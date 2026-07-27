# Kitchen Cost Pro Yoco V2 Final Engine and Admin Audit

Release: `phase-v2-admin-yoco-engine-control-centre-hotfix-8-final-audited`

Date: 2026-07-15

## Executive result

The Yoco V2 observation and shadow-processing release was audited from a clean extraction and clean dependency installation.

The release is suitable for continued localhost and pre-live transaction testing in shadow mode.

The audit does not claim that a real Yoco refund has completed successfully in the deployed account. That final external verification must be performed after this release is deployed and the existing dead-letter refund is requeued.

## Install failure root cause

The reported TypeScript failure was caused by a damaged `node_modules/.bin/tsc` launcher in a Google Drive-synchronised project directory.

A normal npm installation creates `node_modules/.bin/tsc` as a symbolic link to `node_modules/typescript/bin/tsc`. The damaged installation contained a copied launcher file instead. Its relative import then incorrectly resolved `../lib/tsc.js` from `node_modules/.bin`.

This was not caused by the Yoco engine and was not caused by TypeScript source errors.

## Install and deployment hardening

The release now:

- Deletes both root and Worker `node_modules` folders before a deployment install.
- Uses `npm ci` and both committed lockfiles.
- Calls Vite, TypeScript, TSX and Wrangler through their real package paths instead of `node_modules/.bin` launchers.
- Pins and approves only the dependency install scripts required by the current locked packages.
- Supports Node.js 22 through 24 and npm 10 or later.
- Includes `npm run verify:yoco-v2-release` for a non-deploying release gate.
- Includes `npm run deploy:local:clean` for clean install, full validation, Worker deployment and localhost startup.

The Google Drive failure was reproduced deliberately by replacing the TypeScript and Vite bin links with copied files. Type-checking, tests and the production build still passed with the hardened scripts.

## Configuration audit

The committed `cloudflare-v2/wrangler.toml` is prefilled as follows:

### Enabled for every workspace

- `YOCO_V2_CAPTURE_ENABLED = "all"`
- `YOCO_V2_QUEUE_ENABLED = "all"`
- `YOCO_V2_ADMIN_ENABLED = "all"`
- `YOCO_V2_SHADOW_SALES_ENABLED = "all"`
- `YOCO_V2_SHADOW_REFUNDS_ENABLED = "all"`

### Locked off

- `YOCO_V2_LIVE_SALE_REPORTING = "false"`
- `YOCO_V2_LIVE_SALE_STOCK = "false"`
- `YOCO_V2_LIVE_REFUND_REPORTING = "false"`
- `YOCO_V2_LIVE_REFUND_STOCK = "false"`
- `YOCO_V2_LEGACY_SHUTDOWN_ENABLED = "false"`
- `YOCO_V2_PHASE13_REMOVAL_ENABLED = "false"`

### Queue bindings confirmed

- Producer and consumer queue: `kcp-yoco-v2-events`
- Dead-letter queue: `kcp-yoco-v2-events-dlq`

The Wrangler deployment dry run resolved both queues, both Durable Objects, the central D1 binding and all required V2 environment variables.

## Engine audit

### Webhook capture and queueing

Confirmed by automated tests:

- Deterministic event identity.
- Duplicate delivery detection.
- Signature state display.
- Capture and queue publication state.
- Queue publication failure remains observable and replayable.
- Queue-disabled workspaces fail safely without creating live effects.

### Sale observation and shadow comparison

Confirmed by automated tests:

- Legacy remains the owner of sale reporting and sale stock.
- A completed legacy sale creates an idempotent post-commit V2 observation event.
- The observation event is visible under the current South African day filter.
- Canonical sale storage succeeds.
- Ingredient proposal generation succeeds.
- Legacy versus V2 comparison succeeds.
- Duplicate processing cannot create duplicate live effects.
- No V2 live stock or reporting writes occur in this release configuration.

### Refund resolution

Confirmed by automated tests:

- A flat `payment.refunded` webhook can discover the real Yoco refund.
- Correlation can succeed by payment ID when Yoco order references differ.
- Refund searches use the updated-time window and approved status.
- Provisional webhook identities are upgraded to the real refund identity.
- Partial line refunds resolve the correct returned quantity.
- Amount-only refunds create manual review and no automatic stock allocation.
- Previous refunds reduce remaining refundable quantities.
- Over-refund is blocked.
- Duplicate refund events do not duplicate results.
- Refund detail uses the deployed stock-movement schema.
- Financial, inventory, reporting and reconciliation statuses remain independent.

### Retry and dead-letter handling

Confirmed by automated tests:

- Retryable Yoco visibility delays remain retryable.
- Exhausted temporary failures enter dead letter.
- Replaying an exhausted event resets attempts to zero before publication.
- Dead-letter requeue requires confirmation.
- Requeue is idempotent.
- Requeue records an admin audit entry and timeline entry.
- Requeue always publishes with `live_effects: false`.
- Historical failure records are retained.

### Migration integrity

Confirmed by automated SQLite migration application:

- Ordinary SQL statement splitting.
- Quoted semicolon handling.
- Complete `BEGIN ... END` trigger handling.
- `CASE ... END` does not terminate triggers early.
- Every Yoco V2 migration and all trigger definitions apply successfully.
- Legacy tables remain present.
- No Phase 13 deletion executor exists.

## Admin control-centre audit

Confirmed by automated tests and source audits:

- Public admin route normalisation does not duplicate `/admin`.
- Empty workspace IDs never issue API requests.
- Workspace scoping is applied to list and detail queries.
- Raw payloads are excluded from list endpoints.
- Raw payload detail is loaded on demand.
- Payloads and headers are redacted.
- Timeline rows are ordered and append-only.
- Server-side pagination supports 25, 50 and 100 rows.
- Date-only filters include the complete South African day.
- Filter state is preserved.
- No random page reload exists.
- Custom dropdowns render above modals and drawers.
- Replay and dead-letter actions require idempotency keys.
- Configuration reports shadow-only mode.
- Live controls remain unusable.
- SUPER users receive the explicit V2 permission set.

## Legacy preservation audit

The dependency and Phase 12 safety audits passed and confirmed:

- Legacy sale processor remains present.
- Legacy refund processor remains present.
- Legacy sync remains present.
- Legacy retry remains present.
- Legacy routes remain present.
- There is one external Yoco webhook ingress.
- The V2 admin module does not import or call legacy processors.
- V2 admin does not depend on the legacy webhook event table.
- No legacy table deletion was added.
- Legacy shutdown is disabled.
- Phase 13 removal is disabled.

## Validation results

### Automated tests

- Frontend and application tests: 503 passed, 0 failed.
- Worker and Yoco V2 tests: 122 passed, 0 failed.
- Total: 625 passed, 0 failed.

### Build and release gates

- Worker TypeScript type-check: passed.
- Production Vite build: passed.
- Yoco V2 admin dependency audit: passed.
- Phase 12 safety audit: passed.
- Wrangler production deployment dry run: passed.
- Deliberately broken `.bin/tsc` launcher regression: passed.
- Deliberately broken `.bin/vite` launcher regression: passed.

### Dependency audit

- Worker production dependencies: 0 known vulnerabilities.
- Root production dependencies: 0 high, 0 critical, 2 moderate findings inherited through `exceljs -> uuid`.

The moderate root findings are not in the Yoco V2 Worker execution path. They were not changed in this release because npm's suggested resolution is an ExcelJS downgrade and could regress report exports. This remains a non-blocking dependency-maintenance item.

## Known non-blocking items

- The frontend build reports large bundle warnings. The build completes successfully.
- Some existing modules are both statically and dynamically imported. The build completes successfully.
- The isolated SQLite test fixture does not create the legacy `integration_logs` table, so one diagnostic persistence attempt is intentionally non-fatal in test output.

## Required live verification after deployment

After deployment:

1. Requeue the existing refund event from Dead Letter.
2. Confirm attempts restart from 0.
3. Confirm API Health shows a successful refund-resource request or a clear Yoco error.
4. Confirm Refunds displays the real refund ID, original order and amount.
5. Confirm the refund ends as `COMPLETED` or `MANUAL_REVIEW_REQUIRED`, not an unexplained dead letter.
6. Confirm legacy changed stock/reporting at most once.
7. Confirm V2 created no live stock or reporting movements.

If it dead-letters again, record the structured error category, code and API Health row. That would indicate a live Yoco data/API condition rather than the previously fixed attempt-reset and correlation defects.

## Deployment

From the project root:

```bash
npm run deploy:local:clean
```

This command performs a destructive cleanup of dependency folders only. It does not delete application data, D1 data, Durable Object data or queue history.

## Verification without deployment

```bash
rm -rf node_modules cloudflare-v2/node_modules
npm ci --no-audit --no-fund
(cd cloudflare-v2 && npm ci --no-audit --no-fund)
npm run verify:yoco-v2-release
```

## Final conclusion

The source release, migration path, admin control centre, sale shadow flow, refund resolution flow, replay reset, dead-letter requeue, workspace isolation and shadow-only safety gates pass the complete automated release gate.

The only remaining confirmation is the external live Yoco refund replay after deployment. No source audit can substitute for that provider-side verification.
