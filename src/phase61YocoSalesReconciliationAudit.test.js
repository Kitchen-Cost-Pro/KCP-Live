import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 61 initial Yoco connection creates a sales baseline and never imports historical orders', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const migrations = read('cloudflare-v2/src/tenant-migrations.ts');
  assert.doesNotMatch(routes, /syncSalesOnConnect/);
  assert.match(routes, /Initial Yoco connection imports the catalogue only/);
  assert.match(service, /sales_baseline_at/);
  assert.match(service, /Historical orders were not imported or deducted/);
  assert.match(service, /clampToInitialBaseline/);
  assert.match(migrations, /ALTER TABLE yoco_connections ADD COLUMN sales_baseline_at TEXT/);
});

test('Phase 61 customer integrations removes manual sales sync but retains catalogue recovery', () => {
  const integrations = read('src/components/Integrations.js');
  assert.doesNotMatch(integrations, /data-yoco-sync-sales/);
  assert.doesNotMatch(integrations, /syncYocoSales[,(]/);
  assert.match(integrations, /data-yoco-sync-catalogue/);
  assert.match(integrations, /historical sales were not imported/i);
});

test('Phase 61 admin reconciliation uses an explicit lookback instead of the rolling customer cursor', () => {
  const admin = read('public/KCP Admin ConsoleByYOCO.html');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const worker = read('cloudflare-v2/src/index.ts');
  assert.match(admin, /Reconcile Sales - 2 Days/);
  assert.match(admin, /Reconcile Sales - 14 Days/);
  assert.match(admin, /yoco\/reconcile-sales`.*, \{ sinceDays: 2 \}/);
  assert.match(admin, /yoco\/reconcile-sales`.*, \{ sinceDays: 14 \}/);
  assert.match(routes, /action === "reconcile-sales"/);
  assert.match(worker, /'reconcile-sales'/);
});

test('Phase 61 order discovery falls back from Yoco filters and recovers webhook-backed payments', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const webhookRoutes = read('cloudflare-v2/src/legacy/routes.ts');
  assert.match(service, /listYocoOrdersForSalesSync/);
  assert.match(service, /bounded_unfiltered_fallback/);
  assert.match(service, /loadWebhookBackedOrders/);
  assert.match(service, /lower\(event\.event_type\) LIKE '%payment%'/);
  assert.match(service, /COALESCE\(event\.yoco_order_id, ''\) = ''/);
  assert.match(service, /ordersLoadedFromWebhookReferences/);
  assert.match(webhookRoutes, /listOrdersPage/);
  assert.match(webhookRoutes, /valid payment\.created webhook can still resolve its order immediately/);
});

test('Phase 61 only reports a webhook as processed after deduction, safe duplicate, or intentional ignore', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(routes, /totalMovements === 0 && !duplicateSuccess && !intentionallyIgnored/);
  assert.match(routes, /Stock deduction completed with \$\{totalMovements\} stock movement\(s\)/);
  assert.match(service, /updateWebhookSaleOutcome/);
  assert.match(service, /Order found, but stock deduction needs attention/);
  assert.match(sales, /order_not_paid_or_completed/);
  assert.match(sales, /FINAL_YOCO_SALE_STATUSES/);
});

test('Phase 61 errored-order retry query remains valid SQL', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.doesNotMatch(service, /FROM yoco_webhook_events\s+FROM yoco_webhook_events/);
  assert.match(service, /status IN \('failed', 'rejected', 'attention'\)/);
});
