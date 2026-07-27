# Yoco V2 Reporting Wiring Audit

**Release:** `phase-v2-final-legacy-removal-reporting-audit`  
**Audit date:** 2026-07-16

## 1. Reporting contract

- `stock_movements` is the inventory ledger source of truth.
- `yoco_orders` and related canonical Yoco line data are the sale and refund reporting sources.
- Reports do not parse raw webhook payloads or call Yoco.
- The frontend report registry, API data-source catalog, shared report engine, exports, saved views, and scheduler define one reporting architecture.
- UI totals are derived through report modules and shared calculations, not independent page-specific authoritative formulas.
- Location, date range, South African timezone, trading-day, pagination, and workspace filters are applied through shared reporting layers.

## 2. V2 event wiring

### Sale

The queue processor resolves a canonical sale, creates deterministic financial and stock proposals, and invokes controlled V2 live effects. Reporting writes include order identity, location, occurred time, currency, gross, discount, net, VAT, tips, line items, and modifiers. Stock effects use deterministic IDs and write ingredient depletion to `stock_movements`.

### Refund

The processor resolves a canonical refund and builds separate reporting and stock proposals. Financial completion is independent from inventory resolution. Exact and manually allocated lines can return stock. Amount-only unresolved refunds remain financial records with inventory manual review. Return-capacity checks prevent cumulative returned quantities from exceeding the original deduction.

## 3. Report-by-report source map

| Report | Endpoint / engine | Primary tables | Yoco V2 wiring | Filters, export, schedule | Status |
|---|---|---|---|---|---|
| Main Dashboard | Dashboard reporting loaders and shared report APIs | `yoco_orders`, `stock_movements`, stock balances, locations | Sales and refunds from canonical reporting; inventory from ledger | Date/location/trading-day supported; live production reconciliation required | PASS WITH WARNING |
| Operations Dashboard | `reports/detailed-activity` and operations report module | `stock_movements`, inventory documents, `yoco_orders` | Sale/refund movements enter through ledger | Shared filters and report engine | PASS |
| Detailed Activity | `reports/detailed-activity` | `stock_movements` plus document/name joins | Sale depletion and refund return remain traceable by source and metadata | UI/export/schedule use report result | PASS |
| Payment Summary / Sales Financial | `reports/sales-financial` | `yoco_orders`, order lines, locations, workspace settings | Canonical gross, discounts, net, VAT, tips, and refunds | Shared ZAR/date/location handling | PASS |
| Sale Stock Movement | `reports/sale-stock-usage` | `stock_movements`, items, locations, Yoco order identity | V2 sale depletion and refund return are distinguishable by movement type and metadata | Shared report/export path | PASS |
| Modifier Report | `reports/modifier-sales`, `reports/modifier-usage` | Yoco lines/groups, products, `stock_movements` | Canonical modifiers feed financial and ingredient usage; refund proposals reverse resolved modifier effects | Multiple report views supported | PASS |
| Menu and Recipe Health | `reports/menu-recipe-health` | products, recipes, recipe lines, location costs, Yoco lines | Uses current product/recipe mappings and canonical sales context | Warnings are report-layer outputs | PASS |
| Stock Control | `reports/stock-control` | stock items, balances, `stock_movements`, location costs | Sale deductions and refund returns affect ledger-derived position | Location filtering and scheduled-report safety covered | PASS |
| Inventory Audit | `reports/inventory-audit` | audit events, `stock_movements`, recipes, users | V2 movement metadata and system actor provide traceability | Audit views and transaction references | PASS |
| Stock on Hand | stock-on-hand report module | balances, ledger, items, locations | V2 sale and refund movements contribute to SOH | Export/report module parity | PASS |
| Purchase Orders | purchasing report module | purchase orders, lines, suppliers, locations | Not directly Yoco-dependent | Shared report engine | NOT APPLICABLE |
| GRV Log | purchasing report module | GRVs, lines, stock movements, suppliers | Not directly Yoco-dependent | Shared report engine | NOT APPLICABLE |
| Credit Notes | purchasing report module | credit notes, lines, stock movements | Not directly Yoco-dependent | Shared report engine | NOT APPLICABLE |
| Wastage | detailed-activity source and wastage report | `stock_movements`, adjustments, manufacturing | Refund return has a separate movement classification and is not wastage | Source classification tests exist | PASS |
| Adjustments | detailed-activity source and adjustment report | `stock_movements`, adjustments, stock takes, manufacturing | Refund return remains outside adjustment categories | Shared filters/export | PASS |
| Manufacturing | manufacturing transaction report | batches, lines, `stock_movements`, locations | Not directly Yoco-dependent; ledger remains common source | Transaction drawers and exports | NOT APPLICABLE |
| Stock Take Audit | `reports/stock-take-audit`, detail endpoints | sessions, count lines, `stock_movements` | Not directly Yoco-dependent | Date/location/detail export | NOT APPLICABLE |
| Stock Transfers | transfer report module | transfers, lines, `stock_movements`, locations | Not directly Yoco-dependent | Source and destination location resolution | NOT APPLICABLE |
| Theoretical vs Actual | advanced report module | canonical sales, recipes, stock movements | Canonical sale quantities and resolved refunds adjust theoretical usage | Shared date/location filters | PASS WITH WARNING |
| Stock-Out Forecast | advanced report module | stock state, ledger history | V2 movements contribute to demand history | Forecast tests cover source integration | PASS |
| Price Volatility | advanced report module | location costs, receipt history | Not directly Yoco-dependent | Shared report engine | NOT APPLICABLE |
| Saved Views | saved-view control and API | saved view definitions plus report catalog | Stores filters/view state, not legacy totals | Resolves current report IDs/views | PASS |
| Scheduled Reports | scheduling modules and Worker schedule endpoints | schedule definitions plus current report APIs | Fetches current data at execution time through report engine | CSV/XLSX/PDF, views, recipients, dates | PASS WITH WARNING |
| Email Delivery | scheduling attachment and email delivery code | generated report payloads | Uses scheduled report result | Binary attachment tests exist; production provider delivery required | PASS WITH WARNING |
| CSV Export | `exports/exportCsv.js` | report result | No independent Yoco calculation | Filtered visible report data | PASS |
| XLSX Export | `exports/exportExcel.js` | report result | No independent Yoco calculation | Numeric/date cell and multi-sheet paths tested | PASS |
| PDF Export | `exports/exportPdf.js` | report result | No independent Yoco calculation | Table, totals, branding, pagination paths tested | PASS WITH WARNING |

`PASS WITH WARNING` means source wiring and automated checks are present, but live production parity or fixture evidence is still required. It does not conceal a known source-level failure.

## 4. Financial wiring checks

| Check | Result |
|---|---|
| Sale written once through deterministic canonical identity | PASS |
| Duplicate webhook/queue/replay protected by database identity and effect keys | PASS |
| Gross, discount, net, VAT, and tips stored from canonical values | PASS |
| Refund values stored independently from stock resolution | PASS |
| Full and partial refunds linked to original order | PASS |
| Cumulative refund stock return cannot exceed original deductions | PASS |
| ZAR enforced for live sale/refund effects | PASS |
| Integer/minor-unit conversion centralized at Yoco financial boundaries | PASS |
| Aggregate production equations match current Yoco source | REQUIRES LIVE RECONCILIATION |

## 5. Inventory wiring checks

| Check | Result |
|---|---|
| Sale ingredients written to `stock_movements` | PASS |
| Modifier ingredients written once when mapped | PASS |
| Custom UOM expansion reaches base quantity proposal | PASS |
| Sub-recipe expansion is centralized and avoids unrelated legacy sale dependency | PASS |
| Refund stock returned only from resolved proposals | PASS |
| Amount-only unresolved refund creates no automatic return | PASS |
| Manual allocation uses approved line quantities | PASS |
| Original sale location is retained | PASS |
| Duplicate movement prevented by deterministic IDs and insert constraints | PASS |
| Current production SOH matches a full ledger rebuild | REQUIRES LIVE RECONCILIATION |

## 6. Timezone and trading day

Reporting has shared timezone helpers and automated tests. Operational defaults use South African time, and report APIs carry workspace/trading-hour configuration. Date presets, custom ranges, and schedule timing are shared modules.

Source-level status is PASS. Verification against deployed workspaces with 05:00 to 05:00 and 07:00 to 07:00 boundaries remains part of the live reconciliation evidence.

## 7. Export and schedule parity

Manual CSV, XLSX, and PDF exports consume report results rather than querying Yoco or recalculating canonical financial totals. Scheduled report modules resolve report/view definitions and fetch current data at execution time. The test suite covers export generation, binary email attachments, schedule formats, current-data freshness, canonical storage, reference repair, and large report pagination.

Production acceptance still requires capturing the same report/filter set from UI, CSV, XLSX, PDF, and a scheduled run and comparing authoritative totals.

## 8. Unresolved items

No known source-level FAIL item is recorded in this audit. The following are deployment gates, not completed claims:

1. production observation counters are zero
2. all active workspaces have four enabled V2 owners
3. production Yoco versus KCP financial reconciliation passes
4. ledger rebuild versus current stock balances passes
5. UI, CSV, XLSX, PDF, and scheduled output totals match for the same execution window
6. email provider delivery succeeds with current attachments

## 9. Automated validation result

The final source release passed 426 frontend/reporting tests and 39 Worker V2 tests. Worker TypeScript typecheck, frontend production build, both final static audits, and the Cloudflare deployment dry run also passed. The build retains an existing large-chunk performance warning; it does not prevent deployment.

Runtime report parity remains PENDING until a deployed environment supplies matching UI, CSV, XLSX, PDF, and scheduled results for an identical resolved period.

