import { roundMoney, safeNumber } from "../../engine/calculations.js";
import {
  applyReportFilters,
  groupBy,
  sumBy,
  text,
  toArray,
} from "../../engine/grouping.js";
import { zonedDateTimeStrings } from "../../engine/timezone.js";
import { fetchGrvLogRows } from "../../api/reportingApi.js";
import {
  firstText,
  hasValue,
  latestText,
  mapColumns,
  rememberPayload,
  topText,
  uniqueCount,
} from "./purchasingReportHelpers.js";

const moneyColumn = (key, label, tooltipKey = "") => ({
  key,
  label,
  type: "money",
  align: "right",
  sortable: true,
  ...(tooltipKey ? { tooltipKey } : {}),
});
const qtyColumn = (key, label) => ({
  key,
  label,
  type: "number",
  align: "right",
  sortable: true,
});
const numberColumn = (key, label) => ({
  key,
  label,
  type: "number",
  align: "right",
  sortable: true,
});

const summaryColumns = [
  { key: "grvDate", label: "GRV Date & Time", type: "datetime", sortable: true },
  { key: "grvNumber", label: "GRV Number", sortable: true },
  { key: "supplierName", label: "Supplier", sortable: true },
  { key: "invoiceNumber", label: "Invoice Number", sortable: true },
  { key: "purchaseOrderNumber", label: "Purchase Order", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  numberColumn("itemsReceived", "Items Received"),
  qtyColumn("totalQtyReceived", "Total Qty Received"),
  moneyColumn("totalValueExVat", "Total Value Ex VAT", "grvTotalValueExVat"),
  moneyColumn("vat", "VAT"),
  moneyColumn("totalValueInclVat", "Total Value Incl VAT"),
  { key: "status", label: "Status", sortable: true },
  { key: "committedBy", label: "Committed By", sortable: true },
  {
    key: "committedAt",
    label: "Committed At",
    type: "datetime",
    sortable: true,
  },
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
];

const bySupplierColumns = [
  { key: "supplierName", label: "Supplier", sortable: true },
  numberColumn("grvs", "GRVs"),
  numberColumn("itemsReceived", "Items Received"),
  qtyColumn("totalQtyReceived", "Total Qty Received"),
  moneyColumn("totalValueExVat", "Total Value Ex VAT"),
  moneyColumn("vat", "VAT"),
  moneyColumn("totalValueInclVat", "Total Value Incl VAT"),
  { key: "lastGrvDate", label: "Last GRV Date", type: "date", sortable: true },
];

const byLocationColumns = [
  { key: "locationName", label: "Location", sortable: true },
  numberColumn("grvs", "GRVs"),
  numberColumn("itemsReceived", "Items Received"),
  qtyColumn("totalQtyReceived", "Total Qty Received"),
  moneyColumn("totalValueExVat", "Total Value Ex VAT"),
  moneyColumn("vat", "VAT"),
  moneyColumn("totalValueInclVat", "Total Value Incl VAT"),
  { key: "lastGrvDate", label: "Last GRV Date", type: "date", sortable: true },
];

const byItemColumns = [
  { key: "itemName", label: "Item", sortable: true },
  { key: "category", label: "Category", sortable: true },
  { key: "supplierName", label: "Supplier", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  qtyColumn("qtyReceived", "Qty Received"),
  { key: "baseUom", label: "Base UOM", sortable: true },
  moneyColumn("unitCostExVat", "Unit Cost Ex VAT", "unitCostExVat"),
  moneyColumn(
    "receivedValueExVat",
    "Received Value Ex VAT",
    "grvLineValueExVat",
  ),
  {
    key: "lastReceivedDate",
    label: "Last Received Date",
    type: "date",
    sortable: true,
  },
  numberColumn("grvCount", "GRV Count"),
];

const lineDetailColumns = [
  { key: "grvDate", label: "GRV Date", type: "date", sortable: true },
  { key: "grvNumber", label: "GRV Number", sortable: true },
  { key: "supplierName", label: "Supplier", sortable: true },
  { key: "invoiceNumber", label: "Invoice Number", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  { key: "itemName", label: "Item", sortable: true },
  { key: "category", label: "Category", sortable: true },
  qtyColumn("receivedQty", "Received Qty"),
  { key: "baseUom", label: "Base UOM", sortable: true },
  moneyColumn("unitCostExVat", "Unit Cost Ex VAT", "unitCostExVat"),
  moneyColumn("lineValueExVat", "Line Value Ex VAT", "grvLineValueExVat"),
  moneyColumn("vat", "VAT"),
  moneyColumn("lineValueInclVat", "Line Value Incl VAT"),
  { key: "status", label: "Status", sortable: true },
  { key: "committedBy", label: "Committed By", sortable: true },
  {
    key: "committedAt",
    label: "Committed At",
    type: "datetime",
    sortable: true,
  },
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
];

export const grvLogReport = {
  id: "grv_log",
  title: "GRV Log",
  section: "purchasing",
  description:
    "GRV audit report showing goods received, suppliers, invoice numbers, received quantities, received value, and stock impact.",
  emptyState: {
    title: "No GRVs found",
    message: "No GRV rows matched the selected filters.",
  },
  suppressEmptyWarning: true,
  defaultView: "summary",
  availableViews: [
    "summary",
    "by_supplier",
    "by_location",
    "by_item",
    "line_detail",
  ],
  filterConfig: {
    default: ["search", "dateRange", "location", "supplier", "status"],
    by_item: [
      "search",
      "dateRange",
      "location",
      "category",
      "supplier",
      "status",
    ],
    line_detail: [
      "search",
      "dateRange",
      "location",
      "category",
      "supplier",
      "status",
    ],
  },
  columns: {
    summary: summaryColumns,
    by_supplier: bySupplierColumns,
    by_location: byLocationColumns,
    by_item: byItemColumns,
    line_detail: lineDetailColumns,
  },
  exportMapping: {
    summary: mapColumns(summaryColumns),
    by_supplier: mapColumns(bySupplierColumns),
    by_location: mapColumns(byLocationColumns),
    by_item: mapColumns(byItemColumns),
    line_detail: {
      grvDate: "GRV Date",
      grvNumber: "GRV Number",
      supplierName: "Supplier",
      invoiceNumber: "Invoice Number",
      locationName: "Location",
      itemName: "Item",
      category: "Category",
      receivedQty: "Received Qty",
      baseUom: "UOM",
      unitCostExVat: "Unit Cost Ex VAT",
      lineValueExVat: "Line Value Ex VAT",
      vat: "VAT",
      lineValueInclVat: "Line Value Incl VAT",
      status: "Status",
      committedBy: "Committed By",
      committedAt: "Committed At",
      transactionReference: "Transaction ID",
    },
  },
  getRows: async ({
    workspaceId,
    filters,
    services = {},
    view = "summary",
  }) => {
    const payload = services.reporting?.getGrvLogRows
      ? await services.reporting.getGrvLogRows({ workspaceId, filters })
      : await fetchGrvLogRows({ workspaceId, filters });
    rememberPayload(services, "__lastGrvLogPayload", payload);
    const timeZone =
      payload.meta?.timeZone || payload.meta?.timezone || "Africa/Johannesburg";
    const lineRows = applyReportFilters(
      toArray(payload.rows).map((row, index) => normalizeLine(row, index, timeZone)),
      filters,
    );
    const views = buildGrvViews(lineRows);
    return (views[view] || views.summary).map((row) => ({
      ...row,
      __apiWarnings: payload.warnings || [],
      __apiMeta: payload.meta || {},
    }));
  },
  getTotals: ({ rows, view }) => buildTotals(rows, view),
  validate: ({ rows, services, view }) => {
    const warnings = [
      ...toArray(services?.reporting?.__lastGrvLogPayload?.warnings),
    ];
    if (!rows.length || view !== "line_detail") return warnings;
    addCountWarning(
      rows,
      warnings,
      "grv-missing-supplier",
      "critical",
      "GRV line(s) have no supplier.",
      (row) => !text(row.supplierName),
    );
    addCountWarning(
      rows,
      warnings,
      "grv-missing-location",
      "critical",
      "GRV line(s) have no location.",
      (row) => !text(row.locationName),
    );
    addCountWarning(
      rows,
      warnings,
      "grv-missing-invoice",
      "warning",
      "GRV line(s) require an invoice number.",
      (row) => row.invoiceRequired && !text(row.invoiceNumber),
    );
    addCountWarning(
      rows,
      warnings,
      "grv-missing-item",
      "critical",
      "GRV line(s) have no item.",
      (row) => !text(row.itemName),
    );
    addCountWarning(
      rows,
      warnings,
      "grv-missing-quantity",
      "critical",
      "GRV line(s) have no received quantity.",
      (row) => !safeNumber(row.receivedQty),
    );
    addCountWarning(
      rows,
      warnings,
      "grv-missing-unit-cost",
      "critical",
      "GRV line(s) have no unit cost.",
      (row) => !safeNumber(row.unitCostExVat),
    );
    addCountWarning(
      rows,
      warnings,
      "grv-missing-vat",
      "warning",
      "GRV line(s) have a received value but no VAT figure — VAT was reported as R0 rather than calculated.",
      (row) => !row.hasVat,
    );
    addCountWarning(
      rows,
      warnings,
      "grv-missing-stock-movement",
      "critical",
      "committed GRV line(s) have no stock movement row.",
      (row) => safeNumber(row.ledgerRowCount) === 0,
    );
    addCountWarning(
      rows,
      warnings,
      "grv-duplicate-stock-movement",
      "critical",
      "GRV line(s) have duplicate stock movement rows.",
      (row) => safeNumber(row.ledgerRowCount) > 1,
    );
    addCountWarning(
      rows,
      warnings,
      "grv-ledger-qty-mismatch",
      "critical",
      "GRV line(s) do not reconcile to Detailed Activity quantity.",
      (row) =>
        Math.abs(safeNumber(row.ledgerQty) - safeNumber(row.receivedQty)) >
        0.0001,
    );
    addCountWarning(
      rows,
      warnings,
      "grv-ledger-value-mismatch",
      "critical",
      "GRV line(s) do not reconcile to Detailed Activity value.",
      (row) =>
        Math.abs(safeNumber(row.ledgerValue) - safeNumber(row.lineValueExVat)) >
        0.01,
    );
    return warnings;
  },
};

export function buildGrvViews(rows = []) {
  const summaries = buildSummary(rows);
  return {
    summary: summaries,
    by_supplier: buildBySupplier(summaries),
    by_location: buildByLocation(summaries),
    by_item: buildByItem(rows),
    line_detail: rows,
  };
}

function normalizeLine(row = {}, index = 0, timeZone = "Africa/Johannesburg") {
  const receivedQty = safeNumber(
    row.receivedQty ?? row.received_qty ?? row.quantity,
  );
  const unitCostExVat = safeNumber(
    row.unitCostExVat ??
      row.unit_cost_ex_vat ??
      row.unitPrice ??
      row.unit_price,
  );
  const lineValueExVat =
    row.lineValueExVat !== undefined
      ? safeNumber(row.lineValueExVat)
      : roundMoney(receivedQty * unitCostExVat);
  const vatSupplied = hasValue(row.vat) || hasValue(row.lineVat) || hasValue(row.line_vat);
  const vat = safeNumber(row.vat ?? row.lineVat ?? row.line_vat);
  const lineValueInclVat =
    row.lineValueInclVat !== undefined
      ? safeNumber(row.lineValueInclVat)
      : roundMoney(lineValueExVat + vat);
  return {
    ...row,
    // A GRV line with a real ex-VAT value but no VAT field at all is a data gap, not a genuine
    // zero — flagged by the `grv-missing-vat` validator below instead of silently understating
    // `lineValueInclVat`/workspace totals with no indication anything is wrong.
    hasVat: vatSupplied || lineValueExVat <= 0,
    id: text(row.id) || `grv-line:${text(row.sourceId || row.grvId)}:${index}`,
    grvId: text(row.grvId || row.grv_id || row.sourceId),
    sourceId: text(row.sourceId || row.grvId || row.grv_id),
    transactionReference: text(
      row.transactionReference ||
        row.transaction_reference ||
        row.grvNumber ||
        row.grv_number ||
        row.sourceId,
    ),
    // Aliased for applyReportFilters, which resolves a row's comparable date from
    // `date`/`timestamp`/`createdAt` and otherwise has no notion of grvDate. grvDate is a full UTC
    // instant (e.g. "2026-08-29T22:51:40.000Z"), not a pre-localized date -- normalizeComparableDate
    // takes an ISO date verbatim from its first 10 characters with NO timezone conversion, which is
    // correct for an already-local date string but silently takes the UTC calendar day for a raw
    // instant. For a GRV logged at 00:51 SAST (=22:51 UTC the PREVIOUS day), that naive slice reads
    // as "yesterday" and got the row wrongly excluded from "Today" even though the backend's own
    // (correctly timezone-aware) filtering had already included it. Convert to the workspace's
    // reporting timezone first so the comparable date always matches the backend's own idea of
    // which calendar day this row belongs to.
    date: zonedDateTimeStrings(
      row.grvDate || row.grv_date || row.receivedAt || row.received_at,
      timeZone,
    ).date,
    grvDate: text(
      row.grvDate || row.grv_date || row.receivedAt || row.received_at,
    ),
    grvNumber: text(
      row.grvNumber ||
        row.grv_number ||
        row.invoiceNumber ||
        row.invoice_number ||
        row.sourceId,
    ),
    supplierId: text(row.supplierId || row.supplier_id),
    supplierName: text(row.supplierName || row.supplier_name),
    invoiceNumber: text(row.invoiceNumber || row.invoice_number),
    purchaseOrderNumber: text(row.purchaseOrderNumber || row.purchase_order_number || row.poNumber || row.po_number),
    invoiceRequired: Boolean(
      row.invoiceRequired ??
      row.invoice_required ??
      row.requiresInvoice ??
      row.requires_invoice,
    ),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    itemId: text(row.itemId || row.stockItemId || row.stock_item_id),
    itemName: text(row.itemName || row.item_name),
    category:
      text(row.category || row.categoryName || row.category_name) || "General",
    receivedQty,
    baseUom: text(row.baseUom || row.base_uom || row.unit),
    unitCostExVat,
    lineValueExVat,
    vat,
    lineValueInclVat,
    status: text(row.status || "Committed"),
    committedBy: text(
      row.committedByName ||
        row.committed_by_name ||
        row.committedBy ||
        row.committed_by,
    ),
    committedAt: text(
      row.committedAt || row.committed_at || row.receivedAt || row.received_at,
    ),
    // Normalized the same way as ledgerValue below — both feed parallel reconciliation checks
    // (grv-ledger-qty-mismatch / grv-ledger-value-mismatch) against receivedQty/lineValueExVat,
    // which are themselves always positive magnitudes. A signed ledger quantity (e.g. a
    // correction/reversal) would otherwise fail the qty check while the value check on the exact
    // same row correctly reconciled.
    ledgerQty: Math.abs(safeNumber(row.ledgerQty ?? row.ledger_qty)),
    ledgerValue: Math.abs(safeNumber(row.ledgerValue ?? row.ledger_value)),
    ledgerRowCount: safeNumber(row.ledgerRowCount ?? row.ledger_row_count),
  };
}

function buildSummary(rows) {
  return Array.from(
    groupBy(
      rows,
      (row) => row.grvId || row.sourceId || row.grvNumber,
    ).entries(),
  ).map(([key, group]) => ({
    id: `grv-summary:${key}`,
    grvId: firstText(group, "grvId"),
    sourceId: firstText(group, "sourceId", key),
    transactionReference: firstText(group, "transactionReference"),
    grvDate: firstText(group, "grvDate"),
    grvNumber: firstText(group, "grvNumber", key),
    supplierId: firstText(group, "supplierId"),
    supplierName: firstText(group, "supplierName"),
    invoiceNumber: firstText(group, "invoiceNumber"),
    purchaseOrderNumber: firstText(group, "purchaseOrderNumber"),
    locationId:
      uniqueCount(group, "locationId") === 1
        ? firstText(group, "locationId")
        : "",
    locationName:
      uniqueCount(group, "locationName") === 1
        ? firstText(group, "locationName")
        : "Multiple Locations",
    itemsReceived: uniqueCount(group, (row) => row.itemId || row.itemName),
    totalQtyReceived: sumBy(group, "receivedQty"),
    totalValueExVat: roundMoney(sumBy(group, "lineValueExVat")),
    vat: roundMoney(sumBy(group, "vat")),
    totalValueInclVat: roundMoney(sumBy(group, "lineValueInclVat")),
    status: firstText(group, "status", "Committed"),
    committedBy: firstText(group, "committedBy"),
    committedAt: firstText(group, "committedAt"),
    reconciled: group.every(
      (row) =>
        row.ledgerRowCount === 1 &&
        Math.abs(row.ledgerQty - row.receivedQty) <= 0.0001 &&
        Math.abs(row.ledgerValue - row.lineValueExVat) <= 0.01,
    ),
  }));
}

function buildBySupplier(rows) {
  return Array.from(
    groupBy(
      rows,
      (row) => row.supplierId || row.supplierName || "Missing Supplier",
    ).entries(),
  ).map(([key, group]) => ({
    id: `grv-supplier:${key}`,
    supplierId: firstText(group, "supplierId"),
    supplierName: firstText(group, "supplierName", "Missing Supplier"),
    grvs: group.length,
    itemsReceived: sumBy(group, "itemsReceived"),
    totalQtyReceived: sumBy(group, "totalQtyReceived"),
    totalValueExVat: roundMoney(sumBy(group, "totalValueExVat")),
    vat: roundMoney(sumBy(group, "vat")),
    totalValueInclVat: roundMoney(sumBy(group, "totalValueInclVat")),
    lastGrvDate: latestText(group, "grvDate"),
  }));
}

function buildByLocation(rows) {
  return Array.from(
    groupBy(
      rows,
      (row) => row.locationId || row.locationName || "Missing Location",
    ).entries(),
  ).map(([key, group]) => ({
    id: `grv-location:${key}`,
    locationId: firstText(group, "locationId"),
    locationName: firstText(group, "locationName", "Missing Location"),
    grvs: group.length,
    itemsReceived: sumBy(group, "itemsReceived"),
    totalQtyReceived: sumBy(group, "totalQtyReceived"),
    totalValueExVat: roundMoney(sumBy(group, "totalValueExVat")),
    vat: roundMoney(sumBy(group, "vat")),
    totalValueInclVat: roundMoney(sumBy(group, "totalValueInclVat")),
    lastGrvDate: latestText(group, "grvDate"),
  }));
}

function buildByItem(rows) {
  return Array.from(
    groupBy(
      rows,
      (row) =>
        `${row.itemId || row.itemName}::${row.supplierId || row.supplierName}::${row.locationId || row.locationName}`,
    ).entries(),
  ).map(([key, group]) => {
    const qtyReceived = sumBy(group, "receivedQty");
    const receivedValueExVat = roundMoney(sumBy(group, "lineValueExVat"));
    return {
      id: `grv-item:${key}`,
      itemId: firstText(group, "itemId"),
      itemName: firstText(group, "itemName"),
      category: firstText(group, "category", "General"),
      supplierId: firstText(group, "supplierId"),
      supplierName: firstText(group, "supplierName"),
      locationId: firstText(group, "locationId"),
      locationName: firstText(group, "locationName"),
      qtyReceived,
      baseUom: firstText(group, "baseUom"),
      unitCostExVat: qtyReceived
        ? roundMoney(receivedValueExVat / qtyReceived)
        : 0,
      receivedValueExVat,
      lastReceivedDate: latestText(group, "grvDate"),
      grvCount: uniqueCount(group, (row) => row.grvId || row.sourceId),
    };
  });
}

function buildTotals(rows, view) {
  if (view === "line_detail")
    return {
      receivedQty: sumBy(rows, "receivedQty"),
      lineValueExVat: roundMoney(sumBy(rows, "lineValueExVat")),
      vat: roundMoney(sumBy(rows, "vat")),
      lineValueInclVat: roundMoney(sumBy(rows, "lineValueInclVat")),
    };
  if (view === "by_item")
    return {
      qtyReceived: sumBy(rows, "qtyReceived"),
      receivedValueExVat: roundMoney(sumBy(rows, "receivedValueExVat")),
      grvCount: sumBy(rows, "grvCount"),
    };
  return {
    grvs: sumBy(rows, "grvs") || rows.length,
    itemsReceived: sumBy(rows, "itemsReceived"),
    totalQtyReceived: sumBy(rows, "totalQtyReceived"),
    totalValueExVat: roundMoney(sumBy(rows, "totalValueExVat")),
    vat: roundMoney(sumBy(rows, "vat")),
    totalValueInclVat: roundMoney(sumBy(rows, "totalValueInclVat")),
  };
}

function addCountWarning(rows, warnings, code, level, message, predicate) {
  if (warnings.some((warning) => warning?.code === code)) return;
  const count = rows.filter(predicate).length;
  if (count) warnings.push({ code, level, message: `${count} ${message}` });
}

export default grvLogReport;
