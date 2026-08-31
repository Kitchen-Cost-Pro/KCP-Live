import test from "node:test";
import assert from "node:assert/strict";
import { grvLogReport } from "./grvLogReport.js";

// GRV Log must clearly show HOW the item was bought (e.g. "1 Bottle") as a distinct, prominent
// value from the converted base-unit stock-ledger total (e.g. "30 Tot") — not just one ambiguous
// quantity, and not silently only the converted figure.

function fakeRow(overrides = {}) {
  return {
    id: "grv-line-1",
    grvId: "grv-1",
    grvDate: "2026-08-31T10:00:00.000Z",
    itemName: "Jagermeister",
    receivedQty: 30,
    baseUom: "Tot",
    packQty: 1,
    packSize: 30,
    receivingUom: "Bottle",
    unitCostExVat: 5,
    lineValueExVat: 150,
    vat: 22.5,
    lineValueInclVat: 172.5,
    ...overrides,
  };
}

test('a line bought as "1 Bottle" (30 tots per bottle) shows Purchased As "1 Bottle" and Converted Qty "30 Tot"', async () => {
  const result = await grvLogReport.getRows({
    workspaceId: "ws_1",
    filters: {},
    services: { reporting: { getGrvLogRows: async () => ({ rows: [fakeRow()], warnings: [], meta: {} }) } },
    view: "line_detail",
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].purchasedAsDisplay, "1 Bottle");
  assert.equal(result[0].convertedQtyDisplay, "30 Tot");
  // Both underlying values remain available even though only the combined displays are columns.
  assert.equal(result[0].packQty, 1);
  assert.equal(result[0].packSize, 30);
  assert.equal(result[0].receivingUom, "Bottle");
  assert.equal(result[0].receivedQty, 30);
  assert.equal(result[0].baseUom, "Tot");
});

test("a line with no custom UOM captured (bought directly in the base unit) shows the same value on both sides", async () => {
  const row = fakeRow({ receivedQty: 5, baseUom: "kg", packQty: 5, packSize: 1, receivingUom: "kg" });
  const result = await grvLogReport.getRows({
    workspaceId: "ws_1",
    filters: {},
    services: { reporting: { getGrvLogRows: async () => ({ rows: [row], warnings: [], meta: {} }) } },
    view: "line_detail",
  });
  assert.equal(result[0].purchasedAsDisplay, "5 kg");
  assert.equal(result[0].convertedQtyDisplay, "5 kg");
});

test("the Purchased As / Converted Qty columns are registered on the line_detail view", () => {
  const keys = grvLogReport.columns.line_detail.map((column) => column.key);
  assert.ok(keys.includes("purchasedAsDisplay"));
  assert.ok(keys.includes("convertedQtyDisplay"));
  const purchasedAs = grvLogReport.columns.line_detail.find((c) => c.key === "purchasedAsDisplay");
  assert.equal(purchasedAs.type, "qty_unit_text");
});
