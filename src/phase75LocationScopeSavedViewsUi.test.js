import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('restricted location helpers fail closed and reports auto-scope to assigned locations', () => {
  const main = read('src/main.js');
  const auth = read('cloudflare-v2/src/legacy/auth.ts');
  const reporting = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  assert.doesNotMatch(main, /permFiltered = res\.length \? res : list/);
  assert.doesNotMatch(main, /return userFiltered\.length \? userFiltered : permFiltered/);
  assert.match(auth, /const resolved = requested\.length \? requested : allowed/);
  assert.match(reporting, /locationIds/);
  assert.match(reporting, /addLocationSqlScope/);
});

test('dashboard notification email list is workspace-scoped while stock tables may retain a selected site', () => {
  const dashboard = read('src/dashboard.js');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const email = read('cloudflare-v2/src/legacy/low-stock-email.ts');
  assert.match(dashboard, /function getNotificationInventoryItems/);
  assert.match(dashboard, /if \(!ui\.locationId\) return items/);
  assert.match(dashboard, /loadLowStockNotificationSettings\(context\.workspaceId\)/);
  assert.match(routes, /FROM workspace_members/);
  assert.match(email, /getRecipients\(env, workspaceId\)/);
});

test('user management no longer exposes the low stock alert control', () => {
  const userManagement = read('src/components/UserManagement.js');
  assert.doesNotMatch(userManagement, /Low Stock Alert Tag/);
  assert.doesNotMatch(userManagement, /renderLowStockAlertToggle/);
  assert.doesNotMatch(userManagement, /Low Stock Email<\/span>/);
});

test('saved views retry schema repair and can be selected per scheduled report view', () => {
  const schedulingRoutes = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');
  const schedulingPage = read('src/modules/reporting/scheduling/SchedulingPage.js');
  assert.match(schedulingRoutes, /withSchedulingWriteRetry\(env, async \(\) =>/);
  assert.match(schedulingRoutes, /savedViewPersistenceMessage/);
  assert.match(schedulingPage, /data-schedule-item-saved-view/);
  assert.match(schedulingPage, /item\.savedViewId = selected\.id/);
  assert.match(schedulingPage, /renderScheduleViewChoice/);
});

test('requested presentation fixes are represented in component styles', () => {
  const dashboardCss = read('src/styles/dashboard.module.css');
  const stockTakeCss = read('src/styles/stockTake.css');
  const adjustmentsCss = read('src/styles/adjustments.css');
  assert.match(dashboardCss, /\.shell[\s\S]*?background: transparent/);
  assert.match(stockTakeCss, /data-stocktake-impact[\s\S]*?white-space: nowrap/);
  assert.match(adjustmentsCss, /adj-dropdownMenu button:not\(:disabled\):hover/);
});
