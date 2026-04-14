const db = require('../../config/database');

const pool = db.pool;

const ALLOWED_ENTITY_TYPES = new Set([
  'users',
  'projects',
  'employees',
  'activities',
  'labor_permissions',
  'attendance',
  'project_collaborators',
  'project_allowances',
  'allowance_expenses',
  'allowance_requests',
  'project_material_items',
  'material_consumptions',
]);

const ALLOWED_ACTIONS = new Set(['INSERT', 'UPDATE', 'DELETE']);

const parseJsonField = (value) => {
  if (value == null) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
};

const toAuditLog = (row) => ({
  id: row.id,
  user_id: row.user_id,
  action: row.action,
  entity_type: row.entity_type,
  entity_id: row.entity_id,
  old_values: parseJsonField(row.old_values),
  new_values: parseJsonField(row.new_values),
  changed_fields: parseJsonField(row.changed_fields),
  ip_address: row.ip_address,
  created_at: row.created_at,
});

const listAuditLogs = async (req, res) => {
  try {
    const requestedEntityType = (req.query.entity_type || '').toString().trim();
    const requestedAction = (req.query.action || '').toString().trim().toUpperCase();
    const entityId = req.query.entity_id ? Number(req.query.entity_id) : null;
    const userId = req.query.user_id ? Number(req.query.user_id) : null;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;

    if (requestedEntityType && !ALLOWED_ENTITY_TYPES.has(requestedEntityType)) {
      return res.status(400).json({
        success: false,
        message: 'entity_type inválido',
      });
    }

    if (requestedAction && !ALLOWED_ACTIONS.has(requestedAction)) {
      return res.status(400).json({
        success: false,
        message: 'action inválido',
      });
    }

    if (req.query.entity_id && (!Number.isInteger(entityId) || entityId <= 0)) {
      return res.status(400).json({
        success: false,
        message: 'entity_id inválido',
      });
    }

    if (req.query.user_id && (!Number.isInteger(userId) || userId <= 0)) {
      return res.status(400).json({
        success: false,
        message: 'user_id inválido',
      });
    }

    const conditions = [];
    const params = [];

    if (requestedEntityType) {
      conditions.push('entity_type = ?');
      params.push(requestedEntityType);
    }

    if (requestedAction) {
      conditions.push('action = ?');
      params.push(requestedAction);
    }

    if (entityId) {
      conditions.push('entity_id = ?');
      params.push(entityId);
    }

    if (userId) {
      conditions.push('user_id = ?');
      params.push(userId);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const connection = await pool.getConnection();

    const [countRows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM audit_logs ${whereClause}`,
      params
    );

    const [rows] = await connection.execute(
      `SELECT id, user_id, action, entity_type, entity_id, old_values, new_values, changed_fields, ip_address, created_at
       FROM audit_logs
       ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    connection.release();

    res.json({
      success: true,
      data: rows.map(toAuditLog),
      meta: {
        page,
        limit,
        total: countRows[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error('listAuditLogs error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al listar auditoría',
      error: error.message,
    });
  }
};

module.exports = {
  listAuditLogs,
};