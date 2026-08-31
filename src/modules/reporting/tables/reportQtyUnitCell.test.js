import test from "node:test";
import assert from "node:assert/strict";
import { renderReportTable } from "./ReportTable.js";

// The Stock on Hand "by_uom" view's cells were a plain concatenated "<qty> <unit>" string (e.g.
// "52 Tot"), which read as one run-on value. The `qty_unit_text` column type visually splits the
// number from its unit (a muted trailing label) WITHOUT changing the underlying string value used
// for sorting/export.

function withMockDocument(fn) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { className: "", innerHTML: "" };
    },
  };
  try {
    return fn();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

test("a qty_unit_text cell splits the number from its trailing unit into separate elements", () => {
  withMockDocument(() => {
    const wrapper = renderReportTable({
      columns: [{ key: "baseUomDisplay", label: "Base UOM Qty", type: "qty_unit_text" }],
      rows: [{ baseUomDisplay: "52 Tot" }],
      totals: {},
    });
    assert.match(wrapper.innerHTML, /<span class="reportTable__qtyUnitCell"><strong>52<\/strong><em>Tot<\/em><\/span>/);
  });
});

test("a negative quantity keeps its sign on the number part", () => {
  withMockDocument(() => {
    const wrapper = renderReportTable({
      columns: [{ key: "baseUomDisplay", label: "Base UOM Qty", type: "qty_unit_text" }],
      rows: [{ baseUomDisplay: "-2.5 kg" }],
      totals: {},
    });
    assert.match(wrapper.innerHTML, /<strong>-2\.5<\/strong><em>kg<\/em>/);
  });
});

test("a multi-word unit (e.g. a custom UOM name with spaces) is kept intact in the unit part", () => {
  withMockDocument(() => {
    const wrapper = renderReportTable({
      columns: [{ key: "customUom1Display", label: "Custom UOM 1", type: "qty_unit_text" }],
      rows: [{ customUom1Display: "3 Case Pack" }],
      totals: {},
    });
    assert.match(wrapper.innerHTML, /<strong>3<\/strong><em>Case Pack<\/em>/);
  });
});

test("a blank cell (no custom UOM configured) still renders as a plain dash, not a broken split", () => {
  withMockDocument(() => {
    const wrapper = renderReportTable({
      columns: [{ key: "customUom2Display", label: "Custom UOM 2", type: "qty_unit_text" }],
      rows: [{ customUom2Display: "" }],
      totals: {},
    });
    assert.doesNotMatch(wrapper.innerHTML, /reportTable__qtyUnitCell/);
    assert.match(wrapper.innerHTML, /data-column-key="customUom2Display"[^<]*-/);
  });
});
