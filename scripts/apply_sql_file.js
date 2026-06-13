const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/database');

async function run(filePath) {
  const full = path.resolve(filePath);
  const sql = fs.readFileSync(full, 'utf8');
  const statements = sql.split(/;/).map(s => s.trim()).filter(Boolean);
  const conn = await pool.getConnection();
  try {
    for (const st of statements) {
      try {
        await conn.query(st);
        console.log('OK:', st.split('\n')[0]);
      } catch (e) {
        console.warn('Error ejecutando statement:', e.message);
      }
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node apply_sql_file.js <sql-file>'); process.exit(1); }
  run(file).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
}
