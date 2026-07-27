# Yoco Integration Implementation Plan

Last updated: 2026-05-11

## Objective

Build the Yoco integration as a server-led Firebase integration that can be trusted for customer reporting and stock movement.

The integration must:

- Let a workspace owner/admin connect Yoco by entering their personal API key.
- Store the Yoco API key securely on the server only.
- Import Yoco locations automatically into KCP locations.
- Import all Yoco menu catalogue items directly into the KCP menu catalogue with no staging or review step.
- Import Yoco item categories as menu/product categories only, not inventory categories.
- Store Yoco brands as metadata for future use.
- Backfill sales from the last known saved Yoco sales date through the current date.
- Deduct recipe stock for Yoco sales.
- Restore recipe stock for Yoco refunds.
- Process Yoco payment webhooks as soon as possible so dashboards and reports update live.
- Keep idempotency strong so manual syncs, backfills, and webhooks never double-deduct stock.

## Current Implementation Status

Status: `IN PROGRESS - integrated and under live validation`

Implemented local function surface:

- `connectYoco`
- `syncYocoCatalogue`
- `syncYocoSales`
- `disconnectYoco`
- `maintainYocoConnections`
- `yocoWebhook`

Implemented supporting modules:

- `functions/yoco/client.js`
- `functions/yoco/secrets.js`
- `functions/yoco/catalogue.js`
- `functions/yoco/sales.js`
- `functions/yoco/webhooks.js`
- `functions/yoco/workspaceAccess.js`
- `functions/yoco/utils.js`

Current confirmed behaviour:

- API keys are encrypted and stored server-side in Firestore.
- Integration status lives under `workspaces/{workspaceId}/data/integrations/yoco`.
- Catalogue import includes locations, menu categories, brands, items, and variants.
- Variants are represented as distinct sellable menu rows so each variant can have its own recipe.
- Webhook processing and scheduled catch-up sync are both part of the design.
- Scheduled sync runs on top of webhooks as a safety net, not as a replacement.
- Sales and refunds use idempotency signatures to avoid double processing.
- Recipe deduction/restoration is expected to be location-aware.

Current validation focus:

- Confirm real Yoco webhook delivery reaches `yocoWebhook`.
- Confirm real sales deduct stock from closing/current stock, not opening stock.
- Confirm refunds restore stock in the same location context.
- Confirm reports display newest-to-oldest live sales movement.
- Confirm all variant-level recipes are used during deduction.

## Confirmed Product Decisions

1. All Yoco menu catalogue items are imported automatically. There is no staging queue.
2. Sales history sync finds the latest saved Yoco sale date and syncs from that point to the current date.
3. If there is no saved Yoco sale yet, import all available Yoco sales history.
4. Yoco locations are matched or created automatically.
5. Customers can still add manual/non-Yoco locations themselves.
6. Webhook processing should happen ASAP after signature verification.
7. Queue/retry is only a failure fallback, not the normal processing path.
8. Yoco item categories are menu/product categories only.
9. Yoco brands are stored, but there is no brand workflow in this phase.
10. Yoco catalogue import must not create inventory stock items. Stock movement depends on KCP recipes.

## Current Project Fit

Current converted app:

- `src/components/Integrations.js` has the Yoco integration card and top-drawer setup flow.
- `src/services/integrationService.js` calls the Yoco callable functions.
- `src/services/analyticsService.js` already reads `logs_sales`, `logs_sales_errors`, `products`, `ingredients`, `locations`, and `processedSalesSignatures`.
- `functions/index.js` exports the Yoco connect/sync/webhook/scheduled functions.
- Functions are CommonJS on Node 22.
- RTDB is the operational data source for the converted app.
- Firestore is already available and is the right place for server-only encrypted integration secrets.

Important implementation direction:

- Reuse old project behaviour where helpful, especially normalization and sales stock movement logic.
- Do not reuse old browser-side secret handling or local/session-based sync state.
- All Yoco API calls that use the API key must happen in Firebase Functions.

## Yoco API Surface

### Setup and Catalogue

- List locations: `GET /v1/locations/`
- List items: `GET /v1/items/`
- Fetch item: `GET /v1/items/{item_id}`
- List item categories: `GET /v1/item-categories/`
- Fetch item category: `GET /v1/item-categories/{item_category_id}`
- List item brands: `GET /v1/item-brands/`
- Fetch item brand: `GET /v1/item-brands/{item_brand_id}`

### Sales and Refunds

- List orders: `GET /v1/orders/`
- Fetch order: `GET /v1/orders/{order_id}`
- List refunds: `GET /v1/refunds/`
- Fetch refund: `GET /v1/refunds/{refund_id}`

### Live Updates

- Webhook event: `payment.created`
- Webhook event: `payment.refunded`
- Create webhook subscription: `POST /v1/webhooks/subscriptions/`

Yoco notes confirmed from the current docs:

- API calls use bearer auth with `Authorization: Bearer <token>`.
- Orders support pagination with `cursor`, `limit`, and `next_cursor`.
- Orders support date filters such as `created_at__gte/lte`, `updated_at__gte/lte`, and `closed_at__gte/lte`.
- Orders have statuses including `open`, `completed`, and `cancelled`; stock movement should only process completed sales.
- Order money amounts are in the smallest denomination, so ZAR amounts are cents and must be divided by 100 for rand values.
- Webhook subscription creation accepts `event_types`, `name`, and `notification_url`.
- The webhook subscription `secret` is only returned on creation, so it must be encrypted and stored immediately.
- Webhook events include `business_id`, `event_type`, `order_id`, and `payment_id`.
- Webhook requests include a `webhook-signature` header that must be verified before processing.

## Data Model

### RTDB Workspace Status

Path:

```text
workspaces/{workspaceId}/data/integrations/yoco
```

Shape:

```json
{
  "status": "connected",
  "connectedAt": "2026-05-09T00:00:00.000Z",
  "connectedBy": "uid",
  "businessId": "",
  "lastSyncStartedAt": "",
  "lastSyncCompletedAt": "",
  "lastSuccessfulOrderUpdatedAt": "",
  "lastSuccessfulRefundUpdatedAt": "",
  "lastError": "",
  "webhook": {
    "enabled": true,
    "subscriptionId": "",
    "notificationUrl": "",
    "eventTypes": ["payment.created", "payment.refunded"],
    "lastReceivedAt": "",
    "lastProcessedAt": "",
    "failedCount": 0
  },
  "catalogue": {
    "lastSyncedAt": "",
    "itemsCount": 0,
    "categoriesCount": 0,
    "brandsCount": 0,
    "missingRecipeCount": 0
  },
  "locations": {
    "lastSyncedAt": "",
    "count": 0
  }
}
```

### KCP Locations

Existing path:

```text
workspaces/{workspaceId}/data/locations
```

Yoco-created or matched locations should include:

```json
{
  "id": "kcp-location-id",
  "name": "Main Store",
  "yocoLocationId": "yoco-location-id",
  "source": "yoco",
  "updatedAt": "2026-05-09T00:00:00.000Z"
}
```

Matching order:

1. Existing `yocoLocationId`.
2. Exact normalized location name.
3. Create new KCP location with `source = yoco`.

If a Yoco order has no location, do not use a random/default location. Log the order to `logs_sales_errors` and skip stock movement for that order.

### KCP Products/Menu Catalogue

Existing path:

```text
workspaces/{workspaceId}/data/products
```

Yoco-imported or matched products should include:

```json
{
  "id": "kcp-product-id",
  "name": "Burger",
  "category": "Mains",
  "sellingPrice": 120,
  "yocoItemId": "yoco-item-id",
  "yocoVariantId": "yoco-variant-id",
  "yocoCategoryId": "yoco-category-id",
  "yocoCategoryName": "Mains",
  "yocoBrandId": "yoco-brand-id",
  "yocoBrandName": "Brand Name",
  "source": "yoco",
  "recipe": [],
  "updatedAt": "2026-05-09T00:00:00.000Z"
}
```

Matching order:

1. Existing `yocoVariantId`.
2. Existing `yocoItemId`.
3. Barcode/SKU if Yoco item data exposes one.
4. Exact normalized product name.
5. Create new KCP product with empty recipe.

Preserve:

- Existing recipes.
- Existing KCP-edited selling price if the customer changed it after import, unless we later add an explicit "overwrite prices from Yoco" option.
- Existing product id so reports remain stable.

### Sales Logs

Use existing reporting paths:

```text
workspaces/{workspaceId}/data/logs_sales
workspaces/{workspaceId}/data/logs_sales_errors
workspaces/{workspaceId}/data/processedSalesSignatures
```

Recommended `logs_sales` shape for Yoco:

```json
{
  "id": "sale_yoco_order_payment",
  "source": "Yoco",
  "sourceProvider": "yoco",
  "syncMode": "sale",
  "date": "2026-05-09",
  "timestamp": "2026-05-09T12:00:00.000Z",
  "orderId": "yoco-order-id",
  "paymentId": "yoco-payment-id",
  "orderNumber": "1001",
  "locationId": "kcp-location-id",
  "locationName": "Main Store",
  "saleLines": [],
  "details": []
}
```

For recipe deductions, `details` should hold the ingredient stock movement rows used by reporting.

### Server-Only Secrets

Firestore collection:

```text
integrationSecrets/{workspaceId}_yoco
```

Shape:

```json
{
  "workspaceId": "workspace-id",
  "provider": "yoco",
  "apiKeyCiphertext": "",
  "apiKeyIv": "",
  "apiKeyTag": "",
  "webhookSecretCiphertext": "",
  "webhookSecretIv": "",
  "webhookSecretTag": "",
  "createdAt": "server timestamp",
  "updatedAt": "server timestamp"
}
```

Rules:

- Firestore client access must be denied for `integrationSecrets`.
- Only Firebase Admin SDK in Functions reads/writes this collection.
- Encrypt with AES-256-GCM using a Firebase Functions secret such as `YOCO_SECRET_ENCRYPTION_KEY`.
- Never put API keys or webhook secrets in RTDB, browser state, local storage, session storage, or logs.

## Function Architecture

Keep the Functions code modular. Current implemented files:

```text
functions/index.js
functions/yoco/client.js
functions/yoco/secrets.js
functions/yoco/catalogue.js
functions/yoco/sales.js
functions/yoco/webhooks.js
functions/yoco/workspaceAccess.js
functions/yoco/money.js
functions/yoco/utils.js
```

### `yoco/client.js`

Responsibilities:

- `yocoFetch(apiKey, path, options)`
- `listAllPages(apiKey, path, params)`
- `listLocations`
- `listItems`
- `fetchItem`
- `listItemCategories`
- `listItemBrands`
- `listOrders`
- `fetchOrder`
- `listRefunds`
- `fetchRefund`
- `createWebhookSubscription`

Requirements:

- Use `https://api.yoco.com` by default.
- Allow sandbox base URL by config later, but do not expose it in the customer UI yet.
- Use `limit=100` where supported.
- Follow `next_cursor`.
- Retry `429` with backoff.
- Throw typed errors with enough detail for logs, but do not log API keys.

### `yoco/secrets.js`

Responsibilities:

- Encrypt API key.
- Decrypt API key.
- Encrypt webhook secret.
- Decrypt webhook secret.
- Store/delete secret doc.

### `yoco/workspaceAccess.js`

Responsibilities:

- Verify callable auth.
- Verify user belongs to workspace.
- Verify owner/admin role for connect, rotate key, disconnect.
- Allow regular authorized roles to trigger sync only if we decide that fits app permissions.

### `yoco/catalogue.js`

Responsibilities:

- Sync Yoco locations.
- Sync Yoco item categories into menu categories/product category metadata.
- Sync Yoco brands into product metadata.
- Sync Yoco items into products.
- Preserve existing recipes.
- Return counts and missing recipe count.

### `yoco/sales.js`

Responsibilities:

- Resolve last known Yoco sale date.
- Fetch completed Yoco orders from that date through current date.
- Fetch refunds from the last known refund cursor/date.
- Normalize orders and refunds.
- Match location and products.
- Apply stock movements in one RTDB transaction per order/refund where possible.
- Write `logs_sales`, `logs_sales_errors`, and `processedSalesSignatures`.
- Return sync summary.

### `yoco/webhooks.js`

Responsibilities:

- Verify raw payload signature with stored webhook secret.
- Save small audit record.
- Fetch full order/refund.
- Process immediately through the same `processYocoOrder`/`processYocoRefund` pipeline as manual sync.
- Return `200` after successful processing.
- If processing fails after verification, save a durable retry record before returning `200`; otherwise return non-2xx so Yoco can retry.

## Function Exports

Add these exports from `functions/index.js`:

```js
exports.connectYoco = onCall(...);
exports.syncYocoCatalogue = onCall(...);
exports.syncYocoSales = onCall(...);
exports.disconnectYoco = onCall(...);
exports.yocoWebhook = onRequest(...);
```

## Core Callable Flows

### 1. `connectYoco`

Input:

```json
{
  "workspaceId": "workspace-id",
  "apiKey": "user-entered-yoco-api-key"
}
```

Flow:

1. Verify auth and owner/admin workspace access.
2. Validate API key by calling Yoco locations.
3. Encrypt and store API key.
4. Sync locations automatically.
5. Sync categories, brands, and items.
6. Create webhook subscription for `payment.created` and `payment.refunded`.
7. Encrypt and store webhook secret immediately.
8. Resolve last known Yoco sales date.
9. Backfill orders and refunds from that date to now.
10. Update RTDB integration status.
11. Return a customer-readable summary.

Output:

```json
{
  "status": "connected",
  "locationsImported": 0,
  "productsImported": 0,
  "categoriesImported": 0,
  "brandsStored": 0,
  "ordersProcessed": 0,
  "refundsProcessed": 0,
  "missingRecipes": 0,
  "errors": []
}
```

### 2. `syncYocoCatalogue`

Flow:

1. Verify workspace access.
2. Decrypt API key.
3. Fetch locations, categories, brands, and items.
4. Upsert locations and products.
5. Update counts and missing recipe count.

### 3. `syncYocoSales`

Flow:

1. Verify workspace access.
2. Decrypt API key.
3. Resolve lower bound:
   - `integrations/yoco.lastSuccessfulOrderUpdatedAt`
   - latest Yoco `logs_sales` timestamp
   - no lower bound for first import
4. Fetch completed orders.
5. Fetch approved refunds.
6. Process each order/refund idempotently.
7. Update sync timestamps only after successful processing.

### 4. `disconnectYoco`

Flow:

1. Verify owner/admin access.
2. Disable/delete webhook subscription if supported and subscription id exists.
3. Delete encrypted secrets.
4. Mark integration disconnected.
5. Keep historical logs.

## Webhook Flow

Endpoint:

```text
https://{region}-{project}.cloudfunctions.net/yocoWebhook?workspaceId={workspaceId}
```

Flow:

1. Read raw request body.
2. Resolve workspace from query string and RTDB integration metadata.
3. Decrypt webhook secret.
4. Verify `webhook-signature` against raw body.
5. Store audit record under:

```text
workspaces/{workspaceId}/data/integrations/yoco/webhookEvents/{eventId}
```

6. Build event signature:

```text
yoco:webhook:{event_type}:{order_id}:{payment_id}
```

7. If duplicate, mark skipped and return `200`.
8. If `payment.created`, fetch order and process sale.
9. If `payment.refunded`, fetch order/refund data and process refund.
10. Update `lastReceivedAt` and `lastProcessedAt`.

## Stock Movement Rules

### Sales

For each completed Yoco order line:

1. Match to KCP product.
2. If product has a recipe:
   - Deduct stock for every recipe ingredient.
   - Deduction quantity is:

```text
orderLine.quantity * recipeLine.qty
```

3. Deduct at the matched Yoco/KCP location.
4. Write ingredient movement rows to `logs_sales.details`.
5. If product has no recipe:
   - Write sale line to `logs_sales.saleLines`.
   - Write `missing_recipe` or `sales_only` to `logs_sales_errors`.
   - Do not change inventory.

### Refunds

For each approved refund:

1. Resolve original order and returned/refunded lines.
2. Match to KCP product.
3. If product has a recipe:
   - Restore stock for every recipe ingredient.
   - Restore quantity is:

```text
refundedLine.quantity * recipeLine.qty
```

4. Write positive/restoration movement rows to `logs_sales.details`.
5. If product has no recipe:
   - Write refund line as sales-only reversal.
   - Do not change inventory.

### Idempotency

Before any stock mutation, build deterministic signatures:

```text
yoco:{sale|refund}:{orderId}:{paymentId|refundId}:{lineItemId}:{locationId}:{quantity}
```

Store hashed signatures under:

```text
workspaces/{workspaceId}/data/processedSalesSignatures/yoco/{signatureHash}
```

Rules:

- If signature exists, skip the line.
- Never write a duplicate stock movement.
- Manual sync and webhook processing must share the same processing functions.

## Error Handling

Write integration errors to:

```text
workspaces/{workspaceId}/data/logs_sales_errors
```

Error types:

- `yoco_auth_failed`
- `yoco_rate_limited`
- `yoco_location_missing`
- `yoco_product_missing`
- `missing_recipe`
- `sales_only`
- `webhook_signature_failed`
- `webhook_processing_failed`
- `duplicate_signature`
- `yoco_sync_failed`

Each error should include:

- `sourceProvider: "yoco"`
- `workspaceId`
- `orderId` if available
- `paymentId` if available
- `refundId` if available
- `locationId` if available
- `productName` if available
- customer-safe `message`
- developer `debugCode`
- `timestamp`

## Integrations UI Plan

Enhance `src/components/Integrations.js` and supporting services.

### Yoco Setup Modal

Fields and actions:

- API key input.
- `Connect and Sync` button.
- Plain note: sales history starts from the latest saved Yoco sale date, or all available Yoco history if this is the first connection.

States:

- idle
- validating key
- syncing locations
- syncing catalogue
- creating webhook
- importing sales
- connected
- failed

### Connected Card

Show:

- Connected/disconnected badge.
- Last successful sync.
- Webhook status.
- Imported locations count.
- Imported menu catalogue count.
- Missing recipe count.
- Last error.

Actions:

- Sync Now.
- Sync Catalogue.
- Rotate API Key.
- Disconnect.

Recipe follow-up:

- Show count of Yoco menu items without recipes.
- Link to Recipes/Menu Catalogue filtered to missing recipes.

## Rules Updates

### RTDB

Current RTDB rules allow workspace members to read/write workspace data broadly. For this phase, add explicit child entries for new paths so deployment is clear:

```json
"integrations": {},
"processedSalesSignatures": {},
"logs_sales": {},
"logs_sales_errors": {}
```

Later hardening:

- Client should read `integrations/yoco/status` and summary fields.
- Client should not directly write sensitive integration state.
- Function/Admin writes should own sync cursors and webhook metadata.

### Firestore

Add explicit deny-all for:

```text
integrationSecrets/{secretId}
```

Rule:

```js
match /integrationSecrets/{secretId} {
  allow read, write: if false;
}
```

## Implementation Phases

These phases were the original build plan. Phase 1 through the core of Phase 5 are now implemented and being validated with live data. Phase 6 remains the main trust/reconciliation follow-up.

### Phase 1: Backend Foundation

Files:

- `functions/yoco/client.js`
- `functions/yoco/secrets.js`
- `functions/yoco/workspaceAccess.js`
- `functions/yoco/money.js`

Deliverables:

- API client with paging and typed errors.
- Secret encryption helpers.
- Workspace access helper.
- Firestore rules deny `integrationSecrets`.
- Function exports scaffolded.

Acceptance:

- Invalid key fails safely.
- Valid key can call Yoco locations.
- No key is written to browser-readable storage.

### Phase 2: Catalogue and Locations

Files:

- `functions/yoco/catalogue.js`
- updates to `functions/index.js`

Deliverables:

- Automatic Yoco location import/match.
- Automatic Yoco item category import as menu categories.
- Automatic Yoco item import as KCP products.
- Brand metadata stored.
- Existing recipes preserved.

Acceptance:

- Yoco catalogue appears in Menu Catalogue.
- No inventory categories are created from Yoco menu categories.
- No stock items are created from Yoco products.

### Phase 3: Sales and Refund Backfill

Files:

- `functions/yoco/sales.js`

Deliverables:

- Last known sales date resolution.
- Completed order import.
- Approved refund import.
- Shared sale/refund processor.
- Stock deduction/restoration through recipes.
- Idempotency signatures.

Acceptance:

- A completed Yoco sale deducts recipe ingredients once.
- A Yoco refund restores recipe ingredients once.
- Running sync twice does not change stock twice.
- Missing recipes are logged but do not block other sales.

### Phase 4: Webhooks

Files:

- `functions/yoco/webhooks.js`

Deliverables:

- Create webhook subscription during connect.
- Store webhook secret immediately.
- Verify webhook signature.
- Fetch full order/refund.
- Process ASAP through shared pipeline.
- Durable webhook event audit.

Acceptance:

- Live sale updates dashboard/reporting after webhook processing.
- Duplicate webhook does not duplicate stock movement.
- Invalid signature does not mutate stock.

### Phase 5: UI Integration

Files:

- `src/components/Integrations.js`
- `src/styles/integrations.css`
- new `src/services/integrationService.js` if useful

Deliverables:

- Yoco connect modal.
- Progress states.
- Connected status card.
- Sync Now.
- Sync Catalogue.
- Rotate API Key.
- Disconnect.

Acceptance:

- Customer can connect without seeing technical details.
- Errors are understandable.
- No sensitive key value is retained in UI state after submit.

### Phase 6: Reconciliation and Trust Tools

Deliverables:

- `reconcileYocoSales` callable.
- Date-range re-fetch and compare.
- Missing/duplicate/unmatched result summary.
- Integration health panel.

Acceptance:

- Customer/admin can verify imported Yoco sales against processed KCP signatures.
- Failures are visible and actionable.

## First Build Slice

Start with a production-shaped vertical slice rather than a UI mock:

1. Add Functions Yoco API client.
2. Add encrypted secret storage.
3. Add `connectYoco`.
4. Sync locations.
5. Sync catalogue categories, brands, and items.
6. Backfill orders from last known saved Yoco sale date.
7. Process stock deductions for recipe-backed products.
8. Create webhook subscription.
9. Add `yocoWebhook` for `payment.created`.
10. Add `payment.refunded` immediately after sale processing works.
11. Add Integration UI connect/progress/status.

## Testing Checklist

Use a test workspace with known recipes, stock balances, and at least two locations.

1. Invalid API key fails without saving secrets.
2. Valid API key connects and syncs locations.
3. Catalogue import creates products with Yoco ids.
4. Existing product with recipe is matched and recipe is preserved.
5. Yoco menu category imports as product/menu category only.
6. Yoco brand metadata is stored on products.
7. First sales sync imports all available history if no prior Yoco sales exist.
8. Later sales sync starts from latest saved Yoco sale date.
9. Completed sale deducts stock at correct location.
10. Missing recipe logs error and does not deduct stock.
11. Refund restores stock.
12. Manual sync after webhook does not duplicate stock.
13. Duplicate webhook does not duplicate stock.
14. Invalid webhook signature is rejected and logged.
15. Reports update:
    - Yoco Sales Report
    - Sale Stock Movement
    - Stock Movement
    - Payments Report
    - Dashboard stock and sales summaries

## Deployment Notes

Set function secret:

```bash
firebase functions:secrets:set YOCO_SECRET_ENCRYPTION_KEY
```

Deploy together when backend and rules are ready:

```bash
npm run build
firebase deploy --only functions,database,firestore,hosting
```

## Reference Links

- Orders: https://developer.yoco.com/api-reference/yoco-api/orders/list-orders-v-1-orders-get
- Create webhook subscription: https://developer.yoco.com/api-reference/yoco-api/webhooks/create-webhook-subscription-v-1-webhooks-subscriptions-post
- Payment created webhook: https://developer.yoco.com/api-reference/yoco-api/webhook-events/payment-created
- Payment refunded webhook: https://developer.yoco.com/api-reference/yoco-api/webhook-events/payment-refunded
- Locations: https://developer.yoco.com/api-reference/yoco-api/locations/list-locations-v-1-locations-get
- Items: https://developer.yoco.com/api-reference/yoco-api/items/list-items-v-1-items-get
- Item categories: https://developer.yoco.com/api-reference/yoco-api/item-categories/list-item-categories-v-1-item-categories-get
- Item brands: https://developer.yoco.com/api-reference/yoco-api/item-brands/list-item-brands-v-1-item-brands-get
