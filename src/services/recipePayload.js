export const REQUIRED_RECIPE_PERSISTENCE_VERSION = 'dual-store-readback-v1';

export function isRecipePersistenceApiCompatible(health = {}) {
  return String(health?.recipePersistenceVersion || '').trim() === REQUIRED_RECIPE_PERSISTENCE_VERSION;
}

export function normalizeRecipeLines(recipe) {
  const lines = Array.isArray(recipe) ? recipe : Object.values(recipe || {});
  return lines
    .filter((line) => {
      const stockItemId = String(line?.ingId || line?.stockItemId || line?.stock_item_id || '').trim();
      return stockItemId && parseDecimal(line?.qty ?? line?.quantity, 0) > 0;
    })
    .map((line) => {
      const stockItemId = String(line.ingId || line.stockItemId || line.stock_item_id).trim();
      // The recipe editor's live input field is `qty`. Loaded API rows also contain the
      // legacy alias `quantity`, so preferring `quantity` here silently discarded edits:
      // `{ qty: 2, quantity: 1 }` was saved as 1 and then passed read-back verification.
      // Resolve the value once, using the editor-owned field first, and emit both aliases
      // from that single value.
      const quantity = parseDecimal(line.qty ?? line.quantity, 0);
      return {
        ingId: stockItemId,
        stockItemId,
        qty: quantity,
        quantity,
        unit: String(line.unit || line.uom || 'ea').trim() || 'ea'
      };
    });
}

export function buildProductRecipeSavePayload(item = {}, recipe = []) {
  return {
    recipe: normalizeRecipeLines(recipe),
    recipeSourceStockItemId: String(item.recipeSourceStockItemId || item.recipe_source_stock_item_id || '').trim()
  };
}

export function recipeLinesMatch(left = [], right = []) {
  const normalizedLeft = normalizeRecipeLines(left);
  const normalizedRight = normalizeRecipeLines(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((line, index) => {
    const other = normalizedRight[index];
    return line.stockItemId === other.stockItemId &&
      Math.abs(line.quantity - other.quantity) < 0.000001 &&
      line.unit.toLowerCase() === other.unit.toLowerCase();
  });
}

export function mergeVerifiedRecipeSave(item = {}, result = {}, draftRecipe = []) {
  const recipe = normalizeRecipeLines(
    Array.isArray(result.recipe) ? result.recipe : draftRecipe
  );
  const recipeSourceStockItemId = Object.prototype.hasOwnProperty.call(result, 'recipeSourceStockItemId')
    ? String(result.recipeSourceStockItemId || '').trim()
    : String(item.recipeSourceStockItemId || item.recipe_source_stock_item_id || '').trim();
  const linkedRecipe = normalizeRecipeLines(
    item.recipeSourceRecipeLines ||
    item.recipe_source_recipe_lines ||
    item.recipeSourceStockItem?.recipe ||
    []
  );
  const effectiveRecipe = recipe.length ? recipe : linkedRecipe;
  const recipeStatus = String(result.recipeStatus || (
    recipe.length
      ? 'COMPLETE'
      : linkedRecipe.length && recipeSourceStockItemId
        ? 'COMPLETE_VIA_LINKED_STOCK_ITEM'
        : 'MISSING_RECIPE'
  ));

  return {
    ...item,
    recipe,
    directRecipe: recipe,
    directRecipeCount: recipe.length,
    recipeSourceStockItemId,
    effectiveRecipe,
    effectiveRecipeLines: effectiveRecipe,
    recipeCount: effectiveRecipe.length,
    recipeStatus,
    recipeSource: recipe.length
      ? item.recipeOwnerType === 'yoco_modifier' ? 'manual_modifier' : 'direct'
      : recipeStatus === 'COMPLETE_VIA_LINKED_STOCK_ITEM'
        ? 'linked_stock_item'
        : 'missing',
    missingRecipe: recipeStatus === 'MISSING_RECIPE',
    status: recipeStatus === 'MISSING_RECIPE' ? 'missing' : 'complete'
  };
}

export async function awaitRecipeSave(promise, timeoutMs = 17000) {
  let timeoutId;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Recipe saving took too long. The editor has been unlocked so you can try again.'));
    }, Math.max(1, Number(timeoutMs) || 17000));
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function settleRecipeSaveState(state = {}) {
  if (state.actionStatus !== 'saving') return state;
  return {
    ...state,
    actionStatus: ''
  };
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
