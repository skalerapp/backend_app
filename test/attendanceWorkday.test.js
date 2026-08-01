const {
  resolveWorkdayProfile,
  resolveWorkdayState,
  validateEventRegistration,
  validateCheckoutAllowed,
  WORKDAY_PROFILES,
} = require('../src/modules/attendance/attendanceWorkday');

describe('attendanceWorkday', () => {
    test('maps operational roles to full operations profile', () => {
    expect(resolveWorkdayProfile('operational_employee')).toBe(WORKDAY_PROFILES.FULL_OPERATIONS);
    expect(resolveWorkdayProfile('leader')).toBe(WORKDAY_PROFILES.FULL_OPERATIONS);
    expect(resolveWorkdayProfile('supervisor')).toBe(WORKDAY_PROFILES.FULL_OPERATIONS);
  });

  test('maps coordinator, hse, administrative, warehouse and commercial to lunch-only profile', () => {
    expect(resolveWorkdayProfile('coordinator_operations')).toBe(WORKDAY_PROFILES.LUNCH_BREAK_ONLY);
    expect(resolveWorkdayProfile('hse')).toBe(WORKDAY_PROFILES.LUNCH_BREAK_ONLY);
    expect(resolveWorkdayProfile('administrative')).toBe(WORKDAY_PROFILES.LUNCH_BREAK_ONLY);
    expect(resolveWorkdayProfile('warehouse_logistics')).toBe(WORKDAY_PROFILES.LUNCH_BREAK_ONLY);
    expect(resolveWorkdayProfile('commercial')).toBe(WORKDAY_PROFILES.LUNCH_BREAK_ONLY);
  });

  test('full operations flow requires milestones before checkout', () => {
    let state = resolveWorkdayState({
      roleValue: 'operational_employee',
      hasCheckIn: true,
      hasCheckOut: false,
      events: [],
    });
    expect(state.nextAction).toBe('operations_start');

    state = resolveWorkdayState({
      roleValue: 'operational_employee',
      hasCheckIn: true,
      hasCheckOut: false,
      events: [{ event_type: 'operations_start' }],
    });
    expect(state.nextAction).toBe('lunch_start');

    state = resolveWorkdayState({
      roleValue: 'operational_employee',
      hasCheckIn: true,
      hasCheckOut: false,
      events: [
        { event_type: 'operations_start' },
        { event_type: 'lunch_start' },
        { event_type: 'lunch_end' },
        { event_type: 'operations_end' },
      ],
    });
    expect(state.nextAction).toBe('check_out');
    expect(state.canRegisterCheckOut).toBe(true);
  });

  test('administrative flow only requires lunch milestones', () => {
    const state = resolveWorkdayState({
      roleValue: 'administrative',
      hasCheckIn: true,
      hasCheckOut: false,
      events: [],
    });
    expect(state.nextAction).toBe('lunch_start');

    const checkout = validateCheckoutAllowed({
      roleValue: 'administrative',
      events: [{ event_type: 'lunch_start' }],
    });
    expect(checkout.ok).toBe(false);

    const checkoutReady = validateCheckoutAllowed({
      roleValue: 'administrative',
      events: [
        { event_type: 'lunch_start' },
        { event_type: 'lunch_end' },
      ],
    });
    expect(checkoutReady.ok).toBe(true);
  });

  test('validateEventRegistration enforces order', () => {
    const invalid = validateEventRegistration({
      roleValue: 'operational_employee',
      events: [],
      eventType: 'lunch_start',
    });
    expect(invalid.ok).toBe(false);

    const valid = validateEventRegistration({
      roleValue: 'operational_employee',
      events: [{ event_type: 'operations_start' }],
      eventType: 'lunch_start',
    });
    expect(valid.ok).toBe(true);
  });
});
