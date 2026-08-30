import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderReportTable } from "../tables/ReportTable.js";
import { creditNotesReport } from "../reports/purchasing/creditNotesReport.js";
import {
  buildTransactionDetailPdfModel,
  transactionDetailToPdfDocument,
} from "./transactionDetailExports.js";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const creditNoteDetail = {
  entityType: "credit_note",
  transactionReference: "CN-260711-H1IX2E5",
  title: "Credit Note 222",
  status: "Committed",
  occurredAt: "2026-07-11T00:00:00.000Z",
  timeZone: "Africa/Johannesburg",
  locationNames: ["Main Store"],
  createdByName: "David Ziervogel",
  committedBy: "David Ziervogel",
  summaryCards: [
    { key: "lineCount", label: "Items Credited", value: 1, type: "number" },
    { key: "totalQuantity", label: "Credited Quantity", value: 20, type: "number" },
    { key: "totalExVat", label: "Credit Ex VAT", value: 255.78, type: "money" },
    { key: "vat", label: "VAT", value: 38.37, type: "money" },
    { key: "totalInclVat", label: "Credit Incl VAT", value: 294.15, type: "money" },
    { key: "stockImpact", label: "Stock Impact", value: "Stock Returned" },
    { key: "stockMovementRows", label: "Stock Movements", value: 1, type: "number" },
    { key: "reconciled", label: "Ledger Reconciliation", value: "Reconciled" },
  ],
  metadata: {
    supplierId: "supplier-internal-id",
    supplierName: "Digifood",
    creditNoteNumber: "222",
    reason: "Processed from GRV Inv-001",
    originalInvoiceGrv: "Inv-001",
    originalGrvId: "grv-internal-id",
    originalTransactionReference: "GRV-260711-HK9FCH2",
    financialOnly: false,
    pricesIncludeVat: false,
    vatRate: 15,
    vatMode: "Prices exclude VAT",
    ledgerReconciled: true,
    ledgerQuantity: 20,
    ledgerValue: 255.78,
  },
  lineItemColumns: [
    { key: "itemName", label: "Item" },
    { key: "category", label: "Category" },
    { key: "locationName", label: "Location" },
    { key: "quantity", label: "Credited Qty", type: "number" },
    { key: "unit", label: "UOM" },
    { key: "unitCostExVat", label: "Unit Cost Ex VAT", type: "money" },
    { key: "totalExVat", label: "Credit Ex VAT", type: "money" },
    { key: "vat", label: "VAT", type: "money" },
    { key: "totalInclVat", label: "Credit Incl VAT", type: "money" },
    { key: "stockImpact", label: "Stock Impact" },
  ],
  lineItems: [{
    itemName: "Flour",
    category: "Dry Goods - Raw Materials",
    locationName: "Main Store",
    quantity: 20,
    unit: "kg",
    unitCostExVat: 12.79,
    totalExVat: 255.78,
    vat: 38.37,
    totalInclVat: 294.15,
    stockImpact: "Stock Returned",
  }],
};

test("Transaction PDF model keeps customer facts and removes technical metadata", () => {
  const model = buildTransactionDetailPdfModel(creditNoteDetail);
  const factLabels = model.facts.map((fact) => fact.label);
  const renderedFacts = JSON.stringify(model.facts);

  assert.equal(model.title, "CN-260711-H1IX2E5 - Credit Note");
  assert.equal(model.summaryCards.length, 6);
  assert.equal(model.reconciliation, "Reconciled");
  assert.ok(factLabels.includes("Supplier"));
  assert.ok(factLabels.includes("Reason"));
  assert.ok(factLabels.includes("Original Transaction"));
  assert.doesNotMatch(renderedFacts, /supplier-internal-id|grv-internal-id/i);
  assert.doesNotMatch(renderedFacts, /Ledger Quantity|Ledger Value|Financial Only|Prices Include Vat/i);
  assert.equal(model.rows.length, 1);
  assert.equal(model.columns[0].label, "Item");
});

test("Transaction PDF document uses the dedicated structured renderer", async () => {
  const doc = await transactionDetailToPdfDocument(creditNoteDetail);
  const bytes = doc.output("arraybuffer");
  assert.ok(bytes.byteLength > 2000);
  assert.ok(doc.internal.getNumberOfPages() >= 1);
});

test("Transaction ID wrapper and every table section use a fixed sticky first column", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { className: "", innerHTML: "" };
    },
  };

  try {
    const columns = creditNotesReport.columns.summary;
    const wrapper = renderReportTable({
      report: creditNotesReport,
      id: creditNotesReport.id,
      view: "summary",
      columns,
      rows: [{ transactionReference: "CN-260711-H1IX2E5", creditNoteId: "cn-1" }],
      totals: { lineCount: 1 },
    });
    assert.match(wrapper.className, /reportTableWrap--stickyTransaction/);
    assert.match(wrapper.innerHTML, /reportTable__transactionColumn/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  const css = read("src/styles/reporting.css");
  const totals = read("src/modules/reporting/tables/ReportTotalsRow.js");
  assert.match(css, /reportTableWrap--stickyTransaction/);
  assert.match(css, /position:\s*sticky\s*!important/);
  assert.match(css, /left:\s*0\s*!important/);
  assert.match(totals, /isTransactionIdColumn/);
});
