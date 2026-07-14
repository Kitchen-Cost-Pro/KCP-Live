# Kitchen Cost Pro (KCP Live)

Kitchen Cost Pro is a multi-location stock, purchasing, recipe-costing, manufacturing, sales-integration, and reporting platform for food-service businesses.

This repository is the clean Cloudflare production source. It does not require Firebase at runtime and it does not include the retired Firebase Functions, Firebase rules, phase notes, audit text files, patch files, or generated deployment state from earlier migration builds.

## Active stack

| Layer | Technology |
| --- | --- |
| Frontend | Vite, JavaScript ES modules, HTML, CSS |
| Hosting | Cloudflare Pages |
| API | Cloudflare Worker (`cloudflare-v2`) |
| Shared control plane | Cloudflare D1 (`CENTRAL_DB`) |
| Workspace data | One SQLite-backed Durable Object per workspace (`WorkspaceDO`) |
| Authentication | Worker-issued sessions stored and validated through the central data plane |
| Bot protection | Cloudflare Turnstile |
| Reporting/export | Chart.js, ExcelJS/XLSX, jsPDF, jsPDF-AutoTable |
| POS integration | Yoco API and webhooks |

The frontend must call the Worker API. It must not access D1 or Durable Object storage directly.

## Repository layout

```text
.
├── src/                    Frontend application and reporting module
├── public/                 Static assets, Pages routing, and admin console shell
├── cloudflare-v2/          Active Cloudflare Worker API
│   ├── migrations/         Central D1 migrations
│   ├── src/index.ts        Front Worker and central routing
│   ├── src/workspace-do.ts Per-workspace Durable Object
│   └── src/legacy/         Ported route handlers still used by the active Worker
├── scripts/                Build and local cleanup helpers
├── CONTEXT.md              Product, data, and engineering rules
├── package.json            Frontend commands
└── vite.config.js          Vite configuration
```

`cloudflare-v2/src/legacy/` is an active compatibility layer containing the ported application routes. The directory name describes their origin, not their deployment status. Do not remove it unless the routes have first been migrated and replaced.

## Requirements

- Node.js with npm
- A Cloudflare account with Workers, Pages, D1, Durable Objects, and Turnstile enabled
- Access to the configured KCP Cloudflare resources

Use the committed lockfiles and `npm ci` for reproducible installs.

## Local setup

Install both packages:

```bash
npm ci
npm --prefix cloudflare-v2 ci
```

Create the frontend environment file:

```bash
cp .env.example .env
```

For a completely local stack, set:

```dotenv
VITE_CLOUDFLARE_API_URL=http://127.0.0.1:8787
```

To run the frontend against the deployed API instead, set the deployed Worker URL.

Create local Worker secrets:

```bash
cp cloudflare-v2/.dev.vars.example cloudflare-v2/.dev.vars
```

Never commit `.env`, `.dev.vars`, API keys, OAuth client secrets, encryption secrets, or session tokens.

### Start the Worker

For a new local D1 database, apply the central migrations first:

```bash
cd cloudflare-v2
npx wrangler d1 migrations apply kcp_central --local
npm run dev
```

The Worker normally runs at `http://127.0.0.1:8787`.

Workspace Durable Object databases migrate automatically when their `WorkspaceDO` instance starts.

### Start the frontend

In a second terminal:

```bash
npm run dev
```

The Vite development server normally runs at `http://localhost:5173`.

## Current Yoco recovery behavior

- Initial connection imports the Yoco catalogue only and records a sales baseline. Historical orders are not deducted.
- The live subscription uses `order.completed` for sale deduction and `payment.refunded` for refund processing. `payment.created` is not treated as a final stock trigger.
- Completed-order reconciliation queries `closed_at`, `updated_at`, and `created_at`, then combines those results with stored webhook order and payment references.
- Full order detail and line items are required before deduction. Order API failures and empty-line orders remain visible and retryable.
- Customer Integrations has no manual sales-sync action. Admin Console provides explicit 2-day and 14-day reconciliation with readiness and API diagnostics.
- After deploying webhook changes, run **Restart Sync** and then **Reconcile Sales - 2 Days**.
- Detailed findings are in `YOCO_INTEGRATION_AUDIT.md`.

## Validation

Run the full release check:

```bash
npm run check:hardening
```

That command runs:

1. Frontend and reporting tests
2. Production frontend build
3. Worker TypeScript validation
4. Wrangler deployment dry run

Individual commands:

```bash
npm test
npm run build
npm --prefix cloudflare-v2 run typecheck
npm --prefix cloudflare-v2 run deploy:dry
```

## Deployment

Deploy the API before the Pages frontend so both use the same request and reporting contracts.

### 1. Apply central D1 migrations

Back up production data before schema changes, then run from `cloudflare-v2`:

```bash
npx wrangler d1 migrations apply kcp_central --remote
```

### 2. Deploy the Worker

```bash
npm --prefix cloudflare-v2 run deploy
```

### 3. Build and deploy Pages

```bash
npm run build
```

Deploy `dist/` through the configured Cloudflare Pages project or CI pipeline.

## Configuration

### Frontend variable

| Variable | Purpose |
| --- | --- |
| `VITE_CLOUDFLARE_API_URL` | Base URL of the KCP Worker API |

### Worker bindings

Configured in `cloudflare-v2/wrangler.toml`:

| Binding | Purpose |
| --- | --- |
| `CENTRAL_DB` | Shared D1 database for identities, sessions, workspaces, memberships, admin data, and cross-workspace coordination |
| `WORKSPACE` | Durable Object namespace; one SQLite database is addressed by workspace ID |

### Worker secrets

Set production secrets with `wrangler secret put`. Depending on enabled features, the Worker can use:

- `TURNSTILE_SECRET_KEY`
- `YOCO_KEY_ENCRYPTION_SECRET`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_TOKEN_ENCRYPTION_SECRET`
- `GMAIL_OAUTH_STATE_SECRET`
- `GDRIVE_CLIENT_ID`
- `GDRIVE_CLIENT_SECRET`
- `GDRIVE_TOKEN_ENCRYPTION_SECRET`
- `GDRIVE_OAUTH_STATE_SECRET`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `GROQ_API_KEY`
- `ADMIN_API_TOKEN` only while the temporary bridge remains enabled

List configured secrets without exposing their values:

```bash
cd cloudflare-v2
npx wrangler secret list
```

## Runtime architecture

```text
Browser
  -> Cloudflare Pages
  -> Cloudflare Worker
       -> CENTRAL_DB (shared identity and registry data)
       -> WorkspaceDO(workspaceId)
            -> isolated SQLite tenant data
       -> Yoco / Gmail / Drive / email providers where configured
```

The front Worker handles central authentication, admin routes, security configuration, webhooks, workspace resolution, and authorization. Authenticated workspace requests are forwarded to the correct `WorkspaceDO` with a server-resolved identity. The Durable Object executes the tenant routes against that workspace's isolated SQLite database.

## Phase 48 Gmail OAuth callback fix

- Workspace Gmail OAuth callbacks are now routed from the global callback URL into the correct `WorkspaceDO` before reading or writing integration settings.
- The signed OAuth state is still verified inside the tenant handler; the front Worker only decodes the workspace routing hint.
- Gmail tokens and account metadata continue to live in the tenant `workspace_settings` row rather than `CENTRAL_DB`.
- The system/admin Gmail callback remains on the central admin route.
- No D1 migration is required for this fix; deploy the updated Worker and reconnect Gmail.

## Phase 47 release highlights

- Restaurant colour theme, background selection/upload, and UI scale are now stored as personal workspace-member preferences. One user changing their appearance no longer changes another user’s interface; workspace branding such as the logo remains shared.
- Low Stock Summary and Alert Time controls were removed from Business Settings, and the low-stock email assignment was removed from the create-user flow.
- Yoco personal API keys are fingerprint-locked to the workspace. A different key is rejected through the customer connection flow, key replacement is reserved for the KCP admin route, and disconnect is restricted to workspace superusers.
- Reporting dropdowns render through a viewport-aware body portal so date ranges, pagination, and other report selectors remain above tables, modals, and screen edges.
- Default Ordering UOM can be selected per stock item and is respected when PO, GRV, credit-note, and reporting-created order lines are seeded. The stock XLSX template includes a row-specific dropdown containing only that item’s Base UOM and Custom UOM values.
- Scheduling now receives the workspace user list correctly, report-pack view cards are more compact, action icons use clear green/yellow/blue/red states, and pagination controls have enough width for their values and chevrons.
- Report title/header surfaces now use the same themed blue treatment as report tables. The invalid missing-item-name warning recognises menu-item names, and the quick Create PO action is shown only on low-stock rows while manual selection remains available for orderable non-low-stock items.
- Release validation: 370 tests passed, the production frontend build passed, Worker TypeScript validation passed, and Wrangler deployment dry run passed.

## Phase 49 preferences, dropdown, and reporting-shell fixes

- Personal theme, background, and UI-scale routes now self-repair the missing `workspace_members.user_preferences_json` column when an older central D1 deployment has not yet applied migration `0003_user_preferences.sql`. The repair runs only on the authenticated personal-preference routes and tolerates concurrent requests.
- Shared reporting and scheduling custom selects were restored as body-level portal menus with explicit open-state rendering, viewport-aware placement, outside-click handling, and native `change` events. Date-range, scheduling, and rows-per-page selectors now remain interactive above tables and page boundaries.
- Report filter dropdowns use fixed top-layer positioning and automatically choose the available viewport direction instead of being clipped by report cards or pagination surfaces.
- `Default_Ordering_UOM` is the final stock import/export column. Row-specific XLSX validation continues to use only that line item's Base UOM and configured Custom UOM values.
- Reporting now uses the standard application shell: report surfaces are transparent, and the main navigation no longer switches to the reporting-only dark navy treatment.
- Scheduled report view selection is a compact single-column vertical list. Run, Edit, Copy, and Delete actions are aligned under the Actions column and use green, yellow, blue, and red treatments respectively.
- The rows-per-page selector has a wider pill so its value and chevron display cleanly.
- Release validation: 377 tests passed, the production frontend build passed, Worker TypeScript validation passed, and Wrangler deployment dry run passed.

## Phase 50 user-preference and dropdown reliability fix

- Personal appearance and UI-scale settings are now stored in a dedicated central `user_preferences` table keyed to the authenticated person, rather than requiring a `workspace_members` row. Workspace access is still checked before the route can be used.
- Workspace owners and KCP superusers can save personal settings even when they do not exist as ordinary workspace members. The previous `Your active workspace membership was not found` 404 path has been removed.
- Existing `workspace_members.user_preferences_json` values are read once as a compatibility fallback and migrated into the personal preference record automatically.
- Migration `cloudflare-v2/migrations/0004_user_preferences.sql` is included. The authenticated route also creates the table safely on an older deployment, so a skipped migration does not block the user.
- Reporting filters, scheduling selectors, saved-view selectors, recipient selectors, and report pagination now use one shared body-level select portal. Only one menu is active at a time, it remains above modals and tables, and it repositions on page scroll instead of closing when the user scrolls the option list.
- Report filter dropdowns now use the same native-select-backed control as scheduling and pagination, removing the separate fixed-position dropdown implementation that caused inconsistent clipping and interaction failures.
- Validation: 377 automated tests passed, direct browser interaction tests passed for pagination, scheduling-style selectors, and report filters, the production frontend build passed, Worker TypeScript validation passed, and Wrangler deployment dry run passed.

## Phase 51 legal-settings and Payment Summary refinements

- Legal Details now has a dedicated **Save Legal Details** button inside the Company Tax Information panel. It uses the existing Business Settings save pipeline and displays the shared saving state.
- Payment Summary payout is calculated and described consistently as **Net Sales + Tips - Refunds - Fees**.
- Refunds used in payout arithmetic are VAT-exclusive, while the original gross refund and refund VAT remain available on the normalized transaction record for reconciliation.
- Payment Summary columns and exports now read left-to-right as Gross Sales, VAT, Net Sales, Tips, Refunds, Discounts, Fees, and Payout Amount across Daily Summary, By Payment Method, By Location, and Transaction Detail.
- Validation: 381 automated tests passed, the production frontend build passed, Worker TypeScript validation passed, and Wrangler deployment dry run passed.


## Phase 52 stock-take draft and legal-details reliability

- Saving a structured Stock Take draft now persists the draft, exits the active session, resets the session UI, and publishes the saved draft into the Stock Take launchpad state without a page reload.
- Legal Details saves the complete visible Company Tax Information object atomically. Editing one field no longer replaces the other legal fields, and the legal save does not wait for unrelated personal-preference or location-name updates.
- Duplicate Stock Take draft submissions are blocked while the save is in progress.

## Phase 53 reliable dropdown top layer

- Application dropdown menus remain inside their owning component in the DOM so scoped styles, inherited theme variables, search fields, form ownership, and delegated click handlers continue to work.
- Open application menus use the browser Popover top layer with fixed, viewport-aware placement. They escape modal and table clipping, open upward when required, and restore their original state when closed.
- Reporting, scheduling, and pagination selects apply their calculated `top` and `left` coordinates with inline important priority so legacy `inset` rules cannot move an open menu off-screen.

## Phase 54 Stock Take active sessions table

- The Stock Take launchpad now presents exactly three primary actions: **Start Session**, **Quick Count**, and **Bulk Scan**.
- Saved drafts are shown directly below those actions in an **Active Sessions** table with **Session Template**, **Date**, and **Actions** columns.
- Each active-session row exposes **Resume** and **Discard** actions. Saving or discarding updates the table immediately from application state without reloading the page.
- The previous Resume Draft button and Resume Saved Draft modal have been removed.
- The table uses a scrollable desktop layout and responsive session cards on smaller screens.
- Validation: 390 automated tests passed, the production frontend build passed, Worker TypeScript validation passed, and the Wrangler deployment dry run passed.

## Phase 55 Stock Take draft-save and dashboard dropdown fixes

- Stock Take **Save Draft** now clears any focused count or note field before rendering the pending state. This prevents browsers that retain text-field focus after a button click from suppressing both the saving screen and the completion render.
- Each draft receives one stable client ID for the request and any retry. Duplicate clicks are ignored while the request is pending.
- Shared top-layer dropdowns now close on the completed `click` event rather than capture-phase `pointerdown`. An open dropdown can no longer replace the Save Draft or Commit button before that button receives its click, and the former trigger is only synchronised while its original menu still reports itself open so selecting a second dropdown cannot reopen the first.
- A successful save closes the count session, updates the **Active Sessions** table immediately, and shows a confirmation. A failed or timed-out save keeps the session open, clears the pending state, and displays the returned error beside the action buttons as well as in the Stock Take toast.
- Stock Take draft ownership is derived from the authenticated Worker session. Draft loading, saving, and deletion no longer depend on a browser-supplied user ID being present.
- Main Dashboard Location and Date Range menus use a deterministic field width and are pinned to the trigger's measured width before first paint. Menus are kept inside the viewport and recalculated when the window changes size, removing the first-open full-row expansion.
- Durable Object tenant migration 15 creates `stocktake_drafts` for workspaces that were provisioned before resumable drafts were added to the generated baseline. New and existing tenants therefore use the same draft table and owner index.
- Validation: 397 automated tests passed, the production frontend build passed, Worker TypeScript validation passed, and the Wrangler deployment dry run passed.

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

## Phase 59 — Report Actions and SKU Logic

- Every report Actions menu now lists CSV, XLSX, PDF, and All Views Excel downloads above saved-view controls.
- The visible-column selector is an expandable section beneath saved views and is collapsed by default so report actions open in a compact state.
- Blank stock-item SKUs normalize to `SKU - Item Name` across manual creation, imports, existing records, stock tables, dashboards, Stock on Hand reporting, exports, and linked-site transfer data.
- A user-entered SKU is preserved and displayed exactly as entered; the item name is no longer appended to explicit SKU values.
- Validation: 411 automated tests passed, the production frontend build passed, Worker TypeScript validation passed, and Wrangler deployment dry run passed.

## Phase 63: Privacy Policy and Terms of Service

Phase 63 adds:

- A full Privacy Policy at `/privacy.html`.
- Full Terms of Service at `/terms.html`.
- Privacy Policy and Terms of Service links on the sign-in screen.
- Required legal acceptance on workspace registration.
- Frontend and Worker validation so registration cannot bypass acceptance.
- A versioned acceptance record stored in the registration request `raw_json` field.
- Responsive legal-page styling and no em dashes in the new legal copy.

The current legal document version is `2026-07-14`. When the legal documents change, update both `src/legal.js` and `CURRENT_LEGAL_VERSION` in `cloudflare-v2/src/legacy/auth-routes.ts`.

The project does not contain a verified registered company name, physical address, or public legal email address. The legal pages therefore refer users to the service provider and contact details in their order form, subscription agreement, invoice, account, or onboarding communication. Add the final registered entity and public contact information before a formal legal review or public commercial launch.

## Phase 69

Phase 69 preserves custom-UOM stock-take draft counts and variance data across save/resume, and adds `order.updated` as the second-stage Yoco business webhook signal for completing pending refund stock and reporting updates. Reset the Yoco webhook subscription after deployment so the new event set is active.
