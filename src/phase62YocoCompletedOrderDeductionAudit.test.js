import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 62 subscribes to final order events instead of using payment.created as the stock trigger', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  assert.match(service, /const YOCO_WEBHOOK_EVENT_TYPES = \['order\.completed', 'payment\.refunded', 'refund\.succeeded'\]/);
  assert.doesNotMatch(service, /const YOCO_WEBHOOK_EVENT_TYPES = \['payment\.created'/);
  assert.match(routes, /Waiting for the final order\.completed event before deducting stock/);
  assert.match(routes, /yoco\.webhook\.waiting_for_order_completion/);
  assert.match(service, /Dispatch a Yoco order\.completed test webhook/);
});

test('Phase 62 queries completed orders by closed_at and validates order read access', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.match(service, /closed_at_completed_window/);
  assert.match(service, /closed_at__gte: lowerBound, closed_at__lte: upperBound, status: \['completed'\]/);
  assert.match(service, /updated_at_completed_window/);
  assert.match(service, /created_at_completed_window/);
  assert.match(service, /business\/orders:read/);
  assert.match(service, /yocoFetch\(env, cleanKey, '\/v1\/orders\/'/);
});

test('Phase 62 resolves payment webhooks through the Payments API order_id', () => {
  const client = read('cloudflare-v2/src/legacy/yoco-client.ts');
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  assert.match(client, /export const fetchPayment/);
  assert.match(client, /\/v1\/payments\/\$\{encodeURIComponent\(paymentId\)\}/);
  assert.match(service, /The Payments API exposes order_id directly/);
  assert.match(routes, /Yoco payments expose order_id/);
});

test('Phase 62 surfaces order API failures and stock readiness in admin reconciliation', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const admin = read('public/KCP Admin ConsoleByYOCO.html');
  assert.match(service, /successfulOrderApiRequests/);
  assert.match(service, /Yoco Orders API could not be read/);
  assert.match(service, /getYocoSalesReadiness/);
  assert.match(service, /mappedYocoProducts/);
  assert.match(admin, /showYocoReconciliationDiagnostic/);
  assert.match(admin, /Successful Orders API requests/);
  assert.match(admin, /Mapped Yoco products/);
});


test('Phase 62 does not silently treat order summaries without line items as processed sales', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(service, /full line-item detail could not be fetched/);
  assert.doesNotMatch(service, /fetchOrder\(env, apiKey, orderId\)\.catch\(\(\) => order\)/);
  assert.match(sales, /reason: 'order_has_no_line_items'/);
  assert.match(sales, /retryable: true/);
});
