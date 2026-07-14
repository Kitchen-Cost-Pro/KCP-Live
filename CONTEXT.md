# KCP Live Project Context

Last updated: 13 July 2026

## 1. Product purpose

Kitchen Cost Pro is a multi-tenant restaurant and food-service operations platform. Its core responsibilities are:

- Stock item and location management
- Supplier management
- Purchase orders, GRVs, and credit notes
- Manual adjustments and wastage
- Internal and external stock transfers
- Stock takes
- Recipes, sub-recipes, menu costing, and manufacturing
- Yoco catalogue, sales, refunds, modifiers, and stock depletion
- Operational, financial, inventory, purchasing, audit, and advanced reporting
- Saved report views, scheduled reports, email delivery, and exports
- Workspace users, roles, permissions, and the system admin portal

The application is designed for multiple workspaces and multiple locations within each workspace.

## 2. Active architecture

KCP is Cloudflare-first.

### Frontend

- Vite JavaScript application under `src/`
- Hosted on Cloudflare Pages
- Calls the Worker through `src/services/cloudflareApi.js`
- Uses Worker-issued bearer sessions stored by the frontend session service
- Does not read or write D1 or Durable Object storage directly

### API and shared control plane

- Active Worker package: `cloudflare-v2/`
- Entry point: `cloudflare-v2/src/index.ts`
- Shared binding: `CENTRAL_DB`
- Central data includes users, password/session state, workspaces, memberships, admin records, registration requests, invitations, and cross-workspace coordination
- Central schema changes are managed by `cloudflare-v2/migrations/`

### Tenant data plane

- Durable Object class: `WorkspaceDO`
- One object is addressed by each workspace ID
- Each object owns isolated SQLite storage
- Tenant migrations are applied automatically from `cloudflare-v2/src/tenant-migrations.ts`
- The D1-compatible facade in `cloudflare-v2/src/d1-facade.ts` allows the ported route handlers to run against Durable Object SQLite

### Ported active routes

`cloudflare-v2/src/legacy/` is active production code. It contains the route handlers ported from the previous backend structure. The directory must not be treated as dead code merely because it is named `legacy`.

### Retired stack

Firebase Functions, Firestore rules, Realtime Database rules, and Firebase deployment configuration are not part of this clean release. New work must not reintroduce Firebase runtime or deployment dependencies.

## 3. Request and authorization flow

1. The browser authenticates through `/api/auth/*` on the Worker.
2. The Worker validates credentials, Turnstile where required, and the central session.
3. Central routes run against `CENTRAL_DB`.
4. Workspace routes match `/api/workspaces/:workspaceId/*`.
5. The front Worker confirms workspace access and permissions centrally.
6. The Worker forwards the request to `WorkspaceDO(workspaceId)` with a server-generated auth context.
7. The Durable Object executes the tenant route against its own SQLite database.

Never trust workspace identity, role, location access, or user identity solely from browser payloads.

## 4. Tenant and location model

- A workspace represents one customer business profile.
- Locations represent operational or selling locations inside that workspace, such as Main Store, a bar, a food truck, a counter, or a storage location.
- A permanent default location must exist and acts as the fallback for imports and receiving.
- Stock, costs, thresholds, and reporting must preserve location granularity.
- Location access restrictions must be enforced for every user and every route.
- The canonical workspace location record is the source of truth for customer-facing names.
- Yoco or other integration IDs may be stored as references, but technical IDs such as `loc_*`, UUIDs, source keys, or integration identifiers must never be shown as the location label when a canonical name can be resolved.
- Custom location names take priority over integration names.
- Reports, dashboards, exports, schedules, transaction drawers, notifications, and filters must all use the same location-name resolver.

## 5. Stock and costing rules

### Stock source of truth

Operational stock movements must be written to the standard movement ledger. The ledger is used for detailed activity, reconciliation, reporting, dashboards, and transaction drill-downs.

Expected movement fields include:

- `workspace_id`
- `location_id`
- `item_id`
- `category_id`
- `movement_date`
- `movement_type`
- `source_type`
- `source_id`
- `document_number`
- `qty_in`
- `qty_out`
- `net_qty`
- `base_uom`
- `unit_cost_ex_vat`
- `movement_value`
- `created_by`
- `created_at`
- `notes`
- `metadata`

Core formulas:

```text
net_qty = qty_in - qty_out
movement_value = net_qty * unit_cost_ex_vat
```

### Required movement sources

The ledger must cover at least:

- GRV receipt
- Purchase-order receipt where applicable
- Credit-note return/out
- Manual adjustment
- Wastage adjustment
- Manufacturing input
- Manufacturing output
- Manufacturing wastage
- Stock-take variance
- Transfer out
- Transfer in
- Sale usage
- Modifier usage

Writes must be idempotent. A repeated webhook, retry, or schedule must not duplicate a movement.

### Units of measure

- Inventory is stored in the base UOM.
- Ordering, receiving, stock counting, scanning, and custom UOMs must convert to the base UOM at write time.
- A stock item can define a base UOM and up to three custom UOMs with conversion ratios and optional barcodes.

### Costing

- Supported workspace costing modes include Last Received Price and Weighted Average Cost.
- Costs are location-specific.
- A GRV updates the cost of the receiving location, not every location.
- Recipes and reports must read the applicable location cost.
- Currency is displayed in South African Rand. Internal minor-unit storage is acceptable when consistently converted at boundaries.

### Stock take versus wastage

Stock-take variance is inventory variance. It must not be classified as wastage.

## 6. Core workflow rules

### Purchase orders

- Purchase orders support supplier, location, stock item, UOM, quantity, and pack-size selection.
- A stock item is not restricted to a saved supplier or source location; the supplier is selected when the purchase order is created.
- Explicitly selected orderable items must remain in the PO seed even when stock is above par. Where no calculated reorder quantity exists, use a safe default quantity of one for the user to edit.
- Manufactured goods can be reported as low stock but are not orderable and must not be selectable for a purchase order.
- Supplier-facing PDFs must stay clean and must not expose internal status or unnecessary costing fields when the document is intended only for the supplier.

### GRV

- GRVs can receive directly or from a purchase order.
- A line can be split across locations.
- Receiving converts entered UOM quantities to base stock quantities.
- A committed GRV must write stock, cost, transaction references, source documents, and ledger rows consistently.

### Credit notes

- Credit notes return stock to suppliers or record the relevant outbound correction.
- Transaction summaries and exports must reconcile with the movement ledger.

### Transfers

- Internal transfers write matched transfer-out and transfer-in movements.
- External transfers retain the external destination site/workspace name after acceptance.
- Destination validation is line-specific. A broad destination error must not be shown when only one line is missing routing data.

### Manufacturing

- Manufacturing consumes component stock and adds produced stock.
- Actual yield and wastage must be recorded separately and correctly.
- Sub-recipes must not be double-counted when recipes are exploded.

### Stock items and sub-recipes

- Duplicate item names are blocked case-insensitively.
- `Sub-Recipe` is a distinct stock-routing tag.
- Sub-recipes do not behave like ordinary orderable stock items.
- SKU, barcodes, UOMs, category, supplier, and location values must survive imports and exports.

## 7. Yoco integration rules

- Live webhooks are the primary sales and refund ingestion path.
- Scheduled or manual sync is the catch-up path.
- Reprocessing must be idempotent.
- Catalogue sync must update or match existing Yoco locations and items rather than duplicate them.
- Sales deduct stock only from the correctly resolved location.
- Refunds restore stock to the corresponding location.
- Modifier stock is deducted only when the modifier is mapped to stock or recipe usage.
- Sale and modifier usage must write ledger rows.
- VAT, gross, net, tips, refunds, and payout totals must use the actual Yoco data and workspace tax configuration. Tips are non-taxable; Payment Summary Gross is the bill value excluding tips, Net is bill value excluding VAT, and Payout is Net Sales plus Tips less Refunds and Fees. Refunds remain a separate VAT-exclusive deduction for payout reconciliation, while gross refund and VAT metadata remain available internally.
- Webhook signature validation must be performed by the Worker using server-side secrets.
- Integration IDs are never acceptable customer-facing labels.

## 8. Reporting system

The reporting module lives under `src/modules/reporting/` and uses Worker-backed data sources.

Main report families include:

- Detailed Activity
- Operations Dashboard
- Wastage
- Stock Take Audit
- Adjustments
- Stock Transfers
- Sales Payment Summary
- Sale Stock Movement
- Modifier Report
- Menu and Recipe Health
- Stock Control
- Inventory Audit
- Stock on Hand
- Purchase Orders
- GRV Log
- Credit Notes
- Manufacturing Transactions
- Stock-Out Forecast
- Price Volatility Analysis
- Theoretical versus Actual

Reporting requirements:

- Use real tenant data; never silently fall back to mock data.
- Calculations and totals must be deterministic and reconcilable.
- Time values must use the workspace timezone, with South African workspaces normally using `Africa/Johannesburg`.
- Large sources must use server-side pagination or partitioning without producing incomplete totals.
- Page-size controls support practical customer sizes such as 25, 50, and 100 rows.
- CSV, XLSX, and PDF exports must use the same filtered dataset and formulas as the screen.
- PDF exports must be readable, concise, and transaction-focused.
- Transaction IDs must remain visible in report tables and open a drill-down drawer.
- Transaction drawers should show concise customer-facing summaries, line items, and references; do not expose a large generic metadata grid.
- The transaction-ID column should remain sticky while the table body scrolls horizontally.
- Saved views are scoped correctly to the user or workspace.
- Scheduled reports must resolve current views, current location names, active workspace recipients, and fresh data at execution time.
- Scheduled report-pack creation uses three explicit stages: select reports, review reports in the pack, then select views for each report.
- Scheduled XLSX and PDF delivery combines all selected views for the same report and location into one attachment. CSV remains a per-view format.
- Scheduled formats include CSV, XLSX, and PDF where supported.
- Report and schedule date ranges default to Today unless a saved schedule or saved view explicitly stores another range.
- Broad Critical Data Quality banners are not shown. Customer-facing data-quality guidance is attached to the affected rows and limited to issues the customer can act on, such as missing price, missing recipe, missing location, or low stock.
- Every report table column exposes a concise hover and keyboard-focus tooltip. Formula columns should describe the calculation; all other columns use a safe descriptive fallback.
- Wastage reporting separates stock-item wastage from product/menu-item wastage. Product wastage is grouped at the product event level so ingredient ledger lines do not multiply the recorded menu-item quantity.
- Internal ingestion defects must be logged for administrators rather than presented as impossible customer tasks.

## 9. Dashboard rules

- Dashboard data must come from the current Worker/Durable Object data contract.
- Location selection applies consistently to every KPI, alert, chart, and inventory row.
- Low-stock warnings are evaluated per location, not by combining unrelated location balances.
- The notification bell opens the stock notification centre and must respect the selected location and user permissions.
- Dashboard refreshes must be deliberate. Do not introduce full-page reload loops or broad polling that resets the current tab.
- Client GET caching and in-flight request deduplication are intentional performance protections.

## 10. Permissions and admin portal

- Workspace authorization is enforced server-side.
- Superusers retain access to all appropriate administrative and reporting actions.
- Managers and permitted roles can access report scheduling according to the configured permission keys.
- Restricted users only see allowed locations.
- The admin portal uses the same central D1 identity and workspace registry as the main application.
- Admin actions that operate on tenant data must fan out to the relevant `WorkspaceDO`; tenant tables do not live in `CENTRAL_DB`.
- Never run tenant-table SQL directly against the central database.

## 11. UI and accessibility rules

- Light and dark themes must maintain readable contrast across the entire app.
- Customer background images may remain visible, but cards, navigation, tables, controls, placeholders, focus states, toasts, and modals must remain legible.
- Prefer the shared custom dropdown pattern where native controls clip, render behind drawers, or fail theme contrast.
- Modals and drawers must render above validation errors, dropdowns, and action menus.
- Only the intended table container should scroll horizontally; the whole page should not.
- Tables and action columns must not clip menus behind adjacent surfaces.
- Use concise customer-facing labels. Do not display raw database IDs as names.

## 12. Engineering rules

- Do not add a second data-access layer when an existing Worker route or shared service can be extended.
- Do not calculate business-critical totals differently in the UI and API.
- Do not duplicate report mappers, location resolvers, timezone logic, or transaction-reference logic.
- Do not add mock data to production paths.
- Do not hide warnings to make tests pass; fix the source write or classification.
- Do not add direct D1 access to the browser.
- Do not add new Firebase dependencies.
- Preserve idempotency for webhooks, imports, scheduled jobs, and transaction writes.
- Keep secrets out of source and logs.
- Use `npm ci` and committed lockfiles.
- Run `npm run check:hardening` before a release.
- Remove generated `dist/`, `.wrangler/`, `node_modules/`, coverage, patches, audit dumps, and scratch files before packaging.

## 13. Current release baseline

The current clean baseline includes:

- Cloudflare Worker authentication and central D1 identity management
- Per-workspace SQLite Durable Object tenancy
- Main application and admin portal wired to the current data model
- Full reporting registry, exports, saved views, scheduling, and transaction drill-downs
- Three-step scheduled-report creation with a two-column report selector, per-report view selection, report tooltips, workspace-user recipient selection, and combined XLSX/PDF attachments
- Stable dashboard loading and notification-centre behaviour
- Theme contrast improvements across light and dark modes
- Canonical location-name resolution across dashboard, reporting, exports, schedules, transactions, and permissions
- External transfer destination display after acceptance
- Transaction-focused PDF exports and sticky transaction-ID columns

## 14. Release checklist

Before delivery:

```bash
npm ci
npm --prefix cloudflare-v2 ci
npm run check:hardening
./scripts/reset-deploy-state.sh
```

Then confirm:

- Only `README.md` and `CONTEXT.md` remain as project documentation.
- No secrets or local environment files are included.
- No Firebase deployment source or configuration is included.
- No generated build or Wrangler state is included.
- The ZIP opens with a single project root directory.

## Phase 44 refinements (July 2026)
- Dashboard defaults to Today and includes Today, This Week, and 2 Weeks presets; the dashboard SKU/item search was removed and refresh is a labelled pill.
- Stock item SKU values are editable and shown as SKU - Product Name.
- Purchase-order PDF lines now show Product Name, UOM/Custom UOM, and Quantity only.
- Gmail connection prompt CTA text is explicitly visible.
- PO-linked credit notes cannot exceed original ordered quantities; product wastage validates all required inputs before save.
- Scheduled report-pack selection is report-only and presented in a two-column list, using each report's default/current selected view internally.

## Phase 45 reporting and scheduling refinements (July 2026)
- Report-pack creation is a three-step flow: select reports, review the pack, and choose views inside each selected report.
- Report cards are arranged in two columns, act as view-selection buttons, and expose the same explanatory tooltips used elsewhere in scheduling.
- Active workspace users are available in a recipient dropdown, while manually entered recipient emails remain supported. Email subject and message fields were removed.
- Scheduled XLSX and PDF output combines all selected views for each report and location into one attachment.
- Date ranges default to Today and use consistent relative labels, including Last 2 Days, Last 1 Week, and Last 2 Weeks.
- Schedule row actions use compact start, edit, duplicate, and delete icons.
- Payment Summary excludes tips from taxable Gross, reports Net after VAT, calculates Payout as Net Sales plus Tips less Refunds and Fees, with refunds kept as a separate VAT-exclusive deduction.
- Modifier GP by Menu Item uses total menu-item revenue and total stock cost, including both base recipe and modifier cost.
- Report tables use theme-matched headers, aligned numeric columns, and an upward-opening pagination selector to prevent edge clipping.

## Phase 46 reporting usability and stock-control refinements (July 2026)
- All report columns now use shared hover and keyboard-focus tooltips, including calculation details for known formulas and descriptive fallbacks for every other column.
- Wastage and Adjustments include Source and Menu Items views, separating stock-item wastage from product/menu-item wastage. Product events aggregate their ingredient lines without multiplying the recorded product quantity.
- The shared transaction drawer no longer renders the oversized metadata grid, so all transaction types present a focused end-user summary.
- Stock Control no longer presents Top Supplier, supplier grouping, supplier filters, or supplier-only warnings. Items can be ordered through any chosen supplier.
- Manufactured goods remain visible in low-stock results but cannot be selected for purchase orders. Explicitly selected orderable items are included even above par, defaulting to quantity one where no reorder quantity exists.
- Broad Critical Data Quality banners are removed globally; relevant row-level warnings remain.
- Validation completed with 363 passing tests, a successful production frontend build, a successful Worker TypeScript check, and a successful Wrangler deployment dry run.

## Phase 47 personal settings, ordering UOM, and reporting UI refinements (July 2026)
- Restaurant theme, restaurant background, and UI scale are personal workspace-member preferences. They must not be written as shared workspace settings. Workspace logo and business identity remain shared workspace settings.
- Personal settings are stored in `workspace_members.user_preferences_json` and read/written through authenticated `user-preferences` workspace routes.
- Low Stock Summary and Alert Time are not customer-facing Business Settings controls. The create-user flow does not expose the Low Stock Email selector.
- A Yoco personal API key is fingerprint-locked to its workspace. Customer connection requests cannot replace a different locked key; KCP admin replacement is explicit, and workspace disconnect requires the superuser role.
- Report custom-select menus are body-portalled, fixed-position, viewport-aware overlays. They must remain above report cards, modals, drawers, pagination, and table borders.
- Every stock item can designate one Custom UOM as its default ordering UOM. When none is selected, Base UOM remains the default. PO, GRV, credit-note, and reporting PO seeds must preserve this preference.
- The stock XLSX import includes `Default_Ordering_UOM`. Its dropdown is row-scoped and may contain only that row’s Base UOM and configured UOM 1–3 names; imports reject values not configured on the same row.
- The Stock Control quick Create PO action is visible only for low/critical/below-par rows. Manual bulk selection can still include orderable non-low-stock items, while manufactured items remain non-orderable.
- Scheduled-report recipients are sourced from current non-removed workspace memberships. Report-pack view selection stays compact and schedule actions use green Run, yellow Edit, blue Copy, and red Delete treatments.
- Report title/header surfaces use the same themed treatment as report-table headers; pagination selectors must have sufficient width and must not clip.
- Missing-name warnings must recognise menu-item names and should not show “missing item name” where a customer-facing product/menu name exists.

## Phase 48 Gmail OAuth tenant-routing fix (July 2026)
- `/api/gmail/oauth/callback` is a global provider callback, but workspace Gmail credentials are tenant data stored in `workspace_settings` inside the workspace Durable Object.
- The front Worker must decode the workspace ID from the signed OAuth state only to choose the target `WorkspaceDO`, then forward the untouched callback request to the internal `gmail-oauth-callback` resource.
- The tenant handler verifies the state HMAC before exchanging tokens or accessing `workspace_settings`; never query `workspace_settings` through `CENTRAL_DB`.
- The internal callback resource is restricted to the server-injected `gmail-oauth-callback` principal.
- `system:` Gmail OAuth states remain on the central admin Gmail callback path.
- This fix requires no schema migration.

## Phase 49 preferences, dropdown, and reporting-shell fixes (July 2026)
- The authenticated `GET` and `PATCH` user-preference routes must tolerate a central D1 deployment where `workspace_members.user_preferences_json` is missing. They perform a guarded schema check and add the JSON column with an empty-object default. Standard central migrations should still remain current, but a skipped preference migration must not produce a customer-facing 500.
- Shared report and scheduling custom selects are body-portalled overlays. An open portal menu must explicitly render, stay above all report/schedule surfaces, dispatch the native select `change` event, and close on selection, outside click, Escape, resize, or scroll.
- Report filter menus use fixed viewport-aware positioning and must not be clipped by a report card, table, footer, pagination surface, or modal boundary.
- `Default_Ordering_UOM` is the last field in stock XLSX import/export schemas. Row-scoped validation remains derived from the actual column position and each line item's Base UOM plus UOM 1–3 names.
- Reporting uses the normal application navigation and main pane. Reporting dashboard, report viewer, report home, and scheduling backgrounds are transparent so the standard app background remains visible.
- Report-pack view selection is a single vertical column. Schedule row actions remain centered beneath the Actions heading and are visually differentiated: Run green, Edit yellow, Copy blue, Delete red.
- Pagination rows-per-page controls must be wide enough for the complete value and chevron and remain fully interactive.
- Phase 49 validation baseline: 377 passing tests, successful production frontend build, successful Worker TypeScript check, and successful Wrangler deployment dry run.

## Phase 50 user-preference and dropdown reliability fix (July 2026)

- Personal UI preferences must not depend on `workspace_members`. Owners and KCP superusers may have valid workspace access without a membership row, so theme/background/UI-scale data is stored in central `user_preferences`, keyed by the authenticated principal.
- `GET` and `PATCH /api/workspaces/:workspaceId/user-preferences` still call workspace access validation first, but must never return a membership-not-found error after access has been established.
- The route self-creates `user_preferences` for deployment resilience and migration `0004_user_preferences.sql` remains the canonical schema change. Legacy `workspace_members.user_preferences_json` is read only as a migration fallback.
- All reporting-native selects use a single body portal (`report-enhanced-select-portal`). The portal owns option events, dispatches native `input` and `change` events, supports keyboard selection, stays above report and schedule surfaces, and repositions on viewport scrolling.
- Scrolling inside a dropdown must never close it. Do not reintroduce a capture-phase document scroll handler that closes the active menu or call `scrollIntoView` during menu opening.
- Report filters render actual `<select>` fields and are enhanced by the same shared control used by scheduling and pagination. Do not maintain a second report-filter dropdown implementation.
- Phase 50 validation baseline: 377 passing tests, browser-level dropdown interaction checks, successful production frontend build, successful Worker TypeScript check, and successful Wrangler deployment dry run.

## Phase 51 legal-settings and payment-column rules (July 2026)

- The Legal Details / Company Tax Information panel must expose its own `Save Legal Details` action. It reuses the standard Business Settings save handler so all legal fields are persisted together with the current settings draft.
- Payment Summary must be readable as a left-to-right reconciliation: `Gross Sales - VAT = Net Sales`, followed by `Net Sales + Tips - Refunds - Fees = Payout Amount`.
- In Payment Summary, refund values used for payout arithmetic are VAT-exclusive. Preserve gross refund and refund VAT metadata for internal reconciliation, but do not double-count refund rows inside Net Sales.
- Payment Summary view and export order is: Gross Sales, VAT, Net Sales, Tips, Refunds, Discounts, Fees, Payout Amount. Identifier columns remain before these financial columns and count/status columns remain after them.
- Phase 51 validation baseline: 381 passing tests, successful production frontend build, successful Worker TypeScript check, and successful Wrangler deployment dry run.


## Phase 52 stock-take draft and legal-details rules (July 2026)

- Saving a structured Stock Take draft must persist first, then set `sessionActive` to false, replace or prepend the returned draft in `savedDrafts`, clear overlays and open dropdown state, and render the launchpad immediately. Never require a browser reload to expose the saved draft.
- While a draft save is pending, the Save Draft control must be disabled to prevent duplicate requests.
- Legal Details saves one complete Company Tax Information object assembled from every visible legal field. A single edited field must never overwrite or delete the remaining legal data.
- The dedicated legal save must not depend on personal-preference persistence or location-name synchronisation.

## Phase 53 reliable dropdown top-layer rules (July 2026)

- Application dropdown menus must stay under their original component node. Do not move component-owned menus into `document.body`, because doing so breaks scoped selectors, inherited variables, delegated events, form ownership, and searchable option lists.
- Use a manual Popover when supported to place the existing menu in the browser top layer. The fallback may use in-place fixed positioning but must not reparent the menu.
- Store and restore each menu's original inline style, hidden state, and Popover attribute. Outside click and Escape must close the owning control and return focus safely.
- Dropdown placement is viewport-aware, supports upward opening, and uses important fixed coordinates above modal and table stacking contexts.
- Reporting, scheduling, saved-view, recipient, and pagination selects may continue to use their shared body menu, but calculated `top` and `left` values must be inline important so legacy `inset: auto !important` declarations cannot override them.

## Phase 54 Stock Take active-session table rules (July 2026)

- The inactive Stock Take launchpad contains exactly the three primary actions: Start Session, Quick Count, and Bulk Scan.
- Saved Stock Take drafts are active sessions and render inline beneath those actions, not in a modal. The table columns are Session Template, Date, and Actions.
- Active sessions are ordered newest first. Each row shows the session/template identity, location and line count, trade date and saved date, plus Resume and Discard actions.
- Resume hydrates the selected draft into the active session. Discard removes the selected draft from `savedDrafts` immediately after successful deletion. Neither operation may reload the page.
- The desktop table is scrollable with sticky headings. On smaller screens, rows adapt into readable cards while preserving both row actions.
- The legacy Resume Draft launch button, `resume-drafts` overlay, and generic restore-modal handler must not be reintroduced.
- Phase 54 validation baseline: 390 passing tests, successful production frontend build, successful Worker TypeScript check, and successful Wrangler deployment dry run.

## Phase 55 Stock Take draft-save and dashboard-dropdown rules (July 2026)

- `renderApp()` intentionally does not replace the application DOM while a text input, textarea, or select is active. Any action that must close an active Stock Take session after an asynchronous save must therefore clear queued focus and blur the current field before the pending render and again before the completion or error render.
- A Stock Take draft save is single-flight. While `actionStatus` is `saving-draft`, additional submissions are ignored and both Save Draft and Commit Stock Take remain disabled.
- Shared application dropdowns must close after the target's own `click` handler runs, not during capture-phase `pointerdown`. Closing earlier can re-render the owning component and remove a Stock Take action button before its click is delivered. After restoring the top layer, the former trigger may be clicked to synchronise component state only when its original root and trigger remain connected and that root still reports itself open; an unguarded synthetic click can reopen a menu that another control already closed.
- Draft IDs are stable across retries. A response timeout or user retry must reuse the same draft ID rather than create duplicate Active Sessions.
- Draft saves have an explicit request deadline. A timeout must clear `saving-draft`, preserve the current count session, and show a recoverable error instead of leaving the button pending forever.
- Existing tenant Durable Objects must receive append-only migration 15, which creates `stocktake_drafts` and `idx_stocktake_drafts_workspace_user`; changing the generated baseline alone does not upgrade previously provisioned workspaces.
- Successful draft persistence closes the session and updates `savedDrafts` immediately. Failures keep the current session and counts intact and must produce visible inline and toast feedback.
- The authenticated Worker identity is the only authority for Stock Take draft ownership. Browser query, payload, and legacy path user IDs must not select another user's drafts.
- Main Dashboard custom-select fields have deterministic widths. An open Location or Date Range menu is measured from its trigger, assigned an exact pixel width before paint, constrained to the viewport, and recalculated while open on resize.
- Do not restore `width: max(100%, 220px)` or another percentage-based minimum on an absolutely positioned Dashboard menu inside an auto-sized flex item; this can expand the first-open menu against the whole filter row.
- Phase 55 validation baseline: 397 passing tests, successful production frontend build, successful Worker TypeScript check, and successful Wrangler deployment dry run.

## Phase 57: Whole-hour reporting boundaries

- Business Settings now exposes **Reporting Day Hours** as whole-hour **From** and **To** selectors.
- Reporting days remain fixed 24-hour windows, so both selectors stay aligned (for example, 07:00 to 07:00 next day).
- Minute-level boundaries cannot be selected or persisted. Legacy `tradingTime` values are migrated to the equivalent next whole-hour boundary.
- Interactive reports, exports, dashboards, and scheduled reports continue to consume the shared `tradingDayStartMinutes` value.


## Phase 58 — Reporting Hours UI and Go Live Hardening
- Reporting Day Hours now uses inline, custom whole-hour dropdowns and spans the workspace settings panel cleanly.
- From and To remain locked to the same 24-hour boundary.
- Go Live is disabled until Products, Recipes, and Locations are present and shows a saving state.
- Go Live now records an activation timestamp. All webhook and manual Yoco sales processing honors the workspace setting, ignores pre-activation sales, and refuses to restore refunds unless the original sale was depleted.

## Phase 59 report-action and stock-SKU rules (July 2026)

- Report export/download actions must render before saved views inside every report Actions menu.
- Visible-column configuration remains below saved views but is wrapped in a collapsed `<details>` section by default. Opening the Actions menu must not immediately display the full checkbox grid.
- Stock-item SKU normalization has one rule: an explicit user/import SKU is preserved exactly after trimming; a blank SKU becomes `SKU - ${Item Name}`.
- Do not append the item name to an explicit SKU in the Stock Items table or report output.
- Apply the fallback to new saves, imports, legacy blank records returned by the Worker, dashboard inventory rows, Stock on Hand reporting, exports based on normalized stock items, and linked-workspace transfer stock data.
- Phase 59 validation baseline: 411 passing tests, successful production frontend build, successful Worker TypeScript check, and successful Wrangler deployment dry run.
