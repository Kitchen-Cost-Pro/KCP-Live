import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { normalizeScheduledReportFilters } from './modules/reporting/scheduling/scheduleExecutionFreshness.js';

const read = (file) => fs.readFileSync(file, 'utf8');

test('saved-view defaults load automatically and remain scoped to the exact report', () => {
  const dashboard = read('src/modules/reporting/ReportingDashboard.js');
  const viewer = read('src/modules/reporting/ReportViewer.js');
  const savedViews = read('src/modules/reporting/savedViews/SavedViewsControl.js');
  const worker = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');

  assert.match(dashboard, /autoLoadDefault: true/);
  assert.match(viewer, /autoLoadDefault: autoLoadDefault && !groupDefaultApplied/);
  assert.match(savedViews, /view\.reportId === reportId/);
  assert.doesNotMatch(savedViews, /view\.reportGroupId === reportGroupId\) return true/);
  assert.match(worker, /workspace_id=\?2 AND report_id=\?3/);
});

test('scheduled snapshots preserve non-location filters and replace every location alias', () => {
  const filters = normalizeScheduledReportFilters({
    reportId: 'stock_control',
    scheduleFilters: { status: ['low', 'critical'], locationIds: ['old-a', 'old-b'] },
    itemFilters: { category: ['Meat', 'Produce'], location_id: 'old-c' },
    range: { from: '2026-07-15', to: '2026-07-16' },
    dateRangeType: 'last_2_days',
    location: { id: 'LOC-X', name: 'Location X' }
  });

  assert.deepEqual(filters.status, ['low', 'critical']);
  assert.deepEqual(filters.category, ['Meat', 'Produce']);
  assert.equal(filters.locationId, 'LOC-X');
  assert.equal(filters.locationName, 'Location X');
  assert.equal('locationIds' in filters, false);
  assert.equal('location_id' in filters, false);
});

test('role overrides and explicit location assignments survive access-management reloads', () => {
  const service = read('src/services/userManagementService.js');
  const main = read('src/main.js');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const auth = read('cloudflare-v2/src/legacy/auth.ts');

  assert.match(service, /normalizeCustomRoles\(value\)\.filter\(\(role\) => !isSuperUserRoleName/);
  assert.match(service, /Array\.isArray\(payload\.locations\) \? payload\.locations : \['all'\]/);
  assert.match(main, /Array\.isArray\(editor\.locations\) \? editor\.locations : \['all'\]/);
  assert.match(routes, /CASE WHEN \?10 = 1 THEN \?8 ELSE allowed_locations_json END/);
  assert.match(routes, /filter\(\(role\) => !isReservedHiddenRoleKey\(role\.name\)\)/);
  assert.match(auth, /FULL_PERMISSION_ROLE_KEYS\.has\(normalizedRole\)/);
});

test('permission failures are 403 and low-stock email reads central delivery settings', () => {
  const worker = read('cloudflare-v2/src/index.ts');
  const email = read('cloudflare-v2/src/legacy/low-stock-email.ts');

  assert.match(worker, /no locations are assigned\|access to this workspace/);
  assert.match(worker, /\? 403/);
  assert.match(email, /getEmailDeliveryConfig\(\{ \.\.\.env, DB: env\.CENTRAL_DB \} as Env\)/);
  assert.match(email, /ON CONFLICT\(workspace_id\) DO UPDATE SET/);
});
