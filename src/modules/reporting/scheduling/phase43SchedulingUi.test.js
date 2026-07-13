import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const rootDir = process.cwd();
const schedulingSource = fs.readFileSync(path.join(rootDir, 'src/modules/reporting/scheduling/SchedulingPage.js'), 'utf8');
const reportingCss = fs.readFileSync(path.join(rootDir, 'src/styles/reporting.css'), 'utf8');

test('Phase 43 keeps the main schedule form simple and opens report selection separately', () => {
  assert.match(schedulingSource, /data-schedule-pack-open/);
  assert.match(schedulingSource, /data-schedule-pack-picker hidden/);
  assert.match(schedulingSource, /data-schedule-pack-close/);
  assert.match(schedulingSource, /reportSchedulePackSummary/);
  assert.match(schedulingSource, /reportScheduleFormSection__step/);
  assert.match(schedulingSource, /Choose reports/);
  assert.doesNotMatch(schedulingSource, /Choose reports &amp; views/);
});

test('Phase 43 retains all schedule fields and submission behavior', () => {
  for (const field of ['name', 'savedViewId', 'dateRangeType', 'locationSelection', 'frequency', 'scheduleTime', 'timezone', 'format', 'sendCondition', 'recipients', 'isEnabled']) {
    assert.match(schedulingSource, new RegExp(`name=\\"${field}\\"`), field);
  }
  assert.doesNotMatch(schedulingSource, /name="emailSubject"|name="emailMessage"/);
  assert.match(schedulingSource, /data-schedule-recipient-select/);
  assert.match(schedulingSource, /readScheduleForm\(form, catalog, savedViews\)/);
  assert.match(schedulingSource, /createReportSchedule\(workspaceId, payload\)/);
  assert.match(schedulingSource, /updateReportSchedule\(workspaceId, schedule\.id, payload\)/);
});

test('Phase 43 styling stays scoped while Phase 49 deliberately shares the main app background', () => {
  assert.match(reportingCss, /Phase 43: Scheduling workspace simplification and theme alignment/);
  assert.match(reportingCss, /\.reportSchedulingPage \.reportSchedulingTemplate/);
  assert.match(reportingCss, /\.reportSchedulePickerBackdrop/);
  assert.match(reportingCss, /\.reportScheduleModal\.reportModalCard/);
  const phase43Tail = reportingCss.split('Phase 43: Scheduling workspace simplification and theme alignment')[1] || '';
  const phase43 = phase43Tail.split('Phase 45:')[0] || phase43Tail;
  assert.doesNotMatch(phase43, /\.reportingDashboard\s*\{/);
  assert.doesNotMatch(phase43, /\.reportSchedulingPage\s*\{[^}]*background\s*:/s);
  assert.match(reportingCss, /Phase 49:[\s\S]*\.reportSchedulingPage[\s\S]*background:\s*transparent\s*!important/);
});
