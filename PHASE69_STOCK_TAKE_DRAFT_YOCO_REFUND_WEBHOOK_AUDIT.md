# Phase 69 Stock Take Draft and Yoco Refund Webhook Audit

## Scope

This phase fixes two production issues:

1. Session stock-take drafts lost custom UOM entries and displayed an incorrect base count and variance after resuming.
2. Yoco refunds were recoverable through the admin reconciliation flow but did not reliably complete stock and reporting updates from live webhooks.

## Stock Take Draft Findings

### Root cause

The stock-take screen keeps UOM counts as a keyed object while the user is editing, for example:

```json
{
  "base": 2,
  "Case": 3
}
```

The draft serializer converted an object with `Object.values()`. That discarded the keys (`base`, `Case`) before the payload was stored. The total `shelfCount` remained, so the resumed session treated the full converted total as a base-UOM count. The serializer also removed the saved system quantity, variance, unit cost, and variance value fields.

The resume editor had a second issue: persisted UOM rows are arrays, but the edit handler spread the array as an object. This produced numeric keys rather than UOM names.

### Fix

- Preserve object-map keys when serializing stock-take UOM counts.
- Accept both the live object-map shape and the persisted array-row shape.
- Preserve `stockItemName`, `systemStock`, `variance`, `cost`, and `varianceImpactEx` in draft items.
- Convert persisted UOM arrays back into an editable keyed map when a resumed count is changed.
- Keep the existing legacy fallback only for old drafts that contain a total count but no UOM breakdown.

### Old draft limitation

A draft saved before this release may already have lost its custom-UOM breakdown. The total base-equivalent count can still be present, but the original split between base and custom UOMs cannot be reconstructed if it was never stored. New and re-saved drafts preserve the full breakdown.

## Yoco Refund Webhook Findings

### Events used by KCP

The active business webhook subscription is now created with:

```text
order.completed
order.updated
payment.refunded
```

- `order.completed` remains the final live sale-deduction trigger.
- `payment.refunded` starts the staged refund workflow.
- `order.updated` re-reads the order after Yoco has attached or changed returned-line information, allowing a pending refund to complete without an admin sync.

The previous `refund.succeeded` subscription value was removed. That event name belongs to the separate Checkout refund flow and is not the business webhook event shown in the Yoco event-definition list used by this integration.

### Why payment.refunded alone was insufficient

The refund notification identifies the order and payment. Exact stock reversal still depends on the refreshed order containing the returned line, returned quantity, tax information, and original modifiers. These details can become available after the first refund notification.

Phase 68 already performed staged payment and order fetches and scheduled bounded retries. Phase 69 adds `order.updated` as a second-stage live signal. This closes the gap where admin sync worked later but the initial webhook did not complete the physical return.

### Processing rules

- `payment.refunded` runs the refund workflow.
- `order.updated` never deducts a sale again.
- An `order.updated` event with refund data runs exact, idempotent refund processing.
- An ordinary `order.updated` event with no refund is marked ignored and does not create a retry loop.
- Pending and failed `order.updated` refund-refresh events are included in Durable Object recovery checks.
- Existing provider refund IDs and stock movement signatures continue to prevent duplicate financial rows and duplicate stock movements.

## Files Changed

- `src/services/stockTakeService.js`
- `src/main.js`
- `cloudflare-v2/src/legacy/routes.ts`
- `cloudflare-v2/src/legacy/yoco-service.ts`
- `cloudflare-v2/src/legacy/yoco-sales.ts`
- `cloudflare-v2/src/workspace-do.ts`
- `src/phase62YocoCompletedOrderDeductionAudit.test.js`
- `src/phase69StockTakeDraftRefundWebhookRefresh.test.js`

## Deployment and Recovery

1. Deploy the Pages frontend and Cloudflare Worker from this package.
2. In the KCP admin integration controls, reset/reinitialise the Yoco webhook once. This deletes the old subscription and recreates it with `order.completed`, `order.updated`, and `payment.refunded`.
3. Run **Resync Errored Orders** once to recover refund events that were already received before the new subscription and handler were deployed.
4. Test a new two-line order by refunding one line only. Confirm:
   - the selected line and its modifiers are handled according to the refund reason;
   - the other line is unchanged;
   - the gross refund, VAT, and ex-VAT values appear in reporting;
   - the live webhook log shows the refund workflow completed rather than requiring a manual sync.
5. Create a stock-take session with a base-UOM count and at least one custom-UOM count, save it as a draft, resume it, and confirm the separate counts and variance remain visible.

## Validation

- 468 automated tests passed.
- Frontend Vite production build passed.
- Cloudflare Worker TypeScript check passed.
- Wrangler deployment dry run passed.
- No production deployment or live Yoco transaction was performed from the audit environment.
