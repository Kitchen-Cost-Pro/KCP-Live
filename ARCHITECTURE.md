# KCP LIVE CONVERTED - Architecture Notes

Last updated: 2026-06-13

## Purpose

This document captures the current architecture of the converted Kitchen Cost Pro app so future work stays aligned with the real production shape.

Short version:

- the active runtime is Cloudflare Pages + Workers + D1
- Workers are the API and server-authority layer
- D1 is the target operational database
- Firebase should be treated as a temporary auth bridge only where still present
- admin should move from pasted admin token bootstrap to Worker-issued admin sessions

## Active Direction

Cloudflare is the active platform direction because prior RTDB download volume and serverless usage on the old stack created unacceptable cost.

Target stack:

- Frontend: static Vite build on Cloudflare Pages
- Backend/API: Cloudflare Workers
- Database: Cloudflare D1
- Realtime: compact polling, Server-Sent Events, or tiny invalidation signals from Workers
- Yoco webhooks: Cloudflare Worker endpoint
- Auth: temporary Firebase Auth bridge until Cloudflare-native auth/session flow is implemented
- Backups/files: D1 export plus optional Cloudflare R2 for imports, exports, PDFs, and backups

Architecture rule going forward:

- Avoid any new direct Firebase operational data dependencies.
- Avoid browser-side secrets and pasted-token flows as permanent patterns.
- New large data features should be Worker-shaped and D1-native.
- Admin access should resolve through Worker-issued session cookies or short-lived tokens, not a long-lived browser-stored root secret.

## Primary Data Flow

For the target steady state, the frontend talks to Cloudflare Workers:

```text
Browser -> Cloudflare Pages -> Cloudflare Worker API -> D1
```

Temporary auth bridge:

- Browser -> Firebase Auth for sign-in only where still present
- Browser -> Worker API with auth bridge/session bootstrap

## Source of Truth by Layer

### D1

D1 is the operational source of truth for migrated modules, including:

- stock items / ingredients
- stock item UOM configurations and per-UOM barcodes
- per-location balances
- menu products used by live operations
- locations
- location stock routing configuration
- location-specific stock/menu price overrides
- suppliers
- purchase orders and operational receipt state
- GRV, credit note, adjustment, transfer, stocktake, manufacturing, and sales logs
- dashboard metrics and snapshots
- custom report configs
- workspace settings
- team membership and custom roles

### Location Model

The current model is intentionally flat:

- one workspace profile = one business site/profile
- `locations` = selling locations inside that profile
- examples: Main Store, Upstairs Bar, Downstairs Bar, Yoco store locations, counters, food trucks

Do not reintroduce the abandoned two-level Sites / Stock Locations model.

Inventory balances remain keyed by selling location:

```text
workspaces/{workspaceId}/data/ingredients/{ingredientId}/balances/{locationId}
```

The default `Main Store` / default location is a system anchor:

- it must exist
- it cannot be deleted
- it is the fallback for imports and receiving when no location is supplied

Location/site document data:

- Workspace/company tax information is the default legal/tax source for supplier-facing documents.
- Selling locations can optionally override supplier-facing delivery/site/tax/legal details.
- Storage locations remain stock-focused by default.
- Purchase order PDFs and GRNs use selling-location tax override first, workspace/company tax info second, and hide missing fields gracefully.

Locations can define stock routing:

```text
workspaces/{workspaceId}/data/locations/{locationId}/stockRouting/{internalCategory} = "self" | locationId
```

This lets a selling location such as a bar route Food depletion to Kitchen/Main Store while Drinks deplete from itself.

Stock item UOM configuration:

```text
stock_items/{stockItemId}/uomConfigurations[]
```

Each custom UOM stores a display name, ratio back to the base inventory UOM, and optional barcode. PO, GRV, stock take, scanner, import, and reporting flows should convert custom UOM counts back to base UOM for stock on hand.

### Price Overrides

Stock items and menu products support global/default pricing plus location-specific overrides:

```text
ingredients/{ingredientId}/locationPrices/{locationId}
products/{productId}/locationPrices/{locationId}
```

The edit UI should show the override for a selected selling location and fall back to the global/default price when no override exists.

### Firestore

Firestore is used for selected document collections:

- `menu_items`
- `suppliers`
- `recipes`
- `purchase_orders`
- `users`
- `integrationSecrets`

Important rule:

- `integrationSecrets` is server-only and must not be readable by the browser.

### Frontend

The frontend is responsible for:

- rendering the operational UI
- subscribing to live RTDB data
- most normal same-workspace create/edit/delete flows
- table filtering, pagination, and export preparation
- custom dropdown/calendar UI

Firebase setup:

- [src/services/firebase.js](./src/services/firebase.js)

## Functions Responsibilities

Cloud Functions are used where server authority, secrets, scheduled execution, or background processing is needed.

Current local `liveconverted` functions include:

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

Local Xero OAuth/API helper functions exist, but Xero integration is currently paused and should not be treated as the active integration priority.

Function source:

- [functions/index.js](./functions/index.js)
- [functions/dashboardSummary.js](./functions/dashboardSummary.js)
- [functions/yoco](./functions/yoco)

## Server-Owned Paths

### Yoco

Functions own:

- API key validation
- encrypted API key storage
- catalogue import
- location import/mapping
- sales/refund sync
- webhook verification and processing
- scheduled catch-up sync

Yoco locations are imported into KCP selling locations. Re-sync logic should match/update imported records instead of duplicating them.

Yoco menu categories are not the stock-routing source of truth. Stock routing uses the internal inventory category on stock items plus the selling location's `stockRouting` configuration. Yoco category mapping may be used for reporting/translation.

Secrets:

```text
Firestore integrationSecrets/{workspaceId}_yoco
```

Status:

```text
workspaces/{workspaceId}/data/integrations/yoco
```

### Dashboard Summaries

Functions maintain compact summary data so the dashboard does not rely only on client-side recomputation of large logs.

Important accounting rule:

```text
Opening Stock + Purchases - Closing Stock = Theoretical Consumption
```

Opening stock is a period anchor, closing stock is an end-of-period anchor, and movement values are summed inside the selected range.

### Custom Reports

Custom report configs are saved report definitions, not static mock reports. Save should persist the configuration, close the builder, and add/update the saved reports dashboard. Save & Preview should persist the configuration and open a read-only report preview.

The current builder save controls are form submit buttons handled by document-level capture handlers in `src/main.js`; avoid changing them back to nested click-only handlers.

Reset actions:

- Reset Reporting clears reporting/dashboard/log totals without deleting products, recipes, stock items, or item costings.
- Reset Reporting + Stock Values also clears stock-on-hand balances per location while preserving products, recipes, stock items, and costings.
- Destructive reset actions require exact typed confirmation in the UI.
- Reset implementations should avoid excessive fan-out writes that trigger too many Functions.

### User Management

Normal Add Employee uses callable function:

```text
addWorkspaceUser
```

This function:

- creates a Firebase Auth user when a temporary password is supplied
- links an existing Firebase Auth user by email when present
- writes `users/{uid}/profile`
- writes `workspaces/{workspaceId}/data/team/{uid}`
- does not create `invitations/*`

Workspace registration approval remains separate and is handled by the admin console.

## Registration and Admin Approval

Public registration creates pending state:

- Firebase Auth user
- `users/{uid}/profile` with pending status
- `signupRequests/{emailKey}`

Admin approval is handled by:

- `../public/KCP Admin ConsoleByYOCO.html`

Invitations are reserved for registration/workspace approval flows, not normal in-app user additions.

## Deploy Model

Safe commands:

```bash
npm run build
firebase deploy --only hosting
firebase deploy --only database,firestore:rules
firebase deploy --only functions:liveconverted:addWorkspaceUser
```

For other local functions, prefer similarly targeted deploys:

```bash
firebase deploy --only functions:liveconverted:functionName
```

Avoid broad deploy unless intentionally reconciling remote functions:

```bash
firebase deploy --only functions
```

## Admin Console

The admin console is now hosted alongside the main app under:

```text
/admin/
```

Current admin bridge:

- Worker secret: `ADMIN_API_TOKEN`
- Browser prompt for the admin token is temporary
- Replace this with a Worker-issued admin session bootstrap so the browser never needs the root admin secret

## Legacy Caveat

Some modules and docs may still contain legacy Firebase references from the migration period. Those references should be treated as transitional and removed when the matching Worker/D1 path is verified.

Known stale/legacy friction:

- `liveconverted:onMenuUpdate(us-central1)` exists remotely but not locally in that region

## Current Recommendation

Short term: keep direct-to-Firebase stable for:

- normal operational CRUD
- live stock workflows
- PO, GRV, CN, adjustment, transfer, stocktake, and manufacturing user actions
- workspace-scoped reads/writes that rules can protect

Operational stock details to preserve:

- GRVs can receive to default location or split a line across multiple selling locations.
- Stock exports and templates must preserve item + location granularity.
- Stock take counts apply to the unique item + location combination.
- Negative stock is allowed to expose variance.
- Logs should preserve both the selling location and the routed source/deduction location where available.

Short term: use Functions for:

- server-owned aggregates
- integration adapters
- webhook and scheduled processing
- encrypted secrets
- privileged Auth/user operations
- tenant/bootstrap flows
- high-risk financial/inventory recalculations

Medium term: migrate high-volume data paths to the Cloudflare Worker/D1 model:

- dashboard aggregation
- reports
- sales/Yoco order ingestion
- stock movement ledger
- stock balances by location
- low-stock calculations and email batching
- bulk import/export processing

## Related Files

- [agent.md](./agent.md)
- [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md)
- [Yoco Integration.md](./Yoco%20Integration.md)
- [firebase.json](./firebase.json)
- [database.rules.json](./database.rules.json)
- [firestore.rules](./firestore.rules)
- [functions/index.js](./functions/index.js)
- [src/services/firebase.js](./src/services/firebase.js)
- [src/services/database.js](./src/services/database.js)
