const db = require('../../config/database');
const { withDbConnection } = db;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const { normalizeRole } = require('../../middleware/auth.middleware');
const {
  ensureOperationalScopeShape,
  canAccessProjectByOperationalScope,
} = require('../operationalScopes/operationalScopes.service');

const ensureMaterialsShape = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS project_material_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      material_name VARCHAR(255) NOT NULL,
      unit VARCHAR(50) NULL,
      assigned_quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
      unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_project_material (project_id, material_name),
      INDEX idx_project (project_id)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS material_consumptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      material_item_id INT NOT NULL,
      consumed_quantity DECIMAL(14,3) NOT NULL,
      consumption_date DATE NOT NULL,
      notes TEXT NULL,
      evidence_path VARCHAR(500) NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_material_item (material_item_id),
      INDEX idx_date (consumption_date)
    )
  `);
};

const listMaterialItems = async (req, res) => {
  try {
    const rows = await withDbConnection(async (connection) => {
      await ensureMaterialsShape(connection);
      await ensureOperationalScopeShape(connection);

      const normalizedRole = normalizeRole(req.user?.role);
      const conditions = [];
      const params = [];

      if (normalizedRole === 'supervisor' || normalizedRole === 'leader') {
        conditions.push(`EXISTS (
          SELECT 1
          FROM operational_role_assignments ora
          WHERE ora.project_id = p.id
            AND ora.user_id = ?
            AND ora.role_scope = ?
            AND ora.is_active = 1
        )`);
        params.push(req.user.id, normalizedRole);
      } else if (normalizedRole === 'employee') {
        conditions.push('1 = 0');
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const [result] = await connection.execute(`
        SELECT
          mi.id,
          mi.project_id,
          p.name AS project_name,
          mi.material_name,
          mi.unit,
          mi.assigned_quantity,
          mi.unit_cost,
          COALESCE(SUM(mc.consumed_quantity), 0) AS consumed_quantity,
          (mi.assigned_quantity - COALESCE(SUM(mc.consumed_quantity), 0)) AS remaining_quantity,
          (mi.unit_cost * mi.assigned_quantity) AS assigned_total_cost,
          (mi.unit_cost * COALESCE(SUM(mc.consumed_quantity), 0)) AS consumed_total_cost,
          (mi.unit_cost * (mi.assigned_quantity - COALESCE(SUM(mc.consumed_quantity), 0))) AS remaining_total_cost,
          mi.updated_at
        FROM project_material_items mi
        INNER JOIN projects p ON p.id = mi.project_id
        LEFT JOIN material_consumptions mc ON mc.material_item_id = mi.id
        ${where}
        GROUP BY mi.id
        ORDER BY mi.updated_at DESC
      `, params);

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar materiales');
  }
};

const listProjectMaterials = async (req, res) => {
  try {
    const { projectId } = req.params;
    const rows = await withDbConnection(async (connection) => {
      await ensureMaterialsShape(connection);
      await ensureOperationalScopeShape(connection);

      const normalizedRole = normalizeRole(req.user?.role);
      if (normalizedRole === 'supervisor' || normalizedRole === 'leader') {
        const hasProjectAccess = await canAccessProjectByOperationalScope({
          connection,
          userId: req.user.id,
          role: normalizedRole,
          projectId: Number(projectId),
        });

        if (!hasProjectAccess) {
          throw new HttpError(403, 'No tienes acceso operativo a este proyecto');
        }
      }

      if (normalizedRole === 'employee') {
        throw new HttpError(403, 'Acceso denegado');
      }

      const [result] = await connection.execute(`
        SELECT
          mi.id,
          mi.project_id,
          p.name AS project_name,
          mi.material_name,
          mi.unit,
          mi.assigned_quantity,
          mi.unit_cost,
          COALESCE(SUM(mc.consumed_quantity), 0) AS consumed_quantity,
          (mi.assigned_quantity - COALESCE(SUM(mc.consumed_quantity), 0)) AS remaining_quantity,
          (mi.unit_cost * mi.assigned_quantity) AS assigned_total_cost,
          (mi.unit_cost * COALESCE(SUM(mc.consumed_quantity), 0)) AS consumed_total_cost,
          (mi.unit_cost * (mi.assigned_quantity - COALESCE(SUM(mc.consumed_quantity), 0))) AS remaining_total_cost,
          mi.updated_at
        FROM project_material_items mi
        INNER JOIN projects p ON p.id = mi.project_id
        LEFT JOIN material_consumptions mc ON mc.material_item_id = mi.id
        WHERE mi.project_id = ?
        GROUP BY mi.id
        ORDER BY mi.updated_at DESC
      `, [projectId]);

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar materiales del proyecto');
  }
};

const assignMaterial = async (req, res) => {
  try {
    const { project_id, material_name, unit, assigned_quantity, unit_cost } = req.body;
    const normalizedQty = Number(assigned_quantity || 0);
    const normalizedCost = Number(unit_cost || 0);
    const normalizedName = (material_name || '').toString().trim();

    if (!project_id || !normalizedName || Number.isNaN(normalizedQty) || normalizedQty < 0 || Number.isNaN(normalizedCost) || normalizedCost < 0) {
      return res.status(400).json({
        success: false,
        message: 'project_id, material_name, assigned_quantity y unit_cost válidos son requeridos'
      });
    }

    const row = await withDbConnection(async (connection) => {
      await ensureMaterialsShape(connection);

      const [projectRows] = await connection.execute('SELECT id FROM projects WHERE id = ? LIMIT 1', [project_id]);
      if (!projectRows.length) {
        throw new HttpError(404, 'Proyecto no encontrado');
      }

      await applyAuditContext(connection, req);
      await connection.execute(`
        INSERT INTO project_material_items
          (project_id, material_name, unit, assigned_quantity, unit_cost, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          unit = VALUES(unit),
          assigned_quantity = VALUES(assigned_quantity),
          unit_cost = VALUES(unit_cost),
          updated_at = NOW()
      `, [project_id, normalizedName, unit || null, normalizedQty, normalizedCost]);

      const [rows] = await connection.execute(`
        SELECT
          mi.id,
          mi.project_id,
          p.name AS project_name,
          mi.material_name,
          mi.unit,
          mi.assigned_quantity,
          mi.unit_cost,
          COALESCE(SUM(mc.consumed_quantity), 0) AS consumed_quantity,
          (mi.assigned_quantity - COALESCE(SUM(mc.consumed_quantity), 0)) AS remaining_quantity,
          (mi.unit_cost * mi.assigned_quantity) AS assigned_total_cost,
          (mi.unit_cost * COALESCE(SUM(mc.consumed_quantity), 0)) AS consumed_total_cost,
          (mi.unit_cost * (mi.assigned_quantity - COALESCE(SUM(mc.consumed_quantity), 0))) AS remaining_total_cost,
          mi.updated_at
        FROM project_material_items mi
        INNER JOIN projects p ON p.id = mi.project_id
        LEFT JOIN material_consumptions mc ON mc.material_item_id = mi.id
        WHERE mi.project_id = ? AND mi.material_name = ?
        GROUP BY mi.id
        LIMIT 1
      `, [project_id, normalizedName]);

      return rows[0];
    });

    res.json({ success: true, message: 'Material asignado/actualizado', data: row });
  } catch (error) {
    sendControllerError(res, error, 'Error al asignar material');
  }
};

const registerConsumption = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { material_item_id, consumed_quantity, consumption_date, notes, evidence_path } = req.body;

    const materialId = Number(material_item_id || 0);
    const quantity = Number(consumed_quantity || 0);

    if (Number.isNaN(materialId) || materialId <= 0 || Number.isNaN(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'material_item_id y consumed_quantity válidos son requeridos' });
    }

    const result = await withDbConnection(async (connection) => {
      await ensureMaterialsShape(connection);
      await ensureOperationalScopeShape(connection);

      const normalizedRole = normalizeRole(req.user?.role);
      if (normalizedRole === 'supervisor' || normalizedRole === 'leader') {
        const hasProjectAccess = await canAccessProjectByOperationalScope({
          connection,
          userId: req.user.id,
          role: normalizedRole,
          projectId: Number(projectId),
        });

        if (!hasProjectAccess) {
          throw new HttpError(403, 'No tienes acceso operativo a este proyecto');
        }
      }

      if (normalizedRole === 'employee') {
        throw new HttpError(403, 'Acceso denegado');
      }

      const [materialRows] = await connection.execute(
        'SELECT id, project_id, assigned_quantity, unit_cost FROM project_material_items WHERE id = ? LIMIT 1',
        [materialId]
      );

      if (!materialRows.length) {
        throw new HttpError(404, 'Material no encontrado');
      }

      const material = materialRows[0];
      if (Number(material.project_id) !== Number(projectId)) {
        throw new HttpError(400, 'El material no pertenece al proyecto indicado');
      }

      const [consumedRows] = await connection.execute(
        'SELECT COALESCE(SUM(consumed_quantity), 0) AS consumed_quantity FROM material_consumptions WHERE material_item_id = ?',
        [materialId]
      );

      const alreadyConsumed = Number(consumedRows[0].consumed_quantity || 0);
      const remainingQty = Number(material.assigned_quantity || 0) - alreadyConsumed;

      if (quantity > remainingQty) {
        throw new HttpError(409, `El consumo excede la cantidad disponible (${remainingQty.toFixed(3)})`);
      }

      const date = (consumption_date && consumption_date.toString().trim())
        ? consumption_date.toString().trim().slice(0, 10)
        : new Date().toISOString().slice(0, 10);

      const createdBy = req.user?.id || null;

      await applyAuditContext(connection, req);
      const [insertRes] = await connection.execute(
        `INSERT INTO material_consumptions
         (material_item_id, consumed_quantity, consumption_date, notes, evidence_path, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [materialId, quantity, date, notes || null, evidence_path || null, createdBy]
      );

      const [summaryRows] = await connection.execute(
        `SELECT
           mi.id,
           mi.project_id,
           mi.material_name,
           mi.unit,
           mi.assigned_quantity,
           mi.unit_cost,
           COALESCE(SUM(mc.consumed_quantity), 0) AS consumed_quantity,
           (mi.assigned_quantity - COALESCE(SUM(mc.consumed_quantity), 0)) AS remaining_quantity,
           (mi.unit_cost * mi.assigned_quantity) AS assigned_total_cost,
           (mi.unit_cost * COALESCE(SUM(mc.consumed_quantity), 0)) AS consumed_total_cost,
           (mi.unit_cost * (mi.assigned_quantity - COALESCE(SUM(mc.consumed_quantity), 0))) AS remaining_total_cost
         FROM project_material_items mi
         LEFT JOIN material_consumptions mc ON mc.material_item_id = mi.id
         WHERE mi.id = ?
         GROUP BY mi.id`,
        [materialId]
      );

      return {
        consumptionId: insertRes.insertId,
        summary: summaryRows[0],
      };
    });

    res.status(201).json({
      success: true,
      message: 'Consumo registrado y descontado',
      consumptionId: result.consumptionId,
      summary: result.summary
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar consumo de material');
  }
};

const listConsumptionsByProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { material_item_id } = req.query;

    const rows = await withDbConnection(async (connection) => {
      await ensureMaterialsShape(connection);
      await ensureOperationalScopeShape(connection);

      const normalizedRole = normalizeRole(req.user?.role);
      if (normalizedRole === 'supervisor' || normalizedRole === 'leader') {
        const hasProjectAccess = await canAccessProjectByOperationalScope({
          connection,
          userId: req.user.id,
          role: normalizedRole,
          projectId: Number(projectId),
        });

        if (!hasProjectAccess) {
          throw new HttpError(403, 'No tienes acceso operativo a este proyecto');
        }
      }

      if (normalizedRole === 'employee') {
        throw new HttpError(403, 'Acceso denegado');
      }

      const conditions = ['mi.project_id = ?'];
      const params = [projectId];

      if (material_item_id) {
        conditions.push('mi.id = ?');
        params.push(material_item_id);
      }

      const where = `WHERE ${conditions.join(' AND ')}`;

      const [result] = await connection.execute(
        `SELECT
           mc.*,
           mi.project_id,
           mi.material_name,
           mi.unit
         FROM material_consumptions mc
         INNER JOIN project_material_items mi ON mi.id = mc.material_item_id
         ${where}
         ORDER BY mc.created_at DESC`,
        params
      );

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar consumos de materiales');
  }
};

module.exports = {
  listMaterialItems,
  listProjectMaterials,
  assignMaterial,
  registerConsumption,
  listConsumptionsByProject,
  ensureMaterialsShape,
};
