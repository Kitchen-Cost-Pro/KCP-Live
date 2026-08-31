import test from 'node:test';
import assert from 'node:assert/strict';
import { __reportViewerInternals } from './ReportViewer.js';

const { deriveSources, deriveCategories, extractFilterOptions } = __reportViewerInternals;

// Regression: the Source (and Category/Location) filter dropdown used to be built purely by
// scanning the CURRENTLY FILTERED rows for their source/sourceType/__apiMeta.filterOptions. Once a
// filter (a date range, or the Source dropdown itself) narrowed the rows down to a small set or zero
// rows, the dropdown's own option list collapsed with it -- so picking a source, or landing on a
// date range with no matches, left the user unable to pick any OTHER source without first resetting
// to "All sources" and re-applying. The backend already returns the full, unfiltered list at
// result.meta.filterOptions.sources (see getReportFilterOptions in reporting-routes.ts) -- it just
// wasn't being read when rows was empty.

test('extractFilterOptions reads result.meta.filterOptions directly, independent of rows', () => {
  const meta = { filterOptions: { sources: ['GRV', 'Sale Usage', 'Wastage Adjustment'] } };
  assert.deepEqual(extractFilterOptions([], 'sources', meta), ['GRV', 'Sale Usage', 'Wastage Adjustment']);
});

test('deriveSources still returns every source from meta even when the active filter has narrowed rows to just one', () => {
  const meta = { filterOptions: { sources: ['GRV', 'Sale Usage', 'Wastage Adjustment'] } };
  // Simulates having picked "GRV" as the active source filter -- rows only contain GRV rows now.
  const rows = [{ source: 'GRV' }, { source: 'GRV' }];
  const sources = deriveSources(rows, meta);
  assert.ok(sources.includes('GRV'));
  assert.ok(sources.includes('Sale Usage'), 'other sources must still be selectable, not just the currently-active one');
  assert.ok(sources.includes('Wastage Adjustment'));
});

test('deriveSources still returns every source from meta even when the filtered rows are empty (e.g. "Today" matched nothing)', () => {
  const meta = { filterOptions: { sources: ['GRV', 'Sale Usage', 'Wastage Adjustment'] } };
  const sources = deriveSources([], meta);
  assert.deepEqual(sources, ['GRV', 'Sale Usage', 'Wastage Adjustment']);
});

test('deriveCategories falls back to row-scanning when the backend has not supplied filterOptions (e.g. mock data)', () => {
  const rows = [{ category: 'Meat' }, { category: 'Dairy' }, { category: 'Meat' }];
  assert.deepEqual(deriveCategories({}, rows, {}), ['Dairy', 'Meat']);
});
