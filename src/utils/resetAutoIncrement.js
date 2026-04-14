require('dotenv').config();
const { pool } = require('../config/database');

const shouldApply = process.argv.includes('--apply');

async function fetchAutoIncrementTables(connection) {
  const [rows] = await connection.execute(
    `SELECT t.table_name AS tableName
     FROM information_schema.tables t
     INNER JOIN information_schema.columns c
       ON c.table_schema = t.table_schema
      AND c.table_name = t.table_name
     WHERE t.table_schema = DATABASE()
       AND t.table_type = 'BASE TABLE'
       AND c.column_name = 'id'
       AND c.extra LIKE '%auto_increment%'
     ORDER BY t.table_name ASC`
  );

  const tables = [];
  for (const row of rows) {
    const tableName = row.tableName;
    const [maxRows] = await connection.query(
      `SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS rowCount FROM \`${tableName}\``
    );
    const maxId = Number(maxRows[0]?.maxId || 0);
    const rowCount = Number(maxRows[0]?.rowCount || 0);
    tables.push({
      tableName,
      rowCount,
      maxId,
      nextId: Math.max(maxId + 1, 1),
    });
  }

  return tables;
}

async function applyReset(connection, tables) {
  const summary = [];

  for (const table of tables) {
    await connection.query(`ALTER TABLE \`${table.tableName}\` AUTO_INCREMENT = ${table.nextId}`);
    summary.push({
      table: table.tableName,
      rows: table.rowCount,
      nextId: table.nextId,
    });
  }

  return summary;
}

async function main() {
  const connection = await pool.getConnection();
  try {
    const tables = await fetchAutoIncrementTables(connection);

    console.log('=== Reset de AUTO_INCREMENT (preview) ===');
    console.log(JSON.stringify(tables, null, 2));

    if (!shouldApply) {
      console.log('\nModo simulación. Para aplicar cambios: npm run reset:auto-increment -- --apply');
      return;
    }

    const result = await applyReset(connection, tables);
    console.log('\n✅ AUTO_INCREMENT actualizado por tabla:');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ Error reseteando AUTO_INCREMENT:', error.message);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

main();
