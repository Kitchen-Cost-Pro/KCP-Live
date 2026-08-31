import test from 'node:test';
import assert from 'node:assert/strict';
import { runReport } from '../engine/reportRunner.js';
import { reportToCsv } from './exportCsv.js';
import { mapReportRowsForAccountingExport } from './exportMappers.js';

const REQUIRED_DETAILED_HEADERS = [
  'Date',
  'Time',
  'Location',
  'Item',
  'Category',
  'Movement Type',
  'Opening Balance',
  'Source',
  'Document Number',
  'Qty In',
  'Qty Out',
  'Net Qty',
  'Closing Balance',
  'Base UOM',
  'Unit Cost Ex VAT',
  'Movement Value',
  'Running Qty',
  'Running Value',
  'Created By',
  'Notes',
  'Source ID'
];

const REQUIRED_WASTAGE_HEADERS = [
  'Date',
  'Time',
  'Location',
  'Item',
  'Category',
  'Wastage Source',
  'Document Number',
  'Qty Wasted',
  'UOM',
  'Unit Cost Ex VAT',
  'Wastage Value',
  'Reason',
  'Created By',
  'Notes',
  'Source ID'
];

const REQUIRED_STOCK_TAKE_HEADERS = [
  'Stock Take Date',
  'Location',
  'Item',
  'Category',
  'Expected Qty',
  'Counted Qty',
  'Variance Qty',
  'UOM',
  'Unit Cost Ex VAT',
  'Expected Value',
  'Counted Value',
  'Variance Value',
  'Variance %',
  'Committed By',
  'Committed At',
  'Transaction ID'
];

const REQUIRED_ADJUSTMENT_HEADERS = [
  'Date',
  'Time',
  'Location',
  'Item',
  'Category',
  'Adjustment Type',
  'Reason',
  'Qty Before',
  'Qty Adjusted',
  'Qty After',
  'UOM',
  'Unit Cost Ex VAT',
  'Value Impact',
  'Created By',
  'Notes',
  'Source ID'
];

const REQUIRED_TRANSFER_HEADERS = [
  'Date',
  'Time',
  'Transaction ID',
  'Transfer Type',
  'From Site',
  'From Location',
  'To Site',
  'To Location',
  'Requested At',
  'Accepted At',
  'Shipped Qty',
  'Received Qty',
  'Returned Qty',
  'Location',
  'Direction',
  'Item',
  'Category',
  'Qty In',
  'Qty Out',
  'Net Qty',
  'UOM',
  'Unit Cost Ex VAT',
  'Transfer Value',
  'Movement Value',
  'Status',
  'Created By',
  'Committed By',
  'Notes'
];

function ledgerRows() {
  return [
    baseLedgerRow({
      id: 'purchase-001',
      movementDate: '2026-07-01',
      movementTime: '08:00:00',
      movementType: 'Purchase',
      sourceType: 'GRV',
      sourceId: 'grv-001',
      documentNumber: 'INV-001',
      qtyIn: 10,
      qtyOut: 0,
      netQty: 10,
      movementValue: 125.5,
      runningQty: 10,
      runningValue: 125.5,
      notes: 'Received stock'
    }),
    baseLedgerRow({
      id: 'waste-001',
      movementDate: '2026-07-02',
      movementTime: '09:00:00',
      movementType: 'Wastage Adjustment',
      sourceType: 'Wastage Adjustment',
      sourceId: 'waste-001',
      documentNumber: 'WST-001',
      qtyIn: 0,
      qtyOut: 1.5,
      netQty: -1.5,
      movementValue: -18.825,
      runningQty: 8.5,
      runningValue: 106.675,
      notes: 'Dropped during prep',
      reason: 'Dropped'
    }),
    baseLedgerRow({
      id: 'adjust-001',
      movementDate: '2026-07-03',
      movementTime: '10:00:00',
      movementType: 'Manual Adjustment In',
      sourceType: 'Manual Adjustment',
      sourceId: 'adjust-001',
      documentNumber: 'ADJ-001',
      qtyIn: 2,
      qtyOut: 0,
      netQty: 2,
      movementValue: 25.1,
      runningQty: 10.5,
      runningValue: 131.775,
      notes: 'Correction'
    }),
    baseLedgerRow({
      id: 'transfer-out-001',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      movementDate: '2026-07-04',
      movementTime: '11:00:00',
      movementType: 'Transfer Out',
      sourceType: 'Transfer Out',
      sourceId: 'transfer-001',
      documentNumber: 'TR-001',
      qtyIn: 0,
      qtyOut: 3,
      netQty: -3,
      movementValue: -37.65,
      runningQty: 7.5,
      runningValue: 94.125,
      notes: 'Move to bar'
    }),
    baseLedgerRow({
      id: 'transfer-in-001',
      locationId: 'loc-bar',
      locationName: 'Bar',
      movementDate: '2026-07-04',
      movementTime: '11:05:00',
      movementType: 'Transfer In',
      sourceType: 'Transfer In',
      sourceId: 'transfer-001',
      documentNumber: 'TR-001',
      qtyIn: 3,
      qtyOut: 0,
      netQty: 3,
      movementValue: 37.65,
      runningQty: 3,
      runningValue: 37.65,
      notes: 'Move from kitchen'
    })
  ];
}

function baseLedgerRow(overrides = {}) {
  return {
    id: 'row',
    workspaceId: 'WS-export',
    locationId: 'loc-main',
    locationName: 'Main Kitchen',
    itemId: 'item-flour',
    itemName: 'Flour',
    categoryName: 'Dry Goods',
    movementDate: '2026-07-01',
    movementTime: '08:00:00',
    movementType: 'Purchase',
    sourceType: 'GRV',
    sourceId: 'source-001',
    documentNumber: 'DOC-001',
    qtyIn: 1,
    qtyOut: 0,
    netQty: 1,
    baseUom: 'kg',
    unitCostExVat: 12.55,
    movementValue: 12.55,
    runningQty: 1,
    runningValue: 12.55,
    createdByName: 'Ops Admin',
    notes: '',
    raw: { sourceTable: 'stock_movements' },
    ...overrides
  };
}

function stockTakeRows() {
  return [
    {
      id: 'stocktake-line-001',
      stockTakeSessionId: 'stocktake-001',
      sourceId: 'stocktake-001',
      stockTakeDate: '2026-07-05',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      status: 'posted',
      itemId: 'item-flour',
      itemName: 'Flour',
      category: 'Dry Goods',
      countedUom: 'kg',
      baseUom: 'kg',
      expectedQty: 8.5,
      countedQty: 7.25,
      convertedBaseQty: 7.25,
      expectedBaseQty: 8.5,
      varianceQty: -1.25,
      unitCostExVat: 12.55,
      countedAt: '2026-07-05T14:00:00Z',
      committedBy: 'Ops Admin',
      committedAt: '2026-07-05T14:30:00Z',
      notes: 'Counted short'
    }
  ];
}

function reportingServices(rows = ledgerRows()) {
  return {
    reporting: {
      getDetailedActivityLedger: async () => ({
        rows,
        warnings: [],
        meta: { workspaceId: 'WS-export', dataSource: 'real', generatedAt: '2026-07-05T16:00:00Z' }
      }),
      getStockTakeAuditRows: async () => ({
        rows: stockTakeRows(),
        warnings: [],
        meta: { workspaceId: 'WS-export', dataSource: 'real', generatedAt: '2026-07-05T16:00:00Z' }
      })
    }
  };
}

function csvHeaders(csv) {
  return csv.split('\n')[0].split(',');
}

function csvDataRows(csv) {
  return csv.split('\n').slice(1).filter(Boolean);
}

test('CSV export excludes UI-only fields and raw objects', () => {
  const result = {
    report: { id: 'ui_safety', exportColumns: [
      { key: 'itemName', label: 'Item' },
      { key: 'raw', label: 'Raw JSON' },
      { key: 'icon', label: 'Icon' },
      { key: '__meta', label: 'UI State' },
      { key: 'amount', label: 'Amount', type: 'money' }
    ] },
    rows: [{ itemName: 'Flour', raw: { hidden: true }, icon: '⚠', __meta: { selected: true }, amount: 125.5 }],
    columns: [],
    totals: {}
  };

  const csv = reportToCsv(result, { includeTotals: false });
  assert.deepEqual(csvHeaders(csv), ['Item', 'Amount']);
  assert.equal(csv.includes('hidden'), false);
  assert.equal(csv.includes('⚠'), false);
});

test('CSV export includes clean headers and money exports as Rand decimal values, not cents', () => {
  const result = {
    report: { id: 'money_test', exportColumns: [{ key: 'movementValue', label: 'Movement Value', type: 'money' }] },
    rows: [{ movementValue: 125.5 }],
    columns: [],
    totals: {}
  };

  const csv = reportToCsv(result, { includeTotals: false });
  assert.deepEqual(csvHeaders(csv), ['Movement Value']);
  assert.equal(csvDataRows(csv)[0], '125.50');
  assert.equal(csv.includes('12550'), false);
});

test('Detailed Activity export has required accounting-friendly columns', async () => {
  const result = await runReport('detailed_activity', {
    workspaceId: 'WS-export',
    services: reportingServices(),
    filters: { startDate: '2026-07-01', endDate: '2026-07-04' }
  });
  assert.deepEqual(csvHeaders(reportToCsv(result, { includeTotals: false })), REQUIRED_DETAILED_HEADERS);
});

test('Wastage export has required line detail columns', async () => {
  const result = await runReport('wastage', {
    workspaceId: 'WS-export',
    services: reportingServices(),
    filters: { view: 'line_detail' }
  });
  assert.deepEqual(csvHeaders(reportToCsv(result, { includeTotals: false })), REQUIRED_WASTAGE_HEADERS);
});

test('Stock Take Audit export has required stock count columns', async () => {
  const result = await runReport('stock_take_audit', {
    workspaceId: 'WS-export',
    services: reportingServices(),
    filters: { view: 'by_item' }
  });
  assert.deepEqual(csvHeaders(reportToCsv(result, { includeTotals: false })), REQUIRED_STOCK_TAKE_HEADERS);
});

test('Adjustments export has required line detail columns', async () => {
  const result = await runReport('adjustments', {
    workspaceId: 'WS-export',
    services: reportingServices(),
    filters: { view: 'line_detail' }
  });
  assert.deepEqual(csvHeaders(reportToCsv(result, { includeTotals: false })), REQUIRED_ADJUSTMENT_HEADERS);
});

test('Stock Transfers export has required transfer columns', async () => {
  const result = await runReport('stock_transfers', {
    workspaceId: 'WS-export',
    services: reportingServices(),
    filters: { view: 'line_detail' }
  });
  assert.deepEqual(csvHeaders(reportToCsv(result, { includeTotals: false })), REQUIRED_TRANSFER_HEADERS);
});

test('Filtered report exports only filtered rows', async () => {
  const result = await runReport('detailed_activity', {
    workspaceId: 'WS-export',
    services: reportingServices(),
    filters: { startDate: '2026-07-02', endDate: '2026-07-02' }
  });
  const csv = reportToCsv(result, { includeTotals: false });
  const rows = csvDataRows(csv);
  assert.equal(result.rows.length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].includes('Wastage Adjustment'), true);
  assert.equal(rows[0].includes('Purchase'), false);
});

test('Totals are only included when intentionally requested', async () => {
  const result = await runReport('detailed_activity', {
    workspaceId: 'WS-export',
    services: reportingServices(),
    filters: { startDate: '2026-07-01', endDate: '2026-07-01' }
  });
  const withoutTotals = reportToCsv(result, { includeTotals: false });
  const withTotals = reportToCsv(result, { includeTotals: true });
  assert.equal(withoutTotals.includes('Totals'), false);
  assert.equal(withTotals.split('\n').filter((line) => line.startsWith('Totals')).length, 1);
});

test('Xero/Sage-style accounting mapper is prepared with clean accounting fields', () => {
  const result = {
    report: { id: 'accounting_test' },
    rows: [{
      itemName: 'Flour',
      category: 'Dry Goods',
      locationName: 'Main Kitchen',
      documentNumber: 'INV-001',
      movementValue: 125.5,
      source: 'GRV',
      sourceId: 'grv-001'
    }]
  };
  const rows = mapReportRowsForAccountingExport(result);
  assert.deepEqual(Object.keys(rows[0]), [
    'Account Code',
    'Tax Type',
    'Tracking Category 1',
    'Tracking Category 2',
    'Reference',
    'Description',
    'Amount Ex VAT',
    'VAT',
    'Amount Incl VAT',
    'Source',
    'Source ID'
  ]);
  assert.equal(rows[0]['Amount Ex VAT'], '125.50');
  assert.equal(rows[0].Source, 'GRV');
});
