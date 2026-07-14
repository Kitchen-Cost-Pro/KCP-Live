import type { Env } from './types';

const DEFAULT_YOCO_BASE_URL = 'https://api.yoco.com';

export class YocoApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status = 0, details: unknown = null) {
    super(message);
    this.name = 'YocoApiError';
    this.status = status;
    this.details = details;
  }
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function listData(page: any) {
  if (Array.isArray(page)) return page;
  for (const key of ['data', 'items', 'results', 'locations', 'orders', 'refunds', 'categories', 'item_categories', 'itemCategories', 'brands', 'item_brands', 'itemBrands', 'modifier_groups', 'modifierGroups']) {
    if (Array.isArray(page?.[key])) return page[key];
  }
  return [];
}

function objectData(page: any) {
  if (page?.data && typeof page.data === 'object' && !Array.isArray(page.data)) return page.data;
  if (page?.result && typeof page.result === 'object' && !Array.isArray(page.result)) return page.result;
  return page;
}

async function withYocoRetry<T>(task: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    return await task();
  } catch (caught) {
    if (caught instanceof YocoApiError && caught.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1) * (attempt + 1)));
      return withYocoRetry(task, attempt + 1);
    }
    throw caught;
  }
}

export async function yocoFetch(env: Env, apiKey: string, path: string, options: {
  method?: string;
  params?: Record<string, unknown>;
  body?: unknown;
} = {}) {
  const url = new URL(path, env.YOCO_API_BASE_URL || DEFAULT_YOCO_BASE_URL);
  Object.entries(options.params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, String(entry)));
    else url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const raw = await response.text();
  const data = raw ? parseJson(raw) : null;
  if (!response.ok) {
    const message = data?.detail || data?.title || data?.message || response.statusText;
    throw new YocoApiError(`Yoco API request failed: ${message}`, response.status, data);
  }
  return data;
}

export async function listAllPages(env: Env, apiKey: string, path: string, params: Record<string, unknown> = {}) {
  const rows: unknown[] = [];
  let cursor = params.cursor || null;
  do {
    const page = await withYocoRetry(() => yocoFetch(env, apiKey, path, {
      params: {
        ...params,
        cursor,
        limit: params.limit || 100
      }
    }));
    rows.push(...listData(page));
    cursor = page?.next_cursor || page?.nextCursor || page?.pagination?.next_cursor || null;
  } while (cursor);
  return rows;
}

async function listFirstAvailable(env: Env, apiKey: string, paths: string[], params: Record<string, unknown> = {}) {
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      return await listAllPages(env, apiKey, path, params);
    } catch (caught) {
      lastError = caught;
      if (!(caught instanceof YocoApiError) || caught.status !== 404) throw caught;
    }
  }
  throw lastError;
}

export const listLocations = (env: Env, apiKey: string) => listAllPages(env, apiKey, '/v1/locations/');
export const listItems = async (env: Env, apiKey: string) => {
  return listAllPages(env, apiKey, '/v1/items/', { expand: ['category', 'brand'] });
};
// Items with variant prices RESOLVED for a specific location (GET /v1/items/?location_id=…).
// Also expands price_overrides + location_availability so we can tell availability apart.
export const listItemsForLocation = async (env: Env, apiKey: string, locationId: string) => {
  return listAllPages(env, apiKey, '/v1/items/', {
    location_id: locationId,
    expand: ['category', 'brand', 'price_overrides', 'location_availability']
  });
};
export const listItemCategories = (env: Env, apiKey: string) => listFirstAvailable(env, apiKey, ['/v1/item-categories/', '/v1/item_categories/']);
export const listItemBrands = (env: Env, apiKey: string) => listFirstAvailable(env, apiKey, ['/v1/item-brands/', '/v1/item_brands/']);
export const listModifierGroups = (env: Env, apiKey: string) => listFirstAvailable(env, apiKey, ['/v1/modifier_groups/', '/v1/modifier-groups/']);
export const fetchModifierGroup = async (env: Env, apiKey: string, modifierGroupId: string) => {
  let lastError: unknown = null;
  for (const basePath of ['/v1/modifier_groups/', '/v1/modifier-groups/']) {
    try {
      return objectData(await yocoFetch(
        env,
        apiKey,
        `${basePath}${encodeURIComponent(modifierGroupId)}`
      ));
    } catch (caught) {
      lastError = caught;
      if (!(caught instanceof YocoApiError) || caught.status !== 404) throw caught;
    }
  }
  throw lastError;
};
export const listOrders = (env: Env, apiKey: string, params: Record<string, unknown> = {}) => listAllPages(env, apiKey, '/v1/orders/', params);
export const listRefunds = (env: Env, apiKey: string, params: Record<string, unknown> = {}) => listAllPages(env, apiKey, '/v1/refunds/', params);

export async function listOrdersPage(env: Env, apiKey: string, params: Record<string, unknown> = {}) {
  const page = await withYocoRetry(() => yocoFetch(env, apiKey, '/v1/orders/', {
    params: { ...params, limit: params.limit || 100 }
  }));
  return {
    rows: listData(page),
    nextCursor: page?.next_cursor || page?.nextCursor || page?.pagination?.next_cursor || null
  };
}

export const fetchOrder = async (env: Env, apiKey: string, orderId: string) => objectData(await yocoFetch(env, apiKey, `/v1/orders/${encodeURIComponent(orderId)}`));


export const listWebhookSubscriptions = (env: Env, apiKey: string) => listAllPages(env, apiKey, '/v1/webhooks/subscriptions/');

export function deleteWebhookSubscription(env: Env, apiKey: string, subscriptionId: string) {
  return yocoFetch(env, apiKey, `/v1/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
}

export function createWebhookSubscription(env: Env, apiKey: string, body: Record<string, unknown>) {
  return yocoFetch(env, apiKey, '/v1/webhooks/subscriptions/', { method: 'POST', body });
}

export function updateWebhookSubscription(env: Env, apiKey: string, subscriptionId: string, body: Record<string, unknown>) {
  return yocoFetch(env, apiKey, `/v1/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    body
  });
}


export const fetchWebhookSubscription = async (env: Env, apiKey: string, subscriptionId: string) => (
  objectData(await yocoFetch(env, apiKey, `/v1/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`))
);

export function testWebhookSubscription(
  env: Env,
  apiKey: string,
  subscriptionId: string,
  eventType = 'payment.created',
) {
  return yocoFetch(env, apiKey, `/v1/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}/test`, {
    method: 'POST',
    body: { event_type: eventType }
  });
}
