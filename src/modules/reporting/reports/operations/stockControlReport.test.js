import test from 'node:test';
import assert from 'node:assert/strict';
import { getReportDefinition, listReports } from '../index.js';
import { buildStockControlViews } from './stockControlReport.js';
import { normalizeApiStockControlRow } from '../../api/reportingMappers.js';

const rows = [
  {
    id: 'flour-main',
    itemId: 'flour',
    itemName: 'Flour',
    category: 'Dry Goods',
    itemType: 'raw',
    locationId: 'main',
    locationName: 'Main Kitchen',
    currentStock: 0,
    baseUom: 'kg',
    lowStockThreshold: 5,
    parLevel: 20,
    requiredQty: 20,
    unitCostExVat: 10,
    estimatedReorderValue: 200,
    supplierId: 'sup-1',
    supplierName: 'ABC Foods',
    lastPurchaseCost: 11,
    lastPurchasedDate: '2026-07-01',
    purchaseUom: 'bag',
    purchaseUomRatio: 10,
    purchaseUomQty: 2,
    status: 'Critical',
    suggestedAction: 'Reorder urgently',
    lastUpdated: '2026-07-09'
  },
  {
    id: 'sugar-main',
    itemId: 'sugar',
    itemName: 'Sugar',
    category: 'Dry Goods',
    itemType: 'raw',
    locationId: 'main',
    locationName: 'Main Kitchen',
    currentStock: 4,
    baseUom: 'kg',
    lowStockThreshold: 5,
    parLevel: 15,
    requiredQty: 11,
    unitCostExVat: 8,
    estimatedReorderValue: 88,
    supplierId: 'sup-1',
    supplierName: 'ABC Foods',
    purchaseUom: 'bag',
    purchaseUomRatio: 5,
    purchaseUomQty: 2.2,
    status: 'Low',
    suggestedAction: 'Reorder soon',
    lastUpdated: '2026-07-09'
  },
  {
    id: 'milk-bar',
    itemId: 'milk',
    itemName: 'Milk',
    category: 'Dairy',
    itemType: 'raw',
    locationId: 'bar',
    locationName: 'Bar',
    currentStock: 8,
    baseUom: 'l',
    lowStockThreshold: 3,
    parLevel: 10,
    requiredQty: 2,
    unitCostExVat: 12,
    estimatedReorderValue: 24,
    supplierName: '',
    purchaseUom: '',
    purchaseUomRatio: 0,
    purchaseUomQty: 0,
    status: 'Below Par',
    suggestedAction: 'Missing supplier',
    lastUpdated: '2026-07-09'
  }
];

test('Reporting Dashboard exposes one Stock Control tile under stock control section', () => {
  const stockControlReports = listReports({ section: 'stock_control' }).map((report) => report.id);
  assert.deepEqual(stockControlReports, ['stock_control']);
  assert.equal(getReportDefinition('stock_control').title, 'Stock Control');
});

test('Stock Control builds all views from location-specific stock rows', () => {
  const model = buildStockControlViews({ rows, warningRows: [] });
  assert.equal(model.item_detail.length, 3);
  assert.equal(model.reorder_detail.length, 3);
  assert.equal(model.location_summary.length, 2);
  assert.equal(model.category_summary.length, 2);
  assert.equal(model.supplier_reorder.length, 2);
  assert.equal(model.warnings.length, 0);

  const main = model.location_summary.find((row) => row.locationName === 'Main Kitchen');
  assert.equal(main.criticalItems, 1);
  assert.equal(main.lowStockItems, 1);
  assert.equal(main.belowParItems, 2);
  assert.equal(main.estimatedReorderValue, 288);

  const supplier = model.supplier_reorder.find((row) => row.supplierName === 'ABC Foods');
  assert.equal(supplier.itemsToOrder, 2);
  assert.equal(supplier.criticalItems, 1);
  assert.equal(supplier.estimatedReorderValue, 288);
});

test('Stock Control mapper keeps required quantity, purchase UOM and reorder value separate', () => {
  const row = normalizeApiStockControlRow({
    stock_item_id: 'flour',
    item_name: 'Flour',
    location_id: 'main',
    location_name: 'Main Kitchen',
    current_stock: 2,
    low_stock_threshold: 5,
    par_level: 20,
    unit_cost_ex_vat: 10,
    purchase_uom: 'bag',
    purchase_uom_ratio: 10,
    status: 'Below Par'
  });
  assert.equal(row.requiredQty, 18);
  assert.equal(row.estimatedReorderValue, 180);
  assert.equal(row.purchaseUomQty, 1.8);
});

test('Stock Control warning view exposes only customer-actionable setup issues', () => {
  const model = buildStockControlViews({
    rows,
    warningRows: [
      {
        id: 'missing-cost',
        issueType: 'Missing cost',
        issue: 'Stock item has no unit cost.',
        suggestedFix: 'Add a unit cost.'
      },
      {
        id: 'missing-receipt',
        issueType: 'Missing receipt ID',
        issue: 'Receipt ID is missing from the source event.',
        suggestedFix: 'Worker must repair the event.'
      }
    ]
  });

  assert.equal(model.warnings.length, 1);
  assert.equal(model.warnings[0].issueType, 'Missing cost');
});
