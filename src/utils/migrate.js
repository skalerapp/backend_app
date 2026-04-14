const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const run = async () => {
  try {
    const sqlPath = path.join(__dirname, '../../..', 'database', 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Separar statements por punto y coma; filtrar líneas vacías
    const statements = sql
      .split(/;\s*\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      try {
        await pool.query(stmt);
      } catch (err) {
        // Mostrar el error pero continuar con el resto
        console.error('Error ejecutando statement:', err.message);
      }
    }

    console.log('✅ Migración completada (schema.sql)');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migración:', err.message);
    process.exit(1);
  }
};

run();
