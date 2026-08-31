import type { AuthContext, Env } from '../../legacy/types';
import { handleXeroAdminRoute } from './admin-routes';

/** Mirrors modules/yoco-engine-v2/route-dispatch.ts: an isolated, resource-string dispatcher
 * checked before the shared legacy dispatcher (see workspace-do.ts), so this module owns its own
 * routes end to end without touching the legacy dispatch table. */
export async function dispatchXeroWorkspaceRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  resource: string
): Promise<Response | null> {
  return handleXeroAdminRoute(request, env, auth, workspaceId, resource);
}
