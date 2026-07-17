# Yoco V2 Admin Capabilities 500 Hotfix

## Symptom

The admin control centre fails to load and the browser reports:

`GET /api/admin/workspaces/{workspaceId}/yoco-v2/admin/control-centre/capabilities 500`

Browser messages mentioning `goog#html`, Trusted Types, `gaoptout.js`, Turnstile, or sandboxed `about:blank` frames are unrelated to this Worker failure.

## Root cause

The workspace Durable Object migration runner previously split migration scripts at every semicolon. SQLite trigger definitions contain semicolons inside their `BEGIN ... END` bodies. The runner therefore sent incomplete `CREATE TRIGGER` fragments to Durable Object SQLite, preventing the pending Yoco V2 tenant migrations from completing. The Durable Object failed before the capabilities route could execute.

## Fix

`cloudflare-v2/src/d1-facade.ts` now uses a trigger-aware SQL statement splitter. It preserves complete trigger bodies, handles quoted semicolons, SQL comments, escaped quotes, and `CASE ... END` expressions inside triggers.

The fix does not change Yoco capture, queue, sale, refund, stock, reporting, reconciliation, ownership, or legacy-processing logic.

## Recovery behavior

No database reset is required. On the first request after the patched Worker is deployed, each workspace Durable Object reruns its pending migration from its recorded schema version. The V2 migrations use idempotent table, index, and trigger creation, allowing a workspace to recover safely if a prior migration attempt stopped before completion.

## Validation

- 498 frontend tests passed.
- 111 Worker and Yoco V2 tests passed.
- All seven V2 migrations were applied statement-by-statement to a fresh SQLite database in an automated regression test.
- All 16 Yoco V2 trigger definitions were created successfully.
- TypeScript type-check passed.
- Production frontend build passed.
- Wrangler deployment dry run passed.

## Deployment

Deploy the patched Worker first. A frontend deployment is not required for this specific fix, although deploying the matching complete release is safe.

```bash
cd cloudflare-v2
npm install
npm run typecheck
npm test
npm run deploy
```

Then reload the admin console and open **Yoco V2 Engine**. The first request to each workspace may perform its pending Durable Object migrations before returning the capabilities response.

## Safety state

Keep these enabled for observation and shadow processing:

- `YOCO_V2_CAPTURE_ENABLED = "all"`
- `YOCO_V2_QUEUE_ENABLED = "all"`
- `YOCO_V2_ADMIN_ENABLED = "all"`
- `YOCO_V2_SHADOW_SALES_ENABLED = "all"`
- `YOCO_V2_SHADOW_REFUNDS_ENABLED = "all"`

Keep all live-effect, legacy-shutdown, and Phase 13 flags set to `"false"`.
