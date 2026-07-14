import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { parseBarcodeValues } from '../utils/barcodes.js';
import { getEffectiveRecipeLines, getRecipeStatus, RECIPE_STATUS } from './recipeStatus.js';

export async function fetchMenuItems(workspaceId, options = {}) {
  const workspaceKey = requireWorkspace(workspaceId);
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'products', {
    query: {
      limit: 500,
      _refresh: options.cacheBust ? Date.now() : ''
    }
  });
  return sortMenuItems(dedupeMenuItems(filterMainMenuItems(filterActiveMenuItems(hydrateDerivedVariants((response.products || response.items || []).map(normalizeMenuItem))))));
}

export async function fetchMenuModifiers(workspaceId, options = {}) {
  const workspaceKey = requireWorkspace(workspaceId);
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'yoco/modifier-recipes', {
    method: 'GET',
    query: {
      _refresh: options.cacheBust ? Date.now() : ''
    }
  }).catch(() => ({ items: [] }));
  return sortMenuModifiers(filterActiveMenuItems((response.modifiers || response.items || []).map(normalizeMenuModifier)));
}

export async function updateMenuItem(itemId, updates = {}, options = {}) {
  const id = String(itemId || '').trim();
  if (!id) throw new Error('Menu item id is required.');

  const workspaceKey = requireWorkspace(options.workspaceId || updates.workspaceId);
  await callCloudflareWorkspaceRoute(workspaceKey, `products/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    payload: {
      ...updates,
      id,
      sellingPrice: Number(updates.sellingPrice ?? updates.price ?? 0) || 0,
      barcodes: parseBarcodeValues(updates.barcodes || updates.barcode || ''),
      locationPrices: normalizeMenuLocationPrices(updates.locationPrices || updates.locationPricing || updates.pricesByLocation)
    }
  });
}

export async function deleteMenuItem(itemId, options = {}) {
  const id = String(itemId || '').trim();
  if (!id) throw new Error('Menu item id is required.');
  const workspaceKey = requireWorkspace(options.workspaceId);

  const result = await callCloudflareWorkspaceRoute(workspaceKey, `products/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  if (Object.prototype.hasOwnProperty.call(result, 'deletedCount') && Number(result.deletedCount || 0) < 1) {
    throw new Error('Menu item was not deleted. Refresh the catalogue and try again.');
  }
  return result;
}

export async function deleteMultipleMenuItems(items = [], options = {}) {
  const normalized = items
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .map((id) => String(id || '').trim())
    .filter(Boolean);

  if (!normalized.length) return;
  const workspaceKey = requireWorkspace(options.workspaceId);
  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'products/bulk-delete', {
    method: 'POST',
    payload: { ids: normalized }
  });
  if (Object.prototype.hasOwnProperty.call(result, 'deletedCount') && Number(result.deletedCount || 0) < normalized.length) {
    throw new Error(`Only ${Number(result.deletedCount || 0)} of ${normalized.length} menu items were deleted. Refresh the catalogue and try again.`);
  }
  return result;
}

export async function importMenuItems(workspaceId, items = []) {
  const workspaceKey = requireWorkspace(workspaceId);
  const normalized = items
    .map((item) => normalizeImportedMenuItem(item, workspaceKey))
    .filter((item) => item.name);

  if (!normalized.length) return { importedCount: 0 };

  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'products/import', {
    method: 'POST',
    payload: { rows: normalized }
  });
  return {
    importedCount: Number(response.importedCount || 0),
    skippedCount: Number(response.skippedCount || 0),
    errors: response.errors || []
  };
}

export function subscribeMenuCatalogue(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = requireWorkspace(workspaceId);
  let closed = false;

  const load = async () => {
    try {
      const [productResponse, modifierResponse, locationResponse, yocoStatusResponse] = await Promise.all([
        callCloudflareWorkspaceRoute(workspaceKey, 'products', { query: { limit: 500 } }),
        callCloudflareWorkspaceRoute(workspaceKey, 'yoco/modifier-recipes', { method: 'GET' }).catch(() => ({ items: [] })),
        callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
        callCloudflareWorkspaceRoute(workspaceKey, 'yoco/status', { method: 'GET' }).catch(() => null)
      ]);
      if (closed) return;
      const items = sortMenuItems(dedupeMenuItems(filterMainMenuItems(filterActiveMenuItems(hydrateDerivedVariants((productResponse.products || productResponse.items || []).map(normalizeMenuItem))))));
      const modifierItems = sortMenuModifiers(filterActiveMenuItems((modifierResponse.modifiers || modifierResponse.items || []).map(normalizeMenuModifier)));
      const posIntegration = normalizePosIntegrationStatus(yocoStatusResponse);
      onSnapshot?.({
        status: 'ready',
        source: 'Live catalogue',
        items,
        modifierItems,
        locations: normalizeLocations(locationResponse.locations || []),
        posIntegration,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      if (!closed) onError?.(error, 'live:products');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

function normalizePosIntegrationStatus(status = null) {
  const rawStatus = String(status?.status || '').trim().toLowerCase();
  const active = status?.connectionActive === true || rawStatus === 'connected' || status?.webhook?.enabled === true;
  if (!active) return { active: false, provider: '', label: '' };
  return {
    active: true,
    provider: 'yoco',
    label: 'Yoco'
  };
}

function normalizeMenuItem(item = {}) {
  const recipe = normalizeRecipeForMerge(item.recipe);
  const recipeSourceRecipeLines = normalizeRecipeForMerge(item.recipeSourceRecipeLines || item.recipe_source_recipe_lines || item.recipeSourceStockItem?.recipe || []);
  const recipeSourceStockItem = item.recipeSourceStockItem ? {
    ...item.recipeSourceStockItem,
    recipe: recipeSourceRecipeLines,
    recipeLines: recipeSourceRecipeLines,
    recipeCount: recipeSourceRecipeLines.length
  } : null;
  const recipeStatus = getRecipeStatus({
    ...item,
    recipe,
    recipeSourceRecipeLines,
    recipeSourceStockItem
  });
  const effectiveRecipe = normalizeRecipeForMerge(item.effectiveRecipe || item.effectiveRecipeLines || getEffectiveRecipeLines({
    recipe,
    recipeSourceRecipeLines,
    recipeSourceStockItem
  }));
  const modifierGroups = normalizeModifierGroups(item.modifierGroups || item.yocoModifierGroups || []);
  const sellingPrice = Number(
    item.sellingPrice ??
    item.selling_price ??
    item.price ??
    item.menuPrice ??
    0
  ) || 0;
  const sku = String(item.sku || '').trim();
  const customSku = String(item.customSku || '').trim();

  return {
    ...item,
    id: String(item.id || '').trim(),
    source: displaySourceLabel(item.source, 'Live catalogue'),
    name: stripSkuSuffix(item.name || item.productName || item.title || item.id || '', sku || customSku),
    category: item.category || item.menuCategory || 'General',
    sellingPrice,
    locationPrices: normalizeMenuLocationPrices(item.locationPrices || item.locationPricing || item.pricesByLocation),
    barcode: item.barcode || '',
    barcodes: parseBarcodeValues(item),
    customSku,
    sku,
    yocoItemId: item.yocoItemId || '',
    yocoVariantId: item.yocoVariantId || '',
    yocoItemName: item.yocoItemName || item.item?.name || '',
    yocoVariantName: item.yocoVariantName || getYocoVariantDisplay(item),
    yocoOptionSummary: item.yocoOptionSummary || getYocoOptionSummary(item),
    yocoHasMultipleVariants: item.yocoHasMultipleVariants === true || item.item?.has_multiple_variants === true || (Array.isArray(item.item?.variants) && item.item.variants.length > 1),
    yocoCategoryId: item.yocoCategoryId || '',
    yocoCategoryName: item.yocoCategoryName || '',
    yocoBrandId: item.yocoBrandId || '',
    yocoBrandName: item.yocoBrandName || '',
    archived: item.archived === true || item.deleted === true || item.active === false || String(item.catalogueStatus || '').toLowerCase() === 'archived',
    deleted: item.deleted === true,
    active: item.active !== false,
    catalogueStatus: item.catalogueStatus || (item.archived || item.deleted || item.active === false ? 'archived' : 'active'),
    archivedAt: item.archivedAt || '',
    archiveReason: item.archiveReason || '',
	    yocoSellingPrice: Number(item.yocoSellingPrice ?? sellingPrice) || 0,
	    recipe,
	    directRecipe: recipe,
	    directRecipeCount: recipe.length,
	    effectiveRecipe,
	    effectiveRecipeLines: effectiveRecipe,
	    recipeCount: effectiveRecipe.length,
	    recipeStatus,
	    recipeSource: item.recipeSource || (recipeStatus === RECIPE_STATUS.COMPLETE_VIA_LINKED_STOCK_ITEM ? 'linked_stock_item' : recipe.length ? 'direct' : 'missing'),
	    recipeSourceStockItemId: item.recipeSourceStockItemId || item.recipe_source_stock_item_id || '',
	    recipeSourceStockItem,
	    recipeSourceStockItemName: item.recipeSourceStockItemName || recipeSourceStockItem?.name || '',
	    recipeSourceStockItemRecipeCount: Number(item.recipeSourceStockItemRecipeCount || recipeSourceRecipeLines.length || 0) || 0,
	    recipeSourceRecipeLines,
	    modifierGroups,
    modifierGroupCount: Number(item.modifierGroupCount ?? modifierGroups.length) || modifierGroups.length,
    modifierCount: Number(item.modifierCount ?? modifierGroups.reduce((total, group) => total + Number(group.modifierCount || 0), 0)) || 0,
    combinedGpMin: toNullableNumber(item.combinedGpMin),
    combinedGpMax: toNullableNumber(item.combinedGpMax),
    combinedGpDisplay: item.combinedGpDisplay || formatGpRange(item.combinedGpMin, item.combinedGpMax),
	    status: recipeStatus === RECIPE_STATUS.MISSING_RECIPE ? 'missing' : 'complete',
    workspaceId: item.workspaceId || '',
    updatedAt: item.updatedAt || item.modifiedAt || item.createdAt || ''
  };
}

function hydrateDerivedVariants(items = []) {
  const byYocoItem = new Map();
  items.forEach((item) => {
    const itemId = String(item.yocoItemId || '').trim();
    if (itemId) byYocoItem.set(itemId, [...(byYocoItem.get(itemId) || []), item]);
  });

  return items.map((item) => {
    if (String(item.yocoOptionSummary || '').trim()) return item;
    const itemId = String(item.yocoItemId || '').trim();
    const siblings = byYocoItem.get(itemId) || [];
    const itemName = String(item.yocoItemName || inferYocoItemNameFromSiblings(siblings)).trim();
    const variantName = inferVariantNameFromProductName(item.name, itemName);
    if (!variantName) return item;
    return {
      ...item,
      yocoItemName: item.yocoItemName || itemName,
      yocoVariantName: item.yocoVariantName || variantName,
      yocoOptionSummary: variantName,
      yocoHasMultipleVariants: item.yocoHasMultipleVariants || siblings.length > 1
    };
  });
}

function inferYocoItemNameFromSiblings(items = []) {
  if (items.length < 2) return '';
  const prefixes = items
    .map((item) => String(item.name || '').split(/\s+-\s+/)[0]?.trim())
    .filter(Boolean);
  if (prefixes.length !== items.length) return '';
  const first = prefixes[0];
  return prefixes.every((prefix) => prefix.toLowerCase() === first.toLowerCase()) ? first : '';
}

function inferVariantNameFromProductName(productName = '', itemName = '') {
  const name = String(productName || '').trim();
  const base = String(itemName || '').trim();
  if (!name || !base) return '';
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = name.match(new RegExp(`^${escaped}\\s+-\\s+(.+)$`, 'i'));
  return String(match?.[1] || '').trim();
}

function normalizeMenuModifier(item = {}) {
  const linkedProductIds = Array.isArray(item.linkedProductIds)
    ? item.linkedProductIds.map(String).filter(Boolean)
    : linkedProductIdsFromValue(item.linkedProductId);
  const linkedProductNames = Array.isArray(item.linkedProductNames)
    ? item.linkedProductNames.map(String).filter(Boolean)
    : linkedProductNamesFromValue(item.linkedProductName);
  const autoLinkedProductName = String(item.autoLinkedProductName || '').trim();
  const yocoModifierProductName = String(item.yocoModifierProductName || '').trim();
  const yocoModifierVariantId = String(item.yocoModifierVariantId || '').trim();
  const recipeCount = Number(item.recipeCount || item.manualRecipeCount || 0) || 0;
  const linkedRecipeCount = Number(item.linkedProductRecipeCount || 0) || 0;
  const modifierLinkStatus = String(item.modifierLinkStatus || '').toLowerCase();
  const isLinked = modifierLinkStatus === 'linked' ||
    linkedProductIds.length > 0 ||
    linkedProductNames.length > 0 ||
    Boolean(autoLinkedProductName || yocoModifierProductName);

  return {
    ...item,
    id: String(item.id || item.recipeOwnerId || item.yocoModifierId || '').trim(),
    name: String(item.name || item.modifierName || item.yocoModifierName || item.id || '').trim(),
    modifierGroup: String(item.yocoModifierGroupName || item.modifierGroupName || item.groupName || item.category || '').trim() || 'Modifier Group',
    sellingPrice: Number(item.sellingPrice ?? item.price ?? 0) || 0,
    linkedProductIds,
    linkedProductNames,
    linkedProductName: linkedProductNames.join(', '),
    autoLinkedProductName,
    yocoModifierProductName,
    yocoModifierVariantId,
    modifierLinkStatus: item.modifierLinkStatus || '',
    modifierLinkSource: item.modifierLinkSource || '',
    recipeSource: item.recipeSource || '',
    recipeCount,
    linkedProductRecipeCount: linkedRecipeCount,
    status: isLinked ? 'linked' : recipeCount ? 'manual' : 'unlinked',
    statusLabel: isLinked ? 'Linked' : recipeCount ? 'Manual Recipe' : 'Unlinked',
    archived: item.archived === true || item.deleted === true || item.active === false || String(item.catalogueStatus || '').toLowerCase() === 'archived',
    deleted: item.deleted === true,
    active: item.active !== false,
    catalogueStatus: item.catalogueStatus || 'active'
  };
}

function isOptionGroupId(id = '') {
  // Yoco option/choice group IDs are timestamp-UUID composites e.g. "1782807053561-8765c7b5-71df-..."
  // Product modifier groups have human-readable names stored separately; skip groups where the
  // name falls back to the raw ID (no display name) and the ID matches the timestamp-UUID pattern.
  return /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-/.test(id);
}

function normalizeModifierGroups(groups = []) {
  return Array.isArray(groups)
    ? groups
      .map((group) => ({
        id: String(group?.id || group?.yocoModifierGroupId || '').trim(),
        name: String(group?.name || group?.displayName || '').trim(),
        modifierCount: Number(group?.modifierCount || group?.optionCount || 0) || 0,
        gpDisplay: String(group?.gpDisplay || group?.combinedGpDisplay || '').trim()
      }))
      .filter((group) => {
        if (!group.id && !group.name) return false;
        // Drop groups that have no display name and whose ID looks like a Yoco option reference
        if (!group.name && isOptionGroupId(group.id)) return false;
        return true;
      })
      .map((group) => ({ ...group, name: group.name || group.id }))
    : [];
}

function toNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatGpRange(minValue, maxValue) {
  const min = toNullableNumber(minValue);
  const max = toNullableNumber(maxValue);
  if (min === null || max === null) return '';
  const format = (value) => `${value.toFixed(1)}%`;
  return Math.abs(max - min) < 0.05 ? format(min) : `${format(min)}-${format(max)}`;
}

function normalizeImportedMenuItem(item = {}, workspaceKey) {
  const name = String(item.name || item.productName || item.ProductName || '').trim();
  const id = sanitizeDocId(item.id || item.productId || name);
  return {
    id,
    workspaceId: workspaceKey,
    name,
    category: String(item.category || item.ProductCategory || item.Group || 'Imported').trim() || 'Imported',
    sellingPrice: Number(item.sellingPrice ?? item.price ?? item.VariantPrice ?? 0) || 0,
    locationPrices: normalizeMenuLocationPrices(item.locationPrices || item.locationPricing || item.pricesByLocation),
    barcodes: parseBarcodeValues(item.barcodes || item.Barcodes || item.barcode || item.Barcode || item.EAN || item.UPC || '')
  };
}

function normalizeMenuLocationPrices(value = {}) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([locationId, price]) => {
        const entry = price && typeof price === 'object' ? price : { sellingPrice: price };
        return [String(locationId), {
          sellingPrice: Number(entry.sellingPrice ?? entry.price ?? entry.menuPrice ?? 0) || 0,
          updatedAt: entry.updatedAt || ''
        }];
      })
      .filter(([locationId]) => locationId)
  );
}

function getYocoOptionSummary(item = {}) {
  const selected = item.variant?.selected_options || item.variant?.selectedOptions || item.variant?.options;
  if (!Array.isArray(selected)) return '';
  return selected
    .map((entry) => {
      const name = String(entry?.name || entry?.optionName || '').trim();
      const value = String(entry?.value || entry?.valueName || entry?.name || '').trim();
      if (!value) return '';
      return name && name.toLowerCase() !== 'option' && name.toLowerCase() !== value.toLowerCase()
        ? `${name}: ${value}`
        : value;
    })
    .filter(Boolean)
    .join(' / ');
}

function getYocoVariantDisplay(item = {}) {
  const optionSummary = getYocoOptionSummary(item);
  const itemName = String(item.yocoItemName || item.item?.name || item.name || '').trim();
  const explicit = String(item.variant?.name || item.variant?.display_name || item.variant?.displayName || item.variant?.option_name || '').trim();
  if (optionSummary) return optionSummary;
  if (explicit && explicit.toLowerCase() !== itemName.toLowerCase()) return explicit;
  return '';
}

function normalizeLocations(rows = []) {
  return (rows || []).map((row) => {
    const id = String(row.id || row.locationId || '').trim();
    const name = String(row.display_name || row.displayName || row.name || row.external_name || row.externalName || id).trim();
    return {
      id,
      locationId: id,
      name,
      displayName: name,
      type: String(row.kind || row.type || 'selling').trim() || 'selling',
      active: row.active !== false && Number(row.active ?? 1) !== 0,
      isDefault: Number(row.is_default || row.isDefault || 0) === 1
    };
  }).filter((location) => location.id && location.active);
}

function filterActiveMenuItems(items = []) {
  return items.filter((item) => !item.archived && !item.deleted && item.active !== false && String(item.catalogueStatus || '').toLowerCase() !== 'archived');
}

function filterMainMenuItems(items = []) {
  return items.filter((item) => !isModifierMenuProduct(item));
}

function isModifierMenuProduct(item = {}) {
  const id = String(item.id || '').trim().toLowerCase();
  const category = String(item.category || '').trim().toLowerCase();
  const ownerType = String(item.recipeOwnerType || item.ownerType || '').trim().toLowerCase();
  const source = String(item.source || item.recipeSource || '').trim().toLowerCase();
  return id.startsWith('modifier:') ||
    ownerType === 'yoco_modifier' ||
    category.startsWith('modifier -') ||
    source.includes('yoco modifier');
}

function stripSkuSuffix(name = '', sku = '') {
  const value = String(name || '').trim();
  const code = String(sku || '').trim();
  if (!value || !code) return value;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`\\s+-\\s+${escaped}$`, 'i'), '').trim();
}

function dedupeMenuItems(items = []) {
  const byKey = new Map();
  items.forEach((item) => {
    const key = [
      String(item.name || '').trim().toLowerCase().replace(/\s+/g, ' '),
      String(item.category || '').trim().toLowerCase().replace(/\s+/g, ' ')
    ].join('|');
    if (!key.replace('|', '')) return;
    const previous = byKey.get(key);
    if (!previous || String(item.updatedAt || '').localeCompare(String(previous.updatedAt || '')) > 0) {
      byKey.set(key, item);
    }
  });
  return [...byKey.values()];
}

function normalizeRecipeForMerge(recipe) {
  return Array.isArray(recipe) ? recipe : Object.values(recipe || {});
}

function sortMenuItems(items) {
  return [...items].sort((a, b) => {
    const categoryCompare = String(a.category || '').localeCompare(String(b.category || ''));
    if (categoryCompare) return categoryCompare;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function sortMenuModifiers(items) {
  return [...items].sort((a, b) => {
    const groupCompare = String(a.modifierGroup || '').localeCompare(String(b.modifierGroup || ''));
    if (groupCompare) return groupCompare;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function linkedProductIdsFromValue(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function linkedProductNamesFromValue(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function sanitizeDocId(value = '') {
  const safe = String(value || '')
    .trim()
    .replace(/[.#$/[\]]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return safe || globalThis.crypto?.randomUUID?.() || `menu_${Date.now()}`;
}

function requireWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for menu catalogue.');
  return workspaceKey;
}

function displaySourceLabel(source = '', fallback = 'Live data') {
  const value = String(source || '').trim();
  return value && !/flare|d1/i.test(value) ? value : fallback;
}
