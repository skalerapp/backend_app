const mysql = require('mysql2/promise');

const parseBoolean = (value, fallback = true) => {
  if (value == null) return fallback;
  const normalized = value.toString().trim().toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'no', 'off'].includes(normalized);
};

const connectionString =
  process.env.DATABASE_URL ||
  process.env.MYSQL_URL ||
  process.env.MYSQL_PUBLIC_URL ||
  '';

const host = process.env.DB_HOST || process.env.MYSQLHOST || 'localhost';
const port = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
const user = process.env.DB_USER || process.env.MYSQLUSER || 'root';
const password = process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '';
const database = process.env.DB_NAME || process.env.MYSQLDATABASE || 'skaler_db';

const dbConfig = {
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  ssl: parseBoolean(process.env.DB_SSL || process.env.MYSQL_SSL || process.env.MYSQL_SSL_REQUIRED, false)
    ? { rejectUnauthorized: false }
    : undefined,
};

const pool = connectionString.trim().length > 0
  ? mysql.createPool(connectionString.trim())
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

module.exports = {
  pool,
  testConnection,
  closeDatabase,
};