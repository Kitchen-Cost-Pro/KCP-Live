import { DurableObject } from 'cloudflare:workers';
import { FacadeDatabase } from './d1-facade';
import { TENANT_MIGRATIONS } from './tenant-migrations';
import type { Env } from './types';
import { dispatchWorkspaceRoute } from './legacy/index';
import { retryFailedYocoOrders } from './legacy/yoco-service';
import type { Env as LegacyEnv, AuthContext as LegacyAuth } from './legacy/types';

/**
 * One WorkspaceDO instance per workspace (addressed by `idFromName(workspaceId)`), each owning its
 * own SQLite database. It self-migrates on construction, then runs the tenant route handlers with
 * `env.DB` = a D1-compatible facade over its own SQLite.
 *
 * The front Worker forwards an authenticated request here with two headers:
 *   x-kcp-workspace : the workspace id (this DO's tenant)
 *   x-kcp-auth      : JSON { uid, email } resolved centrally (never trusted from the client)
 */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly db: FacadeDatabase;
  private readonly state: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx;
    this.db = new FacadeDatabase(ctx.storage.sql, ctx.storage);
    // Apply pending migrations before serving any request.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate(ctx.storage);
    });
  }

  private migrate(storage: DurableObjectStorage): void {
    const sql = storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS _kcp_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`
    );
    const row = sql.exec(`SELECT version FROM _kcp_schema WHERE id = 1`).toArray()[0] as
      | { version: number }
      | undefined;
    let applied = row ? Number(row.version) : 0;
    for (let i = applied; i < TENANT_MIGRATIONS.length; i += 1) {
      storage.transactionSync(() => {
        this.db.execScript(TENANT_MIGRATIONS[i]);
        applied = i + 1;
        sql.exec(
          `INSERT INTO _kcp_schema (id, version) VALUES (1, ?1)
           ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
          applied
        );
      });
    }
  }

  private legacyEnv(): LegacyEnv {
    return {
      ...this.env,
      DB: this.db,
      CENTRAL_DB: this.env.CENTRAL_DB
    } as unknown as LegacyEnv;
  }

  private async pendingRefundWebhookCount(workspaceId: string) {
    if (!workspaceId) return 0;
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS pending
         FROM yoco_webhook_events
        WHERE workspace_id = ?1
          AND status IN ('attention', 'failed')
          AND lower(replace(event_type, '_', '.')) IN ('payment.refunded', 'order.updated', 'refund.succeeded', 'refund.successful')`
    ).bind(workspaceId).first<{ pending?: number }>();
    return Number(row?.pending || 0) || 0;
  }

  private async scheduleRefundRetry(workspaceId: string, delayMs = 15_000) {
    if (!workspaceId || !(await this.pendingRefundWebhookCount(workspaceId))) return;
    await this.state.storage.put('_kcp_workspace_id', workspaceId);
    const target = Date.now() + Math.max(5_000, delayMs);
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > target) await this.state.storage.setAlarm(target);
  }

  async fetch(request: Request): Promise<Response> {
    const workspaceId = request.headers.get('x-kcp-workspace') || '';
    const resource = request.headers.get('x-kcp-resource') || new URL(request.url).pathname;

    let fwd: { uid?: string; email?: string; name?: string } = {};
    try {
      fwd = JSON.parse(request.headers.get('x-kcp-auth') || '{}');
    } catch {
      /* auth stays empty */
    }
    const auth: LegacyAuth = {
      uid: String(fwd.uid || ''),
      email: String(fwd.email || ''),
      token: { sub: String(fwd.uid || ''), email: String(fwd.email || ''), name: String(fwd.name || '') }
    };

    // The ported handlers see `env.DB` = this workspace's SQLite facade and `env.CENTRAL_DB` = the
    // shared central D1 (for the few central reads: assertWorkspaceAccess, allowed-locations, etc.).
    const response = await dispatchWorkspaceRoute(request, this.legacyEnv(), auth, workspaceId, resource);
    if (resource === 'yoco-webhook') await this.scheduleRefundRetry(workspaceId);
    return response;
  }

  async alarm(): Promise<void> {
    const workspaceId = String(await this.state.storage.get<string>('_kcp_workspace_id') || '');
    if (!workspaceId) return;
    const previousAttempt = Number(await this.state.storage.get<number>('_kcp_refund_retry_attempt') || 0);
    try {
      await retryFailedYocoOrders(this.legacyEnv(), workspaceId, { automatic: true, maxAutomaticLookbackDays: 31 });
    } catch {
      // Pending state is retained and the bounded backoff below schedules another try.
    }
    const pending = await this.pendingRefundWebhookCount(workspaceId);
    if (!pending) {
      await this.state.storage.delete('_kcp_refund_retry_attempt');
      return;
    }
    const nextAttempt = Math.min(previousAttempt + 1, 6);
    await this.state.storage.put('_kcp_refund_retry_attempt', nextAttempt);
    const delayMs = Math.min(15_000 * (2 ** nextAttempt), 5 * 60_000);
    await this.state.storage.setAlarm(Date.now() + delayMs);
  }
}
