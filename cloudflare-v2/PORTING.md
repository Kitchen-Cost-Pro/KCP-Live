# Phase 2b — porting the domain handlers into the WorkspaceDO

Status after Phase 2a: the DO owns a validated 44-table schema (auto-generated), the facade is
runtime-proven, and an end-to-end `suppliers` slice works against the real baseline. This doc is the
exact recipe for porting the real handlers. It was derived by measuring the source, not guessing.

## Decisive finding: copy `routes.ts` WHOLESALE, don't extract piecemeal
`cloudflare/src/routes.ts` (8,833 lines) has a dense web of module-private helpers (`text`,
`numberValue`, `jsonParse`, `objectValue`, `stockItemIsStocked`, `normalizeSupplierPayload`,
`normalizeLocationPayload`, `saveSupplier`, …). Any single handler transitively needs a dozen of
them, so extracting handler-by-handler just drags the whole file along. Port the file as a unit.

## The two-plane split (measured)
- Central-table SQL in routes.ts: **~48 references across ~21 handlers** (`workspaces`,
  `workspace_members`, `roles`, `admin_users`, `app_users`, `auth_sessions`, `auth_reset_tokens`,
  `workspace_registration_requests`).
- **Most of those 21 are CENTRAL routes** (member/role/access management, auth reset, admin) — they
  belong in the front Worker (`src/index.ts`) running against `CENTRAL_DB`, and are NOT dispatched by
  the DO at all.
- **Every other domain handler is pure-tenant**: it uses only `env.DB` + `scoped()`. Example proven:
  `getStockItems`, `getSuppliers` — only tenant tables.

## The seams to adapt (only these)
1. **`scoped(request, env, auth, workspaceId)`** (routes.ts:1319) = `await assertWorkspaceAccess(...)`.
   The front Worker ALREADY runs `assertWorkspaceAccess` before forwarding to the DO, so inside the DO
   `scoped()` becomes a **trusted no-op**. This single change unblocks the majority of handlers.
2. **Handlers that read central data for filtering/permissions but are otherwise tenant** —
   `getUserAllowedLocationIds` (auth.ts) and `getWorkspaceActorRole` (routes.ts:1341) read
   `workspaces`/`workspace_members`/`admin_users`. Point THESE queries at `env.CENTRAL_DB` (the DO's
   Env already binds it). Everything else stays `env.DB`.
3. **Cross-workspace handlers** (external transfers, org/corp consolidated reporting) → Phase 3
   (central `external_transfers` outbox + fan-out). Do not port them into the DO as-is.

## Concrete steps
1. Copy into `cloudflare-v2/src/` (as a `legacy/` subtree): `routes.ts`, `http.ts`, `auth.ts`,
   `crypto.ts`, `yoco-client.ts`, `yoco-webhooks.ts`, `yoco-sales.ts`, `yoco-service.ts`, `email.ts`,
   `low-stock-email.ts`, `turnstile.ts`, and the parts of `admin-routes.ts`/`auth-routes.ts` the
   imports pull in. (chat-routes is optional/independent.)
2. Reconcile the **Env type**: legacy `types.ts` declares `DB: D1Database`. Introduce a `DbLike`
   interface with just `prepare()` + `batch()` (both the facade and D1 satisfy it) and type `env.DB`
   as `DbLike`; add `CENTRAL_DB: D1Database`. This lets the same code run with `env.DB`=facade in the
   DO and `env.DB`=CENTRAL_DB (or the real central handlers) in the front Worker.
3. `scoped()` → no-op; redirect `getUserAllowedLocationIds`/`getWorkspaceActorRole` central reads to
   `env.CENTRAL_DB`.
4. In the DO (`workspace-do.ts`/`tenant-router.ts`), replace the proof-router with the **tenant subset
   of the dispatch switch** from `cloudflare/src/index.ts:448+` (locations, stock, products, recipes,
   suppliers, PO, GRV, adjustments, local transfers, stocktake, manufacturing, credit notes, yoco
   catalogue, reports), calling the copied handlers with `env.DB`=facade.
5. In the front Worker, keep central routes (`/api/auth/*`, `/api/admin/*`, workspace create/list,
   member/role/access) against `CENTRAL_DB`.
6. Typecheck; then smoke-test each feature slice locally exactly like the suppliers proof
   (seed `CENTRAL_DB`, `wrangler dev`, curl the endpoint, verify against the real schema).

## CRITICAL: cross-plane joins (the real hard part) — discovered + catalogued
Some TENANT read queries `LEFT JOIN` a CENTRAL table in ONE statement to enrich rows with the
actor's name/role (`created_by` → `workspace_members`/`app_users`). SQLite/D1 can't join across two
databases, so these can't simply be redirected — the central join must be REMOVED and replaced with a
two-step lookup: run the tenant query, collect distinct `created_by` uids, do ONE `CENTRAL_DB` query
for names/roles, merge in JS. (Chosen over denormalizing actor names into tenant rows because the
current code joins LIVE member data — two-step lookup preserves that exact behavior with no schema
change and no staleness.)

Handler sites needing this rewrite (measured):
- `getAdjustments` (routes.ts ~3921, ~3948) — `LEFT JOIN workspace_members` for actor name.
- `getPurchaseOrders` (~4468, ~4480) — actor via `workspace_members` (in subqueries).
- `getGoodsReceipts` (~4821, ~4833) — actor via `workspace_members`.
- `getCreditNotes` (~5182) — `LEFT JOIN workspace_members`.
- `getStockTakes` (~5419, ~5421) — `LEFT JOIN workspace_members` + `app_users`.
- `postStockTake`/`patchStockTake` (~5685, ~5774) — actor label from a PURE-central lookup
  (`FROM (SELECT ?2 AS created_by) actor LEFT JOIN workspace_members LEFT JOIN app_users`); move the
  whole lookup to `CENTRAL_DB` (no tenant table involved).
- `getTransfers` (~6283) — joins `transfers` (tenant) with `workspaces`+`workspace_members`
  (central); this is the external/cross-workspace transfer view → handle in **Phase 3**, not 2b.

Everything ELSE: central-table queries that DON'T join a tenant table → redirect to `env.CENTRAL_DB`
(done already in `legacy/auth.ts`: requireAuth, getUserAllowedLocationIds, assertWorkspaceAccess).
`getWorkspaceActorRole` (routes.ts:1341) is pure-central → redirect to `env.CENTRAL_DB`.

## REFINED MODEL (validated at runtime): per-QUERY split, all handlers run in the DO
The clean central/tenant split is NOT per-resource — several handlers read BOTH planes in one call
(e.g. `getWorkspaceAccessRoute` reads members/roles centrally AND `locations` locally;
`getWorkspaceSettingsRoute`/`getSiteConfiguration` read `workspaces` centrally + `workspace_settings`
locally). So: **ALL /api/workspaces/:id/* routes run in the DO**, which has `env.DB` (this tenant's
SQLite facade) AND `env.CENTRAL_DB` (shared central D1). The rule is per-STATEMENT:
- statement touches only tenant tables → `env.DB`
- statement touches only central tables → `env.CENTRAL_DB` (works from the DO)
- statement JOINs across planes → the 7 handlers below, rewrite to two-step.
- a `batch()` that mixes planes must be SPLIT (a batch can't span two DBs) — see
  `postSyncDefaultSiteName` (done): central `UPDATE workspaces` pulled out of the tenant batch.
The front Worker does NOT special-case central resources (that breaks mixed handlers) — it just
auths + forwards everything to the DO.

## Complete central-table query map (function | table | line in legacy/routes.ts)
DONE (redirected to CENTRAL_DB): getWorkspaceActorRole (workspaces/workspace_members/admin_users),
getWorkspaceActorPermissionSet (roles), getSiteConfiguration (workspaces), getWorkspaceSettingsRoute
(workspaces), postSyncDefaultSiteName (workspaces, batch split), saveLocationRecord (workspace_members),
and all of legacy/auth.ts.
TODO redirect (central-only statements, safe → CENTRAL_DB): buildLinkedTransferProfile (workspaces
L1192), postCreditNote (workspace_members L5242), postPurchaseOrder (workspace_members L4568),
getWorkspaceAccessRoute (workspaces/workspace_members/roles/admin_users L2382-2407 — its `locations`
read stays env.DB), postWorkspaceMemberRoute (app_users/workspace_members/auth_reset_tokens),
patchWorkspaceMemberRoute, deleteWorkspaceMemberRoute, resendWorkspaceMemberInvite,
postWorkspaceRoleRoute (roles), deleteWorkspaceRoleRoute (roles), postExternalTransfer (workspaces →
Phase 3).
TODO two-step rewrite (cross-plane JOIN): getAdjustments (L3921/3948), getPurchaseOrders (L4468/4480),
getGoodsReceipts (L4821/4833), getCreditNotes (L5182), getStockTakes (L5419/5421), postStockTake
(L5685/5687), patchStockTake (L5774/5776); getTransfers (L6283-6285) → Phase 3.

## Phase 2b status update (most handlers DONE + smoke-tested)
- Two-step actor enrichment DONE + proven (all return ok, no cross-plane errors): getAdjustments,
  getPurchaseOrders, getGoodsReceipts, getCreditNotes, getStockTakes. Shared helper `attachActorInfo`
  (routes.ts) queries CENTRAL_DB workspace_members + app_users (member precedence, app_users fallback)
  and injects `created_by_name`/`created_by_email`, replacing the removed cross-plane LEFT JOINs.
- Central-only reads redirected to CENTRAL_DB: getWorkspaceActorRole, getWorkspaceActorPermissionSet,
  getSiteConfiguration, getWorkspaceSettingsRoute, postSyncDefaultSiteName (batch split),
  saveLocationRecord, getWorkspaceAccessRoute (4 reads; locations stays facade), postPurchaseOrder,
  postCreditNote, postStockTake/patchStockTake actor lookups, all of auth.ts.
- Smoke-tested in DO: suppliers, locations, stock-items, settings, site-configuration, adjustments,
  purchase-orders, grvs, credit-notes, stock-takes, access-management (mixed: central team + tenant
  locations). scoped() → CENTRAL_DB. 401 on no token. Whole tree typechecks (0 errors).

STILL TODO (deferred, well-scoped):
- Member/role WRITE management handlers (central admin routes) still use env.DB for central tables:
  postWorkspaceMemberRoute, patchWorkspaceMemberRoute, deleteWorkspaceMemberRoute,
  resendWorkspaceMemberInvite, postWorkspaceRoleRoute, deleteWorkspaceRoleRoute. Redirect their
  central statements to CENTRAL_DB; watch for batches that also write tenant `audit_events` (split
  those like postSyncDefaultSiteName). These are the only remaining central-only redirects.
- buildLinkedTransferProfile + getTransfers + postExternalTransfer = cross-WORKSPACE (read another
  workspace's DO / shared transfer state) → Phase 3.

## Progress so far (Phase 2b, in progress)
- Copied all `cloudflare/src/*.ts` → `cloudflare-v2/src/legacy/`; whole tree TYPECHECKS (0 errors).
- Env reconciled: `DbLike`/`DbStatementLike`/`DbResult` + `CENTRAL_DB` in `legacy/types.ts`; all
  `D1PreparedStatement`/`D1Database` annotations swapped to `DbLike` types.
- DO wired: `dispatchWorkspaceRoute` extracted from `legacy/index.ts` and called by the DO with
  env.DB=facade, env.CENTRAL_DB=central. Front worker forwards all workspace routes to the DO.
- REAL handlers proven end-to-end in the DO: suppliers (get/post incl. saveSupplier+audit batch),
  locations (post/get), stock-items (get), settings + site-configuration (mixed-plane). scoped()
  access check hits CENTRAL_DB. 401 on no token.
- Redirected the seams listed under DONE above.
- Copied all `cloudflare/src/*.ts` → `cloudflare-v2/src/legacy/`.
- Env reconciled: added `DbLike`/`DbStatementLike` + `CENTRAL_DB` to `legacy/types.ts`; confirmed
  handlers only use `prepare`/`batch` (facade & D1 both satisfy `DbLike`).
- `legacy/auth.ts` fully redirected to `CENTRAL_DB`.
Remaining: redirect remaining pure-central queries in routes.ts/admin-routes.ts/auth-routes.ts to
`CENTRAL_DB`; rewrite the 7 cross-plane join handlers (two-step lookup); wire the DO dispatcher to the
tenant subset; typecheck the whole tree; smoke-test each slice.

## Phase 3c/3d — cross-workspace design (external transfers, discovery, fan-out)

### org/corp discovery — DONE (groundwork)
Grouping is promoted to the CENTRAL `workspaces` registry: `org_id`/`corp_id` columns + indexes added by
gen-central-schema.mjs. The two cross-workspace `json_extract` scans of `workspace_settings`
(getLinkedTransferProfiles, postExternalTransfer) now query `CENTRAL_DB workspaces WHERE org_id/corp_id=?`.
Population points (TODO): admin org-group assignment (admin-routes), provisioning (Phase 4), and the
data-migration tool (Phase 5, from old settings.raw_json). patchWorkspaceSettingsRoute intentionally
STRIPS orgId/corpId (members can't self-assign groups) — do NOT populate from there.

### External transfers — outbox + lazy-reconcile (NO cross-DO calls). TO IMPLEMENT.
An external transfer A→B spans two DOs. Source of truth = central `external_transfers`. Each DO only
touches its OWN tenant tables + the central outbox — no DO has to call another DO (avoids wiring the
WORKSPACE binding into handlers + internal RPC routes).
- **postExternalTransfer (A's DO): DONE + compiles.** Target validated via CENTRAL_DB workspaces;
  target-location validation deferred to accept (B's locations live in B's DO); A's stock deducted
  LOCALLY (stock_balances + stock_movements + A's local `transfers` row, 'pending_receipt'); central
  `external_transfers` outbox row inserted (status 'pending_receipt', items_json=movedItems) with
  ON CONFLICT(id) DO NOTHING for idempotency. This is A's local `transfers` row = A's reconcile ledger.
- **acceptExternalTransfer (B's DO): TODO.** CURRENT code reads the transfer from local `transfers`
  and sources line items from the SOURCE's `transfer_lines` (env.DB) — both unreachable from B now.
  Rewrite: read outbox row (CENTRAL_DB) WHERE id AND to_workspace_id=B AND status pending; source
  line items from outbox `items_json` (NOT source transfer_lines); validate B's toLocation (env.DB);
  credit B's stock LOCALLY; compute per-line shortfall (shipped-received); write received+shortfall
  back into the outbox items_json + set status='accepted', accepted_at. B must NOT write to
  sourceWorkspaceId stock (lines ~6972/6978 today) — that shortfall return becomes A's lazy job.
- **cancel (A's DO, before accept):** A restores its OWN stock locally + set central status='cancelled'.
  Synchronous (A acts on A).
- **reject (B's DO):** set central status='rejected' only (do NOT touch A's stock from B).
- **Lazy restore + status sync (A's getTransfers):** when A lists transfers, read central outbox for
  A's rows; for any 'rejected'/'cancelled' whose A-local copy isn't yet restored, restore A's stock
  locally + mark A's local row reconciled (idempotent flag in raw_json or a status column). Also mirror
  central 'accepted' status onto A's local copy for display. This replaces the removed cross-workspace
  JOIN in getTransfers (L~6280) and needs the actor two-step (attachActorInfo) too.
- getTransfers currently also LEFT JOINs workspaces (central, for from/to names) → replace with a
  CENTRAL_DB lookup of the peer workspace names (like attachActorInfo).

### Fan-out (3d) — primitives DONE, consumers TODO
Front worker now has `callWorkspaceDO(env, workspaceId, resource, auth, method?, body?)` (synthesize an
internal request to any DO, return parsed JSON) and `fanOutWorkspaceDOs(env, ids, resource, auth)`
(concurrent, null on failure). Cross-workspace READS must run in the front worker (only it has
env.WORKSPACE). Consumers to wire:
- **linked-transfer-profiles** (best first — testable with the 2-workspace setup): add a tenant
  handler `getSelfTransferProfile` returning THIS workspace's own profile (id/name + locations + stock
  items w/ balances, in buildLinkedTransferProfile's shape, reading local env.DB); register as tenant
  resource `transfer-profile`. Front worker intercepts `linked-transfer-profiles`: discover peers
  (org/corp from CENTRAL_DB workspaces + source's linkedSites via `callWorkspaceDO(source,'settings')`),
  `fanOutWorkspaceDOs(peers,'transfer-profile')`, merge + apply sourceLink overrides. Return {ok, profiles}.
- **getAdminOverview / org-corp consolidated reports** (admin portal — secondary): getAdminOverview
  (admin-routes.ts:983) currently one query JOINs workspaces+workspace_settings+stock_items+locations
  across ALL workspaces + a yoco_connections aggregate. Fan-out plan: (1) add a tenant `admin-stats`
  resource returning per-workspace counts (stock_item_count, location_count, vat_rate, yoco
  items/locations) from local env.DB; (2) move getAdminOverview to the front worker: central reads
  (workspaces, registration_requests, members, invitations, admins) straight from CENTRAL_DB, then
  `fanOutWorkspaceDOs(allWorkspaceIds, 'admin-stats')` and merge stats into the workspace map. Log
  partial failures; never silently drop a member. Same pattern for org/corp consolidated reports.
  PROVEN reference implementation: getLinkedTransferProfilesFanOut + getSelfTransferProfile.
- **Admin per-workspace ops** (workspace settings GET/PATCH, Yoco connect/sync): front worker forwards
  to that one workspace's DO via forwardToWorkspaceDO (they act on one tenant's tables), rather than
  running against CENTRAL_DB. (Add the corresponding tenant resources in the DO dispatcher.)

Priority note: the core app + external transfers + linked profiles all work per-workspace and are
validated. The above are ADMIN-PORTAL screens (internal tooling) — lower priority than Phase 4
(provisioning) and Phase 5 (data-migration tool), which are the path to an actual new-account cutover.

## Guardrail
Keep it COMPILING at each step. The Env-type reconciliation (step 2) touches all copied files at once
— do it in one pass, then fix type errors file-by-file before wiring the dispatcher. Do this at the
start of a session with full budget, not as a mid-turn partial.
