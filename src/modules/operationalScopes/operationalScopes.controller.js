const db = require('../../config/database');
const { withDbConnection } = db;
const { normalizeRole } = require('../../middleware/auth.middleware');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const { ensureOperationalScopeShape } = require('./operationalScopes.service');

const normalizeScopeRole = (value) => {
  const role = normalizeRole(value);
  if (role === 'supervisor' || role === 'leader') {
    return role;
  }
  return null;
};

const listOperationalAssignments = async (req, res) => {
  try {
    const { role_scope, project_id, user_id, is_active } = req.query;
    const rows = await withDbConnection(async (connection) => {
      await ensureOperationalScopeShape(connection);

      const conditions = [];
      const params = [];

      const normalizedScope = role_scope ? normalizeScopeRole(role_scope) : null;
      if (role_scope && !normalizedScope) {
        throw new HttpError(400, 'role_scope inválido (use supervisor o leader)');
      }

      if (normalizedScope) {
        conditions.push('ora.role_scope = ?');
        params.push(normalizedScope);
      }

      if (project_id) {
        conditions.push('ora.project_id = ?');
        params.push(Number(project_id));
      }

      if (user_id) {
        conditions.push('ora.user_id = ?');
        params.push(Number(user_id));
      }

      if (is_active !== undefined) {
        const normalizedIsActive = Number(is_active) === 0 ? 0 : 1;
        conditions.push('ora.is_active = ?');
        params.push(normalizedIsActive);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const [result] = await connection.execute(
        `SELECT
           ora.id,
           ora.project_id,
           p.name AS project_name,
           ora.user_id,
           u.name AS user_name,
           u.email AS user_email,
           ora.role_scope,
           ora.is_active,
           ora.created_at,
           ora.updated_at
         FROM operational_role_assignments ora
         INNER JOIN projects p ON p.id = ora.project_id
         INNER JOIN users u ON u.id = ora.user_id
         ${where}
         ORDER BY ora.updated_at DESC`,
        params
      );

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar asignaciones operativas');
  }
};

const upsertOperationalAssignment = async (req, res) => {
  try {
    const { project_id, user_id, role_scope, is_active } = req.body;
    const normalizedScope = normalizeScopeRole(role_scope);

    if (!project_id || !user_id || !normalizedScope) {
      return res.status(400).json({
        success: false,
        message: 'project_id, user_id y role_scope válido (supervisor/leader) son requeridos',
      });
    }

    const activeFlag = Number(is_active) === 0 ? 0 : 1;

    const row = await withDbConnection(async (connection) => {
      await ensureOperationalScopeShape(connection);

      const [projectRows] = await connection.execute('SELECT id FROM projects WHERE id = ? LIMIT 1', [project_id]);
      if (!projectRows.length) {
        throw new HttpError(404, 'Proyecto no encontrado');
      }

      const [userRows] = await connection.execute('SELECT id, role FROM users WHERE id = ? LIMIT 1', [user_id]);
      if (!userRows.length) {
        throw new HttpError(404, 'Usuario no encontrado');
      }

      const userRole = normalizeRole(userRows[0].role);
      if (userRole !== normalizedScope) {
        throw new HttpError(409, `El usuario no tiene rol ${normalizedScope}`);
      }

      await connection.execute(
        `INSERT INTO operational_role_assignments (project_id, user_id, role_scope, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           is_active = VALUES(is_active),
           updated_at = NOW()`,
        [project_id, user_id, normalizedScope, activeFlag]
      );

      const [rows] = await connection.execute(
        `SELECT
           ora.id,
           ora.project_id,
           p.name AS project_name,
           ora.user_id,
           u.name AS user_name,
           u.email AS user_email,
           ora.role_scope,
           ora.is_active,
           ora.created_at,
           ora.updated_at
         FROM operational_role_assignments ora
         INNER JOIN projects p ON p.id = ora.project_id
         INNER JOIN users u ON u.id = ora.user_id
         WHERE ora.project_id = ? AND ora.user_id = ? AND ora.role_scope = ?
         LIMIT 1`,
        [project_id, user_id, normalizedScope]
      );

      return rows[0];
    });

    res.json({ success: true, message: 'Asignación operativa guardada', data: row });
  } catch (error) {
    sendControllerError(res, error, 'Error al guardar asignación operativa');
  }
};

const deleteOperationalAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const affectedRows = await withDbConnection(async (connection) => {
      await ensureOperationalScopeShape(connection);
      const [result] = await connection.execute('DELETE FROM operational_role_assignments WHERE id = ?', [id]);
      return result.affectedRows;
    });

    if (affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Asignación no encontrada' });
    }

    res.json({ success: true, message: 'Asignación operativa eliminada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al eliminar asignación operativa');
  }
};

module.exports = {
  listOperationalAssignments,
  upsertOperationalAssignment,
  deleteOperationalAssignment,
};
