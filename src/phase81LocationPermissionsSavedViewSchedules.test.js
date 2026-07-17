import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  dedupeLocations,
  filterLocationsByAccess,
  resolveEffectiveLocationIds,
} from './services/locationAccess.js';
import {
  DATA_PERMISSION_SCHEMA_MARKER,
  hasSectionDataPermission,
  normalizeCustomRoles,
} from './services/roleService.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('location options are deduplicated by id and normalized display name', () => {
  const locations = dedupeLocations([
    { id: 'loc-upstairs-1', name: 'Upstairs Bar' },
    { id: 'loc-upstairs-2', displayName: ' Upstairs  Bar ' },
    { id: 'loc-main', name: 'Main Store' },
  ]);
  assert.deepEqual(locations.map((location) => location.name), ['Main Store', 'Upstairs Bar']);
});

test('restricted users only receive the intersection of role and user location access', () => {
  const access = {
    status: 'ready',
    currentRole: 'manager',
    roleDefinition: { locations: ['loc-main', 'loc-upstairs'] },
    currentUserLocations: ['loc-upstairs', 'loc-food-truck'],
  };
  assert.deepEqual(resolveEffectiveLocationIds(access), ['loc-upstairs']);
  const visible = filterLocationsByAccess([
    { id: 'loc-main', name: 'Main Store' },
    { id: 'loc-upstairs', name: 'Upstairs Bar' },
    { id: 'loc-food-truck', name: 'Food Truck' },
  ], access);
  assert.deepEqual(visible.map((location) => location.id), ['loc-upstairs']);
});

test('an explicitly empty custom-role location scope remains restricted', () => {
  const [role] = normalizeCustomRoles([{ name: 'restricted', permissions: [], locations: [] }]);
  assert.deepEqual(role.locations, []);
  assert.deepEqual(resolveEffectiveLocationIds({
    status: 'ready',
    currentRole: 'restricted',
    roleDefinition: role,
    currentUserLocations: [],
  }), []);
});

test('legacy roles retain import and export access until the new permission schema is explicitly saved', () => {
  const legacyRoles = [{ name: 'legacy-manager', permissions: ['nav-products'], locations: ['all'] }];
  assert.equal(hasSectionDataPermission('products', 'import', 'legacy-manager', legacyRoles), true);
  assert.equal(hasSectionDataPermission('products', 'export', 'legacy-manager', legacyRoles), true);

  const explicitRoles = [{
    name: 'limited-manager',
    permissions: ['nav-products', DATA_PERMISSION_SCHEMA_MARKER, 'action-import-products'],
    locations: ['all'],
  }];
  assert.equal(hasSectionDataPermission('products', 'import', 'limited-manager', explicitRoles), true);
  assert.equal(hasSectionDataPermission('products', 'export', 'limited-manager', explicitRoles), false);
});

test('role editor exposes nested import and export permissions and shell removes unauthorized actions', () => {
  const roles = read('src/components/CustomRoles.js');
  const shell = read('src/appShell.js');
  assert.match(roles, /Import data/);
  assert.match(roles, /Export data/);
  assert.match(roles, /customRolesPermissionSection__options/);
  assert.match(shell, /restrictSectionDataActions/);
  assert.match(shell, /SECTION_DATA_ACTION_SELECTORS/);
});

test('scheduled saved views refresh the current view and apply its own date range at send time', () => {
  const scheduler = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');
  assert.match(scheduler, /savedViewUpdatedAt/);
  assert.match(scheduler, /dateRangeType: saved\.dateRangeType/);
  assert.match(scheduler, /const itemDateRangeType = validateDateRangeType/);
  assert.match(scheduler, /resolveScheduledRelativeRange\(itemDateRangeType, itemFilters/);
  assert.match(scheduler, /resolveSavedViewExecutionLocations/);
  assert.match(scheduler, /extractSavedViewLocationFilters/);
  assert.match(scheduler, /UPDATE report_schedules SET report_items_json=/);
  assert.match(scheduler, /schedulerVersion: '33\.19'/);
});

test('backend location scope combines role and member assignments and scheduling deduplicates locations', () => {
  const auth = read('cloudflare-v2/src/legacy/auth.ts');
  const scheduler = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');
  assert.match(auth, /parseRoleLocationScope/);
  assert.match(auth, /parseMemberLocationScope/);
  assert.match(auth, /roleLocations\.filter/);
  assert.match(scheduler, /seenNames/);
  assert.match(scheduler, /normalizeLocationIdentity/);
});
