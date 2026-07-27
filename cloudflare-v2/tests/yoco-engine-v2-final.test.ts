import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('final V2 Worker has no legacy sale/refund runtime files', () => {
  for (const path of [
    'src/legacy/yoco-sales.ts',
    'src/legacy/yoco-webhooks.ts',
    'src/legacy/yoco-refund-context.ts',
    'src/legacy/yoco-client.ts',
    'src/modules/yoco-engine-v2/sale-shadow.ts',
    'src/modules/yoco-engine-v2/refund-shadow.ts'
  ]) assert.equal(existsSync(resolve(root, path)), false, path);
});

test('webhook, queue and reconciliation are canonical V2 paths', () => {
  const route = read('src/modules/yoco-engine-v2/route-dispatch.ts');
  const processor = read('src/modules/yoco-engine-v2/processor.ts');
  const reconciliation = read('src/modules/yoco-engine-v2/reconciliation.ts');
  assert.match(route, /handleYocoV2WebhookIngress/);
  assert.match(processor, /completeCanonicalProcessing/);
  assert.match(reconciliation, /applyControlledLiveSaleEffects/);
  assert.match(reconciliation, /applyControlledLiveRefundEffects/);
  assert.doesNotMatch(`${route}\n${processor}\n${reconciliation}`, /compareSaleShadow|compareRefundShadow|runDueTransitionReconciliations/);
});

test('ownership is V2-only and fails closed', () => {
  const ownership = read('src/modules/yoco-engine-v2/ownership.ts');
  assert.match(ownership, /'V2'/);
  assert.match(ownership, /YOCO_V2_OWNERSHIP_NOT_READY/);
  assert.doesNotMatch(ownership, /VALUES[^;]*'LEGACY'/s);
});
