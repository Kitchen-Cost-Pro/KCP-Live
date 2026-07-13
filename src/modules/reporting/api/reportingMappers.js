import { safeNumber } from '../engine/calculations.js';
import { text, toArray } from '../engine/grouping.js';
import { DEFAULT_REPORT_TIMEZONE, formatReportTime, resolveReportTimestamp, zonedDateTimeStrings } from '../engine/timezone.js';

function resolveApiReportDateTime(row = {}, meta = {}) {
  const timeZone = text(meta?.timeZone || meta?.timezone || row.reportingTimeZone || row.reporting_time_zone || row.timeZone || row.time_zone) || DEFAULT_REPORT_TIMEZONE;
  const primary = text(row.occurredAt || row.occurred_at || row.timestamp || row.saleAt || row.sale_at || row.movementDate || row.movement_date || row.date);
  const fallback = text(row.createdAt || row.created_at);
  const timestamp = resolveReportTimestamp(primary, fallback, timeZone);
  const local = timestamp ? zonedDateTimeStrings(timestamp, timeZone) : { date: '', time: '' };
  return {
    timeZone,
    timestamp,
    date: text(row.saleDate || row.sale_date || row.date || local.date).slice(0, 10),
    time: formatReportTime(row.saleTime || row.sale_time || row.time || timestamp, timeZone, { includeSeconds: true })
  };
}

function looksLikeTechnicalId(value = '') {
  const clean = text(value).trim();
  if (!clean) return false;
  if (/^prod_[a-z0-9-]+$/i.test(clean)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) return true;
  if (/^[0-9]{10,}[-:][a-z0-9:-]{8,}$/i.test(clean)) return true;
  if (/^[a-z0-9:-]{24,}$/i.test(clean) && /[0-9]/.test(clean) && /[-:]/.test(clean)) return true;
  return false;
}

function stripTechnicalIds(value = '') {
  return text(value)
    .replace(/\bprod_[a-z0-9-]+\b/gi, '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && !looksLikeTechnicalId(part))
    .join(' / ')
    .replace(/\s+[-–—:]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function displayNameOnly(...values) {
  for (const value of values) {
    const cleaned = stripTechnicalIds(value);
    if (cleaned && !looksLikeTechnicalId(cleaned)) return cleaned;
  }
  return '';
}

function yocoProductVariantLabel(row = {}) {
  const product = displayNameOnly(row.yocoProductName, row.yoco_product_name, row.productName, row.product_name, row.menuItemName, row.menu_item_name, row.name);
  const variant = displayNameOnly(row.yocoVariantName, row.yoco_variant_name, row.variantName, row.variant_name);
  if (product && variant && product.toLowerCase() !== variant.toLowerCase()) return `${product} / ${variant}`;
  return displayNameOnly(row.yocoProductVariant, row.yoco_product_variant, product, variant);
}

export function mapDetailedActivityLedgerResponse(response = {}) {
  const rows = toArray(response.rows).map((row, index) => normalizeApiLedgerRow(row, index, response.meta));
  return {
    rows,
    warnings: toArray(response.warnings),
    meta: {
      ...(response.meta || {}),
      dataSource: response.meta?.dataSource || 'real'
    }
  };
}

export function normalizeApiLedgerRow(row = {}, index = 0, meta = {}) {
  const qtyIn = safeNumber(row.qtyIn ?? row.qty_in);
  const qtyOut = safeNumber(row.qtyOut ?? row.qty_out);
  const netQty = row.netQty !== undefined && row.netQty !== null && text(row.netQty) !== ''
    ? safeNumber(row.netQty)
    : qtyIn - qtyOut;
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost);
  const movementValue = row.movementValue !== undefined && row.movementValue !== null && text(row.movementValue) !== ''
    ? safeNumber(row.movementValue)
    : netQty * unitCostExVat;
  const movementDateTime = resolveApiReportDateTime(row, meta);
  const movementDate = text(row.movementDate || row.movement_date || row.date || movementDateTime.date).slice(0, 10);
  const movementTime = formatReportTime(row.movementTime || row.movement_time || row.time || movementDateTime.timestamp, movementDateTime.timeZone, { includeSeconds: true });
  const timestamp = movementDateTime.timestamp || text(row.timestamp || row.occurredAt || row.occurred_at || row.movementDate || row.movement_date || row.createdAt || row.created_at);
  const sourceType = normalizeSourceType(row.sourceType || row.source_type || row.source || row.documentType || row.document_type);

  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta || {},
    id: text(row.id) || `reporting-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta?.workspaceId),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    itemId: text(row.itemId || row.item_id || row.stockItemId || row.stock_item_id),
    itemName: text(row.itemName || row.item_name || row.stockItemName || row.stock_item_name),
    categoryId: text(row.categoryId || row.category_id),
    categoryName: text(row.categoryName || row.category_name || row.category),
    category: text(row.categoryName || row.category_name || row.category) || 'General',
    movementDate,
    movementTime,
    reportingTimeZone: movementDateTime.timeZone,
    date: movementDate,
    time: movementTime || timestamp,
    timestamp,
    movementType: text(row.movementType || row.movement_type),
    sourceType,
    source: sourceType,
    sourceId: text(row.sourceId || row.source_id || row.documentId || row.document_id),
    documentNumber: text(row.documentNumber || row.document_number || row.reference || row.number),
    qtyIn,
    qtyOut,
    netQty,
    baseUom: text(row.baseUom || row.base_uom || row.unit || row.uom),
    unit: text(row.baseUom || row.base_uom || row.unit || row.uom),
    unitCostExVat,
    unitCost: unitCostExVat,
    movementValue,
    valueIn: qtyIn > 0 ? qtyIn * unitCostExVat : 0,
    valueOut: qtyOut > 0 ? qtyOut * unitCostExVat : 0,
    netValue: movementValue,
    runningQty: row.runningQty === null || row.running_qty === null ? null : safeNumber(row.runningQty ?? row.running_qty),
    runningValue: row.runningValue === null || row.running_value === null ? null : safeNumber(row.runningValue ?? row.running_value),
    createdBy: text(row.createdByName || row.created_by_name || row.createdBy || row.created_by || row.createdByEmail || row.created_by_email),
    createdByName: text(row.createdByName || row.created_by_name),
    notes: text(row.notes || row.note || row.reason),
    rawSourceRow: row.raw || row.rawSourceRow || row.raw_source_row || {},
    raw: row.raw || row.rawSourceRow || row.raw_source_row || row
  };
}

function normalizeSourceType(value = '') {
  const normalized = text(value).toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized.includes('credit')) return 'Credit Note';
  if (normalized.includes('purchase order') || normalized === 'po receive' || normalized === 'po receipt') return 'Purchase Order Receive';
  if (normalized === 'grv' || normalized.includes('goods receipt')) return 'GRV';
  if (normalized.includes('manufacturing wastage')) return 'Manufacturing Wastage';
  if (normalized.includes('manufacturing in') || normalized.includes('finished in')) return 'Manufacturing In';
  if (normalized.includes('manufacturing out') || normalized.includes('component out')) return 'Manufacturing Out';
  if (normalized.includes('stock take') || normalized.includes('stocktake')) return 'Stock Take Variance';
  if (normalized.includes('transfer in')) return 'Transfer In';
  if (normalized.includes('transfer out')) return 'Transfer Out';
  if (normalized.includes('modifier')) return 'Modifier Usage';
  if (normalized.includes('sale')) return 'Sale Usage';
  if (normalized.includes('manual wastage') || normalized.includes('wastage adjustment') || normalized === 'wastage') return 'Wastage Adjustment';
  if (normalized.includes('manual adjustment') || normalized === 'adjustment') return 'Manual Adjustment';
  return text(value) || 'Unknown Source';
}


export function mapStockTakeAuditResponse(response = {}) {
  return {
    rows: toArray(response.rows).map((row, index) => normalizeApiStockTakeRow(row, index, response.meta)),
    warnings: toArray(response.warnings),
    meta: {
      ...(response.meta || {}),
      dataSource: response.meta?.dataSource || 'real'
    }
  };
}

export function normalizeApiStockTakeRow(row = {}, index = 0, meta = {}) {
  const expectedQty = safeNumber(row.expectedQty ?? row.expected_qty ?? row.expectedBaseQty ?? row.expected_base_qty);
  const countedQty = safeNumber(row.countedQty ?? row.counted_qty ?? row.convertedBaseQty ?? row.converted_base_qty);
  const uomRatio = safeNumber(row.uomRatio ?? row.uom_ratio ?? 1, 1) || 1;
  const convertedBaseQty = safeNumber(row.convertedBaseQty ?? row.converted_base_qty ?? countedQty * uomRatio);
  const expectedBaseQty = safeNumber(row.expectedBaseQty ?? row.expected_base_qty ?? expectedQty);
  const varianceQty = row.varianceQty !== undefined && row.varianceQty !== null && text(row.varianceQty) !== ''
    ? safeNumber(row.varianceQty)
    : convertedBaseQty - expectedBaseQty;
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost);
  const expectedValue = row.expectedValue !== undefined && row.expectedValue !== null && text(row.expectedValue) !== ''
    ? safeNumber(row.expectedValue)
    : expectedBaseQty * unitCostExVat;
  const countedValue = row.countedValue !== undefined && row.countedValue !== null && text(row.countedValue) !== ''
    ? safeNumber(row.countedValue)
    : convertedBaseQty * unitCostExVat;
  const varianceValue = row.varianceValue !== undefined && row.varianceValue !== null && text(row.varianceValue) !== ''
    ? safeNumber(row.varianceValue)
    : countedValue - expectedValue;

  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta || {},
    id: text(row.id) || `stock-take-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta?.workspaceId),
    stockTakeSessionId: text(row.stockTakeSessionId || row.stock_take_session_id || row.sourceId || row.source_id),
    sourceId: text(row.sourceId || row.source_id || row.stockTakeSessionId || row.stock_take_session_id),
    stockTakeDate: text(row.stockTakeDate || row.stock_take_date || row.date || row.countedAt || row.counted_at).slice(0, 10),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    status: text(row.status || row.sessionStatus || row.session_status || 'posted'),
    itemId: text(row.itemId || row.item_id || row.stockItemId || row.stock_item_id),
    itemName: text(row.itemName || row.item_name || row.stockItemName || row.stock_item_name),
    category: text(row.category || row.categoryName || row.category_name) || 'General',
    itemType: text(row.itemType || row.item_type),
    isStocked: row.isStocked ?? row.is_stocked,
    countedUom: text(row.countedUom || row.counted_uom || row.unit || row.uom || row.baseUom || row.base_uom),
    baseUom: text(row.baseUom || row.base_uom || row.unit || row.uom || 'ea'),
    uomRatio,
    expectedQty,
    countedQty,
    convertedBaseQty,
    expectedBaseQty,
    varianceQty,
    unitCostExVat,
    expectedValue,
    countedValue,
    varianceValue,
    countedAt: text(row.countedAt || row.counted_at),
    committedBy: text(row.committedByName || row.committed_by_name || row.committedBy || row.committed_by || row.user),
    committedAt: text(row.committedAt || row.committed_at || row.updatedAt || row.updated_at || row.countedAt || row.counted_at),
    user: text(row.user || row.committedByName || row.committed_by_name || row.committedBy || row.committed_by),
    notes: text(row.notes || row.note),
    ledgerNetQty: safeNumber(row.ledgerNetQty ?? row.ledger_net_qty),
    ledgerMovementValue: safeNumber(row.ledgerMovementValue ?? row.ledger_movement_value),
    ledgerRowCount: safeNumber(row.ledgerRowCount ?? row.ledger_row_count),
    varianceMovementRowCount: safeNumber(row.varianceMovementRowCount ?? row.variance_movement_row_count),
    raw: row.raw || row
  };
}

export function mapSalesFinancialResponse(response = {}) {
  return {
    rows: toArray(response.rows).map((row, index) => normalizeApiSalesFinancialRow(row, index, response.meta)),
    warnings: toArray(response.warnings),
    meta: {
      ...(response.meta || {}),
      dataSource: response.meta?.dataSource || 'real'
    }
  };
}

export function normalizeApiSalesFinancialRow(row = {}, index = 0, meta = {}) {
  const saleDateTime = resolveApiReportDateTime(row, meta);
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta || {},
    id: text(row.id) || `sales-financial-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta?.workspaceId),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    saleDate: saleDateTime.date,
    saleTime: saleDateTime.time,
    reportingTimeZone: saleDateTime.timeZone,
    receiptNumber: text(row.receiptNumber || row.receipt_number || row.yocoOrderId || row.yoco_order_id || row.orderNumber),
    paymentMethod: text(row.paymentMethod || row.payment_method || 'Unknown'),
    status: text(row.status || 'completed'),
    vatRate: safeNumber(row.vatRate ?? row.vat_rate),
    vatSource: text(row.vatSource || row.vat_source),
    isVatExempt: row.isVatExempt ?? row.is_vat_exempt ?? false,
    grossAmount: safeNumber(row.grossAmount ?? row.gross_amount),
    vatAmount: safeNumber(row.vatAmount ?? row.vat_amount),
    netAmount: safeNumber(row.netAmount ?? row.net_amount),
    discountAmount: safeNumber(row.discountAmount ?? row.discount_amount),
    refundAmount: safeNumber(row.refundAmount ?? row.refund_amount),
    tipAmount: safeNumber(row.tipAmount ?? row.tip_amount),
    feeAmount: safeNumber(row.feeAmount ?? row.fee_amount),
    payoutAmount: safeNumber(row.payoutAmount ?? row.payout_amount),
    createdBy: text(row.createdBy || row.created_by || row.createdByName || row.created_by_name),
    sourceId: text(row.sourceId || row.source_id || row.yocoOrderId || row.yoco_order_id || row.id),
    raw: row.raw || row.rawSourceRow || row.raw_source_row || row
  };
}

export function mapSaleStockUsageResponse(response = {}) {
  return {
    rows: toArray(response.rows).map((row, index) => normalizeApiSaleStockUsageRow(row, index, response.meta)),
    warnings: toArray(response.warnings),
    meta: {
      ...(response.meta || {}),
      dataSource: response.meta?.dataSource || 'real'
    }
  };
}

export function normalizeApiSaleStockUsageRow(row = {}, index = 0, meta = {}) {
  const saleDateTime = resolveApiReportDateTime(row, meta);
  const qtyUsed = safeNumber(row.qtyUsed ?? row.qty_used ?? row.qtyOut ?? row.qty_out);
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost);
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta || {},
    id: text(row.id) || `sale-stock-usage-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta?.workspaceId),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    saleDate: saleDateTime.date,
    saleTime: saleDateTime.time,
    reportingTimeZone: saleDateTime.timeZone,
    receiptNumber: text(row.receiptNumber || row.receipt_number || row.yocoOrderId || row.yoco_order_id),
    saleId: text(row.saleId || row.sale_id || row.orderId || row.order_id || row.documentId || row.document_id),
    saleLineId: text(row.saleLineId || row.sale_line_id || row.lineId || row.line_id),
    menuItemId: text(row.menuItemId || row.menu_item_id || row.productId || row.product_id),
    menuItemName: text(row.menuItemName || row.menu_item_name || row.productName || row.product_name),
    menuCategory: text(row.menuCategory || row.menu_category || row.productCategory || row.product_category),
    qtySold: safeNumber(row.qtySold ?? row.qty_sold ?? row.lineQuantity ?? row.line_quantity, 1),
    modifierGroupId: text(row.modifierGroupId || row.modifier_group_id),
    modifierGroupName: text(row.modifierGroupName || row.modifier_group_name),
    modifierId: text(row.modifierId || row.modifier_id),
    modifierName: text(row.modifierName || row.modifier_name),
    inventoryItemId: text(row.inventoryItemId || row.inventory_item_id || row.itemId || row.item_id || row.stockItemId || row.stock_item_id),
    inventoryItemName: text(row.inventoryItemName || row.inventory_item_name || row.itemName || row.item_name || row.stockItemName || row.stock_item_name),
    inventoryCategoryId: text(row.inventoryCategoryId || row.inventory_category_id || row.categoryId || row.category_id),
    inventoryCategoryName: text(row.inventoryCategoryName || row.inventory_category_name || row.categoryName || row.category_name || row.category) || 'General',
    sourceType: text(row.sourceType || row.source_type || 'Sale Usage'),
    sourceId: text(row.sourceId || row.source_id || row.documentId || row.document_id),
    qtyUsed,
    baseUom: text(row.baseUom || row.base_uom || row.unit || row.uom || 'ea'),
    unitCostExVat,
    stockValueUsed: row.stockValueUsed !== undefined && row.stockValueUsed !== null && text(row.stockValueUsed) !== ''
      ? safeNumber(row.stockValueUsed)
      : qtyUsed * unitCostExVat,
    recipeLineType: text(row.recipeLineType || row.recipe_line_type),
    recipeName: text(row.recipeName || row.recipe_name || row.recipeSubRecipe || row.recipe_sub_recipe),
    recipeLevel: text(row.recipeLevel || row.recipe_level),
    parentRecipe: text(row.parentRecipe || row.parent_recipe),
    ingredientQtyPerSale: safeNumber(row.ingredientQtyPerSale ?? row.ingredient_qty_per_sale),
    totalQtyUsed: safeNumber(row.totalQtyUsed ?? row.total_qty_used ?? qtyUsed),
    grossSaleAmount: safeNumber(row.grossSaleAmount ?? row.gross_sale_amount),
    vatAmount: safeNumber(row.vatAmount ?? row.vat_amount),
    netSaleAmount: safeNumber(row.netSaleAmount ?? row.net_sale_amount),
    createdBy: text(row.createdBy || row.created_by || row.createdByName || row.created_by_name),
    raw: row.raw || row.rawSourceRow || row.raw_source_row || row
  };
}


export function mapModifierSalesResponse(response = {}) {
  return {
    rows: toArray(response.rows).map((row, index) => normalizeApiModifierSalesRow(row, index, response.meta)),
    warnings: toArray(response.warnings),
    meta: {
      ...(response.meta || {}),
      dataSource: response.meta?.dataSource || 'real'
    }
  };
}

export function normalizeApiModifierSalesRow(row = {}, index = 0, meta = {}) {
  const saleDateTime = resolveApiReportDateTime(row, meta);
  const grossAmount = safeNumber(row.grossAmount ?? row.gross_amount ?? row.grossSales ?? row.gross_sales);
  const vatAmount = safeNumber(row.vatAmount ?? row.vat_amount ?? row.vat);
  const netAmount = row.netAmount !== undefined || row.net_amount !== undefined || row.netSales !== undefined || row.net_sales !== undefined
    ? safeNumber(row.netAmount ?? row.net_amount ?? row.netSales ?? row.net_sales)
    : grossAmount - vatAmount;
  const stockQtyDeducted = safeNumber(row.stockQtyDeducted ?? row.stock_qty_deducted ?? row.stockDeducted ?? row.stock_deducted ?? row.qtyDeducted ?? row.qty_deducted);
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost);
  const stockCost = row.stockCost !== undefined || row.stock_cost !== undefined
    ? safeNumber(row.stockCost ?? row.stock_cost)
    : stockQtyDeducted * unitCostExVat;
  const grossProfit = row.grossProfit !== undefined || row.gross_profit !== undefined
    ? safeNumber(row.grossProfit ?? row.gross_profit)
    : netAmount - stockCost;
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta || {},
    id: text(row.id) || `modifier-sales-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta?.workspaceId),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    saleDate: saleDateTime.date,
    saleTime: saleDateTime.time,
    reportingTimeZone: saleDateTime.timeZone,
    receiptNumber: text(row.receiptNumber || row.receipt_number || row.yocoOrderId || row.yoco_order_id),
    paymentMethod: text(row.paymentMethod || row.payment_method),
    status: text(row.status),
    menuItemId: text(row.menuItemId || row.menu_item_id || row.productId || row.product_id),
    menuItemName: text(row.menuItemName || row.menu_item_name || row.productName || row.product_name),
    menuCategory: text(row.menuCategory || row.menu_category || row.productCategory || row.product_category),
    modifierGroupId: text(row.modifierGroupId || row.modifier_group_id),
    modifierGroupName: text(row.modifierGroupName || row.modifier_group_name || row.modifierGroup || row.modifier_group) || 'Modifier Group',
    modifierId: text(row.modifierId || row.modifier_id || row.yocoModifierId || row.yoco_modifier_id),
    yocoModifierId: text(row.yocoModifierId || row.yoco_modifier_id || row.modifierId || row.modifier_id),
    modifierName: text(row.modifierName || row.modifier_name) || 'Yoco Modifier',
    modifierType: text(row.modifierType || row.modifier_type) || 'Note',
    qty: safeNumber(row.qty ?? row.quantity ?? row.timesSelected ?? row.times_selected, 1),
    timesSelected: safeNumber(row.timesSelected ?? row.times_selected ?? row.qty ?? row.quantity, 1),
    grossAmount,
    vatAmount,
    netAmount,
    grossSales: safeNumber(row.grossSales ?? row.gross_sales ?? grossAmount),
    vat: safeNumber(row.vat ?? vatAmount),
    netSales: safeNumber(row.netSales ?? row.net_sales ?? netAmount),
    linkedProduct: text(row.linkedProduct || row.linked_product),
    linkedStockItemId: text(row.linkedStockItemId || row.linked_stock_item_id || row.inventoryItemId || row.inventory_item_id),
    linkedStockItemName: text(row.linkedStockItemName || row.linked_stock_item_name || row.inventoryItemName || row.inventory_item_name),
    stockQtyDeducted,
    stockDeducted: safeNumber(row.stockDeducted ?? row.stock_deducted ?? stockQtyDeducted),
    qtyDeducted: safeNumber(row.qtyDeducted ?? row.qty_deducted ?? stockQtyDeducted),
    baseUom: text(row.baseUom || row.base_uom || row.uom) || '',
    unitCostExVat,
    stockCost,
    grossProfit,
    gpPercent: row.gpPercent !== undefined || row.gp_percent !== undefined ? safeNumber(row.gpPercent ?? row.gp_percent) : (netAmount ? grossProfit / netAmount : 0),
    stockDeductionStatus: text(row.stockDeductionStatus || row.stock_deduction_status) || 'No Stock Mapping Required',
    createdBy: text(row.createdBy || row.created_by || row.createdByName || row.created_by_name),
    sourceId: text(row.sourceId || row.source_id || row.id),
    sourceType: text(row.sourceType || row.source_type || 'Modifier Usage'),
    hasModifierUsage: Boolean(row.hasModifierUsage ?? row.has_modifier_usage),
    modifierMarkedStockDeducting: Boolean(row.modifierMarkedStockDeducting ?? row.modifier_marked_stock_deducting),
    orphanUsage: Boolean(row.orphanUsage ?? row.orphan_usage),
    raw: row.raw || row.rawSourceRow || row.raw_source_row || row
  };
}

export function mapMenuRecipeHealthResponse(response = {}) {
  const meta = {
    ...(response.meta || {}),
    dataSource: response.meta?.dataSource || 'real'
  };
  return {
    rows: toArray(response.rows).map((row, index) => normalizeMenuRecipeHealthRow(row, index, meta)),
    recipeRows: toArray(response.recipeRows).map((row, index) => normalizeMenuRecipeRecipeRow(row, index, meta)),
    pricingRows: toArray(response.pricingRows).map((row, index) => normalizeMenuRecipePricingRow(row, index, meta)),
    warningRows: toArray(response.warningRows).map((row, index) => normalizeMenuRecipeWarningRow(row, index, meta)),
    warnings: toArray(response.warnings),
    meta
  };
}

export function normalizeMenuRecipeHealthRow(row = {}, index = 0, meta = {}) {
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id || row.productId || row.product_id) || `menu-recipe-health-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta.workspaceId),
    menuItemId: text(row.menuItemId || row.menu_item_id || row.productId || row.product_id || row.id),
    menuItemName: text(row.menuItemName || row.menu_item_name || row.productName || row.product_name || row.name),
    yocoProductVariant: yocoProductVariantLabel(row),
    yocoProductName: displayNameOnly(row.yocoProductName, row.yoco_product_name, row.menuItemName, row.menu_item_name, row.name),
    yocoVariantName: displayNameOnly(row.yocoVariantName, row.yoco_variant_name, row.variantName, row.variant_name),
    yocoCategory: text(row.yocoCategory || row.yoco_category || row.yocoCategoryName || row.yoco_category_name),
    category: text(row.category || row.menuCategory || row.menu_category) || 'Uncategorised',
    menuCategory: text(row.menuCategory || row.menu_category || row.category) || 'Uncategorised',
    locationPriceStatus: text(row.locationPriceStatus || row.location_price_status),
    sellingPriceInclVat: safeNumber(row.sellingPriceInclVat ?? row.selling_price_incl_vat),
    vatRate: safeNumber(row.vatRate ?? row.vat_rate),
    vat: safeNumber(row.vat ?? row.vatAmount ?? row.vat_amount),
    sellingPriceExVat: safeNumber(row.sellingPriceExVat ?? row.selling_price_ex_vat),
    recipeCostExVat: safeNumber(row.recipeCostExVat ?? row.recipe_cost_ex_vat),
    modifierCostRisk: text(row.modifierCostRisk || row.modifier_cost_risk || 'Not Checked'),
    foodCostPercent: safeNumber(row.foodCostPercent ?? row.food_cost_percent),
    grossProfit: safeNumber(row.grossProfit ?? row.gross_profit),
    gpPercent: safeNumber(row.gpPercent ?? row.gp_percent),
    recipeStatus: text(row.recipeStatus || row.recipe_status),
    stockDeductionStatus: text(row.stockDeductionStatus || row.stock_deduction_status),
    yocoMappingStatus: text(row.yocoMappingStatus || row.yoco_mapping_status),
    riskStatus: text(row.riskStatus || row.risk_status),
    warningsText: text(row.warningsText || row.warnings_text),
    raw: row.raw || row
  };
}

export function normalizeMenuRecipeRecipeRow(row = {}, index = 0, meta = {}) {
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `menu-recipe-detail-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta.workspaceId),
    menuItemId: text(row.menuItemId || row.menu_item_id),
    menuItemName: text(row.menuItemName || row.menu_item_name),
    recipeSubRecipe: text(row.recipeSubRecipe || row.recipe_sub_recipe || row.recipeName || row.recipe_name),
    recipeLevel: text(row.recipeLevel || row.recipe_level),
    recipeLineType: text(row.recipeLineType || row.recipe_line_type),
    ingredientId: text(row.ingredientId || row.ingredient_id || row.inventoryItemId || row.inventory_item_id),
    ingredientName: text(row.ingredientName || row.ingredient_name || row.inventoryItemName || row.inventory_item_name),
    inventoryCategory: text(row.inventoryCategory || row.inventory_category || row.inventoryCategoryName || row.inventory_category_name) || 'General',
    qtyRequired: safeNumber(row.qtyRequired ?? row.qty_required),
    baseUom: text(row.baseUom || row.base_uom || row.uom),
    unitCostExVat: safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat),
    lineCost: safeNumber(row.lineCost ?? row.line_cost),
    inStockQty: safeNumber(row.inStockQty ?? row.in_stock_qty),
    lowStockThreshold: safeNumber(row.lowStockThreshold ?? row.low_stock_threshold),
    status: text(row.status),
    warning: text(row.warning),
    sourceId: text(row.sourceId || row.source_id),
    raw: row.raw || row
  };
}

export function normalizeMenuRecipePricingRow(row = {}, index = 0, meta = {}) {
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `menu-recipe-pricing-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta.workspaceId),
    menuItemId: text(row.menuItemId || row.menu_item_id),
    menuItemName: text(row.menuItemName || row.menu_item_name),
    yocoProductName: displayNameOnly(row.yocoProductName, row.yoco_product_name),
    yocoVariantName: displayNameOnly(row.yocoVariantName, row.yoco_variant_name),
    yocoCategory: text(row.yocoCategory || row.yoco_category),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name || 'Default'),
    sellingPriceInclVat: safeNumber(row.sellingPriceInclVat ?? row.selling_price_incl_vat),
    vatRate: safeNumber(row.vatRate ?? row.vat_rate),
    vat: safeNumber(row.vat ?? row.vatAmount ?? row.vat_amount),
    sellingPriceExVat: safeNumber(row.sellingPriceExVat ?? row.selling_price_ex_vat),
    recipeCostExVat: safeNumber(row.recipeCostExVat ?? row.recipe_cost_ex_vat),
    grossProfit: safeNumber(row.grossProfit ?? row.gross_profit),
    gpPercent: safeNumber(row.gpPercent ?? row.gp_percent),
    foodCostPercent: safeNumber(row.foodCostPercent ?? row.food_cost_percent),
    priceStatus: text(row.priceStatus || row.price_status),
    warning: text(row.warning),
    riskStatus: text(row.riskStatus || row.risk_status),
    raw: row.raw || row
  };
}

export function normalizeMenuRecipeWarningRow(row = {}, index = 0, meta = {}) {
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `menu-recipe-warning-api-row:${index}`,
    severity: text(row.severity || row.level || 'Warning'),
    menuItemId: text(row.menuItemId || row.menu_item_id),
    menuItemName: text(row.menuItemName || row.menu_item_name),
    category: text(row.category || row.menuCategory || row.menu_category),
    yocoCategory: text(row.yocoCategory || row.yoco_category),
    issueType: text(row.issueType || row.issue_type || row.code),
    issue: text(row.issue || row.message),
    impact: text(row.impact),
    suggestedFix: text(row.suggestedFix || row.suggested_fix),
    sourceId: text(row.sourceId || row.source_id),
    riskStatus: text(row.riskStatus || row.risk_status || row.severity),
    raw: row.raw || row
  };
}

export function mapStockControlResponse(response = {}) {
  const meta = {
    ...(response.meta || {}),
    dataSource: response.meta?.dataSource || 'real'
  };
  return {
    rows: toArray(response.rows).map((row, index) => normalizeApiStockControlRow(row, index, meta)),
    warningRows: toArray(response.warningRows).map((row, index) => normalizeApiStockControlWarningRow(row, index, meta)),
    warnings: toArray(response.warnings),
    meta
  };
}

export function normalizeApiStockControlRow(row = {}, index = 0, meta = {}) {
  const currentStock = safeNumber(row.currentStock ?? row.current_stock ?? row.quantity);
  const lowStockThreshold = safeNumber(row.lowStockThreshold ?? row.low_stock_threshold ?? row.threshold_qty);
  const parLevel = safeNumber(row.parLevel ?? row.par_level ?? row.par_level_qty);
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost);
  const requiredQty = row.requiredQty !== undefined || row.required_qty !== undefined
    ? safeNumber(row.requiredQty ?? row.required_qty)
    : Math.max((parLevel || lowStockThreshold) - currentStock, 0);
  const purchaseUomRatio = safeNumber(row.purchaseUomRatio ?? row.purchase_uom_ratio, 1) || 1;
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `stock-control-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta.workspaceId),
    itemId: text(row.itemId || row.item_id || row.stockItemId || row.stock_item_id),
    itemName: text(row.itemName || row.item_name || row.stockItemName || row.stock_item_name),
    category: text(row.category || row.categoryName || row.category_name) || 'General',
    itemType: text(row.itemType || row.item_type),
    isStocked: row.isStocked ?? row.is_stocked,
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    currentStock,
    baseUom: text(row.baseUom || row.base_uom || row.uom || row.unit),
    lowStockThreshold,
    parLevel,
    requiredQty,
    unitCostExVat,
    estimatedReorderValue: row.estimatedReorderValue !== undefined || row.estimated_reorder_value !== undefined
      ? safeNumber(row.estimatedReorderValue ?? row.estimated_reorder_value)
      : requiredQty * unitCostExVat,
    supplierId: text(row.supplierId || row.supplier_id),
    supplierName: text(row.supplierName || row.supplier_name) || '',
    lastPurchaseCost: safeNumber(row.lastPurchaseCost ?? row.last_purchase_cost),
    lastPurchasedDate: text(row.lastPurchasedDate || row.last_purchased_date).slice(0, 10),
    purchaseUom: text(row.purchaseUom || row.purchase_uom),
    purchaseUomRatio,
    purchaseUomQty: row.purchaseUomQty !== undefined || row.purchase_uom_qty !== undefined
      ? safeNumber(row.purchaseUomQty ?? row.purchase_uom_qty)
      : (purchaseUomRatio ? requiredQty / purchaseUomRatio : 0),
    status: text(row.status),
    stockStatus: text(row.stockStatus || row.stock_status || row.status),
    suggestedAction: text(row.suggestedAction || row.suggested_action),
    lastUpdated: text(row.lastUpdated || row.last_updated || row.updated_at).slice(0, 10),
    sourceId: text(row.sourceId || row.source_id || row.itemId || row.item_id || row.stockItemId || row.stock_item_id),
    raw: row.raw || row
  };
}

export function normalizeApiStockControlWarningRow(row = {}, index = 0, meta = {}) {
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `stock-control-warning-api-row:${index}`,
    severity: text(row.severity || row.level || 'Warning'),
    itemId: text(row.itemId || row.item_id || row.stockItemId || row.stock_item_id),
    itemName: text(row.itemName || row.item_name || row.stockItemName || row.stock_item_name),
    category: text(row.category || row.categoryName || row.category_name) || 'General',
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    issueType: text(row.issueType || row.issue_type || row.code),
    issue: text(row.issue || row.message),
    impact: text(row.impact),
    suggestedFix: text(row.suggestedFix || row.suggested_fix),
    sourceId: text(row.sourceId || row.source_id || row.itemId || row.item_id || row.stockItemId || row.stock_item_id),
    raw: row.raw || row
  };
}


export function mapInventoryAuditResponse(response = {}) {
  const meta = {
    ...(response.meta || {}),
    dataSource: response.meta?.dataSource || 'real'
  };
  return {
    rows: toArray(response.rows).map((row, index) => normalizeApiInventoryAuditRow(row, index, meta)),
    costChangeRows: toArray(response.costChangeRows).map((row, index) => normalizeApiInventoryAuditCostRow(row, index, meta)),
    recipeChangeRows: toArray(response.recipeChangeRows).map((row, index) => normalizeApiInventoryAuditRecipeRow(row, index, meta)),
    dataQualityRows: toArray(response.dataQualityRows).map((row, index) => normalizeApiInventoryAuditQualityRow(row, index, meta)),
    warnings: toArray(response.warnings),
    meta
  };
}

export function normalizeApiInventoryAuditRow(row = {}, index = 0, meta = {}) {
  const reportDateTime = resolveApiReportDateTime(row, meta);
  const timestamp = reportDateTime.timestamp || text(row.timestamp || row.createdAt || row.created_at || row.date || '');
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `inventory-audit-api-row:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id || meta.workspaceId),
    date: text(row.date || reportDateTime.date || timestamp).slice(0, 10),
    time: formatReportTime(row.time || timestamp, reportDateTime.timeZone, { includeSeconds: true }),
    reportingTimeZone: reportDateTime.timeZone,
    user: text(row.user || row.createdByName || row.created_by_name || row.actorName || row.actor_name || row.actorUid || row.actor_uid || row.createdBy || row.created_by),
    action: text(row.action || row.eventType || row.event_type),
    entityType: text(row.entityType || row.entity_type),
    entityName: text(row.entityName || row.entity_name),
    fieldChanged: text(row.fieldChanged || row.field_changed),
    oldValue: row.oldValue ?? row.old_value ?? '',
    newValue: row.newValue ?? row.new_value ?? '',
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    source: text(row.source),
    sourceId: text(row.sourceId || row.source_id || row.entityId || row.entity_id),
    notes: text(row.notes || row.note),
    highRisk: Boolean(row.highRisk ?? row.high_risk),
    raw: row.raw || row
  };
}

export function normalizeApiInventoryAuditCostRow(row = {}, index = 0, meta = {}) {
  const reportDateTime = resolveApiReportDateTime(row, meta);
  const oldCostExVat = safeNumber(row.oldCostExVat ?? row.old_cost_ex_vat);
  const newCostExVat = safeNumber(row.newCostExVat ?? row.new_cost_ex_vat);
  const costDifference = row.costDifference !== undefined || row.cost_difference !== undefined
    ? safeNumber(row.costDifference ?? row.cost_difference)
    : newCostExVat - oldCostExVat;
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `inventory-audit-cost-api-row:${index}`,
    date: text(row.date || reportDateTime.date || row.createdAt || row.created_at).slice(0, 10),
    time: formatReportTime(row.time || reportDateTime.timestamp || row.createdAt || row.created_at, reportDateTime.timeZone, { includeSeconds: true }),
    reportingTimeZone: reportDateTime.timeZone,
    user: text(row.user || row.createdByName || row.created_by_name || row.createdBy || row.created_by),
    itemName: text(row.itemName || row.item_name || row.entityName || row.entity_name),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    oldCostExVat,
    newCostExVat,
    costDifference,
    changePercent: oldCostExVat ? costDifference / oldCostExVat : 0,
    source: text(row.source),
    sourceId: text(row.sourceId || row.source_id),
    reason: text(row.reason || row.notes),
    raw: row.raw || row
  };
}

export function normalizeApiInventoryAuditRecipeRow(row = {}, index = 0, meta = {}) {
  const reportDateTime = resolveApiReportDateTime(row, meta);
  const oldCostImpact = safeNumber(row.oldCostImpact ?? row.old_cost_impact);
  const newCostImpact = safeNumber(row.newCostImpact ?? row.new_cost_impact);
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `inventory-audit-recipe-api-row:${index}`,
    date: text(row.date || reportDateTime.date || row.createdAt || row.created_at).slice(0, 10),
    time: formatReportTime(row.time || reportDateTime.timestamp || row.createdAt || row.created_at, reportDateTime.timeZone, { includeSeconds: true }),
    reportingTimeZone: reportDateTime.timeZone,
    user: text(row.user || row.createdByName || row.created_by_name || row.createdBy || row.created_by),
    recipeName: text(row.recipeName || row.recipe_name || row.entityName || row.entity_name),
    menuItemName: text(row.menuItemName || row.menu_item_name),
    changeType: text(row.changeType || row.change_type || row.action),
    ingredientName: text(row.ingredientName || row.ingredient_name),
    oldQty: safeNumber(row.oldQty ?? row.old_qty),
    newQty: safeNumber(row.newQty ?? row.new_qty),
    oldUom: text(row.oldUom || row.old_uom),
    newUom: text(row.newUom || row.new_uom),
    oldCostImpact,
    newCostImpact,
    costImpactDifference: row.costImpactDifference !== undefined || row.cost_impact_difference !== undefined
      ? safeNumber(row.costImpactDifference ?? row.cost_impact_difference)
      : newCostImpact - oldCostImpact,
    sourceId: text(row.sourceId || row.source_id),
    raw: row.raw || row
  };
}

export function normalizeApiInventoryAuditQualityRow(row = {}, index = 0, meta = {}) {
  return {
    ...row,
    __fromReportingApi: true,
    __apiMeta: meta,
    id: text(row.id) || `inventory-audit-quality-api-row:${index}`,
    severity: text(row.severity || row.level || 'Warning'),
    area: text(row.area || 'Audit'),
    entityType: text(row.entityType || row.entity_type),
    entityName: text(row.entityName || row.entity_name),
    issueType: text(row.issueType || row.issue_type),
    issue: text(row.issue || row.message),
    impact: text(row.impact),
    suggestedFix: text(row.suggestedFix || row.suggested_fix),
    sourceId: text(row.sourceId || row.source_id),
    raw: row.raw || row
  };
}
