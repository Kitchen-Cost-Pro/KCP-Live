# Phase 10 Staging Rollback Drill

Release: `phase-v2-10-yoco-sale-controlled-cutover`

## Status in this packaged release

A real Cloudflare staging rollback drill was not executed in this build environment because no staging account, Yoco merchant credentials, or approved staging workspace were available. The release therefore ships with an empty pilot allowlist and all live sale flags disabled.

The activation code requires an authorised administrator to record `staging_rollback_tested=true`. Until that evidence is recorded, readiness remains `BLOCKED` and the cutover action fails closed.

The automated fixture `ws_phase10_pilot` exercises activation, pause, idempotent live sale effects, rollback to legacy, and transition reconciliation. It is not a substitute for the real staging drill below.

## Required staging drill

Record the following evidence before activating any real pilot workspace.

| Step | Expected result | Evidence |
|---|---|---|
| Deploy Phase 10 with live flags disabled | Legacy sales and refunds continue | Runtime release and webhook logs |
| Enable one staging pilot workspace | Readiness remains blocked before evidence | Readiness response |
| Record all readiness tests except rollback | Status remains `BLOCKED` | Readiness response |
| Enable V2 sale reporting | One V2 reporting effect and no legacy duplicate | Order row, outbox, ownership, comparison |
| Enable V2 sale stock | One V2 stock movement and no legacy duplicate | Movement, balance, outbox, ownership |
| Pause V2 stock | V2 consumption stops and legacy remains suppressed | Runtime control response |
| Roll back stock ownership | Ownership becomes `LEGACY` | Ownership and history rows |
| Roll back reporting ownership | Ownership becomes `LEGACY` | Ownership and history rows |
| Process a new sale after rollback | Legacy reporting and stock resume once | Legacy logs and source tables |
| Process a refund after rollback | Refund remains legacy throughout | Refund logs and effects |
| Reconcile both boundaries | No duplicate or missing effects | Transition reconciliation results |
| Allow each overlap window to end | Scheduled reconciliation creates one idempotent boundary result | Scheduled route response and transition row |

## Evidence fields

Use the readiness evidence endpoint to record:

```json
{
  "integration_id": "yoco:<workspace_id>",
  "duplicate_tests_passed": true,
  "out_of_order_tests_passed": true,
  "rate_limit_tests_passed": true,
  "reconciliation_passed": true,
  "staging_rollback_tested": true,
  "pilot_approved": true,
  "evidence": {
    "staging_deployment": "<deployment identifier>",
    "rollback_drill_at": "<ISO timestamp>",
    "tested_by": "<authorised user>",
    "sale_order_ids": ["<controlled order ids>"],
    "transition_reconciliation_ids": ["<run ids>"],
    "notes": "<observations>"
  }
}
```

Do not record the rollback flag without completing and retaining the evidence above.
