import { formatDateTime } from '../engine/formatters.js';
import { text } from '../engine/grouping.js';
import {
  buildExportFileName,
  getExportColumns,
  getExportHeader,
  mapReportRowsForExport,
  mapReportTotalsForExport
} from './exportMappers.js';
import { drawKcpPdfTopAccent, KCP_PDF_THEME, kcpPdfTableTheme } from '../../../utils/pdfTheme.js';


function pdfTableLayoutForColumns(columnCount = 0) {
  const count = Number(columnCount || 0) || 0;
  return {
    showHead: 'everyPage',
    tableWidth: 'auto',
    rowPageBreak: 'avoid',
    horizontalPageBreak: count > 7,
    horizontalPageBreakRepeat: count > 3 ? 0 : undefined,
    horizontalPageBreakBehaviour: 'afterAllRows',
    styles: {
      font: 'helvetica',
      fontSize: count > 14 ? 6.2 : count > 10 ? 6.8 : 7,
      cellPadding: count > 14 ? 3 : 4,
      overflow: 'linebreak',
      valign: 'top',
      minCellHeight: count > 14 ? 15 : 18,
      textColor: KCP_PDF_THEME.text,
      lineColor: KCP_PDF_THEME.border,
      lineWidth: 0.35
    }
  };
}

function buildReportPdfColumnStyles(headers = []) {
  return (Array.isArray(headers) ? headers : []).reduce((styles, header, index) => {
    const label = String(header || '').toLowerCase();
    if (/qty|cost|amount|total|value|vat|gross|net|variance|percent|movement|price|count/.test(label)) {
      styles[index] = { halign: 'right' };
    }
    if (/item|description|notes|source|document/.test(label)) {
      styles[index] = { ...(styles[index] || {}), cellWidth: 'wrap' };
    }
    return styles;
  }, {});
}

export async function reportToPdfDocument(result = {}, options = {}) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);
  const doc = new jsPDF({ orientation: options.orientation || 'landscape', unit: 'pt', format: 'a4' });
  const autoTable = autoTableModule.default || autoTableModule.autoTable;
  await appendReportPdfSection(doc, autoTable, result, options);
  return doc;
}

export async function reportResultsToPdfDocument(results = [], options = {}) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);
  const doc = new jsPDF({ orientation: options.orientation || 'landscape', unit: 'pt', format: 'a4' });
  const autoTable = autoTableModule.default || autoTableModule.autoTable;
  const safeResults = (Array.isArray(results) ? results : [results]).filter(Boolean);
  if (!safeResults.length) safeResults.push({ title: 'Report', rows: [], report: { title: 'Report' } });
  for (let index = 0; index < safeResults.length; index += 1) {
    if (index > 0) doc.addPage();
    await appendReportPdfSection(doc, autoTable, safeResults[index], options);
  }
  const first = safeResults[0] || {};
  const title = text(options.title || first.title || first.report?.title || 'Report');
  doc.setProperties({
    title,
    subject: `${title} - combined report views`,
    creator: 'Kitchen Cost Pro Reporting'
  });
  return doc;
}

async function appendReportPdfSection(doc, autoTable, result = {}, options = {}) {
  const formatted = options.formatted !== false;
  const columns = getExportColumns(result);
  const headers = columns.map((column) => getExportHeader(result, column));
  const rows = mapReportRowsForExport(result, { formatted });
  const totalRow = options.includeTotals === false ? null : mapReportTotalsForExport(result, { formatted });
  const exportRows = totalRow ? [...rows, totalRow] : rows;
  const body = exportRows.length
    ? exportRows.map((row) => headers.map((header) => pdfCell(row[header])))
    : [headers.length
      ? headers.map((_, index) => index === 0 ? 'No rows for the selected filters. Totals are zero where applicable.' : '')
      : ['No rows for the selected filters. Totals are zero where applicable.']];
  const safeHeaders = headers.length ? headers : ['Report'];
  const warnings = (result.warnings || []).filter(Boolean);
  const reportTitle = text(result.title || result.report?.title || 'Report');
  const viewLabel = text(result.view || result.report?.defaultView || 'default').replace(/_/g, ' ');
  const generatedAt = formatDateTime(result.generatedAt || new Date().toISOString(), { timeZone: result.meta?.timeZone || result.meta?.timezone });
  const subtitle = [
    `View: ${viewLabel}`,
    `Generated: ${generatedAt}`,
    `Rows: ${(result.rows || []).length}`
  ].join('  |  ');

  const header = await drawReportPdfHeader(doc, {
    title: reportTitle,
    subtitle,
    description: result.report?.description || '',
    branding: options.branding || result.branding || {}
  });

  const startY = header.tableStartY;
  const layout = pdfTableLayoutForColumns(safeHeaders.length);
  const tableTheme = kcpPdfTableTheme();
  const tableOptions = {
    ...layout,
    startY,
    head: [safeHeaders],
    body,
    styles: { ...layout.styles, ...tableTheme.styles },
    headStyles: tableTheme.headStyles,
    bodyStyles: tableTheme.bodyStyles,
    alternateRowStyles: tableTheme.alternateRowStyles,
    columnStyles: buildReportPdfColumnStyles(safeHeaders),
    margin: { left: 28, right: 28 },
    didDrawPage: () => {
      const currentPage = doc.internal.getCurrentPageInfo?.().pageNumber || doc.internal.getNumberOfPages();
      doc.setFontSize(7);
      doc.setTextColor(...KCP_PDF_THEME.muted);
      doc.text(`Page ${currentPage}`, doc.internal.pageSize.getWidth() - 68, doc.internal.pageSize.getHeight() - 18);
    }
  };

  if (typeof autoTable === 'function') autoTable(doc, tableOptions);
  else if (typeof doc.autoTable === 'function') doc.autoTable(tableOptions);

  const finalY = Number(doc.lastAutoTable?.finalY || startY) + 18;
  if (warnings.length) {
    const pageHeight = doc.internal.pageSize.getHeight();
    if (finalY > pageHeight - 90) doc.addPage();
    const warningY = finalY > pageHeight - 90 ? 36 : finalY;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...KCP_PDF_THEME.navy);
    doc.text('Warnings', 36, warningY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...KCP_PDF_THEME.text);
    const warningLines = warnings.slice(0, 12).map((warning) => `${text(warning.level || 'warning').toUpperCase()}: ${text(warning.message || warning.code || 'Report warning')}`);
    doc.text(doc.splitTextToSize(warningLines.join('\n'), 760), 36, warningY + 14);
  }
}

export async function reportToPdfBytes(result = {}, options = {}) {
  const doc = await reportToPdfDocument(result, options);
  const buffer = doc.output('arraybuffer');
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

export async function reportResultsToPdfBytes(results = [], options = {}) {
  const doc = await reportResultsToPdfDocument(results, options);
  const buffer = doc.output('arraybuffer');
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

export async function downloadReportPdf(result = {}, options = {}) {
  const doc = await reportToPdfDocument(result, options);
  const fileName = options.fileName || buildExportFileName(result, 'pdf', { workspaceName: options.workspaceName || options.branding?.companyName });
  const blob = doc.output('blob');
  triggerDownload(blob, fileName);
  return { fileName, document: doc };
}

export async function drawReportPdfHeader(doc, { title = 'Report', subtitle = '', description = '', branding = {} } = {}) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const left = 36;
  let textRight = pageWidth - 36;
  drawKcpPdfTopAccent(doc);
  const logo = await resolveReportPdfLogo(branding.logoDataUrl || branding.restaurantLogoDataUrl || '');
  if (logo?.dataUrl) {
    const maxWidth = 96;
    const maxHeight = 52;
    const ratio = Math.min(maxWidth / logo.width, maxHeight / logo.height, 1);
    const width = logo.width * ratio;
    const height = logo.height * ratio;
    const x = pageWidth - 36 - width;
    try {
      doc.addImage(logo.dataUrl, logo.format, x, 28, width, height);
      textRight = x - 18;
    } catch {
      textRight = pageWidth - 36;
    }
  }
  const maxWidth = Math.max(320, textRight - left);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(...KCP_PDF_THEME.navy);
  doc.text(String(title || 'Report'), left, 38, { maxWidth });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...KCP_PDF_THEME.text);
  if (subtitle) doc.text(String(subtitle), left, 56, { maxWidth });
  let ruleY = 74;
  if (description) {
    const lines = doc.splitTextToSize(text(description), maxWidth);
    doc.text(lines, left, 72, { maxWidth, lineHeightFactor: 1.15 });
    ruleY = 78 + Math.min(3, lines.length) * 10;
  }
  if (branding.companyName) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...KCP_PDF_THEME.muted);
    doc.text(String(branding.companyName), left, ruleY, { maxWidth });
    ruleY += 10;
  }
  doc.setDrawColor(...KCP_PDF_THEME.accent);
  doc.setLineWidth(1.2);
  doc.line(left, ruleY, pageWidth - 36, ruleY);
  return { tableStartY: ruleY + 14 };
}

async function resolveReportPdfLogo(logoDataUrl = '') {
  const value = String(logoDataUrl || '').trim();
  if (!value || !value.startsWith('data:image/')) return null;
  const mime = value.slice(5, value.indexOf(';')).toLowerCase();
  const image = await loadReportImage(value).catch(() => null);
  if (!image) return null;
  if (mime.includes('png')) return { dataUrl: value, format: 'PNG', width: image.width || 1, height: image.height || 1 };
  if (mime.includes('jpeg') || mime.includes('jpg')) return { dataUrl: value, format: 'JPEG', width: image.width || 1, height: image.height || 1 };
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    const scale = 4;
    canvas.width = Math.max(1, Math.round((image.width || 160) * scale));
    canvas.height = Math.max(1, Math.round((image.height || 90) * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/png'), format: 'PNG', width: image.width || canvas.width, height: image.height || canvas.height };
  }
  return null;
}

function loadReportImage(src) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('Images are not available in this environment.'));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function pdfCell(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  return raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
