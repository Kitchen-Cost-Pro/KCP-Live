# Reporting Audit & Fix Plan

Phased plan for running `report-auditor` → `report-logic-builder` → `report-bug-checker` against each section of `src/modules/reporting/` (and the `cloudflare-v2` engine it depends on), ending with a `report-ship-manager` gate. Sections are split by directory so no phase's context is too large for a single audit pass, and by dependency order — core math/VAT and filters come first since every downstream report depends on them.

## How each phase runs

1. **Audit** — invoke `report-auditor`, scoped to that phase's files only, ask it for a ranked findings list (blocker/high/medium/low).
2. **Fix** — invoke `report-logic-builder` with the findings list from step 1.
3. **Check** — invoke `report-bug-checker` against the diff from step 2.
4. **Loop** — if `report-bug-checker` reports a SHIP-BLOCKING issue, go back to step 2 for that finding only. Repeat until clean.
5. **Record** — log the phase's findings and resolutions in `docs/report-audits/PHASE_<n>_<name>.md`, following the existing `docs/IMPLEMENTATION_PHASE*.md` convention.

Only after every phase below is closed out does `report-ship-manager` run once, end-to-end, as the final go/no-go (Phase 9).

## Phase 1 — Core engine, math & VAT logic

Highest priority: every report downstream depends on this being correct.

Scope: `engine/calculations.js`, `engine/statistics.js`, `engine/grouping.js`, `engine/yocoFinancials.js`, `engine/stockLedgerMapper.js`, `engine/reportDataMapper.js`, `engine/modifierUsageMapper.js`, `engine/recipeExplosion.js`, `engine/reportingIntegrity.js`, `engine/reportRunner.js`, `engine/timezone.js`, `engine/forecasting.js`, `engine/riskScoring.js`, `engine/trendAnalysis.js`, `engine/formatters.js`.

Focus for the auditor: VAT inclusive/exclusive handling, rounding order, sign conventions on refunds/credits, UOM conversion, recipe cost explosion, timezone boundary handling for date-ranged reports.

## Phase 2 — Sales reports

Scope: `reports/sales/*` (modifierReport, paymentSalesFinancialReport, salesReportHelpers, saleStockMovementReport, salesReportsGroup, dataFoundation).

Focus: VAT-on-modifiers, discount handling, payment-method splits, and reconciliation against Phase 1's `yocoFinancials.js` output.

## Phase 3 — Purchasing reports

Scope: `reports/purchasing/*` (purchaseOrdersReport, grvLogReport, creditNotesReport, purchasingReportHelpers).

Focus: GRV-to-PO matching logic, credit note sign conventions, VAT on purchase costs.

## Phase 4 — Operations reports

Scope: `reports/operations/*` (adjustmentsReport, detailedActivityReport, manufacturingTransactionsReport, menuRecipeHealthReport, operationsDashboardReport, stockControlReport, stockControlOrderability, stockTakeAuditReport, stockTransfersReport, wastageReport, wastageSourceUtils).

Focus: stock movement math, manufacturing yield/recipe consumption, wastage cost attribution, cross-location transfer accounting.

## Phase 5 — Inventory & audit reports

Scope: `reports/inventory/stockOnHandReport.js`, `reports/audit/inventoryAuditReport.js`.

Focus: stock-on-hand reconciliation against ledger, audit trail completeness, opening/closing balance math.

## Phase 6 — Advanced reports

Scope: `reports/advanced/*` (priceVolatilityReport, stockOutForecastReport, theoreticalVsActualReport, advancedReportHelpers).

Focus: forecast/statistical logic correctness (depends on Phase 1's `forecasting.js`/`statistics.js`), theoretical-vs-actual variance calculation.

## Phase 7 — Filters, saved views & scheduling

Scope: `tables/ReportFilters.js`, `ui/customSelect.js`, `savedViews/SavedViewsControl.js`, `scheduling/*` (dateRangePresets, scheduleTiming, scheduleExecutionFreshness, reportSchedulingApi, reportSelectionResolver, SchedulingPage, scheduleFormats, emailAttachmentEncoding).

Focus: filter values actually reaching the query layer, saved-view round-tripping, scheduled runs using the same gating/filter logic as interactive runs (this is the most likely place for silent drift).

## Phase 8 — Columns, tables & exports

Scope: `tables/ReportTable.js`, `ReportTotalsRow.js`, `ReportHeader.js`, `ReportPagination.js`, `ReportDrilldownTabs.js`, `transactionColumnVisibility.js`; `exports/exportCsv.js`, `exportExcel.js`, `exportPdf.js`, `exportMappers.js`; `api/reportingMappers.js`, `api/reportDataSourceCatalog.js`, `api/reportPageLoader.js`.

Focus: on-screen column values vs. exported column values parity, totals row summing the right column, pagination boundary correctness.

## Phase 9 — Cross-report reconciliation, validators & gating

Scope: `validators/*` (reconciliationChecks, dataQualityRules, reportingDatabaseContract, reportRuntimeIntegrity, salesUsageValidators, warningCategories, phase19/23/35 signoff files), plus the server-side gating in `cloudflare-v2/src/modules/modifier-engine` and `cloudflare-v2/src/modules/yoco-engine-v2`.

Focus: does the same transaction reconcile across sales, purchasing, inventory, and audit reports; is permission/location gating enforced server-side, not just in the UI.

## Phase 10 — Final ship gate

Run `report-ship-manager` once, referencing every phase's recorded findings/resolutions and re-running the full test suite itself. Output: `SHIP` or `DO NOT SHIP` with an explicit list of any deferred non-blocking follow-ups, written to `release-evidence/CHANGE_MANIFEST.md` per the existing convention.

## Suggested order of execution

Phase 1 → Phase 7 (filters/scheduling, since every other phase's audit assumes filters work) → Phases 2–6 in parallel or sequence as time allows → Phase 8 → Phase 9 → Phase 10.
