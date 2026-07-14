# KCP Phase 64 Yoco Webhook Hardening Audit

Audit date: 14 July 2026  
Scope: Yoco webhook ingestion, completed-order discovery, order matching, stock deduction, idempotency, signature verification, and recovery diagnostics.

## Executive verdict

The repeated **0 orders found** result had two concrete parser failures:

1. The webhook field extractor did not consistently inspect Yoco's nested `payload` object, so valid order references and payment identifiers could be read as blank.
2. The Yoco API list parser only recognised a limited set of top-level collection shapes. Valid responses such as `{ data: { orders: [...] } }`, `{ result: { orders: [...] } }`, or `{ subscriptions: [...] }` could be converted to an empty array.

Both faults are fixed. The webhook now parses nested payloads, recognises all supported collection envelopes, claims events atomically, requires final sale status evidence, verifies only the standard signed raw-body format, and performs guarded stock updates inside the workspace transaction.

## 1. 🚨 Critical Bug Findings

### 1.1 Nested webhook payload fields were missed

**Original failure:** `eventType`, `orderId`, `paymentId`, and the embedded order were primarily resolved from top-level fields. A valid Yoco event using `body.payload.reference`, `body.payload.id`, `body.payload.status`, or `body.payload.order` could therefore reach the handler with no usable order identifier.

**Fix:**

- `cloudflare-v2/src/legacy/yoco-sales.ts:1134-1275`
- Added a shared `webhookEnvelope()` parser.
- Added nested order, payment, data, metadata, and reference extraction.
- Added status handling for `successful`, `succeeded`, and `success`.
- Added explicit event disposition for final sales, refunds, returns, waiting events, and ignored events.

### 1.2 Valid Yoco list responses were silently converted to zero rows

**Original failure:** the API client only recognised a narrow set of top-level arrays. Nested orders and webhook subscriptions were returned as `[]`, which directly produced the admin message showing zero completed orders.

**Fix:**

- `cloudflare-v2/src/legacy/yoco-client.ts:25-81`
- Collection parsing now checks the top level plus `data`, `result`, and `payload` envelopes.
- Added named collection support for `orders`, `subscriptions`, and `webhooks`.
- Pagination cursor extraction now checks each supported envelope.
- Single-object API reads also unwrap `payload`.

### 1.3 Event filtering was too permissive

**Original failure:** webhook recovery treated broad payment/order event names as potential sales. A setup, created, failed, or unrelated event could enter order recovery instead of remaining diagnostic-only.

**Fix:**

- `cloudflare-v2/src/legacy/routes.ts:15124-15188`
- `cloudflare-v2/src/legacy/yoco-service.ts:1563-1598`
- Only `order.completed`, `payment.succeeded`, and `payment.successful` can enter the sale path.
- `payment.created`, `order.created`, and `order.updated` are logged as waiting and do not deduct stock.
- Unsupported and failed events are logged as ignored and return HTTP 200 without processing.
- Payment success events must contain a successful/succeeded status.

### 1.4 Orders without final payment evidence could be accepted

**Original failure:** when an order contained no status fields, `yocoOrderReadyForStock()` returned true.

**Fix:**

- `cloudflare-v2/src/legacy/yoco-sales.ts:270-330`
- An order now requires a recognised final status or a paid/closed/completed timestamp.
- `succeeded` is explicitly supported.
- Unproven orders remain retryable instead of deducting stock.

### 1.5 Reference type mismatch was not the failure

The tenant schema stores `yoco_order_id`, `yoco_payment_id`, and `provider_event_id` as `TEXT`. The handler normalises identifiers with `String(...).trim()`. Numeric references such as `1024` and alphanumeric references such as `INV-1024` therefore use the same text comparison path. No integer cast should be introduced.

### 1.6 Workspace database routing was already correct

The ingress route already forwards `/webhooks/yoco/:workspaceId` into the workspace Durable Object at `cloudflare-v2/src/index.ts:1017-1029`. The current zero-order fault was downstream in payload/list extraction, not central-versus-tenant database routing.

## 2. 🔒 Security & Race Condition Vulnerabilities

### 2.1 Signature verification accepted legacy non-standard fallbacks

**Original risk:** the verifier supported the standard signed payload, but also accepted legacy HMAC variants including the raw body alone. A delivery without the standard event ID and timestamp could bypass replay-window enforcement.

**Fix:**

- `cloudflare-v2/src/legacy/yoco-webhooks.ts:45-75`
- Requires `webhook-signature`, `webhook-id`, and `webhook-timestamp` or their Standard Webhooks aliases.
- Rejects timestamps outside the three-minute tolerance.
- Signs exactly `webhook-id.webhook-timestamp.rawBody`.
- Requires a `whsec_` secret, base64-decodes the secret material, calculates HMAC SHA-256, and compares in constant time.
- Removed raw-body and hexadecimal compatibility fallbacks.

**Deployment impact:** reset the Yoco webhook after deployment so every workspace has a current standard `whsec_` signing secret.

### 2.2 Provider event replay protection was incomplete

**Original risk:** payload hash uniqueness prevented identical payload replays, but the provider event ID was not uniquely enforced. Payload formatting changes could bypass the hash key.

**Fix:**

- `cloudflare-v2/src/tenant-migrations.ts:494-506`
- Migration 19 deduplicates historical provider IDs and adds a partial unique index on `(workspace_id, provider_event_id)`.
- `cloudflare-v2/src/legacy/routes.ts:15065-15121` checks both payload hash and provider event ID.
- Events are claimed with an atomic `received/failed/rejected/attention -> processing` update.
- A five-minute processing lease permits recovery if a Worker terminates mid-flight, while concurrent retries receive a safe 200 response.

### 2.3 Stock updates could create negative balances

**Original risk:** the previous balance UPSERT applied `quantity + delta` without an SQL-level non-negative guard.

**Fix:**

- `cloudflare-v2/src/legacy/yoco-sales.ts:1498-1655`
- Preflights the complete recipe component, including repeated use of the same ingredient.
- Skips the entire component if any required balance is insufficient, preventing partial recipe deductions.
- Uses an atomic guarded update: `?delta >= 0 OR quantity + ?delta >= 0`.
- Inserts the ledger movement only when the guarded update changed one row.
- Creates the processed component signature only when at least one matching stock movement exists.
- Missing recipes and insufficient stock remain retryable.

### 2.4 Transaction boundary

The workspace database facade executes `env.DB.batch()` inside `DurableObjectStorage.transactionSync()` at `cloudflare-v2/src/d1-facade.ts:99-109`. Balance updates, stock movements, order lines, and processed signatures therefore commit or fail within the workspace transaction boundary.

### 2.5 Dependency audit note

`npm audit --omit=dev` reports two moderate findings through `exceljs -> uuid`. They are not on the Yoco webhook execution path. No high or critical package vulnerability was reported. Updating this dependency should be handled separately because npm's suggested resolution changes the direct ExcelJS version.

## 3. 🛠️ Hardened Refactored Code

The production implementation is included in this Phase 64 package. The primary rewritten flow is:

```ts
const rawBody = await request.text();
const payload = JSON.parse(rawBody);
const fields = yocoWebhookEventFields(payload);

if (!(await verifyYocoWebhook(rawBody, request.headers, activeSecrets))) {
  return unauthorized();
}

const event = await insertOrFindByProviderIdOrPayloadHash(fields, rawBody);
if (!(await claimProcessingLease(event.id))) {
  return ok({ status: 'processing' });
}

switch (yocoWebhookEventDisposition(fields.eventType)) {
  case 'ignored':
    return markIgnored();
  case 'waiting':
    return markWaitingForOrderCompleted();
  case 'sale':
  case 'refund':
  case 'return':
    break;
}

const order = await loadEmbeddedOrderOrFetchByOrderOrPaymentId(fields, payload);
const result = await processYocoOrderAtomically(order);
return recordFinalOutcome(result);
```

Implemented files:

- `cloudflare-v2/src/legacy/routes.ts`
- `cloudflare-v2/src/legacy/yoco-sales.ts`
- `cloudflare-v2/src/legacy/yoco-client.ts`
- `cloudflare-v2/src/legacy/yoco-service.ts`
- `cloudflare-v2/src/legacy/yoco-webhooks.ts`
- `cloudflare-v2/src/tenant-migrations.ts`
- `src/phase64YocoWebhookHardeningAudit.test.js`

## 4. 📊 Database Schema Recommendations

### Implemented

1. Keep Yoco identifiers as `TEXT`. Do not convert order references to integers.
2. Enforce unique provider event IDs per workspace with migration 19.
3. Retain payload-hash uniqueness as a fallback when a provider event ID is absent.
4. Retain `yoco_processed_signatures` for order-line/component idempotency in addition to event-level idempotency.
5. Retain `stock_movements` as the stock ledger and only create signatures after verified ledger writes.

### Recommended future observability fields

These are not required for the current fix, but would improve operational reporting:

- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `last_attempt_at TEXT`
- `next_retry_at TEXT`
- `http_response_code INTEGER`
- `processing_duration_ms INTEGER`

The current five-minute processing lease uses `processed_at` while the row is in `processing` status, so a separate `processing_started_at` column is optional rather than required.

## Validation Results

- Full application test suite: **436 passed, 0 failed**
- Worker TypeScript: **passed**
- Vite production build: **passed**
- Wrangler Worker deployment dry run: **passed**
- New Phase 64 Yoco hardening tests: **5 passed, 0 failed**

## Required deployment sequence

1. Deploy the Worker so tenant migration 19 is available.
2. Deploy the Pages frontend if shipping the complete package.
3. From the KCP admin Yoco integration action, reset/reinitialise the webhook. This deletes the KCP-owned subscription, creates a new subscription, and stores a fresh standard signing secret.
4. Run the admin reconciliation for the required two-day lookback.
5. Confirm the integration log records:
   - discovered completed orders greater than zero,
   - loaded order IDs,
   - order line count,
   - stock movement count,
   - missing recipe count,
   - insufficient stock count,
   - duplicate count,
   - final webhook status.
