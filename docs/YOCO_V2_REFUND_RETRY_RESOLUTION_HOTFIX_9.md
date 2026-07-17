# Yoco V2 Refund Retry Resolution Hotfix 9

Release: `phase-v2-admin-yoco-engine-control-centre-hotfix-9`

## User-visible symptom

A captured `payment.refunded` event remained in `RETRY_SCHEDULED` even after several attempts. The Event Inbox showed only the generic retry status, which did not explain the lookup failure or the next scheduled attempt.

## Root cause

The V2 refund resolver attempted to discover the canonical refund from `/v1/refunds/` before hydrating the refund-order and payment resources referenced by the webhook.

The existing legacy resolver already follows the safer sequence:

1. Fetch the refund-order resource.
2. Fetch the payment resource.
3. Resolve the original order and returned lines from those resources.
4. Use the refunds list as additional enrichment when available.

The V2 resolver used the inverse order and threw a retryable `YOCO_V2_REFUND_LOOKUP_WAITING` error as soon as the refunds list did not expose a matching row. This could continue even when the completed refund-order resource already contained the original order, returned lines and refund amount.

## Changes

- Hydrate the refund-order resource before relying on the refunds list.
- Hydrate the payment resource before relying on the refunds list.
- Accept embedded refund records from payment and refund-order responses.
- Create a structured synthetic refund identity from a final refund-order resource when the canonical refunds list is still eventually consistent.
- Preserve later upgrade to the official refund ID when it becomes available.
- Keep all V2 refund results shadow-only.
- Add `Next retry` and `Last error` to the Event Inbox list.
- Expose requeue for `RETRY_SCHEDULED` events so the administrator can reset attempts and run the corrected path immediately.
- Keep replay and requeue idempotent and audited.

## Safety confirmations

- Legacy refund processing remains active.
- No legacy route or processor was removed.
- No V2 live refund reporting was enabled.
- No V2 live refund stock write was enabled.
- Effect ownership remains `LEGACY`.
- The resolver does not create rows in `stock_movements` during shadow processing.
- Raw payloads remain excluded from event list queries.
- Secrets and credentials remain redacted.

## Automated validation

- 503 frontend and application tests passed.
- 124 Worker and Yoco V2 tests passed.
- 627 total tests passed.
- TypeScript type-check passed.
- Production frontend build passed.
- V2 admin dependency audit passed.
- Phase 12 legacy-preservation audit passed.
- Cloudflare deployment dry run passed.
- Queue and dead-letter bindings were present.
- All live-effect and shutdown flags remained `false`.

## Recovery procedure

After deploying the Worker and restarting localhost:

1. Hard refresh the admin console.
2. Open `Yoco V2 Engine > Event Inbox`.
3. Locate the refund event.
4. Use `Requeue`, not a new refund.
5. Enter a reason such as `Retry after refund-order hydration hotfix 9`.
6. Confirm the action.
7. Inspect the Event Inbox `Next retry` and `Last error` fields.
8. Inspect Processing Runs, Refunds and API Health.

A successful result is `COMPLETED` or `MANUAL_REVIEW_REQUIRED`. `RETRY_SCHEDULED` is not a successful refund result.
