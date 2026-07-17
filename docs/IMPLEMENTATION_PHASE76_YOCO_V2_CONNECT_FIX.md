# Phase 76: Yoco V2 Connection 500 Fix

## Outcome

The `/api/workspaces/:workspaceId/yoco/connect` flow has been repaired without restoring the retired legacy Yoco sale, refund, webhook, or API-client runtime.

The connection implementation now lives in the Yoco V2 engine, tenant databases self-repair missing V2 connection schema once, and connection failures return a specific V2 error contract instead of an unexplained HTTP 500.

## Root cause

Two issues made the connection flow fragile after legacy removal:

1. The V2 connection orchestration still lived at `cloudflare-v2/src/legacy/yoco-service.ts`. Removing or changing the legacy integration layer could therefore break the user-facing V2 connection route even though the V2 webhook, queue, sale, and refund engine were intact.
2. Some existing Workspace Durable Objects could report the latest `_kcp_schema` migration version while still missing one or more Yoco V2 tables or `yoco_connections` columns. The V2 rate-gated credential validation writes request/runtime records before the connection is persisted, so a missing table surfaced as a generic 500.

The browser message `Unchecked runtime.lastError: A listener indicated an asynchronous response...` is separate from the Worker API failure and is normally produced by a browser extension message listener.

## Code changes

### 1. V2-only connection service

Created:

- `cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts`

Removed:

- `cloudflare-v2/src/legacy/yoco-service.ts`

Updated imports:

- `cloudflare-v2/src/legacy/routes.ts`
- `cloudflare-v2/src/legacy/admin-routes.ts`

The service continues to use:

- the V2 rate-gated catalogue/API client
- V2 effect ownership initialization
- create-before-cleanup webhook handling
- encrypted API-key storage
- catalogue-only initial connection, without historical sale deductions

No retired `yoco-client.ts`, `yoco-sales.ts`, `yoco-webhooks.ts`, or legacy refund processor was restored.

### 2. Tenant V2 schema repair

Created:

- `cloudflare-v2/src/modules/yoco-engine-v2/schema-repair.ts`

Updated:

- `cloudflare-v2/src/workspace-do.ts`

The repair:

- creates `yoco_connections` when absent
- adds missing connection, webhook, fingerprint, cursor, baseline, and timestamp columns
- creates `integration_logs`
- applies the required V2 foundation, request tracking, ownership, reconciliation, controlled-effect, and admin-control schema
- ignores only safe duplicate-column errors from `ALTER TABLE ... ADD COLUMN`
- runs in a synchronous tenant transaction
- writes `yoco-v2-connect-schema-v1` to `_kcp_runtime_repairs` only after success
- retries on the next request if a repair fails
- runs once per tenant instead of on every Durable Object cold start

No manual per-workspace migration is required after the Worker is deployed.

### 3. Structured connection errors

Updated:

- `cloudflare-v2/src/legacy/routes.ts`

A failed connection now returns:

```json
{
  "ok": false,
  "error": "Specific failure reason",
  "details": {
    "code": "YOCO_V2_CONNECT_FAILED",
    "engine": "yoco-v2",
    "retryable": true
  }
}
```

Status behavior:

- `400`: invalid/missing API key or authorization failure
- `429`: Yoco rate limiting
- `503`: missing Worker configuration/binding or tenant schema problem
- `502`: other upstream Yoco or connection failures

Successful responses include:

```json
{
  "ok": true,
  "engine": "yoco-v2"
}
```

The API key is never included in structured logs or responses.

### 4. Release and regression checks

Added:

- `cloudflare-v2/tests/yoco-v2-schema-repair.test.ts`

Updated:

- `cloudflare-v2/package.json`
- `src/modules/reporting/engine/yocoFinancials.test.js`
- `src/phase47PersonalSettingsUomReportingUi.test.js`
- `src/phaseV2FinalLegacyRemovalReportingAudit.test.js`
- `scripts/verify-final-yoco-v2-release.mjs`
- `cloudflare-v2/scripts/audit-yoco-v2-admin-dependencies.mjs`

Coverage verifies:

- a partially migrated tenant is repaired
- the repair is idempotent
- repair execution is marked once per tenant
- failed repairs remain retryable
- the integration service exists only in the V2 module
- retired legacy Yoco runtime files remain absent
- all external Yoco operations still pass through V2 rate-gated clients

## Validation completed

- Frontend tests: **431 passed**
- Frontend production build: **passed**
- Worker TypeScript: **passed**
- Yoco V2 Worker tests: **42 passed**
- Worker dry deployment bundle: **passed**
- Final V2 source audit: **passed**
- V2 admin dependency audit: **passed**

The production runtime-readiness audit still requires exported live evidence. That cannot be generated from this environment without Cloudflare production credentials.

## Deployment

From the project root:

```bash
cd cloudflare-v2
npm install
npm run typecheck
npm test
npm run deploy
```

Before deployment, verify that the production Worker still has the encryption secret:

```bash
npx wrangler secret list
```

Required secret:

```text
YOCO_KEY_ENCRYPTION_SECRET
```

If it is missing:

```bash
npx wrangler secret put YOCO_KEY_ENCRYPTION_SECRET
```

Use the original stable secret when existing Yoco API keys are already encrypted. Replacing it with a different value will make previously encrypted keys unreadable and those workspaces will need to reconnect.

This environment could not query the deployed secret list because no `CLOUDFLARE_API_TOKEN` was available.

## Post-deployment test

1. Deploy the Worker.
2. Open the Sausage Bros workspace integration screen.
3. Enter the Yoco API key and connect.
4. Confirm the network response contains `"engine": "yoco-v2"`.
5. Confirm catalogue items and locations populate.
6. Confirm the webhook is shown as enabled.
7. If the request fails, inspect the returned `YOCO_V2_CONNECT_FAILED` message. It will now identify credentials, rate limiting, missing configuration, schema, or upstream failure directly.
8. Tail the Worker while retrying when deeper diagnostics are needed:

```bash
npx wrangler tail kcp-api-v2
```
