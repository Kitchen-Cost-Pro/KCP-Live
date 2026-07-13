import { getReportDefinition, listReports, reportRedirects } from '../reports/index.js';
import { getReportColumns } from './reportValidators.js';
import { getExportColumns } from '../exports/exportMappers.js';
import { getFormulaTooltip } from '../tooltips/tooltipBuilder.js';
import { getReportingPerformanceRecommendations } from '../api/reportingPerformanceRecommendations.js';

export const FINAL_DASHBOARD_TILE_IDS = [
  'sales_reports',
  'modifier_report',
  'menu_recipe_health',
  'stock_control',
  'stock_on_hand',
  'stock_out_forecast',
  'price_volatility_analysis',
  'theoretical_vs_actual',
  'purchase_orders_report',
  'grv_log',
  'credit_notes_report',
  'inventory_audit',
  'operations_dashboard',
  'detailed_activity',
  'wastage',
  'stock_take_audit',
  'adjustments',
  'stock_transfers',
  'manufacturing_transactions'
];

export const DUPLICATE_TILE_IDS_THAT_MUST_STAY_HIDDEN = [
  'payment_sales_financial',
  'sale_stock_movement',
  'modifier_gp_tracker',
  'modifier_summary',
  'modifier_sales_log',
  'low_stock_alert',
  'reorder_report',
  'supplier_reorder_report',
  'menu_health',
  'recipe_health',
  'inventory_change_audit',
  'cost_change_audit',
  'recipe_change_audit',
  'stock_movement',
  'low_stock_alerts',
  'inventory_change'
];

export const REQUIRED_REDIRECT_TARGETS = {
  payment_sales_financial: { targetId: 'sales_reports', activeReportId: 'payment_sales_financial' },
  sale_stock_movement: { targetId: 'sales_reports', activeReportId: 'sale_stock_movement' },
  modifier_gp_tracker: { targetId: 'modifier_report', view: 'gp_tracker' },
  modifier_summary: { targetId: 'modifier_report', view: 'summary' },
  modifier_sales_log: { targetId: 'modifier_report', view: 'sales_log' },
  low_stock_alert: { targetId: 'stock_control', view: 'item_detail' },
  reorder_report: { targetId: 'stock_control', view: 'reorder_detail' },
  supplier_reorder_report: { targetId: 'stock_control', view: 'reorder_detail' },
  menu_health: { targetId: 'menu_recipe_health', view: 'menu_items' },
  recipe_health: { targetId: 'menu_recipe_health', view: 'recipe_detail' },
  inventory_change_audit: { targetId: 'inventory_audit', view: 'change_log' },
  cost_change_audit: { targetId: 'inventory_audit', view: 'cost_changes' },
  recipe_change_audit: { targetId: 'inventory_audit', view: 'recipe_changes' },
  stock_movement: { targetId: 'detailed_activity' },
  low_stock_alerts: { targetId: 'stock_control' },
  inventory_change: { targetId: 'inventory_audit' }
};

export const REQUIRED_FINAL_REPORT_VIEWS = {
  sales_reports: ['payment_sales_financial', 'sale_stock_movement'],
  modifier_report: ['summary', 'gp_tracker', 'by_group', 'by_menu_item', 'by_modifier', 'sales_log'],
  menu_recipe_health: ['overview', 'menu_items', 'recipe_detail', 'pricing', 'warnings'],
  stock_control: ['location_summary', 'category_summary', 'item_detail', 'reorder_detail', 'warnings'],
  stock_on_hand: ['summary', 'by_location', 'by_category', 'by_item', 'line_detail'],
  stock_out_forecast: ['forecast_summary', 'risk_matrix', 'by_location', 'by_category', 'by_item', 'usage_detail'],
  price_volatility_analysis: ['summary', 'volatility_matrix', 'by_supplier', 'by_category', 'by_item', 'price_history'],
  theoretical_vs_actual: ['summary', 'variance_heatmap', 'by_location', 'by_category', 'by_item', 'variance_detail', 'formula_breakdown'],
  purchase_orders_report: ['summary', 'by_supplier', 'by_location', 'by_status', 'line_detail'],
  grv_log: ['summary', 'by_supplier', 'by_location', 'by_item', 'line_detail'],
  credit_notes_report: ['summary', 'by_supplier', 'by_location', 'by_reason', 'line_detail'],
  inventory_audit: ['change_log', 'by_user', 'by_entity', 'cost_changes', 'recipe_changes', 'data_quality'],
  operations_dashboard: ['overview', 'by_category', 'by_item', 'movement_ledger'],
  detailed_activity: ['ledger'],
  wastage: ['summary', 'by_source', 'menu_items', 'by_category', 'by_item', 'line_detail'],
  stock_take_audit: ['sessions', 'by_category', 'by_item', 'count_detail', 'variance_movements'],
  adjustments: ['summary', 'by_source', 'menu_items', 'by_reason', 'by_category', 'by_item', 'line_detail'],
  stock_transfers: ['summary', 'by_item', 'by_location', 'line_detail', 'movement_ledger'],
  manufacturing_transactions: ['batches', 'by_manufactured_item', 'by_location', 'ingredient_usage', 'wastage', 'line_detail']
};

export const REQUIRED_TOOLTIP_KEYS = [
  'netSales',
  'salesVat',
  'payoutAmount',
  'stockValueUsed',
  'grossProfit',
  'gpPercent',
  'foodCostPercent',
  'expectedClosingValue',
  'stockTakeVarianceValue',
  'wastageValue',
  'transferValue',
  'requiredQty',
  'estimatedReorderValue',
  'lineCost',
  'selectedPercent',
  'averageSellingPrice',
  'auditCostDifference',
  'auditChangePercent',
  'stockValue',
  'stockOnHandStatus',
  'poLineValueExVat',
  'qtyOutstanding',
  'outstandingValue',
  'grvLineValueExVat',
  'grvTotalValueExVat',
  'creditLineValueExVat',
  'creditNoteVat',
  'averageDailyUsage',
  'weightedDailyUsage',
  'daysUntilStockOut',
  'forecastStockOutDate',
  'coveragePercent',
  'advancedRiskScore',
  'weightedAverageCost',
  'costChangePercent',
  'volatilityPercent',
  'coefficientOfVariation',
  'theoreticalUsage',
  'expectedClosingStock',
  'advancedVarianceQty',
  'advancedVarianceValue',
  'advancedAccuracyPercent',
  'varianceImpactScore'
];

export const EXPORT_FORBIDDEN_KEYS = new Set([
  'actions',
  'button',
  'buttons',
  'icon',
  'icons',
  'tooltip',
  'cellTooltip',
  'component',
  'element',
  'raw',
  'rawJson',
  'uiState',
  '__meta',
  '__apiMeta',
  '__apiWarnings',
  '__lines',
  'reportSourceRow',
  'rawSourceRow'
]);

export function auditFinalDashboardTiles() {
  const visibleReports = listReports();
  const visibleIds = visibleReports.map((report) => report.id);
  return {
    ok: sameMembers(visibleIds, FINAL_DASHBOARD_TILE_IDS),
    visibleIds,
    expectedIds: FINAL_DASHBOARD_TILE_IDS,
    duplicateIdsVisible: DUPLICATE_TILE_IDS_THAT_MUST_STAY_HIDDEN.filter((id) => visibleIds.includes(id))
  };
}

export function auditGroupedAndSingleReportViews() {
  const problems = [];
  Object.entries(REQUIRED_FINAL_REPORT_VIEWS).forEach(([reportId, expectedViews]) => {
    const report = getReportDefinition(reportId);
    if (!report) {
      problems.push(`${reportId} is not registered.`);
      return;
    }
    if (report.type === 'group') {
      const childIds = (report.reports || []).map((child) => child.id);
      if (!sameMembers(childIds, expectedViews)) problems.push(`${reportId} grouped reports differ. Expected ${expectedViews.join(', ')}; got ${childIds.join(', ')}.`);
      return;
    }
    const views = report.availableViews || [];
    if (!sameMembers(views, expectedViews)) problems.push(`${reportId} views differ. Expected ${expectedViews.join(', ')}; got ${views.join(', ')}.`);
  });
  return { ok: problems.length === 0, problems };
}

export function auditOldReportRedirects() {
  const problems = [];
  Object.entries(REQUIRED_REDIRECT_TARGETS).forEach(([sourceId, expected]) => {
    const actual = reportRedirects[sourceId];
    if (!actual) {
      problems.push(`${sourceId} is missing a redirect.`);
      return;
    }
    Object.entries(expected).forEach(([key, value]) => {
      if (actual[key] !== value) problems.push(`${sourceId}.${key} expected ${value}, got ${actual[key] || ''}.`);
    });
  });
  const visibleIds = listReports().map((report) => report.id);
  DUPLICATE_TILE_IDS_THAT_MUST_STAY_HIDDEN.forEach((id) => {
    if (visibleIds.includes(id)) problems.push(`${id} is visible on the dashboard but should be hidden behind a grouped/single consolidated tile.`);
  });
  return { ok: problems.length === 0, problems };
}

export function auditExportDefinitions() {
  const problems = [];
  const reports = listReports({ includeHidden: true }).flatMap((report) => {
    if (report.type !== 'group') return [report];
    return (report.reports || []).map((child) => getReportDefinition(child.id)).filter(Boolean);
  });

  reports.forEach((report) => {
    (report.availableViews || [report.defaultView]).forEach((view) => {
      const columns = getReportColumns(report, view);
      const exportColumns = getExportColumns({ report, view, columns, exportMapping: resolveExportMapping(report, view) });
      if (!exportColumns.length) problems.push(`${report.id}/${view} has no exportable columns.`);
      exportColumns.forEach((column) => {
        if (EXPORT_FORBIDDEN_KEYS.has(column.key)) problems.push(`${report.id}/${view} exports UI/internal key ${column.key}.`);
        if (column.type === 'money' && /cents/i.test(column.label || column.key)) problems.push(`${report.id}/${view} money column ${column.key} appears to export cents, not Rand values.`);
      });
    });
  });
  return { ok: problems.length === 0, problems };
}

export function auditRequiredTooltips() {
  const missing = REQUIRED_TOOLTIP_KEYS.filter((key) => !getFormulaTooltip(key)?.formula);
  return { ok: missing.length === 0, missing };
}

export function auditPerformanceRecommendations() {
  const recommendations = getReportingPerformanceRecommendations();
  const problems = [];
  ['workspaceId', 'from', 'to', 'locationId', 'categoryId', 'itemId', 'supplierId', 'sourceType', 'movementType', 'status', 'search', 'limit', 'offset'].forEach((param) => {
    if (!recommendations.queryParameters.includes(param)) problems.push(`Missing query parameter recommendation: ${param}`);
  });
  ['stockMovementIndexes', 'salesIndexes', 'auditIndexes', 'purchasingIndexes'].forEach((key) => {
    if (!Array.isArray(recommendations[key]) || recommendations[key].length === 0) problems.push(`Missing ${key} recommendations.`);
  });
  return { ok: problems.length === 0, problems, recommendations };
}

export function buildPhase19ReportingSignoff() {
  const checks = {
    dashboardTiles: auditFinalDashboardTiles(),
    reportViews: auditGroupedAndSingleReportViews(),
    redirects: auditOldReportRedirects(),
    exports: auditExportDefinitions(),
    tooltips: auditRequiredTooltips(),
    performance: auditPerformanceRecommendations()
  };
  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks
  };
}

function resolveExportMapping(report = {}, view = '') {
  if (report.exportMapping?.[view]) return report.exportMapping[view];
  return report.exportMapping || {};
}

function sameMembers(actual = [], expected = []) {
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
