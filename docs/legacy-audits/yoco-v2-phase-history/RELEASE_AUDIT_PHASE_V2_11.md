# Phase V2 11 Release Audit

Release: `phase-v2-11-yoco-refund-controlled-cutover`

## Release decision

The controlled refund cutover implementation is complete and validated locally. It is safe to deploy with default configuration because both pilot allowlists are empty and all live sale and refund flags are false.

No real Cloudflare staging workspace or Yoco merchant was available in the build environment. A real external staging rollback drill and real pilot activation were not performed. The engine therefore remains fail-closed until authorised staging evidence and pilot approval are recorded. The automated staging-equivalent workspace is `ws_phase11_pilot` only.

## Readiness verification

Refund activation requires:

- exact refund fixtures passed
- amount-only manual review passed
- prior-refund quantity protection passed
- a completed stable reconciliation run
- no duplicate sale effects
- existing `REFUND_REPORTING` and `REFUND_STOCK` ownership records
- a completed staging rollback drill
- pilot approval
- explicit refund pilot allowlisting
- effect-specific environment enablement
- a clear transition preview

Tests confirm readiness remains `BLOCKED` until every required item, including rollback evidence, is present.

## Live refund reporting

Implemented in `cloudflare-v2/src/modules/yoco-engine-v2/live-refund.ts`.

Confirmed:

- consumes canonical `sale.refunded` events
- requires V2 ownership for `REFUND_REPORTING`
- requires the refund pilot allowlist, workspace feature flag, active readiness, and enabled control
- uses deterministic outbox, effect, reporting-order, and line keys
- uses database unique constraints
- links each refund to the original source sale
- supports multiple refund identities against one sale
- records signed gross, discount, net, VAT, and tip values
- supports amount-only financial reporting when financial resolution is complete
- records ZAR metadata and a South African `+02:00` occurrence timestamp
- performs the reporting statements through a D1 batch with an outbox and durable effect record
- blocks if an equivalent legacy refund reporting row already exists
- performs no UI-side financial calculation

## Live refund stock

Confirmed:

- requires V2 ownership for `REFUND_STOCK`
- requires the refund pilot allowlist, stock feature flag, active readiness, and enabled control
- accepts exact source-line, return-resource, full-order-remainder, or resolved manual allocations only
- creates no stock return for unresolved amount-only refunds
- requires resolved mappings and warning-free shadow proposals
- uses the original KCP sale location
- reverses trusted ingredient quantities and mapped modifier quantities
- retains sub-recipe double-return protection from the shadow proposal engine
- uses deterministic stock-effect and movement keys with database uniqueness
- writes positive `sale_refund` movements to `stock_movements`
- updates `stock_balances`
- compares cumulative return quantity with original `sale_depletion` less all prior returns
- prevents returns above the originally deducted quantity
- changes an over-return attempt to manual review instead of retrying indefinitely
- blocks if an equivalent legacy refund movement already exists

## Independent completion dimensions

Financial and inventory states remain independent.

A tested amount-only refund produces the financial reporting effect while stock remains blocked and inventory remains `MANUAL_REVIEW_REQUIRED`. Resolving an authorised manual allocation allows the same deterministic stock path to proceed without duplicating the financial effect.

## Legacy coexistence

Confirmed:

- the existing webhook route remains the only external ingress
- signature verification and integration authentication remain unchanged
- legacy sale and refund code remain deployed
- legacy refund reporting is suppressed only when `REFUND_REPORTING` is fully activated and V2-owned
- legacy refund stock is suppressed only when `REFUND_STOCK` is fully activated and V2-owned
- pausing V2 does not silently return authority to legacy
- explicit rollback returns the selected effect to `LEGACY`
- Phase 10 sale ownership and controls remain available and unchanged
- no webhook subscription is created, deleted, or reset by Phase 11

## Cutover controls and diagnostics

The segregated refund admin view exposes:

- financial owner and stock owner
- financial, inventory, reporting, reconciliation, and overall workflow states
- manual reviews
- effect controls and cutover timestamps
- activating users
- outbox and live-effect records
- transition histories, runs, and findings

Admin actions support readiness evidence, preview, enable, pause, resume, rollback, and transition reconciliation independently for reporting and stock.

## Transition reconciliation and rollback

Confirmed:

- activation and rollback record exact timestamps and immutable histories
- events before the boundary remain expected from the previous owner
- events at or after the boundary remain expected from the new owner
- missing, wrong-engine, and both-engine effects are classified explicitly
- scheduled reconciliation closes due refund transition windows
- rollback preserves queued events and every V2 audit record
- post-rollback V2 reprocessing does not repeat an already applied effect

## Database additions

Tenant migration 26 adds:

- `yoco_v2_refund_effect_controls`
- `yoco_v2_refund_cutover_readiness`
- append-only `yoco_v2_refund_cutover_history`
- `yoco_v2_live_refund_effect_outbox`
- `yoco_v2_live_refund_reporting_effects`
- `yoco_v2_live_refund_stock_effects`
- `yoco_v2_refund_transition_reconciliations`
- `yoco_v2_refund_transition_findings`

All changes are additive.

## Automated validation

Phase 11 required scenarios pass:

- exact partial refund writes correct linked reporting
- exact partial refund returns correct stock
- amount-only refund writes financial reporting but no stock
- authorised manual allocation permits stock return
- duplicate delivery does not duplicate reporting or return movement
- prior refunds prevent cumulative over-return
- rollback does not repeat effects
- financial and inventory statuses remain independent

Additional controls pass:

- readiness fails closed without staging rollback evidence
- staging-equivalent activation and rollback preserve append-only history and return ownership to legacy
- existing exact, amount-only, delayed-data, duplicate, prior-refund, reconciliation, sale cutover, rate-gate, and out-of-order tests remain green

Validated results:

- existing application regression suite: **493 passed, 0 failed**
- combined Yoco V2 suite: **87 passed, 0 failed**
- Worker TypeScript check: passed
- frontend production build: passed
- production Wrangler dry-run: passed
- staging configuration Wrangler dry-run: passed using the unchanged example content copied to a temporary `.toml` filename
- release contract and fail-closed configuration scans: passed
- one external Yoco webhook ingress retained: confirmed
- V2 subscription lifecycle calls: none
- Markdown files outside `docs/`: 0
- production and staging pilot allowlists: empty
- production and staging live sale and refund flags: false

## Deployment state

- Not deployed by this build process.
- No real workspace enabled.
- Production sale pilot allowlist is empty.
- Production refund pilot allowlist is empty.
- All production live sale and refund flags are false.
- Real pilot activation remains blocked until authorised staging evidence is recorded.

## Rollback references

Use `CONTROLLED_REFUND_CUTOVER_RUNBOOK.md`, `PHASE11_STAGING_REFUND_ROLLBACK_DRILL.md`, and `ROLLBACK.md`. Preserve all raw events, domain events, manual reviews, outbox records, effect rows, histories, timelines, and reconciliation findings.
