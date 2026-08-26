import test from "node:test";
import assert from "node:assert/strict";

import {
  isStorageReportLocation,
  renderReportTable,
} from "./ReportTable.js";

test("Main Store is identified as storage in report location columns", () => {
  assert.equal(
    isStorageReportLocation(
      "Main Store",
      { key: "locationName" },
      { locationId: "main" },
    ),
    true,
  );
  assert.equal(
    isStorageReportLocation(
      "Waterfront · Main Store",
      { key: "toLocationDisplay" },
      {},
    ),
    true,
  );
  assert.equal(
    isStorageReportLocation(
      "Downstairs Bar",
      { key: "locationName" },
      {},
    ),
    false,
  );
});

test("storage pill renders beside Main Store across shared report tables", () => {
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
        { key: "grossSales", label: "Gross Sales", type: "money" },
      ],
      rows: [
        { locationName: "Main Store", grossSales: 150 },
        { locationName: "Downstairs Bar", grossSales: 20 },
      ],
      totals: {},
    });

    assert.match(
      wrapper.innerHTML,
      /Main Store[\s\S]*reportLocationTypePill--storage[\s\S]*Storage/,
    );
    assert.doesNotMatch(
      wrapper.innerHTML,
      /Downstairs Bar[\s\S]*reportLocationTypePill--storage/,
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
