import { DurableObject } from 'cloudflare:workers';
import { FacadeDatabase, isRetryableAddColumnError } from './d1-facade';
import { TENANT_MIGRATIONS } from './tenant-migrations';
import {
  computeMigrationBackoffMs,
  evaluateMigrationHealth,
  hasExhaustedMigrationAttempts,
  isResourceExhaustionReason,
  shouldClearMigrationHealth,
  type MigrationHealthState,
} from './modules/migration-backoff';
import type { Env } from './types';
import { dispatchWorkspaceRoute } from './legacy/index';
import { dispatchYocoV2WorkspaceRoute } from './modules/yoco-engine-v2/route-dispatch';
import { dispatchXeroWorkspaceRoute } from './modules/xero-engine/route-dispatch';
import { dispatchDriveWorkspaceRoute } from './modules/drive-engine/route-dispatch';
import { getEffectRuntime } from './modules/yoco-engine-v2/effect-gate';
import {
  ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR,
  ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR_ID,
  HOT_PATH_INDEX_SCHEMA_REPAIR,
  HOT_PATH_INDEX_SCHEMA_REPAIR_ID,
  RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR,
  RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR_ID,
  YOCO_V2_RECONCILIATION_FINDINGS_COLUMNS_SCHEMA_REPAIR,
  YOCO_V2_RECONCILIATION_FINDINGS_COLUMNS_SCHEMA_REPAIR_ID,
  YOCO_V2_RUNTIME_SCHEMA_REPAIR,
  YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID,
  YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR,
  YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR_ID,
} from './modules/yoco-engine-v2/schema-repair';
import {
  XERO_V2_SETTINGS_SCHEMA_REPAIR,
  XERO_V2_SETTINGS_SCHEMA_REPAIR_ID,
} from './modules/xero-engine/schema-repair';
import type { Env as LegacyEnv, AuthContext as LegacyAuth } from './legacy/types';

// Backfill for stock_items.name_key (see migration 38's own comment in tenant-migrations.ts for
// the 2026-08-28 incident this replaced: one unconditional UPDATE across the whole table, run
// unconditionally in the migration itself, could exceed a Durable Object's per-request CPU limit
// on any tenant with a non-trivial stock_items table and retry-loop for hours. Bounded batches
// below cap the work any single request can do; a tenant with more pending rows than one
// request's budget simply keeps making progress on its next request instead of failing.
const STOCK_ITEM_NAME_KEY_BACKFILL_ID = 'stock_items_name_key_backfill_v1';
const STOCK_ITEM_NAME_KEY_BACKFILL_BATCH_ROWS = 2000;
const STOCK_ITEM_NAME_KEY_BACKFILL_MAX_BATCHES_PER_REQUEST = 3;
const STOCK_ITEM_NAME_KEY_BACKFILL_SQL = `
  UPDATE stock_items
     SET name_key = trim(lower(replace(replace(replace(replace(
           replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(name,
             char(9), ' '), char(10), ' '), char(13), ' '),
             char(160), ' '), char(8194), ' '), char(8195), ' '), char(8201), ' '), char(8239), ' '),
             char(8203), ''), char(65279), ''),
             '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')))
   WHERE rowid IN (SELECT rowid FROM stock_items WHERE name_key IS NULL LIMIT ?1)
`;

// Backfill for stock_item_latest_purchase (see migration 41's comment in tenant-migrations.ts).
// Unlike the name_key backfill, there's no natural "still needs it" column to filter on — every
// grv_lines row must be visited once to correctly converge on the true latest purchase per
// (stock_item, location). So progress is tracked with an explicit cursor (the last grv_lines.id
// processed) in a small dedicated table, paged through in id order. Because the upsert only
// replaces a stored row when the newly-seen purchase is actually more recent (see its WHERE
// clause), processing order doesn't need to be chronological for correctness — visiting every
// row exactly once, in ANY stable order, converges to the right answer. Smaller batch size than
// the name_key backfill (500 vs 2000) because each row here costs a join to grvs, not a single-
// table update.
const STOCK_ITEM_LATEST_PURCHASE_BACKFILL_ID = 'stock_item_latest_purchase_backfill_v1';
const STOCK_ITEM_LATEST_PURCHASE_BACKFILL_BATCH_ROWS = 500;
const STOCK_ITEM_LATEST_PURCHASE_BACKFILL_MAX_BATCHES_PER_REQUEST = 3;
const STOCK_ITEM_LATEST_PURCHASE_BACKFILL_UPSERT_SQL = `
  INSERT INTO stock_item_latest_purchase
    (workspace_id, stock_item_id, location_id, supplier_id, unit, unit_price, received_at, grv_line_id, updated_at)
  SELECT gl.workspace_id, gl.stock_item_id, gl.location_id, g.supplier_id, gl.unit, gl.unit_price, g.received_at,
         gl.id, datetime('now')
    FROM grv_lines gl
    JOIN grvs g ON g.id = gl.grv_id AND g.workspace_id = gl.workspace_id
   WHERE gl.id > ?1 AND gl.id <= ?2
  ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
    supplier_id = excluded.supplier_id,
    unit = excluded.unit,
    unit_price = excluded.unit_price,
    received_at = excluded.received_at,
    grv_line_id = excluded.grv_line_id,
    updated_at = excluded.updated_at
  WHERE excluded.received_at > stock_item_latest_purchase.received_at
     OR (excluded.received_at = stock_item_latest_purchase.received_at
         AND excluded.grv_line_id > stock_item_latest_purchase.grv_line_id)
`;

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

  /**
   * In-memory migration circuit breaker. These live on the Durable Object INSTANCE, which stays
   * resident across requests, so they work without touching storage at all.
   *
   * This exists because the persisted breaker (_kcp_migration_health) has a fatal dependency: it
   * can only stop a retry loop by WRITING the backoff row. When an account is out of storage quota
   * that write fails too — and recordFailure() deliberately swallows that failure — so nothing is
   * recorded, the next request sees a clean health row, and it attempts the whole migration again.
   * Every request then re-runs a migration that reads a large part of the tenant's data before
   * dying. That is a self-sustaining read amplifier: the busier the workspace, the faster it burns
   * the very quota it is failing on, and it cannot recover on its own.
   *
   * Live incident 2026-08-27: ~15,000,000 rows read in under 40 minutes on ONE workspace, while a
   * second account running the identical code stayed under 100,000 — the difference was not the
   * code but that this tenant had a migration failing. Routine traffic cannot produce that rate;
   * only a retry loop can.
   *
   * `migrationSettledInMemory` additionally means a fully-migrated tenant runs NO migration SQL at
   * all on subsequent requests in the same isolate, instead of the ~10 statements it used to pay on
   * every single request.
   */
  private migrationSettledInMemory = false;
  private migrationSuspendedUntilMs = 0;

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
      this.ensureMigrated();
    });
  }

  // Durable Object instances that are actively receiving requests do NOT pick up a new code
  // deploy's constructor when it ships — Cloudflare only re-runs the constructor (and therefore
  // migrate()) the next time this specific object is freshly instantiated, which for a workspace
  // under continuous traffic (status polling, cron fan-out) may not happen for a long time. A
  // migration added in a deploy can therefore sit unapplied against an already-warm workspace
  // indefinitely, even though every *new* instantiation already has it. Calling this cheap,
  // idempotent check at the top of every fetch() (in addition to the constructor) closes that gap:
  // an already-warm object picks up newly deployed migrations on its very next request instead of
  // waiting for an unpredictable restart.
  private ensureMigrated(): void {
    // migrate() already catches everything it does internally and never throws, but this is a
    // second, unconditional safety net: nothing thrown from in here may ever reach the caller,
    // because that's the one failure mode that takes the whole workspace down (every route, every
    // request) rather than degrading just the thing that needed it.
    try {
      this.migrate(this.state.storage);
    } catch (cause) {
      console.error('[WorkspaceDO] migrate() threw despite its own internal handling — swallowing to keep the DO serving', cause);
    }
  }

  private migrate(storage: DurableObjectStorage): void {
    // Emergency kill switch (see WORKSPACE_MIGRATIONS_DISABLED's own comment in types.ts) — checked
    // before any SQL runs, including the bootstrap CREATE TABLE calls, so a flagged deploy costs
    // zero additional storage reads/writes no matter how large a tenant's pending backlog is.
    if (String(this.env.WORKSPACE_MIGRATIONS_DISABLED || '').toLowerCase() === 'true') return;
    // In-memory breaker, checked BEFORE any SQL. See the field declarations for why this cannot be
    // left to the persisted _kcp_migration_health row alone: that row can only apply the brakes by
    // being written, and the exact situation it needs to stop is the one where writes fail.
    if (this.migrationSettledInMemory) return;
    if (Date.now() < this.migrationSuspendedUntilMs) return;
    // Everything in here — including the two bootstrap CREATE TABLE IF NOT EXISTS calls and the
    // health-check SELECT that used to sit outside this boundary — is now inside one outer
    // try/catch. On the Durable Objects free tier, a write-quota rejection can be thrown by ANY
    // exec() call, including an idempotent CREATE TABLE IF NOT EXISTS that wouldn't actually
    // change anything — Cloudflare's quota check runs before it knows that. Previously those two
    // calls and the health SELECT were unprotected, so a quota-exhausted workspace couldn't even
    // finish constructing its Durable Object: every request to it failed outright, not just
    // writes. Nothing here may ever propagate out of this function.
    let health: MigrationHealthState | undefined;
    const sql = storage.sql;
    const recordFailure = (reason: string, forceLongBackoff: boolean): void => {
      console.error('[WorkspaceDO] migration attempt failed; will back off and keep serving on the existing schema', reason);
      const failures = Number(health?.consecutive_failures || 0) + 1;
      // Apply the brake IN MEMORY first, before attempting to persist anything. The persisted write
      // below is best-effort and is exactly what fails when storage quota is exhausted; if the brake
      // depended on it, every subsequent request would re-attempt this same migration and re-read
      // whatever it reads before dying. Setting it here means the loop stops even when nothing at
      // all can be written.
      this.migrationSuspendedUntilMs = Date.now() + computeMigrationBackoffMs(
        failures,
        forceLongBackoff || isResourceExhaustionReason(reason),
      );
      // A quota/resource-exhaustion error means "wait for the quota to reset," not "try again in a
      // few seconds" — treating it like an ordinary transient error is exactly what turned one
      // failing migration into a runaway retry storm. Back off much longer for these specifically.
      // A CPU-limit kill (forceLongBackoff, detected via the in-progress marker below rather than a
      // catchable error — see its own comment for why) gets the same long treatment: an attempt
      // that got killed mid-flight is by definition too expensive to just retry immediately.
      const isResourceExhaustion = forceLongBackoff || isResourceExhaustionReason(reason);
      const backoffMs = computeMigrationBackoffMs(failures, isResourceExhaustion);
      try {
        sql.exec(
          `INSERT INTO _kcp_migration_health (id, consecutive_failures, next_retry_at, in_progress_since) VALUES (1, ?1, ?2, NULL)
           ON CONFLICT(id) DO UPDATE SET consecutive_failures = excluded.consecutive_failures, next_retry_at = excluded.next_retry_at, in_progress_since = NULL`,
          failures,
          new Date(Date.now() + backoffMs).toISOString(),
        );
      } catch {
        // Even the bookkeeping write failed (storage is completely out of quota right now) — there
        // is nothing further we can safely persist. The next request will simply attempt the
        // migration again and hit this same failure path, which is the best available fallback
        // when writes are fully exhausted; it will start succeeding again as soon as any write
        // capacity returns.
      }
    };
    try {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS _kcp_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`
      );
      // Tracks migration failures so a broken migration backs off instead of being retried on
      // every single cold start. Without this, a persistent failure (e.g. an account-wide storage
      // quota being exhausted) turns into a self-sustaining retry storm: every cron tick, every
      // background poll, every page load re-attempts the identical failing write immediately,
      // which is exactly what is at the write budget rather than idling until it can succeed.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS _kcp_migration_health (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           consecutive_failures INTEGER NOT NULL DEFAULT 0,
           next_retry_at TEXT,
           in_progress_since TEXT
         )`
      );
      // in_progress_since didn't exist before 2026-08-26 — add it for tenants whose
      // _kcp_migration_health table predates this fix. Checked via table_info rather than "just run
      // the ALTER and swallow the duplicate-column error", because migrate() runs on EVERY request:
      // the swallow-it form threw an exception on every request for the entire life of every
      // already-migrated tenant, which is pure waste on the hot path.
      const healthColumns = new Set(
        (sql.exec(`PRAGMA table_info(_kcp_migration_health)`).toArray() as Array<{ name?: unknown }>)
          .map((column) => String(column?.name ?? '')),
      );
      if (!healthColumns.has('in_progress_since')) {
        try {
          sql.exec(`ALTER TABLE _kcp_migration_health ADD COLUMN in_progress_since TEXT`);
        } catch (cause) {
          if (!isRetryableAddColumnError('ALTER TABLE _kcp_migration_health ADD COLUMN in_progress_since TEXT', cause)) throw cause;
        }
      }
      // Guarantee the id=1 row exists before markInProgress() (below) ever runs — it only UPDATEs,
      // so on a brand-new tenant with no row yet it would silently no-op and the crash-loop guard
      // this whole mechanism exists for would never actually engage on that tenant's first attempt.
      sql.exec(`INSERT OR IGNORE INTO _kcp_migration_health (id, consecutive_failures, next_retry_at, in_progress_since) VALUES (1, 0, NULL, NULL)`);
      health = sql.exec(
        `SELECT consecutive_failures, next_retry_at, in_progress_since FROM _kcp_migration_health WHERE id = 1`
      ).toArray()[0] as unknown as MigrationHealthState | undefined;

      // See evaluateMigrationHealth's own doc comment for the full reasoning — in short:
      // in_progress_since is written right before each expensive block below starts and cleared
      // right after it finishes, so finding it still set on a LATER invocation is proof the
      // previous attempt was killed mid-flight (a Durable Object CPU-limit kill isn't a catchable
      // JS exception, so the catch block never ran to record a normal failure). That's exactly the
      // 2026-08-26 crash-loop shape; treating it as a failure here makes it structurally impossible
      // to repeat, since at most one attempt can ever run before backoff kicks in.
      // Hard stop before anything else is considered. Backoff only slows a doomed migration down;
      // this ends it. Deliberately checked against the PERSISTED failure count, because the failure
      // mode that caused the 2026-08-27 outage — a CPU-limit kill — destroys the isolate and every
      // in-memory guard with it, so only something on disk can survive to stop the next isolate.
      if (hasExhaustedMigrationAttempts(health)) {
        this.migrationSettledInMemory = true; // stop re-reading this row on every request too
        console.error(
          `[WorkspaceDO] migration halted after ${health?.consecutive_failures} consecutive failures — ` +
            'automatic retrying is DISABLED for this workspace. It keeps serving on its existing ' +
            'schema. Investigate via GET /api/admin/workspaces/<id>/migration-health, then resume ' +
            'deliberately via POST /api/admin/workspaces/<id>/migration-retry.',
        );
        return;
      }

      const decision = evaluateMigrationHealth(health, Date.now());
      if (decision.action === 'skip_backoff_active') {
        // Still inside the backoff window from a prior failure — skip this attempt entirely and
        // serve the request on the existing schema rather than re-failing the same write again.
        return;
      }
      if (decision.action === 'skip_interrupted_attempt') {
        recordFailure(
          `Previous migration attempt (started ${decision.startedAt}) was interrupted and never completed — likely a Durable Object CPU/resource limit kill.`,
          true,
        );
        return;
      }
      let markedInProgress = false;
      const markInProgress = () => {
        markedInProgress = true;
        return sql.exec(
          `UPDATE _kcp_migration_health SET in_progress_since = ?1 WHERE id = 1`,
          new Date().toISOString(),
        );
      };

      const row = sql.exec(`SELECT version FROM _kcp_schema WHERE id = 1`).toArray()[0] as
        | { version: number }
        | undefined;
      let applied = row ? Number(row.version) : 0;
      // Apply AT MOST ONE pending migration per invocation — never the whole backlog in one shot.
      // A dormant tenant whose DO hasn't been reinstantiated in a while can accumulate a long run
      // of pending migrations; applying all of them in a single request/transaction means the cost
      // (rows read, CPU time) of an entire backlog lands on whichever request happens to wake that
      // DO. Capping to one per invocation bounds the worst case to a single migration's cost — the
      // remaining backlog is picked up on the tenant's next request instead, each one protected by
      // the same backoff/failure tracking as any other attempt. Production incident, 2026-08-27: a
      // tenant catching up on 20+ pending migrations at once, several scanning a large accumulated
      // yoco_orders/yoco_order_lines history, read millions of rows in one call and exhausted the
      // account's entire daily Durable Objects free-tier row-read quota within hours.
      if (applied < TENANT_MIGRATIONS.length) {
        markInProgress();
        const i = applied;
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
        markInProgress();
        storage.transactionSync(() => {
          this.db.execScript(YOCO_V2_RUNTIME_SCHEMA_REPAIR);
          sql.exec(
            `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at)
             VALUES (?1, datetime('now'))`,
            YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID,
          );
        });
      }

      // Kept as a SEPARATE, small, independently-tracked repair from the block above rather than
      // appended to it — applying it must not require re-running that entire historical blob
      // (foundation through effect-gate) again. That combination previously exceeded a Durable
      // Object's CPU time limit in production for a tenant with several days of accumulated data,
      // putting it into a repeating crash loop. See YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR's own
      // comment for the incident this fixes.
      const vatSnapshotRepairApplied = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR_ID,
      ).toArray()[0];
      if (!vatSnapshotRepairApplied) {
        markInProgress();
        storage.transactionSync(() => {
          this.db.execScript(YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR);
          sql.exec(
            `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at)
             VALUES (?1, datetime('now'))`,
            YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR_ID,
          );
        });
      }

      // Hot-path indexes + stock_items.name_key. Applied as a repair, NOT left to migrations 37-39,
      // because a tenant whose _kcp_schema.version drifted ahead of TENANT_MIGRATIONS.length skips
      // the indexed loop entirely and can never receive a newly appended migration — the live
      // WS-lellos-trattoria-bee300 workspace is on version 44 against 40 migrations. Without this,
      // saveStockItem's `WHERE name_key = ?` would fail with "no such column" on every save there.
      // Must run BEFORE the name_key backfill below, which no-ops while the column is absent.
      const hotPathRepairApplied = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        HOT_PATH_INDEX_SCHEMA_REPAIR_ID,
      ).toArray()[0];
      if (!hotPathRepairApplied) {
        markInProgress();
        storage.transactionSync(() => {
          this.db.execScript(HOT_PATH_INDEX_SCHEMA_REPAIR);
          sql.exec(
            `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at) VALUES (?1, datetime('now'))`,
            HOT_PATH_INDEX_SCHEMA_REPAIR_ID,
          );
        });
      }

      // Same drift problem, for the reconciliation index (migration 40) and the
      // stock_item_latest_purchase table (migration 41), both added 2026-08-28. Must run BEFORE
      // the stock_item_latest_purchase backfill below, which no-ops while the table is absent.
      const reconciliationAndPurchaseSummaryRepairApplied = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR_ID,
      ).toArray()[0];
      if (!reconciliationAndPurchaseSummaryRepairApplied) {
        markInProgress();
        storage.transactionSync(() => {
          this.db.execScript(RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR);
          sql.exec(
            `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at) VALUES (?1, datetime('now'))`,
            RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR_ID,
          );
        });
      }

      // Same drift problem, for the adjustment_lines/adjustments indexes (migration 42, 2026-08-28).
      const adjustmentLinesIndexRepairApplied = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR_ID,
      ).toArray()[0];
      if (!adjustmentLinesIndexRepairApplied) {
        markInProgress();
        storage.transactionSync(() => {
          this.db.execScript(ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR);
          sql.exec(
            `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at) VALUES (?1, datetime('now'))`,
            ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR_ID,
          );
        });
      }

      // Same drift problem, for the second half of migration 33 that YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR
      // deliberately left out (yoco_v2_reconciliation_findings.last_seen_at/last_run_id/occurrence_count
      // and its unique index) — see that repair's own comment and this one's for the live incident this
      // closes. Without it, a drifted tenant's reconciliation run fails outright on its first finding,
      // silently disabling the backstop that resolves an order left unwritten by the
      // order.updated/order.completed "not final yet" skip path.
      const reconciliationFindingsColumnsRepairApplied = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        YOCO_V2_RECONCILIATION_FINDINGS_COLUMNS_SCHEMA_REPAIR_ID,
      ).toArray()[0];
      if (!reconciliationFindingsColumnsRepairApplied) {
        markInProgress();
        storage.transactionSync(() => {
          this.db.execScript(YOCO_V2_RECONCILIATION_FINDINGS_COLUMNS_SCHEMA_REPAIR);
          sql.exec(
            `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at) VALUES (?1, datetime('now'))`,
            YOCO_V2_RECONCILIATION_FINDINGS_COLUMNS_SCHEMA_REPAIR_ID,
          );
        });
      }

      // Same drift problem again, for the xero_sync_settings/suppliers columns added by Xero
      // migrations 46 and 49 (2026-09-01) — see XERO_V2_SETTINGS_SCHEMA_REPAIR's own comment for
      // the live "no such column" 500 on POST xero/settings this fixes.
      const xeroSettingsRepairApplied = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        XERO_V2_SETTINGS_SCHEMA_REPAIR_ID,
      ).toArray()[0];
      if (!xeroSettingsRepairApplied) {
        markInProgress();
        storage.transactionSync(() => {
          this.db.execScript(XERO_V2_SETTINGS_SCHEMA_REPAIR);
          sql.exec(
            `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at) VALUES (?1, datetime('now'))`,
            XERO_V2_SETTINGS_SCHEMA_REPAIR_ID,
          );
        });
      }

      // Bounded, resumable backfill for stock_items.name_key — see its own constants' comment
      // above for the 2026-08-28 incident this replaced. Guarded by a persisted repair marker
      // (cheap primary-key lookup) so a tenant that has already finished never pays even the
      // "any rows left?" check again.
      const nameKeyBackfillDone = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        STOCK_ITEM_NAME_KEY_BACKFILL_ID,
      ).toArray()[0];
      if (!nameKeyBackfillDone) {
        const hasNameKeyColumn = (
          sql.exec(`PRAGMA table_info(stock_items)`).toArray() as Array<{ name?: unknown }>
        ).some((column) => String(column?.name ?? '') === 'name_key');
        if (hasNameKeyColumn) {
          markInProgress();
          let exhausted = false;
          for (let batch = 0; batch < STOCK_ITEM_NAME_KEY_BACKFILL_MAX_BATCHES_PER_REQUEST; batch++) {
            const cursor = sql.exec(STOCK_ITEM_NAME_KEY_BACKFILL_SQL, STOCK_ITEM_NAME_KEY_BACKFILL_BATCH_ROWS);
            cursor.toArray(); // drain to populate rowsWritten, same requirement as d1-facade.ts
            const updated = Number((cursor as unknown as { rowsWritten?: number }).rowsWritten || 0);
            if (updated < STOCK_ITEM_NAME_KEY_BACKFILL_BATCH_ROWS) {
              exhausted = true;
              break;
            }
          }
          if (exhausted) {
            sql.exec(
              `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at) VALUES (?1, datetime('now'))`,
              STOCK_ITEM_NAME_KEY_BACKFILL_ID,
            );
          }
          // Not exhausted: leave the repair marker unset so the next request picks up where this
          // one left off. markInProgress() above still clears normally below via
          // shouldClearMigrationHealth, since a partial backfill is forward progress, not a failure.
        }
      }

      // Bounded, resumable backfill for stock_item_latest_purchase — see its own constants'
      // comment above.
      const purchaseSummaryBackfillDone = sql.exec(
        `SELECT repair_id FROM _kcp_runtime_repairs WHERE repair_id = ?1`,
        STOCK_ITEM_LATEST_PURCHASE_BACKFILL_ID,
      ).toArray()[0];
      if (!purchaseSummaryBackfillDone) {
        const hasSummaryTable = (
          sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stock_item_latest_purchase'`).toArray()
        ).length > 0;
        if (hasSummaryTable) {
          markInProgress();
          sql.exec(
            `CREATE TABLE IF NOT EXISTS _kcp_runtime_backfill_cursors (
               backfill_id TEXT PRIMARY KEY,
               cursor TEXT NOT NULL
             )`
          );
          let exhausted = false;
          for (let batch = 0; batch < STOCK_ITEM_LATEST_PURCHASE_BACKFILL_MAX_BATCHES_PER_REQUEST; batch++) {
            const cursorRow = sql.exec(
              `SELECT cursor FROM _kcp_runtime_backfill_cursors WHERE backfill_id = ?1`,
              STOCK_ITEM_LATEST_PURCHASE_BACKFILL_ID,
            ).toArray()[0] as { cursor?: unknown } | undefined;
            const cursor = String(cursorRow?.cursor ?? '');
            const idRows = sql.exec(
              `SELECT id FROM grv_lines WHERE id > ?1 ORDER BY id ASC LIMIT ?2`,
              cursor,
              STOCK_ITEM_LATEST_PURCHASE_BACKFILL_BATCH_ROWS,
            ).toArray() as Array<{ id?: unknown }>;
            if (idRows.length === 0) {
              exhausted = true;
              break;
            }
            const lastId = String(idRows[idRows.length - 1].id);
            sql.exec(STOCK_ITEM_LATEST_PURCHASE_BACKFILL_UPSERT_SQL, cursor, lastId);
            sql.exec(
              `INSERT INTO _kcp_runtime_backfill_cursors (backfill_id, cursor) VALUES (?1, ?2)
               ON CONFLICT(backfill_id) DO UPDATE SET cursor = excluded.cursor`,
              STOCK_ITEM_LATEST_PURCHASE_BACKFILL_ID,
              lastId,
            );
            if (idRows.length < STOCK_ITEM_LATEST_PURCHASE_BACKFILL_BATCH_ROWS) {
              exhausted = true;
              break;
            }
          }
          if (exhausted) {
            sql.exec(
              `INSERT OR REPLACE INTO _kcp_runtime_repairs (repair_id, applied_at) VALUES (?1, datetime('now'))`,
              STOCK_ITEM_LATEST_PURCHASE_BACKFILL_ID,
            );
          }
          // Not exhausted: cursor is already persisted above, so the next request resumes from
          // exactly where this one left off.
        }
      }

      // Success — clear any prior backoff state (and the in-progress marker) so a future genuine
      // failure starts counting fresh. Conditional, because migrate() runs on EVERY request: issued
      // unconditionally this wrote one row per request forever, on a tenant with nothing left to
      // migrate. Measured at 20 requests per page load that is 20 wasted writes per page — 2% of
      // the entire 100,000/day Durable Objects write allowance per 100 page loads, spent on
      // rewriting a row to the values it already held. Only write when something actually changed:
      // either this pass marked an attempt in progress, or the persisted row is genuinely dirty.
      if (shouldClearMigrationHealth(health, markedInProgress)) {
        sql.exec(
          `UPDATE _kcp_migration_health SET consecutive_failures = 0, next_retry_at = NULL, in_progress_since = NULL WHERE id = 1`
        );
      }

      // Reaching here means this pass completed without throwing. If there is also nothing left
      // pending, this isolate never needs to touch migration storage again: later requests return
      // at the in-memory check above instead of re-running the ~10 bookkeeping statements. Only set
      // it when the backlog is genuinely exhausted — migrate() applies at most ONE migration per
      // invocation, so a tenant catching up is still mid-chain here and must come back next request.
      if (applied >= TENANT_MIGRATIONS.length) {
        this.migrationSettledInMemory = true;
      }
    } catch (cause) {
      const message = String((cause as Error)?.message || cause || '');
      recordFailure(message, false);
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
    this.ensureMigrated();
    const workspaceId = request.headers.get('x-kcp-workspace') || '';
    const resource = request.headers.get('x-kcp-resource') || new URL(request.url).pathname;

    // Diagnostic (2026-08-28): which workspace(s) actually account for the account's total SQL
    // storage. `databaseSize` is a real, cheap, synchronous property of this DO's own SQLite
    // storage — no query, no rows read — so this is safe to fan out to every workspace on demand.
    // See /api/admin/workspace-storage in index.ts for the fan-out caller.
    if (resource === 'admin-database-size') {
      return new Response(JSON.stringify({ ok: true, databaseSizeBytes: this.state.storage.sql.databaseSize }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    // Diagnostic (2026-08-28): why isn't stock deducting for a workspace that IS live, when
    // reporting works fine? Calls the EXACT SAME function live-sale.ts's applyStock() calls to
    // decide whether to deduct — getEffectRuntime() — for both SALE_REPORTING and SALE_STOCK, so
    // the answer reflects the real gate logic rather than a guess. Each result's `reason` field is
    // a plain code (EFFECT_OWNERSHIP_NOT_V2, WORKSPACE_EFFECT_DISABLED, V2_CONSUMPTION_PAUSED,
    // WORKSPACE_NOT_LIVE, ACTIVE) already built into that function for exactly this purpose.
    if (resource === 'admin-effect-runtime-check') {
      const integrationId = `yoco:${workspaceId}`;
      const [saleReporting, saleStock] = await Promise.all([
        getEffectRuntime(this.legacyEnv(), workspaceId, integrationId, 'SALE_REPORTING'),
        getEffectRuntime(this.legacyEnv(), workspaceId, integrationId, 'SALE_STOCK'),
      ]);
      return new Response(JSON.stringify({ ok: true, saleReporting, saleStock }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    // Diagnostic (2026-08-28): the effect gate is confirmed ACTIVE for SALE_STOCK on some
    // workspaces (see admin-effect-runtime-check), yet stock still isn't deducting. The other
    // known way applyStock() (live-sale.ts) legitimately deducts nothing: every proposed line for
    // the sale was unresolved (unmapped modifier/item, missing recipe, invalid UOM) and skipped —
    // the order still completes and posts to reporting, but there's nothing resolvable to deduct.
    // Returns the most recent proposed stock movements with their resolution_status/warning_code
    // so we can see directly whether that's what's happening, and for which items.
    if (resource === 'admin-recent-stock-proposals') {
      const sql = this.state.storage.sql;
      const rows = sql.exec(
        `SELECT source_order_id, source_line_id, menu_item_id, modifier_id, ingredient_item_id,
                quantity, resolution_status, warning_code, created_at
           FROM yoco_v2_proposed_stock_movements
          ORDER BY created_at DESC LIMIT 25`
      ).toArray();
      const byStatus = sql.exec(
        `SELECT resolution_status, warning_code, COUNT(*) AS n
           FROM yoco_v2_proposed_stock_movements
          GROUP BY resolution_status, warning_code
          ORDER BY n DESC`
      ).toArray();
      return new Response(JSON.stringify({ ok: true, recentProposals: rows, statusBreakdown: byStatus }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    // Diagnostic (2026-08-28): is yoco_v2_reconciliation_findings' dedup migration actually in
    // effect for this workspace, or is it a drifted tenant (like WS-lellos-trattoria-bee300)
    // silently still on the pre-fix behavior — one new row per finding per run, forever?
    if (resource === 'admin-findings-dedup-check') {
      const sql = this.state.storage.sql;
      const schemaRow = sql.exec(`SELECT version FROM _kcp_schema WHERE id = 1`).toArray()[0] as { version?: unknown } | undefined;
      const uniqueIndexExists = (sql.exec(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_yoco_v2_reconciliation_findings_entity'`
      ).toArray() as unknown[]).length > 0;
      const totalRow = sql.exec(`SELECT COUNT(*) AS n FROM yoco_v2_reconciliation_findings`).toArray()[0] as { n?: unknown };
      const distinctRow = sql.exec(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM yoco_v2_reconciliation_findings GROUP BY workspace_id, integration_id, finding_type, source_entity_type, source_entity_id)`
      ).toArray()[0] as { n?: unknown };
      const maxOccurrenceRow = sql.exec(`SELECT MAX(occurrence_count) AS n FROM yoco_v2_reconciliation_findings`).toArray()[0] as { n?: unknown };
      const topDuplicates = sql.exec(
        `SELECT source_entity_id, finding_type, COUNT(*) AS n
           FROM yoco_v2_reconciliation_findings
          GROUP BY workspace_id, integration_id, finding_type, source_entity_type, source_entity_id
         HAVING COUNT(*) > 1
          ORDER BY n DESC LIMIT 5`
      ).toArray();
      return new Response(JSON.stringify({
        ok: true,
        schemaVersion: Number(schemaRow?.version || 0),
        totalMigrationsLength: TENANT_MIGRATIONS.length,
        uniqueIndexExists,
        totalRows: Number(totalRow?.n || 0),
        distinctEntityKeys: Number(distinctRow?.n || 0),
        maxOccurrenceCount: Number(maxOccurrenceRow?.n || 0),
        topDuplicateGroups: topDuplicates
      }), { headers: { 'content-type': 'application/json' } });
    }

    // Cleanup action (2026-08-28): wipe yoco_v2_reconciliation_findings for this workspace. Safe
    // to run — this table only holds "reconciliation noticed a problem" records, not real
    // transaction/order/stock data; a genuine still-open issue is simply rediscovered fresh on
    // the next reconciliation run. Intended for a workspace confirmed (via
    // admin-findings-dedup-check) to have accumulated a large backlog, e.g. from a drifted
    // migration counter that missed the dedup fix. No WHERE clause needed: each Durable Object
    // only holds this one workspace's own tables, so this can't reach any other workspace's data.
    if (request.method === 'POST' && resource === 'admin-findings-purge') {
      const sql = this.state.storage.sql;
      const cursor = sql.exec(`DELETE FROM yoco_v2_reconciliation_findings`);
      cursor.toArray(); // drain to populate rowsWritten
      const deletedRows = Number((cursor as unknown as { rowsWritten?: number }).rowsWritten || 0);
      return new Response(JSON.stringify({ ok: true, deletedRows }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    // Diagnostic (2026-08-28): follow-up to admin-database-size — which TABLE(S) inside one
    // workspace actually account for its storage. Row counts always work; per-table byte sizes
    // use SQLite's `dbstat` virtual table where the runtime supports it, falling back to
    // rows-only if it doesn't rather than failing the whole diagnostic.
    if (resource === 'admin-table-sizes') {
      const sql = this.state.storage.sql;
      const tables = (sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).toArray() as Array<{ name?: unknown }>)
        .map((row) => String(row.name || ''))
        .filter(Boolean);
      let byteSizes: Map<string, number> | null = null;
      try {
        const rows = sql.exec(`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`).toArray() as Array<{ name?: unknown; bytes?: unknown }>;
        byteSizes = new Map(rows.map((row) => [String(row.name || ''), Number(row.bytes || 0)]));
      } catch {
        byteSizes = null; // dbstat not available in this runtime — row counts only below.
      }
      const results = tables.map((table) => {
        let rowCount = 0;
        try {
          rowCount = Number((sql.exec(`SELECT COUNT(*) AS n FROM "${table}"`).toArray()[0] as { n?: unknown })?.n || 0);
        } catch {
          rowCount = -1; // couldn't count this one — surfaced as -1 rather than silently omitted.
        }
        return { table, rowCount, bytes: byteSizes ? (byteSizes.get(table) ?? 0) : null };
      }).sort((a, b) => (b.bytes ?? b.rowCount) - (a.bytes ?? a.rowCount));
      return new Response(JSON.stringify({ ok: true, dbstatAvailable: byteSizes !== null, tables: results }), {
        headers: { 'content-type': 'application/json' }
      });
    }

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

    // Xero routes (connection/OAuth, settings, item/invoice push) are likewise isolated from the
    // legacy dispatcher — see modules/xero-engine/route-dispatch.ts. Wrapped in its own try/catch
    // (unlike the V2/legacy dispatchers above/below) because a tenant whose migrations have
    // drifted can still throw a raw "no such column" SQLite error here even after
    // XERO_V2_SETTINGS_SCHEMA_REPAIR — e.g. a table this repair doesn't cover, or a repair that
    // hasn't run yet on this exact request. Surface it as a real JSON error instead of a bare,
    // bodyless 500 that the frontend can't explain to the user.
    try {
      const xeroResponse = await dispatchXeroWorkspaceRoute(request, tenantEnv, auth, workspaceId, resource);
      if (xeroResponse) return xeroResponse;
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Xero request failed. If this persists, contact support.', detail: String((err as Error)?.message || err) }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }

    // Google Drive routes (connection/OAuth, settings, GRV/Credit Note PDF push, KCP Assistant
    // OCR) are likewise isolated from the legacy dispatcher — see
    // modules/drive-engine/route-dispatch.ts. Same defensive try/catch as the Xero dispatch above,
    // for the same reason (a drifted tenant migration can still throw a raw SQLite error here).
    try {
      const driveResponse = await dispatchDriveWorkspaceRoute(request, tenantEnv, auth, workspaceId, resource);
      if (driveResponse) return driveResponse;
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Google Drive request failed. If this persists, contact support.', detail: String((err as Error)?.message || err) }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }

    // Non-Yoco/Xero/Drive workspace routes still use the shared tenant dispatcher. Yoco webhook,
    // queue, reconciliation, sale, and refund effects are handled exclusively by the V2 dispatcher
    // above.
    return dispatchWorkspaceRoute(request, tenantEnv, auth, workspaceId, resource);
  }
}
