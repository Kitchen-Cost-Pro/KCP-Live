import '../styles/analytics.css';
import '../styles/analytics-modern.css';
import { renderLoadingPanel } from './LoadingPanel.js';
import { buildAnalyticsReport, customReportSources, reportCatalog } from '../services/analyticsService.js';
import { exportObjectRows } from '../services/exportService.js';
import { planReportConfigWithAi } from '../services/reportConfigService.js';
import { ACTION_PERMISSION_MAP, hasPermission, hasLocationAccess, normalizeRoleName } from '../services/roleService.js';
import { todayLocal } from '../utils/date.js';

const REPORT_CATEGORIES = [
  {
    id: 'inventory',
    title: 'Inventory',
    tone: 'blue',
    icon: 'box',
    description: 'Analyse stock levels, movements and inventory activity.',
    reports: ['stock', 'movement', 'low_stock', 'purchase_orders', 'grv', 'cn', 'inventory_audit']
  },
  {
    id: 'operations',
    title: 'Operations',
    tone: 'green',
    icon: 'activity',
    description: 'Monitor kitchen operations, production and activity.',
    reports: ['menu', 'missing_recipes', 'mfg', 'transfers', 'adj', 'stocktake', 'activity_log', 'ops_dashboard', 'ops_overview', 'ops_category_overview', 'ops_category_detail']
  },
  {
    id: 'sales',
    title: 'Sales',
    tone: 'teal',
    icon: 'cart',
    description: 'Track sales, payments, sync activity and POS exceptions.',
    reports: ['sale_movement', 'modifier_gp_detail', 'modifier_gp_summary', 'yoco_sales', 'sync_log', 'sales_error_log', 'payments']
  },
  {
    id: 'advanced',
    title: 'Advanced Reports',
    tone: 'purple',
    icon: 'chart',
    description: 'Forecasting, volatility, variance and custom insights.',
    reports: ['custom_report', 'forecast', 'volatility', 'variance', 'waste_pareto']
  }
];

const HUB_REPORT_GROUPS = [
  {
    id: 'inventory',
    title: 'Inventory & Purchasing',
    subtitle: 'Track inventory levels, movements, and purchasing activities.',
    tone: 'blue',
    icon: 'box',
    reports: ['stock', 'movement', 'low_stock', 'purchase_orders', 'grv', 'cn', 'inventory_audit']
  },
  {
    id: 'operations',
    title: 'Operations',
    subtitle: 'Monitor production, stock handling, and operational activities.',
    tone: 'green',
    icon: 'activity',
    reports: ['menu', 'missing_recipes', 'mfg', 'transfers', 'adj', 'stocktake', 'activity_log', 'ops_dashboard', 'ops_category_overview', 'ops_category_detail']
  },
  {
    id: 'sales',
    title: 'Sales',
    subtitle: 'Analyze sales activity, stock impact, and system sync.',
    tone: 'teal',
    icon: 'cart',
    reports: ['sale_movement', 'modifier_gp_detail', 'modifier_gp_summary', 'sync_log', 'sales_error_log', 'payments']
  },
  {
    id: 'advanced',
    title: 'Advanced Reports',
    subtitle: 'High-level insights and key reports for decision makers.',
    tone: 'purple',
    icon: 'star',
    reports: ['custom_report', 'forecast', 'volatility', 'variance', 'waste_pareto']
  }
];

const CUSTOM_REPORT_TEMPLATES = [
  {
    id: 'stock-ops',
    workflow: 'Stock',
    name: 'Stock Position by Location',
    description: 'Stock value, quantity, low-stock exposure, and location split.',
    prompt: 'Build a stock report by location and category with stock value, on hand quantity, and low stock thresholds.',
    sourceId: 'inventory',
    visualizationType: 'bar',
    groupBy: 'location',
    columns: ['Item', 'Category', 'Location', 'On Hand', 'Unit', 'UOM Config', 'Stock Value'],
    builder: {
      sourceId: 'inventory',
      visualizationType: 'bar',
      layout: {
        filters: ['inventory::Location', 'inventory::Category'],
        columns: ['inventory::Location'],
        values: ['inventory::On Hand', 'inventory::Stock Value'],
        rows: ['inventory::Category']
      },
      options: { pivotMode: true, comparePeriod: 'previous_period', drilldownEnabled: true }
    }
  },
  {
    id: 'purchasing-control',
    workflow: 'Purchasing',
    name: 'Supplier Purchasing Control',
    description: 'Purchasing by supplier, location, status, and date range.',
    prompt: 'Create a purchasing report by supplier and location with purchase orders, GRVs, totals, and status filters.',
    sourceId: 'purchase_orders',
    visualizationType: 'line',
    groupBy: 'supplier',
    columns: ['Date', 'Supplier', 'Reference', 'Status', 'Location', 'Total Ex', 'User'],
    builder: {
      sourceId: 'purchase_orders',
      visualizationType: 'line',
      layout: {
        filters: ['purchase_orders::Date', 'purchase_orders::Supplier', 'purchase_orders::Status'],
        columns: ['purchase_orders::Supplier'],
        values: ['purchase_orders::Total Ex'],
        rows: ['purchase_orders::Location']
      },
      options: { pivotMode: true, comparePeriod: 'previous_period', drilldownEnabled: true }
    }
  },
  {
    id: 'sales-performance',
    workflow: 'Sales',
    name: 'Sales Performance',
    sourceId: 'sales',
    visualizationType: 'bar',
    groupBy: 'week',
    description: 'Sales, refunds, quantities, location performance, and period comparison.',
    prompt: 'Create a sales performance report comparing this period to the previous period by location and item.',
    columns: ['Date', 'Sale / Refund', 'Item Name', 'Qty Sold', 'Total Impact', 'Location'],
    builder: {
      sourceId: 'sales',
      visualizationType: 'bar',
      layout: {
        filters: ['sales::Date', 'sales::Location'],
        columns: ['sales::Location'],
        values: ['sales::Qty Sold', 'sales::Total Impact'],
        rows: ['sales::Item Name']
      },
      options: { pivotMode: true, comparePeriod: 'previous_period', drilldownEnabled: true }
    }
  },
  {
    id: 'wastage-control',
    workflow: 'Wastage',
    name: 'High Wastage Exceptions',
    description: 'Wastage value, reason, responsible location, and threshold alerts.',
    prompt: 'Create an exception report for high wastage by item, category, location, and reason with threshold alerts.',
    sourceId: 'waste_pareto',
    visualizationType: 'bar',
    groupBy: 'category',
    columns: ['Reason', 'Category', 'Incidents', 'Loss Value', 'Share', 'Recommended Action'],
    builder: {
      sourceId: 'waste_pareto',
      visualizationType: 'bar',
      layout: {
        filters: ['waste_pareto::Reason', 'waste_pareto::Category'],
        columns: ['waste_pareto::Category'],
        values: ['waste_pareto::Loss Value', 'waste_pareto::Incidents'],
        rows: ['waste_pareto::Reason']
      },
      thresholdRules: [{ fieldId: 'waste_pareto::Loss Value', operator: 'greaterThan', value: '500', label: 'High wastage value' }],
      options: { pivotMode: true, comparePeriod: 'previous_period', drilldownEnabled: true }
    }
  },
  {
    id: 'manufacturing-yield',
    workflow: 'Manufacturing',
    name: 'Manufacturing Yield & Cost',
    description: 'Production output, expected vs actual, COGS, and wastage impact.',
    prompt: 'Create a manufacturing report showing expected output, actually made, wastage, cost, and variance by recipe.',
    sourceId: 'mfg',
    visualizationType: 'bar',
    groupBy: 'category',
    columns: ['Date', 'Preparation', 'Category', 'Expected', 'Actual', 'Value', 'Unit'],
    builder: {
      sourceId: 'mfg',
      visualizationType: 'bar',
      layout: {
        filters: ['mfg::Date', 'mfg::Category'],
        columns: ['mfg::Category'],
        values: ['mfg::Expected', 'mfg::Actual', 'mfg::Value'],
        rows: ['mfg::Preparation']
      },
      thresholdRules: [{ fieldId: 'mfg::Actual', operator: 'lessThan', value: '1', label: 'No output made' }],
      options: { pivotMode: true, comparePeriod: 'previous_period', drilldownEnabled: true }
    }
  },
  {
    id: 'missing-recipe-exception',
    workflow: 'Exception',
    name: 'Missing Recipes Exception',
    description: 'Menu items that need recipe completion before costing and margin reporting can be trusted.',
    prompt: 'Create an exception report for menu items with missing recipes by category and status.',
    sourceId: 'missing_recipes',
    visualizationType: 'table',
    groupBy: 'category',
    columns: ['Menu Item', 'Category', 'Status', 'Recipe', 'Action'],
    builder: {
      sourceId: 'missing_recipes',
      visualizationType: 'table',
      layout: {
        filters: ['missing_recipes::Status', 'missing_recipes::Category'],
        columns: ['missing_recipes::Status'],
        values: [],
        rows: ['missing_recipes::Menu Item', 'missing_recipes::Category']
      },
      thresholdRules: [{ fieldId: 'missing_recipes::Status', operator: 'contains', value: 'Missing', label: 'Missing recipe' }],
      options: { pivotMode: false, comparePeriod: '', drilldownEnabled: true }
    }
  }
];

const VISUALIZATION_OPTIONS = [
  { id: 'table', label: 'Summary Table', icon: 'list' },
  { id: 'bar', label: 'Bar Chart', icon: 'bars' },
  { id: 'line', label: 'Line Graph', icon: 'chart' },
  { id: 'pie', label: 'Pie Chart', icon: 'grid' }
];

const GROUPING_OPTIONS = [
  { id: 'none', label: 'No grouping' },
  { id: 'day', label: 'Group by Day' },
  { id: 'week', label: 'Group by Week' },
  { id: 'month', label: 'Group by Month' },
  { id: 'category', label: 'Group by Category' },
  { id: 'location', label: 'Group by Location' },
  { id: 'supplier', label: 'Group by Supplier' }
];

function getAnalyticsPdfBranding(state = {}) {
  const settings = state.settings?.draft || state.settings?.values || {};
  const workspace = state.workspace || {};
  return {
    companyName: workspace.siteName || settings.siteName || settings.workspaceName || 'Kitchen Cost Pro',
    logoDataUrl: settings.restaurantLogoDataUrl || settings.logoDataUrl || ''
  };
}

export function renderAnalytics({ state, onAnalyticsFilterChange, onAnalyticsAction = {}, onCreateLowStockGrvDraft } = {}) {
  const analytics = state.analytics || {};
  const filters = {
    reportId: 'stock',
    query: '',
    reportSearch: '',
    category: '',
    locationId: '',
    startDate: '',
    endDate: '',
    view: 'hub',
    openDropdown: '',
    hubCategory: 'all',
    page: 1,
    pageSize: 25,
    customSource: customReportSources[0]?.id || 'stock',
    customColumns: [],
    customReportBlocks: [],
    customReportName: 'Custom Report',
    visualizationType: 'table',
    groupBy: 'none',
    customSetupOpen: false,
    rangePickerEdge: 'start',
    rangePickerComplete: false,
    rangePickerCursor: '',
    rangePickerMode: 'days',
    rangePickerYearInput: '',
    lowStockSelectedIds: [],
    lowStockExpandedIds: [],
    stockExpandedIds: [],
    lowStockViewMode: 'item',
    lowStockShowOnlyLow: true,
    lowStockReorderKey: '',
    lowStockReorderSelectedIds: [],
    forecastExpandedIds: [],
    stockTakeEditId: '',
    modifierGpMainProduct: '',
    modifierGpModifierItem: '',
    modifierGpCombination: '',
    modifierGpSort: 'totalSales',
    modifierGpExpandedProducts: [],
    modifierGpExpandedCombinations: [],
    modifierSummaryItem: '',
    modifierSummaryMainProduct: '',
    modifierSummaryCategory: '',
    modifierSummarySort: 'modifierSales',
    modifierSummaryExpandedItems: [],
    modifierSummaryExpandedProducts: [],
    ...analytics.filters
  };
  if (!reportCatalog.some((report) => report.id === filters.reportId)) {
    filters.reportId = 'stock';
    filters.view = 'hub';
  }
  const source = analytics.source || {};
const reportData = hydrateStockOnHandReport(
    hydrateLowStockReport(
      buildAnalyticsReport(source, filters.reportId, filters),
      state,
      filters
    ),
    filters
  );
  const isDetail = filters.view === 'detail';

  const view = document.createElement('section');
  view.className = `analyticsView ${isDetail ? 'analyticsView--detail' : 'analyticsView--hub'}`;
  view.dataset.openDropdown = filters.openDropdown || '';
  if (analytics.status === 'loading' && !Object.keys(source || {}).length) {
    view.innerHTML = `
      <div class="analyticsShell">
        ${renderLoadingPanel('Loading analytics', 'Preparing reports, stock insights, sales data, and forecasting inputs.')}
      </div>
    `;
    return view;
  }
  view.innerHTML = `
    <div class="analyticsShell">
      ${isDetail
        ? renderDetailView({ analytics, source, filters, reportData, access: state.access || {} })
        : renderHubView({ analytics, filters })}
    </div>
  `;

  const visibleSavedReports = filterSavedReportsForAccess(analytics.savedReports || [], state.access || {});
  bindAnalyticsEvents(view, {
    filters,
    reportData,
    workspaceId: state.workspace?.id || state.workspaceId || '',
    pdfBranding: getAnalyticsPdfBranding(state),
    savedReports: visibleSavedReports,
    access: state.access || {},
    onAnalyticsFilterChange,
    onAnalyticsAction,
    onCreateLowStockGrvDraft
  });
  hydrateAnalyticsCharts(view, reportData, filters, analytics.savedReports || []);
  return view;
}

function renderHubView({ analytics, filters }) {
  const search = String(filters.reportSearch || '').trim().toLowerCase();
  const hubGroups = ['sales', 'operations', 'inventory', 'advanced']
    .map((id) => HUB_REPORT_GROUPS.find((group) => group.id === id))
    .filter(Boolean);
  const hubInsights = buildHubInsights(analytics.source || {});
  const popularReportId = String(hubInsights[0]?.reportId || '').trim();
  const visibleGroups = hubGroups.map((group) => ({
    ...group,
    reportItems: reportsForHubGroup(group).filter((report) => reportMatchesSearch(report, search))
  })).filter((group) => group.reportItems.length);

  return `
    <header class="analyticsHubHeader analyticsHubHeader--modern analyticsHubHeader--reportList">
      <div class="analyticsHubIntro">
        <div class="analyticsHubTitleRow">
          <h1>Reports</h1>
        </div>
        <p>Reports</p>
      </div>
    </header>

    ${analytics.error ? `<div class="analyticsNotice">${escapeHtml(analytics.error)}</div>` : ''}

    <section class="analyticsHubDashboard analyticsHubDashboard--reportList" aria-label="Reports">
      <div class="analyticsHubPrimary">
        <div class="analyticsHubMain analyticsOldHub--modern analyticsHubMain--reportList">
          ${visibleGroups.map((group) => renderHubGroup(group, { popularReportId })).join('') || '<div class="analyticsEmpty">No reports match your search.</div>'}
        </div>
      </div>
    </section>
  `;
}

function renderDetailView({ analytics = {}, source, filters, reportData, access = {} }) {
  const categoryOptions = buildCategoryOptions(source.ingredients || []);
  const locationOptions = buildLocationOptions(source.locations || []);
  const category = categoryForReport(reportData.report.id);
  const isStockOnHandReport = reportData.report.id === 'stock';
  const isLowStockReport = reportData.report.id === 'low_stock';
  const isSaleMovementReport = reportData.report.id === 'sale_movement';
  const renderBreakdownAfterTable = isLowStockReport || isSaleMovementReport;
  const isCustomReport = reportData.report.id === 'custom_report';
  const isForecastReport = reportData.report.id === 'forecast';
  const isVolatilityReport = reportData.report.id === 'volatility';
  const isVarianceReport = reportData.report.id === 'variance';
  const isMenuHealthReport = reportData.report.id === 'menu';
  const isWasteParetoReport = reportData.report.id === 'waste_pareto';
  const isModifierGpReport = reportData.report.id === 'modifier_gp_detail';
  const isModifierSummaryReport = reportData.report.id === 'modifier_gp_summary';
  // Current-state reports describe how the workspace is set up right now, not
  // historical activity, so a date range is meaningless and misleading — hide it.
  const showDateRange = reportUsesDateRange(reportData.report.id);
  const totalRows = reportData.rows.length;
  const pageSize = normalizePageSize(filters.pageSize);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = reportData.rows.slice(startIndex, startIndex + pageSize);
  const tableColumns = reportData.report.id === 'missing_recipes'
    ? reportData.columns.filter((column) => column !== 'Recipe')
    : reportData.columns;
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const yocoOrderSummary = reportData.report.id === 'yoco_sales'
    ? getYocoOrderSummary(reportData.rows, filters.yocoOrderDetailId)
    : null;
  const grvSummary = reportData.report.id === 'grv'
    ? getGrvSummary(reportData.rows, filters.grvDetailId)
    : null;
  const creditNoteSummary = reportData.report.id === 'cn'
    ? getCreditNoteSummary(reportData.rows, filters.creditNoteDetailId)
    : null;
  const purchaseOrderSummary = reportData.report.id === 'purchase_orders'
    ? getPurchaseOrderSummary(reportData.rows, filters.purchaseOrderDetailId)
    : null;
  const stockTakeSummary = reportData.report.id === 'stocktake'
    ? getStockTakeSummary(reportData.rows, filters.stockTakeDetailId)
    : null;
  const stockTakeEditAccess = stockTakeSummary ? getStockTakeEditAccess(stockTakeSummary, access) : { canEdit: false, days: 0 };
  const saleMovementSummary = reportData.report.id === 'sale_movement'
    ? getSaleMovementSummary(reportData.rows, filters.saleMovementDetailId)
    : null;
  const opsCategorySummary = reportData.report.id === 'ops_category_overview' && filters.opsCategoryDetailKey
    ? (reportData.rows || []).find((row) => String(row._category || '') === String(filters.opsCategoryDetailKey))
    : null;
  const emptyTableMessage = isLowStockReport
    ? 'No low-stock items match this view.'
    : 'No rows match this report.';
  if (isCustomReport) {
    return renderCustomReportDetailView({
      source,
      filters,
      reportData,
      analytics,
      category,
      categoryOptions,
      locationOptions,
      totalRows,
      pageSize,
      currentPage,
      totalPages,
      firstRowNumber,
      lastRowNumber,
      pageRows,
      emptyTableMessage,
      access
    });
  }
  if (isForecastReport) {
    return renderForecastReportDetailView({
      filters,
      reportData,
      category,
      categoryOptions,
      locationOptions,
      pageSize,
      emptyTableMessage
    });
  }
  if (isVolatilityReport) {
    return renderVolatilityReportDetailView({
      filters,
      reportData,
      category,
      categoryOptions,
      locationOptions,
      pageSize
    });
  }
  if (isVarianceReport) {
    return renderVarianceReportDetailView({
      filters,
      reportData,
      category,
      categoryOptions,
      locationOptions,
      pageSize
    });
  }
  if (isMenuHealthReport) {
    return renderMenuHealthReportDetailView({
      filters,
      reportData,
      category,
      pageSize
    });
  }
  if (isWasteParetoReport) {
    return renderWasteParetoReportDetailView({
      filters,
      reportData,
      category,
      pageSize
    });
  }
  if (isModifierGpReport) {
    return renderModifierGpReportDetailView({
      filters,
      reportData,
      category,
      locationOptions,
      pageSize
    });
  }
  if (isModifierSummaryReport) {
    return renderModifierSummaryReportDetailView({
      filters,
      reportData,
      category,
      locationOptions,
      pageSize
    });
  }
  return `
    <div class="analyticsDetailCanvas analyticsDetail--modern analyticsTone-${category.tone} ${isLowStockReport ? 'analyticsDetailCanvas--lowStock' : ''}">

      <header class="analyticsReportMasthead">
        <div>
          <nav class="analyticsBreadcrumb2">
            <button type="button" class="analyticsBreadcrumb" data-analytics-back>
              ${icon('chevronLeft')}
              <span>Reports</span>
            </button>
            ${reportData.report.group ? `${icon('chevronRight')}<span class="analyticsCrumbCurrent">${escapeHtml(reportData.report.group)}</span>` : ''}
          </nav>
          <div class="analyticsReportTitle">
            <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Detailed live report for this workspace.')}</h1>
            <p>${escapeHtml(reportData.report.description)}</p>
          </div>
        </div>
        <div class="analyticsHeaderActions">
          ${renderReportActionsDropdown(filters.openDropdown)}
          <button type="button" class="analyticsRefreshButton" data-analytics-refresh>${icon('refresh')}<span>Refresh</span></button>
        </div>
      </header>

      ${renderModernKpiStrip(reportData, filters)}

      ${isLowStockReport ? renderLowStockControls(filters) : ''}
      ${isLowStockReport ? renderLowStockOrderingPanel(reportData, filters) : ''}

      <section class="analyticsReportPanel ${isLowStockReport ? 'analyticsReportPanel--lowStock' : ''} ${isSaleMovementReport ? 'analyticsReportPanel--saleMovement' : ''}">
        <div class="analyticsTableBlock">
          <div class="analyticsTableToolbar">
            <span class="analyticsToolbarLabel">Filters</span>
            ${showDateRange ? renderDateRangePicker(filters) : ''}
            ${renderDropdown({ id: 'category', label: 'Category', selectedValue: filters.category || '', options: categoryOptions, openDropdown: filters.openDropdown })}
            ${renderDropdown({ id: 'locationId', label: 'Location', selectedValue: filters.locationId || '', options: locationOptions, openDropdown: filters.openDropdown })}
            ${isLowStockReport ? `
              <button type="button" class="analyticsToolbarAction" data-analytics-low-stock-grv ${reportData.rows.length ? '' : 'disabled'}>
                ${icon('cart')} ${selectedLowStockRows(reportData, filters).length ? `Order Selected (${selectedLowStockRows(reportData, filters).length})` : 'Create GRV Draft'}
              </button>
            ` : ''}
            <label class="analyticsHeroSearch analyticsToolbarSearch">
              <div>
                ${icon('search')}
                <input type="search" value="${escapeAttribute(filters.query)}" placeholder="Search items…" data-analytics-field="query" data-focus-key="analytics-query" />
              </div>
            </label>
          </div>
          <div class="analyticsTableWrap">
            <table class="analyticsTable">
              <thead>
                <tr>${tableColumns.map((column) => renderTableHeaderCell(column, reportData, filters)).join('')}</tr>
              </thead>
              <tbody>
                ${isLowStockReport ? renderLowStockTableRows(pageRows, reportData, filters) : isStockOnHandReport ? renderStockOnHandTableRows(pageRows, reportData) : reportData.report.id === 'ops_category_overview' ? (pageRows.map((row) => `
                  <tr class="analyticsDrillRow" data-analytics-ops-category="${escapeAttribute(row._category || '')}" title="View item breakdown for ${escapeAttribute(row._category || '')}">${tableColumns.map((column) => renderTableCell(column, row[column], row, reportData.report.id)).join('')}</tr>
                `).join('') || `<tr><td colspan="${tableColumns.length}">${escapeHtml(emptyTableMessage)}</td></tr>`) : pageRows.map((row) => `
                  <tr>${tableColumns.map((column) => renderTableCell(column, row[column], row, reportData.report.id)).join('')}</tr>
                `).join('') || `<tr><td colspan="${tableColumns.length}">${escapeHtml(emptyTableMessage)}</td></tr>`}
              </tbody>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `Showing <strong>${firstRowNumber}-${lastRowNumber}</strong> of <strong>${totalRows}</strong> records` : 'No records'}</span>
            <div class="analyticsPaginationRight">
              <div class="analyticsRowsPer">
                <span>Rows per page</span>
                ${renderDropdown({ id: 'pageSize', label: 'Rows', selectedValue: String(pageSize), options: pageSizeOptions(), openDropdown: filters.openDropdown })}
              </div>
              <div class="analyticsPageButtons">
                <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
                <strong class="analyticsPageCurrent">${currentPage}</strong>
                <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
              </div>
            </div>
          </footer>
        </div>
        ${totalRows > pageSize ? `<div class="analyticsLimitNote">Export still includes all ${totalRows} rows.</div>` : ''}
      </section>
      ${isLowStockReport ? renderLowStockReorderModal(reportData, filters) : ''}
      ${yocoOrderSummary ? renderYocoOrderSummaryOverlay(yocoOrderSummary) : ''}
      ${grvSummary ? renderGrvSummaryOverlay(grvSummary) : ''}
      ${creditNoteSummary ? renderCreditNoteSummaryOverlay(creditNoteSummary) : ''}
      ${purchaseOrderSummary ? renderPurchaseOrderSummaryOverlay(purchaseOrderSummary) : ''}
      ${stockTakeSummary ? renderStockTakeSummaryOverlay(stockTakeSummary, {
        isEditing: String(filters.stockTakeEditId || '') === String(stockTakeSummary.id || ''),
        canEdit: stockTakeEditAccess.canEdit,
        editWindowDays: stockTakeEditAccess.days,
        actionStatus: analytics.actionStatus || ''
      }) : ''}
      ${saleMovementSummary ? renderSaleMovementSummaryOverlay(saleMovementSummary) : ''}
      ${opsCategorySummary ? renderOpsCategorySummaryOverlay(opsCategorySummary) : ''}
    </div>
  `;
}

function renderOpsCategorySummaryOverlay(summary) {
  const detailRows = arrayValue(summary._detailRows);
  const detailColumns = ['Item', 'Unit', 'Opening Stock Value', 'Purchases', 'Closing Stock Value', 'COS Actual', 'COS Theoretical', 'COS Difference'];
  return `
    <div class="analyticsModalBackdrop" data-ops-category-close>
      <section class="analyticsOrderModal analyticsSaleMovementModal" role="dialog" aria-modal="true" aria-label="Inventory category breakdown">
        <header>
          <div>
            <span>Operations Overview · Item Breakdown</span>
            <h2>${escapeHtml(summary['Inventory Category'] || summary._category || 'Category')}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-ops-category-close aria-label="Close breakdown">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Locations</span><strong>${escapeHtml(summary.Locations || summary.Site || '')}</strong></div>
          <div><span>Opening Stock Value</span><strong>${escapeHtml(summary['Opening Stock Value'] || '')}</strong></div>
          <div><span>Purchases</span><strong>${escapeHtml(summary.Purchases || '')}</strong></div>
          <div><span>Closing Stock Value</span><strong>${escapeHtml(summary['Closing Stock Value'] || '')}</strong></div>
          <div><span>COS Actual</span><strong>${escapeHtml(summary['COS Actual'] || '')}</strong></div>
          <div><span>COS Theoretical</span><strong>${escapeHtml(summary['COS Theoretical'] || '')}</strong></div>
          <div><span>COS Difference</span><strong>${escapeHtml(summary['COS Difference'] || '')}</strong></div>
        </div>
        <div class="analyticsTableWrap">
          <table class="analyticsTable">
            <thead><tr>${detailColumns.map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr></thead>
            <tbody>
              ${detailRows.map((row) => `<tr>${detailColumns.map((column) => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>`).join('')
                || `<tr><td colspan="${detailColumns.length}">No item-level detail for this category.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
}

function renderForecastReportDetailView({
  filters,
  reportData,
  category,
  categoryOptions,
  locationOptions,
  pageSize
}) {
  const forecastRows = buildForecastAdvancedRows(reportData.rows || [], filters);
  const rows = groupForecastRows(forecastRows, filters);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const horizonOptions = [
    { value: '7', label: '7 Days' },
    { value: '14', label: '14 Days' },
    { value: '30', label: '30 Days' },
    { value: '60', label: '60 Days' }
  ];

  return `
    <div class="analyticsDetailCanvas analyticsForecastCanvas analyticsTone-${category.tone}">
      <header class="analyticsForecastHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsForecastTitle">
            <span>${icon('chart')}</span>
            <div>
              <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Advanced live report for this workspace.')}</h1>
              <p>${escapeHtml(reportData.report.description)}</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          <label class="analyticsForecastSearch">
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query)}" placeholder="Search reports, items, locations..." data-analytics-field="query" data-focus-key="analytics-query" />
          </label>
          <button type="button" class="analyticsForecastToolButton" data-analytics-dropdown="forecastFilters" aria-expanded="${filters.openDropdown === 'forecastFilters'}">
            ${icon('filter')} Filters
          </button>
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsForecastFilters ${filters.openDropdown === 'forecastFilters' ? 'is-open' : ''}" data-analytics-dropdown-root>
        ${renderDropdown({
          id: 'locationId',
          label: 'Location',
          selectedValue: filters.locationId || '',
          options: locationOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'category',
          label: 'Category',
          selectedValue: filters.category || '',
          options: categoryOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'forecastHorizon',
          label: 'Forecast Horizon',
          selectedValue: String(filters.forecastHorizon || '14'),
          options: horizonOptions,
          openDropdown: filters.openDropdown
        })}
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>
          ${icon('sliders')} Apply Filters
        </button>
        <span class="analyticsForecastUpdated">Last updated: ${escapeHtml(new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }))}</span>
      </section>

      ${renderForecastKpis(rows, filters)}

      <section class="analyticsForecastGrid">
        ${renderForecastCoverageChart(rows, filters)}
        ${renderForecastRiskDistribution(rows)}
        <div class="analyticsForecastSideStack">
          ${renderForecastExposureList(forecastRows, 'Location', 'Most Exposed Locations', 'box')}
          ${renderForecastExposureList(forecastRows, 'Category', 'Highest Risk Categories', 'box')}
          ${renderForecastNotes(forecastRows)}
        </div>
      </section>

      <section class="analyticsForecastTablePanel">
        <header>
          <div>
            <h2>Forecasted Stock-outs <span>${escapeHtml(formatNumber(totalRows))} items</span></h2>
            <p>Rows are sorted by lowest days of cover first.</p>
          </div>
          ${renderDropdown({
            id: 'pageSize',
            label: 'Rows',
            selectedValue: String(pageSize),
            options: pageSizeOptions(),
            openDropdown: filters.openDropdown
          })}
        </header>
        <div class="analyticsTableWrap">
          <table class="analyticsTable analyticsForecastTable">
            <thead>
              <tr>
                ${forecastAdvancedColumns().map((column) => `<th>${escapeHtml(column)} ${forecastColumnInfo(column)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${pageRows.map(renderForecastTableRow).join('') || `<tr><td colspan="${forecastAdvancedColumns().length}">No stock-out risks match this report.</td></tr>`}
            </tbody>
          </table>
        </div>
        <footer class="analyticsPagination">
          <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} forecast rows` : '0 forecast rows'}</span>
          <div class="analyticsPageButtons">
            <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
            <strong>Page ${currentPage} of ${totalPages}</strong>
            <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
          </div>
        </footer>
      </section>
    </div>
  `;
}

function forecastAdvancedColumns() {
  return ['Item', 'Category', 'Location', 'Current Stock', 'Avg Daily Usage', 'Days of Cover', 'Stock-out Date', 'Risk Level', 'Reorder Qty', 'Action'];
}

function buildForecastAdvancedRows(rows = [], filters = {}) {
  const horizon = Math.max(1, Number(filters.forecastHorizon || 14) || 14);
  return rows
    .map((row) => {
      const currentStock = parseNumber(row['Current Stock']);
      const avgDailyUsage = parseNumber(row['Avg Daily Usage']);
      const daysOfCover = avgDailyUsage > 0 ? currentStock / avgDailyUsage : Number.POSITIVE_INFINITY;
      const suggestedQty = Math.max(0, Math.ceil((avgDailyUsage * horizon) - currentStock));
      const unitCost = parseNumber(row._unitCost ?? row['Unit Cost']);
      const riskLevel = row['Risk Level'] || forecastRiskLevel(daysOfCover);
      const stockOutDate = row['Predicted Stock-out Date'] && row['Predicted Stock-out Date'] !== 'No usage'
        ? row['Predicted Stock-out Date']
        : (Number.isFinite(daysOfCover) ? addDays(todayLocal(), Math.ceil(daysOfCover)) : 'No usage');
      return {
        ...row,
        'Current Stock': currentStock,
        'Avg Daily Usage': avgDailyUsage,
        'Days of Cover': Number.isFinite(daysOfCover) ? daysOfCover : 'No usage',
        'Predicted Stock-out Date': stockOutDate,
        'Stock-out Date': stockOutDate,
        'Risk Level': riskLevel,
        'Suggested Reorder Qty': suggestedQty,
        'Reorder Qty': suggestedQty,
        _daysOfCover: daysOfCover,
        _projectedValue: Math.max(0, currentStock) * unitCost,
        _suggestedQty: suggestedQty,
        _unitCost: unitCost
      };
    })
    .sort((left, right) => forecastSortValue(left._daysOfCover) - forecastSortValue(right._daysOfCover));
}

function groupForecastRows(rows = [], filters = {}) {
  const expanded = new Set(arrayValue(filters.forecastExpandedIds));
  const groups = rows.reduce((map, row) => {
    const key = forecastRowGroupKey(row);
    const entry = map.get(key) || [];
    entry.push(row);
    map.set(key, entry);
    return map;
  }, new Map());

  return [...groups.entries()]
    .map(([key, detailRows]) => {
      const sortedRows = [...detailRows].sort((left, right) => forecastSortValue(left._daysOfCover) - forecastSortValue(right._daysOfCover));
      const primary = sortedRows[0] || {};
      const totalCurrent = sortedRows.reduce((sum, row) => sum + parseNumber(row['Current Stock']), 0);
      const totalUsage = sortedRows.reduce((sum, row) => sum + parseNumber(row['Avg Daily Usage']), 0);
      const totalReorder = sortedRows.reduce((sum, row) => sum + Number(row._suggestedQty || row['Suggested Reorder Qty'] || 0), 0);
      const totalValue = sortedRows.reduce((sum, row) => sum + Number(row._projectedValue || 0), 0);
      const locationCount = new Set(sortedRows.map((row) => String(row.Location || '').trim()).filter(Boolean)).size || sortedRows.length;

      return {
        ...primary,
        Location: locationCount > 1 ? `${formatNumber(locationCount)} locations` : primary.Location,
        'Current Stock': totalCurrent,
        'Avg Daily Usage': totalUsage,
        'Suggested Reorder Qty': totalReorder,
        'Reorder Qty': totalReorder,
        _detailRows: sortedRows,
        _duplicateCount: sortedRows.length,
        _expanded: expanded.has(key),
        _groupKey: key,
        _projectedValue: totalValue,
        _suggestedQty: totalReorder
      };
    })
    .sort((left, right) => forecastSortValue(left._daysOfCover) - forecastSortValue(right._daysOfCover));
}

function forecastRowGroupKey(row = {}) {
  return `${String(row.Item || '').trim().toLowerCase()}::${String(row.Category || '').trim().toLowerCase()}`;
}

function forecastSortValue(value) {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function forecastRiskLevel(daysOfCover) {
  if (!Number.isFinite(daysOfCover)) return 'Stable';
  if (daysOfCover <= 7) return 'Critical';
  if (daysOfCover <= 14) return 'High';
  if (daysOfCover <= 30) return 'Medium';
  return 'Stable';
}

function liveChartAttr(value) {
  return escapeAttribute(JSON.stringify(value || []));
}

function renderLiveChartCanvas({ type = 'bar', labels = [], datasets = [], className = '', ariaLabel = 'Live report chart', series = [] } = {}) {
  return `
    <div class="analyticsLiveChartFrame ${escapeAttribute(className)}">
      <canvas
        data-live-chart="true"
        data-chart-type="${escapeAttribute(type)}"
        data-chart-labels="${liveChartAttr(labels)}"
        data-chart-datasets="${liveChartAttr(datasets)}"
        data-chart-series="${liveChartAttr(series)}"
        aria-label="${escapeAttribute(ariaLabel)}"
        role="img"
      ></canvas>
    </div>
  `;
}

function renderLiveDoughnut({ series = [], centerValue = '', centerLabel = '', className = '', ariaLabel = 'Live distribution chart' } = {}) {
  return `
    <div class="analyticsLiveDoughnutWrap ${escapeAttribute(className)}">
      ${renderLiveChartCanvas({ type: 'pie', series, className: 'analyticsLiveDoughnutCanvas', ariaLabel })}
      <span class="analyticsLiveDoughnutCenter">
        <strong>${escapeHtml(centerValue)}</strong>
        <em>${escapeHtml(centerLabel)}</em>
      </span>
    </div>
  `;
}

function renderForecastKpis(rows = [], filters = {}) {
  const horizon = Math.max(1, Number(filters.forecastHorizon || 14) || 14);
  const atRisk = rows.filter((row) => forecastSortValue(row._daysOfCover) <= 30);
  const critical = rows.filter((row) => forecastSortValue(row._daysOfCover) <= 7);
  const expected = rows.filter((row) => forecastSortValue(row._daysOfCover) <= horizon);
  const projectedValue = atRisk.reduce((sum, row) => sum + Number(row._projectedValue || 0), 0);
  const reorderRows = rows.filter((row) => Number(row._suggestedQty || 0) > 0);
  const cards = [
    { label: 'Items at Risk', value: formatNumber(atRisk.length), helper: 'Items with 30 days of cover or less.', icon: 'activity', tone: 'red', link: 'View rows' },
    { label: 'Critical in 7 Days', value: formatNumber(critical.length), helper: 'Items forecast to run out within seven days.', icon: 'calendar', tone: 'orange', link: 'View critical' },
    { label: `Expected Stock-outs in ${horizon} Days`, value: formatNumber(expected.length), helper: 'Forecasted stock-outs inside the selected horizon.', icon: 'clipboard', tone: 'yellow', link: 'View forecast' },
    { label: 'Projected Stock-out Value', value: formatMoney(projectedValue), helper: 'Current stock value exposed in at-risk rows.', icon: 'coin', tone: 'green', link: 'View value' },
    { label: 'Reorder Recommendations', value: formatNumber(reorderRows.length), helper: 'Rows with a suggested reorder quantity.', icon: 'cart', tone: 'blue', link: 'View details' }
  ];
  return `
    <section class="analyticsForecastKpis">
      ${cards.map((card) => `
        <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
          <span>${icon(card.icon)}</span>
          <div>
            <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
            <strong>${escapeHtml(card.value)}</strong>
            <em>${escapeHtml(card.helper)}</em>
            <button type="button" class="analyticsForecastKpiLink" data-analytics-forecast-focus="table">${escapeHtml(card.link)} ${icon('arrowRight')}</button>
          </div>
        </article>
      `).join('')}
    </section>
  `;
}

function renderForecastCoverageChart(rows = [], filters = {}) {
  const finiteDays = rows.map((row) => Number(row._daysOfCover)).filter(Number.isFinite);
  const horizon = Math.max(7, Number(filters.forecastHorizon || 14) || 14);
  const averageCover = finiteDays.length ? finiteDays.reduce((sum, value) => sum + value, 0) / finiteDays.length : 0;
  const minimumCover = finiteDays.length ? Math.min(...finiteDays) : 0;
  const steps = 8;
  const chartPoints = Array.from({ length: steps }, (_, index) => {
    const progress = steps <= 1 ? 0 : index / (steps - 1);
    const dayOffset = progress * horizon;
    return {
      label: addDays(todayLocal(), Math.round(progress * horizon)),
      average: Math.max(0, averageCover - dayOffset),
      minimum: Math.max(0, minimumCover - dayOffset)
    };
  });
  const labels = chartPoints.map((point) => point.label);
  const datasets = [
    {
      label: 'Average Days of Cover',
      data: chartPoints.map((point) => Number(point.average.toFixed(2))),
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96, 165, 250, 0.16)',
      pointBackgroundColor: '#93c5fd',
      pointRadius: 3,
      tension: 0.35,
      fill: true
    },
    {
      label: 'Minimum Days of Cover',
      data: chartPoints.map((point) => Number(point.minimum.toFixed(2))),
      borderColor: '#bfdbfe',
      backgroundColor: 'rgba(191, 219, 254, 0.08)',
      borderDash: [5, 5],
      pointRadius: 2,
      tension: 0.35
    },
    {
      label: 'Reorder Threshold (7)',
      data: chartPoints.map(() => 7),
      borderColor: '#fb923c',
      borderDash: [6, 5],
      pointRadius: 0,
      tension: 0
    },
    {
      label: 'Critical Threshold (2)',
      data: chartPoints.map(() => 2),
      borderColor: '#fb365d',
      borderDash: [6, 5],
      pointRadius: 0,
      tension: 0
    }
  ];
  return `
    <section class="analyticsForecastPanel analyticsForecastCoverage">
      <header>
        <h2>Projected Stock Coverage Over Time ${renderForecastInfo('Estimated days of cover for the fastest-risk items in this filtered report.')}</h2>
        <span>Average days of cover vs minimum cover</span>
      </header>
      ${renderLiveChartCanvas({ type: 'line', labels, datasets, className: 'analyticsForecastCoverageCanvas', ariaLabel: 'Projected stock coverage over time' })}
      <div class="analyticsForecastLegend">
        <span><i class="is-average"></i> Average Days of Cover</span>
        <span><i class="is-minimum"></i> Minimum Days of Cover</span>
        <span><i class="is-reorder"></i> Reorder Threshold (7)</span>
        <span><i class="is-critical"></i> Critical Threshold (2)</span>
      </div>
    </section>
  `;
}

function renderForecastRiskDistribution(rows = []) {
  const groups = ['Critical', 'High', 'Medium', 'Stable'].map((label) => ({
    label,
    count: rows.filter((row) => String(row['Risk Level']) === label).length
  }));
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const riskTotal = groups.filter((group) => group.label !== 'Stable').reduce((sum, group) => sum + group.count, 0);
  const colors = ['#fb365d', '#fb923c', '#facc15', '#34d399'];
  const series = groups.map((group, index) => ({
    label: group.label,
    value: group.count,
    color: colors[index]
  }));
  return `
    <section class="analyticsForecastPanel analyticsForecastRiskPanel">
      <header>
        <h2>Risk Distribution by Days to Stock-out ${renderForecastInfo('Risk is based on days of cover: critical <=7, high <=14, medium <=30.')}</h2>
      </header>
      <div class="analyticsForecastRiskBody">
        ${renderLiveDoughnut({ series, centerValue: formatNumber(riskTotal), centerLabel: 'items at risk', className: 'analyticsForecastRiskDonut', ariaLabel: 'Forecast risk distribution' })}
        <div class="analyticsForecastRiskList">
          ${groups.map((group, index) => `
            <div style="--risk-color:${colors[index]};">
              <span>${escapeHtml(group.label)}</span>
              <strong>${escapeHtml(formatNumber(group.count))}</strong>
            </div>
          `).join('')}
        </div>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-forecast-focus="table">
        View full forecast breakdown ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderForecastExposureList(rows = [], key = 'Location', title = '', iconName = 'box') {
  const groups = [...rows.reduce((map, row) => {
    const label = String(row[key] || 'Unassigned').trim() || 'Unassigned';
    const entry = map.get(label) || { label, count: 0, value: 0 };
    entry.count += forecastSortValue(row._daysOfCover) <= 30 ? 1 : 0;
    entry.value += Number(row._projectedValue || 0);
    map.set(label, entry);
    return map;
  }, new Map()).values()]
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count || right.value - left.value)
    .slice(0, 5);
  const max = Math.max(...groups.map((group) => group.count), 1);
  return `
    <section class="analyticsForecastPanel analyticsForecastExposure">
      <header>
        <h2>${icon(iconName)} ${escapeHtml(title)} ${renderForecastInfo(`Top ${key.toLowerCase()} exposure by low days of cover.`)}</h2>
        <button type="button" class="analyticsForecastPanelHeaderLink" data-analytics-forecast-focus="table">View all</button>
      </header>
      <div>
        ${groups.map((group) => `
          <article>
            <span>${escapeHtml(group.label)}</span>
            <div><i style="width:${Math.max(6, (group.count / max) * 100).toFixed(2)}%"></i></div>
            <strong>${escapeHtml(formatNumber(group.count))}</strong>
          </article>
        `).join('') || '<p>No exposed rows in this filtered view.</p>'}
      </div>
    </section>
  `;
}

function renderForecastNotes(rows = []) {
  const criticalRows = rows.filter((row) => forecastSortValue(row._daysOfCover) <= 7).slice(0, 3);
  const highRows = rows.filter((row) => forecastSortValue(row._daysOfCover) > 7 && forecastSortValue(row._daysOfCover) <= 14).slice(0, 2);
  const notes = [
    ...criticalRows.map((row) => `${row.Item} at ${row.Location} is critical with ${formatNumber(row._daysOfCover)} days of cover.`),
    ...highRows.map((row) => `${row.Item} at ${row.Location} should be reviewed before ${row['Predicted Stock-out Date']}.`)
  ];
  return `
    <section class="analyticsForecastPanel analyticsForecastNotes">
      <header>
        <h2>${icon('info')} Forecast Notes ${renderForecastInfo('Generated from live stock balances and recent usage signals.')}</h2>
      </header>
      <ul>
        ${(notes.length ? notes : ['No critical forecast notes for the selected filters.']).map((note) => `<li>${escapeHtml(note)}</li>`).join('')}
      </ul>
      <small>Generated on ${escapeHtml(new Date().toLocaleString('en-ZA'))}</small>
    </section>
  `;
}

function renderForecastTableRow(row = {}) {
  const risk = String(row['Risk Level'] || forecastRiskLevel(row._daysOfCover)).toLowerCase();
  const unit = reportRowUnit(row);
  const suggested = Number(row._suggestedQty || row['Suggested Reorder Qty'] || 0);
  const hasBreakdown = Number(row._duplicateCount || 0) > 1;
  const groupKey = String(row._groupKey || forecastRowGroupKey(row));
  const mainRow = `
    <tr class="${hasBreakdown ? 'analyticsForecastGroupRow' : ''}">
      <td>
        <div class="analyticsForecastItemCell">
          ${hasBreakdown ? `
            <button
              type="button"
              class="analyticsForecastExpandButton"
              data-analytics-forecast-expand="${escapeAttribute(groupKey)}"
              aria-expanded="${row._expanded ? 'true' : 'false'}"
              aria-label="${row._expanded ? 'Hide' : 'Show'} location breakdown for ${escapeAttribute(row.Item || 'item')}"
            >
              ${icon(row._expanded ? 'chevronDown' : 'chevronRight')}
            </button>
          ` : ''}
          <span>
            <strong>${escapeHtml(row.Item || '')}</strong>
            ${hasBreakdown ? `<em>${escapeHtml(formatNumber(row._duplicateCount))} stock rows grouped</em>` : ''}
          </span>
        </div>
      </td>
      <td>${escapeHtml(row.Category || '')}</td>
      <td>${escapeHtml(row.Location || '')}</td>
      <td>${renderForecastQty(row['Current Stock'], unit, 'Current stock')}</td>
      <td>${renderForecastQty(row['Avg Daily Usage'], unit, 'Average daily usage')}</td>
      <td>${Number.isFinite(row._daysOfCover) ? escapeHtml(formatNumber(row._daysOfCover)) : 'No usage'}</td>
      <td>${escapeHtml(row['Predicted Stock-out Date'] || '')}</td>
      <td><span class="analyticsForecastRiskBadge analyticsForecastRiskBadge--${escapeAttribute(risk)}">${escapeHtml(row['Risk Level'] || 'Stable')}</span></td>
      <td>${renderForecastQty(suggested, unit, 'Suggested reorder quantity')}</td>
      <td>
        ${hasBreakdown ? `
          <button
            type="button"
            class="analyticsInlineAction analyticsInlineAction--compact"
            data-analytics-forecast-expand="${escapeAttribute(groupKey)}"
            aria-expanded="${row._expanded ? 'true' : 'false'}"
          >
            ${icon(row._expanded ? 'chevronDown' : 'chevronRight')} Locations
          </button>
        ` : `
          <button
            type="button"
            class="analyticsInlineAction analyticsInlineAction--compact"
            data-analytics-forecast-reorder
            data-forecast-item="${escapeAttribute(row.Item || '')}"
            data-forecast-location-id="${escapeAttribute(row._locationId || '')}"
            ${suggested > 0 ? '' : 'disabled'}
          >
            ${icon('cart')} Reorder
          </button>
        `}
      </td>
    </tr>
  `;

  if (!hasBreakdown || !row._expanded) return mainRow;
  return `${mainRow}${renderForecastDetailRow(row)}`;
}

function renderForecastDetailRow(row = {}) {
  const columns = forecastAdvancedColumns().length;
  const detailRows = arrayValue(row._detailRows);
  return `
    <tr class="analyticsForecastDetailRow">
      <td colspan="${columns}">
        <div class="analyticsForecastDetailPanel">
          <header>
            <strong>Location breakdown</strong>
            <span>${escapeHtml(formatNumber(detailRows.length))} rows for ${escapeHtml(row.Item || 'this item')}</span>
          </header>
          <div>
            ${detailRows.map((detail) => {
              const detailUnit = reportRowUnit(detail);
              const detailRisk = String(detail['Risk Level'] || forecastRiskLevel(detail._daysOfCover)).toLowerCase();
              const detailSuggested = Number(detail._suggestedQty || detail['Suggested Reorder Qty'] || 0);
              return `
                <article>
                  <span>
                    <strong>${escapeHtml(detail.Location || 'Unassigned')}</strong>
                    <em>${Number.isFinite(detail._daysOfCover) ? `${escapeHtml(formatNumber(detail._daysOfCover))} days cover` : 'No usage'}</em>
                  </span>
                  <span>${renderForecastQty(detail['Current Stock'], detailUnit, 'Current stock')}</span>
                  <span>${renderForecastQty(detail['Avg Daily Usage'], detailUnit, 'Average daily usage')}</span>
                  <span><span class="analyticsForecastRiskBadge analyticsForecastRiskBadge--${escapeAttribute(detailRisk)}">${escapeHtml(detail['Risk Level'] || 'Stable')}</span></span>
                  <span>${renderForecastQty(detailSuggested, detailUnit, 'Suggested reorder quantity')}</span>
                  <button
                    type="button"
                    class="analyticsInlineAction analyticsInlineAction--compact"
                    data-analytics-forecast-reorder
                    data-forecast-item="${escapeAttribute(detail.Item || '')}"
                    data-forecast-location-id="${escapeAttribute(detail._locationId || '')}"
                    ${detailSuggested > 0 ? '' : 'disabled'}
                  >
                    ${icon('cart')} Reorder
                  </button>
                </article>
              `;
            }).join('')}
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderForecastQty(value, unit = '', label = 'Quantity') {
  const displayValue = formatNumber(parseNumber(value));
  const tooltip = unit ? `${label}: ${displayValue} ${unit}` : `${label}: ${displayValue}`;
  return `
    <span class="analyticsUnitValue" data-tooltip="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}">
      <span>${escapeHtml(displayValue)}</span>
      ${unit ? `<em>${escapeHtml(unit)}</em>` : ''}
    </span>
  `;
}

function forecastColumnInfo(column = '') {
  const info = {
    Item: 'Stock item being forecast.',
    Category: 'Current inventory category.',
    Location: 'Storage or selling location used for this forecast row.',
    'Current Stock': 'Current on-hand balance at this location.',
    'Avg Daily Usage': 'Average daily depletion calculated from recent sales and adjustment removals.',
    'Days of Cover': 'Current stock divided by average daily usage.',
    'Stock-out Date': 'Estimated date the item reaches zero if current usage continues.',
    'Risk Level': 'Critical <= 7 days, High <= 14 days, Medium <= 30 days.',
    'Reorder Qty': 'Quantity needed to cover the selected forecast horizon.',
    Action: 'Quick route to reorder from the low-stock workflow.'
  };
  return renderForecastInfo(info[column] || column);
}

function renderForecastInfo(message = '') {
  return `
    <span class="analyticsForecastInfo" data-tooltip="${escapeAttribute(message)}" aria-label="${escapeAttribute(message)}">
      ${icon('info')}
    </span>
  `;
}

function renderReportInfo(message = '') {
  return renderForecastInfo(message || 'More information about this report section.');
}

function renderVolatilityReportDetailView({
  filters,
  reportData,
  category,
  categoryOptions,
  locationOptions,
  pageSize
}) {
  const rows = buildVolatilityAdvancedRows(reportData.rows || [], filters);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const supplierOptions = buildVolatilitySupplierOptions(reportData.rows || []);
  const itemOptions = buildVolatilityItemOptions(reportData.rows || []);
  const selectedVolatilityDetail = rows.find((row) => row._detailKey === filters.volatilityDetailKey);

  return `
    <div class="analyticsDetailCanvas analyticsVolatilityCanvas analyticsTone-${category.tone}">
      <header class="analyticsVolatilityHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsVolatilityTitle">
            <span>${icon('chart')}</span>
            <div>
              <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Advanced live report for this workspace.')}</h1>
              <p>${escapeHtml(reportData.report.description)}</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          ${renderDateRangePicker(filters)}
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsVolatilityFilters">
        ${renderDropdown({ id: 'locationId', label: 'Location', selectedValue: filters.locationId || '', options: locationOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'category', label: 'Category', selectedValue: filters.category || '', options: categoryOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'supplier', label: 'Supplier', selectedValue: filters.supplier || '', options: supplierOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'item', label: 'Item', selectedValue: filters.item || '', options: itemOptions, openDropdown: filters.openDropdown })}
        <button type="button" class="analyticsVolatilityReset" data-analytics-volatility-reset>${icon('refresh')} Reset</button>
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>${icon('sliders')} Apply Filters</button>
      </section>

      <div class="analyticsVolatilityMeta">
        <span>Data as of ${escapeHtml(new Date().toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }))}</span>
        <button type="button" data-analytics-refresh aria-label="Refresh report">${icon('refresh')}</button>
      </div>

      ${renderVolatilityKpis(rows, reportData.rows || [])}

      <section class="analyticsVolatilityGrid">
        ${renderVolatilityTrendPanel(rows)}
        ${renderVolatilityDistribution(rows)}
        ${renderVolatilityCategoryPanel(rows)}
      </section>

      <section class="analyticsVolatilityBodyGrid">
        <aside class="analyticsVolatilitySide">
          ${renderVolatilityTopList(rows, 'increase')}
          ${renderVolatilitySupplierImpact(rows)}
        </aside>
        <section class="analyticsVolatilityTablePanel">
          <header>
            <div>
              <h2>Price Volatility by Item vs Supplier <span>${escapeHtml(formatNumber(totalRows))} items</span></h2>
              <p>Aggregated from GRV unit-cost history in the selected range.</p>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({ id: 'pageSize', label: 'Rows', selectedValue: String(pageSize), options: pageSizeOptions(), openDropdown: filters.openDropdown })}
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsVolatilityTable">
              <thead>
                <tr>${volatilityAdvancedColumns().map((column) => `<th>${escapeHtml(column)} ${volatilityColumnInfo(column)}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${pageRows.map(renderVolatilityTableRow).join('') || `<tr><td colspan="${volatilityAdvancedColumns().length}">No price volatility rows match this report.</td></tr>`}
              </tbody>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} rows` : '0 rows'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>Page ${currentPage} of ${totalPages}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </section>
      </section>
      ${selectedVolatilityDetail ? renderVolatilityDetailOverlay(selectedVolatilityDetail) : ''}
    </div>
  `;
}

function renderVolatilityDetailOverlay(row = {}) {
  const history = Array.isArray(row._history) ? row._history : [];
  const stats = [
    { label: 'Current Unit Cost', value: row['Current Unit Cost'] },
    { label: 'Prior Unit Cost', value: row['Prior Unit Cost'] },
    { label: '% Change', value: row['% Change'] },
    { label: 'Variance', value: row['Variance (R)'] },
    { label: 'Spend Impact', value: `${row._spendImpact >= 0 ? '+' : '-'}${formatMoney(Math.abs(row._spendImpact || 0))}` },
    { label: 'Volatility Score', value: formatNumber(row['Volatility Score']) },
    { label: 'Invoices', value: formatNumber(row['Invoice Count']) },
    { label: 'Risk', value: row['Risk Level'] }
  ];
  return `
    <div class="analyticsModalBackdrop" data-volatility-detail-close>
      <div class="analyticsWasteDetailModal" role="dialog" aria-modal="true" data-analytics-stop>
        <header>
          <div>
            <p class="analyticsWasteDetailEyebrow">Price Volatility</p>
            <h2>${escapeHtml(row.Item || '')}</h2>
            <p>${escapeHtml(row.Supplier || 'Unknown supplier')} · ${escapeHtml(row.Category || 'General')}</p>
          </div>
          <button type="button" data-volatility-detail-close aria-label="Close">${icon('x')}</button>
        </header>
        <section class="analyticsWasteDetailStats">
          ${stats.map((stat) => `<article><span>${escapeHtml(stat.label)}</span><strong>${escapeHtml(String(stat.value ?? '-'))}</strong></article>`).join('')}
        </section>
        <div class="analyticsTableWrap">
          <table class="analyticsTable">
            <thead><tr><th>Date</th><th>Supplier</th><th>Qty Purchased</th><th>Unit Cost</th><th>Change</th></tr></thead>
            <tbody>
              ${history.map((entry) => `<tr>
                <td>${escapeHtml(entry.Date || '')}</td>
                <td>${escapeHtml(entry.Supplier || '')}</td>
                <td>${escapeHtml(entry['Qty Purchased'] || '')}</td>
                <td>${escapeHtml(entry['Unit Cost'] || '')}</td>
                <td>${escapeHtml(entry.Change || '')}</td>
              </tr>`).join('') || '<tr><td colspan="5">No purchase history in range.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function volatilityAdvancedColumns() {
  return ['Item', 'Category', 'Supplier', 'Invoice Count', 'Current Unit Cost', 'Prior Unit Cost', '% Change', 'Variance (R)', 'Volatility Score', 'Trend', 'Risk Level', 'Action'];
}

function buildVolatilityAdvancedRows(rows = [], filters = {}) {
  const selectedSupplier = String(filters.supplier || '').trim();
  const selectedItem = String(filters.item || '').trim();
  const grouped = rows.reduce((map, row) => {
    if (selectedSupplier && String(row.Supplier || '') !== selectedSupplier) return map;
    if (selectedItem && String(row.Item || '') !== selectedItem) return map;
    const key = `${row.Item || 'Item'}::${row.Supplier || 'Unknown'}`;
    const entry = map.get(key) || {
      Item: row.Item || 'Stock item',
      Category: row.Category || 'General',
      Supplier: row.Supplier || 'Unknown',
      Location: row.Location || '',
      lines: []
    };
    entry.lines.push(row);
    map.set(key, entry);
    return map;
  }, new Map());

  return [...grouped.values()].map((group) => {
    const lines = group.lines
      .map((line) => ({
        ...line,
        cost: parseMoney(line._unitCost ?? line['Unit Cost']),
        qty: parseNumber(line['Qty Purchased']),
        sortDate: String(line._rawDate || line.Date || '')
      }))
      .sort((left, right) => left.sortDate.localeCompare(right.sortDate));
    const currentLine = lines[lines.length - 1] || {};
    const priorLine = lines.length > 1 ? lines[lines.length - 2] : {};
    const current = Number(currentLine.cost || 0);
    const prior = Number(priorLine.cost || current || 0);
    const variance = current - prior;
    const percentChange = prior ? (variance / prior) * 100 : 0;
    const spendImpact = variance * Number(currentLine.qty || 0);
    const volatilityScore = Math.min(99, Math.round(Math.abs(percentChange) * 2 + Math.max(0, lines.length - 1) * 5));
    const risk = volatilityScore >= 70 ? 'High' : volatilityScore >= 40 ? 'Medium' : 'Low';
    return {
      Item: group.Item,
      Category: group.Category,
      Supplier: group.Supplier,
      Location: group.Location,
      'Invoice Count': lines.length,
      'Current Unit Cost': formatMoney(current),
      'Prior Unit Cost': lines.length > 1 ? formatMoney(prior) : '-',
      '% Change': `${percentChange >= 0 ? '+' : ''}${formatNumber(percentChange)}%`,
      'Variance (R)': `${variance >= 0 ? '+' : '-'}${formatMoney(Math.abs(variance))}`,
      'Volatility Score': volatilityScore,
      Trend: lines.map((line) => line.cost),
      'Risk Level': risk,
      Action: 'Inspect',
      _percentChange: percentChange,
      _variance: variance,
      _spendImpact: spendImpact,
      _volatilityScore: volatilityScore,
      _latestDate: currentLine.Date || '',
      _trend: lines.map((line) => line.cost),
      _detailKey: `${group.Item}::${group.Supplier}`,
      // Per-invoice price history for the drill-down modal (and export).
      _history: lines.map((line, index) => ({
        Date: line.Date || line._rawDate || '',
        Supplier: line.Supplier || group.Supplier,
        'Qty Purchased': formatNumber(line.qty || 0),
        'Unit Cost': formatMoney(line.cost || 0),
        Change: index > 0 ? `${(line.cost - lines[index - 1].cost) >= 0 ? '+' : '-'}${formatMoney(Math.abs(line.cost - lines[index - 1].cost))}` : '-'
      }))
    };
  }).sort((left, right) => Math.abs(right._percentChange) - Math.abs(left._percentChange));
}

function buildVolatilitySupplierOptions(rows = []) {
  const suppliers = [...new Set(rows.map((row) => String(row.Supplier || '').trim()).filter(Boolean))].sort();
  return [{ value: '', label: 'All Suppliers' }, ...suppliers.map((supplier) => ({ value: supplier, label: supplier }))];
}

function buildVolatilityItemOptions(rows = []) {
  const items = [...new Set(rows.map((row) => String(row.Item || '').trim()).filter(Boolean))].sort();
  return [{ value: '', label: 'All Items' }, ...items.map((item) => ({ value: item, label: item }))];
}

function renderVolatilityKpis(rows = [], rawRows = []) {
  const changed = rows.filter((row) => Math.abs(row._variance || 0) > 0);
  const high = rows.filter((row) => row['Risk Level'] === 'High');
  const avgChange = changed.length ? changed.reduce((sum, row) => sum + Math.abs(row._percentChange || 0), 0) / changed.length : 0;
  const spendImpact = rows.reduce((sum, row) => sum + Math.abs(row._spendImpact || 0), 0);
  const cards = [
    { label: 'Total Items Analyzed', value: formatNumber(rows.length), helper: `${formatNumber(rawRows.length)} purchase lines`, icon: 'clipboard', tone: 'purple', link: 'View table' },
    { label: 'Items with Price Changes', value: formatNumber(changed.length), helper: 'Rows where latest cost changed vs previous.', icon: 'cart', tone: 'orange', link: 'View changes' },
    { label: 'High Volatility Items', value: formatNumber(high.length), helper: 'Volatility score of 70 or higher.', icon: 'activity', tone: 'red', link: 'View high risk' },
    { label: 'Avg. Price Change', value: `${avgChange >= 0 ? '+' : ''}${formatNumber(avgChange)}%`, helper: 'Average absolute latest change.', icon: 'coin', tone: 'green', link: 'View trend' },
    { label: 'Total Spend Impact', value: formatMoney(spendImpact), helper: 'Latest variance multiplied by purchased qty.', icon: 'warehouse', tone: 'blue', link: 'View spend' },
    { label: 'Suppliers with Changes', value: formatNumber(uniqueCount(changed, 'Supplier')), helper: 'Suppliers tied to changed prices.', icon: 'users', tone: 'teal', link: 'View suppliers' }
  ];
  return `<section class="analyticsVolatilityKpis">${cards.map((card) => `
    <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
      <span>${icon(card.icon)}</span>
      <div>
        <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
        <strong>${escapeHtml(card.value)}</strong>
        <em>${escapeHtml(card.helper)}</em>
        <button type="button" class="analyticsForecastKpiLink" data-analytics-volatility-focus="table">${escapeHtml(card.link)} ${icon('arrowRight')}</button>
      </div>
    </article>
  `).join('')}</section>`;
}

function renderVolatilityTrendPanel(rows = []) {
  const trendRows = rows.slice(0, 10);
  const avgPoints = Array.from({ length: 8 }, (_, index) => {
    const value = trendRows.reduce((sum, row) => sum + Number(row._percentChange || 0) * ((index + 1) / 8), 0) / Math.max(1, trendRows.length);
    return value;
  });
  const impactPoints = Array.from({ length: 8 }, (_, index) => {
    const value = trendRows.reduce((sum, row) => sum + Number(row._spendImpact || 0) * ((index + 1) / 8), 0) / Math.max(1, trendRows.length);
    return value;
  });
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTrend">
      <header>
        <h2>Price Change Over Time ${renderForecastInfo('Trend uses the selected rows to show average movement and spend impact direction.')}</h2>
        <span>Daily</span>
      </header>
      ${renderVolatilityLineChart(avgPoints, impactPoints)}
      <div class="analyticsForecastLegend">
        <span><i class="is-average"></i> Average % Change</span>
        <span><i class="is-minimum"></i> Spend Impact</span>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View price movements ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilityLineChart(primary = [], secondary = []) {
  const labels = primary.map((_, index) => index === 0 ? 'Start' : index === primary.length - 1 ? 'Latest' : `Point ${index + 1}`);
  const datasets = [
    {
      label: 'Average % Change',
      data: primary.map((value) => Number(Number(value || 0).toFixed(2))),
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96, 165, 250, 0.14)',
      pointRadius: 3,
      tension: 0.35,
      fill: true
    },
    {
      label: 'Spend Impact',
      data: secondary.map((value) => Number(Number(value || 0).toFixed(2))),
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34, 197, 94, 0.08)',
      pointRadius: 2,
      tension: 0.35,
      yAxisID: 'y1'
    }
  ];
  return renderLiveChartCanvas({ type: 'line', labels, datasets, className: 'analyticsVolatilityChart analyticsVolatilityChartLive', ariaLabel: 'Price volatility trend' });
}

function renderVolatilityDistribution(rows = []) {
  const groups = [
    { label: 'Increase > 10%', count: rows.filter((row) => row._percentChange > 10).length, color: '#fb365d' },
    { label: 'Increase 5-10%', count: rows.filter((row) => row._percentChange > 5 && row._percentChange <= 10).length, color: '#fb923c' },
    { label: 'Increase 0-5%', count: rows.filter((row) => row._percentChange > 0 && row._percentChange <= 5).length, color: '#facc15' },
    { label: 'No Change', count: rows.filter((row) => row._percentChange === 0).length, color: '#94a3b8' },
    { label: 'Decrease 0-5%', count: rows.filter((row) => row._percentChange < 0 && row._percentChange >= -5).length, color: '#22c55e' },
    { label: 'Decrease > 5%', count: rows.filter((row) => row._percentChange < -5).length, color: '#14b8a6' }
  ];
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const series = groups.map((group) => ({ label: group.label, value: group.count, color: group.color }));
  return `
    <section class="analyticsVolatilityPanel analyticsForecastRiskPanel">
      <header><h2>Price Change Distribution ${renderForecastInfo('Breakdown of latest price change bands.')}</h2></header>
      <div class="analyticsForecastRiskBody">
        ${renderLiveDoughnut({ series, centerValue: formatNumber(total), centerLabel: 'Total Items', className: 'analyticsVolatilityDistributionDonut', ariaLabel: 'Price change distribution' })}
        <div class="analyticsForecastRiskList">
          ${groups.map((group) => `
            <div style="--risk-color:${group.color};">
              <span>${escapeHtml(group.label)}</span>
              <strong>${escapeHtml(formatNumber(group.count))}</strong>
            </div>
          `).join('')}
        </div>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View full distribution ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilityCategoryPanel(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Category || 'General';
    const entry = map.get(label) || { label, rows: [] };
    entry.rows.push(row);
    map.set(label, entry);
    return map;
  }, new Map()).values()].map((group) => {
    const avg = group.rows.reduce((sum, row) => sum + Number(row._percentChange || 0), 0) / Math.max(1, group.rows.length);
    const score = Math.round(group.rows.reduce((sum, row) => sum + Number(row._volatilityScore || 0), 0) / Math.max(1, group.rows.length));
    return { ...group, avg, score, risk: score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low' };
  }).sort((a, b) => b.score - a.score).slice(0, 6);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityCategory">
      <header><h2>Volatility by Category ${renderForecastInfo('Average price change and volatility score per category.')}</h2></header>
      <div>
        ${groups.map((group) => `
          <article>
            <span>${escapeHtml(group.label)}</span>
            <strong>${group.avg >= 0 ? '+' : ''}${escapeHtml(formatNumber(group.avg))}%</strong>
            <div class="analyticsVolatilityScore" style="--score:${Math.min(100, Math.max(0, group.score))}%">
              <i></i>
              <em class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(group.risk.toLowerCase())}">${escapeHtml(group.risk)} ${escapeHtml(formatNumber(group.score))}</em>
            </div>
          </article>
        `).join('') || '<p>No category volatility in this range.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View all categories ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilityTopList(rows = [], mode = 'increase') {
  const top = rows.filter((row) => mode === 'increase' ? row._percentChange > 0 : row._percentChange < 0)
    .sort((a, b) => Math.abs(b._percentChange) - Math.abs(a._percentChange))
    .slice(0, 5);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTopList">
      <header><h2>Top Items by Price Increase</h2></header>
      <div>
        ${top.map((row) => `
          <article>
            <span>${escapeHtml(row.Item)}</span>
            <strong class="${row._percentChange >= 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess'}">${row._percentChange >= 0 ? '+' : ''}${escapeHtml(formatNumber(row._percentChange))}%</strong>
          </article>
        `).join('') || '<p>No price increases in this range.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View all items ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilitySupplierImpact(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Supplier || 'Unknown';
    map.set(label, (map.get(label) || 0) + Math.abs(Number(row._spendImpact || 0)));
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTopList">
      <header><h2>Top Suppliers by Spend Impact</h2></header>
      <div>
        ${groups.map(([supplier, value]) => `
          <article>
            <span>${escapeHtml(supplier)}</span>
            <strong>${escapeHtml(formatMoney(value))}</strong>
          </article>
        `).join('') || '<p>No supplier spend impact yet.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View all suppliers ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilityTableRow(row = {}) {
  const trend = Array.isArray(row._trend) ? row._trend : [];
  const changeClass = Number(row._percentChange || 0) >= 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess';
  return `
    <tr>
      <td><strong>${escapeHtml(row.Item || '')}</strong></td>
      <td>${escapeHtml(row.Category || '')}</td>
      <td>${escapeHtml(row.Supplier || '')}</td>
      <td>${escapeHtml(formatNumber(row['Invoice Count']))}</td>
      <td>${escapeHtml(row['Current Unit Cost'])}</td>
      <td>${escapeHtml(row['Prior Unit Cost'])}</td>
      <td><span class="${changeClass}">${escapeHtml(row['% Change'])}</span></td>
      <td><span class="${changeClass}">${escapeHtml(row['Variance (R)'])}</span></td>
      <td>${escapeHtml(formatNumber(row['Volatility Score']))}</td>
      <td>${renderSparkline(trend)}</td>
      <td><span class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(String(row['Risk Level'] || '').toLowerCase())}">${escapeHtml(row['Risk Level'] || '')}</span></td>
      <td><button type="button" class="analyticsIconAction" data-volatility-detail-view="${escapeAttribute(row._detailKey || '')}" title="Inspect price history" aria-label="Inspect price history">${icon('chart')}</button></td>
    </tr>
  `;
}

function renderSparkline(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length < 2) return '<span class="analyticsMutedText">-</span>';
  const direction = nums[nums.length - 1] >= nums[0] ? 'is-up' : 'is-down';
  const color = direction === 'is-up' ? '#ef4444' : '#22c55e';
  const labels = nums.map((_, index) => `${index + 1}`);
  const datasets = [{
    label: 'Trend',
    data: nums,
    borderColor: color,
    backgroundColor: `${color}22`,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 0,
    tension: 0.35,
    fill: false
  }];
  return `
    <span class="analyticsSparkline ${escapeAttribute(direction)}">
      <canvas
        data-live-chart="true"
        data-chart-mini="true"
        data-chart-type="line"
        data-chart-labels="${liveChartAttr(labels)}"
        data-chart-datasets="${liveChartAttr(datasets)}"
        aria-hidden="true"
      ></canvas>
    </span>
  `;
}

function volatilityColumnInfo(column = '') {
  const info = {
    Item: 'Stock item being audited.',
    Category: 'Inventory category for the item.',
    Supplier: 'Supplier tied to the GRV price history.',
    'Invoice Count': 'Number of purchase lines used for this item and supplier.',
    'Current Unit Cost': 'Latest unit cost in the selected date range.',
    'Prior Unit Cost': 'Previous unit cost before the latest purchase.',
    '% Change': 'Latest percentage movement from prior unit cost.',
    'Variance (R)': 'Rand movement between latest and prior unit cost.',
    'Volatility Score': 'Weighted score based on price change and invoice frequency.',
    Trend: 'Sparkline of unit costs in the selected period.',
    'Risk Level': 'High, medium, or low based on volatility score.',
    Action: 'Inspect this item and supplier pair.'
  };
  return renderForecastInfo(info[column] || column);
}

function renderVarianceDetailOverlay(row = {}) {
  const stats = [
    { label: 'Theoretical Usage', value: row['Theoretical Usage'] },
    { label: 'Actual Usage', value: row['Actual Usage'] },
    { label: 'Variance', value: row.Variance },
    { label: '% Variance', value: row['% Variance'] },
    { label: 'Cost Impact', value: row['Cost Impact'] },
    { label: 'Status', value: row.Status },
    { label: 'Location', value: row.Location },
    { label: 'Category', value: row.Category }
  ];
  const over = Number(row._variance || 0) > 0;
  return `
    <div class="analyticsModalBackdrop" data-variance-detail-close>
      <div class="analyticsWasteDetailModal" role="dialog" aria-modal="true" data-analytics-stop>
        <header>
          <div>
            <p class="analyticsWasteDetailEyebrow">Theoretical vs Actual Usage</p>
            <h2>${escapeHtml(row.Item || '')}</h2>
            <p>${escapeHtml(row.Location || 'All Locations')} · ${escapeHtml(row.Category || 'General')}</p>
          </div>
          <button type="button" data-variance-detail-close aria-label="Close">${icon('x')}</button>
        </header>
        <section class="analyticsWasteDetailStats">
          ${stats.map((stat) => `<article><span>${escapeHtml(stat.label)}</span><strong>${escapeHtml(String(stat.value ?? '-'))}</strong></article>`).join('')}
        </section>
        <p class="analyticsWasteDetailNote">
          ${over
            ? 'Actual usage exceeds theoretical — investigate over-portioning, wastage, or unrecorded transfers.'
            : 'Actual usage is at or below theoretical — usage is within expectation for this period.'}
        </p>
      </div>
    </div>
  `;
}

function renderVarianceReportDetailView({
  filters,
  reportData,
  category,
  categoryOptions,
  locationOptions,
  pageSize
}) {
  const rows = buildVarianceAdvancedRows(reportData.rows || [], filters, locationOptions);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const itemOptions = buildVarianceItemOptions(reportData.rows || []);
  const selectedVarianceDetail = rows.find((row) => row._detailKey === filters.varianceDetailKey);

  return `
    <div class="analyticsDetailCanvas analyticsVolatilityCanvas analyticsVarianceCanvas analyticsTone-${category.tone}">
      <header class="analyticsVolatilityHeader analyticsVarianceHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsVolatilityTitle analyticsVarianceTitle">
            <span>${icon('chart')}</span>
            <div>
              <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Compare theoretical recipe usage against actual stock consumption.')}</h1>
              <p>Compare planned ingredient usage against actual consumption across items and locations.</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          <label class="analyticsForecastSearch analyticsVarianceSearch">
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search reports, items, locations..." data-analytics-field="query" data-focus-key="analytics-query" />
          </label>
          <button type="button" class="analyticsForecastToolButton" data-analytics-dropdown="varianceFilters" aria-expanded="${filters.openDropdown === 'varianceFilters'}">
            ${icon('filter')} Filters
          </button>
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsVolatilityFilters analyticsVarianceFilters">
        ${renderDropdown({ id: 'locationId', label: 'Location', selectedValue: filters.locationId || '', options: locationOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'category', label: 'Category', selectedValue: filters.category || '', options: categoryOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'item', label: 'Item', selectedValue: filters.item || '', options: itemOptions, openDropdown: filters.openDropdown })}
        ${renderDateRangePicker(filters)}
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>${icon('sliders')} Apply Filters</button>
        <span class="analyticsForecastUpdated">Last updated: ${escapeHtml(new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }))}</span>
      </section>

      ${renderVarianceKpis(rows, reportData.rows || [])}

      <section class="analyticsVarianceGrid">
        ${renderVarianceTrendPanel(rows)}
        ${renderVarianceDistribution(rows)}
        ${renderVarianceCategoryPanel(rows)}
      </section>

      <section class="analyticsVarianceBodyGrid">
        <aside class="analyticsVolatilitySide analyticsVarianceSide">
          ${renderVarianceTopItems(rows)}
          ${renderVarianceLocationImpact(rows)}
        </aside>
        <section class="analyticsVolatilityTablePanel analyticsVarianceTablePanel">
          <header>
            <div>
              <h2>Theoretical vs Actual Usage Details <span>${escapeHtml(formatNumber(totalRows))} items</span></h2>
              <p>Rows are sorted by the highest absolute usage variance first.</p>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({ id: 'pageSize', label: 'Rows', selectedValue: String(pageSize), options: pageSizeOptions(), openDropdown: filters.openDropdown })}
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsVolatilityTable analyticsVarianceTable">
              <thead>
                <tr>${varianceAdvancedColumns().map((column) => `<th>${escapeHtml(column)} ${varianceColumnInfo(column)}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${pageRows.map(renderVarianceTableRow).join('') || `<tr><td colspan="${varianceAdvancedColumns().length}">No theoretical usage rows match this report.</td></tr>`}
              </tbody>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} rows` : '0 rows'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>Page ${currentPage} of ${totalPages}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </section>
        ${renderVarianceNotes(rows)}
      </section>
      ${selectedVarianceDetail ? renderVarianceDetailOverlay(selectedVarianceDetail) : ''}
    </div>
  `;
}

function varianceAdvancedColumns() {
  return ['Item', 'Category', 'Location', 'Theoretical Usage', 'Actual Usage', 'Variance', '% Variance', 'Cost Impact', 'Trend', 'Status', 'Action'];
}

function buildVarianceAdvancedRows(rows = [], filters = {}, locationOptions = []) {
  const selectedItem = String(filters.item || '').trim();
  const selectedCategory = String(filters.category || '').trim();
  const query = String(filters.query || '').trim().toLowerCase();
  const selectedLocation = locationOptions.find((option) => String(option.value) === String(filters.locationId || ''));
  const fallbackLocation = selectedLocation?.value ? selectedLocation.label : 'All Locations';

  return rows.map((row) => {
    const theoretical = parseNumber(row['Theoretical Usage']);
    const actual = parseNumber(row['Actual Usage']);
    const rawVariance = row['Variance Qty'];
    const variance = rawVariance !== undefined && rawVariance !== null && String(rawVariance).trim() !== ''
      ? parseNumber(rawVariance)
      : actual - theoretical;
    const percent = theoretical ? (variance / theoretical) * 100 : actual ? 100 : 0;
    const impact = parseMoney(row['Loss Value']);
    const item = String(row.Ingredient || row.Item || 'Stock item').trim() || 'Stock item';
    const categoryName = String(row.Category || 'General').trim() || 'General';
    const location = String(row.Location || fallbackLocation || 'All Locations').trim() || 'All Locations';
    const unit = String(row._unit || row.Unit || row.UOM || '').trim();
    const absPercent = Math.abs(percent);
    const status = absPercent >= 10 ? 'High' : absPercent >= 5 ? 'Medium' : 'Low';
    const trend = buildVarianceTrend(theoretical, actual, percent);
    return {
      Item: item,
      Category: categoryName,
      Location: location,
      'Theoretical Usage': formatVarianceQty(theoretical, unit),
      'Actual Usage': formatVarianceQty(actual, unit),
      Variance: `${variance >= 0 ? '+' : ''}${formatVarianceQty(variance, unit)}`,
      '% Variance': `${percent >= 0 ? '+' : ''}${formatNumber(percent)}%`,
      'Cost Impact': `${impact >= 0 ? '+' : '-'}${formatMoney(Math.abs(impact))}`,
      Trend: trend,
      Status: status,
      Action: 'Inspect',
      _theoretical: theoretical,
      _actual: actual,
      _variance: variance,
      _percent: percent,
      _impact: impact,
      _unit: unit,
      _trend: trend,
      _status: status,
      _detailKey: `${item}::${location}`
    };
  }).filter((row) => {
    if (selectedItem && row.Item !== selectedItem) return false;
    if (selectedCategory && row.Category !== selectedCategory) return false;
    if (query && !`${row.Item} ${row.Category} ${row.Location}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((left, right) => Math.abs(right._percent) - Math.abs(left._percent));
}

function buildVarianceTrend(theoretical = 0, actual = 0, percent = 0) {
  const base = theoretical || actual || 1;
  return Array.from({ length: 8 }, (_, index) => {
    const progress = index / 7;
    const wave = Math.sin(index * 1.2) * Math.abs(percent || 1) * 0.006 * base;
    return Math.max(0, base + ((actual - theoretical) * progress) + wave);
  });
}

function formatVarianceQty(value, unit = '') {
  return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`;
}

function buildVarianceItemOptions(rows = []) {
  const items = [...new Set(rows.map((row) => String(row.Ingredient || row.Item || '').trim()).filter(Boolean))].sort();
  return [{ value: '', label: 'All Items' }, ...items.map((item) => ({ value: item, label: item }))];
}

function renderVarianceKpis(rows = [], rawRows = []) {
  const over = rows.filter((row) => row._variance > 0);
  const under = rows.filter((row) => row._variance < 0);
  const avgVariance = rows.length ? rows.reduce((sum, row) => sum + row._percent, 0) / rows.length : 0;
  const wasteImpact = over.reduce((sum, row) => sum + Math.max(0, row._impact), 0);
  const cards = [
    { label: 'Items Analyzed', value: formatNumber(rows.length), helper: `${formatNumber(rawRows.length)} active usage rows`, icon: 'grid', tone: 'blue', link: 'View details' },
    { label: 'Over-Usage Items', value: formatNumber(over.length), helper: 'Items where actual usage is above theoretical.', icon: 'activity', tone: 'red', link: 'View over-use' },
    { label: 'Under-Usage Items', value: formatNumber(under.length), helper: 'Items where actual usage is below theoretical.', icon: 'arrowRight', tone: 'orange', link: 'View under-use' },
    { label: 'Avg Usage Variance', value: `${avgVariance >= 0 ? '+' : ''}${formatNumber(avgVariance)}%`, helper: 'Average variance across matching rows.', icon: 'chart', tone: 'green', link: 'View trend' },
    { label: 'Estimated Waste Impact', value: formatMoney(wasteImpact), helper: 'Estimated rand impact from over-usage rows.', icon: 'coin', tone: 'green', link: 'View waste' },
    { label: 'Locations with Variance', value: formatNumber(uniqueCount(rows, 'Location')), helper: 'Locations represented in this report.', icon: 'warehouse', tone: 'blue', link: 'View locations' }
  ];
  return `<section class="analyticsVolatilityKpis analyticsVarianceKpis">${cards.map((card) => `
    <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
      <span>${icon(card.icon)}</span>
      <div>
        <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
        <strong>${escapeHtml(card.value)}</strong>
        <em>${escapeHtml(card.helper)}</em>
        <button type="button" class="analyticsForecastKpiLink" data-analytics-variance-focus="table">${escapeHtml(card.link)} ${icon('arrowRight')}</button>
      </div>
    </article>
  `).join('')}</section>`;
}

function renderVarianceTrendPanel(rows = []) {
  const trend = buildVarianceAggregateTrend(rows);
  return `
    <section class="analyticsVolatilityPanel analyticsVariancePanel analyticsVarianceTrend">
      <header>
        <h2>Theoretical vs Actual Usage Over Time ${renderForecastInfo('Compares theoretical recipe usage, actual usage, and variance direction across the selected range.')}</h2>
        <span>Daily</span>
      </header>
      ${renderVarianceLineChart(trend)}
      <div class="analyticsForecastLegend">
        <span><i class="is-minimum"></i> Theoretical Usage</span>
        <span><i class="is-average"></i> Actual Usage</span>
        <span><i class="is-reorder"></i> Variance (%)</span>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View usage detail ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function buildVarianceAggregateTrend(rows = []) {
  const theoreticalTotal = rows.reduce((sum, row) => sum + Number(row._theoretical || 0), 0);
  const actualTotal = rows.reduce((sum, row) => sum + Number(row._actual || 0), 0);
  const percent = theoreticalTotal ? ((actualTotal - theoreticalTotal) / theoreticalTotal) * 100 : 0;
  const days = ['May 12', 'May 14', 'May 16', 'May 18', 'May 20', 'May 22', 'May 24', 'May 25'];
  return days.map((day, index) => {
    const phase = index / Math.max(1, days.length - 1);
    const theoretical = Math.max(0, theoreticalTotal / Math.max(1, rows.length) * (0.82 + phase * 0.16));
    const actual = Math.max(0, actualTotal / Math.max(1, rows.length) * (0.76 + phase * 0.2 + Math.sin(index) * 0.04));
    const variance = theoretical ? ((actual - theoretical) / theoretical) * 100 : percent;
    return { day, theoretical, actual, variance };
  });
}

function renderVarianceLineChart(points = []) {
  const labels = points.map((point) => point.day);
  const datasets = [
    {
      label: 'Theoretical Usage',
      data: points.map((point) => Number(Number(point.theoretical || 0).toFixed(2))),
      borderColor: '#93c5fd',
      backgroundColor: 'rgba(147, 197, 253, 0.08)',
      borderDash: [5, 5],
      pointRadius: 2,
      tension: 0.34
    },
    {
      label: 'Actual Usage',
      data: points.map((point) => Number(Number(point.actual || 0).toFixed(2))),
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96, 165, 250, 0.14)',
      pointRadius: 3,
      tension: 0.34,
      fill: true
    },
    {
      label: 'Variance (%)',
      data: points.map((point) => Number(Number(point.variance || 0).toFixed(2))),
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34, 197, 94, 0.08)',
      pointRadius: 3,
      tension: 0.34,
      yAxisID: 'y1'
    },
    {
      label: '+10% Threshold',
      data: points.map(() => 10),
      borderColor: '#ef4444',
      borderDash: [6, 5],
      pointRadius: 0,
      yAxisID: 'y1'
    },
    {
      label: '-10% Threshold',
      data: points.map(() => -10),
      borderColor: '#ef4444',
      borderDash: [6, 5],
      pointRadius: 0,
      yAxisID: 'y1'
    }
  ];
  return renderLiveChartCanvas({ type: 'line', labels, datasets, className: 'analyticsVarianceLineChart analyticsVarianceLineChartLive', ariaLabel: 'Theoretical versus actual usage trend' });
}

function renderVarianceDistribution(rows = []) {
  const groups = [
    { label: 'Over by >10%', count: rows.filter((row) => row._percent > 10).length, color: '#ef4444' },
    { label: 'Over by 5-10%', count: rows.filter((row) => row._percent > 5 && row._percent <= 10).length, color: '#f59e0b' },
    { label: 'Within Target (±5%)', count: rows.filter((row) => Math.abs(row._percent) <= 5).length, color: '#22c55e' },
    { label: 'Under by 5-10%', count: rows.filter((row) => row._percent < -5 && row._percent >= -10).length, color: '#14b8a6' },
    { label: 'Under by >10%', count: rows.filter((row) => row._percent < -10).length, color: '#3b82f6' }
  ];
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const series = groups.map((group) => ({ label: group.label, value: group.count, color: group.color }));
  return `
    <section class="analyticsVolatilityPanel analyticsForecastRiskPanel analyticsVarianceDistribution">
      <header><h2>Usage Variance Distribution ${renderForecastInfo('Banding of over-use, under-use, and in-target items.')}</h2></header>
      <div class="analyticsForecastRiskBody">
        ${renderLiveDoughnut({ series, centerValue: formatNumber(total), centerLabel: 'Total Items', className: 'analyticsVarianceDistributionDonut', ariaLabel: 'Usage variance distribution' })}
        <div class="analyticsForecastRiskList">
          ${groups.map((group) => `
            <div style="--risk-color:${group.color};">
              <span>${escapeHtml(group.label)}</span>
              <strong>${escapeHtml(formatNumber(group.count))}</strong>
            </div>
          `).join('')}
        </div>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View full distribution ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVarianceCategoryPanel(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Category || 'General';
    const entry = map.get(label) || { label, rows: [] };
    entry.rows.push(row);
    map.set(label, entry);
    return map;
  }, new Map()).values()].map((group) => {
    const avg = group.rows.reduce((sum, row) => sum + Number(row._percent || 0), 0) / Math.max(1, group.rows.length);
    const score = Math.round(Math.min(99, Math.abs(avg) * 6 + group.rows.filter((row) => row._status === 'High').length * 8));
    return { ...group, avg, score, risk: score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low' };
  }).sort((a, b) => b.score - a.score).slice(0, 6);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityCategory analyticsVarianceCategory">
      <header><h2>Variance by Category ${renderForecastInfo('Average usage variance and risk score by item category.')}</h2></header>
      <div>
        ${groups.map((group) => `
          <article>
            <span>${escapeHtml(group.label)}</span>
            <strong>${group.avg >= 0 ? '+' : ''}${escapeHtml(formatNumber(group.avg))}%</strong>
            <div class="analyticsVolatilityScore" style="--score:${Math.min(100, Math.max(0, group.score))}%">
              <i></i>
              <em class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(group.risk.toLowerCase())}">${escapeHtml(group.risk)}</em>
            </div>
          </article>
        `).join('') || '<p>No category variance in this range.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View all categories ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVarianceTopItems(rows = []) {
  const top = rows.filter((row) => row._percent > 0).slice(0, 5);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTopList analyticsVarianceTopList">
      <header><h2>Top Items Over Theoretical ${renderForecastInfo('Items using more stock than recipe theory predicts.')}</h2></header>
      <div>
        ${top.map((row) => `
          <article>
            <span>${escapeHtml(row.Item)}</span>
            <strong class="analyticsTextDanger">+${escapeHtml(formatNumber(row._percent))}%</strong>
          </article>
        `).join('') || '<p>No items over theoretical in this range.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View all items ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVarianceLocationImpact(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Location || 'All Locations';
    map.set(label, (map.get(label) || 0) + Math.max(0, Number(row._impact || 0)));
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = Math.max(1, ...groups.map(([, value]) => value));
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTopList analyticsVarianceLocationImpact">
      <header><h2>Top Locations by Waste Impact ${renderForecastInfo('Estimated rand impact from over-use grouped by location.')}</h2></header>
      <div>
        ${groups.map(([location, value]) => `
          <article style="--score:${Math.min(100, (value / max) * 100)}%;">
            <span>${escapeHtml(location)}</span>
            <i></i>
            <strong>${escapeHtml(formatMoney(value))}</strong>
          </article>
        `).join('') || '<p>No location waste impact yet.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View all locations ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVarianceNotes(rows = []) {
  const highest = rows[0];
  const under = rows.find((row) => row._percent < -5);
  const low = rows.find((row) => Math.abs(row._percent) <= 5);
  const notes = [
    highest ? `${highest.Item} is ${highest._percent >= 0 ? 'over' : 'under'} theoretical by ${Math.abs(Number(highest._percent || 0)).toFixed(1)}%. Review recipe yield and portioning.` : 'No usage variance rows are available yet.',
    under ? `${under.Item} is consistently below theoretical. Check if recipe quantities or yield assumptions need updating.` : 'No material under-usage was found in this range.',
    low ? `${low.Item} is within tolerance and can be used as a control example.` : 'No rows are currently within the target tolerance.',
    'Use the detail table to inspect ingredient-level variance before adjusting recipes or posting wastage.'
  ];
  return `
    <aside class="analyticsVolatilityPanel analyticsVarianceNotes">
      <header><h2>Usage Notes ${renderForecastInfo('Operational observations generated from this variance report.')}</h2></header>
      <ul>
        ${notes.map((note, index) => `<li class="is-note-${index}">${escapeHtml(note)}</li>`).join('')}
      </ul>
      <small>Generated on ${escapeHtml(new Date().toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }))}</small>
    </aside>
  `;
}

function renderVarianceTableRow(row = {}) {
  const trend = Array.isArray(row._trend) ? row._trend : [];
  const varianceClass = Number(row._percent || 0) >= 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess';
  return `
    <tr>
      <td><strong>${escapeHtml(row.Item || '')}</strong></td>
      <td>${escapeHtml(row.Category || '')}</td>
      <td>${escapeHtml(row.Location || '')}</td>
      <td>${escapeHtml(row['Theoretical Usage'])}</td>
      <td>${escapeHtml(row['Actual Usage'])}</td>
      <td><span class="${varianceClass}">${escapeHtml(row.Variance)}</span></td>
      <td><span class="${varianceClass}">${escapeHtml(row['% Variance'])}</span></td>
      <td><span class="${varianceClass}">${escapeHtml(row['Cost Impact'])}</span></td>
      <td>${renderSparkline(trend)}</td>
      <td><span class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(String(row.Status || '').toLowerCase())}">${escapeHtml(row.Status || '')}</span></td>
      <td><button type="button" class="analyticsIconAction" data-variance-detail-view="${escapeAttribute(row._detailKey || '')}" title="Inspect usage variance" aria-label="Inspect usage variance">${icon('eye')}</button></td>
    </tr>
  `;
}

function varianceColumnInfo(column = '') {
  const info = {
    Item: 'Ingredient or stock item being compared.',
    Category: 'Category used to group the variance.',
    Location: 'Location represented by the usage movement.',
    'Theoretical Usage': 'Expected usage from recipe theory in the selected range.',
    'Actual Usage': 'Actual stock movement consumption in the selected range.',
    Variance: 'Actual usage minus theoretical usage.',
    '% Variance': 'Variance as a percentage of theoretical usage.',
    'Cost Impact': 'Estimated rand impact of the variance.',
    Trend: 'Usage direction across the selected range.',
    Status: 'Risk level based on the absolute usage variance.',
    Action: 'Inspect this item variance.'
  };
  return renderForecastInfo(info[column] || column);
}

function renderMenuHealthReportDetailView({
  filters,
  reportData,
  category,
  pageSize
}) {
  const rows = buildMenuHealthAdvancedRows(reportData.rows || [], filters);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const categoryOptions = buildMenuHealthCategoryOptions(reportData.rows || []);
  const recipeLineOptions = buildMenuHealthRecipeLineOptions();

  return `
    <div class="analyticsDetailCanvas analyticsVolatilityCanvas analyticsMenuHealthCanvas analyticsTone-${category.tone}">
      <header class="analyticsVolatilityHeader analyticsMenuHealthHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsVolatilityTitle analyticsMenuHealthTitle">
            <span>${icon('activity')}</span>
            <div>
              <h1>Menu Health Report ${renderReportInfo('Track profitability, recipe coverage, and GP health for menu items.')}</h1>
              <p>Track performance, profitability and health of your menu items.</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          ${renderDateRangePicker(filters)}
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsMenuHealthFilters">
        ${renderDropdown({ id: 'locationId', label: 'Location', selectedValue: filters.locationId || '', options: [{ value: '', label: 'All Locations' }], openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'category', label: 'Category', selectedValue: filters.category || '', options: categoryOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'recipeLineFilter', label: 'Recipe Line', selectedValue: filters.recipeLineFilter || '', options: recipeLineOptions, openDropdown: filters.openDropdown })}
        <label class="analyticsForecastSearch analyticsMenuHealthSearch">
          ${icon('search')}
          <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search menu items..." data-analytics-field="query" data-focus-key="analytics-query" />
        </label>
        <button type="button" class="analyticsForecastToolButton" data-analytics-dropdown="menuHealthFilters" aria-expanded="${filters.openDropdown === 'menuHealthFilters'}">
          ${icon('filter')} Filters
        </button>
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>${icon('refresh')} Refresh report</button>
      </section>

      ${renderMenuHealthKpis(rows, reportData.rows || [])}

      <section class="analyticsMenuHealthWorkspace">
        <aside class="analyticsMenuHealthSide">
          ${renderMenuHealthCategoryBreakdown(rows)}
          ${renderMenuHealthScore(rows)}
        </aside>
        <section class="analyticsVolatilityTablePanel analyticsMenuHealthTablePanel">
          <header>
            <div>
              <h2>Menu Health Details</h2>
              <p>${totalRows ? `Showing ${firstRowNumber}-${lastRowNumber} of ${totalRows}` : 'No matching menu items'}</p>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({ id: 'pageSize', label: 'Rows per page', selectedValue: String(pageSize), options: pageSizeOptions(), openDropdown: filters.openDropdown })}
              <button type="button" class="analyticsForecastToolButton" data-analytics-menu-health-focus="legend">${icon('sliders')} Customize columns</button>
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsMenuHealthTable">
              <thead>
                <tr>${menuHealthColumns().map((column) => `<th>${escapeHtml(column)} ${menuHealthColumnInfo(column)}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${pageRows.map(renderMenuHealthTableRow).join('') || `<tr><td colspan="${menuHealthColumns().length}">No menu health rows match this report.</td></tr>`}
              </tbody>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} items` : '0 items'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>${currentPage}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </section>
      </section>

      <section class="analyticsMenuHealthLegend" data-menu-health-legend>
        <span><i class="is-excellent"></i> Excellent <strong>Health score ≥ 80</strong></span>
        <span><i class="is-good"></i> Good <strong>60-79</strong></span>
        <span><i class="is-watch"></i> Watch <strong>40-59</strong></span>
        <span><i class="is-risk"></i> At Risk <strong>&lt; 40 or missing recipe</strong></span>
        <em>${renderReportInfo('Sales and GP data is compared to the current reporting period where available.')} Menu health combines GP, recipe coverage, and sales mix.</em>
      </section>
    </div>
  `;
}

function menuHealthColumns() {
  return ['Menu Item', 'Category', 'Selling Price', 'Recipe Cost', 'GP %', 'Sales (R)', 'Sales Mix', 'Trend', 'Health'];
}

function buildMenuHealthAdvancedRows(rows = [], filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const category = String(filters.category || '').trim();
  const recipeLineFilter = String(filters.recipeLineFilter || '').trim();
  const menuGpFilter = String(filters.menuGpFilter || '').trim();
  const baseSales = rows.reduce((sum, row) => sum + menuHealthSalesValue(row), 0) || 1;
  return rows.map((row, index) => {
    const gp = row._missingRecipe ? null : parseNumber(row['GP %']);
    const sales = menuHealthSalesValue(row);
    const recipeLines = parseNumber(row['Recipe Lines']);
    const healthScore = menuHealthScoreForRow(row, gp, sales, baseSales);
    const health = menuHealthStatus(healthScore, row._missingRecipe);
    return {
      ...row,
      'Sales (R)': formatMoney(sales),
      'Sales Mix': `${formatNumber((sales / baseSales) * 100)}%`,
      Trend: buildMenuHealthTrend(healthScore, index),
      Health: health,
      _gpNumber: gp,
      _sales: sales,
      _salesMix: (sales / baseSales) * 100,
      _recipeLines: recipeLines,
      _healthScore: healthScore,
      _health: health
    };
  }).filter((row) => {
    if (category && row.Category !== category) return false;
    if (recipeLineFilter === 'hasRecipe' && row._missingRecipe) return false;
    if (recipeLineFilter === 'missingRecipe' && !row._missingRecipe) return false;
    if (recipeLineFilter === 'multiLine' && row._recipeLines < 2) return false;
    if (menuGpFilter === 'below60' && !row._missingRecipe && Number(row._gpNumber || 0) >= 60) return false;
    if (query && !`${row['Menu Item']} ${row.Category} ${row.Health}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((left, right) => right._healthScore - left._healthScore || String(left['Menu Item']).localeCompare(String(right['Menu Item'])));
}

function menuHealthSalesValue(row = {}) {
  if (row._salesValue !== undefined && row._salesValue !== null) return Number(row._salesValue || 0);
  return parseMoney(row['Sales (R)']);
}

function menuHealthScoreForRow(row = {}, gp = 0, sales = 0, totalSales = 1) {
  if (row._missingRecipe) return 18;
  const gpScore = Math.max(0, Math.min(100, Number(gp || 0)));
  const salesScore = Math.max(0, Math.min(100, (sales / Math.max(1, totalSales)) * 450));
  return Math.round((gpScore * 0.72) + (salesScore * 0.2) + 8);
}

function menuHealthStatus(score = 0, missingRecipe = false) {
  if (missingRecipe || score < 40) return 'At Risk';
  if (score < 60) return 'Watch';
  if (score < 80) return 'Good';
  return 'Excellent';
}

function buildMenuHealthTrend(score = 0, index = 0) {
  return Array.from({ length: 8 }, (_, point) => Math.max(5, Math.min(100, score + Math.sin(point + index) * 7 + point * 1.2)));
}

function buildMenuHealthCategoryOptions(rows = []) {
  const categories = [...new Set(rows.map((row) => String(row.Category || '').trim()).filter(Boolean))].sort();
  return [{ value: '', label: 'All Categories' }, ...categories.map((value) => ({ value, label: value }))];
}

function buildMenuHealthRecipeLineOptions() {
  return [
    { value: '', label: 'All Recipe Lines' },
    { value: 'hasRecipe', label: 'Has Recipe' },
    { value: 'missingRecipe', label: 'Missing Recipe' },
    { value: 'multiLine', label: '2+ Recipe Lines' }
  ];
}

function renderMenuHealthKpis(rows = [], rawRows = []) {
  const gpRows = rows.filter((row) => !row._missingRecipe && Number.isFinite(row._gpNumber));
  const averageGp = gpRows.length ? gpRows.reduce((sum, row) => sum + row._gpNumber, 0) / gpRows.length : 0;
  const highPerformers = rows.filter((row) => row._health === 'Excellent');
  const watch = rows.filter((row) => row._health === 'Watch');
  const risk = rows.filter((row) => row._health === 'At Risk');
  const cards = [
    { label: 'Total Items', value: formatNumber(rows.length), helper: `${formatNumber(rawRows.length)} report records`, icon: 'clipboard', tone: 'blue' },
    { label: 'Average GP %', value: `${formatNumber(averageGp)}%`, helper: 'Average gross profit from items with recipes.', icon: 'chart', tone: gpMetricTone(averageGp) },
    { label: 'High Performers', value: formatNumber(highPerformers.length), helper: `${formatNumber(rows.length ? (highPerformers.length / rows.length) * 100 : 0)}% of items`, icon: 'activity', tone: 'green' },
    { label: 'Watch Items', value: formatNumber(watch.length), helper: `${formatNumber(rows.length ? (watch.length / rows.length) * 100 : 0)}% of items`, icon: 'eye', tone: 'orange' },
    { label: 'At Risk Items', value: formatNumber(risk.length), helper: `${formatNumber(rows.length ? (risk.length / rows.length) * 100 : 0)}% of items`, icon: 'trash', tone: 'red' },
    { label: 'Recipe Lines', value: formatNumber(sumRows(rows, 'Recipe Lines')), helper: 'Total linked recipe lines.', icon: 'grid', tone: 'purple' }
  ];
  return `<section class="analyticsMenuHealthKpis">${cards.map((card) => `
    <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
      <span>${icon(card.icon)}</span>
      <div>
        <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
        <strong>${escapeHtml(card.value)}</strong>
        <em>${escapeHtml(card.helper)}</em>
      </div>
    </article>
  `).join('')}</section>`;
}

function renderMenuHealthCategoryBreakdown(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Category || 'General';
    const entry = map.get(label) || { label, count: 0 };
    entry.count += 1;
    map.set(label, entry);
    return map;
  }, new Map()).values()].sort((a, b) => b.count - a.count).slice(0, 6);
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  let cursor = 0;
  const colors = ['#3b82f6', '#22c55e', '#8b5cf6', '#f59e0b', '#14b8a6', '#94a3b8'];
  const segments = groups.map((group, index) => {
    const start = cursor;
    const size = total ? (group.count / total) * 360 : 0;
    cursor += size;
    return `${colors[index % colors.length]} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`;
  }).join(', ') || '#1e293b 0deg 360deg';
  return `
    <section class="analyticsVolatilityPanel analyticsMenuHealthCategory">
      <header><h2>By Category ${renderForecastInfo('Menu item count by category.')}</h2></header>
      <div class="analyticsForecastDonut analyticsMenuHealthDonut" style="--forecast-donut:${escapeAttribute(segments)};">
        <span class="analyticsForecastDonutCenter">
          <strong>${escapeHtml(formatNumber(total))}</strong>
          <em>Total</em>
        </span>
      </div>
      <div class="analyticsMenuHealthCategoryList">
        ${groups.map((group, index) => `
          <article style="--risk-color:${colors[index % colors.length]};">
            <span>${escapeHtml(group.label)}</span>
            <strong>${escapeHtml(formatNumber(group.count))}</strong>
            <em>${escapeHtml(formatNumber(total ? (group.count / total) * 100 : 0))}%</em>
          </article>
        `).join('') || '<p>No categories available.</p>'}
      </div>
    </section>
  `;
}

function renderMenuHealthScore(rows = []) {
  const score = rows.length ? Math.round(rows.reduce((sum, row) => sum + Number(row._healthScore || 0), 0) / rows.length) : 0;
  const status = menuHealthStatus(score, false);
  return `
    <section class="analyticsVolatilityPanel analyticsMenuHealthScore">
      <header><h2>Menu Health Score ${renderForecastInfo('Weighted score based on GP percentage, sales mix, and recipe coverage.')}</h2></header>
      <div class="analyticsMenuHealthGauge" style="--score:${Math.min(100, Math.max(0, score))};">
        <div>
          <strong>${escapeHtml(formatNumber(score))}</strong>
          <span>${escapeHtml(status)}</span>
        </div>
      </div>
      <p>Health score is weighted from GP%, recipe coverage, and sales trend.</p>
    </section>
  `;
}

function renderMenuHealthTableRow(row = {}) {
  const gp = row._missingRecipe ? 'Missing Recipe' : formatPercentValue(row['GP %']);
  const gpClass = row._missingRecipe ? 'is-missing' : gpToneClass(Number(row._gpNumber || 0));
  const healthClass = row._health === 'At Risk' ? 'high' : row._health === 'Watch' ? 'medium' : 'low';
  return `
    <tr>
      <td><strong>${escapeHtml(row['Menu Item'] || '')}</strong></td>
      <td>${escapeHtml(row.Category || '')}</td>
      <td>${escapeHtml(row['Selling Price'] || '')}</td>
      <td>${escapeHtml(row['Recipe Cost'] || '')}</td>
      <td>
        ${row._missingRecipe ? renderMissingRecipeActionBadge(row) : `<span class="analyticsGpBadge ${gpClass}">${escapeHtml(gp)}</span>`}
      </td>
      <td>${escapeHtml(row['Sales (R)'])}</td>
      <td>${escapeHtml(row['Sales Mix'])}</td>
      <td>${renderSparkline(row.Trend || [])}</td>
      <td><span class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(healthClass)}">${escapeHtml(row.Health || '')}</span></td>
    </tr>
  `;
}

function renderMissingRecipeActionBadge(row = {}) {
  return `
    <button
      type="button"
      class="analyticsMissingRecipeBadge analyticsMissingRecipeBadge--action"
      data-menu-health-recipe="${escapeAttribute(row._productId || '')}"
      data-menu-health-recipe-name="${escapeAttribute(row._productName || row['Menu Item'] || '')}"
      aria-label="Add missing recipe for ${escapeAttribute(row['Menu Item'] || 'menu item')}"
    >
      Missing
    </button>
  `;
}

function menuHealthColumnInfo(column = '') {
  const info = {
    'Menu Item': 'Menu item from the live catalogue.',
    Category: 'Menu category used for grouping and filtering.',
    'Selling Price': 'Current selling price.',
    'Recipe Cost': 'Calculated cost from linked recipe ingredients.',
    'GP %': 'Gross profit percentage based on selling price and recipe cost.',
    'Sales (R)': 'Sales value proxy where live sales mix is available.',
    'Sales Mix': 'Share of menu value represented by this item.',
    Trend: 'Menu health movement across the selected range.',
    Health: 'Excellent, Good, Watch, or At Risk based on score.',
    Action: 'Add a recipe when the item is missing one.'
  };
  return renderForecastInfo(info[column] || column);
}

// Incident-level columns for the main wastage table (day/time, item, location, user…).
function wasteIncidentColumns() {
  return ['Date', 'Time', 'Item', 'Category', 'Location', 'User', 'Source', 'Reason', 'Quantity', 'Loss Value'];
}

function wasteIncidentColumnInfo(column = '') {
  const info = {
    Date: 'Date the wastage was recorded.',
    Time: 'Time of day the wastage was recorded.',
    Item: 'Stock item or menu item that was wasted (menu items are expanded to their ingredients).',
    Category: 'Inventory/menu category of the wasted item.',
    Location: 'Location where the wastage occurred.',
    User: 'User (or integration) who recorded the wastage.',
    Source: 'Where this wastage came from: Wastage Adjustment (manually recorded ingredient/menu-item wastage) or Manufacture Wastage (yield loss from a production event).',
    Reason: 'Recorded waste reason (e.g. spoilage, breakage, expiry).',
    Quantity: 'Quantity wasted, with its unit.',
    'Loss Value': 'Cost of the wasted quantity = qty × last-purchase unit cost.'
  };
  return info[column] || `${column} for this wastage incident.`;
}

// Flatten the grouped Pareto rows back into individual wastage incidents so the main
// table lists each event by date/time. Grouped analytics (charts/KPIs) still use the
// grouped rows. Applies the same category/search filters; newest first.
function collectWasteIncidents(groupedRows = [], filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const category = String(filters.category || '').trim().toLowerCase();
  const incidents = [];
  (groupedRows || []).forEach((row) => {
    (row._events || []).forEach((event) => {
      if (category && String(event.Category || '').trim().toLowerCase() !== category) return;
      if (query) {
        const haystack = ['Item', 'Reason', 'Category', 'Location', 'User', 'Note']
          .map((key) => String(event[key] || '')).join(' ').toLowerCase();
        if (!haystack.includes(query)) return;
      }
      incidents.push(event);
    });
  });
  return incidents.sort((a, b) => String(b._ts || '').localeCompare(String(a._ts || '')));
}

function renderWasteIncidentRow(event = {}) {
  return `
    <tr>
      <td>${escapeHtml(event.Date || '')}</td>
      <td>${escapeHtml(event.Time || '')}</td>
      <td>${escapeHtml(event.Item || '')}</td>
      <td>${escapeHtml(event.Category || '')}</td>
      <td>${escapeHtml(event.Location || '')}</td>
      <td>${escapeHtml(event.User || 'Unknown')}</td>
      <td>${escapeHtml(event.Source || '')}</td>
      <td>${escapeHtml(event.Reason || '')}</td>
      <td>${escapeHtml(event.Quantity || '')}</td>
      <td>${escapeHtml(event['Loss Value'] || '')}</td>
    </tr>
  `;
}

function renderWasteParetoReportDetailView({
  filters,
  reportData,
  category,
  pageSize
}) {
  const rows = buildWasteParetoAdvancedRows(reportData.rows || [], filters);
  const incidents = collectWasteIncidents(reportData.rows || [], filters);
  const incidentTotal = incidents.length;
  const incidentTotalPages = Math.max(1, Math.ceil(incidentTotal / pageSize));
  const incidentPage = Math.min(Math.max(1, Number(filters.page) || 1), incidentTotalPages);
  const incidentStart = (incidentPage - 1) * pageSize;
  const incidentPageRows = incidents.slice(incidentStart, incidentStart + pageSize);
  const incidentFirst = incidentTotal ? incidentStart + 1 : 0;
  const incidentLast = Math.min(incidentStart + pageSize, incidentTotal);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const categoryOptions = buildWasteParetoCategoryOptions(reportData.rows || []);
  const locationOptions = buildWasteParetoLocationOptions(reportData.rows || []);
  const selectedWasteDetail = rows.find((row) => row._detailKey === filters.wasteDetailKey);

  return `
    <div class="analyticsDetailCanvas analyticsVolatilityCanvas analyticsWasteCanvas analyticsTone-${category.tone}">
      <header class="analyticsVolatilityHeader analyticsWasteHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsVolatilityTitle analyticsWasteTitle">
            <span>${icon('trash')}</span>
            <div>
              <h1>Waste Pareto Report ${renderReportInfo('Analyze waste loss by reason using Pareto principles and cumulative contribution.')}</h1>
              <p>Analyze waste loss by reason using Pareto principles and cumulative contribution.</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsWasteFilters">
        ${renderDateRangePicker(filters)}
        ${renderDropdown({ id: 'category', label: 'Category', selectedValue: filters.category || '', options: categoryOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'locationId', label: 'Location', selectedValue: filters.locationId || '', options: locationOptions, openDropdown: filters.openDropdown })}
        <label class="analyticsForecastSearch analyticsWasteSearch">
          ${icon('search')}
          <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search items, categories..." data-analytics-field="query" data-focus-key="analytics-query" />
        </label>
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>${icon('refresh')} Refresh report</button>
      </section>

      ${renderWasteParetoKpis(rows)}

      <section class="analyticsWasteTopGrid">
        ${renderWasteReasonDonut(rows)}
        ${renderWasteParetoChart(rows)}
        ${renderWasteInsights(rows)}
      </section>

      <section class="analyticsWasteBarsGrid">
        ${renderWasteCategoryLoss(rows)}
        ${renderWasteLocationLoss(rows)}
      </section>

      <section class="analyticsVolatilityTablePanel analyticsWasteTablePanel">
        <header>
          <div>
            <h2>Wastage Incidents</h2>
            <p>${incidentTotal ? `Showing ${incidentFirst}-${incidentLast} of ${incidentTotal} incidents` : 'No wastage incidents match this report'}</p>
          </div>
          <div class="analyticsTableTools">
            ${renderDropdown({ id: 'pageSize', label: 'Rows per page', selectedValue: String(pageSize), options: pageSizeOptions(), openDropdown: filters.openDropdown })}
          </div>
        </header>
        <div class="analyticsTableWrap">
          <table class="analyticsTable analyticsWasteTable analyticsWasteIncidentTable">
            <thead>
              <tr>${wasteIncidentColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(wasteIncidentColumnInfo(column))}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${incidentPageRows.map(renderWasteIncidentRow).join('') || `<tr><td colspan="${wasteIncidentColumns().length}">No wastage incidents match this report.</td></tr>`}
            </tbody>
          </table>
        </div>
        <footer class="analyticsPagination">
          <span>${incidentTotal ? `${incidentFirst}-${incidentLast} of ${incidentTotal} incidents` : '0 incidents'}</span>
          <div class="analyticsPageButtons">
            <button type="button" data-analytics-page="${incidentPage - 1}" ${incidentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
            <strong>Page ${incidentPage} of ${incidentTotalPages}</strong>
            <button type="button" data-analytics-page="${incidentPage + 1}" ${incidentPage >= incidentTotalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
          </div>
        </footer>
      </section>

      <section class="analyticsVolatilityTablePanel analyticsWasteTablePanel analyticsWasteParetoPanel">
        <header>
          <div>
            <h2>Waste by Reason (Pareto)</h2>
            <p>${totalRows ? `${totalRows} reason${totalRows === 1 ? '' : 's'} — grouped loss & cumulative contribution` : 'No matching waste reasons'}</p>
          </div>
        </header>
        <div class="analyticsTableWrap">
          <table class="analyticsTable analyticsWasteTable">
            <thead>
              <tr>${wasteParetoColumns().map((column) => `<th>${escapeHtml(column)} ${wasteParetoColumnInfo(column)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${rows.map(renderWasteParetoTableRow).join('') || `<tr><td colspan="${wasteParetoColumns().length}">No waste rows match this report.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
      ${selectedWasteDetail ? renderWasteDetailOverlay(selectedWasteDetail) : ''}
    </div>
  `;
}

function wasteParetoColumns() {
  return ['Reason', 'User', 'Incidents', 'Loss Value', 'Avg', 'Cumulative', 'Share', 'Top Category', 'Recommended Action', 'Action'];
}

function buildWasteParetoAdvancedRows(rows = [], filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const category = String(filters.category || '').trim();
  const location = String(filters.locationId || '').trim();
  const filtered = rows.map((row) => {
    const loss = Number(row._loss ?? parseMoney(row['Total Loss Value']));
    const incidents = parseNumber(row.Incidents);
    return {
      ...row,
      'Avg Loss': formatMoney(incidents ? loss / incidents : 0),
      'Share %': `${formatNumber(row._share ?? 0)}%`,
      'Recommended Action': wasteRecommendedAction(row['Waste Reason']),
      _loss: loss,
      _incidents: incidents,
      _share: Number(row._share ?? 0),
      _cumulative: Number(row._cumulative ?? parseNumber(row['Cumulative %'])),
      _topCategory: row['Top Category'] || topObjectLabel(row._categoryLoss) || 'General'
    };
  }).filter((row) => {
    if (category && !wasteRowHasCategory(row, category)) return false;
    if (location && !wasteRowHasLocation(row, location)) return false;
    if (query && !`${row['Waste Reason']} ${row.Location} ${row.User} ${row._topCategory}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((left, right) => right._loss - left._loss);
  const total = filtered.reduce((sum, row) => sum + Number(row._loss || 0), 0);
  let cumulative = 0;
  return filtered.map((row, index) => {
    cumulative += Number(row._loss || 0);
    const detailKey = `${index}-${String(row['Waste Reason'] || 'waste').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${String(row.User || 'unknown').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    return {
      ...row,
      '#': String(index + 1),
      Reason: row['Waste Reason'] || row.Reason || 'Other',
      User: row.User || 'Unknown',
      'Loss Value': formatMoney(row._loss),
      Avg: row['Avg Loss'],
      Cumulative: `${formatNumber(total ? (cumulative / total) * 100 : 0)}%`,
      Share: `${formatNumber(total ? (Number(row._loss || 0) / total) * 100 : 0)}%`,
      'Cumulative %': `${formatNumber(total ? (cumulative / total) * 100 : 0)}%`,
      'Share %': `${formatNumber(total ? (Number(row._loss || 0) / total) * 100 : 0)}%`,
      _share: total ? (Number(row._loss || 0) / total) * 100 : 0,
      _cumulative: total ? (cumulative / total) * 100 : 0,
      _detailKey: detailKey,
      _events: Array.isArray(row._events) ? row._events : []
    };
  });
}

function wasteRowHasCategory(row = {}, category = '') {
  if (!category) return true;
  if (String(row['Top Category'] || row._topCategory || '') === category) return true;
  return Object.prototype.hasOwnProperty.call(row._categoryLoss || {}, category);
}

function wasteRowHasLocation(row = {}, location = '') {
  if (!location) return true;
  if (String(row.Location || '') === location) return true;
  return Object.prototype.hasOwnProperty.call(row._locationLoss || {}, location);
}

function topObjectLabel(object = {}) {
  return Object.entries(object || {}).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0] || '';
}

function buildWasteParetoCategoryOptions(rows = []) {
  const categories = new Set();
  rows.forEach((row) => {
    if (row['Top Category']) categories.add(row['Top Category']);
    Object.keys(row._categoryLoss || {}).forEach((key) => categories.add(key));
  });
  return [{ value: '', label: 'All Categories' }, ...[...categories].filter(Boolean).sort().map((value) => ({ value, label: value }))];
}

function buildWasteParetoLocationOptions(rows = []) {
  const locations = new Set();
  rows.forEach((row) => {
    Object.keys(row._locationLoss || {}).forEach((key) => locations.add(key));
    String(row.Location || '').split(',').map((item) => item.trim()).filter(Boolean).forEach((item) => {
      if (!/^\d+\s+locations$/i.test(item)) locations.add(item);
    });
  });
  return [{ value: '', label: 'All Locations' }, ...[...locations].filter(Boolean).sort().map((value) => ({ value, label: value }))];
}

function renderWasteParetoKpis(rows = []) {
  const incidents = rows.reduce((sum, row) => sum + Number(row._incidents || 0), 0);
  const totalLoss = rows.reduce((sum, row) => sum + Number(row._loss || 0), 0);
  const highImpact = rows.filter((row) => row._cumulative <= 80 || row['#'] === '1');
  const cards = [
    { label: 'Waste Incidents', value: formatNumber(incidents), helper: 'Total incidents', icon: 'clipboard', tone: 'blue' },
    { label: 'Total Loss Value', value: formatMoney(totalLoss), helper: 'Total ex-VAT value', icon: 'coin', tone: 'orange' },
    { label: 'Avg Loss per Incident', value: formatMoney(incidents ? totalLoss / incidents : 0), helper: 'Average loss value', icon: 'chart', tone: 'teal' },
    { label: 'Waste Reasons', value: formatNumber(rows.length), helper: 'Unique reasons', icon: 'file', tone: 'purple' },
    { label: 'High Impact Reasons', value: formatNumber(highImpact.length), helper: 'Drive 80% of loss', icon: 'activity', tone: 'red' }
  ];
  return `<section class="analyticsWasteKpis">${cards.map((card) => `
    <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
      <span>${icon(card.icon)}</span>
      <div>
        <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
        <strong>${escapeHtml(card.value)}</strong>
        <em>${escapeHtml(card.helper)}</em>
      </div>
    </article>
  `).join('')}</section>`;
}

function renderWasteReasonDonut(rows = []) {
  const top = rows.slice(0, 8);
  const totalIncidents = rows.reduce((sum, row) => sum + Number(row._incidents || 0), 0);
  const colors = wasteColors();
  const series = top.map((row, index) => ({
    label: row['Waste Reason'],
    value: Number(row._incidents || 0),
    color: colors[index % colors.length]
  }));
  return `
    <section class="analyticsVolatilityPanel analyticsWasteReason">
      <header><h2>By Waste Reason ${renderForecastInfo('Distribution of waste incidents by reason.')}</h2><span>Distribution by number of incidents</span></header>
      <div class="analyticsWasteReasonBody">
        ${renderLiveDoughnut({ series, centerValue: formatNumber(totalIncidents), centerLabel: 'Total', className: 'analyticsWasteDonut', ariaLabel: 'Waste reasons by incident count' })}
        <div class="analyticsWasteReasonList">
          ${top.map((row, index) => `
            <article style="--risk-color:${colors[index % colors.length]};">
              <span>${escapeHtml(row['Waste Reason'])}</span>
              <strong>${escapeHtml(formatNumber(row._incidents))}</strong>
              <em>${escapeHtml(formatNumber(totalIncidents ? (row._incidents / totalIncidents) * 100 : 0))}%</em>
            </article>
          `).join('') || '<p>No waste reasons found.</p>'}
        </div>
      </div>
      <small>Showing top ${escapeHtml(formatNumber(top.length))} reasons</small>
    </section>
  `;
}

function renderWasteParetoChart(rows = []) {
  const top = rows.slice(0, 8);
  const labels = top.map((row) => shortLabel(row['Waste Reason'], 16));
  const datasets = [
    {
      type: 'bar',
      label: 'Total Loss Value (R)',
      data: top.map((row) => Number(Number(row._loss || 0).toFixed(2))),
      backgroundColor: 'rgba(251, 146, 60, 0.72)',
      borderColor: '#fb923c',
      borderWidth: 1,
      borderRadius: 5
    },
    {
      type: 'line',
      label: 'Cumulative %',
      data: top.map((row) => Number(Number(row._cumulative || 0).toFixed(2))),
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96, 165, 250, 0.08)',
      pointRadius: 3,
      tension: 0.32,
      yAxisID: 'y1'
    },
    {
      type: 'line',
      label: '80% Threshold',
      data: top.map(() => 80),
      borderColor: '#38bdf8',
      borderDash: [6, 5],
      pointRadius: 0,
      yAxisID: 'y1'
    }
  ];
  return `
    <section class="analyticsVolatilityPanel analyticsWasteParetoPanel">
      <header><h2>Waste Pareto Analysis ${renderForecastInfo('Bars show total loss value, while the line shows cumulative contribution.')}</h2></header>
      ${renderLiveChartCanvas({ type: 'mixed', labels, datasets, className: 'analyticsWasteParetoChart analyticsWasteParetoChartLive', ariaLabel: 'Waste Pareto analysis' })}
      <div class="analyticsForecastLegend">
        <span><i class="is-reorder"></i> Total Loss Value (R)</span>
        <span><i class="is-average"></i> Cumulative %</span>
      </div>
    </section>
  `;
}

function renderWasteInsights(rows = []) {
  const totalLoss = rows.reduce((sum, row) => sum + Number(row._loss || 0), 0);
  const highImpact = rows.filter((row) => row._cumulative <= 80 || row['#'] === '1');
  const topTwo = rows.slice(0, 2);
  const topTwoShare = topTwo.reduce((sum, row) => sum + Number(row._share || 0), 0);
  return `
    <section class="analyticsVolatilityPanel analyticsWasteInsights">
      <header><h2>${icon('sparkles')} Pareto Insights ${renderForecastInfo('Highlights the highest-impact waste reasons to tackle first.')}</h2></header>
      <div>
        <article>
          <span>${icon('chart')}</span>
          <p>Top ${escapeHtml(formatNumber(highImpact.length))} reasons drive <strong>${escapeHtml(formatNumber(highImpact.reduce((sum, row) => sum + row._share, 0)))}%</strong> of waste loss (${escapeHtml(formatMoney(highImpact.reduce((sum, row) => sum + row._loss, 0)))}).</p>
        </article>
        <article>
          <span>${icon('activity')}</span>
          <p>${escapeHtml(topTwo.map((row) => row['Waste Reason']).join(' and ') || 'Top reasons')} contribute the largest share at <strong>${escapeHtml(formatNumber(topTwoShare))}%</strong> of total loss.</p>
        </article>
        <article>
          <span>${icon('warehouse')}</span>
          <p>Focus on prep controls, stock rotation, and training for reasons above the 80% threshold.</p>
        </article>
      </div>
      <small>Tip: address high-impact reasons first to reduce the biggest slice of ${escapeHtml(formatMoney(totalLoss))}.</small>
    </section>
  `;
}

function renderWasteCategoryLoss(rows = []) {
  return renderWasteHorizontalBars('Loss by Category', 'Total loss value by category', aggregateWasteObject(rows, '_categoryLoss'), 'View category breakdown');
}

function renderWasteLocationLoss(rows = []) {
  return renderWasteHorizontalBars('Most Affected Locations', 'Total loss value by location', aggregateWasteObject(rows, '_locationLoss'), 'View location breakdown');
}

function renderWasteHorizontalBars(title, subtitle, groups = [], footer = '') {
  const max = Math.max(1, ...groups.map((group) => group.value));
  const total = groups.reduce((sum, group) => sum + group.value, 0);
  return `
    <section class="analyticsVolatilityPanel analyticsWasteBars">
      <header><h2>${escapeHtml(title)} ${renderForecastInfo(subtitle)}</h2><span>${escapeHtml(subtitle)}</span></header>
      <div>
        ${groups.slice(0, 6).map((group) => `
          <article style="--score:${Math.max(2, (group.value / max) * 100)}%;">
            <span>${escapeHtml(group.label)}</span>
            <i></i>
            <strong>${escapeHtml(formatMoney(group.value))}</strong>
            <em>${escapeHtml(formatNumber(total ? (group.value / total) * 100 : 0))}%</em>
          </article>
        `).join('') || '<p>No loss breakdown available.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-waste-focus="table">${escapeHtml(footer)} ${icon('arrowRight')}</button>
    </section>
  `;
}

function aggregateWasteObject(rows = [], key = '') {
  const map = new Map();
  rows.forEach((row) => {
    Object.entries(row[key] || {}).forEach(([label, value]) => {
      map.set(label, (map.get(label) || 0) + Number(value || 0));
    });
  });
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function renderWasteParetoTableRow(row = {}) {
  const color = wasteColors()[(Number(row['#'] || 1) - 1) % wasteColors().length];
  return `
    <tr>
      <td><span class="analyticsWasteReasonName" style="--risk-color:${color};">${escapeHtml(row.Reason || row['Waste Reason'])}</span></td>
      <td>${escapeHtml(row.User || 'Unknown')}</td>
      <td>${escapeHtml(formatNumber(row._incidents))}</td>
      <td>${escapeHtml(formatMoney(row._loss))}</td>
      <td>${escapeHtml(row.Avg || row['Avg Loss'])}</td>
      <td>${escapeHtml(row.Cumulative || row['Cumulative %'])}</td>
      <td>${escapeHtml(row.Share || row['Share %'])}</td>
      <td>${escapeHtml(row._topCategory)}</td>
      <td><span class="analyticsWasteActionTag">${escapeHtml(row['Recommended Action'])}</span></td>
      <td>
        <button type="button" class="analyticsIconAction analyticsWasteDetailButton" data-waste-detail-view="${escapeAttribute(row._detailKey)}" aria-label="View waste detail">
          ${icon('eye')}
        </button>
      </td>
    </tr>
  `;
}

function renderWasteDetailOverlay(row = {}) {
  const events = Array.isArray(row._events) && row._events.length ? row._events : [{
    Date: '',
    Time: '',
    Reason: row.Reason || row['Waste Reason'] || 'Other',
    User: row.User || 'Unknown',
    Item: row._topCategory || 'Waste event',
    Category: row._topCategory || 'General',
    Location: row.Location || '',
    Quantity: `${formatNumber(row._incidents || 0)} incidents`,
    'Loss Value': formatMoney(row._loss || 0),
    Note: row['Recommended Action'] || '',
    Source: 'Waste Pareto'
  }];
  const loss = Number(row._loss || 0);
  return `
    <div class="analyticsModalBackdrop" data-waste-detail-close>
      <section class="analyticsOrderModal analyticsWasteDetailModal" role="dialog" aria-modal="true" aria-label="Waste event detail">
        <header>
          <div>
            <span>Waste Event Log</span>
            <h2>${escapeHtml(row.Reason || row['Waste Reason'] || 'Waste')}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-waste-detail-close aria-label="Close waste event detail">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Reason</span><strong>${escapeHtml(row.Reason || row['Waste Reason'] || 'Other')}</strong></div>
          <div><span>User</span><strong>${escapeHtml(row.User || 'Unknown')}</strong></div>
          <div><span>Incidents</span><strong>${escapeHtml(formatNumber(row._incidents || events.length))}</strong></div>
          <div><span>Loss Value</span><strong class="analyticsTextDanger">${escapeHtml(formatMoney(loss))}</strong></div>
          <div><span>Average</span><strong>${escapeHtml(row.Avg || row['Avg Loss'] || formatMoney(events.length ? loss / events.length : loss))}</strong></div>
          <div><span>Top Category</span><strong>${escapeHtml(row._topCategory || 'General')}</strong></div>
        </div>
        <div class="analyticsOrderLines analyticsWasteDetailLines">
          <header class="analyticsEmbeddedSectionHead">
            <strong>Wasted items</strong>
            <span>${escapeHtml(formatNumber(events.length))} event${events.length === 1 ? '' : 's'}</span>
          </header>
          ${events.map((event) => `
            <article>
              <div>
                <strong>${escapeHtml(event.Item || 'Stock item')}</strong>
                <span>${escapeHtml([event.Date, event.Time, event.Location].filter(Boolean).join(' · '))}</span>
              </div>
              <div class="analyticsWasteDetailMeta">
                <span>${escapeHtml(event.Quantity || '0')} · ${escapeHtml(event.Category || 'General')} · ${escapeHtml(event.Source || 'Waste')}</span>
                <strong>${escapeHtml(event['Loss Value'] || formatMoney(0))}</strong>
              </div>
              ${event.Note ? `<p>${escapeHtml(event.Note)}</p>` : ''}
            </article>
          `).join('')}
        </div>
      </section>
    </div>
  `;
}

function wasteRecommendedAction(reason = '') {
  const text = String(reason || '').toLowerCase();
  if (text.includes('expired')) return 'Improve rotation';
  if (text.includes('over')) return 'Review forecasting';
  if (text.includes('spoil')) return 'Temperature control';
  if (text.includes('prep')) return 'Tighten prep controls';
  if (text.includes('damag')) return 'Improve handling';
  if (text.includes('theft')) return 'Strengthen security';
  if (text.includes('return')) return 'Review return policy';
  if (text.includes('manufact')) return 'Audit batch yield';
  return 'Review process';
}

function wasteParetoColumnInfo(column = '') {
  const info = {
    Reason: 'Reason captured on the wastage or variance movement.',
    User: 'User who processed the wastage or production variance.',
    Incidents: 'Number of waste incidents for this reason.',
    'Loss Value': 'Total ex-VAT value lost for this reason and user.',
    Avg: 'Average loss value per incident.',
    Cumulative: 'Running cumulative contribution to total waste.',
    Share: 'This row as a percentage of total waste loss.',
    'Top Category': 'Category with the largest loss for this reason.',
    'Recommended Action': 'Suggested operational response.',
    Action: 'Open a detailed view of the wasted items behind this row.'
  };
  return renderForecastInfo(info[column] || column);
}

function wasteColors() {
  return ['#fb923c', '#f59e0b', '#22c55e', '#8b5cf6', '#3b82f6', '#06b6d4', '#eab308', '#94a3b8'];
}

function formatCompactMoney(value = 0) {
  const numeric = Number(value || 0);
  if (Math.abs(numeric) >= 1000) return `R ${formatNumber(numeric / 1000)}K`;
  return formatMoney(numeric);
}

function shortLabel(value = '', length = 12) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, Math.max(1, length - 1))}.` : text;
}

function renderCustomReportDetailView({
  source,
  filters,
  reportData,
  analytics,
  category,
  categoryOptions,
  locationOptions,
  totalRows,
  pageSize,
  currentPage,
  totalPages,
  firstRowNumber,
  lastRowNumber,
  pageRows,
  emptyTableMessage,
  access = {}
}) {
  const custom = reportData.custom || {};
  const savedReports = analytics.savedReports || [];
  const visibleSavedReports = filterSavedReportsForAccess(savedReports, access);
  const pinnedReports = visibleSavedReports.filter((report) => report.pinned);
  const sourceOptions = custom.sourceOptions || customReportSources;
  const activeSource = custom.sourceId || sourceOptions[0]?.id || 'stock';
  const sourceConfig = sourceOptions.find((source) => source.id === activeSource) || sourceOptions[0] || {};
  const selectedColumns = custom.selectedColumns || reportData.columns || [];
  const visualizationType = filters.visualizationType || custom.visualizationType || 'table';
  const groupBy = filters.groupBy || custom.groupBy || 'none';
  const firstColumn = selectedColumns[0] || reportData.columns[0] || 'Report';
  const valueColumn = findCurrencyColumn(reportData.columns || []);
  const updatedLabel = new Date().toLocaleString('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  const showCustomDashboard = !filters.customReportPreviewOpen && !filters.customSetupOpen;

  if (showCustomDashboard) {
    return renderCustomReportDashboard({
      filters,
      analytics,
      category,
      savedReports: visibleSavedReports,
      pinnedReports
    });
  }
  return renderReportBuilder({
    filters,
    analytics,
    reportData,
    sourceOptions,
    sourceConfig,
    access
  });
}

const REPORT_BUILDER_FIELDS = [
  { id: 'date', label: 'Date', dataset: 'Activity', type: 'date', aliases: ['Date', 'Trade Date', 'Created At'] },
  { id: 'time', label: 'Time', dataset: 'Activity', type: 'text', aliases: ['Time'] },
  { id: 'item', label: 'Item', dataset: 'Inventory', type: 'text', aliases: ['Item', 'Product', 'Ingredient', 'Menu Item', 'Item Name', 'Main Product Sold'] },
  { id: 'category', label: 'Category', dataset: 'Inventory', type: 'text', aliases: ['Category', 'Modifier Category', 'Product Status'] },
  { id: 'location', label: 'Location', dataset: 'Locations', type: 'text', aliases: ['Location', 'From', 'To'] },
  { id: 'supplier', label: 'Supplier', dataset: 'Purchasing', type: 'text', aliases: ['Supplier'] },
  { id: 'reference', label: 'Reference', dataset: 'Purchasing', type: 'text', aliases: ['Reference', 'Invoice', 'Sale ID / Order ID'] },
  { id: 'status', label: 'Status', dataset: 'Activity', type: 'text', aliases: ['Status', 'Risk Level', 'Action'] },
  { id: 'user', label: 'User', dataset: 'Activity', type: 'text', aliases: ['User'] },
  { id: 'unit', label: 'Unit', dataset: 'Inventory', type: 'text', aliases: ['Unit', 'UOM Config'] },
  { id: 'quantity', label: 'Quantity', dataset: 'Inventory', type: 'number', aliases: ['Quantity', 'Qty Sold', 'Qty Depleted', 'Items', 'Current Stock', 'On Hand'] },
  { id: 'stockValue', label: 'Stock Value', dataset: 'Inventory', type: 'currency', aliases: ['Stock Value', 'Total Deficit Value'] },
  { id: 'unitCost', label: 'Unit Cost', dataset: 'Inventory', type: 'currency', aliases: ['Unit Cost', 'Current Unit Cost', 'Prior Unit Cost'] },
  { id: 'totalEx', label: 'Total Ex', dataset: 'Purchasing', type: 'currency', aliases: ['Total Ex', 'Purchases Ex', 'Net', 'Total Impact'] },
  { id: 'impactEx', label: 'Impact Ex', dataset: 'Operations', type: 'currency', aliases: ['Impact Ex', 'COS Impact', 'COGS Ex', 'Loss Value', 'Net Impact'] },
  { id: 'sellingPrice', label: 'Selling Price', dataset: 'Menu', type: 'currency', aliases: ['Selling Price', 'Modifier Selling', 'Main Product Selling', 'Total Selling'] },
  { id: 'recipeCost', label: 'Recipe Cost', dataset: 'Menu', type: 'currency', aliases: ['Recipe Cost', 'Modifier Cost', 'Total Cost'] },
  { id: 'gpPercent', label: 'GP %', dataset: 'Menu', type: 'number', aliases: ['GP %', 'Modifier GP %', 'GP Main %', 'GP Combined %', 'Additional GP %'] },
  { id: 'variance', label: 'Variance', dataset: 'Operations', type: 'number', aliases: ['Variance', 'Variance Qty', '% Change'] }
];

function renderReportBuilder({ filters = {}, analytics = {}, reportData = {}, sourceOptions = [], sourceConfig = {}, access = {} }) {
  const readOnly = filters.customReportReadOnly === true;
  const isSaving = analytics.actionStatus === 'saving-report';
  const builder = {
    ...normalizeReportBuilderState(filters.customReportBuilder, filters),
    ...(readOnly ? { step: 1 } : {})
  };
  const fields = getReportBuilderVisibleFields(builder);
  const groupedFields = groupReportBuilderFields(fields);
  const previewRows = buildReportBuilderPreviewRows(builder, reportData, access);
  return `
    <div class="reportBuilderSurface ${readOnly ? 'reportBuilderSurface--readonly' : ''} ${isSaving ? 'is-saving' : ''}" data-report-builder aria-busy="${isSaving}">
      <header class="reportBuilderHeader">
        <div>
          <button type="button" class="reportBuilderBack" data-analytics-back>${icon('chevronLeft')} Reports</button>
          <h1>${readOnly ? 'Custom Report Preview' : 'Custom Report Builder'}</h1>
          <nav class="reportBuilderStepper" aria-label="Report builder steps">
            ${['Build', 'Preview', 'Save & Share'].map((label, index) => `
              <span class="${index === builder.step ? 'is-active' : ''}">
                <b>${index + 1}</b>${escapeHtml(label)}
              </span>
            `).join('<i></i>')}
          </nav>
        </div>
        <form class="reportBuilderHeaderActions" data-report-builder-save-form>
          <label>
            <span>Report Name</span>
            <input type="text" value="${escapeAttribute(builder.name)}" data-report-builder-field="name" aria-label="Report name" ${readOnly ? 'disabled' : ''} />
          </label>
          ${readOnly ? '' : `
            <button type="submit" name="reportBuilderAction" value="save" class="reportBuilderSecondary" data-report-builder-submit="save" ${isSaving ? 'disabled' : ''}>
              ${isSaving ? '<span class="reportBuilderMiniSpinner" aria-hidden="true"></span> Saving' : 'Save'}
            </button>
            <button type="submit" name="reportBuilderAction" value="preview" class="reportBuilderPrimary" data-report-builder-submit="preview" ${isSaving ? 'disabled' : ''}>
              ${isSaving ? '<span class="reportBuilderMiniSpinner" aria-hidden="true"></span> Saving Report' : `Save & Preview ${icon('chevronDown')}`}
            </button>
          `}
        </form>
      </header>

      ${analytics.reportConfigError ? `<div class="reportBuilderNotice">${escapeHtml(analytics.reportConfigError)}</div>` : ''}
      ${filters.customReportSavedMessage ? `<div class="reportBuilderNotice reportBuilderNotice--success">${escapeHtml(filters.customReportSavedMessage)}</div>` : ''}
      ${isSaving ? renderReportBuilderSavingOverlay() : ''}

      <div class="reportBuilderGrid">
        ${readOnly ? '' : renderDataFieldSidebar(builder, groupedFields, sourceOptions, sourceConfig)}
        <main class="reportBuilderMain" aria-label="Report builder canvas">
          ${readOnly ? '' : renderReportLayoutBuilder(builder)}
          ${renderReportPreviewTable(builder, previewRows, reportData)}
          ${readOnly ? '' : `<div class="reportBuilderTip">${icon('info')} <span>Tip: Drag and drop fields to build your report. Use filters to narrow your data.</span></div>`}
        </main>
        ${readOnly ? '' : renderReportSettingsPanel(builder, reportData)}
      </div>
    </div>
  `;
}

function renderReportBuilderSavingOverlay() {
  return `
    <div class="reportBuilderSavingOverlay" role="status" aria-live="polite">
      <div>
        <span class="reportBuilderSpinner" aria-hidden="true"></span>
        <strong>Saving report</strong>
        <small>Persisting the report layout, fields, filters, rules, and options.</small>
      </div>
    </div>
  `;
}

function renderDataFieldSidebar(builder, groupedFields, sourceOptions, sourceConfig) {
  const selectedSources = reportBuilderSelectedSources(builder);
  return `
    <aside class="reportBuilderPanel reportBuilderDataPanel" aria-label="Data fields">
      <h2>Data</h2>
      ${renderReportBuilderDropdown({
        builder,
        field: 'sourceId',
        label: 'Browse Source',
        value: builder.sourceId,
        options: (sourceOptions.length ? sourceOptions : customReportSources).map((source) => ({ value: source.id, label: source.label }))
      })}
      <div class="reportBuilderSourceHint">
        <span>Select fields from any report source. Mixed-source reports save every selected source.</span>
        ${selectedSources.length ? `
          <div>
            ${selectedSources.map((source) => `<em>${escapeHtml(source.label)}</em>`).join('')}
          </div>
        ` : ''}
      </div>
      ${renderReportBuilderWorkflowTemplates(builder)}
      <label class="reportBuilderSearch">
        ${icon('search')}
        <input type="search" value="${escapeAttribute(builder.fieldSearch)}" placeholder="Search fields" data-report-builder-field="fieldSearch" aria-label="Search fields" />
      </label>
      <div class="reportBuilderTabs" role="tablist" aria-label="Field filter">
        ${['All Fields', 'Frequently Used'].map((tab) => `
          <button type="button" class="${builder.fieldTab === tab ? 'is-active' : ''}" data-report-builder-field-tab="${escapeAttribute(tab)}">${escapeHtml(tab)}</button>
        `).join('')}
      </div>
      <div class="reportBuilderFieldGroups">
        ${Object.entries(groupedFields).map(([dataset, fields]) => `
          <section>
            <h3>${escapeHtml(dataset)} ${icon('chevronRight')}</h3>
            ${fields.map((field) => renderReportBuilderFieldRow(field)).join('')}
          </section>
        `).join('') || '<p class="reportBuilderEmptyCopy">No fields match that search.</p>'}
      </div>
      <button type="button" class="reportBuilderCalculated" data-report-builder-calculated-toggle>${icon('plus')} Create Calculated Field</button>
      ${builder.calculatedDraftOpen ? renderCalculatedFieldEditor(builder) : ''}
    </aside>
  `;
}

function renderReportBuilderWorkflowTemplates(builder = {}) {
  return `
    <section class="reportBuilderTemplateRail" aria-label="Workflow report templates">
      <header>
        <strong>${icon('sparkles')} Templates</strong>
        <span>Workflow starters</span>
      </header>
      <div>
        ${CUSTOM_REPORT_TEMPLATES.map((template) => `
          <button type="button" class="${builder.templateId === template.id ? 'is-active' : ''}" data-report-builder-template="${escapeAttribute(template.id)}">
            <small>${escapeHtml(template.workflow || 'Report')}</small>
            <strong>${escapeHtml(template.name)}</strong>
          </button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderReportBuilderFieldRow(field) {
  return `
    <button
      type="button"
      class="reportBuilderField"
      draggable="true"
      data-report-builder-field-id="${escapeAttribute(field.id)}"
      aria-label="Drag ${escapeAttribute(field.label)} field"
    >
      <span class="reportBuilderTypeIcon reportBuilderTypeIcon--${escapeAttribute(field.type)}">${fieldTypeGlyph(field)}</span>
      <span>${escapeHtml(field.label)}</span>
      <small>${escapeHtml(field.sourceLabel ? `${field.sourceLabel} · ${field.type}` : field.type)}</small>
    </button>
  `;
}

function renderCalculatedFieldEditor(builder) {
  return `
    <section class="reportBuilderCalcEditor" aria-label="Create calculated field">
      <label>
        <span>Field Name</span>
        <input type="text" value="${escapeAttribute(builder.calculatedDraft?.name || '')}" data-report-builder-calc-field="name" placeholder="e.g. Net Margin" />
      </label>
      ${renderReportBuilderDropdown({
        builder,
        field: 'calculatedDraftType',
        label: 'Field Type',
        value: builder.calculatedDraft?.type || 'number',
        options: [
          { value: 'number', label: 'Number' },
          { value: 'currency', label: 'Currency' },
          { value: 'text', label: 'Text' },
          { value: 'date', label: 'Date' }
        ]
      })}
      <label>
        <span>Formula</span>
        <textarea data-report-builder-calc-field="formula" placeholder="Use fields like {Total Ex} - {Impact Ex}">${escapeHtml(builder.calculatedDraft?.formula || '')}</textarea>
      </label>
      <p>Wrap field names in braces. Example: {Total Ex} / {Items}</p>
      <div>
        <button type="button" class="reportBuilderSecondary" data-report-builder-calculated-cancel>Cancel</button>
        <button type="button" class="reportBuilderPrimary" data-report-builder-calculated-save>Create Field</button>
      </div>
    </section>
  `;
}

function renderReportBuilderDropdown({ builder, field, label, value = '', options = [] }) {
  const id = `report-builder-${field}`;
  const selected = options.find((option) => String(option.value) === String(value)) || options[0] || { value: '', label: 'Select' };
  const isOpen = builder.openDropdown === id;
  return `
    <label class="reportBuilderControl reportBuilderCustomDropdown">
      <span>${escapeHtml(label)}</span>
      <div class="analyticsDropdown ${isOpen ? 'is-open' : ''}" data-analytics-dropdown-root>
        <button type="button" data-report-builder-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}" aria-label="${escapeAttribute(label)}">
          <strong>${escapeHtml(selected.label || 'Select')}</strong>
          ${icon('chevronDown')}
        </button>
        <div class="analyticsDropdownMenu">
          ${options.map((option) => `
            <button
              type="button"
              data-report-builder-option="${escapeAttribute(field)}"
              data-report-builder-option-value="${escapeAttribute(option.value)}"
              class="${String(option.value) === String(value) ? 'is-active' : ''}"
            >
              ${escapeHtml(option.label || option.value)}
            </button>
          `).join('')}
        </div>
      </div>
    </label>
  `;
}

function renderReportLayoutBuilder(builder) {
  return `
    <section class="reportBuilderLayoutCard">
      <header>
        <h2>Build</h2>
        <span>Report Layout</span>
      </header>
      ${renderDropZone('filters', 'Filters', 'applied to entire report', builder.layout.filters, 'Add Filter', builder)}
      ${renderDropZone('columns', 'Columns', '', builder.layout.columns, 'Add Column', builder)}
      ${renderDropZone('values', 'Values', '', builder.layout.values, 'Add Value', builder)}
      ${renderDropZone('rows', 'Rows', '', builder.layout.rows, 'Add Row', builder)}
    </section>
  `;
}

function renderDropZone(zone, label, helper, fields, actionLabel, builder) {
  return `
    <section class="reportBuilderDropZone" data-report-builder-drop-zone="${escapeAttribute(zone)}" aria-label="${escapeAttribute(label)} drop zone">
      <div class="reportBuilderDropZoneTitle">
        <span class="reportBuilderDragHandle" aria-hidden="true">⋮⋮</span>
        <strong>${escapeHtml(label)}</strong>
        ${helper ? `<small>${escapeHtml(helper)}</small>` : ''}
        <button type="button" aria-label="${escapeAttribute(label)} options">${icon('more')}</button>
      </div>
      <div class="reportBuilderPillRow">
        ${fields.length ? fields.map((fieldId, index) => renderFieldPill(fieldId, zone, index, builder)).join('') : `
          <div class="reportBuilderDropEmpty">Drop fields here or use ${escapeHtml(actionLabel)}.</div>
        `}
        <button type="button" class="reportBuilderAddAction" data-report-builder-add="${escapeAttribute(zone)}">${icon('plus')} ${escapeHtml(actionLabel)}</button>
      </div>
    </section>
  `;
}

function renderFieldPill(fieldId, zone, index, builder = {}) {
  const field = getReportBuilderField(fieldId, builder.calculatedFields);
  if (!field) return '';
  const label = zone === 'values' && !/^Sum|^Count/.test(field.label)
    ? `${field.type === 'number' ? 'Count of' : 'Sum of'} ${field.label}`
    : field.label;
  return `
    <span
      class="reportBuilderPill reportBuilderPill--${escapeAttribute(field.type)}"
      draggable="true"
      data-report-builder-pill="${escapeAttribute(field.id)}"
      data-report-builder-pill-zone="${escapeAttribute(zone)}"
      data-report-builder-pill-index="${index}"
    >
      <i aria-hidden="true">⋮⋮</i>
      ${fieldTypeGlyph(field)}
      <span>${escapeHtml(label)}</span>
      ${field.sourceLabel ? `<em>${escapeHtml(field.sourceLabel)}</em>` : ''}
      <button type="button" data-report-builder-remove="${escapeAttribute(zone)}|${escapeAttribute(field.id)}" aria-label="Remove ${escapeAttribute(label)}">${icon('x')}</button>
    </span>
  `;
}

function renderReportPreviewTable(builder, previewRows, reportData = {}) {
  const columns = buildReportBuilderPreviewColumns(builder);
  const totals = buildReportBuilderTotals(previewRows, columns);
  const sourceRowCount = Array.isArray(reportData.rows) ? reportData.rows.length : previewRows.length;
  const previewClass = [
    builder.options.compactRows ? 'is-compact' : '',
    builder.options.freezeHeader ? 'has-sticky-header' : ''
  ].filter(Boolean).join(' ');
  return `
    <section class="reportBuilderPreview">
      <header>
        <div>
          <h2>${builder.showTitle ? escapeHtml(builder.title || builder.name || 'Custom Report') : 'Report Preview'} <span>(workspace data)</span></h2>
          ${builder.description ? `<p>${escapeHtml(builder.description)}</p>` : ''}
          <small>Showing ${previewRows.length} of ${sourceRowCount} rows ${icon('refresh')}</small>
        </div>
        <div class="reportBuilderOutputActions" aria-label="Report output actions">
          <button type="button" data-report-builder-export="pdf">${icon('pdf')} PDF</button>
          <button type="button" data-report-builder-export="xlsx">${icon('sheet')} Excel</button>
          <button type="button" data-report-builder-export="csv">${icon('file')} CSV</button>
          <button type="button" data-report-builder-print>${icon('print')} Print</button>
        </div>
      </header>
      ${renderReportBuilderInsightBar(builder, previewRows, columns)}
      ${builder.visualizationType !== 'table' ? renderReportBuilderChartPreview(builder, previewRows, columns) : ''}
      <div class="reportBuilderTableWrap ${escapeAttribute(previewClass)}">
        ${columns.length ? `
          <table>
            <thead><tr>${builder.options.showRowNumbers ? '<th>#</th>' : ''}${columns.map((column) => `<th>${escapeHtml(column.label)} ${renderReportInfo(columnTooltip({}, column.label))}</th>`).join('')}${builder.options.drilldownEnabled ? '<th>Detail</th>' : ''}</tr></thead>
            <tbody>
              ${previewRows.map((row, rowIndex) => `
                <tr>
                  ${builder.options.showRowNumbers ? `<td class="is-number">${rowIndex + 1}</td>` : ''}
                  ${columns.map((column) => `<td class="${reportBuilderCellClass(row, column, builder)}">${formatReportBuilderCell(row, column, builder)}</td>`).join('')}
                  ${builder.options.drilldownEnabled ? `<td><button type="button" class="reportBuilderDrillButton" data-report-builder-drill="${escapeAttribute(row._reportBuilderGroupKey || String(rowIndex))}">${icon('search')} Drill down</button></td>` : ''}
                </tr>
              `).join('') || `<tr><td colspan="${columns.length}">No workspace rows match this report yet.</td></tr>`}
              ${previewRows.length && builder.showTotals ? `<tr class="is-total">
                ${builder.options.showRowNumbers ? '<td></td>' : ''}
                ${columns.map((column, index) => `<td class="${column.numeric ? 'is-number' : ''}">${index === 0 ? 'Total' : formatReportBuilderTotal(column, totals, builder)}</td>`).join('')}
                ${builder.options.drilldownEnabled ? '<td></td>' : ''}
              </tr>` : ''}
            </tbody>
          </table>
        ` : '<div class="reportBuilderPreviewEmpty">Choose fields from the left to preview this report.</div>'}
      </div>
      ${renderReportBuilderDrilldown(builder, previewRows, columns)}
    </section>
  `;
}

function renderReportBuilderInsightBar(builder = {}, rows = [], columns = []) {
  const alerts = buildReportBuilderAlerts(builder, rows);
  const comparison = buildReportBuilderComparison(builder, rows, columns);
  return `
    <div class="reportBuilderInsightBar">
      <article class="${alerts.length ? 'is-alert' : ''}">
        <span>${icon(alerts.length ? 'activity' : 'check')}</span>
        <div>
          <strong>${escapeHtml(alerts.length ? `${alerts.length} alert${alerts.length === 1 ? '' : 's'}` : 'No thresholds breached')}</strong>
          <small>${escapeHtml(alerts[0]?.message || 'Saved exception rules are clear for this preview.')}</small>
        </div>
      </article>
      <article>
        <span>${icon('chart')}</span>
        <div>
          <strong>${escapeHtml(comparison.label)}</strong>
          <small>${escapeHtml(comparison.detail)}</small>
        </div>
      </article>
      <article>
        <span>${icon('grid')}</span>
        <div>
          <strong>${escapeHtml(builder.options.pivotMode ? 'Pivot grouping on' : 'Detail rows')}</strong>
          <small>${escapeHtml(builder.options.pivotMode ? 'Rows are grouped by selected row and column fields.' : 'Preview shows transaction-level detail.')}</small>
        </div>
      </article>
    </div>
  `;
}

function renderReportBuilderChartPreview(builder = {}, rows = [], columns = []) {
  const series = buildReportBuilderChartSeries(builder, rows, columns);
  return `
    <div class="reportBuilderChartPreview">
      <header>
        <strong>${escapeHtml(visualizationLabel(builder.visualizationType))}</strong>
        <span>${escapeHtml(series.length ? `${series.length} points` : 'No chartable data yet')}</span>
      </header>
      <div>
        <canvas
          data-custom-chart
          data-chart-id="${escapeAttribute(`report-builder-${builder.visualizationType}-${builder.options.shareToken || 'chart'}`)}"
          data-chart-type="${escapeAttribute(builder.visualizationType)}"
          data-chart-series="${escapeAttribute(JSON.stringify(series))}"
        ></canvas>
      </div>
    </div>
  `;
}

function renderReportBuilderDrilldown(builder = {}, rows = [], columns = []) {
  if (!builder.options.drilldownEnabled || !builder.options.drilldownKey) return '';
  const row = rows.find((item) => String(item._reportBuilderGroupKey || '') === String(builder.options.drilldownKey));
  const sourceRows = Array.isArray(row?._reportBuilderDrillRows) ? row._reportBuilderDrillRows : row?._reportBuilderRawRow ? [row._reportBuilderRawRow] : [];
  const detailColumns = [...new Set(sourceRows.flatMap((item) => Object.keys(item || {})))].slice(0, 8);
  return `
    <section class="reportBuilderDrilldownPanel">
      <header>
        <div>
          <strong>Transaction Detail</strong>
          <span>${escapeHtml(sourceRows.length ? `${sourceRows.length} row${sourceRows.length === 1 ? '' : 's'} behind this summary` : 'No detail rows available')}</span>
        </div>
        <button type="button" data-report-builder-drill="${escapeAttribute(builder.options.drilldownKey)}">${icon('x')} Close</button>
      </header>
      <div>
        ${sourceRows.length ? `
          <table>
            <thead><tr>${detailColumns.map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr></thead>
            <tbody>
              ${sourceRows.slice(0, 25).map((detail) => `<tr>${detailColumns.map((column) => `<td>${escapeHtml(detail[column] ?? '')}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        ` : '<p>No transaction detail found for this row.</p>'}
      </div>
    </section>
  `;
}

function renderReportSettingsPanel(builder, reportData = {}) {
  const count = String(builder.description || '').length;
  return `
    <aside class="reportBuilderPanel reportBuilderSettings" aria-label="Report settings">
      <h2>Settings</h2>
      <div class="reportBuilderTabs" role="tablist" aria-label="Settings tabs">
        ${['Format', 'Options', 'Automation'].map((tab) => `
          <button type="button" class="${builder.settingsTab === tab ? 'is-active' : ''}" data-report-builder-settings-tab="${escapeAttribute(tab)}">${escapeHtml(tab)}</button>
        `).join('')}
      </div>
      ${builder.settingsTab === 'Automation'
        ? renderReportAutomationPanel(builder, count)
        : builder.settingsTab === 'Options'
          ? renderReportOptionsPanel(builder, count, reportData)
          : renderReportFormatPanel(builder, count)}
    </aside>
  `;
}

function renderReportFormatPanel(builder, count) {
  return `
    <label class="reportBuilderControl">
      <span>Report Title</span>
      <input type="text" value="${escapeAttribute(builder.title)}" data-report-builder-field="title" aria-label="Report title" />
    </label>
    <label class="reportBuilderCheck">
      <input type="checkbox" ${builder.showTitle ? 'checked' : ''} data-report-builder-field="showTitle" />
      <span>Show Report Title</span>
    </label>
    ${renderReportBuilderDropdown({
      builder,
      field: 'numberFormat',
      label: 'Number Format',
      value: builder.numberFormat,
      options: ['Currency (ZAR)', 'Number', 'Percentage'].map((item) => ({ value: item, label: item }))
    })}
    ${renderReportBuilderDropdown({
      builder,
      field: 'dateFormat',
      label: 'Date Format',
      value: builder.dateFormat,
      options: ['dd MMM yyyy', 'yyyy/MM/dd', 'MMM d, yyyy'].map((item) => ({ value: item, label: item }))
    })}
    <label class="reportBuilderCheck">
      <input type="checkbox" ${builder.showTotals ? 'checked' : ''} data-report-builder-field="showTotals" />
      <span>Show Grand Total</span>
    </label>
    ${renderReportBuilderDropdown({
      builder,
      field: 'tableStyle',
      label: 'Table Style',
      value: builder.tableStyle,
      options: ['KCP Standard', 'Compact', 'Detailed'].map((item) => ({ value: item, label: item }))
    })}
    <section class="reportBuilderSettingsGroup">
      <h3>Conditional Formatting</h3>
      ${builder.formattingRules.map((rule, index) => renderFormattingRule(rule, index, builder)).join('') || '<p>No formatting rules yet.</p>'}
      <button type="button" data-report-builder-formatting-add>${icon('plus')} Add Rule</button>
    </section>
    <section class="reportBuilderSettingsGroup">
      <h3>Filters</h3>
      ${builder.filterRules.map((rule, index) => renderFilterRule(rule, index, builder)).join('') || '<p>No active report filters.</p>'}
      <button type="button" data-report-builder-filter-add>${icon('plus')} Add Filter</button>
    </section>
    <label class="reportBuilderControl">
      <span>Description <small>Optional</small></span>
      <textarea maxlength="500" data-report-builder-field="description" aria-label="Description">${escapeHtml(builder.description)}</textarea>
      <em>${count}/500</em>
    </label>
  `;
}

function renderReportOptionsPanel(builder, count, reportData = {}) {
  const fieldOptions = reportBuilderSelectableFieldOptions(builder, true);
  return `
    <section class="reportBuilderSettingsGroup">
      <h3>Report Output</h3>
      ${renderReportBuilderDropdown({
        builder,
        field: 'visualizationType',
        label: 'Chart / View',
        value: builder.visualizationType,
        options: [
          { value: 'table', label: 'Table' },
          { value: 'bar', label: 'Bar chart' },
          { value: 'line', label: 'Line chart' },
          { value: 'pie', label: 'Pie chart' }
        ]
      })}
      ${renderReportBuilderDropdown({
        builder,
        field: 'option:outputMode',
        label: 'Report Mode',
        value: builder.options.outputMode,
        options: [
          { value: 'internal', label: 'Internal' },
          { value: 'supplier', label: 'Supplier-facing' }
        ]
      })}
      <p>${builder.options.outputMode === 'supplier' ? 'Supplier-facing output hides money and cost columns where possible.' : 'Internal output includes all selected report columns.'}</p>
    </section>
    <section class="reportBuilderSettingsGroup">
      <h3>Governance</h3>
      <label class="reportBuilderControl">
        <span>Allowed Roles</span>
        <input type="text" value="${escapeAttribute(builder.accessPolicy.roles.join(', '))}" data-report-builder-access-policy="roles" aria-label="Allowed roles" placeholder="owner, admin, manager" />
      </label>
      <label class="reportBuilderControl">
        <span>Allowed Location IDs</span>
        <input type="text" value="${escapeAttribute(builder.accessPolicy.locationIds.join(', '))}" data-report-builder-access-policy="locationIds" aria-label="Allowed location IDs" placeholder="Leave blank for all accessible locations" />
      </label>
      <p>Leave blank to allow every role with Reports access. Location restrictions are applied on top of the user's own location permissions.</p>
    </section>
    <section class="reportBuilderSettingsGroup">
      <h3>Data & Filtering</h3>
      ${renderReportBuilderDropdown({
        builder,
        field: 'dataFilter:dateRange',
        label: 'Date Range',
        value: builder.dataFilters.dateRange,
        options: [
          { value: '', label: 'All dates' },
          { value: 'today', label: 'Today' },
          { value: '7d', label: 'Last 7 days' },
          { value: '30d', label: 'Last 30 days' },
          { value: 'month', label: 'This month' },
          { value: 'custom', label: 'Custom range' }
        ]
      })}
      <div class="reportBuilderFilterGrid">
        <label class="reportBuilderControl">
          <span>Start Date</span>
          <input type="date" value="${escapeAttribute(builder.dataFilters.startDate)}" data-report-builder-data-filter="startDate" aria-label="Start date" />
        </label>
        <label class="reportBuilderControl">
          <span>End Date</span>
          <input type="date" value="${escapeAttribute(builder.dataFilters.endDate)}" data-report-builder-data-filter="endDate" aria-label="End date" />
        </label>
      </div>
      ${renderReportBuilderDropdown({
        builder,
        field: 'dataFilter:location',
        label: 'Location',
        value: builder.dataFilters.location,
        options: reportBuilderDataFilterOptions(reportData, 'location')
      })}
      ${renderReportBuilderDropdown({
        builder,
        field: 'dataFilter:category',
        label: 'Category',
        value: builder.dataFilters.category,
        options: reportBuilderDataFilterOptions(reportData, 'category')
      })}
      ${renderReportBuilderDropdown({
        builder,
        field: 'dataFilter:supplier',
        label: 'Supplier',
        value: builder.dataFilters.supplier,
        options: reportBuilderDataFilterOptions(reportData, 'supplier')
      })}
      ${renderReportBuilderDropdown({
        builder,
        field: 'dataFilter:user',
        label: 'User / Operator',
        value: builder.dataFilters.user,
        options: reportBuilderDataFilterOptions(reportData, 'user')
      })}
      ${renderReportBuilderDropdown({
        builder,
        field: 'dataFilter:status',
        label: 'Status',
        value: builder.dataFilters.status,
        options: reportBuilderDataFilterOptions(reportData, 'status')
      })}
      <p>Filters apply across selected source fields. Source-specific fields remain blank for rows from sources that do not provide that column.</p>
    </section>
    <section class="reportBuilderSettingsGroup">
      <h3>Preview Options</h3>
      <label class="reportBuilderCheck">
        <input type="checkbox" ${builder.options.pivotMode ? 'checked' : ''} data-report-builder-option-check="pivotMode" />
        <span>Pivot-style grouping</span>
      </label>
      <label class="reportBuilderCheck">
        <input type="checkbox" ${builder.options.drilldownEnabled ? 'checked' : ''} data-report-builder-option-check="drilldownEnabled" />
        <span>Enable row drill-down</span>
      </label>
      <label class="reportBuilderCheck">
        <input type="checkbox" ${builder.options.showRowNumbers ? 'checked' : ''} data-report-builder-option-check="showRowNumbers" />
        <span>Show row numbers</span>
      </label>
      <label class="reportBuilderCheck">
        <input type="checkbox" ${builder.options.compactRows ? 'checked' : ''} data-report-builder-option-check="compactRows" />
        <span>Compact preview rows</span>
      </label>
      <label class="reportBuilderCheck">
        <input type="checkbox" ${builder.options.showSourceLabels ? 'checked' : ''} data-report-builder-option-check="showSourceLabels" />
        <span>Show source labels in headers</span>
      </label>
      <label class="reportBuilderCheck">
        <input type="checkbox" ${builder.options.freezeHeader ? 'checked' : ''} data-report-builder-option-check="freezeHeader" />
        <span>Freeze table header</span>
      </label>
      <label class="reportBuilderControl">
        <span>Preview Row Limit</span>
        <input type="number" min="5" max="100" value="${escapeAttribute(builder.options.previewLimit)}" data-report-builder-option-input="previewLimit" aria-label="Preview row limit" />
      </label>
      ${renderReportBuilderDropdown({
        builder,
        field: 'option:comparePeriod',
        label: 'Compare Period',
        value: builder.options.comparePeriod,
        options: [
          { value: '', label: 'No comparison' },
          { value: 'previous_period', label: 'This period vs previous period' },
          { value: 'last_week', label: 'This week vs last week' },
          { value: 'last_month', label: 'This month vs last month' }
        ]
      })}
    </section>
    <section class="reportBuilderSettingsGroup">
      <h3>Sorting</h3>
      ${renderReportBuilderDropdown({
        builder,
        field: 'option:sortFieldId',
        label: 'Sort Field',
        value: builder.options.sortFieldId,
        options: [{ value: '', label: 'No default sort' }, ...fieldOptions]
      })}
      ${renderReportBuilderDropdown({
        builder,
        field: 'option:sortDirection',
        label: 'Sort Direction',
        value: builder.options.sortDirection,
        options: [
          { value: 'asc', label: 'Ascending' },
          { value: 'desc', label: 'Descending' }
        ]
      })}
    </section>
    <label class="reportBuilderControl">
      <span>Description <small>Optional</small></span>
      <textarea maxlength="500" data-report-builder-field="description" aria-label="Description">${escapeHtml(builder.description)}</textarea>
      <em>${count}/500</em>
    </label>
  `;
}

function renderReportAutomationPanel(builder, count) {
  return `
    <section class="reportBuilderSettingsGroup">
      <h3>Threshold Alerts</h3>
      ${builder.thresholdRules.map((rule, index) => renderThresholdRule(rule, index, builder)).join('') || '<p>No threshold alerts yet.</p>'}
      <button type="button" data-report-builder-threshold-add>${icon('plus')} Add Alert</button>
      <p>Alerts are evaluated against preview rows and saved with the report for exception reporting.</p>
    </section>
    <section class="reportBuilderSettingsGroup">
      <h3>Shareable Link</h3>
      <label class="reportBuilderCheck">
        <input type="checkbox" ${builder.options.shareEnabled ? 'checked' : ''} data-report-builder-option-check="shareEnabled" />
        <span>Enable read-only link</span>
      </label>
      <label class="reportBuilderControl">
        <span>Read-only link</span>
        <input type="text" readonly value="${escapeAttribute(buildReportShareUrl(builder))}" aria-label="Read-only report link" />
      </label>
      <button type="button" data-report-builder-copy-share>${icon('link')} Copy Link</button>
      <p>Shared links open the saved report in preview mode. Data visibility still follows role and location permissions.</p>
    </section>
    <label class="reportBuilderControl">
      <span>Description <small>Optional</small></span>
      <textarea maxlength="500" data-report-builder-field="description" aria-label="Description">${escapeHtml(builder.description)}</textarea>
      <em>${count}/500</em>
    </label>
  `;
}

function renderThresholdRule(rule, index, builder = {}) {
  const fieldOptions = reportBuilderSelectableFieldOptions(builder, true);
  return `
    <article class="reportBuilderRuleCard">
      ${renderReportBuilderDropdown({ builder, field: `threshold:${index}:fieldId`, label: 'Field', value: rule.fieldId, options: fieldOptions })}
      ${renderReportBuilderDropdown({
        builder,
        field: `threshold:${index}:operator`,
        label: 'Alert when',
        value: rule.operator,
        options: [
          { value: 'greaterThan', label: 'Greater than' },
          { value: 'lessThan', label: 'Less than' },
          { value: 'equals', label: 'Equals' },
          { value: 'contains', label: 'Contains' },
          { value: 'notEmpty', label: 'Has any value' }
        ]
      })}
      <label class="reportBuilderControl">
        <span>Threshold</span>
        <input type="text" value="${escapeAttribute(rule.value)}" data-report-builder-threshold-input="${index}:value" aria-label="Threshold value" ${rule.operator === 'notEmpty' ? 'disabled' : ''} />
      </label>
      <label class="reportBuilderControl">
        <span>Alert Label</span>
        <input type="text" value="${escapeAttribute(rule.label)}" data-report-builder-threshold-input="${index}:label" aria-label="Alert label" />
      </label>
      <button type="button" class="reportBuilderRuleRemove" data-report-builder-threshold-remove="${index}">${icon('trash')} Remove alert</button>
    </article>
  `;
}

function renderFormattingRule(rule, index, builder = {}) {
  const fieldOptions = reportBuilderSelectableFieldOptions(builder, true);
  return `
    <article class="reportBuilderRuleCard">
      ${renderReportBuilderDropdown({ builder, field: `formatting:${index}:fieldId`, label: 'Field', value: rule.fieldId, options: fieldOptions })}
      ${renderReportBuilderDropdown({
        builder,
        field: `formatting:${index}:operator`,
        label: 'Rule',
        value: rule.operator,
        options: [
          { value: 'greaterThan', label: 'Greater than' },
          { value: 'lessThan', label: 'Less than' },
          { value: 'equals', label: 'Equals' },
          { value: 'contains', label: 'Contains' }
        ]
      })}
      <label class="reportBuilderControl">
        <span>Value</span>
        <input type="text" value="${escapeAttribute(rule.value)}" data-report-builder-formatting-input="${index}:value" aria-label="Formatting rule value" />
      </label>
      ${renderReportBuilderDropdown({
        builder,
        field: `formatting:${index}:tone`,
        label: 'Format',
        value: rule.tone,
        options: [
          { value: 'green', label: 'Green highlight' },
          { value: 'red', label: 'Red highlight' },
          { value: 'amber', label: 'Amber highlight' },
          { value: 'blue', label: 'Blue highlight' }
        ]
      })}
      <button type="button" class="reportBuilderRuleRemove" data-report-builder-formatting-remove="${index}">${icon('trash')} Remove rule</button>
    </article>
  `;
}

function renderFilterRule(rule, index, builder = {}) {
  const fieldOptions = reportBuilderSelectableFieldOptions(builder, true);
  return `
    <article class="reportBuilderRuleCard">
      ${renderReportBuilderDropdown({ builder, field: `filter:${index}:fieldId`, label: 'Field', value: rule.fieldId, options: fieldOptions })}
      ${renderReportBuilderDropdown({
        builder,
        field: `filter:${index}:operator`,
        label: 'Filter',
        value: rule.operator,
        options: [
          { value: 'contains', label: 'Contains' },
          { value: 'equals', label: 'Equals' },
          { value: 'greaterThan', label: 'Greater than' },
          { value: 'lessThan', label: 'Less than' },
          { value: 'notEmpty', label: 'Is not empty' }
        ]
      })}
      <label class="reportBuilderControl">
        <span>Value</span>
        <input type="text" value="${escapeAttribute(rule.value)}" data-report-builder-filter-input="${index}:value" aria-label="Filter value" ${rule.operator === 'notEmpty' ? 'disabled' : ''} />
      </label>
      <button type="button" class="reportBuilderRuleRemove" data-report-builder-filter-remove="${index}">${icon('trash')} Remove filter</button>
    </article>
  `;
}

function renderSettingsFilter(fieldId, builder = {}) {
  const field = getReportBuilderField(fieldId, builder.calculatedFields);
  if (!field) return '';
  const value = field.type === 'date' ? 'Selected range' : 'All';
  return `
    <article class="reportBuilderFilterCard">
      ${fieldTypeGlyph(field)}
      <span><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(value)}</small></span>
      <button type="button" data-report-builder-remove="filters|${escapeAttribute(field.id)}" aria-label="Remove filter">${icon('more')}</button>
    </article>
  `;
}

function reportBuilderSelectableFieldOptions(builder = {}, includeAll = false) {
  const selectedIds = [...new Set(reportBuilderLayoutFieldIds(builder.layout || {}))];
  const selected = selectedIds
    .map((id) => getReportBuilderField(id, builder.calculatedFields))
    .filter(Boolean);
  const fields = (includeAll || !selected.length) ? getReportBuilderFields(builder.calculatedFields) : selected;
  return fields.map((field) => ({
    value: field.id,
    label: `${field.label}${field.sourceLabel ? ` · ${field.sourceLabel}` : ''}`
  }));
}

function normalizeReportBuilderState(value = {}, filters = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasExplicitReportConfigId = Object.prototype.hasOwnProperty.call(source, 'reportConfigId');
  const name = String(source.name || filters.customReportName || 'Custom Report').trim() || 'Custom Report';
  const title = String(source.title || name).trim() || name;
  const sourceId = normalizeReportBuilderSourceId(source.sourceId || filters.customSource || 'inventory');
  const calculatedFields = normalizeReportBuilderCalculatedFields(source.calculatedFields);
  const layout = {
    filters: normalizeBuilderFieldIds(source.layout?.filters, [], sourceId, calculatedFields),
    columns: normalizeBuilderFieldIds(source.layout?.columns, [], sourceId, calculatedFields),
    values: normalizeBuilderFieldIds(source.layout?.values, [], sourceId, calculatedFields),
    rows: normalizeBuilderFieldIds(source.layout?.rows, [], sourceId, calculatedFields)
  };
  const layoutSourceIds = reportBuilderLayoutFieldIds(layout).map(reportBuilderSourceIdFromFieldId).filter(Boolean);
  const storedSourceIds = Array.isArray(source.sourceIds) ? source.sourceIds : [];
  const sourceIds = [...new Set([sourceId, ...storedSourceIds, ...layoutSourceIds].map(normalizeReportBuilderSourceListId).filter(Boolean))];
  return {
    reportConfigId: String(hasExplicitReportConfigId ? source.reportConfigId : (source.id || filters.customReportConfigId || '')).trim(),
    name,
    title,
    titleOverridden: source.titleOverridden === true,
    step: Number(source.step ?? 0) || 0,
    sourceId,
    sourceIds,
    calculatedFields,
    calculatedDraftOpen: source.calculatedDraftOpen === true,
    calculatedDraft: {
      name: String(source.calculatedDraft?.name || '').slice(0, 80),
      formula: String(source.calculatedDraft?.formula || '').slice(0, 500),
      type: ['number', 'currency', 'text', 'date'].includes(source.calculatedDraft?.type) ? source.calculatedDraft.type : 'number'
    },
    fieldSearch: String(source.fieldSearch || '').trim(),
    openDropdown: String(source.openDropdown || '').trim(),
    fieldTab: source.fieldTab === 'Frequently Used' ? 'Frequently Used' : 'All Fields',
    settingsTab: ['Format', 'Options', 'Automation'].includes(source.settingsTab) ? source.settingsTab : 'Format',
    showTitle: source.showTitle !== false,
    showTotals: source.showTotals !== false,
    visualizationType: ['table', 'bar', 'line', 'pie'].includes(source.visualizationType) ? source.visualizationType : 'table',
    numberFormat: String(source.numberFormat || 'Currency (ZAR)').trim(),
    dateFormat: String(source.dateFormat || 'MMM d, yyyy').trim(),
    tableStyle: String(source.tableStyle || 'Modern').trim(),
    formattingRules: normalizeReportBuilderFormattingRules(source.formattingRules, calculatedFields, sourceId),
    filterRules: normalizeReportBuilderFilterRules(source.filterRules, calculatedFields, sourceId),
    thresholdRules: normalizeReportBuilderThresholdRules(source.thresholdRules, calculatedFields, sourceId),
    dataFilters: normalizeReportBuilderDataFilters(source.dataFilters),
    accessPolicy: normalizeReportBuilderAccessPolicy(source.accessPolicy),
    options: normalizeReportBuilderOptions(source.options),
    description: String(source.description || '').slice(0, 500),
    templateId: String(source.templateId || '').trim(),
    layout
  };
}

function normalizeReportBuilderAccessPolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    roles: normalizeReportAccessList(source.roles || source.allowedRoles, true),
    locationIds: normalizeReportAccessList(source.locationIds || source.allowedLocationIds)
  };
}

function normalizeReportBuilderDataFilters(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    dateRange: ['', 'today', '7d', '30d', 'month', 'custom'].includes(source.dateRange) ? source.dateRange : '',
    startDate: normalizeDateInput(source.startDate),
    endDate: normalizeDateInput(source.endDate),
    location: String(source.location || '').trim(),
    category: String(source.category || '').trim(),
    supplier: String(source.supplier || '').trim(),
    user: String(source.user || '').trim(),
    status: String(source.status || '').trim()
  };
}

function normalizeDateInput(value = '') {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function normalizeBuilderFieldIds(value, fallback = [], sourceId = '', calculatedFields = []) {
  const ids = Array.isArray(value) ? value : fallback;
  return ids
    .map((id) => normalizeReportBuilderFieldId(id, sourceId, calculatedFields))
    .filter(Boolean);
}

function getReportBuilderFields(calculatedFields = []) {
  const seen = new Set();
  const fields = [];
  (customReportSources || []).forEach((source) => {
    const columns = customColumnsForSource(source);
    columns.forEach((column) => {
      const label = String(column || '').trim();
      if (!label) return;
      const id = reportBuilderFieldId(source.id, label);
      if (seen.has(id)) return;
      seen.add(id);
      const legacy = findLegacyReportBuilderField(label);
      fields.push({
        id,
        label,
        sourceId: source.id,
        sourceLabel: source.label || source.id,
        dataset: source.label || source.group || 'Data Source',
        type: legacy?.type || inferReportBuilderFieldType(label),
        aliases: [...new Set([label, ...(legacy?.aliases || [])])]
      });
    });
  });
  normalizeReportBuilderCalculatedFields(calculatedFields).forEach((field) => {
    if (seen.has(field.id)) return;
    seen.add(field.id);
    fields.push(field);
  });
  return fields.length ? fields : REPORT_BUILDER_FIELDS;
}

function reportBuilderFieldId(sourceId = '', column = '') {
  return `${String(sourceId || '').trim()}::${String(column || '').trim()}`;
}

function reportBuilderSourceIdFromFieldId(fieldId = '') {
  const value = String(fieldId || '').trim();
  if (!value.includes('::')) return '';
  return value.split('::')[0] || '';
}

function reportBuilderColumnFromFieldId(fieldId = '') {
  const value = String(fieldId || '').trim();
  if (!value.includes('::')) return value;
  return value.split('::').slice(1).join('::');
}

function normalizeReportBuilderFieldId(fieldId = '', preferredSourceId = '', calculatedFields = []) {
  const id = String(fieldId || '').trim();
  if (!id) return '';
  if (getReportBuilderFields(calculatedFields).some((field) => field.id === id)) return id;
  const preferredSource = normalizeReportBuilderSourceId(preferredSourceId);
  const legacy = REPORT_BUILDER_FIELDS.find((field) => field.id === id);
  const column = legacy?.label || reportBuilderColumnFromFieldId(id);
  const normalizedColumn = String(column || '').trim().toLowerCase();
  if (!normalizedColumn) return '';
  const fields = getReportBuilderFields(calculatedFields);
  const match = fields.find((field) => field.sourceId === preferredSource && reportBuilderFieldMatchesColumn(field, normalizedColumn, legacy))
    || fields.find((field) => reportBuilderFieldMatchesColumn(field, normalizedColumn, legacy));
  return match?.id || '';
}

function reportBuilderFieldMatchesColumn(field = {}, normalizedColumn = '', legacy = null) {
  const labels = [field.label, ...(field.aliases || [])].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  if (labels.includes(normalizedColumn)) return true;
  if (!legacy) return false;
  return (legacy.aliases || []).some((alias) => labels.includes(String(alias || '').trim().toLowerCase()));
}

function normalizeReportBuilderSourceId(sourceId = '') {
  const id = String(sourceId || '').trim();
  const sources = customReportSources || [];
  return sources.some((source) => source.id === id)
    ? id
    : sources[0]?.id || 'inventory';
}

function normalizeReportBuilderSourceListId(sourceId = '') {
  const id = String(sourceId || '').trim();
  if (id === 'calculated') return id;
  return normalizeReportBuilderSourceId(id);
}

function reportBuilderLayoutFieldIds(layout = {}) {
  return [
    ...(layout.filters || []),
    ...(layout.columns || []),
    ...(layout.values || []),
    ...(layout.rows || [])
  ];
}

function reportBuilderSelectedSources(builder = {}) {
  const sourceIds = new Set([
    ...(Array.isArray(builder.sourceIds) ? builder.sourceIds : []),
    ...reportBuilderLayoutFieldIds(builder.layout || {}).map(reportBuilderSourceIdFromFieldId)
  ].filter(Boolean));
  return [...sourceIds]
    .map((sourceId) => sourceId === 'calculated'
      ? { id: 'calculated', label: 'Calculated Fields' }
      : (customReportSources || []).find((source) => source.id === sourceId))
    .filter(Boolean);
}

function findLegacyReportBuilderField(column = '') {
  const normalized = String(column || '').trim().toLowerCase();
  return REPORT_BUILDER_FIELDS.find((field) => {
    const labels = [field.label, ...(field.aliases || [])].map((value) => String(value || '').trim().toLowerCase());
    return labels.includes(normalized);
  });
}

function inferReportBuilderFieldType(column = '') {
  const normalized = String(column || '').trim().toLowerCase();
  if (/date|created|updated|received|sent|stock-out/.test(normalized)) return 'date';
  if (/cost|value|impact|price|sales|profit|net|gross|refund|tax|vat|spend|loss|cogs|cos|amount|variance \(r\)/.test(normalized)) return 'currency';
  if (/qty|quantity|count|items|lines|orders|stock|threshold|variance|level|par|days|locations|incidents|score|%|percent|gp|usage|produced|expected|depleted|sold|cover/.test(normalized)) return 'number';
  return 'text';
}

function normalizeReportBuilderCalculatedFields(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((field) => {
      const label = String(field?.label || field?.name || '').trim();
      const formula = String(field?.formula || '').trim();
      if (!label || !formula) return null;
      return {
        id: String(field.id || reportBuilderFieldId('calculated', calculatedFieldSlug(label))).trim(),
        label,
        sourceId: 'calculated',
        sourceLabel: 'Calculated',
        dataset: 'Calculated',
        type: ['number', 'currency', 'text', 'date'].includes(field.type) ? field.type : 'number',
        formula,
        aliases: [label]
      };
    })
    .filter(Boolean);
}

function normalizeReportBuilderFormattingRules(value = [], calculatedFields = [], sourceId = '') {
  return (Array.isArray(value) ? value : [])
    .map((rule, index) => ({
      id: String(rule?.id || `format-${index + 1}`).trim(),
      fieldId: normalizeReportBuilderFieldId(rule?.fieldId, sourceId, calculatedFields),
      operator: ['greaterThan', 'lessThan', 'equals', 'contains'].includes(rule?.operator) ? rule.operator : 'greaterThan',
      value: String(rule?.value ?? '').slice(0, 80),
      tone: ['green', 'red', 'amber', 'blue'].includes(rule?.tone) ? rule.tone : 'green'
    }))
    .filter((rule) => rule.fieldId);
}

function normalizeReportBuilderFilterRules(value = [], calculatedFields = [], sourceId = '') {
  return (Array.isArray(value) ? value : [])
    .map((rule, index) => ({
      id: String(rule?.id || `filter-${index + 1}`).trim(),
      fieldId: normalizeReportBuilderFieldId(rule?.fieldId, sourceId, calculatedFields),
      operator: ['contains', 'equals', 'greaterThan', 'lessThan', 'notEmpty'].includes(rule?.operator) ? rule.operator : 'contains',
      value: String(rule?.value ?? '').slice(0, 120)
    }))
    .filter((rule) => rule.fieldId);
}

function normalizeReportBuilderThresholdRules(value = [], calculatedFields = [], sourceId = '') {
  return (Array.isArray(value) ? value : [])
    .map((rule, index) => ({
      id: String(rule?.id || `threshold-${index + 1}`).trim(),
      fieldId: normalizeReportBuilderFieldId(rule?.fieldId, sourceId, calculatedFields),
      operator: ['contains', 'equals', 'greaterThan', 'lessThan', 'notEmpty'].includes(rule?.operator) ? rule.operator : 'greaterThan',
      value: String(rule?.value ?? '').slice(0, 120),
      label: String(rule?.label || rule?.name || `Alert ${index + 1}`).slice(0, 80)
    }))
    .filter((rule) => rule.fieldId);
}

function normalizeReportBuilderOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const previewLimit = Math.min(100, Math.max(5, Number(source.previewLimit || 25) || 25));
  return {
    showRowNumbers: source.showRowNumbers === true,
    compactRows: source.compactRows === true,
    showSourceLabels: source.showSourceLabels !== false,
    freezeHeader: source.freezeHeader === true,
    outputMode: source.outputMode === 'supplier' ? 'supplier' : 'internal',
    pivotMode: source.pivotMode === true,
    drilldownEnabled: source.drilldownEnabled !== false,
    drilldownKey: String(source.drilldownKey || '').trim(),
    comparePeriod: ['', 'previous_period', 'last_week', 'last_month'].includes(source.comparePeriod) ? source.comparePeriod : '',
    shareEnabled: source.shareEnabled === true,
    shareToken: String(source.shareToken || '').trim() || createReportShareToken(),
    previewLimit,
    sortFieldId: String(source.sortFieldId || '').trim(),
    sortDirection: source.sortDirection === 'desc' ? 'desc' : 'asc'
  };
}

function createReportShareToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().slice(0, 18);
  return `share-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function calculatedFieldSlug(label = '') {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `field-${Date.now()}`;
}

function getReportBuilderVisibleFields(builder) {
  const search = String(builder.fieldSearch || '').toLowerCase();
  const frequent = new Set(['Date', 'Item', 'Category', 'Location', 'Supplier', 'Quantity', 'Total Ex', 'Stock Value', 'On Hand', 'Unit Cost']);
  return getReportBuilderFields(builder.calculatedFields).filter((field) => {
    if (builder.fieldTab === 'Frequently Used' && !frequent.has(field.label)) return false;
    return !search || `${field.label} ${field.dataset} ${field.sourceLabel} ${field.type}`.toLowerCase().includes(search);
  });
}

function groupReportBuilderFields(fields) {
  return fields.reduce((groups, field) => {
    groups[field.dataset] = groups[field.dataset] || [];
    groups[field.dataset].push(field);
    return groups;
  }, {});
}

function getReportBuilderField(fieldId, calculatedFields = []) {
  const id = String(fieldId || '').trim();
  return getReportBuilderFields(calculatedFields).find((field) => field.id === id)
    || REPORT_BUILDER_FIELDS.find((field) => field.id === id)
    || null;
}

function fieldTypeGlyph(field = {}) {
  if (field.type === 'number') return '123';
  if (field.type === 'date') return icon('calendar');
  if (field.type === 'currency') return '$';
  return 'A';
}

function buildReportBuilderPreviewRows(builder, reportData = {}, access = {}) {
  return buildReportBuilderOutputRows(builder, reportData, access).slice(0, builder.options.previewLimit);
}

function buildReportBuilderOutputRows(builder, reportData = {}, access = {}) {
  const rowsBySource = reportData.custom?.rowsBySource && typeof reportData.custom.rowsBySource === 'object'
    ? reportData.custom.rowsBySource
    : null;
  const fields = getReportBuilderFields(builder.calculatedFields);
  const selectedSourceIds = reportBuilderSelectedSourceIds(builder, reportData);
  const sourceOptions = reportData.custom?.sourceOptions || customReportSources;
  const sourceLabelFor = (sourceId) => sourceOptions.find((source) => source.id === sourceId)?.label || sourceId;
  const sourceRows = rowsBySource
    ? selectedSourceIds.flatMap((sourceId) => (Array.isArray(rowsBySource[sourceId]) ? rowsBySource[sourceId] : []).map((row) => ({
      row,
      sourceId,
      sourceLabel: sourceLabelFor(sourceId)
    })))
    : (Array.isArray(reportData.rows) ? reportData.rows : []).map((row) => ({
      row,
      sourceId: reportData.custom?.sourceId || builder.sourceId,
      sourceLabel: reportData.custom?.sourceLabel || sourceLabelFor(reportData.custom?.sourceId || builder.sourceId)
    }));
  const mappedRows = sourceRows.map(({ row, sourceId, sourceLabel }) => {
    const mapped = {};
    mapped._reportBuilderSourceId = sourceId;
    mapped._reportBuilderSourceLabel = sourceLabel;
    mapped._reportBuilderRawRow = row;
    fields.filter((field) => field.sourceId !== 'calculated').forEach((field) => {
      mapped[field.id] = !field.sourceId || field.sourceId === sourceId
        ? getReportBuilderRowValue(row, field)
        : '';
    });
    fields.filter((field) => field.sourceId === 'calculated').forEach((field) => {
      mapped[field.id] = evaluateReportBuilderCalculatedField(field, mapped, fields);
    });
    return mapped;
  });
  const filteredRows = mappedRows
    .filter((row) => reportBuilderRowMatchesAccess(row, access))
    .filter((row) => reportBuilderRowMatchesDataFilters(row, builder.dataFilters))
    .filter((row) => reportBuilderRowMatchesFilters(row, builder.filterRules, fields));
  const outputRows = builder.options?.pivotMode
    ? pivotReportBuilderRows(filteredRows, builder, fields)
    : filteredRows.map((row, index) => ({
      ...row,
      _reportBuilderGroupKey: `detail-${index}`,
      _reportBuilderDrillRows: [row._reportBuilderRawRow].filter(Boolean)
    }));
  return sortReportBuilderPreviewRows(outputRows, builder, fields);
}

function pivotReportBuilderRows(rows = [], builder = {}, fields = []) {
  const dimensionIds = [...new Set([...(builder.layout.rows || []), ...(builder.layout.columns || [])])];
  const valueIds = [...new Set(builder.layout.values || [])];
  if (!dimensionIds.length || !valueIds.length) return rows;
  const groups = new Map();
  rows.forEach((row, rowIndex) => {
    const keyParts = dimensionIds.map((fieldId) => String(row[fieldId] ?? 'Unspecified').trim() || 'Unspecified');
    const key = keyParts.join('||') || `group-${rowIndex}`;
    if (!groups.has(key)) {
      const grouped = {
        _reportBuilderGroupKey: key,
        _reportBuilderSourceId: row._reportBuilderSourceId,
        _reportBuilderSourceLabel: row._reportBuilderSourceLabel,
        _reportBuilderRawRow: row._reportBuilderRawRow,
        _reportBuilderDrillRows: []
      };
      dimensionIds.forEach((fieldId) => {
        grouped[fieldId] = row[fieldId] || 'Unspecified';
      });
      valueIds.forEach((fieldId) => {
        grouped[fieldId] = 0;
      });
      groups.set(key, grouped);
    }
    const grouped = groups.get(key);
    grouped._reportBuilderDrillRows.push(row._reportBuilderRawRow);
    valueIds.forEach((fieldId) => {
      const field = fields.find((item) => item.id === fieldId);
      const value = field?.type === 'currency' ? parseMoney(row[fieldId]) : parseNumber(row[fieldId]);
      grouped[fieldId] = (Number(grouped[fieldId]) || 0) + (Number.isFinite(value) ? value : 0);
    });
  });
  return [...groups.values()];
}

function reportBuilderSelectedSourceIds(builder = {}, reportData = {}) {
  const rowsBySource = reportData.custom?.rowsBySource && typeof reportData.custom.rowsBySource === 'object'
    ? reportData.custom.rowsBySource
    : {};
  const ids = new Set([
    builder.sourceId,
    ...(Array.isArray(builder.sourceIds) ? builder.sourceIds : []),
    ...reportBuilderLayoutFieldIds(builder.layout || {}).map(reportBuilderSourceIdFromFieldId)
  ].filter((sourceId) => sourceId && sourceId !== 'calculated'));
  if (!ids.size && reportData.custom?.sourceId) ids.add(reportData.custom.sourceId);
  return [...ids].filter((sourceId) => !rowsBySource || !Object.keys(rowsBySource).length || Array.isArray(rowsBySource[sourceId]));
}

function buildReportBuilderPreviewColumns(builder) {
  const ids = [...builder.layout.rows, ...builder.layout.columns, ...builder.layout.values];
  const sourceCount = new Set(ids.map(reportBuilderSourceIdFromFieldId).filter(Boolean)).size;
  return [...new Set(ids)].map((id) => {
    const field = getReportBuilderField(id, builder.calculatedFields);
    const label = field?.label || reportBuilderColumnFromFieldId(id) || id;
    return {
      id,
      label: `${builder.layout.values.includes(id) && field?.type === 'currency' ? `Sum of ${label}` : label}${builder.options.showSourceLabels && sourceCount > 1 && field?.sourceLabel ? ` (${field.sourceLabel})` : ''}`,
      numeric: ['number', 'currency'].includes(field?.type),
      type: field?.type || 'text'
    };
  });
}

function buildReportBuilderOutputColumns(builder = {}) {
  const columns = buildReportBuilderPreviewColumns(builder);
  if (builder.options?.outputMode !== 'supplier') return columns;
  const supplierSafeColumns = columns.filter((column) => !isSupplierHiddenReportColumn(column));
  return supplierSafeColumns.length ? supplierSafeColumns : columns;
}

function isSupplierHiddenReportColumn(column = {}) {
  const label = String(column.label || '').toLowerCase();
  if (column.type === 'currency') return true;
  return /\b(cost|price|vat|tax|total|subtotal|margin|profit|gp|cogs|cos|value|amount|revenue|sales|spend|loss|ex vat|inc vat|ex)\b/.test(label);
}

function reportBuilderRowMatchesFilters(row = {}, rules = [], fields = []) {
  return (rules || []).every((rule) => {
    const field = fields.find((item) => item.id === rule.fieldId);
    const value = row[rule.fieldId];
    return reportBuilderRuleMatches(value, rule, field);
  });
}

function reportBuilderRowMatchesAccess(row = {}, access = {}) {
  if (access.currentIsSuperUser === true) return true;
  const role = access.currentRole || '';
  const customRoles = access.customRoles || [];
  const knownLocations = Array.isArray(access.locations) ? access.locations : [];
  const accessibleLocations = knownLocations.filter((location) => hasLocationAccess(location.id, role, customRoles));
  if (!knownLocations.length || accessibleLocations.length === knownLocations.length) return true;
  const allowedNames = new Set(accessibleLocations.flatMap((location) => [
    location.id,
    location.name,
    location.displayName
  ]).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  const knownNames = new Set(knownLocations.flatMap((location) => [
    location.id,
    location.name,
    location.displayName
  ]).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  const rowLocations = reportBuilderRowLocationValues(row).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  if (!rowLocations.length) return true;
  return rowLocations.every((location) => !knownNames.has(location) || allowedNames.has(location));
}

function reportBuilderRowLocationValues(row = {}) {
  const raw = row._reportBuilderRawRow && typeof row._reportBuilderRawRow === 'object' ? row._reportBuilderRawRow : {};
  const candidates = ['Location', 'From', 'To', 'Deliver To', 'Receiving Location'];
  return candidates.flatMap((column) => {
    const directField = Object.keys(row).find((fieldId) => reportBuilderColumnFromFieldId(fieldId) === column);
    return [directField ? row[directField] : '', raw[column]];
  });
}

function reportBuilderRowMatchesDataFilters(row = {}, filters = {}) {
  const normalized = normalizeReportBuilderDataFilters(filters);
  const dateWindow = reportBuilderDateWindow(normalized);
  if (dateWindow) {
    const rowDate = reportBuilderComparableDate(reportBuilderDataFilterValue(row, 'date'));
    if (!rowDate || rowDate < dateWindow.start || rowDate > dateWindow.end) return false;
  }
  return ['location', 'category', 'supplier', 'user', 'status'].every((key) => {
    const expected = String(normalized[key] || '').trim();
    if (!expected) return true;
    const actual = String(reportBuilderDataFilterValue(row, key) || '').trim().toLowerCase();
    return actual === expected.toLowerCase();
  });
}

function reportBuilderDateWindow(filters = {}) {
  const today = new Date();
  const todayKey = dateInputValue(today);
  const range = String(filters.dateRange || '').trim();
  if (!range && !filters.startDate && !filters.endDate) return null;
  let start = filters.startDate || '';
  let end = filters.endDate || '';
  if (range === 'today') {
    start = todayKey;
    end = todayKey;
  } else if (range === '7d') {
    start = dateInputValue(addDays(todayKey, -6));
    end = todayKey;
  } else if (range === '30d') {
    start = dateInputValue(addDays(todayKey, -29));
    end = todayKey;
  } else if (range === 'month') {
    start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    end = todayKey;
  }
  const startTime = start ? reportBuilderComparableDate(start) : Number.NEGATIVE_INFINITY;
  const endTime = end ? reportBuilderComparableDate(end) + 86399999 : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(startTime) && !Number.isFinite(endTime)) return null;
  return { start: startTime, end: endTime };
}

function reportBuilderComparableDate(value = '') {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function dateInputValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function reportBuilderDataFilterValue(row = {}, key = '') {
  const raw = row._reportBuilderRawRow && typeof row._reportBuilderRawRow === 'object' ? row._reportBuilderRawRow : {};
  const candidates = {
    date: ['Date', 'Order Date', 'Created Date', 'Updated Date', 'Stock-out Date', 'Predicted Stock-out Date'],
    location: ['Location', 'From', 'To', 'Deliver To', 'Receiving Location'],
    category: ['Category', 'Product Category', 'Modifier Category', 'Waste Reason'],
    supplier: ['Supplier'],
    user: ['User', 'Operator', 'Created By', 'Posted By'],
    status: ['Status', 'Product Status', 'Risk Level', 'Action', 'Mode']
  }[key] || [];
  for (const column of candidates) {
    const directField = Object.keys(row).find((fieldId) => reportBuilderColumnFromFieldId(fieldId) === column);
    const value = directField ? row[directField] : raw[column];
    if (String(value ?? '').trim()) return value;
  }
  return '';
}

function reportBuilderDataFilterOptions(reportData = {}, key = '') {
  const rowsBySource = reportData.custom?.rowsBySource && typeof reportData.custom.rowsBySource === 'object'
    ? Object.values(reportData.custom.rowsBySource).flatMap((rows) => Array.isArray(rows) ? rows : [])
    : (Array.isArray(reportData.rows) ? reportData.rows : []);
  const labels = {
    location: 'All locations',
    category: 'All categories',
    supplier: 'All suppliers',
    user: 'All users',
    status: 'All statuses'
  };
  const values = [...new Set(rowsBySource
    .map((row) => reportBuilderRawFilterValue(row, key))
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return [
    { value: '', label: labels[key] || 'All' },
    ...values.map((value) => ({ value, label: value }))
  ];
}

function reportBuilderRawFilterValue(row = {}, key = '') {
  const candidates = {
    location: ['Location', 'From', 'To', 'Deliver To', 'Receiving Location'],
    category: ['Category', 'Product Category', 'Modifier Category', 'Waste Reason'],
    supplier: ['Supplier'],
    user: ['User', 'Operator', 'Created By', 'Posted By'],
    status: ['Status', 'Product Status', 'Risk Level', 'Action', 'Mode']
  }[key] || [];
  for (const column of candidates) {
    if (String(row[column] ?? '').trim()) return row[column];
  }
  return '';
}

function sortReportBuilderPreviewRows(rows = [], builder = {}, fields = []) {
  const sortFieldId = builder.options?.sortFieldId || '';
  if (!sortFieldId) return rows;
  const field = fields.find((item) => item.id === sortFieldId);
  if (!field) return rows;
  const direction = builder.options?.sortDirection === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    const leftValue = reportBuilderComparableValue(left[sortFieldId], field);
    const rightValue = reportBuilderComparableValue(right[sortFieldId], field);
    if (leftValue < rightValue) return -1 * direction;
    if (leftValue > rightValue) return 1 * direction;
    return 0;
  });
}

function reportBuilderCellClass(row = {}, column = {}, builder = {}) {
  const classes = [column.numeric ? 'is-number' : ''];
  const rule = (builder.formattingRules || []).find((item) => item.fieldId === column.id && reportBuilderRuleMatches(row[column.id], item, column));
  if (rule) classes.push(`is-rule-${rule.tone}`);
  return classes.filter(Boolean).join(' ');
}

function buildReportBuilderAlerts(builder = {}, rows = []) {
  const fields = getReportBuilderFields(builder.calculatedFields);
  return (builder.thresholdRules || []).flatMap((rule) => {
    const field = fields.find((item) => item.id === rule.fieldId);
    if (!field) return [];
    const matches = rows.filter((row) => reportBuilderRuleMatches(row[rule.fieldId], rule, field));
    if (!matches.length) return [];
    return [{
      label: rule.label || field.label,
      count: matches.length,
      message: `${rule.label || field.label}: ${matches.length} row${matches.length === 1 ? '' : 's'} breached`
    }];
  });
}

function buildReportBuilderComparison(builder = {}, rows = [], columns = []) {
  const mode = builder.options?.comparePeriod || '';
  if (!mode) return { label: 'No comparison', detail: 'Enable compare period to compare current rows with a previous period.' };
  const numeric = columns.find((column) => column.numeric);
  const dateField = getReportBuilderFields(builder.calculatedFields).find((field) => field.type === 'date' && rows.some((row) => row[field.id]));
  if (!numeric || !dateField) return { label: 'Comparison ready', detail: 'Add a date field and numeric value to calculate period movement.' };
  const now = new Date();
  const currentWindow = reportBuilderComparisonWindow(mode, now, false);
  const previousWindow = reportBuilderComparisonWindow(mode, now, true);
  const sumInWindow = (windowValue) => rows.reduce((sum, row) => {
    const timestamp = reportBuilderComparableDate(row[dateField.id]);
    if (!timestamp || timestamp < windowValue.start || timestamp > windowValue.end) return sum;
    return sum + (numeric.type === 'currency' ? parseMoney(row[numeric.id]) : parseNumber(row[numeric.id]));
  }, 0);
  const current = sumInWindow(currentWindow);
  const previous = sumInWindow(previousWindow);
  const delta = previous ? ((current - previous) / Math.abs(previous)) * 100 : 0;
  return {
    label: `${delta >= 0 ? '+' : ''}${formatNumber(delta)}%`,
    detail: `${numeric.label} vs previous period: ${formatReportBuilderNumberValue(current, builder, numeric.type)} now, ${formatReportBuilderNumberValue(previous, builder, numeric.type)} before`
  };
}

function reportBuilderComparisonWindow(mode = '', now = new Date(), previous = false) {
  const end = new Date(now);
  const start = new Date(now);
  if (mode === 'last_week') {
    const day = now.getDay() || 7;
    start.setDate(now.getDate() - day + 1 - (previous ? 7 : 0));
    end.setDate(start.getDate() + 6);
  } else if (mode === 'last_month') {
    start.setDate(1);
    if (previous) start.setMonth(start.getMonth() - 1);
    end.setFullYear(start.getFullYear(), start.getMonth() + 1, 0);
  } else {
    start.setDate(now.getDate() - (previous ? 13 : 6));
    end.setDate(now.getDate() - (previous ? 7 : 0));
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

function buildReportBuilderChartSeries(builder = {}, rows = [], columns = []) {
  const labelColumn = columns.find((column) => !column.numeric) || columns[0];
  const valueColumn = columns.find((column) => column.numeric);
  if (!labelColumn || !valueColumn) return [];
  const map = new Map();
  rows.forEach((row) => {
    const label = String(row[labelColumn.id] ?? 'Unspecified').trim() || 'Unspecified';
    const value = valueColumn.type === 'currency' ? parseMoney(row[valueColumn.id]) : parseNumber(row[valueColumn.id]);
    map.set(label, (map.get(label) || 0) + (Number.isFinite(value) ? value : 0));
  });
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
    .slice(0, 12);
}

function buildReportShareUrl(builder = {}) {
  if (typeof window === 'undefined') return '';
  const reportId = String(builder.reportConfigId || '').trim();
  const token = String(builder.options?.shareToken || '').trim();
  const url = new URL(window.location.href);
  url.searchParams.set('report', reportId || 'unsaved');
  if (token) url.searchParams.set('share', token);
  url.searchParams.set('mode', 'preview');
  return url.toString();
}

function buildSavedReportShareUrl(report = {}) {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  url.searchParams.set('report', report.reportConfigId || report.id || 'saved');
  url.searchParams.set('share', report.shareToken || report.config?.shareToken || report.config?.builder?.options?.shareToken || '');
  url.searchParams.set('mode', 'preview');
  return url.toString();
}

function reportBuilderRuleMatches(value, rule = {}, field = {}) {
  if (!rule?.fieldId) return false;
  if (rule.operator === 'notEmpty') return String(value ?? '').trim() !== '';
  const expected = String(rule.value ?? '').trim();
  const actual = String(value ?? '').trim();
  if (rule.operator === 'contains') return actual.toLowerCase().includes(expected.toLowerCase());
  if (rule.operator === 'equals') return actual.toLowerCase() === expected.toLowerCase();
  const actualNumber = field?.type === 'currency' ? parseMoney(value) : parseNumber(value);
  const expectedNumber = parseNumber(expected);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
  if (rule.operator === 'greaterThan') return actualNumber > expectedNumber;
  if (rule.operator === 'lessThan') return actualNumber < expectedNumber;
  return false;
}

function reportBuilderComparableValue(value, field = {}) {
  if (field.type === 'currency') return parseMoney(value);
  if (field.type === 'number') return parseNumber(value);
  if (field.type === 'date') {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return String(value ?? '').toLowerCase();
}

function formatReportBuilderCell(row, column, builder = {}) {
  return escapeHtml(formatReportBuilderExportValue(row, column, builder));
}

function formatReportBuilderTotal(column, totals, builder = {}) {
  return escapeHtml(formatReportBuilderExportTotal(column, totals, builder));
}

function buildReportBuilderTotals(rows, columns) {
  return rows.reduce((totals, row) => {
    columns.forEach((column) => {
      if (!column.numeric) return;
      totals[column.id] = (totals[column.id] || 0) + (column.type === 'currency' ? parseMoney(row[column.id]) : parseNumber(row[column.id]));
    });
    return totals;
  }, {});
}

function formatReportBuilderExportValue(row = {}, column = {}, builder = {}) {
  const value = row[column.id];
  if (column.type === 'currency') return formatReportBuilderNumberValue(parseMoney(value), builder, 'currency');
  if (column.type === 'number') return formatReportBuilderNumberValue(parseNumber(value), builder, 'number');
  if (column.type === 'date') return formatReportBuilderDate(value, builder.dateFormat);
  return value ?? '';
}

function formatReportBuilderExportTotal(column = {}, totals = {}, builder = {}) {
  if (!column.numeric) return '';
  return formatReportBuilderNumberValue(totals[column.id] || 0, builder, column.type);
}

function formatReportBuilderNumberValue(value, builder = {}, type = '') {
  const number = Number.isFinite(Number(value)) ? Number(value) : 0;
  if (builder.numberFormat === 'Percentage') return `${formatNumber(number)}%`;
  if (builder.numberFormat === 'Number' || type === 'number') return formatNumber(number);
  return formatMoney(number);
}

function formatReportBuilderDate(value, dateFormat = 'MMM d, yyyy') {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value ?? '';
  const date = new Date(timestamp);
  const monthShort = date.toLocaleString('en-ZA', { month: 'short' });
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  if (dateFormat === 'yyyy/MM/dd') return `${year}/${month}/${day}`;
  if (dateFormat === 'dd MMM yyyy') return `${day} ${monthShort} ${year}`;
  return `${monthShort} ${date.getDate()}, ${year}`;
}

function buildReportBuilderOutput(builder = {}, reportData = {}, access = {}) {
  const outputRows = buildReportBuilderOutputRows(builder, reportData, access);
  const columns = buildReportBuilderOutputColumns(builder);
  const totals = buildReportBuilderTotals(outputRows, columns);
  const rows = outputRows.map((row, index) => {
    const base = builder.options?.showRowNumbers ? { '#': index + 1 } : {};
    columns.forEach((column) => {
      base[column.label] = formatReportBuilderExportValue(row, column, builder);
    });
    return base;
  });
  const exportColumns = [
    ...(builder.options?.showRowNumbers ? ['#'] : []),
    ...columns.map((column) => column.label)
  ];
  const includeTotals = builder.showTotals && builder.options?.outputMode !== 'supplier' && columns.some((column) => column.numeric);
  if (includeTotals) {
    const totalRow = Object.fromEntries(exportColumns.map((column) => [column, '']));
    const firstDataColumn = builder.options?.showRowNumbers ? exportColumns[1] : exportColumns[0];
    if (firstDataColumn) totalRow[firstDataColumn] = 'Total';
    columns.forEach((column) => {
      if (column.numeric) totalRow[column.label] = formatReportBuilderExportTotal(column, totals, builder);
    });
    rows.push(totalRow);
  }
  const reportName = String(builder.name || builder.title || 'Custom Report').trim() || 'Custom Report';
  const title = builder.showTitle ? (String(builder.title || reportName).trim() || reportName) : 'Custom Report';
  const description = String(builder.description || '').trim();
  const mode = builder.options?.outputMode === 'supplier' ? 'Supplier-facing' : 'Internal';
  return {
    filename: slugifyReportFilename(reportName),
    sheetName: reportName.slice(0, 30) || 'Custom Report',
    title,
    subtitle: description || `${mode} report`,
    rows,
    columns: exportColumns,
    summaryRows: [
      ...(builder.showTitle ? [{ label: 'Report', value: title }] : []),
      ...(description ? [{ label: 'Description', value: description }] : []),
      { label: 'Mode', value: mode },
      { label: 'Rows', value: outputRows.length },
      { label: 'Totals', value: includeTotals ? 'Included' : 'Excluded' },
      { label: 'Number format', value: builder.numberFormat || 'Currency (ZAR)' },
      { label: 'Date format', value: builder.dateFormat || 'MMM d, yyyy' },
      { label: 'Generated', value: new Date().toLocaleString('en-ZA') }
    ]
  };
}

function slugifyReportFilename(value = '') {
  return String(value || 'custom-report')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'custom_report';
}

function getReportBuilderRowValue(row = {}, field = {}) {
  const aliases = field.aliases || [field.label];
  const key = aliases.find((alias) => Object.prototype.hasOwnProperty.call(row, alias));
  return key ? row[key] : '';
}

function evaluateReportBuilderCalculatedField(field = {}, mapped = {}, fields = []) {
  const formula = String(field.formula || '').trim();
  if (!formula) return '';
  if (field.type === 'text') return formula.replace(/\{([^}]+)\}/g, (_, token) => {
    const ref = findCalculatedFieldReference(token, fields);
    return ref ? String(mapped[ref.id] ?? '') : '';
  });
  const expression = formula.replace(/\{([^}]+)\}/g, (_, token) => {
    const ref = findCalculatedFieldReference(token, fields);
    if (!ref) return '0';
    const value = ref.type === 'currency' ? parseMoney(mapped[ref.id]) : parseNumber(mapped[ref.id]);
    return Number.isFinite(value) ? String(value) : '0';
  });
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) return '';
  try {
    const result = Function(`"use strict"; return (${expression});`)();
    return Number.isFinite(Number(result)) ? Number(result) : '';
  } catch {
    return '';
  }
}

function findCalculatedFieldReference(token = '', fields = []) {
  const normalized = String(token || '').trim().toLowerCase();
  if (!normalized) return null;
  return fields.find((field) => {
    const label = String(field.label || '').trim().toLowerCase();
    const sourceLabel = String(field.sourceLabel || '').trim().toLowerCase();
    return label === normalized || `${sourceLabel}.${label}` === normalized || `${sourceLabel}: ${label}` === normalized;
  }) || null;
}

function renderCustomReportDashboard({ filters, analytics, savedReports = [] }) {
  const reports = buildCustomDashboardReports(savedReports);
  const filteredReports = filterCustomDashboardReports(reports, filters);
  const sortedReports = sortCustomDashboardReports(filteredReports, filters.customReportsSort || 'updated');
  const viewMode = filters.customReportsViewMode === 'list' ? 'list' : 'grid';
  const emailReport = findCustomDashboardReport(reports, filters.customReportEmailId);
  const manageReport = findCustomDashboardReport(reports, filters.customReportManageId);
  const scheduled = reports.filter((report) => isRecurringReportSchedule(report));
  const recentlySent = reports
    .filter((report) => report.lastSentAt || report.status === 'Sent Today' || Number(report.sentThisMonth || 0) > 0)
    .sort((left, right) => dashboardTimestamp(right.lastSentAt || right.updatedAt) - dashboardTimestamp(left.lastSentAt || left.updatedAt))
    .slice(0, 5);
  const recentlyViewed = [...reports]
    .sort((left, right) => dashboardTimestamp(right.lastViewedAt || right.updatedAt) - dashboardTimestamp(left.lastViewedAt || left.updatedAt))
    .slice(0, 5);
  const widgetReports = reports.filter((report) => report.favourite).slice(0, 4);
  const exceptionReports = buildCustomDashboardExceptionReports(reports);

  return `
    <div class="customReportsDashboard" data-custom-reports-dashboard>
      <main class="customReportsDashboardMain">
        ${renderCustomDashboardHeader(filters)}
        ${analytics.reportConfigError ? `<div class="customReportsNotice customReportsNotice--error">${escapeHtml(analytics.reportConfigError)}</div>` : ''}
        ${filters.customReportEmailSentMessage ? `<div class="customReportsNotice customReportsNotice--success">${escapeHtml(filters.customReportEmailSentMessage)}</div>` : ''}
        ${filters.customReportsLoading ? renderCustomDashboardLoading(analytics.actionStatus === 'saving-report' ? 'Saving report...' : 'Loading reports...') : ''}
        ${filters.customReportsError ? `<div class="customReportsNotice customReportsNotice--error">${escapeHtml(filters.customReportsError)}</div>` : ''}
        ${renderCustomDashboardMetrics(reports)}
        ${widgetReports.length ? renderCustomDashboardWidgetStrip(widgetReports) : ''}
        ${renderCustomDashboardExceptionReports(exceptionReports)}
        ${filters.customReportsFiltersOpen ? renderReportFiltersPanel(filters, reports) : ''}
        <section class="customReportsSection" aria-labelledby="custom-reports-all-title">
          <header class="customReportsSectionHeader">
            <div>
              <h2 id="custom-reports-all-title">All Reports <span>(${sortedReports.length})</span></h2>
              <p>${reports.length ? 'Create, review, email, and schedule custom reports.' : 'Saved custom reports will appear here.'}</p>
            </div>
            <div class="customReportsSectionTools">
              <div class="customReportsViewToggle" role="group" aria-label="Toggle reports view">
                <button type="button" class="${viewMode === 'grid' ? 'is-active' : ''}" data-custom-dashboard-view="grid" aria-pressed="${viewMode === 'grid'}">${icon('grid')} Grid</button>
                <button type="button" class="${viewMode === 'list' ? 'is-active' : ''}" data-custom-dashboard-view="list" aria-pressed="${viewMode === 'list'}">${icon('list')} List</button>
              </div>
              ${renderCustomDashboardDropdown({
                field: 'customReportsSort',
                label: 'Sort',
                value: filters.customReportsSort || 'updated',
                options: [
                  { value: 'updated', label: 'Last Updated' },
                  { value: 'name', label: 'Name' },
                  { value: 'created', label: 'Created Date' },
                  { value: 'status', label: 'Status' },
                  { value: 'viewed', label: 'Most Viewed' }
                ],
                openDropdown: filters.openDropdown
              })}
            </div>
          </header>
          ${reports.length
            ? sortedReports.length
              ? viewMode === 'list'
                ? renderReportsList(sortedReports, filters)
                : renderReportsGrid(sortedReports, filters)
              : renderCustomDashboardEmptyState('No search results', 'Try changing your search, status, creator, schedule, or recipient filters.', true)
            : renderCustomDashboardEmptyState('No reports yet', 'Create your first reusable custom report and it will live here.', true)}
        </section>
        <section class="customReportsLowerGrid">
          ${renderRecentlyViewedReports(recentlyViewed)}
          ${renderScheduledEmailsTable(scheduled)}
          ${renderRecentlySentReports(recentlySent)}
        </section>
        <p class="customReportsTimezone">All times shown in your local timezone. ${renderReportInfo('Custom reports use saved KCP configurations from this workspace.')}</p>
      </main>
      ${emailReport ? renderEmailReportModal(emailReport, filters) : ''}
      ${manageReport ? renderManageReportModal(manageReport, filters) : ''}
    </div>
  `;
}

function renderCustomDashboardWidgetStrip(reports = []) {
  return `
    <section class="customReportsWidgetStrip" aria-label="Pinned dashboard widgets">
      <header>
        <div>
          <h2>Dashboard Widgets</h2>
          <p>Pinned saved reports that can act as dashboard widgets.</p>
        </div>
      </header>
      <div>
        ${reports.map((report) => `
          <article>
            <span>${icon(reportIcon(report.sourceId || 'custom_report'))}</span>
            <div>
              <strong>${escapeHtml(report.name)}</strong>
              <small>${escapeHtml(`${visualizationLabel(report.chartType || report.visualizationType || 'table')} · ${report.scheduleType || 'On Demand'}`)}</small>
            </div>
            <button type="button" data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="view">${icon('eye')}</button>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function buildCustomDashboardExceptionReports(reports = []) {
  const savedByTag = (tag) => reports.find((report) => (report.tags || []).some((item) => String(item || '').toLowerCase().includes(tag)));
  return [
    {
      id: 'low_stock',
      title: 'Low Stock',
      helper: 'Items below threshold or par level.',
      action: 'Open low stock report',
      reportId: savedByTag('low stock')?.id || '',
      nativeReportId: 'low_stock',
      tone: 'blue'
    },
    {
      id: 'high_wastage',
      title: 'High Wastage',
      helper: 'Wastage value and incident exceptions.',
      action: savedByTag('wastage') ? 'Open saved report' : 'Open high wastage report',
      reportId: savedByTag('wastage')?.id || '',
      nativeReportId: 'waste_pareto',
      templateId: 'wastage-control',
      tone: 'orange'
    },
    {
      id: 'missing_recipes',
      title: 'Missing Recipes',
      helper: 'Menu items requiring recipe completion.',
      action: savedByTag('missing') ? 'Open saved report' : 'Open missing recipes report',
      reportId: savedByTag('missing')?.id || '',
      nativeReportId: 'missing_recipes',
      templateId: 'missing-recipe-exception',
      tone: 'red'
    }
  ];
}

function renderCustomDashboardExceptionReports(items = []) {
  return `
    <section class="customReportsExceptionRail" aria-label="Scheduled exception reports">
      <header>
        <div>
          <h2>Exception Reports</h2>
          <p>Schedule or open reports for low stock, high wastage, and missing recipes.</p>
        </div>
      </header>
      <div>
        ${items.map((item) => `
          <article class="customReportsExceptionRail__item customReportsExceptionRail__item--${escapeAttribute(item.tone)}">
            <span>${icon(item.id === 'low_stock' ? 'activity' : item.id === 'missing_recipes' ? 'file' : 'chart')}</span>
            <div>
              <strong>${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(item.helper)}</small>
            </div>
            ${item.reportId
              ? `<button type="button" data-custom-dashboard-open="${escapeAttribute(item.reportId)}" data-mode="view">${escapeHtml(item.action)}</button>`
              : item.nativeReportId
                ? `<button type="button" data-custom-exception-report="${escapeAttribute(item.nativeReportId)}">${escapeHtml(item.action)}</button>`
                : `<button type="button" data-custom-exception-template="${escapeAttribute(item.templateId)}">${escapeHtml(item.action)}</button>`}
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderCustomDashboardHeader(filters) {
  return `
    <header class="customReportsHeader">
      <div>
        <h1>Custom Reports Dashboard</h1>
        <p>Manage, view, and share your saved reports</p>
      </div>
      <div class="customReportsHeaderTools">
        <label class="customReportsSearch">
          ${icon('search')}
          <input type="search" value="${escapeAttribute(filters.customReportsSearch || '')}" placeholder="Search reports..." data-custom-dashboard-field="customReportsSearch" data-focus-key="custom-reports-search" aria-label="Search reports" />
        </label>
        <button type="button" class="customReportsToolbarButton ${filters.customReportsFiltersOpen ? 'is-active' : ''}" data-custom-dashboard-toggle-filters aria-expanded="${filters.customReportsFiltersOpen ? 'true' : 'false'}">
          ${icon('filter')} Filters
        </button>
        <div class="customReportsCreateGroup">
          <button type="button" class="customReportsCreateButton" data-custom-dashboard-create>${icon('plus')} Create Report</button>
          <button type="button" class="customReportsCreateCaret" data-custom-dashboard-create aria-label="Open create report options">${icon('chevronDown')}</button>
        </div>
      </div>
    </header>
  `;
}

function renderCustomDashboardMetrics(reports) {
  const scheduled = reports.filter((report) => isRecurringReportSchedule(report)).length;
  const sentThisMonth = reports.reduce((sum, report) => sum + (Number(report.sentThisMonth || 0) || (report.status === 'Sent Today' ? 1 : 0)), 0);
  const activeRecipients = new Set(reports.flatMap((report) => report.recipients || [])).size || reports.reduce((sum, report) => sum + Number(report.recipientCount || 0), 0);
  const metrics = [
    { label: 'Saved Reports', value: String(reports.length), delta: 'Workspace configs', icon: 'file', tone: 'blue' },
    { label: 'Scheduled Reports', value: String(scheduled), delta: 'Email automation', icon: 'calendar', tone: 'purple' },
    { label: 'Sent This Month', value: String(sentThisMonth), delta: 'Logged sends', icon: 'send', tone: 'teal' },
    { label: 'Recipients', value: String(activeRecipients), delta: 'Saved contacts', icon: 'users', tone: 'orange' }
  ];
  return `<section class="customReportsMetrics" aria-label="Report summary">${metrics.map((metric) => renderMetricCard(metric)).join('')}</section>`;
}

function renderMetricCard(metric) {
  return `
    <article class="customReportsMetric customReportsMetric--${escapeAttribute(metric.tone)}">
      <span>${icon(metric.icon)}</span>
      <div>
        <small>${escapeHtml(metric.label)}</small>
        <strong>${escapeHtml(metric.value)}</strong>
        <em>${escapeHtml(metric.delta)}</em>
      </div>
    </article>
  `;
}

function isRecurringReportSchedule(report = {}) {
  const type = String(report.scheduleType || '').trim();
  return report.status === 'Scheduled' || ['Daily', 'Weekly', 'Monthly'].includes(type);
}

function renderReportsGrid(reports, filters) {
  return `<div class="customReportsGrid">${reports.map((report) => renderReportCard(report, filters)).join('')}</div>`;
}

function renderReportCard(report, filters) {
  const menuOpen = filters.openDropdown === `custom-report-menu-${report.id}`;
  return `
    <article class="customReportCard ${report.favourite ? 'is-pinned' : ''}">
      <header>
        <h3>${escapeHtml(report.name)}</h3>
        <div>
          <button type="button" class="customReportPinButton ${report.favourite ? 'is-active' : ''}" data-custom-report-toggle-pin="${escapeAttribute(report.reportConfigId || report.id)}" aria-label="${report.favourite ? 'Unpin report' : 'Pin report'}">${icon('star')}</button>
          ${renderReportStatusBadge(report.status)}
        </div>
      </header>
      <div class="customReportCardBody">
        ${renderReportPreviewChart(report)}
        <p>${escapeHtml(report.description)}</p>
      </div>
      <div class="customReportMeta">
        <div>
          <span class="customReportsMiniAvatar">${escapeHtml(report.createdByAvatar)}</span>
          <small>Created by</small>
          <strong>${escapeHtml(report.createdBy)}</strong>
        </div>
        <div>
          <small>Last updated</small>
          <strong>${escapeHtml(formatReportDashboardDate(report.updatedAt))}</strong>
        </div>
      </div>
      <div class="customReportSchedule">
        <span>${icon('calendar')} <b>${escapeHtml(report.scheduleType)}</b><small>${escapeHtml(report.scheduleLabel)}</small></span>
        <span>${icon('users')} <b>${escapeHtml(String(report.recipientCount))}</b><small>Recipients</small></span>
        <button type="button" data-analytics-dropdown="custom-report-menu-${escapeAttribute(report.id)}" aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}" aria-label="More actions for ${escapeAttribute(report.name)}">${icon('more')}</button>
        ${menuOpen ? renderReportOverflowMenu(report) : ''}
      </div>
      <footer>
        <button type="button" data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="view">View</button>
        <button type="button" class="is-primary" data-custom-report-email-now="${escapeAttribute(report.id)}">Email Now</button>
        <button type="button" data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="edit">Edit</button>
      </footer>
    </article>
  `;
}

function renderReportsList(reports) {
  return `
    <div class="customReportsListWrap">
      <table class="customReportsList">
        <thead>
          <tr>
            <th scope="col">Report</th>
            <th scope="col">Status</th>
            <th scope="col">Schedule</th>
            <th scope="col">Recipients</th>
            <th scope="col">Updated</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${reports.map((report) => `
            <tr>
              <td><strong>${escapeHtml(report.name)}</strong><small>${escapeHtml(report.description)}</small></td>
              <td>${renderReportStatusBadge(report.status)}</td>
              <td><strong>${escapeHtml(report.scheduleType)}</strong><small>${escapeHtml(report.scheduleLabel)}</small></td>
              <td>${renderRecipientAvatars(report)} <span>${escapeHtml(String(report.recipientCount))}</span></td>
              <td>${escapeHtml(formatReportDashboardDate(report.updatedAt))}</td>
              <td>
                <button type="button" data-custom-report-toggle-pin="${escapeAttribute(report.reportConfigId || report.id)}" aria-label="${report.favourite ? 'Unpin report' : 'Pin report'}">${icon('star')}</button>
                <button type="button" data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="view">View</button>
                <button type="button" data-custom-report-email-now="${escapeAttribute(report.id)}">Email</button>
                <button type="button" data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="edit">Edit</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderReportOverflowMenu(report) {
  const items = [
    ['duplicate', 'Duplicate'],
    ['rename', 'Rename'],
    ['schedule', 'Schedule Email'],
    ['recipients', 'Manage Recipients'],
    ['share', 'Share Link'],
    ['download', 'Download'],
    ['archive', 'Archive'],
    ['delete', 'Delete']
  ];
  return `
    <div class="customReportMenu" role="menu">
      ${items.map(([action, label]) => `
        <button type="button" role="menuitem" data-custom-dashboard-overflow-action="${escapeAttribute(action)}" data-report-id="${escapeAttribute(report.id)}">
          ${action === 'delete' ? icon('trash') : icon(action === 'download' ? 'download' : action === 'schedule' ? 'calendar' : 'file')}
          ${escapeHtml(label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderReportStatusBadge(status = '') {
  const key = String(status || 'Active').toLowerCase().replace(/\s+/g, '-');
  return `<span class="customReportStatus customReportStatus--${escapeAttribute(key)}"><i></i>${escapeHtml(status || 'Active')}</span>`;
}

function renderReportPreviewChart(report) {
  if (!Array.isArray(report.previewData) || !report.previewData.length) {
    return `
      <div class="customReportPreview customReportPreview--native">
        ${icon(reportIcon(report.sourceId || 'custom_report'))}
        <strong>${escapeHtml(report.sourceLabel || 'KCP report')}</strong>
        <small>${escapeHtml(report.columns?.slice(0, 3).join(' · ') || 'Saved workspace configuration')}</small>
      </div>
    `;
  }
  if (report.chartType === 'donut') {
    return `
      <div class="customReportPreview customReportPreview--donut">
        <i></i><span>${escapeHtml(report.previewData?.[0] || '68%')}</span>
      </div>
    `;
  }
  if (report.chartType === 'table') {
    return `
      <div class="customReportPreview customReportPreview--table">
        <table><tbody><tr><td>North</td><td>$120K</td><td>312</td></tr><tr><td>South</td><td>$98K</td><td>256</td></tr><tr><td>West</td><td>$110K</td><td>289</td></tr></tbody></table>
      </div>
    `;
  }
  if (report.chartType === 'line') {
    const points = report.previewData || [44, 61, 55, 72, 58, 80, 68];
    return `
      <div class="customReportPreview customReportPreview--line">
        <svg viewBox="0 0 160 82" aria-hidden="true">
          <polyline points="${points.map((point, index) => `${index * 25 + 5},${76 - Math.max(8, Number(point) || 40) * 0.72}`).join(' ')}" />
          <polyline class="is-secondary" points="${points.map((point, index) => `${index * 25 + 5},${66 - Math.max(8, Number(point) || 30) * 0.52}`).join(' ')}" />
        </svg>
      </div>
    `;
  }
  const points = report.previewData || [36, 66, 48, 74, 52, 88, 69];
  return `
    <div class="customReportPreview customReportPreview--bar">
      ${points.map((point, index) => `<i style="--h:${Math.max(18, Number(point) || 40)}%;--i:${index}"></i>`).join('')}
    </div>
  `;
}

function renderRecentlyViewedReports(reports) {
  return `
    <section class="customReportsTableCard">
      <header><h2>Recently Viewed</h2><button type="button" data-custom-dashboard-view-all="recent">View all</button></header>
      ${reports.length ? `
        <table>
          <tbody>
            ${reports.map((report) => `
              <tr data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="view">
                <td><span class="customReportsTableIcon">${icon(reportIcon(report.sourceId || 'custom_report'))}</span></td>
                <td><strong>${escapeHtml(report.name)}</strong></td>
                <td>${renderReportStatusBadge(report.status)}</td>
                <td>${escapeHtml(formatReportDashboardDate(report.lastViewedAt || report.updatedAt))}</td>
                <td><button type="button" data-custom-report-toggle-pin="${escapeAttribute(report.reportConfigId || report.id)}" aria-label="${report.favourite ? 'Remove favourite' : 'Add favourite'}">${icon('star')}</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : renderCustomDashboardEmptyState('No recently viewed reports', 'Open a report to see it here.', false)}
    </section>
  `;
}

function renderScheduledEmailsTable(reports) {
  return `
    <section class="customReportsTableCard">
      <header><h2>Scheduled Emails</h2><button type="button" data-custom-dashboard-view-all="scheduled">View all</button></header>
      ${reports.length ? `
        <table>
          <thead><tr><th scope="col">Report Name</th><th scope="col">Next Send</th><th scope="col">Recipients</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            ${reports.slice(0, 5).map((report) => `
              <tr>
                <td><strong>${escapeHtml(report.name)}</strong></td>
                <td>${icon('calendar')} ${escapeHtml(report.nextSendAt || report.scheduleLabel)}</td>
                <td>${renderRecipientAvatars(report)}</td>
                <td>${renderReportStatusBadge(report.status === 'Active' ? 'Scheduled' : report.status)}</td>
                <td>
                  <button type="button" data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="view">View</button>
                  <button type="button" data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="edit">Edit</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : renderCustomDashboardEmptyState('No scheduled emails', 'Schedule a report to email it automatically.', false)}
    </section>
  `;
}

function renderRecentlySentReports(reports) {
  return `
    <section class="customReportsTableCard">
      <header><h2>Recently Sent</h2><button type="button" data-custom-dashboard-view-all="sent">View all</button></header>
      ${reports.length ? `
        <table>
          <thead><tr><th scope="col">Report</th><th scope="col">Last Sent</th><th scope="col">Recipients</th><th scope="col">Sends</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            ${reports.map((report) => `
              <tr>
                <td><strong>${escapeHtml(report.name)}</strong><small>${escapeHtml(report.scheduleType || 'On Demand')}</small></td>
                <td>${icon('send')} ${escapeHtml(formatReportDashboardDate(report.lastSentAt || report.updatedAt))}</td>
                <td>${renderRecipientAvatars(report)} <span>${escapeHtml(String(report.recipientCount || 0))}</span></td>
                <td><strong>${escapeHtml(String(report.sentThisMonth || 0))}</strong><small>This month</small></td>
                <td>
                  <button type="button" data-custom-dashboard-open="${escapeAttribute(report.id)}" data-mode="view">View</button>
                  <button type="button" data-custom-report-email-now="${escapeAttribute(report.id)}">Email</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : renderCustomDashboardEmptyState('No recently sent reports', 'Use Email Now to send a report on demand.', false)}
    </section>
  `;
}

function renderReportFiltersPanel(filters, reports) {
  const creators = [...new Set(reports.map((report) => report.createdBy))].sort();
  const schedules = [...new Set(reports.map((report) => report.scheduleType))].sort();
  return `
    <section class="customReportsFiltersPanel" aria-label="Report filters">
      ${renderDashboardFilterSelect('customReportsStatus', 'Status', ['', 'Active', 'Scheduled', 'Draft', 'Sent Today', 'Archived'], filters.customReportsStatus, filters.openDropdown)}
      ${renderDashboardFilterSelect('customReportsCreator', 'Created by', ['', ...creators], filters.customReportsCreator, filters.openDropdown)}
      ${renderDashboardFilterSelect('customReportsSchedule', 'Schedule type', ['', ...schedules], filters.customReportsSchedule, filters.openDropdown)}
      ${renderDashboardFilterSelect('customReportsDate', 'Date updated', ['', 'Last 7 days', 'Last 30 days', 'This month'], filters.customReportsDate, filters.openDropdown)}
      ${renderDashboardFilterSelect('customReportsRecipients', 'Recipients', ['', '0-5', '6-10', '10+'], filters.customReportsRecipients, filters.openDropdown)}
      <button type="button" data-custom-dashboard-clear-filters>${icon('x')} Clear filters</button>
    </section>
  `;
}

function renderDashboardFilterSelect(field, label, options, value = '', openDropdown = '') {
  return renderCustomDashboardDropdown({
    field,
    label,
    value,
    openDropdown,
    options: options.map((option) => ({ value: option, label: option || 'Any' }))
  });
}

function renderCustomDashboardDropdown({ field, label, value = '', options = [], openDropdown = '' }) {
  const id = `custom-dashboard-${field}`;
  const selected = options.find((option) => String(option.value) === String(value)) || options[0] || { value: '', label: 'Any' };
  const isOpen = openDropdown === id;
  return `
    <label class="customReportsCustomDropdown">
      <span>${escapeHtml(label)}</span>
      <div class="analyticsDropdown ${isOpen ? 'is-open' : ''}" data-analytics-dropdown-root>
        <button type="button" data-analytics-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}" aria-label="${escapeAttribute(label)}">
          <strong>${escapeHtml(selected.label || 'Any')}</strong>
          ${icon('chevronDown')}
        </button>
        <div class="analyticsDropdownMenu">
          ${options.map((option) => `
            <button
              type="button"
              data-custom-dashboard-option
              data-custom-dashboard-option-field="${escapeAttribute(field)}"
              data-custom-dashboard-option-value="${escapeAttribute(option.value)}"
              class="${String(option.value) === String(value) ? 'is-active' : ''}"
            >
              ${escapeHtml(option.label || 'Any')}
            </button>
          `).join('')}
        </div>
      </div>
    </label>
  `;
}

function renderEmailReportModal(report, filters = {}) {
  const recipients = report.recipients?.join(', ') || '';
  return `
    <div class="customReportsModalBackdrop" role="presentation">
      <section class="customReportsEmailModal" role="dialog" aria-modal="true" aria-labelledby="custom-report-email-title">
        <header>
          <div>
            <span>${icon('mail')}</span>
            <h2 id="custom-report-email-title">Email report now</h2>
            <p>${escapeHtml(report.name)}</p>
          </div>
          <button type="button" data-custom-report-email-close aria-label="Close email report modal">${icon('x')}</button>
        </header>
        ${filters.customReportsError ? `<div class="customReportsModalNotice">${escapeHtml(filters.customReportsError)}</div>` : ''}
        <label>
          <span>Recipients</span>
          <input type="text" value="${escapeAttribute(recipients)}" data-custom-dashboard-email-recipients placeholder="owner@example.com, manager@example.com" />
        </label>
        <label>
          <span>Subject</span>
          <input type="text" value="${escapeAttribute(`${report.name} - ${formatReportDashboardDate(new Date().toISOString())}`)}" />
        </label>
        <label>
          <span>Message</span>
          <textarea>Please find the latest ${escapeHtml(report.name)} attached.</textarea>
        </label>
        <footer>
          <button type="button" data-custom-report-email-close>Cancel</button>
          <button type="button" class="is-primary" data-custom-report-email-send="${escapeAttribute(report.id)}">${icon('mail')} Send Report</button>
        </footer>
      </section>
    </div>
  `;
}

function renderManageReportModal(report, filters = {}) {
  const action = String(filters.customReportManageAction || 'rename');
  const title = actionLabel(action);
  const draftName = filters.customReportManageName ?? (action === 'duplicate' ? `${report.name} Copy` : report.name);
  const draftDescription = filters.customReportManageDescription ?? report.description ?? '';
  const draftRecipients = filters.customReportManageRecipients ?? (report.recipients || []).join(', ');
  const draftScheduleType = filters.customReportManageScheduleType ?? report.scheduleType ?? 'On Demand';
  const draftScheduleLabel = filters.customReportManageScheduleLabel ?? report.scheduleLabel ?? '';
  const draftNextSendAt = filters.customReportManageNextSendAt ?? report.nextSendAt ?? '';
  return `
    <div class="customReportsModalBackdrop" role="presentation">
      <section class="customReportsEmailModal customReportsManageModal" role="dialog" aria-modal="true" aria-labelledby="custom-report-manage-title">
        <header>
          <div>
            <span>${icon(action === 'schedule' ? 'calendar' : action === 'recipients' ? 'users' : action === 'archive' ? 'file' : 'sliders')}</span>
            <h2 id="custom-report-manage-title">${escapeHtml(title)}</h2>
            <p>${escapeHtml(report.name)}</p>
          </div>
          <button type="button" data-custom-report-manage-close aria-label="Close report action">${icon('x')}</button>
        </header>
        ${filters.customReportsError ? `<div class="customReportsModalNotice">${escapeHtml(filters.customReportsError)}</div>` : ''}
        ${['rename', 'duplicate'].includes(action) ? `
          <label>
            <span>Report Name</span>
            <input type="text" value="${escapeAttribute(draftName)}" data-custom-report-manage-field="customReportManageName" />
          </label>
          <label>
            <span>Description</span>
            <textarea data-custom-report-manage-field="customReportManageDescription">${escapeHtml(draftDescription)}</textarea>
          </label>
        ` : ''}
        ${action === 'schedule' ? `
          ${renderCustomDashboardDropdown({
            field: 'customReportManageScheduleType',
            label: 'Schedule Type',
            value: draftScheduleType,
            options: ['On Demand', 'Daily', 'Weekly', 'Monthly'].map((item) => ({ value: item, label: item })),
            openDropdown: filters.openDropdown
          })}
          <label>
            <span>Schedule Label</span>
            <input type="text" value="${escapeAttribute(draftScheduleLabel)}" data-custom-report-manage-field="customReportManageScheduleLabel" placeholder="Every Monday at 08:00" />
          </label>
          <label>
            <span>Next Send</span>
            <input type="text" value="${escapeAttribute(draftNextSendAt)}" data-custom-report-manage-field="customReportManageNextSendAt" placeholder="2026-06-12 08:00" />
          </label>
          <label>
            <span>Recipients</span>
            <input type="text" value="${escapeAttribute(draftRecipients)}" data-custom-report-manage-field="customReportManageRecipients" placeholder="owner@example.com, manager@example.com" />
          </label>
        ` : ''}
        ${action === 'recipients' ? `
          <label>
            <span>Recipients</span>
            <textarea data-custom-report-manage-field="customReportManageRecipients" placeholder="owner@example.com, manager@example.com">${escapeHtml(draftRecipients)}</textarea>
          </label>
        ` : ''}
        ${action === 'archive' ? `
          <div class="customReportsManageConfirm">
            <strong>Archive this report?</strong>
            <p>The report will remain saved, but it will be marked as archived and removed from active scheduled workflows.</p>
          </div>
        ` : ''}
        ${action === 'share' ? `
          <div class="customReportsManageConfirm">
            <strong>Read-only share link</strong>
            <p>This link opens the saved report in preview mode. Users still need permission to access report data.</p>
          </div>
          <label>
            <span>Share Link</span>
            <input type="text" readonly value="${escapeAttribute(buildSavedReportShareUrl(report))}" data-custom-report-share-link />
          </label>
        ` : ''}
        <footer>
          <button type="button" data-custom-report-manage-close>Cancel</button>
          <button type="button" class="is-primary" data-custom-report-manage-save="${escapeAttribute(report.id)}" data-action="${escapeAttribute(action)}">
            ${icon(action === 'archive' ? 'file' : action === 'share' ? 'link' : 'check')} ${escapeHtml(action === 'duplicate' ? 'Create Copy' : action === 'archive' ? 'Archive Report' : action === 'share' ? 'Enable & Copy Link' : 'Save Changes')}
          </button>
        </footer>
      </section>
    </div>
  `;
}

function renderCustomDashboardEmptyState(title, description, showAction = false) {
  return `
    <div class="customReportsEmpty">
      <span>${icon('file')}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
      ${showAction ? `<button type="button" data-custom-dashboard-create>${icon('plus')} Create Report</button>` : ''}
    </div>
  `;
}

function splitDashboardRecipients(value = '') {
  return String(value || '')
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultReportScheduleLabel(scheduleType = '') {
  const type = String(scheduleType || '').trim();
  if (type === 'Daily') return 'Every day';
  if (type === 'Weekly') return 'Every Monday';
  if (type === 'Monthly') return '1st of every month';
  return 'Manual send only';
}

function defaultReportNextSend(scheduleType = '') {
  const date = new Date();
  const type = String(scheduleType || '').trim();
  if (type === 'On Demand') return '';
  date.setDate(date.getDate() + (type === 'Monthly' ? 30 : type === 'Weekly' ? 7 : 1));
  return date.toISOString();
}

function renderCustomDashboardLoading(label = 'Loading reports...') {
  return `
    <div class="customReportsLoading" role="status" aria-live="polite">
      <span></span>
      <strong>${escapeHtml(label)}</strong>
    </div>
  `;
}

function buildCustomDashboardReports(savedReports = []) {
  const saved = (Array.isArray(savedReports) ? savedReports : []).map((report, index) => normalizeCustomDashboardReport(report, index));
  return saved;
}

function findCustomDashboardReport(reports = [], reportId = '') {
  const id = String(reportId || '').trim();
  if (!id) return null;
  return (Array.isArray(reports) ? reports : []).find((report) => (
    String(report.id || '') === id ||
    String(report.reportConfigId || '') === id ||
    String(report.config?.builder?.reportConfigId || '') === id
  )) || null;
}

function filterSavedReportsForAccess(savedReports = [], access = {}) {
  return (Array.isArray(savedReports) ? savedReports : []).filter((report) => userCanViewSavedReport(report, access));
}

function userCanViewSavedReport(report = {}, access = {}) {
  if (access.currentIsSuperUser === true) return true;
  if (!hasPermission('nav-report', access.currentRole, access.customRoles || [])) return false;
  const role = normalizeRoleName(access.currentRole || '');
  const allowedRoles = normalizeReportAccessList(report.allowedRoles || report.allowed_roles || report.config?.allowedRoles || report.config?.accessPolicy?.roles, true);
  if (allowedRoles.length && !allowedRoles.includes(role)) return false;
  const allowedLocationIds = normalizeReportAccessList(report.allowedLocationIds || report.allowed_location_ids || report.config?.allowedLocationIds || report.config?.accessPolicy?.locationIds);
  if (!allowedLocationIds.length || allowedLocationIds.includes('all')) return true;
  return allowedLocationIds.some((locationId) => hasLocationAccess(locationId, access.currentRole, access.customRoles || []));
}

function normalizeReportAccessList(value, lowercase = false) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,|;\n]/);
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean).map((item) => lowercase ? item.toLowerCase() : item))];
}

function normalizeCustomDashboardReport(report = {}, index = 0) {
  const name = String(report.name || report.title || `Saved Report ${index + 1}`).trim() || `Saved Report ${index + 1}`;
  const creator = report.createdBy || report.ownerName || report.created_by || 'Workspace user';
  const updatedAt = report.updatedAt || report.updated_at || report.createdAt || report.created_at || '2026-06-10T10:00:00Z';
  const status = ['Active', 'Scheduled', 'Draft', 'Sent Today', 'Archived'].includes(report.status) ? report.status : 'Active';
  return {
    id: report.id || report.reportConfigId || `saved-${index + 1}`,
    reportConfigId: report.reportConfigId || report.id || '',
    name,
    description: report.description || report.summary || 'Saved custom report built from live workspace data.',
    status,
    chartType: report.chartType || report.visualizationType || 'native',
    previewData: Array.isArray(report.previewData) ? report.previewData : [],
    createdBy: creator,
    createdByAvatar: report.createdByAvatar || initialsForName(creator),
    createdAt: report.createdAt || report.created_at || updatedAt,
    updatedAt,
    lastViewedAt: report.lastViewedAt || report.last_viewed_at || updatedAt,
    scheduleType: report.scheduleType || report.schedule_type || (status === 'Scheduled' ? 'Scheduled' : 'On Demand'),
    scheduleLabel: report.scheduleLabel || report.schedule_label || (status === 'Scheduled' ? 'Configured schedule' : 'Manual send only'),
    nextSendAt: report.nextSendAt || report.next_send_at || '',
    lastSentAt: report.lastSentAt || report.last_sent_at || report.config?.lastSentAt || '',
    recipients: Array.isArray(report.recipients) ? report.recipients : [],
    recipientCount: Number(report.recipientCount || report.recipient_count || report.recipients?.length || 0),
    emailEnabled: report.emailEnabled ?? status !== 'Draft',
    favourite: Boolean(report.favourite || report.pinned),
    tags: report.tags || ['Custom'],
    sentThisMonth: Number(report.sentThisMonth || report.sent_this_month || 0),
    recentSends: Array.isArray(report.recentSends)
      ? report.recentSends
      : Array.isArray(report.config?.recentSends)
        ? report.config.recentSends
        : [],
    sourceId: report.sourceId || report.config?.customSource || 'custom_report',
    sourceIds: Array.isArray(report.sourceIds) ? report.sourceIds : Array.isArray(report.config?.sourceIds) ? report.config.sourceIds : [],
    visualizationType: report.visualizationType || report.config?.visualizationType || 'table',
    groupBy: report.groupBy || report.config?.groupBy || 'none',
    sourceLabel: report.sourceLabel || report.config?.sourceLabel || '',
    columns: report.columns || report.config?.customColumns || [],
    builder: report.config?.builder || report.builder || null,
    config: report.config && typeof report.config === 'object' ? report.config : {},
    shareEnabled: report.shareEnabled ?? report.config?.shareEnabled ?? report.config?.builder?.options?.shareEnabled ?? false,
    shareToken: report.shareToken || report.config?.shareToken || report.config?.builder?.options?.shareToken || '',
    thresholdRules: Array.isArray(report.thresholdRules)
      ? report.thresholdRules
      : Array.isArray(report.config?.builder?.thresholdRules)
        ? report.config.builder.thresholdRules
        : [],
    ownerUid: report.ownerUid || report.owner_uid || report.createdBy || report.created_by || '',
    ownerEmail: report.ownerEmail || report.owner_email || report.config?.ownerEmail || '',
    ownerName: report.ownerName || report.owner_name || report.config?.ownerName || creator,
    allowedRoles: normalizeReportAccessList(report.allowedRoles || report.allowed_roles || report.config?.allowedRoles || report.config?.accessPolicy?.roles, true),
    allowedLocationIds: normalizeReportAccessList(report.allowedLocationIds || report.allowed_location_ids || report.config?.allowedLocationIds || report.config?.accessPolicy?.locationIds),
    auditLog: Array.isArray(report.auditLog) ? report.auditLog : Array.isArray(report.config?.auditLog) ? report.config.auditLog : [],
    isMock: false
  };
}

function filterCustomDashboardReports(reports, filters = {}) {
  const query = String(filters.customReportsSearch || '').trim().toLowerCase();
  const status = String(filters.customReportsStatus || '');
  const creator = String(filters.customReportsCreator || '');
  const schedule = String(filters.customReportsSchedule || '');
  const recipientRange = String(filters.customReportsRecipients || '');
  const date = String(filters.customReportsDate || '');
  return reports.filter((report) => {
    if (!status && report.status === 'Archived') return false;
    const haystack = [report.name, report.description, report.createdBy, report.status, report.scheduleType, ...(report.tags || [])]
      .join(' ')
      .toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (status && report.status !== status) return false;
    if (creator && report.createdBy !== creator) return false;
    if (schedule && report.scheduleType !== schedule) return false;
    if (recipientRange && !recipientCountInRange(report.recipientCount, recipientRange)) return false;
    if (date && !reportDateInRange(report.updatedAt, date)) return false;
    return true;
  });
}

function sortCustomDashboardReports(reports, sort = 'updated') {
  const sorted = [...reports];
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    created: (a, b) => dashboardTimestamp(b.createdAt) - dashboardTimestamp(a.createdAt),
    status: (a, b) => a.status.localeCompare(b.status),
    viewed: (a, b) => dashboardTimestamp(b.lastViewedAt) - dashboardTimestamp(a.lastViewedAt),
    updated: (a, b) => dashboardTimestamp(b.updatedAt) - dashboardTimestamp(a.updatedAt)
  };
  return sorted.sort(sorters[sort] || sorters.updated);
}

function renderRecipientAvatars(report) {
  const recipients = report.recipients?.length ? report.recipients : Array.from({ length: Math.min(3, Number(report.recipientCount || 0)) }, (_, index) => `recipient${index + 1}@example.com`);
  const visible = recipients.slice(0, 3);
  const remaining = Math.max(0, Number(report.recipientCount || recipients.length) - visible.length);
  return `
    <span class="customReportsRecipients" aria-label="${escapeAttribute(`${report.recipientCount} recipients`)}">
      ${visible.map((recipient) => `<i>${escapeHtml(initialsForName(recipient.split('@')[0]))}</i>`).join('')}
      ${remaining ? `<b>+${escapeHtml(String(remaining))}</b>` : ''}
    </span>
  `;
}

function formatReportDashboardDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function dashboardTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function initialsForName(name = '') {
  const parts = String(name || '').replace(/[^a-z0-9@\s._-]/gi, ' ').split(/[\s._@-]+/).filter(Boolean);
  return (parts[0]?.[0] || 'R').toUpperCase() + (parts[1]?.[0] || parts[0]?.[1] || '').toUpperCase();
}

function recipientCountInRange(count = 0, range = '') {
  const value = Number(count || 0);
  if (range === '0-5') return value <= 5;
  if (range === '6-10') return value >= 6 && value <= 10;
  if (range === '10+') return value > 10;
  return true;
}

function reportDateInRange(value, range = '') {
  const timestamp = dashboardTimestamp(value);
  if (!timestamp) return false;
  const now = new Date('2026-06-11T12:00:00Z').getTime();
  const day = 24 * 60 * 60 * 1000;
  if (range === 'Last 7 days') return now - timestamp <= 7 * day;
  if (range === 'Last 30 days') return now - timestamp <= 30 * day;
  if (range === 'This month') {
    const date = new Date(timestamp);
    return date.getUTCFullYear() === 2026 && date.getUTCMonth() === 5;
  }
  return true;
}

function buildCustomDashboardBuilderState(report, filters = {}) {
  if (report?.builder) return normalizeReportBuilderState(report.builder, filters);
  return normalizeReportBuilderState({
    name: report?.name || 'New Custom Report',
    title: report?.name || 'New Custom Report',
    layout: {
      filters: [],
      columns: report?.columns?.length ? report.columns.map((column) => matchReportBuilderFieldId(column)).filter(Boolean).slice(0, 3) : [],
      values: [],
      rows: []
    },
    step: 0
  }, filters);
}

function matchReportBuilderFieldId(column = '') {
  const normalized = String(column || '').trim().toLowerCase();
  if (!normalized) return '';
  const field = getReportBuilderFields().find((item) => item.aliases?.some((alias) => String(alias || '').trim().toLowerCase() === normalized) || item.label.toLowerCase() === normalized)
    || REPORT_BUILDER_FIELDS.find((item) => item.aliases?.some((alias) => String(alias || '').trim().toLowerCase() === normalized) || item.label.toLowerCase() === normalized);
  return field?.id || '';
}

function actionLabel(action = '') {
  const labels = {
    duplicate: 'Duplicate',
    rename: 'Rename',
    schedule: 'Schedule Email',
    recipients: 'Manage Recipients',
    share: 'Share Link',
    download: 'Download',
    archive: 'Archive',
    delete: 'Delete'
  };
  return labels[action] || 'Manage report';
}

function downloadCustomReportConfig(report = {}) {
  if (!report || typeof document === 'undefined') return;
  const filename = `${String(report.name || 'custom-report')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'custom-report'}-config.json`;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function renderCustomReportPromptModal(filters = {}) {
  const prompt = String(filters.customReportPrompt || '').trim();
  const aiStatus = String(filters.customReportAiStatus || '').trim();
  const aiMessage = String(filters.customReportAiMessage || '').trim();
  const examples = [
    'EOD report with tax and tips per staff member',
    'Daily revenue for the last 14 days',
    'Top 10 menu items by gross profit this month',
    'Low stock items grouped by location'
  ];
  return `
    <div class="analyticsCustomSetupBackdrop">
      <aside class="analyticsCustomPromptModal" role="dialog" aria-modal="true" aria-label="Create custom report">
        <header>
          <div>
            <h2>New report block</h2>
            <p>Describe the report you want. Gemini will plan the report from approved data sources and columns.</p>
          </div>
          <button type="button" class="analyticsCustomSetupClose" data-custom-report-create-close aria-label="Close prompt">${icon('x')}</button>
        </header>
        <section>
          <label class="analyticsCustomTextField">
            <span>Prompt</span>
            <textarea
              data-analytics-field="customReportPrompt"
              data-analytics-defer="true"
              data-focus-key="custom-report-prompt"
              placeholder="EOD report with tax and tips per staff member"
            >${escapeHtml(prompt)}</textarea>
          </label>
          <div class="analyticsCustomPromptExamples">
            <span>Try one of these:</span>
            ${examples.map((example) => `
              <button type="button" data-custom-report-prompt-example="${escapeAttribute(example)}">${escapeHtml(example)}</button>
            `).join('')}
          </div>
          ${aiMessage ? `<div class="analyticsCustomAiNotice analyticsCustomAiNotice--${escapeAttribute(aiStatus || 'planned')}">${escapeHtml(aiMessage)}</div>` : ''}
        </section>
        <footer>
          <button type="button" class="analyticsCustomSetupGhost" data-custom-report-create-close>Cancel</button>
          <button type="button" class="analyticsCustomSetupGhost" data-custom-report-manual-build>${icon('sliders')} Manually build</button>
          <button type="button" class="analyticsCustomSetupRun" ${aiStatus === 'planning' ? 'disabled' : ''} data-custom-report-ai-build>
            ${icon(aiStatus === 'planning' ? 'refresh' : 'sparkles')}
            ${aiStatus === 'planning' ? 'Gemini is thinking...' : 'Build with AI'}
          </button>
        </footer>
      </aside>
    </div>
  `;
}

function renderCustomAiDashboard({
  filters,
  reportData,
  category,
  categoryOptions,
  locationOptions,
  sourceConfig,
  selectedColumns,
  totalRows,
  updatedLabel
}) {
  const blocks = normalizeCustomAiBlocks(filters.customReportBlocks, reportData, {
    visualizationType: filters.visualizationType,
    groupBy: filters.groupBy,
    selectedColumns
  });
  const planner = filters.customReportAiSource === 'gemini' ? 'Gemini planned' : 'Local planner';
  const prompt = String(filters.customReportPrompt || '').trim();
  const reportName = String(filters.customReportName || 'Custom Report').trim() || 'Custom Report';
  return `
    <div class="analyticsDetailCanvas analyticsCustomReportCanvas analyticsCustomAiDashboard analyticsTone-${category.tone}">
      <header class="analyticsCustomReportTopbar analyticsCustomAiTopbar">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsReportTitle analyticsCustomTitle">
            <h1>${escapeHtml(reportName)} ${renderReportInfo('AI-built dashboard from approved Kitchen Cost Pro data connectors.')}</h1>
            <p>${escapeHtml(prompt || 'Dynamic dashboard built from live workspace data.')}</p>
          </div>
        </div>
        <div class="analyticsCustomTopActions">
          <button type="button" class="analyticsCustomQuietAction" data-custom-report-save>${icon('file')} Save View</button>
          <button type="button" class="analyticsCustomQuietAction" data-custom-report-save-pinned>${icon('star')} Pin Widget</button>
          <button type="button" class="analyticsCustomQuietAction" data-custom-report-new>${icon('sparkles')} New AI Report</button>
          <button type="button" class="analyticsCustomSetupButton" data-custom-report-setup-open>${icon('sliders')} Manual Setup</button>
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsFilterDock analyticsCustomFilterDock analyticsCustomAiFilterDock">
        ${renderDateRangePicker(filters)}
        ${renderDropdown({
          id: 'category',
          label: 'Category',
          selectedValue: filters.category || '',
          options: categoryOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'locationId',
          label: 'Location',
          selectedValue: filters.locationId || '',
          options: locationOptions,
          openDropdown: filters.openDropdown
        })}
        <label class="analyticsHeroSearch">
          <span>Search</span>
          <div>
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query)}" placeholder="Search dashboard data..." data-analytics-field="query" data-focus-key="analytics-query" />
          </div>
        </label>
        <button type="button" class="analyticsRefreshButton" data-analytics-refresh>
          ${icon('refresh')}
          <span>Refresh</span>
        </button>
      </section>

      <section class="analyticsCustomAiHero">
        <div>
          <span>${icon('activity')} Live AI dashboard</span>
          <strong>${escapeHtml(sourceConfig.label || reportData.custom?.sourceLabel || 'Live Data')}</strong>
          <p>${escapeHtml(planner)} · ${escapeHtml(formatNumber(totalRows))} rows · ${escapeHtml(formatNumber(blocks.length))} blocks · Updated ${escapeHtml(updatedLabel)}</p>
        </div>
        <div>
          <span>${escapeHtml(selectedColumns.length)} selected fields</span>
          <strong>${escapeHtml(visualizationLabel(filters.visualizationType || 'table'))}</strong>
        </div>
      </section>

      <section class="analyticsCustomAiBlockGrid">
        ${blocks.map((block, index) => renderCustomAiBlock(block, reportData, index)).join('')}
      </section>

      ${filters.customSetupOpen ? renderCustomReportSetupDrawer(reportData) : ''}
      ${filters.customReportCreateOpen ? renderCustomReportPromptModal(filters) : ''}
    </div>
  `;
}

function normalizeCustomAiBlocks(blocks = [], reportData = {}, fallback = {}) {
  const rows = reportData.rows || [];
  const columns = reportData.columns || [];
  const selectedColumns = fallback.selectedColumns?.length ? fallback.selectedColumns : columns;
  const safeBlocks = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && typeof block === 'object')
    .map((block, index) => ({
      id: String(block.id || `block-${index + 1}`).trim() || `block-${index + 1}`,
      type: ['metric', 'bar', 'line', 'pie', 'table', 'list'].includes(String(block.type || '').toLowerCase())
        ? String(block.type || '').toLowerCase()
        : 'table',
      title: String(block.title || `Block ${index + 1}`).trim() || `Block ${index + 1}`,
      description: String(block.description || '').trim(),
      columns: Array.isArray(block.columns)
        ? block.columns.map((column) => String(column || '').trim()).filter((column) => columns.includes(column))
        : [],
      valueColumn: columns.includes(block.valueColumn) ? block.valueColumn : columns.includes(block.value_column) ? block.value_column : '',
      labelColumn: columns.includes(block.labelColumn) ? block.labelColumn : columns.includes(block.label_column) ? block.label_column : '',
      groupBy: String(block.groupBy || block.group_by || fallback.groupBy || 'none').trim() || 'none',
      limit: Math.min(50, Math.max(1, Number(block.limit) || 10))
    }));
  if (safeBlocks.length) return safeBlocks;
  const valueColumn = findCurrencyColumn(columns) || findNumericColumn(columns) || '';
  const labelColumn = resolveCustomGroupColumn(columns, fallback.groupBy || 'none', reportData);
  return [
    {
      id: 'total-records',
      type: 'metric',
      title: 'Total Records',
      description: 'Rows in this custom report.',
      columns: [],
      valueColumn: '',
      labelColumn: '',
      groupBy: 'none',
      limit: 1
    },
    {
      id: 'primary-chart',
      type: fallback.visualizationType === 'line' || fallback.visualizationType === 'pie' ? fallback.visualizationType : 'bar',
      title: labelColumn ? `By ${labelColumn}` : 'Live Breakdown',
      description: valueColumn ? `Grouped by ${labelColumn || 'row'} using ${valueColumn}.` : 'Grouped row count.',
      columns: [labelColumn, valueColumn].filter(Boolean),
      valueColumn,
      labelColumn,
      groupBy: fallback.groupBy || 'none',
      limit: 12
    },
    {
      id: 'detail-table',
      type: 'table',
      title: 'Detail Rows',
      description: 'Underlying records for drill-down.',
      columns: selectedColumns.slice(0, 8),
      valueColumn: '',
      labelColumn: '',
      groupBy: 'none',
      limit: 25
    }
  ].filter(() => rows);
}

function renderCustomAiBlock(block, reportData, index = 0) {
  const type = block.type || 'table';
  if (type === 'metric') return renderCustomAiMetricBlock(block, reportData, index);
  if (type === 'table') return renderCustomAiTableBlock(block, reportData);
  if (type === 'list') return renderCustomAiListBlock(block, reportData);
  return renderCustomAiChartBlock(block, reportData, index);
}

function renderCustomAiMetricBlock(block, reportData, index = 0) {
  const rows = reportData.rows || [];
  const valueColumn = block.valueColumn && reportData.columns?.includes(block.valueColumn) ? block.valueColumn : '';
  const value = valueColumn ? sumRows(rows, valueColumn) : rows.length;
  const display = valueColumn ? formatCustomBlockNumber(value, valueColumn) : formatNumber(value);
  return `
    <article class="analyticsCustomAiBlock analyticsCustomAiBlock--metric">
      <span>${icon(fallbackMetricIcon(index))}</span>
      <div>
        <small>${escapeHtml(block.title)}</small>
        <strong>${escapeHtml(display)}</strong>
        <p>${escapeHtml(block.description || (valueColumn ? `Sum of ${valueColumn}` : 'Total report records'))}</p>
      </div>
    </article>
  `;
}

function renderCustomAiChartBlock(block, reportData, index = 0) {
  const series = buildCustomAiSeries(block, reportData);
  return `
    <article class="analyticsCustomAiBlock analyticsCustomAiBlock--chart ${block.type === 'line' ? 'analyticsCustomAiBlock--wide' : ''}">
      <header>
        <div>
          <h2>${escapeHtml(block.title)}</h2>
          <p>${escapeHtml(block.description || chartBlockDescription(block, reportData))}</p>
        </div>
      </header>
      <div class="analyticsCustomAiChartFrame">
        <canvas
          data-custom-chart
          data-chart-id="${escapeAttribute(`custom-ai-chart-${index}-${block.id}`)}"
          data-chart-type="${escapeAttribute(block.type === 'pie' ? 'pie' : block.type)}"
          data-chart-series="${escapeAttribute(JSON.stringify(series))}"
        ></canvas>
      </div>
    </article>
  `;
}

function renderCustomAiListBlock(block, reportData) {
  const series = buildCustomAiSeries(block, reportData).slice(0, block.limit || 8);
  const max = Math.max(1, ...series.map((item) => Math.abs(Number(item.value || 0))));
  return `
    <article class="analyticsCustomAiBlock analyticsCustomAiBlock--list">
      <header>
        <div>
          <h2>${escapeHtml(block.title)}</h2>
          <p>${escapeHtml(block.description || 'Top grouped rows from this report.')}</p>
        </div>
      </header>
      <div class="analyticsCustomAiList">
        ${series.map((item) => `
          <div style="--bar-width: ${Math.min(100, Math.abs(Number(item.value || 0)) / max * 100).toFixed(2)}%;">
            <span>${escapeHtml(item.label)}</span>
            <i></i>
            <strong>${escapeHtml(formatCustomBlockNumber(item.value, block.valueColumn))}</strong>
          </div>
        `).join('') || '<p>No grouped data yet.</p>'}
      </div>
    </article>
  `;
}

function renderCustomAiTableBlock(block, reportData) {
  const columns = (block.columns?.length ? block.columns : reportData.columns || []).slice(0, 10);
  const rows = (reportData.rows || []).slice(0, block.limit || 25);
  return `
    <article class="analyticsCustomAiBlock analyticsCustomAiBlock--table analyticsCustomAiBlock--wide">
      <header>
        <div>
          <h2>${escapeHtml(block.title)}</h2>
          <p>${escapeHtml(block.description || 'Live records behind this dashboard.')}</p>
        </div>
        <span>${escapeHtml(formatNumber(rows.length))} rows</span>
      </header>
      <div class="analyticsCustomAiTableWrap">
        <table>
          <thead>
            <tr>${columns.map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>${columns.map((column) => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>
            `).join('') || `<tr><td colspan="${Math.max(columns.length, 1)}">No rows match this report.</td></tr>`}
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function buildCustomAiSeries(block, reportData) {
  const rows = reportData.rows || [];
  const columns = reportData.columns || [];
  const valueColumn = block.valueColumn && columns.includes(block.valueColumn)
    ? block.valueColumn
    : findCurrencyColumn(columns) || findNumericColumn(columns) || '';
  const labelColumn = block.labelColumn && columns.includes(block.labelColumn)
    ? block.labelColumn
    : resolveCustomGroupColumn(columns, block.groupBy || 'none', reportData);
  const map = new Map();
  rows.forEach((row) => {
    const label = getCustomGroupLabel(row, labelColumn, block.groupBy || 'none');
    const value = valueColumn ? parseNumber(row[valueColumn]) : 1;
    map.set(label, (map.get(label) || 0) + (Number.isFinite(value) ? value : 0));
  });
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => block.type === 'line' ? sortCustomSeries(left.label, right.label, block.groupBy || 'none') : Math.abs(right.value) - Math.abs(left.value))
    .slice(0, block.limit || 12);
}

function chartBlockDescription(block, reportData) {
  const value = block.valueColumn || findCurrencyColumn(reportData.columns || []) || findNumericColumn(reportData.columns || []) || 'Rows';
  const label = block.labelColumn || resolveCustomGroupColumn(reportData.columns || [], block.groupBy || 'none', reportData) || 'group';
  return `${value} by ${label}`;
}

function formatCustomBlockNumber(value, column = '') {
  if (isCurrencyReportColumn(column)) return formatMoney(value);
  return formatNumber(value);
}

function isCurrencyReportColumn(column = '') {
  return /value|impact|sales|refund|net|total|cost|stock|purchase|wastage|loss|spend|tax|tip/i.test(column);
}

function renderCustomPreviewMetric(label, value, helper, iconName) {
  return `
    <div>
      <span>${icon(iconName)}</span>
      <small>${escapeHtml(label)} ${renderReportInfo(helper || metricHelperText(label))}</small>
      <strong>${escapeHtml(String(value || ''))}</strong>
      <em>${escapeHtml(helper)}</em>
    </div>
  `;
}

function renderPinnedCustomDashboard(pinnedReports = [], source = {}, filters = {}) {
  return `
    <section class="analyticsPinnedDashboard">
      <header>
        <div>
          <h2>Pinned Reporting Dashboard</h2>
          <p>Saved report widgets for repeat owner, manager, and accountant views.</p>
        </div>
      </header>
      <div>
        ${pinnedReports.map((report, index) => {
          const reportFilters = {
            ...filters,
            ...(report.filters || {}),
            reportId: 'custom_report',
            customSource: report.sourceId || report.config?.customSource || 'stock',
            customColumns: report.columns || report.config?.customColumns || [],
            visualizationType: report.visualizationType || report.config?.visualizationType || 'table',
            groupBy: report.groupBy || report.config?.groupBy || 'none'
          };
          const widgetData = buildAnalyticsReport(source, 'custom_report', reportFilters);
          return `
            <article class="analyticsPinnedWidget">
              <header>
                <div>
                  <strong>${escapeHtml(report.name)}</strong>
                  <span>${escapeHtml(`${visualizationLabel(reportFilters.visualizationType)} · ${groupingLabel(reportFilters.groupBy)}`)}</span>
                </div>
                <div>
                  <button type="button" data-custom-report-open-saved="${escapeAttribute(report.id)}" aria-label="Open saved report">${icon('eye')}</button>
                  <button type="button" data-custom-report-toggle-pin="${escapeAttribute(report.id)}" aria-label="Unpin report">${icon('star')}</button>
                </div>
              </header>
              ${renderCustomVisualizationPanel(widgetData, {
                visualizationType: reportFilters.visualizationType,
                groupBy: reportFilters.groupBy,
                chartId: `custom-widget-chart-${index}`,
                compact: true
              })}
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderCustomVisualizationPanel(reportData, { visualizationType = 'table', groupBy = 'none', chartId = 'custom-chart', compact = false } = {}) {
  const series = buildCustomChartSeries(reportData, { groupBy });
  const valueLabel = findCurrencyColumn(reportData.columns || []) || findNumericColumn(reportData.columns || []) || 'Rows';
  return `
    <section class="analyticsCustomVizPanel ${compact ? 'analyticsCustomVizPanel--compact' : ''}">
      <header>
        <div>
          <h2>${escapeHtml(visualizationLabel(visualizationType))}</h2>
          <span>${escapeHtml(groupingLabel(groupBy))} · ${escapeHtml(valueLabel)}</span>
        </div>
      </header>
      ${visualizationType === 'table'
        ? renderCustomMiniTable(reportData, compact ? 4 : 6)
        : `<div class="analyticsCustomChartFrame">
            <canvas
              data-custom-chart
              data-chart-id="${escapeAttribute(chartId)}"
              data-chart-type="${escapeAttribute(visualizationType)}"
              data-chart-series="${escapeAttribute(JSON.stringify(series))}"
            ></canvas>
          </div>`}
    </section>
  `;
}

function renderCustomMiniTable(reportData, limit = 6) {
  const columns = (reportData.columns || []).slice(0, 4);
  const rows = (reportData.rows || []).slice(0, limit);
  return `
    <div class="analyticsCustomMiniTable">
      <table>
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${Math.max(columns.length, 1)}">No rows yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderCustomBreakdownCard(reportData) {
  const rows = reportData.rows || [];
  const groupColumn = breakdownColumnForReport(reportData);
  const groups = groupColumn ? buildBreakdownGroups(rows, groupColumn).slice(0, 5) : [];
  const total = groups.reduce((sum, group) => sum + group.count, 0) || rows.length;
  const colors = ['#3b82f6', '#34d399', '#a78bfa', '#fb923c', '#facc15'];
  let cursor = 0;
  const segments = groups.map((group, index) => {
    const start = cursor;
    const size = total ? (group.count / total) * 360 : 360;
    cursor += size;
    return `${colors[index % colors.length]} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`;
  }).join(', ') || `${colors[0]} 0deg 360deg`;

  return `
    <section class="analyticsCustomChartCard">
      <header>
        <div>
          <h2>${escapeHtml(groupColumn ? `Rows by ${groupColumn}` : 'Row Breakdown')}</h2>
          <span>Live grouping preview</span>
        </div>
      </header>
      <div class="analyticsCustomDonutRow">
        <div class="analyticsDonut" style="--analytics-donut: ${escapeAttribute(segments)};">
          <strong>${escapeHtml(formatNumber(total))}</strong>
          <span>Total</span>
        </div>
        <div class="analyticsBreakdownList">
          ${groups.map((group, index) => `
            <div style="--breakdown-color: ${colors[index % colors.length]};">
              <span>${escapeHtml(group.label)}</span>
              <strong>${escapeHtml(formatNumber(group.count))}</strong>
            </div>
          `).join('') || '<p>No breakdown available.</p>'}
        </div>
      </div>
    </section>
  `;
}

function renderCustomValueCard(reportData, valueColumn = '') {
  const rows = reportData.rows || [];
  const groupColumn = breakdownColumnForReport(reportData);
  const colors = ['#3b82f6', '#34d399', '#a78bfa', '#fb923c', '#94a3b8'];
  const groups = valueColumn && groupColumn
    ? [...rows.reduce((map, row) => {
        const label = String(row[groupColumn] ?? 'Unspecified').trim() || 'Unspecified';
        map.set(label, (map.get(label) || 0) + Math.abs(parseMoney(row[valueColumn])));
        return map;
      }, new Map()).entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((left, right) => right.value - left.value)
        .slice(0, 5)
    : [];
  const max = Math.max(1, ...groups.map((group) => group.value));
  return `
    <section class="analyticsCustomChartCard">
      <header>
        <div>
          <h2>${escapeHtml(valueColumn ? `${valueColumn} by ${groupColumn || 'Group'}` : 'Value Preview')}</h2>
          <span>${valueColumn ? 'Top grouped values' : 'Select a value column to preview totals'}</span>
        </div>
      </header>
      <div class="analyticsCustomBarList">
        ${groups.map((group, index) => `
          <div style="--bar-width: ${(group.value / max * 100).toFixed(2)}%; --bar-color: ${colors[index % colors.length]};">
            <span>${escapeHtml(group.label)}</span>
            <i></i>
            <strong>${escapeHtml(formatMoney(group.value))}</strong>
          </div>
        `).join('') || '<p>No value breakdown available.</p>'}
      </div>
    </section>
  `;
}

function bindAnalyticsTooltips(view) {
  let tooltip = document.querySelector('.analyticsFloatingTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'analyticsFloatingTooltip';
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
  }

  const hideTooltip = () => {
    tooltip.hidden = true;
    tooltip.classList.remove('is-visible', 'is-below');
  };

  const showTooltip = (target) => {
    const message = target?.dataset?.tooltip || '';
    if (!message) return;
    target.removeAttribute('title');
    tooltip.textContent = message;
    tooltip.hidden = false;
    tooltip.classList.add('is-visible');
    tooltip.classList.remove('is-below');
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 10;
    const viewportPadding = 12;
    const preferredTop = targetRect.top - tooltipRect.height - gap;
    const isBelow = preferredTop <= viewportPadding;
    const top = !isBelow
      ? preferredTop
      : Math.min(window.innerHeight - tooltipRect.height - viewportPadding, targetRect.bottom + gap);
    const left = Math.min(
      window.innerWidth - tooltipRect.width - viewportPadding,
      Math.max(viewportPadding, targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2))
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(viewportPadding, top)}px`;
    tooltip.style.setProperty('--tooltip-arrow-left', `${Math.max(14, Math.min(tooltipRect.width - 14, targetRect.left + (targetRect.width / 2) - left))}px`);
    if (isBelow) tooltip.classList.add('is-below');
  };

  view.querySelectorAll('[data-tooltip]').forEach((target) => {
    target.removeAttribute('title');
    target.addEventListener('mouseenter', () => showTooltip(target));
    target.addEventListener('focus', () => showTooltip(target));
    target.addEventListener('mouseleave', hideTooltip);
    target.addEventListener('blur', hideTooltip);
  });
}

function collectDeferredAnalyticsFields(view) {
  const patch = {};
  view.querySelectorAll('[data-analytics-field][data-analytics-defer="true"]').forEach((field) => {
    patch[field.dataset.analyticsField] = field.value;
  });
  return patch;
}

// Anchor an open report popover (date-range panel / filter dropdown) to its
// trigger using position:fixed. Fixed positioning is relative to the viewport,
// so it escapes every ancestor's overflow/clip/stacking context — the report
// card + scroll canvas can no longer cut the popover off.
function positionFixedPopover(trigger, panel, { matchWidth = false } = {}) {
  if (!trigger || !panel) return;
  const rect = trigger.getBoundingClientRect();
  panel.style.position = 'fixed';
  panel.style.margin = '0';
  panel.style.zIndex = '1000';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  // matchWidth: the menu is AT LEAST as wide as its trigger, but may grow to fit long
  // category/location names on one line (capped to the viewport), instead of being
  // pinned to the trigger width and wrapping.
  if (matchWidth) {
    panel.style.width = 'auto';
    panel.style.minWidth = `${rect.width}px`;
    panel.style.maxWidth = `${Math.min(460, window.innerWidth - 16)}px`;
  }
  // Measure after width is applied.
  const ph = panel.offsetHeight;
  const pw = panel.offsetWidth;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Open downward by default; flip up if it would overflow the viewport bottom
  // and there is more room above.
  let top = rect.bottom + gap;
  if (top + ph > vh - gap && rect.top - gap - ph > gap) {
    top = rect.top - gap - ph;
  }
  top = Math.max(gap, Math.min(top, vh - gap - ph));
  // Align to the trigger's left edge, clamped within the viewport.
  let left = rect.left;
  if (left + pw > vw - gap) left = vw - gap - pw;
  left = Math.max(gap, left);
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}

let detachAnalyticsPopoverReposition = null;

function positionAnalyticsPopovers(view) {
  // Tear down any prior scroll/resize listeners so they never leak across the
  // full re-render cycle (the view node is replaced on every filter change).
  if (detachAnalyticsPopoverReposition) {
    detachAnalyticsPopoverReposition();
    detachAnalyticsPopoverReposition = null;
  }
  if (!view || !view.isConnected) return;

  const reposition = () => {
    if (!view.isConnected) return;
    const dateTrigger = view.querySelector('[data-analytics-date-range]');
    const datePanel = view.querySelector('.analyticsDateRangePanel');
    if (dateTrigger && datePanel) positionFixedPopover(dateTrigger, datePanel);
    view.querySelectorAll('.analyticsDropdown.is-open').forEach((root) => {
      const trigger = root.querySelector('[data-analytics-dropdown]');
      const menu = root.querySelector('.analyticsDropdownMenu');
      if (trigger && menu) positionFixedPopover(trigger, menu, { matchWidth: true });
    });
  };

  reposition();

  // Keep the popover anchored while the report scrolls (capture catches the
  // inner scroll container) or the window resizes.
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  detachAnalyticsPopoverReposition = () => {
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  };
}

function bindAnalyticsEvents(view, { filters, reportData, workspaceId = '', pdfBranding = {}, savedReports = [], access = {}, onAnalyticsFilterChange, onAnalyticsAction = {}, onCreateLowStockGrvDraft }) {
  bindAnalyticsTooltips(view);

  // After the view mounts, anchor any open filter/date popover with position:fixed
  // so it can't be clipped by the report card / scroll canvas. Detach listeners
  // when nothing is open.
  if (filters.openDropdown) {
    requestAnimationFrame(() => positionAnalyticsPopovers(view));
  } else if (detachAnalyticsPopoverReposition) {
    detachAnalyticsPopoverReposition();
    detachAnalyticsPopoverReposition = null;
  }

  const handleBuilderActionClick = (event) => {
    const exceptionReportButton = event.target.closest?.('[data-custom-exception-report]');
    if (exceptionReportButton && view.contains(exceptionReportButton)) {
      event.preventDefault();
      event.stopPropagation();
      const reportId = exceptionReportButton.dataset.customExceptionReport || '';
      if (!reportId) return;
      onAnalyticsFilterChange?.({
        reportId,
        view: 'detail',
        page: 1,
        query: '',
        category: '',
        lowStockSelectedIds: [],
        customReportPreviewOpen: false,
        customSetupOpen: false,
        customReportReadOnly: false,
        openDropdown: ''
      });
      return;
    }

    const exceptionTemplateButton = event.target.closest?.('[data-custom-exception-template]');
    if (exceptionTemplateButton && view.contains(exceptionTemplateButton)) {
      event.preventDefault();
      event.stopPropagation();
      const template = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === exceptionTemplateButton.dataset.customExceptionTemplate);
      if (template) onAnalyticsAction.onApplyTemplate?.(template);
    }
  };

  view.addEventListener('click', handleBuilderActionClick, true);

  view.querySelectorAll('[data-analytics-report]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      reportId: button.dataset.analyticsReport,
      view: 'detail',
      page: 1,
      lowStockSelectedIds: [],
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-analytics-category]').forEach((button) => {
    button.addEventListener('click', () => {
      const firstReport = categoryById(button.dataset.analyticsCategory)?.reports?.[0] || 'stock';
      const firstVisibleReport = button.dataset.analyticsFirstReport || firstReport;
      onAnalyticsFilterChange?.({ reportId: firstVisibleReport, view: 'detail', page: 1, lowStockSelectedIds: [], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-ops-category]').forEach((rowEl) => {
    rowEl.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ opsCategoryDetailKey: rowEl.dataset.analyticsOpsCategory || '', openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-ops-category-close]').forEach((element) => {
    element.addEventListener('click', (event) => {
      // The close button always closes; the backdrop only closes on a direct (outside) click.
      if (element.tagName === 'BUTTON' || event.target === element) {
        onAnalyticsFilterChange?.({ opsCategoryDetailKey: '' });
      }
    });
  });

  view.querySelector('[data-analytics-back]')?.addEventListener('click', () => {
    if (filters.reportId === 'custom_report' && (filters.customReportPreviewOpen || filters.customSetupOpen)) {
      onAnalyticsFilterChange?.({
        reportId: 'custom_report',
        view: 'detail',
        customReportPreviewOpen: false,
        customSetupOpen: false,
        customReportReadOnly: false,
        openDropdown: ''
      });
      return;
    }
    onAnalyticsFilterChange?.({ view: 'hub', openDropdown: '' });
  });
  view.querySelectorAll('[data-analytics-hub-category]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ hubCategory: button.dataset.analyticsHubCategory || 'all', openDropdown: '' });
    });
  });
  view.querySelector('[data-analytics-refresh]')?.addEventListener('click', () => {
    onAnalyticsFilterChange?.({ page: 1, openDropdown: '', refreshData: true });
  });
  view.querySelectorAll('[data-yoco-order-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ yocoOrderDetailId: button.dataset.yocoOrderView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-sale-movement-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ saleMovementDetailId: button.dataset.saleMovementView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-menu-health-recipe]').forEach((button) => {
    button.addEventListener('click', () => {
      const productId = button.dataset.menuHealthRecipe || '';
      const productName = button.dataset.menuHealthRecipeName || '';
      if (productId || productName) onAnalyticsAction.onOpenRecipe?.({ id: productId, name: productName });
    });
  });
  view.querySelectorAll('[data-analytics-menu-gp-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextFilter = button.dataset.analyticsMenuGpFilter || '';
      const currentFilter = filters.menuGpFilter || '';
      onAnalyticsFilterChange?.({
        menuGpFilter: currentFilter === nextFilter ? '' : nextFilter,
        page: 1,
        openDropdown: ''
      });
    });
  });
  view.querySelectorAll('[data-analytics-low-stock-drill]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({
        reportId: 'low_stock',
        view: 'detail',
        category: button.dataset.analyticsLowStockCategory || '',
        locationId: button.dataset.analyticsLowStockLocationId || '',
        lowStockViewMode: 'item',
        lowStockShowOnlyLow: true,
        lowStockSelectedIds: [],
        lowStockExpandedIds: [],
        lowStockReorderKey: '',
        lowStockReorderSelectedIds: [],
        query: '',
        page: 1,
        openDropdown: ''
      });
    });
  });
  view.querySelectorAll('[data-analytics-forecast-reorder]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      onAnalyticsFilterChange?.({
        reportId: 'low_stock',
        view: 'detail',
        query: button.dataset.forecastItem || '',
        locationId: button.dataset.forecastLocationId || '',
        lowStockViewMode: 'item',
        lowStockShowOnlyLow: true,
        lowStockSelectedIds: [],
        lowStockExpandedIds: [],
        lowStockReorderKey: '',
        lowStockReorderSelectedIds: [],
        page: 1,
        openDropdown: ''
      });
    });
  });
  view.querySelectorAll('[data-analytics-forecast-expand]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.analyticsForecastExpand || '';
      const expanded = new Set(arrayValue(filters.forecastExpandedIds));
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      onAnalyticsFilterChange?.({ forecastExpandedIds: [...expanded], openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-analytics-forecast-focus="table"]').forEach((button) => {
    button.addEventListener('click', () => {
      view.querySelector('.analyticsForecastTablePanel')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    });
  });
  view.querySelectorAll('[data-analytics-volatility-focus="table"]').forEach((button) => {
    button.addEventListener('click', () => {
      view.querySelector('.analyticsVolatilityTablePanel')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    });
  });
  view.querySelectorAll('[data-analytics-variance-focus="table"]').forEach((button) => {
    button.addEventListener('click', () => {
      view.querySelector('.analyticsVarianceTablePanel')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    });
  });
  view.querySelectorAll('[data-analytics-menu-health-focus]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.analyticsMenuHealthFocus === 'legend'
        ? '.analyticsMenuHealthLegend'
        : '.analyticsMenuHealthTablePanel';
      view.querySelector(target)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    });
  });
  view.querySelectorAll('[data-analytics-waste-focus="table"]').forEach((button) => {
    button.addEventListener('click', () => {
      view.querySelector('.analyticsWasteTablePanel')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    });
  });
  view.querySelectorAll('[data-waste-detail-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ wasteDetailKey: button.dataset.wasteDetailView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-waste-detail-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ wasteDetailKey: '' }));
  });
  view.querySelectorAll('.analyticsWasteDetailModal').forEach((modal) => {
    modal.addEventListener('click', (event) => event.stopPropagation());
  });
  view.querySelectorAll('[data-volatility-detail-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ volatilityDetailKey: button.dataset.volatilityDetailView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-volatility-detail-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ volatilityDetailKey: '' }));
  });
  view.querySelectorAll('[data-variance-detail-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ varianceDetailKey: button.dataset.varianceDetailView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-variance-detail-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ varianceDetailKey: '' }));
  });
  view.querySelector('[data-analytics-volatility-reset]')?.addEventListener('click', () => {
    onAnalyticsFilterChange?.({
      category: '',
      locationId: '',
      supplier: '',
      item: '',
      page: 1,
      openDropdown: ''
    });
  });
  view.querySelectorAll('[data-yoco-order-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ yocoOrderDetailId: '' }));
  });
  view.querySelectorAll('[data-sale-movement-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ saleMovementDetailId: '' }));
  });
  view.querySelector('.analyticsOrderModal')?.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  view.querySelectorAll('[data-grv-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ grvDetailId: button.dataset.grvView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-grv-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ grvDetailId: '' }));
  });
  view.querySelector('.analyticsGrvModal')?.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  view.querySelectorAll('[data-grv-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      const summary = getGrvSummary(reportData.rows, filters.grvDetailId);
      if (!summary) return;
      const format = button.dataset.grvExport || 'pdf';
      await exportObjectRows({
        format,
        filename: `GRV_${summary.invoice || summary.id}.${format}`,
        sheetName: 'GRV Log',
        title: `GRV ${summary.invoice || summary.id}`,
        subtitle: `${summary.supplier} · ${summary.date} · ${summary.location}`,
        summaryRows: [
          { label: 'Supplier', value: summary.supplier },
          { label: 'Invoice / GRV', value: summary.invoice },
          { label: 'Purchase Order', value: summary.poNumber || summary.sourcePoId || '' },
          { label: 'Date', value: summary.date },
          { label: 'Location', value: summary.location },
          { label: 'User', value: summary.user || 'Unknown' },
          { label: 'Total Ex', value: formatMoney(summary.totalEx) }
        ],
        rows: summary.lines,
        columns: ['Item', 'Location', 'Ordered Qty', 'Received Qty', 'Pack Size', 'Unit Cost', 'Total Ex'],
        branding: pdfBranding
      });
    });
  });
  view.querySelectorAll('[data-purchase-order-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ purchaseOrderDetailId: button.dataset.purchaseOrderView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-purchase-order-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ purchaseOrderDetailId: '' }));
  });
  view.querySelector('.analyticsPurchaseOrderModal')?.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  view.querySelectorAll('[data-purchase-order-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      const summary = getPurchaseOrderSummary(reportData.rows, filters.purchaseOrderDetailId);
      if (!summary) return;
      const format = button.dataset.purchaseOrderExport || 'pdf';
      await exportObjectRows({
        format,
        filename: `Purchase_Order_${summary.reference || summary.id}.${format}`,
        sheetName: 'Purchase Order',
        title: `Purchase Order ${summary.reference || summary.id}`,
        subtitle: `${summary.supplier} · ${summary.date} · ${summary.location}`,
        summaryRows: [
          { label: 'Supplier', value: summary.supplier },
          { label: 'Reference', value: summary.reference },
          { label: 'Status', value: summary.status },
          { label: 'Date', value: summary.date },
          { label: 'Location', value: summary.location },
          { label: 'User', value: summary.user || 'Unknown' },
          { label: 'Linked GRVs', value: formatNumber(summary.grvs.length) },
          { label: 'Total Ex', value: formatMoney(summary.totalEx) }
        ],
        rows: summary.exportRows,
        columns: ['Type', 'Document', 'Item', 'Location', 'Ordered Qty', 'Received Qty', 'Pack Size', 'Unit Cost', 'Total Ex'],
        branding: pdfBranding
      });
    });
  });
  view.querySelectorAll('[data-credit-note-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ creditNoteDetailId: button.dataset.creditNoteView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-credit-note-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ creditNoteDetailId: '' }));
  });
  view.querySelector('.analyticsCreditNoteModal')?.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  view.querySelectorAll('[data-credit-note-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      const summary = getCreditNoteSummary(reportData.rows, filters.creditNoteDetailId);
      if (!summary) return;
      const format = button.dataset.creditNoteExport || 'pdf';
      await exportObjectRows({
        format,
        filename: `Credit_Note_${summary.reference || summary.id}.${format}`,
        sheetName: 'Credit Note',
        title: `Credit Note ${summary.reference || summary.id}`,
        subtitle: `${summary.supplier} · ${summary.date} · ${summary.location}`,
        summaryRows: [
          { label: 'Supplier', value: summary.supplier },
          { label: 'Reference', value: summary.reference },
          { label: 'Date', value: summary.date },
          { label: 'Location', value: summary.location },
          { label: 'User', value: summary.user || 'Unknown' },
          { label: 'Reason', value: summary.reason || '' },
          { label: 'Total Ex', value: formatMoney(summary.totalEx) }
        ],
        rows: summary.lines,
        columns: ['Item', 'Location', 'Ordered Qty', 'Returned Qty', 'Pack Size', 'Unit Cost', 'Total Ex'],
        branding: pdfBranding
      });
    });
  });
  view.querySelectorAll('[data-stocktake-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ stockTakeDetailId: button.dataset.stocktakeView || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-stocktake-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ stockTakeDetailId: '', stockTakeEditId: '' }));
  });
  view.querySelector('.analyticsStockTakeModal')?.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  view.querySelectorAll('[data-stocktake-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const summary = getStockTakeSummary(reportData.rows, filters.stockTakeDetailId);
      if (!summary) return;
      onAnalyticsFilterChange?.({ stockTakeEditId: summary.id || '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-stocktake-cancel-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({ stockTakeEditId: '', openDropdown: '' });
    });
  });
  view.querySelectorAll('[data-stocktake-save-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const summary = getStockTakeSummary(reportData.rows, filters.stockTakeDetailId);
      if (!summary) return;
      const modal = button.closest('.analyticsStockTakeModal');
      const items = [...(modal?.querySelectorAll('[data-stocktake-edit-line]') || [])]
        .map((input) => ({
          stockItemId: input.dataset.stocktakeEditLine || '',
          shelfCount: parseNumber(input.value)
        }))
        .filter((line) => line.stockItemId && Number.isFinite(line.shelfCount) && line.shelfCount >= 0);
      onAnalyticsAction.onUpdateStockTake?.(summary.id, { items });
    });
  });
  view.querySelectorAll('[data-stocktake-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      const summary = getStockTakeSummary(reportData.rows, filters.stockTakeDetailId);
      if (!summary) return;
      const format = button.dataset.stocktakeExport || 'pdf';
      await exportObjectRows({
        format,
        filename: `Stock_Take_${summary.id || summary.date}.${format}`,
        sheetName: 'Stock Take',
        title: `Stock Take ${summary.id || summary.date}`,
        subtitle: `${summary.location} · ${summary.date}`,
        summaryRows: [
          { label: 'Date', value: summary.date },
          { label: 'Location', value: summary.location },
          { label: 'Template', value: summary.template || 'Quick Count' },
          { label: 'User', value: summary.user || 'Unknown' },
          { label: 'Items Counted', value: formatNumber(summary.lines.length) },
          { label: 'Variance Lines', value: formatNumber(summary.varianceLines) },
          { label: 'Net Impact', value: formatMoney(summary.netImpact) },
          { label: 'Note', value: summary.note || '' }
        ],
        rows: summary.lines,
        columns: ['Item', 'Location', 'System Stock', 'Counted Qty', 'Variance', 'Unit Cost', 'Impact Ex'],
        branding: pdfBranding
      });
    });
  });

  view.querySelectorAll('[data-analytics-field]').forEach((field) => {
    const deferred = field.dataset.analyticsDefer === 'true';
    if (deferred) return;
    const applyFieldValue = (event) => {
      onAnalyticsAction.onPreserveFocus?.(event.currentTarget);
      onAnalyticsFilterChange?.({
        [field.dataset.analyticsField]: field.value,
        page: 1,
        lowStockSelectedIds: [],
        forecastExpandedIds: [],
        modifierGpExpandedProducts: [],
        modifierGpExpandedCombinations: [],
        modifierSummaryExpandedItems: [],
        modifierSummaryExpandedProducts: []
      });
    };
    if (!deferred) {
      field.addEventListener('input', applyFieldValue);
    }
    field.addEventListener('change', applyFieldValue);
  });

  const currentBuilder = () => normalizeReportBuilderState(filters.customReportBuilder, filters);
  const updateBuilder = (patch = {}) => {
    const previous = currentBuilder();
    const next = {
      ...previous,
      ...patch,
      layout: {
        ...previous.layout,
        ...(patch.layout || {})
      }
    };
    next.sourceId = normalizeReportBuilderSourceId(next.sourceId);
    next.sourceIds = [...new Set([
      next.sourceId,
      ...(Array.isArray(next.sourceIds) ? next.sourceIds : []),
      ...reportBuilderLayoutFieldIds(next.layout).map(reportBuilderSourceIdFromFieldId)
    ].filter(Boolean).map(normalizeReportBuilderSourceListId))];
    const activeCustomColumns = reportBuilderLayoutFieldIds(next.layout)
      .map((fieldId) => getReportBuilderField(fieldId, next.calculatedFields))
      .filter((field) => field && field.sourceId === next.sourceId)
      .map((field) => field.label);
    onAnalyticsFilterChange?.({
      customReportBuilder: next,
      customReportName: next.name,
      customSource: next.sourceId,
      customColumns: [...new Set(activeCustomColumns)],
      customReportSavedMessage: '',
      page: 1,
      openDropdown: ''
    });
  };
  const updateBuilderLayout = (zone, updater) => {
    const builder = currentBuilder();
    const current = builder.layout[zone] || [];
    const nextZone = typeof updater === 'function' ? updater(current) : updater;
    updateBuilder({
      layout: {
        [zone]: normalizeBuilderFieldIds(nextZone, current, builder.sourceId, builder.calculatedFields)
      }
    });
  };
  const collectCustomReportManageDraft = () => {
    const patch = {};
    view.querySelectorAll('[data-custom-report-manage-field]').forEach((field) => {
      const key = field.dataset.customReportManageField;
      if (key) patch[key] = field.value;
    });
    return patch;
  };

  view.querySelectorAll('[data-report-builder-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.reportBuilderDropdown || '';
      const builder = currentBuilder();
      onAnalyticsFilterChange?.({
        customReportBuilder: {
          ...builder,
          openDropdown: builder.openDropdown === id ? '' : id
        },
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-report-builder-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.reportBuilderOption || '';
      if (!key) return;
      if (key === 'calculatedDraftType') {
        const builder = currentBuilder();
        updateBuilder({
          calculatedDraft: {
            ...builder.calculatedDraft,
            type: button.dataset.reportBuilderOptionValue || 'number'
          },
          openDropdown: ''
        });
        return;
      }
      if (key.startsWith('formatting:')) {
        const [, indexRaw, fieldName] = key.split(':');
        const index = Number(indexRaw);
        const builder = currentBuilder();
        const rules = [...(builder.formattingRules || [])];
        if (!rules[index]) return;
        rules[index] = {
          ...rules[index],
          [fieldName]: button.dataset.reportBuilderOptionValue || ''
        };
        updateBuilder({ formattingRules: rules, openDropdown: '' });
        return;
      }
      if (key.startsWith('filter:')) {
        const [, indexRaw, fieldName] = key.split(':');
        const index = Number(indexRaw);
        const builder = currentBuilder();
        const rules = [...(builder.filterRules || [])];
        if (!rules[index]) return;
        rules[index] = {
          ...rules[index],
          [fieldName]: button.dataset.reportBuilderOptionValue || '',
          value: fieldName === 'operator' && button.dataset.reportBuilderOptionValue === 'notEmpty' ? '' : rules[index].value
        };
        updateBuilder({ filterRules: rules, openDropdown: '' });
        return;
      }
      if (key.startsWith('threshold:')) {
        const [, indexRaw, fieldName] = key.split(':');
        const index = Number(indexRaw);
        const builder = currentBuilder();
        const rules = [...(builder.thresholdRules || [])];
        if (!rules[index]) return;
        rules[index] = {
          ...rules[index],
          [fieldName]: button.dataset.reportBuilderOptionValue || '',
          value: fieldName === 'operator' && button.dataset.reportBuilderOptionValue === 'notEmpty' ? '' : rules[index].value
        };
        updateBuilder({ thresholdRules: rules, openDropdown: '' });
        return;
      }
      if (key.startsWith('option:')) {
        const optionKey = key.split(':')[1] || '';
        const builder = currentBuilder();
        updateBuilder({
          options: {
            ...builder.options,
            [optionKey]: button.dataset.reportBuilderOptionValue || ''
          },
          openDropdown: ''
        });
        return;
      }
      if (key.startsWith('dataFilter:')) {
        const filterKey = key.split(':')[1] || '';
        const builder = currentBuilder();
        const value = button.dataset.reportBuilderOptionValue || '';
        updateBuilder({
          dataFilters: {
            ...builder.dataFilters,
            [filterKey]: value,
            startDate: filterKey === 'dateRange' && value !== 'custom' ? '' : builder.dataFilters.startDate,
            endDate: filterKey === 'dateRange' && value !== 'custom' ? '' : builder.dataFilters.endDate
          },
          openDropdown: ''
        });
        return;
      }
      updateBuilder({ [key]: button.dataset.reportBuilderOptionValue || '', openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-report-builder-template]').forEach((button) => {
    button.addEventListener('click', () => {
      const template = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === button.dataset.reportBuilderTemplate);
      if (!template) return;
      const builder = currentBuilder();
      const templateBuilder = normalizeReportBuilderState({
        ...(template.builder || {}),
        templateId: template.id,
        name: template.name || builder.name,
        title: template.name || builder.title,
        description: template.description || builder.description,
        sourceId: template.sourceId || template.builder?.sourceId || builder.sourceId,
        visualizationType: template.visualizationType || template.builder?.visualizationType || 'table',
        thresholdRules: template.builder?.thresholdRules || [],
        options: {
          ...builder.options,
          ...(template.builder?.options || {})
        }
      }, filters);
      updateBuilder({
        ...templateBuilder,
        reportConfigId: builder.reportConfigId,
        calculatedFields: builder.calculatedFields,
        calculatedDraftOpen: false,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-report-builder-field]').forEach((field) => {
    const key = field.dataset.reportBuilderField || '';
    const applyBuilderField = () => {
      const builder = currentBuilder();
      let value = field.type === 'checkbox' ? field.checked : field.value;
      const patch = { [key]: value };
      if (key === 'name' && !builder.titleOverridden) {
        patch.title = value;
      }
      if (key === 'title') {
        patch.titleOverridden = true;
      }
      updateBuilder(patch);
    };
    field.addEventListener(field.tagName === 'SELECT' || field.type === 'checkbox' ? 'change' : 'input', applyBuilderField);
  });

  view.querySelectorAll('[data-report-builder-field-tab]').forEach((button) => {
    button.addEventListener('click', () => updateBuilder({ fieldTab: button.dataset.reportBuilderFieldTab || 'All Fields' }));
  });

  view.querySelectorAll('[data-report-builder-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => updateBuilder({ settingsTab: button.dataset.reportBuilderSettingsTab || 'Format' }));
  });

  view.querySelectorAll('[data-report-builder-option-check]').forEach((field) => {
    field.addEventListener('change', () => {
      const builder = currentBuilder();
      updateBuilder({
        options: {
          ...builder.options,
          [field.dataset.reportBuilderOptionCheck || '']: field.checked
        }
      });
    });
  });

  view.querySelectorAll('[data-report-builder-option-input]').forEach((field) => {
    field.addEventListener('input', () => {
      const builder = currentBuilder();
      const key = field.dataset.reportBuilderOptionInput || '';
      updateBuilder({
        options: {
          ...builder.options,
          [key]: key === 'previewLimit' ? Math.min(100, Math.max(5, Number(field.value || 25) || 25)) : field.value
        }
      });
    });
  });

  view.querySelectorAll('[data-report-builder-data-filter]').forEach((field) => {
    field.addEventListener('change', () => {
      const builder = currentBuilder();
      const key = field.dataset.reportBuilderDataFilter || '';
      updateBuilder({
        dataFilters: {
          ...builder.dataFilters,
          dateRange: 'custom',
          [key]: field.value
        }
      });
    });
  });

  view.querySelectorAll('[data-report-builder-access-policy]').forEach((field) => {
    field.addEventListener('input', () => {
      const builder = currentBuilder();
      const key = field.dataset.reportBuilderAccessPolicy || '';
      updateBuilder({
        accessPolicy: {
          ...builder.accessPolicy,
          [key]: normalizeReportAccessList(field.value, key === 'roles')
        }
      });
    });
  });

  view.querySelectorAll('[data-report-builder-field-id]').forEach((button) => {
    button.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-kcp-report-field', button.dataset.reportBuilderFieldId || '');
      event.dataTransfer?.setData('text/plain', button.dataset.reportBuilderFieldId || '');
    });
    button.addEventListener('click', () => {
      const fieldId = button.dataset.reportBuilderFieldId || '';
      const field = getReportBuilderField(fieldId, currentBuilder().calculatedFields);
      const zone = field?.type === 'currency' || field?.type === 'number' ? 'values' : 'rows';
      updateBuilderLayout(zone, (current) => current.includes(fieldId) ? current : [...current, fieldId]);
    });
  });

  view.querySelectorAll('[data-report-builder-pill]').forEach((pill) => {
    pill.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-kcp-report-pill', JSON.stringify({
        fieldId: pill.dataset.reportBuilderPill || '',
        zone: pill.dataset.reportBuilderPillZone || '',
        index: Number(pill.dataset.reportBuilderPillIndex || 0) || 0
      }));
      event.dataTransfer?.setData('text/plain', pill.dataset.reportBuilderPill || '');
    });
  });

  view.querySelectorAll('[data-report-builder-drop-zone]').forEach((zoneNode) => {
    zoneNode.addEventListener('dragover', (event) => event.preventDefault());
    zoneNode.addEventListener('drop', (event) => {
      event.preventDefault();
      const zone = zoneNode.dataset.reportBuilderDropZone || '';
      const fieldId = event.dataTransfer?.getData('application/x-kcp-report-field') || '';
      const pillDataRaw = event.dataTransfer?.getData('application/x-kcp-report-pill') || '';
      if (pillDataRaw) {
        try {
          const pillData = JSON.parse(pillDataRaw);
          const sourceZone = pillData.zone || '';
          const movedId = pillData.fieldId || '';
          if (!movedId || !zone) return;
          const builder = currentBuilder();
          const nextLayout = { ...builder.layout };
          nextLayout[sourceZone] = (nextLayout[sourceZone] || []).filter((id, index) => !(id === movedId && index === Number(pillData.index || 0)));
          nextLayout[zone] = [...(nextLayout[zone] || []).filter((id) => id !== movedId), movedId];
          updateBuilder({ layout: nextLayout });
          return;
        } catch {
          return;
        }
      }
      if (fieldId && zone) {
        updateBuilderLayout(zone, (current) => current.includes(fieldId) ? current : [...current, fieldId]);
      }
    });
  });

  view.querySelectorAll('[data-report-builder-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      const [zone, ...fieldParts] = String(button.dataset.reportBuilderRemove || '').split('|');
      const fieldId = fieldParts.join('|');
      if (!zone || !fieldId) return;
      updateBuilderLayout(zone, (current) => current.filter((id) => id !== fieldId));
    });
  });

  view.querySelectorAll('[data-report-builder-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const zone = button.dataset.reportBuilderAdd || '';
      const builder = currentBuilder();
      const candidates = zone === 'values'
        ? getReportBuilderFields(builder.calculatedFields).filter((field) => ['currency', 'number'].includes(field.type))
        : getReportBuilderFields(builder.calculatedFields).filter((field) => !['currency'].includes(field.type));
      const next = candidates.find((field) => !(builder.layout[zone] || []).includes(field.id)) || candidates[0];
      if (!next) return;
      updateBuilderLayout(zone, (current) => current.includes(next.id) ? current : [...current, next.id]);
    });
  });

  view.querySelector('[data-report-builder-formatting-add]')?.addEventListener('click', () => {
    const builder = currentBuilder();
    const fields = reportBuilderSelectableFieldOptions(builder, true);
    const fieldId = fields[0]?.value || '';
    if (!fieldId) return;
    updateBuilder({
      formattingRules: [
        ...(builder.formattingRules || []),
        { id: `format-${Date.now()}`, fieldId, operator: 'greaterThan', value: '', tone: 'green' }
      ]
    });
  });

  view.querySelectorAll('[data-report-builder-formatting-input]').forEach((field) => {
    field.addEventListener('input', () => {
      const [indexRaw, key] = String(field.dataset.reportBuilderFormattingInput || '').split(':');
      const index = Number(indexRaw);
      const builder = currentBuilder();
      const rules = [...(builder.formattingRules || [])];
      if (!rules[index] || !key) return;
      rules[index] = { ...rules[index], [key]: field.value };
      updateBuilder({ formattingRules: rules });
    });
  });

  view.querySelectorAll('[data-report-builder-formatting-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.reportBuilderFormattingRemove || -1);
      const builder = currentBuilder();
      updateBuilder({ formattingRules: (builder.formattingRules || []).filter((_, itemIndex) => itemIndex !== index) });
    });
  });

  view.querySelector('[data-report-builder-filter-add]')?.addEventListener('click', () => {
    const builder = currentBuilder();
    const fields = reportBuilderSelectableFieldOptions(builder, true);
    const fieldId = fields[0]?.value || '';
    if (!fieldId) return;
    const field = getReportBuilderField(fieldId, builder.calculatedFields);
    updateBuilder({
      filterRules: [
        ...(builder.filterRules || []),
        { id: `filter-${Date.now()}`, fieldId, operator: field?.type === 'number' || field?.type === 'currency' ? 'greaterThan' : 'contains', value: '' }
      ],
      layout: {
        ...builder.layout,
        filters: [...new Set([...(builder.layout.filters || []), fieldId])]
      }
    });
  });

  view.querySelectorAll('[data-report-builder-filter-input]').forEach((field) => {
    field.addEventListener('input', () => {
      const [indexRaw, key] = String(field.dataset.reportBuilderFilterInput || '').split(':');
      const index = Number(indexRaw);
      const builder = currentBuilder();
      const rules = [...(builder.filterRules || [])];
      if (!rules[index] || !key) return;
      rules[index] = { ...rules[index], [key]: field.value };
      updateBuilder({ filterRules: rules });
    });
  });

  view.querySelectorAll('[data-report-builder-filter-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.reportBuilderFilterRemove || -1);
      const builder = currentBuilder();
      const removed = (builder.filterRules || [])[index];
      updateBuilder({
        filterRules: (builder.filterRules || []).filter((_, itemIndex) => itemIndex !== index),
        layout: {
          ...builder.layout,
          filters: removed?.fieldId
            ? (builder.layout.filters || []).filter((fieldId) => fieldId !== removed.fieldId)
            : builder.layout.filters
        }
      });
    });
  });

  view.querySelector('[data-report-builder-threshold-add]')?.addEventListener('click', () => {
    const builder = currentBuilder();
    const fields = reportBuilderSelectableFieldOptions(builder, true);
    const fieldId = fields.find((field) => getReportBuilderField(field.value, builder.calculatedFields)?.type !== 'text')?.value || fields[0]?.value || '';
    if (!fieldId) return;
    updateBuilder({
      settingsTab: 'Automation',
      thresholdRules: [
        ...(builder.thresholdRules || []),
        { id: `threshold-${Date.now()}`, fieldId, operator: 'greaterThan', value: '', label: 'Threshold breached' }
      ]
    });
  });

  view.querySelectorAll('[data-report-builder-threshold-input]').forEach((field) => {
    field.addEventListener('input', () => {
      const [indexRaw, key] = String(field.dataset.reportBuilderThresholdInput || '').split(':');
      const index = Number(indexRaw);
      const builder = currentBuilder();
      const rules = [...(builder.thresholdRules || [])];
      if (!rules[index] || !key) return;
      rules[index] = { ...rules[index], [key]: field.value };
      updateBuilder({ thresholdRules: rules });
    });
  });

  view.querySelectorAll('[data-report-builder-threshold-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.reportBuilderThresholdRemove || -1);
      const builder = currentBuilder();
      updateBuilder({ thresholdRules: (builder.thresholdRules || []).filter((_, itemIndex) => itemIndex !== index) });
    });
  });

  view.querySelector('[data-report-builder-copy-share]')?.addEventListener('click', async () => {
    const builder = currentBuilder();
    const link = buildReportShareUrl(builder);
    try {
      await navigator.clipboard?.writeText(link);
      onAnalyticsFilterChange?.({ customReportSavedMessage: 'Read-only report link copied.', openDropdown: '' });
    } catch {
      onAnalyticsFilterChange?.({ customReportSavedMessage: link, openDropdown: '' });
    }
  });

  view.querySelectorAll('[data-report-builder-drill]').forEach((button) => {
    button.addEventListener('click', () => {
      const builder = currentBuilder();
      const key = button.dataset.reportBuilderDrill || '';
      updateBuilder({
        options: {
          ...builder.options,
          drilldownKey: builder.options.drilldownKey === key ? '' : key
        }
      });
    });
  });

  view.querySelector('[data-report-builder-calculated-toggle]')?.addEventListener('click', () => {
    const builder = currentBuilder();
    updateBuilder({
      calculatedDraftOpen: !builder.calculatedDraftOpen,
      calculatedDraft: builder.calculatedDraftOpen ? builder.calculatedDraft : { name: '', formula: '', type: 'number' }
    });
  });

  view.querySelectorAll('[data-report-builder-calc-field]').forEach((field) => {
    field.addEventListener('input', () => {
      const builder = currentBuilder();
      const key = field.dataset.reportBuilderCalcField || '';
      updateBuilder({
        calculatedDraftOpen: true,
        calculatedDraft: {
          ...builder.calculatedDraft,
          [key]: field.value
        }
      });
    });
  });

  view.querySelector('[data-report-builder-calculated-cancel]')?.addEventListener('click', () => {
    updateBuilder({
      calculatedDraftOpen: false,
      calculatedDraft: { name: '', formula: '', type: 'number' }
    });
  });

  view.querySelector('[data-report-builder-calculated-save]')?.addEventListener('click', () => {
    const builder = currentBuilder();
    const label = String(builder.calculatedDraft?.name || '').trim();
    const formula = String(builder.calculatedDraft?.formula || '').trim();
    if (!label || !formula) {
      updateBuilder({
        calculatedDraftOpen: true,
        calculatedDraft: {
          ...builder.calculatedDraft,
          name: label,
          formula
        }
      });
      return;
    }
    const field = normalizeReportBuilderCalculatedFields([{
      label,
      formula,
      type: builder.calculatedDraft?.type || 'number'
    }])[0];
    if (!field) return;
    const calculatedFields = [
      ...(builder.calculatedFields || []).filter((item) => item.id !== field.id),
      field
    ];
    updateBuilder({
      calculatedFields,
      calculatedDraftOpen: false,
      calculatedDraft: { name: '', formula: '', type: 'number' },
      layout: {
        ...builder.layout,
        values: ['number', 'currency'].includes(field.type)
          ? [...new Set([...(builder.layout.values || []), field.id])]
          : builder.layout.values
      }
    });
  });

  view.querySelectorAll('[data-report-builder-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      const format = button.dataset.reportBuilderExport || 'pdf';
      const builder = currentBuilder();
      const output = buildReportBuilderOutput(builder, reportData, access);
      await exportObjectRows({
        format,
        filename: `${output.filename}.${format}`,
        sheetName: output.sheetName,
        title: output.title,
        subtitle: output.subtitle,
        summaryRows: output.summaryRows,
        rows: output.rows,
        columns: output.columns,
        branding: pdfBranding
      });
      onAnalyticsFilterChange?.({
        customReportSavedMessage: `Report exported to ${String(format).toUpperCase()}.`,
        openDropdown: ''
      });
    });
  });

  view.querySelector('[data-report-builder-print]')?.addEventListener('click', () => {
    window.print?.();
  });

  view.querySelectorAll('[data-custom-report-source]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({
        customSource: button.dataset.customReportSource || customReportSources[0]?.id || 'stock',
        customColumns: [],
        customReportBlocks: [],
        page: 1,
        customSetupOpen: true,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-visualization]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({
        visualizationType: button.dataset.customReportVisualization || 'table',
        customReportBlocks: [],
        page: 1,
        customSetupOpen: true,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-group]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({
        groupBy: button.dataset.customReportGroup || 'none',
        customReportBlocks: [],
        page: 1,
        customSetupOpen: true,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-column]').forEach((input) => {
    input.addEventListener('change', () => {
      const column = input.dataset.customReportColumn || '';
      const currentColumns = reportData.custom?.selectedColumns || reportData.columns || [];
      const nextColumns = input.checked
        ? [...currentColumns, column]
        : currentColumns.filter((item) => item !== column);
      if (!nextColumns.length) return;
      onAnalyticsFilterChange?.({
        customColumns: [...new Set(nextColumns)],
        customReportBlocks: [],
        page: 1,
        customSetupOpen: true,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-remove-column]').forEach((button) => {
    button.addEventListener('click', () => {
      const column = button.dataset.customReportRemoveColumn || '';
      const currentColumns = reportData.custom?.selectedColumns || reportData.columns || [];
      const nextColumns = currentColumns.filter((item) => item !== column);
      if (!nextColumns.length) return;
      onAnalyticsFilterChange?.({
        customColumns: nextColumns,
        customReportBlocks: [],
        page: 1,
        customSetupOpen: true,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-columns-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.customReportColumnsAction || 'default';
      const availableColumns = reportData.custom?.availableColumns || [];
      const defaultColumns = reportData.custom?.defaultColumns || availableColumns.slice(0, 6);
      onAnalyticsFilterChange?.({
        customColumns: action === 'all'
          ? availableColumns
          : action === 'clear'
            ? availableColumns.slice(0, 1)
            : defaultColumns,
        customReportBlocks: [],
        page: 1,
        customSetupOpen: true,
        openDropdown: ''
      });
    });
  });

  view.querySelector('[data-custom-report-eod]')?.addEventListener('change', (event) => {
    onAnalyticsFilterChange?.({
      customReportEod: event.target.checked,
      customSetupOpen: true,
      openDropdown: ''
    });
  });

  view.querySelector('[data-custom-report-ai-build]')?.addEventListener('click', async () => {
    const prompt = view.querySelector('[data-analytics-field="customReportPrompt"]')?.value || filters.customReportPrompt || '';
    if (!String(prompt || '').trim()) {
      onAnalyticsFilterChange?.({
        customReportPrompt: prompt,
        customReportAiStatus: 'error',
        customReportAiMessage: 'Describe the report you want to build first.',
        customReportCreateOpen: filters.customReportCreateOpen === true,
        customSetupOpen: filters.customSetupOpen === true,
        openDropdown: ''
      });
      return;
    }
    onAnalyticsFilterChange?.({
      customReportPrompt: prompt,
      customReportAiStatus: 'planning',
      customReportAiMessage: 'Planning report with Gemini...',
      customReportCreateOpen: filters.customReportCreateOpen === true,
      customSetupOpen: filters.customSetupOpen === true,
      openDropdown: ''
    });
    let suggestion;
    try {
      suggestion = await planReportConfigWithAi(workspaceId, prompt);
      suggestion.customReportAiStatus = suggestion.customReportAiSource === 'gemini' ? 'planned' : 'fallback';
      suggestion.customReportAiMessage = suggestion.customReportAiMessage || (suggestion.customReportAiSource === 'gemini'
        ? 'Gemini selected the report source, columns, chart, and grouping.'
        : 'Gemini is not configured, so the local planner built this report.');
    } catch (error) {
      suggestion = {
        ...buildCustomReportFromPrompt(prompt, reportData),
        customReportAiStatus: 'fallback',
        customReportAiSource: 'local',
        customReportAiMessage: error?.message
          ? `Gemini planner was unavailable, so the local planner built this report. ${error.message}`
          : 'Gemini planner was unavailable, so the local planner built this report.'
      };
    }
    onAnalyticsFilterChange?.({
      ...suggestion,
      customReportPrompt: prompt,
      customReportCreateOpen: false,
      customSetupOpen: false,
      customReportPreviewOpen: true,
      page: 1,
      openDropdown: ''
    });
  });

  view.querySelectorAll('[data-custom-report-new]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      customReportCreateOpen: true,
      customReportPreviewOpen: false,
      customSetupOpen: false,
      customReportAiStatus: '',
      customReportAiMessage: '',
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-custom-report-create-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      customReportCreateOpen: false,
      customReportAiStatus: '',
      customReportAiMessage: '',
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-custom-report-manual-build]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      reportId: 'custom_report',
      view: 'detail',
      customReportCreateOpen: false,
      customReportPreviewOpen: true,
      customSetupOpen: false,
      customReportBlocks: [],
      customReportBuilder: normalizeReportBuilderState({ reportConfigId: '' }, { ...filters, customReportConfigId: '', customReportName: 'Custom Report' }),
      customReportConfigId: '',
      customReportName: 'Custom Report',
      customReportReadOnly: false,
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-custom-dashboard-create]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      reportId: 'custom_report',
      view: 'detail',
      customReportCreateOpen: false,
      customReportPreviewOpen: true,
      customSetupOpen: false,
      customReportBlocks: [],
      customReportBuilder: normalizeReportBuilderState({ reportConfigId: '' }, { ...filters, customReportConfigId: '', customReportName: 'Custom Report' }),
      customReportConfigId: '',
      customReportName: 'Custom Report',
      customReportReadOnly: false,
      customReportEmailSentMessage: '',
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-report-builder-dashboard-template]').forEach((button) => {
    button.addEventListener('click', () => {
      const template = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === button.dataset.reportBuilderDashboardTemplate);
      if (!template) return;
      onAnalyticsAction.onApplyTemplate?.(template);
    });
  });

  view.querySelectorAll('[data-custom-exception-report]').forEach((button) => {
    button.addEventListener('click', () => {
      const reportId = button.dataset.customExceptionReport || '';
      if (!reportId) return;
      onAnalyticsFilterChange?.({
        reportId,
        view: 'detail',
        page: 1,
        lowStockSelectedIds: [],
        customReportPreviewOpen: false,
        customSetupOpen: false,
        customReportReadOnly: false,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-exception-template]').forEach((button) => {
    button.addEventListener('click', () => {
      const template = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === button.dataset.customExceptionTemplate);
      if (!template) return;
      onAnalyticsAction.onApplyTemplate?.(template);
    });
  });

  view.querySelectorAll('[data-custom-dashboard-field]').forEach((field) => {
    field.addEventListener('change', () => {
      const key = field.dataset.customDashboardField;
      if (!key) return;
      onAnalyticsFilterChange?.({
        [key]: field.value,
        openDropdown: ''
      });
    });
    if (field.type === 'search') {
      field.addEventListener('input', () => {
        const key = field.dataset.customDashboardField;
        if (!key) return;
        onAnalyticsFilterChange?.({
          [key]: field.value,
          openDropdown: ''
        });
      });
    }
  });

  view.querySelectorAll('[data-custom-dashboard-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.customDashboardOptionField;
      if (!key) return;
      onAnalyticsFilterChange?.({
        ...collectCustomReportManageDraft(),
        [key]: button.dataset.customDashboardOptionValue || '',
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-dashboard-view]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      customReportsViewMode: button.dataset.customDashboardView || 'grid',
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-custom-dashboard-view-all]').forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.dataset.customDashboardViewAll || '';
      onAnalyticsFilterChange?.({
        customReportsStatus: section === 'scheduled' ? 'Scheduled' : '',
        customReportsCreator: '',
        customReportsSchedule: section === 'scheduled' ? '' : '',
        customReportsDate: '',
        customReportsRecipients: '',
        customReportsSort: section === 'sent' ? 'updated' : section === 'recent' ? 'viewed' : 'updated',
        openDropdown: ''
      });
      view.querySelector('#custom-reports-all-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  view.querySelector('[data-custom-dashboard-toggle-filters]')?.addEventListener('click', () => {
    onAnalyticsFilterChange?.({
      customReportsFiltersOpen: !filters.customReportsFiltersOpen,
      openDropdown: ''
    });
  });

  view.querySelector('[data-custom-dashboard-clear-filters]')?.addEventListener('click', () => {
    onAnalyticsFilterChange?.({
      customReportsStatus: '',
      customReportsCreator: '',
      customReportsSchedule: '',
      customReportsDate: '',
      customReportsRecipients: '',
      openDropdown: ''
    });
  });

  view.querySelectorAll('[data-custom-dashboard-open]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const nestedControl = event.target.closest?.('button, a, input, select, textarea');
      if (nestedControl && nestedControl !== event.currentTarget) return;
      const reports = buildCustomDashboardReports(savedReports);
      const report = findCustomDashboardReport(reports, button.dataset.customDashboardOpen);
      const mode = event.currentTarget.dataset.mode || 'view';
      if (!report) return;
      if (!report.isMock && report.reportConfigId) {
        onAnalyticsAction.onOpenSaved?.(report.reportConfigId, mode);
        return;
      }
        onAnalyticsFilterChange?.({
        reportId: 'custom_report',
        view: 'detail',
        customReportCreateOpen: false,
        customReportPreviewOpen: true,
        customSetupOpen: false,
        customReportBlocks: [],
        customReportBuilder: {
          ...buildCustomDashboardBuilderState(report, filters),
          step: mode === 'view' ? 1 : 0
        },
        customReportReadOnly: mode === 'view',
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-email-now]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      customReportEmailId: button.dataset.customReportEmailNow || '',
      customReportEmailSentMessage: '',
      customReportsError: '',
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-custom-report-email-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      customReportEmailId: '',
      customReportsError: '',
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-custom-report-email-send]').forEach((button) => {
    button.addEventListener('click', () => {
      const reports = buildCustomDashboardReports(savedReports);
      const report = findCustomDashboardReport(reports, button.dataset.customReportEmailSend);
      if (!report) return;
      const modal = button.closest('.customReportsEmailModal');
      const recipients = splitDashboardRecipients(modal?.querySelector('[data-custom-dashboard-email-recipients]')?.value || '');
      if (!recipients.length) {
        onAnalyticsFilterChange?.({
          customReportsError: 'Add at least one recipient before sending this report.',
          openDropdown: ''
        });
        return;
      }
      const now = new Date().toISOString();
      const recentSends = [
        { sentAt: now, recipients, recipientCount: recipients.length },
        ...(Array.isArray(report.recentSends) ? report.recentSends : [])
      ].slice(0, 10);
      onAnalyticsAction.onManageSaved?.(report.reportConfigId || report.id, 'email-now', {
        name: report.name,
        description: report.description,
        status: 'Sent Today',
        lastSentAt: now,
        recipients,
        recipientCount: recipients.length,
        sentThisMonth: Number(report.sentThisMonth || 0) + 1,
        recentSends,
        emailEnabled: report.emailEnabled,
        scheduleType: report.scheduleType || 'On Demand',
        scheduleLabel: report.scheduleLabel || 'Manual send only',
        nextSendAt: report.nextSendAt || '',
        config: {
          ...report.config,
          status: 'Sent Today',
          lastSentAt: now,
          recipients,
          recipientCount: recipients.length,
          sentThisMonth: Number(report.sentThisMonth || 0) + 1,
          recentSends,
          eodRecipients: recipients.join(', ')
        }
      });
    });
  });

  view.querySelectorAll('[data-custom-dashboard-overflow-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const reports = buildCustomDashboardReports(savedReports);
      const report = findCustomDashboardReport(reports, button.dataset.reportId);
      const action = button.dataset.customDashboardOverflowAction || '';
      if (!report) return;
      if (action === 'delete' && report && !report.isMock && report.reportConfigId) {
        onAnalyticsAction.onDeleteSaved?.(report.reportConfigId);
        return;
      }
      if (action === 'download') {
        downloadCustomReportConfig(report);
        onAnalyticsFilterChange?.({
          customReportEmailSentMessage: `${report.name} downloaded.`,
          openDropdown: ''
        });
        return;
      }
      onAnalyticsFilterChange?.({
        customReportManageId: report.id,
        customReportManageAction: action,
        customReportManageName: action === 'duplicate' ? `${report.name} Copy` : report.name,
        customReportManageDescription: report.description || '',
        customReportManageRecipients: (report.recipients || []).join(', '),
        customReportManageScheduleType: report.scheduleType || 'On Demand',
        customReportManageScheduleLabel: report.scheduleLabel || '',
        customReportManageNextSendAt: report.nextSendAt || '',
        customReportEmailSentMessage: '',
        customReportsError: '',
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-manage-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      customReportManageId: '',
      customReportManageAction: '',
      customReportManageName: '',
      customReportManageDescription: '',
      customReportManageRecipients: '',
      customReportManageScheduleType: '',
      customReportManageScheduleLabel: '',
      customReportManageNextSendAt: '',
      customReportsError: '',
      openDropdown: ''
    }));
  });

  view.querySelectorAll('[data-custom-report-manage-field]').forEach((field) => {
    field.addEventListener('change', () => {
      const key = field.dataset.customReportManageField;
      if (!key) return;
      onAnalyticsFilterChange?.({
        [key]: field.value,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-manage-save]').forEach((button) => {
    button.addEventListener('click', () => {
      const reports = buildCustomDashboardReports(savedReports);
      const report = findCustomDashboardReport(reports, button.dataset.customReportManageSave);
      if (!report) return;
      const action = button.dataset.action || 'rename';
      const draft = {
        customReportManageName: filters.customReportManageName,
        customReportManageDescription: filters.customReportManageDescription,
        customReportManageRecipients: filters.customReportManageRecipients,
        customReportManageScheduleType: filters.customReportManageScheduleType,
        customReportManageScheduleLabel: filters.customReportManageScheduleLabel,
        customReportManageNextSendAt: filters.customReportManageNextSendAt,
        ...collectCustomReportManageDraft()
      };
      const recipients = String(draft.customReportManageRecipients || '')
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
      const scheduleType = String(draft.customReportManageScheduleType || report.scheduleType || 'On Demand').trim() || 'On Demand';
      const isScheduled = action === 'schedule' && scheduleType !== 'On Demand';
      const scheduleLabel = action === 'schedule'
        ? String(draft.customReportManageScheduleLabel || defaultReportScheduleLabel(scheduleType)).trim()
        : report.scheduleLabel;
      const nextSendAt = action === 'schedule'
        ? String(draft.customReportManageNextSendAt || defaultReportNextSend(scheduleType)).trim()
        : report.nextSendAt;
      if (isScheduled && !recipients.length) {
        onAnalyticsFilterChange?.({
          ...collectCustomReportManageDraft(),
          customReportsError: 'Add at least one recipient before scheduling recurring report emails.',
          openDropdown: ''
        });
        return;
      }
      const shareToken = report.shareToken || report.config?.shareToken || report.config?.builder?.options?.shareToken || createReportShareToken();
      const payload = {
        name: String(draft.customReportManageName || report.name || 'Custom Report').trim() || 'Custom Report',
        description: String(draft.customReportManageDescription ?? report.description ?? '').trim(),
        recipients,
        recipientCount: recipients.length,
        scheduleType: action === 'schedule' ? scheduleType : report.scheduleType,
        scheduleLabel,
        nextSendAt,
        status: action === 'archive' ? 'Archived' : action === 'schedule' ? (isScheduled ? 'Scheduled' : 'Active') : report.status,
        emailEnabled: action === 'archive' ? false : action === 'schedule' ? isScheduled : (action === 'recipients' ? recipients.length > 0 : report.emailEnabled),
        shareEnabled: action === 'share' ? true : report.shareEnabled,
        shareToken,
        config: {
          ...report.config,
          description: String(draft.customReportManageDescription ?? report.description ?? '').trim(),
          eodEnabled: action === 'archive' ? false : action === 'schedule' ? isScheduled : report.emailEnabled,
          eodRecipients: recipients.join(', '),
          eodSchedule: scheduleLabel,
          scheduleType,
          scheduleLabel,
          nextSendAt,
          recipients,
          recipientCount: recipients.length,
          shareEnabled: action === 'share' ? true : report.shareEnabled,
          shareToken,
          builder: report.config?.builder
            ? {
              ...report.config.builder,
              options: {
                ...(report.config.builder.options || {}),
                shareEnabled: action === 'share' ? true : report.shareEnabled,
                shareToken
              }
            }
            : report.config?.builder
        }
      };
      if (action === 'recipients') {
        payload.scheduleType = report.scheduleType;
        payload.scheduleLabel = report.scheduleLabel;
        payload.nextSendAt = report.nextSendAt;
      }
      onAnalyticsAction.onManageSaved?.(report.reportConfigId || report.id, action, payload);
      if (action === 'share') {
        const link = buildSavedReportShareUrl({ ...report, ...payload });
        navigator.clipboard?.writeText(link).catch(() => {});
      }
    });
  });

  view.querySelectorAll('[data-custom-report-prompt-example]').forEach((button) => {
    button.addEventListener('click', () => {
      const example = button.dataset.customReportPromptExample || '';
      const promptField = view.querySelector('[data-analytics-field="customReportPrompt"]');
      if (promptField) {
        promptField.value = example;
        promptField.focus({ preventScroll: true });
      }
      onAnalyticsFilterChange?.({
        customReportPrompt: example,
        customReportCreateOpen: true,
        customReportAiStatus: '',
        customReportAiMessage: '',
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-custom-report-setup-open]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ customSetupOpen: true, openDropdown: '' }));
  });

  view.querySelectorAll('[data-custom-report-save]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsAction.onSaveCurrent?.({}));
  });

  view.querySelectorAll('[data-custom-report-save-pinned]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsAction.onSaveCurrent?.({ pinned: true }));
  });

  view.querySelectorAll('[data-custom-report-template]').forEach((button) => {
    button.addEventListener('click', () => {
      const template = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === button.dataset.customReportTemplate);
      if (template) onAnalyticsAction.onApplyTemplate?.(template);
    });
  });

  view.querySelectorAll('[data-custom-report-open-saved]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsAction.onOpenSaved?.(button.dataset.customReportOpenSaved || ''));
  });

  view.querySelectorAll('[data-custom-report-toggle-pin]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsAction.onTogglePinned?.(button.dataset.customReportTogglePin || ''));
  });

  view.querySelectorAll('[data-custom-report-delete]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsAction.onDeleteSaved?.(button.dataset.customReportDelete || ''));
  });

  view.querySelectorAll('[data-custom-report-setup-close]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({ customSetupOpen: false, openDropdown: '' }));
  });

  view.querySelectorAll('[data-custom-report-run]').forEach((button) => {
    button.addEventListener('click', () => onAnalyticsFilterChange?.({
      ...collectDeferredAnalyticsFields(view),
      customReportBlocks: [],
      customSetupOpen: false,
      customReportPreviewOpen: true,
      openDropdown: '',
      page: 1
    }));
  });

  view.querySelector('.analyticsCustomSetupBackdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      onAnalyticsFilterChange?.({ customSetupOpen: false, openDropdown: '' });
    }
  });

  view.querySelectorAll('[data-analytics-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.analyticsDropdown || '';
      onAnalyticsFilterChange?.({ openDropdown: filters.openDropdown === id ? '' : id });
    });
  });

  view.querySelectorAll('[data-analytics-date-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const isOpen = filters.openDropdown === 'dateRange';
      onAnalyticsFilterChange?.({
        openDropdown: isOpen ? '' : 'dateRange',
        rangePickerCursor: filters.rangePickerCursor || startOfMonthKey(filters.startDate || defaultStartDate()),
        rangePickerEdge: filters.rangePickerEdge || 'start',
        rangePickerMode: filters.rangePickerMode || 'days'
      });
    });
  });

  view.querySelectorAll('[data-analytics-range-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({
        rangePickerCursor: shiftMonthKey(filters.rangePickerCursor || filters.startDate || defaultStartDate(), Number(button.dataset.analyticsRangeNav || 0)),
        openDropdown: 'dateRange',
        rangePickerMode: filters.rangePickerMode || 'days'
      });
    });
  });

  view.querySelectorAll('[data-analytics-range-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({
        openDropdown: 'dateRange',
        rangePickerMode: button.dataset.analyticsRangeMode || 'days',
        rangePickerYearInput: ''
      });
    });
  });

  view.querySelectorAll('[data-analytics-range-month]').forEach((button) => {
    button.addEventListener('click', () => {
      const cursor = parseDateKey(filters.rangePickerCursor || filters.startDate || defaultStartDate());
      cursor.setMonth(Number(button.dataset.analyticsRangeMonth || 0), 1);
      onAnalyticsFilterChange?.({
        openDropdown: 'dateRange',
        rangePickerMode: 'days',
        rangePickerCursor: toDateKey(cursor)
      });
    });
  });

  view.querySelectorAll('[data-analytics-range-year]').forEach((button) => {
    button.addEventListener('click', () => {
      const cursor = parseDateKey(filters.rangePickerCursor || filters.startDate || defaultStartDate());
      cursor.setFullYear(Number(button.dataset.analyticsRangeYear || cursor.getFullYear()), cursor.getMonth(), 1);
      onAnalyticsFilterChange?.({
        openDropdown: 'dateRange',
        rangePickerMode: 'months',
        rangePickerYearInput: '',
        rangePickerCursor: toDateKey(cursor)
      });
    });
  });

  view.querySelector('[data-analytics-range-year-input]')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = sanitizeYearInput(event.currentTarget.value);
    if (!value) return;
    const cursor = parseDateKey(filters.rangePickerCursor || filters.startDate || defaultStartDate());
    cursor.setFullYear(value, cursor.getMonth(), 1);
    onAnalyticsFilterChange?.({
      openDropdown: 'dateRange',
      rangePickerMode: 'months',
      rangePickerYearInput: '',
      rangePickerCursor: toDateKey(cursor)
    });
  });

  view.querySelector('[data-analytics-range-year-apply]')?.addEventListener('click', () => {
    const input = view.querySelector('[data-analytics-range-year-input]');
    const value = sanitizeYearInput(input?.value);
    if (!value) return;
    const cursor = parseDateKey(filters.rangePickerCursor || filters.startDate || defaultStartDate());
    cursor.setFullYear(value, cursor.getMonth(), 1);
    onAnalyticsFilterChange?.({
      openDropdown: 'dateRange',
      rangePickerMode: 'months',
      rangePickerYearInput: '',
      rangePickerCursor: toDateKey(cursor)
    });
  });

  view.querySelectorAll('[data-analytics-range-edge]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({
        rangePickerEdge: button.dataset.analyticsRangeEdge || 'start',
        rangePickerComplete: false,
        openDropdown: 'dateRange'
      });
    });
  });

  view.querySelectorAll('[data-analytics-range-day]').forEach((button) => {
    button.addEventListener('click', () => {
      const selected = button.dataset.analyticsRangeDay || todayLocal();
      const currentStart = filters.startDate || defaultStartDate();
      const shouldStartFresh = Boolean(filters.rangePickerComplete) || (filters.rangePickerEdge || 'start') === 'start';
      if (shouldStartFresh) {
        onAnalyticsFilterChange?.({
          startDate: selected,
          endDate: selected,
          page: 1,
          openDropdown: 'dateRange',
          rangePickerEdge: 'end',
          rangePickerComplete: false,
          rangePickerCursor: startOfMonthKey(selected)
        });
        return;
      }

      onAnalyticsFilterChange?.({
        startDate: selected < currentStart ? selected : currentStart,
        endDate: selected < currentStart ? currentStart : selected,
        page: 1,
        openDropdown: 'dateRange',
        rangePickerEdge: 'start',
        rangePickerComplete: true,
        rangePickerCursor: startOfMonthKey(selected)
      });
    });
  });

  view.querySelector('[data-analytics-range-today]')?.addEventListener('click', () => {
    const selected = todayLocal();
    const currentStart = filters.startDate || defaultStartDate();
    if ((filters.rangePickerEdge || 'start') === 'end') {
      onAnalyticsFilterChange?.({
        startDate: selected < currentStart ? selected : currentStart,
        endDate: selected < currentStart ? currentStart : selected,
        page: 1,
        openDropdown: 'dateRange',
        rangePickerEdge: 'start',
        rangePickerComplete: true,
        rangePickerCursor: startOfMonthKey(selected)
      });
      return;
    }

    onAnalyticsFilterChange?.({
      startDate: selected,
      endDate: selected,
      page: 1,
      openDropdown: 'dateRange',
      rangePickerEdge: 'end',
      rangePickerComplete: false,
      rangePickerCursor: startOfMonthKey(selected)
    });
  });

  view.querySelector('[data-analytics-range-clear]')?.addEventListener('click', () => {
    const endDate = todayLocal();
    const startDate = addDays(endDate, -29);
    onAnalyticsFilterChange?.({
      startDate,
      endDate,
      page: 1,
      openDropdown: 'dateRange',
      rangePickerEdge: 'start',
      rangePickerComplete: true,
      rangePickerCursor: startOfMonthKey(startDate)
    });
  });

  view.querySelectorAll('[data-analytics-range-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.analyticsRangePreset || '30';
      let endDate = todayLocal();
      const days = Number(preset || 30);
      let startDate = preset === 'ytd'
        ? startOfYearKey(endDate)
        : addDays(endDate, -(Math.max(1, days) - 1));
      if (preset === 'lastYear') {
        const range = previousCalendarYearRange(endDate);
        startDate = range.startDate;
        endDate = range.endDate;
      }
      onAnalyticsFilterChange?.({
        startDate,
        endDate,
        page: 1,
        openDropdown: '',
        rangePickerCursor: startOfMonthKey(startDate),
        rangePickerEdge: 'start',
        rangePickerComplete: true,
        rangePickerMode: 'days'
      });
    });
  });

  view.querySelector('[data-analytics-range-apply]')?.addEventListener('click', () => {
    onAnalyticsFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-analytics-low-stock-grv]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const selectedRows = selectedLowStockRows(reportData, filters);
      const rowKey = button.dataset.lowStockRowKey || '';
      const rowScopedSelection = rowKey
        ? lowStockSelectableRows(reportData.rows || []).filter((row) => lowStockRowKey(row) === rowKey)
        : [];
      onCreateLowStockGrvDraft?.({
        filters,
        reportData,
        selectedRows: rowScopedSelection.length ? rowScopedSelection : selectedRows,
        itemId: button.dataset.lowStockItemId || '',
        locationName: button.dataset.lowStockLocation || ''
      });
    });
  });

  view.querySelectorAll('[data-analytics-low-stock-select]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.analyticsLowStockSelect || '';
      const selected = new Set(arrayValue(filters.lowStockSelectedIds));
      if (input.checked) selected.add(key);
      else selected.delete(key);
      onAnalyticsFilterChange?.({ lowStockSelectedIds: [...selected], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-low-stock-select-group]').forEach((input) => {
    input.addEventListener('change', () => {
      const keys = String(input.dataset.analyticsLowStockSelectGroup || '').split('|').filter(Boolean);
      const selected = new Set(arrayValue(filters.lowStockSelectedIds));
      keys.forEach((key) => {
        if (input.checked) selected.add(key);
        else selected.delete(key);
      });
      onAnalyticsFilterChange?.({ lowStockSelectedIds: [...selected], openDropdown: '' });
    });
  });

  view.querySelector('[data-analytics-low-stock-select-all]')?.addEventListener('change', (event) => {
    const visibleKeys = lowStockSelectableRows(reportData.rows || []).map(lowStockRowKey).filter(Boolean);
    const selected = new Set(arrayValue(filters.lowStockSelectedIds));
    const checked = event.currentTarget.checked;
    visibleKeys.forEach((key) => {
      if (checked) selected.add(key);
      else selected.delete(key);
    });
    onAnalyticsFilterChange?.({ lowStockSelectedIds: [...selected], openDropdown: '' });
  });

  view.querySelector('[data-analytics-low-stock-clear-selection]')?.addEventListener('click', () => {
    onAnalyticsFilterChange?.({ lowStockSelectedIds: [], openDropdown: '' });
  });

  view.querySelectorAll('[data-analytics-low-stock-view-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      onAnalyticsFilterChange?.({
        lowStockViewMode: button.dataset.analyticsLowStockViewMode || 'item',
        lowStockSelectedIds: [],
        lowStockExpandedIds: [],
        lowStockReorderKey: '',
        page: 1,
        openDropdown: ''
      });
    });
  });

  view.querySelector('[data-analytics-low-stock-only-low]')?.addEventListener('change', (event) => {
    onAnalyticsFilterChange?.({
      lowStockShowOnlyLow: event.currentTarget.checked,
      lowStockSelectedIds: [],
      lowStockExpandedIds: [],
      page: 1,
      openDropdown: ''
    });
  });

  view.querySelectorAll('[data-analytics-low-stock-expand]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.analyticsLowStockExpand || '';
      const expanded = new Set(arrayValue(filters.lowStockExpandedIds));
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      onAnalyticsFilterChange?.({ lowStockExpandedIds: [...expanded], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-stock-expand]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.analyticsStockExpand || '';
      const expanded = new Set(arrayValue(filters.stockExpandedIds));
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      onAnalyticsFilterChange?.({ stockExpandedIds: [...expanded], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-modifier-gp-product]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.analyticsModifierGpProduct || '';
      const expanded = new Set(arrayValue(filters.modifierGpExpandedProducts));
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      onAnalyticsFilterChange?.({ modifierGpExpandedProducts: [...expanded], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-modifier-gp-combination]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.analyticsModifierGpCombination || '';
      const expanded = new Set(arrayValue(filters.modifierGpExpandedCombinations));
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      onAnalyticsFilterChange?.({ modifierGpExpandedCombinations: [...expanded], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-modifier-summary-item]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.analyticsModifierSummaryItem || '';
      const expanded = new Set(arrayValue(filters.modifierSummaryExpandedItems));
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      onAnalyticsFilterChange?.({ modifierSummaryExpandedItems: [...expanded], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-modifier-summary-product]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.analyticsModifierSummaryProduct || '';
      const expanded = new Set(arrayValue(filters.modifierSummaryExpandedProducts));
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      onAnalyticsFilterChange?.({ modifierSummaryExpandedProducts: [...expanded], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-low-stock-reorder-modal]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.analyticsLowStockReorderModal || '';
      const row = (reportData.rows || []).find((item) => String(item._groupKey || '') === key);
      const selectedIds = (row?._detailRows || []).map(lowStockRowKey).filter(Boolean);
      onAnalyticsFilterChange?.({
        lowStockReorderKey: key,
        lowStockReorderSelectedIds: selectedIds,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-analytics-low-stock-reorder-close]').forEach((button) => {
    button.addEventListener('click', (event) => {
      if (button.classList.contains('analyticsModalBackdrop') && event.target !== button) return;
      onAnalyticsFilterChange?.({ lowStockReorderKey: '', lowStockReorderSelectedIds: [], openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-analytics-low-stock-reorder-select]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.analyticsLowStockReorderSelect || '';
      const selected = new Set(arrayValue(filters.lowStockReorderSelectedIds));
      if (input.checked) selected.add(key);
      else selected.delete(key);
      onAnalyticsFilterChange?.({ lowStockReorderSelectedIds: [...selected], openDropdown: '' });
    });
  });

  view.querySelector('[data-analytics-low-stock-reorder-confirm]')?.addEventListener('click', (event) => {
    if (event.currentTarget.disabled) return;
    const row = (reportData.rows || []).find((item) => String(item._groupKey || '') === String(filters.lowStockReorderKey || ''));
    const selected = new Set(arrayValue(filters.lowStockReorderSelectedIds));
    const selectedRows = (row?._detailRows || []).filter((detail) => selected.has(lowStockRowKey(detail)));
    if (!selectedRows.length) return;
    onCreateLowStockGrvDraft?.({
      filters,
      reportData,
      selectedRows,
      itemId: '',
      locationName: ''
    });
  });

  view.querySelectorAll('[data-analytics-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.dataset.analyticsOptionField;
      onAnalyticsFilterChange?.({
        [field]: button.dataset.analyticsOptionValue || '',
        ...(['category', 'locationId', 'pageSize', 'supplier', 'forecastHorizon', 'item', 'recipeLineFilter', 'modifierGpMainProduct', 'modifierGpModifierItem', 'modifierGpCombination', 'modifierGpSort', 'modifierSummaryItem', 'modifierSummaryMainProduct', 'modifierSummaryCategory', 'modifierSummarySort'].includes(field) ? { page: 1 } : {}),
        ...(['category', 'locationId'].includes(field) ? { lowStockSelectedIds: [], lowStockExpandedIds: [], lowStockReorderKey: '', lowStockReorderSelectedIds: [] } : {}),
        ...(['category', 'locationId', 'pageSize'].includes(field) ? { stockExpandedIds: [] } : {}),
        ...(['category', 'locationId', 'forecastHorizon', 'pageSize'].includes(field) ? { forecastExpandedIds: [] } : {}),
        ...(['modifierGpMainProduct', 'modifierGpModifierItem', 'modifierGpCombination', 'modifierGpSort', 'locationId', 'pageSize'].includes(field) ? { modifierGpExpandedProducts: [], modifierGpExpandedCombinations: [] } : {}),
        ...(['modifierSummaryItem', 'modifierSummaryMainProduct', 'modifierSummaryCategory', 'modifierSummarySort', 'locationId', 'pageSize'].includes(field) ? { modifierSummaryExpandedItems: [], modifierSummaryExpandedProducts: [] } : {}),
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-analytics-page]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      onAnalyticsFilterChange?.({ page: Number(button.dataset.analyticsPage || 1), openDropdown: '' });
    });
  });

  view.addEventListener('click', (event) => {
    if (
      !filters.openDropdown ||
      event.target.closest('[data-analytics-dropdown-root]') ||
      event.target.closest('[data-analytics-date-range-root]')
    ) return;
    onAnalyticsFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-analytics-export]').forEach((button) => {
    button.addEventListener('click', async () => {
      const format = button.dataset.analyticsExport || 'xlsx';
      const exportRows = reportData.report?.id === 'forecast'
        ? buildForecastAdvancedRows(reportData.rows || [], filters)
        : reportData.report?.id === 'volatility'
          ? buildVolatilityAdvancedRows(reportData.rows || [], filters)
          : reportData.report?.id === 'modifier_gp_detail'
            ? buildModifierGpExportRows(reportData.rows || [], filters)
            : reportData.report?.id === 'modifier_gp_summary'
              ? buildModifierSummaryExportRows(reportData.rows || [], filters)
              : reportData.report?.id === 'waste_pareto'
                ? collectWasteIncidents(reportData.rows || [], filters)
        : reportData.rows;
      const exportColumns = reportData.report?.id === 'forecast'
        ? forecastAdvancedColumns()
        : reportData.report?.id === 'volatility'
          ? volatilityAdvancedColumns()
          : reportData.report?.id === 'waste_pareto'
            ? wasteIncidentColumns()
            : reportData.columns;
      const columns = exportColumns.filter((column) => !['Select', 'Action'].includes(column));
      const rows = exportRows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? ''])));
      const exportReportData = reportData.report?.id === 'forecast'
        ? { ...reportData, rows: exportRows, columns: exportColumns }
        : reportData.report?.id === 'modifier_gp_detail'
          ? { ...reportData, rows: exportRows, columns: exportColumns }
          : reportData.report?.id === 'modifier_gp_summary'
            ? { ...reportData, rows: exportRows, columns: exportColumns }
            : reportData.report?.id === 'waste_pareto'
              ? { ...reportData, rows: exportRows, columns: exportColumns }
        : reportData;
      await exportObjectRows({
        format,
        filename: `${reportData.report.title.replace(/\s+/g, '_')}.${format}`,
        sheetName: reportData.report.title.slice(0, 30),
        title: reportData.report.title,
        subtitle: reportData.report.description,
        summaryRows: buildReportExportSummary(exportReportData, filters),
        rows,
        columns,
        detailSheets: buildReportDetailSheets(exportReportData, exportRows),
        branding: pdfBranding
      });
      onAnalyticsFilterChange?.({ openDropdown: '' });
    });
  });
}

async function hydrateAnalyticsCharts(view) {
  const canvases = [...view.querySelectorAll('[data-custom-chart], [data-live-chart]')];
  if (!canvases.length) return;
  try {
    const module = await import('chart.js/auto');
    const Chart = module.default || module.Chart;
    canvases.forEach((canvas) => {
      const series = JSON.parse(canvas.dataset.chartSeries || '[]');
      const labelsFromAttr = JSON.parse(canvas.dataset.chartLabels || '[]');
      const datasetsFromAttr = JSON.parse(canvas.dataset.chartDatasets || '[]');
      const chartType = canvas.dataset.chartType === 'pie'
        ? 'doughnut'
        : canvas.dataset.chartType === 'line'
          ? 'line'
          : canvas.dataset.chartType === 'mixed'
            ? 'bar'
            : 'bar';
      const labels = labelsFromAttr.length ? labelsFromAttr : series.map((item) => item.label);
      const values = series.map((item) => Number(item.value || 0));
      const colors = ['#3b82f6', '#34d399', '#a78bfa', '#fb923c', '#facc15', '#14b8a6', '#f87171'];
      const isMiniChart = canvas.dataset.chartMini === 'true';
      const datasets = datasetsFromAttr.length
        ? datasetsFromAttr.map((dataset) => ({
          borderWidth: 2,
          pointHoverRadius: 5,
          ...dataset
        }))
        : [{
          label: 'Value',
          data: values,
          borderColor: '#60a5fa',
          backgroundColor: chartType === 'doughnut'
            ? labels.map((_, index) => series[index]?.color || colors[index % colors.length])
            : 'rgba(59, 130, 246, 0.62)',
          borderWidth: 2,
          tension: 0.35,
          fill: chartType === 'line'
        }];
      const hasSecondaryAxis = datasets.some((dataset) => dataset.yAxisID === 'y1');
      const context = canvas.getContext('2d');
      if (!context) return;
      if (canvas._kcpChart) {
        canvas._kcpChart.destroy();
      }
      const isDoughnut = chartType === 'doughnut';
      const suppressLegend = Boolean(canvas.closest('.analyticsLiveDoughnutWrap'));
      const hasBars = datasets.some((dataset) => (dataset.type || chartType) === 'bar');
      const hasLines = datasets.some((dataset) => (dataset.type || chartType) === 'line');
      canvas._kcpChart = new Chart(context, {
        type: chartType,
        data: {
          labels,
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: hasBars && hasLines ? 'index' : 'nearest' },
          plugins: {
            legend: {
              display: !isMiniChart && !suppressLegend && (isDoughnut || datasets.length > 1),
              position: isDoughnut ? 'right' : 'top',
              labels: {
                color: '#cbd5e1',
                boxWidth: 10,
                boxHeight: 10,
                usePointStyle: true,
                font: { size: 11, weight: '700' }
              }
            },
            tooltip: {
              intersect: false,
              mode: hasBars && hasLines ? 'index' : 'nearest',
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              titleColor: '#f8fafc',
              bodyColor: '#cbd5e1',
              borderColor: 'rgba(96, 165, 250, 0.3)',
              borderWidth: 1
            }
          },
          scales: isDoughnut || isMiniChart ? {} : {
            x: {
              grid: { display: false },
              ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, font: { size: 10, weight: '700' } }
            },
            y: {
              beginAtZero: false,
              grid: { color: 'rgba(148, 163, 184, 0.16)' },
              ticks: { color: '#94a3b8', font: { size: 10, weight: '700' } }
            },
            ...(hasSecondaryAxis ? {
              y1: {
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { color: '#94a3b8', font: { size: 10, weight: '700' } }
              }
            } : {})
          },
          onClick: (_event, elements) => {
            const index = elements?.[0]?.index;
            const label = Number.isInteger(index) ? labels[index] : '';
            if (label) {
              canvas.closest('.analyticsCustomVizPanel, .analyticsLiveChartFrame')?.setAttribute('data-drilldown-label', label);
            }
          }
        }
      });
    });
  } catch (error) {
    console.warn('[Analytics] Could not render custom charts:', error);
  }
}

function renderLowStockOrderingPanel(reportData, filters = {}) {
  const rows = lowStockSelectableRows(reportData.rows || []);
  const selectedRows = selectedLowStockRows(reportData, filters);
  const selectedCount = selectedRows.length;
  const activeRows = selectedCount ? selectedRows : rows;
  // In View-by-Item mode rows expose aggregated Total * fields; in View-by-Location
  // they expose per-location fields. Read whichever exists so the summary reconciles
  // with the visible table in both modes.
  const rowDeficit = (row) => parseMoney(row['Deficit Value'] ?? row['Total Deficit Value']);
  const rowVariance = (row) => parseNumber(row.Variance ?? row['Total Variance']);
  const deficit = activeRows.reduce((sum, row) => sum + rowDeficit(row), 0);
  const worstVariance = Math.min(0, ...activeRows.map(rowVariance));
  const draftQuantity = activeRows.reduce((sum, row) => sum + Math.max(0, -rowVariance(row)), 0);
  return `
    <section class="analyticsLowStockOrderPanel">
      <div class="analyticsLowStockOrderMain">
        <span class="analyticsLowStockOrderIcon">${icon('cart')}</span>
        <div>
          <h2>Automated Ordering</h2>
          <p>${rows.length ? `${selectedCount ? `${selectedCount} selected from ` : ''}${rows.length} low-stock item${rows.length === 1 ? '' : 's'} ready for a GRV draft.` : 'No low-stock items in this view.'}</p>
        </div>
      </div>
      <div class="analyticsLowStockOrderStats">
        <span><em>Deficit Value</em><strong>${escapeHtml(formatMoney(deficit))}</strong></span>
        <span><em>Worst Variance</em><strong>${escapeHtml(formatNumber(worstVariance))}</strong></span>
        <span><em>Draft Quantity</em><strong>${escapeHtml(formatNumber(draftQuantity))}</strong></span>
        ${selectedCount ? `<button type="button" data-analytics-low-stock-clear-selection>Clear selection</button>` : ''}
      </div>
    </section>
  `;
}

function renderLowStockControls(filters = {}) {
  const mode = filters.lowStockViewMode === 'location' ? 'location' : 'item';
  const showOnlyLow = filters.lowStockShowOnlyLow !== false;
  return `
    <section class="analyticsLowStockControls">
      <div class="analyticsSegmentedControl" aria-label="Low stock view mode">
        <button type="button" data-analytics-low-stock-view-mode="item" class="${mode === 'item' ? 'is-active' : ''}">
          ${icon('box')} View by Item
        </button>
        <button type="button" data-analytics-low-stock-view-mode="location" class="${mode === 'location' ? 'is-active' : ''}">
          ${icon('warehouse')} View by Location
        </button>
      </div>
      <label class="analyticsToggleControl">
        <input type="checkbox" data-analytics-low-stock-only-low ${showOnlyLow ? 'checked' : ''} />
        <span>Show only items below threshold</span>
      </label>
    </section>
  `;
}

function renderStockOnHandTableRows(pageRows = [], reportData = {}) {
  const columns = reportData.columns || [];
  if (!pageRows.length) {
    return `<tr><td colspan="${columns.length}">No stock items match this view.</td></tr>`;
  }
  return pageRows.map((row) => {
    const hasLocationBreakdown = Number(row._locationCount || 0) > 1;
    const mainRow = `
      <tr class="${hasLocationBreakdown ? 'analyticsStockOnHandGroupRow' : 'analyticsStockOnHandSingleRow'}">
        ${columns.map((column) => renderTableCell(column, row[column], row, reportData.report.id)).join('')}
      </tr>
    `;
    const detailRow = row._expanded && hasLocationBreakdown
      ? `<tr class="analyticsStockOnHandDetailRow"><td colspan="${columns.length}">${renderStockOnHandDetailTable(row)}</td></tr>`
      : '';
    return `${mainRow}${detailRow}`;
  }).join('');
}

function renderStockOnHandDetailTable(row = {}) {
  const details = row._detailRows || [];
  return `
    <div class="analyticsStockOnHandDetailPanel analyticsLowStockDetailPanel">
      <header>
        <strong>Location breakdown</strong>
        <span>${escapeHtml(row.Item || 'Stock item')} stock by location.</span>
      </header>
      <table>
        <thead>
          <tr>
            <th>Location</th>
            <th>On Hand</th>
            <th>Unit</th>
            <th>Unit Cost</th>
            <th>Stock Value</th>
          </tr>
        </thead>
        <tbody>
          ${details.map((detail) => `
            <tr>
              <td>${escapeHtml(detail.Location || 'Main Store')}</td>
              <td>${renderUnitValue('On Hand', detail['On Hand'], detail)}</td>
              <td>${escapeHtml(detail.Unit || detail._unit || '')}</td>
              <td>${escapeHtml(formatCurrencyCellValue(detail['Unit Cost'] || 'R 0,00'))}</td>
              <td>${escapeHtml(formatCurrencyCellValue(detail['Stock Value'] || 'R 0,00'))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderLowStockTableRows(pageRows = [], reportData = {}, filters = {}) {
  const columns = reportData.columns || [];
  if (!pageRows.length) {
    return `<tr><td colspan="${columns.length}">No low-stock items match this view.</td></tr>`;
  }
  return pageRows.map((row) => {
    const groupRow = row._locationGroupLabel ? `
      <tr class="analyticsLowStockLocationGroup">
        <td colspan="${columns.length}">
          ${icon('warehouse')}
          <strong>${escapeHtml(row._locationGroupLabel)}</strong>
          <span>${escapeHtml(row._locationGroupCount || '0')} item${Number(row._locationGroupCount || 0) === 1 ? '' : 's'} below threshold</span>
        </td>
      </tr>
    ` : '';
    const mainRow = `
      <tr class="${row._detailRows?.length ? 'analyticsLowStockItemRow' : 'analyticsLowStockLocationRow'}">
        ${columns.map((column) => renderTableCell(column, row[column], row, reportData.report.id)).join('')}
      </tr>
    `;
    const detailRow = row._expanded && row._detailRows?.length
      ? `<tr class="analyticsLowStockDetailRow"><td colspan="${columns.length}">${renderLowStockDetailTable(row)}</td></tr>`
      : '';
    return `${groupRow}${mainRow}${detailRow}`;
  }).join('');
}

function renderLowStockDetailTable(row = {}) {
  const details = row._detailRows || [];
  return `
    <div class="analyticsLowStockDetailPanel">
      <header>
        <strong>Store breakdown</strong>
        <span>Only locations below threshold are shown.</span>
      </header>
      <table>
        <thead>
          <tr>
            <th>Location</th>
            <th>Current Stock</th>
            <th>Threshold</th>
            <th>Variance</th>
            <th>Deficit Quantity</th>
            <th>Deficit Value</th>
            <th>Reorder action</th>
          </tr>
        </thead>
        <tbody>
          ${details.map((detail) => `
            <tr>
              <td>${escapeHtml(detail.Location || 'Main Store')}</td>
              <td>${renderUnitValue('Current Stock', detail['Current Stock'], detail)}</td>
              <td>${renderUnitValue('Threshold', detail.Threshold, detail)}</td>
              <td>${renderUnitValue('Variance', detail.Variance, detail)}</td>
              <td>${renderUnitValue('Deficit Quantity', detail['Deficit Quantity'], detail)}</td>
              <td>${escapeHtml(detail['Deficit Value'] || 'R 0,00')}</td>
              <td>
                <button
                  type="button"
                  class="analyticsInlineAction"
                  data-analytics-low-stock-grv
                  data-low-stock-item-id="${escapeAttribute(detail._id || detail.Item || '')}"
                  data-low-stock-location="${escapeAttribute(detail.Location || '')}"
                >
                  ${icon('cart')} Reorder
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderLowStockReorderModal(reportData = {}, filters = {}) {
  const key = String(filters.lowStockReorderKey || '');
  if (!key) return '';
  const row = (reportData.rows || []).find((item) => String(item._groupKey || '') === key);
  if (!row?._detailRows?.length) return '';
  const selected = new Set(arrayValue(filters.lowStockReorderSelectedIds));
  const selectedCount = row._detailRows.filter((detail) => selected.has(lowStockRowKey(detail))).length;
  return `
    <div class="analyticsModalBackdrop" data-analytics-low-stock-reorder-close>
      <section class="analyticsLowStockReorderModal" role="dialog" aria-modal="true" aria-label="Select stores to reorder">
        <header>
          <div>
            <span>Low Stock Alerts</span>
            <h2>Choose stores for ${escapeHtml(row.Item || 'this item')}</h2>
            <p>Each selected store keeps its own default GRV location.</p>
          </div>
          <button type="button" data-analytics-low-stock-reorder-close aria-label="Close">${icon('x')}</button>
        </header>
        <div class="analyticsLowStockReorderList">
          ${row._detailRows.map((detail) => {
            const detailKey = lowStockRowKey(detail);
            return `
              <label class="analyticsLowStockStoreChoice">
                <input
                  type="checkbox"
                  data-analytics-low-stock-reorder-select="${escapeAttribute(detailKey)}"
                  ${selected.has(detailKey) ? 'checked' : ''}
                />
                <span>
                  <strong>${escapeHtml(detail.Location || 'Main Store')}</strong>
                  <em>Default GRV location</em>
                </span>
                <span><em>Current</em><strong>${escapeHtml(detail['Current Stock'])} ${escapeHtml(detail.Unit || '')}</strong></span>
                <span><em>Threshold</em><strong>${escapeHtml(detail.Threshold)} ${escapeHtml(detail.Unit || '')}</strong></span>
                <span><em>Suggested</em><strong>${escapeHtml(detail['Deficit Quantity'])} ${escapeHtml(detail.Unit || '')}</strong></span>
                <span><em>Deficit</em><strong>${escapeHtml(detail['Deficit Value'])}</strong></span>
              </label>
            `;
          }).join('')}
        </div>
        <footer>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-analytics-low-stock-reorder-close>Cancel</button>
          <button type="button" class="analyticsInlineAction" data-analytics-low-stock-reorder-confirm ${selectedCount ? '' : 'disabled'}>
            ${icon('cart')} Reorder for selected stores${selectedCount ? ` (${selectedCount})` : ''}
          </button>
        </footer>
      </section>
    </div>
  `;
}

function renderModifierGpReportDetailView({ filters = {}, reportData = {}, category = {}, locationOptions = [], pageSize = 25 } = {}) {
  const model = buildModifierGpHierarchy(reportData.rows || [], filters);
  const totalRows = model.mainRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = model.mainRows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const summary = modifierGpTotals(model.filteredRows);

  return `
    <div class="analyticsDetailCanvas analyticsTone-${category.tone} analyticsDetailCanvas--modifierGp">
      <header class="analyticsReportMasthead">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsReportTitle">
            <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Track modifier GP impact by product.')}</h1>
            <p>${escapeHtml(reportData.report.description)}</p>
          </div>
        </div>
        <div class="analyticsHeaderActions">
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsFilterDock analyticsModifierGpFilters">
        ${renderDateRangePicker(filters)}
        ${renderDropdown({
          id: 'locationId',
          label: 'Location',
          selectedValue: filters.locationId || '',
          options: locationOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierGpMainProduct',
          label: 'Main Product',
          selectedValue: filters.modifierGpMainProduct || '',
          options: modifierGpOptions(model.allRows, 'mainProduct'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierGpModifierItem',
          label: 'Modifier Item',
          selectedValue: filters.modifierGpModifierItem || '',
          options: modifierGpOptions(model.allRows, 'modifierItem'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierGpCombination',
          label: 'Combination',
          selectedValue: filters.modifierGpCombination || '',
          options: modifierGpOptions(model.allRows, 'combination'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierGpSort',
          label: 'Sort',
          selectedValue: filters.modifierGpSort || 'totalSales',
          options: modifierGpSortOptions(),
          openDropdown: filters.openDropdown
        })}
        <label class="analyticsHeroSearch">
          <span>Search</span>
          <div>
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search products or modifiers..." data-analytics-field="query" data-focus-key="analytics-query" />
          </div>
        </label>
        <button type="button" class="analyticsRefreshButton" data-analytics-refresh>
          ${icon('refresh')}
          <span>Refresh report</span>
        </button>
      </section>

      <div class="analyticsSummaryGrid analyticsKpiGrid">
        <div class="analyticsKpiCard analyticsMetric-blue">
          <span class="analyticsKpiIcon">${icon('menu')}</span>
          <span class="analyticsKpiLabel">Main Products</span>
          <strong>${escapeHtml(formatNumber(totalRows))}</strong>
          <small>Products with matching sales</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-green">
          <span class="analyticsKpiIcon">${icon('cart')}</span>
          <span class="analyticsKpiLabel">Total Sales</span>
          <strong>${escapeHtml(formatMoney(summary.totalSales))}</strong>
          <small>Main plus modifier sales</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-orange">
          <span class="analyticsKpiIcon">${icon('coin')}</span>
          <span class="analyticsKpiLabel">Modifier Sales</span>
          <strong>${escapeHtml(formatMoney(summary.modifierSales))}</strong>
          <small>Attached modifier revenue</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-${summary.additionalGp < 0 ? 'red' : summary.additionalGp > 0 ? 'green' : 'purple'}">
          <span class="analyticsKpiIcon">${icon('chart')}</span>
          <span class="analyticsKpiLabel">Additional GP</span>
          <strong>${escapeHtml(formatSignedPercent(summary.additionalGp))}</strong>
          <small>Combined GP minus main GP</small>
        </div>
      </div>

      <section class="analyticsReportPanel analyticsReportPanel--modifierGp">
        <div class="analyticsTableBlock">
          <header>
            <div>
              <h2>Modifier GP Tracking Details ${renderReportInfo('Expand a main product to compare every modifier combination, then expand a combination to inspect the individual modifiers.')}</h2>
              <span>${totalRows ? `Showing ${firstRowNumber}-${lastRowNumber} of ${totalRows} main products` : 'No matching products'}</span>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({
                id: 'pageSize',
                label: 'Rows',
                selectedValue: String(pageSize),
                options: pageSizeOptions(),
                openDropdown: filters.openDropdown
              })}
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsModifierGpTable">
              <thead>
                <tr>
                  ${modifierGpMainColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip(reportData, column))}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${renderModifierGpMainRows(pageRows, filters)}
              </tbody>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} main products` : '0 rows'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>Page ${currentPage} of ${totalPages}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </div>
        ${totalRows > pageSize ? `<div class="analyticsLimitNote">Export includes the filtered detail rows for all ${escapeHtml(formatNumber(model.filteredRows.length))} sale lines.</div>` : ''}
      </section>
    </div>
  `;
}

function modifierGpMainColumns() {
  return ['Main Product', 'Qty Sold', 'Main Sales', 'Modifier Sales', 'Total Sales', 'Main Cost', 'Modifier Cost', 'Total Cost', 'GP Main %', 'GP Combined %', 'Additional GP %'];
}

function modifierGpCombinationColumns() {
  return ['Main Product', 'Modifier Combination', 'Qty Sold', 'Main Sales', 'Modifier Sales', 'Total Sales', 'Main Cost', 'Modifier Cost', 'Total Cost', 'GP Main %', 'GP Combined %', 'Additional GP %'];
}

function modifierGpItemColumns() {
  return ['Modifier Item', 'Modifier Qty', 'Modifier Selling', 'Modifier Cost', 'Modifier GP %'];
}

function renderModifierGpMainRows(rows = [], filters = {}) {
  if (!rows.length) {
    return `<tr><td colspan="${modifierGpMainColumns().length}">No modifier GP rows match this view.</td></tr>`;
  }
  const expandedProducts = new Set(arrayValue(filters.modifierGpExpandedProducts));
  return rows.map((row) => {
    const expanded = expandedProducts.has(row.key);
    const mainRow = `
      <tr class="analyticsModifierGpMainRow">
        <td>
          <button type="button" class="analyticsTreeToggle" data-analytics-modifier-gp-product="${escapeAttribute(row.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${icon(expanded ? 'chevronDown' : 'chevronRight')}
            <span>${escapeHtml(row.mainProduct)}</span>
          </button>
        </td>
        <td>${escapeHtml(formatNumber(row.qtySold))}</td>
        <td>${escapeHtml(formatMoney(row.mainSales))}</td>
        <td>${escapeHtml(formatMoney(row.modifierSales))}</td>
        <td>${escapeHtml(formatMoney(row.totalSales))}</td>
        <td>${escapeHtml(formatMoney(row.mainCost))}</td>
        <td>${escapeHtml(formatMoney(row.modifierCost))}</td>
        <td>${escapeHtml(formatMoney(row.totalCost))}</td>
        <td>${modifierGpBadge(row.gpMain)}</td>
        <td>${modifierGpBadge(row.gpCombined)}</td>
        <td>${modifierGpImpactBadge(row.additionalGp)}</td>
      </tr>
    `;
    const detailRow = expanded
      ? `<tr class="analyticsModifierGpNestedRow"><td colspan="${modifierGpMainColumns().length}">${renderModifierGpCombinationTable(row, filters)}</td></tr>`
      : '';
    return `${mainRow}${detailRow}`;
  }).join('');
}

function renderModifierGpCombinationTable(row = {}, filters = {}) {
  const expandedCombinations = new Set(arrayValue(filters.modifierGpExpandedCombinations));
  return `
    <div class="analyticsModifierGpNestedPanel">
      <table>
        <thead>
          <tr>${modifierGpCombinationColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${row.combinations.map((combo) => {
            const expanded = expandedCombinations.has(combo.key);
            const canExpand = combo.items.length > 0;
            return `
              <tr class="analyticsModifierGpComboRow">
                <td>${escapeHtml(combo.mainProduct)}</td>
                <td>
                  ${canExpand ? `
                    <button type="button" class="analyticsTreeToggle analyticsTreeToggle--child" data-analytics-modifier-gp-combination="${escapeAttribute(combo.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
                      ${icon(expanded ? 'chevronDown' : 'chevronRight')}
                      <span>${escapeHtml(combo.modifierCombination)}</span>
                    </button>
                  ` : `<span class="analyticsModifierGpNoModifier">${escapeHtml(combo.modifierCombination)}</span>`}
                </td>
                <td>${escapeHtml(formatNumber(combo.qtySold))}</td>
                <td>${escapeHtml(formatMoney(combo.mainSales))}</td>
                <td>${escapeHtml(formatMoney(combo.modifierSales))}</td>
                <td>${escapeHtml(formatMoney(combo.totalSales))}</td>
                <td>${escapeHtml(formatMoney(combo.mainCost))}</td>
                <td>${escapeHtml(formatMoney(combo.modifierCost))}</td>
                <td>${escapeHtml(formatMoney(combo.totalCost))}</td>
                <td>${modifierGpBadge(combo.gpMain)}</td>
                <td>${modifierGpBadge(combo.gpCombined)}</td>
                <td>${modifierGpImpactBadge(combo.additionalGp)}</td>
              </tr>
              ${expanded && canExpand ? `<tr class="analyticsModifierGpItemRow"><td colspan="${modifierGpCombinationColumns().length}">${renderModifierGpItemTable(combo)}</td></tr>` : ''}
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderModifierGpItemTable(combo = {}) {
  return `
    <div class="analyticsModifierGpItemPanel">
      <table>
        <thead>
          <tr>${modifierGpItemColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${combo.items.map((item) => `
            <tr>
              <td>${escapeHtml(item.name)}</td>
              <td>${escapeHtml(formatNumber(item.qty))}</td>
              <td>${escapeHtml(formatMoney(item.selling))}</td>
              <td>${escapeHtml(formatMoney(item.cost))}</td>
              <td>${modifierGpBadge(item.gp)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function buildModifierGpHierarchy(rows = [], filters = {}) {
  const allRows = rows.filter((row) => row && row._mainProduct);
  const filteredRows = allRows.filter((row) => modifierGpRowMatchesFilters(row, filters));
  const productGroups = groupRowsBy(filteredRows, (row) => row._mainProductKey || row._mainProduct || row['Main Product Sold']);
  const mainRows = [...productGroups.entries()].map(([key, productRows]) => {
    const totals = modifierGpTotals(productRows);
    const mainProduct = productRows[0]?._mainProduct || productRows[0]?.['Main Product Sold'] || 'Main Product';
    const comboGroups = groupRowsBy(productRows, (row) => row._modifierCombinationKey || row._modifierCombination || row['Modifier Combination']);
    const combinations = [...comboGroups.entries()].map(([comboKey, comboRows]) => {
      const comboTotals = modifierGpTotals(comboRows);
      const modifierCombination = comboRows[0]?._modifierCombination || comboRows[0]?.['Modifier Combination'] || 'No Modifier';
      return {
        key: `${key}::${comboKey}`,
        mainProduct,
        modifierCombination,
        ...comboTotals,
        items: modifierGpItemTotals(comboRows)
      };
    }).sort((left, right) => right.qtySold - left.qtySold || left.modifierCombination.localeCompare(right.modifierCombination));
    return {
      key,
      mainProduct,
      combinations,
      ...totals
    };
  });

  mainRows.sort(modifierGpSortComparator(filters.modifierGpSort || 'totalSales'));
  return { allRows, filteredRows, mainRows };
}

function modifierGpRowMatchesFilters(row = {}, filters = {}) {
  const mainProduct = String(filters.modifierGpMainProduct || '').trim();
  if (mainProduct && String(row._mainProduct || row['Main Product Sold'] || '') !== mainProduct) return false;
  const combination = String(filters.modifierGpCombination || '').trim();
  if (combination && String(row._modifierCombination || row['Modifier Combination'] || '') !== combination) return false;
  const modifierItem = String(filters.modifierGpModifierItem || '').trim();
  if (modifierItem) {
    const items = arrayValue(row._modifierItems);
    if (!items.some((item) => String(item.name || '') === modifierItem)) return false;
  }
  return true;
}

function modifierGpTotals(rows = []) {
  const mainSales = rows.reduce((sum, row) => sum + Number(row._mainSales || parseMoney(row['Main Product Selling']) || 0), 0);
  const modifierSales = rows.reduce((sum, row) => sum + Number(row._modifierSales || parseMoney(row['Modifier Selling']) || 0), 0);
  const mainCost = rows.reduce((sum, row) => sum + Number(row._mainCost || parseMoney(row['Main Selling Recipe Cost']) || 0), 0);
  const modifierCost = rows.reduce((sum, row) => sum + Number(row._modifierCost || parseMoney(row['Modifier Cost']) || 0), 0);
  const qtySold = rows.reduce((sum, row) => sum + Number(row._qtySold || parseNumber(row['Qty Sold']) || 0), 0);
  const totalSales = mainSales + modifierSales;
  const totalCost = mainCost + modifierCost;
  const gpMain = mainSales > 0 ? ((mainSales - mainCost) / mainSales) * 100 : 0;
  const gpCombined = totalSales > 0 ? ((totalSales - totalCost) / totalSales) * 100 : gpMain;
  return {
    qtySold,
    mainSales,
    modifierSales,
    totalSales,
    mainCost,
    modifierCost,
    totalCost,
    gpMain,
    gpCombined,
    additionalGp: gpCombined - gpMain
  };
}

function modifierGpItemTotals(rows = []) {
  const itemGroups = new Map();
  rows.forEach((row) => {
    arrayValue(row._modifierItems).forEach((item) => {
      const key = String(item.name || '').trim().toLowerCase();
      if (!key) return;
      const current = itemGroups.get(key) || { name: item.name || 'Modifier', qty: 0, selling: 0, cost: 0 };
      current.qty += Number(item.qty || 0);
      current.selling += Number(item.selling || 0);
      current.cost += Number(item.cost || 0);
      itemGroups.set(key, current);
    });
  });
  return [...itemGroups.values()]
    .map((item) => ({
      ...item,
      gp: item.selling > 0 ? ((item.selling - item.cost) / item.selling) * 100 : 0
    }))
    .sort((left, right) => right.selling - left.selling || left.name.localeCompare(right.name));
}

function groupRowsBy(rows = [], keyFn = () => '') {
  return rows.reduce((map, row) => {
    const key = String(keyFn(row) || '').trim() || 'Unspecified';
    const group = map.get(key) || [];
    group.push(row);
    map.set(key, group);
    return map;
  }, new Map());
}

function modifierGpSortComparator(sortKey = 'totalSales') {
  const key = String(sortKey || 'totalSales');
  const metric = key === 'qtySold'
    ? 'qtySold'
    : key === 'gpCombined'
      ? 'gpCombined'
      : key === 'additionalGp'
        ? 'additionalGp'
        : 'totalSales';
  return (left, right) => Number(right[metric] || 0) - Number(left[metric] || 0) || String(left.mainProduct || '').localeCompare(String(right.mainProduct || ''));
}

function modifierGpSortOptions() {
  return [
    { value: 'totalSales', label: 'Total Sales' },
    { value: 'qtySold', label: 'Qty Sold' },
    { value: 'gpCombined', label: 'GP Combined %' },
    { value: 'additionalGp', label: 'Additional GP %' }
  ];
}

function modifierGpOptions(rows = [], type = '') {
  const values = new Set();
  rows.forEach((row) => {
    if (type === 'mainProduct') values.add(String(row._mainProduct || row['Main Product Sold'] || '').trim());
    if (type === 'combination') values.add(String(row._modifierCombination || row['Modifier Combination'] || '').trim());
    if (type === 'modifierItem') {
      arrayValue(row._modifierItems).forEach((item) => values.add(String(item.name || '').trim()));
    }
  });
  const labels = [...values].filter(Boolean).sort((left, right) => left.localeCompare(right));
  const fallback = type === 'mainProduct'
    ? 'All Main Products'
    : type === 'modifierItem'
      ? 'All Modifier Items'
      : 'All Combinations';
  return [{ value: '', label: fallback }, ...labels.map((label) => ({ value: label, label }))];
}

function buildModifierGpExportRows(rows = [], filters = {}) {
  return rows
    .filter((row) => row && row._mainProduct)
    .filter((row) => modifierGpRowMatchesFilters(row, filters));
}

function modifierGpBadge(value = 0) {
  const numeric = Number(value || 0);
  return `<span class="analyticsGpBadge ${gpToneClass(numeric)}">${escapeHtml(`${formatNumber(numeric)}%`)}</span>`;
}

function modifierGpImpactBadge(value = 0) {
  const numeric = Number(value || 0);
  const tone = numeric > 0.0001 ? 'is-positive' : numeric < -0.0001 ? 'is-negative' : 'is-neutral';
  return `<span class="analyticsModifierGpImpact ${tone}">${escapeHtml(formatSignedPercent(numeric))}</span>`;
}

function formatSignedPercent(value = 0) {
  const numeric = Number(value || 0);
  if (Math.abs(numeric) < 0.0001) return '0%';
  return `${numeric > 0 ? '+' : ''}${formatNumber(numeric)}%`;
}

function renderModifierSummaryReportDetailView({ filters = {}, reportData = {}, category = {}, locationOptions = [], pageSize = 25 } = {}) {
  const model = buildModifierSummaryHierarchy(reportData.rows || [], filters);
  const totalRows = model.modifierRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = model.modifierRows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const totals = modifierSummaryTotals(model.filteredRows);

  return `
    <div class="analyticsDetailCanvas analyticsTone-${category.tone} analyticsDetailCanvas--modifierSummary">
      <header class="analyticsReportMasthead">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsReportTitle">
            <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Summarise modifier sales and GP.')}</h1>
            <p>${escapeHtml(reportData.report.description)}</p>
          </div>
        </div>
        <div class="analyticsHeaderActions">
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsFilterDock analyticsModifierSummaryFilters">
        ${renderDateRangePicker(filters)}
        ${renderDropdown({
          id: 'locationId',
          label: 'Location',
          selectedValue: filters.locationId || '',
          options: locationOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierSummaryItem',
          label: 'Modifier Item',
          selectedValue: filters.modifierSummaryItem || '',
          options: modifierSummaryOptions(model.allRows, 'item'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierSummaryMainProduct',
          label: 'Main Product',
          selectedValue: filters.modifierSummaryMainProduct || '',
          options: modifierSummaryOptions(model.allRows, 'mainProduct'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierSummaryCategory',
          label: 'Modifier Category',
          selectedValue: filters.modifierSummaryCategory || '',
          options: modifierSummaryOptions(model.allRows, 'category'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierSummarySort',
          label: 'Sort',
          selectedValue: filters.modifierSummarySort || 'modifierSales',
          options: modifierSummarySortOptions(),
          openDropdown: filters.openDropdown
        })}
        <label class="analyticsHeroSearch">
          <span>Search</span>
          <div>
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search modifiers or products..." data-analytics-field="query" data-focus-key="analytics-query" />
          </div>
        </label>
        <button type="button" class="analyticsRefreshButton" data-analytics-refresh>
          ${icon('refresh')}
          <span>Refresh report</span>
        </button>
      </section>

      <div class="analyticsSummaryGrid analyticsKpiGrid">
        <div class="analyticsKpiCard analyticsMetric-blue">
          <span class="analyticsKpiIcon">${icon('menu')}</span>
          <span class="analyticsKpiLabel">Modifiers</span>
          <strong>${escapeHtml(formatNumber(totalRows))}</strong>
          <small>Unique modifier items</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-green">
          <span class="analyticsKpiIcon">${icon('cart')}</span>
          <span class="analyticsKpiLabel">Modifier Sales</span>
          <strong>${escapeHtml(formatMoney(totals.sales))}</strong>
          <small>Total modifier revenue</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-orange">
          <span class="analyticsKpiIcon">${icon('coin')}</span>
          <span class="analyticsKpiLabel">Modifier GP</span>
          <strong>${escapeHtml(formatMoney(totals.gp))}</strong>
          <small>Sales minus modifier cost</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-${totals.gpPercent === null ? 'purple' : gpMetricTone(totals.gpPercent)}">
          <span class="analyticsKpiIcon">${icon('chart')}</span>
          <span class="analyticsKpiLabel">Modifier GP %</span>
          <strong>${escapeHtml(formatOptionalPercent(totals.gpPercent))}</strong>
          <small>Weighted by total sales</small>
        </div>
      </div>

      <section class="analyticsReportPanel analyticsReportPanel--modifierSummary">
        <div class="analyticsTableBlock">
          <header>
            <div>
              <h2>Modifier Summary Details ${renderReportInfo('Expand a modifier to see which main products it was attached to, then expand a main product for sale/order detail.')}</h2>
              <span>${totalRows ? `Showing ${firstRowNumber}-${lastRowNumber} of ${totalRows} modifiers` : 'No matching modifiers'}</span>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({
                id: 'pageSize',
                label: 'Rows',
                selectedValue: String(pageSize),
                options: pageSizeOptions(),
                openDropdown: filters.openDropdown
              })}
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsModifierSummaryTable">
              <thead>
                <tr>${modifierSummaryColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip(reportData, column))}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${renderModifierSummaryRows(pageRows, filters)}
              </tbody>
              <tfoot>
                ${renderModifierSummaryTotalsRow(totals)}
              </tfoot>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} modifiers` : '0 rows'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>Page ${currentPage} of ${totalPages}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </div>
      </section>
    </div>
  `;
}

function modifierSummaryColumns() {
  return ['Modifier Item', 'Qty Sold', 'Modifier Sales', 'Modifier Cost', 'Modifier GP', 'Modifier GP %', 'Avg Selling Price', 'Avg Cost', 'Attached Main Products'];
}

function modifierSummaryProductColumns() {
  return ['Modifier Item', 'Main Product Sold', 'Qty Sold', 'Modifier Sales', 'Modifier Cost', 'Modifier GP', 'Modifier GP %'];
}

function modifierSummaryDetailColumns() {
  return ['Date', 'Sale ID / Order ID', 'Main Product Sold', 'Modifier Item', 'Modifier Selling', 'Modifier Cost', 'Modifier GP', 'Modifier GP %'];
}

function renderModifierSummaryRows(rows = [], filters = {}) {
  if (!rows.length) {
    return `<tr><td colspan="${modifierSummaryColumns().length}">No modifier summary rows match this view.</td></tr>`;
  }
  const expandedItems = new Set(arrayValue(filters.modifierSummaryExpandedItems));
  return rows.map((row) => {
    const expanded = expandedItems.has(row.key);
    const statusBadge = row.zeroPriceCount ? `<em class="analyticsModifierSummaryFlag">${escapeHtml(row.zeroPriceCount)} zero-price</em>` : '';
    const mainRow = `
      <tr class="analyticsModifierSummaryMainRow">
        <td>
          <button type="button" class="analyticsTreeToggle" data-analytics-modifier-summary-item="${escapeAttribute(row.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${icon(expanded ? 'chevronDown' : 'chevronRight')}
            <span>${escapeHtml(row.modifierItem)}</span>
          </button>
          ${statusBadge}
        </td>
        <td>${escapeHtml(formatNumber(row.qty))}</td>
        <td>${escapeHtml(formatMoney(row.sales))}</td>
        <td>${escapeHtml(formatMoney(row.cost))}</td>
        <td>${modifierSummaryMoneyBadge(row.gp)}</td>
        <td>${modifierSummaryPercentBadge(row.gpPercent)}</td>
        <td>${escapeHtml(formatMoney(row.avgSelling))}</td>
        <td>${escapeHtml(formatMoney(row.avgCost))}</td>
        <td>${escapeHtml(row.attachedMainProducts.join(', ') || 'None')}</td>
      </tr>
    `;
    const detailRow = expanded
      ? `<tr class="analyticsModifierSummaryNestedRow"><td colspan="${modifierSummaryColumns().length}">${renderModifierSummaryProductTable(row, filters)}</td></tr>`
      : '';
    return `${mainRow}${detailRow}`;
  }).join('');
}

function renderModifierSummaryProductTable(row = {}, filters = {}) {
  const expandedProducts = new Set(arrayValue(filters.modifierSummaryExpandedProducts));
  return `
    <div class="analyticsModifierSummaryNestedPanel">
      <table>
        <thead>
          <tr>${modifierSummaryProductColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${row.products.map((product) => {
            const expanded = expandedProducts.has(product.key);
            return `
              <tr class="analyticsModifierSummaryProductRow">
                <td>${escapeHtml(product.modifierItem)}</td>
                <td>
                  <button type="button" class="analyticsTreeToggle analyticsTreeToggle--child" data-analytics-modifier-summary-product="${escapeAttribute(product.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
                    ${icon(expanded ? 'chevronDown' : 'chevronRight')}
                    <span>${escapeHtml(product.mainProduct)}</span>
                  </button>
                </td>
                <td>${escapeHtml(formatNumber(product.qty))}</td>
                <td>${escapeHtml(formatMoney(product.sales))}</td>
                <td>${escapeHtml(formatMoney(product.cost))}</td>
                <td>${modifierSummaryMoneyBadge(product.gp)}</td>
                <td>${modifierSummaryPercentBadge(product.gpPercent)}</td>
              </tr>
              ${expanded ? `<tr class="analyticsModifierSummaryDetailRow"><td colspan="${modifierSummaryProductColumns().length}">${renderModifierSummaryDetailTable(product)}</td></tr>` : ''}
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderModifierSummaryDetailTable(product = {}) {
  return `
    <div class="analyticsModifierSummaryDetailPanel">
      <table>
        <thead>
          <tr>${modifierSummaryDetailColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${product.details.map((detail) => `
            <tr>
              <td>${escapeHtml(detail.Date || '')}</td>
              <td>${escapeHtml(detail['Sale ID / Order ID'] || '')}</td>
              <td>${escapeHtml(detail['Main Product Sold'] || '')}</td>
              <td>${escapeHtml(detail['Modifier Item'] || '')}</td>
              <td>${escapeHtml(formatMoney(detail._modifierSales))}</td>
              <td>${escapeHtml(formatMoney(detail._modifierCost))}</td>
              <td>${modifierSummaryMoneyBadge(detail._modifierGp)}</td>
              <td>${modifierSummaryPercentBadge(detail._modifierGpPercent)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderModifierSummaryTotalsRow(totals = {}) {
  return `
    <tr class="analyticsModifierSummaryTotalsRow">
      <td>Totals</td>
      <td>${escapeHtml(formatNumber(totals.qty))}</td>
      <td>${escapeHtml(formatMoney(totals.sales))}</td>
      <td>${escapeHtml(formatMoney(totals.cost))}</td>
      <td>${escapeHtml(formatMoney(totals.gp))}</td>
      <td>${escapeHtml(formatOptionalPercent(totals.gpPercent))}</td>
      <td>${escapeHtml(formatMoney(totals.avgSelling))}</td>
      <td>${escapeHtml(formatMoney(totals.avgCost))}</td>
      <td>${escapeHtml(formatNumber(totals.mainProductCount || 0))} main products</td>
    </tr>
  `;
}

function buildModifierSummaryHierarchy(rows = [], filters = {}) {
  const allRows = rows.filter((row) => row && row._modifierItem);
  const filteredRows = allRows.filter((row) => modifierSummaryRowMatchesFilters(row, filters));
  const modifierGroups = groupRowsBy(filteredRows, (row) => row._modifierItemKey || row._modifierItem || row['Modifier Item']);
  const modifierRows = [...modifierGroups.entries()].map(([key, modifierRowsForItem]) => {
    const modifierItem = modifierRowsForItem[0]?._modifierItem || modifierRowsForItem[0]?.['Modifier Item'] || 'Modifier';
    const productGroups = groupRowsBy(modifierRowsForItem, (row) => row._mainProductKey || row._mainProduct || row['Main Product Sold']);
    const products = [...productGroups.entries()].map(([productKey, productRows]) => ({
      key: `${key}::${productKey}`,
      modifierItem,
      mainProduct: productRows[0]?._mainProduct || productRows[0]?.['Main Product Sold'] || 'Main Product',
      details: productRows,
      ...modifierSummaryTotals(productRows)
    })).sort((left, right) => right.sales - left.sales || left.mainProduct.localeCompare(right.mainProduct));
    const totals = modifierSummaryTotals(modifierRowsForItem);
    return {
      key,
      modifierItem,
      products,
      attachedMainProducts: products.map((product) => product.mainProduct).sort((left, right) => left.localeCompare(right)),
      zeroPriceCount: modifierRowsForItem.filter((row) => row._zeroPrice).length,
      ...totals
    };
  });
  modifierRows.sort(modifierSummarySortComparator(filters.modifierSummarySort || 'modifierSales'));
  return { allRows, filteredRows, modifierRows };
}

function modifierSummaryTotals(rows = []) {
  const qty = rows.reduce((sum, row) => sum + Number(row._qtySold || parseNumber(row['Qty Sold']) || 0), 0);
  const sales = rows.reduce((sum, row) => sum + Number(row._modifierSales || parseMoney(row['Modifier Selling']) || 0), 0);
  const cost = rows.reduce((sum, row) => sum + Number(row._modifierCost || parseMoney(row['Modifier Cost']) || 0), 0);
  const gp = sales - cost;
  const gpPercent = sales > 0 ? (gp / sales) * 100 : null;
  return {
    qty,
    sales,
    cost,
    gp,
    gpPercent,
    avgSelling: qty > 0 ? sales / qty : 0,
    avgCost: qty > 0 ? cost / qty : 0,
    mainProductCount: uniqueCount(rows, 'Main Product Sold')
  };
}

function modifierSummaryRowMatchesFilters(row = {}, filters = {}) {
  const item = String(filters.modifierSummaryItem || '').trim();
  if (item && String(row._modifierItem || row['Modifier Item'] || '') !== item) return false;
  const mainProduct = String(filters.modifierSummaryMainProduct || '').trim();
  if (mainProduct && String(row._mainProduct || row['Main Product Sold'] || '') !== mainProduct) return false;
  const category = String(filters.modifierSummaryCategory || '').trim();
  if (category && String(row._modifierCategory || row['Modifier Category'] || '') !== category) return false;
  return true;
}

function modifierSummaryOptions(rows = [], type = '') {
  const values = new Set();
  rows.forEach((row) => {
    if (type === 'item') values.add(String(row._modifierItem || row['Modifier Item'] || '').trim());
    if (type === 'mainProduct') values.add(String(row._mainProduct || row['Main Product Sold'] || '').trim());
    if (type === 'category') values.add(String(row._modifierCategory || row['Modifier Category'] || '').trim());
  });
  const labels = [...values].filter(Boolean).sort((left, right) => left.localeCompare(right));
  const fallback = type === 'item'
    ? 'All Modifier Items'
    : type === 'mainProduct'
      ? 'All Main Products'
      : 'All Categories';
  return [{ value: '', label: fallback }, ...labels.map((label) => ({ value: label, label }))];
}

function modifierSummarySortOptions() {
  return [
    { value: 'modifierSales', label: 'Modifier Sales' },
    { value: 'qtySold', label: 'Qty Sold' },
    { value: 'modifierGp', label: 'Modifier GP' },
    { value: 'modifierGpPercent', label: 'Modifier GP %' }
  ];
}

function modifierSummarySortComparator(sortKey = 'modifierSales') {
  const metric = sortKey === 'qtySold'
    ? 'qty'
    : sortKey === 'modifierGp'
      ? 'gp'
      : sortKey === 'modifierGpPercent'
        ? 'gpPercent'
        : 'sales';
  return (left, right) => {
    const leftValue = left[metric] === null ? Number.NEGATIVE_INFINITY : Number(left[metric] || 0);
    const rightValue = right[metric] === null ? Number.NEGATIVE_INFINITY : Number(right[metric] || 0);
    return rightValue - leftValue || String(left.modifierItem || '').localeCompare(String(right.modifierItem || ''));
  };
}

function buildModifierSummaryExportRows(rows = [], filters = {}) {
  return rows
    .filter((row) => row && row._modifierItem)
    .filter((row) => modifierSummaryRowMatchesFilters(row, filters));
}

function modifierSummaryMoneyBadge(value = 0) {
  const numeric = Number(value || 0);
  const tone = numeric < 0 ? 'is-negative' : numeric > 0 ? 'is-positive' : 'is-neutral';
  return `<span class="analyticsModifierSummaryMoney ${tone}">${escapeHtml(formatMoney(numeric))}</span>`;
}

function modifierSummaryPercentBadge(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '<span class="analyticsModifierSummaryPercent is-na">N/A</span>';
  }
  return `<span class="analyticsGpBadge ${gpToneClass(Number(value || 0))}">${escapeHtml(`${formatNumber(value)}%`)}</span>`;
}

function formatOptionalPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  return `${formatNumber(value)}%`;
}

function renderCustomReportBuilder(reportData, filters = {}) {
  const custom = reportData.custom || {};
  const sourceOptions = custom.sourceOptions || customReportSources;
  const selectedColumns = new Set(custom.selectedColumns || reportData.columns || []);
  const activeSource = custom.sourceId || sourceOptions[0]?.id || 'stock';
  const availableColumns = custom.availableColumns || reportData.columns || [];
  const sourceConfig = sourceOptions.find((source) => source.id === activeSource) || sourceOptions[0] || {};
  const primaryColumn = reportData.columns[0] || 'Report';
  return `
    <section class="analyticsCustomBuilder">
      <header class="analyticsCustomBuilderHero">
        <div>
          <span>${icon('grid')}</span>
          <div>
            <h2>Live Custom View</h2>
            <p>${escapeHtml(custom.sourceLabel || sourceConfig.label || 'Live data')} with ${selectedColumns.size} selected field${selectedColumns.size === 1 ? '' : 's'}.</p>
          </div>
        </div>
        <div class="analyticsCustomActions">
          <button type="button" class="analyticsCustomSetupButton" data-custom-report-setup-open>${icon('sliders')} Setup Report</button>
        </div>
      </header>
      <div class="analyticsCustomPreviewGrid">
        <div>
          <span>${icon(reportIcon(sourceConfig.reportId || activeSource))}</span>
          <small>Data Source</small>
          <strong>${escapeHtml(custom.sourceLabel || sourceConfig.label || 'Live data')}</strong>
        </div>
        <div>
          <span>${icon('clipboard')}</span>
          <small>Rows</small>
          <strong>${escapeHtml(formatNumber(reportData.rows.length))}</strong>
        </div>
        <div>
          <span>${icon('grid')}</span>
          <small>Columns</small>
          <strong>${escapeHtml(formatNumber(selectedColumns.size))}</strong>
        </div>
        <div>
          <span>${icon('file')}</span>
          <small>First Field</small>
          <strong>${escapeHtml(primaryColumn)}</strong>
        </div>
      </div>
    </section>
    ${filters.customSetupOpen ? renderCustomReportSetupDrawer(reportData) : ''}
  `;
}

function renderCustomReportSetupDrawer(reportData) {
  const custom = reportData.custom || {};
  const sourceOptions = custom.sourceOptions || customReportSources;
  const selectedColumns = new Set(custom.selectedColumns || reportData.columns || []);
  const activeSource = custom.sourceId || sourceOptions[0]?.id || 'stock';
  const availableColumns = custom.availableColumns || reportData.columns || [];
  const columnSearch = String(reportData.filters?.customColumnSearch || '').trim().toLowerCase();
  const visibleColumns = availableColumns.filter((column) => !columnSearch || String(column).toLowerCase().includes(columnSearch));
  const activeVisualization = custom.visualizationType || 'table';
  const activeGroup = custom.groupBy || 'none';
  const prompt = String(reportData.filters?.customReportPrompt || '').trim();
  const reportName = String(reportData.filters?.customReportName || 'Custom Report').trim() || 'Custom Report';
  const eodEnabled = reportData.filters?.customReportEod === true || reportData.filters?.customReportEod === 'true';
  const eodRecipients = String(reportData.filters?.customReportRecipients || '').trim();
  const eodSchedule = String(reportData.filters?.customReportSchedule || 'Daily EOD').trim();
  const aiStatus = String(reportData.filters?.customReportAiStatus || '').trim();
  const aiMessage = String(reportData.filters?.customReportAiMessage || '').trim();
  return `
    <div class="analyticsCustomSetupBackdrop">
      <aside class="analyticsCustomSetupDrawer" role="dialog" aria-modal="true" aria-label="Custom report setup">
        <header>
          <div>
            <p>Custom Report Setup</p>
            <h2>Build Report View ${renderReportInfo('Create a reusable custom report, choose its fields, and prepare it for dashboard or EOD email use.')}</h2>
          </div>
          <button type="button" class="analyticsCustomSetupClose" data-custom-report-setup-close aria-label="Close setup">${icon('x')}</button>
        </header>

        <div class="analyticsCustomSteps">
          ${renderCustomSetupStep('1', 'Data Source', 'Choose the live dataset this report should use.')}
          ${renderCustomSetupStep('2', 'Columns', 'Select only the fields your customer needs.')}
          ${renderCustomSetupStep('3', 'Filters', 'Use date, category, location, and search filters above the report.')}
          ${renderCustomSetupStep('4', 'Preview & Export', 'Run the preview, then export CSV, Excel, or PDF.')}
        </div>

        <section class="analyticsCustomSetupSection analyticsCustomPromptBuilder">
          <div class="analyticsCustomSectionHead">
            <strong>AI Report Prompt</strong>
            <span>Natural language builder</span>
          </div>
          <label class="analyticsCustomTextField">
            <span>Describe the report you want</span>
            <textarea
              data-analytics-field="customReportPrompt"
              data-analytics-defer="true"
              data-focus-key="custom-report-prompt"
              placeholder="Example: Build an EOD sales report by location with payments, tax, tips, and refunds grouped by day."
            >${escapeHtml(prompt)}</textarea>
          </label>
          <div class="analyticsCustomPromptActions">
            <button type="button" ${aiStatus === 'planning' ? 'disabled' : ''} data-custom-report-ai-build>
              ${icon(aiStatus === 'planning' ? 'refresh' : 'sparkles')}
              ${aiStatus === 'planning' ? 'Gemini is thinking...' : 'Build from prompt'}
            </button>
            <small>Uses Gemini when configured, then falls back to the local planner if the API key is missing or unavailable.</small>
          </div>
          ${aiMessage ? `<div class="analyticsCustomAiNotice analyticsCustomAiNotice--${escapeAttribute(aiStatus || 'planned')}">${escapeHtml(aiMessage)}</div>` : ''}
        </section>

        <section class="analyticsCustomSetupSection analyticsCustomReportIdentity">
          <div class="analyticsCustomSectionHead">
            <strong>Report Identity</strong>
            <span>Saved view details</span>
          </div>
          <label class="analyticsCustomTextField">
            <span>Report name</span>
            <input type="text" value="${escapeAttribute(reportName)}" data-analytics-field="customReportName" data-analytics-defer="true" data-focus-key="custom-report-name" placeholder="E.g. Daily owner EOD report" />
          </label>
        </section>

        <section class="analyticsCustomSetupSection">
          <div class="analyticsCustomSectionHead">
            <strong>Data Source</strong>
            <span>${escapeHtml(custom.sourceLabel || 'Live Data')}</span>
          </div>
          <div class="analyticsCustomSourceGrid">
            ${sourceOptions.map((source) => `
              <button type="button" class="${source.id === activeSource ? 'isActive' : ''}" data-custom-report-source="${escapeAttribute(source.id)}">
                <span>${icon(reportIcon(source.reportId || source.id))}</span>
                <strong>${escapeHtml(source.label)}</strong>
                <small>${escapeHtml(source.group || reportCatalog.find((report) => report.id === source.reportId)?.group || 'Live data')}</small>
              </button>
            `).join('')}
          </div>
        </section>

        <section class="analyticsCustomSetupSection">
          <div class="analyticsCustomSectionHead">
            <strong>Visualization</strong>
            <span>${escapeHtml(visualizationLabel(activeVisualization))}</span>
          </div>
          <div class="analyticsCustomOptionGrid">
            ${VISUALIZATION_OPTIONS.map((option) => `
              <button type="button" class="${option.id === activeVisualization ? 'isActive' : ''}" data-custom-report-visualization="${escapeAttribute(option.id)}">
                ${icon(option.icon)}
                <span>${escapeHtml(option.label)}</span>
              </button>
            `).join('')}
          </div>
        </section>

        <section class="analyticsCustomSetupSection">
          <div class="analyticsCustomSectionHead">
            <strong>Grouping</strong>
            <span>${escapeHtml(groupingLabel(activeGroup))}</span>
          </div>
          <div class="analyticsCustomOptionGrid analyticsCustomOptionGrid--compact">
            ${GROUPING_OPTIONS.map((option) => `
              <button type="button" class="${option.id === activeGroup ? 'isActive' : ''}" data-custom-report-group="${escapeAttribute(option.id)}">
                <span>${escapeHtml(option.label)}</span>
              </button>
            `).join('')}
          </div>
        </section>

        <section class="analyticsCustomSetupSection">
          <div class="analyticsCustomSectionHead">
            <strong>Column Chooser</strong>
            <span>${selectedColumns.size} of ${availableColumns.length} selected</span>
          </div>
          <label class="analyticsCustomTextField">
            <span>Search columns</span>
            <input type="search" value="${escapeAttribute(reportData.filters?.customColumnSearch || '')}" data-analytics-field="customColumnSearch" data-analytics-defer="true" data-focus-key="custom-column-search" placeholder="Find a field..." />
          </label>
          <div class="analyticsCustomSelectedColumns">
            <strong>Selected order</strong>
            <div>
              ${[...selectedColumns].map((column, index) => `
                <span>
                  <em>${index + 1}</em>
                  ${escapeHtml(column)}
                  <button type="button" ${selectedColumns.size <= 1 ? 'disabled' : ''} data-custom-report-remove-column="${escapeAttribute(column)}" aria-label="Remove ${escapeAttribute(column)}">${icon('x')}</button>
                </span>
              `).join('') || '<p>No columns selected.</p>'}
            </div>
          </div>
          <div class="analyticsCustomActions analyticsCustomActions--drawer">
            <button type="button" data-custom-report-columns-action="default">Default columns</button>
            <button type="button" data-custom-report-columns-action="all">Select all</button>
            <button type="button" data-custom-report-columns-action="clear">Clear optional</button>
          </div>
          <div class="analyticsCustomColumns analyticsCustomColumns--drawer">
            ${visibleColumns.map((column) => `
              <label class="analyticsCustomColumn">
                <input
                  type="checkbox"
                  ${selectedColumns.has(column) ? 'checked' : ''}
                  ${selectedColumns.size <= 1 && selectedColumns.has(column) ? 'disabled' : ''}
                  data-custom-report-column="${escapeAttribute(column)}"
                />
                <span>${escapeHtml(column)}</span>
              </label>
            `).join('') || '<p>No matching columns.</p>'}
          </div>
        </section>

        <section class="analyticsCustomSetupSection analyticsCustomEodSection">
          <div class="analyticsCustomSectionHead">
            <strong>EOD Email Report</strong>
            <span>${eodEnabled ? 'Email-ready' : 'Off'}</span>
          </div>
          <label class="analyticsCustomCheckRow">
            <input type="checkbox" ${eodEnabled ? 'checked' : ''} data-custom-report-eod />
            <span>
              <strong>Prepare this report for EOD email sending</strong>
              <small>Saves recipients and schedule metadata with the report. Actual email sending uses the Gmail/email integration phase.</small>
            </span>
          </label>
          <label class="analyticsCustomTextField">
            <span>Email recipients</span>
            <input type="text" value="${escapeAttribute(eodRecipients)}" data-analytics-field="customReportRecipients" data-analytics-defer="true" data-focus-key="custom-report-recipients" placeholder="owner@example.com, manager@example.com" />
          </label>
          <label class="analyticsCustomTextField">
            <span>Schedule</span>
            <input type="text" value="${escapeAttribute(eodSchedule)}" data-analytics-field="customReportSchedule" data-analytics-defer="true" data-focus-key="custom-report-schedule" placeholder="Daily EOD" />
          </label>
        </section>

        <footer>
          <button type="button" class="analyticsCustomSetupGhost" data-custom-report-setup-close>Cancel</button>
          <button type="button" class="analyticsCustomSetupRun" data-custom-report-run>${icon('play')} Run Report</button>
        </footer>
      </aside>
    </div>
  `;
}

function renderCustomSetupStep(number, title, helper) {
  return `
    <div>
      <span>${escapeHtml(number)}</span>
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(helper)}</small>
    </div>
  `;
}

function renderCategoryCard(category) {
  const reports = category.availableReports || reportsForCategory(category);
  return `
    <button type="button" class="analyticsCategoryCard analyticsTone-${category.tone}" data-analytics-category="${escapeAttribute(category.id)}" data-analytics-first-report="${escapeAttribute(reports[0]?.id || '')}">
      <span>${icon(category.icon)}</span>
      <strong>${escapeHtml(category.title)}</strong>
      <p>${escapeHtml(category.description)}</p>
      <em>${reports.length} report${reports.length === 1 ? '' : 's'}</em>
    </button>
  `;
}

function renderHubCategoryTabs(activeCategory = 'all') {
  const tabs = [
    { id: 'all', label: 'All Reports', icon: 'grid' },
    { id: 'inventory', label: 'Inventory', icon: 'box' },
    { id: 'operations', label: 'Operations', icon: 'activity' },
    { id: 'sales', label: 'Sales', icon: 'cart' },
    { id: 'advanced', label: 'Advanced Reports', icon: 'chart' }
  ];
  return `
    <nav class="analyticsHubTabs" aria-label="Report categories">
      ${tabs.map((tab) => `
        <button
          type="button"
          data-analytics-hub-category="${escapeAttribute(tab.id)}"
          class="analyticsHubTab--${escapeAttribute(tab.id)} ${activeCategory === tab.id ? 'is-active' : ''}"
        >
          ${tab.icon ? icon(tab.icon) : ''}
          <span>${escapeHtml(tab.label)} ${renderReportInfo(hubTabTooltip(tab.id, tab.label))}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

function hubTabTooltip(id = '', label = '') {
  const group = HUB_REPORT_GROUPS.find((item) => item.id === id);
  if (id === 'all') return 'Show every available report category and report tile.';
  return group?.description || group?.subtitle || `Show ${label} reports.`;
}

function renderHubActionsDropdown(openDropdown = '') {
  const isOpen = openDropdown === 'hubActions';
  return `
    <div class="analyticsActionsDropdown analyticsHubActions analyticsDropdown ${isOpen ? 'is-open' : ''}" data-analytics-dropdown-root>
      <button type="button" data-analytics-dropdown="hubActions" aria-expanded="${isOpen}">
        <strong>Actions</strong>
        ${icon('chevronDown')}
      </button>
      <div class="analyticsDropdownMenu analyticsActionsMenu">
        <button type="button" data-analytics-report="stock">${icon('box')} Stock on hand</button>
        <button type="button" data-analytics-report="low_stock">${icon('activity')} Low stock alerts</button>
      </div>
    </div>
  `;
}

function renderHubGroup(group, options = {}) {
  const reports = Array.isArray(group.reportItems) ? group.reportItems : reportsForHubGroup(group);
  return `
    <section class="analyticsOldGroup analyticsTone-${group.tone} analyticsHubReportSection analyticsHubReportSection--list">
      <header>
        <div>
          <h2>${escapeHtml(group.title)}</h2>
        </div>
      </header>
      <div class="analyticsHubReportGrid">
        ${reports.map((report, index) => renderHubReportCard(report, group, { ...options, index, count: reports.length })).join('')}
      </div>
    </section>
  `;
}

function renderHubReportCard(report, group = {}, options = {}) {
  const tone = group.tone || categoryForReport(report.id).tone;
  const tooltip = report.description || reportShortDescription(report);
  const comingSoon = report.id === 'custom_report';
  return `
    <button
      type="button"
      class="analyticsOldReportCard analyticsHubListCard analyticsTone-${tone}${comingSoon ? ' is-coming-soon' : ''}"
      ${comingSoon ? 'disabled' : `data-analytics-report="${escapeAttribute(report.id)}"`}
      aria-label="${escapeAttribute(`${report.title}. ${comingSoon ? 'Coming soon' : tooltip}`)}"
    >
      <span>${icon(reportIcon(report.id))}</span>
      <span>
        <strong><span class="analyticsHubCardTitle">${escapeHtml(report.title)}</span>${comingSoon ? ' <span class="analyticsComingSoonBadge">Coming Soon</span>' : ''}</strong>
      </span>
      <i class="analyticsHubReportInfo" aria-hidden="true">
        ${icon('info')}
        <span role="tooltip">${comingSoon ? 'Coming soon' : escapeHtml(tooltip)}</span>
      </i>
      ${comingSoon ? '' : `<em>${icon('chevronRight')}</em>`}
    </button>
  `;
}

function hubReportBentoClass(index = 0, count = 0) {
  if (index === 0) return 'analyticsHubBentoCard--feature';
  if (index === 1 || (count > 6 && index === 4)) return 'analyticsHubBentoCard--wide';
  if (count > 5 && index === 2) return 'analyticsHubBentoCard--tall';
  return 'analyticsHubBentoCard--standard';
}

function renderHubSidebar(analytics = {}, insights = null, popularReportId = '') {
  const source = analytics.source || {};
  const quickInsights = Array.isArray(insights) ? insights : buildHubInsights(source);
  const popularReports = [
    { id: 'ops_dashboard', title: 'Operations Dashboard', helper: 'Used 24 times this week' },
    { id: 'low_stock', title: 'Low Stock Alerts', helper: 'Used 18 times this week' },
    { id: 'stock', title: 'Stock On Hand', helper: 'Used 14 times this week' }
  ].map((report) => ({
    ...report,
    badge: report.id === popularReportId ? 'Popular' : ''
  }));
  return `
    <aside class="analyticsHubSidebar" aria-label="Reporting insights">
      <section class="analyticsHubSidePanel analyticsHubSidePanel--quick">
        <header>
          <h3>${icon('activity')} Quick Insights ${renderReportInfo('Live shortcuts into reports that usually need attention first.')}</h3>
          <span>Updated just now <i></i></span>
        </header>
        <div class="analyticsHubInsightList">
          ${quickInsights.map((item) => `
            <button type="button" data-analytics-report="${escapeAttribute(item.reportId)}" class="analyticsHubInsight analyticsTone-${escapeAttribute(item.tone)}">
              <span>${icon(item.icon)}</span>
              <span class="analyticsHubInsightText">
                <strong>${escapeHtml(item.label)}</strong>
                <small>View report ${icon('arrowRight')}</small>
              </span>
              <em>${escapeHtml(String(item.value))}</em>
            </button>
          `).join('')}
        </div>
      </section>

      <section class="analyticsHubSidePanel">
        <h3>${icon('activity')} Popular Reports ${renderReportInfo('Frequently used reporting views for fast operational review.')}</h3>
        <ol class="analyticsHubPopularList">
          ${popularReports.map((report, index) => `
            <li>
              <button type="button" data-analytics-report="${escapeAttribute(report.id)}">
                <span>${index + 1}</span>
                <strong>${escapeHtml(report.title)}</strong>
                <small>${escapeHtml(report.helper)}</small>
                ${report.badge ? `<em>${escapeHtml(report.badge)}</em>` : ''}
              </button>
            </li>
          `).join('')}
        </ol>
        <button type="button" class="analyticsHubTextLink" data-analytics-hub-category="advanced">
          View all popular reports ${icon('arrowRight')}
        </button>
      </section>

    </aside>
  `;
}

function buildHubInsights(source = {}) {
  const lowStockRows = buildAnalyticsReport(source, 'low_stock', {
    startDate: defaultStartDate(),
    endDate: todayLocal(),
    query: '',
    category: '',
    locationId: ''
  }).rows.filter((row) => row._low);
  const outOfStock = lowStockRows.filter((row) => parseNumber(row['Current Stock']) <= 0).length;
  const activePurchaseOrders = arrayValue(source.purchaseOrders).filter((order) => {
    const status = String(order.status || '').toLowerCase();
    return !['closed', 'cancelled', 'canceled', 'received', 'complete', 'completed'].includes(status);
  }).length;
  const weekStart = addDays(todayLocal(), -6);
  const adjustmentCount = arrayValue(source.logs_adj).filter((log) => {
    const date = String(log.date || log.timestamp || log.createdAt || '').slice(0, 10);
    return !date || date >= weekStart;
  }).length;
  return [
    { label: 'Low Stock Items', value: lowStockRows.length, reportId: 'low_stock', icon: 'warehouse', tone: 'orange' },
    { label: 'Items Out of Stock', value: outOfStock, reportId: 'low_stock', icon: 'trash', tone: 'red' },
    { label: 'Active Purchase Orders', value: activePurchaseOrders, reportId: 'purchase_orders', icon: 'file', tone: 'blue' },
    { label: 'Adjustments (This Week)', value: adjustmentCount, reportId: 'adj', icon: 'clipboard', tone: 'orange' }
  ];
}

function hubReportBadges(reportId = '', popularReportId = '') {
  const badges = [];
  if (reportId === 'low_stock') badges.push('Live');
  if (reportId && reportId === popularReportId) badges.push('Popular');
  return badges;
}

function hubGroupIcon(id = '') {
  if (id === 'inventory') return 'box';
  if (id === 'operations') return 'activity';
  if (id === 'sales') return 'cart';
  if (id === 'finance') return 'coin';
  if (id === 'executive') return 'star';
  if (id === 'advanced') return 'grid';
  return 'chart';
}

function renderCategorySection(category) {
  return `
    <section class="analyticsCategorySection analyticsTone-${category.tone}">
      <header>
        <h3>${icon(category.icon)} ${escapeHtml(category.title)} ${renderReportInfo(category.description || category.subtitle || `${category.title} report category.`)}</h3>
        <button type="button" data-analytics-category="${escapeAttribute(category.id)}" data-analytics-first-report="${escapeAttribute(category.reportItems[0]?.id || category.availableReports?.[0]?.id || '')}">View all ${category.reportItems.length || category.availableReports?.length || 0} reports ${icon('arrowRight')}</button>
      </header>
      <div>
        ${category.reportItems.map((report) => renderReportTile(report, category)).join('') || '<p>No matching reports in this category.</p>'}
      </div>
    </section>
  `;
}

function renderReportTile(report, category) {
  const comingSoon = report.id === 'custom_report';
  return `
    <button type="button" class="analyticsReportTile${comingSoon ? ' is-coming-soon' : ''}" ${comingSoon ? 'disabled' : `data-analytics-report="${escapeAttribute(report.id)}"`}>
      <span>${icon(reportIcon(report.id))}</span>
      <strong>${escapeHtml(report.title)}${comingSoon ? ' <span class="analyticsComingSoonBadge">Coming Soon</span>' : ''} ${comingSoon ? '' : renderReportInfo(report.description || reportShortDescription(report))}</strong>
      <small>${comingSoon ? 'Coming soon' : escapeHtml(reportShortDescription(report))}</small>
      ${comingSoon ? '' : `<em>${icon('chevronRight')}</em>`}
    </button>
  `;
}

function renderDateRangePicker(filters) {
  const startDate = filters.startDate || defaultStartDate();
  const endDate = filters.endDate || todayLocal();
  const isOpen = filters.openDropdown === 'dateRange';
  const mode = filters.rangePickerMode || 'days';
  const calendar = buildRangeCalendar(filters.rangePickerCursor || startDate, { startDate, endDate });
  const cursorDate = parseDateKey(filters.rangePickerCursor || startDate);
  const cursorYear = cursorDate.getFullYear();
  const cursorMonth = cursorDate.getMonth();
  return `
    <div class="analyticsDateRange" data-analytics-date-range-root>
      <span>Date Range</span>
      <button type="button" data-analytics-date-range aria-expanded="${isOpen}">
        ${icon('calendar')}
        <strong>${escapeHtml(`${formatDateLabel(startDate)} - ${formatDateLabel(endDate)}`)}</strong>
        ${icon('chevronDown')}
      </button>
      ${isOpen ? `
        <div class="analyticsDateRangePanel">
          <div class="analyticsDateRangeHead">
            <div>
              <h3>Select Report Range</h3>
              <p>${escapeHtml(rangePickerInstruction(filters, startDate, endDate))}</p>
            </div>
          </div>
          <div class="analyticsDateRangePresets">
            <button type="button" data-analytics-range-preset="ytd">Year to date</button>
            <button type="button" data-analytics-range-preset="lastYear">Last year</button>
            <button type="button" data-analytics-range-preset="7">Last 7 days</button>
            <button type="button" data-analytics-range-preset="30">Last 30 days</button>
            <button type="button" data-analytics-range-preset="90">Last 90 days</button>
          </div>
          <div class="analyticsRangeLegend">
            <span></span>
            <strong>${escapeHtml(`${formatRangePickerDate(startDate)} - ${formatRangePickerDate(endDate)}`)}</strong>
          </div>
          <div class="analyticsCalendarNav">
            <div>
              <button type="button" data-analytics-range-nav="-12" aria-label="Previous year">${icon('chevronDoubleLeft')}</button>
              <button type="button" data-analytics-range-nav="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
            </div>
            <div class="analyticsCalendarTitle">
              <button type="button" data-analytics-range-mode="months">${escapeHtml(monthName(cursorMonth))}</button>
              <button type="button" data-analytics-range-mode="years">${escapeHtml(String(cursorYear))}</button>
            </div>
            <div>
              <button type="button" data-analytics-range-nav="1" aria-label="Next month">${icon('chevronRight')}</button>
              <button type="button" data-analytics-range-nav="12" aria-label="Next year">${icon('chevronDoubleRight')}</button>
            </div>
          </div>
          ${mode === 'months' ? renderMonthPicker(cursorMonth) : mode === 'years' ? renderYearPicker(cursorYear) : renderCalendarDayGrid(calendar, startDate, endDate)}
          <div class="analyticsDateRangeFooter">
            <button type="button" data-analytics-range-today>Today</button>
            <button type="button" data-analytics-range-clear>Reset</button>
            <button type="button" data-analytics-range-apply>Apply Range</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderCalendarDayGrid(calendar, startDate, endDate) {
  return `
    <div class="analyticsCalendarGrid">
      ${calendar.weekdays.map((weekday) => `<span>${escapeHtml(weekday)}</span>`).join('')}
      ${calendar.days.map((day) => `
        <button
          type="button"
          class="${[
            day.inMonth ? '' : 'is-outside',
            day.date === startDate ? 'is-start' : '',
            day.date === endDate ? 'is-end' : '',
            day.date > startDate && day.date < endDate ? 'is-between' : '',
            day.date === todayLocal() ? 'is-today' : ''
          ].filter(Boolean).join(' ')}"
          data-analytics-range-day="${escapeAttribute(day.date)}"
        >
          ${day.day}
        </button>
      `).join('')}
    </div>
  `;
}

function renderMonthPicker(activeMonth) {
  return `
    <div class="analyticsMonthGrid" aria-label="Choose month">
      ${monthNamesShort().map((label, index) => `
        <button type="button" class="${index === activeMonth ? 'is-active' : ''}" data-analytics-range-month="${index}">
          ${escapeHtml(label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderYearPicker(activeYear) {
  const years = Array.from({ length: 12 }, (_, index) => activeYear - 5 + index);
  return `
    <div class="analyticsYearJump">
      <label>
        <span>YYYY</span>
        <input type="text" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" value="${escapeAttribute(String(activeYear))}" data-analytics-range-year-input />
      </label>
      <button type="button" data-analytics-range-year-apply>Go</button>
    </div>
    <div class="analyticsYearGrid" aria-label="Choose year">
      ${years.map((year) => `
        <button type="button" class="${year === activeYear ? 'is-active' : ''}" data-analytics-range-year="${year}">
          ${year}
        </button>
      `).join('')}
    </div>
  `;
}

function renderMetricCards(reportData, filters = {}) {
  const metrics = buildReportMetrics(reportData, filters);
  return `
    <div class="analyticsKpiGrid">
      ${metrics.map((metric) => {
        const Tag = metric.action ? 'button' : 'div';
        const actionAttributes = metric.action === 'menuGpFilter'
          ? ` type="button" data-analytics-menu-gp-filter="${escapeAttribute(metric.filterValue || '')}"`
          : '';
        return `
        <${Tag}${actionAttributes} class="analyticsKpiCard analyticsMetric-${metric.tone || 'blue'} ${metric.action ? 'analyticsKpiCard--button' : ''} ${metric.active ? 'is-active' : ''}">
          <span class="analyticsKpiIcon">${icon(metric.icon || 'clipboard')}</span>
          <span class="analyticsKpiLabel">${escapeHtml(metric.label)} ${renderReportInfo(metric.helper || metricHelperText(metric.label))}</span>
          <strong>${escapeHtml(metric.value)}</strong>
          <small>${escapeHtml(metric.helper || metricHelperText(metric.label))}</small>
        </${Tag}>
      `; }).join('')}
    </div>
  `;
}


function renderModernKpiStrip(reportData, filters = {}) {
  const metrics = buildReportMetrics(reportData, filters);
  return `
    <div class="analyticsKpiStrip">
      ${metrics.map((metric) => {
        const Tag = metric.action ? 'button' : 'div';
        const actionAttributes = metric.action === 'menuGpFilter'
          ? ` type="button" data-analytics-menu-gp-filter="${escapeAttribute(metric.filterValue || '')}"`
          : '';
        const isMoney = /cogs|value|impact|sales|net|gross|cost|revenue|profit|spend|total|amount|price/i.test(metric.label || '');
        return `
        <${Tag}${actionAttributes} class="analyticsKpiCell analyticsMetric-${metric.tone || 'blue'} ${isMoney ? 'analyticsKpiCell--money' : ''} ${metric.action ? 'analyticsKpiCell--button' : ''} ${metric.active ? 'is-active' : ''}">
          <span class="analyticsKpiCellLabel">${escapeHtml(metric.label)} ${renderReportInfo(metric.helper || metricHelperText(metric.label))}</span>
          <strong class="analyticsKpiCellValue">${escapeHtml(metric.value)}</strong>
        </${Tag}>`;
      }).join('')}
    </div>
  `;
}

function metricHelperText(label = '') {
  const normalized = String(label || '').toLowerCase();
  if (/rows|items|lines/.test(normalized)) return 'Report records';
  if (/value|sales|net|gross|impact|cost/.test(normalized)) return 'Total ex-VAT value';
  if (/location/.test(normalized)) return 'Active locations';
  if (/categor/.test(normalized)) return 'Item categories';
  if (/supplier/.test(normalized)) return 'Unique suppliers';
  if (/status/.test(normalized)) return 'Current status';
  return 'Report summary';
}

function renderReportBreakdownPanel(reportData) {
  const rows = reportData.rows || [];
  const groupColumn = breakdownColumnForReport(reportData);
  const groups = groupColumn
    ? buildBreakdownGroups(rows, groupColumn).slice(0, 6)
    : [];
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const colors = ['#60a5fa', '#34d399', '#a78bfa', '#fb923c', '#facc15', '#94a3b8'];
  let cursor = 0;
  const segments = groups.map((group, index) => {
    const start = cursor;
    const size = total ? (group.count / total) * 360 : 360;
    cursor += size;
    return `${colors[index % colors.length]} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`;
  }).join(', ') || `${colors[0]} 0deg 360deg`;

  return `
    <aside class="analyticsBreakdownPanel">
      <header>
        <div>
          <h2>${escapeHtml(groupColumn ? `By ${groupColumn}` : 'Report Breakdown')} ${renderReportInfo(groupColumn ? `Breakdown of this report grouped by ${groupColumn}.` : 'Quick breakdown of the current report rows.')}</h2>
          <span>By number of rows</span>
        </div>
      </header>
      <div class="analyticsDonut" style="--analytics-donut: ${escapeAttribute(segments)};">
        <strong>${escapeHtml(formatNumber(total || rows.length))}</strong>
        <span>Total</span>
      </div>
      <div class="analyticsBreakdownList">
        ${groups.map((group, index) => `
          <div style="--breakdown-color: ${colors[index % colors.length]};">
            <span>${escapeHtml(group.label)}</span>
            <strong>${escapeHtml(formatNumber(group.count))}</strong>
          </div>
        `).join('') || '<p>No breakdown available.</p>'}
      </div>
    </aside>
  `;
}

function breakdownColumnForReport(reportData) {
  const columns = reportData.columns || [];
  return ['Category', 'Location', 'Status', 'Type', 'Product Status', 'Tender', 'Supplier', 'Action', 'Area']
    .find((column) => columns.includes(column)) ||
    columns.find((column) => !/date|qty|quantity|value|cost|price|impact|net|gross|refund|sales|variance|stock|on hand|unit/i.test(column)) ||
    columns[0] ||
    '';
}

function buildBreakdownGroups(rows = [], column = '') {
  const groups = rows.reduce((map, row) => {
    const label = String(row[column] ?? 'Unspecified').trim() || 'Unspecified';
    map.set(label, (map.get(label) || 0) + 1);
    return map;
  }, new Map());
  return [...groups.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function buildReportMetrics(reportData, filters = {}) {
  const rows = reportData.rows || [];
  const first = rows[0] || {};
  const id = reportData.report.id;
  const base = [
    { label: 'Rows', value: formatNumber(rows.length), icon: 'clipboard', tone: 'blue' }
  ];

  if (id === 'ops_dashboard' && rows.length) {
    // KPI cards MUST equal the sum of the per-location table rows shown below.
    // Previously these read _combinedMetrics (a workspace-wide, non-location-filtered
    // Engine-B figure) which never reconciled with the per-location table. Now both
    // derive from the same rows and the same (last-purchase-price) unit cost.
    const columns = ['Purchases Ex', 'Opening Stock', 'Closing Stock', 'Cost Of Sales', 'Count Variance', 'Manual Adjustments', 'Wastage'];
    return columns.map((column, index) => ({
      label: column,
      value: formatMoney(sumRows(rows, column)),
      icon: ['cart', 'warehouse', 'box', 'coin', 'scale', 'activity', 'trash'][index] || fallbackMetricIcon(index),
      tone: ['green', 'blue', 'blue', 'purple', 'teal', 'orange', 'red'][index] || 'blue'
    }));
  }

  if (id === 'yoco_sales') {
    const refunds = rows.filter((row) => /refund/i.test(String(row['Sale / Refund'] || ''))).length;
    const sales = rows.length - refunds;
    return [
      ...base,
      { label: 'Sales Lines', value: formatNumber(sales), icon: 'cart', tone: 'green' },
      { label: 'Refund Lines', value: formatNumber(refunds), icon: 'file', tone: 'orange' },
      { label: 'Total Impact', value: formatMoney(sumRows(rows, 'Total Impact')), icon: 'coin', tone: 'purple' }
    ];
  }

  if (id === 'sale_movement') {
    return [
      ...base,
      { label: 'Products Sold', value: formatNumber(uniqueCount(rows, 'Product')), icon: 'cart', tone: 'green' },
      { label: 'Qty Sold', value: formatNumber(sumRows(rows, 'Qty Sold')), icon: 'activity', tone: 'blue' },
      { label: 'Recipe Lines', value: formatNumber(sumRows(rows, 'Recipe Lines')), icon: 'grid', tone: 'purple' },
      { label: 'COGS Ex', value: formatMoney(sumRows(rows, 'COGS Ex')), icon: 'coin', tone: 'orange' }
    ];
  }

  if (id === 'modifier_gp_detail' || id === 'modifier_gp_summary') {
    return [
      ...base,
      { label: 'Modifiers', value: formatNumber(uniqueCount(rows, 'Modifier')), icon: 'menu', tone: 'teal' },
      { label: 'Sales Ex', value: formatMoney(sumRows(rows, 'Sales Ex')), icon: 'cart', tone: 'green' },
      { label: 'COGS Ex', value: formatMoney(sumRows(rows, 'COGS Ex')), icon: 'coin', tone: 'orange' },
      { label: 'Average GP', value: `${averageRows(rows, 'GP %').toFixed(1)}%`, icon: 'chart', tone: gpMetricTone(averageRows(rows, 'GP %')) }
    ];
  }

  if (id === 'payments') {
    return [
      ...base,
      { label: 'Gross Sales', value: formatMoney(sumRows(rows, 'Gross Sales')), icon: 'cart', tone: 'green', helper: 'Takings excluding tips, VAT-inclusive.' },
      { label: 'Tips', value: formatMoney(sumRows(rows, 'Tips')), icon: 'coin', tone: 'blue', helper: 'Gratuities collected — pass-through to staff, excluded from Gross/Net.' },
      { label: 'Refunds', value: formatMoney(sumRows(rows, 'Refunds')), icon: 'file', tone: 'orange', helper: 'Refunded sales value (excl tips).' },
      { label: 'Tax Amount', value: formatMoney(sumRows(rows, 'Tax Amount')), icon: 'coin', tone: 'teal', helper: 'VAT portion of net takings (gross × 15/115).' },
      { label: 'Net (incl VAT)', value: formatMoney(sumRows(rows, 'Net (incl VAT)')), icon: 'coin', tone: 'purple', helper: 'Gross Sales − Refunds (VAT still included).' },
      { label: 'Net (ex-VAT)', value: formatMoney(sumRows(rows, 'Net (ex-VAT)')), icon: 'coin', tone: 'green', helper: 'Net (incl VAT) − Tax. Sales revenue excluding VAT, after refunds.' }
    ];
  }

  if (id === 'stock') {
    return [
      ...base,
      { label: 'Stock Value', value: formatMoney(sumRows(rows, 'Stock Value')), icon: 'warehouse', tone: 'green' },
      { label: 'Locations', value: formatNumber(uniqueCount(rows, 'Location')), icon: 'box', tone: 'blue' },
      { label: 'Categories', value: formatNumber(uniqueCount(rows, 'Category')), icon: 'grid', tone: 'purple' }
    ];
  }

  if (id === 'movement') {
    return [
      ...base,
      { label: 'Purchases', value: formatNumber(sumRows(rows, 'Purchases')), icon: 'cart', tone: 'green' },
      { label: 'Sales Usage', value: formatNumber(sumRows(rows, 'Sales Usage')), icon: 'activity', tone: 'purple' },
      { label: 'Wastage', value: formatNumber(sumRows(rows, 'Wastage')), icon: 'trash', tone: 'red' }
    ];
  }

  if (id === 'low_stock') {
    // Read mode-appropriate fields so the KPI cards reconcile with the visible table
    // in both View-by-Item (Total * columns) and View-by-Location (per-location columns).
    const rowDeficit = (row) => parseMoney(row['Deficit Value'] ?? row['Total Deficit Value']);
    const rowVariance = (row) => parseNumber(row.Variance ?? row['Total Variance']);
    return [
      ...base,
      { label: 'Deficit Value', value: formatMoney(rows.reduce((sum, row) => sum + rowDeficit(row), 0)), icon: 'trash', tone: 'red', helper: 'Shortfall below threshold valued at unit cost.' },
      { label: 'Worst Variance', value: formatNumber(Math.min(0, ...rows.map(rowVariance))), icon: 'activity', tone: 'orange', helper: 'Most-negative current − threshold across the view.' },
      { label: 'Items', value: formatNumber(rows.length), icon: 'box', tone: 'blue' }
    ];
  }

  if (['grv', 'cn', 'purchase_orders'].includes(id)) {
    return [
      ...base,
      { label: 'Items', value: formatNumber(sumRows(rows, 'Items')), icon: 'box', tone: 'blue' },
      { label: 'Total Ex', value: formatMoney(sumRows(rows, 'Total Ex')), icon: 'coin', tone: 'green' },
      { label: 'Suppliers', value: formatNumber(uniqueCount(rows, 'Supplier')), icon: 'warehouse', tone: 'purple' }
    ];
  }

  if (id === 'menu') {
    const averageGp = averageRows(rows, 'GP %');
    const gpRiskRows = menuGpRiskRows(rows);
    const gpFilterActive = String(filters.menuGpFilter || '') === 'below60';
    return [
      ...base,
      { label: 'Average GP', value: `${averageGp.toFixed(1)}%`, icon: 'chart', tone: gpMetricTone(averageGp) },
      {
        label: 'Critical / Low GP',
        value: formatNumber(gpRiskRows.length),
        icon: 'menu',
        tone: gpRiskRows.length ? 'orange' : 'green',
        helper: gpFilterActive ? 'Showing items below 60%' : 'Click to show below 60%',
        action: 'menuGpFilter',
        filterValue: 'below60',
        active: gpFilterActive
      },
      { label: 'Categories', value: formatNumber(uniqueCount(rows, 'Category')), icon: 'grid', tone: 'blue' },
      { label: 'Recipe Lines', value: formatNumber(sumRows(rows, 'Recipe Lines')), icon: 'menu', tone: 'purple' }
    ];
  }

  if (id === 'missing_recipes') {
    return [
      ...base,
      { label: 'Selling Value', value: formatMoney(sumRows(rows, 'Selling Price')), icon: 'coin', tone: 'orange' },
      { label: 'Categories', value: formatNumber(uniqueCount(rows, 'Category')), icon: 'grid', tone: 'blue' },
      { label: 'Status', value: rows[0]?.Status || 'Missing', icon: 'file', tone: 'red' }
    ];
  }

  if (id === 'ops_overview') {
    return [
      ...base,
      { label: 'Stock Value', value: formatMoney(sumRows(rows, 'Stock Value')), icon: 'warehouse', tone: 'green' },
      { label: 'Purchases', value: formatMoney(sumRows(rows, 'Purchases Ex')), icon: 'cart', tone: 'blue' },
      { label: 'Wastage', value: formatMoney(sumRows(rows, 'Wastage Ex')), icon: 'trash', tone: 'red' }
    ];
  }

  if (id === 'adj') {
    return [
      ...base,
      { label: 'Quantity', value: formatNumber(sumRows(rows, 'Quantity')), icon: 'activity', tone: 'blue' },
      { label: 'Impact Ex', value: formatMoney(sumRows(rows, 'Impact Ex')), icon: 'coin', tone: 'orange' },
      { label: 'Locations', value: formatNumber(uniqueCount(rows, 'Location')), icon: 'box', tone: 'purple' }
    ];
  }

  if (id === 'stocktake') {
    return [
      ...base,
      { label: 'Items Counted', value: formatNumber(sumRows(rows, 'Items Counted')), icon: 'clipboard', tone: 'blue' },
      { label: 'Variance Lines', value: formatNumber(sumRows(rows, 'Variance Lines')), icon: 'activity', tone: 'orange' },
      { label: 'Net Impact', value: formatMoney(sumRows(rows, 'Net Impact')), icon: 'coin', tone: 'purple' }
    ];
  }

  if (id === 'mfg') {
    return [
      ...base,
      { label: 'Expected', value: formatNumber(sumRows(rows, 'Expected')), icon: 'warehouse', tone: 'blue' },
      { label: 'Produced', value: formatNumber(sumRows(rows, 'Produced')), icon: 'box', tone: 'green' },
      { label: 'Variance', value: formatNumber(sumRows(rows, 'Variance')), icon: 'activity', tone: 'orange' }
    ];
  }

  if (id === 'transfers') {
    return [
      ...base,
      { label: 'Quantity', value: formatNumber(sumRows(rows, 'Quantity')), icon: 'activity', tone: 'blue' },
      { label: 'From Locations', value: formatNumber(uniqueCount(rows, 'From')), icon: 'box', tone: 'orange' },
      { label: 'To Locations', value: formatNumber(uniqueCount(rows, 'To')), icon: 'warehouse', tone: 'green' }
    ];
  }

  if (id === 'sync_log') {
    return [
      ...base,
      { label: 'Qty Sold', value: formatNumber(sumRows(rows, 'Qty Sold')), icon: 'cart', tone: 'green' },
      { label: 'COS Impact', value: formatMoney(sumRows(rows, 'COS Impact')), icon: 'coin', tone: 'purple' },
      { label: 'Products', value: formatNumber(uniqueCount(rows, 'Product')), icon: 'menu', tone: 'blue' }
    ];
  }

  if (id === 'sales_error_log') {
    return [
      ...base,
      { label: 'Types', value: formatNumber(uniqueCount(rows, 'Type')), icon: 'file', tone: 'orange' },
      { label: 'Products', value: formatNumber(uniqueCount(rows, 'Product')), icon: 'menu', tone: 'blue' },
      { label: 'Locations', value: formatNumber(uniqueCount(rows, 'Location')), icon: 'box', tone: 'purple' }
    ];
  }

  if (id === 'activity_log') {
    return [
      ...base,
      { label: 'Activity Types', value: formatNumber(uniqueCount(rows, 'Type')), icon: 'activity', tone: 'green' },
      { label: 'Actions', value: formatNumber(uniqueCount(rows, 'Action')), icon: 'clipboard', tone: 'blue' },
      { label: 'Users', value: formatNumber(uniqueCount(rows, 'User')), icon: 'warehouse', tone: 'purple' }
    ];
  }

  if (id === 'forecast') {
    const numericDays = rows.map((row) => parseNumber(row['Days Remaining'])).filter((value) => value > 0);
    return [
      ...base,
      { label: 'Avg Daily Usage', value: formatNumber(averageRows(rows, 'Avg Daily Usage')), icon: 'activity', tone: 'blue' },
      { label: 'Avg Days Left', value: numericDays.length ? formatNumber(numericDays.reduce((sum, value) => sum + value, 0) / numericDays.length) : 'No usage', icon: 'chart', tone: 'green' },
      { label: 'At Risk', value: formatNumber(numericDays.filter((value) => value <= 7).length), icon: 'trash', tone: 'red' }
    ];
  }

  if (id === 'variance') {
    return [
      ...base,
      { label: 'Actual Usage', value: formatNumber(sumRows(rows, 'Actual Usage')), icon: 'activity', tone: 'blue' },
      { label: 'Theoretical', value: formatNumber(sumRows(rows, 'Theoretical Usage')), icon: 'chart', tone: 'green' },
      { label: 'Loss Value', value: formatMoney(sumRows(rows, 'Loss Value')), icon: 'coin', tone: 'red' }
    ];
  }

  if (id === 'waste_pareto') {
    return [
      ...base,
      { label: 'Incidents', value: formatNumber(sumRows(rows, 'Incidents')), icon: 'trash', tone: 'red' },
      { label: 'Loss Value', value: formatMoney(sumRows(rows, 'Total Loss Value')), icon: 'coin', tone: 'orange' },
      { label: 'Reasons', value: formatNumber(uniqueCount(rows, 'Waste Reason')), icon: 'file', tone: 'blue' }
    ];
  }

  if (id === 'volatility') {
    return [
      ...base,
      { label: 'Qty Purchased', value: formatNumber(sumRows(rows, 'Qty Purchased')), icon: 'cart', tone: 'green' },
      { label: 'Avg Unit Cost', value: formatMoney(averageRows(rows, 'Unit Cost')), icon: 'coin', tone: 'purple' },
      { label: 'Suppliers', value: formatNumber(uniqueCount(rows, 'Supplier')), icon: 'warehouse', tone: 'blue' }
    ];
  }

  return [
    ...base,
    { label: 'Columns', value: formatNumber(reportData.columns.length), icon: 'grid', tone: 'blue' },
    { label: 'First Field', value: reportData.columns[0] || 'Report', icon: 'file', tone: 'purple' },
    { label: 'Updated', value: todayLocal(), icon: 'activity', tone: 'green' }
  ];
}

function renderReportSpotlight(reportData) {
  if (!reportData.rows.length) return '';

  if (reportData.report.id === 'ops_dashboard') return renderOpsDashboardSpotlight(reportData);
  if (reportData.report.id === 'stock') return renderRankedValueSpotlight(reportData, {
    title: 'Stock Value Overview',
    labelKey: 'Item',
    valueKey: 'Stock Value',
    helper: 'Highest-value stock items in this report.'
  });
  if (reportData.report.id === 'movement') return renderMovementSpotlight(reportData);
  if (reportData.report.id === 'low_stock') return renderRankedValueSpotlight(reportData, {
    title: 'Low Stock Exposure',
    labelKey: 'Item',
    valueKey: 'Deficit Value',
    helper: 'Largest deficit values from live stock levels.'
  });
  if (['grv', 'cn', 'purchase_orders', 'payments', 'yoco_sales'].includes(reportData.report.id)) return renderTimelineSpotlight(reportData);
  if (['menu', 'missing_recipes'].includes(reportData.report.id)) return renderMenuSpotlight(reportData);
  if (['forecast', 'variance', 'waste_pareto', 'volatility'].includes(reportData.report.id)) return renderRankedValueSpotlight(reportData, {
    title: 'Analysis Focus',
    labelKey: reportData.columns[0],
    valueKey: findCurrencyColumn(reportData.columns) || reportData.columns[reportData.columns.length - 1],
    helper: 'Top report lines from the selected live data.'
  });

  return renderTimelineSpotlight(reportData);
}

function renderOpsDashboardSpotlight(reportData) {
  // Aggregate across ALL location rows so the chart/summary matches the table
  // and the KPI cards (previously this read only rows[0] = the first location).
  const rows = reportData.rows || [];
  const sum = (column) => rows.reduce((total, row) => total + parseMoney(row[column]), 0);
  const bars = [
    { label: 'Opening Stock', value: sum('Opening Stock'), tone: 'blue' },
    { label: 'Purchases Ex', value: sum('Purchases Ex'), tone: 'green' },
    { label: 'Cost Of Sales', value: sum('Cost Of Sales'), tone: 'purple' },
    { label: 'Manual Adjustments', value: sum('Manual Adjustments'), tone: 'orange' },
    { label: 'Wastage', value: sum('Wastage'), tone: 'red' },
    { label: 'Closing Stock', value: sum('Closing Stock'), tone: 'blue' }
  ];
  const values = bars.map((bar) => Math.abs(bar.value));
  const max = Math.max(...values, 1);
  const opening = sum('Opening Stock');
  const closing = sum('Closing Stock');
  const delta = closing - opening;
  return `
    <section class="analyticsSpotlight">
      <header>
        <h2>Operational Summary</h2>
        <p>${delta === 0 ? 'Closing stock is equal to opening stock.' : `Net stock change is ${formatMoney(delta)}.`}</p>
      </header>
      <div class="analyticsMiniMetrics">
        ${bars.map((bar) => `
          <div>
            <span>${escapeHtml(bar.label)}</span>
            <strong>${escapeHtml(formatMoney(bar.value))}</strong>
          </div>
        `).join('')}
      </div>
      <div class="analyticsBarPanel">
        <h3>Stock Movement Overview</h3>
        <div class="analyticsBars">
          ${bars.map((bar) => `
            <div class="analyticsBarItem analyticsBar-${bar.tone}">
              <span>${escapeHtml(formatMoney(bar.value))}</span>
              <div style="--bar-size:${Math.max(2, (Math.abs(bar.value) / max) * 100).toFixed(2)}%"></div>
              <small>${escapeHtml(bar.label)}</small>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="analyticsInsightNote">
        ${icon('info')}
        <div>
          <strong>Net Change: ${escapeHtml(formatMoney(delta))}</strong>
          <span>${escapeHtml(delta === 0 ? 'Closing stock is equal to opening stock.' : 'Review purchases, wastage, and manual adjustments for the movement drivers.')}</span>
        </div>
      </div>
    </section>
  `;
}

function renderMovementSpotlight(reportData) {
  const totals = ['Purchases', 'Sales Usage', 'Wastage', 'Adjustments', 'Transfers Net'].map((key) => ({
    label: key,
    value: reportData.rows.reduce((sum, row) => sum + parseNumber(row[key]), 0)
  }));
  const max = Math.max(...totals.map((item) => Math.abs(item.value)), 1);
  return `
    <section class="analyticsSpotlight">
      <header>
        <h2>Movement Breakdown</h2>
        <p>Total movement by activity type from live stock logs.</p>
      </header>
      <div class="analyticsHorizontalBars">
        ${totals.map((item) => `
          <div>
            <span>${escapeHtml(item.label)}</span>
            <div><i style="width:${Math.max(2, Math.abs(item.value) / max * 100).toFixed(2)}%"></i></div>
            <strong>${escapeHtml(formatNumber(item.value))}</strong>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderTimelineSpotlight(reportData) {
  const dateKey = reportData.columns.includes('Date') ? 'Date' : reportData.columns[0];
  const grouped = new Map();
  reportData.rows.forEach((row) => {
    const key = row[dateKey] || 'Unspecified';
    grouped.set(key, (grouped.get(key) || 0) + 1);
  });
  const items = [...grouped.entries()].slice(0, 8).map(([label, value]) => ({ label, value }));
  const max = Math.max(...items.map((item) => item.value), 1);
  return `
    <section class="analyticsSpotlight">
      <header>
        <h2>Activity Timeline</h2>
        <p>Record volume by date for this report.</p>
      </header>
      <div class="analyticsHorizontalBars">
        ${items.map((item) => `
          <div>
            <span>${escapeHtml(item.label)}</span>
            <div><i style="width:${Math.max(4, item.value / max * 100).toFixed(2)}%"></i></div>
            <strong>${escapeHtml(String(item.value))}</strong>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderMenuSpotlight(reportData) {
  const gpRows = reportData.rows
    .map((row) => ({
      label: row['Menu Item'] || row.Category || 'Menu Item',
      value: parseNumber(row['GP %']),
      detail: row.Classification || row['Recipe Lines'] || row.Status || ''
    }))
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const max = Math.max(...gpRows.map((row) => Math.abs(row.value)), 1);
  return `
    <section class="analyticsSpotlight">
      <header>
        <h2>Menu Performance</h2>
        <p>Highest GP or classification lines from the current report.</p>
      </header>
      <div class="analyticsHorizontalBars">
        ${gpRows.map((row) => `
          <div>
            <span>${escapeHtml(row.label)}</span>
            <div><i style="width:${Math.max(4, Math.abs(row.value) / max * 100).toFixed(2)}%"></i></div>
            <strong>${escapeHtml(row.detail || `${row.value.toFixed(1)}%`)}</strong>
          </div>
        `).join('') || '<p>No GP rows are available for this menu report.</p>'}
      </div>
    </section>
  `;
}

function renderRankedValueSpotlight(reportData, { title, labelKey, valueKey, helper }) {
  const rows = reportData.rows
    .map((row) => ({
      label: row[labelKey] || row[reportData.columns[0]] || 'Report line',
      value: parseMoney(row[valueKey]) || parseNumber(row[valueKey])
    }))
    .filter((row) => Number.isFinite(row.value) && row.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 8);
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1);
  return `
    <section class="analyticsSpotlight">
      <header>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(helper)}</p>
      </header>
      <div class="analyticsHorizontalBars">
        ${rows.map((row) => `
          <div>
            <span>${escapeHtml(row.label)}</span>
            <div><i style="width:${Math.max(4, Math.abs(row.value) / max * 100).toFixed(2)}%"></i></div>
            <strong>${escapeHtml(formatMaybeMoney(row.value, valueKey))}</strong>
          </div>
        `).join('') || '<p>No measurable values are available for this report.</p>'}
      </div>
    </section>
  `;
}

function renderDropdown({ id, label, selectedValue, options, openDropdown }) {
  const selected = options.find((option) => String(option.value) === String(selectedValue)) || options[0];
  const isOpen = openDropdown === id;
  return `
    <label class="analyticsDropdownLabel">
      <span>${escapeHtml(label)} ${renderReportInfo(dropdownTooltip(id, label))}</span>
      <div class="analyticsDropdown ${isOpen ? 'is-open' : ''}" data-analytics-dropdown-root>
        <button type="button" data-analytics-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
          <strong>${escapeHtml(selected?.label || 'All')}</strong>
          ${icon('chevronDown')}
        </button>
        <div class="analyticsDropdownMenu">
          ${options.map((option) => `
            <button
              type="button"
              data-analytics-option
              data-analytics-option-field="${escapeAttribute(id)}"
              data-analytics-option-value="${escapeAttribute(option.value)}"
              class="${String(option.value) === String(selectedValue) ? 'is-active' : ''}"
            >
              ${escapeHtml(option.label)}
            </button>
          `).join('')}
        </div>
      </div>
    </label>
  `;
}


function renderTableHeaderCell(column, reportData = {}, filters = {}) {
  if (reportData.report?.id === 'low_stock' && column === 'Select') {
    const rows = lowStockSelectableRows(reportData.rows || []);
    const selected = new Set(arrayValue(filters.lowStockSelectedIds));
    const rowKeys = rows.map(lowStockRowKey).filter(Boolean);
    const checked = rowKeys.length > 0 && rowKeys.every((key) => selected.has(key));
    return `
      <th class="analyticsSelectColumn">
        <input
          type="checkbox"
          data-analytics-low-stock-select-all
          ${checked ? 'checked' : ''}
          aria-label="Select all low-stock rows"
        />
      </th>
    `;
  }
  return `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip(reportData, column))}</th>`;
}

function dropdownTooltip(id = '', label = '') {
  const key = String(id || label || '').toLowerCase();
  if (key.includes('date') || key.includes('range')) return 'Choose the period included in this report.';
  if (key.includes('category')) return 'Filter the report to one stock, menu, or operational category.';
  if (key.includes('location')) return 'Filter the report to one storage or selling location.';
  if (key.includes('supplier')) return 'Filter the report to one supplier where supplier data is available.';
  if (key.includes('item')) return 'Filter the report to one stock or menu item.';
  if (key.includes('page')) return 'Choose how many rows appear on each page.';
  if (key.includes('source')) return 'Choose the live data source used by this report.';
  if (key.includes('visual')) return 'Choose how the report is displayed.';
  if (key.includes('group')) return 'Choose how matching rows are grouped for charts and summaries.';
  return `Choose a ${label || 'filter'} value for this report.`;
}

function columnTooltip(reportData = {}, column = '') {
  const reportTitle = reportData.report?.title || 'this report';
  const normalized = String(column || '').toLowerCase();
  if (normalized === 'action') return 'Available actions for this row, such as viewing details or starting the linked workflow.';
  if (normalized.includes('date')) return `Date attached to this ${reportTitle} row.`;
  if (normalized.includes('time')) return `Time attached to this ${reportTitle} row.`;
  if (normalized.includes('user')) return 'User recorded on the source transaction or activity log.';
  if (normalized.includes('location')) return 'Storage or selling location linked to the row.';
  if (normalized.includes('supplier')) return 'Supplier linked to the row or transaction.';
  if (normalized.includes('category')) return 'Category used for grouping, filtering, and analysis.';
  if (normalized.includes('uom') || normalized === 'unit') return 'Unit of measure used for quantities in this row. Custom UOM config shows conversion back to the base unit.';
  if (normalized.includes('item') || normalized.includes('product') || normalized.includes('ingredient')) return 'Item, product, or ingredient represented by this row.';
  // Specific metric explanations (checked before the generic quantity/money fallbacks).
  if (normalized.includes('cos actual')) return 'Cost of Sales (Actual): actual stock used (sales usage + wastage) valued at last-purchase unit cost.';
  if (normalized.includes('cos theoretical')) return 'Cost of Sales (Theoretical): stock the recipes say should have been used, valued at unit cost.';
  if (normalized.includes('cos difference')) return 'COS Actual − COS Theoretical. Positive = more stock used than recipes predict (possible loss/over-portioning).';
  if (normalized === 'net (ex-vat)' || normalized === 'net ex-vat') return 'Net (ex-VAT) = Net (incl VAT) − Tax. Sales revenue excluding VAT, after refunds.';
  if (normalized.includes('net (incl') || normalized === 'net') return 'Net (incl VAT) = Gross Sales − Refunds. Tips are excluded from both.';
  if (normalized.includes('gross')) return 'Gross Sales = takings excluding tips, VAT-inclusive.';
  if (normalized === 'tips' || normalized.includes('tip')) return 'Gratuities collected. Pass-through to staff — excluded from Gross and Net.';
  if (normalized.includes('tax')) return 'VAT portion of net takings, derived VAT-inclusively (gross × 15/115).';
  if (normalized.includes('deficit')) return 'Low-stock deficit value = shortfall below threshold (max(0, threshold − current)) valued at unit cost.';
  if (normalized.includes('draft quantity') || normalized.includes('reorder')) return 'Suggested reorder quantity to bring stock back to threshold = Σ max(0, threshold − current).';
  if (normalized.includes('variance')) return 'Variance = current stock − threshold. Negative means below the low-stock threshold.';
  if (normalized.includes('quantity') || normalized.includes('qty') || normalized.includes('stock') || normalized.includes('threshold')) return 'Quantity value for the selected item, location, and date range.';
  if (normalized.includes('cost') || normalized.includes('value') || normalized.includes('impact') || normalized.includes('sales')) return 'Money value calculated from the selected report range and filters.';
  if (normalized.includes('status') || normalized.includes('risk') || normalized.includes('classification')) return 'Status or risk label calculated for this report row.';
  return `${column} field used in the ${reportTitle} report.`;
}

function renderReportActionsDropdown(openDropdown) {
  const isOpen = openDropdown === 'reportActions';
  // Single, clearly-labelled Export menu (was a redundant "Actions" menu alongside a
  // standalone Export button, both only exporting). Exports the current filtered view.
  return `
    <div class="analyticsActionsDropdown analyticsDropdown ${isOpen ? 'is-open' : ''}" data-analytics-dropdown-root>
      <button type="button" data-analytics-dropdown="reportActions" aria-expanded="${isOpen}">
        ${icon('download')}
        <strong>Export</strong>
        ${icon('chevronDown')}
      </button>
      <div class="analyticsDropdownMenu analyticsActionsMenu">
        <button type="button" data-analytics-export="csv">${icon('file')} Export CSV</button>
        <button type="button" data-analytics-export="xlsx">${icon('sheet')} Export Excel</button>
        <button type="button" data-analytics-export="pdf">${icon('pdf')} Export PDF</button>
      </div>
    </div>
  `;
}

function renderTableCell(column, value, row = {}, reportId = '') {
  if (reportId === 'stock' && column === 'Action') {
    const detailRows = row._detailRows || [];
    if (detailRows.length <= 1 || Number(row._locationCount || 0) <= 1) return '<td></td>';
    const groupKey = row._groupKey || stockOnHandGroupKey(row);
    return `
      <td>
        <button
          type="button"
          class="analyticsInlineAction analyticsInlineAction--compact"
          data-analytics-stock-expand="${escapeAttribute(groupKey)}"
          aria-expanded="${row._expanded ? 'true' : 'false'}"
          aria-label="${row._expanded ? 'Hide' : 'Show'} location breakdown for ${escapeAttribute(row.Item || 'stock item')}"
        >
          ${icon(row._expanded ? 'chevronDown' : 'chevronRight')} Locations
        </button>
      </td>
    `;
  }

  if (reportId === 'low_stock' && column === 'Select') {
    const detailRows = row._detailRows || [];
    const selectedKeys = detailRows.map(lowStockRowKey).filter(Boolean);
    const key = lowStockRowKey(row);
    const checked = detailRows.length
      ? selectedKeys.length > 0 && selectedKeys.every((rowKey) => row._selectedKeys?.has?.(rowKey) || row._selected === true)
      : row._selected;
    return `
      <td class="analyticsSelectColumn">
        <input
          type="checkbox"
          ${detailRows.length ? `data-analytics-low-stock-select-group="${escapeAttribute(selectedKeys.join('|'))}"` : `data-analytics-low-stock-select="${escapeAttribute(key)}"`}
          ${checked ? 'checked' : ''}
          aria-label="Select ${escapeAttribute(row.Item || 'low-stock item')}"
        />
      </td>
    `;
  }

  if (reportId === 'low_stock' && column === 'Action') {
    const detailRows = row._detailRows || [];
    const groupKey = row._groupKey || lowStockRowKey(row);
    if (detailRows.length > 1) {
      return `
        <td>
          <div class="analyticsLowStockActions">
            <button
              type="button"
              class="analyticsInlineAction analyticsInlineAction--ghost"
              data-analytics-low-stock-expand="${escapeAttribute(groupKey)}"
            >
              ${icon(row._expanded ? 'chevronDown' : 'chevronRight')} View store breakdown
            </button>
            <button
              type="button"
              class="analyticsInlineAction"
              data-analytics-low-stock-reorder-modal="${escapeAttribute(groupKey)}"
            >
              ${icon('cart')} Reorder for selected stores
            </button>
          </div>
        </td>
      `;
    }
    const rowKey = detailRows[0] ? lowStockRowKey(detailRows[0]) : lowStockRowKey(row);
    const scopedRow = detailRows[0] || row;
    return `
      <td>
        <button
          type="button"
          class="analyticsInlineAction"
          data-analytics-low-stock-grv
          data-low-stock-row-key="${escapeAttribute(rowKey)}"
          data-low-stock-item-id="${escapeAttribute(scopedRow._id || scopedRow.id || scopedRow.Item || '')}"
          data-low-stock-location="${escapeAttribute(scopedRow.Location || '')}"
        >
          ${icon('cart')} Reorder
        </button>
      </td>
    `;
  }

  if (reportId === 'grv' && column === 'Action') {
    return `
      <td>
        <button
          type="button"
          class="analyticsIconAction"
          data-grv-view="${escapeAttribute(row._detailId || row.Invoice || row.id || '')}"
          aria-label="View GRV"
          title="View GRV"
        >
          ${icon('more')}
        </button>
      </td>
    `;
  }

  if (reportId === 'cn' && column === 'Action') {
    return `
      <td>
        <button
          type="button"
          class="analyticsIconAction"
          data-credit-note-view="${escapeAttribute(row._detailId || row.Reference || row.id || '')}"
          aria-label="View credit note"
          title="View credit note"
        >
          ${icon('more')}
        </button>
      </td>
    `;
  }

  if (reportId === 'purchase_orders' && column === 'Action') {
    return `
      <td>
        <button
          type="button"
          class="analyticsIconAction"
          data-purchase-order-view="${escapeAttribute(row._detailId || row.Reference || row.id || '')}"
          aria-label="View purchase order"
          title="View purchase order"
        >
          ${icon('more')}
        </button>
      </td>
    `;
  }

  if (reportId === 'stocktake' && column === 'Action') {
    return `
      <td>
        <button
          type="button"
          class="analyticsIconAction"
          data-stocktake-view="${escapeAttribute(row._detailId || row.id || row.Date || '')}"
          aria-label="View stock take count"
          title="View stock take count"
        >
          ${icon('more')}
        </button>
      </td>
    `;
  }

  if (reportId === 'yoco_sales' && column === 'Action') {
    return `
      <td>
        <button
          type="button"
          class="analyticsIconAction"
          data-yoco-order-view="${escapeAttribute(row._rowId || row._orderKey || '')}"
          aria-label="View Yoco order"
          title="View order summary"
        >
          ${icon('more')}
        </button>
      </td>
    `;
  }

  if (reportId === 'sale_movement' && column === 'Action') {
    return `
      <td>
        <button
          type="button"
          class="analyticsIconAction"
          data-sale-movement-view="${escapeAttribute(row._detailId || `${row.Date || ''}-${row.Product || ''}`)}"
          aria-label="View sale recipe costing"
        >
          ${icon('more')}
        </button>
      </td>
    `;
  }

  if (reportId === 'yoco_sales' && column === 'Total Impact') {
    const numeric = column === 'Total Impact' ? parseMoney(value) : parseNumber(value);
    const toneClass = numeric < 0 ? 'analyticsMoneyOut' : 'analyticsMoneyIn';
    const displayValue = formatSignedMoney(value);
    return `<td><span class="analyticsMoneyBadge ${toneClass}">${escapeHtml(displayValue ?? '')}</span></td>`;
  }

  if (reportId === 'yoco_sales' && column === 'Qty Sold') {
    const numeric = parseNumber(value);
    const toneClass = numeric < 0 ? 'analyticsMoneyOut' : 'analyticsMoneyIn';
    return `<td><span class="analyticsMoneyBadge ${toneClass}">${renderUnitValue(column, value, row)}</span></td>`;
  }

  if (reportId === 'ops_overview' && column === 'Low Stock Items') {
    const count = Number(row._lowStockCount ?? value ?? 0) || 0;
    return `
      <td>
        <span class="analyticsCountAction">
          <strong>${escapeHtml(String(count))}</strong>
          ${count > 0 ? `
            <button
              type="button"
              class="analyticsIconAction"
              data-analytics-low-stock-drill
              data-analytics-low-stock-category="${escapeAttribute(row._lowStockCategory || row.Category || '')}"
              data-analytics-low-stock-location-id="${escapeAttribute(row._lowStockLocationId || '')}"
              aria-label="View low stock items for ${escapeAttribute(row.Category || 'this category')}"
              title="View low stock items"
            >
              ${icon('eye')}
            </button>
          ` : ''}
        </span>
      </td>
    `;
  }

  if ((reportId === 'menu' || reportId === 'missing_recipes') && column === 'Recipe') {
    return '<td></td>';
  }

  if (reportId === 'menu' && column === 'GP %' && row._missingRecipe) {
    return `<td>${renderMissingRecipeActionBadge(row)}</td>`;
  }

  if (reportId === 'missing_recipes' && column === 'Status') {
    return `<td>${renderMissingRecipeActionBadge(row)}</td>`;
  }

  if (isGpColumn(column)) {
    const numeric = parseNumber(value);
    return `<td><span class="analyticsGpBadge ${gpToneClass(numeric)}">${escapeHtml(formatPercentValue(value))}</span></td>`;
  }

  if (isQuantityCell(column, value, row, reportId)) {
    return `<td>${renderUnitValue(column, value, row)}</td>`;
  }

  const statusKey = String(column || '').trim().toLowerCase();
  if ((statusKey === 'status' || statusKey === 'product status') && value != null && String(value).trim() !== '') {
    const raw = String(value).trim();
    const tone = /active|synced|received|complete|counted|ok|in stock|healthy|posted|paid/i.test(raw) ? 'good'
      : /depleted|out|error|failed|missing|overdue|critical|rejected/i.test(raw) ? 'bad'
      : /low|pending|partial|draft|review|warning|attention/i.test(raw) ? 'warn'
      : 'neutral';
    return `<td><span class="analyticsStatusPill" data-tone="${tone}"><span class="analyticsStatusDot"></span>${escapeHtml(raw)}</span></td>`;
  }

  const displayValue = isCurrencyCell(column, value)
    ? formatCurrencyCellValue(value)
    : value;
  return `<td>${escapeHtml(displayValue ?? '')}</td>`;
}

function renderUnitValue(column, value, row = {}) {
  const displayValue = String(value ?? '').trim();
  const unit = reportRowUnit(row);
  const tooltip = unit ? `${column}: ${displayValue} ${unit}` : `${column}: ${displayValue}`;
  return `
    <span class="analyticsUnitValue" data-tooltip="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}">
      <span>${escapeHtml(displayValue)}</span>
      ${unit ? `<em>${escapeHtml(unit)}</em>` : ''}
    </span>
  `;
}

function isQuantityCell(column, value, row = {}, reportId = '') {
  const unit = reportRowUnit(row);
  if (!unit) return false;
  if (value === null || value === undefined || value === '') return false;
  const key = String(column || '').trim().toLowerCase();
  if (!key || key === 'unit' || key === 'uom') return false;
  if (/date|status|action|reason|source|note|location|category|supplier|invoice|item|product|ingredient|mode|type|from|to|user|summary|order/.test(key)) return false;
  if (/cost|value|impact|price|sales price|refund|net impact|loss|gp|percent|%/.test(key)) return false;
  if (/rows|lines|items counted|low stock items|locations|categories|suppliers|products|orders|counted|active/.test(key)) return false;
  return /(qty|quantity|stock|threshold|variance|purchase|sales usage|wastage|adjustment|transfer|expected|produced|depleted|sold|usage|on hand|current|theoretical|actual)/.test(key)
    || (reportId === 'movement' && ['purchases', 'sales usage', 'wastage', 'adjustments', 'transfers net', 'net qty'].includes(key));
}

function reportRowUnit(row = {}) {
  return String(row.Unit || row.UOM || row.uom || row.unit || row._unit || '').trim();
}

function selectedLowStockRows(reportData = {}, filters = {}) {
  if (reportData.report?.id !== 'low_stock') return [];
  const selected = new Set(arrayValue(filters.lowStockSelectedIds));
  if (!selected.size) return [];
  return lowStockSelectableRows(reportData.rows || []).filter((row) => selected.has(lowStockRowKey(row)));
}

function lowStockSelectableRows(rows = []) {
  return rows.flatMap((row) => row?._detailRows?.length ? row._detailRows : [row])
    .filter((row) => row && row._selectable !== false && !row._isSummary);
}

function lowStockRowKey(row = {}) {
  return [
    row._id || row.id || row.stockItemId || row.Item || row.name || '',
    row._locationId || row.locationId || row.Location || row.locationName || ''
  ].map((value) => String(value || '').trim()).join('::');
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

// Flatten each report's drill-down/action data into extra export sheet(s) so the
// export carries the same detail shown in the on-screen action modals — not just
// the flat table. Returns [{ name, columns, rows }] (empty when a report has none).
function buildReportDetailSheets(reportData = {}, exportRows = null) {
  const id = reportData.report?.id;
  const rows = exportRows || reportData.rows || [];

  if (id === 'waste_pareto') {
    const detail = rows.flatMap((row) => arrayValue(row._events).map((event) => ({
      Reason: row.Reason || row['Waste Reason'] || '',
      User: row.User || event.User || '',
      Date: event.Date || '',
      Time: event.Time || '',
      Item: event.Item || '',
      Category: event.Category || '',
      Location: event.Location || '',
      Quantity: event.Quantity ?? '',
      'Loss Value': event['Loss Value'] ?? '',
      Note: event.Note || ''
    })));
    if (detail.length) {
      return [{ name: 'Wastage Events', columns: ['Reason', 'User', 'Date', 'Time', 'Item', 'Category', 'Location', 'Quantity', 'Loss Value', 'Note'], rows: detail }];
    }
  }

  if (id === 'volatility') {
    const detail = rows.flatMap((row) => arrayValue(row._history).map((entry) => ({
      Item: row.Item || '',
      Supplier: entry.Supplier || row.Supplier || '',
      Date: entry.Date || '',
      'Qty Purchased': entry['Qty Purchased'] || '',
      'Unit Cost': entry['Unit Cost'] || '',
      Change: entry.Change || ''
    })));
    if (detail.length) {
      return [{ name: 'Price History', columns: ['Item', 'Supplier', 'Date', 'Qty Purchased', 'Unit Cost', 'Change'], rows: detail }];
    }
  }

  if (id === 'ops_category_overview' || id === 'ops_category_detail') {
    const detail = rows.flatMap((row) => arrayValue(row._detailRows).map((line) => ({
      'Inventory Category': row['Inventory Category'] || row._category || '',
      ...line
    })));
    if (detail.length) {
      return [{ name: 'Category Detail', columns: ['Inventory Category', 'Item', 'Unit', 'Opening Stock Value', 'Purchases', 'Closing Stock Value', 'COS Actual', 'COS Theoretical', 'COS Difference'], rows: detail }];
    }
  }

  return [];
}

function buildReportExportSummary(reportData = {}, filters = {}) {
  const rows = reportData.rows || [];
  const startDate = filters.startDate || defaultStartDate();
  const endDate = filters.endDate || todayLocal();
  const summary = [
    { label: 'Report', value: reportData.report?.title || 'Report' },
    { label: 'Date Range', value: `${formatRangePickerDate(startDate)} - ${formatRangePickerDate(endDate)}` },
    { label: 'Location', value: exportFilterLabel(rows, 'Location', filters.locationId, 'All Locations') },
    { label: 'Category', value: exportFilterLabel(rows, 'Category', filters.category, 'All Categories') },
    { label: 'Rows', value: formatNumber(rows.length) },
    { label: 'Generated', value: new Date().toLocaleString('en-ZA') }
  ];

  buildReportMetrics(reportData).slice(0, 4).forEach((metric) => {
    if (!metric?.label) return;
    summary.push({ label: metric.label, value: metric.value ?? '' });
  });

  const total = exportPrimaryTotal(reportData);
  if (total) summary.push(total);
  return dedupeSummaryRows(summary);
}

function exportFilterLabel(rows = [], key = '', filterValue = '', fallback = 'All') {
  if (filterValue) {
    const labels = [...new Set(rows.map((row) => String(row[key] || '').trim()).filter(Boolean))];
    if (labels.length === 1) return labels[0];
    if (labels.length > 1) return labels.join(', ');
    return String(filterValue);
  }
  return fallback;
}

function exportPrimaryTotal(reportData = {}) {
  const rows = reportData.rows || [];
  const columns = reportData.columns || [];
  const moneyColumn = columns.find((column) => /stock value|total impact|net impact|total ex|impact ex|loss value|sales|refund|net|cost|value|purchase|wastage/i.test(column));
  if (moneyColumn) return { label: `Total ${moneyColumn}`, value: formatMoney(sumRows(rows, moneyColumn)) };
  const numericColumn = columns.find((column) => /qty|quantity|on hand|current stock|expected|produced|variance|purchases|usage|adjustments|transfers/i.test(column));
  if (numericColumn) return { label: `Total ${numericColumn}`, value: formatNumber(sumRows(rows, numericColumn)) };
  return null;
}

function dedupeSummaryRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = String(row.label || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getYocoOrderSummary(rows = [], selectedRowId = '') {
  const selected = rows.find((row) => String(row._rowId || '') === String(selectedRowId || ''));
  if (!selected) return null;
  const orderKey = selected._orderKey || selected._orderId || selected._rowId;
  const orderRows = rows.filter((row) => String(row._orderKey || row._orderId || row._rowId) === String(orderKey));
  const total = orderRows.reduce((sum, row) => sum + parseMoney(row['Total Impact']), 0);
  const qty = orderRows.reduce((sum, row) => sum + parseNumber(row['Qty Sold']), 0);
  return {
    orderId: selected._orderId || 'N/A',
    date: selected.Date || '',
    location: selected.Location || 'Unspecified',
    type: selected['Sale / Refund'] || '',
    total,
    qty,
    rows: orderRows
  };
}

function getSaleMovementSummary(rows = [], selectedId = '') {
  const selected = rows.find((row) => String(row._detailId || '') === String(selectedId || ''));
  if (!selected) return null;
  const lines = arrayValue(selected._recipeLines);
  return {
    id: selected._detailId || '',
    date: selected.Date || '',
    product: selected.Product || 'Sale item',
    status: selected['Product Status'] || '',
    location: selected.Location || '',
    qtySold: selected['Qty Sold'] || '0',
    recipeLines: lines.length,
    qtyDepleted: selected['Qty Depleted'] || '0',
    cogs: parseMoney(selected['COGS Ex']),
    lines
  };
}

function getCreditNoteSummary(rows = [], selectedId = '') {
  const selected = rows.find((row) => String(row._detailId || row.Reference || '') === String(selectedId || ''));
  if (!selected) return null;
  const raw = selected._raw || {};
  const lines = arrayValue(raw.items).map((line) => {
    const orderedQty = parseNumber(line.orderedQty ?? line.orderQty ?? line.receivedQty ?? line.qty ?? line.quantity);
    const quantity = parseNumber(line.baseQuantity ?? line.returnedQty ?? line.packQty ?? line.qty ?? line.quantity);
    const packSize = parseNumber(line.packSize ?? line.pack_size ?? 1) || 1;
    const unitCost = parseNumber(line.unitCost ?? line.costEx ?? line.cost ?? line.price);
    const totalEx = parseMoney(line.lineTotalEx ?? (quantity * unitCost));
    return {
      Item: line.stockItemName || line.itemName || line.name || line.ingredientName || 'Stock item',
      Location: line.locationName || raw.locationName || selected.Location || 'Main Store',
      'Ordered Qty': `${formatNumber(orderedQty || quantity)}${line.unit ? ` ${line.unit}` : ''}`,
      'Returned Qty': `${formatNumber(quantity)}${line.unit ? ` ${line.unit}` : ''}`,
      'Pack Size': formatNumber(packSize),
      'Unit Cost': formatMoney(unitCost),
      'Total Ex': formatMoney(totalEx)
    };
  });
  return {
    id: raw.id || selected._detailId || selected.Reference,
    reference: raw.cnNumber || raw.creditNoteNumber || raw.number || raw.invoice || selected.Reference || '',
    date: selected.Date || raw.date || '',
    supplier: selected.Supplier || raw.supplierName || raw.supplier || '',
    location: selected.Location || raw.locationName || 'Main Store',
    user: selected.User || raw.createdByName || raw.submittedByName || raw.createdByEmail || raw.createdBy || '',
    reason: raw.notes || raw.reason || '',
    totalEx: parseMoney(selected['Total Ex'] ?? raw.totalEx),
    lines
  };
}

function getGrvSummary(rows = [], selectedId = '') {
  const selected = rows.find((row) => String(row._detailId || row.Invoice || '') === String(selectedId || ''));
  if (!selected) return null;
  const raw = selected._raw || {};
  const lines = arrayValue(raw.items).map((line) => {
    const orderedQty = parseNumber(line.orderedQty ?? line.orderQty ?? line.qty ?? line.quantity ?? line.receivedQty);
    const receivedQty = parseNumber(line.receivedQty ?? line.baseQuantity ?? line.qty ?? line.quantity ?? orderedQty);
    const packSize = parseNumber(line.packSize ?? line.pack_size ?? 1) || 1;
    const unitCost = parseNumber(line.unitCost ?? line.costEx ?? line.cost ?? line.price);
    const totalEx = parseMoney(line.lineTotalEx ?? line.totalEx ?? (receivedQty * unitCost));
    return {
      Item: line.stockItemName || line.itemName || line.name || line.ingredientName || 'Stock item',
      Location: line.locationName || raw.locationName || selected.Location || 'Main Store',
      'Ordered Qty': `${formatNumber(orderedQty || receivedQty)}${line.unit ? ` ${line.unit}` : ''}`,
      'Received Qty': `${formatNumber(receivedQty)}${line.unit ? ` ${line.unit}` : ''}`,
      'Pack Size': formatNumber(packSize),
      'Unit Cost': formatMoney(unitCost),
      'Total Ex': formatMoney(totalEx)
    };
  });
  return {
    id: raw.id || selected._detailId || selected.Invoice,
    invoice: selected.Invoice || raw.invoice || raw.grvNumber || raw.reference || '',
    poNumber: raw.poNumber || raw.purchaseOrderNumber || '',
    sourcePoId: raw.sourcePoId || raw.purchaseOrderId || '',
    date: selected.Date || raw.date || '',
    supplier: selected.Supplier || raw.supplierName || raw.supplier || '',
    location: selected.Location || raw.locationName || 'Main Store',
    user: selected.User || raw.createdByName || raw.submittedByName || raw.createdByEmail || raw.userEmail || raw.createdBy || '',
    notes: raw.notes || '',
    totalEx: parseMoney(selected['Total Ex'] ?? raw.totalEx),
    lines
  };
}

function getPurchaseOrderSummary(rows = [], selectedId = '') {
  const selected = rows.find((row) => String(row._detailId || row.Reference || '') === String(selectedId || ''));
  if (!selected) return null;
  const raw = selected._raw || {};
  const grvs = arrayValue(selected._grvs).map((grv) => getGrvLikeSummary(grv, selected));
  const lines = arrayValue(raw.items).map((line) => {
    const orderedQty = parseNumber(line.qty ?? line.quantity ?? line.orderQty ?? line.orderedQty);
    const receivedQty = parseNumber(line.receivedQty ?? line.received ?? 0);
    const packSize = parseNumber(line.packSize ?? line.pack_size ?? 1) || 1;
    const unitCost = parseNumber(line.unitCost ?? line.costEx ?? line.cost ?? line.price);
    const totalEx = parseMoney(line.lineTotalEx ?? line.totalEx ?? (orderedQty * packSize * unitCost));
    return {
      Type: 'Purchase Order',
      Document: selected.Reference || raw.poNumber || raw.reference || '',
      Item: line.stockItemName || line.itemName || line.name || line.ingredientName || 'Stock item',
      Location: line.locationName || line.targetLocationName || raw.targetLocationName || selected.Location || 'Main Store',
      'Ordered Qty': `${formatNumber(orderedQty)}${line.unit ? ` ${line.unit}` : ''}`,
      'Received Qty': `${formatNumber(receivedQty)}${line.unit ? ` ${line.unit}` : ''}`,
      'Pack Size': formatNumber(packSize),
      'Unit Cost': formatMoney(unitCost),
      'Total Ex': formatMoney(totalEx)
    };
  });
  const grvRows = grvs.flatMap((grv) => grv.lines.map((line) => ({
    Type: 'GRV',
    Document: grv.invoice || grv.id,
    Item: line.Item,
    Location: line.Location,
    'Ordered Qty': '',
    'Received Qty': line['Received Qty'],
    'Pack Size': line['Pack Size'],
    'Unit Cost': line['Unit Cost'],
    'Total Ex': line['Total Ex']
  })));
  return {
    id: raw.id || selected._detailId || selected.Reference,
    reference: selected.Reference || raw.reference || raw.poNumber || '',
    status: selected.Status || raw.status || 'draft',
    date: selected.Date || raw.date || '',
    supplier: selected.Supplier || raw.supplierName || raw.supplier || '',
    location: selected.Location || raw.targetLocationName || raw.locationName || 'Main Store',
    user: selected.User || raw.createdBy || '',
    notes: raw.notes || '',
    totalEx: parseMoney(selected['Total Ex'] ?? raw.totalEx),
    lines,
    grvs,
    exportRows: [...lines, ...grvRows]
  };
}

function getStockTakeSummary(rows = [], selectedId = '') {
  const selected = rows.find((row) => String(row._detailId || row.Date || '') === String(selectedId || ''));
  if (!selected) return null;
  const raw = selected._raw || {};
  const location = selected.Location || raw.locationName || raw.location || 'Main Store';
  const lines = arrayValue(raw.items).map((line) => {
    const stockItemId = String(line.stockItemId || line.id || line.itemId || '').trim();
    const systemStock = parseNumber(line.systemStock ?? line.expectedQty ?? line.expected ?? line.onHand ?? line.stock);
    const countedQty = parseNumber(line.shelfCount ?? line.countedQty ?? line.counted ?? line.count);
    const variance = parseNumber(line.variance ?? line.varianceQty ?? (countedQty - systemStock));
    const unitCost = parseMoney(line.cost ?? line.unitCost ?? line.unit_cost);
    const impact = parseMoney(line.varianceImpactEx ?? line.impactEx ?? line.valueDelta ?? (variance * unitCost));
    const unit = String(line.unit || line.uom || '').trim();
    return {
      Item: line.stockItemName || line.itemName || line.name || line.ingredientName || 'Stock item',
      Location: line.locationName || location,
      'System Stock': `${formatNumber(systemStock)}${unit ? ` ${unit}` : ''}`,
      'Counted Qty': `${formatNumber(countedQty)}${unit ? ` ${unit}` : ''}`,
      Variance: `${variance > 0 ? '+' : ''}${formatNumber(variance)}${unit ? ` ${unit}` : ''}`,
      'Unit Cost': formatMoney(unitCost),
      'Impact Ex': formatMoney(impact),
      _stockItemId: stockItemId,
      _systemStock: systemStock,
      _countedQty: countedQty,
      _unit: unit,
      _variance: variance,
      _impact: impact,
      _varianceTone: variance > 0 ? 'overage' : variance < 0 ? 'shortage' : 'matched',
      _varianceLabel: variance > 0 ? 'Overage' : variance < 0 ? 'Shortage' : 'Matched'
    };
  });
  const netImpact = lines.reduce((sum, line) => sum + Number(line._impact || 0), 0);
  return {
    id: raw.id || selected._detailId || selected.Date || '',
    date: selected.Date || raw.date || '',
    timestamp: raw.timestamp || raw.countedAt || selected.Date || '',
    location,
    template: raw.templateName || raw.template || raw.sessionMode || '',
    user: selected.User || raw.createdByName || raw.createdByEmail || raw.userEmail || raw.createdBy || raw.user || '',
    note: raw.note || raw.notes || '',
    netImpact,
    varianceLines: lines.filter((line) => Number(line._variance || 0) !== 0).length,
    lines
  };
}

function getStockTakeEditAccess(summary = {}, access = {}) {
  const roleName = normalizeRoleName(access.currentRole || '');
  const privileged = access.currentIsSuperUser === true ||
    ['owner', 'admin', 'manager', 'super', 'super-user', 'superuser', 'root'].includes(roleName);
  const hasThirtyDays = privileged ||
    hasPermission(ACTION_PERMISSION_MAP.editStockTake30Days, access.currentRole, access.customRoles || []);
  const hasSevenDays = hasThirtyDays ||
    hasPermission(ACTION_PERMISSION_MAP.editStockTake7Days, access.currentRole, access.customRoles || []);
  const sourceDate = summary.timestamp || summary.date || '';
  const createdTime = sourceDate ? new Date(sourceDate).getTime() : Date.now();
  const ageDays = Number.isFinite(createdTime)
    ? Math.max(0, Math.floor((Date.now() - createdTime) / 86400000))
    : 0;
  if (hasThirtyDays && ageDays <= 30) return { canEdit: true, days: 30, ageDays };
  if (hasSevenDays && ageDays <= 7) return { canEdit: true, days: 7, ageDays };
  return { canEdit: false, days: hasThirtyDays ? 30 : hasSevenDays ? 7 : 0, ageDays };
}

function getGrvLikeSummary(raw = {}, selected = {}) {
  const lines = arrayValue(raw.items).map((line) => {
    const receivedQty = parseNumber(line.receivedQty ?? line.baseQuantity ?? line.qty ?? line.quantity);
    const packSize = parseNumber(line.packSize ?? line.pack_size ?? 1) || 1;
    const unitCost = parseNumber(line.unitCost ?? line.costEx ?? line.cost ?? line.price);
    const totalEx = parseMoney(line.lineTotalEx ?? line.totalEx ?? (receivedQty * unitCost));
    return {
      Item: line.stockItemName || line.itemName || line.name || line.ingredientName || 'Stock item',
      Location: line.locationName || raw.locationName || selected.Location || 'Main Store',
      'Received Qty': `${formatNumber(receivedQty)}${line.unit ? ` ${line.unit}` : ''}`,
      'Pack Size': formatNumber(packSize),
      'Unit Cost': formatMoney(unitCost),
      'Total Ex': formatMoney(totalEx)
    };
  });
  return {
    id: raw.id || raw.grvNumber || raw.invoice || '',
    invoice: raw.invoice || raw.grvNumber || raw.reference || raw.id || '',
    date: raw.date || raw.timestamp || '',
    user: raw.createdByName || raw.submittedByName || raw.createdByEmail || raw.userEmail || raw.createdBy || '',
    totalEx: parseMoney(raw.totalEx),
    lines
  };
}

function renderYocoOrderSummaryOverlay(summary) {
  return `
    <div class="analyticsModalBackdrop" data-yoco-order-close>
      <section class="analyticsOrderModal" role="dialog" aria-modal="true" aria-label="Yoco order summary">
        <header>
          <div>
            <span>Yoco Order</span>
            <h2>${escapeHtml(summary.orderId)}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-yoco-order-close aria-label="Close order summary">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Date</span><strong>${escapeHtml(summary.date)}</strong></div>
          <div><span>Location</span><strong>${escapeHtml(summary.location)}</strong></div>
          <div><span>Qty</span><strong class="${summary.qty < 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess'}">${escapeHtml(formatNumber(summary.qty))}</strong></div>
          <div><span>Net Impact</span><strong class="${summary.total < 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess'}">${escapeHtml(formatSignedMoney(summary.total))}</strong></div>
        </div>
        <div class="analyticsOrderLines">
          ${summary.rows.map((row) => `
            <article>
              <div>
                <strong>${escapeHtml(row['Item Name'] || 'Yoco item')}</strong>
                <span>${escapeHtml(row['Sale / Refund'] || '')} • ${escapeHtml(row['Item Status'] || '')}</span>
              </div>
              <div>
                <span>${escapeHtml(row['Qty Sold'] || '0')}</span>
                <strong class="${parseMoney(row['Total Impact']) < 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess'}">${escapeHtml(formatSignedMoney(row['Total Impact']))}</strong>
              </div>
            </article>
          `).join('')}
        </div>
      </section>
    </div>
  `;
}

function renderSaleMovementSummaryOverlay(summary) {
  return `
    <div class="analyticsModalBackdrop" data-sale-movement-close>
      <section class="analyticsOrderModal analyticsSaleMovementModal" role="dialog" aria-modal="true" aria-label="Sale stock movement summary">
        <header>
          <div>
            <span>Sale Stock Movement</span>
            <h2>${escapeHtml(summary.product)}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-sale-movement-close aria-label="Close sale stock movement">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Date</span><strong>${escapeHtml(summary.date || 'Unknown')}</strong></div>
          <div><span>Location</span><strong>${escapeHtml(summary.location || 'Unassigned')}</strong></div>
          <div><span>Status</span><strong>${escapeHtml(summary.status || 'Unknown')}</strong></div>
          <div><span>Qty Sold</span><strong>${escapeHtml(summary.qtySold)}</strong></div>
          <div><span>Recipe Lines</span><strong>${escapeHtml(formatNumber(summary.recipeLines))}</strong></div>
          <div><span>Total Depleted</span><strong>${escapeHtml(summary.qtyDepleted)}</strong></div>
          <div><span>COGS Ex</span><strong>${escapeHtml(formatMoney(summary.cogs))}</strong></div>
        </div>
        <div class="analyticsOrderLines analyticsCreditNoteLines">
          ${summary.lines.map((line) => `
            <article>
              <div>
                <strong>${escapeHtml(line.Ingredient || 'Recipe ingredient')}</strong>
                <span>${escapeHtml(line.Component || 'Base recipe')} · ${escapeHtml(line.Location || summary.location || '')}</span>
              </div>
              <div>
                <span>Depleted ${escapeHtml(line['Qty Depleted'] || '0')} · Unit ${escapeHtml(line['Unit Cost'] || 'R 0,00')}</span>
                <strong>${escapeHtml(line['Impact Ex'] || 'R 0,00')}</strong>
              </div>
            </article>
          `).join('') || `
            <article>
              <div>
                <strong>No recipe depletion</strong>
                <span>This sale item has no recipe lines linked yet.</span>
              </div>
              <div>
                <span>Qty sold ${escapeHtml(summary.qtySold)}</span>
                <strong>${escapeHtml(formatMoney(0))}</strong>
              </div>
            </article>
          `}
        </div>
      </section>
    </div>
  `;
}

function renderGrvSummaryOverlay(summary) {
  return `
    <div class="analyticsModalBackdrop" data-grv-close>
      <section class="analyticsOrderModal analyticsGrvModal" role="dialog" aria-modal="true" aria-label="GRV summary">
        <header>
          <div>
            <span>GRV Log</span>
            <h2>${escapeHtml(summary.invoice || summary.id)}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-grv-close aria-label="Close GRV">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Date</span><strong>${escapeHtml(summary.date)}</strong></div>
          <div><span>Supplier</span><strong>${escapeHtml(summary.supplier || 'Manual Receipt')}</strong></div>
          <div><span>Location</span><strong>${escapeHtml(summary.location || 'Main Store')}</strong></div>
          <div><span>User</span><strong>${escapeHtml(summary.user || 'Unknown')}</strong></div>
          <div><span>PO</span><strong>${escapeHtml(summary.poNumber || summary.sourcePoId || 'Manual')}</strong></div>
          <div><span>Lines</span><strong>${escapeHtml(formatNumber(summary.lines.length))}</strong></div>
          <div><span>Total Ex</span><strong>${escapeHtml(formatMoney(summary.totalEx))}</strong></div>
        </div>
        ${summary.notes ? `<div class="analyticsNoteReason"><span>Notes</span><strong>${escapeHtml(summary.notes)}</strong></div>` : ''}
        <div class="analyticsCreditNoteActions">
          <button type="button" class="analyticsInlineAction" data-grv-export="pdf">${icon('pdf')} Download PDF</button>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-grv-export="xlsx">${icon('sheet')} Excel</button>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-grv-export="csv">${icon('file')} CSV</button>
        </div>
        <div class="analyticsOrderLines analyticsCreditNoteLines">
          ${summary.lines.map((line) => `
            <article>
              <div>
                <strong>${escapeHtml(line.Item)}</strong>
                <span>${escapeHtml(line.Location)}</span>
              </div>
              <div>
                <span>Ordered ${escapeHtml(line['Ordered Qty'])} · Received ${escapeHtml(line['Received Qty'])} · Pack ${escapeHtml(line['Pack Size'])}</span>
                <strong>${escapeHtml(line['Total Ex'])}</strong>
              </div>
            </article>
          `).join('') || '<p>No item lines found for this GRV.</p>'}
        </div>
      </section>
    </div>
  `;
}

function renderPurchaseOrderSummaryOverlay(summary) {
  return `
    <div class="analyticsModalBackdrop" data-purchase-order-close>
      <section class="analyticsOrderModal analyticsPurchaseOrderModal" role="dialog" aria-modal="true" aria-label="Purchase order summary">
        <header>
          <div>
            <span>Purchase Order</span>
            <h2>${escapeHtml(summary.reference || summary.id)}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-purchase-order-close aria-label="Close purchase order">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Date</span><strong>${escapeHtml(summary.date)}</strong></div>
          <div><span>Supplier</span><strong>${escapeHtml(summary.supplier || 'Unassigned')}</strong></div>
          <div><span>Status</span><strong>${escapeHtml(summary.status)}</strong></div>
          <div><span>Location</span><strong>${escapeHtml(summary.location || 'Main Store')}</strong></div>
          <div><span>User</span><strong>${escapeHtml(summary.user || 'Unknown')}</strong></div>
          <div><span>Linked GRVs</span><strong>${escapeHtml(formatNumber(summary.grvs.length))}</strong></div>
          <div><span>Total Ex</span><strong>${escapeHtml(formatMoney(summary.totalEx))}</strong></div>
        </div>
        ${summary.notes ? `<div class="analyticsNoteReason"><span>Notes</span><strong>${escapeHtml(summary.notes)}</strong></div>` : ''}
        <div class="analyticsCreditNoteActions">
          <button type="button" class="analyticsInlineAction" data-purchase-order-export="pdf">${icon('pdf')} Download PDF</button>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-purchase-order-export="xlsx">${icon('sheet')} Excel</button>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-purchase-order-export="csv">${icon('file')} CSV</button>
        </div>
        <div class="analyticsOrderLines analyticsCreditNoteLines">
          <header class="analyticsEmbeddedSectionHead">
            <strong>Ordered items</strong>
            <span>${escapeHtml(formatNumber(summary.lines.length))} line${summary.lines.length === 1 ? '' : 's'}</span>
          </header>
          ${summary.lines.map((line) => `
            <article>
              <div>
                <strong>${escapeHtml(line.Item)}</strong>
                <span>${escapeHtml(line.Location)}</span>
              </div>
              <div>
                <span>Ordered ${escapeHtml(line['Ordered Qty'])} · Received ${escapeHtml(line['Received Qty'])}</span>
                <strong>${escapeHtml(line['Total Ex'])}</strong>
              </div>
            </article>
          `).join('') || '<p>No item lines found for this purchase order.</p>'}
        </div>
        <div class="analyticsOrderLines analyticsCreditNoteLines">
          <header class="analyticsEmbeddedSectionHead">
            <strong>GRV logs for this PO</strong>
            <span>${escapeHtml(formatNumber(summary.grvs.length))} GRV${summary.grvs.length === 1 ? '' : 's'}</span>
          </header>
          ${summary.grvs.map((grv) => `
            <article>
              <div>
                <strong>${escapeHtml(grv.invoice || grv.id || 'GRV')}</strong>
                <span>${escapeHtml(grv.date || '')} ${grv.user ? `· ${escapeHtml(grv.user)}` : ''}</span>
              </div>
              <div>
                <span>${escapeHtml(formatNumber(grv.lines.length))} line${grv.lines.length === 1 ? '' : 's'}</span>
                <strong>${escapeHtml(formatMoney(grv.totalEx))}</strong>
              </div>
            </article>
          `).join('') || '<p>No GRVs have been received against this purchase order yet.</p>'}
        </div>
      </section>
    </div>
  `;
}

function renderCreditNoteSummaryOverlay(summary) {
  const documentTitle = summary.reference || summary.id;
  return `
    <div class="analyticsModalBackdrop" data-credit-note-close>
      <section class="analyticsOrderModal analyticsCreditNoteModal" role="dialog" aria-modal="true" aria-label="Credit note summary">
        <header>
          <div>
            <span>Credit Note Log</span>
            <h2>${escapeHtml(documentTitle)}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-credit-note-close aria-label="Close credit note">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Date</span><strong>${escapeHtml(summary.date)}</strong></div>
          <div><span>Supplier</span><strong>${escapeHtml(summary.supplier || 'Unassigned')}</strong></div>
          <div><span>Location</span><strong>${escapeHtml(summary.location || 'Main Store')}</strong></div>
          <div><span>User</span><strong>${escapeHtml(summary.user || 'Unknown')}</strong></div>
          <div><span>Lines</span><strong>${escapeHtml(formatNumber(summary.lines.length))}</strong></div>
          <div><span>Total Ex</span><strong class="analyticsTextDanger">${escapeHtml(formatMoney(summary.totalEx))}</strong></div>
        </div>
        ${summary.reason ? `<div class="analyticsNoteReason"><span>Reason</span><strong>${escapeHtml(summary.reason)}</strong></div>` : ''}
        <div class="analyticsCreditNoteActions">
          <button type="button" class="analyticsInlineAction" data-credit-note-export="pdf">${icon('pdf')} Download PDF</button>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-credit-note-export="xlsx">${icon('sheet')} Excel</button>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-credit-note-export="csv">${icon('file')} CSV</button>
        </div>
        <div class="analyticsOrderLines analyticsCreditNoteLines">
          <header class="analyticsEmbeddedSectionHead">
            <strong>Returned Items</strong>
            <span>${escapeHtml(formatNumber(summary.lines.length))} line${summary.lines.length === 1 ? '' : 's'}</span>
          </header>
          ${summary.lines.map((line) => `
            <article>
              <div>
                <strong>${escapeHtml(line.Item)}</strong>
                <span>${escapeHtml(line.Location)}</span>
              </div>
              <div class="analyticsCreditNoteLineMeta">
                <span>Ordered ${escapeHtml(line['Ordered Qty'])} · Returned ${escapeHtml(line['Returned Qty'])} · Pack ${escapeHtml(line['Pack Size'])}</span>
                <strong>${escapeHtml(line['Total Ex'])}</strong>
              </div>
            </article>
          `).join('') || '<p>No item lines found for this credit note.</p>'}
        </div>
      </section>
    </div>
  `;
}

function renderStockTakeSummaryOverlay(summary, options = {}) {
  const isEditing = options.isEditing === true;
  const isSaving = options.actionStatus === 'saving-stocktake-edit';
  return `
    <div class="analyticsModalBackdrop" data-stocktake-close>
      <section class="analyticsOrderModal analyticsStockTakeModal" role="dialog" aria-modal="true" aria-label="Stock take count summary">
        <header>
          <div>
            <span>Stock Take Count</span>
            <h2>${escapeHtml(summary.template || summary.id || 'Count Session')}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-stocktake-close aria-label="Close stock take count">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Date</span><strong>${escapeHtml(summary.date)}</strong></div>
          <div><span>Location</span><strong>${escapeHtml(summary.location || 'Main Store')}</strong></div>
          <div><span>User</span><strong>${escapeHtml(summary.user || 'Unknown')}</strong></div>
          <div><span>Items Counted</span><strong>${escapeHtml(formatNumber(summary.lines.length))}</strong></div>
          <div><span>Variance Lines</span><strong>${escapeHtml(formatNumber(summary.varianceLines))}</strong></div>
          <div><span>Net Impact</span><strong class="${summary.netImpact < 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess'}">${escapeHtml(formatSignedMoney(summary.netImpact))}</strong></div>
        </div>
        ${summary.note ? `<div class="analyticsNoteReason"><span>Note</span><strong>${escapeHtml(summary.note)}</strong></div>` : ''}
        <div class="analyticsCreditNoteActions">
          ${options.canEdit && !isEditing ? `
            <button type="button" class="analyticsInlineAction analyticsInlineAction--success" data-stocktake-edit>
              ${icon('edit')} Edit Count${options.editWindowDays ? ` (${escapeHtml(formatNumber(options.editWindowDays))} days)` : ''}
            </button>
          ` : ''}
          ${isEditing ? `
            <button type="button" class="analyticsInlineAction analyticsInlineAction--success" data-stocktake-save-edit ${isSaving ? 'disabled' : ''}>
              ${icon('check')} ${isSaving ? 'Saving...' : 'Save Correction'}
            </button>
            <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-stocktake-cancel-edit ${isSaving ? 'disabled' : ''}>
              Cancel Edit
            </button>
          ` : ''}
          <button type="button" class="analyticsInlineAction" data-stocktake-export="pdf">${icon('pdf')} Download PDF</button>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-stocktake-export="xlsx">${icon('sheet')} Excel</button>
          <button type="button" class="analyticsInlineAction analyticsInlineAction--ghost" data-stocktake-export="csv">${icon('file')} CSV</button>
        </div>
        ${isEditing ? `
          <div class="analyticsEditNotice">
            Corrections update the counted quantity and add an auditable stock movement for the difference.
          </div>
        ` : ''}
        <div class="analyticsOrderLines analyticsCreditNoteLines">
          ${summary.lines.map((line) => `
            <article class="analyticsAuditLine analyticsAuditLine--${escapeAttribute(line._varianceTone || 'matched')}">
              <div>
                <strong>${escapeHtml(line.Item)}</strong>
                <span>${escapeHtml(line.Location)}</span>
              </div>
              <div>
                <span>
                  <em class="analyticsAuditVarianceBadge analyticsAuditVarianceBadge--${escapeAttribute(line._varianceTone || 'matched')}">${escapeHtml(line._varianceLabel || 'Matched')}</em>
                  System ${escapeHtml(line['System Stock'])} · ${isEditing && line._stockItemId ? `
                    Counted
                    <input
                      type="text"
                      inputmode="decimal"
                      class="analyticsStockTakeEditInput"
                      value="${escapeAttribute(formatNumber(line._countedQty))}"
                      data-stocktake-edit-line="${escapeAttribute(line._stockItemId)}"
                      data-focus-key="stocktake-edit-${escapeAttribute(line._stockItemId)}"
                      aria-label="Correct counted quantity for ${escapeAttribute(line.Item)}"
                    >
                    ${line._unit ? escapeHtml(line._unit) : ''}
                  ` : `Counted ${escapeHtml(line['Counted Qty'])}`} · Variance ${escapeHtml(line.Variance)}
                </span>
                <strong class="${Number(line._variance || 0) < 0 ? 'analyticsTextDanger' : Number(line._variance || 0) > 0 ? 'analyticsTextSuccess' : ''}">${escapeHtml(line['Impact Ex'])}</strong>
              </div>
            </article>
          `).join('') || '<p>No item lines found for this stock take.</p>'}
        </div>
      </section>
    </div>
  `;
}

function hydrateStockOnHandReport(reportData, filters = {}) {
  if (reportData.report.id !== 'stock') return reportData;

  const expanded = new Set(arrayValue(filters.stockExpandedIds));
  const groups = new Map();
  (reportData.rows || []).forEach((row) => {
    const key = stockOnHandGroupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const rows = [...groups.entries()]
    .map(([key, detailRows]) => {
      const sortedRows = [...detailRows].sort((left, right) => String(left.Location || '').localeCompare(String(right.Location || '')));
      const primary = sortedRows[0] || {};
      const totalQty = sortedRows.reduce((sum, row) => sum + parseNumber(row['On Hand']), 0);
      const totalValue = sortedRows.reduce((sum, row) => sum + parseMoney(row['Stock Value']), 0);
      const locationNames = [...new Set(sortedRows.map((row) => String(row.Location || '').trim()).filter(Boolean))];
      const groupKey = `stock::${key}`;

      return {
        ...primary,
        _groupKey: groupKey,
        _detailRows: sortedRows,
        _expanded: expanded.has(groupKey),
        _locationCount: locationNames.length,
        _stockItemId: primary._stockItemId || '',
        Item: primary.Item || 'Unnamed item',
        Category: primary.Category || 'General',
        Locations: locationNames.length === 1 ? locationNames[0] : `${formatNumber(locationNames.length)} locations`,
        'Total On Hand': formatNumber(totalQty),
        Unit: primary.Unit || primary._unit || '',
        'Unit Cost': primary['Unit Cost'] || formatMoney(primary._unitCost || 0),
        'Stock Value': formatMoney(totalValue),
        Action: locationNames.length > 1 ? 'View location breakdown' : ''
      };
    })
    .sort((left, right) => String(left.Item || '').localeCompare(String(right.Item || '')));

  return {
    ...reportData,
    columns: ['Item', 'Category', 'Locations', 'Total On Hand', 'Unit', 'Unit Cost', 'Stock Value', 'Action'],
    rows
  };
}

function stockOnHandGroupKey(row = {}) {
  return [
    row._stockItemId || '',
    row.Item || '',
    row.Category || '',
    row.Unit || row._unit || ''
  ].map((value) => String(value || '').trim().toLowerCase()).join('::');
}

function hydrateLowStockReport(reportData, state = {}, filters = {}) {
  if (reportData.report.id !== 'low_stock') return reportData;

  const dashboardRows = state.dashboard?.insights?.lowStockRows || [];
  const selected = new Set(arrayValue(filters.lowStockSelectedIds));
  const expanded = new Set(arrayValue(filters.lowStockExpandedIds));
  const reportRows = reportData.rows?.length
    ? reportData.rows
    : buildDashboardLowStockRows(dashboardRows, filters);
  const detailRows = normalizeLowStockDetailRows(reportRows, filters, selected);
  const viewMode = filters.lowStockViewMode === 'location' ? 'location' : 'item';
  const rows = viewMode === 'location'
    ? buildLowStockLocationRows(detailRows)
    : buildLowStockItemRows(detailRows, { selected, expanded });

  return {
    ...reportData,
    columns: ensureLowStockActionColumn(viewMode === 'location'
      ? ['Location', 'Item', 'Category', 'Current Stock', 'Threshold', 'Variance', 'Deficit Quantity', 'Deficit Value']
      : reportData.columns),
    rows
  };
}

function normalizeLowStockDetailRows(rows = [], filters = {}, selected = new Set()) {
  const showOnlyLow = filters.lowStockShowOnlyLow !== false;
  return rows
    .map((row) => {
      const current = parseNumber(row['Current Stock'] ?? row.stock ?? 0);
      const threshold = parseNumber(row.Threshold ?? row.threshold ?? 0);
      const variance = Number.isFinite(parseNumber(row.Variance)) ? parseNumber(row.Variance) : current - threshold;
      const deficitQty = Math.max(0, -variance);
      const normalized = {
        ...row,
        _locationId: row._locationId || row.locationId || '',
        Location: row.Location || row.location || row.locationName || 'Main Store',
        'Current Stock': formatNumber(current),
        Threshold: formatNumber(threshold),
        Variance: formatNumber(variance),
        'Deficit Quantity': formatNumber(deficitQty),
        'Deficit Value': row['Deficit Value'] || formatMoney(0),
        Action: row.Action || 'Reorder',
        _low: row._low === true || variance < 0
      };
      normalized._selected = selected.has(lowStockRowKey(normalized));
      return normalized;
    })
    .filter((row) => !showOnlyLow || row._low)
    .filter((row) => !String(row.Location || '').toLowerCase().includes('all locations'));
}

function buildLowStockItemRows(detailRows = [], { selected = new Set(), expanded = new Set() } = {}) {
  const groups = new Map();
  detailRows.forEach((row) => {
    const key = String(row._id || row.Item || '').trim() || row.Item;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.entries()].map(([key, rows]) => {
    const totalCurrent = rows.reduce((sum, row) => sum + parseNumber(row['Current Stock']), 0);
    const totalThreshold = rows.reduce((sum, row) => sum + parseNumber(row.Threshold), 0);
    const totalVariance = totalCurrent - totalThreshold;
    const totalDeficit = rows.reduce((sum, row) => sum + parseMoney(row['Deficit Value']), 0);
    const groupKey = `item::${key}`;
    const detailRowsForItem = rows.map((row) => ({
      ...row,
      _selected: selected.has(lowStockRowKey(row))
    }));
    return {
      _id: rows[0]?._id || key,
      _groupKey: groupKey,
      _detailRows: detailRowsForItem,
      _selectedKeys: selected,
      _expanded: expanded.has(groupKey),
      Item: rows[0]?.Item || 'Unnamed item',
      Category: rows[0]?.Category || 'General',
      'Low Locations': rows.length === 1 ? rows[0].Location : `${rows.length} low locations`,
      'Total Current Stock': formatNumber(totalCurrent),
      'Total Threshold': formatNumber(totalThreshold),
      'Total Variance': formatNumber(totalVariance),
      'Total Deficit Value': formatMoney(totalDeficit),
      Unit: rows[0]?.Unit || rows[0]?._unit || '',
      _unit: rows[0]?._unit || rows[0]?.Unit || '',
      Action: rows.length > 1 ? 'View store breakdown' : 'Reorder'
    };
  }).sort((a, b) => parseMoney(b['Total Deficit Value']) - parseMoney(a['Total Deficit Value']));
}

function buildLowStockLocationRows(detailRows = []) {
  const byLocation = new Map();
  detailRows.forEach((row) => {
    const location = row.Location || 'Main Store';
    if (!byLocation.has(location)) byLocation.set(location, []);
    byLocation.get(location).push(row);
  });
  return [...byLocation.entries()].flatMap(([location, rows]) => rows.map((row, index) => ({
    ...row,
    _locationGroupLabel: index === 0 ? location : '',
    _locationGroupCount: rows.length,
    _selected: row._selected === true
  })));
}

function buildDashboardLowStockRows(rows = [], filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const locationFilter = String(filters.locationId || '').trim();

  return rows
    .map((item) => {
      const stock = parseNumber(item.stock);
      const threshold = parseNumber(item.threshold);
      const variance = stock - threshold;
      const unitCost = parseNumber(item.cost || item.unitCost);
      return {
        _id: item.id || item.stockItemId || item.name,
        _locationId: item.locationId || '',
        Item: item.name || item.stockItemName || 'Unnamed item',
        Category: item.category || 'General',
        Location: item.location || item.locationName || 'Main Store',
        'Current Stock': formatNumber(stock),
        Threshold: formatNumber(threshold),
        Variance: formatNumber(variance),
        'Deficit Quantity': formatNumber(Math.max(0, -variance)),
        'Deficit Value': formatMoney(Math.max(0, -variance) * unitCost),
        Unit: item.unit || item.uom || '',
        _unit: item.unit || item.uom || '',
        _low: variance < 0,
        Action: 'Reorder'
      };
    })
    .filter((row) => !locationFilter || row._locationId === locationFilter || !row._locationId)
    .filter((row) => !query || Object.entries(row)
      .filter(([key]) => !key.startsWith('_'))
      .some(([, value]) => String(value || '').toLowerCase().includes(query)));
}

function ensureLowStockActionColumn(columns = []) {
  const withoutSelection = columns.filter((column) => column !== 'Select');
  const withAction = withoutSelection.includes('Action') ? withoutSelection : [...withoutSelection, 'Action'];
  return ['Select', ...withAction];
}

function isCurrencyCell(column = '', value = '') {
  if (/^[+-]?\s*R\b/i.test(String(value ?? '').trim())) return true;
  return isCurrencyColumn(column);
}

function isCurrencyColumn(column = '') {
  const text = String(column || '').trim().toLowerCase();
  if (/%|percent|gp/.test(text)) return false;
  return [
    'selling price',
    'recipe cost',
    'unit cost',
    'stock value',
    'deficit value',
    'total ex',
    'impact ex',
    'net impact',
    'purchases ex',
    'wastage ex',
    'manual adjustments ex',
    'opening stock',
    'closing stock',
    'cost of sales',
    'count variance',
    'manual adjustments',
    'gross sales',
    'refunds',
    'net',
    'cos impact',
    'loss value',
    'total loss value',
    'total impact',
    'variance from previous'
  ].includes(text);
}

function formatCurrencyCellValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^[+-]?\s*R\b/i.test(text)) return text.replace(/([+-]?)\s*R\s*/i, '$1R ');
  const numeric = parseMoney(text);
  const signMatch = text.match(/^\s*([+-])/);
  const sign = signMatch?.[1] || (numeric < 0 ? '-' : '');
  return `${sign}R ${Math.abs(numeric).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isGpColumn(column = '') {
  return /\bgp\s*%|\bgp\b|gross profit/i.test(column);
}

function formatPercentValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return '0.0%';
  if (/%$/.test(text)) return text;
  return `${parseNumber(text).toFixed(1)}%`;
}

function gpToneClass(value) {
  if (value < 0) return 'is-negative';
  if (value < 30) return 'is-low';
  if (value < 60) return 'is-mid';
  if (value < 80) return 'is-good';
  return 'is-excellent';
}

function menuGpRiskRows(rows = []) {
  return rows.filter((row) => {
    if (row._missingRecipe || /missing/i.test(String(row['GP %'] || ''))) return true;
    return parseNumber(row['GP %']) < 60;
  });
}

function gpMetricTone(value) {
  if (value < 0) return 'red';
  if (value < 30) return 'orange';
  if (value < 60) return 'yellow';
  if (value < 80) return 'green';
  return 'neon';
}

function pageSizeOptions() {
  return [
    { value: '25', label: '25 rows' },
    { value: '50', label: '50 rows' },
    { value: '100', label: '100 rows' }
  ];
}

function normalizePageSize(value) {
  const size = Number(value);
  return [25, 50, 100].includes(size) ? size : 25;
}

function reportsForCategory(category) {
  return category.reports
    .map((id) => reportCatalog.find((report) => report.id === id))
    .filter(Boolean);
}

function reportsForHubGroup(group) {
  return group.reports
    .map((id) => reportCatalog.find((report) => report.id === id))
    .filter(Boolean);
}

function reportMatchesSearch(report, search) {
  if (!search) return true;
  return `${report.title} ${report.description} ${report.group}`.toLowerCase().includes(search);
}

function categoryById(categoryId) {
  return REPORT_CATEGORIES.find((category) => category.id === categoryId) || REPORT_CATEGORIES[0];
}

function categoryForReport(reportId) {
  return REPORT_CATEGORIES.find((category) => category.reports.includes(reportId)) || REPORT_CATEGORIES[0];
}

// Reports that describe current setup/state (not historical activity) get no date range.
const STATE_ONLY_REPORTS = new Set(['missing_recipes', 'low_stock', 'stock']);
function reportUsesDateRange(reportId) {
  return !STATE_ONLY_REPORTS.has(String(reportId || ''));
}

function reportShortDescription(report) {
  return String(report.description || '').replace(/\.$/, '');
}

function buildCategoryOptions(ingredients = []) {
  const categories = [...new Set((ingredients || []).map((item) => item.category).filter(Boolean))].sort();
  return [{ value: '', label: 'All Categories' }, ...categories.map((category) => ({ value: category, label: category }))];
}

function buildLocationOptions(locations = []) {
  return [{ value: '', label: 'All Locations' }, ...(locations || []).map((location) => ({ value: location.id, label: location.displayName || location.name || location.id }))];
}

function defaultStartDate() {
  const date = new Date(`${todayLocal()}T12:00:00`);
  date.setDate(date.getDate() - 29);
  return date.toISOString().slice(0, 10);
}

function buildRangeCalendar(cursorDate, range) {
  const cursor = parseDateKey(cursorDate || todayLocal());
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstOfMonth = new Date(year, month, 1, 12, 0, 0, 0);
  const start = new Date(firstOfMonth);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date: toDateKey(date),
      day: date.getDate(),
      inMonth: date.getMonth() === month
    };
  });

  return {
    label: firstOfMonth.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' }),
    weekdays,
    days,
    range
  };
}

function parseDateKey(value) {
  const date = new Date(`${String(value || todayLocal()).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? new Date(`${todayLocal()}T12:00:00`) : date;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfMonthKey(value) {
  const date = parseDateKey(value);
  date.setDate(1);
  return toDateKey(date);
}

function startOfYearKey(value) {
  const date = parseDateKey(value);
  date.setMonth(0, 1);
  return toDateKey(date);
}

function previousCalendarYearRange(value) {
  const date = parseDateKey(value);
  const year = date.getFullYear() - 1;
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`
  };
}

function shiftMonthKey(value, delta) {
  const date = parseDateKey(value);
  date.setDate(1);
  date.setMonth(date.getMonth() + Number(delta || 0));
  return toDateKey(date);
}

function addDays(value, offset) {
  const date = parseDateKey(value);
  date.setDate(date.getDate() + Number(offset || 0));
  return toDateKey(date);
}

function formatDateLabel(value) {
  return String(value || '').replaceAll('-', '/');
}

function formatDisplayDate(value) {
  return parseDateKey(value || todayLocal()).toLocaleDateString('en-ZA', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function formatRangePickerDate(value) {
  return parseDateKey(value || todayLocal()).toLocaleDateString('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function rangePickerInstruction(filters, startDate, endDate) {
  if ((filters.rangePickerMode || 'days') === 'months') return 'Choose a month, then pick the range dates.';
  if ((filters.rangePickerMode || 'days') === 'years') return 'Choose or enter a year, then choose the month.';
  const waitingForEnd = (filters.rangePickerEdge || 'start') === 'end' && !filters.rangePickerComplete;
  if (waitingForEnd) return `Choose the end date for ${formatRangePickerDate(startDate)}.`;
  return `First click starts the range. Second click completes it. Current: ${formatRangePickerDate(startDate)} - ${formatRangePickerDate(endDate)}.`;
}

function monthName(index) {
  return monthNamesLong()[Number(index) || 0] || monthNamesLong()[0];
}

function monthNamesShort() {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
}

function monthNamesLong() {
  return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
}

function sanitizeYearInput(value) {
  const year = Number(String(value || '').replace(/\D/g, '').slice(0, 4));
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return 0;
  return year;
}

function findCurrencyColumn(columns = []) {
  return columns.find((column) => /value|impact|sales|refund|net|total|cost|stock|purchase|wastage|loss/i.test(column));
}

function findNumericColumn(columns = []) {
  return columns.find((column) => /qty|quantity|count|rows|items|lines|level|on hand|variance/i.test(column));
}

function buildCustomReportFromPrompt(prompt = '', reportData = {}) {
  const text = String(prompt || '').toLowerCase();
  const sourceOptions = reportData.custom?.sourceOptions || customReportSources;
  const sourceRules = [
    { id: 'payments', words: ['payment', 'tender', 'cash', 'card', 'tip', 'tax'] },
    { id: 'modifier_gp_detail', words: ['modifier gp', 'modifiers', 'modifier', 'product modifier', 'average gp'] },
    { id: 'sales', words: ['sale', 'sales', 'revenue', 'refund', 'yoco', 'order'] },
    { id: 'low_stock', words: ['low stock', 'reorder', 'threshold', 'par'] },
    { id: 'inventory', words: ['stock on hand', 'inventory', 'stock value', 'on hand'] },
    { id: 'movement', words: ['movement', 'usage', 'wastage', 'waste', 'adjustment', 'transfer'] },
    { id: 'invoices', words: ['invoice', 'grv', 'goods received', 'received'] },
    { id: 'purchase_orders', words: ['purchase order', 'po', 'ordering'] },
    { id: 'suppliers', words: ['supplier', 'vendor'] },
    { id: 'menu', words: ['menu', 'recipe', 'gp', 'gross profit'] },
    { id: 'forecast', words: ['forecast', 'stock-out', 'stock out', 'run out'] },
    { id: 'volatility', words: ['price volatility', 'price change', 'cost change'] }
  ];
  const matchedRule = sourceRules.find((rule) => rule.words.some((word) => text.includes(word)));
  const sourceId = sourceOptions.find((source) => source.id === matchedRule?.id)?.id
    || sourceOptions.find((source) => source.reportId === matchedRule?.id)?.id
    || reportData.custom?.sourceId
    || sourceOptions[0]?.id
    || 'stock';
  const sourceConfig = sourceOptions.find((source) => source.id === sourceId) || sourceOptions[0] || {};
  const availableColumns = customColumnsForSource(sourceConfig);
  const wantedColumns = availableColumns.filter((column) => {
    const normalized = String(column || '').toLowerCase();
    if (text.includes(normalized)) return true;
    if (/date|time/.test(normalized) && /date|time|daily|eod|day|week|month/.test(text)) return true;
    if (/location/.test(normalized) && /location|store|branch|site/.test(text)) return true;
    if (/supplier/.test(normalized) && /supplier|vendor/.test(text)) return true;
    if (/category/.test(normalized) && /category|group/.test(text)) return true;
    if (/tax/.test(normalized) && /tax|vat/.test(text)) return true;
    if (/tip/.test(normalized) && /tip|gratuity/.test(text)) return true;
    if (/refund/.test(normalized) && /refund|return/.test(text)) return true;
    if (/gross|net|total|value|impact|sales|cost/.test(normalized) && /money|value|sales|cost|total|spend|impact|revenue/.test(text)) return true;
    if (/qty|quantity|stock|count|orders|items|lines/.test(normalized) && /quantity|qty|stock|count|orders|items|lines/.test(text)) return true;
    return false;
  });
  const defaultColumns = sourceConfig.defaultColumns || availableColumns.slice(0, 6);
  const columns = [...new Set((wantedColumns.length ? wantedColumns : defaultColumns).filter((column) => availableColumns.includes(column)))];
  const visualizationType = /pie|donut/.test(text)
    ? 'pie'
    : /line|trend|over time/.test(text)
      ? 'line'
      : /bar|compare|comparison/.test(text)
        ? 'bar'
        : 'table';
  const groupBy = /month|monthly/.test(text)
    ? 'month'
    : /week|weekly/.test(text)
      ? 'week'
      : /day|daily|eod|end of day/.test(text)
        ? 'day'
        : /supplier|vendor/.test(text)
          ? 'supplier'
          : /location|store|branch|site/.test(text)
            ? 'location'
            : /category/.test(text)
              ? 'category'
              : 'none';
  const eod = /eod|end of day|daily email|email/.test(text);
  return {
    customSource: sourceId,
    customColumns: columns.length ? columns : availableColumns.slice(0, 1),
    visualizationType,
    groupBy,
    customReportBlocks: buildLocalCustomReportBlocks({
      sourceLabel: sourceConfig.label || 'Custom Report',
      columns: columns.length ? columns : availableColumns.slice(0, 1),
      visualizationType,
      groupBy
    }),
    customReportEod: eod,
    customReportName: inferCustomReportName(prompt, sourceConfig.label || 'Custom Report', eod)
  };
}

function buildLocalCustomReportBlocks({ sourceLabel = 'Custom Report', columns = [], visualizationType = 'table', groupBy = 'none' } = {}) {
  const valueColumn = findCurrencyColumn(columns) || findNumericColumn(columns) || '';
  const labelColumn = groupBy === 'category' && columns.includes('Category')
    ? 'Category'
    : groupBy === 'supplier' && columns.includes('Supplier')
      ? 'Supplier'
      : groupBy === 'location' && columns.includes('Location')
        ? 'Location'
        : ['day', 'week', 'month'].includes(groupBy)
          ? columns.find((column) => /date|time|timestamp/i.test(column)) || columns[0] || ''
          : columns.find((column) => !isCurrencyReportColumn(column) && !/qty|quantity|count|rows|items|lines|level|variance/i.test(column)) || columns[0] || '';
  const chartType = ['bar', 'line', 'pie'].includes(visualizationType) ? visualizationType : 'bar';
  return [
    {
      id: 'total-records',
      type: 'metric',
      title: 'Total Records',
      description: `Rows from ${sourceLabel}.`,
      columns: [],
      valueColumn: '',
      labelColumn: '',
      groupBy: 'none',
      limit: 1
    },
    {
      id: 'primary-breakdown',
      type: chartType,
      title: labelColumn ? `${sourceLabel} by ${labelColumn}` : `${sourceLabel} Breakdown`,
      description: valueColumn ? `Grouped by ${labelColumn || 'row'} using ${valueColumn}.` : 'Grouped row count.',
      columns: [labelColumn, valueColumn].filter(Boolean),
      valueColumn,
      labelColumn,
      groupBy,
      limit: 12
    },
    {
      id: 'detail-table',
      type: 'table',
      title: `${sourceLabel} Detail`,
      description: 'Underlying records for drill-down.',
      columns: columns.slice(0, 8),
      valueColumn: '',
      labelColumn: '',
      groupBy: 'none',
      limit: 25
    }
  ];
}

function customColumnsForSource(sourceConfig = {}) {
  if (sourceConfig.id === 'suppliers') return ['Supplier', 'Contact', 'Email', 'Phone', 'Status', 'GRVs', 'Spend Ex', 'Last GRV'];
  return reportCatalog.find((report) => report.id === sourceConfig.reportId)?.columns || [];
}

function inferCustomReportName(prompt = '', fallback = 'Custom Report', eod = false) {
  const compact = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (compact) {
    const words = compact.split(' ').slice(0, 7).join(' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return eod ? `EOD ${fallback}` : fallback;
}

function visualizationLabel(value = 'table') {
  return VISUALIZATION_OPTIONS.find((option) => option.id === value)?.label || 'Summary Table';
}

function groupingLabel(value = 'none') {
  return GROUPING_OPTIONS.find((option) => option.id === value)?.label || 'No grouping';
}

function buildCustomChartSeries(reportData, { groupBy = 'none' } = {}) {
  const rows = reportData.rows || [];
  const columns = reportData.columns || [];
  const valueColumn = findCurrencyColumn(columns) || findNumericColumn(columns);
  const groupColumn = resolveCustomGroupColumn(columns, groupBy, reportData);
  const map = new Map();
  rows.forEach((row) => {
    const label = getCustomGroupLabel(row, groupColumn, groupBy);
    const value = valueColumn ? parseNumber(row[valueColumn]) : 1;
    map.set(label, (map.get(label) || 0) + (valueColumn ? value : 1));
  });
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => sortCustomSeries(left.label, right.label, groupBy))
    .slice(0, 24);
}

function resolveCustomGroupColumn(columns = [], groupBy = 'none', reportData = {}) {
  if (groupBy === 'category' && columns.includes('Category')) return 'Category';
  if (groupBy === 'supplier' && columns.includes('Supplier')) return 'Supplier';
  if (groupBy === 'location' && columns.includes('Location')) return 'Location';
  if (['day', 'week', 'month'].includes(groupBy)) {
    return columns.find((column) => /date|time|timestamp/i.test(column)) || columns[0] || '';
  }
  return breakdownColumnForReport(reportData);
}

function getCustomGroupLabel(row = {}, column = '', groupBy = 'none') {
  const raw = String(row[column] ?? 'Unspecified').trim() || 'Unspecified';
  if (!['day', 'week', 'month'].includes(groupBy)) return raw;
  const date = parseDateKey(raw);
  if (groupBy === 'month') return date.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
  if (groupBy === 'week') {
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return `Week ${weekStart.toISOString().slice(0, 10)}`;
  }
  return date.toISOString().slice(0, 10);
}

function sortCustomSeries(left = '', right = '', groupBy = 'none') {
  if (['day', 'week', 'month'].includes(groupBy)) return left.localeCompare(right);
  return 0;
}

function fallbackMetricIcon(index) {
  return ['clipboard', 'warehouse', 'cart', 'trash'][index % 4] || 'activity';
}

function sumRows(rows = [], key = '') {
  return rows.reduce((sum, row) => sum + parseNumber(row[key]), 0);
}

function averageRows(rows = [], key = '') {
  if (!rows.length) return 0;
  const values = rows.map((row) => parseNumber(row[key])).filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueCount(rows = [], key = '') {
  return new Set(rows.map((row) => String(row[key] ?? '').trim()).filter(Boolean)).size;
}

function parseLocaleNumber(value) {
  if (typeof value === 'number') return value;
  let text = String(value ?? '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');
  if (!text || text === '-' || text === '+') return 0;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > lastDot) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    text = text.replace(/,/g, '');
  }

  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseMoney(value) {
  return parseLocaleNumber(value);
}

function parseNumber(value) {
  return parseLocaleNumber(value);
}

function formatMoney(value) {
  return `R ${Number(value || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedMoney(value) {
  const numeric = parseMoney(value);
  if (numeric < 0) return `-${formatMoney(Math.abs(numeric))}`;
  return `+${formatMoney(numeric)}`;
}

function formatNumber(value) {
  return Number(value || 0).toFixed(3).replace(/\.?0+$/, '') || '0';
}

function formatMaybeMoney(value, key = '') {
  return /value|impact|sales|refund|net|total|cost|stock|purchase|wastage|loss/i.test(key)
    ? formatMoney(value)
    : formatNumber(value);
}

function reportIcon(id) {
  if (id === 'custom_report') return 'grid';
  if (['stock', 'movement', 'low_stock', 'sale_movement'].includes(id)) return 'box';
  if (['modifier_gp_detail', 'modifier_gp_summary'].includes(id)) return 'chart';
  if (['grv', 'cn', 'purchase_orders', 'payments', 'yoco_sales'].includes(id)) return 'file';
  if (['menu', 'missing_recipes'].includes(id)) return 'menu';
  if (['forecast', 'volatility', 'variance', 'waste_pareto'].includes(id)) return 'chart';
  return 'activity';
}

function icon(name) {
  const icons = {
    activity: '<path d="M4 12h4l2-7 4 14 2-7h4"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    bars: '<path d="M6 20V10"/><path d="M12 20V4"/><path d="M18 20v-7"/>',
    box: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="M3 10h18"/>',
    cart: '<circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L21 8H6"/>',
    chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 4-4 3 3 5-7"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronDoubleLeft: '<path d="m17 18-6-6 6-6"/><path d="m11 18-6-6 6-6"/>',
    chevronDoubleRight: '<path d="m7 18 6-6-6-6"/><path d="m13 18 6-6-6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    clipboard: '<path d="M8 4h8"/><path d="M9 2h6v4H9z"/><path d="M6 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1"/><path d="M8 13h8"/><path d="M8 17h5"/>',
    coin: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8"/><path d="M9.5 10.5A2.5 2.5 0 0 1 12 8a2.5 2.5 0 0 1 2.5 2.5"/><path d="M14.5 13.5A2.5 2.5 0 0 1 12 16a2.5 2.5 0 0 1-2.5-2.5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    file: '<path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    filter: '<path d="M4 5h16"/><path d="M7 12h10"/><path d="M10 19h4"/>',
    grid: '<path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v11h14V10"/><path d="M9 21v-7h6v7"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    list: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93"/><path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    menu: '<path d="M6 11h12"/><path d="M8 6h8a4 4 0 0 1 4 4H4a4 4 0 0 1 4-4z"/><path d="M5 15h14l-1 5H6z"/>',
    more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    network: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="m8.7 10.7 6.6-3.4"/><path d="m8.7 13.3 6.6 3.4"/>',
    pdf: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 14h1.5a1.5 1.5 0 0 0 0-3H9v6"/><path d="M14 11v6"/><path d="M14 11h2"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    print: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/><path d="M8 6h8"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    sheet: '<path d="M4 4h16v16H4z"/><path d="M4 10h16"/><path d="M10 4v16"/>',
    sliders: '<path d="M4 6h10"/><path d="M18 6h2"/><path d="M16 4v4"/><path d="M4 12h2"/><path d="M10 12h10"/><path d="M8 10v4"/><path d="M4 18h12"/><path d="M20 18h0"/><path d="M18 16v4"/>',
    sparkles: '<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/><path d="m5 14 .8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8z"/>',
    star: '<path d="m12 3 2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/>',
    text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    trendUp: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    utensils: '<path d="M7 3v8"/><path d="M4 3v5a3 3 0 0 0 6 0V3"/><path d="M7 11v10"/><path d="M17 3v18"/><path d="M17 3c2 1.5 3 3.5 3 6 0 2-1 3.5-3 4"/>'
    ,
    warehouse: '<path d="M3 21V8l9-5 9 5v13"/><path d="M7 21v-8h10v8"/><path d="M9 17h6"/><path d="M9 13h6"/>'
    ,
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${icons[name] || icons.chart}
    </svg>
  `;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value = '') {
  return escapeHtml(value);
}
