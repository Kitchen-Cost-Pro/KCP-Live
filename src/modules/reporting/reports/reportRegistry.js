import { detailedActivityReport } from "./operations/detailedActivityReport.js";
import { operationsDashboardReport } from "./operations/operationsDashboardReport.js";
import { wastageReport } from "./operations/wastageReport.js";
import { stockTakeAuditReport } from "./operations/stockTakeAuditReport.js";
import { adjustmentsReport } from "./operations/adjustmentsReport.js";
import { stockTransfersReport } from "./operations/stockTransfersReport.js";
import { manufacturingTransactionsReport } from "./operations/manufacturingTransactionsReport.js";
import { menuRecipeHealthReport } from "./operations/menuRecipeHealthReport.js";
import { stockControlReport } from "./operations/stockControlReport.js";
import { inventoryAuditReport } from "./audit/index.js";
import { stockOnHandReport } from "./inventory/index.js";
import { purchaseOrdersReport, grvLogReport, creditNotesReport } from "./purchasing/index.js";
import { stockOutForecastReport, priceVolatilityReport, theoreticalVsActualReport } from "./advanced/index.js";
import {
  salesReportsGroup,
  paymentSalesFinancialReport,
  saleStockMovementReport,
  modifierReport,
  modifierSummaryReport,
  modifierGpTrackerReport,
  modifierSalesLogReport
} from "./sales/index.js";

const asSingleReport = (report, overrides = {}) => ({
  type: 'single',
  ...report,
  ...overrides
});

const asHiddenViewAlias = (report, { id, title, defaultView, redirectsTo, redirectView }) => asSingleReport(report, {
  id,
  title: title || report.title,
  defaultView: defaultView || report.defaultView,
  hiddenFromDashboard: true,
  internalReport: true,
  redirectsTo,
  redirectView: redirectView || defaultView || report.defaultView
});

export const reportRedirects = {
  stock_movement: {
    targetId: 'detailed_activity'
  },
  low_stock_alerts: {
    targetId: 'stock_control'
  },
  inventory_change: {
    targetId: 'inventory_audit'
  },
  payment_sales_financial: {
    targetId: 'sales_reports',
    activeReportId: 'payment_sales_financial'
  },
  sale_stock_movement: {
    targetId: 'sales_reports',
    activeReportId: 'sale_stock_movement'
  },
  modifier_summary: {
    targetId: 'modifier_report',
    view: 'summary'
  },
  modifier_gp_tracker: {
    targetId: 'modifier_report',
    view: 'gp_tracker'
  },
  modifier_sales_log: {
    targetId: 'modifier_report',
    view: 'sales_log'
  },
  low_stock_alert: {
    targetId: 'stock_control',
    view: 'item_detail'
  },
  reorder_report: {
    targetId: 'stock_control',
    view: 'reorder_detail'
  },
  supplier_reorder_report: {
    targetId: 'stock_control',
    view: 'reorder_detail'
  },
  below_par_report: {
    targetId: 'stock_control',
    view: 'reorder_detail'
  },
  menu_health: {
    targetId: 'menu_recipe_health',
    view: 'menu_items'
  },
  recipe_health: {
    targetId: 'menu_recipe_health',
    view: 'recipe_detail'
  },
  missing_recipes: {
    targetId: 'menu_recipe_health',
    view: 'warnings'
  },
  recipe_warnings: {
    targetId: 'menu_recipe_health',
    view: 'warnings'
  },
  pricing_warnings: {
    targetId: 'menu_recipe_health',
    view: 'pricing'
  },
  inventory_change_audit: {
    targetId: 'inventory_audit',
    view: 'change_log'
  },
  cost_change_audit: {
    targetId: 'inventory_audit',
    view: 'cost_changes'
  },
  recipe_change_audit: {
    targetId: 'inventory_audit',
    view: 'recipe_changes'
  },
  user_change_log: {
    targetId: 'inventory_audit',
    view: 'by_user'
  }
};

export const reportRegistry = [
  salesReportsGroup,
  asSingleReport(paymentSalesFinancialReport, { hiddenFromDashboard: true, internalReport: true }),
  asSingleReport(saleStockMovementReport, { hiddenFromDashboard: true, internalReport: true }),
  asSingleReport(modifierReport),
  asSingleReport(modifierSummaryReport, { hiddenFromDashboard: true, internalReport: true }),
  asSingleReport(modifierGpTrackerReport, { hiddenFromDashboard: true, internalReport: true }),
  asSingleReport(modifierSalesLogReport, { hiddenFromDashboard: true, internalReport: true }),
  asHiddenViewAlias(stockControlReport, { id: 'low_stock_alert', title: 'Low Stock Alert', defaultView: 'item_detail', redirectsTo: 'stock_control' }),
  asHiddenViewAlias(stockControlReport, { id: 'reorder_report', title: 'Reorder Report', defaultView: 'reorder_detail', redirectsTo: 'stock_control' }),
  asHiddenViewAlias(stockControlReport, { id: 'supplier_reorder_report', title: 'Supplier Reorder Report', defaultView: 'reorder_detail', redirectsTo: 'stock_control' }),
  asHiddenViewAlias(stockControlReport, { id: 'below_par_report', title: 'Below Par Report', defaultView: 'reorder_detail', redirectsTo: 'stock_control' }),
  asHiddenViewAlias(menuRecipeHealthReport, { id: 'menu_health', title: 'Menu Health', defaultView: 'menu_items', redirectsTo: 'menu_recipe_health' }),
  asHiddenViewAlias(menuRecipeHealthReport, { id: 'recipe_health', title: 'Recipe Health', defaultView: 'recipe_detail', redirectsTo: 'menu_recipe_health' }),
  asHiddenViewAlias(menuRecipeHealthReport, { id: 'missing_recipes', title: 'Missing Recipes', defaultView: 'warnings', redirectsTo: 'menu_recipe_health' }),
  asHiddenViewAlias(menuRecipeHealthReport, { id: 'recipe_warnings', title: 'Recipe Warnings', defaultView: 'warnings', redirectsTo: 'menu_recipe_health' }),
  asHiddenViewAlias(menuRecipeHealthReport, { id: 'pricing_warnings', title: 'Pricing Warnings', defaultView: 'pricing', redirectsTo: 'menu_recipe_health' }),
  asHiddenViewAlias(inventoryAuditReport, { id: 'inventory_change_audit', title: 'Inventory Change Audit', defaultView: 'change_log', redirectsTo: 'inventory_audit' }),
  asHiddenViewAlias(inventoryAuditReport, { id: 'cost_change_audit', title: 'Cost Change Audit', defaultView: 'cost_changes', redirectsTo: 'inventory_audit' }),
  asHiddenViewAlias(inventoryAuditReport, { id: 'recipe_change_audit', title: 'Recipe Change Audit', defaultView: 'recipe_changes', redirectsTo: 'inventory_audit' }),
  asHiddenViewAlias(inventoryAuditReport, { id: 'user_change_log', title: 'User Change Log', defaultView: 'by_user', redirectsTo: 'inventory_audit' }),
  asSingleReport(menuRecipeHealthReport),
  asSingleReport(stockControlReport),
  asSingleReport(stockOnHandReport),
  asSingleReport(stockOutForecastReport),
  asSingleReport(priceVolatilityReport),
  asSingleReport(theoreticalVsActualReport),
  asSingleReport(purchaseOrdersReport),
  asSingleReport(grvLogReport),
  asSingleReport(creditNotesReport),
  asSingleReport(inventoryAuditReport),
  asSingleReport(operationsDashboardReport),
  asSingleReport(detailedActivityReport),
  asSingleReport(wastageReport),
  asSingleReport(stockTakeAuditReport),
  asSingleReport(adjustmentsReport),
  asSingleReport(stockTransfersReport),
  asSingleReport(manufacturingTransactionsReport)
];
