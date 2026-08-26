import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatTransactionReference,
  historicalTransactionReference,
  isTransactionReference,
  transactionDateKey,
} from "./transactionReference.js";
import { grvLogReport } from "../reports/purchasing/grvLogReport.js";
import { creditNotesReport } from "../reports/purchasing/creditNotesReport.js";
import { stockTransfersReport } from "../reports/operations/stockTransfersReport.js";
import { stockTakeAuditReport } from "../reports/operations/stockTakeAuditReport.js";

test("Phase 35.2 formats readable transaction IDs in the workspace reporting timezone", () => {
  const occurredAt = "2026-07-11T22:30:00.000Z";
  assert.equal(transactionDateKey(occurredAt), "260712");
  assert.equal(formatTransactionReference("grv", "260712", 42), "GRV-260712-0042");
  assert.equal(formatTransactionReference("credit_note", "260712", 18), "CN-260712-0018");
  assert.equal(formatTransactionReference("manufacturing_batch", "260712", 24), "MFG-260712-0024");
  assert.equal(formatTransactionReference("transfer", "260712", 31), "TRF-260712-0031");
  assert.equal(formatTransactionReference("stock_take", "260712", 15), "STK-260712-0015");
});

test("Phase 35.2 historical transaction IDs are deterministic and remain readable", () => {
  const first = historicalTransactionReference(
    "stock_take",
    "123e4567-e89b-12d3-a456-426614174000",
    "2026-07-12T08:00:00+02:00",
  );
  const second = historicalTransactionReference(
    "stock_take",
    "123e4567-e89b-12d3-a456-426614174000",
    "2026-07-12T08:00:00+02:00",
  );
  assert.equal(first, second);
  assert.match(first, /^STK-260712-H[A-Z0-9]{6}$/);
  assert.equal(isTransactionReference(first, "stock_take"), true);
});

test("Phase 35.2 transaction summary reports expose clickable Transaction ID columns", () => {
  const reports = [
    [grvLogReport, "summary"],
    [creditNotesReport, "summary"],
    [stockTransfersReport, "summary"],
    [stockTakeAuditReport, "sessions"],
  ];
  for (const [report, view] of reports) {
    const transactionColumn = report.columns[view].find(
      (column) => column.key === "transactionReference",
    );
    assert.ok(transactionColumn, `${report.id}:${view} has no Transaction ID`);
    assert.equal(transactionColumn.label, "Transaction ID");
    assert.equal(transactionColumn.type, "transaction_id");
    assert.equal(
      report.columns[view].some((column) => column.label === "Source ID"),
      false,
    );
  }
});

test("Phase 35.2 Worker allocation is central, retry-safe, and shared for external transfers", async () => {
  const [referenceSource, routesSource, migrationSource] = await Promise.all([
    readFile(
      new URL("../../../../cloudflare-v2/src/legacy/transaction-references.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../../cloudflare-v2/src/legacy/routes.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../../cloudflare-v2/migrations/0002_transaction_references.sql", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(referenceSource, /transaction_reference_sequences/);
  assert.match(referenceSource, /transaction_reference_links/);
  assert.match(referenceSource, /ON CONFLICT\(workspace_id, entity_type, entity_id\) DO NOTHING/);
  assert.match(routesSource, /getTransactionReference[\s\S]*duplicate: true/);
  assert.match(routesSource, /senderTransactionReference[\s\S]*preferredReference|senderTransactionReference[\s\S]*ensureTransactionReference/);
  assert.match(migrationSource, /UNIQUE \(entity_type, date_key, sequence\)/);
});

test("Phase 35.2 transaction cells dispatch a selection event without changing report state", async () => {
  const [tableSource, viewerSource] = await Promise.all([
    readFile(new URL("../tables/ReportTable.js", import.meta.url), "utf8"),
    readFile(new URL("../ReportViewer.js", import.meta.url), "utf8"),
  ]);
  assert.match(tableSource, /data-report-transaction-id/);
  assert.match(tableSource, /reportTable__transactionLink/);
  assert.match(viewerSource, /reporttransactionselect/);
  assert.match(viewerSource, /onTransactionSelect/);
  assert.match(viewerSource, /event\.target\.closest/);
});
