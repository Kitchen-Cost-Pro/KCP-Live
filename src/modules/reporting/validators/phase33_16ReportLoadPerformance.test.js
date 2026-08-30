import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
const reportingRoutes = read('cloudflare-v2/src/legacy/reporting-routes.ts');
const reportLoader = read('src/modules/reporting/api/reportPageLoader.js');
const reportViewer = read('src/modules/reporting/ReportViewer.js');
const tenantMigrations = read('cloudflare-v2/src/tenant-migrations.ts');
const schedulingRoutes = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');
const schedulingPage = read('src/modules/reporting/scheduling/SchedulingPage.js');

test('Phase 33.16 canonicalizes duplicate Yoco order and order-line sources before reporting', () => {
  assert.match(reportingRoutes, /ranked_yoco_orders/);
  assert.match(reportingRoutes, /PARTITION BY yo\.workspace_id/);
  assert.match(reportingRoutes, /sourceDeduplicated: true/);
  assert.match(reportingRoutes, /serverPaginated: true/);
  assert.match(reportingRoutes, /COUNT\(\*\) OVER\(\) AS __total_rows/);
  assert.match(reportingRoutes, /LIMIT \?\$\{limitBind\} OFFSET \?\$\{offsetBind\}/);
  assert.match(reportingRoutes, /ROW_NUMBER\(\) OVER \([\s\S]*yol_source\.yoco_line_id/);
});

test('Phase 33.16 prevents repeated pages and table controls from rerunning the complete report', () => {
  assert.match(reportLoader, /paginationStalled/);
  assert.match(reportLoader, /duplicateRowsRemoved/);
  assert.match(reportLoader, /canonicalReportRowKey/);
  assert.match(reportViewer, /latestResult/);
  assert.match(reportViewer, /draw\(\{ reload: false \}\)/);
});

test('Phase 33.16 adds Yoco report source indexes and requires the matching Worker', () => {
  assert.match(tenantMigrations, /idx_yoco_orders_workspace_business_key/);
  assert.match(tenantMigrations, /idx_yoco_order_lines_workspace_order_line/);
  assert.match(tenantMigrations, /_kcp_yoco_order_dedupe/);
  assert.match(tenantMigrations, /CREATE UNIQUE INDEX IF NOT EXISTS ux_yoco_orders_workspace_business_key/);
  assert.match(schedulingRoutes, /schedulerVersion: '33\.19'/);
  assert.match(schedulingPage, /minor >= 19/);
});
