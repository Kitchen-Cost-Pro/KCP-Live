import type { Env, DbLike, DbStatementLike } from './types';
import { fallbackStockItemUnitCost } from './inventory-costing';
// @ts-ignore Shared Yoco Money converter: Money objects are minor units; normalized scalars remain major units.
import { yocoMoneyToMajor } from '../../../src/modules/reporting/engine/yocoFinancials.js';

type Row = Record<string, unknown>;

interface LocationRow extends Row {
  id: string;
  name: string;
  display_name?: string;
  external_name?: string;
  kind?: string;
  is_default?: number;
  external_provider?: string;
  external_location_id?: string;
  stock_routing_json?: string;
}

interface ProductRow extends Row {
  id: string;
  name: string;
  category?: string;
  price?: number;
  yoco_item_id?: string;
  yoco_variant_id?: string;
  yoco_category_id?: string;
  recipe_source_stock_item_id?: string;
  raw_json?: string;
}

interface YocoModifierGroupRow extends Row {
  id: string;
  yoco_modifier_group_id: string;
  name: string;
  raw_json?: string;
}

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

interface StockBalanceRow extends Row {
  stock_item_id: string;
  location_id: string;
  quantity?: number;
}

interface StockItemLocationPriceRow extends Row {
  stock_item_id: string;
  location_id: string;
  price?: number;
}

interface RecipeRow extends Row {
  id: string;
  owner_type: string;
  owner_id: string;
  yield_qty?: number;
  linked_product_id?: string | null;
}

interface RecipeLineRow extends Row {
  id: string;
  recipe_id: string;
  stock_item_id: string;
  quantity?: number;
  unit?: string;
}

interface DepletionLine {
  stockItem: StockItemRow;
  quantity: number;
  recipeLine: RecipeLineRow;
}

interface ModifierCatalogEntry {
  id: string;
  type: string;
  variantId: string;
  groupId: string;
  groupName: string;
  name: string;
  raw: Row;
}

interface SaleComponent {
  sourceLine: Row;
  lineId: string;
  product: ProductRow | null;
  productName: string;
  quantityMultiplier: number;
  total: number;
  componentType: 'product' | 'modifier';
  modifier?: Row;
  modifierCatalog?: ModifierCatalogEntry | null;
  parentLineId?: string;
  parentProduct?: ProductRow | null;
}

export interface YocoProcessResult {
  processed: boolean;
  reason?: string;
  retryable?: boolean;
  missingRecipes: number;
  orderLines: number;
  stockMovements: number;
  skippedDuplicates?: number;
}

// How stock should behave when a Yoco refund reason is present.
// 'return'  → restore stock to inventory (default)
// 'wastage' -> do NOT restore stock; record as wastage movement for dashboards
// 'skip'    → no stock change and no movement record
export type RefundReturnBehavior = 'return' | 'wastage' | 'skip';

export function resolveRefundReturnBehavior(returnEntry: Row): RefundReturnBehavior {
  const reason = text(
    returnEntry.reason ||
    returnEntry.refund_reason ||
    returnEntry.refundReason ||
    returnEntry.return_reason ||
    returnEntry.returnReason
  ).toLowerCase();

  // Yoco sends reason as structured key OR as human-readable display text in the note field
  const note = text(
    returnEntry.other_reason ||
    returnEntry.otherReason ||
    returnEntry.note ||
    returnEntry.reason_note ||
    returnEntry.reasonNote ||
    returnEntry.description
  ).toLowerCase();

  if (reason === 'damaged_or_defective' || reason === 'damaged or defective') return 'wastage';
  // Yoco puts "Damaged or defective" as a display string in the note field
  if (/damaged.*defective|defective.*damaged/i.test(note)) return 'wastage';

  if (reason === 'other' || reason === '') {
    if (/wastage|waste|scrap|discard/.test(note)) return 'wastage';
  }

  // accidental_charge, customer_changed_mind, incorrect_amount, service_not_delivered
  // and "other" with non-waste notes all restore stock
  return 'return';
}

export interface YocoReturnsResult {
  returnsProcessed: number;
  totalMovements: number;
  results: YocoProcessResult[];
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function normalizeText(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function jsonParse(value: unknown, fallback: Row = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Row;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : fallback;
  } catch {
    return fallback;
  }
}

function jsonString(value: unknown) {
  return JSON.stringify(value || {});
}

// Unified stock valuation unit cost — mirrors the frontend getStockValuationUnitCost.
// The stock_items.unit_cost column is frequently 0 for items priced only via their
// last purchase; the real cost lives in raw_json. Using this everywhere a movement's
// value_delta is written (wastage, manual adjustments) keeps Dashboard values
// non-zero for last-purchase-priced items.
export function stockValuationUnitCost(item: Partial<StockItemRow> | undefined | null) {
  return fallbackStockItemUnitCost((item || undefined) as Row | undefined, 0);
}

function moneyToMajor(value: unknown) {
  const amount = yocoMoneyToMajor(value, { scalarUnit: 'major', absolute: false });
  return Number.isFinite(amount) ? amount : 0;
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

interface StockDepletionPolicy {
  enabled: boolean;
  enabledAt: string;
}

function parseBoolean(value: unknown) {
  return value === true || text(value).toLowerCase() === 'true' || numberValue(value, 0) === 1;
}

async function getStockDepletionPolicy(env: Env, workspaceId: string): Promise<StockDepletionPolicy> {
  const row = await env.DB.prepare(
    `SELECT raw_json
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`
  ).bind(workspaceId).first<{ raw_json?: string | null }>();
  const settings = objectValue(jsonParse(row?.raw_json));
  const enabled = parseBoolean(settings.stockDepletionEnabled ?? settings.stock_depletion_enabled);
  const enabledAtRaw = text(settings.stockDepletionEnabledAt ?? settings.stock_depletion_enabled_at);
  const enabledAt = Number.isFinite(Date.parse(enabledAtRaw)) ? new Date(enabledAtRaw).toISOString() : '';
  return { enabled, enabledAt };
}

function occurredBeforeActivation(occurredAt: string, enabledAt: string) {
  if (!enabledAt) return false;
  const occurredMs = Date.parse(occurredAt);
  const enabledMs = Date.parse(enabledAt);
  return Number.isFinite(occurredMs) && Number.isFinite(enabledMs) && occurredMs < enabledMs;
}

async function originalSaleWasDepleted(env: Env, workspaceId: string, orderId: string) {
  const row = await env.DB.prepare(
    `SELECT id
       FROM stock_movements
      WHERE workspace_id = ?1
        AND document_type = 'yoco_order'
        AND document_id = ?2
        AND movement_type = 'sale_depletion'
      LIMIT 1`
  ).bind(workspaceId, orderId).first<{ id?: string }>();
  return Boolean(row?.id);
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function hash(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getOrderLineItems(order: Row) {
  for (const key of ['line_items', 'lineItems', 'items', 'order_lines', 'orderLines']) {
    const value = order[key];
    if (Array.isArray(value)) return value as Row[];
  }
  return [];
}

function refundProportion(order: Row, refund: Row): number {
  const refundAmt = moneyToMajor(refund.total_amount || objectValue(refund.amounts).net_amount || refund.amount || refund.net_amount);
  const orderAmt = moneyToMajor(order.total_price || objectValue(order.amounts).net_amount || order.total_amount || order.net_amount);
  if (refundAmt > 0 && orderAmt > 0 && refundAmt < orderAmt * 0.9999) return refundAmt / orderAmt;
  return 1;
}

function scaleLineQty(line: Row, proportion: number): Row {
  if (proportion >= 0.9999) return line;
  const original = Math.abs(numberValue(line.quantity || line.qty || line.count, 1));
  return { ...line as Record<string, unknown>, quantity: Math.max(Math.round(original * proportion), 1) } as Row;
}

function getRefundLineItems(order: Row, refund: Row | null) {
  if (!refund) return [];
  const proportion = refundProportion(order, refund);
  for (const key of ['returned_line_items', 'returnedLineItems', 'line_items', 'lineItems', 'items', 'refund_lines', 'refundLines']) {
    const value = refund[key];
    if (Array.isArray(value) && value.length) return (value as Row[]).map((l) => scaleLineQty(l, proportion));
  }
  return getOrderLineItems(order).map((l) => scaleLineQty(l, proportion));
}

function lineId(line: Row, index: number) {
  return text(line.id || line.line_item_id || line.lineItemId || line.uuid || `line_${index}`);
}

function lineName(line: Row) {
  return text(line.name || line.product_name || line.productName || line.item_name || line.itemName, 'Yoco Item');
}

function lineQuantity(line: Row) {
  return Math.abs(numberValue(line.quantity || line.qty || line.count, 1));
}

function lineItemId(line: Row) {
  return text(line.item_id || line.itemId || line.product_id || line.productId);
}

function lineVariantId(line: Row) {
  const item = objectValue(line.item);
  const product = objectValue(line.product);
  const variant = objectValue(line.variant);
  const productVariant = objectValue(line.product_variant || line.productVariant);
  return text(
    line.variant_id ||
    line.variantId ||
    line.item_variant_id ||
    line.itemVariantId ||
    line.variation_id ||
    line.product_variant_id ||
    line.productVariantId ||
    productVariant.id ||
    productVariant.variant_id ||
    productVariant.variantId ||
    variant.id ||
    variant.variant_id ||
    variant.variantId ||
    product.variant_id ||
    product.variantId ||
    item.variant_id ||
    item.variantId
  );
}

function modifierId(modifier: Row) {
  return text(modifier.modifier_id || modifier.modifierId || modifier.id || modifier.uuid);
}

function modifierVariantId(modifier: Row) {
  const product = objectValue(modifier.product);
  const item = objectValue(modifier.item);
  const variant = objectValue(modifier.variant);
  const productVariant = objectValue(modifier.product_variant || modifier.productVariant);
  return text(
    modifier.variant_id ||
    modifier.variantId ||
    modifier.item_variant_id ||
    modifier.itemVariantId ||
    modifier.variation_id ||
    modifier.product_variant_id ||
    modifier.productVariantId ||
    modifier.product_id ||
    modifier.productId ||
    modifier.item_id ||
    modifier.itemId ||
    productVariant.id ||
    productVariant.variant_id ||
    productVariant.variantId ||
    variant.id ||
    variant.variant_id ||
    variant.variantId ||
    product.variant_id ||
    product.variantId ||
    product.id ||
    item.variant_id ||
    item.variantId ||
    item.id
  );
}

function modifierName(modifier: Row, fallback = 'Yoco Modifier') {
  const product = objectValue(modifier.product);
  const item = objectValue(modifier.item);
  const variant = objectValue(modifier.variant);
  const productVariant = objectValue(modifier.product_variant || modifier.productVariant);
  return text(
    modifier.name ||
    modifier.display_name ||
    modifier.displayName ||
    modifier.product_name ||
    modifier.productName ||
    product.name ||
    product.display_name ||
    product.displayName ||
    item.name ||
    item.display_name ||
    item.displayName ||
    productVariant.name ||
    productVariant.display_name ||
    productVariant.displayName ||
    variant.name ||
    variant.display_name ||
    variant.displayName,
    fallback
  );
}

function modifierQuantity(modifier: Row) {
  const quantity = numberValue(modifier.quantity || modifier.qty || modifier.count, 1);
  return quantity > 0 ? Math.abs(quantity) : 1;
}

function modifierTotal(modifier: Row) {
  return moneyToMajor(modifier.total_price || modifier.net_amount || modifier.amount || modifier.price || 0);
}

function modifierGroupId(modifier: Row) {
  const group = objectValue(modifier.group || modifier.modifier_group || modifier.modifierGroup);
  return text(
    modifier.group_id ||
    modifier.groupId ||
    modifier.modifier_group_id ||
    modifier.modifierGroupId ||
    group.id ||
    group.modifier_group_id ||
    group.modifierGroupId
  );
}

function modifierGroupName(modifier: Row) {
  const group = objectValue(modifier.group || modifier.modifier_group || modifier.modifierGroup);
  return text(
    modifier.group_name ||
    modifier.groupName ||
    modifier.modifier_group_name ||
    modifier.modifierGroupName ||
    group.name ||
    group.display_name ||
    group.displayName
  );
}

function modifierType(modifier: Row) {
  return normalizeText(modifier.type || modifier.kind || modifier.modifier_type || modifier.modifierType);
}

function normalizeLineModifier(value: unknown, group: Row = {}) {
  const row = objectValue(value);
  const nested = objectValue(row.modifier || row.modifier_item || row.modifierItem || row.selected_modifier || row.selectedModifier);
  const modifier = Object.keys(nested).length ? { ...nested, ...row } : row;
  const groupId = text(modifierGroupId(modifier) || group.id || group.modifier_group_id || group.modifierGroupId);
  const groupName = text(modifierGroupName(modifier) || group.name || group.display_name || group.displayName);
  return {
    ...modifier,
    ...(groupId ? { group_id: groupId, groupId } : {}),
    ...(groupName ? { group_name: groupName, groupName } : {})
  };
}

function getLineModifiers(line: Row) {
  const modifiers: Row[] = [];
  for (const key of [
    'modifiers',
    'selected_modifiers',
    'selectedModifiers',
    'line_modifiers',
    'lineModifiers',
    'modifier_lines',
    'modifierLines',
    'applied_modifiers',
    'appliedModifiers',
    'modifier_selections',
    'modifierSelections'
  ]) {
    const value = line[key];
    if (Array.isArray(value)) modifiers.push(...value.map((entry) => normalizeLineModifier(entry)));
  }
  for (const key of [
    'modifier_groups',
    'modifierGroups',
    'selected_modifier_groups',
    'selectedModifierGroups',
    'applied_modifier_groups',
    'appliedModifierGroups'
  ]) {
    const groups = line[key];
    if (!Array.isArray(groups)) continue;
    for (const groupValue of groups) {
      const group = objectValue(groupValue);
      modifierGroupModifiers(group).forEach((modifier) => {
        modifiers.push(normalizeLineModifier(modifier, group));
      });
    }
  }
  const seen = new Set<string>();
  return modifiers.filter((modifier, index) => {
    const key = [
      modifierId(modifier),
      modifierVariantId(modifier),
      modifierGroupId(modifier),
      normalizeText(modifierName(modifier, `modifier_${index}`))
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function modifierGroupModifiers(group: Row) {
  for (const key of ['modifiers', 'modifier_items', 'modifierItems', 'modifier_options', 'modifierOptions', 'options', 'items', 'values']) {
    const value = group[key];
    if (Array.isArray(value)) return value as Row[];
  }
  return [];
}

function orderLocationId(order: Row, line: Row) {
  return text(line.location_id || line.locationId || order.location_id || order.locationId);
}

function getPaymentId(order: Row, refund: Row | null) {
  if (refund) return text(refund.id || refund.payment_id || refund.paymentId);
  const payments = order.payments;
  if (Array.isArray(payments) && payments[0]) {
    const approved = payments.find((payment) => normalizeText((payment as Row).status) === 'approved') || payments[0];
    return text((approved as Row).id || (approved as Row).payment_id);
  }
  return text(order.payment_id || order.paymentId);
}

function getPaymentMethod(order: Row, refund: Row | null) {
  if (refund) return text(refund.payment_method || refund.paymentMethod, 'refund');
  const payments = order.payments;
  if (Array.isArray(payments) && payments[0]) {
    const approved = payments.find((payment) => normalizeText((payment as Row).status) === 'approved') || payments[0];
    return text((approved as Row).payment_method || (approved as Row).paymentMethod || (approved as Row).type, 'card');
  }
  return text(order.payment_method || order.paymentMethod, 'card');
}

function stockCategoryBase(category: string) {
  return text(category || 'General')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Sub Recipe$/i, '')
    .replace(/\s*\(([^)]+)\)\s*-\s*Manufactured$/i, '$1')
    .trim() || 'General';
}

function normalizeRoutingMap(value: unknown) {
  const raw = typeof value === 'string' ? jsonParse(value) : objectValue(value);
  return Object.entries(raw).reduce((map, [key, target]) => {
    const normalized = normalizeText(key);
    const routeTarget = text(target);
    if (normalized && routeTarget) map[normalized] = routeTarget;
    return map;
  }, {} as Record<string, string>);
}

function locationDisplayName(location: LocationRow | null) {
  if (!location) return '';
  return text(location.display_name || location.name || location.external_name);
}

function findLocation(locations: LocationRow[], target: string) {
  const wanted = text(target);
  const normalized = normalizeText(wanted);
  if (!wanted || normalized === 'self') return null;
  if (['main', 'main store', 'default', 'default location', 'storage'].includes(normalized)) {
    return locations.find((location) => location.is_default === 1) || null;
  }
  return locations.find((location) => [
    location.id,
    location.name,
    location.display_name,
    location.external_name,
    location.external_location_id
  ].some((value) => text(value) === wanted || normalizeText(value) === normalized)) || null;
}

function categoryRoutingTarget(routing: Record<string, string>, category: string) {
  const base = stockCategoryBase(category);
  const candidates = [
    category,
    base,
    `${base} - Raw Materials`,
    `${base} - Manufactured`,
    `${base} - Sub Recipe`
  ].map(normalizeText).filter(Boolean);
  for (const key of [...new Set(candidates)]) {
    const target = routing[key];
    if (target) return target;
  }
  return '';
}

function resolveSourceLocation(
  sellingLocation: LocationRow,
  stockItem: StockItemRow,
  locations: LocationRow[]
) {
  const category = text(stockItem.category, 'General');
  const routing = normalizeRoutingMap(sellingLocation.stock_routing_json || '{}');
  const target = categoryRoutingTarget(routing, category);
  if (!target || normalizeText(target) === 'self') return sellingLocation;
  const routed = normalizeText(target) === 'self' ? null : findLocation(locations, target);
  return routed || sellingLocation;
}

function findSellingLocation(locations: LocationRow[], order: Row, line: Row, fallbackLocation: LocationRow | null = null) {
  const yocoId = orderLocationId(order, line);
  const normalized = normalizeText(yocoId);
  if (!yocoId && fallbackLocation) return fallbackLocation;
  const match = locations.find((location) => [
    location.id,
    location.external_location_id,
    location.external_name,
    location.name,
    location.display_name
  ].some((value) => text(value) === yocoId || normalizeText(value) === normalized));
  return match || fallbackLocation || locations.find((location) => location.is_default === 1) || locations[0] || null;
}

function findProduct(products: ProductRow[], line: Row) {
  const itemId = lineItemId(line);
  const variantId = lineVariantId(line);
  const name = normalizeText(lineName(line));
  if (variantId) {
    const variantMatch = products.find((product) => productVariantAliases(product).includes(variantId));
    if (variantMatch) return variantMatch;
  }
  if (itemId) {
    const itemMatches = products.filter((product) => text(product.yoco_item_id) === itemId);
    if (itemMatches.length === 1) return itemMatches[0];
    const namedItemMatch = itemMatches.find((product) => name && normalizeText(product.name) === name);
    if (namedItemMatch) return namedItemMatch;
    const fuzzyItemMatch = itemMatches.find((product) => {
      const productName = normalizeText(product.name);
      return name && productName && (name.startsWith(productName) || productName.startsWith(name));
    });
    if (fuzzyItemMatch) return fuzzyItemMatch;
  }
  return products.find((product) => name && normalizeText(product.name) === name) || null;
}

function findProductByVariantId(products: ProductRow[], variantId: string) {
  const wanted = text(variantId);
  if (!wanted) return null;
  return products.find((product) => productVariantAliases(product).includes(wanted)) ||
    wanted.split(':').map((part) => text(part)).filter(Boolean)
      .map((part) => products.find((product) => productVariantAliases(product).includes(part)))
      .find(Boolean) ||
    null;
}

function productVariantAliases(product: ProductRow) {
  const raw = jsonParse(product.raw_json);
  const item = objectValue(raw.item);
  const variant = objectValue(raw.variant);
  const itemId = text(product.yoco_item_id || item.id || item.item_id || item.itemId);
  const variantId = text(product.yoco_variant_id || variant.id || variant.variant_id || variant.variantId);
  const aliases = [
    variantId,
    text(variant.variant_id || variant.variantId),
    itemId && variantId ? `${itemId}:${variantId}` : '',
    itemId && text(variant.variant_id || variant.variantId) ? `${itemId}:${text(variant.variant_id || variant.variantId)}` : ''
  ].filter(Boolean);
  return [...new Set(aliases)];
}

function buildModifierCatalogue(groups: YocoModifierGroupRow[]) {
  const catalogue = new Map<string, ModifierCatalogEntry>();
  const setIfEmpty = (key: string, entry: ModifierCatalogEntry) => {
    if (key && !catalogue.has(key)) catalogue.set(key, entry);
  };
  for (const group of groups) {
    const raw = jsonParse(group.raw_json);
    const modifiers = modifierGroupModifiers(raw);
    for (const modifier of modifiers) {
      const id = modifierId(modifier);
      const variantId = modifierVariantId(modifier);
      const name = modifierName(modifier, id || variantId || 'Yoco Modifier');
      if (!id && !variantId && !name) continue;
      const catalogueId = id || (variantId ? `variant:${variantId}` : `name:${normalizeText(name)}`);
      const entry = {
        id: catalogueId,
        type: modifierType(modifier),
        variantId,
        groupId: text(raw.id || group.yoco_modifier_group_id || group.id),
        groupName: text(raw.name || group.name),
        name,
        raw: modifier
      };
      setIfEmpty(catalogueId, entry);
      setIfEmpty(id, entry);
      setIfEmpty(variantId ? `variant:${variantId}` : '', entry);
      setIfEmpty(normalizeText(name) ? `name:${normalizeText(name)}` : '', entry);
      setIfEmpty(entry.groupId && normalizeText(name) ? `group:${entry.groupId}:name:${normalizeText(name)}` : '', entry);
      setIfEmpty(normalizeText(entry.groupName) && normalizeText(name) ? `group-name:${normalizeText(entry.groupName)}:name:${normalizeText(name)}` : '', entry);
    }
  }
  return catalogue;
}

function productModifierGroupIds(product: ProductRow | null) {
  if (!product) return [];
  const raw = jsonParse(product.raw_json);
  const ids = raw.yocoModifierGroupIds || raw.modifierGroupIds || raw.modifier_groups || raw.modifierGroups;
  return Array.isArray(ids)
    ? ids.map((entry) => text(entry)).filter(Boolean)
    : [];
}

function findModifierCatalogEntry(
  modifierCatalogue: Map<string, ModifierCatalogEntry>,
  modifier: Row,
  parentProduct: ProductRow | null
) {
  const idValue = modifierId(modifier);
  const variantId = modifierVariantId(modifier);
  const groupId = modifierGroupId(modifier);
  const groupName = modifierGroupName(modifier);
  const name = normalizeText(modifierName(modifier, ''));
  const keys = [
    idValue,
    variantId ? `variant:${variantId}` : '',
    groupId && name ? `group:${groupId}:name:${name}` : '',
    groupName && name ? `group-name:${normalizeText(groupName)}:name:${name}` : '',
    ...productModifierGroupIds(parentProduct).map((parentGroupId) => name ? `group:${parentGroupId}:name:${name}` : ''),
    name ? `name:${name}` : ''
  ].filter(Boolean);
  for (const key of keys) {
    const match = modifierCatalogue.get(key);
    if (match) return match;
  }
  return null;
}

function findModifierCatalogEntryForProduct(
  modifierCatalogue: Map<string, ModifierCatalogEntry>,
  product: ProductRow | null
) {
  if (!product) return null;
  const aliases = productVariantAliases(product);
  for (const alias of aliases) {
    const match = modifierCatalogue.get(`variant:${alias}`);
    if (match) return match;
  }
  const nameMatch = modifierCatalogue.get(`name:${normalizeText(product.name)}`);
  return nameMatch || null;
}

function lineUnitTotal(line: Row) {
  const quantity = Math.max(lineQuantity(line), 1);
  const unitPrice = moneyToMajor(line.unit_price || line.unitPrice || 0);
  if (unitPrice > 0) return unitPrice;
  return moneyToMajor(line.total_price || line.net_amount || line.amount) / quantity;
}

function moneyMatches(left: unknown, right: unknown) {
  return Math.abs(numberValue(left, 0) - numberValue(right, 0)) < 0.01;
}

function findParentProductForModifierSelection(
  line: Row,
  selectedProduct: ProductRow | null,
  selectedCatalog: ModifierCatalogEntry | null,
  products: ProductRow[]
) {
  const groupId = text(selectedCatalog?.groupId);
  if (!selectedProduct || !groupId) return null;
  const linePrice = lineUnitTotal(line);
  const selectedPrice = numberValue(selectedProduct.price, 0);
  const candidates = products.filter((product) => (
    text(product.id) !== text(selectedProduct.id) &&
    productModifierGroupIds(product).includes(groupId)
  ));
  if (!candidates.length) return null;

  const priceMatchedParent = candidates.find((product) => moneyMatches(product.price, linePrice));
  if (priceMatchedParent && !moneyMatches(selectedPrice, linePrice)) return priceMatchedParent;

  return null;
}

function productModifierVariantId(modifier: Row, catalog: ModifierCatalogEntry | null) {
  return modifierVariantId(modifier) || text(catalog?.variantId);
}

function modifierRecipeOwnerIds(modifier: Row, catalog: ModifierCatalogEntry | null) {
  const groupId = text(catalog?.groupId || modifierGroupId(modifier));
  const catalogId = text(catalog?.id);
  const idValue = modifierId(modifier) || (catalogId.startsWith('variant:') ? '' : catalogId);
  const variantId = productModifierVariantId(modifier, catalog);
  const ownerIds = [
    groupId && idValue ? `${groupId}:${idValue}` : '',
    idValue,
    variantId ? `variant:${variantId}` : '',
    normalizeText(modifierName(modifier, text(catalog?.name, 'Yoco Modifier'))).replace(/\s+/g, '_')
  ].filter(Boolean);
  return [...new Set(ownerIds)];
}

function isProductModifier(modifier: Row, catalog: ModifierCatalogEntry | null) {
  const variantId = productModifierVariantId(modifier, catalog);
  const type = modifierType(modifier);
  if (catalog?.type.includes('product')) return true;
  if (type.includes('product')) return true;
  if (!variantId) return false;
  if (!catalog) return true;
  return !catalog.type || catalog.type.includes('product');
}

function modifierLineId(parentLineId: string, modifier: Row, index: number) {
  return `${parentLineId}:modifier:${modifierId(modifier) || modifierVariantId(modifier) || index}`;
}

function metadataFieldFragment(key: string, value: string) {
  return `"${key}":${JSON.stringify(value)}`;
}

async function componentMovementExists(
  env: Env,
  workspaceId: string,
  orderId: string,
  mode: 'sale' | 'refund',
  component: SaleComponent,
  effectiveProduct: ProductRow | null
) {
  const componentType = component.componentType;
  const productId = text(effectiveProduct?.id);
  const productName = text(effectiveProduct?.name || component.productName);
  const currentModifierId = component.modifier ? modifierId(component.modifier) : '';
  const currentModifierVariantId = component.modifier ? productModifierVariantId(component.modifier, component.modifierCatalog || null) : '';
  const checks = [
    mode ? metadataFieldFragment('mode', mode) : '',
    componentType ? metadataFieldFragment('componentType', componentType) : '',
    componentType === 'modifier' && component.parentLineId ? metadataFieldFragment('parentLineId', component.parentLineId) : '',
    componentType === 'modifier' && currentModifierId ? metadataFieldFragment('modifierId', currentModifierId) : '',
    componentType === 'modifier' && currentModifierVariantId ? metadataFieldFragment('modifierVariantId', currentModifierVariantId) : '',
    productId ? metadataFieldFragment('productId', productId) : '',
    !productId && productName ? metadataFieldFragment('productName', productName) : ''
  ].filter(Boolean);
  const filters = checks.map((_, index) => `instr(metadata_json, ?${index + 3}) > 0`).join(' AND ');
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM stock_movements
      WHERE workspace_id = ?1
        AND document_type = 'yoco_order'
        AND document_id = ?2
        AND movement_type IN ('sale_depletion', 'sale_refund')
        ${filters ? `AND ${filters}` : ''}`
  ).bind(workspaceId, orderId, ...checks).first<{ count: number }>();
  return numberValue(row?.count, 0) > 0;
}

function buildSaleComponents(
  line: Row,
  index: number,
  products: ProductRow[],
  modifierCatalogue: Map<string, ModifierCatalogEntry>
) {
  const baseLineId = lineId(line, index);
  const explicitModifiers = getLineModifiers(line);
  const lineProduct = findProduct(products, line);
  const implicitModifierCatalog = findModifierCatalogEntryForProduct(modifierCatalogue, lineProduct);
  const implicitParentProduct = explicitModifiers.length
    ? null
    : findParentProductForModifierSelection(line, lineProduct, implicitModifierCatalog, products);
  const parentProduct = implicitParentProduct || lineProduct;
  const components: SaleComponent[] = [{
    sourceLine: line,
    lineId: baseLineId,
    product: parentProduct,
    productName: text(parentProduct?.name, lineName(line)),
    quantityMultiplier: 1,
    total: moneyToMajor(line.total_price || line.net_amount || line.amount),
    componentType: 'product'
  }];

  if (implicitParentProduct && lineProduct && implicitModifierCatalog) {
    components.push({
      sourceLine: line,
      lineId: modifierLineId(baseLineId, implicitModifierCatalog.raw, 0),
      product: lineProduct,
      productName: text(lineProduct.name, implicitModifierCatalog.name),
      quantityMultiplier: 1,
      total: moneyToMajor(line.total_price || line.net_amount || line.amount),
      componentType: 'modifier',
      modifier: implicitModifierCatalog.raw,
      modifierCatalog: implicitModifierCatalog,
      parentLineId: baseLineId,
      parentProduct: implicitParentProduct
    });
  }

  explicitModifiers.forEach((modifier, modifierIndex) => {
    const catalog = findModifierCatalogEntry(modifierCatalogue, modifier, parentProduct);
    if (!isProductModifier(modifier, catalog)) return;
    const product = findProductByVariantId(products, productModifierVariantId(modifier, catalog));
    components.push({
      sourceLine: line,
      lineId: modifierLineId(baseLineId, modifier, modifierIndex),
      product,
      productName: text(product?.name, modifierName(modifier, text(catalog?.name, 'Yoco Product Modifier'))),
      quantityMultiplier: modifierQuantity(modifier),
      total: modifierTotal(modifier),
      componentType: 'modifier',
      modifier,
      modifierCatalog: catalog,
      parentLineId: baseLineId,
      parentProduct
    });
  });

  return components;
}

function stockItemType(item: StockItemRow) {
  const rawJson = objectValue(jsonParse(item.raw_json));
  const isSub = item.is_sub_recipe === 1 || item.is_sub_recipe === 'true' || item.is_sub_recipe === true ||
                rawJson.isSubRecipe === 1 || rawJson.isSubRecipe === 'true' || rawJson.isSubRecipe === true ||
                rawJson.SubRecipe === 1 || rawJson.SubRecipe === 'true' || rawJson.SubRecipe === true;
  if (isSub) return 'sub_recipe';

  const raw = normalizeText(item.item_type || rawJson.itemType || item.category);
  if (raw.includes('sub recipe') || raw.includes('subrecipe') || raw.includes('virtual')) return 'sub_recipe';
  if (raw.includes('recipe source') || raw.includes('non stock') || raw.includes('non_stock')) return 'non_stock';
  if (raw.includes('manufactured') || raw.includes('prep')) return 'manufactured';
  return 'raw';
}

function recipeFor(ownerType: string, ownerId: string, recipes: RecipeRow[]) {
  return recipes.find((recipe) => text(recipe.owner_type) === ownerType && text(recipe.owner_id) === ownerId) || null;
}

function linkedProductIdsFromValue(value: unknown) {
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((entry) => text(entry)).filter(Boolean);
  } catch {
    // Plain comma-separated ids are supported for older records.
  }
  return raw.split(',').map((entry) => text(entry)).filter(Boolean);
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
  seen = new Set<string>()
): DepletionLine[] {
  const expanded: DepletionLine[] = [];
  for (const line of recipeLines) {
    const stockItemId = text(line.stock_item_id);
    const stockItem = stockItemsById.get(stockItemId);
    if (!stockItem) continue;

    const quantity = numberValue(line.quantity, 0) * multiplier;
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
          nextSeen
        ));
        continue;
      }
    }

    expanded.push({ stockItem, quantity, recipeLine: line });
  }
  return expanded;
}

async function allRows<T extends Row>(statement: DbStatementLike) {
  const result = await statement.all<T>();
  return (result.results || []) as T[];
}

export interface IngredientDepletion {
  stockItemId: string;
  stockItemName: string;
  unit: string;
  unitCost: number;
  totalQty: number;
}

export async function expandProductIngredients(
  env: Env,
  workspaceId: string,
  productId: string,
  quantity: number
): Promise<IngredientDepletion[]> {
  const [stockItemsRows, recipesRows, recipeLinesRows, productRow] = await Promise.all([
    allRows<StockItemRow>(env.DB.prepare('SELECT * FROM stock_items WHERE workspace_id = ?1 AND active = 1').bind(workspaceId)),
    allRows<RecipeRow>(env.DB.prepare('SELECT * FROM recipes WHERE workspace_id = ?1 AND active = 1').bind(workspaceId)),
    allRows<RecipeLineRow>(env.DB.prepare('SELECT * FROM recipe_lines WHERE workspace_id = ?1').bind(workspaceId)),
    env.DB.prepare('SELECT recipe_source_stock_item_id FROM products WHERE workspace_id = ?1 AND id = ?2 LIMIT 1').bind(workspaceId, productId).first<{ recipe_source_stock_item_id?: string | null }>()
  ]);
  const stockItemsById = new Map(stockItemsRows.map((item) => [text(item.id), item]));

  // Try direct product recipe first, then fall back to recipe_source_stock_item_id (linked stock item recipe)
  const directRecipe = recipeFor('product', productId, recipesRows);
  const recipeSourceStockItemId = text(productRow?.recipe_source_stock_item_id);
  const linkedRecipe = !directRecipe && recipeSourceStockItemId
    ? recipeFor('stock_item', recipeSourceStockItemId, recipesRows)
    : null;
  const recipe = directRecipe || linkedRecipe;
  if (!recipe) return [];

  const baseLines = linesForRecipe(text(recipe.id), recipeLinesRows);
  const depletions = expandRecipeLines(baseLines, stockItemsById, recipesRows, recipeLinesRows);
  return depletions.map((d) => ({
    stockItemId: text(d.stockItem.id),
    stockItemName: text(d.stockItem.name),
    unit: text(d.stockItem.unit),
    // Use the unified valuation cost (raw_json last-purchase fallback) so wastage
    // value_delta isn't 0 when unit_cost column is unset.
    unitCost: stockValuationUnitCost(d.stockItem),
    totalQty: d.quantity * quantity
  }));
}

export function getOrderReturns(order: Row): Row[] {
  const returns = order.returns;
  if (!Array.isArray(returns)) return [];
  return (returns as Row[]).filter((entry) => {
    for (const key of ['returned_line_items', 'returnedLineItems', 'line_items', 'lineItems']) {
      const val = (entry as Row)[key];
      if (Array.isArray(val) && (val as unknown[]).length) return true;
    }
    return false;
  });
}

export async function processYocoOrderReturns(
  env: Env,
  workspaceId: string,
  order: Row,
  options: { eventType?: string; overrideBehavior?: RefundReturnBehavior } = {}
): Promise<YocoReturnsResult> {
  const returns = getOrderReturns(order);
  if (!returns.length) return { returnsProcessed: 0, totalMovements: 0, results: [] };
  const results: YocoProcessResult[] = [];
  let totalMovements = 0;
  for (const returnEntry of returns) {
    // Use override behavior from the payment refund object if provided (it has the reason; return entries often don't)
    const returnBehavior = options.overrideBehavior ?? resolveRefundReturnBehavior(returnEntry);
    if (returnBehavior === 'skip') {
      results.push({ processed: false, reason: 'skipped_other_reason', missingRecipes: 0, orderLines: 0, stockMovements: 0 });
      continue;
    }
    const result = await processYocoOrder(env, workspaceId, order, {
      mode: 'refund',
      refund: returnEntry,
      eventType: options.eventType || 'yoco.return',
      returnBehavior
    });
    results.push(result);
    totalMovements += result.stockMovements;
  }
  return { returnsProcessed: returns.length, totalMovements, results };
}

export function extractYocoOrder(payload: Row) {
  const data = objectValue(payload.data);
  const candidates = [
    objectValue(payload.order),
    objectValue(data.order),
    objectValue(data),
    payload
  ];
  return candidates.find((candidate) => text(candidate.id || candidate.order_id || candidate.orderId) && getOrderLineItems(candidate).length) || null;
}

export function yocoWebhookEventFields(payload: Row) {
  const data = objectValue(payload.data);
  return {
    eventType: text(payload.event_type || payload.event || payload.type),
    orderId: text(payload.order_id || payload.orderId || data.order_id || data.orderId || objectValue(data.order).id),
    paymentId: text(payload.payment_id || payload.paymentId || data.payment_id || data.paymentId)
  };
}

export async function processYocoOrder(
  env: Env,
  workspaceId: string,
  order: Row,
  options: { mode?: 'sale' | 'refund'; refund?: Row | null; eventType?: string; returnBehavior?: RefundReturnBehavior } = {}
): Promise<YocoProcessResult> {
  const mode = options.mode || 'sale';
  const returnBehavior: RefundReturnBehavior = options.returnBehavior || 'return';
  const refund = options.refund || null;
  const orderId = text(order.id || order.order_id || order.orderId || refund?.order_id || refund?.original_order_id);
  if (!orderId) throw new Error('Yoco order id is missing.');
  if (mode === 'sale' && text(order.status, 'completed').toLowerCase() !== 'completed') {
    return { processed: false, reason: 'order_not_completed', missingRecipes: 0, orderLines: 0, stockMovements: 0 };
  }

  const occurredAt = mode === 'refund'
    ? text(refund?.processed_at || refund?.created_at || refund?.updated_at || order.closed_at || order.created_at || new Date().toISOString())
    : text(order.closed_at || order.created_at || order.updated_at || new Date().toISOString());
  const depletionPolicy = await getStockDepletionPolicy(env, workspaceId);
  if (!depletionPolicy.enabled) {
    return { processed: false, reason: 'stock_depletion_disabled', missingRecipes: 0, orderLines: 0, stockMovements: 0 };
  }
  if (mode === 'sale' && occurredBeforeActivation(occurredAt, depletionPolicy.enabledAt)) {
    return { processed: false, reason: 'before_stock_depletion_start', missingRecipes: 0, orderLines: 0, stockMovements: 0 };
  }
  if (mode === 'refund' && !(await originalSaleWasDepleted(env, workspaceId, orderId))) {
    return { processed: false, reason: 'original_sale_not_depleted', missingRecipes: 0, orderLines: 0, stockMovements: 0 };
  }

  const [
    locations,
    products,
    stockItems,
    stockBalances,
    stockItemLocationPrices,
    recipes,
    recipeLines,
    modifierGroups
  ] = await Promise.all([
    allRows<LocationRow>(env.DB.prepare('SELECT * FROM locations WHERE workspace_id = ?1 AND active = 1').bind(workspaceId)),
    allRows<ProductRow>(env.DB.prepare('SELECT * FROM products WHERE workspace_id = ?1 AND active = 1').bind(workspaceId)),
    allRows<StockItemRow>(env.DB.prepare('SELECT * FROM stock_items WHERE workspace_id = ?1 AND active = 1').bind(workspaceId)),
    allRows<StockBalanceRow>(env.DB.prepare('SELECT stock_item_id, location_id, quantity FROM stock_balances WHERE workspace_id = ?1').bind(workspaceId)),
    allRows<StockItemLocationPriceRow>(env.DB.prepare('SELECT stock_item_id, location_id, price FROM stock_item_location_prices WHERE workspace_id = ?1').bind(workspaceId)).catch(() => []),
    allRows<RecipeRow>(env.DB.prepare('SELECT * FROM recipes WHERE workspace_id = ?1 AND active = 1').bind(workspaceId)),
    allRows<RecipeLineRow>(env.DB.prepare('SELECT * FROM recipe_lines WHERE workspace_id = ?1').bind(workspaceId)),
    allRows<YocoModifierGroupRow>(
      env.DB.prepare('SELECT * FROM yoco_modifier_groups WHERE workspace_id = ?1').bind(workspaceId)
    ).catch(() => [])
  ]);

  const stockItemsById = new Map(stockItems.map((item) => [text(item.id), item]));
  const stockBalanceByKey = new Map(stockBalances.map((balance) => [
    `${text(balance.stock_item_id)}:${text(balance.location_id)}`,
    numberValue(balance.quantity, 0)
  ]));
  const locationCostByKey = new Map(stockItemLocationPrices.map((row) => [
    `${text(row.stock_item_id)}:${text(row.location_id)}`,
    numberValue(row.price, 0)
  ]));
  const productsById = new Map(products.map((product) => [text(product.id), product]));
  const modifierCatalogue = buildModifierCatalogue(modifierGroups);
  const sourceLines = mode === 'refund' ? getRefundLineItems(order, refund) : getOrderLineItems(order);
  const paymentId = getPaymentId(order, refund);
  let refundIndex = 0;
  if (refund) {
    const refunds = Array.isArray(order.refunds) ? order.refunds : [];
    const returns = Array.isArray(order.returns) ? order.returns : [];
    const rIdx = refunds.findIndex((r: any) =>
      text(r.id) === text(refund.id) ||
      text(r.payment_id) === text(refund.payment_id) ||
      text(r.paymentId) === text(refund.paymentId)
    );
    if (rIdx >= 0) {
      refundIndex = rIdx;
    } else {
      const retIdx = returns.findIndex((r: any) =>
        text(r.id) === text(refund.id) ||
        text(r.payment_id) === text(refund.payment_id)
      );
      if (retIdx >= 0) {
        refundIndex = retIdx;
      }
    }
  }
  const statements: DbStatementLike[] = [];
  const existingOrder = await env.DB.prepare(
    `SELECT id, location_id
       FROM yoco_orders
      WHERE workspace_id = ?1 AND yoco_order_id = ?2 AND order_type = ?3
      LIMIT 1`
  ).bind(workspaceId, orderId, mode).first<{ id: string; location_id?: string | null }>();
  const existingSignatureRows = await allRows<{ signature_hash: string }>(
    env.DB.prepare(
      `SELECT signature_hash
         FROM yoco_processed_signatures
        WHERE workspace_id = ?1
          AND yoco_order_id = ?2`
    ).bind(workspaceId, orderId)
  );
  const existingSignatureHashes = new Set(existingSignatureRows.map((row) => text(row.signature_hash)).filter(Boolean));
  const yocoOrderDbId = existingOrder?.id || id('yoco_order');
  let missingRecipes = 0;
  let orderLineCount = 0;
  let movementCount = 0;
  let skippedDuplicates = 0;
  const orderSellingLocations = new Set<string>();
  const pendingBalanceDeltas = new Map<string, number>();
  const existingSellingLocation = existingOrder?.location_id
    ? locations.find((location) => text(location.id) === text(existingOrder.location_id)) || null
    : null;

  statements.push(env.DB.prepare(
    `INSERT INTO yoco_orders
      (id, workspace_id, yoco_order_id, yoco_payment_id, location_id, order_type, status, payment_method, total, occurred_at, raw_json)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(workspace_id, yoco_order_id, order_type) DO UPDATE SET
      yoco_payment_id = excluded.yoco_payment_id,
      status = excluded.status,
      payment_method = excluded.payment_method,
      total = excluded.total,
      occurred_at = excluded.occurred_at,
      raw_json = excluded.raw_json`
  ).bind(
    yocoOrderDbId,
    workspaceId,
    orderId,
    paymentId || null,
    mode,
    mode === 'refund' ? 'refunded' : text(order.status, 'completed'),
    getPaymentMethod(order, refund),
    (mode === 'refund'
      ? moneyToMajor(refund?.total_amount || order.total_price || objectValue(order.amounts).net_amount || 0)
      : moneyToMajor(order.total_price || objectValue(order.amounts).net_amount || 0)
    ) * (mode === 'refund' ? -1 : 1),
    occurredAt,
    jsonString(order)
  ));

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    const baseQuantitySold = lineQuantity(line);
    if (baseQuantitySold <= 0) continue;

    const sellingLocation = findSellingLocation(locations, order, line, existingSellingLocation);
    if (!sellingLocation) throw new Error('No selling/default location is configured for this workspace.');
    orderSellingLocations.add(text(sellingLocation.id));

    const components = buildSaleComponents(line, index, products, modifierCatalogue);
    for (const component of components) {
      const quantitySold = baseQuantitySold * component.quantityMultiplier;
      if (quantitySold <= 0) continue;

	      const product = component.product;
	      const productName = component.productName;
	      const productRecipe = product ? recipeFor('product', text(product.id), recipes) : null;
	      const productRaw = product ? objectValue(jsonParse(product.raw_json)) : {};
	      const recipeSourceStockItemId = product && !productRecipe
	        ? text(product.recipe_source_stock_item_id || productRaw.recipeSourceStockItemId || productRaw.recipe_source_stock_item_id)
	        : '';
	      const recipeSourceStockItemRecipe = recipeSourceStockItemId ? recipeFor('stock_item', recipeSourceStockItemId, recipes) : null;
	      const manualModifierOwnerIds = component.componentType === 'modifier' && component.modifier
        ? modifierRecipeOwnerIds(component.modifier, component.modifierCatalog || null)
        : [];
      const manualModifierRecipe = manualModifierOwnerIds
        .map((ownerId) => recipeFor('yoco_modifier', ownerId, recipes))
        .find(Boolean) || null;
      const linkedProducts = manualModifierRecipe
        ? linkedProductIdsFromValue(manualModifierRecipe.linked_product_id)
          .map((linkedProductId) => productsById.get(linkedProductId))
          .filter(Boolean) as ProductRow[]
        : [];
      const linkedProductRecipes = linkedProducts
        .map((linkedProduct) => recipeFor('product', text(linkedProduct.id), recipes))
        .filter(Boolean) as RecipeRow[];
      const linkedProductRecipeLines = linkedProductRecipes.flatMap((linkedRecipe) => linesForRecipe(text(linkedRecipe.id), recipeLines));
	      const recipe = productRecipe || recipeSourceStockItemRecipe || linkedProductRecipes[0] || manualModifierRecipe;
      const effectiveProduct = product || linkedProducts[0] || null;
      const signaturePaymentPart = mode === 'refund' ? `refund_${refundIndex}` : paymentId;
      const rawSignature = `yoco:${mode}:${orderId}:${signaturePaymentPart}:${component.lineId}:${quantitySold}`;
      const signatureHash = await hash(rawSignature);
      const hasExistingMovement = await componentMovementExists(env, workspaceId, orderId, mode, component, effectiveProduct);
      if (existingSignatureHashes.has(signatureHash) || hasExistingMovement) {
        skippedDuplicates += 1;
        continue;
      }

      const sourceLocationIds = new Set<string>();
      const lineDbId = id('yoco_line');
      const componentMovementStart = movementCount;

      if (!effectiveProduct || !recipe) {
        missingRecipes += 1;
      } else {
	        const baseLines = productRecipe
	          ? linesForRecipe(text(productRecipe.id), recipeLines)
	          : recipeSourceStockItemRecipe
	            ? linesForRecipe(text(recipeSourceStockItemRecipe.id), recipeLines)
	          : linkedProductRecipeLines.length ? linkedProductRecipeLines : linesForRecipe(text(recipe.id), recipeLines);
        const depletionLines = expandRecipeLines(
          baseLines,
          stockItemsById,
          recipes,
          recipeLines
        );
        if (!depletionLines.length) missingRecipes += 1;
        for (const depletion of depletionLines) {
          const sourceLocation = resolveSourceLocation(sellingLocation, depletion.stockItem, locations);
          const sourceLocationId = text(sourceLocation.id);
          sourceLocationIds.add(sourceLocationId);
          // For 'wastage' behavior: item is damaged, don't restore stock — deduct direction like a sale
          const isWastageBehavior = mode === 'refund' && returnBehavior === 'wastage';
          const deltaQty = quantitySold * depletion.quantity * (mode === 'refund' && !isWastageBehavior ? 1 : -1);
          const locationCostKey = `${text(depletion.stockItem.id)}:${sourceLocationId}`;
          const unitCost = locationCostByKey.has(locationCostKey)
            ? numberValue(locationCostByKey.get(locationCostKey), 0)
            : stockValuationUnitCost(depletion.stockItem);
          const movementId = id('mov');
          const balanceKey = `${text(depletion.stockItem.id)}:${sourceLocationId}`;
          let availableBefore: number | null = null;
          let insufficientStock = false;
          if (deltaQty < 0) {
            const available = numberValue(stockBalanceByKey.get(balanceKey), 0) + numberValue(pendingBalanceDeltas.get(balanceKey), 0);
            availableBefore = available;
            insufficientStock = available + deltaQty < 0;
          }
          // Only track pending balance deltas when stock will actually be updated
          if (!isWastageBehavior) {
            pendingBalanceDeltas.set(balanceKey, numberValue(pendingBalanceDeltas.get(balanceKey), 0) + deltaQty);
          }
          const resolvedMovementType = isWastageBehavior
            ? 'wastage'
            : mode === 'refund' ? 'sale_refund' : 'sale_depletion';
          const refundReason = mode === 'refund' && refund
            ? text(refund.reason || refund.refund_reason || refund.refundReason || refund.return_reason || refund.returnReason)
            : undefined;
          const refundNote = mode === 'refund' && refund
            ? text(refund.other_reason || refund.otherReason || refund.note || refund.reason_note || refund.reasonNote || refund.description)
            : undefined;
          const metadata = {
            mode,
            returnBehavior: mode === 'refund' ? returnBehavior : undefined,
            refundReason: refundReason || undefined,
            refundNote: refundNote || undefined,
            orderId,
            paymentId,
            componentType: component.componentType,
            parentLineId: component.parentLineId || null,
            parentProductId: text(component.parentProduct?.id) || null,
            parentProductName: text(component.parentProduct?.name) || null,
            modifierId: component.modifier ? modifierId(component.modifier) : null,
            modifierName: component.modifier ? modifierName(component.modifier, '') : null,
            modifierGroupId: component.modifierCatalog?.groupId || null,
            modifierGroupName: component.modifierCatalog?.groupName || text(component.modifier?.group_name || component.modifier?.groupName) || null,
            modifierVariantId: component.modifier ? productModifierVariantId(component.modifier, component.modifierCatalog || null) : null,
	            recipeOwnerType: text(recipe?.owner_type),
	            recipeOwnerId: text(recipe?.owner_id),
	            recipeSourceStockItemId: recipeSourceStockItemRecipe ? recipeSourceStockItemId : null,
	            linkedProductIds: linkedProducts.map((linkedProduct) => text(linkedProduct.id)).filter(Boolean),
            linkedProductNames: linkedProducts.map((linkedProduct) => text(linkedProduct.name)).filter(Boolean),
            productId: text(effectiveProduct.id),
            productName,
            componentLineId: component.lineId,
            sellingLocationId: text(sellingLocation.id),
            sellingLocationName: locationDisplayName(sellingLocation),
            sourceLocationId,
            sourceLocationName: locationDisplayName(sourceLocation),
            stockCategory: text(depletion.stockItem.category),
            recipeLineId: text(depletion.recipeLine.id),
            stockAvailableBefore: availableBefore,
            insufficientStock,
            valuationCostSource: locationCostByKey.has(locationCostKey) ? 'location' : 'stock_item_fallback'
          };

          statements.push(env.DB.prepare(
            `INSERT INTO stock_movements
              (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
               source_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'yoco_order', ?6, ?7, ?8, ?9, ?10, ?11, 'yoco', ?12, datetime('now'))`
          ).bind(
            movementId,
            workspaceId,
            text(depletion.stockItem.id),
            sourceLocationId,
            resolvedMovementType,
            orderId,
            sourceLocationId,
            deltaQty,
            unitCost,
            deltaQty * unitCost,
            occurredAt,
            jsonString(metadata)
          ));

          // Damaged/defective: don't restore stock — item can't go back on shelf.
          // The original sale deduction already stands; we just record the wastage movement above.
          if (!isWastageBehavior) {
            statements.push(env.DB.prepare(
              `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
               VALUES (?1, ?2, ?3, ?4, datetime('now'))
               ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
                quantity = quantity + excluded.quantity,
                updated_at = datetime('now')`
            ).bind(workspaceId, text(depletion.stockItem.id), sourceLocationId, deltaQty));
          }

          movementCount += 1;
        }
      }

      statements.push(env.DB.prepare(
        `INSERT INTO yoco_order_lines
          (id, workspace_id, yoco_order_id, product_id, yoco_line_id, name, quantity, total,
           selling_location_id, source_location_id, raw_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(workspace_id, yoco_order_id, yoco_line_id) DO UPDATE SET
           product_id = excluded.product_id,
           name = excluded.name,
           quantity = excluded.quantity,
           total = excluded.total,
           selling_location_id = excluded.selling_location_id,
           source_location_id = excluded.source_location_id,
           raw_json = excluded.raw_json`
      ).bind(
        lineDbId,
        workspaceId,
        yocoOrderDbId,
        text(effectiveProduct?.id) || null,
        component.lineId,
        productName,
        mode === 'refund' ? -quantitySold : quantitySold,
        component.total * (mode === 'refund' ? -1 : 1),
        text(sellingLocation.id),
        sourceLocationIds.size === 1 ? [...sourceLocationIds][0] : null,
        jsonString({
          ...component.sourceLine,
          kcpComponentType: component.componentType,
          kcpParentLineId: component.parentLineId || null,
          kcpModifier: component.modifier || null,
          kcpModifierCatalog: component.modifierCatalog || null
        })
      ));

      // A component is only terminally deduplicated after it has produced at least one
      // stock movement. Missing product/recipe mappings stay retryable so a later resync can
      // deduct stock after the setup is corrected.
      if (movementCount > componentMovementStart) {
        statements.push(env.DB.prepare(
          `INSERT INTO yoco_processed_signatures
            (workspace_id, signature_hash, event_type, yoco_order_id, payment_id, raw_signature)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(workspace_id, signature_hash) DO NOTHING`
        ).bind(workspaceId, signatureHash, options.eventType || `yoco.${mode}`, orderId, paymentId || null, rawSignature));
        existingSignatureHashes.add(signatureHash);
      }

      orderLineCount += 1;
    }
  }

  if (orderSellingLocations.size === 1) {
    statements.push(env.DB.prepare(
      `UPDATE yoco_orders
          SET location_id = ?1
        WHERE workspace_id = ?2 AND yoco_order_id = ?3 AND order_type = ?4`
    ).bind([...orderSellingLocations][0], workspaceId, orderId, mode));
  }

  if (statements.length) await env.DB.batch(statements);

  const retryable = missingRecipes > 0;
  return {
    processed: movementCount > 0 || skippedDuplicates > 0,
    reason: retryable
      ? (movementCount > 0 ? 'partially_processed_missing_recipe_or_mapping' : 'missing_recipe_or_mapping')
      : skippedDuplicates && !orderLineCount ? 'duplicate' : undefined,
    retryable,
    missingRecipes,
    orderLines: orderLineCount,
    stockMovements: movementCount,
    skippedDuplicates
  };
}
