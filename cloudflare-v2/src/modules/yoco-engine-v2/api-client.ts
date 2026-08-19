import type { Env } from '../../legacy/types';
import { decryptText } from '../../legacy/crypto';
import type {
  YocoV2ApiClassification,
  YocoV2CacheStatus,
  YocoV2CircuitState,
  YocoV2RateGateRequest,
  YocoV2RateGateResponse
} from './contracts';
import { yocoV2ApiConfig } from './config';
import { newId, nowIso, type Row } from './repository';
import { recordYocoV2Diagnostic, recordYocoV2DiagnosticIfNotable } from './observability';

const DEFAULT_YOCO_BASE_URL = 'https://api.yoco.com';

export interface YocoV2ApiClientEnv extends Env {
  YOCO_V2_RATE_GATE?: DurableObjectNamespace;
}

export interface YocoV2ApiRequestContext {
  workspaceId: string;
  integrationId: string;
  rawEventId?: string;
  processingRunId?: string;
  traceId: string;
  attempt?: number;
  endpointName: string;
  resourceId?: string;
  method?: string;
  path: string;
  params?: Record<string, unknown>;
  body?: unknown;
  apiKeyOverride?: string;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
}

export interface YocoV2ApiResult<T = unknown> {
  data: T | null;
  found: boolean;
  classification: YocoV2ApiClassification;
  responseStatus: number;
  cacheStatus: YocoV2CacheStatus;
  retryAfterSeconds: number;
  circuit: YocoV2CircuitState;
  requestId: string;
}

export class YocoV2ApiClientError extends Error {
  status: number;
  category: string;
  code: string;
  retryable: boolean;
  retryAfterMs: number;
  details: Record<string, unknown>;

  constructor(input: {
    message: string;
    status: number;
    category: string;
    code: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = 'YocoV2ApiClientError';
    this.status = input.status;
    this.category = input.category;
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = Math.max(0, Number(input.retryAfterSeconds || 0) * 1000);
    this.details = input.details || {};
  }
}

function parseJson(value: string): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function objectData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  for (const key of ['data', 'result', 'payload']) {
    const candidate = row[key];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return value;
}

function errorContract(classification: YocoV2ApiClassification, responseStatus: number) {
  switch (classification) {
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return { category: 'AUTHENTICATION_ERROR', retryable: false, code: 'YOCO_V2_API_AUTHENTICATION' };
    case 'RATE_LIMITED':
      return { category: 'RATE_LIMITED', retryable: true, code: 'YOCO_V2_API_RATE_LIMITED' };
    case 'RETRYABLE_SERVER_ERROR':
      return { category: 'YOCO_TEMPORARY_ERROR', retryable: true, code: 'YOCO_V2_API_SERVER_ERROR' };
    case 'TIMEOUT':
      return { category: 'NETWORK_ERROR', retryable: true, code: 'YOCO_V2_API_TIMEOUT' };
    case 'NETWORK_ERROR':
      return { category: 'NETWORK_ERROR', retryable: true, code: 'YOCO_V2_API_NETWORK_ERROR' };
    case 'INVALID_RESPONSE':
      return { category: 'VALIDATION_ERROR', retryable: false, code: 'YOCO_V2_API_INVALID_RESPONSE' };
    case 'NON_RETRYABLE_CLIENT_ERROR':
      return { category: 'VALIDATION_ERROR', retryable: false, code: 'YOCO_V2_API_CLIENT_ERROR' };
    case 'NOT_FOUND':
      return { category: 'VALIDATION_ERROR', retryable: false, code: 'YOCO_V2_API_NOT_FOUND' };
    default:
      return { category: 'INTERNAL_ERROR', retryable: responseStatus >= 500, code: 'YOCO_V2_API_ERROR' };
  }
}

async function loadApiKey(env: YocoV2ApiClientEnv, workspaceId: string): Promise<string> {
  const connection = await env.DB.prepare(
    `SELECT api_key_encrypted, status, connection_active
       FROM yoco_connections WHERE workspace_id = ?1 LIMIT 1`
  ).bind(workspaceId).first<Row>();
  const encrypted = String(connection?.api_key_encrypted || '').trim();
  if (!encrypted) {
    throw new YocoV2ApiClientError({
      message: 'Yoco API credentials are not configured for this workspace.',
      status: 401,
      category: 'CONFIGURATION_ERROR',
      code: 'YOCO_V2_API_KEY_MISSING',
      retryable: false
    });
  }
  return decryptText(env, encrypted);
}

function buildUrl(env: YocoV2ApiClientEnv, input: YocoV2ApiRequestContext): URL {
  const url = new URL(input.path, env.YOCO_API_BASE_URL || DEFAULT_YOCO_BASE_URL);
  for (const [key, value] of Object.entries(input.params || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, String(entry)));
    else url.searchParams.set(key, String(value));
  }
  return url;
}

function stableRequestKey(input: YocoV2ApiRequestContext, url: URL): string {
  return [String(input.method || 'GET').toUpperCase(), input.endpointName, input.resourceId || '', url.pathname, url.search].join('|');
}

async function recordApiRequest(env: YocoV2ApiClientEnv, input: YocoV2ApiRequestContext, requestId: string, startedAt: string, gate: YocoV2RateGateResponse): Promise<void> {
  const completedAt = nowIso();
  const contract = gate.ok ? null : errorContract(gate.classification, gate.responseStatus);
  await env.DB.prepare(
    `INSERT INTO yoco_v2_api_requests
      (id, workspace_id, integration_id, raw_event_id, processing_run_id, trace_id,
       request_key, method, endpoint_name, resource_id, attempt, request_started_at,
       request_completed_at, duration_ms, response_status, rate_limited,
       retry_after_seconds, cache_status, error_category, error_code,
       redacted_metadata_json, created_at)
     VALUES (?1, ?2, ?3, NULLIF(?4, ''), NULLIF(?5, ''), ?6, ?7, ?8, ?9,
       NULLIF(?10, ''), ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?12)`
  ).bind(
    requestId,
    input.workspaceId,
    input.integrationId,
    input.rawEventId || '',
    input.processingRunId || '',
    input.traceId,
    stableRequestKey(input, buildUrl(env, input)),
    String(input.method || 'GET').toUpperCase(),
    input.endpointName,
    input.resourceId || '',
    Math.max(1, Number(input.attempt || 1)),
    startedAt,
    completedAt,
    gate.durationMs,
    gate.responseStatus,
    gate.classification === 'RATE_LIMITED' ? 1 : 0,
    gate.retryAfterSeconds,
    gate.cacheStatus,
    contract?.category || null,
    gate.errorCode || contract?.code || null,
    JSON.stringify({
      classification: gate.classification,
      circuit: gate.circuit,
      response_headers: gate.responseHeaders,
      credential_redacted: true
    })
  ).run();

  await env.DB.prepare(
    `INSERT INTO yoco_v2_integration_runtime
      (workspace_id, integration_id, paused_until, pause_reason, intervention_required,
       consecutive_auth_failures, consecutive_rate_limits, last_cache_status,
       last_response_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(workspace_id, integration_id) DO UPDATE SET
       paused_until = excluded.paused_until,
       pause_reason = excluded.pause_reason,
       intervention_required = excluded.intervention_required,
       consecutive_auth_failures = excluded.consecutive_auth_failures,
       consecutive_rate_limits = excluded.consecutive_rate_limits,
       last_cache_status = excluded.last_cache_status,
       last_response_status = excluded.last_response_status,
       updated_at = excluded.updated_at`
  ).bind(
    input.workspaceId,
    input.integrationId,
    gate.circuit.pausedUntil,
    gate.circuit.pauseReason,
    gate.circuit.interventionRequired ? 1 : 0,
    gate.circuit.consecutiveAuthFailures,
    gate.circuit.consecutiveRateLimits,
    gate.cacheStatus,
    gate.responseStatus,
    completedAt
  ).run();
}

export async function executeYocoV2ApiRequest<T = unknown>(env: YocoV2ApiClientEnv, input: YocoV2ApiRequestContext): Promise<YocoV2ApiResult<T>> {
  if (!env.YOCO_V2_RATE_GATE) {
    throw new YocoV2ApiClientError({
      message: 'YOCO_V2_RATE_GATE binding is not configured.',
      status: 0,
      category: 'CONFIGURATION_ERROR',
      code: 'YOCO_V2_RATE_GATE_MISSING',
      retryable: false
    });
  }
  const startedAt = nowIso();
  const requestId = newId('yoco_v2_api_request');
  const url = buildUrl(env, input);
  const apiKey = String(input.apiKeyOverride || '').trim() || await loadApiKey(env, input.workspaceId);
  const config = yocoV2ApiConfig(env);
  const gateInput: YocoV2RateGateRequest = {
    integrationId: input.integrationId,
    requestKey: stableRequestKey(input, url),
    traceId: input.traceId,
    method: String(input.method || 'GET').toUpperCase(),
    url: url.toString(),
    apiKey,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    timeoutMs: config.timeoutMs,
    cacheTtlMs: Math.max(0, Number(input.cacheTtlMs ?? 0)),
    forceRefresh: Boolean(input.forceRefresh),
    requestSpacingMs: config.requestSpacingMs,
    authFailureThreshold: config.authFailureThreshold,
    rateLimitPauseFallbackMs: config.rateLimitPauseFallbackMs
  };

  const stub = env.YOCO_V2_RATE_GATE.get(env.YOCO_V2_RATE_GATE.idFromName(input.integrationId));
  const response = await stub.fetch('https://rate-gate/fetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(gateInput)
  });
  const gate = await response.json<YocoV2RateGateResponse>().catch(() => null);
  if (!gate || typeof gate.classification !== 'string') {
    throw new YocoV2ApiClientError({
      message: `Yoco V2 rate gate returned an invalid response (HTTP ${response.status}).`,
      status: response.status,
      category: 'CONFIGURATION_ERROR',
      code: 'YOCO_V2_RATE_GATE_INVALID_RESPONSE',
      retryable: response.status >= 500
    });
  }

  await recordApiRequest(env, input, requestId, startedAt, gate);
  await recordYocoV2DiagnosticIfNotable(env.DB, {
    trace_id: input.traceId,
    raw_event_id: input.rawEventId,
    workspace_id: input.workspaceId,
    integration_id: input.integrationId,
    event_type: 'yoco.api.request',
    attempt: input.attempt,
    status: gate.classification,
    duration_ms: gate.durationMs,
    error_category: gate.ok ? undefined : errorContract(gate.classification, gate.responseStatus).category,
    operation: `yoco.v2.api.${input.endpointName}`,
    message: `Yoco V2 API ${input.endpointName} completed with ${gate.classification}; cache=${gate.cacheStatus}.`
  });

  if (gate.classification === 'NOT_FOUND') {
    return {
      data: null,
      found: false,
      classification: gate.classification,
      responseStatus: gate.responseStatus,
      cacheStatus: gate.cacheStatus,
      retryAfterSeconds: gate.retryAfterSeconds,
      circuit: gate.circuit,
      requestId
    };
  }

  if (!gate.ok) {
    const contract = errorContract(gate.classification, gate.responseStatus);
    const parsed = parseJson(gate.bodyText) as Record<string, unknown> | null;
    const providerMessage = String(parsed?.detail || parsed?.message || parsed?.title || '').trim();
    throw new YocoV2ApiClientError({
      message: gate.errorMessage || providerMessage || `Yoco API ${input.endpointName} failed with ${gate.classification}.`,
      status: gate.responseStatus,
      category: contract.category,
      code: gate.errorCode || contract.code,
      retryable: contract.retryable,
      retryAfterSeconds: gate.retryAfterSeconds,
      details: { classification: gate.classification, circuit: gate.circuit, request_id: requestId }
    });
  }

  const parsed = parseJson(gate.bodyText);
  if (gate.bodyText && parsed === null) {
    await env.DB.prepare(
      `UPDATE yoco_v2_api_requests
          SET error_category = 'VALIDATION_ERROR', error_code = 'YOCO_V2_API_INVALID_JSON',
              redacted_metadata_json = ?2
        WHERE id = ?1`
    ).bind(requestId, JSON.stringify({
      classification: 'INVALID_RESPONSE',
      upstream_classification: gate.classification,
      circuit: gate.circuit,
      response_headers: gate.responseHeaders,
      credential_redacted: true
    })).run();
    await recordYocoV2Diagnostic(env.DB, {
      trace_id: input.traceId,
      raw_event_id: input.rawEventId,
      workspace_id: input.workspaceId,
      integration_id: input.integrationId,
      event_type: 'yoco.api.request',
      attempt: input.attempt,
      status: 'INVALID_RESPONSE',
      duration_ms: gate.durationMs,
      error_category: 'VALIDATION_ERROR',
      operation: `yoco.v2.api.${input.endpointName}.invalid_response`,
      message: `Yoco API ${input.endpointName} returned malformed JSON.`
    });
    throw new YocoV2ApiClientError({
      message: `Yoco API ${input.endpointName} returned malformed JSON.`,
      status: gate.responseStatus,
      category: 'VALIDATION_ERROR',
      code: 'YOCO_V2_API_INVALID_JSON',
      retryable: false,
      details: { request_id: requestId }
    });
  }
  return {
    data: objectData(parsed) as T,
    found: true,
    classification: gate.classification,
    responseStatus: gate.responseStatus,
    cacheStatus: gate.cacheStatus,
    retryAfterSeconds: gate.retryAfterSeconds,
    circuit: gate.circuit,
    requestId
  };
}

export async function fetchYocoV2Order<T = Record<string, unknown>>(
  env: YocoV2ApiClientEnv,
  context: Omit<YocoV2ApiRequestContext, 'endpointName' | 'path' | 'method' | 'resourceId' | 'cacheTtlMs'> & { orderId: string; forceRefresh?: boolean }
): Promise<YocoV2ApiResult<T>> {
  const config = yocoV2ApiConfig(env);
  return executeYocoV2ApiRequest<T>(env, {
    ...context,
    method: 'GET',
    endpointName: 'order.detail',
    resourceId: context.orderId,
    path: `/v1/orders/${encodeURIComponent(context.orderId)}`,
    cacheTtlMs: config.orderCacheTtlMs,
    forceRefresh: context.forceRefresh
  });
}

export async function fetchYocoV2Refund<T = Record<string, unknown>>(
  env: YocoV2ApiClientEnv,
  context: Omit<YocoV2ApiRequestContext, 'endpointName' | 'path' | 'method' | 'resourceId' | 'cacheTtlMs'> & { refundId: string; forceRefresh?: boolean }
): Promise<YocoV2ApiResult<T>> {
  const config = yocoV2ApiConfig(env);
  return executeYocoV2ApiRequest<T>(env, {
    ...context,
    method: 'GET',
    endpointName: 'refund.detail',
    resourceId: context.refundId,
    path: `/v1/refunds/${encodeURIComponent(context.refundId)}`,
    cacheTtlMs: config.refundCacheTtlMs,
    forceRefresh: context.forceRefresh
  });
}

export async function fetchYocoV2Payment<T = Record<string, unknown>>(
  env: YocoV2ApiClientEnv,
  context: Omit<YocoV2ApiRequestContext, 'endpointName' | 'path' | 'method' | 'resourceId' | 'cacheTtlMs'> & { paymentId: string; forceRefresh?: boolean }
): Promise<YocoV2ApiResult<T>> {
  const config = yocoV2ApiConfig(env);
  return executeYocoV2ApiRequest<T>(env, {
    ...context,
    method: 'GET',
    endpointName: 'payment.detail',
    resourceId: context.paymentId,
    path: `/v1/payments/${encodeURIComponent(context.paymentId)}`,
    cacheTtlMs: config.metadataCacheTtlMs,
    forceRefresh: context.forceRefresh
  });
}

export async function listYocoV2Orders<T = unknown>(
  env: YocoV2ApiClientEnv,
  context: Omit<YocoV2ApiRequestContext, 'endpointName' | 'path' | 'method' | 'resourceId' | 'cacheTtlMs'> & { params?: Record<string, unknown>; forceRefresh?: boolean }
): Promise<YocoV2ApiResult<T>> {
  return executeYocoV2ApiRequest<T>(env, {
    ...context,
    method: 'GET',
    endpointName: 'order.list',
    resourceId: 'orders',
    path: '/v1/orders/',
    params: context.params,
    cacheTtlMs: 0,
    forceRefresh: context.forceRefresh ?? true
  });
}

export async function listYocoV2Refunds<T = unknown>(
  env: YocoV2ApiClientEnv,
  context: Omit<YocoV2ApiRequestContext, 'endpointName' | 'path' | 'method' | 'resourceId' | 'cacheTtlMs'> & { params?: Record<string, unknown>; forceRefresh?: boolean }
): Promise<YocoV2ApiResult<T>> {
  return executeYocoV2ApiRequest<T>(env, {
    ...context,
    method: 'GET',
    endpointName: 'refund.list',
    resourceId: 'refunds',
    path: '/v1/refunds/',
    params: context.params,
    cacheTtlMs: 0,
    forceRefresh: context.forceRefresh ?? true
  });
}
