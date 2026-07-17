# Reporting Reconciliation Evidence

**Release:** `phase-v2-final-legacy-removal-reporting-audit`  
**Audit date:** 2026-07-16

## 1. Evidence levels

This document separates evidence that can be proven from the source archive from evidence that requires a deployed Yoco connection and production or staging fixture activity.

- **AUTOMATED SOURCE EVIDENCE:** code path, deterministic identity, constraint, and automated test evidence.
- **LIVE EVIDENCE REQUIRED:** actual canonical records, report rows, ledger rows, Yoco API comparison, and cross-format totals from a deployed environment.

No live transaction is fabricated in this audit.

## 2. Common trace chain

Every captured case must preserve this trace:

`raw event -> processing run -> canonical event -> effect proposal -> live outbox/effect -> yoco_orders and/or stock_movements -> report result -> export/schedule result`

The evidence bundle must redact credentials, signatures, personal information, and full secret values. Keep workspace, order, refund, canonical event, effect key, and movement references in a safely shortened but consistently correlatable form.

## 3. Scenario evidence matrix

| Scenario | Canonical and reporting evidence | Stock evidence | Idempotency/recovery evidence | Current status |
|---|---|---|---|---|
| Normal sale | Canonical sale resolver and reporting proposal include order, location, gross, discount, net, VAT, tips, lines, and currency | Sale proposal expands mapped recipe ingredients and live sale writes depletion movements | Deterministic canonical/effect identities and database insert semantics | AUTOMATED SOURCE EVIDENCE; LIVE SAMPLE REQUIRED |
| Sale with modifier | Modifier lines/groups flow through sale proposals and modifier reporting sources | Mapped modifier ingredients create distinct proposals; unmapped modifiers do not create inventory effects | Proposal identity includes source line/modifier/ingredient dimensions | AUTOMATED SOURCE EVIDENCE; LIVE SAMPLE REQUIRED |
| Full refund | Canonical refund links refund ID to source order and writes negative financial values | Resolved remaining refundable quantities create return proposals | Return-capacity query subtracts prior returns from original deductions | AUTOMATED SOURCE EVIDENCE; LIVE SAMPLE REQUIRED |
| Partial line refund | Canonical line resolution limits financial/line reversal to refunded lines | Only resolved original line ingredients are returned | Refund and source-line identities remain in movement metadata | AUTOMATED SOURCE EVIDENCE; LIVE SAMPLE REQUIRED |
| Partial quantity refund | Canonical quantity scales refund proposal | Ingredient return scales by approved refunded quantity | Cumulative capacity prevents full-order or over-return behaviour | AUTOMATED SOURCE EVIDENCE; LIVE SAMPLE REQUIRED |
| Amount-only refund | Financial proposal is permitted independently | No resolved stock proposal; workflow remains manual review | Retry/reconciliation may enrich later without duplicating financial effect | AUTOMATED SOURCE EVIDENCE; LIVE SAMPLE REQUIRED |
| Manual allocation | Existing financial refund remains linked to canonical refund | Approved manual line allocation creates only the authorized stock return | Allocation and effect keys are auditable and duplicate-safe | AUTOMATED SOURCE EVIDENCE; LIVE SAMPLE REQUIRED |
| Duplicate event | Existing canonical identity and outbox/effect records are reused | Deterministic movement IDs plus insert constraints prevent duplicate ledger rows | Webhook, queue, replay, and reconciliation share identity model | AUTOMATED SOURCE EVIDENCE; LIVE DUPLICATE DELIVERY REQUIRED |
| Missing webhook / reconciliation recovery | Reconciliation obtains source activity and creates or enriches canonical events | Same live effect writers repair missing reporting/stock effects | Reconciliation does not use an alternative legacy writer | AUTOMATED SOURCE EVIDENCE; LIVE RECOVERY DRILL REQUIRED |
| Rate-limited request | V2 request audit and rate gate capture response state | No stock effect occurs until canonical processing completes | `Retry-After` is parsed and respected before controlled retry | AUTOMATED SOURCE EVIDENCE; LIVE OR STUBBED 429 FIXTURE REQUIRED |

## 4. Database idempotency evidence

The V2 engine uses deterministic identities across:

- raw event capture
- canonical/domain events
- sale and refund effect proposals
- live reporting outboxes
- live stock effects
- stock movement IDs
- reconciliation reruns

The live refund writer also calculates per-item and per-location return capacity from original `sale_depletion` movements less existing `sale_refund` movements. A proposed return beyond capacity is blocked and marked for manual review rather than silently clipped or duplicated.

## 5. Required financial equations

Capture per-order values from the canonical sale, all canonical refunds, the financial report row, and aggregate report totals.

```text
sale gross - refund gross = remaining gross sales
sale net   - refund net   = remaining net sales
sale VAT   - refund VAT   = remaining VAT
```

The evidence must also show that tips and discounts are represented consistently and that the refund total never exceeds the remaining refundable balance.

## 6. Required inventory equation

For every refunded original sale line and ingredient/location pair:

```text
original ingredient deduction
- previous returned quantity
- current refund return
= remaining net ingredient usage
```

The result must never be negative. An unresolved amount-only refund must show a financial record and zero automatic stock-return movements.

## 7. Required cross-report comparisons

For one fixed workspace, location, date range, timezone, and trading-day window, record:

- Main Dashboard sales and refunds
- Payment/Sales Financial transaction and aggregate totals
- Sale Stock Movement rows
- Detailed Activity ledger rows
- Stock on Hand before and after
- Modifier report totals where applicable
- Theoretical vs Actual usage
- Inventory Audit trace
- manual CSV, XLSX, and PDF totals
- scheduled report totals at its execution timestamp

Expected relationships:

```text
Dashboard sales = Payment report sales
Dashboard refunds = sum of refund transactions
Sale Stock Movement = matching stock_movements rows
Stock on Hand = ledger-derived balance
Modifier report = canonical modifier lines and mapped usage
Theoretical usage = sale recipe usage less resolved refund usage
Scheduled totals = live report totals for the same resolved period
```

## 8. Live evidence capture template

For each scenario, add a subsection containing:

```text
Workspace:
Location:
Trading day:
Yoco order ID (redacted):
Yoco refund ID (redacted, when applicable):
Raw event ID:
Canonical event ID:
Processing run ID:
Reporting effect key and status:
Stock effect key(s) and status:
Financial report result:
Stock movement result:
UI/CSV/XLSX/PDF/scheduled totals:
Reconciliation run ID and result:
Outcome: PASS / PASS WITH WARNING / FAIL
```

## 9. Current conclusion

The source architecture supports the required reconciliation chain and no longer contains an alternate legacy sale/refund business writer. Final reconciliation acceptance remains open until the deployed fixture evidence is appended and the runtime readiness audit passes.

## 10. Automated evidence result

The release archive records the following reproducible evidence:

- final source audit: 24 passed, 0 failed
- frontend and reporting tests: 426 passed, 0 failed
- Worker V2 tests: 39 passed, 0 failed
- Worker TypeScript typecheck: PASS
- frontend production build: PASS WITH WARNING for the existing large application chunk
- Cloudflare deployment dry run: PASS

This evidence validates code paths and deterministic fixture scenarios. It does not substitute for current production records, Yoco source comparisons, ledger balance reconciliation, or cross-format report captures.

