import type { Env } from '../../legacy/types';
import { deriveYocoFinancialAmounts, yocoMoneyToMajor } from '../../../../src/modules/reporting/engine/yocoFinancials.js';
import type {
  CanonicalSaleCompletedEvent,
  CanonicalSaleLine,
  CanonicalSaleModifier,
  YocoV2SaleResolutionStatus
} from './contracts';
import { fetchYocoV2Order, YocoV2ApiClientError, type YocoV2ApiClientEnv } from './api-client';
import { appendTimeline, newId, nowIso, type Row } from './repository';
import { observeModifier, resolveModifierMapping } from '../modifier-engine/rules';
import { normalizeModifierNote, observeLineNotes } from '../modifier-engine/reliability';
import { resolveYocoStockLocation } from './location-routing';

const SALE_SCHEMA_VERSION = '1.0.0';
const FINAL_STATUSES = new Set(['approved', 'captured', 'closed', 'complete', 'completed', 'fulfilled', 'paid', 'settled', 'success', 'successful', 'succeeded', 'partially refunded', 'refunded']);
const LINE_KEYS = ['line_items', 'lineItems', 'items', 'order_lines', 'orderLines'];
const MODIFIER_KEYS = ['modifiers', 'selected_modifiers', 'selectedModifiers', 'line_modifiers', 'lineModifiers', 'modifier_lines', 'modifierLines', 'applied_modifiers', 'appliedModifiers', 'modifier_selections', 'modifierSelections'];
const NOTE_KEYS = ['note', 'notes', 'line_note', 'lineNote', 'kitchen_note', 'kitchenNote', 'special_instructions', 'specialInstructions', 'instructions'];

function objectValue(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function arrayValue(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as Row[] : [];
}
function text(value: unknown, fallback = ''): string { return String(value ?? fallback).trim(); }
function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
function money(value: unknown, scalarUnit: 'major' | 'minor' = 'major'): number {
  const result = yocoMoneyToMajor(value, { scalarUnit, absolute: true });
  return Number.isFinite(result) ? result : 0;
}
function firstObject(...values: unknown[]): Row {
  return values.map(objectValue).find((row) => Object.keys(row).length > 0) || {};
}

export function normalizeYocoV2EventType(value: unknown): string {
  return text(value).toLowerCase().replace(/_/g, '.');
}

export function isSupportedCompletedSaleEvent(eventType: string): boolean {
  const normalized = normalizeYocoV2EventType(eventType);
  return [
    'order.completed', 'order.complete', 'order.paid', 'payment.created', 'payment.succeeded',
    'payment.successful', 'payment.completed', 'payment.captured', 'order.updated'
  ].includes(normalized);
}

function embeddedOrder(payload: Row): Row {
  const data = objectValue(payload.data);
  const envelope = objectValue(payload.payload);
  const envelopeData = objectValue(envelope.data);
  return firstObject(
    payload.order,
    data.order,
    envelope.order,
    envelopeData.order,
    data.object,
    envelopeData.object,
    normalizeYocoV2EventType(payload.type).startsWith('order.') ? data : {},
    normalizeYocoV2EventType(payload.type).startsWith('order.') ? envelopeData : {}
  );
}

export function extractYocoV2OrderId(payload: Row): string {
  const data = objectValue(payload.data);
  const envelope = objectValue(payload.payload);
  const envelopeData = objectValue(envelope.data);
  const order = embeddedOrder(payload);
  const payment = firstObject(payload.payment, data.payment, envelope.payment, envelopeData.payment, data);
  return text(
    order.id || order.order_id || order.orderId ||
    payload.order_id || payload.orderId || data.order_id || data.orderId ||
    envelope.order_id || envelope.orderId || envelopeData.order_id || envelopeData.orderId ||
    payment.order_id || payment.orderId || objectValue(payment.order).id
  );
}

function orderLines(order: Row): Row[] {
  for (const key of LINE_KEYS) {
    const rows = arrayValue(order[key]);
    if (rows.length) return rows;
  }
  return [];
}

function orderStatusValues(order: Row): string[] {
  const payment = objectValue(order.payment);
  const payments = arrayValue(order.payments);
  return [
    order.status, order.order_status, order.orderStatus, order.payment_status, order.paymentStatus,
    payment.status, ...payments.flatMap((row) => [row.status, row.state, row.payment_status, row.paymentStatus])
  ].map((entry) => text(entry).toLowerCase()).filter(Boolean);
}

function completedOrder(order: Row): boolean {
  const statuses = orderStatusValues(order);
  const timestamp = text(order.completed_at || order.completedAt || order.closed_at || order.closedAt || order.paid_at || order.paidAt);
  if (statuses.some((status) => FINAL_STATUSES.has(status) || /complete|paid|captur|settled|success/.test(status))) return true;
  return Boolean(timestamp);
}

function orderLocationId(order: Row): string {
  const location = objectValue(order.location);
  return text(order.location_id || order.locationId || location.id || location.location_id || location.locationId);
}

function orderPaymentId(order: Row): string {
  const payments = arrayValue(order.payments);
  const selected = payments.find((row) => FINAL_STATUSES.has(text(row.status).toLowerCase())) || payments[0] || objectValue(order.payment);
  return text(order.payment_id || order.paymentId || selected.id || selected.payment_id || selected.paymentId);
}

// Yoco carries the tender at payments[<approved|first>].payment_method (e.g. "cash"/"card"), not at
// the top level. Mirror the legacy getPaymentMethod so reporting keeps a payment method per sale.
function orderPaymentMethod(order: Row): string {
  const payments = arrayValue(order.payments);
  const selected = payments.find((row) => FINAL_STATUSES.has(text(row.status).toLowerCase())) || payments[0] || objectValue(order.payment);
  return text(
    selected.payment_method || selected.paymentMethod || selected.payment_type || selected.type ||
    order.payment_method || order.paymentMethod || objectValue(order.payment).method
  );
}

function lineId(line: Row, index: number): string { return text(line.id || line.line_item_id || line.lineItemId || line.uuid || `line_${index}`); }
function lineProductId(line: Row): string {
  const product = objectValue(line.product);
  const item = objectValue(line.item);
  return text(line.product_id || line.productId || line.item_id || line.itemId || product.id || item.id);
}
function lineVariantId(line: Row): string {
  const variant = firstObject(line.variant, line.product_variant, line.productVariant, objectValue(line.product).variant, objectValue(line.item).variant);
  return text(line.variant_id || line.variantId || line.item_variant_id || line.itemVariantId || line.product_variant_id || line.productVariantId || variant.id);
}
function lineName(line: Row): string {
  return text(line.name || line.product_name || line.productName || line.item_name || line.itemName || objectValue(line.product).name || objectValue(line.item).name, 'Yoco Item');
}
function lineQuantity(line: Row): number {
  const raw = line.quantity ?? line.qty ?? line.count;
  return Math.abs(numberValue(raw, raw === undefined || raw === null ? 1 : 0));
}

function lineNotes(line: Row): string[] {
  const values: unknown[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) values.push(...value);
    else if (value && typeof value === 'object') {
      const row = objectValue(value);
      values.push(row.text, row.value, row.note, row.notes, row.name);
    } else values.push(value);
  };
  for (const key of NOTE_KEYS) collect(line[key]);
  const metadata = objectValue(line.metadata);
  for (const key of NOTE_KEYS) collect(metadata[key]);
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function lineAmounts(line: Row) {
  const amounts = objectValue(line.amounts);
  const quantity = lineQuantity(line) || 1;
  const gross = money(line.total_price || line.totalPrice || line.total_amount || line.totalAmount || line.amount || amounts.gross_amount || amounts.net_amount);
  const unit = money(line.unit_price || line.unitPrice || line.price) || (gross / quantity);
  const discount = money(line.discount_amount || line.discountAmount || amounts.discount_amount || amounts.discountAmount);
  const tax = money(line.tax_amount || line.taxAmount || amounts.tax_amount || amounts.taxAmount);
  const net = money(line.net_amount || line.netAmount || amounts.net_amount || amounts.netAmount) || Math.max(0, gross - tax);
  return { gross, unit, discount, tax, net };
}

function modifierRows(line: Row): Row[] {
  const result: Row[] = [];
  for (const key of MODIFIER_KEYS) result.push(...arrayValue(line[key]));
  for (const group of arrayValue(line.modifier_groups || line.modifierGroups || line.selected_modifier_groups || line.selectedModifierGroups)) {
    const groupRows = arrayValue(group.modifiers || group.items || group.options || group.values);
    for (const modifier of groupRows) result.push({ ...modifier, group_id: modifier.group_id || group.id, group_name: modifier.group_name || group.name });
  }
  const seen = new Set<string>();
  return result.filter((row, index) => {
    const key = text(row.id || row.modifier_id || row.variant_id || row.product_id || `${text(row.name)}:${index}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function modifierIdentity(row: Row) {
  const nested = firstObject(row.modifier, row.modifier_item, row.modifierItem, row.selected_modifier, row.selectedModifier);
  const value = Object.keys(nested).length ? { ...nested, ...row } : row;
  const product = objectValue(value.product);
  const item = objectValue(value.item);
  const variant = firstObject(value.variant, value.product_variant, value.productVariant);
  const variantId = text(value.variant_id || value.variantId || value.product_variant_id || value.productVariantId || value.product_id || value.productId || value.item_id || value.itemId || variant.id || product.id || item.id);
  const rawType = text(value._kcp_modifier_kind || value.type || value.kind || value.modifier_type || value.modifierType || value.input_type || value.inputType).toLowerCase();
  const type = rawType.includes('note') || rawType.includes('text') || rawType.includes('free')
    ? 'Note'
    : rawType.includes('product') || Boolean(variantId)
      ? 'Product'
      : 'Option';
  return {
    row: value,
    id: text(value.modifier_id || value.modifierId || value.id || value.uuid),
    groupId: text(value.group_id || value.groupId || value.modifier_group_id || value.modifierGroupId || objectValue(value.group).id),
    variantId,
    name: text(value.name || value.display_name || value.product_name || product.name || item.name || variant.name, 'Yoco Modifier'),
    type,
    quantity: Math.max(1, Math.abs(numberValue(value.quantity || value.qty || value.count, 1))),
    gross: money(value.total_price || value.totalPrice || value.amount || value.price)
  };
}

async function mapLocation(env: Env, workspaceId: string, sourceLocationId: string): Promise<string> {
  return resolveYocoStockLocation(env, workspaceId, sourceLocationId);
}

async function mapProduct(env: Env, workspaceId: string, sourceProductId: string, sourceVariantId: string): Promise<string> {
  if (!sourceProductId && !sourceVariantId) return '';
  const row = await env.DB.prepare(
    `SELECT id FROM products
      WHERE workspace_id = ?1 AND active = 1
        AND lower(COALESCE(external_provider, 'yoco')) = 'yoco'
        AND (
          (?3 <> '' AND yoco_variant_id = ?3)
          OR (?2 <> '' AND yoco_item_id = ?2 AND (COALESCE(yoco_variant_id, '') = '' OR ?3 = ''))
        )
      ORDER BY CASE WHEN yoco_variant_id = ?3 AND ?3 <> '' THEN 0 ELSE 1 END LIMIT 1`
  ).bind(workspaceId, sourceProductId, sourceVariantId).first<Row>();
  return text(row?.id);
}

async function mapModifier(env: Env, workspaceId: string, row: ReturnType<typeof modifierIdentity>) {
  return resolveModifierMapping(env, workspaceId, {
    id: row.id,
    groupId: row.groupId,
    variantId: row.variantId,
    name: row.name
  });
}

async function resolveLine(env: Env, workspaceId: string, line: Row, index: number): Promise<CanonicalSaleLine> {
  const sourceProductId = lineProductId(line);
  const sourceVariantId = lineVariantId(line);
  const mappedProductId = await mapProduct(env, workspaceId, sourceProductId, sourceVariantId);
  const amounts = lineAmounts(line);
  const modifiers: CanonicalSaleModifier[] = [];
  const rawNotes = lineNotes(line);
  for (const rawModifier of modifierRows(line)) {
    const identity = modifierIdentity(rawModifier);
    const mapping = await mapModifier(env, workspaceId, identity);
    const mappedModifierId = mapping.ownerId;
    modifiers.push({
      source_modifier_id: identity.id || identity.variantId || `${lineId(line, index)}:modifier:${modifiers.length}`,
      source_modifier_group_id: identity.groupId || undefined,
      source_name: identity.name,
      quantity: identity.quantity,
      gross_amount: identity.gross,
      mapping_status: mappedModifierId ? 'MAPPED' : 'MISSING',
      mapped_modifier_id: mappedModifierId || undefined,
      metadata: {
        source_variant_id: identity.variantId || undefined,
        modifier_type: identity.type,
        source: identity.row,
        mapping_source: mapping.source,
        modifier_rule_id: mapping.rule?.id || undefined,
        modifier_action_type: mapping.rule?.action_type || undefined,
        auto_linked_product_id: mapping.autoLinkedProductId || undefined
      }
    });
  }
  return {
    source_line_id: lineId(line, index),
    source_product_id: sourceProductId,
    source_variant_id: sourceVariantId || undefined,
    source_name: lineName(line),
    quantity: lineQuantity(line),
    unit_gross_amount: amounts.unit,
    gross_amount: amounts.gross,
    discount_amount: amounts.discount,
    net_amount: amounts.net,
    tax_amount: amounts.tax,
    modifiers,
    mapping_status: mappedProductId ? 'MAPPED' : 'MISSING',
    mapped_menu_item_id: mappedProductId || undefined,
    metadata: {
      source: line,
      raw_note_texts: rawNotes,
      normalized_note_texts: rawNotes.map(normalizeModifierNote).filter(Boolean)
    }
  };
}

function resolutionStatus(input: { completed: boolean; locationId: string; sourceLocationId: string; lines: CanonicalSaleLine[] }): YocoV2SaleResolutionStatus {
  if (!input.completed) return 'UNSUPPORTED_ORDER_STATE';
  if (input.sourceLocationId && !input.locationId) return 'LOCATION_MAPPING_MISSING';
  if (input.lines.some((line) => line.mapping_status === 'MISSING')) return 'ITEM_MAPPING_MISSING';
  if (input.lines.some((line) => line.modifiers.some((modifier) => modifier.mapping_status === 'MISSING'))) return 'MODIFIER_MAPPING_MISSING';
  if (!input.lines.length || !input.locationId) return 'PARTIALLY_RESOLVED';
  return 'RESOLVED';
}

async function workspaceVatRate(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT vat_rate FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`).bind(workspaceId).first<Row>();
  const value = numberValue(row?.vat_rate, 15);
  return value > 0 ? value : 15;
}

export interface ResolveCanonicalSaleInput {
  rawEvent: Row;
  processingRun: Row;
  forceRefresh?: boolean;
}

async function upsertCanonicalSaleDomainEvent(
  env: Env,
  input: {
    eventId: string;
    workspaceId: string;
    integrationId: string;
    rawEventId: string;
    processingRunId: string;
    sourceOrderId: string;
    occurredAt: string;
    canonical: CanonicalSaleCompletedEvent;
  }
): Promise<Row> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_domain_events
      (id, workspace_id, integration_id, raw_event_id, processing_run_id, event_key,
       event_type, schema_version, source_entity_id, occurred_at, payload_json,
       resolution_status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sale.completed', ?7, ?8, ?9, ?10, ?11, ?12, ?12)
     ON CONFLICT(workspace_id, integration_id, event_key) DO UPDATE SET
       processing_run_id = excluded.processing_run_id,
       schema_version = excluded.schema_version,
       occurred_at = excluded.occurred_at,
       payload_json = excluded.payload_json,
       resolution_status = excluded.resolution_status,
       updated_at = excluded.updated_at`
  ).bind(
    input.eventId, input.workspaceId, input.integrationId, input.rawEventId, input.processingRunId,
    `sale:${input.sourceOrderId}`, SALE_SCHEMA_VERSION, input.sourceOrderId, input.occurredAt,
    JSON.stringify(input.canonical), input.canonical.resolution_status, now
  ).run();
  const domainEvent = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE id = ?1 LIMIT 1`).bind(input.eventId).first<Row>();
  if (!domainEvent) throw new Error('Canonical sale domain event could not be stored.');
  return domainEvent;
}

export async function resolveCanonicalYocoSale(env: YocoV2ApiClientEnv, input: ResolveCanonicalSaleInput): Promise<{ domainEvent: Row; canonical: CanonicalSaleCompletedEvent }> {
  const rawEventId = text(input.rawEvent.id);
  const processingRunId = text(input.processingRun.id);
  const workspaceId = text(input.rawEvent.workspace_id);
  const integrationId = text(input.rawEvent.integration_id);
  const traceId = text(input.rawEvent.trace_id);
  const eventType = normalizeYocoV2EventType(input.rawEvent.event_type);
  const payload = JSON.parse(text(input.rawEvent.payload_json, '{}')) as Row;
  if (!isSupportedCompletedSaleEvent(eventType)) throw new Error(`Unsupported event for canonical sale resolution: ${eventType}`);
  const sourceOrderId = extractYocoV2OrderId(payload);
  if (!sourceOrderId) {
    throw new YocoV2ApiClientError({
      message: 'Completed-sale webhook did not contain a Yoco order reference.',
      status: 400,
      category: 'VALIDATION_ERROR',
      code: 'YOCO_V2_SALE_ORDER_ID_MISSING',
      retryable: false
    });
  }

  const existing = await env.DB.prepare(
    `SELECT id, created_at FROM yoco_v2_domain_events
      WHERE workspace_id = ?1 AND integration_id = ?2 AND event_key = ?3 LIMIT 1`
  ).bind(workspaceId, integrationId, `sale:${sourceOrderId}`).first<Row>();
  const eventId = text(existing?.id) || newId('yoco_v2_domain');

  let order = embeddedOrder(payload);
  const embeddedComplete = orderLines(order).length > 0 && (order.amounts || order.total_price || order.total_amount || order.net_amount);
  let apiRequestId = '';
  if (!embeddedComplete || input.forceRefresh) {
    const fetched = await fetchYocoV2Order<Row>(env, {
      workspaceId,
      integrationId,
      rawEventId,
      processingRunId,
      traceId,
      attempt: numberValue(input.processingRun.attempt_number, 1),
      orderId: sourceOrderId,
      forceRefresh: input.forceRefresh
    });
    apiRequestId = fetched.requestId;
    if (!fetched.found || !fetched.data) {
      const waitingCanonical: CanonicalSaleCompletedEvent = {
        event_id: eventId,
        event_type: 'sale.completed',
        source: 'yoco',
        source_version: 'v1',
        workspace_id: workspaceId,
        integration_id: integrationId,
        source_order_id: sourceOrderId,
        occurred_at: text(input.rawEvent.received_at),
        received_at: text(input.rawEvent.received_at),
        currency: 'ZAR',
        gross_amount: 0,
        discount_amount: 0,
        net_amount: 0,
        tax_amount: 0,
        tip_amount: 0,
        status: 'waiting_for_yoco',
        lines: [],
        metadata: {
          raw_event_type: eventType,
          api_request_id: fetched.requestId,
          source_payload: payload,
          waiting_reason: 'Yoco order detail returned not found and may not be available yet.'
        },
        schema_version: SALE_SCHEMA_VERSION,
        resolution_status: 'WAITING_FOR_YOCO'
      };
      await upsertCanonicalSaleDomainEvent(env, {
        eventId, workspaceId, integrationId, rawEventId, processingRunId, sourceOrderId,
        occurredAt: waitingCanonical.occurred_at,
        canonical: waitingCanonical
      });
      await appendTimeline(env.DB, {
        rawEventId,
        processingRunId,
        step: 'CANONICAL_SALE_WAITING_FOR_YOCO',
        status: 'WAITING_FOR_YOCO',
        message: `Canonical sale ${sourceOrderId} is waiting for delayed Yoco order availability.`,
        metadata: { domain_event_id: eventId, source_order_id: sourceOrderId, api_request_id: fetched.requestId }
      });
      throw new YocoV2ApiClientError({
        message: 'Yoco order is not available yet; resolution will retry through the rate gate.',
        status: 404,
        category: 'YOCO_TEMPORARY_ERROR',
        code: 'YOCO_V2_ORDER_NOT_AVAILABLE_YET',
        retryable: true,
        retryAfterSeconds: Math.max(5, fetched.retryAfterSeconds || 0),
        details: { source_order_id: sourceOrderId, resolution_status: 'WAITING_FOR_YOCO', domain_event_id: eventId }
      });
    }
    order = { ...order, ...fetched.data };
  }

  const sourceLocationId = orderLocationId(order);
  const kcpLocationId = await mapLocation(env, workspaceId, sourceLocationId);
  const lines: CanonicalSaleLine[] = [];
  for (const [index, line] of orderLines(order).entries()) lines.push(await resolveLine(env, workspaceId, line, index));
  const completed = completedOrder(order);
  // payment.created is Yoco's earliest documented live device-sale notification.
  // It can arrive a moment before the order endpoint reflects the final paid
  // state. Retry instead of permanently recording a non-final sale with no
  // effects; a later retry or order.completed delivery resolves the same order
  // and the source-order idempotency keys prevent duplicate reporting/stock.
  if (eventType === 'payment.created' && !completed) {
    throw new YocoV2ApiClientError({
      message: 'Yoco payment was created, but the order is not final yet; live sale processing will retry.',
      status: 409,
      category: 'YOCO_TEMPORARY_ERROR',
      code: 'YOCO_V2_PAYMENT_ORDER_NOT_FINAL_YET',
      retryable: true,
      retryAfterSeconds: 5,
      details: { source_order_id: sourceOrderId, raw_event_type: eventType }
    });
  }
  const status = resolutionStatus({ completed, locationId: kcpLocationId, sourceLocationId, lines });
  const financials = deriveYocoFinancialAmounts({
    raw: order,
    persistedTotal: 0,
    configuredVatRate: await workspaceVatRate(env, workspaceId),
    orderType: 'sale',
    status: text(order.status)
  });
  const occurredAt = text(order.closed_at || order.closedAt || order.completed_at || order.completedAt || order.paid_at || order.paidAt || order.created_at || order.createdAt, text(input.rawEvent.received_at));
  const canonical: CanonicalSaleCompletedEvent = {
    event_id: eventId,
    event_type: 'sale.completed',
    source: 'yoco',
    source_version: 'v1',
    workspace_id: workspaceId,
    integration_id: integrationId,
    source_order_id: sourceOrderId,
    source_payment_id: orderPaymentId(order) || undefined,
    payment_method: orderPaymentMethod(order) || undefined,
    source_location_id: sourceLocationId || undefined,
    kcp_location_id: kcpLocationId || undefined,
    occurred_at: occurredAt,
    received_at: text(input.rawEvent.received_at),
    currency: text(objectValue(order.amounts).currency || order.currency, 'ZAR'),
    gross_amount: numberValue(financials.grossAmount),
    discount_amount: numberValue(financials.discountAmount),
    net_amount: numberValue(financials.netAmount),
    tax_amount: numberValue(financials.vatAmount),
    tip_amount: numberValue(financials.tipAmount),
    status: text(order.status, completed ? 'completed' : 'unknown'),
    lines,
    metadata: {
      raw_event_type: eventType,
      api_request_id: apiRequestId || undefined,
      financial_diagnostics: financials.diagnostics,
      financial_issues: financials.issues,
      source_order: order
    },
    schema_version: SALE_SCHEMA_VERSION,
    resolution_status: status
  };
  const domainEvent = await upsertCanonicalSaleDomainEvent(env, {
    eventId, workspaceId, integrationId, rawEventId, processingRunId, sourceOrderId,
    occurredAt,
    canonical
  });
  await Promise.all(lines.flatMap((line) => line.modifiers.map((modifier) => observeModifier(env as Env, {
    workspaceId,
    sourceOrderId,
    sourceLineId: line.source_line_id,
    identity: {
      id: modifier.source_modifier_id,
      groupId: modifier.source_modifier_group_id,
      variantId: text(modifier.metadata?.source_variant_id),
      name: modifier.source_name
    },
    ownerId: modifier.mapped_modifier_id,
    mappingStatus: modifier.mapping_status,
    raw: objectValue(modifier.metadata?.source)
  }))));
  await Promise.all(lines.map((line) => observeLineNotes(env as Env, {
    workspaceId,
    sourceOrderId,
    sourceLineId: line.source_line_id,
    menuItemId: line.mapped_menu_item_id,
    locationId: kcpLocationId,
    notes: Array.isArray(line.metadata?.raw_note_texts) ? line.metadata.raw_note_texts.map((value) => text(value)).filter(Boolean) : [],
    observedAt: occurredAt
  })));
  await appendTimeline(env.DB, {
    rawEventId,
    processingRunId,
    step: 'CANONICAL_SALE_STORED',
    status,
    message: `Canonical sale ${sourceOrderId} stored once with resolution status ${status}.`,
    metadata: { domain_event_id: eventId, source_order_id: sourceOrderId, line_count: lines.length, resolution_status: status }
  });
  return { domainEvent, canonical };
}
