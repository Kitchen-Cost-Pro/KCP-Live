import { safeNumber } from '../engine/calculations.js';
import { text, toArray } from '../engine/grouping.js';
import { validateSalesFinancialRows, validateSaleStockUsageRows } from './salesUsageValidators.js';
import { buildRowWarnings } from './rowWarningUtils.js';

export function runDataQualityRules(dataSet = {}, reportResult = {}) {
  if (usesReportSpecificDataQuality(reportResult)) {
    return [];
  }
  return [
    ...missingItemNames(reportResult.rows),
    ...missingUnitCosts(reportResult.rows),
    ...missingLocationNames(reportResult.rows),
    // Dates are system-owned in the reporting engine. Rows without a user-facing
    // date are normalized by the ledger/API layer and should not create noisy
    // item-level errors for users.
    ...negativeQuantityWarnings(reportResult.rows),
    ...validateSalesFinancialRows(reportResult.rows),
    ...validateSaleStockUsageRows(reportResult.rows)
  ];
}

function usesReportSpecificDataQuality(reportResult = {}) {
  const reportId = text(reportResult.id || reportResult.report?.id);
  return ['menu_recipe_health', 'inventory_audit', 'stock_control'].includes(reportId);
}

function missingItemNames(rows = []) {
  return buildRowWarnings(rows, 'missing-item-name', 'critical', 'report row(s) are missing item names.', (row) => !isSummaryRow(row) && !text(row.itemName || row.stockItemName || row.productName) && hasItemContext(row));
}

function missingUnitCosts(rows = []) {
  return buildRowWarnings(rows, 'missing-unit-cost', 'critical', 'row(s) have zero unit cost. Value calculations may be understated.', (row) => !isSummaryRow(row) && hasValueContext(row) && safeNumber(row.unitCostExVat ?? row.unitCost) === 0);
}

function missingLocationNames(rows = []) {
  return buildRowWarnings(rows, 'missing-location-name', 'critical', 'row(s) have a location id but no clear location name.', (row) => !isSummaryRow(row) && text(row.locationId) && !text(row.locationName || row.fromLocationName || row.toLocationName));
}

function negativeQuantityWarnings(rows = []) {
  return buildRowWarnings(rows, 'negative-quantity', 'info', 'row(s) contain negative raw quantities. Use Qty In, Qty Out, or Net Movement for reporting.', (row) => !isSummaryRow(row) && (safeNumber(row.qty) < 0 || safeNumber(row.quantity) < 0));
}

function hasItemContext(row = {}) {
  return Boolean(row.itemId || row.stockItemId || row.productId);
}

function hasValueContext(row = {}) {
  return Boolean(row.itemId || row.stockItemId || row.productId) && Boolean(row.value || row.stockValue || row.valueIn || row.valueOut || row.varianceValue || row.qty || row.qtyIn || row.qtyOut);
}


function isSummaryRow(row = {}) {
  return Boolean(row.reportSummaryRow);
}
