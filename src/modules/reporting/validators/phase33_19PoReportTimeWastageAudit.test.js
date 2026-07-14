import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getFirstReportView } from '../ReportViewer.js';
import { normalizeApiLedgerRow } from '../api/reportingMappers.js';
import { runReport } from '../engine/reportRunner.js';
import { formatReportTime, resolveReportTimestamp } from '../engine/timezone.js';
import { isWastageRow } from '../reports/advanced/advancedReportHelpers.js';

const source = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');

test('Phase 33.19 purchase-order UOM and location menus escape the modal scroll container', () => {
  const component = source('src/components/PurchaseOrders.js');
  const css = source('src/styles/purchaseOrders.css');

  assert.match(component, /schedulePurchaseOrderLineDropdownPositioning\(view\)/);
  assert.match(component, /getBoundingClientRect\(\)/);
  assert.match(component, /window\.innerHeight/);
  assert.match(css, /purchaseOrdersModule__lineUom[\s\S]*purchaseOrdersModule__dropdownMenu[\s\S]*position:\s*fixed/);
  assert.match(css, /z-index:\s*1400/);
});

test('Phase 33.19 reporting navigation opens the directory and reports choose their first registered view', () => {
  const main = source('src/main.js');
  const dashboard = source('src/modules/reporting/ReportingDashboard.js');

  assert.match(main, /nextSection === 'reporting'\) clearReportingNavigationParameters\(\)/);
  assert.match(dashboard, /if \(!initialRoute\) clearReportingRouteState\(\)/);
  assert.equal(getFirstReportView({ availableViews: ['overview', 'detail'], defaultView: 'detail' }), 'overview');
  assert.equal(getFirstReportView({ availableViews: [], defaultView: 'summary' }), 'summary');
});

test('Phase 33.20 report Actions menu uses the browser top layer with a body-portal fallback', () => {
  const viewer = source('src/modules/reporting/ReportViewer.js');
  const header = source('src/modules/reporting/tables/ReportHeader.js');
  const actionMenu = source('src/modules/reporting/ui/reportActionMenu.js');
  const css = source('src/styles/reporting.css');

  assert.match(viewer, /installReportActionMenu\(root\)/);
  assert.match(header, /popover=\"manual\"/);
  assert.match(actionMenu, /panel\.showPopover\(\)/);
  assert.match(actionMenu, /document\.body\.append\(panel\)/);
  assert.match(actionMenu, /setImportantStyle\(panel, 'z-index', '2147483646'\)/);
  assert.match(actionMenu, /window\.innerWidth/);
  assert.match(css, /\.reportActionMenu__panel:popover-open/);
  assert.match(css, /\.reportActionMenu__panel--portal/);
  assert.match(css, /overflow-y:\s*auto/);
});

test('Phase 33.19 repairs artificial midnight report times in Africa Johannesburg', () => {
  const timestamp = resolveReportTimestamp(
    '2026-07-11T00:00:00Z',
    '2026-07-11T13:42:00Z',
    'Africa/Johannesburg'
  );
  assert.equal(timestamp, '2026-07-11T13:42:00Z');
  assert.equal(formatReportTime(timestamp, 'Africa/Johannesburg'), '15:42');

  const row = normalizeApiLedgerRow({
    id: 'midnight-row',
    movementDate: '2026-07-11',
    createdAt: '2026-07-11T13:42:00Z',
    movementType: 'Manual Adjustment',
    sourceType: 'Manual Adjustment',
    qtyIn: 1,
    qtyOut: 0,
    unitCostExVat: 10
  }, 0, { timeZone: 'Africa/Johannesburg', dataSource: 'real' });
  assert.equal(row.movementDate, '2026-07-11');
  assert.equal(row.movementTime, '15:42:00');
});

test('Phase 33.19 reports accounting-only manufacturing wastage quantity and excludes stock-take variance', async () => {
  const rows = [
    {
      id: 'manufacturing-waste-5',
      workspaceId: 'WS-audit',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'prep-item',
      itemName: 'Prepared Product',
      categoryName: 'Prep',
      movementDate: '2026-07-11',
      movementTime: '14:30:00',
      movementType: 'Manufacturing Wastage',
      sourceType: 'Manufacturing Wastage',
      sourceId: 'batch-10',
      documentNumber: 'BATCH-10',
      qtyIn: 0,
      qtyOut: 0,
      netQty: 0,
      baseUom: 'ea',
      unitCostExVat: 20,
      movementValue: -100,
      wastageQty: 5,
      accountingOnly: true,
      metadata: { wastageQty: 5, accountingOnly: true }
    },
    {
      id: 'stocktake-loss-5',
      workspaceId: 'WS-audit',
      locationId: 'loc-main',
      locationName: 'Main Kitchen',
      itemId: 'prep-item',
      itemName: 'Prepared Product',
      categoryName: 'Prep',
      movementDate: '2026-07-11',
      movementTime: '15:00:00',
      movementType: 'Stock Take Variance',
      sourceType: 'Stock Take Variance',
      sourceId: 'stocktake-10',
      qtyIn: 0,
      qtyOut: 5,
      netQty: -5,
      baseUom: 'ea',
      unitCostExVat: 20,
      movementValue: -100
    }
  ];
  const services = {
    reporting: {
      getDetailedActivityLedger: async () => ({
        rows,
        warnings: [],
        meta: { workspaceId: 'WS-audit', dataSource: 'real', timeZone: 'Africa/Johannesburg' }
      })
    }
  };

  const result = await runReport('wastage', {
    workspaceId: 'WS-audit',
    services,
    filters: { view: 'line_detail' }
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].wastageSource, 'Manufacturing Wastage');
  assert.equal(result.rows[0].qtyWasted, 5);
  assert.equal(result.rows[0].wastageValue, 100);
  assert.equal(isWastageRow(rows[0]), true);
  assert.equal(isWastageRow(rows[1]), false);
});
