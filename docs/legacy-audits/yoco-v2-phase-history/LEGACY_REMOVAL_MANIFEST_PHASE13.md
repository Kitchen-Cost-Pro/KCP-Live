# Phase 13 Legacy Yoco Removal Manifest

Status: proposal only. Nothing in this manifest is deleted by Phase 12.

Release proposed after approval: `phase-v2-13-yoco-legacy-removal`

## Classification

Each item must be marked during the retention review as one of:

- `DELETE`
- `PARTIAL_DELETE`
- `PRESERVE`
- `ARCHIVE_THEN_DELETE`
- `REPLACE_BEFORE_DELETE`

## Files and code sections

| Item | Proposed action | Preconditions |
| --- | --- | --- |
| `cloudflare-v2/src/legacy/yoco-sales.ts` | Partial delete of `processYocoOrder`, `processYocoOrderReturns`, legacy refund financial writes, ingredient depletion writes, and legacy effect helpers | All sales and refunds V2-owned, observation approved, no callers remain |
| `cloudflare-v2/src/legacy/yoco-refund-context.ts` | Delete after V2 resolver provides every retained diagnostic need | Refund observation approved and delayed-resource fixtures retained in V2 |
| `cloudflare-v2/src/legacy/yoco-webhooks.ts` | Partial delete of legacy refund extraction and search helpers | Preserve or relocate signature verification before removal |
| `cloudflare-v2/src/legacy/yoco-service.ts` | Partial delete of `syncYocoSales`, `retryFailedYocoOrders`, `retryPendingYocoRefundWebhooks`, and legacy sale/refund recovery helpers | V2 reconciliation and replay proven across fleet |
| `cloudflare-v2/src/legacy/yoco-client.ts` | Partial delete of legacy order/refund fetch and retry wrappers after every caller uses the rate-gated V2 client | Preserve catalogue, connection, or subscription functions until replacements exist |
| `cloudflare-v2/src/legacy/routes.ts` | Delete legacy webhook business branch, sale sync, reconciliation, failed-order retry, refund retry, and manual repair actions | Keep verified ingress routing and nonbusiness connection actions until replacements are approved |
| `cloudflare-v2/src/legacy/index.ts` | Remove dispatch entries for obsolete Yoco business actions | Central and tenant route scans show zero callers |
| `cloudflare-v2/src/workspace-do.ts` | Remove the legacy refund retry alarm and pending-refund scheduling state | V2 queue and DLQ recovery observation approved |
| `cloudflare-v2/src/legacy/admin-routes.ts` | Remove obsolete legacy Yoco business action exposure | V2 admin diagnostics and controls replace all required actions |
| `cloudflare-v2/src/index.ts` | Remove obsolete legacy admin action allowlist entries, but preserve `/webhooks/yoco/:workspaceId` as the V2 ingress unless a reviewed replacement URL is deployed | Subscription verified before and after change |
| `public/KCP Admin ConsoleByYOCO.html` | Remove legacy sync, reconcile, retry, reset, and test actions that are obsolete; replace retained subscription and diagnostics actions with V2 controls | UI dependency review and operator signoff |
| legacy-only frontend integration actions under `src/components/Integrations.js`, `src/services/integrationService.js`, and `src/main.js` | Remove only actions mapped to deleted routes | Frontend route inventory and replacement UX approved |

## Routes and admin actions

### Remove after approval

- `POST /api/workspaces/:workspaceId/yoco/sync-sales`
- legacy `sync-sales` workspace admin action
- legacy `reconcile-sales` workspace admin action
- legacy `retry-failed-orders` workspace admin action
- legacy `retry-refunds` workspace admin action
- legacy manual refund repair or replay actions that bypass canonical review
- legacy sale or refund business branch behind `POST /webhooks/yoco/:workspaceId`

### Review before removal

- `sync-catalogue`
- `reset-webhook`
- `test-webhook`
- connection status, connect, and disconnect
- webhook health monitoring

These are not automatically obsolete merely because business effects moved to V2. Remove them only after V2 replacements own subscription lifecycle, catalogue sync, diagnostics, and credentials.

### Preserve

- one external `POST /webhooks/yoco/:workspaceId` ingress, unless Yoco is migrated to a reviewed replacement URL without creating a second active subscription
- authentication and workspace access controls
- V2 raw capture, queue, reconciliation, replay, DLQ, observation, and diagnostics routes

## Database tables

### Candidate archive or removal

| Table | Proposed action | Retention condition |
| --- | --- | --- |
| `yoco_webhook_events` | Archive then delete if no legal, forensic, or operational dependency remains | Raw V2 event coverage and retention export verified |
| legacy-only retry state or columns identified during schema review | Archive or migrate, then remove | No active alarms or repair workflows depend on them |
| obsolete legacy webhook signature replay rows in `yoco_processed_signatures` | Retain through provider replay-risk window, then review | V2 raw-event deduplication and webhook security review complete |

### Preserve

- `yoco_connections` until credentials and subscription ownership are migrated and retention is approved
- `yoco_orders`
- `yoco_order_lines`
- `stock_movements`
- `stock_balances`
- `integration_logs` and security logs required for audit
- `yoco_brands`, `yoco_categories`, catalogue and mapping records still used by the product
- every `yoco_v2_*` raw event, domain event, processing, timeline, proposal, comparison, effect, outbox, reconciliation, manual review, cutover, observation, alert, and audit table subject to retention policy
- migration history
- financial reporting records
- legal, tax, stock ledger, and reconciliation evidence

No table may be dropped solely because its name includes `yoco`. Perform a column-level and query-level dependency review first.

## Scheduled processes

### Remove after approval

- legacy pending refund retry alarm in `WorkspaceDO`
- legacy failed-order retry scheduling
- legacy manual sale reconciliation scheduling
- any cron or admin recovery action that invokes legacy sale or refund processors

### Preserve

- V2 incremental reconciliation
- V2 deep reconciliation
- V2 transition-window reconciliation
- V2 observation snapshot capture during Phase 12 and post-removal verification
- webhook health or subscription health checks until replaced
- queue and DLQ consumers

## Configuration and feature flags

### Candidate removal after Phase 13 stabilises

- `YOCO_V2_LEGACY_SHUTDOWN_ENABLED`
- `YOCO_V2_OBSERVATION_MIN_HOURS`
- `YOCO_V2_PHASE13_REMOVAL_ENABLED`
- legacy retry and legacy business-processing toggles discovered in deployment secrets or environment configuration
- temporary pilot allowlists after a reviewed all-workspace V2 configuration replaces them

### Preserve until a separate simplification review

- capture, queue, admin, rate-gate, reconciliation, and live-effect safety controls
- effect ownership records
- emergency V2 pause controls

Do not remove a safety flag in the same commit that removes the path it guards unless rollback and deployment ordering are proven.

## Legacy API methods

### Sale and refund data methods proposed for removal after all callers migrate

- `yocoFetch` legacy business use
- `listAllPages` legacy business use
- `listOrders`
- `listRefunds`
- `listOrdersPage`
- `listRefundsPageOnce`
- `listRefundsPage`
- `fetchOrderOnce`
- `fetchPaymentOnce`
- `fetchRefundOnce`
- `fetchOrder`
- `fetchPayment`
- `fetchRefund`

All future V2 resource access must remain behind the V2 per-integration rate gate.

### Subscription and catalogue methods requiring replacement review

- `listLocations`
- `listItems`
- `listItemsForLocation`
- `listItemCategories`
- `listItemBrands`
- `listModifierGroups`
- `fetchModifierGroup`
- `listWebhookSubscriptions`
- `deleteWebhookSubscription`
- `createWebhookSubscription`
- `updateWebhookSubscription`
- `fetchWebhookSubscription`
- `testWebhookSubscription`
- `connectYoco`
- `resetYocoWebhook`
- `ensureYocoWebhook`
- `cleanupStaleYocoWebhookSubscriptions`
- `testYocoWebhook`
- `disconnectYoco`
- `syncYocoCatalogue`
- `syncYocoLocationPrices`

Do not remove these until their retained responsibilities have V2 replacements.

## Tests

### Remove or rewrite when the associated legacy path is deleted

- `src/phase56NotificationWebhookTradingTime.test.js`
- `src/phase60YocoWebhookRecoveryAudit.test.js`
- `src/phase61YocoSalesReconciliationAudit.test.js`
- `src/phase62YocoCompletedOrderDeductionAudit.test.js`
- `src/phase64YocoWebhookHardeningAudit.test.js`
- `src/phase65YocoRefundStockReportingAudit.test.js`
- `src/phase67YocoRefundRecoveryAudit.test.js`
- `src/phase68YocoLivePartialRefundGrossVat.test.js`
- `src/phase69StockTakeDraftRefundWebhookRefresh.test.js`
- `src/phase70YocoLiveRefundReplay.test.js`
- `src/phase71YocoRefundLiveRecovery.test.js`
- `src/phase72YocoWebhookRateLimitSafety.test.js`
- `src/phase74YocoRefundAmountLineResolution.test.js`
- `src/phase75YocoRefundOrderHydration.test.js`
- legacy route expectations in `src/adminRoute.test.js`, `src/adminPortalD1Rewire.test.js`, and related integration tests

Rewrite valuable behavioural assertions against V2 before deleting the legacy test. Preserve V2 fixture, cutover, observation, rate-limit, reconciliation, manual-review, and idempotency tests.

## UI actions

Review and remove or replace these actions in the Yoco admin console:

- manual sale reconciliation for 2 days
- manual sale reconciliation for 14 days
- retry refunds
- retry failed orders
- combined reset webhook, catalogue sync, and sales reconcile action
- any manual refund repair that writes legacy effects

Subscription reset, connection, catalogue sync, and webhook test actions require a replacement decision rather than automatic removal.

## Deletion order

1. Freeze the approved manifest and database retention decision.
2. Remove UI entry points for obsolete actions.
3. Remove legacy route dispatch.
4. Remove scheduled legacy invocations.
5. Remove legacy processor calls from webhook ingress.
6. Remove unreachable processor and client code.
7. Rewrite or remove obsolete tests.
8. Archive and verify candidate historical data.
9. Remove approved schema objects in a later migration.
10. Run the complete Phase 13 validation and post-removal observation.
