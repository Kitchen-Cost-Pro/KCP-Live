import { safeNumber } from './calculations.js';
import { indexBy, text, toArray } from './grouping.js';

export function createReportingDataSet(input = {}) {
  const source = input?.source || input?.reportingData || input?.data || input || {};
  const stockItems = getStockItems(input, source);
  const products = getProducts(input, source);
  const locations = getLocations(input, source);
  const users = getUsers(input, source);
  const adjustments = getAdjustments(input, source);
  const stockTakes = getStockTakes(input, source);
  const transfers = getTransfers(input, source);
  const manufacturingLogs = getManufacturingLogs(input, source);
  const grvs = getGrvs(input, source);
  const creditNotes = getCreditNotes(input, source);
  const purchaseOrders = getPurchaseOrders(input, source);
  const purchaseOrderReceives = getPurchaseOrderReceives(input, source);
  const saleUsage = getSaleUsage(input, source);
  const modifierUsage = getModifierUsage(input, source);
  const ledgerRows = getLedgerRows(input, source);
  const stockSnapshots = getStockSnapshots(input, source);
  const openingStockSnapshots = getOpeningStockSnapshots(input, source);
  const closingStockSnapshots = getClosingStockSnapshots(input, source);
  const stockCostLookup = buildStockCostLookup(stockItems, products);
  const stockItemLookup = buildStockItemLookup(stockItems, products);
  const locationLookup = buildLocationLookup(locations);

  return {
    source,
    stockItems,
    products,
    locations,
    users,
    adjustments,
    stockTakes,
    transfers,
    manufacturingLogs,
    grvs,
    creditNotes,
    purchaseOrders,
    purchaseOrderReceives,
    saleUsage,
    modifierUsage,
    ledgerRows,
    stockSnapshots,
    openingStockSnapshots,
    closingStockSnapshots,
    stockCostLookup,
    stockItemLookup,
    locationLookup,
    updatedAt: source.updatedAt || input.updatedAt || new Date().toISOString()
  };
}

export function buildStockCostLookup(stockItems = [], products = []) {
  const byId = new Map();
  const byName = new Map();
  [...toArray(stockItems), ...toArray(products)].forEach((item) => {
    const id = text(item.id || item.stockItemId || item.itemId || item.productId);
    const name = text(item.name || item.itemName || item.stockItemName || item.productName);
    const unitCost = resolveUnitCost(item);
    if (id && !byId.has(id)) byId.set(id, unitCost);
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), unitCost);
  });
  return { byId, byName };
}

export function buildStockItemLookup(stockItems = [], products = []) {
  const byId = new Map();
  const byName = new Map();
  [...toArray(stockItems), ...toArray(products)].forEach((item) => {
    const id = text(item.id || item.stockItemId || item.itemId || item.productId);
    const name = text(item.name || item.itemName || item.stockItemName || item.productName);
    const normalized = {
      ...item,
      id,
      name,
      category: text(item.category || item.stockCategory || item.itemCategory || item.group || item.type),
      baseUom: text(item.baseUom || item.base_uom || item.unit || item.uom),
      unitCost: resolveUnitCost(item)
    };
    if (id && !byId.has(id)) byId.set(id, normalized);
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), normalized);
  });
  return { byId, byName };
}

export function resolveStockItem(item = {}, lookup = null) {
  if (!lookup) return null;
  const id = text(item.id || item.itemId || item.stockItemId || item.productId || item.ingredientId || item.ingId);
  const name = text(item.name || item.itemName || item.stockItemName || item.productName || item.ingredientName).toLowerCase();
  return (id && lookup.byId.get(id)) || (name && lookup.byName.get(name)) || null;
}

export function resolveUnitCost(item = {}, lookup = null) {
  const direct = safeNumber(
    item.unitCostExVat ??
    item.unitCostExVAT ??
    item.unitCost ??
    item.cost ??
    item.costEx ??
    item.cost_ex ??
    item.lastPurchasePrice ??
    item.last_purchase_price ??
    item.weightedAverageCost ??
    item.weighted_average_cost ??
    item.recipeCost ??
    item.baseRecipeCost ??
    0
  );
  if (direct) return direct;
  if (!lookup) return 0;
  const id = text(item.id || item.itemId || item.stockItemId || item.productId || item.ingredientId || item.ingId);
  const name = text(item.name || item.itemName || item.stockItemName || item.productName || item.ingredientName).toLowerCase();
  return safeNumber((id && lookup.byId.get(id)) || (name && lookup.byName.get(name)) || 0);
}

export function buildLocationLookup(locations = []) {
  return indexBy(locations, (location) => location.id || location.locationId || location.location_id || location.key);
}

export function resolveLocationName(locationId = '', locationLookup = new Map(), fallback = '') {
  const key = text(locationId);
  const location = key ? locationLookup.get(key) : null;
  return text(location?.displayName || location?.name || location?.locationName || fallback || key || 'Unassigned');
}

export function resolveClearLocationName(locationId = '', locationLookup = new Map(), fallback = '') {
  const key = text(locationId);
  const location = key ? locationLookup.get(key) : null;
  return text(location?.displayName || location?.name || location?.locationName || fallback);
}

function getStockItems(input, source) {
  return toArray(
    input?.stock?.items ||
    input?.stockItems ||
    source?.stockItems ||
    source?.items ||
    source?.stock?.items ||
    source?.ingredients ||
    []
  );
}

function getProducts(input, source) {
  return toArray(input?.menu?.products || input?.products || source?.products || source?.menuItems || []);
}

function getLocations(input, source) {
  return toArray(
    input?.locations?.items ||
    input?.locations?.locations ||
    input?.stock?.locations ||
    input?.grv?.locations ||
    input?.purchaseOrders?.locations ||
    input?.creditNotes?.locations ||
    input?.adjustments?.locations ||
    input?.transfers?.locations ||
    input?.manufacturing?.locations ||
    input?.locations ||
    source?.locations ||
    source?.stockLocations ||
    []
  );
}

function getUsers(input, source) {
  return toArray(input?.userManagement?.members || input?.users || source?.users || source?.members || []);
}

function getAdjustments(input, source) {
  return toArray(input?.adjustments?.adjustments || input?.adjustments || source?.adjustments || source?.adjustmentLogs || []);
}

function getStockTakes(input, source) {
  return toArray(input?.stockTake?.stockTakes || input?.stockTakes || source?.stockTakes || source?.stockTakeLogs || []);
}

function getTransfers(input, source) {
  return toArray(input?.transfers?.transfers || input?.transfers || source?.transfers || source?.transferLogs || []);
}

function getManufacturingLogs(input, source) {
  return toArray(input?.manufacturing?.logs || input?.manufacturingLogs || source?.manufacturingLogs || source?.manufacturing || []);
}

function getGrvs(input, source) {
  return toArray(input?.grv?.receipts || input?.grv?.grvs || input?.grvs || input?.receipts || source?.receipts || source?.grvs || source?.goodsReceipts || []);
}

function getCreditNotes(input, source) {
  return toArray(input?.creditNotes?.creditNotes || input?.creditNotes || source?.creditNotes || source?.supplierCreditNotes || []);
}

function getPurchaseOrders(input, source) {
  return toArray(input?.purchaseOrders?.orders || input?.purchaseOrders || source?.purchaseOrders || source?.orders || []);
}

function getPurchaseOrderReceives(input, source) {
  return toArray(
    input?.purchaseOrderReceives ||
    input?.poReceives ||
    input?.poReceipts ||
    source?.purchaseOrderReceives ||
    source?.poReceives ||
    source?.poReceipts ||
    []
  );
}

function getSaleUsage(input, source) {
  return toArray(
    input?.sales?.usage ||
    input?.salesUsage ||
    input?.saleUsage ||
    source?.salesUsage ||
    source?.saleUsage ||
    source?.menuItemUsage ||
    []
  );
}

function getModifierUsage(input, source) {
  return toArray(
    input?.modifiers?.usage ||
    input?.modifierUsage ||
    input?.modifierUsages ||
    source?.modifierUsage ||
    source?.modifierUsages ||
    source?.modifierItemUsage ||
    []
  );
}

function getLedgerRows(input, source) {
  return toArray(
    input?.ledgerRows ||
    input?.stockLedgerRows ||
    input?.stockMovements ||
    source?.ledgerRows ||
    source?.stockLedgerRows ||
    source?.stockMovements ||
    []
  );
}


function getStockSnapshots(input, source) {
  return toArray(input?.stockSnapshots || input?.stock?.snapshots || source?.stockSnapshots || source?.stock?.snapshots || []);
}

function getOpeningStockSnapshots(input, source) {
  return toArray(input?.openingStockSnapshots || input?.stock?.openingSnapshots || source?.openingStockSnapshots || source?.stock?.openingSnapshots || []);
}

function getClosingStockSnapshots(input, source) {
  return toArray(input?.closingStockSnapshots || input?.stock?.closingSnapshots || source?.closingStockSnapshots || source?.stock?.closingSnapshots || []);
}
