import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStockTakePayload,
  normalizeStockTakeUomCounts
} from './services/stockTakeService.js';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 69 stock take drafts preserve base and custom UOM entries plus variance fields', () => {
  const normalized = normalizeStockTakePayload({
    id: 'draft-1',
    locationId: 'main',
    items: [{
      stockItemId: 'onions',
      stockItemName: 'Onions',
      shelfCount: 25,
      systemStock: 20,
      variance: 5,
      cost: 2,
      varianceImpactEx: 10,
      unit: 'kg',
      uomCounts: { base: 5, Bag: 2 }
    }]
  });

  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].stockItemName, 'Onions');
  assert.equal(normalized.items[0].systemStock, 20);
  assert.equal(normalized.items[0].variance, 5);
  assert.equal(normalized.items[0].varianceImpactEx, 10);
  assert.deepEqual(
    normalized.items[0].uomCounts.map((row) => [row.key, row.uomName, row.count]),
    [['base', 'base', 5], ['Bag', 'Bag', 2]]
  );
});

test('Phase 69 UOM normalization accepts both object maps and saved array rows', () => {
  assert.deepEqual(
    normalizeStockTakeUomCounts({ base: 3, Crate: 4 }).map((row) => [row.key, row.count]),
    [['base', 3], ['Crate', 4]]
  );
  assert.deepEqual(
    normalizeStockTakeUomCounts([
      { key: 'base', uomName: 'base', ratio: 1, count: 3 },
      { key: 'Crate', uomName: 'Crate', ratio: 12, count: 4 }
    ]).map((row) => [row.key, row.count, row.ratio]),
    [['base', 3, 1], ['Crate', 4, 12]]
  );
});

test('Phase 69 resumed draft edits convert saved UOM arrays back to editable keyed counts', () => {
  const main = read('src/main.js');
  assert.match(main, /function stockTakeUomCountMap\(value = \{\}, baseUom = 'ea'\)/);
  assert.match(main, /const uomCounts = stockTakeUomCountMap\(existingEntry\.uomCounts \|\| \{\}, stockItem\.unit \|\| 'ea'\)/);
  assert.match(main, /rawKey === 'base'/);
});

test('Phase 69 subscribes to Yoco refund and order refresh events used by the live refund workflow', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const workspace = read('cloudflare-v2/src/workspace-do.ts');

  assert.match(service, /const YOCO_WEBHOOK_EVENT_TYPES = \['order\.completed', 'order\.updated', 'payment\.refunded'\]/);
  const eventTypeLine = service.match(/const YOCO_WEBHOOK_EVENT_TYPES = \[[^\n]+/i)?.[0] || '';
  assert.doesNotMatch(eventTypeLine, /refund\.succeeded/);
  assert.match(sales, /if \(eventType === 'order\.updated'\) return 'refund_refresh';/);
  assert.match(routes, /const isRefundWorkflow = isRefund \|\| isRefundRefresh;/);
  assert.match(routes, /const refundObjects = isRefundWorkflow \? findRefunds\(order, paymentId, webhookRefund\) : \[\];/);
  assert.match(routes, /order_update_has_no_refund/);
  assert.match(workspace, /'payment\.refunded', 'order\.updated'/);
});
