const db = require('../../config/database');
const { withDbConnection } = db;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');

const normalizeEmployeeStatus = (statusValue) => (statusValue || '').toString().trim().toLowerCase();
const normalizeDateValue = (value) => {
  if (value === null || value === undefined) return null;
  const text = value.toString().trim();
  if (text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.substring(0, 10);
  }
  return text;
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      INDEX idx_dates (start_date, end_date)
    )
  `);
};

const getLaborPermissions = async (req, res) => {
  try {
    const rows = await withDbConnection(async (connection) => {
      await ensureLaborPermissionsTable(connection);

      const [result] = await connection.execute(
        `SELECT lp.*, e.position, e.department, e.status AS employee_status,
                COALESCE(u.name, e.employee_name, CONCAT('Colaborador #', lp.employee_id)) AS employee_name
         FROM labor_permissions lp
         LEFT JOIN employees e ON lp.employee_id = e.id
         LEFT JOIN users u ON e.user_id = u.id
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

      const [rows] = await connection.execute(
        `SELECT lp.*, e.position, e.department, e.status AS employee_status,
                COALESCE(u.name, e.employee_name, CONCAT('Colaborador #', lp.employee_id)) AS employee_name
         FROM labor_permissions lp
         LEFT JOIN employees e ON lp.employee_id = e.id
         LEFT JOIN users u ON e.user_id = u.id
         WHERE lp.id = ?`,
        [id]
      );

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
    const { employee_id, permission_type, start_date, end_date, reason, status } = req.body;

    if (!employee_id || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'employee_id, start_date y end_date son requeridos'
      });
    }

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
        `INSERT INTO labor_permissions (employee_id, permission_type, start_date, end_date, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          employee_id,
          permission_type || null,
          start_date,
          end_date,
          reason || null,
          status || 'pending'
        ]
      );

      return result.insertId;
    });

    res.status(201).json({
      success: true,
      message: 'Permiso laboral creado',
      laborPermissionId
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

      const [existingRows] = await connection.execute(
        'SELECT * FROM labor_permissions WHERE id = ?',
        [id]
      );

      if (existingRows.length === 0) {
        throw new HttpError(404, 'Permiso laboral no encontrado');
      }

      const existing = existingRows[0];

      if (existing.status === 'approved') {
        const requestedStatus = status ?? existing.status;
        if (requestedStatus !== 'approved' && requestedStatus !== 'rejected') {
          throw new HttpError(400, 'Permiso aprobado: solo puede mantenerse aprobado o pasar a rechazado');
        }

        const currentPermissionType = existing.permission_type ?? null;
        const currentStartDate = normalizeDateValue(existing.start_date);
        const currentEndDate = normalizeDateValue(existing.end_date);
        const currentReason = existing.reason ?? null;
        const currentEmployeeId = Number(existing.employee_id);

        const requestedPermissionType = permission_type ?? currentPermissionType;
        const requestedStartDate = normalizeDateValue(start_date ?? currentStartDate);
        const requestedEndDate = normalizeDateValue(end_date ?? currentEndDate);
        const requestedReason = reason ?? currentReason;
        const requestedEmployeeId = Number(employee_id ?? currentEmployeeId);

        const nonStatusChanged =
          requestedEmployeeId !== currentEmployeeId ||
          requestedPermissionType !== currentPermissionType ||
          requestedStartDate !== currentStartDate ||
          requestedEndDate !== currentEndDate ||
          requestedReason !== currentReason;

        if (nonStatusChanged) {
          throw new HttpError(400, 'Permiso aprobado: no se pueden modificar colaborador, tipo, fechas ni motivo');
        }
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

      await applyAuditContext(connection, req);
      await connection.execute(
        `UPDATE labor_permissions
         SET employee_id = ?, permission_type = ?, start_date = ?, end_date = ?, reason = ?, status = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          employee_id ?? existing.employee_id,
          permission_type ?? existing.permission_type,
          start_date ?? existing.start_date,
          end_date ?? existing.end_date,
          reason ?? existing.reason,
          status ?? existing.status,
          id
        ]
      );
    });

    res.json({ success: true, message: 'Permiso laboral actualizado' });
  } catch (error) {
    sendControllerError(res, error, 'Error al actualizar permiso laboral');
  }
};

const deleteLaborPermission = async (req, res) => {
  try {
    const { id } = req.params;
    await withDbConnection(async (connection) => {
      await ensureLaborPermissionsTable(connection);
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
  deleteLaborPermission,
  ensureLaborPermissionsTable
};
