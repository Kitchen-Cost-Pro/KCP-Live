import { callCloudflareWorkspaceRoute, callOptionalCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchStock } from './stockService.js';
import { getStockValuationUnitCost } from './database.js';
import { normalizeAdjustmentLogs, normalizeWastageResponse } from './adjustmentLog.js';
import { DEFAULT_SITE_ID, normalizeSites, normalizeStockLocations } from './locationModel.js';
import { todayLocal } from '../utils/date.js';

export function subscribeAdjustmentsWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for adjustments.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchAdjustmentsWorkspace(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:adjustments');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchAdjustmentsWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for adjustments.');

  const [adjustmentResponse, wastageResponse, stockResponse, locationResponse, siteResponse, productResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'adjustments', { query: { limit: 500 } }),
    callOptionalCloudflareWorkspaceRoute(workspaceKey, 'wastage-adjustments', { query: { limit: 500 }, fallback: {} }),
    fetchStock(workspaceKey),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
    callCloudflareWorkspaceRoute(workspaceKey, 'site-configuration'),
    callCloudflareWorkspaceRoute(workspaceKey, 'products', { query: { limit: 500 } }).catch(() => ({ products: [] }))
  ]);

  const settings = { siteName: siteResponse.siteConfiguration?.site_name || 'Main Site' };
  const sites = normalizeSites([{ id: DEFAULT_SITE_ID, name: settings.siteName, isDefault: true }], settings);
  const locations = normalizeStockLocations((locationResponse.locations || []).map(normalizeCloudflareLocation), sites, settings);

  return {
    status: 'ready',
    source: 'Live adjustments',
    adjustments: sortAdjustments(normalizeAdjustmentLogs([
      ...(adjustmentResponse.adjustments || adjustmentResponse.items || []),
      ...normalizeWastageResponse(wastageResponse)
    ])),
    stockItems: sortByName(stockResponse.items || []),
    products: sortByName(normalizeProductsForWastage(
      productResponse.products || productResponse.items || [],
      buildStockCostLookup(stockResponse.items || [])
    )),
    sites: sortByName(sites),
    locations: sortByName(locations),
    loaded: {
      adjustments: true,
      stockItems: true,
      products: true,
      sites: true,
      locations: true
    },
    updatedAt: new Date().toISOString()
  };
}

export async function saveWastageAdjustment(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save wastage.');

  const draft = normalizeWastagePayload(payload);
  if (!draft.items.length) throw new Error('Select at least one menu item to waste.');
  if (!draft.wasteReason) throw new Error('Select a waste reason.');
  if (!draft.locationId) throw new Error('Select a location.');

  return callCloudflareWorkspaceRoute(workspaceKey, 'wastage-adjustments', {
    method: 'POST',
    payload: draft
  });
}

export async function saveManualAdjustments(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save adjustments.');

  const draft = normalizeAdjustmentPayload(payload);
  if (!draft.items.length) throw new Error('Add at least one stock item to the adjustment.');
  if (!draft.mode) throw new Error('Select an adjustment type first.');

  return callCloudflareWorkspaceRoute(workspaceKey, 'adjustments', {
    method: 'POST',
    payload: draft
  });
}

function normalizeAdjustmentPayload(payload = {}) {
  const mode = String(payload.mode || '').trim();
  return {
    id: String(payload.id || '').trim(),
    mode,
    date: String(payload.date || todayLocal()).trim(),
    locationId: String(payload.locationId || '').trim(),
    locationName: String(payload.locationName || '').trim(),
    note: String(payload.note || '').trim(),
    wasteReason: mode === 'remove' ? String(payload.wasteReason || '').trim() : '',
    items: (payload.items || []).map((item) => ({
      stockItemId: String(item.stockItemId || item.itemId || item.ingId || '').trim(),
      stockItemName: String(item.stockItemName || item.itemName || item.name || '').trim(),
      quantity: Math.max(parseAdjustmentQuantity(item.quantity ?? item.qty ?? 0), 0),
      unit: String(item.unit || '').trim(),
      unitCost: Number(item.unitCost ?? item.cost ?? item.costEx ?? 0) || 0,
      locationId: String(item.locationId || payload.locationId || '').trim(),
      locationName: String(item.locationName || payload.locationName || '').trim()
    })).filter((item) => item.stockItemId && (mode === 'override' ? item.quantity >= 0 : item.quantity > 0))
  };
}

function normalizeCloudflareLocation(row = {}) {
  const id = String(row.id || '').trim();
  const isDefault = Number(row.is_default || row.isDefault || 0) === 1 || id === 'main';
  const kind = String(row.kind || (isDefault ? 'storage' : 'selling')).trim();
  return {
    id,
    locationId: id,
    siteId: DEFAULT_SITE_ID,
    name: row.display_name || row.displayName || row.name || row.external_name || row.externalName || 'Location',
    displayName: row.display_name || row.displayName || row.name || '',
    type: kind,
    kind,
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault,
    stockRouting: parseJsonObject(row.stock_routing_json || row.stockRoutingJson || row.stockRouting)
  };
}

function parseAdjustmentQuantity(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sortByName(items = []) {
  return [...items].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function sortAdjustments(items = []) {
  return [...items].sort((left, right) => String(right.timestamp || right.date || '').localeCompare(String(left.timestamp || left.date || '')));
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}

// Build a unit-cost lookup from the (already-normalized) stock-items slice so a
// wastage product with no cost of its own can fall back to the matching stock
// item's valuation cost. Keyed by id and by normalized name.
function buildStockCostLookup(stockItems = []) {
  const byId = new Map();
  const byName = new Map();
  stockItems.forEach((item) => {
    const cost = getStockValuationUnitCost(item);
    if (!(cost > 0)) return;
    const id = String(item.id || item.stockItemId || '').trim();
    if (id) byId.set(id, cost);
    const name = String(item.name || item.itemName || '').trim().toLowerCase();
    if (name && !byName.has(name)) byName.set(name, cost);
  });
  return { byId, byName };
}

// Food cost of a menu item = Σ (recipe line qty × that ingredient's stock cost).
// Uses the last-purchase-based stock cost lookup so it works even when the
// backend's stock unit_cost column (and thus baseRecipeCost) is 0.
function computeRecipeUnitCost(product = {}, stockCosts = { byId: new Map() }) {
  const lines = product.recipe || product.recipeLines || product.effectiveRecipeLines
    || product.recipeSourceRecipeLines || [];
  if (!Array.isArray(lines) || !lines.length) return 0;
  return lines.reduce((sum, line) => {
    const id = String(line.ingId || line.stockItemId || line.itemId || '').trim();
    const qty = Number(line.qty ?? line.quantity ?? 0) || 0;
    const cost = stockCosts.byId.get(id) || 0;
    return sum + qty * cost;
  }, 0);
}

function normalizeProductsForWastage(products = [], stockCosts = { byId: new Map(), byName: new Map() }) {
  return products
    .filter((p) => p && (p.id || p.productId))
    .map((p) => {
      const id = String(p.id || p.productId || '').trim();
      const name = String(p.name || p.productName || '').trim();
      // Cost resolution order:
      // 1) unified valuation basis for stock-like items (lastPurchasePrice → costEx → cost)
      // 2) recipe/food cost computed from the product's recipe × stock costs (menu items)
      // 3) any pre-computed recipe/food cost fields
      // 4) fall back to the matching stock item's valuation cost
      let unitCost = getStockValuationUnitCost(p) || 0;
      if (!(unitCost > 0)) unitCost = computeRecipeUnitCost(p, stockCosts);
      if (!(unitCost > 0)) {
        unitCost = Number(p.baseRecipeCost ?? p.recipeCostEx ?? p.foodCostEx ?? p.recipeCost ?? p.unitCost ?? 0) || 0;
      }
      if (!(unitCost > 0)) {
        unitCost = stockCosts.byId.get(id) || stockCosts.byName.get(name.toLowerCase()) || 0;
      }
      return {
        id,
        name,
        category: String(p.category || '').trim() || 'General',
        price: Number(p.price || 0) || 0,
        // Estimated wastage cost per unit; when genuinely none, the UI shows "Cost unavailable".
        unitCost: Number(unitCost) || 0,
        yocoItemId: String(p.yoco_item_id || p.yocoItemId || '').trim()
      };
    })
    .filter((p) => p.id && p.name);
}

function normalizeWastagePayload(payload = {}) {
  return {
    id: String(payload.id || '').trim(),
    locationId: String(payload.locationId || '').trim(),
    locationName: String(payload.locationName || '').trim(),
    wasteReason: String(payload.wasteReason || '').trim(),
    note: String(payload.note || '').trim(),
    date: String(payload.date || todayLocal()).trim(),
    items: (payload.items || []).map((item) => ({
      productId: String(item.productId || item.id || '').trim(),
      productName: String(item.productName || item.name || '').trim(),
      quantity: Math.max(parseAdjustmentQuantity(item.quantity ?? item.qty ?? 0), 0)
    })).filter((item) => item.productId && item.quantity > 0)
  };
}
