import type { Env } from '../../legacy/types';
import { nowIso } from './config';

function structuredLog(level: 'log' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
  console[level](JSON.stringify({ provider: 'xero-v2', event, ...fields }));
}

export function logXero(event: string, fields: Record<string, unknown> = {}) {
  structuredLog('log', event, fields);
}

/**
 * Mirrors modules/yoco-engine-v2/observability.ts's cost-control rule: always console.log (free),
 * but only persist to the shared `integration_logs` D1 table on failure/retry — a routine daily
 * success push is a handful of calls, but writing one integration_logs row per call still isn't
 * free against the account's write budget, and nobody reads a "yes it worked" row.
 */
export async function recordXeroDiagnosticIfNotable(
  env: Env,
  workspaceId: string,
  input: { operation: string; status: 'success' | 'failed' | 'warning'; message: string; details?: Record<string, unknown> }
) {
  structuredLog(input.status === 'failed' ? 'error' : 'log', input.operation, { workspaceId, status: input.status, message: input.message });
  if (input.status === 'success') return;
  try {
    await env.DB.prepare(
      `INSERT INTO integration_logs
        (id, workspace_id, provider, operation, status, severity, message, details_json, created_at)
       VALUES (?1, ?2, 'xero-v2', ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(
        `integration_log_${crypto.randomUUID()}`,
        workspaceId,
        input.operation,
        input.status,
        input.status === 'failed' ? 'error' : 'warning',
        input.message,
        JSON.stringify(input.details || {}),
        nowIso()
      )
      .run();
  } catch (cause) {
    // Logging must never break the actual sync — swallow and console-log only.
    console.error('[xero-v2] failed to persist diagnostic log', cause);
  }
}
