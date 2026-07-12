import test from "node:test";
import assert from "node:assert/strict";

import { renderReportTable } from "../tables/ReportTable.js";
import { grvLogReport } from "../reports/purchasing/grvLogReport.js";
import { creditNotesReport } from "../reports/purchasing/creditNotesReport.js";
import { manufacturingTransactionsReport } from "../reports/operations/manufacturingTransactionsReport.js";
import { stockTransfersReport } from "../reports/operations/stockTransfersReport.js";
import { stockTakeAuditReport } from "../reports/operations/stockTakeAuditReport.js";

const reportCases = [
  [grvLogReport, "GRV-260712-0001", { grvId: "grv-1" }],
  [creditNotesReport, "CN-260712-0001", { creditNoteId: "cn-1" }],
  [manufacturingTransactionsReport, "MFG-260712-0001", { manufacturingBatchId: "mfg-1" }],
  [stockTransfersReport, "TRF-260712-0001", { transferId: "trf-1" }],
  [stockTakeAuditReport, "STK-260712-0001", { stockTakeSessionId: "stk-1" }],
];

test("Transaction ID renders first and clickable in every transaction-enabled Phase 35 table view", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { className: "", innerHTML: "" };
    },
  };

  try {
    for (const [report, reference, identity] of reportCases) {
      for (const [view, columns] of Object.entries(report.columns || {})) {
        if (!(columns || []).some((column) => column.type === "transaction_id")) continue;

        const wrapper = renderReportTable({
          report,
          id: report.id,
          view,
          columns,
          rows: [{ transactionReference: reference, ...identity }],
          totals: {},
        });
        const html = wrapper.innerHTML;
        const transactionHeader = html.indexOf('data-column-key="transactionReference"');
        const nextKnownHeader = columns
          .filter((column) => column.key !== "transactionReference")
          .map((column) => html.indexOf(`data-column-key="${column.key}"`))
          .filter((index) => index >= 0)
          .sort((a, b) => a - b)[0];

        assert.ok(transactionHeader >= 0, `${report.id}/${view} must render Transaction ID header`);
        assert.ok(
          nextKnownHeader === undefined || transactionHeader < nextKnownHeader,
          `${report.id}/${view} must render Transaction ID before all other columns`,
        );
        assert.match(
          html,
          new RegExp(`data-report-transaction-id="${reference}"`),
          `${report.id}/${view} must render a clickable Transaction ID`,
        );
      }
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
