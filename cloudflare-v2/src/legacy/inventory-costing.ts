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

/**
 * Whether a SUPPLIER is VAT registered — a different concept from isWorkspaceVatRegistered (which
 * is about whether THIS business can reclaim VAT). A non-VAT-registered supplier never charges VAT
 * on anything they sell, regardless of whether the item itself is normally VATable (bread vs beer)
 * — so a GRV/PO/Credit Note line must carry VAT only when BOTH the stock item is VATable AND the
 * supplier is VAT registered. Stored in suppliers.raw_json (like most other supplier fields —
 * there's no dedicated column), defaulting to true when unset or when there's no supplier at all
 * (a manual/no-supplier receipt), matching stock_items.vat_enabled's own "assume VATable" default.
 */
export async function isSupplierVatRegistered(env: Env, workspaceId: string, supplierId: string): Promise<boolean> {
  if (!supplierId) return true;
  const row = await env.DB.prepare(
    `SELECT raw_json FROM suppliers WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`
  ).bind(supplierId, workspaceId).first<{ raw_json?: string }>();
  if (!row?.raw_json) return true;
  try {
    const parsed = jsonObject(row.raw_json);
    return parsed.vatRegistered !== false;
  } catch {
    return true;
  }
}

export interface VatAwareLineInput {
  stockItemId?: unknown;
  lineTotalEx?: unknown;
}

export interface VatAwareLineTotals {
  totalEx: number;
  totalVat: number;
  totalInc: number;
  /** Sum of only the VATable lines' ex-VAT amounts — the base a header-level discount's VAT
   * portion must be pro-rated against (see applyProRataDiscount below), since totalVat is not a
   * flat rate on the whole order. */
  taxableEx: number;
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
 *
 * `supplierIsVatRegistered` (default true) is a second, independent gate on top of vat_enabled: a
 * non-VAT-registered supplier never charges VAT on anything, so when false, EVERY line is treated
 * as non-VATable regardless of its own stock item's vat_enabled flag — bread and beer alike.
 */
export function sumVatAwareLineTotals(
  items: VatAwareLineInput[],
  vatRate: number,
  vatEnabledByStockItemId: Map<string, boolean>,
  linesAreAlreadyVatInclusive = false,
  supplierIsVatRegistered = true
): VatAwareLineTotals {
  let totalEx = 0;
  let totalVat = 0;
  let taxableEx = 0;
  for (const line of items) {
    const submitted = numberValue(line.lineTotalEx, 0);
    const stockItemId = text(line.stockItemId);
    const isVatable = supplierIsVatRegistered && vatEnabledByStockItemId.get(stockItemId) !== false;
    if (!isVatable) {
      totalEx += submitted;
      continue;
    }
    if (linesAreAlreadyVatInclusive) {
      const ex = submitted / (1 + vatRate);
      totalEx += ex;
      taxableEx += ex;
      totalVat += submitted - ex;
    } else {
      totalEx += submitted;
      taxableEx += submitted;
      totalVat += submitted * vatRate;
    }
  }
  return { totalEx, totalVat, totalInc: totalEx + totalVat, taxableEx };
}

/**
 * Applies a header-level discount (GRV's "Discount (Ex)" field) across pre-discount VAT-aware
 * totals, pro-rating the VAT reduction by the taxable share of the order — mirrors
 * GRVEntry.js's calculateDraftTotals exactly (discountTaxableShare/taxableAfterDiscount), so the
 * saved/pushed totals match what the user saw in the live preview. A discount is NOT modeled as
 * its own line with its own VAT rate — a discount on a mixed bread+beer GRV reduces both the
 * taxable and non-taxable spend in proportion to their share of the pre-discount subtotal, not
 * at a single flat rate applied to the whole discount amount.
 *
 * Unlike item unit costs, the "Discount (Ex)" (and "Transport (Ex)", see computeGrvTotals below)
 * field is ALWAYS a genuine ex-VAT figure — confirmed with David 2026-09-01 — regardless of
 * whether the workspace is VAT-registered: VAT is always calculated by adding the rate on top,
 * same as this function has always done, and it's only the RESULT that becomes non-reclaimable
 * (folded into a final inclusive figure) for a non-registered workspace, not the discount's own
 * input direction. So this function needs no registration awareness at all — an earlier attempt to
 * add a `discountIsAlreadyVatInclusive` parameter was based on a wrong assumption and has been
 * reverted; the actual registration-aware bug was in how the Transport line was computed (see
 * computeGrvTotals's own comment for the real root cause and the correct combined total).
 */
export function applyProRataDiscount(preDiscount: VatAwareLineTotals, discountEx: number, vatRate: number): VatAwareLineTotals {
  const discount = Math.max(0, numberValue(discountEx, 0));
  if (!discount) return preDiscount;
  const subtotal = preDiscount.totalEx;
  const discountTaxableShare = subtotal > 0 ? discount * (preDiscount.taxableEx / subtotal) : 0;
  const taxableEx = Math.max(0, preDiscount.taxableEx - discountTaxableShare);
  const totalEx = Math.max(0, subtotal - discount);
  const totalVat = taxableEx * vatRate;
  return { totalEx, totalVat, totalInc: totalEx + totalVat, taxableEx };
}

export interface GrvTotals extends VatAwareLineTotals {
  transportEx: number;
  transportVat: number;
  transportInc: number;
  // The discount's OWN net impact (always <= 0) on each figure — i.e. postDiscount minus
  // preDiscount — handy for callers (the transaction-detail drawer, the Xero push) that need to
  // show/push the discount as its own line rather than only the combined final totals.
  discountExImpact: number;
  discountVatImpact: number;
  discountIncImpact: number;
}

/**
 * Single source of truth for a GRV's combined item + transport + discount totals — used by
 * postGoodsReceipt (what gets saved), loadGrvDetail (the transaction-detail drawer), and the Xero
 * GRV push, so this math can't silently diverge across call sites the way it did before this fix.
 *
 * Root cause this replaces: `transport_ex` was previously fed through `sumVatAwareLineTotals`
 * ALONGSIDE stock items using the SAME `linesAreAlreadyVatInclusive` flag — i.e. for a
 * non-registered workspace, transport was treated as an already-VAT-inclusive figure and its
 * ex-VAT/VAT split was backed OUT of it, exactly like a stock item's folded cost. But confirmed
 * with David: the "Transport (Ex)" field (like "Discount (Ex)") is ALWAYS a genuine ex-VAT amount
 * regardless of registration — VAT is always calculated by adding the rate on top (matching
 * GRVEntry.js's renderTransportRow, which has always done exactly this, unconditionally). For a
 * non-registered workspace that added VAT is simply non-reclaimable, so it must still be added
 * before being folded into the final total — backing it out instead (the old bug) silently
 * understated a GRV's true total by the transport line's own VAT amount.
 *
 * Concrete regression this fixes: R100 bread (not VATable) + R115 water (VAT-inclusive, an item,
 * folds correctly to R100 ex/R15 VAT) + R100 transport (Ex, VAT-registered supplier) + R50
 * discount (Ex), non-registered workspace. Transport's own VAT is R15 (100 * 15%), giving a true
 * pre-discount total of R330 — the R50 discount (always ex-VAT, pro-rated over the R200 taxable
 * base out of R300 ex-VAT) removes R55 of real value (R50 ex + its own R5 VAT share), landing on
 * the correct final total of R275.00 — not R265 (transport's VAT dropped) or R260.11 (transport's
 * VAT AND part of the discount's own VAT reduction both dropped), both of which were live bugs.
 */
export function computeGrvTotals(input: {
  items: VatAwareLineInput[];
  vatRate: number;
  vatEnabledByStockItemId: Map<string, boolean>;
  linesAreAlreadyVatInclusive: boolean;
  supplierIsVatRegistered: boolean;
  transportEx: number;
  discountEx: number;
}): GrvTotals {
  const itemTotals = sumVatAwareLineTotals(
    input.items,
    input.vatRate,
    input.vatEnabledByStockItemId,
    input.linesAreAlreadyVatInclusive,
    input.supplierIsVatRegistered
  );
  return applyGrvTransportAndDiscount(itemTotals, {
    vatRate: input.vatRate,
    supplierIsVatRegistered: input.supplierIsVatRegistered,
    transportEx: input.transportEx,
    discountEx: input.discountEx
  });
}

/**
 * The transport/discount half of computeGrvTotals, split out so a caller that already has
 * TRUSTED, already-computed item totals (e.g. loadGrvDetail's transaction-detail drawer, reading
 * back already-saved `grv_lines` rows) can reuse the exact same transport/discount math without
 * having to reconstruct the original raw per-item inputs just to feed them back through
 * `sumVatAwareLineTotals` a second time.
 */
export function applyGrvTransportAndDiscount(
  itemTotals: VatAwareLineTotals,
  input: { vatRate: number; supplierIsVatRegistered: boolean; transportEx: number; discountEx: number }
): GrvTotals {
  const transportEx = Math.max(0, numberValue(input.transportEx, 0));
  // Transport is taxable exactly when the supplier can charge VAT at all — it isn't tied to any
  // one stock item's vat_enabled, and (unlike stock lines) never depends on workspace
  // registration for its OWN input direction.
  const transportIsVatable = input.supplierIsVatRegistered && transportEx > 0;
  const transportVat = transportIsVatable ? transportEx * input.vatRate : 0;
  const transportInc = transportEx + transportVat;
  const preDiscount: VatAwareLineTotals = {
    totalEx: itemTotals.totalEx + transportEx,
    totalVat: itemTotals.totalVat + transportVat,
    taxableEx: itemTotals.taxableEx + (transportIsVatable ? transportEx : 0),
    totalInc: itemTotals.totalInc + transportInc
  };
  const postDiscount = applyProRataDiscount(preDiscount, input.discountEx, input.vatRate);
  return {
    ...postDiscount,
    transportEx,
    transportVat,
    transportInc,
    discountExImpact: postDiscount.totalEx - preDiscount.totalEx,
    discountVatImpact: postDiscount.totalVat - preDiscount.totalVat,
    discountIncImpact: postDiscount.totalInc - preDiscount.totalInc
  };
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

/**
 * Pure WAC/last-cost replay used to work out which sales got costed wrong because a GRV line's
 * cost was entered incorrectly and has now been corrected on edit (e.g. R2 typed instead of R20)
 * — see routes.ts's patchGoodsReceipt/buildSameDayCostCorrectionStatements for how the inputs are
 * built (that caller's query window runs from the GRV's receipt through to now, not just its own
 * trading day, so a mistake caught days later still gets every affected sale corrected) and how
 * the resulting corrections are turned into compensating ledger entries.
 *
 * Starts from the balance/cost immediately after the (now-revised) GRV line posts, then walks
 * every later stock_item+location movement in the caller's window in order: an inbound movement blends
 * into the running cost exactly like a fresh GRV would (calculateIncomingLocationCost — under
 * 'last' costing this just resets to that movement's own cost, under 'wac' it blends); an outbound
 * movement carries the current running cost forward, and if it's a sale whose recorded cost
 * doesn't match what the replay says it should have been, it's flagged for a compensating entry.
 * Non-sale outbound movements (credit notes, wastage, adjustments-out) still consume from the
 * ledger correctly but are never "corrected" themselves — only sales feed margin/GP reporting.
 *
 * `events` must already be in chronological order (occurred_at, then created_at as a tiebreak),
 * and unitCost for a sale event must be its CURRENT EFFECTIVE cost (i.e. after any earlier
 * correction from a previous edit of this same GRV), not necessarily what's on the original row —
 * the caller is responsible for resolving that before calling this. Lives here (rather than in
 * routes.ts, where it's used) purely so it can be unit tested without pulling in routes.ts's
 * Worker-runtime-only imports.
 */
export function replaySameDayCostCorrections(input: {
  costingMethod: unknown;
  startingQuantity: number;
  startingUnitCost: number;
  events: Array<{ id: string; quantityDelta: number; unitCost: number; isSale: boolean }>;
}): Array<{ id: string; correctedUnitCost: number }> {
  let quantity = Math.max(input.startingQuantity, 0);
  let cost = input.startingUnitCost;
  const corrections: Array<{ id: string; correctedUnitCost: number }> = [];
  for (const event of input.events) {
    if (event.quantityDelta > 0) {
      cost = calculateIncomingLocationCost({
        method: input.costingMethod,
        previousQuantity: quantity,
        previousUnitCost: cost,
        incomingQuantity: event.quantityDelta,
        incomingUnitCost: event.unitCost,
      });
      quantity += event.quantityDelta;
    } else if (event.quantityDelta < 0) {
      if (event.isSale && Math.abs(event.unitCost - cost) > 0.0001) {
        corrections.push({ id: event.id, correctedUnitCost: cost });
      }
      quantity = Math.max(quantity + event.quantityDelta, 0);
    }
  }
  return corrections;
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
