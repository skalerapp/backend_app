require('dotenv').config();

const { withDbConnection, closeDatabase } = require('../config/database');
const {
  ensureAttendanceShape,
  ensureAttendanceEventsShape,
} = require('../modules/attendance/attendance.controller');
const { computeAttendanceProductivity } = require('../modules/attendance/attendanceProductivity');

const ATTENDANCE_SELECT = `
  SELECT a.*,
         COALESCE(user_direct.role, u.role, '') AS app_user_role
  FROM attendance a
  LEFT JOIN employees e ON e.id = a.employee_id
  LEFT JOIN employees e_by_user ON a.user_id IS NOT NULL AND e_by_user.user_id = a.user_id
  LEFT JOIN users user_direct ON a.user_id = user_direct.id
  LEFT JOIN users u ON e.user_id = u.id
  WHERE a.check_in IS NOT NULL
    AND a.check_out IS NOT NULL
`;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply;
  const idIndex = args.indexOf('--id');
  const fromIndex = args.indexOf('--from');
  const toIndex = args.indexOf('--to');

  return {
    dryRun,
    apply,
    attendanceId: idIndex >= 0 ? Number(args[idIndex + 1]) : null,
    dateFrom: fromIndex >= 0 ? args[fromIndex + 1] : null,
    dateTo: toIndex >= 0 ? args[toIndex + 1] : null,
  };
};

const buildQuery = ({ attendanceId, dateFrom, dateTo }) => {
  const conditions = [];
  const params = [];

  if (attendanceId) {
    conditions.push('a.id = ?');
    params.push(attendanceId);
  }
  if (dateFrom) {
    conditions.push('a.attendance_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('a.attendance_date <= ?');
    params.push(dateTo);
  }

  const whereExtra = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
  return {
    sql: `${ATTENDANCE_SELECT}${whereExtra} ORDER BY a.attendance_date ASC, a.id ASC`,
    params,
  };
};

const fetchEvents = async (connection, attendanceId) => {
  const [rows] = await connection.execute(
    'SELECT event_type, recorded_at FROM attendance_events WHERE attendance_id = ? ORDER BY recorded_at ASC, id ASC',
    [attendanceId],
  );
  return rows;
};

const recalculateAttendanceProductivity = async (connection, options = {}) => {
  await ensureAttendanceShape(connection);
  await ensureAttendanceEventsShape(connection);

  const { sql, params } = buildQuery(options);
  const [rows] = await connection.execute(sql, params);

  const summary = {
    scanned: rows.length,
    updated: 0,
    unchanged: 0,
    categoryChanges: 0,
    samples: [],
  };

  for (const row of rows) {
    const events = await fetchEvents(connection, row.id);
    const productivity = await computeAttendanceProductivity(connection, row, events);

    const nextCategory = productivity.time_category;
    const nextReason = productivity.unproductive_reason;
    const prevCategory = (row.time_category || 'productive').toString();
    const prevReason = row.unproductive_reason?.toString() || null;

    const categoryChanged = prevCategory !== nextCategory;
    const reasonChanged = prevReason !== nextReason;
    const changed = categoryChanged || reasonChanged;

    if (changed) {
      summary.updated += 1;
      if (categoryChanged) summary.categoryChanges += 1;

      if (summary.samples.length < 10) {
        summary.samples.push({
          id: row.id,
          date: row.attendance_date?.toString().slice(0, 10),
          employeeId: row.employee_id,
          prevCategory,
          nextCategory,
          prevReason,
          nextReason,
          referenceHours: productivity.reference_hours,
        });
      }

      if (!options.dryRun) {
        await connection.execute(
          `UPDATE attendance
           SET time_category = ?,
               unproductive_reason = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [nextCategory, nextReason, row.id],
        );
      }
    } else {
      summary.unchanged += 1;
    }
  }

  return summary;
};

const printSummary = (summary, dryRun) => {
  console.log('');
  console.log(dryRun ? '🔎 Simulación (sin cambios en BD)' : '✅ Recalculo aplicado');
  console.log(`   Registros revisados: ${summary.scanned}`);
  console.log(`   A actualizar:        ${summary.updated}`);
  console.log(`   Sin cambios:         ${summary.unchanged}`);
  console.log(`   Cambio de categoría: ${summary.categoryChanges}`);

  if (summary.samples.length > 0) {
    console.log('');
    console.log('Ejemplos:');
    for (const sample of summary.samples) {
      console.log(` - #${sample.id} ${sample.date} | ${sample.prevCategory} -> ${sample.nextCategory} | ref ${sample.referenceHours} h`);
      if (sample.prevReason !== sample.nextReason) {
        console.log(`   antes: ${sample.prevReason || '(vacío)'}`);
        console.log(`   ahora: ${sample.nextReason || '(vacío)'}`);
      }
    }
  }

  if (dryRun && summary.updated > 0) {
    console.log('');
    console.log('Para aplicar cambios ejecuta el mismo comando con --apply');
  }
};

const run = async () => {
  const options = parseArgs();
  console.log('Recalculando productividad de asistencia (zona horaria Colombia)...');
  if (options.attendanceId) console.log(`Filtro id: ${options.attendanceId}`);
  if (options.dateFrom) console.log(`Desde: ${options.dateFrom}`);
  if (options.dateTo) console.log(`Hasta: ${options.dateTo}`);

  const summary = await withDbConnection(async (connection) =>
    recalculateAttendanceProductivity(connection, options),
  );

  printSummary(summary, options.dryRun);
};

if (require.main === module) {
  run()
    .catch((error) => {
      console.error('❌ Error recalculando productividad:', error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabase();
    });
}

module.exports = {
  recalculateAttendanceProductivity,
  parseArgs,
};
