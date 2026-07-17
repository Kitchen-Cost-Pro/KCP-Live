# Phase V2 07-09 Release Audit

Release: `phase-v2-07-09-yoco-refund-reconciliation-shadow`

Date: 2026-07-15

Deployment status: not deployed

## Release conclusion

Phases 7-9 are implemented as additive shadow infrastructure on top of the intact Phase 1-6 engine. The legacy Yoco integration remains active and owns all sale and refund reporting and stock effects.

No V2 live effect was enabled or implemented.

## Phase 7 confirmation

- A stable `sale.refunded` canonical contract is defined.
- Refund identity and domain-event uniqueness are deterministic.
- Webhook, refund, refund order, payment, original order, returned lines, previous refunds, and manual allocation evidence are evaluated.
- Every provider fetch uses the Phase 4 per-integration rate-gated client.
- Refund workflow states and financial, inventory, reporting, reconciliation, and overall dimensions are stored separately.
- Exact source-line and quantity allocation is enforced.
- Previous resolved refunds reduce remaining refundable quantities.
- Full refunds cannot return more than the remaining original sale quantity.
- Equal price is never used as a line-selection rule.
- Amount-only and custom-amount refunds create manual review and no automatic stock proposal.
- Delayed refund orders or returned lines enter controlled waiting/retry behavior.
- Administrator allocation exposes remaining quantities, validates limits, preserves audit history, and supports explicit custom-amount acknowledgement.

## Phase 8 confirmation

- Shadow refund reporting proposals are stored in `yoco_v2_proposed_refund_reporting`.
- Shadow reverse stock proposals are stored in `yoco_v2_proposed_refund_stock_movements`.
- Reverse proposals use resolved quantities, original KCP location, base UOM, recipe data, mapped modifiers, deterministic keys, and prior-refund limits.
- Sub-recipes are expanded once and are not double-returned.
- Refund comparisons link canonical refunds, legacy refund/reporting rows, legacy return movements, and V2 proposals.
- Legacy full-order over-return and gross, net, VAT, location, and movement differences are observable.
- Re-resolution, reproposal, and comparison reruns are idempotent.

## Phase 9 confirmation

- Reconciliation is scoped by workspace and integration.
- Durable checkpoints and configurable overlapping windows are used.
- Orders and refunds are fetched through the per-integration rate gate.
- Collection follows provider cursors with a bounded safety limit; an incomplete page walk does not advance the checkpoint.
- Missing sales and refunds can be rebuilt into immutable reconciliation raw-event equivalents, canonical events, proposals, and comparisons.
- Incomplete workflows, unresolved mappings, financial mismatches, stock mismatches, legacy-only effects, V2-only source activity, and manual review are recorded as findings.
- Hourly incremental, daily deeper, manual date-range, and per-integration pause controls are available.
- A failed or rate-limited run preserves the previous checkpoint.
- Safe repair actions remain shadow-only.

## Legacy and webhook audit

- The legacy webhook endpoint remains `POST /webhooks/yoco/:workspaceId`.
- Legacy signature verification remains before V2 capture.
- Legacy processing remains active.
- V2 creates no webhook subscription and makes no subscription lifecycle call.
- The legacy API client and live processors were not redirected.
- `integration_effect_ownership` remains `LEGACY` for all four effect types.

## Live-effect audit

Static source checks confirm the V2 module contains:

- no `INSERT INTO stock_movements`
- no `UPDATE stock_balances`
- no `INSERT INTO yoco_orders`
- no V2 webhook subscription mutation

Production and staging defaults confirm:

```text
YOCO_V2_LIVE_SALE_REPORTING=false
YOCO_V2_LIVE_SALE_STOCK=false
YOCO_V2_LIVE_REFUND_REPORTING=false
YOCO_V2_LIVE_REFUND_STOCK=false
```

## Storage and migration audit

Tenant migration 24 adds:

- `yoco_v2_refund_workflows`
- `yoco_v2_manual_reviews`
- `yoco_v2_proposed_refund_reporting`
- `yoco_v2_proposed_refund_stock_movements`
- `yoco_v2_refund_comparisons`
- `yoco_v2_reconciliation_state`
- `yoco_v2_reconciliation_runs`
- `yoco_v2_reconciliation_findings`

The checked-in SQL reference contains the complete migration. No legacy table is removed.

## Admin diagnostics audit

Internal administrator APIs expose:

- canonical refund lists and detail
- source order and line evidence
- prior refunds and remaining refundable quantities
- workflow dimensions and timeline
- API request audits
- manual reviews and allocation history
- legacy refund/reporting and return movements
- V2 reporting and stock proposals
- comparison explanation
- reconciliation state, runs, findings, repair results, pause, resume, and manual run

No admin action can create a live V2 business effect.

## Automated validation

Passed:

- existing application regression suite: 493 of 493
- combined Yoco V2 suite: 67 of 67
- frontend production build
- Worker TypeScript check
- production Wrangler dry-run
- staging Wrangler dry-run using a temporary valid D1 identifier for configuration validation
- static live-write and subscription-mutation scan
- Markdown location check: zero project Markdown files outside `docs/`

Fixture coverage includes full, partial-line, partial-quantity, multi-line, amount-only, discounted, VAT, repeated, out-of-order, duplicate, delayed-resource, over-quantity, equal-priced, custom-amount, and modifier refunds.

## Deployment and rollback

Deployment and rollback procedures are documented in:

- `docs/yoco-v2/DEPLOYMENT.md`
- `docs/yoco-v2/ROLLBACK.md`

Rollback requires disabling V2 shadow capabilities or deploying the prior Worker. It requires no Yoco subscription change and no reversal of V2 stock or reporting effects because none exist.

## Non-blocking dependency note

Installing the existing root lockfile reports two moderate npm advisories. No automatic breaking dependency upgrade was applied as part of this integration-engine release.
