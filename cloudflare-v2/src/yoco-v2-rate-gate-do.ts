import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

const DEFAULT_MIN_INTERVAL_MS = 100;
const MAX_MIN_INTERVAL_MS = 60_000;
const NEXT_ALLOWED_AT_KEY = 'nextAllowedAt';

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requestedInterval(url: URL, body: Record<string, unknown>): number {
  const candidates = [
    body.minIntervalMs,
    body.minSpacingMs,
    body.delayMs,
    url.searchParams.get('minIntervalMs'),
    url.searchParams.get('minSpacingMs'),
    url.searchParams.get('delayMs')
  ];

  for (const candidate of candidates) {
    const parsed = finiteNumber(candidate);
    if (parsed !== null) {
      return Math.max(0, Math.min(MAX_MIN_INTERVAL_MS, Math.floor(parsed)));
    }
  }

  return DEFAULT_MIN_INTERVAL_MS;
}

/**
 * Historical Yoco v2 request gate.
 *
 * This class was provisioned by the already-applied `v2-yoco-rate-gate`
 * migration. It must remain exported so existing objects and any bindings to
 * the namespace continue to resolve. The current KCP request path does not
 * create a new binding to it, but the compatibility implementation retains the
 * original purpose: serialize callers and enforce a small minimum gap between
 * grants without deleting any existing Durable Object storage.
 */
export class YocoV2RateGateDO extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return Response.json(
        { ok: false, error: 'METHOD_NOT_ALLOWED' },
        { status: 405, headers: { Allow: 'GET, POST, OPTIONS' } }
      );
    }

    let releaseQueue!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      const url = new URL(request.url);
      const body =
        request.method === 'POST'
          ? ((await request.clone().json().catch(() => ({}))) as Record<string, unknown>)
          : {};
      const minIntervalMs = requestedInterval(url, body);
      const now = Date.now();
      const storedNext = finiteNumber(await this.ctx.storage.get<number>(NEXT_ALLOWED_AT_KEY)) ?? 0;
      const grantedAt = Math.max(now, storedNext);
      const nextAllowedAt = grantedAt + minIntervalMs;

      await this.ctx.storage.put(NEXT_ALLOWED_AT_KEY, nextAllowedAt);

      const waitedMs = Math.max(0, grantedAt - now);
      if (waitedMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitedMs));
      }

      return Response.json({
        ok: true,
        granted: true,
        waitedMs,
        grantedAt,
        nextAllowedAt
      });
    } finally {
      releaseQueue();
    }
  }
}
