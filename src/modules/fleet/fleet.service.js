const {
  ensureWarehouseShape,
  generateNextAssetCode,
  isFleetAssetLike,
  buildFleetDocumentAlerts,
  summarizeFleetDocumentAlerts,
  normalizeWarehouseAssetPayload,
  upsertWarehouseAsset,
  updateWarehouseAssetById,
  normalizeText,
  parseFlexibleDate,
} = require('../warehouse/warehouse.service');

const FLEET_CATEGORY_NAME = 'Flota vehicular';

const FLEET_SQL_FILTER = `(
  (wa.vehicle_plate IS NOT NULL AND TRIM(wa.vehicle_plate) <> '')
  OR LOWER(COALESCE(wa.vehicle_type, '')) LIKE '%veh%'
  OR LOWER(COALESCE(wa.vehicle_type, '')) LIKE '%flota%'
  OR LOWER(COALESCE(wa.vehicle_type, '')) LIKE '%maquinaria%'
  OR LOWER(COALESCE(wa.category_name, '')) LIKE '%veh%'
  OR LOWER(COALESCE(wa.category_name, '')) LIKE '%flota%'
  OR LOWER(COALESCE(wa.category_name, '')) LIKE '%maquinaria%'
  OR LOWER(COALESCE(wa.asset_name, '')) LIKE '%camioneta%'
  OR LOWER(COALESCE(wa.asset_name, '')) LIKE '%vehiculo%'
  OR LOWER(COALESCE(wa.asset_name, '')) LIKE '%manlift%'
  OR LOWER(COALESCE(wa.asset_name, '')) LIKE '%bugui%'
)`;

const ensureFleetShape = async (connection) => {
  await ensureWarehouseShape(connection);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS fleet_maintenance_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      asset_id INT NOT NULL,
      maintenance_type VARCHAR(80) NOT NULL,
      service_date DATE NOT NULL,
      next_due_date DATE NULL,
      odometer_snapshot VARCHAR(80) NULL,
      vendor_name VARCHAR(160) NULL,
      cost DECIMAL(12, 2) NULL,
      description TEXT NULL,
      notes TEXT NULL,
      created_by_user_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_fleet_maintenance_asset_id (asset_id),
      INDEX idx_fleet_maintenance_service_date (service_date)
    )
  `);
};

const FLEET_OUTBOUND_MOVEMENT_TYPES = new Set(['delivery', 'assignment', 'transfer']);

const enrichFleetUnitRow = (row, maintenanceCount = 0) => {
  const documentAlerts = buildFleetDocumentAlerts(row);
  const alertSummary = summarizeFleetDocumentAlerts(documentAlerts);
  const latestType = (row.latest_movement_type || '').toString().trim().toLowerCase();
  const isDeployed = FLEET_OUTBOUND_MOVEMENT_TYPES.has(latestType);

  return {
    ...row,
    document_alerts: documentAlerts,
    alert_summary: alertSummary,
    maintenance_count: Number(maintenanceCount) || 0,
    deployment_status: isDeployed ? 'deployed' : 'available',
  };
};

const listFleetUnits = async (connection, { query, city, limit = 200 } = {}) => {
  const conditions = [FLEET_SQL_FILTER];
  const params = [];

  if ((query || '').toString().trim()) {
    conditions.push(`(
      wa.asset_code LIKE ? OR
      wa.asset_name LIKE ? OR
      wa.vehicle_plate LIKE ? OR
      wa.vehicle_type LIKE ? OR
      wa.brand LIKE ? OR
      wa.model LIKE ?
    )`);
    const queryLike = `%${query.toString().trim()}%`;
    params.push(queryLike, queryLike, queryLike, queryLike, queryLike, queryLike);
  }

  if ((city || '').toString().trim()) {
    conditions.push('wa.current_city = ?');
    params.push(city.toString().trim());
  }

  const normalizedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const where = `WHERE ${conditions.join(' AND ')}`;

  const [rows] = await connection.execute(`
    SELECT
      wa.*,
      COALESCE(mv.movement_count, 0) AS movement_count,
      mv.last_movement_date,
      mv.last_movement_at,
      lm.latest_movement_type,
      lm.latest_project_ot_code,
      lm.latest_project_name,
      COALESCE(fm.maintenance_count, 0) AS maintenance_count
    FROM warehouse_assets wa
    LEFT JOIN (
      SELECT
        asset_id,
        COUNT(*) AS movement_count,
        MAX(movement_date) AS last_movement_date,
        MAX(created_at) AS last_movement_at
      FROM warehouse_asset_movements
      GROUP BY asset_id
    ) mv ON mv.asset_id = wa.id
    LEFT JOIN (
      SELECT
        wm.asset_id,
        wm.movement_type AS latest_movement_type,
        p.ot_code AS latest_project_ot_code,
        p.name AS latest_project_name
      FROM warehouse_asset_movements wm
      INNER JOIN (
        SELECT asset_id, MAX(id) AS latest_id
        FROM warehouse_asset_movements
        GROUP BY asset_id
      ) latest ON latest.latest_id = wm.id
      LEFT JOIN projects p ON p.id = wm.project_id
    ) lm ON lm.asset_id = wa.id
    LEFT JOIN (
      SELECT asset_id, COUNT(*) AS maintenance_count
      FROM fleet_maintenance_records
      GROUP BY asset_id
    ) fm ON fm.asset_id = wa.id
    ${where}
    ORDER BY wa.updated_at DESC, wa.id DESC
    LIMIT ${normalizedLimit}
  `, params);

  return rows.map((row) => enrichFleetUnitRow(row, row.maintenance_count));
};

const getFleetUnitById = async (connection, assetId) => {
  const [rows] = await connection.execute(`
    SELECT
      wa.*,
      lm.latest_movement_type,
      lm.latest_project_ot_code,
      lm.latest_project_name
    FROM warehouse_assets wa
    LEFT JOIN (
      SELECT
        wm.asset_id,
        wm.movement_type AS latest_movement_type,
        p.ot_code AS latest_project_ot_code,
        p.name AS latest_project_name
      FROM warehouse_asset_movements wm
      INNER JOIN (
        SELECT asset_id, MAX(id) AS latest_id
        FROM warehouse_asset_movements
        GROUP BY asset_id
      ) latest ON latest.latest_id = wm.id
      LEFT JOIN projects p ON p.id = wm.project_id
    ) lm ON lm.asset_id = wa.id
    WHERE wa.id = ?
    LIMIT 1
  `, [assetId]);

  const row = rows[0];
  if (!row || !isFleetAssetLike(row)) {
    return null;
  }

  const [maintenanceRows] = await connection.execute(`
    SELECT *
    FROM fleet_maintenance_records
    WHERE asset_id = ?
    ORDER BY service_date DESC, id DESC
    LIMIT 50
  `, [assetId]);

  return {
    ...enrichFleetUnitRow(row, maintenanceRows.length),
    maintenance_records: maintenanceRows,
  };
};

const normalizeFleetUnitPayload = (payload) => {
  const normalized = normalizeWarehouseAssetPayload({
    ...payload,
    category_name: normalizeText(payload.category_name) || FLEET_CATEGORY_NAME,
    unit_measure: normalizeText(payload.unit_measure) || 'UND',
    current_stock: 0,
    minimum_stock: 0,
    intake_origin: payload.intake_origin ?? 'purchase',
  });

  return normalized;
};

const validateFleetUnitPayload = (normalized) => {
  if (!normalized.assetName) {
    return 'asset_name es requerido para registrar el vehículo';
  }
  if (!normalized.vehiclePlate) {
    return 'vehicle_plate es requerido para registrar el vehículo';
  }
  if (!normalized.vehicleType) {
    return 'vehicle_type es requerido para registrar el vehículo';
  }

  const fleetAlerts = buildFleetDocumentAlerts(normalized);
  const missing = fleetAlerts.filter((item) => item.missing);
  if (missing.length) {
    return `Debes registrar vencimiento de ${missing.map((item) => item.label).join(', ')}`;
  }

  return null;
};

const createFleetUnit = async (connection, payload) => {
  const normalized = normalizeFleetUnitPayload(payload);
  const validationError = validateFleetUnitPayload(normalized);
  if (validationError) {
    throw new Error(validationError);
  }

  const asset = {
    ...normalized,
    assetCode: normalized.assetCode || await generateNextAssetCode(connection),
  };

  await upsertWarehouseAsset(connection, asset);

  const [rows] = await connection.execute(
    'SELECT * FROM warehouse_assets WHERE asset_code = ? LIMIT 1',
    [asset.assetCode],
  );

  return enrichFleetUnitRow(rows[0] || {});
};

const updateFleetUnit = async (connection, assetId, payload) => {
  const [existingRows] = await connection.execute(
    'SELECT * FROM warehouse_assets WHERE id = ? LIMIT 1',
    [assetId],
  );
  const existing = existingRows[0];
  if (!existing || !isFleetAssetLike(existing)) {
    return null;
  }

  const normalized = normalizeFleetUnitPayload({
    ...existing,
    ...payload,
    asset_code: existing.asset_code,
  });
  const validationError = validateFleetUnitPayload(normalized);
  if (validationError) {
    throw new Error(validationError);
  }

  const updated = await updateWarehouseAssetById(connection, assetId, normalized);
  if (!updated) {
    return null;
  }

  return getFleetUnitById(connection, assetId);
};

const normalizeMaintenancePayload = (payload) => {
  const maintenanceType = normalizeText(payload.maintenance_type);
  const serviceDate = parseFlexibleDate(payload.service_date);
  const nextDueDate = parseFlexibleDate(payload.next_due_date);
  const odometerSnapshot = normalizeText(payload.odometer_snapshot);
  const vendorName = normalizeText(payload.vendor_name);
  const description = normalizeText(payload.description);
  const notes = normalizeText(payload.notes);
  const cost = Number.isFinite(Number(payload.cost)) ? Number(payload.cost) : null;

  return {
    maintenanceType,
    serviceDate,
    nextDueDate,
    odometerSnapshot,
    vendorName,
    description,
    notes,
    cost,
  };
};

const listMaintenanceRecords = async (connection, assetId) => {
  const [rows] = await connection.execute(`
    SELECT *
    FROM fleet_maintenance_records
    WHERE asset_id = ?
    ORDER BY service_date DESC, id DESC
  `, [assetId]);

  return rows;
};

const createMaintenanceRecord = async (connection, assetId, payload, userId = null) => {
  const [assetRows] = await connection.execute(
    'SELECT * FROM warehouse_assets WHERE id = ? LIMIT 1',
    [assetId],
  );
  const asset = assetRows[0];
  if (!asset || !isFleetAssetLike(asset)) {
    return null;
  }

  const normalized = normalizeMaintenancePayload(payload);
  if (!normalized.maintenanceType) {
    throw new Error('maintenance_type es requerido');
  }
  if (!normalized.serviceDate) {
    throw new Error('service_date es requerido');
  }

  const [result] = await connection.execute(`
    INSERT INTO fleet_maintenance_records (
      asset_id,
      maintenance_type,
      service_date,
      next_due_date,
      odometer_snapshot,
      vendor_name,
      cost,
      description,
      notes,
      created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    assetId,
    normalized.maintenanceType,
    normalized.serviceDate,
    normalized.nextDueDate,
    normalized.odometerSnapshot,
    normalized.vendorName,
    normalized.cost,
    normalized.description,
    normalized.notes,
    userId,
  ]);

  const maintenanceType = normalized.maintenanceType.toLowerCase();
  const docUpdates = {};
  if (maintenanceType.includes('soat') && normalized.nextDueDate) {
    docUpdates.soat_due_date = normalized.nextDueDate;
  }
  if (maintenanceType.includes('seguro') && normalized.nextDueDate) {
    docUpdates.insurance_due_date = normalized.nextDueDate;
  }
  if ((maintenanceType.includes('tecno') || maintenanceType.includes('rtm')) && normalized.nextDueDate) {
    docUpdates.technical_due_date = normalized.nextDueDate;
  }

  if (Object.keys(docUpdates).length) {
    await updateFleetUnit(connection, assetId, docUpdates);
  }

  const [rows] = await connection.execute(
    'SELECT * FROM fleet_maintenance_records WHERE id = ? LIMIT 1',
    [result.insertId],
  );

  return rows[0] || null;
};

const listFleetAlerts = async (connection, { query, limit = 200 } = {}) => {
  const units = await listFleetUnits(connection, { query, limit });
  return units.filter((unit) => unit.alert_summary?.hasIssues);
};

module.exports = {
  FLEET_CATEGORY_NAME,
  ensureFleetShape,
  listFleetUnits,
  getFleetUnitById,
  createFleetUnit,
  updateFleetUnit,
  listMaintenanceRecords,
  createMaintenanceRecord,
  listFleetAlerts,
  enrichFleetUnitRow,
};
