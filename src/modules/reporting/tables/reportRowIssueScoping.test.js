import test from "node:test";
import assert from "node:assert/strict";

import { renderReportTable } from "./ReportTable.js";
import { createRowWarning } from "../validators/rowWarningUtils.js";

// Regression: a per-row data-quality warning (createRowWarning() tags it with the source row's own
// itemId/itemName and isItemSpecific: true) was still falling through to a generic "does THIS row
// also look zero-cost" heuristic when it didn't explicitly match — so a "Milk has zero unit cost"
// warning ended up listed under every OTHER zero-cost row's "!" tooltip too, not just Milk's own row.
test("a row's data-quality tooltip only lists warnings about that row's own item", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { className: "", innerHTML: "" };
    },
  };

  try {
    const coffeeRow = { itemId: "stock-coffee", itemName: "Coffee Beans", stockItemId: "stock-coffee", unitCostExVat: 0, value: 0 };
    const milkRow = { itemId: "stock-milk", itemName: "Milk (regular)", stockItemId: "stock-milk", unitCostExVat: 0, value: 0 };
    const warnings = [
      createRowWarning(coffeeRow, "missing-unit-cost", "critical", "row(s) have zero unit cost. Value calculations may be understated.", 0),
      createRowWarning(milkRow, "missing-unit-cost", "critical", "row(s) have zero unit cost. Value calculations may be understated.", 1),
    ];

    const wrapper = renderReportTable({
      columns: [
        { key: "itemName", label: "Item" },
        { key: "unitCostExVat", label: "Unit Cost", type: "money" },
      ],
      rows: [coffeeRow, milkRow],
      warnings,
      totals: {},
    });

    const rows = wrapper.innerHTML.split('<tr data-report-row=').slice(1);
    const coffeeRowHtml = rows.find((row) => row.includes("Coffee Beans"));
    const milkRowHtml = rows.find((row) => row.includes("Milk (regular)"));

    // cleanRowIssueText() strips a row's own label from its own tooltip (redundant since it's
    // already shown inline on that row) — the bug this guards against is cross-item leakage, so
    // what matters is that Milk's name never appears on Coffee Beans' tooltip and vice versa.
    assert.match(coffeeRowHtml, /data-report-tooltip="Have zero unit cost/);
    assert.doesNotMatch(coffeeRowHtml, /Milk \(regular\)/);
    assert.match(milkRowHtml, /data-report-tooltip="Have zero unit cost/);
    assert.doesNotMatch(milkRowHtml, /Coffee Beans/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
