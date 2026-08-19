import type { DbLike } from '../../legacy/types';

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export interface YocoV2LogEntry {
  trace_id: string;
  raw_event_id?: string;
  workspace_id: string;
  integration_id?: string;
  event_type?: string;
  attempt?: number;
  status: string;
  duration_ms?: number;
  error_category?: string;
  operation: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export function structuredYocoV2Log(entry: YocoV2LogEntry): void {
  console.log(JSON.stringify({ component: 'kcp-yoco-engine-v2', timestamp: nowIso(), ...entry }));
}

/**
 * Persist a diagnostic only when it carries signal, but ALWAYS emit the structured console line.
 *
 * `integration_logs` lives in the workspace's Durable Object SQLite, so every routine
 * success row consumes the tenant's daily row-write allowance. The high-volume caller is the Yoco
 * API client, which logged one row per outbound request — up to ~50 per reconciliation page sweep,
 * none of which anyone reads when the call simply succeeded. Failures, retries and rate-limiting
 * still persist, because those are what operators actually go looking for after the fact.
 *
 * The console line is free (it goes to Workers logs, not tenant storage), so observability of
 * successful calls is preserved in `wrangler tail` and the dashboard regardless.
 */
export async function recordYocoV2DiagnosticIfNotable(db: DbLike, entry: YocoV2LogEntry): Promise<void> {
  const routineSuccess = !entry.error_category
    && ['OK', 'SUCCESS', 'CACHED', 'NOT_MODIFIED'].includes(String(entry.status || '').toUpperCase());
  if (routineSuccess) {
    structuredYocoV2Log(entry);
    return;
  }
  await recordYocoV2Diagnostic(db, entry);
}

export async function recordYocoV2Diagnostic(db: DbLike, entry: YocoV2LogEntry): Promise<void> {
  structuredYocoV2Log(entry);
  try {
    await db.prepare(
      `INSERT INTO integration_logs
        (id, workspace_id, provider, operation, status, severity, message, details_json, correlation_id, started_at, completed_at, duration_ms, created_at)
       VALUES (?1, ?2, 'yoco-v2', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?9)`
    ).bind(
      id('integration_log'),
      entry.workspace_id,
      entry.operation,
      entry.status,
      entry.error_category ? 'error' : entry.status === 'warning' ? 'warning' : 'info',
      entry.message,
      JSON.stringify({
        trace_id: entry.trace_id,
        raw_event_id: entry.raw_event_id || null,
        integration_id: entry.integration_id || null,
        event_type: entry.event_type || null,
        attempt: entry.attempt || 0,
        error_category: entry.error_category || null,
        ...(entry.metadata || {})
      }),
      entry.trace_id,
      nowIso(),
      Math.max(0, Number(entry.duration_ms || 0))
    ).run();
  } catch (cause) {
    console.error(JSON.stringify({
      component: 'kcp-yoco-engine-v2',
      operation: 'diagnostic.persist.failed',
      trace_id: entry.trace_id,
      workspace_id: entry.workspace_id,
      error: cause instanceof Error ? cause.message : String(cause)
    }));
  }
}
