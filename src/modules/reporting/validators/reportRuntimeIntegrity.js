import { safeNumber } from '../engine/calculations.js';
import { text, toArray } from '../engine/grouping.js';
import { getExportColumns, mapReportRowsForExport } from '../exports/exportMappers.js';

const MONEY_TOLERANCE = 0.000001;
const MONEY_KEY_PATTERN = /(amount|cost|value|vat|price|sales|purchase|wastage|variance|gross|net|total)$/i;

export function validateReportRuntimeIntegrity(result = {}) {
  const warnings = [];
  const rows = toArray(result.rows);
  const meta = result.meta || {};

  if (meta.truncated === true || meta.hasMore === true) {
    warnings.push({
      code: 'report-source-incomplete',
      level: 'critical',
      message: 'The report source is incomplete. Refine the filters before relying on totals or exports.'
    });
  }

  const expectedTotal = finiteOrNull(meta.total ?? meta.totalRows ?? meta.totalCount);
  if (expectedTotal !== null && expectedTotal > rows.length && meta.allPagesLoaded !== true) {
    warnings.push({
      code: 'report-row-count-mismatch',
      level: 'critical',
      message: `The report loaded ${rows.length} of ${expectedTotal} source row(s).`
    });
  }

  const duplicateIds = findDuplicateRowIds(rows);
  if (duplicateIds.length) {
    warnings.push({
      code: 'duplicate-report-rows',
      level: 'critical',
      message: `${duplicateIds.length} duplicate report row id(s) were detected.`,
      details: { ids: duplicateIds.slice(0, 20) }
    });
  }

  const invalidMoneyCells = findInvalidMoneyCells(rows, result.columns);
  if (invalidMoneyCells.length) {
    warnings.push({
      code: 'invalid-report-money-values',
      level: 'critical',
      message: `${invalidMoneyCells.length} report money value(s) are not finite numbers.`,
      details: { cells: invalidMoneyCells.slice(0, 20) }
    });
  }

  const missingLocations = rows.filter((row) => text(row.locationId) && !text(row.locationName || row.location));
  if (missingLocations.length) {
    warnings.push({
      code: 'report-location-name-missing',
      level: 'warning',
      message: `${missingLocations.length} row(s) have a location id but no customer-readable location name.`
    });
  }

  const exportProblems = validateExportParity(result);
  warnings.push(...exportProblems);
  return warnings;
}

export function validateExportParity(result = {}) {
  const rows = toArray(result.rows);
  const columns = getExportColumns(result);
  if (!rows.length || !columns.length) return [];

  const exported = mapReportRowsForExport(result, { formatted: false });
  const warnings = [];
  if (exported.length !== rows.length) {
    warnings.push({
      code: 'report-export-row-count-mismatch',
      level: 'critical',
      message: `The export contains ${exported.length} row(s), but the report contains ${rows.length}.`
    });
  }

  const expectedHeaders = columns.map((column) => result.exportMapping?.[column.key] || column.exportLabel || column.label || column.key);
  const actualHeaders = Object.keys(exported[0] || {});
  const missingHeaders = expectedHeaders.filter((header) => !actualHeaders.includes(header));
  if (missingHeaders.length) {
    warnings.push({
      code: 'report-export-column-mismatch',
      level: 'critical',
      message: `The export is missing column(s): ${missingHeaders.join(', ')}.`
    });
  }
  return warnings;
}

function findDuplicateRowIds(rows = []) {
  const seen = new Set();
  const duplicates = new Set();
  rows.forEach((row) => {
    const id = text(row?.id);
    if (!id) return;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  });
  return [...duplicates];
}

function findInvalidMoneyCells(rows = [], columns = []) {
  const moneyKeys = toArray(columns)
    .filter((column) => column?.type === 'money' || column?.type === 'currency' || MONEY_KEY_PATTERN.test(text(column?.key)))
    .map((column) => text(column.key))
    .filter(Boolean);
  const invalid = [];
  rows.forEach((row, rowIndex) => {
    moneyKeys.forEach((key) => {
      const value = row?.[key];
      if (value === '' || value === null || value === undefined) return;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || Math.abs(numeric - safeNumber(value)) > MONEY_TOLERANCE) {
        invalid.push({ rowIndex, rowId: text(row?.id), key, value });
      }
    });
  });
  return invalid;
}

function finiteOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
