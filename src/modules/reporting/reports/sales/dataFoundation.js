import { fetchModifierSalesRows, fetchModifierUsageRows, fetchSalesFinancialRows, fetchSaleStockUsageRows } from '../../api/reportingApi.js';

// Phase 11 data foundation only. Full sales report definitions are intentionally deferred
// to the sales reporting phases that depend on these report-ready API contracts.
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
