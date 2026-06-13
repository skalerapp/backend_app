require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { closeDatabase } = require('../config/database');
const { hashPassword } = require('./auth.utils');
const { ensureCurrentSchema } = require('./syncCurrentSchema');

const dbName = process.env.DB_NAME || 'skaler_db';

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
};

const schemaPath = path.join(__dirname, '../../..', 'database', 'schema.sql');
const adminOnly = process.argv.includes('--admin-only');

const parseStatements = (sql) => {
  const sanitizedSql = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return sanitizedSql
    .split(/;\s*\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const ensureBaseUsers = async (connection) => {
  const adminPassword = await hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || 'admin123');

  await connection.execute(
    `INSERT INTO users (email, password, name, role, status, created_at)
     VALUES (?, ?, ?, ?, 'active', NOW())
     ON DUPLICATE KEY UPDATE
       password = VALUES(password),
       name = VALUES(name),
       role = VALUES(role),
       status = 'active',
       updated_at = NOW()`,
    ['admin@skaler.com', adminPassword, 'Admin', 'super_admin'],
  );

  if (!adminOnly) {
    const commercialPassword = await hashPassword(process.env.COMMERCIAL_USER_PASSWORD || 'commercial123');
    await connection.execute(
      `INSERT INTO users (email, password, name, role, status, created_at)
       VALUES (?, ?, ?, ?, 'active', NOW())
       ON DUPLICATE KEY UPDATE
         password = VALUES(password),
         name = VALUES(name),
         role = VALUES(role),
         status = 'active',
         updated_at = NOW()`,
      [
        process.env.COMMERCIAL_USER_EMAIL || 'commercial@skaler.com',
        commercialPassword,
        process.env.COMMERCIAL_USER_NAME || 'Asesor Comercial',
        'commercial',
      ],
    );
  }
};

const resetCounters = async (connection) => {
  const [tables] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'counters'`
  );

  if (Number(tables[0]?.total || 0) === 0) {
    return;
  }

  await connection.query('DELETE FROM counters');
  await connection.query("INSERT INTO counters (name, value) VALUES ('quotation', 0)");
};

const run = async () => {
  let serverConnection;
  let dbConnection;

  try {
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`No se encontró schema.sql en ${schemaPath}`);
    }

    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const statements = parseStatements(schemaSql);

    serverConnection = await mysql.createConnection(connectionConfig);
    await serverConnection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await serverConnection.query(`CREATE DATABASE \`${dbName}\``);
    await serverConnection.end();
    serverConnection = null;

    dbConnection = await mysql.createConnection({
      ...connectionConfig,
      database: dbName,
    });

    for (const statement of statements) {
      try {
        await dbConnection.query(statement);
      } catch (error) {
        console.error(`Aviso ejecutando statement: ${error.message}`);
      }
    }

    try {
      await dbConnection.query("ALTER TABLE users MODIFY COLUMN role VARCHAR(50) NOT NULL DEFAULT 'employee'");
    } catch (_) {
    }

    await ensureCurrentSchema({ connection: dbConnection });
    await resetCounters(dbConnection);
    await ensureBaseUsers(dbConnection);

    const [tableRows] = await dbConnection.query(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
       ORDER BY table_name ASC`
    );

    console.log(`✅ Base de datos reconstruida: ${dbName}`);
    console.log(`✅ Tablas disponibles tras sincronización: ${tableRows.length}`);
    console.log('✅ Usuario admin listo: admin@skaler.com / admin123');
    console.log('✅ Consecutivos reiniciados (counters.quotation = 0)');
    if (!adminOnly) {
      console.log(`✅ Usuario comercial listo: ${process.env.COMMERCIAL_USER_EMAIL || 'commercial@skaler.com'} / ${process.env.COMMERCIAL_USER_PASSWORD || 'commercial123'}`);
    } else {
      console.log('ℹ️ Modo admin-only: solo quedó admin@skaler.com');
    }
  } catch (error) {
    console.error(`❌ Error reconstruyendo la base: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (serverConnection) {
      await serverConnection.end();
    }
    if (dbConnection) {
      await dbConnection.end();
    }
    await closeDatabase();
  }
};

run();