const { parseArgs, formatError } = require('../src/utils/recalculateAttendanceProductivity');

describe('recalculateAttendanceProductivity args', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('defaults to dry run without --apply', () => {
    process.argv = ['node', 'recalculateAttendanceProductivity.js'];
    const options = parseArgs();
    expect(options.dryRun).toBe(true);
    expect(options.apply).toBe(false);
  });

  it('parses apply and filters', () => {
    process.argv = [
      'node',
      'recalculateAttendanceProductivity.js',
      '--apply',
      '--id',
      '42',
      '--from',
      '2026-08-01',
      '--to',
      '2026-08-31',
    ];
    const options = parseArgs();
    expect(options.apply).toBe(true);
    expect(options.dryRun).toBe(false);
    expect(options.attendanceId).toBe(42);
    expect(options.dateFrom).toBe('2026-08-01');
    expect(options.dateTo).toBe('2026-08-31');
  });

  it('formats connection refused with actionable guidance', () => {
    const message = formatError({ code: 'ECONNREFUSED' });
    expect(message).toMatch(/ECONNREFUSED/i);
    expect(message).toMatch(/\.env\.client\.sync/i);
  });
});
