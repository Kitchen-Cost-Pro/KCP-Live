import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAverageDailyUsage, calculateDaysUntilStockOut, calculateForecastStockOutDate, calculateRecommendedReorderQty, calculateWeightedAverageUsage } from '../../engine/forecasting.js';
import { calculateAccuracyPercent, calculateCoefficientOfVariation, calculateExpectedClosingStock, calculateVolatilityPercent, calculateWeightedAverageCost } from '../../engine/statistics.js';
import { calculateRiskScore, priceVolatilityStatus } from '../../engine/riskScoring.js';
import { listReports } from '../index.js';
import { buildStockOutForecastModel } from './stockOutForecastReport.js';
import { buildPriceVolatilityModel } from './priceVolatilityReport.js';
import { buildTheoreticalVsActualModel } from './theoreticalVsActualReport.js';

function isoDays(endDate, count) {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (count - index - 1));
    return date.toISOString().slice(0, 10);
  });
}

function response(rows) {
  return { rows, warnings: [], meta: { dataSource: 'real', generatedAt: '2026-07-10T12:00:00.000Z' } };
}

test('Phase 22 formula helpers calculate forecast, volatility, variance, accuracy, and risk values', () => {
  assert.equal(calculateAverageDailyUsage(70, 14), 5);
  assert.equal(calculateWeightedAverageUsage({ usage7Day: 14, usage14Day: 28, usage30Day: 60 }), 2);
  assert.equal(calculateDaysUntilStockOut(10, 2), 5);
  assert.equal(calculateForecastStockOutDate('2026-07-10', 5), '2026-07-15');
  assert.equal(calculateRecommendedReorderQty(10, 30), 20);

  assert.ok(Math.abs(calculateWeightedAverageCost([{ qty: 10, unitCostExVat: 10 }, { qty: 20, unitCostExVat: 12 }]) - (340 / 30)) < 0.000001);
  assert.ok(Math.abs(calculateVolatilityPercent(10, 12, 340 / 30) - (2 / (340 / 30))) < 0.000001);
  assert.ok(calculateCoefficientOfVariation([10, 12]) > 0);
  assert.equal(priceVolatilityStatus({ purchasesCount: 2, volatilityPercent: 0.18, costChangePercent: 0.2 }), 'High');

  assert.equal(calculateExpectedClosingStock({ openingStock: 100, purchases: 20, transfersIn: 5, theoreticalUsage: 35, wastage: 3, transfersOut: 5 }), 82);
  assert.equal(calculateAccuracyPercent(82, 82), 1);
  assert.equal(calculateRiskScore({ probability: 100, financialImpact: 100, urgency: 100, dataConfidence: 100 }), 90);
});

test('Stock-Out Forecast uses location stock and real ledger usage to produce forecast and reorder values', async () => {
  const usageRows = isoDays('2026-07-10', 30).map((date, index) => ({
    id: `sale-${index}`,
    date,
    locationId: 'main',
    locationName: 'Main Kitchen',
    itemId: 'flour',
    itemName: 'Flour',
    category: 'Dry Goods',
    movementType: 'Sale Usage',
    source: 'Sale Usage',
    qtyIn: 0,
    qtyOut: 2,
    netQty: -2,
    baseUom: 'kg',
    unitCostExVat: 2,
    movementValue: -4,
    sourceId: `sale-${index}`
  }));
  const services = { reporting: {
    getStockOnHandRows: async () => response([{ itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', locationId: 'main', locationName: 'Main Kitchen', currentStock: 10, baseUom: 'kg', unitCostExVat: 2, lowStockThreshold: 5, parLevel: 30, supplierId: 'sup-1', supplierName: 'Supplier One', hasLocationBalance: true }]),
    getDetailedActivityLedger: async () => response(usageRows)
  } };

  const model = await buildStockOutForecastModel({ workspaceId: 'WS-1', filters: { endDate: '2026-07-10', lookbackPeriod: 30 }, services });
  assert.equal(model.filteredRows.length, 1);
  const row = model.filteredRows[0];
  assert.equal(row.currentStock, 10);
  assert.equal(row.usageLast7Days, 14);
  assert.equal(row.usageLast30Days, 60);
  assert.equal(row.weightedDailyUsage, 2);
  assert.equal(row.daysUntilStockOut, 5);
  assert.equal(row.forecastStockOutDate, '2026-07-15');
  assert.equal(row.recommendedReorderQty, 20);
  assert.equal(row.estimatedReorderValue, 40);
  assert.equal(row.riskStatus, 'High Risk');
  assert.ok(row.riskScore > 0);
});

test('Price Volatility uses committed GRV costs and keeps credit notes in auditable price history', async () => {
  const services = { reporting: {
    getGrvLogRows: async () => response([
      { id: 'g1-line', grvId: 'g1', sourceId: 'g1', grvDate: '2026-06-01', grvNumber: 'GRV-1', supplierId: 'sup-1', supplierName: 'Supplier One', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', receivedQty: 10, baseUom: 'kg', unitCostExVat: 10, lineValueExVat: 100, status: 'Committed' },
      { id: 'g2-line', grvId: 'g2', sourceId: 'g2', grvDate: '2026-07-01', grvNumber: 'GRV-2', supplierId: 'sup-1', supplierName: 'Supplier One', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', receivedQty: 20, baseUom: 'kg', unitCostExVat: 12, lineValueExVat: 240, status: 'Committed' }
    ]),
    getPurchaseOrderReportRows: async () => response([]),
    getCreditNoteReportRows: async () => response([
      { id: 'cn1-line', creditNoteId: 'cn1', sourceId: 'cn1', creditNoteDate: '2026-07-05', creditNoteNumber: 'CN-1', supplierId: 'sup-1', supplierName: 'Supplier One', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', reason: 'Price correction', qtyCredited: 1, baseUom: 'kg', unitCostExVat: 12, lineCreditExVat: 12, stockImpact: 'Financial Only' }
    ])
  } };

  const model = await buildPriceVolatilityModel({ workspaceId: 'WS-1', filters: {}, services });
  assert.equal(model.rows.length, 1);
  const row = model.rows[0];
  assert.equal(row.firstCostExVat, 10);
  assert.equal(row.lastPurchaseCostExVat, 12);
  assert.ok(Math.abs(row.weightedAverageCostExVat - (340 / 30)) < 0.000001);
  assert.equal(row.costChange, 2);
  assert.equal(row.costChangePercent, 0.2);
  assert.equal(row.riskStatus, 'High');
  assert.equal(model.priceHistory.length, 3);
  const credit = model.priceHistory.find((entry) => entry.sourceType === 'Credit Note');
  assert.ok(credit);
  assert.equal(credit.qtyPurchased, -1);
  assert.equal(credit.purchaseValue, -12);
});

test('Theoretical vs Actual reconciles opening, inbound, theoretical usage, wastage, transfers, and committed stock take', async () => {
  const ledger = [
    { id: 'grv', date: '2026-07-01', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', movementType: 'GRV', source: 'GRV', qtyIn: 20, qtyOut: 0, netQty: 20, runningQty: 120, baseUom: 'kg', unitCostExVat: 5, movementValue: 100, sourceId: 'grv' },
    { id: 'transfer-in', date: '2026-07-02', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', movementType: 'Transfer In', source: 'Transfer In', qtyIn: 5, qtyOut: 0, netQty: 5, runningQty: 125, baseUom: 'kg', unitCostExVat: 5, movementValue: 25, sourceId: 'transfer-in' },
    { id: 'sale', date: '2026-07-06', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', movementType: 'Sale Usage', source: 'Sale Usage', qtyIn: 0, qtyOut: 35, netQty: -35, runningQty: 90, baseUom: 'kg', unitCostExVat: 5, movementValue: -175, sourceId: 'sale' },
    { id: 'waste', date: '2026-07-08', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', movementType: 'Wastage Adjustment', source: 'Wastage Adjustment', qtyIn: 0, qtyOut: 3, netQty: -3, runningQty: 87, baseUom: 'kg', unitCostExVat: 5, movementValue: -15, sourceId: 'waste' },
    { id: 'transfer-out', date: '2026-07-09', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', movementType: 'Transfer Out', source: 'Transfer Out', qtyIn: 0, qtyOut: 5, netQty: -5, runningQty: 82, baseUom: 'kg', unitCostExVat: 5, movementValue: -25, sourceId: 'transfer-out' }
  ];
  const services = { reporting: {
    getStockOnHandRows: async () => response([{ itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', locationId: 'main', locationName: 'Main Kitchen', currentStock: 82, baseUom: 'kg', unitCostExVat: 5, hasLocationBalance: true }]),
    getDetailedActivityLedger: async () => response(ledger),
    getStockTakeAuditRows: async () => response([{ id: 'st-line', stockTakeSessionId: 'st-1', sourceId: 'st-1', stockTakeDate: '2026-07-10', status: 'Committed', locationId: 'main', locationName: 'Main Kitchen', itemId: 'flour', itemName: 'Flour', category: 'Dry Goods', expectedQty: 82, countedQty: 82, convertedBaseQty: 82, baseUom: 'kg', unitCostExVat: 5 }]),
    getSaleStockUsageRows: async () => response([{ id: 'usage-1', sourceId: 'usage-1', saleDate: '2026-07-06', locationId: 'main', locationName: 'Main Kitchen', inventoryItemId: 'flour', inventoryItemName: 'Flour', inventoryCategoryName: 'Dry Goods', sourceType: 'Sale Usage', qtyUsed: 35, totalQtyUsed: 35, baseUom: 'kg', unitCostExVat: 5, menuItemId: 'menu-1', menuItemName: 'Bread', receiptNumber: 'R-1' }])
  } };

  const model = await buildTheoreticalVsActualModel({ workspaceId: 'WS-1', filters: { startDate: '2026-07-01', endDate: '2026-07-10' }, services });
  assert.equal(model.rows.length, 1);
  const row = model.rows[0];
  assert.equal(row.openingStock, 100);
  assert.equal(row.purchases, 20);
  assert.equal(row.transfersIn, 5);
  assert.equal(row.theoreticalUsageQty, 35);
  assert.equal(row.wastageQty, 3);
  assert.equal(row.transfersOut, 5);
  assert.equal(row.expectedClosingStock, 82);
  assert.equal(row.actualClosingStock, 82);
  assert.equal(row.varianceQty, 0);
  assert.equal(row.varianceValue, 0);
  assert.equal(row.accuracyPercent, 1);
  assert.equal(row.hasStockTake, true);
  assert.match(model.views.formula_breakdown[0].formulaResult, /^82 = 100 \+ 20 \+ 5 \+ 0 - 35 - 3 - 5$/);
});

test('Advanced registry exposes only the three Phase 22 reports', () => {
  assert.deepEqual(listReports({ section: 'advanced' }).map((report) => report.id), [
    'stock_out_forecast',
    'price_volatility_analysis',
    'theoretical_vs_actual'
  ]);
  assert.equal(listReports().some((report) => /custom.*builder/i.test(report.title)), false);
});
