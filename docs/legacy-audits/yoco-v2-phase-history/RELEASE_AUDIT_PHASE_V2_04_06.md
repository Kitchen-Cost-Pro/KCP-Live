# Phase V2 04-06 Release Audit

Release: `phase-v2-04-06-yoco-sale-shadow-engine`

Date: 2026-07-15

Status: Implementation complete; not deployed.

## Scope delivered

### Phase 4

- Audited all active legacy Yoco API calls without redirecting them.
- Added an isolated V2 API client with authentication, trace propagation, timeout, parsing, classification, secret-safe logging, metrics-ready diagnostics, and `Retry-After` support.
- Added `YocoV2RateGateDO`, coordinated per integration ID.
- Added request serialization, configurable pacing, in-flight deduplication, integration-scoped TTL cache, rate-limit pause, authentication circuit, and forced refresh.
- Added `yoco_v2_api_requests` and `yoco_v2_integration_runtime` diagnostics.

### Phase 5

- Added the versioned canonical `sale.completed` contract.
- Added deterministic, idempotent storage in `yoco_v2_domain_events`.
- Added order hydration exclusively through the V2 client and rate gate.
- Added financial, line, modifier, location, and menu mapping resolution.
- Added explicit incomplete and waiting statuses.
- Added duplicate and out-of-order webhook enrichment without duplicate sale identity.
- Added anonymised fixture coverage.

### Phase 6

- Added shadow-only stock movement proposals using existing KCP recipe, ingredient, UOM, cost, mapping, and location data.
- Added mapped modifier proposals and recursive sub-recipe handling without double deduction.
- Added `yoco_v2_proposed_stock_movements` with deterministic uniqueness.
- Added legacy-versus-V2 sale comparisons in `yoco_v2_sale_comparisons`.
- Added detailed internal admin diagnostics and controlled refetch, re-resolution, reproposal, and re-comparison.

## Required release confirmations

### Legacy remains active

Confirmed. The existing webhook ingress, signature verification, subscription lifecycle, catalogue sync, sale/refund processing, stock writes, reporting writes, reconciliation, and recovery paths remain in place. No legacy Yoco API caller was redirected.

### One Yoco webhook subscription path

Confirmed. V2 uses the existing verified webhook fan-out and contains no subscription create, update, delete, or second-ingress implementation.

### V2 API calls use the rate gate

Confirmed. V2 order hydration enters `api-client.ts`, which requires the `YOCO_V2_RATE_GATE` binding. Administrative forced refetch and queue retries use the same processor/client path.

### 429 handling respects Retry-After

Confirmed. The rate gate parses `Retry-After`, records it, pauses only the affected integration, classifies the response as `RATE_LIMITED`, and propagates retry timing to queue processing.

### No undocumented rate-limit assumption

Confirmed. There is no hard-coded Yoco request quota. Configurable request spacing is documented as conservative coordination only and is independent per integration.

### Canonical sale stored once

Confirmed. Canonical identity is deterministic for workspace, integration, `sale.completed`, and source order. Duplicate or out-of-order webhooks update/enrich the same event.

### Shadow proposals only

Confirmed. The V2 proposal writer targets only `yoco_v2_proposed_stock_movements`. It has no insert/update path to `stock_movements`, stock balances, or legacy reporting tables.

### Comparisons visible

Confirmed. Internal administrator APIs expose sale lists, sale detail, raw timeline, API requests, canonical payload, legacy sale/movements, V2 proposals, comparison outcomes, and difference summaries.

### Effect ownership and live flags

Confirmed. All four ownership records remain `LEGACY`. All V2 live-effect flags default false and remain hard-disabled in code.

### Idempotency and reruns

Confirmed. Raw events, canonical sales, proposals, and comparisons use deterministic keys/upserts. Replay, refetch, resolution, proposal, and comparison reruns do not create duplicate effects or duplicate shadow identities.

### Deployment and rollback

Documented in `DEPLOYMENT.md` and `ROLLBACK.md`. Deployment is additive; rollback requires disabling V2 flags and does not change the live Yoco subscription.

## Automated validation

Executed successfully before packaging:

| Check | Result |
|---|---|
| Existing application regression suite | 493 passed, 0 failed |
| Combined Yoco V2 Phase 1-6 suite | 42 passed, 0 failed |
| Frontend production build | Passed |
| Worker TypeScript check | Passed |
| Wrangler production dry-run | Passed |
| Production binding inspection | Workspace DO, per-integration rate-gate DO, main queue, DLQ, and central D1 detected |
| Markdown consolidation check | Passed; no project Markdown remains outside `docs/` |
| Static live-write scan | Passed; no V2 SQL mutation path targets live stock or reporting tables |
| TOML parse check | Production and staging example passed |

The V2 suite coverage includes:

- identical concurrent fetch coalescing
- integration isolation
- 429 and `Retry-After`
- retryable 5xx
- 401 configuration attention
- retryable timeout
- integration-scoped cache
- credential redaction
- manual refetch through the gate
- queue retry through the gate
- valid sale fixtures and mapping states
- delayed 404 then successful enrichment
- duplicate/out-of-order event idempotency
- exact and differing comparisons
- modifier and sub-recipe behavior
- rerun idempotency
- assertions that live stock and reporting tables receive no V2 writes


## Deployment status

Not deployed. The archive is a release candidate for controlled review and deployment.
