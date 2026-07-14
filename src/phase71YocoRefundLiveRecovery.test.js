import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 71 exposes the deployed Worker release so Pages and API drift is visible', () => {
  const release = read('cloudflare-v2/src/release.ts');
  const worker = read('cloudflare-v2/src/index.ts');
  const admin = read('public/KCP Admin ConsoleByYOCO.html');

  assert.match(release, /phase7[12]-yoco-(?:refund-live-recovery|webhook-rate-limit-safe)/);
  assert.match(worker, /\/api\/runtime-version/);
  assert.match(worker, /workerRelease: KCP_WORKER_RELEASE/);
  assert.match(admin, /KCP_EXPECTED_WORKER_RELEASE = 'phase7[12]-yoco-(?:refund-live-recovery|webhook-rate-limit-safe)'/);
  assert.match(admin, /updating Pages alone does not update webhook logic/);
});

test('Phase 71 immediately retries a refund incorrectly marked processed without a refund transaction', () => {
  const workspace = read('cloudflare-v2/src/workspace-do.ts');
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');

  for (const source of [workspace, service]) {
    assert.match(source, /event\.status = 'processed'/);
    assert.match(source, /refund_order\.order_type = 'refund'/);
    assert.match(source, /refund_order\.parent_yoco_order_id = event\.yoco_order_id/);
    assert.match(source, /NOT EXISTS/);
  }
  assert.match(workspace, /scheduleRefundRetry/);
  assert.match(service, /retryPendingYocoRefundWebhooks/);
});

test('Phase 71 recovers stale processing leases and uses the original payment id for refund records', () => {
  const workspace = read('cloudflare-v2/src/workspace-do.ts');
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');

  assert.match(workspace, /event\.status = 'processing'[\s\S]*datetime\('now', '-5 minutes'\)/);
  assert.match(service, /event\.status = 'processing'[\s\S]*datetime\('now', '-5 minutes'\)/);
  assert.match(sales, /if \(refund\) return text\(refund\.payment_id \|\| refund\.paymentId \|\| refund\.id\)/);
});

test('Phase 71 provides a targeted live refund recovery action in the admin console', () => {
  const worker = read('cloudflare-v2/src/index.ts');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const admin = read('public/KCP Admin ConsoleByYOCO.html');

  assert.match(worker, /'retry-refunds'/);
  assert.match(routes, /action === "retry-refunds"/);
  assert.match(routes, /retryPendingYocoRefundWebhooks\(env, workspaceId, \{ limit: 100 \}\)/);
  assert.match(admin, /Retry Live Refunds/);
  assert.match(admin, /\/yoco\/retry-refunds/);
});
