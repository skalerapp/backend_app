const { pool } = require('../config/database');

const dropAttendanceStatusColumn = async () => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'attendance'
         AND COLUMN_NAME = 'status'`
    );

    const hasStatusColumn = Array.isArray(rows) && rows[0] && Number(rows[0].total) > 0;

    if (!hasStatusColumn) {
      console.log('ℹ️ La columna attendance.status no existe. No hay cambios.');
      return;
    }

    await connection.execute('ALTER TABLE attendance DROP COLUMN status');
    console.log('✅ Columna attendance.status eliminada correctamente.');
  } catch (error) {
    console.error('❌ Error eliminando attendance.status:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
};

dropAttendanceStatusColumn();
