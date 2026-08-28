// In-memory cache for report data fetches, keyed by workspace + resource + query. Every report
// fetch funnels through fetchReportJson() in reportingApi.js, so caching there covers every
// report and every underlying paginated resource call it makes.
//
// Invalidation has exactly two triggers, matching what was asked for:
//  1. The app already polls a cheap `data-version` endpoint (see main.js) and dispatches
//     'kcp:data-version-changed' on the window whenever it detects a real change (a sale, a GRV,
//     an adjustment, etc.). We just piggyback on that existing, already-proven signal instead of
//     inventing a second one — this fires within 15s while the Ingredients tab is open, or within
//     2 minutes otherwise.
//  2. The report page's own Refresh button, which explicitly clears the cache before reloading.
//
// Deliberately no time-based expiry beyond that: a report that hasn't been told anything changed
// keeps serving its cached result indefinitely, per what was asked for.

const cache = new Map();

function cacheKey({ workspaceId, resource, query } = {}) {
  return `${workspaceId || ''}::${resource || ''}::${JSON.stringify(query || {})}`;
}

export function getCachedReport(params) {
  return cache.get(cacheKey(params));
}

export function setCachedReport(params, data) {
  cache.set(cacheKey(params), data);
}

export function clearReportCache() {
  cache.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('kcp:data-version-changed', () => clearReportCache());
}
