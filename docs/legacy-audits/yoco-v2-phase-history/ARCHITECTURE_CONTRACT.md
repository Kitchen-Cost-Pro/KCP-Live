# Yoco V2 Engine Architecture Contract

Release: `phase-v2-12-yoco-legacy-shutdown`

Date: 2026-07-15

## Purpose

This release preserves Phases 1 through 10 and adds a controlled, effect-specific V2 refund cutover for explicitly selected pilot workspaces. Sale cutover remains unchanged. The legacy webhook, authentication, subscription lifecycle, sale code, and refund code remain deployed for rollback.

A deployment does not enable a live effect. Every live sale or refund effect remains fail-closed behind an explicit pilot allowlist, an effect-specific environment flag, a database control, V2 effect ownership, readiness evidence, a cutover timestamp, and an unpaused runtime state.

## Repository boundary

The application remains a single Cloudflare Worker. The isolated engine boundary is:

```text
cloudflare-v2/src/modules/yoco-engine-v2/
  admin-routes.ts
  api-client.ts
  capture.ts
  config.ts
  contracts.ts
  cutover.ts
  errors.ts
  identity.ts
  live-refund.ts
  live-sale.ts
  migrations.ts
  observability.ts
  ownership.ts
  processor.ts
  queue-consumer.ts
  rate-gate.ts
  reconciliation.ts
  refund-cutover.ts
  refund-resolver.ts
  refund-shadow.ts
  repository.ts
  route-dispatch.ts
  sale-resolver.ts
  sale-shadow.ts
```

Supporting boundaries:

```text
cloudflare-v2/src/yoco-v2-rate-gate-do.ts
cloudflare-v2/tests/fixtures/yoco-v2/
cloudflare-v2/tests/yoco-engine-v2*.test.ts
```

## Single webhook ingress

There remains one external endpoint:

```text
POST /webhooks/yoco/:workspaceId
```

The verified flow is:

```text
Yoco webhook
  -> existing signature verification
  -> existing legacy processor remains available
  -> immutable V2 raw event capture
  -> identifier-only queue message
  -> rate-gated resolver
  -> canonical sale or refund event
  -> shadow proposals and comparisons
  -> ownership-gated live consumer, only for an activated pilot effect
```

V2 does not create, delete, reset, or test Yoco webhook subscriptions.

## Effect ownership

`integration_effect_ownership` remains the authoritative write-owner contract for:

- `SALE_REPORTING`
- `SALE_STOCK`
- `REFUND_REPORTING`
- `REFUND_STOCK`

Sale and refund ownership are independent. Refund financial ownership and refund stock ownership are also independent.

An effect is consumed by V2 only when all of the following are true:

1. The workspace is in the matching pilot allowlist.
2. The matching environment feature flag includes the workspace.
3. `integration_effect_ownership.engine_version` is `V2` and enabled.
4. The workspace effect control is enabled.
5. Cutover readiness is `ACTIVE` or `PAUSED`.
6. Consumption is not paused.
7. The raw event was received at or after the effect's exact cutover timestamp.

While V2 owns an effect, a pause keeps the equivalent legacy write suppressed. Rollback explicitly returns ownership to `LEGACY`.

## Controlled outbound API boundary

All V2 Yoco API calls use `api-client.ts` and the integration-scoped `YocoV2RateGateDO`. The gate provides request pacing, coordination, request coalescing, short-lived integration-scoped caching, circuit state, and `Retry-After` support without asserting an undocumented provider limit.

## Canonical events

Provider payloads are resolved into stable internal contracts:

- `sale.completed`
- `sale.refunded`

Canonical refunds track financial, inventory, reporting, reconciliation, and overall statuses independently. Duplicate and out-of-order webhook activity enriches the same deterministic domain event.

## Live refund reporting

`live-refund.ts` consumes canonical `sale.refunded` events only when `REFUND_REPORTING` is active for the pilot workspace.

It:

- writes deterministic outbox and reporting-effect records
- writes one linked refund reporting transaction per provider refund identity
- supports multiple refunds against one original sale
- records gross, discount, net, VAT, tip, ZAR currency metadata, and the original source order relationship
- records the occurrence time with the South African `+02:00` offset
- performs the reporting batch transactionally
- refuses to write if an equivalent legacy refund row already exists

## Live refund stock

`live-refund.ts` applies stock returns only when `REFUND_STOCK` is active and the inventory dimension is fully resolved.

Accepted resolution methods are:

- `EXACT_SOURCE_LINE`
- `RETURN_RESOURCE`
- `FULL_ORDER_REMAINDER`
- `MANUAL_ALLOCATION`

The consumer:

- requires mapped canonical lines and clean shadow proposals
- blocks unresolved amount-only refunds
- blocks open manual reviews
- uses the original KCP sale location
- reverses trusted ingredient and mapped modifier proposals
- preserves sub-recipe double-return protection from the shadow proposal engine
- uses deterministic effect and movement keys
- writes to `stock_movements` and updates `stock_balances`
- calculates remaining capacity from original `sale_depletion` movements less all prior `sale_refund` movements
- changes an over-return attempt to durable manual review rather than retrying indefinitely

## Legacy coexistence

Legacy receipt, signature validation, credentials, provider hydration, subscription management, sale code, and refund code remain deployed.

The legacy processor suppresses only the exact effect that is fully activated and owned by V2. For example, V2 may own `REFUND_REPORTING` while legacy still owns `REFUND_STOCK`. Refund rollback returns only the selected effect to legacy and does not remove V2 audit history.

## Transition reconciliation

Every refund activation and rollback records:

- exact boundary timestamp
- actor
- previous and new owner
- transition window
- effect type
- reconciliation state

Transition reconciliation compares expected engine ownership with actual legacy and V2 refund reporting or stock effects. It reports missing, wrong-engine, and both-engine writes. Due transition windows are reconciled by the existing scheduled route and remain idempotent per append-only history record.

## Additive storage

Tenant migration 26 adds:

- `yoco_v2_refund_effect_controls`
- `yoco_v2_refund_cutover_readiness`
- append-only `yoco_v2_refund_cutover_history`
- `yoco_v2_live_refund_effect_outbox`
- `yoco_v2_live_refund_reporting_effects`
- `yoco_v2_live_refund_stock_effects`
- `yoco_v2_refund_transition_reconciliations`
- `yoco_v2_refund_transition_findings`

No legacy table, webhook route, subscription path, or rollback implementation is removed.

## Default deployment state

Production and staging examples ship with empty sale and refund pilot allowlists and every live sale and refund flag set to false. No real workspace is activated by this package.


## Phase 12 legacy shutdown boundary

Legacy Yoco source remains present. Business execution is disabled only when an explicit workspace configuration, V2 ownership for all four effects, enabled V2 controls, and an active observation or approved state agree.

The single webhook ingress continues signature verification and immutable V2 capture. After capture, the legacy business branch is skipped when shutdown is active. Credentials, subscription support, historical data, and rollback code remain present.

A paused V2 consumer does not reopen legacy execution. Phase 12 rollback requires all effect-specific ownership records to return to `LEGACY` before the shutdown state may be rolled back.

Phase 13 removal is outside this release and has no executable deletion route.
