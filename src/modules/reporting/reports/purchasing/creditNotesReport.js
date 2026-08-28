import { roundMoney, safeNumber } from "../../engine/calculations.js";
import { groupBy, sumBy, text, toArray } from "../../engine/grouping.js";
import { fetchCreditNoteReportRows } from "../../api/reportingApi.js";
import {
  firstText,
  hasValue,
  latestText,
  mapColumns,
  rememberPayload,
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
  {
    key: "creditNoteDate",
    label: "Credit Note Date",
    type: "datetime",
    sortable: true,
  },
  { key: "creditNoteNumber", label: "Credit Note Number", sortable: true },
  { key: "supplierName", label: "Supplier", sortable: true },
  {
    key: "originalInvoiceGrv",
    label: "Original Invoice / GRV",
    sortable: true,
  },
  { key: "locationName", label: "Location", sortable: true },
  { key: "reason", label: "Reason", sortable: true },
  { key: "status", label: "Status", sortable: true },
  numberColumn("items", "Items"),
  moneyColumn("creditValueExVat", "Credit Value Ex VAT"),
  moneyColumn("vat", "VAT", "creditNoteVat"),
  moneyColumn("creditValueInclVat", "Credit Value Incl VAT"),
  { key: "stockImpact", label: "Stock Impact", sortable: true },
  { key: "createdBy", label: "Created By", sortable: true },
  { key: "committedBy", label: "Committed By", sortable: true },
  { key: "committedAt", label: "Committed At", type: "datetime", sortable: true },
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
];

const bySupplierColumns = [
  { key: "supplierName", label: "Supplier", sortable: true },
  numberColumn("creditNotes", "Credit Notes"),
  moneyColumn("creditValueExVat", "Credit Value Ex VAT"),
  moneyColumn("vat", "VAT"),
  moneyColumn("creditValueInclVat", "Credit Value Incl VAT"),
  numberColumn("stockImpactCount", "Stock Impact Count"),
  {
    key: "lastCreditNoteDate",
    label: "Last Credit Note Date",
    type: "date",
    sortable: true,
  },
];

const byLocationColumns = [
  { key: "locationName", label: "Location", sortable: true },
  numberColumn("creditNotes", "Credit Notes"),
  moneyColumn("creditValueExVat", "Credit Value Ex VAT"),
  moneyColumn("vat", "VAT"),
  moneyColumn("creditValueInclVat", "Credit Value Incl VAT"),
  numberColumn("stockImpactCount", "Stock Impact Count"),
];

const byReasonColumns = [
  { key: "reason", label: "Reason", sortable: true },
  numberColumn("creditNotes", "Credit Notes"),
  numberColumn("items", "Items"),
  moneyColumn("creditValueExVat", "Credit Value Ex VAT"),
  moneyColumn("vat", "VAT"),
  moneyColumn("creditValueInclVat", "Credit Value Incl VAT"),
  numberColumn("stockImpactCount", "Stock Impact Count"),
];

const lineDetailColumns = [
  {
    key: "creditNoteDate",
    label: "Credit Note Date",
    type: "date",
    sortable: true,
  },
  { key: "creditNoteNumber", label: "Credit Note Number", sortable: true },
  { key: "supplierName", label: "Supplier", sortable: true },
  {
    key: "originalInvoiceGrv",
    label: "Original Invoice / GRV",
    sortable: true,
  },
  { key: "locationName", label: "Location", sortable: true },
  { key: "itemName", label: "Item", sortable: true },
  { key: "category", label: "Category", sortable: true },
  { key: "reason", label: "Reason", sortable: true },
  qtyColumn("qtyCredited", "Qty Credited"),
  { key: "baseUom", label: "Base UOM", sortable: true },
  moneyColumn("unitCostExVat", "Unit Cost Ex VAT", "unitCostExVat"),
  moneyColumn("lineCreditExVat", "Line Credit Ex VAT", "creditLineValueExVat"),
  moneyColumn("vat", "VAT", "creditNoteVat"),
  moneyColumn("lineCreditInclVat", "Line Credit Incl VAT"),
  { key: "stockImpact", label: "Stock Impact", sortable: true },
  { key: "createdBy", label: "Created By", sortable: true },
  { key: "committedBy", label: "Committed By", sortable: true },
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
];

export const creditNotesReport = {
  id: "credit_notes_report",
  exportFileNameBase: "credit-notes",
  title: "Credit Notes",
  section: "purchasing",
  description:
    "Credit note report showing supplier credits, original invoice/GRV links, reasons, credit value, VAT, and stock impact.",
  emptyState: {
    title: "No credit notes found",
    message: "No credit note rows matched the selected filters.",
  },
  suppressEmptyWarning: true,
  defaultView: "summary",
  availableViews: [
    "summary",
    "by_supplier",
    "by_location",
    "by_reason",
    "line_detail",
  ],
  filterConfig: {
    default: ["search", "dateRange", "location", "supplier", "status"],
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
    by_reason: byReasonColumns,
    line_detail: lineDetailColumns,
  },
  exportMapping: {
    summary: mapColumns(summaryColumns),
    by_supplier: mapColumns(bySupplierColumns),
    by_location: mapColumns(byLocationColumns),
    by_reason: mapColumns(byReasonColumns),
    line_detail: {
      creditNoteDate: "Credit Note Date",
      creditNoteNumber: "Credit Note Number",
      supplierName: "Supplier",
      originalInvoiceGrv: "Original Invoice / GRV",
      locationName: "Location",
      itemName: "Item",
      category: "Category",
      reason: "Reason",
      qtyCredited: "Qty Credited",
      baseUom: "UOM",
      unitCostExVat: "Unit Cost Ex VAT",
      lineCreditExVat: "Line Credit Ex VAT",
      vat: "VAT",
      lineCreditInclVat: "Line Credit Incl VAT",
      stockImpact: "Stock Impact",
      createdBy: "Created By",
      committedBy: "Committed By",
      transactionReference: "Transaction ID",
    },
  },
  getRows: async ({
    workspaceId,
    filters,
    services = {},
    view = "summary",
  }) => {
    const payload = services.reporting?.getCreditNoteReportRows
      ? await services.reporting.getCreditNoteReportRows({
          workspaceId,
          filters,
        })
      : await fetchCreditNoteReportRows({ workspaceId, filters });
    rememberPayload(services, "__lastCreditNoteReportPayload", payload);
    const lineRows = toArray(payload.rows).map(normalizeLine);
    const views = buildCreditNoteViews(lineRows);
    return (views[view] || views.summary).map((row) => ({
      ...row,
      __apiWarnings: payload.warnings || [],
      __apiMeta: payload.meta || {},
    }));
  },
  getTotals: ({ rows, view }) => buildTotals(rows, view),
  validate: ({ rows, services, view }) => {
    const warnings = [
      ...toArray(services?.reporting?.__lastCreditNoteReportPayload?.warnings),
    ];
    if (!rows.length || view !== "line_detail") return warnings;
    addCountWarning(
      rows,
      warnings,
      "credit-note-missing-supplier",
      "critical",
      "credit note line(s) have no supplier.",
      (row) => !text(row.supplierName),
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-missing-source",
      "warning",
      "credit note line(s) require an original invoice or GRV link.",
      (row) => row.requiresSourceLink && !text(row.originalInvoiceGrv),
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-missing-reason",
      "critical",
      "credit note line(s) have no reason.",
      (row) => !text(row.reason),
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-stock-impact-unclear",
      "critical",
      "credit note line(s) have unclear stock impact.",
      (row) =>
        ![
          "Stock Returned",
          "Stock Removed",
          "Financial Only",
          "No Stock Impact",
        ].includes(row.stockImpact),
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-missing-stock-movement",
      "critical",
      "stock-impacting credit note line(s) have no stock movement row.",
      (row) =>
        ["Stock Returned", "Stock Removed"].includes(row.stockImpact) &&
        safeNumber(row.ledgerRowCount) === 0,
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-missing-vat",
      "warning",
      "credit note line(s) have a credit value but no VAT figure — VAT was reported as R0 rather than calculated.",
      (row) => !row.hasVat,
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-missing-item",
      "critical",
      "credit note line(s) have no item.",
      (row) => !text(row.itemName),
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-missing-quantity",
      "critical",
      "credit note line(s) have no quantity.",
      (row) => !safeNumber(row.qtyCredited),
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-missing-unit-cost",
      "critical",
      "credit note line(s) have no unit cost.",
      (row) => !safeNumber(row.unitCostExVat),
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-ledger-qty-mismatch",
      "critical",
      "stock-impacting credit note line(s) do not reconcile to Detailed Activity quantity.",
      (row) =>
        ["Stock Returned", "Stock Removed"].includes(row.stockImpact) &&
        Math.abs(
          Math.abs(safeNumber(row.ledgerQty)) - safeNumber(row.qtyCredited),
        ) > 0.0001,
    );
    addCountWarning(
      rows,
      warnings,
      "credit-note-ledger-value-mismatch",
      "critical",
      "stock-impacting credit note line(s) do not reconcile to Detailed Activity value.",
      (row) =>
        ["Stock Returned", "Stock Removed"].includes(row.stockImpact) &&
        Math.abs(
          Math.abs(safeNumber(row.ledgerValue)) -
            safeNumber(row.lineCreditExVat),
        ) > 0.01,
    );
    return warnings;
  },
};

export function buildCreditNoteViews(rows = []) {
  const summaries = buildSummary(rows);
  return {
    summary: summaries,
    by_supplier: buildBySupplier(summaries),
    by_location: buildByLocation(summaries),
    by_reason: buildByReason(summaries),
    line_detail: rows,
  };
}

function normalizeLine(row = {}, index = 0) {
  const qtyCredited = safeNumber(
    row.qtyCredited ?? row.qty_credited ?? row.quantity,
  );
  const unitCostExVat = safeNumber(
    row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost,
  );
  const lineCreditExVat =
    row.lineCreditExVat !== undefined
      ? safeNumber(row.lineCreditExVat)
      : roundMoney(qtyCredited * unitCostExVat);
  const vatSupplied = hasValue(row.vat) || hasValue(row.lineVat) || hasValue(row.line_vat);
  const vat = safeNumber(row.vat ?? row.lineVat ?? row.line_vat);
  const lineCreditInclVat =
    row.lineCreditInclVat !== undefined
      ? safeNumber(row.lineCreditInclVat)
      : roundMoney(lineCreditExVat + vat);
  return {
    ...row,
    // A credit-note line with a real ex-VAT value but no VAT field at all is a data gap, not a
    // genuine zero — flagged by the `credit-note-missing-vat` validator below instead of silently
    // understating `lineCreditInclVat`/workspace totals with no indication anything is wrong.
    hasVat: vatSupplied || lineCreditExVat <= 0,
    id:
      text(row.id) ||
      `credit-note-line:${text(row.sourceId || row.creditNoteId)}:${index}`,
    creditNoteId: text(row.creditNoteId || row.credit_note_id || row.sourceId),
    sourceId: text(row.sourceId || row.creditNoteId || row.credit_note_id),
    transactionReference: text(
      row.transactionReference || row.transaction_reference || row.sourceId,
    ),
    creditNoteDate: text(
      row.creditNoteDate ||
        row.credit_note_date ||
        row.creditedAt ||
        row.credited_at,
    ),
    creditNoteNumber: text(
      row.creditNoteNumber || row.credit_note_number || row.sourceId,
    ),
    supplierId: text(row.supplierId || row.supplier_id),
    supplierName: text(row.supplierName || row.supplier_name),
    originalInvoiceGrv: text(
      row.originalInvoiceGrv || row.original_invoice_grv,
    ),
    requiresSourceLink: Boolean(
      row.requiresSourceLink ??
      row.requires_source_link ??
      row.sourceRequired ??
      row.source_required,
    ),
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    itemId: text(row.itemId || row.stockItemId || row.stock_item_id),
    itemName: text(row.itemName || row.item_name),
    category:
      text(row.category || row.categoryName || row.category_name) || "General",
    reason: text(row.reason),
    qtyCredited,
    baseUom: text(row.baseUom || row.base_uom || row.unit),
    unitCostExVat,
    lineCreditExVat,
    vat,
    lineCreditInclVat,
    stockImpact: normalizeStockImpact(
      row.stockImpact || row.stock_impact,
      row.ledgerQty ?? row.ledger_qty,
      row.financialOnly ?? row.financial_only,
    ),
    status: text(row.status || "Committed"),
    createdBy: text(
      row.createdByName ||
        row.created_by_name ||
        row.createdBy ||
        row.created_by,
    ),
    committedAt: text(row.committedAt || row.committed_at || row.creditedAt || row.credited_at),
    committedBy: text(
      row.committedByName ||
        row.committed_by_name ||
        row.committedBy ||
        row.committed_by ||
        row.createdByName ||
        row.created_by_name ||
        row.createdBy ||
        row.created_by,
    ),
    ledgerQty: safeNumber(row.ledgerQty ?? row.ledger_qty),
    ledgerValue: safeNumber(row.ledgerValue ?? row.ledger_value),
    ledgerRowCount: safeNumber(row.ledgerRowCount ?? row.ledger_row_count),
  };
}

function normalizeStockImpact(value, ledgerQty, financialOnly) {
  const clean = text(value).toLowerCase().replace(/[_-]+/g, " ");
  if (clean.includes("return")) return "Stock Returned";
  if (
    clean.includes("remove") ||
    clean.includes("deduct") ||
    clean.includes("out")
  )
    return "Stock Removed";
  if (
    clean.includes("financial") ||
    financialOnly === true ||
    financialOnly === 1
  )
    return "Financial Only";
  if (clean.includes("no stock")) return "No Stock Impact";
  if (safeNumber(ledgerQty) > 0) return "Stock Returned";
  if (safeNumber(ledgerQty) < 0) return "Stock Removed";
  return "No Stock Impact";
}

function buildSummary(rows) {
  return Array.from(
    groupBy(
      rows,
      (row) => row.creditNoteId || row.sourceId || row.creditNoteNumber,
    ).entries(),
  ).map(([key, group]) => ({
    id: `credit-note-summary:${key}`,
    creditNoteId: firstText(group, "creditNoteId"),
    sourceId: firstText(group, "sourceId", key),
    transactionReference: firstText(group, "transactionReference"),
    creditNoteDate: firstText(group, "creditNoteDate"),
    creditNoteNumber: firstText(group, "creditNoteNumber", key),
    supplierId: firstText(group, "supplierId"),
    supplierName: firstText(group, "supplierName"),
    originalInvoiceGrv: firstText(group, "originalInvoiceGrv"),
    locationId:
      uniqueCount(group, "locationId") === 1
        ? firstText(group, "locationId")
        : "",
    locationName:
      uniqueCount(group, "locationName") === 1
        ? firstText(group, "locationName")
        : "Multiple Locations",
    reason: firstText(group, "reason"),
    status: firstText(group, "status", "Committed"),
    items: uniqueCount(group, (row) => row.itemId || row.itemName),
    creditValueExVat: roundMoney(sumBy(group, "lineCreditExVat")),
    vat: roundMoney(sumBy(group, "vat")),
    creditValueInclVat: roundMoney(sumBy(group, "lineCreditInclVat")),
    stockImpact: summarizeImpact(group),
    createdBy: firstText(group, "createdBy"),
    committedBy: firstText(group, "committedBy"),
    committedAt: firstText(group, "committedAt"),
  }));
}

function summarizeImpact(group) {
  const impacts = [
    ...new Set(group.map((row) => row.stockImpact).filter(Boolean)),
  ];
  return impacts.length === 1
    ? impacts[0]
    : impacts.includes("Stock Removed")
      ? "Stock Removed"
      : impacts.includes("Stock Returned")
        ? "Stock Returned"
        : impacts.includes("Financial Only")
          ? "Financial Only"
          : "No Stock Impact";
}

function buildBySupplier(rows) {
  return Array.from(
    groupBy(
      rows,
      (row) => row.supplierId || row.supplierName || "Missing Supplier",
    ).entries(),
  ).map(([key, group]) => ({
    id: `credit-note-supplier:${key}`,
    supplierId: firstText(group, "supplierId"),
    supplierName: firstText(group, "supplierName", "Missing Supplier"),
    creditNotes: group.length,
    creditValueExVat: roundMoney(sumBy(group, "creditValueExVat")),
    vat: roundMoney(sumBy(group, "vat")),
    creditValueInclVat: roundMoney(sumBy(group, "creditValueInclVat")),
    stockImpactCount: group.filter((row) =>
      ["Stock Returned", "Stock Removed"].includes(row.stockImpact),
    ).length,
    lastCreditNoteDate: latestText(group, "creditNoteDate"),
  }));
}

function buildByLocation(rows) {
  return Array.from(
    groupBy(
      rows,
      (row) => row.locationId || row.locationName || "Missing Location",
    ).entries(),
  ).map(([key, group]) => ({
    id: `credit-note-location:${key}`,
    locationId: firstText(group, "locationId"),
    locationName: firstText(group, "locationName", "Missing Location"),
    creditNotes: group.length,
    creditValueExVat: roundMoney(sumBy(group, "creditValueExVat")),
    vat: roundMoney(sumBy(group, "vat")),
    creditValueInclVat: roundMoney(sumBy(group, "creditValueInclVat")),
    stockImpactCount: group.filter((row) =>
      ["Stock Returned", "Stock Removed"].includes(row.stockImpact),
    ).length,
  }));
}

function buildByReason(rows) {
  return Array.from(
    groupBy(rows, (row) => row.reason || "No Reason").entries(),
  ).map(([key, group]) => ({
    id: `credit-note-reason:${key}`,
    reason: key,
    creditNotes: group.length,
    items: sumBy(group, "items"),
    creditValueExVat: roundMoney(sumBy(group, "creditValueExVat")),
    vat: roundMoney(sumBy(group, "vat")),
    creditValueInclVat: roundMoney(sumBy(group, "creditValueInclVat")),
    stockImpactCount: group.filter((row) =>
      ["Stock Returned", "Stock Removed"].includes(row.stockImpact),
    ).length,
  }));
}

function buildTotals(rows, view) {
  if (view === "line_detail")
    return {
      qtyCredited: sumBy(rows, "qtyCredited"),
      lineCreditExVat: roundMoney(sumBy(rows, "lineCreditExVat")),
      vat: roundMoney(sumBy(rows, "vat")),
      lineCreditInclVat: roundMoney(sumBy(rows, "lineCreditInclVat")),
    };
  return {
    creditNotes: sumBy(rows, "creditNotes") || rows.length,
    items: sumBy(rows, "items"),
    creditValueExVat: roundMoney(sumBy(rows, "creditValueExVat")),
    vat: roundMoney(sumBy(rows, "vat")),
    creditValueInclVat: roundMoney(sumBy(rows, "creditValueInclVat")),
    stockImpactCount: sumBy(rows, "stockImpactCount"),
  };
}

function addCountWarning(rows, warnings, code, level, message, predicate) {
  if (warnings.some((warning) => warning?.code === code)) return;
  const count = rows.filter(predicate).length;
  if (count) warnings.push({ code, level, message: `${count} ${message}` });
}

export default creditNotesReport;
