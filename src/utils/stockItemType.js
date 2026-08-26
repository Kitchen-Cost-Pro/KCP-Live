/**
 * Canonical stock-item type derivation, shared by every frontend surface.
 *
 * This logic previously existed as four separate near-identical copies (stockService,
 * StockItems, main, stockCountEligibility). Each copy tested the explicit `itemType` and the
 * category TEXT with equal priority via an `OR`, which meant a stale category string kept
 * re-deriving the old type on every save: switching an item from Non Stock back to a normal stock
 * item silently failed, because the category still read "… - Non Stock" and that text won.
 *
 * The worker's `deriveStockItemType` (cloudflare-v2/src/legacy/routes.ts) was fixed to treat an
 * explicit type as authoritative; the frontend copies were not, and since the frontend computes
 * `itemType` before sending, the frontend's answer is the one that reaches the database. Hence one
 * shared implementation here, matching the worker's precedence exactly.
 *
 * Category-text inference is a fallback for legacy rows saved before `itemType` existed. It must
 * never override an explicit choice.
 */

const SUB_RECIPE_TOKENS = ['sub_recipe', 'subrecipe'];
const MANUFACTURED_TOKENS = ['manufactured', 'prep', 'prepared', 'manufactured_item', 'manufacturing', 'finished_good', 'finished_goods'];
const VIRTUAL_TOKENS = ['virtual', 'menu_item', 'menu'];
const NON_STOCK_TOKENS = ['recipe_source', 'recipesource', 'non_stock', 'nonstock'];
const STANDARD_TOKENS = ['standard', 'stock', 'stock_item', 'ingredient', 'raw', 'raw_material'];

function token(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function truthy(value) {
  if (value === true) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function explicitTokens(item) {
  return [
    item.itemType,
    item.stockItemType,
    item.specificationType,
    item.item_type,
    item.productType,
    item.type,
    item.kind
  ].map(token).filter(Boolean);
}

/**
 * Derive the fine-grained item type. Returns one of:
 * 'sub_recipe' | 'manufactured' | 'virtual' | 'recipe_source' | 'standard'
 *
 * 'virtual' is kept DISTINCT from 'recipe_source' here because stock-count eligibility depends on
 * the difference (a virtual item is not countable, a Non Stock item is). Callers that treat them
 * alike should collapse them themselves rather than have this function lose the distinction.
 */
export function deriveStockItemType(item = {}) {
  const explicit = explicitTokens(item);
  const has = (tokens) => explicit.some((value) => tokens.includes(value));

  // Boolean flags are an explicit statement of type too, so they rank with `itemType` rather than
  // with category text.
  if (truthy(item.isSubRecipe ?? item.is_sub_recipe ?? item.SubRecipe)) return 'sub_recipe';
  if (has(SUB_RECIPE_TOKENS)) return 'sub_recipe';
  if (truthy(item.isManufactured ?? item.is_manufactured ?? item.Manufactured ?? item.manufactured ?? item.MFG)) return 'manufactured';
  if (has(MANUFACTURED_TOKENS)) return 'manufactured';
  if (has(VIRTUAL_TOKENS)) return 'virtual';
  if (has(NON_STOCK_TOKENS)) return 'recipe_source';
  if (has(STANDARD_TOKENS)) return 'standard';
  // An explicit value we do not recognise is still an explicit value — treat it as a plain stock
  // item rather than falling through to category guessing.
  if (explicit.length) return 'standard';

  const category = String(item.category ?? item.inventoryCategory ?? item.stockCategory ?? '').toLowerCase();
  if (!category) return 'standard';
  if (category.includes('sub recipe') || category.includes('sub-recipe')) return 'sub_recipe';
  if (category.includes('manufactured') || category.includes('manufacturing')) return 'manufactured';
  if (category.includes('virtual')) return 'virtual';
  if (category.includes('recipe source') || category.includes('non-stock') || category.includes('non stock')) return 'recipe_source';
  return 'standard';
}

/**
 * Type-marker suffixes that the app appends to a category for display/grouping. These are derived
 * from the item type, so they must be stripped before a new one is appended — otherwise converting
 * Non Stock -> stock produced "General - Non Stock - Raw Materials", and the stale "Non Stock"
 * text then kept re-deriving the old type forever.
 */
const CATEGORY_TYPE_SUFFIXES = [
  'raw materials',
  'manufactured',
  'manufacturing',
  'non stock',
  'non-stock',
  'nonstock',
  'recipe source',
  'sub recipe',
  'sub-recipe',
  'virtual'
];

/** Strip every trailing type-marker segment from a category, leaving the user's own base category. */
export function stripStockCategoryTypeSuffix(value = '') {
  let category = String(value ?? '').trim();
  // Loop because categories can carry more than one accumulated marker.
  for (let pass = 0; pass < CATEGORY_TYPE_SUFFIXES.length; pass += 1) {
    const parts = category.split(/\s+-\s+/);
    if (parts.length < 2) break;
    const last = parts.at(-1).trim().toLowerCase();
    if (!CATEGORY_TYPE_SUFFIXES.includes(last)) break;
    category = parts.slice(0, -1).join(' - ').trim();
  }
  return category;
}
