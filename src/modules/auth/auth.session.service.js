const crypto = require('crypto');
const { pool } = require('../../config/database');
const { toSqlDatetime } = require('../../utils/datetime.utils');

const authSessionSchemaState = {
  ready: false,
};

const SESSION_STATUS_ACTIVE = 'active';
const SESSION_STATUS_REVOKED = 'revoked';
const SESSION_STATUS_EXPIRED = 'expired';

const TICKET_STATUS_PENDING = 'pending';
const TICKET_STATUS_CONSUMED = 'consumed';
const TICKET_STATUS_EXPIRED = 'expired';
const TICKET_STATUS_REVOKED = 'revoked';

const DEFAULT_APP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TICKET_TTL_MS = 30 * 60 * 1000;
const DEFAULT_HEARTBEAT_TTL_MS = 90 * 1000;

const addMilliseconds = (date, milliseconds) => new Date(date.getTime() + milliseconds);

const parseDurationToMs = (value, fallbackMs) => {
  if (value == null) return fallbackMs;
  const normalized = value.toString().trim().toLowerCase();
  if (!normalized) return fallbackMs;
  if (/^\d+$/.test(normalized)) {
    return Number(normalized) * 1000;
  }

  const match = normalized.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return fallbackMs;

  const amount = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    default:
      return fallbackMs;
  }
};

const appSessionTtlMs = () => parseDurationToMs(process.env.JWT_EXPIRE, DEFAULT_APP_SESSION_TTL_MS);
const webSessionTtlMs = () => parseDurationToMs(process.env.WEB_SESSION_EXPIRE, DEFAULT_WEB_SESSION_TTL_MS);
const ticketTtlMs = () => parseDurationToMs(process.env.WEB_LAUNCH_TICKET_EXPIRE, DEFAULT_TICKET_TTL_MS);
const heartbeatTtlMs = () => parseDurationToMs(process.env.APP_SESSION_HEARTBEAT_TTL, DEFAULT_HEARTBEAT_TTL_MS);

const createId = (size = 24) => crypto.randomBytes(size).toString('hex');

const normalizeUrl = (value) => (value || '').toString().trim().replace(/\/$/, '');

const getWebAppUrl = () => {
  const configured = normalizeUrl(process.env.WEB_APP_URL);
  if (configured) return configured;

  const frontendUrl = normalizeUrl(process.env.FRONTEND_URL);
  if (frontendUrl) return frontendUrl;

  const dashboardUrl = normalizeUrl(process.env.DASHBOARD_URL);
  if (dashboardUrl) return dashboardUrl;

  // En producción la app web vive en otro host (Firebase, Netlify, etc.).
  // No reutilizar API_URL: el backend no sirve la UI Flutter.
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return '';
  }

  const apiUrl = normalizeUrl(process.env.API_URL);
  if (!apiUrl) return '';

  return apiUrl.replace(/:3000(?=$|\/)/, ':8080').replace(/\/api(?=$|\/)/, '');
};

const buildLaunchUrl = (ticketCode) => {
  const webAppUrl = getWebAppUrl();
  if (!webAppUrl) return null;
  const separator = webAppUrl.includes('?') ? '&' : '?';
  return `${webAppUrl}${separator}bridge_ticket=${encodeURIComponent(ticketCode)}`;
};

const ensureAuthSessionSchema = async () => {
  if (authSessionSchemaState.ready) return;

  const connection = await pool.getConnection();
  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS auth_app_sessions (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        jwt_session_id VARCHAR(96) NOT NULL,
        user_id INT NOT NULL,
        user_role VARCHAR(50) NOT NULL,
        device_label VARCHAR(120) NULL,
        session_status ENUM('active', 'revoked', 'expired') NOT NULL DEFAULT 'active',
        last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NULL,
        revoked_at DATETIME NULL,
        revoked_reason VARCHAR(255) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_auth_app_sessions_jwt_session_id (jwt_session_id),
        KEY idx_auth_app_sessions_user_status (user_id, session_status),
        KEY idx_auth_app_sessions_expires_at (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS auth_web_launch_tickets (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ticket_code VARCHAR(128) NOT NULL,
        app_session_id BIGINT NOT NULL,
        user_id INT NOT NULL,
        ticket_status ENUM('pending', 'consumed', 'expired', 'revoked') NOT NULL DEFAULT 'pending',
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME NULL,
        consumed_by_ip VARCHAR(120) NULL,
        target_url VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_auth_web_launch_tickets_code (ticket_code),
        KEY idx_auth_web_launch_tickets_session (app_session_id, ticket_status),
        KEY idx_auth_web_launch_tickets_expires_at (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS auth_web_sessions (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        jwt_session_id VARCHAR(96) NOT NULL,
        app_session_id BIGINT NOT NULL,
        user_id INT NOT NULL,
        session_status ENUM('active', 'revoked', 'expired') NOT NULL DEFAULT 'active',
        last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NULL,
        revoked_at DATETIME NULL,
        revoked_reason VARCHAR(255) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_auth_web_sessions_jwt_session_id (jwt_session_id),
        KEY idx_auth_web_sessions_app_status (app_session_id, session_status),
        KEY idx_auth_web_sessions_expires_at (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    authSessionSchemaState.ready = true;
  } finally {
    connection.release();
  }
};

const createAppSession = async ({ user, deviceLabel = 'mobile-app' }) => {
  await ensureAuthSessionSchema();

  const jwtSessionId = createId(24);
  const expiresAt = addMilliseconds(new Date(), appSessionTtlMs());
  const expiresAtSql = toSqlDatetime(expiresAt);

  const connection = await pool.getConnection();
  try {
    const [result] = await connection.execute(
      `
        INSERT INTO auth_app_sessions (
          jwt_session_id,
          user_id,
          user_role,
          device_label,
          session_status,
          last_seen_at,
          expires_at
        )
        VALUES (?, ?, ?, ?, ?, NOW(), ?)
      `,
      [jwtSessionId, user.id, user.role || 'employee', deviceLabel, SESSION_STATUS_ACTIVE, expiresAtSql],
    );

    return {
      appSessionId: result.insertId,
      jwtSessionId,
      expiresAt,
    };
  } finally {
    connection.release();
  }
};

const getUserById = async (userId) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, email, name, role FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    return rows[0] || null;
  } finally {
    connection.release();
  }
};

const createWebLaunchTicket = async ({ appSessionId, userId }) => {
  await ensureAuthSessionSchema();

  const ticketCode = createId(24);
  const expiresAt = addMilliseconds(new Date(), ticketTtlMs());
  const expiresAtSql = toSqlDatetime(expiresAt);
  const launchUrl = buildLaunchUrl(ticketCode);

  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `
        UPDATE auth_web_launch_tickets
        SET ticket_status = ?, updated_at = NOW()
        WHERE app_session_id = ? AND ticket_status = ?
      `,
      [TICKET_STATUS_REVOKED, appSessionId, TICKET_STATUS_PENDING],
    );

    await connection.execute(
      `
        INSERT INTO auth_web_launch_tickets (
          ticket_code,
          app_session_id,
          user_id,
          ticket_status,
          expires_at,
          target_url
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [ticketCode, appSessionId, userId, TICKET_STATUS_PENDING, expiresAtSql, launchUrl],
    );

    return {
      ticketCode,
      expiresAt,
      launchUrl,
    };
  } finally {
    connection.release();
  }
};

const getAppSessionBridgeOverview = async ({ appSessionId }) => {
  await ensureAuthSessionSchema();

  if (!appSessionId) {
    return {
      pendingTickets: 0,
      activeWebSessions: 0,
      hasPendingTicket: false,
      hasActiveWebSession: false,
      latestTicketExpiresAt: null,
      latestWebSessionExpiresAt: null,
    };
  }

  const connection = await pool.getConnection();
  try {
    const [ticketRows] = await connection.execute(
      `
        SELECT COUNT(*) AS pending_tickets, MAX(expires_at) AS latest_ticket_expires_at
        FROM auth_web_launch_tickets
        WHERE app_session_id = ? AND ticket_status = ? AND expires_at > NOW()
      `,
      [appSessionId, TICKET_STATUS_PENDING],
    );

    const [webRows] = await connection.execute(
      `
        SELECT COUNT(*) AS active_web_sessions, MAX(expires_at) AS latest_web_session_expires_at
        FROM auth_web_sessions
        WHERE app_session_id = ? AND session_status = ? AND (expires_at IS NULL OR expires_at > NOW())
      `,
      [appSessionId, SESSION_STATUS_ACTIVE],
    );

    const pendingTickets = Number(ticketRows[0]?.pending_tickets || 0);
    const activeWebSessions = Number(webRows[0]?.active_web_sessions || 0);

    return {
      pendingTickets,
      activeWebSessions,
      hasPendingTicket: pendingTickets > 0,
      hasActiveWebSession: activeWebSessions > 0,
      latestTicketExpiresAt: ticketRows[0]?.latest_ticket_expires_at || null,
      latestWebSessionExpiresAt: webRows[0]?.latest_web_session_expires_at || null,
    };
  } finally {
    connection.release();
  }
};

const getWebLaunchTicketState = async ({ ticketCode }) => {
  await ensureAuthSessionSchema();

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      `
        SELECT
          ticket.id,
          ticket.ticket_status,
          ticket.expires_at,
          ticket.consumed_at,
          app.session_status AS app_session_status,
          app.last_seen_at AS app_last_seen_at,
          app.expires_at AS app_expires_at
        FROM auth_web_launch_tickets ticket
        INNER JOIN auth_app_sessions app ON app.id = ticket.app_session_id
        WHERE ticket.ticket_code = ?
        LIMIT 1
      `,
      [ticketCode],
    );

    if (rows.length === 0) {
      return { valid: false, reason: 'not_found', ticketStatus: null };
    }

    const ticket = rows[0];
    const now = Date.now();
    const ticketStatus = ticket.ticket_status;

    if (ticketStatus === TICKET_STATUS_REVOKED) {
      return { valid: false, reason: 'ticket_revoked', ticketStatus };
    }

    if (ticketStatus === TICKET_STATUS_CONSUMED) {
      return { valid: false, reason: 'ticket_consumed', ticketStatus };
    }

    if (ticketStatus === TICKET_STATUS_EXPIRED) {
      return { valid: false, reason: 'ticket_expired', ticketStatus };
    }

    if (ticketStatus !== TICKET_STATUS_PENDING) {
      return { valid: false, reason: 'ticket_used_or_revoked', ticketStatus };
    }

    if (ticket.expires_at && new Date(ticket.expires_at).getTime() <= now) {
      return { valid: false, reason: 'ticket_expired', ticketStatus };
    }

    if (ticket.app_session_status !== SESSION_STATUS_ACTIVE) {
      return { valid: false, reason: 'app_session_revoked', ticketStatus };
    }

    if (ticket.app_expires_at && new Date(ticket.app_expires_at).getTime() <= now) {
      return { valid: false, reason: 'app_session_expired', ticketStatus };
    }

    const appLastSeenAt = ticket.app_last_seen_at ? new Date(ticket.app_last_seen_at).getTime() : 0;
    if (appLastSeenAt + heartbeatTtlMs() <= now) {
      return { valid: false, reason: 'app_session_inactive', ticketStatus };
    }

    return { valid: true, reason: null, ticketStatus, expiresAt: ticket.expires_at || null };
  } finally {
    connection.release();
  }
};

const consumeWebLaunchTicket = async ({ ticketCode, consumedByIp }) => {
  await ensureAuthSessionSchema();

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [ticketRows] = await connection.execute(
      `
        SELECT ticket.id, ticket.app_session_id, ticket.user_id, ticket.ticket_status, ticket.expires_at,
               app.jwt_session_id AS app_jwt_session_id,
               app.session_status AS app_session_status,
               app.last_seen_at AS app_last_seen_at,
               app.expires_at AS app_expires_at
        FROM auth_web_launch_tickets ticket
        INNER JOIN auth_app_sessions app ON app.id = ticket.app_session_id
        WHERE ticket.ticket_code = ?
        LIMIT 1
      `,
      [ticketCode],
    );

    if (ticketRows.length === 0) {
      await connection.rollback();
      throw new Error('El enlace temporal no existe o ya no está disponible');
    }

    const ticket = ticketRows[0];
    const now = new Date();
    const ticketExpiry = ticket.expires_at ? new Date(ticket.expires_at) : null;
    const appExpiry = ticket.app_expires_at ? new Date(ticket.app_expires_at) : null;
    const appLastSeenAt = ticket.app_last_seen_at ? new Date(ticket.app_last_seen_at).getTime() : 0;

    if (ticket.ticket_status === TICKET_STATUS_REVOKED) {
      await connection.rollback();
      throw new Error('El enlace temporal fue revocado y ya no está disponible');
    }

    if (ticket.ticket_status === TICKET_STATUS_CONSUMED) {
      await connection.rollback();
      throw new Error('El enlace temporal ya fue usado');
    }

    if (ticket.ticket_status && ticket.ticket_status !== TICKET_STATUS_PENDING) {
      await connection.rollback();
      throw new Error('El enlace temporal ya fue usado o invalidado');
    }

    if (ticketExpiry && ticketExpiry.getTime() <= now.getTime()) {
      await connection.execute(
        'UPDATE auth_web_launch_tickets SET ticket_status = ?, updated_at = NOW() WHERE id = ?',
        [TICKET_STATUS_EXPIRED, ticket.id],
      );
      await connection.commit();
      throw new Error('El enlace temporal ya expiró');
    }

    if (ticket.app_session_status !== SESSION_STATUS_ACTIVE) {
      await connection.rollback();
      throw new Error('La sesión móvil asociada ya no está activa');
    }

    if (appExpiry && appExpiry.getTime() <= now.getTime()) {
      await connection.execute(
        'UPDATE auth_app_sessions SET session_status = ?, updated_at = NOW() WHERE id = ?',
        [SESSION_STATUS_EXPIRED, ticket.app_session_id],
      );
      await connection.commit();
      throw new Error('La sesión móvil asociada ya expiró');
    }

    if (appLastSeenAt + heartbeatTtlMs() <= now.getTime()) {
      await connection.rollback();
      throw new Error('La sesión móvil asociada ya no está activa');
    }

    await connection.execute(
      `
        UPDATE auth_web_sessions
        SET session_status = ?, revoked_at = NOW(), revoked_reason = ?, updated_at = NOW()
        WHERE app_session_id = ? AND session_status = ?
      `,
      [
        SESSION_STATUS_REVOKED,
        'Nueva sesión web iniciada con enlace temporal',
        ticket.app_session_id,
        SESSION_STATUS_ACTIVE,
      ],
    );

    const jwtSessionId = createId(24);
    const expiresAt = appExpiry && appExpiry.getTime() > now.getTime()
      ? appExpiry
      : addMilliseconds(now, webSessionTtlMs());
    const expiresAtSql = toSqlDatetime(expiresAt);

    await connection.execute(
      `
        INSERT INTO auth_web_sessions (
          jwt_session_id,
          app_session_id,
          user_id,
          session_status,
          last_seen_at,
          expires_at
        )
        VALUES (?, ?, ?, ?, NOW(), ?)
      `,
      [jwtSessionId, ticket.app_session_id, ticket.user_id, SESSION_STATUS_ACTIVE, expiresAtSql],
    );

    await connection.execute(
      `
        UPDATE auth_web_launch_tickets
        SET ticket_status = ?, consumed_at = NOW(), consumed_by_ip = ?, updated_at = NOW()
        WHERE id = ?
      `,
      [TICKET_STATUS_CONSUMED, consumedByIp || null, ticket.id],
    );

    await connection.commit();

    const user = await getUserById(ticket.user_id);
    if (!user) {
      throw new Error('No fue posible recuperar el usuario de la sesión web');
    }

    return {
      jwtSessionId,
      expiresAt,
      appSessionId: ticket.app_session_id,
      user,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
};

const revokeLinkedWebSessions = async ({ appSessionId, reason }) => {
  await ensureAuthSessionSchema();
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `
        UPDATE auth_web_sessions
        SET session_status = ?, revoked_at = NOW(), revoked_reason = ?, updated_at = NOW()
        WHERE app_session_id = ? AND session_status = ?
      `,
      [SESSION_STATUS_REVOKED, reason || 'La sesión móvil fue cerrada', appSessionId, SESSION_STATUS_ACTIVE],
    );
    await connection.execute(
      `
        UPDATE auth_web_launch_tickets
        SET ticket_status = ?, updated_at = NOW()
        WHERE app_session_id = ? AND ticket_status IN (?, ?)
      `,
      [TICKET_STATUS_REVOKED, appSessionId, TICKET_STATUS_PENDING, TICKET_STATUS_CONSUMED],
    );
  } finally {
    connection.release();
  }
};

const revokeAppSessionByJwtSessionId = async ({ jwtSessionId, reason }) => {
  await ensureAuthSessionSchema();
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id FROM auth_app_sessions WHERE jwt_session_id = ? LIMIT 1',
      [jwtSessionId],
    );
    if (rows.length === 0) return false;

    const appSessionId = rows[0].id;
    await connection.execute(
      `
        UPDATE auth_app_sessions
        SET session_status = ?, revoked_at = NOW(), revoked_reason = ?, updated_at = NOW()
        WHERE id = ?
      `,
      [SESSION_STATUS_REVOKED, reason || 'Sesión cerrada desde la app', appSessionId],
    );
    await connection.execute(
      `
        UPDATE auth_web_sessions
        SET session_status = ?, revoked_at = NOW(), revoked_reason = ?, updated_at = NOW()
        WHERE app_session_id = ? AND session_status = ?
      `,
      [SESSION_STATUS_REVOKED, reason || 'La sesión móvil fue cerrada', appSessionId, SESSION_STATUS_ACTIVE],
    );
    await connection.execute(
      `
        UPDATE auth_web_launch_tickets
        SET ticket_status = ?, updated_at = NOW()
        WHERE app_session_id = ? AND ticket_status IN (?, ?)
      `,
      [TICKET_STATUS_REVOKED, appSessionId, TICKET_STATUS_PENDING, TICKET_STATUS_CONSUMED],
    );
    return true;
  } finally {
    connection.release();
  }
};

const revokeWebSessionByJwtSessionId = async ({ jwtSessionId, reason }) => {
  await ensureAuthSessionSchema();
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `
        UPDATE auth_web_sessions
        SET session_status = ?, revoked_at = NOW(), revoked_reason = ?, updated_at = NOW()
        WHERE jwt_session_id = ?
      `,
      [SESSION_STATUS_REVOKED, reason || 'Sesión web cerrada', jwtSessionId],
    );
    return true;
  } finally {
    connection.release();
  }
};

const touchSession = async ({ jwtSessionId, sessionType }) => {
  await ensureAuthSessionSchema();
  const tableName = sessionType === 'web' ? 'auth_web_sessions' : 'auth_app_sessions';
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `UPDATE ${tableName} SET last_seen_at = NOW(), updated_at = NOW() WHERE jwt_session_id = ?`,
      [jwtSessionId],
    );
  } finally {
    connection.release();
  }
};

const getSessionState = async ({ jwtSessionId, sessionType, touch = false }) => {
  await ensureAuthSessionSchema();
  const connection = await pool.getConnection();
  try {
    let result;

    if (sessionType === 'web') {
      const [rows] = await connection.execute(
        `
          SELECT
            web.id,
            web.app_session_id,
            web.session_status AS web_status,
            web.last_seen_at AS web_last_seen_at,
            web.expires_at AS web_expires_at,
            app.session_status AS app_status,
            app.last_seen_at AS app_last_seen_at,
            app.expires_at AS app_expires_at
          FROM auth_web_sessions web
          INNER JOIN auth_app_sessions app ON app.id = web.app_session_id
          WHERE web.jwt_session_id = ?
          LIMIT 1
        `,
        [jwtSessionId],
      );

      if (rows.length === 0) {
        return { valid: false, reason: 'session_not_found' };
      }

      const item = rows[0];
      const now = Date.now();
      const webExpiresAt = item.web_expires_at ? new Date(item.web_expires_at).getTime() : null;
      const appExpiresAt = item.app_expires_at ? new Date(item.app_expires_at).getTime() : null;
      const appLastSeenAt = item.app_last_seen_at ? new Date(item.app_last_seen_at).getTime() : 0;

      if (item.web_status !== SESSION_STATUS_ACTIVE) {
        return { valid: false, reason: 'web_session_revoked' };
      }
      if (item.app_status !== SESSION_STATUS_ACTIVE) {
        return { valid: false, reason: 'app_session_revoked' };
      }
      if (webExpiresAt != null && webExpiresAt <= now) {
        return { valid: false, reason: 'web_session_expired' };
      }
      if (appExpiresAt != null && appExpiresAt <= now) {
        return { valid: false, reason: 'app_session_expired' };
      }
      if (appLastSeenAt + heartbeatTtlMs() <= now) {
        return { valid: false, reason: 'app_session_inactive' };
      }

      result = {
        valid: true,
        sessionType: 'web',
        appSessionId: item.app_session_id,
      };
    } else {
      const [rows] = await connection.execute(
        `
          SELECT id, session_status, last_seen_at, expires_at
          FROM auth_app_sessions
          WHERE jwt_session_id = ?
          LIMIT 1
        `,
        [jwtSessionId],
      );

      if (rows.length === 0) {
        return { valid: false, reason: 'session_not_found' };
      }

      const item = rows[0];
      const now = Date.now();
      const expiresAt = item.expires_at ? new Date(item.expires_at).getTime() : null;
      if (item.session_status !== SESSION_STATUS_ACTIVE) {
        return { valid: false, reason: 'session_revoked' };
      }
      if (expiresAt != null && expiresAt <= now) {
        return { valid: false, reason: 'session_expired' };
      }

      result = {
        valid: true,
        sessionType: 'app',
        appSessionId: item.id,
      };
    }

    if (touch && result.valid) {
      const tableName = sessionType === 'web' ? 'auth_web_sessions' : 'auth_app_sessions';
      await connection.execute(
        `UPDATE ${tableName} SET last_seen_at = NOW(), updated_at = NOW() WHERE jwt_session_id = ?`,
        [jwtSessionId],
      );
    }

    return result;
  } finally {
    connection.release();
  }
};

module.exports = {
  SESSION_STATUS_ACTIVE,
  SESSION_STATUS_REVOKED,
  SESSION_STATUS_EXPIRED,
  TICKET_STATUS_PENDING,
  TICKET_STATUS_CONSUMED,
  TICKET_STATUS_EXPIRED,
  TICKET_STATUS_REVOKED,
  ensureAuthSessionSchema,
  createAppSession,
  createWebLaunchTicket,
  consumeWebLaunchTicket,
  revokeAppSessionByJwtSessionId,
  revokeWebSessionByJwtSessionId,
  revokeLinkedWebSessions,
  touchSession,
  getSessionState,
  getAppSessionBridgeOverview,
  getWebLaunchTicketState,
  buildLaunchUrl,
  getWebAppUrl,
};