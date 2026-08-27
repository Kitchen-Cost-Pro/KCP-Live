import { toCsvSafe } from '../engine/formatters.js';
import { buildExportFileName, getExportColumns, getExportHeader, mapReportRowsForExport, mapReportTotalsForExport } from './exportMappers.js';

export function reportToCsv(result = {}, options = {}) {
  const formatted = options.formatted !== false;
  const rows = mapReportRowsForExport(result, { formatted });
  const totalRow = options.includeTotals === false ? null : mapReportTotalsForExport(result, { formatted });
  const exportRows = totalRow ? [...rows, totalRow] : rows;
  const headers = getExportColumns(result).map((column) => getExportHeader(result, column));

  return [
    headers.map(toCsvSafe).join(','),
    ...exportRows.map((row) => headers.map((header) => toCsvSafe(row[header])).join(','))
  ].join('\n');
}

export function downloadReportCsv(result = {}, options = {}) {
  const csv = reportToCsv(result, options);
  const fileName = options.fileName || buildExportFileName(result, 'csv', { workspaceName: options.workspaceName });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, fileName);
  return { fileName, csv };
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
