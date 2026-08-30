import { formatCell } from '../engine/formatters.js';
import { zonedDateTimeStrings } from '../engine/timezone.js';
import { safeNumber } from '../engine/calculations.js';
import { text, toArray } from '../engine/grouping.js';
import { buildExportFilename } from '../../../services/exportService.js';

export const STANDARD_EXPORT_COLUMNS = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'time', label: 'Time', type: 'time' },
  { key: 'documentNumber', label: 'Document Number' },
  { key: 'locationName', label: 'Location' },
  { key: 'category', label: 'Category' },
  { key: 'itemName', label: 'Item' },
  { key: 'description', label: 'Description' },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'baseUom', label: 'UOM' },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money' },
  { key: 'netAmount', label: 'Net Amount', type: 'money' },
  { key: 'vatAmount', label: 'VAT Amount', type: 'money' },
  { key: 'grossAmount', label: 'Gross Amount', type: 'money' },
  { key: 'source', label: 'Source' },
  { key: 'createdBy', label: 'Created By' },
  { key: 'reference', label: 'Reference' },
  { key: 'sourceId', label: 'Source ID' },
  { key: 'notes', label: 'Notes' }
];

export const ACCOUNTING_EXPORT_COLUMNS = [
  { key: 'accountCode', label: 'Account Code' },
  { key: 'taxType', label: 'Tax Type' },
  { key: 'trackingCategory1', label: 'Tracking Category 1' },
  { key: 'trackingCategory2', label: 'Tracking Category 2' },
  { key: 'reference', label: 'Reference' },
  { key: 'description', label: 'Description' },
  { key: 'amountExVat', label: 'Amount Ex VAT', type: 'money' },
  { key: 'vat', label: 'VAT', type: 'money' },
  { key: 'amountInclVat', label: 'Amount Incl VAT', type: 'money' },
  { key: 'source', label: 'Source' },
  { key: 'sourceId', label: 'Source ID' }
];

const UI_ONLY_KEYS = new Set([
  'actions',
  'button',
  'buttons',
  'icon',
  'icons',
  'tooltip',
  'cellTooltip',
  'component',
  'element',
  'raw',
  'rawJson',
  'uiState',
  '__meta',
  '__apiMeta',
  '__apiWarnings',
  '__lines',
  'reportSourceRow',
  'rawSourceRow'
]);

const MONEY_KEY_PATTERN = /(amount|cost|value|vat|variance|purchase|sales|wastage|adjustment|transfer|closing|opening|movement|gross|net|incl|ex|price)$/i;

export function mapReportRowsForExport(result = {}, { formatted = true } = {}) {
  const columns = getExportColumns(result);
  return toArray(result.rows).map((row) => mapRowToExport(row, columns, result, { formatted }));
}

export function mapReportTotalsForExport(result = {}, { formatted = true } = {}) {
  if (result.includeTotalsInExport === false || result.report?.includeTotalsInExport === false) return null;
  const totals = result.totals || {};
  const columns = getExportColumns(result);
  if (!columns.length || !Object.keys(totals).length) return null;

  const row = columns.reduce((mapped, column, index) => {
    const header = getExportHeader(result, column);
    if (index === 0) {
      mapped[header] = 'Totals';
      return mapped;
    }
    mapped[header] = totals[column.key] === undefined
      ? ''
      : normalizeExportValue(totals[column.key], column, { row: totals, result, formatted });
    return mapped;
  }, {});
  return Object.values(row).some((value) => text(value)) ? row : null;
}

export function mapReportRowsForAccountingExport(result = {}, { formatted = true } = {}) {
  return toArray(result.rows).map((row) => {
    const mapped = {
      accountCode: row.accountCode || row.account_code || '',
      taxType: row.taxType || row.tax_type || '',
      trackingCategory1: row.trackingCategory1 || row.tracking_category_1 || row.locationName || row.location || '',
      trackingCategory2: row.trackingCategory2 || row.tracking_category_2 || row.category || '',
      reference: row.reference || row.documentNumber || row.transferNumber || row.sourceId || '',
      description: row.description || buildAccountingDescription(row),
      amountExVat: row.amountExVat ?? row.netAmount ?? row.movementValue ?? row.valueImpact ?? row.wastageValue ?? row.transferValue ?? '',
      vat: row.vat ?? row.vatAmount ?? row.taxAmount ?? '',
      amountInclVat: row.amountInclVat ?? row.grossAmount ?? '',
      source: row.source || row.sourceType || row.wastageSource || row.adjustmentType || row.direction || '',
      sourceId: row.sourceId || ''
    };
    return mapRowToExport(mapped, ACCOUNTING_EXPORT_COLUMNS, result, { formatted });
  });
}

export function getExportColumns(result = {}) {
  const configured = resolveConfiguredExportColumns(result.report?.exportColumns, result.view);
  const columns = configured.length ? configured : toArray(result.columns);
  return columns
    .map(normalizeExportColumn)
    .filter((column) => column.key && column.exportable !== false && !UI_ONLY_KEYS.has(column.key));
}

export function getExportHeader(result = {}, column = {}) {
  return result.exportMapping?.[column.key] || column.exportLabel || column.label || column.key;
}

export function normalizeExportValue(value, column = {}, context = {}) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.every(isPrimitiveExportValue) ? value.map(text).filter(Boolean).join('; ') : '';
  if (typeof value === 'object') return '';

  const formatted = context.formatted !== false;
  if (!formatted) return value;

  const key = text(column.key);
  const type = resolveExportType(column, value);

  if (type === 'money') return formatExportMoney(value);
  if (type === 'number') return formatExportNumber(value);
  if (type === 'percent') return formatExportPercent(value);
  if (type === 'date') return formatExportDate(value);
  if (type === 'datetime') return formatExportDateTime(value, context.result?.meta?.timeZone || context.result?.meta?.timezone);
  if (type === 'time') return formatExportTime(value, context.result?.meta?.timeZone || context.result?.meta?.timezone);
  if (type === 'qty') return formatExportQuantity(value, context.row?.baseUom || context.row?.uom || context.row?.unit);
  if (!column.type && MONEY_KEY_PATTERN.test(key) && isNumericLike(value)) return formatExportMoney(value);
  return String(value);
}

export function buildExportFileName(result = {}, extension = 'csv', { workspaceName } = {}) {
  const reportType = result.report?.title || result.report?.exportFileNameBase || result.report?.id || result.id || 'Report';
  const view = slugify(result.view);
  const includeView = shouldIncludeViewInFileName(result.report, result.view);
  const dateRange = buildDateRangeSlug(result.filters || {});
  const filename = buildExportFilename({
    workspaceName,
    reportType,
    suffix: includeView && view ? view : '',
    date: dateRange
  });
  return `${filename}.${extension}`;
}

function mapRowToExport(row = {}, columns = [], result = {}, { formatted = true } = {}) {
  return columns.reduce((mapped, column) => {
    const header = getExportHeader(result, column);
    mapped[header] = normalizeExportValue(resolveExportValue(row, column), column, { row, result, formatted });
    return mapped;
  }, {});
}

function resolveConfiguredExportColumns(configured, view = '') {
  if (!configured) return [];
  if (Array.isArray(configured)) return configured;
  if (Array.isArray(configured?.[view])) return configured[view];
  if (Array.isArray(configured?.default)) return configured.default;
  return [];
}

function normalizeExportColumn(column) {
  if (typeof column === 'string') return { key: column, label: column };
  return column || {};
}

function resolveExportValue(row = {}, column = {}) {
  if (typeof column.value === 'function') return column.value(row);
  if (typeof column.getExportValue === 'function') return column.getExportValue(row);
  if (Object.prototype.hasOwnProperty.call(row, column.key)) return row[column.key];
  for (const alias of toArray(column.aliases)) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) return row[alias];
  }
  return '';
}

function resolveExportType(column = {}, value) {
  if (column.exportType) return column.exportType;
  if (column.type === 'money' || column.type === 'currency') return 'money';
  if (column.type === 'number') return 'number';
  if (column.type === 'percent') return 'percent';
  if (column.type === 'date') return 'date';
  if (column.type === 'datetime') return 'datetime';
  if (column.type === 'time') return 'time';
  if (column.type === 'qty' || column.type === 'quantity') return 'qty';
  if (typeof value === 'number') return 'number';
  return '';
}

function formatExportMoney(value) {
  return safeNumber(value).toFixed(2);
}

function formatExportNumber(value) {
  return trimTrailingZeros(safeNumber(value).toFixed(6));
}

function formatExportQuantity(value, unit = '') {
  const qty = formatExportNumber(value);
  const suffix = text(unit);
  return suffix ? `${qty} ${suffix}` : qty;
}

function formatExportPercent(value) {
  return `${trimTrailingZeros((safeNumber(value) * 100).toFixed(4))}%`;
}

function formatExportDate(value) {
  const raw = text(value);
  if (!raw) return '';
  const datePart = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : formatCell(value, { type: 'date' });
}

function formatExportDateTime(value, timeZone = '') {
  const raw = text(value);
  if (!raw) return '';
  const local = zonedDateTimeStrings(raw, timeZone || undefined);
  return local.dateTime ? local.dateTime.slice(0, 16) : raw;
}

function formatExportTime(value, timeZone = '') {
  const raw = text(value);
  if (!raw) return '';
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(raw)) return raw.slice(0, 5);
  const local = zonedDateTimeStrings(raw, timeZone || undefined);
  return local.time ? local.time.slice(0, 5) : raw;
}

function trimTrailingZeros(value = '') {
  return String(value).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

function slugify(value) {
  return text(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function shouldIncludeViewInFileName(report = {}, view = '') {
  const normalizedView = text(view);
  if (!normalizedView || normalizedView === 'summary' || normalizedView === 'ledger') return false;
  if (report?.id === 'operations_dashboard' && normalizedView === 'overview') return true;
  return normalizedView !== text(report?.defaultView || '');
}

function buildDateRangeSlug(filters = {}) {
  const start = text(filters.startDate || filters.dateFrom || filters.from);
  const end = text(filters.endDate || filters.dateTo || filters.to);
  if (start && end) return `${start}-to-${end}`;
  if (start) return `from-${start}`;
  if (end) return `to-${end}`;
  return '';
}

function isPrimitiveExportValue(value) {
  return ['string', 'number', 'boolean'].includes(typeof value) || value === null || value === undefined;
}

function isNumericLike(value) {
  return value !== '' && Number.isFinite(Number(value));
}

function buildAccountingDescription(row = {}) {
  return [
    row.itemName || row.item || row.category,
    row.movementType || row.wastageSource || row.adjustmentType || row.direction,
    row.locationName || row.location
  ].map(text).filter(Boolean).join(' - ');
}
