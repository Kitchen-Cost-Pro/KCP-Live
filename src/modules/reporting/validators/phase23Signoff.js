import { getReportDefinition, listReports, reportRedirects, resolveReportRoute } from '../reports/index.js';
import { REPORT_DATA_SOURCE_CATALOG } from '../api/reportDataSourceCatalog.js';
import { getReportingPerformanceRecommendations } from '../api/reportingPerformanceRecommendations.js';
import { getFormulaTooltip } from '../tooltips/tooltipBuilder.js';
import { buildExportFileName } from '../exports/exportMappers.js';
import { auditExportDefinitions } from './phase19Signoff.js';
import { normalizeWarning, WARNING_CATEGORIES } from './warningCategories.js';
import {
  calculateExpectedClosingQty,
  calculateFoodCostPercent,
  calculateGpPercent,
  calculateGrossProfit,
  calculateNetFromGross,
  calculateNetMovement,
  calculateStockValue,
  calculateVarianceQty as calculateCoreVarianceQty,
  calculateVarianceValue as calculateCoreVarianceValue,
  calculateVatFromGross
} from '../engine/calculations.js';
import {
  calculateAverageDailyUsage,
  calculateDaysUntilStockOut,
  calculateEstimatedReorderValue,
  calculateForecastStockOutDate,
  calculateRecommendedReorderQty,
  calculateWeightedAverageUsage
} from '../engine/forecasting.js';
import {
  calculateAccuracyPercent,
  calculateCoefficientOfVariation,
  calculateCostChange,
  calculateCostChangePercent,
  calculateExpectedClosingStock,
  calculatePriceRange,
  calculateQuantityVariancePercent,
  calculateTheoreticalUsage,
  calculateVolatilityPercent,
  calculateWeightedAverageCost
} from '../engine/statistics.js';
import { calculateRiskScore } from '../engine/riskScoring.js';
import { ACTION_PERMISSION_MAP, hasLocationAccess, hasPermission, hasSectionAccess } from '../../../services/roleService.js';

export const PHASE23_EXPECTED_VISIBLE_REPORT_IDS = Object.freeze([
  'sales_reports',
  'modifier_report',
  'menu_recipe_health',
  'stock_control',
  'inventory_audit',
  'operations_dashboard',
  'detailed_activity',
  'wastage',
  'stock_take_audit',
  'adjustments',
  'stock_transfers',
  'manufacturing_transactions',
  'stock_on_hand',
  'purchase_orders_report',
  'grv_log',
  'credit_notes_report',
  'stock_out_forecast',
  'price_volatility_analysis',
  'theoretical_vs_actual'
]);

export const PHASE23_DUPLICATE_TILE_IDS = Object.freeze([
  'payment_sales_financial',
  'sale_stock_movement',
  'modifier_gp_tracker',
  'modifier_summary',
  'modifier_sales_log',
  'low_stock_alert',
  'inventory_change',
  'stock_movement',
  'menu_health',
  'recipe_health',
  'reorder_report',
  'supplier_reorder_report',
  'cost_change_audit',
  'recipe_change_audit'
]);

export const PHASE23_REQUIRED_REDIRECTS = Object.freeze({
  payment_sales_financial: { targetId: 'sales_reports', activeReportId: 'payment_sales_financial' },
  sale_stock_movement: { targetId: 'sales_reports', activeReportId: 'sale_stock_movement' },
  modifier_gp_tracker: { targetId: 'modifier_report', view: 'gp_tracker' },
  modifier_summary: { targetId: 'modifier_report', view: 'summary' },
  modifier_sales_log: { targetId: 'modifier_report', view: 'sales_log' },
  low_stock_alert: { targetId: 'stock_control' },
  inventory_change: { targetId: 'inventory_audit' },
  stock_movement: { targetId: 'detailed_activity' },
  menu_health: { targetId: 'menu_recipe_health' },
  recipe_health: { targetId: 'menu_recipe_health' },
  reorder_report: { targetId: 'stock_control' },
  supplier_reorder_report: { targetId: 'stock_control' },
  cost_change_audit: { targetId: 'inventory_audit' },
  recipe_change_audit: { targetId: 'inventory_audit' }
});

export const PHASE23_REQUIRED_TOOLTIP_KEYS = Object.freeze([
  'netSales', 'salesVat', 'payoutAmount', 'stockValue', 'movementValue', 'runningQty', 'runningValue',
  'expectedClosingQty', 'varianceQty', 'varianceValue', 'wastageValue', 'transferValue', 'requiredQty',
  'estimatedReorderValue', 'forecastStockOutDate', 'averageDailyUsage', 'weightedDailyUsage', 'costChange',
  'volatilityPercent', 'coefficientOfVariation', 'theoreticalUsage', 'advancedAccuracyPercent', 'grossProfit',
  'gpPercent', 'foodCostPercent', 'selectedPercent', 'averageSellingPrice'
]);

export function auditPhase23Registry() {
  const visibleIds = listReports().map((report) => report.id);
  const duplicateIdsVisible = PHASE23_DUPLICATE_TILE_IDS.filter((id) => visibleIds.includes(id));
  const missing = PHASE23_EXPECTED_VISIBLE_REPORT_IDS.filter((id) => !visibleIds.includes(id));
  const unexpected = visibleIds.filter((id) => !PHASE23_EXPECTED_VISIBLE_REPORT_IDS.includes(id));
  const repeated = visibleIds.filter((id, index) => visibleIds.indexOf(id) !== index);
  return {
    ok: !missing.length && !unexpected.length && !duplicateIdsVisible.length && !repeated.length,
    visibleIds,
    missing,
    unexpected,
    duplicateIdsVisible,
    repeated
  };
}

export function auditPhase23Routing() {
  const problems = [];
  Object.entries(PHASE23_REQUIRED_REDIRECTS).forEach(([legacyId, expected]) => {
    const redirect = reportRedirects[legacyId];
    const route = resolveReportRoute(legacyId);
    if (!redirect) {
      problems.push(`${legacyId} has no redirect.`);
      return;
    }
    if (!route?.redirected || route.reportId !== expected.targetId) {
      problems.push(`${legacyId} does not resolve to ${expected.targetId}.`);
    }
    if (expected.activeReportId && route?.activeReportId !== expected.activeReportId) {
      problems.push(`${legacyId} does not resolve grouped child ${expected.activeReportId}.`);
    }
    if (expected.view && route?.view !== expected.view) {
      problems.push(`${legacyId} does not resolve view ${expected.view}.`);
    }
  });
  return { ok: problems.length === 0, problems };
}

export function auditPhase23RealDataCatalog() {
  const requiredIds = new Set(PHASE23_EXPECTED_VISIBLE_REPORT_IDS);
  requiredIds.add('payment_sales_financial');
  requiredIds.add('sale_stock_movement');
  const problems = [];
  [...requiredIds].forEach((reportId) => {
    const source = REPORT_DATA_SOURCE_CATALOG[reportId];
    if (!source) {
      problems.push(`${reportId} has no data-source catalog entry.`);
      return;
    }
    if (!source.realDataOnly) problems.push(`${reportId} is not marked real-data-only.`);
    if (!source.workspaceScoped) problems.push(`${reportId} is not workspace scoped.`);
    if (!source.endpoints?.length) problems.push(`${reportId} has no documented reporting endpoint.`);
    if (!source.tables?.length) problems.push(`${reportId} has no documented source tables.`);
    if (!source.sourceIds?.length) problems.push(`${reportId} has no documented source identifier.`);
    if (!source.cleanLocationNames || !source.cleanItemNames || !source.cleanUserNames) {
      problems.push(`${reportId} does not document clean name resolution.`);
    }
  });
  return { ok: problems.length === 0, problems, catalog: REPORT_DATA_SOURCE_CATALOG };
}

export function auditPhase23FormulaContracts() {
  const checks = {
    netQty: calculateNetMovement(10, 3) === 7,
    movementValue: calculateStockValue(7, 50) === 350,
    expectedClosingQty: calculateExpectedClosingQty(100, 20, 35) === 85,
    varianceQty: calculateCoreVarianceQty(82, 85) === -3,
    varianceValue: calculateCoreVarianceValue(-3, 50) === -150,
    vat: almostEqual(calculateVatFromGross(115, 15), 15),
    netSales: almostEqual(calculateNetFromGross(115, 15), 100),
    grossProfit: calculateGrossProfit(100, 35) === 65,
    gpPercent: almostEqual(calculateGpPercent(65, 100), 0.65),
    foodCostPercent: almostEqual(calculateFoodCostPercent(35, 100), 0.35),
    averageDailyUsage: almostEqual(calculateAverageDailyUsage(70, 7), 10),
    weightedDailyUsage: almostEqual(calculateWeightedAverageUsage({ usage7Day: 70, usage14Day: 112, usage30Day: 180 }), 8.6),
    daysUntilStockOut: almostEqual(calculateDaysUntilStockOut(43, 8.6), 5),
    forecastStockOutDate: calculateForecastStockOutDate('2026-07-10', 5) === '2026-07-15',
    recommendedReorderQty: calculateRecommendedReorderQty(43, 100) === 57,
    estimatedReorderValue: calculateEstimatedReorderValue(57, 12.5) === 712.5,
    costChange: calculateCostChange(50, 60) === 10,
    costChangePercent: almostEqual(calculateCostChangePercent(50, 60), 0.2),
    priceRange: calculatePriceRange(50, 60) === 10,
    weightedAverageCost: almostEqual(calculateWeightedAverageCost([{ qty: 10, unitCost: 50 }, { qty: 30, unitCost: 60 }]), 57.5),
    volatilityPercent: almostEqual(calculateVolatilityPercent(50, 60, 57.5), 10 / 57.5),
    coefficientOfVariation: calculateCoefficientOfVariation([50, 55, 60]) > 0,
    theoreticalUsage: calculateTheoreticalUsage(25, 5, 10) === 40,
    theoreticalExpectedClosing: calculateExpectedClosingStock({ openingStock: 100, purchases: 20, transfersIn: 5, manufacturingIn: 0, theoreticalUsage: 35, wastage: 3, transfersOut: 5 }) === 82,
    theoreticalVariancePercent: almostEqual(calculateQuantityVariancePercent(-3, 82), -3 / 82),
    accuracyPercent: almostEqual(calculateAccuracyPercent(79, 82), 1 - (3 / 82)),
    riskScore: calculateRiskScore({ probability: 90, financialImpact: 70, urgency: 80, dataConfidence: 100 }) > 0
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
  return { ok: failed.length === 0, failed, checks };
}

export function auditPhase23Tooltips() {
  const missing = PHASE23_REQUIRED_TOOLTIP_KEYS.filter((key) => !getFormulaTooltip(key)?.formula);
  return { ok: missing.length === 0, missing };
}

export function auditPhase23Exports() {
  const baseAudit = auditExportDefinitions();
  const fileNames = {
    stockOnHand: buildExportFileName({ report: getReportDefinition('stock_on_hand'), view: 'summary', filters: { from: '2026-07-01', to: '2026-07-31' } }),
    grvLog: buildExportFileName({ report: getReportDefinition('grv_log'), view: 'summary', filters: { from: '2026-07-01', to: '2026-07-31' } }),
    purchaseOrders: buildExportFileName({ report: getReportDefinition('purchase_orders_report'), view: 'summary', filters: { from: '2026-07-01', to: '2026-07-31' } }),
    creditNotes: buildExportFileName({ report: getReportDefinition('credit_notes_report'), view: 'summary', filters: { from: '2026-07-01', to: '2026-07-31' } }),
    theoreticalByItem: buildExportFileName({ report: getReportDefinition('theoretical_vs_actual'), view: 'by_item', filters: { from: '2026-07-01', to: '2026-07-31' } })
  };
  const expected = {
    stockOnHand: 'KCP_Stock on Hand_2026-07-01-to-2026-07-31.csv',
    grvLog: 'KCP_GRV Log_2026-07-01-to-2026-07-31.csv',
    purchaseOrders: 'KCP_Purchase Orders_2026-07-01-to-2026-07-31.csv',
    creditNotes: 'KCP_Credit Notes_2026-07-01-to-2026-07-31.csv',
    theoreticalByItem: 'KCP_Theoretical vs Actual_by-item_2026-07-01-to-2026-07-31.csv'
  };
  const namingProblems = Object.keys(expected).filter((key) => fileNames[key] !== expected[key]).map((key) => `${key}: expected ${expected[key]}, got ${fileNames[key]}`);
  return { ok: baseAudit.ok && namingProblems.length === 0, problems: [...baseAudit.problems, ...namingProblems], fileNames };
}

export function auditPhase23Warnings() {
  const samples = {
    critical: normalizeWarning({ code: 'missing-unit-cost', level: 'critical', message: '1 row is missing unit cost.' }),
    coverage: normalizeWarning({ code: 'no-credit-note-source-rows', level: 'info', message: 'No Credit Note movements found for the selected filters.' }),
    backend: normalizeWarning({ code: 'backend-yoco-location-unmapped', level: 'warning', message: 'Backend mapping gap: Yoco location not mapped.' })
  };
  const problems = [];
  if (samples.critical.category !== WARNING_CATEGORIES.critical) problems.push('Missing unit cost was not classified as critical.');
  if (samples.coverage.category !== WARNING_CATEGORIES.coverage) problems.push('No rows in selected period was not classified as a coverage note.');
  if (samples.backend.category !== WARNING_CATEGORIES.backend) problems.push('Backend mapping gap was not classified correctly.');
  return { ok: problems.length === 0, problems, samples };
}

export function auditPhase23Performance() {
  const recommendations = getReportingPerformanceRecommendations();
  const problems = [];
  ['workspaceId', 'from', 'to', 'locationId', 'categoryId', 'itemId', 'supplierId', 'sourceType', 'movementType', 'status', 'search', 'limit', 'offset'].forEach((param) => {
    if (!recommendations.queryParameters.includes(param)) problems.push(`Missing query parameter ${param}.`);
  });
  ['stockMovementIndexes', 'salesIndexes', 'purchasingIndexes', 'auditIndexes'].forEach((key) => {
    if (!recommendations[key]?.length) problems.push(`Missing ${key}.`);
  });
  ['detailed_activity', 'sale_stock_movement', 'modifier_report:sales_log', 'inventory_audit', 'grv_log', 'stock_on_hand', 'theoretical_vs_actual'].forEach((reportId) => {
    if (!recommendations.largeReports.includes(reportId)) problems.push(`${reportId} is missing from the large-report safe-limit list.`);
  });
  return { ok: problems.length === 0, problems, recommendations };
}

export function auditPhase23Permissions() {
  const problems = [];
  ['owner', 'admin', 'manager'].forEach((role) => {
    if (!hasSectionAccess('reporting', role)) problems.push(`${role} cannot access reporting.`);
  });
  if (hasSectionAccess('reporting', 'member')) problems.push('Member unexpectedly has reporting access.');
  if (!hasPermission(ACTION_PERMISSION_MAP.scheduleReports, 'manager')) problems.push('Manager cannot schedule reports.');
  if (!hasPermission(ACTION_PERMISSION_MAP.emailReports, 'manager')) problems.push('Manager cannot email reports.');
  if (hasPermission(ACTION_PERMISSION_MAP.scheduleReports, 'member')) problems.push('Member unexpectedly can schedule reports.');
  const customRole = [{ name: 'location-reporter', permissions: ['nav-reporting'], locations: ['loc-a'] }];
  if (!hasLocationAccess('loc-a', 'location-reporter', customRole)) problems.push('Permitted custom-role location is blocked.');
  if (hasLocationAccess('loc-b', 'location-reporter', customRole)) problems.push('Unpermitted custom-role location is allowed.');
  return { ok: problems.length === 0, problems };
}

export function buildPhase23ReportingSignoff() {
  const checks = {
    registry: auditPhase23Registry(),
    routing: auditPhase23Routing(),
    realDataCatalog: auditPhase23RealDataCatalog(),
    formulas: auditPhase23FormulaContracts(),
    tooltips: auditPhase23Tooltips(),
    exports: auditPhase23Exports(),
    warnings: auditPhase23Warnings(),
    performance: auditPhase23Performance(),
    permissions: auditPhase23Permissions()
  };
  return { ok: Object.values(checks).every((check) => check.ok), checks };
}

function almostEqual(actual, expected, tolerance = 0.000001) {
  return Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

export default buildPhase23ReportingSignoff;
