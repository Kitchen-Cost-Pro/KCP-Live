# KCP Live Phase 65
## Yoco Refund, Stock Movement, Modifier, Wastage, and Sales Reporting Audit

Date: 14 July 2026

## Executive Summary

The Phase 64 refund implementation was not safe for line-level restaurant refunds. A partial amount could be spread proportionally across every order line, later refunds on the same order could overwrite the earlier financial refund row, modifier ingredients could be missed when the refund payload omitted modifier details, and a damaged-item refund could appear as a second physical stock deduction.

Phase 65 replaces that behavior with provider-refund-level financial records, exact line resolution, modifier-aware reversal, atomic stock restoration for returnable items, and accounting-only wastage movements for damaged or scrapped items.

## Required Refund Behavior

| Yoco reason | KCP handling | Physical stock effect | Sales reporting | Wastage reporting |
|---|---|---:|---|---|
| Accidental Charge | Return | Restore selected item and modifiers | Refund shown | No |
| Customer Changed Their Mind | Return | Restore selected item and modifiers | Refund shown | No |
| Incorrect Amount | Return | Restore selected item and modifiers | Refund shown | No |
| Service Not Delivered | Return | Restore selected item and modifiers | Refund shown | No |
| Damaged or Defective | Scrap / Wastage | No second deduction and no restoration | Refund shown | Yes |
| Other with waste, wastage, scrap, damaged, defective, discarded, spoiled, contaminated, unusable, destroyed, or throw-away wording | Scrap / Wastage | No second deduction and no restoration | Refund shown | Yes |
| Other without scrap or wastage wording | Return | Restore selected item and modifiers | Refund shown | No |

## 1. Critical Bug Findings

### 1.1 Partial refund amounts were spread across the entire order

The old logic calculated a refund proportion from the refunded amount and scaled every order line. On a bill containing a burger and a drink, refunding only the drink could reverse a fraction of both products and all associated ingredients.

Phase 65 removes proportional spreading. It resolves refund lines using this priority:

1. Explicit refunded line identifiers or references.
2. Exact product and variant identifiers.
3. A unique exact line name.
4. The matching refund entry embedded in the refreshed order.
5. A unique exact subset of original line amounts.
6. Full-order reversal only when the refund is explicitly full or equals the order amount.

An ambiguous partial refund is recorded financially but stock is not changed until the line can be identified. This is safer than altering the wrong stock item.

### 1.2 Multiple refunds on one order overwrote one financial row

The old data model treated the order ID as the refund transaction identity. A second refund for the same bill could overwrite the first refund's amount, reason, and timestamp.

Each refund is now stored under a unique reporting key:

```text
{orderId}:refund:{providerRefundId}
```

The original receipt remains available through `parent_yoco_order_id`, while `provider_refund_id` identifies the exact Yoco refund.

### 1.3 Scrap refunds could be reported as a second stock deduction

The sale already removed the burger ingredients from physical stock. Recording a damaged refund with another negative stock quantity would double-deduct stock.

Phase 65 records a scrap refund as:

```text
quantity_delta = 0
value_delta = negative wastage cost
metadata.accountingOnly = true
metadata.wastageQty = scrapped ingredient quantity
```

This preserves the original sale deduction, adds the wastage cost and quantity to reporting, and does not change the stock balance again.

### 1.4 Modifier ingredients were not reliably handled

Yoco refund payloads may identify the refunded order line without repeating the original modifier selection. That could restore a burger recipe but fail to restore or scrap the extra onion.

Phase 65 merges the original line's modifiers into the resolved refund line when modifier detail is absent. When modifier detail is explicitly supplied, the refund payload remains authoritative.

### 1.5 Financial and stock reports could join refund movements to the original sale

Movement filters and modifier aggregation previously used the original order ID. Refund movements could therefore be mixed into the original sale row or hidden by filters.

All refund movements now include `metadata.reportOrderKey`, and reporting joins by that key before falling back to `document_id`.

### 1.6 Modifier reporting converted refund values into sale-like positive values

Refund VAT, net sales, quantities, and stock reversals must retain their sign. Phase 65 preserves negative refund financial values, separates refunded selections from sale selections, records return stock quantities as reversals, and records scrap modifiers as zero physical stock change with a separate wastage quantity.

## 2. Security, Idempotency, and Race Condition Controls

### Provider refund idempotency

Migration 20 adds a unique partial index on:

```sql
(workspace_id, provider_refund_id)
```

Each recipe or modifier component signature also includes the provider refund ID. Replayed `refund.succeeded` events therefore cannot restore stock twice or create duplicate wastage movements.

### Final-event filtering

Only final refund events enter the refund processor. Pending, created, and processing events wait. Failed and unrelated events are retained for diagnostics but do not change stock.

Supported final refund event names include:

```text
refund.succeeded
refund.successful
payment.refunded
```

Yoco documents `refund.succeeded` as the final asynchronous confirmation for a successful refund.

### Atomic stock restoration

Returnable refunds use the existing atomic balance and movement batch. A positive balance update and its ledger movement are committed together through the workspace database transaction boundary.

### No physical write for scrap

Scrap refunds deliberately skip the stock balance update. They insert only an accounting-only wastage movement with `quantity_delta = 0`.

### Ambiguous line safety

A partial refund without a uniquely identifiable order line is marked retryable. The financial refund remains visible, but KCP does not guess which stock to restore or scrap.

## 3. Hardened Processing Flow

```ts
const refund = extractYocoRefund(webhookPayload);
const disposition = yocoWebhookEventDisposition(eventType);

if (disposition !== 'refund') {
  return handleNonRefundDisposition(disposition);
}

const order = await fetchOrMergeOriginalOrder(refund);
const behavior = resolveRefundReturnBehavior(refund);
const resolution = resolveRefundLineItems(order, refund);

await storeSeparateRefundFinancialTransaction({
  providerRefundId: refund.id,
  parentOrderId: order.id,
  amount: refund.amount,
  reason: refund.reason,
  behavior
});

if (resolution.source === 'unresolved') {
  return markRetryableWithoutChangingStock(resolution.reason);
}

for (const refundedLine of resolution.lines) {
  const components = buildSaleComponentsWithOriginalModifiers(refundedLine);

  if (behavior === 'return') {
    await restoreComponentsAtomically(components);
  } else {
    await recordAccountingOnlyWastage(components);
  }
}
```

## 4. Database Schema Changes

Migration 20 adds:

```sql
ALTER TABLE yoco_orders ADD COLUMN parent_yoco_order_id TEXT;
ALTER TABLE yoco_orders ADD COLUMN provider_refund_id TEXT;
ALTER TABLE yoco_orders ADD COLUMN refund_reason TEXT;
ALTER TABLE yoco_orders ADD COLUMN refund_behavior TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_yoco_orders_workspace_provider_refund
  ON yoco_orders(workspace_id, provider_refund_id)
  WHERE COALESCE(TRIM(provider_refund_id), '') <> '';

CREATE INDEX IF NOT EXISTS idx_yoco_orders_workspace_parent_order
  ON yoco_orders(workspace_id, parent_yoco_order_id, occurred_at);
```

No integer cast is applied to Yoco order, payment, line, or refund IDs. They remain text identifiers.

## 5. Reporting Changes

### Payment and Sales Financial Report

Each refund appears as a separate negative financial transaction with:

- Original receipt number
- Provider refund ID
- Refund reason
- Refund handling decision
- Refund amount
- Refund VAT and net amount
- Refund timestamp

### Sale Stock Movement Report

Returnable refund:

- Movement type: Refund Return
- Positive physical stock change
- Negative usage reversal
- Selected order line only
- Selected line modifiers included

Scrap refund:

- Movement type: Refund Scrap
- Physical stock change: zero
- Wastage quantity shown separately
- Wastage value shown
- Selected order line only
- Selected line modifiers included

### Wastage Report

Accounting-only refund scrap movements are included even though their physical `netQty` is zero. The report reads `metadata.wastageQty` and the negative wastage value.

### Modifier Report

The report now exposes:

- Transaction type
- Refund ID
- Refund reason
- Refund handling
- Sale selections
- Refunded selections
- Net selections
- Stock quantity reversal
- Wastage quantity
- Refund amount

## 6. Files Changed

Worker and database:

- `cloudflare-v2/src/legacy/yoco-sales.ts`
- `cloudflare-v2/src/legacy/yoco-webhooks.ts`
- `cloudflare-v2/src/legacy/yoco-service.ts`
- `cloudflare-v2/src/legacy/routes.ts`
- `cloudflare-v2/src/legacy/reporting-routes.ts`
- `cloudflare-v2/src/tenant-migrations.ts`

Frontend reporting:

- `src/modules/reporting/api/reportingMappers.js`
- `src/modules/reporting/reports/sales/paymentSalesFinancialReport.js`
- `src/modules/reporting/reports/sales/saleStockMovementReport.js`
- `src/modules/reporting/reports/sales/salesReportHelpers.js`
- `src/modules/reporting/reports/sales/modifierReport.js`
- `src/modules/reporting/reports/operations/wastageReport.js`
- `src/modules/reporting/reports/operations/detailedActivityReport.js`

Regression tests:

- `src/phase65YocoRefundStockReportingAudit.test.js`
- Updated older Yoco recovery tests for the corrected refund model

## 7. Validation Completed

- 446 automated tests passed
- 0 automated tests failed
- Vite production build passed
- Cloudflare Worker TypeScript passed
- Wrangler deployment dry run passed
- Executable refund helper checks passed for:
  - every required reason classification
  - nested `Other` notes containing waste language
  - exact line-level partial refund
  - modifier preservation
  - explicit zero refunded quantity
  - unique amount inference
  - ambiguous equal-price line protection
  - final refund event disposition

## 8. Deployment and Live Verification

1. Deploy the Worker first so migration 20 runs before new refund rows are written.
2. Deploy the frontend reporting build.
3. Use the admin integration reset or resubscribe action so the active Yoco subscription includes `refund.succeeded` and `payment.refunded`.
4. Run one live test for each scenario:
   - one-line returnable refund
   - one-line damaged refund
   - partial refund on a two-item bill
   - burger with a stock-deducting modifier, returned
   - burger with a stock-deducting modifier, scrapped
   - two separate refunds against the same original order
5. Confirm balances and reports after each test.

This package was validated locally and through Wrangler dry run. It was not deployed to production and no live Yoco refund was executed from this environment.
