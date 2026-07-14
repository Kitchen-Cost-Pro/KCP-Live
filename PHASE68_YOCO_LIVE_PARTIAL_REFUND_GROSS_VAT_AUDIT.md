# Phase 68 Yoco Live Partial Refund, Stock and Gross VAT Audit

## Executive summary

Phase 68 fixes three connected production defects:

1. A `payment.refunded` webhook could be accepted but not update stock until an administrator manually ran reconciliation.
2. A partial refund for one product on a multi-item order could be interpreted as a full-order refund.
3. Reporting could treat the refund value as ex VAT even though the customer receives the full VAT-inclusive gross amount.

The implementation now uses a bounded staged Yoco lookup, exact returned-line matching, automatic Durable Object retry, and separate gross, VAT and ex-VAT accounting fields.

## Yoco API findings

### Webhook payload

Yoco's `payment.refunded` webhook identifies the event using `order_id` and `payment_id`. It does not contain the complete returned product collection.

Source:

- https://developer.yoco.com/api-reference/yoco-api/webhook-events/payment-refunded

### Payment detail

`GET /v1/payments/:payment_id` supplies the payment's `order_id`, cumulative refunded amount and approved refund summaries. This is the correct first enrichment request because it identifies the provider refund records tied to the webhook payment.

Source:

- https://developer.yoco.com/api-reference/yoco-api/payments/fetch-payment-v-1-payments-payment-id-get

### Order detail

`GET /v1/orders/:order_id` supplies the original order lines, refund summaries, and the separate `returns[].returned_line_items` collection. Returned lines contain the exact returned product, returned quantity, taxes and modifiers. Stock must be driven from this returned-line collection rather than inferred from the refund amount.

Source:

- https://developer.yoco.com/api-reference/yoco-api/orders/fetch-order-v-1-orders-order-id-get

### Refund detail

`GET /v1/refunds/:refund_id` supplies a specific refund's amount, note, identifiers and approval status. It does not replace the order fetch for returned product lines. KCP retains this endpoint for targeted enrichment, but the normal live path does not add an unnecessary refund request when the payment and order responses already provide the required data.

Source:

- https://developer.yoco.com/api-reference/yoco-api/refunds/fetch-refund-v-1-refunds-refund-id-get

## Correct live processing sequence

1. Receive and verify `payment.refunded`.
2. Claim the webhook event idempotently.
3. Fetch the payment once using `payment_id`.
4. Identify approved refund summaries and resolve `order_id`.
5. Fetch the order once using `order_id`.
6. Match each refund to an exact `returns[].returned_line_items` record.
7. Apply the configured reason handling:
   - Return: restore only the selected product recipe and selected modifiers.
   - Scrap or wastage: record accounting wastage without restoring stock and without a second stock deduction.
8. Write the refund financial transaction using the VAT-inclusive gross amount.
9. Store VAT and ex-VAT components separately.
10. If Yoco has confirmed the refund but has not exposed the returned lines yet, leave the event pending and schedule an automatic retry after 15 seconds with bounded exponential backoff.

## Critical defects corrected

### Live webhook depended on manual reconciliation

The previous route could reach Yoco before the order's `returns` data was queryable. It then left stock unresolved until the administrator ran the manual retry action.

Phase 68 now performs two tightly bounded order re-reads at 500 ms and 1,250 ms only when the payment shows an approved refund but the order has fewer line-bearing return records. If the data is still unavailable, the workspace Durable Object schedules an automatic retry. This makes the normal path live without creating an API request storm.

### Full-order inference from refund amount

The old logic could infer all original order lines when a monetary value appeared to equal an order total. Yoco exposes several amount concepts, including VAT-inclusive, ex-tip, discounted and return values. Comparing ambiguous totals can make a one-item refund appear equal to the whole order.

Phase 68 removes all amount-only stock selection. A refund changes stock only when:

- exact returned lines are available, or
- Yoco explicitly marks the provider refund as a full refund.

An unresolved amount-only partial refund remains pending instead of guessing.

### Positional pairing of multiple refunds

Refund summaries and return records are not paired by array position when multiple partial refunds exist. Pairing now requires stable identifiers, payment references, unique amount plus timestamp evidence, or a safe one-refund to one-return case.

### Refund amount used ex VAT

The refund shown to the customer and deducted from payout is now the full VAT-inclusive gross amount.

For a R115 refund containing R15 VAT:

- Refund Gross: R115
- Refund VAT: R15
- Refund Ex VAT: R100
- Payout effect: -R115
- Net sales effect: -R100
- VAT effect: -R15

The implementation prefers the exact returned tax values supplied by Yoco. If no returned tax is provided, it uses the workspace VAT rate as a fallback.

## Stock and modifier behaviour

For an order containing:

- Burger
  - Extra Onion modifier
- Soft Drink

If only the Burger is refunded:

- The Burger recipe is reversed according to the refund reason.
- Extra Onion follows the Burger's returned line and is reversed or scrapped using the same reason.
- The Soft Drink remains unchanged.
- The financial refund row contains only the selected refund's gross, VAT and ex-VAT values.

## Reporting changes

### Payment and Sales Financial Report

The affected views now expose:

- Refunds (Gross)
- Refund VAT
- Refund Ex VAT
- Net Sales
- VAT
- Payout Amount

Payout uses:

`Net Sales + Tips - Gross Refunds - Fees`

### Transaction detail

Each refund row includes:

- Original receipt
- Provider refund id
- Refund reason
- Return or wastage handling
- Refund Gross
- Refund VAT
- Refund Ex VAT
- Signed VAT and net values

### Sales and stock reports

- Return refunds show positive physical stock movements for the exact product ingredients and modifiers.
- Scrap refunds show zero additional physical stock movement and separate wastage quantity and value.
- Idempotency keys include the provider refund id, line id, recipe component and direction.

## Database migration

Migration 21 adds signed accounting components to `yoco_orders`:

```sql
ALTER TABLE yoco_orders ADD COLUMN gross_total REAL;
ALTER TABLE yoco_orders ADD COLUMN vat_total REAL;
ALTER TABLE yoco_orders ADD COLUMN net_total REAL;

UPDATE yoco_orders
   SET gross_total = total
 WHERE gross_total IS NULL;

CREATE INDEX IF NOT EXISTS idx_yoco_orders_workspace_refund_financials
  ON yoco_orders(workspace_id, order_type, occurred_at, gross_total);
```

`total` remains the backwards-compatible signed customer amount. Refund rows store gross, VAT and net as negative values in persistence, while report display fields expose positive refund amounts where appropriate.

## Primary files changed

- `cloudflare-v2/src/legacy/yoco-client.ts`
- `cloudflare-v2/src/legacy/routes.ts`
- `cloudflare-v2/src/legacy/yoco-webhooks.ts`
- `cloudflare-v2/src/legacy/yoco-sales.ts`
- `cloudflare-v2/src/workspace-do.ts`
- `cloudflare-v2/src/tenant-migrations.ts`
- `cloudflare-v2/src/legacy/reporting-routes.ts`
- `src/modules/reporting/engine/yocoFinancials.js`
- `src/modules/reporting/engine/reportingIntegrity.js`
- `src/modules/reporting/api/reportingMappers.js`
- `src/modules/reporting/reports/sales/salesReportHelpers.js`
- `src/modules/reporting/reports/sales/paymentSalesFinancialReport.js`
- `src/phase68YocoLivePartialRefundGrossVat.test.js`

## Validation completed

- 464 tests passed
- 0 tests failed
- Vite production build passed
- Worker TypeScript passed
- Wrangler deployment dry run passed
- Package ZIP integrity passed

## Deployment and live verification

This release has not been deployed from the audit environment and no live Yoco refund was executed here.

After deployment:

1. Allow the workspace migration to run.
2. Refund one line from a two-line order.
3. Confirm the webhook event changes to processed without an admin sync.
4. Confirm only the refunded line and its modifiers are restored or recorded as wastage.
5. Confirm the sales report shows the full gross refund, VAT component and ex-VAT component.
6. Confirm payout decreases by the full gross refund.
7. Replay the webhook and confirm no duplicate financial or stock movements are created.
