const { pool } = require('../../config/database');
const { withConnection } = require('../../utils/withConnection');
const { hashPassword, comparePassword, generateToken } = require('../../utils/auth.utils');
const { validationResult } = require('express-validator');
const { getCurrentTermsPayload, CURRENT_TERMS_VERSION } = require('../../config/appTerms');
const {
  ensureUserTermsSchema,
  hasUserAcceptedTerms,
  recordTermsAcceptance,
  listTermsAcceptances,
  listAllTermsAcceptancesForExport,
} = require('./auth.terms.service');
const {
  ensureLoginSecuritySchema,
  recordLoginEvent,
  getLockState,
  registerFailedAttempt,
  clearLockout,
  listLoginEvents,
  isWebPasswordLoginEnabled,
  isWebClientRequest,
} = require('./auth.login.security.service');
const {
  ensureAuthSessionSchema,
  isUserAccountActive,
  createAppSession,
  webStandaloneSessionTtlMs,
  createWebLaunchTicket,
  consumeWebLaunchTicket,
  revokeAppSessionByJwtSessionId,
  revokeWebSessionByJwtSessionId,
  getSessionState,
  getAppSessionBridgeOverview,
  getWebLaunchTicketState,
  touchSession,
  extendSessionExpiry,
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

    const existingUser = await withConnection(pool, async (connection) => {
      const [rows] = await connection.execute(
        'SELECT * FROM users WHERE email = ?',
        [email]
      );
      return rows;
    });

    if (existingUser.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'El usuario ya existe'
      });
    }

    const hashedPassword = await hashPassword(password);

    const result = await withConnection(pool, async (connection) => {
      const [insertResult] = await connection.execute(
        'INSERT INTO users (email, password, name, role, created_at) VALUES (?, ?, ?, ?, NOW())',
        [email, hashedPassword, name, role || 'employee']
      );
      return insertResult;
    });

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
    await ensureLoginSecuritySchema();

    const clientPlatform = (req.headers['x-skaler-client'] || '').toString().trim().toLowerCase();
    const isWebClient = isWebClientRequest(req);
    if (isWebClient && !isWebPasswordLoginEnabled()) {
      return res.status(403).json({
        success: false,
        reason: 'web_password_login_disabled',
        message: 'El inicio de sesión web con contraseña está deshabilitado.',
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

    const lockState = await getLockState(identifier);
    if (lockState.locked) {
      await recordLoginEvent({
        identifier,
        outcome: 'locked',
        message: 'Intento bloqueado por exceso de fallos',
        req,
      });
      return res.status(429).json({
        success: false,
        reason: 'login_locked',
        message: `Demasiados intentos fallidos. Espera ${Math.ceil(lockState.retryAfterSeconds / 60)} minuto(s) e inténtalo de nuevo.`,
        retryAfterSeconds: lockState.retryAfterSeconds,
      });
    }

    const users = await withConnection(pool, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT *
         FROM users
         WHERE LOWER(email) = ? OR LOWER(name) = ?
         LIMIT 1`,
        [identifier, identifier]
      );
      return rows;
    });

    if (users.length === 0) {
      const failure = await registerFailedAttempt(identifier);
      await recordLoginEvent({
        identifier,
        outcome: 'failed_unknown_user',
        message: 'Usuario no encontrado',
        req,
      });
      if (failure.locked) {
        return res.status(429).json({
          success: false,
          reason: 'login_locked',
          message: `Demasiados intentos fallidos. Espera ${Math.ceil(failure.retryAfterSeconds / 60)} minuto(s) e inténtalo de nuevo.`,
          retryAfterSeconds: failure.retryAfterSeconds,
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas',
      });
    }

    const user = users[0];
    const passwordValid = await comparePassword(password, user.password);

    if (!passwordValid) {
      const failure = await registerFailedAttempt(identifier);
      await recordLoginEvent({
        userId: user.id,
        identifier,
        outcome: 'failed_password',
        message: 'Contraseña incorrecta',
        req,
      });
      if (failure.locked) {
        return res.status(429).json({
          success: false,
          reason: 'login_locked',
          message: `Demasiados intentos fallidos. Espera ${Math.ceil(failure.retryAfterSeconds / 60)} minuto(s) e inténtalo de nuevo.`,
          retryAfterSeconds: failure.retryAfterSeconds,
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas',
      });
    }

    if (!isUserAccountActive(user.status)) {
      await recordLoginEvent({
        userId: user.id,
        identifier,
        outcome: 'inactive_user',
        message: 'Usuario inactivo',
        req,
      });
      return res.status(403).json({
        success: false,
        message: 'Tu usuario está inactivo. Contacta al administrador.',
        reason: 'user_inactive',
      });
    }

    await clearLockout(identifier);

    await ensureUserTermsSchema();
    const requestedTermsVersion = (req.body.termsVersion || CURRENT_TERMS_VERSION).toString().trim();
    const termsVersion = requestedTermsVersion || CURRENT_TERMS_VERSION;
    const existingAcceptance = await hasUserAcceptedTerms(user.id, termsVersion);
    const acceptTermsRequested =
      req.body.acceptTerms === true ||
      req.body.acceptTerms === 1 ||
      req.body.acceptTerms === 'true' ||
      req.body.acceptTerms === '1';

    if (!existingAcceptance && !acceptTermsRequested) {
      await recordLoginEvent({
        userId: user.id,
        identifier,
        outcome: 'terms_required',
        message: 'Faltó aceptar términos',
        req,
      });
      return res.status(403).json({
        success: false,
        reason: 'terms_required',
        message: 'Debes aceptar los términos y condiciones para continuar.',
        terms: getCurrentTermsPayload(),
      });
    }

    let termsAcceptanceRecorded = existingAcceptance;
    if (!existingAcceptance && acceptTermsRequested) {
      termsAcceptanceRecorded = await recordTermsAcceptance({
        user,
        req,
        termsVersion,
      });
    }

    const webStandalone = isWebClient && clientPlatform === 'web';
    const deviceLabel = webStandalone
      ? 'web-browser-standalone'
      : (req.headers['x-device-label'] || req.headers['x-skaler-device'] || 'mobile-app');
    const appSession = await createAppSession({
      user,
      deviceLabel,
      ttlMs: webStandalone ? webStandaloneSessionTtlMs() : null,
    });
    const token = generateToken(user, {
      sessionId: appSession.jwtSessionId,
      sessionType: 'app',
      expiresIn: webStandalone ? process.env.WEB_STANDALONE_SESSION_EXPIRE || '8h' : undefined,
    });

    await recordLoginEvent({
      userId: user.id,
      identifier,
      outcome: 'success',
      message: webStandalone ? 'Inicio web standalone' : 'Inicio app móvil',
      req,
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
      terms: {
        accepted: true,
        version: termsVersion,
        acceptedAt: termsAcceptanceRecorded?.accepted_at || termsAcceptanceRecorded?.acceptedAt || null,
      },
      bridgeOverview,
    });
  } catch (error) {
    console.error('Error en login:', error && error.stack ? error.stack : error);
    res.status(500).json({
      success: false,
      message: 'Error en login',
      error: error?.message || String(error),
    });
  }
};

const buildAuthUserPayload = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
});

const refreshSessionToken = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado',
      });
    }

    const sessionId = req.user.sid;
    const sessionType = req.user.session_type === 'web' ? 'web' : 'app';
    const sessionState = await getSessionState({ jwtSessionId: sessionId, sessionType });

    if (!sessionState.valid) {
      return res.status(403).json({
        success: false,
        message: 'La sesión vinculada ya no está activa',
        reason: sessionState.reason,
      });
    }

    const userAccount = await getUserById(req.user.id);
    if (!userAccount || !isUserAccountActive(userAccount.status)) {
      return res.status(403).json({
        success: false,
        message: 'Tu usuario está inactivo. Contacta al administrador.',
        reason: 'user_inactive',
      });
    }

    const expiresAt = await extendSessionExpiry({ jwtSessionId: sessionId, sessionType });
    const token = generateToken(userAccount, {
      sessionId,
      sessionType,
      linkedAppSessionId: sessionType === 'web' ? req.user.linked_app_session_id : undefined,
    });

    res.json({
      success: true,
      message: 'Token refrescado',
      token,
      session: {
        type: sessionType,
        sessionId,
        expiresAt,
      },
      user: buildAuthUserPayload(userAccount),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al refrescar token',
    });
  }
};

// Compatibilidad con clientes que aún llaman /refresh-token.
const refreshToken = refreshSessionToken;

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
        reason: state.reason || null,
        sessionType,
        linkedAppSessionActive: sessionType === 'web'
          ? state.linkedAppSessionActive !== false
          : state.valid,
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
        linkedAppSessionActive: sessionType === 'web'
          ? state.linkedAppSessionActive !== false
          : state.valid,
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

const getCurrentTerms = async (_req, res) => {
  try {
    res.json({
      success: true,
      data: getCurrentTermsPayload(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'No fue posible cargar los términos y condiciones',
      error: error?.message || String(error),
    });
  }
};

const listAcceptedTerms = async (req, res) => {
  try {
    const result = await listTermsAcceptances({
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search,
      termsVersion: req.query.termsVersion,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Error listando términos aceptados:', error && error.stack ? error.stack : error);
    res.status(500).json({
      success: false,
      message: 'No fue posible consultar las aceptaciones de términos',
      error: error?.message || String(error),
    });
  }
};

const listLoginEventsHandler = async (req, res) => {
  try {
    const result = await listLoginEvents({
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search,
      outcome: req.query.outcome,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'No fue posible consultar el registro de accesos',
      error: error?.message || String(error),
    });
  }
};

const exportLoginEventsCsv = async (req, res) => {
  try {
    const result = await listLoginEvents({
      page: 1,
      pageSize: 10000,
      search: req.query.search,
      outcome: req.query.outcome,
    });
    const rows = result.items || [];
    const headers = [
      'Fecha',
      'Resultado',
      'Identificador',
      'Usuario ID',
      'Mensaje',
      'Plataforma',
      'IP',
    ];
    const escapeCsv = (value) => {
      const text = value == null ? '' : String(value);
      if (/[",;\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    };
    const lines = [headers.map(escapeCsv).join(';')];
    for (const row of rows) {
      lines.push(
        [
          row.created_at,
          row.outcome,
          row.identifier,
          row.user_id,
          row.message,
          row.client_platform,
          row.ip_address,
        ]
          .map(escapeCsv)
          .join(';')
      );
    }
    const csv = `\uFEFF${lines.join('\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="registro_accesos.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'No fue posible exportar el registro de accesos',
      error: error?.message || String(error),
    });
  }
};

const exportAcceptedTermsCsv = async (req, res) => {
  try {
    const rows = await listAllTermsAcceptancesForExport({
      search: req.query.search,
      termsVersion: req.query.termsVersion,
    });

    const headers = [
      'Fecha aceptación',
      'Versión términos',
      'Usuario ID',
      'Correo',
      'Nombre usuario',
      'Rol',
      'Estado usuario',
      'Cédula',
      'Nombre colaborador',
      'Cargo',
      'Área',
      'Fecha ingreso',
      'Plataforma',
      'Dispositivo',
      'IP',
      'Versión app',
    ];

    const escapeCsv = (value) => {
      const text = value == null ? '' : String(value);
      if (/[",;\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const lines = [headers.map(escapeCsv).join(';')];
    for (const row of rows) {
      lines.push(
        [
          row.accepted_at,
          row.terms_version,
          row.user_id,
          row.user_email,
          row.user_name,
          row.user_role,
          row.user_status,
          row.identification_number,
          row.employee_name,
          row.employee_position,
          row.employee_department,
          row.employee_hire_date,
          row.client_platform,
          row.device_label,
          row.ip_address,
          row.app_version,
        ]
          .map(escapeCsv)
          .join(';')
      );
    }

    const csv = `\uFEFF${lines.join('\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="terminos_aceptados.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    console.error('Error exportando términos aceptados:', error && error.stack ? error.stack : error);
    res.status(500).json({
      success: false,
      message: 'No fue posible exportar las aceptaciones de términos',
      error: error?.message || String(error),
    });
  }
};

module.exports = {
  register,
  login,
  getCurrentTerms,
  listAcceptedTerms,
  exportAcceptedTermsCsv,
  listLoginEventsHandler,
  exportLoginEventsCsv,
  refreshToken,
  refreshSessionToken,
  logout,
  createTemporaryWebLaunch,
  consumeTemporaryWebLaunch,
  heartbeatSession,
  sessionStatus,
  webLaunchTicketStatus,
  previewWebLaunch,
};
