const DEFAULT_APP_TIMEZONE = 'America/Bogota';
const DEFAULT_APP_TIMEZONE_OFFSET = '-05:00';
const SQL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

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

const nowSql = () => toSqlDatetime(new Date());

const toBusinessDateKey = (date = new Date()) => toSqlDatetime(date).slice(0, 10);

const formatDatetimeForApi = (value) => {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return toSqlDatetime(value);
  }

  const raw = value.toString().trim();
  if (!raw) return null;

  if (SQL_DATETIME_PATTERN.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }

  return toSqlDatetime(parsed);
};

const normalizeRowDatetimes = (row, fields) => {
  if (!row || typeof row !== 'object') return row;
  const normalized = { ...row };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) {
      normalized[field] = formatDatetimeForApi(normalized[field]);
    }
  }
  return normalized;
};

const parseSqlDatetimeInAppTimezone = (value) => {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = value.toString().trim();
  if (!raw) return null;

  if (SQL_DATETIME_PATTERN.test(raw)) {
    const parsed = new Date(`${raw.replace(' ', 'T')}${resolveAppTimezoneOffset()}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const isoCandidate = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(isoCandidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getSqlDatetimeMillis = (value) => {
  const parsed = parseSqlDatetimeInAppTimezone(value);
  return parsed ? parsed.getTime() : null;
};

const isSqlDatetimePast = (value, nowMs = Date.now()) => {
  const millis = getSqlDatetimeMillis(value);
  if (millis == null) return false;
  return millis <= nowMs;
};

module.exports = {
  DEFAULT_APP_TIMEZONE,
  DEFAULT_APP_TIMEZONE_OFFSET,
  resolveAppTimezone,
  resolveAppTimezoneOffset,
  toSqlDatetime,
  nowSql,
  toBusinessDateKey,
  formatDatetimeForApi,
  normalizeRowDatetimes,
  parseSqlDatetimeInAppTimezone,
  getSqlDatetimeMillis,
  isSqlDatetimePast,
};
