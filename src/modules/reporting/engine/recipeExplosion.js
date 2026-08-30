import { calculateStockValue, safeNumber } from './calculations.js';
import { text, toArray } from './grouping.js';

const STANDARD_UOM_FACTORS = {
  g: { base: 'kg', factor: 0.001 },
  gram: { base: 'kg', factor: 0.001 },
  grams: { base: 'kg', factor: 0.001 },
  kg: { base: 'kg', factor: 1 },
  kilogram: { base: 'kg', factor: 1 },
  kilograms: { base: 'kg', factor: 1 },
  ml: { base: 'l', factor: 0.001 },
  millilitre: { base: 'l', factor: 0.001 },
  milliliter: { base: 'l', factor: 0.001 },
  l: { base: 'l', factor: 1 },
  litre: { base: 'l', factor: 1 },
  liter: { base: 'l', factor: 1 },
  ea: { base: 'ea', factor: 1 },
  each: { base: 'ea', factor: 1 },
  unit: { base: 'ea', factor: 1 },
  units: { base: 'ea', factor: 1 }
};

export function explodeRecipeToIngredients({ menuItemId, quantitySold = 1, recipeData = {} } = {}) {
  const warnings = [];
  const indexes = buildRecipeIndexes(recipeData);
  const recipe = resolveRecipeForOwner(indexes, 'product', menuItemId) || indexes.recipesById.get(text(menuItemId));

  if (!recipe) {
    warnings.push(warning('missing-recipe', `No recipe exists for menu item ${text(menuItemId) || 'unknown menu item'}.`, { menuItemId }));
    return { rows: [], warnings };
  }

  const exploded = resolveSubRecipeIngredients({
    recipe,
    quantityMultiplier: safeNumber(quantitySold, 1),
    recipeData,
    indexes,
    warnings,
    path: []
  });

  const rows = aggregateIngredientRows(exploded.map((row, index) => ({
    ...row,
    id: row.id || `recipe-usage:${text(menuItemId)}:${row.inventoryItemId}:${index}`,
    menuItemId: text(menuItemId),
    sourceType: 'Sale Usage',
    stockValueUsed: calculateIngredientUsageCost(row)
  })));

  return { rows, warnings: uniqueWarnings(warnings) };
}

export function resolveSubRecipeIngredients({ recipe, quantityMultiplier = 1, recipeData = {}, indexes = buildRecipeIndexes(recipeData), warnings = [], path = [] } = {}) {
  const recipeId = text(recipe?.id);
  if (!recipeId) {
    warnings.push(warning('missing-recipe', 'Recipe could not be resolved because its id is missing.', { recipe }));
    return [];
  }

  if (detectCircularRecipe(path, recipeId)) {
    warnings.push(warning('circular-recipe', `Circular recipe loop detected at recipe ${recipeId}.`, { recipeId, path }));
    return [];
  }

  const yieldQty = Math.max(safeNumber(recipe.yieldQty ?? recipe.yield_qty, 1), 1);
  const recipeMultiplier = safeNumber(quantityMultiplier, 1) / yieldQty;
  const nextPath = [...path, recipeId];
  const lines = indexes.recipeLinesByRecipeId.get(recipeId) || [];

  if (!lines.length) {
    warnings.push(warning('missing-ingredient', `Recipe ${recipeId} has no ingredient lines.`, { recipeId }));
    return [];
  }

  const rows = [];
  for (const line of lines) {
    const stockItemId = text(line.stockItemId || line.stock_item_id || line.itemId || line.item_id || line.ingredientId || line.ingredient_id);
    const stockItem = indexes.stockItemsById.get(stockItemId);
    if (!stockItem) {
      warnings.push(warning('missing-ingredient-stock-item', `Recipe line ${text(line.id) || stockItemId || 'unknown'} points to a missing stock item.`, { recipeId, line }));
      continue;
    }

    const baseUom = text(stockItem.baseUom || stockItem.base_uom || stockItem.unit || stockItem.uom || 'ea');
    const converted = convertToBaseUom({
      qty: safeNumber(line.quantity ?? line.qty, 0),
      fromUom: text(line.unit || line.uom || baseUom),
      toUom: baseUom,
      stockItem,
      recipeData,
      warnings,
      context: { recipeId, lineId: text(line.id), stockItemId }
    });
    const qtyUsed = converted.qty * recipeMultiplier;

    if (isSubRecipeItem(stockItem) && !isStockHoldingPrepItem(stockItem)) {
      const nestedRecipe = resolveRecipeForOwner(indexes, 'stock_item', stockItemId);
      if (!nestedRecipe) {
        warnings.push(warning('missing-recipe', `Sub-recipe stock item ${text(stockItem.name) || stockItemId} has no linked recipe.`, { stockItemId, recipeId }));
        continue;
      }
      rows.push(...resolveSubRecipeIngredients({
        recipe: nestedRecipe,
        quantityMultiplier: qtyUsed,
        recipeData,
        indexes,
        warnings,
        path: nextPath
      }));
      continue;
    }

    // A genuinely zero unit cost (a free or zero-valued ingredient) is a real cost, not a missing
    // one: resolveUnitCost returns null only when no cost is present anywhere, and only that case
    // is warned about.
    const resolvedUnitCost = resolveUnitCost(stockItem, line);
    const unitCostExVat = resolvedUnitCost === null ? 0 : resolvedUnitCost;
    if (resolvedUnitCost === null) {
      warnings.push(warning('missing-unit-cost', `Missing unit cost for ingredient ${text(stockItem.name) || stockItemId}.`, { stockItemId, recipeId }));
    }

    rows.push({
      id: `recipe-usage:${recipeId}:${stockItemId}:${text(line.id)}`,
      recipeId,
      recipeLineId: text(line.id),
      inventoryItemId: stockItemId,
      inventoryItemName: text(stockItem.name || stockItem.itemName || stockItem.stockItemName),
      inventoryCategoryId: text(stockItem.categoryId || stockItem.category_id || stockItem.category),
      inventoryCategoryName: text(stockItem.categoryName || stockItem.category_name || stockItem.category) || 'General',
      qtyUsed,
      baseUom,
      unitCostExVat,
      raw: { recipe, line, stockItem }
    });
  }

  return rows;
}

export function convertToBaseUom({ qty = 0, fromUom = '', toUom = '', stockItem = {}, recipeData = {}, warnings = [], context = {} } = {}) {
  const quantity = safeNumber(qty, 0);
  const from = normalizeUom(fromUom || toUom || stockItem.unit || stockItem.baseUom || stockItem.base_uom);
  const to = normalizeUom(toUom || stockItem.baseUom || stockItem.base_uom || stockItem.unit || from);
  if (!from || !to || from === to) return { qty: quantity, factor: 1, fromUom: from, toUom: to };

  const explicitFactor = findExplicitConversionFactor({ from, to, stockItem, recipeData });
  if (explicitFactor) return { qty: quantity * explicitFactor, factor: explicitFactor, fromUom: from, toUom: to };

  const standardFrom = STANDARD_UOM_FACTORS[from];
  const standardTo = STANDARD_UOM_FACTORS[to];
  if (standardFrom && standardTo && standardFrom.base === standardTo.base) {
    const factor = standardFrom.factor / standardTo.factor;
    return { qty: quantity * factor, factor, fromUom: from, toUom: to };
  }

  // 'ea' reaching here is the recipe editor's "no UOM chosen" sentinel, not the unit "each" — it
  // means "use the stock item's base unit", which is what the editor itself displays for such a
  // line. Warning about it produced an unactionable "Missing UOM conversion from ea to kg." on
  // every kg/g/L/ml recipe line. Mirrors convertMenuRecipeQty in the worker's reporting-routes.ts
  // and the stock-side contract in cloudflare-v2/src/inventory/uom.ts — keep all three in step.
  if (from === 'ea') return { qty: quantity, factor: 1, fromUom: from, toUom: to };

  warnings.push(warning('missing-uom-conversion', `Missing UOM conversion from ${from || 'unknown'} to ${to || 'base UOM'}.`, context));
  return { qty: quantity, factor: 1, fromUom: from, toUom: to, missingConversion: true };
}

export function detectCircularRecipe(path = [], recipeId = '') {
  const key = text(recipeId);
  return Boolean(key && toArray(path).map((entry) => text(entry)).includes(key));
}

export function calculateIngredientUsageCost(row = {}) {
  return calculateStockValue(safeNumber(row.qtyUsed ?? row.qty_used), safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost));
}

function buildRecipeIndexes(recipeData = {}) {
  const recipes = toArray(recipeData.recipes || recipeData.recipeRows || recipeData.recipeHeaders);
  const recipeLines = toArray(recipeData.recipeLines || recipeData.lines || recipeData.ingredients);
  const stockItems = toArray(recipeData.stockItems || recipeData.items || recipeData.inventoryItems);
  const recipesById = new Map();
  const recipesByOwner = new Map();
  const recipeLinesByRecipeId = new Map();
  const stockItemsById = new Map();

  recipes.forEach((recipe) => {
    const id = text(recipe.id || recipe.recipeId || recipe.recipe_id);
    if (id) recipesById.set(id, recipe);
    const ownerType = text(recipe.ownerType || recipe.owner_type || 'product');
    const ownerId = text(recipe.ownerId || recipe.owner_id || recipe.menuItemId || recipe.productId || recipe.stockItemId);
    if (ownerType && ownerId) recipesByOwner.set(`${ownerType}:${ownerId}`, recipe);
  });

  recipeLines.forEach((line) => {
    const recipeId = text(line.recipeId || line.recipe_id);
    if (!recipeId) return;
    if (!recipeLinesByRecipeId.has(recipeId)) recipeLinesByRecipeId.set(recipeId, []);
    recipeLinesByRecipeId.get(recipeId).push(line);
  });

  stockItems.forEach((item) => {
    const id = text(item.id || item.stockItemId || item.stock_item_id || item.itemId || item.item_id);
    if (id) stockItemsById.set(id, item);
  });

  return { recipes, recipeLines, stockItems, recipesById, recipesByOwner, recipeLinesByRecipeId, stockItemsById };
}

function resolveRecipeForOwner(indexes, ownerType, ownerId) {
  return indexes.recipesByOwner.get(`${text(ownerType)}:${text(ownerId)}`) || null;
}

function aggregateIngredientRows(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const key = [row.menuItemId, row.inventoryItemId, row.baseUom, row.sourceType].map(text).join('::');
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...row });
      continue;
    }
    const qtyUsed = safeNumber(existing.qtyUsed) + safeNumber(row.qtyUsed);
    grouped.set(key, {
      ...existing,
      qtyUsed,
      stockValueUsed: calculateStockValue(qtyUsed, existing.unitCostExVat),
      raw: {
        ...existing.raw,
        aggregatedRows: [...toArray(existing.raw?.aggregatedRows), row]
      }
    });
  }
  return [...grouped.values()];
}

function isSubRecipeItem(stockItem = {}) {
  const raw = parseJson(stockItem.raw_json || stockItem.raw || '{}');
  const type = text(stockItem.itemType || stockItem.item_type || raw.itemType || raw.item_type || stockItem.type).toLowerCase().replace(/[_-]+/g, ' ');
  return Boolean(
    type.includes('sub recipe') ||
    type.includes('subrecipe') ||
    raw.isSubRecipe === true || raw.isSubRecipe === 1 || raw.isSubRecipe === 'true' ||
    stockItem.isSubRecipe === true || stockItem.isSubRecipe === 1 || stockItem.is_sub_recipe === 1
  );
}

function isStockHoldingPrepItem(stockItem = {}) {
  const raw = parseJson(stockItem.raw_json || stockItem.raw || '{}');
  const type = text(stockItem.itemType || stockItem.item_type || raw.itemType || raw.item_type || stockItem.type).toLowerCase().replace(/[_-]+/g, ' ');
  const explicitlyStocked = stockItem.isStocked === true || stockItem.is_stocked === true || stockItem.is_stocked === 1 || raw.isStocked === true || raw.isStocked === 1;
  const prepLike = type.includes('prep') || type.includes('manufactured') || type.includes('stock holding');
  return explicitlyStocked && prepLike;
}

// Returns the resolved unit cost, or null when no cost value is present at all. A present value of
// 0 is returned as 0 so callers can tell "free ingredient" apart from "cost not captured".
function resolveUnitCost(stockItem = {}, line = {}) {
  const raw =
    line.unitCostExVat ?? line.unit_cost_ex_vat ?? line.unitCost ?? line.unit_cost ??
    stockItem.unitCostExVat ?? stockItem.unit_cost_ex_vat ?? stockItem.unitCost ?? stockItem.unit_cost ?? stockItem.costExVat ?? stockItem.cost;
  // Only a finite number or a non-blank numeric string counts as present. Booleans, arrays and
  // whitespace-only strings would all coerce to 0 through `Number()` and masquerade as a genuine
  // zero cost, swallowing the missing-unit-cost warning they should raise.
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function findExplicitConversionFactor({ from, to, stockItem = {}, recipeData = {} } = {}) {
  const lineRatio = safeNumber(stockItem?.uomRatio ?? stockItem?.uom_ratio, 0);
  if (lineRatio && normalizeUom(stockItem?.unit || stockItem?.uom) === from && normalizeUom(stockItem?.baseUom || stockItem?.base_uom) === to) return lineRatio;

  // The UOM builder saves custom UOM ratios under `uomConfigurations` with shape
  // { baseUom, customUom, ratio } (see normalizeUomConfigurations on the backend) — NOT
  // `uomConversions` with a { from, to, factor } shape. This previously only ever checked
  // `uomConversions`, a field nothing in the app actually writes, so a configured custom UOM
  // ratio could never be found and every custom-UOM recipe line was flagged as a missing
  // conversion regardless of what was actually set up.
  const rawJsonUomConfigurations = parseJson(stockItem.raw_json || stockItem.raw || '{}').uomConfigurations;
  const configuredUoms = [
    ...toArray(stockItem.uomConfigurations),
    ...toArray(rawJsonUomConfigurations)
  ];
  const entryCustom = (entry) => normalizeUom(entry.customUom || entry.custom_uom || entry.customUnit);
  const entryBase = (entry) => normalizeUom(entry.baseUom || entry.base_uom || entry.baseUnit);
  const entryRatio = (entry) => safeNumber(entry.ratio ?? entry.conversionRatio ?? entry.unitsPerCustomUnit ?? entry.units_per_custom_unit, 0);

  const configMatch = configuredUoms.find((entry) =>
    entryCustom(entry) === from && (entryBase(entry) === to || !entryBase(entry))
  );
  if (configMatch) {
    const factor = entryRatio(configMatch);
    if (factor) return factor;
  }

  // A configured ratio describes both directions. `ratio` is base units per ONE custom unit, so the
  // custom -> base direction is the ratio and base -> custom is its reciprocal. Without this inverse
  // lookup a recipe line written in the base UOM against an item stocked in a custom one was still
  // reported as a missing conversion even though the ratio was set up in the UOM builder.
  const inverseMatch = configuredUoms.find((entry) =>
    entryBase(entry) === from && entryCustom(entry) === to && entryRatio(entry) > 0
  );
  if (inverseMatch) return 1 / entryRatio(inverseMatch);

  const conversions = [
    ...toArray(recipeData.uomConversions),
    ...toArray(stockItem.uomConversions),
    ...toArray(parseJson(stockItem.raw_json || stockItem.raw || '{}').uomConversions)
  ];
  const match = conversions.find((conversion) => normalizeUom(conversion.from || conversion.uom || conversion.name) === from && normalizeUom(conversion.to || conversion.baseUom || conversion.base_uom || stockItem.baseUom || stockItem.base_uom) === to);
  return match ? safeNumber(match.factor ?? match.ratio ?? match.qtyInBase ?? match.qty_in_base, 0) : 0;
}

function normalizeUom(value = '') {
  return text(value).toLowerCase().replace(/\./g, '').trim();
}

function warning(code, message, details = {}) {
  return { code, level: code.includes('circular') ? 'critical' : 'warning', message, details };
}

function uniqueWarnings(warnings = []) {
  const seen = new Set();
  return warnings.filter((entry) => {
    const key = `${entry.code}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
