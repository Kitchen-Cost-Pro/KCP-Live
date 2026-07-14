import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildDefaultStockSku, resolveStockItemSku } from './utils/stockSku.js';

const dashboard = fs.readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const dashboardCss = fs.readFileSync(new URL('./styles/dashboard.module.css', import.meta.url), 'utf8');
const stock = fs.readFileSync(new URL('./components/StockItems.js', import.meta.url), 'utf8');
const purchaseOrders = fs.readFileSync(new URL('./components/PurchaseOrders.js', import.meta.url), 'utf8');
const purchaseOrderCss = fs.readFileSync(new URL('./styles/purchaseOrders.css', import.meta.url), 'utf8');
const dataService = fs.readFileSync(new URL('./services/dataService.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('./../cloudflare-v2/src/legacy/routes.ts', import.meta.url), 'utf8');
const adjustments = fs.readFileSync(new URL('./components/Adjustments.js', import.meta.url), 'utf8');
const scheduling = fs.readFileSync(new URL('./modules/reporting/scheduling/SchedulingPage.js', import.meta.url), 'utf8');
const reportingCss = fs.readFileSync(new URL('./styles/reporting.css', import.meta.url), 'utf8');

test('dashboard defaults to Today, includes week presets, removes search, and uses a Refresh pill', () => {
  assert.match(dashboard, /\['today', 'Today'\]/);
  assert.match(dashboard, /\['this_week', 'This Week'\]/);
  assert.match(dashboard, /\['two_weeks', '2 Weeks'\]/);
  assert.match(dashboard, /rangePreset: 'today'/);
  assert.doesNotMatch(dashboard, /data-dashboard-search/);
  assert.match(dashboard, /styles\.refreshButton/);
  assert.match(dashboardCss, /\.refreshButton\s*\{/);
});

test('stock item SKU defaults from the item name and preserves entered values exactly', () => {
  assert.match(stock, /name="sku"/);
  assert.match(stock, /sku: formData\.get\('sku'\)/);
  assert.match(stock, /resolveStockItemSku/);
  assert.doesNotMatch(stock, /`\$\{sku\} - \$\{name\}`/);
  assert.equal(buildDefaultStockSku('Burger Bun'), 'SKU - Burger Bun');
  assert.equal(resolveStockItemSku('Burger Bun', ''), 'SKU - Burger Bun');
  assert.equal(resolveStockItemSku('Burger Bun', 'BB-001'), 'BB-001');
  assert.match(worker, /function resolveStockSku/);
  assert.match(worker, /const hasSkuInput/);
});

test('purchase order PDF contains product, UOM and quantity only', () => {
  assert.match(dataService, /\['PRODUCT NAME', 'UOM \/ CUSTOM UOM', 'QTY'\]/);
  assert.doesNotMatch(dataService, /head: \[\['ITEM DESCRIPTION', 'UNIT', 'PACK SIZE'/);
});

test('Gmail integration CTA text remains visible', () => {
  assert.match(purchaseOrders, /gmailPromptEyebrow/);
  assert.match(purchaseOrderCss, /purchaseOrdersModule__primary span/);
  assert.match(purchaseOrderCss, /color: #fff/);
});

test('credit notes enforce original PO quantity in client and worker', () => {
  assert.match(main, /getCreditNotePurchaseOrderQuantityError/);
  assert.match(main, /cannot return more than the original purchase order quantity/);
  assert.match(worker, /SELECT SUM\(quantity\) AS quantity/);
  assert.match(worker, /purchase_order_lines/);
  assert.match(worker, /previouslyReturnedByStockItem/);
  assert.match(worker, /cumulativeReturn/);
});

test('wastage cannot save until every required field and quantity is valid', () => {
  assert.match(adjustments, /getWastageValidationMessage/);
  assert.match(adjustments, /adj-primary--blocked/);
  assert.match(main, /Select a valid location before recording wastage/);
  assert.match(main, /Enter a quantity greater than zero/);
});

test('schedule report picker lists report-only cards in two columns', () => {
  assert.match(scheduling, /Build the report pack<\/h4>/);
  assert.doesNotMatch(scheduling, /data-schedule-report-view/);
  assert.match(scheduling, /data-default-view/);
  assert.match(scheduling, /reportScheduleReportGrid/);
  assert.match(scheduling, /catalog\.map\(\(entry\)/);
  assert.match(reportingCss, /\.reportSchedulePicker \.reportScheduleReportGrid[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});
