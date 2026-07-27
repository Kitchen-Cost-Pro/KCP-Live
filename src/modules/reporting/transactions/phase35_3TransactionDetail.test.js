import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getTransactionDetailDefinition } from "./transactionDetailRegistry.js";
import {
  transactionDetailFileStem,
  transactionDetailSummaryRows,
} from "./transactionDetailUtils.js";
import { transactionDetailToReport } from "./transactionDetailExports.js";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Phase 35.3 registry covers all transaction families", () => {
  assert.equal(getTransactionDetailDefinition("grv").label, "GRV");
  assert.equal(getTransactionDetailDefinition("credit_note").label, "Credit Note");
  assert.equal(getTransactionDetailDefinition("manufacturing_batch").label, "Manufacturing");
  assert.equal(getTransactionDetailDefinition("transfer").label, "Transfer");
  assert.equal(getTransactionDetailDefinition("stock_take").label, "Stock Take");
});

test("Phase 35.3 transaction export model contains only the selected transaction lines", () => {
  const detail = {
    entityType: "stock_take",
    transactionReference: "STK-260712-0015",
    status: "posted",
    locationNames: ["Main Store"],
    summaryCards: [{ key: "variance", label: "Variance", value: 12.5, type: "money" }],
    lineItemColumns: [
      { key: "itemName", label: "Item" },
      { key: "varianceValue", label: "Variance Value", type: "money" },
    ],
    lineItems: [{ itemName: "Burger Bun", varianceValue: 12.5 }],
  };
  const report = transactionDetailToReport(detail);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].itemName, "Burger Bun");
  assert.match(report.report.description, /STK-260712-0015/);
  assert.equal(transactionDetailFileStem(detail), "STK-260712-0015");
  assert.ok(transactionDetailSummaryRows(detail).some((row) => row.Field === "Variance"));
});

test("Phase 35.3 drawer is shared, keyboard accessible, and preserves focus", () => {
  const drawer = read("src/modules/reporting/transactions/TransactionDetailDrawer.js");
  const viewer = read("src/modules/reporting/ReportViewer.js");
  const table = read("src/modules/reporting/tables/ReportTable.js");
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /event\.key === "Escape"/);
  assert.match(drawer, /restoreTarget\?\.focus\?\./);
  assert.match(drawer, /closeTransactionDetailDrawer\(\{ restoreFocus: false \}\)/);
  assert.match(viewer, /openTransactionDetailDrawer/);
  assert.match(table, /data-report-transaction-entity-id/);
  assert.match(table, /data-report-transaction-type/);
});

test("Phase 35.3 Worker endpoint validates workspace, reporting, reference, and location access", () => {
  const route = read("cloudflare-v2/src/legacy/transaction-detail-routes.ts");
  const index = read("cloudflare-v2/src/legacy/index.ts");
  assert.match(route, /assertWorkspaceAccess/);
  assert.match(route, /assertWorkspacePermission\(env, auth, workspaceId, "nav-reporting"\)/);
  assert.match(route, /assertLocationAccess/);
  assert.match(route, /getTransactionReference/);
  assert.match(route, /historicalTransactionReference/);
  assert.match(index, /reports\\\/transactions\\\/\(\[\^\/\]\+\)/);
});

test("Phase 35.3 XLSX model includes summary, line item, movement, and audit sheets", () => {
  const exportsSource = read("src/modules/reporting/transactions/transactionDetailExports.js");
  assert.match(exportsSource, /append\("Summary"/);
  assert.match(exportsSource, /append\("Line Items"/);
  assert.match(exportsSource, /append\("Stock Movements"/);
  assert.match(exportsSource, /append\("Audit Trail"/);
  assert.match(exportsSource, /downloadTransactionDetailPdf/);
  assert.match(exportsSource, /downloadTransactionDetailCsv/);
});
