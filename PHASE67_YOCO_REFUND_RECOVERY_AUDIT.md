# Phase 67 Yoco Refund Recovery Audit

Date: 14 July 2026

## Incident confirmed

The admin log showed two separate facts:

1. The `payment.refunded` webhook was received and marked `PROCESSED`.
2. The follow-up `yoco.sync.refund` operation failed because the Yoco API rate limit had been exceeded.

The webhook acknowledgement did not mean KCP had completed the refund. It only meant that the event reached the Worker. The old implementation could then fail to fetch the full order and still leave the webhook row in a processed state. This prevented the normal errored-order retry query from finding it.

## Root causes

### 1. The webhook does not contain the refund line items

Yoco's `payment.refunded` event contains the business, order and payment identifiers. It does not contain the refund amount, refund reason, order lines, returned lines or modifiers.

KCP must fetch the order to obtain:

- `line_items`
- `payments[].refunds`
- `refunds`
- `returns[].returned_line_items`
- modifiers on the original or returned lines

### 2. Refund and return records were not paired correctly

Yoco exposes the financial refund and physical item return as separate collections:

- `refunds` describes the money refund
- `returns[].returned_line_items` describes the products and modifiers returned

The previous matching code could match a refund summary back to itself instead of pairing it with the separate return record. This left the line selection unresolved and produced no stock movement.

### 3. Rate limiting caused request fan-out

After one failed order request, the webhook loader could try several other order and payment lookup routes. The reconciliation process also fetched the same order once for each refund. This consumed more API allowance after the first 429 response.

### 4. Financial reporting was written too late

The refund financial row was previously created only inside the stock-processing batch. Early exits such as stock depletion being disabled, the original sale not being found in the stock ledger, or unresolved refund lines could prevent the refund from appearing in sales reporting.

### 5. Older incorrectly processed events were invisible to retry

The admin retry action searched only webhook rows with `failed`, `rejected` or `attention` status. The refund in the screenshot had already been marked `processed`, although it had no refund transaction and no stock movement.

## Implemented fixes

### Webhook state is now truthful

A rate-limited refund webhook is stored as `attention`, not `processed`.

The Worker returns HTTP 200 to Yoco to avoid a delivery storm, while KCP keeps the event internally retryable and records the suggested retry delay when Yoco supplies one.

A refund is marked processed only when:

- refund reporting is recorded and the required stock or wastage movements complete,
- the movements were already processed idempotently, or
- the event is intentionally ignored under an explicit rule.

### One standard order request per webhook

For a normal `payment.refunded` webhook with `order_id`, KCP performs one direct order fetch. It does not begin list-order scans after a 429 response.

Legacy list lookup remains available only for non-standard payloads that omit `order_id`.

### Rate-limit-aware Yoco client

The Yoco API client now:

- identifies HTTP 429 errors explicitly,
- reads `Retry-After`, `RateLimit-Reset` and `X-RateLimit-Reset`,
- applies a bounded retry delay,
- stops reconciliation request loops when the rate limit remains active.

### Refund and return pairing

Refund summaries are collected from both:

- `order.refunds`
- `order.payments[].refunds`

They are paired with line-bearing `order.returns` records using:

1. refund or payment references where supplied,
2. a unique matching refund amount,
3. timestamp proximity where timestamps exist,
4. stable ordinal pairing when refund and return counts match,
5. the single refund and single return case.

The resulting refund object carries `returned_line_items`, so only the actual refunded products are reversed. Returned modifiers are included. Where Yoco omits modifier detail from the returned line, KCP retains the original line's modifier selection.

### Reporting is independent from stock completion

The financial refund transaction is now upserted before stock policy and stock-mapping gates.

This means the sales report can show the refund even when the stock reversal remains in an attention state. The integration message explains whether reporting completed and why stock is still pending.

### Refund order cache

Reconciliation caches each fetched order by `order_id`. Multiple refunds for one bill reuse the same complete order response.

When Yoco returns 429 during refund enrichment, KCP stops processing the remaining refunds and leaves the refund cursor unchanged. It does not continue issuing requests.

### Refund-only recovery

The admin and automatic retry logic now detects:

- failed, rejected and attention webhook events,
- older final refund webhooks marked processed that have no corresponding refund transaction.

When all pending events are refunds, KCP runs a refund-only reconciliation. This skips sale-order discovery and preserves the available Yoco API allowance for refund discovery and order enrichment.

The previously processed event in the screenshot will therefore become eligible for recovery after Phase 67 is deployed.

## Expected recovery process after deployment

1. Deploy the Phase 67 frontend and Worker.
2. Allow the current Yoco rate-limit window to clear.
3. Open the KCP admin console.
4. Use **Resync Errored Orders** once.
5. Confirm the reconciliation result shows `refundOnly: true` for this incident.
6. Confirm the refund appears in the sales financial report.
7. Confirm the selected item and its modifiers produce either:
   - positive `sale_refund` stock movements for a normal return, or
   - accounting-only wastage movements with zero physical quantity change for a scrap reason.
8. Confirm the unrelated items on the bill remain unchanged.

The operation is idempotent. Re-running recovery does not create a duplicate refund row or duplicate stock movement.

## Files changed

- `cloudflare-v2/src/legacy/yoco-client.ts`
- `cloudflare-v2/src/legacy/yoco-webhooks.ts`
- `cloudflare-v2/src/legacy/yoco-sales.ts`
- `cloudflare-v2/src/legacy/yoco-service.ts`
- `cloudflare-v2/src/legacy/routes.ts`
- `src/phase67YocoRefundRecoveryAudit.test.js`

## Database changes

No new schema migration is required for Phase 67. It uses the refund transaction and idempotency fields added in Phase 65.

## Validation

- 458 automated tests passed
- 0 automated tests failed
- Worker TypeScript passed
- Vite production build passed
- Wrangler deployment dry run passed

## Deployment status

The package was validated locally but was not deployed from this environment. No live Yoco refund or production database mutation was performed.
