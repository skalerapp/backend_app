const db = require('../../config/database');
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');
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
    const connection = await pool.getConnection();
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
      ${where}
      GROUP BY mi.id
      ORDER BY mi.updated_at DESC
    `, params);

    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar materiales', error: error.message });
  }
};

const listProjectMaterials = async (req, res) => {
  try {
    const { projectId } = req.params;
    const connection = await pool.getConnection();
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
        connection.release();
        return res.status(403).json({ success: false, message: 'No tienes acceso operativo a este proyecto' });
      }
    }

    if (normalizedRole === 'employee') {
      connection.release();
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

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
      WHERE mi.project_id = ?
      GROUP BY mi.id
      ORDER BY mi.updated_at DESC
    `, [projectId]);

    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar materiales del proyecto', error: error.message });
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

    const connection = await pool.getConnection();
    await ensureMaterialsShape(connection);

    const [projectRows] = await connection.execute('SELECT id FROM projects WHERE id = ? LIMIT 1', [project_id]);
    if (!projectRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
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

    connection.release();
    res.json({ success: true, message: 'Material asignado/actualizado', data: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al asignar material', error: error.message });
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

    const connection = await pool.getConnection();
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
        connection.release();
        return res.status(403).json({ success: false, message: 'No tienes acceso operativo a este proyecto' });
      }
    }

    if (normalizedRole === 'employee') {
      connection.release();
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

    const [materialRows] = await connection.execute(
      'SELECT id, project_id, assigned_quantity, unit_cost FROM project_material_items WHERE id = ? LIMIT 1',
      [materialId]
    );

    if (!materialRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Material no encontrado' });
    }

    const material = materialRows[0];
    if (Number(material.project_id) !== Number(projectId)) {
      connection.release();
      return res.status(400).json({ success: false, message: 'El material no pertenece al proyecto indicado' });
    }

    const [consumedRows] = await connection.execute(
      'SELECT COALESCE(SUM(consumed_quantity), 0) AS consumed_quantity FROM material_consumptions WHERE material_item_id = ?',
      [materialId]
    );

    const alreadyConsumed = Number(consumedRows[0].consumed_quantity || 0);
    const remainingQty = Number(material.assigned_quantity || 0) - alreadyConsumed;

    if (quantity > remainingQty) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: `El consumo excede la cantidad disponible (${remainingQty.toFixed(3)})`
      });
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

    connection.release();

    res.status(201).json({
      success: true,
      message: 'Consumo registrado y descontado',
      consumptionId: insertRes.insertId,
      summary: summaryRows[0]
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al registrar consumo de material', error: error.message });
  }
};

const listConsumptionsByProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { material_item_id } = req.query;

    const connection = await pool.getConnection();
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
        connection.release();
        return res.status(403).json({ success: false, message: 'No tienes acceso operativo a este proyecto' });
      }
    }

    if (normalizedRole === 'employee') {
      connection.release();
      return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }

    const conditions = ['mi.project_id = ?'];
    const params = [projectId];

    if (material_item_id) {
      conditions.push('mi.id = ?');
      params.push(material_item_id);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [rows] = await connection.execute(
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

    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar consumos de materiales', error: error.message });
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
