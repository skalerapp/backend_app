const {
  toSqlDatetime,
  toBusinessDateKey,
  resolveAppTimezoneOffset,
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

  it('defaults app timezone offset to Colombia', () => {
    delete process.env.APP_TIMEZONE_OFFSET;
    expect(resolveAppTimezoneOffset()).toBe('-05:00');
  });
});
