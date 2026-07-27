# Yoco V2 Legacy Shutdown Deployment Guide

Release: `phase-v2-12-yoco-legacy-shutdown`

## Deployment principle

Deploy additively while the legacy Yoco implementation remains present. Phase 12 can disable legacy business execution only after every effect is V2-owned and the workspace passes readiness. The packaged production and staging configuration does not activate shutdown or Phase 13 removal.

## Cloudflare resources

Required bindings:

- `WORKSPACE` to `WorkspaceDO`
- `YOCO_V2_RATE_GATE` to `YocoV2RateGateDO`
- `CENTRAL_DB`
- `YOCO_V2_EVENTS`
- `YOCO_V2_EVENTS_DLQ`

Queue names:

```text
kcp-yoco-v2-events
kcp-yoco-v2-events-dlq
```

The existing Worker schedule continues incremental reconciliation and due sale and refund transition-window reconciliation.

## Tenant migrations

Additive tenant migrations:

- 22: V2 raw capture, queue, processing, ownership, and diagnostics
- 23: rate-gated API client, canonical sales, sale shadow proposals, comparisons
- 24: canonical refunds, manual review, refund shadow proposals, reconciliation
- 25: controlled sale ownership, readiness, outbox, live sale effects, sale transition reconciliation
- 26: controlled refund ownership, readiness, outbox, live refund effects, refund transition reconciliation
- 27: legacy shutdown state, observation snapshots, legacy invocation alerts, dependency audit, and Phase 13 readiness gate

SQL references:

```text
cloudflare-v2/src/modules/yoco-engine-v2/migrations/0001-yoco-v2-foundation.sql
cloudflare-v2/src/modules/yoco-engine-v2/migrations/0002-yoco-v2-sale-shadow.sql
cloudflare-v2/src/modules/yoco-engine-v2/migrations/0003-yoco-v2-refund-reconciliation.sql
cloudflare-v2/src/modules/yoco-engine-v2/migrations/0004-yoco-v2-controlled-cutover.sql
cloudflare-v2/src/modules/yoco-engine-v2/migrations/0005-yoco-v2-refund-controlled-cutover.sql
cloudflare-v2/src/modules/yoco-engine-v2/migrations/0006-yoco-v2-legacy-shutdown.sql
```

No legacy webhook, subscription, credential, sale, refund, stock, or reporting implementation is removed.

## Fail-closed defaults

```text
YOCO_V2_CAPTURE_ENABLED=false
YOCO_V2_QUEUE_ENABLED=false
YOCO_V2_ADMIN_ENABLED=false
YOCO_V2_SHADOW_SALES_ENABLED=false
YOCO_V2_SHADOW_REFUNDS_ENABLED=false
YOCO_V2_LIVE_SALE_REPORTING=false
YOCO_V2_LIVE_SALE_STOCK=false
YOCO_V2_LIVE_REFUND_REPORTING=false
YOCO_V2_LIVE_REFUND_STOCK=false
YOCO_V2_PILOT_WORKSPACE_IDS=
YOCO_V2_REFUND_PILOT_WORKSPACE_IDS=
YOCO_V2_CUTOVER_MIN_COMPARISONS=25
YOCO_V2_CUTOVER_WINDOW_HOURS=24
YOCO_V2_CUTOVER_TRANSITION_MINUTES=30
YOCO_V2_LEGACY_SHUTDOWN_ENABLED=false
YOCO_V2_OBSERVATION_MIN_HOURS=168
YOCO_V2_PHASE13_REMOVAL_ENABLED=false
```

Do not use broad values such as `true`, `all`, or `*` for live pilot effects. Use one explicit workspace ID.

## Controlled API defaults

```text
YOCO_V2_API_TIMEOUT_MS=15000
YOCO_V2_REQUEST_SPACING_MS=250
YOCO_V2_ORDER_CACHE_TTL_MS=30000
YOCO_V2_REFUND_CACHE_TTL_MS=20000
YOCO_V2_METADATA_CACHE_TTL_MS=60000
YOCO_V2_AUTH_FAILURE_THRESHOLD=2
YOCO_V2_RATE_LIMIT_PAUSE_FALLBACK_MS=30000
YOCO_V2_RECONCILIATION_OVERLAP_MINUTES=120
YOCO_V2_RECONCILIATION_LOOKBACK_HOURS=24
```

Request spacing is conservative coordination, not a claim about an undocumented Yoco rate limit. A provider `Retry-After` response takes precedence.

## Safe staging sequence

1. Deploy with `YOCO_V2_LEGACY_SHUTDOWN_ENABLED=false` and `YOCO_V2_PHASE13_REMOVAL_ENABLED=false`.
2. Confirm `/api/runtime-version` reports `phase-v2-12-yoco-legacy-shutdown`.
3. Confirm tenant migrations 22 through 27 complete.
4. Confirm the current webhook URL and subscription count are unchanged.
5. Confirm sales and refunds are already V2-owned and stable through the Phase 10 and Phase 11 controls.
6. Run `npm --prefix cloudflare-v2 run audit:yoco-v2-admin-dependencies`.
7. Revalidate the sale and refund rollback runbooks.
8. Query the fleet readiness endpoint and resolve every unavailable or blocked workspace.
9. Add only the approved workspace IDs to `YOCO_V2_LEGACY_SHUTDOWN_ENABLED`.
10. Record dependency and rollback evidence per workspace.
11. Start observation independently for each approved workspace.
12. Inspect scheduled and manual observation snapshots throughout the minimum period.
13. Treat every legacy invocation alert as a blocker requiring investigation.
14. Approve observation only when every snapshot in the period is clean.
15. Keep `YOCO_V2_PHASE13_REMOVAL_ENABLED=false` until a separately approved removal change.

## Production boundary

A production code deployment is safe with the new Phase 12 flags disabled. Do not activate fleet shutdown from the source package alone. Use the runtime fleet endpoints and complete the real observation period against deployed workspace data.

## Validation commands

```bash
npm ci
npm --prefix cloudflare-v2 ci
npm test
npm run build
npm --prefix cloudflare-v2 test
npm --prefix cloudflare-v2 run typecheck
npm --prefix cloudflare-v2 run deploy:dry
cp cloudflare-v2/wrangler.staging.toml.example cloudflare-v2/wrangler.staging.validation.toml
(cd cloudflare-v2 && npx wrangler deploy --dry-run --config wrangler.staging.validation.toml)
rm cloudflare-v2/wrangler.staging.validation.toml
# Run npm run verify:worker-release only after an actual deployment.
```

Replace staging placeholders before a real deployment.

## Operational references

- `CONTROLLED_SALE_CUTOVER_RUNBOOK.md`
- `CONTROLLED_REFUND_CUTOVER_RUNBOOK.md`
- `STAGING_ROLLBACK_DRILL.md`
- `PHASE11_STAGING_REFUND_ROLLBACK_DRILL.md`
- `ROLLBACK.md`
- `PHASE12_OBSERVATION_RUNBOOK.md`
- `PHASE12_ADMIN_DEPENDENCY_AUDIT.md`
- `LEGACY_REMOVAL_MANIFEST_PHASE13.md`
- `PHASE13_BLOCKER_AND_EXECUTION_PLAN.md`
- `RELEASE_AUDIT_PHASE_V2_12.md`
