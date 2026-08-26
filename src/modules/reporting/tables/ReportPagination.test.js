import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportPageSize, paginateReportRows, REPORT_PAGE_SIZES } from './ReportPagination.js';

test('all reporting tables support only 25, 50, or 100 rows per page', () => {
  assert.deepEqual(REPORT_PAGE_SIZES, [25, 50, 100]);
  assert.equal(normalizeReportPageSize(25), 25);
  assert.equal(normalizeReportPageSize('50'), 50);
  assert.equal(normalizeReportPageSize(100), 100);
  assert.equal(normalizeReportPageSize(999), 25);
});

test('report pagination clamps pages and returns accurate row ranges', () => {
  const rows = Array.from({ length: 233 }, (_, index) => ({ id: index + 1 }));
  const middle = paginateReportRows(rows, 3, 50);
  assert.equal(middle.page, 3);
  assert.equal(middle.pageCount, 5);
  assert.equal(middle.startRow, 101);
  assert.equal(middle.endRow, 150);
  assert.equal(middle.rows[0].id, 101);

  const final = paginateReportRows(rows, 99, 100);
  assert.equal(final.page, 3);
  assert.equal(final.startRow, 201);
  assert.equal(final.endRow, 233);
  assert.equal(final.rows.length, 33);
});
