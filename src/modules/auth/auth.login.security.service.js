const { pool } = require('../../config/database');

const schemaState = { ready: false };

const maxFailedAttempts = () => {
  const parsed = Number.parseInt(process.env.AUTH_LOGIN_MAX_FAILED_ATTEMPTS || '5', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
};

const lockMinutes = () => {
  const parsed = Number.parseInt(process.env.AUTH_LOGIN_LOCK_MINUTES || '15', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
};

const normalizeIdentifier = (value) => (value || '').toString().trim().toLowerCase();

const extractClientMeta = (req) => {
  const clientPlatform = (req.headers['x-skaler-client'] || '').toString().trim().toLowerCase() || 'unknown';
  const ipAddress =
    (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
      .toString()
      .split(',')[0]
      .trim()
      .slice(0, 120) || null;
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 2000) || null;
  return { clientPlatform, ipAddress, userAgent };
};

const ensureLoginSecuritySchema = async () => {
  if (schemaState.ready) return;

  const connection = await pool.getConnection();
  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS auth_login_lockouts (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        lock_key VARCHAR(255) NOT NULL,
        failed_attempts INT NOT NULL DEFAULT 0,
        locked_until DATETIME NULL,
        last_attempt_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_auth_login_lockouts_key (lock_key),
        KEY idx_auth_login_lockouts_locked_until (locked_until)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS auth_login_events (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        identifier VARCHAR(255) NOT NULL,
        outcome VARCHAR(40) NOT NULL,
        message VARCHAR(255) NULL,
        client_platform VARCHAR(32) NULL,
        ip_address VARCHAR(120) NULL,
        user_agent TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_auth_login_events_created_at (created_at),
        KEY idx_auth_login_events_user_id (user_id),
        KEY idx_auth_login_events_outcome (outcome),
        KEY idx_auth_login_events_identifier (identifier)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    schemaState.ready = true;
  } finally {
    connection.release();
  }
};

const withConnection = async (handler) => {
  const connection = await pool.getConnection();
  try {
    return await handler(connection);
  } finally {
    connection.release();
  }
};

const recordLoginEvent = async ({
  userId = null,
  identifier,
  outcome,
  message = null,
  req,
}) => {
  await ensureLoginSecuritySchema();
  const meta = extractClientMeta(req);
  await withConnection(async (connection) => {
    await connection.execute(
      `
        INSERT INTO auth_login_events (
          user_id,
          identifier,
          outcome,
          message,
          client_platform,
          ip_address,
          user_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        userId,
        normalizeIdentifier(identifier),
        outcome,
        message,
        meta.clientPlatform,
        meta.ipAddress,
        meta.userAgent,
      ]
    );
  });
};

const getLockState = async (identifier) => {
  await ensureLoginSecuritySchema();
  const lockKey = normalizeIdentifier(identifier);
  if (!lockKey) {
    return { locked: false, retryAfterSeconds: 0, failedAttempts: 0 };
  }

  return withConnection(async (connection) => {
    const [rows] = await connection.execute(
      `
        SELECT failed_attempts, locked_until
        FROM auth_login_lockouts
        WHERE lock_key = ?
        LIMIT 1
      `,
      [lockKey]
    );

    if (rows.length === 0) {
      return { locked: false, retryAfterSeconds: 0, failedAttempts: 0 };
    }

    const row = rows[0];
    const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
    const now = Date.now();
    if (lockedUntil && lockedUntil.getTime() > now) {
      return {
        locked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now) / 1000)),
        failedAttempts: Number(row.failed_attempts || 0),
        lockedUntil,
      };
    }

    return {
      locked: false,
      retryAfterSeconds: 0,
      failedAttempts: Number(row.failed_attempts || 0),
    };
  });
};

const registerFailedAttempt = async (identifier) => {
  await ensureLoginSecuritySchema();
  const lockKey = normalizeIdentifier(identifier);
  if (!lockKey) return { locked: false, retryAfterSeconds: 0 };

  const maxAttempts = maxFailedAttempts();
  const lockMs = lockMinutes() * 60 * 1000;

  return withConnection(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT id, failed_attempts, locked_until FROM auth_login_lockouts WHERE lock_key = ? LIMIT 1`,
      [lockKey]
    );

    const now = new Date();
    let failedAttempts = 1;
    let lockedUntil = null;

    if (rows.length === 0) {
      if (failedAttempts >= maxAttempts) {
        lockedUntil = new Date(now.getTime() + lockMs);
      }
      await connection.execute(
        `
          INSERT INTO auth_login_lockouts (lock_key, failed_attempts, locked_until, last_attempt_at)
          VALUES (?, ?, ?, NOW())
        `,
        [lockKey, failedAttempts, lockedUntil],
      );
    } else {
      const row = rows[0];
      failedAttempts = Number(row.failed_attempts || 0) + 1;
      if (failedAttempts >= maxAttempts) {
        lockedUntil = new Date(now.getTime() + lockMs);
      }
      await connection.execute(
        `
          UPDATE auth_login_lockouts
          SET failed_attempts = ?, locked_until = ?, last_attempt_at = NOW(), updated_at = NOW()
          WHERE lock_key = ?
        `,
        [failedAttempts, lockedUntil, lockKey],
      );
    }

    if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
      return {
        locked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)),
        failedAttempts,
      };
    }

    return { locked: false, retryAfterSeconds: 0, failedAttempts };
  });
};

const clearLockout = async (identifier) => {
  await ensureLoginSecuritySchema();
  const lockKey = normalizeIdentifier(identifier);
  if (!lockKey) return;

  await withConnection(async (connection) => {
    await connection.execute('DELETE FROM auth_login_lockouts WHERE lock_key = ?', [lockKey]);
  });
};

const listLoginEvents = async ({ page = 1, pageSize = 25, search = '', outcome = '' } = {}) => {
  await ensureLoginSecuritySchema();

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 25));
  const offset = (safePage - 1) * safePageSize;
  const normalizedSearch = search.toString().trim();
  const normalizedOutcome = outcome.toString().trim();

  const whereParts = [];
  const params = [];

  if (normalizedSearch) {
    whereParts.push('(identifier LIKE ? OR message LIKE ? OR ip_address LIKE ?)');
    const like = `%${normalizedSearch}%`;
    params.push(like, like, like);
  }
  if (normalizedOutcome) {
    whereParts.push('outcome = ?');
    params.push(normalizedOutcome);
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  return withConnection(async (connection) => {
    const [countRows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM auth_login_events ${whereClause}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await connection.execute(
      `
        SELECT
          id,
          user_id,
          identifier,
          outcome,
          message,
          client_platform,
          ip_address,
          user_agent,
          created_at
        FROM auth_login_events
        ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${safePageSize} OFFSET ${offset}
      `,
      params
    );

    return {
      items: rows,
      total,
      page: safePage,
      pageSize: safePageSize,
    };
  });
};

const isWebPasswordLoginEnabled = () =>
  (process.env.APP_WEB_PASSWORD_LOGIN_ENABLED || 'true').toString().trim().toLowerCase() !== 'false';

const isWebClientRequest = (req) => {
  const clientPlatform = (req.headers['x-skaler-client'] || '').toString().trim().toLowerCase();
  if (clientPlatform === 'web') return true;
  const origin = (req.headers.origin || req.headers.referer || '').toString().toLowerCase();
  if (!origin) return false;
  if (origin.includes(':8080') && process.env.NODE_ENV !== 'production') return true;
  const webAppUrl = (process.env.WEB_APP_URL || process.env.FRONTEND_URL || '').toString().toLowerCase();
  if (webAppUrl && origin.startsWith(webAppUrl.replace(/\/$/, ''))) return true;
  return origin.includes('skalerapp-web.web.app') || origin.includes('web.app');
};

module.exports = {
  ensureLoginSecuritySchema,
  recordLoginEvent,
  getLockState,
  registerFailedAttempt,
  clearLockout,
  listLoginEvents,
  isWebPasswordLoginEnabled,
  isWebClientRequest,
  maxFailedAttempts,
  lockMinutes,
};
