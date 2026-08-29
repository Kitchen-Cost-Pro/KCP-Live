import type { AuthContext, Env } from "./types";
import { assertWorkspaceAccess, assertReportLocationScope, getResolvedReportLocationScope } from "./auth";
import { json, limitFromUrl, offsetFromUrl } from "./http";
// @ts-ignore Shared timezone helpers used by the reporting client and Worker.
import {
  localDateRangeToUtcBounds,
  normalizeReportTimeZone,
  normalizeTradingDayStartMinutes,
  zonedTradingDateTimeStrings,
  zonedTradingDisplayTimestamp,
} from "../../../src/modules/reporting/engine/timezone.js";
import {
  historicalTransactionReference,
  resolveTransactionReferences,
} from "./transaction-references";
import { getWorkspaceEffectiveVatRate } from "./inventory-costing";

type Row = Record<string, any>;
type Warning = { code: string; level: string; message: string };
const MAX_ROWS = 1000000;

export async function getStockOnHandReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);
  const context = await reportContext(request, env, workspaceId, 3000);
  const { filters, limit, offset, generatedAt, timeZone, tradingDayStartMinutes } = context;
  const tables = await tableStatus(env, [
    "stock_items",
    "stock_balances",
    "locations",
    "stock_movements",
    "stock_item_location_prices",
    "grvs",
    "grv_lines",
    "suppliers",
  ]);
  const warnings: Warning[] = [];
  if (!tables.stock_items || !tables.locations)
    return emptyReport(
      request,
      env,
      workspaceId,
      context,
      tables,
      "stock-on-hand-missing-source-tables",
      "Stock on Hand cannot load because stock_items or locations are missing.",
    );

  const useBalances = tables.stock_balances;
  if (!useBalances && !tables.stock_movements)
    return emptyReport(
      request,
      env,
      workspaceId,
      context,
      tables,
      "stock-on-hand-no-balance-source",
      "No stock balance table or stock movement ledger is available.",
    );
  if (!useBalances)
    warnings.push({
      code: "stock-on-hand-ledger-fallback",
      level: "warning",
      message:
        "The trusted stock_balances table is unavailable. Location-specific closing stock was derived from stock_movements.",
    });

  const movementCtes = tables.stock_movements
    ? `
    movement_totals AS (
      SELECT workspace_id, stock_item_id, location_id,
             SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) AS qty_in,
             SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END) AS qty_out,
             SUM(quantity_delta) AS ledger_closing_stock,
             MAX(occurred_at) AS last_movement_date
        FROM stock_movements WHERE workspace_id = ?1
       GROUP BY workspace_id, stock_item_id, location_id
    ),
    latest_movement AS (
      SELECT * FROM (
        SELECT workspace_id, stock_item_id, location_id, movement_type, document_id,
               occurred_at, ROW_NUMBER() OVER (PARTITION BY workspace_id, stock_item_id, location_id ORDER BY datetime(occurred_at) DESC, datetime(created_at) DESC, id DESC) AS rn
          FROM stock_movements WHERE workspace_id = ?1
      ) WHERE rn = 1
    )`
    : `
    movement_totals AS (SELECT '' workspace_id, '' stock_item_id, '' location_id, 0 qty_in, 0 qty_out, 0 ledger_closing_stock, '' last_movement_date WHERE 0),
    latest_movement AS (SELECT '' workspace_id, '' stock_item_id, '' location_id, '' movement_type, '' document_id, '' occurred_at, 1 rn WHERE 0)`;
  const purchaseCte =
    tables.grvs && tables.grv_lines
      ? `,
    latest_purchase AS (
      SELECT * FROM (
        SELECT gl.workspace_id, gl.stock_item_id, gl.location_id, g.supplier_id,
               ${tables.suppliers ? "s.name" : "''"} AS supplier_name,
               ROW_NUMBER() OVER (PARTITION BY gl.workspace_id, gl.stock_item_id, gl.location_id ORDER BY datetime(g.received_at) DESC, gl.id DESC) AS rn
          FROM grv_lines gl JOIN grvs g ON g.id = gl.grv_id AND g.workspace_id = gl.workspace_id
          ${tables.suppliers ? "LEFT JOIN suppliers s ON s.id = g.supplier_id AND s.workspace_id = g.workspace_id" : ""}
         WHERE gl.workspace_id = ?1
      ) WHERE rn = 1
    )`
      : `,
    latest_purchase AS (SELECT '' workspace_id, '' stock_item_id, '' location_id, '' supplier_id, '' supplier_name, 1 rn WHERE 0)`;
  const baseFrom = useBalances
    ? `stock_balances sb JOIN stock_items si ON si.id = sb.stock_item_id AND si.workspace_id = sb.workspace_id JOIN locations l ON l.id = sb.location_id AND l.workspace_id = sb.workspace_id`
    : `movement_totals base JOIN stock_items si ON si.id = base.stock_item_id AND si.workspace_id = base.workspace_id JOIN locations l ON l.id = base.location_id AND l.workspace_id = base.workspace_id`;
  const currentStock = useBalances
    ? "sb.quantity"
    : "base.ledger_closing_stock";
  const updatedAt = useBalances ? "sb.updated_at" : "base.last_movement_date";
  const baseWorkspace = useBalances ? "sb.workspace_id" : "base.workspace_id";
  const baseItem = useBalances ? "sb.stock_item_id" : "base.stock_item_id";
  const baseLocation = useBalances ? "sb.location_id" : "base.location_id";
  const priceJoin = tables.stock_item_location_prices
    ? `LEFT JOIN stock_item_location_prices silp ON silp.workspace_id = ${baseWorkspace} AND silp.stock_item_id = ${baseItem} AND silp.location_id = ${baseLocation}`
    : "";
  const priceSelect = tables.stock_item_location_prices
    ? "CASE WHEN silp.stock_item_id IS NOT NULL THEN COALESCE(silp.price, 0) ELSE COALESCE(si.unit_cost, 0) END"
    : "COALESCE(si.unit_cost, 0)";
  const rows = await env.DB.prepare(
    `WITH ${movementCtes}${purchaseCte}
    SELECT ${baseItem} AS stock_item_id, ${baseLocation} AS location_id,
           si.name AS item_name, si.category, si.item_type, si.unit AS base_uom,
           si.threshold_qty, si.par_level_qty, si.is_stocked, si.raw_json AS stock_raw_json,
           COALESCE(l.display_name, l.name, l.external_name, l.id) AS location_name,
           ${currentStock} AS current_stock, ${updatedAt} AS balance_updated_at,
           ${priceSelect} AS resolved_unit_cost,
           COALESCE(mt.qty_in, 0) AS qty_in, COALESCE(mt.qty_out, 0) AS qty_out,
           lm.movement_type AS last_movement_type, lm.occurred_at AS last_movement_date,
           lm.document_id AS last_source_id, lp.supplier_id, lp.supplier_name
      FROM ${baseFrom}
      ${priceJoin}
      LEFT JOIN movement_totals mt ON mt.workspace_id = ${baseWorkspace} AND mt.stock_item_id = ${baseItem} AND mt.location_id = ${baseLocation}
      LEFT JOIN latest_movement lm ON lm.workspace_id = ${baseWorkspace} AND lm.stock_item_id = ${baseItem} AND lm.location_id = ${baseLocation}
      LEFT JOIN latest_purchase lp ON lp.workspace_id = ${baseWorkspace} AND lp.stock_item_id = ${baseItem} AND lp.location_id = ${baseLocation}
     WHERE ${baseWorkspace} = ?1 AND COALESCE(si.active, 1) = 1 AND COALESCE(l.active, 1) = 1
     ORDER BY location_name, si.category, si.name LIMIT ${MAX_ROWS}`,
  )
    .bind(workspaceId)
    .all<Row>();

  const canonicalSourceRows = dedupeRowsByKey(
    rows.results || [],
    (row) => `${clean(row.stock_item_id)}:${clean(row.location_id)}`,
  );
  let excludedRecipeOnly = 0;
  const standardized = canonicalSourceRows.flatMap((row, index) => {
    const raw = parseJson(row.stock_raw_json);
    if (isRecipeOnly(row, raw)) {
      excludedRecipeOnly += 1;
      return [];
    }
    if (number(row.is_stocked, 1) === 0 && !allowsStock(raw)) return [];
    const currentStock = number(row.current_stock);
    const unitCost = number(row.resolved_unit_cost);
    const qtyIn = number(row.qty_in);
    const qtyOut = number(row.qty_out);
    const threshold = number(row.threshold_qty);
    const par = number(row.par_level_qty);
    return [
      {
        id: `soh:${clean(row.stock_item_id)}:${clean(row.location_id)}:${index}`,
        itemId: clean(row.stock_item_id),
        stockItemId: clean(row.stock_item_id),
        itemName: clean(row.item_name),
        sku:
          clean(
            raw.sku || raw.SKU || raw.code || raw.itemCode || raw.item_code,
          ) || `SKU - ${clean(row.item_name, "Unnamed Stock Item")}`,
        category: clean(row.category, "General"),
        locationId: clean(row.location_id),
        locationName: clean(row.location_name),
        currentStock,
        baseUom: clean(row.base_uom),
        unitCostExVat: unitCost,
        stockValue: money(currentStock * unitCost),
        lowStockThreshold: threshold,
        parLevel: par,
        status: stockStatus(currentStock, threshold, par),
        supplierId: clean(row.supplier_id),
        supplierName: clean(row.supplier_name),
        openingStock: quantity(currentStock - qtyIn + qtyOut),
        qtyIn: quantity(qtyIn),
        qtyOut: quantity(qtyOut),
        lastMovementType: title(clean(row.last_movement_type)),
        lastMovementDate: clean(row.last_movement_date),
        lastUpdated: clean(row.balance_updated_at),
        sourceId: clean(row.last_source_id || row.stock_item_id),
        hasLocationBalance: true,
        balanceSource: useBalances ? "stock_balances" : "stock_movements",
      },
    ];
  });
  if (excludedRecipeOnly)
    warnings.push({
      code: "stock-on-hand-recipe-only-excluded",
      level: "warning",
      message: `${excludedRecipeOnly} recipe-only sub-recipe stock row(s) were excluded from Stock on Hand.`,
    });
  const filtered = standardized.filter(
    (row) =>
      matchesCommon(row, filters) &&
      (!filters.status || lower(row.status) === lower(filters.status)) &&
      (!filters.supplierId || row.supplierId === filters.supplierId) &&
      (!filters.supplier ||
        lower(row.supplierName) === lower(filters.supplier)),
  );
  addCountWarning(
    filtered,
    warnings,
    "stock-on-hand-missing-location",
    "critical",
    "stock row(s) are missing a location.",
    (row) => !row.locationName,
  );
  addCountWarning(
    filtered,
    warnings,
    "stock-on-hand-missing-item",
    "critical",
    "stock row(s) are missing an item name.",
    (row) => !row.itemName,
  );
  addCountWarning(
    filtered,
    warnings,
    "stock-on-hand-missing-uom",
    "critical",
    "stock row(s) are missing a base UOM.",
    (row) => !row.baseUom,
  );
  addCountWarning(
    filtered,
    warnings,
    "stock-on-hand-missing-cost",
    "warning",
    "stock row(s) have no unit cost.",
    (row) => row.unitCostExVat <= 0,
  );
  addCountWarning(
    filtered,
    warnings,
    "stock-on-hand-missing-supplier",
    "warning",
    "stock row(s) have no known supplier.",
    (row) =>
      !row.supplierName &&
      (row.currentStock !== 0 || row.parLevel > 0 || row.lowStockThreshold > 0),
  );
  return json(request, env, {
    rows: filtered.slice(offset, offset + limit),
    warnings: uniqueWarnings(warnings),
    meta: meta(workspaceId, context, filtered.length, {
      sourceTables: tables,
      stockBalanceSource: useBalances ? "stock_balances" : "stock_movements",
      locationSpecific: true,
      filterOptions: await filterOptions(env, workspaceId, filtered),
    }),
  });
}

export async function getPurchaseOrdersReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);
  const context = await reportContext(request, env, workspaceId, 2000);
  const { filters, limit, offset, timeZone, tradingDayStartMinutes } = context;
  const tables = await tableStatus(env, [
    "purchase_orders",
    "purchase_order_lines",
    "suppliers",
    "locations",
    "stock_items",
    "grvs",
    "grv_lines",
  ]);
  const warnings: Warning[] = [];
  if (!tables.purchase_orders || !tables.purchase_order_lines)
    return emptyReport(
      request,
      env,
      workspaceId,
      context,
      tables,
      "purchase-orders-missing-source-tables",
      "Purchase Orders cannot load because purchase_orders or purchase_order_lines are missing.",
    );
  const clauses = ["po.workspace_id = ?1"];
  const binds: any[] = [workspaceId];
  addDateRange(
    clauses,
    binds,
    "COALESCE(po.ordered_at, po.created_at)",
    filters,
    timeZone,
  );
  addSqlLocationScope(clauses, binds, filters, "po.target_location_id");
  addSqlFilter(clauses, binds, filters.supplierId, "po.supplier_id");
  addSqlFilter(clauses, binds, filters.itemId, "pol.stock_item_id");
  if (filters.status)
    addSqlFilter(clauses, binds, lower(filters.status), "lower(po.status)");
  if (filters.category || filters.categoryId)
    addSqlFilter(
      clauses,
      binds,
      lower(filters.category || filters.categoryId),
      "lower(si.category)",
    );
  const grvJoin =
    tables.grvs && tables.grv_lines
      ? `LEFT JOIN (
      SELECT g.workspace_id, g.purchase_order_id, gl.stock_item_id, gl.location_id,
             SUM(gl.quantity) AS qty_received, SUM(gl.total_ex) AS received_value,
             COUNT(DISTINCT g.id) AS grv_count
        FROM grvs g JOIN grv_lines gl ON gl.grv_id = g.id AND gl.workspace_id = g.workspace_id
       WHERE g.workspace_id = ?1 GROUP BY g.workspace_id, g.purchase_order_id, gl.stock_item_id, gl.location_id
    ) gr ON gr.workspace_id = po.workspace_id AND gr.purchase_order_id = po.id AND gr.stock_item_id = pol.stock_item_id AND (gr.location_id = po.target_location_id OR po.target_location_id IS NULL)`
      : "";
  const rows = await env.DB.prepare(
    `SELECT pol.id AS line_id, po.id AS po_id, po.po_number, po.supplier_id, po.target_location_id,
      po.status, po.ordered_at, po.expected_at, po.total_ex AS po_total_ex, po.total_vat AS po_total_vat,
      po.total_inc AS po_total_inc, po.raw_json AS po_raw_json,
      ${tables.suppliers ? "s.name" : "''"} AS supplier_name,
      ${tables.locations ? "COALESCE(l.display_name, l.name, l.external_name, l.id)" : "''"} AS location_name,
      pol.stock_item_id, pol.description, pol.quantity AS qty_ordered, pol.unit, pol.unit_price,
      pol.total_ex AS line_total_ex, pol.total_vat AS line_vat, pol.total_inc AS line_total_inc,
      ${tables.stock_items ? "si.name" : "pol.description"} AS item_name,
      ${tables.stock_items ? "si.category" : "'General'"} AS category,
      ${tables.stock_items ? "si.unit" : "pol.unit"} AS base_uom,
      ${tables.grvs && tables.grv_lines ? "COALESCE(gr.qty_received, 0)" : "0"} AS qty_received,
      ${tables.grvs && tables.grv_lines ? "COALESCE(gr.received_value, 0)" : "0"} AS received_value,
      ${tables.grvs && tables.grv_lines ? "COALESCE(gr.grv_count, 0)" : "0"} AS grv_count
    FROM purchase_orders po LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id AND pol.workspace_id = po.workspace_id
    ${tables.suppliers ? "LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.workspace_id = po.workspace_id" : ""}
    ${tables.locations ? "LEFT JOIN locations l ON l.id = po.target_location_id AND l.workspace_id = po.workspace_id" : ""}
    ${tables.stock_items ? "LEFT JOIN stock_items si ON si.id = pol.stock_item_id AND si.workspace_id = pol.workspace_id" : ""}
    ${grvJoin}
    WHERE ${clauses.join(" AND ")} ORDER BY datetime(COALESCE(po.ordered_at, po.created_at)) DESC, po.id, pol.id LIMIT ${MAX_ROWS}`,
  )
    .bind(...binds)
    .all<Row>();
  const canonicalRows = dedupeRowsByKey(rows.results || [], (row) =>
    clean(row.line_id || row.po_id),
  );
  const actorIds: string[] = [];
  const standardized: Row[] = canonicalRows.map((row, index) => {
    const raw = parseJson(row.po_raw_json);
    const hasLine = Boolean(clean(row.line_id));
    const createdId = clean(
      raw.createdBy || raw.created_by || raw.createdById || raw.created_by_id,
    );
    const approvedId = clean(
      raw.approvedBy ||
        raw.approved_by ||
        raw.approvedById ||
        raw.approved_by_id,
    );
    actorIds.push(createdId, approvedId);
    return {
      id: clean(row.line_id) || `po-header:${clean(row.po_id) || index}`,
      hasLine,
      poId: clean(row.po_id),
      sourceId: clean(row.po_id),
      poDate: zonedTradingDateTimeStrings(row.ordered_at || row.created_at, timeZone, tradingDayStartMinutes).date,
      poNumber: clean(row.po_number || raw.poNumber || raw.number || row.po_id),
      supplierId: clean(row.supplier_id),
      supplierName: clean(row.supplier_name),
      locationId: clean(row.target_location_id),
      locationName: clean(row.location_name),
      itemId: clean(row.stock_item_id),
      itemName: hasLine ? clean(row.item_name || row.description) : "",
      category: hasLine ? clean(row.category, "General") : "",
      qtyOrdered: hasLine ? number(row.qty_ordered) : 0,
      qtyReceived: hasLine ? number(row.qty_received) : 0,
      baseUom: hasLine ? clean(row.base_uom || row.unit) : "",
      unitCostExVat: hasLine ? number(row.unit_price) : 0,
      lineValueExVat: money(hasLine ? row.line_total_ex : row.po_total_ex),
      vat: money(hasLine ? row.line_vat : row.po_total_vat),
      lineValueInclVat: money(hasLine ? row.line_total_inc : row.po_total_inc),
      receivedValue: hasLine ? money(row.received_value) : 0,
      grvReceivedValue: hasLine ? money(row.received_value) : 0,
      grvCount: hasLine ? number(row.grv_count) : 0,
      status: title(clean(row.status, "Unknown")),
      expectedDeliveryDate: clean(
        row.expected_at ||
          raw.expectedDeliveryDate ||
          raw.expected_delivery_date,
      ),
      createdById: createdId,
      approvedById: approvedId,
      createdByFallback: clean(raw.createdByName || raw.created_by_name),
      approvedByFallback: clean(raw.approvedByName || raw.approved_by_name),
    };
  });
  const actors = await actorMap(env, workspaceId, actorIds);
  for (const row of standardized) {
    row.createdByName =
      actorName(actors, row.createdById) || clean(row.createdByFallback);
    row.approvedByName =
      actorName(actors, row.approvedById) || clean(row.approvedByFallback);
  }
  const filtered = standardized.filter((row) =>
    matchesSearch(row, filters.search),
  );
  addCountWarning(
    filtered,
    warnings,
    "purchase-order-no-supplier",
    "critical",
    "purchase order line(s) have no supplier.",
    (row) => !row.supplierName,
  );
  addCountWarning(
    filtered,
    warnings,
    "purchase-order-no-location",
    "critical",
    "purchase order line(s) have no location.",
    (row) => !row.locationName,
  );
  addCountWarning(
    filtered,
    warnings,
    "purchase-order-no-lines",
    "critical",
    "purchase order(s) have no line items.",
    (row) => !row.hasLine,
  );
  addCountWarning(
    filtered,
    warnings,
    "purchase-order-missing-item",
    "critical",
    "purchase order line(s) have no item.",
    (row) => row.hasLine && !row.itemName,
  );
  addCountWarning(
    filtered,
    warnings,
    "purchase-order-missing-quantity",
    "critical",
    "purchase order line(s) have no ordered quantity.",
    (row) => row.hasLine && row.qtyOrdered <= 0,
  );
  addCountWarning(
    filtered,
    warnings,
    "purchase-order-missing-cost",
    "critical",
    "purchase order line(s) have no unit cost.",
    (row) => row.hasLine && row.unitCostExVat <= 0,
  );
  addCountWarning(
    filtered,
    warnings,
    "purchase-order-status-unclear",
    "warning",
    "purchase order line(s) have an unclear status.",
    (row) =>
      ![
        "Draft",
        "Pending",
        "Approved",
        "Partially Received",
        "Received",
        "Cancelled",
      ].includes(row.status),
  );
  addCountWarning(
    filtered,
    warnings,
    "purchase-order-received-without-grv",
    "critical",
    "received purchase order line(s) have no linked GRV.",
    (row) => row.hasLine && row.status === "Received" && row.grvCount <= 0,
  );
  return json(request, env, {
    rows: filtered.slice(offset, offset + limit),
    warnings: uniqueWarnings(warnings),
    meta: meta(workspaceId, context, filtered.length, {
      sourceTables: tables,
      purchaseOrderSource: "purchase_orders + purchase_order_lines",
      grvReconciliationAvailable: tables.grvs && tables.grv_lines,
      filterOptions: await filterOptions(env, workspaceId, filtered),
    }),
  });
}

export async function getGrvLogReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);
  const context = await reportContext(request, env, workspaceId, 2000);
  const { filters, limit, offset, timeZone, tradingDayStartMinutes } = context;
  const tables = await tableStatus(env, [
    "grvs",
    "grv_lines",
    "suppliers",
    "locations",
    "stock_items",
    "stock_movements",
    "purchase_orders",
  ]);
  const warnings: Warning[] = [];
  if (!tables.grvs || !tables.grv_lines)
    return emptyReport(
      request,
      env,
      workspaceId,
      context,
      tables,
      "grv-log-missing-source-tables",
      "GRV Log cannot load because grvs or grv_lines are missing.",
    );
  const clauses = ["g.workspace_id = ?1"];
  const binds: any[] = [workspaceId];
  addDateRange(clauses, binds, "g.received_at", filters, timeZone);
  addSqlLocationScope(clauses, binds, filters, "gl.location_id");
  addSqlFilter(clauses, binds, filters.supplierId, "g.supplier_id");
  addSqlFilter(clauses, binds, filters.itemId, "gl.stock_item_id");
  if (filters.category || filters.categoryId)
    addSqlFilter(
      clauses,
      binds,
      lower(filters.category || filters.categoryId),
      "lower(si.category)",
    );
  const ledgerJoin = tables.stock_movements
    ? `LEFT JOIN (SELECT workspace_id, document_id, stock_item_id, location_id, SUM(quantity_delta) ledger_qty, SUM(value_delta) ledger_value, COUNT(*) ledger_rows FROM stock_movements WHERE workspace_id = ?1 AND document_type = 'grv' GROUP BY workspace_id, document_id, stock_item_id, location_id) sm ON sm.workspace_id = g.workspace_id AND sm.document_id = g.id AND sm.stock_item_id = gl.stock_item_id AND sm.location_id = gl.location_id`
    : "";
  const rows = await env.DB.prepare(
    `SELECT gl.id, g.id grv_id, g.invoice_number, g.purchase_order_id, g.received_at, g.total_ex grv_total_ex, g.total_vat grv_total_vat, g.total_inc grv_total_inc, g.created_by, g.created_at, g.raw_json grv_raw_json, g.supplier_id,
      ${tables.suppliers ? "s.name" : "''"} supplier_name, gl.location_id, ${tables.locations ? "COALESCE(l.display_name,l.name,l.external_name,l.id)" : "''"} location_name,
      gl.stock_item_id, ${tables.stock_items ? "si.name" : "''"} item_name, ${tables.stock_items ? "si.category" : "'General'"} category, ${tables.stock_items ? "si.unit" : "gl.unit"} base_uom,
      gl.quantity received_qty, gl.unit_price, gl.total_ex line_total_ex, gl.total_vat line_vat, gl.total_inc line_total_inc,
      ${tables.stock_movements ? "COALESCE(sm.ledger_qty,0)" : "0"} ledger_qty, ${tables.stock_movements ? "COALESCE(sm.ledger_value,0)" : "0"} ledger_value, ${tables.stock_movements ? "COALESCE(sm.ledger_rows,0)" : "0"} ledger_rows,
      ${tables.purchase_orders ? "po.po_number" : "''"} po_number
    FROM grvs g JOIN grv_lines gl ON gl.grv_id=g.id AND gl.workspace_id=g.workspace_id
    ${tables.suppliers ? "LEFT JOIN suppliers s ON s.id=g.supplier_id AND s.workspace_id=g.workspace_id" : ""}
    ${tables.locations ? "LEFT JOIN locations l ON l.id=gl.location_id AND l.workspace_id=gl.workspace_id" : ""}
    ${tables.stock_items ? "LEFT JOIN stock_items si ON si.id=gl.stock_item_id AND si.workspace_id=gl.workspace_id" : ""}
    ${tables.purchase_orders ? "LEFT JOIN purchase_orders po ON po.id=g.purchase_order_id AND po.workspace_id=g.workspace_id" : ""}
    ${ledgerJoin} WHERE ${clauses.join(" AND ")} ORDER BY datetime(g.received_at) DESC,g.id,gl.id LIMIT ${MAX_ROWS}`,
  )
    .bind(...binds)
    .all<Row>();
  const canonicalRows = dedupeRowsByKey(rows.results || [], (row) =>
    clean(row.id || row.grv_id),
  );
  const grvReferences = await resolveTransactionReferences(
    env,
    workspaceId,
    canonicalRows,
    "grv",
    "grv_id",
  );
  const actors = await actorMap(
    env,
    workspaceId,
    canonicalRows.map((row) => row.created_by),
  );
  const standardized = canonicalRows.map((row, index) => {
    const raw = parseJson(row.grv_raw_json);
    return {
      id: clean(row.id) || `grv-line:${index}`,
      grvId: clean(row.grv_id),
      sourceId: clean(row.grv_id),
      transactionReference:
        grvReferences.get(clean(row.grv_id)) ||
        clean(raw.transactionReference) ||
        historicalTransactionReference(
          "grv",
          row.grv_id,
          row.received_at || row.created_at,
        ),
      grvDate: zonedTradingDisplayTimestamp(row.received_at, timeZone, tradingDayStartMinutes),
      grvNumber: clean(
        raw.grvNumber || raw.grv_number || raw.reference || row.grv_id,
      ),
      supplierId: clean(row.supplier_id),
      supplierName: clean(row.supplier_name),
      invoiceNumber: clean(row.invoice_number),
      invoiceRequired: boolean(
        raw.invoiceRequired ??
          raw.invoice_required ??
          raw.requiresInvoice ??
          raw.requires_invoice,
      ),
      purchaseOrderId: clean(row.purchase_order_id),
      purchaseOrderNumber: clean(row.po_number),
      locationId: clean(row.location_id),
      locationName: clean(row.location_name),
      itemId: clean(row.stock_item_id),
      itemName: clean(row.item_name),
      category: clean(row.category, "General"),
      receivedQty: number(row.received_qty),
      baseUom: clean(row.base_uom),
      unitCostExVat: number(row.unit_price),
      lineValueExVat: money(row.line_total_ex),
      vat: money(row.line_vat),
      lineValueInclVat: money(row.line_total_inc),
      status: title(clean(raw.status, "Committed")),
      committedBy: actorName(actors, row.created_by) || clean(row.created_by),
      committedAt: zonedTradingDisplayTimestamp(row.created_at || row.received_at, timeZone, tradingDayStartMinutes),
      ledgerQty: number(row.ledger_qty),
      ledgerValue: money(row.ledger_value),
      ledgerRowCount: number(row.ledger_rows),
      detailedActivitySourceType: row.purchase_order_id
        ? "Purchase Order Receive"
        : "GRV",
    };
  });
  const filtered = standardized.filter(
    (row) =>
      matchesCommon(row, filters) &&
      (!filters.status || lower(row.status) === lower(filters.status)) &&
      (!filters.supplier ||
        lower(row.supplierName) === lower(filters.supplier)) &&
      matchesSearch(row, filters.search),
  );
  addCountWarning(
    filtered,
    warnings,
    "grv-no-supplier",
    "critical",
    "GRV line(s) have no supplier.",
    (r) => !r.supplierName,
  );
  addCountWarning(
    filtered,
    warnings,
    "grv-no-location",
    "critical",
    "GRV line(s) have no location.",
    (r) => !r.locationName,
  );
  addCountWarning(
    filtered,
    warnings,
    "grv-missing-item",
    "critical",
    "GRV line(s) have no item.",
    (r) => !r.itemName,
  );
  addCountWarning(
    filtered,
    warnings,
    "grv-missing-quantity",
    "critical",
    "GRV line(s) have no received quantity.",
    (r) => r.receivedQty <= 0,
  );
  addCountWarning(
    filtered,
    warnings,
    "grv-missing-cost",
    "critical",
    "GRV line(s) have no unit cost.",
    (r) => r.unitCostExVat <= 0,
  );
  if (tables.stock_movements) {
    addCountWarning(
      filtered,
      warnings,
      "grv-no-stock-movement",
      "critical",
      "committed GRV line(s) have no stock movement row.",
      (r) => r.ledgerRowCount <= 0,
    );
    addCountWarning(
      filtered,
      warnings,
      "grv-duplicate-stock-movement",
      "critical",
      "GRV line(s) have duplicate stock movement rows.",
      (r) => r.ledgerRowCount > 1,
    );
    addCountWarning(
      filtered,
      warnings,
      "grv-ledger-mismatch",
      "critical",
      "GRV line(s) do not reconcile to the stock ledger.",
      (r) =>
        r.ledgerRowCount > 0 &&
        (Math.abs(r.receivedQty - r.ledgerQty) > 0.0001 ||
          Math.abs(r.lineValueExVat - r.ledgerValue) > 0.01),
    );
  }
  return json(request, env, {
    rows: filtered.slice(offset, offset + limit),
    warnings: uniqueWarnings(warnings),
    meta: meta(workspaceId, context, filtered.length, {
      sourceTables: tables,
      grvSource: "grvs + grv_lines",
      reconciliationSource: "stock_movements document_type='grv'",
      detailedActivitySourceTypes: ["GRV", "Purchase Order Receive"],
      grvReconciled: tables.stock_movements
        ? filtered.every(
            (r) =>
              r.ledgerRowCount === 1 &&
              Math.abs(r.receivedQty - r.ledgerQty) <= 0.0001 &&
              Math.abs(r.lineValueExVat - r.ledgerValue) <= 0.01,
          )
        : null,
      filterOptions: await filterOptions(env, workspaceId, filtered),
    }),
  });
}

export async function getCreditNotesReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);
  const context = await reportContext(request, env, workspaceId, 2000);
  const { filters, limit, offset, timeZone, tradingDayStartMinutes } = context;
  const tables = await tableStatus(env, [
    "credit_notes",
    "credit_note_lines",
    "suppliers",
    "locations",
    "stock_items",
    "stock_movements",
    "workspace_settings",
  ]);
  const warnings: Warning[] = [];
  if (!tables.credit_notes || !tables.credit_note_lines)
    return emptyReport(
      request,
      env,
      workspaceId,
      context,
      tables,
      "credit-notes-missing-source-tables",
      "Credit Notes cannot load because credit_notes or credit_note_lines are missing.",
    );
  // Must use the same registration-aware rate everywhere else in the app derives VAT from a
  // stored cost (getWorkspaceEffectiveVatRate) — a hand-rolled `vat_rate`-only lookup ignored
  // `vat_registered`, so for a non-VAT-registered workspace it kept applying the full rate on
  // top of `unit_cost`, which is already VAT-inclusive for that workspace (see
  // finalizeReceivedCost in GRVEntry.js). That double-applied VAT, inflating `vat` and
  // `lineCreditInclVat` by another ~15% instead of correctly reporting 0 additional VAT.
  const vatRate = tables.workspace_settings
    ? await getWorkspaceEffectiveVatRate(env, workspaceId)
    : 0.15;
  const clauses = ["cn.workspace_id = ?1"];
  const binds: any[] = [workspaceId];
  addDateRange(clauses, binds, "cn.credited_at", filters, timeZone);
  addSqlLocationScope(clauses, binds, filters, "cnl.location_id");
  addSqlFilter(clauses, binds, filters.supplierId, "cn.supplier_id");
  addSqlFilter(clauses, binds, filters.itemId, "cnl.stock_item_id");
  if (filters.category || filters.categoryId)
    addSqlFilter(
      clauses,
      binds,
      lower(filters.category || filters.categoryId),
      "lower(si.category)",
    );
  const ledgerJoin = tables.stock_movements
    ? `LEFT JOIN (SELECT workspace_id,document_id,stock_item_id,location_id,SUM(quantity_delta) ledger_qty,SUM(value_delta) ledger_value,COUNT(*) ledger_rows FROM stock_movements WHERE workspace_id=?1 AND document_type='credit_note' GROUP BY workspace_id,document_id,stock_item_id,location_id) sm ON sm.workspace_id=cn.workspace_id AND sm.document_id=cn.id AND sm.stock_item_id=cnl.stock_item_id AND sm.location_id=cnl.location_id`
    : "";
  const rows = await env.DB.prepare(
    `SELECT cnl.id,cn.id credit_note_id,cn.credit_note_number,cn.credited_at,cn.reason,cn.created_by,cn.created_at,cn.raw_json credit_raw_json,cn.supplier_id,cn.location_id header_location_id,
    ${tables.suppliers ? "s.name" : "''"} supplier_name,cnl.location_id,${tables.locations ? "COALESCE(l.display_name,l.name,l.external_name,l.id)" : "''"} location_name,cnl.stock_item_id,${tables.stock_items ? "si.name" : "''"} item_name,${tables.stock_items ? "si.category" : "'General'"} category,${tables.stock_items ? "si.unit" : "cnl.unit"} base_uom,${tables.stock_items ? "si.vat_enabled" : "1"} vat_enabled,
    cnl.quantity qty_credited,cnl.unit_cost,cnl.total_ex line_total_ex,${tables.stock_movements ? "COALESCE(sm.ledger_qty,0)" : "0"} ledger_qty,${tables.stock_movements ? "COALESCE(sm.ledger_value,0)" : "0"} ledger_value,${tables.stock_movements ? "COALESCE(sm.ledger_rows,0)" : "0"} ledger_rows
    FROM credit_notes cn JOIN credit_note_lines cnl ON cnl.credit_note_id=cn.id AND cnl.workspace_id=cn.workspace_id
    ${tables.suppliers ? "LEFT JOIN suppliers s ON s.id=cn.supplier_id AND s.workspace_id=cn.workspace_id" : ""} ${tables.locations ? "LEFT JOIN locations l ON l.id=cnl.location_id AND l.workspace_id=cnl.workspace_id" : ""} ${tables.stock_items ? "LEFT JOIN stock_items si ON si.id=cnl.stock_item_id AND si.workspace_id=cnl.workspace_id" : ""} ${ledgerJoin}
    WHERE ${clauses.join(" AND ")} ORDER BY datetime(cn.credited_at) DESC,cn.id,cnl.id LIMIT ${MAX_ROWS}`,
  )
    .bind(...binds)
    .all<Row>();
  const canonicalRows = dedupeRowsByKey(rows.results || [], (row) =>
    clean(row.id || row.line_id || row.purchase_order_line_id),
  );
  const creditNoteReferences = await resolveTransactionReferences(
    env,
    workspaceId,
    canonicalRows,
    "credit_note",
    "credit_note_id",
  );
  const actors = await actorMap(
    env,
    workspaceId,
    canonicalRows.map((r) => r.created_by),
  );
  const standardized = canonicalRows.map((row, index) => {
    const raw = parseJson(row.credit_raw_json);
    const financialOnly = boolean(
      raw.financialOnly ??
        raw.financial_only ??
        raw.noStockImpact ??
        raw.no_stock_impact,
    );
    const ledgerQty = number(row.ledger_qty);
    const explicit = clean(raw.stockImpact || raw.stock_impact);
    const stockImpact =
      explicit ||
      (financialOnly
        ? "Financial Only"
        : number(row.ledger_rows) > 0
          ? ledgerQty > 0
            ? "Stock Returned"
            : ledgerQty < 0
              ? "Stock Removed"
              : "Stock Removed"
          : "Stock Removed");
    const ex = money(row.line_total_ex);
    const vat = number(row.vat_enabled, 1) === 0 ? 0 : money(ex * vatRate);
    return {
      id: clean(row.id) || `credit-line:${index}`,
      creditNoteId: clean(row.credit_note_id),
      sourceId: clean(row.credit_note_id),
      transactionReference:
        creditNoteReferences.get(clean(row.credit_note_id)) ||
        clean(raw.transactionReference) ||
        historicalTransactionReference(
          "credit_note",
          row.credit_note_id,
          row.credited_at || row.created_at,
        ),
      creditNoteDate: zonedTradingDisplayTimestamp(row.credited_at, timeZone, tradingDayStartMinutes),
      creditNoteNumber: clean(row.credit_note_number),
      supplierId: clean(row.supplier_id),
      supplierName: clean(row.supplier_name),
      originalInvoiceGrv: clean(
        raw.originalInvoice ||
          raw.original_invoice ||
          raw.sourceInvoice ||
          raw.source_invoice ||
          raw.originalGrv ||
          raw.original_grv ||
          raw.sourceReference ||
          raw.source_reference,
      ),
      locationId: clean(row.location_id || row.header_location_id),
      locationName: clean(row.location_name),
      itemId: clean(row.stock_item_id),
      itemName: clean(row.item_name),
      category: clean(row.category, "General"),
      reason: clean(row.reason || raw.reason),
      qtyCredited: number(row.qty_credited),
      baseUom: clean(row.base_uom),
      unitCostExVat: number(row.unit_cost),
      lineCreditExVat: ex,
      vat,
      lineCreditInclVat: money(ex + vat),
      status: title(clean(raw.status, "Committed")),
      stockImpact,
      financialOnly,
      createdBy: actorName(actors, row.created_by) || clean(row.created_by),
      committedBy: actorName(actors, row.created_by) || clean(row.created_by),
      ledgerQty,
      ledgerValue: money(row.ledger_value),
      ledgerRowCount: number(row.ledger_rows),
      requiresSourceLink: boolean(
        raw.requiresSourceLink ??
          raw.requires_source_link ??
          raw.sourceRequired ??
          raw.source_required,
      ),
    };
  });
  const filtered = standardized.filter(
    (r) =>
      matchesCommon(r, filters) &&
      (!filters.status || lower(r.status) === lower(filters.status)) &&
      (!filters.supplier ||
        lower(r.supplierName) === lower(filters.supplier)) &&
      matchesSearch(r, filters.search),
  );
  addCountWarning(
    filtered,
    warnings,
    "credit-note-no-supplier",
    "critical",
    "credit note line(s) have no supplier.",
    (r) => !r.supplierName,
  );
  addCountWarning(
    filtered,
    warnings,
    "credit-note-source-missing",
    "warning",
    "credit note line(s) require an original invoice or GRV link.",
    (r) => r.requiresSourceLink && !r.originalInvoiceGrv,
  );
  addCountWarning(
    filtered,
    warnings,
    "credit-note-no-reason",
    "warning",
    "credit note line(s) have no reason.",
    (r) => !r.reason,
  );
  addCountWarning(
    filtered,
    warnings,
    "credit-note-missing-item",
    "critical",
    "credit note line(s) have no item.",
    (r) => !r.itemName,
  );
  addCountWarning(
    filtered,
    warnings,
    "credit-note-missing-quantity",
    "critical",
    "credit note line(s) have no quantity.",
    (r) => r.qtyCredited <= 0,
  );
  addCountWarning(
    filtered,
    warnings,
    "credit-note-missing-cost",
    "critical",
    "credit note line(s) have no unit cost.",
    (r) => r.unitCostExVat <= 0,
  );
  if (tables.stock_movements) {
    addCountWarning(
      filtered,
      warnings,
      "credit-note-no-stock-movement",
      "critical",
      "stock-impacting credit note line(s) have no stock movement row.",
      (r) =>
        !r.financialOnly &&
        !["Financial Only", "No Stock Impact"].includes(r.stockImpact) &&
        r.ledgerRowCount <= 0,
    );
    addCountWarning(
      filtered,
      warnings,
      "credit-note-ledger-mismatch",
      "critical",
      "credit note line(s) do not reconcile to the stock ledger.",
      (r) =>
        r.ledgerRowCount > 0 &&
        (Math.abs(r.qtyCredited - Math.abs(r.ledgerQty)) > 0.0001 ||
          Math.abs(r.lineCreditExVat - Math.abs(r.ledgerValue)) > 0.01),
    );
  }
  const stockRows = filtered.filter(
    (r) =>
      !r.financialOnly &&
      !["Financial Only", "No Stock Impact"].includes(r.stockImpact),
  );
  return json(request, env, {
    rows: filtered.slice(offset, offset + limit),
    warnings: uniqueWarnings(warnings),
    meta: meta(workspaceId, context, filtered.length, {
      sourceTables: tables,
      creditNoteSource: "credit_notes + credit_note_lines",
      vatRate: vatRate * 100,
      reconciliationSource: "stock_movements document_type='credit_note'",
      stockImpactingCreditNotesReconciled: tables.stock_movements
        ? stockRows.every(
            (r) =>
              r.ledgerRowCount > 0 &&
              Math.abs(r.qtyCredited - Math.abs(r.ledgerQty)) <= 0.0001 &&
              Math.abs(r.lineCreditExVat - Math.abs(r.ledgerValue)) <= 0.01,
          )
        : null,
      filterOptions: await filterOptions(env, workspaceId, filtered),
    }),
  });
}


export async function getManufacturingTransactionsReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);
  const context = await reportContext(request, env, workspaceId, 2500);
  const { filters, limit, offset, timeZone, tradingDayStartMinutes } = context;
  const tables = await tableStatus(env, [
    "manufacturing_batches",
    "manufacturing_batch_lines",
    "stock_items",
    "locations",
    "stock_movements",
  ]);
  const warnings: Warning[] = [];
  if (!tables.manufacturing_batches || !tables.manufacturing_batch_lines) {
    return emptyReport(
      request,
      env,
      workspaceId,
      context,
      tables,
      "manufacturing-missing-source-tables",
      "Manufacturing Transactions cannot load because manufacturing batch source tables are missing.",
    );
  }

  const clauses = ["mb.workspace_id = ?1"];
  const binds: any[] = [workspaceId];
  addDateRange(clauses, binds, "mb.posted_at", filters, timeZone);
  addSqlLocationScope(clauses, binds, filters, "mb.location_id");
  addSqlFilter(clauses, binds, filters.itemId, "mb.stock_item_id");
  if (filters.category || filters.categoryId) {
    addSqlFilter(
      clauses,
      binds,
      lower(filters.category || filters.categoryId),
      "lower(si.category)",
    );
  }

  const movementCte = tables.stock_movements
    ? `,
    movement_totals AS (
      SELECT document_id,
             SUM(CASE WHEN movement_type = 'manufacturing_component_out' THEN ABS(quantity_delta) ELSE 0 END) AS ledger_input_qty,
             SUM(CASE WHEN movement_type = 'manufacturing_component_out' THEN ABS(value_delta) ELSE 0 END) AS ledger_input_value,
             SUM(CASE WHEN movement_type = 'manufacturing_finished_in' THEN quantity_delta ELSE 0 END) AS ledger_output_qty,
             SUM(CASE WHEN movement_type = 'manufacturing_finished_in' THEN value_delta ELSE 0 END) AS ledger_output_value,
             SUM(CASE WHEN movement_type IN ('manufacturing_wastage','manufacturing_waste_out') THEN ABS(value_delta) ELSE 0 END) AS ledger_wastage_value,
             SUM(CASE WHEN movement_type = 'manufacturing_component_out' THEN 1 ELSE 0 END) AS ledger_input_rows,
             SUM(CASE WHEN movement_type = 'manufacturing_finished_in' THEN 1 ELSE 0 END) AS ledger_output_rows,
             SUM(CASE WHEN movement_type IN ('manufacturing_wastage','manufacturing_waste_out') THEN 1 ELSE 0 END) AS ledger_wastage_rows
        FROM stock_movements
       WHERE workspace_id = ?1 AND document_type = 'manufacturing_batch'
       GROUP BY document_id
    )`
    : `,
    movement_totals AS (
      SELECT '' document_id, 0 ledger_input_qty, 0 ledger_input_value, 0 ledger_output_qty,
             0 ledger_output_value, 0 ledger_wastage_value, 0 ledger_input_rows,
             0 ledger_output_rows, 0 ledger_wastage_rows WHERE 0
    )`;

  const rows = await env.DB.prepare(
    `WITH line_totals AS (
       SELECT workspace_id, manufacturing_batch_id,
              COUNT(*) AS ingredient_count,
              SUM(quantity_used) AS ingredient_qty_total,
              SUM(quantity_used * unit_cost) AS ingredient_cost_total
         FROM manufacturing_batch_lines
        WHERE workspace_id = ?1
        GROUP BY workspace_id, manufacturing_batch_id
     )${movementCte}
     SELECT mb.id AS manufacturing_batch_id,
            mb.stock_item_id AS manufactured_item_id,
            si.name AS manufactured_item_name,
            si.category AS manufactured_item_category,
            si.unit AS manufactured_item_unit,
            mb.location_id,
            COALESCE(l.display_name, l.name, l.external_name, l.id) AS location_name,
            mb.quantity_made,
            mb.actual_quantity,
            mb.wastage_quantity,
            mb.unit AS output_unit,
            mb.posted_at,
            mb.created_by,
            mb.created_at,
            mb.raw_json,
            mbl.id AS manufacturing_line_id,
            mbl.component_stock_item_id AS ingredient_item_id,
            csi.name AS ingredient_item_name,
            csi.category AS ingredient_category,
            mbl.quantity_used AS ingredient_qty,
            mbl.unit AS ingredient_unit,
            mbl.unit_cost AS ingredient_unit_cost,
            COALESCE(lt.ingredient_count, 0) AS ingredient_count,
            COALESCE(lt.ingredient_qty_total, 0) AS ingredient_qty_total,
            COALESCE(lt.ingredient_cost_total, 0) AS ingredient_cost_total,
            COALESCE(mt.ledger_input_qty, 0) AS ledger_input_qty,
            COALESCE(mt.ledger_input_value, 0) AS ledger_input_value,
            COALESCE(mt.ledger_output_qty, 0) AS ledger_output_qty,
            COALESCE(mt.ledger_output_value, 0) AS ledger_output_value,
            COALESCE(mt.ledger_wastage_value, 0) AS ledger_wastage_value,
            COALESCE(mt.ledger_input_rows, 0) AS ledger_input_rows,
            COALESCE(mt.ledger_output_rows, 0) AS ledger_output_rows,
            COALESCE(mt.ledger_wastage_rows, 0) AS ledger_wastage_rows
       FROM manufacturing_batches mb
       LEFT JOIN stock_items si ON si.id = mb.stock_item_id AND si.workspace_id = mb.workspace_id
       LEFT JOIN locations l ON l.id = mb.location_id AND l.workspace_id = mb.workspace_id
       LEFT JOIN manufacturing_batch_lines mbl ON mbl.manufacturing_batch_id = mb.id AND mbl.workspace_id = mb.workspace_id
       LEFT JOIN stock_items csi ON csi.id = mbl.component_stock_item_id AND csi.workspace_id = mbl.workspace_id
       LEFT JOIN line_totals lt ON lt.workspace_id = mb.workspace_id AND lt.manufacturing_batch_id = mb.id
       LEFT JOIN movement_totals mt ON mt.document_id = mb.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY datetime(mb.posted_at) DESC, mb.id, mbl.rowid
      LIMIT ${MAX_ROWS}`,
  ).bind(...binds).all<Row>();

  const sourceRows = rows.results || [];
  const references = await resolveTransactionReferences(
    env,
    workspaceId,
    sourceRows,
    "manufacturing_batch",
    "manufacturing_batch_id",
  );
  const actors = await actorMap(
    env,
    workspaceId,
    sourceRows.map((row) => row.created_by),
  );

  const standardized = sourceRows.map((row, index) => {
    const raw = parseJson(row.raw_json);
    const actualYield = number(
      raw.producedQty ?? raw.actualQty ?? row.actual_quantity ?? row.quantity_made,
    );
    const plannedYield = number(
      raw.expectedQty ?? raw.plannedYield ?? raw.expectedYield ?? row.quantity_made,
    );
    const yieldVariance = quantity(actualYield - plannedYield);
    const ingredientCostTotal = money(
      raw.batchCost ?? raw.theoreticalBatchCost ?? row.ingredient_cost_total,
    );
    const actualUnitCost = number(
      raw.actualUnitCost,
      actualYield > 0 ? ingredientCostTotal / actualYield : 0,
    );
    const outputValue = money(actualYield * actualUnitCost);
    const expectedUnitCost = number(
      raw.expectedUnitCost,
      plannedYield > 0 ? ingredientCostTotal / plannedYield : actualUnitCost,
    );
    const wastageQty = quantity(
      raw.wastageQty ?? raw.wastageQuantity ?? row.wastage_quantity,
    );
    const wastageValue = money(
      raw.wastageValue ?? wastageQty * expectedUnitCost,
    );
    const ingredientQty = quantity(row.ingredient_qty);
    const ingredientUnitCost = number(row.ingredient_unit_cost);
    const ingredientCost = money(ingredientQty * ingredientUnitCost);
    const status = title(clean(raw.status, "Committed"));
    const batchId = clean(row.manufacturing_batch_id);
    const committedBy = actorName(actors, row.created_by) || clean(row.created_by);
    const ledgerInputValue = money(row.ledger_input_value);
    const ledgerOutputValue = money(row.ledger_output_value);
    const ledgerWastageValue = money(row.ledger_wastage_value);
    const inputReconciled = !tables.stock_movements || (
      number(row.ledger_input_rows) > 0 &&
      Math.abs(ingredientCostTotal - ledgerInputValue) <= 0.01
    );
    const outputReconciled = !tables.stock_movements || (
      number(row.ledger_output_rows) > 0 &&
      Math.abs(actualYield - number(row.ledger_output_qty)) <= 0.0001 &&
      Math.abs(outputValue - ledgerOutputValue) <= 0.01
    );
    const wastageReconciled = !tables.stock_movements || wastageQty <= 0 || (
      number(row.ledger_wastage_rows) > 0 &&
      Math.abs(wastageValue - ledgerWastageValue) <= 0.01
    );
    return {
      id: `mfg:${batchId}:${clean(row.manufacturing_line_id, String(index))}`,
      manufacturingBatchId: batchId,
      sourceId: batchId,
      documentId: batchId,
      transactionReference: clean(
        raw.transactionReference ||
          references.get(batchId) ||
          historicalTransactionReference(
            "manufacturing_batch",
            batchId,
            row.posted_at || row.created_at,
          ),
      ),
      postedAt: zonedTradingDisplayTimestamp(row.posted_at, timeZone, tradingDayStartMinutes),
      batchDate: zonedTradingDateTimeStrings(row.posted_at, timeZone, tradingDayStartMinutes).date,
      committedAt: zonedTradingDisplayTimestamp(row.created_at || row.posted_at, timeZone, tradingDayStartMinutes),
      status,
      manufacturedItemId: clean(row.manufactured_item_id),
      itemId: clean(row.manufactured_item_id),
      manufacturedItemName: clean(row.manufactured_item_name),
      itemName: clean(row.manufactured_item_name),
      category: clean(row.manufactured_item_category, "General"),
      locationId: clean(row.location_id),
      locationName: clean(row.location_name),
      plannedYield,
      actualYield,
      yieldVariance,
      yieldVariancePercent: plannedYield > 0 ? (yieldVariance / plannedYield) * 100 : 0,
      yieldUom: clean(raw.unit || row.output_unit || row.manufactured_item_unit),
      batchMultiplier: number(raw.batchCount ?? raw.batchMultiplier, 1),
      ingredientCount: number(row.ingredient_count),
      ingredientItemId: clean(row.ingredient_item_id),
      ingredientItemName: clean(row.ingredient_item_name),
      ingredientCategory: clean(row.ingredient_category, "General"),
      ingredientQty,
      ingredientUom: clean(row.ingredient_unit),
      ingredientUnitCost,
      ingredientCost,
      ingredientQtyTotal: quantity(row.ingredient_qty_total),
      ingredientCostTotal,
      outputUnitCost: actualUnitCost,
      outputValue,
      wastageQty,
      wastageValue,
      committedBy,
      createdBy: committedBy,
      note: clean(raw.note),
      costingMethod: clean(raw.costingMethod),
      correctionType: clean(raw.correctionType || raw.correction_type),
      ledgerInputQty: quantity(row.ledger_input_qty),
      ledgerInputValue,
      ledgerOutputQty: quantity(row.ledger_output_qty),
      ledgerOutputValue,
      ledgerWastageValue,
      ledgerInputRows: number(row.ledger_input_rows),
      ledgerOutputRows: number(row.ledger_output_rows),
      ledgerWastageRows: number(row.ledger_wastage_rows),
      inputReconciled,
      outputReconciled,
      wastageReconciled,
      ledgerReconciled: inputReconciled && outputReconciled && wastageReconciled,
      accountingOnlyWastage: wastageQty > 0,
    };
  });

  const filtered = standardized.filter((row) =>
    matchesCommon(row, filters) &&
    (!filters.status || lower(row.status) === lower(filters.status)) &&
    matchesSearch(row, filters.search),
  );
  addCountWarning(
    filtered,
    warnings,
    "manufacturing-missing-item",
    "critical",
    "manufacturing row(s) are missing the manufactured item name.",
    (row) => !row.manufacturedItemName,
  );
  addCountWarning(
    filtered,
    warnings,
    "manufacturing-missing-location",
    "critical",
    "manufacturing row(s) are missing a location.",
    (row) => !row.locationName,
  );

  const batchRows = dedupeRowsByKey(filtered, (row) => clean(row.manufacturingBatchId));
  return json(request, env, {
    rows: filtered.slice(offset, offset + limit),
    warnings: uniqueWarnings(warnings),
    meta: meta(workspaceId, context, filtered.length, {
      sourceTables: tables,
      manufacturingSource: "manufacturing_batches + manufacturing_batch_lines",
      reconciliationSource: "stock_movements document_type='manufacturing_batch'",
      batchCount: batchRows.length,
      manufacturingReconciled: tables.stock_movements
        ? batchRows.every((row) => row.ledgerReconciled === true)
        : null,
      wastageAccountingPolicy: "Manufacturing wastage is accounting-only and is not deducted twice from stock.",
      filterOptions: await filterOptions(env, workspaceId, filtered),
    }),
  });
}


export async function getStockTransferTransactionsReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);
  const context = await reportContext(request, env, workspaceId, 2500);
  const { filters, limit, offset, timeZone, tradingDayStartMinutes } = context;
  const tables = await tableStatus(env, [
    "transfers",
    "transfer_lines",
    "stock_items",
    "locations",
    "audit_events",
  ]);
  if (!tables.transfers || !tables.transfer_lines) {
    return emptyReport(
      request,
      env,
      workspaceId,
      context,
      tables,
      "stock-transfer-missing-source-tables",
      "Stock Transfers cannot load because transfer source tables are missing.",
    );
  }

  const localRows = await env.DB.prepare(
    `SELECT t.id AS transfer_id, t.transfer_type, t.status, t.from_location_id,
            t.to_location_id, t.from_workspace_id, t.to_workspace_id, t.note,
            t.requested_at, t.accepted_at, t.created_by, t.raw_json,
            COALESCE(fl.display_name, fl.name, fl.external_name, fl.id) AS from_location_name,
            COALESCE(tl.display_name, tl.name, tl.external_name, tl.id) AS to_location_name,
            trl.id AS transfer_line_id, trl.stock_item_id,
            si.name AS stock_item_name, si.category AS stock_item_category,
            trl.quantity, trl.unit, trl.unit_cost
       FROM transfers t
       LEFT JOIN transfer_lines trl
         ON trl.workspace_id = t.workspace_id AND trl.transfer_id = t.id
       LEFT JOIN stock_items si
         ON si.workspace_id = trl.workspace_id AND si.id = trl.stock_item_id
       LEFT JOIN locations fl
         ON fl.workspace_id = t.workspace_id AND fl.id = t.from_location_id
       LEFT JOIN locations tl
         ON tl.workspace_id = t.workspace_id AND tl.id = t.to_location_id
      WHERE t.workspace_id = ?1
      ORDER BY datetime(t.requested_at) DESC, t.id, trl.rowid
      LIMIT ${MAX_ROWS}`,
  ).bind(workspaceId).all<Row>();

  let centralRows: Row[] = [];
  try {
    const result = await env.CENTRAL_DB.prepare(
      `SELECT id, from_workspace_id, to_workspace_id, from_location_id,
              to_location_id, status, items_json, note, created_by,
              requested_at, accepted_at, updated_at
         FROM external_transfers
        WHERE from_workspace_id = ?1 OR to_workspace_id = ?1
        ORDER BY datetime(requested_at) DESC
        LIMIT ${MAX_ROWS}`,
    ).bind(workspaceId).all<Row>();
    centralRows = result.results || [];
  } catch {
    centralRows = [];
  }

  const centralById = new Map(
    centralRows.map((row) => [clean(row.id), row] as const),
  );
  const localSourceRows = localRows.results || [];
  const references = await resolveTransactionReferences(
    env,
    workspaceId,
    localSourceRows,
    "transfer",
    "transfer_id",
  );

  const locationRows = await safeAll(
    env.DB.prepare(
      `SELECT id, COALESCE(display_name, name, external_name, id) AS name
         FROM locations WHERE workspace_id = ?1`,
    ).bind(workspaceId),
  );
  const localLocations = new Map(
    locationRows.map((row: Row) => [clean(row.id), clean(row.name)]),
  );

  const workspaceIds = new Set<string>([workspaceId]);
  for (const row of localSourceRows) {
    workspaceIds.add(clean(row.from_workspace_id));
    workspaceIds.add(clean(row.to_workspace_id));
    const raw = parseJson(row.raw_json);
    const transferMeta = transferReportMeta(raw);
    workspaceIds.add(clean(transferMeta.fromSiteId || transferMeta.from_site_id));
    workspaceIds.add(clean(transferMeta.toSiteId || transferMeta.to_site_id));
  }
  for (const row of centralRows) {
    workspaceIds.add(clean(row.from_workspace_id));
    workspaceIds.add(clean(row.to_workspace_id));
  }
  workspaceIds.delete("");
  const workspaceNames = new Map<string, string>();
  if (workspaceIds.size) {
    const ids = [...workspaceIds];
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
    const rows = await env.CENTRAL_DB.prepare(
      `SELECT id, name FROM workspaces WHERE id IN (${placeholders})`,
    ).bind(...ids).all<Row>();
    for (const row of rows.results || []) {
      workspaceNames.set(clean(row.id), clean(row.name));
    }
  }

  const transferIds = [...new Set([
    ...localSourceRows.map((row) => clean(row.transfer_id)),
    ...centralRows.filter((row) => clean(row.to_workspace_id) === workspaceId)
      .map((row) => clean(row.id)),
  ].filter(Boolean))];
  const auditActors = new Map<string, { actorId: string; eventType: string; createdAt: string }>();
  if (tables.audit_events && transferIds.length) {
    const placeholders = transferIds.map((_, index) => `?${index + 2}`).join(",");
    const auditRows = await env.DB.prepare(
      `SELECT entity_id, actor_uid, event_type, created_at
         FROM audit_events
        WHERE workspace_id = ?1 AND entity_type = 'transfer'
          AND entity_id IN (${placeholders})
        ORDER BY datetime(created_at) DESC`,
    ).bind(workspaceId, ...transferIds).all<Row>();
    for (const row of auditRows.results || []) {
      const entityId = clean(row.entity_id);
      if (!entityId || auditActors.has(entityId)) continue;
      const eventType = lower(row.event_type);
      if (
        eventType.includes("accepted") ||
        eventType.includes("rejected") ||
        eventType.includes("cancelled") ||
        eventType.includes("posted")
      ) {
        auditActors.set(entityId, {
          actorId: clean(row.actor_uid),
          eventType: clean(row.event_type),
          createdAt: clean(row.created_at),
        });
      }
    }
  }

  const actorIds = [
    ...localSourceRows.map((row) => row.created_by),
    ...centralRows.map((row) => row.created_by),
    ...[...auditActors.values()].map((entry) => entry.actorId),
  ];
  const actors = await reportActorMap(env, workspaceId, actorIds);

  const standardized: Row[] = [];
  const localTransferIds = new Set<string>();
  for (const row of localSourceRows) {
    const transferId = clean(row.transfer_id);
    if (!transferId) continue;
    localTransferIds.add(transferId);
    const raw = parseJson(row.raw_json);
    const localMeta = transferReportMeta(raw);
    const localLifecycle = transferReportLifecycle(raw);
    const central = centralById.get(transferId);
    const envelope = parseTransferReportEnvelope(central?.items_json);
    const transferMeta = { ...localMeta, ...envelope.transferMeta };
    const lifecycle = { ...localLifecycle, ...envelope.lifecycle };
    const transferType = lower(row.transfer_type || transferMeta.transferType) === "external"
      ? "external"
      : "internal";
    const fromSiteId = clean(
      transferMeta.fromSiteId || transferMeta.from_site_id ||
      central?.from_workspace_id || row.from_workspace_id || workspaceId,
    );
    const toSiteId = clean(
      transferMeta.toSiteId || transferMeta.to_site_id ||
      central?.to_workspace_id || row.to_workspace_id || workspaceId,
    );
    const fromLocationId = clean(
      transferMeta.fromLocationId || transferMeta.from_location_id ||
      central?.from_location_id || row.from_location_id,
    );
    const toLocationId = clean(
      transferMeta.toLocationId || transferMeta.to_location_id ||
      central?.to_location_id || row.to_location_id,
    );
    const fromLocationName = clean(
      transferMeta.fromLocationName || transferMeta.from_location_name ||
      row.from_location_name || localLocations.get(fromLocationId),
      fromLocationId ? (fromSiteId === workspaceId ? "Source Location" : "External Location") : "",
    );
    const toLocationName = clean(
      transferMeta.toLocationName || transferMeta.to_location_name ||
      row.to_location_name || localLocations.get(toLocationId),
      toLocationId ? (toSiteId === workspaceId ? "Receiving Location" : "External Location") : "",
    );
    const requestedAt = clean(
      transferMeta.requestedAt || central?.requested_at || row.requested_at,
    );
    const acceptedAt = clean(
      lifecycle.acceptedAt || transferMeta.acceptedAt ||
      central?.accepted_at || row.accepted_at,
    );
    const rawStatus = clean(
      lifecycle.status || transferMeta.status || central?.status || row.status,
      transferType === "internal" ? "posted" : "pending_receipt",
    );
    const sourceStockItemId = clean(row.stock_item_id);
    const shipped = number(row.quantity);
    const receivedLine = findTransferReportLine(
      envelope.received.length ? envelope.received : transferReportLines(lifecycle.received),
      sourceStockItemId,
    );
    const shortfallLine = findTransferReportLine(
      envelope.shortfalls.length ? envelope.shortfalls : transferReportLines(lifecycle.shortfalls),
      sourceStockItemId,
    );
    const returned = quantity(
      shortfallLine.shortfall ?? shortfallLine.returnedQty ??
      (["rejected", "cancelled"].includes(lower(rawStatus)) ? shipped : 0),
    );
    const received = quantity(
      receivedLine.receivedQty ?? receivedLine.quantity ??
      (transferType === "internal" || lower(rawStatus) === "accepted"
        ? Math.max(0, shipped - returned)
        : 0),
    );
    const status = transferReportStatus(rawStatus, shipped, received, returned);
    const audit = auditActors.get(transferId);
    const committedBy = reportActorName(actors, audit?.actorId) ||
      clean(transferMeta.acceptedByName || transferMeta.committedByName) ||
      (transferType === "internal" ? reportActorName(actors, row.created_by) :
        acceptedAt ? "Receiving workspace" : "");
    standardized.push(buildTransferReportRow({
      workspaceId,
      transferId,
      transactionReference: clean(
        transferMeta.transactionReference || references.get(transferId) ||
        historicalTransactionReference("transfer", transferId, requestedAt),
      ),
      transferType,
      workspaceRole: transferType === "internal" ? "internal" : "sender",
      status,
      rawStatus,
      requestedAt,
      acceptedAt,
      fromSiteId,
      fromSiteName: clean(
        transferMeta.fromSiteName || workspaceNames.get(fromSiteId),
        fromSiteId === workspaceId ? "Current Site" : "External Site",
      ),
      fromLocationId,
      fromLocationName,
      toSiteId,
      toSiteName: clean(
        transferMeta.toSiteName || workspaceNames.get(toSiteId),
        toSiteId === workspaceId ? "Current Site" : "External Site",
      ),
      toLocationId,
      toLocationName,
      itemId: sourceStockItemId,
      itemName: clean(row.stock_item_name),
      category: clean(row.stock_item_category, "General"),
      unit: clean(row.unit),
      unitCost: number(row.unit_cost),
      shippedQty: shipped,
      receivedQty: received,
      returnedQty: returned,
      createdBy: reportActorName(actors, row.created_by) || clean(row.created_by),
      committedBy,
      note: clean(row.note),
    }));
  }

  for (const central of centralRows) {
    const transferId = clean(central.id);
    if (!transferId || clean(central.to_workspace_id) !== workspaceId || localTransferIds.has(transferId)) continue;
    const envelope = parseTransferReportEnvelope(central.items_json);
    const transferMeta = envelope.transferMeta;
    const lifecycle = envelope.lifecycle;
    const fromSiteId = clean(transferMeta.fromSiteId || central.from_workspace_id);
    const toSiteId = clean(transferMeta.toSiteId || central.to_workspace_id);
    const fromLocationId = clean(transferMeta.fromLocationId || central.from_location_id);
    const toLocationId = clean(transferMeta.toLocationId || central.to_location_id);
    const requestedAt = clean(transferMeta.requestedAt || central.requested_at);
    const acceptedAt = clean(lifecycle.acceptedAt || transferMeta.acceptedAt || central.accepted_at);
    const rawStatus = clean(lifecycle.status || transferMeta.status || central.status, "pending_receipt");
    const audit = auditActors.get(transferId);
    const committedBy = reportActorName(actors, audit?.actorId) ||
      clean(transferMeta.acceptedByName || transferMeta.committedByName);
    const shippedLines = envelope.shipped.length ? envelope.shipped : [{}];
    for (const item of shippedLines) {
      const sourceStockItemId = clean(
        item.stockItemId || item.stock_item_id || item.sourceStockItemId || item.id,
      );
      const receivedLine = findTransferReportLine(envelope.received, sourceStockItemId);
      const shortfallLine = findTransferReportLine(envelope.shortfalls, sourceStockItemId);
      const shipped = quantity(item.shippedQty ?? item.quantity ?? item.qty);
      const returned = quantity(
        shortfallLine.shortfall ?? shortfallLine.returnedQty ??
        (["rejected", "cancelled"].includes(lower(rawStatus)) ? shipped : 0),
      );
      const received = quantity(
        receivedLine.receivedQty ?? receivedLine.quantity ??
        (lower(rawStatus) === "accepted" ? Math.max(0, shipped - returned) : 0),
      );
      standardized.push(buildTransferReportRow({
        workspaceId,
        transferId,
        transactionReference: clean(
          transferMeta.transactionReference ||
          historicalTransactionReference("transfer", transferId, requestedAt),
        ),
        transferType: "external",
        workspaceRole: "receiver",
        status: transferReportStatus(rawStatus, shipped, received, returned),
        rawStatus,
        requestedAt,
        acceptedAt,
        fromSiteId,
        fromSiteName: clean(
          transferMeta.fromSiteName || workspaceNames.get(fromSiteId),
          "External Site",
        ),
        fromLocationId,
        fromLocationName: clean(
          transferMeta.fromLocationName,
          fromLocationId ? "External Location" : "",
        ),
        toSiteId,
        toSiteName: clean(
          transferMeta.toSiteName || workspaceNames.get(toSiteId),
          "Current Site",
        ),
        toLocationId,
        toLocationName: clean(
          localLocations.get(toLocationId) || transferMeta.toLocationName,
          toLocationId ? "Receiving Location" : "",
        ),
        itemId: sourceStockItemId,
        itemName: clean(item.name || item.stockItemName),
        category: clean(item.category, "General"),
        unit: clean(item.unit),
        unitCost: number(item.unitCost ?? item.unit_cost),
        shippedQty: shipped,
        receivedQty: received,
        returnedQty: returned,
        createdBy: reportActorName(actors, central.created_by) || clean(central.created_by),
        committedBy,
        timeZone,
        tradingDayStartMinutes,
        note: clean(central.note),
      }));
    }
  }

  const { fromUtc, toExclusiveUtc } = localDateRangeToUtcBounds({
    from: filters.from,
    to: filters.to,
    timeZone,
    tradingDayStartMinutes,
  });
  const filtered = standardized.filter((row) => {
    const timestamp = clean(row.sourceRequestedAt || row.requestedAt || row.timestamp);
    if (fromUtc && timestamp && new Date(timestamp).getTime() < new Date(fromUtc).getTime()) return false;
    if (toExclusiveUtc && timestamp && new Date(timestamp).getTime() >= new Date(toExclusiveUtc).getTime()) return false;
    if (!matchesLocationScope(toCleanStringArray(row.reportLocationIds), filters)) return false;
    if (filters.itemId && clean(row.itemId) !== filters.itemId) return false;
    if (filters.category && lower(row.category) !== lower(filters.category)) return false;
    if (filters.categoryId && lower(row.category) !== lower(filters.categoryId)) return false;
    if (filters.status && lower(row.status) !== lower(filters.status) && lower(row.rawStatus) !== lower(filters.status)) return false;
    return matchesSearch(row, filters.search);
  });

  const warnings: Warning[] = [];
  addCountWarning(
    filtered,
    warnings,
    "stock-transfer-transaction-missing-item",
    "critical",
    "transfer line(s) are missing an item name.",
    (row) => !row.itemName,
  );
  return json(request, env, {
    rows: filtered.slice(offset, offset + limit),
    warnings: uniqueWarnings(warnings),
    meta: meta(workspaceId, context, filtered.length, {
      sourceTables: tables,
      transferSource: "transfers + transfer_lines + central external_transfers",
      transactionCount: new Set(filtered.map((row) => row.sourceId)).size,
      includesPendingAndRejected: true,
      filterOptions: await filterOptions(env, workspaceId, filtered),
    }),
  });
}

function buildTransferReportRow(input: Row): Row {
  const localDirection = input.workspaceRole === "receiver" ? "Transfer In" : "Transfer Out";
  const requestedLocal = zonedTradingDateTimeStrings(
    input.requestedAt,
    clean(input.timeZone, "Africa/Johannesburg"),
    number(input.tradingDayStartMinutes),
  );
  const requestedDisplay = zonedTradingDisplayTimestamp(
    input.requestedAt,
    clean(input.timeZone, "Africa/Johannesburg"),
    number(input.tradingDayStartMinutes),
  );
  const acceptedDisplay = zonedTradingDisplayTimestamp(
    input.acceptedAt,
    clean(input.timeZone, "Africa/Johannesburg"),
    number(input.tradingDayStartMinutes),
  );
  const shippedQty = quantity(input.shippedQty);
  const receivedQty = quantity(input.receivedQty);
  const returnedQty = quantity(input.returnedQty);
  const unitCost = number(input.unitCost);
  const qtyIn = input.workspaceRole === "receiver" ? receivedQty : 0;
  const qtyOut = input.workspaceRole === "receiver" ? 0 : shippedQty;
  const netQty = quantity(qtyIn - qtyOut);
  const localLocationId = input.workspaceRole === "receiver" ? input.toLocationId : input.fromLocationId;
  const localLocationName = input.workspaceRole === "receiver" ? input.toLocationName : input.fromLocationName;
  return {
    id: `transfer-transaction:${clean(input.transferId)}:${clean(input.itemId, "line")}:${input.workspaceRole}`,
    sourceId: clean(input.transferId),
    entityId: clean(input.transferId),
    documentNumber: clean(input.transactionReference),
    transactionReference: clean(input.transactionReference),
    transferType: clean(input.transferType),
    transferScope: clean(input.transferType),
    transferTypeLabel: title(input.transferType),
    workspaceRole: clean(input.workspaceRole),
    sourceRequestedAt: clean(input.requestedAt),
    sourceAcceptedAt: clean(input.acceptedAt),
    requestedAt: requestedDisplay || clean(input.requestedAt),
    acceptedAt: acceptedDisplay || clean(input.acceptedAt),
    timestamp: acceptedDisplay || requestedDisplay || clean(input.acceptedAt || input.requestedAt),
    date: requestedLocal.date,
    status: clean(input.status),
    rawStatus: clean(input.rawStatus),
    fromSiteId: clean(input.fromSiteId),
    fromSiteName: clean(input.fromSiteName),
    fromLocationId: clean(input.fromLocationId),
    fromLocationName: clean(input.fromLocationName),
    toSiteId: clean(input.toSiteId),
    toSiteName: clean(input.toSiteName),
    toLocationId: clean(input.toLocationId),
    toLocationName: clean(input.toLocationName),
    locationId: clean(localLocationId),
    locationName: clean(localLocationName),
    reportLocationIds: [clean(input.fromLocationId), clean(input.toLocationId)].filter(Boolean),
    direction: localDirection,
    source: localDirection,
    movementType: localDirection,
    itemId: clean(input.itemId),
    stockItemId: clean(input.itemId),
    itemName: clean(input.itemName),
    category: clean(input.category, "General"),
    baseUom: clean(input.unit),
    unit: clean(input.unit),
    unitCostExVat: unitCost,
    shippedQty,
    receivedQty,
    returnedQty,
    qtyTransferred: shippedQty,
    qtyIn,
    qtyOut,
    netQty,
    transferValue: money(shippedQty * unitCost),
    movementValue: money(netQty * unitCost),
    createdBy: clean(input.createdBy),
    committedBy: clean(input.committedBy),
    notes: clean(input.note),
  };
}

function transferReportMeta(raw: Row): Row {
  return objectRow(raw.transferMeta || raw.transfer_meta || raw);
}

function transferReportLifecycle(raw: Row): Row {
  return objectRow(raw.lifecycle);
}

function objectRow(value: any): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function transferReportLines(value: any): Row[] {
  if (Array.isArray(value)) return value.map(objectRow);
  return [];
}

function toCleanStringArray(value: any): string[] {
  return Array.isArray(value) ? value.map((entry) => clean(entry)).filter(Boolean) : [];
}

function parseTransferReportEnvelope(value: any): {
  shipped: Row[];
  received: Row[];
  shortfalls: Row[];
  transferMeta: Row;
  lifecycle: Row;
} {
  let parsed: any = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
  }
  if (Array.isArray(parsed)) {
    return { shipped: parsed.map(objectRow), received: [], shortfalls: [], transferMeta: {}, lifecycle: {} };
  }
  const envelope = objectRow(parsed);
  return {
    shipped: transferReportLines(envelope.shipped || envelope.items),
    received: transferReportLines(envelope.received),
    shortfalls: transferReportLines(envelope.shortfalls),
    transferMeta: objectRow(envelope.transferMeta || envelope.transfer_meta || envelope.meta),
    lifecycle: objectRow(envelope.lifecycle),
  };
}

function findTransferReportLine(lines: Row[], stockItemId: string): Row {
  const id = clean(stockItemId);
  return lines.find((line) => clean(
    line.sourceStockItemId || line.source_stock_item_id ||
    line.transferLineStockItemId || line.stockItemId ||
    line.stock_item_id || line.itemId || line.id,
  ) === id) || {};
}

function transferReportStatus(rawStatus: string, shipped: number, received: number, returned: number): string {
  const normalized = lower(rawStatus).replace(/[\s-]+/g, "_");
  if (normalized === "accepted" && received > 0 && returned > 0) return "Partially Accepted";
  if (normalized === "accepted") return "Accepted";
  if (["pending", "pending_receipt"].includes(normalized)) return "Pending Receipt";
  if (normalized === "rejected") return "Rejected";
  if (normalized === "cancelled") return "Cancelled";
  if (normalized === "posted" || normalized === "completed") return "Committed";
  if (shipped > 0 && received > 0 && received < shipped) return "Partially Accepted";
  return title(normalized || "pending");
}

async function reportActorMap(env: Env, workspaceId: string, ids: any[]): Promise<Map<string, Row>> {
  const values = [...new Set(ids.map((id) => clean(id)).filter(Boolean))];
  const map = new Map<string, Row>();
  if (!values.length) return map;
  const placeholders = values.map((_, index) => `?${index + 2}`).join(",");
  const emailPlaceholders = values.map((_, index) => `?${values.length + index + 2}`).join(",");
  try {
    const members = await env.CENTRAL_DB.prepare(
      `SELECT auth_uid AS id, email, display_name
         FROM workspace_members
        WHERE workspace_id = ?1
          AND (auth_uid IN (${placeholders}) OR lower(email) IN (${emailPlaceholders}))`,
    ).bind(workspaceId, ...values, ...values.map(lower)).all<Row>();
    for (const row of members.results || []) {
      if (clean(row.id)) map.set(clean(row.id), row);
      if (clean(row.email)) map.set(lower(row.email), row);
    }
  } catch {}
  try {
    const appPlaceholders = values.map((_, index) => `?${index + 1}`).join(",");
    const emailAppPlaceholders = values.map((_, index) => `?${values.length + index + 1}`).join(",");
    const users = await env.CENTRAL_DB.prepare(
      `SELECT id, email, display_name FROM app_users
        WHERE id IN (${appPlaceholders}) OR lower(email) IN (${emailAppPlaceholders})`,
    ).bind(...values, ...values.map(lower)).all<Row>();
    for (const row of users.results || []) {
      if (clean(row.id)) map.set(clean(row.id), row);
      if (clean(row.email)) map.set(lower(row.email), row);
    }
  } catch {}
  return map;
}

function reportActorName(map: Map<string, Row>, id: any): string {
  const key = clean(id);
  const row = map.get(key) || map.get(lower(key));
  return clean(row?.display_name || row?.email);
}

async function reportContext(
  request: Request,
  env: Env,
  workspaceId: string,
  defaultLimit: number,
) {
  const url = new URL(request.url);
  const reporting = await workspaceReportingContext(env, workspaceId);
  return {
    url,
    timeZone: reporting.timeZone,
    tradingDayStartMinutes: reporting.tradingDayStartMinutes,
    tradingDayLabel: reporting.tradingDayLabel,
    filters: {
      ...readFilters(url, request),
      tradingDayStartMinutes: reporting.tradingDayStartMinutes,
    },
    limit: limitFromUrl(url, defaultLimit, 5000),
    offset: offsetFromUrl(url),
    generatedAt: new Date().toISOString(),
  };
}
function readFilters(url: URL, request?: Request) {
  const get = (key: string) => clean(url.searchParams.get(key));
  const requestedLocationIds = Array.from(new Set([
    ...url.searchParams.getAll("locationId"),
    ...url.searchParams.getAll("locationIds"),
    ...url.searchParams.getAll("location"),
  ].flatMap((value) => value.split(",")).map((value) => clean(value)).filter(Boolean)));
  const resolvedScope = request ? getResolvedReportLocationScope(request) : undefined;
  const locationIds = resolvedScope === null
    ? requestedLocationIds
    : Array.isArray(resolvedScope)
      ? resolvedScope
      : requestedLocationIds;
  return {
    from: get("from"),
    to: get("to"),
    locationId: locationIds.length === 1 ? locationIds[0] : "",
    locationIds,
    category: get("category"),
    categoryId: get("categoryId"),
    itemId: get("itemId"),
    supplierId: get("supplierId"),
    supplier: get("supplier"),
    status: get("status"),
    search: get("search"),
  };
}
function meta(
  workspaceId: string,
  context: Row,
  totalRows: number,
  extra: Row = {},
) {
  const returnedRows = Math.max(
    0,
    Math.min(context.limit, totalRows - context.offset),
  );
  const hasMore = context.offset + returnedRows < totalRows;
  const sourceRowCap = number(extra.sourceRowCap, MAX_ROWS);
  // Do not infer truncation from a row count. Only an explicit discarded-row
  // signal is allowed to mark a report incomplete.
  const truncated = extra.truncated === true;
  return {
    workspaceId,
    from: context.filters.from || null,
    to: context.filters.to || null,
    totalRows,
    limit: context.limit,
    offset: context.offset,
    returnedRows,
    hasMore,
    nextOffset: hasMore ? context.offset + returnedRows : null,
    sourceRowCap,
    truncated,
    dataSource: "real",
    currency: "ZAR",
    timeZone: context.timeZone,
    timezone: context.timeZone,
    tradingDayStartMinutes: context.tradingDayStartMinutes || 0,
    tradingDayLabel: context.tradingDayLabel || "00:00–00:00",
    generatedAt: context.generatedAt,
    ...extra,
  };
}
async function emptyReport(
  request: Request,
  env: Env,
  workspaceId: string,
  context: Row,
  tables: Row,
  code: string,
  message: string,
) {
  return json(request, env, {
    rows: [],
    warnings: [{ code, level: "warning", message }],
    meta: meta(workspaceId, context, 0, { sourceTables: tables }),
  });
}
async function tableStatus(env: Env, names: string[]) {
  const result: Row = {};
  for (const name of names) result[name] = await tableExists(env, name);
  return result;
}
async function tableExists(env: Env, name: string) {
  try {
    return Boolean(
      (
        await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?1 LIMIT 1",
        )
          .bind(name)
          .first<Row>()
      )?.name,
    );
  } catch {
    return false;
  }
}
async function workspaceReportingContext(env: Env, workspaceId: string) {
  let timeZone = normalizeReportTimeZone("Africa/Johannesburg");
  let rawSettings: Row = {};
  try {
    const [workspace, settings] = await Promise.all([
      env.CENTRAL_DB.prepare(
        "SELECT timezone FROM workspaces WHERE id=?1 LIMIT 1",
      ).bind(workspaceId).first<Row>(),
      env.DB.prepare(
        "SELECT raw_json FROM workspace_settings WHERE workspace_id=?1 LIMIT 1",
      ).bind(workspaceId).first<Row>(),
    ]);
    timeZone = normalizeReportTimeZone(workspace?.timezone || "Africa/Johannesburg");
    rawSettings = parseJson(settings?.raw_json);
  } catch {
    // Safe fallback is Johannesburg with calendar-day reporting.
  }
  const tradingDayStartMinutes = normalizeTradingDayStartMinutes(rawSettings as any);
  const hour = Math.floor(tradingDayStartMinutes / 60);
  const minute = tradingDayStartMinutes % 60;
  const label = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return {
    timeZone,
    tradingDayStartMinutes,
    tradingDayLabel: tradingDayStartMinutes ? `${label}–${label}` : "00:00–00:00",
  };
}
function addDateRange(
  clauses: string[],
  binds: any[],
  column: string,
  filters: Row,
  timeZone: string,
) {
  const { fromUtc, toExclusiveUtc } = localDateRangeToUtcBounds({
    from: filters.from,
    to: filters.to,
    timeZone,
    tradingDayStartMinutes: number(filters.tradingDayStartMinutes),
  });
  if (fromUtc) {
    binds.push(fromUtc);
    clauses.push(`datetime(${column})>=datetime(?${binds.length})`);
  }
  if (toExclusiveUtc) {
    binds.push(toExclusiveUtc);
    clauses.push(`datetime(${column})<datetime(?${binds.length})`);
  }
}
function addSqlFilter(
  clauses: string[],
  binds: any[],
  value: any,
  column: string,
) {
  if (!clean(value)) return;
  binds.push(value);
  clauses.push(`${column}=?${binds.length}`);
}
function locationScopeIds(filters: Row): string[] {
  const raw = Array.isArray(filters.locationIds)
    ? filters.locationIds
    : clean(filters.locationId)
      ? [filters.locationId]
      : [];
  return Array.from(new Set(raw.map((value) => clean(value)).filter(Boolean)));
}
function addSqlLocationScope(clauses: string[], binds: any[], filters: Row, column: string) {
  const ids = locationScopeIds(filters);
  if (!ids.length) return;
  const placeholders = ids.map((id) => {
    binds.push(id);
    return `?${binds.length}`;
  });
  clauses.push(`${column} IN (${placeholders.join(", ")})`);
}
function matchesLocationScope(value: unknown, filters: Row) {
  const permitted = locationScopeIds(filters);
  if (!permitted.length) return true;
  const values = (Array.isArray(value) ? value : [value]).map((value) => clean(value)).filter(Boolean);
  if (!values.length) return false;
  return values.some((id) => permitted.includes(id));
}
function dedupeRowsByKey(rows: Row[], keySelector: (row: Row) => string) {
  const seen = new Set<string>();
  const output: Row[] = [];
  for (const row of rows || []) {
    const key = clean(keySelector(row));
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    output.push(row);
  }
  return output;
}

function clean(value: any, fallback = "") {
  return String(value ?? fallback).trim();
}
function lower(value: any) {
  return clean(value).toLowerCase();
}
function number(value: any, fallback = 0) {
  const parsed =
    typeof value === "number"
      ? value
      : Number(
          String(value ?? "")
            .replace(/\s/g, "")
            .replace(/[^\d,.-]/g, "")
            .replace(",", "."),
        );
  return Number.isFinite(parsed) ? parsed : fallback;
}
function money(value: any) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}
function quantity(value: any) {
  return Math.round((number(value) + Number.EPSILON) * 10000) / 10000;
}
function boolean(value: any) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    ["true", "yes"].includes(lower(value))
  );
}
function parseJson(value: any): Row {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}
function title(value: any) {
  return clean(value)
    .replace(/[_-]+/g, " ")
    .replace(
      /\w\S*/g,
      (part: string) =>
        part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    );
}
function stockStatus(stock: number, threshold: number, par: number) {
  if (stock <= 0) return "Critical";
  if (stock <= threshold) return "Low";
  if (stock < par) return "Below Par";
  return "Healthy";
}
function isRecipeOnly(row: Row, raw: Row) {
  const type = lower(row.item_type || raw.itemType || raw.item_type);
  const sub =
    (type.includes("sub") && type.includes("recipe")) ||
    ["subrecipe", "sub_recipe"].includes(type);
  const holding =
    boolean(
      raw.stockHolding ||
        raw.stock_holding ||
        raw.isStockHolding ||
        raw.is_stock_holding ||
        raw.trackInventory ||
        raw.track_inventory,
    ) || type.includes("prep");
  return sub && !holding;
}
function allowsStock(raw: Row) {
  return boolean(
    raw.allowStockOnHand ||
      raw.allow_stock_on_hand ||
      raw.trackInventory ||
      raw.track_inventory,
  );
}
function matchesCommon(row: Row, filters: Row) {
  if (!matchesLocationScope(row.locationId, filters)) return false;
  if (filters.itemId && clean(row.itemId) !== filters.itemId) return false;
  const category = filters.category || filters.categoryId;
  if (category && lower(row.category) !== lower(category)) return false;
  return matchesSearch(row, filters.search);
}
function matchesSearch(row: Row, search: string) {
  if (!clean(search)) return true;
  return lower(
    Object.values(row)
      .filter((v) => typeof v === "string" || typeof v === "number")
      .join(" "),
  ).includes(lower(search));
}
function addCountWarning(
  rows: Row[],
  warnings: Warning[],
  code: string,
  level: string,
  message: string,
  predicate: (row: Row) => boolean,
) {
  const count = rows.filter(predicate).length;
  if (count) warnings.push({ code, level, message: `${count} ${message}` });
}
function uniqueWarnings(warnings: Warning[]) {
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.code}:${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function actorMap(env: Env, workspaceId: string, ids: any[]) {
  const values = [...new Set(ids.map((id) => clean(id)).filter(Boolean))];
  const map = new Map<string, Row>();
  if (!values.length) return map;
  const uid = values.map((_, i) => `?${i + 2}`).join(",");
  const email = values.map((_, i) => `?${values.length + i + 2}`).join(",");
  try {
    const rows = await env.CENTRAL_DB.prepare(
      `SELECT auth_uid,email,display_name FROM workspace_members WHERE workspace_id=?1 AND (auth_uid IN (${uid}) OR lower(email) IN (${email}))`,
    )
      .bind(workspaceId, ...values, ...values.map(lower))
      .all<Row>();
    for (const row of rows.results || []) {
      if (clean(row.auth_uid)) map.set(clean(row.auth_uid), row);
      if (clean(row.email)) map.set(clean(row.email), row);
    }
    return map;
  } catch {
    return map;
  }
}
function actorName(map: Map<string, Row>, id: any) {
  const row = map.get(clean(id));
  return clean(row?.display_name || row?.email);
}
async function filterOptions(env: Env, workspaceId: string, rows: Row[]) {
  const locations = await safeAll(
    env.DB.prepare(
      "SELECT id,COALESCE(display_name,name,external_name,id) name FROM locations WHERE workspace_id=?1 AND COALESCE(active,1)=1 ORDER BY name",
    ).bind(workspaceId),
  );
  const suppliers = await safeAll(
    env.DB.prepare(
      "SELECT id,name FROM suppliers WHERE workspace_id=?1 AND COALESCE(active,1)=1 ORDER BY name",
    ).bind(workspaceId),
  );
  const categories = [
    ...new Set(rows.map((r) => clean(r.category)).filter(Boolean)),
  ].sort();
  const statuses = [
    ...new Set(rows.map((r) => clean(r.status)).filter(Boolean)),
  ].sort();
  return {
    locations: locations.map((r: Row) => ({
      id: clean(r.id),
      name: clean(r.name),
    })),
    suppliers: suppliers.map((r: Row) => ({
      id: clean(r.id),
      name: clean(r.name),
    })),
    categories,
    statuses: statuses.map((name) => ({ name })),
  };
}
async function safeAll(statement: any) {
  try {
    return (await statement.all()).results || [];
  } catch {
    return [];
  }
}
