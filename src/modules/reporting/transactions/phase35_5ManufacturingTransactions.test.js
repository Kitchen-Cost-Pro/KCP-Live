import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manufacturingTransactionsReport } from "../reports/operations/manufacturingTransactionsReport.js";
import { getReportDefinition } from "../reports/index.js";
import { getReportDataSource } from "../api/reportDataSourceCatalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const sourceRows = [
  {
    id: "mfg:b1:l1",
    manufacturingBatchId: "b1",
    transactionReference: "MFG-260712-0001",
    postedAt: "2026-07-12T08:00:00.000Z",
    manufacturedItemId: "finished-1",
    manufacturedItemName: "Tomato Sauce",
    category: "Prep",
    locationId: "loc-1",
    locationName: "Main Kitchen",
    plannedYield: 10,
    actualYield: 8,
    yieldVariance: -2,
    yieldVariancePercent: -20,
    yieldUom: "L",
    ingredientCount: 2,
    ingredientItemId: "tomato",
    ingredientItemName: "Tomatoes",
    ingredientCategory: "Produce",
    ingredientQty: 5,
    ingredientUom: "kg",
    ingredientUnitCost: 12,
    ingredientCost: 60,
    ingredientCostTotal: 80,
    outputUnitCost: 10,
    outputValue: 80,
    wastageQty: 2,
    wastageValue: 16,
    status: "Committed",
    committedBy: "Chef",
    ledgerReconciled: true,
  },
  {
    id: "mfg:b1:l2",
    manufacturingBatchId: "b1",
    transactionReference: "MFG-260712-0001",
    postedAt: "2026-07-12T08:00:00.000Z",
    manufacturedItemId: "finished-1",
    manufacturedItemName: "Tomato Sauce",
    category: "Prep",
    locationId: "loc-1",
    locationName: "Main Kitchen",
    plannedYield: 10,
    actualYield: 8,
    yieldVariance: -2,
    yieldVariancePercent: -20,
    yieldUom: "L",
    ingredientCount: 2,
    ingredientItemId: "spice",
    ingredientItemName: "Spice Mix",
    ingredientCategory: "Dry Goods",
    ingredientQty: 1,
    ingredientUom: "kg",
    ingredientUnitCost: 20,
    ingredientCost: 20,
    ingredientCostTotal: 80,
    outputUnitCost: 10,
    outputValue: 80,
    wastageQty: 2,
    wastageValue: 16,
    status: "Committed",
    committedBy: "Chef",
    ledgerReconciled: true,
  },
];

const services = {
  reporting: {
    getManufacturingTransactionRows: async () => ({
      rows: sourceRows,
      warnings: [],
      meta: { manufacturingReconciled: true },
    }),
  },
};

test("Phase 35.5 registers the Manufacturing report with all approved views", () => {
  const report = getReportDefinition("manufacturing_transactions");
  assert.ok(report);
  assert.equal(report.defaultView, "batches");
  assert.deepEqual(report.availableViews, [
    "batches",
    "by_manufactured_item",
    "by_location",
    "ingredient_usage",
    "wastage",
    "line_detail",
  ]);
  assert.equal(report.columns.batches[0].type, "transaction_id");
});

test("Phase 35.5 batch summaries do not double count repeated batch totals", async () => {
  const batches = await manufacturingTransactionsReport.getRows({
    workspaceId: "ws",
    filters: {},
    services,
    view: "batches",
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].ingredientCostTotal, 80);
  assert.equal(batches[0].outputValue, 80);
  assert.equal(batches[0].wastageQty, 2);

  const byItem = await manufacturingTransactionsReport.getRows({
    workspaceId: "ws",
    filters: {},
    services,
    view: "by_manufactured_item",
  });
  assert.equal(byItem.length, 1);
  assert.equal(byItem[0].ingredientCost, 80);
  assert.equal(byItem[0].outputValue, 80);
  assert.equal(byItem[0].wastageValue, 16);
});

test("Phase 35.5 ingredient usage aggregates line quantities and costs", async () => {
  const rows = await manufacturingTransactionsReport.getRows({
    workspaceId: "ws",
    filters: {},
    services,
    view: "ingredient_usage",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.ingredientCost, 0), 80);
});

test("Phase 35.5 wastage is labelled accounting-only rather than deducted twice", async () => {
  const rows = await manufacturingTransactionsReport.getRows({
    workspaceId: "ws",
    filters: {},
    services,
    view: "wastage",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountingTreatment, "Accounting-only yield loss");
  assert.equal(rows[0].wastagePercent, 20);
});

test("Phase 35.5 wires the real D1 endpoint, source catalog, scheduling, and detail reconciliation", () => {
  const source = getReportDataSource("manufacturing_transactions");
  assert.deepEqual(source.endpoints, [
    "reports/manufacturing-transactions",
    "reports/transactions/:transactionReference",
  ]);
  assert.ok(source.tables.includes("manufacturing_batch_lines"));

  const indexSource = read("cloudflare-v2/src/legacy/index.ts");
  const reportRoute = read("cloudflare-v2/src/legacy/reporting-phase21-routes.ts");
  const scheduling = read("cloudflare-v2/src/legacy/report-scheduling-routes.ts");
  const detail = read("cloudflare-v2/src/legacy/transaction-detail-routes.ts");

  assert.match(indexSource, /reports\/manufacturing-transactions/);
  assert.match(reportRoute, /manufacturing_batches \+ manufacturing_batch_lines/);
  assert.match(reportRoute, /accounting-only and is not deducted twice/);
  assert.match(scheduling, /manufacturing_transactions/);
  assert.match(scheduling, /getManufacturingTransactionRows/);
  assert.match(detail, /manufacturing_component_out/);
  assert.match(detail, /wastageAccountingPolicy/);
  assert.match(detail, /component usage is not deducted twice/);
});
