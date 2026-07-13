import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeScheduleExportFormat } from './scheduleFormats.js';

const workerSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/legacy/report-scheduling-routes.ts', import.meta.url), 'utf8');
const migrationSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/tenant-migrations.ts', import.meta.url), 'utf8');
const workspaceDoSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/workspace-do.ts', import.meta.url), 'utf8');
const schedulingPageSource = fs.readFileSync(new URL('./SchedulingPage.js', import.meta.url), 'utf8');

test('Phase 33.13 validates every supported schedule export format directly', () => {
  assert.equal(normalizeScheduleExportFormat('CSV'), 'csv');
  assert.equal(normalizeScheduleExportFormat('XLSX'), 'xlsx');
  assert.equal(normalizeScheduleExportFormat('PDF'), 'pdf');
  assert.equal(normalizeScheduleExportFormat('report_link'), 'report_link');
  assert.equal(normalizeScheduleExportFormat('odf'), 'report_link');
});

test('Phase 33.13 Worker persists one canonical format and no live saved-view reference', () => {
  assert.match(workerSource, /format, recipients_json/);
  assert.match(workerSource, /normalizeScheduleExportFormat\(body\.format\)/);
  assert.match(workerSource, /normalizeScheduleExportFormat\(merged\.format\)/);
  assert.doesNotMatch(workerSource, /attachment_format/);
  assert.doesNotMatch(workerSource, /saved_view_id/);
  assert.doesNotMatch(workerSource, /legacyCompatibleScheduleFormat/);
  assert.doesNotMatch(workerSource, /resolveStoredScheduleFormat/);
  assert.match(workerSource, /schedulerVersion: '33\.17'/);
});

test('Phase 33.13 atomically rebuilds schedule storage and keeps schedule run history', () => {
  assert.match(migrationSource, /CREATE TABLE report_schedules_next/);
  assert.match(migrationSource, /CHECK \(format IN \('csv', 'xlsx', 'pdf', 'report_link'\)\)/);
  assert.match(migrationSource, /LEFT JOIN report_saved_views sv/);
  assert.match(migrationSource, /INSERT INTO report_schedule_runs_next/);
  assert.match(migrationSource, /DROP TABLE report_schedule_runs/);
  assert.match(migrationSource, /ALTER TABLE report_schedules_next RENAME TO report_schedules/);
  assert.match(workspaceDoSource, /storage\.transactionSync/);
  assert.match(schedulingPageSource, /minor >= 17/);
});
