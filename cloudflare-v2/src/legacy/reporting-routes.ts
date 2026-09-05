import type { AuthContext, Env } from "./types";
import { assertWorkspaceAccess, assertReportLocationScope, getResolvedReportLocationScope } from "./auth";
import { json, limitFromUrl, offsetFromUrl, readJson } from "./http";
// Shared browser/Worker calculations keep interactive and scheduled reports identical.
// @ts-ignore JavaScript module shared with the Vite reporting client.
import {
  deriveYocoFinancialAmounts,
  resolveYocoVatRate,
  yocoMoneyToMajor,
} from "../../../src/modules/reporting/engine/yocoFinancials.js";
// @ts-ignore JavaScript module shared with the Vite reporting client.
import {
  appendIntegrityWarnings,
  buildReportIntegritySummary,
} from "../../../src/modules/reporting/engine/reportingIntegrity.js";
// @ts-ignore JavaScript module shared with the Vite reporting client.
import {
  localDateRangeToUtcBounds,
  normalizeReportTimeZone,
  normalizeTradingDayStartMinutes,
  resolveReportTimestamp,
  zonedTradingDateTimeStrings,
} from "../../../src/modules/reporting/engine/timezone.js";
import {
  historicalTransactionReference,
  resolveTransactionReferences,
  type TransactionEntityType,
} from "./transaction-references";

type Row = Record<string, any>;
type ReportWarning = {
  code: string;
  level: string;
  message: string;
  [key: string]: unknown;
};

// Hard safety ceiling for one canonical report data set. Pagination is handled by
// the client/scheduler, while hitting this ceiling is explicitly surfaced as a
// truncation condition so an incomplete report can never be exported silently.
const MAX_REPORT_ROWS = 1000000;

// A GRV edit that fixes a mistaken cost after same-day sales already happened against it writes a
// compensating 'cost_correction' stock_movements row (quantity_delta 0, only value_delta carries
// the fix) keyed back to the original sale's id via metadata_json.correctedMovementId — see
// buildSameDayCostCorrectionStatements in routes.ts. Append this column to any `sm`-aliased SELECT
// whose rows feed signedMovementStockCost, so a corrected sale's true cost is reflected in
// margin/GP reporting instead of silently staying wrong forever. The correlated subquery uses the
// existing idx_stock_movements_workspace_movement_type index (migration 39) to narrow to the
// (normally very few) cost_correction rows before matching by id, so it stays cheap even on a
// large ledger.
const COST_CORRECTION_VALUE_DELTA_SQL = `COALESCE((
          SELECT SUM(c.value_delta) FROM stock_movements c
           WHERE c.workspace_id = sm.workspace_id
             AND c.movement_type = 'cost_correction'
             AND json_extract(c.metadata_json, '$.correctedMovementId') = sm.id
        ), 0) AS cost_correction_value_delta`;

// stock_movements document types entered via a date-only picker (no time-of-day input), which
// therefore always store `occurred_at` as literal UTC midnight for any backdated entry. Reporting
// shows these as their real processing time (created_at) instead -- see standardizeMovementRow.
// Every other document type (sale, transfer, stock take, purchase order) carries a genuine
// externally- or system-captured occurred_at that must never be overridden this way.
const BACKDATABLE_LEDGER_DOCUMENT_TYPES = new Set([
  "grv",
  "credit_note",
  "adjustment",
  "wastage_adjustment",
  "sale_adjustment",
  "manufacturing_batch",
]);

// The SQL-level twin of BACKDATABLE_LEDGER_DOCUMENT_TYPES above, used to filter/sort
// stock_movements by the same "effective date" the JS-side standardizeMovementRow computes. Must
// match idx_stock_movements_workspace_effective_date (tenant-migrations.ts, migration 43) BOTH in
// the IN-list contents and in overall shape, or SQLite won't recognize it can use that index and
// will fall back to a full scan for date-range filtering.
const EFFECTIVE_MOVEMENT_DATE_SQL =
  "(CASE WHEN sm.document_type IN ('grv', 'credit_note', 'adjustment', 'wastage_adjustment', 'sale_adjustment', 'manufacturing_batch') THEN sm.created_at ELSE sm.occurred_at END)";

export async function getDetailedActivityReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
    tradingDayLabel: reportingContext.tradingDayLabel,
  };
  const requestedLimit = limitFromUrl(url, 500, 5000);
  const offset = offsetFromUrl(url);
  const generatedAt = new Date().toISOString();
  const warnings: ReportWarning[] = [];

  const tableCheck = await tableExists(env, "stock_movements");
  if (!tableCheck) {
    return json(request, env, {
      rows: [],
      warnings: [
        {
          code: "reporting-no-stock-ledger-table",
          level: "warning",
          message:
            "No true stock ledger table exists. Expected tenant table stock_movements was not found.",
        },
      ],
      meta: buildMeta(
        workspaceId,
        filters,
        0,
        requestedLimit,
        offset,
        generatedAt,
        { filterOptions: await getReportFilterOptions(env, workspaceId) },
      ),
    });
  }

  const { whereSql, binds } = buildMovementWhere(
    workspaceId,
    filters,
    timeZone,
  );
  const rawRows = await env.DB.prepare(
    `SELECT
        sm.id,
        sm.workspace_id,
        sm.stock_item_id,
        sm.location_id,
        sm.movement_type,
        sm.document_type,
        sm.document_id,
        sm.source_location_id,
        sm.destination_location_id,
        sm.quantity_delta,
        sm.unit_cost,
        sm.value_delta,
        sm.occurred_at,
        sm.created_by,
        sm.metadata_json,
        sm.created_at,
        si.name AS item_name,
        si.category AS category_name,
        si.item_type AS item_type,
        COALESCE(
          NULLIF(si.unit, ''),
          NULLIF(json_extract(sm.metadata_json, '$.baseUom'), ''),
          NULLIF(json_extract(sm.metadata_json, '$.base_uom'), ''),
          NULLIF(json_extract(sm.metadata_json, '$.unit'), '')
        ) AS base_uom,
        si.unit_cost AS stock_unit_cost,
        si.raw_json AS stock_item_raw_json,
        silp.price AS location_unit_cost,
        l.name AS location_name,
        l.display_name AS location_display_name,
        sl.name AS source_location_name,
        sl.display_name AS source_location_display_name,
        dl.name AS destination_location_name,
        dl.display_name AS destination_location_display_name,
        g.invoice_number AS grv_invoice_number,
        g.purchase_order_id AS grv_purchase_order_id,
        g.supplier_id AS supplier_id,
        s.name AS supplier_name,
        g.raw_json AS grv_raw_json,
        po.po_number AS po_number,
        cn.credit_note_number AS credit_note_number,
        cn.reason AS credit_note_reason,
        a.adjustment_type AS adjustment_type,
        a.reason AS adjustment_reason,
        st.status AS stocktake_status,
        t.transfer_type AS transfer_type,
        t.status AS transfer_status,
        t.from_location_id AS transfer_from_location_id,
        t.to_location_id AS transfer_to_location_id,
        t.from_workspace_id AS transfer_from_workspace_id,
        t.to_workspace_id AS transfer_to_workspace_id,
        t.requested_at AS transfer_requested_at,
        t.accepted_at AS transfer_accepted_at,
        t.raw_json AS transfer_raw_json,
        t.note AS transfer_note,
        mb.raw_json AS manufacturing_raw_json,
        yo.yoco_order_id AS yoco_order_number,
        yo.yoco_payment_id AS yoco_payment_id
       FROM stock_movements sm
       LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
       LEFT JOIN (
         SELECT workspace_id, stock_item_id, location_id, price, updated_at
           FROM (
             SELECT silp_source.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY silp_source.workspace_id, silp_source.stock_item_id, silp_source.location_id
                      ORDER BY datetime(silp_source.updated_at) DESC, silp_source.rowid DESC
                    ) AS canonical_rank
               FROM stock_item_location_prices silp_source
              WHERE silp_source.workspace_id = ?1
           )
          WHERE canonical_rank = 1
       ) silp ON silp.stock_item_id = sm.stock_item_id AND silp.location_id = sm.location_id AND silp.workspace_id = sm.workspace_id
       LEFT JOIN locations l ON l.id = sm.location_id AND l.workspace_id = sm.workspace_id
       LEFT JOIN locations sl ON sl.id = sm.source_location_id AND sl.workspace_id = sm.workspace_id
       LEFT JOIN locations dl ON dl.id = sm.destination_location_id AND dl.workspace_id = sm.workspace_id
       LEFT JOIN grvs g ON g.id = sm.document_id AND g.workspace_id = sm.workspace_id AND sm.document_type = 'grv'
       LEFT JOIN suppliers s ON s.id = g.supplier_id AND s.workspace_id = g.workspace_id
       LEFT JOIN purchase_orders po ON po.workspace_id = sm.workspace_id AND (po.id = g.purchase_order_id OR (po.id = sm.document_id AND sm.document_type = 'purchase_order'))
       LEFT JOIN credit_notes cn ON cn.id = sm.document_id AND cn.workspace_id = sm.workspace_id AND sm.document_type = 'credit_note'
       LEFT JOIN adjustments a ON a.id = sm.document_id AND a.workspace_id = sm.workspace_id AND sm.document_type IN ('adjustment', 'wastage_adjustment', 'sale_adjustment')
       LEFT JOIN stocktake_sessions st ON st.id = sm.document_id AND st.workspace_id = sm.workspace_id AND sm.document_type = 'stock_take'
       LEFT JOIN transfers t ON t.id = sm.document_id AND t.workspace_id = sm.workspace_id AND sm.document_type = 'transfer'
       LEFT JOIN manufacturing_batches mb ON mb.id = sm.document_id AND mb.workspace_id = sm.workspace_id AND sm.document_type = 'manufacturing_batch'
       LEFT JOIN yoco_orders yo ON yo.workspace_id = sm.workspace_id AND sm.document_type = 'yoco_order' AND yo.yoco_order_id = COALESCE(NULLIF(json_extract(sm.metadata_json, '$.reportOrderKey'), ''), sm.document_id)
      WHERE ${whereSql}
      ORDER BY datetime(${EFFECTIVE_MOVEMENT_DATE_SQL}) ASC, datetime(sm.created_at) ASC, sm.movement_type ASC, sm.id ASC
      LIMIT ?${binds.length + 1}`,
  )
    .bind(...binds, MAX_REPORT_ROWS)
    .all<Row>();

  const canonicalRawRows = dedupeRowsByKey(rawRows.results || [], (row) =>
    clean(row.id),
  );
  await enrichTransactionReferenceReportRows(
    env,
    workspaceId,
    canonicalRawRows,
  );
  await enrichExternalTransferReportRows(env, workspaceId, canonicalRawRows);
  const actorMap = await resolveActors(
    env,
    workspaceId,
    canonicalRawRows.map((row) => row.created_by),
  );
  const openingBalances = await getOpeningBalances(
    env,
    workspaceId,
    filters.from,
    timeZone,
    reportingContext.tradingDayStartMinutes,
  );
  const standardizedRows = calculateRunningRows(
    canonicalRawRows.map((row) =>
      standardizeMovementRow(row, actorMap, warnings, timeZone, reportingContext.tradingDayStartMinutes),
    ),
    openingBalances,
    warnings,
  ).filter((row) => applyPostFilters(row, filters));

  addDataQualityWarnings(standardizedRows, warnings);
  const integrity = appendIntegrityWarnings(standardizedRows, warnings);
  const filterOptions = await getReportFilterOptions(env, workspaceId);
  const sourceCoverage = buildSourceCoverage(standardizedRows);

  const pagedRows = standardizedRows.slice(offset, offset + requestedLimit);

  return json(request, env, {
    rows: pagedRows,
    warnings: uniqueWarnings(warnings),
    meta: buildMeta(
      workspaceId,
      filters,
      standardizedRows.length,
      requestedLimit,
      offset,
      generatedAt,
      { filterOptions, sourceCoverage, integrity, timeZone },
    ),
  });
}

// Human-readable translations for the machine warning codes stamped on a
// yoco_v2_proposed_stock_movements row when a sale line could not be resolved into an actual
// stock movement (see effect-proposals.ts, where these codes are assigned).
const UNRESOLVED_LINE_REASON_LABELS: Record<string, string> = {
  MENU_RECIPE_MISSING: "This menu item has no recipe configured, so no stock could be deducted.",
  MODIFIER_RECIPE_MISSING: "A modifier on this sale has no recipe configured.",
  ITEM_MAPPING_MISSING: "This menu item isn't mapped to a stock item yet.",
  MODIFIER_MAPPING_MISSING: "A modifier on this sale isn't mapped to a stock item yet.",
  MODIFIER_STOCK_ITEM_MISSING: "A modifier's linked stock item could not be found.",
  MODIFIER_STOCK_UOM_INVALID: "A modifier's stock item has an invalid unit of measure.",
  MODIFIER_RULE_SOURCE_INGREDIENT_MISSING: "A modifier rule's source ingredient could not be found.",
  MODIFIER_REPLACEMENT_ITEM_MISSING: "A modifier's replacement item could not be found.",
  RECIPE_CYCLE_DETECTED: "This item's recipe references itself (a recipe cycle), so it could not be costed.",
};

function unresolvedLineReasonLabel(warningCode: string): string {
  return UNRESOLVED_LINE_REASON_LABELS[warningCode]
    || `This line could not be resolved (code: ${warningCode || "unknown"}).`;
}

// Sales/lines that are structurally invisible to every other report — see getDetailedActivityReport
// and getSaleStockUsageReport, both of which only ever read stock_movements, which by definition
// never contains a row for these. Surfaced here, filtered to the SAME date range/location scope a
// report is currently showing, so "N shown, M excluded" stays in sync with what's on screen.
export async function getOperationsExcludedSummary(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
  };
  const limit = limitFromUrl(url, 200, 1000);

  const [domainEventsExists, proposalsExists] = await Promise.all([
    tableExists(env, "yoco_v2_domain_events"),
    tableExists(env, "yoco_v2_proposed_stock_movements"),
  ]);

  // yoco_v2_domain_events has no location_id column — location lives inside the stored canonical
  // event (payload_json.kcp_location_id, the same field applyReporting/applyStock later read to
  // write stock_movements.location_id — see sale-resolver.ts). Extracting it here is what lets
  // "N shown / M excluded" stay in sync when the report is filtered to one location instead of
  // silently reporting workspace-wide numbers next to a location-scoped report.
  const DOMAIN_EVENT_LOCATION_EXPR = "json_extract(payload_json, '$.kcp_location_id')";

  let unsupportedOrders: Row[] = [];
  let unsupportedOrderTotalCount = 0;
  let includedOrderCount = 0;
  if (domainEventsExists) {
    const clauses = ["workspace_id = ?1", "event_type = 'sale.completed'", "resolution_status = 'UNSUPPORTED_ORDER_STATE'"];
    const binds: unknown[] = [workspaceId];
    addZonedDateRange(clauses, binds, "occurred_at", filters, timeZone);
    addLocationSqlScope(clauses, binds, DOMAIN_EVENT_LOCATION_EXPR, filters);
    const whereSql = clauses.join(" AND ");

    // Counted separately from the row fetch below, which is capped at `limit` for the drill-down
    // list — otherwise a period with more excluded sales than the row cap would silently under-
    // report its own count in the "N excluded" banner (the exact kind of silent undercount this
    // whole feature exists to prevent).
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM yoco_v2_domain_events WHERE ${whereSql}`,
    ).bind(...binds).first<Row>();
    unsupportedOrderTotalCount = numberValue(countRow?.n);

    const rowBinds = [...binds, limit];
    const rows = await env.DB.prepare(
      `SELECT id, source_entity_id AS source_order_id, occurred_at
         FROM yoco_v2_domain_events
        WHERE ${whereSql}
        ORDER BY datetime(occurred_at) DESC
        LIMIT ?${rowBinds.length}`,
    ).bind(...rowBinds).all<Row>();
    unsupportedOrders = rows.results || [];

    // A count of sales that WERE eligible to be reported this period — independent of which
    // aggregation view (overview/by-item/ledger) is currently on screen, so "N shown" stays
    // meaningful no matter how the report is currently grouped.
    const includedClauses = ["workspace_id = ?1", "event_type = 'sale.completed'", "resolution_status <> 'UNSUPPORTED_ORDER_STATE'"];
    const includedBinds: unknown[] = [workspaceId];
    addZonedDateRange(includedClauses, includedBinds, "occurred_at", filters, timeZone);
    addLocationSqlScope(includedClauses, includedBinds, DOMAIN_EVENT_LOCATION_EXPR, filters);
    const includedRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM yoco_v2_domain_events WHERE ${includedClauses.join(" AND ")}`,
    ).bind(...includedBinds).first<Row>();
    includedOrderCount = numberValue(includedRow?.n);
  }

  let unresolvedLines: Row[] = [];
  let unresolvedLineTotalCount = 0;
  if (proposalsExists && domainEventsExists) {
    const clauses = ["psm.workspace_id = ?1", "COALESCE(psm.warning_code, '') <> ''"];
    const binds: unknown[] = [workspaceId];
    addZonedDateRange(clauses, binds, "de.occurred_at", filters, timeZone);
    addLocationSqlScope(clauses, binds, "psm.location_id", filters);
    const whereSql = clauses.join(" AND ");

    // Same reasoning as unsupportedOrderTotalCount above: count independently of the row cap.
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM yoco_v2_proposed_stock_movements psm
         JOIN yoco_v2_domain_events de ON de.id = psm.domain_event_id
        WHERE ${whereSql}`,
    ).bind(...binds).first<Row>();
    unresolvedLineTotalCount = numberValue(countRow?.n);

    const rowBinds = [...binds, limit];
    const rows = await env.DB.prepare(
      `SELECT psm.id, psm.source_order_id, psm.warning_code, de.occurred_at,
              l.name AS location_name, l.display_name AS location_display_name,
              p.name AS menu_item_name, si.name AS ingredient_name
         FROM yoco_v2_proposed_stock_movements psm
         JOIN yoco_v2_domain_events de ON de.id = psm.domain_event_id
         LEFT JOIN locations l ON l.id = psm.location_id AND l.workspace_id = psm.workspace_id
         LEFT JOIN products p ON p.id = psm.menu_item_id AND p.workspace_id = psm.workspace_id
         LEFT JOIN stock_items si ON si.id = psm.ingredient_item_id AND si.workspace_id = psm.workspace_id
        WHERE ${whereSql}
        ORDER BY datetime(de.occurred_at) DESC
        LIMIT ?${rowBinds.length}`,
    ).bind(...rowBinds).all<Row>();
    unresolvedLines = rows.results || [];
  }

  return json(request, env, {
    includedOrderCount,
    unsupportedOrders: {
      count: unsupportedOrderTotalCount,
      truncated: unsupportedOrders.length < unsupportedOrderTotalCount,
      rows: unsupportedOrders.map((row) => ({
        id: clean(row.id),
        sourceOrderId: clean(row.source_order_id),
        occurredAt: clean(row.occurred_at),
        reason: "This order was not in a completed/paid state when Yoco sent it, so it could not be reported.",
      })),
    },
    unresolvedLines: {
      count: unresolvedLineTotalCount,
      truncated: unresolvedLines.length < unresolvedLineTotalCount,
      rows: unresolvedLines.map((row) => ({
        id: clean(row.id),
        sourceOrderId: clean(row.source_order_id),
        occurredAt: clean(row.occurred_at),
        locationName: clean(row.location_display_name || row.location_name),
        itemName: clean(row.menu_item_name || row.ingredient_name) || "Unknown item",
        warningCode: clean(row.warning_code),
        reason: unresolvedLineReasonLabel(clean(row.warning_code)),
      })),
    },
    meta: buildMeta(workspaceId, filters, unsupportedOrderTotalCount + unresolvedLineTotalCount, limit, 0, new Date().toISOString(), { timeZone }),
  });
}

export async function getStockTakeAuditReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
    tradingDayLabel: reportingContext.tradingDayLabel,
  };
  const requestedLimit = limitFromUrl(url, 500, 5000);
  const offset = offsetFromUrl(url);
  const generatedAt = new Date().toISOString();
  const warnings: Array<{ code: string; level: string; message: string }> = [];

  const requiredTables = [
    "stocktake_sessions",
    "stocktake_count_lines",
    "stock_movements",
    "stock_items",
    "locations",
  ];
  const tableStatus: Record<string, boolean> = {};
  for (const table of requiredTables)
    tableStatus[table] = await tableExists(env, table);
  const missingTables = requiredTables.filter((table) => !tableStatus[table]);
  if (missingTables.length) {
    return json(request, env, {
      rows: [],
      warnings: [
        {
          code: "stocktake-audit-missing-source-tables",
          level: "warning",
          message: `Stock Take Audit cannot load because source table(s) are missing: ${missingTables.join(", ")}.`,
        },
      ],
      meta: buildMeta(
        workspaceId,
        filters,
        0,
        requestedLimit,
        offset,
        generatedAt,
        {
          filterOptions: await getReportFilterOptions(env, workspaceId),
          sourceTables: tableStatus,
        },
      ),
    });
  }

  const { whereSql, binds } = buildStockTakeWhere(
    workspaceId,
    filters,
    timeZone,
  );
  const rows = await env.DB.prepare(
    `SELECT
        stcl.id,
        stcl.workspace_id,
        stcl.stocktake_session_id,
        stcl.stock_item_id,
        stcl.location_id,
        stcl.expected_qty,
        COALESCE(stcl.counted_qty, 0) AS counted_qty,
        stcl.variance_qty,
        stcl.unit_cost,
        sts.status,
        sts.counted_at,
        sts.created_by,
        sts.raw_json AS session_raw_json,
        sts.created_at AS session_created_at,
        sts.updated_at AS session_updated_at,
        si.name AS item_name,
        si.category AS category_name,
        si.unit AS base_uom,
        si.unit_cost AS stock_unit_cost,
        si.item_type AS item_type,
        COALESCE(si.is_stocked, 1) AS is_stocked,
        l.name AS location_name,
        l.display_name AS location_display_name,
        COALESCE(sm.ledger_net_qty, 0) AS ledger_net_qty,
        COALESCE(sm.ledger_movement_value, 0) AS ledger_movement_value,
        COALESCE(sm.ledger_row_count, 0) AS ledger_row_count,
        COALESCE(sm.variance_movement_row_count, 0) AS variance_movement_row_count
       FROM stocktake_count_lines stcl
       JOIN stocktake_sessions sts ON sts.id = stcl.stocktake_session_id AND sts.workspace_id = stcl.workspace_id
       LEFT JOIN stock_items si ON si.id = stcl.stock_item_id AND si.workspace_id = stcl.workspace_id
       LEFT JOIN locations l ON l.id = stcl.location_id AND l.workspace_id = stcl.workspace_id
       LEFT JOIN (
          SELECT workspace_id, document_id, stock_item_id, location_id,
                 COALESCE(SUM(quantity_delta), 0) AS ledger_net_qty,
                 COALESCE(SUM(value_delta), 0) AS ledger_movement_value,
                 COUNT(*) AS ledger_row_count,
                 SUM(CASE WHEN movement_type = 'stock_take_variance' THEN 1 ELSE 0 END) AS variance_movement_row_count
            FROM stock_movements
           WHERE document_type = 'stock_take'
             AND movement_type IN ('stock_take_variance', 'stock_take_correction')
           GROUP BY workspace_id, document_id, stock_item_id, location_id
       ) sm ON sm.workspace_id = stcl.workspace_id
            AND sm.document_id = stcl.stocktake_session_id
            AND sm.stock_item_id = stcl.stock_item_id
            AND sm.location_id = stcl.location_id
      WHERE ${whereSql}
      ORDER BY datetime(sts.counted_at) DESC, COALESCE(l.display_name, l.name), si.category, si.name
      LIMIT ?${binds.length + 1}`,
  )
    .bind(...binds, MAX_REPORT_ROWS)
    .all<Row>();

  const sourceRows = dedupeRowsByKey(rows.results || [], (row) =>
    clean(row.id),
  );
  const stockTakeReferences = await resolveTransactionReferences(
    env,
    workspaceId,
    sourceRows,
    "stock_take",
    "stocktake_session_id",
  );
  const actorMap = await resolveActors(
    env,
    workspaceId,
    sourceRows.map((row) => row.created_by),
  );
  const standardizedRows = sourceRows
    .map((row) => {
      const standardized = standardizeStockTakeAuditRow(
        row,
        actorMap,
        timeZone,
      );
      const sessionRaw = parseJson(row.session_raw_json);
      return {
        ...standardized,
        transactionReference:
          clean(sessionRaw.transactionReference) ||
          stockTakeReferences.get(clean(row.stocktake_session_id)) ||
          historicalTransactionReference(
            "stock_take",
            clean(row.stocktake_session_id),
            row.counted_at || row.session_created_at,
          ),
      };
    })
    .filter((row) => applyPostFilters(row, filters));
  const integrity = appendIntegrityWarnings(standardizedRows, warnings);
  const pagedRows = standardizedRows.slice(offset, offset + requestedLimit);

  return json(request, env, {
    rows: pagedRows,
    warnings: uniqueWarnings(warnings),
    meta: buildMeta(
      workspaceId,
      filters,
      standardizedRows.length,
      requestedLimit,
      offset,
      generatedAt,
      {
        filterOptions: await getReportFilterOptions(env, workspaceId),
        sourceTables: tableStatus,
        integrity,
        timeZone,
        dataSource: "real",
      },
    ),
  });
}

export async function getSalesFinancialReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
    tradingDayLabel: reportingContext.tradingDayLabel,
  };
  const requestedLimit = limitFromUrl(url, 500, 5000);
  const offset = offsetFromUrl(url);
  const generatedAt = new Date().toISOString();
  const warnings: Array<{ code: string; level: string; message: string }> = [];

  const requiredTables = [
    "yoco_orders",
    "yoco_order_lines",
    "locations",
    "products",
    "stock_movements",
    "workspace_settings",
  ];
  const tableStatus: Record<string, boolean> = {};
  for (const table of requiredTables)
    tableStatus[table] = await tableExists(env, table);
  // Checking the TABLE exists is not enough for vat_registered specifically — workspace_settings
  // has existed for a long time, so tableStatus.workspace_settings is already true on any
  // workspace whose vat_registered column migration simply hasn't finished applying yet (e.g.
  // still working through the migration circuit-breaker's backoff). Referencing the column in SQL
  // before it exists throws "no such column", which is exactly what caused sales-financial (and
  // the other reports below) to 500 for a workspace mid-migration. Gate on the column directly.
  const vatRegisteredColumnAvailable =
    tableStatus.workspace_settings &&
    (await tableHasColumns(env, "workspace_settings", ["vat_registered"]));
  const orderVatColumnsAvailable =
    tableStatus.yoco_orders &&
    (await tableHasColumns(env, "yoco_orders", ["vat_rate", "vat_registered"]));
  if (!tableStatus.yoco_orders) {
    return json(request, env, {
      rows: [],
      warnings: [
        {
          code: "sales-financial-missing-source-tables",
          level: "warning",
          message:
            "Sales Financial reporting cannot load because yoco_orders is missing.",
        },
      ],
      meta: buildMeta(
        workspaceId,
        filters,
        0,
        requestedLimit,
        offset,
        generatedAt,
        { sourceTables: tableStatus, truncated: false, serverPaginated: true },
      ),
    });
  }

  const { whereSql, binds } = buildSalesWhere(
    workspaceId,
    filters,
    tableStatus,
    timeZone,
  );
  const limitBind = binds.length + 1;
  const offsetBind = binds.length + 2;
  const rows = await env.DB.prepare(
    `WITH ranked_yoco_orders AS (
       SELECT yo.*,
              ROW_NUMBER() OVER (
                PARTITION BY yo.workspace_id,
                             COALESCE(NULLIF(yo.yoco_order_id, ''), yo.id),
                             COALESCE(NULLIF(yo.order_type, ''), 'sale')
                ORDER BY datetime(COALESCE(NULLIF(yo.occurred_at, ''), yo.created_at)) DESC,
                         datetime(yo.created_at) DESC,
                         yo.id DESC
              ) AS canonical_rank
         FROM yoco_orders yo
        WHERE yo.workspace_id = ?1
     ),
     canonical_yoco_orders AS (
       SELECT * FROM ranked_yoco_orders WHERE canonical_rank = 1
     ),
     filtered_orders AS (
       SELECT
        yo.id,
        yo.workspace_id,
        yo.yoco_order_id,
        yo.yoco_payment_id,
        yo.parent_yoco_order_id,
        yo.provider_refund_id,
        yo.refund_reason,
        yo.refund_behavior,
        yo.location_id,
        yo.order_type,
        yo.status,
        CASE
          WHEN lower(COALESCE(yo.order_type, '')) = 'refund' THEN COALESCE(
            NULLIF(CASE WHEN lower(COALESCE(yo.payment_method, '')) NOT IN ('', 'refund') THEN yo.payment_method ELSE '' END, ''),
            NULLIF(parent_yo.payment_method, ''),
            'Unknown'
          )
          ELSE COALESCE(NULLIF(yo.payment_method, ''), 'Unknown')
        END AS payment_method,
        parent_yo.payment_method AS original_payment_method,
        yo.total,
        yo.gross_total,
        yo.vat_total,
        yo.net_total,
        yo.occurred_at,
        yo.raw_json,
        yo.created_at,
        l.name AS location_name,
        l.display_name AS location_display_name,
        ${buildVatRateSqlExpression({
          orderAlias: "yo",
          fallbackWorkspaceIdExpr: "yo.workspace_id",
          orderVatColumnsAvailable,
          vatRegisteredColumnAvailable,
          workspaceSettingsExists: tableStatus.workspace_settings,
        })} AS vat_rate,
        COUNT(*) OVER() AS __total_rows
       FROM canonical_yoco_orders yo
       LEFT JOIN canonical_yoco_orders parent_yo
         ON parent_yo.workspace_id = yo.workspace_id
        AND parent_yo.yoco_order_id = yo.parent_yoco_order_id
        AND lower(COALESCE(parent_yo.order_type, 'sale')) <> 'refund'
       LEFT JOIN locations l ON l.id = yo.location_id AND l.workspace_id = yo.workspace_id
      WHERE ${whereSql}
     )
     SELECT *
       FROM filtered_orders
      ORDER BY datetime(occurred_at) DESC, id DESC
      LIMIT ?${limitBind} OFFSET ?${offsetBind}`,
  )
    .bind(...binds, requestedLimit, offset)
    .all<Row>();

  const sourceRows = rows.results || [];
  const totalRows = sourceRows.length
    ? numberValue(sourceRows[0].__total_rows, sourceRows.length)
    : 0;
  const standardizedRows = sourceRows.map((row) =>
    standardizeSalesFinancialRow(row, warnings, timeZone, reportingContext.tradingDayStartMinutes),
  );
  addSalesFinancialWarnings(standardizedRows, warnings);
  const integrity = appendIntegrityWarnings(standardizedRows, warnings);

  return json(request, env, {
    rows: standardizedRows,
    warnings: uniqueWarnings(warnings),
    meta: buildMeta(
      workspaceId,
      filters,
      totalRows,
      requestedLimit,
      offset,
      generatedAt,
      {
        sourceTables: tableStatus,
        filterOptions: await getReportFilterOptions(env, workspaceId),
        integrity,
        timeZone,
        dataSource: "real",
        truncated: false,
        serverPaginated: true,
        sourceDeduplicated: true,
        sourceRowsFetched: sourceRows.length,
      },
    ),
  });
}

export async function getSaleStockUsageReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  sourceScope: "all" | "modifier" = "all",
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
    tradingDayLabel: reportingContext.tradingDayLabel,
  };
  const requestedLimit = limitFromUrl(url, 500, 5000);
  const offset = offsetFromUrl(url);
  const generatedAt = new Date().toISOString();
  const warnings: Array<{ code: string; level: string; message: string }> = [];

  const requiredTables = [
    "stock_movements",
    "stock_items",
    "locations",
    "yoco_orders",
    "yoco_order_lines",
    "workspace_settings",
  ];
  const tableStatus: Record<string, boolean> = {};
  for (const table of requiredTables)
    tableStatus[table] = await tableExists(env, table);
  // See getSalesFinancialReport for why this can't just check tableStatus.workspace_settings.
  const vatRegisteredColumnAvailable =
    tableStatus.workspace_settings &&
    (await tableHasColumns(env, "workspace_settings", ["vat_registered"]));
  const orderVatColumnsAvailable =
    tableStatus.yoco_orders &&
    (await tableHasColumns(env, "yoco_orders", ["vat_rate", "vat_registered"]));
  if (!tableStatus.stock_movements) {
    return json(request, env, {
      rows: [],
      warnings: [
        {
          code: "sale-stock-usage-missing-ledger",
          level: "warning",
          message:
            "Sale Stock Usage reporting cannot load because stock_movements is missing.",
        },
      ],
      meta: buildMeta(
        workspaceId,
        filters,
        0,
        requestedLimit,
        offset,
        generatedAt,
        { sourceTables: tableStatus },
      ),
    });
  }

  const { whereSql, binds } = buildSaleUsageWhere(
    workspaceId,
    filters,
    tableStatus,
    sourceScope,
    timeZone,
  );
  const rows = await env.DB.prepare(
    `SELECT
        sm.id,
        sm.workspace_id,
        sm.stock_item_id,
        sm.location_id,
        sm.movement_type,
        sm.document_type,
        sm.document_id,
        sm.quantity_delta,
        sm.unit_cost,
        sm.value_delta,
        sm.occurred_at,
        sm.created_by,
        sm.metadata_json,
        sm.created_at,
        si.name AS item_name,
        si.category AS category_name,
        COALESCE(
          NULLIF(si.unit, ''),
          NULLIF(json_extract(sm.metadata_json, '$.baseUom'), ''),
          NULLIF(json_extract(sm.metadata_json, '$.base_uom'), ''),
          NULLIF(json_extract(sm.metadata_json, '$.unit'), '')
        ) AS base_uom,
        ${COST_CORRECTION_VALUE_DELTA_SQL},
        l.name AS location_name,
        l.display_name AS location_display_name,
        yo.id AS yoco_order_db_id,
        yo.yoco_order_id,
        yo.yoco_payment_id,
        yo.parent_yoco_order_id,
        yo.provider_refund_id,
        yo.refund_reason,
        yo.refund_behavior,
        yo.payment_method,
        yo.status AS sale_status,
        yo.total AS order_total,
        yo.raw_json AS order_raw_json,
        COALESCE(yol.id, original_yol.id) AS yoco_order_line_db_id,
        COALESCE(yol.yoco_line_id, original_yol.yoco_line_id) AS yoco_line_id,
        COALESCE(yol.product_id, original_yol.product_id) AS line_product_id,
        COALESCE(yol.name, original_yol.name) AS line_name,
        COALESCE(yol.quantity, original_yol.quantity) AS line_quantity,
        COALESCE(yol.total, original_yol.total) AS line_total,
        COALESCE(yol.raw_json, original_yol.raw_json) AS line_raw_json,
        p.name AS product_name,
        p.category AS product_category,
        ${buildVatRateSqlExpression({
          orderAlias: "yo",
          fallbackWorkspaceIdExpr: "sm.workspace_id",
          orderVatColumnsAvailable,
          vatRegisteredColumnAvailable,
          workspaceSettingsExists: tableStatus.workspace_settings,
        })} AS vat_rate
       FROM stock_movements sm
       LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
       LEFT JOIN locations l ON l.id = sm.location_id AND l.workspace_id = sm.workspace_id
       LEFT JOIN (
         SELECT * FROM (
           SELECT yo_source.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY yo_source.workspace_id,
                                 COALESCE(NULLIF(yo_source.yoco_order_id, ''), yo_source.id),
                                 COALESCE(NULLIF(yo_source.order_type, ''), 'sale')
                    ORDER BY datetime(COALESCE(NULLIF(yo_source.occurred_at, ''), yo_source.created_at)) DESC,
                             datetime(yo_source.created_at) DESC,
                             yo_source.id DESC
                  ) AS canonical_rank
             FROM yoco_orders yo_source
            WHERE yo_source.workspace_id = ?1
         ) WHERE canonical_rank = 1
       ) yo ON yo.workspace_id = sm.workspace_id AND yo.yoco_order_id = COALESCE(NULLIF(json_extract(sm.metadata_json, '$.reportOrderKey'), ''), sm.document_id)
       LEFT JOIN (
         SELECT * FROM (
           SELECT yol_source.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY yol_source.workspace_id,
                                 yol_source.yoco_order_id,
                                 COALESCE(NULLIF(yol_source.yoco_line_id, ''), yol_source.id)
                    ORDER BY yol_source.id DESC
                  ) AS canonical_rank
             FROM yoco_order_lines yol_source
            WHERE yol_source.workspace_id = ?1
         ) WHERE canonical_rank = 1
       ) yol ON yol.workspace_id = sm.workspace_id
             AND yol.yoco_order_id = yo.id
             AND yol.yoco_line_id = COALESCE(
               NULLIF(json_extract(sm.metadata_json, '$.componentLineId'), ''),
               NULLIF(json_extract(sm.metadata_json, '$.component_line_id'), ''),
               NULLIF(json_extract(sm.metadata_json, '$.sourceLineId'), ''),
               NULLIF(json_extract(sm.metadata_json, '$.source_line_id'), ''),
               NULLIF(json_extract(sm.metadata_json, '$.sourceRefundLineId'), ''),
               NULLIF(json_extract(sm.metadata_json, '$.sourceOriginalLineId'), '')
             )
       LEFT JOIN (
         SELECT * FROM (
           SELECT original_yo_source.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY original_yo_source.workspace_id,
                                 COALESCE(NULLIF(original_yo_source.yoco_order_id, ''), original_yo_source.id),
                                 COALESCE(NULLIF(original_yo_source.order_type, ''), 'sale')
                    ORDER BY datetime(COALESCE(NULLIF(original_yo_source.occurred_at, ''), original_yo_source.created_at)) DESC,
                             datetime(original_yo_source.created_at) DESC,
                             original_yo_source.id DESC
                  ) AS canonical_rank
             FROM yoco_orders original_yo_source
            WHERE original_yo_source.workspace_id = ?1
         ) WHERE canonical_rank = 1
       ) original_yo ON original_yo.workspace_id = sm.workspace_id
                    AND original_yo.yoco_order_id = COALESCE(
                      NULLIF(json_extract(sm.metadata_json, '$.sourceOrderId'), ''),
                      NULLIF(json_extract(sm.metadata_json, '$.originalOrderId'), ''),
                      sm.document_id
                    )
                    AND lower(COALESCE(original_yo.order_type, 'sale')) <> 'refund'
       LEFT JOIN (
         SELECT * FROM (
           SELECT original_yol_source.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY original_yol_source.workspace_id,
                                 original_yol_source.yoco_order_id,
                                 COALESCE(NULLIF(original_yol_source.yoco_line_id, ''), original_yol_source.id)
                    ORDER BY original_yol_source.id DESC
                  ) AS canonical_rank
             FROM yoco_order_lines original_yol_source
            WHERE original_yol_source.workspace_id = ?1
         ) WHERE canonical_rank = 1
       ) original_yol ON original_yol.workspace_id = sm.workspace_id
                     AND original_yol.yoco_order_id = original_yo.id
                     AND original_yol.yoco_line_id = COALESCE(
                       NULLIF(json_extract(sm.metadata_json, '$.sourceOriginalLineId'), ''),
                       NULLIF(json_extract(sm.metadata_json, '$.componentLineId'), '')
                     )
       LEFT JOIN products p ON p.workspace_id = sm.workspace_id AND p.id = COALESCE(
         yol.product_id,
         original_yol.product_id,
         json_extract(sm.metadata_json, '$.productId'),
         json_extract(sm.metadata_json, '$.product_id'),
         json_extract(sm.metadata_json, '$.menuItemId'),
         json_extract(sm.metadata_json, '$.menu_item_id'),
         json_extract(sm.metadata_json, '$.parentProductId'),
         json_extract(sm.metadata_json, '$.parent_product_id')
       )
      WHERE ${whereSql}
      ORDER BY datetime(sm.occurred_at) DESC, sm.id DESC
      LIMIT ?${binds.length + 1}`,
  )
    .bind(...binds, MAX_REPORT_ROWS)
    .all<Row>();

  const canonicalUsageRows = dedupeRowsByKey(rows.results || [], (row) =>
    clean(row.id),
  );
  const standardizedRows = canonicalUsageRows.map((row) =>
    standardizeSaleStockUsageRow(row, warnings, timeZone, reportingContext.tradingDayStartMinutes),
  );
  const pagedRows = standardizedRows.slice(offset, offset + requestedLimit);
  addSaleStockUsageWarnings(standardizedRows, warnings, sourceScope);
  const integrity = appendIntegrityWarnings(standardizedRows, warnings);

  return json(request, env, {
    rows: pagedRows,
    warnings: uniqueWarnings(warnings),
    meta: buildMeta(
      workspaceId,
      filters,
      standardizedRows.length,
      requestedLimit,
      offset,
      generatedAt,
      {
        sourceTables: tableStatus,
        sourceCoverage: buildSourceCoverage(standardizedRows),
        filterOptions: await getReportFilterOptions(env, workspaceId),
        integrity,
        timeZone,
        dataSource: "real",
        sourceDeduplicated: true,
      },
    ),
  });
}

export async function getModifierSalesReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
    tradingDayLabel: reportingContext.tradingDayLabel,
  };
  const requestedLimit = limitFromUrl(url, 500, 5000);
  const offset = offsetFromUrl(url);
  const generatedAt = new Date().toISOString();
  const warnings: Array<{ code: string; level: string; message: string }> = [];

  const requiredTables = [
    "yoco_orders",
    "yoco_order_lines",
    "locations",
    "products",
    "stock_movements",
    "stock_items",
    "workspace_settings",
    "yoco_modifier_groups",
    "modifier_rules",
    "modifier_sale_action_snapshots",
  ];
  const tableStatus: Record<string, boolean> = {};
  for (const table of requiredTables)
    tableStatus[table] = await tableExists(env, table);
  // See getSalesFinancialReport for why this can't just check tableStatus.workspace_settings.
  const vatRegisteredColumnAvailable =
    tableStatus.workspace_settings &&
    (await tableHasColumns(env, "workspace_settings", ["vat_registered"]));
  const orderVatColumnsAvailable =
    tableStatus.yoco_orders &&
    (await tableHasColumns(env, "yoco_orders", ["vat_rate", "vat_registered"]));
  if (!tableStatus.yoco_orders || !tableStatus.yoco_order_lines) {
    return json(request, env, {
      rows: [],
      warnings: [
        {
          code: "modifier-report-missing-source-tables",
          level: "warning",
          message:
            "Modifier Report cannot load because synced Yoco order tables are missing.",
        },
      ],
      meta: buildMeta(
        workspaceId,
        filters,
        0,
        requestedLimit,
        offset,
        generatedAt,
        { sourceTables: tableStatus, dataSource: "real" },
      ),
    });
  }

  const { whereSql, binds } = buildModifierSalesWhere(
    workspaceId,
    filters,
    tableStatus,
    timeZone,
  );
  const salesRows = await env.DB.prepare(
    `SELECT
        yol.id AS yoco_order_line_db_id,
        yol.workspace_id,
        yol.yoco_order_id AS yoco_order_db_id,
        yol.product_id AS line_product_id,
        yol.yoco_line_id,
        yol.name AS line_name,
        yol.quantity AS line_quantity,
        yol.total AS line_total,
        yol.raw_json AS line_raw_json,
        yo.id AS yoco_order_db_id_joined,
        yo.yoco_order_id,
        yo.yoco_payment_id,
        yo.parent_yoco_order_id,
        yo.provider_refund_id,
        yo.refund_reason,
        yo.refund_behavior,
        yo.location_id,
        yo.order_type,
        yo.status,
        yo.payment_method,
        yo.total AS order_total,
        yo.occurred_at,
        yo.raw_json AS order_raw_json,
        l.name AS location_name,
        l.display_name AS location_display_name,
        p.name AS product_name,
        p.category AS product_category,
        p.yoco_item_id,
        p.yoco_variant_id,
        p.raw_json AS product_raw_json,
        ${buildVatRateSqlExpression({
          orderAlias: "yo",
          fallbackWorkspaceIdExpr: "yol.workspace_id",
          orderVatColumnsAvailable,
          vatRegisteredColumnAvailable,
          workspaceSettingsExists: tableStatus.workspace_settings,
        })} AS vat_rate
       FROM (
         SELECT * FROM (
           SELECT yol_source.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY yol_source.workspace_id,
                                 yol_source.yoco_order_id,
                                 COALESCE(NULLIF(yol_source.yoco_line_id, ''), yol_source.id)
                    ORDER BY yol_source.id DESC
                  ) AS canonical_rank
             FROM yoco_order_lines yol_source
            WHERE yol_source.workspace_id = ?1
         ) WHERE canonical_rank = 1
       ) yol
       JOIN (
         SELECT * FROM (
           SELECT yo_source.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY yo_source.workspace_id,
                                 COALESCE(NULLIF(yo_source.yoco_order_id, ''), yo_source.id),
                                 COALESCE(NULLIF(yo_source.order_type, ''), 'sale')
                    ORDER BY datetime(COALESCE(NULLIF(yo_source.occurred_at, ''), yo_source.created_at)) DESC,
                             datetime(yo_source.created_at) DESC,
                             yo_source.id DESC
                  ) AS canonical_rank
             FROM yoco_orders yo_source
            WHERE yo_source.workspace_id = ?1
         ) WHERE canonical_rank = 1
       ) yo ON yo.id = yol.yoco_order_id AND yo.workspace_id = yol.workspace_id
       LEFT JOIN locations l ON l.id = yo.location_id AND l.workspace_id = yo.workspace_id
       LEFT JOIN products p ON p.id = yol.product_id AND p.workspace_id = yol.workspace_id
      WHERE ${whereSql}
      ORDER BY datetime(yo.occurred_at) DESC, yo.id DESC, yol.id DESC
      LIMIT ?${binds.length + 1}`,
  )
    .bind(...binds, MAX_REPORT_ROWS)
    .all<Row>();

  const modifierRulesReportingReady = tableStatus.modifier_rules
    ? await tableHasColumns(env, "modifier_rules", [
        "workspace_id",
        "modifier_owner_id",
        "source_modifier_id",
        "source_modifier_group_id",
        "source_modifier_variant_id",
        "source_name",
        "action_type",
        "status",
      ])
    : false;
  const modifierActionSnapshotsReportingReady = tableStatus.modifier_sale_action_snapshots
    ? await tableHasColumns(env, "modifier_sale_action_snapshots", [
        "workspace_id",
        "source_order_id",
        "source_line_id",
        "source_kind",
        "source_key",
        "source_name",
        "rule_id",
        "action_type",
      ])
    : false;
  tableStatus.modifier_rules_reporting_ready = modifierRulesReportingReady;
  tableStatus.modifier_sale_action_snapshots_reporting_ready =
    modifierActionSnapshotsReportingReady;

  // Do not join modifier_sale_action_snapshots directly onto stock_movements.
  // The historical OR/LIKE join can produce a workspace-wide nested scan and breach
  // the Durable Object CPU budget. Snapshot enrichment is loaded in bounded chunks
  // after the ledger rows have been selected.
  const modifierActionColumns = `,
        '' AS movement_modifier_source_id,
        '' AS movement_modifier_source_name,
        '' AS movement_modifier_action_type`;

  const usageWhere = buildModifierUsageOnlyWhere(
    workspaceId,
    filters,
    timeZone,
  );
  const usageRows = tableStatus.stock_movements
    ? await env.DB.prepare(
        `SELECT
        sm.id,
        sm.workspace_id,
        sm.stock_item_id,
        sm.location_id,
        sm.movement_type,
        sm.document_type,
        sm.document_id,
        sm.quantity_delta,
        sm.unit_cost,
        sm.value_delta,
        sm.occurred_at,
        sm.created_by,
        sm.metadata_json,
        sm.created_at,
        si.name AS item_name,
        si.category AS category_name,
        COALESCE(
          NULLIF(si.unit, ''),
          NULLIF(json_extract(sm.metadata_json, '$.baseUom'), ''),
          NULLIF(json_extract(sm.metadata_json, '$.base_uom'), ''),
          NULLIF(json_extract(sm.metadata_json, '$.unit'), '')
        ) AS base_uom,
        ${COST_CORRECTION_VALUE_DELTA_SQL}
        ${modifierActionColumns}
       FROM stock_movements sm
       LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
      WHERE ${usageWhere.whereSql}`
      )
        .bind(...usageWhere.binds)
        .all<Row>()
    : { results: [] };

  const menuUsageWhere = buildMenuItemUsageWhere(workspaceId, filters, timeZone);
  const menuUsageRows = tableStatus.stock_movements
    ? await env.DB.prepare(
        `SELECT
        sm.id,
        sm.workspace_id,
        sm.stock_item_id,
        sm.location_id,
        sm.movement_type,
        sm.document_type,
        sm.document_id,
        sm.quantity_delta,
        sm.unit_cost,
        sm.value_delta,
        sm.occurred_at,
        sm.created_by,
        sm.metadata_json,
        sm.created_at,
        si.name AS item_name,
        si.category AS category_name,
        COALESCE(
          NULLIF(si.unit, ''),
          NULLIF(json_extract(sm.metadata_json, '$.baseUom'), ''),
          NULLIF(json_extract(sm.metadata_json, '$.base_uom'), ''),
          NULLIF(json_extract(sm.metadata_json, '$.unit'), '')
        ) AS base_uom,
        ${COST_CORRECTION_VALUE_DELTA_SQL}
        ${modifierActionColumns}
       FROM stock_movements sm
       LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
      WHERE ${menuUsageWhere.whereSql}`
      )
        .bind(...menuUsageWhere.binds)
        .all<Row>()
    : { results: [] };

  const modifierCatalogue = tableStatus.yoco_modifier_groups
    ? await loadModifierCatalogue(env, workspaceId, modifierRulesReportingReady, warnings)
    : new Map<string, Row>();
  const canonicalModifierSalesRows = dedupeRowsByKey(
    salesRows.results || [],
    (row) => clean(row.yoco_order_line_db_id || row.id),
  );
  const rawModifierUsageRows = dedupeRowsByKey(
    usageRows.results || [],
    (row) => clean(row.id),
  );
  const rawMenuUsageRows = dedupeRowsByKey(
    menuUsageRows.results || [],
    (row) => clean(row.id),
  );
  const canonicalModifierUsageRows = modifierActionSnapshotsReportingReady
    ? await enrichModifierUsageRowsWithActionSnapshots(
        env,
        workspaceId,
        rawModifierUsageRows,
        warnings,
      )
    : rawModifierUsageRows;
  const canonicalMenuUsageRows = modifierActionSnapshotsReportingReady
    ? await enrichModifierUsageRowsWithActionSnapshots(
        env,
        workspaceId,
        rawMenuUsageRows,
        warnings,
      )
    : rawMenuUsageRows;
  const usageIndex = buildModifierUsageIndex(canonicalModifierUsageRows);
  const menuUsageIndex = buildMenuItemUsageIndex(canonicalMenuUsageRows);
  const standardizedRows: Row[] = [];

  for (const row of canonicalModifierSalesRows) {
    try {
      const extracted = extractModifierSelectionsFromLine(row, modifierCatalogue);
      for (const selection of extracted) {
        try {
          const standardized = standardizeModifierSalesRow(
            row,
            selection,
            usageIndex,
            menuUsageIndex,
            warnings,
            timeZone,
            reportingContext.tradingDayStartMinutes,
          );
          if (modifierSalesRowMatchesFilters(standardized, filters))
            standardizedRows.push(standardized);
        } catch (error) {
          warnings.push({
            code: "modifier-sale-selection-skipped",
            level: "warning",
            message: `One malformed modifier selection was skipped instead of failing the report: ${reportErrorMessage(error)}`,
          });
        }
      }
    } catch (error) {
      warnings.push({
        code: "modifier-sale-line-skipped",
        level: "warning",
        message: `One malformed Yoco sale line was skipped instead of failing the report: ${reportErrorMessage(error)}`,
      });
    }
  }

  // Include stock-deducting modifier movements that could not be linked to a parsed Yoco modifier sale line.
  for (const orphan of buildOrphanModifierUsageRows(
    canonicalModifierUsageRows,
    standardizedRows,
    warnings,
    timeZone,
    reportingContext.tradingDayStartMinutes,
  )) {
    if (modifierSalesRowMatchesFilters(orphan, filters))
      standardizedRows.push(orphan);
  }

  addModifierSalesWarnings(standardizedRows, warnings);
  const integrity = appendIntegrityWarnings(standardizedRows, warnings);
  const pagedRows = standardizedRows.slice(offset, offset + requestedLimit);

  return json(request, env, {
    rows: pagedRows,
    warnings: uniqueWarnings(warnings),
    meta: buildMeta(
      workspaceId,
      filters,
      standardizedRows.length,
      requestedLimit,
      offset,
      generatedAt,
      {
        sourceTables: tableStatus,
        sourceCoverage: {
          yocoModifierSelections: standardizedRows.filter((row) =>
            clean(row.yocoModifierId),
          ).length,
          modifierUsageRows: canonicalModifierUsageRows.length,
          orphanModifierUsageRows: standardizedRows.filter(
            (row) => row.orphanUsage === true,
          ).length,
        },
        integrity,
        timeZone,
        filterOptions: await getReportFilterOptions(env, workspaceId),
        dataSource: "real",
        sourceDeduplicated: true,
        modifierReportVersion: "phase91-bounded-snapshot-enrichment",
      },
    ),
  });
}

export async function getMenuRecipeHealthReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
    tradingDayLabel: reportingContext.tradingDayLabel,
  };
  const requestedLimit = limitFromUrl(url, 500, 5000);
  const offset = offsetFromUrl(url);
  const generatedAt = new Date().toISOString();
  const warnings: Array<{ code: string; level: string; message: string }> = [];

  const requiredTables = [
    "products",
    "product_location_prices",
    "yoco_categories",
    "recipes",
    "recipe_lines",
    "stock_items",
    "stock_balances",
    "stock_item_location_prices",
    "workspace_settings",
    "yoco_modifier_groups",
    "yoco_orders",
    "yoco_order_lines",
    "stock_movements",
    "locations",
  ];
  const tableStatus: Record<string, boolean> = {};
  for (const table of requiredTables)
    tableStatus[table] = await tableExists(env, table);

  if (!tableStatus.products) {
    return json(request, env, {
      rows: [],
      recipeRows: [],
      pricingRows: [],
      warningRows: [],
      warnings: [
        {
          code: "menu-recipe-health-missing-products",
          level: "warning",
          message:
            "Menu & Recipe Health cannot load because products are missing.",
        },
      ],
      meta: buildMeta(
        workspaceId,
        filters,
        0,
        requestedLimit,
        offset,
        generatedAt,
        { sourceTables: tableStatus, dataSource: "real" },
      ),
    });
  }

  const vatRateRow = tableStatus.workspace_settings
    ? await (async () => {
        // See getSalesFinancialReport for why table existence alone isn't enough to safely
        // reference vat_registered — it can still be mid-migration on this workspace.
        const hasVatRegisteredColumn = await tableHasColumns(env, "workspace_settings", ["vat_registered"]);
        return env.DB.prepare(
          hasVatRegisteredColumn
            ? `SELECT CASE WHEN COALESCE(vat_registered, 1) = 0 THEN 0 ELSE COALESCE(NULLIF(vat_rate, 0), 15) END AS vat_rate
                 FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`
            : `SELECT COALESCE(NULLIF(vat_rate, 0), 15) AS vat_rate
                 FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
        )
          .bind(workspaceId)
          .first<Row>();
      })()
    : null;
  const vatRate = numberValue(vatRateRow?.vat_rate, 15);

  const locations = tableStatus.locations
    ? await safeAllRows(
        env.DB.prepare(
          `SELECT id, COALESCE(display_name, name, external_name, id) AS name FROM locations WHERE workspace_id = ?1 AND COALESCE(active, 1) = 1 ORDER BY is_default DESC, name ASC`,
        ).bind(workspaceId),
      )
    : [];

  const products = await loadMenuHealthProducts(
    env,
    workspaceId,
    filters,
    tableStatus,
  );
  const recipes = tableStatus.recipes
    ? await safeAllRows(
        env.DB.prepare(
          `SELECT id, workspace_id, owner_type, owner_id, yield_qty, yield_unit, linked_product_id, active, created_at, updated_at
       FROM recipes
      WHERE workspace_id = ?1 AND COALESCE(active, 1) = 1`,
        ).bind(workspaceId),
      )
    : [];

  const recipeLineRows = tableStatus.recipe_lines
    ? await loadMenuHealthRecipeLines(env, workspaceId, tableStatus)
    : [];
  const priceRows = tableStatus.product_location_prices
    ? await safeAllRows(
        env.DB.prepare(
          `SELECT plp.product_id, plp.location_id, plp.price, plp.updated_at,
            COALESCE(l.display_name, l.name, l.external_name, l.id) AS location_name
       FROM product_location_prices plp
       LEFT JOIN locations l ON l.id = plp.location_id AND l.workspace_id = plp.workspace_id
      WHERE plp.workspace_id = ?1
      ORDER BY product_id, location_name`,
        ).bind(workspaceId),
      )
    : [];

  const modifierGroups = tableStatus.yoco_modifier_groups
    ? await safeAllRows(
        env.DB.prepare(
          `SELECT id, yoco_modifier_group_id, name, product_modifier_count, raw_json
       FROM yoco_modifier_groups
      WHERE workspace_id = ?1`,
        ).bind(workspaceId),
      )
    : [];

  const modifierUsageCounts = tableStatus.stock_movements
    ? await safeAllRows(
        env.DB.prepare(
          `SELECT COALESCE(json_extract(metadata_json, '$.parentProductId'), json_extract(metadata_json, '$.productId')) AS product_id,
            COUNT(*) AS usage_rows
       FROM stock_movements
      WHERE workspace_id = ?1
        AND document_type = 'yoco_order'
        AND movement_type IN ('sale_depletion', 'sale_refund')
        AND json_extract(metadata_json, '$.componentType') = 'modifier'
      GROUP BY product_id`,
        ).bind(workspaceId),
      )
    : [];

  const salesStats = tableStatus.yoco_order_lines
    ? await safeAllRows(
        env.DB.prepare(
          `SELECT product_id, SUM(quantity) AS qty_sold, SUM(total) AS gross_sales, COUNT(DISTINCT yoco_order_id) AS sale_count
       FROM yoco_order_lines
      WHERE workspace_id = ?1
      GROUP BY product_id`,
        ).bind(workspaceId),
      )
    : [];

  // Per-location ingredient cost overrides, so the per-location pricing breakdown (which already
  // resolves selling price per location via product_location_prices) can resolve recipe cost the
  // same way instead of mixing a location-scoped selling price against a workspace-global cost.
  const locationCostRows = tableStatus.stock_item_location_prices
    ? await safeAllRows(
        env.DB.prepare(
          `SELECT stock_item_id, location_id, price
       FROM stock_item_location_prices
      WHERE workspace_id = ?1`,
        ).bind(workspaceId),
      )
    : [];

  const context = buildMenuHealthContext({
    workspaceId,
    vatRate,
    locations,
    recipes,
    recipeLines: recipeLineRows,
    priceRows,
    locationCostRows,
    modifierGroups,
    modifierUsageCounts,
    salesStats,
  });
  const built = buildMenuRecipeHealthRows(products, context, warnings);
  const filtered = filterMenuRecipeHealthPayload(built, filters);
  const pagedRows = filtered.rows.slice(offset, offset + requestedLimit);

  return json(request, env, {
    rows: pagedRows,
    recipeRows: filtered.recipeRows,
    pricingRows: filtered.pricingRows,
    warningRows: filtered.warningRows,
    warnings: uniqueWarnings(warnings),
    meta: buildMeta(
      workspaceId,
      filters,
      filtered.rows.length,
      requestedLimit,
      offset,
      generatedAt,
      {
        sourceTables: tableStatus,
        filterOptions: await getMenuRecipeHealthFilterOptions(
          env,
          workspaceId,
          filtered,
          tableStatus,
        ),
        dataSource: "real",
      },
    ),
  });
}

export async function getStockControlReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
    tradingDayLabel: reportingContext.tradingDayLabel,
  };
  const requestedLimit = limitFromUrl(url, 500, 5000);
  const offset = offsetFromUrl(url);
  const generatedAt = new Date().toISOString();
  const warnings: Array<{ code: string; level: string; message: string }> = [];

  const requiredTables = [
    "stock_items",
    "stock_balances",
    "locations",
    "suppliers",
    "grvs",
    "grv_lines",
    "stock_item_location_prices",
    "stock_item_latest_purchase",
  ];
  const tableStatus: Record<string, boolean> = {};
  for (const table of requiredTables)
    tableStatus[table] = await tableExists(env, table);

  if (!tableStatus.stock_items || !tableStatus.locations) {
    return json(request, env, {
      rows: [],
      warningRows: [],
      warnings: [
        {
          code: "stock-control-missing-source-tables",
          level: "warning",
          message:
            "Stock Control cannot load because stock_items or locations are missing.",
        },
      ],
      meta: buildMeta(
        workspaceId,
        filters,
        0,
        requestedLimit,
        offset,
        generatedAt,
        { sourceTables: tableStatus, dataSource: "real" },
      ),
    });
  }

  const { whereSql, binds } = buildStockControlWhere(
    workspaceId,
    filters,
    tableStatus,
  );
  // Reads the maintained stock_item_latest_purchase summary (one row per stock_item+location,
  // kept current at write time — see migration 41's comment in tenant-migrations.ts) instead of
  // recomputing "most recent purchase" from full GRV history on every report load. Falls back to
  // the old full-history window-function scan only for a tenant that hasn't been repaired/
  // backfilled yet (see workspace-do.ts) — this keeps the report correct throughout that rollout
  // window rather than showing blank purchase data, at the old (known, bounded-in-time) cost.
  const latestPurchaseCte =
    tableStatus.stock_item_latest_purchase
      ? `latest_purchase AS (
        SELECT
            lp.workspace_id,
            lp.stock_item_id,
            lp.location_id,
            lp.supplier_id,
            ${tableStatus.suppliers ? "s.name" : "''"} AS supplier_name,
            lp.unit AS last_purchase_uom,
            lp.unit_price AS last_purchase_cost,
            lp.received_at AS last_purchased_date
          FROM stock_item_latest_purchase lp
          ${tableStatus.suppliers ? "LEFT JOIN suppliers s ON s.id = lp.supplier_id AND s.workspace_id = lp.workspace_id" : ""}
         WHERE lp.workspace_id = ?1
      )`
      : tableStatus.grv_lines && tableStatus.grvs
      ? `latest_purchase AS (
        SELECT * FROM (
          SELECT
              gl.workspace_id,
              gl.stock_item_id,
              gl.location_id,
              g.supplier_id,
              ${tableStatus.suppliers ? "s.name" : "''"} AS supplier_name,
              gl.unit AS last_purchase_uom,
              gl.unit_price AS last_purchase_cost,
              g.received_at AS last_purchased_date,
              ROW_NUMBER() OVER (PARTITION BY gl.workspace_id, gl.stock_item_id, gl.location_id ORDER BY datetime(g.received_at) DESC, gl.id DESC) AS rn
            FROM grv_lines gl
            JOIN grvs g ON g.id = gl.grv_id AND g.workspace_id = gl.workspace_id
            ${tableStatus.suppliers ? "LEFT JOIN suppliers s ON s.id = g.supplier_id AND s.workspace_id = g.workspace_id" : ""}
           WHERE gl.workspace_id = ?1
        ) WHERE rn = 1
      )`
      : `latest_purchase AS (
        SELECT '' AS workspace_id, '' AS stock_item_id, '' AS location_id, '' AS supplier_id, '' AS supplier_name, '' AS last_purchase_uom, 0 AS last_purchase_cost, '' AS last_purchased_date, 1 AS rn WHERE 0
      )`;
  const stockBalanceCte = tableStatus.stock_balances
    ? `latest_balance AS (
        SELECT workspace_id, stock_item_id, location_id, quantity, updated_at, rn
          FROM (
            SELECT
              sb.workspace_id,
              sb.stock_item_id,
              sb.location_id,
              sb.quantity,
              sb.updated_at,
              ROW_NUMBER() OVER (
                PARTITION BY sb.workspace_id, sb.stock_item_id, sb.location_id
                ORDER BY datetime(sb.updated_at) DESC, sb.rowid DESC
              ) AS rn
            FROM stock_balances sb
           WHERE sb.workspace_id = ?1
          )
         WHERE rn = 1
      )`
    : `latest_balance AS (
        SELECT '' AS workspace_id, '' AS stock_item_id, '' AS location_id, 0 AS quantity, '' AS updated_at, 1 AS rn WHERE 0
      )`;
  const locationCostCte = tableStatus.stock_item_location_prices
    ? `latest_location_cost AS (
        SELECT workspace_id, stock_item_id, location_id, price, updated_at, rn
          FROM (
            SELECT
              silp.workspace_id,
              silp.stock_item_id,
              silp.location_id,
              silp.price,
              silp.updated_at,
              ROW_NUMBER() OVER (
                PARTITION BY silp.workspace_id, silp.stock_item_id, silp.location_id
                ORDER BY datetime(silp.updated_at) DESC, silp.rowid DESC
              ) AS rn
            FROM stock_item_location_prices silp
           WHERE silp.workspace_id = ?1
          )
         WHERE rn = 1
      )`
    : `latest_location_cost AS (
        SELECT '' AS workspace_id, '' AS stock_item_id, '' AS location_id, 0 AS price, '' AS updated_at, 1 AS rn WHERE 0
      )`;
  const locationCostSelect =
    "CASE WHEN silp.stock_item_id IS NOT NULL THEN COALESCE(silp.price, 0) ELSE COALESCE(si.unit_cost, 0) END";

  const rows = await env.DB.prepare(
    `WITH ${latestPurchaseCte}, ${stockBalanceCte}, ${locationCostCte}
     SELECT
        si.id AS stock_item_id,
        si.workspace_id,
        si.name AS item_name,
        si.category,
        si.item_type,
        si.unit AS base_uom,
        si.unit_cost,
        si.threshold_qty,
        si.par_level_qty,
        si.raw_json AS stock_raw_json,
        si.active,
        COALESCE(si.is_stocked, 1) AS is_stocked,
        l.id AS location_id,
        COALESCE(l.display_name, l.name, l.external_name, l.id) AS location_name,
        sb.quantity AS current_stock,
        sb.updated_at AS balance_updated_at,
        CASE WHEN sb.stock_item_id IS NULL THEN 0 ELSE 1 END AS has_location_balance,
        ${locationCostSelect} AS resolved_unit_cost,
        lp.supplier_id,
        lp.supplier_name,
        lp.last_purchase_uom,
        lp.last_purchase_cost,
        lp.last_purchased_date,
        lsa.acknowledged AS low_stock_acknowledged,
        lsa.acknowledged_at AS low_stock_acknowledged_at
       FROM stock_items si
       JOIN locations l ON l.workspace_id = si.workspace_id AND COALESCE(l.active, 1) = 1
       LEFT JOIN latest_balance sb ON sb.workspace_id = si.workspace_id AND sb.stock_item_id = si.id AND sb.location_id = l.id
       LEFT JOIN latest_location_cost silp ON silp.workspace_id = si.workspace_id AND silp.stock_item_id = si.id AND silp.location_id = l.id
       LEFT JOIN latest_purchase lp ON lp.workspace_id = si.workspace_id AND lp.stock_item_id = si.id AND lp.location_id = l.id
       LEFT JOIN low_stock_alert_state lsa ON lsa.workspace_id = si.workspace_id AND lsa.stock_item_id = si.id AND lsa.location_id = l.id
      WHERE ${whereSql}
      ORDER BY l.name, si.category, si.name
      LIMIT ${MAX_REPORT_ROWS + 1}`,
  )
    .bind(...binds)
    .all<Row>();

  const sourceRows = dedupeRowsByKey(
    rows.results || [],
    (row) => `${clean(row.stock_item_id)}:${clean(row.location_id)}`,
  );
  const sourceTruncated = sourceRows.length > MAX_REPORT_ROWS;
  const completeSourceRows = sourceTruncated
    ? sourceRows.slice(0, MAX_REPORT_ROWS)
    : sourceRows;
  const warningRows: Row[] = [];
  const standardizedRows = completeSourceRows
    .map((row) => standardizeStockControlRow(row, warningRows, warnings))
    .filter(Boolean) as Row[];
  const filteredRows = standardizedRows.filter((row) =>
    stockControlRowMatchesFilters(row, filters),
  );
  const filteredWarnings = warningRows.filter((row) =>
    stockControlWarningMatchesFilters(row, filters),
  );
  const pagedRows = filteredRows.slice(offset, offset + requestedLimit);

  return json(request, env, {
    rows: pagedRows,
    warningRows: filteredWarnings,
    warnings: uniqueWarnings(warnings),
    meta: buildMeta(
      workspaceId,
      filters,
      filteredRows.length,
      requestedLimit,
      offset,
      generatedAt,
      {
        sourceTables: tableStatus,
        filterOptions: await getStockControlFilterOptions(
          env,
          workspaceId,
          filteredRows,
        ),
        sourceRowCap: MAX_REPORT_ROWS,
        sourceRowsFetched: sourceRows.length,
        sourceRowsEvaluated: completeSourceRows.length,
        truncated: sourceTruncated,
        dataSource: "real",
      },
    ),
  });
}

function buildStockControlWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  tableStatus: Record<string, boolean>,
) {
  const clauses = ["si.workspace_id = ?1", "COALESCE(si.active, 1) = 1"];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  addLocationSqlScope(clauses, binds, "l.id", filters);
  if (filters.category)
    add("lower(COALESCE(si.category, '')) = lower(?)", filters.category);
  if (filters.categoryId)
    add("lower(COALESCE(si.category, '')) = lower(?)", filters.categoryId);
  if (filters.itemId) add("si.id = ?", filters.itemId);
  if (filters.itemType)
    add("lower(COALESCE(si.item_type, '')) = lower(?)", filters.itemType);
  if (filters.search) {
    binds.push(`%${filters.search.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(`(
      lower(COALESCE(si.name, '')) LIKE ?${idx}
      OR lower(COALESCE(si.category, '')) LIKE ?${idx}
      OR lower(COALESCE(si.item_type, '')) LIKE ?${idx}
      OR lower(COALESCE(l.name, '')) LIKE ?${idx}
      OR lower(COALESCE(l.display_name, '')) LIKE ?${idx}
      OR lower(COALESCE(si.raw_json, '')) LIKE ?${idx}
    )`);
  }
  return { whereSql: clauses.join(" AND "), binds };
}

function standardizeStockControlRow(
  row: Row,
  warningRows: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  const raw = parseJson(row.stock_raw_json);
  const item = {
    id: clean(row.stock_item_id),
    item_type: row.item_type,
    is_stocked: row.is_stocked,
    raw_json: row.stock_raw_json,
  };
  if (isRecipeOnlyStockItem(item)) {
    if (
      numberValue(row.current_stock, 0) !== 0 ||
      numberValue(row.has_location_balance, 0) === 1
    ) {
      const warning = stockControlWarning(
        "Critical",
        row,
        "Recipe-only sub-recipe appearing in stock-on-hand",
        "Recipe-only sub-recipe has a stock balance but should not be reordered as stock-on-hand.",
        "Reorder suggestions may include virtual recipe items.",
        "Mark the sub-recipe as stock-holding prep only if it is physically counted, otherwise remove the balance.",
        clean(row.stock_item_id),
      );
      warningRows.push(warning);
      warnings.push({
        code: "stock-control-recipe-only-soh",
        level: "critical",
        message: warning.issue,
      });
    }
    return null;
  }
  if (numberValue(row.is_stocked, 1) === 0 && !allowsStockOnHand(raw)) {
    const warning = stockControlWarning(
      "Critical",
      row,
      "Non-stock item appearing in reorder report",
      "Non-stock item is not configured to hold stock and was excluded from reorder logic.",
      "Reorder values would be inaccurate.",
      "Enable stock tracking only if this item should hold stock.",
      clean(row.stock_item_id),
    );
    warningRows.push(warning);
    warnings.push({
      code: "stock-control-non-stock-excluded",
      level: "critical",
      message: warning.issue,
    });
    return null;
  }

  const hasLocationBalance = numberValue(row.has_location_balance, 0) === 1;
  const currentStock = hasLocationBalance
    ? numberValue(row.current_stock, 0)
    : 0;
  const lowStockThreshold = numberValue(row.threshold_qty, 0);
  const parLevel = numberValue(row.par_level_qty, 0);
  const unitCostExVat =
    numberValue(row.resolved_unit_cost, 0) || numberValue(row.unit_cost, 0);
  const requiredBase = parLevel > 0 ? parLevel : lowStockThreshold;
  const requiredQty = Math.max(requiredBase - currentStock, 0);
  const purchase = resolvePurchaseUomDetails(
    raw,
    clean(row.last_purchase_uom),
    clean(row.base_uom),
  );
  const estimatedReorderValue = roundMoneyNumber(requiredQty * unitCostExVat);
  const status = resolveStockControlStatus(
    currentStock,
    lowStockThreshold,
    parLevel,
    hasLocationBalance,
  );
  const suggestedAction = resolveStockControlAction({
    status,
    itemType: row.item_type,
    unitCostExVat,
    purchaseUom: purchase.purchaseUom,
    purchaseUomRatio: purchase.purchaseUomRatio,
    parLevel,
  });
  const out = {
    id: `stock-control:${clean(row.stock_item_id)}:${clean(row.location_id)}`,
    workspaceId: clean(row.workspace_id),
    itemId: clean(row.stock_item_id),
    stockItemId: clean(row.stock_item_id),
    itemName: clean(row.item_name),
    category: clean(row.category || "General"),
    itemType: clean(row.item_type || "raw"),
    isStocked: numberValue(row.is_stocked, 1),
    locationId: clean(row.location_id),
    locationName: clean(row.location_name),
    currentStock,
    hasLocationBalance,
    baseUom: clean(row.base_uom || "ea"),
    lowStockThreshold,
    parLevel,
    requiredQty,
    unitCostExVat,
    estimatedReorderValue,
    supplierId: clean(row.supplier_id),
    supplierName: clean(row.supplier_name),
    lastPurchaseCost: numberValue(row.last_purchase_cost, 0),
    lastPurchasedDate: clean(row.last_purchased_date).slice(0, 10),
    purchaseUom: purchase.purchaseUom,
    purchaseUomRatio: purchase.purchaseUomRatio,
    purchaseUomQty: purchase.purchaseUomRatio
      ? requiredQty / purchase.purchaseUomRatio
      : 0,
    status,
    stockStatus: status,
    suggestedAction,
    lowStockAcknowledged: numberValue(row.low_stock_acknowledged, 0) === 1,
    lowStockAcknowledgedAt: clean(row.low_stock_acknowledged_at),
    lastUpdated: clean(row.balance_updated_at),
    sourceId: clean(row.stock_item_id),
    raw: { stockItem: row, purchase },
  };
  addStockControlRowWarnings(out, warningRows, warnings);
  return out;
}

function resolveStockControlStatus(
  currentStock: number,
  lowStockThreshold: number,
  parLevel: number,
  hasLocationBalance: boolean,
) {
  if (!hasLocationBalance) return "Critical";
  if (currentStock <= 0) return "Critical";
  if (lowStockThreshold > 0 && currentStock <= lowStockThreshold) return "Low";
  if (parLevel > 0 && currentStock < parLevel) return "Below Par";
  return "Healthy";
}

function resolveStockControlAction({
  status,
  itemType,
  unitCostExVat,
  purchaseUom,
  purchaseUomRatio,
  parLevel,
}: Row) {
  if (isManufacturedStockControlItemType(itemType)) return "Manufacture internally";
  if (!unitCostExVat) return "Missing cost";
  if (!clean(purchaseUom)) return "Missing purchase UOM";
  if (!purchaseUomRatio) return "Missing purchase UOM";
  if (!parLevel) return "Review par level";
  if (status === "Critical") return "Reorder urgently";
  if (status === "Low" || status === "Below Par") return "Reorder soon";
  return "Review par level";
}

function isManufacturedStockControlItemType(value: unknown) {
  const itemType = clean(value).toLowerCase().replace(/[\s-]+/g, "_");
  return ["manufactured", "manufactured_good", "manufactured_goods", "sub_recipe", "subrecipe"].includes(itemType);
}

function addStockControlRowWarnings(
  row: Row,
  warningRows: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  const add = (
    severity: string,
    issueType: string,
    issue: string,
    impact: string,
    suggestedFix: string,
  ) => {
    const warning = stockControlWarning(
      severity,
      row,
      issueType,
      issue,
      impact,
      suggestedFix,
      clean(row.sourceId || row.itemId),
    );
    warningRows.push(warning);
    warnings.push({
      code: `stock-control-${slug(issueType)}`,
      level: severity.toLowerCase(),
      message: warning.issue,
    });
  };
  if (!clean(row.locationId))
    add(
      "Critical",
      "Location is missing",
      "Stock row has no location.",
      "Low stock must be calculated per location.",
      "Map the stock balance to a valid location.",
    );
  if (!clean(row.itemName))
    add(
      "Critical",
      "Item name is missing",
      "Stock item has no item name.",
      "Reorder lines cannot be identified.",
      "Update the stock item name.",
    );
  if (!clean(row.baseUom))
    add(
      "Critical",
      "Base UOM is missing",
      "Stock item has no base UOM.",
      "Required quantity cannot be interpreted.",
      "Set the stock item base UOM.",
    );
  if (row.hasLocationBalance === false)
    add(
      "Critical",
      "Missing location stock balance",
      "Item has no location stock balance.",
      "Current stock cannot be calculated for this location.",
      "Create or post a stock balance for this item and location.",
    );
  if (!numberValue(row.unitCostExVat, 0))
    add(
      "Critical",
      "Missing unit cost",
      "Item has no unit cost ex VAT.",
      "Estimated reorder value cannot be calculated.",
      "Load a current unit cost or receive the item through GRV.",
    );
  if (!numberValue(row.lowStockThreshold, 0))
    add(
      "Warning",
      "Missing low stock threshold",
      "Item has no low stock threshold.",
      "Low stock alerts may not trigger early enough.",
      "Set a low stock threshold for this item.",
    );
  if (!numberValue(row.parLevel, 0))
    add(
      "Critical",
      "Missing par level",
      "Item has no par level.",
      "Required reorder quantity may fall back to the low stock threshold.",
      "Set a par level for this item and location.",
    );
  if (!isManufacturedStockControlItemType(row.itemType) && !clean(row.purchaseUom))
    add(
      "Critical",
      "Missing purchase UOM",
      "No purchase UOM is available.",
      "Supplier order quantity cannot be converted for purchasing.",
      "Add a purchase UOM to the item setup.",
    );
  if (!isManufacturedStockControlItemType(row.itemType) && clean(row.purchaseUom) && !numberValue(row.purchaseUomRatio, 0))
    add(
      "Critical",
      "Missing purchase UOM conversion",
      "Purchase UOM has no conversion ratio.",
      "Purchase quantity may be wrong.",
      "Add a conversion ratio from purchase UOM to base UOM.",
    );
}

function stockControlWarning(
  severity: string,
  row: Row,
  issueType: string,
  issue: string,
  impact: string,
  suggestedFix: string,
  sourceId = "",
) {
  return {
    id: `stock-control-warning:${slug(issueType)}:${clean(sourceId) || slug(clean(row.itemName))}:${clean(row.locationId)}`,
    severity,
    itemId: clean(row.itemId || row.stock_item_id),
    itemName: clean(row.itemName || row.item_name),
    category: clean(row.category || "General"),
    locationId: clean(row.locationId || row.location_id),
    locationName: clean(row.locationName || row.location_name),
    issueType,
    issue,
    impact,
    suggestedFix,
    sourceId: clean(sourceId || row.sourceId || row.stock_item_id),
  };
}

function stockControlRowMatchesFilters(
  row: Row,
  filters: ReturnType<typeof readFilters>,
) {
  if (
    filters.status &&
    clean(row.status).toLowerCase() !== filters.status.toLowerCase()
  )
    return false;
  if (truthyFilter(filters.onlyCritical) && row.status !== "Critical")
    return false;
  if (
    truthyFilter(filters.onlyBelowPar) &&
    !["Critical", "Low", "Below Par"].includes(clean(row.status))
  )
    return false;
  if (
    truthyFilter(filters.missingCost) &&
    numberValue(row.unitCostExVat, 0) > 0
  )
    return false;
  return true;
}

function stockControlWarningMatchesFilters(
  row: Row,
  filters: ReturnType<typeof readFilters>,
) {
  if (
    filters.warningSeverity &&
    clean(row.severity).toLowerCase() !== filters.warningSeverity.toLowerCase()
  )
    return false;
  if (!rowMatchesLocationScope(row.locationId, filters)) return false;
  if (
    filters.category &&
    clean(row.category).toLowerCase() !== filters.category.toLowerCase()
  )
    return false;
  if (filters.search) {
    const haystack = clean(
      [
        row.itemName,
        row.category,
        row.locationName,
        row.issueType,
        row.issue,
        row.suggestedFix,
      ].join(" "),
    ).toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

function truthyFilter(value: string) {
  return ["1", "true", "yes", "y"].includes(clean(value).toLowerCase());
}

function resolvePurchaseUomDetails(
  raw: Row,
  lastPurchaseUom = "",
  baseUom = "",
) {
  const configuredUoms = Array.isArray(raw.uomConfigurations)
    ? raw.uomConfigurations
    : Array.isArray(raw.uomConfig)
      ? raw.uomConfig
      : Array.isArray(raw.uomConversions)
        ? raw.uomConversions
        : Array.isArray(raw.uoms)
          ? raw.uoms
          : Array.isArray(raw.customUoms)
            ? raw.customUoms
            : [];
  const defaultConfiguration = configuredUoms.find((item: Row) => {
    const value = item?.isDefaultOrdering ?? item?.defaultOrdering ?? item?.is_default_ordering ?? item?.defaultOrderUom;
    return value === true || ["true", "1", "yes", "on"].includes(clean(value).toLowerCase());
  });
  const defaultConfiguredUom = clean(
    defaultConfiguration?.customUom ||
      defaultConfiguration?.custom_uom ||
      defaultConfiguration?.customUnit ||
      defaultConfiguration?.name ||
      defaultConfiguration?.uom ||
      defaultConfiguration?.unit,
  );
  const purchaseUom = clean(
    raw.purchaseUom ||
      raw.purchase_uom ||
      raw.purchaseUnit ||
      raw.purchase_unit ||
      raw.defaultPurchaseUom ||
      raw.default_purchase_uom ||
      defaultConfiguredUom ||
      lastPurchaseUom ||
      baseUom,
  );
  let purchaseUomRatio = numberValue(
    raw.purchaseUomRatio ??
      raw.purchase_uom_ratio ??
      raw.purchaseUnitRatio ??
      raw.purchase_unit_ratio,
    0,
  );
  if (
    !purchaseUomRatio &&
    purchaseUom &&
    baseUom &&
    purchaseUom.toLowerCase() === baseUom.toLowerCase()
  )
    purchaseUomRatio = 1;
  if (!purchaseUomRatio) {
    const uoms = configuredUoms;
    const match = uoms.find(
      (item: Row) =>
        clean(item.name || item.uom || item.unit).toLowerCase() ===
        purchaseUom.toLowerCase(),
    );
    purchaseUomRatio = numberValue(
      match?.qtyInBase ?? match?.qty_in_base ?? match?.ratio ?? match?.baseQty,
      0,
    );
  }
  if (!purchaseUomRatio) {
    for (const key of ["UOM_1", "UOM_2", "UOM_3", "uom1", "uom2", "uom3"]) {
      const name = clean(
        raw[`${key}_Name`] ||
          raw[`${key}_name`] ||
          raw[`${key}Name`] ||
          raw[`${key}name`],
      );
      if (name && name.toLowerCase() === purchaseUom.toLowerCase()) {
        purchaseUomRatio = numberValue(
          raw[`${key}_Qty_In_Base`] ??
            raw[`${key}_qty_in_base`] ??
            raw[`${key}QtyInBase`] ??
            raw[`${key}Ratio`],
          0,
        );
        break;
      }
    }
  }
  return { purchaseUom, purchaseUomRatio };
}

function isRecipeOnlyStockItem(stockItem: Row) {
  return isSubRecipeStockItem(stockItem) && !isStockHoldingPrepItem(stockItem);
}

function allowsStockOnHand(raw: Row) {
  return ["true", "1", "yes"].includes(
    clean(
      raw.allowStockOnHand ||
        raw.allow_stock_on_hand ||
        raw.trackInventory ||
        raw.track_inventory,
    ).toLowerCase(),
  );
}

async function getStockControlFilterOptions(
  env: Env,
  workspaceId: string,
  rows: Row[],
) {
  const base = await getReportFilterOptions(env, workspaceId);
  const suppliers = await safeAllRows(
    env.DB.prepare(
      `SELECT id, name FROM suppliers WHERE workspace_id = ?1 AND COALESCE(active, 1) = 1 ORDER BY name ASC`,
    ).bind(workspaceId),
  );
  return {
    ...base,
    suppliers: suppliers
      .map((row) => ({ id: clean(row.id), name: clean(row.name) }))
      .filter((row) => row.id || row.name),
    statuses: uniqueTextValues(rows.map((row) => clean(row.status))).map(
      (name) => ({ name }),
    ),
    itemTypes: uniqueTextValues(rows.map((row) => clean(row.itemType))).map(
      (name) => ({ name }),
    ),
  };
}

function uniqueTextValues(values: string[]) {
  return Array.from(
    new Set(values.map((value) => clean(value)).filter(Boolean)),
  ).sort();
}

async function loadMenuHealthProducts(
  env: Env,
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  tableStatus: Record<string, boolean>,
) {
  const yocoCategorySelect = tableStatus.yoco_categories
    ? "yc.name AS yoco_category_name_resolved,"
    : "'' AS yoco_category_name_resolved,";
  const yocoCategoryJoin = tableStatus.yoco_categories
    ? "LEFT JOIN yoco_categories yc ON yc.yoco_category_id = p.yoco_category_id AND yc.workspace_id = p.workspace_id"
    : "";
  const clauses = ["p.workspace_id = ?1", "COALESCE(p.active, 1) = 1"];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  if (filters.menuItemId) add("p.id = ?", filters.menuItemId);
  if (filters.menuCategory)
    add("lower(COALESCE(p.category, '')) = lower(?)", filters.menuCategory);
  if (filters.yocoCategory)
    add(
      "(lower(COALESCE(p.yoco_category_id, '')) = lower(?) OR lower(COALESCE(p.yoco_category_name, '')) = lower(?))",
      filters.yocoCategory,
    );
  if (filters.search) {
    binds.push(`%${filters.search.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(
      `(lower(COALESCE(p.name, '')) LIKE ?${idx} OR lower(COALESCE(p.category, '')) LIKE ?${idx} OR lower(COALESCE(p.yoco_item_id, '')) LIKE ?${idx} OR lower(COALESCE(p.yoco_variant_id, '')) LIKE ?${idx} OR lower(COALESCE(p.raw_json, '')) LIKE ?${idx})`,
    );
  }
  const salesSelect = tableStatus.yoco_order_lines
    ? "COALESCE(sales.qty_sold, 0) AS qty_sold, COALESCE(sales.gross_sales, 0) AS gross_sales, COALESCE(sales.sale_count, 0) AS sale_count"
    : "0 AS qty_sold, 0 AS gross_sales, 0 AS sale_count";
  const salesJoin = tableStatus.yoco_order_lines
    ? `LEFT JOIN (
          SELECT product_id, SUM(quantity) AS qty_sold, SUM(total) AS gross_sales, COUNT(DISTINCT yoco_order_id) AS sale_count
            FROM yoco_order_lines
           WHERE workspace_id = ?1
           GROUP BY product_id
       ) sales ON sales.product_id = p.id`
    : "";
  const rows = await env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.name, p.category, p.price, p.active, p.external_provider,
            p.yoco_item_id, p.yoco_variant_id, p.yoco_category_id, p.yoco_category_name,
            p.missing_recipe, p.recipe_source_stock_item_id, p.raw_json,
            ${yocoCategorySelect}
            ${salesSelect}
       FROM products p
       ${yocoCategoryJoin}
       ${salesJoin}
      WHERE ${clauses.join(" AND ")}
      ORDER BY p.category, p.name
      LIMIT ${MAX_REPORT_ROWS}`,
  )
    .bind(...binds)
    .all<Row>();
  return rows.results || [];
}

async function loadMenuHealthRecipeLines(
  env: Env,
  workspaceId: string,
  tableStatus: Record<string, boolean>,
) {
  if (!tableStatus.stock_items) return [];
  const stockBalanceJoin = tableStatus.stock_balances
    ? `LEFT JOIN (
          SELECT workspace_id, stock_item_id, SUM(quantity) AS total_qty
            FROM stock_balances
           WHERE workspace_id = ?1
           GROUP BY workspace_id, stock_item_id
       ) sb ON sb.workspace_id = rl.workspace_id AND sb.stock_item_id = rl.stock_item_id`
    : "";
  const stockQtySelect = tableStatus.stock_balances
    ? "COALESCE(sb.total_qty, 0) AS in_stock_qty,"
    : "0 AS in_stock_qty,";
  const rows = await env.DB.prepare(
    `SELECT rl.id, rl.workspace_id, rl.recipe_id, rl.stock_item_id, rl.quantity, rl.unit, rl.sort_order,
            si.name AS stock_item_name, si.category AS stock_category, si.item_type, si.unit AS base_uom,
            si.unit_cost, si.threshold_qty, si.raw_json AS stock_raw_json,
            COALESCE(si.is_stocked, 1) AS is_stocked,
            ${stockQtySelect}
            si.active AS stock_active
       FROM recipe_lines rl
       LEFT JOIN stock_items si ON si.id = rl.stock_item_id AND si.workspace_id = rl.workspace_id
       ${stockBalanceJoin}
      WHERE rl.workspace_id = ?1
      ORDER BY rl.recipe_id, rl.sort_order, rl.id`,
  )
    .bind(workspaceId)
    .all<Row>();
  return rows.results || [];
}

function buildMenuHealthContext({
  workspaceId,
  vatRate,
  locations,
  recipes,
  recipeLines,
  priceRows,
  locationCostRows,
  modifierGroups,
  modifierUsageCounts,
  salesStats,
}: Row) {
  const recipesById = new Map<string, Row>();
  const recipesByOwner = new Map<string, Row>();
  const linesByRecipe = new Map<string, Row[]>();
  const priceRowsByProduct = new Map<string, Row[]>();
  const locationCostsByStockItem = new Map<string, Map<string, number>>();
  const modifierUsageByProduct = new Map<string, number>();
  const salesByProduct = new Map<string, Row>();
  for (const recipe of recipes || []) {
    recipesById.set(clean(recipe.id), recipe);
    const ownerType = clean(
      recipe.owner_type || recipe.ownerType,
    ).toLowerCase();
    const ownerId = clean(recipe.owner_id || recipe.ownerId);
    if (ownerType && ownerId)
      recipesByOwner.set(`${ownerType}:${ownerId}`, recipe);
    if (clean(recipe.linked_product_id))
      recipesByOwner.set(`product:${clean(recipe.linked_product_id)}`, recipe);
  }
  for (const line of recipeLines || []) {
    const recipeId = clean(line.recipe_id);
    if (!linesByRecipe.has(recipeId)) linesByRecipe.set(recipeId, []);
    linesByRecipe.get(recipeId)?.push(line);
  }
  for (const price of priceRows || []) {
    const productId = clean(price.product_id);
    if (!priceRowsByProduct.has(productId))
      priceRowsByProduct.set(productId, []);
    priceRowsByProduct.get(productId)?.push(price);
  }
  for (const row of locationCostRows || []) {
    const stockItemId = clean(row.stock_item_id);
    const locationId = clean(row.location_id);
    if (!stockItemId || !locationId) continue;
    if (!locationCostsByStockItem.has(stockItemId))
      locationCostsByStockItem.set(stockItemId, new Map());
    locationCostsByStockItem.get(stockItemId)?.set(locationId, numberValue(row.price, 0));
  }
  for (const usage of modifierUsageCounts || []) {
    modifierUsageByProduct.set(
      clean(usage.product_id),
      numberValue(usage.usage_rows, 0),
    );
  }
  for (const stat of salesStats || [])
    salesByProduct.set(clean(stat.product_id), stat);
  return {
    workspaceId,
    vatRate,
    locations: locations || [],
    recipesById,
    recipesByOwner,
    linesByRecipe,
    priceRowsByProduct,
    locationCostsByStockItem,
    modifierGroups: modifierGroups || [],
    modifierUsageByProduct,
    salesByProduct,
  };
}

function buildMenuRecipeHealthRows(
  products: Row[],
  context: Row,
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  const rows: Row[] = [];
  const recipeRows: Row[] = [];
  const pricingRows: Row[] = [];
  const warningRows: Row[] = [];
  for (const product of products || []) {
    const raw = parseJson(product.raw_json);
    const productId = clean(product.id);
    const recipe = context.recipesByOwner.get(`product:${productId}`);
    const itemWarnings: Row[] = [];
    const priceRows = context.priceRowsByProduct.get(productId) || [];
    const locationPriceStatus = resolveLocationPriceStatus(
      product,
      priceRows,
      context.locations,
    );
    const basePriceInclVat = resolveProductPrice(product, priceRows);
    const vat = calculateVatAmount(basePriceInclVat, context.vatRate);
    const sellingPriceExVat = roundMoneyNumber(basePriceInclVat - vat);
    const exploded = recipe
      ? explodeMenuRecipe(product, recipe, context, warnings, itemWarnings)
      : { rows: [], cost: 0 };
    const recipeCostExVat = roundMoneyNumber(exploded.cost || 0);
    const grossProfit = roundMoneyNumber(sellingPriceExVat - recipeCostExVat);
    const gpPercent = sellingPriceExVat ? grossProfit / sellingPriceExVat : 0;
    const foodCostPercent = sellingPriceExVat
      ? recipeCostExVat / sellingPriceExVat
      : 0;
    // A user-set opt-out (products/raw_json.noRecipeRequired, toggled from the menu item edit
    // form) — e.g. a resold bottled drink, gift card, or service charge that legitimately never
    // has a recipe. Must not surface as "Missing Recipe" anywhere this report reads recipeStatus.
    const noRecipeRequired = raw.noRecipeRequired === true;
    const recipeStatus = !recipe
      ? noRecipeRequired
        ? "No Recipe Required"
        : "Missing Recipe"
      : exploded.rows.length
        ? "Recipe Ready"
        : "Recipe Missing Ingredients";
    const yocoMappingStatus = resolveYocoMappingStatus(product, raw);
    const modifierCostRisk = resolveModifierCostRisk(product, raw, context);
    const stockDeductionStatus =
      recipeStatus === "Recipe Ready"
        ? "Ready"
        : recipeStatus === "No Recipe Required"
          ? "Not Required"
          : "Not Ready";

    if (!clean(product.yoco_item_id))
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Missing YOCO product mapping",
          "YOCO product is not mapped to the local menu item.",
          "Sales and menu health cannot reliably reconcile this item.",
          "Sync or map the YOCO product to this local product.",
          productId,
        ),
      );
    if (hasVariantData(raw) && !clean(product.yoco_variant_id))
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Missing YOCO variant mapping",
          "YOCO variant is not mapped where variants appear to be used.",
          "Location pricing and sales matching can be inaccurate.",
          "Map the YOCO variant to the local product variant.",
          productId,
        ),
      );
    if (!recipe && !noRecipeRequired)
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Missing recipe",
          "Menu item has no recipe.",
          "Sales will not deduct recipe stock and GP cannot be trusted.",
          "Create or link a recipe for this menu item.",
          productId,
        ),
      );
    if (recipe && !exploded.rows.length && !noRecipeRequired)
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Recipe has no ingredients",
          "Recipe has no usable ingredient lines.",
          "Recipe cost cannot be calculated.",
          "Add ingredient stock items to the recipe.",
          clean(recipe.id),
        ),
      );
    if (!basePriceInclVat)
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Selling price missing",
          "Menu item has no selling price.",
          "GP and food cost cannot be calculated.",
          "Sync or set a YOCO selling price.",
          productId,
        ),
      );
    if (basePriceInclVat > 0 && recipeCostExVat > sellingPriceExVat)
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Selling price below recipe cost",
          "Selling price ex VAT is lower than recipe cost.",
          "This item is likely losing money before other costs.",
          "Review recipe cost or selling price.",
          productId,
        ),
      );
    if (foodCostPercent > 0.45)
      itemWarnings.push(
        menuHealthWarning(
          "Warning",
          product,
          "Food cost too high",
          "Food cost percentage is above the target range.",
          "Menu margin may be too low.",
          "Review selling price, portioning, or ingredient costs.",
          productId,
        ),
      );
    if (gpPercent > 0 && gpPercent < 0.55)
      itemWarnings.push(
        menuHealthWarning(
          "Warning",
          product,
          "GP below target",
          "GP percentage is below the target range.",
          "Profitability may be weak.",
          "Review selling price and recipe cost.",
          productId,
        ),
      );
    if (locationPriceStatus === "Missing Location Price")
      itemWarnings.push(
        menuHealthWarning(
          "Warning",
          product,
          "Missing location price",
          "No location price exists for this menu item.",
          "Multi-location pricing may be incomplete.",
          "Sync YOCO location prices or add a local location price.",
          productId,
        ),
      );
    if (
      modifierCostRisk.includes("Warning") ||
      modifierCostRisk.includes("Missing")
    )
      itemWarnings.push(
        menuHealthWarning(
          "Warning",
          product,
          "Modifier stock not linked",
          "Modifier mapping or stock deduction coverage may be incomplete.",
          "Modifier GP can be understated or stock can fail to deduct.",
          "Map stock-deducting modifiers and verify Modifier Usage rows.",
          productId,
        ),
      );

    for (const row of exploded.rows) recipeRows.push(row);
    for (const warning of itemWarnings) warningRows.push(warning);
    const riskStatus = itemWarnings.some(
      (warning) => warning.severity === "Critical",
    )
      ? "Critical"
      : itemWarnings.some((warning) => warning.severity === "Warning")
        ? "Warning"
        : "Healthy";

    rows.push({
      id: `menu-health:${productId}`,
      workspaceId: clean(product.workspace_id),
      menuItemId: productId,
      productId,
      menuItemName: clean(product.name),
      yocoProductName: clean(product.name),
      yocoVariantName: clean(
        raw.variantName ||
          raw.variant_name ||
          raw.variant?.name ||
          product.yoco_variant_id,
      ),
      yocoProductVariant: clean(product.yoco_variant_id)
        ? `${clean(product.name)} / ${clean(raw.variantName || raw.variant_name || raw.variant?.name || product.yoco_variant_id)}`
        : clean(product.name),
      yocoCategory: clean(
        product.yoco_category_name ||
          product.yoco_category_name_resolved ||
          raw.category?.name ||
          product.yoco_category_id,
      ),
      category: clean(product.category || "Uncategorised"),
      menuCategory: clean(product.category || "Uncategorised"),
      locationIds: (priceRows || [])
        .map((price: Row) => clean(price.location_id))
        .filter(Boolean),
      locationPriceStatus,
      sellingPriceInclVat: basePriceInclVat,
      vatRate: normalizeReportVatRate(context.vatRate),
      vat,
      sellingPriceExVat,
      recipeCostExVat,
      modifierCostRisk,
      foodCostPercent,
      grossProfit,
      gpPercent,
      recipeStatus,
      stockDeductionStatus,
      yocoMappingStatus,
      riskStatus,
      warningsText: itemWarnings.map((warning) => warning.issueType).join("; "),
      salesCount: numberValue(product.sale_count, 0),
      qtySold: numberValue(product.qty_sold, 0),
      raw: { product, recipe, priceRows },
    });

    const productPricingRows = buildPricingRowsForProduct(
      product,
      context,
      basePriceInclVat,
      recipeCostExVat,
      itemWarnings,
      recipe,
    );
    pricingRows.push(...productPricingRows);
  }
  return { rows, recipeRows, pricingRows, warningRows };
}

function explodeMenuRecipe(
  product: Row,
  recipe: Row,
  context: Row,
  warnings: Array<{ code: string; level: string; message: string }>,
  itemWarnings: Row[],
  path: string[] = [],
  level = 1,
  parentRecipe = "",
): { rows: Row[]; cost: number } {
  const recipeId = clean(recipe.id);
  if (path.includes(recipeId)) {
    const warning = menuHealthWarning(
      "Critical",
      product,
      "Sub-recipe circular reference",
      `Circular sub-recipe reference detected at recipe ${recipeId}.`,
      "Recipe cost cannot be trusted.",
      "Remove the circular recipe link.",
      recipeId,
    );
    itemWarnings.push(warning);
    warnings.push({
      code: "menu-health-circular-recipe",
      level: "critical",
      message: warning.issue,
    });
    return { rows: [], cost: 0 };
  }
  const lines = context.linesByRecipe.get(recipeId) || [];
  if (!lines.length) return { rows: [], cost: 0 };
  const yieldQty = Math.max(numberValue(recipe.yield_qty, 1), 1);
  const nextPath = [...path, recipeId];
  const rows: Row[] = [];
  let totalCost = 0;
  for (const line of lines) {
    const stockItemId = clean(line.stock_item_id);
    if (!stockItemId || !clean(line.stock_item_name)) {
      const warning = menuHealthWarning(
        "Critical",
        product,
        "Missing stock item link",
        "Recipe ingredient is missing a stock item link.",
        "Recipe cost cannot be calculated for this line.",
        "Link the recipe line to a stock item.",
        clean(line.id),
      );
      itemWarnings.push(warning);
      continue;
    }
    const converted = convertMenuRecipeQty({
      qty: numberValue(line.quantity, 0),
      fromUom: clean(line.unit || line.base_uom),
      toUom: clean(line.base_uom || line.unit),
      stockRawJson: line.stock_raw_json,
    });
    if (converted.missingConversion)
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Missing UOM conversion",
          `Missing UOM conversion from ${clean(line.unit)} to ${clean(line.base_uom)}.`,
          "Recipe quantity may be wrong.",
          "Add a UOM conversion for the ingredient.",
          clean(line.id),
        ),
      );
    const qtyRequired = converted.qty / yieldQty;
    const stockItem = {
      id: stockItemId,
      item_type: line.item_type,
      is_stocked: line.is_stocked,
      raw_json: line.stock_raw_json,
    };
    const nestedRecipe = context.recipesByOwner.get(
      `stock_item:${stockItemId}`,
    );
    if (
      isSubRecipeStockItem(stockItem) &&
      !isStockHoldingPrepItem(stockItem) &&
      nestedRecipe
    ) {
      const nested = explodeMenuRecipe(
        product,
        nestedRecipe,
        context,
        warnings,
        itemWarnings,
        nextPath,
        level + 1,
        clean(line.stock_item_name),
      );
      for (const nestedRow of nested.rows) {
        const multipliedQty =
          numberValue(nestedRow.qtyRequired, 0) * qtyRequired;
        const lineCost = roundMoneyNumber(
          multipliedQty * numberValue(nestedRow.unitCostExVat, 0),
        );
        rows.push({
          ...nestedRow,
          id: `${nestedRow.id}:${clean(line.id)}`,
          qtyRequired: multipliedQty,
          lineCost,
          recipeLineType: "Sub-Recipe Ingredient",
          parentRecipe: clean(line.stock_item_name),
          recipeLevel: `Level ${Math.min(level + 1, 99)}`,
        });
        totalCost += lineCost;
      }
      continue;
    }
    if (
      isSubRecipeStockItem(stockItem) &&
      !isStockHoldingPrepItem(stockItem) &&
      !nestedRecipe
    ) {
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Missing recipe ingredient",
          `Sub-recipe ${clean(line.stock_item_name)} has no linked recipe.`,
          "Sub-recipe cost cannot be exploded to final ingredients.",
          "Create a recipe for the sub-recipe stock item.",
          stockItemId,
        ),
      );
    }
    const unitCostExVat = numberValue(line.unit_cost, 0);
    if (!unitCostExVat)
      itemWarnings.push(
        menuHealthWarning(
          "Critical",
          product,
          "Missing ingredient cost",
          `${clean(line.stock_item_name)} has no unit cost.`,
          "Recipe cost is understated.",
          "Load a unit cost for the stock item or location.",
          stockItemId,
        ),
      );
    if (numberValue(line.stock_active, 1) === 0)
      itemWarnings.push(
        menuHealthWarning(
          "Warning",
          product,
          "Recipe ingredient inactive",
          `${clean(line.stock_item_name)} is inactive.`,
          "Inactive ingredients may not be purchasable or counted.",
          "Reactivate or replace the stock item.",
          stockItemId,
        ),
      );
    const recipeLineType =
      isSubRecipeStockItem(stockItem) && isStockHoldingPrepItem(stockItem)
        ? "Stock-Holding Prep Item"
        : level > 1
          ? "Sub-Recipe Ingredient"
          : "Direct Ingredient";
    const lineCost = roundMoneyNumber(qtyRequired * unitCostExVat);
    totalCost += lineCost;
    rows.push({
      id: `menu-recipe-detail:${clean(product.id)}:${recipeId}:${clean(line.id)}`,
      workspaceId: clean(product.workspace_id),
      menuItemId: clean(product.id),
      menuItemName: clean(product.name),
      recipeSubRecipe: parentRecipe || clean(product.name),
      recipeLevel: `Level ${level}`,
      recipeLineType,
      ingredientId: stockItemId,
      ingredientName: clean(line.stock_item_name),
      inventoryCategory: clean(line.stock_category || "General"),
      qtyRequired,
      baseUom: clean(line.base_uom || line.unit || "ea"),
      unitCostExVat,
      lineCost,
      inStockQty: numberValue(line.in_stock_qty, 0),
      lowStockThreshold: numberValue(line.threshold_qty, 0),
      status: lineCost > 0 ? "Costed" : "Missing Cost",
      warning: unitCostExVat ? "" : "Missing ingredient cost",
      parentRecipe,
      sourceId: clean(line.id),
      raw: { recipe, line },
    });
  }
  return { rows, cost: totalCost };
}

/**
 * Pure (no warnings, no side effects) recipe-cost walk used only to re-cost a recipe at one
 * specific location for the per-location pricing breakdown. explodeMenuRecipe already computes
 * the workspace-level cost once per product and pushes warnings as a side effect; calling it again
 * per location would duplicate every ingredient warning onto the shared itemWarnings/warnings
 * arrays, so this mirrors its cost-only logic instead of reusing it directly.
 */
function calculateLocationRecipeCost(
  recipe: Row | undefined,
  context: Row,
  locationId: string,
  path: string[] = [],
): number {
  if (!recipe) return 0;
  const recipeId = clean(recipe.id);
  if (path.includes(recipeId)) return 0;
  const lines = context.linesByRecipe.get(recipeId) || [];
  if (!lines.length) return 0;
  const yieldQty = Math.max(numberValue(recipe.yield_qty, 1), 1);
  const nextPath = [...path, recipeId];
  let totalCost = 0;
  for (const line of lines) {
    const stockItemId = clean(line.stock_item_id);
    // Matches explodeMenuRecipe's own skip condition (a stock_item_id with no resolved
    // stock_item_name means the linked stock item was deleted) — otherwise this per-location cost
    // would silently include a line the workspace-level summary cost deliberately excludes (with
    // a "Missing stock item link" warning), producing two different costs for the same recipe.
    if (!stockItemId || !clean(line.stock_item_name)) continue;
    const converted = convertMenuRecipeQty({
      qty: numberValue(line.quantity, 0),
      fromUom: clean(line.unit || line.base_uom),
      toUom: clean(line.base_uom || line.unit),
      stockRawJson: line.stock_raw_json,
    });
    const qtyRequired = converted.qty / yieldQty;
    const stockItem = {
      id: stockItemId,
      item_type: line.item_type,
      is_stocked: line.is_stocked,
      raw_json: line.stock_raw_json,
    };
    const nestedRecipe = context.recipesByOwner.get(`stock_item:${stockItemId}`);
    if (
      isSubRecipeStockItem(stockItem) &&
      !isStockHoldingPrepItem(stockItem) &&
      nestedRecipe
    ) {
      totalCost +=
        qtyRequired *
        calculateLocationRecipeCost(nestedRecipe, context, locationId, nextPath);
      continue;
    }
    totalCost += qtyRequired * resolveMenuRecipeIngredientCost(stockItemId, line, context, locationId);
  }
  return totalCost;
}

/** Location cost override if one exists for this ingredient at this location, else the workspace-global unit cost. */
function resolveMenuRecipeIngredientCost(
  stockItemId: string,
  line: Row,
  context: Row,
  locationId: string,
): number {
  if (locationId) {
    const override = context.locationCostsByStockItem?.get(stockItemId)?.get(locationId);
    if (override !== undefined) return override;
  }
  return numberValue(line.unit_cost, 0);
}

function buildPricingRowsForProduct(
  product: Row,
  context: Row,
  fallbackPriceInclVat: number,
  recipeCostExVat: number,
  itemWarnings: Row[],
  recipe?: Row,
) {
  const priceRows = context.priceRowsByProduct.get(clean(product.id)) || [];
  const targetPrices = priceRows.length
    ? priceRows
    : [
        {
          product_id: product.id,
          location_id: "",
          location_name: "Default",
          price: fallbackPriceInclVat,
        },
      ];
  return targetPrices.map((price: Row, index: number) => {
    const locationId = clean(price.location_id);
    // Resolved the same way the selling price already is: per-location cost when this row has a
    // real location, else the workspace-level cost already computed for the summary row.
    const locationRecipeCostExVat = recipe && locationId
      ? roundMoneyNumber(calculateLocationRecipeCost(recipe, context, locationId))
      : recipeCostExVat;
    const sellingPriceInclVat = roundMoneyNumber(
      numberValue(price.price, fallbackPriceInclVat),
    );
    const vat = calculateVatAmount(sellingPriceInclVat, context.vatRate);
    const sellingPriceExVat = roundMoneyNumber(sellingPriceInclVat - vat);
    const grossProfit = roundMoneyNumber(sellingPriceExVat - locationRecipeCostExVat);
    const gpPercent = sellingPriceExVat ? grossProfit / sellingPriceExVat : 0;
    const foodCostPercent = sellingPriceExVat
      ? locationRecipeCostExVat / sellingPriceExVat
      : 0;
    const priceStatus = resolveLocationPriceStatus(
      product,
      priceRows,
      context.locations,
      locationId,
    );
    const rowWarnings = itemWarnings.filter((warning) =>
      [
        "Missing location price",
        "Selling price missing",
        "Selling price below recipe cost",
        "Food cost too high",
        "GP below target",
      ].includes(warning.issueType),
    );
    return {
      id: `menu-recipe-pricing:${clean(product.id)}:${locationId || index}`,
      workspaceId: clean(product.workspace_id),
      menuItemId: clean(product.id),
      menuItemName: clean(product.name),
      yocoProductName: clean(product.name),
      yocoVariantName: clean(
        parseJson(product.raw_json).variantName ||
          parseJson(product.raw_json).variant_name ||
          product.yoco_variant_id,
      ),
      yocoCategory: clean(
        product.yoco_category_name ||
          product.yoco_category_name_resolved ||
          product.yoco_category_id,
      ),
      locationId,
      locationName: clean(price.location_name || "Default"),
      sellingPriceInclVat,
      vatRate: normalizeReportVatRate(context.vatRate),
      vat,
      sellingPriceExVat,
      recipeCostExVat: locationRecipeCostExVat,
      grossProfit,
      gpPercent,
      foodCostPercent,
      priceStatus,
      warning: rowWarnings.map((warning) => warning.issueType).join("; "),
      riskStatus: rowWarnings.some((warning) => warning.severity === "Critical")
        ? "Critical"
        : rowWarnings.some((warning) => warning.severity === "Warning")
          ? "Warning"
          : "Healthy",
    };
  });
}

function filterMenuRecipeHealthPayload(
  payload: Row,
  filters: ReturnType<typeof readFilters>,
) {
  const productIds = new Set<string>();
  const rows = payload.rows.filter((row: Row) =>
    menuRecipeHealthRowMatches(row, filters),
  );
  rows.forEach((row: Row) => productIds.add(clean(row.menuItemId)));
  return {
    rows,
    recipeRows: payload.recipeRows.filter(
      (row: Row) =>
        productIds.has(clean(row.menuItemId)) &&
        recipeDetailMatches(row, filters),
    ),
    pricingRows: payload.pricingRows.filter(
      (row: Row) =>
        productIds.has(clean(row.menuItemId)) && pricingMatches(row, filters),
    ),
    warningRows: payload.warningRows.filter(
      (row: Row) =>
        productIds.has(clean(row.menuItemId)) && warningMatches(row, filters),
    ),
  };
}

function menuRecipeHealthRowMatches(
  row: Row,
  filters: ReturnType<typeof readFilters>,
) {
  if (
    filters.recipeStatus &&
    clean(row.recipeStatus).toLowerCase() !== filters.recipeStatus.toLowerCase()
  )
    return false;
  if (
    filters.stockDeductionStatus &&
    clean(row.stockDeductionStatus).toLowerCase() !==
      filters.stockDeductionStatus.toLowerCase()
  )
    return false;
  if (
    filters.riskStatus &&
    clean(row.riskStatus).toLowerCase() !== filters.riskStatus.toLowerCase()
  )
    return false;
  if (!rowMatchesLocationScope(row.locationIds || row.locationId, filters)) return false;
  return true;
}

function recipeDetailMatches(
  row: Row,
  filters: ReturnType<typeof readFilters>,
) {
  if (
    filters.inventoryCategory &&
    clean(row.inventoryCategory).toLowerCase() !==
      filters.inventoryCategory.toLowerCase()
  )
    return false;
  if (
    filters.inventoryItemId &&
    clean(row.ingredientId) !== filters.inventoryItemId
  )
    return false;
  return true;
}

function pricingMatches(row: Row, filters: ReturnType<typeof readFilters>) {
  if (!rowMatchesLocationScope(row.locationId, filters)) return false;
  if (
    filters.riskStatus &&
    clean(row.riskStatus).toLowerCase() !== filters.riskStatus.toLowerCase()
  )
    return false;
  return true;
}

function warningMatches(row: Row, filters: ReturnType<typeof readFilters>) {
  if (
    filters.warningSeverity &&
    clean(row.severity).toLowerCase() !== filters.warningSeverity.toLowerCase()
  )
    return false;
  if (
    filters.riskStatus &&
    clean(row.severity).toLowerCase() !== filters.riskStatus.toLowerCase()
  )
    return false;
  return true;
}

function resolveProductPrice(product: Row, priceRows: Row[]) {
  if (priceRows.length) {
    const positive = priceRows
      .map((row) => numberValue(row.price, 0))
      .filter((price) => price > 0);
    if (positive.length) return roundMoneyNumber(positive[0]);
  }
  return roundMoneyNumber(numberValue(product.price, 0));
}

function resolveLocationPriceStatus(
  product: Row,
  priceRows: Row[],
  locations: Row[],
  locationId = "",
) {
  const basePrice = numberValue(product.price, 0);
  if (
    locationId &&
    !priceRows.some((row) => clean(row.location_id) === locationId)
  )
    return "Missing Location Price";
  if (!priceRows.length)
    return basePrice > 0 ? "Single Price" : "Missing Location Price";
  const prices = uniqueText(
    priceRows.map((row) => String(roundMoneyNumber(numberValue(row.price, 0)))),
  );
  if (locations.length && priceRows.length < locations.length && basePrice <= 0)
    return "Missing Location Price";
  if (prices.length > 1) return "Multi-location Price";
  if (
    basePrice > 0 &&
    prices.length === 1 &&
    Math.abs(numberValue(prices[0], 0) - basePrice) > 0.01
  )
    return "Price Mismatch";
  return "Single Price";
}

function resolveYocoMappingStatus(product: Row, raw: Row) {
  if (!clean(product.yoco_item_id)) return "Missing YOCO Product Mapping";
  if (hasVariantData(raw) && !clean(product.yoco_variant_id))
    return "Missing YOCO Variant Mapping";
  return "Mapped";
}

function resolveModifierCostRisk(product: Row, raw: Row, context: Row) {
  const modifiers = extractProductModifierRefs(raw);
  if (!modifiers.length) return "No Modifier Risk Found";
  const productModifierRefs = modifiers.filter(
    (modifier) =>
      normalizeModifierType(
        modifier.type ||
          modifier.modifierType ||
          modifier.kind ||
          (modifier.variant_id || modifier.variantId ? "product" : "note"),
      ) === "Product",
  );
  if (!productModifierRefs.length) return "Note Modifiers Only";
  const usageRows = numberValue(
    context.modifierUsageByProduct.get(clean(product.id)),
    0,
  );
  return usageRows > 0
    ? "Modifier Usage Linked"
    : "Warning - Missing Modifier Usage";
}

function extractProductModifierRefs(raw: Row) {
  const refs: Row[] = [];
  for (const key of [
    "modifiers",
    "modifierGroups",
    "modifier_groups",
    "modifier_group_ids",
    "modifierGroupIds",
  ]) {
    const value = raw[key];
    if (Array.isArray(value)) refs.push(...value.map(objectFromUnknown));
  }
  return refs;
}

function hasVariantData(raw: Row) {
  return Boolean(
    clean(raw.variantName || raw.variant_name || raw.variant?.name) ||
    Array.isArray(raw.variants) ||
    Array.isArray(raw.productVariants) ||
    Array.isArray(raw.product_variants),
  );
}

function menuHealthWarning(
  severity: string,
  product: Row,
  issueType: string,
  issue: string,
  impact: string,
  suggestedFix: string,
  sourceId = "",
) {
  return {
    id: `menu-health-warning:${clean(product.id)}:${issueType.toLowerCase().replace(/\s+/g, "-")}:${clean(sourceId)}`,
    severity,
    menuItemId: clean(product.id),
    menuItemName: clean(product.name),
    category: clean(product.category || "Uncategorised"),
    yocoCategory: clean(
      product.yoco_category_name ||
        product.yoco_category_name_resolved ||
        product.yoco_category_id,
    ),
    issueType,
    issue,
    impact,
    suggestedFix,
    sourceId: clean(sourceId || product.id),
    riskStatus: severity,
  };
}

function convertMenuRecipeQty({ qty, fromUom, toUom, stockRawJson }: Row) {
  const quantity = numberValue(qty, 0);
  const from = normalizeUomForReport(fromUom || toUom);
  const to = normalizeUomForReport(toUom || fromUom);
  if (!from || !to || from === to) return { qty: quantity, factor: 1 };
  const standard: Row = {
    g: ["kg", 0.001],
    gram: ["kg", 0.001],
    grams: ["kg", 0.001],
    kg: ["kg", 1],
    ml: ["l", 0.001],
    millilitre: ["l", 0.001],
    milliliter: ["l", 0.001],
    l: ["l", 1],
    litre: ["l", 1],
    liter: ["l", 1],
    ea: ["ea", 1],
    each: ["ea", 1],
    unit: ["ea", 1],
    units: ["ea", 1],
  };
  const a = standard[from];
  const b = standard[to];
  if (a && b && a[0] === b[0])
    return { qty: quantity * (a[1] / b[1]), factor: a[1] / b[1] };
  const raw = parseJson(stockRawJson);
  // The UOM builder saves custom UOM ratios under `uomConfigurations` with shape
  // { baseUom, customUom, ratio } (see normalizeUomConfigurations) — NOT `uomConversions` with a
  // { from, to, factor } shape. This function previously only ever checked `uomConversions`, a
  // field nothing in the app actually writes, so a configured custom UOM ratio could never be
  // found here and every custom-UOM recipe line was permanently flagged as "missing conversion"
  // regardless of what was set up. Check the real field (with legacy aliases kept as a fallback
  // for any older data shaped the other way) and match on the correct property names.
  const configuredUoms = Array.isArray(raw.uomConfigurations)
    ? raw.uomConfigurations
    : Array.isArray(raw.uomConfig)
      ? raw.uomConfig
      : Array.isArray(raw.uoms)
        ? raw.uoms
        : Array.isArray(raw.customUoms)
          ? raw.customUoms
          : [];
  const entryCustom = (conversion: Row) =>
    normalizeUomForReport(conversion.customUom || conversion.custom_uom || conversion.customUnit);
  const entryBase = (conversion: Row) =>
    normalizeUomForReport(conversion.baseUom || conversion.base_uom || conversion.baseUnit);
  const entryRatio = (conversion: Row) =>
    numberValue(
      conversion.ratio ?? conversion.conversionRatio ?? conversion.unitsPerCustomUnit ?? conversion.units_per_custom_unit,
      0,
    );

  const configMatch = configuredUoms.find(
    (conversion: Row) => entryCustom(conversion) === from && (entryBase(conversion) === to || !entryBase(conversion)),
  );
  if (configMatch) {
    const factor = entryRatio(configMatch);
    if (factor) return { qty: quantity * factor, factor };
  }

  // A configured ratio describes both directions. `ratio` is base units per ONE custom unit, so the
  // custom -> base direction is the ratio and base -> custom is its reciprocal. Without this inverse
  // lookup a recipe line written in the base UOM against an item stocked in a custom one was still
  // reported as a missing conversion even though the ratio was set up in the UOM builder.
  const inverseMatch = configuredUoms.find(
    (conversion: Row) => entryBase(conversion) === from && entryCustom(conversion) === to && entryRatio(conversion) > 0,
  );
  if (inverseMatch) {
    const factor = 1 / entryRatio(inverseMatch);
    return { qty: quantity * factor, factor };
  }
  const conversions = Array.isArray(raw.uomConversions)
    ? raw.uomConversions
    : [];
  const match = conversions.find(
    (conversion: Row) =>
      normalizeUomForReport(
        conversion.from || conversion.uom || conversion.name,
      ) === from &&
      normalizeUomForReport(
        conversion.to || conversion.baseUom || conversion.base_uom,
      ) === to,
  );
  if (match) {
    const factor = numberValue(
      match.factor ?? match.ratio ?? match.qtyInBase ?? match.qty_in_base,
      0,
    );
    if (factor) return { qty: quantity * factor, factor };
  }
  // `ea` here is not the unit "each": it is the sentinel the recipe editor writes into
  // recipe_lines.unit when no explicit UOM was chosen (normalizeRecipeLines in
  // services/recipeService.js), and it means "use the stock item's base unit" — which is exactly
  // what the recipe screen renders for such a line. Reporting it as a missing conversion produced
  // a permanent, unactionable "Missing UOM conversion from ea to kg." warning on every recipe line
  // measured in kg/g/L/ml, telling merchants to configure a conversion that should not exist. See
  // inventory/uom.ts, which holds the same contract for the stock-deduction path.
  if (from === "ea") return { qty: quantity, factor: 1 };
  return { qty: quantity, factor: 1, missingConversion: true };
}

function normalizeUomForReport(value: unknown) {
  return clean(value).toLowerCase().replace(/\./g, "").trim();
}

function isSubRecipeStockItem(stockItem: Row) {
  const raw = parseJson(stockItem.raw_json);
  const type = clean(stockItem.item_type || raw.itemType || raw.item_type)
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  return (
    type.includes("sub recipe") ||
    type.includes("subrecipe") ||
    raw.isSubRecipe === true ||
    raw.isSubRecipe === 1 ||
    raw.isSubRecipe === "true"
  );
}

function isStockHoldingPrepItem(stockItem: Row) {
  const raw = parseJson(stockItem.raw_json);
  const type = clean(stockItem.item_type || raw.itemType || raw.item_type)
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  const stocked =
    stockItem.is_stocked === true ||
    stockItem.is_stocked === 1 ||
    raw.isStocked === true ||
    raw.isStocked === 1;
  return (
    stocked &&
    (type.includes("prep") ||
      type.includes("manufactured") ||
      type.includes("stock holding"))
  );
}

function normalizeReportVatRate(vatRate: unknown) {
  const supplied = numberValue(vatRate, 0);
  const rate = supplied > 0 ? supplied : 15;
  return rate > 1 ? rate / 100 : rate;
}

async function getMenuRecipeHealthFilterOptions(
  env: Env,
  workspaceId: string,
  filtered: Row,
  tableStatus: Record<string, boolean>,
) {
  const base = await getReportFilterOptions(env, workspaceId);
  const menuCategories = uniqueText(
    (filtered.rows || []).map((row: Row) =>
      clean(row.menuCategory || row.category),
    ),
  );
  const yocoCategories = uniqueText(
    (filtered.rows || []).map((row: Row) => clean(row.yocoCategory)),
  );
  return {
    ...base,
    menuCategories,
    yocoCategories,
    menuItems: (filtered.rows || [])
      .map((row: Row) => ({
        value: clean(row.menuItemId),
        label: clean(row.menuItemName),
      }))
      .filter((row: Row) => row.value),
    inventoryCategories: uniqueText(
      (filtered.recipeRows || []).map((row: Row) =>
        clean(row.inventoryCategory),
      ),
    ),
    inventoryItems: (filtered.recipeRows || [])
      .map((row: Row) => ({
        value: clean(row.ingredientId),
        label: clean(row.ingredientName),
      }))
      .filter((row: Row) => row.value),
    recipeStatuses: uniqueText(
      (filtered.rows || []).map((row: Row) => clean(row.recipeStatus)),
    ),
    stockDeductionStatuses: uniqueText(
      (filtered.rows || []).map((row: Row) => clean(row.stockDeductionStatus)),
    ),
    riskStatuses: uniqueText(
      (filtered.rows || []).map((row: Row) => clean(row.riskStatus)),
    ),
    warningSeverities: uniqueText(
      (filtered.warningRows || []).map((row: Row) => clean(row.severity)),
    ),
  };
}

async function safeAllRows(statement: {
  all: () => Promise<{ results?: Row[] }>;
}) {
  try {
    const rows = await statement.all();
    return rows.results || [];
  } catch {
    return [];
  }
}

export async function getLedgerIntegrityAudit(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);
  const tables = [
    "stock_movements",
    "grvs",
    "grv_lines",
    "credit_notes",
    "credit_note_lines",
    "adjustments",
    "adjustment_lines",
    "manufacturing_batches",
    "manufacturing_batch_lines",
    "stocktake_sessions",
    "stocktake_count_lines",
    "transfers",
    "transfer_lines",
    "yoco_orders",
    "yoco_order_lines",
    "stock_items",
    "locations",
  ];
  const tableStatus: Record<string, boolean> = {};
  for (const table of tables)
    tableStatus[table] = await tableExists(env, table);

  const status = [
    await sourceStatus(
      env,
      workspaceId,
      "GRV",
      tableStatus.grv_lines,
      grvMissingSql(),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Credit Note",
      tableStatus.credit_note_lines,
      creditNoteMissingSql(),
    ),
    {
      sourceType: "Purchase Order Receive",
      status: "not_applicable",
      message:
        "This system posts purchase order receipts through GRV rows unless a direct purchase_order movement exists.",
    },
    await sourceStatus(
      env,
      workspaceId,
      "Manual Adjustment",
      tableStatus.adjustment_lines,
      adjustmentMissingSql("manual"),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Wastage Adjustment",
      tableStatus.adjustment_lines,
      adjustmentMissingSql("wastage"),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Manufacturing In",
      tableStatus.manufacturing_batches,
      manufacturingInMissingSql(),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Manufacturing Out",
      tableStatus.manufacturing_batch_lines,
      manufacturingOutMissingSql(),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Manufacturing Wastage",
      tableStatus.manufacturing_batches,
      manufacturingWastageMissingSql(),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Stock Take Variance",
      tableStatus.stocktake_count_lines,
      stockTakeVarianceMissingSql(),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Transfer Out",
      tableStatus.transfer_lines,
      transferMissingSql("out"),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Transfer In",
      tableStatus.transfer_lines,
      transferMissingSql("in"),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Sale Usage",
      tableStatus.yoco_orders,
      saleUsageMissingSql(),
    ),
    await sourceStatus(
      env,
      workspaceId,
      "Modifier Usage",
      tableStatus.yoco_orders,
      modifierUsageMissingSql(),
    ),
  ];

  const ledgerCounts = tableStatus.stock_movements
    ? await env.DB.prepare(
        `SELECT document_type, movement_type, COUNT(*) AS rows
       FROM stock_movements
      WHERE workspace_id = ?1
      GROUP BY document_type, movement_type
      ORDER BY document_type, movement_type`,
      )
        .bind(workspaceId)
        .all<Row>()
    : { results: [] };

  return json(request, env, {
    ok: true,
    workspaceId,
    ledgerTable: "stock_movements",
    tableStatus,
    sourceStatus: status,
    ledgerCounts: ledgerCounts.results || [],
    generatedAt: new Date().toISOString(),
  });
}

export async function postLedgerIntegrityBackfill(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);
  const url = new URL(request.url);
  const body: Record<string, unknown> =
    request.method === "POST"
      ? await readJson<Record<string, unknown>>(request).catch(
          () => ({}) as Record<string, unknown>,
        )
      : {};
  const dryRun =
    url.searchParams.get("dryRun") !== "false" && body.dryRun !== false;
  const steps = [
    backfillStep("GRV", grvMissingSql(), grvBackfillSql()),
    backfillStep(
      "Credit Note",
      creditNoteMissingSql(),
      creditNoteBackfillSql(),
    ),
    backfillStep(
      "Manual Adjustment",
      adjustmentMissingSql("manual"),
      adjustmentBackfillSql("manual"),
    ),
    backfillStep(
      "Wastage Adjustment",
      adjustmentMissingSql("wastage"),
      adjustmentBackfillSql("wastage"),
    ),
    backfillStep(
      "Manufacturing In",
      manufacturingInMissingSql(),
      manufacturingInBackfillSql(),
    ),
    backfillStep(
      "Manufacturing Out",
      manufacturingOutMissingSql(),
      manufacturingOutBackfillSql(),
    ),
    backfillStep(
      "Manufacturing Wastage",
      manufacturingWastageMissingSql(),
      manufacturingWastageBackfillSql(),
    ),
    backfillStep(
      "Stock Take Variance",
      stockTakeVarianceMissingSql(),
      stockTakeVarianceBackfillSql(),
    ),
    backfillStep(
      "Transfer Out",
      transferMissingSql("out"),
      transferOutBackfillSql(),
    ),
    backfillStep(
      "Transfer In",
      transferMissingSql("in"),
      transferInBackfillSql(),
    ),
  ];

  const results: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    const wouldCreate = await countQuery(env, workspaceId, step.missingSql);
    let changed = 0;
    if (!dryRun && wouldCreate > 0) {
      const result = await env.DB.prepare(step.insertSql)
        .bind(workspaceId)
        .run();
      changed =
        Number((result as Row).meta?.changes || (result as Row).changes || 0) ||
        0;
    }
    results.push({
      sourceType: step.sourceType,
      wouldCreate,
      created: dryRun ? 0 : changed,
    });
  }

  const oldManufacturingWastage = await countQuery(
    env,
    workspaceId,
    manufacturingWastageAccountingOnlySql(),
  );
  let repairedManufacturingWastage = 0;
  if (!dryRun && oldManufacturingWastage > 0) {
    const result = await env.DB.prepare(manufacturingWastageRepairSql())
      .bind(workspaceId)
      .run();
    repairedManufacturingWastage =
      Number((result as Row).meta?.changes || (result as Row).changes || 0) ||
      0;
  }
  results.push({
    sourceType: "Manufacturing Wastage Quantity Normalisation",
    wouldUpdate: oldManufacturingWastage,
    updated: dryRun ? 0 : repairedManufacturingWastage,
  });

  return json(request, env, {
    ok: true,
    dryRun,
    ledgerTable: "stock_movements",
    results,
    generatedAt: new Date().toISOString(),
  });
}

function backfillStep(
  sourceType: string,
  missingSql: string,
  insertSql: string,
) {
  return { sourceType, missingSql, insertSql };
}

async function sourceStatus(
  env: Env,
  workspaceId: string,
  sourceType: string,
  featureExists: boolean,
  missingSql: string,
) {
  if (!featureExists)
    return { sourceType, status: "feature_not_available", missingRows: 0 };
  const missingRows = await countQuery(env, workspaceId, missingSql);
  return {
    sourceType,
    status: missingRows > 0 ? "historical_backfill_needed" : "supported",
    missingRows,
  };
}

async function countQuery(env: Env, workspaceId: string, sql: string) {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM (${sql}) missing_rows`,
    )
      .bind(workspaceId)
      .first<Row>();
    return numberValue(row?.count, 0);
  } catch {
    return 0;
  }
}

function grvMissingSql() {
  return `SELECT gl.id
    FROM grv_lines gl
    JOIN grvs g ON g.id = gl.grv_id AND g.workspace_id = gl.workspace_id
   WHERE gl.workspace_id = ?1
     AND COALESCE(gl.quantity, 0) <> 0
     AND NOT EXISTS (
       SELECT 1 FROM stock_movements sm
        WHERE sm.workspace_id = gl.workspace_id
          AND sm.document_type = 'grv'
          AND sm.document_id = gl.grv_id
          AND sm.stock_item_id = gl.stock_item_id
          AND sm.location_id = gl.location_id
          AND sm.movement_type = 'grv_in'
     )`;
}

function grvBackfillSql() {
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_grv_' || gl.id, gl.workspace_id, gl.stock_item_id, gl.location_id, 'grv_in', 'grv', gl.grv_id, gl.location_id,
           gl.quantity, gl.unit_price, COALESCE(gl.total_ex, gl.quantity * gl.unit_price), COALESCE(g.received_at, g.created_at), g.created_by,
           json_object('backfilled', 1, 'sourceLineId', gl.id), datetime('now')
      FROM grv_lines gl
      JOIN grvs g ON g.id = gl.grv_id AND g.workspace_id = gl.workspace_id
     WHERE gl.workspace_id = ?1
       AND COALESCE(gl.quantity, 0) <> 0
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = gl.workspace_id AND sm.document_type = 'grv' AND sm.document_id = gl.grv_id AND sm.stock_item_id = gl.stock_item_id AND sm.location_id = gl.location_id AND sm.movement_type = 'grv_in')`;
}

function creditNoteMissingSql() {
  return `SELECT cnl.id
    FROM credit_note_lines cnl
    JOIN credit_notes cn ON cn.id = cnl.credit_note_id AND cn.workspace_id = cnl.workspace_id
   WHERE cnl.workspace_id = ?1
     AND COALESCE(cnl.quantity, 0) <> 0
     AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = cnl.workspace_id AND sm.document_type = 'credit_note' AND sm.document_id = cnl.credit_note_id AND sm.stock_item_id = cnl.stock_item_id AND sm.location_id = cnl.location_id)`;
}

function creditNoteBackfillSql() {
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, source_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_credit_note_' || cnl.id, cnl.workspace_id, cnl.stock_item_id, cnl.location_id, 'credit_note_out', 'credit_note', cnl.credit_note_id, cnl.location_id,
           -ABS(cnl.quantity), cnl.unit_cost, -ABS(COALESCE(cnl.total_ex, cnl.quantity * cnl.unit_cost)), COALESCE(cn.credited_at, cn.created_at), cn.created_by,
           json_object('backfilled', 1, 'sourceLineId', cnl.id), datetime('now')
      FROM credit_note_lines cnl
      JOIN credit_notes cn ON cn.id = cnl.credit_note_id AND cn.workspace_id = cnl.workspace_id
     WHERE cnl.workspace_id = ?1
       AND COALESCE(cnl.quantity, 0) <> 0
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = cnl.workspace_id AND sm.document_type = 'credit_note' AND sm.document_id = cnl.credit_note_id AND sm.stock_item_id = cnl.stock_item_id AND sm.location_id = cnl.location_id)`;
}

function adjustmentMissingSql(kind: "manual" | "wastage") {
  const clause =
    kind === "wastage"
      ? "lower(a.adjustment_type) = 'wastage'"
      : "lower(a.adjustment_type) <> 'wastage'";
  return `SELECT al.id
    FROM adjustment_lines al
    JOIN adjustments a ON a.id = al.adjustment_id AND a.workspace_id = al.workspace_id
   WHERE al.workspace_id = ?1
     AND ${clause}
     AND COALESCE(al.quantity_delta, 0) <> 0
     AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = al.workspace_id AND sm.document_id = al.adjustment_id AND sm.stock_item_id = al.stock_item_id AND sm.location_id = al.location_id AND sm.movement_type = CASE WHEN lower(a.adjustment_type) = 'wastage' THEN 'wastage' ELSE 'adjustment' END)`;
}

function adjustmentBackfillSql(kind: "manual" | "wastage") {
  const clause =
    kind === "wastage"
      ? "lower(a.adjustment_type) = 'wastage'"
      : "lower(a.adjustment_type) <> 'wastage'";
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_adjustment_' || al.id, al.workspace_id, al.stock_item_id, al.location_id,
           CASE WHEN lower(a.adjustment_type) = 'wastage' THEN 'wastage' ELSE 'adjustment' END,
           CASE WHEN lower(a.adjustment_type) = 'wastage' THEN 'wastage_adjustment' ELSE 'adjustment' END,
           al.adjustment_id, al.quantity_delta, al.unit_cost, al.quantity_delta * al.unit_cost, COALESCE(a.occurred_at, a.created_at), a.created_by,
           json_object('backfilled', 1, 'sourceLineId', al.id, 'adjustmentType', a.adjustment_type), datetime('now')
      FROM adjustment_lines al
      JOIN adjustments a ON a.id = al.adjustment_id AND a.workspace_id = al.workspace_id
     WHERE al.workspace_id = ?1
       AND ${clause}
       AND COALESCE(al.quantity_delta, 0) <> 0
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = al.workspace_id AND sm.document_id = al.adjustment_id AND sm.stock_item_id = al.stock_item_id AND sm.location_id = al.location_id AND sm.movement_type = CASE WHEN lower(a.adjustment_type) = 'wastage' THEN 'wastage' ELSE 'adjustment' END)`;
}

function manufacturingInMissingSql() {
  return `SELECT mb.id FROM manufacturing_batches mb
   WHERE mb.workspace_id = ?1 AND COALESCE(mb.quantity_made, 0) <> 0
     AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = mb.workspace_id AND sm.document_type = 'manufacturing_batch' AND sm.document_id = mb.id AND sm.stock_item_id = mb.stock_item_id AND sm.location_id = mb.location_id AND sm.movement_type = 'manufacturing_finished_in')`;
}

function manufacturingInBackfillSql() {
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_mfg_in_' || mb.id, mb.workspace_id, mb.stock_item_id, mb.location_id, 'manufacturing_finished_in', 'manufacturing_batch', mb.id,
           mb.quantity_made, si.unit_cost, mb.quantity_made * si.unit_cost, COALESCE(mb.posted_at, mb.created_at), mb.created_by,
           json_object('backfilled', 1, 'sourceBatchId', mb.id), datetime('now')
      FROM manufacturing_batches mb
      LEFT JOIN stock_items si ON si.id = mb.stock_item_id AND si.workspace_id = mb.workspace_id
     WHERE mb.workspace_id = ?1 AND COALESCE(mb.quantity_made, 0) <> 0
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = mb.workspace_id AND sm.document_type = 'manufacturing_batch' AND sm.document_id = mb.id AND sm.stock_item_id = mb.stock_item_id AND sm.location_id = mb.location_id AND sm.movement_type = 'manufacturing_finished_in')`;
}

function manufacturingOutMissingSql() {
  return `SELECT mbl.id FROM manufacturing_batch_lines mbl
    JOIN manufacturing_batches mb ON mb.id = mbl.manufacturing_batch_id AND mb.workspace_id = mbl.workspace_id
   WHERE mbl.workspace_id = ?1 AND COALESCE(mbl.quantity_used, 0) <> 0
     AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = mbl.workspace_id AND sm.document_type = 'manufacturing_batch' AND sm.document_id = mbl.manufacturing_batch_id AND sm.stock_item_id = mbl.component_stock_item_id AND sm.location_id = mbl.location_id AND sm.movement_type = 'manufacturing_component_out')`;
}

function manufacturingOutBackfillSql() {
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_mfg_out_' || mbl.id, mbl.workspace_id, mbl.component_stock_item_id, mbl.location_id, 'manufacturing_component_out', 'manufacturing_batch', mbl.manufacturing_batch_id,
           -ABS(mbl.quantity_used), mbl.unit_cost, -ABS(mbl.quantity_used * mbl.unit_cost), COALESCE(mb.posted_at, mb.created_at), mb.created_by,
           json_object('backfilled', 1, 'sourceLineId', mbl.id), datetime('now')
      FROM manufacturing_batch_lines mbl
      JOIN manufacturing_batches mb ON mb.id = mbl.manufacturing_batch_id AND mb.workspace_id = mbl.workspace_id
     WHERE mbl.workspace_id = ?1 AND COALESCE(mbl.quantity_used, 0) <> 0
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = mbl.workspace_id AND sm.document_type = 'manufacturing_batch' AND sm.document_id = mbl.manufacturing_batch_id AND sm.stock_item_id = mbl.component_stock_item_id AND sm.location_id = mbl.location_id AND sm.movement_type = 'manufacturing_component_out')`;
}

function manufacturingWastageMissingSql() {
  return `SELECT mb.id FROM manufacturing_batches mb
   WHERE mb.workspace_id = ?1
     AND COALESCE(json_extract(mb.raw_json, '$.wastageQty'), json_extract(mb.raw_json, '$.wasteQty'), json_extract(mb.raw_json, '$.expectedQty') - json_extract(mb.raw_json, '$.producedQty'), 0) > 0
     AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = mb.workspace_id AND sm.document_type = 'manufacturing_batch' AND sm.document_id = mb.id AND sm.stock_item_id = mb.stock_item_id AND sm.location_id = mb.location_id AND sm.movement_type = 'manufacturing_wastage')`;
}

function manufacturingWastageBackfillSql() {
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_mfg_waste_' || mb.id, mb.workspace_id, mb.stock_item_id, mb.location_id, 'manufacturing_wastage', 'manufacturing_batch', mb.id,
           0,
           COALESCE(json_extract(mb.raw_json, '$.expectedUnitCost'), si.unit_cost, 0),
           -ABS(COALESCE(json_extract(mb.raw_json, '$.wastageValue'),
             COALESCE(json_extract(mb.raw_json, '$.wastageQty'), json_extract(mb.raw_json, '$.wasteQty'), json_extract(mb.raw_json, '$.expectedQty') - json_extract(mb.raw_json, '$.producedQty'), 0)
               * COALESCE(json_extract(mb.raw_json, '$.expectedUnitCost'), si.unit_cost, 0), 0)),
           COALESCE(mb.posted_at, mb.created_at), mb.created_by,
           json_object(
             'backfilled', 1,
             'sourceBatchId', mb.id,
             'wastageQty', COALESCE(json_extract(mb.raw_json, '$.wastageQty'), json_extract(mb.raw_json, '$.wasteQty'), json_extract(mb.raw_json, '$.expectedQty') - json_extract(mb.raw_json, '$.producedQty'), 0),
             'accountingOnly', 1),
           datetime('now')
      FROM manufacturing_batches mb
      LEFT JOIN stock_items si ON si.id = mb.stock_item_id AND si.workspace_id = mb.workspace_id
     WHERE mb.workspace_id = ?1
       AND COALESCE(json_extract(mb.raw_json, '$.wastageQty'), json_extract(mb.raw_json, '$.wasteQty'), json_extract(mb.raw_json, '$.expectedQty') - json_extract(mb.raw_json, '$.producedQty'), 0) > 0
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = mb.workspace_id AND sm.document_type = 'manufacturing_batch' AND sm.document_id = mb.id AND sm.stock_item_id = mb.stock_item_id AND sm.location_id = mb.location_id AND sm.movement_type = 'manufacturing_wastage')`;
}

function manufacturingWastageAccountingOnlySql() {
  return `SELECT id FROM stock_movements
   WHERE workspace_id = ?1 AND movement_type = 'manufacturing_wastage' AND COALESCE(quantity_delta, 0) <> 0
     AND COALESCE(json_extract(metadata_json, '$.wastageQty'), json_extract(metadata_json, '$.wasteQty'), 0) > 0`;
}

function manufacturingWastageRepairSql() {
  return `UPDATE stock_movements
      SET quantity_delta = 0,
          value_delta = CASE
            WHEN COALESCE(value_delta, 0) <> 0 THEN -ABS(value_delta)
            ELSE -ABS(COALESCE(json_extract(metadata_json, '$.wastageQty'), json_extract(metadata_json, '$.wasteQty'), 0) * COALESCE(unit_cost, 0))
          END,
          metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.accountingOnly', 1, '$.normalisedByBackfill', 1)
    WHERE workspace_id = ?1 AND movement_type = 'manufacturing_wastage' AND COALESCE(quantity_delta, 0) <> 0
      AND COALESCE(json_extract(metadata_json, '$.wastageQty'), json_extract(metadata_json, '$.wasteQty'), 0) > 0`;
}

function stockTakeVarianceMissingSql() {
  return `SELECT stcl.id FROM stocktake_count_lines stcl
    JOIN stocktake_sessions sts ON sts.id = stcl.stocktake_session_id AND sts.workspace_id = stcl.workspace_id
   WHERE stcl.workspace_id = ?1 AND COALESCE(stcl.variance_qty, 0) <> 0
     AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = stcl.workspace_id AND sm.document_type = 'stock_take' AND sm.document_id = stcl.stocktake_session_id AND sm.stock_item_id = stcl.stock_item_id AND sm.location_id = stcl.location_id)`;
}

function stockTakeVarianceBackfillSql() {
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_stocktake_' || stcl.id, stcl.workspace_id, stcl.stock_item_id, stcl.location_id, 'stock_take_variance', 'stock_take', stcl.stocktake_session_id,
           stcl.variance_qty, stcl.unit_cost, stcl.variance_qty * stcl.unit_cost, COALESCE(sts.counted_at, sts.created_at), sts.created_by,
           json_object('backfilled', 1, 'sourceLineId', stcl.id, 'expectedQty', stcl.expected_qty, 'countedQty', stcl.counted_qty), datetime('now')
      FROM stocktake_count_lines stcl
      JOIN stocktake_sessions sts ON sts.id = stcl.stocktake_session_id AND sts.workspace_id = stcl.workspace_id
     WHERE stcl.workspace_id = ?1 AND COALESCE(stcl.variance_qty, 0) <> 0
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = stcl.workspace_id AND sm.document_type = 'stock_take' AND sm.document_id = stcl.stocktake_session_id AND sm.stock_item_id = stcl.stock_item_id AND sm.location_id = stcl.location_id)`;
}

function transferMissingSql(direction: "out" | "in") {
  const loc = direction === "out" ? "t.from_location_id" : "t.to_location_id";
  const movement = direction === "out" ? "transfer_out" : "transfer_in";
  return `SELECT tl.id FROM transfer_lines tl
    JOIN transfers t ON t.id = tl.transfer_id AND t.workspace_id = tl.workspace_id
   WHERE tl.workspace_id = ?1 AND COALESCE(tl.quantity, 0) <> 0 AND COALESCE(${loc}, '') <> ''
     AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = tl.workspace_id AND sm.document_type = 'transfer' AND sm.document_id = tl.transfer_id AND sm.stock_item_id = tl.stock_item_id AND sm.location_id = ${loc} AND sm.movement_type = '${movement}')`;
}

function transferOutBackfillSql() {
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, source_location_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_transfer_out_' || tl.id, tl.workspace_id, tl.stock_item_id, t.from_location_id, 'transfer_out', 'transfer', tl.transfer_id, t.from_location_id, t.to_location_id,
           -ABS(tl.quantity), tl.unit_cost, -ABS(tl.quantity * tl.unit_cost), COALESCE(t.requested_at, t.accepted_at), t.created_by, json_object('backfilled', 1, 'sourceLineId', tl.id), datetime('now')
      FROM transfer_lines tl JOIN transfers t ON t.id = tl.transfer_id AND t.workspace_id = tl.workspace_id
     WHERE tl.workspace_id = ?1 AND COALESCE(tl.quantity, 0) <> 0 AND COALESCE(t.from_location_id, '') <> ''
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = tl.workspace_id AND sm.document_type = 'transfer' AND sm.document_id = tl.transfer_id AND sm.stock_item_id = tl.stock_item_id AND sm.location_id = t.from_location_id AND sm.movement_type = 'transfer_out')`;
}

function transferInBackfillSql() {
  return `INSERT OR IGNORE INTO stock_movements
    (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, source_location_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
    SELECT 'bf_transfer_in_' || tl.id, tl.workspace_id, tl.stock_item_id, t.to_location_id, 'transfer_in', 'transfer', tl.transfer_id, t.from_location_id, t.to_location_id,
           ABS(tl.quantity), tl.unit_cost, ABS(tl.quantity * tl.unit_cost), COALESCE(t.accepted_at, t.requested_at), t.created_by, json_object('backfilled', 1, 'sourceLineId', tl.id), datetime('now')
      FROM transfer_lines tl JOIN transfers t ON t.id = tl.transfer_id AND t.workspace_id = tl.workspace_id
     WHERE tl.workspace_id = ?1 AND COALESCE(tl.quantity, 0) <> 0 AND COALESCE(t.to_location_id, '') <> ''
       AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = tl.workspace_id AND sm.document_type = 'transfer' AND sm.document_id = tl.transfer_id AND sm.stock_item_id = tl.stock_item_id AND sm.location_id = t.to_location_id AND sm.movement_type = 'transfer_in')`;
}

function saleUsageMissingSql() {
  return `SELECT id FROM yoco_orders yo
   WHERE yo.workspace_id = ?1
     AND EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = yo.workspace_id AND sm.document_type = \'yoco_order\' AND sm.document_id = yo.id AND sm.movement_type IN ('sale_depletion', 'sale_refund'))
     AND 0`;
}

function modifierUsageMissingSql() {
  return `SELECT id FROM yoco_orders yo
   WHERE yo.workspace_id = ?1
     AND EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.workspace_id = yo.workspace_id AND sm.document_type = \'yoco_order\' AND sm.document_id = yo.id AND sm.metadata_json LIKE '%modifier%')
     AND 0`;
}

function buildStockTakeWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  timeZone: string,
) {
  const clauses = ["stcl.workspace_id = ?1"];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace("?", `?${binds.length}`));
  };
  addZonedDateRange(clauses, binds, "sts.counted_at", filters, timeZone);
  addLocationSqlScope(clauses, binds, "stcl.location_id", filters);
  if (filters.itemId) add("stcl.stock_item_id = ?", filters.itemId);
  if (filters.categoryId) add("si.category = ?", filters.categoryId);
  if (filters.category) add("lower(si.category) = lower(?)", filters.category);
  // Time filtering is applied after timestamps have been converted to the workspace
  // timezone. Filtering the stored UTC string here caused Johannesburg 10:00 rows
  // to be compared as 08:00 and produced inconsistent report results.
  if (filters.search) {
    binds.push(`%${filters.search.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(`(
      lower(COALESCE(si.name, '')) LIKE ?${idx}
      OR lower(COALESCE(si.category, '')) LIKE ?${idx}
      OR lower(COALESCE(l.name, '')) LIKE ?${idx}
      OR lower(COALESCE(l.display_name, '')) LIKE ?${idx}
      OR lower(COALESCE(sts.id, '')) LIKE ?${idx}
      OR lower(COALESCE(sts.status, '')) LIKE ?${idx}
      OR lower(COALESCE(sts.raw_json, '')) LIKE ?${idx}
    )`);
  }
  return { whereSql: clauses.join(" AND "), binds };
}

function standardizeStockTakeAuditRow(
  row: Row,
  actorMap: Map<string, { name: string; email: string }>,
  timeZone: string,
  tradingDayStartMinutes = 0,
) {
  const sessionRaw = parseJson(row.session_raw_json);
  const expectedQty = numberValue(row.expected_qty, 0);
  const countedQty = numberValue(row.counted_qty, 0);
  const varianceQty = hasMeaningfulValue(row.variance_qty)
    ? numberValue(row.variance_qty, 0)
    : countedQty - expectedQty;
  const unitCostExVat =
    numberValue(row.unit_cost, 0) || numberValue(row.stock_unit_cost, 0);
  const expectedValue = expectedQty * unitCostExVat;
  const countedValue = countedQty * unitCostExVat;
  const varianceValue = countedValue - expectedValue;
  const actor = actorMap.get(clean(row.created_by));
  const sourceId = clean(row.stocktake_session_id);
  const locationName = clean(row.location_display_name || row.location_name);
  const committedByName = clean(actor?.name || actor?.email || row.created_by);
  const rawLine = resolveStockTakeLineRaw(
    sessionRaw,
    clean(row.stock_item_id),
  );
  const uomBreakdownRows = normalizeStockTakeAuditUomBreakdown(
    rawLine.uomCounts || rawLine.scanBreakdown,
    clean(row.base_uom || "ea"),
  );
  const enteredQty = uomBreakdownRows.length
    ? uomBreakdownRows.reduce(
        (sum, entry) => sum + numberValue(entry.count, 0),
        0,
      )
    : numberValue(
        rawLine.enteredQty ?? rawLine.shelfCount ?? rawLine.countedQty,
        countedQty,
      );
  const countedUom = uomBreakdownRows.length > 1
    ? "Mixed UOMs"
    : clean(
        uomBreakdownRows[0]?.uomName ||
          rawLine.selectedUom ||
          rawLine.unit ||
          row.base_uom ||
          "ea",
      );
  const uomBreakdown = uomBreakdownRows
    .map(
      (entry) =>
        `${numberValue(entry.count)} ${clean(entry.uomName)} × ${numberValue(entry.ratio, 1)}`,
    )
    .join(" + ");
  const lineNote = clean(rawLine.note || rawLine.notes || sessionRaw.note);
  const countedAt = resolveReportTimestamp(
    row.counted_at,
    row.session_created_at,
    timeZone,
  );
  const local = zonedTradingDateTimeStrings(countedAt, timeZone, tradingDayStartMinutes);

  return {
    id: clean(row.id),
    workspaceId: clean(row.workspace_id),
    stockTakeSessionId: sourceId,
    sourceId,
    stockTakeDate: local.date,
    stockTakeTime: local.time,
    reportingTimeZone: local.timeZone || timeZone,
    locationId: clean(row.location_id),
    locationName,
    status: clean(row.status || "posted"),
    itemId: clean(row.stock_item_id),
    itemName: clean(row.item_name),
    category: clean(row.category_name) || "General",
    itemType: clean(row.item_type),
    isStocked: numberValue(row.is_stocked, 1),
    countedUom,
    enteredQty,
    uomBreakdown,
    countedQty,
    convertedBaseQty: countedQty,
    expectedBaseQty: expectedQty,
    expectedQty,
    varianceQty,
    varianceBaseQty: varianceQty,
    baseUom: clean(row.base_uom || "ea"),
    uomRatio:
      uomBreakdownRows.length === 1
        ? numberValue(uomBreakdownRows[0]?.ratio, 1)
        : 1,
    unitCostExVat,
    expectedValue,
    countedValue,
    varianceValue,
    countedAt,
    committedBy: committedByName,
    committedByName,
    committedAt: clean(
      row.session_updated_at || row.counted_at || row.session_created_at,
    ),
    user: committedByName,
    notes: clean(lineNote || sessionRaw.note),
    ledgerNetQty: numberValue(row.ledger_net_qty, 0),
    ledgerMovementValue: numberValue(row.ledger_movement_value, 0),
    ledgerRowCount: numberValue(row.ledger_row_count, 0),
    varianceMovementRowCount: numberValue(row.variance_movement_row_count, 0),
    raw: {
      stockTakeLine: row,
      session: sessionRaw,
    },
  };
}

function resolveStockTakeLineRaw(sessionRaw: Row, stockItemId = ""): Row {
  const items = Array.isArray(sessionRaw.items) ? sessionRaw.items : [];
  return (
    items.find(
      (item: Row) => clean(item.stockItemId || item.id) === stockItemId,
    ) || {}
  );
}

function normalizeStockTakeAuditUomBreakdown(
  value: unknown,
  baseUom = "ea",
): Row[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value as Row).map(([key, count]) => ({
          key,
          uomName: key === "base" ? "Base UOM" : key,
          count,
          ratio: 1,
        }))
      : [];
  return rows
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Row)
        : {},
    )
    .map((entry) => {
      const rawUomName = clean(
        entry.uomName || entry.selectedUom || entry.unit || entry.key,
      );
      const uomName = ["base", "base uom"].includes(rawUomName.toLowerCase())
        ? clean(entry.baseUom || entry.baseUnit || baseUom)
        : rawUomName;
      return {
      uomName,
      ratio:
        numberValue(
          entry.ratio ?? entry.qtyInBase ?? entry.qty_in_base ?? entry.packSize,
          1,
        ) || 1,
      count: numberValue(
        entry.count ?? entry.quantity ?? entry.qty ?? entry.scans,
        0,
      ),
      };
    })
    .filter((entry) => entry.uomName && numberValue(entry.count) > 0);
}

function buildSalesWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  tableStatus: Record<string, boolean>,
  timeZone: string,
) {
  const clauses = ["yo.workspace_id = ?1"];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  addZonedDateRange(clauses, binds, "yo.occurred_at", filters, timeZone);
  addLocationSqlScope(clauses, binds, "yo.location_id", filters);
  if (filters.paymentMethod)
    add(
      "lower(CASE WHEN lower(COALESCE(yo.order_type, '')) = 'refund' THEN COALESCE(NULLIF(CASE WHEN lower(COALESCE(yo.payment_method, '')) NOT IN ('', 'refund') THEN yo.payment_method ELSE '' END, ''), NULLIF(parent_yo.payment_method, ''), 'Unknown') ELSE COALESCE(NULLIF(yo.payment_method, ''), 'Unknown') END) = lower(?)",
      filters.paymentMethod,
    );
  if (filters.status)
    add("lower(COALESCE(yo.status, '')) = lower(?)", filters.status);
  if (filters.receiptNumber) {
    binds.push(`%${filters.receiptNumber.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(
      `(lower(COALESCE(yo.parent_yoco_order_id, yo.yoco_order_id, '')) LIKE ?${idx} OR lower(COALESCE(yo.provider_refund_id, '')) LIKE ?${idx} OR lower(COALESCE(yo.yoco_payment_id, '')) LIKE ?${idx} OR lower(COALESCE(yo.id, '')) LIKE ?${idx})`,
    );
  }
  if (filters.menuItemId && tableStatus.yoco_order_lines)
    add(
      "EXISTS (SELECT 1 FROM yoco_order_lines yol_filter WHERE yol_filter.workspace_id = yo.workspace_id AND yol_filter.yoco_order_id = yo.id AND yol_filter.product_id = ?)",
      filters.menuItemId,
    );
  if (
    filters.categoryId &&
    tableStatus.yoco_order_lines &&
    tableStatus.products
  )
    add(
      "EXISTS (SELECT 1 FROM yoco_order_lines yol_filter JOIN products p_filter ON p_filter.id = yol_filter.product_id AND p_filter.workspace_id = yol_filter.workspace_id WHERE yol_filter.workspace_id = yo.workspace_id AND yol_filter.yoco_order_id = yo.id AND lower(COALESCE(p_filter.category, '')) = lower(?))",
      filters.categoryId,
    );
  if (
    filters.menuCategory &&
    tableStatus.yoco_order_lines &&
    tableStatus.products
  )
    add(
      "EXISTS (SELECT 1 FROM yoco_order_lines yol_filter JOIN products p_filter ON p_filter.id = yol_filter.product_id AND p_filter.workspace_id = yol_filter.workspace_id WHERE yol_filter.workspace_id = yo.workspace_id AND yol_filter.yoco_order_id = yo.id AND lower(COALESCE(p_filter.category, '')) = lower(?))",
      filters.menuCategory,
    );
  if (filters.inventoryItemId && tableStatus.stock_movements)
    add(
      "EXISTS (SELECT 1 FROM stock_movements sm_filter WHERE sm_filter.workspace_id = yo.workspace_id AND sm_filter.document_type = 'yoco_order' AND COALESCE(NULLIF(json_extract(sm_filter.metadata_json, '$.reportOrderKey'), ''), sm_filter.document_id) = yo.yoco_order_id AND sm_filter.stock_item_id = ?)",
      filters.inventoryItemId,
    );
  if (
    filters.inventoryCategory &&
    tableStatus.stock_movements &&
    tableStatus.stock_items
  )
    add(
      "EXISTS (SELECT 1 FROM stock_movements sm_filter JOIN stock_items si_filter ON si_filter.id = sm_filter.stock_item_id AND si_filter.workspace_id = sm_filter.workspace_id WHERE sm_filter.workspace_id = yo.workspace_id AND sm_filter.document_type = 'yoco_order' AND COALESCE(NULLIF(json_extract(sm_filter.metadata_json, '$.reportOrderKey'), ''), sm_filter.document_id) = yo.yoco_order_id AND lower(COALESCE(si_filter.category, '')) = lower(?))",
      filters.inventoryCategory,
    );
  if (filters.modifierGroupId && tableStatus.stock_movements)
    add(
      "EXISTS (SELECT 1 FROM stock_movements sm_filter WHERE sm_filter.workspace_id = yo.workspace_id AND sm_filter.document_type = 'yoco_order' AND COALESCE(NULLIF(json_extract(sm_filter.metadata_json, '$.reportOrderKey'), ''), sm_filter.document_id) = yo.yoco_order_id AND json_extract(sm_filter.metadata_json, '$.modifierGroupId') = ?)",
      filters.modifierGroupId,
    );
  if (filters.modifierId && tableStatus.stock_movements)
    add(
      "EXISTS (SELECT 1 FROM stock_movements sm_filter WHERE sm_filter.workspace_id = yo.workspace_id AND sm_filter.document_type = 'yoco_order' AND COALESCE(NULLIF(json_extract(sm_filter.metadata_json, '$.reportOrderKey'), ''), sm_filter.document_id) = yo.yoco_order_id AND json_extract(sm_filter.metadata_json, '$.modifierId') = ?)",
      filters.modifierId,
    );
  if (filters.search) {
    binds.push(`%${filters.search.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(`(
      lower(COALESCE(yo.yoco_order_id, '')) LIKE ?${idx}
      OR lower(COALESCE(yo.yoco_payment_id, '')) LIKE ?${idx}
      OR lower(COALESCE(yo.payment_method, '')) LIKE ?${idx}
      OR lower(COALESCE(yo.status, '')) LIKE ?${idx}
      OR lower(COALESCE(l.name, '')) LIKE ?${idx}
      OR lower(COALESCE(l.display_name, '')) LIKE ?${idx}
      OR lower(COALESCE(yo.raw_json, '')) LIKE ?${idx}
    )`);
  }
  return { whereSql: clauses.join(" AND "), binds };
}

function buildSaleUsageWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  tableStatus: Record<string, boolean>,
  sourceScope: "all" | "modifier",
  timeZone: string,
) {
  const clauses = [
    "sm.workspace_id = ?1",
    "sm.document_type = 'yoco_order'",
    "(sm.movement_type IN ('sale_depletion', 'sale_refund') OR (sm.movement_type = 'wastage' AND json_extract(sm.metadata_json, '$.mode') = 'refund'))",
  ];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  if (sourceScope === "modifier")
    clauses.push(
      `(
        lower(COALESCE(json_extract(sm.metadata_json, '$.componentType'), json_extract(sm.metadata_json, '$.component_type'), '')) = 'modifier'
        OR NULLIF(COALESCE(json_extract(sm.metadata_json, '$.modifierId'), json_extract(sm.metadata_json, '$.modifier_id'), json_extract(sm.metadata_json, '$.modifierName'), json_extract(sm.metadata_json, '$.modifier_name'), ''), '') IS NOT NULL
      )`,
    );
  addZonedDateRange(clauses, binds, "sm.occurred_at", filters, timeZone);
  addLocationSqlScope(clauses, binds, "sm.location_id", filters);
  if (filters.inventoryItemId || filters.itemId)
    add("sm.stock_item_id = ?", filters.inventoryItemId || filters.itemId);
  if (filters.categoryId)
    add("lower(COALESCE(si.category, '')) = lower(?)", filters.categoryId);
  if (filters.category)
    add("lower(COALESCE(si.category, '')) = lower(?)", filters.category);
  if (filters.inventoryCategory)
    add(
      "lower(COALESCE(si.category, '')) = lower(?)",
      filters.inventoryCategory,
    );
  if (filters.paymentMethod && tableStatus.yoco_orders)
    add(
      "lower(COALESCE(yo.payment_method, '')) = lower(?)",
      filters.paymentMethod,
    );
  if (filters.status && tableStatus.yoco_orders)
    add("lower(COALESCE(yo.status, '')) = lower(?)", filters.status);
  if (filters.receiptNumber && tableStatus.yoco_orders) {
    binds.push(`%${filters.receiptNumber.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(
      `(lower(COALESCE(yo.yoco_order_id, '')) LIKE ?${idx} OR lower(COALESCE(yo.yoco_payment_id, '')) LIKE ?${idx} OR lower(COALESCE(sm.document_id, '')) LIKE ?${idx})`,
    );
  }
  if (filters.menuCategory && tableStatus.products)
    add("lower(COALESCE(p.category, '')) = lower(?)", filters.menuCategory);
  if (filters.menuItemId) {
    binds.push(filters.menuItemId);
    const idx = binds.length;
    clauses.push(
      `(COALESCE(json_extract(sm.metadata_json, '$.productId'), json_extract(sm.metadata_json, '$.product_id'), json_extract(sm.metadata_json, '$.menuItemId'), json_extract(sm.metadata_json, '$.menu_item_id')) = ?${idx} OR COALESCE(json_extract(sm.metadata_json, '$.parentProductId'), json_extract(sm.metadata_json, '$.parent_product_id')) = ?${idx})`,
    );
  }
  if (filters.modifierGroupId)
    add(
      "COALESCE(json_extract(sm.metadata_json, '$.modifierGroupId'), json_extract(sm.metadata_json, '$.modifier_group_id')) = ?",
      filters.modifierGroupId,
    );
  if (filters.modifierId)
    add(
      "COALESCE(json_extract(sm.metadata_json, '$.sourceModifierId'), json_extract(sm.metadata_json, '$.source_modifier_id'), json_extract(sm.metadata_json, '$.modifierId'), json_extract(sm.metadata_json, '$.modifier_id')) = ?",
      filters.modifierId,
    );
  if (filters.sourceType) {
    const source = clean(filters.sourceType).toLowerCase();
    if (source.includes("modifier"))
      clauses.push(
        `(
          lower(COALESCE(json_extract(sm.metadata_json, '$.componentType'), json_extract(sm.metadata_json, '$.component_type'), '')) = 'modifier'
          OR NULLIF(COALESCE(json_extract(sm.metadata_json, '$.modifierId'), json_extract(sm.metadata_json, '$.modifier_id'), json_extract(sm.metadata_json, '$.modifierName'), json_extract(sm.metadata_json, '$.modifier_name'), ''), '') IS NOT NULL
        )`,
      );
    if (source.includes("sale"))
      clauses.push(
        `NOT (
          lower(COALESCE(json_extract(sm.metadata_json, '$.componentType'), json_extract(sm.metadata_json, '$.component_type'), '')) = 'modifier'
          OR NULLIF(COALESCE(json_extract(sm.metadata_json, '$.modifierId'), json_extract(sm.metadata_json, '$.modifier_id'), json_extract(sm.metadata_json, '$.modifierName'), json_extract(sm.metadata_json, '$.modifier_name'), ''), '') IS NOT NULL
        )`,
      );
  }
  if (filters.search) {
    binds.push(`%${filters.search.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(`(
      lower(COALESCE(si.name, '')) LIKE ?${idx}
      OR lower(COALESCE(si.category, '')) LIKE ?${idx}
      OR lower(COALESCE(l.name, '')) LIKE ?${idx}
      OR lower(COALESCE(l.display_name, '')) LIKE ?${idx}
      OR lower(COALESCE(yo.yoco_order_id, '')) LIKE ?${idx}
      OR lower(COALESCE(yo.yoco_payment_id, '')) LIKE ?${idx}
      OR lower(COALESCE(yol.name, '')) LIKE ?${idx}
      OR lower(COALESCE(sm.metadata_json, '')) LIKE ?${idx}
    )`);
  }
  return { whereSql: clauses.join(" AND "), binds };
}

function standardizeSalesFinancialRow(
  row: Row,
  warnings: Array<{ code: string; level: string; message: string }>,
  timeZone: string,
  tradingDayStartMinutes = 0,
) {
  const raw = parseJson(row.raw_json);
  const kcpRefund = reportRowObject(raw.kcpRefund);
  const financials = deriveYocoFinancialAmounts({
    raw,
    persistedTotal: row.total,
    persistedGrossTotal: row.gross_total,
    persistedVatTotal: row.vat_total,
    persistedNetTotal: row.net_total,
    configuredVatRate: row.vat_rate,
    orderType: row.order_type,
    status: row.status,
  });
  const locationName = clean(row.location_display_name || row.location_name);
  const saleAt = clean(row.occurred_at || row.created_at);
  const local = zonedTradingDateTimeStrings(saleAt, timeZone, tradingDayStartMinutes);

  for (const issue of financials.issues || []) {
    warnings.push({
      code: clean(issue.code),
      level: clean(issue.level || "warning"),
      message: clean(issue.message),
    });
  }
  if (!local.date || !local.time) {
    warnings.push({
      code: "sales-invalid-timestamp",
      level: "critical",
      message:
        "A Yoco sale has an invalid transaction timestamp and cannot be placed in the correct local reporting period.",
    });
  }

  return {
    id: clean(row.id),
    workspaceId: clean(row.workspace_id),
    locationId: clean(row.location_id),
    locationName,
    saleDate: local.date,
    saleTime: local.time,
    occurredAt: saleAt,
    reportingTimeZone: local.timeZone || timeZone,
    receiptNumber: clean(row.parent_yoco_order_id || kcpRefund.originalOrderId || row.yoco_order_id || row.yoco_payment_id || row.id),
    refundId: clean(row.provider_refund_id || kcpRefund.refundId),
    refundReason: clean(row.refund_reason || kcpRefund.reason),
    refundHandling: clean(row.refund_behavior || kcpRefund.behavior).toLowerCase() === 'wastage'
      ? 'Scrap / Wastage'
      : clean(row.order_type).toLowerCase() === 'refund' ? 'Returned to Stock' : '',
    refundBehavior: clean(row.refund_behavior || kcpRefund.behavior),
    paymentMethod: clean((clean(row.order_type).toLowerCase() === 'refund' && clean(row.payment_method).toLowerCase() === 'refund' ? row.original_payment_method : row.payment_method) || row.original_payment_method || "Unknown"),
    status: clean(row.status || row.order_type || "completed"),
    grossAmount: financials.grossAmount,
    vatAmount: financials.vatAmount,
    netAmount: financials.netAmount,
    discountAmount: financials.discountAmount,
    refundAmount: financials.refundAmount,
    refundGrossAmount: financials.refundGrossAmount,
    refundVatAmount: financials.refundVatAmount,
    refundNetAmount: financials.refundNetAmount,
    tipAmount: financials.tipAmount,
    feeAmount: financials.feeAmount,
    payoutAmount: financials.payoutAmount,
    vatRate: financials.vatRate,
    vatSource: financials.vatSource,
    isVatExempt: financials.isVatExempt,
    financialDiagnostics: financials.diagnostics,
    createdBy: "yoco",
    sourceId: clean(row.provider_refund_id || row.yoco_order_id || row.id),
    raw: { order: row, parsed: raw, financials },
  };
}

function standardizeSaleStockUsageRow(
  row: Row,
  warnings: Array<{ code: string; level: string; message: string }>,
  timeZone: string,
  tradingDayStartMinutes = 0,
) {
  const metadata = parseJson(row.metadata_json);
  const orderRaw = parseJson(row.order_raw_json);
  const lineRaw = parseJson(row.line_raw_json);
  const componentType = movementComponentType(metadata);
  const sourceType =
    componentType === "modifier" ? "Modifier Usage" : "Sale Usage";
  const physicalQuantityDelta = numberValue(row.quantity_delta, 0);
  const movementType = clean(row.movement_type).toLowerCase();
  const isRefundMovement = clean(metadata.mode).toLowerCase() === 'refund' || movementType === 'sale_refund';
  const isRefundWastage = isRefundMovement && (
    movementType === 'wastage' || clean(metadata.returnBehavior).toLowerCase() === 'wastage'
  );
  // Usage is the inverse of the physical balance delta: a sale deduction is positive
  // usage, a returned item is negative usage, and accounting-only scrap has zero
  // physical impact because the original sale deduction already remains in force.
  const qtyUsed = isRefundWastage ? 0 : -physicalQuantityDelta;
  const unitCostExVat = numberValue(row.unit_cost, 0);
  const movementValue = hasMeaningfulValue(row.value_delta)
    ? numberValue(row.value_delta, 0)
    : physicalQuantityDelta * unitCostExVat;
  // A GRV edit that fixes a mistaken cost after this sale already happened writes a compensating
  // 'cost_correction' stock_movements row keyed back to this sale's id (see
  // buildSameDayCostCorrectionStatements in routes.ts) rather than mutating this row in place. The
  // query above already selects it summed via COST_CORRECTION_VALUE_DELTA_SQL — fold it in here,
  // the same way signedMovementStockCost does for other reports, or a corrected sale keeps showing
  // its stale pre-correction value forever in this one.
  const costCorrectionValue = numberValue(row.cost_correction_value_delta, 0);
  const stockValueUsed = isRefundWastage ? 0 : -(movementValue + costCorrectionValue);
  const wastageQty = isRefundWastage
    ? Math.abs(numberValue(metadata.wastageQty || metadata.wasteQty || metadata.wastage_quantity, 0))
    : 0;
  const lineFinancialSource =
    componentType === "modifier"
      ? objectFromUnknown(lineRaw.kcpModifier || lineRaw.modifier || lineRaw)
      : lineRaw;
  const lineFinancials = deriveYocoFinancialAmounts({
    raw: lineFinancialSource,
    persistedTotal: row.line_total,
    configuredVatRate: row.vat_rate,
    status: row.sale_status,
  });
  const lineGross = lineFinancials.grossAmount;
  const vatRate = lineFinancials.vatRate;
  const vatAmount = lineFinancials.vatAmount;
  const netSaleAmount = lineFinancials.netAmount;
  const saleAt = clean(row.occurred_at || row.created_at);
  const local = zonedTradingDateTimeStrings(saleAt, timeZone, tradingDayStartMinutes);
  const modifierId = movementModifierId(row, metadata);
  const modifierGroupId = movementModifierGroupId(metadata);

  for (const issue of lineFinancials.issues || []) {
    warnings.push({
      code: clean(issue.code),
      level: clean(issue.level || "warning"),
      message: clean(issue.message),
    });
  }
  if (!clean(row.stock_item_id))
    warnings.push({
      code: "missing-ingredient-stock-item",
      level: "critical",
      message: "A sale usage movement is missing its stock item id.",
    });
  if (!unitCostExVat && (qtyUsed || wastageQty))
    warnings.push({
      code: "missing-unit-cost",
      level: "critical",
      message: "A sale usage movement is missing unit cost.",
    });

  return {
    id: clean(row.id),
    workspaceId: clean(row.workspace_id),
    locationId: clean(row.location_id),
    locationName: clean(row.location_display_name || row.location_name),
    saleDate: local.date,
    saleTime: local.time,
    occurredAt: saleAt,
    reportingTimeZone: local.timeZone || timeZone,
    receiptNumber: clean(
      row.parent_yoco_order_id || metadata.orderId || metadata.order_id || row.yoco_order_id || row.yoco_payment_id || row.document_id,
    ),
    saleId: clean(row.provider_refund_id || row.yoco_order_id || row.document_id),
    refundId: clean(row.provider_refund_id || metadata.refundId),
    refundReason: clean(row.refund_reason || metadata.refundReason),
    refundHandling: clean(row.refund_behavior || metadata.returnBehavior).toLowerCase() === 'wastage'
      ? 'Scrap / Wastage'
      : isRefundMovement ? 'Returned to Stock' : '',
    refundBehavior: clean(row.refund_behavior || metadata.returnBehavior),
    stockMovementType: isRefundWastage ? 'Refund Scrap' : isRefundMovement ? 'Refund Return' : 'Sale Depletion',
    stockQuantityChange: physicalQuantityDelta,
    wastageQty,
    accountingOnly: isRefundWastage || metadata.accountingOnly === true || numberValue(metadata.accountingOnly, 0) === 1,
    saleLineId: clean(
      row.yoco_line_id || movementLineId(metadata),
    ),
    menuItemId:
      sourceType === "Modifier Usage"
        ? clean(metadata.parentProductId || metadata.parent_product_id || metadata.menuItemId || metadata.menu_item_id || row.line_product_id)
        : clean(metadata.productId || metadata.product_id || metadata.menuItemId || metadata.menu_item_id || row.line_product_id),
    menuItemName:
      sourceType === "Modifier Usage"
        ? clean(metadata.parentProductName || metadata.parent_product_name || metadata.productName || metadata.product_name || row.line_name || row.product_name || orderRaw.display_name || orderRaw.displayName)
        : clean(metadata.productName || metadata.parentProductName || row.line_name || metadata.product_name || metadata.parent_product_name || row.product_name || orderRaw.display_name || orderRaw.displayName),
    menuCategory: clean(row.product_category),
    qtySold: isRefundMovement
      ? -Math.abs(numberValue(row.line_quantity, 1) || 1)
      : Math.abs(numberValue(row.line_quantity, 1)) || 1,
    recipeLineType:
      sourceType === "Modifier Usage"
        ? "Modifier Ingredient"
        : clean(metadata.recipeOwnerType).toLowerCase() === "stock_item"
          ? "Sub-Recipe Ingredient"
          : metadata.recipeSourceStockItemId
            ? "Stock-Holding Prep Item"
            : "Direct Ingredient",
    recipeName: clean(
      metadata.recipeOwnerId || metadata.productName || row.product_name,
    ),
    recipeLevel:
      clean(metadata.recipeOwnerType).toLowerCase() === "stock_item"
        ? "Level 2"
        : "Level 1",
    parentRecipe: clean(
      metadata.parentProductName || metadata.productName || row.product_name,
    ),
    ingredientQtyPerSale:
      Math.abs(numberValue(row.line_quantity, 1)) || 1
        ? qtyUsed / (Math.abs(numberValue(row.line_quantity, 1)) || 1)
        : qtyUsed,
    totalQtyUsed: qtyUsed,
    modifierGroupId,
    modifierGroupName: movementModifierGroupName(metadata),
    modifierId,
    modifierName: movementModifierName(row, metadata),
    inventoryItemId: clean(row.stock_item_id),
    inventoryItemName: clean(row.item_name || metadata.stockItemName),
    inventoryCategoryId: clean(row.category_name || metadata.stockCategory),
    inventoryCategoryName:
      clean(row.category_name || metadata.stockCategory) || "General",
    sourceType,
    sourceId: clean(row.document_id || row.id),
    qtyUsed,
    baseUom: movementBaseUom(row, metadata),
    unitCostExVat,
    stockValueUsed,
    grossSaleAmount: lineGross,
    vatAmount,
    netSaleAmount,
    vatRate,
    vatSource: lineFinancials.vatSource,
    isVatExempt: lineFinancials.isVatExempt,
    financialDiagnostics: lineFinancials.diagnostics,
    createdBy: clean(row.created_by || "yoco"),
    raw: {
      movement: row,
      metadata,
      order: orderRaw,
      line: lineRaw,
      financials: lineFinancials,
    },
  };
}

function addSalesFinancialWarnings(
  rows: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  count(
    rows,
    (row) => !clean(row.receiptNumber),
    "missing-receipt-number",
    "warning",
    "Sales rows are missing receipt numbers.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.paymentMethod),
    "missing-payment-method",
    "warning",
    "Sales rows are missing payment methods.",
    warnings,
  );
  count(
    rows,
    (row) =>
      numberValue(row.grossAmount, 0) > 0 &&
      numberValue(row.vatRate, 0) > 0 &&
      numberValue(row.vatAmount, 0) === 0 &&
      !booleanValue(row.isVatExempt),
    "missing-vat-amount",
    "critical",
    "VAT-bearing sale rows have no VAT amount.",
    warnings,
  );
}

function addSaleStockUsageWarnings(
  rows: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
  sourceScope: "all" | "modifier",
) {
  count(
    rows,
    (row) => !clean(row.saleId),
    "missing-sale-id",
    "critical",
    "Usage rows are missing sale IDs.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.receiptNumber),
    "missing-receipt-number",
    "warning",
    "Usage rows are missing receipt numbers.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.inventoryItemId),
    "missing-ingredient-stock-item",
    "critical",
    "Usage rows are missing ingredient stock items.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.baseUom),
    "missing-uom-conversion",
    "critical",
    "Usage rows are missing base UOM.",
    warnings,
  );
  count(
    rows,
    (row) =>
      numberValue(row.unitCostExVat, 0) === 0 &&
      numberValue(row.qtyUsed, 0) !== 0,
    "missing-unit-cost",
    "critical",
    "Usage rows have missing unit costs.",
    warnings,
  );
  if (sourceScope === "modifier") {
    count(
      rows,
      (row) => clean(row.sourceType) !== "Modifier Usage",
      "modifier-usage-source-mismatch",
      "warning",
      "Modifier usage endpoint returned non-modifier rows.",
      warnings,
    );
  }
}

function resolveRawMoney(raw: Row, paths: string[], fallback: number) {
  for (const path of paths) {
    const value = deepValue(raw, path);
    if (hasMeaningfulValue(value)) return Math.abs(numberValue(value, 0));
  }
  return fallback;
}

function deepValue(source: Row, path: string) {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    return (current as Row)[key];
  }, source);
}

function calculateVatAmount(gross: number, vatRate: number) {
  // A genuine, explicit 0 (a non-VAT-registered workspace) is authoritative and must not be
  // treated the same as "no rate supplied" — otherwise it would fall through to a fallback rate
  // and incorrectly show VAT for a business that isn't registered. Check the raw input for
  // strict equality to 0 BEFORE any coercion: numberValue(null) and numberValue(undefined) both
  // resolve to 0 too, so coercing first would misclassify a genuinely missing rate as "explicitly
  // zero" and wrongly suppress the fallback.
  const isExplicitZero = vatRate === 0 || (vatRate as unknown) === '0';
  if (isExplicitZero) return 0;
  const supplied = numberValue(vatRate, NaN);
  const resolved = supplied > 0 ? supplied : resolveYocoVatRate({}, supplied).value;
  const rate = resolved > 1 ? resolved / 100 : resolved;
  if (!gross || !rate) return 0;
  return roundMoneyNumber(gross - gross / (1 + rate));
}

function roundMoneyNumber(value: number) {
  return Math.round((numberValue(value, 0) + Number.EPSILON) * 100) / 100;
}

function buildModifierSalesWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  tableStatus: Record<string, boolean>,
  timeZone: string,
) {
  const clauses = ["yol.workspace_id = ?1"];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  addZonedDateRange(clauses, binds, "yo.occurred_at", filters, timeZone);
  addLocationSqlScope(clauses, binds, "yo.location_id", filters);
  if (filters.menuItemId) add("yol.product_id = ?", filters.menuItemId);
  if (filters.menuCategory && tableStatus.products)
    add("lower(COALESCE(p.category, '')) = lower(?)", filters.menuCategory);
  if (filters.paymentMethod)
    add(
      "lower(COALESCE(yo.payment_method, '')) = lower(?)",
      filters.paymentMethod,
    );
  if (filters.status)
    add("lower(COALESCE(yo.status, '')) = lower(?)", filters.status);
  if (filters.receiptNumber) {
    binds.push(`%${filters.receiptNumber.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(
      `(lower(COALESCE(yo.parent_yoco_order_id, yo.yoco_order_id, '')) LIKE ?${idx} OR lower(COALESCE(yo.provider_refund_id, '')) LIKE ?${idx} OR lower(COALESCE(yo.yoco_payment_id, '')) LIKE ?${idx} OR lower(COALESCE(yol.yoco_line_id, '')) LIKE ?${idx})`,
    );
  }
  if (filters.search) {
    binds.push(`%${filters.search.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(`(
      lower(COALESCE(yo.yoco_order_id, '')) LIKE ?${idx}
      OR lower(COALESCE(yo.yoco_payment_id, '')) LIKE ?${idx}
      OR lower(COALESCE(yol.name, '')) LIKE ?${idx}
      OR lower(COALESCE(p.name, '')) LIKE ?${idx}
      OR lower(COALESCE(p.category, '')) LIKE ?${idx}
      OR lower(COALESCE(l.name, '')) LIKE ?${idx}
      OR lower(COALESCE(l.display_name, '')) LIKE ?${idx}
      OR lower(COALESCE(yol.raw_json, '')) LIKE ?${idx}
    )`);
  }
  return { whereSql: clauses.join(" AND "), binds };
}

function buildModifierUsageOnlyWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  timeZone: string,
) {
  const clauses = [
    "sm.workspace_id = ?1",
    "sm.document_type = 'yoco_order'",
    "(sm.movement_type IN ('sale_depletion', 'sale_refund') OR (sm.movement_type = 'wastage' AND json_extract(sm.metadata_json, '$.mode') = 'refund'))",
    `(
      lower(COALESCE(
        json_extract(sm.metadata_json, '$.componentType'),
        json_extract(sm.metadata_json, '$.component_type'),
        ''
      )) = 'modifier'
      OR NULLIF(COALESCE(
        json_extract(sm.metadata_json, '$.modifierId'),
        json_extract(sm.metadata_json, '$.modifier_id'),
        json_extract(sm.metadata_json, '$.modifierName'),
        json_extract(sm.metadata_json, '$.modifier_name'),
        ''
      ), '') IS NOT NULL
    )`,
  ];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  addZonedDateRange(clauses, binds, "sm.occurred_at", filters, timeZone);
  addLocationSqlScope(clauses, binds, "sm.location_id", filters);
  if (filters.inventoryItemId || filters.itemId)
    add("sm.stock_item_id = ?", filters.inventoryItemId || filters.itemId);
  if (filters.modifierGroupId)
    add(
      "COALESCE(json_extract(sm.metadata_json, '$.modifierGroupId'), json_extract(sm.metadata_json, '$.modifier_group_id')) = ?",
      filters.modifierGroupId,
    );
  if (filters.modifierId)
    add(
      "COALESCE(json_extract(sm.metadata_json, '$.sourceModifierId'), json_extract(sm.metadata_json, '$.source_modifier_id'), json_extract(sm.metadata_json, '$.modifierId'), json_extract(sm.metadata_json, '$.modifier_id')) = ?",
      filters.modifierId,
    );
  if (filters.search) {
    binds.push(`%${filters.search.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(
      `(lower(COALESCE(sm.metadata_json, '')) LIKE ?${idx} OR lower(COALESCE(si.name, '')) LIKE ?${idx})`,
    );
  }
  return { whereSql: clauses.join(" AND "), binds };
}

function buildMenuItemUsageWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  timeZone: string,
) {
  const clauses = [
    "sm.workspace_id = ?1",
    "sm.document_type = 'yoco_order'",
    "(sm.movement_type IN ('sale_depletion', 'sale_refund') OR (sm.movement_type = 'wastage' AND json_extract(sm.metadata_json, '$.mode') = 'refund'))",
  ];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  addZonedDateRange(clauses, binds, "sm.occurred_at", filters, timeZone);
  addLocationSqlScope(clauses, binds, "sm.location_id", filters);
  return { whereSql: clauses.join(" AND "), binds };
}

async function loadModifierCatalogue(
  env: Env,
  workspaceId: string,
  includeRules = false,
  warnings: Array<{ code: string; level: string; message: string }> = [],
) {
  let rows: { results?: Row[] } = { results: [] };
  try {
    rows = await env.DB.prepare(
      `SELECT id, yoco_modifier_group_id, name, raw_json
         FROM yoco_modifier_groups
        WHERE workspace_id = ?1`,
    )
      .bind(workspaceId)
      .all<Row>();
  } catch (error) {
    warnings.push({
      code: "modifier-catalogue-unavailable",
      level: "warning",
      message: `Modifier catalogue enrichment was skipped: ${reportErrorMessage(error)}`,
    });
  }
  let rules: Row[] = [];
  if (includeRules) {
    try {
      const ruleRows = await env.DB.prepare(
        `SELECT modifier_owner_id, action_type, source_modifier_id,
                source_modifier_group_id, source_modifier_variant_id, source_name
           FROM modifier_rules
          WHERE workspace_id = ?1 AND status = 'active'`,
      )
        .bind(workspaceId)
        .all<Row>();
      rules = ruleRows.results || [];
    } catch (error) {
      warnings.push({
        code: "modifier-rule-enrichment-unavailable",
        level: "warning",
        message: `Modifier rule enrichment was skipped: ${reportErrorMessage(error)}`,
      });
    }
  }
  const catalogue = new Map<string, Row>();
  for (const group of rows.results || []) {
    const rawGroup = parseJson(group.raw_json);
    const groupId = clean(
      rawGroup.id || group.yoco_modifier_group_id || group.id,
    );
    const groupName = clean(rawGroup.name || group.name || "Modifier Group");
    for (const modifier of modifierOptionsFromGroup(rawGroup)) {
      const id = modifierIdentity(modifier);
      const variantId = modifierVariantIdentity(modifier);
      const name = modifierDisplayName(modifier, id || variantId || "Modifier");
      const type = normalizeModifierType(
        modifier.type ||
          modifier.kind ||
          modifier.modifier_type ||
          modifier.modifierType ||
          (variantId ? "product" : "option"),
      );
      const ownerCandidates = new Set(
        [
          groupId && id ? `${groupId}:${id}` : "",
          id,
          variantId ? `variant:${variantId}` : "",
          variantId,
          slug(name).replace(/-/g, "_"),
        ].filter(Boolean),
      );
      const normalizedName = clean(name).toLowerCase();
      const rule = rules.find((candidate) => {
        const ownerId = clean(candidate.modifier_owner_id);
        const sourceId = clean(candidate.source_modifier_id);
        const sourceVariantId = clean(candidate.source_modifier_variant_id);
        const sourceGroupId = clean(candidate.source_modifier_group_id);
        const sourceName = clean(candidate.source_name).toLowerCase();
        return (
          ownerCandidates.has(ownerId) ||
          Boolean(id && sourceId === id) ||
          Boolean(variantId && sourceVariantId === variantId) ||
          Boolean(
            normalizedName &&
              sourceName === normalizedName &&
              (!sourceGroupId || sourceGroupId === groupId),
          )
        );
      });
      const entry = {
        id,
        variantId,
        name,
        type,
        groupId,
        groupName,
        stockActionType: normalizeModifierStockAction(rule?.action_type),
        raw: modifier,
      };
      setModifierCatalogue(catalogue, id, entry);
      setModifierCatalogue(
        catalogue,
        variantId ? `variant:${variantId}` : "",
        entry,
      );
      setModifierCatalogue(
        catalogue,
        name ? `name:${clean(name).toLowerCase()}` : "",
        entry,
      );
      setModifierCatalogue(
        catalogue,
        groupId && name
          ? `group:${groupId}:name:${clean(name).toLowerCase()}`
          : "",
        entry,
      );
      setModifierCatalogue(
        catalogue,
        groupName && name
          ? `group-name:${clean(groupName).toLowerCase()}:name:${clean(name).toLowerCase()}`
          : "",
        entry,
      );
    }
  }
  return catalogue;
}

function setModifierCatalogue(map: Map<string, Row>, key: string, entry: Row) {
  const normalized = clean(key);
  if (normalized && !map.has(normalized)) map.set(normalized, entry);
}

function extractModifierSelectionsFromLine(
  row: Row,
  catalogue: Map<string, Row>,
) {
  const raw = parseJson(row.line_raw_json);
  const selections = extractRawLineModifiers(raw).map((modifier, index) =>
    standardizeRawModifierSelection(modifier, row, catalogue, index),
  );
  return selections.filter(
    (selection) => clean(selection.modifierName) || clean(selection.modifierId),
  );
}

function extractRawLineModifiers(line: Row) {
  const modifiers: Row[] = [];
  const directKeys = [
    "modifiers",
    "selected_modifiers",
    "selectedModifiers",
    "line_modifiers",
    "lineModifiers",
    "modifier_lines",
    "modifierLines",
    "applied_modifiers",
    "appliedModifiers",
    "modifier_selections",
    "modifierSelections",
  ];
  for (const key of directKeys) {
    const value = (line as Row)[key];
    if (Array.isArray(value))
      modifiers.push(...value.map((entry) => normalizeRawModifier(entry)));
  }
  const groupKeys = [
    "modifier_groups",
    "modifierGroups",
    "selected_modifier_groups",
    "selectedModifierGroups",
    "applied_modifier_groups",
    "appliedModifierGroups",
  ];
  for (const key of groupKeys) {
    const groups = (line as Row)[key];
    if (!Array.isArray(groups)) continue;
    for (const groupValue of groups) {
      const group = objectFromUnknown(groupValue);
      for (const modifier of modifierOptionsFromGroup(group))
        modifiers.push(normalizeRawModifier(modifier, group));
    }
  }
  const seen = new Set<string>();
  return modifiers.filter((modifier, index) => {
    const key = [
      modifierIdentity(modifier),
      modifierVariantIdentity(modifier),
      modifierGroupIdentity(modifier),
      clean(modifierDisplayName(modifier, `modifier-${index}`)).toLowerCase(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeRawModifier(value: unknown, group: Row = {}) {
  const row = objectFromUnknown(value);
  const nested = objectFromUnknown(
    row.modifier ||
      row.modifier_item ||
      row.modifierItem ||
      row.selected_modifier ||
      row.selectedModifier,
  );
  const modifier = Object.keys(nested).length ? { ...nested, ...row } : row;
  const groupId = clean(
    modifierGroupIdentity(modifier) ||
      group.id ||
      group.modifier_group_id ||
      group.modifierGroupId,
  );
  const groupName = clean(
    modifierGroupDisplayName(modifier) ||
      group.name ||
      group.display_name ||
      group.displayName,
  );
  return {
    ...modifier,
    group_id: groupId || modifier.group_id,
    groupId: groupId || modifier.groupId,
    group_name: groupName || modifier.group_name,
    groupName: groupName || modifier.groupName,
  };
}

function standardizeRawModifierSelection(
  modifier: Row,
  row: Row,
  catalogue: Map<string, Row>,
  index: number,
) {
  const metadata = objectFromUnknown(modifier.metadata);
  const id = modifierIdentity(modifier);
  const variantId = modifierVariantIdentity(modifier);
  const name = modifierDisplayName(
    modifier,
    id || variantId || "Yoco Modifier",
  );
  const groupId = clean(modifierGroupIdentity(modifier));
  const groupName = clean(modifierGroupDisplayName(modifier));
  const catalog =
    catalogue.get(id) ||
    catalogue.get(variantId ? `variant:${variantId}` : "") ||
    catalogue.get(
      groupId && name
        ? `group:${groupId}:name:${clean(name).toLowerCase()}`
        : "",
    ) ||
    catalogue.get(name ? `name:${clean(name).toLowerCase()}` : "") ||
    {};
  const quantity =
    Math.abs(
      numberValue(modifier.quantity || modifier.qty || modifier.count, 1),
    ) || 1;
  const parentQty = Math.abs(numberValue(row.line_quantity, 1)) || 1;
  const total = moneyToMajorReport(
    modifier.total_price ||
      modifier.totalPrice ||
      modifier.net_amount ||
      modifier.netAmount ||
      modifier.amount ||
      modifier.price ||
      modifier.unit_price ||
      modifier.unitPrice ||
      0,
  );
  const grossAmount =
    total ||
    roundMoneyNumber(
      moneyToMajorReport(
        modifier.price || modifier.unit_price || modifier.unitPrice || 0,
      ) *
        quantity *
        parentQty,
    );
  return {
    modifierId: clean(id || catalog.id || variantId || `modifier:${index}`),
    modifierVariantId: clean(variantId || catalog.variantId),
    modifierName: clean(name || catalog.name || "Yoco Modifier"),
    modifierGroupId: clean(groupId || catalog.groupId),
    modifierGroupName: clean(
      groupName || catalog.groupName || "Modifier Group",
    ),
    modifierType: normalizeModifierType(
      modifier.type ||
        modifier.kind ||
        modifier.modifier_type ||
        modifier.modifierType ||
        metadata.modifier_type ||
        metadata.modifierType ||
        catalog.type ||
        (variantId ? "product" : "option"),
    ),
    stockActionType: normalizeModifierStockAction(
      modifier.stock_action_type ||
        modifier.stockActionType ||
        modifier.modifier_action_type ||
        metadata.modifier_action_type ||
        metadata.note_action_type ||
        catalog.stockActionType ||
        (normalizeModifierType(catalog.type || (variantId ? "product" : "option")) === "Product" ? "ADD_RECIPE" : ""),
    ),
    qty: quantity * parentQty,
    grossAmount,
    sourceId: `${clean(row.yoco_order_id || row.yoco_order_db_id_joined)}:${clean(row.yoco_line_id || row.yoco_order_line_db_id)}:modifier:${clean(id || variantId || index)}`,
    parentLineId: clean(row.yoco_line_id || row.yoco_order_line_db_id),
    raw: modifier,
  };
}

function reportErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : clean(error);
  return clean(message || "Unknown reporting error").slice(0, 240);
}

async function enrichModifierUsageRowsWithActionSnapshots(
  env: Env,
  workspaceId: string,
  rows: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  if (!rows.length) return rows;
  const orderIds = uniqueText(
    rows.map((row) => movementReportOrderKey(row, parseJson(row.metadata_json))),
  );
  if (!orderIds.length) return rows;

  const snapshots: Row[] = [];
  const chunkSize = 75;
  try {
    for (let start = 0; start < orderIds.length; start += chunkSize) {
      const chunk = orderIds.slice(start, start + chunkSize);
      const placeholders = chunk.map((_, index) => `?${index + 2}`).join(", ");
      const result = await env.DB.prepare(
        `SELECT source_order_id, source_line_id, source_key, source_name,
                rule_id, action_type
           FROM modifier_sale_action_snapshots
          WHERE workspace_id = ?1
            AND source_kind = 'MODIFIER'
            AND source_order_id IN (${placeholders})`,
      )
        .bind(workspaceId, ...chunk)
        .all<Row>();
      snapshots.push(...(result.results || []));
    }
  } catch (error) {
    warnings.push({
      code: "modifier-action-snapshot-enrichment-unavailable",
      level: "warning",
      message: `Sale-time modifier action enrichment was skipped: ${reportErrorMessage(error)}`,
    });
    return rows;
  }

  const snapshotIndex = new Map<string, Row>();
  const set = (key: string, value: Row) => {
    const normalized = clean(key);
    if (normalized && !snapshotIndex.has(normalized)) snapshotIndex.set(normalized, value);
  };
  for (const snapshot of snapshots) {
    const orderId = clean(snapshot.source_order_id);
    const lineId = clean(snapshot.source_line_id);
    const sourceKey = clean(snapshot.source_key);
    const ruleId = clean(snapshot.rule_id);
    const sourceName = clean(snapshot.source_name).toLowerCase();
    if (!orderId || !lineId) continue;
    set(sourceKey ? `${orderId}|${lineId}|source:${sourceKey}` : "", snapshot);
    set(ruleId ? `${orderId}|${lineId}|rule:${ruleId}` : "", snapshot);
    set(sourceName ? `${orderId}|${lineId}|name:${sourceName}` : "", snapshot);
  }

  return rows.map((row) => {
    const metadata = parseJson(row.metadata_json);
    const orderId = movementReportOrderKey(row, metadata);
    const lineId = movementLineId(metadata);
    if (!orderId || !lineId) return row;
    const modifierIds = uniqueText([
      clean(metadata.sourceModifierId),
      clean(metadata.source_modifier_id),
      clean(metadata.modifierId),
      clean(metadata.modifier_id),
      clean(metadata.modifierVariantId),
      clean(metadata.modifier_variant_id),
    ]);
    const ownerId = clean(metadata.modifierOwnerId || metadata.modifier_owner_id);
    if (ownerId) {
      modifierIds.push(ownerId);
      const suffix = ownerId.includes(":") ? ownerId.split(":").pop() || "" : "";
      if (suffix) modifierIds.push(suffix);
    }
    const ruleId = clean(
      metadata.modifierRuleId ||
        metadata.modifier_rule_id ||
        metadata.ruleId ||
        metadata.rule_id,
    );
    const modifierName = clean(
      metadata.modifierName ||
        metadata.modifier_name ||
        metadata.noteSourceName ||
        metadata.note_source_name,
    ).toLowerCase();

    let snapshot: Row | undefined;
    for (const id of uniqueText(modifierIds)) {
      snapshot = snapshotIndex.get(`${orderId}|${lineId}|source:${id}`);
      if (snapshot) break;
    }
    if (!snapshot && ruleId)
      snapshot = snapshotIndex.get(`${orderId}|${lineId}|rule:${ruleId}`);
    if (!snapshot && modifierName)
      snapshot = snapshotIndex.get(`${orderId}|${lineId}|name:${modifierName}`);
    if (!snapshot) return row;
    return {
      ...row,
      movement_modifier_source_id: clean(snapshot.source_key),
      movement_modifier_source_name: clean(snapshot.source_name),
      movement_modifier_action_type: clean(snapshot.action_type),
    };
  });
}

function movementReportOrderKey(row: Row, metadata: Row) {
  return clean(
    metadata.reportOrderKey ||
      metadata.report_order_key ||
      metadata.orderId ||
      metadata.order_id ||
      metadata.sourceOrderId ||
      metadata.source_order_id ||
      row.document_id,
  );
}

function movementComponentType(metadata: Row) {
  const explicit = clean(
    metadata.componentType || metadata.component_type,
  ).toLowerCase();
  if (explicit === "modifier") return "modifier";
  if (explicit === "product") return "product";
  return clean(
    metadata.modifierId ||
      metadata.modifier_id ||
      metadata.modifierName ||
      metadata.modifier_name,
  )
    ? "modifier"
    : "product";
}

function movementLineId(metadata: Row) {
  return clean(
    metadata.componentLineId ||
      metadata.component_line_id ||
      metadata.sourceLineId ||
      metadata.source_line_id ||
      metadata.parentLineId ||
      metadata.parent_line_id ||
      metadata.saleLineId ||
      metadata.sale_line_id ||
      metadata.lineId ||
      metadata.line_id,
  );
}

function movementModifierId(row: Row, metadata: Row) {
  return clean(
    row.movement_modifier_source_id ||
      metadata.sourceModifierId ||
      metadata.source_modifier_id ||
      metadata.modifierId ||
      metadata.modifier_id ||
      metadata.modifierVariantId ||
      metadata.modifier_variant_id,
  );
}

function movementModifierOwnerId(row: Row, metadata: Row) {
  return clean(
    metadata.modifierOwnerId ||
      metadata.modifier_owner_id ||
      metadata.modifier_id ||
      metadata.modifierId,
  );
}

function movementModifierName(row: Row, metadata: Row) {
  return clean(
    row.movement_modifier_source_name ||
      metadata.modifierName ||
      metadata.modifier_name ||
      metadata.noteSourceName ||
      metadata.note_source_name ||
      metadata.sourceName ||
      metadata.source_name,
  );
}

function movementModifierGroupId(metadata: Row) {
  return clean(
    metadata.modifierGroupId || metadata.modifier_group_id,
  );
}

function movementModifierGroupName(metadata: Row) {
  return clean(
    metadata.modifierGroupName || metadata.modifier_group_name,
  );
}

function movementActionType(row: Row, metadata: Row) {
  return clean(
    row.movement_modifier_action_type ||
      metadata.modifierActionType ||
      metadata.modifier_action_type ||
      metadata.noteActionType ||
      metadata.note_action_type,
  );
}

function movementBaseUom(row: Row, metadata: Row) {
  return clean(
    row.base_uom ||
      metadata.baseUom ||
      metadata.base_uom ||
      metadata.unit,
  );
}

function isAccountingOnlyRefundWastage(row: Row) {
  const metadata = parseJson(row.metadata_json);
  return clean(metadata.mode).toLowerCase() === 'refund' && (
    clean(row.movement_type).toLowerCase() === 'wastage' ||
    clean(metadata.returnBehavior).toLowerCase() === 'wastage' ||
    metadata.accountingOnly === true ||
    numberValue(metadata.accountingOnly, 0) === 1
  );
}

function buildMenuItemUsageIndex(rows: Row[]) {
  const index = new Map<string, Row[]>();
  for (const row of rows) {
    const metadata = parseJson(row.metadata_json);
    const orderId = movementReportOrderKey(row, metadata);
    const lineId = movementLineId(metadata);
    if (!orderId || !lineId) continue;
    const key = `${orderId}|${lineId}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)?.push(row);
  }
  return index;
}

function matchingMenuItemUsageRows(row: Row, selection: Row, index: Map<string, Row[]>) {
  const orderId = clean(row.yoco_order_id || row.yoco_payment_id || row.yoco_order_db_id_joined);
  const lineId = clean(selection.parentLineId || row.yoco_line_id || row.yoco_order_line_db_id);
  return orderId && lineId ? index.get(`${orderId}|${lineId}`) || [] : [];
}

function signedMovementStockCost(row: Row) {
  if (isAccountingOnlyRefundWastage(row)) return 0;
  const baseValue = hasMeaningfulValue(row.value_delta)
    ? numberValue(row.value_delta, 0)
    : numberValue(row.quantity_delta, 0) * numberValue(row.unit_cost, 0);
  // A GRV edit that fixed a mistaken cost after the fact (patchGoodsReceipt's same-day sale cost
  // correction, routes.ts) writes a compensating 'cost_correction' stock_movements row keyed back
  // to this sale's own id via metadata_json.correctedMovementId, rather than mutating this row in
  // place — see buildSameDayCostCorrectionStatements. Callers must SELECT
  // cost_correction_value_delta (COST_CORRECTION_VALUE_DELTA_SQL, a correlated subquery summing
  // any such rows) alongside the usual movement columns for a corrected sale's true cost to show
  // up here — it defaults to 0 (no-op) for any query that doesn't include that column.
  const correctionValue = numberValue(row.cost_correction_value_delta, 0);
  const amount = Math.abs(baseValue + correctionValue);
  return clean(row.movement_type).toLowerCase() === "sale_refund" ? -amount : amount;
}

function buildModifierUsageIndex(rows: Row[]) {
  const index = new Map<string, Row[]>();
  for (const row of rows) {
    const metadata = parseJson(row.metadata_json);
    const keys = modifierUsageKeys(row, metadata);
    for (const key of keys) {
      if (!index.has(key)) index.set(key, []);
      index.get(key)?.push(row);
    }
  }
  return index;
}

function modifierUsageKeys(row: Row, metadata: Row) {
  const orderId = movementReportOrderKey(row, metadata);
  const lineId = movementLineId(metadata);
  const modifierId = movementModifierId(row, metadata);
  const modifierOwnerId = movementModifierOwnerId(row, metadata);
  const modifierName = movementModifierName(row, metadata).toLowerCase();
  const groupId = movementModifierGroupId(metadata);
  return [
    orderId && lineId && modifierId ? `${orderId}|${lineId}|${modifierId}` : "",
    orderId && lineId && modifierOwnerId
      ? `${orderId}|${lineId}|${modifierOwnerId}`
      : "",
    orderId && lineId && modifierName
      ? `${orderId}|${lineId}|name:${modifierName}`
      : "",
    orderId && groupId && modifierId
      ? `${orderId}|group:${groupId}|${modifierId}`
      : "",
    orderId && groupId && modifierName
      ? `${orderId}|group:${groupId}|name:${modifierName}`
      : "",
    orderId && modifierId ? `${orderId}|${modifierId}` : "",
    orderId && modifierOwnerId ? `${orderId}|${modifierOwnerId}` : "",
    orderId && modifierName ? `${orderId}|name:${modifierName}` : "",
  ].filter(Boolean);
}

function matchingModifierUsageRows(
  row: Row,
  selection: Row,
  index: Map<string, Row[]>,
) {
  const orderId = clean(
    row.yoco_order_id || row.yoco_payment_id || row.yoco_order_db_id_joined,
  );
  const lineId = clean(
    selection.parentLineId || row.yoco_line_id || row.yoco_order_line_db_id,
  );
  const modifierId = clean(selection.modifierId || selection.modifierVariantId);
  const modifierName = clean(selection.modifierName).toLowerCase();
  const groupId = clean(selection.modifierGroupId);
  const keys = [
    orderId && lineId && modifierId ? `${orderId}|${lineId}|${modifierId}` : "",
    orderId && lineId && modifierName
      ? `${orderId}|${lineId}|name:${modifierName}`
      : "",
    orderId && groupId && modifierId
      ? `${orderId}|group:${groupId}|${modifierId}`
      : "",
    orderId && groupId && modifierName
      ? `${orderId}|group:${groupId}|name:${modifierName}`
      : "",
    orderId && modifierId ? `${orderId}|${modifierId}` : "",
    orderId && modifierName ? `${orderId}|name:${modifierName}` : "",
  ].filter(Boolean);
  const seen = new Set<string>();
  const matches: Row[] = [];
  for (const key of keys) {
    for (const usage of index.get(key) || []) {
      const id = clean(usage.id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      matches.push(usage);
    }
    if (matches.length) break;
  }
  return matches;
}

function standardizeModifierSalesRow(
  row: Row,
  selection: Row,
  usageIndex: Map<string, Row[]>,
  menuUsageIndex: Map<string, Row[]>,
  warnings: Array<{ code: string; level: string; message: string }>,
  timeZone: string,
  tradingDayStartMinutes = 0,
) {
  const usageRows = matchingModifierUsageRows(row, selection, usageIndex);
  const menuUsageRows = matchingMenuItemUsageRows(row, selection, menuUsageIndex);
  const isRefundRow = clean(row.order_type).toLowerCase() === 'refund' || clean(row.status).toLowerCase().includes('refund');
  const selectedAmount = roundMoneyNumber(
    Math.abs(numberValue(selection.grossAmount, 0)),
  );
  const modifierFinancials = deriveYocoFinancialAmounts({
    raw: objectFromUnknown(selection.raw || {}),
    persistedTotal: selectedAmount,
    configuredVatRate: row.vat_rate,
    orderType: row.order_type,
    status: row.status,
  });
  const grossAmount = modifierFinancials.grossAmount;
  const refundAmount = modifierFinancials.refundAmount;
  const vatRate = modifierFinancials.vatRate;
  const vatAmount = modifierFinancials.vatAmount;
  const netAmount = modifierFinancials.netAmount;
  const menuItemAmount = roundMoneyNumber(Math.abs(numberValue(row.line_total, 0)));
  const menuItemFinancials = deriveYocoFinancialAmounts({
    raw: parseJson(row.line_raw_json),
    persistedTotal: menuItemAmount,
    configuredVatRate: row.vat_rate,
    orderType: row.order_type,
    status: row.status,
  });
  const menuItemModifierStockCost = roundMoneyNumber(
    menuUsageRows
      .filter((usage) => movementComponentType(parseJson(usage.metadata_json)) === "modifier")
      .reduce((sum, usage) => sum + signedMovementStockCost(usage), 0),
  );
  const menuItemBaseStockCost = roundMoneyNumber(
    menuUsageRows
      .filter((usage) => movementComponentType(parseJson(usage.metadata_json)) !== "modifier")
      .reduce((sum, usage) => sum + signedMovementStockCost(usage), 0),
  );
  const menuItemTotalStockCost = roundMoneyNumber(menuItemBaseStockCost + menuItemModifierStockCost);
  const menuItemGrossProfit = roundMoneyNumber(menuItemFinancials.netAmount - menuItemTotalStockCost);
  const menuItemGpPercent = menuItemFinancials.netAmount ? menuItemGrossProfit / menuItemFinancials.netAmount : 0;
  const physicalStockQuantityChange = usageRows.reduce(
    (sum, usage) => sum + numberValue(usage.quantity_delta, 0),
    0,
  );
  const stockQtyDeducted = -physicalStockQuantityChange;
  const accountingWastageRows = usageRows.filter(isAccountingOnlyRefundWastage);
  const wastageQty = accountingWastageRows.reduce((sum, usage) => {
    const metadata = parseJson(usage.metadata_json);
    return sum + Math.abs(numberValue(metadata.wastageQty || metadata.wasteQty || metadata.wastage_quantity, 0));
  }, 0);
  const wastageCost = roundMoneyNumber(accountingWastageRows.reduce((sum, usage) => sum + Math.abs(
    hasMeaningfulValue(usage.value_delta)
      ? numberValue(usage.value_delta, 0)
      : numberValue(usage.unit_cost, 0) * numberValue(parseJson(usage.metadata_json).wastageQty, 0)
  ), 0));
  const stockCost = roundMoneyNumber(
    usageRows.reduce((sum, usage) => sum + signedMovementStockCost(usage), 0),
  );
  const costQuantity = Math.abs(stockQtyDeducted) || wastageQty;
  const unitCostExVat = costQuantity
    ? roundMoneyNumber(Math.abs((stockCost || wastageCost) / costQuantity))
    : 0;
  const sourceIds = usageRows.map((usage) => clean(usage.id)).filter(Boolean);
  const linkedItems = uniqueText(
    usageRows.map((usage) => clean(usage.item_name || usage.stock_item_id)),
  ).join(", ");
  const baseUom =
    sameText(
      usageRows.map((usage) =>
        movementBaseUom(usage, parseJson(usage.metadata_json)),
      ),
    ) || "";
  const modifierType = normalizeModifierType(selection.modifierType);
  const usageActionType = sameText(usageRows.map((usage) => {
    const metadata = parseJson(usage.metadata_json);
    return movementActionType(usage, metadata);
  }));
  const stockActionType = normalizeModifierStockAction(selection.stockActionType || usageActionType || (modifierType === "Product" ? "ADD_RECIPE" : ""));
  const stockAction = modifierStockActionLabel(stockActionType);
  const expectsSeparateModifierMovement = [
    "ADD_RECIPE",
    "ADD_STOCK_ITEM",
    "REPLACE_INGREDIENT",
  ].includes(stockActionType);
  const shouldDeduct = usageRows.length > 0 || expectsSeparateModifierMovement;
  const status = isRefundRow
    ? accountingWastageRows.length
      ? "Scrapped / Wastage"
      : usageRows.length
        ? "Returned to Stock"
        : shouldDeduct
          ? "Missing Modifier Refund Movement"
          : "Refunded / No Stock Mapping Required"
    : usageRows.length
      ? "Deducted"
      : shouldDeduct
        ? "Missing Modifier Usage"
        : stockActionType === "REMOVE_INGREDIENT"
          ? "Applied to Base Recipe"
          : "No Stock Mapping Required";
  const selectionQty = Math.abs(numberValue(selection.qty, 1)) || 1;
  const saleQty = isRefundRow ? 0 : selectionQty;
  const refundQty = isRefundRow ? selectionQty : 0;
  const signedQty = saleQty - refundQty;
  const saleAt = clean(row.occurred_at);
  const local = zonedTradingDateTimeStrings(saleAt, timeZone, tradingDayStartMinutes);

  for (const issue of modifierFinancials.issues || []) {
    warnings.push({
      code: clean(issue.code),
      level: clean(issue.level || "warning"),
      message: clean(issue.message),
    });
  }
  if (shouldDeduct && !usageRows.length)
    warnings.push({
      code: isRefundRow ? "modifier-refund-usage-row-missing" : "modifier-usage-row-missing",
      level: "critical",
      message: isRefundRow
        ? "A stock-affecting refunded modifier has no matching return or wastage movement row."
        : "A stock-deducting modifier has no Modifier Usage movement row.",
    });

  return {
    id: clean(selection.sourceId),
    workspaceId: clean(row.workspace_id),
    locationId: clean(row.location_id),
    locationName: clean(row.location_display_name || row.location_name),
    saleDate: local.date,
    saleTime: local.time,
    occurredAt: saleAt,
    reportingTimeZone: local.timeZone || timeZone,
    receiptNumber: clean(
      row.parent_yoco_order_id || row.yoco_order_id || row.yoco_payment_id || row.yoco_order_db_id_joined,
    ),
    transactionType: isRefundRow ? "Refund" : "Sale",
    isRefund: isRefundRow,
    refundId: clean(row.provider_refund_id),
    refundReason: clean(row.refund_reason),
    refundHandling: clean(row.refund_behavior).toLowerCase() === 'wastage'
      ? 'Scrap / Wastage'
      : isRefundRow ? 'Returned to Stock' : '',
    paymentMethod: clean(row.payment_method),
    status: clean(row.status || row.order_type || "completed"),
    menuItemId: clean(row.line_product_id),
    menuItemName: clean(row.product_name || row.line_name),
    menuCategory: clean(row.product_category),
    parentLineId: clean(selection.parentLineId || row.yoco_line_id || row.yoco_order_line_db_id),
    menuItemSaleKey: `${clean(row.yoco_order_id || row.yoco_payment_id || row.yoco_order_db_id_joined)}|${clean(selection.parentLineId || row.yoco_line_id || row.yoco_order_line_db_id)}`,
    menuItemGrossAmount: menuItemFinancials.grossAmount,
    menuItemRefundAmount: menuItemFinancials.refundAmount,
    menuItemVatAmount: menuItemFinancials.vatAmount,
    menuItemNetAmount: menuItemFinancials.netAmount,
    menuItemBaseStockCost,
    menuItemModifierStockCost,
    menuItemTotalStockCost,
    menuItemGrossProfit,
    menuItemGpPercent,
    modifierGroupId: clean(selection.modifierGroupId),
    modifierGroupName: clean(selection.modifierGroupName || "Modifier Group"),
    modifierId: clean(selection.modifierId),
    yocoModifierId: clean(selection.modifierId),
    modifierName: clean(selection.modifierName || "Yoco Modifier"),
    modifierType,
    stockActionType,
    stockAction,
    qty: signedQty,
    saleQty,
    refundQty,
    timesSelected: saleQty,
    refundedSelections: refundQty,
    netSelections: signedQty,
    grossAmount,
    refundAmount,
    vatAmount,
    netAmount,
    vatRate,
    vatSource: modifierFinancials.vatSource,
    isVatExempt: modifierFinancials.isVatExempt,
    financialDiagnostics: modifierFinancials.diagnostics,
    grossSales: grossAmount,
    refunds: refundAmount,
    vat: vatAmount,
    netSales: netAmount,
    linkedProduct:
      modifierType === "Product" ? clean(selection.modifierName) : "",
    linkedStockItemId: uniqueText(
      usageRows.map((usage) => clean(usage.stock_item_id)),
    ).join(", "),
    linkedStockItemName: linkedItems,
    stockQuantityChange: physicalStockQuantityChange,
    stockQtyDeducted,
    stockDeducted: stockQtyDeducted,
    qtyDeducted: stockQtyDeducted,
    wastageQty,
    wastageCost,
    accountingOnlyWastage: accountingWastageRows.length > 0,
    baseUom,
    unitCostExVat,
    stockCost,
    grossProfit: roundMoneyNumber(netAmount - stockCost),
    gpPercent: netAmount ? (netAmount - stockCost) / netAmount : 0,
    stockDeductionStatus: status,
    createdBy: "yoco",
    sourceId: clean(row.provider_refund_id) || sourceIds[0] || clean(selection.sourceId),
    sourceType: "Modifier Usage",
    hasModifierUsage: usageRows.length > 0,
    modifierMarkedStockDeducting: shouldDeduct,
    raw: {
      line: row,
      selection: selection.raw,
      usageRows,
      menuUsageRows,
      financials: modifierFinancials,
      menuItemFinancials,
    },
  };
}

function buildOrphanModifierUsageRows(
  rows: Row[],
  linkedRows: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
  timeZone: string,
  tradingDayStartMinutes = 0,
) {
  const linkedUsageIds = new Set<string>();
  for (const row of linkedRows) {
    for (const usage of row.raw?.usageRows || [])
      linkedUsageIds.add(clean(usage.id));
  }
  return rows
    .filter((row) => !linkedUsageIds.has(clean(row.id)))
    .map((row) => {
      const metadata = parseJson(row.metadata_json);
      const isRefund = clean(metadata.mode).toLowerCase() === 'refund' || clean(row.movement_type).toLowerCase() === 'sale_refund';
      const isWastage = isAccountingOnlyRefundWastage(row);
      const physicalStockQuantityChange = numberValue(row.quantity_delta, 0);
      const stockQtyDeducted = isWastage ? 0 : -physicalStockQuantityChange;
      const wastageQty = isWastage
        ? Math.abs(numberValue(metadata.wastageQty || metadata.wasteQty || metadata.wastage_quantity, 0))
        : 0;
      const unitCostExVat = numberValue(row.unit_cost, 0);
      const movementValue = hasMeaningfulValue(row.value_delta)
        ? numberValue(row.value_delta, 0)
        : physicalStockQuantityChange * unitCostExVat;
      const stockCost = roundMoneyNumber(signedMovementStockCost(row));
      const wastageCost = isWastage ? roundMoneyNumber(Math.abs(movementValue)) : 0;
      const saleAt = clean(row.occurred_at || row.created_at);
      const local = zonedTradingDateTimeStrings(saleAt, timeZone, tradingDayStartMinutes);
      warnings.push({
        code: "modifier-usage-not-linked-to-yoco-line",
        level: "warning",
        message:
          "A Modifier Usage movement could not be linked back to a parsed Yoco modifier sale or refund line.",
      });
      return {
        id: `orphan-modifier-usage:${clean(row.id)}`,
        workspaceId: clean(row.workspace_id),
        locationId: clean(row.location_id),
        locationName: "",
        saleDate: local.date,
        saleTime: local.time,
        occurredAt: saleAt,
        reportingTimeZone: local.timeZone || timeZone,
        receiptNumber: clean(metadata.orderId || row.document_id),
        transactionType: isRefund ? 'Refund' : 'Sale',
        isRefund,
        refundId: clean(metadata.refundId),
        refundReason: clean(metadata.refundReason),
        refundHandling: isWastage ? 'Scrap / Wastage' : isRefund ? 'Returned to Stock' : '',
        menuItemId: clean(metadata.parentProductId || metadata.productId),
        menuItemName: clean(
          metadata.parentProductName ||
            metadata.productName ||
            "Unmapped Menu Item",
        ),
        menuCategory: "",
        modifierGroupId: movementModifierGroupId(metadata),
        modifierGroupName: clean(
          movementModifierGroupName(metadata) || "Modifier Group",
        ),
        modifierId: movementModifierId(row, metadata),
        yocoModifierId: clean(
          movementModifierId(row, metadata),
        ),
        modifierName: movementModifierName(row, metadata) || "Yoco Modifier",
        modifierType: normalizeModifierType(metadata.modifierType || (metadata.note_action_type ? "note" : "product")),
        stockActionType: normalizeModifierStockAction(movementActionType(row, metadata)),
        stockAction: modifierStockActionLabel(normalizeModifierStockAction(movementActionType(row, metadata))),
        qty: isRefund ? -1 : 1,
        saleQty: isRefund ? 0 : 1,
        refundQty: isRefund ? 1 : 0,
        timesSelected: isRefund ? 0 : 1,
        refundedSelections: isRefund ? 1 : 0,
        netSelections: isRefund ? -1 : 1,
        grossAmount: 0,
        refundAmount: 0,
        vatAmount: 0,
        netAmount: 0,
        grossSales: 0,
        refunds: 0,
        vat: 0,
        netSales: 0,
        linkedProduct: movementModifierName(row, metadata),
        linkedStockItemId: clean(row.stock_item_id),
        linkedStockItemName: clean(row.item_name || row.stock_item_id),
        stockQuantityChange: physicalStockQuantityChange,
        stockQtyDeducted,
        stockDeducted: stockQtyDeducted,
        qtyDeducted: stockQtyDeducted,
        wastageQty,
        wastageCost,
        accountingOnlyWastage: isWastage,
        baseUom: movementBaseUom(row, metadata),
        unitCostExVat,
        stockCost,
        grossProfit: -stockCost,
        gpPercent: 0,
        stockDeductionStatus: isWastage
          ? "Scrapped / Wastage - Sale Line Missing"
          : isRefund
            ? "Returned to Stock - Sale Line Missing"
            : "Deducted - Sale Line Missing",
        createdBy: clean(row.created_by || "yoco"),
        sourceId: clean(metadata.refundId || row.id || row.document_id),
        sourceType: "Modifier Usage",
        hasModifierUsage: true,
        modifierMarkedStockDeducting: true,
        orphanUsage: true,
        raw: { movement: row, metadata },
      };
    });
}

function modifierSalesRowMatchesFilters(
  row: Row,
  filters: ReturnType<typeof readFilters>,
) {
  if (
    filters.modifierGroupId &&
    clean(row.modifierGroupId) !== filters.modifierGroupId
  )
    return false;
  if (filters.modifierId && clean(row.modifierId) !== filters.modifierId)
    return false;
  if (
    filters.modifierName &&
    clean(row.modifierName).toLowerCase() !== filters.modifierName.toLowerCase()
  )
    return false;
  const modifierType = clean((filters as Row).modifierType).toLowerCase();
  if (modifierType && clean(row.modifierType).toLowerCase() !== modifierType)
    return false;
  const stockStatus = clean(
    (filters as Row).stockDeductionStatus,
  ).toLowerCase();
  if (
    stockStatus &&
    clean(row.stockDeductionStatus).toLowerCase() !== stockStatus
  )
    return false;
  const search = clean(filters.search).toLowerCase();
  if (search) {
    const haystack = [
      row.receiptNumber,
      row.locationName,
      row.menuItemName,
      row.modifierGroupName,
      row.modifierName,
      row.modifierType,
      row.stockAction,
      row.stockActionType,
      row.linkedStockItemName,
      row.stockDeductionStatus,
      row.sourceId,
    ]
      .map((value) => clean(value))
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
}

function addModifierSalesWarnings(
  rows: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  count(
    rows,
    (row) => !clean(row.yocoModifierId),
    "modifier-sale-missing-yoco-modifier-id",
    "critical",
    "Modifier sale rows have no YOCO modifier ID.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.receiptNumber),
    "modifier-sale-missing-receipt-number",
    "warning",
    "Modifier sale rows have no receipt number.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.modifierGroupName),
    "modifier-group-missing",
    "critical",
    "Modifier sale rows have missing modifier groups.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.modifierName),
    "modifier-name-missing",
    "critical",
    "Modifier sale rows have missing modifier names.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.modifierType),
    "modifier-type-missing",
    "critical",
    "Modifier sale rows have missing modifier types.",
    warnings,
  );
  count(
    rows,
    (row) => !hasMeaningfulValue(row.grossAmount),
    "modifier-gross-amount-missing",
    "warning",
    "Modifier sale rows have missing gross amounts.",
    warnings,
  );
  count(
    rows,
    (row) =>
      numberValue(row.grossAmount, 0) > 0 &&
      numberValue(row.vatAmount, 0) === 0 &&
      numberValue(row.netAmount, 0) === 0,
    "modifier-vat-net-cannot-calculate",
    "critical",
    "Modifier VAT/net cannot be calculated.",
    warnings,
  );
  count(
    rows,
    (row) =>
      row.modifierMarkedStockDeducting === true &&
      !clean(row.linkedStockItemId),
    "modifier-stock-item-missing",
    "critical",
    "Stock-deducting modifiers have no linked stock item.",
    warnings,
  );
  count(
    rows,
    (row) =>
      row.modifierMarkedStockDeducting === true &&
      row.hasModifierUsage === false,
    "modifier-usage-row-missing",
    "critical",
    "Stock-deducting modifiers have no Modifier Usage row.",
    warnings,
  );
  count(
    rows,
    (row) =>
      row.hasModifierUsage === true &&
      numberValue(row.stockQtyDeducted, 0) === 0,
    "modifier-usage-qty-missing",
    "critical",
    "Modifier Usage rows have no qty.",
    warnings,
  );
  count(
    rows,
    (row) =>
      row.hasModifierUsage === true &&
      numberValue(row.unitCostExVat, 0) === 0 &&
      numberValue(row.stockQtyDeducted, 0) !== 0,
    "modifier-usage-unit-cost-missing",
    "critical",
    "Modifier Usage rows have no unit cost.",
    warnings,
  );
  count(
    rows,
    (row) => row.hasModifierUsage === true && !clean(row.sourceId),
    "modifier-usage-source-id-missing",
    "critical",
    "Modifier Usage rows have no source ID.",
    warnings,
  );
  count(
    rows,
    (row) => row.orphanUsage === true,
    "modifier-usage-not-linked-to-yoco-line",
    "warning",
    "Modifier Usage rows cannot be linked back to YOCO sale modifier lines.",
    warnings,
  );
  count(
    rows,
    (row) =>
      !Number.isFinite(numberValue(row.gpPercent, NaN)) &&
      numberValue(row.netSales, 0) !== 0,
    "modifier-gp-cannot-calculate",
    "critical",
    "Modifier GP cannot be calculated.",
    warnings,
  );
}

function modifierOptionsFromGroup(group: Row) {
  for (const key of [
    "modifiers",
    "modifier_items",
    "modifierItems",
    "modifier_options",
    "modifierOptions",
    "options",
    "items",
    "values",
  ]) {
    const value = group[key];
    if (Array.isArray(value)) return value.map(objectFromUnknown);
  }
  return [];
}

function objectFromUnknown(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function modifierIdentity(modifier: Row) {
  const product = objectFromUnknown(modifier.product);
  const item = objectFromUnknown(modifier.item);
  const variant = objectFromUnknown(modifier.variant);
  const productVariant = objectFromUnknown(
    modifier.product_variant || modifier.productVariant,
  );
  return clean(
    modifier.source_modifier_id ||
      modifier.sourceModifierId ||
      modifier.mapped_modifier_id ||
      modifier.mappedModifierId ||
      modifier.id ||
      modifier.modifier_id ||
      modifier.modifierId ||
      modifier.product_id ||
      modifier.productId ||
      product.id ||
      item.id ||
      productVariant.id ||
      variant.id,
  );
}

function modifierVariantIdentity(modifier: Row) {
  const metadata = objectFromUnknown(modifier.metadata);
  const product = objectFromUnknown(modifier.product);
  const item = objectFromUnknown(modifier.item);
  const variant = objectFromUnknown(modifier.variant);
  const productVariant = objectFromUnknown(
    modifier.product_variant || modifier.productVariant,
  );
  return clean(
    modifier.source_variant_id ||
      modifier.sourceVariantId ||
      metadata.source_variant_id ||
      metadata.sourceVariantId ||
      modifier.variant_id ||
      modifier.variantId ||
      modifier.product_variant_id ||
      modifier.productVariantId ||
      product.variant_id ||
      product.variantId ||
      item.variant_id ||
      item.variantId ||
      productVariant.variant_id ||
      productVariant.variantId ||
      variant.id ||
      variant.variant_id ||
      variant.variantId,
  );
}

function modifierGroupIdentity(modifier: Row) {
  const group = objectFromUnknown(
    modifier.group || modifier.modifier_group || modifier.modifierGroup,
  );
  return clean(
    modifier.source_modifier_group_id ||
      modifier.sourceModifierGroupId ||
      modifier.group_id ||
      modifier.groupId ||
      modifier.modifier_group_id ||
      modifier.modifierGroupId ||
      group.id ||
      group.modifier_group_id ||
      group.modifierGroupId,
  );
}

function modifierGroupDisplayName(modifier: Row) {
  const group = objectFromUnknown(
    modifier.group || modifier.modifier_group || modifier.modifierGroup,
  );
  return clean(
    modifier.group_name ||
      modifier.groupName ||
      modifier.modifier_group_name ||
      modifier.modifierGroupName ||
      group.name ||
      group.display_name ||
      group.displayName,
  );
}

function modifierDisplayName(modifier: Row, fallback = "Yoco Modifier") {
  const product = objectFromUnknown(modifier.product);
  const item = objectFromUnknown(modifier.item);
  const variant = objectFromUnknown(modifier.variant);
  const productVariant = objectFromUnknown(
    modifier.product_variant || modifier.productVariant,
  );
  return clean(
    modifier.source_name ||
      modifier.sourceName ||
      modifier.name ||
      modifier.display_name ||
      modifier.displayName ||
      modifier.product_name ||
      modifier.productName ||
      product.name ||
      product.display_name ||
      product.displayName ||
      item.name ||
      item.display_name ||
      item.displayName ||
      productVariant.name ||
      productVariant.display_name ||
      productVariant.displayName ||
      variant.name ||
      variant.display_name ||
      variant.displayName,
    fallback,
  );
}

function normalizeModifierType(value: unknown) {
  const raw = clean(value).toLowerCase();
  if (raw.includes("product")) return "Product";
  if (raw.includes("note")) return "Note";
  if (raw.includes("text")) return "Note";
  return raw ? titleCase(raw) : "Option";
}

function normalizeModifierStockAction(value: unknown) {
  const action = clean(value).toUpperCase();
  if ([
    "ADD_RECIPE",
    "ADD_STOCK_ITEM",
    "REMOVE_INGREDIENT",
    "REPLACE_INGREDIENT",
    "NO_STOCK_CHANGE",
  ].includes(action)) return action;
  return "";
}

function modifierStockActionLabel(value: unknown) {
  const action = normalizeModifierStockAction(value);
  return ({
    ADD_RECIPE: "Add recipe",
    ADD_STOCK_ITEM: "Add stock item",
    REMOVE_INGREDIENT: "Remove ingredient",
    REPLACE_INGREDIENT: "Replace ingredient",
    NO_STOCK_CHANGE: "No stock change",
  } as Record<string, string>)[action] || "Not recorded";
}

function moneyToMajorReport(value: unknown) {
  const amount = yocoMoneyToMajor(value, {
    scalarUnit: "major",
    absolute: false,
  });
  return Number.isFinite(amount) ? amount : 0;
}

function uniqueText(values: string[]) {
  return Array.from(
    new Set(values.map((value) => clean(value)).filter(Boolean)),
  );
}

function sameText(values: string[]) {
  const unique = uniqueText(values);
  if (unique.length === 1) return unique[0];
  return unique.length > 1 ? "Mixed" : "";
}

export const __modifierReportingInternals = {
  buildModifierUsageIndex,
  enrichModifierUsageRowsWithActionSnapshots,
  loadModifierCatalogue,
  movementBaseUom,
  movementComponentType,
  movementLineId,
  movementModifierId,
  movementModifierName,
  signedMovementStockCost,
  standardizeModifierSalesRow,
  standardizeSaleStockUsageRow,
  COST_CORRECTION_VALUE_DELTA_SQL,
};

export const __menuHealthInternals = {
  buildMenuHealthContext,
  buildMenuRecipeHealthRows,
  buildPricingRowsForProduct,
  calculateLocationRecipeCost,
  resolveMenuRecipeIngredientCost,
};

export async function getInventoryAuditReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertReportLocationScope(env, auth, workspaceId, request);

  const url = new URL(request.url);
  const reportingContext = await getWorkspaceReportingContext(env, workspaceId);
  const timeZone = reportingContext.timeZone;
  const filters = {
    ...readFilters(url, request),
    reportingTimeZone: timeZone,
    tradingDayStartMinutes: reportingContext.tradingDayStartMinutes,
    tradingDayLabel: reportingContext.tradingDayLabel,
  } as ReturnType<typeof readFilters> & {
    reportingTimeZone: string;
    tradingDayStartMinutes: number;
    tradingDayLabel: string;
    user?: string;
    action?: string;
    entityType?: string;
    entityName?: string;
    warningSeverity?: string;
  };
  const requestedLimit = limitFromUrl(url, 500, 5000);
  const offset = offsetFromUrl(url);
  const generatedAt = new Date().toISOString();
  const warnings: Array<{ code: string; level: string; message: string }> = [];

  const requiredTables = [
    "audit_events",
    "stock_movements",
    "stock_items",
    "products",
    "recipes",
    "recipe_lines",
    "suppliers",
    "locations",
  ];
  const tableStatus: Record<string, boolean> = {};
  for (const table of requiredTables)
    tableStatus[table] = await tableExists(env, table);

  const changeRows: Row[] = [];
  const costChangeRows: Row[] = [];
  const recipeChangeRows: Row[] = [];
  const dataQualityRows: Row[] = [];

  if (!tableStatus.audit_events) {
    const gap = inventoryAuditQuality(
      "Critical",
      "Audit",
      "Audit Log",
      "audit_events",
      "Missing audit trail",
      "The tenant database does not have an audit_events table.",
      "Master-data edits cannot be audited until audit_events is added and write paths populate it.",
      "Add audit_events and write before/after changes for stock items, recipes, UOM, suppliers, mappings, and cost edits.",
      "audit_events",
    );
    dataQualityRows.push(gap);
    warnings.push({
      code: "inventory-audit-missing-audit-events",
      level: "critical",
      message: gap.issue,
    });
  } else {
    const { whereSql, binds } = buildInventoryAuditWhere(
      workspaceId,
      filters,
      timeZone,
    );
    const auditRows = await env.DB.prepare(
      `SELECT ae.id,
              ae.workspace_id,
              ae.actor_uid,
              ae.event_type,
              ae.entity_type,
              ae.entity_id,
              ae.before_json,
              ae.after_json,
              ae.created_at,
              COALESCE(si.name, p.name, sup.name, loc.display_name, loc.name, rp.name, ae.entity_id) AS resolved_entity_name,
              COALESCE(si.category, p.category, '') AS resolved_category,
              loc.id AS resolved_location_id,
              COALESCE(loc.display_name, loc.name) AS resolved_location_name
         FROM audit_events ae
         LEFT JOIN stock_items si ON si.id = ae.entity_id AND si.workspace_id = ae.workspace_id
         LEFT JOIN products p ON p.id = ae.entity_id AND p.workspace_id = ae.workspace_id
         LEFT JOIN suppliers sup ON sup.id = ae.entity_id AND sup.workspace_id = ae.workspace_id
         LEFT JOIN locations loc ON loc.id = ae.entity_id AND loc.workspace_id = ae.workspace_id
         LEFT JOIN recipes r ON r.id = ae.entity_id AND r.workspace_id = ae.workspace_id
         LEFT JOIN products rp ON rp.id = COALESCE(r.linked_product_id, r.owner_id) AND rp.workspace_id = r.workspace_id
        WHERE ${whereSql}
        ORDER BY datetime(ae.created_at) DESC, ae.id DESC
        LIMIT ${MAX_REPORT_ROWS}`,
    )
      .bind(...binds)
      .all<Row>();

    const actorMap = await resolveActors(
      env,
      workspaceId,
      (auditRows.results || []).map((row) => row.actor_uid),
    );
    for (const row of auditRows.results || []) {
      const expanded = expandAuditEventRow(row, actorMap, timeZone, reportingContext.tradingDayStartMinutes);
      changeRows.push(...expanded.changeRows);
      costChangeRows.push(...expanded.costChangeRows);
      recipeChangeRows.push(...expanded.recipeChangeRows);
    }

    addAuditTrailGapRows(
      env,
      workspaceId,
      tableStatus,
      dataQualityRows,
      warnings,
    ).catch(() => undefined);
  }

  if (tableStatus.stock_movements) {
    const sourceRows = await getInventorySourceActionRows(
      env,
      workspaceId,
      filters,
      timeZone,
    );
    const actorMap = await resolveActors(
      env,
      workspaceId,
      sourceRows.map((row) => row.created_by),
    );
    for (const row of sourceRows) {
      changeRows.push(
        standardizeInventorySourceActionRow(row, actorMap, timeZone, reportingContext.tradingDayStartMinutes),
      );
    }
    await addInventoryAuditDataQualityRows(
      env,
      workspaceId,
      tableStatus,
      dataQualityRows,
      warnings,
    );
  } else {
    const gap = inventoryAuditQuality(
      "Warning",
      "Stock Actions",
      "Stock Movement",
      "stock_movements",
      "Missing stock movement source actions",
      "stock_movements does not exist, so committed stock document actions cannot be audited from source metadata.",
      "Committed GRV, stock take, transfer, manufacturing, wastage, and adjustment source actions cannot be cross-checked.",
      "Enable the stock movement ledger and source document metadata.",
      "stock_movements",
    );
    dataQualityRows.push(gap);
    warnings.push({
      code: "inventory-audit-missing-stock-movements",
      level: "warning",
      message: gap.issue,
    });
  }

  const filteredChangeRows = changeRows.filter((row) =>
    inventoryAuditRowMatchesFilters(row, filters),
  );
  const filteredCostRows = costChangeRows.filter((row) =>
    inventoryAuditRowMatchesFilters(row, filters),
  );
  const filteredRecipeRows = recipeChangeRows.filter((row) =>
    inventoryAuditRowMatchesFilters(row, filters),
  );
  const filteredQualityRows = dataQualityRows.filter((row) =>
    inventoryAuditQualityMatchesFilters(row, filters),
  );
  const pagedRows = filteredChangeRows.slice(offset, offset + requestedLimit);

  return json(request, env, {
    rows: pagedRows,
    costChangeRows: filteredCostRows,
    recipeChangeRows: filteredRecipeRows,
    dataQualityRows: filteredQualityRows,
    warnings: uniqueWarnings(warnings),
    meta: buildMeta(
      workspaceId,
      filters,
      filteredChangeRows.length,
      requestedLimit,
      offset,
      generatedAt,
      {
        sourceTables: tableStatus,
        filterOptions: buildInventoryAuditFilterOptions(
          filteredChangeRows,
          filteredQualityRows,
        ),
        dataSource: "real",
      },
    ),
  });
}

function buildInventoryAuditWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters> & Row,
  timeZone: string,
) {
  const clauses = ["ae.workspace_id = ?1"];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  addZonedDateRange(clauses, binds, "ae.created_at", filters, timeZone);
  if (filters.user)
    add("lower(COALESCE(ae.actor_uid, '')) = lower(?)", filters.user);
  if (filters.action)
    add("lower(COALESCE(ae.event_type, '')) = lower(?)", filters.action);
  if (filters.entityType)
    add("lower(COALESCE(ae.entity_type, '')) = lower(?)", filters.entityType);
  if (filters.entityName)
    add("lower(COALESCE(ae.entity_id, '')) = lower(?)", filters.entityName);
  if (filters.search) {
    binds.push(`%${clean(filters.search).toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(`(
      lower(COALESCE(ae.event_type, '')) LIKE ?${idx}
      OR lower(COALESCE(ae.entity_type, '')) LIKE ?${idx}
      OR lower(COALESCE(ae.entity_id, '')) LIKE ?${idx}
      OR lower(COALESCE(ae.before_json, '')) LIKE ?${idx}
      OR lower(COALESCE(ae.after_json, '')) LIKE ?${idx}
    )`);
  }
  return { whereSql: clauses.join(" AND "), binds };
}

function expandAuditEventRow(
  row: Row,
  actorMap: Map<string, { name: string; email: string }>,
  timeZone: string,
  tradingDayStartMinutes = 0,
) {
  const before = parseJson(row.before_json);
  const after = parseJson(row.after_json);
  const fields = changedAuditFields(before, after);
  const timestamp = clean(row.created_at);
  const local = zonedTradingDateTimeStrings(timestamp, timeZone, tradingDayStartMinutes);
  const actor = actorMap.get(clean(row.actor_uid));
  const user = clean(actor?.name || actor?.email || row.actor_uid);
  const action = classifyAuditAction(row, fields);
  const entityType = classifyAuditEntityType(row.entity_type);
  const entityName = clean(
    row.resolved_entity_name ||
      entityDisplayName(before) ||
      entityDisplayName(after) ||
      row.entity_id,
  );
  const base = {
    workspaceId: clean(row.workspace_id),
    date: local.date,
    time: local.time,
    occurredAt: timestamp,
    reportingTimeZone: local.timeZone || timeZone,
    user,
    action,
    entityType,
    entityName,
    locationId: clean(
      row.resolved_location_id || before.location_id || after.location_id,
    ),
    locationName: clean(
      row.resolved_location_name || before.locationName || after.locationName,
    ),
    source: "Audit Event",
    sourceId: clean(row.id || row.entity_id),
    notes: clean(after.reason || before.reason || after.notes || before.notes),
    highRisk: false,
    raw: { auditEvent: row, before, after },
  };
  const changeRows: Row[] = [];
  const costChangeRows: Row[] = [];
  const recipeChangeRows: Row[] = [];
  const selectedFields = fields.length ? fields : [""];
  for (const field of selectedFields) {
    const oldValue = field ? before[field] : "";
    const newValue = field ? after[field] : "";
    const auditRow = {
      id: `inventory-audit:${clean(row.id)}:${slug(field || "event")}`,
      ...base,
      fieldChanged: field ? humanFieldName(field) : "",
      oldValue: humanReadableAuditValue(oldValue),
      newValue: humanReadableAuditValue(newValue),
      highRisk: isHighRiskAuditField(field, action, entityType),
    };
    changeRows.push(auditRow);
    if (isCostField(field)) {
      const oldCost = numberValue(oldValue, 0);
      const newCost = numberValue(newValue, 0);
      costChangeRows.push({
        id: `inventory-audit-cost:${clean(row.id)}:${slug(field)}`,
        date: base.date,
        time: base.time,
        user,
        itemName: entityName,
        locationId: base.locationId,
        locationName: base.locationName,
        oldCostExVat: oldCost,
        newCostExVat: newCost,
        costDifference: roundMoneyNumber(newCost - oldCost),
        changePercent: oldCost ? (newCost - oldCost) / oldCost : 0,
        source: base.source,
        sourceId: base.sourceId,
        reason: base.notes,
        raw: auditRow.raw,
      });
    }
    if (isRecipeAudit(entityType, action, field)) {
      const oldQty = numberValue(
        (before as Row).quantity ?? (before as Row).qty,
        0,
      );
      const newQty = numberValue(
        (after as Row).quantity ?? (after as Row).qty,
        0,
      );
      const oldCostImpact = numberValue(
        (before as Row).lineCost ?? (before as Row).costImpact,
        0,
      );
      const newCostImpact = numberValue(
        (after as Row).lineCost ?? (after as Row).costImpact,
        0,
      );
      recipeChangeRows.push({
        id: `inventory-audit-recipe:${clean(row.id)}:${slug(field || "recipe")}`,
        date: base.date,
        time: base.time,
        user,
        recipeName: entityName,
        menuItemName: clean(
          after.menuItemName ||
            before.menuItemName ||
            after.productName ||
            before.productName,
        ),
        changeType: action,
        ingredientName: clean(
          after.ingredientName ||
            before.ingredientName ||
            after.stockItemName ||
            before.stockItemName,
        ),
        oldQty,
        newQty,
        oldUom: clean(before.unit || before.uom),
        newUom: clean(after.unit || after.uom),
        oldCostImpact,
        newCostImpact,
        costImpactDifference: roundMoneyNumber(newCostImpact - oldCostImpact),
        sourceId: base.sourceId,
        raw: auditRow.raw,
      });
    }
  }
  return { changeRows, costChangeRows, recipeChangeRows };
}

function changedAuditFields(before: Row, after: Row) {
  const keys = Array.from(
    new Set([...Object.keys(before || {}), ...Object.keys(after || {})]),
  );
  return keys
    .filter(
      (key) =>
        key !== "raw_json" &&
        JSON.stringify(before?.[key] ?? null) !==
          JSON.stringify(after?.[key] ?? null),
    )
    .sort();
}

async function getInventorySourceActionRows(
  env: Env,
  workspaceId: string,
  filters: Row,
  timeZone: string,
) {
  const clauses = [
    "sm.workspace_id = ?1",
    "COALESCE(sm.document_id, '') <> ''",
    "COALESCE(sm.document_type, '') <> ''",
  ];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace(/\?/g, `?${binds.length}`));
  };
  addZonedDateRange(clauses, binds, "sm.occurred_at", filters, timeZone);
  addLocationSqlScope(clauses, binds, "sm.location_id", filters);
  if (filters.user)
    add("lower(COALESCE(sm.created_by, '')) = lower(?)", filters.user);
  if (filters.search) {
    binds.push(`%${clean(filters.search).toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(`(
      lower(COALESCE(sm.document_type, '')) LIKE ?${idx}
      OR lower(COALESCE(sm.document_id, '')) LIKE ?${idx}
      OR lower(COALESCE(l.name, '')) LIKE ?${idx}
      OR lower(COALESCE(l.display_name, '')) LIKE ?${idx}
    )`);
  }
  const rows = await env.DB.prepare(
    `SELECT sm.workspace_id,
            sm.document_type,
            sm.document_id,
            sm.location_id,
            COALESCE(l.display_name, l.name) AS location_name,
            sm.created_by,
            MIN(sm.occurred_at) AS occurred_at,
            MIN(sm.created_at) AS created_at,
            COUNT(*) AS movement_count
       FROM stock_movements sm
       LEFT JOIN locations l ON l.id = sm.location_id AND l.workspace_id = sm.workspace_id
      WHERE ${clauses.join(" AND ")}
      GROUP BY sm.workspace_id, sm.document_type, sm.document_id, sm.location_id, sm.created_by
      ORDER BY datetime(MIN(sm.occurred_at)) DESC
      LIMIT ${MAX_REPORT_ROWS}`,
  )
    .bind(...binds)
    .all<Row>();
  return rows.results || [];
}

function standardizeInventorySourceActionRow(
  row: Row,
  actorMap: Map<string, { name: string; email: string }>,
  timeZone: string,
  tradingDayStartMinutes = 0,
) {
  // See the matching comment in standardizeMovementRow -- same backdatable-date-picker issue.
  const occurredAt = BACKDATABLE_LEDGER_DOCUMENT_TYPES.has(clean(row.document_type).toLowerCase())
    ? clean(row.created_at) || row.occurred_at
    : resolveReportTimestamp(row.occurred_at, row.created_at, timeZone);
  const local = zonedTradingDateTimeStrings(occurredAt, timeZone, tradingDayStartMinutes);
  const actor = actorMap.get(clean(row.created_by));
  const documentType = clean(row.document_type);
  return {
    id: `inventory-source-action:${slug(documentType)}:${clean(row.document_id)}:${clean(row.location_id)}`,
    workspaceId: clean(row.workspace_id),
    date: local.date,
    time: local.time,
    occurredAt,
    reportingTimeZone: local.timeZone || timeZone,
    user: clean(actor?.name || actor?.email || row.created_by),
    action: classifyCommittedAction(documentType),
    entityType: classifyDocumentEntityType(documentType),
    entityName: `${titleCase(documentType)} ${clean(row.document_id)}`,
    fieldChanged: "Committed source document",
    oldValue: "",
    newValue: `${numberValue(row.movement_count, 0)} ledger row(s)`,
    locationId: clean(row.location_id),
    locationName: clean(row.location_name),
    source: "Stock Movement Source Document",
    sourceId: clean(row.document_id),
    notes:
      "Derived from real committed stock movement document metadata for audit traceability, not from movement detail calculations.",
    highRisk: true,
    raw: { sourceAction: row },
  };
}

async function addInventoryAuditDataQualityRows(
  env: Env,
  workspaceId: string,
  tableStatus: Record<string, boolean>,
  out: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  if (!tableStatus.stock_movements) return;
  const missingUser = await env.DB.prepare(
    `SELECT document_type, document_id, COUNT(*) AS count
       FROM stock_movements
      WHERE workspace_id = ?1
        AND COALESCE(created_by, '') = ''
      GROUP BY document_type, document_id
      LIMIT 50`,
  )
    .bind(workspaceId)
    .all<Row>();
  for (const row of missingUser.results || []) {
    const issue = inventoryAuditQuality(
      "Critical",
      "Stock Actions",
      classifyDocumentEntityType(row.document_type),
      clean(row.document_id || row.document_type),
      "Missing user on stock movement",
      `${numberValue(row.count, 0)} committed movement row(s) have no created_by user.`,
      "Inventory source actions cannot be traced to a clear user.",
      "Ensure every committed source document writes created_by into stock_movements.",
      clean(row.document_id || row.document_type),
    );
    out.push(issue);
    warnings.push({
      code: "inventory-audit-stock-movement-missing-user",
      level: "critical",
      message: issue.issue,
    });
  }
  const missingSource = await env.DB.prepare(
    `SELECT movement_type, COUNT(*) AS count
       FROM stock_movements
      WHERE workspace_id = ?1
        AND (COALESCE(document_id, '') = '' OR COALESCE(document_type, '') = '')
      GROUP BY movement_type
      LIMIT 50`,
  )
    .bind(workspaceId)
    .all<Row>();
  for (const row of missingSource.results || []) {
    const issue = inventoryAuditQuality(
      "Critical",
      "Stock Actions",
      "Stock Movement",
      clean(row.movement_type),
      "Missing source ID on stock movement",
      `${numberValue(row.count, 0)} stock movement row(s) are missing document_type or document_id.`,
      "Source document traceability is incomplete.",
      "Write document_type and document_id for every stock movement row.",
      clean(row.movement_type),
    );
    out.push(issue);
    warnings.push({
      code: "inventory-audit-stock-movement-missing-source-id",
      level: "critical",
      message: issue.issue,
    });
  }
  const duplicateRows = await env.DB.prepare(
    `SELECT document_type, document_id, stock_item_id, location_id, movement_type, quantity_delta, COUNT(*) AS count
       FROM stock_movements
      WHERE workspace_id = ?1
        AND COALESCE(document_id, '') <> ''
      GROUP BY document_type, document_id, stock_item_id, location_id, movement_type, quantity_delta
     HAVING COUNT(*) > 1
      LIMIT 50`,
  )
    .bind(workspaceId)
    .all<Row>();
  for (const row of duplicateRows.results || []) {
    const issue = inventoryAuditQuality(
      "Warning",
      "Stock Actions",
      classifyDocumentEntityType(row.document_type),
      clean(row.document_id),
      "Duplicate source movement rows",
      `${numberValue(row.count, 0)} similar stock movement rows exist for the same source, item, location, type, and quantity.`,
      "Ledger and audit reconciliation may show duplicate committed activity.",
      "Review source document commit idempotency for this movement group.",
      clean(row.document_id),
    );
    out.push(issue);
    warnings.push({
      code: "inventory-audit-duplicate-source-movement-rows",
      level: "warning",
      message: issue.issue,
    });
  }
}

async function addAuditTrailGapRows(
  env: Env,
  workspaceId: string,
  tableStatus: Record<string, boolean>,
  out: Row[],
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  // Fire-and-forget helper retained for future deeper mapping. Synchronous report gaps are handled by addInventoryAuditDataQualityRows.
}

function inventoryAuditQuality(
  severity: string,
  area: string,
  entityType: string,
  entityName: string,
  issueType: string,
  issue: string,
  impact: string,
  suggestedFix: string,
  sourceId = "",
) {
  return {
    id: `inventory-audit-quality:${slug(issueType)}:${slug(clean(sourceId || entityName))}`,
    severity,
    area,
    entityType: clean(entityType),
    entityName: clean(entityName),
    issueType,
    issue,
    impact,
    suggestedFix,
    sourceId: clean(sourceId),
  };
}

function buildInventoryAuditFilterOptions(rows: Row[], qualityRows: Row[]) {
  const combined = [...rows, ...qualityRows];
  return {
    users: uniqueOptionValues(rows, (row) => row.user),
    actions: uniqueOptionValues(rows, (row) => row.action),
    entityTypes: uniqueOptionValues(combined, (row) => row.entityType),
    entityNames: uniqueOptionValues(combined, (row) => row.entityName),
    locations: uniqueLocationOptions(rows),
    warningSeverities: uniqueOptionValues(qualityRows, (row) => row.severity),
  };
}

function uniqueOptionValues(rows: Row[], selector: (row: Row) => unknown) {
  return Array.from(
    new Set(
      (rows || [])
        .map(selector)
        .map((value) => clean(value))
        .filter(Boolean),
    ),
  )
    .sort()
    .map((value) => ({ value, label: value }));
}

function uniqueLocationOptions(rows: Row[]) {
  const seen = new Map<string, Row>();
  for (const row of rows || []) {
    const id = clean(row.locationId || row.location_id);
    const name = clean(row.locationName || row.location_name || id);
    if (!id && !name) continue;
    const key = id || name;
    if (!seen.has(key)) seen.set(key, { id: key, name });
  }
  return [...seen.values()].sort((a, b) =>
    clean(a.name).localeCompare(clean(b.name)),
  );
}

function inventoryAuditRowMatchesFilters(row: Row, filters: Row) {
  if (
    filters.action &&
    clean(row.action).toLowerCase() !== clean(filters.action).toLowerCase()
  )
    return false;
  if (
    filters.entityType &&
    clean(row.entityType).toLowerCase() !==
      clean(filters.entityType).toLowerCase()
  )
    return false;
  if (
    filters.entityName &&
    clean(row.entityName).toLowerCase() !==
      clean(filters.entityName).toLowerCase()
  )
    return false;
  if (
    filters.user &&
    clean(row.user).toLowerCase() !== clean(filters.user).toLowerCase()
  )
    return false;
  return true;
}

function inventoryAuditQualityMatchesFilters(row: Row, filters: Row) {
  if (
    filters.warningSeverity &&
    clean(row.severity).toLowerCase() !==
      clean(filters.warningSeverity).toLowerCase()
  )
    return false;
  if (
    filters.entityType &&
    clean(row.entityType).toLowerCase() !==
      clean(filters.entityType).toLowerCase()
  )
    return false;
  if (
    filters.entityName &&
    clean(row.entityName).toLowerCase() !==
      clean(filters.entityName).toLowerCase()
  )
    return false;
  if (filters.search) {
    const needle = clean(filters.search).toLowerCase();
    const haystack =
      `${row.severity} ${row.area} ${row.entityType} ${row.entityName} ${row.issueType} ${row.issue} ${row.impact} ${row.suggestedFix} ${row.sourceId}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function classifyAuditAction(row: Row, fields: string[]) {
  const event = clean(row.event_type);
  if (event) return titleCase(event);
  if (!clean(row.before_json) && clean(row.after_json))
    return `Created ${classifyAuditEntityType(row.entity_type)}`;
  if (clean(row.before_json) && !clean(row.after_json))
    return `Deleted ${classifyAuditEntityType(row.entity_type)}`;
  if (fields.some(isCostField)) return "Updated Cost";
  if (fields.some((field) => /uom|unit/i.test(field))) return "Updated UOM";
  if (/recipe/i.test(clean(row.entity_type))) return "Updated Recipe";
  return `Updated ${classifyAuditEntityType(row.entity_type)}`;
}

function classifyAuditEntityType(value: unknown) {
  const raw = clean(value).toLowerCase().replace(/[_-]+/g, " ");
  if (raw.includes("stock item")) return "Stock Item";
  if (raw.includes("recipe line") || raw.includes("ingredient"))
    return "Recipe Ingredient";
  if (raw.includes("recipe")) return "Recipe";
  if (raw.includes("supplier")) return "Supplier";
  if (raw.includes("location")) return "Location";
  if (raw.includes("uom") || raw.includes("unit")) return "UOM";
  if (raw.includes("cost")) return "Cost";
  if (raw.includes("modifier")) return "Modifier Mapping";
  if (raw.includes("yoco")) return "YOCO Mapping";
  if (raw.includes("product")) return "YOCO Mapping";
  return titleCase(clean(value || "Inventory Entity"));
}

function classifyCommittedAction(documentType: string) {
  const raw = clean(documentType).toLowerCase();
  if (raw === "grv") return "Committed GRV";
  if (raw.includes("stock_take") || raw.includes("stock take"))
    return "Committed Stock Take";
  if (raw.includes("transfer")) return "Committed Transfer";
  if (raw.includes("manufacturing")) return "Committed Manufacturing";
  if (raw.includes("wastage")) return "Committed Wastage";
  if (raw.includes("adjustment")) return "Adjusted Stock";
  if (raw.includes("credit")) return "Committed Credit Note";
  if (raw.includes("yoco")) return "Committed YOCO Sale";
  return `Committed ${titleCase(documentType)}`;
}

function classifyDocumentEntityType(documentType: unknown) {
  const raw = clean(documentType).toLowerCase();
  if (raw === "grv") return "GRV";
  if (raw.includes("stock_take") || raw.includes("stock take"))
    return "Stock Take";
  if (raw.includes("transfer")) return "Transfer";
  if (raw.includes("manufacturing")) return "Manufacturing Event";
  if (raw.includes("wastage")) return "Wastage Adjustment";
  if (raw.includes("adjustment")) return "Stock Adjustment";
  if (raw.includes("credit")) return "Credit Note";
  if (raw.includes("yoco")) return "YOCO Sale";
  return titleCase(clean(documentType || "Source Document"));
}

function isCostField(field: string) {
  return /cost|unit_cost|unitCost|price|unit_price|unitPrice/i.test(
    clean(field),
  );
}

function isRecipeAudit(entityType: string, action: string, field: string) {
  return (
    /recipe/i.test(`${entityType} ${action}`) ||
    /quantity|qty|unit|uom|ingredient|lineCost|costImpact/i.test(clean(field))
  );
}

function isHighRiskAuditField(
  field: string,
  action: string,
  entityType: string,
) {
  return /cost|quantity|qty|recipe|uom|unit|delete|deleted|stock|threshold|par|mapping|committed/i.test(
    `${field} ${action} ${entityType}`,
  );
}

function entityDisplayName(value: Row) {
  return clean(
    value?.name ||
      value?.itemName ||
      value?.productName ||
      value?.recipeName ||
      value?.supplierName ||
      value?.displayName,
  );
}

function humanFieldName(value: string) {
  return titleCase(clean(value).replace(/([a-z])([A-Z])/g, "$1 $2"));
}

function humanReadableAuditValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return clean(value);
}

function readFilters(url: URL, request?: Request) {
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
    from: clean(url.searchParams.get("from")),
    to: clean(url.searchParams.get("to")),
    locationId: locationIds.length === 1 ? locationIds[0] : "",
    locationIds,
    categoryId: clean(url.searchParams.get("categoryId")),
    category: clean(url.searchParams.get("category")),
    itemId: clean(url.searchParams.get("itemId")),
    menuItemId: clean(url.searchParams.get("menuItemId")),
    inventoryItemId: clean(url.searchParams.get("inventoryItemId")),
    paymentMethod: clean(url.searchParams.get("paymentMethod")),
    status: clean(url.searchParams.get("status")),
    receiptNumber: clean(url.searchParams.get("receiptNumber")),
    menuCategory: clean(url.searchParams.get("menuCategory")),
    inventoryCategory: clean(url.searchParams.get("inventoryCategory")),
    modifierGroupId: clean(url.searchParams.get("modifierGroupId")),
    modifierId: clean(url.searchParams.get("modifierId")),
    modifierType: clean(url.searchParams.get("modifierType")),
    modifierName: clean(url.searchParams.get("modifierName")),
    yocoCategory: clean(url.searchParams.get("yocoCategory")),
    recipeStatus: clean(url.searchParams.get("recipeStatus")),
    riskStatus: clean(url.searchParams.get("riskStatus")),
    warningSeverity: clean(url.searchParams.get("warningSeverity")),
    stockDeductionStatus: clean(url.searchParams.get("stockDeductionStatus")),
    supplierId: clean(url.searchParams.get("supplierId")),
    supplier: clean(url.searchParams.get("supplier")),
    itemType: clean(url.searchParams.get("itemType")),
    onlyCritical: clean(url.searchParams.get("onlyCritical")),
    onlyBelowPar: clean(url.searchParams.get("onlyBelowPar")),
    missingSupplier: clean(url.searchParams.get("missingSupplier")),
    missingCost: clean(url.searchParams.get("missingCost")),
    movementType: clean(url.searchParams.get("movementType")),
    sourceType: clean(url.searchParams.get("sourceType")),
    user: clean(url.searchParams.get("user")),
    action: clean(url.searchParams.get("action")),
    entityType: clean(url.searchParams.get("entityType")),
    entityName: clean(url.searchParams.get("entityName")),
    search: clean(url.searchParams.get("search")),
    time: clean(url.searchParams.get("time")),
  };
}

function reportLocationIds(filters: Row): string[] {
  const raw = Array.isArray(filters.locationIds)
    ? filters.locationIds
    : clean(filters.locationId)
      ? [filters.locationId]
      : [];
  return Array.from(new Set(raw.map((value) => clean(value)).filter(Boolean)));
}

function addLocationSqlScope(clauses: string[], binds: unknown[], column: string, filters: Row) {
  const ids = reportLocationIds(filters);
  if (!ids.length) return;
  const placeholders = ids.map((id) => {
    binds.push(id);
    return `?${binds.length}`;
  });
  clauses.push(`${column} IN (${placeholders.join(", ")})`);
}

function rowMatchesLocationScope(value: unknown, filters: Row): boolean {
  const permitted = reportLocationIds(filters);
  if (!permitted.length) return true;
  const values = (Array.isArray(value) ? value : [value]).map((value) => clean(value)).filter(Boolean);
  if (!values.length) return false;
  return values.some((id) => permitted.includes(id));
}

function buildMovementWhere(
  workspaceId: string,
  filters: ReturnType<typeof readFilters>,
  timeZone: string,
) {
  const clauses = ["sm.workspace_id = ?1"];
  const binds: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => {
    binds.push(value);
    clauses.push(sql.replace("?", `?${binds.length}`));
  };
  addZonedDateRange(clauses, binds, EFFECTIVE_MOVEMENT_DATE_SQL, filters, timeZone);
  addLocationSqlScope(clauses, binds, "sm.location_id", filters);
  if (filters.itemId) add("sm.stock_item_id = ?", filters.itemId);
  if (filters.categoryId) add("si.category = ?", filters.categoryId);
  if (filters.category) add("lower(si.category) = lower(?)", filters.category);
  // Apply the time filter to standardized local movementTime values in
  // applyPostFilters instead of comparing raw UTC database text.
  if (filters.movementType)
    add("lower(sm.movement_type) = lower(?)", filters.movementType);
  if (filters.search) {
    binds.push(`%${filters.search.toLowerCase()}%`);
    const idx = binds.length;
    clauses.push(`(
      lower(COALESCE(si.name, '')) LIKE ?${idx}
      OR lower(COALESCE(si.category, '')) LIKE ?${idx}
      OR lower(COALESCE(l.name, '')) LIKE ?${idx}
      OR lower(COALESCE(l.display_name, '')) LIKE ?${idx}
      OR lower(COALESCE(sm.movement_type, '')) LIKE ?${idx}
      OR lower(COALESCE(sm.document_type, '')) LIKE ?${idx}
      OR lower(COALESCE(sm.document_id, '')) LIKE ?${idx}
      OR lower(COALESCE(sm.metadata_json, '')) LIKE ?${idx}
    )`);
  }
  return { whereSql: clauses.join(" AND "), binds };
}

async function enrichTransactionReferenceReportRows(
  env: Env,
  workspaceId: string,
  rows: Row[],
) {
  const entityByDocumentType: Record<string, TransactionEntityType> = {
    grv: "grv",
    credit_note: "credit_note",
    manufacturing_batch: "manufacturing_batch",
    transfer: "transfer",
    stock_take: "stock_take",
    adjustment: "adjustment",
    wastage_adjustment: "adjustment",
    sale_adjustment: "adjustment",
  };
  for (const [documentType, entityType] of Object.entries(
    entityByDocumentType,
  )) {
    const matches = (rows || []).filter(
      (row) =>
        clean(row.document_type).toLowerCase() === documentType &&
        clean(row.document_id),
    );
    if (!matches.length) continue;
    const references = await resolveTransactionReferences(
      env,
      workspaceId,
      matches,
      entityType,
      "document_id",
    );
    for (const row of matches) {
      const entityId = clean(row.document_id);
      const metadata = parseJson(row.metadata_json);
      const raw =
        documentType === "grv"
          ? parseJson(row.grv_raw_json)
          : documentType === "manufacturing_batch"
            ? parseJson(row.manufacturing_raw_json)
            : documentType === "transfer"
              ? parseJson(row.transfer_raw_json)
              : {};
      row.transaction_reference =
        references.get(entityId) ||
        clean(metadata.transactionReference || raw.transactionReference) ||
        historicalTransactionReference(
          entityType,
          entityId,
          row.occurred_at || row.created_at,
        );
    }
  }
}

async function enrichExternalTransferReportRows(
  env: Env,
  workspaceId: string,
  rows: Row[],
) {
  const transferIds = [
    ...new Set(
      rows
        .filter((row) => clean(row.document_type) === "transfer")
        .filter((row) => clean(row.transfer_type).toLowerCase() === "external")
        .map((row) => clean(row.document_id))
        .filter(Boolean),
    ),
  ];
  if (!transferIds.length) return;

  const transfers = new Map<string, Row>();
  for (let start = 0; start < transferIds.length; start += 200) {
    const chunk = transferIds.slice(start, start + 200);
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(", ");
    const result = await env.CENTRAL_DB.prepare(
      `SELECT id, from_workspace_id, to_workspace_id, from_location_id, to_location_id,
              status, items_json, requested_at, accepted_at
         FROM external_transfers
        WHERE (from_workspace_id = ?1 OR to_workspace_id = ?1)
          AND id IN (${placeholders})`,
    )
      .bind(workspaceId, ...chunk)
      .all<Row>();
    for (const transfer of result.results || []) {
      transfers.set(clean(transfer.id), transfer);
    }
  }
  if (!transfers.size) return;

  const workspaceIds = [
    ...new Set(
      [...transfers.values()]
        .flatMap((transfer) => [
          clean(transfer.from_workspace_id),
          clean(transfer.to_workspace_id),
        ])
        .filter(Boolean),
    ),
  ];
  const workspaceNames = new Map<string, string>();
  for (let start = 0; start < workspaceIds.length; start += 200) {
    const chunk = workspaceIds.slice(start, start + 200);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ");
    const result = await env.CENTRAL_DB.prepare(
      `SELECT id, name FROM workspaces WHERE id IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<Row>();
    for (const workspace of result.results || []) {
      workspaceNames.set(clean(workspace.id), clean(workspace.name));
    }
  }

  for (const row of rows) {
    const transferId = clean(row.document_id);
    const transfer = transfers.get(transferId);
    if (!transfer) continue;
    const envelope = parseExternalTransferReportEnvelope(transfer.items_json);
    const meta = envelope.transferMeta;
    const movementMetadata = parseJson(row.metadata_json);
    const stockItemId = clean(
      movementMetadata.sourceStockItemId ||
        movementMetadata.source_stock_item_id ||
        row.stock_item_id,
    );
    const shippedLine = findExternalTransferReportLine(
      envelope.shipped,
      stockItemId,
    );
    const receivedLine = findExternalTransferReportLine(
      envelope.received,
      stockItemId,
    );
    const shortfallLine = findExternalTransferReportLine(
      envelope.shortfalls,
      stockItemId,
    );
    const shippedQty = numberValue(
      shippedLine.quantity ?? shippedLine.qty ?? row.quantity_delta,
      Math.abs(numberValue(row.quantity_delta, 0)),
    );
    const returnedQty = numberValue(
      shortfallLine.shortfall ?? shortfallLine.returnedQty,
      ["rejected", "cancelled"].includes(clean(transfer.status).toLowerCase())
        ? shippedQty
        : 0,
    );
    const receivedQty = numberValue(
      receivedLine.receivedQty ?? receivedLine.quantity,
      clean(transfer.status).toLowerCase() === "accepted"
        ? Math.max(0, shippedQty - returnedQty)
        : 0,
    );
    const fromSiteId = clean(transfer.from_workspace_id);
    const toSiteId = clean(transfer.to_workspace_id);
    const fromLocationId = clean(transfer.from_location_id);
    const toLocationId = clean(transfer.to_location_id);
    row.__external_transfer = {
      transferType: "external",
      transferScope: "external",
      fromSiteId,
      fromSiteName:
        clean(meta.fromSiteName || workspaceNames.get(fromSiteId)) ||
        (fromSiteId === workspaceId ? "Current Site" : "External Site"),
      fromLocationId,
      fromLocationName:
        clean(meta.fromLocationName) ||
        clean(row.source_location_display_name || row.source_location_name) ||
        (fromSiteId === workspaceId ? "Source Location" : "External Location"),
      toSiteId,
      toSiteName:
        clean(meta.toSiteName || workspaceNames.get(toSiteId)) ||
        (toSiteId === workspaceId ? "Current Site" : "External Site"),
      toLocationId,
      toLocationName:
        clean(meta.toLocationName) ||
        clean(
          row.destination_location_display_name ||
            row.destination_location_name,
        ) ||
        (toSiteId === workspaceId ? "Receiving Location" : "External Location"),
      status: clean(
        transfer.status || envelope.lifecycle.status || meta.status,
      ),
      requestedAt: clean(transfer.requested_at || meta.requestedAt),
      acceptedAt: clean(
        transfer.accepted_at ||
          envelope.lifecycle.acceptedAt ||
          meta.acceptedAt,
      ),
      shippedQty,
      receivedQty,
      returnedQty,
      partialAcceptance: receivedQty > 0 && returnedQty > 0,
    };
  }
}

function parseExternalTransferReportEnvelope(value: unknown) {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  if (Array.isArray(parsed)) {
    return {
      shipped: parsed as Row[],
      received: [] as Row[],
      shortfalls: [] as Row[],
      transferMeta: {} as Row,
      lifecycle: {} as Row,
    };
  }
  const envelope = parsed && typeof parsed === "object" ? (parsed as Row) : {};
  return {
    shipped: Array.isArray(envelope.shipped)
      ? envelope.shipped
      : Array.isArray(envelope.items)
        ? envelope.items
        : [],
    received: Array.isArray(envelope.received) ? envelope.received : [],
    shortfalls: Array.isArray(envelope.shortfalls) ? envelope.shortfalls : [],
    transferMeta: reportRowObject(
      envelope.transferMeta || envelope.transfer_meta || envelope.meta,
    ),
    lifecycle: reportRowObject(envelope.lifecycle),
  };
}

function reportRowObject(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Row;
  return parseJson(value);
}

function findExternalTransferReportLine(lines: Row[], stockItemId: string) {
  return (
    (lines || []).find(
      (line) =>
        clean(
          line.sourceStockItemId ||
            line.stockItemId ||
            line.stock_item_id ||
            line.id,
        ) === stockItemId,
    ) || {}
  );
}

function standardizeMovementRow(
  row: Row,
  actorMap: Map<string, { name: string; email: string }>,
  warnings: Array<{ code: string; level: string; message: string }>,
  timeZone: string,
  tradingDayStartMinutes = 0,
) {
  const metadata = parseJson(row.metadata_json);
  const transferRaw = parseJson(row.transfer_raw_json);
  const transferMeta = reportRowObject(
    transferRaw.transferMeta || transferRaw.transfer_meta || transferRaw,
  );
  const externalTransfer = reportRowObject(row.__external_transfer);
  const transferData = {
    ...transferMeta,
    ...metadata,
    ...externalTransfer,
  };
  const rawQuantityDelta = numberValue(row.quantity_delta, 0);
  const sourceType = classifySourceType(row, metadata);
  const qtyIn = rawQuantityDelta > 0 ? rawQuantityDelta : 0;
  const qtyOut = rawQuantityDelta < 0 ? Math.abs(rawQuantityDelta) : 0;
  const netQty = qtyIn - qtyOut;
  const unitCostExVat = resolveReportUnitCost(row, metadata, netQty);
  const movementValue = hasMeaningfulValue(row.value_delta)
    ? numberValue(row.value_delta, 0)
    : netQty * unitCostExVat;
  const actor = actorMap.get(clean(row.created_by));
  const sourceId = clean(row.document_id || row.id);
  const documentNumber = resolveDocumentNumber(
    row,
    metadata,
    sourceType,
    sourceId,
  );
  const locationName = clean(row.location_display_name || row.location_name);
  const itemName = clean(
    row.item_name || metadata.stockItemName || metadata.productName,
  );
  const categoryName =
    clean(row.category_name || metadata.stockCategory || metadata.category) ||
    "General";
  // GRV/Credit Note/Adjustment/Wastage/Manufacturing all have a date-only entry field that can be
  // deliberately backdated (see grvDate/creditNoteDate/postedAt in reporting-phase21-routes.ts) --
  // occurred_at for those document types is therefore always literal UTC midnight, never a real
  // clock time. Reporting shows when the movement was actually PROCESSED (created_at), matching
  // those reports' own date columns, rather than resolveReportTimestamp's same-day fallback (which
  // would still show midnight for a backdated entry). Every other document type (sale/transfer/
  // stock take/purchase order) carries a genuine, externally- or system-captured occurred_at that
  // must NOT be overridden by processing time -- resolveReportTimestamp is the safe, conservative
  // choice there since it only ever substitutes a value that already looks like midnight.
  const occurredAt = BACKDATABLE_LEDGER_DOCUMENT_TYPES.has(clean(row.document_type).toLowerCase())
    ? clean(row.created_at) || row.occurred_at
    : resolveReportTimestamp(row.occurred_at, row.created_at, timeZone);
  const local = zonedTradingDateTimeStrings(occurredAt, timeZone, tradingDayStartMinutes);
  const baseUom =
    clean(row.base_uom || metadata.unit || metadata.baseUom) || "ea";
  const notes = resolveNotes(row, metadata, sourceType);
  const wastageQty = Math.abs(
    numberValue(
      metadata.wastageQty ||
        metadata.wasteQty ||
        metadata.wastage_quantity,
      0,
    ),
  );
  const accountingOnly =
    metadata.accountingOnly === true ||
    numberValue(metadata.accountingOnly, 0) === 1;
  const isTransfer =
    sourceType === "Transfer In" || sourceType === "Transfer Out";
  const transferType = isTransfer
    ? clean(
        row.transfer_type ||
          transferData.transferType ||
          transferData.transfer_type,
      ) || "internal"
    : "";
  const transferScope = isTransfer
    ? clean(
        transferData.transferScope ||
          transferData.transfer_scope ||
          transferType,
      )
    : "";
  const fromSiteId = isTransfer
    ? clean(
        transferData.fromSiteId ||
          transferData.from_site_id ||
          row.transfer_from_workspace_id ||
          row.workspace_id,
      )
    : "";
  const toSiteId = isTransfer
    ? clean(
        transferData.toSiteId ||
          transferData.to_site_id ||
          row.transfer_to_workspace_id ||
          row.workspace_id,
      )
    : "";
  const fromLocationId = isTransfer
    ? clean(
        transferData.fromLocationId ||
          transferData.from_location_id ||
          row.transfer_from_location_id ||
          row.source_location_id,
      )
    : "";
  const toLocationId = isTransfer
    ? clean(
        transferData.toLocationId ||
          transferData.to_location_id ||
          row.transfer_to_location_id ||
          row.destination_location_id,
      )
    : "";
  const fromSiteName = isTransfer
    ? clean(transferData.fromSiteName || transferData.from_site_name) ||
      (fromSiteId === clean(row.workspace_id)
        ? "Current Site"
        : "External Site")
    : "";
  const toSiteName = isTransfer
    ? clean(transferData.toSiteName || transferData.to_site_name) ||
      (toSiteId === clean(row.workspace_id) ? "Current Site" : "External Site")
    : "";
  const fromLocationName = isTransfer
    ? clean(
        transferData.fromLocationName ||
          transferData.from_location_name ||
          row.source_location_display_name ||
          row.source_location_name ||
          (sourceType === "Transfer Out" ? locationName : ""),
      ) || (transferType === "external" ? "External Location" : "")
    : "";
  const toLocationName = isTransfer
    ? clean(
        transferData.toLocationName ||
          transferData.to_location_name ||
          row.destination_location_display_name ||
          row.destination_location_name ||
          (sourceType === "Transfer In" ? locationName : ""),
      ) || (transferType === "external" ? "External Location" : "")
    : "";
  const transferStatus = isTransfer
    ? clean(
        transferData.status ||
          transferData.transferStatus ||
          row.transfer_status,
      )
    : "";
  const requestedAt = isTransfer
    ? clean(
        transferData.requestedAt ||
          transferData.requested_at ||
          row.transfer_requested_at,
      )
    : "";
  const acceptedAt = isTransfer
    ? clean(
        transferData.acceptedAt ||
          transferData.accepted_at ||
          row.transfer_accepted_at,
      )
    : "";
  const shippedQty = isTransfer
    ? Math.abs(numberValue(transferData.shippedQty, Math.abs(rawQuantityDelta)))
    : 0;
  const receivedQty = isTransfer
    ? Math.abs(
        numberValue(
          transferData.receivedQty,
          transferStatus === "accepted" && sourceType === "Transfer In"
            ? qtyIn
            : 0,
        ),
      )
    : 0;
  const returnedQty = isTransfer
    ? Math.abs(numberValue(transferData.returnedQty, 0))
    : 0;

  return {
    id: clean(row.id),
    workspaceId: clean(row.workspace_id),
    locationId: clean(row.location_id),
    locationName,
    itemId: clean(row.stock_item_id),
    itemName,
    categoryId: categoryName,
    categoryName,
    movementDate: local.date,
    movementTime: local.time,
    occurredAt,
    reportingTimeZone: local.timeZone || timeZone,
    movementType: classifyMovementType(sourceType, row, metadata),
    sourceType,
    sourceId,
    transactionReference:
      clean(row.transaction_reference) ||
      clean(metadata.transactionReference) ||
      documentNumber,
    documentNumber,
    transferType,
    transferScope,
    fromSiteId,
    fromSiteName,
    fromLocationId,
    fromLocationName,
    toSiteId,
    toSiteName,
    toLocationId,
    toLocationName,
    status: transferStatus,
    requestedAt,
    acceptedAt,
    shippedQty,
    receivedQty,
    returnedQty,
    supplierId: clean(
      row.supplier_id || metadata.supplierId || metadata.supplier_id,
    ),
    supplierName: clean(
      row.supplier_name ||
        metadata.supplierName ||
        metadata.supplier ||
        metadata.supplier_name,
    ),
    qtyIn,
    qtyOut,
    netQty,
    baseUom,
    unitCostExVat,
    movementValue,
    runningQty: null,
    runningValue: null,
    createdBy: clean(row.created_by),
    createdByName: clean(actor?.name || actor?.email || row.created_by),
    notes,
    wastageQty,
    accountingOnly,
    raw: {
      movement: row,
      metadata,
      transfer: transferRaw,
      externalTransfer,
    },
  };
}

function calculateRunningRows(
  rows: Row[],
  openingBalances: Map<string, number>,
  warnings: ReportWarning[],
) {
  const balances = new Map(openingBalances);
  let hasMissingRunningBasis = false;
  const sorted = [...rows].sort((left, right) => {
    const byDate = clean(left.movementDate).localeCompare(
      clean(right.movementDate),
    );
    if (byDate) return byDate;
    const byTime = clean(left.movementTime).localeCompare(
      clean(right.movementTime),
    );
    if (byTime) return byTime;
    const bySource = clean(left.sourceType).localeCompare(
      clean(right.sourceType),
    );
    if (bySource) return bySource;
    return clean(left.sourceId || left.id).localeCompare(
      clean(right.sourceId || right.id),
    );
  });

  const withRunning: Row[] = sorted.map((row): Row => {
    const key = runningKey(row);
    if (!row.movementDate || !row.itemId || !row.locationId) {
      hasMissingRunningBasis = true;
      warnings.push(
        buildRowWarning(
          row,
          "reporting-running-qty-limited",
          "warning",
          "Running quantity cannot be calculated because the system ledger date, item, or location is missing.",
        ),
      );
      return { ...row, runningQty: null, runningValue: null };
    }
    const previousQty = numberValue(balances.get(key), 0);
    const runningQty = previousQty + numberValue(row.netQty, 0);
    balances.set(key, runningQty);
    return {
      ...row,
      runningQty,
      runningValue: runningQty * numberValue(row.unitCostExVat, 0),
    };
  });

  // Missing running basis is now attached to the affected rows above, not shown
  // as a broad banner that leaves users guessing which line needs attention.
  void hasMissingRunningBasis;

  return withRunning.sort((left, right) =>
    clean(
      `${right.movementDate || ""}${right.movementTime || ""}`,
    ).localeCompare(
      clean(`${left.movementDate || ""}${left.movementTime || ""}`),
    ),
  );
}

async function getOpeningBalances(
  env: Env,
  workspaceId: string,
  fromDate = "",
  timeZone = "Africa/Johannesburg",
  tradingDayStartMinutes = 0,
) {
  const map = new Map<string, number>();
  if (!fromDate) return map;
  const { fromUtc } = localDateRangeToUtcBounds({ from: fromDate, timeZone, tradingDayStartMinutes });
  if (!fromUtc) return map;
  try {
    const rows = await env.DB.prepare(
      `SELECT stock_item_id, location_id, COALESCE(SUM(quantity_delta), 0) AS opening_qty
         FROM stock_movements
        WHERE workspace_id = ?1
          AND datetime(occurred_at) < datetime(?2)
        GROUP BY stock_item_id, location_id`,
    )
      .bind(workspaceId, fromUtc)
      .all<Row>();
    for (const row of rows.results || []) {
      map.set(
        `${clean(row.location_id)}::${clean(row.stock_item_id)}`,
        numberValue(row.opening_qty, 0),
      );
    }
  } catch {
    // If historical opening cannot be read, keep zero and let row-level warnings carry data gaps.
  }
  return map;
}

function applyPostFilters(row: Row, filters: ReturnType<typeof readFilters>) {
  if (
    filters.sourceType &&
    clean(row.sourceType).toLowerCase() !== filters.sourceType.toLowerCase()
  )
    return false;
  if (filters.time) {
    const rowTime = clean(
      row.movementTime || row.saleTime || row.stockTakeTime || row.time,
    ).slice(0, 5);
    if (!rowTime || rowTime !== clean(filters.time).slice(0, 5)) return false;
  }
  return true;
}

function buildSourceCoverage(rows: Row[]) {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    const source = clean(row.sourceType || row.source);
    if (!source) continue;
    counts[source] = (counts[source] || 0) + 1;
  }
  return counts;
}

function addDataQualityWarnings(rows: Row[], warnings: ReportWarning[]) {
  count(
    rows,
    (row) => !clean(row.locationName),
    "reporting-location-names-missing",
    "warning",
    "Location names are missing on real ledger rows.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.itemName),
    "reporting-item-names-missing",
    "warning",
    "Item names are missing on real ledger rows.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.createdByName),
    "reporting-users-unresolved",
    "info",
    "Users cannot be resolved for some real ledger rows.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.sourceId),
    "reporting-source-ids-missing",
    "warning",
    "Source IDs are missing on real ledger rows.",
    warnings,
  );
  count(
    rows,
    (row) =>
      numberValue(row.unitCostExVat, 0) === 0 &&
      (numberValue(row.qtyIn, 0) > 0 || numberValue(row.qtyOut, 0) > 0),
    "reporting-unit-costs-missing",
    "info",
    "Unit costs are missing on real ledger rows. Values will show R0 until item or location costs are loaded.",
    warnings,
  );
  count(
    rows,
    (row) => !clean(row.baseUom),
    "reporting-uom-conversion-missing",
    "warning",
    "Base UOM values are missing on real ledger rows; UOM conversion data may be incomplete.",
    warnings,
  );
  count(
    rows,
    (row) =>
      clean(row.sourceType) === "Manufacturing Wastage" &&
      numberValue(row.qtyIn, 0) === 0 &&
      numberValue(row.qtyOut, 0) === 0 &&
      numberValue(row.wastageQty, 0) <= 0,
    "reporting-manufacturing-wastage-missing-qty",
    "warning",
    "Manufacturing wastage ledger rows exist but do not contain a recorded wastage quantity.",
    warnings,
  );
}

function count(
  rows: Row[],
  predicate: (row: Row) => boolean,
  code: string,
  level: string,
  message: string,
  warnings: ReportWarning[],
) {
  for (const row of rows || []) {
    if (!predicate(row)) continue;
    warnings.push(buildRowWarning(row, code, level, message));
  }
}

function buildRowWarning(
  row: Row,
  code: string,
  level: string,
  message: string,
): ReportWarning {
  const label = clean(
    row.itemName ||
      row.item_name ||
      row.menuItemName ||
      row.productName ||
      row.stockItemName ||
      row.inventoryItemName ||
      row.locationName ||
      row.location_name ||
      row.documentNumber ||
      row.sourceId ||
      row.id ||
      "Line",
  );
  const cleanMessage = clean(message)
    .replace(/^\d+\s+/, "")
    .replace(/\brows?\b/gi, "line")
    .replace(/\brow\(s\)\b/gi, "line")
    .replace(/\blines?\b/gi, "line")
    .trim();
  return {
    code,
    level,
    message: `${label} - ${cleanMessage || "Review this line."}`,
    rowId: clean(row.id || row.rowId || row.lineId),
    itemId: clean(
      row.itemId ||
        row.stock_item_id ||
        row.stockItemId ||
        row.inventoryItemId ||
        row.productId ||
        row.menuItemId,
    ),
    itemName: clean(
      row.itemName ||
        row.item_name ||
        row.stockItemName ||
        row.inventoryItemName ||
        row.inventoryIngredient ||
        row.productName ||
        row.menuItemName ||
        row.name,
    ),
    stockItemId: clean(row.stockItemId || row.stock_item_id || row.itemId),
    stockItemName: clean(
      row.stockItemName || row.itemName || row.item_name || row.name,
    ),
    productId: clean(row.productId || row.menuItemId),
    productName: clean(row.productName || row.menuItemName),
    sourceId: clean(
      row.sourceId ||
        row.document_id ||
        row.documentId ||
        row.saleId ||
        row.transferId ||
        row.stockTakeId,
    ),
    locationId: clean(
      row.locationId ||
        row.location_id ||
        row.fromLocationId ||
        row.toLocationId,
    ),
    locationName: clean(
      row.locationName ||
        row.location_name ||
        row.fromLocationName ||
        row.toLocationName,
    ),
    isItemSpecific: true,
  };
}

function classifySourceType(row: Row, metadata: Row) {
  const movement = clean(row.movement_type).toLowerCase();
  const document = clean(row.document_type).toLowerCase();
  if (document === "grv")
    return clean(row.grv_purchase_order_id) ? "Purchase Order Receive" : "GRV";
  if (document === "purchase_order" || movement.includes("purchase_order"))
    return "Purchase Order Receive";
  if (document === "credit_note" || movement.includes("credit"))
    return "Credit Note";
  if (movement === "manufacturing_finished_in") return "Manufacturing In";
  if (movement === "manufacturing_component_out") return "Manufacturing Out";
  if (
    movement === "manufacturing_wastage" ||
    movement === "manufacturing_waste_out"
  )
    return "Manufacturing Wastage";
  if (
    movement === "stock_take_variance" ||
    movement === "stock_take_correction" ||
    document === "stock_take"
  )
    return "Stock Take Variance";
  if (movement === "transfer_in") return "Transfer In";
  if (movement === "transfer_out") return "Transfer Out";
  if (movement === "transfer_reversal") return "Transfer In";
  if (
    document === "wastage_adjustment" ||
    movement === "wastage" ||
    clean(metadata.returnBehavior).toLowerCase() === "wastage" ||
    clean(metadata.mode).toLowerCase() === "wastage" ||
    clean(metadata.wasteReason)
  )
    return "Wastage Adjustment";
  // Checked BEFORE the generic `movement.includes("sale")` fallback below, which would otherwise
  // misclassify this as "Sale Usage" (a real POS sale) — a Product Sales Adjustment is a manual
  // correction for a sale the POS never captured, deliberately kept out of Sales Usage/GP reporting
  // (see postSalesAdjustment in routes.ts) and must stay a distinct Adjustments-report entry.
  if (document === "sale_adjustment" || movement === "sale_adjustment")
    return "Sale Adjustment";
  if (
    document === "yoco_order" &&
    movementComponentType(metadata) === "modifier"
  )
    return "Modifier Usage";
  if (
    document === "yoco_order" &&
    (movement === "sale_depletion" || movement === "sale_refund")
  )
    return "Sale Usage";
  if (document === "adjustment" || movement === "adjustment")
    return "Manual Adjustment";
  if (movement.includes("sale")) return "Sale Usage";
  return titleCase(movement || document || "Unknown Source");
}

function classifyMovementType(sourceType: string, row: Row, _metadata: Row) {
  const movement = clean(row.movement_type).toLowerCase();
  if (sourceType === "GRV") return "Purchase";
  if (sourceType === "Purchase Order Receive") return "Purchase";
  if (sourceType === "Credit Note")
    return numberValue(row.quantity_delta, 0) >= 0
      ? "Credit Note In"
      : "Credit Note Out";
  if (sourceType === "Manual Adjustment")
    return numberValue(row.quantity_delta, 0) >= 0
      ? "Manual Adjustment In"
      : "Manual Adjustment Out";
  if (sourceType === "Wastage Adjustment") return "Wastage Adjustment";
  if (sourceType === "Sale Usage")
    return movement === "sale_refund" ? "Sale Refund" : "Sale Usage";
  if (sourceType === "Modifier Usage")
    return movement === "sale_refund" ? "Modifier Refund" : "Modifier Usage";
  return sourceType;
}

function resolveReportUnitCost(row: Row, metadata: Row, netQty: number) {
  const movementValue = numberValue(row.value_delta, 0);
  if (numberValue(row.unit_cost, 0)) return numberValue(row.unit_cost, 0);
  if (numberValue(row.location_unit_cost, 0))
    return numberValue(row.location_unit_cost, 0);
  if (numberValue(row.stock_unit_cost, 0))
    return numberValue(row.stock_unit_cost, 0);
  if (netQty && movementValue) return Math.abs(movementValue / netQty);
  if (numberValue(metadata.unitCost, 0))
    return numberValue(metadata.unitCost, 0);
  return 0;
}

function resolveDocumentNumber(
  row: Row,
  metadata: Row,
  sourceType: string,
  sourceId: string,
) {
  if (sourceType === "GRV" || sourceType === "Purchase Order Receive") {
    const grvRaw = parseJson(row.grv_raw_json);
    return clean(
      row.grv_invoice_number ||
        row.po_number ||
        grvRaw.grvNumber ||
        grvRaw.invoice ||
        grvRaw.reference ||
        sourceId,
    );
  }
  if (sourceType === "Credit Note")
    return clean(row.credit_note_number || sourceId);
  if (sourceType === "Transfer In" || sourceType === "Transfer Out")
    return clean(metadata.transferNumber || metadata.reference || sourceId);
  if (sourceType.includes("Manufacturing")) {
    const manufacturingRaw = parseJson(row.manufacturing_raw_json);
    return clean(
      manufacturingRaw.batchNumber ||
        manufacturingRaw.productionNumber ||
        metadata.batchId ||
        sourceId,
    );
  }
  if (sourceType === "Sale Usage" || sourceType === "Modifier Usage")
    return clean(
      row.yoco_order_number ||
        row.yoco_payment_id ||
        metadata.orderId ||
        metadata.paymentId ||
        sourceId,
    );
  return clean(metadata.reference || metadata.number || sourceId);
}

function resolveNotes(row: Row, metadata: Row, sourceType: string) {
  if (sourceType === "Credit Note")
    return clean(row.credit_note_reason || metadata.note || metadata.reason);
  if (sourceType === "Manual Adjustment" || sourceType === "Wastage Adjustment" || sourceType === "Sale Adjustment")
    return clean(
      row.adjustment_reason ||
        metadata.note ||
        metadata.wasteReason ||
        metadata.saleReason ||
        metadata.refundReason ||
        metadata.refundNote ||
        metadata.reason,
    );
  if (sourceType === "Transfer In" || sourceType === "Transfer Out")
    return clean(row.transfer_note || metadata.note);
  if (sourceType === "Sale Usage" || sourceType === "Modifier Usage")
    return clean(
      metadata.productName ||
        metadata.modifierName ||
        metadata.parentProductName ||
        metadata.refundReason,
    );
  return clean(metadata.note || metadata.reason || metadata.description);
}

async function resolveActors(env: Env, workspaceId: string, ids: unknown[]) {
  const values = [...new Set(ids.map((id) => clean(id)).filter(Boolean))];
  const map = new Map<string, { name: string; email: string }>();
  if (!values.length) return map;
  const uidPlaceholders = values.map((_, index) => `?${index + 2}`).join(",");
  const emailPlaceholders = values
    .map((_, index) => `?${values.length + index + 2}`)
    .join(",");
  try {
    const members = await env.CENTRAL_DB.prepare(
      `SELECT auth_uid, email, display_name
         FROM workspace_members
        WHERE workspace_id = ?1
          AND (auth_uid IN (${uidPlaceholders}) OR lower(email) IN (${emailPlaceholders}))`,
    )
      .bind(
        workspaceId,
        ...values,
        ...values.map((value) => value.toLowerCase()),
      )
      .all<Row>();
    for (const member of members.results || []) {
      const info = {
        name: clean(member.display_name),
        email: clean(member.email),
      };
      if (clean(member.auth_uid)) map.set(clean(member.auth_uid), info);
      if (clean(member.email)) map.set(clean(member.email), info);
    }
  } catch {
    return map;
  }
  return map;
}

async function tableExists(env: Env, tableName: string) {
  try {
    const row = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1 LIMIT 1`,
    )
      .bind(tableName)
      .first<Row>();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function tableHasColumns(
  env: Env,
  tableName: string,
  requiredColumns: string[],
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return false;
  try {
    const info = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all<Row>();
    const columns = new Set(
      (info.results || []).map((row) => clean(row.name)).filter(Boolean),
    );
    return requiredColumns.every((column) => columns.has(column));
  } catch {
    return false;
  }
}

// Builds the vat_rate SQL expression for a per-order/per-line reporting row. Prefers the
// point-in-time snapshot stamped onto yoco_orders by applyReporting (live-sale.ts/live-refund.ts)
// at processing time — this is what actually applied to that specific transaction — and only
// falls back to the live workspace_settings lookup for rows written before the snapshot columns
// existed, where there is no way to recover the historical rate. Without this, a VAT rate/
// registration change made today would silently recompute every past order's reported VAT rate.
function buildVatRateSqlExpression({
  orderAlias,
  fallbackWorkspaceIdExpr,
  orderVatColumnsAvailable,
  vatRegisteredColumnAvailable,
  workspaceSettingsExists,
}: {
  orderAlias: string;
  fallbackWorkspaceIdExpr: string;
  orderVatColumnsAvailable: boolean;
  vatRegisteredColumnAvailable: boolean;
  workspaceSettingsExists: boolean;
}): string {
  const liveExpr = vatRegisteredColumnAvailable
    ? `COALESCE((SELECT CASE WHEN COALESCE(ws.vat_registered, 1) = 0 THEN 0 ELSE NULLIF(ws.vat_rate, 0) END FROM workspace_settings ws WHERE ws.workspace_id = ${fallbackWorkspaceIdExpr} ORDER BY datetime(ws.updated_at) DESC LIMIT 1), 15)`
    : workspaceSettingsExists
      ? `COALESCE((SELECT NULLIF(ws.vat_rate, 0) FROM workspace_settings ws WHERE ws.workspace_id = ${fallbackWorkspaceIdExpr} ORDER BY datetime(ws.updated_at) DESC LIMIT 1), 15)`
      : "15";
  if (!orderVatColumnsAvailable) return liveExpr;
  return `COALESCE(CASE WHEN ${orderAlias}.vat_rate IS NOT NULL THEN (CASE WHEN COALESCE(${orderAlias}.vat_registered, 1) = 0 THEN 0 ELSE NULLIF(${orderAlias}.vat_rate, 0) END) END, ${liveExpr})`;
}

function buildMeta(
  workspaceId: string,
  filters: ReturnType<typeof readFilters> & Row,
  totalRows: number,
  limit: number,
  offset: number,
  generatedAt: string,
  extra: Row = {},
) {
  const returnedRows = Math.max(0, Math.min(limit, totalRows - offset));
  const hasMore = offset + returnedRows < totalRows;
  const sourceRowCap = numberValue(extra.sourceRowCap, MAX_REPORT_ROWS);
  // Row counts at the historical ceiling are not proof of truncation. Only an
  // endpoint that actually discarded source rows may mark the response as
  // truncated. This prevents false 100,000-row failures across report types.
  const hasExplicitTruncationState = Object.prototype.hasOwnProperty.call(extra, "truncated");
  const truncated = hasExplicitTruncationState ? extra.truncated === true : false;
  return {
    workspaceId,
    from: filters.from || null,
    to: filters.to || null,
    totalRows,
    limit,
    offset,
    returnedRows,
    hasMore,
    nextOffset: hasMore ? offset + returnedRows : null,
    sourceRowCap,
    truncated,
    dataSource: "real",
    currency: "ZAR",
    timeZone: normalizeReportTimeZone(
      extra.timeZone ||
        extra.timezone ||
        filters.reportingTimeZone ||
        "Africa/Johannesburg",
    ),
    timezone: normalizeReportTimeZone(
      extra.timeZone ||
        extra.timezone ||
        filters.reportingTimeZone ||
        "Africa/Johannesburg",
    ),
    generatedAt,
    ...extra,
  };
}

async function getReportFilterOptions(env: Env, workspaceId: string) {
  const [locations, categories, sources] = await Promise.all([
    safeAll(
      env.DB.prepare(
        `SELECT id, COALESCE(display_name, name, external_name, id) AS name, kind
         FROM locations
        WHERE workspace_id = ?1
          AND COALESCE(active, 1) = 1
        ORDER BY is_default DESC, name ASC`,
      ).bind(workspaceId),
    ),
    safeAll(
      env.DB.prepare(
        `SELECT DISTINCT category AS name
         FROM stock_items
        WHERE workspace_id = ?1
          AND COALESCE(active, 1) = 1
          AND COALESCE(category, '') <> ''
        ORDER BY category ASC`,
      ).bind(workspaceId),
    ),
    safeAll(
      env.DB.prepare(
        `SELECT DISTINCT movement_type AS name
         FROM stock_movements
        WHERE workspace_id = ?1
          AND COALESCE(movement_type, '') <> ''
        ORDER BY movement_type ASC`,
      ).bind(workspaceId),
    ),
  ]);
  return {
    locations: locations
      .map((row) => ({
        id: clean(row.id),
        name: clean(row.name),
        kind: clean(row.kind),
      }))
      .filter((row) => row.id),
    categories: categories.map((row) => clean(row.name)).filter(Boolean),
    sources: sources.map((row) => titleCase(clean(row.name))).filter(Boolean),
  };
}

async function safeAll(statement: { all: () => Promise<{ results?: Row[] }> }) {
  try {
    const rows = await statement.all();
    return rows.results || [];
  } catch {
    return [];
  }
}

function uniqueWarnings(
  warnings: Array<{ code: string; level: string; message: string }>,
) {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runningKey(row: Row) {
  return `${clean(row.locationId)}::${clean(row.itemId)}`;
}

function hasMeaningfulValue(value: unknown) {
  return value !== undefined && value !== null && clean(value) !== "";
}

async function getWorkspaceReportingContext(env: Env, workspaceId: string) {
  let timeZone = normalizeReportTimeZone("Africa/Johannesburg");
  let settings: Row = {};
  try {
    const [workspace, settingsRow] = await Promise.all([
      env.CENTRAL_DB.prepare(
        `SELECT timezone FROM workspaces WHERE id = ?1 LIMIT 1`,
      ).bind(workspaceId).first<{ timezone?: string }>(),
      env.DB.prepare(
        `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
      ).bind(workspaceId).first<{ raw_json?: string }>(),
    ]);
    timeZone = normalizeReportTimeZone(workspace?.timezone || "Africa/Johannesburg");
    settings = parseJson(settingsRow?.raw_json);
  } catch {
    // Keep safe Johannesburg/calendar-day defaults when either plane is unavailable.
  }
  const tradingDayStartMinutes = normalizeTradingDayStartMinutes(settings as any);
  const hour = Math.floor(tradingDayStartMinutes / 60);
  const minute = tradingDayStartMinutes % 60;
  const timeLabel = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return {
    timeZone,
    tradingDayStartMinutes,
    tradingDayLabel: tradingDayStartMinutes ? `${timeLabel}–${timeLabel}` : "00:00–00:00",
  };
}

function addZonedDateRange(
  clauses: string[],
  binds: unknown[],
  column: string,
  filters: Row,
  timeZone: string,
) {
  const { fromUtc, toExclusiveUtc } = localDateRangeToUtcBounds({
    from: filters.from,
    to: filters.to,
    timeZone,
    tradingDayStartMinutes: numberValue((filters as Row).tradingDayStartMinutes, 0),
  });
  // The datetime(...) predicates below are the EXACT, authoritative bounds and are kept as-is:
  // datetime() normalises both sides, so they stay correct even if stored timestamps mix ISO
  // 'T' and SQLite ' ' separators. But wrapping the column in a function makes it non-sargable —
  // SQLite cannot use idx_stock_movements_workspace_date and full-scans the ledger, which is why
  // reports/detailed-activity (13 LEFT JOINs, called on every dashboard load) was one of the
  // heaviest reads in the system.
  //
  // So each exact predicate is paired with a deliberately WIDER, index-usable prefilter on the
  // bare column. It only has to be a guaranteed superset — the exact predicate still removes
  // anything extra it lets through, so results are unchanged while the planner gets a range it
  // can seek on. Comparing against a date-only bound is safe for any separator because the first
  // ten characters are the date, and a longer string sharing that prefix always sorts after it:
  // both '2026-08-27T09:00Z' and '2026-08-27 09:00' sort >= '2026-08-27' and < '2026-08-28'.
  // The upper bound uses the day AFTER toExclusiveUtc's date, since rows earlier on that final
  // day are still legitimately in range.
  const utcDay = (value: unknown): string => String(value ?? "").slice(0, 10);
  const dayAfter = (day: string): string => {
    const parsed = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return "9999-12-31";
    parsed.setUTCDate(parsed.getUTCDate() + 1);
    return parsed.toISOString().slice(0, 10);
  };

  if (fromUtc) {
    binds.push(fromUtc);
    clauses.push(`datetime(${column}) >= datetime(?${binds.length})`);
    binds.push(utcDay(fromUtc));
    clauses.push(`${column} >= ?${binds.length}`);
  }
  if (toExclusiveUtc) {
    binds.push(toExclusiveUtc);
    clauses.push(`datetime(${column}) < datetime(?${binds.length})`);
    binds.push(dayAfter(utcDay(toExclusiveUtc)));
    clauses.push(`${column} < ?${binds.length}`);
  }
}

function parseJson(value: unknown): Row {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown, fallback = 0) {
  const parsed =
    typeof value === "number"
      ? value
      : Number(
          String(value ?? "")
            .trim()
            .replace(/\s/g, "")
            .replace(/[^\d,.-]/g, "")
            .replace(",", "."),
        );
  return Number.isFinite(parsed) ? parsed : fallback;
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

function clean(value: unknown, fallback = "") {
  return String(value ?? fallback).trim();
}

function booleanValue(value: unknown) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    clean(value).toLowerCase() === "true"
  );
}

function extractTime(value: string) {
  const raw = clean(value);
  const match = raw.match(/T?(\d{2}:\d{2}(?::\d{2})?)/);
  return match ? match[1] : "";
}

function slug(value: string) {
  return (
    clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "unknown"
  );
}

function titleCase(value: string) {
  return clean(value)
    .replace(/[_-]+/g, " ")
    .replace(
      /\w\S*/g,
      (part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`,
    );
}
