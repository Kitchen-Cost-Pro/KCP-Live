import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

test("Phase 35.4 GRV summaries include transaction, PO, timestamp and VAT fields", () => {
  const source = read("src/modules/reporting/reports/purchasing/grvLogReport.js");
  assert.match(source, /Transaction ID/);
  assert.match(source, /GRV Date & Time/);
  assert.match(source, /purchaseOrderNumber/);
  assert.match(source, /Multiple Locations/);
  assert.match(source, /Total Value Incl VAT/);
});

test("Phase 35.4 Credit Note summaries include timestamp, VAT, stock impact and committed user", () => {
  const source = read("src/modules/reporting/reports/purchasing/creditNotesReport.js");
  assert.match(source, /Credit Note Date/);
  assert.match(source, /type: "datetime"/);
  assert.match(source, /committedAt/);
  assert.match(source, /Credit Value Incl VAT/);
  assert.match(source, /stockImpact/);
});

test("Phase 35.4 transaction API exposes GRV receiving detail and Credit Note reconciliation fields", () => {
  const source = read("cloudflare-v2/src/legacy/transaction-detail-routes.ts");
  assert.match(source, /Received UOM/);
  assert.match(source, /Base Qty/);
  assert.match(source, /originalTransactionReference/);
  assert.match(source, /Credit Incl VAT/);
  assert.match(source, /Ledger Reconciliation/);
  assert.match(source, /Review Required/);
});

test("Phase 35.4 drawer can open the linked source transaction", () => {
  const source = read("src/modules/reporting/transactions/TransactionDetailDrawer.js");
  assert.match(source, /data-linked-transaction-reference/);
  assert.match(source, /openTransactionDetailDrawer/);
});
