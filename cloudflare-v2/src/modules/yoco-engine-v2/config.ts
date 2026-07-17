export interface YocoV2FeatureEnv {
  YOCO_V2_CAPTURE_ENABLED?: string;
  YOCO_V2_QUEUE_ENABLED?: string;
  YOCO_V2_ADMIN_ENABLED?: string;
  YOCO_V2_LIVE_SALE_REPORTING?: string;
  YOCO_V2_LIVE_SALE_STOCK?: string;
  YOCO_V2_LIVE_REFUND_REPORTING?: string;
  YOCO_V2_LIVE_REFUND_STOCK?: string;
  YOCO_V2_MAX_ATTEMPTS?: string;
  YOCO_V2_BASE_RETRY_MS?: string;
  YOCO_V2_MAX_RETRY_MS?: string;
  YOCO_V2_API_TIMEOUT_MS?: string;
  YOCO_V2_REQUEST_SPACING_MS?: string;
  YOCO_V2_ORDER_CACHE_TTL_MS?: string;
  YOCO_V2_REFUND_CACHE_TTL_MS?: string;
  YOCO_V2_METADATA_CACHE_TTL_MS?: string;
  YOCO_V2_AUTH_FAILURE_THRESHOLD?: string;
  YOCO_V2_RATE_LIMIT_PAUSE_FALLBACK_MS?: string;
  YOCO_V2_RECONCILIATION_OVERLAP_MINUTES?: string;
  YOCO_V2_RECONCILIATION_LOOKBACK_HOURS?: string;
}

export interface YocoV2FeatureFlags {
  yoco_v2_capture_enabled: boolean;
  yoco_v2_queue_enabled: boolean;
  yoco_v2_admin_enabled: boolean;
  yoco_v2_live_sale_reporting: boolean;
  yoco_v2_live_sale_stock: boolean;
  yoco_v2_live_refund_reporting: boolean;
  yoco_v2_live_refund_stock: boolean;
}

function enabledForWorkspace(value: unknown, workspaceId: string): boolean {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on', 'all', '*'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'none'].includes(normalized)) return false;
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).includes(workspaceId);
}

export function yocoV2FeatureFlags(env: YocoV2FeatureEnv, workspaceId: string): YocoV2FeatureFlags {
  return {
    yoco_v2_capture_enabled: enabledForWorkspace(env.YOCO_V2_CAPTURE_ENABLED, workspaceId),
    yoco_v2_queue_enabled: enabledForWorkspace(env.YOCO_V2_QUEUE_ENABLED, workspaceId),
    yoco_v2_admin_enabled: enabledForWorkspace(env.YOCO_V2_ADMIN_ENABLED, workspaceId),
    // Final V2 runtime: sale effects remain fail-closed and require the environment
    // flag, V2 database ownership, and an enabled, unpaused effect control.
    yoco_v2_live_sale_reporting: enabledForWorkspace(env.YOCO_V2_LIVE_SALE_REPORTING, workspaceId),
    yoco_v2_live_sale_stock: enabledForWorkspace(env.YOCO_V2_LIVE_SALE_STOCK, workspaceId),
    // Refund reporting and stock remain independently controllable. Each requires the
    // environment flag, V2 database ownership, and an enabled, unpaused effect control.
    yoco_v2_live_refund_reporting: enabledForWorkspace(env.YOCO_V2_LIVE_REFUND_REPORTING, workspaceId),
    yoco_v2_live_refund_stock: enabledForWorkspace(env.YOCO_V2_LIVE_REFUND_STOCK, workspaceId)
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function yocoV2RetryConfig(env: YocoV2FeatureEnv) {
  return {
    maxAttempts: boundedInteger(env.YOCO_V2_MAX_ATTEMPTS, 8, 1, 25),
    baseRetryMs: boundedInteger(env.YOCO_V2_BASE_RETRY_MS, 5_000, 1_000, 300_000),
    maxRetryMs: boundedInteger(env.YOCO_V2_MAX_RETRY_MS, 15 * 60_000, 10_000, 24 * 60 * 60_000)
  };
}

export function yocoV2ApiConfig(env: YocoV2FeatureEnv) {
  return {
    timeoutMs: boundedInteger(env.YOCO_V2_API_TIMEOUT_MS, 15_000, 1_000, 120_000),
    // This is configurable conservative pacing, not a claim about Yoco's undocumented limit.
    requestSpacingMs: boundedInteger(env.YOCO_V2_REQUEST_SPACING_MS, 250, 0, 60_000),
    orderCacheTtlMs: boundedInteger(env.YOCO_V2_ORDER_CACHE_TTL_MS, 30_000, 0, 15 * 60_000),
    refundCacheTtlMs: boundedInteger(env.YOCO_V2_REFUND_CACHE_TTL_MS, 20_000, 0, 15 * 60_000),
    metadataCacheTtlMs: boundedInteger(env.YOCO_V2_METADATA_CACHE_TTL_MS, 60_000, 0, 60 * 60_000),
    authFailureThreshold: boundedInteger(env.YOCO_V2_AUTH_FAILURE_THRESHOLD, 2, 1, 10),
    rateLimitPauseFallbackMs: boundedInteger(env.YOCO_V2_RATE_LIMIT_PAUSE_FALLBACK_MS, 30_000, 1_000, 60 * 60_000)
  };
}

export function yocoV2ReconciliationConfig(env: YocoV2FeatureEnv) {
  return {
    overlapMinutes: boundedInteger(env.YOCO_V2_RECONCILIATION_OVERLAP_MINUTES, 120, 5, 7 * 24 * 60),
    initialLookbackHours: boundedInteger(env.YOCO_V2_RECONCILIATION_LOOKBACK_HOURS, 24, 1, 90 * 24)
  };
}
