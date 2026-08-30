import { safeNumber } from './calculations.js';
import { DEFAULT_REPORT_TIMEZONE, formatReportDateTime, formatReportTime, normalizeReportTimeZone, parseReportInstant } from './timezone.js';

const moneyFormatter = new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const numberFormatter = new Intl.NumberFormat('en-ZA', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

const percentFormatter = new Intl.NumberFormat('en-ZA', {
  style: 'percent',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

export function formatMoney(value) {
  return moneyFormatter.format(safeNumber(value));
}

export function formatQuantity(value, unit = '') {
  const suffix = String(unit || '').trim();
  const formatted = numberFormatter.format(safeNumber(value));
  return suffix ? `${formatted} ${suffix}` : formatted;
}

export function formatNumber(value) {
  return numberFormatter.format(safeNumber(value));
}

export function formatPercent(value) {
  return percentFormatter.format(safeNumber(value));
}

export function formatDate(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const date = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
    return new Intl.DateTimeFormat(options.locale || 'en-ZA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    }).format(date);
  }
  const parsed = parseReportInstant(raw);
  if (!parsed) return raw.slice(0, 10) || raw;
  return new Intl.DateTimeFormat(options.locale || 'en-ZA', {
    timeZone: normalizeReportTimeZone(options.timeZone || DEFAULT_REPORT_TIMEZONE),
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(parsed);
}

export function formatTime(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  const timeZone = typeof options === 'string' ? options : options.timeZone;
  return formatReportTime(raw, timeZone || DEFAULT_REPORT_TIMEZONE) || raw;
}

export function formatDateTime(value, options = {}) {
  const timeZone = typeof options === 'string' ? options : options.timeZone;
  return formatReportDateTime(value, timeZone || DEFAULT_REPORT_TIMEZONE, typeof options === 'object' ? options : {});
}

export function formatCell(value, column = {}) {
  if (value === null || value === undefined || value === '') return '-';
  if (column.type === 'money') return formatMoney(value);
  if (column.type === 'qty') return formatQuantity(value, column.unit || '');
  if (column.type === 'percent') return formatPercent(value);
  if (column.type === 'number') return formatNumber(value);
  if (column.type === 'date') return formatDate(value, column);
  if (column.type === 'datetime') return formatDateTime(value, column);
  if (column.type === 'time') return formatTime(value, column);
  return String(value);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function toCsvSafe(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
