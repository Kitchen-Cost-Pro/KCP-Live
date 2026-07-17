# Yoco Completed Order and Stock Deduction Audit

Date: 14 July 2026  
Release: Phase 62 - Yoco Completed Order Deduction and Order API Diagnostics

## Problem confirmed

The webhook log proved that Yoco could reach KCP, but it did not prove that KCP had received a final completed order with line items or created stock movements.

The previous subscription used `payment.created` as the main sale event. That event means that a payment record was created. It does not mean that the order is closed and fully paid. KCP could therefore receive and log the event before the order was ready for stock deduction.

The admin reconciliation also relied on order queries that did not prioritise the order completion timestamp. When a filtered request failed or returned no rows, errors could be hidden behind a zero-order result. A discovered order summary could also be used after the full order-detail request failed, leaving KCP with no line items and no useful explanation.

## Confirmed root causes

1. The live webhook subscribed to `payment.created` instead of the final `order.completed` event.
2. The two-day reconciliation did not query `closed_at` first, even though completed orders are finalised at that point.
3. Order API errors could be converted into an empty order result.
4. Payment-to-order recovery relied partly on an undocumented Orders API payment filter instead of first reading the payment and using its `order_id`.
5. A failed full-order fetch could fall back to a list summary with no line items.
6. An order with no line items could return zero movements without a specific retry reason.
7. The webhook test still requested `payment.created`, which no longer matched the corrected subscription.
8. The admin result did not clearly show whether Go Live, product mappings, locations, line items, or API permissions blocked the deduction.

## Corrections implemented

### Final webhook event

KCP now creates the Yoco subscription with:

- `order.completed`
- `payment.refunded`

`order.completed` is the sale trigger used for stock deduction. Existing `payment.created` events from an older subscription are accepted for compatibility, but they are marked as waiting for order completion and do not deduct stock.

The webhook test now sends an `order.completed` test event.

### Completed order discovery

Admin reconciliation now tries these completed-order queries and merges their results:

1. `closed_at` within the selected period with status `completed`
2. `updated_at` within the selected period with status `completed`
3. `created_at` within the selected period with status `completed`
4. A bounded completed-order page scan with local date filtering

The API client preserves repeated query parameters for list filters and deduplicates orders by Yoco order ID.

### Direct webhook recovery

Recent webhook rows are used as a second recovery source.

KCP now:

1. Reads the order ID directly from an order webhook.
2. Reads a payment through `/v1/payments/{payment_id}` when only a payment reference is available.
3. Uses the returned `order_id` to fetch the full order.
4. Merges the resolved order with orders returned by the normal order list.
5. Updates the webhook row with the resolved order ID and the real deduction outcome.

### Full line-item enforcement

A list-order summary is no longer silently processed when the full order request fails.

If the full order cannot be fetched, reconciliation records a clear error and blocks cursor advancement. If Yoco returns an order with no line items, the order is marked retryable with the reason `order_has_no_line_items`.

No zero-line order is recorded as a successful deduction.

### API permission check

Connection and Restart Sync now perform a completed-order read check. A key that cannot read orders fails visibly instead of appearing connected after catalogue access alone.

The relevant Yoco key must include `business/orders:read`.

### Admin diagnostic result

The 2-day and 14-day reconciliation results now show:

- completed orders found
- successful Orders API requests
- orders returned by list queries
- webhook candidates
- orders recovered from webhook IDs or payment IDs
- stock movements created
- retryable orders
- result reason counts
- Go Live state and activation timestamp
- active Yoco products
- mapped Yoco products
- active locations
- recipe line count
- warnings and API errors
- whether the order cursor advanced

This distinguishes an order-fetch problem from a recipe, mapping, location, Go Live, or line-item problem.

## Initial connection behavior

Initial connection still imports catalogue data only.

It does not fetch, import, or deduct historical sales. It records `sales_baseline_at`, and normal background overlap cannot cross that boundary. Admin reconciliation can inspect an explicit earlier period, while the Go Live timestamp remains the final stock-deduction boundary.

The customer-facing manual Sales Sync button remains removed.

## Required deployment and recovery sequence

1. Deploy the Worker.
2. Deploy the Pages frontend and admin console.
3. Run **Restart Sync** for the affected workspace.
4. Confirm that the remote subscription lists `order.completed` and `payment.refunded`.
5. Run **Reconcile Sales - 2 Days**.
6. Review the diagnostic window and the Yoco Integration Log.

Restart Sync is required because an existing remote subscription continues to send its old event types until it is deleted and recreated.

A successful sale must report at least one stock movement or a proven duplicate. A zero-movement result must now contain a specific warning or error.

## Validation completed

- Automated suite: 428 passed, 0 failed
- Frontend production build: passed
- Cloudflare Worker TypeScript check: passed
- Wrangler deployment dry run: passed

The frontend build emits existing chunking warnings for modules that are both statically and dynamically imported. Those warnings are unrelated to this Yoco correction and do not fail the build.

## Environment limitation

The release was audited, compiled, and tested locally. The production Cloudflare account and live Yoco credentials were not available in this environment, so the affected production order could not be replayed here.
