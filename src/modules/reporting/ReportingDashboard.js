import { createReportingDataSet } from './engine/reportDataMapper.js';
import { listReports, resolveReportRoute, normalizeSectionId } from './reports/index.js';
import { renderReportViewer } from './ReportViewer.js';
import { escapeHtml } from './engine/formatters.js';
import { bindReportTooltips } from './tooltips/tooltipBuilder.js';
import { normalizeReportTimeZone, normalizeTradingDayStartMinutes } from './engine/timezone.js';

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
  const dataSet = createReportingDataSet(sourceState);
  const datePresetContext = {
    timeZone: normalizeReportTimeZone(
      sourceState?.workspace?.timezone || sourceState?.settings?.timezone || 'Africa/Johannesburg'
    ),
    tradingDayStartMinutes: normalizeTradingDayStartMinutes(sourceState?.settings || {}),
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
      sourceData: dataSet,
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
  fragment.className = 'reportingHome reportingHome--miniBento';
  fragment.innerHTML = `
    <header class="reportingHomeSlimHeader">
      <div>
        <p class="reportingEyebrow">Reporting</p>
        <h1>Reports</h1>
      </div>
    </header>
    <div class="reportingMiniSections">
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
  return `
    <section class="reportingMiniSection reportingMiniSection--neutral reportingMiniSection--${escapeHtml(section.id)}">
      <div class="reportingMiniSection__header">
        <h2>${escapeHtml(section.title)}</h2>
      </div>
      <div class="reportTileGrid reportTileGrid--miniBento">
        ${section.reports.map((report) => renderMiniReportTile(report, section)).join('')}
      </div>
    </section>
  `;
}

function renderMiniReportTile(report, section) {
  const subtitle = report.type === 'group' && Array.isArray(report.reports)
    ? `${report.reports.length} grouped reports`
    : `${viewCount(report)} ${viewCount(report) === 1 ? 'view' : 'views'}`;
  const viewLabels = report.type === 'group' && Array.isArray(report.reports)
    ? report.reports.map((item) => item.label || item.id)
    : (report.availableViews || [report.defaultView]).map(formatViewLabel);
  const tooltip = buildReportTooltip(report, viewLabels);
  const criticalCount = Number(report.criticalWarningCount || 0);
  return `
    <button
      type="button"
      class="reportTile reportTile--miniBento reportTile--neutral reportTile--${escapeHtml(section.id)}${criticalCount > 0 ? ' reportTile--warning' : ''}"
      data-report-open="${escapeHtml(report.id)}"
      data-report-tooltip="${escapeHtml(tooltip)}"
      aria-label="Open ${escapeHtml(report.title || report.id)}"
    >
      <span class="reportTile__icon" aria-hidden="true">${reportIcon(report.id)}</span>
      <span class="reportTile__content">
        <span class="reportTile__title">${escapeHtml(report.title || report.id)}</span>
        <span class="reportTile__meta">${escapeHtml(subtitle)}</span>
      </span>
      ${criticalCount > 0 ? `<span class="reportTile__qualityDot" title="${criticalCount} item issue${criticalCount === 1 ? '' : 's'}" aria-label="${criticalCount} item issue${criticalCount === 1 ? '' : 's'}"></span>` : ''}
      <span class="reportTile__arrow" aria-hidden="true">→</span>
    </button>
  `;
}

function reportIcon(reportId = '') {
  const icons = {
    sales_reports: '◔', modifier_report: '⌁', menu_recipe_health: '✓', inventory_audit: '≋',
    operations_dashboard: '▥', detailed_activity: '◷', wastage: '⌁', stock_take_audit: '☷',
    adjustments: '±', stock_transfers: '⇄', manufacturing_transactions: '⚙', stock_control: '▤', stock_on_hand: '▦',
    purchase_orders_report: '⌑', grv_log: '⇣', credit_notes_report: '↩',
    stock_out_forecast: '⌛', price_volatility_analysis: '↗', theoretical_vs_actual: '≈'
  };
  return icons[reportId] || '▦';
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

function formatViewLabel(view = '') {
  return String(view || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
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
