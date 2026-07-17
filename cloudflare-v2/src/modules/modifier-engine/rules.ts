import type { Env } from '../../legacy/types';
import { expandProductIngredients } from '../../inventory/recipe-expansion';
import { newId, nowIso, type Row } from '../yoco-engine-v2/repository';

export const MODIFIER_ACTIONS = [
  'ADD_RECIPE',
  'ADD_STOCK_ITEM',
  'REMOVE_INGREDIENT',
  'REPLACE_INGREDIENT',
  'NO_STOCK_CHANGE'
] as const;

export type ModifierAction = typeof MODIFIER_ACTIONS[number];

export class ModifierRuleValidationError extends Error {
  readonly code = 'MODIFIER_RULE_VALIDATION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'ModifierRuleValidationError';
  }
}

export interface ModifierIdentityInput {
  id?: string;
  groupId?: string;
  variantId?: string;
  name?: string;
}

export interface ModifierRuleInput {
  actionType?: string;
  targetOwnerType?: string;
  targetOwnerId?: string;
  sourceStockItemId?: string;
  replacementStockItemId?: string;
  quantity?: number;
  unit?: string;
  menuItemIds?: string[];
  locationIds?: string[];
  applyAllMatchingProducts?: boolean;
  active?: boolean;
  sourceModifierId?: string;
  sourceModifierGroupId?: string;
  sourceModifierVariantId?: string;
  sourceName?: string;
}

export interface ResolvedModifierMapping {
  ownerId: string;
  rule?: Row;
  autoLinkedProductId?: string;
  source: 'rule' | 'recipe' | 'catalogue_product' | 'none';
}

function text(value: unknown, fallback = ''): string { return String(value ?? fallback).trim(); }
function numberValue(value: unknown, fallback = 0): number { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function objectValue(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function arrayValue(value: unknown): Row[] { return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as Row[] : []; }
function parseJson(value: unknown): Row { try { return objectValue(JSON.parse(text(value, '{}'))); } catch { return {}; } }
function normalize(value: unknown): string { return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function slug(value: unknown): string { return normalize(value).replace(/\s+/g, '_'); }
function unique(values: unknown[]): string[] { return [...new Set(values.map((value) => text(value)).filter(Boolean))]; }
function jsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return unique(value);
  try { const parsed = JSON.parse(text(value, '[]')); return Array.isArray(parsed) ? unique(parsed) : []; } catch { return []; }
}

function modifierGroupRefId(ref: unknown): string {
  if (typeof ref === 'string' || typeof ref === 'number') return text(ref);
  const row = objectValue(ref);
  return text(row.id || row.modifier_group_id || row.modifierGroupId || row.uuid || row.group_id || row.groupId || row.external_id);
}

function modifierGroupRefsFromProductRaw(raw: Row): string[] {
  const refs: unknown[] = [];
  const collect = (row: Row) => {
    [
      row.yocoModifierGroupIds,
      row.yoco_modifier_group_ids,
      row.modifier_groups,
      row.modifierGroups,
      row.modifier_group_ids,
      row.modifierGroupIds,
      row.assigned_modifier_groups,
      row.assignedModifierGroups
    ].forEach((value) => {
      if (Array.isArray(value)) refs.push(...value);
      else if (value && typeof value === 'object') refs.push(...Object.values(value as Row));
    });
  };
  collect(raw);
  collect(objectValue(raw.item));
  collect(objectValue(raw.variant));
  const item = objectValue(raw.item);
  for (const variant of arrayValue(item.variants || item.item_variants || item.itemVariants)) collect(variant);
  return unique(refs.map(modifierGroupRefId));
}

function linkedProductIds(value: unknown): string[] {
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return unique(parsed);
  } catch {}
  return unique(raw.split(','));
}

function stockItemUomFactor(item: Row, requestedUnit: string): number | null {
  const baseUnit = normalize(item.unit);
  const requested = normalize(requestedUnit || item.unit);
  if (!requested || requested === baseUnit) return 1;
  const raw = parseJson(item.raw_json);
  for (const collection of [raw.uoms, raw.customUoms, raw.custom_uoms, raw.units, raw.alternateUoms, raw.alternate_uoms]) {
    if (!Array.isArray(collection)) continue;
    for (const entryValue of collection) {
      const entry = objectValue(entryValue);
      if (normalize(entry.name || entry.unit || entry.uom || entry.label) !== requested) continue;
      const factor = numberValue(entry.ratio ?? entry.qtyInBase ?? entry.qty_in_base ?? entry.factor ?? entry.baseQty ?? entry.packSize, 0);
      return factor > 0 ? factor : null;
    }
  }
  return null;
}

function rawModifierId(modifier: Row): string {
  return text(modifier._kcp_modifier_id || modifier.modifier_id || modifier.modifierId || modifier.id || modifier.uuid);
}
function rawModifierVariantId(modifier: Row): string {
  const product = objectValue(modifier.product);
  const item = objectValue(modifier.item);
  const variant = objectValue(modifier.variant);
  const productVariant = objectValue(modifier.product_variant || modifier.productVariant);
  return text(
    modifier.variant_id || modifier.variantId || modifier.item_variant_id || modifier.itemVariantId ||
    modifier.variation_id || modifier.product_variant_id || modifier.productVariantId || modifier.product_id ||
    modifier.productId || modifier.item_id || modifier.itemId || productVariant.id || productVariant.variant_id ||
    productVariant.variantId || variant.id || variant.variant_id || variant.variantId || product.variant_id ||
    product.variantId || product.id || item.variant_id || item.variantId || item.id
  );
}
function rawModifierName(modifier: Row): string {
  const product = objectValue(modifier.product);
  const item = objectValue(modifier.item);
  const variant = objectValue(modifier.variant);
  const productVariant = objectValue(modifier.product_variant || modifier.productVariant);
  return text(
    modifier.name || modifier.display_name || modifier.displayName || modifier.title || modifier.label || modifier.value || modifier.product_name || modifier.productName ||
    productVariant.name || productVariant.display_name || productVariant.displayName ||
    variant.name || variant.display_name || variant.displayName ||
    product.name || product.display_name || product.displayName ||
    item.name || item.display_name || item.displayName
  );
}
function ownerIds(groupId: string, modifier: Row): string[] {
  const modifierId = rawModifierId(modifier);
  const variantId = rawModifierVariantId(modifier);
  return unique([
    groupId && modifierId ? `${groupId}:${modifierId}` : '',
    modifierId,
    variantId ? `variant:${variantId}` : '',
    slug(rawModifierName(modifier))
  ]);
}
function optionRows(raw: Row): Row[] {
  const keys = [
    'modifiers', 'modifier_items', 'modifierItems', 'modifier_options', 'modifierOptions',
    'product_modifiers', 'productModifiers', 'linked_product_modifiers', 'linkedProductModifiers',
    'option_modifiers', 'optionModifiers', 'add_on_modifiers', 'addOnModifiers',
    'note_modifiers', 'noteModifiers', 'text_modifiers', 'textModifiers',
    'options', 'option_items', 'optionItems', 'option_values', 'optionValues',
    'choices', 'values', 'items', 'entries', 'modifier_group_items', 'modifierGroupItems',
    'selections', 'selection_options', 'selectionOptions'
  ];
  const rows: Row[] = [];
  const containers = [raw, objectValue(raw.data), objectValue(raw.result), objectValue(raw.payload), objectValue(raw.attributes), objectValue(raw.configuration), objectValue(raw.config), objectValue(raw.metadata)];
  for (const container of containers) {
    for (const key of keys) {
      const value = container[key];
      const add = (entry: unknown, entryId: string, index: number) => {
        const outer = objectValue(entry);
        const nested = objectValue(outer.modifier || outer.option || outer.choice || outer.product_modifier || outer.productModifier || outer.note_modifier || outer.noteModifier);
        const row = Object.keys(nested).length ? { ...outer, ...nested } : outer;
        const normalizedKey = key.toLowerCase();
        const collectionType = normalizedKey.includes('note') || normalizedKey.includes('text')
          ? 'note'
          : normalizedKey.includes('product')
            ? 'product'
            : 'option';
        rows.push({
          ...row,
          id: text(row.id || row.uuid || row.modifier_id || row.modifierId || row.option_id || row.optionId, entryId),
          name: rawModifierName(row) || text(entry, `Option ${index + 1}`),
          _kcp_modifier_kind: text(row._kcp_modifier_kind || row.type || row.kind, collectionType),
        });
      };
      if (Array.isArray(value)) value.forEach((entry, index) => add(entry, `${text(raw.id || raw.uuid, 'group')}:${key}:${index + 1}`, index));
      else if (value && typeof value === 'object') Object.entries(value as Row).forEach(([entryId, entry], index) => add(entry, entryId, index));
    }
  }
  if (rows.length) {
    const deduped = new Map<string, Row>();
    rows.forEach((row, index) => {
      const key = text(row._kcp_modifier_id || row.id || row.uuid, `${rawModifierName(row)}:${index}`);
      if (!deduped.has(key)) deduped.set(key, row);
    });
    return [...deduped.values()];
  }
  const type = normalize(raw.type || raw.kind || raw.modifier_type || raw.modifierType || raw.input_type || raw.inputType);
  if (type.includes('note') || type.includes('free text') || type === 'text' || raw.is_note === true || raw.isNote === true) {
    const groupId = text(raw.id || raw.modifier_group_id || raw.modifierGroupId || raw.uuid, slug(rawModifierName(raw) || 'note'));
    return [{ id: `${groupId}:note`, name: rawModifierName(raw) || 'Note', type: 'note', _kcp_modifier_kind: 'note', _kcp_modifier_id: `${groupId}:note` }];
  }
  return [];
}

async function firstRuleForOwners(env: Env, workspaceId: string, owners: string[]): Promise<Row | null> {
  if (!owners.length) return null;
  const placeholders = owners.map((_, index) => `?${index + 2}`).join(', ');
  try {
    return await env.DB.prepare(
      `SELECT * FROM modifier_rules
        WHERE workspace_id = ?1 AND status = 'active' AND modifier_owner_id IN (${placeholders})
        ORDER BY CASE modifier_owner_id ${owners.map((_, index) => `WHEN ?${index + 2} THEN ${index}`).join(' ')} ELSE 99 END
        LIMIT 1`
    ).bind(workspaceId, ...owners).first<Row>();
  } catch {
    return null;
  }
}

async function firstRuleForIdentity(env: Env, workspaceId: string, identity: ModifierIdentityInput): Promise<Row | null> {
  const modifierId = text(identity.id);
  const groupId = text(identity.groupId);
  const variantId = text(identity.variantId);
  try {
    const exact = await env.DB.prepare(
      `SELECT * FROM modifier_rules
        WHERE workspace_id = ?1 AND status = 'active'
          AND (
            (?2 <> '' AND source_modifier_id = ?2 AND (?3 = '' OR COALESCE(source_modifier_group_id, '') = '' OR source_modifier_group_id = ?3))
            OR (?4 <> '' AND source_modifier_variant_id = ?4)
          )
        ORDER BY
          CASE
            WHEN ?2 <> '' AND source_modifier_id = ?2 AND ?3 <> '' AND source_modifier_group_id = ?3 THEN 0
            WHEN ?4 <> '' AND source_modifier_variant_id = ?4 THEN 1
            WHEN ?2 <> '' AND source_modifier_id = ?2 THEN 2
            ELSE 9
          END,
          updated_at DESC
        LIMIT 1`
    ).bind(workspaceId, modifierId, groupId, variantId).first<Row>();
    if (exact) return exact;

    const normalizedName = normalize(identity.name);
    if (!normalizedName) return null;
    const rows = await env.DB.prepare(
      `SELECT * FROM modifier_rules
        WHERE workspace_id = ?1 AND status = 'active' AND COALESCE(source_name, '') <> ''
        ORDER BY updated_at DESC`
    ).bind(workspaceId).all<Row>();
    const nameMatches = (rows.results || []).filter((row) => normalize(row.source_name) === normalizedName);
    const scopedMatch = nameMatches.find((row) => (
      !groupId || !text(row.source_modifier_group_id) || text(row.source_modifier_group_id) === groupId
    ));
    if (scopedMatch) return scopedMatch;
    const uniqueOwners = unique(nameMatches.map((row) => row.modifier_owner_id));
    return uniqueOwners.length === 1 ? nameMatches[0] || null : null;
  } catch {
    return null;
  }
}

async function firstRecipeOwner(env: Env, workspaceId: string, owners: string[]): Promise<string> {
  if (!owners.length) return '';
  const placeholders = owners.map((_, index) => `?${index + 2}`).join(', ');
  const row = await env.DB.prepare(
    `SELECT owner_id FROM recipes
      WHERE workspace_id = ?1 AND active = 1 AND owner_type = 'yoco_modifier'
        AND owner_id IN (${placeholders})
      ORDER BY CASE owner_id ${owners.map((_, index) => `WHEN ?${index + 2} THEN ${index}`).join(' ')} ELSE 99 END LIMIT 1`
  ).bind(workspaceId, ...owners).first<Row>();
  return text(row?.owner_id);
}

async function autoLinkedProduct(env: Env, workspaceId: string, modifier: Row): Promise<string> {
  const variantId = rawModifierVariantId(modifier);
  if (variantId) {
    const row = await env.DB.prepare(
      `SELECT id FROM products
        WHERE workspace_id = ?1 AND active = 1
          AND (yoco_variant_id = ?2 OR yoco_item_id = ?2)
        ORDER BY CASE WHEN yoco_variant_id = ?2 THEN 0 ELSE 1 END LIMIT 1`
    ).bind(workspaceId, variantId).first<Row>();
    if (row?.id) return text(row.id);
  }
  const name = normalize(rawModifierName(modifier));
  if (!name) return '';
  const rows = await env.DB.prepare(
    `SELECT id, name FROM products WHERE workspace_id = ?1 AND active = 1`
  ).bind(workspaceId).all<Row>();
  return text((rows.results || []).find((row) => normalize(row.name) === name)?.id);
}

export async function resolveModifierMapping(env: Env, workspaceId: string, identity: ModifierIdentityInput): Promise<ResolvedModifierMapping> {
  const identityRule = await firstRuleForIdentity(env, workspaceId, identity);
  if (identityRule) return { ownerId: text(identityRule.modifier_owner_id), rule: identityRule, source: 'rule' };

  const directOwners = unique([
    identity.groupId && identity.id ? `${identity.groupId}:${identity.id}` : '',
    identity.id,
    identity.variantId ? `variant:${identity.variantId}` : '',
    identity.variantId,
    slug(identity.name)
  ]);
  const directRule = await firstRuleForOwners(env, workspaceId, directOwners);
  if (directRule) return { ownerId: text(directRule.modifier_owner_id), rule: directRule, source: 'rule' };
  const directRecipe = await firstRecipeOwner(env, workspaceId, directOwners);
  if (directRecipe) return { ownerId: directRecipe, source: 'recipe' };

  const groups = await env.DB.prepare(
    `SELECT id, yoco_modifier_group_id, name, raw_json FROM yoco_modifier_groups
      WHERE workspace_id = ?1
      ORDER BY CASE WHEN ?2 <> '' AND (yoco_modifier_group_id = ?2 OR id = ?2) THEN 0 ELSE 1 END, name`
  ).bind(workspaceId, text(identity.groupId)).all<Row>();
  const normalizedName = normalize(identity.name);
  const nameCandidates: Array<{ option: Row; groupId: string; groupMatches: boolean }> = [];

  const resolveCatalogueOption = async (groupId: string, option: Row): Promise<ResolvedModifierMapping | null> => {
    const owners = ownerIds(groupId, option);
    const rule = await firstRuleForOwners(env, workspaceId, owners);
    if (rule) return { ownerId: text(rule.modifier_owner_id), rule, source: 'rule' };
    const recipeOwner = await firstRecipeOwner(env, workspaceId, owners);
    if (recipeOwner) return { ownerId: recipeOwner, source: 'recipe' };
    const productId = await autoLinkedProduct(env, workspaceId, option);
    if (productId) return { ownerId: owners[0] || directOwners[0], autoLinkedProductId: productId, source: 'catalogue_product' };
    return null;
  };

  for (const group of groups.results || []) {
    const raw = parseJson(group.raw_json);
    const groupId = text(raw.id || group.yoco_modifier_group_id);
    const groupMatches = !identity.groupId || identity.groupId === groupId || identity.groupId === text(group.id) || identity.groupId === text(group.yoco_modifier_group_id);
    for (const option of optionRows(raw)) {
      const idMatch = Boolean(identity.id && rawModifierId(option) === identity.id);
      const variantMatch = Boolean(identity.variantId && rawModifierVariantId(option) === identity.variantId);
      if (idMatch || variantMatch) {
        const resolved = await resolveCatalogueOption(groupId, option);
        if (resolved) return resolved;
      }
      if (normalizedName && normalize(rawModifierName(option)) === normalizedName) {
        nameCandidates.push({ option, groupId, groupMatches });
      }
    }
  }

  const scopedNameCandidates = nameCandidates.some((candidate) => candidate.groupMatches)
    ? nameCandidates.filter((candidate) => candidate.groupMatches)
    : nameCandidates;
  const uniqueNameCandidates = scopedNameCandidates.filter((candidate, index, all) => {
    const key = ownerIds(candidate.groupId, candidate.option)[0] || `${candidate.groupId}:${rawModifierName(candidate.option)}`;
    return all.findIndex((entry) => (ownerIds(entry.groupId, entry.option)[0] || `${entry.groupId}:${rawModifierName(entry.option)}`) === key) === index;
  });
  const resolvedNameCandidates: ResolvedModifierMapping[] = [];
  for (const candidate of uniqueNameCandidates) {
    const resolved = await resolveCatalogueOption(candidate.groupId, candidate.option);
    if (resolved) resolvedNameCandidates.push(resolved);
  }
  const uniqueResolvedOwners = unique(resolvedNameCandidates.map((candidate) => candidate.ownerId));
  if (uniqueResolvedOwners.length === 1) {
    return resolvedNameCandidates.find((candidate) => candidate.ownerId === uniqueResolvedOwners[0]) || resolvedNameCandidates[0];
  }
  return { ownerId: '', source: 'none' };
}

export async function getApplicableModifierRule(env: Env, workspaceId: string, ownerId: string, menuItemId = '', locationId = ''): Promise<Row | null> {
  const rule = await firstRuleForOwners(env, workspaceId, [ownerId]);
  if (!rule) return null;
  const menuIds = jsonStringArray(rule.menu_item_scope_json);
  const locationIds = jsonStringArray(rule.location_scope_json);
  const excludedByMenu = menuIds.length > 0 && !menuIds.includes(menuItemId);
  const excludedByLocation = locationIds.length > 0 && !locationIds.includes(locationId);
  if (excludedByMenu || excludedByLocation) {
    return {
      ...rule,
      action_type: 'NO_STOCK_CHANGE',
      scope_excluded: 1,
      scope_excluded_reason: excludedByMenu ? 'menu_item' : 'location'
    };
  }
  return rule;
}

async function assertEntity(env: Env, sql: string, values: unknown[], message: string): Promise<Row> {
  const row = await env.DB.prepare(sql).bind(...values).first<Row>();
  if (!row) throw new ModifierRuleValidationError(message);
  return row;
}

async function assertRemovalScope(env: Env, workspaceId: string, menuItemIds: string[], sourceStockItemId: string): Promise<void> {
  for (const productId of unique(menuItemIds)) {
    const ingredients = await expandProductIngredients(env, workspaceId, productId, 1);
    if (!ingredients.some((ingredient) => ingredient.stockItemId === sourceStockItemId && ingredient.totalQty > 0)) {
      const product = await env.DB.prepare(`SELECT name FROM products WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`).bind(workspaceId, productId).first<Row>();
      throw new ModifierRuleValidationError(`${text(product?.name, 'Selected menu item')} does not contain the ingredient selected for this modifier action.`);
    }
  }
}

async function matchingMenuItemIds(env: Env, workspaceId: string, ownerId: string, sourceModifierGroupId: string): Promise<string[]> {
  const ids = new Set<string>();
  const recipe = await env.DB.prepare(
    `SELECT linked_product_id FROM recipes
      WHERE workspace_id = ?1 AND owner_type = 'yoco_modifier' AND owner_id = ?2 AND active = 1 LIMIT 1`
  ).bind(workspaceId, ownerId).first<Row>();
  linkedProductIds(recipe?.linked_product_id).forEach((id) => ids.add(id));

  if (sourceModifierGroupId) {
    const products = await env.DB.prepare(
      `SELECT id, raw_json FROM products WHERE workspace_id = ?1 AND active = 1`
    ).bind(workspaceId).all<Row>();
    for (const product of products.results || []) {
      if (modifierGroupRefsFromProductRaw(parseJson(product.raw_json)).includes(sourceModifierGroupId)) ids.add(text(product.id));
    }
  }
  return [...ids].filter(Boolean);
}

function normalizedRuleInput(input: ModifierRuleInput): Required<ModifierRuleInput> & { actionType: ModifierAction } {
  const actionType = text(input.actionType, 'ADD_RECIPE').toUpperCase() as ModifierAction;
  if (!MODIFIER_ACTIONS.includes(actionType)) throw new ModifierRuleValidationError('Select a valid modifier stock action.');
  return {
    actionType,
    targetOwnerType: text(input.targetOwnerType),
    targetOwnerId: text(input.targetOwnerId),
    sourceStockItemId: text(input.sourceStockItemId),
    replacementStockItemId: text(input.replacementStockItemId),
    quantity: Math.abs(numberValue(input.quantity, 1)),
    unit: text(input.unit),
    menuItemIds: input.applyAllMatchingProducts === true ? [] : unique(input.menuItemIds || []),
    locationIds: unique(input.locationIds || []),
    applyAllMatchingProducts: input.applyAllMatchingProducts === true,
    active: input.active !== false,
    sourceModifierId: text(input.sourceModifierId),
    sourceModifierGroupId: text(input.sourceModifierGroupId),
    sourceModifierVariantId: text(input.sourceModifierVariantId),
    sourceName: text(input.sourceName)
  };
}

export async function validateModifierRule(env: Env, input: {
  workspaceId: string;
  ownerId: string;
  rule: ModifierRuleInput;
  allowPendingRecipeOwnerId?: string;
}): Promise<ReturnType<typeof normalizedRuleInput>> {
  const value = normalizedRuleInput(input.rule);
  if ((value.actionType === 'ADD_RECIPE' || value.actionType === 'ADD_STOCK_ITEM') && value.quantity <= 0) {
    throw new ModifierRuleValidationError('Modifier quantity must be greater than zero.');
  }
  if (value.targetOwnerType && !['product', 'stock_item', 'yoco_modifier'].includes(value.targetOwnerType)) {
    throw new ModifierRuleValidationError('Select a valid recipe target.');
  }
  if (value.actionType === 'ADD_RECIPE') {
    if (!value.targetOwnerType || !value.targetOwnerId) throw new ModifierRuleValidationError('Select the recipe that should be deducted.');
    value.unit ||= 'ea';
    const isPendingSelfRecipe = value.targetOwnerType === 'yoco_modifier' &&
      value.targetOwnerId === text(input.allowPendingRecipeOwnerId) &&
      value.targetOwnerId === input.ownerId;
    if (!isPendingSelfRecipe) {
      await assertEntity(env,
        `SELECT id FROM recipes WHERE workspace_id = ?1 AND owner_type = ?2 AND owner_id = ?3 AND active = 1 LIMIT 1`,
        [input.workspaceId, value.targetOwnerType, value.targetOwnerId],
        'The selected recipe is missing or inactive.'
      );
    }
  }
  if (value.actionType === 'ADD_STOCK_ITEM') {
    if (!value.targetOwnerId) throw new ModifierRuleValidationError('Select the stock item that should be deducted.');
    const item = await assertEntity(env,
      `SELECT id, name, unit, raw_json FROM stock_items WHERE workspace_id = ?1 AND id = ?2 AND active = 1 LIMIT 1`,
      [input.workspaceId, value.targetOwnerId],
      'The selected stock item is missing or inactive.'
    );
    if (!text(value.unit)) value.unit = text(item.unit, 'ea');
    if (stockItemUomFactor(item, value.unit) === null) {
      throw new ModifierRuleValidationError(`The unit ${value.unit} is not a valid base or custom UOM for ${text(item.name, 'the selected stock item')}.`);
    }
  }
  if (value.actionType === 'REMOVE_INGREDIENT' || value.actionType === 'REPLACE_INGREDIENT' || value.actionType === 'NO_STOCK_CHANGE') {
    value.unit ||= 'ea';
  }
  if (value.actionType === 'REMOVE_INGREDIENT' || value.actionType === 'REPLACE_INGREDIENT') {
    if (!value.sourceStockItemId) throw new ModifierRuleValidationError('Select the ingredient to remove from the base recipe.');
    const source = await assertEntity(env,
      `SELECT id, unit FROM stock_items WHERE workspace_id = ?1 AND id = ?2 AND active = 1 LIMIT 1`,
      [input.workspaceId, value.sourceStockItemId],
      'The ingredient to remove is missing or inactive.'
    );
    // Explicit menu-item scopes remain strict: every selected item must contain
    // the source ingredient. An "all matching products" rule is intentionally
    // broader and is evaluated per sold item, so products that do not contain
    // the source are skipped safely instead of blocking the rule save.
    if (value.menuItemIds.length) {
      await assertRemovalScope(env, input.workspaceId, value.menuItemIds, value.sourceStockItemId);
    }
    if (value.actionType === 'REPLACE_INGREDIENT') {
      if (value.quantity <= 0) throw new ModifierRuleValidationError('Replacement quantity must be greater than zero.');
      if (!value.replacementStockItemId) throw new ModifierRuleValidationError('Select the replacement ingredient.');
      if (value.replacementStockItemId === value.sourceStockItemId) throw new ModifierRuleValidationError('The replacement ingredient must be different from the original ingredient.');
      const replacement = await assertEntity(env,
        `SELECT id, unit FROM stock_items WHERE workspace_id = ?1 AND id = ?2 AND active = 1 LIMIT 1`,
        [input.workspaceId, value.replacementStockItemId],
        'The replacement ingredient is missing or inactive.'
      );
      if (normalize(source.unit) !== normalize(replacement.unit)) {
        throw new ModifierRuleValidationError(`Replacement UOM is incompatible. ${text(source.unit)} can only be replaced by an item using the same base UOM.`);
      }
    }
  }
  for (const productId of value.menuItemIds) {
    await assertEntity(env, `SELECT id FROM products WHERE workspace_id = ?1 AND id = ?2 AND active = 1 LIMIT 1`, [input.workspaceId, productId], 'A selected menu item is missing or inactive.');
  }
  for (const locationId of value.locationIds) {
    await assertEntity(env, `SELECT id FROM locations WHERE workspace_id = ?1 AND id = ?2 AND active = 1 LIMIT 1`, [input.workspaceId, locationId], 'A selected location is missing or inactive.');
  }

  return value;
}

export async function upsertModifierRule(env: Env, input: {
  workspaceId: string;
  ownerId: string;
  rule: ModifierRuleInput;
  actor?: string;
}): Promise<Row> {
  const value = await validateModifierRule(env, input);
  const existing = await env.DB.prepare(
    `SELECT id, version, created_at FROM modifier_rules WHERE workspace_id = ?1 AND modifier_owner_id = ?2 LIMIT 1`
  ).bind(input.workspaceId, input.ownerId).first<Row>();
  const ruleId = text(existing?.id) || newId('modifier_rule');
  const version = Math.max(1, numberValue(existing?.version, 0) + 1);
  const now = nowIso();
  const status = value.active ? 'active' : 'inactive';
  const snapshot = {
    modifierOwnerId: input.ownerId,
    ...value,
    status,
    version
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO modifier_rules (
        id, workspace_id, modifier_owner_id, source_modifier_id, source_modifier_group_id,
        source_modifier_variant_id, source_name, action_type, target_owner_type, target_owner_id,
        source_stock_item_id, replacement_stock_item_id, quantity, unit, menu_item_scope_json,
        location_scope_json, apply_all_matching_products, status, version, raw_json,
        created_by, created_at, updated_at
      ) VALUES (?1, ?2, ?3, NULLIF(?4, ''), NULLIF(?5, ''), NULLIF(?6, ''), NULLIF(?7, ''),
        ?8, NULLIF(?9, ''), NULLIF(?10, ''), NULLIF(?11, ''), NULLIF(?12, ''), ?13, ?14,
        ?15, ?16, ?17, ?18, ?19, ?20, NULLIF(?21, ''), ?22, ?22)
      ON CONFLICT(workspace_id, modifier_owner_id) DO UPDATE SET
        source_modifier_id = excluded.source_modifier_id,
        source_modifier_group_id = excluded.source_modifier_group_id,
        source_modifier_variant_id = excluded.source_modifier_variant_id,
        source_name = excluded.source_name,
        action_type = excluded.action_type,
        target_owner_type = excluded.target_owner_type,
        target_owner_id = excluded.target_owner_id,
        source_stock_item_id = excluded.source_stock_item_id,
        replacement_stock_item_id = excluded.replacement_stock_item_id,
        quantity = excluded.quantity,
        unit = excluded.unit,
        menu_item_scope_json = excluded.menu_item_scope_json,
        location_scope_json = excluded.location_scope_json,
        apply_all_matching_products = excluded.apply_all_matching_products,
        status = excluded.status,
        version = excluded.version,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`
    ).bind(
      ruleId, input.workspaceId, input.ownerId, value.sourceModifierId, value.sourceModifierGroupId,
      value.sourceModifierVariantId, value.sourceName, value.actionType, value.targetOwnerType,
      value.targetOwnerId, value.sourceStockItemId, value.replacementStockItemId, value.quantity,
      value.unit, JSON.stringify(value.menuItemIds), JSON.stringify(value.locationIds),
      value.applyAllMatchingProducts ? 1 : 0, status, version, JSON.stringify(snapshot),
      text(input.actor), now
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO modifier_rule_versions
        (id, workspace_id, modifier_rule_id, version, snapshot_json, changed_by, changed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7)`
    ).bind(newId('modifier_rule_version'), input.workspaceId, ruleId, version, JSON.stringify(snapshot), text(input.actor), now)
  ]);
  return (await env.DB.prepare(`SELECT * FROM modifier_rules WHERE id = ?1 LIMIT 1`).bind(ruleId).first<Row>()) || { id: ruleId };
}

export function serializeModifierRule(row: Row | null | undefined): Row | null {
  if (!row) return null;
  return {
    id: text(row.id),
    modifierOwnerId: text(row.modifier_owner_id),
    sourceModifierId: text(row.source_modifier_id),
    sourceModifierGroupId: text(row.source_modifier_group_id),
    sourceModifierVariantId: text(row.source_modifier_variant_id),
    sourceName: text(row.source_name),
    actionType: text(row.action_type, 'ADD_RECIPE'),
    targetOwnerType: text(row.target_owner_type),
    targetOwnerId: text(row.target_owner_id),
    sourceStockItemId: text(row.source_stock_item_id),
    replacementStockItemId: text(row.replacement_stock_item_id),
    quantity: numberValue(row.quantity, 1),
    unit: text(row.unit, 'ea'),
    menuItemIds: jsonStringArray(row.menu_item_scope_json),
    locationIds: jsonStringArray(row.location_scope_json),
    applyAllMatchingProducts: numberValue(row.apply_all_matching_products) === 1,
    active: text(row.status) === 'active',
    status: text(row.status),
    version: numberValue(row.version, 1)
  };
}

export async function observeModifier(env: Env, input: {
  workspaceId: string;
  sourceOrderId: string;
  sourceLineId: string;
  identity: ModifierIdentityInput;
  ownerId?: string;
  mappingStatus: string;
  raw?: Row;
}): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO modifier_observations (
        id, workspace_id, source_order_id, source_line_id, source_modifier_id,
        source_modifier_group_id, source_modifier_variant_id, source_name,
        mapped_modifier_owner_id, mapping_status, raw_json, observed_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7, NULLIF(?8, ''),
        NULLIF(?9, ''), ?10, ?11, ?12)
      ON CONFLICT(workspace_id, source_order_id, source_line_id, source_modifier_id, source_modifier_variant_id)
      DO UPDATE SET mapped_modifier_owner_id = excluded.mapped_modifier_owner_id,
        mapping_status = excluded.mapping_status, raw_json = excluded.raw_json, observed_at = excluded.observed_at`
    ).bind(
      newId('modifier_observation'), input.workspaceId, input.sourceOrderId, input.sourceLineId,
      text(input.identity.id), text(input.identity.groupId), text(input.identity.variantId), text(input.identity.name),
      text(input.ownerId), input.mappingStatus, JSON.stringify(input.raw || {}), nowIso()
    ).run();
  } catch {
    // Observation storage must never block sale ingestion while older tenants are migrating.
  }
}
