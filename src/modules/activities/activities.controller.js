const db = require('../../config/database');
const { withDbConnection } = db;
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const {
  ensureOperationalScopeShape,
  buildOperationalVisibilityFilter,
  canAccessProjectByOperationalScope,
} = require('../operationalScopes/operationalScopes.service');

const normalizeRole = (roleValue) => {
  const raw = (roleValue || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_');

  switch (raw) {
    case 'admin':
    case 'administrativo':
    case 'administrative':
      return 'administrative';
    case 'manager':
    case 'coordinador':
    case 'coordinador_operaciones':
    case 'coordinator_operations':
      return 'coordinator_operations';
    case 'supervisor':
      return 'supervisor';
    case 'lider':
    case 'leader':
      return 'leader';
    case 'employee':
    case 'empleado':
    case 'colaborador':
      return 'employee';
    default:
      return raw;
  }
};

const normalizeActivityStatus = (value) => {
  const raw = (value || '').toString().trim().toLowerCase();
  switch (raw) {
    case 'planned':
    case 'planificada':
      return 'planned';
    case 'in_progress':
    case 'en progreso':
    case 'en_progreso':
      return 'in_progress';
    case 'paused':
    case 'pausada':
    case 'pausado':
      return 'paused';
    case 'completed':
    case 'completada':
      return 'completed';
    case 'cancelled':
    case 'cancelada':
      return 'cancelled';
    default:
      return 'planned';
  }
};

const ensureActivityStatusShape = async (connection) => {
  try {
    await connection.execute("ALTER TABLE activities ADD COLUMN status ENUM('planned','in_progress','paused','completed','cancelled') DEFAULT 'planned'");
  } catch (e) {}

  try {
    await connection.execute("ALTER TABLE activities MODIFY COLUMN status ENUM('planned','in_progress','paused','completed','cancelled') NOT NULL DEFAULT 'planned'");
  } catch (e) {}

  try {
    await connection.execute("UPDATE activities SET status = 'planned' WHERE status IS NULL OR TRIM(status) = ''");
  } catch (e) {}

  try {
    await connection.execute(`
      UPDATE activities
      SET status = CASE LOWER(TRIM(status))
        WHEN 'planificada' THEN 'planned'
        WHEN 'planned' THEN 'planned'
        WHEN 'en progreso' THEN 'in_progress'
        WHEN 'en_progreso' THEN 'in_progress'
        WHEN 'in progress' THEN 'in_progress'
        WHEN 'in-progress' THEN 'in_progress'
        WHEN 'in_progress' THEN 'in_progress'
        WHEN 'paused' THEN 'paused'
        WHEN 'pausada' THEN 'paused'
        WHEN 'pausado' THEN 'paused'
        WHEN 'completada' THEN 'completed'
        WHEN 'completed' THEN 'completed'
        WHEN 'cancelada' THEN 'cancelled'
        WHEN 'canceled' THEN 'cancelled'
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'planned'
      END
    `);
  } catch (e) {}
};

const ensureActivityLegacyShape = async (connection) => {
  try {
    await connection.execute('ALTER TABLE activities ADD COLUMN title VARCHAR(255) NULL');
  } catch (e) {}

  try {
    await connection.execute('ALTER TABLE activities ADD COLUMN `date` DATE NULL');
  } catch (e) {}

  try {
    await connection.execute('ALTER TABLE activities ADD COLUMN activity_date DATE NULL');
  } catch (e) {}

  try {
    await connection.execute('ALTER TABLE activities ADD COLUMN hours_worked DECIMAL(10,2) DEFAULT 0');
  } catch (e) {}

  try {
    await connection.execute('ALTER TABLE activities ADD COLUMN evidences INT DEFAULT 0');
  } catch (e) {}

  try {
    await connection.execute('ALTER TABLE activities ADD COLUMN executed_area_m2 DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  } catch (e) {}

  try {
    await connection.execute('ALTER TABLE activities ADD COLUMN executed_length_ml DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  } catch (e) {}
};

const syncLegacyActivityRow = async (connection, activityId) => {
  if (!activityId) return;

  try {
    await connection.execute(
      `UPDATE activities
       SET title = COALESCE(NULLIF(TRIM(title), ''), NULLIF(TRIM(description), ''), CONCAT('Actividad #', id))
       WHERE id = ?`,
      [activityId]
    );
  } catch (e) {}

  try {
    await connection.execute(
      "UPDATE activities SET `date` = DATE(created_at) WHERE id = ? AND (`date` IS NULL OR `date` = '0000-00-00')",
      [activityId]
    );
  } catch (e) {}

  try {
    await connection.execute(
      "UPDATE activities SET activity_date = DATE(created_at) WHERE id = ? AND (activity_date IS NULL OR activity_date = '0000-00-00')",
      [activityId]
    );
  } catch (e) {}

  try {
    await connection.execute(
      `UPDATE activities
       SET start_time = COALESCE(start_time, NOW())
       WHERE id = ? AND status IN ('in_progress', 'paused', 'completed', 'cancelled')`,
      [activityId]
    );
  } catch (e) {}

  try {
    await connection.execute(
      `UPDATE activities
       SET end_time = COALESCE(end_time, NOW())
       WHERE id = ? AND status IN ('completed', 'cancelled')`,
      [activityId]
    );
  } catch (e) {}

  try {
    await connection.execute(
      `UPDATE activities
       SET hours_worked = CASE
         WHEN start_time IS NOT NULL AND end_time IS NOT NULL THEN ROUND(TIMESTAMPDIFF(MINUTE, start_time, end_time) / 60, 2)
         ELSE COALESCE(hours_worked, 0)
       END
       WHERE id = ?`,
      [activityId]
    );
  } catch (e) {}

  try {
    await connection.execute(
      `UPDATE activities a
       LEFT JOIN (
         SELECT activity_id, COUNT(*) AS total
         FROM evidence
         WHERE activity_id IS NOT NULL
         GROUP BY activity_id
       ) ev ON ev.activity_id = a.id
       SET a.evidences = COALESCE(ev.total, 0)
       WHERE a.id = ?`,
      [activityId]
    );
  } catch (e) {}
};

const ensureActivitiesSchema = async (connection) => {
  await ensureActivityStatusShape(connection);
  await ensureActivityLegacyShape(connection);
};

// Obtener todas las actividades
const getActivities = async (req, res) => {
  try {
    const activities = await withDbConnection(async (connection) => {
      await ensureActivityStatusShape(connection);
      await ensureActivityLegacyShape(connection);
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

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const [rows] = await connection.execute(
        `SELECT a.*, p.name AS project_name, e.position AS employee_position, e.employee_name AS employee_name
         FROM activities a
         LEFT JOIN projects p ON a.project_id = p.id
         LEFT JOIN employees e ON a.employee_id = e.id
         ${where}
         ORDER BY a.created_at DESC`,
        params,
      );

      return rows;
    });

    res.json({ success: true, data: activities });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener actividades');
  }
};

// Obtener actividad por ID
const getActivityById = async (req, res) => {
  try {
    const { id } = req.params;
    const activity = await withDbConnection(async (connection) => {
      await ensureActivityStatusShape(connection);
      await ensureActivityLegacyShape(connection);
      await ensureOperationalScopeShape(connection);
      await syncLegacyActivityRow(connection, id);

      const normalizedRole = normalizeRole(req.user?.role);
      const visibility = buildOperationalVisibilityFilter({
        normalizedRole,
        userId: req.user.id,
        projectAlias: 'p',
        employeeUserExpression: 'e.user_id',
      });
      const conditions = ['a.id = ?'];
      const params = [id];
      if (visibility.clause) {
        conditions.push(visibility.clause);
        params.push(...visibility.params);
      }

      const where = `WHERE ${conditions.join(' AND ')}`;

      const [rows] = await connection.execute(
        `SELECT a.*, p.name AS project_name, e.position AS employee_position, e.employee_name AS employee_name
         FROM activities a
         LEFT JOIN projects p ON a.project_id = p.id
         LEFT JOIN employees e ON a.employee_id = e.id
         ${where}`,
        params
      );

      return rows[0] || null;
    });

    if (!activity) {
      return res.status(404).json({ success: false, message: 'Actividad no encontrada' });
    }

    res.json({ success: true, data: activity });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener actividad');
  }
};

// Crear actividad nueva
const createActivity = async (req, res) => {
  try {
    const { project_id, employee_id, description, start_time, end_time, status, executed_area_m2, executed_length_ml } = req.body;

    if (!project_id || !employee_id) {
      return res.status(400).json({ success: false, message: 'project_id y employee_id son requeridos' });
    }

    const activityId = await withDbConnection(async (connection) => {
      try {
        await connection.execute("ALTER TABLE activities ADD COLUMN start_time DATETIME");
      } catch (e) {}
      try {
        await connection.execute("ALTER TABLE activities ADD COLUMN end_time DATETIME");
      } catch (e) {}
      try {
        await connection.execute("ALTER TABLE activities ADD COLUMN status ENUM('planned','in_progress','paused','completed','cancelled') DEFAULT 'planned'");
      } catch (e) {}

      await ensureActivityStatusShape(connection);
      await ensureActivityLegacyShape(connection);
      const normalizedStatus = normalizeActivityStatus(status);
      await applyAuditContext(connection, req);

      const resolvedExecutedArea = Number(executed_area_m2) || 0;
      const resolvedExecutedLength = Number(executed_length_ml) || 0;
      const [result] = await connection.execute(
        `INSERT INTO activities (project_id, employee_id, description, start_time, end_time, status, executed_area_m2, executed_length_ml, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [project_id, employee_id, description || null, start_time || null, end_time || null, normalizedStatus, resolvedExecutedArea, resolvedExecutedLength]
      );
      await syncLegacyActivityRow(connection, result.insertId);
      return result.insertId;
    });

    res.status(201).json({ success: true, message: 'Actividad creada', activityId });
  } catch (error) {
    sendControllerError(res, error, 'Error al crear actividad');
  }
};

// Actualizar actividad
const updateActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const { project_id, employee_id, description, start_time, end_time, status, executed_area_m2, executed_length_ml } = req.body;
    const normalizedRole = normalizeRole(req.user?.role);

    await withDbConnection(async (connection) => {
      try {
        await connection.execute("ALTER TABLE activities ADD COLUMN start_time DATETIME");
      } catch (e) {}
      try {
        await connection.execute("ALTER TABLE activities ADD COLUMN end_time DATETIME");
      } catch (e) {}
      try {
        await connection.execute("ALTER TABLE activities ADD COLUMN status ENUM('planned','in_progress','paused','completed','cancelled') DEFAULT 'planned'");
      } catch (e) {}

      await ensureActivityStatusShape(connection);
      await ensureActivityLegacyShape(connection);

      const [rows] = await connection.execute('SELECT * FROM activities WHERE id = ?', [id]);
      if (rows.length === 0) {
        throw new HttpError(404, 'Actividad no encontrada');
      }
      const existing = rows[0];
      const previousStatus = normalizeActivityStatus(existing.status);
      const nextStatus = status !== undefined ? normalizeActivityStatus(status) : previousStatus;

      if (normalizedRole === 'leader' || normalizedRole === 'supervisor') {
        const hasProjectAccess = await canAccessProjectByOperationalScope({
          connection,
          userId: req.user.id,
          role: normalizedRole,
          projectId: Number(existing.project_id),
        });

        if (!hasProjectAccess) {
          throw new HttpError(403, 'No tienes acceso operativo a esta actividad');
        }

        const triesToChangeRestrictedFields =
          project_id !== undefined ||
          employee_id !== undefined ||
          description !== undefined ||
          start_time !== undefined ||
          end_time !== undefined;

        if (triesToChangeRestrictedFields) {
          throw new HttpError(403, 'Para tu rol solo está permitido actualizar el estado de la actividad');
        }
      }

      const pid = project_id !== undefined ? project_id : existing.project_id;
      const eid = employee_id !== undefined ? employee_id : existing.employee_id;
      const desc = description !== undefined ? description : existing.description;
      let st = start_time !== undefined ? start_time : existing.start_time;
      let et = end_time !== undefined ? end_time : existing.end_time;
      const resolvedExecutedArea = executed_area_m2 !== undefined ? Number(executed_area_m2) : Number(existing.executed_area_m2 || 0);
      const resolvedExecutedLength = executed_length_ml !== undefined ? Number(executed_length_ml) : Number(existing.executed_length_ml || 0);
      const stts = nextStatus;

      if (nextStatus === 'in_progress' && previousStatus !== 'in_progress' && (st == null || st === '')) {
        await connection.execute(
          'UPDATE activities SET start_time = NOW() WHERE id = ? AND start_time IS NULL',
          [id]
        );
        const [startedRows] = await connection.execute('SELECT start_time FROM activities WHERE id = ?', [id]);
        st = startedRows[0]?.start_time ?? st;
      }

      if (
        (nextStatus === 'completed' || nextStatus === 'cancelled') &&
        previousStatus !== 'completed' &&
        previousStatus !== 'cancelled' &&
        (et == null || et === '')
      ) {
        await connection.execute(
          'UPDATE activities SET end_time = NOW() WHERE id = ? AND end_time IS NULL',
          [id]
        );
        const [finishedRows] = await connection.execute('SELECT end_time FROM activities WHERE id = ?', [id]);
        et = finishedRows[0]?.end_time ?? et;
      }

      await applyAuditContext(connection, req);
      await connection.execute(
        `UPDATE activities SET project_id = ?, employee_id = ?, description = ?, start_time = ?, end_time = ?, status = ?, executed_area_m2 = ?, executed_length_ml = ?, updated_at = NOW()
         WHERE id = ?`,
        [pid, eid, desc, st, et, stts, resolvedExecutedArea, resolvedExecutedLength, id]
      );
      await syncLegacyActivityRow(connection, id);
    });

    res.json({ success: true, message: 'Actividad actualizada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar actividad');
  }
};

const deleteActivity = async (req, res) => {
  try {
    const { id } = req.params;
    await withDbConnection(async (connection) => {
      await applyAuditContext(connection, req);
      await connection.execute('DELETE FROM activities WHERE id = ?', [id]);
    });

    res.json({ success: true, message: 'Actividad eliminada' });
  } catch (error) {
    sendControllerError(res, error, 'Error al eliminar actividad');
  }
};

module.exports = {
  getActivities,
  getActivityById,
  createActivity,
  updateActivity,
  deleteActivity,
  ensureActivitiesSchema
};
