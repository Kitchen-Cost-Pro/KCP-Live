import {
  absoluteValue,
  calculateStockValue,
  safeNumber,
} from "../../engine/calculations.js";
import { groupBy, sumBy, text, toArray } from "../../engine/grouping.js";
import { buildRowWarnings } from "../../validators/rowWarningUtils.js";
import { formatMoney, formatNumber } from "../../engine/formatters.js";
import {
  DEFAULT_REPORT_TIMEZONE,
  formatReportTime,
} from "../../engine/timezone.js";
import { buildRowFormulaTooltip } from "../../tooltips/tooltipBuilder.js";
import { reconcileStockTransfersToDetailedActivity } from "../../validators/reconciliationChecks.js";
import { detailedActivityReport } from "./detailedActivityReport.js";
import { fetchStockTransferTransactionRows } from "../../api/reportingApi.js";

const VALUE_TOLERANCE = 0.01;
const QTY_TOLERANCE = 0.0001;

const summaryColumns = [
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
  {
    key: "requestedAt",
    label: "Requested At",
    type: "datetime",
    sortable: true,
  },
  {
    key: "acceptedAt",
    label: "Accepted At",
    type: "datetime",
    sortable: true,
  },
  { key: "transferTypeLabel", label: "Transfer Type", sortable: true },
  { key: "fromSiteName", label: "From Site", sortable: true },
  { key: "fromLocationName", label: "From Location", sortable: true },
  { key: "toSiteName", label: "To Site", sortable: true },
  { key: "toLocationDisplay", label: "To Location", sortable: true },
  { key: "status", label: "Status", sortable: true },
  {
    key: "shippedQty",
    label: "Shipped Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "receivedQty",
    label: "Received Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "returnedQty",
    label: "Returned Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "items",
    label: "Items",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "totalQty",
    label: "Total Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "totalTransferValue",
    label: "Total Transfer Value",
    type: "money",
    align: "right",
    tooltipKey: "transferValue",
    cellTooltip: transferValueTooltip,
    sortable: true,
  },
  { key: "createdBy", label: "Created By", sortable: true },
  {
    key: "committedBy",
    label: "Accepted / Committed By",
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
  { key: "transferTypeLabel", label: "Transfer Type", sortable: true },
  { key: "fromSiteName", label: "From Site", sortable: true },
  { key: "fromLocationName", label: "From Location", sortable: true },
  { key: "toSiteName", label: "To Site", sortable: true },
  { key: "toLocationDisplay", label: "To Location", sortable: true },
  {
    key: "qtyTransferred",
    label: "Qty Transferred",
    type: "number",
    align: "right",
    sortable: true,
  },
  { key: "baseUom", label: "Base UOM", sortable: true },
  {
    key: "unitCostExVat",
    label: "Unit Cost Ex VAT",
    type: "money",
    align: "right",
    tooltipKey: "unitCostExVat",
    sortable: true,
  },
  {
    key: "transferValue",
    label: "Transfer Value",
    type: "money",
    align: "right",
    tooltipKey: "transferValue",
    cellTooltip: transferValueTooltip,
    sortable: true,
  },
  { key: "status", label: "Status", sortable: true },
];

const byLocationColumns = [
  { key: "locationName", label: "Location", sortable: true },
  {
    key: "transfersInQty",
    label: "Transfers In Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "transfersInValue",
    label: "Transfers In Value",
    type: "money",
    align: "right",
    sortable: true,
  },
  {
    key: "transfersOutQty",
    label: "Transfers Out Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "transfersOutValue",
    label: "Transfers Out Value",
    type: "money",
    align: "right",
    sortable: true,
  },
  {
    key: "netTransferQty",
    label: "Net Transfer Qty",
    type: "number",
    align: "right",
    tooltipKey: "netTransferQty",
    cellTooltip: netTransferQtyTooltip,
    sortable: true,
  },
  {
    key: "netTransferValue",
    label: "Net Transfer Value",
    type: "money",
    align: "right",
    tooltipKey: "netTransferValue",
    cellTooltip: netTransferValueTooltip,
    sortable: true,
  },
  {
    key: "transferEvents",
    label: "Transfer Events",
    type: "number",
    align: "right",
    sortable: true,
  },
];

const lineDetailColumns = [
  { key: "date", label: "Date", type: "date", sortable: true },
  { key: "time", label: "Time", type: "time", sortable: true },
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
    sortable: true,
  },
  { key: "locationName", label: "Location", sortable: true },
  { key: "direction", label: "Direction", sortable: true },
  { key: "itemName", label: "Item", sortable: true },
  { key: "category", label: "Category", sortable: true },
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
    tooltipKey: "unitCostExVat",
    sortable: true,
  },
  {
    key: "movementValue",
    label: "Movement Value",
    type: "money",
    align: "right",
    tooltipKey: "movementValue",
    cellTooltip: movementValueTooltip,
    sortable: true,
  },
  { key: "transferTypeLabel", label: "Transfer Type", sortable: true },
  { key: "fromSiteName", label: "From Site", sortable: true },
  { key: "fromLocationName", label: "From Location", sortable: true },
  { key: "toSiteName", label: "To Site", sortable: true },
  { key: "toLocationDisplay", label: "To Location", sortable: true },
  { key: "status", label: "Status", sortable: true },
  {
    key: "shippedQty",
    label: "Shipped Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "receivedQty",
    label: "Received Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  {
    key: "returnedQty",
    label: "Returned Qty",
    type: "number",
    align: "right",
    sortable: true,
  },
  { key: "createdBy", label: "Created By", sortable: true },
  { key: "committedBy", label: "Committed By", sortable: true },
  { key: "notes", label: "Notes" },
];

const transferExportColumns = [
  { key: "date", label: "Date", type: "date" },
  { key: "time", label: "Time", type: "time" },
  {
    key: "transactionReference",
    label: "Transaction ID",
    type: "transaction_id",
  },
  { key: "transferTypeLabel", label: "Transfer Type" },
  { key: "fromSiteName", label: "From Site" },
  { key: "fromLocationName", label: "From Location" },
  { key: "toSiteName", label: "To Site" },
  { key: "toLocationDisplay", label: "To Location" },
  { key: "requestedAt", label: "Requested At" },
  { key: "acceptedAt", label: "Accepted At" },
  { key: "shippedQty", label: "Shipped Qty", type: "number" },
  { key: "receivedQty", label: "Received Qty", type: "number" },
  { key: "returnedQty", label: "Returned Qty", type: "number" },
  { key: "locationName", label: "Location" },
  { key: "direction", label: "Direction" },
  { key: "itemName", label: "Item" },
  { key: "category", label: "Category" },
  { key: "qtyIn", label: "Qty In", type: "number" },
  { key: "qtyOut", label: "Qty Out", type: "number" },
  { key: "netQty", label: "Net Qty", type: "number" },
  { key: "baseUom", label: "UOM" },
  { key: "unitCostExVat", label: "Unit Cost Ex VAT", type: "money" },
  { key: "transferValue", label: "Transfer Value", type: "money" },
  { key: "movementValue", label: "Movement Value", type: "money" },
  { key: "status", label: "Status" },
  { key: "createdBy", label: "Created By" },
  { key: "committedBy", label: "Committed By" },
  { key: "notes", label: "Notes" },
];

const transferExportMapping = {
  date: "Date",
  time: "Time",
  transactionReference: "Transaction ID",
  transferTypeLabel: "Transfer Type",
  fromSiteName: "From Site",
  fromLocationName: "From Location",
  toSiteName: "To Site",
  toLocationDisplay: "To Location",
  requestedAt: "Requested At",
  acceptedAt: "Accepted At",
  shippedQty: "Shipped Qty",
  receivedQty: "Received Qty",
  returnedQty: "Returned Qty",
  locationName: "Location",
  direction: "Direction",
  itemName: "Item",
  category: "Category",
  qtyIn: "Qty In",
  qtyOut: "Qty Out",
  netQty: "Net Qty",
  baseUom: "UOM",
  unitCostExVat: "Unit Cost Ex VAT",
  transferValue: "Transfer Value",
  movementValue: "Movement Value",
  status: "Status",
  createdBy: "Created By",
  committedBy: "Committed By",
  notes: "Notes",
};

const movementLedgerColumns = [
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
    tooltipKey: "unitCostExVat",
    sortable: true,
  },
  {
    key: "movementValue",
    label: "Movement Value",
    type: "money",
    align: "right",
    tooltipKey: "movementValue",
    cellTooltip: movementValueTooltip,
    sortable: true,
  },
  {
    key: "runningQty",
    label: "Running Qty",
    type: "number",
    align: "right",
    tooltipKey: "runningQty",
    sortable: true,
  },
  {
    key: "runningValue",
    label: "Running Value",
    type: "money",
    align: "right",
    tooltipKey: "runningValue",
    sortable: true,
  },
  { key: "createdBy", label: "Created By", sortable: true },
  { key: "notes", label: "Notes" },
];

export const stockTransfersReport = {
  id: "stock_transfers",
  title: "Stock Transfers Report",
  section: "operations",
  description:
    "Track stock movement between locations, including Transfer Out from the source location and Transfer In to the destination location.",
  emptyState: {
    title: "No stock transfers found",
    message: "No stock transfers found for the selected filters.",
  },
  suppressEmptyWarning: true,
  defaultView: "summary",
  availableViews: [
    "summary",
    "by_item",
    "by_location",
    "line_detail",
    "movement_ledger",
  ],
  filterConfig: {
    summary: ["search", "dateRange", "location", "source"],
    by_item: ["search", "dateRange", "location", "category", "source"],
    by_location: ["search", "dateRange", "location", "category", "source"],
    line_detail: [
      "search",
      "dateRange",
      "time",
      "location",
      "category",
      "source",
    ],
    movement_ledger: [
      "search",
      "dateRange",
      "time",
      "location",
      "category",
      "source",
    ],
  },

  columns: {
    summary: summaryColumns,
    by_item: byItemColumns,
    by_location: byLocationColumns,
    line_detail: lineDetailColumns,
    movement_ledger: movementLedgerColumns,
  },

  exportColumns: {
    summary: transferExportColumns,
    by_item: transferExportColumns,
    by_location: transferExportColumns,
    line_detail: transferExportColumns,
    movement_ledger: transferExportColumns,
  },

  getRows: async ({
    workspaceId,
    filters,
    services = {},
    dataSet = {},
    view = "summary",
  }) => {
    const ledgerRows = await detailedActivityReport.getRows({
      workspaceId,
      filters,
      services,
      dataSet,
      view: "ledger",
    });
    const pairingLedgerRows = await loadPairingLedgerRows({
      workspaceId,
      filters,
      services,
      dataSet,
      ledgerRows,
    });
    const pairRows = buildTransferRows(pairingLedgerRows, pairingLedgerRows);
    const transferRows = buildTransferRows(ledgerRows, pairingLedgerRows);
    const transactionResponse = await loadTransferTransactionRows({
      workspaceId,
      filters,
      services,
      dataSet,
    });
    const transactionRows = toArray(transactionResponse.rows).map(
      (row, index) => normalizeTransferRowBase(
        { ...row, transactionSource: true },
        index,
      ),
    );
    const model = buildTransferModel(
      transferRows,
      pairRows,
      ledgerRows,
      transactionRows,
      transactionResponse,
    );
    rememberStockTransferModel(services, model);
    return (model.views[view] || model.views.summary).map((row) =>
      withMeta(row, model),
    );
  },

  getTotals: ({ rows, view }) => getTotalsForView(view, rows),

  validate: ({ services }) =>
    validateTransferRows(services?.reporting?.__lastStockTransfersModel),

  exportMapping: {
    summary: transferExportMapping,
    by_item: transferExportMapping,
    by_location: transferExportMapping,
    line_detail: transferExportMapping,
    movement_ledger: transferExportMapping,
  },
};

async function loadPairingLedgerRows({
  workspaceId,
  filters = {},
  services = {},
  dataSet = {},
  ledgerRows = [],
}) {
  if (!text(filters.locationId) && !text(filters.time)) return ledgerRows;
  const pairingFilters = { ...filters, locationId: "", time: "" };
  return detailedActivityReport.getRows({
    workspaceId,
    filters: pairingFilters,
    services,
    dataSet,
    view: "ledger",
  });
}

export function buildTransferRows(
  ledgerRows = [],
  pairingLedgerRows = ledgerRows,
) {
  const pairBaseRows = toArray(pairingLedgerRows)
    .filter(isTransferLedgerRow)
    .map(normalizeTransferRowBase);
  const pairIndex = buildPairIndex(pairBaseRows);
  return toArray(ledgerRows)
    .filter(isTransferLedgerRow)
    .map((row, index) =>
      completeTransferRow(normalizeTransferRowBase(row, index), pairIndex),
    );
}

function buildTransferModel(
  transferRows = [],
  pairRows = [],
  ledgerRows = [],
  transactionRows = [],
  transactionResponse = {},
) {
  const rows = toArray(transferRows);
  const transactions = toArray(transactionRows);
  const transactionViewRows = transactions.length ? transactions : rows;
  return {
    transferRows: rows,
    transactionRows: transactions,
    pairRows: toArray(pairRows),
    ledgerRows: toArray(ledgerRows),
    transactionWarnings: toArray(transactionResponse?.warnings),
    transactionMeta: transactionResponse?.meta || {},
    views: {
      summary: buildSummaryRows(transactionViewRows),
      by_item: buildByItemRows(transactionViewRows),
      by_location: buildByLocationRows(rows),
      line_detail: transactionViewRows,
      movement_ledger: rows.map(toMovementLedgerRow),
    },
  };
}

async function loadTransferTransactionRows({
  workspaceId,
  filters = {},
  services = {},
  dataSet = {},
}) {
  if (services.reporting?.getStockTransferTransactionRows) {
    return normalizeTransferTransactionResponse(
      await services.reporting.getStockTransferTransactionRows({
        workspaceId,
        filters,
      }),
    );
  }
  const provided =
    dataSet.stockTransferTransactions ||
    dataSet.stock_transfer_transactions ||
    dataSet.transferTransactions;
  if (provided) return normalizeTransferTransactionResponse(provided);
  if (typeof window !== "undefined") {
    return normalizeTransferTransactionResponse(
      await fetchStockTransferTransactionRows({ workspaceId, filters }),
    );
  }
  return { rows: [], warnings: [], meta: {} };
}

function normalizeTransferTransactionResponse(value = {}) {
  if (Array.isArray(value)) return { rows: value, warnings: [], meta: {} };
  return {
    rows: toArray(value?.rows || value?.data || value?.items),
    warnings: toArray(value?.warnings),
    meta: value?.meta || {},
  };
}

function normalizeTransferRowBase(row = {}, index = 0) {
  const direction = resolveTransferDirection(row);
  const qtyIn = safeNumber(row.qtyIn ?? row.qty_in);
  const qtyOut = safeNumber(row.qtyOut ?? row.qty_out);
  const netQty = hasValue(row.netQty ?? row.net_qty)
    ? safeNumber(row.netQty ?? row.net_qty)
    : qtyIn - qtyOut;
  const hasQuantity =
    hasValue(row.qtyIn ?? row.qty_in) ||
    hasValue(row.qtyOut ?? row.qty_out) ||
    hasValue(row.netQty ?? row.net_qty);
  const unitCostRaw =
    row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost;
  const unitCostExVat = safeNumber(unitCostRaw);
  const hasUnitCost = hasValue(unitCostRaw);
  const movementValueRaw =
    row.movementValue ??
    row.movement_value ??
    row.valueDelta ??
    row.value_delta ??
    row.netValue;
  const hasMovementValue = hasValue(movementValueRaw);
  const movementValue = hasMovementValue
    ? safeNumber(movementValueRaw)
    : calculateStockValue(netQty, unitCostExVat);
  const raw = row.raw || row.rawSourceRow || row.raw_source_row || {};
  const metadata = raw.metadata || row.metadata || {};
  const transferEnvelope =
    raw.transfer || raw.externalTransfer || raw.external_transfer || {};
  const transferMeta =
    transferEnvelope.transferMeta ||
    transferEnvelope.transfer_meta ||
    transferEnvelope.metadata ||
    transferEnvelope;
  const locationId = text(row.locationId || row.location_id);
  const locationName = text(row.locationName || row.location_name);
  const fromLocationId = text(
    row.fromLocationId ||
      row.from_location_id ||
      raw.fromLocationId ||
      raw.from_location_id ||
      metadata.fromLocationId ||
      metadata.from_location_id ||
      transferMeta.fromLocationId ||
      transferMeta.from_location_id ||
      (direction === "Transfer Out" ? locationId : ""),
  );
  const fromLocationName = text(
    row.fromLocationName ||
      row.from_location_name ||
      raw.fromLocationName ||
      raw.from_location_name ||
      metadata.fromLocationName ||
      metadata.from_location_name ||
      transferMeta.fromLocationName ||
      transferMeta.from_location_name ||
      (direction === "Transfer Out" ? locationName : ""),
  );
  const toLocationId = text(
    row.toLocationId ||
      row.to_location_id ||
      raw.toLocationId ||
      raw.to_location_id ||
      metadata.toLocationId ||
      metadata.to_location_id ||
      transferMeta.toLocationId ||
      transferMeta.to_location_id ||
      (direction === "Transfer In" ? locationId : ""),
  );
  const toLocationName = text(
    row.toLocationName ||
      row.to_location_name ||
      raw.toLocationName ||
      raw.to_location_name ||
      metadata.toLocationName ||
      metadata.to_location_name ||
      transferMeta.toLocationName ||
      transferMeta.to_location_name ||
      (direction === "Transfer In" ? locationName : ""),
  );
  const transferType = normalizeTransferType(
    row.transferType ||
      row.transfer_type ||
      raw.transferType ||
      raw.transfer_type ||
      metadata.transferType ||
      metadata.transfer_type ||
      transferMeta.transferType ||
      transferMeta.transfer_type,
  );
  const transferScope = text(
    row.transferScope ||
      row.transfer_scope ||
      raw.transferScope ||
      raw.transfer_scope ||
      metadata.transferScope ||
      metadata.transfer_scope ||
      transferMeta.transferScope ||
      transferMeta.transfer_scope ||
      transferType,
  );
  const fromSiteId = text(
    row.fromSiteId ||
      row.from_site_id ||
      raw.fromSiteId ||
      raw.from_site_id ||
      metadata.fromSiteId ||
      metadata.from_site_id ||
      transferMeta.fromSiteId ||
      transferMeta.from_site_id,
  );
  const fromSiteName = cleanSiteName(
    row.fromSiteName ||
      row.from_site_name ||
      raw.fromSiteName ||
      raw.from_site_name ||
      metadata.fromSiteName ||
      metadata.from_site_name ||
      transferMeta.fromSiteName ||
      transferMeta.from_site_name,
    fromSiteId,
    fromSiteId
      ? transferType === "external"
        ? "External Site"
        : "Current Site"
      : "",
  );
  const toSiteId = text(
    row.toSiteId ||
      row.to_site_id ||
      raw.toSiteId ||
      raw.to_site_id ||
      metadata.toSiteId ||
      metadata.to_site_id ||
      transferMeta.toSiteId ||
      transferMeta.to_site_id,
  );
  const toSiteName = cleanSiteName(
    row.toSiteName ||
      row.to_site_name ||
      raw.toSiteName ||
      raw.to_site_name ||
      metadata.toSiteName ||
      metadata.to_site_name ||
      transferMeta.toSiteName ||
      transferMeta.to_site_name,
    toSiteId,
    toSiteId
      ? transferType === "external"
        ? "External Site"
        : "Current Site"
      : "",
  );
  const requestedAt = text(
    row.requestedAt ||
      row.requested_at ||
      metadata.requestedAt ||
      metadata.requested_at ||
      transferMeta.requestedAt ||
      transferMeta.requested_at,
  );
  const acceptedAt = text(
    row.acceptedAt ||
      row.accepted_at ||
      metadata.acceptedAt ||
      metadata.accepted_at ||
      transferMeta.acceptedAt ||
      transferMeta.accepted_at,
  );
  const shippedQty = absoluteValue(
    safeNumber(
      row.shippedQty ??
        row.shipped_qty ??
        metadata.shippedQty ??
        metadata.shipped_qty ??
        transferMeta.shippedQty ??
        transferMeta.shipped_qty ??
        resolveTransferredQty({ direction, qtyIn, qtyOut, netQty }),
    ),
  );
  const receivedQty = absoluteValue(
    safeNumber(
      row.receivedQty ??
        row.received_qty ??
        metadata.receivedQty ??
        metadata.received_qty ??
        transferMeta.receivedQty ??
        transferMeta.received_qty,
    ),
  );
  const returnedQty = absoluteValue(
    safeNumber(
      row.returnedQty ??
        row.returned_qty ??
        metadata.returnedQty ??
        metadata.returned_qty ??
        transferMeta.returnedQty ??
        transferMeta.returned_qty,
    ),
  );
  const sourceId = text(row.sourceId || row.source_id);
  const documentNumber = text(
    row.documentNumber ||
      row.document_number ||
      row.reference ||
      row.number ||
      raw.transferNumber ||
      raw.transfer_number ||
      raw.reference ||
      raw.number,
  );
  const transactionReference = text(
    row.transactionReference ||
      row.transaction_reference ||
      metadata.transactionReference ||
      transferMeta.transactionReference ||
      documentNumber ||
      sourceId,
  );
  const transferNumber = transactionReference;
  const date = text(
    row.date ||
      row.movementDate ||
      row.movement_date ||
      row.timestamp ||
      row.createdAt ||
      row.created_at,
  ).slice(0, 10);
  const time = resolveTime(row);
  const itemId = text(
    row.itemId || row.item_id || row.stockItemId || row.stock_item_id,
  );
  const itemName = text(
    row.itemName || row.item_name || row.stockItemName || row.stock_item_name,
  );
  const qtyTransferred = row.transactionSource
    ? absoluteValue(
        safeNumber(
          row.qtyTransferred ?? row.qty_transferred ?? row.shippedQty ?? row.shipped_qty,
        ),
      )
    : resolveTransferredQty({
        direction,
        qtyIn,
        qtyOut,
        netQty,
      });

  return {
    ...row,
    id: text(row.id) || `stock-transfer:${index}`,
    date,
    time,
    transferDate: date,
    timestamp: text(
      row.timestamp ||
        row.occurredAt ||
        row.occurred_at ||
        row.createdAt ||
        row.created_at ||
        row.date,
    ),
    transferNumber,
    transactionReference,
    documentNumber: transferNumber,
    locationId,
    locationName,
    direction,
    movementType: direction,
    source: direction,
    sourceType: direction,
    sourceId,
    itemId,
    itemName,
    category:
      text(row.category || row.categoryName || row.category_name) || "General",
    qtyIn,
    qtyOut,
    netQty,
    qtyTransferred,
    baseUom: text(row.baseUom || row.base_uom || row.unit || row.uom),
    unit: text(row.baseUom || row.base_uom || row.unit || row.uom),
    unitCostExVat,
    unitCost: unitCostExVat,
    movementValue,
    transferValue: hasValue(row.transferValue ?? row.transfer_value)
      ? safeNumber(row.transferValue ?? row.transfer_value)
      : calculateStockValue(qtyTransferred, unitCostExVat),
    valueIn: qtyIn > 0 ? calculateStockValue(qtyIn, unitCostExVat) : 0,
    valueOut: qtyOut > 0 ? calculateStockValue(qtyOut, unitCostExVat) : 0,
    runningQty: row.runningQty ?? row.running_qty ?? null,
    runningValue: row.runningValue ?? row.running_value ?? null,
    transferType,
    transferTypeLabel: transferType === "external" ? "External" : "Internal",
    transferScope,
    fromSiteId,
    fromSiteName,
    fromLocationId,
    fromLocationName,
    toSiteId,
    toSiteName,
    toLocationId,
    toLocationName,
    toLocationDisplay: formatDestinationDisplay(
      transferType,
      toSiteName,
      toLocationName,
    ),
    requestedAt,
    acceptedAt,
    shippedQty,
    receivedQty,
    returnedQty,
    status: resolveStatus(row, raw, metadata),
    createdBy: text(
      row.createdBy ||
        row.createdByName ||
        row.created_by_name ||
        row.user ||
        raw.createdByName ||
        raw.createdBy ||
        raw.created_by,
    ),
    committedBy: text(
      row.committedBy ||
        row.committedByName ||
        row.committed_by_name ||
        row.submittedByName ||
        row.submitted_by_name ||
        raw.committedByName ||
        raw.committedBy ||
        raw.submittedByName ||
        row.createdBy ||
        row.createdByName ||
        row.user,
    ),
    notes: text(
      row.notes ||
        row.note ||
        raw.notes ||
        raw.note ||
        metadata.notes ||
        metadata.note,
    ),
    raw,
    __hasQuantity: hasQuantity,
    __hasUnitCost: hasUnitCost,
    __hasMovementValue: hasMovementValue,
    __pairKey: getTransferPairKey({
      sourceId,
      documentNumber,
      transferNumber,
      itemId,
      itemName,
    }),
  };
}

function buildPairIndex(pairRows = []) {
  const index = new Map();
  toArray(pairRows).forEach((row) => {
    const key = row.__pairKey || getTransferPairKey(row);
    if (!index.has(key)) index.set(key, { rows: [], inRows: [], outRows: [] });
    const group = index.get(key);
    group.rows.push(row);
    if (row.direction === "Transfer In") group.inRows.push(row);
    if (row.direction === "Transfer Out") group.outRows.push(row);
  });
  return index;
}

function completeTransferRow(row = {}, pairIndex = new Map()) {
  const pair = pairIndex.get(row.__pairKey) || {
    rows: [row],
    inRows: row.direction === "Transfer In" ? [row] : [],
    outRows: row.direction === "Transfer Out" ? [row] : [],
  };
  const outRow = pair.outRows[0] || {};
  const inRow = pair.inRows[0] || {};
  const fromLocationId = text(
    row.fromLocationId || outRow.locationId || outRow.fromLocationId,
  );
  const fromLocationName = text(
    row.fromLocationName || outRow.locationName || outRow.fromLocationName,
  );
  const toLocationId = text(
    row.toLocationId || inRow.locationId || inRow.toLocationId,
  );
  const toLocationName = text(
    row.toLocationName || inRow.locationName || inRow.toLocationName,
  );
  const transferType = normalizeTransferType(
    row.transferType || summarizeTextValues(pair.rows, "transferType"),
  );
  const fromSiteId = text(
    row.fromSiteId || outRow.fromSiteId || inRow.fromSiteId,
  );
  const fromSiteName = text(
    row.fromSiteName || outRow.fromSiteName || inRow.fromSiteName,
  );
  const toSiteId = text(row.toSiteId || inRow.toSiteId || outRow.toSiteId);
  const toSiteName = text(
    row.toSiteName || inRow.toSiteName || outRow.toSiteName,
  );
  const status = text(row.status) || summarizeTextValues(pair.rows, "status");
  const createdBy =
    text(row.createdBy) || summarizeTextValues(pair.rows, "createdBy");
  const committedBy =
    text(row.committedBy) || summarizeTextValues(pair.rows, "committedBy");
  const qtyTransferred = row.qtyTransferred || resolveTransferredQty(row);
  return {
    ...row,
    transferType,
    transferTypeLabel: transferType === "external" ? "External" : "Internal",
    fromSiteId,
    fromSiteName,
    fromLocationId,
    fromLocationName,
    toSiteId,
    toSiteName,
    toLocationId,
    toLocationName,
    toLocationDisplay: formatDestinationDisplay(
      transferType,
      toSiteName,
      toLocationName,
    ),
    shippedQty:
      row.shippedQty || sumBy(pair.outRows, "qtyTransferred") || qtyTransferred,
    receivedQty: row.receivedQty || sumBy(pair.inRows, "qtyTransferred"),
    returnedQty: row.returnedQty || 0,
    status,
    createdBy,
    committedBy,
    qtyTransferred,
    transferValue: calculateStockValue(qtyTransferred, row.unitCostExVat),
    __matchedTransferIn: pair.inRows.length > 0,
    __matchedTransferOut: pair.outRows.length > 0,
    __pairInQty: sumBy(pair.inRows, (item) => item.qtyTransferred),
    __pairOutQty: sumBy(pair.outRows, (item) => item.qtyTransferred),
    __pairInValue: sumBy(pair.inRows, (item) =>
      absoluteValue(item.movementValue),
    ),
    __pairOutValue: sumBy(pair.outRows, (item) =>
      absoluteValue(item.movementValue),
    ),
    __pairRowCount: pair.rows.length,
  };
}

function buildSummaryRows(rows = []) {
  return Array.from(groupBy(rows, transferEventKey).entries()).map(
    ([key, groupRows]) => {
      const itemRows = buildByItemRows(groupRows);
      const first = groupRows[0] || {};
      return {
        id: `stock-transfer-summary:${key}`,
        transferDate: earliestText(groupRows, "date"),
        date: earliestText(groupRows, "date"),
        time: earliestText(groupRows, "time"),
        transferNumber:
          first.transactionReference || first.transferNumber || first.sourceId,
        transactionReference:
          first.transactionReference || first.transferNumber,
        transferType: first.transferType,
        transferTypeLabel: first.transferTypeLabel,
        fromSiteId: first.fromSiteId,
        fromSiteName: first.fromSiteName,
        fromLocationId: first.fromLocationId,
        fromLocationName: first.fromLocationName,
        toSiteId: first.toSiteId,
        toSiteName: first.toSiteName,
        toLocationId: first.toLocationId,
        toLocationName: first.toLocationName,
        toLocationDisplay: first.toLocationDisplay,
        requestedAt: earliestText(groupRows, "requestedAt"),
        acceptedAt: earliestText(groupRows, "acceptedAt"),
        shippedQty: sumDistinctLineQuantity(
          itemRows,
          "shippedQty",
          "qtyTransferred",
        ),
        receivedQty: sumDistinctLineQuantity(itemRows, "receivedQty"),
        returnedQty: sumDistinctLineQuantity(itemRows, "returnedQty"),
        status: summarizeTextValues(groupRows, "status"),
        items: new Set(
          itemRows.map((row) => row.itemId || row.itemName).filter(Boolean),
        ).size,
        totalQty: sumBy(itemRows, "qtyTransferred"),
        netQty: sumBy(itemRows, "qtyTransferred"),
        totalTransferValue: sumBy(itemRows, "transferValue"),
        qtyTransferred: sumBy(itemRows, "qtyTransferred"),
        unitCostExVat:
          itemRows.length === 1 ? safeNumber(itemRows[0].unitCostExVat) : "",
        transferValue: sumBy(itemRows, "transferValue"),
        movementValue: sumBy(itemRows, "transferValue"),
        locationName: "",
        direction: "",
        itemName: "",
        category: "",
        qtyIn: "",
        qtyOut: "",
        baseUom: "",
        notes: "",
        createdBy: summarizeTextValues(groupRows, "createdBy"),
        committedBy: summarizeTextValues(groupRows, "committedBy"),
        sourceId: first.sourceId,
        documentNumber: first.documentNumber,
        reportSummaryRow: true,
      };
    },
  );
}

function buildByItemRows(rows = []) {
  return Array.from(groupBy(rows, transferItemKey).entries()).map(
    ([key, groupRows]) => {
      const first = groupRows[0] || {};
      const outRows = groupRows.filter(
        (row) => row.direction === "Transfer Out",
      );
      const inRows = groupRows.filter((row) => row.direction === "Transfer In");
      const qtyTransferred = outRows.length
        ? sumBy(outRows, "qtyTransferred")
        : sumBy(inRows, "qtyTransferred");
      const unitCostExVat = firstNonZero(groupRows, "unitCostExVat");
      return {
        id: `stock-transfer-item:${key}`,
        transferDate: earliestText(groupRows, "date"),
        date: earliestText(groupRows, "date"),
        time: "",
        transferNumber:
          first.transactionReference || first.transferNumber || first.sourceId,
        transactionReference:
          first.transactionReference || first.transferNumber,
        itemId: first.itemId,
        itemName: first.itemName,
        category: first.category || "General",
        transferType: first.transferType,
        transferTypeLabel: first.transferTypeLabel,
        fromSiteId: first.fromSiteId,
        fromSiteName: first.fromSiteName,
        fromLocationId: first.fromLocationId,
        fromLocationName: first.fromLocationName,
        toSiteId: first.toSiteId,
        toSiteName: first.toSiteName,
        toLocationId: first.toLocationId,
        toLocationName: first.toLocationName,
        toLocationDisplay: first.toLocationDisplay,
        requestedAt: earliestText(groupRows, "requestedAt"),
        acceptedAt: earliestText(groupRows, "acceptedAt"),
        shippedQty: firstNonZero(groupRows, "shippedQty") || qtyTransferred,
        receivedQty: firstNonZero(groupRows, "receivedQty"),
        returnedQty: firstNonZero(groupRows, "returnedQty"),
        qtyTransferred,
        qtyIn: "",
        qtyOut: "",
        netQty: qtyTransferred,
        locationName: "",
        direction: "",
        baseUom: first.baseUom || first.unit,
        unitCostExVat,
        transferValue: calculateStockValue(qtyTransferred, unitCostExVat),
        movementValue: calculateStockValue(qtyTransferred, unitCostExVat),
        notes: "",
        status: summarizeTextValues(groupRows, "status"),
        sourceId: first.sourceId,
        documentNumber: first.documentNumber,
        createdBy: summarizeTextValues(groupRows, "createdBy"),
        committedBy: summarizeTextValues(groupRows, "committedBy"),
      };
    },
  );
}

function buildByLocationRows(rows = []) {
  return Array.from(
    groupBy(
      rows,
      (row) => row.locationId || row.locationName || "Unassigned",
    ).entries(),
  ).map(([key, groupRows]) => {
    const first = groupRows[0] || {};
    const inRows = groupRows.filter((row) => row.direction === "Transfer In");
    const outRows = groupRows.filter((row) => row.direction === "Transfer Out");
    const transfersInQty = sumBy(inRows, "qtyTransferred");
    const transfersOutQty = sumBy(outRows, "qtyTransferred");
    const transfersInValue = sumBy(inRows, (row) =>
      absoluteValue(row.movementValue),
    );
    const transfersOutValue = sumBy(outRows, (row) =>
      absoluteValue(row.movementValue),
    );
    const eventKeys = new Set(groupRows.map(transferEventKey).filter(Boolean));
    return {
      id: `stock-transfer-location:${key}`,
      locationId: first.locationId,
      locationName: first.locationName || "Unassigned",
      date: "",
      time: "",
      transferNumber: "",
      fromLocationName: "",
      toLocationName: "",
      direction: "",
      itemName: "",
      category: "",
      qtyIn: transfersInQty,
      qtyOut: transfersOutQty,
      netQty: transfersInQty - transfersOutQty,
      baseUom: "",
      unitCostExVat: "",
      transferValue: transfersInValue - transfersOutValue,
      movementValue: transfersInValue - transfersOutValue,
      status: "",
      createdBy: "",
      committedBy: "",
      notes: "",
      sourceId: "",
      transfersInQty,
      transfersInValue,
      transfersOutQty,
      transfersOutValue,
      netTransferQty: transfersInQty - transfersOutQty,
      netTransferValue: transfersInValue - transfersOutValue,
      transferEvents: eventKeys.size,
    };
  });
}

function toMovementLedgerRow(row = {}) {
  return {
    ...row,
    movementType: row.direction,
    source: row.direction,
    documentNumber: row.transferNumber || row.documentNumber,
    transferValue: row.transferValue,
  };
}

function getTotalsForView(view = "", rows = []) {
  if (view === "summary") {
    return {
      items: sumBy(rows, "items"),
      totalQty: sumBy(rows, "totalQty"),
      netQty: sumBy(rows, "totalQty"),
      totalTransferValue: sumBy(rows, "totalTransferValue"),
      transferValue: sumBy(rows, "totalTransferValue"),
      movementValue: sumBy(rows, "totalTransferValue"),
    };
  }
  if (view === "by_item") {
    return {
      qtyTransferred: sumBy(rows, "qtyTransferred"),
      netQty: sumBy(rows, "qtyTransferred"),
      transferValue: sumBy(rows, "transferValue"),
      movementValue: sumBy(rows, "transferValue"),
    };
  }
  if (view === "by_location") {
    return {
      transfersInValue: sumBy(rows, "transfersInValue"),
      transfersOutValue: sumBy(rows, "transfersOutValue"),
      netTransferValue: sumBy(rows, "netTransferValue"),
      qtyIn: sumBy(rows, "transfersInQty"),
      qtyOut: sumBy(rows, "transfersOutQty"),
      netQty: sumBy(rows, "netTransferQty"),
      transferValue: sumBy(rows, "netTransferValue"),
      movementValue: sumBy(rows, "netTransferValue"),
    };
  }
  if (view === "line_detail" || view === "movement_ledger") {
    return {
      qtyIn: sumBy(rows, "qtyIn"),
      qtyOut: sumBy(rows, "qtyOut"),
      netQty: sumBy(rows, "netQty"),
      movementValue: sumBy(rows, "movementValue"),
      transferValue: sumBy(rows, (row) => absoluteValue(row.movementValue)),
    };
  }
  return {};
}

export function validateTransferRows(model = {}) {
  const movementRows = toArray(model?.transferRows);
  const transactionRows = toArray(model?.transactionRows);
  const rows = transactionRows.length ? transactionRows : movementRows;
  const pairRows = toArray(model?.pairRows).length
    ? toArray(model.pairRows)
    : movementRows;
  if (!rows.length && !movementRows.length) return [];

  return [
    ...toArray(model?.transactionWarnings),
    countWarning(
      rows,
      "stock-transfer-missing-source-id",
      "critical",
      "transfer row(s) have no source ID.",
      (row) => !text(row.sourceId),
    ),
    countWarning(
      rows,
      "stock-transfer-missing-item",
      "critical",
      "transfer row(s) have no item.",
      (row) => !text(row.itemId || row.itemName),
    ),
    countWarning(
      rows,
      "stock-transfer-missing-source-location",
      "critical",
      "transfer row(s) have no source location.",
      (row) => !text(row.fromLocationId || row.fromLocationName),
    ),
    ...missingDestinationWarnings(rows),
    countWarning(
      rows,
      "stock-transfer-missing-clean-location-name",
      "critical",
      "transfer row(s) have no clean location name.",
      (row) => !hasCleanLocationName(row.locationName, row.locationId),
    ),
    countWarning(
      rows,
      "stock-transfer-missing-quantity",
      "critical",
      "transfer row(s) have missing quantity.",
      (row) => !row.__hasQuantity,
    ),
    countWarning(
      rows,
      "stock-transfer-missing-unit-cost",
      "critical",
      "transfer row(s) have missing unit cost.",
      (row) => !row.__hasUnitCost,
    ),
    countWarning(
      rows,
      "stock-transfer-missing-movement-value",
      "critical",
      "transfer row(s) have missing movement value and it cannot be calculated.",
      (row) =>
        !row.__hasMovementValue && !(row.__hasQuantity && row.__hasUnitCost),
    ),
    ...validateTransferPairs(pairRows),
    ...validateDuplicateRows(pairRows),
    ...reconcileStockTransfersToDetailedActivity({
      transferRows: movementRows,
      detailedRows: model.ledgerRows,
    }),
  ].filter(Boolean);
}

function validateTransferPairs(pairRows = []) {
  const warnings = [];
  Array.from(
    groupBy(
      pairRows,
      (row) => row.__pairKey || getTransferPairKey(row),
    ).entries(),
  ).forEach(([key, groupRows]) => {
    const rowsWithSourceId = groupRows.filter((row) => text(row.sourceId));
    if (!rowsWithSourceId.length) return;
    const inRows = groupRows.filter((row) => row.direction === "Transfer In");
    const outRows = groupRows.filter((row) => row.direction === "Transfer Out");
    const first = groupRows[0] || {};
    const label = first.transferNumber || first.sourceId || key;
    const isExternal = groupRows.some(
      (row) =>
        normalizeTransferType(row.transferType || row.transferScope) ===
        "external",
    );
    if (!isExternal && outRows.length && !inRows.length) {
      warnings.push({
        code: "stock-transfer-out-without-in",
        level: "critical",
        message: `Transfer Out exists without matching Transfer In for ${label} / ${first.itemName || "unknown item"}.`,
      });
    }
    if (!isExternal && inRows.length && !outRows.length) {
      warnings.push({
        code: "stock-transfer-in-without-out",
        level: "critical",
        message: `Transfer In exists without matching Transfer Out for ${label} / ${first.itemName || "unknown item"}.`,
      });
    }
    if (inRows.length && outRows.length) {
      const inQty = sumBy(inRows, "qtyTransferred");
      const outQty = sumBy(outRows, "qtyTransferred");
      const inValue = sumBy(inRows, (row) => absoluteValue(row.movementValue));
      const outValue = sumBy(outRows, (row) =>
        absoluteValue(row.movementValue),
      );
      if (Math.abs(inQty - outQty) > QTY_TOLERANCE) {
        warnings.push({
          code: "stock-transfer-qty-mismatch",
          level: "critical",
          message: `Transfer In and Transfer Out quantities do not match for ${label} / ${first.itemName || "unknown item"}.`,
        });
      }
      if (Math.abs(inValue - outValue) > VALUE_TOLERANCE) {
        warnings.push({
          code: "stock-transfer-value-mismatch",
          level: "critical",
          message: `Transfer In and Transfer Out values do not match for ${label} / ${first.itemName || "unknown item"}.`,
        });
      }
    }
  });
  return warnings;
}

function validateDuplicateRows(rows = []) {
  return Array.from(groupBy(rows, duplicateTransferKey).entries())
    .filter(([, groupRows]) => groupRows.length > 1)
    .map(([, groupRows]) => {
      const first = groupRows[0] || {};
      return {
        code: "stock-transfer-duplicate-row",
        level: "critical",
        message: `Duplicate transfer movement rows exist for ${first.transferNumber || first.sourceId || "unknown transfer"} / ${first.itemName || "unknown item"} / ${first.locationName || "unknown location"} / ${first.direction || "unknown direction"}.`,
      };
    });
}

function missingDestinationWarnings(rows = []) {
  return toArray(rows)
    .filter((row) => !isTransferReturnOrReversal(row))
    .filter(
      (row) =>
        !text(
          row.toLocationId ||
            row.toLocationName ||
            row.toSiteId ||
            row.toSiteName,
        ),
    )
    .map((row, index) => ({
      code: "stock-transfer-missing-destination-location",
      level: "critical",
      message: `${text(row.itemName) || `Line ${index + 1}`} — Destination location missing`,
      rowId: text(row.id),
      itemId: text(row.itemId),
      itemName: text(row.itemName),
      entityId: text(row.sourceId),
      entityName: text(row.transferNumber || row.sourceId),
      sourceId: text(row.sourceId),
      locationId: text(row.locationId || row.fromLocationId),
      locationName: text(row.locationName || row.fromLocationName),
      isItemSpecific: true,
    }));
}

function isTransferReturnOrReversal(row = {}) {
  const combined = normalize(
    [row.direction, row.source, row.movementType, row.notes, row.status]
      .map(text)
      .join(" "),
  );
  return (
    combined.includes("return") ||
    combined.includes("reversal") ||
    combined.includes("restore")
  );
}

function normalizeTransferType(value = "") {
  const normalized = normalize(value);
  return normalized.includes("external") ||
    normalized.includes("cross workspace")
    ? "external"
    : "internal";
}

function cleanSiteName(value = "", id = "", fallback = "") {
  const name = text(value);
  if (
    !name ||
    (text(id) && name.toLowerCase() === text(id).toLowerCase()) ||
    looksOpaqueIdentifier(name)
  )
    return fallback;
  return name;
}

function looksOpaqueIdentifier(value = "") {
  const candidate = text(value);
  return (
    /^[a-f0-9]{16,}$/i.test(candidate) ||
    /^[a-z]{1,8}[-_][a-z0-9_-]{14,}$/i.test(candidate)
  );
}

function formatDestinationDisplay(
  transferType = "",
  siteName = "",
  locationName = "",
) {
  const site = text(siteName);
  const location = text(locationName);
  if (normalizeTransferType(transferType) !== "external") return location;
  if (site && location) return `${site} · ${location}`;
  return location || site;
}

function sumDistinctLineQuantity(rows = [], key = "", fallbackKey = "") {
  return sumBy(rows, (row) => {
    const value = safeNumber(row[key]);
    return value || (fallbackKey ? safeNumber(row[fallbackKey]) : 0);
  });
}

function countWarning(
  rows = [],
  code = "",
  level = "critical",
  message = "",
  predicate = () => false,
) {
  return buildRowWarnings(rows, code, level, message, predicate);
}

function transferValueTooltip(row = {}) {
  const qty = safeNumber(row.qtyTransferred ?? row.totalQty);
  const unitCost = safeNumber(row.unitCostExVat);
  const value = safeNumber(
    row.transferValue ??
      row.totalTransferValue ??
      calculateStockValue(qty, unitCost),
  );
  const example = unitCost
    ? `${formatMoney(value)} = ${formatNumber(qty)} x ${formatMoney(unitCost)}`
    : "";
  return buildRowFormulaTooltip("transferValue", example);
}

function netTransferQtyTooltip(row = {}) {
  const example = `${formatNumber(row.netTransferQty)} = ${formatNumber(row.transfersInQty)} - ${formatNumber(row.transfersOutQty)}`;
  return buildRowFormulaTooltip("netTransferQty", example);
}

function netTransferValueTooltip(row = {}) {
  const example = `${formatMoney(row.netTransferValue)} = ${formatMoney(row.transfersInValue)} - ${formatMoney(row.transfersOutValue)}`;
  return buildRowFormulaTooltip("netTransferValue", example);
}

function movementValueTooltip(row = {}) {
  const netQty = safeNumber(row.netQty);
  const unitCost = safeNumber(row.unitCostExVat);
  const value = safeNumber(
    row.movementValue ?? calculateStockValue(netQty, unitCost),
  );
  const example = unitCost
    ? `${formatMoney(value)} = ${formatNumber(netQty)} x ${formatMoney(unitCost)}`
    : "";
  return buildRowFormulaTooltip("movementValue", example);
}

function isTransferLedgerRow(row = {}) {
  const source = normalize(row.source || row.sourceType || row.source_type);
  const movementType = normalize(row.movementType || row.movement_type);
  return (
    source === "transfer in" ||
    source === "transfer out" ||
    movementType === "transfer in" ||
    movementType === "transfer out"
  );
}

function resolveTransferDirection(row = {}) {
  const source = normalize(row.source || row.sourceType || row.source_type);
  const movementType = normalize(row.movementType || row.movement_type);
  if (source === "transfer in" || movementType === "transfer in")
    return "Transfer In";
  if (source === "transfer out" || movementType === "transfer out")
    return "Transfer Out";
  return safeNumber(row.qtyIn) >= safeNumber(row.qtyOut)
    ? "Transfer In"
    : "Transfer Out";
}

function resolveTransferredQty(row = {}) {
  if (row.direction === "Transfer In" && safeNumber(row.qtyIn) !== 0)
    return absoluteValue(row.qtyIn);
  if (row.direction === "Transfer Out" && safeNumber(row.qtyOut) !== 0)
    return absoluteValue(row.qtyOut);
  return absoluteValue(row.netQty);
}

function resolveStatus(row = {}, raw = {}, metadata = {}) {
  return text(
    row.status ||
      row.transferStatus ||
      row.transfer_status ||
      row.sourceStatus ||
      row.source_status ||
      raw.status ||
      raw.transferStatus ||
      raw.transfer_status ||
      metadata.status ||
      metadata.transferStatus ||
      metadata.transfer_status,
  );
}

function resolveTime(row = {}) {
  const timeZone =
    text(
      row.reportingTimeZone ||
        row.reporting_time_zone ||
        row.timeZone ||
        row.time_zone ||
        row.__apiMeta?.timeZone,
    ) || DEFAULT_REPORT_TIMEZONE;
  return formatReportTime(
    row.time ||
      row.movementTime ||
      row.movement_time ||
      row.timestamp ||
      row.occurredAt ||
      row.occurred_at ||
      row.createdAt ||
      row.created_at,
    timeZone,
    { includeSeconds: true },
  );
}

function transferEventKey(row = {}) {
  return [
    row.sourceId || row.documentNumber || row.transferNumber || row.id,
    row.transferNumber || row.documentNumber || "",
  ]
    .map(text)
    .join("::");
}

function transferItemKey(row = {}) {
  return [transferEventKey(row), row.itemId || row.itemName || "unknown-item"]
    .map(text)
    .join("::");
}

function getTransferPairKey(row = {}) {
  return [
    row.sourceId || row.documentNumber || row.transferNumber || row.id,
    row.itemId || row.itemName || "unknown-item",
  ]
    .map(text)
    .join("::");
}

function duplicateTransferKey(row = {}) {
  return [
    row.sourceId ||
      row.documentNumber ||
      row.transferNumber ||
      "missing-source",
    row.itemId || row.itemName || "missing-item",
    row.locationId || row.locationName || "missing-location",
    row.direction || "missing-direction",
  ]
    .map(text)
    .join("::");
}

function firstNonZero(rows = [], key = "") {
  const found = toArray(rows).find((row) => safeNumber(row[key]) !== 0);
  return found ? safeNumber(found[key]) : safeNumber(toArray(rows)[0]?.[key]);
}

function summarizeTextValues(rows = [], key = "") {
  const values = Array.from(
    new Set(
      toArray(rows)
        .map((row) => text(row[key]))
        .filter(Boolean),
    ),
  );
  if (!values.length) return "";
  if (values.length <= 2) return values.join(", ");
  return `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
}

function earliestText(rows = [], key = "") {
  return (
    toArray(rows)
      .map((row) => text(row[key]))
      .filter(Boolean)
      .sort()[0] || ""
  );
}

function hasCleanLocationName(locationName = "", locationId = "") {
  const name = text(locationName);
  const id = text(locationId);
  if (!name) return false;
  if (id && name.toLowerCase() === id.toLowerCase()) return false;
  if (/^(loc|location|site|wh|warehouse)[_-]?[a-z0-9]{4,}$/i.test(name))
    return false;
  if (/^[a-f0-9]{8,}(-[a-f0-9]{4,}){2,}$/i.test(name)) return false;
  return true;
}

function normalize(value = "") {
  return text(value).toLowerCase().replace(/[_-]+/g, " ");
}

function hasValue(value) {
  return value !== undefined && value !== null && text(value) !== "";
}

function rememberStockTransferModel(services = {}, model = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastStockTransfersModel = model;
}

function withMeta(row = {}, model = {}) {
  return {
    ...row,
    __meta: {
      transferRows: model.transferRows,
      pairRows: model.pairRows,
      transactionRows: model.transactionRows,
    },
  };
}

export const __stockTransfersReportInternals = {
  buildTransferRows,
  buildTransferModel,
  validateTransferRows,
};

export default stockTransfersReport;
