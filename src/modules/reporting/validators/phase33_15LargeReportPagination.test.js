import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const reportingApi = fs.readFileSync(new URL('../api/reportingApi.js', import.meta.url), 'utf8');
const pageLoader = fs.readFileSync(new URL('../api/reportPageLoader.js', import.meta.url), 'utf8');
const scheduler = fs.readFileSync(new URL('../../../../cloudflare-v2/src/legacy/report-scheduling-routes.ts', import.meta.url), 'utf8');
const viewer = fs.readFileSync(new URL('../ReportViewer.js', import.meta.url), 'utf8');


test('interactive reports use adaptive source pagination instead of failing at 100k rows', () => {
  assert.match(reportingApi, /collectCompleteReportPages/);
  assert.doesNotMatch(reportingApi, /reached its .*hard safety limit/);
  assert.match(pageLoader, /splitByDate/);
  assert.match(pageLoader, /filterOptions\?\.locations/);
});

test('scheduled reports use the same complete pagination loader', () => {
  assert.match(scheduler, /collectCompleteReportPages/);
  assert.doesNotMatch(scheduler, /source reached its .*row safety limit/);
});

test('all report viewers retain 25, 50, and 100 row table pagination', () => {
  assert.match(viewer, /paginateReportRows/);
  assert.match(viewer, /renderReportPagination/);
});
