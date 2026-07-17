# Legacy Yoco Removal Audit

**Release:** `phase-v2-final-legacy-removal-reporting-audit`  
**Audit date:** 2026-07-16  
**Decision:** Source cleanup is ready for validation. Production acceptance remains blocked until the runtime observation evidence passes `npm run audit:yoco-v2-runtime-readiness`.

## 1. Readiness result

| Gate | Status | Evidence |
|---|---|---|
| Single V2 webhook ingress | PASS | `webhook-ingress.ts`, V2 route dispatch, final static audit |
| Canonical sale processing | PASS | `processor.ts`, `effect-proposals.ts`, `live-sale.ts` |
| Canonical refund processing | PASS | `processor.ts`, `refund-effect-proposals.ts`, `live-refund.ts` |
| V2-only effect ownership | PASS | New integrations initialize all four V2 owners. Existing incomplete or non-V2 ownership fails before remote connection changes. |
| V2 rate gate and Retry-After | PASS | Remote catalogue, location, modifier, validation, and webhook subscription requests use `api-client.ts` through `catalog-client.ts`. |
| Reconciliation uses canonical processors | PASS | `reconciliation.ts` creates or enriches canonical events and applies V2 effects. |
| Legacy execution during production observation period | NOT VERIFIED | Requires exported production evidence. No source archive can establish live execution counts. |
| No critical unresolved production V2 failures | NOT VERIFIED | Requires current production engine health data. |

## 2. Removed runtime assets

The following obsolete business-processing files were deleted:

- `cloudflare-v2/src/legacy/yoco-sales.ts`
- `cloudflare-v2/src/legacy/yoco-webhooks.ts`
- `cloudflare-v2/src/legacy/yoco-refund-context.ts`
- `cloudflare-v2/src/legacy/yoco-client.ts`
- `cloudflare-v2/src/modules/yoco-engine-v2/sale-shadow.ts`
- `cloudflare-v2/src/modules/yoco-engine-v2/refund-shadow.ts`
- `cloudflare-v2/src/modules/yoco-engine-v2/legacy-shutdown.ts`
- `cloudflare-v2/src/modules/yoco-engine-v2/legacy-shadow-observer.ts`

Obsolete local activation, shadow enablement, Phase 12 safety, and old verification scripts were also deleted.

The file-level comparison against the original upload records **65 deleted**, **64 added**, and **38 modified** source/document files after excluding generated dependencies, build output, local environment files, and macOS metadata. See `release-evidence/CHANGE_MANIFEST.md`.

## 3. Removed routes, jobs, and actions

Removed production capabilities include:

- direct legacy webhook sale and refund processing
- manual legacy sales sync and historical backfill paths
- legacy refund retry, recovery, and refund alarm execution
- legacy reconciliation and transition jobs
- shadow comparison and recompare actions
- pilot and prelaunch activation paths
- rollback functions that could reassign effects to LEGACY
- legacy admin resync, retry, replay, subscription-reset, and free-text log controls

The admin surface now uses V2 reconciliation, structured processing runs, canonical events, live effect outboxes, dead-letter state, and trace timelines.

## 4. Retained or migrated assets

| Asset | Classification | Reason |
|---|---|---|
| `stock_movements` | KEEP | Inventory source of truth and historical audit ledger |
| `yoco_orders` and Yoco order lines | KEEP | Canonical reporting history and sale/refund traceability |
| V2 raw events, canonical events, runs, outboxes, proposals, failures | KEEP | Processing, support, reconciliation, and idempotency evidence |
| `integration_effect_ownership` history | KEEP | Proves historical authority and final V2 ownership |
| Historical cutover and comparison tables | ARCHIVE FOR AUDIT | No longer drive runtime decisions, but explain prior migration activity |
| Earlier phase documents | ARCHIVE FOR AUDIT | Moved under `docs/legacy-audits/`; clearly marked non-operational |
| Connection and catalogue mapping service | MIGRATE/KEEP | Still required for credentials, locations, items, modifiers, mapping, and webhook subscription lifecycle; all Yoco requests now use the V2 client |
| Generic files under `src/legacy/` | KEEP | The directory contains the existing application router and non-Yoco business modules. Its name alone is not evidence of legacy Yoco execution. |

## 5. Database decision

No historical Yoco or reporting table is automatically dropped in this release.

This is intentional because the archive alone cannot prove that every historical table is legally or operationally disposable. Application dependencies on obsolete processors were removed first. Historical comparison, cutover, and ownership records are retained as audit evidence but are not consulted to select an execution engine.

A future destructive migration may be created only after production read/write telemetry proves zero use and the data-retention owner approves the drop list.

## 6. Ownership safety

The four required effects are:

- `SALE_REPORTING`
- `SALE_STOCK`
- `REFUND_REPORTING`
- `REFUND_STOCK`

New integrations receive enabled V2 ownership for all four. Existing workspaces with partial, disabled, or non-V2 ownership raise `YOCO_V2_OWNERSHIP_REQUIRES_EXPLICIT_MIGRATION`. The preflight occurs before credential validation or webhook modification, preventing an external connection mutation before the ownership blocker is surfaced.

No runtime function can assign an effect back to LEGACY.

## 7. Direct API audit

The only approved direct remote Yoco request implementation is `cloudflare-v2/src/modules/yoco-engine-v2/api-client.ts`. Higher-level catalogue and subscription operations call it through `catalog-client.ts`.

The final static audit recursively scans Worker source and fails when another source file directly fetches `https://api.yoco.com`.

## 8. Runtime observation evidence required

Before deployment acceptance, export the production evidence described in `docs/yoco-v2/RUNTIME_READINESS_EVIDENCE.md`. The gate requires:

- enabled V2 ownership for all four effects on every active workspace
- active webhook, queue, raw-event, canonical-event, stock, reconciliation, dead-letter, admin-diagnostic, and rate-limit capabilities
- zero calls to every listed legacy processor, writer, route, scheduled job, and admin action during the approved observation period
- zero unresolved critical V2 failures

Run:

```bash
npm run audit:yoco-v2-runtime-readiness -- runtime-evidence/yoco-v2-readiness.json
```

Missing evidence deliberately exits with `YOCO_V2_RUNTIME_EVIDENCE_REQUIRED`.

## 9. Validation commands

```bash
npm run audit:yoco-v2-final
npm --prefix cloudflare-v2 run audit:yoco-v2-final
npm test
npm run build
npm --prefix cloudflare-v2 run typecheck
npm --prefix cloudflare-v2 test
npm --prefix cloudflare-v2 run deploy:dry
```

Final command results are recorded in `release-evidence/validation-summary.json`.

| Validation | Result |
|---|---|
| Final source audit | PASS, 24 checks passed |
| Worker source audit | PASS |
| Frontend and reporting tests | PASS, 426 of 426 |
| Worker V2 tests | PASS, 39 of 39 |
| Worker TypeScript typecheck | PASS |
| Frontend production build | PASS WITH WARNING, existing large-chunk warning only |
| Cloudflare deployment dry run | PASS |
| Production runtime readiness | PENDING, `YOCO_V2_RUNTIME_EVIDENCE_REQUIRED` |

## 10. Remaining risks and rollback limitations

- Production ownership and observation evidence must still be collected from the deployed environment.
- Production reconciliation must be run over an approved window containing the required sale and refund fixtures.
- Historical legacy execution code is intentionally absent, so rollback means restoring the previous release and its compatible schema/configuration, not toggling a runtime LEGACY owner.
- Historical tables are retained, but they are not a supported execution fallback.
- Export and scheduled-report parity tests in the source suite validate shared code paths; current production data parity must be captured after deployment.

## 11. Acceptance

Do not mark the release complete when the runtime evidence audit, production reconciliation, or any validation command fails. Source cleanup alone is not production acceptance.
