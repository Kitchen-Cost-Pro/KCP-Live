import test from "node:test";
import assert from "node:assert/strict";

import { grvLogReport } from "../reports/purchasing/grvLogReport.js";
import { creditNotesReport } from "../reports/purchasing/creditNotesReport.js";
import { manufacturingTransactionsReport } from "../reports/operations/manufacturingTransactionsReport.js";
import { stockTransfersReport } from "../reports/operations/stockTransfersReport.js";
import { stockTakeAuditReport } from "../reports/operations/stockTakeAuditReport.js";
import {
  getRequiredTransactionColumnKeys,
  normalizeVisibleReportColumns,
  prepareTransactionReportResult,
  prioritizeTransactionColumns,
} from "./transactionColumnVisibility.js";

const transactionReports = [
  grvLogReport,
  creditNotesReport,
  manufacturingTransactionsReport,
  stockTransfersReport,
  stockTakeAuditReport,
];

test("transaction columns are promoted to the first visible position", () => {
  const columns = [
    { key: "date", label: "Date" },
    {
      key: "transactionReference",
      label: "Transaction ID",
      type: "transaction_id",
    },
    { key: "status", label: "Status" },
  ];

  const ordered = prioritizeTransactionColumns(columns);
  assert.equal(ordered[0].key, "transactionReference");
  assert.deepEqual(getRequiredTransactionColumnKeys(columns), [
    "transactionReference",
  ]);
});

test("saved views cannot hide the Transaction ID drawer entry point", () => {
  const columns = [
    { key: "date", label: "Date" },
    {
      key: "transactionReference",
      label: "Transaction ID",
      type: "transaction_id",
    },
    { key: "status", label: "Status" },
  ];

  assert.deepEqual(normalizeVisibleReportColumns(columns, ["date"]), [
    "transactionReference",
    "date",
  ]);
  assert.deepEqual(normalizeVisibleReportColumns(columns, []), [
    "transactionReference",
  ]);
});

test("all Phase 35 transaction report views expose Transaction ID first when supported", () => {
  for (const report of transactionReports) {
    let supportedViews = 0;
    for (const [view, columns] of Object.entries(report.columns || {})) {
      const transactionColumn = (columns || []).find(
        (column) => column.type === "transaction_id",
      );
      if (!transactionColumn) continue;
      supportedViews += 1;
      const prepared = prepareTransactionReportResult({
        report,
        view,
        columns,
      });
      assert.equal(
        prepared.columns[0]?.key,
        "transactionReference",
        `${report.id}/${view} must lead with Transaction ID`,
      );
      assert.equal(
        prepared.columns[0]?.type,
        "transaction_id",
        `${report.id}/${view} must keep the clickable transaction cell type`,
      );
      assert.equal(
        normalizeVisibleReportColumns(prepared.columns, [
          prepared.columns.at(-1)?.key,
        ])[0],
        "transactionReference",
        `${report.id}/${view} saved views must retain Transaction ID`,
      );
    }
    assert.ok(
      supportedViews > 0,
      `${report.id} must expose at least one transaction-enabled view`,
    );
  }
});
