const db = require('../../config/database');
const { withDbConnection } = db;
const { sendControllerError } = require('../../utils/httpError');
const { auditedTables } = require('../../utils/installAuditTriggers');

const ALLOWED_ENTITY_TYPES = new Set(auditedTables.map((table) => table.entityType));

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

const normalizeChangedFields = (value) => {
  const parsed = parseJsonField(value);
  if (!Array.isArray(parsed)) {
    if (parsed == null || parsed === '') return [];
    return [parsed.toString()];
  }

  const flat = [];
  const queue = [...parsed];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item == null) continue;
    if (Array.isArray(item)) {
      queue.unshift(...item);
      continue;
    }
    const text = item.toString().trim();
    if (text) flat.push(text);
  }

  return [...new Set(flat)];
};

const toAuditLog = (row) => ({
  id: row.id,
  user_id: row.user_id,
  user_name: row.user_name ?? null,
  user_email: row.user_email ?? null,
  action: row.action,
  entity_type: row.entity_type,
  entity_id: row.entity_id,
  old_values: parseJsonField(row.old_values),
  new_values: parseJsonField(row.new_values),
  changed_fields: normalizeChangedFields(row.changed_fields),
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
        message: `entity_type inválido. Valores permitidos: ${[...ALLOWED_ENTITY_TYPES].sort().join(', ')}`,
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
      conditions.push('al.entity_type = ?');
      params.push(requestedEntityType);
    }

    if (requestedAction) {
      conditions.push('al.action = ?');
      params.push(requestedAction);
    }

    if (entityId) {
      conditions.push('al.entity_id = ?');
      params.push(entityId);
    }

    if (userId) {
      conditions.push('al.user_id = ?');
      params.push(userId);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows, total } = await withDbConnection(async (connection) => {
      const [countRows] = await connection.execute(
        `SELECT COUNT(*) AS total FROM audit_logs al ${whereClause}`,
        params
      );

      const [result] = await connection.execute(
        `SELECT
           al.id,
           al.user_id,
           u.name AS user_name,
           u.email AS user_email,
           al.action,
           al.entity_type,
           al.entity_id,
           al.old_values,
           al.new_values,
           al.changed_fields,
           al.ip_address,
           al.created_at
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         ${whereClause}
         ORDER BY al.created_at DESC, al.id DESC
         LIMIT ${limit} OFFSET ${offset}`
      );

      return {
        rows: result,
        total: Number(countRows[0]?.total ?? 0),
      };
    });

    res.json({
      success: true,
      data: rows.map(toAuditLog),
      meta: {
        page,
        limit,
        total,
      },
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar auditoría');
  }
};

module.exports = {
  listAuditLogs,
  ALLOWED_ENTITY_TYPES,
};
