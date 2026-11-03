const { pool } = require('../../config/database');
const { CURRENT_TERMS_VERSION } = require('../../config/appTerms');

const termsSchemaState = { ready: false };

/** mysql2 rejects `undefined` in execute() bindings — normalize to SQL NULL. */
const sqlBind = (value) => (value === undefined ? null : value);

const ensureUserTermsSchema = async () => {
  if (termsSchemaState.ready) return;

  const connection = await pool.getConnection();
  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_terms_acceptances (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        terms_version VARCHAR(32) NOT NULL,
        accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user_email VARCHAR(255) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        user_role VARCHAR(50) NOT NULL,
        user_status VARCHAR(32) NULL,
        identification_number VARCHAR(50) NULL,
        employee_name VARCHAR(255) NULL,
        employee_position VARCHAR(100) NULL,
        employee_department VARCHAR(100) NULL,
        employee_hire_date DATE NULL,
        device_label VARCHAR(120) NULL,
        client_platform VARCHAR(32) NULL,
        ip_address VARCHAR(120) NULL,
        user_agent TEXT NULL,
        app_version VARCHAR(32) NULL,
        acceptance_payload JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_terms_user_version (user_id, terms_version),
        KEY idx_user_terms_accepted_at (accepted_at),
        KEY idx_user_terms_user_id (user_id),
        CONSTRAINT fk_user_terms_user FOREIGN KEY (user_id) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    termsSchemaState.ready = true;
  } finally {
    connection.release();
  }
};

const loadUserTermsProfile = async (userId) => {
  return withConnection(async (connection) => {
    const [rows] = await connection.execute(
      `
        SELECT
          u.id,
          u.email,
          u.name,
          u.role,
          u.status,
          u.created_at AS user_created_at,
          e.identification_number,
          e.employee_name,
          e.position AS employee_position,
          e.department AS employee_department,
          e.hire_date AS employee_hire_date
        FROM users u
        LEFT JOIN employees e ON e.user_id = u.id
        WHERE u.id = ?
        LIMIT 1
      `,
      [userId]
    );
    return rows[0] || null;
  });
};

const withConnection = async (handler) => {
  const connection = await pool.getConnection();
  try {
    return await handler(connection);
  } finally {
    connection.release();
  }
};

const hasUserAcceptedTerms = async (userId, termsVersion = CURRENT_TERMS_VERSION) => {
  await ensureUserTermsSchema();
  return withConnection(async (connection) => {
    const [rows] = await connection.execute(
      `
        SELECT id, accepted_at
        FROM user_terms_acceptances
        WHERE user_id = ? AND terms_version = ?
        LIMIT 1
      `,
      [userId, termsVersion]
    );
    return rows.length > 0 ? rows[0] : null;
  });
};

const buildAcceptanceSnapshot = ({ user, profile, req, termsVersion = CURRENT_TERMS_VERSION }) => {
  const clientPlatform = (req.headers['x-skaler-client'] || 'mobile').toString().trim().toLowerCase();
  const deviceLabel = (req.headers['x-device-label'] || req.headers['x-skaler-device'] || 'mobile-app')
    .toString()
    .trim()
    .slice(0, 120);
  const appVersion = (req.headers['x-skaler-app-version'] || req.body?.appVersion || null)
    ?.toString()
    ?.trim()
    ?.slice(0, 32);
  const ipAddress =
    (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
      .toString()
      .split(',')[0]
      .trim()
      .slice(0, 120) || null;
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 2000) || null;

  const email = profile?.email || user.email;
  const name = profile?.name || user.name;
  const role = profile?.role || user.role;

  return {
    user_email: sqlBind(email),
    user_name: sqlBind(name),
    user_role: sqlBind(role),
    user_status: sqlBind(profile?.status ?? user.status ?? null),
    identification_number: sqlBind(profile?.identification_number ?? null),
    employee_name: sqlBind(profile?.employee_name ?? null),
    employee_position: sqlBind(profile?.employee_position ?? null),
    employee_department: sqlBind(profile?.employee_department ?? null),
    employee_hire_date: sqlBind(profile?.employee_hire_date ?? null),
    device_label: sqlBind(deviceLabel),
    client_platform: sqlBind(clientPlatform),
    ip_address: sqlBind(ipAddress),
    user_agent: sqlBind(userAgent),
    app_version: sqlBind(appVersion),
    acceptance_payload: {
      userCreatedAt: profile?.user_created_at ?? null,
      acceptedFromLogin: true,
      termsVersion: termsVersion || CURRENT_TERMS_VERSION,
    },
  };
};

const recordTermsAcceptance = async ({ user, req, termsVersion = CURRENT_TERMS_VERSION }) => {
  await ensureUserTermsSchema();
  const profile = await loadUserTermsProfile(user.id);
  const snapshot = buildAcceptanceSnapshot({ user, profile, req, termsVersion });

  return withConnection(async (connection) => {
    const [result] = await connection.execute(
      `
        INSERT INTO user_terms_acceptances (
          user_id,
          terms_version,
          accepted_at,
          user_email,
          user_name,
          user_role,
          user_status,
          identification_number,
          employee_name,
          employee_position,
          employee_department,
          employee_hire_date,
          device_label,
          client_platform,
          ip_address,
          user_agent,
          app_version,
          acceptance_payload
        ) VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          accepted_at = VALUES(accepted_at),
          user_email = VALUES(user_email),
          user_name = VALUES(user_name),
          user_role = VALUES(user_role),
          user_status = VALUES(user_status),
          identification_number = VALUES(identification_number),
          employee_name = VALUES(employee_name),
          employee_position = VALUES(employee_position),
          employee_department = VALUES(employee_department),
          employee_hire_date = VALUES(employee_hire_date),
          device_label = VALUES(device_label),
          client_platform = VALUES(client_platform),
          ip_address = VALUES(ip_address),
          user_agent = VALUES(user_agent),
          app_version = VALUES(app_version),
          acceptance_payload = VALUES(acceptance_payload)
      `,
      [
        user.id,
        termsVersion,
        sqlBind(snapshot.user_email),
        sqlBind(snapshot.user_name),
        sqlBind(snapshot.user_role),
        sqlBind(snapshot.user_status),
        sqlBind(snapshot.identification_number),
        sqlBind(snapshot.employee_name),
        sqlBind(snapshot.employee_position),
        sqlBind(snapshot.employee_department),
        sqlBind(snapshot.employee_hire_date),
        sqlBind(snapshot.device_label),
        sqlBind(snapshot.client_platform),
        sqlBind(snapshot.ip_address),
        sqlBind(snapshot.user_agent),
        sqlBind(snapshot.app_version),
        JSON.stringify(snapshot.acceptance_payload),
      ]
    );

    const [rows] = await connection.execute(
      `
        SELECT accepted_at
        FROM user_terms_acceptances
        WHERE user_id = ? AND terms_version = ?
        LIMIT 1
      `,
      [user.id, termsVersion]
    );

    return {
      insertId: result.insertId,
      acceptedAt: rows[0]?.accepted_at || new Date(),
    };
  });
};

const listTermsAcceptances = async ({
  page = 1,
  pageSize = 25,
  search = '',
  termsVersion = '',
} = {}) => {
  await ensureUserTermsSchema();

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 25));
  const offset = (safePage - 1) * safePageSize;
  const normalizedSearch = search.toString().trim();
  const normalizedVersion = termsVersion.toString().trim();

  const whereParts = [];
  const params = [];

  if (normalizedSearch) {
    whereParts.push(
      `(user_email LIKE ? OR user_name LIKE ? OR identification_number LIKE ? OR employee_name LIKE ?)`
    );
    const like = `%${normalizedSearch}%`;
    params.push(like, like, like, like);
  }

  if (normalizedVersion) {
    whereParts.push('terms_version = ?');
    params.push(normalizedVersion);
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  return withConnection(async (connection) => {
    const [countRows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM user_terms_acceptances ${whereClause}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await connection.execute(
      `
        SELECT
          id,
          user_id,
          terms_version,
          accepted_at,
          user_email,
          user_name,
          user_role,
          user_status,
          identification_number,
          employee_name,
          employee_position,
          employee_department,
          employee_hire_date,
          device_label,
          client_platform,
          ip_address,
          app_version,
          created_at
        FROM user_terms_acceptances
        ${whereClause}
        ORDER BY accepted_at DESC, id DESC
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

const listAllTermsAcceptancesForExport = async ({ search = '', termsVersion = '' } = {}) => {
  const result = await listTermsAcceptances({
    page: 1,
    pageSize: 10000,
    search,
    termsVersion,
  });
  return result.items;
};

module.exports = {
  ensureUserTermsSchema,
  hasUserAcceptedTerms,
  recordTermsAcceptance,
  loadUserTermsProfile,
  listTermsAcceptances,
  listAllTermsAcceptancesForExport,
};
