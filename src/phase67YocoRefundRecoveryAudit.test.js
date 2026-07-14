import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 67 pairs Yoco refund summaries with the separate returned-line collection', () => {
  const webhooks = read('cloudflare-v2/src/legacy/yoco-webhooks.ts');
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(webhooks, /function pairRefundsWithReturns/);
  assert.match(webhooks, /returned_line_items/);
  assert.doesNotMatch(webhooks, /refunds\.length === sortedReturns\.length/);
  assert.match(webhooks, /Never pair multiple partial refunds and returns by array position/);
  assert.match(webhooks, /export function findRefunds/);
  assert.match(sales, /prefer line-bearing order\.returns entries/);
  assert.match(sales, /source = 'linked_return'/);
});

test('Phase 67 records refund financial reporting before any stock reversal gate', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  const financialIndex = sales.indexOf('await recordYocoRefundFinancial');
  const depletionIndex = sales.indexOf('const depletionPolicy = await getStockDepletionPolicy', financialIndex);
  const originalSaleGateIndex = sales.indexOf("originalSaleWasDepleted", financialIndex);
  assert.ok(financialIndex > 0);
  assert.ok(depletionIndex > financialIndex);
  assert.ok(originalSaleGateIndex > financialIndex);
  assert.match(sales, /financialRecorded/);
  assert.match(sales, /reportOrderKey = mode === 'refund'/);
});

test('Phase 67 keeps a rate-limited refund webhook retryable and does not mark it processed', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  assert.match(routes, /operation: "yoco\.webhook\.rate_limit"/);
  assert.match(routes, /SET status = 'attention'/);
  assert.match(routes, /Return 200 so Yoco does not create a retry storm/);
  assert.match(routes, /reason: "yoco_rate_limited"/);
  assert.match(routes, /Refund webhook verified, but Yoco has not yet exposed the refund and returned-line detail/);
});

test('Phase 67/68 uses bounded staged payment and original-order fetches for standard refund webhooks', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const context = read('cloudflare-v2/src/legacy/yoco-refund-context.ts');
  const start = routes.indexOf('async function loadYocoOrderForWebhook');
  const end = routes.indexOf('function getObjectLineItems', start);
  const loader = routes.slice(start, end);
  assert.match(loader, /resolveYocoRefundWebhookContext/);
  assert.match(loader, /singleAttempt: true/);
  assert.ok(context.indexOf('fetchPaymentOnce(env') < context.indexOf('fetchOrderOnce(env'));
  assert.match(context, /fetchOrderOnce\(env, apiKey, originalOrderId\)/);
  assert.match(context, /if \(isYocoRateLimitError\(caught\)\) throw caught/);
  assert.doesNotMatch(context, /for \(let pageIndex/);
});

test('Phase 67 caches refund orders and stops issuing requests when Yoco rate limits enrichment', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.match(service, /const refundOrderCache = new Map<string, Row>\(\)/);
  assert.match(service, /refundOrderCache\.get\(orderId\)/);
  assert.match(service, /refundOrderCache\.set\(orderId, order\)/);
  assert.match(service, /Remaining refunds were left pending instead of issuing more API requests/);
  assert.match(service, /if \(isYocoRateLimitError\(caught\)\)[\s\S]*break;/);
  assert.match(service, /if \(rows\.length > 0\) break;/);
});

test('Phase 67 leaves refund cursor unchanged after discovery or enrichment rate limits', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.match(service, /refundDiscoveryError/);
  assert.match(service, /refundRateLimited/);
  assert.match(service, /refundCursorBlocked = refundErrors > 0 \|\| retryableRefunds > 0 \|\| Boolean\(refundDiscoveryError\) \|\| refundRateLimited/);
  assert.match(service, /refundRetryAfterSeconds/);
});

test('Phase 67 retry action detects previously mislabelled processed refund webhooks with no refund transaction', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.match(service, /event\.status = 'processed'/);
  assert.match(service, /'payment\.refunded', 'refund\.succeeded', 'refund\.successful'/);
  assert.match(service, /NOT EXISTS \([\s\S]*FROM yoco_orders refund_order/);
  assert.match(service, /refund_order\.parent_yoco_order_id = event\.yoco_order_id/);
  assert.match(service, /refundOnly = refundErrorCount > 0 && saleErrorCount === 0/);
  assert.match(service, /strategy: 'refund_only'/);
});

test('Phase 67 preserves the sale no-line-items safety check', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(sales, /if \(mode === 'sale' && sourceLines\.length === 0\)/);
  assert.match(sales, /reason: 'order_has_no_line_items'/);
  assert.match(sales, /retryable: true/);
});
