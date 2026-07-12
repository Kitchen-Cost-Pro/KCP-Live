import {
  calculateVariancePercent,
  calculateVarianceQty,
  calculateVarianceValue,
  safeNumber,
} from "../../engine/calculations.js";
import { groupBy, sumBy, text, toArray } from "../../engine/grouping.js";
import { buildRowWarnings } from "../../validators/rowWarningUtils.js";
import { formatMoney, formatNumber } from "../../engine/formatters.js";
import { buildRowFormulaTooltip } from "../../tooltips/tooltipBuilder.js";
import { reconcileStockTakeAuditToDetailedActivity } from "../../validators/reconciliationChecks.js";
import { fetchStockTakeAuditRows } from "../../api/reportingApi.js";
import { detailedActivityReport } from "./detailedActivityReport.js";

const VALUE_TOLERANCE = 0.01;

const sessionsColumns = [
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
  {
    key: "stockTakeDateTime",
    label: "Session Date and Time",
    type: "datetime",
    sortable: true,
  },
  { key: "locationName", label: "Location", sortable: true },
  { key: "status", label: "Status", sortable: true },
  {
    key: "itemsCounted",
    label: "Items Counted",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "itemsWithVariance",
    label: "Items With Variance",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "totalVarianceQty",
    label: "Variance Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "totalExpectedValue",
    label: "Total Expected Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeExpectedValue",
    cellTooltip: expectedValueTooltip,
    sortable: true,
  },
  {
    key: "totalCountedValue",
    label: "Total Counted Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeCountedValue",
    cellTooltip: countedValueTooltip,
    sortable: true,
  },
  {
    key: "varianceValue",
    label: "Variance Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeVarianceValue",
    cellTooltip: varianceValueTooltip,
    sortable: true,
  },
  {
    key: "variancePercent",
    label: "Variance %",
    type: "percent",
    align: "right",
    tooltipKey: "stockTakeVariancePercent",
    cellTooltip: variancePercentTooltip,
    sortable: true,
  },
  { key: "committedBy", label: "Committed By", sortable: true },
  {
    key: "committedAt",
    label: "Committed At",
    type: "datetime",
    sortable: true,
  },
];

const byCategoryColumns = [
  { key: "category", label: "Category", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  {
    key: "itemsCounted",
    label: "Items Counted",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "itemsWithVariance",
    label: "Items With Variance",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "expectedValue",
    label: "Expected Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeExpectedValue",
    cellTooltip: expectedValueTooltip,
    sortable: true,
  },
  {
    key: "countedValue",
    label: "Counted Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeCountedValue",
    cellTooltip: countedValueTooltip,
    sortable: true,
  },
  {
    key: "varianceValue",
    label: "Variance Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeVarianceValue",
    cellTooltip: varianceValueTooltip,
    sortable: true,
  },
  {
    key: "variancePercent",
    label: "Variance %",
    type: "percent",
    align: "right",
    tooltipKey: "stockTakeVariancePercent",
    cellTooltip: variancePercentTooltip,
    sortable: true,
  },
  {
    key: "positiveVarianceValue",
    label: "Positive Variance Value",
    type: "money",
    align: "right",
    sortable: true,
  },
  {
    key: "negativeVarianceValue",
    label: "Negative Variance Value",
    type: "money",
    align: "right",
    sortable: true,
  },
];

const byItemColumns = [
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
  { key: "itemName", label: "Item", sortable: true },
  { key: "category", label: "Category", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  {
    key: "expectedQty",
    label: "Expected Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "countedQty",
    label: "Counted Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "varianceQty",
    label: "Variance Qty",
    type: "number",
    align: "right",
    tooltipKey: "stockTakeVarianceQty",
    cellTooltip: varianceQtyTooltip,
    sortable: true,
  },
  { key: "baseUom", label: "Base UOM", sortable: true },
  {
    key: "unitCostExVat",
    label: "Unit Cost Ex VAT",
    type: "money",
    align: "right",
    sortable: true,
  },
  {
    key: "expectedValue",
    label: "Expected Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeExpectedValue",
    cellTooltip: expectedValueTooltip,
    sortable: true,
  },
  {
    key: "countedValue",
    label: "Counted Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeCountedValue",
    cellTooltip: countedValueTooltip,
    sortable: true,
  },
  {
    key: "varianceValue",
    label: "Variance Value",
    type: "money",
    align: "right",
    tooltipKey: "stockTakeVarianceValue",
    cellTooltip: varianceValueTooltip,
    sortable: true,
  },
  {
    key: "variancePercent",
    label: "Variance %",
    type: "percent",
    align: "right",
    tooltipKey: "stockTakeVariancePercent",
    cellTooltip: variancePercentTooltip,
    sortable: true,
  },
  {
    key: "stockTakeDate",
    label: "Stock Take Date",
    type: "date",
    sortable: true,
  },
  { key: "committedBy", label: "Committed By", sortable: true },
];

const countDetailColumns = [
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
  {
    key: "stockTakeDate",
    label: "Stock Take Date",
    type: "date",
    sortable: true,
  },
  { key: "locationName", label: "Location", sortable: true },
  { key: "itemName", label: "Item", sortable: true },
  { key: "category", label: "Category", sortable: true },
  { key: "countedUom", label: "Counted UOM", sortable: true },
  {
    key: "enteredQty",
    label: "Entered Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  { key: "uomBreakdown", label: "Count Breakdown", sortable: true },
  {
    key: "convertedBaseQty",
    label: "Converted Base Qty",
    type: "number",
    align: "right",
    tooltipKey: "convertedBaseQty",
    cellTooltip: convertedBaseQtyTooltip,
    sortable: true,
  },
  {
    key: "expectedBaseQty",
    label: "Expected Base Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "varianceBaseQty",
    label: "Variance Base Qty",
    type: "number",
    align: "right",
    tooltipKey: "stockTakeVarianceQty",
    cellTooltip: varianceQtyTooltip,
    sortable: true,
  },
  { key: "baseUom", label: "Base UOM", sortable: true },
  {
    key: "unitCostExVat",
    label: "Unit Cost Ex VAT",
    type: "money",
    align: "right",
    sortable: true,
  },
  {
    key: "expectedValue",
    label: "Expected Value",
    type: "money",
    align: "right",
    sortable: true,
  },
  {
    key: "countedValue",
    label: "Counted Value",
    type: "money",
    align: "right",
    sortable: true,
  },
  {
    key: "varianceValue",
    label: "Variance Value",
    type: "money",
    align: "right",
    sortable: true,
  },
  { key: "user", label: "User", sortable: true },
  { key: "countedAt", label: "Counted At", type: "datetime", sortable: true },
  { key: "notes", label: "Notes" },
];

const varianceMovementColumns = [
  { key: "date", label: "Date", type: "date", sortable: true },
  { key: "time", label: "Time", type: "time", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  { key: "itemName", label: "Item", sortable: true },
  { key: "category", label: "Category", sortable: true },
  { key: "movementType", label: "Movement Type", sortable: true },
  { key: "source", label: "Source", tooltipKey: "source", sortable: true },
  { key: "documentNumber", label: "Document Number", sortable: true },
  {
    key: "qtyIn",
    label: "Qty In",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "qtyOut",
    label: "Qty Out",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "netQty",
    label: "Net Qty",
    type: "number",
    align: "right",
    tooltipKey: "netMovement",
    sortable: true,
  },
  { key: "baseUom", label: "Base UOM", sortable: true },
  {
    key: "unitCostExVat",
    label: "Unit Cost Ex VAT",
    type: "money",
    align: "right",
    sortable: true,
  },
  {
    key: "movementValue",
    label: "Movement Value",
    type: "money",
    align: "right",
    tooltipKey: "movementValue",
    sortable: true,
  },
  { key: "createdBy", label: "Created By", sortable: true },
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
];

const stockTakeExportColumns = [
  {
    key: "stockTakeDate",
    label: "Stock Take Date",
    type: "date",
    aliases: ["date"],
  },
  { key: "locationName", label: "Location" },
  { key: "itemName", label: "Item" },
  { key: "category", label: "Category" },
  {
    key: "expectedQty",
    label: "Expected Qty",
    type: "number",
    aliases: ["expectedBaseQty"],
  },
  {
    key: "countedQty",
    label: "Counted Qty",
    type: "number",
    aliases: ["convertedBaseQty"],
  },
  {
    key: "varianceQty",
    label: "Variance Qty",
    type: "number",
    aliases: ["varianceBaseQty"],
  },
  { key: "baseUom", label: "UOM" },
  { key: "unitCostExVat", label: "Unit Cost Ex VAT", type: "money" },
  { key: "expectedValue", label: "Expected Value", type: "money" },
  { key: "countedValue", label: "Counted Value", type: "money" },
  { key: "varianceValue", label: "Variance Value", type: "money" },
  { key: "variancePercent", label: "Variance %", type: "percent" },
  { key: "committedBy", label: "Committed By" },
  {
    key: "committedAt",
    label: "Committed At",
    type: "datetime",
    aliases: ["countedAt"],
  },
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
  },
];

export const stockTakeAuditReport = {
  id: "stock_take_audit",
  title: "Stock Take Audit",
  section: "operations",
  description:
    "Audit stock take sessions, counted quantities, expected quantities, variances, value impact, and committed stock movement corrections.",
  emptyState: {
    title: "No stock takes found",
    message: "No stock takes found for the selected filters.",
  },
  defaultView: "sessions",
  availableViews: [
    "sessions",
    "by_category",
    "by_item",
    "count_detail",
    "variance_movements",
  ],
  filterConfig: {
    sessions: ["search", "dateRange", "location"],
    by_category: ["search", "dateRange", "location", "category"],
    by_item: ["search", "dateRange", "location", "category"],
    count_detail: ["search", "dateRange", "time", "location", "category"],
    variance_movements: ["search", "dateRange", "time", "location", "category"],
  },

  columns: {
    sessions: sessionsColumns,
    by_category: byCategoryColumns,
    by_item: byItemColumns,
    count_detail: countDetailColumns,
    variance_movements: varianceMovementColumns,
  },

  exportColumns: {
    sessions: sessionsColumns,
    by_category: byCategoryColumns,
    by_item: stockTakeExportColumns,
    count_detail: countDetailColumns,
    variance_movements: varianceMovementColumns,
  },

  getRows: async ({
    workspaceId,
    filters,
    services = {},
    dataSet = {},
    view = "sessions",
  }) => {
    const model = await loadStockTakeAuditModel({
      workspaceId,
      filters,
      services,
      dataSet,
    });
    const rows =
      view === "variance_movements"
        ? model.views.variance_movements
        : model.views[view] || [];
    return rows.map((row) => withMeta(row, model));
  },

  getTotals: ({ rows, view }) => getTotalsForView(view, rows),

  validate: ({ rows, view, services }) =>
    validateStockTakeAuditRows(rows, view, services),

  exportMapping: {
    sessions: {
      transactionReference: "Transaction ID",
      stockTakeDateTime: "Session Date and Time",
      locationName: "Location",
      status: "Status",
      itemsCounted: "Items Counted",
      itemsWithVariance: "Items With Variance",
      totalVarianceQty: "Variance Qty",
      totalExpectedValue: "Total Expected Value",
      totalCountedValue: "Total Counted Value",
      varianceValue: "Variance Value",
      variancePercent: "Variance %",
      committedBy: "Committed By",
      committedAt: "Committed At",
    },
    by_category: {
      category: "Category",
      locationName: "Location",
      itemsCounted: "Items Counted",
      itemsWithVariance: "Items With Variance",
      expectedValue: "Expected Value",
      countedValue: "Counted Value",
      varianceValue: "Variance Value",
      variancePercent: "Variance %",
      positiveVarianceValue: "Positive Variance Value",
      negativeVarianceValue: "Negative Variance Value",
    },
    by_item: {
      transactionReference: "Transaction ID",
      itemName: "Item",
      category: "Category",
      locationName: "Location",
      expectedQty: "Expected Qty",
      countedQty: "Counted Qty",
      varianceQty: "Variance Qty",
      baseUom: "UOM",
      unitCostExVat: "Unit Cost Ex VAT",
      expectedValue: "Expected Value",
      countedValue: "Counted Value",
      varianceValue: "Variance Value",
      variancePercent: "Variance %",
      stockTakeDate: "Stock Take Date",
      committedBy: "Committed By",
    },
    count_detail: {
      transactionReference: "Transaction ID",
      stockTakeDate: "Stock Take Date",
      locationName: "Location",
      itemName: "Item",
      category: "Category",
      countedUom: "Counted UOM",
      enteredQty: "Entered Qty",
      uomBreakdown: "Count Breakdown",
      convertedBaseQty: "Converted Base Qty",
      expectedBaseQty: "Expected Base Qty",
      varianceBaseQty: "Variance Base Qty",
      baseUom: "UOM",
      unitCostExVat: "Unit Cost Ex VAT",
      expectedValue: "Expected Value",
      countedValue: "Counted Value",
      varianceValue: "Variance Value",
      user: "User",
      countedAt: "Counted At",
      notes: "Notes",
    },
    variance_movements: {
      date: "Date",
      time: "Time",
      locationName: "Location",
      itemName: "Item",
      category: "Category",
      movementType: "Movement Type",
      source: "Source",
      documentNumber: "Document Number",
      qtyIn: "Qty In",
      qtyOut: "Qty Out",
      netQty: "Net Qty",
      baseUom: "UOM",
      unitCostExVat: "Unit Cost Ex VAT",
      movementValue: "Movement Value",
      createdBy: "Created By",
      transactionReference: "Transaction ID",
    },
  },
};

async function loadStockTakeAuditModel({
  workspaceId,
  filters,
  services = {},
  dataSet = {},
}) {
  const sourceResponse = await loadStockTakeSourceRows({
    workspaceId,
    filters,
    services,
  });
  const sourceRows = normalizeStockTakeRows(sourceResponse.rows);
  const varianceLedgerRows = await loadStockTakeVarianceLedgerRows({
    workspaceId,
    filters,
    services,
    dataSet,
  });
  const model = buildStockTakeAuditModel({
    sourceRows,
    varianceLedgerRows,
    sourceResponse,
  });
  rememberStockTakeAuditResponse(services, sourceResponse, model);
  return model;
}

async function loadStockTakeSourceRows({
  workspaceId,
  filters,
  services = {},
}) {
  if (services.reporting?.getStockTakeAuditRows) {
    return normalizeStockTakeResponse(
      await services.reporting.getStockTakeAuditRows({ workspaceId, filters }),
      { dataSource: "real", workspaceId },
    );
  }
  if (services.reporting?.getStockTakeAudit) {
    return normalizeStockTakeResponse(
      await services.reporting.getStockTakeAudit({ workspaceId, filters }),
      { dataSource: "real", workspaceId },
    );
  }
  return fetchStockTakeAuditRows({ workspaceId, filters });
}

async function loadStockTakeVarianceLedgerRows({
  workspaceId,
  filters,
  services = {},
  dataSet = {},
}) {
  const ledgerRows = await detailedActivityReport.getRows({
    workspaceId,
    filters,
    services,
    dataSet,
    view: "ledger",
  });
  return toArray(ledgerRows).filter(isStockTakeVarianceLedgerRow);
}

function buildStockTakeAuditModel({
  sourceRows = [],
  varianceLedgerRows = [],
  sourceResponse = {},
}) {
  const detailRows = toArray(sourceRows).map(enrichStockTakeLine);
  const ledgerRows = toArray(varianceLedgerRows).map(
    normalizeVarianceMovementRow,
  );
  const sessions = buildSessionRows(detailRows);
  const byCategory = buildByCategoryRows(detailRows);
  const byItem = buildByItemRows(detailRows);
  const countDetail = detailRows.map((line) => ({
    ...line,
    id: `count-detail:${line.id}`,
  }));
  const reconciliation = buildReconciliation(detailRows, ledgerRows);

  return {
    sourceRows: detailRows,
    varianceLedgerRows: ledgerRows,
    reconciliation,
    warnings: toArray(sourceResponse.warnings),
    meta: sourceResponse.meta || {},
    views: {
      sessions,
      by_category: byCategory,
      by_item: byItem,
      count_detail: countDetail,
      variance_movements: ledgerRows,
    },
  };
}

function normalizeStockTakeRows(rows = []) {
  return toArray(rows).map((row, index) => ({
    ...row,
    id: text(row.id) || `stock-take-line:${index}`,
    stockTakeSessionId: text(
      row.stockTakeSessionId ||
        row.stock_take_session_id ||
        row.sourceId ||
        row.source_id,
    ),
    sourceId: text(
      row.sourceId ||
        row.source_id ||
        row.stockTakeSessionId ||
        row.stock_take_session_id,
    ),
    transactionReference: text(
      row.transactionReference ||
        row.transaction_reference ||
        row.documentNumber ||
        row.document_number,
    ),
    stockTakeDate: text(
      row.stockTakeDate ||
        row.stock_take_date ||
        row.date ||
        row.countedAt ||
        row.counted_at,
    ).slice(0, 10),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    status: text(
      row.status || row.sessionStatus || row.session_status || "posted",
    ),
    itemId: text(
      row.itemId || row.item_id || row.stockItemId || row.stock_item_id,
    ),
    itemName: text(
      row.itemName || row.item_name || row.stockItemName || row.stock_item_name,
    ),
    category:
      text(row.category || row.categoryName || row.category_name) || "General",
    itemType: text(row.itemType || row.item_type),
    isStocked: row.isStocked ?? row.is_stocked,
    countedUom: text(
      row.countedUom ||
        row.counted_uom ||
        row.unit ||
        row.uom ||
        row.baseUom ||
        row.base_uom,
    ),
    enteredQty: safeNumber(
      row.enteredQty ??
        row.entered_qty ??
        row.countedQty ??
        row.counted_qty ??
        row.convertedBaseQty ??
        row.converted_base_qty,
    ),
    uomBreakdown: text(
      row.uomBreakdown || row.uom_breakdown || row.countBreakdown,
    ),
    baseUom: text(row.baseUom || row.base_uom || row.unit || row.uom || "ea"),
    uomRatio: safeNumber(row.uomRatio ?? row.uom_ratio ?? 1, 1) || 1,
    expectedQty: safeNumber(
      row.expectedQty ??
        row.expected_qty ??
        row.expectedBaseQty ??
        row.expected_base_qty,
    ),
    countedQty: safeNumber(
      row.countedQty ??
        row.counted_qty ??
        row.convertedBaseQty ??
        row.converted_base_qty,
    ),
    convertedBaseQty: safeNumber(
      row.convertedBaseQty ??
        row.converted_base_qty ??
        row.countedQty ??
        row.counted_qty,
    ),
    expectedBaseQty: safeNumber(
      row.expectedBaseQty ??
        row.expected_base_qty ??
        row.expectedQty ??
        row.expected_qty,
    ),
    varianceQty: safeNumber(row.varianceQty ?? row.variance_qty),
    unitCostExVat: safeNumber(
      row.unitCostExVat ??
        row.unit_cost_ex_vat ??
        row.unitCost ??
        row.unit_cost,
    ),
    countedAt: text(
      row.countedAt ||
        row.counted_at ||
        row.stockTakeDate ||
        row.stock_take_date,
    ),
    committedBy: text(
      row.committedByName ||
        row.committed_by_name ||
        row.committedBy ||
        row.committed_by ||
        row.user,
    ),
    committedAt: text(
      row.committedAt ||
        row.committed_at ||
        row.countedAt ||
        row.counted_at ||
        row.updatedAt ||
        row.updated_at,
    ),
    user: text(
      row.user ||
        row.committedByName ||
        row.committed_by_name ||
        row.committedBy ||
        row.committed_by,
    ),
    notes: text(row.notes || row.note),
    ledgerNetQty: safeNumber(row.ledgerNetQty ?? row.ledger_net_qty),
    ledgerMovementValue: safeNumber(
      row.ledgerMovementValue ?? row.ledger_movement_value,
    ),
    ledgerRowCount: safeNumber(row.ledgerRowCount ?? row.ledger_row_count),
    varianceMovementRowCount: safeNumber(
      row.varianceMovementRowCount ?? row.variance_movement_row_count,
    ),
    raw: row.raw || row,
  }));
}

function enrichStockTakeLine(row = {}) {
  const expectedBaseQty = safeNumber(row.expectedBaseQty ?? row.expectedQty);
  const convertedBaseQty = safeNumber(row.convertedBaseQty ?? row.countedQty);
  const varianceBaseQty = hasValue(row.varianceQty)
    ? safeNumber(row.varianceQty)
    : calculateVarianceQty(convertedBaseQty, expectedBaseQty);
  const unitCostExVat = safeNumber(row.unitCostExVat);
  const expectedValue = expectedBaseQty * unitCostExVat;
  const countedValue = convertedBaseQty * unitCostExVat;
  const varianceValue = countedValue - expectedValue;
  return {
    ...row,
    expectedQty: expectedBaseQty,
    countedQty: convertedBaseQty,
    convertedBaseQty,
    expectedBaseQty,
    varianceQty: varianceBaseQty,
    varianceBaseQty,
    unitCostExVat,
    expectedValue,
    countedValue,
    varianceValue,
    variancePercent: calculateVariancePercent(varianceValue, expectedValue),
    reportSummaryRow: false,
  };
}

function buildSessionRows(lines = []) {
  return Array.from(
    groupBy(
      lines,
      (line) => line.sourceId || line.stockTakeSessionId,
    ).entries(),
  ).map(([sourceId, rows]) => {
    const totalExpectedValue = sumBy(rows, "expectedValue");
    const totalCountedValue = sumBy(rows, "countedValue");
    const varianceValue = totalCountedValue - totalExpectedValue;
    const first = rows[0] || {};
    return {
      id: `stock-take-session:${sourceId}`,
      reportSummaryRow: true,
      stockTakeDate: first.stockTakeDate,
      stockTakeDateTime:
        first.countedAt || first.committedAt || first.stockTakeDate,
      locationId: first.locationId,
      locationName: first.locationName,
      status: first.status,
      itemsCounted: rows.length,
      itemsWithVariance: rows.filter((row) => safeNumber(row.varianceQty) !== 0)
        .length,
      totalVarianceQty: sumBy(rows, "varianceQty"),
      totalExpectedValue,
      totalCountedValue,
      varianceValue,
      variancePercent: calculateVariancePercent(
        varianceValue,
        totalExpectedValue,
      ),
      committedBy: first.committedBy,
      committedAt: first.committedAt,
      sourceId,
      transactionReference: first.transactionReference,
      __lines: rows,
    };
  });
}

function buildByCategoryRows(lines = []) {
  return Array.from(
    groupBy(
      lines,
      (line) =>
        `${line.category || "General"}::${line.locationId || line.locationName || ""}`,
    ).entries(),
  ).map(([key, rows]) => {
    const expectedValue = sumBy(rows, "expectedValue");
    const countedValue = sumBy(rows, "countedValue");
    const varianceValue = countedValue - expectedValue;
    const first = rows[0] || {};
    return {
      id: `stock-take-category:${key}`,
      reportSummaryRow: true,
      category: first.category || "General",
      locationId: first.locationId,
      locationName: first.locationName,
      itemsCounted: rows.length,
      itemsWithVariance: rows.filter((row) => safeNumber(row.varianceQty) !== 0)
        .length,
      expectedValue,
      countedValue,
      varianceValue,
      variancePercent: calculateVariancePercent(varianceValue, expectedValue),
      positiveVarianceValue: sumBy(
        rows.filter((row) => safeNumber(row.varianceValue) > 0),
        "varianceValue",
      ),
      negativeVarianceValue: sumBy(
        rows.filter((row) => safeNumber(row.varianceValue) < 0),
        "varianceValue",
      ),
      __lines: rows,
    };
  });
}

function buildByItemRows(lines = []) {
  return Array.from(
    groupBy(
      lines,
      (line) =>
        `${line.sourceId || ""}::${line.locationId || ""}::${line.itemId || line.itemName}`,
    ).entries(),
  ).map(([key, rows]) => {
    const first = rows[0] || {};
    const expectedQty = sumBy(rows, "expectedBaseQty");
    const countedQty = sumBy(rows, "convertedBaseQty");
    const varianceQty = countedQty - expectedQty;
    const unitCostExVat = weightedUnitCost(rows);
    const expectedValue = sumBy(rows, "expectedValue");
    const countedValue = sumBy(rows, "countedValue");
    const varianceValue = countedValue - expectedValue;
    return {
      id: `stock-take-item:${key}`,
      itemId: first.itemId,
      itemName: first.itemName,
      category: first.category || "General",
      locationId: first.locationId,
      locationName: first.locationName,
      expectedQty,
      countedQty,
      varianceQty,
      baseUom: first.baseUom,
      unitCostExVat,
      expectedValue,
      countedValue,
      varianceValue,
      variancePercent: calculateVariancePercent(varianceValue, expectedValue),
      stockTakeDate: first.stockTakeDate,
      committedBy: first.committedBy,
      sourceId: first.sourceId,
      transactionReference: first.transactionReference,
      __lines: rows,
    };
  });
}

function normalizeVarianceMovementRow(row = {}) {
  return {
    ...row,
    id:
      text(row.id) ||
      `stock-take-variance:${row.sourceId}:${row.itemId}:${row.locationId}`,
    date: text(row.date || row.movementDate).slice(0, 10),
    time: text(row.time || row.movementTime),
    source: text(row.source || row.sourceType || "Stock Take Variance"),
    category: text(row.category || row.categoryName) || "General",
    createdBy: text(row.createdBy || row.createdByName),
    reportSummaryRow: false,
  };
}

function buildReconciliation(lines = [], ledgerRows = []) {
  const byKey = new Map();
  for (const row of ledgerRows) {
    const key = reconcileKey(row.sourceId, row.itemId, row.locationId);
    const existing = byKey.get(key) || {
      netQty: 0,
      movementValue: 0,
      rowCount: 0,
      varianceMovementRows: 0,
    };
    existing.netQty += safeNumber(row.netQty);
    existing.movementValue += safeNumber(row.movementValue);
    existing.rowCount += 1;
    if (text(row.movementType).toLowerCase() === "stock take variance")
      existing.varianceMovementRows += 1;
    byKey.set(key, existing);
  }

  return lines.map((line) => {
    const ledger = byKey.get(
      reconcileKey(line.sourceId, line.itemId, line.locationId),
    ) || {
      netQty: safeNumber(line.ledgerNetQty),
      movementValue: safeNumber(line.ledgerMovementValue),
      rowCount: safeNumber(line.ledgerRowCount),
      varianceMovementRows: safeNumber(line.varianceMovementRowCount),
    };
    return {
      line,
      ledger,
      hasVariance: safeNumber(line.varianceQty) !== 0,
      missingLedger:
        safeNumber(line.varianceQty) !== 0 && safeNumber(ledger.rowCount) === 0,
      qtyMismatch:
        safeNumber(line.varianceQty) !== 0 &&
        safeNumber(ledger.rowCount) > 0 &&
        Math.abs(safeNumber(line.varianceQty) - safeNumber(ledger.netQty)) >
          VALUE_TOLERANCE,
      valueMismatch:
        safeNumber(line.varianceValue) !== 0 &&
        safeNumber(ledger.rowCount) > 0 &&
        Math.abs(
          safeNumber(line.varianceValue) - safeNumber(ledger.movementValue),
        ) > VALUE_TOLERANCE,
      duplicateVarianceRows: safeNumber(ledger.varianceMovementRows) > 1,
    };
  });
}

function getTotalsForView(view, rows = []) {
  const activeView = text(view || "sessions");
  if (activeView === "sessions") {
    const totalExpectedValue = sumBy(rows, "totalExpectedValue");
    const totalCountedValue = sumBy(rows, "totalCountedValue");
    const varianceValue = totalCountedValue - totalExpectedValue;
    return {
      itemsCounted: sumBy(rows, "itemsCounted"),
      itemsWithVariance: sumBy(rows, "itemsWithVariance"),
      totalExpectedValue,
      totalCountedValue,
      varianceValue,
      variancePercent: calculateVariancePercent(
        varianceValue,
        totalExpectedValue,
      ),
    };
  }
  if (activeView === "by_category") {
    const expectedValue = sumBy(rows, "expectedValue");
    const countedValue = sumBy(rows, "countedValue");
    const varianceValue = countedValue - expectedValue;
    return {
      itemsCounted: sumBy(rows, "itemsCounted"),
      itemsWithVariance: sumBy(rows, "itemsWithVariance"),
      expectedValue,
      countedValue,
      varianceValue,
      variancePercent: calculateVariancePercent(varianceValue, expectedValue),
      positiveVarianceValue: sumBy(rows, "positiveVarianceValue"),
      negativeVarianceValue: sumBy(rows, "negativeVarianceValue"),
    };
  }
  if (activeView === "by_item") {
    const expectedValue = sumBy(rows, "expectedValue");
    const countedValue = sumBy(rows, "countedValue");
    const varianceValue = countedValue - expectedValue;
    return {
      expectedQty: sumBy(rows, "expectedQty"),
      countedQty: sumBy(rows, "countedQty"),
      varianceQty: sumBy(rows, "varianceQty"),
      expectedValue,
      countedValue,
      varianceValue,
      variancePercent: calculateVariancePercent(varianceValue, expectedValue),
    };
  }
  if (activeView === "count_detail") {
    return {
      countedQty: sumBy(rows, "countedQty"),
      convertedBaseQty: sumBy(rows, "convertedBaseQty"),
      expectedBaseQty: sumBy(rows, "expectedBaseQty"),
      varianceBaseQty: sumBy(rows, "varianceBaseQty"),
    };
  }
  if (activeView === "variance_movements") {
    return {
      qtyIn: sumBy(rows, "qtyIn"),
      qtyOut: sumBy(rows, "qtyOut"),
      netQty: sumBy(rows, "netQty"),
      movementValue: sumBy(rows, "movementValue"),
    };
  }
  return {};
}

function validateStockTakeAuditRows(
  rows = [],
  _view = "sessions",
  services = {},
) {
  const rowMeta = firstMeta(rows) || {};
  const lastModel = services?.reporting?.__lastStockTakeAuditModel || {};
  const lines = toArray(rowMeta.stockTakeSourceRows || lastModel.sourceRows);
  const varianceLedgerRows = toArray(
    rowMeta.stockTakeVarianceLedgerRows || lastModel.varianceLedgerRows,
  );
  const reconciliation = toArray(
    rowMeta.reconciliation || lastModel.reconciliation,
  );
  const apiWarnings = toArray(
    rowMeta.warnings ||
      lastModel.warnings ||
      services?.reporting?.__lastStockTakeAuditWarnings,
  );
  if (!lines.length) return apiWarnings;

  return [
    ...apiWarnings,
    countWarning(
      lines,
      "stocktake-session-missing-location",
      "critical",
      "stock take line(s) are linked to sessions with no location.",
      (row) => !text(row.locationId || row.locationName),
    ),
    countWarning(
      lines,
      "stocktake-line-missing-item",
      "critical",
      "stock take line(s) have no item.",
      (row) => !text(row.itemId || row.itemName),
    ),
    countWarning(
      lines,
      "stocktake-expected-qty-missing",
      "warning",
      "stock take line(s) are missing expected quantity.",
      (row) => !hasValue(row.expectedQty),
    ),
    countWarning(
      lines,
      "stocktake-counted-qty-missing",
      "warning",
      "committed stock take line(s) are missing counted quantity.",
      (row) => isCommitted(row) && !hasValue(row.countedQty),
    ),
    countWarning(
      lines,
      "stocktake-uom-conversion-missing",
      "warning",
      "stock take line(s) are missing UOM conversion data.",
      (row) => !text(row.baseUom) || !safeNumber(row.uomRatio, 1),
    ),
    countWarning(
      lines,
      "stocktake-unit-cost-missing",
      "critical",
      "stock take line(s) are missing unit cost, so value variance cannot be trusted.",
      (row) => safeNumber(row.unitCostExVat) === 0,
    ),
    countWarning(
      lines,
      "stocktake-variance-value-missing",
      "critical",
      "stock take line(s) cannot calculate variance value.",
      (row) => !Number.isFinite(Number(row.varianceValue)),
    ),
    countWarning(
      reconciliation,
      "stocktake-variance-ledger-missing",
      "critical",
      "committed stock take variance line(s) are missing Stock Take Variance ledger rows.",
      (row) => row.missingLedger,
    ),
    countWarning(
      reconciliation,
      "stocktake-variance-ledger-qty-mismatch",
      "critical",
      "stock take variance ledger quantity does not match stock take variance.",
      (row) => row.qtyMismatch,
    ),
    countWarning(
      reconciliation,
      "stocktake-variance-ledger-value-mismatch",
      "critical",
      "stock take variance ledger value does not match stock take variance value.",
      (row) => row.valueMismatch,
    ),
    countWarning(
      reconciliation,
      "stocktake-duplicate-variance-ledger-rows",
      "critical",
      "duplicate Stock Take Variance ledger rows exist for the same source/item/location.",
      (row) => row.duplicateVarianceRows,
    ),
    countWarning(
      lines,
      "stocktake-committed-by-missing",
      "warning",
      "stock take line(s) are missing Committed By.",
      (row) => !text(row.committedBy),
    ),
    countWarning(
      lines,
      "stocktake-committed-at-missing",
      "warning",
      "stock take line(s) are missing Committed At.",
      (row) => !text(row.committedAt),
    ),
    countWarning(
      lines,
      "stocktake-recipe-only-subrecipe-counted",
      "warning",
      "recipe-only sub-recipe item(s) are counted as stock-on-hand.",
      isRecipeOnlySubRecipe,
    ),
    ...reconcileStockTakeAuditToDetailedActivity({
      stockTakeRows: varianceLedgerRows,
      detailedRows: varianceLedgerRows,
    }),
  ].filter(Boolean);
}

function withMeta(row = {}, model = {}) {
  return {
    ...row,
    __meta: {
      stockTakeSourceRows: model.sourceRows || [],
      stockTakeVarianceLedgerRows: model.varianceLedgerRows || [],
      reconciliation: model.reconciliation || [],
      warnings: model.warnings || [],
      meta: model.meta || {},
    },
  };
}

function firstMeta(rows = []) {
  return toArray(rows).find((row) => row.__meta)?.__meta || null;
}

function rememberStockTakeAuditResponse(
  services = {},
  response = {},
  model = {},
) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastStockTakeAuditResponse = response;
  services.reporting.__lastStockTakeAuditWarnings = toArray(response.warnings);
  services.reporting.__lastStockTakeAuditModel = model;
}

function normalizeStockTakeResponse(response, fallbackMeta = {}) {
  if (Array.isArray(response)) {
    return { rows: response, warnings: [], meta: fallbackMeta };
  }
  return {
    rows: toArray(response?.rows),
    warnings: toArray(response?.warnings),
    meta: { ...fallbackMeta, ...(response?.meta || {}) },
  };
}

function isStockTakeVarianceLedgerRow(row = {}) {
  const source = text(row.source || row.sourceType).toLowerCase();
  return (
    source === "stock take variance" || source.includes("stock take variance")
  );
}

function reconcileKey(sourceId = "", itemId = "", locationId = "") {
  return [sourceId, itemId, locationId]
    .map((value) => text(value).toLowerCase())
    .join("::");
}

function weightedUnitCost(rows = []) {
  const qty = sumBy(
    rows,
    (row) =>
      Math.abs(safeNumber(row.varianceQty)) ||
      safeNumber(row.expectedQty) ||
      safeNumber(row.countedQty),
  );
  if (!qty) return safeNumber(rows[0]?.unitCostExVat);
  return (
    sumBy(
      rows,
      (row) =>
        (Math.abs(safeNumber(row.varianceQty)) ||
          safeNumber(row.expectedQty) ||
          safeNumber(row.countedQty)) * safeNumber(row.unitCostExVat),
    ) / qty
  );
}

function countWarning(
  rows = [],
  code = "",
  level = "warning",
  message = "",
  predicate = () => false,
) {
  return buildRowWarnings(rows, code, level, message, predicate);
}

function hasValue(value) {
  return value !== undefined && value !== null && text(value) !== "";
}

function isCommitted(row = {}) {
  return ["posted", "committed", "closed"].includes(
    text(row.status).toLowerCase(),
  );
}

function isRecipeOnlySubRecipe(row = {}) {
  const type = text(row.itemType).toLowerCase();
  const isSubRecipe =
    type.includes("sub") || type.includes("prep") || type.includes("recipe");
  const stockedFlag = row.isStocked;
  const isNotStocked =
    stockedFlag === false ||
    stockedFlag === 0 ||
    stockedFlag === "0" ||
    String(stockedFlag).toLowerCase() === "false";
  return isSubRecipe && isNotStocked;
}

function expectedValueTooltip(row = {}) {
  return buildRowFormulaTooltip(
    "stockTakeExpectedValue",
    `${formatMoney(row.expectedValue ?? row.totalExpectedValue)} = ${formatNumber(row.expectedQty ?? row.expectedBaseQty ?? "")} x ${formatMoney(row.unitCostExVat ?? "")}`,
  );
}

function countedValueTooltip(row = {}) {
  return buildRowFormulaTooltip(
    "stockTakeCountedValue",
    `${formatMoney(row.countedValue ?? row.totalCountedValue)} = ${formatNumber(row.countedQty ?? row.convertedBaseQty ?? "")} x ${formatMoney(row.unitCostExVat ?? "")}`,
  );
}

function varianceQtyTooltip(row = {}) {
  return buildRowFormulaTooltip(
    "stockTakeVarianceQty",
    `${formatNumber(row.varianceQty ?? row.varianceBaseQty)} = ${formatNumber(row.countedQty ?? row.convertedBaseQty)} - ${formatNumber(row.expectedQty ?? row.expectedBaseQty)}`,
  );
}

function varianceValueTooltip(row = {}) {
  return buildRowFormulaTooltip(
    "stockTakeVarianceValue",
    `${formatMoney(row.varianceValue)} = ${formatMoney(row.countedValue ?? row.totalCountedValue)} - ${formatMoney(row.expectedValue ?? row.totalExpectedValue)}`,
  );
}

function variancePercentTooltip(row = {}) {
  return buildRowFormulaTooltip(
    "stockTakeVariancePercent",
    `${formatNumber((row.variancePercent || 0) * 100)}% = ${formatMoney(row.varianceValue)} / ${formatMoney(row.expectedValue ?? row.totalExpectedValue)}`,
  );
}

function convertedBaseQtyTooltip(row = {}) {
  return buildRowFormulaTooltip(
    "convertedBaseQty",
    `${formatNumber(row.convertedBaseQty)} = ${formatNumber(row.countedQty)} x ${formatNumber(row.uomRatio || 1)}`,
  );
}

export const __stockTakeAuditReportInternals = {
  buildStockTakeAuditModel,
  normalizeStockTakeRows,
  isStockTakeVarianceLedgerRow,
};

export default stockTakeAuditReport;
