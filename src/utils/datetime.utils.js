const DEFAULT_APP_TIMEZONE = 'America/Bogota';
const DEFAULT_APP_TIMEZONE_OFFSET = '-05:00';

const resolveAppTimezone = () => {
  const configured = (process.env.APP_TIMEZONE || '').trim();
  return configured || DEFAULT_APP_TIMEZONE;
};

const resolveAppTimezoneOffset = () => {
  const configured = (process.env.APP_TIMEZONE_OFFSET || '').trim();
  return configured || DEFAULT_APP_TIMEZONE_OFFSET;
};

const toSqlDatetime = (date = new Date()) => {
  const resolved = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(resolved.getTime())) {
    throw new TypeError('Invalid date');
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveAppTimezone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(resolved);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '00';
  const hour = pick('hour') === '24' ? '00' : pick('hour');

  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}:${pick('second')}`;
};

const toBusinessDateKey = (date = new Date()) => toSqlDatetime(date).slice(0, 10);

module.exports = {
  DEFAULT_APP_TIMEZONE,
  DEFAULT_APP_TIMEZONE_OFFSET,
  resolveAppTimezone,
  resolveAppTimezoneOffset,
  toSqlDatetime,
  toBusinessDateKey,
};
