import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentModel } from './modules/reporting/reports/sales/salesReportHelpers.js';
import { buildModifierReportModel } from './modules/reporting/reports/sales/modifierReport.js';
import { __wastageReportInternals } from './modules/reporting/reports/operations/wastageReport.js';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 65 classifies return and scrap refund reasons without double deducting stock', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(sales, /damaged_or_defective/);
  assert.match(sales, /wast\(\?:e\|age\|ed\|ing\)/);
  assert.match(sales, /accidental_charge, customer_changed_mind, incorrect_amount, service_not_delivered/);
  assert.match(sales, /accountingOnly: isWastageBehavior/);
  assert.match(sales, /wastageQty: isWastageBehavior/);
  assert.match(sales, /sourceLocationId,\s*0,\s*unitCost,\s*-Math\.abs\(quantitySold \* depletion\.quantity \* unitCost\)/s);
});

test('Phase 65 resolves partial refunds at line level and never spreads a proportion across the whole bill', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(sales, /export function resolveRefundLineItems/);
  assert.match(sales, /refund_line_could_not_match_original_order/);
  assert.match(sales, /refund_return_lines_not_available_yet/);
  assert.match(sales, /Stock must be driven by Yoco's returned_line_items, not by a monetary guess/);
  assert.doesNotMatch(sales, /function refundProportion/);
  assert.doesNotMatch(sales, /function scaleLineQty/);
});

test('Phase 65 carries original modifiers into refund processing when Yoco omits modifier detail', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(sales, /Preserve the original line's[\s\S]*extra onion/);
  assert.match(sales, /return \{ \.\.\.original, \.\.\.refundLine, quantity \}/);
  assert.match(sales, /componentType: 'modifier'/);
  assert.match(sales, /refundId: refundId \|\| undefined/);
});

test('Phase 65 stores each refund as a separate financial transaction', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  const migrations = read('cloudflare-v2/src/tenant-migrations.ts');
  assert.match(sales, /const reportOrderKey = mode === 'refund' \? `\$\{orderId\}:refund:\$\{refundId\}`/);
  assert.match(sales, /parent_yoco_order_id, provider_refund_id, refund_reason, refund_behavior/);
  assert.match(migrations, /ux_yoco_orders_workspace_provider_refund/);
  assert.match(migrations, /parent_yoco_order_id/);
});

test('Phase 65 processes only final refund events', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.match(sales, /'refund\.succeeded'/);
  assert.match(sales, /'payment\.refunded'/);
  assert.match(sales, /'refund\.created'/);
  assert.match(sales, /return 'waiting'/);
  assert.match(service, /'refund\.succeeded'/);
});

test('Phase 65 sales transaction detail preserves separate refund reasons and handling', () => {
  const model = buildPaymentModel([
    {
      id: 'refund-row-1',
      receiptNumber: 'ORDER-100',
      sourceId: 'REFUND-1',
      refundId: 'REFUND-1',
      refundReason: 'customer_changed_mind',
      refundHandling: 'Returned to Stock',
      status: 'refunded',
      refundAmount: 115,
      refundNetAmount: 100,
      occurredAt: '2026-07-14T10:00:00Z',
      locationName: 'Main'
    },
    {
      id: 'refund-row-2',
      receiptNumber: 'ORDER-100',
      sourceId: 'REFUND-2',
      refundId: 'REFUND-2',
      refundReason: 'damaged_or_defective',
      refundHandling: 'Scrap / Wastage',
      status: 'refunded',
      refundAmount: 57.5,
      refundNetAmount: 50,
      occurredAt: '2026-07-14T11:00:00Z',
      locationName: 'Main'
    }
  ]);
  assert.equal(model.views.transaction_detail.length, 2);
  assert.deepEqual(model.views.transaction_detail.map((row) => row.refundId), ['REFUND-1', 'REFUND-2']);
  assert.deepEqual(model.views.transaction_detail.map((row) => row.refundHandling), ['Returned to Stock', 'Scrap / Wastage']);
  assert.equal(model.views.daily_summary[0].transactionCount, 2);
});


test('Phase 65 sale stock movement shows return versus scrap without false detailed-activity errors', () => {
  const reporting = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  const stockReport = read('src/modules/reporting/reports/sales/saleStockMovementReport.js');
  const detailed = read('src/modules/reporting/reports/operations/detailedActivityReport.js');
  assert.match(reporting, /stockMovementType: isRefundWastage \? 'Refund Scrap' : isRefundMovement \? 'Refund Return'/);
  assert.match(reporting, /const qtyUsed = isRefundWastage \? 0 : -physicalQuantityDelta/);
  assert.match(reporting, /sm\.movement_type = 'wastage'[\s\S]*'\$\.mode'\) = 'refund'/);
  assert.match(stockReport, /Refund Handling/);
  assert.match(stockReport, /Stock Qty Change/);
  assert.match(detailed, /function isAccountingOnlyWastage/);
});

test('Phase 65 accounting-only refund scrap appears in wastage without a second stock quantity deduction', () => {
  const rows = __wastageReportInternals.buildWastageRows([{
    id: 'mov-refund-scrap',
    sourceType: 'Wastage Adjustment',
    movementType: 'Wastage Adjustment',
    documentType: 'yoco_order',
    qtyIn: 0,
    qtyOut: 0,
    netQty: 0,
    unitCostExVat: 20,
    movementValue: -10,
    metadata: {
      accountingOnly: true,
      wastageQty: 0.5,
      refundReason: 'damaged_or_defective',
      productName: 'Burger',
      returnBehavior: 'wastage'
    },
    date: '2026-07-14',
    locationName: 'Main'
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qtyWasted, 0.5);
  assert.equal(rows[0].wastageValue, 10);
  assert.equal(rows[0].reason, 'damaged_or_defective');
  assert.equal(rows[0].productName, 'Burger');
  assert.equal(rows[0].netQty, 0);
});


test('Phase 65 modifier reporting nets sale, return, and accounting-only scrap without a second stock deduction', () => {
  const model = buildModifierReportModel([
    {
      id: 'sale-extra-onion',
      receiptNumber: 'ORDER-200',
      transactionType: 'Sale',
      modifierGroupId: 'extras',
      modifierGroupName: 'Extras',
      modifierId: 'extra-onion',
      modifierName: 'Extra Onion',
      modifierType: 'Product',
      timesSelected: 1,
      grossAmount: 10,
      vatAmount: 1.3,
      netAmount: 8.7,
      stockQtyDeducted: 0.05,
      stockCost: 1,
      stockDeductionStatus: 'Deducted',
      hasModifierUsage: true,
      unitCostExVat: 20,
      sourceId: 'sale-extra-onion'
    },
    {
      id: 'return-extra-onion',
      receiptNumber: 'ORDER-200',
      transactionType: 'Refund',
      refundId: 'REFUND-RETURN-1',
      refundReason: 'customer_changed_mind',
      refundHandling: 'Returned to Stock',
      modifierGroupId: 'extras',
      modifierGroupName: 'Extras',
      modifierId: 'extra-onion',
      modifierName: 'Extra Onion',
      modifierType: 'Product',
      qty: -1,
      refundedSelections: 1,
      netSelections: -1,
      grossAmount: -10,
      refundAmount: 10,
      vatAmount: -1.3,
      netAmount: -8.7,
      stockQtyDeducted: -0.05,
      stockCost: -1,
      stockDeductionStatus: 'Returned to Stock',
      hasModifierUsage: true,
      unitCostExVat: 20,
      sourceId: 'return-extra-onion'
    },
    {
      id: 'scrap-extra-onion',
      receiptNumber: 'ORDER-201',
      transactionType: 'Refund',
      refundId: 'REFUND-SCRAP-1',
      refundReason: 'damaged_or_defective',
      refundHandling: 'Scrap / Wastage',
      modifierGroupId: 'extras',
      modifierGroupName: 'Extras',
      modifierId: 'extra-onion',
      modifierName: 'Extra Onion',
      modifierType: 'Product',
      qty: -1,
      refundedSelections: 1,
      netSelections: -1,
      grossAmount: -10,
      refundAmount: 10,
      vatAmount: -1.3,
      netAmount: -8.7,
      stockQtyDeducted: 0,
      stockCost: 0,
      wastageQty: 0.05,
      wastageCost: 1,
      accountingOnlyWastage: true,
      stockDeductionStatus: 'Scrapped / Wastage',
      hasModifierUsage: true,
      unitCostExVat: 20,
      sourceId: 'scrap-extra-onion'
    }
  ]);

  assert.equal(model.views.sales_log.length, 3);
  assert.equal(model.views.sales_log[1].stockQtyDeducted, -0.05);
  assert.equal(model.views.sales_log[2].stockQtyDeducted, 0);
  assert.equal(model.views.sales_log[2].wastageQty, 0.05);
  assert.equal(model.views.sales_log[2].accountingOnlyWastage, true);
  assert.equal(model.views.summary[0].timesSelected, 1);
  assert.equal(model.views.summary[0].refundedSelections, 2);
  assert.equal(model.views.summary[0].netSelections, -1);
  assert.equal(model.views.summary[0].stockDeducted, 0);
  assert.equal(model.views.summary[0].refundAmount, 20);
});

test('Phase 65 reporting filters join movements to the specific refund transaction key', () => {
  const reporting = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  const expectedJoin = /COALESCE\(NULLIF\(json_extract\(sm_filter\.metadata_json, '\$\.reportOrderKey'\), ''\), sm_filter\.document_id\) = yo\.yoco_order_id/g;
  assert.ok((reporting.match(expectedJoin) || []).length >= 4);
  assert.match(reporting, /function movementReportOrderKey/);
  assert.match(reporting, /metadata\.reportOrderKey \|\| row\.document_id/);
  assert.match(reporting, /accountingOnlyWastage: accountingWastageRows\.length > 0/);
});
