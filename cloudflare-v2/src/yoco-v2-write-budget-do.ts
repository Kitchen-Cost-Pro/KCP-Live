import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import { YocoV2WriteBudgetCoordinator, type WriteBudgetReserveInput } from './modules/yoco-engine-v2/write-budget';

export class YocoV2WriteBudgetDO extends DurableObject<Env> {
  private readonly coordinator: YocoV2WriteBudgetCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new YocoV2WriteBudgetCoordinator(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/state') {
      return Response.json({ ok: true, state: await this.coordinator.getState() });
    }
    if (request.method !== 'POST' || url.pathname !== '/reserve') {
      return Response.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }

    const input = await request.json<WriteBudgetReserveInput>().catch(() => null);
    if (!input || !Number.isFinite(input.estimatedWrites) || !Number.isFinite(input.dailyCap)) {
      return Response.json({ ok: false, error: 'Invalid write-budget reserve request.' }, { status: 400 });
    }
    const result = await this.coordinator.reserve(input);
    return Response.json({ ok: true, ...result });
  }
}
