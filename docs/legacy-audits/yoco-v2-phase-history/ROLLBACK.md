# Yoco V2 Phase 12 Rollback Guide

Release: `phase-v2-12-yoco-legacy-shutdown`

The legacy integration remains deployed and available. Sale and refund reporting and stock ownership can be rolled back independently.


## Phase 12 shutdown rollback

Phase 12 must not reopen legacy business processing while any effect is still V2-owned. Roll back effect ownership first, then roll back the shutdown layer.

Required order:

1. Pause the affected V2 consumers.
2. Run sale and refund transition reconciliation.
3. Use the Phase 10 and Phase 11 rollback routes for all four effects.
4. Confirm every `integration_effect_ownership.engine_version` value is `LEGACY`.
5. Call `POST yoco-v2/admin/legacy-shutdown/rollback`.
6. Verify legacy business processing is available and V2 live consumers cannot write without ownership.
7. Process controlled sale and refund cases and reconcile the boundary.
8. Retain all Phase 12 snapshots, alerts, invocation events, and history.

The Phase 12 rollback endpoint rejects the request while any of the four effects remains V2-owned. A V2 pause alone never re-enables legacy execution.

## Refund effect rollback

Use the internal action for the affected refund effect:

```text
POST yoco-v2/admin/refund-cutover/effects/REFUND_REPORTING/rollback
POST yoco-v2/admin/refund-cutover/effects/REFUND_STOCK/rollback
```

Each action:

- pauses and disables the selected V2 refund control
- switches the selected ownership record to `LEGACY`
- records the exact rollback timestamp and actor
- appends an immutable refund cutover-history record
- preserves queued events, canonical events, manual reviews, outbox records, effects, and timelines
- creates a transition window for reconciliation

Run refund transition reconciliation after rollback and process one controlled refund to verify legacy recovery without a repeated V2 effect.

## Sale effect rollback

Phase 10 sale rollback routes remain unchanged:

```text
POST yoco-v2/admin/cutover/effects/SALE_REPORTING/rollback
POST yoco-v2/admin/cutover/effects/SALE_STOCK/rollback
```

## Pause versus rollback

A pause stops V2 consumption but intentionally keeps legacy suppressed while V2 still owns the effect. This protects queued events and prevents automatic overlap. A rollback is required to return write authority to legacy.

## Recommended refund rollback sequence

1. Pause the affected refund effect.
2. Inspect the refund outbox, manual reviews, queued events, and transition preview.
3. Run transition reconciliation.
4. Invoke the effect-specific rollback action.
5. Confirm `integration_effect_ownership.engine_version='LEGACY'` for that effect.
6. Confirm the V2 control is disabled and paused.
7. Confirm the legacy refund write policy is no longer suppressed for that effect.
8. Process one controlled refund after rollback.
9. Verify the effect appears once through legacy and no new V2 effect is created.
10. Reconcile after the transition window closes.
11. Retain all V2 audit evidence.

## Emergency environment containment

Remove the pilot workspace from the applicable values:

```text
YOCO_V2_LIVE_REFUND_REPORTING
YOCO_V2_LIVE_REFUND_STOCK
YOCO_V2_REFUND_PILOT_WORKSPACE_IDS
```

This stops V2 consumption, but environment changes do not transfer ownership. Use the rollback action before relying on legacy writes.

The sale pilot values remain separate:

```text
YOCO_V2_LIVE_SALE_REPORTING
YOCO_V2_LIVE_SALE_STOCK
YOCO_V2_PILOT_WORKSPACE_IDS
```

## Worker rollback

1. Pause affected V2 effects.
2. Run the relevant transition reconciliation.
3. Roll affected effects back to legacy.
4. Confirm legacy write policies and ownership.
5. Deploy the previously approved Worker release only if code rollback is still required.
6. Do not delete or recreate the Yoco webhook subscription.
7. Verify controlled legacy sale and refund processing.
8. Keep reconciliation scheduled until every overlap window closes.
9. Retain V2 raw events, domain events, outbox rows, effect rows, histories, reviews, and findings.

## Rollback assertions

- one external webhook ingress remains
- legacy authentication and subscription lifecycle remain unchanged
- rolled-back effects are owned by `LEGACY`
- V2 controls are disabled for rolled-back effects
- queued events remain preserved
- no refund is reported or returned by both engines around the boundary
- amount-only unresolved inventory is not returned
- transition reconciliation reports no duplicate or missing effect
- V2 audit history remains intact
