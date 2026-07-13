import { downloadReportCsv } from "../exports/exportCsv.js";
import { drawReportPdfHeader } from "../exports/exportPdf.js";
import { formatTransactionDetailValue,
  transactionDetailExportRows,
  transactionDetailFileStem,
  transactionDetailSummaryRows,
  transactionDetailTimeZone,
} from "./transactionDetailUtils.js";
import { getTransactionDetailDefinition } from "./transactionDetailRegistry.js";

const PDF_METADATA_FIELDS = {
  grv: [
    ["supplierName", "Supplier"],
    ["invoiceNumber", "Invoice Number"],
    ["purchaseOrderNumber", "Purchase Order"],
    ["splitByLocation", "Split By Location"],
    ["vatMode", "VAT Mode"],
  ],
  credit_note: [
    ["supplierName", "Supplier"],
    ["creditNoteNumber", "Credit Note Number"],
    ["reason", "Reason"],
    ["originalInvoiceGrv", "Original Invoice / GRV"],
    ["originalTransactionReference", "Original Transaction"],
    ["vatRate", "VAT Rate"],
    ["vatMode", "VAT Mode"],
  ],
  manufacturing_batch: [
    ["manufacturedItemName", "Manufactured Item"],
    ["category", "Category"],
    ["batchMultiplier", "Batch Multiplier"],
    ["plannedYield", "Planned Yield"],
    ["actualYield", "Actual Yield"],
    ["yieldVariance", "Yield Variance"],
    ["yieldUom", "Yield UOM"],
    ["costingMethod", "Costing Method"],
    ["wastageAccountingTreatment", "Wastage Treatment"],
    ["note", "Notes"],
  ],
  transfer: [
    ["transferType", "Transfer Type"],
    ["fromSiteName", "From Site"],
    ["fromLocationName", "From Location"],
    ["toSiteName", "To Site"],
    ["toLocationName", "To Location"],
    ["requestedAt", "Requested At", "datetime"],
    ["acceptedAt", "Accepted At", "datetime"],
    ["partialAcceptance", "Partial Acceptance"],
    ["note", "Notes"],
  ],
  stock_take: [
    ["templateName", "Template"],
    ["sessionMode", "Session Mode"],
    ["countedAt", "Counted At", "datetime"],
    ["committedAt", "Committed At", "datetime"],
    ["varianceClassification", "Variance Classification"],
    ["note", "Notes"],
  ],
};

const SUMMARY_CARD_EXCLUSIONS = new Set([
  "stockMovementRows",
  "stockMovements",
]);

export function transactionDetailToReport(detail = {}) {
  const timeZone = transactionDetailTimeZone(detail);
  const columns = (detail.lineItemColumns || []).map((column) => ({
    ...column,
    timeZone: ["date", "datetime", "time"].includes(column.type)
      ? timeZone
      : column.timeZone,
    sortable: false,
  }));
  const summary = transactionDetailSummaryRows(detail)
    .map((row) => `${row.Field}: ${row.Value}`)
    .join(" | ");
  return {
    id: `transaction_${detail.entityType || "detail"}`,
    title: `${detail.transactionReference || "Transaction"} Details`,
    generatedAt: new Date().toISOString(),
    view: "line_items",
    report: {
      id: `transaction_${detail.entityType || "detail"}`,
      title: `${detail.transactionReference || "Transaction"} Details`,
      description: summary,
      exportMapping: Object.fromEntries(
        columns.map((column) => [column.key, column.label || column.key]),
      ),
    },
    columns,
    rows: detail.lineItems || [],
    totals: {},
    warnings: [],
    meta: {
      transactionReference: detail.transactionReference,
      timeZone,
    },
  };
}

export function downloadTransactionDetailCsv(detail = {}) {
  return downloadReportCsv(transactionDetailToReport(detail), {
    includeTotals: false,
    fileName: `${transactionDetailFileStem(detail)}.csv`,
  });
}

export function transactionDetailWorkbookSheets(detail = {}) {
  return [
    { name: "Summary", rows: transactionDetailSummaryRows(detail) },
    {
      name: "Line Items",
      rows: transactionDetailExportRows(
        detail.lineItems || [],
        detail.lineItemColumns || [],
        detail,
      ),
    },
    {
      name: "Stock Movements",
      rows: transactionDetailExportRows(detail.stockMovements || [], [], detail),
    },
    {
      name: "Audit Trail",
      rows: transactionDetailExportRows(detail.auditTrail || [], [], detail),
    },
  ];
}

export async function downloadTransactionDetailExcel(detail = {}) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const append = (name, rows) => {
    const safeRows = Array.isArray(rows) && rows.length ? rows : [{ Note: "No data available." }];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(safeRows),
      String(name).slice(0, 31),
    );
  };
  const sheets = transactionDetailWorkbookSheets(detail);
  append("Summary", sheets.find((sheet) => sheet.name === "Summary")?.rows);
  append("Line Items", sheets.find((sheet) => sheet.name === "Line Items")?.rows);
  append("Stock Movements", sheets.find((sheet) => sheet.name === "Stock Movements")?.rows);
  append("Audit Trail", sheets.find((sheet) => sheet.name === "Audit Trail")?.rows);
  const fileName = `${transactionDetailFileStem(detail)}.xlsx`;
  XLSX.writeFile(workbook, fileName);
  return { fileName, workbook };
}

export function buildTransactionDetailPdfModel(detail = {}) {
  const definition = getTransactionDetailDefinition(detail.entityType);
  const timeZone = transactionDetailTimeZone(detail);
  const occurredAt = detail.occurredAt || detail.createdAt || "";
  const reference = detail.transactionReference || "Transaction";
  const location = (detail.locationNames || []).filter(Boolean).join(", ");
  const reconciliationCard = (detail.summaryCards || []).find((card) =>
    String(card?.key || "").toLowerCase() === "reconciled",
  );
  const summaryCards = (detail.summaryCards || [])
    .filter((card) => card && !SUMMARY_CARD_EXCLUSIONS.has(String(card.key || "")))
    .filter((card) => String(card.key || "").toLowerCase() !== "reconciled")
    .slice(0, 6)
    .map((card) => ({
      label: card.label || card.key || "Summary",
      value: formatTransactionDetailValue(card.value, card.type, timeZone) || "-",
    }));
  const facts = [
    { label: "Status", value: detail.status || "-" },
    {
      label: "Date and Time",
      value: occurredAt
        ? formatTransactionDetailValue(occurredAt, "datetime", timeZone)
        : "-",
    },
    { label: "Location", value: location || "-" },
    { label: "Created By", value: detail.createdByName || detail.createdBy || "-" },
    { label: "Committed By", value: detail.committedBy || "-" },
    ...buildPdfMetadataFacts(detail, timeZone),
  ];
  const columns = (detail.lineItemColumns || [])
    .filter((column) => column?.key && column.showInPdf !== false)
    .map((column) => ({
      key: column.key,
      label: column.label || humanizePdfKey(column.key),
      type: column.type || "",
    }));
  const rows = (detail.lineItems || []).map((row) =>
    columns.map((column) =>
      formatTransactionDetailValue(row?.[column.key], column.type, timeZone),
    ),
  );
  return {
    reference,
    entityType: detail.entityType || "detail",
    typeLabel: definition.label || "Transaction",
    title: `${reference} - ${definition.label || "Transaction"}`,
    subtitle: [detail.status, occurredAt ? formatTransactionDetailValue(occurredAt, "datetime", timeZone) : "", location]
      .filter(Boolean)
      .join(" | "),
    timeZone,
    generatedAt: formatTransactionDetailValue(new Date().toISOString(), "datetime", timeZone),
    summaryCards,
    facts: deduplicatePdfFacts(facts),
    reconciliation: reconciliationCard
      ? String(reconciliationCard.value || "")
      : detail.metadata?.ledgerReconciled === true
        ? "Reconciled"
        : detail.metadata?.ledgerReconciled === false
          ? "Review Required"
          : "",
    columns,
    rows,
  };
}

function buildPdfMetadataFacts(detail = {}, timeZone = "") {
  const metadata = detail.metadata && typeof detail.metadata === "object"
    ? detail.metadata
    : {};
  const fieldDefinitions = PDF_METADATA_FIELDS[detail.entityType] || [];
  return fieldDefinitions
    .map(([key, label, type = ""]) => ({
      label,
      value: formatPdfMetadataValue(metadata[key], key, type, timeZone),
    }))
    .filter((row) => row.value !== "" && row.value !== "-");
}

function formatPdfMetadataValue(value, key = "", type = "", timeZone = "") {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (type === "datetime") return formatTransactionDetailValue(value, "datetime", timeZone);
  if (/vatRate$/i.test(key)) return `${Number(value) || 0}%`;
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value);
}

function deduplicatePdfFacts(facts = []) {
  const seen = new Set();
  return facts.filter((fact) => {
    const label = String(fact?.label || "").trim();
    const value = String(fact?.value ?? "").trim();
    if (!label || !value) return false;
    const identity = `${label.toLowerCase()}::${value.toLowerCase()}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function humanizePdfKey(value = "") {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export async function transactionDetailToPdfDocument(detail = {}, options = {}) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable = autoTableModule.default || autoTableModule.autoTable;
  const model = buildTransactionDetailPdfModel(detail);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 32;
  const contentWidth = pageWidth - margin * 2;

  doc.setProperties({
    title: model.title,
    subject: `${model.typeLabel} transaction ${model.reference}`,
    creator: "Kitchen Cost Pro Reporting",
  });

  const header = await drawReportPdfHeader(doc, {
    title: model.title,
    subtitle: model.subtitle,
    description: "",
    branding: options.branding || {},
  });

  let cursorY = header.tableStartY + 2;
  cursorY = drawPdfSummaryCards(doc, model.summaryCards, margin, cursorY, contentWidth);
  cursorY = drawPdfFactTable(doc, autoTable, model.facts, margin, cursorY, contentWidth);

  if (model.reconciliation) {
    cursorY = ensurePdfSpace(doc, cursorY, 42, margin);
    const reconciled = model.reconciliation.toLowerCase().includes("reconciled")
      && !model.reconciliation.toLowerCase().includes("review");
    doc.setFillColor(...(reconciled ? [236, 253, 245] : [255, 247, 237]));
    doc.setDrawColor(...(reconciled ? [167, 243, 208] : [253, 186, 116]));
    doc.roundedRect(margin, cursorY, contentWidth, 30, 6, 6, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(...(reconciled ? [6, 95, 70] : [154, 52, 18]));
    doc.text(`Ledger Reconciliation: ${model.reconciliation}`, margin + 12, cursorY + 19);
    cursorY += 42;
  }

  cursorY = ensurePdfSpace(doc, cursorY, 80, margin);
  drawPdfSectionTitle(doc, "Line Items", margin, cursorY);
  cursorY += 18;

  const headers = model.columns.map((column) => column.label);
  const body = model.rows.length
    ? model.rows
    : [headers.map((_, index) => index === 0 ? "No line items were recorded." : "")];
  const tableOptions = {
    startY: cursorY,
    head: [headers],
    body,
    showHead: "everyPage",
    tableWidth: "auto",
    rowPageBreak: "avoid",
    horizontalPageBreak: headers.length > 10,
    horizontalPageBreakRepeat: headers.length > 5 ? 0 : undefined,
    horizontalPageBreakBehaviour: "afterAllRows",
    margin: { left: margin, right: margin, bottom: 30 },
    styles: {
      font: "helvetica",
      fontSize: headers.length > 13 ? 6.1 : headers.length > 10 ? 6.7 : 7.4,
      cellPadding: headers.length > 13 ? 3 : 4,
      overflow: "linebreak",
      valign: "middle",
      textColor: [55, 65, 81],
      lineColor: [226, 232, 240],
      lineWidth: 0.35,
    },
    headStyles: {
      fillColor: [17, 24, 39],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      minCellHeight: 23,
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: buildTransactionPdfColumnStyles(model.columns),
    didDrawPage: (data) => {
      drawTransactionPdfFooter(doc, model, data.pageNumber, pageHeight, margin);
    },
  };
  if (typeof autoTable === "function") autoTable(doc, tableOptions);
  else if (typeof doc.autoTable === "function") doc.autoTable(tableOptions);

  return doc;
}

function drawPdfSummaryCards(doc, cards = [], left = 32, startY = 90, contentWidth = 760) {
  if (!cards.length) return startY;
  drawPdfSectionTitle(doc, "Summary", left, startY);
  const gap = 8;
  const columns = 3;
  const cardWidth = (contentWidth - gap * (columns - 1)) / columns;
  const cardHeight = 44;
  let cursorY = startY + 16;
  cards.forEach((card, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = left + column * (cardWidth + gap);
    const y = cursorY + row * (cardHeight + gap);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(x, y, cardWidth, cardHeight, 6, 6, "FD");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(107, 114, 128);
    doc.text(String(card.label || "Summary"), x + 10, y + 14, { maxWidth: cardWidth - 20 });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(17, 24, 39);
    doc.text(String(card.value || "-"), x + 10, y + 32, { maxWidth: cardWidth - 20 });
  });
  const rows = Math.ceil(cards.length / columns);
  return cursorY + rows * (cardHeight + gap) + 2;
}

function drawPdfFactTable(doc, autoTable, facts = [], left = 32, startY = 160, contentWidth = 760) {
  if (!facts.length) return startY;
  drawPdfSectionTitle(doc, "Transaction Details", left, startY);
  const pairs = [];
  for (let index = 0; index < facts.length; index += 2) {
    const first = facts[index] || { label: "", value: "" };
    const second = facts[index + 1] || { label: "", value: "" };
    pairs.push([first.label, first.value, second.label, second.value]);
  }
  const tableOptions = {
    startY: startY + 14,
    body: pairs,
    theme: "plain",
    tableWidth: contentWidth,
    margin: { left, right: left },
    styles: {
      font: "helvetica",
      fontSize: 7.8,
      cellPadding: { top: 4, right: 6, bottom: 4, left: 6 },
      overflow: "linebreak",
      valign: "top",
      textColor: [55, 65, 81],
      lineColor: [226, 232, 240],
      lineWidth: { bottom: 0.35 },
    },
    columnStyles: {
      0: { cellWidth: 78, fontStyle: "bold", textColor: [107, 114, 128] },
      1: { cellWidth: contentWidth / 2 - 78 },
      2: { cellWidth: 78, fontStyle: "bold", textColor: [107, 114, 128] },
      3: { cellWidth: contentWidth / 2 - 78 },
    },
  };
  if (typeof autoTable === "function") autoTable(doc, tableOptions);
  else if (typeof doc.autoTable === "function") doc.autoTable(tableOptions);
  return Number(doc.lastAutoTable?.finalY || startY + 30) + 14;
}

function drawPdfSectionTitle(doc, title = "", x = 32, y = 80) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(31, 41, 55);
  doc.text(String(title), x, y);
}

function ensurePdfSpace(doc, cursorY = 0, requiredHeight = 0, topMargin = 32) {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (cursorY + requiredHeight <= pageHeight - 36) return cursorY;
  doc.addPage();
  return topMargin;
}

function buildTransactionPdfColumnStyles(columns = []) {
  return columns.reduce((styles, column, index) => {
    const type = String(column.type || "").toLowerCase();
    const label = String(column.label || "").toLowerCase();
    if (["money", "number", "percent", "qty", "quantity"].includes(type)
      || /qty|cost|amount|total|value|vat|variance|percent|price/.test(label)) {
      styles[index] = { ...(styles[index] || {}), halign: "right" };
    }
    if (/item|category|location|reason|notes|breakdown|impact|uom/.test(label)) {
      styles[index] = { ...(styles[index] || {}), cellWidth: "wrap" };
    }
    return styles;
  }, {});
}

function drawTransactionPdfFooter(doc, model, pageNumber, pageHeight, margin) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.8);
  doc.setTextColor(107, 114, 128);
  doc.text(`${model.reference} | Generated ${model.generatedAt} | ${model.timeZone}`, margin, pageHeight - 16);
  doc.text(`Page ${pageNumber}`, doc.internal.pageSize.getWidth() - margin - 36, pageHeight - 16);
}

export async function downloadTransactionDetailPdf(detail = {}, options = {}) {
  const doc = await transactionDetailToPdfDocument(detail, options);
  const fileName = `${transactionDetailFileStem(detail)}.pdf`;
  const blob = doc.output("blob");
  triggerDownload(blob, fileName);
  return { fileName, document: doc };
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
