import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const removedFiles = [
  'cloudflare-v2/src/legacy/yoco-service.ts',
  'cloudflare-v2/src/legacy/yoco-sales.ts',
  'cloudflare-v2/src/legacy/yoco-webhooks.ts',
  'cloudflare-v2/src/legacy/yoco-refund-context.ts',
  'cloudflare-v2/src/legacy/yoco-client.ts',
  'cloudflare-v2/src/modules/yoco-engine-v2/sale-shadow.ts',
  'cloudflare-v2/src/modules/yoco-engine-v2/refund-shadow.ts',
  'cloudflare-v2/src/modules/yoco-engine-v2/legacy-shutdown.ts',
  'cloudflare-v2/src/modules/yoco-engine-v2/legacy-shadow-observer.ts'
];

test('obsolete Yoco runtime files are removed', () => {
  removedFiles.forEach((path) => assert.equal(existsSync(resolve(root, path)), false, path));
});

test('only the V2 webhook ingress is registered for Yoco business events', () => {
  const worker = read('cloudflare-v2/src/index.ts');
  const dispatcher = read('cloudflare-v2/src/modules/yoco-engine-v2/route-dispatch.ts');
  const legacyRoutes = read('cloudflare-v2/src/legacy/index.ts');
  assert.match(worker, /yoco-v2\/webhook/);
  assert.match(dispatcher, /handleYocoV2WebhookIngress/);
  assert.doesNotMatch(legacyRoutes, /postYocoWebhook|postYocoSyncSales|postAdminYocoSyncSales/);
});

test('runtime cannot assign Yoco effect ownership back to LEGACY', () => {
  const ownership = read('cloudflare-v2/src/modules/yoco-engine-v2/ownership.ts');
  const saleRuntime = read('cloudflare-v2/src/modules/yoco-engine-v2/cutover.ts');
  const refundRuntime = read('cloudflare-v2/src/modules/yoco-engine-v2/refund-cutover.ts');
  const joined = `${ownership}\n${saleRuntime}\n${refundRuntime}`;
  assert.doesNotMatch(joined, /engine_version\s*=\s*['"]LEGACY['"]/);
  assert.doesNotMatch(joined, /ROLLED_BACK_TO_LEGACY|rollbackSaleEffect|rollbackRefundEffect/);
  assert.match(ownership, /YOCO_V2_OWNERSHIP_REQUIRES_EXPLICIT_MIGRATION/);
});

test('canonical processing applies sale and refund effects through V2 proposals', () => {
  const processor = read('cloudflare-v2/src/modules/yoco-engine-v2/processor.ts');
  assert.match(processor, /resolveCanonicalYocoSale/);
  assert.match(processor, /buildSaleEffectProposals/);
  assert.match(processor, /applyControlledLiveSaleEffects/);
  assert.match(processor, /resolveCanonicalYocoRefund/);
  assert.match(processor, /buildRefundReportingProposal/);
  assert.match(processor, /buildRefundStockProposals/);
  assert.match(processor, /applyControlledLiveRefundEffects/);
  assert.doesNotMatch(processor, /compareSaleShadow|compareRefundShadow|SHADOW_DISABLED/);
});

test('all external Yoco API operations use the V2 rate-gated clients', () => {
  const service = read('cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts');
  const catalog = read('cloudflare-v2/src/modules/yoco-engine-v2/catalog-client.ts');
  const api = read('cloudflare-v2/src/modules/yoco-engine-v2/api-client.ts');
  const gate = read('cloudflare-v2/src/modules/yoco-engine-v2/rate-gate.ts');
  assert.match(catalog, /executeYocoV2ApiRequest/);
  assert.match(api, /retryAfterSeconds/);
  assert.match(gate, /retry-after/i);
  assert.doesNotMatch(service, /fetch\s*\(\s*[`'"]https:\/\/api\.yoco\.com/);
});

test('reporting catalog uses canonical sales records and stock_movements', () => {
  const catalog = read('src/modules/reporting/api/reportDataSourceCatalog.js');
  const backend = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  assert.match(catalog, /yoco_orders/);
  assert.match(catalog, /stock_movements/);
  assert.match(backend, /stock_movements/);
  assert.match(backend, /yoco_orders/);
});

test('required final audit documents and release name exist', () => {
  assert.equal(read('RELEASE.txt').trim(), 'phase-v2-final-legacy-removal-reporting-audit');
  [
    'docs/LEGACY_YOCO_REMOVAL_AUDIT.md',
    'docs/YOCO_V2_REPORTING_WIRING_AUDIT.md',
    'docs/REPORTING_RECONCILIATION_EVIDENCE.md'
  ].forEach((path) => assert.equal(existsSync(resolve(root, path)), true, path));
});
