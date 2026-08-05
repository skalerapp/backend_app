const {
  toSqlDatetime,
  toBusinessDateKey,
  resolveAppTimezoneOffset,
  formatDatetimeForApi,
  normalizeRowDatetimes,
} = require('../src/utils/datetime.utils');

describe('datetime utils', () => {
  const previousTimezone = process.env.APP_TIMEZONE;
  const previousOffset = process.env.APP_TIMEZONE_OFFSET;

  afterEach(() => {
    if (previousTimezone == null) {
      delete process.env.APP_TIMEZONE;
    } else {
      process.env.APP_TIMEZONE = previousTimezone;
    }

    if (previousOffset == null) {
      delete process.env.APP_TIMEZONE_OFFSET;
    } else {
      process.env.APP_TIMEZONE_OFFSET = previousOffset;
    }
  });

  it('formats UTC instants in America/Bogota for SQL datetime columns', () => {
    process.env.APP_TIMEZONE = 'America/Bogota';
    const utcInstant = new Date('2026-06-20T00:32:50.000Z');

    expect(toSqlDatetime(utcInstant)).toBe('2026-06-19 19:32:50');
  });

  it('derives business date keys from timezone-aware SQL datetimes', () => {
    process.env.APP_TIMEZONE = 'America/Bogota';
    const utcInstant = new Date('2026-07-03T00:39:42.000Z');

    expect(toSqlDatetime(utcInstant)).toBe('2026-07-02 19:39:42');
    expect(toBusinessDateKey(utcInstant)).toBe('2026-07-02');
  });

  it('formats API datetimes without timezone suffix', () => {
    process.env.APP_TIMEZONE = 'America/Bogota';
    expect(formatDatetimeForApi('2026-08-01 14:18:24')).toBe('2026-08-01 14:18:24');
    expect(formatDatetimeForApi(new Date('2026-08-01T19:18:24.000Z'))).toBe('2026-08-01 14:18:24');
  });

  it('normalizes row datetime fields for API responses', () => {
    process.env.APP_TIMEZONE = 'America/Bogota';
    const row = normalizeRowDatetimes(
      { id: 1, check_in: new Date('2026-08-01T19:18:24.000Z'), check_out: null },
      ['check_in', 'check_out'],
    );
    expect(row.check_in).toBe('2026-08-01 14:18:24');
    expect(row.check_out).toBeNull();
  });

  it('defaults app timezone offset to Colombia', () => {
    delete process.env.APP_TIMEZONE_OFFSET;
    expect(resolveAppTimezoneOffset()).toBe('-05:00');
  });

  it('parses SQL datetimes using app timezone instead of server local time', () => {
    const {
      parseSqlDatetimeInAppTimezone,
      isSqlDatetimePast,
    } = require('../src/utils/datetime.utils');

    process.env.APP_TIMEZONE_OFFSET = '-05:00';

    const parsed = parseSqlDatetimeInAppTimezone('2026-08-05 17:10:24');
    expect(parsed.toISOString()).toBe('2026-08-05T22:10:24.000Z');

    const beforeExpiry = new Date('2026-08-05T21:42:00.000Z').getTime();
    expect(isSqlDatetimePast('2026-08-05 17:10:24', beforeExpiry)).toBe(false);

    const afterExpiry = new Date('2026-08-05T22:15:00.000Z').getTime();
    expect(isSqlDatetimePast('2026-08-05 17:10:24', afterExpiry)).toBe(true);
  });
});
