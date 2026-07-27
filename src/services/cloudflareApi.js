const VITE_ENV = import.meta.env || {};

export const CLOUDFLARE_API_URL = String(
  VITE_ENV.VITE_CLOUDFLARE_API_URL ||
  VITE_ENV.VITE_KCP_API_BASE_URL ||
  (VITE_ENV.DEV ? 'http://127.0.0.1:8787' : '')
).replace(/\/+$/, '');

export const CLOUD_SESSION_STORAGE_KEY = 'kcp:cloud-session:v1';

export function getCloudSession() {
  try {
    const raw = window.localStorage.getItem(CLOUD_SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setCloudSession(session) {
  const previousToken = String(getCloudSession()?.token || '').trim();
  const nextToken = String(session?.token || '').trim();
  try {
    if (nextToken) window.localStorage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(CLOUD_SESSION_STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in private contexts; callers still receive the session object.
  }
  if (previousToken !== nextToken) {
    clearApiCache();
    clearUnsupportedWorkspaceRouteCache();
  }
}

export function clearCloudSession() {
  setCloudSession(null);
}

export function getCloudSessionToken() {
  return String(getCloudSession()?.token || '').trim();
}

// --- Short-TTL client GET cache + in-flight dedupe -------------------------------------------
// Every tab switch/refresh previously re-downloaded everything from scratch (no cache, no dedupe).
// This caches GET responses briefly and coalesces concurrent identical GETs so shared resources
// (locations, stock, suppliers, settings) aren't fetched 2-4x per tab load or re-fetched on every
// tab switch. Any write (non-GET) clears the cache; explicit refreshes call clearApiCache() too.
const GET_CACHE_TTL_MS = 30000;
const apiGetCache = new Map(); // key -> { promise, expires }
const unsupportedWorkspaceRoutes = new Set();

export function clearApiCache() {
  apiGetCache.clear();
}

export function clearUnsupportedWorkspaceRouteCache() {
  unsupportedWorkspaceRoutes.clear();
}

export async function callCloudflareRoute(path, {
  method = 'GET',
  payload,
  query,
  token = getCloudSessionToken(),
  headers = {},
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  const resourcePath = String(path || '').replace(/^\/+/, '');
  const url = createApiUrl(resourcePath);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  const requestMethod = String(method || 'GET').toUpperCase();

  // Serve/dedupe ordinary GETs from the short-lived cache. Cache entries are scoped to
  // the authenticated session so one signed-in user's workspace or permission response can
  // never be reused for another user in the same browser. Access management is always fresh.
  if (requestMethod === 'GET' && !requiresFreshGet(url.pathname)) {
    const cacheKey = `${getTokenCacheScope(token)}:${url.pathname}${url.search}`;
    const now = Date.now();
    const cached = apiGetCache.get(cacheKey);
    if (cached && cached.expires > now) return cached.promise;

    const promise = executeRequest(url, requestMethod, payload, token, headers, timeoutMs);
    apiGetCache.set(cacheKey, { promise, expires: now + GET_CACHE_TTL_MS });
    // Never cache a failed request.
    promise.catch(() => {
      if (apiGetCache.get(cacheKey)?.promise === promise) apiGetCache.delete(cacheKey);
    });
    return promise;
  }

  // Any mutation may affect any tab's data — invalidate the whole read cache on success.
  const result = await executeRequest(url, requestMethod, payload, token, headers, timeoutMs);
  clearApiCache();
  return result;
}

// A hung connection (dead socket, DO cold start with no response) would otherwise leave
// `await fetch(...)` pending forever, stranding callers (e.g. a stock take commit) in a
// permanent "saving" state with no error to recover from. This guarantees a rejection.
const REQUEST_TIMEOUT_MS = 30000;

async function executeRequest(url, requestMethod, payload, token, headers, timeoutMs = REQUEST_TIMEOUT_MS) {
  const requestHeaders = {
    'Content-Type': 'application/json',
    ...headers
  };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const requestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

  let response;
  let result = {};
  try {
    response = await fetch(url.toString(), {
      method: requestMethod,
      headers: requestHeaders,
      cache: requestMethod === 'GET' ? 'no-store' : 'default',
      body: requestMethod === 'GET' ? undefined : JSON.stringify(payload || {}),
      signal: controller.signal
    });
    // Keep the abort timer active until the response body has been consumed. Fetch can
    // resolve as soon as headers arrive; clearing the timer at that point allowed a
    // stalled body stream to leave callers in a permanent "saving" state.
    result = await response.json().catch((error) => {
      if (error?.name === 'AbortError') throw error;
      return {};
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Request timed out — please check your connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok || result.ok === false) {
    throw new Error(result.message || result.error || `Live data request failed (${response.status}).`);
  }
  return result;
}

function normalizeRequestTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return REQUEST_TIMEOUT_MS;
  return Math.min(120000, Math.max(1000, Math.round(parsed)));
}

function requiresFreshGet(pathname = '') {
  return /\/access-management$/.test(String(pathname || ''));
}

function getTokenCacheScope(token = '') {
  // This map is memory-only and never logged. Using the complete session token avoids any
  // possibility of two authenticated users sharing a cache entry through a hash collision.
  return String(token || 'anonymous');
}

export async function callCloudflareWorkspaceRoute(workspaceId, resource, {
  method = 'GET',
  payload,
  query,
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  const token = getCloudSessionToken();
  if (!token) throw new Error('Sign in before loading workspace data.');

  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace is required.');

  const url = createApiUrl(`api/workspaces/${encodeURIComponent(workspaceKey)}/${resource}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  return callCloudflareRoute(url.pathname + url.search, { method, payload, token, timeoutMs });
}

export async function callOptionalCloudflareWorkspaceRoute(workspaceId, resource, {
  method = 'GET',
  payload,
  query,
  fallback = {}
} = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  const requestMethod = String(method || 'GET').toUpperCase();
  const routeKey = `${workspaceKey}::${String(resource || '').trim()}::${requestMethod}`;
  if (unsupportedWorkspaceRoutes.has(routeKey)) return fallback;
  try {
    return await callCloudflareWorkspaceRoute(workspaceId, resource, { method, payload, query });
  } catch (error) {
    const message = String(error?.message || '');
    if (requestMethod === 'GET' && /\(404\)/.test(message)) {
      unsupportedWorkspaceRoutes.add(routeKey);
      return fallback;
    }
    throw error;
  }
}

function createApiUrl(path) {
  const resourcePath = String(path || '').replace(/^\/+/, '');
  if (CLOUDFLARE_API_URL) return new URL(`${CLOUDFLARE_API_URL}/${resourcePath}`);
  return new URL(`/${resourcePath}`, window.location.origin);
}
