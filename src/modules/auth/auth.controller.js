const { pool } = require('../../config/database');
const { hashPassword, comparePassword, generateToken } = require('../../utils/auth.utils');
const { validationResult } = require('express-validator');
const {
  ensureAuthSessionSchema,
  createAppSession,
  createWebLaunchTicket,
  consumeWebLaunchTicket,
  revokeAppSessionByJwtSessionId,
  revokeWebSessionByJwtSessionId,
  getSessionState,
  getAppSessionBridgeOverview,
  getWebLaunchTicketState,
  touchSession,
  buildLaunchUrl,
  getWebAppUrl,
} = require('./auth.session.service');

// Registro de usuario
const register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, name, role } = req.body;

    const connection = await pool.getConnection();

    // Verificar si el usuario ya existe
    const [existingUser] = await connection.execute(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (existingUser.length > 0) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'El usuario ya existe'
      });
    }

    // Encriptar contraseña
    const hashedPassword = await hashPassword(password);

    // Crear usuario
    const [result] = await connection.execute(
      'INSERT INTO users (email, password, name, role, created_at) VALUES (?, ?, ?, ?, NOW())',
      [email, hashedPassword, name, role || 'employee']
    );

    connection.release();

    res.status(201).json({
      success: true,
      message: 'Usuario registrado exitosamente',
      userId: result.insertId
    });
  } catch (error) {
    console.error('Error en register:', error && error.stack ? error.stack : error);
    res.status(500).json({
      success: false,
      message: 'Error en registro',
      error: error.message
    });
  }
};

// Inicio de sesión
const login = async (req, res) => {
  try {
    await ensureAuthSessionSchema();

    const clientPlatform = (req.headers['x-skaler-client'] || '').toString().trim().toLowerCase();
    const origin = (req.headers.origin || req.headers.referer || '').toString().toLowerCase();
    const devLoginRequested = (req.headers['x-skaler-dev-login'] || '').toString().trim().toLowerCase() === 'true';
    const allowDevWebLogin = process.env.NODE_ENV !== 'production' && devLoginRequested;
    if ((clientPlatform === 'web' || origin.includes(':8080')) && !allowDevWebLogin) {
      return res.status(403).json({
        success: false,
        message: 'El acceso web solo funciona con un enlace temporal generado desde la app móvil.',
      });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;
    const identifier = (email || '').toString().trim().toLowerCase();

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Debes ingresar usuario/email y contraseña',
      });
    }

    const connection = await pool.getConnection();

    const [users] = await connection.execute(
      `SELECT *
       FROM users
       WHERE LOWER(email) = ? OR LOWER(name) = ?
       LIMIT 1`,
      [identifier, identifier]
    );

    connection.release();

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    const user = users[0];
    const passwordValid = await comparePassword(password, user.password);

    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    const appSession = await createAppSession({
      user,
      deviceLabel: req.headers['x-device-label'] || 'mobile-app',
    });
    const token = generateToken(user, {
      sessionId: appSession.jwtSessionId,
      sessionType: 'app',
    });
    const bridgeOverview = await getAppSessionBridgeOverview({ appSessionId: appSession.appSessionId || appSession.id || null });

    res.json({
      success: true,
      message: 'Inicio de sesión exitoso',
      token,
      session: {
        type: 'app',
        sessionId: appSession.jwtSessionId,
        expiresAt: appSession.expiresAt,
      },
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      },
      bridgeOverview,
    });
  } catch (error) {
    console.error('Error en login:', error && error.stack ? error.stack : error);
    res.status(500).json({
      success: false,
      message: 'Error en login',
      error: error.message
    });
  }
};

// Refrescar token
const refreshToken = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado',
      });
    }

    res.json({
      success: true,
      message: 'Token refrescado'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al refrescar token'
    });
  }
};

// Cerrar sesión
const logout = async (req, res) => {
  try {
    const sessionId = req.user?.sid;
    const sessionType = req.user?.session_type === 'web' ? 'web' : 'app';

    if (sessionId) {
      if (sessionType === 'web') {
        await revokeWebSessionByJwtSessionId({
          jwtSessionId: sessionId,
          reason: 'Sesión web cerrada por el usuario',
        });
      } else {
        await revokeAppSessionByJwtSessionId({
          jwtSessionId: sessionId,
          reason: 'Sesión móvil cerrada por el usuario',
        });
      }
    }

    res.json({
      success: true,
      message: 'Sesión cerrada'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al cerrar sesión'
    });
  }
};

const createTemporaryWebLaunch = async (req, res) => {
  try {
    const sessionId = req.user?.sid;
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'La sesión actual no soporta enlace web temporal. Inicia sesión nuevamente en la app.',
      });
    }

    const sessionState = await getSessionState({ jwtSessionId: sessionId, sessionType: 'app' });
    if (!sessionState.valid) {
      return res.status(403).json({
        success: false,
        message: 'La sesión móvil ya no está activa',
      });
    }

    const ticket = await createWebLaunchTicket({
      appSessionId: sessionState.appSessionId,
      userId: req.user.id,
    });
    const bridgeOverview = await getAppSessionBridgeOverview({ appSessionId: sessionState.appSessionId });

    res.status(201).json({
      success: true,
      message: 'Enlace temporal generado',
      data: {
        ticket: ticket.ticketCode,
        expiresAt: ticket.expiresAt,
        launchUrl: ticket.launchUrl,
        fallbackConsumeUrl: `/api/auth/web-session/consume`,
        webAppUrl: getWebAppUrl() || null,
        bridgeOverview,
      },
    });
  } catch (error) {
    console.error('Error al generar enlace temporal web:', error && error.stack ? error.stack : error);
    res.status(500).json({
      success: false,
      message: 'No fue posible generar el enlace temporal web',
      error: error.message,
    });
  }
};

const consumeTemporaryWebLaunch = async (req, res) => {
  try {
    await ensureAuthSessionSchema();
    const ticketCode = (req.body?.ticket || req.query?.ticket || '').toString().trim();
    if (!ticketCode) {
      return res.status(400).json({
        success: false,
        message: 'Debes enviar el ticket temporal',
      });
    }

    const consumed = await consumeWebLaunchTicket({
      ticketCode,
      consumedByIp: req.ip,
    });
    const token = generateToken(consumed.user, {
      sessionId: consumed.jwtSessionId,
      sessionType: 'web',
      linkedAppSessionId: consumed.appSessionId,
    });

    res.json({
      success: true,
      message: 'Sesión web iniciada',
      token,
      session: {
        type: 'web',
        sessionId: consumed.jwtSessionId,
        linkedAppSessionId: consumed.appSessionId,
        expiresAt: consumed.expiresAt,
      },
      user: consumed.user,
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'No fue posible abrir la sesión web';
    res.status(400).json({
      success: false,
      message,
    });
  }
};

const heartbeatSession = async (req, res) => {
  try {
    const sessionId = req.user?.sid;
    const sessionType = req.user?.session_type === 'web' ? 'web' : 'app';
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'La sesión actual no soporta heartbeat',
      });
    }

    await touchSession({ jwtSessionId: sessionId, sessionType });
    const state = await getSessionState({ jwtSessionId: sessionId, sessionType });
    const bridgeOverview = state.valid && sessionType === 'app'
      ? await getAppSessionBridgeOverview({ appSessionId: state.appSessionId })
      : null;

    res.json({
      success: true,
      message: 'Heartbeat registrado',
      data: {
        active: state.valid,
        sessionType,
        linkedAppSessionActive: state.valid,
        bridgeOverview,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'No fue posible actualizar la sesión',
      error: error.message,
    });
  }
};

const sessionStatus = async (req, res) => {
  try {
    const sessionId = req.user?.sid;
    const sessionType = req.user?.session_type === 'web' ? 'web' : 'app';
    if (!sessionId) {
      return res.json({
        success: true,
        data: {
          active: false,
          reason: 'legacy_session_unsupported',
          sessionType: 'legacy',
          linkedAppSessionActive: false,
        },
      });
    }

    const state = req.sessionState || await getSessionState({ jwtSessionId: sessionId, sessionType });
    const bridgeOverview = state.valid && sessionType === 'app'
      ? await getAppSessionBridgeOverview({ appSessionId: state.appSessionId })
      : null;
    res.json({
      success: true,
      data: {
        active: state.valid,
        reason: state.reason || null,
        sessionType,
        linkedAppSessionActive: state.valid,
        bridgeOverview,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'No fue posible consultar el estado de la sesión',
      error: error.message,
    });
  }
};

const webLaunchTicketMessages = {
  not_found: 'El enlace temporal no existe o ya no está disponible',
  ticket_revoked: 'El enlace temporal fue revocado y ya no está disponible',
  ticket_consumed: 'El enlace temporal ya fue usado',
  ticket_used_or_revoked: 'El enlace temporal ya fue usado o invalidado',
  ticket_expired: 'El enlace temporal ya expiró',
  app_session_revoked: 'La sesión móvil asociada ya no está activa',
  app_session_expired: 'La sesión móvil asociada ya expiró',
  app_session_inactive: 'La sesión móvil asociada ya no está activa',
};

const webLaunchTicketStatus = async (req, res) => {
  const ticketCode = (req.params.ticket || '').toString().trim();
  if (!ticketCode) {
    return res.status(400).json({
      success: false,
      message: 'Ticket inválido',
    });
  }

  try {
    const ticketState = await getWebLaunchTicketState({ ticketCode });
    if (!ticketState.valid) {
      return res.status(410).json({
        success: false,
        message: webLaunchTicketMessages[ticketState.reason] || 'El enlace temporal ya no está disponible',
        reason: ticketState.reason,
        data: {
          ticketStatus: ticketState.ticketStatus || null,
          valid: false,
        },
      });
    }

    return res.json({
      success: true,
      message: 'Enlace temporal válido',
      data: {
        valid: true,
        ticketStatus: ticketState.ticketStatus,
        expiresAt: ticketState.expiresAt || null,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'No fue posible validar el enlace temporal',
      error: error.message,
    });
  }
};

const previewWebLaunch = async (req, res) => {
  const ticketCode = (req.params.ticket || '').toString().trim();
  if (!ticketCode) {
    return res.status(400).json({
      success: false,
      message: 'Ticket inválido',
    });
  }

  try {
    const ticketState = await getWebLaunchTicketState({ ticketCode });
    if (!ticketState.valid) {
      return res.status(410).json({
        success: false,
        message: webLaunchTicketMessages[ticketState.reason] || 'El enlace temporal ya no está disponible',
        reason: ticketState.reason,
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'No fue posible validar el enlace temporal',
      error: error.message,
    });
  }

  const launchUrl = buildLaunchUrl(ticketCode);
  if (!launchUrl) {
    return res.status(200).json({
      success: true,
      message: 'Ticket válido. Configura WEB_APP_URL para redirigir automáticamente al cliente web.',
      data: {
        ticket: ticketCode,
        consumeUrl: '/api/auth/web-session/consume',
      },
    });
  }

  return res.redirect(302, launchUrl);
};

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  createTemporaryWebLaunch,
  consumeTemporaryWebLaunch,
  heartbeatSession,
  sessionStatus,
  webLaunchTicketStatus,
  previewWebLaunch,
};
