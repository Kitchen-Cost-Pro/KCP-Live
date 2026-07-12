import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getSchedulableReportCatalog, resolveCatalogReportSelection } from './reportCatalog.js';
import { resolveScheduleReportSelection } from './reportSelectionResolver.js';
import { getReportDefinition } from '../reports/index.js';
import { getReportColumns } from '../validators/reportValidators.js';
import { reportToCsv } from '../exports/exportCsv.js';
import { reportToExcelBytes } from '../exports/exportExcel.js';
import { reportToPdfBytes } from '../exports/exportPdf.js';

const workerSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/legacy/report-scheduling-routes.ts', import.meta.url), 'utf8');
const schedulingPageSource = fs.readFileSync(new URL('./SchedulingPage.js', import.meta.url), 'utf8');

const aliases = [
  ['stock_movement', '', 'detailed_activity', 'ledger'],
  ['low_stock_alerts', '', 'stock_control', 'item_detail'],
  ['inventory_change', '', 'inventory_audit', 'change_log'],
  ['modifier_summary', '', 'modifier_report', 'summary'],
  ['modifier_gp_tracker', '', 'modifier_report', 'gp_tracker'],
  ['modifier_sales_log', '', 'modifier_report', 'sales_log'],
  ['low_stock_alert', '', 'stock_control', 'item_detail'],
  ['reorder_report', '', 'stock_control', 'reorder_detail'],
  ['supplier_reorder_report', '', 'stock_control', 'supplier_reorder'],
  ['below_par_report', '', 'stock_control', 'reorder_detail'],
  ['menu_health', '', 'menu_recipe_health', 'menu_items'],
  ['recipe_health', '', 'menu_recipe_health', 'recipe_detail'],
  ['missing_recipes', '', 'menu_recipe_health', 'warnings'],
  ['recipe_warnings', '', 'menu_recipe_health', 'warnings'],
  ['pricing_warnings', '', 'menu_recipe_health', 'pricing'],
  ['inventory_change_audit', '', 'inventory_audit', 'change_log'],
  ['cost_change_audit', '', 'inventory_audit', 'cost_changes'],
  ['recipe_change_audit', '', 'inventory_audit', 'recipe_changes'],
  ['user_change_log', '', 'inventory_audit', 'by_user']
];

test('Phase 33.11 resolves legacy and hidden saved-view aliases to current schedulable report views', () => {
  const catalog = getSchedulableReportCatalog();
  for (const [reportId, viewId, expectedReportId, expectedViewId] of aliases) {
    const resolved = resolveScheduleReportSelection(reportId, viewId);
    assert.ok(resolved, `${reportId} should resolve`);
    assert.equal(resolved.reportId, expectedReportId, reportId);
    assert.equal(resolved.viewId, expectedViewId, reportId);
    const catalogResolved = resolveCatalogReportSelection(catalog, reportId, viewId);
    assert.ok(catalogResolved, `${reportId} should be schedulable`);
    assert.equal(catalogResolved.reportId, expectedReportId, reportId);
    assert.equal(catalogResolved.viewId, expectedViewId, reportId);
  }
});

test('Phase 33.11 repairs obsolete view IDs to the current report default without changing export format behavior', () => {
  const catalog = getSchedulableReportCatalog();
  for (const entry of catalog) {
    const resolved = resolveCatalogReportSelection(catalog, entry.reportId, 'obsolete_view_id');
    assert.ok(resolved, entry.reportId);
    assert.equal(resolved.reportId, entry.reportId, entry.reportId);
    assert.equal(resolved.viewId, entry.defaultView, entry.reportId);
  }
});

test('every schedulable report view produces CSV, XLSX and PDF bytes from the same canonical result', async () => {
  const catalog = getSchedulableReportCatalog();
  let checked = 0;
  for (const entry of catalog) {
    const report = getReportDefinition(entry.reportId);
    assert.ok(report, entry.reportId);
    for (const view of entry.views) {
      const resolved = resolveScheduleReportSelection(entry.reportId, view.value);
      assert.ok(resolved, `${entry.reportId}:${view.value}`);
      assert.equal(resolved.reportId, entry.reportId);
      assert.equal(resolved.viewId, view.value);

      const columns = getReportColumns(report, view.value);
      const row = Object.fromEntries(columns.map((column) => [column.key, sampleValue(column)]));
      const result = {
        id: entry.reportId,
        title: report.title,
        report,
        view: view.value,
        generatedAt: '2026-07-11T12:00:00.000Z',
        filters: { from: '2026-07-01', to: '2026-07-11', locationId: 'loc-test' },
        meta: { timezone: 'Africa/Johannesburg' },
        columns,
        rows: [row],
        totals: {},
        warnings: []
      };

      const csv = reportToCsv(result, { formatted: true });
      const xlsx = await reportToExcelBytes(result, { formatted: true });
      const pdf = await reportToPdfBytes(result, { formatted: true });

      assert.equal(typeof csv, 'string', `${entry.reportId}:${view.value}:csv`);
      assert.ok(csv.length > 0, `${entry.reportId}:${view.value}:csv`);
      assert.ok(xlsx instanceof Uint8Array, `${entry.reportId}:${view.value}:xlsx`);
      assert.deepEqual([...xlsx.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], `${entry.reportId}:${view.value}:xlsx`);
      assert.ok(pdf instanceof Uint8Array, `${entry.reportId}:${view.value}:pdf`);
      assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), '%PDF-', `${entry.reportId}:${view.value}:pdf`);
      assert.equal(result.view, view.value, `${entry.reportId}:${view.value}:view mutated`);
      checked += 1;
    }
  }
  assert.ok(checked >= 70, `expected broad format coverage, checked ${checked}`);
});

test('Phase 33.11 browser and Worker use one canonical report/view resolver before format rendering', () => {
  assert.match(workerSource, /resolveScheduleReportSelection/);
  assert.match(workerSource, /mapSavedViewForClient/);
  assert.match(workerSource, /schedulerVersion: '33\.17'/);
  assert.match(workerSource, /buildScheduledAttachments\(schedule\.format, outputs\)/);
  assert.match(schedulingPageSource, /resolveCatalogReportSelection/);
  assert.match(schedulingPageSource, /major === 33 && minor >= 17/);
});

function sampleValue(column = {}) {
  const type = String(column.type || column.exportType || '').toLowerCase();
  if (type === 'money' || type === 'currency' || type === 'number' || type === 'qty' || type === 'quantity') return 12.5;
  if (type === 'percent') return 0.125;
  if (type === 'date') return '2026-07-11';
  if (type === 'datetime') return '2026-07-11T12:00:00.000Z';
  if (type === 'time') return '14:30';
  if (type === 'boolean') return true;
  return `Test ${String(column.label || column.key || 'value')}`;
}
