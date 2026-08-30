import { safeNumber } from '../engine/calculations.js';
import { text, toArray } from '../engine/grouping.js';
import { buildRowWarnings, flattenWarnings } from './rowWarningUtils.js';

export function validateSalesFinancialRows(rows = []) {
  const salesRows = toArray(rows).filter((row) => hasSalesFinancialContext(row));
  return [
    countWarning(salesRows, grossEqualsNetWithVat, 'gross-equals-net-with-vat', 'critical', 'Gross equals Net on VAT-bearing sales rows. VAT mapping is likely wrong.'),
    countWarning(salesRows, (row) => text(row.vatRate || row.vat_rate) === '' && safeNumber(row.grossAmount) > 0 && safeNumber(row.vatAmount) === 0, 'missing-vat-rate', 'warning', 'Sales rows are missing VAT rate and have no VAT amount.'),
    countWarning(salesRows, (row) => !text(row.saleId || row.sourceId || row.id), 'missing-sale-id', 'critical', 'Sales rows are missing sale IDs.'),
    countWarning(salesRows, (row) => !text(row.receiptNumber), 'missing-receipt-number', 'warning', 'Sales rows are missing receipt numbers.'),
    countWarning(salesRows, (row) => !text(row.paymentMethod), 'missing-payment-method', 'warning', 'Sales rows are missing payment methods.')
  ].flatMap((warning) => flattenWarnings(warning)).filter(Boolean);
}

export function validateSaleStockUsageRows(rows = []) {
  const usageRows = toArray(rows).filter((row) => hasSaleUsageContext(row));
  return [
    countWarning(usageRows, (row) => !text(row.saleId), 'missing-sale-id', 'critical', 'Stock usage rows are missing sale IDs.'),
    countWarning(usageRows, (row) => !text(row.receiptNumber), 'missing-receipt-number', 'warning', 'Stock usage rows are missing receipt numbers.'),
    countWarning(usageRows, (row) => !text(row.inventoryItemId), 'missing-ingredient-stock-item', 'critical', 'Usage rows are missing ingredient stock item IDs.'),
    countWarning(usageRows, (row) => !text(row.baseUom), 'missing-uom-conversion', 'critical', 'Usage rows are missing base UOM values.'),
    countWarning(usageRows, (row) => safeNumber(row.unitCostExVat) === 0 && safeNumber(row.qtyUsed) !== 0, 'missing-unit-cost', 'critical', 'Usage rows are missing unit costs.'),
    countWarning(usageRows, (row) => text(row.recipeWarningCode) === 'missing-recipe', 'missing-recipe', 'critical', 'Sold recipe items are missing recipes.'),
    countWarning(usageRows, (row) => text(row.recipeWarningCode) === 'circular-recipe', 'circular-recipe', 'critical', 'Circular recipe relationships were detected.'),
    countWarning(usageRows, (row) => row.subRecipeDoubleCountingRisk === true, 'sub-recipe-double-counting-risk', 'warning', 'Sub-recipe double counting risk detected.'),
    countWarning(usageRows, (row) => text(row.sourceType) === 'Sale Usage' && row.expectedUsageMovement === true && row.hasUsageMovement === false, 'sale-usage-movement-missing', 'critical', 'Sale usage movement is missing for sold recipe items.'),
    countWarning(usageRows, (row) => text(row.sourceType) === 'Modifier Usage' && row.stockDeductingModifier === true && row.hasUsageMovement === false, 'modifier-usage-movement-missing', 'critical', 'Modifier usage movement is missing for stock-deducting modifiers.'),
    countWarning(usageRows, (row) => text(row.sourceType) === 'Modifier Usage' && row.stockDeductingModifier === true && !text(row.inventoryItemId), 'modifier-stock-mapping-missing', 'critical', 'Stock-deducting modifiers are missing stock mappings.'),
    countWarning(usageRows, (row) => text(row.sourceType) === 'Modifier Usage' && row.modifierMarkedStockDeducting === true && row.hasUsageMovement === false, 'modifier-marked-stock-deducting-no-movement', 'critical', 'Modifier is marked stock-deducting but no movement row exists.')
  ].flatMap((warning) => flattenWarnings(warning)).filter(Boolean);
}

function grossEqualsNetWithVat(row = {}) {
  const gross = safeNumber(row.grossAmount);
  const net = safeNumber(row.netAmount);
  const vat = safeNumber(row.vatAmount);
  const vatRate = safeNumber(row.vatRate ?? row.vat_rate);
  const isVatExempt = row.isVatExempt === true || row.is_vat_exempt === true || /zero[ _-]?rated|exempt|non[ _-]?taxable/.test(text(row.vatSource || row.vat_source).toLowerCase());
  const taxableContext = vat > 0 || vatRate > 0 || text(row.createdBy || row.created_by).toLowerCase() === 'yoco' || ['yoco', 'calculated', 'source'].includes(text(row.vatSource || row.vat_source).toLowerCase());
  return gross > 0 && Math.abs(gross - net) < 0.01 && taxableContext && !isVatExempt;
}

function hasSalesFinancialContext(row = {}) {
  return ['grossAmount', 'netAmount', 'paymentMethod', 'receiptNumber'].some((key) => row[key] !== undefined);
}

function hasSaleUsageContext(row = {}) {
  return ['qtyUsed', 'inventoryItemId', 'sourceType'].some((key) => row[key] !== undefined) && ['Sale Usage', 'Modifier Usage'].includes(text(row.sourceType));
}

function countWarning(rows = [], predicate, code, level, message) {
  return buildRowWarnings(toArray(rows), code, level, message, predicate);
}
