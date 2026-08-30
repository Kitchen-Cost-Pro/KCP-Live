import { getReportDefinition } from "../reports/index.js";
import { getReportDataSource } from "../api/reportDataSourceCatalog.js";
import { getTransactionDetailRegistry } from "../transactions/transactionDetailRegistry.js";
import { isTransactionReference } from "../transactions/transactionReference.js";
import {
  transactionDetailSummaryRows,
  transactionDetailTimeZone,
} from "../transactions/transactionDetailUtils.js";
import {
  transactionDetailToReport,
  transactionDetailWorkbookSheets,
} from "../transactions/transactionDetailExports.js";

export const PHASE35_TRANSACTION_FAMILIES = Object.freeze([
  Object.freeze({
    entityType: "grv",
    prefix: "GRV",
    reportId: "grv_log",
    summaryView: "summary",
    sourceEndpoint: "reports/grv-log",
  }),
  Object.freeze({
    entityType: "credit_note",
    prefix: "CN",
    reportId: "credit_notes_report",
    summaryView: "summary",
    sourceEndpoint: "reports/credit-notes",
  }),
  Object.freeze({
    entityType: "manufacturing_batch",
    prefix: "MFG",
    reportId: "manufacturing_transactions",
    summaryView: "batches",
    sourceEndpoint: "reports/manufacturing-transactions",
  }),
  Object.freeze({
    entityType: "transfer",
    prefix: "TRF",
    reportId: "stock_transfers",
    summaryView: "summary",
    sourceEndpoint: "reports/stock-transfer-transactions",
  }),
  Object.freeze({
    entityType: "stock_take",
    prefix: "STK",
    reportId: "stock_take_audit",
    summaryView: "sessions",
    sourceEndpoint: "reports/stock-take-audit",
  }),
]);

const DETAIL_ENDPOINT = "reports/transactions/:transactionReference";
const QTY_TOLERANCE = 0.0001;
const VALUE_TOLERANCE = 0.01;

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function numberValue(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function sum(rows, key) {
  return (Array.isArray(rows) ? rows : [])
    .reduce((total, row) => total + numberValue(row?.[key]), 0);
}

function cardValue(detail, key) {
  return numberValue((detail.summaryCards || []).find((card) => card.key === key)?.value);
}

function mismatch(mismatches, field, expected, actual, tolerance = VALUE_TOLERANCE) {
  if (Math.abs(numberValue(expected) - numberValue(actual)) > tolerance) {
    mismatches.push({ field, expected: numberValue(expected), actual: numberValue(actual) });
  }
}

export function auditPhase35TransactionRegistry() {
  const detailRegistry = getTransactionDetailRegistry();
  const problems = [];
  for (const family of PHASE35_TRANSACTION_FAMILIES) {
    if (!detailRegistry[family.entityType]) {
      problems.push(`${family.entityType} is missing from the transaction detail registry.`);
    }
    const report = getReportDefinition(family.reportId);
    if (!report) {
      problems.push(`${family.reportId} is missing from the report registry.`);
      continue;
    }
    if (!(report.availableViews || []).includes(family.summaryView)) {
      problems.push(`${family.reportId} is missing ${family.summaryView}.`);
    }
    const columns = report.columns?.[family.summaryView] || [];
    if (!columns.some((column) => column.key === "transactionReference" && column.type === "transaction_id")) {
      problems.push(`${family.reportId}.${family.summaryView} has no clickable Transaction ID column.`);
    }
  }
  return { ok: !problems.length, problems };
}

export function auditPhase35TransactionSources() {
  const problems = [];
  for (const family of PHASE35_TRANSACTION_FAMILIES) {
    const source = getReportDataSource(family.reportId);
    if (!source) {
      problems.push(`${family.reportId} has no source catalog entry.`);
      continue;
    }
    if (!source.realDataOnly || !source.workspaceScoped) {
      problems.push(`${family.reportId} is not marked real-data-only and workspace-scoped.`);
    }
    if (!source.endpoints.includes(family.sourceEndpoint)) {
      problems.push(`${family.reportId} is missing ${family.sourceEndpoint}.`);
    }
    if (!source.endpoints.includes(DETAIL_ENDPOINT)) {
      problems.push(`${family.reportId} is missing the shared transaction detail endpoint.`);
    }
    if (!source.sourceIds.includes("transactionReference")) {
      problems.push(`${family.reportId} does not document transactionReference as a source identifier.`);
    }
  }
  return { ok: !problems.length, problems };
}

export function auditTransactionDetailParity(detail = {}) {
  const mismatches = [];
  const lines = Array.isArray(detail.lineItems) ? detail.lineItems : [];
  const entityType = text(detail.entityType);

  if (!isTransactionReference(detail.transactionReference, entityType)) {
    mismatches.push({ field: "transactionReference", expected: entityType, actual: detail.transactionReference });
  }
  if (!lines.length) {
    mismatches.push({ field: "lineItems", expected: "> 0", actual: 0 });
  }

  if (entityType === "grv") {
    mismatch(mismatches, "lineCount", lines.length, cardValue(detail, "lineCount"), 0);
    mismatch(mismatches, "totalQuantity", sum(lines, "baseQuantity"), cardValue(detail, "totalQuantity"), QTY_TOLERANCE);
    mismatch(mismatches, "totalExVat", sum(lines, "totalExVat"), cardValue(detail, "totalExVat"));
    mismatch(mismatches, "vat", sum(lines, "vat"), cardValue(detail, "vat"));
    mismatch(mismatches, "totalInclVat", sum(lines, "totalInclVat"), cardValue(detail, "totalInclVat"));
  } else if (entityType === "credit_note") {
    mismatch(mismatches, "lineCount", lines.length, cardValue(detail, "lineCount"), 0);
    mismatch(mismatches, "totalQuantity", sum(lines, "quantity"), cardValue(detail, "totalQuantity"), QTY_TOLERANCE);
    mismatch(mismatches, "totalExVat", sum(lines, "totalExVat"), cardValue(detail, "totalExVat"));
    mismatch(mismatches, "vat", sum(lines, "vat"), cardValue(detail, "vat"));
    mismatch(mismatches, "totalInclVat", sum(lines, "totalInclVat"), cardValue(detail, "totalInclVat"));
  } else if (entityType === "manufacturing_batch") {
    mismatch(mismatches, "lineCount", lines.length, cardValue(detail, "lineCount"), 0);
    mismatch(mismatches, "ingredientCost", sum(lines, "totalExVat"), cardValue(detail, "ingredientCost"));
    mismatch(mismatches, "actualYield", detail.metadata?.actualYield, cardValue(detail, "actualYield"), QTY_TOLERANCE);
    mismatch(mismatches, "outputValue", detail.metadata?.outputValue, cardValue(detail, "outputValue"));
    mismatch(mismatches, "wastageQty", detail.metadata?.wastageQty, cardValue(detail, "wastageQty"), QTY_TOLERANCE);
    mismatch(mismatches, "wastageValue", detail.metadata?.wastageValue, cardValue(detail, "wastageValue"));
  } else if (entityType === "transfer") {
    mismatch(mismatches, "lineCount", lines.length, cardValue(detail, "lineCount"), 0);
    mismatch(mismatches, "shippedQty", sum(lines, "shippedQty"), cardValue(detail, "shippedQty"), QTY_TOLERANCE);
    mismatch(mismatches, "receivedQty", sum(lines, "receivedQty"), cardValue(detail, "receivedQty"), QTY_TOLERANCE);
    mismatch(mismatches, "returnedQty", sum(lines, "returnedQty"), cardValue(detail, "returnedQty"), QTY_TOLERANCE);
    mismatch(mismatches, "transferValue", sum(lines, "transferValue"), cardValue(detail, "transferValue"));
    for (const [index, line] of lines.entries()) {
      const shipped = numberValue(line.shippedQty);
      const received = numberValue(line.receivedQty);
      const returned = numberValue(line.returnedQty);
      if (received + returned - shipped > QTY_TOLERANCE) {
        mismatches.push({ field: `lineItems[${index}] lifecycle`, expected: shipped, actual: received + returned });
      }
    }
  } else if (entityType === "stock_take") {
    mismatch(mismatches, "lineCount", lines.length, cardValue(detail, "lineCount"), 0);
    mismatch(mismatches, "varianceItems", lines.filter((line) => Math.abs(numberValue(line.varianceQty)) > QTY_TOLERANCE).length, cardValue(detail, "varianceItems"), 0);
    mismatch(mismatches, "varianceQty", sum(lines, "varianceQty"), cardValue(detail, "varianceQty"), QTY_TOLERANCE);
    mismatch(mismatches, "expectedValue", sum(lines, "expectedValue"), cardValue(detail, "expectedValue"));
    mismatch(mismatches, "countedValue", sum(lines, "countedValue"), cardValue(detail, "countedValue"));
    mismatch(mismatches, "varianceValue", sum(lines, "varianceValue"), cardValue(detail, "varianceValue"));
    for (const [index, line] of lines.entries()) {
      mismatch(
        mismatches,
        `lineItems[${index}].varianceValue`,
        numberValue(line.countedValue) - numberValue(line.expectedValue),
        line.varianceValue,
      );
    }
  } else {
    mismatches.push({ field: "entityType", expected: "supported transaction type", actual: entityType });
  }

  if (detail.metadata?.ledgerReconciled === false) {
    mismatches.push({ field: "ledgerReconciled", expected: true, actual: false });
  }

  return { ok: !mismatches.length, mismatches };
}

export function auditTransactionDetailExports(detail = {}) {
  const report = transactionDetailToReport(detail);
  const sheets = transactionDetailWorkbookSheets(detail);
  const summaryRows = transactionDetailSummaryRows(detail);
  const timeZone = transactionDetailTimeZone(detail);
  const problems = [];

  if (report.rows.length !== (detail.lineItems || []).length) {
    problems.push("CSV/PDF line rows do not match the selected transaction.");
  }
  if (report.meta?.timeZone !== timeZone) {
    problems.push("CSV/PDF export is missing the transaction reporting timezone.");
  }
  const expectedSheets = ["Summary", "Line Items", "Stock Movements", "Audit Trail"];
  if (sheets.map((sheet) => sheet.name).join("|") !== expectedSheets.join("|")) {
    problems.push("XLSX sheet contract is incomplete.");
  }
  if ((sheets.find((sheet) => sheet.name === "Line Items")?.rows || []).length !== (detail.lineItems || []).length) {
    problems.push("XLSX line rows do not match the selected transaction.");
  }
  if (!summaryRows.some((row) => row.Field === "Transaction ID" && row.Value === detail.transactionReference)) {
    problems.push("Export summary is missing the Transaction ID.");
  }
  if (!summaryRows.some((row) => row.Field === "Reporting Time Zone" && row.Value === timeZone)) {
    problems.push("Export summary is missing the reporting timezone.");
  }
  return { ok: !problems.length, problems, report, sheets };
}

export function buildPhase35TransactionSignoff(details = []) {
  const checks = {
    registry: auditPhase35TransactionRegistry(),
    sources: auditPhase35TransactionSources(),
    details: (details || []).map((detail) => ({
      transactionReference: detail.transactionReference,
      parity: auditTransactionDetailParity(detail),
      exports: auditTransactionDetailExports(detail),
    })),
  };
  const detailChecksPass = checks.details.every((check) => check.parity.ok && check.exports.ok);
  return {
    ok: checks.registry.ok && checks.sources.ok && detailChecksPass,
    checks,
  };
}

export default buildPhase35TransactionSignoff;
