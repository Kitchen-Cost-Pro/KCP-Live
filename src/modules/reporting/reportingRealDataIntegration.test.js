import test from 'node:test';
import assert from 'node:assert/strict';
import { runReport } from './engine/reportRunner.js';
import { isReportingMockDataEnabled } from './api/reportingEndpoints.js';
import { __wastageReportInternals } from './reports/operations/wastageReport.js';
import { __adjustmentsReportInternals } from './reports/operations/adjustmentsReport.js';
import { __stockTransfersReportInternals } from './reports/operations/stockTransfersReport.js';

function makeApiRows() {
  return [
    {
      id: 'move-001',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-01',
      movementTime: '08:00:00',
      movementType: 'Purchase',
      sourceType: 'GRV',
      sourceId: 'grv-001',
      documentNumber: 'INV-001',
      qtyIn: 20,
      qtyOut: 0,
      netQty: 20,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: 1000,
      runningQty: 20,
      runningValue: 1000,
      createdByName: 'Ops Admin',
      notes: 'Received stock',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-002',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-01',
      movementTime: '12:00:00',
      movementType: 'Sale Usage',
      sourceType: 'Sale Usage',
      sourceId: 'sale-001',
      documentNumber: 'ORDER-001',
      qtyIn: 0,
      qtyOut: 5,
      netQty: -5,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -250,
      runningQty: 15,
      runningValue: 750,
      createdByName: 'Yoco Sync',
      notes: 'Sale depletion',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-003',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-01',
      movementTime: '13:00:00',
      movementType: 'Manufacturing Wastage',
      sourceType: 'Manufacturing Wastage',
      sourceId: 'batch-001',
      documentNumber: 'BATCH-001',
      qtyIn: 0,
      qtyOut: 2,
      netQty: -2,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -100,
      runningQty: 13,
      runningValue: 650,
      createdByName: 'Prep User',
      notes: 'Manufacturing wastage',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-004',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-01',
      movementTime: '14:00:00',
      movementType: 'Transfer Out',
      sourceType: 'Transfer Out',
      sourceId: 'transfer-001',
      documentNumber: 'TR-001',
      qtyIn: 0,
      qtyOut: 3,
      netQty: -3,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -150,
      runningQty: 10,
      runningValue: 500,
      createdByName: 'Ops Admin',
      notes: 'Transfer out',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-005',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-01',
      movementTime: '15:00:00',
      movementType: 'Manual Adjustment In',
      sourceType: 'Manual Adjustment',
      sourceId: 'adjustment-001',
      documentNumber: 'ADJ-001',
      qtyIn: 1,
      qtyOut: 0,
      netQty: 1,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: 50,
      runningQty: 11,
      runningValue: 550,
      createdByName: 'Ops Admin',
      notes: 'Manual adjustment',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-006',
      workspaceId: 'WS-real',
      locationId: 'loc-bar',
      locationName: 'Bar',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-01',
      movementTime: '14:05:00',
      movementType: 'Transfer In',
      sourceType: 'Transfer In',
      sourceId: 'transfer-001',
      documentNumber: 'TR-001',
      qtyIn: 3,
      qtyOut: 0,
      netQty: 3,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: 150,
      runningQty: 3,
      runningValue: 150,
      createdByName: 'Ops Admin',
      notes: 'Transfer in',
      raw: { sourceTable: 'stock_movements' }
    }
  ];
}

function realReportingServices(rows = makeApiRows()) {
  return {
    reporting: {
      getDetailedActivityLedger: async () => ({
        rows,
        warnings: [],
        meta: { workspaceId: 'WS-real', dataSource: 'real', generatedAt: '2026-07-01T16:00:00Z' }
      })
    }
  };
}

test('mock reporting data is not enabled by default', () => {
  assert.equal(isReportingMockDataEnabled({}), false);
});

test('Detailed Activity loads real API ledger rows and preserves stock movement calculations', async () => {
  const result = await runReport('detailed_activity', {
    workspaceId: 'WS-real',
    services: realReportingServices()
  });

  assert.equal(result.rows.length, 6);
  assert.equal(result.rows[0].__apiMeta.dataSource, 'real');
  for (const row of result.rows) {
    assert.equal(row.netQty, row.qtyIn - row.qtyOut);
    assert.equal(row.movementValue, row.netQty * row.unitCostExVat);
    assert.ok(!(row.qtyIn > 0 && row.qtyOut > 0));
  }

  const transferSources = new Set(result.rows.map((row) => row.source));
  assert.ok(transferSources.has('Transfer In'));
  assert.ok(transferSources.has('Transfer Out'));
  assert.ok(transferSources.has('Manufacturing Wastage'));
});

test('running quantity is preserved per item and location from real ledger rows', async () => {
  const result = await runReport('detailed_activity', {
    workspaceId: 'WS-real',
    services: realReportingServices()
  });

  const saleRow = result.rows.find((row) => row.id === 'move-002');
  const transferInRow = result.rows.find((row) => row.id === 'move-006');
  assert.equal(saleRow.runningQty, 15);
  assert.equal(transferInRow.runningQty, 3);
});

test('Operations Dashboard movement ledger matches Detailed Activity ledger for same real data', async () => {
  const services = realReportingServices();
  const detailed = await runReport('detailed_activity', { workspaceId: 'WS-real', services });
  const movementLedger = await runReport('operations_dashboard', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'movement_ledger' }
  });

  assert.deepEqual(
    movementLedger.rows.map((row) => [row.id, row.netQty, row.movementValue]),
    detailed.rows.map((row) => [row.id, row.netQty, row.movementValue])
  );
});

test('Operations Dashboard totals reconcile with real ledger rows and keeps wastage/transfers separate', async () => {
  const services = realReportingServices();
  const overview = await runReport('operations_dashboard', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'overview' }
  });
  const row = overview.rows[0];

  assert.equal(row.purchases, 1000);
  assert.equal(row.salesUsage, 250);
  assert.equal(row.manufacturingWastage, 100);
  assert.equal(row.manualWastage, 0);
  assert.equal(overview.totals.transfersIn, 150);
  assert.equal(overview.totals.transfersOut, 150);
  assert.equal(overview.totals.adjustments, 50);
  assert.equal(overview.totals.netStockMovement, 700);
});


function makeAdditionalWastageRows() {
  return [
    {
      id: 'move-007',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-02',
      movementTime: '09:00:00',
      movementType: 'Wastage Adjustment',
      sourceType: 'Wastage Adjustment',
      sourceId: 'waste-001',
      documentNumber: 'WST-001',
      qtyIn: 0,
      qtyOut: 1.5,
      netQty: -1.5,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -75,
      runningQty: 8.5,
      runningValue: 425,
      createdByName: 'Ops Admin',
      notes: 'Dropped during prep',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-008',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-02',
      movementTime: '10:00:00',
      movementType: 'Stock Take Variance',
      sourceType: 'Stock Take Variance',
      sourceId: 'stocktake-001',
      documentNumber: 'ST-001',
      qtyIn: 0,
      qtyOut: 1.2,
      netQty: -1.2,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -60,
      runningQty: 7.3,
      runningValue: 365,
      createdByName: 'Ops Admin',
      notes: 'Negative variance',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-009',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-02',
      movementTime: '11:00:00',
      movementType: 'Manufacturing Out',
      sourceType: 'Manufacturing Out',
      sourceId: 'batch-002',
      documentNumber: 'BATCH-002',
      qtyIn: 0,
      qtyOut: 4,
      netQty: -4,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -200,
      runningQty: 3.3,
      runningValue: 165,
      createdByName: 'Prep User',
      notes: 'Ingredient consumption',
      raw: { sourceTable: 'stock_movements' }
    }
  ];
}

test('Wastage Report uses real ledger rows and keeps wastage sources separate', async () => {
  const rows = [...makeApiRows(), ...makeAdditionalWastageRows()];
  const result = await runReport('wastage', {
    workspaceId: 'WS-real',
    services: realReportingServices(rows),
    filters: { view: 'line_detail' }
  });

  const sources = new Set(result.rows.map((row) => row.wastageSource));
  assert.equal(result.rows.length, 2);
  assert.ok(sources.has('Manufacturing Wastage'));
  assert.ok(sources.has('Stock Item Wastage'));
  assert.equal(sources.has('Stock Take Variance'), false);
  assert.equal(sources.has('Manufacturing Out'), false);
  assert.equal(sources.has('Sale Usage'), false);
  assert.equal(result.totals.qtyWasted, 3.5);
  assert.equal(result.totals.wastageValue, 175);
});

test('Wastage Report source view percentages and totals reconcile to Detailed Activity wastage rows', async () => {
  const rows = [...makeApiRows(), ...makeAdditionalWastageRows()];
  const services = realReportingServices(rows);
  const detailed = await runReport('detailed_activity', { workspaceId: 'WS-real', services });
  const wastageRows = __wastageReportInternals.buildWastageRows(detailed.rows);
  const bySource = await runReport('wastage', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'by_source' }
  });

  assert.equal(sum(bySource.rows, 'wastageValue'), sum(wastageRows, 'wastageValue'));
  assert.equal(bySource.totals.wastageValue, 175);
  assert.equal(bySource.totals.percentOfTotalWastage, 1);
});

test('Wastage Report manual and manufacturing wastage reconcile with Operations Dashboard wastage totals', async () => {
  const rows = [...makeApiRows(), makeAdditionalWastageRows()[0]];
  const services = realReportingServices(rows);
  const wastage = await runReport('wastage', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'by_source' }
  });
  const operations = await runReport('operations_dashboard', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'overview' }
  });

  assert.equal(wastage.totals.wastageValue, operations.totals.manufacturingWastage + operations.totals.manualWastage);
});

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function makeStockTakeApiRows() {
  return [
    {
      id: 'stcl-001',
      workspaceId: 'WS-real',
      stockTakeSessionId: 'stocktake-001',
      sourceId: 'stocktake-001',
      stockTakeDate: '2026-07-02',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      status: 'posted',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      category: 'Meat',
      countedUom: 'kg',
      countedQty: 8.8,
      convertedBaseQty: 8.8,
      expectedBaseQty: 10,
      expectedQty: 10,
      varianceQty: -1.2,
      baseUom: 'kg',
      uomRatio: 1,
      unitCostExVat: 50,
      expectedValue: 500,
      countedValue: 440,
      varianceValue: -60,
      countedAt: '2026-07-02T09:00:00Z',
      committedBy: 'Ops Admin',
      committedAt: '2026-07-02T09:02:00Z',
      user: 'Ops Admin',
      notes: 'Counted lower',
      ledgerNetQty: -1.2,
      ledgerMovementValue: -60,
      ledgerRowCount: 1,
      varianceMovementRowCount: 1
    },
    {
      id: 'stcl-002',
      workspaceId: 'WS-real',
      stockTakeSessionId: 'stocktake-001',
      sourceId: 'stocktake-001',
      stockTakeDate: '2026-07-02',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      status: 'posted',
      itemId: 'item-buns',
      itemName: 'Burger Buns',
      category: 'Bakery',
      countedUom: 'ea',
      countedQty: 55,
      convertedBaseQty: 55,
      expectedBaseQty: 50,
      expectedQty: 50,
      varianceQty: 5,
      baseUom: 'ea',
      uomRatio: 1,
      unitCostExVat: 2,
      expectedValue: 100,
      countedValue: 110,
      varianceValue: 10,
      countedAt: '2026-07-02T09:00:00Z',
      committedBy: 'Ops Admin',
      committedAt: '2026-07-02T09:02:00Z',
      user: 'Ops Admin',
      notes: '',
      ledgerNetQty: 5,
      ledgerMovementValue: 10,
      ledgerRowCount: 1,
      varianceMovementRowCount: 1
    }
  ];
}

function makeStockTakeLedgerRows() {
  return [
    ...makeApiRows(),
    {
      id: 'move-st-001',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-02',
      movementTime: '09:02:00',
      movementType: 'Stock Take Variance',
      sourceType: 'Stock Take Variance',
      sourceId: 'stocktake-001',
      documentNumber: 'stocktake-001',
      qtyIn: 0,
      qtyOut: 1.2,
      netQty: -1.2,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -60,
      runningQty: 8.8,
      runningValue: 440,
      createdByName: 'Ops Admin',
      notes: 'Stock take variance',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-st-002',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-buns',
      itemName: 'Burger Buns',
      categoryName: 'Bakery',
      movementDate: '2026-07-02',
      movementTime: '09:02:00',
      movementType: 'Stock Take Variance',
      sourceType: 'Stock Take Variance',
      sourceId: 'stocktake-001',
      documentNumber: 'stocktake-001',
      qtyIn: 5,
      qtyOut: 0,
      netQty: 5,
      baseUom: 'ea',
      unitCostExVat: 2,
      movementValue: 10,
      runningQty: 55,
      runningValue: 110,
      createdByName: 'Ops Admin',
      notes: 'Stock take variance',
      raw: { sourceTable: 'stock_movements' }
    }
  ];
}

function stockTakeReportingServices() {
  return {
    reporting: {
      getDetailedActivityLedger: async () => ({
        rows: makeStockTakeLedgerRows(),
        warnings: [],
        meta: { workspaceId: 'WS-real', dataSource: 'real', generatedAt: '2026-07-02T10:00:00Z' }
      }),
      getStockTakeAuditRows: async () => ({
        rows: makeStockTakeApiRows(),
        warnings: [],
        meta: { workspaceId: 'WS-real', dataSource: 'real', generatedAt: '2026-07-02T10:00:00Z' }
      })
    }
  };
}

test('Stock Take Audit opens all views from real stock take rows and variance ledger rows', async () => {
  const services = stockTakeReportingServices();
  for (const view of ['sessions', 'by_category', 'by_item', 'count_detail', 'variance_movements']) {
    const result = await runReport('stock_take_audit', {
      workspaceId: 'WS-real',
      services,
      filters: { view }
    });
    assert.ok(result.rows.length > 0, `${view} should have rows`);
  }
});

test('Stock Take Audit treats committed counts as base quantities and totals session variance values', async () => {
  const result = await runReport('stock_take_audit', {
    workspaceId: 'WS-real',
    services: stockTakeReportingServices(),
    filters: { view: 'sessions' }
  });
  const session = result.rows[0];
  assert.equal(session.itemsCounted, 2);
  assert.equal(session.itemsWithVariance, 2);
  assert.equal(session.totalExpectedValue, 600);
  assert.equal(session.totalCountedValue, 550);
  assert.equal(session.varianceValue, -50);
  assert.equal(result.totals.varianceValue, -50);
});

test('Stock Take Audit variance movements reconcile to Detailed Activity Stock Take Variance rows', async () => {
  const services = stockTakeReportingServices();
  const stockTake = await runReport('stock_take_audit', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'variance_movements' }
  });
  const detailed = await runReport('detailed_activity', { workspaceId: 'WS-real', services });
  const detailedStockTakeRows = detailed.rows.filter((row) => row.source === 'Stock Take Variance');

  assert.deepEqual(
    stockTake.rows.map((row) => [row.id, row.netQty, row.movementValue]),
    detailedStockTakeRows.map((row) => [row.id, row.netQty, row.movementValue])
  );
});

test('Negative Stock Take Variance is excluded from Wastage Report and remains an Operations Dashboard adjustment', async () => {
  const services = stockTakeReportingServices();
  const wastage = await runReport('wastage', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'line_detail' }
  });
  const operations = await runReport('operations_dashboard', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'overview' }
  });

  assert.equal(wastage.rows.some((row) => row.wastageSource === 'Stock Take Variance'), false);
  assert.equal(operations.totals.adjustments, -50 + 50); // stock take net variance plus existing manual adjustment from makeApiRows
});


function makeAdditionalAdjustmentRows() {
  return [
    {
      id: 'move-adj-001',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-03',
      movementTime: '08:00:00',
      movementType: 'Wastage Adjustment',
      sourceType: 'Wastage Adjustment',
      sourceId: 'waste-002',
      documentNumber: 'WST-002',
      qtyIn: 0,
      qtyOut: 2,
      netQty: -2,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -100,
      runningQty: 9,
      runningValue: 450,
      createdByName: 'Ops Admin',
      notes: 'Expired stock',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-adj-002',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-03',
      movementTime: '09:00:00',
      movementType: 'Stock Take Variance',
      sourceType: 'Stock Take Variance',
      sourceId: 'stocktake-002',
      documentNumber: 'ST-002',
      qtyIn: 0,
      qtyOut: 1,
      netQty: -1,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: -50,
      runningQty: 8,
      runningValue: 400,
      createdByName: 'Ops Admin',
      notes: 'Stock take loss',
      raw: { sourceTable: 'stock_movements' }
    },
    {
      id: 'move-adj-003',
      workspaceId: 'WS-real',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'item-beef',
      itemName: 'Beef Patty',
      categoryName: 'Meat',
      movementDate: '2026-07-03',
      movementTime: '10:00:00',
      movementType: 'System Correction',
      sourceType: 'System Correction',
      sourceId: 'system-001',
      documentNumber: 'SYS-001',
      qtyIn: 0.5,
      qtyOut: 0,
      netQty: 0.5,
      baseUom: 'kg',
      unitCostExVat: 50,
      movementValue: 25,
      runningQty: 8.5,
      runningValue: 425,
      createdByName: 'System Admin',
      notes: 'System correction',
      raw: { sourceTable: 'stock_movements' }
    }
  ];
}

test('Adjustments Report uses real ledger rows and includes adjustment source types only', async () => {
  const rows = [...makeApiRows(), ...makeAdditionalAdjustmentRows()];
  const result = await runReport('adjustments', {
    workspaceId: 'WS-real',
    services: realReportingServices(rows),
    filters: { view: 'line_detail' }
  });

  const sources = new Set(result.rows.map((row) => row.adjustmentType));
  // Stock Take Variance has its own dedicated Stock Take Audit report and is deliberately excluded
  // here (see isAdjustmentLedgerRow) — down from 4 rows to 3 once move-adj-002 drops out.
  assert.equal(result.rows.length, 3);
  assert.ok(sources.has('Manual Adjustment'));
  assert.ok(sources.has('Stock Item Wastage'));
  assert.ok(sources.has('System Correction'));
  assert.equal(sources.has('Stock Take Variance'), false);
  assert.equal(sources.has('GRV'), false);
  assert.equal(sources.has('Sale Usage'), false);
  assert.equal(result.totals.qtyAdjusted, -0.5);
  assert.equal(result.totals.valueImpact, -25);
});

test('Adjustments Report derives Qty Before and Qty After from running quantity', async () => {
  const rows = [...makeApiRows(), ...makeAdditionalAdjustmentRows()];
  const result = await runReport('adjustments', {
    workspaceId: 'WS-real',
    services: realReportingServices(rows),
    filters: { view: 'line_detail' }
  });

  const manualAdjustment = result.rows.find((row) => row.sourceId === 'adjustment-001');
  assert.equal(manualAdjustment.qtyAdjusted, 1);
  assert.equal(manualAdjustment.qtyAfter, 11);
  assert.equal(manualAdjustment.qtyBefore, 10);
});

test('Adjustments Report reconciles to Detailed Activity and Operations Dashboard adjustment totals', async () => {
  const rows = [...makeApiRows(), ...makeAdditionalAdjustmentRows()];
  const services = realReportingServices(rows);
  const detailed = await runReport('detailed_activity', { workspaceId: 'WS-real', services });
  const adjustmentLedgerRows = __adjustmentsReportInternals.buildAdjustmentRows(detailed.rows);
  const adjustments = await runReport('adjustments', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'line_detail' }
  });
  const operations = await runReport('operations_dashboard', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'overview' }
  });

  assert.equal(adjustments.totals.valueImpact, sum(adjustmentLedgerRows, 'valueImpact'));
  const nonWastageAdjustmentValue = adjustments.rows
    .filter((row) => !['Stock Item Wastage', 'Product Wastage'].includes(row.adjustmentType))
    .reduce((total, row) => total + Number(row.valueImpact || 0), 0);
  // Stock Take Variance has its own dedicated Stock Take Audit report and is deliberately excluded
  // from the Adjustments Report (see isAdjustmentLedgerRow), but Operations Dashboard's generic
  // "adjustments" bucket still reconciles every stock-affecting cause including stock takes -- these
  // two totals now have different scope by design, so the stock take contribution must be added back
  // in separately rather than expecting a direct 1:1 match.
  const stockTakeVarianceValue = detailed.rows
    .filter((row) => row.movementType === 'Stock Take Variance')
    .reduce((total, row) => total + Number(row.movementValue || 0), 0);
  assert.equal(nonWastageAdjustmentValue + stockTakeVarianceValue, operations.totals.adjustments);
});

test('Wastage Adjustment values in Adjustments Report reconcile to Wastage Report', async () => {
  const rows = [...makeApiRows(), ...makeAdditionalAdjustmentRows()];
  const services = realReportingServices(rows);
  const adjustments = await runReport('adjustments', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'line_detail' }
  });
  const wastage = await runReport('wastage', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'line_detail' }
  });

  const adjustmentWastageValue = adjustments.rows
    .filter((row) => ['Stock Item Wastage', 'Product Wastage'].includes(row.adjustmentType))
    .reduce((total, row) => total + Math.abs(Number(row.valueImpact || 0)), 0);
  const wastageAdjustmentValue = wastage.rows
    .filter((row) => row.wastageSource === 'Stock Item Wastage')
    .reduce((total, row) => total + Number(row.wastageValue || 0), 0);

  assert.equal(adjustmentWastageValue, wastageAdjustmentValue);
});


test('Stock Transfers Report opens all views from real transfer ledger rows', async () => {
  const services = realReportingServices();
  for (const view of ['summary', 'by_item', 'by_location', 'line_detail', 'movement_ledger']) {
    const result = await runReport('stock_transfers', {
      workspaceId: 'WS-real',
      services,
      filters: { view }
    });
    assert.ok(result.rows.length > 0, `${view} should have transfer rows`);
  }
});

test('Stock Transfers Report keeps Transfer In and Transfer Out as separate movement rows', async () => {
  const result = await runReport('stock_transfers', {
    workspaceId: 'WS-real',
    services: realReportingServices(),
    filters: { view: 'line_detail' }
  });

  const directions = new Set(result.rows.map((row) => row.direction));
  assert.equal(result.rows.length, 2);
  assert.ok(directions.has('Transfer In'));
  assert.ok(directions.has('Transfer Out'));
  assert.equal(result.totals.qtyIn, 3);
  assert.equal(result.totals.qtyOut, 3);
  assert.equal(result.totals.netQty, 0);
  assert.equal(result.totals.movementValue, 0);
});

test('Stock Transfers Report pairs transfer rows by source ID and shows clean source and destination names', async () => {
  const result = await runReport('stock_transfers', {
    workspaceId: 'WS-real',
    services: realReportingServices(),
    filters: { view: 'summary' }
  });
  const summary = result.rows[0];

  assert.equal(summary.sourceId, 'transfer-001');
  assert.equal(summary.transferNumber, 'TR-001');
  assert.equal(summary.fromLocationName, 'Main Kitchen');
  assert.equal(summary.toLocationName, 'Bar');
  assert.equal(summary.items, 1);
  assert.equal(summary.totalQty, 3);
  assert.equal(summary.totalTransferValue, 150);
});

test('Stock Transfers Report values reconcile to Detailed Activity and Operations Dashboard transfer totals', async () => {
  const services = realReportingServices();
  const detailed = await runReport('detailed_activity', { workspaceId: 'WS-real', services });
  const transferLedgerRows = __stockTransfersReportInternals.buildTransferRows(detailed.rows);
  const lineDetail = await runReport('stock_transfers', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'line_detail' }
  });
  const byLocation = await runReport('stock_transfers', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'by_location' }
  });
  const operations = await runReport('operations_dashboard', {
    workspaceId: 'WS-real',
    services,
    filters: { view: 'overview' }
  });

  assert.deepEqual(
    lineDetail.rows.map((row) => [row.id, row.netQty, row.movementValue]),
    transferLedgerRows.map((row) => [row.id, row.netQty, row.movementValue])
  );
  assert.equal(byLocation.totals.transfersInValue, operations.totals.transfersIn);
  assert.equal(byLocation.totals.transfersOutValue, operations.totals.transfersOut);
  assert.equal(byLocation.totals.netTransferValue, 0);
});
