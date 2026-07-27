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

    // Repair schema drift independently from the indexed migration counter. Several historical
    // releases reused migration positions while the Yoco V2 engine was being separated from the
    // old integration. A tenant could therefore report the latest version while still missing a
    // V2 table or yoco_connections column, causing /yoco/connect to fail with HTTP 500.
    //
    // Record the repair separately so the full idempotent script is paid only once per tenant,
    // rather than on every Durable Object cold start. A failed repair never writes its marker and
    // will be retried safely on the next request.
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
