# Phase 72 - Yoco Webhook Rate-Limit Safety

Date: 14 July 2026
Worker release: `phase72-yoco-webhook-rate-limit-safe`
Refund pipeline: `live-refund-v3`

## Incident

Resetting or reconnecting Yoco failed while KCP attempted to delete seven older webhook subscriptions. Yoco returned HTTP 429 rate-limit responses and `/yoco/connect` returned HTTP 500.

## Root cause

The previous flow performed too many webhook-management requests in one foreground action:

1. Admin Webhook Reset called `disconnectYoco`.
2. Disconnect listed and deleted matching remote subscriptions.
3. Reset then called `connectYoco`.
4. Connect listed and deleted the same matching subscriptions again.
5. Connect created a replacement subscription and listed subscriptions again for verification.
6. Any failed delete caused the entire connection action to throw.
7. The admin browser then called catalogue sync a second time even though the connect endpoint had already completed it.

This made rate limiting likely and incorrectly treated stale-subscription cleanup as more important than keeping a live webhook connected.

## Implemented changes

### 1. Reset no longer disconnects first

The admin reset endpoint now calls `resetYocoWebhook` directly. It does not clear the API key, disconnect the workspace, or run duplicate deletion passes.

### 2. The replacement webhook is created first

KCP now creates the new subscription and stores its ID and signing secret before stale cleanup is considered. A rate-limited cleanup cannot leave the workspace without a valid live webhook.

### 3. Mass deletion was removed from foreground connect and reset

Connect and reset now return success once the live subscription is ready. Older matching subscriptions are recorded as pending cleanup rather than causing an HTTP 500.

### 4. Automatic stale-subscription cleanup

The existing 15-minute Yoco health task now calls `cleanupStaleYocoWebhookSubscriptions`. It preserves the current live subscription and removes stale KCP subscriptions in the background. If Yoco rate-limits the cleanup, the next scheduled health run tries again.

### 5. Rate-aware Yoco webhook writes

Webhook create and delete operations now retry HTTP 429 responses, respect Yoco retry headers when supplied, and use bounded exponential backoff.

### 6. Paced deletion

Background stale-subscription deletion is sequential and paced rather than sending a burst of delete requests.

### 7. Healthy subscription reuse

When the stored webhook still exists remotely, matches the required URL and events, and KCP still has its signing secret, KCP reuses it instead of replacing it.

### 8. Duplicate catalogue sync removed

The admin Connect action now uses the catalogue result already returned by the connect endpoint. It no longer calls `/yoco/sync-catalogue` a second time.

### 9. Clear admin result

The admin console reports when the live webhook is active but stale subscription cleanup remains scheduled. Cleanup warnings no longer convert a successful connection into a failure.

## Required live events

The subscription remains restricted to:

- `order.completed`
- `order.updated`
- `payment.refunded`

## Deployment

```bash
npm ci
npm --prefix cloudflare-v2 ci
npm run deploy:worker
npm run verify:worker-release
npm run build
npx wrangler pages deploy dist --project-name kcp-live
```

Expected verification:

```text
Worker release verified: phase72-yoco-webhook-rate-limit-safe
Refund pipeline: live-refund-v3
```

## Recovery after deployment

1. Hard refresh the admin console.
2. Confirm Backend Release shows `phase72-yoco-webhook-rate-limit-safe`.
3. Click Webhook Reset once. Do not repeatedly reset while a Yoco rate-limit window is active.
4. A success with a cleanup warning is acceptable. It means the replacement webhook is live and older subscriptions will be removed automatically.
5. Click Retry Live Refunds once to replay the refund that was received but not applied.
6. Confirm refund reporting, VAT/net/gross values, returned stock, and refund stock movements.

## Validation

- 481 automated tests passed.
- Worker TypeScript typecheck passed.
- Production frontend build passed.
- Wrangler deployment dry run passed.

## Files changed

- `cloudflare-v2/src/legacy/yoco-client.ts`
- `cloudflare-v2/src/legacy/yoco-service.ts`
- `cloudflare-v2/src/legacy/admin-routes.ts`
- `cloudflare-v2/src/legacy/routes.ts`
- `cloudflare-v2/src/release.ts`
- `public/KCP Admin ConsoleByYOCO.html`
- `scripts/verify-worker-release.mjs`
- `src/phase71YocoRefundLiveRecovery.test.js`
- `src/phase72YocoWebhookRateLimitSafety.test.js`
