import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDateRangePreset, normalizeDateRangeType, resolveDateRangePreset } from './dateRangePresets.js';
import { findCatalogEntry, getSchedulableReportCatalog } from './reportCatalog.js';
import { calculateReportNextRunAt, resolveScheduledRelativeRange } from './scheduleTiming.js';
import { ACTION_PERMISSION_MAP, DEFAULT_ROLES, getAccessRenderRevision, hasPermission } from '../../../services/roleService.js';

const rootDir = process.cwd();
const workerFile = path.join(rootDir, 'cloudflare-v2/src/legacy/report-scheduling-routes.ts');
const workerSource = fs.readFileSync(workerFile, 'utf8');
const migrationSource = fs.readFileSync(path.join(rootDir, 'cloudflare-v2/src/tenant-migrations.ts'), 'utf8');
const routeSource = fs.readFileSync(path.join(rootDir, 'cloudflare-v2/src/legacy/index.ts'), 'utf8');
const cronSource = fs.readFileSync(path.join(rootDir, 'cloudflare-v2/src/index.ts'), 'utf8');
const mainSource = fs.readFileSync(path.join(rootDir, 'src/main.js'), 'utf8');
const appShellSource = fs.readFileSync(path.join(rootDir, 'src/appShell.js'), 'utf8');
const reportViewerSource = fs.readFileSync(path.join(rootDir, 'src/modules/reporting/ReportViewer.js'), 'utf8');
const schedulingPageSource = fs.readFileSync(path.join(rootDir, 'src/modules/reporting/scheduling/SchedulingPage.js'), 'utf8');
const facadeSource = fs.readFileSync(path.join(rootDir, 'cloudflare-v2/src/d1-facade.ts'), 'utf8');
const workspaceDoSource = fs.readFileSync(path.join(rootDir, 'cloudflare-v2/src/workspace-do.ts'), 'utf8');
const cloudflareApiSource = fs.readFileSync(path.join(rootDir, 'src/services/cloudflareApi.js'), 'utf8');

const fixedNow = new Date(2026, 6, 10, 12, 0, 0);

test('Phase 20 relative presets resolve against the load/run date rather than stored fixed dates', () => {
  assert.equal(normalizeDateRangeType('Last 7 Days'), 'last_7_days');
  assert.deepEqual(resolveDateRangePreset('last_7_days', { now: fixedNow }), {
    dateRangeType: 'last_7_days',
    startDate: '2026-07-04',
    endDate: '2026-07-10'
  });
  assert.deepEqual(resolveDateRangePreset('last_week', { now: fixedNow }), {
    dateRangeType: 'last_week',
    startDate: '2026-06-29',
    endDate: '2026-07-05'
  });
  const restored = applyDateRangePreset({ dateRangeType: 'last_30_days', startDate: '2020-01-01', endDate: '2020-01-02' }, { now: fixedNow });
  assert.equal(restored.startDate, '2026-06-11');
  assert.equal(restored.endDate, '2026-07-10');
  assert.equal(restored.from, '2026-06-11');
  assert.equal(restored.to, '2026-07-10');
});

test('Phase 20 custom ranges keep their configured dates', () => {
  const restored = applyDateRangePreset({ dateRangeType: 'custom', startDate: '2026-05-01', endDate: '2026-05-15' }, { now: fixedNow });
  assert.equal(restored.dateRangeType, 'custom');
  assert.equal(restored.startDate, '2026-05-01');
  assert.equal(restored.endDate, '2026-05-15');
});


test('Phase 20 backend schedule timing calculates daily, weekly, and monthly next_run_at values in the selected timezone', () => {
  const from = new Date('2026-07-10T08:30:00.000Z'); // Friday 10:30 in Johannesburg.
  assert.equal(calculateReportNextRunAt({ scheduleFrequency: 'daily', scheduleTime: '11:00', timezone: 'Africa/Johannesburg' }, from), '2026-07-10T09:00:00.000Z');
  assert.equal(calculateReportNextRunAt({ scheduleFrequency: 'weekly', scheduleDay: 1, scheduleTime: '08:00', timezone: 'Africa/Johannesburg' }, from), '2026-07-13T06:00:00.000Z');
  assert.equal(calculateReportNextRunAt({ scheduleFrequency: 'monthly', scheduleDay: 1, scheduleTime: '09:00', timezone: 'Africa/Johannesburg' }, from), '2026-08-01T07:00:00.000Z');
});

test('Phase 20 scheduled relative dates resolve in the schedule timezone', () => {
  const range = resolveScheduledRelativeRange('last_7_days', {}, 'Africa/Johannesburg', new Date('2026-07-10T22:30:00.000Z'));
  assert.deepEqual(range, { from: '2026-07-05', to: '2026-07-11', startDate: '2026-07-05', endDate: '2026-07-11' });
});

test('Phase 20 scheduling catalog contains grouped child reports and their internal views', () => {
  const catalog = getSchedulableReportCatalog();
  assert.ok(catalog.length >= 12);
  const payment = findCatalogEntry('payment_sales_financial');
  const movement = findCatalogEntry('sale_stock_movement');
  const modifier = findCatalogEntry('modifier_report');
  const stock = findCatalogEntry('stock_control');
  assert.equal(payment.reportGroupId, 'sales_reports');
  assert.equal(movement.reportGroupId, 'sales_reports');
  assert.ok(payment.views.some((view) => view.value === 'daily_summary'));
  assert.ok(movement.views.some((view) => view.value === 'by_menu_item'));
  assert.ok(modifier.views.some((view) => view.value === 'gp_tracker'));
  assert.equal(stock.views.some((view) => view.value === 'supplier_reorder'), false);
});

test('every report and view exposed by Scheduling is accepted by the Worker registry', () => {
  for (const report of getSchedulableReportCatalog()) {
    assert.match(workerSource, new RegExp(`\\b${report.reportId}: \\{`), report.reportId);
    for (const view of report.views) assert.ok(workerSource.includes(`'${view.value}'`), `${report.reportId}:${view.value}`);
  }
});

test('Phase 20 managers and higher have centralized scheduling permissions by default', () => {
  const manager = DEFAULT_ROLES.find((role) => role.id === 'manager');
  assert.ok(manager);
  for (const permission of [
    ACTION_PERMISSION_MAP.saveWorkspaceReportViews,
    ACTION_PERMISSION_MAP.scheduleReports,
    ACTION_PERMISSION_MAP.emailReports,
    ACTION_PERMISSION_MAP.manageReportSchedules,
    ACTION_PERMISSION_MAP.deleteReportSchedules
  ]) {
    assert.equal(hasPermission(permission, 'manager', []), true, permission);
    assert.ok(manager.permissions.includes(permission), permission);
  }
});

test('Phase 20 tenant migration creates saved views, schedules, run history and required indexes', () => {
  for (const table of ['report_saved_views', 'report_schedules', 'report_schedule_runs']) {
    assert.match(migrationSource, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const indexFragment of [
    'idx_report_saved_views_workspace_user',
    'idx_report_saved_views_workspace_report',
    'idx_report_schedules_workspace_enabled',
    'idx_report_schedules_next_run',
    'idx_report_schedule_runs_schedule_created'
  ]) assert.match(migrationSource, new RegExp(indexFragment));
  for (const column of [
    'report_items_json',
    'location_mode',
    'location_ids_json',
    'reports_generated',
    'files_generated',
    'output_manifest_json'
  ]) assert.ok(migrationSource.includes(column), column);
});

test('report scheduling verifies the canonical workspace schema before use', () => {
  assert.match(workerSource, /ensureReportSchedulingSchema/);
  assert.match(workerSource, /schedulingSchemaPromises = new WeakMap/);
  assert.match(workerSource, /repairReportSchedulingSchema/);
  assert.match(workerSource, /REPORT_SCHEDULE_COLUMNS/);
  assert.match(workerSource, /verifyTableColumns/);
  assert.match(workerSource, /withSchedulingSchemaRetry/);
  assert.match(workerSource, /PRAGMA table_info\(\$\{table\}\)/);
  assert.match(workerSource, /ALTER TABLE \$\{table\} ADD COLUMN/);
  assert.match(facadeSource, /duplicate column name\|already exists/);
  assert.match(workspaceDoSource, /storage\.transactionSync/);
});

test('schedule APIs and the scheduling table expose individual location names', () => {
  assert.match(workerSource, /locationNames: locations\.map/);
  assert.match(workerSource, /enrichScheduleLocations\(mapSchedule/);
  assert.match(schedulingPageSource, /formatScheduleLocations/);
  assert.match(schedulingPageSource, /uniqueNames\.join\(', '\)/);
  assert.doesNotMatch(schedulingPageSource, /All locations · separate files/);
});

test('schedule location selection uses one dropdown containing All Locations and each permitted location', () => {
  assert.match(workerSource, /locations: selectableLocations/);
  assert.match(workerSource, /allowAllLocations: allowedLocationIds === null/);
  assert.match(schedulingPageSource, /name="locationSelection"/);
  assert.match(schedulingPageSource, />All Locations<\/option>/);
  assert.match(schedulingPageSource, /values\.locations\.map\(\(location\) => `<option/);
  assert.doesNotMatch(schedulingPageSource, /name="locationMode"/);
  assert.doesNotMatch(schedulingPageSource, /name="locationIds"/);
  assert.doesNotMatch(schedulingPageSource, /No active locations are available in this workspace/);
});

test('Phase 20 exposes saved-view, schedule, run-now, and test-email APIs under workspace routes', () => {
  for (const fragment of ['report-saved-views', 'report-schedules', 'run-now', 'reports/send-test-email']) {
    assert.ok(routeSource.includes(fragment), fragment);
  }
});

test('Phase 20 emailed report links restore the reporting route, selected view, and filters', () => {
  assert.match(workerSource, /url\.searchParams\.set\('route', 'reporting'\)/);
  assert.match(mainSource, /new URLSearchParams\(window\.location\.search\)\.get\('route'\)/);
  assert.match(appShellSource, /initialReportId:\s*readReportingDeepLinkReportId\(\)/);
  assert.match(appShellSource, /params\.get\('route'\) === 'reporting'/);
  assert.match(mainSource, /nextSection === 'reporting'\) clearReportingNavigationParameters\(\)/);
  assert.match(reportViewerSource, /readReportLinkConfiguration/);
  assert.match(reportViewerSource, /params\.get\('view'\)/);
  assert.match(reportViewerSource, /params\.get\('from'\)/);
  assert.match(reportViewerSource, /'locationId'/);
});

test('Phase 20 backend schedule runner uses the shared report runner and manual export mappers', () => {
  assert.match(workerSource, /import \{ runReport \} from .*reportRunner\.js/);
  assert.match(workerSource, /import \{ reportToCsv \} from .*exportCsv\.js/);
  assert.match(workerSource, /import \{ reportResultsToExcelBytes, reportToExcelBytes \} from .*exportExcel\.js/);
  assert.match(workerSource, /import \{ reportResultsToPdfBytes, reportToPdfBytes \} from .*exportPdf\.js/);
  assert.match(workerSource, /await runReport\(reportId/);
  assert.match(workerSource, /reportToCsv\(result/);
  assert.match(workerSource, /reportResultsToExcelBytes\(payloads/);
  assert.match(workerSource, /reportResultsToPdfBytes\(payloads/);
  assert.doesNotMatch(workerSource, /mockReportData|VITE_REPORTING_USE_MOCK_DATA\s*=\s*true/);
});

test('Phase 20 validates recipients, report/view IDs, formats, workspace ownership, disabled schedules and conditions', () => {
  assert.match(workerSource, /EMAIL_RE/);
  assert.match(workerSource, /validateReport\(reportId, viewId\)/);
  assert.match(workerSource, /FORMATS = new Set\(\['csv', 'xlsx', 'pdf', 'report_link'\]\)/);
  assert.match(workerSource, /materializeScheduleItems/);
  assert.match(workerSource, /the schedule will use its stored report settings/i);
  assert.match(workerSource, /report_items_json/);
  assert.doesNotMatch(workerSource, /saved_view_id/);
  assert.match(workerSource, /is_enabled=1 AND next_run_at IS NOT NULL/);
  assert.match(workerSource, /if \(!condition\.send && !isTest\)/);
  assert.match(workerSource, /You can only (edit|run|delete) your own report schedules/);
  assert.match(workerSource, /EMAIL_REPORT_PERMISSION = 'action-email-reports'/);
  assert.match(workerSource, /You do not have permission to email reports/);
});

test('Phase 20 scheduled report packs include metadata, separate location links, and CSV/XLSX/PDF attachments', () => {
  for (const label of ['Schedule:', 'Workspace:', 'Period:', 'Generated:', 'Summary:', 'Reports:']) {
    assert.ok(workerSource.includes(label), label);
  }
  assert.match(workerSource, /for \(let itemIndex = 0; itemIndex < itemPlans\.length; itemIndex \+= 1\)/);
  assert.match(workerSource, /for \(const location of itemLocations\)/);
  assert.match(workerSource, /buildScheduledAttachments\(schedule\.format, outputs\)/);
  assert.match(workerSource, /buildCsvAttachment\(output\.payload, output\)/);
  assert.match(workerSource, /groupScheduledOutputsByReport\(outputs\)/);
  assert.match(workerSource, /buildCombinedXlsxAttachment\(group\)/);
  assert.match(workerSource, /buildCombinedPdfAttachment\(group\)/);
  assert.match(workerSource, /text\/csv; charset=utf-8/);
  assert.match(workerSource, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(workerSource, /application\/pdf/);
});

test('Phase 20 schedule model supports multiple report views and separate location outputs', () => {
  assert.match(workerSource, /reportItems\?: ScheduleReportItem\[\]/);
  assert.match(workerSource, /locationIds\?: string\[\]/);
  assert.match(workerSource, /resolveScheduleLocations/);
  assert.match(workerSource, /report_items_json/);
  assert.match(workerSource, /location_ids_json/);
  assert.match(workerSource, /locationMode: clean\(row\.location_mode/);
});

test('Phase 20 cron invokes due report schedules on the Worker backend', () => {
  assert.match(cronSource, /report-schedules-due/);
  assert.match(routeSource, /postRunDueReportSchedules/);
});


test('schedule edits are allowed through the Worker CORS preflight', () => {
  assert.match(cronSource, /Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'/);
  assert.match(routeSource, /scheduleMatch && request\.method === [\"']PUT[\"']/);
});

test('workspace modules wait for resolved access and rerender only when effective access changes', () => {
  const loadingRevision = getAccessRenderRevision({ status: 'loading' });
  const access = {
    status: 'ready',
    currentRole: 'manager',
    allowedSections: ['reporting-scheduling', 'reporting'],
    roleDefinition: { permissions: ['action-schedule-reports', 'action-email-reports'], locations: ['all'] },
    updatedAt: '2026-07-11T12:00:00.000Z'
  };
  const readyRevision = getAccessRenderRevision(access);
  const timestampOnlyRefresh = getAccessRenderRevision({ ...access, updatedAt: '2026-07-11T12:05:00.000Z' });
  assert.notEqual(loadingRevision, readyRevision);
  assert.equal(timestampOnlyRefresh, readyRevision);
  assert.match(mainSource, /appState\.access\?\.status === 'loading'[\s\S]*Loading your workspace permissions/);
  assert.match(mainSource, /canPreserveMountedModule/);
  assert.match(mainSource, /mountedMain\.dataset\.accessRevision === getAccessRenderRevision\(appState\.access\)/);
  assert.match(appShellSource, /main\.dataset\.accessRevision = getAccessRenderRevision\(state\.access\)/);
  assert.match(appShellSource, /accessStatus: state\.access\?\.status/);
  assert.match(schedulingPageSource, /Loading your workspace role and scheduling permissions/);
});

test('schedule mutations update the existing table without a post-save reload request', () => {
  assert.match(schedulingPageSource, /refresh = async \(\{ showLoading = schedules\.length === 0 \} = \{\}\)/);
  assert.match(schedulingPageSource, /const mutate = async \(operation\)[\s\S]*await operation\(\);[\s\S]*updateDynamic\(\)/);
  assert.doesNotMatch(schedulingPageSource, /await refresh\(\{ showLoading: false \}\)/);
});


test('permission loads bypass the shared GET cache and cached workspace data is session scoped', () => {
  assert.match(cloudflareApiSource, /requiresFreshGet\(url\.pathname\)/);
  assert.match(cloudflareApiSource, /\\\/access-management\$/);
  assert.match(cloudflareApiSource, /getTokenCacheScope\(token\)/);
  assert.match(cloudflareApiSource, /previousToken !== nextToken[\s\S]*clearApiCache\(\)/);
});
