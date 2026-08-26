import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  auditPhase35TransactionRegistry,
  auditPhase35TransactionSources,
  auditTransactionDetailExports,
  auditTransactionDetailParity,
  buildPhase35TransactionSignoff,
  PHASE35_TRANSACTION_FAMILIES,
} from "./phase35_7TransactionSignoff.js";
import {
  historicalTransactionReference,
  isTransactionReference,
} from "../transactions/transactionReference.js";
import {
  transactionDetailSummaryRows,
  transactionDetailTimeZone,
} from "../transactions/transactionDetailUtils.js";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function baseDetail(overrides = {}) {
  return {
    entityType: "grv",
    entityId: "grv-1",
    transactionReference: "GRV-260712-0001",
    status: "Committed",
    occurredAt: "2026-07-12T08:00:00.000Z",
    createdAt: "2026-07-12T07:55:00.000Z",
    createdBy: "user-1",
    createdByName: "Kitchen User",
    committedBy: "Kitchen User",
    timeZone: "Africa/Johannesburg",
    locationIds: ["loc-1"],
    locationNames: ["Main Kitchen"],
    summaryCards: [],
    lineItemColumns: [],
    lineItems: [],
    stockMovements: [],
    auditTrail: [],
    metadata: { ledgerReconciled: true, reportingTimeZone: "Africa/Johannesburg" },
    ...overrides,
  };
}

const grvDetail = baseDetail({
  summaryCards: [
    { key: "lineCount", value: 2, type: "number" },
    { key: "totalQuantity", value: 5, type: "number" },
    { key: "totalExVat", value: 100, type: "money" },
    { key: "vat", value: 15, type: "money" },
    { key: "totalInclVat", value: 115, type: "money" },
  ],
  lineItemColumns: [
    { key: "itemName", label: "Item" },
    { key: "baseQuantity", label: "Base Qty", type: "number" },
    { key: "totalExVat", label: "Ex VAT", type: "money" },
    { key: "vat", label: "VAT", type: "money" },
    { key: "totalInclVat", label: "Incl VAT", type: "money" },
  ],
  lineItems: [
    { itemName: "Flour", baseQuantity: 3, totalExVat: 60, vat: 9, totalInclVat: 69 },
    { itemName: "Oil", baseQuantity: 2, totalExVat: 40, vat: 6, totalInclVat: 46 },
  ],
});

const creditNoteDetail = baseDetail({
  entityType: "credit_note",
  entityId: "credit-1",
  transactionReference: "CN-260712-0001",
  summaryCards: [
    { key: "lineCount", value: 1, type: "number" },
    { key: "totalQuantity", value: 2, type: "number" },
    { key: "totalExVat", value: 40, type: "money" },
    { key: "vat", value: 6, type: "money" },
    { key: "totalInclVat", value: 46, type: "money" },
  ],
  lineItemColumns: [
    { key: "itemName", label: "Item" },
    { key: "quantity", label: "Quantity", type: "number" },
    { key: "totalExVat", label: "Ex VAT", type: "money" },
    { key: "vat", label: "VAT", type: "money" },
    { key: "totalInclVat", label: "Incl VAT", type: "money" },
  ],
  lineItems: [
    { itemName: "Oil", quantity: 2, totalExVat: 40, vat: 6, totalInclVat: 46, stockImpact: "Stock Returned" },
  ],
});

const manufacturingDetail = baseDetail({
  entityType: "manufacturing_batch",
  entityId: "mfg-1",
  transactionReference: "MFG-260712-0001",
  summaryCards: [
    { key: "lineCount", value: 2, type: "number" },
    { key: "plannedYield", value: 10, type: "number" },
    { key: "actualYield", value: 8, type: "number" },
    { key: "yieldVariance", value: -2, type: "number" },
    { key: "ingredientCost", value: 80, type: "money" },
    { key: "outputValue", value: 80, type: "money" },
    { key: "wastageQty", value: 2, type: "number" },
    { key: "wastageValue", value: 16, type: "money" },
  ],
  lineItemColumns: [
    { key: "itemName", label: "Ingredient" },
    { key: "quantity", label: "Quantity", type: "number" },
    { key: "totalExVat", label: "Cost", type: "money" },
  ],
  lineItems: [
    { itemName: "Tomatoes", quantity: 5, totalExVat: 60 },
    { itemName: "Spice", quantity: 1, totalExVat: 20 },
  ],
  metadata: {
    ledgerReconciled: true,
    reportingTimeZone: "Africa/Johannesburg",
    actualYield: 8,
    outputValue: 80,
    wastageQty: 2,
    wastageValue: 16,
    wastageAccountingPolicy: "Yield loss is accounting-only; component usage is not deducted twice.",
  },
});

function transferDetail({
  reference = "TRF-260712-0001",
  status = "Accepted",
  shipped = 10,
  received = 10,
  returned = 0,
  transferType = "internal",
} = {}) {
  return baseDetail({
    entityType: "transfer",
    entityId: reference.toLowerCase(),
    transactionReference: reference,
    status,
    summaryCards: [
      { key: "lineCount", value: 1, type: "number" },
      { key: "shippedQty", value: shipped, type: "number" },
      { key: "receivedQty", value: received, type: "number" },
      { key: "returnedQty", value: returned, type: "number" },
      { key: "transferValue", value: shipped * 2.5, type: "money" },
    ],
    lineItemColumns: [
      { key: "sourceItemName", label: "Source Item" },
      { key: "destinationItemName", label: "Destination Item" },
      { key: "shippedQty", label: "Shipped", type: "number" },
      { key: "receivedQty", label: "Received", type: "number" },
      { key: "returnedQty", label: "Returned", type: "number" },
      { key: "transferValue", label: "Transfer Value", type: "money" },
    ],
    lineItems: [{
      sourceItemName: "Burger Bun",
      destinationItemName: "Burger Bun",
      shippedQty: shipped,
      receivedQty: received,
      returnedQty: returned,
      transferValue: shipped * 2.5,
      status,
    }],
    metadata: {
      ledgerReconciled: true,
      reportingTimeZone: "Africa/Johannesburg",
      transferType,
      varianceAccountingPolicy: "Transfer returns restore sender stock.",
    },
  });
}

function stockTakeDetail({
  reference = "STK-260712-0001",
  expected = 10,
  counted = 10,
} = {}) {
  const variance = counted - expected;
  const unitCost = 5;
  return baseDetail({
    entityType: "stock_take",
    entityId: reference.toLowerCase(),
    transactionReference: reference,
    summaryCards: [
      { key: "lineCount", value: 1, type: "number" },
      { key: "varianceItems", value: variance === 0 ? 0 : 1, type: "number" },
      { key: "varianceQty", value: variance, type: "number" },
      { key: "expectedValue", value: expected * unitCost, type: "money" },
      { key: "countedValue", value: counted * unitCost, type: "money" },
      { key: "varianceValue", value: variance * unitCost, type: "money" },
    ],
    lineItemColumns: [
      { key: "itemName", label: "Item" },
      { key: "countedUom", label: "Counted UOM" },
      { key: "expectedValue", label: "Expected Value", type: "money" },
      { key: "countedValue", label: "Counted Value", type: "money" },
      { key: "varianceQty", label: "Variance Qty", type: "number" },
      { key: "varianceValue", label: "Variance Value", type: "money" },
    ],
    lineItems: [{
      itemName: "Flour",
      countedUom: "Bag",
      enteredQty: counted / 2,
      conversionRatio: 2,
      convertedBaseQty: counted,
      expectedQty: expected,
      varianceQty: variance,
      expectedValue: expected * unitCost,
      countedValue: counted * unitCost,
      varianceValue: variance * unitCost,
    }],
    metadata: {
      ledgerReconciled: true,
      reportingTimeZone: "Africa/Johannesburg",
      varianceAccountingPolicy: "Stock take variance is inventory variance, not wastage.",
    },
  });
}

const allFamilyDetails = [
  grvDetail,
  creditNoteDetail,
  manufacturingDetail,
  transferDetail(),
  stockTakeDetail(),
];

test("Phase 35.7 transaction registry and source catalog cover all five transaction families", () => {
  const registry = auditPhase35TransactionRegistry();
  const sources = auditPhase35TransactionSources();
  assert.equal(registry.ok, true, JSON.stringify(registry.problems, null, 2));
  assert.equal(sources.ok, true, JSON.stringify(sources.problems, null, 2));
  assert.equal(PHASE35_TRANSACTION_FAMILIES.length, 5);
});

test("Phase 35.7 historical transaction fallbacks remain deterministic without valid timestamps", () => {
  const missingDateA = historicalTransactionReference("grv", "legacy-grv-1", "");
  const missingDateB = historicalTransactionReference("grv", "legacy-grv-1", null);
  const invalidDate = historicalTransactionReference("grv", "legacy-grv-1", "not-a-date");
  assert.equal(missingDateA, missingDateB);
  assert.equal(missingDateA, invalidDate);
  assert.match(missingDateA, /^GRV-000000-H[A-Z0-9]{6}$/);
  assert.equal(isTransactionReference(missingDateA, "grv"), true);

  const worker = read("cloudflare-v2/src/legacy/transaction-references.ts");
  assert.match(worker, /fallbackToNow: false/);
  assert.match(worker, /dateKey = parsed \? transactionDateKey\(parsed\) : "000000"/);
});

test("Phase 35.7 transaction detail summaries and exports use the workspace timezone", () => {
  const rows = transactionDetailSummaryRows(grvDetail);
  const dateRow = rows.find((row) => row.Field === "Date and Time");
  assert.match(dateRow.Value, /10:00/);
  assert.equal(transactionDetailTimeZone(grvDetail), "Africa/Johannesburg");
  const exportsAudit = auditTransactionDetailExports(grvDetail);
  assert.equal(exportsAudit.ok, true, JSON.stringify(exportsAudit.problems, null, 2));
  assert.equal(exportsAudit.report.meta.timeZone, "Africa/Johannesburg");
  assert.deepEqual(exportsAudit.sheets.map((sheet) => sheet.name), [
    "Summary",
    "Line Items",
    "Stock Movements",
    "Audit Trail",
  ]);

  const route = read("cloudflare-v2/src/legacy/transaction-detail-routes.ts");
  assert.match(route, /resolveWorkspaceTimeZone/);
  assert.match(route, /detail\.timeZone = reportingTimeZone/);
});

test("Phase 35.7 all transaction family totals reconcile with their selected detail lines", () => {
  for (const detail of allFamilyDetails) {
    const audit = auditTransactionDetailParity(detail);
    assert.equal(audit.ok, true, `${detail.transactionReference}: ${JSON.stringify(audit.mismatches, null, 2)}`);
  }
});

test("Phase 35.7 detects transaction summary, lifecycle, and ledger mismatches", () => {
  const broken = structuredClone(transferDetail());
  broken.summaryCards.find((card) => card.key === "receivedQty").value = 11;
  broken.metadata.ledgerReconciled = false;
  const audit = auditTransactionDetailParity(broken);
  assert.equal(audit.ok, false);
  assert.ok(audit.mismatches.some((entry) => entry.field === "receivedQty"));
  assert.ok(audit.mismatches.some((entry) => entry.field === "ledgerReconciled"));
});

test("Phase 35.7 transfer lifecycle matrix covers internal, pending, partial, rejected, and cancelled transactions", () => {
  const cases = [
    transferDetail({ reference: "TRF-260712-0001", transferType: "internal", status: "Accepted", shipped: 10, received: 10, returned: 0 }),
    transferDetail({ reference: "TRF-260712-0002", transferType: "external", status: "Pending Receipt", shipped: 10, received: 0, returned: 0 }),
    transferDetail({ reference: "TRF-260712-0003", transferType: "external", status: "Partially Accepted", shipped: 10, received: 8, returned: 2 }),
    transferDetail({ reference: "TRF-260712-0004", transferType: "external", status: "Rejected", shipped: 10, received: 0, returned: 10 }),
    transferDetail({ reference: "TRF-260712-0005", transferType: "external", status: "Cancelled", shipped: 0, received: 0, returned: 0 }),
  ];
  for (const detail of cases) {
    assert.equal(auditTransactionDetailParity(detail).ok, true, detail.status);
  }
});

test("Phase 35.7 stock take matrix covers zero, positive, and negative inventory variance without wastage classification", () => {
  const cases = [
    stockTakeDetail({ reference: "STK-260712-0001", expected: 10, counted: 10 }),
    stockTakeDetail({ reference: "STK-260712-0002", expected: 10, counted: 12 }),
    stockTakeDetail({ reference: "STK-260712-0003", expected: 10, counted: 8 }),
  ];
  for (const detail of cases) {
    assert.equal(auditTransactionDetailParity(detail).ok, true, detail.transactionReference);
    assert.match(detail.metadata.varianceAccountingPolicy, /inventory variance, not wastage/i);
  }
});

test("Phase 35.7 transaction exports remain selected-record only and retain audit and movement sheets", () => {
  for (const detail of allFamilyDetails) {
    const audit = auditTransactionDetailExports(detail);
    assert.equal(audit.ok, true, `${detail.transactionReference}: ${JSON.stringify(audit.problems, null, 2)}`);
    assert.equal(audit.report.rows.length, detail.lineItems.length);
    assert.equal(audit.sheets.find((sheet) => sheet.name === "Line Items").rows.length, detail.lineItems.length);
  }
});

test("Phase 35.7 permissions, scheduling, and real-data-only contracts remain production-safe", () => {
  const route = read("cloudflare-v2/src/legacy/transaction-detail-routes.ts");
  const scheduling = read("cloudflare-v2/src/legacy/report-scheduling-routes.ts");
  const reporting = read("src/modules/reporting/api/reportDataSourceCatalog.js");

  assert.match(route, /assertWorkspaceAccess/);
  assert.match(route, /assertWorkspacePermission\(env, auth, workspaceId, "nav-reporting"\)/);
  assert.match(route, /assertDetailLocationAccess/);
  assert.match(route, /Transaction reference does not match the requested transaction/);
  assert.match(route, /Transaction type does not match/);

  for (const family of PHASE35_TRANSACTION_FAMILIES) {
    assert.match(scheduling, new RegExp(`${family.reportId}:`));
  }
  assert.doesNotMatch(reporting, /mockReportData/);
});

test("Phase 35.7 complete transaction production sign-off passes", () => {
  const signoff = buildPhase35TransactionSignoff(allFamilyDetails);
  assert.equal(signoff.ok, true, JSON.stringify(signoff.checks, null, 2));
});
