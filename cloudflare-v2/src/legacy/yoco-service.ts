import type { Env, DbLike, DbStatementLike } from './types';
// @ts-ignore Shared Yoco Money converter: Money objects are minor units; normalized scalars remain major units.
import { yocoMoneyToMajor } from '../../../src/modules/reporting/engine/yocoFinancials.js';
import { decryptText, encryptText } from './crypto';
import {
  YocoApiError,
  createWebhookSubscription,
  deleteWebhookSubscription,
  fetchOrder,
  fetchModifierGroup,
  listItemBrands,
  listItemCategories,
  listItems,
  listItemsForLocation,
  listLocations,
  listModifierGroups,
  listWebhookSubscriptions,
  listOrders,
  listOrdersPage,
  listRefunds,
  testWebhookSubscription,
  yocoFetch
} from './yoco-client';
import { extractYocoOrder, processYocoOrder, yocoWebhookEventFields } from './yoco-sales';
import { findRefund } from './yoco-webhooks';
import { recordIntegrationLog, runLoggedIntegrationOperation } from './integration-log';

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
    item.assigned_modifier_groups,
    item.assignedModifierGroups
  ].forEach((value) => {
    if (Array.isArray(value)) refs.push(...value);
    else if (value && typeof value === 'object') refs.push(...Object.values(value as Row));
  });
  normalizeVariants(item).forEach((variant) => {
    [
      variant.modifier_groups,
      variant.modifierGroups,
      variant.modifier_group_ids,
      variant.modifierGroupIds,
      variant.assigned_modifier_groups,
      variant.assignedModifierGroups
    ].forEach((value) => {
      if (Array.isArray(value)) refs.push(...value);
      else if (value && typeof value === 'object') refs.push(...Object.values(value as Row));
    });
  });
  return refs;
}

function isExpandedModifierGroup(ref: unknown) {
  const row = ref && typeof ref === 'object' && !Array.isArray(ref) ? ref as Row : {};
  return Boolean(yocoModifierGroupId(row) && modifierGroupModifiers(row).length);
}

function modifierGroupModifiers(group: Row) {
  const modifiers = group.modifiers ||
    group.modifier_items ||
    group.modifierItems ||
    group.modifier_options ||
    group.modifierOptions ||
    group.options ||
    group.items ||
    group.values;
  return Array.isArray(modifiers) ? modifiers as Row[] : [];
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
  const type = text(modifier.type || modifier.kind || modifier.modifier_type || modifier.modifierType).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return Boolean(modifierProductReferenceId(modifier)) && (!type || type.includes('product'));
}

function productModifierCount(group: Row) {
  return modifierGroupModifiers(group).filter(isProductLinkedModifier).length;
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

export function productLinkedYocoModifierGroup(group: Row) {
  return productLinkedModifierGroup(group);
}

function modifierId(modifier: Row) {
  return text(modifier.modifier_id || modifier.modifierId || modifier.id || modifier.uuid);
}

function modifierVariantId(modifier: Row) {
  return modifierProductReferenceId(modifier);
}

function modifierName(modifier: Row, fallback = 'Yoco Modifier') {
  return text(modifier.name || modifier.display_name || modifier.displayName || modifier.product_name || modifier.productName, fallback);
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
    modifierGroupModifiers(group).filter(isProductLinkedModifier).forEach((modifier) => {
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

function subscriptionSecret(subscription: Row) {
  return text(subscription.secret || subscription.webhook_secret || subscription.webhookSecret || subscription.signing_secret || subscription.signingSecret);
}

const YOCO_WEBHOOK_EVENT_TYPES = ['payment.created', 'payment.refunded'];
const WEBHOOK_PREVIOUS_SECRET_GRACE_MS = 24 * 60 * 60 * 1000;

type YocoSyncOptions = { full?: boolean; sinceIso?: string; resetWebhook?: boolean };

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

async function createYocoWebhookWithFallback(env: Env, apiKey: string, webhookUrl: string) {
  const name = 'Kitchen Cost Pro Cloudflare Webhook';
  const attempts = [
    // Official Yoco API shape: notification_url + explicit event_types.
    { event_types: YOCO_WEBHOOK_EVENT_TYPES, name, notification_url: webhookUrl },
    // Alternate shape accepted by some Standard Webhooks based Yoco endpoints.
    { event_types: YOCO_WEBHOOK_EVENT_TYPES, name, url: webhookUrl },
    // Legacy fallback kept so older tenant keys do not fail setup unexpectedly.
    { name, notification_url: webhookUrl },
    { name, url: webhookUrl }
  ];
  let lastError: unknown = null;
  for (const body of attempts) {
    try {
      const response = await createWebhookSubscription(env, apiKey, body) as Row;
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

async function inspectRemoteYocoWebhook(env: Env, apiKey: string, webhookId: string, webhookUrl: string) {
  const subscriptions = await listWebhookSubscriptions(env, apiKey) as Row[];
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
  apiKey: string,
  options: { webhookId?: string; webhookUrl?: string } = {},
) {
  const subscriptions = await listWebhookSubscriptions(env, apiKey) as Row[];
  const webhookId = text(options.webhookId);
  const webhookUrl = text(options.webhookUrl);
  const candidates = subscriptions.filter((subscription) => isKcpWebhookSubscription(subscription, webhookId, webhookUrl));
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const subscription of candidates) {
    const idValue = subscriptionId(subscription);
    try {
      await deleteWebhookSubscription(env, apiKey, idValue);
      deleted.push(idValue);
    } catch (caught) {
      if (caught instanceof YocoApiError && caught.status === 404) {
        deleted.push(idValue);
        continue;
      }
      const message = caught instanceof Error ? caught.message : String(caught || 'Unknown delete error');
      failed.push(`${idValue}: ${message}`);
    }
  }
  if (failed.length) {
    throw new Error(`Could not delete ${failed.length} Yoco webhook subscription(s): ${failed.slice(0, 3).join('; ')}`);
  }
  return {
    deletedCount: deleted.length,
    deletedIds: deleted,
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

  await yocoFetch(env, cleanKey, '/v1/locations/', { params: { limit: 1 } });

  const encrypted = await encryptText(env, cleanKey);
  const webhookUrl = expectedWebhookUrl(env, workspaceId);
  let webhookEnabled = false;
  let webhookId = '';
  let webhookSecret = '';
  let webhookError = '';
  let deletionResult = { deletedCount: 0, deletedIds: [] as string[], ignoredSubscriptionCount: 0 };

  try {
    if (!webhookUrl) throw new Error('YOCO_WEBHOOK_BASE_URL is not configured.');
    const setup = await runLoggedIntegrationOperation(
      env,
      workspaceId,
      'yoco.connect.webhook',
      'Validate Yoco credentials and initialise the live webhook',
      async (correlationId) => {
        deletionResult = await deleteYocoWebhookSubscriptions(env, cleanKey, {
          webhookId: text(existing?.webhook_id),
          webhookUrl,
        });
        await recordIntegrationLog(env, workspaceId, {
          operation: 'yoco.webhook.delete_subscriptions',
          status: 'success',
          message: `Deleted ${deletionResult.deletedCount} Yoco webhook subscription(s).`,
          details: deletionResult,
          correlationId,
        });
        const { subscription } = await createYocoWebhookWithFallback(env, cleanKey, webhookUrl);
        const createdId = subscriptionId(subscription);
        const createdSecret = subscriptionSecret(subscription);
        const remote = await inspectRemoteYocoWebhook(env, cleanKey, createdId, webhookUrl);
        if (!remote.healthy) {
          throw new Error(`Yoco created a webhook but remote verification failed: ${remote.reason || 'unknown reason'}.`);
        }
        return { webhookId: createdId, webhookSecret: createdSecret, webhookUrl };
      },
      { webhookUrl, eventTypes: YOCO_WEBHOOK_EVENT_TYPES },
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
    remoteVerified: true,
    salesBaselineAt,
    historicalSalesImported: false,
  };
}

export async function resetYocoWebhook(env: Env, workspaceId: string, apiKeyOverride = '') {
  const connection = await getYocoConnection(env, workspaceId);
  const apiKey = text(apiKeyOverride) || await getYocoApiKey(env, workspaceId);
  const webhookUrl = expectedWebhookUrl(env, workspaceId);
  if (!webhookUrl) throw new Error('YOCO_WEBHOOK_BASE_URL is not configured.');
  const previousWebhookId = text(connection?.webhook_id);
  const previousWebhookSecret = text(connection?.webhook_secret);
  let subscriptionsDeleted = false;

  try {
    return await runLoggedIntegrationOperation(
      env,
      workspaceId,
      'yoco.webhook.reset',
      'Delete existing Yoco subscriptions and create a fresh live subscription',
      async (correlationId) => {
        const deletionResult = await deleteYocoWebhookSubscriptions(env, apiKey, {
          webhookId: previousWebhookId,
          webhookUrl,
        });
        subscriptionsDeleted = true;
        await recordIntegrationLog(env, workspaceId, {
          operation: 'yoco.webhook.delete_subscriptions',
          status: 'success',
          message: `Deleted ${deletionResult.deletedCount} Yoco webhook subscription(s).`,
          details: deletionResult,
          correlationId,
        });

        const { subscription } = await createYocoWebhookWithFallback(env, apiKey, webhookUrl);
        const webhookId = subscriptionId(subscription);
        const webhookSecret = subscriptionSecret(subscription);
        const remote = await inspectRemoteYocoWebhook(env, apiKey, webhookId, webhookUrl);
        if (!remote.healthy) {
          throw new Error(`Fresh Yoco webhook failed remote verification: ${remote.reason || 'unknown reason'}.`);
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
        return {
          webhookEnabled: true,
          webhookId,
          webhookUrl,
          replacedWebhookId: previousWebhookId,
          deletedSubscriptionCount: deletionResult.deletedCount,
          deletedSubscriptionIds: deletionResult.deletedIds,
          remoteVerified: true,
          eventTypes: YOCO_WEBHOOK_EVENT_TYPES,
        };
      },
      { webhookUrl, previousWebhookId, eventTypes: YOCO_WEBHOOK_EVENT_TYPES },
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await env.DB.prepare(
      `UPDATE yoco_connections
          SET status = 'error',
              connection_active = 1,
              webhook_id = CASE WHEN ?3 = 1 THEN NULL ELSE webhook_id END,
              webhook_secret = CASE WHEN ?3 = 1 THEN NULL ELSE webhook_secret END,
              last_error = ?2,
              updated_at = datetime('now')
        WHERE workspace_id = ?1`,
    ).bind(workspaceId, message, subscriptionsDeleted ? 1 : 0).run();
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

  const remote = await inspectRemoteYocoWebhook(env, apiKey, webhookId, webhookUrl);
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
    'Dispatch a Yoco payment.created test webhook',
    async () => {
      const response = await testWebhookSubscription(env, apiKey, health.webhookId, 'payment.created') as Row;
      return {
        webhookId: health.webhookId,
        messageId: text(response.message_id || response.messageId || response.id),
        response,
      };
    },
    { webhookId: health.webhookId, eventType: 'payment.created' },
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

export async function disconnectYoco(env: Env, workspaceId: string) {
  const connection = await getYocoConnection(env, workspaceId);
  const encrypted = text(connection?.api_key_encrypted);
  const webhookId = text(connection?.webhook_id);
  let disconnectError = '';
  if (encrypted && webhookId) {
    try {
      const apiKey = await decryptText(env, encrypted);
      await deleteYocoWebhookSubscriptions(env, apiKey, {
        webhookId,
        webhookUrl: text(connection?.webhook_url) || expectedWebhookUrl(env, workspaceId),
      });
    } catch (caught) {
      disconnectError = caught instanceof Error ? caught.message : String(caught);
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
  return { disconnected: true, webhookDisabled: !disconnectError, disconnectError };
}

export async function syncYocoCatalogue(env: Env, workspaceId: string, options: YocoSyncOptions = {}) {
  const apiKey = await getYocoApiKey(env, workspaceId);
  const webhook = await prepareYocoWebhookForSync(env, workspaceId, apiKey, options.resetWebhook === true);
  const [locations, categories, brands, items] = await Promise.all([
    listLocations(env, apiKey),
    listItemCategories(env, apiKey).catch(() => []),
    listItemBrands(env, apiKey).catch(() => []),
    listItems(env, apiKey)
  ]);
  const modifierGroups = await fetchAssignedYocoModifierGroups(env, apiKey, items as Row[]).catch(() => []);

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

  if (assignedModifierGroupIds.length) {
    const placeholders = assignedModifierGroupIds.map((_, index) => `?${index + 2}`).join(', ');
    statements.push(env.DB.prepare(
      `DELETE FROM yoco_modifier_groups
        WHERE workspace_id = ?1
          AND yoco_modifier_group_id NOT IN (${placeholders})`
    ).bind(workspaceId, ...assignedModifierGroupIds));
  } else {
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
      productModifierCount(group),
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
    productModifiersStored: (modifierGroups as Row[]).reduce((total, group) => total + productModifierCount(group), 0),
    productsImported,
    productsMatched,
    productsRemoved,
    locationPricesUpserted: locationPricing.locationPricesUpserted,
    locationPricesRemoved: locationPricing.locationPricesRemoved,
    locationsPriced: locationPricing.locationsPriced,
    warnings: locationPricing.warnings,
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
      locationItems = await listItemsForLocation(env, apiKey, yocoLocId);
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

export async function fetchAssignedYocoModifierGroups(env: Env, apiKey: string, sourceItems?: Row[]) {
  const items = sourceItems || await listItems(env, apiKey) as Row[];
  const byId = new Map<string, Row>();
  const fetchIds = new Set<string>();

  for (const item of items) {
    for (const ref of itemModifierGroupRefs(item)) {
      const groupId = modifierGroupRefId(ref);
      if (!groupId || byId.has(groupId)) continue;
      if (isExpandedModifierGroup(ref)) byId.set(groupId, ref as Row);
      else fetchIds.add(groupId);
    }
  }

  const fetched = await Promise.all([...fetchIds].map((groupId) => (
    fetchModifierGroup(env, apiKey, groupId).catch(() => null)
  )));
  fetched.forEach((group) => {
    const row = group && typeof group === 'object' && !Array.isArray(group) ? group as Row : null;
    const groupId = row ? yocoModifierGroupId(row) : '';
    if (row && groupId) byId.set(groupId, row);
  });

  let productLinkedGroups = [...byId.values()]
    .map(productLinkedModifierGroup)
    .filter(Boolean) as Row[];

  if (!productLinkedGroups.length) {
    const allGroups = await listModifierGroups(env, apiKey).catch(() => []) as Row[];
    allGroups.forEach((group) => {
      const groupId = yocoModifierGroupId(group);
      if (groupId) byId.set(groupId, group);
    });
    productLinkedGroups = [...byId.values()]
      .map(productLinkedModifierGroup)
      .filter(Boolean) as Row[];
  }

  return productLinkedGroups;
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

function yocoOrderIdValue(order: Row) {
  return text(order.id || order.order_id || order.orderId);
}

function yocoOrderTimestampValue(order: Row) {
  return text(
    order.updated_at ||
    order.updatedAt ||
    order.closed_at ||
    order.closedAt ||
    order.completed_at ||
    order.completedAt ||
    order.paid_at ||
    order.paidAt ||
    order.created_at ||
    order.createdAt
  );
}

function yocoOrderWithinWindow(order: Row, lowerBound: string, upperBound: string) {
  const occurredAt = yocoOrderTimestampValue(order);
  const parsed = Date.parse(occurredAt);
  if (!Number.isFinite(parsed)) return true;
  const lower = Date.parse(lowerBound);
  const upper = Date.parse(upperBound);
  if (Number.isFinite(lower) && parsed < lower) return false;
  if (Number.isFinite(upper) && parsed > upper) return false;
  return true;
}

async function listYocoOrdersForSalesSync(
  env: Env,
  apiKey: string,
  lowerBound: string,
  upperBound: string,
) {
  const attempts = lowerBound
    ? [
        {
          strategy: 'updated_at_window',
          params: { updated_at__gte: lowerBound, updated_at__lte: upperBound },
        },
        {
          strategy: 'created_at_window',
          params: { created_at__gte: lowerBound, created_at__lte: upperBound },
        },
      ]
    : [{ strategy: 'unfiltered', params: { updated_at__lte: upperBound } }];
  const attemptErrors: string[] = [];

  for (const attempt of attempts) {
    try {
      const rows = await listOrders(env, apiKey, attempt.params) as Row[];
      if (rows.length) {
        return {
          orders: rows.filter((order) => yocoOrderWithinWindow(order, lowerBound, upperBound)),
          strategy: attempt.strategy,
          attemptErrors,
        };
      }
    } catch (caught) {
      attemptErrors.push(`${attempt.strategy}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  // Some Yoco tenants return an empty collection for unsupported server-side filters rather
  // than a validation error. Pull a bounded number of normal order pages and apply the window
  // locally so admin reconciliation cannot incorrectly report zero while webhooks are arriving.
  const fallbackOrders: Row[] = [];
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    try {
      const page: { rows: unknown[]; nextCursor: unknown } = await listOrdersPage(env, apiKey, { cursor, limit: 100 });
      const rows = (page.rows || []) as Row[];
      fallbackOrders.push(...rows.filter((order) => yocoOrderWithinWindow(order, lowerBound, upperBound)));
      cursor = text(page.nextCursor) || null;
      if (!cursor || !rows.length) break;
    } catch (caught) {
      attemptErrors.push(`bounded_unfiltered_page_${pageIndex + 1}: ${caught instanceof Error ? caught.message : String(caught)}`);
      break;
    }
  }
  return { orders: fallbackOrders, strategy: 'bounded_unfiltered_fallback', attemptErrors };
}

function yocoOrderHasPaymentId(order: Row, paymentId: string) {
  const wanted = text(paymentId);
  if (!wanted) return false;
  if ([order.payment_id, order.paymentId].some((value) => text(value) === wanted)) return true;
  const payments = Array.isArray(order.payments) ? order.payments as Row[] : [];
  return payments.some((payment) => [payment.id, payment.payment_id, payment.paymentId]
    .some((value) => text(value) === wanted));
}

async function findYocoOrderByPaymentId(env: Env, apiKey: string, paymentId: string) {
  if (!paymentId) return null;
  const direct = await listOrders(env, apiKey, { payment_id: paymentId, limit: 25 }).catch(() => []) as Row[];
  const directMatch = direct.find((order) => yocoOrderHasPaymentId(order, paymentId));
  if (directMatch) return directMatch;

  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const page: { rows: unknown[]; nextCursor: unknown } | null = await listOrdersPage(env, apiKey, { cursor, limit: 100 }).catch(() => null);
    if (!page) break;
    const rows = (page.rows || []) as Row[];
    const match = rows.find((order) => yocoOrderHasPaymentId(order, paymentId));
    if (match) return match;
    cursor = text(page.nextCursor) || null;
    if (!cursor || !rows.length) break;
  }
  return null;
}

async function loadWebhookBackedOrders(
  env: Env,
  workspaceId: string,
  apiKey: string,
  lowerBound: string,
) {
  const floor = lowerBound || new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, yoco_order_id, event_type, raw_json, created_at
       FROM yoco_webhook_events event
      WHERE event.workspace_id = ?1
        AND lower(event.event_type) NOT LIKE '%refund%'
        AND (
          lower(event.event_type) LIKE '%payment%'
          OR lower(event.event_type) LIKE '%order%'
          OR lower(event.event_type) LIKE '%sale%'
        )
        AND datetime(event.created_at) >= datetime(?2)
        AND (
          COALESCE(event.yoco_order_id, '') = ''
          OR NOT EXISTS (
            SELECT 1
              FROM stock_movements movement
             WHERE movement.workspace_id = event.workspace_id
               AND movement.document_type = 'yoco_order'
               AND movement.document_id = event.yoco_order_id
               AND movement.movement_type = 'sale_depletion'
          )
        )
      ORDER BY datetime(event.created_at) DESC
      LIMIT 200`,
  ).bind(workspaceId, floor).all<Row>();

  const orderMap = new Map<string, Row>();
  const failures: string[] = [];
  for (const row of rows.results || []) {
    const payload = jsonParse(row.raw_json);
    const payloadOrder = extractYocoOrder(payload);
    const fields = yocoWebhookEventFields(payload);
    const storedOrderId = text(row.yoco_order_id);
    const orderIds = [...new Set([storedOrderId, fields.orderId].filter(Boolean))];
    let loadedOrder: Row | null = payloadOrder;
    let lastError = '';

    for (const orderId of orderIds) {
      if (loadedOrder) break;
      try {
        loadedOrder = await fetchOrder(env, apiKey, orderId) as Row;
      } catch (caught) {
        lastError = caught instanceof Error ? caught.message : String(caught);
      }
    }

    if (!loadedOrder && fields.paymentId) {
      loadedOrder = await findYocoOrderByPaymentId(env, apiKey, fields.paymentId);
    }

    const resolvedOrderId = loadedOrder ? yocoOrderIdValue(loadedOrder) : '';
    if (loadedOrder && resolvedOrderId) {
      orderMap.set(resolvedOrderId, loadedOrder);
      if (resolvedOrderId !== storedOrderId) {
        await env.DB.prepare(
          `UPDATE yoco_webhook_events
              SET yoco_order_id = ?2
            WHERE workspace_id = ?1
              AND id = ?3`,
        ).bind(workspaceId, resolvedOrderId, text(row.id)).run().catch(() => undefined);
      }
      continue;
    }

    failures.push(`${storedOrderId || fields.paymentId || 'unknown webhook reference'}: ${lastError || 'Yoco order could not be resolved from the webhook payload.'}`);
  }
  return { orders: [...orderMap.values()], failures, candidateCount: (rows.results || []).length, floor };
}

async function updateWebhookSaleOutcome(
  env: Env,
  workspaceId: string,
  orderId: string,
  result: { reason?: string; retryable?: boolean; stockMovements?: number; skippedDuplicates?: number },
) {
  if (!orderId) return;
  const reason = text(result.reason);
  const movements = Number(result.stockMovements || 0);
  const duplicate = reason === 'duplicate' || Number(result.skippedDuplicates || 0) > 0;
  const ignored = reason === 'before_stock_depletion_start';
  const needsAttention = result.retryable === true || (
    movements === 0 && !duplicate && !ignored
  );
  const status = ignored ? 'ignored' : needsAttention ? 'attention' : 'processed';
  const message = ignored
    ? 'Order is before the KCP sales baseline or Go Live timestamp. No historical stock deduction was applied.'
    : reason === 'stock_depletion_disabled'
      ? 'Order found, but stock depletion is not live. Enable Go Live before new sales can deduct stock.'
      : reason === 'order_not_paid_or_completed'
        ? 'Order found, but Yoco has not yet returned it in a paid/completed state.'
        : needsAttention
          ? `Order found, but stock deduction needs attention: ${reason || 'missing recipe or product mapping'}.`
          : duplicate && movements === 0
            ? 'Order was already deducted. No duplicate stock movement was created.'
            : `Sales reconciliation created ${movements} stock movement(s).`;
  await env.DB.prepare(
    `UPDATE yoco_webhook_events
        SET status = ?3,
            error_message = ?4,
            processed_at = ?5
      WHERE workspace_id = ?1
        AND yoco_order_id = ?2
        AND lower(event_type) NOT LIKE '%refund%'`,
  ).bind(workspaceId, orderId, status, message, nowIso()).run();
}

async function recordYocoSyncError(env: Env, workspaceId: string, details: {
  eventType: string;
  orderId?: string;
  message: string;
  raw?: unknown;
}) {
  const createdAt = nowIso();
  const eventType = text(details.eventType, 'yoco.sync.error');
  const orderId = text(details.orderId);
  const message = text(details.message, 'Yoco sync failed.');
  const payloadHash = await sha256Hex(`${workspaceId}|${eventType}|${orderId}|${message}|${createdAt}`);
  await env.DB.prepare(
    `INSERT INTO yoco_webhook_events
      (id, workspace_id, provider_event_id, event_type, yoco_order_id,
       payload_hash, status, error_message, raw_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'failed', ?7, ?8, ?9)
     ON CONFLICT(workspace_id, payload_hash) DO UPDATE SET
      status = 'failed',
      error_message = excluded.error_message,
      raw_json = excluded.raw_json`
  ).bind(
    id('yoco_evt'),
    workspaceId,
    `${eventType}:${orderId || payloadHash.slice(0, 12)}`,
    eventType,
    orderId || null,
    payloadHash,
    message,
    jsonString(details.raw || {}),
    createdAt
  ).run();
}

export async function syncYocoSales(env: Env, workspaceId: string, options: YocoSyncOptions = {}) {
  const apiKey = await getYocoApiKey(env, workspaceId);
  const syncStartedAt = nowIso();
  const syncStartedMs = Date.now();
  const webhook = await prepareYocoWebhookForSync(env, workspaceId, apiKey, options.resetWebhook === true);
  const connection = await getYocoConnection(env, workspaceId);
  const now = nowIso();
  const explicitSince = text(options.sinceIso);
  const overlapCursor = (value: unknown) => {
    const raw = text(value);
    if (!raw) return '';
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed - 6 * 60 * 60 * 1000).toISOString() : raw;
  };
  const orderCursor = text(connection?.last_successful_order_updated_at || connection?.last_sales_sync_at);
  const refundCursor = text(connection?.last_successful_refund_updated_at || connection?.last_sales_sync_at);
  const salesBaselineAt = text(connection?.sales_baseline_at);
  const clampToInitialBaseline = (candidate: string) => {
    if (!candidate || !salesBaselineAt || explicitSince || options.full) return candidate;
    const candidateMs = Date.parse(candidate);
    const baselineMs = Date.parse(salesBaselineAt);
    if (!Number.isFinite(candidateMs) || !Number.isFinite(baselineMs)) return candidate;
    return new Date(Math.max(candidateMs, baselineMs)).toISOString();
  };
  const orderLowerBound = options.full ? '' : (explicitSince || clampToInitialBaseline(overlapCursor(orderCursor)) || salesBaselineAt);
  const refundLowerBound = options.full ? '' : (explicitSince || clampToInitialBaseline(overlapCursor(refundCursor)) || salesBaselineAt);

  await recordIntegrationLog(env, workspaceId, {
    operation: 'yoco.sales.sync',
    status: 'started',
    message: 'Yoco sales reconciliation started.',
    details: {
      orderLowerBound: orderLowerBound || null,
      refundLowerBound: refundLowerBound || null,
      explicitSince: explicitSince || null,
      salesBaselineAt: salesBaselineAt || null,
      full: options.full === true,
      resetWebhook: options.resetWebhook === true,
      webhookHealthy: webhook.webhookEnabled === true && webhook.remoteVerified === true,
    },
    startedAt: syncStartedAt,
  });

  const orderDiscovery = await listYocoOrdersForSalesSync(env, apiKey, orderLowerBound, now);
  const webhookBacked = await loadWebhookBackedOrders(env, workspaceId, apiKey, orderLowerBound);
  const orderMap = new Map<string, Row>();
  [...orderDiscovery.orders, ...webhookBacked.orders].forEach((order) => {
    const orderId = yocoOrderIdValue(order);
    if (orderId) orderMap.set(orderId, order);
  });
  const orders = [...orderMap.values()];
  const refunds = await listRefunds(env, apiKey, refundLowerBound ? {
    updated_at__gte: refundLowerBound,
    updated_at__lte: now
  } : { updated_at__lte: now });

  await recordIntegrationLog(env, workspaceId, {
    operation: 'yoco.sales.discovery',
    status: webhookBacked.failures.length ? 'warning' : 'success',
    message: orders.length
      ? `Discovered ${orders.length} unique Yoco order(s) for reconciliation.`
      : 'No Yoco orders were returned for the reconciliation window.',
    details: {
      listStrategy: orderDiscovery.strategy,
      ordersFromList: orderDiscovery.orders.length,
      webhookCandidates: webhookBacked.candidateCount,
      ordersLoadedFromWebhookReferences: webhookBacked.orders.length,
      uniqueOrders: orders.length,
      filterAttemptErrors: orderDiscovery.attemptErrors,
      webhookOrderLoadFailures: webhookBacked.failures,
      orderLowerBound: orderLowerBound || null,
      webhookCandidateFloor: webhookBacked.floor,
    },
  });

  let ordersProcessed = 0;
  let refundsProcessed = 0;
  let ordersSkipped = 0;
  let refundsSkipped = 0;
  let missingRecipes = 0;
  let stockMovements = 0;
  let orderLines = 0;
  let orderErrors = 0;
  let refundErrors = 0;
  let retryableOrders = 0;
  let retryableRefunds = 0;
  let duplicateOrders = 0;
  let duplicateRefunds = 0;
  const errors: string[] = [];
  const warnings: string[] = webhookBacked.failures.map((failure) => `Webhook-backed order could not be loaded: ${failure}`);
  const reasonCounts: Record<string, number> = {};
  const countReason = (reason: unknown) => {
    const key = text(reason, 'processed');
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  };

  for (const order of orders as Row[]) {
    const orderId = text((order as Row).id || (order as Row).order_id || (order as Row).orderId);
    try {
      const fullOrder = orderId
        ? await fetchOrder(env, apiKey, orderId).catch(() => order) as Row
        : order;
      const result = await processYocoOrder(env, workspaceId, fullOrder, { mode: 'sale', eventType: 'yoco.sync.sale' });
      countReason(result.reason);
      stockMovements += Number(result.stockMovements || 0);
      orderLines += Number(result.orderLines || 0);
      missingRecipes += Number(result.missingRecipes || 0);
      if (result.reason === 'duplicate') duplicateOrders += 1;
      await updateWebhookSaleOutcome(env, workspaceId, orderId, result);
      if (result.retryable) {
        retryableOrders += 1;
        const message = result.reason === 'order_not_paid_or_completed'
          ? `Order ${orderId || 'unknown'} was found, but Yoco has not yet returned it in a paid/completed state.`
          : `Order ${orderId || 'unknown'} remains retryable because ${result.missingRecipes || 0} product/recipe component(s) could not deduct stock.`;
        warnings.push(message);
        await recordYocoSyncError(env, workspaceId, {
          eventType: 'yoco.sync.sale.retryable',
          orderId,
          message,
          raw: { order, result }
        });
        await recordIntegrationLog(env, workspaceId, {
          operation: 'yoco.sale.deduction',
          status: 'warning',
          message,
          details: { orderId, result },
        });
      }
      if (result.processed && !result.retryable) ordersProcessed += 1;
      else if (!result.processed || result.retryable) ordersSkipped += 1;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      orderErrors += 1;
      errors.push(message);
      await recordYocoSyncError(env, workspaceId, {
        eventType: 'yoco.sync.sale',
        orderId,
        message,
        raw: order
      });
      await recordIntegrationLog(env, workspaceId, {
        operation: 'yoco.sale.deduction',
        status: 'failed',
        message,
        details: { orderId },
      });
    }
  }

  for (const refund of refunds as Row[]) {
    const orderId = text((refund as Row).original_order_id || (refund as Row).order_id);
    try {
      if (!orderId) {
        refundsSkipped += 1;
        countReason('refund_missing_order_id');
        continue;
      }
      const order = await fetchOrder(env, apiKey, orderId) as Row;
      const result = await processYocoOrder(env, workspaceId, order, {
        mode: 'refund',
        refund,
        eventType: 'yoco.sync.refund'
      });
      countReason(result.reason);
      stockMovements += Number(result.stockMovements || 0);
      orderLines += Number(result.orderLines || 0);
      missingRecipes += Number(result.missingRecipes || 0);
      if (result.reason === 'duplicate') duplicateRefunds += 1;
      if (result.retryable) {
        retryableRefunds += 1;
        const message = `Refund for order ${orderId} remains retryable because ${result.missingRecipes || 0} product/recipe component(s) could not update stock.`;
        warnings.push(message);
        await recordYocoSyncError(env, workspaceId, {
          eventType: 'yoco.sync.refund.retryable',
          orderId,
          message,
          raw: { refund, result }
        });
        await recordIntegrationLog(env, workspaceId, {
          operation: 'yoco.refund.deduction',
          status: 'warning',
          message,
          details: { orderId, result },
        });
      }
      if (result.processed && !result.retryable) refundsProcessed += 1;
      else if (!result.processed || result.retryable) refundsSkipped += 1;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      refundErrors += 1;
      errors.push(message);
      await recordYocoSyncError(env, workspaceId, {
        eventType: 'yoco.sync.refund',
        orderId,
        message,
        raw: refund
      });
      await recordIntegrationLog(env, workspaceId, {
        operation: 'yoco.refund.deduction',
        status: 'failed',
        message,
        details: { orderId },
      });
    }
  }

  const orderCursorBlocked = orderErrors > 0 || retryableOrders > 0 || webhookBacked.failures.length > 0;
  const refundCursorBlocked = refundErrors > 0 || retryableRefunds > 0;
  const healthError = text((webhook as Row).error);
  const firstProblem = errors[0] || warnings[0] || healthError || '';
  await env.DB.prepare(
    `UPDATE yoco_connections
        SET last_sales_sync_at = ?2,
            last_successful_order_updated_at = CASE WHEN ?3 = 0 THEN ?2 ELSE last_successful_order_updated_at END,
            last_successful_refund_updated_at = CASE WHEN ?4 = 0 THEN ?2 ELSE last_successful_refund_updated_at END,
            last_error = ?5,
            status = CASE WHEN ?6 = 1 THEN 'connected' ELSE 'error' END,
            updated_at = ?2
      WHERE workspace_id = ?1`
  ).bind(
    workspaceId,
    now,
    orderCursorBlocked ? 1 : 0,
    refundCursorBlocked ? 1 : 0,
    firstProblem,
    webhook.webhookEnabled === true && webhook.remoteVerified === true ? 1 : 0,
  ).run();

  const result = {
    ordersFetched: orders.length,
    ordersFromList: orderDiscovery.orders.length,
    webhookOrderCandidates: webhookBacked.candidateCount,
    ordersLoadedFromWebhookReferences: webhookBacked.orders.length,
    orderDiscoveryStrategy: orderDiscovery.strategy,
    orderDiscoveryErrors: orderDiscovery.attemptErrors,
    webhookOrderLoadFailures: webhookBacked.failures,
    refundsFetched: (refunds as Row[]).length,
    ordersProcessed,
    refundsProcessed,
    ordersSkipped,
    refundsSkipped,
    retryableOrders,
    retryableRefunds,
    duplicateOrders,
    duplicateRefunds,
    missingRecipes,
    stockMovements,
    orderLines,
    reasonCounts,
    orderCursorAdvanced: !orderCursorBlocked,
    refundCursorAdvanced: !refundCursorBlocked,
    orderLowerBound: orderLowerBound || null,
    refundLowerBound: refundLowerBound || null,
    webhook,
    warnings,
    errors,
  };

  await recordIntegrationLog(env, workspaceId, {
    operation: 'yoco.sales.sync',
    status: errors.length ? 'failed' : warnings.length || webhook.webhookEnabled !== true ? 'warning' : 'success',
    message: errors.length
      ? `Yoco sales reconciliation completed with ${errors.length} error(s).`
      : warnings.length
        ? `Yoco sales reconciliation completed with ${warnings.length} retryable warning(s).`
        : `Yoco sales reconciliation completed with ${stockMovements} stock movement(s).`,
    details: result,
    startedAt: syncStartedAt,
    completedAt: nowIso(),
    durationMs: Date.now() - syncStartedMs,
  });

  return result;
}

export async function retryFailedYocoOrders(
  env: Env,
  workspaceId: string,
  options: { automatic?: boolean; maxAutomaticLookbackDays?: number } = {},
) {
  const automatic = options.automatic === true;
  const stats = await env.DB.prepare(
    `SELECT COUNT(*) AS error_count,
            MIN(created_at) AS earliest_error_at,
            MAX(created_at) AS latest_error_at
       FROM yoco_webhook_events
      WHERE workspace_id = ?1
        AND status IN ('failed', 'rejected', 'attention')`,
  ).bind(workspaceId).first<Row>();
  const errorCount = Number(stats?.error_count || 0) || 0;
  if (!errorCount) {
    return { status: 'nothing_to_retry', errorCount: 0, ordersProcessed: 0, refundsProcessed: 0, errors: [] };
  }

  let earliest = text(stats?.earliest_error_at);
  if (!earliest) earliest = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (automatic) {
    const maxDays = Math.max(1, Number(options.maxAutomaticLookbackDays || 31) || 31);
    const floor = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const parsed = Date.parse(earliest);
    if (!Number.isFinite(parsed) || parsed < floor) earliest = new Date(floor).toISOString();
  }

  // Pull a six-hour overlap before the oldest error. Yoco sale/refund ingestion and stock
  // movements are idempotent, so this safely recovers delayed orders without duplicating deductions.
  const parsedEarliest = Date.parse(earliest);
  const sinceIso = new Date((Number.isFinite(parsedEarliest) ? parsedEarliest : Date.now()) - 6 * 60 * 60 * 1000).toISOString();
  const result = await syncYocoSales(env, workspaceId, { sinceIso });
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const retryableCount = Number(result.retryableOrders || 0) + Number(result.retryableRefunds || 0);
  if (!errors.length && retryableCount === 0) {
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET status = 'processed',
              processed_at = ?2,
              error_message = ''
        WHERE workspace_id = ?1
          AND status IN ('failed', 'rejected', 'attention')
          AND datetime(created_at) >= datetime(?3)`,
    ).bind(workspaceId, nowIso(), sinceIso).run();
  }
  return {
    status: errors.length ? 'retry_completed_with_errors' : retryableCount ? 'retry_completed_with_attention' : 'retried',
    errorCount,
    earliestErrorAt: text(stats?.earliest_error_at),
    latestErrorAt: text(stats?.latest_error_at),
    sinceIso,
    ordersProcessed: Number(result.ordersProcessed || 0),
    refundsProcessed: Number(result.refundsProcessed || 0),
    missingRecipes: Number(result.missingRecipes || 0),
    retryableOrders: Number(result.retryableOrders || 0),
    retryableRefunds: Number(result.retryableRefunds || 0),
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    errors,
  };
}
