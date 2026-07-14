import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveYocoFinancialAmounts, sumYocoTaxAmounts } from './modules/reporting/engine/yocoFinancials.js';
import { buildPaymentModel } from './modules/reporting/reports/sales/salesReportHelpers.js';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 68 stages payment then original order and schedules automatic DO retry for eventual consistency', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const client = read('cloudflare-v2/src/legacy/yoco-client.ts');
  const context = read('cloudflare-v2/src/legacy/yoco-refund-context.ts');
  const workspace = read('cloudflare-v2/src/workspace-do.ts');
  assert.match(client, /export const fetchPaymentOnce/);
  assert.match(client, /export const fetchOrderOnce/);
  assert.ok(context.indexOf('fetchPaymentOnce(env') < context.indexOf('fetchOrderOnce(env'));
  assert.match(context, /payment\?\.order_id/);
  assert.match(context, /refund\.original_order_id/);
  const loader = routes.slice(routes.indexOf('async function loadYocoOrderForWebhook'), routes.indexOf('function getObjectLineItems'));
  assert.match(loader, /resolveYocoRefundWebhookContext/);
  assert.match(loader, /singleAttempt: true/);
  assert.match(workspace, /async alarm\(\): Promise<void>/);
  assert.match(workspace, /retryPendingYocoRefundWebhooks/);
  assert.match(workspace, /setAlarm\(Date\.now\(\) \+ delayMs\)/);
});

test('Phase 68 never upgrades an amount-only partial refund into a full-order stock reversal', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  const start = sales.indexOf('export function resolveRefundLineItems');
  const end = sales.indexOf('\nfunction lineId', start);
  const resolver = sales.slice(start, end);
  assert.match(resolver, /refund_return_lines_not_available_yet/);
  assert.doesNotMatch(resolver, /refundAmount >= orderAmount/);
  assert.doesNotMatch(resolver, /inferRefundLinesByAmount/);
  assert.match(resolver, /if \(refundLooksFull\(refund\)\)/);
});

test('Phase 68 refuses positional pairing across multiple partial refunds', () => {
  const webhooks = read('cloudflare-v2/src/legacy/yoco-webhooks.ts');
  assert.match(webhooks, /Never pair multiple partial refunds and returns by array position/);
  assert.doesNotMatch(webhooks, /refunds\.length === sortedReturns\.length/);
});

test('Phase 68 calculates a VAT-inclusive gross refund and exposes VAT and ex-VAT components', () => {
  const raw = {
    total_amount: { amount: 11500, currency: 'ZAR' },
    returned_total_taxes: [{ name: 'VAT', tax_amount: { amount: 1500, currency: 'ZAR' } }],
    returned_line_items: [{
      id: 'burger-line',
      quantity: '1.00',
      total_price: { amount: 11500, currency: 'ZAR' },
      modifiers: [{ id: 'extra-onion', name: 'Extra Onion' }]
    }]
  };
  assert.equal(sumYocoTaxAmounts(raw), 15);
  const financials = deriveYocoFinancialAmounts({
    raw,
    persistedTotal: -115,
    orderType: 'refund',
    status: 'refunded',
    configuredVatRate: 15
  });
  assert.equal(financials.refundAmount, 115);
  assert.equal(financials.refundGrossAmount, 115);
  assert.equal(financials.refundVatAmount, 15);
  assert.equal(financials.refundNetAmount, 100);
  assert.equal(financials.vatAmount, -15);
  assert.equal(financials.netAmount, -100);
  assert.equal(financials.payoutAmount, -115);
  assert.equal(financials.vatSource, 'yoco-return');
});

test('Phase 68 payment tables use gross refund for payout while retaining refund VAT and ex-VAT', () => {
  const model = buildPaymentModel([{
    id: 'refund-1',
    receiptNumber: 'ORDER-1',
    refundId: 'REFUND-1',
    status: 'refunded',
    orderType: 'refund',
    refundGrossAmount: 115,
    refundVatAmount: 15,
    refundNetAmount: 100,
    vatAmount: -15,
    netAmount: -100,
    occurredAt: '2026-07-14T14:00:00Z',
    locationName: 'Main'
  }]);
  const row = model.views.transaction_detail[0];
  assert.equal(row.refundAmount, 115);
  assert.equal(row.refundVatAmount, 15);
  assert.equal(row.refundNetAmount, 100);
  assert.equal(row.payoutAmount, -115);
  const summary = model.views.daily_summary[0];
  assert.equal(summary.refunds, 115);
  assert.equal(summary.refundVat, 15);
  assert.equal(summary.refundNet, 100);
  assert.equal(summary.payoutAmount, -115);
});

test('Phase 68 persists signed gross VAT and net values on Yoco transactions', () => {
  const migrations = read('cloudflare-v2/src/tenant-migrations.ts');
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  const reporting = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  assert.match(migrations, /ALTER TABLE yoco_orders ADD COLUMN gross_total REAL/);
  assert.match(migrations, /ALTER TABLE yoco_orders ADD COLUMN vat_total REAL/);
  assert.match(migrations, /ALTER TABLE yoco_orders ADD COLUMN net_total REAL/);
  assert.match(sales, /gross_total, vat_total, net_total/);
  assert.match(reporting, /persistedGrossTotal: row\.gross_total/);
  assert.match(reporting, /refundVatAmount: financials\.refundVatAmount/);
});
