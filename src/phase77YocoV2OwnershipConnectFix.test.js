import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('Yoco Connect performs the authorised one-way V2 ownership migration after credential validation', () => {
  const service = read('cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts');
  const validation = service.indexOf('await validateYocoConnection');
  const encryption = service.indexOf('await encryptText', validation);
  const migration = service.indexOf('await migrateYocoV2EffectOwnershipForConnection', encryption);

  assert.ok(validation >= 0, 'missing V2 credential validation');
  assert.ok(encryption > validation, 'API key must be encryptable before ownership changes');
  assert.ok(migration > encryption, 'ownership migration must run only after validation and encryption');
  assert.doesNotMatch(service, /await assertYocoV2OwnershipReadyOrUninitialized/);
});

test('V2 ownership migration claims and activates all four effects without restoring a legacy writer', () => {
  const ownership = read('cloudflare-v2/src/modules/yoco-engine-v2/ownership.ts');
  assert.match(ownership, /migrateYocoV2EffectOwnershipForConnection/);
  assert.match(ownership, /engine_version = 'V2'/);
  // Phase V2 14 unified the separate yoco_v2_effect_controls (sale) and
  // yoco_v2_refund_effect_controls (refund) tables into one yoco_v2_effect_gate table
  // (see migrations.ts) — the per-effect cutover history tables stayed separate.
  assert.match(ownership, /yoco_v2_effect_gate/);
  assert.match(ownership, /yoco_v2_cutover_history/);
  assert.match(ownership, /yoco_v2_refund_cutover_history/);
  assert.match(ownership, /legacy_runtime_restored: false/);
  assert.doesNotMatch(ownership, /engine_version = 'LEGACY'/);
});
