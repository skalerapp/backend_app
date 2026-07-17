const db = require('../../config/database');
const { withDbConnection } = db;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const { normalizeRole } = require('../../middleware/auth.middleware');
const {
  ensureOperationalScopeShape,
  canAccessProjectByOperationalScope,
  buildOperationalVisibilityFilter,
} = require('../operationalScopes/operationalScopes.service');

const normalizeTaskStatus = (value) => {
  const raw = (value || 'pending').toString().trim().toLowerCase();
  switch (raw) {
    case 'in_progress':
    case 'en_progreso':
      return 'in_progress';
    case 'completed':
    case 'completada':
      return 'completed';
    case 'cancelled':
    case 'cancelada':
      return 'cancelled';
    default:
      return 'pending';
  }
};

const normalizeDateValue = (value) => {
  if (value === null || value === undefined) return null;
  const text = value.toString().trim();
  if (text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.substring(0, 10);
  return text || null;
};

const ensureTasksSchema = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS operational_tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      employee_id INT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT NULL,
      due_date DATE NULL,
      priority VARCHAR(20) NOT NULL DEFAULT 'normal',
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      created_by INT NULL,
      completed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      INDEX idx_employee (employee_id),
      INDEX idx_status (status),
      INDEX idx_due_date (due_date)
    )
  `);
};

const assertTaskAccess = async (connection, req, taskRow) => {
  const normalizedRole = normalizeRole(req.user?.role);

  if (
    normalizedRole === 'super_admin' ||
    normalizedRole === 'administrative' ||
    normalizedRole === 'coordinator_operations' ||
    normalizedRole === 'supervisor' ||
    normalizedRole === 'gerencial'
  ) {
    return;
  }

  if (normalizedRole === 'employee') {
    const [rows] = await connection.execute(
      'SELECT id FROM employees WHERE user_id = ? AND id = ? LIMIT 1',
      [req.user.id, taskRow.employee_id]
    );
    if (!rows.length) {
      throw new HttpError(403, 'No tienes acceso a esta tarea');
    }
    return;
  }

  const hasAccess = await canAccessProjectByOperationalScope({
    connection,
    userId: req.user.id,
    role: normalizedRole,
    projectId: Number(taskRow.project_id),
  });
  if (!hasAccess) {
    throw new HttpError(403, 'No tienes acceso operativo a esta tarea');
  }
};

const listTasks = async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
    const status = req.query.status ? normalizeTaskStatus(req.query.status) : null;

    const rows = await withDbConnection(async (connection) => {
      await ensureTasksSchema(connection);
      await ensureOperationalScopeShape(connection);

      const normalizedRole = normalizeRole(req.user?.role);
      const conditions = [];
      const params = [];

      const visibility = buildOperationalVisibilityFilter({
        normalizedRole,
        userId: req.user.id,
        projectAlias: 'p',
        employeeUserExpression: 'e.user_id',
      });

      if (visibility.clause) {
        conditions.push(visibility.clause);
        params.push(...visibility.params);
      }

      if (projectId) {
        conditions.push('t.project_id = ?');
        params.push(projectId);
      }
      if (employeeId) {
        conditions.push('t.employee_id = ?');
        params.push(employeeId);
      }
      if (status) {
        conditions.push('t.status = ?');
        params.push(status);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [result] = await connection.execute(
        `SELECT t.*, p.name AS project_name, p.ot_code,
                COALESCE(u.name, e.employee_name, CONCAT('Colaborador #', e.id)) AS employee_name
         FROM operational_tasks t
         INNER JOIN projects p ON p.id = t.project_id
         LEFT JOIN employees e ON e.id = t.employee_id
         LEFT JOIN users u ON u.id = e.user_id
         ${where}
         ORDER BY
           CASE t.status
             WHEN 'pending' THEN 0
             WHEN 'in_progress' THEN 1
             WHEN 'completed' THEN 2
             ELSE 3
           END,
           t.due_date IS NULL,
           t.due_date ASC,
           t.id DESC
         LIMIT 500`,
        params
      );
      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al listar tareas operativas');
  }
};

const createTask = async (req, res) => {
  try {
    const { project_id, employee_id, title, description, due_date, priority, status } = req.body;
    if (!project_id || !title) {
      throw new HttpError(400, 'project_id y title son requeridos');
    }

    const row = await withDbConnection(async (connection) => {
      await ensureTasksSchema(connection);
      await ensureOperationalScopeShape(connection);

      const normalizedRole = normalizeRole(req.user?.role);
      if (['leader', 'supervisor'].includes(normalizedRole)) {
        const hasAccess = await canAccessProjectByOperationalScope({
          connection,
          userId: req.user.id,
          role: normalizedRole,
          projectId: Number(project_id),
        });
        if (!hasAccess) {
          throw new HttpError(403, 'No tienes acceso operativo a este proyecto');
        }
      }

      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO operational_tasks
         (project_id, employee_id, title, description, due_date, priority, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project_id,
          employee_id || null,
          title.toString().trim(),
          description || null,
          normalizeDateValue(due_date),
          (priority || 'normal').toString().trim(),
          normalizeTaskStatus(status),
          req.user?.id || null,
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM operational_tasks WHERE id = ?', [result.insertId]);
      return rows[0];
    });

    res.status(201).json({ success: true, data: row, message: 'Tarea creada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al crear tarea operativa');
  }
};

const updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    const row = await withDbConnection(async (connection) => {
      await ensureTasksSchema(connection);
      await ensureOperationalScopeShape(connection);

      const [existingRows] = await connection.execute('SELECT * FROM operational_tasks WHERE id = ?', [id]);
      if (!existingRows.length) {
        throw new HttpError(404, 'Tarea no encontrada');
      }
      const existing = existingRows[0];

      await assertTaskAccess(connection, req, existing);

      const normalizedRole = normalizeRole(req.user?.role);
      if (normalizedRole === 'employee') {
        const allowedKeys = ['status'];
        const hasDisallowedChange = Object.keys(req.body || {}).some((key) => {
          if (allowedKeys.includes(key)) return false;
          if (key === 'status') return false;
          const nextValue = req.body[key];
          if (nextValue == null) return false;
          return true;
        });
        if (hasDisallowedChange) {
          throw new HttpError(403, 'Solo puedes actualizar el estado de tus tareas asignadas');
        }
      }

      const nextStatus = req.body.status == null ? existing.status : normalizeTaskStatus(req.body.status);
      let completedAt = existing.completed_at;
      if (nextStatus === 'completed' && !completedAt) {
        completedAt = new Date();
      }
      if (nextStatus !== 'completed') {
        completedAt = null;
      }

      await applyAuditContext(connection, req);
      await connection.execute(
        `UPDATE operational_tasks
         SET employee_id = ?, title = ?, description = ?, due_date = ?, priority = ?, status = ?, completed_at = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          req.body.employee_id == null ? existing.employee_id : req.body.employee_id,
          (req.body.title ?? existing.title).toString().trim(),
          req.body.description == null ? existing.description : req.body.description,
          req.body.due_date == null ? existing.due_date : normalizeDateValue(req.body.due_date),
          (req.body.priority ?? existing.priority).toString().trim(),
          nextStatus,
          completedAt,
          id,
        ]
      );
      const [rows] = await connection.execute('SELECT * FROM operational_tasks WHERE id = ?', [id]);
      return rows[0];
    });

    res.json({ success: true, data: row, message: 'Tarea actualizada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar tarea operativa');
  }
};

const deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    await withDbConnection(async (connection) => {
      await ensureTasksSchema(connection);
      await ensureOperationalScopeShape(connection);

      const [existingRows] = await connection.execute('SELECT * FROM operational_tasks WHERE id = ?', [id]);
      if (!existingRows.length) {
        throw new HttpError(404, 'Tarea no encontrada');
      }

      await assertTaskAccess(connection, req, existingRows[0]);
      await applyAuditContext(connection, req);
      const [result] = await connection.execute('DELETE FROM operational_tasks WHERE id = ?', [id]);
      if (!result.affectedRows) {
        throw new HttpError(404, 'Tarea no encontrada');
      }
    });
    res.json({ success: true, message: 'Tarea eliminada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al eliminar tarea operativa');
  }
};

module.exports = {
  ensureTasksSchema,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
};
