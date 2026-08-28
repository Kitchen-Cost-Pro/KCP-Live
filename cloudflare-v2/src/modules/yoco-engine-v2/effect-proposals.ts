import type { Env } from '../../legacy/types';
import type { CanonicalSaleCompletedEvent } from './contracts';
import { appendTimeline, newId, nowIso, type Row } from './repository';
import { getApplicableModifierRule } from '../modifier-engine/rules';
import { UNSPECIFIED_LINE_UOM, standardUomFactor } from '../../inventory/uom';
import { getApplicableNoteRules, getModifierEngineControl, recordModifierEngineComparison, snapshotSaleAction, snapshotSaleMovement } from '../modifier-engine/reliability';

function text(value: unknown, fallback = ''): string { return String(value ?? fallback).trim(); }
function numberValue(value: unknown, fallback = 0): number { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function objectValue(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function parseJson(value: unknown): Row { try { return objectValue(JSON.parse(text(value, '{}'))); } catch { return {}; } }
function normalized(value: unknown): string { return text(value).toLowerCase().replace(/[\s_-]+/g, ''); }

interface IngredientProposal {
  sourceLineId: string;
  menuItemId?: string;
  modifierId?: string;
  ingredientItemId: string;
  stockCategory?: string;
  locationId?: string;
  quantity: number;
  baseUom: string;
  unitCost: number;
  warningCode?: string;
  resolutionStatus: string;
  ruleId?: string;
  ruleVersion?: number;
  actionType?: string;
  ruleSnapshot?: Row;
}

// See inventory/uom.ts for the shared unit contract this implements.
//
// Resolution order, deliberately mirroring convertMenuRecipeQty in legacy/reporting-routes.ts so
// stock and reporting can never disagree about the same recipe line again:
//   1. no unit, or the item's own base unit          -> 1
//   2. a standard same-family conversion (g -> kg)   -> that factor
//   3. a custom UOM configured on the stock item     -> its ratio
//   4. the 'ea' unspecified sentinel                 -> 1 (the item's base unit)
//   5. anything else                                 -> null, a real misconfiguration
//
// Step 4 sits AFTER the custom lookup on purpose: an item that genuinely has 'ea' configured as a
// custom UOM (e.g. 1 ea = 0.25 kg portion) must keep using that ratio rather than the sentinel.
function resolveCustomUomFactor(item: Row, unit: string): number | null {
  const baseUnit = normalized(item.unit);
  const requested = normalized(unit || item.unit);
  if (!requested || requested === baseUnit) return 1;

  const standard = standardUomFactor(requested, baseUnit);
  if (standard !== null) return standard;

  const raw = parseJson(item.raw_json);
  // `uomConfigurations` (customUom/custom_uom + ratio) is the schema the stock-item editor
  // frontend actually writes (see inventory/recipe-expansion.ts resolveUomRatio and Recipes.js
  // getIngredientUomRatio) — check it first. The other collections below were never populated
  // by any writer we found; they are kept only as a defensive fallback for any legacy/manually
  // imported data that might use those key names, not as the primary schema.
  const uomConfigurations = Array.isArray(raw.uomConfigurations) ? raw.uomConfigurations : [];
  for (const entryValue of uomConfigurations) {
    const entry = objectValue(entryValue);
    const entryName = normalized(entry.customUom || entry.custom_uom);
    if (entryName !== requested) continue;
    const factor = numberValue(entry.ratio, 0);
    if (factor > 0) return factor;
    break;
  }
  const collections = [raw.uoms, raw.customUoms, raw.custom_uoms, raw.units, raw.alternateUoms, raw.alternate_uoms];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const entryValue of collection) {
      const entry = objectValue(entryValue);
      const entryName = normalized(entry.name || entry.unit || entry.uom || entry.label);
      if (entryName !== requested) continue;
      const factor = numberValue(entry.ratio ?? entry.qtyInBase ?? entry.qty_in_base ?? entry.factor ?? entry.baseQty ?? entry.packSize, 0);
      if (factor > 0) return factor;
      break;
    }
  }
  // Unspecified means "use the item's base unit" — which is exactly what the recipe editor already
  // shows the user for such a line. A genuinely named-but-unconfigured unit (e.g. "box" with no
  // ratio) stays a hard failure: silently deducting 1 base unit instead of 12 is the
  // under-deduction this null exists to prevent.
  return requested === UNSPECIFIED_LINE_UOM ? 1 : null;
}

async function locationUnitCost(env: Env, workspaceId: string, locationId: string, item: Row): Promise<number> {
  if (locationId) {
    const row = await env.DB.prepare(
      `SELECT price FROM stock_item_location_prices
        WHERE workspace_id = ?1 AND stock_item_id = ?2 AND location_id = ?3 LIMIT 1`
    ).bind(workspaceId, text(item.id), locationId).first<Row>();
    if (row && Number.isFinite(Number(row.price))) return Math.max(0, numberValue(row.price));
  }
  const raw = parseJson(item.raw_json);
  return Math.max(0, numberValue(item.unit_cost ?? raw.unitCost ?? raw.unit_cost ?? raw.costExVat ?? raw.cost_ex_vat, 0));
}

async function loadRecipe(env: Env, workspaceId: string, ownerType: string, ownerId: string): Promise<{ recipe: Row; lines: Row[] } | null> {
  const recipe = await env.DB.prepare(
    `SELECT * FROM recipes
      WHERE workspace_id = ?1 AND owner_type = ?2 AND owner_id = ?3 AND active = 1 LIMIT 1`
  ).bind(workspaceId, ownerType, ownerId).first<Row>();
  if (!recipe) return null;
  const lines = await env.DB.prepare(
    `SELECT line.*, item.name AS stock_item_name, item.category AS stock_category,
            item.item_type, item.unit AS base_unit,
            item.unit_cost, item.raw_json AS stock_item_raw_json, item.is_stocked
       FROM recipe_lines line
       JOIN stock_items item ON item.id = line.stock_item_id AND item.workspace_id = line.workspace_id
      WHERE line.workspace_id = ?1 AND line.recipe_id = ?2
      ORDER BY line.sort_order, line.id`
  ).bind(workspaceId, text(recipe.id)).all<Row>();
  return { recipe, lines: lines.results || [] };
}

function parseLinkedProductIds(value: unknown): string[] {
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return [...new Set(parsed.map((entry) => text(entry)).filter(Boolean))];
  } catch {}
  return [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

async function loadStockItem(env: Env, workspaceId: string, itemId: string): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT id, name, category, item_type, unit, unit_cost, raw_json, is_stocked
       FROM stock_items WHERE workspace_id = ?1 AND id = ?2 AND active = 1 LIMIT 1`
  ).bind(workspaceId, itemId).first<Row>();
}

function normalizeStockCategory(value: unknown): string {
  return text(value, 'General')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s*\(([^)]+)\)\s*-\s*Manufactured$/i, '$1')
    .trim() || 'General';
}

function routingKey(value: unknown): string {
  return normalizeStockCategory(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function routingValue(map: Row, key: string): unknown {
  const normalizedKey = routingKey(key);
  if (!normalizedKey) return undefined;
  const match = Object.entries(map).find(([candidate]) => routingKey(candidate) === normalizedKey);
  return match?.[1];
}

function routingLabelForCategory(category: string, settings: Row): string {
  const categoryMap = objectValue(
    settings.stockCategoryRoutingMap ||
    settings.stock_category_routing_map
  );
  const mapped = routingValue(categoryMap, category);
  const entry = objectValue(mapped);
  return text(
    entry.routingLabel ||
    entry.routing_label ||
    entry.label ||
    entry.name ||
    mapped,
    normalizeStockCategory(category)
  );
}

/**
 * Apply the stock-category routing configured on the location that originated
 * the sale. The source may be a POS selling location or the storage location
 * selected by the no-selling-location fallback. Any active selling or storage
 * location may be the destination. Unmapped categories, explicit Self routes,
 * and invalid/inactive destinations remain on the resolved source location.
 *
 * Routing is deliberately one hop. A destination's own routing map describes
 * sales originating at that destination; it must not silently reroute a sale
 * that originated somewhere else or create routing loops.
 */
async function applyStockCategoryRouting(
  env: Env,
  workspaceId: string,
  sourceLocationId: string,
  proposals: IngredientProposal[],
): Promise<IngredientProposal[]> {
  if (!sourceLocationId || !proposals.length) return proposals;
  const [locationRows, settingsRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, display_name, external_name, kind, active, is_default, stock_routing_json
         FROM locations
        WHERE workspace_id = ?1 AND active = 1`
    ).bind(workspaceId).all<Row>(),
    env.DB.prepare(
      `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`
    ).bind(workspaceId).first<Row>()
  ]);
  const locations = locationRows.results || [];
  const source = locations.find((location) => text(location.id) === sourceLocationId);
  if (!source) return proposals;

  const stockRouting = parseJson(source.stock_routing_json);
  if (!Object.keys(stockRouting).length) return proposals;
  const activeLocationIds = new Set(locations.map((location) => text(location.id)).filter(Boolean));
  const settings = parseJson(settingsRow?.raw_json);
  const itemCache = new Map<string, Promise<Row | null>>();
  const loadItem = (itemId: string) => {
    if (!itemCache.has(itemId)) itemCache.set(itemId, loadStockItem(env, workspaceId, itemId));
    return itemCache.get(itemId)!;
  };

  return Promise.all(proposals.map(async (proposal) => {
    if (proposal.warningCode || !proposal.ingredientItemId) return proposal;
    const category = normalizeStockCategory(proposal.stockCategory);
    const label = routingLabelForCategory(category, settings);
    const configuredTarget = text(
      routingValue(stockRouting, label) ??
      routingValue(stockRouting, category)
    );
    if (
      !configuredTarget ||
      normalized(configuredTarget) === 'self' ||
      configuredTarget === sourceLocationId ||
      !activeLocationIds.has(configuredTarget)
    ) return proposal;

    const item = await loadItem(proposal.ingredientItemId);
    return {
      ...proposal,
      locationId: configuredTarget,
      unitCost: item
        ? await locationUnitCost(env, workspaceId, configuredTarget, item)
        : proposal.unitCost
    };
  }));
}

async function loadBaselineModifierRule(
  env: Env,
  workspaceId: string,
  modifierId: string,
): Promise<Row | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT rule.id AS rule_id, version.version, version.snapshot_json
         FROM modifier_rules rule
         JOIN modifier_rule_versions version
           ON version.workspace_id = rule.workspace_id
          AND version.modifier_rule_id = rule.id
        WHERE rule.workspace_id = ?1 AND rule.modifier_owner_id = ?2
        ORDER BY version.version ASC
        LIMIT 1`,
    ).bind(workspaceId, modifierId).first<Row>();
    if (!row) return null;
    const snapshot = parseJson(row.snapshot_json);
    if (text(snapshot.actionType || snapshot.action_type).toUpperCase() !== 'ADD_RECIPE') return null;
    return {
      ...snapshot,
      id: text(row.rule_id),
      version: numberValue(row.version, 1),
      action_type: 'ADD_RECIPE',
      target_owner_type: text(snapshot.targetOwnerType || snapshot.target_owner_type),
      target_owner_id: text(snapshot.targetOwnerId || snapshot.target_owner_id),
      source_stock_item_id: text(snapshot.sourceStockItemId || snapshot.source_stock_item_id),
      replacement_stock_item_id: text(snapshot.replacementStockItemId || snapshot.replacement_stock_item_id),
      quantity: numberValue(snapshot.quantity, 1),
      unit: text(snapshot.unit, 'ea'),
      menu_item_scope_json: JSON.stringify(snapshot.menuItemIds || []),
      location_scope_json: JSON.stringify(snapshot.locationIds || []),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause ?? '');
    if (/no such table: modifier_rule/i.test(message)) return null;
    throw cause;
  }
}

async function directStockProposal(env: Env, input: {
  workspaceId: string;
  locationId?: string;
  sourceLineId: string;
  menuItemId?: string;
  modifierId?: string;
  stockItemId: string;
  quantity: number;
  unit?: string;
  rule?: Row | null;
  actionType?: string;
}): Promise<IngredientProposal> {
  const item = await loadStockItem(env, input.workspaceId, input.stockItemId);
  if (!item) {
    return {
      sourceLineId: input.sourceLineId,
      menuItemId: input.menuItemId,
      modifierId: input.modifierId,
      ingredientItemId: `unresolved-stock-item:${input.stockItemId}`,
      locationId: input.locationId,
      quantity: 0,
      baseUom: '',
      unitCost: 0,
      warningCode: 'MODIFIER_STOCK_ITEM_MISSING',
      resolutionStatus: 'WARNING'
    };
  }
  const requestedUnit = text(input.unit || item.unit);
  const factor = resolveCustomUomFactor(item, requestedUnit);
  if (factor === null) {
    return {
      sourceLineId: input.sourceLineId,
      menuItemId: input.menuItemId,
      modifierId: input.modifierId,
      ingredientItemId: text(item.id),
      locationId: input.locationId,
      quantity: 0,
      baseUom: text(item.unit, 'ea'),
      unitCost: 0,
      warningCode: 'MODIFIER_STOCK_UOM_INVALID',
      resolutionStatus: 'WARNING'
    };
  }
  const quantityBase = Math.abs(input.quantity) * factor;
  return {
    sourceLineId: input.sourceLineId,
    menuItemId: input.menuItemId,
    modifierId: input.modifierId,
    ingredientItemId: text(item.id),
    stockCategory: text(item.category, 'General'),
    locationId: input.locationId,
    quantity: -Math.abs(quantityBase),
    baseUom: text(item.unit, 'ea'),
    unitCost: await locationUnitCost(env, input.workspaceId, text(input.locationId), item),
    resolutionStatus: 'RESOLVED',
    ruleId: text(input.rule?.id) || undefined,
    ruleVersion: numberValue(input.rule?.version, 0) || undefined,
    actionType: text(input.actionType || input.rule?.action_type) || undefined,
    ruleSnapshot: input.rule || undefined
  };
}

async function explodeRecipe(env: Env, input: {
  workspaceId: string;
  locationId?: string;
  ownerType: string;
  ownerId: string;
  sourceLineId: string;
  menuItemId?: string;
  modifierId?: string;
  multiplier: number;
  stack?: Set<string>;
  rule?: Row | null;
  actionType?: string;
}): Promise<IngredientProposal[]> {
  const key = `${input.ownerType}:${input.ownerId}`;
  const stack = new Set(input.stack || []);
  if (stack.has(key)) {
    return [{
      sourceLineId: input.sourceLineId,
      menuItemId: input.menuItemId,
      modifierId: input.modifierId,
      ingredientItemId: `cycle:${input.ownerId}`,
      locationId: input.locationId,
      quantity: 0,
      baseUom: '',
      unitCost: 0,
      warningCode: 'RECIPE_CYCLE_DETECTED',
      resolutionStatus: 'WARNING'
    }];
  }
  stack.add(key);
  const loaded = await loadRecipe(env, input.workspaceId, input.ownerType, input.ownerId);
  if (!loaded) {
    return [{
      sourceLineId: input.sourceLineId,
      menuItemId: input.menuItemId,
      modifierId: input.modifierId,
      ingredientItemId: `unresolved:${input.ownerType}:${input.ownerId}`,
      locationId: input.locationId,
      quantity: 0,
      baseUom: '',
      unitCost: 0,
      warningCode: input.ownerType === 'yoco_modifier' ? 'MODIFIER_RECIPE_MISSING' : 'MENU_RECIPE_MISSING',
      resolutionStatus: 'WARNING'
    }];
  }
  if (input.ownerType === 'yoco_modifier') {
    const linkedProductIds = parseLinkedProductIds(loaded.recipe.linked_product_id);
    if (linkedProductIds.length) {
      const linkedOutput: IngredientProposal[] = [];
      for (const productId of linkedProductIds) {
        linkedOutput.push(...await explodeRecipe(env, {
          ...input,
          ownerType: 'product',
          ownerId: productId,
          stack
        }));
      }
      const resolvedLinked = linkedOutput.filter((proposal) => !proposal.warningCode);
      if (resolvedLinked.length) return linkedOutput;
    }
  }
  const yieldQty = Math.max(0.000001, numberValue(loaded.recipe.yield_qty, 1));
  const output: IngredientProposal[] = [];
  for (const line of loaded.lines) {
    const lineMultiplier = input.multiplier / yieldQty;
    const requestedQty = Math.abs(numberValue(line.quantity)) * lineMultiplier;
    const stockItem: Row = {
      id: line.stock_item_id,
      category: line.stock_category,
      item_type: line.item_type,
      unit: line.base_unit,
      unit_cost: line.unit_cost,
      raw_json: line.stock_item_raw_json,
      is_stocked: line.is_stocked
    };
    // A recipe line recorded in a custom UOM (e.g. "1 box" where 1 box = 12 base units) must
    // resolve a real ratio before it is used as a stock-deduction multiplier. Silently defaulting
    // to a factor of 1 here (as `customUomFactor` does) would deduct 1 base unit instead of 12
    // with no indication anything went wrong — surface it as a WARNING instead, matching how
    // `directStockProposal` already handles the identical lookup failure.
    const uomFactor = resolveCustomUomFactor(stockItem, text(line.unit));
    if (uomFactor === null) {
      output.push({
        sourceLineId: input.sourceLineId,
        menuItemId: input.menuItemId,
        modifierId: input.modifierId,
        ingredientItemId: text(line.stock_item_id),
        locationId: input.locationId,
        quantity: 0,
        baseUom: text(line.base_unit || stockItem.unit, 'ea'),
        unitCost: 0,
        warningCode: 'MODIFIER_STOCK_UOM_INVALID',
        resolutionStatus: 'WARNING'
      });
      continue;
    }
    const subRecipe = await loadRecipe(env, input.workspaceId, 'stock_item', text(line.stock_item_id));
    const isSubRecipe = ['subrecipe', 'subrecipeitem', 'prep'].includes(normalized(line.item_type)) || numberValue(line.is_stocked, 1) === 0;
    if (subRecipe && isSubRecipe) {
      output.push(...await explodeRecipe(env, {
        ...input,
        ownerType: 'stock_item',
        ownerId: text(line.stock_item_id),
        multiplier: requestedQty * uomFactor,
        stack
      }));
      continue;
    }
    const quantityBase = requestedQty * uomFactor;
    const unitCost = await locationUnitCost(env, input.workspaceId, text(input.locationId), stockItem);
    output.push({
      sourceLineId: input.sourceLineId,
      menuItemId: input.menuItemId,
      modifierId: input.modifierId,
      ingredientItemId: text(line.stock_item_id),
      stockCategory: text(line.stock_category, 'General'),
      locationId: input.locationId,
      quantity: -Math.abs(quantityBase),
      baseUom: text(line.base_unit || stockItem.unit, 'ea'),
      unitCost,
      resolutionStatus: 'RESOLVED',
      ruleId: text(input.rule?.id) || undefined,
      ruleVersion: numberValue(input.rule?.version, 0) || undefined,
      actionType: text(input.actionType || input.rule?.action_type) || undefined,
      ruleSnapshot: input.rule || undefined
    });
  }
  return output;
}

function aggregateProposals(proposals: IngredientProposal[]): IngredientProposal[] {
  const map = new Map<string, IngredientProposal>();
  for (const proposal of proposals) {
    const key = [proposal.sourceLineId, proposal.menuItemId || '', proposal.modifierId || '', proposal.ingredientItemId, proposal.locationId || '', proposal.warningCode || ''].join('|');
    const existing = map.get(key);
    if (existing && !proposal.warningCode) {
      existing.quantity += proposal.quantity;
      existing.unitCost = proposal.unitCost || existing.unitCost;
    } else map.set(key, { ...proposal });
  }
  return [...map.values()];
}

function comparisonRow(proposal: IngredientProposal): Row {
  return {
    ingredient_item_id: proposal.ingredientItemId,
    location_id: proposal.locationId || '',
    modifier_id: proposal.modifierId || '',
    quantity: proposal.quantity,
    unit_cost_ex_vat: proposal.unitCost,
    warning_code: proposal.warningCode || '',
    metadata_json: '{}',
  };
}

export async function buildSaleEffectProposals(env: Env, domainEvent: Row, canonical: CanonicalSaleCompletedEvent, rawEventId: string, processingRunId: string): Promise<Row[]> {
  const proposals: IngredientProposal[] = [];
  const baselineProposals: IngredientProposal[] = [];
  const domainEventId = text(domainEvent.id);
  const control = await getModifierEngineControl(env, canonical.workspace_id);
  const modifierMode = text(control.mode, 'LIVE').toUpperCase();
  const newEngineIsAuthoritative = modifierMode === 'LIVE';

  for (const line of canonical.lines) {
    if (!line.mapped_menu_item_id) {
      const unresolvedLine: IngredientProposal = {
        sourceLineId: line.source_line_id,
        ingredientItemId: `unresolved-line:${line.source_line_id}`,
        locationId: canonical.kcp_location_id,
        quantity: 0,
        baseUom: '',
        unitCost: 0,
        warningCode: 'ITEM_MAPPING_MISSING',
        resolutionStatus: 'WARNING'
      };
      proposals.push(unresolvedLine);
      baselineProposals.push({ ...unresolvedLine });
      continue;
    }

    const lineProposals = await explodeRecipe(env, {
      workspaceId: canonical.workspace_id,
      locationId: canonical.kcp_location_id,
      ownerType: 'product',
      ownerId: line.mapped_menu_item_id,
      sourceLineId: line.source_line_id,
      menuItemId: line.mapped_menu_item_id,
      multiplier: Math.abs(line.quantity)
    });
    const baseProposals = lineProposals.filter((proposal) => !proposal.modifierId).map((proposal) => ({ ...proposal }));
    const baselineBaseProposals = lineProposals.filter((proposal) => !proposal.modifierId).map((proposal) => ({ ...proposal }));
    const additiveProposals: IngredientProposal[] = [];
    const baselineAdditiveProposals: IngredientProposal[] = [];

    const applyStockAction = async (input: {
      sourceKind: 'MODIFIER' | 'NOTE';
      sourceKey: string;
      sourceName: string;
      proposalModifierId: string;
      rule: Row | null;
      actionType: string;
      multiplier: number;
      fallbackOwnerType?: string;
      fallbackOwnerId?: string;
    }) => {
      const actionType = text(input.actionType || input.rule?.action_type || 'ADD_RECIPE');
      if (newEngineIsAuthoritative) {
        await snapshotSaleAction(env, {
          workspaceId: canonical.workspace_id,
          domainEventId,
          sourceOrderId: canonical.source_order_id,
          sourceLineId: line.source_line_id,
          menuItemId: line.mapped_menu_item_id,
          sourceKind: input.sourceKind,
          sourceKey: input.sourceKey,
          sourceName: input.sourceName,
          rule: input.rule,
          actionType,
          originalLineQuantity: line.quantity,
          locationId: canonical.kcp_location_id
        });
      }

      if (actionType === 'NO_STOCK_CHANGE') return;

      if (actionType === 'REMOVE_INGREDIENT' || actionType === 'REPLACE_INGREDIENT') {
        const sourceStockItemId = text(input.rule?.source_stock_item_id);
        const matching = baseProposals.filter((proposal) => proposal.ingredientItemId === sourceStockItemId && !proposal.warningCode);
        if (!sourceStockItemId || !matching.length) {
          if (sourceStockItemId && numberValue(input.rule?.apply_all_matching_products, 0) === 1) {
            // Global modifier rules are applicable to several menu items. If a
            // particular sold item does not contain the selected source
            // ingredient, the correct result is no stock change for that rule.
            return;
          }
          additiveProposals.push({
            sourceLineId: line.source_line_id,
            menuItemId: line.mapped_menu_item_id,
            modifierId: input.proposalModifierId,
            ingredientItemId: sourceStockItemId || `unresolved-rule-source:${input.sourceKey}`,
            locationId: canonical.kcp_location_id,
            quantity: 0,
            baseUom: '',
            unitCost: 0,
            warningCode: 'MODIFIER_RULE_SOURCE_INGREDIENT_MISSING',
            resolutionStatus: 'WARNING',
            ruleId: text(input.rule?.id) || undefined,
            ruleVersion: numberValue(input.rule?.version, 0) || undefined,
            actionType,
            ruleSnapshot: input.rule || undefined
          });
          return;
        }
        const removedQuantity = matching.reduce((sum, proposal) => sum + Math.abs(proposal.quantity), 0);
        if (actionType === 'REPLACE_INGREDIENT') {
          const replacementId = text(input.rule?.replacement_stock_item_id);
          const replacement = await loadStockItem(env, canonical.workspace_id, replacementId);
          if (!replacement) {
            additiveProposals.push({
              sourceLineId: line.source_line_id,
              menuItemId: line.mapped_menu_item_id,
              modifierId: input.proposalModifierId,
              ingredientItemId: replacementId || `unresolved-replacement:${input.sourceKey}`,
              locationId: canonical.kcp_location_id,
              quantity: 0,
              baseUom: '',
              unitCost: 0,
              warningCode: 'MODIFIER_REPLACEMENT_ITEM_MISSING',
              resolutionStatus: 'WARNING',
              ruleId: text(input.rule?.id) || undefined,
              ruleVersion: numberValue(input.rule?.version, 0) || undefined,
              actionType,
              ruleSnapshot: input.rule || undefined
            });
            return;
          }
          for (let index = baseProposals.length - 1; index >= 0; index -= 1) {
            if (baseProposals[index].ingredientItemId === sourceStockItemId && !baseProposals[index].warningCode) baseProposals.splice(index, 1);
          }
          additiveProposals.push({
            sourceLineId: line.source_line_id,
            menuItemId: line.mapped_menu_item_id,
            modifierId: input.proposalModifierId,
            ingredientItemId: replacementId,
            stockCategory: text(replacement.category, 'General'),
            locationId: canonical.kcp_location_id,
            quantity: -Math.abs(removedQuantity * Math.abs(numberValue(input.rule?.quantity, 1))),
            baseUom: text(replacement.unit, 'ea'),
            unitCost: await locationUnitCost(env, canonical.workspace_id, canonical.kcp_location_id || '', replacement),
            resolutionStatus: 'RESOLVED',
            ruleId: text(input.rule?.id) || undefined,
            ruleVersion: numberValue(input.rule?.version, 0) || undefined,
            actionType,
            ruleSnapshot: input.rule || undefined
          });
          return;
        }
        for (let index = baseProposals.length - 1; index >= 0; index -= 1) {
          if (baseProposals[index].ingredientItemId === sourceStockItemId && !baseProposals[index].warningCode) baseProposals.splice(index, 1);
        }
        return;
      }

      if (actionType === 'ADD_STOCK_ITEM') {
        additiveProposals.push(await directStockProposal(env, {
          workspaceId: canonical.workspace_id,
          locationId: canonical.kcp_location_id,
          sourceLineId: line.source_line_id,
          menuItemId: line.mapped_menu_item_id,
          modifierId: input.proposalModifierId,
          stockItemId: text(input.rule?.target_owner_id),
          quantity: input.multiplier * Math.abs(numberValue(input.rule?.quantity, 1)),
          unit: text(input.rule?.unit),
          rule: input.rule,
          actionType
        }));
        return;
      }

      if (actionType === 'ADD_RECIPE') {
        additiveProposals.push(...await explodeRecipe(env, {
          workspaceId: canonical.workspace_id,
          locationId: canonical.kcp_location_id,
          ownerType: text(input.rule?.target_owner_type, input.fallbackOwnerType || 'yoco_modifier'),
          ownerId: text(input.rule?.target_owner_id, input.fallbackOwnerId || input.sourceKey),
          sourceLineId: line.source_line_id,
          menuItemId: line.mapped_menu_item_id,
          modifierId: input.proposalModifierId,
          multiplier: input.multiplier * Math.abs(numberValue(input.rule?.quantity, 1)),
          rule: input.rule,
          actionType
        }));
        return;
      }
    };

    for (const modifier of line.modifiers) {
      if (!modifier.mapped_modifier_id) {
        const unresolvedModifier: IngredientProposal = {
          sourceLineId: line.source_line_id,
          menuItemId: line.mapped_menu_item_id,
          ingredientItemId: `unresolved-modifier:${modifier.source_modifier_id}`,
          locationId: canonical.kcp_location_id,
          quantity: 0,
          baseUom: '',
          unitCost: 0,
          warningCode: 'MODIFIER_MAPPING_MISSING',
          resolutionStatus: 'WARNING'
        };
        additiveProposals.push(unresolvedModifier);
        baselineAdditiveProposals.push({ ...unresolvedModifier });
        continue;
      }

      const multiplier = Math.abs(line.quantity) * Math.abs(modifier.quantity || 1);
      const autoLinkedProductId = text(modifier.metadata?.auto_linked_product_id);
      const baselineRule = await loadBaselineModifierRule(
        env,
        canonical.workspace_id,
        modifier.mapped_modifier_id,
      );
      if (!newEngineIsAuthoritative) {
        await snapshotSaleAction(env, {
          workspaceId: canonical.workspace_id,
          domainEventId,
          sourceOrderId: canonical.source_order_id,
          sourceLineId: line.source_line_id,
          menuItemId: line.mapped_menu_item_id,
          sourceKind: 'MODIFIER',
          sourceKey: modifier.source_modifier_id || modifier.mapped_modifier_id,
          sourceName: modifier.source_name,
          rule: baselineRule,
          actionType: 'ADD_RECIPE',
          originalLineQuantity: line.quantity,
          locationId: canonical.kcp_location_id,
        });
      }
      baselineAdditiveProposals.push(...await explodeRecipe(env, {
        workspaceId: canonical.workspace_id,
        locationId: canonical.kcp_location_id,
        ownerType: autoLinkedProductId ? 'product' : 'yoco_modifier',
        ownerId: autoLinkedProductId || modifier.mapped_modifier_id,
        sourceLineId: line.source_line_id,
        menuItemId: line.mapped_menu_item_id,
        modifierId: modifier.mapped_modifier_id,
        multiplier,
        rule: baselineRule,
        actionType: 'ADD_RECIPE',
      }));

      const rule = await getApplicableModifierRule(
        env,
        canonical.workspace_id,
        modifier.mapped_modifier_id,
        line.mapped_menu_item_id,
        canonical.kcp_location_id || ''
      );
      const actionType = text(rule?.action_type || modifier.metadata?.modifier_action_type || 'ADD_RECIPE');
      await applyStockAction({
        sourceKind: 'MODIFIER',
        sourceKey: modifier.source_modifier_id || modifier.mapped_modifier_id,
        sourceName: modifier.source_name,
        proposalModifierId: modifier.mapped_modifier_id,
        rule,
        actionType,
        multiplier,
        fallbackOwnerType: autoLinkedProductId ? 'product' : 'yoco_modifier',
        fallbackOwnerId: autoLinkedProductId || modifier.mapped_modifier_id
      });
    }

    const normalizedNotes = Array.isArray(line.metadata?.normalized_note_texts)
      ? line.metadata.normalized_note_texts.map((value) => text(value)).filter(Boolean)
      : [];
    const noteRules = await getApplicableNoteRules(env, {
      workspaceId: canonical.workspace_id,
      normalizedNotes,
      menuItemId: line.mapped_menu_item_id,
      locationId: canonical.kcp_location_id
    });
    for (const noteRule of noteRules) {
      await applyStockAction({
        sourceKind: 'NOTE',
        sourceKey: text(noteRule.normalized_text),
        sourceName: text(noteRule.source_name),
        proposalModifierId: `note:${text(noteRule.id)}`,
        rule: noteRule,
        actionType: text(noteRule.action_type),
        multiplier: Math.abs(line.quantity)
      });
    }

    proposals.push(...baseProposals, ...additiveProposals);
    baselineProposals.push(...baselineBaseProposals, ...baselineAdditiveProposals);
  }

  const unroutedNew = aggregateProposals(proposals);
  const unroutedBaseline = aggregateProposals(baselineProposals);
  const routedProposals = await applyStockCategoryRouting(
    env,
    canonical.workspace_id,
    canonical.kcp_location_id || '',
    [...unroutedNew, ...unroutedBaseline]
  );
  const aggregatedNew = routedProposals.slice(0, unroutedNew.length);
  const aggregatedBaseline = routedProposals.slice(unroutedNew.length);
  const aggregated = newEngineIsAuthoritative ? aggregatedNew : aggregatedBaseline;
  const keys: string[] = [];
  const now = nowIso();
  for (const proposal of aggregated) {
    const proposalKey = [
      canonical.source_order_id,
      proposal.sourceLineId,
      proposal.menuItemId || '',
      proposal.modifierId || '',
      proposal.ingredientItemId,
      proposal.locationId || '',
      proposal.warningCode || 'movement'
    ].join('|');
    keys.push(proposalKey);
    await env.DB.prepare(
      `INSERT INTO yoco_v2_proposed_stock_movements
        (id, domain_event_id, workspace_id, location_id, source_order_id, source_line_id,
         menu_item_id, modifier_id, ingredient_item_id, movement_type, quantity, base_uom,
         unit_cost_ex_vat, movement_value, proposal_key, resolution_status, warning_code,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, NULLIF(?4, ''), ?5, ?6, NULLIF(?7, ''), NULLIF(?8, ''), ?9,
         'SALE_DEPLETION_PROPOSAL', ?10, ?11, ?12, ?13, ?14, ?15, NULLIF(?16, ''), ?17, ?17)
       ON CONFLICT(workspace_id, proposal_key) DO UPDATE SET
         domain_event_id = excluded.domain_event_id,
         location_id = excluded.location_id,
         quantity = excluded.quantity,
         base_uom = excluded.base_uom,
         unit_cost_ex_vat = excluded.unit_cost_ex_vat,
         movement_value = excluded.movement_value,
         resolution_status = excluded.resolution_status,
         warning_code = excluded.warning_code,
         updated_at = excluded.updated_at`
    ).bind(
      newId('yoco_v2_proposal'), domainEventId, canonical.workspace_id, proposal.locationId || '',
      canonical.source_order_id, proposal.sourceLineId, proposal.menuItemId || '', proposal.modifierId || '',
      proposal.ingredientItemId, proposal.quantity, proposal.baseUom, proposal.unitCost,
      proposal.quantity * proposal.unitCost, proposalKey, proposal.resolutionStatus, proposal.warningCode || '', now
    ).run();

    if (!proposal.warningCode && proposal.quantity < 0 && proposal.locationId && proposal.ingredientItemId) {
      const sourceLine = canonical.lines.find((line) => line.source_line_id === proposal.sourceLineId);
      await snapshotSaleMovement(env, {
        workspaceId: canonical.workspace_id,
        domainEventId,
        sourceOrderId: canonical.source_order_id,
        sourceLineId: proposal.sourceLineId,
        menuItemId: proposal.menuItemId,
        modifierId: proposal.modifierId,
        ingredientItemId: proposal.ingredientItemId,
        locationId: proposal.locationId,
        originalLineQuantity: sourceLine?.quantity || 1,
        movementQuantity: proposal.quantity,
        baseUom: proposal.baseUom,
        unitCost: proposal.unitCost,
        proposalKey,
        ruleId: proposal.ruleId,
        ruleVersion: proposal.ruleVersion,
        actionType: proposal.actionType,
        ruleSnapshot: proposal.ruleSnapshot
      });
    }
  }

  if (keys.length) {
    const placeholders = keys.map((_, index) => `?${index + 3}`).join(', ');
    await env.DB.prepare(
      `DELETE FROM yoco_v2_proposed_stock_movements
        WHERE workspace_id = ?1 AND domain_event_id = ?2 AND proposal_key NOT IN (${placeholders})`
    ).bind(canonical.workspace_id, domainEventId, ...keys).run();
  } else {
    await env.DB.prepare(`DELETE FROM yoco_v2_proposed_stock_movements WHERE workspace_id = ?1 AND domain_event_id = ?2`)
      .bind(canonical.workspace_id, domainEventId).run();
  }
  const stored = await env.DB.prepare(
    `SELECT * FROM yoco_v2_proposed_stock_movements WHERE domain_event_id = ?1 ORDER BY source_line_id, modifier_id, ingredient_item_id`
  ).bind(domainEventId).all<Row>();

  for (const line of canonical.lines) {
    await recordModifierEngineComparison(env, {
      workspaceId: canonical.workspace_id,
      domainEventId,
      sourceOrderId: canonical.source_order_id,
      sourceLineId: line.source_line_id,
      menuItemId: line.mapped_menu_item_id,
      oldRows: aggregatedBaseline
        .filter((row) => row.sourceLineId === line.source_line_id)
        .map(comparisonRow),
      newRows: aggregatedNew
        .filter((row) => row.sourceLineId === line.source_line_id)
        .map(comparisonRow),
    });
  }

  await appendTimeline(env.DB, {
    rawEventId,
    processingRunId,
    step: 'SALE_EFFECT_PROPOSALS_STORED',
    status: 'COMPLETED',
    message: `Stored ${stored.results.length} idempotent V2 effect proposal rows before controlled live application.`,
    metadata: {
      domain_event_id: domainEvent.id,
      modifier_engine_mode: modifierMode,
      authoritative_modifier_path: newEngineIsAuthoritative ? 'NEW_ENGINE' : 'EXISTING_BASELINE',
      movement_proposals: stored.results.filter((row) => numberValue(row.quantity) !== 0).length,
      warnings: stored.results.filter((row) => text(row.warning_code)).length
    }
  });
  return stored.results || [];
}
