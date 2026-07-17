import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('dashboard notification centre configures daily low-stock email instead of manual send', () => {
  const dashboard = read('src/dashboard.js');
  const service = read('src/services/notificationService.js');
  assert.doesNotMatch(dashboard, /Email this list/);
  assert.match(dashboard, /data-dashboard-notification-settings/);
  assert.match(dashboard, /data-dashboard-notification-time/);
  assert.match(dashboard, /data-dashboard-notification-recipient/);
  assert.match(service, /notifications\/low-stock-settings/);
});

test('worker persists daily alert time and selected workspace recipients', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const worker = read('cloudflare-v2/src/legacy/index.ts');
  const lowStock = read('cloudflare-v2/src/legacy/low-stock-email.ts');
  assert.match(worker, /notifications\/low-stock-settings/);
  assert.match(routes, /can_receive_low_stock_email = CASE WHEN id IN/);
  assert.match(routes, /period='1 day'/);
  assert.match(routes, /enabled=1/);
  assert.match(lowStock, /const frequency = '1_day'/);
});

test('scheduled reports rehydrate selected saved views at execution time', () => {
  const scheduler = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');
  assert.match(scheduler, /hydrateScheduleItemsForExecution/);
  assert.match(scheduler, /item\.savedViewSnapshotId \|\| item\.savedViewId/);
  assert.match(scheduler, /const items = await hydrateScheduleItemsForExecution/);
  assert.match(scheduler, /filters: \{ \.\.\.\(saved\.filters \|\| \{\}\) \}/);
});
