import {
  addMoney,
  calculateFoodCostPercent,
  calculateGpPercent,
  calculateGrossProfit,
  calculateNetFromGross,
  calculateVatFromGross,
  roundMoney,
  safeNumber
} from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { DEFAULT_REPORT_TIMEZONE, formatReportTime, resolveReportTimestamp, zonedDateTimeStrings } from '../../engine/timezone.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';

export const DEFAULT_VAT_RATE = 0.15;

function resolveSalesDateTime(row = {}) {
  const timeZone = text(row.reportingTimeZone || row.reporting_time_zone || row.timeZone || row.time_zone || row.__apiMeta?.timeZone) || DEFAULT_REPORT_TIMEZONE;
  const primary = text(row.occurredAt || row.occurred_at || row.saleAt || row.sale_at || row.saleDate || row.sale_date || row.date);
  const fallback = text(row.createdAt || row.created_at);
  const timestamp = resolveReportTimestamp(primary, fallback, timeZone);
  const local = timestamp ? zonedDateTimeStrings(timestamp, timeZone) : { date: '', time: '' };
  return {
    timeZone,
    date: text(row.saleDate || row.sale_date || row.date || local.date).slice(0, 10),
    time: formatReportTime(row.saleTime || row.sale_time || row.time || timestamp, timeZone, { includeSeconds: true })
  };
}


export function normalizeSalesFinancialRow(row = {}) {
  const saleDateTime = resolveSalesDateTime(row);
  const grossAmount = safeNumber(row.grossAmount ?? row.gross_amount);
  const suppliedVatRate = row.vatRate !== undefined || row.vat_rate !== undefined
    ? normalizeRate(row.vatRate ?? row.vat_rate)
    : 0;
  const vatRate = suppliedVatRate > 0 ? suppliedVatRate : DEFAULT_VAT_RATE;
  const status = text(row.status) || 'Unknown';
  const isRefund = status.toLowerCase().includes('refund') || text(row.orderType || row.order_type).toLowerCase() === 'refund';
  const isVatExempt = booleanValue(row.isVatExempt ?? row.is_vat_exempt ?? row.vatExempt ?? row.vat_exempt ?? row.zeroRated ?? row.zero_rated)
    || /zero[ _-]?rated|tax[ _-]?exempt|vat[ _-]?exempt|non[ _-]?taxable/.test(text(row.vatSource || row.vat_source || row.taxStatus || row.tax_status).toLowerCase());
  const explicitVat = row.vatAmount ?? row.vat_amount;
  const explicitVatAmount = safeNumber(explicitVat);
  const explicitVatUsable = hasValue(explicitVat)
    && (explicitVatAmount > 0 || !grossAmount || isVatExempt || isRefund);
  const vatAmount = isRefund
    ? 0
    : explicitVatUsable
      ? explicitVatAmount
      : calculateVatFromGross(grossAmount, vatRate);
  const explicitNet = row.netAmount ?? row.net_amount;
  const explicitNetAmount = safeNumber(explicitNet);
  const explicitNetReconciles = hasValue(explicitNet)
    && Math.abs(roundMoney(grossAmount - vatAmount) - roundMoney(explicitNetAmount)) <= 0.011;
  const netAmount = isRefund
    ? 0
    : explicitNetReconciles
      ? explicitNetAmount
      : roundMoney(grossAmount - vatAmount);
  const refundAmount = Math.abs(safeNumber(row.refundAmount ?? row.refund_amount));
  const discountAmount = Math.abs(safeNumber(row.discountAmount ?? row.discount_amount));
  const tipAmount = Math.abs(safeNumber(row.tipAmount ?? row.tip_amount));
  const feeAmount = Math.abs(safeNumber(row.feeAmount ?? row.fee_amount));
  const payoutAmount = hasValue(row.payoutAmount ?? row.payout_amount)
    ? safeNumber(row.payoutAmount ?? row.payout_amount)
    : roundMoney(grossAmount - refundAmount - feeAmount + tipAmount);

  return {
    ...row,
    id: text(row.id || row.sourceId || row.source_id || row.receiptNumber || row.receipt_number),
    workspaceId: text(row.workspaceId || row.workspace_id),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name) || 'Unmapped Location',
    saleDate: saleDateTime.date,
    saleTime: saleDateTime.time,
    reportingTimeZone: saleDateTime.timeZone,
    receiptNumber: text(row.receiptNumber || row.receipt_number),
    paymentMethod: text(row.paymentMethod || row.payment_method) || 'Unknown',
    status,
    grossAmount,
    vatAmount,
    netAmount,
    discountAmount,
    refundAmount,
    tipAmount,
    feeAmount,
    payoutAmount,
    vatRate,
    isVatExempt,
    vatSource: text(row.vatSource || row.vat_source) || (isVatExempt ? 'zero-rated' : explicitVatUsable ? 'source' : 'calculated'),
    createdBy: text(row.createdBy || row.created_by),
    sourceId: text(row.sourceId || row.source_id || row.id),
    raw: row.raw || row
  };
}

export function normalizeSaleUsageRow(row = {}) {
  const saleDateTime = resolveSalesDateTime(row);
  const sourceType = text(row.sourceType || row.source_type || 'Sale Usage') || 'Sale Usage';
  const qtyUsed = Math.abs(safeNumber(row.qtyUsed ?? row.qty_used));
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost);
  const stockValueUsed = hasValue(row.stockValueUsed ?? row.stock_value_used)
    ? Math.abs(safeNumber(row.stockValueUsed ?? row.stock_value_used))
    : roundMoney(qtyUsed * unitCostExVat);
  const qtySold = Math.abs(safeNumber(row.qtySold ?? row.qty_sold ?? row.lineQuantity ?? row.line_quantity, 1)) || 1;
  const grossSaleAmount = safeNumber(row.grossSaleAmount ?? row.gross_sale_amount);
  const suppliedVatRate = row.vatRate !== undefined || row.vat_rate !== undefined
    ? normalizeRate(row.vatRate ?? row.vat_rate)
    : 0;
  const vatRate = suppliedVatRate > 0 ? suppliedVatRate : DEFAULT_VAT_RATE;
  const isVatExempt = booleanValue(row.isVatExempt ?? row.is_vat_exempt ?? row.vatExempt ?? row.vat_exempt ?? row.zeroRated ?? row.zero_rated)
    || /zero[ _-]?rated|tax[ _-]?exempt|vat[ _-]?exempt|non[ _-]?taxable/.test(text(row.vatSource || row.vat_source || row.taxStatus || row.tax_status).toLowerCase());
  const explicitVat = row.vatAmount ?? row.vat_amount;
  const explicitVatAmount = safeNumber(explicitVat);
  const explicitVatUsable = hasValue(explicitVat) && (explicitVatAmount > 0 || !grossSaleAmount || isVatExempt);
  const vatAmount = explicitVatUsable ? explicitVatAmount : calculateVatFromGross(grossSaleAmount, vatRate);
  const explicitNet = row.netSaleAmount ?? row.net_sale_amount;
  const explicitNetAmount = safeNumber(explicitNet);
  const explicitNetReconciles = hasValue(explicitNet)
    && Math.abs(roundMoney(grossSaleAmount - vatAmount) - roundMoney(explicitNetAmount)) <= 0.011;
  const netSaleAmount = explicitNetReconciles ? explicitNetAmount : roundMoney(grossSaleAmount - vatAmount);
  const recipeLineType = text(row.recipeLineType || row.recipe_line_type) || defaultRecipeLineType(row);
  const totalQtyUsed = hasValue(row.totalQtyUsed ?? row.total_qty_used) ? safeNumber(row.totalQtyUsed ?? row.total_qty_used) : qtyUsed;
  const ingredientQtyPerSale = hasValue(row.ingredientQtyPerSale ?? row.ingredient_qty_per_sale)
    ? safeNumber(row.ingredientQtyPerSale ?? row.ingredient_qty_per_sale)
    : (qtySold ? totalQtyUsed / qtySold : totalQtyUsed);

  return {
    ...row,
    id: text(row.id || row.sourceId || row.source_id),
    workspaceId: text(row.workspaceId || row.workspace_id),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name) || 'Unmapped Location',
    saleDate: saleDateTime.date,
    saleTime: saleDateTime.time,
    reportingTimeZone: saleDateTime.timeZone,
    receiptNumber: text(row.receiptNumber || row.receipt_number),
    saleId: text(row.saleId || row.sale_id),
    saleLineId: text(row.saleLineId || row.sale_line_id),
    menuItemId: text(row.menuItemId || row.menu_item_id),
    menuItemName: text(row.menuItemName || row.menu_item_name) || 'Unmapped Menu Item',
    menuCategory: text(row.menuCategory || row.menu_category || row.productCategory || row.product_category) || 'Uncategorised',
    modifierGroupId: text(row.modifierGroupId || row.modifier_group_id),
    modifierGroupName: text(row.modifierGroupName || row.modifier_group_name),
    modifierId: text(row.modifierId || row.modifier_id),
    modifierName: text(row.modifierName || row.modifier_name),
    inventoryItemId: text(row.inventoryItemId || row.inventory_item_id),
    inventoryItemName: text(row.inventoryItemName || row.inventory_item_name) || 'Unmapped Ingredient',
    inventoryCategoryId: text(row.inventoryCategoryId || row.inventory_category_id),
    inventoryCategoryName: text(row.inventoryCategoryName || row.inventory_category_name || row.category) || 'General',
    sourceType,
    sourceId: text(row.sourceId || row.source_id),
    qtySold,
    qtyUsed,
    totalQtyUsed,
    ingredientQtyPerSale,
    baseUom: text(row.baseUom || row.base_uom || row.uom) || 'ea',
    unitCostExVat,
    stockValueUsed,
    grossSaleAmount,
    vatAmount,
    netSaleAmount,
    vatRate,
    isVatExempt,
    vatSource: text(row.vatSource || row.vat_source) || (isVatExempt ? 'zero-rated' : explicitVatUsable ? 'source' : 'calculated'),
    recipeLineType,
    recipeName: text(row.recipeName || row.recipe_name || row.recipeSubRecipe || row.recipe_sub_recipe || row.menuItemName),
    recipeLevel: text(row.recipeLevel || row.recipe_level) || (recipeLineType === 'Sub-Recipe Ingredient' ? 'Level 2' : 'Level 1'),
    parentRecipe: text(row.parentRecipe || row.parent_recipe || row.menuItemName),
    linkedMenuItems: text(row.linkedMenuItems || row.linked_menu_items || row.menuItemName),
    saleCount: safeNumber(row.saleCount ?? row.sale_count, 1),
    createdBy: text(row.createdBy || row.created_by),
    raw: row.raw || row
  };
}

export function buildPaymentRows(rows = []) {
  return toArray(rows).map(normalizeSalesFinancialRow);
}

export function buildSaleUsageRows(rows = []) {
  return toArray(rows).map(normalizeSaleUsageRow);
}

export function buildPaymentModel(rows = []) {
  const normalized = buildPaymentRows(rows);
  return {
    sourceRows: normalized,
    views: {
      daily_summary: summarizePayments(normalized, (row) => [row.saleDate, row.locationId || row.locationName], (groupRows, key) => {
        const [date] = key.split('::');
        const first = groupRows[0] || {};
        return { date, locationName: first.locationName };
      }),
      by_payment_method: summarizePayments(normalized, (row) => [row.paymentMethod, row.locationId || row.locationName], (groupRows, key) => {
        const [paymentMethod] = key.split('::');
        const first = groupRows[0] || {};
        return { paymentMethod, locationName: first.locationName };
      }).map((row) => ({ ...row, averageTransactionValue: row.transactionCount ? roundMoney(row.grossSales / row.transactionCount) : 0 })),
      by_location: summarizePayments(normalized, (row) => [row.locationId || row.locationName], (groupRows) => ({ locationName: groupRows[0]?.locationName || 'Unmapped Location' }))
        .map((row, index) => ({ ...row, id: row.id || `payment-location:${index}`, refundCount: toArray(row.__rows).filter((item) => safeNumber(item.refundAmount) > 0 || text(item.status).toLowerCase().includes('refund')).length })),
      transaction_detail: normalized.map((row) => ({ ...row, date: row.saleDate, time: row.saleTime }))
    }
  };
}

export function buildSaleStockMovementModel(rows = []) {
  const normalized = buildSaleUsageRows(rows);
  const recipeRows = normalized.filter((row) => row.sourceType !== 'Modifier Usage');
  const modifierRows = normalized.filter((row) => row.sourceType === 'Modifier Usage');

  return {
    sourceRows: normalized,
    recipeRows,
    modifierRows,
    views: {
      summary: buildSalesMovementSummary(normalized),
      by_menu_item: buildByMenuItem(normalized),
      by_inventory_category: buildByInventoryCategory(normalized),
      by_inventory_item: buildByInventoryItem(normalized),
      recipe_line_detail: normalized.map(toRecipeLineDetailRow),
      transaction_detail: normalized.map(toUsageTransactionDetailRow)
    }
  };
}

export function paymentTotals(rows = [], includeAverage = false) {
  const totals = {
    label: 'Totals',
    grossSales: sumBy(rows, (row) => row.grossSales ?? row.grossAmount),
    discounts: sumBy(rows, (row) => row.discounts ?? row.discountAmount),
    refunds: sumBy(rows, (row) => row.refunds ?? row.refundAmount),
    vat: sumBy(rows, (row) => row.vat ?? row.vatAmount),
    netSales: sumBy(rows, (row) => row.netSales ?? row.netAmount),
    tips: sumBy(rows, (row) => row.tips ?? row.tipAmount),
    fees: sumBy(rows, (row) => row.fees ?? row.feeAmount),
    payoutAmount: sumBy(rows, (row) => row.payoutAmount),
    transactionCount: sumBy(rows, (row) => row.transactionCount ?? 1)
  };
  if (includeAverage) totals.averageTransactionValue = totals.transactionCount ? roundMoney(totals.grossSales / totals.transactionCount) : 0;
  return totals;
}

export function stockMovementTotals(rows = []) {
  const recipeStockValueUsed = sumBy(rows, (row) => row.recipeStockValueUsed ?? row.recipeStockCost ?? (row.sourceType === 'Modifier Usage' ? 0 : row.stockValueUsed));
  const modifierStockValueUsed = sumBy(rows, (row) => row.modifierStockValueUsed ?? row.modifierStockCost ?? (row.sourceType === 'Modifier Usage' ? row.stockValueUsed : 0));
  const totalStockValueUsed = sumBy(rows, (row) => row.totalStockValueUsed ?? row.totalStockCost ?? row.stockValueUsed) || addMoney(recipeStockValueUsed, modifierStockValueUsed);
  const netSales = sumBy(rows, (row) => row.netSales ?? row.netSaleAmount);
  const grossProfit = calculateGrossProfit(netSales, totalStockValueUsed);
  return {
    label: 'Totals',
    salesCount: sumBy(rows, (row) => row.salesCount ?? row.saleCount ?? 1),
    qtySold: sumBy(rows, (row) => row.qtySold),
    grossSales: sumBy(rows, (row) => row.grossSales ?? row.grossSaleAmount),
    vat: sumBy(rows, (row) => row.vat ?? row.vatAmount),
    netSales,
    qtyUsed: sumBy(rows, (row) => row.qtyUsed),
    recipeStockValueUsed,
    modifierStockValueUsed,
    totalStockValueUsed,
    recipeStockCost: recipeStockValueUsed,
    modifierStockCost: modifierStockValueUsed,
    totalStockCost: totalStockValueUsed,
    stockValueUsed: totalStockValueUsed,
    grossProfit,
    gpPercent: calculateGpPercent(grossProfit, netSales),
    foodCostPercent: calculateFoodCostPercent(totalStockValueUsed, netSales)
  };
}

export function moneyTooltip(key, values = '') {
  return buildRowFormulaTooltip(key, values);
}

function summarizePayments(rows, keySelector, baseSelector) {
  return Array.from(groupBy(rows, (row) => toArray(keySelector(row)).map(text).join('::')).entries()).map(([key, groupRows], index) => {
    const grossSales = sumBy(groupRows, 'grossAmount');
    const discounts = sumBy(groupRows, 'discountAmount');
    const refunds = sumBy(groupRows, 'refundAmount');
    const vat = sumBy(groupRows, 'vatAmount');
    const netSales = sumBy(groupRows, 'netAmount');
    const tips = sumBy(groupRows, 'tipAmount');
    const fees = sumBy(groupRows, 'feeAmount');
    const payoutAmount = sumBy(groupRows, 'payoutAmount');
    return {
      id: `payment-summary:${key || index}`,
      ...baseSelector(groupRows, key),
      grossSales,
      discounts,
      refunds,
      vat,
      netSales,
      tips,
      fees,
      payoutAmount,
      transactionCount: groupRows.length,
      __rows: groupRows
    };
  });
}

function buildSalesMovementSummary(rows = []) {
  return Array.from(groupBy(rows, (row) => [row.saleDate, row.locationId || row.locationName].map(text).join('::')).entries()).map(([key, groupRows], index) => {
    const [date] = key.split('::');
    const first = groupRows[0] || {};
    const recipeStockValueUsed = sumBy(groupRows, (row) => row.sourceType === 'Modifier Usage' ? 0 : row.stockValueUsed);
    const modifierStockValueUsed = sumBy(groupRows, (row) => row.sourceType === 'Modifier Usage' ? row.stockValueUsed : 0);
    const totalStockValueUsed = addMoney(recipeStockValueUsed, modifierStockValueUsed);
    const netSales = sumDistinctSales(groupRows, 'netSaleAmount');
    const grossSales = sumDistinctSales(groupRows, 'grossSaleAmount');
    const vat = sumDistinctSales(groupRows, 'vatAmount');
    const grossProfit = calculateGrossProfit(netSales, totalStockValueUsed);
    return {
      id: `sale-movement-summary:${key || index}`,
      date,
      locationName: first.locationName,
      salesCount: countDistinct(groupRows, (row) => row.saleId || row.receiptNumber || row.sourceId),
      grossSales,
      vat,
      netSales,
      recipeStockValueUsed,
      modifierStockValueUsed,
      totalStockValueUsed,
      grossProfit,
      gpPercent: calculateGpPercent(grossProfit, netSales),
      __rows: groupRows
    };
  });
}

function buildByMenuItem(rows = []) {
  return Array.from(groupBy(rows, (row) => [row.menuItemId || row.menuItemName, row.locationId || row.locationName].map(text).join('::')).entries()).map(([key, groupRows], index) => {
    const first = groupRows[0] || {};
    const recipeStockCost = sumBy(groupRows, (row) => row.sourceType === 'Modifier Usage' ? 0 : row.stockValueUsed);
    const modifierStockCost = sumBy(groupRows, (row) => row.sourceType === 'Modifier Usage' ? row.stockValueUsed : 0);
    const totalStockCost = addMoney(recipeStockCost, modifierStockCost);
    const netSales = sumDistinctSales(groupRows, 'netSaleAmount');
    const grossSales = sumDistinctSales(groupRows, 'grossSaleAmount');
    const vat = sumDistinctSales(groupRows, 'vatAmount');
    const grossProfit = calculateGrossProfit(netSales, totalStockCost);
    return {
      id: `sale-movement-menu:${key || index}`,
      menuItemName: first.menuItemName,
      menuCategory: first.menuCategory,
      locationName: first.locationName,
      qtySold: sumDistinctSales(groupRows, 'qtySold'),
      grossSales,
      vat,
      netSales,
      recipeStockCost,
      modifierStockCost,
      totalStockCost,
      grossProfit,
      gpPercent: calculateGpPercent(grossProfit, netSales),
      foodCostPercent: calculateFoodCostPercent(totalStockCost, netSales),
      __rows: groupRows
    };
  });
}

function buildByInventoryCategory(rows = []) {
  return Array.from(groupBy(rows, (row) => [row.saleDate, row.locationId || row.locationName, row.inventoryCategoryName].map(text).join('::')).entries()).map(([key, groupRows], index) => {
    const [date] = key.split('::');
    const first = groupRows[0] || {};
    const stockValueUsed = sumBy(groupRows, 'stockValueUsed');
    const linkedSalesNet = sumDistinctSales(groupRows, 'netSaleAmount');
    const grossProfit = calculateGrossProfit(linkedSalesNet, stockValueUsed);
    return {
      id: `sale-movement-inventory-category:${key || index}`,
      date,
      locationName: first.locationName,
      inventoryCategoryName: first.inventoryCategoryName,
      qtyUsed: sumBy(groupRows, 'qtyUsed'),
      baseUom: sameOrMixed(groupRows, 'baseUom'),
      stockValueUsed,
      linkedSalesNet,
      grossProfit,
      gpPercent: calculateGpPercent(grossProfit, linkedSalesNet),
      __rows: groupRows
    };
  });
}

function buildByInventoryItem(rows = []) {
  return Array.from(groupBy(rows, (row) => [row.inventoryItemId || row.inventoryItemName, row.locationId || row.locationName, row.sourceType].map(text).join('::')).entries()).map(([key, groupRows], index) => {
    const first = groupRows[0] || {};
    return {
      id: `sale-movement-inventory-item:${key || index}`,
      inventoryItemName: first.inventoryItemName,
      inventoryCategoryName: first.inventoryCategoryName,
      locationName: first.locationName,
      qtyUsed: sumBy(groupRows, 'qtyUsed'),
      baseUom: first.baseUom,
      unitCostExVat: weightedAverage(groupRows, 'unitCostExVat', 'qtyUsed'),
      stockValueUsed: sumBy(groupRows, 'stockValueUsed'),
      linkedMenuItems: distinctText(groupRows.map((row) => row.menuItemName)).join(', '),
      saleCount: countDistinct(groupRows, (row) => row.saleId || row.receiptNumber || row.sourceId),
      sourceType: first.sourceType,
      __rows: groupRows
    };
  });
}

function toRecipeLineDetailRow(row = {}) {
  return {
    ...row,
    id: `recipe-line:${row.id}`,
    saleDate: row.saleDate,
    saleTime: row.saleTime,
    receiptNumber: row.receiptNumber,
    locationName: row.locationName,
    menuItemSold: row.menuItemName,
    qtySold: row.qtySold,
    recipeLineType: row.recipeLineType,
    recipeSubRecipe: row.recipeName,
    inventoryIngredient: row.inventoryItemName,
    inventoryCategoryName: row.inventoryCategoryName,
    ingredientQtyPerSale: row.ingredientQtyPerSale,
    totalQtyUsed: row.totalQtyUsed,
    baseUom: row.baseUom,
    unitCostExVat: row.unitCostExVat,
    stockValueUsed: row.stockValueUsed,
    recipeLevel: row.recipeLevel,
    parentRecipe: row.parentRecipe,
    sourceType: row.sourceType,
    sourceId: row.sourceId
  };
}

function toUsageTransactionDetailRow(row = {}) {
  return {
    ...row,
    saleDate: row.saleDate,
    saleTime: row.saleTime,
    receiptNumber: row.receiptNumber,
    locationName: row.locationName,
    menuItemName: row.menuItemName,
    inventoryIngredient: row.inventoryItemName,
    inventoryCategoryName: row.inventoryCategoryName,
    sourceType: row.sourceType,
    qtyUsed: row.qtyUsed,
    baseUom: row.baseUom,
    unitCostExVat: row.unitCostExVat,
    stockValueUsed: row.stockValueUsed,
    grossSaleAmount: row.grossSaleAmount,
    vatAmount: row.vatAmount,
    netSaleAmount: row.netSaleAmount,
    createdBy: row.createdBy,
    sourceId: row.sourceId
  };
}

function sumDistinctSales(rows = [], key = '') {
  const seen = new Set();
  let total = 0;
  for (const row of rows) {
    const saleKey = text(row.saleLineId || row.saleId || row.receiptNumber || row.sourceId || row.id);
    const scoped = `${saleKey}:${key}`;
    if (saleKey && seen.has(scoped)) continue;
    seen.add(scoped);
    total += safeNumber(row[key]);
  }
  return roundMoney(total);
}

function countDistinct(rows = [], selector) {
  return new Set(toArray(rows).map(selector).map(text).filter(Boolean)).size || toArray(rows).length;
}

function distinctText(values = []) {
  return Array.from(new Set(toArray(values).map(text).filter(Boolean)));
}

function sameOrMixed(rows = [], key = '') {
  const values = distinctText(rows.map((row) => row[key]));
  return values.length <= 1 ? values[0] || '' : 'Mixed';
}

function weightedAverage(rows = [], valueKey = '', weightKey = '') {
  const totalWeight = sumBy(rows, weightKey);
  if (!totalWeight) return 0;
  return roundMoney(sumBy(rows, (row) => safeNumber(row[valueKey]) * safeNumber(row[weightKey])) / totalWeight);
}

function defaultRecipeLineType(row = {}) {
  const sourceType = text(row.sourceType || row.source_type);
  if (sourceType === 'Modifier Usage') return 'Modifier Ingredient';
  const raw = row.raw?.metadata || row.raw?.movement?.metadata || row.raw || {};
  const ownerType = text(raw.recipeOwnerType || raw.recipe_owner_type).toLowerCase();
  if (ownerType === 'stock_item') return 'Sub-Recipe Ingredient';
  if (raw.recipeSourceStockItemId || raw.recipe_source_stock_item_id) return 'Stock-Holding Prep Item';
  return 'Direct Ingredient';
}

function normalizeRate(value = 0) {
  const rate = safeNumber(value);
  return rate > 1 ? rate / 100 : rate;
}

function hasValue(value) {
  return value !== undefined && value !== null && text(value) !== '' && Number.isFinite(Number(value));
}

function booleanValue(value) {
  return value === true || value === 1 || value === '1' || text(value).toLowerCase() === 'true';
}
