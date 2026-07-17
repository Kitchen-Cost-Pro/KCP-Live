# Legacy Yoco API Call Audit

Release: `phase-v2-04-06-yoco-sale-shadow-engine`

Date: 2026-07-15

## Scope and rule

This audit describes the outbound Yoco API calls currently used by the live legacy integration. It is documentation only. No legacy call is redirected through the V2 client or V2 rate gate in this release.

The legacy client is implemented in `cloudflare-v2/src/legacy/yoco-client.ts`. Callers are primarily `yoco-service.ts`, `routes.ts`, `yoco-refund-context.ts`, and `chat-routes.ts`.

All legacy calls use an integration API key in an HTTP `Authorization: Bearer <key>` header and send or accept JSON. The API key is decrypted before use. Legacy requests do not currently have a shared cross-instance concurrency gate or cache.

## Existing shared legacy behavior

- `yocoFetch` builds a URL from `YOCO_API_BASE_URL` or `https://api.yoco.com`, sends JSON, parses JSON-compatible responses, and throws `YocoApiError` for non-2xx responses.
- `withYocoRetry` retries only HTTP 429 responses, up to four retries after the initial call.
- Retry delay uses `Retry-After`, `RateLimit-Reset`, or `X-RateLimit-Reset` when available. Otherwise it uses bounded exponential delay.
- Single-attempt order, payment, and refund detail methods deliberately bypass the internal retry wrapper for webhook-controlled staged recovery.
- There is no coordinated per-integration concurrency limit across Worker instances.
- There is no shared response cache or in-flight request coalescing.
- List pagination defaults to 100 rows and follows returned cursors.
- The live sale reconciliation contains bounded fallbacks and stops overlapping discovery queries after the first productive query to preserve rate-limit capacity.

## Endpoint inventory

| Endpoint | Method | Legacy purpose | Typical response | Triggering paths | Cache eligibility | Deduplication potential | Current retry and rate-limit behavior |
|---|---:|---|---|---|---|---|---|
| `/v1/locations/` | GET | Validate credentials and import Yoco locations into KCP mappings. | Paginated location collection. | Connect, catalogue sync, setup validation. | Short-lived merchant metadata cache is reasonable. | Concurrent catalogue/setup calls can share one fetch. | Paginated calls retry 429 up to four times. Direct credential probe is single request. No shared gate. |
| `/v1/items/` | GET | Import menu items, categories, brands, prices, and mapping source data. | Paginated item collection. | Catalogue sync and onboarding. | Short-lived catalogue cache is possible, scoped to integration and location. | Identical catalogue fetches can be coalesced. | 429-only retry through pagination helper. No shared gate. |
| `/v1/items/?location_id=...` | GET | Load location-resolved item prices, overrides, and availability. | Paginated item collection. | Per-location catalogue sync. | Short-lived per-integration and per-location cache is possible. | Same location/resource request can be coalesced. | 429-only retry. Location loops may produce sequential calls but are not globally coordinated. |
| `/v1/item-categories/` or `/v1/item_categories/` | GET | Import item categories. | Paginated category collection. | Catalogue sync. | Short-lived metadata cache is suitable. | Identical calls can be coalesced. | Tries alternate path only after 404. Each paginated call has 429 retry. |
| `/v1/item-brands/` or `/v1/item_brands/` | GET | Import item brands. | Paginated brand collection. | Catalogue sync. | Short-lived metadata cache is suitable. | Identical calls can be coalesced. | Tries alternate path after 404; 429 retry on pagination. |
| `/v1/modifier_groups/` or `/v1/modifier-groups/` | GET | Import modifier groups and modifier mapping source data. | Paginated modifier-group collection. | Catalogue/modifier sync. | Short-lived metadata cache is suitable. | Identical calls can be coalesced. | Alternate path on 404; paginated 429 retry. |
| `/v1/modifier_groups/:id` or `/v1/modifier-groups/:id` | GET | Fetch one modifier group with complete modifier detail. | Modifier-group object. | Modifier assignment, mapping, catalogue enrichment. | Short-lived resource cache is suitable. | Same group fetch can be coalesced. | No general retry wrapper; alternate path is tried after 404. No cross-instance gate. |
| `/v1/orders/` | GET | Discover completed sales, recover webhook-referenced orders, query by payment ID, provide chat/admin diagnostics, and reconciliation. | Paginated order collection. | Manual/recovery sync, scheduled reconciliation, payment webhook recovery, admin/chat requests. | Very short-lived query cache only; forced refresh required for reconciliation. | Identical page/query calls can be coalesced, while different cursors must remain distinct. | Pagination retries 429 up to four times. Reconciliation has bounded filtered and page fallbacks. No cross-instance coordination with webhook work. |
| `/v1/orders/:id` | GET | Hydrate an order with full lines, payments, returns, modifiers, and financial data. | Order object. | Live completed-sale processing, payment recovery, refund order hydration, manual/recovery sync. | Short-lived immutable-ish order snapshot cache is suitable, with forced refresh for delayed/refund enrichment. | Multiple webhook or sync processors for the same order can share one upstream fetch. | `fetchOrder` retries 429; `fetchOrderOnce` is single attempt so webhook code controls pacing. No in-flight coalescing. |
| `/v1/payments/:id` | GET | Resolve an order ID from a payment and hydrate payment-linked refund context. | Payment object. | Payment webhook recovery, refund context resolution, admin repair. | Short-lived resource cache is suitable. | Same payment fetch can be coalesced. | Retried on 429 through `fetchPayment`; single-attempt variant is used by staged webhook recovery. |
| `/v1/refunds/` | GET | Discover refunds during reconciliation and resolve refund context by filters/cursors. | Paginated refund collection. | Manual/recovery sync, refund-only reconciliation, refund webhook recovery, chat/admin diagnostics. | Very short-lived query cache only; forced refresh needed for reconciliation. | Identical filtered/cursor requests can be coalesced. | Standard page/list methods retry 429; `listRefundsPageOnce` deliberately makes one attempt. No shared gate. |
| `/v1/refunds/:id` | GET | Fetch one refund object. The helper exists in the legacy client, but the current live call paths primarily resolve refunds from list/order/payment data. | Refund object. | Available for refund detail recovery; not a primary current call site. | Short-lived resource cache is suitable. | Same refund fetch can be coalesced. | Retried variant and single-attempt variant exist. No shared gate. |
| `/v1/webhooks/subscriptions/` | GET | Discover current subscriptions, health-check configuration, clean stale or duplicate subscriptions, reset integration. | Paginated subscription collection. | Connect, reset, cleanup, webhook health and admin diagnostics. | Very short-lived cache only; forced refresh after mutation. | Concurrent health checks can share a read. | Paginated 429 retry. No shared mutation lock across Worker instances. |
| `/v1/webhooks/subscriptions/` | POST | Create the single live KCP webhook subscription. | Subscription object. | Connect or reset after cleanup. | Not cacheable. | Mutation should be protected by idempotent reset/connect coordination. | Retries only 429 via `withYocoRetry`; no per-integration mutation gate. |
| `/v1/webhooks/subscriptions/:id` | DELETE | Remove obsolete or duplicate subscriptions during disconnect/reset/cleanup. | Empty or deletion result. | Disconnect, reset, stale-subscription cleanup. | Not cacheable. | Repeated delete can be treated idempotently by ID. | Retries only 429. No per-integration mutation gate. |
| `/v1/webhooks/subscriptions/:id/test` | POST | Ask Yoco to emit an `order.completed` test event. | Test result object. | Admin webhook test. | Not cacheable. | User action should not be coalesced unless an identical test is already in progress. | Single request without the general retry wrapper. |
| `/v1/webhooks/subscriptions/:id` | PATCH | Client helper for subscription update. No active legacy call site was found in this release. | Subscription object. | Reserved helper. | Not cacheable. | Mutation key can be deduplicated by subscription and body hash if activated. | 429 retry through wrapper. |
| `/v1/webhooks/subscriptions/:id` | GET | Client helper for one subscription. No active legacy call site was found in this release. | Subscription object. | Reserved helper. | Short-lived cache possible. | Same ID can be coalesced. | Single request without general retry wrapper. |

## Event and workflow relationships

### Completed sales

Supported live webhook/recovery paths include `order.completed`, `payment.succeeded`, and `payment.successful`. The legacy processor may use an embedded order, fetch an order directly, fetch a payment to discover its order, query orders by payment ID, or scan bounded completed-order pages. It then performs live legacy reporting and stock effects.

### Refunds

Refund webhook and reconciliation paths may query refund pages, hydrate the refund order, hydrate a payment, and re-fetch the original order to obtain line and return detail. Legacy refund processing remains unchanged and live.

### Catalogue and mappings

Connection and catalogue synchronization read locations, items, location-resolved items, categories, brands, modifier groups, and modifier-group detail. These calls remain entirely on the legacy client.

### Subscription lifecycle

The legacy integration remains the sole owner of Yoco webhook subscription creation, deletion, testing, and cleanup. V2 creates no second subscription and makes no subscription API call.

## Phase 4 conclusion

The legacy integration has partial local 429 handling and some bounded reconciliation safeguards, but it has no strongly coordinated per-integration rate gate, shared circuit state, cache, or request coalescing. The new V2 API client addresses those concerns for V2 only. Redirecting legacy traffic is explicitly deferred.
