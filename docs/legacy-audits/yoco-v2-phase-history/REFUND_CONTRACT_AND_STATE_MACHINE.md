# Canonical Refund Contract and State Machine

Release: `phase-v2-07-09-yoco-refund-reconciliation-shadow`

## Canonical event

V2 stores one deterministic `sale.refunded` domain event per integration and refund identity. The contract includes refund and original-order references, timestamps, currency, refund type, financial dimensions, independent resolution dimensions, exact resolved lines, and preserved provider metadata.

Refund types are:

- `FULL`
- `PARTIAL_LINE`
- `PARTIAL_QUANTITY`
- `AMOUNT_ONLY`
- `UNKNOWN`

A refund is `FULL` only when reliable source data allocates all remaining refundable quantities after previous resolved refunds. A multi-line refund containing any reduced source quantity is `PARTIAL_QUANTITY`.

## Resolution evidence order

The resolver evaluates available evidence from:

1. verified webhook payload
2. refund resource
3. refund order
4. payment resource
5. original sale order
6. return resource or returned-line collection
7. previously resolved canonical refunds
8. an authorised manual allocation

All provider fetches use the V2 rate-gated client.

## State machine

Normal states:

```text
RECEIVED
REFUND_RESOURCE_REQUESTED
REFUND_RESOURCE_RESOLVED
REFUND_ORDER_RESOLVED
ORIGINAL_ORDER_RESOLVED
RETURN_LINES_RESOLVED
FINANCIALS_RESOLVED
MAPPINGS_RESOLVED
CANONICAL_EVENT_CREATED
STOCK_PROPOSAL_CREATED
REPORTING_PROPOSAL_CREATED
RECONCILED
COMPLETED
```

Alternative states:

```text
WAITING_FOR_YOCO
RETRY_SCHEDULED
MANUAL_REVIEW_REQUIRED
FAILED_PERMANENTLY
```

The workflow row independently tracks `financial_status`, `inventory_status`, `reporting_status`, `reconciliation_status`, and `overall_status`. Timeline records are append-only.

## Exact line safety

Exact original line IDs are preferred. A product fallback is accepted only when it identifies one unique source line. Equal prices are never used to select a line.

For every allocation:

```text
remaining quantity = originally sold quantity - prior resolved refund quantity
```

The resolver rejects or routes to review any quantity above the remaining amount.

## Amount-only and un-allocatable refunds

When stock cannot be confidently allocated — financial value without reliable returned lines
(amount-only), an ambiguous product reference, an unmapped item or location, or a quantity above the
remaining refundable amount:

- financial resolution is retained and the reporting reversal is applied
- `refund_type` is classified normally (e.g. `AMOUNT_ONLY`)
- inventory resolution is `NOT_APPLICABLE` — the stock return is skipped, never guessed
- no manual review is opened; `metadata.allocation_reason_code` records why stock was skipped

This is deliberate for an inventory-first system: the engine never invents a stock movement it
cannot substantiate, and it never blocks on a human. Stock is only returned when reliable returned
lines map cleanly to mapped items at a mapped location.

`openRefundManualReview` and the manual-allocation endpoint remain available for an explicit,
administrator-initiated allocation if one is ever wanted. A custom amount that does not equal the
allocated source-line gross still requires a separate acknowledgement stored in audit history.

## Delayed provider data

Early 404 or incomplete return-line responses are treated as temporary provider availability conditions. The event enters `WAITING_FOR_YOCO`, receives controlled retry scheduling, and remains idempotent. It is not prematurely converted into a guessed allocation or permanent failure.
