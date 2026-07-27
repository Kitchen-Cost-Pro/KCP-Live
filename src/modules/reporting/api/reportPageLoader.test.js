import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCompleteReportPages } from './reportPageLoader.js';

function makeDateRows(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sale-${index + 1}`,
    date: `2026-07-${String(index + 1).padStart(2, '0')}`
  }));
}

test('large date-backed reports are split into complete non-overlapping partitions', async () => {
  const source = makeDateRows(12);
  const calls = [];
  const payload = await collectCompleteReportPages({
    resource: 'reports/sales-financial',
    baseQuery: { from: '2026-07-01', to: '2026-07-12' },
    pageSize: 2,
    today: '2026-07-12',
    fetchPage: async (query) => {
      calls.push({ ...query });
      const matching = source.filter((row) => row.date >= query.from && row.date <= query.to);
      const cap = 4;
      const capped = matching.slice(0, cap);
      const offset = Number(query.offset || 0);
      const rows = capped.slice(offset, offset + Number(query.limit || 2));
      return {
        rows,
        warnings: [],
        meta: {
          totalRows: capped.length,
          returnedRows: rows.length,
          offset,
          hasMore: offset + rows.length < capped.length,
          nextOffset: offset + rows.length,
          sourceRowCap: cap,
          truncated: matching.length >= cap
        }
      };
    }
  });

  assert.equal(payload.rows.length, 12);
  assert.deepEqual([...payload.rows.map((row) => row.id)].sort(), [...source.map((row) => row.id)].sort());
  assert.equal(payload.meta.truncated, false);
  assert.equal(payload.meta.partitioned, true);
  assert.ok(payload.meta.partitionCount >= 4);
  assert.ok(calls.some((query) => query.from !== '2026-07-01' || query.to !== '2026-07-12'));
});

test('large inventory reports split by active location when dates do not apply', async () => {
  const source = [
    { id: 'a1', locationId: 'A' }, { id: 'a2', locationId: 'A' }, { id: 'a3', locationId: 'A' },
    { id: 'b1', locationId: 'B' }, { id: 'b2', locationId: 'B' }, { id: 'b3', locationId: 'B' }
  ];
  const payload = await collectCompleteReportPages({
    resource: 'reports/stock-on-hand',
    baseQuery: {},
    pageSize: 2,
    fetchPage: async (query) => {
      const matching = query.locationId ? source.filter((row) => row.locationId === query.locationId) : source;
      const cap = 4;
      const capped = matching.slice(0, cap);
      const offset = Number(query.offset || 0);
      const rows = capped.slice(offset, offset + Number(query.limit || 2));
      return {
        rows,
        warnings: [],
        meta: {
          totalRows: capped.length,
          returnedRows: rows.length,
          offset,
          hasMore: offset + rows.length < capped.length,
          nextOffset: offset + rows.length,
          sourceRowCap: cap,
          truncated: matching.length >= cap,
          filterOptions: { locations: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }] }
        }
      };
    }
  });

  assert.equal(payload.rows.length, 6);
  assert.deepEqual(payload.rows.map((row) => row.id), source.map((row) => row.id));
  assert.equal(payload.meta.partitionCount, 2);
  assert.equal(payload.meta.partitioned, true);
});

test('ordinary reports retain API pagination and complete metadata', async () => {
  const source = Array.from({ length: 7 }, (_, index) => ({ id: index + 1 }));
  const payload = await collectCompleteReportPages({
    resource: 'reports/menu-recipe-health',
    pageSize: 3,
    fetchPage: async (query) => {
      const offset = Number(query.offset || 0);
      const rows = source.slice(offset, offset + Number(query.limit || 3));
      return {
        rows,
        warnings: [{ code: 'once', message: 'Only once' }],
        meta: {
          totalRows: source.length,
          returnedRows: rows.length,
          offset,
          hasMore: offset + rows.length < source.length,
          nextOffset: offset + rows.length,
          truncated: false
        }
      };
    }
  });

  assert.equal(payload.rows.length, 7);
  assert.equal(payload.warnings.length, 1);
  assert.equal(payload.meta.totalRows, 7);
  assert.equal(payload.meta.hasMore, false);
  assert.equal(payload.meta.partitioned, false);
});

test('repeated legacy sales pages are deduplicated and stop instead of manufacturing 100000 rows', async () => {
  let calls = 0;
  const logicalRows = [
    { id: 'db-a', sourceId: 'order-1', status: 'completed' },
    { id: 'db-b', sourceId: 'order-2', status: 'completed' },
    { id: 'db-c', sourceId: 'order-3', status: 'completed' },
    { id: 'db-d', sourceId: 'order-4', status: 'completed' }
  ];
  const payload = await collectCompleteReportPages({
    resource: 'reports/sales-financial',
    pageSize: 4,
    fetchPage: async (query) => {
      calls += 1;
      const offset = Number(query.offset || 0);
      return {
        rows: logicalRows.map((row, index) => ({ ...row, id: `${row.id}-${offset}-${index}` })),
        warnings: [],
        meta: {
          totalRows: 100000,
          returnedRows: 4,
          offset,
          hasMore: true,
          nextOffset: offset + 4,
          truncated: false
        }
      };
    }
  });

  assert.equal(calls, 2);
  assert.equal(payload.rows.length, 4);
  assert.equal(payload.meta.paginationStalled, true);
  assert.equal(payload.meta.duplicateRowsRemoved, 4);
  assert.equal(payload.meta.totalRows, 4);
});

test('an unsplittable capped partition is recovered without a customer-facing row-limit error', async () => {
  const source = [
    { id: 'row-1', itemName: 'Flour' },
    { id: 'row-2', itemName: 'Sugar' }
  ];
  const payload = await collectCompleteReportPages({
    resource: 'reports/menu-recipe-health',
    pageSize: 2,
    fetchPage: async (query) => {
      const offset = Number(query.offset || 0);
      const rows = source.slice(offset, offset + Number(query.limit || 2));
      return {
        rows,
        warnings: [],
        meta: {
          totalRows: source.length,
          returnedRows: rows.length,
          offset,
          hasMore: offset + rows.length < source.length,
          nextOffset: offset + rows.length,
          sourceRowCap: 100000,
          truncated: true,
          filterOptions: { locations: [], categories: [] }
        }
      };
    }
  });

  assert.equal(payload.rows.length, 2);
  assert.equal(payload.meta.truncated, false);
  assert.equal(payload.meta.sourceCapRecovered, true);
  assert.equal(payload.meta.sourceReportedTruncated, true);
});
