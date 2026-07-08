import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchStock } from './stockService.js';
import { parseBarcodeValues } from '../utils/barcodes.js';
import { getEffectiveRecipeLines, getRecipeStatus, RECIPE_STATUS } from './recipeStatus.js';

export function subscribeRecipeWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = requireWorkspace(workspaceId);
  let closed = false;

  const load = async () => {
    try {
      const [productResponse, modifierResponse, stockResponse] = await Promise.all([
        callCloudflareWorkspaceRoute(workspaceKey, 'products', { query: { limit: 500 } }),
        callCloudflareWorkspaceRoute(workspaceKey, 'yoco/modifier-recipes', { method: 'GET' }).catch(() => ({ items: [] })),
        fetchStock(workspaceKey)
      ]);
      if (closed) return;
      const productItems = (productResponse.products || productResponse.items || []).map(normalizeRecipeItem);
      const modifierItems = (modifierResponse.modifiers || modifierResponse.items || []).map(normalizeRecipeItem);
      const items = sortRecipeItems(filterActiveRecipeItems([...productItems, ...modifierItems]));
      onSnapshot?.({
        status: 'ready',
        items,
        ingredients: stockResponse.items || [],
        source: 'Live catalogue',
        loaded: {
          firestoreItems: false,
          realtimeItems: false,
          menuItems: true,
          ingredients: true
        },
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      if (!closed) onError?.(error, 'live:recipes');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchRecipeItems(workspaceId, options = {}) {
  const workspaceKey = requireWorkspace(workspaceId);
  const [productResponse, modifierResponse, stockResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'products', {
      query: {
        limit: 500,
        _refresh: options.cacheBust ? Date.now() : ''
      }
    }),
    callCloudflareWorkspaceRoute(workspaceKey, 'yoco/modifier-recipes', {
      method: 'GET',
      query: {
        _refresh: options.cacheBust ? Date.now() : ''
      }
    }).catch(() => ({ items: [] })),
    fetchStock(workspaceKey)
  ]);
  const productItems = (productResponse.products || productResponse.items || []).map(normalizeRecipeItem);
  const modifierItems = (modifierResponse.modifiers || modifierResponse.items || []).map(normalizeRecipeItem);
  return {
    items: sortRecipeItems(filterActiveRecipeItems([...productItems, ...modifierItems])),
    ingredients: stockResponse.items || []
  };
}

export async function updateRecipe(workspaceId, item, recipe = []) {
  const workspaceKey = requireWorkspace(workspaceId);
  if (!item?.id) throw new Error('Menu item id is required to update recipes.');
  if (item.recipeOwnerType === 'yoco_modifier') {
    const ownerId = String(item.recipeOwnerId || item.id).replace(/^modifier:/, '');
    await callCloudflareWorkspaceRoute(workspaceKey, `yoco/modifier-recipes/${encodeURIComponent(ownerId)}`, {
      method: 'PATCH',
      payload: {
        recipe: normalizeRecipeLines(recipe),
        linkedProductId: item.linkedProductId || '',
        linkedProductIds: Array.isArray(item.linkedProductIds) ? item.linkedProductIds : linkedProductIdsFromValue(item.linkedProductId)
      }
    });
    return;
  }

	  await callCloudflareWorkspaceRoute(workspaceKey, `products/${encodeURIComponent(item.id)}`, {
	    method: 'PATCH',
	    payload: {
	      id: item.id,
	      name: item.name,
	      category: item.category || 'General',
	      sellingPrice: Number(item.sellingPrice || item.price || 0) || 0,
	      recipeSourceStockItemId: item.recipeSourceStockItemId || '',
	      recipe: normalizeRecipeLines(recipe)
	    }
	  });
}

export async function clearMultipleRecipes(workspaceId, items = []) {
  const workspaceKey = requireWorkspace(workspaceId);
  const normalizedItems = (items || []).filter((item) => item?.id);
  if (!normalizedItems.length) return { clearedCount: 0 };

  const productItems = normalizedItems.filter((item) => !isModifierRecipeItem(item));
  const modifierItems = normalizedItems.filter(isModifierRecipeItem);

  await Promise.all([
    ...productItems.map((item) => callCloudflareWorkspaceRoute(
      workspaceKey,
      `products/${encodeURIComponent(item.id)}`,
      {
        method: 'PATCH',
        payload: {
          id: item.id,
          name: item.name,
          category: item.category || 'General',
          sellingPrice: Number(item.sellingPrice || item.price || 0) || 0,
          recipe: []
        }
      }
    )),
    ...modifierItems.map((item) => callCloudflareWorkspaceRoute(
      workspaceKey,
      `yoco/modifier-recipes/${encodeURIComponent(getModifierRecipeOwnerId(item))}`,
      {
        method: 'PATCH',
        payload: {
          recipe: [],
          linkedProductId: '',
          linkedProductIds: []
        }
      }
    ))
  ]);

  return {
    clearedCount: normalizedItems.length,
    productCount: productItems.length,
    modifierCount: modifierItems.length
  };
}

export async function deleteModifierRecipes(workspaceId, items = []) {
  const workspaceKey = requireWorkspace(workspaceId);
  const modifierItems = (items || []).filter(isModifierRecipeItem);
  if (!modifierItems.length) return { deletedCount: 0 };

  const results = await Promise.all(modifierItems.map((item) => callCloudflareWorkspaceRoute(
    workspaceKey,
    `yoco/modifier-recipes/${encodeURIComponent(getModifierRecipeOwnerId(item))}`,
    { method: 'DELETE' }
  )));
  return {
    deletedCount: results.reduce((total, result) => total + Number(result?.deletedCount ?? 1), 0),
    modifierCount: modifierItems.length
  };
}

export async function importRecipes(workspaceId, recipeItems = []) {
  const workspaceKey = requireWorkspace(workspaceId);
  const items = recipeItems
    .map((item) => ({
      id: sanitizeDocId(item.id || item.name),
      name: String(item.name || '').trim(),
      category: String(item.category || '').trim() || 'General',
      sellingPrice: Number(item.sellingPrice || item.price || 0) || 0,
      price: Number(item.sellingPrice || item.price || 0) || 0,
      sku: String(item.sku || item.customSku || '').trim(),
      customSku: String(item.customSku || item.sku || '').trim(),
      externalProvider: item.externalProvider || (item.yocoItemId || item.yocoVariantId ? 'yoco' : ''),
      yocoItemId: item.yocoItemId || '',
      yocoVariantId: item.yocoVariantId || '',
      yocoCategoryId: item.yocoCategoryId || '',
      yocoCategoryName: item.yocoCategoryName || '',
      recipe: normalizeRecipeLines(item.recipe || [])
    }))
    .filter((item) => item.name);

  if (!items.length) return { importedCount: 0 };

  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'products/import', {
    method: 'POST',
    payload: { rows: items }
  });

  return {
    importedCount: Number(response.importedCount || 0),
    skippedCount: Number(response.skippedCount || 0),
    errors: response.errors || []
  };
}

export async function createRecipeShell(workspaceId, item = {}) {
  const workspaceKey = requireWorkspace(workspaceId);
  const id = sanitizeDocId(item.id || item.name);
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'products', {
    method: 'POST',
    payload: {
      id,
      name: String(item.name || id).trim(),
      category: String(item.category || 'General').trim() || 'General',
      sellingPrice: Number(item.sellingPrice || 0) || 0,
      recipe: normalizeRecipeLines(item.recipe || [])
    }
  });

  return response.id || id;
}

export function calculateRecipeCost(recipe = [], ingredients = []) {
  const ingredientMap = new Map((ingredients || []).map((ingredient) => [String(ingredient.id), ingredient]));
  return calculateRecipeCostFromMap(recipe, ingredientMap, new Set());
}

function normalizeRecipeItem(item = {}) {
  const recipe = normalizeRecipeLines(item.recipe || []);
  const recipeSourceRecipeLines = normalizeRecipeLines(item.recipeSourceRecipeLines || item.recipe_source_recipe_lines || item.recipeSourceStockItem?.recipe || []);
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
  const effectiveRecipe = normalizeRecipeLines(item.effectiveRecipe || item.effectiveRecipeLines || getEffectiveRecipeLines({
    recipe,
    recipeSourceRecipeLines,
    recipeSourceStockItem
  }));
  const archived = item.archived === true ||
    item.deleted === true ||
    item.active === false ||
    String(item.catalogueStatus || '').toLowerCase() === 'archived';
  const sku = String(item.sku || '').trim();
  const customSku = String(item.customSku || '').trim();
  return {
    ...item,
    id: String(item.id || '').trim(),
    source: displaySourceLabel(item.source, 'Live catalogue'),
    workspaceId: item.workspaceId || '',
    name: stripSkuSuffix(item.name || item.productName || item.title || item.id || '', sku || customSku),
    category: item.category || item.menuCategory || 'General',
    sellingPrice: Number(item.sellingPrice ?? item.price ?? 0) || 0,
    archived,
    deleted: item.deleted === true,
    active: item.active !== false,
    catalogueStatus: item.catalogueStatus || (archived ? 'archived' : 'active'),
    barcode: item.barcode || '',
    barcodes: parseBarcodeValues(item),
    customSku,
    sku,
    yocoItemId: item.yocoItemId || '',
    yocoVariantId: item.yocoVariantId || '',
    yocoItemName: item.yocoItemName || '',
    yocoVariantName: item.yocoVariantName || '',
    yocoOptionSummary: item.yocoOptionSummary || '',
    yocoCategoryId: item.yocoCategoryId || '',
    yocoCategoryName: item.yocoCategoryName || '',
    yocoBrandId: item.yocoBrandId || '',
    yocoBrandName: item.yocoBrandName || '',
    yocoModifierId: item.yocoModifierId || '',
    yocoModifierVariantId: item.yocoModifierVariantId || '',
    yocoModifierGroupId: item.yocoModifierGroupId || '',
    yocoModifierGroupName: item.yocoModifierGroupName || '',
    linkedProductId: item.linkedProductId || '',
    linkedProductIds: Array.isArray(item.linkedProductIds) ? item.linkedProductIds.map(String).filter(Boolean) : linkedProductIdsFromValue(item.linkedProductId),
    linkedProductName: item.linkedProductName || '',
    linkedProductNames: Array.isArray(item.linkedProductNames) ? item.linkedProductNames.map(String).filter(Boolean) : linkedProductNamesFromValue(item.linkedProductName),
	    linkedProductRecipeCount: Number(item.linkedProductRecipeCount || 0) || 0,
	    manualRecipeCount: Number(item.manualRecipeCount || 0) || 0,
	    recipeSourceStockItemId: item.recipeSourceStockItemId || item.recipe_source_stock_item_id || '',
	    recipeSourceStockItem,
	    recipeSourceStockItemName: item.recipeSourceStockItemName || recipeSourceStockItem?.name || '',
	    recipeSourceStockItemRecipeCount: Number(item.recipeSourceStockItemRecipeCount || recipeSourceRecipeLines.length || 0) || 0,
	    recipeSourceRecipeLines,
	    recipeOwnerType: item.recipeOwnerType || 'product',
	    recipeOwnerId: item.recipeOwnerId || item.id || '',
	    recipeSource: item.recipeSource || (recipeStatus === RECIPE_STATUS.COMPLETE_VIA_LINKED_STOCK_ITEM ? 'linked_stock_item' : recipe.length ? 'direct' : 'missing'),
	    recipe,
	    directRecipe: recipe,
	    directRecipeCount: recipe.length,
	    effectiveRecipe,
	    effectiveRecipeLines: effectiveRecipe,
	    recipeCount: effectiveRecipe.length,
	    recipeStatus,
	    status: recipeStatus === RECIPE_STATUS.MISSING_RECIPE ? 'missing' : 'complete'
	  };
}

function filterActiveRecipeItems(items = []) {
  return (items || []).filter((item) => {
    const catalogueStatus = String(item.catalogueStatus || '').toLowerCase();
    return item.deleted !== true &&
      item.archived !== true &&
      item.active !== false &&
      catalogueStatus !== 'archived' &&
      catalogueStatus !== 'deleted';
  });
}

function stripSkuSuffix(name = '', sku = '') {
  const value = String(name || '').trim();
  const code = String(sku || '').trim();
  if (!value || !code) return value;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`\\s+-\\s+${escaped}$`, 'i'), '').trim();
}

function displaySourceLabel(source = '', fallback = 'Live data') {
  const value = String(source || '').trim();
  return value && !/flare|d1/i.test(value) ? value : fallback;
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

function isModifierRecipeItem(item = {}) {
  return item.recipeOwnerType === 'yoco_modifier' || String(item.id || '').startsWith('modifier:');
}

function getModifierRecipeOwnerId(item = {}) {
  return String(item.recipeOwnerId || item.id || '').replace(/^modifier:/, '');
}

function linkedProductNamesFromValue(value = '') {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeRecipeLines(recipe) {
  const lines = Array.isArray(recipe) ? recipe : Object.values(recipe || {});
  return lines
    .filter((line) => (line?.ingId || line?.stockItemId || line?.stock_item_id) && parseDecimal(line.qty ?? line.quantity, 0) > 0)
    .map((line) => ({
      ingId: String(line.ingId || line.stockItemId || line.stock_item_id),
      stockItemId: String(line.stockItemId || line.stock_item_id || line.ingId),
      qty: parseDecimal(line.qty ?? line.quantity, 0),
      quantity: parseDecimal(line.quantity ?? line.qty, 0),
      unit: String(line.unit || line.uom || 'ea').trim() || 'ea'
    }));
}

function sortRecipeItems(items) {
  return [...items].sort((a, b) => {
    const categoryCompare = String(a.category || '').localeCompare(String(b.category || ''));
    if (categoryCompare) return categoryCompare;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function getIngredientUnitCost(ingredientId, ingredientMap, seen = new Set()) {
  const ingredient = ingredientMap.get(String(ingredientId));
  if (!ingredient) return 0;
  const key = String(ingredient.id);
  if (seen.has(key)) return 0;
  seen.add(key);

  const recipe = normalizeRecipeLines(ingredient.recipe || []);
  const isManufactured = ingredient.isManufactured === true ||
    String(ingredient.category || '').toLowerCase().includes('manufactured');

  if (isManufactured && recipe.length) {
    const yieldBatch = Number(ingredient.yieldBatch ?? ingredient.yieldQty ?? 1);
    return calculateRecipeCostFromMap(recipe, ingredientMap, seen) / (yieldBatch > 0 ? yieldBatch : 1);
  }

  return Number(
    ingredient.lastPurchasePrice ??
    ingredient.lastPurchaseCost ??
    ingredient.latestPurchasePrice ??
    ingredient.costEx ??
    ingredient.cost ??
    0
  ) || 0;
}

function calculateRecipeCostFromMap(recipe = [], ingredientMap, seen = new Set()) {
  return normalizeRecipeLines(recipe).reduce((total, line) => {
    return total + getIngredientUnitCost(line.ingId, ingredientMap, new Set(seen)) * parseDecimal(line.qty, 0);
  }, 0);
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

function sanitizeDocId(value = '') {
  const safe = String(value || '')
    .trim()
    .replace(/[.#$/[\]]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return safe || globalThis.crypto?.randomUUID?.() || `recipe_${Date.now()}`;
}

function requireWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for recipes.');
  return workspaceKey;
}
