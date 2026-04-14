const jwt = require('jsonwebtoken');
const { MODULE_ACCESS_POLICY } = require('../config/moduleAccessPolicy');
const { getSessionState, touchSession } = require('../modules/auth/auth.session.service');

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
    case 'cordinador':
    case 'cordinador_operativo':
    case 'cordinador_operaciones':
    case 'coordinador':
    case 'coordinador_operativo':
    case 'coordinador_operacion':
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

// Middleware para verificar JWT
const verifyToken = async (req, res, next) => {
  const token = req.headers['authorization'];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Token no proporcionado'
    });
  }

  const bearerToken = token.startsWith('Bearer ') ? token.slice(7) : token;

  try {
    const secret = process.env.JWT_SECRET || 'skaler_dev_secret';
    const decoded = jwt.verify(bearerToken, secret);

    if (decoded && decoded.sid) {
      const sessionType = decoded.session_type === 'web' ? 'web' : 'app';
      const sessionState = await getSessionState({
        jwtSessionId: decoded.sid,
        sessionType,
      });

      if (!sessionState.valid) {
        return res.status(403).json({
          success: false,
          message: 'La sesión vinculada ya no está activa',
          reason: sessionState.reason,
        });
      }

      await touchSession({
        jwtSessionId: decoded.sid,
        sessionType,
      });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({
      success: false,
      message: 'Token inválido o expirado'
    });
  }
};

// Middleware para verificar roles
const verifyRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    const normalizedUserRole = normalizeRole(req.user.role);
    const normalizedAllowedRoles = allowedRoles.map((item) => normalizeRole(item));

    if (normalizedUserRole === 'super_admin') {
      return next();
    }

    if (!normalizedAllowedRoles.includes(normalizedUserRole)) {
      return res.status(403).json({
        success: false,
        message: 'Acceso denegado. Rol insuficiente.'
      });
    }

    next();
  };
};

const verifyModuleAccess = (moduleKey, action = 'read') => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    const normalizedUserRole = normalizeRole(req.user.role);
    const rolePolicy = MODULE_ACCESS_POLICY[normalizedUserRole] || {};
    const moduleActions = rolePolicy[moduleKey] || [];

    if (moduleActions.includes(action) || moduleActions.includes('*')) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: `Acceso denegado al módulo ${moduleKey} para la acción ${action}`,
    });
  };
};

module.exports = {
  verifyToken,
  verifyRole,
  verifyModuleAccess,
  normalizeRole,
};
