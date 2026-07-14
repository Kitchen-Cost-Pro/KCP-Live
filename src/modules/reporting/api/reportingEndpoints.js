import { text } from '../engine/grouping.js';

export const REPORTING_USE_MOCK_ENV_KEY = 'VITE_REPORTING_USE_MOCK_DATA';

export function buildReportingEndpoint(workspaceId = '', reportPath = '', filters = {}) {
  const workspaceKey = text(workspaceId);
  const path = text(reportPath).replace(/^\/+/, '');
  const endpoint = `reports/${path}`;
  return {
    workspaceId: workspaceKey,
    resource: endpoint,
    query: buildReportingQuery(filters)
  };
}

export function buildReportingQuery(filters = {}) {
  const query = {};
  const from = text(filters.from || filters.dateFrom || filters.startDate);
  const to = text(filters.to || filters.dateTo || filters.endDate);
  const locationId = text(filters.locationId || filters.location_id);
  const categoryId = text(filters.categoryId || filters.category_id);
  const category = text(filters.category || filters.categoryName || filters.category_name);
  const itemId = text(filters.itemId || filters.item_id || filters.stockItemId || filters.stock_item_id);
  const menuItemId = text(filters.menuItemId || filters.menu_item_id || filters.productId || filters.product_id);
  const inventoryItemId = text(filters.inventoryItemId || filters.inventory_item_id || filters.stockItemId || filters.stock_item_id);
  const yocoCategory = text(filters.yocoCategory || filters.yoco_category || filters.yocoCategoryId || filters.yoco_category_id);
  const recipeStatus = text(filters.recipeStatus || filters.recipe_status);
  const riskStatus = text(filters.riskStatus || filters.risk_status);
  const warningSeverity = text(filters.warningSeverity || filters.warning_severity || filters.severity);
  const paymentMethod = text(filters.paymentMethod || filters.payment_method);
  const status = text(filters.status);
  const receiptNumber = text(filters.receiptNumber || filters.receipt_number);
  const menuCategory = text(filters.menuCategory || filters.menu_category);
  const inventoryCategory = text(filters.inventoryCategory || filters.inventory_category);
  const modifierGroupId = text(filters.modifierGroupId || filters.modifier_group_id);
  const modifierId = text(filters.modifierId || filters.modifier_id);
  const modifierType = text(filters.modifierType || filters.modifier_type);
  const modifierName = text(filters.modifierName || filters.modifier_name);
  const stockDeductionStatus = text(filters.stockDeductionStatus || filters.stock_deduction_status);
  const supplierId = text(filters.supplierId || filters.supplier_id);
  const supplier = text(filters.supplier || filters.supplierName || filters.supplier_name);
  const itemType = text(filters.itemType || filters.item_type);
  const onlyCritical = text(filters.onlyCritical || filters.only_critical);
  const onlyHighRisk = text(filters.onlyHighRisk || filters.only_high_risk);
  const onlyHighVolatility = text(filters.onlyHighVolatility || filters.only_high_volatility);
  const onlyItemsWithStockTake = text(filters.onlyItemsWithStockTake || filters.only_items_with_stock_take);
  const onlyNegativeVariance = text(filters.onlyNegativeVariance || filters.only_negative_variance);
  const onlyPositiveVariance = text(filters.onlyPositiveVariance || filters.only_positive_variance);
  const onlyBelowPar = text(filters.onlyBelowPar || filters.only_below_par);
  const missingSupplier = text(filters.missingSupplier || filters.missing_supplier);
  const missingCost = text(filters.missingCost || filters.missing_cost);
  const lookbackPeriod = text(filters.lookbackPeriod || filters.lookback_period);
  const costChangeThreshold = text(filters.costChangeThreshold || filters.cost_change_threshold);
  const volatilityThreshold = text(filters.volatilityThreshold || filters.volatility_threshold);
  const varianceThreshold = text(filters.varianceThreshold || filters.variance_threshold);
  const movementType = text(filters.movementType || filters.movement_type);
  const sourceType = text(filters.sourceType || filters.source || filters.source_type);
  const user = text(filters.user || filters.createdBy || filters.created_by);
  const action = text(filters.action);
  const entityType = text(filters.entityType || filters.entity_type);
  const entityName = text(filters.entityName || filters.entity_name);
  const search = text(filters.search);
  const time = text(filters.time);
  const limit = text(filters.limit);
  const offset = text(filters.offset);

  if (from) query.from = from;
  if (to) query.to = to;
  if (locationId) query.locationId = locationId;
  if (categoryId) query.categoryId = categoryId;
  if (category) query.category = category;
  if (itemId) query.itemId = itemId;
  if (menuItemId) query.menuItemId = menuItemId;
  if (inventoryItemId) query.inventoryItemId = inventoryItemId;
  if (yocoCategory) query.yocoCategory = yocoCategory;
  if (recipeStatus) query.recipeStatus = recipeStatus;
  if (riskStatus) query.riskStatus = riskStatus;
  if (warningSeverity) query.warningSeverity = warningSeverity;
  if (paymentMethod) query.paymentMethod = paymentMethod;
  if (status) query.status = status;
  if (receiptNumber) query.receiptNumber = receiptNumber;
  if (menuCategory) query.menuCategory = menuCategory;
  if (inventoryCategory) query.inventoryCategory = inventoryCategory;
  if (modifierGroupId) query.modifierGroupId = modifierGroupId;
  if (modifierId) query.modifierId = modifierId;
  if (modifierType) query.modifierType = modifierType;
  if (modifierName) query.modifierName = modifierName;
  if (stockDeductionStatus) query.stockDeductionStatus = stockDeductionStatus;
  if (supplierId) query.supplierId = supplierId;
  if (supplier) query.supplier = supplier;
  if (itemType) query.itemType = itemType;
  if (onlyCritical) query.onlyCritical = onlyCritical;
  if (onlyHighRisk) query.onlyHighRisk = onlyHighRisk;
  if (onlyHighVolatility) query.onlyHighVolatility = onlyHighVolatility;
  if (onlyItemsWithStockTake) query.onlyItemsWithStockTake = onlyItemsWithStockTake;
  if (onlyNegativeVariance) query.onlyNegativeVariance = onlyNegativeVariance;
  if (onlyPositiveVariance) query.onlyPositiveVariance = onlyPositiveVariance;
  if (onlyBelowPar) query.onlyBelowPar = onlyBelowPar;
  if (missingSupplier) query.missingSupplier = missingSupplier;
  if (missingCost) query.missingCost = missingCost;
  if (lookbackPeriod) query.lookbackPeriod = lookbackPeriod;
  if (costChangeThreshold) query.costChangeThreshold = costChangeThreshold;
  if (volatilityThreshold) query.volatilityThreshold = volatilityThreshold;
  if (varianceThreshold) query.varianceThreshold = varianceThreshold;
  if (movementType) query.movementType = movementType;
  if (sourceType) query.sourceType = sourceType;
  if (user) query.user = user;
  if (action) query.action = action;
  if (entityType) query.entityType = entityType;
  if (entityName) query.entityName = entityName;
  if (search) query.search = search;
  if (time) query.time = time;
  if (limit) query.limit = limit;
  if (offset) query.offset = offset;
  return query;
}

export function isReportingMockDataEnabled(services = {}) {
  if (services?.reporting?.useMockData === true) return true;
  const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined;
  return String(env?.[REPORTING_USE_MOCK_ENV_KEY] || '').toLowerCase() === 'true';
}
