require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'skaler_db',
  });

  try {
    const [tables] = await connection.query(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
       ORDER BY table_name ASC`
    );

    const result = [];
    for (const { tableName } of tables) {
      const [rows] = await connection.query(`SELECT COUNT(*) AS rowCount FROM \`${tableName}\``);
      result.push({ tableName, rowCount: Number(rows[0]?.rowCount || 0) });
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
