# Yoco V2 Reconciliation Engine

Release: `phase-v2-07-09-yoco-refund-reconciliation-shadow`

## Scope

Reconciliation repairs and compares shadow data only. It never creates a live KCP reporting row or live stock movement.

## Checkpoint and overlap

Each workspace and integration has a durable state row containing its checkpoint, overlap duration, schedule state, and pause reason.

Incremental runs begin before the previous checkpoint by the configured overlap. Deterministic raw-event, domain-event, proposal, and comparison keys make overlap safe. The checkpoint advances only after the full run succeeds.

Defaults:

```text
YOCO_V2_RECONCILIATION_OVERLAP_MINUTES=120
YOCO_V2_RECONCILIATION_LOOKBACK_HOURS=24
```

## Collection behavior

Orders and refunds are fetched through `YocoV2RateGateDO`. Collection supports provider cursors and deduplicates source identities across pages. Hourly and deep runs have bounded page safety; reaching the boundary fails the run rather than silently advancing past unexamined activity.

A 429 preserves the prior checkpoint and records `PAUSED_RATE_LIMIT`. `Retry-After` and the affected integration circuit are honoured by the shared client and rate gate.

## Findings

The engine records:

- `MISSING_SALE_EVENT`
- `MISSING_REFUND_EVENT`
- `INCOMPLETE_WORKFLOW`
- `FINANCIAL_MISMATCH`
- `STOCK_PROPOSAL_MISMATCH`
- `UNRESOLVED_MAPPING`
- `LEGACY_ONLY_EFFECT`
- `V2_ONLY_SOURCE_ACTIVITY`
- `MANUAL_REVIEW_REQUIRED`

## Allowed automatic shadow repairs

- create an immutable reconciliation raw-event equivalent
- create a missing canonical event
- refetch a temporarily unavailable resource
- rerun a resolver
- rerun a proposal
- rerun a comparison

No repair writes to legacy reporting, `yoco_orders`, `stock_movements`, or stock balances.

## Scheduling and administration

The existing Worker cron runs frequently enough to evaluate due work. Per-integration state permits an hourly incremental run and a daily seven-day deep run. Administrators can run a selected window and pause or resume one integration.

Admin diagnostics expose state, checkpoint, recent runs, findings, repair outcome, unresolved refunds, mapping issues, and mismatches.
