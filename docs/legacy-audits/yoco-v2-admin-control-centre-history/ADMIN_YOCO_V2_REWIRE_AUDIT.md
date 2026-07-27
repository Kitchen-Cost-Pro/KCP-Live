# Admin Yoco V2 Rewire Audit

**Release:** `phase-v2-admin-yoco-engine-control-centre`  
**Date:** 2026-07-15  
**Scope:** KCP administration frontend, isolated Yoco V2 admin APIs, admin observability tables, permissions, tests, and operator documentation.

## Executive result

The KCP admin console now has a separate **Yoco V2 Engine** control centre. The existing page remains available as **Legacy Yoco Integration** and its processing logic was not removed or replaced.

The new control centre reads structured state from `yoco_v2_*` tables through workspace-scoped Worker and Durable Object APIs. It does not determine processing state from free-text integration logs. The interface is observation and shadow-only. It has no usable cutover control and every action initiated from the new interface publishes `live_effects: false`.

## Explicit release confirmations

- **Legacy processing was not removed.** The legacy webhook, sync, retry, stock deduction, refund, reporting, integration status, and legacy admin action paths remain installed.
- **No V2 live writes were enabled.** Existing environment flags and existing controlled-cutover code were not activated or changed by this release. New control-centre replay, requeue, resolver, proposal, comparison, reconciliation-finding, and manual-review actions are shadow-only.
- **All V2 data is workspace-scoped.** The browser calls `/api/admin/workspaces/:workspaceId/yoco-v2/...`; the front Worker authenticates the admin and forwards to that workspace Durable Object. SQL list, detail, action, configuration, and audit queries include the workspace boundary.
- **Secrets are redacted.** Authorization, API key, secret, token, password, cookie, signature, and credential-like fields are recursively redacted. Stored headers use a safe allowlist and sensitive header values are replaced.
- **Replay is idempotent.** Action endpoints require `Idempotency-Key`. The key is unique per workspace, duplicate calls return the original result, and a repeated requeue cannot publish a second queue message.
- **Raw payloads are loaded only on demand.** Event list SQL omits `payload_json`, `headers_json`, and source IP. Payload and redacted headers are queried only by the event-detail endpoint and require `yoco_v2.view_payload`.
- **Structured engine state is used.** KPIs, health, event state, run state, retries, errors, API health, comparison state, reconciliation findings, manual reviews, and dead-letter state come directly from structured V2 records. Free-text log parsing is not used.
- **All tests passed.** Final verification completed with the root frontend suite, the complete Worker Yoco V2 suite, Worker TypeScript typecheck, JavaScript syntax checks, and the production Vite build. See `TEST_RESULTS.md` in this release folder. The final count is 605 automated tests passed, 0 failed.

## Implemented frontend

### Navigation and separation

- Added a new sidebar entry: **Yoco V2 Engine**.
- Kept the current integration page and changed only its visible heading to **Legacy Yoco Integration**.
- Added the required notice that legacy processing remains active during observation or shadow mode.
- Added safe legacy-to-V2 correlation links using an order/source reference and workspace scope.

### V2 sections

The control centre provides:

1. Overview
2. Event Inbox
3. Processing Runs
4. Sales Shadow
5. Refunds
6. Reconciliation
7. Manual Review
8. API Health
9. Dead Letter
10. Configuration

Capability discovery hides backend-dependent sections when their structured table phase is not installed. No placeholder production values are generated.

### UI behaviour

- KCP admin styling and existing session model retained.
- Server-side pagination with 25, 50, and 100 rows.
- Sticky table headers and horizontally responsive tables.
- Custom keyboard-focusable dropdown controls.
- Dropdown menu layer `z-index: 420`; detail drawer layer `z-index: 440`.
- Filter, page-size, workspace, active-tab, and safe-polling state persisted in local storage.
- Manual refresh and optional 30-second safe polling.
- Polling refreshes data without reloading the page, resetting filters, or closing a drawer.
- Detail payloads are fetched only when a drawer opens.
- Loading skeletons, useful empty states, error states, and retry buttons.
- Independent Financial, Inventory, Reporting, and Reconciliation badges for refunds.
- Production, Staging, or Local banner plus a permanent Shadow-only lock banner.

## Implemented backend

### Isolated route family

All new routes are beneath:

`/api/admin/workspaces/:workspaceId/yoco-v2/control-centre/*`

The front Worker converts that path to the internal workspace resource:

`yoco-v2/admin/control-centre/*`

Implemented resources include capabilities, overview, events, event detail, processing runs, run detail, sales, sale detail/actions, refunds, refund detail/actions, manual reviews, manual approval, reconciliation runs, findings and actions, API health, API requests, dead letters and actions, and configuration read/locked update.

### Security and action controls

- Admin session authentication at the central Worker.
- Workspace Durable Object isolation.
- Explicit permission checks.
- Validated page sizes and bounded page numbers.
- Parameter-bound filters.
- Allowlisted event sort fields.
- Recursive response redaction.
- Per-admin, per-workspace action rate limiting.
- Required confirmation for replay, requeue, allocation approval, reconciliation, dead-letter close, and shadow rebuilds.
- Required reason for permanent dead-letter closure.
- Acting admin and trace ID recorded for every new control-centre action.

### Structured observability additions

Migration 28 adds:

- `yoco_v2_webhook_receipts`: append-only verification/capture/queue receipt history, including invalid signatures and failures that never became raw events.
- `yoco_v2_admin_actions`: idempotent action and audit history with previous state, resulting state, reason, actor, target, trace, and timestamps.

Both tables have no-delete triggers. Receipt rows also have a no-update trigger. Admin action identity fields are immutable after insert.

## Permission model

Added permissions:

- `yoco_v2.view`
- `yoco_v2.view_payload`
- `yoco_v2.replay`
- `yoco_v2.reconcile`
- `yoco_v2.manual_review`
- `yoco_v2.configure`
- `yoco_v2.cutover`

SUPER users receive all permissions. A non-SUPER admin receives only `yoco_v2.view` by default. Payload access remains separate. Cutover permission exists for future governance but is unusable in this release.

## Business-logic boundary

The following were intentionally not changed:

- legacy webhook processing
- legacy sale deduction
- legacy refund processing
- legacy reporting writes
- legacy stock writes
- V2 canonical sale/refund resolution algorithms
- V2 stock proposal calculations
- V2 financial proposal calculations
- existing Phase 10 and Phase 11 controlled-cutover engine code
- existing effect-ownership gates

The new code observes these systems and controls only safe shadow retries or reviews.

## Files added

- `public/yoco-v2-admin.js`
- `public/yoco-v2-admin.css`
- `cloudflare-v2/src/modules/yoco-engine-v2/admin-control-centre.ts`
- `cloudflare-v2/src/modules/yoco-engine-v2/admin-permissions.ts`
- `cloudflare-v2/src/modules/yoco-engine-v2/admin-security.ts`
- `cloudflare-v2/src/modules/yoco-engine-v2/migrations/0007-yoco-v2-admin-control-centre.sql`
- `cloudflare-v2/tests/yoco-v2-admin-control-centre.test.ts`
- `src/phaseV2AdminYocoEngineControlCentre.test.js`
- documentation in `docs/yoco-v2-admin-control-centre/`

## Files updated

- `public/KCP Admin ConsoleByYOCO.html`
- `cloudflare-v2/src/index.ts`
- `cloudflare-v2/src/workspace-do.ts`
- `cloudflare-v2/src/types.ts`
- `cloudflare-v2/src/legacy/types.ts`
- `cloudflare-v2/src/legacy/routes.ts`
- `cloudflare-v2/src/modules/yoco-engine-v2/capture.ts` for structured receipt recording only
- `cloudflare-v2/src/modules/yoco-engine-v2/admin-routes.ts` to route the isolated control centre
- `cloudflare-v2/src/modules/yoco-engine-v2/migrations.ts`
- `cloudflare-v2/src/tenant-migrations.ts`
- `cloudflare-v2/src/release.ts`
- package test command and release-compatibility tests
- `cloudflare-v2/scripts/audit-yoco-v2-phase12-safety.mjs` to recognize this Phase 12-safe successor release

## Known operational constraints

- The control centre requires `YOCO_V2_ADMIN_ENABLED` for the selected workspace.
- Tabs backed by later structured phases are hidden if their table does not exist.
- The Configuration tab is intentionally read-only.
- Full-history reconciliation is not exposed. A run is limited to 90 days; ranges over 31 days require explicit confirmation.
- Existing legacy logs remain limited by their legacy UI. The new Event Inbox is the enterprise paginated operational surface.
