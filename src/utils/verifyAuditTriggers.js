require('dotenv').config();
const mysql = require('mysql2/promise');

async function verifyAuditTriggers() {
  let connection;

  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'skaler_db',
    });

    const [triggerRows] = await connection.query(`
      SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
      FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND TRIGGER_NAME LIKE 'trg\\_%\\_audit\\_%'
      ORDER BY EVENT_OBJECT_TABLE, EVENT_MANIPULATION
    `);

    const [columnRows] = await connection.query('SHOW COLUMNS FROM audit_logs');

    console.log(`TRIGGER_COUNT=${triggerRows.length}`);
    triggerRows.forEach((row) => {
      console.log(`${row.EVENT_OBJECT_TABLE} | ${row.EVENT_MANIPULATION} | ${row.ACTION_TIMING} | ${row.TRIGGER_NAME}`);
    });
    console.log(`AUDIT_LOG_COLUMNS=${columnRows.map((row) => row.Field).join(',')}`);
  } catch (error) {
    console.error('❌ Error verificando triggers de auditoría:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

verifyAuditTriggers();