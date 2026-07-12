export const DEFAULT_REPORT_TIMEZONE = 'Africa/Johannesburg';

export function normalizeReportTimeZone(value = DEFAULT_REPORT_TIMEZONE, fallback = DEFAULT_REPORT_TIMEZONE) {
  const candidate = String(value || '').trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-ZA', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

export function parseReportInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  let normalized = raw;
  // Tenant SQLite timestamps without an explicit offset are UTC. Make that explicit so
  // browser locale settings cannot silently shift report times differently per device.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(normalized)) {
    normalized = `${normalized.replace(' ', 'T')}Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized = `${normalized}T00:00:00.000Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolveReportTimestamp(primaryValue, fallbackValue = '', timeZone = DEFAULT_REPORT_TIMEZONE) {
  const primary = String(primaryValue || '').trim();
  const fallback = String(fallbackValue || '').trim();
  if (!primary) return fallback;
  if (!fallback) return primary;

  const primaryInstant = parseReportInstant(primary);
  const fallbackInstant = parseReportInstant(fallback);
  if (!primaryInstant || !fallbackInstant) return primary;

  const primaryHasOnlyDate = /^\d{4}-\d{2}-\d{2}$/.test(primary);
  const primaryClock = primary.match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  const primaryLooksLikeMidnight = primaryHasOnlyDate || (
    primaryClock && Number(primaryClock[1]) === 0 && Number(primaryClock[2]) === 0 && Number(primaryClock[3] || 0) === 0
  );
  if (!primaryLooksLikeMidnight) return primary;

  const fallbackClock = fallback.match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  const fallbackHasUsefulClock = Boolean(fallbackClock) && (
    Number(fallbackClock[1]) !== 0 || Number(fallbackClock[2]) !== 0 || Number(fallbackClock[3] || 0) !== 0
  );
  if (!fallbackHasUsefulClock) return primary;

  const zone = normalizeReportTimeZone(timeZone);
  const primaryParts = getZonedDateTimeParts(primaryInstant, zone);
  const fallbackParts = getZonedDateTimeParts(fallbackInstant, zone);
  if (!primaryParts || !fallbackParts) return primary;
  const sameLocalDate = primaryParts.year === fallbackParts.year
    && primaryParts.month === fallbackParts.month
    && primaryParts.day === fallbackParts.day;
  return sameLocalDate ? fallback : primary;
}

export function getZonedDateTimeParts(value, timeZone = DEFAULT_REPORT_TIMEZONE) {
  const parsed = parseReportInstant(value);
  if (!parsed) return null;
  const zone = normalizeReportTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(parsed);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    timeZone: zone
  };
}

export function zonedDateTimeStrings(value, timeZone = DEFAULT_REPORT_TIMEZONE) {
  const parts = getZonedDateTimeParts(value, timeZone);
  if (!parts) return { date: '', time: '', dateTime: '' };
  const pad = (number) => String(number).padStart(2, '0');
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const time = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return { date, time, dateTime: `${date} ${time}`, timeZone: parts.timeZone };
}

export function formatReportDateTime(value, timeZone = DEFAULT_REPORT_TIMEZONE, options = {}) {
  const parsed = parseReportInstant(value);
  if (!parsed) return String(value || '').trim() || '-';
  return new Intl.DateTimeFormat(options.locale || 'en-ZA', {
    timeZone: normalizeReportTimeZone(timeZone),
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...options
  }).format(parsed);
}

export function formatReportTime(value, timeZone = DEFAULT_REPORT_TIMEZONE, { includeSeconds = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const timeOnly = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnly) return includeSeconds && timeOnly[3]
    ? `${timeOnly[1]}:${timeOnly[2]}:${timeOnly[3]}`
    : `${timeOnly[1]}:${timeOnly[2]}`;
  const local = zonedDateTimeStrings(raw, timeZone);
  if (!local.time) return '';
  return includeSeconds ? local.time : local.time.slice(0, 5);
}

export function zonedLocalDateTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0, timeZone = DEFAULT_REPORT_TIMEZONE) {
  const zone = normalizeReportTimeZone(timeZone);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const represented = getZonedDateTimeParts(new Date(guess), zone);
    if (!represented) break;
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second
    );
    const correction = target - representedUtc;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

export function localDateRangeToUtcBounds({ from = '', to = '', timeZone = DEFAULT_REPORT_TIMEZONE } = {}) {
  const zone = normalizeReportTimeZone(timeZone);
  const parseDate = (value) => {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
  };
  const start = parseDate(from);
  const end = parseDate(to);
  const fromUtc = start
    ? zonedLocalDateTimeToUtc(start.year, start.month, start.day, 0, 0, 0, zone).toISOString()
    : '';
  let toExclusiveUtc = '';
  if (end) {
    const next = new Date(Date.UTC(end.year, end.month - 1, end.day + 1));
    toExclusiveUtc = zonedLocalDateTimeToUtc(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
      0,
      0,
      zone
    ).toISOString();
  }
  return { fromUtc, toExclusiveUtc, timeZone: zone };
}
