import type { DbStatementLike, Env } from './types';

type Row = Record<string, unknown>;

export type InventoryCostingMethod = 'last' | 'wac';

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value ?? '').trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function jsonObject(value: unknown): Row {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Row;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

/** Normalize every supported setting spelling to the two persisted costing modes. */
export function normalizeInventoryCostingMethod(value: unknown): InventoryCostingMethod {
  const method = text(value || 'last').toLowerCase().replace(/[\s-]+/g, '_');
  return ['wac', 'weighted_average', 'weighted_average_cost', 'weighted'].includes(method) ? 'wac' : 'last';
}

/**
 * The Worker is the authority for the selected stock-control method.
 * Client payloads must never decide whether a transaction uses WAC or last received.
 */
export async function getWorkspaceInventoryCostingMethod(env: Env, workspaceId: string): Promise<InventoryCostingMethod> {
  const row = await env.DB.prepare(
    `SELECT raw_json
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`
  ).bind(workspaceId).first<Row>();
  const raw = jsonObject(row?.raw_json);
  const nestedBusiness = jsonObject(raw.business);
  return normalizeInventoryCostingMethod(
    raw.costingMethod || raw.costing_method || nestedBusiness.costingMethod || nestedBusiness.costing_method
  );
}

/**
 * Effective VAT rate (as a fraction, e.g. 0.15) to use for GRV/PO/Credit Note ex-VAT extraction and
 * other stock-costing math. Deliberately independent of vat_registered: VAT paid to a supplier on a
 * VATable stock item (e.g. beer) is real money paid regardless of whether THIS business can reclaim
 * it — a non-registered business still pays the VAT, it just can't deduct it on a return. Whether a
 * given line carries VAT at all is instead decided per line by stock_items.vat_enabled (e.g. bread
 * never carries VAT) — see sumVatAwareLineTotals/loadVatEnabledByStockItemId below, which callers
 * combine with this rate. vat_registered still legitimately gates OUTPUT VAT on sales (a
 * non-registered business cannot charge VAT) — that's handled separately in the Yoco sale/refund
 * resolvers and is NOT this function's concern.
 */
export async function getWorkspaceEffectiveVatRate(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT vat_rate
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`
  ).bind(workspaceId).first<{ vat_rate?: number }>();
  if (!row) return 0.15;
  const percent = numberValue(row.vat_rate, 15);
  return (percent > 0 ? percent : 15) / 100;
}

/**
 * Whether the workspace is currently VAT registered. NOT used to decide whether stock costing
 * charges VAT (that's vat_enabled's job, always) — only to know which convention an already-
 * submitted GRV line total is in: GRVEntry.js's finalizeReceivedCost folds VAT straight into the
 * stored unit cost for a VATable line when the business can't reclaim it (not registered), so
 * that figure is already VAT-inclusive by the time it reaches the backend; for a registered
 * business it stays ex-VAT. See sumVatAwareLineTotals's `linesAreAlreadyVatInclusive` option.
 */
export async function isWorkspaceVatRegistered(env: Env, workspaceId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT vat_registered
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`
  ).bind(workspaceId).first<{ vat_registered?: number }>();
  return Number(row?.vat_registered ?? 1) !== 0;
}

export interface VatAwareLineInput {
  stockItemId?: unknown;
  lineTotalEx?: unknown;
}

export interface VatAwareLineTotals {
  totalEx: number;
  totalVat: number;
  totalInc: number;
}

/**
 * Sums line totals into VAT-aware header totals for a GRV/PO/Credit Note: VAT is computed PER LINE
 * from each stock item's own vat_enabled flag, then summed — never one flat rate applied to the
 * order/GRV total as a whole (that previously wiped out the bread-vs-beer distinction). A stock
 * item missing from vatEnabledByStockItemId is treated as VATable, matching stock_items.vat_enabled's
 * DB default of 1.
 *
 * `linesAreAlreadyVatInclusive` (default false — the normal case) controls which direction a
 * VATable line's submitted amount gets split: false ADDS vatRate on top (the amount submitted is
 * genuine ex-VAT — true for Purchase Orders always, and for GRVs on a VAT-registered workspace).
 * true instead BACKS the true ex-VAT/VAT split OUT of an already-inclusive submitted amount — only
 * correct for a GRV on a non-VAT-registered workspace, where GRVEntry.js's finalizeReceivedCost has
 * already folded VAT into the line's cost before it reached this function. Getting this backwards
 * either silently drops real VAT or double-counts it — see the caller for why each is set the way
 * it is.
 */
export function sumVatAwareLineTotals(
  items: VatAwareLineInput[],
  vatRate: number,
  vatEnabledByStockItemId: Map<string, boolean>,
  linesAreAlreadyVatInclusive = false
): VatAwareLineTotals {
  let totalEx = 0;
  let totalVat = 0;
  for (const line of items) {
    const submitted = numberValue(line.lineTotalEx, 0);
    const stockItemId = text(line.stockItemId);
    const isVatable = vatEnabledByStockItemId.get(stockItemId) !== false;
    if (!isVatable) {
      totalEx += submitted;
      continue;
    }
    if (linesAreAlreadyVatInclusive) {
      const ex = submitted / (1 + vatRate);
      totalEx += ex;
      totalVat += submitted - ex;
    } else {
      totalEx += submitted;
      totalVat += submitted * vatRate;
    }
  }
  return { totalEx, totalVat, totalInc: totalEx + totalVat };
}

/** Batched vat_enabled lookup for a set of stock items — one query regardless of line count. */
export async function loadVatEnabledByStockItemId(
  env: Env,
  workspaceId: string,
  stockItemIds: Array<string | undefined | null>
): Promise<Map<string, boolean>> {
  const uniqueIds = Array.from(new Set(stockItemIds.map((value) => text(value)).filter(Boolean)));
  const map = new Map<string, boolean>();
  if (!uniqueIds.length) return map;
  const placeholders = uniqueIds.map((_, index) => `?${index + 2}`).join(', ');
  const rows = await env.DB.prepare(
    `SELECT id, vat_enabled FROM stock_items WHERE workspace_id = ?1 AND id IN (${placeholders})`
  )
    .bind(workspaceId, ...uniqueIds)
    .all<{ id: string; vat_enabled: number }>();
  for (const row of rows.results || []) {
    map.set(text(row.id), Number(row.vat_enabled ?? 1) !== 0);
  }
  return map;
}

/** Master-item fallback used only when no location-specific price row exists. */
export function fallbackStockItemUnitCost(item: Row | null | undefined, fallback = 0) {
  if (!item) return numberValue(fallback, 0);
  const column = numberValue(item.unit_cost ?? item.unitCost, NaN);
  if (Number.isFinite(column) && column !== 0) return column;
  const raw = jsonObject(item.raw_json ?? item.rawJson);
  const candidate = raw.lastPurchasePrice
    ?? raw.lastPurchaseCost
    ?? raw.latestPurchasePrice
    ?? raw.costEx
    ?? raw.cost
    ?? raw.unitCost;
  const parsed = numberValue(candidate, NaN);
  return Number.isFinite(parsed) ? parsed : numberValue(fallback, 0);
}

export interface LocationCostResolution {
  cost: number;
  source: 'location' | 'fallback';
  hasLocationPrice: boolean;
}

/**
 * Resolve the current valuation cost for one item/location.
 * A stored price of 0 is deliberate and must not be treated as missing.
 */
export async function resolveLocationUnitCost(
  env: Env,
  workspaceId: string,
  stockItemId: string,
  locationId: string,
  fallbackItemOrCost: Row | number | null | undefined = 0
): Promise<LocationCostResolution> {
  const row = await env.DB.prepare(
    `SELECT price
       FROM stock_item_location_prices
      WHERE workspace_id = ?1
        AND stock_item_id = ?2
        AND location_id = ?3
      LIMIT 1`
  ).bind(workspaceId, stockItemId, locationId).first<Row>();

  if (row && row.price !== undefined && row.price !== null) {
    return { cost: numberValue(row.price, 0), source: 'location', hasLocationPrice: true };
  }

  const fallback = typeof fallbackItemOrCost === 'number'
    ? numberValue(fallbackItemOrCost, 0)
    : fallbackStockItemUnitCost(fallbackItemOrCost || undefined, 0);
  return { cost: fallback, source: 'fallback', hasLocationPrice: false };
}

/** Cost to persist after an inbound quantity is added at a location. */
export function calculateIncomingLocationCost(input: {
  method: unknown;
  previousQuantity: unknown;
  previousUnitCost: unknown;
  incomingQuantity: unknown;
  incomingUnitCost: unknown;
}) {
  const method = normalizeInventoryCostingMethod(input.method);
  const previousCost = numberValue(input.previousUnitCost, 0);
  const incomingCost = numberValue(input.incomingUnitCost, previousCost);
  if (method === 'last') return incomingCost;

  const previousQuantity = Math.max(numberValue(input.previousQuantity, 0), 0);
  const incomingQuantity = Math.max(numberValue(input.incomingQuantity, 0), 0);
  const totalQuantity = previousQuantity + incomingQuantity;
  if (totalQuantity <= 0) return incomingCost;
  return ((previousQuantity * previousCost) + (incomingQuantity * incomingCost)) / totalQuantity;
}

export function upsertLocationCostStatement(
  env: Env,
  workspaceId: string,
  stockItemId: string,
  locationId: string,
  unitCost: number,
  updatedAt: string
): DbStatementLike {
  return env.DB.prepare(
    `INSERT INTO stock_item_location_prices (workspace_id, stock_item_id, location_id, price, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
      price = excluded.price,
      updated_at = excluded.updated_at`
  ).bind(workspaceId, stockItemId, locationId, numberValue(unitCost, 0), updatedAt);
}
