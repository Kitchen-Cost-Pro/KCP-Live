# Release Audit: Phase V2 12 Yoco Legacy Shutdown

Release: `phase-v2-12-yoco-legacy-shutdown`

## Scope result

Phase 12 is implemented as an additive, fail-closed observation and legacy business-processing shutdown layer. Phase 13 deletion is intentionally not executed.

## Architecture assertions

- The single external Yoco webhook ingress remains present.
- Signature verification, credentials, subscription support, and V2 raw capture remain present.
- Legacy sale and refund source code remains in the repository for rollback.
- Legacy business paths are blocked only when configuration, all-four-effect V2 ownership, enabled V2 controls, and an approved shutdown state agree.
- A V2 consumer pause does not reopen legacy writes.
- Phase 12 rollback is rejected until all four effect-specific ownership records have first returned to `LEGACY`.
- Every blocked legacy invocation creates an append-only event and an operational alert.
- V2 admin diagnostics do not depend on legacy processing functions or `yoco_webhook_events`.
- No Phase 13 deletion route or executor exists.

## Observation coverage

The observation snapshot records webhook capture, queue publication, rate limits, sale and refund completion, manual reviews, reconciliation mismatches, duplicate prevention, sale and refund stock accuracy, sale and refund reporting accuracy, dead letters, legacy attempts, and alerts.

An observation cannot be approved when any snapshot in the observation period required attention.

## Fleet coverage

Superusers can query all active workspaces through:

```text
GET /api/admin/yoco-v2/legacy-shutdown/fleet-readiness
GET /api/admin/yoco-v2/legacy-shutdown/fleet-observation
```

There is no bulk activation action.

## Migration

Tenant migration 27 adds:

- `yoco_v2_legacy_shutdown_state`
- `yoco_v2_legacy_shutdown_history`
- `yoco_v2_legacy_invocation_events`
- `yoco_v2_operational_alerts`
- `yoco_v2_observation_snapshots`
- `yoco_v2_admin_dependency_audits`
- `yoco_v2_phase13_removal_gate`

The history and invocation tables are append-only.

## Phase 13 status

`BLOCKED_NOT_EXECUTED`

The removal manifest is documented in `LEGACY_REMOVAL_MANIFEST_PHASE13.md`. Actual removal requires a real deployed observation, explicit confirmation, retention review, migration review, and a separately approved release.

## Deployment truth

This source package has not been deployed and has not observed a real production fleet. It cannot honestly confirm that every current production workspace is V2-owned or that the required observation period has elapsed. The release supplies the controls and fleet diagnostics required to make that confirmation after deployment.

## Validation record

Final validation completed:

- existing application regression suite: **493 passed, 0 failed**
- combined Yoco V2 suite: **100 passed, 0 failed**
- TypeScript compilation: passed
- frontend production build: passed
- V2 admin dependency audit: passed
- Phase 12 safety audit: passed
- production Worker dry-run: passed
- staging configuration dry-run: passed
- SQLite migration integrity check: `ok`
- static verification that legacy code remains: passed
- static verification that no Phase 13 deletion executor exists: passed

The archive integrity and checksum are verified after packaging. See `VALIDATION_RECORD_PHASE_V2_12.md`.
