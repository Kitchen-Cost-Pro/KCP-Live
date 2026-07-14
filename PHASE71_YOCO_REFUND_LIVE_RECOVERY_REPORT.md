# Phase 71: Yoco Refund Live Recovery

## Finding from the production screenshot

The production log shows `payment.created` as `PROCESSED` with no explanatory message.

That result cannot be produced by the Phase 70 Worker code. In Phase 70, `payment.created` is deliberately stored as `attention` with a message that KCP is waiting for `order.completed`.

This means the production webhook endpoint is still running an older Cloudflare Worker, even if the latest Pages frontend was deployed. The webhook logic runs in `kcp-api-v2`, not in the Pages bundle.

A second defect was also present in Phase 70. If an older handler marked `payment.refunded` as `processed` without creating a refund reporting transaction, the Durable Object alarm only counted `attention` and `failed` rows. The event therefore did not receive the immediate 15-second replay and could remain stranded until a later scheduled reconciliation.

## Fixes implemented

### 1. Immediate recovery of incorrectly processed refund events

The Durable Object retry scheduler now treats a `payment.refunded` event as actionable when:

- its status is `attention` or `failed`
- its processing lease has been stuck for more than five minutes
- its status is `processed`, but no linked refund transaction exists in `yoco_orders`

This means a refund cannot be considered complete merely because the webhook row says `processed`.

### 2. Automatic replay now starts for the exact failure shown

Every Yoco webhook request still reaches the Durable Object `finally` block. The updated actionable-event query now detects the stranded processed refund and schedules the retry alarm immediately.

The existing 15-minute global integration health job remains a second recovery layer.

### 3. Correct payment correlation

Refund ingestion previously preferred `refund.id` over `refund.payment_id` when populating the payment identifier. It now stores the original Yoco payment ID first and keeps the refund ID as the separate refund identity.

### 4. Backend release verification

The Worker now exposes:

`GET /api/runtime-version`

Expected result:

```json
{
  "workerRelease": "phase71-yoco-refund-live-recovery",
  "refundPipelineVersion": "live-refund-v3"
}
```

The admin integration panel also displays the active backend release. If Pages is updated but the Worker is not, the integration status changes to red and explicitly states that the backend Worker is outdated.

### 5. Targeted admin recovery action

A new `Retry Live Refunds` button replays only pending or stranded refund webhooks. It does not require a full sales resync.

Endpoint:

`POST /api/admin/workspaces/:workspaceId/yoco/retry-refunds`

### 6. Better integration log output

A processed refund webhook without an outcome message now displays a warning-style explanation instead of a blank dash. New webhook processing logs include the Worker release, refund pipeline version, reporting result, stock movement count, payment ID, and order ID.

## Required deployment

Deploying the Pages site alone will not update refund handling. The Cloudflare Worker must be deployed from the `cloudflare-v2` package.

```bash
npm ci
npm --prefix cloudflare-v2 ci
npm run deploy:worker
npm run verify:worker-release
```

The last command must print:

```text
Worker release verified: phase71-yoco-refund-live-recovery
Refund pipeline: live-refund-v3
```

Then deploy the Pages frontend through the normal KCP Pages process so the admin console can display the release check and targeted retry button.

After both deployments:

1. Open the admin integration panel.
2. Confirm `Backend Release` is green and reads `phase71-yoco-refund-live-recovery`.
3. Click `Retry Live Refunds` once to recover the refund already visible in the screenshot.
4. Refresh the Payment Summary, Sale Stock Movement, and stock balance views.
5. Run one new single-item refund. The log must show either a completed movement count or a specific `attention` reason. It must not show `PROCESSED` with a blank message.

## Verification completed

- 476 automated tests passed
- Worker TypeScript typecheck passed
- Vite production build passed
- Wrangler deployment dry run passed
- No schema migration is required
