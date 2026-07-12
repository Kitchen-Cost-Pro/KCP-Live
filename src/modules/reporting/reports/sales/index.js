export * from './dataFoundation.js';
export { paymentSalesFinancialReport } from './paymentSalesFinancialReport.js';
export { saleStockMovementReport } from './saleStockMovementReport.js';
export { salesReportsGroup } from './salesReportsGroup.js';
export { modifierReport, modifierSummaryReport, modifierGpTrackerReport, modifierSalesLogReport } from './modifierReport.js';

import { fetchModifierSalesRows, fetchModifierUsageRows, fetchSalesFinancialRows, fetchSaleStockUsageRows } from '../../api/reportingApi.js';

// Phase 11 data foundation contracts reused by Phase 12/13 reports.
export const SALES_REPORTING_FOUNDATION_ENDPOINTS = {
  salesFinancial: '/reports/sales-financial',
  saleStockUsage: '/reports/sale-stock-usage',
  modifierUsage: '/reports/modifier-usage',
  modifierSales: '/reports/modifier-sales'
};

export async function loadSalesReportingFoundation({ workspaceId, filters } = {}) {
  const [salesFinancial, saleStockUsage, modifierUsage, modifierSales] = await Promise.all([
    fetchSalesFinancialRows({ workspaceId, filters }),
    fetchSaleStockUsageRows({ workspaceId, filters }),
    fetchModifierUsageRows({ workspaceId, filters }),
    fetchModifierSalesRows({ workspaceId, filters })
  ]);
  return { salesFinancial, saleStockUsage, modifierUsage, modifierSales };
}
