const db = require('../../config/database');
const pool = db.pool;
const { applyAuditContext } = require('../../utils/auditContext');
const { hashPassword } = require('../../utils/auth.utils');

const normalizeRequestedRole = (roleValue) => {
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
    case 'cordinador':
    case 'cordinador_operativo':
    case 'cordinador_operaciones':
    case 'coordinador':
    case 'coordinador_operativo':
    case 'coordinador_operaciones':
    case 'coordinador_operacion':
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
    case 'almacen':
    case 'bodega':
    case 'warehouse':
    case 'logistica':
    case 'warehouse_logistics':
    case 'warehouse_logistic':
    case 'almacen_logistica':
    case 'almacen_y_logistica':
    case 'logistica_almacen':
      return 'warehouse_logistics';
    case 'gerencial':
    case 'management':
      return 'gerencial';
    case 'commercial':
    case 'comercial':
    case 'asesor_comercial':
    case 'ejecutivo_comercial':
    case 'commercial_advisor':
      return 'commercial';
    default:
      return raw;
  }
};

const roleToStorageValue = (normalizedRole) => {
  switch (normalizedRole) {
    case 'super_admin':
      return 'super_admin';
    case 'administrative':
      return 'administrative';
    case 'coordinator_operations':
      return 'manager';
    default:
      return normalizedRole;
  }
};

const toApiUser = (row) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: normalizeRequestedRole(row.role),
  status: row.status,
});

const ensureUsersRoleSchema = async (connection) => {
  try {
    await connection.execute("ALTER TABLE users MODIFY COLUMN role VARCHAR(50) NOT NULL DEFAULT 'employee'");
  } catch (e) {}

  try {
    await connection.execute(`
      UPDATE users
      SET role = CASE
        WHEN role IS NULL OR TRIM(role) = '' THEN 'employee'
        WHEN LOWER(TRIM(role)) IN ('admin', 'super_admin', 'superadmin') THEN 'super_admin'
        WHEN LOWER(TRIM(role)) IN ('administrativo', 'administrative') THEN 'administrative'
        WHEN LOWER(TRIM(role)) IN (
          'manager',
          'cordinador',
          'cordinador_operativo',
          'cordinador_operaciones',
          'coordinador',
          'coordinador_operativo',
          'coordinador_operaciones',
          'coordinador_operacion',
          'coordinator_operations'
        ) THEN 'manager'
        WHEN LOWER(TRIM(role)) IN ('lider', 'leader') THEN 'leader'
        WHEN LOWER(TRIM(role)) IN ('empleado', 'colaborador') THEN 'employee'
        WHEN LOWER(TRIM(role)) IN (
          'almacen',
          'bodega',
          'warehouse',
          'logistica',
          'warehouse_logistics',
          'warehouse_logistic',
          'almacen_logistica',
          'almacen_y_logistica',
          'logistica_almacen'
        ) THEN 'warehouse_logistics'
        WHEN LOWER(TRIM(role)) IN ('management') THEN 'gerencial'
        WHEN LOWER(TRIM(role)) IN ('commercial', 'comercial', 'asesor_comercial', 'ejecutivo_comercial', 'commercial_advisor') THEN 'commercial'
        ELSE LOWER(TRIM(role))
      END
    `);
  } catch (e) {}
};

// Obtener todos los usuarios
const getUsers = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await ensureUsersRoleSchema(connection);
    const [users] = await connection.execute(
      'SELECT id, email, name, role, status FROM users WHERE status = ? ORDER BY name ASC',
      ['active']
    );
    connection.release();

    res.json({ success: true, data: users.map(toApiUser) });
  } catch (error) {
    console.error('getUsers error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener usuarios', error: error.message });
  }
};

const createUser = async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    const normalizedEmail = (email || '').toString().trim().toLowerCase();
    const normalizedName = (name || '').toString().trim();
    const normalizedRole = normalizeRequestedRole(role || 'employee');
    const requesterRole = normalizeRequestedRole(req.user?.role || '');

    if (!normalizedEmail || !normalizedName || !password) {
      return res.status(400).json({
        success: false,
        message: 'name, email y password son requeridos',
      });
    }

    if (password.toString().length < 6) {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 6 caracteres',
      });
    }

    const allowedRoles = [
      'super_admin',
      'administrative',
      'coordinator_operations',
      'supervisor',
      'leader',
      'employee',
      'warehouse_logistics',
      'commercial',
      'gerencial',
    ];
    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({
        success: false,
        message: 'Rol inválido',
      });
    }

    if (normalizedRole === 'super_admin' && requesterRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Solo Super Admin puede asignar el rol Super Admin',
      });
    }

    const connection = await pool.getConnection();
    await ensureUsersRoleSchema(connection);

    const [existingRows] = await connection.execute(
      'SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1',
      [normalizedEmail]
    );
    if (existingRows.length > 0) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'Ya existe un usuario con ese correo',
      });
    }

    const hashedPassword = await hashPassword(password.toString());

    const storageRole = roleToStorageValue(normalizedRole);
    await applyAuditContext(connection, req);

    const [result] = await connection.execute(
      'INSERT INTO users (email, password, name, role, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [normalizedEmail, hashedPassword, normalizedName, storageRole, 'active']
    );

    const [rows] = await connection.execute(
      'SELECT id, email, name, role, status FROM users WHERE id = ? LIMIT 1',
      [result.insertId]
    );

    connection.release();

    res.status(201).json({
      success: true,
      message: 'Usuario creado correctamente',
      data: toApiUser(rows[0]),
    });
  } catch (error) {
    console.error('createUser error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear usuario',
      error: error.message,
    });
  }
};

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, role, status, password } = req.body;

    const userId = Number(id);
    if (Number.isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'ID de usuario inválido',
      });
    }

    const normalizedEmail = (email || '').toString().trim().toLowerCase();
    const normalizedName = (name || '').toString().trim();
    const normalizedRole = normalizeRequestedRole(role || 'employee');
    const requesterRole = normalizeRequestedRole(req.user?.role || '');
    const storageRole = roleToStorageValue(normalizedRole);
    const normalizedStatus = (status || 'active').toString().trim().toLowerCase();

    if (!normalizedEmail || !normalizedName) {
      return res.status(400).json({
        success: false,
        message: 'name y email son requeridos',
      });
    }

    const normalizedPassword = password == null ? '' : password.toString();
    if (normalizedPassword.length > 0 && normalizedPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 6 caracteres',
      });
    }

    const allowedRoles = [
      'super_admin',
      'administrative',
      'coordinator_operations',
      'supervisor',
      'leader',
      'employee',
      'warehouse_logistics',
      'commercial',
      'gerencial',
    ];
    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({
        success: false,
        message: 'Rol inválido',
      });
    }

    if (normalizedRole === 'super_admin' && requesterRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Solo Super Admin puede asignar el rol Super Admin',
      });
    }

    const allowedStatuses = ['active', 'inactive'];
    if (!allowedStatuses.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Estado inválido',
      });
    }

    const connection = await pool.getConnection();
    await ensureUsersRoleSchema(connection);

    const [existingRows] = await connection.execute(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    if (existingRows.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    const [emailRows] = await connection.execute(
      'SELECT id FROM users WHERE LOWER(email) = ? AND id <> ? LIMIT 1',
      [normalizedEmail, userId]
    );
    if (emailRows.length > 0) {
      connection.release();
      return res.status(409).json({
        success: false,
        message: 'Ya existe otro usuario con ese correo',
      });
    }

    if (normalizedPassword.length > 0) {
      await applyAuditContext(connection, req);
      const hashedPassword = await hashPassword(normalizedPassword);
      await connection.execute(
        'UPDATE users SET email = ?, name = ?, role = ?, status = ?, password = ? WHERE id = ?',
        [normalizedEmail, normalizedName, storageRole, normalizedStatus, hashedPassword, userId]
      );
    } else {
      await applyAuditContext(connection, req);
      await connection.execute(
        'UPDATE users SET email = ?, name = ?, role = ?, status = ? WHERE id = ?',
        [normalizedEmail, normalizedName, storageRole, normalizedStatus, userId]
      );
    }

    const [rows] = await connection.execute(
      'SELECT id, email, name, role, status FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    connection.release();

    res.json({
      success: true,
      message: 'Usuario actualizado correctamente',
      data: toApiUser(rows[0]),
    });
  } catch (error) {
    console.error('updateUser error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar usuario',
      error: error.message,
    });
  }
};

module.exports = { getUsers, createUser, updateUser };
module.exports.ensureUsersRoleSchema = ensureUsersRoleSchema;
