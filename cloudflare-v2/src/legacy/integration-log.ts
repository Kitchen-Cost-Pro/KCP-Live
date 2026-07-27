import type { Env } from './types';

type IntegrationLogInput = {
  provider?: string;
  operation: string;
  status: 'started' | 'success' | 'warning' | 'failed' | 'info';
  severity?: 'info' | 'warning' | 'error';
  message: string;
  details?: Record<string, unknown> | null;
  correlationId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number | null;
};

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function cleanDetails(value: Record<string, unknown> | null | undefined) {
  const visit = (input: unknown, key = ''): unknown => {
    if (/secret|api.?key|authorization|token/i.test(key)) return '[redacted]';
    if (Array.isArray(input)) return input.map((entry) => visit(entry));
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          visit(childValue, childKey),
        ]),
      );
    }
    return input;
  };
  return visit(value || {}) as Record<string, unknown>;
}

export async function recordIntegrationLog(
  env: Env,
  workspaceId: string,
  input: IntegrationLogInput,
) {
  const createdAt = nowIso();
  const severity = input.severity || (input.status === 'failed' ? 'error' : input.status === 'warning' ? 'warning' : 'info');
  try {
    await env.DB.prepare(
      `INSERT INTO integration_logs
        (id, workspace_id, provider, operation, status, severity, message, details_json,
         correlation_id, started_at, completed_at, duration_ms, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    ).bind(
      id('integration_log'),
      workspaceId,
      text(input.provider, 'yoco'),
      text(input.operation, 'unknown'),
      input.status,
      severity,
      text(input.message, 'Integration event'),
      JSON.stringify(cleanDetails(input.details)),
      text(input.correlationId) || null,
      text(input.startedAt) || null,
      text(input.completedAt) || null,
      Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
      createdAt,
    ).run();
  } catch (caught) {
    // Diagnostics must never break the integration operation they are describing.
    console.warn('[integration-log] write failed', caught);
  }
}

export async function runLoggedIntegrationOperation<T>(
  env: Env,
  workspaceId: string,
  operation: string,
  message: string,
  task: (correlationId: string) => Promise<T>,
  details: Record<string, unknown> = {},
): Promise<T> {
  const correlationId = id('integration_op');
  const startedAt = nowIso();
  const startedMs = Date.now();
  await recordIntegrationLog(env, workspaceId, {
    operation,
    status: 'started',
    message,
    details,
    correlationId,
    startedAt,
  });
  try {
    const result = await task(correlationId);
    await recordIntegrationLog(env, workspaceId, {
      operation,
      status: 'success',
      message: `${message} completed.`,
      details: { ...details, result: result && typeof result === 'object' ? result as Record<string, unknown> : result },
      correlationId,
      startedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    return result;
  } catch (caught) {
    const errorMessage = caught instanceof Error ? caught.message : String(caught || 'Unknown integration error');
    await recordIntegrationLog(env, workspaceId, {
      operation,
      status: 'failed',
      severity: 'error',
      message: errorMessage,
      details,
      correlationId,
      startedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    throw caught;
  }
}
