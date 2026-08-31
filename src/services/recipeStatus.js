export const RECIPE_STATUS = Object.freeze({
  COMPLETE: 'COMPLETE',
  COMPLETE_VIA_LINKED_STOCK_ITEM: 'COMPLETE_VIA_LINKED_STOCK_ITEM',
  MISSING_RECIPE: 'MISSING_RECIPE',
  NOT_REQUIRED: 'NOT_REQUIRED'
});

export function normalizeRecipeLinesForStatus(recipe = []) {
  const lines = Array.isArray(recipe) ? recipe : Object.values(recipe || {});
  return lines.filter((line = {}) => {
    const stockItemId = String(line.ingId || line.stockItemId || line.stock_item_id || line.id || '').trim();
    const quantity = Number(String(line.qty ?? line.quantity ?? 0).replace(',', '.')) || 0;
    return stockItemId && quantity > 0;
  });
}

export function getRecipeStatus(menuItem = {}) {
  if (normalizeRecipeLinesForStatus(menuItem.recipeLines || menuItem.recipe || []).length > 0) {
    return RECIPE_STATUS.COMPLETE;
  }

  const linkedStockItem = menuItem.recipeSourceStockItem || menuItem.recipe_source_stock_item || null;
  const linkedRecipeLines = menuItem.recipeSourceRecipeLines ||
    menuItem.recipe_source_recipe_lines ||
    linkedStockItem?.recipeLines ||
    linkedStockItem?.recipe ||
    [];

  if (normalizeRecipeLinesForStatus(linkedRecipeLines).length > 0) {
    return RECIPE_STATUS.COMPLETE_VIA_LINKED_STOCK_ITEM;
  }

  // A user-set opt-out (e.g. a resold bottled drink, gift card, or service charge) — these items
  // legitimately never have a recipe, so a genuinely missing one must not read as a problem.
  if (menuItem.noRecipeRequired === true) return RECIPE_STATUS.NOT_REQUIRED;

  return RECIPE_STATUS.MISSING_RECIPE;
}

export function getEffectiveRecipeLines(menuItem = {}) {
  const directRecipeLines = normalizeRecipeLinesForStatus(menuItem.recipeLines || menuItem.recipe || []);
  if (directRecipeLines.length > 0) return directRecipeLines;

  const linkedStockItem = menuItem.recipeSourceStockItem || menuItem.recipe_source_stock_item || null;
  return normalizeRecipeLinesForStatus(
    menuItem.recipeSourceRecipeLines ||
    menuItem.recipe_source_recipe_lines ||
    linkedStockItem?.recipeLines ||
    linkedStockItem?.recipe ||
    []
  );
}
