# Yoco Live Device Webhook Fix

Release: `yoco-v2-live-device-webhook-fix`

## Production diagnosis

On 2026-07-28, the public Worker endpoints still identified the deployed
release as:

`phase92-modifier-replacement-picker-and-scope-fix` (2026-07-16)

The source release being tested locally identified itself as:

`yoco-v2-locationless-sales-runtime-fix` (2026-07-28)

This confirmed that the current frontend/source changes had not been matched by
the required Worker deployment. Live Yoco webhook ingestion executes in the
Worker, not the frontend.

## Hardening in this release

- Subscribe to both documented live sale signals: `payment.created` and
  `order.completed`.
- Continue subscribing to `order.updated` and `payment.refunded`.
- Treat `payment.created` as a supported live sale trigger.
- Retry briefly when the payment event arrives before the order API exposes a
  final paid order.
- Preserve order-level idempotency so receiving both live sale events cannot
  double-write reporting or stock.
- Preserve the Main Storage fallback for location-less device sales.

## Verification

- Worker/Yoco tests: 100 passed, 0 failed.
- Worker TypeScript typecheck: passed.
- Wrangler deployment dry run: passed, including Durable Object, Queue, DLQ,
  D1 and V2 runtime bindings.

Deployment is still required. After deploying the Worker, reset or sync the
Yoco webhook once so existing subscriptions are replaced with the complete
event set.
