# Phase 73: Yoco Refund Original Order Resolution

Date: 14 July 2026

## Problem confirmed from the live integration log

The webhook connection is working. KCP received both of the relevant live events:

- `payment.refunded`
- `order.completed`

The remaining failure was identifier handling.

Yoco's `payment.refunded` payload provides a refund order reference and a payment reference. The refund order is not the original completed sale order. It can exist without the original sale `line_items`, which is why the log showed `order_has_no_line_items` even though the sale had already deducted stock correctly.

Phase 72 used the webhook `order_id` as the order to fetch and process. That caused two symptoms:

1. The refund-order `order.completed` event was treated as a new sale and entered attention because it had no sale lines.
2. The refund handler could request the wrong Yoco resource and record `The requested resource does not exist` instead of resolving the original sale.

## Correct refund relationship

The live pipeline now distinguishes these identifiers:

- **Refund order ID:** `payment.refunded.order_id`
- **Payment ID:** `payment.refunded.payment_id`
- **Original sale order ID:** `payment.order_id` or `refund.original_order_id`

Stock and reporting processing always use the original sale order because that is the resource containing the sold line items, linked returns, recipe mappings, location, and original stock deduction context.

## Implementation

### Shared refund context resolver

Added:

`cloudflare-v2/src/legacy/yoco-refund-context.ts`

The resolver performs this bounded sequence:

1. Fetch the payment using the webhook `payment_id`.
2. Read the original sale order from `payment.order_id`.
3. Read `refund.original_order_id` when refund detail is available.
4. Use a recent approved-refund lookup as a fallback when the payment detail is not yet available.
5. Fetch the original sale order, never the refund order, for stock processing.
6. Fall back to KCP's cached sale using either original order ID or payment ID. This is safe because the successful sale deduction already persisted the original order and its lines.
7. Merge the approved refund detail into the original sale before calling the existing refund and returned-line matching logic.

### Live webhook route

The webhook route now:

- treats `payment.refunded.order_id` as a refund order reference;
- resolves the original sale before running stock or reporting logic;
- converts a line-less refund `order.completed` event into `refund_refresh` instead of treating it as a broken sale;
- keeps temporary Yoco 404 responses retryable rather than marking the refund permanently failed;
- updates the webhook event record with the resolved original sale order ID.

### Targeted retry

`Retry Live Refunds` now:

- reads the raw webhook's refund order ID and payment ID;
- resolves the original sale through the shared resolver;
- replaces the stored event order ID with the original sale ID;
- processes the refund through the existing idempotent refund path;
- preserves attention status when approved refund or returned-line data has not appeared yet;
- does not perform a complete sales resync and does not duplicate stock movements.

### Yoco client support

Added one-page refund list methods for the bounded fallback lookup:

- `listRefundsPageOnce`
- `listRefundsPage`

The live webhook uses the single-attempt method so it controls rate-limit behaviour. Background retry uses the standard bounded retry wrapper.

## Release identifiers

- Worker release: `phase73-yoco-refund-original-order-resolution`
- Refund pipeline: `live-refund-v4`

## Validation

Completed successfully:

- 486 automated tests passed
- Worker TypeScript typecheck passed
- Vite production build passed
- Wrangler Worker deployment dry run passed

Build warnings about existing chunk sizes and mixed static/dynamic imports remain warnings only. They are unrelated to refund processing.

## Deployment

Run from the extracted Phase 73 folder:

```bash
npm ci
npm --prefix cloudflare-v2 ci
npm run deploy:worker
npm run verify:worker-release
npm run build
npx wrangler pages deploy dist --project-name kcp-live
```

Expected Worker verification:

```text
Worker release verified: phase73-yoco-refund-original-order-resolution
Refund pipeline: live-refund-v4
```

## Recovery steps after deployment

1. Hard refresh the KCP admin console.
2. Confirm Backend Release is `phase73-yoco-refund-original-order-resolution`.
3. Click **Retry Live Refunds** once.
4. Do not reset or reconnect Yoco again.
5. Confirm the failed `payment.refunded` event changes to either:
   - `PROCESSED`, when Yoco has exposed the approved refund and exact returned lines; or
   - `ATTENTION`, with a specific message that the original sale or returned-line detail is not yet available.
6. Confirm stock was returned only for the refunded quantity and that Gross Refund, Refund VAT, Refund Ex VAT, Net Sales, and payout reporting updated.

The existing failed webhook row is eligible for the targeted retry, so a new sale or a full resync is not required to recover it.
