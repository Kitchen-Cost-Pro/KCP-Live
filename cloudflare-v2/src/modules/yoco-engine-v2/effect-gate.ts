import type { Env } from '../../legacy/types';
import { yocoV2FeatureFlags } from './config';
import type { YocoV2EffectType } from './contracts';
import { nowIso, type Row } from './repository';

function text(value: unknown): string { return String(value ?? '').trim(); }
function enabled(value: unknown, fallback = true): boolean {
  if (value == null || value === '') return fallback;
  return Number(value) === 1;
}

function environmentEnabledFor(env: Env, workspaceId: string, effectType: YocoV2EffectType): boolean {
  const flags = yocoV2FeatureFlags(env, workspaceId);
  switch (effectType) {
    case 'SALE_REPORTING': return flags.yoco_v2_live_sale_reporting;
    case 'SALE_STOCK': return flags.yoco_v2_live_sale_stock;
    case 'REFUND_REPORTING': return flags.yoco_v2_live_refund_reporting;
    case 'REFUND_STOCK': return flags.yoco_v2_live_refund_stock;
  }
}

function disabledReasonPrefix(effectType: YocoV2EffectType): string {
  return effectType.startsWith('REFUND_') ? 'REFUND_' : '';
}

function isStockEffect(effectType: YocoV2EffectType): boolean {
  return effectType === 'SALE_STOCK' || effectType === 'REFUND_STOCK';
}

// Settings.js's "Go Live" panel sets this flag (stockDepletionEnabled, in workspace_settings.raw_json
// — see settingsService.js) and its copy explicitly promises "New paid sales will deduct after Go
// Live". That promise was never actually wired into the deduction path: this was the only gate
// missing from getEffectRuntime, so a workspace connected to Yoco started deducting real stock on
// every completed sale regardless of whether the merchant had clicked Go Live. Only STOCK effect
// types are gated by it — reporting should still reflect real sales during onboarding review.
async function workspaceStockDepletionEnabled(env: Env, workspaceId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
  ).bind(workspaceId).first<Row>();
  try {
    return JSON.parse(text(row?.raw_json) || '{}')?.stockDepletionEnabled === true;
  } catch {
    return false;
  }
}

export interface EffectRuntime {
  effectType: YocoV2EffectType;
  workspaceId: string;
  integrationId: string;
  environmentEnabled: boolean;
  ownerIsV2: boolean;
  featureEnabled: boolean;
  paused: boolean;
  workspaceLive: boolean;
  cutoverAt: string | null;
  activatedBy: string | null;
  canConsume: boolean;
  reason: string;
}

export async function getEffectRuntime(
  env: Env,
  workspaceId: string,
  integrationId: string,
  effectType: YocoV2EffectType,
): Promise<EffectRuntime> {
  const [ownership, control, workspaceLive] = await Promise.all([
    env.DB.prepare(
      `SELECT engine_version, enabled FROM integration_effect_ownership
        WHERE workspace_id = ?1 AND integration_type = 'YOCO' AND effect_type = ?2 LIMIT 1`,
    ).bind(workspaceId, effectType).first<Row>(),
    env.DB.prepare(
      `SELECT feature_enabled, consumption_paused, cutover_at, activated_by
         FROM yoco_v2_effect_gate
        WHERE workspace_id = ?1 AND integration_id = ?2 AND effect_type = ?3 LIMIT 1`,
    ).bind(workspaceId, integrationId, effectType).first<Row>(),
    // Only stock effects care about the merchant's own Go Live status — skip the extra read for
    // reporting effects, which should keep reflecting real sales during onboarding review.
    isStockEffect(effectType) ? workspaceStockDepletionEnabled(env, workspaceId) : Promise.resolve(true),
  ]);
  const environmentEnabled = environmentEnabledFor(env, workspaceId, effectType);
  const ownerIsV2 = text(ownership?.engine_version).toUpperCase() === 'V2' && enabled(ownership?.enabled, false);
  const featureEnabled = enabled(control?.feature_enabled, true);
  const paused = enabled(control?.consumption_paused, false);
  const canConsume = environmentEnabled && ownerIsV2 && featureEnabled && !paused && workspaceLive;
  const prefix = disabledReasonPrefix(effectType);
  const reason = !environmentEnabled ? `${prefix}ENVIRONMENT_FEATURE_FLAG_DISABLED`
    : !ownerIsV2 ? `${prefix}EFFECT_OWNERSHIP_NOT_V2`
      : !featureEnabled ? `${prefix}WORKSPACE_EFFECT_DISABLED`
        : paused ? `V2_${prefix}CONSUMPTION_PAUSED`
          : !workspaceLive ? `${prefix}WORKSPACE_NOT_LIVE`
            : 'ACTIVE';
  return {
    effectType, workspaceId, integrationId, environmentEnabled, ownerIsV2, featureEnabled, paused, workspaceLive,
    cutoverAt: text(control?.cutover_at) || null,
    activatedBy: text(control?.activated_by) || null,
    canConsume, reason,
  };
}

export async function pauseEffect(env: Env, input: {
  workspaceId: string; integrationId: string; effectType: YocoV2EffectType; actorId: string; reason?: string;
}): Promise<Row> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_effect_gate
      (workspace_id, integration_id, effect_type, feature_enabled, consumption_paused, pause_reason, cutover_at, activated_by, updated_at, updated_by)
     VALUES (?1, ?2, ?3, 1, 1, ?4, ?5, ?6, ?5, ?6)
     ON CONFLICT(workspace_id, integration_id, effect_type) DO UPDATE SET
       consumption_paused = 1, pause_reason = excluded.pause_reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(input.workspaceId, input.integrationId, input.effectType, input.reason || 'Paused by administrator.', now, input.actorId).run();
  return (await env.DB.prepare(
    `SELECT * FROM yoco_v2_effect_gate WHERE workspace_id=?1 AND integration_id=?2 AND effect_type=?3`,
  ).bind(input.workspaceId, input.integrationId, input.effectType).first<Row>()) || {};
}

export async function resumeEffect(env: Env, input: {
  workspaceId: string; integrationId: string; effectType: YocoV2EffectType; actorId: string;
}): Promise<Row> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_effect_gate
      (workspace_id, integration_id, effect_type, feature_enabled, consumption_paused, cutover_at, activated_by, updated_at, updated_by)
     VALUES (?1, ?2, ?3, 1, 0, ?4, ?5, ?4, ?5)
     ON CONFLICT(workspace_id, integration_id, effect_type) DO UPDATE SET
       feature_enabled=1, consumption_paused=0, pause_reason=NULL, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  ).bind(input.workspaceId, input.integrationId, input.effectType, now, input.actorId).run();
  return (await env.DB.prepare(
    `SELECT * FROM yoco_v2_effect_gate WHERE workspace_id=?1 AND integration_id=?2 AND effect_type=?3`,
  ).bind(input.workspaceId, input.integrationId, input.effectType).first<Row>()) || {};
}
