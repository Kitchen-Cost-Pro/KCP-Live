import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildColumnTooltip } from './modules/reporting/tooltips/tooltipBuilder.js';
import { __wastageReportInternals } from './modules/reporting/reports/operations/wastageReport.js';
import { __adjustmentsReportInternals } from './modules/reporting/reports/operations/adjustmentsReport.js';
import { buildMenuItemWastageRows } from './modules/reporting/reports/operations/wastageSourceUtils.js';
import {
  buildStockControlViews,
  isManufacturedStockControlRow,
  isOrderableStockControlRow,
  stockControlReport,
} from './modules/reporting/reports/operations/stockControlReport.js';
import { __reportViewerInternals } from './modules/reporting/ReportViewer.js';

const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

function productWastageRows() {
  const common = {
    source: 'Wastage Adjustment',
    sourceType: 'wastage',
    movementType: 'Wastage Adjustment',
    sourceId: 'waste-product-1',
    documentType: 'wastage_adjustment',
    locationId: 'main',
    locationName: 'Main Store',
    date: '2026-07-13',
    unitCostExVat: 10,
    metadata: {
      productId: 'menu-burger',
      productName: 'Classic Burger',
      wastageQty: 3,
      reason: 'Burnt',
    },
    createdBy: 'Test User',
  };
  return [
    {
      ...common,
      id: 'waste-product-1-bun',
      itemId: 'bun',
      itemName: 'Burger Bun',
      qtyOut: 0.6,
      netQty: -0.6,
      movementValue: -6,
    },
    {
      ...common,
      id: 'waste-product-1-patty',
      itemId: 'patty',
      itemName: 'Burger Patty',
      qtyOut: 0.45,
      netQty: -0.45,
      movementValue: -4.5,
    },
  ];
}

function stockItemWastageRow() {
  return {
    id: 'waste-stock-1',
    source: 'Wastage Adjustment',
    sourceType: 'wastage',
    movementType: 'Wastage Adjustment',
    sourceId: 'waste-stock-1',
    locationId: 'main',
    locationName: 'Main Store',
    date: '2026-07-13',
    itemId: 'wine',
    itemName: 'Red Wine',
    qtyOut: 2,
    netQty: -2,
    unitCostExVat: 50,
    movementValue: -100,
    reason: 'Broken bottle',
    createdBy: 'Test User',
  };
}

test('Phase 46 gives every report column a useful fallback tooltip', () => {
  assert.match(buildColumnTooltip({ key: 'locationName', label: 'Location' }), /location/i);
  assert.match(buildColumnTooltip({ key: 'qtyMenuItemsWasted', label: 'Menu Items Wasted', type: 'number' }), /quantity|count/i);
  assert.match(buildColumnTooltip({ key: 'customField', label: 'Custom Field' }), /recorded or calculated/i);

  const tableSource = read('./modules/reporting/tables/ReportTable.js');
  assert.match(tableSource, /renderColumnTooltipIcon\(column\)/);
});

test('Phase 46 splits product wastage from stock-item wastage and counts finished menu items once', () => {
  const normalized = __wastageReportInternals.buildWastageRows([
    ...productWastageRows(),
    stockItemWastageRow(),
  ]);
  const productLines = normalized.filter((row) => row.wastageSource === 'Product Wastage');
  const stockLines = normalized.filter((row) => row.wastageSource === 'Stock Item Wastage');
  assert.equal(productLines.length, 2);
  assert.equal(stockLines.length, 1);
  assert.deepEqual(productLines.map((row) => row.qtyWasted), [0.6, 0.45]);

  const menuRows = buildMenuItemWastageRows(normalized);
  assert.equal(menuRows.length, 1);
  assert.equal(menuRows[0].menuItemName, 'Classic Burger');
  assert.equal(menuRows[0].qtyMenuItemsWasted, 3);
  assert.equal(menuRows[0].eventCount, 1);
  assert.equal(menuRows[0].ingredientLineCount, 2);
  assert.equal(menuRows[0].wastageValue, 10.5);
});

test('Phase 46 adds source and menu-item views to Adjustments without double-counting product quantities', () => {
  const adjustmentRows = __adjustmentsReportInternals.buildAdjustmentRows([
    ...productWastageRows(),
    stockItemWastageRow(),
  ]);
  const model = __adjustmentsReportInternals.buildAdjustmentModel(adjustmentRows, adjustmentRows);

  assert.ok(model.views.by_source);
  assert.ok(model.views.menu_items);
  assert.equal(model.views.menu_items.length, 1);
  assert.equal(model.views.menu_items[0].qtyMenuItemsWasted, 3);

  const productSource = model.views.by_source.find((row) => row.adjustmentSource === 'Product Wastage');
  const stockSource = model.views.by_source.find((row) => row.adjustmentSource === 'Stock Item Wastage');
  assert.equal(productSource.menuItemsWasted, 3);
  assert.equal(productSource.eventCount, 1);
  assert.equal(stockSource.menuItemsWasted, 0);
});

test('Phase 46 keeps manufactured low-stock rows visible but excludes them from purchase-order selection', () => {
  const rows = [
    {
      id: 'raw-1',
      itemId: 'raw-1',
      itemName: 'Flour',
      itemType: 'raw',
      locationId: 'main',
      locationName: 'Main Store',
      currentStock: 100,
      parLevel: 10,
      requiredQty: 0,
      status: 'Healthy',
      baseUom: 'kg',
    },
    {
      id: 'made-1',
      itemId: 'made-1',
      itemName: 'Pizza Dough',
      itemType: 'manufactured',
      locationId: 'main',
      locationName: 'Main Store',
      currentStock: 0,
      parLevel: 10,
      requiredQty: 10,
      status: 'Critical',
      baseUom: 'kg',
    },
  ];
  const views = buildStockControlViews({ rows, warningRows: [] });
  assert.equal(views.item_detail.length, 2);
  assert.equal(views.reorder_detail.some((row) => row.itemId === 'made-1'), true);
  assert.equal(isManufacturedStockControlRow(rows[1]), true);
  assert.equal(isOrderableStockControlRow(rows[1]), false);

  const orderable = __reportViewerInternals.getBulkOrderRows(views.item_detail);
  assert.deepEqual(orderable.map((row) => row.itemId), ['raw-1']);
  const payload = __reportViewerInternals.buildLowStockOrderPayload(orderable[0]);
  assert.equal(payload.purchaseUomQty, 1);
  assert.equal(payload.supplierId, '');
  assert.equal(payload.supplierName, '');
});

test('Phase 46 removes supplier grouping, Top Supplier and supplier requirements from Stock Control', () => {
  assert.equal(stockControlReport.availableViews.includes('supplier_reorder'), false);
  assert.equal(stockControlReport.filterConfig.default.includes('supplier'), false);
  assert.equal(stockControlReport.filterConfig.default.includes('missingSupplier'), false);
  assert.equal(stockControlReport.columns.location_summary.some((column) => column.key === 'topSupplier'), false);
  assert.equal(stockControlReport.columns.item_detail.some((column) => column.key === 'supplierName'), false);

  const views = buildStockControlViews({
    rows: [],
    warningRows: [
      { issueType: 'Missing supplier', issue: 'No supplier was inferred.' },
      { issueType: 'Missing cost', issue: 'No unit cost exists.' },
    ],
  });
  assert.equal(views.warnings.length, 1);
  assert.equal(views.warnings[0].issueType, 'Missing cost');
});

test('Phase 46 removes the metadata grid and global critical data-quality banner from every report', () => {
  const drawerSource = read('./modules/reporting/transactions/TransactionDetailDrawer.js');
  const bannerSource = read('./modules/reporting/tables/ReportWarningBanner.js');
  assert.doesNotMatch(drawerSource, /transactionDetailMetadata/);
  assert.doesNotMatch(drawerSource, /renderMetadata/);
  assert.match(bannerSource, /createDocumentFragment/);
  assert.doesNotMatch(bannerSource, /Critical Data Quality Issues/);
});

test('Phase 46 purchase-order seed uses an editable supplier and a minimum selected quantity of one', () => {
  const mainSource = read('./main.js');
  assert.match(mainSource, /suggestedQty = cleanQty \|\| Math\.max\([^;]+\) \|\| 1/);
  assert.match(mainSource, /supplierId: seed\.supplierId \|\| ''/);
  assert.doesNotMatch(mainSource, /supplierId: seed\.supplierId \|\| stockItem\.supplierId/);
});
