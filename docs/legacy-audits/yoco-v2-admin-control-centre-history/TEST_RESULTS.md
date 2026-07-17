# Test Results

**Release:** `phase-v2-admin-yoco-engine-control-centre`  
**Validated:** 2026-07-15

## Final release gate

| Check | Result | Evidence |
|---|---:|---|
| Root automated suite | PASS | 498 passed, 0 failed |
| Worker automated suite | PASS | 107 passed, 0 failed |
| Total automated tests | PASS | 605 passed, 0 failed |
| Worker TypeScript typecheck | PASS | `tsc --noEmit` |
| Admin JavaScript syntax | PASS | `node --check public/yoco-v2-admin.js` |
| Production frontend build | PASS | Vite production build completed |
| Worker deployment dry run | PASS | Wrangler generated the complete upload and binding manifest, then exited in dry-run mode |
| V2 admin dependency audit | PASS | No legacy processor imports/calls, no legacy event dependency, no deletion executor |
| Phase 12 safety audit | PASS | Legacy sale/refund/sync/retry paths present, one webhook ingress, shutdown and Phase 13 disabled |
| Composed Phase 12 release gate | PASS | Typecheck, Worker tests, dependency audit, safety audit, and deployment dry run |

## Commands executed

```bash
npm test
npm run typecheck:worker
npm --prefix cloudflare-v2 test
node --check public/yoco-v2-admin.js
npm run build
CI=1 WRANGLER_SEND_METRICS=false npm --prefix cloudflare-v2 run deploy:dry
npm --prefix cloudflare-v2 run audit:yoco-v2-admin-dependencies
npm --prefix cloudflare-v2 run audit:yoco-v2-phase12-safety
CI=1 WRANGLER_SEND_METRICS=false npm --prefix cloudflare-v2 run check:phase12
```

## Safety state observed in deployment dry run

The generated production binding manifest retained:

```text
YOCO_V2_CAPTURE_ENABLED="false"
YOCO_V2_QUEUE_ENABLED="false"
YOCO_V2_ADMIN_ENABLED="false"
YOCO_V2_SHADOW_SALES_ENABLED="false"
YOCO_V2_SHADOW_REFUNDS_ENABLED="false"
YOCO_V2_LIVE_SALE_REPORTING="false"
YOCO_V2_LIVE_SALE_STOCK="false"
YOCO_V2_LIVE_REFUND_REPORTING="false"
YOCO_V2_LIVE_REFUND_STOCK="false"
YOCO_V2_LEGACY_SHUTDOWN_ENABLED="false"
YOCO_V2_PHASE13_REMOVAL_ENABLED="false"
```

No environment flag or ownership state was activated by the implementation.

## Coverage added by this release

- permission defaults and payload permission separation
- workspace isolation
- server pagination with a 130-row dataset and a 100-row page
- list queries exclude payloads
- on-demand payload redaction
- duplicate event display
- ordered processing timelines
- shadow-only configuration lock
- LEGACY effect ownership
- confirmed dead-letter requeue
- replay and requeue idempotency
- one queue publication for repeated idempotency keys
- append-only action audit and timeline
- manual review allocation validation
- filter persistence
- custom dropdown and drawer layering
- no hard page reload
- legacy and V2 navigation separation
- migration append-only protections
- no admin action creates stock or reporting effects
- large event datasets remain within query safety limits

Existing Yoco V2 tests continue to cover refund allocation validation, cumulative refund limits, independent refund statuses, live-effect ownership gates, retries, duplicate capture, API rate limits, reconciliation, controlled cutover, rollback, and legacy shutdown observation.

## Build note

The production build reports the existing large-bundle warning for the main application chunk. It is non-fatal and the build completed successfully. This release adds the V2 admin JavaScript as a separate static asset and does not increase the main application entry by importing the admin control centre into the customer application bundle.
