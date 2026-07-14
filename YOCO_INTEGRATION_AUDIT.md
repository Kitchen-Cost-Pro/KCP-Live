# Yoco Webhook and Sales Reconciliation Audit

Date: 14 July 2026  
Release: Phase 61 - Yoco Sales Reconciliation and Initial-Sync Boundary

## Scope audited

- Customer Yoco connection and initial catalogue import
- Webhook delivery, order resolution, event status, and stock deduction
- Yoco order-list retrieval and date/status filtering
- Admin 2-day and 14-day sales reconciliation
- Recovery of orders already represented in webhook logs
- Go Live, initial sales baseline, cursor overlap, retries, and duplicate protection
- Customer and admin integration controls

## Confirmed root causes

1. **A webhook could show `PROCESSED` with zero stock movements.** Receipt and signature verification were treated as successful processing even when stock depletion was disabled, the order was not considered complete, or recipe/product mapping produced no deduction.
2. **Admin reconciliation depended too heavily on the filtered Yoco order list.** When an account returned an empty result for the supplied order filters, KCP reported zero orders even though payment webhooks had already supplied recoverable order or payment references.
3. **Payment-shaped webhooks were not always resolvable.** Some events identify the payment first. The direct `payment_id` order lookup could return no rows, and there was no bounded unfiltered fallback in the live webhook path.
4. **Webhook recovery excluded payment-only events.** Admin recovery required a stored order ID, so a valid payment event with no resolved order ID could be ignored.
5. **Initial connection had no permanent sales boundary.** Connection skipped historical sales, but later cursor overlap could look behind the moment of connection.
6. **The customer Integrations page exposed an unnecessary manual sales-sync control.** Recovery and retrospective reconciliation should be an admin operation, not a customer setup action.
7. **The errored-order audit query contained duplicated SQL text.** This could break the recovery action at runtime despite passing TypeScript validation.

## Corrections implemented

### Initial connection and catalogue setup

- Initial Yoco connection now always imports the catalogue only.
- The hidden `syncSalesOnConnect` path was removed.
- A dedicated `sales_baseline_at` is created on initial connection and added through append-only tenant migration 18.
- Normal automatic reconciliation and its six-hour overlap cannot cross the initial baseline.
- Explicit admin reconciliation may inspect an older selected period, while the Go Live timestamp remains the final stock-deduction guard.
- Customer messaging clearly states that historical sales were not imported.

### Live webhook deduction

- A webhook is now marked `processed` only when:
  - stock movements were created;
  - the order was safely identified as an already-processed duplicate; or
  - the event was intentionally ignored, in which case it uses `ignored` rather than `processed`.
- Zero-movement outcomes now use `attention` with an explicit reason, including:
  - stock depletion is not live;
  - order not yet paid/completed;
  - missing recipe or product mapping;
  - unresolved Yoco order.
- Order readiness recognises final order and payment states from top-level and nested payment data instead of requiring only the exact word `completed`.
- Payment-created webhooks first attempt the direct payment lookup, then inspect up to five normal order pages and match the payment locally.
- Once a payment reference resolves to an order, the webhook row is corrected to the actual order ID.

### Admin sales reconciliation

- Admin controls are now **Reconcile Sales - 2 Days** and **Reconcile Sales - 14 Days**.
- They call the explicit `reconcile-sales` action with a fixed lookback rather than depending on the rolling customer cursor.
- Order discovery now attempts:
  1. updated-at window;
  2. created-at window;
  3. bounded unfiltered pages with local date filtering.
- Reconciliation also scans recent payment/order/sale webhook rows, including rows with no stored order ID.
- It resolves the raw webhook payload, direct order references, and payment references, then merges and deduplicates these orders with the normal order-list results.
- Existing webhook rows are updated after reconciliation to show the real deduction result and movement count.
- The result reports list-sourced orders, webhook candidates, webhook-recovered orders, discovery strategy, load failures, retryable orders, and stock movements.
- Cursor advancement is blocked when retryable orders, processing errors, or unresolved webhook-backed orders remain.
- The malformed duplicated `FROM yoco_webhook_events` recovery query was repaired.

### Integration controls

- The customer-facing manual **Sync Sales** button and event handler were removed.
- Catalogue sync remains available on the customer integration.
- Admin connection saves credentials, establishes the webhook, and imports the catalogue without importing sales.
- **Restart Sync** still performs webhook replacement, catalogue refresh, and a controlled two-day reconciliation.

## Expected diagnostic behavior after deployment

A `payment.created` row must no longer show a blank-message `PROCESSED` state when no deduction occurred. It will show one of these outcomes:

- `PROCESSED` — stock movements were created;
- `PROCESSED` — already deducted, duplicate safely skipped;
- `ATTENTION` — order found but not ready, Go Live disabled, or mapping/recipe issue;
- `FAILED` — order/API processing failed;
- `IGNORED` — order predates the baseline or Go Live activation.

The admin reconciliation toast and log will separately report:

- unique orders found;
- orders returned by the Yoco list;
- webhook candidates;
- orders recovered from webhook references;
- stock movements created;
- retryable or unresolved orders.

## Validation completed

- Automated suite: **423 passed, 0 failed**
- Frontend production build: **passed**
- Cloudflare Worker TypeScript check: **passed**
- Wrangler Worker deployment dry run: **passed**

The frontend build emits existing chunking warnings for modules that are both statically and dynamically imported. These warnings are unrelated to the Yoco changes and do not fail the build.

## Deployment and recovery sequence

1. Deploy the Worker first so tenant migration 18 and the new webhook/reconciliation logic are active.
2. Deploy the Pages frontend/admin console.
3. In Admin Console, run **Restart Sync** once for the affected workspace.
4. Run **Reconcile Sales - 2 Days**. Use 14 days only when the missed order is older.
5. Review the Yoco Integration Log:
   - `ordersFromList` may be zero;
   - `ordersLoadedFromWebhookReferences` should recover known webhook orders;
   - `stockMovements` must be greater than zero for a successfully mapped sale.
6. Any remaining `ATTENTION` row will now state the exact blocking reason. Correct the mapping/recipe or enable Go Live, then run **Resync Errored Orders**.

## Environment limitation

The release was audited, compiled, and tested locally. No production Cloudflare account or live Yoco credentials were available in the audit environment, so the live subscription and affected orders could not be replayed here.
