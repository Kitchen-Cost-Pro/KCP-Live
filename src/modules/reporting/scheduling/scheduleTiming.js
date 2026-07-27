import { zonedTradingDateTimeStrings } from "../engine/timezone.js";

const DATE_RANGE_TYPES = new Set([
  'today', 'yesterday', 'last_2_days', 'this_week', 'last_week', 'this_month', 'last_month',
  'last_7_days', 'last_14_days', 'last_30_days', 'custom'
]);

export function resolveScheduledRelativeRange(
  type = 'custom',
  filters = {},
  timezone = 'Africa/Johannesburg',
  now = new Date(),
  tradingDayStartMinutes = 0,
) {
  const normalized = normalizeDateRangeType(type);
  if (normalized === 'custom') {
    const from = clean(filters.from || filters.startDate);
    const to = clean(filters.to || filters.endDate);
    return { from, to, startDate: from, endDate: to };
  }

  const tradingDate = zonedTradingDateTimeStrings(now, timezone, tradingDayStartMinutes).date;
  const tradingMatch = tradingDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parts = tradingMatch
    ? { year: Number(tradingMatch[1]), month: Number(tradingMatch[2]), day: Number(tradingMatch[3]) }
    : zonedDateParts(now, timezone);
  let start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  let end = new Date(start);
  const mondayStart = (date) => {
    const output = new Date(date);
    const day = output.getUTCDay();
    output.setUTCDate(output.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return output;
  };

  if (normalized === 'yesterday') {
    start.setUTCDate(start.getUTCDate() - 1);
    end = new Date(start);
  } else if (normalized === 'last_2_days') {
    start.setUTCDate(start.getUTCDate() - 1);
  } else if (normalized === 'this_week') {
    start = mondayStart(start);
  } else if (normalized === 'last_week') {
    end = mondayStart(start);
    end.setUTCDate(end.getUTCDate() - 1);
    start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
  } else if (normalized === 'this_month') {
    start = new Date(Date.UTC(parts.year, parts.month - 1, 1));
  } else if (normalized === 'last_month') {
    start = new Date(Date.UTC(parts.year, parts.month - 2, 1));
    end = new Date(Date.UTC(parts.year, parts.month - 1, 0));
  } else if (normalized === 'last_7_days') {
    start.setUTCDate(start.getUTCDate() - 6);
  } else if (normalized === 'last_14_days') {
    start.setUTCDate(start.getUTCDate() - 13);
  } else if (normalized === 'last_30_days') {
    start.setUTCDate(start.getUTCDate() - 29);
  }

  const format = (date) => date.toISOString().slice(0, 10);
  return { from: format(start), to: format(end), startDate: format(start), endDate: format(end) };
}

export function calculateReportNextRunAt(input = {}, from = new Date()) {
  const frequency = clean(input.scheduleFrequency || input.frequency || 'weekly').toLowerCase();
  const timezone = clean(input.timezone || 'Africa/Johannesburg');
  const [parsedHour, parsedMinute] = clean(input.scheduleTime || input.time || '08:00').split(':').map(Number);
  const hour = Number.isFinite(parsedHour) ? parsedHour : 8;
  const minute = Number.isFinite(parsedMinute) ? parsedMinute : 0;
  const local = zonedDateParts(from, timezone);
  let year = local.year;
  let month = local.month;
  let day = local.day;

  if (frequency === 'weekly') {
    const currentDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const targetDay = clamp(Number(input.scheduleDay ?? 1), 0, 6);
    let delta = (targetDay - currentDay + 7) % 7;
    const candidateToday = zonedLocalToUtc(year, month, day, hour, minute, timezone);
    if (delta === 0 && candidateToday.getTime() <= from.getTime()) delta = 7;
    const target = new Date(Date.UTC(year, month - 1, day + delta));
    year = target.getUTCFullYear();
    month = target.getUTCMonth() + 1;
    day = target.getUTCDate();
  } else if (frequency === 'monthly') {
    day = clamp(Number(input.scheduleDay || 1), 1, 28);
    const candidate = zonedLocalToUtc(year, month, day, hour, minute, timezone);
    if (candidate.getTime() <= from.getTime()) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  } else {
    const candidate = zonedLocalToUtc(year, month, day, hour, minute, timezone);
    if (candidate.getTime() <= from.getTime()) {
      const target = new Date(Date.UTC(year, month - 1, day + 1));
      year = target.getUTCFullYear();
      month = target.getUTCMonth() + 1;
      day = target.getUTCDate();
    }
  }

  return zonedLocalToUtc(year, month, day, hour, minute, timezone).toISOString();
}

function normalizeDateRangeType(value) {
  const normalized = clean(value || 'custom').toLowerCase().replace(/[\s-]+/g, '_');
  if (!DATE_RANGE_TYPES.has(normalized)) throw new Error('Unsupported date range preset.');
  return normalized;
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function zonedLocalToUtc(year, month, day, hour, minute, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const representedParts = zonedDateParts(new Date(guess), timeZone);
    const represented = Date.UTC(
      representedParts.year,
      representedParts.month - 1,
      representedParts.day,
      representedParts.hour,
      representedParts.minute
    );
    guess += Date.UTC(year, month - 1, day, hour, minute) - represented;
  }
  return new Date(guess);
}

function clamp(value, minimum, maximum) {
  const numeric = Number.isFinite(value) ? value : minimum;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function clean(value) {
  return String(value ?? '').trim();
}
