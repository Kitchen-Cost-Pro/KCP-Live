# KCP Live Project Context

Last updated: 12 July 2026

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
- VAT, gross, net, and payment totals must use the actual Yoco data and workspace tax configuration.
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
- The transaction-ID column should remain sticky while the table body scrolls horizontally.
- Saved views are scoped correctly to the user or workspace.
- Scheduled reports must resolve current views, current location names, and fresh data at execution time.
- Scheduled formats include CSV, XLSX, and PDF where supported.
- Customer-facing data-quality warnings are limited to issues the customer can act on, such as missing price, missing recipe, missing location, or low stock.
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
- Simplified scheduled-report creation with a separate report-and-view selector, stepped delivery configuration, and theme-matched scheduling panels
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
