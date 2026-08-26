function asFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readCostEntry(entry) {
  const parsed = parseMaybeJson(entry);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const candidates = [
      parsed.cost,
      parsed.unitCost,
      parsed.unit_cost,
      parsed.unitCostExVat,
      parsed.unit_cost_ex_vat,
      parsed.price,
      parsed.value
    ];
    for (const candidate of candidates) {
      const number = asFiniteNumber(candidate);
      if (number !== null) return { found: true, value: number };
    }
    return { found: false, value: 0 };
  }

  const number = asFiniteNumber(parsed);
  return number === null
    ? { found: false, value: 0 }
    : { found: true, value: number };
}

function findLocationCostEntry(costs, locationId) {
  const parsed = parseMaybeJson(costs);
  const id = String(locationId || '').trim();
  if (!id || !parsed) return undefined;

  if (Array.isArray(parsed)) {
    return parsed.find((entry) => String(
      entry?.locationId ?? entry?.location_id ?? entry?.id ?? entry?.location ?? ''
    ).trim() === id);
  }

  if (typeof parsed === 'object') return parsed[id];
  return undefined;
}

function resolveFallbackUnitCost(item = {}) {
  const candidates = [
    item.cost,
    item.unitCost,
    item.unit_cost,
    item.unitCostExVat,
    item.unit_cost_ex_vat,
    item.costExVat,
    item.cost_ex_vat,
    item.costEx,
    item.lastPurchasePrice,
    item.lastPurchaseCost,
    item.latestPurchasePrice
  ];
  for (const candidate of candidates) {
    const number = asFiniteNumber(candidate);
    if (number !== null) return number;
  }
  return 0;
}

/**
 * Resolves the exact unit cost shown for a stock item at a location.
 * Explicit location values, including zero, take precedence over workspace fallbacks.
 */
export function resolveLocationUnitCost(item = {}, locationId = '') {
  const id = String(locationId || '').trim();
  const fallback = resolveFallbackUnitCost(item);
  if (!id) return fallback;

  const costMaps = [
    item.locationCosts,
    item.locationPrices,
    item.locationPricing,
    item.pricesByLocation,
    item.location_costs_json,
    item.location_prices_json
  ];

  for (const costs of costMaps) {
    const entry = findLocationCostEntry(costs, id);
    const resolved = readCostEntry(entry);
    if (resolved.found) return resolved.value;
  }

  return fallback;
}

function normalizeItemType(item = {}) {
  return String(
    item.itemType ?? item.item_type ?? item.type ?? ''
  ).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function parseBoolean(value) {
  if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return null;
}

/**
 * Only virtual/non-stock recipe ingredients should be exploded into their own recipe.
 * Physical Prep/Manufactured stock items must use their stored per-location unit cost,
 * matching Stock Items and reporting valuation.
 */
export function shouldExpandIngredientRecipe(item = {}) {
  const itemType = normalizeItemType(item);
  const category = String(item.category || '').trim().toLowerCase();
  const stocked = parseBoolean(item.isStocked ?? item.is_stocked);
  const isSubRecipe = item.isSubRecipe === true || item.is_sub_recipe === true ||
    ['sub_recipe', 'subrecipe', 'virtual'].includes(itemType) || /sub[-\s]?recipe/.test(category);
  const isPrep = item.isManufactured === true || item.is_manufactured === true ||
    ['manufactured', 'prep', 'stock_holding_prep'].includes(itemType) || /manufactured|\bprep\b/.test(category);

  if (isPrep && stocked !== false) return false;
  return isSubRecipe || (isPrep && stocked === false);
}

function parseQuantity(value) {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

/**
 * Resolves an ingredient unit cost while preventing circular recipe expansion.
 */
export function resolveRecipeIngredientUnitCost(ingredientId, ingredients = [], locationId = '', seen = new Set()) {
  const ingredient = (ingredients || []).find((item) => String(item?.id) === String(ingredientId));
  if (!ingredient) return 0;

  const key = String(ingredient.id || ingredientId);
  if (seen.has(key)) return 0;
  const nextSeen = new Set(seen);
  nextSeen.add(key);

  const recipe = Array.isArray(ingredient.recipe) ? ingredient.recipe : [];
  if (recipe.length && shouldExpandIngredientRecipe(ingredient)) {
    const total = recipe.reduce((sum, line) => (
      sum + resolveRecipeIngredientUnitCost(line.ingId, ingredients, locationId, nextSeen) * parseQuantity(line.qty)
    ), 0);
    const yieldBatch = asFiniteNumber(ingredient.yieldBatch ?? ingredient.yieldQty) ?? 1;
    return total / (yieldBatch > 0 ? yieldBatch : 1);
  }

  return resolveLocationUnitCost(ingredient, locationId);
}
