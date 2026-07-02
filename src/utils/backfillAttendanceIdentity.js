require('dotenv').config();

const { withDbConnection, closeDatabase } = require('../config/database');
const {
  ensureAttendanceShape,
  backfillAttendanceIdentity,
} = require('../modules/attendance/attendance.controller');

const run = async () => {
  const result = await withDbConnection(async (connection) => {
    await ensureAttendanceShape(connection);
    return backfillAttendanceIdentity(connection);
  });

  console.log('✅ Backfill de asistencia completado');
  console.log(`   employee_id completados desde user_id: ${result.employeeIdsFilled}`);
  console.log(`   user_id completados desde employee_id: ${result.userIdsFilled}`);
};

run()
  .catch((error) => {
    console.error('❌ Error en backfill de asistencia:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
