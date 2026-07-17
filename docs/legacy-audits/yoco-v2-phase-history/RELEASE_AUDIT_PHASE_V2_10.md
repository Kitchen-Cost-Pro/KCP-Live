# Phase V2 10 Release Audit

Release: `phase-v2-10-yoco-sale-controlled-cutover`

## Release decision

The controlled sale cutover implementation is complete and validated locally. The package is safe to deploy with its default configuration, which has an empty pilot allowlist and all live sale and refund flags disabled.

A real staging rollback drill and real external pilot were not performed in this build environment. Activation therefore remains operationally blocked until an authorised administrator completes the staging drill and records the evidence. The automated pilot uses the isolated fixture workspace `ws_phase10_pilot` only.

## Readiness controls

Activation requires:

- one explicitly allowlisted pilot workspace
- effect-specific environment enablement
- stable matched sale shadow comparisons
- duplicate test evidence
- out-of-order test evidence
- rate-limit test evidence
- successful reconciliation evidence and latest completed run
- existing sale effect ownership records
- staging rollback evidence
- pilot approval
- a clear transition-window preview

The same environment, ownership, control, readiness, and pause conditions are checked before every live effect.

## Live sale reporting

Implemented in `cloudflare-v2/src/modules/yoco-engine-v2/live-sale.ts`.

Confirmed:

- consumes canonical `sale.completed` events only
- requires V2 ownership for `SALE_REPORTING`
- requires the selected workspace flag and pilot allowlist
- uses deterministic effect, outbox, order, and line identifiers
- uses database uniqueness constraints
- writes canonical gross, net, VAT, and ZAR values
- writes a South African `+02:00` occurrence timestamp
- performs no UI-side financial calculation
- uses a transactional D1 batch and durable outbox/effect records
- skips events received before the exact cutover boundary

## Live sale stock

Confirmed:

- requires V2 ownership for `SALE_STOCK`
- consumes only resolved shadow proposals produced from trusted KCP recipe logic
- uses base UOM proposals and the resolved KCP location
- includes mapped modifier proposals only
- inherits sub-recipe double-deduction protection from the tested shadow proposal engine
- uses deterministic movement and effect keys
- uses unique constraints and `INSERT OR IGNORE`
- writes to `stock_movements` and updates `stock_balances`
- records `created_by='yoco-v2'`
- blocks live writes when any shadow proposal has a warning or unresolved status

## Legacy coexistence and rollback

Confirmed:

- the existing webhook route remains the only external webhook ingress
- signature verification and integration authentication remain unchanged
- the legacy sale code remains deployed
- legacy reporting and stock writes are suppressed independently only when that exact effect is V2-owned and fully activated
- a V2 pause does not silently let legacy write, preventing overlap
- explicit rollback returns ownership to `LEGACY` and disables the V2 control
- legacy refunds remain active and unchanged
- no webhook subscription is deleted or recreated by Phase 10

## Transition reconciliation

Confirmed:

- every activation and rollback records exact cutover time, actor, prior owner, new owner, and overlap window
- events before the boundary are expected from the prior owner
- events at or after the boundary are expected from the new owner
- duplicate, missing, and wrong-engine effects create explicit findings
- V2-created `yoco_orders` rows are not misclassified as legacy reporting rows
- activation stops when the preview finds queued, incomplete, unresolved, or unmatched boundary events
- the scheduled reconciliation route automatically closes due activation and rollback windows
- one deterministic reconciliation record is retained per immutable cutover-history entry

## Refund safety

Confirmed:

- `REFUND_REPORTING` remains `LEGACY`
- `REFUND_STOCK` remains `LEGACY`
- `yoco_v2_live_refund_reporting` is hard false
- `yoco_v2_live_refund_stock` is hard false
- no live refund consumer was added

## Database additions

Tenant migration 25 adds:

- `yoco_v2_effect_controls`
- `yoco_v2_cutover_readiness`
- append-only `yoco_v2_cutover_history`
- `yoco_v2_live_effect_outbox`
- `yoco_v2_live_sale_reporting_effects`
- `yoco_v2_live_sale_stock_effects`
- `yoco_v2_transition_reconciliations`
- `yoco_v2_transition_findings`

All additions are additive. No legacy table or code path is removed.

## Automated validation

Phase 10 controlled-cutover tests cover:

- legacy ownership by default
- ownership gate
- workspace feature-flag gate
- staging rollback evidence gate
- independent legacy suppression
- correct ZAR, VAT, and South African timestamp reporting
- stock movement and balance application
- duplicate delivery idempotency
- pause behavior
- rollback to legacy
- refund ownership isolation
- transition-boundary reconciliation
- automatic scheduled transition-window reconciliation and idempotent repeat scheduling

Combined Yoco V2 suite: **77 passed, 0 failed**.

Final local validation:

- existing application regression suite: **493 passed, 0 failed**
- combined Yoco V2 suite: **77 passed, 0 failed**
- frontend production build: passed
- Worker TypeScript check: passed
- production Wrangler dry-run: passed
- staging configuration Wrangler dry-run: passed
- local release-contract and fail-closed configuration checks: passed
- one external Yoco webhook ingress retained: confirmed
- Markdown placement check: passed

The deployed runtime-version check was intentionally not counted because this release was not deployed by the build process. Archive integrity and checksum are recorded during packaging.

## Deployment state

- Not deployed by this build process.
- No real workspace enabled.
- Production pilot allowlist is empty.
- Production live sale flags are false.
- Staging example live sale flags are false.
- Both refund live flags are false.

## Rollback

Use `CONTROLLED_SALE_CUTOVER_RUNBOOK.md` and `ROLLBACK.md`. Effect-specific rollback is preferred over removing code or changing the webhook subscription. Retain all cutover, outbox, effect, timeline, and reconciliation evidence.
