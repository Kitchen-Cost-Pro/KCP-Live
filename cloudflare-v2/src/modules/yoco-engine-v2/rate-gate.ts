import type {
  YocoV2ApiClassification,
  YocoV2CircuitState,
  YocoV2RateGateRequest,
  YocoV2RateGateResponse
} from './contracts';
import { sha256Hex } from './identity';

const DEFAULT_CIRCUIT: YocoV2CircuitState = {
  pausedUntil: null,
  pauseReason: null,
  interventionRequired: false,
  consecutiveAuthFailures: 0,
  consecutiveRateLimits: 0,
  updatedAt: new Date(0).toISOString()
};

interface StoredCacheEntry {
  expiresAt: number;
  response: Omit<YocoV2RateGateResponse, 'cacheStatus'>;
}

export interface RateGateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export type RateGateFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function classifyYocoV2HttpStatus(status: number): YocoV2ApiClassification {
  if (status >= 200 && status < 300) return 'SUCCESS';
  if (status === 404) return 'NOT_FOUND';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'RETRYABLE_SERVER_ERROR';
  if (status >= 400) return 'NON_RETRYABLE_CLIENT_ERROR';
  return 'INVALID_RESPONSE';
}

export function yocoV2RetryAfterSeconds(headers: Headers, nowMs = Date.now()): number {
  const raw = String(headers.get('retry-after') || '').trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) return Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
  }
  for (const name of ['ratelimit-reset', 'x-ratelimit-reset']) {
    const value = Number(headers.get(name));
    if (!Number.isFinite(value) || value <= 0) continue;
    const resetMs = value > 10_000_000_000 ? value : value * 1000;
    return Math.max(0, Math.ceil((resetMs - nowMs) / 1000));
  }
  return 0;
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['content-type', 'retry-after', 'ratelimit-reset', 'x-ratelimit-reset', 'request-id', 'x-request-id']) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function cloneCircuit(value: YocoV2CircuitState | undefined): YocoV2CircuitState {
  return value ? { ...value } : { ...DEFAULT_CIRCUIT, updatedAt: new Date().toISOString() };
}

function cloneResponse(value: YocoV2RateGateResponse): YocoV2RateGateResponse {
  return {
    ...value,
    responseHeaders: { ...value.responseHeaders },
    circuit: { ...value.circuit }
  };
}

export class YocoV2RateGateCoordinator {
  private readonly inFlight = new Map<string, Promise<YocoV2RateGateResponse>>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: RateGateStorage,
    // Wrap the global fetch so it is always invoked as a free function. Storing the bare `fetch`
    // and calling it as `this.fetcher(...)` invokes it with `this === this coordinator`, which the
    // Cloudflare Workers runtime rejects with "Illegal invocation: function called with incorrect
    // `this` reference." The arrow keeps `this` correct regardless of how the property is called.
    private readonly fetcher: RateGateFetcher = (input, init) => fetch(input, init)
  ) {}

  async getCircuitState(): Promise<YocoV2CircuitState> {
    return cloneCircuit(await this.storage.get<YocoV2CircuitState>('circuit'));
  }

  async clearCredentialCircuit(): Promise<YocoV2CircuitState> {
    const next = { ...DEFAULT_CIRCUIT, updatedAt: new Date().toISOString() };
    await this.storage.put('circuit', next);
    return next;
  }

  async execute(input: YocoV2RateGateRequest): Promise<YocoV2RateGateResponse> {
    const cacheKey = `cache:${await sha256Hex(input.requestKey)}`;
    const now = Date.now();
    if (!input.forceRefresh && input.cacheTtlMs > 0) {
      const cached = await this.storage.get<StoredCacheEntry>(cacheKey);
      if (cached && cached.expiresAt > now) {
        return { ...cached.response, cacheStatus: 'HIT' };
      }
      if (cached) await this.storage.delete(cacheKey);
    }

    const existing = this.inFlight.get(input.requestKey);
    if (existing) {
      const result = cloneResponse(await existing);
      result.cacheStatus = 'COALESCED';
      return result;
    }

    const task = this.serialize(() => this.perform(input, cacheKey));
    this.inFlight.set(input.requestKey, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(input.requestKey);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async perform(input: YocoV2RateGateRequest, cacheKey: string): Promise<YocoV2RateGateResponse> {
    const startedAt = Date.now();
    let circuit = await this.getCircuitState();
    const pausedUntilMs = circuit.pausedUntil ? Date.parse(circuit.pausedUntil) : 0;
    if (circuit.interventionRequired) {
      return {
        ok: false,
        classification: 'UNAUTHORIZED',
        responseStatus: 401,
        bodyText: '',
        responseHeaders: {},
        retryAfterSeconds: 0,
        cacheStatus: input.forceRefresh ? 'BYPASS' : 'MISS',
        durationMs: Date.now() - startedAt,
        circuit,
        errorCode: 'YOCO_V2_CREDENTIAL_INTERVENTION_REQUIRED',
        errorMessage: 'Outbound requests are paused until Yoco credentials are repaired.'
      };
    }
    if (pausedUntilMs > Date.now()) {
      return {
        ok: false,
        classification: 'RATE_LIMITED',
        responseStatus: 429,
        bodyText: '',
        responseHeaders: {},
        retryAfterSeconds: Math.max(1, Math.ceil((pausedUntilMs - Date.now()) / 1000)),
        cacheStatus: input.forceRefresh ? 'BYPASS' : 'MISS',
        durationMs: Date.now() - startedAt,
        circuit,
        errorCode: 'YOCO_V2_INTEGRATION_PAUSED',
        errorMessage: circuit.pauseReason || 'Integration outbound requests are temporarily paused.'
      };
    }

    const nextAllowedAt = Number(await this.storage.get<number>('next-allowed-at') || 0);
    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await this.storage.put('next-allowed-at', Date.now() + Math.max(0, input.requestSpacingMs));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), Math.max(1, input.timeoutMs));
    let response: Response;
    try {
      response = await this.fetcher(input.url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-kcp-trace-id': input.traceId
        },
        body: input.body || undefined,
        signal: controller.signal
      });
    } catch (cause) {
      clearTimeout(timeout);
      const timeoutError = cause instanceof DOMException && cause.name === 'AbortError';
      return {
        ok: false,
        classification: timeoutError ? 'TIMEOUT' : 'NETWORK_ERROR',
        responseStatus: 0,
        bodyText: '',
        responseHeaders: {},
        retryAfterSeconds: 0,
        cacheStatus: input.forceRefresh ? 'BYPASS' : 'MISS',
        durationMs: Date.now() - startedAt,
        circuit,
        errorCode: timeoutError ? 'YOCO_V2_API_TIMEOUT' : 'YOCO_V2_API_NETWORK_ERROR',
        errorMessage: timeoutError ? 'Yoco API request timed out.' : (cause instanceof Error ? cause.message : String(cause))
      };
    } finally {
      clearTimeout(timeout);
    }

    const bodyText = await response.text();
    const classification = classifyYocoV2HttpStatus(response.status);
    const retryAfterSeconds = yocoV2RetryAfterSeconds(response.headers);
    circuit = await this.updateCircuit(circuit, classification, retryAfterSeconds, input);
    const result: YocoV2RateGateResponse = {
      ok: classification === 'SUCCESS',
      classification,
      responseStatus: response.status,
      bodyText,
      responseHeaders: safeResponseHeaders(response.headers),
      retryAfterSeconds,
      cacheStatus: input.forceRefresh ? 'BYPASS' : 'MISS',
      durationMs: Date.now() - startedAt,
      circuit
    };

    if (result.ok && input.cacheTtlMs > 0 && !input.forceRefresh) {
      const { cacheStatus: _cacheStatus, ...cacheableResponse } = result;
      await this.storage.put<StoredCacheEntry>(cacheKey, {
        expiresAt: Date.now() + input.cacheTtlMs,
        response: cacheableResponse
      });
    }
    return result;
  }

  private async updateCircuit(
    previous: YocoV2CircuitState,
    classification: YocoV2ApiClassification,
    retryAfterSeconds: number,
    input: YocoV2RateGateRequest
  ): Promise<YocoV2CircuitState> {
    const now = Date.now();
    const next = cloneCircuit(previous);
    next.updatedAt = new Date(now).toISOString();

    if (classification === 'UNAUTHORIZED' || classification === 'FORBIDDEN') {
      next.consecutiveAuthFailures += 1;
      next.pauseReason = classification === 'UNAUTHORIZED' ? 'INVALID_CREDENTIALS' : 'CREDENTIAL_FORBIDDEN';
      if (next.consecutiveAuthFailures >= input.authFailureThreshold) {
        next.interventionRequired = true;
        next.pausedUntil = null;
      }
    } else if (classification === 'RATE_LIMITED') {
      next.consecutiveRateLimits += 1;
      const pauseMs = retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : Math.max(1_000, input.rateLimitPauseFallbackMs) * Math.min(next.consecutiveRateLimits, 4);
      next.pausedUntil = new Date(now + pauseMs).toISOString();
      next.pauseReason = 'RATE_LIMITED';
    } else if (classification === 'SUCCESS' || classification === 'NOT_FOUND') {
      next.consecutiveAuthFailures = 0;
      next.consecutiveRateLimits = 0;
      next.pausedUntil = null;
      next.pauseReason = null;
      next.interventionRequired = false;
    }
    await this.storage.put('circuit', next);
    return next;
  }
}
