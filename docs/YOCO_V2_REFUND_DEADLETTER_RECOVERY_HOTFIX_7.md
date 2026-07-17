# Yoco V2 Refund Dead-Letter Recovery Hotfix 7

Release: `phase-v2-admin-yoco-engine-control-centre-hotfix-7`

## Incident

A valid `payment.refunded` event was captured and published, reached the V2 queue, retried until exhausted, and then moved to dead letter. Replaying the exhausted event could immediately dead-letter it again.

## Root causes

1. The V2 refund lookup required every available reference to match the same refund row. A correct payment match was rejected when the refund list `order_id` differed from the webhook `order_id`.
2. The lookup searched refund `created_at`, although an approved refund can be updated after its original creation time.
3. Admin replay did not reset the processing-attempt counter for terminal or exhausted events.

## Corrections

- Treat payment ID as the strongest refund correlation key.
- Reject a candidate when its supplied payment ID conflicts with the webhook payment ID.
- Accept payment correlation even when the webhook/refund-list order references differ.
- Use `updated_at__gte`, `updated_at__lte`, and approved status for recent refund discovery.
- Reset attempts for dead-lettered, permanently failed, or exhausted events before replay publication.
- Preserve idempotency, history, timeline, audit identity, and shadow-only processing.

## Safety confirmation

- Legacy refund processing remains active.
- No V2 live stock or reporting flags were enabled.
- All replay messages retain `live_effects: false`.
- No historical processing attempts or dead-letter timeline records are deleted.
- No Wrangler configuration changes are included or required.

## Deployment

From the project root:

```bash
set -e && \
unzip -o KCP-Yoco-V2-Refund-Deadletter-Hotfix-7-Patch.zip -d . && \
(cd cloudflare-v2 && \
  npm install && \
  npm run typecheck && \
  npm test && \
  npm run deploy)
```

## Recover the existing event

1. Open Admin > Yoco V2 Engine > Dead Letter.
2. Locate `msg_3GXvJhOgV5mgBDxYXkYMHMjLEo3`.
3. Select Requeue.
4. Enter a reason and confirm.
5. Refresh Event Inbox, Processing Runs, Refunds, and API Health.

Do not create another refund until this existing event resolves or exposes a new structured error.

## Validation

- TypeScript type-check passed.
- 122 Worker and Yoco V2 tests passed.
- Wrangler deployment dry run passed.
- Queue and dead-letter bindings were present.
- Observation/shadow flags remained enabled for all workspaces.
- All V2 live-effect and legacy-shutdown flags remained disabled.
