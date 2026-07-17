# Yoco V2 Admin Unknown Route Hotfix 3

Release: `phase-v2-admin-yoco-engine-control-centre-hotfix-3`

## Symptom

The browser requested:

`/api/admin/workspaces/:workspaceId/yoco-v2/admin/control-centre/capabilities`

The Worker returned HTTP 404 with an unknown Yoco V2 admin route error.

## Root cause

The front Worker captured `admin/control-centre/capabilities` and then prefixed it with
`yoco-v2/admin/` before forwarding the request to the workspace Durable Object. The resulting
internal resource was:

`yoco-v2/admin/admin/control-centre/capabilities`

The duplicated `admin/` segment prevented the control-centre router from matching.

## Correction

- Added a dedicated route normalizer that removes one optional leading `admin/` segment.
- Preserved older Phase 12 routes that do not contain the public `admin/` segment.
- Allowed PATCH requests through the same workspace-scoped admin forwarding boundary.
- Added regression tests for the exact capabilities route and legacy Phase 12 route shapes.
- Prefilled `cloudflare-v2/wrangler.toml` for all-workspace capture, queue, admin, and shadow processing.
- Kept all live sale/refund reporting and stock flags disabled.
- Kept legacy shutdown and Phase 13 removal disabled.

## Safety state

The corrected production configuration is:

- V2 capture: all workspaces
- V2 queue: all workspaces
- V2 admin: all workspaces
- V2 sale shadow: all workspaces
- V2 refund shadow: all workspaces
- V2 live sale reporting: false
- V2 live sale stock: false
- V2 live refund reporting: false
- V2 live refund stock: false
- Legacy shutdown: false
- Phase 13 removal: false

No sale, refund, stock, or reporting business logic was changed.
