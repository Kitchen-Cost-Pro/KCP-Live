# Phase 70: Yoco Live Refund Webhook Replay

## Root cause found

Normal sales were live because `order.completed` directly loaded and processed the completed order. Refund events could be stored as `attention`, but the Durable Object retry then used a broad refund-list reconciliation. It did not replay the exact `payment_id` and `order_id` received in the webhook. When Yoco exposed `returned_line_items` shortly after the initial webhook, KCP could therefore leave the refund pending until a full manual resync.

A second risk existed in webhook creation: legacy fallback request bodies could create a subscription without explicit `event_types`. That could leave a tenant connected without a guaranteed `payment.refunded` subscription.

## Implemented

- Webhook subscriptions now use Yoco's official request shape only:
  - `order.completed`
  - `order.updated`
  - `payment.refunded`
  - `notification_url`
- Removed subscription fallbacks that omitted `event_types`.
- Added targeted pending-refund replay using the webhook's exact `payment_id` and `order_id`.
- Targeted replay fetches the payment, then the order, merges approved payment refunds, matches the order return and exact `returned_line_items`, and invokes the existing idempotent refund stock/reporting processor.
- Refund events remain `attention` while Yoco has not exposed exact returned-line detail. They are not falsely bulk-marked as processed.
- The workspace webhook route now schedules retry in a `finally` block, including when processing throws after the event was persisted.
- Durable Object alarms now run targeted refund replay with bounded exponential backoff rather than waiting for a broad manual resync.
- Added integration log operation `yoco.refund.webhook_retry`.
- The existing admin retry flow runs targeted refund replay first, then retains the broad reconciliation as a secondary recovery path.

## Deployment and one-time connection step

1. Deploy the Worker and Pages build.
2. Reinitialise/reconnect the Yoco integration once after deployment. This deletes the previous remote subscription and creates a verified subscription containing all three explicit event types.
3. Complete a new sale, then refund one item from the order.
4. Confirm the admin integration log shows:
   - `payment.refunded`
   - `yoco.webhook.process` or `yoco.refund.webhook_retry`
   - a processed result, or a temporary `attention` result followed by a processed retry
5. Confirm only the returned item quantity is restored and the gross refund appears in reporting.

## Verification completed

- 472 application tests passed.
- Cloudflare Worker TypeScript typecheck passed.
- Vite production build passed.
- Wrangler deployment dry run passed.

No live Yoco merchant refund was executed from this local environment, so production webhook delivery still needs the post-deployment test above.
