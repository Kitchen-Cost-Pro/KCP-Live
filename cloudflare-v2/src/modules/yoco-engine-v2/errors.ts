import type { YocoV2ErrorCategory } from './contracts';

export interface ClassifiedYocoV2Error {
  category: YocoV2ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details: Record<string, unknown>;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function numeric(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function classifyYocoV2Error(value: unknown): ClassifiedYocoV2Error {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const message = value instanceof Error ? value.message : text(row.message || value) || 'Unknown V2 processing error.';
  const lower = message.toLowerCase();
  const status = numeric(row.status || row.statusCode);
  const retryAfterMs = numeric(row.retryAfterMs) ?? (numeric(row.retryAfterSeconds) !== undefined ? Number(row.retryAfterSeconds) * 1000 : undefined);
  const explicitCategory = text(row.category) as YocoV2ErrorCategory;
  const explicitCode = text(row.code);
  if (explicitCategory && explicitCode && typeof row.retryable === 'boolean') {
    return {
      category: explicitCategory,
      code: explicitCode,
      message,
      retryable: Boolean(row.retryable),
      retryAfterMs,
      details: row.details && typeof row.details === 'object' && !Array.isArray(row.details)
        ? row.details as Record<string, unknown>
        : { status }
    };
  }

  // Deterministic live-effect conditions that a retry can never resolve: a sold line/modifier
  // has no recipe/stock mapping, no resolved proposals, an unresolved location, or an
  // unsupported currency. These are data/setup gaps, not transient faults, so they must fail
  // once and surface for review instead of churning through 8 retryable "error" attempts.
  if (/blocked_by_proposal_warnings|has_no_resolved|_not_resolved|not_fully_resolved|currency_unsupported/.test(lower)) {
    return { category: 'VALIDATION_ERROR', code: 'YOCO_V2_EFFECT_NOT_APPLICABLE', message, retryable: false, details: {} };
  }
  if (status === 401 || status === 403 || /authentication|unauthori[sz]ed|forbidden|invalid api key/.test(lower)) {
    return { category: 'AUTHENTICATION_ERROR', code: 'YOCO_V2_AUTHENTICATION', message, retryable: false, details: { status } };
  }
  if (status === 429 || /rate limit|too many requests/.test(lower)) {
    return { category: 'RATE_LIMITED', code: 'YOCO_V2_RATE_LIMITED', message, retryable: true, retryAfterMs, details: { status } };
  }
  if ((status !== undefined && status >= 500) || /temporar|service unavailable|bad gateway|gateway timeout/.test(lower)) {
    return { category: 'YOCO_TEMPORARY_ERROR', code: 'YOCO_V2_PROVIDER_TEMPORARY', message, retryable: true, retryAfterMs, details: { status } };
  }
  if (/network|fetch failed|socket|connection reset|timed? out|dns/.test(lower)) {
    return { category: 'NETWORK_ERROR', code: 'YOCO_V2_NETWORK', message, retryable: true, details: {} };
  }
  if (/d1|sqlite|database|sql|constraint|storage/.test(lower)) {
    return { category: 'DATABASE_ERROR', code: 'YOCO_V2_DATABASE', message, retryable: true, details: {} };
  }
  if (/config|binding|not configured|missing environment/.test(lower)) {
    return { category: 'CONFIGURATION_ERROR', code: 'YOCO_V2_CONFIGURATION', message, retryable: false, details: {} };
  }
  if (/unsupported event/.test(lower)) {
    return { category: 'UNSUPPORTED_EVENT', code: 'YOCO_V2_UNSUPPORTED_EVENT', message, retryable: false, details: {} };
  }
  if (/duplicate/.test(lower)) {
    return { category: 'DUPLICATE_EVENT', code: 'YOCO_V2_DUPLICATE', message, retryable: false, details: {} };
  }
  if (/invalid|required|malformed|validation|not found/.test(lower)) {
    return { category: 'VALIDATION_ERROR', code: 'YOCO_V2_VALIDATION', message, retryable: false, details: {} };
  }
  return { category: 'INTERNAL_ERROR', code: 'YOCO_V2_INTERNAL', message, retryable: true, details: {} };
}

export function computeYocoV2RetryDelayMs(input: {
  attemptNumber: number;
  baseRetryMs: number;
  maxRetryMs: number;
  retryAfterMs?: number;
  random?: number;
}): number {
  const attempt = Math.max(1, Math.floor(input.attemptNumber));
  const exponential = Math.min(input.maxRetryMs, input.baseRetryMs * (2 ** Math.max(0, attempt - 1)));
  const random = Number.isFinite(input.random) ? Math.max(0, Math.min(1, Number(input.random))) : Math.random();
  const jittered = Math.round(exponential * (0.75 + random * 0.5));
  return Math.min(input.maxRetryMs, Math.max(jittered, Math.max(0, Number(input.retryAfterMs || 0))));
}
