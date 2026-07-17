import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import type { YocoV2RateGateRequest } from './modules/yoco-engine-v2/contracts';
import { YocoV2RateGateCoordinator } from './modules/yoco-engine-v2/rate-gate';

export class YocoV2RateGateDO extends DurableObject<Env> {
  private readonly coordinator: YocoV2RateGateCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new YocoV2RateGateCoordinator(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/state') {
      return Response.json({ ok: true, circuit: await this.coordinator.getCircuitState() });
    }
    if (request.method === 'POST' && url.pathname === '/clear-credential-circuit') {
      return Response.json({ ok: true, circuit: await this.coordinator.clearCredentialCircuit() });
    }
    if (request.method !== 'POST' || url.pathname !== '/fetch') {
      return Response.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }

    const input = await request.json<YocoV2RateGateRequest>().catch(() => null);
    if (!input || !input.integrationId || !input.requestKey || !input.url || !input.apiKey) {
      return Response.json({ ok: false, error: 'Invalid rate-gate request.' }, { status: 400 });
    }
    const allowedOrigin = new URL(this.env.YOCO_API_BASE_URL || 'https://api.yoco.com').origin;
    let requestOrigin = '';
    try { requestOrigin = new URL(input.url).origin; } catch { /* validated below */ }
    if (requestOrigin !== allowedOrigin) {
      return Response.json({ ok: false, error: 'Yoco V2 rate gate rejected a non-Yoco endpoint.' }, { status: 400 });
    }
    const result = await this.coordinator.execute(input);
    return Response.json(result);
  }
}
