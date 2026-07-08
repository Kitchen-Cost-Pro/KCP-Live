import type { Env, DbLike, DbStatementLike } from './types';
import { decryptText, encryptText } from './crypto';
import {
  createWebhookSubscription,
  fetchOrder,
  fetchModifierGroup,
  listItemBrands,
  listItemCategories,
  listItems,
  listItemsForLocation,
  listLocations,
  listModifierGroups,
  listOrders,
  listRefunds,
  updateWebhookSubscription,
  yocoFetch
} from './yoco-client';
import { processYocoOrder } from './yoco-sales';
import { findRefund } from './yoco-webhooks';

type Row = Record<string, unknown>;

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function jsonString(value: unknown) {
  return JSON.stringify(value || {});
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
  if (value && typeof value === 'object') {
    const obj = value as Row;
    if (typeof obj.amount === 'number') return obj.amount / 100;
    if (typeof obj.value === 'number') return obj.value / 100;
  }
  if (typeof value === 'number') return Math.abs(value) > 999 ? value / 100 : value;
  const number = Number(value || 0);
  return Math.abs(number) > 999 ? number / 100 : number;
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

export async function connectYoco(env: Env, workspaceId: string, apiKey: string) {
  const cleanKey = text(apiKey);
  if (!cleanKey) throw new Error('Yoco API key is required.');

  await yocoFetch(env, cleanKey, '/v1/locations/', { params: { limit: 1 } });

  const encrypted = await encryptText(env, cleanKey);
  const baseUrl = webhookBaseUrl(env);
  let webhookEnabled = false;
  let webhookId = '';
  let webhookSecret = '';
  let webhookError = '';
  let webhookUrl = '';

  if (baseUrl) {
    webhookUrl = `${baseUrl}/webhooks/yoco/${encodeURIComponent(workspaceId)}`;
    try {
      const subscription = await createWebhookSubscription(env, cleanKey, {
        event_types: ['payment.created', 'payment.refunded'],
        name: 'Kitchen Cost Pro Cloudflare Webhook',
        notification_url: webhookUrl
      }) as Row;
      webhookEnabled = true;
      webhookId = text(subscription.id || subscription.subscription_id);
      webhookSecret = text(subscription.secret || subscription.webhook_secret);
    } catch (caught) {
      webhookError = caught instanceof Error ? caught.message : String(caught);
    }
  } else {
    webhookError = 'YOCO_WEBHOOK_BASE_URL is not configured.';
  }

  await env.DB.prepare(
    `INSERT INTO yoco_connections
      (workspace_id, status, api_key_encrypted, webhook_id, webhook_secret, webhook_url,
       connection_active, last_error, created_at, updated_at)
     VALUES (?1, 'connected', ?2, ?3, ?4, ?5, 1, ?6, datetime('now'), datetime('now'))
     ON CONFLICT(workspace_id) DO UPDATE SET
       status = 'connected',
       api_key_encrypted = excluded.api_key_encrypted,
       webhook_id = excluded.webhook_id,
       webhook_secret = excluded.webhook_secret,
       webhook_url = excluded.webhook_url,
       connection_active = 1,
       last_error = excluded.last_error,
       disconnected_at = NULL,
       updated_at = datetime('now')`
  ).bind(workspaceId, encrypted, webhookId || null, webhookSecret || null, webhookUrl || null, webhookError).run();

  return {
    connected: true,
    webhookEnabled,
    webhookId,
    webhookUrl,
    webhookError
  };
}

export async function disconnectYoco(env: Env, workspaceId: string) {
  const connection = await getYocoConnection(env, workspaceId);
  const encrypted = text(connection?.api_key_encrypted);
  const webhookId = text(connection?.webhook_id);
  let disconnectError = '';
  if (encrypted && webhookId) {
    try {
      const apiKey = await decryptText(env, encrypted);
      await updateWebhookSubscription(env, apiKey, webhookId, { enabled: false });
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
            last_error = ?3,
            disconnected_at = ?2,
            updated_at = ?2
      WHERE workspace_id = ?1`
  ).bind(workspaceId, nowIso(), disconnectError).run();
  return { disconnected: true, webhookDisabled: !disconnectError, disconnectError };
}

export async function syncYocoCatalogue(env: Env, workspaceId: string) {
  const apiKey = await getYocoApiKey(env, workspaceId);
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
    warnings: locationPricing.warnings
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

export async function syncYocoSales(env: Env, workspaceId: string, options: { full?: boolean; sinceIso?: string } = {}) {
  const apiKey = await getYocoApiKey(env, workspaceId);
  const connection = await getYocoConnection(env, workspaceId);
  const now = nowIso();
  // An explicit `sinceIso` (e.g. "last 14 days" from the admin console) overrides the stored
  // incremental cursor so admins can re-pull a fixed recent window on demand. `full` wins over both.
  const explicitSince = text(options.sinceIso);
  const orderLowerBound = options.full ? '' : (explicitSince || text(connection?.last_successful_order_updated_at || connection?.last_sales_sync_at));
  const refundLowerBound = options.full ? '' : (explicitSince || text(connection?.last_successful_refund_updated_at || connection?.last_sales_sync_at));
  const orders = await listOrders(env, apiKey, orderLowerBound ? {
    status: ['completed'],
    updated_at__gte: orderLowerBound,
    updated_at__lte: now
  } : { status: ['completed'], updated_at__lte: now });
  const refunds = await listRefunds(env, apiKey, refundLowerBound ? {
    status: ['approved'],
    updated_at__gte: refundLowerBound,
    updated_at__lte: now
  } : { status: ['approved'], updated_at__lte: now });

  let ordersProcessed = 0;
  let refundsProcessed = 0;
  let missingRecipes = 0;
  let orderErrors = 0;
  let refundErrors = 0;
  const errors: string[] = [];

  for (const order of orders as Row[]) {
    const orderId = text((order as Row).id || (order as Row).order_id || (order as Row).orderId);
    try {
      const fullOrder = orderId
        ? await fetchOrder(env, apiKey, orderId).catch(() => order) as Row
        : order;
      const result = await processYocoOrder(env, workspaceId, fullOrder, { mode: 'sale', eventType: 'yoco.sync.sale' });
      if (result.processed) ordersProcessed += 1;
      missingRecipes += result.missingRecipes || 0;
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
    }
  }

  for (const refund of refunds as Row[]) {
    const orderId = text((refund as Row).original_order_id || (refund as Row).order_id);
    try {
      if (!orderId) continue;
      const order = await fetchOrder(env, apiKey, orderId) as Row;
      const result = await processYocoOrder(env, workspaceId, order, {
        mode: 'refund',
        refund,
        eventType: 'yoco.sync.refund'
      });
      if (result.processed) refundsProcessed += 1;
      missingRecipes += result.missingRecipes || 0;
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
    }
  }

  await env.DB.prepare(
    `UPDATE yoco_connections
        SET last_sales_sync_at = ?2,
            last_successful_order_updated_at = CASE WHEN ?3 = 0 THEN ?2 ELSE last_successful_order_updated_at END,
            last_successful_refund_updated_at = CASE WHEN ?4 = 0 THEN ?2 ELSE last_successful_refund_updated_at END,
            last_error = ?5,
            updated_at = ?2
      WHERE workspace_id = ?1`
  ).bind(workspaceId, now, orderErrors, refundErrors, errors[0] || '').run();

  return { ordersProcessed, refundsProcessed, missingRecipes, errors };
}
