import { buildExportFileName, mapReportRowsForExport, mapReportTotalsForExport } from './exportMappers.js';

export async function reportToExcelWorkbook(result = {}, options = {}) {
  const XLSX = await import('xlsx');
  const formatted = options.formatted !== false;
  const rows = mapReportRowsForExport(result, { formatted });
  const totalRow = options.includeTotals === false ? null : mapReportTotalsForExport(result, { formatted });
  const exportRows = totalRow ? [...rows, totalRow] : rows;
  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(options.sheetName || result.report?.title || 'Report'));

  const criticalWarnings = (result.warnings || []).filter((warning) => warning?.level === 'critical');
  if (criticalWarnings.length) {
    const warningRows = criticalWarnings.map((warning) => ({
      Level: warning.level,
      Code: warning.code || '',
      Message: warning.message || ''
    }));
    const warningsSheet = XLSX.utils.json_to_sheet(warningRows);
    XLSX.utils.book_append_sheet(workbook, warningsSheet, 'Warnings');
  }

  return { XLSX, workbook };
}

export async function reportToExcelBytes(result = {}, options = {}) {
  const { XLSX, workbook } = await reportToExcelWorkbook(result, options);
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export async function downloadReportExcel(result = {}, options = {}) {
  const { XLSX, workbook } = await reportToExcelWorkbook(result, options);
  const fileName = options.fileName || buildExportFileName(result, 'xlsx', { workspaceName: options.workspaceName });
  XLSX.writeFile(workbook, fileName);
  return { fileName, workbook };
}

export async function reportResultsToExcelWorkbook(results = [], options = {}) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const seenNames = [];
  const safeResults = (Array.isArray(results) ? results : []).filter(Boolean);
  if (!safeResults.length) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([]), 'Report');
    return { XLSX, workbook };
  }
  safeResults.forEach((result) => {
    const formatted = options.formatted !== false;
    const rows = mapReportRowsForExport(result, { formatted });
    const totalRow = options.includeTotals === false ? null : mapReportTotalsForExport(result, { formatted });
    const exportRows = totalRow ? [...rows, totalRow] : rows;
    const worksheet = XLSX.utils.json_to_sheet(exportRows.length ? exportRows : [{ Note: 'No rows for this view. Totals are zero where applicable.' }]);
    const baseName = sanitizeSheetName(formatSheetName(result));
    const sheetName = uniqueSheetName(seenNames, baseName);
    seenNames.push(sheetName);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  });
  return { XLSX, workbook };
}

export async function reportResultsToExcelBytes(results = [], options = {}) {
  const { XLSX, workbook } = await reportResultsToExcelWorkbook(results, options);
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export async function downloadReportAllViewsExcel(results = [], options = {}) {
  const { XLSX, workbook } = await reportResultsToExcelWorkbook(results, options);
  const first = (Array.isArray(results) ? results : [results]).find(Boolean) || {};
  const fileName = options.fileName || buildExportFileName({ ...first, view: 'all_views' }, 'xlsx', { workspaceName: options.workspaceName });
  XLSX.writeFile(workbook, fileName);
  return { fileName, workbook };
}

function formatSheetName(result = {}) {
  const reportTitle = result.report?.title || result.title || result.report?.id || result.id || 'Report';
  const view = result.view ? String(result.view).replace(/_/g, ' ') : '';
  return view ? `${reportTitle} ${view}` : reportTitle;
}

function uniqueSheetName(existing = [], baseName = 'Report') {
  const cleanBase = sanitizeSheetName(baseName || 'Report') || 'Report';
  if (!existing.includes(cleanBase)) return cleanBase;
  let index = 2;
  while (existing.includes(sanitizeSheetName(`${cleanBase.slice(0, 27)} ${index}`))) index += 1;
  return sanitizeSheetName(`${cleanBase.slice(0, 27)} ${index}`);
}

function sanitizeSheetName(value = 'Report') {
  return String(value || 'Report').replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Report';
}
