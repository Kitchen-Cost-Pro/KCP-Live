import { escapeHtml } from '../engine/formatters.js';

export const REPORT_PAGE_SIZES = Object.freeze([25, 50, 100]);

export function normalizeReportPageSize(value, fallback = 25) {
  const parsed = Number(value);
  return REPORT_PAGE_SIZES.includes(parsed) ? parsed : fallback;
}

export function paginateReportRows(rows = [], page = 1, pageSize = 25) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const normalizedPageSize = normalizeReportPageSize(pageSize);
  const pageCount = Math.max(1, Math.ceil(sourceRows.length / normalizedPageSize));
  const normalizedPage = Math.min(pageCount, Math.max(1, Math.floor(Number(page) || 1)));
  const startIndex = sourceRows.length ? (normalizedPage - 1) * normalizedPageSize : 0;
  const endIndex = Math.min(sourceRows.length, startIndex + normalizedPageSize);
  return {
    rows: sourceRows.slice(startIndex, endIndex),
    page: normalizedPage,
    pageSize: normalizedPageSize,
    pageCount,
    totalRows: sourceRows.length,
    startRow: sourceRows.length ? startIndex + 1 : 0,
    endRow: endIndex
  };
}

export function renderReportPagination(pagination = {}) {
  const model = paginateReportRows(
    new Array(Math.max(0, Number(pagination.totalRows) || 0)),
    pagination.page,
    pagination.pageSize
  );
  const wrapper = document.createElement('div');
  wrapper.className = 'reportPagination';
  wrapper.setAttribute('aria-label', 'Report pagination');
  wrapper.innerHTML = `
    <div class="reportPagination__summary">
      <strong>${escapeHtml(model.startRow)}-${escapeHtml(model.endRow)}</strong> of
      <strong>${escapeHtml(model.totalRows.toLocaleString('en-ZA'))}</strong> rows
      <span>Totals and exports include all filtered rows.</span>
    </div>
    <div class="reportPagination__controls">
      <label class="reportPagination__pageSize">
        <span>Rows per page</span>
        <select data-report-page-size aria-label="Rows per page">
          ${REPORT_PAGE_SIZES.map((size) => `<option value="${size}" ${size === model.pageSize ? 'selected' : ''}>${size}</option>`).join('')}
        </select>
      </label>
      <button type="button" data-report-page="first" ${model.page <= 1 ? 'disabled' : ''} aria-label="First page">«</button>
      <button type="button" data-report-page="previous" ${model.page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
      <span class="reportPagination__pageStatus">Page <strong>${model.page}</strong> of <strong>${model.pageCount}</strong></span>
      <button type="button" data-report-page="next" ${model.page >= model.pageCount ? 'disabled' : ''} aria-label="Next page">›</button>
      <button type="button" data-report-page="last" ${model.page >= model.pageCount ? 'disabled' : ''} aria-label="Last page">»</button>
    </div>
  `;
  return wrapper;
}
