import { listReports, resolveReportRoute, normalizeSectionId } from './reports/index.js';
import { renderReportViewer } from './ReportViewer.js';
import { escapeHtml } from './engine/formatters.js';
import { bindReportTooltips } from './tooltips/tooltipBuilder.js';
import { normalizeReportTimeZone, normalizeTradingDayStartMinutes } from './engine/timezone.js';
// Not imported here: this module is imported directly by several plain-Node unit tests, which
// (unlike the real Vite build) can't process a .css import at all. reporting.css follows the same
// pattern — see main.js, which is where reportingHub.css is imported instead.

// One accent per report category — drives the section dot, the card's left accent rail, and the
// hover glow. Applied as inline CSS custom properties (see renderReportSection/renderMiniReportTile)
// rather than one CSS rule per category, so adding/renaming a category never needs a matching CSS
// selector anywhere else.
const CATEGORY_ACCENTS = {
  sales: '#a3e635',
  operations: '#fb923c',
  inventory: '#22d3ee',
  advanced: '#a78bfa'
};
const DEFAULT_ACCENT = '#8b93a3';

// Lucide icon path data (ISC-licensed, https://lucide.dev), inlined as raw SVG rather than pulled
// in via the lucide-react package — this app is vanilla JS, not React, and this is a small fixed
// set of icons, so inlining avoids a dependency whose primary export (React components) this
// codebase can't use anyway. Every entry is the exact <path>/<rect>/<circle> markup Lucide ships
// for that icon, at its default stroke-width of 2, so redrawing them here can never drift from the
// real icon set.
const REPORT_ICON_PATHS = {
  sales_reports: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  modifier_report: '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
  menu_recipe_health: '<path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"/><path d="M6 17h12"/>',
  inventory_audit: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  operations_dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  detailed_activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  wastage: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  stock_take_audit: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  adjustments: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  stock_transfers: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  manufacturing_transactions: '<path d="M12 16h.01"/><path d="M16 16h.01"/><path d="M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a.5.5 0 0 0-.769-.422l-4.462 2.844A.5.5 0 0 1 15 10.5v-2a.5.5 0 0 0-.769-.422L9.77 10.922A.5.5 0 0 1 9 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"/><path d="M8 16h.01"/>',
  stock_control: '<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/>',
  stock_on_hand: '<path d="M12 22V12"/><path d="M20.27 18.27 22 20"/><path d="M21 10.498V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.98-.559"/><path d="M3.29 7 12 12l8.71-5"/><path d="m7.5 4.27 8.997 5.148"/><circle cx="18.5" cy="16.5" r="2.5"/>',
  purchase_orders_report: '<path d="m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18"/><path d="M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25"/><circle cx="18" cy="20" r="2"/><circle cx="8" cy="20" r="2"/>',
  grv_log: '<path d="M12 22V12"/><path d="m16 17 2 2 4-4"/><path d="M21 11.127V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.32-.753"/><path d="M3.29 7 12 12l8.71-5"/><path d="m7.5 4.27 8.997 5.148"/>',
  credit_notes_report: '<path d="M20 14V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M14 18h6"/>',
  stock_out_forecast: '<path d="M16 17h6v-6"/><path d="m22 17-8.5-8.5-5 5L2 7"/>',
  price_volatility_analysis: '<path d="M9 5v4"/><rect width="4" height="6" x="7" y="9" rx="1"/><path d="M9 15v2"/><path d="M17 3v2"/><rect width="4" height="8" x="15" y="5" rx="1"/><path d="M17 13v3"/><path d="M3 3v16a2 2 0 0 0 2 2h16"/>',
  theoretical_vs_actual: '<path d="M12 3v18"/><path d="m19 8 3 8a5 5 0 0 1-6 0zV7"/><path d="M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1"/><path d="m5 8 3 8a5 5 0 0 1-6 0zV7"/><path d="M7 21h10"/>'
};
const REPORT_ICON_FALLBACK = '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 9h6v6H9z"/>';
const ARROW_RIGHT_ICON_PATH = '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>';

function svgIcon(pathMarkup) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathMarkup}</svg>`;
}

const SECTION_DEFINITIONS = [
  {
    id: 'sales',
    title: 'Sales',
    description: 'YOCO payment, sales, stock movement, and modifier performance reports.'
  },
  {
    id: 'operations',
    title: 'Operations',
    description: 'Activity, wastage, stock takes, adjustments, transfers, menu health, and inventory audit.'
  },
  {
    id: 'inventory',
    title: 'Inventory',
    sourceSections: ['stock_control', 'inventory', 'purchasing'],
    description: 'Stock control, stock on hand, purchase orders, goods received, and supplier credit reports.'
  },
  {
    id: 'advanced',
    title: 'Advanced',
    description: 'Forecasting, volatility, theoretical usage, variance, and risk analysis.'
  },
  {
    id: 'audit',
    title: 'Audit',
    description: 'Standalone audit reports if any are registered outside operations.'
  }
];

export function renderReportingDashboard({
  sourceData = {},
  state = null,
  initialReportId = '',
  services = {},
  workspaceId = '',
  onRefresh
} = {}) {
  const root = document.createElement('section');
  root.className = 'reportingDashboard reportingDashboard--home reportingDashboard--miniBentoHome';
  const reports = listReports();
  const sourceState = state || sourceData || {};
  // appState.settings is a state WRAPPER ({ status, values, draft, ... }), not the settings fields
  // themselves — those live one level deeper, at .values/.draft (see createSettingsState in
  // main.js). Reading sourceState.settings directly here meant every date-range preset ("Today",
  // "This Week", ...) was silently resolved with tradingDayStartMinutes always 0 and the default
  // timezone, regardless of the workspace's real configured values — the SAME settings object the
  // backend correctly reads, just one property too shallow.
  const settingsValues = sourceState?.settings?.values || sourceState?.settings?.draft || {};
  const datePresetContext = {
    timeZone: normalizeReportTimeZone(
      sourceState?.workspace?.timezone || settingsValues.timezone || 'Africa/Johannesburg'
    ),
    tradingDayStartMinutes: normalizeTradingDayStartMinutes(settingsValues),
  };
  const initialRoute = resolveReportRoute(initialReportId);
  let activeReportState = initialRoute
    ? {
      reportId: initialRoute.reportId,
      initialActiveReportId: initialRoute.activeReportId || '',
      initialView: initialRoute.view || '',
      allowUrlConfiguration: Boolean(initialReportId)
    }
    : null;

  bindReportTooltips(root);

  if (!initialRoute) clearReportingRouteState();

  const draw = () => {
    root.innerHTML = '';
    root.classList.toggle('reportingDashboard--report', Boolean(activeReportState?.reportId));
    root.classList.toggle('reportingDashboard--home', !activeReportState?.reportId);

    if (!activeReportState?.reportId) {
      clearReportingRouteState();
      root.append(renderReportingHome({ reports }));
      root.querySelectorAll('[data-report-open]').forEach((button) => {
        button.addEventListener('click', () => {
          const route = resolveReportRoute(button.dataset.reportOpen || '');
          if (!route) return;
          activeReportState = {
            reportId: route.reportId,
            initialActiveReportId: route.activeReportId || button.dataset.reportActive || '',
            initialView: route.view || button.dataset.reportView || '',
            allowUrlConfiguration: false
          };
          draw();
        });
      });
      return;
    }

    const report = reports.find((item) => item.id === activeReportState.reportId) || resolveReportRoute(activeReportState.reportId)?.definition;
    root.append(renderReportPageShell(report));
    const viewerSlot = root.querySelector('[data-report-viewer-slot]');
    viewerSlot?.append(renderReportViewer({
      reportId: activeReportState.reportId,
      // Pass the raw live app state (sourceState), not a pre-derived dataSet snapshot -- ReportViewer.js's
      // own draw() recomputes createReportingDataSet(state) on every reload so client-state-dependent
      // report logic (e.g. Operations Dashboard's live stock balance fallback) can pick up data that
      // arrived after this dashboard first mounted. Passing an already-derived dataSet as sourceData
      // instead would defeat that: it would itself be a frozen snapshot from a single computation, so
      // "recomputing" from it downstream would just re-read the same stale snapshot every time.
      state: sourceState,
      services,
      workspaceId,
      initialActiveReportId: activeReportState.initialActiveReportId,
      initialView: activeReportState.initialView,
      allowUrlConfiguration: activeReportState.allowUrlConfiguration === true,
      autoLoadDefault: true,
      datePresetContext,
      onRefresh
    }));
    root.querySelector('[data-report-home]')?.addEventListener('click', () => {
      activeReportState = null;
      clearReportingRouteState();
      draw();
    });
  };

  draw();
  return root;
}

function clearReportingRouteState() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  const reportKeys = [
    'report', 'view', 'from', 'to', 'startDate', 'endDate', 'dateRangeType',
    'search', 'time', 'locationId', 'category', 'source', 'sourceType',
    'paymentMethod', 'status', 'receiptNumber', 'menuCategory', 'menuItemId',
    'inventoryCategory', 'inventoryItemId', 'modifierGroupId', 'modifierType',
    'modifierName', 'stockDeductionStatus', 'yocoCategory', 'recipeStatus',
    'riskStatus', 'warningSeverity', 'supplierId', 'itemType', 'onlyCritical',
    'onlyBelowPar', 'missingSupplier', 'missingCost', 'user', 'action',
    'entityType', 'entityName'
  ];
  let changed = false;
  reportKeys.forEach((key) => {
    if (!url.searchParams.has(key)) return;
    url.searchParams.delete(key);
    changed = true;
  });
  if (changed) window.history.replaceState({}, '', url);
}

function renderReportingHome({ reports = [] } = {}) {
  const visibleSections = SECTION_DEFINITIONS
    .map((section) => ({ ...section, reports: reportsForSection(section, reports) }))
    .filter((section) => section.reports.length);
  const fragment = document.createElement('div');
  fragment.className = 'reportingHome repHub';
  fragment.innerHTML = `
    <header class="repHub__pageHead">
      <p class="repHub__eyebrow">Reporting</p>
      <h1>Reports</h1>
    </header>
    <div class="repHub__sections">
      ${visibleSections.map((section) => renderReportSection(section)).join('')}
    </div>
  `;
  return fragment;
}

function reportsForSection(section, allReports) {
  const sourceSections = new Set((section.sourceSections || [section.id]).map(normalizeSectionId));
  return allReports
    .filter((report) => sourceSections.has(normalizeSectionId(report.section || '')))
    .sort((a, b) => reportTilePriority(a.id) - reportTilePriority(b.id));
}

function reportTilePriority(reportId = '') {
  const order = {
    sales_reports: 0,
    modifier_report: 1,
    menu_recipe_health: 2,
    inventory_audit: 3,
    operations_dashboard: 4,
    detailed_activity: 5,
    wastage: 6,
    stock_take_audit: 7,
    adjustments: 8,
    stock_transfers: 9,
    manufacturing_transactions: 10,
    stock_control: 11,
    stock_on_hand: 12,
    purchase_orders_report: 13,
    grv_log: 14,
    credit_notes_report: 15,
    stock_out_forecast: 16,
    price_volatility_analysis: 17,
    theoretical_vs_actual: 18
  };
  return order[reportId] ?? 50;
}

function renderReportSection(section) {
  const accent = CATEGORY_ACCENTS[section.id] || DEFAULT_ACCENT;
  const count = section.reports.length;
  return `
    <section class="repHub__section" style="--repHub-accent:${accent}">
      <div class="repHub__sectionHead">
        <span class="repHub__dot" aria-hidden="true"></span>
        <h2>${escapeHtml(section.title)}</h2>
        <span class="repHub__sectionCount">${count} ${count === 1 ? 'report' : 'reports'}</span>
        <span class="repHub__rule" aria-hidden="true"></span>
      </div>
      <div class="repHub__grid">
        ${section.reports.map((report) => renderMiniReportTile(report, section)).join('')}
      </div>
    </section>
  `;
}

function renderMiniReportTile(report, section) {
  const isGroup = report.type === 'group' && Array.isArray(report.reports);
  const count = isGroup ? report.reports.length : viewCount(report);
  const badgeLabel = isGroup
    ? `${count} ${count === 1 ? 'report' : 'reports'}`
    : `${count} ${count === 1 ? 'view' : 'views'}`;
  const viewLabels = isGroup
    ? report.reports.map((item) => item.label || item.id)
    : (report.availableViews || [report.defaultView]).map(formatViewLabel);
  const tooltip = buildReportTooltip(report, viewLabels);
  const criticalCount = Number(report.criticalWarningCount || 0);
  const accent = CATEGORY_ACCENTS[section.id] || DEFAULT_ACCENT;
  return `
    <button
      type="button"
      class="repHubCard${criticalCount > 0 ? ' repHubCard--warning' : ''}"
      style="--repHub-accent:${accent}"
      data-report-open="${escapeHtml(report.id)}"
      data-report-tooltip="${escapeHtml(tooltip)}"
      aria-label="Open ${escapeHtml(report.title || report.id)}"
    >
      <span class="repHubCard__rail" aria-hidden="true"></span>
      <span class="repHubCard__icon" aria-hidden="true">${svgIcon(REPORT_ICON_PATHS[report.id] || REPORT_ICON_FALLBACK)}</span>
      <span class="repHubCard__body">
        <span class="repHubCard__title">${escapeHtml(report.title || report.id)}</span>
        <span class="repHubCard__badge">${escapeHtml(badgeLabel)}</span>
      </span>
      ${criticalCount > 0 ? `<span class="repHubCard__qualityDot" aria-label="${criticalCount} item issue${criticalCount === 1 ? '' : 's'}"></span>` : ''}
      <span class="repHubCard__arrow" aria-hidden="true">${svgIcon(ARROW_RIGHT_ICON_PATH)}</span>
    </button>
  `;
}

function buildReportTooltip(report = {}, viewLabels = []) {
  const parts = [];
  if (report.description) parts.push(report.description);
  if (viewLabels.length) parts.push(`Contains: ${viewLabels.join(', ')}`);
  if (report.type === 'group') parts.push('Opens with a toggle between grouped reports.');
  return parts.join('\n');
}

function viewCount(report = {}) {
  if (report.type === 'group') return Array.isArray(report.reports) ? report.reports.length : 0;
  return Array.isArray(report.availableViews) ? report.availableViews.length : (report.defaultView ? 1 : 0);
}

const REPORT_VIEW_LABEL_ACRONYMS = new Set(['uom', 'vat', 'sku', 'grv', 'po']);

function formatViewLabel(view = '') {
  return String(view || '')
    .split('_')
    .filter(Boolean)
    .map((part) => (REPORT_VIEW_LABEL_ACRONYMS.has(part.toLowerCase())
      ? part.toUpperCase()
      : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function renderReportPageShell(report = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'reportingReportPage';
  wrapper.innerHTML = `
    <div class="reportingReportPage__bar">
      <button type="button" class="reportingBackButton" data-report-home>
        <span aria-hidden="true">←</span>
        <span>Reports</span>
      </button>
      <div class="reportingReportPage__crumb">
        <span>Reporting</span>
        <span>${escapeHtml(sectionLabel(report.section || 'reports'))}</span>
        <strong>${escapeHtml(report.title || 'Report')}</strong>
      </div>
    </div>
    <div data-report-viewer-slot></div>
  `;
  return wrapper;
}

function sectionLabel(section = '') {
  const normalized = normalizeSectionId(section);
  const match = SECTION_DEFINITIONS.find((entry) => {
    const sourceSections = (entry.sourceSections || [entry.id]).map(normalizeSectionId);
    return sourceSections.includes(normalized);
  });
  return match?.title || section || 'Reports';
}

export default renderReportingDashboard;
