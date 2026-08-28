import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTransferRows, validateTransferRows, stockTransfersReport } from './stockTransfersReport.js';

function transferOut(overrides = {}) {
  return {
    id: 'movement-out-1',
    source: 'Transfer Out',
    movementType: 'Transfer Out',
    sourceId: 'external-transfer-1',
    documentNumber: 'EXT-0001',
    date: '2026-07-12',
    timestamp: '2026-07-12T12:30:00.000Z',
    locationId: 'loc-source',
    locationName: 'Main Kitchen',
    itemId: 'item-bun',
    itemName: 'Burger Bun',
    category: 'Bakery',
    qtyIn: 0,
    qtyOut: 10,
    netQty: -10,
    baseUom: 'ea',
    unitCostExVat: 2,
    movementValue: -20,
    transferType: 'external',
    transferScope: 'external',
    fromSiteId: 'workspace-source',
    fromSiteName: 'Central Kitchen',
    fromLocationId: 'loc-source',
    fromLocationName: 'Main Kitchen',
    toSiteId: 'workspace-destination',
    toSiteName: 'Waterfront Branch',
    toLocationId: 'loc-destination',
    toLocationName: 'Receiving Store',
    status: 'accepted',
    requestedAt: '2026-07-12T12:00:00.000Z',
    acceptedAt: '2026-07-12T12:35:00.000Z',
    shippedQty: 10,
    receivedQty: 8,
    returnedQty: 2,
    createdBy: 'Sender User',
    committedBy: 'Receiver User',
    ...overrides
  };
}

test('Phase 35.1 accepted external transfer shows the destination site and location without requiring a local Transfer In row', () => {
  const rows = buildTransferRows([transferOut()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transferTypeLabel, 'External');
  assert.equal(rows[0].toSiteName, 'Waterfront Branch');
  assert.equal(rows[0].toLocationName, 'Receiving Store');
  assert.equal(rows[0].toLocationDisplay, 'Waterfront Branch · Receiving Store');
  assert.equal(rows[0].shippedQty, 10);
  assert.equal(rows[0].receivedQty, 8);
  assert.equal(rows[0].returnedQty, 2);

  const warnings = validateTransferRows({ transferRows: rows, pairRows: rows, ledgerRows: [transferOut()] });
  assert.equal(warnings.some((warning) => warning.code === 'stock-transfer-missing-destination-location'), false);
  assert.equal(warnings.some((warning) => warning.code === 'stock-transfer-out-without-in'), false);
  assert.equal(warnings.some((warning) => warning.code === 'reconcile-transfer-out-without-in'), false);
});

test('Phase 35.1 destination warning is attached only to the genuinely incomplete transfer line', () => {
  const complete = transferOut();
  const incomplete = transferOut({
    id: 'movement-out-2',
    itemId: 'item-bun-2',
    itemName: 'Burger Bun',
    toSiteId: '',
    toSiteName: '',
    toLocationId: '',
    toLocationName: ''
  });
  const rows = buildTransferRows([complete, incomplete]);
  const warnings = validateTransferRows({ transferRows: rows, pairRows: rows, ledgerRows: [complete, incomplete] })
    .filter((warning) => warning.code === 'stock-transfer-missing-destination-location');

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].rowId, 'movement-out-2');
  assert.equal(warnings[0].itemName, 'Burger Bun');
  assert.equal(warnings[0].message, 'Burger Bun — Destination location missing');
  assert.equal(warnings[0].isItemSpecific, true);
});

test('Phase 35.1 valid destination IDs suppress the warning even when historical names are unavailable', () => {
  const row = transferOut({ toSiteName: '', toLocationName: '' });
  const rows = buildTransferRows([row]);
  const warnings = validateTransferRows({ transferRows: rows, pairRows: rows, ledgerRows: [row] });
  assert.equal(warnings.some((warning) => warning.code === 'stock-transfer-missing-destination-location'), false);
});

test('Phase 35.1 stock transfer views expose route, lifecycle and quantity fields', () => {
  const summaryKeys = stockTransfersReport.columns.summary.map((column) => column.key);
  const detailKeys = stockTransfersReport.columns.line_detail.map((column) => column.key);
  for (const key of ['transferTypeLabel', 'fromSiteName', 'fromLocationName', 'toSiteName', 'toLocationDisplay', 'status', 'shippedQty', 'receivedQty', 'returnedQty']) {
    assert.equal(summaryKeys.includes(key), true, `summary is missing ${key}`);
    assert.equal(detailKeys.includes(key), true, `line detail is missing ${key}`);
  }
});

test('Phase 35.1 transfer submission and Worker reporting retain canonical destination names', async () => {
  const [mainSource, serviceSource, routeSource, reportingSource] = await Promise.all([
    readFile(new URL('../../../../main.js', import.meta.url), 'utf8'),
    readFile(new URL('../../../../services/orgTransferService.js', import.meta.url), 'utf8'),
    readFile(new URL('../../../../../cloudflare-v2/src/legacy/routes.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../../../cloudflare-v2/src/legacy/reporting-routes.ts', import.meta.url), 'utf8')
  ]);

  for (const field of ['from_site_name', 'to_site_name', 'from_location_name', 'to_location_name']) {
    assert.match(mainSource, new RegExp(field));
    assert.match(serviceSource, new RegExp(field));
  }
  for (const field of ['fromSiteName', 'toSiteName', 'fromLocationName', 'toLocationName', 'shippedQty', 'receivedQty', 'returnedQty']) {
    assert.match(routeSource, new RegExp(field));
    assert.match(reportingSource, new RegExp(field));
  }
  assert.match(reportingSource, /enrichExternalTransferReportRows/);
});

test('Phase 35.1 preserves pending, accepted, rejected and cancelled external lifecycle states', () => {
  const scenarios = [
    { status: 'pending_receipt', receivedQty: 0, returnedQty: 0 },
    { status: 'accepted', receivedQty: 10, returnedQty: 0 },
    { status: 'accepted', receivedQty: 6, returnedQty: 4 },
    { status: 'rejected', receivedQty: 0, returnedQty: 10 },
    { status: 'cancelled', receivedQty: 0, returnedQty: 10 }
  ];

  for (const scenario of scenarios) {
    const rows = buildTransferRows([transferOut(scenario)]);
    assert.equal(rows[0].status, scenario.status);
    assert.equal(rows[0].receivedQty, scenario.receivedQty);
    assert.equal(rows[0].returnedQty, scenario.returnedQty);
    const warnings = validateTransferRows({ transferRows: rows, pairRows: rows, ledgerRows: rows }).flat(Infinity).filter(Boolean);
    assert.equal(warnings.some((warning) => String(warning.code || '').includes('without-in')), false);
    assert.equal(warnings.some((warning) => warning.code === 'stock-transfer-missing-destination-location'), false);
  }
});

test('Phase 35.1 keeps internal transfer pairing validation unchanged', () => {
  const outbound = transferOut({
    transferType: 'internal',
    transferScope: 'internal',
    fromSiteId: 'workspace-source',
    fromSiteName: 'Central Kitchen',
    toSiteId: 'workspace-source',
    toSiteName: 'Central Kitchen',
    receivedQty: 10,
    returnedQty: 0
  });
  const inbound = {
    ...outbound,
    id: 'movement-in-1',
    source: 'Transfer In',
    movementType: 'Transfer In',
    locationId: 'loc-destination',
    locationName: 'Receiving Store',
    qtyIn: 10,
    qtyOut: 0,
    netQty: 10,
    movementValue: 20
  };
  const rows = buildTransferRows([outbound, inbound]);
  const warnings = validateTransferRows({ transferRows: rows, pairRows: rows, ledgerRows: [outbound, inbound] }).flat(Infinity).filter(Boolean);
  assert.equal(warnings.some((warning) => String(warning.code || '').includes('without-')), false);
});

test('an internal transfer leg orphaned for a while still raises a critical warning', () => {
  // Internal transfers write both legs atomically in the same database batch, so a genuinely
  // stale orphaned leg (here dated 2026-07-12, long before "now") reflects real data corruption
  // and must still escalate loudly, not be swept under the recent-write grace period.
  const outbound = transferOut({
    id: 'movement-out-3',
    sourceId: 'internal-transfer-stale',
    documentNumber: 'INT-STALE',
    transferType: 'internal',
    transferScope: 'internal',
    fromSiteId: 'workspace-source',
    fromSiteName: 'Central Kitchen',
    toSiteId: 'workspace-source',
    toSiteName: 'Central Kitchen'
  });
  const rows = buildTransferRows([outbound]);
  const warnings = validateTransferRows({ transferRows: rows, pairRows: rows, ledgerRows: [outbound] }).flat(Infinity).filter(Boolean);
  const orphanWarning = warnings.find((warning) => warning.code === 'stock-transfer-out-without-in');
  assert.ok(orphanWarning, 'a stale orphaned internal leg must still be flagged');
  assert.equal(orphanWarning.level, 'critical');
});

test('an internal transfer leg orphaned moments ago is downgraded to a warning instead of a critical alert', () => {
  // Regression guard: this used to unconditionally raise a critical alert for ANY orphaned
  // internal leg. A leg written moments ago with no visible match yet could reflect the report's
  // read path racing the write (a paginated ledger fetch not yet including the sibling row)
  // rather than genuine corruption — only this narrow, recent window should be a warning.
  const now = new Date();
  const outbound = transferOut({
    id: 'movement-out-4',
    sourceId: 'internal-transfer-fresh',
    documentNumber: 'INT-FRESH',
    date: now.toISOString().slice(0, 10),
    timestamp: now.toISOString(),
    transferType: 'internal',
    transferScope: 'internal',
    fromSiteId: 'workspace-source',
    fromSiteName: 'Central Kitchen',
    toSiteId: 'workspace-source',
    toSiteName: 'Central Kitchen'
  });
  const rows = buildTransferRows([outbound]);
  const warnings = validateTransferRows({ transferRows: rows, pairRows: rows, ledgerRows: [outbound] }).flat(Infinity).filter(Boolean);
  const orphanWarning = warnings.find((warning) => warning.code === 'stock-transfer-out-without-in');
  assert.ok(orphanWarning, 'a recently orphaned internal leg should still be surfaced');
  assert.equal(orphanWarning.level, 'warning', 'a moments-old orphan must not be a critical alert');
  assert.equal(warnings.some((warning) => String(warning.code || '').includes('mismatch')), false);
});
