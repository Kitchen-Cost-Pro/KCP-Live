import { text, toArray } from '../engine/grouping.js';

export function validateReportDefinition(report = {}) {
  const errors = [];
  if (!text(report.id)) errors.push('Report id is required.');
  if (!text(report.title)) errors.push(`Report ${report.id || 'unknown'} needs a title.`);
  if (!text(report.section)) errors.push(`Report ${report.id || 'unknown'} needs a section.`);
  if (!text(report.defaultView)) errors.push(`Report ${report.id || 'unknown'} needs a defaultView.`);
  if (!Array.isArray(report.availableViews) || !report.availableViews.length) errors.push(`Report ${report.id || 'unknown'} needs availableViews.`);
  if (typeof report.getRows !== 'function') errors.push(`Report ${report.id || 'unknown'} needs a getRows function.`);
  if (typeof report.getTotals !== 'function') errors.push(`Report ${report.id || 'unknown'} needs a getTotals function.`);
  if (typeof report.validate !== 'function') errors.push(`Report ${report.id || 'unknown'} needs a validate function.`);
  if (!report.columns || typeof report.columns !== 'object' || Array.isArray(report.columns)) {
    errors.push(`Report ${report.id || 'unknown'} needs columns keyed by view.`);
  } else {
    const missingColumns = toArray(report.availableViews).filter((view) => !Array.isArray(report.columns[view]) || report.columns[view].length === 0);
    if (missingColumns.length) errors.push(`Report ${report.id || 'unknown'} has missing columns for view(s): ${missingColumns.join(', ')}.`);
  }
  if (!report.exportMapping || typeof report.exportMapping !== 'object' || Array.isArray(report.exportMapping)) {
    errors.push(`Report ${report.id || 'unknown'} needs an exportMapping object.`);
  }
  return errors;
}

export function getReportColumns(report = {}, view = '') {
  const activeView = text(view || report.defaultView || toArray(report.availableViews)[0]);
  return toArray(report.columns?.[activeView]);
}

export function validateReportResult(result = {}) {
  const warnings = [];
  const rows = toArray(result.rows);
  const columns = toArray(result.columns);
  const columnKeys = new Set(columns.map((column) => text(column.key)).filter(Boolean));

  if (!rows.length && result.report?.suppressEmptyWarning !== true) {
    warnings.push({ code: 'empty-report', level: 'info', message: 'No rows matched the selected filters.' });
  }

  const missingColumnKeys = columns.filter((column) => !text(column.key));
  if (missingColumnKeys.length) {
    warnings.push({ code: 'bad-columns', level: 'warning', message: `${missingColumnKeys.length} column(s) are missing keys.` });
  }

  if (columnKeys.size) {
    const rowsWithNoMatchingValues = rows.filter((row) => !Array.from(columnKeys).some((key) => row[key] !== undefined && row[key] !== null && row[key] !== ''));
    if (rowsWithNoMatchingValues.length) {
      warnings.push({ code: 'unmapped-rows', level: 'warning', message: `${rowsWithNoMatchingValues.length} row(s) do not map to the report columns.` });
    }
  }

  return warnings;
}

export function assertValidReport(report = {}) {
  const errors = validateReportDefinition(report);
  if (errors.length) {
    throw new Error(errors.join(' '));
  }
}
