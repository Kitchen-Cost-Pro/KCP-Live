import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stockTransfersReport } from "../reports/operations/stockTransfersReport.js";
import { stockTakeAuditReport } from "../reports/operations/stockTakeAuditReport.js";
import { getReportDataSource } from "../api/reportDataSourceCatalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const transferTransactionRows = [
  {
    id: "transaction-transfer-1",
    sourceId: "transfer-1",
    transactionReference: "TRF-260712-0001",
    timestamp: "2026-07-12T09:00:00.000Z",
    requestedAt: "2026-07-12T08:00:00.000Z",
    acceptedAt: "2026-07-12T09:00:00.000Z",
    locationId: "loc-source",
    locationName: "Main Kitchen",
    itemId: "item-bun",
    itemName: "Burger Bun",
    category: "Bakery",
    source: "Transfer Out",
    movementType: "Transfer Out",
    qtyOut: 10,
    netQty: -10,
    shippedQty: 10,
    receivedQty: 8,
    returnedQty: 2,
    qtyTransferred: 10,
    baseUom: "ea",
    unitCostExVat: 2.5,
    transferValue: 25,
    movementValue: -25,
    transferType: "external",
    transferScope: "external",
    fromSiteId: "ws-source",
    fromSiteName: "Kitchen A",
    fromLocationId: "loc-source",
    fromLocationName: "Main Kitchen",
    toSiteId: "ws-destination",
    toSiteName: "Kitchen B",
    toLocationId: "loc-destination",
    toLocationName: "Storage",
    status: "Partially Accepted",
    createdBy: "Sender User",
    committedBy: "Receiver User",
  },
];

const transferServices = {
  reporting: {
    getStockTransferTransactionRows: async () => ({
      rows: transferTransactionRows,
      warnings: [],
      meta: { dataSource: "real", timeZone: "Africa/Johannesburg" },
    }),
    getDetailedActivityLedger: async () => ({
      rows: [
        {
          id: "move-out-1",
          timestamp: "2026-07-12T08:00:00.000Z",
          locationId: "loc-source",
          locationName: "Main Kitchen",
          itemId: "item-bun",
          itemName: "Burger Bun",
          category: "Bakery",
          source: "Transfer Out",
          movementType: "Transfer Out",
          sourceId: "transfer-1",
          transactionReference: "TRF-260712-0001",
          qtyOut: 10,
          netQty: -10,
          baseUom: "ea",
          unitCostExVat: 2.5,
          movementValue: -25,
          transferType: "external",
          transferScope: "external",
          fromSiteId: "ws-source",
          fromSiteName: "Kitchen A",
          fromLocationId: "loc-source",
          fromLocationName: "Main Kitchen",
          toSiteId: "ws-destination",
          toSiteName: "Kitchen B",
          toLocationId: "loc-destination",
          toLocationName: "Storage",
          requestedAt: "2026-07-12T08:00:00.000Z",
          acceptedAt: "2026-07-12T09:00:00.000Z",
          shippedQty: 10,
          receivedQty: 8,
          returnedQty: 2,
          status: "accepted",
          createdBy: "Sender User",
          committedBy: "Receiver User",
        },
      ],
      warnings: [],
      meta: { dataSource: "real", timeZone: "Africa/Johannesburg" },
    }),
  },
};

const stockTakeServices = {
  reporting: {
    getStockTakeAuditRows: async () => ({
      rows: [
        {
          id: "count-1",
          sourceId: "stocktake-1",
          stockTakeSessionId: "stocktake-1",
          transactionReference: "STK-260712-0001",
          stockTakeDate: "2026-07-12",
          countedAt: "2026-07-12T10:00:00.000Z",
          committedAt: "2026-07-12T10:05:00.000Z",
          locationId: "loc-1",
          locationName: "Main Kitchen",
          status: "committed",
          itemId: "item-a",
          itemName: "Flour",
          category: "Dry Goods",
          countedUom: "Bag",
          enteredQty: 6,
          uomBreakdown: "6 Bag × 2",
          baseUom: "kg",
          countedQty: 12,
          convertedBaseQty: 12,
          expectedQty: 10,
          expectedBaseQty: 10,
          varianceQty: 2,
          unitCostExVat: 5,
          committedBy: "Stock Controller",
        },
        {
          id: "count-2",
          sourceId: "stocktake-1",
          stockTakeSessionId: "stocktake-1",
          transactionReference: "STK-260712-0001",
          stockTakeDate: "2026-07-12",
          countedAt: "2026-07-12T10:00:00.000Z",
          committedAt: "2026-07-12T10:05:00.000Z",
          locationId: "loc-1",
          locationName: "Main Kitchen",
          status: "committed",
          itemId: "item-b",
          itemName: "Oil",
          category: "Dry Goods",
          countedUom: "Bottle",
          baseUom: "L",
          countedQty: 4,
          convertedBaseQty: 4,
          expectedQty: 5,
          expectedBaseQty: 5,
          varianceQty: -1,
          unitCostExVat: 20,
          committedBy: "Stock Controller",
        },
      ],
      warnings: [],
      meta: { dataSource: "real" },
    }),
    getDetailedActivityLedger: async () => ({
      rows: [
        {
          id: "variance-1",
          timestamp: "2026-07-12T10:05:00.000Z",
          source: "Stock Take Variance",
          movementType: "Stock Take Variance",
          sourceId: "stocktake-1",
          transactionReference: "STK-260712-0001",
          locationId: "loc-1",
          locationName: "Main Kitchen",
          itemId: "item-a",
          itemName: "Flour",
          qtyIn: 2,
          netQty: 2,
          unitCostExVat: 5,
          movementValue: 10,
        },
        {
          id: "variance-2",
          timestamp: "2026-07-12T10:05:00.000Z",
          source: "Stock Take Variance",
          movementType: "Stock Take Variance",
          sourceId: "stocktake-1",
          transactionReference: "STK-260712-0001",
          locationId: "loc-1",
          locationName: "Main Kitchen",
          itemId: "item-b",
          itemName: "Oil",
          qtyOut: 1,
          netQty: -1,
          unitCostExVat: 20,
          movementValue: -20,
        },
      ],
      warnings: [],
      meta: { dataSource: "real" },
    }),
  },
};

test("Phase 35.6 transfer summary exposes lifecycle, destination, and partial acceptance totals", async () => {
  const rows = await stockTransfersReport.getRows({
    workspaceId: "ws-source",
    filters: {},
    services: transferServices,
    view: "summary",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transactionReference, "TRF-260712-0001");
  assert.equal(rows[0].transferTypeLabel, "External");
  assert.equal(rows[0].toSiteName, "Kitchen B");
  assert.equal(rows[0].toLocationDisplay, "Kitchen B · Storage");
  assert.equal(rows[0].shippedQty, 10);
  assert.equal(rows[0].receivedQty, 8);
  assert.equal(rows[0].returnedQty, 2);
  assert.equal(rows[0].totalTransferValue, 25);
  assert.equal(rows[0].requestedAt, "2026-07-12T08:00:00.000Z");
  assert.equal(rows[0].acceptedAt, "2026-07-12T09:00:00.000Z");
});

test("Phase 35.6 transfer summary includes pending and rejected transfers without ledger movements", async () => {
  const services = {
    reporting: {
      getStockTransferTransactionRows: async () => ({
        rows: [
          { ...transferTransactionRows[0], id: "pending-line", sourceId: "transfer-pending", transactionReference: "TRF-260712-0002", status: "Pending Receipt", acceptedAt: "", receivedQty: 0, returnedQty: 0 },
          { ...transferTransactionRows[0], id: "rejected-line", sourceId: "transfer-rejected", transactionReference: "TRF-260712-0003", status: "Rejected", receivedQty: 0, returnedQty: 10 },
        ],
        warnings: [],
        meta: { dataSource: "real" },
      }),
      getDetailedActivityLedger: async () => ({ rows: [], warnings: [], meta: { dataSource: "real" } }),
    },
  };
  const rows = await stockTransfersReport.getRows({
    workspaceId: "ws-source",
    filters: {},
    services,
    view: "summary",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.transactionReference === "TRF-260712-0002").status, "Pending Receipt");
  assert.equal(rows.find((row) => row.transactionReference === "TRF-260712-0003").returnedQty, 10);
});

test("Phase 35.6 stock take sessions aggregate one row per session with variance totals", async () => {
  const rows = await stockTakeAuditReport.getRows({
    workspaceId: "ws",
    filters: {},
    services: stockTakeServices,
    view: "sessions",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transactionReference, "STK-260712-0001");
  assert.equal(rows[0].stockTakeDateTime, "2026-07-12T10:00:00.000Z");
  assert.equal(rows[0].itemsCounted, 2);
  assert.equal(rows[0].itemsWithVariance, 2);
  assert.equal(rows[0].totalVarianceQty, 1);
  assert.equal(rows[0].totalExpectedValue, 150);
  assert.equal(rows[0].totalCountedValue, 140);
  assert.equal(rows[0].varianceValue, -10);
});

test("Phase 35.6 stock take count detail retains UOM conversion and financial variance fields", async () => {
  const rows = await stockTakeAuditReport.getRows({
    workspaceId: "ws",
    filters: {},
    services: stockTakeServices,
    view: "count_detail",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].countedUom, "Bag");
  assert.equal(rows[0].enteredQty, 6);
  assert.equal(rows[0].uomBreakdown, "6 Bag × 2");
  assert.equal(rows[0].convertedBaseQty, 12);
  assert.equal(rows[0].expectedValue, 50);
  assert.equal(rows[0].countedValue, 60);
  assert.equal(rows[0].varianceValue, 10);
  assert.equal(rows[1].varianceValue, -20);
});

test("Phase 35.6 source catalog includes transfer detail and stock take transaction sources", () => {
  const transferSource = getReportDataSource("stock_transfers");
  assert.ok(transferSource.endpoints.includes("reports/transactions/:transactionReference"));
  assert.ok(transferSource.endpoints.includes("reports/stock-transfer-transactions"));
  assert.ok(transferSource.tables.includes("transfer_lines"));
  assert.ok(transferSource.tables.includes("external_transfers"));
  assert.ok(transferSource.sourceIds.includes("transactionReference"));

  const stockTakeSource = getReportDataSource("stock_take_audit");
  assert.ok(stockTakeSource.endpoints.includes("reports/transactions/:transactionReference"));
  assert.ok(stockTakeSource.sourceIds.includes("transactionReference"));
});

test("Phase 35.6 detail route supports receiver fallback, item mapping, UOM breakdown, and variance-not-wastage policy", () => {
  const detail = read("cloudflare-v2/src/legacy/transaction-detail-routes.ts");
  const drawer = read("src/modules/reporting/transactions/TransactionDetailDrawer.js");
  const styles = read("src/styles/reporting.css");

  const reportingRoute = read("cloudflare-v2/src/legacy/reporting-phase21-routes.ts");
  assert.match(detail, /FROM external_transfers/);
  assert.match(reportingRoute, /getStockTransferTransactionsReport/);
  assert.match(reportingRoute, /includesPendingAndRejected/);
  assert.match(detail, /workspaceRole/);
  assert.match(detail, /sourceStockItemId/);
  assert.match(detail, /destinationStockItemId/);
  assert.match(detail, /ledgerReturnedQuantity/);
  assert.match(detail, /normaliseStockTakeUomBreakdown/);
  assert.match(detail, /varianceDirection/);
  assert.match(detail, /Stock take variance is inventory variance, not wastage/);
  assert.match(detail, /ledgerVarianceQuantity/);
  assert.match(drawer, /is-positive-variance/);
  assert.match(drawer, /is-negative-variance/);
  assert.match(styles, /transactionDetailTable tbody tr\.is-positive-variance/);
  assert.match(styles, /transactionDetailTable tbody tr\.is-negative-variance/);
});
