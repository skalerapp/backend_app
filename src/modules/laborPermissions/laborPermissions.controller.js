const db = require('../../config/database');
const { withDbConnection } = db;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const { normalizeRole } = require('../../middleware/auth.middleware');

const normalizeEmployeeStatus = (statusValue) => (statusValue || '').toString().trim().toLowerCase();
const normalizePermissionStatus = (value) => {
  const raw = (value || 'pending').toString().trim().toLowerCase();
  if (raw === 'approved' || raw === 'aprobado') return 'approved';
  if (raw === 'rejected' || raw === 'rechazado') return 'rejected';
  return 'pending';
};

const normalizeDateValue = (value) => {
  if (value === null || value === undefined) return null;
  const text = value.toString().trim();
  if (text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.substring(0, 10);
  }
  return text;
};

const normalizeNullableText = (value, maxLength = 5000) => {
  if (value == null) return null;
  const text = value.toString().trim();
  if (!text) return null;
  return text.length > maxLength ? text.substring(0, maxLength) : text;
};

const canDecideLaborPermission = (normalizedRole) => {
  return (
    normalizedRole === 'super_admin' ||
    normalizedRole === 'administrative' ||
    normalizedRole === 'coordinator_operations'
  );
};

const ensureLaborPermissionsTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS labor_permissions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      employee_id INT NOT NULL,
      permission_type VARCHAR(50),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT,
      status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
      requested_by_user_id INT NULL,
      approver_user_id INT NULL,
      decided_at DATETIME NULL,
      decision_notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      INDEX idx_dates (start_date, end_date),
      INDEX idx_status (status)
    )
  `);

  const columns = [
    ['requested_by_user_id', 'INT NULL'],
    ['approver_user_id', 'INT NULL'],
    ['decided_at', 'DATETIME NULL'],
    ['decision_notes', 'TEXT NULL'],
  ];

  for (const [columnName, definition] of columns) {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'labor_permissions'
         AND COLUMN_NAME = ?`,
      [columnName]
    );
    if (Number(rows[0]?.total || 0) === 0) {
      await connection.execute(`ALTER TABLE labor_permissions ADD COLUMN ${columnName} ${definition}`);
    }
  }
};

const laborPermissionSelect = `
  SELECT lp.*, e.position, e.department, e.status AS employee_status,
         COALESCE(u.name, e.employee_name, CONCAT('Colaborador #', lp.employee_id)) AS employee_name,
         req.name AS requested_by_name,
         app.name AS approver_name
  FROM labor_permissions lp
  LEFT JOIN employees e ON lp.employee_id = e.id
  LEFT JOIN users u ON e.user_id = u.id
  LEFT JOIN users req ON req.id = lp.requested_by_user_id
  LEFT JOIN users app ON app.id = lp.approver_user_id
`;

const validateDateRange = (startDate, endDate) => {
  const start = normalizeDateValue(startDate);
  const end = normalizeDateValue(endDate);
  if (start && end && start > end) {
    throw new HttpError(400, 'La fecha de fin no puede ser anterior a la fecha de inicio');
  }
};

const getLaborPermissions = async (req, res) => {
  try {
    const rows = await withDbConnection(async (connection) => {
      await ensureLaborPermissionsTable(connection);

      const [result] = await connection.execute(
        `${laborPermissionSelect}
         ORDER BY lp.created_at DESC`
      );

      return result;
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener permisos laborales');
  }
};

const getLaborPermissionById = async (req, res) => {
  try {
    const { id } = req.params;
    const row = await withDbConnection(async (connection) => {
      await ensureLaborPermissionsTable(connection);

      const [rows] = await connection.execute(`${laborPermissionSelect} WHERE lp.id = ?`, [id]);

      return rows[0] || null;
    });

    if (!row) {
      return res.status(404).json({ success: false, message: 'Permiso laboral no encontrado' });
    }

    res.json({ success: true, data: row });
  } catch (error) {
    sendControllerError(res, error, 'Error al obtener permiso laboral');
  }
};

const createLaborPermission = async (req, res) => {
  try {
    const { employee_id, permission_type, start_date, end_date, reason } = req.body;

    if (!employee_id || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'employee_id, start_date y end_date son requeridos',
      });
    }

    validateDateRange(start_date, end_date);

    const laborPermissionId = await withDbConnection(async (connection) => {
      await ensureLaborPermissionsTable(connection);

      const [employeeRows] = await connection.execute(
        'SELECT id, status FROM employees WHERE id = ? LIMIT 1',
        [employee_id]
      );

      if (employeeRows.length === 0) {
        throw new HttpError(404, 'Colaborador no encontrado');
      }

      const employeeStatus = normalizeEmployeeStatus(employeeRows[0].status);
      if (employeeStatus !== 'active') {
        throw new HttpError(400, 'Solo se pueden registrar permisos para colaboradores activos');
      }

      await applyAuditContext(connection, req);
      const [result] = await connection.execute(
        `INSERT INTO labor_permissions
         (employee_id, permission_type, start_date, end_date, reason, status, requested_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NOW())`,
        [
          employee_id,
          permission_type || null,
          start_date,
          end_date,
          reason || null,
          req.user?.id || null,
        ]
      );

      return result.insertId;
    });

    res.status(201).json({
      success: true,
      message: 'Permiso laboral registrado y enviado a aprobación',
      laborPermissionId,
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al crear permiso laboral');
  }
};

const updateLaborPermission = async (req, res) => {
  try {
    const { id } = req.params;
    const { employee_id, permission_type, start_date, end_date, reason, status } = req.body;

    await withDbConnection(async (connection) => {
      await ensureLaborPermissionsTable(connection);

      const [existingRows] = await connection.execute('SELECT * FROM labor_permissions WHERE id = ?', [id]);
      if (existingRows.length === 0) {
        throw new HttpError(404, 'Permiso laboral no encontrado');
      }

      const existing = existingRows[0];
      const normalizedRole = normalizeRole(req.user?.role);

      if (status != null && normalizePermissionStatus(status) !== existing.status) {
        throw new HttpError(400, 'Para aprobar o rechazar usa el endpoint de decisión');
      }

      if (existing.status === 'approved') {
        throw new HttpError(400, 'Permiso aprobado: usa el endpoint de decisión para rechazarlo');
      }

      if (existing.status === 'rejected' && !canDecideLaborPermission(normalizedRole)) {
        throw new HttpError(403, 'No puedes editar un permiso rechazado');
      }

      const nextEmployeeId = employee_id ?? existing.employee_id;
      const employeeChanged = Number(nextEmployeeId) !== Number(existing.employee_id);

      if (employeeChanged) {
        const [employeeRows] = await connection.execute(
          'SELECT id, status FROM employees WHERE id = ? LIMIT 1',
          [nextEmployeeId]
        );

        if (employeeRows.length === 0) {
          throw new HttpError(404, 'Colaborador no encontrado');
        }

        const employeeStatus = normalizeEmployeeStatus(employeeRows[0].status);
        if (employeeStatus !== 'active') {
          throw new HttpError(400, 'Solo se pueden asignar permisos a colaboradores activos');
        }
      }

      const nextStartDate = start_date ?? existing.start_date;
      const nextEndDate = end_date ?? existing.end_date;
      validateDateRange(nextStartDate, nextEndDate);

      await applyAuditContext(connection, req);
      await connection.execute(
        `UPDATE labor_permissions
         SET employee_id = ?, permission_type = ?, start_date = ?, end_date = ?, reason = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          nextEmployeeId,
          permission_type ?? existing.permission_type,
          nextStartDate,
          nextEndDate,
          reason ?? existing.reason,
          id,
        ]
      );
    });

    res.json({ success: true, message: 'Permiso laboral actualizado' });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar permiso laboral');
  }
};

const updateLaborPermissionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const status = normalizePermissionStatus(req.body.status);
    const decisionNotes = normalizeNullableText(req.body.decision_notes, 5000);

    if (status !== 'approved' && status !== 'rejected') {
      throw new HttpError(400, 'Solo se permite aprobar o rechazar permisos laborales');
    }

    if (status === 'rejected' && !decisionNotes) {
      throw new HttpError(400, 'Debes registrar una observación para rechazar el permiso');
    }

    const row = await withDbConnection(async (connection) => {
      await ensureLaborPermissionsTable(connection);

      const normalizedRole = normalizeRole(req.user?.role);
      if (!canDecideLaborPermission(normalizedRole)) {
        throw new HttpError(403, 'No tienes permiso para decidir permisos laborales');
      }

      const [existingRows] = await connection.execute('SELECT * FROM labor_permissions WHERE id = ?', [id]);
      if (!existingRows.length) {
        throw new HttpError(404, 'Permiso laboral no encontrado');
      }

      const existing = existingRows[0];
      if (existing.status !== 'pending') {
        throw new HttpError(409, 'El permiso ya tiene una decisión final registrada');
      }

      await applyAuditContext(connection, req);
      await connection.execute(
        `UPDATE labor_permissions
         SET status = ?, approver_user_id = ?, decided_at = NOW(), decision_notes = ?, updated_at = NOW()
         WHERE id = ?`,
        [status, req.user?.id || null, decisionNotes, id]
      );

      const [rows] = await connection.execute(`${laborPermissionSelect} WHERE lp.id = ?`, [id]);
      return rows[0];
    });

    res.json({
      success: true,
      data: row,
      message: status === 'approved' ? 'Permiso laboral aprobado' : 'Permiso laboral rechazado',
    });
  } catch (error) {
    sendControllerError(res, error, 'Error al decidir permiso laboral');
  }
};

const deleteLaborPermission = async (req, res) => {
  try {
    const { id } = req.params;
    await withDbConnection(async (connection) => {
      await ensureLaborPermissionsTable(connection);

      const [existingRows] = await connection.execute('SELECT status FROM labor_permissions WHERE id = ?', [id]);
      if (!existingRows.length) {
        throw new HttpError(404, 'Permiso laboral no encontrado');
      }

      if (existingRows[0].status === 'approved') {
        throw new HttpError(400, 'No se puede eliminar un permiso aprobado');
      }

      await applyAuditContext(connection, req);
      await connection.execute('DELETE FROM labor_permissions WHERE id = ?', [id]);
    });

    res.json({ success: true, message: 'Permiso laboral eliminado' });
  } catch (error) {
    sendControllerError(res, error, 'Error al eliminar permiso laboral');
  }
};

module.exports = {
  getLaborPermissions,
  getLaborPermissionById,
  createLaborPermission,
  updateLaborPermission,
  updateLaborPermissionStatus,
  deleteLaborPermission,
  ensureLaborPermissionsTable,
};
