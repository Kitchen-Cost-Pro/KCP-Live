import type { Env } from '../../legacy/types';
import {
  executeYocoV2ApiRequest,
  YocoV2ApiClientError,
  type YocoV2ApiClientEnv,
} from './api-client';

type Row = Record<string, unknown>;

export { YocoV2ApiClientError as YocoApiError };

export function isYocoRateLimitError(value: unknown): value is YocoV2ApiClientError {
  return value instanceof YocoV2ApiClientError && value.status === 429;
}

const LIST_KEYS = [
  'items', 'results', 'locations', 'orders', 'refunds', 'categories',
  'item_categories', 'itemCategories', 'brands', 'item_brands', 'itemBrands',
  'modifier_groups', 'modifierGroups', 'modifiers', 'modifier_items', 'modifierItems',
  'modifier_options', 'modifierOptions', 'product_modifiers', 'productModifiers',
  'option_modifiers', 'optionModifiers', 'add_on_modifiers', 'addOnModifiers',
  'note_modifiers', 'noteModifiers', 'text_modifiers', 'textModifiers',
  'options', 'choices', 'values', 'entries', 'subscriptions', 'webhooks',
];

function listData(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  const row = page && typeof page === 'object' ? page as Row : {};
  const containers = [row, row.data, row.result, row.payload]
    .filter((value): value is Row => Boolean(value && typeof value === 'object' && !Array.isArray(value)));
  const collected: unknown[] = [];
  for (const container of containers) {
    if (Array.isArray(container.data)) collected.push(...container.data);
    for (const key of LIST_KEYS) {
      const value = container[key];
      const normalizedKey = key.toLowerCase();
      const collectionKind = normalizedKey.includes('note') || normalizedKey.includes('text')
        ? 'note'
        : normalizedKey.includes('product') && normalizedKey.includes('modifier')
          ? 'product'
          : (normalizedKey.includes('option') || normalizedKey.includes('add_on') || normalizedKey.includes('addon')) && normalizedKey.includes('modifier')
            ? 'option'
            : '';
      const decorate = (entry: unknown, entryId = '') => {
        const child = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Row : {};
        if (Object.keys(child).length) return {
          ...child,
          id: child.id || child.uuid || entryId || undefined,
          ...(collectionKind ? { _kcp_collection_key: key, _kcp_modifier_kind: child._kcp_modifier_kind || child.type || child.kind || collectionKind } : {}),
        };
        return {
          id: entryId || undefined,
          name: String(entry ?? entryId),
          value: entry,
          ...(collectionKind ? { _kcp_collection_key: key, _kcp_modifier_kind: collectionKind } : {}),
        };
      };
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collected.push(decorate(entry, `${key}:${index + 1}`)));
        continue;
      }
      if (value && typeof value === 'object') {
        Object.entries(value as Row).forEach(([entryId, entry]) => collected.push(decorate(entry, entryId)));
      }
    }
    if (collected.length) break;
  }
  const deduped = new Map<string, unknown>();
  collected.forEach((entry, index) => {
    const entryRow = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Row : {};
    const key = String(
      entryRow.id || entryRow.uuid || entryRow.modifier_id || entryRow.modifierId ||
      `${entryRow._kcp_modifier_kind || entryRow._kcp_collection_key || ''}:${entryRow.option_id || entryRow.optionId || entryRow.name || `row:${index}`}`
    );
    if (!deduped.has(key)) deduped.set(key, entry);
  });
  return [...deduped.values()];
}

function nextCursor(page: unknown): string {
  const row = page && typeof page === 'object' ? page as Row : {};
  const containers = [row, row.data, row.result, row.payload, row.meta, row.links]
    .filter((value): value is Row => Boolean(value && typeof value === 'object' && !Array.isArray(value)));
  for (const container of containers) {
    const pagination = container.pagination && typeof container.pagination === 'object'
      ? container.pagination as Row
      : {};
    const links = container.links && typeof container.links === 'object' ? container.links as Row : {};
    const cursor = container.next_cursor || container.nextCursor || container.next_page_token || container.nextPageToken ||
      pagination.next_cursor || pagination.nextCursor || pagination.next_page_token || pagination.nextPageToken ||
      pagination.cursor || links.next_cursor || links.nextCursor;
    if (cursor) return String(cursor);
    const nextUrl = container.next || pagination.next || links.next;
    if (nextUrl) {
      try {
        const url = new URL(String(nextUrl), 'https://api.yoco.com');
        return url.searchParams.get('cursor') || url.searchParams.get('page_token') || url.searchParams.get('pageToken') || '';
      } catch {}
    }
  }
  return '';
}

function objectData(page: unknown): unknown {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return page;
  const row = page as Row;
  for (const key of ['data', 'result', 'payload']) {
    const value = row[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return page;
}

function traceId(workspaceId: string, endpointName: string) {
  return `yoco-v2-admin:${workspaceId}:${endpointName}:${crypto.randomUUID()}`;
}

async function requestRaw(
  env: Env,
  workspaceId: string,
  apiKey: string,
  endpointName: string,
  path: string,
  options: { method?: string; params?: Record<string, unknown>; body?: unknown; resourceId?: string } = {},
): Promise<unknown> {
  const result = await executeYocoV2ApiRequest<unknown>(env as YocoV2ApiClientEnv, {
    workspaceId,
    integrationId: `yoco:${workspaceId}`,
    traceId: traceId(workspaceId, endpointName),
    endpointName,
    resourceId: options.resourceId,
    method: options.method || 'GET',
    path,
    params: options.params,
    body: options.body,
    apiKeyOverride: apiKey,
    cacheTtlMs: 0,
    forceRefresh: true,
  });
  if (!result.found) {
    throw new YocoV2ApiClientError({
      message: `Yoco resource was not found for ${endpointName}.`,
      status: 404,
      category: 'VALIDATION_ERROR',
      code: 'YOCO_V2_API_NOT_FOUND',
      retryable: false,
    });
  }
  return result.data;
}

async function listAllPages(
  env: Env,
  workspaceId: string,
  apiKey: string,
  endpointName: string,
  path: string,
  params: Record<string, unknown> = {},
) {
  const rows: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor = String(params.cursor || '');
  let pageCount = 0;
  do {
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
    const page = await requestRaw(env, workspaceId, apiKey, endpointName, path, {
      params: { ...params, cursor: cursor || undefined, limit: params.limit || 100 },
    });
    rows.push(...listData(page));
    cursor = nextCursor(page);
    pageCount += 1;
  } while (cursor && pageCount < 100);
  return rows;
}

async function listFirstAvailable(
  env: Env,
  workspaceId: string,
  apiKey: string,
  endpointName: string,
  paths: string[],
  params: Record<string, unknown> = {},
) {
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      return await listAllPages(env, workspaceId, apiKey, endpointName, path, params);
    } catch (caught) {
      lastError = caught;
      if (!(caught instanceof YocoV2ApiClientError) || caught.status !== 404) throw caught;
    }
  }
  throw lastError;
}

export const listLocations = (env: Env, workspaceId: string, apiKey: string) =>
  listAllPages(env, workspaceId, apiKey, 'catalog.locations.list', '/v1/locations/');

export async function listItems(env: Env, workspaceId: string, apiKey: string) {
  // Yoco workspaces can expose product, option and note modifier assignments only on the item
  // payload. Prefer the expanded catalogue response, but fall back to the long-standing basic
  // expansion when an account/API version does not accept one of the modifier expansion names.
  const expansionAttempts = [
    ['category', 'brand', 'modifier_groups', 'variants', 'variants.modifier_groups'],
    ['category', 'brand', 'modifier_groups'],
    ['category', 'brand'],
  ];
  let lastError: unknown = null;
  for (const expand of expansionAttempts) {
    try {
      return await listAllPages(env, workspaceId, apiKey, 'catalog.items.list', '/v1/items/', { expand });
    } catch (caught) {
      lastError = caught;
      if (!(caught instanceof YocoV2ApiClientError) || ![400, 404, 422].includes(caught.status)) throw caught;
    }
  }
  throw lastError;
}

export const listItemsForLocation = (env: Env, workspaceId: string, apiKey: string, locationId: string) =>
  listAllPages(env, workspaceId, apiKey, 'catalog.items.location.list', '/v1/items/', {
    location_id: locationId,
    expand: ['category', 'brand', 'price_overrides', 'location_availability'],
  });

export const listItemCategories = (env: Env, workspaceId: string, apiKey: string) =>
  listFirstAvailable(env, workspaceId, apiKey, 'catalog.item_categories.list', ['/v1/item-categories/', '/v1/item_categories/']);

export const listItemBrands = (env: Env, workspaceId: string, apiKey: string) =>
  listFirstAvailable(env, workspaceId, apiKey, 'catalog.item_brands.list', ['/v1/item-brands/', '/v1/item_brands/']);

export async function listModifierGroups(env: Env, workspaceId: string, apiKey: string) {
  // Request fully expanded modifier groups when supported. Accounts/API revisions that reject an
  // expansion fall back to the basic list and are hydrated group-by-group below.
  const attempts: Record<string, unknown>[] = [
    { expand: ['modifiers', 'options', 'product_modifiers', 'option_modifiers', 'note_modifiers'] },
    { expand: ['modifiers', 'options'] },
    {},
  ];
  let lastError: unknown = null;
  for (const params of attempts) {
    try {
      return await listFirstAvailable(
        env, workspaceId, apiKey, 'catalog.modifier_groups.list',
        ['/v1/modifier_groups/', '/v1/modifier-groups/'], params,
      );
    } catch (caught) {
      lastError = caught;
      if (!(caught instanceof YocoV2ApiClientError) || ![400, 404, 422].includes(caught.status)) throw caught;
    }
  }
  throw lastError;
}

export async function fetchModifierGroup(env: Env, workspaceId: string, apiKey: string, modifierGroupId: string) {
  let lastError: unknown = null;
  const encoded = encodeURIComponent(modifierGroupId);
  const paths = [
    `/v1/modifier_groups/${encoded}/`,
    `/v1/modifier_groups/${encoded}`,
    `/v1/modifier-groups/${encoded}/`,
    `/v1/modifier-groups/${encoded}`,
  ];
  const expansionAttempts: Record<string, unknown>[] = [
    { expand: ['modifiers', 'options', 'product_modifiers', 'option_modifiers', 'note_modifiers'] },
    { expand: ['modifiers', 'options'] },
    {},
  ];
  for (const path of paths) {
    for (const params of expansionAttempts) {
      try {
        return objectData(await requestRaw(
          env,
          workspaceId,
          apiKey,
          'catalog.modifier_group.detail',
          path,
          { resourceId: modifierGroupId, params },
        ));
      } catch (caught) {
        lastError = caught;
        if (!(caught instanceof YocoV2ApiClientError) || ![400, 404, 422].includes(caught.status)) throw caught;
      }
    }
  }
  throw lastError;
}


export async function listModifierGroupChildren(env: Env, workspaceId: string, apiKey: string, modifierGroupId: string) {
  // Some Yoco catalogue versions return a group summary/detail without expanding its option
  // collection. Probe the supported child-resource aliases only for those incomplete groups.
  const encoded = encodeURIComponent(modifierGroupId);
  const paths = [
    `/v1/modifier_groups/${encoded}/modifiers/`,
    `/v1/modifier-groups/${encoded}/modifiers/`,
    `/v1/modifier_groups/${encoded}/options/`,
    `/v1/modifier-groups/${encoded}/options/`,
    `/v1/modifier_groups/${encoded}/items/`,
    `/v1/modifier-groups/${encoded}/items/`,
    `/v1/modifier_groups/${encoded}/entries/`,
    `/v1/modifier-groups/${encoded}/entries/`,
    `/v1/modifier_groups/${encoded}/choices/`,
    `/v1/modifier-groups/${encoded}/choices/`,
  ];
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      const rows = await listAllPages(env, workspaceId, apiKey, 'catalog.modifier_group.children.list', path);
      if (rows.length) return rows;
    } catch (caught) {
      lastError = caught;
      if (!(caught instanceof YocoV2ApiClientError) || ![400, 404, 405, 422].includes(caught.status)) throw caught;
    }
  }
  if (lastError && !(lastError instanceof YocoV2ApiClientError)) throw lastError;
  return [];
}

export const listWebhookSubscriptions = (env: Env, workspaceId: string, apiKey: string) =>
  listAllPages(env, workspaceId, apiKey, 'webhook.subscriptions.list', '/v1/webhooks/subscriptions/');

export const deleteWebhookSubscription = (env: Env, workspaceId: string, apiKey: string, subscriptionId: string) =>
  requestRaw(env, workspaceId, apiKey, 'webhook.subscription.delete', `/v1/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE', resourceId: subscriptionId,
  });

export const createWebhookSubscription = (env: Env, workspaceId: string, apiKey: string, body: Record<string, unknown>) =>
  requestRaw(env, workspaceId, apiKey, 'webhook.subscription.create', '/v1/webhooks/subscriptions/', { method: 'POST', body });

export const fetchWebhookSubscription = (env: Env, workspaceId: string, apiKey: string, subscriptionId: string) =>
  requestRaw(env, workspaceId, apiKey, 'webhook.subscription.detail', `/v1/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    resourceId: subscriptionId,
  }).then(objectData);

export const testWebhookSubscription = (
  env: Env,
  workspaceId: string,
  apiKey: string,
  subscriptionId: string,
  eventType = 'order.completed',
) => requestRaw(env, workspaceId, apiKey, 'webhook.subscription.test', `/v1/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}/test`, {
  method: 'POST', body: { event_type: eventType }, resourceId: subscriptionId,
});

export const validateYocoConnection = async (env: Env, workspaceId: string, apiKey: string) => {
  await requestRaw(env, workspaceId, apiKey, 'connection.validate.locations', '/v1/locations/', { params: { limit: 1 } });
  await requestRaw(env, workspaceId, apiKey, 'connection.validate.orders', '/v1/orders/', { params: { limit: 1, status: ['completed'] } });
};
