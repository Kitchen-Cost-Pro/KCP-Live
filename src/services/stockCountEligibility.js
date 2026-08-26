function normalizeToken(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseBooleanFlag(value, fallback = false) {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return fallback;
}

function isArchivedOrDeleted(item = {}) {
  return parseBooleanFlag(item.deleted ?? item.isDeleted ?? item.archived ?? item.isArchived ?? item.inactive ?? item.isInactive, false);
}

function hasCategoryToken(item = {}, tokens = []) {
  const category = normalizeToken(item.category || item.inventoryCategory || item.stockCategory || '');
  return tokens.some((token) => category.includes(token));
}

export function normalizeStockItemType(item = {}) {
  const explicitValues = [
    item.itemType,
    item.stockItemType,
    item.specificationType,
    item.item_type,
    item.productType,
    item.type,
    item.kind
  ].map(normalizeToken).filter(Boolean);

  if (parseBooleanFlag(item.isSubRecipe ?? item.is_sub_recipe ?? item.SubRecipe, false)) return 'sub_recipe';
  if (explicitValues.some((value) => ['sub_recipe', 'subrecipe', 'sub_recipes'].includes(value))) return 'sub_recipe';
  if (explicitValues.some((value) => value.includes('sub_recipe') || value.includes('subrecipe'))) return 'sub_recipe';
  if (hasCategoryToken(item, ['sub_recipe', 'subrecipe'])) return 'sub_recipe';

  if (explicitValues.some((value) => ['virtual', 'menu_item', 'menu'].includes(value))) return 'virtual';
  if (hasCategoryToken(item, ['virtual'])) return 'virtual';

  if (explicitValues.some((value) => ['non_stock', 'nonstock', 'recipe_source', 'recipesource'].includes(value))) return 'non_stock';
  if (hasCategoryToken(item, ['non_stock', 'nonstock', 'recipe_source', 'recipesource'])) return 'non_stock';

  if (parseBooleanFlag(item.isManufactured ?? item.is_manufactured ?? item.manufactured ?? item.Manufacturing, false)) return 'manufactured';
  if (explicitValues.some((value) => ['manufactured', 'manufacturing', 'prep', 'prepared', 'finished_good', 'finished_goods'].includes(value))) return 'manufactured';
  if (hasCategoryToken(item, ['manufacturing', 'manufactured'])) return 'manufactured';

  if (explicitValues.some((value) => ['standard', 'stock', 'stock_item', 'ingredient', 'raw', 'raw_material'].includes(value))) return 'standard';
  if (explicitValues.length) return explicitValues[0];

  return 'standard';
}

export function isStockCountableItem(item = {}) {
  if (!item || typeof item !== 'object' || isArchivedOrDeleted(item)) return false;
  const type = normalizeStockItemType(item);
  if (['sub_recipe', 'virtual'].includes(type)) return false;
  return ['standard', 'manufactured', 'non_stock'].includes(type) || !type;
}

export function isTransferEligibleStockItem(item = {}) {
  if (!item || typeof item !== 'object' || isArchivedOrDeleted(item)) return false;
  const type = normalizeStockItemType(item);
  return ['standard', 'manufactured', 'non_stock'].includes(type);
}

export function isStockRoutingEligibleItem(item = {}) {
  if (!item || typeof item !== 'object' || isArchivedOrDeleted(item)) return false;
  const type = normalizeStockItemType(item);
  return ['standard', 'manufactured'].includes(type);
}
