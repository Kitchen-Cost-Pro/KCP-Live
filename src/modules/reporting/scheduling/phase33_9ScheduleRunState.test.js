import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workerSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/legacy/report-scheduling-routes.ts', import.meta.url), 'utf8');
const migrationSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/tenant-migrations.ts', import.meta.url), 'utf8');
const schedulingPageSource = fs.readFileSync(new URL('./SchedulingPage.js', import.meta.url), 'utf8');

test('Phase 33.9 uses only run-history states accepted by production workspace constraints', () => {
  assert.match(workerSource, /status='completed'/);
  assert.match(workerSource, /status='skipped'/);
  assert.match(workerSource, /status='failed'/);
  assert.match(workerSource, /'running'/);
  assert.doesNotMatch(workerSource, /status='success'/);
  assert.doesNotMatch(workerSource, /DEFAULT 'pending'/i);
  assert.match(workerSource, /CHECK \(status IN \('running', 'completed', 'skipped', 'failed'\)\)/);
});

test('Phase 33.13 canonical migration normalizes run states while copying all history', () => {
  assert.match(migrationSource, /SET status='completed' WHERE status='success'/);
  assert.match(migrationSource, /SET status='running' WHERE status='pending'/);
  assert.match(migrationSource, /status NOT IN \('running', 'completed', 'skipped', 'failed'\)/);
  assert.match(migrationSource, /INSERT INTO report_schedule_runs_next/);
  assert.match(migrationSource, /FROM report_schedule_runs;/);
  assert.match(migrationSource, /ALTER TABLE report_schedule_runs_next RENAME TO report_schedule_runs/);
  assert.doesNotMatch(migrationSource, /DELETE FROM report_schedule_runs/);
});

test('Phase 33.9 scheduling mutations update only dynamic content instead of redrawing the full page', () => {
  assert.match(schedulingPageSource, /data-schedule-feedback/);
  assert.match(schedulingPageSource, /data-schedule-list/);
  assert.match(schedulingPageSource, /const updateDynamic = \(\) =>/);
  assert.match(schedulingPageSource, /upsertSchedule\(result\?\.schedule\)/);
  assert.equal((schedulingPageSource.match(/\bdraw\(\);/g) || []).length, 1);
});

test('Phase 33.9 does not report a delivered email as failed solely because history persistence failed', () => {
  assert.match(workerSource, /Scheduled report delivery succeeded but run history persistence failed/);
  assert.match(workerSource, /warning: persistenceWarnings\.join/);
  assert.match(schedulingPageSource, /result\.warning/);
});
