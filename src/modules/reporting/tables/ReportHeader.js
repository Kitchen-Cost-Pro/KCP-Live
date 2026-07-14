import { escapeHtml, formatDateTime } from '../engine/formatters.js';
import { formatViewLabel } from './ReportDrilldownTabs.js';

const DATE_LABELS = {
  today: 'Today', yesterday: 'Yesterday', this_week: 'This Week', last_week: 'Last Week',
  this_month: 'This Month', last_month: 'Last Month', last_7_days: 'Last 7 Days',
  last_30_days: 'Last 30 Days', custom: 'Custom Range'
};

export function renderReportHeader(result = {}, options = {}) {
  const header = document.createElement('header');
  header.className = 'reportHeader reportHeader--compact';
  const report = result.report || {};
  const filters = options.filters || {};
  const viewLabel = formatViewLabel(result.view || report.defaultView || 'ledger');
  const dateLabel = formatDateRange(filters);
  const locationLabel = String(filters.locationName || options.locationName || '').trim() || 'All Locations';
  const rowCount = Array.isArray(result.rows) ? result.rows.length : 0;
  const canExport = options.canExport !== false;
  const timeZone = result.meta?.timeZone || result.meta?.timezone || result.rows?.find?.((row) => row?.__apiMeta?.timeZone || row?.__apiMeta?.timezone)?.__apiMeta?.timeZone || result.rows?.find?.((row) => row?.__apiMeta?.timezone)?.__apiMeta?.timezone || options.timeZone || options.timezone || 'Africa/Johannesburg';
  header.innerHTML = `
    <div class="reportHeader__summary">
      <div class="reportHeader__titleLine">
        <p class="reportHeader__eyebrow">${escapeHtml(report.section || result.section || 'Reporting')}</p>
        <h1>${escapeHtml(result.title || report.title || 'Report')}</h1>
      </div>
      <div class="reportHeader__quickSummary" aria-label="Current report summary">
        <span><strong>View</strong>${escapeHtml(viewLabel)}</span>
        <span><strong>Period</strong>${escapeHtml(dateLabel)}</span>
        <span><strong>Location</strong>${escapeHtml(locationLabel)}</span>
        <span><strong>Rows</strong>${escapeHtml(String(rowCount))}</span>
        <span class="reportHeader__generated"><strong>Updated</strong>${escapeHtml(formatDateTime(result.generatedAt || new Date().toISOString(), { timeZone }))}</span>
      </div>
    </div>
    <div class="reportHeader__actions">
      ${options.showRefresh === false ? '' : '<button type="button" class="reportHeader__refresh" data-report-refresh>Refresh</button>'}
      <details class="reportActionMenu">
        <summary class="reportActionMenu__trigger" role="button" aria-label="Open report actions">
          <span>Actions</span>
          <span class="reportActionMenu__chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="reportActionMenu__panel" popover="manual" role="menu" aria-label="Report actions">
          ${canExport ? `
            <section class="reportActionMenu__section reportActionMenu__exports">
              <header><span>Export</span><strong>Current report</strong></header>
              <button type="button" role="menuitem" data-report-export="csv"><span aria-hidden="true">CSV</span><strong>Export CSV</strong></button>
              <button type="button" role="menuitem" data-report-export="xlsx"><span aria-hidden="true">XLSX</span><strong>Export Excel</strong></button>
              <button type="button" role="menuitem" data-report-export="pdf"><span aria-hidden="true">PDF</span><strong>Export PDF</strong></button>
              ${report.allowAllViewsExport === false ? '' : '<button type="button" role="menuitem" data-report-export="all-xlsx"><span aria-hidden="true">ALL</span><strong>All Views Excel</strong></button>'}
            </section>
          ` : ''}
          <div class="reportActionMenu__custom" data-report-actions-custom></div>
        </div>
      </details>
    </div>
  `;
  return header;
}

function formatDateRange(filters = {}) {
  const type = String(filters.dateRangeType || '').trim();
  if (type && type !== 'custom') return DATE_LABELS[type] || type.replaceAll('_', ' ');
  const from = String(filters.startDate || filters.from || filters.dateFrom || '').trim();
  const to = String(filters.endDate || filters.to || filters.dateTo || '').trim();
  if (from && to) return `${from} to ${to}`;
  if (from || to) return from || to;
  return DATE_LABELS[type] || 'All Dates';
}
