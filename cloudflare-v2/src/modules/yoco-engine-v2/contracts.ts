export const YOCO_V2_ENGINE_VERSION = 'V2' as const;
export const LEGACY_ENGINE_VERSION = 'LEGACY' as const;

export const YOCO_V2_EFFECT_TYPES = [
  'SALE_REPORTING',
  'SALE_STOCK',
  'REFUND_REPORTING',
  'REFUND_STOCK'
] as const;

export type YocoV2EffectType = typeof YOCO_V2_EFFECT_TYPES[number];
export type YocoV2EngineVersion = typeof YOCO_V2_ENGINE_VERSION | typeof LEGACY_ENGINE_VERSION;

export const YOCO_V2_PROCESSING_STATUSES = [
  'RECEIVED',
  'QUEUED',
  'PROCESSING',
  'RETRY_SCHEDULED',
  'WAITING',
  'DEAD_LETTERED',
  'COMPLETED',
  'FAILED_PERMANENTLY',
  'MANUAL_REVIEW_REQUIRED'
] as const;

export type YocoV2ProcessingStatus = typeof YOCO_V2_PROCESSING_STATUSES[number];

export const YOCO_V2_ERROR_CATEGORIES = [
  'VALIDATION_ERROR',
  'AUTHENTICATION_ERROR',
  'RATE_LIMITED',
  'YOCO_TEMPORARY_ERROR',
  'NETWORK_ERROR',
  'DATABASE_ERROR',
  'CONFIGURATION_ERROR',
  'UNSUPPORTED_EVENT',
  'DUPLICATE_EVENT',
  'INTERNAL_ERROR'
] as const;

export type YocoV2ErrorCategory = typeof YOCO_V2_ERROR_CATEGORIES[number];

export const YOCO_V2_API_CLASSIFICATIONS = [
  'SUCCESS',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'RETRYABLE_SERVER_ERROR',
  'NON_RETRYABLE_CLIENT_ERROR',
  'TIMEOUT',
  'NETWORK_ERROR',
  'INVALID_RESPONSE'
] as const;

export type YocoV2ApiClassification = typeof YOCO_V2_API_CLASSIFICATIONS[number];
export type YocoV2CacheStatus = 'HIT' | 'MISS' | 'COALESCED' | 'BYPASS';

export const YOCO_V2_SALE_RESOLUTION_STATUSES = [
  'RESOLVED',
  'PARTIALLY_RESOLVED',
  'WAITING_FOR_YOCO',
  'LOCATION_MAPPING_MISSING',
  'ITEM_MAPPING_MISSING',
  'MODIFIER_MAPPING_MISSING',
  'UNSUPPORTED_ORDER_STATE',
  'MANUAL_REVIEW_REQUIRED'
] as const;

export type YocoV2SaleResolutionStatus = typeof YOCO_V2_SALE_RESOLUTION_STATUSES[number];

export const YOCO_V2_COMPARISON_STATUSES = [
  'MATCHED',
  'EXPECTED_DIFFERENCE',
  'LEGACY_ERROR',
  'V2_ERROR',
  'INSUFFICIENT_SOURCE_DATA',
  'MANUAL_REVIEW'
] as const;

export type YocoV2ComparisonStatus = typeof YOCO_V2_COMPARISON_STATUSES[number];

export interface YocoV2QueueMessage {
  raw_event_id: string;
  workspace_id: string;
  integration_id: string;
  event_type: string;
  trace_id: string;
  replay_reason?: string;
  force_refresh?: boolean;
  rerun_stage?: 'resolution' | 'proposal' | 'comparison' | 'all';
  live_effects?: boolean;
}

export interface YocoV2CaptureInput {
  workspaceId: string;
  integrationId?: string;
  rawBody: string;
  payload: Record<string, unknown>;
  headers: Headers;
  eventType?: string;
  yocoEventId?: string;
  signatureValid: boolean;
  receivedAt?: string;
  liveEffects?: boolean;
  replayReason?: string;
}

export interface YocoV2QueueDispatchResult {
  ok: boolean;
  action: 'ack' | 'retry';
  delaySeconds?: number;
  status?: YocoV2ProcessingStatus;
  error?: string;
}

export interface YocoV2RateGateRequest {
  integrationId: string;
  requestKey: string;
  traceId: string;
  method: string;
  url: string;
  apiKey: string;
  body?: string;
  timeoutMs: number;
  cacheTtlMs: number;
  forceRefresh: boolean;
  requestSpacingMs: number;
  authFailureThreshold: number;
  rateLimitPauseFallbackMs: number;
}

export interface YocoV2CircuitState {
  pausedUntil: string | null;
  pauseReason: string | null;
  interventionRequired: boolean;
  consecutiveAuthFailures: number;
  consecutiveRateLimits: number;
  updatedAt: string;
}

export interface YocoV2RateGateResponse {
  ok: boolean;
  classification: YocoV2ApiClassification;
  responseStatus: number;
  bodyText: string;
  responseHeaders: Record<string, string>;
  retryAfterSeconds: number;
  cacheStatus: YocoV2CacheStatus;
  durationMs: number;
  circuit: YocoV2CircuitState;
  errorCode?: string;
  errorMessage?: string;
}

export interface CanonicalSaleModifier {
  source_modifier_id: string;
  source_modifier_group_id?: string;
  source_name: string;
  quantity: number;
  gross_amount: number;
  mapping_status: 'MAPPED' | 'MISSING' | 'NOT_REQUIRED';
  mapped_modifier_id?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalSaleLine {
  source_line_id: string;
  source_product_id: string;
  source_variant_id?: string;
  source_name: string;
  quantity: number;
  unit_gross_amount: number;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
  tax_amount: number;
  modifiers: CanonicalSaleModifier[];
  mapping_status: 'MAPPED' | 'MISSING';
  mapped_menu_item_id?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalSaleCompletedEvent {
  event_id: string;
  event_type: 'sale.completed';
  source: 'yoco';
  source_version: string;
  workspace_id: string;
  integration_id: string;
  source_order_id: string;
  source_payment_id?: string;
  payment_method?: string;
  source_location_id?: string;
  kcp_location_id?: string;
  occurred_at: string;
  received_at: string;
  currency: string;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
  tax_amount: number;
  tip_amount: number;
  status: string;
  lines: CanonicalSaleLine[];
  metadata: Record<string, unknown>;
  schema_version: string;
  resolution_status: YocoV2SaleResolutionStatus;
}

export const YOCO_V2_REFUND_TYPES = [
  'FULL',
  'PARTIAL_LINE',
  'PARTIAL_QUANTITY',
  'AMOUNT_ONLY',
  'UNKNOWN'
] as const;
export type YocoV2RefundType = typeof YOCO_V2_REFUND_TYPES[number];

export const YOCO_V2_REFUND_WORKFLOW_STEPS = [
  'RECEIVED',
  'REFUND_RESOURCE_REQUESTED',
  'REFUND_RESOURCE_RESOLVED',
  'REFUND_ORDER_RESOLVED',
  'ORIGINAL_ORDER_RESOLVED',
  'RETURN_LINES_RESOLVED',
  'FINANCIALS_RESOLVED',
  'MAPPINGS_RESOLVED',
  'CANONICAL_EVENT_CREATED',
  'STOCK_PROPOSAL_CREATED',
  'REPORTING_PROPOSAL_CREATED',
  'RECONCILED',
  'COMPLETED',
  'WAITING_FOR_YOCO',
  'RETRY_SCHEDULED',
  'MANUAL_REVIEW_REQUIRED',
  'FAILED_PERMANENTLY'
] as const;
export type YocoV2RefundWorkflowStep = typeof YOCO_V2_REFUND_WORKFLOW_STEPS[number];

export type YocoV2RefundDimensionStatus =
  | 'PENDING'
  | 'RESOLVED'
  | 'PARTIALLY_RESOLVED'
  | 'WAITING_FOR_YOCO'
  | 'MAPPING_MISSING'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'NOT_APPLICABLE'
  | 'FAILED';

export interface CanonicalRefundLine {
  source_refund_line_id: string;
  source_original_line_id: string;
  source_product_id: string;
  source_name: string;
  quantity: number;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
  tax_amount: number;
  match_confidence: number;
  resolution_method: 'EXACT_SOURCE_LINE' | 'RETURN_RESOURCE' | 'MANUAL_ALLOCATION' | 'FULL_ORDER_REMAINDER';
  mapping_status: 'MAPPED' | 'MISSING';
  mapped_menu_item_id?: string;
  modifiers?: CanonicalSaleModifier[];
  metadata?: Record<string, unknown>;
}

export interface CanonicalSaleRefundedEvent {
  event_id: string;
  event_type: 'sale.refunded';
  schema_version: string;
  source: 'yoco';
  workspace_id: string;
  integration_id: string;
  refund_id: string;
  refund_order_id?: string;
  source_order_id: string;
  source_payment_id?: string;
  payment_method?: string;
  source_location_id?: string;
  kcp_location_id?: string;
  occurred_at: string;
  received_at: string;
  currency: string;
  refund_type: YocoV2RefundType;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
  tax_amount: number;
  tip_amount: number;
  financial_resolution_status: YocoV2RefundDimensionStatus;
  inventory_resolution_status: YocoV2RefundDimensionStatus;
  reporting_resolution_status: YocoV2RefundDimensionStatus;
  reconciliation_status: YocoV2RefundDimensionStatus;
  overall_status: YocoV2RefundWorkflowStep;
  lines: CanonicalRefundLine[];
  metadata: Record<string, unknown>;
}

export type YocoV2ManualReviewType =
  | 'REFUND_LINE_ALLOCATION'
  | 'LOCATION_MAPPING'
  | 'ITEM_MAPPING'
  | 'DUPLICATE_SOURCE_REFERENCE'
  | 'FINANCIAL_MISMATCH'
  | 'OTHER';

export type YocoV2ReconciliationFindingType =
  | 'MISSING_SALE_EVENT'
  | 'MISSING_REFUND_EVENT'
  | 'INCOMPLETE_WORKFLOW'
  | 'FINANCIAL_MISMATCH'
  | 'STOCK_PROPOSAL_MISMATCH'
  | 'UNRESOLVED_MAPPING'
  | 'LEGACY_ONLY_EFFECT'
  | 'V2_ONLY_SOURCE_ACTIVITY'
  | 'MANUAL_REVIEW_REQUIRED';
