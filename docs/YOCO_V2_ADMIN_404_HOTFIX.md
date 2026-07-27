# Yoco V2 Admin 404 Hotfix 2

## Root causes

1. The full hotfix release retained fail-closed defaults in `cloudflare-v2/wrangler.toml`. Extracting it could therefore restore `YOCO_V2_ADMIN_ENABLED = "false"`. The V2 admin route intentionally returns HTTP 404 while that feature gate is disabled.
2. The admin V2 script could initialize before the workspace registry had loaded and send one invalid request containing `/api/admin/workspaces//`.

## Corrections

- Added `npm run configure:yoco-v2-shadow-all` to enable capture, queue, admin, sale shadow, and refund shadow for every workspace.
- The same command explicitly keeps all four V2 live-effect flags false, clears pilot allowlists, and keeps legacy shutdown and Phase 13 removal false.
- The frontend now waits for the KCP admin workspace registry before performing any V2 API request.
- Added regression coverage preventing an empty workspace route.

## No business-logic changes

This hotfix does not change sale, refund, stock, reporting, reconciliation, or legacy processing logic.
