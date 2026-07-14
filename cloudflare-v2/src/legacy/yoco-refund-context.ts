import type { Env } from './types';
import {
  YocoApiError,
  fetchOrder,
  fetchOrderOnce,
  fetchPayment,
  fetchPaymentOnce,
  isYocoRateLimitError,
  listRefundsPage,
  listRefundsPageOnce,
} from './yoco-client';

type Row = Record<string, unknown>;

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function objectRows(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as Row[]
    : [];
}

function jsonParse(value: unknown): Row {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
  try {
    const parsed = JSON.parse(text(value) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

function orderLines(order: Row | null) {
  if (!order) return [];
  for (const key of ['line_items', 'lineItems', 'items', 'order_lines', 'orderLines']) {
    const rows = objectRows(order[key]);
    if (rows.length) return rows;
  }
  return [];
}

function refundId(refund: Row) {
  return text(refund.id || refund.refund_id || refund.refundId || refund.transaction_id || refund.transactionId);
}

function refundIsFinal(refund: Row) {
  const status = text(refund.status).toLowerCase();
  return !status || ['approved', 'complete', 'completed', 'refunded', 'succeeded', 'successful', 'success'].includes(status);
}

function refundTimestamp(refund: Row) {
  const raw = text(refund.processed_at || refund.processedAt || refund.updated_at || refund.updatedAt || refund.created_at || refund.createdAt);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueRefunds(refunds: Row[], paymentId: string) {
  const byKey = new Map<string, Row>();
  refunds.filter(refundIsFinal).forEach((refund, index) => {
    const normalized = paymentId && !text(refund.payment_id || refund.paymentId)
      ? { ...refund, payment_id: paymentId }
      : refund;
    const key = refundId(normalized) || `${text(normalized.payment_id || normalized.paymentId)}:${refundTimestamp(normalized)}:${index}`;
    const current = byKey.get(key);
    byKey.set(key, current ? { ...current, ...normalized } : normalized);
  });
  return [...byKey.values()].sort((left, right) => refundTimestamp(left) - refundTimestamp(right));
}

function mergeRefundContext(order: Row | null, payment: Row | null, refunds: Row[], paymentId: string) {
  if (!order) return null;
  const existingRefunds = objectRows(order.refunds);
  const paymentRefunds = objectRows(payment?.refunds);
  const mergedRefunds = uniqueRefunds([...existingRefunds, ...paymentRefunds, ...refunds], paymentId);
  const existingPayments = objectRows(order.payments);
  const resolvedPaymentId = text(payment?.id || payment?.payment_id || payment?.paymentId || paymentId);
  const payments = payment
    ? [...existingPayments.filter((entry) => text(entry.id || entry.payment_id || entry.paymentId) !== resolvedPaymentId), payment]
    : existingPayments;
  return {
    ...order,
    refunds: mergedRefunds,
    payments,
  };
}

export function isYocoNotFoundError(value: unknown): value is YocoApiError {
  return value instanceof YocoApiError && value.status === 404;
}

async function loadCachedSale(
  env: Env,
  workspaceId: string,
  originalOrderId: string,
  paymentId: string,
) {
  if (!originalOrderId && !paymentId) return null;
  const row = await env.DB.prepare(
    `SELECT raw_json
       FROM yoco_orders
      WHERE workspace_id = ?1
        AND order_type = 'sale'
        AND (
          (?2 <> '' AND yoco_order_id = ?2)
          OR (?3 <> '' AND yoco_payment_id = ?3)
        )
      ORDER BY datetime(occurred_at) DESC
      LIMIT 1`,
  ).bind(workspaceId, originalOrderId, paymentId).first<{ raw_json?: string | null }>();
  const cached = jsonParse(row?.raw_json);
  return orderLines(cached).length ? cached : null;
}

async function loadRecentRefunds(
  env: Env,
  apiKey: string,
  paymentId: string,
  refundOrderId: string,
  singleAttempt: boolean,
) {
  if (!paymentId && !refundOrderId) return [] as Row[];
  const lowerBound = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const upperBound = new Date().toISOString();
  const page = singleAttempt
    ? await listRefundsPageOnce(env, apiKey, {
        updated_at__gte: lowerBound,
        updated_at__lte: upperBound,
        status: ['approved'],
        limit: 100,
      })
    : await listRefundsPage(env, apiKey, {
        updated_at__gte: lowerBound,
        updated_at__lte: upperBound,
        status: ['approved'],
        limit: 100,
      });
  return (page.rows as Row[]).filter((refund) => {
    const currentPaymentId = text(refund.payment_id || refund.paymentId);
    const currentRefundOrderId = text(refund.order_id || refund.orderId);
    return Boolean(
      (paymentId && currentPaymentId === paymentId)
      || (refundOrderId && currentRefundOrderId === refundOrderId)
    );
  });
}

export async function resolveYocoRefundWebhookContext(
  env: Env,
  workspaceId: string,
  apiKey: string,
  references: {
    webhookOrderId?: string;
    paymentId?: string;
    storedOrderId?: string;
  },
  options: { singleAttempt?: boolean } = {},
) {
  const singleAttempt = options.singleAttempt === true;
  const refundOrderId = text(references.webhookOrderId);
  const paymentId = text(references.paymentId);
  const storedOrderId = text(references.storedOrderId);
  const lookupErrors: string[] = [];

  let payment: Row | null = null;
  if (paymentId) {
    try {
      payment = singleAttempt
        ? await fetchPaymentOnce(env, apiKey, paymentId) as Row
        : await fetchPayment(env, apiKey, paymentId) as Row;
    } catch (caught) {
      if (isYocoRateLimitError(caught)) throw caught;
      if (!isYocoNotFoundError(caught)) throw caught;
      lookupErrors.push('payment_not_found_yet');
    }
  }

  let refunds = uniqueRefunds(objectRows(payment?.refunds), paymentId);
  let originalOrderId = text(
    refunds.find((refund) => text(refund.original_order_id || refund.originalOrderId))?.original_order_id
    || refunds.find((refund) => text(refund.original_order_id || refund.originalOrderId))?.originalOrderId
    || payment?.order_id
    || payment?.orderId,
  );

  if (!refunds.length || !originalOrderId) {
    try {
      const recentRefunds = await loadRecentRefunds(env, apiKey, paymentId, refundOrderId, singleAttempt);
      refunds = uniqueRefunds([...refunds, ...recentRefunds], paymentId);
      originalOrderId = text(
        refunds.find((refund) => text(refund.original_order_id || refund.originalOrderId))?.original_order_id
        || refunds.find((refund) => text(refund.original_order_id || refund.originalOrderId))?.originalOrderId
        || originalOrderId,
      );
    } catch (caught) {
      if (isYocoRateLimitError(caught)) throw caught;
      if (!isYocoNotFoundError(caught)) throw caught;
      lookupErrors.push('refund_list_not_available_yet');
    }
  }

  if (!originalOrderId && storedOrderId && storedOrderId !== refundOrderId) {
    originalOrderId = storedOrderId;
  }

  let order: Row | null = null;
  if (originalOrderId) {
    try {
      order = singleAttempt
        ? await fetchOrderOnce(env, apiKey, originalOrderId) as Row
        : await fetchOrder(env, apiKey, originalOrderId) as Row;
    } catch (caught) {
      if (isYocoRateLimitError(caught)) throw caught;
      if (!isYocoNotFoundError(caught)) throw caught;
      lookupErrors.push('original_order_not_found_yet');
    }
  }

  if (!order || !orderLines(order).length) {
    const cached = await loadCachedSale(env, workspaceId, originalOrderId, paymentId);
    if (cached) {
      order = cached;
      originalOrderId = text(cached.id || cached.order_id || cached.orderId || originalOrderId);
    }
  }

  order = mergeRefundContext(order, payment, refunds, paymentId);
  return {
    order,
    payment,
    refunds,
    originalOrderId: text(order?.id || order?.order_id || order?.orderId || originalOrderId),
    refundOrderId,
    paymentId,
    lookupErrors,
    source: order
      ? orderLines(order).length
        ? lookupErrors.length ? 'cached_or_fallback_original_order' : 'original_order'
        : 'order_without_lines'
      : 'unresolved',
  };
}
