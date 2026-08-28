import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// reportCache.js registers a window event listener at module load time, so `window` must exist
// before it's imported — plain `node:test` has no DOM by default.
const dom = new JSDOM('', { url: 'https://app.test' });
globalThis.window = dom.window;
globalThis.CustomEvent = dom.window.CustomEvent;

const { getCachedReport, setCachedReport, clearReportCache } = await import('./reportCache.js');

test('a cached report is returned for the same workspace/resource/query', () => {
  clearReportCache();
  const params = { workspaceId: 'ws_1', resource: 'reports/stock-control', query: { from: '2026-08-01' } };
  assert.equal(getCachedReport(params), undefined);
  setCachedReport(params, { rows: [{ id: 1 }] });
  assert.deepEqual(getCachedReport(params), { rows: [{ id: 1 }] });
});

test('a different query for the same resource is a separate cache entry (filter changes always fetch fresh)', () => {
  clearReportCache();
  const base = { workspaceId: 'ws_1', resource: 'reports/stock-control' };
  setCachedReport({ ...base, query: { from: '2026-08-01' } }, { rows: ['august'] });
  assert.equal(getCachedReport({ ...base, query: { from: '2026-09-01' } }), undefined);
  assert.deepEqual(getCachedReport({ ...base, query: { from: '2026-08-01' } }), { rows: ['august'] });
});

test('different workspaces never share a cache entry', () => {
  clearReportCache();
  const query = { from: '2026-08-01' };
  setCachedReport({ workspaceId: 'ws_1', resource: 'reports/stock-control', query }, { rows: ['ws1'] });
  assert.equal(getCachedReport({ workspaceId: 'ws_2', resource: 'reports/stock-control', query }), undefined);
});

test('clearReportCache wipes every entry, not just one resource', () => {
  clearReportCache();
  setCachedReport({ workspaceId: 'ws_1', resource: 'reports/stock-control', query: {} }, { rows: [1] });
  setCachedReport({ workspaceId: 'ws_1', resource: 'reports/sales-financial', query: {} }, { rows: [2] });
  clearReportCache();
  assert.equal(getCachedReport({ workspaceId: 'ws_1', resource: 'reports/stock-control', query: {} }), undefined);
  assert.equal(getCachedReport({ workspaceId: 'ws_1', resource: 'reports/sales-financial', query: {} }), undefined);
});

test('a kcp:data-version-changed window event clears the cache (the "something changed" signal)', () => {
  clearReportCache();
  const params = { workspaceId: 'ws_1', resource: 'reports/stock-control', query: {} };
  setCachedReport(params, { rows: [1] });
  assert.deepEqual(getCachedReport(params), { rows: [1] });
  window.dispatchEvent(new CustomEvent('kcp:data-version-changed', { detail: { workspaceId: 'ws_1', version: 'v2' } }));
  assert.equal(getCachedReport(params), undefined);
});
