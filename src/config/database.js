const mysql = require('mysql2/promise');
const { withConnection } = require('../utils/withConnection');

const parseBoolean = (value, fallback = false) => {
  if (value == null) return fallback;
  const normalized = value.toString().trim().toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'no', 'off'].includes(normalized);
};

const isInternalRailwayHost = (host = '') =>
  host.toString().includes('.railway.internal') || host === 'mysql.railway.internal';

const resolveHostFromConnectionString = (uri = '') => {
  try {
    const normalized = uri.trim().replace(/^mysql:\/\//, 'http://');
    return new URL(normalized).hostname;
  } catch (_) {
    return '';
  }
};

const hasRailwayMysqlVars = Boolean(
  (process.env.MYSQLHOST || process.env.MYSQLUSER || process.env.MYSQLPASSWORD || '').toString().trim(),
);

const connectionString = hasRailwayMysqlVars
  ? ''
  : (
    process.env.DATABASE_URL ||
    process.env.MYSQL_URL ||
    process.env.MYSQL_PUBLIC_URL ||
    ''
  ).toString().trim();

const host = process.env.MYSQLHOST || process.env.DB_HOST || 'localhost';
const port = Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306);
const user = process.env.MYSQLUSER || process.env.DB_USER || 'root';
const password = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '';
const database = process.env.MYSQLDATABASE || process.env.DB_NAME || 'skaler_db';

const resolvedHost = connectionString.length > 0
  ? resolveHostFromConnectionString(connectionString)
  : host;

const resolveSslConfig = () => {
  if (isInternalRailwayHost(resolvedHost)) {
    return undefined;
  }
  return parseBoolean(
    process.env.DB_SSL || process.env.MYSQL_SSL || process.env.MYSQL_SSL_REQUIRED,
    false,
  )
    ? { rejectUnauthorized: false }
    : undefined;
};

const dbConfig = {
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: Number(process.env.DB_QUEUE_LIMIT || 0),
  acquireTimeout: Number(process.env.DB_ACQUIRE_TIMEOUT_MS || 15000),
  maxIdle: Number(process.env.DB_MAX_IDLE || 10),
  idleTimeout: Number(process.env.DB_IDLE_TIMEOUT_MS || 60000),
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  ssl: resolveSslConfig(),
};
const pool = connectionString.length > 0
  ? mysql.createPool(connectionString)
  : mysql.createPool(dbConfig);

// ✅ función para probar conexión (NO automática)
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Conexión a base de datos establecida');
    connection.release();
  } catch (err) {
    console.error('❌ Error de conexión a base de datos:', err.message);
  }
}

// ✅ función para cerrar DB (IMPORTANTE PARA JEST)
async function closeDatabase() {
  await pool.end();
  console.log('🛑 Pool de MySQL cerrado');
}

async function withDbConnection(callback) {
  return withConnection(pool, callback);
}

module.exports = {
  pool,
  withDbConnection,
  testConnection,
  closeDatabase,
};