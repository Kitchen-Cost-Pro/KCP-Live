import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportingQuery, isReportingMockDataEnabled } from '../api/reportingEndpoints.js';
import { runReport } from '../engine/reportRunner.js';
import { getReportDefinition } from '../reports/index.js';
import {
  auditPhase23Exports,
  auditPhase23FormulaContracts,
  auditPhase23Performance,
  auditPhase23Permissions,
  auditPhase23RealDataCatalog,
  auditPhase23Registry,
  auditPhase23Routing,
  auditPhase23Tooltips,
  auditPhase23Warnings,
  buildPhase23ReportingSignoff,
  PHASE23_EXPECTED_VISIBLE_REPORT_IDS
} from './phase23Signoff.js';

const rootDir = process.cwd();
const reportingDir = path.join(rootDir, 'src/modules/reporting');

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('Phase 23 report registry contains only the approved visible tiles', () => {
  const audit = auditPhase23Registry();
  assert.equal(audit.ok, true, JSON.stringify(audit, null, 2));
  assert.deepEqual(new Set(audit.visibleIds), new Set(PHASE23_EXPECTED_VISIBLE_REPORT_IDS));
});

test('Phase 23 legacy report IDs route safely to consolidated reports and views', () => {
  const audit = auditPhase23Routing();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
});

test('Phase 23 source catalog documents real workspace-scoped APIs, tables, names, and source IDs', () => {
  const audit = auditPhase23RealDataCatalog();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
});

test('Phase 23 no report imports mock rows directly and mock mode remains explicit-only', () => {
  assert.equal(isReportingMockDataEnabled({}), false);
  assert.equal(isReportingMockDataEnabled({ reporting: { useMockData: true } }), true);
  const files = listJsFiles(reportingDir)
    .filter((file) => !file.endsWith('mockReportData.js'))
    .filter((file) => !file.endsWith('.test.js'));
  const directMockImports = files.filter((file) => /from ['"].*mockReportData|import\(['"].*mockReportData/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(directMockImports.map((file) => path.relative(rootDir, file)), []);
});

test('Phase 23 real API failures surface as errors and never silently return mock rows', async () => {
  await assert.rejects(
    runReport('detailed_activity', {
      workspaceId: 'WS-FAIL',
      services: { reporting: { getDetailedActivityLedger: async () => { throw new Error('Reporting API unavailable'); } } }
    }),
    /Reporting API unavailable/
  );
});

test('Phase 23 shared formula contracts pass for stock, VAT, GP, forecasting, volatility, and theoretical variance', () => {
  const audit = auditPhase23FormulaContracts();
  assert.equal(audit.ok, true, JSON.stringify(audit.failed, null, 2));
});

test('Phase 23 required calculated columns expose formula tooltips', () => {
  const audit = auditPhase23Tooltips();
  assert.equal(audit.ok, true, JSON.stringify(audit.missing, null, 2));
  const forecast = getReportDefinition('stock_out_forecast');
  const forecastColumn = forecast.columns.forecast_summary.find((column) => column.key === 'forecastStockOutDate');
  assert.equal(forecastColumn.tooltipKey, 'forecastStockOutDate');
});

test('Phase 23 exports are view-specific, auditable, and use clean file names', () => {
  const audit = auditPhase23Exports();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
});

test('Phase 23 warning categories distinguish critical issues, coverage notes, and backend mapping gaps', () => {
  const audit = auditPhase23Warnings();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
});

test('Phase 33.17 keeps diagnostics internally but renders only customer-fixable warnings', () => {
  const runner = read('src/modules/reporting/engine/reportRunner.js');
  const banner = read('src/modules/reporting/tables/ReportWarningBanner.js');
  assert.match(runner, /result\.allWarnings\s*=\s*allWarnings/);
  assert.match(runner, /result\.warnings\s*=\s*filterUserVisibleWarnings\(allWarnings\)/);
  assert.doesNotMatch(banner, /VITE_REPORTING_SHOW_ADVISORY_WARNINGS/);
});

test('Phase 23 API query passes all core and advanced report filters', () => {
  const query = buildReportingQuery({
    workspaceId: 'WS-1', from: '2026-07-01', to: '2026-07-31', locationId: 'loc-a', categoryId: 'cat-a',
    itemId: 'item-a', supplierId: 'supplier-a', sourceType: 'GRV', movementType: 'Purchase', status: 'Committed',
    search: 'flour', limit: 500, offset: 0, lookbackPeriod: 30, costChangeThreshold: 0.08,
    volatilityThreshold: 0.1, varianceThreshold: 0.05, onlyHighRisk: true, onlyHighVolatility: true,
    onlyItemsWithStockTake: true, onlyNegativeVariance: true, onlyPositiveVariance: false
  });
  assert.equal(query.from, '2026-07-01');
  assert.equal(query.to, '2026-07-31');
  assert.equal(query.locationId, 'loc-a');
  assert.equal(query.categoryId, 'cat-a');
  assert.equal(query.itemId, 'item-a');
  assert.equal(query.supplierId, 'supplier-a');
  assert.equal(query.status, 'Committed');
  assert.equal(query.limit, '500');
  assert.equal(query.offset, '0');
  assert.equal(query.lookbackPeriod, '30');
  assert.equal(query.costChangeThreshold, '0.08');
  assert.equal(query.volatilityThreshold, '0.1');
  assert.equal(query.varianceThreshold, '0.05');
  assert.equal(query.onlyHighRisk, 'true');
  assert.equal(query.onlyHighVolatility, 'true');
  assert.equal(query.onlyItemsWithStockTake, 'true');
  assert.equal(query.onlyNegativeVariance, 'true');
  assert.equal(query.onlyPositiveVariance, undefined);
});

test('Phase 23 performance contract includes pagination, safe limits, filters, and index recommendations', () => {
  const audit = auditPhase23Performance();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
  const worker = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  assert.match(worker, /MAX_REPORT_ROWS/);
  assert.match(worker, /assertWorkspaceAccess/);
});

test('Phase 23 reporting permissions follow role, scheduling, and location access rules', () => {
  const audit = auditPhase23Permissions();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems, null, 2));
  const header = read('src/modules/reporting/tables/ReportHeader.js');
  const viewer = read('src/modules/reporting/ReportViewer.js');
  assert.match(header, /canExport/);
  assert.match(viewer, /canExportReports/);
});

test('Phase 23 report directory uses Green, Orange, Blue, Purple icons with uniform neutral section borders', () => {
  const css = read('src/styles/reporting.css');
  assert.match(css, /reportTile--sales[\s\S]*?--section-icon:\s*#16f59b/);
  assert.match(css, /reportTile--operations[\s\S]*?--section-icon:\s*#ff8a30/);
  assert.match(css, /reportTile--inventory[\s\S]*?--section-icon:\s*#2ac3ff/);
  assert.match(css, /reportTile--advanced[\s\S]*?--section-icon:\s*#c18cff/);
  const inventoryBlock = css.slice(css.lastIndexOf('.reportingDashboard--miniBentoHome .reportTile--inventory'), css.lastIndexOf('.reportingDashboard--miniBentoHome .reportTile--advanced'));
  const advancedBlock = css.slice(css.lastIndexOf('.reportingDashboard--miniBentoHome .reportTile--advanced'), css.indexOf('.advancedReportPresentation'));
  assert.match(inventoryBlock, /--section-line:\s*var\(--directory-line\)/);
  assert.match(advancedBlock, /--section-line:\s*var\(--directory-line\)/);
});

test('Phase 23 Custom Report Builder remains deleted and no tile is rendered', () => {
  const dashboard = read('src/modules/reporting/ReportingDashboard.js');
  const registry = read('src/modules/reporting/reports/reportRegistry.js');
  assert.doesNotMatch(dashboard, /Custom Report Builder|custom_report_builder/i);
  assert.doesNotMatch(registry, /Custom Report Builder|custom_report_builder/i);
});

test('Phase 23 complete reporting production sign-off contract passes', () => {
  const signoff = buildPhase23ReportingSignoff();
  assert.equal(signoff.ok, true, JSON.stringify(signoff.checks, null, 2));
});

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}
