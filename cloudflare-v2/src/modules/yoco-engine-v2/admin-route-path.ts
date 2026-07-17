/**
 * Normalize the public admin route suffix before forwarding it to a workspace Durable Object.
 *
 * Public routes are exposed as:
 *   /api/admin/workspaces/:workspaceId/yoco-v2/admin/<action>
 *
 * Older Phase 12 fleet controls used:
 *   /api/admin/workspaces/:workspaceId/yoco-v2/<action>
 *
 * The workspace Durable Object always expects:
 *   yoco-v2/admin/<action>
 *
 * Stripping one optional leading `admin/` prevents the front Worker from forwarding
 * `yoco-v2/admin/admin/...`, which otherwise falls through as an unknown admin route.
 */
export function normalizeYocoV2AdminActionPath(value: string): string {
  const normalized = String(value || '').replace(/^\/+|\/+$/g, '');
  return normalized.startsWith('admin/') ? normalized.slice('admin/'.length) : normalized;
}
