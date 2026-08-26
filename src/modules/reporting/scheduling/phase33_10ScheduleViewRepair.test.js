import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workerSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/legacy/report-scheduling-routes.ts', import.meta.url), 'utf8');
const schedulingPageSource = fs.readFileSync(new URL('./SchedulingPage.js', import.meta.url), 'utf8');
const roleServiceSource = fs.readFileSync(new URL('../../../services/roleService.js', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../../../main.js', import.meta.url), 'utf8');

test('saved views are materialized into durable per-report snapshots', () => {
  assert.match(schedulingPageSource, /savedViewSnapshotId/);
  assert.match(schedulingPageSource, /savedViewSnapshotName/);
  assert.match(schedulingPageSource, /restoreSavedViewSnapshot/);
  assert.match(schedulingPageSource, /readScheduleForm\(form, catalog, savedViews, values\.reportItems\)/);
  assert.match(workerSource, /materializeScheduleItems/);
  assert.match(workerSource, /savedViewSnapshotId: saved\.id/);
  assert.match(workerSource, /savedViewSnapshotName: saved\.name/);
  assert.doesNotMatch(workerSource, /saved_view_id/);
  assert.match(workerSource, /reportItems: validation\.items/);
});

test('Phase 33.13 resolves obsolete report views without persisting repair references', () => {
  assert.match(workerSource, /function repairScheduleItem/);
  assert.match(workerSource, /resolveScheduleReportSelection/);
  assert.doesNotMatch(workerSource, /repairStoredScheduleReferences/);
  assert.match(workerSource, /schedulerVersion: '33\.19'/);
  assert.match(workerSource, /targets a report that is no longer available; the schedule will use its stored report settings/);
});

test('Phase 33.10 prevents timestamp-only access refreshes from remounting Scheduling', () => {
  assert.doesNotMatch(roleServiceSource, /String\(access\.updatedAt/);
  assert.match(roleServiceSource, /rolePermissions/);
  assert.match(roleServiceSource, /userLocations/);
  assert.match(mainSource, /canPreserveMountedModule/);
  assert.match(mainSource, /Keep the already[\s\S]*authenticated module mounted/);
});


test('Phase 33.13 detects an outdated Worker before allowing schedule mutations', () => {
  assert.match(workerSource, /schedulerVersion: '33\.19'/);
  assert.match(schedulingPageSource, /isSchedulerVersionCompatible/);
  assert.match(schedulingPageSource, /The Scheduling Worker is older than this page/);
  assert.match(schedulingPageSource, /major === 33 && minor >= 19/);
  assert.match(schedulingPageSource, /!schedulerReady\(\)/);
});

test('Phase 33.10 save and action flows update local schedule state without full list reloads', () => {
  assert.doesNotMatch(schedulingPageSource, /await refresh\(\{ showLoading: false \}\)/);
  assert.match(schedulingPageSource, /upsertSchedule\(result\?\.schedule\)/);
  assert.match(schedulingPageSource, /schedules = schedules\.filter/);
  assert.equal((schedulingPageSource.match(/\bdraw\(\);/g) || []).length, 1);
});
