import test from "node:test";
import assert from "node:assert/strict";

import { renderReportTable } from "./ReportTable.js";

test("numeric report headings, values, and totals share centred column alignment", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { className: "", innerHTML: "" };
    },
  };

  try {
    const wrapper = renderReportTable({
      columns: [
        { key: "locationName", label: "Location" },
        {
          key: "grossSales",
          label: "Gross Sales",
          type: "money",
          align: "right",
        },
        {
          key: "transactionCount",
          label: "Transaction Count",
          type: "number",
          align: "right",
        },
      ],
      rows: [
        {
          locationName: "Main Store",
          grossSales: 150,
          transactionCount: 8,
        },
      ],
      totals: {
        grossSales: 150,
        transactionCount: 8,
      },
    });

    assert.match(
      wrapper.innerHTML,
      /<th class="is-numeric is-align-center" data-column-key="grossSales" style="text-align:center">/,
    );
    assert.match(
      wrapper.innerHTML,
      /<td class="reportTable__cell is-numeric" data-column-key="grossSales" style="text-align:center">R\s150,00<\/td>/,
    );
    assert.match(
      wrapper.innerHTML,
      /<td class="reportTable__cell is-numeric" data-column-key="transactionCount" style="text-align:center">8<\/td>/,
    );
    assert.match(
      wrapper.innerHTML,
      /<tfoot>[\s\S]*data-column-key="grossSales" style="text-align:center">R\s150,00<\/td>/,
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
