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
 * Effective VAT rate (as a fraction, e.g. 0.15) to use for GRV/PO ex-VAT extraction and other
 * costing math. Returns exactly 0 when the workspace is not VAT registered, regardless of the
 * configured percentage — a non-registered business never adds/reclaims VAT on its costs.
 */
export async function getWorkspaceEffectiveVatRate(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT vat_rate, vat_registered
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`
  ).bind(workspaceId).first<{ vat_rate?: number; vat_registered?: number }>();
  if (!row) return 0.15;
  if (Number(row.vat_registered ?? 1) === 0) return 0;
  const percent = numberValue(row.vat_rate, 15);
  return (percent > 0 ? percent : 15) / 100;
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
