import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { DEFAULT_STOCK_LOCATION_ID, normalizeSites, normalizeStockLocations } from './locationModel.js';
import { parseBarcodeValues } from '../utils/barcodes.js';
import { resolveBalanceKey } from '../utils/stockBalances.js';
import { resolveStockItemSku } from '../utils/stockSku.js';
import { deriveStockItemType, stripStockCategoryTypeSuffix } from '../utils/stockItemType.js';

const DEFAULT_UOMS = ['ea', 'kg', 'g', 'l', 'ml', 'pack', 'case', 'bottle', 'bag', 'box', 'tray', 'portion', 'batch'];
const MANUFACTURED_CATEGORY = 'Manufactured';

export function subscribeStockItems(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for stock items.');

  const state = {
    stockItems: [],
    sites: [],
    locations: [],
    uoms: DEFAULT_UOMS,
    loaded: {
      stockItems: false,
      sites: false,
      locations: false,
      uoms: false
    }
  };

  const emit = () => {
    const stockItems = dedupeStockItems(state.stockItems);
    const categories = buildCategoryUsage(stockItems, []);
    onSnapshot?.({
      status: state.loaded.stockItems ? 'ready' : 'loading',
      items: sortIngredients(stockItems),
      sites: sortLocations(normalizeSites(state.sites)),
      locations: sortLocations(normalizeStockLocations(state.locations, state.sites)),
      categories,
      uoms: normalizeUoms([...DEFAULT_UOMS, ...state.uoms, ...stockItems.map((item) => item.unit)]),
      loaded: { ...state.loaded },
      updatedAt: new Date().toISOString()
    });
  };

  const refreshCloudflareState = async () => {
    try {
      const [stockItems, locations] = await Promise.all([
        fetchCloudflareStockItems(workspaceKey),
        fetchCloudflareLocations(workspaceKey)
      ]);
      state.stockItems = stockItems;
      state.locations = locations;
      state.sites = [];
      state.uoms = normalizeUoms([...DEFAULT_UOMS, ...stockItems.map((item) => item.unit)]);
      state.loaded.stockItems = true;
      state.loaded.locations = true;
      state.loaded.sites = true;
      state.loaded.uoms = true;
      emit();
    } catch (error) {
      state.loaded.stockItems = true;
      state.loaded.locations = true;
      state.loaded.sites = true;
      state.loaded.uoms = true;
      onError?.(error, 'live:stock-items');
      emit();
    }
  };

  refreshCloudflareState();

  return () => {
    // Load-on-open only. Mutations restart the relevant tab loader instead of background polling.
  };
}

export async function fetchStock(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to fetch stock.');

  const [stockItems, locations] = await Promise.all([
    fetchCloudflareStockItems(workspaceKey),
    fetchCloudflareLocations(workspaceKey)
  ]);
  const items = sortIngredients(dedupeStockItems(stockItems));

  return {
    items,
    locations: sortLocations(normalizeStockLocations(locations, [])),
    categories: buildCategoryUsage(items, []),
    uoms: normalizeUoms([...DEFAULT_UOMS, ...items.map((item) => item.unit)]),
    source: 'Live stock',
    updatedAt: new Date().toISOString()
  };
}

export async function updateStockLevel(workspaceId, itemId, nextLevel, options = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(itemId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to update stock.');
  if (!id) throw new Error('Stock item id is required.');

  await callCloudflareWorkspaceRoute(workspaceKey, `stock-items/${encodeURIComponent(id)}/stock-level`, {
    method: 'PATCH',
    payload: {
      stock: Number(nextLevel || 0) || 0,
      locationId: String(options.locationId || '').trim()
    }
  });
}

export async function upsertStockItem(workspaceId, item = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save stock items.');

  const payload = normalizeStockPayload(item);
  if (!payload.name) throw new Error('Stock item name is required.');
  const route = item.id ? `stock-items/${encodeURIComponent(payload.id)}` : 'stock-items';
  await callCloudflareWorkspaceRoute(workspaceKey, route, {
    method: item.id ? 'PATCH' : 'POST',
    payload: { item: payload }
  });

  // A displayed row can stand for several database rows: dedupeStockItems merges rows sharing
  // name+category+unit and keeps the rest in `mergedIds`. Saving only the primary id (e.g. when
  // editing just the Unit field) left those siblings on their old unit — on the next refresh they
  // no longer matched the merge key, resurfaced as separate rows with the SAME name, and the next
  // save then hit the "item already exists" duplicate-name check. Keep every id in the group in
  // sync with the same field values instead of letting siblings silently drift.
  if (item.id) {
    const siblingIds = resolveStockItemPersistedIds(item).filter((id) => id !== payload.id);
    for (const siblingId of siblingIds) {
      await callCloudflareWorkspaceRoute(workspaceKey, `stock-items/${encodeURIComponent(siblingId)}`, {
        method: 'PATCH',
        payload: { item: { ...payload, id: siblingId } }
      });
    }
  }
}

/**
 * Every database id a displayed stock row actually stands for.
 *
 * `dedupeStockItems` collapses rows that share name+category+unit into ONE visible row, keeping the
 * primary's `id` and recording the whole group in `mergedIds`. Anything that mutates a row therefore
 * has to act on the full group: deleting only `id` left the siblings active, and the next refresh
 * rebuilt the merged row from them — which is exactly why deleted items "came back".
 */
export function resolveStockItemPersistedIds(item = {}) {
  const merged = String(item.mergedIds || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const primary = String(item.id || '').trim();
  // Primary first so the caller's single-delete path targets the row the user actually clicked.
  return [...new Set(primary ? [primary, ...merged] : merged)];
}

export async function deleteStockItem(workspaceId, itemId) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(itemId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to delete stock items.');
  if (!id) throw new Error('Stock item id is required.');

  await callCloudflareWorkspaceRoute(workspaceKey, `stock-items/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export async function deleteMultipleStockItems(workspaceId, itemIds = []) {
  const workspaceKey = String(workspaceId || '').trim();
  const ids = new Set(itemIds.map(String).filter(Boolean));
  if (!workspaceKey) throw new Error('Workspace id is required to delete stock items.');
  if (!ids.size) return;

  await callCloudflareWorkspaceRoute(workspaceKey, 'stock-items/bulk-delete', {
    method: 'POST',
    payload: { ids: [...ids] }
  });
}

export async function resetStockTotals(workspaceId, options = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to reset stock totals.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'stock-items/reset-dashboard', {
    method: 'POST',
    payload: {
      includeStockOnHand: true,
      locationId: String(options.locationId || '').trim()
    }
  });

  return {
    resetCount: Number(result.stockResetCount || 0),
    locationId: String(options.locationId || '').trim()
  };
}

export async function resetWorkspaceDashboardHistory(workspaceId, options = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to reset dashboard history.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'stock-items/reset-dashboard', {
    method: 'POST',
    payload: { includeStockOnHand: options.includeStockOnHand === true }
  });

  return {
    mode: result.mode || (options.includeStockOnHand === true ? 'dashboard_stock' : 'dashboard'),
    resetAt: result.resetAt || new Date().toISOString(),
    boundaryMode: true,
    stockResetCount: Number(result.stockResetCount || 0)
  };
}


export async function resetWorkspaceReportingHistory(workspaceId, options = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to reset reporting data.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'stock-items/reset-reporting', {
    method: 'POST',
    payload: { includeStockOnHand: options.includeStockOnHand === true }
  });

  return {
    mode: result.mode || (options.includeStockOnHand === true ? 'reporting_stock' : 'reporting'),
    resetAt: result.resetAt || new Date().toISOString(),
    boundaryMode: true,
    stockResetCount: Number(result.stockResetCount || 0)
  };
}

export async function deleteStockCategory(workspaceId, categoryName) {
  const workspaceKey = String(workspaceId || '').trim();
  const target = normalizeCategoryLabel(categoryName);
  if (!workspaceKey) throw new Error('Workspace id is required to delete stock categories.');
  if (!target) throw new Error('Category name is required.');

  await callCloudflareWorkspaceRoute(workspaceKey, 'stock-categories/delete', {
    method: 'POST',
    payload: { name: target }
  });
}

export async function createStockCategory(workspaceId, categoryName) {
  const workspaceKey = String(workspaceId || '').trim();
  const target = normalizeCategoryLabel(categoryName);
  if (!workspaceKey) throw new Error('Workspace id is required to create stock categories.');
  if (!target) throw new Error('Category name is required.');

  await callCloudflareWorkspaceRoute(workspaceKey, 'stock-categories/create', {
    method: 'POST',
    payload: { name: target }
  });
}

export async function createStockUom(workspaceId, uomName) {
  const workspaceKey = String(workspaceId || '').trim();
  const target = normalizeUomLabel(uomName);
  if (!workspaceKey) throw new Error('Workspace id is required to create stock UOMs.');
  if (!target) throw new Error('UOM name is required.');

  await callCloudflareWorkspaceRoute(workspaceKey, 'stock-uoms/create', {
    method: 'POST',
    payload: { name: target }
  });
}

export async function renameStockCategory(workspaceId, currentName, nextName) {
  const workspaceKey = String(workspaceId || '').trim();
  const currentLabel = normalizeCategoryLabel(currentName);
  const nextLabel = normalizeCategoryLabel(nextName);
  if (!workspaceKey) throw new Error('Workspace id is required to rename stock categories.');
  if (!currentLabel || !nextLabel) throw new Error('Both category names are required.');
  if (currentLabel === nextLabel) return;

  await callCloudflareWorkspaceRoute(workspaceKey, 'stock-categories/rename', {
    method: 'POST',
    payload: { currentName: currentLabel, nextName: nextLabel }
  });
}

export async function renameStockUom(workspaceId, currentName, nextName) {
  const workspaceKey = String(workspaceId || '').trim();
  const currentLabel = normalizeUomLabel(currentName);
  const nextLabel = normalizeUomLabel(nextName);
  if (!workspaceKey) throw new Error('Workspace id is required to rename stock UOMs.');
  if (!currentLabel || !nextLabel) throw new Error('Both UOM names are required.');
  if (currentLabel.toLowerCase() === nextLabel.toLowerCase()) return;

  await callCloudflareWorkspaceRoute(workspaceKey, 'stock-uoms/rename', {
    method: 'POST',
    payload: { currentName: currentLabel, nextName: nextLabel }
  });
}

export async function deleteStockUom(workspaceId, uomName) {
  const workspaceKey = String(workspaceId || '').trim();
  const target = normalizeUomLabel(uomName);
  if (!workspaceKey) throw new Error('Workspace id is required to delete stock UOMs.');
  if (!target) throw new Error('UOM name is required.');

  await callCloudflareWorkspaceRoute(workspaceKey, 'stock-uoms/delete', {
    method: 'POST',
    payload: { name: target }
  });
}

export async function importStockItems(workspaceId, items = [], options = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to import stock items.');

  const imports = items
    .map((item) => {
      const hasOpeningStock = item?.__openingStockProvided === true;
      const raw = hasOpeningStock ? { ...(item && typeof item === 'object' ? item : {}) } : stripImportStockAdjustmentFields(item);
      return {
        hasOpeningStock,
        raw,
        payload: normalizeStockPayload(raw)
      };
    })
    .filter(({ payload }) => payload.name);

  if (!imports.length) return { importedCount: 0 };
  const locations = await fetchCloudflareLocations(workspaceKey);
  const sites = [];
  const normalizedImports = imports.map(({ raw, payload, hasOpeningStock }) => assignImportLocation(payload, raw, {
    sites,
    locations,
    options: { ...options, allowStockBalanceUpdate: hasOpeningStock }
  }));
  return callCloudflareWorkspaceRoute(workspaceKey, 'stock-items/import', {
    method: 'POST',
    payload: {
      items: normalizedImports,
      options: {
        ...options,
        allowStockBalanceUpdate: imports.some((entry) => entry.hasOpeningStock)
      }
    }
  });
}

export function normalizeIngredients(value) {
  if (!value) return [];

  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([key, item]) => normalizeIngredient(key, item));
}

async function fetchCloudflareStockItems(workspaceId) {
  const rows = [];
  const limit = 200;
  let offset = 0;

  while (true) {
    const result = await callCloudflareWorkspaceRoute(workspaceId, 'stock-items', {
      method: 'GET',
      query: { limit, offset }
    });
    const stockItems = Array.isArray(result.stockItems) ? result.stockItems : [];
    rows.push(...stockItems.map(normalizeCloudflareStockItem));
    if (stockItems.length < limit) break;
    offset += limit;
  }

  return rows;
}

async function fetchCloudflareLocations(workspaceId) {
  const result = await callCloudflareWorkspaceRoute(workspaceId, 'locations', { method: 'GET' });
  return Array.isArray(result.locations) ? result.locations.map(normalizeCloudflareLocation) : [];
}

function normalizeCloudflareLocation(row = {}) {
  return {
    id: String(row.id || '').trim(),
    name: row.display_name || row.displayName || row.name || row.external_name || row.externalName || 'Location',
    externalName: row.external_name || row.externalName || '',
    displayName: row.display_name || row.displayName || '',
    kind: row.kind || (Number(row.is_default || row.isDefault || 0) === 1 ? 'storage' : 'selling'),
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault: Number(row.is_default || row.isDefault || 0) === 1,
    externalProvider: row.external_provider || row.externalProvider || '',
    externalLocationId: row.external_location_id || row.externalLocationId || ''
  };
}

function normalizeCloudflareStockItem(row = {}) {
  const raw = parseJsonObject(row.raw_json || row.rawJson);
  const balances = parseBalancesJson(row.balances_json || row.balancesJson || row.balances);
  const locationCosts = parseLocationCostsJson(row.location_costs_json || row.locationCostsJson || row.locationCosts || row.location_prices_json || raw.locationCosts || raw.locationPrices);
  const stock = Object.keys(balances).length
    ? sumBalances(balances)
    : Number(row.on_hand ?? row.onHand ?? row.stock ?? 0) || 0;

  return normalizeIngredient(row.id, {
    ...raw,
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    cost: Number(row.unit_cost ?? row.unitCost ?? row.cost ?? 0) || 0,
    vatEnabled: Number(row.vat_enabled ?? row.vatEnabled ?? 1) !== 0,
    lowStockThreshold: Number(row.threshold_qty ?? row.thresholdQty ?? 5) || 5,
    parLevel: Number(row.par_level_qty ?? row.parLevelQty ?? 0) || 0,
    yieldFactor: Number(row.yield_pct ?? row.yieldPct ?? raw.yieldFactor ?? 100) || 100,
    yieldBatch: parseDecimal(row.batch_yield ?? row.batchYield ?? raw.yieldBatch, 1) || 1,
    stock,
    balances,
    locationCosts,
    locationPrices: locationCosts,
    itemType: row.item_type || row.itemType || raw.itemType,
    isStocked: resolveIsStocked(row.item_type || row.itemType || raw.itemType, row.is_stocked, raw.isStocked),
    source: 'Live stock'
  });
}

function resolveIsStocked(itemTypeValue, rowStocked, rawStocked) {
  const itemType = String(itemTypeValue || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['sub_recipe', 'subrecipe', 'virtual'].includes(itemType)) return false;
  if (['recipe_source', 'non_stock'].includes(itemType)) return true;
  if (rowStocked !== undefined && rowStocked !== null) return Number(rowStocked) !== 0;
  if (rawStocked !== undefined && rawStocked !== null) return rawStocked !== false && Number(rawStocked) !== 0;
  return true;
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

function parseBalancesJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, quantity]) => [String(key), Number(quantity || 0) || 0])
  );
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parseBalancesJson(parsed);
  } catch {
    return {};
  }
}

function parseLocationCostsJson(value) {
  if (!value) return {};
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([locationId, entry]) => {
        const row = entry && typeof entry === 'object' ? entry : { price: entry };
        return [String(locationId), {
          cost: Number(row.cost ?? row.unitCost ?? row.price ?? 0) || 0,
          unitCost: Number(row.unitCost ?? row.cost ?? row.price ?? 0) || 0,
          price: Number(row.price ?? row.cost ?? row.unitCost ?? 0) || 0,
          updatedAt: row.updatedAt || row.updated_at || ''
        }];
      }).filter(([locationId]) => locationId)
    );
  }
  try {
    return parseLocationCostsJson(JSON.parse(String(value || '{}')));
  } catch {
    return {};
  }
}

function mergeLocationCostMaps(primary = {}, duplicate = {}) {
  return {
    ...(duplicate && typeof duplicate === 'object' ? duplicate : {}),
    ...(primary && typeof primary === 'object' ? primary : {})
  };
}

function mergeCloudflareStockItems(legacyItems = [], cloudflareItems = []) {
  const cloudflareById = new Map((cloudflareItems || []).map((item) => [String(item.id), item]));
  const cloudflareByKey = new Map((cloudflareItems || []).map((item) => [stockMergeKey(item), item]));
  const usedKeys = new Set();
  const merged = (legacyItems || []).map((item) => {
    const live = cloudflareById.get(String(item.id)) || cloudflareByKey.get(stockMergeKey(item));
    if (!live) return item;
    usedKeys.add(String(live.id));
    usedKeys.add(stockMergeKey(live));
    return {
      ...item,
      cost: Number(live.cost ?? item.cost ?? 0) || 0,
      lowStockThreshold: Number(live.lowStockThreshold ?? item.lowStockThreshold ?? 5) || 5,
      parLevel: Number(live.parLevel ?? item.parLevel ?? 0) || 0,
      stock: Number(live.stock ?? item.stock ?? 0) || 0,
      balances: live.balances && Object.keys(live.balances).length ? live.balances : item.balances || {},
      locationCosts: live.locationCosts && Object.keys(live.locationCosts).length ? live.locationCosts : item.locationCosts || item.locationPrices || {},
      locationPrices: live.locationPrices && Object.keys(live.locationPrices).length ? live.locationPrices : item.locationPrices || item.locationCosts || {}
    };
  });

  cloudflareItems.forEach((item) => {
    const key = stockMergeKey(item);
    if (!usedKeys.has(String(item.id)) && !usedKeys.has(key)) {
      usedKeys.add(String(item.id));
      usedKeys.add(key);
      merged.push(item);
    }
  });

  return dedupeStockItems(merged);
}

function stockMergeKey(item = {}) {
  return [
    normalizeStockMergeText(item.name || item.ingredientName),
    normalizeStockMergeText(item.category),
    normalizeStockMergeText(item.unit || item.uom)
  ].join('|');
}

function normalizeStockMergeText(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+-\s+raw materials$/i, '')
    .replace(/\s+-\s+sub[-\s]?recipe$/i, ' - sub recipe')
    .replace(/\s+-\s+manufactured$/i, ' - manufactured')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeStockItems(items = []) {
  const byKey = new Map();
  items.forEach((item) => {
    const key = stockMergeKey(item);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      return;
    }

    byKey.set(key, mergeDuplicateStockItems(existing, item));
  });
  return [...byKey.values()];
}

function mergeDuplicateStockItems(primary = {}, duplicate = {}) {
  const balances = {};
  [primary.balances, duplicate.balances].forEach((source) => {
    Object.entries(source && typeof source === 'object' ? source : {}).forEach(([locationId, qty]) => {
      const key = String(locationId || '').trim();
      if (!key) return;
      balances[key] = (Number(balances[key] || 0) || 0) + (Number(qty || 0) || 0);
    });
  });
  const hasBalances = Object.keys(balances).length > 0;
  const stock = hasBalances
    ? Object.values(balances).reduce((sum, qty) => sum + Number(qty || 0), 0)
    : (Number(primary.stock || 0) || 0) + (Number(duplicate.stock || 0) || 0);
  const ids = [
    ...new Set([
      ...String(primary.mergedIds || primary.id || '').split(','),
      ...String(duplicate.mergedIds || duplicate.id || '').split(',')
    ].map((id) => id.trim()).filter(Boolean))
  ];

  return {
    ...duplicate,
    ...primary,
    id: primary.id || duplicate.id,
    mergedIds: ids.join(','),
    duplicateCount: Math.max(Number(primary.duplicateCount || 1), 1) + Math.max(Number(duplicate.duplicateCount || 1), 1),
    stock,
    onHand: stock,
    balances: hasBalances ? balances : (primary.balances || duplicate.balances || {}),
    locationCosts: mergeLocationCostMaps(primary.locationCosts || primary.locationPrices, duplicate.locationCosts || duplicate.locationPrices),
    locationPrices: mergeLocationCostMaps(primary.locationPrices || primary.locationCosts, duplicate.locationPrices || duplicate.locationCosts)
  };
}

export function normalizeIngredient(key, item = {}) {
  const itemWithoutLocationPrices = { ...item };
  ['location' + 'Pricing', 'prices' + 'ByLocation'].forEach((field) => {
    delete itemWithoutLocationPrices[field];
  });
  const rawBalances = item.balances && typeof item.balances === 'object' ? item.balances : {};
  const itemType = normalizeStockItemType(item);
  const isSubRecipe = itemType === 'sub_recipe';
  const isManufactured = itemType === 'manufactured';
  const balances = isSubRecipe ? {} : rawBalances;
  const stock = isSubRecipe
    ? 0
    : Object.keys(balances).length
      ? Object.values(balances).reduce((sum, value) => sum + (Number(value) || 0), 0)
      : Number(item.stock || 0);
  const barcodes = parseBarcodeValues(item);
  const name = item.name || item.ingredientName || 'Unnamed Stock Item';
  const sku = resolveStockItemSku(
    name,
    item.sku,
    item.SKU,
    item.skuCode,
    item.stockCode,
    item.itemCode,
    item.customSku,
    item.code,
  );

  return {
    ...itemWithoutLocationPrices,
    id: String(item.id || key || createId()),
    name,
    sku,
    customSku: sku,
    category: isSubRecipe ? normalizeSubRecipeCategory(item.category) : isManufactured ? normalizeManufacturedCategory(name, item.category) : (item.category || 'General - Raw Materials'),
    unit: item.unit || item.uom || 'ea',
    cost: Number(item.cost ?? item.costEx ?? 0) || 0,
    lastPurchasePrice: Number(item.lastPurchasePrice ?? item.lastPurchaseCost ?? item.latestPurchasePrice ?? item.costEx ?? item.cost ?? 0) || 0,
    stock,
    balances,
    barcodes,
    vatEnabled: item.vatEnabled !== false,
    lowStockThreshold: Number(item.lowStockThreshold || 5),
    parLevel: Number(item.parLevel || 0),
    yieldFactor: Number(item.yieldFactor || 100),
    yieldBatch: parseDecimal(item.yieldBatch ?? item.yieldQty, 1),
    uomConfigurations: normalizeUomConfigurations(item.uomConfigurations || item.uomConfig || item.uom_configuration || item.uomConversions || item.uomConversion),
    itemType,
    isStocked: itemType === 'sub_recipe' ? false : itemType === 'recipe_source' ? true : item.isStocked !== false,
    isSubRecipe,
    isManufactured
  };
}

function normalizeStockPayload(item = {}) {
  const id = String(item.id || createId()).trim();
	  const itemType = normalizeStockItemType(item);
	  const isSubRecipe = itemType === 'sub_recipe';
	  const isManufactured = itemType === 'manufactured';
	  const isRecipeSource = itemType === 'recipe_source';
	  // Strip any type marker the previous save appended before deriving the new one. Without this the
	  // markers accumulate ("General - Non Stock - Raw Materials") and the stale text keeps the item
	  // pinned to its old type on every subsequent save, which is why converting a Non Stock item back
	  // to a normal stock item never stuck.
	  let category = stripStockCategoryTypeSuffix(item.category);
  const name = String(item.name || '').replace(/\s+-\s+Manufactured$/i, '').replace(/\s+-\s+Manufacturing$/i, '').trim();
  const hasStock = Object.prototype.hasOwnProperty.call(item, 'stock') && item.stock !== undefined && item.stock !== null && item.stock !== '';

	  if (isSubRecipe) {
	    category = normalizeSubRecipeCategory(category);
	  } else if (isManufactured) {
	    category = normalizeManufacturedCategory(name, category);
	  } else if (isRecipeSource) {
	    // The `includes` guards keep a user whose own base category happens to BE the marker word
	    // ("Raw Materials", "Non Stock") from getting it appended twice — stripping only removes a
	    // marker that follows a " - " separator, so a bare one survives by design.
	    category = /non[-\s]?stock/i.test(category) ? category : `${category || 'General'} - Non Stock`;
	  } else if (category && !category.toLowerCase().includes('raw materials')) {
	    category += ' - Raw Materials';
	  }

  const sku = resolveStockItemSku(name, item.sku, item.SKU, item.skuCode, item.stockCode, item.itemCode, item.customSku, item.code);

  const payload = {
    id,
    name,
    sku,
    category: category || 'General - Raw Materials',
    unit: String(item.unit || item.uom || 'ea').trim() || 'ea',
    cost: Number(item.cost || 0) || 0,
    lastPurchasePrice: Number(item.lastPurchasePrice ?? item.lastPurchaseCost ?? item.latestPurchasePrice ?? item.cost ?? 0) || 0,
    barcodes: parseBarcodeValues(item),
    vatEnabled: parseBooleanFlag(item.vatEnabled ?? item.VAT_Enabled ?? item.VATEnabled ?? item.VAT ?? item.Taxable, false),
    notes: String(item.notes || item.note || '').trim(),
    lowStockThreshold: Number(item.lowStockThreshold || 5),
    parLevel: Number(item.parLevel || 0),
    yieldFactor: Number(item.yieldFactor || 100),
    yieldBatch: parseDecimal(item.yieldBatch, 1),
    uomConfigurations: normalizeUomConfigurations(item.uomConfigurations || item.uomConfig || item.uom_configuration || item.uomConversions || item.uomConversion),
	    // Non Stock ("recipe_source") items are simple purchased items with no bill-of-materials —
	    // they are counted as-is, not assembled from other ingredients. The editor already refuses to
	    // show them an ingredients screen (see isRecipeBackedItem in StockItems.js); carrying a recipe
	    // for them here too meant the two layers disagreed, and a Non Stock item kept being treated as
	    // recipe-backed downstream.
	    recipe: ['sub_recipe', 'manufactured'].includes(itemType)
	      ? normalizeStockRecipe(item.recipe)
	      : [],
	    itemType,
    isStocked: isSubRecipe ? false : isRecipeSource ? true : item.isStocked !== false,
	    isSubRecipe,
	    isManufactured
	  };

  if (!isSubRecipe && hasStock) {
    payload.stock = Number(item.stock || 0) || 0;
  }

  if (!isSubRecipe && item.balances && typeof item.balances === 'object') {
    payload.balances = item.balances;
  }

  return payload;
}

function stripImportStockAdjustmentFields(item = {}) {
  const payload = { ...(item && typeof item === 'object' ? item : {}) };
  [
    'stock',
    'onHand',
    'on_hand',
    'quantity',
    'qty',
    'balances',
    'stockByLocation',
    'locationBalances'
  ].forEach((field) => {
    delete payload[field];
  });
  return payload;
}

function normalizeSubRecipeCategory(category = '') {
  const raw = String(category || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Sub[-\s]?Recipe$/i, '')
    .replace(/^Sub[-\s]?Recipe$/i, '')
    .trim();
  return `${raw || 'General'} - Sub Recipe`;
}

// Delegates to the shared canonical derivation. This module treats 'virtual' as a Non Stock
// ("recipe_source") item, which is the behaviour it has always had, so the fine-grained type is
// collapsed here rather than in the shared helper (stock-count eligibility needs the distinction).
function normalizeStockItemType(item = {}) {
  const type = deriveStockItemType(item);
  return type === 'virtual' ? 'recipe_source' : type;
}

function normalizeStockRecipe(value = []) {
  const lines = Array.isArray(value)
    ? value
    : Object.values(value && typeof value === 'object' ? value : {});

  return lines
    .map((line = {}) => ({
      ingId: String(line.ingId || line.ingredientId || line.stockItemId || line.id || '').trim(),
      qty: parseDecimal(line.qty ?? line.quantity ?? line.amount, 0) || 0
    }))
    .filter((line) => line.ingId);
}

function normalizeUomConfigurations(value = []) {
  const rows = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? [value] : []);

  return rows
    .map((entry = {}) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const baseUom = String(row.baseUom || row.base_uom || row.baseUnit || row.unit || '').trim();
      const customUom = String(row.customUom || row.custom_uom || row.customUnit || row.orderingUom || '').trim();
      const ratio = parseDecimal(row.ratio ?? row.conversionRatio ?? row.unitsPerCustomUnit ?? row.units_per_custom_unit, 0);
      const barcode = parseBarcodeValues(row.barcode || row.barcodes || row.customBarcode || row.customUomBarcode)[0] || '';
      const isDefaultOrdering = ['true', '1', 'yes', 'on'].includes(String(row.isDefaultOrdering ?? row.defaultOrdering ?? row.is_default_ordering ?? row.defaultOrderUom ?? '').toLowerCase()) || row.isDefaultOrdering === true || row.defaultOrdering === true;
      return { baseUom, customUom, ratio, barcode, isDefaultOrdering };
    })
    .filter((entry) => entry.baseUom && entry.customUom && entry.ratio > 0);
}

function parseDecimal(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const normalized = raw
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assignImportLocation(payload = {}, rawItem = {}, { sites = [], locations = [], options = {} } = {}) {
  const location = resolveImportStockLocation(rawItem, { sites, locations, options });
  if (!location?.id) return payload;
  if (options.allowStockBalanceUpdate === false) {
    return {
      ...payload,
      siteId: String(location.siteId || ''),
      siteName: getSiteName(sites, location.siteId),
      locationId: String(location.id || ''),
      locationName: location.name || '',
      targetLocation: String(location.id || ''),
      targetLocationName: location.name || ''
    };
  }

  const balances = payload.balances && typeof payload.balances === 'object'
    ? { ...payload.balances }
    : {};
  const hasBalances = Object.keys(balances).length > 0;
  const stock = Number(payload.stock ?? rawItem.stock ?? 0) || 0;
  if (!hasBalances || !Object.prototype.hasOwnProperty.call(balances, location.id)) {
    balances[location.id] = hasBalances ? Number(balances[location.id] || 0) : stock;
  }

  return {
    ...payload,
    stock: sumBalances(balances),
    balances,
    siteId: String(location.siteId || ''),
    siteName: getSiteName(sites, location.siteId),
    locationId: String(location.id || ''),
    locationName: location.name || '',
    targetLocation: String(location.id || ''),
    targetLocationName: location.name || ''
  };
}

function resolveImportStockLocation(rawItem = {}, { sites = [], locations = [], options = {} } = {}) {
  const validLocations = (locations || []).filter((location) => location?.id);
  if (!validLocations.length) return null;

  const rowLocationId = firstText(
    rawItem.locationId,
    rawItem.targetLocation,
    rawItem.defaultLocationId,
    rawItem.Stock_Location_ID,
    rawItem.Location_ID,
    rawItem.LocationId,
    rawItem.location_id
  );
  const byId = findLocationById(validLocations, rowLocationId);
  if (byId) return byId;

  const siteId = firstText(
    rawItem.siteId,
    rawItem.Site_ID,
    rawItem.SiteId,
    rawItem.site_id
  );
  const siteName = firstText(
    rawItem.siteName,
    rawItem.Site,
    rawItem.Site_Name,
    rawItem.Store,
    rawItem.Store_Location,
    rawItem.storeLocation
  );
  const matchedSite = findSite(sites, siteId, siteName);
  const matchedSiteId = String(matchedSite?.id || siteId || '').trim();

  const locationName = firstText(
    rawItem.locationName,
    rawItem.Location,
    rawItem.Stock_Location,
    rawItem.StockLocation,
    rawItem.Storage_Location,
    rawItem.StorageLocation,
    rawItem.storageLocation
  );
  const byName = findLocationByName(validLocations, locationName, matchedSiteId);
  if (byName) return byName;

  const defaultLocationId = firstText(
    options.defaultImportLocationId,
    options.locationId,
    rawItem.defaultImportLocationId
  );
  const defaultById = findLocationById(validLocations, defaultLocationId);
  if (defaultById) return defaultById;

  const optionSiteId = firstText(options.siteId);
  return getDefaultImportLocation(validLocations, matchedSiteId || optionSiteId);
}

function mergeImportBalances(existing = {}, incoming = {}) {
  const balances = existing.balances && typeof existing.balances === 'object'
    ? { ...existing.balances }
    : {};
  const incomingBalances = incoming.balances && typeof incoming.balances === 'object'
    ? incoming.balances
    : {};
  Object.entries(incomingBalances).forEach(([locationId, value]) => {
    const id = String(locationId || '').trim();
    if (!id) return;
    balances[id] = Number(value || 0) || 0;
  });
  return balances;
}

function findLocationById(locations = [], locationId = '') {
  const id = String(locationId || '').trim();
  if (!id) return null;
  return locations.find((location) => [
    location.id,
    location.locationId,
    location.yocoLocationId,
    location.yocoStoreLocationId,
    location.externalLocationId,
    location.externalId
  ].some((value) => String(value || '').trim() === id)) || null;
}

function findLocationByName(locations = [], locationName = '', siteId = '') {
  const name = normalizeLookup(locationName);
  if (!name) return null;
  return locations.find((location) => {
    if (siteId && String(location.siteId || '') !== String(siteId)) return false;
    return [
      location.name,
      location.displayName,
      location.label,
      location.code,
      location.yocoLocationName
    ].some((value) => normalizeLookup(value) === name);
  }) || null;
}

function getDefaultImportLocation(locations = [], siteId = '') {
  const scopedLocations = siteId
    ? locations.filter((location) => String(location.siteId || '') === String(siteId))
    : [];
  const candidates = scopedLocations.length ? scopedLocations : locations;

  return candidates.find((location) => String(location.id || '') === DEFAULT_STOCK_LOCATION_ID) ||
    candidates.find((location) => location.isDefault === true) ||
    candidates.find((location) => ['main', 'mainlocation', 'mainstore', 'mainstorage'].includes(normalizeLookup(location.name))) ||
    candidates[0] ||
    locations.find((location) => String(location.id || '') === DEFAULT_STOCK_LOCATION_ID) ||
    locations.find((location) => location.isDefault === true) ||
    locations[0] ||
    null;
}

function findSite(sites = [], siteId = '', siteName = '') {
  const id = String(siteId || '').trim();
  const name = normalizeLookup(siteName);
  return sites.find((site) => (
    (id && (String(site.id) === id || String(site.siteId || '') === id)) ||
    (name && [site.name, site.siteName, site.code].some((value) => normalizeLookup(value) === name))
  )) || null;
}

function getSiteName(sites = [], siteId = '') {
  return sites.find((site) => String(site.id) === String(siteId || ''))?.name || '';
}

function firstText(...values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

function normalizeLookup(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sumBalances(balances = {}) {
  return Object.values(balances || {}).reduce((sum, value) => sum + (Number(value || 0) || 0), 0);
}

function normalizeManufacturedName(value = '') {
  const base = String(value || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .trim();
  return base ? `${base} - Manufactured` : '';
}

function normalizeManufacturedCategory(itemName = '', value = '') {
  const rawCategory = String(value || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .trim();

  const baseName = String(itemName || '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .trim();
  let customerCategory = rawCategory;
  const existingFormatted = rawCategory.match(/\(([^)]+)\)$/);

  if (existingFormatted?.[1] && baseName && rawCategory.toLowerCase().startsWith(`${baseName.toLowerCase()} (`)) {
    customerCategory = existingFormatted[1].trim();
  } else if (baseName && rawCategory.toLowerCase().startsWith(`${baseName.toLowerCase()} - `)) {
    customerCategory = rawCategory.slice(baseName.length + 3).trim();
  }

  if (!customerCategory || customerCategory.toLowerCase() === MANUFACTURED_CATEGORY.toLowerCase()) {
    return MANUFACTURED_CATEGORY;
  }

  return `${customerCategory} - Manufactured`;
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const textValue = String(value ?? '').trim().toLowerCase();
  if (!textValue) return fallback;
  if (['yes', 'y', '1', 'true'].includes(textValue)) return true;
  if (['no', 'n', '0', 'false', 'tax exempt', 'tax-exempt', 'exempt'].includes(textValue)) return false;
  return fallback;
}

function normalizeLocations(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => ({
      id: String(item.id || id),
      name: item.name || item.label || id
    }));
}

function normalizeUoms(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : String(value || '').split(',');

  return [...new Set(entries
    .map((unit) => String(unit || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function mergeStockSettings(settings = {}, { units = [], categories = [] } = {}) {
  const currentSettings = settings && typeof settings === 'object' ? { ...settings } : {};
  return {
    ...currentSettings,
    categories: normalizeCategoryNames([
      ...normalizeCategoryNames(currentSettings.categories),
      ...categories
    ]),
    uoms: normalizeUoms([
      ...DEFAULT_UOMS,
      ...normalizeUoms(currentSettings.uoms),
      ...units
    ])
  };
}

function normalizeCategoryNames(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : String(value || '').split(',');

  return [...new Set(entries
    .map((category) => normalizeCategoryLabel(category))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function buildCategoryUsage(ingredients = [], configuredCategories = []) {
  const usage = new Map();

  normalizeCategoryNames(configuredCategories).forEach((category) => {
    usage.set(category, 0);
  });

  ingredients.forEach((ingredient) => {
    const category = normalizeCategoryLabel(ingredient.category);
    if (!category) return;
    usage.set(category, (usage.get(category) || 0) + 1);
  });

  return [...usage.entries()]
    .map(([name, itemCount]) => ({ name, itemCount }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function normalizeCategoryLabel(value = '') {
  const raw = String(value || '');
  const manufacturedCategory = raw.toLowerCase().includes('manufactured')
    ? raw.match(/\(([^)]+)\)\s*-\s*Manufactured$/i)
    : null;
  if (manufacturedCategory?.[1]) return manufacturedCategory[1].trim();
  const stripped = raw
    .replace(' - Raw Materials', '')
    .replace(' - Manufactured', '')
    .trim();
  const hyphenParts = raw.toLowerCase().includes('manufactured')
    ? stripped.split(/\s+-\s+/).filter(Boolean)
    : [];
  if (hyphenParts.length > 1) return hyphenParts.at(-1).trim();
  return stripped;
}

function normalizeUomLabel(value = '') {
  return String(value || '').trim();
}

function applyCategoryLabel(sourceCategory = '', nextBaseLabel = '') {
  const label = normalizeCategoryLabel(nextBaseLabel);
  const raw = String(sourceCategory || '');
  if (raw.toLowerCase().includes('manufactured')) return `${label} - Manufactured`;
  if (raw.toLowerCase().includes('raw materials')) return `${label} - Raw Materials`;
  return label;
}

function isSameStockItem(left, right) {
  if (left.id && right.id && String(left.id) === String(right.id)) return true;
  if (String(left.name || '').trim().toLowerCase() === String(right.name || '').trim().toLowerCase()) return true;

  const leftBarcodes = new Set((left.barcodes || []).map(String));
  return (right.barcodes || []).some((barcode) => leftBarcodes.has(String(barcode)));
}

function mergeBarcodes(left, right) {
  return [...new Set([...(left.barcodes || []), ...(right.barcodes || [])].map(String).filter(Boolean))];
}

function createInventoryAuditEntry(action, item = {}, context = {}) {
  const now = new Date().toISOString();
  return {
    id: createId(),
    timestamp: now,
    date: now.slice(0, 10),
    area: String(context.area || 'stock_item'),
    action: String(action || 'updated'),
    itemId: String(item.id || ''),
    itemName: String(item.name || item.stockItemName || ''),
    category: String(item.category || ''),
    locationId: String(context.locationId || item.locationId || ''),
    locationName: String(context.locationName || item.locationName || ''),
    beforeValue: stringifyAuditValue(context.beforeValue),
    afterValue: stringifyAuditValue(context.afterValue),
    source: String(context.source || 'stock_master')
  };
}

function stringifyAuditValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return String(Number(value.toFixed(5)));
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function describeStockItemSnapshot(item = {}) {
  return [
    `stock=${Number(item.stock || 0)}`,
    `cost=${Number(item.cost || 0)}`,
    `unit=${item.unit || ''}`,
    `category=${item.category || ''}`
  ].join(' | ');
}

async function writeInventoryAuditEntries(rootPath, entries = []) {
  // Stock writes are handled by the live API. Audit entries are recorded server-side.
  void rootPath;
  void entries;
}

function sortIngredients(items) {
  return [...items].sort((a, b) => {
    const categoryCompare = String(a.category || '').localeCompare(String(b.category || ''));
    if (categoryCompare) return categoryCompare;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function sortLocations(locations) {
  return [...locations].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
