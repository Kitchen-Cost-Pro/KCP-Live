import type { Env } from '../../legacy/types';
import { deriveYocoFinancialAmounts, yocoMoneyToMajor } from '../../../../src/modules/reporting/engine/yocoFinancials.js';
import type {
  CanonicalRefundLine,
  CanonicalSaleModifier,
  CanonicalSaleRefundedEvent,
  YocoV2RefundDimensionStatus,
  YocoV2RefundType,
  YocoV2RefundWorkflowStep
} from './contracts';
import {
  fetchYocoV2Order,
  fetchYocoV2Payment,
  fetchYocoV2Refund,
  listYocoV2Refunds,
  YocoV2ApiClientError,
  type YocoV2ApiClientEnv
} from './api-client';
import { appendTimeline, newId, nowIso, type Row } from './repository';
import { normalizeYocoV2EventType } from './sale-resolver';
import { resolveYocoStockLocation } from './location-routing';

const REFUND_SCHEMA_VERSION = '1.0.0';
const DAY_MS = 24 * 60 * 60_000;
const YOCO_REFUND_LIST_MAX_RANGE_MS = 31 * DAY_MS - 60_000;
const REFUND_LOOKUP_PAST_MS = 3 * DAY_MS;
const REFUND_LOOKUP_EVENT_FUTURE_MS = 60 * 60_000;
const REFUND_LOOKUP_CLOCK_SKEW_MS = 5 * 60_000;
const REFUND_LOOKUP_MAX_PAGES = 25;
const RETURN_LINE_KEYS = ['returned_line_items', 'returnedLineItems', 'return_lines', 'returnLines', 'line_items', 'lineItems', 'items'];
const ORDER_LINE_KEYS = ['line_items', 'lineItems', 'items', 'order_lines', 'orderLines'];
const MODIFIER_KEYS = ['modifiers', 'selected_modifiers', 'selectedModifiers', 'line_modifiers', 'lineModifiers', 'applied_modifiers', 'appliedModifiers'];

function objectValue(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function arrayValue(value: unknown): Row[] { return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as Row[] : []; }
function text(value: unknown, fallback = ''): string { return String(value ?? fallback).trim(); }
function numberValue(value: unknown, fallback = 0): number { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function money(value: unknown, scalarUnit: 'major' | 'minor' = 'major'): number {
  const amount = yocoMoneyToMajor(value, { scalarUnit, absolute: true });
  return Number.isFinite(amount) ? amount : 0;
}
function moneyEqual(left: number, right: number, tolerance = 0.02): boolean { return Math.abs(left - right) <= tolerance; }
function firstObject(...values: unknown[]): Row { return values.map(objectValue).find((row) => Object.keys(row).length > 0) || {}; }
function firstText(...values: unknown[]): string { return values.map((value) => text(value)).find(Boolean) || ''; }
function parseJson(value: unknown): Row { try { return objectValue(JSON.parse(text(value, '{}'))); } catch { return {}; } }

export function isSupportedRefundEvent(eventType: string): boolean {
  const normalized = normalizeYocoV2EventType(eventType);
  return normalized.startsWith('refund.') || normalized.startsWith('return.') || normalized === 'payment.refunded' || normalized === 'order.refunded' || normalized === 'order.updated';
}

function payloadParts(payload: Row) {
  const data = objectValue(payload.data);
  const envelope = objectValue(payload.payload);
  const envelopeData = objectValue(envelope.data);
  const eventType = normalizeYocoV2EventType(firstText(payload.event_type, payload.eventType, payload.type));
  const refund = firstObject(
    payload.refund, data.refund, envelope.refund, envelopeData.refund,
    eventType.startsWith('refund.') ? data : {},
    eventType.startsWith('refund.') ? envelope : {}
  );
  const order = firstObject(
    payload.order, data.order, envelope.order, envelopeData.order,
    eventType.startsWith('order.') ? data : {},
    eventType.startsWith('order.') ? envelope : {}
  );
  const payment = firstObject(
    payload.payment, data.payment, envelope.payment, envelopeData.payment,
    eventType.startsWith('payment.') ? data : {},
    eventType.startsWith('payment.') ? envelope : {}
  );
  const returnResource = firstObject(payload.return, data.return, envelope.return, envelopeData.return, payload.return_resource, data.return_resource);
  return { data, envelope, envelopeData, refund, order, payment, returnResource };
}

function refundReferences(payload: Row) {
  const { data, envelope, envelopeData, refund, order, payment, returnResource } = payloadParts(payload);
  const eventType = normalizeYocoV2EventType(firstText(payload.event_type, payload.eventType, payload.type));
  const topLevelOrderId = firstText(
    payload.order_id, payload.orderId, data.order_id, data.orderId,
    envelope.order_id, envelope.orderId, envelopeData.order_id, envelopeData.orderId
  );
  const explicitOriginalOrderId = firstText(
    refund.original_order_id, refund.originalOrderId, refund.source_order_id, refund.sourceOrderId,
    returnResource.original_order_id, returnResource.originalOrderId, returnResource.source_order_id, returnResource.sourceOrderId
  );
  const refundId = firstText(
    refund.id, refund.refund_id, refund.refundId,
    payload.refund_id, payload.refundId, data.refund_id, data.refundId,
    envelope.refund_id, envelope.refundId, envelopeData.refund_id, envelopeData.refundId,
    returnResource.refund_id, returnResource.refundId
  );
  const refundOrderId = firstText(
    refund.refund_order_id, refund.refundOrderId,
    order.refund_order_id, order.refundOrderId,
    returnResource.refund_order_id, returnResource.refundOrderId,
    eventType === 'payment.refunded' ? topLevelOrderId : '',
    explicitOriginalOrderId && refund.order_id && text(refund.order_id) !== explicitOriginalOrderId ? refund.order_id : '',
    explicitOriginalOrderId && refund.orderId && text(refund.orderId) !== explicitOriginalOrderId ? refund.orderId : '',
    order.id && /refund|return/i.test(text(order.type || order.order_type || order.orderType || order.status)) ? order.id : ''
  );
  const sourceOrderId = firstText(
    explicitOriginalOrderId,
    refund.parent_order_id, refund.parentOrderId,
    order.original_order_id, order.originalOrderId, order.source_order_id, order.sourceOrderId, order.parent_order_id, order.parentOrderId,
    payload.original_order_id, payload.originalOrderId, data.original_order_id, data.originalOrderId,
    eventType === 'payment.refunded' ? '' : topLevelOrderId,
    payment.order_id, payment.orderId, objectValue(payment.order).id,
    refund.order_id && text(refund.order_id) !== refundOrderId ? refund.order_id : '',
    refund.orderId && text(refund.orderId) !== refundOrderId ? refund.orderId : ''
  );
  const paymentId = firstText(
    refund.payment_id, refund.paymentId,
    payload.payment_id, payload.paymentId, data.payment_id, data.paymentId,
    envelope.payment_id, envelope.paymentId, envelopeData.payment_id, envelopeData.paymentId,
    payment.id, payment.payment_id, payment.paymentId,
    order.payment_id, order.paymentId, arrayValue(order.payments)[0]?.id
  );
  return { refundId, refundOrderId, sourceOrderId, paymentId, embeddedRefund: refund, embeddedOrder: order, embeddedPayment: payment, embeddedReturn: returnResource };
}

function originalOrderPaymentMethod(order: Row): string {
  const payments = arrayValue(order.payments);
  const selected = payments.find((row) => /approved|captured|closed|complete|completed|paid|settled|success|successful|succeeded/.test(text(row.status).toLowerCase()))
    || payments[0]
    || objectValue(order.payment);
  return firstText(
    selected.payment_method, selected.paymentMethod, selected.payment_type, selected.type,
    order.payment_method, order.paymentMethod, objectValue(order.payment).method
  );
}

function refundListRows(value: unknown): Row[] {
  if (Array.isArray(value)) return arrayValue(value);
  const root = objectValue(value);
  for (const key of ['data', 'results', 'items']) {
    const rows = arrayValue(root[key]);
    if (rows.length) return rows;
  }
  return [];
}

function refundListContinuationCursor(value: unknown): string {
  const root = objectValue(value);
  const data = objectValue(root.data);
  const meta = objectValue(root.meta || root.pagination || data.meta || data.pagination);
  const direct = firstText(
    root.next_cursor,
    root.nextCursor,
    root.next_page_token,
    root.nextPageToken,
    data.next_cursor,
    data.nextCursor,
    meta.next_cursor,
    meta.nextCursor,
    meta.next_page_token,
    meta.nextPageToken
  );
  if (direct) return direct;
  const links = objectValue(root.links || data.links || meta.links);
  const next = firstText(links.next, root.next, data.next);
  if (!next) return '';
  try {
    const url = new URL(next, 'https://api.yoco.com');
    return firstText(url.searchParams.get('cursor'), url.searchParams.get('page_token'), url.searchParams.get('pageToken'));
  } catch {
    return '';
  }
}

export function refundLookupUpdatedWindow(
  receivedAt: string,
  nowMs = Date.now()
): { updated_at__gte: string; updated_at__lte: string } {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const parsedReceivedAt = Date.parse(receivedAt);
  const receivedAtMs = Number.isFinite(parsedReceivedAt) ? parsedReceivedAt : safeNow;
  const upperBound = Math.max(
    receivedAtMs + REFUND_LOOKUP_EVENT_FUTURE_MS,
    safeNow + REFUND_LOOKUP_CLOCK_SKEW_MS
  );
  const lowerBound = Math.max(
    receivedAtMs - REFUND_LOOKUP_PAST_MS,
    upperBound - YOCO_REFUND_LIST_MAX_RANGE_MS
  );
  return {
    updated_at__gte: new Date(lowerBound).toISOString(),
    updated_at__lte: new Date(upperBound).toISOString()
  };
}

async function listRefundLookupRows(
  env: YocoV2ApiClientEnv,
  input: {
    workspaceId: string;
    integrationId: string;
    rawEventId: string;
    processingRunId: string;
    traceId: string;
    attempt: number;
    receivedAt: string;
    forceRefresh: boolean;
  }
): Promise<{ rows: Row[]; requestIds: string[] }> {
  const rows: Row[] = [];
  const requestIds: string[] = [];
  const seenRows = new Set<string>();
  const seenCursors = new Set<string>();
  const window = refundLookupUpdatedWindow(input.receivedAt);
  let cursor = '';

  for (let pageIndex = 0; pageIndex < REFUND_LOOKUP_MAX_PAGES; pageIndex += 1) {
    const listed = await listYocoV2Refunds<unknown>(env, {
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      rawEventId: input.rawEventId,
      processingRunId: input.processingRunId,
      traceId: input.traceId,
      attempt: input.attempt,
      params: {
        ...window,
        ...(cursor ? { cursor } : {}),
        status: ['approved'],
        limit: 100
      },
      forceRefresh: input.forceRefresh
    });
    requestIds.push(listed.requestId);

    for (const row of refundListRows(listed.data)) {
      const id = firstText(row.id, row.refund_id, row.refundId);
      const key = id ? `id:${id}` : `json:${JSON.stringify(row)}`;
      if (seenRows.has(key)) continue;
      seenRows.add(key);
      rows.push(row);
    }

    const nextCursor = refundListContinuationCursor(listed.data);
    if (!nextCursor) return { rows, requestIds };
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      throw new YocoV2ApiClientError({
        message: 'Yoco refund pagination returned the same cursor more than once.',
        status: 502,
        category: 'YOCO_TEMPORARY_ERROR',
        code: 'YOCO_V2_REFUND_PAGINATION_CURSOR_LOOP',
        retryable: true,
        retryAfterSeconds: 30,
        details: { cursor: nextCursor, pages_read: pageIndex + 1, api_request_ids: requestIds }
      });
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new YocoV2ApiClientError({
    message: `Yoco refund pagination exceeded the safe ${REFUND_LOOKUP_MAX_PAGES}-page boundary.`,
    status: 502,
    category: 'YOCO_TEMPORARY_ERROR',
    code: 'YOCO_V2_REFUND_PAGINATION_LIMIT',
    retryable: true,
    retryAfterSeconds: 60,
    details: { max_pages: REFUND_LOOKUP_MAX_PAGES, api_request_ids: requestIds }
  });
}

function refundResourceTimestamp(resource: Row): number {
  for (const value of [resource.processed_at, resource.processedAt, resource.updated_at, resource.updatedAt, resource.created_at, resource.createdAt]) {
    const parsed = Date.parse(text(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function selectRefundResource(resources: Row[], refs: ReturnType<typeof refundReferences>, receivedAt: string): Row | null {
  const candidates = resources.flatMap((resource) => {
    const id = firstText(resource.id, resource.refund_id, resource.refundId);
    if (!id) return [];
    const paymentId = firstText(resource.payment_id, resource.paymentId);
    const refundOrderId = firstText(resource.order_id, resource.orderId, resource.refund_order_id, resource.refundOrderId);
    const originalOrderId = firstText(resource.original_order_id, resource.originalOrderId, resource.source_order_id, resource.sourceOrderId);
    let score = 0;

    if (refs.paymentId && paymentId) {
      if (paymentId !== refs.paymentId) return [];
      score += 100;
    }

    if (refs.refundOrderId && refundOrderId === refs.refundOrderId) score += 60;
    if (refs.sourceOrderId && originalOrderId === refs.sourceOrderId) score += 40;
    if (!score) return [];

    const at = refundResourceTimestamp(resource);
    const target = Date.parse(receivedAt);
    const distance = Number.isFinite(target) && Number.isFinite(at)
      ? Math.abs(at - target)
      : Number.POSITIVE_INFINITY;
    return [{ resource, score, distance }];
  });
  if (!candidates.length) return null;
  const ranked = candidates.sort((left, right) => right.score - left.score || left.distance - right.distance || text(left.resource.id).localeCompare(text(right.resource.id)));
  if (ranked.length > 1 && ranked[0].score === ranked[1].score && ranked[0].distance === ranked[1].distance) return null;
  return ranked[0].resource;
}


function refundOrderOriginalOrderId(refundOrder: Row): string {
  const direct = firstText(
    refundOrder.original_order_id,
    refundOrder.originalOrderId,
    refundOrder.source_order_id,
    refundOrder.sourceOrderId,
    refundOrder.parent_order_id,
    refundOrder.parentOrderId
  );
  if (direct) return direct;
  for (const returned of arrayValue(refundOrder.returns)) {
    const sourceOrderId = firstText(
      returned.source_order_id,
      returned.sourceOrderId,
      returned.original_order_id,
      returned.originalOrderId,
      returned.parent_order_id,
      returned.parentOrderId
    );
    if (sourceOrderId) return sourceOrderId;
  }
  for (const refund of arrayValue(refundOrder.refunds)) {
    const sourceOrderId = firstText(refund.original_order_id, refund.originalOrderId);
    if (sourceOrderId) return sourceOrderId;
  }
  return '';
}

function refundOrderAmount(refundOrder: Row): unknown {
  const amounts = objectValue(refundOrder.amounts);
  const direct = [
    refundOrder.total_amount,
    refundOrder.totalAmount,
    refundOrder.refund_amount,
    refundOrder.refundAmount,
    refundOrder.total_price,
    refundOrder.totalPrice,
    refundOrder.net_amount,
    refundOrder.netAmount,
    amounts.net_amount,
    amounts.netAmount,
    amounts.total_amount,
    amounts.totalAmount
  ].find((value) => value !== undefined && value !== null && text(value) !== '');
  if (direct !== undefined) return direct;
  for (const returned of arrayValue(refundOrder.returns)) {
    const returnAmounts = objectValue(returned.amounts);
    const nested = [
      returned.total_amount,
      returned.totalAmount,
      returned.refund_amount,
      returned.refundAmount,
      returned.total_price,
      returned.totalPrice,
      returned.net_amount,
      returned.netAmount,
      returnAmounts.net_amount,
      returnAmounts.netAmount,
      returnAmounts.total_amount,
      returnAmounts.totalAmount
    ].find((value) => value !== undefined && value !== null && text(value) !== '');
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function refundOrderIsFinal(refundOrder: Row): boolean {
  const status = firstText(
    refundOrder.status,
    refundOrder.order_status,
    refundOrder.orderStatus,
    refundOrder.payment_status,
    refundOrder.paymentStatus
  ).toLowerCase();
  if (status) return ['approved', 'closed', 'complete', 'completed', 'refunded', 'succeeded', 'successful', 'success'].includes(status);
  return Boolean(firstText(
    refundOrder.closed_at,
    refundOrder.closedAt,
    refundOrder.completed_at,
    refundOrder.completedAt,
    refundOrder.refunded_at,
    refundOrder.refundedAt
  ));
}

function syntheticRefundFromRefundOrder(
  refundOrder: Row,
  refs: ReturnType<typeof refundReferences>
): Row | null {
  if (!Object.keys(refundOrder).length || !refundOrderIsFinal(refundOrder)) return null;
  const refundOrderId = firstText(refs.refundOrderId, refundOrder.id, refundOrder.order_id, refundOrder.orderId);
  const sourceOrderId = firstText(refs.sourceOrderId, refundOrderOriginalOrderId(refundOrder));
  if (!refundOrderId || !sourceOrderId || refundOrderId === sourceOrderId) return null;
  const paymentId = firstText(
    refs.paymentId,
    refundOrder.payment_id,
    refundOrder.paymentId,
    arrayValue(refundOrder.payments)[0]?.id,
    arrayValue(refundOrder.payments)[0]?.payment_id,
    arrayValue(refundOrder.payments)[0]?.paymentId
  );
  const returnedEntries = arrayValue(refundOrder.returns);
  const returnedLines = returnedEntries.flatMap((entry) => resourceLines(entry));
  const amount = refundOrderAmount(refundOrder);
  if (!returnedLines.length && amount === undefined) return null;
  const firstReturn = returnedEntries[0] || {};
  return {
    id: refundOrderId,
    refund_id: refundOrderId,
    refund_order_id: refundOrderId,
    original_order_id: sourceOrderId,
    ...(paymentId ? { payment_id: paymentId } : {}),
    status: 'approved',
    ...(amount !== undefined ? { total_amount: amount } : {}),
    ...(returnedLines.length ? { returned_line_items: returnedLines } : {}),
    processed_at: firstText(
      refundOrder.closed_at,
      refundOrder.closedAt,
      refundOrder.completed_at,
      refundOrder.completedAt,
      refundOrder.updated_at,
      refundOrder.updatedAt,
      refundOrder.created_at,
      refundOrder.createdAt
    ) || undefined,
    reason: firstText(firstReturn.reason, firstReturn.return_reason, firstReturn.returnReason, refundOrder.reason) || undefined,
    note: firstText(firstReturn.note, firstReturn.return_note, firstReturn.returnNote, refundOrder.note) || undefined,
    metadata: { kcp_synthetic_from_refund_order: true }
  };
}

function resourceLines(resource: Row): Row[] {
  for (const key of RETURN_LINE_KEYS) {
    const lines = arrayValue(resource[key]);
    if (lines.length) return lines;
  }
  for (const nested of arrayValue(resource.returns)) {
    const lines = resourceLines(nested);
    if (lines.length) return lines;
  }
  return [];
}
function orderLines(order: Row): Row[] {
  for (const key of ORDER_LINE_KEYS) {
    const lines = arrayValue(order[key]);
    if (lines.length) return lines;
  }
  return [];
}
function sourceLineId(line: Row, index: number): string { return firstText(line.id, line.line_item_id, line.lineItemId, line.order_line_id, line.orderLineId, line.uuid, `line_${index}`); }
function originalLineReference(line: Row): string {
  return firstText(
    line.original_line_id, line.originalLineId, line.source_line_id, line.sourceLineId,
    line.order_line_id, line.orderLineId, line.original_order_line_id, line.originalOrderLineId,
    objectValue(line.original_line).id, objectValue(line.source_line).id
  );
}
function sourceProductId(line: Row): string {
  return firstText(line.product_id, line.productId, line.item_id, line.itemId, objectValue(line.product).id, objectValue(line.item).id);
}
function sourceVariantId(line: Row): string {
  return firstText(line.variant_id, line.variantId, line.product_variant_id, line.productVariantId, objectValue(line.variant).id);
}
function lineName(line: Row): string { return firstText(line.name, line.product_name, line.productName, line.item_name, line.itemName, objectValue(line.product).name, objectValue(line.item).name, 'Yoco Item'); }
function lineQuantity(line: Row): number { return Math.abs(numberValue(line.quantity ?? line.qty ?? line.count, 1)); }
function lineAmounts(line: Row) {
  const amounts = objectValue(line.amounts);
  const quantity = Math.max(0.000001, lineQuantity(line));
  const gross = money(line.total_price || line.totalPrice || line.total_amount || line.totalAmount || line.amount || amounts.gross_amount || amounts.net_amount);
  const unitGross = money(line.unit_price || line.unitPrice || line.price) || gross / quantity;
  const discount = money(line.discount_amount || line.discountAmount || amounts.discount_amount || amounts.discountAmount);
  const tax = money(line.tax_amount || line.taxAmount || amounts.tax_amount || amounts.taxAmount);
  const net = money(line.net_amount || line.netAmount || amounts.net_amount || amounts.netAmount) || Math.max(0, gross - tax);
  return { gross, unitGross, discount, tax, net };
}
function modifierRows(line: Row): Row[] {
  const rows: Row[] = [];
  for (const key of MODIFIER_KEYS) rows.push(...arrayValue(line[key]));
  return rows;
}

async function mapLocation(env: Env, workspaceId: string, sourceLocationId: string): Promise<string> {
  return resolveYocoStockLocation(env, workspaceId, sourceLocationId);
}
async function mapProduct(env: Env, workspaceId: string, productId: string, variantId: string): Promise<string> {
  if (!productId && !variantId) return '';
  const row = await env.DB.prepare(
    `SELECT id FROM products WHERE workspace_id = ?1 AND active = 1
      AND lower(COALESCE(external_provider, 'yoco')) = 'yoco'
      AND ((?3 <> '' AND yoco_variant_id = ?3) OR (?2 <> '' AND yoco_item_id = ?2 AND (COALESCE(yoco_variant_id, '') = '' OR ?3 = '')))
      ORDER BY CASE WHEN yoco_variant_id = ?3 AND ?3 <> '' THEN 0 ELSE 1 END LIMIT 1`
  ).bind(workspaceId, productId, variantId).first<Row>();
  return text(row?.id);
}
async function mapModifier(env: Env, workspaceId: string, modifier: Row): Promise<string> {
  const candidates = [modifier.modifier_id, modifier.modifierId, modifier.id, modifier.variant_id, modifier.variantId, modifier.product_id, modifier.productId]
    .map((value) => text(value)).filter(Boolean);
  if (!candidates.length) return '';
  const placeholders = candidates.map((_, index) => `?${index + 2}`).join(', ');
  const row = await env.DB.prepare(
    `SELECT owner_id FROM recipes WHERE workspace_id = ?1 AND active = 1 AND owner_type = 'yoco_modifier'
      AND owner_id IN (${placeholders}) LIMIT 1`
  ).bind(workspaceId, ...candidates).first<Row>();
  return text(row?.owner_id);
}

async function canonicalModifiers(env: Env, workspaceId: string, originalLine: Row): Promise<CanonicalSaleModifier[]> {
  const result: CanonicalSaleModifier[] = [];
  for (const [index, modifier] of modifierRows(originalLine).entries()) {
    const mapped = await mapModifier(env, workspaceId, modifier);
    result.push({
      source_modifier_id: firstText(modifier.modifier_id, modifier.modifierId, modifier.id, modifier.variant_id, modifier.variantId, `${sourceLineId(originalLine, 0)}:modifier:${index}`),
      source_modifier_group_id: firstText(modifier.group_id, modifier.groupId, modifier.modifier_group_id, modifier.modifierGroupId) || undefined,
      source_name: firstText(modifier.name, modifier.product_name, modifier.productName, 'Yoco Modifier'),
      quantity: Math.max(1, lineQuantity(modifier)),
      gross_amount: lineAmounts(modifier).gross,
      mapping_status: mapped ? 'MAPPED' : 'MISSING',
      mapped_modifier_id: mapped || undefined,
      metadata: { source: modifier }
    });
  }
  return result;
}

function orderLocationId(order: Row): string { return firstText(order.location_id, order.locationId, objectValue(order.location).id); }
function orderPaymentId(order: Row): string { return firstText(order.payment_id, order.paymentId, arrayValue(order.payments)[0]?.id, objectValue(order.payment).id); }
function refundOccurredAt(refund: Row, refundOrder: Row, receivedAt: string): string {
  return firstText(
    refund.processed_at, refund.processedAt, refund.completed_at, refund.completedAt, refund.closed_at, refund.closedAt,
    refundOrder.completed_at, refundOrder.completedAt, refundOrder.closed_at, refundOrder.closedAt,
    refund.updated_at, refund.updatedAt, refund.created_at, refund.createdAt, receivedAt
  );
}

async function workspaceVatRate(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT vat_rate FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`).bind(workspaceId).first<Row>();
  const vat = numberValue(row?.vat_rate, 15);
  return vat > 0 ? vat : 15;
}

async function previousRefundedQuantities(env: Env, workspaceId: string, sourceOrderId: string, currentRefundId: string): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT payload_json FROM yoco_v2_domain_events
      WHERE workspace_id = ?1 AND event_type = 'sale.refunded' AND source_entity_id <> ?2`
  ).bind(workspaceId, currentRefundId).all<Row>();
  const totals = new Map<string, number>();
  for (const row of rows.results || []) {
    const event = parseJson(row.payload_json) as unknown as CanonicalSaleRefundedEvent;
    if (text(event.source_order_id) !== sourceOrderId) continue;
    for (const line of Array.isArray(event.lines) ? event.lines : []) {
      const key = text(line.source_original_line_id);
      if (key) totals.set(key, (totals.get(key) || 0) + Math.abs(numberValue(line.quantity)));
    }
  }
  return totals;
}

function originalLineMap(lines: Row[]) {
  const byId = new Map<string, Row>();
  const byProduct = new Map<string, Row[]>();
  const byVariant = new Map<string, Row[]>();
  lines.forEach((line, index) => {
    const id = sourceLineId(line, index);
    byId.set(id, line);
    const product = sourceProductId(line);
    if (product) byProduct.set(product, [...(byProduct.get(product) || []), line]);
    const variant = sourceVariantId(line);
    if (variant) byVariant.set(variant, [...(byVariant.get(variant) || []), line]);
  });
  return { byId, byProduct, byVariant };
}

async function canonicalRefundLine(env: Env, workspaceId: string, originalLine: Row, originalIndex: number, returnedLine: Row, returnedIndex: number, quantity: number, method: CanonicalRefundLine['resolution_method'], confidence: number): Promise<CanonicalRefundLine> {
  const originalAmounts = lineAmounts(originalLine);
  const originalQty = Math.max(0.000001, lineQuantity(originalLine));
  const ratio = Math.max(0, quantity) / originalQty;
  const returnedAmounts = lineAmounts(returnedLine);
  const productId = sourceProductId(originalLine) || sourceProductId(returnedLine);
  const variantId = sourceVariantId(originalLine) || sourceVariantId(returnedLine);
  const mapped = await mapProduct(env, workspaceId, productId, variantId);
  return {
    source_refund_line_id: sourceLineId(returnedLine, returnedIndex),
    source_original_line_id: sourceLineId(originalLine, originalIndex),
    source_product_id: productId,
    source_name: lineName(originalLine),
    quantity,
    gross_amount: returnedAmounts.gross || originalAmounts.gross * ratio,
    discount_amount: returnedAmounts.discount || originalAmounts.discount * ratio,
    net_amount: returnedAmounts.net || originalAmounts.net * ratio,
    tax_amount: returnedAmounts.tax || originalAmounts.tax * ratio,
    match_confidence: confidence,
    resolution_method: method,
    mapping_status: mapped ? 'MAPPED' : 'MISSING',
    mapped_menu_item_id: mapped || undefined,
    modifiers: await canonicalModifiers(env, workspaceId, originalLine),
    metadata: { original_line: originalLine, returned_line: returnedLine, source_variant_id: variantId || undefined }
  };
}

export async function openRefundManualReview(env: Env, input: {
  workspaceId: string;
  integrationId: string;
  domainEventId: string;
  reasonCode: string;
  reasonMessage: string;
  originalLines: Row[];
  financials: Record<string, unknown>;
}): Promise<Row> {
  const now = nowIso();
  const existing = await env.DB.prepare(
    `SELECT * FROM yoco_v2_manual_reviews WHERE workspace_id = ?1 AND domain_event_id = ?2
      AND review_type = 'REFUND_LINE_ALLOCATION' AND reason_code = ?3 LIMIT 1`
  ).bind(input.workspaceId, input.domainEventId, input.reasonCode).first<Row>();
  const id = text(existing?.id) || newId('yoco_v2_manual_review');
  await env.DB.prepare(
    `INSERT INTO yoco_v2_manual_reviews
      (id, workspace_id, integration_id, domain_event_id, review_type, status, reason_code,
       reason_message, available_source_lines_json, refund_financials_json,
       proposed_allocation_json, resolved_allocation_json, audit_history_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'REFUND_LINE_ALLOCATION', 'OPEN', ?5, ?6, ?7, ?8, '[]', '[]', '[]', ?9, ?9)
     ON CONFLICT(workspace_id, domain_event_id, review_type, reason_code) DO UPDATE SET
       reason_message = excluded.reason_message,
       available_source_lines_json = excluded.available_source_lines_json,
       refund_financials_json = excluded.refund_financials_json,
       updated_at = excluded.updated_at`
  ).bind(id, input.workspaceId, input.integrationId, input.domainEventId, input.reasonCode, input.reasonMessage, JSON.stringify(input.originalLines), JSON.stringify(input.financials), now).run();
  return (await env.DB.prepare(`SELECT * FROM yoco_v2_manual_reviews WHERE id = ?1`).bind(id).first<Row>()) || { id };
}

async function resolvedManualAllocation(env: Env, workspaceId: string, domainEventId: string): Promise<Row[]> {
  const row = await env.DB.prepare(
    `SELECT resolved_allocation_json FROM yoco_v2_manual_reviews
      WHERE workspace_id = ?1 AND domain_event_id = ?2 AND review_type = 'REFUND_LINE_ALLOCATION' AND status = 'RESOLVED'
      ORDER BY resolved_at DESC LIMIT 1`
  ).bind(workspaceId, domainEventId).first<Row>();
  if (!row) return [];
  try { return arrayValue(JSON.parse(text(row.resolved_allocation_json, '[]'))); } catch { return []; }
}

async function updateWorkflow(env: Env, input: {
  workflowId: string;
  workspaceId: string;
  integrationId: string;
  rawEventId: string;
  domainEventId?: string;
  refundId: string;
  sourceOrderId?: string;
  step: YocoV2RefundWorkflowStep;
  financialStatus: YocoV2RefundDimensionStatus;
  inventoryStatus: YocoV2RefundDimensionStatus;
  reportingStatus: YocoV2RefundDimensionStatus;
  reconciliationStatus: YocoV2RefundDimensionStatus;
  overallStatus: YocoV2RefundWorkflowStep;
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_refund_workflows
      (id, workspace_id, integration_id, raw_event_id, domain_event_id, refund_id, source_order_id,
       current_step, financial_status, inventory_status, reporting_status, reconciliation_status,
       overall_status, last_error_code, last_error_message, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, NULLIF(?5, ''), ?6, NULLIF(?7, ''), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
     ON CONFLICT(workspace_id, integration_id, refund_id) DO UPDATE SET
       raw_event_id = excluded.raw_event_id,
       domain_event_id = COALESCE(excluded.domain_event_id, yoco_v2_refund_workflows.domain_event_id),
       source_order_id = COALESCE(excluded.source_order_id, yoco_v2_refund_workflows.source_order_id),
       current_step = excluded.current_step,
       financial_status = excluded.financial_status,
       inventory_status = excluded.inventory_status,
       reporting_status = excluded.reporting_status,
       reconciliation_status = excluded.reconciliation_status,
       overall_status = excluded.overall_status,
       last_error_code = excluded.last_error_code,
       last_error_message = excluded.last_error_message,
       updated_at = excluded.updated_at`
  ).bind(
    input.workflowId, input.workspaceId, input.integrationId, input.rawEventId, input.domainEventId || '', input.refundId,
    input.sourceOrderId || '', input.step, input.financialStatus, input.inventoryStatus, input.reportingStatus,
    input.reconciliationStatus, input.overallStatus, input.errorCode || null, input.errorMessage || null, now
  ).run();
}

async function upsertCanonicalRefundDomainEvent(env: Env, input: {
  eventId: string;
  workspaceId: string;
  integrationId: string;
  rawEventId: string;
  processingRunId: string;
  refundId: string;
  occurredAt: string;
  canonical: CanonicalSaleRefundedEvent;
}): Promise<Row> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_domain_events
      (id, workspace_id, integration_id, raw_event_id, processing_run_id, event_key, event_type,
       schema_version, source_entity_id, occurred_at, payload_json, resolution_status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sale.refunded', ?7, ?8, ?9, ?10, ?11, ?12, ?12)
     ON CONFLICT(workspace_id, integration_id, event_key) DO UPDATE SET
       processing_run_id = excluded.processing_run_id,
       occurred_at = excluded.occurred_at,
       payload_json = excluded.payload_json,
       resolution_status = excluded.resolution_status,
       updated_at = excluded.updated_at`
  ).bind(
    input.eventId, input.workspaceId, input.integrationId, input.rawEventId, input.processingRunId,
    `refund:${input.refundId}`, REFUND_SCHEMA_VERSION, input.refundId, input.occurredAt,
    JSON.stringify(input.canonical), input.canonical.overall_status, now
  ).run();
  const row = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND integration_id = ?2 AND event_key = ?3 LIMIT 1`)
    .bind(input.workspaceId, input.integrationId, `refund:${input.refundId}`).first<Row>();
  if (!row) throw new Error('Canonical refund domain event could not be stored.');
  return row;
}

export interface ResolveCanonicalRefundInput {
  rawEvent: Row;
  processingRun: Row;
  forceRefresh?: boolean;
}

export async function resolveCanonicalYocoRefund(env: YocoV2ApiClientEnv, input: ResolveCanonicalRefundInput): Promise<{ domainEvent: Row; canonical: CanonicalSaleRefundedEvent; workflow: Row }> {
  const rawEventId = text(input.rawEvent.id);
  const processingRunId = text(input.processingRun.id);
  const workspaceId = text(input.rawEvent.workspace_id);
  const integrationId = text(input.rawEvent.integration_id);
  const traceId = text(input.rawEvent.trace_id);
  const receivedAt = text(input.rawEvent.received_at, nowIso());
  const eventType = normalizeYocoV2EventType(input.rawEvent.event_type);
  const payload = parseJson(input.rawEvent.payload_json);
  if (!isSupportedRefundEvent(eventType)) throw new Error(`Unsupported event for canonical refund resolution: ${eventType}`);

  let refs = refundReferences(payload);
  let discoveredRefund: Row = {};
  let refundDiscoveryAttempted = false;
  let refundOrder = refs.embeddedOrder;
  let payment = refs.embeddedPayment;
  const apiRequestIds: string[] = [];

  // A payment.refunded webhook does not carry the canonical refund resource id.
  // Hydrate the refund-order and payment resources first because they can expose
  // the original order, returned lines, amount and embedded refunds before the
  // /v1/refunds list reaches eventual consistency.
  if (!refs.refundId && eventType === 'payment.refunded' && (refs.paymentId || refs.refundOrderId || refs.sourceOrderId)) {
    refundDiscoveryAttempted = true;

    if (refs.refundOrderId && !Object.keys(refundOrder).length) {
      const fetchedOrder = await fetchYocoV2Order<Row>(env, {
        workspaceId,
        integrationId,
        rawEventId,
        processingRunId,
        traceId,
        attempt: numberValue(input.processingRun.attempt_number, 1),
        orderId: refs.refundOrderId,
        forceRefresh: input.forceRefresh ?? true
      });
      apiRequestIds.push(fetchedOrder.requestId);
      if (fetchedOrder.found && fetchedOrder.data) refundOrder = fetchedOrder.data;
    }

    if (refs.paymentId && !Object.keys(payment).length) {
      const fetchedPayment = await fetchYocoV2Payment<Row>(env, {
        workspaceId,
        integrationId,
        rawEventId,
        processingRunId,
        traceId,
        attempt: numberValue(input.processingRun.attempt_number, 1),
        paymentId: refs.paymentId,
        forceRefresh: input.forceRefresh ?? true
      });
      apiRequestIds.push(fetchedPayment.requestId);
      if (fetchedPayment.found && fetchedPayment.data) payment = fetchedPayment.data;
    }

    refs = { ...refs, ...refundReferences({ ...payload, order: refundOrder, payment }) };
    const embeddedCandidate = selectRefundResource(
      [...arrayValue(payment.refunds), ...arrayValue(refundOrder.refunds)],
      refs,
      receivedAt
    );
    if (embeddedCandidate) {
      discoveredRefund = embeddedCandidate;
      refs = { ...refs, ...refundReferences({ refund: embeddedCandidate, order: refundOrder, payment }) };
    }

    if (!refs.refundId) {
      const listed = await listRefundLookupRows(env, {
        workspaceId,
        integrationId,
        rawEventId,
        processingRunId,
        traceId,
        attempt: numberValue(input.processingRun.attempt_number, 1),
        receivedAt,
        forceRefresh: input.forceRefresh ?? true
      });
      apiRequestIds.push(...listed.requestIds);
      const listedCandidate = selectRefundResource(listed.rows, refs, receivedAt);
      if (listedCandidate) {
        discoveredRefund = listedCandidate;
        refs = { ...refs, ...refundReferences({ refund: listedCandidate, order: refundOrder, payment }) };
      }
    }

    if (!refs.refundId) {
      const synthetic = syntheticRefundFromRefundOrder(refundOrder, refs);
      if (synthetic) {
        discoveredRefund = synthetic;
        refs = { ...refs, ...refundReferences({ refund: synthetic, order: refundOrder, payment }) };
      }
    }
  }

  const provisionalRefundIdentity = text(input.rawEvent.yoco_event_id) || text(input.rawEvent.event_key) || rawEventId;
  const refundIdentity = refs.refundId || refs.refundOrderId || provisionalRefundIdentity;
  const existingByIdentity = await env.DB.prepare(
    `SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND integration_id = ?2 AND event_key = ?3 LIMIT 1`
  ).bind(workspaceId, integrationId, `refund:${refundIdentity}`).first<Row>();
  const existingByRaw = await env.DB.prepare(
    `SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND integration_id = ?2 AND raw_event_id = ?3 AND event_type = 'sale.refunded' ORDER BY created_at LIMIT 1`
  ).bind(workspaceId, integrationId, rawEventId).first<Row>();

  let existingDomain = existingByIdentity || existingByRaw;
  if (existingByIdentity && existingByRaw && text(existingByIdentity.id) !== text(existingByRaw.id)) {
    await env.DB.prepare(
      `UPDATE yoco_v2_domain_events SET resolution_status = 'SUPERSEDED', updated_at = ?2 WHERE id = ?1`
    ).bind(text(existingByRaw.id), nowIso()).run();
    existingDomain = existingByIdentity;
  } else if (!existingByIdentity && existingByRaw && text(existingByRaw.source_entity_id) !== refundIdentity) {
    await env.DB.prepare(
      `UPDATE yoco_v2_domain_events SET event_key = ?2, source_entity_id = ?3, updated_at = ?4 WHERE id = ?1`
    ).bind(text(existingByRaw.id), `refund:${refundIdentity}`, refundIdentity, nowIso()).run();
    existingDomain = { ...existingByRaw, event_key: `refund:${refundIdentity}`, source_entity_id: refundIdentity };
  }

  const eventId = text(existingDomain?.id) || newId('yoco_v2_refund_domain');
  const workflowByIdentity = await env.DB.prepare(
    `SELECT * FROM yoco_v2_refund_workflows WHERE workspace_id = ?1 AND integration_id = ?2 AND refund_id = ?3 LIMIT 1`
  ).bind(workspaceId, integrationId, refundIdentity).first<Row>();
  const workflowByDomain = existingDomain ? await env.DB.prepare(
    `SELECT * FROM yoco_v2_refund_workflows WHERE workspace_id = ?1 AND integration_id = ?2 AND domain_event_id = ?3 LIMIT 1`
  ).bind(workspaceId, integrationId, eventId).first<Row>() : null;
  const workflowExisting = workflowByIdentity || workflowByDomain;
  if (workflowExisting && text(workflowExisting.refund_id) !== refundIdentity) {
    await env.DB.prepare(
      `UPDATE yoco_v2_refund_workflows SET refund_id = ?2, source_order_id = NULLIF(?3, ''), updated_at = ?4 WHERE id = ?1`
    ).bind(text(workflowExisting.id), refundIdentity, refs.sourceOrderId, nowIso()).run();
  }
  const workflowId = text(workflowExisting?.id) || newId('yoco_v2_refund_workflow');

  let financialStatus: YocoV2RefundDimensionStatus = 'PENDING';
  let inventoryStatus: YocoV2RefundDimensionStatus = 'PENDING';
  let reportingStatus: YocoV2RefundDimensionStatus = 'PENDING';
  let reconciliationStatus: YocoV2RefundDimensionStatus = 'PENDING';
  let currentStep: YocoV2RefundWorkflowStep = 'RECEIVED';

  const markStep = async (step: YocoV2RefundWorkflowStep, message: string, metadata: Record<string, unknown> = {}) => {
    currentStep = step;
    await updateWorkflow(env, {
      workflowId, workspaceId, integrationId, rawEventId, domainEventId: eventId, refundId: refundIdentity,
      sourceOrderId: refs.sourceOrderId, step, financialStatus, inventoryStatus, reportingStatus,
      reconciliationStatus, overallStatus: step
    });
    await appendTimeline(env.DB, { rawEventId, processingRunId, step, status: step, message, metadata: { refund_id: refundIdentity, ...metadata } });
  };

  await markStep('RECEIVED', 'Refund event entered the canonical V2 refund state machine.', { event_type: eventType });

  let refund = { ...refs.embeddedRefund, ...discoveredRefund };
  let originalOrder: Row = {};

  if (refundDiscoveryAttempted && !refs.refundId) {
    financialStatus = 'WAITING_FOR_YOCO';
    inventoryStatus = 'WAITING_FOR_YOCO';
    reportingStatus = 'WAITING_FOR_YOCO';
    await markStep('WAITING_FOR_YOCO', 'The payment.refunded webhook was valid, but the matching refund resource is not visible in Yoco yet.', {
      source_order_id: refs.sourceOrderId || null,
      payment_id: refs.paymentId || null,
      api_request_ids: apiRequestIds
    });
    const waiting: CanonicalSaleRefundedEvent = {
      event_id: eventId,
      event_type: 'sale.refunded',
      schema_version: REFUND_SCHEMA_VERSION,
      source: 'yoco',
      workspace_id: workspaceId,
      integration_id: integrationId,
      refund_id: refundIdentity,
      source_order_id: refs.sourceOrderId,
      source_payment_id: refs.paymentId || undefined,
      occurred_at: receivedAt,
      received_at: receivedAt,
      currency: 'ZAR',
      refund_type: 'UNKNOWN',
      gross_amount: 0,
      discount_amount: 0,
      net_amount: 0,
      tax_amount: 0,
      tip_amount: 0,
      financial_resolution_status: financialStatus,
      inventory_resolution_status: inventoryStatus,
      reporting_resolution_status: reportingStatus,
      reconciliation_status: reconciliationStatus,
      overall_status: 'WAITING_FOR_YOCO',
      lines: [],
      metadata: { raw_event_type: eventType, source_payload: payload, api_request_ids: apiRequestIds, refund_lookup: 'payment_and_order' }
    };
    await upsertCanonicalRefundDomainEvent(env, {
      eventId,
      workspaceId,
      integrationId,
      rawEventId,
      processingRunId,
      refundId: refundIdentity,
      occurredAt: receivedAt,
      canonical: waiting
    });
    throw new YocoV2ApiClientError({
      message: 'The Yoco refund resource is not visible yet for the refunded payment.',
      status: 404,
      category: 'YOCO_TEMPORARY_ERROR',
      code: 'YOCO_V2_REFUND_LOOKUP_WAITING',
      retryable: true,
      retryAfterSeconds: 15,
      details: { source_order_id: refs.sourceOrderId, payment_id: refs.paymentId, api_request_ids: apiRequestIds }
    });
  }

  if (refs.refundId && (!Object.keys(refund).length || input.forceRefresh)) {
    await markStep('REFUND_RESOURCE_REQUESTED', 'Refund resource requested through the per-integration rate gate.');
    const fetched = await fetchYocoV2Refund<Row>(env, {
      workspaceId, integrationId, rawEventId, processingRunId, traceId,
      attempt: numberValue(input.processingRun.attempt_number, 1), refundId: refs.refundId, forceRefresh: input.forceRefresh
    });
    apiRequestIds.push(fetched.requestId);
    if (!fetched.found || !fetched.data) {
      financialStatus = 'WAITING_FOR_YOCO'; inventoryStatus = 'WAITING_FOR_YOCO'; reportingStatus = 'WAITING_FOR_YOCO';
      await markStep('WAITING_FOR_YOCO', 'Yoco has not exposed the refund resource yet; retry remains safe and idempotent.', { api_request_id: fetched.requestId });
      const waiting: CanonicalSaleRefundedEvent = {
        event_id: eventId, event_type: 'sale.refunded', schema_version: REFUND_SCHEMA_VERSION, source: 'yoco',
        workspace_id: workspaceId, integration_id: integrationId, refund_id: refundIdentity,
        refund_order_id: refs.refundOrderId || undefined, source_order_id: refs.sourceOrderId,
        source_payment_id: refs.paymentId || undefined, occurred_at: receivedAt, received_at: receivedAt,
        currency: 'ZAR', refund_type: 'UNKNOWN', gross_amount: 0, discount_amount: 0, net_amount: 0,
        tax_amount: 0, tip_amount: 0, financial_resolution_status: financialStatus,
        inventory_resolution_status: inventoryStatus, reporting_resolution_status: reportingStatus,
        reconciliation_status: reconciliationStatus, overall_status: 'WAITING_FOR_YOCO', lines: [],
        metadata: { raw_event_type: eventType, source_payload: payload, api_request_ids: apiRequestIds }
      };
      await upsertCanonicalRefundDomainEvent(env, { eventId, workspaceId, integrationId, rawEventId, processingRunId, refundId: refundIdentity, occurredAt: receivedAt, canonical: waiting });
      throw new YocoV2ApiClientError({ message: 'Yoco refund resource is not available yet.', status: 404, category: 'YOCO_TEMPORARY_ERROR', code: 'YOCO_V2_REFUND_NOT_AVAILABLE_YET', retryable: true, retryAfterSeconds: Math.max(10, fetched.retryAfterSeconds || 0) });
    }
    refund = { ...refund, ...fetched.data };
    refs = { ...refs, ...refundReferences({ ...payload, refund }) };
  }
  await markStep('REFUND_RESOURCE_RESOLVED', 'Refund resource references were resolved.', { api_request_ids: apiRequestIds });

  if (refs.paymentId && (!Object.keys(payment).length || input.forceRefresh)) {
    const fetched = await fetchYocoV2Payment<Row>(env, {
      workspaceId, integrationId, rawEventId, processingRunId, traceId,
      attempt: numberValue(input.processingRun.attempt_number, 1), paymentId: refs.paymentId, forceRefresh: input.forceRefresh
    });
    apiRequestIds.push(fetched.requestId);
    if (fetched.found && fetched.data) payment = { ...payment, ...fetched.data };
  }

  refs = { ...refs, ...refundReferences({ ...payload, refund, payment, order: refundOrder }) };
  if (refs.refundOrderId && (!Object.keys(refundOrder).length || text(refundOrder.id) !== refs.refundOrderId || input.forceRefresh)) {
    const fetched = await fetchYocoV2Order<Row>(env, {
      workspaceId, integrationId, rawEventId, processingRunId, traceId,
      attempt: numberValue(input.processingRun.attempt_number, 1), orderId: refs.refundOrderId, forceRefresh: input.forceRefresh
    });
    apiRequestIds.push(fetched.requestId);
    if (fetched.found && fetched.data) refundOrder = { ...refundOrder, ...fetched.data };
    else if (!resourceLines(refund).length && numberValue(input.processingRun.attempt_number, 1) <= 3) {
      financialStatus = Object.keys(refund).length ? 'RESOLVED' : 'WAITING_FOR_YOCO';
      inventoryStatus = 'WAITING_FOR_YOCO';
      reportingStatus = financialStatus;
      await markStep('WAITING_FOR_YOCO', 'Refund order or returned-line resource is not available yet; delayed retry was scheduled before manual allocation.', { refund_order_id: refs.refundOrderId, api_request_id: fetched.requestId });
      throw new YocoV2ApiClientError({ message: 'Yoco refund order is not available yet.', status: 404, category: 'YOCO_TEMPORARY_ERROR', code: 'YOCO_V2_REFUND_ORDER_WAITING', retryable: true, retryAfterSeconds: Math.max(10, fetched.retryAfterSeconds || 0) });
    }
  }
  await markStep('REFUND_ORDER_RESOLVED', 'Refund-order context was evaluated.', { refund_order_id: refs.refundOrderId || null });

  refs = { ...refs, ...refundReferences({ ...payload, refund, payment, order: refundOrder }) };
  if (!refs.sourceOrderId) {
    const sourceFromRefundOrder = firstText(refundOrder.original_order_id, refundOrder.originalOrderId, refundOrder.source_order_id, refundOrder.sourceOrderId, refundOrder.parent_order_id, refundOrder.parentOrderId);
    refs.sourceOrderId = sourceFromRefundOrder;
  }
  if (refs.sourceOrderId) {
    const fetched = await fetchYocoV2Order<Row>(env, {
      workspaceId, integrationId, rawEventId, processingRunId, traceId,
      attempt: numberValue(input.processingRun.attempt_number, 1), orderId: refs.sourceOrderId, forceRefresh: input.forceRefresh
    });
    apiRequestIds.push(fetched.requestId);
    if (fetched.found && fetched.data) originalOrder = fetched.data;
  }
  if (!refs.sourceOrderId || !Object.keys(originalOrder).length) {
    financialStatus = Object.keys(refund).length || Object.keys(refundOrder).length ? 'RESOLVED' : 'WAITING_FOR_YOCO';
    inventoryStatus = 'WAITING_FOR_YOCO'; reportingStatus = financialStatus;
    await markStep('WAITING_FOR_YOCO', 'Original order is not available yet; no line allocation or stock proposal was attempted.', { source_order_id: refs.sourceOrderId || null });
    const rawFinancial = { ...refundOrder, ...refund };
    const derived = deriveYocoFinancialAmounts({ raw: rawFinancial, configuredVatRate: await workspaceVatRate(env, workspaceId), orderType: 'refund', status: text(refund.status || refundOrder.status) });
    const waiting: CanonicalSaleRefundedEvent = {
      event_id: eventId, event_type: 'sale.refunded', schema_version: REFUND_SCHEMA_VERSION, source: 'yoco', workspace_id: workspaceId,
      integration_id: integrationId, refund_id: refundIdentity, refund_order_id: refs.refundOrderId || undefined,
      source_order_id: refs.sourceOrderId, source_payment_id: refs.paymentId || undefined, occurred_at: refundOccurredAt(refund, refundOrder, receivedAt),
      received_at: receivedAt, currency: text(objectValue(rawFinancial.amounts).currency || rawFinancial.currency, 'ZAR'), refund_type: 'UNKNOWN',
      gross_amount: numberValue(derived.refundGrossAmount), discount_amount: 0, net_amount: numberValue(derived.refundNetAmount),
      tax_amount: numberValue(derived.refundVatAmount), tip_amount: 0, financial_resolution_status: financialStatus,
      inventory_resolution_status: inventoryStatus, reporting_resolution_status: reportingStatus,
      reconciliation_status: reconciliationStatus, overall_status: 'WAITING_FOR_YOCO', lines: [],
      metadata: { raw_event_type: eventType, source_payload: payload, refund_resource: refund, refund_order: refundOrder, payment, api_request_ids: apiRequestIds }
    };
    await upsertCanonicalRefundDomainEvent(env, { eventId, workspaceId, integrationId, rawEventId, processingRunId, refundId: refundIdentity, occurredAt: waiting.occurred_at, canonical: waiting });
    throw new YocoV2ApiClientError({ message: 'Original Yoco order is not available yet.', status: 404, category: 'YOCO_TEMPORARY_ERROR', code: 'YOCO_V2_REFUND_ORIGINAL_ORDER_WAITING', retryable: true, retryAfterSeconds: 15 });
  }
  await markStep('ORIGINAL_ORDER_RESOLVED', 'Original order and sold lines were resolved through the rate gate.', { source_order_id: refs.sourceOrderId });

  const originalLines = orderLines(originalOrder);
  const maps = originalLineMap(originalLines);
  const previous = await previousRefundedQuantities(env, workspaceId, refs.sourceOrderId, refundIdentity);
  const returnedLines = [...resourceLines(refund), ...resourceLines(refundOrder), ...resourceLines(refs.embeddedReturn)];
  const returnedLinesPending = Boolean(refund.returned_lines_pending || refund.returnedLinesPending || refund.line_items_pending || refund.lineItemsPending)
    || /pending|processing/.test(text(refund.return_status || refund.returnStatus || objectValue(refund.return).status).toLowerCase());
  if (!returnedLines.length && returnedLinesPending && numberValue(input.processingRun.attempt_number, 1) <= 3) {
    inventoryStatus = 'WAITING_FOR_YOCO';
    await markStep('WAITING_FOR_YOCO', 'Yoco indicates returned lines are still being prepared; no allocation was guessed.', { source_order_id: refs.sourceOrderId });
    throw new YocoV2ApiClientError({ message: 'Yoco returned lines are delayed.', status: 404, category: 'YOCO_TEMPORARY_ERROR', code: 'YOCO_V2_RETURN_LINES_WAITING', retryable: true, retryAfterSeconds: 15 });
  }
  const uniqueReturned = new Map<string, Row>();
  returnedLines.forEach((line, index) => uniqueReturned.set(`${originalLineReference(line)}|${sourceProductId(line)}|${sourceLineId(line, index)}`, line));
  const canonicalLines: CanonicalRefundLine[] = [];
  let allocationIssue = '';

  const manualAllocation = await resolvedManualAllocation(env, workspaceId, eventId);
  const allocations = manualAllocation.length ? manualAllocation : [...uniqueReturned.values()];
  for (const [returnedIndex, returnedLine] of allocations.entries()) {
    const originalRef = originalLineReference(returnedLine);
    let originalLine = originalRef ? maps.byId.get(originalRef) : undefined;
    let originalIndex = originalLine ? originalLines.indexOf(originalLine) : -1;
    let method: CanonicalRefundLine['resolution_method'] = manualAllocation.length ? 'MANUAL_ALLOCATION' : 'EXACT_SOURCE_LINE';
    let confidence = manualAllocation.length ? 1 : 1;
    if (!originalLine) {
      const productCandidates = maps.byProduct.get(sourceProductId(returnedLine)) || [];
      if (productCandidates.length === 1) {
        originalLine = productCandidates[0]; originalIndex = originalLines.indexOf(originalLine);
        method = manualAllocation.length ? 'MANUAL_ALLOCATION' : 'RETURN_RESOURCE'; confidence = manualAllocation.length ? 1 : 0.9;
      }
    }
    if (!originalLine) {
      // Yoco line items often carry only a variant_id (no product_id / original_line_id). When the
      // returned line's variant uniquely identifies one sold line, that is a reliable identity match
      // (not an equal-price guess), so allocate against it.
      const variantCandidates = maps.byVariant.get(sourceVariantId(returnedLine)) || [];
      if (variantCandidates.length === 1) {
        originalLine = variantCandidates[0]; originalIndex = originalLines.indexOf(originalLine);
        method = manualAllocation.length ? 'MANUAL_ALLOCATION' : 'RETURN_RESOURCE'; confidence = manualAllocation.length ? 1 : 0.9;
      }
    }
    if (!originalLine) { allocationIssue = 'RETURN_LINE_ORIGINAL_REFERENCE_MISSING'; continue; }
    const sold = lineQuantity(originalLine);
    const already = previous.get(sourceLineId(originalLine, originalIndex)) || 0;
    const remaining = Math.max(0, sold - already);
    const requested = lineQuantity(returnedLine);
    if (requested <= 0 || requested - remaining > 0.000001) {
      allocationIssue = 'REFUND_QUANTITY_EXCEEDS_REMAINING';
      continue;
    }
    canonicalLines.push(await canonicalRefundLine(env, workspaceId, originalLine, originalIndex, returnedLine, returnedIndex, requested, method, confidence));
  }

  const refundRaw: Row = { ...refundOrder, ...refund, payments: arrayValue(originalOrder.payments).length ? originalOrder.payments : arrayValue(payment).length ? payment : undefined };
  const financials = deriveYocoFinancialAmounts({ raw: refundRaw, configuredVatRate: await workspaceVatRate(env, workspaceId), orderType: 'refund', status: text(refund.status || refundOrder.status || 'refunded') });
  const grossAmount = Math.abs(numberValue(financials.refundGrossAmount));
  const originalRemainingGross = originalLines.reduce((sum, line, index) => {
    const remainingQty = Math.max(0, lineQuantity(line) - (previous.get(sourceLineId(line, index)) || 0));
    return sum + lineAmounts(line).unitGross * remainingQty;
  }, 0);
  const explicitFull = Boolean(refund.full_refund || refund.fullRefund || text(refund.refund_type || refund.refundType).toLowerCase() === 'full' || text(refundOrder.refund_type || refundOrder.refundType).toLowerCase() === 'full');

  if (!canonicalLines.length && !manualAllocation.length && explicitFull && originalLines.length && moneyEqual(grossAmount, originalRemainingGross)) {
    for (const [index, originalLine] of originalLines.entries()) {
      const remaining = Math.max(0, lineQuantity(originalLine) - (previous.get(sourceLineId(originalLine, index)) || 0));
      if (remaining <= 0) continue;
      canonicalLines.push(await canonicalRefundLine(env, workspaceId, originalLine, index, { ...originalLine, id: `${refundIdentity}:${sourceLineId(originalLine, index)}` }, index, remaining, 'FULL_ORDER_REMAINDER', 1));
    }
  }

  let refundType: YocoV2RefundType = 'UNKNOWN';
  if (canonicalLines.length) {
    const allRemaining = originalLines.every((line, index) => {
      const remaining = Math.max(0, lineQuantity(line) - (previous.get(sourceLineId(line, index)) || 0));
      const allocated = canonicalLines.filter((entry) => entry.source_original_line_id === sourceLineId(line, index)).reduce((sum, entry) => sum + entry.quantity, 0);
      return Math.abs(remaining - allocated) <= 0.000001;
    });
    if (allRemaining && canonicalLines.length) refundType = 'FULL';
    else if (canonicalLines.some((line) => line.quantity < lineQuantity(maps.byId.get(line.source_original_line_id) || {}))) refundType = 'PARTIAL_QUANTITY';
    else refundType = canonicalLines.length === 1 ? 'PARTIAL_LINE' : 'PARTIAL_LINE';
  } else if (grossAmount > 0) refundType = 'AMOUNT_ONLY';

  const sourceLocationId = orderLocationId(originalOrder);
  const kcpLocationId = await mapLocation(env, workspaceId, sourceLocationId);
  financialStatus = grossAmount > 0 ? 'RESOLVED' : 'PARTIALLY_RESOLVED';
  // Inventory-system policy: refunds are never routed to manual review. When stock can be
  // confidently allocated (reliable returned lines that are mapped, at a mapped location) it is
  // returned automatically. Otherwise — amount-only, ambiguous, unmapped, or over-refund — the
  // financial/reporting reversal is still recorded and the stock return is simply skipped
  // (inventory NOT_APPLICABLE) rather than opening a review that a human must action.
  const stockAllocatable = canonicalLines.length > 0 && !canonicalLines.some((line) => line.mapping_status === 'MISSING') && Boolean(kcpLocationId);
  // Lines present but not mappable (unmapped item/location) stay MAPPING_MISSING so reconciliation
  // still surfaces the config gap as a non-blocking finding (never a review). Genuinely
  // un-allocatable refunds — amount-only, ambiguous, or over-refund (no reliable lines) — are
  // NOT_APPLICABLE. Both skip the stock return; reporting is still applied in every case.
  inventoryStatus = stockAllocatable ? 'RESOLVED' : (canonicalLines.length > 0 ? 'MAPPING_MISSING' : 'NOT_APPLICABLE');
  reportingStatus = financialStatus;
  const reasonCode = allocationIssue || (refundType === 'AMOUNT_ONLY' ? 'AMOUNT_ONLY_WITHOUT_RETURN_LINES' : !canonicalLines.length ? 'REFUND_LINES_UNRESOLVED' : '');

  await markStep('RETURN_LINES_RESOLVED', canonicalLines.length ? 'Refunded source lines and quantities were resolved exactly.' : 'No reliable automatic line allocation was available.', { line_count: canonicalLines.length, reason_code: reasonCode || null });
  await markStep('FINANCIALS_RESOLVED', 'Refund gross, net and VAT financial dimensions were resolved independently.', { gross_amount: grossAmount, net_amount: Math.abs(numberValue(financials.refundNetAmount)), tax_amount: Math.abs(numberValue(financials.refundVatAmount)) });
  await markStep('MAPPINGS_RESOLVED', 'Refund item and location mappings were evaluated.', { location_id: kcpLocationId || null, item_mapping_missing: canonicalLines.some((line) => line.mapping_status === 'MISSING') });

  const overallStatus: YocoV2RefundWorkflowStep = 'CANONICAL_EVENT_CREATED';
  const canonical: CanonicalSaleRefundedEvent = {
    event_id: eventId,
    event_type: 'sale.refunded',
    schema_version: REFUND_SCHEMA_VERSION,
    source: 'yoco',
    workspace_id: workspaceId,
    integration_id: integrationId,
    refund_id: refundIdentity,
    refund_order_id: refs.refundOrderId || undefined,
    source_order_id: refs.sourceOrderId,
    source_payment_id: refs.paymentId || orderPaymentId(originalOrder) || undefined,
    payment_method: firstText(refund.payment_method, refund.paymentMethod, refundOrder.payment_method, refundOrder.paymentMethod, originalOrderPaymentMethod(originalOrder), 'Unknown'),
    source_location_id: sourceLocationId || undefined,
    kcp_location_id: kcpLocationId || undefined,
    occurred_at: refundOccurredAt(refund, refundOrder, receivedAt),
    received_at: receivedAt,
    currency: text(objectValue(refundRaw.amounts).currency || refundRaw.currency || originalOrder.currency, 'ZAR'),
    refund_type: refundType,
    gross_amount: grossAmount,
    discount_amount: money(refund.discount_amount || refund.discountAmount || objectValue(refund.amounts).discount_amount),
    net_amount: Math.abs(numberValue(financials.refundNetAmount)),
    tax_amount: Math.abs(numberValue(financials.refundVatAmount)),
    tip_amount: money(refund.tip_amount || refund.tipAmount),
    financial_resolution_status: financialStatus,
    inventory_resolution_status: inventoryStatus,
    reporting_resolution_status: reportingStatus,
    reconciliation_status: reconciliationStatus,
    overall_status: overallStatus,
    lines: canonicalLines,
    metadata: {
      raw_event_type: eventType,
      source_payload: payload,
      refund_resource: refund,
      refund_order: refundOrder,
      original_order: originalOrder,
      payment,
      previous_refunded_quantities: Object.fromEntries(previous),
      remaining_refundable_quantities: Object.fromEntries(originalLines.map((line, index) => [sourceLineId(line, index), Math.max(0, lineQuantity(line) - (previous.get(sourceLineId(line, index)) || 0))])),
      api_request_ids: apiRequestIds,
      financial_diagnostics: financials.diagnostics,
      financial_issues: financials.issues,
      allocation_reason_code: reasonCode || undefined
    }
  };
  const domainEvent = await upsertCanonicalRefundDomainEvent(env, { eventId, workspaceId, integrationId, rawEventId, processingRunId, refundId: refundIdentity, occurredAt: canonical.occurred_at, canonical });
  // No automatic manual review is opened. When stock could not be allocated the reason is retained
  // on the canonical event (metadata.allocation_reason_code) for observability, reporting is still
  // applied, and the stock return is skipped. `openRefundManualReview` remains available for an
  // explicit, admin-initiated allocation review if one is ever wanted.
  await updateWorkflow(env, {
    workflowId, workspaceId, integrationId, rawEventId, domainEventId: text(domainEvent.id), refundId: refundIdentity,
    sourceOrderId: refs.sourceOrderId, step: overallStatus, financialStatus, inventoryStatus, reportingStatus,
    reconciliationStatus, overallStatus
  });
  await appendTimeline(env.DB, {
    rawEventId, processingRunId, step: 'CANONICAL_EVENT_CREATED', status: overallStatus,
    message: `Canonical refund ${refundIdentity} stored once with refund type ${refundType}.`,
    metadata: { domain_event_id: domainEvent.id, refund_id: refundIdentity, source_order_id: refs.sourceOrderId, line_count: canonicalLines.length, overall_status: overallStatus }
  });
  const workflow = await env.DB.prepare(`SELECT * FROM yoco_v2_refund_workflows WHERE id = ?1`).bind(workflowId).first<Row>();
  return { domainEvent, canonical, workflow: workflow || { id: workflowId } };
}

export async function saveManualRefundAllocation(env: Env, input: {
  workspaceId: string;
  reviewId: string;
  allocation: Array<{ source_original_line_id: string; quantity: number }>;
  resolvedBy: string;
  acknowledgeFinancialDifference?: boolean;
}): Promise<Row> {
  const review = await env.DB.prepare(`SELECT * FROM yoco_v2_manual_reviews WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`)
    .bind(input.reviewId, input.workspaceId).first<Row>();
  if (!review) throw new Error('Refund manual review was not found.');
  const domain = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`)
    .bind(text(review.domain_event_id), input.workspaceId).first<Row>();
  if (!domain) throw new Error('Canonical refund event was not found.');
  const canonical = parseJson(domain.payload_json) as unknown as CanonicalSaleRefundedEvent;
  const sourceLines = arrayValue(JSON.parse(text(review.available_source_lines_json, '[]')));
  const previous = await previousRefundedQuantities(env, input.workspaceId, text(canonical.source_order_id), text(canonical.refund_id));
  const lineMap = originalLineMap(sourceLines);
  const normalized: Row[] = [];
  const seen = new Set<string>();
  for (const entry of input.allocation || []) {
    const lineId = text(entry.source_original_line_id);
    const quantity = Math.abs(numberValue(entry.quantity));
    if (!lineId || quantity <= 0 || seen.has(lineId)) throw new Error('Manual allocation contains an invalid or duplicate source line.');
    const line = lineMap.byId.get(lineId);
    if (!line) throw new Error(`Original order line ${lineId} was not found.`);
    const remaining = Math.max(0, lineQuantity(line) - (previous.get(lineId) || 0));
    if (quantity - remaining > 0.000001) throw new Error(`Allocation for ${lineId} exceeds the remaining refundable quantity.`);
    normalized.push({ ...line, id: `${canonical.refund_id}:manual:${lineId}`, original_line_id: lineId, quantity });
    seen.add(lineId);
  }
  if (!normalized.length) throw new Error('At least one refund line allocation is required.');
  const expectedGross = Math.abs(numberValue(canonical.gross_amount));
  const allocatedGross = normalized.reduce((sum, line) => {
    const original = lineMap.byId.get(text(line.original_line_id)) || line;
    return sum + lineAmounts(original).unitGross * lineQuantity(line);
  }, 0);
  const financialDifference = !moneyEqual(expectedGross, allocatedGross);
  if (financialDifference && !input.acknowledgeFinancialDifference) {
    throw new Error(`Allocated source-line gross ${allocatedGross.toFixed(2)} differs from refund gross ${expectedGross.toFixed(2)}. Explicit financial-difference acknowledgement is required for a custom amount allocation.`);
  }
  const now = nowIso();
  let history: unknown[] = [];
  try { history = JSON.parse(text(review.audit_history_json, '[]')); } catch { history = []; }
  history.push({
    action: 'MANUAL_ALLOCATION_SAVED',
    resolved_by: input.resolvedBy,
    resolved_at: now,
    allocation: normalized,
    refund_gross: expectedGross,
    allocated_source_line_gross: allocatedGross,
    financial_difference_acknowledged: financialDifference && Boolean(input.acknowledgeFinancialDifference)
  });
  await env.DB.prepare(
    `UPDATE yoco_v2_manual_reviews SET status = 'RESOLVED', resolved_allocation_json = ?2,
      audit_history_json = ?3, resolved_at = ?4, resolved_by = ?5, updated_at = ?4 WHERE id = ?1`
  ).bind(input.reviewId, JSON.stringify(normalized), JSON.stringify(history), now, input.resolvedBy).run();
  return (await env.DB.prepare(`SELECT * FROM yoco_v2_manual_reviews WHERE id = ?1`).bind(input.reviewId).first<Row>()) || review;
}
