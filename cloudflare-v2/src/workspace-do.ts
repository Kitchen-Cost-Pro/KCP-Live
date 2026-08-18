import { DurableObject } from 'cloudflare:workers';
import { FacadeDatabase } from './d1-facade';
import { TENANT_MIGRATIONS } from './tenant-migrations';
import type { Env } from './types';
import { dispatchWorkspaceRoute } from './legacy/index';
import { dispatchYocoV2WorkspaceRoute } from './modules/yoco-engine-v2/route-dispatch';
import {
  YOCO_V2_RUNTIME_SCHEMA_REPAIR,
  YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID,
} from './modules/yoco-engine-v2/schema-repair';
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
    // Apply pending migrations before serving any request. Migration failures must NEVER be
    // allowed to reach blockConcurrencyWhile as a thrown exception — that crashes the entire
    // Durable Object, so every route (not just whatever needed the new schema) fails on every
    // single subsequent request, forever, with no backoff. That turned one migration hitting an
    // account-wide storage quota into a full outage that kept regenerating itself: every retry
    // (from cron ticks, background polling, page loads) attempted the same failing write again
    // immediately, burning through the write quota further and guaranteeing the next attempt
    // would fail too. `migrate()` now handles and records its own failures internally and never
    // throws — a workspace whose migration is pending simply keeps serving on its current schema
    // until the migration can succeed.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate(ctx.storage);
    });
  }

  private migrate(storage: DurableObjectStorage): void {
    const sql = storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS _kcp_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`
    );
    // Tracks migration failures so a broken migration backs off instead of being retried on every
    // single incoming request. Without this, a persistent failure (e.g. an account-wide storage
    // quota being exhausted) turns into a self-sustaining retry storm: every cron tick, every
    // background poll, every page load re-attempts the identical failing write immediately,
    // which is exactly what is at the write budget rather than idling until it can succeed.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS _kcp_migration_health (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         consecutive_failures INTEGER NOT NULL DEFAULT 0,
         next_retry_at TEXT
       )`
    );
    const health = sql.exec(
      `SELECT consecutive_failures, next_retry_at FROM _kcp_migration_health WHERE id = 1`
    ).toArray()[0] as { consecutive_failures: number; next_retry_at: string | null } | undefined;
    const nextRetryAtMs = health?.next_retry_at ? Date.parse(health.next_retry_at) : 0;
    if (nextRetryAtMs && Date.now() < nextRetryAtMs) {
      // Still inside the backoff window from a prior failure — skip this attempt entirely and
      // serve the request on the existing schema rather than re-failing the same write again.
      return;
    }

    try {
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

      // Repair schema drift independently from the indexed migration counter. Several historical
      // releases reused migration positions while the Yoco V2 engine was being separated from the
      // old integration. A tenant could therefore report the latest version while still missing a
      // V2 table or yoco_connections column, causing /yoco/connect to fail with HTTP 500.
      //
      // Record the repair separately so the full idempotent script is paid only once per tenant,
      // rather than on every Durable Object cold start.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS _kcp_runtime_repairs (
           repair_id TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL
         )`
      );
      const repairApplied = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID,
      ).toArray()[0];
      if (!repairApplied) {
        storage.transactionSync(() => {
          this.db.execScript(YOCO_V2_RUNTIME_SCHEMA_REPAIR);
          sql.exec(
            `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at)
             VALUES (?1, datetime('now'))`,
            YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID,
          );
        });
      }

      // Success — clear any prior backoff state so a future genuine failure starts counting fresh.
      if (health && (health.consecutive_failures || health.next_retry_at)) {
        sql.exec(
          `UPDATE _kcp_migration_health SET consecutive_failures = 0, next_retry_at = NULL WHERE id = 1`
        );
      }
    } catch (cause) {
      console.error('[WorkspaceDO] migration attempt failed; will back off and keep serving on the existing schema', cause);
      const failures = Number(health?.consecutive_failures || 0) + 1;
      const message = String((cause as Error)?.message || cause || '');
      // A quota/resource-exhaustion error means "wait for the quota to reset," not "try again in a
      // few seconds" — treating it like an ordinary transient error is exactly what turned one
      // failing migration into a runaway retry storm. Back off much longer for these specifically.
      const isResourceExhaustion = /exceeded allowed|quota|free tier|rate limit/i.test(message);
      const backoffMs = isResourceExhaustion
        ? Math.min(60 * 60 * 1000, 5 * 60 * 1000 * failures) // 5, 10, 15... min, capped at 1 hour
        : Math.min(5 * 60 * 1000, 15 * 1000 * failures); // 15, 30, 45... sec, capped at 5 min
      try {
        sql.exec(
          `INSERT INTO _kcp_migration_health (id, consecutive_failures, next_retry_at) VALUES (1, ?1, ?2)
           ON CONFLICT(id) DO UPDATE SET consecutive_failures = excluded.consecutive_failures, next_retry_at = excluded.next_retry_at`,
          failures,
          new Date(Date.now() + backoffMs).toISOString(),
        );
      } catch {
        // Even the bookkeeping write failed (storage is completely out of quota right now) — there
        // is nothing further we can safely persist. The next request will simply attempt the
        // migration again and hit this same catch block, which is the best available fallback
        // when writes are fully exhausted; it will start succeeding again as soon as any write
        // capacity returns.
      }
      // Deliberately do not re-throw: a pending/failed migration must never prevent the workspace
      // from serving requests that don't depend on the new schema.
    }
  }

  private legacyEnv(): LegacyEnv {
    return {
      ...this.env,
      DB: this.db,
      CENTRAL_DB: this.env.CENTRAL_DB,
      YOCO_V2_WAIT_UNTIL: (promise: Promise<unknown>) => this.state.waitUntil(promise)
    } as unknown as LegacyEnv;
  }

  async fetch(request: Request): Promise<Response> {
    const workspaceId = request.headers.get('x-kcp-workspace') || '';
    const resource = request.headers.get('x-kcp-resource') || new URL(request.url).pathname;

    let fwd: { uid?: string; email?: string; name?: string; systemRole?: 'admin' | 'queue'; adminRole?: string; permissions?: string[] } = {};
    try {
      fwd = JSON.parse(request.headers.get('x-kcp-auth') || '{}');
    } catch {
      /* auth stays empty */
    }
    const auth: LegacyAuth = {
      uid: String(fwd.uid || ''),
      email: String(fwd.email || ''),
      token: { sub: String(fwd.uid || ''), email: String(fwd.email || ''), name: String(fwd.name || '') },
      systemRole: fwd.systemRole,
      adminRole: fwd.adminRole,
      permissions: Array.isArray(fwd.permissions) ? fwd.permissions : []
    };

    // V2 routes are isolated from the legacy dispatcher. They use the same tenant database but
    // cannot reach legacy sale/refund stock or reporting writers.
    const tenantEnv = this.legacyEnv();
    const v2Response = await dispatchYocoV2WorkspaceRoute(request, tenantEnv, auth, workspaceId, resource);
    if (v2Response) return v2Response;

    // Non-Yoco workspace routes still use the shared tenant dispatcher. Yoco webhook, queue,
    // reconciliation, sale, and refund effects are handled exclusively by the V2 dispatcher above.
    return dispatchWorkspaceRoute(request, tenantEnv, auth, workspaceId, resource);
  }
}
