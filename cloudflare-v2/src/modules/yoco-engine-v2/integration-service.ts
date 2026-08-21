import type { Env, DbLike, DbStatementLike } from '../../legacy/types';
// @ts-ignore Shared Yoco Money converter: Money objects are minor units; normalized scalars remain major units.
import { yocoMoneyToMajor } from '../../../../src/modules/reporting/engine/yocoFinancials.js';
import { decryptText, encryptText } from '../../legacy/crypto';
import {
  YocoApiError,
  isYocoRateLimitError,
  createWebhookSubscription,
  deleteWebhookSubscription,
  fetchModifierGroup,
  listModifierGroupChildren,
  listItemBrands,
  listItemCategories,
  listItems,
  listItemsForLocation,
  listLocations,
  listModifierGroups,
  listWebhookSubscriptions,
  testWebhookSubscription,
  validateYocoConnection
} from './catalog-client';
import { recordIntegrationLog, runLoggedIntegrationOperation } from '../../legacy/integration-log';
import { normalizeStandardWebhookSecret } from './webhook-signature';
import {
  assertAllYocoEffectsOwnedByV2,
  migrateYocoV2EffectOwnershipForConnection,
} from './ownership';

type Row = Record<string, unknown>;

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function nowIso() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + 2);
  return d.toISOString().replace('Z', '+02:00');
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function jsonString(value: unknown) {
  return JSON.stringify(value || {});
}

/**
 * Append-only audit trail for admin/system-triggered Yoco actions, surfaced in the Webhook
 * Health dashboard's "View Audit Trail" action. Failure to write this must never break the
 * caller's actual operation, so it's fire-and-forget with its own try/catch.
 */
async function recordYocoV2AdminAction(
  env: Env,
  workspaceId: string,
  integrationId: string,
  details: {
    action: string;
    targetType: string;
    targetId: string;
    status: 'completed' | 'failed';
    resultingState?: unknown;
    reason?: string;
  },
) {
  try {
    const actionId = id('yoco_v2_admin_action');
    const timestamp = nowIso();
    await env.DB.prepare(
      `INSERT INTO yoco_v2_admin_actions
        (id, workspace_id, integration_id, actor_uid, actor_email, action, target_type, target_id,
         idempotency_key, previous_state_json, resulting_state_json, reason, status, trace_id, created_at, completed_at)
       VALUES (?1, ?2, ?3, 'system', '', ?4, ?5, ?6, ?1, '{}', ?7, ?8, ?9, ?1, ?10, ?10)`,
    ).bind(
      actionId,
      workspaceId,
      integrationId,
      details.action,
      details.targetType,
      details.targetId,
      jsonString(details.resultingState),
      details.reason || '',
      details.status,
      timestamp,
    ).run();
  } catch {
    // Audit-trail write failure must never mask the underlying operation's own result.
  }
}

function jsonParse(value: unknown): Row {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
  try {
    const parsed = JSON.parse(text(value) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function runD1Batches(db: DbLike, statements: DbStatementLike[], size = 50) {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}

function moneyToMajor(value: unknown) {
  const amount = yocoMoneyToMajor(value, { scalarUnit: 'major', absolute: false });
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeName(row: Row, fallback = 'Yoco Item') {
  return text(row.name || row.display_name || row.displayName || row.title, fallback);
}

function yocoLocationId(location: Row) {
  return text(location.id || location.location_id || location.uuid || location.external_id);
}

function yocoCategoryId(category: Row) {
  return text(category.id || category.category_id || category.uuid);
}

function yocoBrandId(brand: Row) {
  return text(brand.id || brand.brand_id || brand.uuid);
}

function yocoModifierGroupId(group: Row) {
  return text(group.id || group.modifier_group_id || group.modifierGroupId || group.uuid);
}

function modifierGroupRefId(ref: unknown) {
  if (typeof ref === 'string' || typeof ref === 'number') return text(ref);
  const row = ref && typeof ref === 'object' && !Array.isArray(ref) ? ref as Row : {};
  return yocoModifierGroupId(row) ||
    text(row.modifier_group || row.modifierGroup || row.group_id || row.groupId || row.external_id);
}

function itemModifierGroupRefs(item: Row) {
  const refs: unknown[] = [];
  [
    item.modifier_groups,
    item.modifierGroups,
    item.modifier_group_ids,
    item.modifierGroupIds,
    item.modifier_group_assignments,
    item.modifierGroupAssignments,
    item.modifier_sets,
    item.modifierSets,
    item.assigned_modifier_groups,
    item.assignedModifierGroups
  ].forEach((value) => {
    refs.push(...collectionValues(value));
  });
  normalizeVariants(item).forEach((variant) => {
    [
      variant.modifier_groups,
      variant.modifierGroups,
      variant.modifier_group_ids,
      variant.modifierGroupIds,
      variant.modifier_group_assignments,
      variant.modifierGroupAssignments,
      variant.modifier_sets,
      variant.modifierSets,
      variant.assigned_modifier_groups,
      variant.assignedModifierGroups
    ].forEach((value) => {
      refs.push(...collectionValues(value));
    });
  });
  return refs;
}

const MODIFIER_COLLECTION_KEYS = [
  'modifiers', 'modifier_items', 'modifierItems', 'modifier_options', 'modifierOptions',
  'product_modifiers', 'productModifiers', 'linked_product_modifiers', 'linkedProductModifiers',
  'option_modifiers', 'optionModifiers', 'add_on_modifiers', 'addOnModifiers',
  'note_modifiers', 'noteModifiers', 'text_modifiers', 'textModifiers',
  'options', 'option_items', 'optionItems', 'option_values', 'optionValues',
  'choices', 'choice_items', 'choiceItems', 'values', 'items', 'entries',
  'modifier_group_items', 'modifierGroupItems', 'selections', 'selection_options', 'selectionOptions'
] as const;

function collectionValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value === undefined || value === null || text(value) === '' ? [] : [value];
  const row = value as Row;
  for (const key of [
    'data', 'items', 'results', 'modifiers', 'modifier_items', 'modifierItems',
    'modifier_options', 'modifierOptions', 'product_modifiers', 'productModifiers',
    'option_modifiers', 'optionModifiers', 'note_modifiers', 'noteModifiers',
    'options', 'choices', 'values', 'entries'
  ]) {
    if (Array.isArray(row[key])) return row[key] as unknown[];
  }
  const entries = Object.entries(row);
  if (!entries.length) return [];
  const looksLikeSingleModifier = Boolean(
    row.id || row.uuid || row.modifier_id || row.modifierId || row.name || row.display_name || row.title ||
    row.product_id || row.productId || row.variant_id || row.variantId || row.type || row.kind
  );
  if (looksLikeSingleModifier) return [row];
  return entries.map(([key, entry]) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const child = entry as Row;
      return { ...child, id: child.id || child.uuid || key, name: child.name || child.display_name || child.title || key };
    }
    return { id: key, name: text(entry, key), value: entry };
  });
}

function normalizedModifierType(modifier: Row) {
  if (modifier.is_note === true || modifier.isNote === true || modifier.free_text === true || modifier.freeText === true) return 'note';
  if (modifier.is_product_modifier === true || modifier.isProductModifier === true || modifier.linked_product === true || modifier.linkedProduct === true) return 'product';
  return text(
    modifier._kcp_modifier_kind || modifier.type || modifier.kind || modifier.modifier_type || modifier.modifierType ||
    modifier.input_type || modifier.inputType || modifier.selection_type || modifier.selectionType ||
    modifier.control_type || modifier.controlType || modifier.value_type || modifier.valueType ||
    modifier.source_type || modifier.sourceType
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isNoteModifierType(typeValue: unknown) {
  const type = text(typeValue).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return Boolean(type) && (
    type === 'note' || type === 'customer note' || type === 'free text' || type === 'freeform text' ||
    type === 'text' || type === 'text input' || type === 'open text' || type === 'note modifier' ||
    type.includes('note') || type.includes('free text') || type.includes('freeform')
  );
}

function isProductModifierType(typeValue: unknown) {
  const type = text(typeValue).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return Boolean(type) && (
    type === 'product' || type === 'linked product' || type === 'product modifier' ||
    type.includes('linked product') || type.includes('product modifier')
  );
}

function kindFromCollectionKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (normalized.includes('note') || normalized.includes('text')) return 'note';
  if (normalized.includes('product') || normalized.includes('linked product')) return 'product';
  if (normalized.includes('option') || normalized.includes('add on') || normalized.includes('choice') || normalized.includes('value')) return 'option';
  return '';
}

function normalizedModifierGroupType(group: Row) {
  if (group.is_note === true || group.isNote === true || group.free_text === true || group.freeText === true || group.allow_notes === true || group.allowNotes === true) return 'note';
  return normalizedModifierType({
    type: group.type || group.kind || group.modifier_type || group.modifierType ||
      group.input_type || group.inputType || group.selection_type || group.selectionType ||
      group.control_type || group.controlType || group.value_type || group.valueType
  });
}

function stableModifierSlug(value: unknown, fallback = 'modifier') {
  return text(value, fallback).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function canonicalModifierEntry(group: Row, entry: unknown, index: number, collectionKey = ''): Row | null {
  const outer = entry && typeof entry === 'object' && !Array.isArray(entry)
    ? entry as Row
    : { name: text(entry), value: entry };
  const nested = [outer.modifier, outer.option, outer.choice, outer.product_modifier, outer.productModifier, outer.note_modifier, outer.noteModifier]
    .find((value) => value && typeof value === 'object' && !Array.isArray(value)) as Row | undefined;
  const source: Row = nested ? { ...outer, ...nested } : outer;
  const groupId = yocoModifierGroupId(group);
  const groupType = normalizedModifierGroupType(group);
  const productReferenceId = modifierProductReferenceId(source);
  const explicitType = normalizedModifierType(source);
  const collectionType = kindFromCollectionKey(collectionKey);
  const kind = isNoteModifierType(explicitType) || collectionType === 'note'
    ? 'note'
    : isProductModifierType(explicitType) || collectionType === 'product' || productReferenceId
      ? 'product'
      : explicitType || collectionType || groupType || 'option';
  const name = text(
    source.name || source.display_name || source.displayName || source.title || source.label ||
    source.value_name || source.valueName || source.option_name || source.optionName || source.value ||
    source.note || source.note_text || source.noteText,
    isNoteModifierType(kind) ? normalizeName(group, 'Note') : `Option ${index + 1}`
  );
  const sourceId = text(
    source.modifier_id || source.modifierId || source.id || source.uuid || source.option_id || source.optionId ||
    source.value_id || source.valueId || source.choice_id || source.choiceId || source.note_id || source.noteId
  );
  const generatedId = sourceId || productReferenceId || `${groupId || 'group'}:${stableModifierSlug(kind, 'option')}:${stableModifierSlug(name, String(index + 1))}`;
  if (!generatedId && !name) return null;
  return {
    ...source,
    id: sourceId || generatedId,
    name,
    type: kind,
    _kcp_modifier_id: generatedId,
    _kcp_modifier_kind: isNoteModifierType(kind) ? 'note' : isProductModifierType(kind) || productReferenceId ? 'product' : 'option',
    _kcp_collection_key: collectionKey,
    _kcp_synthetic_id: sourceId ? false : true,
    _kcp_group_id: groupId
  };
}

function modifierGroupModifiers(group: Row) {
  const collected: Array<{ entry: unknown; key: string }> = [];
  const containers = [
    group,
    group.data && typeof group.data === 'object' && !Array.isArray(group.data) ? group.data as Row : {},
    group.result && typeof group.result === 'object' && !Array.isArray(group.result) ? group.result as Row : {},
    group.payload && typeof group.payload === 'object' && !Array.isArray(group.payload) ? group.payload as Row : {},
    group.attributes && typeof group.attributes === 'object' && !Array.isArray(group.attributes) ? group.attributes as Row : {},
    group.configuration && typeof group.configuration === 'object' && !Array.isArray(group.configuration) ? group.configuration as Row : {},
    group.config && typeof group.config === 'object' && !Array.isArray(group.config) ? group.config as Row : {},
    group.metadata && typeof group.metadata === 'object' && !Array.isArray(group.metadata) ? group.metadata as Row : {},
    group.modifier_group && typeof group.modifier_group === 'object' && !Array.isArray(group.modifier_group) ? group.modifier_group as Row : {},
    group.modifierGroup && typeof group.modifierGroup === 'object' && !Array.isArray(group.modifierGroup) ? group.modifierGroup as Row : {}
  ];
  for (const container of containers) {
    const keys = new Set<string>(MODIFIER_COLLECTION_KEYS);
    Object.entries(container).forEach(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      if ((Array.isArray(value) || (value && typeof value === 'object')) &&
          /(modifier|option|choice|selection|note|add.?on|linked.?product)/.test(normalizedKey) &&
          !/(count|total|limit|minimum|maximum|selected|selection.?type|modifier.?type|group)/.test(normalizedKey)) keys.add(key);
    });
    for (const key of keys) {
      collectionValues(container[key]).forEach((entry) => collected.push({ entry, key }));
    }
  }
  const normalized = collected
    .map(({ entry, key }, index) => canonicalModifierEntry(group, entry, index, key))
    .filter(Boolean) as Row[];
  const deduped = new Map<string, Row>();
  normalized.forEach((entry, index) => {
    const key = text(entry._kcp_modifier_id || entry.id || entry.uuid) || `${normalizedModifierType(entry)}:${stableModifierSlug(entry.name, String(index))}`;
    if (!deduped.has(key)) deduped.set(key, entry);
  });
  if (deduped.size) return [...deduped.values()];

  // Note/free-text groups can legitimately have no option array. Retain the group as a stable
  // catalogue modifier so it can be configured, while free-form order text still uses exact
  // approved note rules under Suggestions from orders.
  const groupType = normalizedModifierGroupType(group);
  if (isNoteModifierType(groupType)) {
    const groupId = yocoModifierGroupId(group);
    return [{
      id: `${groupId || stableModifierSlug(normalizeName(group, 'note'))}:note`,
      name: normalizeName(group, 'Note'),
      type: 'note',
      _kcp_modifier_id: `${groupId || stableModifierSlug(normalizeName(group, 'note'))}:note`,
      _kcp_modifier_kind: 'note',
      _kcp_note_source: true,
      _kcp_group_id: groupId
    }];
  }
  return [];
}

function isExpandedModifierGroup(ref: unknown) {
  const row = ref && typeof ref === 'object' && !Array.isArray(ref) ? ref as Row : {};
  return Boolean(yocoModifierGroupId(row) && modifierGroupModifiers(row).length);
}

function modifierProductReferenceId(modifier: Row) {
  const product = modifier.product && typeof modifier.product === 'object' && !Array.isArray(modifier.product) ? modifier.product as Row : {};
  const item = modifier.item && typeof modifier.item === 'object' && !Array.isArray(modifier.item) ? modifier.item as Row : {};
  const variant = modifier.variant && typeof modifier.variant === 'object' && !Array.isArray(modifier.variant) ? modifier.variant as Row : {};
  const productVariant = modifier.product_variant && typeof modifier.product_variant === 'object' && !Array.isArray(modifier.product_variant)
    ? modifier.product_variant as Row
    : modifier.productVariant && typeof modifier.productVariant === 'object' && !Array.isArray(modifier.productVariant) ? modifier.productVariant as Row : {};
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

function isProductLinkedModifier(modifier: Row) {
  const type = normalizedModifierType(modifier);
  return Boolean(modifierProductReferenceId(modifier)) && (!type || type.includes('product'));
}

function isNoteModifier(modifier: Row) {
  return isNoteModifierType(normalizedModifierType(modifier));
}

function isActionableModifier(modifier: Row) {
  return Boolean(
    modifierId(modifier) ||
    modifierProductReferenceId(modifier) ||
    text(modifier.name || modifier.display_name || modifier.displayName || modifier.title)
  );
}

function actionableModifierCount(group: Row) {
  return modifierGroupModifiers(group).filter(isActionableModifier).length;
}

function modifierTypeCounts(group: Row) {
  const counts = { product: 0, option: 0, note: 0 };
  modifierGroupModifiers(group).forEach((modifier) => {
    if (isNoteModifier(modifier)) counts.note += 1;
    else if (isProductLinkedModifier(modifier)) counts.product += 1;
    else counts.option += 1;
  });
  return counts;
}

function declaredModifierCount(group: Row) {
  const values = [
    group.modifier_count, group.modifierCount, group.option_count, group.optionCount,
    group.modifiers_count, group.modifiersCount, group.items_count, group.itemsCount,
    group.number_of_options, group.numberOfOptions,
    group.product_modifier_count, group.productModifierCount, group.option_modifier_count, group.optionModifierCount,
    group.note_modifier_count, group.noteModifierCount, group.add_on_modifier_count, group.addOnModifierCount
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0);
  return values.length ? Math.max(...values) : 0;
}

function productLinkedModifierGroup(group: Row) {
  const modifiers = modifierGroupModifiers(group).filter(isProductLinkedModifier);
  if (!modifiers.length) return null;
  return {
    ...group,
    modifiers,
    options: undefined,
    items: undefined
  };
}

function actionableModifierGroup(group: Row) {
  const modifiers = modifierGroupModifiers(group).filter(isActionableModifier);
  if (!modifiers.length) return null;
  return {
    ...group,
    modifiers,
    options: undefined,
    items: undefined
  };
}

export function productLinkedYocoModifierGroup(group: Row) {
  return productLinkedModifierGroup(group);
}

export function actionableYocoModifierGroup(group: Row) {
  return actionableModifierGroup(group);
}

function modifierId(modifier: Row) {
  return text(modifier._kcp_modifier_id || modifier.modifier_id || modifier.modifierId || modifier.id || modifier.uuid);
}

function modifierVariantId(modifier: Row) {
  return modifierProductReferenceId(modifier);
}

function modifierName(modifier: Row, fallback = 'Yoco Modifier') {
  return text(modifier.name || modifier.display_name || modifier.displayName || modifier.title || modifier.label || modifier.product_name || modifier.productName || modifier.value, fallback);
}

function modifierRecipeOwnerIdAliases(groupId: string, modifier: Row) {
  const currentModifierId = modifierId(modifier);
  const currentVariantId = modifierVariantId(modifier);
  const ownerIds = [
    groupId && currentModifierId ? `${groupId}:${currentModifierId}` : '',
    currentModifierId,
    currentVariantId ? `variant:${currentVariantId}` : '',
    modifierName(modifier).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  ].filter(Boolean);
  return [...new Set(ownerIds)];
}

function modifierRecipeOwnerIds(groups: Row[]) {
  const ownerIds = new Set<string>();
  groups.forEach((group) => {
    const groupId = yocoModifierGroupId(group);
    modifierGroupModifiers(group).filter(isActionableModifier).forEach((modifier) => {
      modifierRecipeOwnerIdAliases(groupId, modifier).forEach((ownerId) => {
        if (ownerId) ownerIds.add(ownerId);
      });
    });
  });
  return [...ownerIds];
}

function normalizeVariants(item: Row) {
  const variants = item.variants || item.item_variants || item.itemVariants;
  if (Array.isArray(variants) && variants.length) return variants as Row[];
  return [{
    id: item.default_variant_id || item.variant_id || item.id,
    name: '',
    price: item.price || item.default_price || item.amount,
    sku: item.sku || item.code || ''
  }];
}

function selectedOptionSummary(variant: Row) {
  const selectedOptions = variant.selected_options || variant.selectedOptions || variant.options;
  if (!Array.isArray(selectedOptions)) return '';
  return selectedOptions
    .map((entry) => {
      const option = entry && typeof entry === 'object' ? entry as Row : {};
      const name = text(option.name || option.option_name || option.optionName);
      const value = text(option.value || option.value_name || option.valueName || option.name);
      if (!value) return '';
      return name && name.toLowerCase() !== 'option' && name.toLowerCase() !== value.toLowerCase()
        ? `${name}: ${value}`
        : value;
    })
    .filter(Boolean)
    .join(' / ');
}

function selectedOptionValues(variant: Row) {
  const selectedOptions = variant.selected_options || variant.selectedOptions || variant.options;
  if (!Array.isArray(selectedOptions)) return [];
  return selectedOptions
    .map((entry) => {
      const option = entry && typeof entry === 'object' ? entry as Row : {};
      return text(option.value || option.value_name || option.valueName || option.name);
    })
    .filter(Boolean);
}

function variantLabel(item: Row, variant: Row) {
  const itemName = normalizeName(item);
  const optionSummary = selectedOptionSummary(variant);
  const variantText = text(variant.name || variant.display_name || variant.displayName || variant.option_name);
  if (optionSummary) return optionSummary;
  if (variantText && variantText.toLowerCase() !== itemName.toLowerCase()) return variantText;
  return '';
}

function variantName(item: Row, variant: Row) {
  const itemName = normalizeName(item);
  const optionValues = selectedOptionValues(variant);
  const variantText = text(variant.name || variant.display_name || variant.displayName || variant.option_name);
  const suffix = optionValues.length
    ? optionValues.join(' / ')
    : variantText && variantText.toLowerCase() !== itemName.toLowerCase()
      ? variantText
      : text(variant.sku || variant.code);
  if (!suffix || suffix.toLowerCase() === itemName.toLowerCase()) return itemName;
  if (suffix.toLowerCase().startsWith(`${itemName.toLowerCase()} - `)) return suffix;
  return `${itemName} - ${suffix}`;
}

function categoryForItem(item: Row, categoryMap: Map<string, Row>) {
  const embedded = item.category && typeof item.category === 'object' ? item.category as Row : null;
  const categoryId = text(item.category_id || item.categoryId || embedded?.id || embedded?.category_id);
  const category = embedded || categoryMap.get(categoryId) || null;
  return {
    id: categoryId,
    name: normalizeName(category || {}, text(item.category_name || item.categoryName || 'General', 'General'))
  };
}

function webhookBaseUrl(env: Env) {
  return text(env.YOCO_WEBHOOK_BASE_URL).replace(/\/$/, '');
}

function subscriptionId(subscription: Row) {
  return text(subscription.id || subscription.subscription_id || subscription.subscriptionId || subscription.webhook_id || subscription.webhookId);
}

/**
 * Read the signing secret from a Yoco webhook subscription, normalised to the Standard Webhooks
 * `whsec_<base64>` form the verifier requires.
 *
 * `verifyYocoV2WebhookSignature` fails closed on any secret without the `whsec_` prefix — it cannot
 * know how to decode it — and a stored secret is skipped entirely, so verification returns false for
 * every delivery. Yoco does not always include the prefix on the value it hands back, which left the
 * integration permanently reporting "signature cannot be verified". Add the prefix here, at the one
 * place secrets enter the system, rather than loosening the verifier: signature checking stays
 * fail-closed, which is the property worth keeping.
 */
function subscriptionSecret(subscription: Row) {
  return normalizeStandardWebhookSecret(
    subscription.secret || subscription.webhook_secret || subscription.webhookSecret || subscription.signing_secret || subscription.signingSecret,
  );
}

// Subscribe to both live sale signals documented by the Yoco Business API.
// payment.created is the earliest device-payment notification and order.completed
// is the final paid-order signal. Processing is idempotent by source order id, so
// receiving both cannot double-deduct stock. Order Updated is the important
// second-stage refund/return signal because returned_line_items can be attached
// shortly after payment.refunded. Do not subscribe to the Checkout-only
// refund.succeeded name on this API.
export const YOCO_WEBHOOK_EVENT_TYPES = [
  'payment.created',
  'order.completed',
  'order.updated',
  'payment.refunded',
] as const;
const WEBHOOK_PREVIOUS_SECRET_GRACE_MS = 24 * 60 * 60 * 1000;

type YocoSyncOptions = { full?: boolean; sinceIso?: string; resetWebhook?: boolean; refundOnly?: boolean };

function expectedWebhookUrl(env: Env, workspaceId: string) {
  const baseUrl = webhookBaseUrl(env);
  return baseUrl ? `${baseUrl}/webhooks/yoco/${encodeURIComponent(workspaceId)}` : '';
}

function webhookNeedsReset(connection: Row | null | undefined, expectedUrl: string) {
  if (!expectedUrl) return false;
  if (!text(connection?.webhook_id) || !text(connection?.webhook_secret)) return true;
  if (text(connection?.webhook_url) !== expectedUrl) return true;
  const lastError = text(connection?.last_error).toLowerCase();
  return /webhook|signature|stale|secret/.test(lastError);
}

async function createYocoWebhookWithFallback(env: Env, workspaceId: string, apiKey: string, webhookUrl: string) {
  const name = 'Kitchen Cost Pro Cloudflare Webhook';
  const attempts = [
    // Official Yoco API shape: notification_url + explicit event_types.
    { event_types: YOCO_WEBHOOK_EVENT_TYPES, name, notification_url: webhookUrl },
  ];
  let lastError: unknown = null;
  for (const body of attempts) {
    try {
      const response = await createWebhookSubscription(env, workspaceId, apiKey, body) as Row;
      const subscription = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
        ? response.data as Row
        : response;
      const idValue = subscriptionId(subscription);
      const secretValue = subscriptionSecret(subscription);
      if (!idValue || !secretValue) {
        throw new Error('Yoco webhook subscription response did not include both id and secret.');
      }
      return { subscription, body };
    } catch (caught) {
      lastError = caught;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Yoco webhook subscription failed.'));
}


function subscriptionEnabled(subscription: Row) {
  if (subscription.enabled === false || subscription.is_enabled === false || subscription.active === false) return false;
  const status = text(subscription.status || subscription.state).toLowerCase();
  return !['disabled', 'inactive', 'deleted', 'archived'].includes(status);
}

function subscriptionNotificationUrl(subscription: Row) {
  return text(subscription.notification_url || subscription.notificationUrl || subscription.url);
}

function subscriptionName(subscription: Row) {
  return text(subscription.name || subscription.display_name || subscription.displayName);
}

function subscriptionEventTypes(subscription: Row) {
  const value = subscription.event_types || subscription.eventTypes || subscription.events;
  if (!Array.isArray(value)) return [];
  return value.map((entry) => text(entry).toLowerCase()).filter(Boolean);
}

function webhookSubscriptionMatches(subscription: Row, webhookId: string, webhookUrl: string) {
  if (!subscription || subscriptionId(subscription) !== webhookId) return false;
  if (!subscriptionEnabled(subscription)) return false;
  if (subscriptionNotificationUrl(subscription) !== webhookUrl) return false;
  const eventTypes = subscriptionEventTypes(subscription);
  return YOCO_WEBHOOK_EVENT_TYPES.every((eventType) => eventTypes.includes(eventType));
}

async function inspectRemoteYocoWebhook(env: Env, workspaceId: string, apiKey: string, webhookId: string, webhookUrl: string) {
  const subscriptions = await listWebhookSubscriptions(env, workspaceId, apiKey) as Row[];
  const subscription = subscriptions.find((row) => subscriptionId(row) === webhookId) || null;
  return {
    subscriptions,
    subscription,
    healthy: Boolean(subscription && webhookSubscriptionMatches(subscription, webhookId, webhookUrl)),
    reason: !subscription
      ? 'stored_subscription_missing_remotely'
      : !subscriptionEnabled(subscription)
        ? 'subscription_disabled_remotely'
        : subscriptionNotificationUrl(subscription) !== webhookUrl
          ? 'notification_url_mismatch'
          : !YOCO_WEBHOOK_EVENT_TYPES.every((eventType) => subscriptionEventTypes(subscription).includes(eventType))
            ? 'event_types_mismatch'
            : ''
  };
}

function isKcpWebhookSubscription(subscription: Row, webhookId: string, webhookUrl: string) {
  const idValue = subscriptionId(subscription);
  const urlValue = subscriptionNotificationUrl(subscription);
  const nameValue = subscriptionName(subscription).toLowerCase();
  return Boolean(
    idValue
    && (
      (webhookId && idValue === webhookId)
      || (webhookUrl && urlValue === webhookUrl)
      || nameValue.includes('kitchen cost pro')
      || nameValue.includes('kcp')
    )
  );
}

async function deleteYocoWebhookSubscriptions(
  env: Env,
  workspaceId: string,
  apiKey: string,
  options: {
    webhookId?: string;
    webhookUrl?: string;
    subscriptions?: Row[];
    preserveIds?: string[];
    throwOnFailure?: boolean;
    paceMs?: number;
  } = {},
) {
  const subscriptions = Array.isArray(options.subscriptions)
    ? options.subscriptions
    : await listWebhookSubscriptions(env, workspaceId, apiKey) as Row[];
  const webhookId = text(options.webhookId);
  const webhookUrl = text(options.webhookUrl);
  const preserveIds = new Set((options.preserveIds || []).map((value) => text(value)).filter(Boolean));
  const candidates = subscriptions.filter((subscription) => {
    const idValue = subscriptionId(subscription);
    return isKcpWebhookSubscription(subscription, webhookId, webhookUrl) && !preserveIds.has(idValue);
  });
  const deleted: string[] = [];
  const failed: string[] = [];
  const failedIds: string[] = [];
  let rateLimitedCount = 0;
  let retryAfterMs = 0;
  const paceMs = Math.min(Math.max(Number(options.paceMs ?? 900) || 900, 250), 5_000);

  for (let index = 0; index < candidates.length; index += 1) {
    const subscription = candidates[index];
    const idValue = subscriptionId(subscription);
    try {
      await deleteWebhookSubscription(env, workspaceId, apiKey, idValue);
      deleted.push(idValue);
    } catch (caught) {
      if (caught instanceof YocoApiError && caught.status === 404) {
        deleted.push(idValue);
      } else {
        const message = caught instanceof Error ? caught.message : String(caught || 'Unknown delete error');
        failed.push(`${idValue}: ${message}`);
        failedIds.push(idValue);
        if (isYocoRateLimitError(caught)) {
          rateLimitedCount += 1;
          retryAfterMs = Math.max(retryAfterMs, caught.retryAfterMs || 0);
        }
      }
    }
    if (index < candidates.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, paceMs));
    }
  }

  if (failed.length && options.throwOnFailure === true) {
    throw new Error(`Could not delete ${failed.length} Yoco webhook subscription(s): ${failed.slice(0, 3).join('; ')}`);
  }
  return {
    deletedCount: deleted.length,
    deletedIds: deleted,
    failedCount: failed.length,
    failedIds,
    failures: failed,
    rateLimitedCount,
    retryAfterMs,
    cleanupPending: failed.length > 0,
    ignoredSubscriptionCount: Math.max(0, subscriptions.length - candidates.length),
  };
}

export async function getYocoConnection(env: Env, workspaceId: string) {
  return env.DB.prepare(
    `SELECT *
       FROM yoco_connections
      WHERE workspace_id = ?1
      LIMIT 1`
  ).bind(workspaceId).first<Row>();
}

export async function getYocoApiKey(env: Env, workspaceId: string) {
  const connection = await getYocoConnection(env, workspaceId);
  const encrypted = text(connection?.api_key_encrypted);
  if (!connection || !encrypted || connection.status === 'disconnected') {
    throw new Error('Yoco is not connected for this workspace.');
  }
  return decryptText(env, encrypted);
}

async function yocoApiKeyFingerprint(apiKey: string) {
  const bytes = new TextEncoder().encode(text(apiKey));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function connectYoco(
  env: Env,
  workspaceId: string,
  apiKey: string,
  options: { allowKeyReplacement?: boolean; actorUid?: string } = {},
) {
  const cleanKey = text(apiKey);
  if (!cleanKey) throw new Error('Yoco API key is required.');
  const fingerprint = await yocoApiKeyFingerprint(cleanKey);
  const existing = await getYocoConnection(env, workspaceId);
  const existingSalesCursor = text(existing?.last_successful_order_updated_at || existing?.last_sales_sync_at);
  const existingSalesBaseline = text(existing?.sales_baseline_at);
  const salesBaselineAt = existingSalesBaseline || existingSalesCursor || nowIso();
  const salesBaselineCreated = !existingSalesBaseline;
  const lockedFingerprint = text(existing?.api_key_fingerprint);
  if (lockedFingerprint && lockedFingerprint !== fingerprint && options.allowKeyReplacement !== true) {
    throw new Error('This workspace is locked to a different Yoco API key. A KCP administrator must replace the locked key.');
  }

  // Validate credentials before performing the explicit one-way V2 ownership cutover.
  // This prevents an invalid API key attempt from changing live effect ownership.
  await validateYocoConnection(env, workspaceId, cleanKey);
  const encrypted = await encryptText(env, cleanKey);

  const integrationId = `yoco:${workspaceId}`;
  const ownershipMigration = await migrateYocoV2EffectOwnershipForConnection(
    env.DB,
    workspaceId,
    integrationId,
    text(options.actorUid) || 'yoco-v2-connect',
  );
  await assertAllYocoEffectsOwnedByV2(env.DB, workspaceId);
  if (ownershipMigration.changedEffects.length) {
    await recordIntegrationLog(env, workspaceId, {
      operation: 'yoco.v2.ownership.cutover',
      status: 'success',
      message: ownershipMigration.ownershipMigrated
        ? 'Historic Yoco ownership rows were migrated to the V2-only engine during connection.'
        : 'Yoco V2 effect ownership was initialised during connection.',
      details: {
        integrationId,
        cutoverAt: ownershipMigration.cutoverAt,
        changedEffects: ownershipMigration.changedEffects,
        migratedEffects: ownershipMigration.migratedEffects,
        initializedEffects: ownershipMigration.initializedEffects,
        legacyRuntimeRestored: false,
      },
    });
  }

  const webhookUrl = expectedWebhookUrl(env, workspaceId);
  let webhookEnabled = false;
  let webhookId = '';
  let webhookSecret = '';
  let webhookError = '';
  let deletionResult = {
    deletedCount: 0,
    deletedIds: [] as string[],
    failedCount: 0,
    failedIds: [] as string[],
    failures: [] as string[],
    rateLimitedCount: 0,
    retryAfterMs: 0,
    cleanupPending: false,
    ignoredSubscriptionCount: 0,
  };
  let webhookReused = false;
  let webhookCleanupWarning = '';

  try {
    if (!webhookUrl) throw new Error('YOCO_WEBHOOK_BASE_URL is not configured.');
    const setup = await runLoggedIntegrationOperation(
      env,
      workspaceId,
      'yoco.connect.webhook',
      'Validate Yoco credentials and initialise the live webhook',
      async (correlationId) => {
        let subscriptions: Row[] = [];
        let discoveryError = '';
        try {
          subscriptions = await listWebhookSubscriptions(env, workspaceId, cleanKey) as Row[];
        } catch (caught) {
          discoveryError = caught instanceof Error ? caught.message : String(caught);
          await recordIntegrationLog(env, workspaceId, {
            operation: 'yoco.webhook.list_subscriptions',
            status: 'warning',
            message: 'Could not list existing Yoco subscriptions before connection. KCP will create the live subscription first and defer stale cleanup.',
            details: { error: discoveryError },
            correlationId,
          });
        }

        const storedWebhookId = text(existing?.webhook_id);
        const storedWebhookSecret = text(existing?.webhook_secret);
        const storedSubscription = subscriptions.find((row) => subscriptionId(row) === storedWebhookId) || null;
        if (
          storedSubscription
          && storedWebhookSecret
          && webhookSubscriptionMatches(storedSubscription, storedWebhookId, webhookUrl)
        ) {
          webhookReused = true;
          deletionResult = await deleteYocoWebhookSubscriptions(env, workspaceId, cleanKey, {
            subscriptions,
            webhookId: storedWebhookId,
            webhookUrl,
            preserveIds: [storedWebhookId],
            paceMs: 900,
          });
          webhookCleanupWarning = deletionResult.failedCount
            ? `${deletionResult.failedCount} stale Yoco webhook subscription(s) could not be deleted and remain active.`
            : '';
          if (deletionResult.failedCount) {
            await recordYocoV2AdminAction(env, workspaceId, integrationId, {
              action: 'webhook.duplicate_cleanup_failed',
              targetType: 'yoco_webhook_subscription',
              targetId: storedWebhookId,
              status: 'failed',
              resultingState: deletionResult,
            });
          }
          await recordIntegrationLog(env, workspaceId, {
            operation: 'yoco.webhook.reuse_subscription',
            status: deletionResult.failedCount ? 'warning' : 'success',
            message: deletionResult.failedCount
              ? `Reused the healthy live webhook. ${deletionResult.failedCount} duplicate subscription(s) could not be deleted (see admin actions) and remain active until the next reconcile sweep.`
              : 'Reused the healthy live webhook. No duplicate Yoco subscriptions were found.',
            details: deletionResult,
            correlationId,
          });
          return { webhookId: storedWebhookId, webhookSecret: storedWebhookSecret, webhookUrl };
        }

        // Create first so rate-limited cleanup can never leave the workspace without a live webhook.
        const { subscription } = await createYocoWebhookWithFallback(env, workspaceId, cleanKey, webhookUrl);
        const createdId = subscriptionId(subscription);
        const createdSecret = subscriptionSecret(subscription);
        if (!webhookSubscriptionMatches(subscription, createdId, webhookUrl)) {
          throw new Error('Yoco created a webhook but the returned subscription did not match the required live events and notification URL.');
        }

        if (!discoveryError) {
          deletionResult = await deleteYocoWebhookSubscriptions(env, workspaceId, cleanKey, {
            subscriptions,
            webhookId: storedWebhookId,
            webhookUrl,
            preserveIds: [createdId],
            paceMs: 900,
          });
          webhookCleanupWarning = deletionResult.failedCount
            ? `${deletionResult.failedCount} stale Yoco webhook subscription(s) could not be deleted and remain active.`
            : '';
          if (deletionResult.failedCount) {
            await recordYocoV2AdminAction(env, workspaceId, integrationId, {
              action: 'webhook.duplicate_cleanup_failed',
              targetType: 'yoco_webhook_subscription',
              targetId: createdId,
              status: 'failed',
              resultingState: deletionResult,
            });
          }
          await recordIntegrationLog(env, workspaceId, {
            operation: 'yoco.webhook.cleanup_scheduled',
            status: deletionResult.failedCount ? 'warning' : 'success',
            message: deletionResult.failedCount
              ? `The new live webhook is ready. ${deletionResult.failedCount} stale subscription(s) could not be deleted (see admin actions) and remain active until the next reconcile sweep.`
              : 'The new live webhook is ready. No stale Yoco subscriptions were found.',
            details: deletionResult,
            correlationId,
          });
        } else {
          webhookCleanupWarning = 'Existing Yoco subscription cleanup was deferred because the subscription list could not be retrieved.';
        }

        return { webhookId: createdId, webhookSecret: createdSecret, webhookUrl };
      },
      { webhookUrl, eventTypes: YOCO_WEBHOOK_EVENT_TYPES, createBeforeCleanup: true },
    );
    webhookEnabled = true;
    webhookId = setup.webhookId;
    webhookSecret = setup.webhookSecret;
  } catch (caught) {
    webhookError = caught instanceof Error ? caught.message : String(caught);
  }

  await env.DB.prepare(
    `INSERT INTO yoco_connections
      (workspace_id, status, api_key_encrypted, webhook_id, webhook_secret, webhook_url,
       connection_active, last_error, api_key_fingerprint, api_key_locked_at, api_key_locked_by_uid,
       last_sales_sync_at, last_successful_order_updated_at, last_successful_refund_updated_at, sales_baseline_at,
       created_at, updated_at)
     VALUES (?1, ?10, ?2, ?3, ?4, ?5, 1, ?6, ?7, datetime('now'), ?8, ?11, ?11, ?11, ?11, datetime('now'), datetime('now'))
     ON CONFLICT(workspace_id) DO UPDATE SET
       status = ?10,
       api_key_encrypted = excluded.api_key_encrypted,
       api_key_fingerprint = CASE
         WHEN ?9 = 1 OR COALESCE(yoco_connections.api_key_fingerprint, '') = '' THEN excluded.api_key_fingerprint
         ELSE yoco_connections.api_key_fingerprint
       END,
       api_key_locked_at = CASE
         WHEN ?9 = 1 OR COALESCE(yoco_connections.api_key_fingerprint, '') = '' THEN excluded.api_key_locked_at
         ELSE yoco_connections.api_key_locked_at
       END,
       api_key_locked_by_uid = CASE
         WHEN ?9 = 1 OR COALESCE(yoco_connections.api_key_fingerprint, '') = '' THEN excluded.api_key_locked_by_uid
         ELSE yoco_connections.api_key_locked_by_uid
       END,
       webhook_id = excluded.webhook_id,
       webhook_secret = excluded.webhook_secret,
       webhook_url = excluded.webhook_url,
       webhook_previous_id = NULL,
       webhook_previous_secret = NULL,
       webhook_previous_until = NULL,
       connection_active = 1,
       last_sales_sync_at = CASE
         WHEN COALESCE(yoco_connections.last_sales_sync_at, '') = '' THEN excluded.last_sales_sync_at
         ELSE yoco_connections.last_sales_sync_at
       END,
       last_successful_order_updated_at = CASE
         WHEN COALESCE(yoco_connections.last_successful_order_updated_at, '') = '' THEN excluded.last_successful_order_updated_at
         ELSE yoco_connections.last_successful_order_updated_at
       END,
       last_successful_refund_updated_at = CASE
         WHEN COALESCE(yoco_connections.last_successful_refund_updated_at, '') = '' THEN excluded.last_successful_refund_updated_at
         ELSE yoco_connections.last_successful_refund_updated_at
       END,
       sales_baseline_at = CASE
         WHEN COALESCE(yoco_connections.sales_baseline_at, '') = '' THEN excluded.sales_baseline_at
         ELSE yoco_connections.sales_baseline_at
       END,
       last_error = excluded.last_error,
       disconnected_at = NULL,
       updated_at = datetime('now')`,
  ).bind(
    workspaceId,
    encrypted,
    webhookId || null,
    webhookSecret || null,
    webhookUrl || null,
    webhookError,
    fingerprint,
    text(options.actorUid) || null,
    options.allowKeyReplacement === true ? 1 : 0,
    webhookEnabled ? 'connected' : 'error',
    salesBaselineAt,
  ).run();

  if (salesBaselineCreated) {
    await recordIntegrationLog(env, workspaceId, {
      operation: 'yoco.sales.baseline',
      status: 'success',
      message: 'Initial Yoco connection baseline created. Historical orders were not imported or deducted.',
      details: { salesBaselineAt, historicalSalesImported: false },
    });
  }

  if (!webhookEnabled) {
    throw new Error(`Yoco credentials were saved, but the live webhook could not be initialised: ${webhookError}`);
  }

  return {
    connected: true,
    webhookEnabled,
    webhookId,
    webhookUrl,
    webhookError: '',
    deletedSubscriptionCount: deletionResult.deletedCount,
    deletedSubscriptionIds: deletionResult.deletedIds,
    deferredSubscriptionCleanupCount: deletionResult.failedCount,
    webhookCleanupPending: deletionResult.cleanupPending,
    webhookCleanupWarning,
    webhookReused,
    remoteVerified: true,
    salesBaselineAt,
    historicalSalesImported: false,
    ownershipCutoverAt: ownershipMigration.cutoverAt,
    ownershipMigrated: ownershipMigration.ownershipMigrated,
    ownershipChangedEffects: ownershipMigration.changedEffects,
  };
}

export async function resetYocoWebhook(env: Env, workspaceId: string, apiKeyOverride = '') {
  const connection = await getYocoConnection(env, workspaceId);
  const apiKey = text(apiKeyOverride) || await getYocoApiKey(env, workspaceId);
  const webhookUrl = expectedWebhookUrl(env, workspaceId);
  if (!webhookUrl) throw new Error('YOCO_WEBHOOK_BASE_URL is not configured.');
  const previousWebhookId = text(connection?.webhook_id);
  const previousWebhookSecret = text(connection?.webhook_secret);

  try {
    return await runLoggedIntegrationOperation(
      env,
      workspaceId,
      'yoco.webhook.reset',
      'Create a fresh live Yoco subscription before cleaning up stale subscriptions',
      async (correlationId) => {
        let subscriptions: Row[] = [];
        let discoveryError = '';
        try {
          subscriptions = await listWebhookSubscriptions(env, workspaceId, apiKey) as Row[];
        } catch (caught) {
          discoveryError = caught instanceof Error ? caught.message : String(caught);
          await recordIntegrationLog(env, workspaceId, {
            operation: 'yoco.webhook.list_subscriptions',
            status: 'warning',
            message: 'Yoco subscription discovery was rate limited. KCP will create the replacement webhook first and defer stale cleanup.',
            details: { error: discoveryError },
            correlationId,
          });
        }

        // Never delete the currently working webhook before the replacement and its secret exist.
        const { subscription } = await createYocoWebhookWithFallback(env, workspaceId, apiKey, webhookUrl);
        const webhookId = subscriptionId(subscription);
        const webhookSecret = subscriptionSecret(subscription);
        if (!webhookSubscriptionMatches(subscription, webhookId, webhookUrl)) {
          throw new Error('Fresh Yoco webhook did not match the required live events and notification URL.');
        }

        const previousUntil = previousWebhookSecret
          ? new Date(Date.now() + WEBHOOK_PREVIOUS_SECRET_GRACE_MS).toISOString()
          : null;
        await env.DB.prepare(
          `UPDATE yoco_connections
              SET webhook_id = ?2,
                  webhook_secret = ?3,
                  webhook_url = ?4,
                  webhook_previous_id = ?5,
                  webhook_previous_secret = ?6,
                  webhook_previous_until = ?7,
                  connection_active = 1,
                  status = 'connected',
                  last_error = '',
                  updated_at = datetime('now')
            WHERE workspace_id = ?1`,
        ).bind(
          workspaceId,
          webhookId,
          webhookSecret,
          webhookUrl,
          previousWebhookId || null,
          previousWebhookSecret || null,
          previousUntil,
        ).run();

        let deletionResult = {
          deletedCount: 0,
          deletedIds: [] as string[],
          failedCount: 0,
          failedIds: [] as string[],
          failures: [] as string[],
          rateLimitedCount: 0,
          retryAfterMs: 0,
          cleanupPending: Boolean(discoveryError),
          ignoredSubscriptionCount: 0,
        };
        if (!discoveryError) {
          deletionResult = await deleteYocoWebhookSubscriptions(env, workspaceId, apiKey, {
            subscriptions,
            webhookId: previousWebhookId,
            webhookUrl,
            preserveIds: [webhookId],
            paceMs: 900,
          });
          if (deletionResult.failedCount) {
            await recordYocoV2AdminAction(env, workspaceId, `yoco:${workspaceId}`, {
              action: 'webhook.duplicate_cleanup_failed',
              targetType: 'yoco_webhook_subscription',
              targetId: webhookId,
              status: 'failed',
              resultingState: deletionResult,
            });
          }
          await recordIntegrationLog(env, workspaceId, {
            operation: 'yoco.webhook.cleanup_scheduled',
            status: deletionResult.failedCount ? 'warning' : 'success',
            message: deletionResult.failedCount
              ? `Replacement webhook is live. ${deletionResult.failedCount} stale subscription(s) could not be deleted (see admin actions) and remain active until the next reconcile sweep.`
              : 'Replacement webhook is live. No stale Yoco subscriptions were found.',
            details: deletionResult,
            correlationId,
          });
        }

        return {
          webhookEnabled: true,
          webhookId,
          webhookUrl,
          replacedWebhookId: previousWebhookId,
          deletedSubscriptionCount: deletionResult.deletedCount,
          deletedSubscriptionIds: deletionResult.deletedIds,
          deferredSubscriptionCleanupCount: deletionResult.failedCount,
          webhookCleanupPending: deletionResult.cleanupPending,
          webhookCleanupWarning: discoveryError
            ? 'Existing Yoco subscription cleanup was deferred because the subscription list was rate limited.'
            : deletionResult.failedCount
              ? `${deletionResult.failedCount} stale Yoco webhook subscription(s) are scheduled for automatic cleanup.`
              : '',
          remoteVerified: true,
          eventTypes: YOCO_WEBHOOK_EVENT_TYPES,
          createBeforeCleanup: true,
        };
      },
      { webhookUrl, previousWebhookId, eventTypes: YOCO_WEBHOOK_EVENT_TYPES, createBeforeCleanup: true },
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await env.DB.prepare(
      `UPDATE yoco_connections
          SET status = CASE
                WHEN COALESCE(webhook_id, '') <> '' AND COALESCE(webhook_secret, '') <> '' THEN 'connected'
                ELSE 'error'
              END,
              connection_active = 1,
              last_error = ?2,
              updated_at = datetime('now')
        WHERE workspace_id = ?1`,
    ).bind(workspaceId, message).run();
    throw caught;
  }
}

export async function ensureYocoWebhook(env: Env, workspaceId: string, apiKeyOverride = '') {
  const connection = await getYocoConnection(env, workspaceId);
  const apiKey = text(apiKeyOverride) || await getYocoApiKey(env, workspaceId);
  const webhookUrl = expectedWebhookUrl(env, workspaceId);
  if (!webhookUrl) throw new Error('YOCO_WEBHOOK_BASE_URL is not configured.');
  const webhookId = text(connection?.webhook_id);
  if (webhookNeedsReset(connection, webhookUrl)) {
    await recordIntegrationLog(env, workspaceId, {
      operation: 'yoco.webhook.health_check',
      status: 'warning',
      message: 'Local webhook state requires a reset.',
      details: { webhookId, webhookUrl, lastError: text(connection?.last_error) },
    });
    return resetYocoWebhook(env, workspaceId, apiKey);
  }

  const remote = await inspectRemoteYocoWebhook(env, workspaceId, apiKey, webhookId, webhookUrl);
  if (!remote.healthy) {
    await recordIntegrationLog(env, workspaceId, {
      operation: 'yoco.webhook.health_check',
      status: 'warning',
      message: `Remote Yoco webhook is unhealthy: ${remote.reason}.`,
      details: { webhookId, webhookUrl, reason: remote.reason, remoteSubscriptionCount: remote.subscriptions.length },
    });
    return resetYocoWebhook(env, workspaceId, apiKey);
  }

  await recordIntegrationLog(env, workspaceId, {
    operation: 'yoco.webhook.health_check',
    status: 'success',
    message: 'Stored Yoco webhook is enabled and matches the live endpoint.',
    details: { webhookId, webhookUrl, eventTypes: subscriptionEventTypes(remote.subscription || {}) },
  });
  return {
    webhookEnabled: true,
    webhookId,
    webhookUrl,
    replacedWebhookId: '',
    remoteVerified: true,
    eventTypes: YOCO_WEBHOOK_EVENT_TYPES,
  };
}


export async function testYocoWebhook(env: Env, workspaceId: string) {
  const apiKey = await getYocoApiKey(env, workspaceId);
  const health = await ensureYocoWebhook(env, workspaceId, apiKey);
  return runLoggedIntegrationOperation(
    env,
    workspaceId,
    'yoco.webhook.test',
    'Dispatch a Yoco order.completed test webhook',
    async () => {
      const response = await testWebhookSubscription(env, workspaceId, apiKey, health.webhookId, 'order.completed') as Row;
      return {
        webhookId: health.webhookId,
        messageId: text(response.message_id || response.messageId || response.id),
        response,
      };
    },
    { webhookId: health.webhookId, eventType: 'order.completed' },
  );
}

async function prepareYocoWebhookForSync(
  env: Env,
  workspaceId: string,
  apiKey: string,
  resetWebhook: boolean,
) {
  if (resetWebhook) return resetYocoWebhook(env, workspaceId, apiKey);
  try {
    return await ensureYocoWebhook(env, workspaceId, apiKey);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await env.DB.prepare(
      `UPDATE yoco_connections
          SET last_error = ?2,
              status = 'error',
              updated_at = datetime('now')
        WHERE workspace_id = ?1`,
    ).bind(workspaceId, message).run();
    await recordIntegrationLog(env, workspaceId, {
      operation: 'yoco.webhook.health_check',
      status: 'failed',
      message,
      details: { syncContinuedForRecovery: true },
    });
    return {
      webhookEnabled: false,
      webhookId: '',
      webhookUrl: expectedWebhookUrl(env, workspaceId),
      remoteVerified: false,
      error: message,
    };
  }
}

/** Read-only remote subscription count for the Workspace Health dashboard — never mutates anything. */
export async function countActiveYocoWebhookSubscriptions(env: Env, workspaceId: string): Promise<{ count: number; error?: string }> {
  const connection = await getYocoConnection(env, workspaceId);
  const encrypted = text(connection?.api_key_encrypted);
  if (!encrypted) return { count: 0 };
  try {
    const apiKey = await decryptText(env, encrypted);
    const webhookId = text(connection?.webhook_id);
    const webhookUrl = text(connection?.webhook_url) || expectedWebhookUrl(env, workspaceId);
    const subscriptions = await listWebhookSubscriptions(env, workspaceId, apiKey) as Row[];
    const count = subscriptions.filter((subscription) => isKcpWebhookSubscription(subscription, webhookId, webhookUrl)).length;
    return { count };
  } catch (caught) {
    return { count: 0, error: caught instanceof Error ? caught.message : String(caught) };
  }
}

/**
 * Defense-in-depth backstop for the "exactly 1 active subscription" invariant. connect/reset
 * already delete stale subscriptions inline, but a delete can be rate-limited and never retried
 * within that request. This re-lists remote subscriptions and, if more than one KCP-tagged
 * subscription exists, deletes every one except the currently stored/healthy webhook_id.
 *
 * Not yet wired to a cron — crons are deliberately disabled account-wide pending the unrelated
 * fixes CRON_BACKUP_RESTORE.md requires first. Callable on demand (admin route) until then.
 */
export async function reconcileYocoWebhookSubscription(env: Env, workspaceId: string) {
  const connection = await getYocoConnection(env, workspaceId);
  const encrypted = text(connection?.api_key_encrypted);
  if (!connection || !encrypted || connection.status === 'disconnected') {
    return { ok: true, skipped: true, reason: 'not_connected', extraSubscriptionsFound: 0 };
  }

  const apiKey = await decryptText(env, encrypted);
  const webhookUrl = text(connection.webhook_url) || expectedWebhookUrl(env, workspaceId);
  const storedWebhookId = text(connection.webhook_id);

  const subscriptions = await listWebhookSubscriptions(env, workspaceId, apiKey) as Row[];
  const kcpSubscriptions = subscriptions.filter((subscription) => isKcpWebhookSubscription(subscription, storedWebhookId, webhookUrl));
  if (kcpSubscriptions.length <= 1) {
    return { ok: true, skipped: false, extraSubscriptionsFound: 0 };
  }

  const preserveId = kcpSubscriptions.some((subscription) => subscriptionId(subscription) === storedWebhookId)
    ? storedWebhookId
    : subscriptionId(kcpSubscriptions[0]);
  const result = await deleteYocoWebhookSubscriptions(env, workspaceId, apiKey, {
    subscriptions,
    webhookId: preserveId,
    webhookUrl,
    preserveIds: [preserveId],
    paceMs: 900,
  });

  await recordYocoV2AdminAction(env, workspaceId, `yoco:${workspaceId}`, {
    action: result.failedCount ? 'webhook.reconcile_sweep_partial' : 'webhook.reconcile_sweep_cleaned',
    targetType: 'yoco_workspace',
    targetId: workspaceId,
    status: result.failedCount ? 'failed' : 'completed',
    resultingState: result,
  });

  return { ok: true, skipped: false, extraSubscriptionsFound: kcpSubscriptions.length - 1, ...result };
}

export async function disconnectYoco(env: Env, workspaceId: string) {
  const connection = await getYocoConnection(env, workspaceId);
  const encrypted = text(connection?.api_key_encrypted);
  const webhookId = text(connection?.webhook_id);
  let disconnectError = '';
  let cleanupPending = false;
  let deletedSubscriptionCount = 0;
  if (encrypted) {
    try {
      const apiKey = await decryptText(env, encrypted);
      const deletionResult = await deleteYocoWebhookSubscriptions(env, workspaceId, apiKey, {
        webhookId,
        webhookUrl: text(connection?.webhook_url) || expectedWebhookUrl(env, workspaceId),
      });
      deletedSubscriptionCount = deletionResult.deletedCount;
      cleanupPending = deletionResult.failedCount > 0;
      disconnectError = cleanupPending
        ? `Disconnected locally. ${deletionResult.failedCount} remote Yoco webhook subscription cleanup attempt(s) were rate limited and may remain active temporarily.`
        : '';
    } catch (caught) {
      disconnectError = caught instanceof Error ? caught.message : String(caught);
      cleanupPending = true;
    }
  }

  await env.DB.prepare(
    `UPDATE yoco_connections
        SET status = 'disconnected',
            connection_active = 0,
            api_key_encrypted = NULL,
            webhook_id = NULL,
            webhook_secret = NULL,
            webhook_url = NULL,
            webhook_previous_id = NULL,
            webhook_previous_secret = NULL,
            webhook_previous_until = NULL,
            last_error = ?3,
            disconnected_at = ?2,
            updated_at = ?2
      WHERE workspace_id = ?1`
  ).bind(workspaceId, nowIso(), disconnectError).run();
  return {
    disconnected: true,
    webhookDisabled: !cleanupPending,
    cleanupPending,
    deletedSubscriptionCount,
    disconnectError,
  };
}

export async function syncYocoCatalogue(env: Env, workspaceId: string, options: YocoSyncOptions = {}) {
  const apiKey = await getYocoApiKey(env, workspaceId);
  const webhook = await prepareYocoWebhookForSync(env, workspaceId, apiKey, options.resetWebhook === true);
  const [locations, categories, brands, items] = await Promise.all([
    listLocations(env, workspaceId, apiKey),
    listItemCategories(env, workspaceId, apiKey).catch(() => []),
    listItemBrands(env, workspaceId, apiKey).catch(() => []),
    listItems(env, workspaceId, apiKey)
  ]);
  const modifierCatalogue = await fetchCompleteYocoModifierCatalogue(env, workspaceId, apiKey, items as Row[])
    .catch((caught) => ({
      groups: [] as Row[],
      complete: false,
      warnings: [{ message: `Yoco modifiers could not be synchronized. ${text((caught as Error)?.message)}`.trim() }],
      counts: { product: 0, option: 0, note: 0, total: 0 },
    }));
  const modifierGroups = modifierCatalogue.groups;

  const categoryMap = new Map<string, Row>();
  const modifierGroupIdsByItemId = buildItemModifierGroupIdMap(items as Row[]);
  const assignedModifierGroupIds = (modifierGroups as Row[]).map(yocoModifierGroupId).filter(Boolean);
  const [existingLocationRows, existingProductRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, external_location_id, name, active
         FROM locations
        WHERE workspace_id = ?1
          AND external_provider = 'yoco'`
    ).bind(workspaceId).all<{ id: string; external_location_id: string; name: string; active: number }>(),
    env.DB.prepare(
      `SELECT id, yoco_item_id, yoco_variant_id, active, raw_json
         FROM products
        WHERE workspace_id = ?1
          AND external_provider = 'yoco'`
    ).bind(workspaceId).all<{ id: string; yoco_item_id: string; yoco_variant_id: string; active: number; raw_json: string }>()
  ]);
  const existingLocationIdByYocoId = new Map(
    (existingLocationRows.results || [])
      .map((row) => [text(row.external_location_id), text(row.id)] as const)
      .filter(([externalId, locationId]) => externalId && locationId)
  );
  const existingProductIdByYocoKey = new Map(
    (existingProductRows.results || [])
      .map((row) => [`${text(row.yoco_item_id)}:${text(row.yoco_variant_id)}`, text(row.id)] as const)
      .filter(([key, productId]) => key !== ':' && productId)
  );
  // Change-detection state: skip re-writing rows whose content is unchanged. This collapses the
  // per-sync D1 writes from ~one-per-row to only the genuinely changed/new/removed rows — the key
  // to staying within the free-tier write budget when many workspaces sync (frequently).
  const existingLocationStateByYocoId = new Map(
    (existingLocationRows.results || [])
      .map((row) => [text(row.external_location_id), { name: text(row.name), active: Number(row.active) }] as const)
      .filter(([externalId]) => externalId)
  );
  const existingProductStateByKey = new Map(
    (existingProductRows.results || [])
      .map((row) => [`${text(row.yoco_item_id)}:${text(row.yoco_variant_id)}`, { active: Number(row.active), raw: text(row.raw_json) }] as const)
      .filter(([key]) => key !== ':')
  );
  const statements: DbStatementLike[] = [];
  let locationsImported = 0;
  let locationsMatched = 0;
  let productsImported = 0;
  let productsMatched = 0;
  let productsRemoved = 0;
  let locationsRemoved = 0;
  const currentYocoProductKeys = new Set<string>();
  const currentYocoLocationIds = new Set<string>();

  // Names that conflict with the protected default storage location
  const RESERVED_LOCATION_NAMES = new Set(['main store', 'main storage', 'mainstore', 'mainstorage']);
  for (const location of locations as Row[]) {
    const yocoId = yocoLocationId(location);
    if (!yocoId) continue;
    const rawName = normalizeName(location, yocoId);
    // Deconflict: if a Yoco location is named the same as the default storage location,
    // append " (Yoco)" to avoid breaking location resolution throughout the system.
    const name = RESERVED_LOCATION_NAMES.has(rawName.toLowerCase().replace(/[^a-z0-9]/g, ''))
      ? `${rawName} (Yoco)`
      : rawName;
    const existingId = existingLocationIdByYocoId.get(yocoId) || '';
    currentYocoLocationIds.add(yocoId);

    if (existingId) {
      locationsMatched += 1;
      const nextActive = location.active === false || location.archived === true ? 0 : 1;
      const prev = existingLocationStateByYocoId.get(yocoId);
      // Change-detection: only write when the name or active state actually changed.
      if (!prev || prev.name !== name || prev.active !== nextActive) {
        statements.push(env.DB.prepare(
          // Update `name` too (not just external_name) so a rename in Yoco actually surfaces — the
          // frontend resolves the display as display_name || name || external_name, and `name`
          // outranks external_name. display_name is left untouched so a manual override survives.
          `UPDATE locations
              SET name = ?3,
                  external_name = ?3,
                  active = ?4,
                  updated_at = datetime('now')
            WHERE workspace_id = ?1 AND id = ?2`
        ).bind(workspaceId, existingId, name, nextActive));
      }
    } else {
      locationsImported += 1;
      statements.push(env.DB.prepare(
        `INSERT INTO locations
          (id, workspace_id, name, display_name, external_name, kind, active,
           is_default, external_provider, external_location_id, stock_routing_json)
         VALUES (?1, ?2, ?3, NULL, ?3, 'selling', ?4, 0, 'yoco', ?5, '{}')`
      ).bind(id('loc'), workspaceId, name, location.active === false || location.archived === true ? 0 : 1, yocoId));
    }
  }

  // Reconcile deletions: soft-deactivate any Yoco-sourced location that is no longer present in
  // the latest Yoco response. Soft (active = 0) rather than DELETE so stock_balances /
  // stock_movements / audit history remain intact. Scoped to external_provider = 'yoco' and
  // is_default = 0, so Main Store and manual storage locations are never touched.
  for (const [externalId, locationId] of existingLocationIdByYocoId.entries()) {
    if (currentYocoLocationIds.has(externalId)) continue;
    locationsRemoved += 1;
    statements.push(env.DB.prepare(
      `UPDATE locations
          SET active = 0,
              updated_at = datetime('now')
        WHERE workspace_id = ?1
          AND id = ?2
          AND external_provider = 'yoco'
          AND is_default = 0`
    ).bind(workspaceId, locationId));
  }

  for (const category of categories as Row[]) {
    const yocoId = yocoCategoryId(category);
    const name = normalizeName(category, yocoId || 'Yoco Category');
    if (yocoId) categoryMap.set(yocoId, category);
    statements.push(env.DB.prepare(
      `INSERT INTO yoco_categories (id, workspace_id, yoco_category_id, name, raw_json)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(workspace_id, yoco_category_id) DO UPDATE SET
        name = excluded.name,
        raw_json = excluded.raw_json`
    ).bind(id('yc'), workspaceId, yocoId, name, jsonString(category)));
  }

  for (const brand of brands as Row[]) {
    const yocoId = yocoBrandId(brand);
    if (!yocoId) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO yoco_brands (id, workspace_id, yoco_brand_id, name, raw_json)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(workspace_id, yoco_brand_id) DO UPDATE SET
        name = excluded.name,
        raw_json = excluded.raw_json`
    ).bind(id('yb'), workspaceId, yocoId, normalizeName(brand, yocoId), jsonString(brand)));
  }

  if (modifierCatalogue.complete && assignedModifierGroupIds.length) {
    const placeholders = assignedModifierGroupIds.map((_, index) => `?${index + 2}`).join(', ');
    statements.push(env.DB.prepare(
      `DELETE FROM yoco_modifier_groups
        WHERE workspace_id = ?1
          AND yoco_modifier_group_id NOT IN (${placeholders})`
    ).bind(workspaceId, ...assignedModifierGroupIds));
  } else if (modifierCatalogue.complete) {
    statements.push(env.DB.prepare(
      `DELETE FROM yoco_modifier_groups
        WHERE workspace_id = ?1`
    ).bind(workspaceId));
  }

  for (const group of modifierGroups as Row[]) {
    const yocoId = yocoModifierGroupId(group);
    if (!yocoId) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO yoco_modifier_groups
        (id, workspace_id, yoco_modifier_group_id, name, min_selections, max_selections,
         product_modifier_count, raw_json, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
       ON CONFLICT(workspace_id, yoco_modifier_group_id) DO UPDATE SET
        name = excluded.name,
        min_selections = excluded.min_selections,
        max_selections = excluded.max_selections,
        product_modifier_count = excluded.product_modifier_count,
        raw_json = excluded.raw_json,
        updated_at = datetime('now')`
    ).bind(
      id('ymg'),
      workspaceId,
      yocoId,
      normalizeName(group, yocoId),
      Number(group.min_selections ?? group.minSelections ?? 0) || 0,
      group.max_selections ?? group.maxSelections ?? null,
      actionableModifierCount(group),
      jsonString(group)
    ));
  }

  const currentModifierOwnerIds = modifierRecipeOwnerIds(modifierGroups as Row[]);
  for (let index = 0; index < currentModifierOwnerIds.length; index += 80) {
    const chunk = currentModifierOwnerIds.slice(index, index + 80);
    const placeholders = chunk.map((_, chunkIndex) => `?${chunkIndex + 2}`).join(', ');
    statements.push(env.DB.prepare(
      `UPDATE recipes
          SET active = 1,
              updated_at = datetime('now')
        WHERE workspace_id = ?1
          AND owner_type = 'yoco_modifier'
          AND owner_id IN (${placeholders})`
    ).bind(workspaceId, ...chunk));
  }

  for (const item of items as Row[]) {
    const itemId = text(item.id || item.item_id || item.uuid);
    const category = categoryForItem(item, categoryMap);
    for (const variant of normalizeVariants(item)) {
      const variantId = text(variant.id || variant.variant_id || variant.uuid || itemId);
      const itemName = normalizeName(item);
      const variantSummary = variantLabel(item, variant);
      const productKey: `${string}:${string}` = `${itemId}:${variantId}`;
      const existingId = existingProductIdByYocoKey.get(productKey) || '';
      const productId = existingId || id('prod');
      if (existingId) productsMatched += 1;
      else productsImported += 1;
      currentYocoProductKeys.add(productKey);

      const nextActive = item.active === false || item.archived === true ? 0 : 1;
      const nextRawJson = jsonString({
        item,
        variant,
        yocoItemName: itemName,
        yocoVariantName: variantSummary,
        yocoOptionSummary: selectedOptionSummary(variant),
        yocoHasMultipleVariants: item.has_multiple_variants === true || item.hasMultipleVariants === true || normalizeVariants(item).length > 1,
        yocoModifierGroupIds: modifierGroupIdsByItemId.get(itemId) || [],
        yocoBrandId: text(item.brand_id || (item.brand && typeof item.brand === 'object' ? (item.brand as Row).id : '')),
        yocoBrandName: item.brand && typeof item.brand === 'object' ? normalizeName(item.brand as Row, '') : ''
      });

      // Change-detection: skip the upsert when this variant already exists and neither its
      // active state nor its full Yoco payload (raw_json) changed since last sync.
      const prevProduct = existingProductStateByKey.get(productKey);
      if (existingId && prevProduct && prevProduct.active === nextActive && prevProduct.raw === nextRawJson) {
        continue;
      }

      statements.push(env.DB.prepare(
        `INSERT INTO products
          (id, workspace_id, name, sku, category, price, active, external_provider,
           yoco_item_id, yoco_variant_id, yoco_category_id, yoco_category_name, raw_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'yoco', ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(workspace_id, external_provider, yoco_item_id, yoco_variant_id) DO UPDATE SET
          name = excluded.name,
          sku = excluded.sku,
          category = excluded.category,
          price = excluded.price,
          active = excluded.active,
          yoco_category_id = excluded.yoco_category_id,
          yoco_category_name = excluded.yoco_category_name,
          raw_json = excluded.raw_json,
          updated_at = datetime('now')`
      ).bind(
        productId,
        workspaceId,
        variantName(item, variant),
        text(variant.sku || item.sku || item.code) || null,
        category.name || 'General',
        moneyToMajor(variant.price || item.price || item.default_price || item.amount),
        nextActive,
        itemId || null,
        variantId || null,
        category.id || null,
        category.name || null,
        nextRawJson
      ));
    }
  }

  // Deactivate products that exist in KCP but are no longer in Yoco (deleted on Yoco side).
  // SOFT delete (active = 0) — a hard DELETE throws a FOREIGN KEY violation for any product that
  // was ever sold (yoco_order_lines.product_id REFERENCES products(id), RESTRICT), which rolled
  // back the whole sync batch and made syncYocoCatalogue throw (blocking new products, location
  // deactivations and imports too). Mirrors deleteProductRoute.
  const removedYocoProductIds: string[] = [];
  for (const [key, productId] of existingProductIdByYocoKey.entries()) {
    if (!currentYocoProductKeys.has(key)) {
      removedYocoProductIds.push(productId);
    }
  }
  if (removedYocoProductIds.length) {
    productsRemoved = removedYocoProductIds.length;
    for (let i = 0; i < removedYocoProductIds.length; i += 80) {
      const chunk = removedYocoProductIds.slice(i, i + 80);
      const placeholders = chunk.map((_, idx) => `?${idx + 2}`).join(', ');
      statements.push(env.DB.prepare(
        `UPDATE products
            SET active = 0, updated_at = datetime('now')
          WHERE workspace_id = ?1
            AND external_provider = 'yoco'
            AND id IN (${placeholders})`
      ).bind(workspaceId, ...chunk));
    }
  }

  statements.push(env.DB.prepare(
    `UPDATE yoco_connections
        SET last_catalogue_sync_at = ?2,
            last_error = '',
            updated_at = ?2
      WHERE workspace_id = ?1`
  ).bind(workspaceId, nowIso()));

  if (statements.length) await runD1Batches(env.DB, statements);

  // Per-location pricing pass (runs AFTER products/locations are committed above so it can read
  // their ids). Best-effort: a failure here never breaks the main catalogue sync.
  let locationPricing = { locationPricesUpserted: 0, locationPricesRemoved: 0, locationsPriced: 0, warnings: [] as YocoPriceWarning[] };
  try {
    locationPricing = await syncYocoLocationPrices(env, workspaceId, apiKey);
  } catch (caught) {
    locationPricing.warnings.push({ message: `Per-location pricing sync failed: ${text((caught as Error)?.message) || 'unknown error'}` });
  }

  return {
    locationsImported,
    locationsMatched,
    locationsRemoved,
    categoriesImported: (categories as unknown[]).length,
    brandsStored: (brands as unknown[]).length,
    modifierGroupsStored: (modifierGroups as unknown[]).length,
    modifierOptionsStored: modifierCatalogue.counts.total,
    productModifiersStored: modifierCatalogue.counts.product,
    optionModifiersStored: modifierCatalogue.counts.option,
    noteModifiersStored: modifierCatalogue.counts.note,
    productsImported,
    productsMatched,
    productsRemoved,
    locationPricesUpserted: locationPricing.locationPricesUpserted,
    locationPricesRemoved: locationPricing.locationPricesRemoved,
    locationsPriced: locationPricing.locationsPriced,
    warnings: [...modifierCatalogue.warnings, ...locationPricing.warnings],
    webhook
  };
}

type YocoPriceWarning = { locationId?: string; locationName?: string; message: string };

// Fetch item prices per Yoco location and persist them into product_location_prices with
// source='yoco', so the same item can carry a different price per location (e.g. Coke Zero =
// R15 upstairs, R20 downstairs). NEVER touches source='manual' rows (user overrides win).
// Reads the freshly-committed location + product ids from the DB, then queries Yoco per location
// (variant prices are resolved for that location by ?location_id=). Per-location errors are
// collected as warnings so one failing location doesn't abort the rest.
export async function syncYocoLocationPrices(env: Env, workspaceId: string, apiKey: string) {
  const warnings: YocoPriceWarning[] = [];

  const [locationRows, productRows, existingPriceRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, external_location_id, name FROM locations
        WHERE workspace_id = ?1 AND external_provider = 'yoco' AND active = 1`
    ).bind(workspaceId).all<{ id: string; external_location_id: string; name: string }>(),
    env.DB.prepare(
      `SELECT id, yoco_item_id, yoco_variant_id FROM products
        WHERE workspace_id = ?1 AND external_provider = 'yoco' AND active = 1`
    ).bind(workspaceId).all<{ id: string; yoco_item_id: string; yoco_variant_id: string }>(),
    env.DB.prepare(
      `SELECT product_id, location_id, price, source FROM product_location_prices
        WHERE workspace_id = ?1`
    ).bind(workspaceId).all<{ product_id: string; location_id: string; price: number; source: string }>()
  ]);

  const kcpLocationByYocoId = new Map(
    (locationRows.results || [])
      .map((row) => [text(row.external_location_id), { id: text(row.id), name: text(row.name) }] as const)
      .filter(([yocoId, loc]) => yocoId && loc.id)
  );
  const productIdByYocoKey = new Map(
    (productRows.results || [])
      .map((row) => [`${text(row.yoco_item_id)}:${text(row.yoco_variant_id)}`, text(row.id)] as const)
      .filter(([key, productId]) => key !== ':' && productId)
  );
  const yocoProductIds = new Set(productIdByYocoKey.values());
  const yocoLocationIds = new Set([...kcpLocationByYocoId.values()].map((loc) => loc.id));
  // Only compare/refresh against existing YOCO rows; manual overrides are left untouched.
  const existingYocoPriceByKey = new Map<string, number>(
    (existingPriceRows.results || [])
      .filter((row) => text(row.source) === 'yoco')
      .map((row) => [`${text(row.product_id)}::${text(row.location_id)}`, Number(row.price)])
  );

  if (!kcpLocationByYocoId.size || !productIdByYocoKey.size) {
    return { locationPricesUpserted: 0, locationPricesRemoved: 0, locationsPriced: 0, warnings };
  }

  const statements: DbStatementLike[] = [];
  const seenPriceKeys = new Set<string>();
  let locationsPriced = 0;
  let upserted = 0;

  for (const [yocoLocId, kcpLoc] of kcpLocationByYocoId) {
    let locationItems: unknown[];
    try {
      locationItems = await listItemsForLocation(env, workspaceId, apiKey, yocoLocId);
    } catch (caught) {
      warnings.push({ locationId: kcpLoc.id, locationName: kcpLoc.name, message: `Failed to fetch prices for ${kcpLoc.name}: ${text((caught as Error)?.message) || 'error'}` });
      continue;
    }
    locationsPriced += 1;
    for (const item of locationItems as Row[]) {
      const itemId = text(item.id || item.item_id || item.uuid);
      for (const variant of normalizeVariants(item)) {
        const variantId = text(variant.id || variant.variant_id || variant.uuid || itemId);
        const productId = productIdByYocoKey.get(`${itemId}:${variantId}`);
        if (!productId) continue;
        const priceMajor = moneyToMajor(variant.price || item.default_price || item.price || item.amount);
        const priceKey = `${productId}::${kcpLoc.id}`;
        seenPriceKeys.add(priceKey);
        const prev = existingYocoPriceByKey.get(priceKey);
        if (prev !== undefined && Math.abs(prev - priceMajor) < 0.0001) continue; // unchanged yoco row
        statements.push(env.DB.prepare(
          `INSERT INTO product_location_prices (workspace_id, product_id, location_id, price, source, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'yoco', ?5)
           ON CONFLICT(workspace_id, product_id, location_id) DO UPDATE SET
             price = excluded.price,
             updated_at = excluded.updated_at
           WHERE product_location_prices.source != 'manual'`
        ).bind(workspaceId, productId, kcpLoc.id, priceMajor, nowIso()));
        upserted += 1;
      }
    }
  }

  // Remove stale YOCO rows (item/variant no longer priced at that location) — only for
  // Yoco products + Yoco locations, and only source='yoco'. Manual overrides untouched.
  let removed = 0;
  for (const [priceKey, ] of existingYocoPriceByKey) {
    if (seenPriceKeys.has(priceKey)) continue;
    const [productId, locationId] = priceKey.split('::');
    if (!yocoProductIds.has(productId) || !yocoLocationIds.has(locationId)) continue;
    statements.push(env.DB.prepare(
      `DELETE FROM product_location_prices
        WHERE workspace_id = ?1 AND product_id = ?2 AND location_id = ?3 AND source = 'yoco'`
    ).bind(workspaceId, productId, locationId));
    removed += 1;
  }

  if (statements.length) await runD1Batches(env.DB, statements);
  return { locationPricesUpserted: upserted, locationPricesRemoved: removed, locationsPriced, warnings };
}

function buildItemModifierGroupIdMap(items: Row[]) {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const itemId = text(item.id || item.item_id || item.uuid);
    if (!itemId) continue;
    const ids = [...new Set(itemModifierGroupRefs(item).map(modifierGroupRefId).filter(Boolean))];
    if (ids.length) map.set(itemId, ids);
  }
  return map;
}

type YocoModifierCatalogueResult = {
  groups: Row[];
  complete: boolean;
  warnings: Array<{ message: string }>;
  counts: { product: number; option: number; note: number; total: number };
};

async function fetchCompleteYocoModifierCatalogue(
  env: Env,
  workspaceId: string,
  apiKey: string,
  sourceItems?: Row[],
): Promise<YocoModifierCatalogueResult> {
  const items = sourceItems || await listItems(env, workspaceId, apiKey) as Row[];
  const byId = new Map<string, Row>();
  const detailIds = new Set<string>();
  const warnings: Array<{ message: string }> = [];
  let complete = true;

  // Item assignments are useful because some Yoco item payloads already include a fully expanded
  // modifier group. They are not treated as the complete catalogue: groups can exist before they
  // are assigned, and assignments can be represented only at variant level.
  for (const item of items) {
    for (const ref of itemModifierGroupRefs(item)) {
      const groupId = modifierGroupRefId(ref);
      if (!groupId) continue;
      if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        const current = byId.get(groupId);
        if (!current || (!isExpandedModifierGroup(current) && isExpandedModifierGroup(ref))) byId.set(groupId, ref as Row);
      }
      if (!isExpandedModifierGroup(ref)) detailIds.add(groupId);
    }
  }

  // Always enumerate the full modifier catalogue. The old implementation only did this when no
  // assigned group was found, which meant a successful partial assignment response silently hid
  // every other modifier group from KCP.
  try {
    const listedGroups = await listModifierGroups(env, workspaceId, apiKey) as Row[];
    for (const group of listedGroups) {
      const groupId = yocoModifierGroupId(group);
      if (!groupId) continue;
      const current = byId.get(groupId);
      if (!current || (!isExpandedModifierGroup(current) && isExpandedModifierGroup(group))) byId.set(groupId, group);
      if (!isExpandedModifierGroup(group)) detailIds.add(groupId);
    }
  } catch (caught) {
    complete = false;
    warnings.push({
      message: `The full Yoco modifier-group list could not be loaded. Existing cached groups were preserved. ${text((caught as Error)?.message)}`.trim(),
    });
  }

  const idsToHydrate = [...detailIds].filter((groupId) => !isExpandedModifierGroup(byId.get(groupId)));
  const hydrated = await Promise.all(idsToHydrate.map(async (groupId) => {
    const summary = byId.get(groupId) || { id: groupId };
    try {
      const detailValue = await fetchModifierGroup(env, workspaceId, apiKey, groupId);
      const detail = detailValue && typeof detailValue === 'object' && !Array.isArray(detailValue) ? detailValue as Row : {};
      let merged: Row = { ...summary, ...detail, id: yocoModifierGroupId(detail) || yocoModifierGroupId(summary) || groupId };
      if (!modifierGroupModifiers(merged).length) {
        const children = await listModifierGroupChildren(env, workspaceId, apiKey, groupId);
        if (children.length) merged = { ...merged, modifiers: children };
      }
      return merged;
    } catch (caught) {
      complete = false;
      warnings.push({
        message: `Yoco modifier group ${groupId} could not be expanded and its catalogue summary was preserved. ${text((caught as Error)?.message)}`.trim(),
      });
      return summary;
    }
  }));

  hydrated.forEach((group) => {
    const row = group && typeof group === 'object' && !Array.isArray(group) ? group as Row : null;
    const groupId = row ? yocoModifierGroupId(row) : '';
    if (row && groupId) byId.set(groupId, row);
  });

  const groups = [...byId.values()]
    .map(actionableModifierGroup)
    .filter(Boolean) as Row[];
  const counts = groups.reduce<YocoModifierCatalogueResult['counts']>((total, group) => {
    const current = modifierTypeCounts(group);
    total.product += current.product;
    total.option += current.option;
    total.note += current.note;
    total.total += current.product + current.option + current.note;
    return total;
  }, { product: 0, option: 0, note: 0, total: 0 });

  return { groups, complete, warnings, counts };
}

export async function fetchAssignedYocoModifierGroups(env: Env, workspaceId: string, apiKey: string, sourceItems?: Row[]) {
  const result = await fetchCompleteYocoModifierCatalogue(env, workspaceId, apiKey, sourceItems);
  return result.groups;
}

function parseModifierGroupRow(row: Row) {
  let raw: unknown = row.raw_json || {};
  if (typeof row.raw_json === 'string') {
    try {
      raw = JSON.parse(row.raw_json || '{}');
    } catch {
      raw = {};
    }
  }
  const rawRow = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {};
  return {
    id: text(row.yoco_modifier_group_id || rawRow.id),
    name: text(row.name || rawRow.name),
    minSelections: Number(row.min_selections ?? rawRow.min_selections ?? 0) || 0,
    maxSelections: row.max_selections ?? rawRow.max_selections ?? null,
    productModifierCount: Number(row.product_modifier_count || 0),
    modifiers: Array.isArray(rawRow.modifiers) ? rawRow.modifiers : [],
    raw: rawRow,
    updatedAt: text(row.updated_at)
  };
}

export async function listYocoModifierGroups(env: Env, workspaceId: string) {
  const result = await env.DB.prepare(
    `SELECT *
       FROM yoco_modifier_groups
      WHERE workspace_id = ?1
      ORDER BY name COLLATE NOCASE`
  ).bind(workspaceId).all<Row>();
  return (result.results || []).map(parseModifierGroupRow);
}

export async function getYocoModifierGroup(env: Env, workspaceId: string, modifierGroupId: string) {
  const row = await env.DB.prepare(
    `SELECT *
       FROM yoco_modifier_groups
      WHERE workspace_id = ?1
        AND (id = ?2 OR yoco_modifier_group_id = ?2)
      LIMIT 1`
  ).bind(workspaceId, modifierGroupId).first<Row>();
  return row ? parseModifierGroupRow(row) : null;
}
