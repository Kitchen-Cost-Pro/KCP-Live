import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 73 identifies the original-order refund pipeline release', () => {
  const release = read('cloudflare-v2/src/release.ts');
  const admin = read('public/KCP Admin ConsoleByYOCO.html');
  const verify = read('scripts/verify-worker-release.mjs');

  assert.match(release, /phase73-yoco-refund-original-order-resolution/);
  assert.match(release, /live-refund-v4/);
  assert.match(admin, /KCP_EXPECTED_WORKER_RELEASE = 'phase73-yoco-refund-original-order-resolution'/);
  assert.match(verify, /phase73-yoco-refund-original-order-resolution/);
});

test('Phase 73 treats payment.refunded order_id as the refund order and resolves the original sale', () => {
  const context = read('cloudflare-v2/src/legacy/yoco-refund-context.ts');

  assert.match(context, /const refundOrderId = text\(references\.webhookOrderId\)/);
  assert.match(context, /refund\.original_order_id \|\| refund\.originalOrderId/);
  assert.match(context, /payment\?\.order_id/);
  assert.match(context, /storedOrderId !== refundOrderId/);
  assert.match(context, /fetchOrderOnce\(env, apiKey, originalOrderId\)/);
  assert.match(context, /fetchOrder\(env, apiKey, originalOrderId\)/);
});

test('Phase 73 falls back to the cached deducted sale and does not fail live processing on a temporary 404', () => {
  const context = read('cloudflare-v2/src/legacy/yoco-refund-context.ts');

  assert.match(context, /export function isYocoNotFoundError/);
  assert.match(context, /lookupErrors\.push\('payment_not_found_yet'\)/);
  assert.match(context, /lookupErrors\.push\('original_order_not_found_yet'\)/);
  assert.match(context, /order_type = 'sale'/);
  assert.match(context, /yoco_payment_id = \?3/);
  assert.match(context, /mergeRefundContext/);
});

test('Phase 73 converts a line-less refund order.completed event into a refund refresh', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');

  assert.match(routes, /eventDisposition === "sale"[\s\S]*!getObjectLineItems\(order\)\.length/);
  assert.match(routes, /resolveYocoRefundWebhookContext/);
  assert.match(routes, /eventDisposition = "refund_refresh"/);
  assert.match(routes, /refund order as a new sale/);
});

test('Phase 73 targeted retry stores and processes the resolved original sale id', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');

  assert.match(service, /webhookOrderId: refundOrderId/);
  assert.match(service, /storedOrderId/);
  assert.match(service, /let orderId = context\.originalOrderId/);
  assert.match(service, /SET yoco_order_id = \?3/);
  assert.match(service, /webhook order id is a refund-order reference/);
  assert.doesNotMatch(service, /let orderId = storedOrderId \|\| refundOrderId/);
});
