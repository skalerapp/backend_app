const db = require('../../config/database');
const { withDbConnection } = db;
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
    case 'super_admin':
    case 'superadmin':
      return 'super_admin';
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

const ensureAttendanceShape = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INT PRIMARY KEY AUTO_INCREMENT,
      employee_id INT NOT NULL,
      project_id INT,
      check_in TIMESTAMP NULL,
      check_out TIMESTAMP NULL,
      location_latitude DECIMAL(10, 8),
      location_longitude DECIMAL(11, 8),
      attendance_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      FOREIGN KEY (project_id) REFERENCES projects(id),
      INDEX idx_employee (employee_id),
      INDEX idx_date (attendance_date)
    )
  `);

  try {
    await connection.execute('ALTER TABLE attendance MODIFY COLUMN employee_id INT NULL');
  } catch (e) {}
  try {
    await connection.execute('ALTER TABLE attendance ADD COLUMN user_id INT NULL');
  } catch (e) {}
  try {
    await connection.execute('ALTER TABLE attendance ADD COLUMN photo_path VARCHAR(500) NULL');
  } catch (e) {}
  try {
    await connection.execute('ALTER TABLE attendance ADD COLUMN checkout_location_latitude DECIMAL(10, 8) NULL');
  } catch (e) {}
  try {
    await connection.execute('ALTER TABLE attendance ADD COLUMN checkout_location_longitude DECIMAL(11, 8) NULL');
  } catch (e) {}
  try {
    await connection.execute('ALTER TABLE attendance ADD COLUMN checkout_photo_path VARCHAR(500) NULL');
  } catch (e) {}
  try {
    await connection.execute('ALTER TABLE attendance ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  } catch (e) {}
  try {
    await connection.execute("ALTER TABLE attendance ADD COLUMN time_category VARCHAR(30) NOT NULL DEFAULT 'productive'");
  } catch (e) {}
  try {
    await connection.execute('ALTER TABLE attendance ADD COLUMN unproductive_reason VARCHAR(255) NULL');
  } catch (e) {}
};

const normalizeTimeCategory = (value) => {
  const raw = (value || 'productive').toString().trim().toLowerCase();
  if (raw === 'unproductive' || raw === 'improductivo') return 'unproductive';
  if (raw === 'neutral' || raw === 'neutro') return 'neutral';
  return 'productive';
};

const ATTENDANCE_SELECT_FIELDS = `
  SELECT
    a.id,
    a.employee_id,
    COALESCE(a.user_id, e.user_id) AS user_id,
    a.project_id,
    a.check_in,
    a.check_out,
    a.location_latitude,
    a.location_longitude,
    a.checkout_location_latitude,
    a.checkout_location_longitude,
    a.attendance_date,
    a.photo_path,
    a.checkout_photo_path,
    a.time_category,
    a.unproductive_reason,
    a.created_at,
    a.updated_at,
    p.name AS project_name,
    COALESCE(e.identification_number, '') AS identification_number,
    COALESCE(e.position, '') AS employee_position,
    COALESCE(e.department, '') AS employee_department,
    COALESCE(e.employee_name, user_direct.name, u.name) AS employee_name,
    COALESCE(user_direct.name, u.name) AS app_user_name,
    COALESCE(user_direct.email, u.email) AS app_user_email
  FROM attendance a
  LEFT JOIN projects p ON a.project_id = p.id
  LEFT JOIN employees e ON a.employee_id = e.id
  LEFT JOIN users user_direct ON a.user_id = user_direct.id
  LEFT JOIN users u ON e.user_id = u.id
`;

const buildAttendanceFilters = ({
  req,
  employeeId,
  userId,
  attendanceDate,
  dateFrom,
  dateTo,
  projectId,
}) => {
  const conditions = [];
  const params = [];
  const normalizedRole = normalizeRole(req.user?.role);

  if (employeeId) {
    conditions.push('a.employee_id = ?');
    params.push(employeeId);
  }

  if (userId) {
    conditions.push('COALESCE(a.user_id, e.user_id) = ?');
    params.push(userId);
  }

  if (attendanceDate) {
    conditions.push('a.attendance_date = ?');
    params.push(attendanceDate);
  }

  if (dateFrom) {
    conditions.push('a.attendance_date >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push('a.attendance_date <= ?');
    params.push(dateTo);
  }

  if (projectId) {
    conditions.push('a.project_id = ?');
    params.push(projectId);
  }

  const isOwnUserFilter = userId && Number(userId) === Number(req.user.id);
  if (!isOwnUserFilter) {
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
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
};

const canExportHrAttendanceReport = (roleValue) => {
  const role = normalizeRole(roleValue);
  return role === 'super_admin' || role === 'administrative';
};

const parseIsoDate = (value) => {
  if (!value) return null;
  const normalized = value.toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }
  return normalized;
};

const getAttendance = async (req, res) => {
  try {
    const { employee_id, user_id, attendance_date } = req.query;
    const rows = await withDbConnection(async (connection) => {
      await ensureAttendanceShape(connection);
      await ensureOperationalScopeShape(connection);

      const { where, params } = buildAttendanceFilters({
        req,
        employeeId: employee_id,
        userId: user_id,
        attendanceDate: attendance_date,
      });

      const [result] = await connection.execute(
        `${ATTENDANCE_SELECT_FIELDS}
         ${where}
         ORDER BY a.attendance_date DESC, a.check_in DESC`,
        params
      );

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener asistencia');
  }
};

const exportAttendanceReport = async (req, res) => {
  try {
    if (!canExportHrAttendanceReport(req.user?.role)) {
      return res.status(403).json({
        success: false,
        message: 'Solo el perfil administrativo puede exportar el reporte de asistencia',
      });
    }

    const dateFrom = parseIsoDate(req.query.from || req.query.date_from);
    const dateTo = parseIsoDate(req.query.to || req.query.date_to);
    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        success: false,
        message: 'Debes enviar from y to con formato YYYY-MM-DD',
      });
    }

    if (dateFrom > dateTo) {
      return res.status(400).json({
        success: false,
        message: 'La fecha inicial no puede ser mayor que la fecha final',
      });
    }

    const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;

    const rows = await withDbConnection(async (connection) => {
      await ensureAttendanceShape(connection);
      await ensureOperationalScopeShape(connection);

      const { where, params } = buildAttendanceFilters({
        req,
        employeeId: Number.isFinite(employeeId) ? employeeId : null,
        projectId: Number.isFinite(projectId) ? projectId : null,
        dateFrom,
        dateTo,
      });

      const [result] = await connection.execute(
        `${ATTENDANCE_SELECT_FIELDS}
         ${where}
         ORDER BY a.attendance_date ASC, a.check_in ASC`,
        params
      );

      return result;
    });

    res.json({
      success: true,
      message: 'Reporte de asistencia generado',
      data: rows,
      meta: {
        from: dateFrom,
        to: dateTo,
        total: rows.length,
        employeeId: Number.isFinite(employeeId) ? employeeId : null,
        projectId: Number.isFinite(projectId) ? projectId : null,
      },
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al exportar reporte de asistencia');
  }
};

const getAttendanceById = async (req, res) => {
  try {
    const { id } = req.params;
    const row = await withDbConnection(async (connection) => {
      await ensureAttendanceShape(connection);
      await ensureOperationalScopeShape(connection);

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
        `SELECT
           a.id,
           a.employee_id,
          COALESCE(a.user_id, e.user_id) AS user_id,
           a.project_id,
           a.check_in,
           a.check_out,
           a.location_latitude,
           a.location_longitude,
           a.checkout_location_latitude,
           a.checkout_location_longitude,
           a.attendance_date,
           a.photo_path,
           a.checkout_photo_path,
           a.created_at,
           a.updated_at,
           p.name AS project_name,
           COALESCE(e.employee_name, user_direct.name, u.name) AS employee_name,
           COALESCE(user_direct.name, u.name) AS app_user_name,
           COALESCE(user_direct.email, u.email) AS app_user_email
         FROM attendance a
         LEFT JOIN projects p ON a.project_id = p.id
         LEFT JOIN employees e ON a.employee_id = e.id
         LEFT JOIN users user_direct ON a.user_id = user_direct.id
         LEFT JOIN users u ON e.user_id = u.id
         ${where}`,
        params
      );

      return rows[0] || null;
    });

    if (!row) {
      return res.status(404).json({ success: false, message: 'Registro no encontrado' });
    }

    res.json({ success: true, data: row });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener registro');
  }
};

const checkInAttendance = async (req, res) => {
  try {
    const {
      employee_id,
      project_id,
      location_latitude,
      location_longitude,
      photo_path,
      attendance_date
    } = req.body;

    const today = attendance_date || new Date().toISOString().slice(0, 10);

    const attendanceId = await withDbConnection(async (connection) => {
      await ensureAttendanceShape(connection);
      await ensureOperationalScopeShape(connection);

      const normalizedRole = normalizeRole(req.user?.role);
      const usesUserAttendanceOnly = (
        !employee_id &&
        (
          normalizedRole === 'administrative' ||
          normalizedRole === 'coordinator_operations' ||
          normalizedRole === 'leader' ||
          normalizedRole === 'supervisor' ||
          normalizedRole === 'commercial'
        )
      );

      if (!employee_id && !usesUserAttendanceOnly) {
        throw new HttpError(400, 'employee_id es requerido para este rol');
      }

      const isAdministrativeUserAttendance =
        usesUserAttendanceOnly &&
        (normalizedRole === 'administrative' || normalizedRole === 'coordinator_operations');

      if (isAdministrativeUserAttendance && project_id) {
        throw new HttpError(400, 'La asistencia administrativa no usa proyecto');
      }

      if ((normalizedRole === 'leader' || normalizedRole === 'supervisor') && project_id) {
        const hasProjectAccess = await canAccessProjectByOperationalScope({
          connection,
          userId: req.user.id,
          role: normalizedRole,
          projectId: Number(project_id),
        });

        if (!hasProjectAccess) {
          throw new HttpError(403, 'No tienes acceso operativo a este proyecto');
        }
      }

      if (employee_id && project_id) {
        const [assignmentRows] = await connection.execute(
          `SELECT 1
           FROM project_collaborators
           WHERE project_id = ? AND employee_id = ?
           LIMIT 1`,
          [project_id, employee_id]
        );

        if (!assignmentRows.length) {
          throw new HttpError(400, 'El colaborador no está asignado al proyecto seleccionado');
        }
      }

      if ((normalizedRole === 'employee' || normalizedRole === 'commercial') && employee_id) {
        const [ownedEmployee] = await connection.execute(
          'SELECT id FROM employees WHERE id = ? AND user_id = ? LIMIT 1',
          [employee_id, req.user.id]
        );
        if (!ownedEmployee.length) {
          throw new HttpError(403, 'Solo puedes registrar tu propia asistencia');
        }
      }

      const duplicateQuery = usesUserAttendanceOnly
        ? {
            sql: `SELECT id, check_out FROM attendance WHERE user_id = ? AND attendance_date = ? LIMIT 1`,
            params: [req.user.id, today],
          }
        : {
            sql: `SELECT id, check_out FROM attendance WHERE employee_id = ? AND attendance_date = ? LIMIT 1`,
            params: [employee_id, today],
          };

      const [existingRows] = await connection.execute(duplicateQuery.sql, duplicateQuery.params);

      if (existingRows.length > 0) {
        throw new HttpError(400, 'Ya existe un registro de asistencia para este colaborador hoy');
      }

      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO attendance (
          employee_id, user_id, project_id, check_in, location_latitude, location_longitude,
          photo_path, attendance_date, created_at
        ) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, NOW())`,
        [
          employee_id || null,
          usesUserAttendanceOnly ? req.user.id : null,
          project_id || null,
          location_latitude || null,
          location_longitude || null,
          photo_path || null,
          today
        ]
      );

      return result.insertId;
    });

    res.status(201).json({
      success: true,
      message: 'Check-in registrado',
      attendanceId
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar check-in');
  }
};

const checkOutAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { location_latitude, location_longitude, photo_path, time_category, unproductive_reason } = req.body;

    await withDbConnection(async (connection) => {
      await ensureAttendanceShape(connection);
      await ensureOperationalScopeShape(connection);
      const normalizedRole = normalizeRole(req.user?.role);

      const [rows] = await connection.execute(
        `SELECT a.*, e.user_id AS employee_user_id
         FROM attendance a
         LEFT JOIN employees e ON e.id = a.employee_id
         WHERE a.id = ?`,
        [id]
      );
      if (!rows.length) {
        throw new HttpError(404, 'Registro no encontrado');
      }

      const existing = rows[0];
      const ownerUserId = Number(existing.user_id || existing.employee_user_id || 0);

      if (normalizedRole === 'employee') {
        const [ownedRows] = await connection.execute(
          `SELECT a.id
           FROM attendance a
           INNER JOIN employees e ON a.employee_id = e.id
           WHERE a.id = ? AND e.user_id = ?
           LIMIT 1`,
          [id, req.user.id]
        );
        if (!ownedRows.length) {
          throw new HttpError(403, 'Solo puedes cerrar tu propia asistencia');
        }
      }

      if (normalizedRole === 'administrative' || normalizedRole === 'coordinator_operations' || normalizedRole === 'gerencial' || normalizedRole === 'commercial') {
        if (ownerUserId !== Number(req.user.id)) {
          throw new HttpError(403, 'Solo puedes cerrar tu propia asistencia');
        }
      }

      if (normalizedRole === 'leader' || normalizedRole === 'supervisor') {
        const isOwnAttendance = ownerUserId === Number(req.user.id);
        let hasProjectAccess = false;

        if (existing.project_id) {
          hasProjectAccess = await canAccessProjectByOperationalScope({
            connection,
            userId: req.user.id,
            role: normalizedRole,
            projectId: Number(existing.project_id),
          });
        }

        if (!isOwnAttendance && !hasProjectAccess) {
          throw new HttpError(403, 'No tienes acceso operativo para cerrar este registro');
        }
      }

      await applyAuditContext(connection, req);
      const normalizedCategory = normalizeTimeCategory(time_category || existing.time_category);
      const normalizedReason = normalizedCategory === 'unproductive'
        ? (unproductive_reason || existing.unproductive_reason || null)
        : null;
      await connection.execute(
        `UPDATE attendance
         SET check_out = NOW(),
             checkout_location_latitude = ?,
             checkout_location_longitude = ?,
             checkout_photo_path = ?,
             time_category = ?,
             unproductive_reason = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [
          location_latitude ?? existing.checkout_location_latitude,
          location_longitude ?? existing.checkout_location_longitude,
          photo_path ?? existing.checkout_photo_path,
          normalizedCategory,
          normalizedReason,
          id
        ]
      );
    });

    res.json({ success: true, message: 'Check-out registrado' });
  } catch (error) {
    sendControllerError(res, error, 'Error al registrar check-out');
  }
};

const getProductivitySummary = async (req, res) => {
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const dateFrom = req.query.date_from ? req.query.date_from.toString().slice(0, 10) : null;
    const dateTo = req.query.date_to ? req.query.date_to.toString().slice(0, 10) : null;

    const data = await withDbConnection(async (connection) => {
      await ensureAttendanceShape(connection);
      await ensureOperationalScopeShape(connection);

      const conditions = ['a.check_in IS NOT NULL'];
      const params = [];

      if (projectId) {
        conditions.push('a.project_id = ?');
        params.push(projectId);
      }
      if (dateFrom) {
        conditions.push('a.attendance_date >= ?');
        params.push(dateFrom);
      }
      if (dateTo) {
        conditions.push('a.attendance_date <= ?');
        params.push(dateTo);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [rows] = await connection.execute(
        `SELECT
           a.id,
           a.project_id,
           p.name AS project_name,
           a.time_category,
           a.check_in,
           a.check_out,
           a.attendance_date
         FROM attendance a
         LEFT JOIN projects p ON p.id = a.project_id
         ${where}
         ORDER BY a.attendance_date DESC, a.id DESC
         LIMIT 1000`,
        params
      );

      let productiveHours = 0;
      let unproductiveHours = 0;
      let neutralHours = 0;
      let productiveRecords = 0;
      let unproductiveRecords = 0;
      let neutralRecords = 0;
      let openRecords = 0;

      const byProjectMap = new Map();

      for (const row of rows) {
        const category = normalizeTimeCategory(row.time_category);
        if (!row.check_out) {
          openRecords += 1;
          continue;
        }

        const checkIn = new Date(row.check_in);
        const checkOut = new Date(row.check_out);
        const hours = Math.max(0, (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60));

        if (category === 'unproductive') {
          unproductiveHours += hours;
          unproductiveRecords += 1;
        } else if (category === 'neutral') {
          neutralHours += hours;
          neutralRecords += 1;
        } else {
          productiveHours += hours;
          productiveRecords += 1;
        }

        const key = row.project_id || 0;
        const current = byProjectMap.get(key) || {
          project_id: row.project_id,
          project_name: row.project_name || 'Sin proyecto',
          productive_hours: 0,
          unproductive_hours: 0,
          neutral_hours: 0,
        };

        if (category === 'unproductive') current.unproductive_hours += hours;
        else if (category === 'neutral') current.neutral_hours += hours;
        else current.productive_hours += hours;

        byProjectMap.set(key, current);
      }

      const totalClosedHours = productiveHours + unproductiveHours + neutralHours;
      const productivityRate = totalClosedHours <= 0
        ? 0
        : Math.round((productiveHours / totalClosedHours) * 100);

      return {
        productive_hours: Number(productiveHours.toFixed(2)),
        unproductive_hours: Number(unproductiveHours.toFixed(2)),
        neutral_hours: Number(neutralHours.toFixed(2)),
        productive_records: productiveRecords,
        unproductive_records: unproductiveRecords,
        neutral_records: neutralRecords,
        open_records: openRecords,
        productivity_rate: productivityRate,
        by_project: [...byProjectMap.values()].sort((a, b) => b.productive_hours - a.productive_hours),
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener resumen de productividad');
  }
};

module.exports = {
  getAttendance,
  getAttendanceById,
  exportAttendanceReport,
  checkInAttendance,
  checkOutAttendance,
  getProductivitySummary,
  ensureAttendanceShape,
  canExportHrAttendanceReport,
};
