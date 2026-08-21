import type { DbLike, DbStatementLike } from '../../legacy/types';
import { YOCO_V2_EFFECT_TYPES, type YocoV2EffectType } from './contracts';

function nowIso(): string {
  return new Date().toISOString();
}

type OwnershipRow = {
  effect_type?: string;
  engine_version?: string;
  enabled?: number;
};

export interface YocoV2OwnershipMigrationResult {
  cutoverAt: string | null;
  changedEffects: YocoV2EffectType[];
  migratedEffects: YocoV2EffectType[];
  initializedEffects: YocoV2EffectType[];
  ownershipMigrated: boolean;
}

function normalizedEngine(value: unknown): 'LEGACY' | 'V2' {
  return String(value || '').trim().toUpperCase() === 'V2' ? 'V2' : 'LEGACY';
}

function ownershipIsV2(row: OwnershipRow | undefined): boolean {
  return Boolean(row)
    && normalizedEngine(row?.engine_version) === 'V2'
    && Number(row?.enabled || 0) === 1;
}

function ownershipHistoryStatement(
  db: DbLike,
  workspaceId: string,
  integrationId: string,
  effectType: YocoV2EffectType,
  previous: OwnershipRow,
  cutoverAt: string,
  actorId: string,
): DbStatementLike {
  const historyId = `yoco-v2-only-connect:${workspaceId}:${effectType}`;
  const previousEngine = normalizedEngine(previous.engine_version);
  const previousEnabled = Number(previous.enabled || 0) === 1 ? 1 : 0;
  const reason = 'V2-only Yoco connection activated after the legacy Yoco runtime was removed.';
  const details = JSON.stringify({
    source: 'yoco-v2-connect',
    one_way_migration: true,
    legacy_runtime_restored: false,
  });

  if (effectType === 'SALE_REPORTING' || effectType === 'SALE_STOCK') {
    return db.prepare(
      `INSERT OR IGNORE INTO yoco_v2_cutover_history
        (id, workspace_id, integration_id, effect_type, previous_engine_version, new_engine_version,
         previous_enabled, new_enabled, cutover_at, actor_id, reason,
         transition_window_start, transition_window_end, details_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'V2', ?6, 1, ?7, ?8, ?9, ?7, ?7, ?10, ?7)`,
    ).bind(
      historyId,
      workspaceId,
      integrationId,
      effectType,
      previousEngine,
      previousEnabled,
      cutoverAt,
      actorId,
      reason,
      details,
    );
  }

  return db.prepare(
    `INSERT OR IGNORE INTO yoco_v2_refund_cutover_history
      (id, workspace_id, integration_id, effect_type, previous_engine_version, new_engine_version,
       previous_enabled, new_enabled, cutover_at, actor_id, reason,
       transition_window_start, transition_window_end, details_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'V2', ?6, 1, ?7, ?8, ?9, ?7, ?7, ?10, ?7)`,
  ).bind(
    historyId,
    workspaceId,
    integrationId,
    effectType,
    previousEngine,
    previousEnabled,
    cutoverAt,
    actorId,
    reason,
    details,
  );
}

function effectControlStatement(
  db: DbLike,
  workspaceId: string,
  integrationId: string,
  effectType: YocoV2EffectType,
  cutoverAt: string,
  actorId: string,
): DbStatementLike {
  return db.prepare(
    `INSERT INTO yoco_v2_effect_gate
      (workspace_id, integration_id, effect_type, feature_enabled, consumption_paused,
       pause_reason, cutover_at, activated_by, updated_at, updated_by)
     VALUES (?1, ?2, ?3, 1, 0, NULL, ?4, ?5, ?4, ?5)
     ON CONFLICT(workspace_id, integration_id, effect_type) DO UPDATE SET
       feature_enabled = 1,
       consumption_paused = 0,
       pause_reason = NULL,
       cutover_at = excluded.cutover_at,
       activated_by = excluded.activated_by,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).bind(workspaceId, integrationId, effectType, cutoverAt, actorId);
}

/**
 * One-way cutover used only by an authorised V2 Connect request.
 *
 * The legacy Yoco processors no longer exist, so keeping historic LEGACY ownership rows blocks
 * the only available engine. A successful credential validation is the explicit migration action:
 * all four effects are claimed by V2, activated at one cutover instant and recorded in the
 * append-only sale/refund cutover history tables. The operation is idempotent.
 */
export async function migrateYocoV2EffectOwnershipForConnection(
  db: DbLike,
  workspaceId: string,
  integrationId = `yoco:${workspaceId}`,
  actorId = 'yoco-v2-connect',
): Promise<YocoV2OwnershipMigrationResult> {
  const existing = await db.prepare(
    `SELECT effect_type, engine_version, enabled
       FROM integration_effect_ownership
      WHERE workspace_id = ?1 AND integration_type = 'YOCO'`,
  ).bind(workspaceId).all<OwnershipRow>();

  const rows = existing.results || [];
  const byType = new Map(rows.map((row) => [String(row.effect_type || ''), row]));
  const changedEffects = YOCO_V2_EFFECT_TYPES.filter((effectType) => !ownershipIsV2(byType.get(effectType)));
  const initializedEffects = changedEffects.filter((effectType) => !byType.has(effectType));
  const migratedEffects = changedEffects.filter((effectType) => byType.has(effectType));
  if (!changedEffects.length) {
    return {
      cutoverAt: null,
      changedEffects: [],
      migratedEffects: [],
      initializedEffects: [],
      ownershipMigrated: false,
    };
  }

  const cutoverAt = nowIso();
  const statements: DbStatementLike[] = [];
  for (const effectType of changedEffects) {
    const previous = byType.get(effectType);
    if (previous) {
      statements.push(ownershipHistoryStatement(
        db,
        workspaceId,
        integrationId,
        effectType,
        previous,
        cutoverAt,
        actorId,
      ));
    }

    statements.push(
      db.prepare(
        `INSERT INTO integration_effect_ownership
          (workspace_id, integration_type, effect_type, engine_version, enabled,
           enabled_at, enabled_by, updated_at)
         VALUES (?1, 'YOCO', ?2, 'V2', 1, ?3, ?4, ?3)
         ON CONFLICT(workspace_id, integration_type, effect_type) DO UPDATE SET
           engine_version = 'V2',
           enabled = 1,
           enabled_at = excluded.enabled_at,
           enabled_by = excluded.enabled_by,
           updated_at = excluded.updated_at`,
      ).bind(workspaceId, effectType, cutoverAt, actorId),
      effectControlStatement(db, workspaceId, integrationId, effectType, cutoverAt, actorId),
    );
  }

  await db.batch(statements);
  await assertAllYocoEffectsOwnedByV2(db, workspaceId);

  return {
    cutoverAt,
    changedEffects,
    migratedEffects,
    initializedEffects,
    ownershipMigrated: migratedEffects.length > 0,
  };
}

export async function assertYocoV2OwnershipReadyOrUninitialized(db: DbLike, workspaceId: string): Promise<void> {
  const rows = await db.prepare(
    `SELECT effect_type, engine_version, enabled
       FROM integration_effect_ownership
      WHERE workspace_id = ?1 AND integration_type = 'YOCO'`,
  ).bind(workspaceId).all<OwnershipRow>();
  const current = rows.results || [];
  if (!current.length) return;
  const byType = new Map(current.map((row) => [String(row.effect_type || ''), row]));
  const invalid = YOCO_V2_EFFECT_TYPES.filter((effectType) => !ownershipIsV2(byType.get(effectType)));
  if (invalid.length) throw new Error(`YOCO_V2_OWNERSHIP_REQUIRES_EXPLICIT_MIGRATION:${invalid.join(',')}`);
}

export async function initializeYocoV2EffectOwnershipForNewIntegration(
  db: DbLike,
  workspaceId: string,
  actorId = 'yoco-v2-connect',
): Promise<void> {
  await migrateYocoV2EffectOwnershipForConnection(
    db,
    workspaceId,
    `yoco:${workspaceId}`,
    actorId,
  );
}

export async function assertAllYocoEffectsOwnedByV2(db: DbLike, workspaceId: string): Promise<void> {
  const rows = await db.prepare(
    `SELECT effect_type, engine_version, enabled
       FROM integration_effect_ownership
      WHERE workspace_id = ?1 AND integration_type = 'YOCO'`,
  ).bind(workspaceId).all<OwnershipRow>();
  const byType = new Map((rows.results || []).map((row) => [String(row.effect_type || ''), row]));
  const invalid = YOCO_V2_EFFECT_TYPES.filter((effectType) => !ownershipIsV2(byType.get(effectType)));
  if (invalid.length) throw new Error(`YOCO_V2_OWNERSHIP_NOT_READY:${invalid.join(',')}`);
}

export async function isV2EffectOwner(db: DbLike, workspaceId: string, effectType: YocoV2EffectType): Promise<boolean> {
  const row = await db.prepare(
    `SELECT engine_version, enabled
       FROM integration_effect_ownership
      WHERE workspace_id = ?1
        AND integration_type = 'YOCO'
        AND effect_type = ?2
      LIMIT 1`,
  ).bind(workspaceId, effectType).first<OwnershipRow>();
  return ownershipIsV2(row || undefined);
}
