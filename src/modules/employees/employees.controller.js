const db = require('../../config/database');
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');
const { normalizeRole } = require('../../middleware/auth.middleware');
const {
  ensureOperationalScopeShape,
  buildOperationalVisibilityFilter,
} = require('../operationalScopes/operationalScopes.service');

const normalizeIdentification = (value) => {
  if (value === undefined || value === null) return '';
  return value.toString().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
};

let employeeSchemaReadyPromise = null;

const runEmployeeSchemaMigration = async (providedConnection) => {
  const connection = providedConnection ?? await pool.getConnection();
  const shouldRelease = !providedConnection;
  try {
    try {
      await connection.execute("ALTER TABLE employees ADD COLUMN identification_number VARCHAR(50)");
    } catch (e) {}

    try {
      await connection.execute('ALTER TABLE employees ADD COLUMN employee_name VARCHAR(255)');
    } catch (e) {}

    try {
      await connection.execute('ALTER TABLE employees MODIFY COLUMN user_id INT NULL');
    } catch (e) {}
  } finally {
    if (shouldRelease) {
      connection.release();
    }
  }
};

const ensureEmployeeSchema = async (providedConnection) => {
  if (employeeSchemaReadyPromise != null) {
    await employeeSchemaReadyPromise;
    return;
  }

  employeeSchemaReadyPromise = runEmployeeSchemaMigration(providedConnection);

  try {
    await employeeSchemaReadyPromise;
  } catch (error) {
    employeeSchemaReadyPromise = null;
    throw error;
  }
};

// Obtener todos los empleados
const getEmployees = async (req, res) => {
  let connection;
  try {
    await ensureEmployeeSchema();
    connection = await pool.getConnection();
    await ensureOperationalScopeShape(connection);

    const normalizedRole = normalizeRole(req.user?.role);
    const visibility = buildOperationalVisibilityFilter({
      normalizedRole,
      userId: req.user?.id,
      projectAlias: 'p',
      employeeUserExpression: 'e.user_id',
    });
    const where = visibility.clause ? `WHERE ${visibility.clause}` : '';

    const [employees] = await connection.execute(
      `SELECT
        DISTINCT
        e.*,
        e.employee_name AS name,
        u.name AS app_user_name,
        u.email AS app_user_email,
        u.email AS email
      FROM employees e
      LEFT JOIN users u ON e.user_id = u.id
      LEFT JOIN project_collaborators pc ON pc.employee_id = e.id
      LEFT JOIN projects p ON p.id = pc.project_id
      ${where}
      ORDER BY e.created_at DESC`,
      visibility.params
    );

    res.json({ success: true, data: employees });
  } catch (error) {
    console.error('getEmployees error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener empleados', error: error.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Obtener empleado por ID
const getEmployeeById = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    await ensureEmployeeSchema();
    connection = await pool.getConnection();
    const [employees] = await connection.execute(
      `SELECT
        e.*,
        e.employee_name AS name,
        u.name AS app_user_name,
        u.email AS app_user_email,
        u.email AS email
      FROM employees e
      LEFT JOIN users u ON e.user_id = u.id
      WHERE e.id = ?`,
      [id]
    );

    if (employees.length === 0) {
      return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
    }

    res.json({ success: true, data: employees[0] });
  } catch (error) {
    console.error('getEmployeeById error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener empleado', error: error.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Crear nuevo empleado
const createEmployee = async (req, res) => {
  const { user_id, employee_name, identification_number, position, department, salary, hire_date, status } = req.body;
  const normalizedUserId = user_id === undefined || user_id === null || user_id === '' ? null : user_id;
  const identificationRaw = identification_number?.toString().trim() || null;
  const normalizedIdentification = normalizeIdentification(identificationRaw);

  let connection;
  try {
    await ensureEmployeeSchema();
    connection = await pool.getConnection();

    if (normalizedIdentification) {
      const [existingRows] = await connection.execute(
        'SELECT id, identification_number FROM employees WHERE identification_number IS NOT NULL'
      );
      const existing = existingRows.find(
        (item) => normalizeIdentification(item.identification_number) === normalizedIdentification
      );
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Ya existe un colaborador registrado con esa cédula'
        });
      }
    }

    await applyAuditContext(connection, req);
    const [result] = await connection.execute(
      `INSERT INTO employees (user_id, employee_name, identification_number, position, department, salary, hire_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [normalizedUserId, employee_name || null, identificationRaw, position || null, department || null, salary || null, hire_date || null, status || 'active']
    );

    res.status(201).json({ success: true, message: 'Empleado creado', employeeId: result.insertId });
  } catch (error) {
    console.error('createEmployee error:', error);
    res.status(500).json({ success: false, message: 'Error al crear empleado', error: error.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Actualizar empleado
const updateEmployee = async (req, res) => {
  const { id } = req.params;
  const { user_id, employee_name, identification_number, position, department, salary, hire_date, status } = req.body;
  const normalizedUserId = user_id === undefined || user_id === null || user_id === '' ? null : user_id;
  const identificationRaw = identification_number?.toString().trim() || null;
  const normalizedIdentification = normalizeIdentification(identificationRaw);

  let connection;
  try {
    await ensureEmployeeSchema();
    connection = await pool.getConnection();

    if (normalizedIdentification) {
      const [existingRows] = await connection.execute(
        'SELECT id, identification_number FROM employees WHERE identification_number IS NOT NULL AND id <> ?',
        [id]
      );
      const existing = existingRows.find(
        (item) => normalizeIdentification(item.identification_number) === normalizedIdentification
      );
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Ya existe un colaborador registrado con esa cédula'
        });
      }
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE employees SET user_id = ?, employee_name = ?, identification_number = ?, position = ?, department = ?, salary = ?, hire_date = ?, status = ?, updated_at = NOW()
       WHERE id = ?`,
      [normalizedUserId, employee_name || null, identificationRaw, position || null, department || null, salary || null, hire_date || null, status || 'active', id]
    );

    res.json({ success: true, message: 'Empleado actualizado' });
  } catch (error) {
    console.error('updateEmployee error:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar empleado', error: error.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Eliminar empleado
const deleteEmployee = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    await applyAuditContext(connection, req);
    await connection.execute('DELETE FROM employees WHERE id = ?', [id]);

    res.json({ success: true, message: 'Empleado eliminado' });
  } catch (error) {
    console.error('deleteEmployee error:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar empleado', error: error.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

module.exports = {
  getEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  ensureEmployeeSchema
};
