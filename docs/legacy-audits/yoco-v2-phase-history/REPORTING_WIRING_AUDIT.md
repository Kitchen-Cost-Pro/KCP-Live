# Yoco V2 Reporting Wiring Audit

Date: 2026-07-16. Scope: verify every report that depends on Yoco integration data reads fields
the V2 engine actually writes (`yoco_orders`, `yoco_order_lines`, `stock_movements`).

## Verdict

- **Money reporting is correctly wired to V2.** Sales Financial reads the persisted
  `yoco_orders` columns 1:1 and refunds are stored negative and re-signed by the reporting engine.
- **Stock-usage / modifier reporting is partially broken for V2 *sales*** because the V2 sale
  writer's `stock_movements.metadata_json` uses different (and fewer) keys than the reports read.
  This is the outstanding backlog item; it is **deferred** (not fixed in the 2026-07-16 round).
- Two contained items were fixed in this round: the **missing sale payment method** and the
  **Detailed Activity ledger join** (see "Fixed" below).

## What the V2 engine writes

- Sale `yoco_orders` (`live-sale.ts` applyReporting): `order_type='sale'`, positive
  `total/gross_total/vat_total/net_total`, `payment_method` (now resolved), `status`, `location_id`,
  `occurred_at` (+02:00), `raw_json.kcp_v2`.
- Refund `yoco_orders` (`live-refund.ts` applyReporting): `order_type='refund'`, negative totals,
  `parent_yoco_order_id`, `provider_refund_id`, `refund_reason`, `refund_behavior`, `payment_method`
  (now written), `yoco_order_id = <source_order_id>:refund:<refund_id>`.
- `stock_movements`: sale `movement_type='sale_depletion'` (negative qty), refund `'sale_refund'`
  (positive), `document_id = source_order_id`, `created_by='yoco-v2'`, plus a `metadata_json` object.

## Report-by-report

| Report (worker: `legacy/reporting-routes.ts`) | Reads | V2 wired? | Notes |
|---|---|---|---|
| Sales Financial | `yoco_orders` totals/order_type/status/payment_method/refund fields; `raw_json.kcpRefund` | ✅ Yes | Fully correct. Refund re-signing via `yocoFinancials.js`. Payment method fixed this round. |
| Sale Stock Usage | `stock_movements` joins via `metadata.reportOrderKey`, `componentLineId`, `productId`/`parentProductId`; classifier reads `componentType` | ⚠️ Partial | V2 **sale** metadata lacks these keys → product/line attribution lost, modifier depletions mislabeled as product. V2 **refund** mostly wired but lacks `componentLineId`. |
| Modifier Usage | filters `metadata.componentType='modifier'`, `modifierId`, `modifierGroupId` | 🔴 Broken for V2 sales | V2 sale writes no `componentType` → excluded; `modifierGroupId` never written by either path. |
| Modifier Sales | `yoco_order_lines`+`yoco_orders`+`products` (ok) + modifier enrichment via `metadata.componentLineId/parentLineId/modifierId` | ⚠️ Partial | Base rows fine; modifier attribution keys absent for V2 sales. |
| Menu Recipe Health | sales stats (ok) + modifier usage via `metadata.parentProductId`+`componentType='modifier'` | ⚠️ Partial | Modifier-usage block blind to V2 sales. |
| Detailed Activity / Stock Ledger | `stock_movements` + `yoco_orders` join | ✅ Fixed | Join corrected this round (see below). |
| Transaction search (sales) | `yoco_orders` refund/id fields (ok); ingredient/modifier `EXISTS` on `metadata` | ⚠️ Partial | Order/refund search fine; `modifierGroupId` filter matches no V2 rows; `modifierId` matches V2 refunds (camelCase) not V2 sales (snake_case). |

## Root cause of the deferred gap

`stock_movements.metadata_json` schema divergence:
- Legacy (`yoco-sales.ts`) wrote: `componentType, productId, parentProductId, componentLineId,
  parentLineId, reportOrderKey, modifierId, modifierGroupId, modifierName, productName, mode`, …
- V2 **sale** writer (`live-sale.ts`) writes only: `engine, effect_type, effect_key, proposal_key,
  domain_event_id, source_line_id, menu_item_id, modifier_id, base_uom, cutover_at` — snake_case,
  no `componentType`, no `reportOrderKey`, no group/parent/name keys.
- V2 **refund** writer (`live-refund.ts`) is richer (`componentType, productId, modifierId,
  reportOrderKey, sourceRefundLineId, sourceOriginalLineId`) but still no `componentLineId`.

## Deferred backlog (follow-up phase)

Align the V2 sale (and refund) `stock_movements.metadata_json` to the report schema:
- Derivable at write time (no new data): `componentType` (from `modifier_id`), `productId`
  (=`menu_item_id`), `componentLineId` (=`source_line_id`/`sourceRefundLineId`),
  `reportOrderKey` (sale=`source_order_id`; refund already set), `mode`.
- Requires capturing more during resolution/shadow (proposal table + `sale-shadow.ts`/`refund-shadow.ts`):
  `modifierGroupId`, `modifierName`, `parentProductId`, `parentLineId`, `productName`.
- The `yoco_v2_proposed_stock_movements` table currently has: `menu_item_id, modifier_id,
  source_line_id, ingredient_item_id, base_uom, unit_cost_ex_vat` — so group/parent/name fields
  need to be added there and populated by the resolver's modifier mapping.

## Fixed on 2026-07-16
- **Sale/refund payment method** resolved from `payments[<approved|first>].payment_method` into the
  canonical event and persisted to `yoco_orders.payment_method` (`sale-resolver.ts`,
  `refund-resolver.ts`, `live-sale.ts`, `live-refund.ts`).
- **Detailed Activity ledger join** (`reporting-routes.ts`): now
  `yo.yoco_order_id = COALESCE(NULLIF(json_extract(sm.metadata_json,'$.reportOrderKey'),''), sm.document_id)`
  so sale and refund movements enrich with their Yoco order (previously joined on `yo.id`, which
  never matched the provider order id stored in `document_id`).
