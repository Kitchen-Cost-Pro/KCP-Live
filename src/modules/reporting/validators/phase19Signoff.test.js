import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportingQuery, isReportingMockDataEnabled } from '../api/reportingEndpoints.js';
import { normalizeWarning, WARNING_CATEGORIES } from './warningCategories.js';
import {
  auditExportDefinitions,
  auditFinalDashboardTiles,
  auditGroupedAndSingleReportViews,
  auditOldReportRedirects,
  auditPerformanceRecommendations,
  auditRequiredTooltips,
  buildPhase19ReportingSignoff,
  FINAL_DASHBOARD_TILE_IDS
} from './phase19Signoff.js';

const rootDir = process.cwd();
const reportingDir = path.join(rootDir, 'src/modules/reporting');

test('Phase 19 final dashboard exposes only the approved reporting tiles', () => {
  const audit = auditFinalDashboardTiles();
  assert.equal(audit.ok, true, JSON.stringify(audit, null, 2));
  assert.deepEqual(new Set(audit.visibleIds), new Set(FINAL_DASHBOARD_TILE_IDS));
  assert.deepEqual(audit.duplicateIdsVisible, []);
});

test('Phase 19 grouped and single report view contracts are locked', () => {
  const audit = auditGroupedAndSingleReportViews();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
});

test('Phase 19 old report IDs redirect to grouped or consolidated reports', () => {
  const audit = auditOldReportRedirects();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
});

test('Phase 19 mock data is off by default and report files do not import mock data directly', () => {
  assert.equal(isReportingMockDataEnabled({}), false);
  const files = listJsFiles(reportingDir)
    .filter((file) => !file.endsWith('mockReportData.js'))
    .filter((file) => !file.endsWith('.test.js'));
  const directMockImports = files.filter((file) => /from ['"].*mockReportData|import\(['"].*mockReportData/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(directMockImports.map((file) => path.relative(rootDir, file)), []);
});

test('Phase 19 export definitions are view-specific and exclude UI/internal fields', () => {
  const audit = auditExportDefinitions();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
});

test('Phase 19 table row formula cells expose the shared tooltip data attribute', () => {
  const tableSource = fs.readFileSync(path.join(reportingDir, 'tables/ReportTable.js'), 'utf8');
  assert.match(tableSource, /data-report-tooltip/);
  assert.match(tableSource, /column\.cellTooltip/);
});

test('Phase 19 required calculation tooltips are present', () => {
  const audit = auditRequiredTooltips();
  assert.equal(audit.ok, true, JSON.stringify(audit.missing, null, 2));
});

test('Phase 19 warnings classify no-data messages as coverage notes, not critical issues', () => {
  const coverage = normalizeWarning({ code: 'no-credit-note-source-rows', level: 'info', message: 'No Credit Note movements found for the selected filters.' });
  const critical = normalizeWarning({ code: 'gross-equals-net-with-vat', level: 'critical', message: 'Gross equals Net while VAT is expected.' });
  const backend = normalizeWarning({ code: 'backend-ledger-mapping-gap', level: 'warning', message: 'Backend mapping gap for YOCO product not mapped.' });
  assert.equal(coverage.category, WARNING_CATEGORIES.coverage);
  assert.equal(critical.category, WARNING_CATEGORIES.critical);
  assert.equal(backend.category, WARNING_CATEGORIES.backend);
});

test('Phase 19 reporting query and performance recommendations include required filters, pagination and indexes', () => {
  const query = buildReportingQuery({
    workspaceId: 'WS-1',
    from: '2026-07-01',
    to: '2026-07-31',
    locationId: 'loc-main',
    categoryId: 'cat-dry',
    itemId: 'item-flour',
    sourceType: 'GRV',
    movementType: 'Purchase',
    search: 'flour',
    limit: 1000,
    offset: 0
  });
  assert.equal(query.from, '2026-07-01');
  assert.equal(query.to, '2026-07-31');
  assert.equal(query.locationId, 'loc-main');
  assert.equal(query.categoryId, 'cat-dry');
  assert.equal(query.itemId, 'item-flour');
  assert.equal(query.sourceType, 'GRV');
  assert.equal(query.movementType, 'Purchase');
  assert.equal(query.search, 'flour');
  assert.equal(query.limit, '1000');
  assert.equal(query.offset, '0');

  const audit = auditPerformanceRecommendations();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
  assert.ok(audit.recommendations.largeReports.includes('detailed_activity'));
  assert.ok(audit.recommendations.largeReports.includes('sale_stock_movement'));
  assert.ok(audit.recommendations.largeReports.includes('modifier_report:sales_log'));
  assert.ok(audit.recommendations.largeReports.includes('inventory_audit'));
});

test('Phase 19 sign-off checklist passes as one production readiness contract', () => {
  const signoff = buildPhase19ReportingSignoff();
  assert.equal(signoff.ok, true, JSON.stringify(signoff.checks, null, 2));
});

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}
