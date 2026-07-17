# Rollback Instructions

This release is additive. Rollback does not require deleting V2 history or changing legacy processing.

## Fast UI rollback

Deploy the previous Pages artifact. The previous admin console will stop showing the new **Yoco V2 Engine** section, while the Worker and append-only data can remain in place.

```bash
# From the previously approved release checkout/artifact
npm install --no-audit --no-fund
npm run build
npx wrangler pages deploy dist --project-name kcp-live
```

## Worker rollback

Deploy the previously approved Worker release:

```bash
# From the previously approved Worker checkout/artifact
npm install --no-audit --no-fund --prefix cloudflare-v2
npm --prefix cloudflare-v2 run typecheck
npm --prefix cloudflare-v2 run deploy
```

## Configuration-only disable

To hide the V2 admin surface without rolling back code, remove the affected workspace IDs from `YOCO_V2_ADMIN_ENABLED` and deploy the Worker configuration.

Do not change:

- legacy Yoco connection state
- legacy webhook subscriptions
- effect ownership
- live sale or refund flags
- queue contents

## Database rollback policy

Do not drop `yoco_v2_webhook_receipts` or `yoco_v2_admin_actions`. They are append-only operational and audit history. Leaving the additive migration installed is safe when the UI or Worker is rolled back.

No rollback step should delete:

- raw events
- processing runs
- timelines
- API requests
- comparisons
- reconciliation runs/findings
- manual reviews
- admin action records

## Validation after rollback

1. Open **Legacy Yoco Integration**.
2. Confirm webhook status and normal legacy processing.
3. Confirm a new sale follows the same legacy deduction path as before.
4. Confirm no effect-ownership row changed.
5. Confirm all four live V2 flags remain at their pre-release values.
6. Confirm the previous Worker release identifier is visible.
