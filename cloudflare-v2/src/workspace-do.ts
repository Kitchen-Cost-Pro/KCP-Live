import { DurableObject } from 'cloudflare:workers';
import { FacadeDatabase } from './d1-facade';
import { TENANT_MIGRATIONS } from './tenant-migrations';
import type { Env } from './types';
import { dispatchWorkspaceRoute } from './legacy/index';
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new FacadeDatabase(ctx.storage.sql, ctx.storage);
    // Apply pending migrations before serving any request.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate(ctx.storage.sql);
    });
  }

  private migrate(sql: SqlStorage): void {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS _kcp_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`
    );
    const row = sql.exec(`SELECT version FROM _kcp_schema WHERE id = 1`).toArray()[0] as
      | { version: number }
      | undefined;
    let applied = row ? Number(row.version) : 0;
    for (let i = applied; i < TENANT_MIGRATIONS.length; i += 1) {
      this.db.execScript(TENANT_MIGRATIONS[i]);
      applied = i + 1;
    }
    sql.exec(
      `INSERT INTO _kcp_schema (id, version) VALUES (1, ?1)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
      applied
    );
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
    const legacyEnv = {
      ...this.env,
      DB: this.db,
      CENTRAL_DB: this.env.CENTRAL_DB
    } as unknown as LegacyEnv;

    return dispatchWorkspaceRoute(request, legacyEnv, auth, workspaceId, resource);
  }
}
