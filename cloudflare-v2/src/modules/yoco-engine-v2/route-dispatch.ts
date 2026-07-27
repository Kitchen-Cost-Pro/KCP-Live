import type { AuthContext } from '../../legacy/types';
import type { YocoV2QueueMessage } from './contracts';
import type { YocoV2QueueEnv } from './capture';
import { handleYocoV2AdminRoute } from './admin-routes';
import { processYocoV2QueueMessage } from './processor';
import { yocoV2FeatureFlags } from './config';
import { runScheduledYocoV2Reconciliation } from './reconciliation';
import { handleYocoV2WebhookIngress } from './webhook-ingress';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export async function dispatchYocoV2WorkspaceRoute(
  request: Request,
  env: YocoV2QueueEnv,
  auth: AuthContext,
  workspaceId: string,
  resource: string
): Promise<Response | null> {
  if (request.method === 'POST' && resource === 'yoco-v2/webhook') {
    return handleYocoV2WebhookIngress(request, env, auth, workspaceId);
  }

  const admin = await handleYocoV2AdminRoute(request, env, auth, workspaceId, resource);
  if (admin) return admin;

  if (request.method === 'POST' && resource === 'yoco-v2/reconciliation/scheduled') {
    if (auth.uid !== 'system' && auth.systemRole !== 'queue' && auth.systemRole !== 'admin') return response({ ok: false, error: 'Internal reconciliation route only.' }, 403);
    const flags = yocoV2FeatureFlags(env, workspaceId);
    if (!flags.yoco_v2_queue_enabled) {
      return response({ ok: true, skipped: true, reason: 'V2 queue processing is disabled for this workspace.' });
    }
    try {
      const run = await runScheduledYocoV2Reconciliation(env, workspaceId, `yoco:${workspaceId}`);
      return response({ ok: true, skipped: !run, run });
    } catch (cause) {
      return response({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }, 503);
    }
  }

  if (request.method === 'POST' && resource === 'yoco-v2/queue/process') {
    if (auth.uid !== 'yoco-v2-queue' || auth.systemRole !== 'queue') return response({ ok: false, error: 'Internal queue route only.' }, 403);
    const message = await request.json<YocoV2QueueMessage>().catch(() => null);
    if (!message) return response({ ok: false, action: 'ack', error: 'Invalid queue message.' }, 400);
    const result = await processYocoV2QueueMessage(env, message);
    return response(result, result.ok ? 200 : result.action === 'retry' ? 503 : 200);
  }

  return null;
}
