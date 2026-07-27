# Phase 91 — Modifier Sales Report CPU/500 Fix

## Incident

The Modifier Sales endpoint continued returning HTTP 500 after the Phase 90 schema correction.

## Root cause

Phase 89 added a direct `LEFT JOIN` from every matching `stock_movements` row to `modifier_sale_action_snapshots` using multiple `OR` conditions and a suffix `LIKE` comparison. On a live workspace this can become a nested scan across ledger and snapshot rows, exceed the Workspace Durable Object CPU budget, and surface as a generic HTTP 500.

The Phase 90 `modifier_rules.status` fix was valid, but it did not remove this expensive join.

## Fix

- Removed the direct snapshot-to-ledger SQL join.
- Selects ledger rows first using the existing indexed report filters.
- Collects only the order IDs represented by those rows.
- Loads sale-time action snapshots in bounded batches of 75 order IDs.
- Matches snapshots to movements in memory by order, line, modifier source key, rule ID, or modifier name.
- Snapshot and modifier-rule enrichment now fail open with a report warning instead of failing the entire endpoint.
- A malformed modifier sale line or selection is skipped with a warning instead of returning HTTP 500.
- Added a unique Worker release marker and `modifierReportVersion` response metadata for deployment verification.

## Deployment verification

After deploying the Worker, `/health` must report:

`phase91-modifier-report-bounded-snapshot-enrichment`

The Modifier Sales response metadata reports:

`phase91-bounded-snapshot-enrichment`
