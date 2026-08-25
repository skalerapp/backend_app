const {
  computeReferenceHours,
  computeProductivityCategory,
  computeProductivityFromMetrics,
} = require('../src/modules/attendance/attendanceProductivity');

describe('attendanceProductivity', () => {
  test('uses operations window for full operations profile', () => {
    const hours = computeReferenceHours({
      profile: 'full_operations',
      checkIn: '2026-08-01T08:00:00.000Z',
      checkOut: '2026-08-01T17:00:00.000Z',
      events: [
        { event_type: 'operations_start', recorded_at: '2026-08-01T09:00:00.000Z' },
        { event_type: 'lunch_start', recorded_at: '2026-08-01T12:00:00.000Z' },
        { event_type: 'lunch_end', recorded_at: '2026-08-01T13:00:00.000Z' },
        { event_type: 'operations_end', recorded_at: '2026-08-01T16:00:00.000Z' },
      ],
    });

    expect(hours).toBe(6);
  });

  test('marks productive when execution covers most of operational time', () => {
    const result = computeProductivityFromMetrics({
      roleValue: 'operational_employee',
      checkIn: '2026-08-01T08:00:00.000Z',
      checkOut: '2026-08-01T17:00:00.000Z',
      events: [
        { event_type: 'operations_start', recorded_at: '2026-08-01T09:00:00.000Z' },
        { event_type: 'operations_end', recorded_at: '2026-08-01T17:00:00.000Z' },
      ],
      activityHours: 6.5,
      completedActivities: 3,
      completedTasks: 1,
    });

    expect(result.time_category).toBe('productive');
    expect(result.productivity_rate).toBeGreaterThanOrEqual(65);
  });

  test('marks unproductive when there is operational time but no execution', () => {
    const result = computeProductivityCategory({
      referenceHours: 8,
      activityHours: 0,
      completedActivities: 0,
      completedTasks: 0,
    });

    expect(result.time_category).toBe('unproductive');
    expect(result.unproductive_reason).toMatch(/sin actividades/i);
  });

  test('administrative profile uses Bogota SQL datetimes for reference hours', () => {
    const hours = computeReferenceHours({
      profile: 'lunch_break_only',
      checkIn: '2026-08-21 06:07:43',
      checkOut: '2026-08-21 18:05:28',
      events: [
        { event_type: 'lunch_start', recorded_at: '2026-08-21 18:05:08' },
        { event_type: 'lunch_end', recorded_at: '2026-08-21 18:05:11' },
      ],
    });

    expect(hours).toBeCloseTo(11.96, 1);
  });

  test('administrative profile uses full shift minus lunch as reference', () => {
    const result = computeProductivityFromMetrics({
      roleValue: 'administrative',
      checkIn: '2026-08-01T08:00:00.000Z',
      checkOut: '2026-08-01T17:00:00.000Z',
      events: [
        { event_type: 'lunch_start', recorded_at: '2026-08-01T12:00:00.000Z' },
        { event_type: 'lunch_end', recorded_at: '2026-08-01T13:00:00.000Z' },
      ],
      activityHours: 5,
      completedActivities: 2,
      completedTasks: 0,
    });

    expect(result.reference_hours).toBe(8);
    expect(result.time_category).toBe('productive');
  });
});
