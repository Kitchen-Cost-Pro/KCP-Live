import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_PERMISSION_MAP, getAllowedSections, hasLocationAccess, hasPermission, hasSectionAccess } from './roleService.js';

test('super user aliases always receive every permission and section', () => {
  for (const role of ['super', 'super-user', 'superuser', 'root', 'KCP Superuser']) {
    assert.equal(hasPermission(ACTION_PERMISSION_MAP.scheduleReports, role, []), true, role);
    assert.equal(hasPermission(ACTION_PERMISSION_MAP.deleteRecords, role, []), true, role);
    assert.equal(hasSectionAccess('reporting-scheduling', role, []), true, role);
    assert.equal(hasLocationAccess('any-location', role, []), true, role);
    assert.ok(getAllowedSections(role, []).includes('reporting-scheduling'), role);
  }
});

test('manager keeps reporting schedule permissions without destructive defaults', () => {
  assert.equal(hasPermission(ACTION_PERMISSION_MAP.scheduleReports, 'manager', []), true);
  assert.equal(hasPermission(ACTION_PERMISSION_MAP.emailReports, 'manager', []), true);
  assert.equal(hasPermission(ACTION_PERMISSION_MAP.deleteRecords, 'manager', []), false);
});
