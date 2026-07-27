import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildLocationNameIndex,
  mergeCanonicalLocations,
  resolveLocationDisplayName,
  resolveLocationNameByReference
} from './utils/locationDisplayName.js';
import { reconcileDashboardLocationNames } from './dashboardData.js';

test('default workspace location ids never render as customer-facing names', () => {
  const id = 'loc_WS-leo-S-demo-de3159_main';
  assert.equal(resolveLocationDisplayName({ id, name: id, is_default: 1 }), 'Main Store');
});

test('integration identifiers resolve through the canonical location name', () => {
  const locations = [{
    id: 'loc_1234567890',
    name: 'loc_1234567890',
    external_name: 'Downstairs Bar',
    external_location_id: 'yoco-location-42'
  }];

  const index = buildLocationNameIndex(locations);
  assert.equal(index.byReference.get('loc_1234567890')?.name, 'Downstairs Bar');
  assert.equal(index.byReference.get('yoco-location-42')?.name, 'Downstairs Bar');
  assert.equal(resolveLocationNameByReference('yoco-location-42', locations), 'Downstairs Bar');
});

test('later canonical location data replaces a fallback label', () => {
  const merged = mergeCanonicalLocations(
    [{ id: 'loc_workspace_main', name: 'loc_workspace_main', isDefault: true }],
    [{ id: 'loc_workspace_main', displayName: 'Central Stockroom', isDefault: true }]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'Central Stockroom');
});

test('dashboard pills, rows and alert labels use the canonical location name', () => {
  const technicalId = 'loc_WS-leo-S-demo-de3159_main';
  const model = {
    locations: [{ id: technicalId, name: technicalId }],
    inventoryLocations: [{ id: technicalId, name: technicalId }],
    inventoryItems: [{
      id: 'beef',
      name: 'Beef Patty',
      locationId: technicalId,
      locationName: technicalId,
      locations: [technicalId],
      status: 'critical'
    }],
    alerts: { criticalCount: 1, criticalNames: [`Beef Patty — ${technicalId}`] }
  };

  const resolved = reconcileDashboardLocationNames(model, [{
    id: technicalId,
    displayName: 'Main Stockroom',
    isDefault: true
  }]);

  assert.equal(resolved.locations[0].name, 'Main Stockroom');
  assert.equal(resolved.inventoryLocations[0].name, 'Main Stockroom');
  assert.equal(resolved.inventoryItems[0].locationName, 'Main Stockroom');
  assert.deepEqual(resolved.inventoryItems[0].locations, ['Main Stockroom']);
  assert.deepEqual(resolved.alerts.criticalNames, ['Beef Patty — Main Stockroom']);
});

test('workspace routes repair location names before reports and user-scoped location lists load', async () => {
  const [dispatcher, routes] = await Promise.all([
    readFile(new URL('../cloudflare-v2/src/legacy/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../cloudflare-v2/src/legacy/routes.ts', import.meta.url), 'utf8')
  ]);

  assert.match(dispatcher, /await ensureWorkspaceLocationNames\(env, workspaceId\)/);
  assert.match(routes, /const resolvedName = resolveLocationDisplayName\(row\)/);
  assert.match(routes, /display_name: resolvedName/);
});
