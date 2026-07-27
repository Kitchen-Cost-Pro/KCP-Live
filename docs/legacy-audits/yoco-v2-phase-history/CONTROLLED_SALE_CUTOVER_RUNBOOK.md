# Controlled Yoco V2 Sale Cutover Runbook

Release: `phase-v2-10-yoco-sale-controlled-cutover`

## Scope

Phase 10 can transfer `SALE_REPORTING` and `SALE_STOCK` independently to V2 for one selected pilot workspace. Webhook receipt, signature verification, credentials, subscription management, raw capture, and all refund effects remain on the existing integration boundary. Legacy sale code remains deployed for rollback.

No workspace is enabled by deployment alone. Activation requires all gates below.

## Activation gates

A sale effect can become active only when:

1. The workspace ID is present in `YOCO_V2_PILOT_WORKSPACE_IDS`.
2. The same workspace ID is present in the relevant environment flag:
   - `YOCO_V2_LIVE_SALE_REPORTING`
   - `YOCO_V2_LIVE_SALE_STOCK`
3. The database readiness record confirms:
   - stable matched shadow comparisons
   - duplicate tests passed
   - out-of-order tests passed
   - rate-limit tests passed
   - reconciliation passed
   - staging rollback tested
   - pilot approved
4. The transition-window preview reports no unresolved, unmatched, queued, or incomplete sale events.
5. `integration_effect_ownership` is switched to `V2` by the controlled action.
6. `yoco_v2_effect_controls.feature_enabled` is enabled and consumption is not paused.

The engine checks these conditions again at consumption time.

## Pilot restriction

Use exactly one non-production or approved test workspace ID for the first pilot. Do not use `true`, `all`, or `*` for either live sale flag. Production defaults in this release contain an empty pilot allowlist and disabled live flags.

## Recommended activation order

1. Deploy the Worker with the Phase 10 migration and all live flags disabled.
2. Confirm the legacy webhook and subscription remain unchanged.
3. Complete the staging rollback drill in `STAGING_ROLLBACK_DRILL.md`.
4. Select one pilot workspace.
5. Add only that workspace ID to:
   - `YOCO_V2_PILOT_WORKSPACE_IDS`
   - `YOCO_V2_LIVE_SALE_REPORTING`
   - `YOCO_V2_LIVE_SALE_STOCK`
6. Keep both refund live flags false.
7. Record readiness evidence through the internal admin endpoint.
8. Review the readiness response and transition preview.
9. Enable `SALE_REPORTING` first.
10. Process a controlled sale and confirm:
    - one `yoco_orders` sale row
    - correct gross, net, VAT, and ZAR values
    - South African `+02:00` occurrence timestamp
    - one applied reporting outbox effect
    - no legacy reporting duplicate
11. Run transition reconciliation for `SALE_REPORTING`.
12. Enable `SALE_STOCK` only after reporting is clean.
13. Process a controlled recipe sale and confirm:
    - deterministic stock movement
    - expected base-UOM quantity
    - correct KCP location
    - mapped modifiers only
    - no sub-recipe double deduction
    - no legacy stock duplicate
14. Run transition reconciliation for `SALE_STOCK`.
15. Observe the pilot before considering any further workspace.

The scheduled reconciliation route also detects activation or rollback windows whose end time has passed and runs the transition audit automatically. Manual reconciliation remains available for immediate review; repeated scheduled delivery is idempotent for the same cutover-history record.

## Internal admin routes

All routes remain protected by the existing internal front-Worker role boundary.

```text
GET  yoco-v2/admin/cutover?integrationId=<integration_id>
GET  yoco-v2/admin/cutover/readiness?integrationId=<integration_id>
POST yoco-v2/admin/cutover/readiness/evidence
POST yoco-v2/admin/cutover/preview
POST yoco-v2/admin/cutover/effects/SALE_REPORTING/enable
POST yoco-v2/admin/cutover/effects/SALE_REPORTING/pause
POST yoco-v2/admin/cutover/effects/SALE_REPORTING/resume
POST yoco-v2/admin/cutover/effects/SALE_REPORTING/rollback
POST yoco-v2/admin/cutover/effects/SALE_STOCK/enable
POST yoco-v2/admin/cutover/effects/SALE_STOCK/pause
POST yoco-v2/admin/cutover/effects/SALE_STOCK/resume
POST yoco-v2/admin/cutover/effects/SALE_STOCK/rollback
POST yoco-v2/admin/cutover/reconcile
```

## Pause semantics

Pausing an effect stops V2 consumption but does not automatically return that effect to legacy. Legacy remains suppressed while ownership is V2. This prevents both engines from writing during an investigation. Use the rollback action to return ownership explicitly.

## Rollback sequence

1. Pause the affected V2 effect.
2. Inspect the outbox and transition window.
3. Run transition reconciliation.
4. Use the effect-specific rollback action.
5. Confirm ownership is `LEGACY` and the V2 control is disabled.
6. Confirm the legacy write policy is no longer suppressed.
7. Process one controlled sale.
8. Run transition reconciliation again.
9. Keep raw events, canonical events, outbox records, histories, and findings for audit.

After the overlap window ends, confirm that the scheduled route has produced one transition reconciliation for the rollback history. A `FAILED` or `UNCERTAIN` result requires administrator review before any later activation.

## Refund boundary

This Phase 10 runbook remains the sale-specific procedure. In the Phase 11 package, controlled refund ownership is managed independently through `CONTROLLED_REFUND_CUTOVER_RUNBOOK.md`. Sale cutover actions do not transfer or modify refund ownership.
