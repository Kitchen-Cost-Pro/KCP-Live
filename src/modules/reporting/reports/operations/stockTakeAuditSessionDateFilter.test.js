import assert from "node:assert/strict";
import test from "node:test";

import { __stockTakeAuditReportInternals } from "./stockTakeAuditReport.js";
import { applyReportFilters } from "../../engine/grouping.js";

const { buildStockTakeAuditModel, normalizeStockTakeRows } = __stockTakeAuditReportInternals;

// Regression: applyReportFilters (the shared date-range quick filter, same one used across every
// report) only resolves a row's comparable date from `date`/`timestamp`/`createdAt`. The line-level
// rows get a `date` alias from normalizeStockTakeRows, but the "sessions"/"by_category"/"by_item"
// summary views build fresh row objects that only carried `stockTakeDate` — invisible to the
// filter. A row with none of the three recognised keys resolves to '' and is silently EXCLUDED
// whenever a date range is active (see applyReportFilters), so "Today" and "Yesterday" (exact
// single-day ranges) always came back empty for these views even though the count happened today.

function buildTodaySession() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = normalizeStockTakeRows(
    [
      {
        id: "line-1",
        sourceId: "session-1",
        stockTakeSessionId: "session-1",
        countedAt: `${today}T10:00:00.000Z`,
        locationId: "loc-1",
        locationName: "Down Bar",
        itemId: "item-1",
        itemName: "Almond Flour",
        category: "Bakery",
        expectedQty: 10,
        countedQty: 8,
        unitCostExVat: 15,
      },
    ],
    "Africa/Johannesburg",
  );
  return buildStockTakeAuditModel({ sourceRows: rows, varianceLedgerRows: [], sourceResponse: {} });
}

test("sessions view rows carry a `date` alias so today's count survives an exact-day filter", () => {
  const model = buildTodaySession();
  const today = new Date().toISOString().slice(0, 10);
  const filtered = applyReportFilters(model.views.sessions, { startDate: today, endDate: today });
  assert.equal(filtered.length, 1);
});

test("by_category view rows carry a `date` alias so today's count survives an exact-day filter", () => {
  const model = buildTodaySession();
  const today = new Date().toISOString().slice(0, 10);
  const filtered = applyReportFilters(model.views.by_category, { startDate: today, endDate: today });
  assert.equal(filtered.length, 1);
});

test("by_item view rows carry a `date` alias so today's count survives an exact-day filter", () => {
  const model = buildTodaySession();
  const today = new Date().toISOString().slice(0, 10);
  const filtered = applyReportFilters(model.views.by_item, { startDate: today, endDate: today });
  assert.equal(filtered.length, 1);
});

test("sessions view rows are excluded by an unrelated single day, proving the filter is exact and not just wide", () => {
  const model = buildTodaySession();
  const filtered = applyReportFilters(model.views.sessions, { startDate: "2000-01-01", endDate: "2000-01-01" });
  assert.equal(filtered.length, 0);
});
