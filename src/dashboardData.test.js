import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateInventoryRows, buildDashboardModel, getDashboardDateRange } from './dashboardData.js';

test('dashboard date range defaults to the current day', () => {
  const range = getDashboardDateRange(new Date(2026, 6, 10), { from: '2026-07-10', to: '2026-07-10' });
  assert.equal(range.from, '2026-07-10');
  assert.equal(range.to, '2026-07-10');
  assert.equal(range.dayCount, 1);
});

test('a single-day dashboard range buckets the trend by hour, honouring the trading day start hour', () => {
  const range = getDashboardDateRange(new Date(2026, 8, 4), {
    from: '2026-09-04',
    to: '2026-09-04',
    tradingDayStartHour: 5
  });
  assert.equal(range.granularity, 'hour');
  assert.equal(range.buckets.length, 24);
  assert.equal(range.buckets[0].label, '05:00');
  assert.equal(range.buckets[0].key, '2026-09-04T05');
  assert.equal(range.buckets.at(-1).label, '04:00');
  assert.equal(range.buckets.at(-1).key, '2026-09-05T04');
  assert.equal(range.label, '05:00 – 05:00 · 04 Sept 2026');

  const model = buildDashboardModel({
    now: new Date(2026, 8, 4),
    range,
    ledgerRows: [
      { date: '2026-09-04 06:30:00', source: 'Sale Usage', movementValue: -150 },
      { date: '2026-09-05 02:15:00', source: 'Sale Usage', movementValue: -50 }
    ]
  });

  const sixAm = model.trend.find((bucket) => bucket.label === '06:00');
  const twoAmNextDay = model.trend.find((bucket) => bucket.label === '02:00');
  assert.equal(sixAm.cos, 150);
  assert.equal(twoAmNextDay.cos, 50);
});

test('a date-only sales row (no time-of-day) still counts toward today when the trading day starts mid-morning', () => {
  // payment_sales_financial's daily_summary view reports one row per calendar day with no
  // time-of-day at all — defaulting that to midnight would put "today" before the 05:00 trading
  // day boundary and misattribute the whole day's sales to the prior period.
  const range = getDashboardDateRange(new Date(2026, 8, 4), {
    from: '2026-09-04',
    to: '2026-09-04',
    tradingDayStartHour: 5
  });

  const model = buildDashboardModel({
    now: new Date(2026, 8, 4),
    range,
    salesRows: [
      { date: '2026-09-04', netSales: 1000, grossSales: 1150 },
      { date: '2026-09-03', netSales: 400, grossSales: 460 }
    ]
  });

  assert.equal(model.metrics.netSales, 1000);
});

test('inventory rows stay split by location so stock status is never based on cumulative quantity', () => {
  const rows = aggregateInventoryRows([
    { itemId: 'a', itemName: 'Milk', currentStock: 25, parLevel: 20, unitCostExVat: 10, status: 'Healthy', locationId: 'bar', locationName: 'Bar' },
    { itemId: 'a', itemName: 'Milk', currentStock: 0, parLevel: 20, unitCostExVat: 12, status: 'Critical', locationId: 'kitchen', locationName: 'Kitchen' }
  ]);
  assert.equal(rows.length, 2);
  const bar = rows.find((row) => row.locationId === 'bar');
  const kitchen = rows.find((row) => row.locationId === 'kitchen');
  assert.equal(bar.qty, 25);
  assert.equal(bar.reorder, 20);
  assert.equal(bar.status, 'ok');
  assert.equal(bar.totalValue, 250);
  assert.equal(kitchen.qty, 0);
  assert.equal(kitchen.status, 'critical');
});

test('dashboard model derives KPI and trend values from reporting rows', () => {
  const model = buildDashboardModel({
    now: new Date(2026, 6, 10),
    ledgerRows: [
      { date: '2026-07-02', source: 'Sale Usage', movementValue: -400 },
      { date: '2026-07-03', source: 'Wastage Adjustment', movementValue: -40 },
      { date: '2026-07-04', source: 'Manufacturing Wastage', movementValue: -10 },
      { date: '2026-07-05', source: 'Manual Adjustment', movementValue: -20 },
      { date: '2026-06-05', source: 'Sale Usage', movementValue: -200 }
    ],
    salesRows: [
      { date: '2026-07-02', netSales: 1000, grossSales: 1150 },
      { date: '2026-06-02', netSales: 500, grossSales: 575 }
    ],
    stockRows: [
      { itemId: 'a', itemName: 'Milk', currentStock: 10, unitCostExVat: 5, status: 'Healthy' },
      { itemId: 'b', itemName: 'Chicken', currentStock: 0, unitCostExVat: 20, status: 'Critical' }
    ]
  });

  assert.equal(model.metrics.totalStockValue, 50);
  assert.equal(model.metrics.costOfSales, 600);
  assert.equal(model.metrics.wastage, 50);
  assert.equal(model.metrics.grossMargin, 60);
  assert.equal(model.alerts.criticalCount, 1);
  assert.equal(model.trend.at(-1).adjustments, 20);
});

test('dashboard date range supports custom dates and an equal comparison period', () => {
  const range = getDashboardDateRange(new Date(2026, 6, 10), {
    from: '2026-07-01',
    to: '2026-07-10'
  });
  assert.equal(range.from, '2026-07-01');
  assert.equal(range.to, '2026-07-10');
  assert.equal(range.comparisonFrom, '2026-06-21');
  assert.equal(range.comparisonTo, '2026-06-30');
  assert.equal(range.granularity, 'day');
  assert.equal(range.buckets.length, 10);
});

test('dashboard model filters reporting rows by location', () => {
  const range = getDashboardDateRange(new Date(2026, 6, 10), {
    from: '2026-07-01',
    to: '2026-07-10'
  });
  const model = buildDashboardModel({
    now: new Date(2026, 6, 10),
    range,
    locationId: 'bar',
    ledgerRows: [
      { date: '2026-07-02', locationId: 'bar', locationName: 'Bar', source: 'Sale Usage', movementValue: -100 },
      { date: '2026-07-02', locationId: 'kitchen', locationName: 'Kitchen', source: 'Sale Usage', movementValue: -300 }
    ],
    salesRows: [
      { date: '2026-07-02', locationId: 'bar', locationName: 'Bar', netSales: 250 },
      { date: '2026-07-02', locationId: 'kitchen', locationName: 'Kitchen', netSales: 700 }
    ],
    stockRows: [
      { itemId: 'a', itemName: 'Milk', locationId: 'bar', locationName: 'Bar', currentStock: 10, unitCostExVat: 5 },
      { itemId: 'a', itemName: 'Milk', locationId: 'kitchen', locationName: 'Kitchen', currentStock: 30, unitCostExVat: 5 }
    ]
  });

  assert.equal(model.metrics.costOfSales, 100);
  assert.equal(model.metrics.netSales, 250);
  assert.equal(model.metrics.totalStockValue, 50);
  assert.equal(model.inventoryItems[0].locationCount, 1);
  assert.equal(model.inventoryItems[0].locationId, 'bar');
  assert.deepEqual(model.inventoryLocations, [{ id: 'bar', name: 'Bar' }]);
});
