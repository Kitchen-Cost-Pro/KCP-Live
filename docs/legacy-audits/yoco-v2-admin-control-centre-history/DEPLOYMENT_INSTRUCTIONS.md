# Deployment Instructions

## Release

`phase-v2-admin-yoco-engine-control-centre`

Deploy the Worker first, verify it, then deploy Pages. This order prevents the new frontend from calling routes that are not yet available.

## 1. Pre-deployment checks

From the project root:

```bash
npm install --no-audit --no-fund
npm install --no-audit --no-fund --prefix cloudflare-v2
npm test
npm run typecheck:worker
npm --prefix cloudflare-v2 test
npm run build
npm --prefix cloudflare-v2 run deploy:dry
```

Do not continue if a command fails.

## 2. Configuration boundary

Preserve the current workspace lists for capture, queue, shadow, and any previously governed cutover phase.

The only flag required to expose this admin surface is:

```toml
YOCO_V2_ADMIN_ENABLED = "<comma-separated workspace IDs or existing configured value>"
```

Do not enable or broaden these flags as part of this release:

```toml
YOCO_V2_LIVE_SALE_REPORTING = "false"
YOCO_V2_LIVE_SALE_STOCK = "false"
YOCO_V2_LIVE_REFUND_REPORTING = "false"
YOCO_V2_LIVE_REFUND_STOCK = "false"
```

Do not change effect ownership. It must remain `LEGACY` during this admin rewire.

## 3. Deploy the Worker

```bash
npm run deploy:worker
```

The next request to each workspace Durable Object applies tenant migration 28 automatically through the existing tenant migration runner.

Verify the deployed release reports:

```text
phase-v2-admin-yoco-engine-control-centre
```

## 4. Verify migration state

Open the admin console and select **Yoco V2 Engine** for one pilot workspace. Confirm:

- Capabilities and Configuration load without a migration error.
- Configuration says **Shadow only**.
- all four live effects show Disabled.
- all four effect ownership rows show LEGACY.
- webhook receipts and admin action tables are available after the first relevant event/action.

For a direct database verification in a controlled maintenance session, confirm these tables exist in the workspace database:

```sql
SELECT name
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('yoco_v2_webhook_receipts', 'yoco_v2_admin_actions');
```

## 5. Deploy Pages

```bash
npm run build
npx wrangler pages deploy dist --project-name kcp-live
```

The build copies the updated admin console to `/admin/index.html` and includes `yoco-v2-admin.js` and `yoco-v2-admin.css` from `public/`.

## 6. Production smoke test

1. Sign in to `/admin` as a SUPER user.
2. Open **Legacy Yoco Integration** and confirm the existing workspace status and actions still render.
3. Open **Yoco V2 Engine**.
4. Confirm Production banner and Shadow-only lock.
5. Select a workspace and verify Overview metrics load.
6. Open Event Inbox and confirm pagination defaults to 25.
7. Open an event and confirm payload is fetched in the drawer, redacted, and timeline ordered.
8. Find a duplicate event or use the duplicate filter.
9. Open Configuration and confirm live controls are false and read-only.
10. Perform one eligible replay using a test event. Confirm only one shadow queue message and one admin audit action are created.
11. Return to Legacy Yoco Integration and confirm processing remains active.

## 7. Post-deployment monitoring

For the first production observation window, monitor:

- `yoco_v2_webhook_receipts.capture_status`
- `yoco_v2_webhook_receipts.queue_status`
- `yoco_v2_raw_events.processing_status`
- `yoco_v2_admin_actions.status`
- queue publication failures
- invalid signatures
- dead-letter backlog
- 429 and authentication responses

Do not use an HTTP 200 webhook response as the health criterion. Use the structured capture, queue, processing, API, and reconciliation states shown by the control centre.
