import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getReportDefinition, listReports, resolveReportRoute } from './index.js';
import { buildStockOnHandViews } from './inventory/stockOnHandReport.js';
import { purchaseOrdersReport } from './purchasing/purchaseOrdersReport.js';
import { buildGrvViews, grvLogReport } from './purchasing/grvLogReport.js';
import { buildCreditNoteViews, creditNotesReport } from './purchasing/creditNotesReport.js';

const phase21Ids = ['stock_on_hand', 'purchase_orders_report', 'grv_log', 'credit_notes_report'];

test('Phase 21 exposes four standalone inventory and purchasing tiles with no duplicate legacy tiles', () => {
  const visible = listReports().map((report) => report.id);
  for (const id of phase21Ids) assert.ok(visible.includes(id), `${id} should be visible`);
  assert.deepEqual(listReports({ section: 'inventory' }).map((report) => report.id), ['stock_on_hand']);
  assert.deepEqual(listReports({ section: 'purchasing' }).map((report) => report.id), ['purchase_orders_report', 'grv_log', 'credit_notes_report']);
  for (const id of ['stock_movement', 'low_stock_alerts', 'inventory_change']) assert.equal(visible.includes(id), false);
});

test('Phase 21 legacy report IDs redirect to the consolidated reports', () => {
  assert.equal(resolveReportRoute('stock_movement').reportId, 'detailed_activity');
  assert.equal(resolveReportRoute('low_stock_alerts').reportId, 'stock_control');
  assert.equal(resolveReportRoute('inventory_change').reportId, 'inventory_audit');
});

test('Stock on Hand remains location-specific and calculates value and status correctly', () => {
  const model = buildStockOnHandViews([
    { itemId: 'flour', itemName: 'Flour', locationId: 'up', locationName: 'Upstairs', category: 'Dry', currentStock: 2, unitCostExVat: 10, stockValue: 20, lowStockThreshold: 3, parLevel: 10, status: 'Low', supplierName: 'Supplier A', lastMovementDate: '2026-07-10' },
    { itemId: 'flour', itemName: 'Flour', locationId: 'down', locationName: 'Downstairs', category: 'Dry', currentStock: 12, unitCostExVat: 10, stockValue: 120, lowStockThreshold: 3, parLevel: 10, status: 'Healthy', supplierName: 'Supplier A', lastMovementDate: '2026-07-09' },
    { itemId: 'milk', itemName: 'Milk', locationId: 'up', locationName: 'Upstairs', category: 'Dairy', currentStock: 0, unitCostExVat: 15, stockValue: 0, lowStockThreshold: 2, parLevel: 6, status: 'Critical', supplierName: 'Supplier B', lastMovementDate: '2026-07-08' }
  ]);
  assert.equal(model.by_item.length, 3);
  assert.equal(model.summary.length, 2);
  const upstairs = model.summary.find((row) => row.locationName === 'Upstairs');
  assert.equal(upstairs.totalStockValue, 20);
  assert.equal(upstairs.lowStockItems, 1);
  assert.equal(upstairs.criticalItems, 1);
  assert.equal(upstairs.belowParItems, 2);
});

test('Purchase Orders calculate outstanding quantities and values from linked GRV receipts', async () => {
  const services = { reporting: { getPurchaseOrderReportRows: async () => ({ rows: [
    { id: 'line-1', poId: 'po-1', sourceId: 'po-1', poDate: '2026-07-01', poNumber: 'PO-1', supplierName: 'Supplier A', locationName: 'Main', itemId: 'flour', itemName: 'Flour', qtyOrdered: 10, qtyReceived: 4, baseUom: 'kg', unitCostExVat: 20, lineValueExVat: 200, vat: 30, lineValueInclVat: 230, receivedValue: 80, grvReceivedValue: 80, grvCount: 1, status: 'Partially Received' }
  ], warnings: [], meta: {} }) } };
  const detail = await purchaseOrdersReport.getRows({ workspaceId: 'WS-1', filters: {}, services, view: 'line_detail' });
  const summary = await purchaseOrdersReport.getRows({ workspaceId: 'WS-1', filters: {}, services, view: 'summary' });
  assert.equal(detail[0].qtyOutstanding, 6);
  assert.equal(summary[0].outstandingValue, 120);
  assert.equal(summary[0].receivedValue, 80);
});

test('Purchase Orders flag a real PO/GRV value mismatch even when the API omits grvReceivedValue', async () => {
  // Regression guard: grvReceivedValue used to fall back to the PO's own receivedValue when the
  // API didn't supply it, which made both sides of the mismatch check always equal — silently
  // defeating the very check meant to catch a real receiving discrepancy. It must now default to
  // 0 like any other missing numeric field, so an actual mismatch is still caught.
  const services = { reporting: { getPurchaseOrderReportRows: async () => ({ rows: [
    { id: 'line-3', poId: 'po-3', sourceId: 'po-3', poDate: '2026-07-03', poNumber: 'PO-3', supplierName: 'Supplier A', locationName: 'Main', itemId: 'flour', itemName: 'Flour', qtyOrdered: 10, qtyReceived: 4, baseUom: 'kg', unitCostExVat: 20, lineValueExVat: 200, vat: 30, lineValueInclVat: 230, receivedValue: 80, grvCount: 1, status: 'Partially Received' }
  ], warnings: [], meta: {} }) } };
  const detail = await purchaseOrdersReport.getRows({ workspaceId: 'WS-1', filters: {}, services, view: 'line_detail' });
  assert.equal(detail[0].grvReceivedValue, 0, 'a missing grvReceivedValue must not silently mirror receivedValue');
  const warnings = purchaseOrdersReport.validate({ rows: detail, services, view: 'line_detail' });
  assert.ok(warnings.some((warning) => warning.code === 'purchase-order-grv-value-mismatch'), 'the PO/GRV value mismatch must be caught, not silently masked');
});

test('Purchase Orders retain header-only records and emit a single no-line warning', async () => {
  const services = { reporting: { getPurchaseOrderReportRows: async () => ({ rows: [
    { id: 'po-header:po-2', hasLine: false, poId: 'po-2', sourceId: 'po-2', poDate: '2026-07-02', poNumber: 'PO-2', supplierName: 'Supplier A', locationName: 'Main', status: 'Draft', lineValueExVat: 0, vat: 0, lineValueInclVat: 0 }
  ], warnings: [], meta: {} }) } };
  const detail = await purchaseOrdersReport.getRows({ workspaceId: 'WS-1', filters: {}, services, view: 'line_detail' });
  const summary = await purchaseOrdersReport.getRows({ workspaceId: 'WS-1', filters: {}, services, view: 'summary' });
  const warnings = purchaseOrdersReport.validate({ rows: detail, services, view: 'line_detail' });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].items, 0);
  assert.ok(warnings.some((warning) => warning.code === 'purchase-order-no-lines'));
  assert.equal(warnings.some((warning) => warning.code === 'purchase-order-missing-item'), false);
});

test('Conditional GRV invoice and credit-note source warnings stay quiet when not required', async () => {
  const grvServices = { reporting: { getGrvLogRows: async () => ({ rows: [
    { id: 'gl-2', grvId: 'g-2', sourceId: 'g-2', grvDate: '2026-07-04', grvNumber: 'GRV-2', supplierName: 'Supplier A', invoiceNumber: '', invoiceRequired: false, locationName: 'Main', itemName: 'Flour', receivedQty: 1, baseUom: 'kg', unitCostExVat: 20, lineValueExVat: 20, vat: 3, lineValueInclVat: 23, ledgerQty: 1, ledgerValue: 20, ledgerRowCount: 1, status: 'Committed' }
  ], warnings: [], meta: {} }) } };
  const grvRows = await grvLogReport.getRows({ workspaceId: 'WS-1', filters: {}, services: grvServices, view: 'line_detail' });
  const grvWarnings = grvLogReport.validate({ rows: grvRows, services: grvServices, view: 'line_detail' });
  assert.equal(grvWarnings.some((warning) => warning.code === 'grv-missing-invoice'), false);

  const creditServices = { reporting: { getCreditNoteReportRows: async () => ({ rows: [
    { id: 'cl-2', creditNoteId: 'c-2', sourceId: 'c-2', creditNoteDate: '2026-07-05', creditNoteNumber: 'CN-2', supplierName: 'Supplier A', originalInvoiceGrv: '', requiresSourceLink: false, locationName: 'Main', itemName: 'Flour', reason: 'Price correction', qtyCredited: 1, baseUom: 'kg', unitCostExVat: 20, lineCreditExVat: 20, vat: 3, lineCreditInclVat: 23, stockImpact: 'Financial Only', financialOnly: true, ledgerQty: 0, ledgerValue: 0, ledgerRowCount: 0 }
  ], warnings: [], meta: {} }) } };
  const creditRows = await creditNotesReport.getRows({ workspaceId: 'WS-1', filters: {}, services: creditServices, view: 'line_detail' });
  const creditWarnings = creditNotesReport.validate({ rows: creditRows, services: creditServices, view: 'line_detail' });
  assert.equal(creditWarnings.some((warning) => warning.code === 'credit-note-missing-source'), false);
  assert.equal(creditWarnings.some((warning) => warning.code === 'credit-note-missing-stock-movement'), false);
});

test('GRV and stock-impacting credit note rows expose ledger reconciliation fields', () => {
  const grv = buildGrvViews([{ id: 'gl-1', grvId: 'g-1', sourceId: 'g-1', grvDate: '2026-07-02', grvNumber: 'GRV-1', supplierName: 'Supplier A', locationName: 'Main', itemId: 'flour', itemName: 'Flour', category: 'Dry', receivedQty: 5, baseUom: 'kg', unitCostExVat: 20, lineValueExVat: 100, vat: 15, lineValueInclVat: 115, ledgerQty: 5, ledgerValue: 100, ledgerRowCount: 1, status: 'Committed' }]);
  assert.equal(grv.line_detail[0].ledgerQty, 5);
  assert.equal(grv.line_detail[0].ledgerValue, 100);
  assert.equal(grv.summary[0].totalValueExVat, 100);

  const credit = buildCreditNoteViews([{ id: 'cl-1', creditNoteId: 'c-1', sourceId: 'c-1', creditNoteDate: '2026-07-03', creditNoteNumber: 'CN-1', supplierName: 'Supplier A', locationName: 'Main', itemId: 'flour', itemName: 'Flour', category: 'Dry', reason: 'Damaged', qtyCredited: 2, baseUom: 'kg', unitCostExVat: 20, lineCreditExVat: 40, vat: 6, lineCreditInclVat: 46, stockImpact: 'Stock Removed', ledgerQty: -2, ledgerValue: -40, ledgerRowCount: 1 }]);
  assert.equal(credit.line_detail[0].stockImpact, 'Stock Removed');
  assert.equal(credit.line_detail[0].ledgerQty, -2);
  assert.equal(credit.summary[0].creditValueExVat, 40);
});

test('a signed GRV ledger quantity still reconciles instead of spuriously failing the qty-mismatch check', async () => {
  // Regression guard: ledgerValue was normalized with Math.abs() but ledgerQty was not, so a
  // signed ledger quantity (e.g. from a correction/reversal) would fail grv-ledger-qty-mismatch
  // while the value-side check on the exact same row correctly reconciled.
  const services = { reporting: { getGrvLogRows: async () => ({ rows: [
    { id: 'gl-signed', grvId: 'g-signed', sourceId: 'g-signed', grvDate: '2026-07-07', grvNumber: 'GRV-7', supplierName: 'Supplier A', locationName: 'Main', itemName: 'Flour', receivedQty: 5, baseUom: 'kg', unitCostExVat: 20, lineValueExVat: 100, vat: 15, ledgerQty: -5, ledgerValue: -100, ledgerRowCount: 1, status: 'Committed' }
  ], warnings: [], meta: {} }) } };
  const rows = await grvLogReport.getRows({ workspaceId: 'WS-1', filters: {}, services, view: 'line_detail' });
  assert.equal(rows[0].ledgerQty, 5, 'ledgerQty must be normalized to a magnitude, matching ledgerValue');
  const warnings = grvLogReport.validate({ rows, services, view: 'line_detail' });
  assert.equal(warnings.some((warning) => warning.code === 'grv-ledger-qty-mismatch'), false);
});

test('GRV and credit note lines flag a missing VAT figure instead of silently reporting R0', async () => {
  // Regression guard: `vat = safeNumber(row.vat ?? ...)` silently became 0 when the source
  // integration omitted VAT entirely, understating lineValueInclVat/workspace totals with no
  // signal anything was wrong. A genuine zero-value line (nothing to tax) must NOT be flagged.
  const grvServices = { reporting: { getGrvLogRows: async () => ({ rows: [
    { id: 'gl-novat', grvId: 'g-novat', sourceId: 'g-novat', grvDate: '2026-07-05', grvNumber: 'GRV-5', supplierName: 'Supplier A', locationName: 'Main', itemName: 'Flour', receivedQty: 10, baseUom: 'kg', unitCostExVat: 20, lineValueExVat: 200, ledgerQty: 10, ledgerValue: 200, ledgerRowCount: 1, status: 'Committed' }
  ], warnings: [], meta: {} }) } };
  const grvRows = await grvLogReport.getRows({ workspaceId: 'WS-1', filters: {}, services: grvServices, view: 'line_detail' });
  const grvWarnings = grvLogReport.validate({ rows: grvRows, services: grvServices, view: 'line_detail' });
  assert.ok(grvWarnings.some((warning) => warning.code === 'grv-missing-vat'));

  const creditServices = { reporting: { getCreditNoteReportRows: async () => ({ rows: [
    { id: 'cl-novat', creditNoteId: 'c-novat', sourceId: 'c-novat', creditNoteDate: '2026-07-06', creditNoteNumber: 'CN-5', supplierName: 'Supplier A', locationName: 'Main', itemName: 'Flour', reason: 'Damaged', qtyCredited: 2, baseUom: 'kg', unitCostExVat: 20, lineCreditExVat: 40, stockImpact: 'Financial Only' }
  ], warnings: [], meta: {} }) } };
  const creditRows = await creditNotesReport.getRows({ workspaceId: 'WS-1', filters: {}, services: creditServices, view: 'line_detail' });
  const creditWarnings = creditNotesReport.validate({ rows: creditRows, services: creditServices, view: 'line_detail' });
  assert.ok(creditWarnings.some((warning) => warning.code === 'credit-note-missing-vat'));
});

test('Phase 21 report definitions use real API services and no mock data imports', () => {
  for (const id of phase21Ids) assert.ok(getReportDefinition(id));
  const files = [
    'inventory/stockOnHandReport.js',
    'purchasing/purchaseOrdersReport.js',
    'purchasing/grvLogReport.js',
    'purchasing/creditNotesReport.js'
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/modules/reporting/reports', relative), 'utf8');
    assert.doesNotMatch(source, /mockReportData|mock data/i);
    assert.match(source, /fetch[A-Z]|services\.reporting/);
  }
  const worker = fs.readFileSync(path.join(process.cwd(), 'cloudflare-v2/src/legacy/reporting-phase21-routes.ts'), 'utf8');
  for (const table of ['stock_balances', 'purchase_orders', 'purchase_order_lines', 'grvs', 'grv_lines', 'credit_notes', 'credit_note_lines', 'stock_movements']) assert.match(worker, new RegExp(table));
});
