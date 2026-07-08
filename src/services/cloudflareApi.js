export const CLOUDFLARE_API_URL = String(
  import.meta.env.VITE_CLOUDFLARE_API_URL ||
  import.meta.env.VITE_KCP_API_BASE_URL ||
  (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '')
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
  try {
    if (session?.token) window.localStorage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(CLOUD_SESSION_STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in private contexts; callers still receive the session object.
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
  headers = {}
} = {}) {
  const resourcePath = String(path || '').replace(/^\/+/, '');
  const url = createApiUrl(resourcePath);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  const requestMethod = String(method || 'GET').toUpperCase();

  // Serve/dedupe GETs from the short-lived cache (keyed by full path+query).
  if (requestMethod === 'GET') {
    const cacheKey = url.pathname + url.search;
    const now = Date.now();
    const cached = apiGetCache.get(cacheKey);
    if (cached && cached.expires > now) return cached.promise;

    const promise = executeRequest(url, requestMethod, payload, token, headers);
    apiGetCache.set(cacheKey, { promise, expires: now + GET_CACHE_TTL_MS });
    // Never cache a failed request.
    promise.catch(() => {
      if (apiGetCache.get(cacheKey)?.promise === promise) apiGetCache.delete(cacheKey);
    });
    return promise;
  }

  // Any mutation may affect any tab's data — invalidate the whole read cache on success.
  const result = await executeRequest(url, requestMethod, payload, token, headers);
  clearApiCache();
  return result;
}

// A hung connection (dead socket, DO cold start with no response) would otherwise leave
// `await fetch(...)` pending forever, stranding callers (e.g. a stock take commit) in a
// permanent "saving" state with no error to recover from. This guarantees a rejection.
const REQUEST_TIMEOUT_MS = 30000;

async function executeRequest(url, requestMethod, payload, token, headers) {
  const requestHeaders = {
    'Content-Type': 'application/json',
    ...headers
  };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: requestMethod,
      headers: requestHeaders,
      cache: requestMethod === 'GET' ? 'no-store' : 'default',
      body: requestMethod === 'GET' ? undefined : JSON.stringify(payload || {}),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Request timed out — please check your connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result.message || result.error || `Live data request failed (${response.status}).`);
  }
  return result;
}

export async function callCloudflareWorkspaceRoute(workspaceId, resource, {
  method = 'GET',
  payload,
  query
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

  return callCloudflareRoute(url.pathname + url.search, { method, payload, token });
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
