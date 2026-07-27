# Controlled Yoco V2 Refund Cutover Runbook

Release: `phase-v2-11-yoco-refund-controlled-cutover`

## Scope

Phase 11 can transfer `REFUND_REPORTING` and `REFUND_STOCK` independently to V2 for one approved pilot workspace. Phase 10 sale ownership remains unchanged. Legacy webhook receipt, signature verification, credentials, subscription management, and refund code remain deployed for rollback.

A deployment alone cannot activate refund effects.

## Readiness gates

Refund activation requires all of the following:

1. The workspace ID is present in `YOCO_V2_REFUND_PILOT_WORKSPACE_IDS`.
2. The same workspace ID is present in the intended effect flag:
   - `YOCO_V2_LIVE_REFUND_REPORTING`
   - `YOCO_V2_LIVE_REFUND_STOCK`
3. Readiness evidence confirms:
   - exact refund fixtures passed
   - amount-only manual review passed
   - prior-refund quantity protection passed
   - reconciliation passed and the latest run completed
   - no duplicate sale effects exist
   - the refund ownership records exist
   - staging rollback was tested
   - the pilot was approved
4. The transition preview is clear.
5. The controlled action switches the selected effect ownership to `V2`.
6. The selected database control is enabled and not paused.

These conditions are checked again for every live refund event.

## Pilot restriction

Use exactly one approved test workspace for the first deployment. Keep the production and staging example allowlists empty until the drill is completed. Do not use `true`, `all`, or `*` for pilot activation.

## Recommended sequence

1. Deploy migration 26 with all live refund flags false and the refund pilot allowlist empty.
2. Confirm the one existing Yoco webhook subscription and legacy processing remain healthy.
3. Confirm the Phase 10 sale cutover remains stable and no duplicate sale effects exist.
4. Complete `PHASE11_STAGING_REFUND_ROLLBACK_DRILL.md`.
5. Select one approved staging or test workspace.
6. Add only that workspace to `YOCO_V2_REFUND_PILOT_WORKSPACE_IDS`.
7. Enable only `YOCO_V2_LIVE_REFUND_REPORTING` for the workspace first.
8. Record readiness evidence and review the transition preview.
9. Activate `REFUND_REPORTING`.
10. Process controlled full and partial refunds and verify one linked V2 reporting effect per refund.
11. Confirm gross, discount, net, VAT, ZAR, original sale link, and multiple-refund behavior.
12. Reconcile the reporting transition window.
13. Enable `YOCO_V2_LIVE_REFUND_STOCK` for the same workspace only after reporting is clean.
14. Activate `REFUND_STOCK`.
15. Process an exact line or partial-quantity refund and verify the original location and expected ingredient return.
16. Process an amount-only refund and confirm reporting is written while stock remains blocked for manual allocation.
17. Resolve a manual allocation and confirm one deterministic stock return.
18. Reconcile the stock transition window.
19. Observe the single pilot before considering any later rollout.

## Admin diagnostics

The refund cutover view shows, separately:

- financial owner
- stock owner
- financial completion
- inventory completion
- reporting completion
- manual review state
- reconciliation state
- effect controls
- outbox records
- live effect records
- cutover history
- transition findings

## Internal admin routes

All routes use the existing internal front-Worker role boundary.

```text
GET  yoco-v2/admin/refund-cutover?integrationId=<integration_id>
GET  yoco-v2/admin/refund-cutover/readiness?integrationId=<integration_id>
POST yoco-v2/admin/refund-cutover/readiness/evidence
POST yoco-v2/admin/refund-cutover/preview
POST yoco-v2/admin/refund-cutover/effects/REFUND_REPORTING/enable
POST yoco-v2/admin/refund-cutover/effects/REFUND_REPORTING/pause
POST yoco-v2/admin/refund-cutover/effects/REFUND_REPORTING/resume
POST yoco-v2/admin/refund-cutover/effects/REFUND_REPORTING/rollback
POST yoco-v2/admin/refund-cutover/effects/REFUND_STOCK/enable
POST yoco-v2/admin/refund-cutover/effects/REFUND_STOCK/pause
POST yoco-v2/admin/refund-cutover/effects/REFUND_STOCK/resume
POST yoco-v2/admin/refund-cutover/effects/REFUND_STOCK/rollback
POST yoco-v2/admin/refund-cutover/reconcile
```

## Financial and stock independence

`REFUND_REPORTING` and `REFUND_STOCK` must be treated as separate cutovers.

An amount-only refund with resolved financials may be written to reporting while inventory remains `MANUAL_REVIEW_REQUIRED`. It must not create a stock return until an authorised allocation is saved and the shadow stock proposal is rerun successfully.

## Pause semantics

Pausing stops the selected V2 consumer but does not silently return that effect to legacy. Ownership remains V2 and the corresponding legacy write remains suppressed. This preserves queued events and avoids a double-write window.

## Rollback sequence

1. Pause the affected V2 refund effect.
2. Inspect queued events, outbox records, and the transition window.
3. Run refund transition reconciliation.
4. Invoke the effect-specific rollback action.
5. Confirm ownership is `LEGACY` and the V2 control is disabled and paused.
6. Confirm the legacy write policy is no longer suppressed for that effect.
7. Process one controlled refund after rollback.
8. Confirm the effect is written once by legacy and is not repeated by V2.
9. Run transition reconciliation after the overlap window.
10. Retain raw events, canonical events, manual reviews, outbox rows, effects, histories, and findings.
