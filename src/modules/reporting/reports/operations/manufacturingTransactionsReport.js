import { fetchManufacturingTransactionRows } from "../../api/reportingApi.js";
import { safeNumber } from "../../engine/calculations.js";
import { zonedDateTimeStrings } from "../../engine/timezone.js";
import { text, toArray } from "../../engine/grouping.js";

const batchColumns = [
  { key: "transactionReference", label: "Transaction ID", type: "transaction_id", sortable: true },
  { key: "batchDate", label: "Batch Date", type: "date", sortable: true },
  { key: "batchTime", label: "Time", type: "time", sortable: true },
  { key: "manufacturedItemName", label: "Manufactured Item", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  { key: "plannedYield", label: "Planned Yield", type: "number", align: "right", sortable: true },
  { key: "actualYield", label: "Actual Yield", type: "number", align: "right", sortable: true },
  { key: "yieldVariance", label: "Yield Variance", type: "number", align: "right", sortable: true },
  { key: "yieldVariancePercent", label: "Yield Variance %", type: "percent", align: "right", sortable: true },
  { key: "yieldUom", label: "Yield UOM", sortable: true },
  { key: "ingredientCostTotal", label: "Ingredient Cost", type: "money", align: "right", sortable: true },
  { key: "outputValue", label: "Output Value", type: "money", align: "right", sortable: true },
  { key: "wastageQty", label: "Wastage Qty", type: "number", align: "right", sortable: true },
  { key: "wastageValue", label: "Wastage Value", type: "money", align: "right", sortable: true },
  { key: "status", label: "Status", type: "badge", sortable: true },
  { key: "ledgerStatus", label: "Ledger", type: "badge", sortable: true },
  { key: "committedBy", label: "Committed By", sortable: true },
];

const byManufacturedItemColumns = [
  { key: "manufacturedItemName", label: "Manufactured Item", sortable: true },
  { key: "category", label: "Category", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  { key: "batchCount", label: "Batches", type: "number", align: "right", sortable: true },
  { key: "plannedYield", label: "Planned Yield", type: "number", align: "right", sortable: true },
  { key: "actualYield", label: "Actual Yield", type: "number", align: "right", sortable: true },
  { key: "yieldVariance", label: "Yield Variance", type: "number", align: "right", sortable: true },
  { key: "yieldVariancePercent", label: "Yield Variance %", type: "percent", align: "right", sortable: true },
  { key: "ingredientCost", label: "Ingredient Cost", type: "money", align: "right", sortable: true },
  { key: "outputValue", label: "Output Value", type: "money", align: "right", sortable: true },
  { key: "wastageQty", label: "Wastage Qty", type: "number", align: "right", sortable: true },
  { key: "wastageValue", label: "Wastage Value", type: "money", align: "right", sortable: true },
];

const byLocationColumns = [
  { key: "locationName", label: "Location", sortable: true },
  { key: "batchCount", label: "Batches", type: "number", align: "right", sortable: true },
  { key: "manufacturedItemCount", label: "Manufactured Items", type: "number", align: "right", sortable: true },
  { key: "plannedYield", label: "Planned Yield", type: "number", align: "right", sortable: true },
  { key: "actualYield", label: "Actual Yield", type: "number", align: "right", sortable: true },
  { key: "yieldVariance", label: "Yield Variance", type: "number", align: "right", sortable: true },
  { key: "ingredientCost", label: "Ingredient Cost", type: "money", align: "right", sortable: true },
  { key: "outputValue", label: "Output Value", type: "money", align: "right", sortable: true },
  { key: "wastageQty", label: "Wastage Qty", type: "number", align: "right", sortable: true },
  { key: "wastageValue", label: "Wastage Value", type: "money", align: "right", sortable: true },
  { key: "reconciledBatches", label: "Reconciled", type: "number", align: "right", sortable: true },
];

const ingredientUsageColumns = [
  { key: "ingredientItemName", label: "Ingredient", sortable: true },
  { key: "ingredientCategory", label: "Category", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  { key: "batchCount", label: "Batches Used In", type: "number", align: "right", sortable: true },
  { key: "ingredientQty", label: "Quantity Used", type: "number", align: "right", sortable: true },
  { key: "ingredientUom", label: "UOM", sortable: true },
  { key: "averageUnitCost", label: "Average Unit Cost", type: "money", align: "right", sortable: true },
  { key: "ingredientCost", label: "Ingredient Cost", type: "money", align: "right", sortable: true },
  { key: "lastUsedAt", label: "Last Used", type: "datetime", sortable: true },
];

const wastageColumns = [
  { key: "transactionReference", label: "Transaction ID", type: "transaction_id", sortable: true },
  { key: "batchDate", label: "Batch Date", type: "date", sortable: true },
  { key: "manufacturedItemName", label: "Manufactured Item", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  { key: "plannedYield", label: "Planned Yield", type: "number", align: "right", sortable: true },
  { key: "actualYield", label: "Actual Yield", type: "number", align: "right", sortable: true },
  { key: "wastageQty", label: "Yield Loss Qty", type: "number", align: "right", sortable: true },
  { key: "wastagePercent", label: "Yield Loss %", type: "percent", align: "right", sortable: true },
  { key: "wastageValue", label: "Wastage Value", type: "money", align: "right", sortable: true },
  { key: "accountingTreatment", label: "Accounting Treatment", sortable: true },
  { key: "committedBy", label: "Committed By", sortable: true },
];

const lineDetailColumns = [
  { key: "transactionReference", label: "Transaction ID", type: "transaction_id", sortable: true },
  { key: "postedAt", label: "Batch Date and Time", type: "datetime", sortable: true },
  { key: "manufacturedItemName", label: "Manufactured Item", sortable: true },
  { key: "locationName", label: "Location", sortable: true },
  { key: "ingredientItemName", label: "Ingredient", sortable: true },
  { key: "ingredientCategory", label: "Ingredient Category", sortable: true },
  { key: "ingredientQty", label: "Quantity Used", type: "number", align: "right", sortable: true },
  { key: "ingredientUom", label: "UOM", sortable: true },
  { key: "ingredientUnitCost", label: "Unit Cost Ex VAT", type: "money", align: "right", sortable: true },
  { key: "ingredientCost", label: "Ingredient Cost", type: "money", align: "right", sortable: true },
  { key: "plannedYield", label: "Planned Yield", type: "number", align: "right", sortable: true },
  { key: "actualYield", label: "Actual Yield", type: "number", align: "right", sortable: true },
  { key: "wastageQty", label: "Wastage Qty", type: "number", align: "right", sortable: true },
  { key: "outputUnitCost", label: "Output Unit Cost", type: "money", align: "right", sortable: true },
  { key: "status", label: "Status", type: "badge", sortable: true },
  { key: "committedBy", label: "Committed By", sortable: true },
  { key: "note", label: "Notes" },
];

export const manufacturingTransactionsReport = {
  id: "manufacturing_transactions",
  title: "Manufacturing",
  section: "operations",
  description: "Review manufacturing batches, planned and actual yield, ingredient consumption, output cost, and manufacturing wastage.",
  emptyState: {
    title: "No manufacturing transactions found",
    message: "No manufacturing batches matched the selected filters.",
  },
  defaultView: "batches",
  availableViews: [
    "batches",
    "by_manufactured_item",
    "by_location",
    "ingredient_usage",
    "wastage",
    "line_detail",
  ],
  filterConfig: {
    batches: ["search", "dateRange", "location", "category", "status"],
    by_manufactured_item: ["search", "dateRange", "location", "category"],
    by_location: ["search", "dateRange", "location"],
    ingredient_usage: ["search", "dateRange", "location"],
    wastage: ["search", "dateRange", "location", "category"],
    line_detail: ["search", "dateRange", "time", "location", "category", "status"],
  },
  columns: {
    batches: batchColumns,
    by_manufactured_item: byManufacturedItemColumns,
    by_location: byLocationColumns,
    ingredient_usage: ingredientUsageColumns,
    wastage: wastageColumns,
    line_detail: lineDetailColumns,
  },
  exportColumns: {
    batches: batchColumns,
    by_manufactured_item: byManufacturedItemColumns,
    by_location: byLocationColumns,
    ingredient_usage: ingredientUsageColumns,
    wastage: wastageColumns,
    line_detail: lineDetailColumns,
  },
  getRows: async ({ workspaceId, filters, services = {}, view = "batches" }) => {
    const model = await loadManufacturingModel({ workspaceId, filters, services });
    return (model.views[view] || []).map((row) => ({
      ...row,
      __apiMeta: model.meta,
      __apiWarnings: model.warnings,
    }));
  },
  getTotals: ({ rows, view }) => totalsForView(rows, view),
  validate: ({ rows }) => validateRows(rows),
  exportMapping: Object.fromEntries([
    ...batchColumns,
    ...byManufacturedItemColumns,
    ...byLocationColumns,
    ...ingredientUsageColumns,
    ...wastageColumns,
    ...lineDetailColumns,
  ].map((column) => [column.key, column.label])),
};

async function loadManufacturingModel({ workspaceId, filters, services = {} }) {
  const response = await loadSource({ workspaceId, filters, services });
  const sourceRows = toArray(response.rows).map(normalizeLine);
  const batches = buildBatchRows(sourceRows);
  return {
    warnings: toArray(response.warnings),
    meta: response.meta || {},
    views: {
      batches,
      by_manufactured_item: aggregateByManufacturedItem(batches),
      by_location: aggregateByLocation(batches),
      ingredient_usage: aggregateIngredientUsage(sourceRows),
      wastage: batches.filter((row) => row.wastageQty > 0).map((row) => ({
        ...row,
        wastagePercent: row.plannedYield > 0 ? row.wastageQty / row.plannedYield * 100 : 0,
        accountingTreatment: "Accounting-only yield loss",
      })),
      line_detail: sourceRows,
    },
  };
}

async function loadSource({ workspaceId, filters, services = {} }) {
  if (services.reporting?.getManufacturingTransactionRows) {
    return normalizeResponse(await services.reporting.getManufacturingTransactionRows({ workspaceId, filters }));
  }
  if (services.reporting?.getManufacturingTransactions) {
    return normalizeResponse(await services.reporting.getManufacturingTransactions({ workspaceId, filters }));
  }
  return normalizeResponse(await fetchManufacturingTransactionRows({ workspaceId, filters }));
}

function normalizeResponse(value) {
  if (Array.isArray(value)) return { rows: value, warnings: [], meta: {} };
  return {
    rows: toArray(value?.rows || value?.data || value?.items),
    warnings: toArray(value?.warnings),
    meta: value?.meta || {},
  };
}

function normalizeLine(row = {}) {
  const postedAt = text(row.postedAt || row.batchDate || row.date);
  const local = zonedDateTimeStrings(postedAt);
  return {
    ...row,
    manufacturingBatchId: text(row.manufacturingBatchId || row.sourceId || row.documentId),
    transactionReference: text(row.transactionReference || row.documentNumber),
    postedAt,
    batchDate: local.date,
    batchTime: local.time,
    manufacturedItemName: text(row.manufacturedItemName || row.itemName),
    itemName: text(row.manufacturedItemName || row.itemName),
    category: text(row.category || "General"),
    locationName: text(row.locationName),
    plannedYield: safeNumber(row.plannedYield),
    actualYield: safeNumber(row.actualYield),
    yieldVariance: safeNumber(row.yieldVariance),
    yieldVariancePercent: safeNumber(row.yieldVariancePercent),
    ingredientQty: safeNumber(row.ingredientQty),
    ingredientUnitCost: safeNumber(row.ingredientUnitCost),
    ingredientCost: safeNumber(row.ingredientCost),
    ingredientCostTotal: safeNumber(row.ingredientCostTotal),
    outputUnitCost: safeNumber(row.outputUnitCost),
    outputValue: safeNumber(row.outputValue),
    wastageQty: safeNumber(row.wastageQty),
    wastageValue: safeNumber(row.wastageValue),
    ledgerStatus: row.ledgerReconciled === false ? "Review Required" : "Reconciled",
  };
}

function buildBatchRows(rows) {
  const byBatch = new Map();
  rows.forEach((row) => {
    const key = text(row.manufacturingBatchId || row.transactionReference || row.id);
    if (!key || byBatch.has(key)) return;
    byBatch.set(key, {
      ...row,
      id: `manufacturing-batch:${key}`,
      ingredientCount: safeNumber(row.ingredientCount),
    });
  });
  return [...byBatch.values()];
}

function aggregateByManufacturedItem(rows) {
  return aggregate(rows, (row) => `${text(row.manufacturedItemId)}:${text(row.locationId)}`, (group, key) => {
    const plannedYield = sum(group, "plannedYield");
    const actualYield = sum(group, "actualYield");
    const first = group[0] || {};
    return {
      id: `manufactured-item:${key}`,
      manufacturedItemId: first.manufacturedItemId,
      manufacturedItemName: first.manufacturedItemName,
      category: first.category,
      locationId: first.locationId,
      locationName: first.locationName,
      batchCount: group.length,
      plannedYield,
      actualYield,
      yieldVariance: actualYield - plannedYield,
      yieldVariancePercent: plannedYield > 0 ? (actualYield - plannedYield) / plannedYield * 100 : 0,
      ingredientCost: sum(group, "ingredientCostTotal"),
      outputValue: sum(group, "outputValue"),
      wastageQty: sum(group, "wastageQty"),
      wastageValue: sum(group, "wastageValue"),
    };
  });
}

function aggregateByLocation(rows) {
  return aggregate(rows, (row) => text(row.locationId || row.locationName), (group, key) => {
    const first = group[0] || {};
    return {
      id: `manufacturing-location:${key}`,
      locationId: first.locationId,
      locationName: first.locationName,
      batchCount: group.length,
      manufacturedItemCount: new Set(group.map((row) => text(row.manufacturedItemId || row.manufacturedItemName))).size,
      plannedYield: sum(group, "plannedYield"),
      actualYield: sum(group, "actualYield"),
      yieldVariance: sum(group, "yieldVariance"),
      ingredientCost: sum(group, "ingredientCostTotal"),
      outputValue: sum(group, "outputValue"),
      wastageQty: sum(group, "wastageQty"),
      wastageValue: sum(group, "wastageValue"),
      reconciledBatches: group.filter((row) => row.ledgerReconciled !== false).length,
    };
  });
}

function aggregateIngredientUsage(rows) {
  const usable = rows.filter((row) => text(row.ingredientItemId || row.ingredientItemName));
  return aggregate(usable, (row) => `${text(row.ingredientItemId)}:${text(row.locationId)}`, (group, key) => {
    const first = group[0] || {};
    const quantity = sum(group, "ingredientQty");
    const cost = sum(group, "ingredientCost");
    const latest = [...group].sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)))[0];
    return {
      id: `ingredient-usage:${key}`,
      ingredientItemId: first.ingredientItemId,
      ingredientItemName: first.ingredientItemName,
      ingredientCategory: first.ingredientCategory,
      locationId: first.locationId,
      locationName: first.locationName,
      batchCount: new Set(group.map((row) => text(row.manufacturingBatchId))).size,
      ingredientQty: quantity,
      ingredientUom: first.ingredientUom,
      averageUnitCost: quantity > 0 ? cost / quantity : 0,
      ingredientCost: cost,
      lastUsedAt: latest?.postedAt || "",
    };
  });
}

function aggregate(rows, keySelector, mapper) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keySelector(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.entries()].map(([key, group]) => mapper(group, key));
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + safeNumber(row[key]), 0);
}

function totalsForView(rows = [], view = "batches") {
  const list = toArray(rows);
  if (view === "ingredient_usage") {
    return {
      ingredientQty: sum(list, "ingredientQty"),
      ingredientCost: sum(list, "ingredientCost"),
      batchCount: sum(list, "batchCount"),
    };
  }
  if (view === "by_location" || view === "by_manufactured_item") {
    return {
      batchCount: sum(list, "batchCount"),
      plannedYield: sum(list, "plannedYield"),
      actualYield: sum(list, "actualYield"),
      ingredientCost: sum(list, "ingredientCost"),
      outputValue: sum(list, "outputValue"),
      wastageValue: sum(list, "wastageValue"),
    };
  }
  return {
    batches: view === "line_detail" ? new Set(list.map((row) => text(row.manufacturingBatchId))).size : list.length,
    plannedYield: sum(list, "plannedYield"),
    actualYield: sum(list, "actualYield"),
    ingredientCost: sum(list, view === "line_detail" ? "ingredientCost" : "ingredientCostTotal"),
    outputValue: view === "line_detail" ? 0 : sum(list, "outputValue"),
    wastageValue: view === "line_detail" ? 0 : sum(list, "wastageValue"),
  };
}

function validateRows(rows = []) {
  const list = toArray(rows);
  const apiWarnings = list.flatMap((row) => toArray(row.__apiWarnings));
  const warnings = [...apiWarnings];
  list.forEach((row) => {
    if (row.manufacturedItemName === "") warnings.push({ code: `manufacturing-item:${row.id}`, level: "critical", message: "Manufacturing transaction — Manufactured item missing" });
    if (row.locationName === "") warnings.push({ code: `manufacturing-location:${row.id}`, level: "critical", message: `${row.manufacturedItemName || "Manufacturing transaction"} — Location missing` });
  });
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default manufacturingTransactionsReport;
