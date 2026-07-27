const DEFAULT_BASE_URL = 'https://api.yoco.com';

class YocoApiError extends Error {
  constructor(message, { status = 0, code = '', details = null, request = null } = {}) {
    super(message);
    this.name = 'YocoApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.request = request;
  }
}

async function yocoFetch(apiKey, path, options = {}) {
  const token = String(apiKey || '').trim();
  if (!token) throw new YocoApiError('Yoco API key is missing.', { status: 401, code: 'missing_key' });

  const baseUrl = options.baseUrl || process.env.YOCO_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(path, baseUrl);
  Object.entries(options.params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((entry) => url.searchParams.append(key, entry));
    } else {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const data = text ? parseJson(text) : null;
  if (!response.ok) {
    const detail = data?.detail || data?.title || data?.message || response.statusText;
    throw new YocoApiError(`Yoco API request failed: ${detail}`, {
      status: response.status,
      code: data?.code || '',
      details: data,
      request: {
        method: options.method || 'GET',
        path,
        url: `${url.origin}${url.pathname}`
      }
    });
  }
  return data;
}

async function listAllPages(apiKey, path, params = {}) {
  const results = [];
  let cursor = params.cursor || null;
  do {
    const page = await withYocoRetry(() => yocoFetch(apiKey, path, {
      params: {
        ...params,
        cursor,
        limit: params.limit || 100
      }
    }));
    const data = extractListData(page);
    results.push(...data);
    cursor = page?.next_cursor || page?.nextCursor || page?.pagination?.next_cursor || page?.pagination?.nextCursor || null;
  } while (cursor);
  return results;
}

async function listFirstAvailable(apiKey, paths = [], params = {}) {
  let lastError = null;
  for (const path of paths) {
    try {
      return await listAllPages(apiKey, path, params);
    } catch (error) {
      lastError = error;
      if (!(error instanceof YocoApiError) || error.status !== 404) throw error;
    }
  }
  throw lastError;
}

function extractListData(page) {
  if (Array.isArray(page)) return page;
  const keys = [
    'data',
    'items',
    'results',
    'locations',
    'orders',
    'refunds',
    'item_categories',
    'itemCategories',
    'categories',
    'item_brands',
    'itemBrands',
    'brands'
  ];
  for (const key of keys) {
    if (Array.isArray(page?.[key])) return page[key];
  }
  return [];
}

async function withYocoRetry(task, attempt = 0) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof YocoApiError && error.status === 429 && attempt < 3) {
      await delay(500 * (attempt + 1) * (attempt + 1));
      return withYocoRetry(task, attempt + 1);
    }
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const listLocations = (apiKey) => listAllPages(apiKey, '/v1/locations/');
const listItems = (apiKey, params = {}) => listAllPages(apiKey, '/v1/items/', params);
const fetchItem = (apiKey, itemId) => yocoFetch(apiKey, `/v1/items/${encodeURIComponent(itemId)}`);
const listItemCategories = (apiKey) => listFirstAvailable(apiKey, [
  '/v1/item-categories/',
  '/v1/item-categories',
  '/v1/item_categories/',
  '/v1/item_categories'
]);
const fetchItemCategory = (apiKey, categoryId) => yocoFetch(apiKey, `/v1/item-categories/${encodeURIComponent(categoryId)}`);
const listItemBrands = (apiKey) => listFirstAvailable(apiKey, [
  '/v1/item-brands/',
  '/v1/item-brands',
  '/v1/item_brands/',
  '/v1/item_brands'
]);
const fetchItemBrand = (apiKey, brandId) => yocoFetch(apiKey, `/v1/item-brands/${encodeURIComponent(brandId)}`);
const listOrders = (apiKey, params = {}) => listAllPages(apiKey, '/v1/orders/', params);
const fetchOrder = (apiKey, orderId) => yocoFetch(apiKey, `/v1/orders/${encodeURIComponent(orderId)}`);
const listRefunds = (apiKey, params = {}) => listAllPages(apiKey, '/v1/refunds/', params);
const fetchRefund = (apiKey, refundId) => yocoFetch(apiKey, `/v1/refunds/${encodeURIComponent(refundId)}`);

function createWebhookSubscription(apiKey, body) {
  return yocoFetch(apiKey, '/v1/webhooks/subscriptions/', {
    method: 'POST',
    body
  });
}

module.exports = {
  YocoApiError,
  createWebhookSubscription,
  fetchItem,
  fetchItemBrand,
  fetchItemCategory,
  fetchOrder,
  fetchRefund,
  listItemBrands,
  listItemCategories,
  listItems,
  listLocations,
  listOrders,
  listRefunds,
  yocoFetch
};
