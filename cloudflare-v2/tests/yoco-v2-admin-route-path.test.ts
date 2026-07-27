import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeYocoV2AdminActionPath } from '../src/modules/yoco-engine-v2/admin-route-path';

test('normalizes the public control-centre path without duplicating admin', () => {
  assert.equal(
    normalizeYocoV2AdminActionPath('admin/control-centre/capabilities'),
    'control-centre/capabilities'
  );
});

test('normalizes unknown historical paths without changing their payload text', () => {
  assert.equal(
    normalizeYocoV2AdminActionPath('legacy-shutdown/readiness'),
    'legacy-shutdown/readiness'
  );
});

test('removes only one optional leading admin segment and surrounding slashes', () => {
  assert.equal(
    normalizeYocoV2AdminActionPath('/admin/control-centre/events/evt_123/'),
    'control-centre/events/evt_123'
  );
});
