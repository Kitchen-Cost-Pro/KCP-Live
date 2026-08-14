import type { DbStatementLike, Env } from '../legacy/types';
import { fallbackStockItemUnitCost } from '../legacy/inventory-costing';

type Row = Record<string, unknown>;

interface StockItemRow extends Row {
  id: string;
  name: string;
  category?: string;
  item_type?: string;
  unit?: string;
  unit_cost?: number;
  batch_yield?: number;
  raw_json?: string;
}

interface RecipeRow extends Row {
  id: string;
  owner_type: string;
  owner_id: string;
  yield_qty?: number;
}

interface RecipeLineRow extends Row {
  id: string;
  recipe_id: string;
  stock_item_id: string;
  quantity?: number;
  unit?: string;
}

interface UomConfiguration {
  customUom?: string;
  custom_uom?: string;
  ratio?: number | string;
}

interface DepletionLine {
  stockItem: StockItemRow;
  quantity: number;
}

export interface IngredientDepletion {
  stockItemId: string;
  stockItemName: string;
  unit: string;
  unitCost: number;
  totalQty: number;
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function objectValue(value: unknown): Row {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

function normalizeText(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A recipe line's `unit` may be a custom UOM configured on the stock item (e.g. "box" where
// 1 box = 12 base units), not the item's base unit. Deduction must convert the recorded line
// quantity into the item's base unit before it is ever written to stock_balances/stock_movements,
// or usage is silently under/over-deducted by whatever the ratio happens to be. This mirrors the
// ratio lookup the frontend already applies for cost preview (getIngredientUomRatio in
// Recipes.js) — that logic was never mirrored here, which is what let base-unit deductions go out
// unconverted.
function resolveUomRatio(stockItem: StockItemRow, lineUnit: string): number {
  const baseUnit = text(stockItem.unit, 'ea').toLowerCase();
  const requestedUnit = text(lineUnit).toLowerCase();
  if (!requestedUnit || requestedUnit === baseUnit) return 1;

  const rawJson = objectValue(stockItem.raw_json);
  const configs = Array.isArray(rawJson.uomConfigurations) ? (rawJson.uomConfigurations as UomConfiguration[]) : [];
  const match = configs.find((cfg) => {
    const customUom = text(cfg.customUom || cfg.custom_uom).toLowerCase();
    return customUom && customUom === requestedUnit;
  });
  const ratio = match ? numberValue(match.ratio, 0) : 0;
  return ratio > 0 ? ratio : 1;
}

function stockItemType(item: StockItemRow) {
  const rawJson = objectValue(item.raw_json);
  const isSub = item.is_sub_recipe === 1 || item.is_sub_recipe === 'true' || item.is_sub_recipe === true ||
    rawJson.isSubRecipe === 1 || rawJson.isSubRecipe === 'true' || rawJson.isSubRecipe === true ||
    rawJson.SubRecipe === 1 || rawJson.SubRecipe === 'true' || rawJson.SubRecipe === true;
  if (isSub) return 'sub_recipe';

  const raw = normalizeText(item.item_type || rawJson.itemType || item.category);
  if (raw.includes('sub recipe') || raw.includes('subrecipe') || raw.includes('virtual')) return 'sub_recipe';
  return 'raw';
}

function recipeFor(ownerType: string, ownerId: string, recipes: RecipeRow[]) {
  return recipes.find((recipe) => text(recipe.owner_type) === ownerType && text(recipe.owner_id) === ownerId) || null;
}

function linesForRecipe(recipeId: string, recipeLines: RecipeLineRow[]) {
  return recipeLines.filter((line) => text(line.recipe_id) === recipeId);
}

function expandRecipeLines(
  recipeLines: RecipeLineRow[],
  stockItemsById: Map<string, StockItemRow>,
  recipes: RecipeRow[],
  allRecipeLines: RecipeLineRow[],
  multiplier = 1,
  seen = new Set<string>(),
): DepletionLine[] {
  const expanded: DepletionLine[] = [];
  for (const line of recipeLines) {
    const stockItemId = text(line.stock_item_id);
    const stockItem = stockItemsById.get(stockItemId);
    if (!stockItem) continue;

    // Convert the recipe line's recorded quantity (which may be in a custom UOM, e.g. "1 box")
    // into the stock item's base unit (e.g. "12 ea") before it's used for depletion.
    const uomRatio = resolveUomRatio(stockItem, text(line.unit));
    const quantity = numberValue(line.quantity, 0) * uomRatio * multiplier;
    if (stockItemType(stockItem) === 'sub_recipe' && !seen.has(stockItemId)) {
      const nestedRecipe = recipeFor('stock_item', stockItemId, recipes);
      if (nestedRecipe) {
        const nextSeen = new Set(seen);
        nextSeen.add(stockItemId);
        const yieldQty = Math.max(numberValue(nestedRecipe.yield_qty || stockItem.batch_yield, 1), 1);
        expanded.push(...expandRecipeLines(
          linesForRecipe(text(nestedRecipe.id), allRecipeLines),
          stockItemsById,
          recipes,
          allRecipeLines,
          quantity / yieldQty,
          nextSeen,
        ));
        continue;
      }
    }

    expanded.push({ stockItem, quantity });
  }
  return expanded;
}

async function allRows<T extends Row>(statement: DbStatementLike) {
  const result = await statement.all<T>();
  return (result.results || []) as T[];
}

export async function expandProductIngredients(
  env: Env,
  workspaceId: string,
  productId: string,
  quantity: number,
): Promise<IngredientDepletion[]> {
  const [stockItemsRows, recipesRows, recipeLinesRows, productRow] = await Promise.all([
    allRows<StockItemRow>(env.DB.prepare('SELECT * FROM stock_items WHERE workspace_id = ?1 AND active = 1').bind(workspaceId)),
    allRows<RecipeRow>(env.DB.prepare('SELECT * FROM recipes WHERE workspace_id = ?1 AND active = 1').bind(workspaceId)),
    allRows<RecipeLineRow>(env.DB.prepare('SELECT * FROM recipe_lines WHERE workspace_id = ?1').bind(workspaceId)),
    env.DB.prepare('SELECT recipe_source_stock_item_id FROM products WHERE workspace_id = ?1 AND id = ?2 LIMIT 1').bind(workspaceId, productId).first<{ recipe_source_stock_item_id?: string | null }>(),
  ]);

  const stockItemsById = new Map(stockItemsRows.map((item) => [text(item.id), item]));
  const directRecipe = recipeFor('product', productId, recipesRows);
  const recipeSourceStockItemId = text(productRow?.recipe_source_stock_item_id);
  const linkedRecipe = !directRecipe && recipeSourceStockItemId
    ? recipeFor('stock_item', recipeSourceStockItemId, recipesRows)
    : null;
  const recipe = directRecipe || linkedRecipe;
  if (!recipe) return [];

  return expandRecipeLines(
    linesForRecipe(text(recipe.id), recipeLinesRows),
    stockItemsById,
    recipesRows,
    recipeLinesRows,
  ).map((depletion) => ({
    stockItemId: text(depletion.stockItem.id),
    stockItemName: text(depletion.stockItem.name),
    unit: text(depletion.stockItem.unit),
    unitCost: fallbackStockItemUnitCost(depletion.stockItem, 0),
    totalQty: depletion.quantity * quantity,
  }));
}
