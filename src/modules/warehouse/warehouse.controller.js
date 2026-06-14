const db = require('../../config/database');
const { withDbConnection } = db;
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const {
  buildFleetDocumentAlerts,
  ensureWarehouseShape,
  generateNextAssetCode,
  isFleetAssetLike,
  normalizeIntakeOrigin,
  normalizeWarehouseAssetPayload,
  shouldImportWarehouseAsset,
  upsertWarehouseAsset,
} = require('./warehouse.service');

const listAssets = async (req, res) => {
  try {
    const { q, city, lifecycleStatus, limit } = req.query;
    const rows = await withDbConnection(async (connection) => {
      await ensureWarehouseShape(connection);

      const conditions = [];
      const params = [];

      if ((q || '').toString().trim().isNotEmpty) {
        conditions.push(`(
          wa.asset_code LIKE ? OR
          wa.sku_code LIKE ? OR
          wa.asset_name LIKE ? OR
          wa.category_name LIKE ? OR
          wa.serial_number LIKE ? OR
          wa.brand LIKE ? OR
          wa.model LIKE ? OR
          wa.work_order LIKE ? OR
          wa.client_name LIKE ?
        )`);
        const queryLike = `%${q.toString().trim()}%`;
        params.push(queryLike, queryLike, queryLike, queryLike, queryLike, queryLike, queryLike, queryLike, queryLike);
      }

      if ((city || '').toString().trim().isNotEmpty) {
        conditions.push('wa.current_city = ?');
        params.push(city.toString().trim());
      }

      if ((lifecycleStatus || '').toString().trim().isNotEmpty) {
        conditions.push('wa.lifecycle_status = ?');
        params.push(lifecycleStatus.toString().trim());
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const normalizedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);

      const [result] = await connection.execute(`
        SELECT
          wa.*,
          COALESCE(mv.movement_count, 0) AS movement_count,
          mv.last_movement_date
        FROM warehouse_assets wa
        LEFT JOIN (
          SELECT
            asset_id,
            COUNT(*) AS movement_count,
            MAX(movement_date) AS last_movement_date
          FROM warehouse_asset_movements
          GROUP BY asset_id
        ) mv ON mv.asset_id = wa.id
        ${where}
        ORDER BY wa.updated_at DESC, wa.id DESC
        LIMIT ${normalizedLimit}
      `, params);

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar activos de almacen');
  }
};

const importAssets = async (req, res) => {
  let connection;
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items debe ser un arreglo de activos' });
    }

    connection = await pool.getConnection();
    await ensureWarehouseShape(connection);
    await applyAuditContext(connection, req);
    await connection.beginTransaction();

    let imported = 0;
    let skipped = 0;

    for (const rawItem of items) {
      const asset = normalizeWarehouseAssetPayload(rawItem || {});
      if (!shouldImportWarehouseAsset(asset)) {
        skipped += 1;
        continue;
      }

      await upsertWarehouseAsset(connection, asset);
      imported += 1;
    }

    await connection.commit();

    res.json({
      success: true,
      message: 'Activos importados correctamente',
      data: {
        imported,
        skipped,
        received: items.length,
      },
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {}
    }
    sendControllerError(res, error, 'Error al importar activos de almacen');
  } finally {
    connection?.release();
  }
};

const createAsset = async (req, res) => {
  try {
    const payload = req.body || {};
    const normalized = normalizeWarehouseAssetPayload(payload);

    if (!normalized.assetName) {
      return res.status(400).json({ success: false, message: 'asset_name es requerido para registrar el activo' });
    }

    if (isFleetAssetLike(normalized)) {
      if (!normalized.vehiclePlate) {
        return res.status(400).json({ success: false, message: 'vehicle_plate es requerido para registrar flota o maquinaria' });
      }
      if (!normalized.vehicleType) {
        return res.status(400).json({ success: false, message: 'vehicle_type es requerido para registrar flota o maquinaria' });
      }

      const fleetAlerts = buildFleetDocumentAlerts(normalized);
      const missing = fleetAlerts.filter((item) => item.missing);
      if (missing.length) {
        return res.status(400).json({
          success: false,
          message: `Debes registrar vencimiento de ${missing.map((item) => item.label).join(', ')} para activos de flota`,
        });
      }
    }

    const assetRow = await withDbConnection(async (connection) => {
      await ensureWarehouseShape(connection);

      const asset = {
        ...normalized,
        assetCode: normalized.assetCode || await generateNextAssetCode(connection),
        currentStock: normalized.currentStock == null ? 0 : normalized.currentStock,
        minimumStock: normalized.minimumStock == null ? 0 : normalized.minimumStock,
      };

      await applyAuditContext(connection, req);
      await upsertWarehouseAsset(connection, asset);

      const [rows] = await connection.execute(
        `SELECT *
         FROM warehouse_assets
         WHERE asset_code = ?
         LIMIT 1`,
        [asset.assetCode]
      );

      return rows[0];
    });

    res.status(201).json({
      success: true,
      message: 'Activo de almacén registrado',
      data: assetRow,
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar activo de almacén');
  }
};

const listMovements = async (req, res) => {
  try {
    const { assetId, projectId } = req.query;
    const rows = await withDbConnection(async (connection) => {
      await ensureWarehouseShape(connection);

      const conditions = [];
      const params = [];
      if (assetId) {
        conditions.push('wm.asset_id = ?');
        params.push(Number(assetId));
      }
      if (projectId) {
        conditions.push('wm.project_id = ?');
        params.push(Number(projectId));
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [result] = await connection.execute(
        `SELECT
           wm.*,
           wa.asset_code,
           wa.asset_name,
           p.name AS project_name,
           responsible.name AS responsible_name,
           receiver.name AS receiver_name
         FROM warehouse_asset_movements wm
         INNER JOIN warehouse_assets wa ON wa.id = wm.asset_id
         LEFT JOIN projects p ON p.id = wm.project_id
         LEFT JOIN users responsible ON responsible.id = wm.responsible_user_id
         LEFT JOIN users receiver ON receiver.id = wm.receiver_user_id
         ${where}
         ORDER BY COALESCE(wm.movement_date, DATE(wm.created_at)) DESC, wm.id DESC`,
        params
      );

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar movimientos de almacen');
  }
};

const createMovement = async (req, res) => {
  try {
    const {
      asset_id,
      project_id,
      movement_type,
      intake_origin,
      intake_origin_project_id,
      movement_date,
      work_order,
      client_name,
      dispatch_note,
      evidence_path,
      quantity,
      serial_snapshot,
      delivery_signature_name,
      delivery_signature_data,
      receiving_signature_name,
      receiving_signature_data,
      vehicle_plate_snapshot,
      odometer_snapshot,
      fuel_level_snapshot,
      checklist_snapshot,
      status_snapshot,
      city_snapshot,
      responsible_user_id,
      receiver_user_id,
      notes,
    } = req.body;

    const assetId = Number(asset_id || 0);
    const normalizedMovementType = (movement_type || '').toString().trim();
    const normalizedIntakeOrigin = normalizeIntakeOrigin(intake_origin);
    const normalizedIntakeOriginProjectId = Number.isFinite(Number(intake_origin_project_id))
      ? Number(intake_origin_project_id)
      : null;
    if (assetId <= 0 || !normalizedMovementType) {
      return res.status(400).json({ success: false, message: 'asset_id y movement_type son requeridos' });
    }

    const sessionUserId = Number(req.user?.id || 0);
    const sessionUserName = (req.user?.name || '').toString().trim();
    if (sessionUserId <= 0) {
      throw new HttpError(401, 'Sesión inválida para registrar el movimiento');
    }

    const delivererMovementTypes = new Set(['delivery', 'assignment']);
    const resolvedResponsibleUserId = sessionUserId;
    const resolvedDeliverySignatureName = delivererMovementTypes.has(normalizedMovementType)
      ? sessionUserName || null
      : delivery_signature_name || null;
    const resolvedDeliverySignatureData = delivererMovementTypes.has(normalizedMovementType)
      ? null
      : delivery_signature_data || null;

    await withDbConnection(async (connection) => {
      await ensureWarehouseShape(connection);

      const [assetRows] = await connection.execute(
        `SELECT
           id,
           asset_name,
           category_name,
           vehicle_plate,
           vehicle_type,
           insurance_due_date,
           soat_due_date,
           technical_due_date
         FROM warehouse_assets
         WHERE id = ?
         LIMIT 1`,
        [assetId]
      );
      if (!assetRows.length) {
        throw new HttpError(404, 'Activo no encontrado');
      }

      const asset = assetRows[0];
      const isFleetMovement = normalizedMovementType === 'transfer' || isFleetAssetLike(asset);
      if (isFleetMovement) {
        const plateSnapshot = (vehicle_plate_snapshot || asset.vehicle_plate || '').toString().trim();
        if (!plateSnapshot) {
          throw new HttpError(400, 'La flota requiere placa o identificación de unidad para registrar el movimiento');
        }
        if (!(odometer_snapshot || '').toString().trim()) {
          throw new HttpError(400, 'La flota requiere odómetro u horómetro para registrar la salida');
        }
        if (!(fuel_level_snapshot || '').toString().trim()) {
          throw new HttpError(400, 'La flota requiere nivel de combustible o carga al momento de la entrega');
        }
        if (!(checklist_snapshot || '').toString().trim()) {
          throw new HttpError(400, 'La flota requiere checklist de salida o entrega');
        }

        const fleetAlerts = buildFleetDocumentAlerts(asset);
        const missing = fleetAlerts.filter((item) => item.missing);
        if (missing.length) {
          throw new HttpError(409, `No se puede mover la flota porque falta vigencia de ${missing.map((item) => item.label).join(', ')}`);
        }

        const expired = fleetAlerts.filter((item) => item.expired);
        if (expired.length) {
          throw new HttpError(409, `No se puede mover la flota porque tiene vencido ${expired.map((item) => item.label).join(', ')}`);
        }
      }

      await applyAuditContext(connection, req);
      await connection.execute(
        `INSERT INTO warehouse_asset_movements (
           asset_id,
           project_id,
           movement_type,
           movement_date,
           work_order,
           client_name,
           dispatch_note,
           evidence_path,
           quantity,
           serial_snapshot,
           delivery_signature_name,
           delivery_signature_data,
           receiving_signature_name,
           receiving_signature_data,
           vehicle_plate_snapshot,
           odometer_snapshot,
           fuel_level_snapshot,
           checklist_snapshot,
           intake_origin,
           intake_origin_project_id,
           status_snapshot,
           city_snapshot,
           responsible_user_id,
           receiver_user_id,
           notes,
           created_at,
           updated_at
         )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          assetId,
          project_id || null,
          normalizedMovementType,
          movement_date || null,
          work_order || null,
          client_name || null,
          dispatch_note || null,
          evidence_path || null,
          quantity || null,
          serial_snapshot || null,
          resolvedDeliverySignatureName,
          resolvedDeliverySignatureData,
          receiving_signature_name || null,
          receiving_signature_data || null,
          vehicle_plate_snapshot || null,
          odometer_snapshot || null,
          fuel_level_snapshot || null,
          checklist_snapshot || null,
          normalizedIntakeOrigin,
          normalizedIntakeOriginProjectId,
          status_snapshot || null,
          city_snapshot || null,
          resolvedResponsibleUserId,
          receiver_user_id || null,
          notes || null,
        ]
      );
    });

    res.json({ success: true, message: 'Movimiento de almacen registrado' });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar movimiento de almacen');
  }
};

module.exports = {
  listAssets,
  createAsset,
  importAssets,
  listMovements,
  createMovement,
};
