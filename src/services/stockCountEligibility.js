function normalizedType(item = {}) {
  return String(item.itemType || item.stockItemType || item.specificationType || item.item_type || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function parseBooleanFlag(value, fallback = false) {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return fallback;
}

export function isStockCountableItem(item = {}) {
  const type = normalizedType(item);
  if (['sub_recipe', 'subrecipe', 'virtual'].includes(type)) return false;
  if (['non_stock', 'recipe_source'].includes(type)) return true;
  if (parseBooleanFlag(item.isSubRecipe ?? item.is_sub_recipe ?? item.SubRecipe, false)) return false;

  const category = String(item.category || '').toLowerCase();
  if (category.includes('virtual') || category.includes('sub recipe') || category.includes('sub-recipe')) return false;
  if (category.includes('non-stock') || category.includes('non stock') || category.includes('recipe source')) return true;

  return true;
}
