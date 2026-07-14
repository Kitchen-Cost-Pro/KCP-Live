import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const rootDir = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
const reportViewerSource = read('src/modules/reporting/ReportViewer.js');
const reportHeaderSource = read('src/modules/reporting/tables/ReportHeader.js');
const savedViewsSource = read('src/modules/reporting/savedViews/SavedViewsControl.js');
const schedulingSource = read('src/modules/reporting/scheduling/SchedulingPage.js');
const customSelectSource = read('src/modules/reporting/ui/customSelect.js');
const reportingCss = read('src/styles/reporting.css');
const workerSource = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');

test('report actions show downloads first and keep columns collapsed below saved views', () => {
  assert.match(reportHeaderSource, /data-report-actions-custom/);
  assert.ok(
    reportHeaderSource.indexOf('reportActionMenu__exports') < reportHeaderSource.indexOf('data-report-actions-custom'),
    'report downloads must render above saved views',
  );
  assert.match(reportViewerSource, /actionMount\?\.append\(renderSavedViewsControl/);
  assert.match(reportViewerSource, /actionMount\?\.append\(renderColumnVisibilityControl/);
  assert.match(reportViewerSource, /<details class="reportColumnVisibility__details">/);
  assert.doesNotMatch(reportViewerSource, /<details class="reportColumnVisibility__details" open/);
  assert.match(reportingCss, /reportColumnVisibility--embedded > details > summary/);
  assert.match(savedViewsSource, /visibleColumns: config\.visibleColumns \|\| \[\]/);
});

test('report header is compact and keeps refresh and actions together at the top right', () => {
  assert.match(reportHeaderSource, /reportHeader--compact/);
  assert.match(reportHeaderSource, /reportHeader__quickSummary/);
  assert.match(reportHeaderSource, /data-report-refresh/);
  assert.match(reportHeaderSource, /reportActionMenu/);
  assert.doesNotMatch(reportHeaderSource, /report\.description|result\.description/);
});

test('reporting replaces native dropdown presentation with custom select controls', () => {
  assert.match(reportViewerSource, /enhanceReportingSelects\(root\)/);
  assert.match(schedulingSource, /enhanceReportingSelects\(overlay\)/);
  assert.match(savedViewsSource, /enhanceReportingSelects\(overlay\)/);
  assert.match(customSelectSource, /reportEnhancedSelect__button/);
  assert.match(customSelectSource, /role', 'listbox/);
  assert.match(reportingCss, /\.reportEnhancedSelect__native/);
});

test('report modals use solid surfaces without backdrop blur', () => {
  assert.match(reportingCss, /\.reportModalBackdrop[\s\S]*backdrop-filter: none/);
  assert.match(reportingCss, /\.reportModalCard,[\s\S]*background: #f8fafc/);
  assert.match(reportingCss, /\.reportScheduleModal[\s\S]*opacity: 1/);
});

test('scheduled email format selector enables CSV, XLSX, PDF, and report links', () => {
  assert.match(schedulingSource, /<option value="csv"[^>]*>CSV attachments<\/option>/);
  assert.match(schedulingSource, /<option value="xlsx"[^>]*>XLSX attachments<\/option>/);
  assert.match(schedulingSource, /<option value="pdf"[^>]*>PDF attachments<\/option>/);
  assert.match(schedulingSource, /<option value="report_link"[^>]*>Report links only<\/option>/);
  assert.doesNotMatch(schedulingSource, /coming soon/i);
});

test('schedule UI selects reports and views while the runner keeps location output boundaries', () => {
  assert.match(schedulingSource, /data-schedule-pack-open/);
  assert.match(schedulingSource, /data-schedule-pack-picker/);
  assert.match(schedulingSource, /<strong>Select reports<\/strong>/);
  assert.match(schedulingSource, /<strong>Reports in pack<\/strong>/);
  assert.match(schedulingSource, /<strong>Select views<\/strong>/);
  assert.match(schedulingSource, /data-schedule-report-toggle/);
  assert.match(schedulingSource, /data-schedule-view-toggle/);
  assert.match(schedulingSource, /data-report-tooltip/);
  assert.match(schedulingSource, /name="locationSelection"/);
  assert.match(schedulingSource, /Choose All Locations to generate a separate output for every active location/);
  assert.match(schedulingSource, /values\.locations\.map\(\(location\) => `<option/);
  assert.match(workerSource, /const outputCount = items\.length \* locations\.length/);
  assert.match(workerSource, /for \(const location of locations\)/);
  assert.match(workerSource, /buildScheduledAttachments\(schedule\.format, outputs\)/);
  assert.match(workerSource, /groupScheduledOutputsByReport\(outputs\)/);
});
