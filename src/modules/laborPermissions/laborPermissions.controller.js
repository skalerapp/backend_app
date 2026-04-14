const db = require('../../config/database');
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');

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
    const connection = await pool.getConnection();
    await ensureLaborPermissionsTable(connection);

    const [rows] = await connection.execute(
      `SELECT lp.*, e.position, e.department, e.status AS employee_status,
              COALESCE(u.name, e.employee_name, CONCAT('Colaborador #', lp.employee_id)) AS employee_name
       FROM labor_permissions lp
       LEFT JOIN employees e ON lp.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
       ORDER BY lp.created_at DESC`
    );

    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('getLaborPermissions error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener permisos laborales', error: error.message });
  }
};

const getLaborPermissionById = async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
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

    connection.release();

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Permiso laboral no encontrado' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('getLaborPermissionById error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener permiso laboral', error: error.message });
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

    const connection = await pool.getConnection();
    await ensureLaborPermissionsTable(connection);

    const [employeeRows] = await connection.execute(
      'SELECT id, status FROM employees WHERE id = ? LIMIT 1',
      [employee_id]
    );

    if (employeeRows.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Colaborador no encontrado'
      });
    }

    const employeeStatus = normalizeEmployeeStatus(employeeRows[0].status);
    if (employeeStatus !== 'active') {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden registrar permisos para colaboradores activos'
      });
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

    connection.release();

    res.status(201).json({
      success: true,
      message: 'Permiso laboral creado',
      laborPermissionId: result.insertId
    });
  } catch (error) {
    console.error('createLaborPermission error:', error);
    res.status(500).json({ success: false, message: 'Error al crear permiso laboral', error: error.message });
  }
};

const updateLaborPermission = async (req, res) => {
  try {
    const { id } = req.params;
    const { employee_id, permission_type, start_date, end_date, reason, status } = req.body;

    const connection = await pool.getConnection();
    await ensureLaborPermissionsTable(connection);

    const [existingRows] = await connection.execute(
      'SELECT * FROM labor_permissions WHERE id = ?',
      [id]
    );

    if (existingRows.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Permiso laboral no encontrado' });
    }

    const existing = existingRows[0];

    if (existing.status === 'approved') {
      const requestedStatus = status ?? existing.status;
      if (requestedStatus !== 'approved' && requestedStatus !== 'rejected') {
        connection.release();
        return res.status(400).json({
          success: false,
          message: 'Permiso aprobado: solo puede mantenerse aprobado o pasar a rechazado'
        });
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
        connection.release();
        return res.status(400).json({
          success: false,
          message: 'Permiso aprobado: no se pueden modificar colaborador, tipo, fechas ni motivo'
        });
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
        connection.release();
        return res.status(404).json({
          success: false,
          message: 'Colaborador no encontrado'
        });
      }

      const employeeStatus = normalizeEmployeeStatus(employeeRows[0].status);
      if (employeeStatus !== 'active') {
        connection.release();
        return res.status(400).json({
          success: false,
          message: 'Solo se pueden asignar permisos a colaboradores activos'
        });
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

    connection.release();

    res.json({ success: true, message: 'Permiso laboral actualizado' });
  } catch (error) {
    console.error('updateLaborPermission error:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar permiso laboral', error: error.message });
  }
};

const deleteLaborPermission = async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    await ensureLaborPermissionsTable(connection);

    await applyAuditContext(connection, req);
    await connection.execute('DELETE FROM labor_permissions WHERE id = ?', [id]);
    connection.release();

    res.json({ success: true, message: 'Permiso laboral eliminado' });
  } catch (error) {
    console.error('deleteLaborPermission error:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar permiso laboral', error: error.message });
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
