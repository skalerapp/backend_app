const { resolveWorkdayProfile } = require('./attendanceWorkday');

const parseDateTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const hoursBetween = (start, end) => {
  if (!start || !end || end <= start) return 0;
  return (end - start) / (1000 * 60 * 60);
};

const indexEventsByType = (events = []) => {
  const map = {};
  for (const event of events) {
    const type = event?.event_type?.toString().trim();
    if (!type) continue;
    map[type] = parseDateTime(event.recorded_at);
  }
  return map;
};

const computeReferenceHours = ({
  profile,
  events = [],
  checkIn,
  checkOut,
}) => {
  const eventMap = indexEventsByType(events);
  const checkInAt = parseDateTime(checkIn);
  const checkOutAt = parseDateTime(checkOut);

  if (profile === 'full_operations') {
    const operationsStart = eventMap.operations_start || checkInAt;
    const operationsEnd = eventMap.operations_end || checkOutAt;
    let hours = hoursBetween(operationsStart, operationsEnd);
    if (eventMap.lunch_start && eventMap.lunch_end) {
      hours -= hoursBetween(eventMap.lunch_start, eventMap.lunch_end);
    }
    return Math.max(0, hours);
  }

  let hours = hoursBetween(checkInAt, checkOutAt);
  if (eventMap.lunch_start && eventMap.lunch_end) {
    hours -= hoursBetween(eventMap.lunch_start, eventMap.lunch_end);
  }
  return Math.max(0, hours);
};

const computeProductivityCategory = ({
  referenceHours,
  activityHours,
  completedActivities,
  completedTasks,
}) => {
  const taskBonusHours = Math.min(completedTasks * 0.5, referenceHours * 0.3);
  const effectiveExecutionHours = activityHours + taskBonusHours;
  const ratio = referenceHours > 0
    ? effectiveExecutionHours / referenceHours
    : (effectiveExecutionHours > 0 ? 1 : 0);

  if (referenceHours <= 0 && effectiveExecutionHours <= 0) {
    return {
      time_category: 'neutral',
      unproductive_reason: null,
      productivity_rate: 0,
      reference_hours: 0,
      execution_hours: 0,
      completed_activities: completedActivities,
      completed_tasks: completedTasks,
      summary: 'Jornada cerrada sin tiempo operativo evaluable.',
    };
  }

  if (ratio >= 0.65 || (completedActivities >= 2 && ratio >= 0.45)) {
    return {
      time_category: 'productive',
      unproductive_reason: null,
      productivity_rate: Math.round(Math.min(ratio, 1) * 100),
      reference_hours: Number(referenceHours.toFixed(2)),
      execution_hours: Number(effectiveExecutionHours.toFixed(2)),
      completed_activities: completedActivities,
      completed_tasks: completedTasks,
      summary: 'Productividad alta según tiempo operativo y actividades/tareas ejecutadas.',
    };
  }

  if (ratio >= 0.35 || completedTasks >= 1 || completedActivities >= 1) {
    return {
      time_category: 'neutral',
      unproductive_reason: null,
      productivity_rate: Math.round(Math.min(ratio, 1) * 100),
      reference_hours: Number(referenceHours.toFixed(2)),
      execution_hours: Number(effectiveExecutionHours.toFixed(2)),
      completed_activities: completedActivities,
      completed_tasks: completedTasks,
      summary: 'Productividad parcial según tiempo operativo y ejecución registrada.',
    };
  }

  return {
    time_category: 'unproductive',
    unproductive_reason: `Tiempo operativo (${referenceHours.toFixed(1)} h) sin actividades/tareas suficientes (${effectiveExecutionHours.toFixed(1)} h registradas).`,
    productivity_rate: Math.round(Math.min(ratio, 1) * 100),
    reference_hours: Number(referenceHours.toFixed(2)),
    execution_hours: Number(effectiveExecutionHours.toFixed(2)),
    completed_activities: completedActivities,
    completed_tasks: completedTasks,
    summary: 'Productividad baja según tiempo operativo y ejecución registrada.',
  };
};

const computeProductivityFromMetrics = ({
  roleValue,
  events = [],
  checkIn,
  checkOut,
  activityHours = 0,
  completedActivities = 0,
  completedTasks = 0,
}) => {
  const profile = resolveWorkdayProfile(roleValue);
  const referenceHours = computeReferenceHours({
    profile,
    events,
    checkIn,
    checkOut,
  });

  return computeProductivityCategory({
    referenceHours,
    activityHours,
    completedActivities,
    completedTasks,
  });
};

const fetchExecutionMetrics = async (connection, { employeeId, attendanceDate }) => {
  if (!employeeId || !attendanceDate) {
    return {
      activityHours: 0,
      completedActivities: 0,
      completedTasks: 0,
    };
  }

  const [activities] = await connection.execute(
    `SELECT start_time, end_time
     FROM activities
     WHERE employee_id = ?
       AND status = 'completed'
       AND (
         DATE(start_time) = ?
         OR DATE(end_time) = ?
         OR DATE(created_at) = ?
       )`,
    [employeeId, attendanceDate, attendanceDate, attendanceDate]
  );

  let activityHours = 0;
  for (const row of activities) {
    activityHours += hoursBetween(parseDateTime(row.start_time), parseDateTime(row.end_time));
  }

  let completedTasks = 0;
  try {
    const [tasks] = await connection.execute(
      `SELECT id
       FROM operational_tasks
       WHERE employee_id = ?
         AND status = 'completed'
         AND DATE(completed_at) = ?`,
      [employeeId, attendanceDate]
    );
    completedTasks = tasks.length;
  } catch (_) {
    completedTasks = 0;
  }

  return {
    activityHours: Math.max(0, activityHours),
    completedActivities: activities.length,
    completedTasks,
  };
};

const computeAttendanceProductivity = async (connection, attendanceRow, events = []) => {
  const employeeId = Number(attendanceRow.employee_id || attendanceRow.resolved_employee_id || 0) || null;
  const attendanceDate = attendanceRow.attendance_date?.toString().slice(0, 10);
  const metrics = await fetchExecutionMetrics(connection, {
    employeeId,
    attendanceDate,
  });

  return computeProductivityFromMetrics({
    roleValue: attendanceRow.app_user_role,
    events,
    checkIn: attendanceRow.check_in,
    checkOut: new Date(),
    activityHours: metrics.activityHours,
    completedActivities: metrics.completedActivities,
    completedTasks: metrics.completedTasks,
  });
};

module.exports = {
  computeReferenceHours,
  computeProductivityCategory,
  computeProductivityFromMetrics,
  computeAttendanceProductivity,
  fetchExecutionMetrics,
};
