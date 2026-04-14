const db = require('../../config/database');
const { normalizeRole } = require('../../middleware/auth.middleware');
const { ensureOperationalScopeShape } = require('./operationalScopes.service');

const pool = db.pool;

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
    const connection = await pool.getConnection();
    await ensureOperationalScopeShape(connection);

    const conditions = [];
    const params = [];

    const normalizedScope = role_scope ? normalizeScopeRole(role_scope) : null;
    if (role_scope && !normalizedScope) {
      connection.release();
      return res.status(400).json({ success: false, message: 'role_scope inválido (use supervisor o leader)' });
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
       ${where}
       ORDER BY ora.updated_at DESC`,
      params
    );

    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('listOperationalAssignments error:', error);
    res.status(500).json({ success: false, message: 'Error al listar asignaciones operativas', error: error.message });
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

    const connection = await pool.getConnection();
    await ensureOperationalScopeShape(connection);

    const [projectRows] = await connection.execute('SELECT id FROM projects WHERE id = ? LIMIT 1', [project_id]);
    if (!projectRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Proyecto no encontrado' });
    }

    const [userRows] = await connection.execute('SELECT id, role FROM users WHERE id = ? LIMIT 1', [user_id]);
    if (!userRows.length) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    const userRole = normalizeRole(userRows[0].role);
    if (userRole !== normalizedScope) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: `El usuario no tiene rol ${normalizedScope}`,
      });
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

    connection.release();
    res.json({ success: true, message: 'Asignación operativa guardada', data: rows[0] });
  } catch (error) {
    console.error('upsertOperationalAssignment error:', error);
    res.status(500).json({ success: false, message: 'Error al guardar asignación operativa', error: error.message });
  }
};

const deleteOperationalAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    await ensureOperationalScopeShape(connection);

    const [result] = await connection.execute('DELETE FROM operational_role_assignments WHERE id = ?', [id]);
    connection.release();

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Asignación no encontrada' });
    }

    res.json({ success: true, message: 'Asignación operativa eliminada' });
  } catch (error) {
    console.error('deleteOperationalAssignment error:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar asignación operativa', error: error.message });
  }
};

module.exports = {
  listOperationalAssignments,
  upsertOperationalAssignment,
  deleteOperationalAssignment,
};
