import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workerSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/legacy/report-scheduling-routes.ts', import.meta.url), 'utf8');

test('Phase 33.8 snapshots saved views and removes fragile database references', () => {
  assert.match(workerSource, /async function materializeScheduleItems/);
  assert.match(workerSource, /savedViewId: ''/);
  assert.match(workerSource, /JSON\.stringify\(validation\.items\)/);
  assert.doesNotMatch(workerSource, /saved_view_id/);
  assert.doesNotMatch(workerSource, /A saved view referenced by this schedule no longer exists/);
});

test('Phase 33.8 repairs stale selected locations without widening restricted access', () => {
  assert.match(workerSource, /reconcileExistingScheduleLocations/);
  assert.match(workerSource, /allowedIds === null \? active : active\.filter/);
  assert.match(workerSource, /if \(!matches\.length && active\.length\) return \[active\[0\]\]/);
  assert.match(workerSource, /resolveScheduleLocations\(env, auth, workspaceId, schedule\)/);
});
