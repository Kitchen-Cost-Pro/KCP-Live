# KCP LIVE CONVERTED - Agent Handoff

Last updated: 2026-06-13

## 1. Project Snapshot

This project is the active Kitchen Cost Pro web app during the Cloudflare migration.

Current active stack:

- Vite frontend
- Cloudflare Pages for hosting
- Cloudflare Workers for API, admin routes, and Yoco webhook handling
- Cloudflare D1 as the active operational database
- Firebase Auth still present temporarily for user sign-in while auth migration is pending

Important current state:

- The app should now be treated as Cloudflare-first.
- New app reads/writes should target Worker endpoints and D1 models, not direct RTDB/Firestore patterns.
- Firebase is no longer the target data plane and should be treated only as a temporary auth bridge where still unavoidable.
- Do not introduce new Firebase-dependent modules, listeners, secrets, or admin tooling.
- Optional Cloudflare R2 later for imports, exports, PDFs, and backups
- Compact polling, Server-Sent Events, or tiny invalidation signals instead of broad RTDB listeners

Live URLs:

- Main app production alias is `https://main.kcp-kitchencostpro.pages.dev`
- Recent Pages preview is `https://a84e039f.kcp-kitchencostpro.pages.dev`
- Admin console is hosted alongside the app at `/admin/`
- Example deployed admin route: `https://<pages-deployment>.kcp-kitchencostpro.pages.dev/admin/`

Admin auth note:

- The admin page currently uses a temporary `ADMIN_API_TOKEN` bridge stored as a Cloudflare Worker secret.
- The next planned step is Worker-issued admin sessions/cookies so the browser no longer prompts for a pasted admin token.

## 2. Built Product Surface

Implemented views/modules:

- Login and workspace selection
- Dashboard
- Menu Catalogue
- Recipes
- Stock Items
- Suppliers
- Purchase Orders
- GRV Entry
- Credit Notes
- Adjustments
- Transfers
- Stock Take
- Locations
- Manufacturing
- Integrations
- User Management
- Roles/custom permissions
- Settings

Implemented supporting features:

- Custom dropdown pattern across key workflows
- Custom date range calendar
- CSV/XLSX/PDF export utilities
- Yoco integration drawer and status handling
- Stock item UOM configuration, including up to three custom UOMs and per-UOM barcodes
- Worker-backed admin console hosted on Cloudflare Pages
- Pending registration flow
- Temporary admin-token bridge until Worker-issued admin session bootstrap is implemented

## 3. Data Architecture

Main operational data should be treated as D1-backed:

```text
Cloudflare Worker API <-> D1
```

Important point:

- Normal app operations should be moving toward Worker endpoints and D1 reads/writes.

See:

- [ARCHITECTURE.md](./ARCHITECTURE.md)

## 4. Current Functions

Local `liveconverted` functions include:

- `refreshDashboardSummary`
- `bootstrapDashboardLiveStates`
- `connectProfiles`
- `getSiteConfiguration`
- `orgTransferApi`
- `sendQueuedWelcomeEmail`
- `deleteWorkspaceAdmin`
- `requestWorkspaceRegistration`
- `onDashboardSourceWrite`
- `onDashboardSourceItemWrite`
- `onLegacyDashboardSourceWrite`
- `onLegacyDashboardSourceItemWrite`
- `refreshDashboardSummaries`
- `sendLowStockSummaryEmails`
- `onMenuUpdate`
- `connectYoco`
- `syncYocoCatalogue`
- `syncYocoSales`
- `disconnectYoco`
- `maintainYocoConnections`
- `syncYocoCataloguesFrequently`
- `yocoWebhook`
- `addWorkspaceUser`

Xero helper functions exist locally, but Xero integration is paused for now.

Important files:

- [functions/index.js](./functions/index.js)
- [functions/dashboardSummary.js](./functions/dashboardSummary.js)
- [functions/yoco](./functions/yoco)

## 5. Recent Critical Product Decisions

### Registration

- Public account/workspace registration creates a pending signup request.
- It does not create active workspace access immediately.
- Welcome/password setup handling is initiated from admin approval.

### User Management

- Adding an employee inside an existing workspace does not create an invitation.
- Add Employee calls `addWorkspaceUser`.
- The function creates a Firebase Auth user when a temporary password is supplied.
- If the email already exists, it links that existing Auth user to the workspace.
- Invitations are reserved for registration/workspace approval flows only.

### Yoco

- Yoco API keys are encrypted in Firestore server-only secrets.
- Webhooks and scheduled sync both exist:
  - webhooks process live sales/refunds
  - scheduled sync catches missed/delayed events
- Yoco variants import as separate menu rows.
- Each variant can have its own recipe and price.
- Yoco locations import into KCP selling locations and should update/match rather than duplicate on re-sync.
- Sales deduct stock by smart-routed source location.
- Refunds restore stock by smart-routed source location.
- Yoco menu categories are not the stock-routing source of truth.
- Internal stock item categories plus `locations/{locationId}/stockRouting` drive depletion routing.

### Locations and Stock

- One workspace profile represents one business site/profile.
- `locations` are selling locations inside the profile, such as Main Store, bars, counters, or imported Yoco locations.
- Do not reintroduce the abandoned Sites / Stock Locations nested model.
- A permanent default `Main Store` / default location must exist and cannot be deleted.
- Ingredient balances remain keyed by `locationId`.
- Bulk stock imports with blank location values default to the default location.
- GRVs can receive to one location or split a received line across multiple selling locations.
- Selling locations can optionally hold supplier-facing site/delivery/tax/legal overrides. Storage locations stay stock-focused by default.
- Workspace/company tax information is the default legal/tax source for supplier-facing documents.
- PO PDFs and GRNs use legal/tax data by priority: selling-location override, workspace/company tax info, then hide missing fields.
- Stock exports/templates must preserve item + location granularity.
- Stock take templates apply counts to unique item + location combinations.
- Negative stock is allowed so variance remains visible.
- Stock item UOM configuration converts ordering/receiving/counting/scanning units back to the base inventory UOM.

### Pricing

- Stock items and menu items support global/default pricing plus location-specific overrides.
- Overrides are stored under `locationPrices[locationId]`.
- Edit modals should let the user select a selling location and view/edit that location's price override.

- Dashboard date ranges use accounting anchors:
  - opening stock at period start
  - closing stock at period end
  - activity summed inside the range
- Theoretical Consumption = Opening Stock + Purchases - Closing Stock.
- Backend summary nodes are used to reduce dashboard load lag.
- Low-stock summary emails are scheduled per workspace and sent to members tagged for low-stock alerts.

### Menu Catalogue Delete

- Menu deletes must remove matching rows from both Firestore and RTDB.
- Matching includes id, Yoco item/variant ids, SKU keys, and name fallback.

### Google Account Requests

- Google login is shown on the login screen.
- If Google auth succeeds for a user with no active workspace, route the user into the account/workspace request flow.
- Prefill name and email from Google, allow the user to edit the name, and require workspace name before submitting approval request.
- Google signup must not bypass admin approval.

## 6. Deployment Status

Recently deployed:

- Cloudflare Pages production alias at `https://main.kcp-kitchencostpro.pages.dev`
- Recent Pages preview `https://a84e039f.kcp-kitchencostpro.pages.dev`
- Cloudflare Worker API remains `https://kcp-api.kcp-kitchencostpro.workers.dev`

Safe deploy commands:

```bash
cd KCP-LIVE-CONVERTED
npm run build
cd ../cloudflare
npm run typecheck
node_modules/.bin/wrangler pages deploy ../KCP-LIVE-CONVERTED/dist --project-name kcp-kitchencostpro --branch main
```

Avoid:

```bash
firebase deploy --only functions
```

Reason:

- The live Firebase project still has legacy/stale functions not represented locally.
- Broad function deploys can trigger deletion prompts, including stale `liveconverted:onMenuUpdate(us-central1)`.

## 7. Security / Multi-Tenant Status

RTDB rules are checked into the repo and workspace-gate key operational paths.

Firestore rules still need deeper membership hardening for full production confidence. Treat this as an important remaining production-hardening task.

## 8. Known Open Issues / Caveats

- Firestore tenant rules are not yet strong enough for final customer production confidence.
- Function inventory is not fully reconciled with the live Firebase project.
- `firebase-functions` package should eventually be upgraded carefully.
- Vite build succeeds but warns about large chunks.
- Import screens should show loading while processing; stock/supplier/stock-count templates are now client-friendly and UOM-aware.
- UI patterns to preserve: custom dropdowns where native selects clip or contrast badly, bottom-center fixed toasts with border/accent status colors, viewport-current delete confirmations, and minimized nested modal scrollbars.

## 9. Recommended Next Steps

1. Add observability around remaining RTDB listeners and high-download paths.
4. Harden Firestore workspace membership checks for the current live system while migration is underway.
5. Reconcile legacy remote Cloud Functions with local source only if paid Firebase infrastructure remains in use.
6. Add automated tests for high-risk stock/accounting logic.

## 10. Useful Commands

Frontend:

```bash
npm run dev
npm run build
```

Functions:

```bash
npm --prefix functions install
npm --prefix functions run lint
node -c functions/index.js
```

Firebase:

```bash
firebase deploy --only hosting
firebase deploy --only database,firestore:rules
firebase deploy --only functions:liveconverted:functionName
```
