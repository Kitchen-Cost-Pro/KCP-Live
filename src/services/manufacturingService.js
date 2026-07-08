import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { deleteStockItem, fetchStock, normalizeIngredient, upsertStockItem } from './stockService.js';
import { DEFAULT_SITE_ID, normalizeSites, normalizeStockLocations } from './locationModel.js';
import { todayLocal } from '../utils/date.js';

const DEFAULT_UOMS = ['ea', 'kg', 'g', 'l', 'ml', 'pack', 'case', 'bottle', 'bag', 'box', 'tray', 'portion', 'batch'];
const MANUFACTURED_CATEGORY = 'Manufactured';

export function subscribeManufacturingWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for manufacturing.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchManufacturingWorkspace(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:manufacturing');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchManufacturingWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for manufacturing.');

  const [stockState, batchResponse, locationResponse, siteResponse] = await Promise.all([
    fetchStock(workspaceKey),
    callCloudflareWorkspaceRoute(workspaceKey, 'manufacturing-batches', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
    callCloudflareWorkspaceRoute(workspaceKey, 'site-configuration')
  ]);

  const settings = { siteName: siteResponse.siteConfiguration?.site_name || 'Main Site' };
  const sites = normalizeSites([{ id: DEFAULT_SITE_ID, name: settings.siteName, isDefault: true }], settings);
  const locations = normalizeStockLocations((locationResponse.locations || []).map(normalizeCloudflareLocation), sites, settings);
  const stockItems = stockState.items || [];
  const manufacturedItems = stockItems
    .filter((item) => ['manufactured', 'sub_recipe'].includes(getManufacturingItemType(item)))
    .map((item) => decorateManufacturedItem(item, stockItems));

  return {
    status: 'ready',
    source: 'Live manufacturing',
    manufacturedItems: sortByName(manufacturedItems),
    stockItems: sortByName(stockItems),
    sites: sortByName(sites),
    locations: sortByName(locations),
    categories: normalizeCategoryNames(stockItems.map((item) => item.category)),
    uoms: normalizeUoms([...DEFAULT_UOMS, ...stockItems.map((item) => item.unit)]),
    logs: sortLogs(normalizeManufacturingLogs(batchResponse.batches || [])),
    loaded: {
      ingredients: true,
      sites: true,
      locations: true,
      settings: true,
      logs: true,
      categories: true,
      uoms: true
    },
    updatedAt: new Date().toISOString()
  };
}

export async function saveManufacturedItem(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save manufacturing blueprints.');

  const draft = normalizeManufacturedPayload(payload);
  const itemType = getManufacturingItemType(draft) === 'sub_recipe' ? 'sub_recipe' : 'manufactured';
  if (!draft.id) draft.id = createId('mfg');
  if (!draft.name) throw new Error(`${itemType === 'sub_recipe' ? 'Sub-recipe' : 'Manufactured item'} name is required.`);
  if (!(draft.yieldBatch > 0)) throw new Error('Batch yield must be greater than zero.');

  const stockState = await fetchStock(workspaceKey);
  const duplicate = (stockState.items || []).find((item) => (
    String(item.name || '').trim().toLowerCase() === draft.name.toLowerCase() &&
    String(item.id) !== String(draft.id)
  ));
  if (duplicate) throw new Error('A manufactured item with this name already exists.');

  const componentMap = new Map((stockState.items || []).map((item) => [String(item.id), item]));
  const cost = computeManufacturedUnitCost(draft, componentMap);
  const nextItem = normalizeIngredient(draft.id, {
    ...draft,
    cost,
    lastPurchasePrice: cost,
    itemType,
    isManufactured: itemType === 'manufactured',
    isSubRecipe: itemType === 'sub_recipe'
  });

  await upsertStockItem(workspaceKey, nextItem);
  return nextItem;
}

export async function deleteManufacturedItem(workspaceId, itemId) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(itemId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to delete manufacturing blueprints.');
  if (!id) throw new Error('Manufactured item id is required.');
  await deleteStockItem(workspaceKey, id);
}

export async function postManufacturingBatch(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to post a production batch.');

  const draft = normalizeBatchPayload(payload);
  if (!draft.manufacturedItemId) throw new Error('Select a manufactured item first.');
  if (!draft.locationId) throw new Error('Choose a location.');
  if (!(draft.producedQty > 0)) throw new Error('Actual produced quantity must be greater than zero.');
  if (!(draft.expectedQty > 0)) throw new Error('Expected quantity must be greater than zero.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'manufacturing-batches', {
    method: 'POST',
    payload: { batch: draft }
  });
  return result.batch || { id: result.id };
}

export async function importManufacturedItems(workspaceId, items = []) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to import manufactured items.');

  const stockState = await fetchStock(workspaceKey);
  // Match on the suffix-stripped base name so items stored with/without the
  // " - Manufactured" suffix still resolve to the same record (prevents duplicates).
  const stripSuffix = (value = '') => String(value || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .replace(/\s+-\s+Sub-?Recipe$/i, '')
    .trim()
    .toLowerCase();
  const existingByName = new Map((stockState.items || [])
    .filter((item) => ['manufactured', 'sub_recipe'].includes(getManufacturingItemType(item)))
    .map((item) => [stripSuffix(item.name), item]));
  const imports = (items || [])
    .map((item) => normalizeManufacturedPayload(item))
    .map((item) => ({
      ...item,
      // A base-name match against live stock wins (authoritative for dedup), then any id
      // already resolved upstream, else a new id.
      id: existingByName.get(stripSuffix(item.name))?.id || item.id || createId('mfg')
    }))
    .filter((item) => item.name);

  for (const item of imports) {
    await saveManufacturedItem(workspaceKey, item);
  }

  return { importedCount: imports.length };
}

function decorateManufacturedItem(item, stockItems) {
  const componentMap = new Map((stockItems || []).map((entry) => [String(entry.id), entry]));
  const recipe = normalizeRecipe(item.recipe).map((line) => {
    const component = componentMap.get(String(line.ingId || ''));
    const cost = (Number(component?.cost || 0) || 0) * parseDecimal(line.qty, 0);
    const componentType = getManufacturingItemType(component || {});
    return {
      ...line,
      name: component?.name || 'Missing Component',
      unit: component?.unit || '',
      cost,
      componentType,
      missingRecipe: componentType === 'sub_recipe' && !normalizeRecipe(component?.recipe).length
    };
  });
  const batchCost = recipe.reduce((sum, line) => sum + (Number(line.cost || 0) || 0), 0);
  const yieldBatch = parseDecimal(item.yieldBatch, 1) || 1;
  const unitCost = yieldBatch > 0 ? batchCost / yieldBatch : 0;
  const itemType = getManufacturingItemType(item);
  return {
    ...item,
    itemType,
    recipe,
    batchCost,
    unitCost,
    componentCount: recipe.length,
    missingRecipeCount: recipe.filter((line) => line.missingRecipe).length
  };
}

function computeManufacturedUnitCost(item, componentMap) {
  const recipe = normalizeRecipe(item.recipe);
  const batchCost = recipe.reduce((sum, line) => {
    const component = componentMap.get(String(line.ingId || ''));
    const cost = Number(component?.cost || 0) || 0;
    return sum + (parseDecimal(line.qty, 0) * cost);
  }, 0);
  const yieldBatch = parseDecimal(item.yieldBatch, 1) || 1;
  return yieldBatch > 0 ? batchCost / yieldBatch : 0;
}

function normalizeManufacturedPayload(payload = {}) {
  const itemType = normalizeProductionItemType(
    readPayloadField(payload, 'itemType', 'Item_Type', 'Item Type', 'Type') ||
    payload.itemType ||
    payload.stockItemType ||
    payload.specificationType
  );
  const name = normalizeProductionName(payload.name || payload.itemName, itemType);
  const category = normalizeProductionCategory(name, readPayloadField(payload, 'category', 'Category', 'ProductCategory', 'Group'), itemType);
  return {
    id: String(readPayloadField(payload, 'id', 'ID', 'Id', 'Code') || '').trim(),
    name,
    unit: String(readPayloadField(payload, 'unit', 'Unit', 'uom', 'UOM') || '').trim(),
    category,
    yieldBatch: parseDecimal(readPayloadField(payload, 'yieldBatch', 'Batch_Yield', 'BatchYield', 'Batch Yield'), 1) || 1,
    recipe: normalizeRecipe(payload.recipe),
    balances: payload.balances && typeof payload.balances === 'object' ? payload.balances : {},
    stock: Number(payload.stock || 0) || 0,
    itemType,
    isManufactured: itemType === 'manufactured',
    isSubRecipe: itemType === 'sub_recipe'
  };
}

function normalizeProductionItemType(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['sub_recipe', 'subrecipe', 'sub', 'sub_recipe_item'].includes(normalized)) return 'sub_recipe';
  return 'manufactured';
}

function getManufacturingItemType(item = {}) {
  const explicit = String(item.itemType || item.stockItemType || item.specificationType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const category = String(item.category || '').toLowerCase();
  if (explicit === 'sub_recipe' || item.isSubRecipe === true || category.includes('sub recipe') || category.includes('sub-recipe')) return 'sub_recipe';
  if (['manufactured', 'prep', 'prepared', 'manufactured_item'].includes(explicit)) return 'manufactured';
  if (item.isManufactured === true || category.includes('manufactured')) return 'manufactured';
  return 'standard';
}

function normalizeBatchPayload(payload = {}) {
  return {
    id: String(payload.id || '').trim(),
    manufacturedItemId: String(payload.manufacturedItemId || '').trim(),
    siteId: String(payload.siteId || '').trim(),
    siteName: String(payload.siteName || '').trim(),
    locationId: String(payload.locationId || '').trim(),
    locationName: String(payload.locationName || '').trim(),
    producedQty: parseDecimal(payload.producedQty, 0) || 0,
    expectedQty: parseDecimal(payload.expectedQty, 0) || 0,
    batchCount: parseDecimal(payload.batchCount ?? payload.batchMultiplier, 0) || 0,
    date: String(payload.date || todayLocal()).trim(),
    note: String(payload.note || '').trim()
  };
}

function normalizeRecipe(value) {
  const recipe = Array.isArray(value) ? value : Object.values(value || {});
  return recipe
    .map((line) => ({
      ingId: String(line.ingId || line.id || '').trim(),
      qty: parseDecimal(line.qty, 0) || 0
    }))
    .filter((line) => line.ingId && line.qty >= 0);
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

function normalizeProductionName(value = '', itemType = 'manufactured') {
  const base = String(value || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .replace(/\s+-\s+Sub-?Recipe$/i, '')
    .trim();
  if (itemType === 'sub_recipe') return base;
  return base ? `${base} - Manufactured` : '';
}

function normalizeProductionCategory(itemName = '', value = '', itemType = 'manufactured') {
  const rawCategory = String(value || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .replace(/\s+-\s+Sub-?Recipe$/i, '')
    .trim();

  if (itemType === 'sub_recipe') return normalizeSubRecipeCategory(rawCategory);

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

function normalizeSubRecipeCategory(category = '') {
  const raw = String(category || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Sub[-\s]?Recipe$/i, '')
    .replace(/^Sub[-\s]?Recipe$/i, '')
    .trim();
  return `${raw || 'General'} - Sub Recipe`;
}

function readPayloadField(payload = {}, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) return payload[key];
  }
  const normalized = new Map(Object.keys(payload).map((key) => [normalizePayloadKey(key), key]));
  for (const key of keys) {
    const match = normalized.get(normalizePayloadKey(key));
    if (match) return payload[match];
  }
  return '';
}

function normalizePayloadKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
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

function normalizeCategoryNames(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : String(value || '').split(',');

  return [...new Set(entries
    .map((category) => {
      const raw = String(category || '');
      const manufacturedCategory = raw.toLowerCase().includes('manufactured')
        ? raw.match(/\(([^)]+)\)\s*-\s*Manufactured$/i)
        : null;
      if (manufacturedCategory?.[1]) return manufacturedCategory[1].trim();
      const stripped = raw.replace(' - Raw Materials', '').replace(' - Manufactured', '').trim();
      const hyphenParts = raw.toLowerCase().includes('manufactured')
        ? stripped.split(/\s+-\s+/).filter(Boolean)
        : [];
      if (hyphenParts.length > 1) return hyphenParts.at(-1).trim();
      return stripped;
    })
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function normalizeManufacturingLogs(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => ({
      ...item,
      id: String(item.id || id || createId('mfg')),
      itemId: String(item.itemId || '').trim(),
      itemName: String(item.itemName || '').trim(),
      producedQty: Number(item.producedQty || 0) || 0,
      expectedQty: Number(item.expectedQty || 0) || 0,
      variance: Number(item.variance || 0) || 0,
      wastageQty: Number(item.wastageQty || 0) || 0,
      wastageValue: Number(item.wastageValue || 0) || 0,
      expectedUnitCost: Number(item.expectedUnitCost || item.unitCost || 0) || 0,
      actualUnitCost: Number(item.actualUnitCost || item.unitCost || 0) || 0,
      batchCost: Number(item.batchCost || 0) || 0,
      unit: String(item.unit || '').trim(),
      date: String(item.date || '').trim(),
      timestamp: item.timestamp || '',
      locationId: String(item.locationId || '').trim(),
      locationName: String(item.locationName || '').trim(),
      note: String(item.note || '').trim(),
      components: Array.isArray(item.components) ? item.components : Object.values(item.components || {})
    }));
}

function normalizeCloudflareLocation(row = {}) {
  const id = String(row.id || '').trim();
  return {
    ...row,
    id,
    name: String(row.display_name || row.displayName || row.name || row.external_name || id).trim(),
    siteId: DEFAULT_SITE_ID,
    siteName: 'Main Site',
    type: String(row.kind || row.type || 'selling').trim(),
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault: Number(row.is_default || row.isDefault || 0) === 1 || id === 'main'
  };
}

function sortByName(items = []) {
  return [...items].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function sortLogs(items = []) {
  return [...items].sort((left, right) => String(right.timestamp || right.date || '').localeCompare(String(left.timestamp || left.date || '')));
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}
