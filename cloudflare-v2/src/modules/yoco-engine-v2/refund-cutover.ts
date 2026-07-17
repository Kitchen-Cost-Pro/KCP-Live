import type { Env } from '../../legacy/types';
import { yocoV2FeatureFlags } from './config';
import type { YocoV2EffectType } from './contracts';
import { nowIso, type Row } from './repository';

export type RefundEffectType = Extract<YocoV2EffectType, 'REFUND_REPORTING' | 'REFUND_STOCK'>;

function text(value: unknown): string { return String(value ?? '').trim(); }
function enabled(value: unknown, fallback = true): boolean {
  if (value == null || value === '') return fallback;
  return Number(value) === 1;
}

export interface RefundEffectRuntime {
  effectType: RefundEffectType;
  workspaceId: string;
  integrationId: string;
  environmentEnabled: boolean;
  ownerIsV2: boolean;
  featureEnabled: boolean;
  paused: boolean;
  cutoverAt: string | null;
  activatedBy: string | null;
  canConsume: boolean;
  reason: string;
}

export async function getRefundEffectRuntime(
  env: Env,
  workspaceId: string,
  integrationId: string,
  effectType: RefundEffectType,
): Promise<RefundEffectRuntime> {
  const [ownership, control] = await Promise.all([
    env.DB.prepare(
      `SELECT engine_version, enabled FROM integration_effect_ownership
        WHERE workspace_id = ?1 AND integration_type = 'YOCO' AND effect_type = ?2 LIMIT 1`,
    ).bind(workspaceId, effectType).first<Row>(),
    env.DB.prepare(
      `SELECT feature_enabled, consumption_paused, cutover_at, activated_by
         FROM yoco_v2_refund_effect_controls
        WHERE workspace_id = ?1 AND integration_id = ?2 AND effect_type = ?3 LIMIT 1`,
    ).bind(workspaceId, integrationId, effectType).first<Row>(),
  ]);
  const flags = yocoV2FeatureFlags(env, workspaceId);
  const environmentEnabled = effectType === 'REFUND_REPORTING'
    ? flags.yoco_v2_live_refund_reporting
    : flags.yoco_v2_live_refund_stock;
  const ownerIsV2 = text(ownership?.engine_version).toUpperCase() === 'V2' && enabled(ownership?.enabled, false);
  const featureEnabled = enabled(control?.feature_enabled, true);
  const paused = enabled(control?.consumption_paused, false);
  const canConsume = environmentEnabled && ownerIsV2 && featureEnabled && !paused;
  const reason = !environmentEnabled ? 'REFUND_ENVIRONMENT_FEATURE_FLAG_DISABLED'
    : !ownerIsV2 ? 'REFUND_EFFECT_OWNERSHIP_NOT_V2'
      : !featureEnabled ? 'REFUND_WORKSPACE_EFFECT_DISABLED'
        : paused ? 'V2_REFUND_CONSUMPTION_PAUSED'
          : 'ACTIVE';
  return {
    effectType, workspaceId, integrationId, environmentEnabled, ownerIsV2, featureEnabled, paused,
    cutoverAt: text(control?.cutover_at) || null,
    activatedBy: text(control?.activated_by) || null,
    canConsume, reason,
  };
}

export async function pauseRefundEffect(env: Env, input: {
  workspaceId: string; integrationId: string; effectType: RefundEffectType; actorId: string; reason?: string;
}): Promise<Row> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_refund_effect_controls
      (workspace_id, integration_id, effect_type, feature_enabled, consumption_paused, pause_reason, cutover_at, activated_by, updated_at, updated_by)
     VALUES (?1, ?2, ?3, 1, 1, ?4, ?5, ?6, ?5, ?6)
     ON CONFLICT(workspace_id, integration_id, effect_type) DO UPDATE SET
       consumption_paused=1, pause_reason=excluded.pause_reason, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  ).bind(input.workspaceId, input.integrationId, input.effectType, input.reason || 'Paused by administrator.', now, input.actorId).run();
  return (await env.DB.prepare(
    `SELECT * FROM yoco_v2_refund_effect_controls WHERE workspace_id=?1 AND integration_id=?2 AND effect_type=?3`,
  ).bind(input.workspaceId, input.integrationId, input.effectType).first<Row>()) || {};
}

export async function resumeRefundEffect(env: Env, input: {
  workspaceId: string; integrationId: string; effectType: RefundEffectType; actorId: string;
}): Promise<Row> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_refund_effect_controls
      (workspace_id, integration_id, effect_type, feature_enabled, consumption_paused, cutover_at, activated_by, updated_at, updated_by)
     VALUES (?1, ?2, ?3, 1, 0, ?4, ?5, ?4, ?5)
     ON CONFLICT(workspace_id, integration_id, effect_type) DO UPDATE SET
       feature_enabled=1, consumption_paused=0, pause_reason=NULL, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  ).bind(input.workspaceId, input.integrationId, input.effectType, now, input.actorId).run();
  return (await env.DB.prepare(
    `SELECT * FROM yoco_v2_refund_effect_controls WHERE workspace_id=?1 AND integration_id=?2 AND effect_type=?3`,
  ).bind(input.workspaceId, input.integrationId, input.effectType).first<Row>()) || {};
}
