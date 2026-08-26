import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileDetailedActivityToOperationsDashboard,
  reconcileWastageToDetailedActivity,
  reconcileAdjustmentsToDetailedActivity,
  reconcileStockTransfersToDetailedActivity,
  summarizeDetailedActivityForReconciliation
} from './reconciliationChecks.js';
import { categorizeReportWarnings, WARNING_CATEGORIES } from './warningCategories.js';
import { buildReportingQuery } from '../api/reportingEndpoints.js';
import { getFormulaTooltip } from '../tooltips/tooltipBuilder.js';

function reconciliationLedgerRows() {
  return [
    row({ id: 'grv', source: 'GRV', sourceType: 'GRV', qtyIn: 10, netQty: 10, movementValue: 100 }),
    row({ id: 'sale', source: 'Sale Usage', sourceType: 'Sale Usage', qtyOut: 2, netQty: -2, movementValue: -20 }),
    row({ id: 'm-in', source: 'Manufacturing In', sourceType: 'Manufacturing In', qtyIn: 3, netQty: 3, movementValue: 30 }),
    row({ id: 'm-out', source: 'Manufacturing Out', sourceType: 'Manufacturing Out', qtyOut: 1, netQty: -1, movementValue: -10 }),
    row({ id: 'm-waste', source: 'Manufacturing Wastage', sourceType: 'Manufacturing Wastage', qtyOut: 1, netQty: -1, movementValue: -10 }),
    row({ id: 'waste', source: 'Wastage Adjustment', sourceType: 'Wastage Adjustment', qtyOut: 1, netQty: -1, movementValue: -10 }),
    row({ id: 'adj', source: 'Manual Adjustment', sourceType: 'Manual Adjustment', qtyIn: 1, netQty: 1, movementValue: 10 }),
    row({ id: 'tr-out', source: 'Transfer Out', sourceType: 'Transfer Out', sourceId: 'tr-1', documentNumber: 'TR-1', qtyOut: 2, netQty: -2, movementValue: -20, locationId: 'loc-a', locationName: 'Kitchen' }),
    row({ id: 'tr-in', source: 'Transfer In', sourceType: 'Transfer In', sourceId: 'tr-1', documentNumber: 'TR-1', qtyIn: 2, netQty: 2, movementValue: 20, locationId: 'loc-b', locationName: 'Bar' })
  ];
}

function row(overrides = {}) {
  return {
    id: 'row',
    source: 'GRV',
    sourceType: 'GRV',
    movementType: overrides.source || 'GRV',
    sourceId: overrides.sourceId || overrides.id || 'source-1',
    documentNumber: overrides.documentNumber || 'DOC-1',
    itemId: 'item-1',
    itemName: 'Flour',
    category: 'Dry Goods',
    locationId: 'loc-a',
    locationName: 'Kitchen',
    qtyIn: 0,
    qtyOut: 0,
    netQty: 0,
    unitCostExVat: 10,
    movementValue: 0,
    ...overrides
  };
}

test('shared reconciliation helper summarizes Detailed Activity into Operations Dashboard buckets', () => {
  const summary = summarizeDetailedActivityForReconciliation(reconciliationLedgerRows());
  assert.equal(summary.netMovementValue, 90);
  assert.equal(summary.purchases, 100);
  assert.equal(summary.salesUsage, 20);
  assert.equal(summary.manufacturingIn, 30);
  assert.equal(summary.manufacturingOut, 10);
  assert.equal(summary.manufacturingWastage, 10);
  assert.equal(summary.manualWastage, 10);
  assert.equal(summary.adjustments, 10);
  assert.equal(summary.transfersIn, 20);
  assert.equal(summary.transfersOut, 20);
});

test('Operations Dashboard reconciliation returns no warnings when dashboard totals match Detailed Activity', () => {
  const warnings = reconcileDetailedActivityToOperationsDashboard({
    detailedRows: reconciliationLedgerRows(),
    operationsTotals: {
      netStockMovement: 90,
      purchases: 100,
      salesUsage: 20,
      manufacturingIn: 30,
      manufacturingOut: 10,
      manufacturingWastage: 10,
      manualWastage: 10,
      adjustments: 10,
      transfersIn: 20,
      transfersOut: 20
    }
  });
  assert.deepEqual(warnings, []);
});

test('Wastage, Adjustments, and Stock Transfers reconcile to Detailed Activity source rows', () => {
  const detailedRows = reconciliationLedgerRows();
  assert.deepEqual(reconcileWastageToDetailedActivity({ detailedRows, wastageTotals: { wastageValue: 20 } }), []);
  assert.deepEqual(reconcileAdjustmentsToDetailedActivity({ detailedRows, adjustmentTotals: { valueImpact: 0 } }), []);
  assert.deepEqual(reconcileStockTransfersToDetailedActivity({ detailedRows, transferTotals: { movementValue: 0, netQty: 0 } }), []);
});

test('Stock transfer reconciliation warns when committed transfer is missing one side', () => {
  const warnings = reconcileStockTransfersToDetailedActivity({
    detailedRows: reconciliationLedgerRows().filter((ledgerRow) => ledgerRow.id !== 'tr-in'),
    transferTotals: { movementValue: -20, netQty: -2 }
  });
  assert.ok(warnings.some((warning) => warning.code === 'reconcile-transfer-out-without-in'));
});

test('warning categorisation splits critical issues, coverage notes, and backend mapping gaps', () => {
  const warnings = categorizeReportWarnings([
    { code: 'missing-item-name', level: 'critical', message: '1 row is missing item name.' },
    { code: 'empty-report', level: 'info', message: 'No rows matched the selected filters.' },
    { code: 'backend-ledger-mapping-gap', level: 'warning', message: 'Backend mapping gap for stock_movements.' }
  ]);
  assert.equal(warnings[0].category, WARNING_CATEGORIES.critical);
  assert.equal(warnings[1].category, WARNING_CATEGORIES.coverage);
  assert.equal(warnings[2].category, WARNING_CATEGORIES.backend);
});

test('reporting API query supports filter and pagination parameters without over-fetch-only defaults', () => {
  const query = buildReportingQuery({
    from: '2026-07-01',
    to: '2026-07-31',
    locationId: 'loc-main',
    categoryId: 'cat-dry',
    itemId: 'item-flour',
    sourceType: 'GRV',
    movementType: 'Purchase',
    search: 'flour',
    limit: 250,
    offset: 500
  });
  assert.deepEqual(query, {
    from: '2026-07-01',
    to: '2026-07-31',
    locationId: 'loc-main',
    categoryId: 'cat-dry',
    itemId: 'item-flour',
    movementType: 'Purchase',
    sourceType: 'GRV',
    search: 'flour',
    limit: '250',
    offset: '500'
  });
});

test('required Phase 10 tooltip formulas are available', () => {
  assert.equal(getFormulaTooltip('movementValue')?.formula, 'Net Qty x Unit Cost Ex VAT');
  assert.equal(getFormulaTooltip('netTransferQty')?.formula, 'Net Transfer Qty = Transfers In Qty - Transfers Out Qty');
  assert.equal(getFormulaTooltip('netTransferValue')?.formula, 'Net Transfer Value = Transfers In Value - Transfers Out Value');
});


test('report tooltip icons carry visible tooltip data without browser title hover conflicts', async () => {
  const { renderTooltipIcon, buildFormulaTooltip } = await import('../tooltips/tooltipBuilder.js');
  const tooltip = buildFormulaTooltip('movementValue');
  const html = renderTooltipIcon('movementValue');
  assert.ok(tooltip.includes('Net Qty x Unit Cost Ex VAT'));
  assert.ok(html.includes('data-report-tooltip='));
  assert.equal(html.includes('title='), false);
  assert.ok(html.includes('reportTooltip'));
  assert.ok(html.includes('Net Qty x Unit Cost Ex VAT'));
});
