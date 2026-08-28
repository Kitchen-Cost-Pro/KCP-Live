import {
  calculateNetMovement,
  calculateStockValue,
  calculateVarianceQty,
  calculateVarianceValue,
  safeNumber,
} from "./calculations.js";
import {
  resolveClearLocationName,
  resolveStockItem,
  resolveUnitCost,
  resolveUnitCostOrNull,
} from "./reportDataMapper.js";
import { sortByDateDesc, text, toArray } from "./grouping.js";
import {
  DEFAULT_REPORT_TIMEZONE,
  formatReportTime,
  resolveReportTimestamp,
  zonedDateTimeStrings,
} from "./timezone.js";

const SOURCE_TYPES = {
  GRV: "grv",
  CREDIT_NOTE: "creditNote",
  PURCHASE_ORDER_RECEIVE: "purchaseOrderReceive",
  MANUAL_ADJUSTMENT: "adjustment",
  WASTAGE_ADJUSTMENT: "wastage",
  MANUFACTURING_IN: "manufacturingIn",
  MANUFACTURING_OUT: "manufacturingOut",
  MANUFACTURING_WASTAGE: "manufacturingWastage",
  STOCK_TAKE_VARIANCE: "stockTake",
  TRANSFER: "transfer",
  SALE_USAGE: "saleUsage",
  MODIFIER_USAGE: "modifierUsage",
};

export function buildStockLedger(dataSet = {}) {
  const rows = [
    ...mapGenericLedgerRows(dataSet),
    ...mapGrvLedgerRows(dataSet),
    ...mapCreditNoteLedgerRows(dataSet),
    ...mapPurchaseOrderReceiveLedgerRows(dataSet),
    ...mapAdjustmentLedgerRows(dataSet),
    ...mapStockTakeLedgerRows(dataSet),
    ...mapTransferLedgerRows(dataSet),
    ...mapManufacturingLedgerRows(dataSet),
    ...mapSaleUsageLedgerRows(dataSet),
    ...mapModifierUsageLedgerRows(dataSet),
  ];

  return finalizeLedgerRows(rows);
}

export function finalizeLedgerRows(rows = []) {
  return sortByDateDesc(
    addRunningBalances(toArray(rows).map(normalizeLedgerRow)),
  );
}

export function normalizeLedgerRow(row = {}, index = 0) {
  const qtyIn = safeNumber(row.qtyIn ?? row.qty_in);
  const qtyOut = safeNumber(row.qtyOut ?? row.qty_out);
  const hasNetQty = hasValue(row.netQty ?? row.net_qty);
  const netQty = hasNetQty
    ? safeNumber(row.netQty ?? row.net_qty)
    : calculateNetMovement(qtyIn, qtyOut);
  const unitCost = safeNumber(
    row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost,
  );
  const hasMovementValue = hasValue(
    row.movementValue ??
      row.movement_value ??
      row.valueDelta ??
      row.value_delta ??
      row.netValue,
  );
  const movementValue = hasMovementValue
    ? safeNumber(
        row.movementValue ??
          row.movement_value ??
          row.valueDelta ??
          row.value_delta ??
          row.netValue,
      )
    : calculateStockValue(netQty, unitCost);
  const reportingTimeZone =
    text(
      row.reportingTimeZone ||
        row.timeZone ||
        row.timezone ||
        row.__apiMeta?.timeZone ||
        row.__apiMeta?.timezone,
    ) || DEFAULT_REPORT_TIMEZONE;
  const eventTimestamp = text(
    row.timestamp ||
      row.occurredAt ||
      row.occurred_at ||
      row.date ||
      row.movementDate ||
      row.movement_date,
  );
  const createdTimestamp = text(
    row.createdAt ||
      row.created_at ||
      row.raw?.movement?.created_at ||
      row.rawSourceRow?.createdAt ||
      row.rawSourceRow?.created_at,
  );
  const timestamp = resolveReportTimestamp(
    eventTimestamp,
    createdTimestamp,
    reportingTimeZone,
  );
  const timestampWasRepaired = Boolean(
    eventTimestamp && timestamp && eventTimestamp !== timestamp,
  );
  const localTimestamp = zonedDateTimeStrings(timestamp, reportingTimeZone);
  const movementDate =
    text(row.movementDate || row.movement_date || row.date).slice(0, 10) ||
    localTimestamp.date;
  const explicitMovementTime = text(
    row.movementTime || row.movement_time || row.time,
  );
  const movementTime = timestampWasRepaired
    ? formatReportTime(timestamp, reportingTimeZone, { includeSeconds: true })
    : formatReportTime(explicitMovementTime || timestamp, reportingTimeZone, {
        includeSeconds: true,
      }) || explicitMovementTime;
  const source = normalizeSourceLabel(
    row.source ||
      row.movementSource ||
      row.sourceType ||
      row.source_type ||
      row.documentType ||
      row.document_type,
  );
  const sourceId = text(
    row.sourceId ||
      row.source_id ||
      row.documentId ||
      row.document_id ||
      row.id,
  );
  const documentNumber = text(
    row.documentNumber ||
      row.documentNo ||
      row.document_number ||
      row.invoice ||
      row.invoiceNumber ||
      row.reference ||
      row.number,
  );
  const transactionReference = text(
    row.transactionReference ||
      row.transaction_reference ||
      row.raw?.transactionReference ||
      row.rawSourceRow?.transactionReference ||
      documentNumber,
  );
  const baseUom = text(row.baseUom || row.base_uom || row.unit || row.uom);
  const createdBy = text(
    row.createdByName ||
      row.created_by_name ||
      row.createdBy ||
      row.created_by ||
      row.user ||
      row.createdByEmail ||
      row.created_by_email ||
      row.submittedByName ||
      row.submittedByUserId,
  );
  const notes = text(row.notes || row.note || row.reason || row.wasteReason);
  const trustedApiRow =
    row.__fromReportingApi === true ||
    text(row.__apiMeta?.dataSource || row.dataSource || row.data_source) ===
      "real";
  const hasRunningQty = hasValue(row.runningQty ?? row.running_qty);
  const hasRunningValue = hasValue(row.runningValue ?? row.running_value);
  const metadata = resolveLedgerMetadata(row);
  const wastageQty = safeNumber(
    row.wastageQty ??
      row.wasteQty ??
      metadata.wastageQty ??
      metadata.wasteQty ??
      metadata.wastage_quantity,
  );
  const accountingOnly =
    row.accountingOnly === true ||
    row.accounting_only === true ||
    metadata.accountingOnly === true ||
    Number(metadata.accountingOnly || 0) === 1;
  const transferRaw = resolveTransferMetadata(row);
  const transferType = text(
    row.transferType ||
      row.transfer_type ||
      transferRaw.transferType ||
      transferRaw.transfer_type,
  );
  const transferScope = text(
    row.transferScope ||
      row.transfer_scope ||
      transferRaw.transferScope ||
      transferRaw.transfer_scope ||
      transferType,
  );
  const fromSiteId = text(
    row.fromSiteId ||
      row.from_site_id ||
      transferRaw.fromSiteId ||
      transferRaw.from_site_id,
  );
  const fromSiteName = text(
    row.fromSiteName ||
      row.from_site_name ||
      transferRaw.fromSiteName ||
      transferRaw.from_site_name,
  );
  const fromLocationId = text(
    row.fromLocationId ||
      row.from_location_id ||
      transferRaw.fromLocationId ||
      transferRaw.from_location_id,
  );
  const fromLocationName = text(
    row.fromLocationName ||
      row.from_location_name ||
      transferRaw.fromLocationName ||
      transferRaw.from_location_name,
  );
  const toSiteId = text(
    row.toSiteId ||
      row.to_site_id ||
      transferRaw.toSiteId ||
      transferRaw.to_site_id,
  );
  const toSiteName = text(
    row.toSiteName ||
      row.to_site_name ||
      transferRaw.toSiteName ||
      transferRaw.to_site_name,
  );
  const toLocationId = text(
    row.toLocationId ||
      row.to_location_id ||
      transferRaw.toLocationId ||
      transferRaw.to_location_id,
  );
  const toLocationName = text(
    row.toLocationName ||
      row.to_location_name ||
      transferRaw.toLocationName ||
      transferRaw.to_location_name,
  );
  const transferStatus = text(
    row.status ||
      row.transferStatus ||
      row.transfer_status ||
      transferRaw.status ||
      transferRaw.transferStatus ||
      transferRaw.transfer_status,
  );
  const requestedAt = text(
    row.requestedAt ||
      row.requested_at ||
      transferRaw.requestedAt ||
      transferRaw.requested_at,
  );
  const acceptedAt = text(
    row.acceptedAt ||
      row.accepted_at ||
      transferRaw.acceptedAt ||
      transferRaw.accepted_at,
  );
  const shippedQty = safeNumber(
    row.shippedQty ??
      row.shipped_qty ??
      transferRaw.shippedQty ??
      transferRaw.shipped_qty,
  );
  const receivedQty = safeNumber(
    row.receivedQty ??
      row.received_qty ??
      transferRaw.receivedQty ??
      transferRaw.received_qty,
  );
  const returnedQty = safeNumber(
    row.returnedQty ??
      row.returned_qty ??
      transferRaw.returnedQty ??
      transferRaw.returned_qty,
  );

  return {
    ...row,
    id: text(row.id) || `${sourceId || source || "ledger"}:${index}`,
    workspaceId: text(row.workspaceId || row.workspace_id),
    date: movementDate,
    movementDate,
    time: movementTime || timestamp,
    movementTime: movementTime || timestamp,
    timestamp,
    reportingTimeZone,
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    itemId: text(
      row.itemId ||
        row.item_id ||
        row.stockItemId ||
        row.stock_item_id ||
        row.productId ||
        row.ingredientId ||
        row.ingId,
    ),
    itemName: text(
      row.itemName ||
        row.item_name ||
        row.stockItemName ||
        row.stock_item_name ||
        row.productName ||
        row.ingredientName ||
        row.name,
    ),
    categoryId: text(row.categoryId || row.category_id),
    categoryName:
      text(
        row.categoryName ||
          row.category_name ||
          row.category ||
          row.itemCategory ||
          row.stockCategory,
      ) || "General",
    category:
      text(
        row.categoryName ||
          row.category_name ||
          row.category ||
          row.itemCategory ||
          row.stockCategory,
      ) || "General",
    movementType: text(row.movementType || row.movement_type || source),
    source,
    sourceType: sourceToType(source),
    sourceId,
    transactionReference,
    documentNumber,
    qtyIn,
    qtyOut,
    netQty,
    baseUom,
    unit: baseUom,
    unitCost,
    unitCostExVat: unitCost,
    movementValue,
    valueIn: qtyIn > 0 ? calculateStockValue(qtyIn, unitCost) : 0,
    valueOut: qtyOut > 0 ? calculateStockValue(qtyOut, unitCost) : 0,
    netValue: movementValue,
    runningQty:
      trustedApiRow && !hasRunningQty
        ? null
        : hasRunningQty
          ? safeNumber(row.runningQty ?? row.running_qty)
          : 0,
    runningValue:
      trustedApiRow && !hasRunningValue
        ? null
        : hasRunningValue
          ? safeNumber(row.runningValue ?? row.running_value)
          : 0,
    createdBy,
    user: createdBy,
    notes,
    note: notes,
    wastageQty,
    accountingOnly,
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
    rawSourceRow: row.rawSourceRow || row.raw_source_row || row.raw || row,
  };
}

function resolveTransferMetadata(row = {}) {
  const raw = row.rawSourceRow || row.raw_source_row || row.raw || {};
  const transfer =
    raw.transfer || raw.externalTransfer || raw.external_transfer || {};
  const direct =
    transfer.transferMeta ||
    transfer.transfer_meta ||
    transfer.metadata ||
    transfer;
  if (direct && typeof direct === "object" && !Array.isArray(direct))
    return direct;
  return {};
}

function resolveLedgerMetadata(row = {}) {
  const direct =
    row.metadata ||
    row.raw?.metadata ||
    row.raw?.movement?.metadata ||
    row.rawSourceRow?.metadata;
  if (direct && typeof direct === "object" && !Array.isArray(direct))
    return direct;
  const raw =
    row.metadataJson ||
    row.metadata_json ||
    row.raw?.movement?.metadata_json ||
    row.rawSourceRow?.metadata_json;
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function hasValue(value) {
  return value !== undefined && value !== null && text(value) !== "";
}

export function mapGenericLedgerRows(dataSet = {}) {
  return toArray(dataSet.ledgerRows).map((row, index) =>
    normalizeGenericLedgerRow(row, dataSet, index),
  );
}

export function mapGrvLedgerRows(dataSet = {}) {
  return toArray(dataSet.grvs).flatMap((grv) =>
    toArray(grv.items || grv.lines).map((line) => {
      const source = isPurchaseOrderReceipt(grv)
        ? "Purchase Order Receive"
        : "GRV";
      return createLedgerRow({
        raw: line,
        dataSet,
        id: `${source === "Purchase Order Receive" ? "po-receive" : "grv"}:${grv.id}:${line.stockItemId || line.itemId || line.id}`,
        source,
        sourceType:
          source === "Purchase Order Receive"
            ? SOURCE_TYPES.PURCHASE_ORDER_RECEIVE
            : SOURCE_TYPES.GRV,
        sourceId: grv.id,
        documentNumber:
          grv.grvNumber ||
          grv.invoice ||
          grv.reference ||
          grv.poNumber ||
          grv.number,
        date: grv.date || grv.timestamp || grv.createdAt,
        timestamp: grv.timestamp || grv.createdAt || grv.date,
        movementType:
          source === "Purchase Order Receive"
            ? "Purchase Order Receive"
            : "GRV Received",
        itemId:
          line.stockItemId ||
          line.itemId ||
          line.ingredientId ||
          line.ingId ||
          line.id,
        itemName:
          line.stockItemName ||
          line.itemName ||
          line.ingredientName ||
          line.name,
        category: line.category,
        locationId:
          line.locationId ||
          line.targetLocation ||
          grv.locationId ||
          grv.targetLocation,
        locationName:
          line.locationName ||
          line.targetLocationName ||
          grv.locationName ||
          grv.targetLocationName,
        qtyIn: resolveBaseQuantity(
          line,
          line.receivedQty ?? line.qty ?? line.quantity,
        ),
        qtyOut: 0,
        baseUom: line.baseUom || line.unit || line.uom,
        unitCost: resolveUnitCostOrNull(line, dataSet.stockCostLookup),
        createdBy:
          grv.submittedByName ||
          grv.createdByName ||
          grv.user ||
          grv.createdByEmail ||
          grv.createdBy,
        notes: grv.notes || grv.note || grv.sourceLabel,
      });
    }),
  );
}

export function mapCreditNoteLedgerRows(dataSet = {}) {
  return toArray(dataSet.creditNotes).flatMap((note) =>
    toArray(note.items || note.lines).map((line) =>
      createLedgerRow({
        raw: line,
        dataSet,
        id: `credit-note:${note.id}:${line.stockItemId || line.itemId || line.id}`,
        source: "Credit Note",
        sourceType: SOURCE_TYPES.CREDIT_NOTE,
        sourceId: note.id,
        documentNumber:
          note.cnNumber || note.invoice || note.reference || note.number,
        date: note.date || note.timestamp || note.createdAt,
        timestamp: note.timestamp || note.createdAt || note.date,
        movementType: "Credit Note",
        itemId:
          line.stockItemId ||
          line.itemId ||
          line.ingredientId ||
          line.ingId ||
          line.id,
        itemName:
          line.stockItemName ||
          line.itemName ||
          line.ingredientName ||
          line.name,
        category: line.category,
        locationId: line.locationId || note.locationId,
        locationName: line.locationName || note.locationName,
        qtyIn: 0,
        qtyOut: resolveBaseQuantity(
          line,
          line.baseQuantity ??
            line.returnedQty ??
            line.packQty ??
            line.qty ??
            line.quantity,
        ),
        baseUom: line.baseUom || line.unit || line.uom,
        unitCost: resolveUnitCostOrNull(line, dataSet.stockCostLookup),
        createdBy:
          note.submittedByName ||
          note.createdByName ||
          note.user ||
          note.createdByEmail ||
          note.createdBy,
        notes: note.notes || note.note || note.reason,
      }),
    ),
  );
}

export function mapPurchaseOrderReceiveLedgerRows(dataSet = {}) {
  const rows = toArray(dataSet.purchaseOrderReceives).flatMap((receipt) =>
    toArray(receipt.items || receipt.lines).map((line) =>
      createLedgerRow({
        raw: line,
        dataSet,
        id: `po-receive:${receipt.id}:${line.stockItemId || line.itemId || line.id}`,
        source: "Purchase Order Receive",
        sourceType: SOURCE_TYPES.PURCHASE_ORDER_RECEIVE,
        sourceId: receipt.id,
        documentNumber:
          receipt.poNumber ||
          receipt.grvNumber ||
          receipt.invoice ||
          receipt.reference ||
          receipt.number,
        date:
          receipt.date ||
          receipt.receivedAt ||
          receipt.timestamp ||
          receipt.createdAt,
        timestamp:
          receipt.timestamp ||
          receipt.receivedAt ||
          receipt.createdAt ||
          receipt.date,
        movementType: "Purchase Order Receive",
        itemId:
          line.stockItemId ||
          line.itemId ||
          line.ingredientId ||
          line.ingId ||
          line.id,
        itemName:
          line.stockItemName ||
          line.itemName ||
          line.ingredientName ||
          line.name,
        category: line.category,
        locationId:
          line.locationId ||
          line.targetLocation ||
          receipt.locationId ||
          receipt.targetLocation,
        locationName:
          line.locationName ||
          line.targetLocationName ||
          receipt.locationName ||
          receipt.targetLocationName,
        qtyIn: resolveBaseQuantity(
          line,
          line.receivedQty ?? line.qty ?? line.quantity,
        ),
        qtyOut: 0,
        baseUom: line.baseUom || line.unit || line.uom,
        unitCost: resolveUnitCostOrNull(line, dataSet.stockCostLookup),
        createdBy:
          receipt.receivedByName ||
          receipt.submittedByName ||
          receipt.createdByName ||
          receipt.user ||
          receipt.createdByEmail ||
          receipt.createdBy,
        notes: receipt.notes || receipt.note,
      }),
    ),
  );

  const grvPoIds = new Set(
    toArray(dataSet.grvs)
      .map((grv) => text(grv.sourcePoId || grv.poId))
      .filter(Boolean),
  );
  // A PO already covered by an explicit `purchaseOrderReceives` row (built into `rows` above)
  // must not ALSO be re-derived from the order's own `receivedQty` below — that double-counted
  // the same physical receipt for any order received via the PO-receive flow rather than a GRV,
  // inflating stock-in and closing value in every report that consumes this ledger.
  const receivedPoIds = new Set(
    toArray(dataSet.purchaseOrderReceives)
      .map((receipt) => text(receipt.poId || receipt.sourcePoId || receipt.purchaseOrderId || receipt.id))
      .filter(Boolean),
  );
  const derivedFromOrders = toArray(dataSet.purchaseOrders).flatMap((order) => {
    const orderId = text(order.id);
    if (orderId && (grvPoIds.has(orderId) || receivedPoIds.has(orderId))) return [];
    const receivedAt = text(
      order.receivedAt ||
        order.partiallyReceivedAt ||
        order.updatedAt ||
        order.createdAt ||
        order.date,
    );
    return toArray(order.items || order.lines).flatMap((line) => {
      const receivedQty = safeNumber(line.receivedQty ?? line.received);
      if (receivedQty <= 0) return [];
      return createLedgerRow({
        raw: line,
        dataSet,
        id: `po-line-receive:${order.id}:${line.id || line.stockItemId || line.itemId}`,
        source: "Purchase Order Receive",
        sourceType: SOURCE_TYPES.PURCHASE_ORDER_RECEIVE,
        sourceId: order.id,
        documentNumber: order.poNumber || order.reference || order.number,
        date: receivedAt,
        timestamp: receivedAt,
        movementType: "Purchase Order Receive",
        itemId:
          line.stockItemId ||
          line.itemId ||
          line.ingredientId ||
          line.ingId ||
          line.id,
        itemName:
          line.stockItemName ||
          line.itemName ||
          line.ingredientName ||
          line.name,
        category: line.category,
        locationId:
          line.locationId ||
          line.targetLocation ||
          order.locationId ||
          order.targetLocation,
        locationName:
          line.locationName ||
          line.targetLocationName ||
          order.locationName ||
          order.targetLocationName,
        qtyIn: resolveBaseQuantity(line, receivedQty),
        qtyOut: 0,
        baseUom: line.baseUom || line.unit || line.uom,
        unitCost: resolveUnitCostOrNull(line, dataSet.stockCostLookup),
        createdBy:
          order.receivedByName ||
          order.createdByName ||
          order.user ||
          order.createdByEmail ||
          order.createdBy,
        notes: order.notes || order.note,
      });
    });
  });

  return [...rows, ...derivedFromOrders];
}

export function mapAdjustmentLedgerRows(dataSet = {}) {
  return toArray(dataSet.adjustments).map((log) => {
    const mode = text(
      log.mode || log.adjustmentType || log.adjustment_type || "remove",
    ).toLowerCase();
    const signedQty = safeNumber(log.impactQty ?? log.quantity ?? log.qty);
    const qty = Math.abs(signedQty);
    const isIncrease =
      mode === "add" ||
      mode === "increase" ||
      (!["remove", "decrease", "wastage", "override"].includes(mode) &&
        signedQty > 0);
    const isWastage =
      mode === "wastage" ||
      Boolean(log.wasteReason || log.waste_reason) ||
      text(log.note).toLowerCase().includes("waste");
    return createLedgerRow({
      raw: log,
      dataSet,
      id: `adjustment:${log.id || `${log.locationId || log.location_id}:${log.itemId || log.stockItemId}`}`,
      source: isWastage ? "Wastage Adjustment" : "Manual Adjustment",
      sourceType: isWastage
        ? SOURCE_TYPES.WASTAGE_ADJUSTMENT
        : SOURCE_TYPES.MANUAL_ADJUSTMENT,
      sourceId: log.id,
      documentNumber: log.reference || log.number || log.id,
      date: log.date || log.timestamp || log.createdAt,
      timestamp: log.timestamp || log.createdAt || log.date,
      movementType: isWastage
        ? "Wastage Adjustment"
        : isIncrease
          ? "Manual Adjustment In"
          : "Manual Adjustment Out",
      itemId: log.itemId || log.stockItemId || log.productId,
      itemName: log.itemName || log.stockItemName || log.productName,
      category: log.category,
      locationId: log.locationId || log.location_id,
      locationName: log.locationName || log.location_name,
      qtyIn: isIncrease ? qty : 0,
      qtyOut: isIncrease ? 0 : qty,
      baseUom: log.baseUom || log.unit || log.uom,
      unitCost: resolveUnitCostOrNull(log, dataSet.stockCostLookup),
      createdBy:
        log.createdByName || log.user || log.createdByEmail || log.createdBy,
      notes: log.note || log.wasteReason || log.waste_reason,
    });
  });
}

export function mapStockTakeLedgerRows(dataSet = {}) {
  return toArray(dataSet.stockTakes).flatMap((take) =>
    toArray(take.items).map((line) => {
      const expectedQty = safeNumber(
        line.systemStock ?? line.expectedQty ?? line.expected_qty,
      );
      const countedQty = safeNumber(
        line.shelfCount ?? line.countedQty ?? line.counted_qty,
      );
      const varianceQty = safeNumber(
        line.variance ??
          line.varianceQty ??
          calculateVarianceQty(countedQty, expectedQty),
      );
      const qtyIn = varianceQty > 0 ? Math.abs(varianceQty) : 0;
      const qtyOut = varianceQty < 0 ? Math.abs(varianceQty) : 0;
      return createLedgerRow({
        raw: line,
        dataSet,
        id: `stock-take:${take.id}:${line.stockItemId || line.itemId}`,
        source: "Stock Take Variance",
        sourceType: SOURCE_TYPES.STOCK_TAKE_VARIANCE,
        sourceId: take.id,
        documentNumber:
          take.stockTakeNumber || take.reference || take.number || take.id,
        date: take.date || take.timestamp || take.createdAt,
        timestamp: take.timestamp || take.createdAt || take.date,
        movementType: "Stock Take Variance",
        itemId: line.stockItemId || line.itemId,
        itemName: line.stockItemName || line.name || line.itemName,
        category: line.category,
        locationId: take.locationId || line.locationId,
        locationName: take.locationName || line.locationName,
        qtyIn,
        qtyOut,
        baseUom: line.baseUom || line.unit || line.uom,
        unitCost: resolveUnitCostOrNull(
          { ...line, id: line.stockItemId || line.itemId },
          dataSet.stockCostLookup,
        ),
        createdBy:
          take.createdByName ||
          take.user ||
          take.createdByEmail ||
          take.createdBy,
        notes: take.note || line.note,
        extra: {
          expectedQty,
          countedQty,
          varianceQty,
          varianceValue: calculateVarianceValue(
            varianceQty,
            resolveUnitCost(
              { ...line, id: line.stockItemId || line.itemId },
              dataSet.stockCostLookup,
            ),
          ),
        },
      });
    }),
  );
}

export function mapTransferLedgerRows(dataSet = {}) {
  return toArray(dataSet.transfers).flatMap((transfer) =>
    toArray(transfer.items).flatMap((line) => {
      const qty = resolveBaseQuantity(
        line,
        line.qty ?? line.quantity ?? line.transferQty,
      );
      const fromLocationId = text(
        transfer.from || transfer.fromLocationId || line.fromLocationId,
      );
      const toLocationId = text(
        transfer.to || transfer.toLocationId || line.toLocationId,
      );
      const itemId = text(line.stockItemId || line.id || line.itemId);
      const itemName = text(line.stockItemName || line.name || line.itemName);
      const base = {
        raw: line,
        dataSet,
        sourceType: SOURCE_TYPES.TRANSFER,
        sourceId: transfer.id,
        documentNumber:
          transfer.transferNumber ||
          transfer.reference ||
          transfer.number ||
          transfer.id,
        date: transfer.date || transfer.timestamp || transfer.createdAt,
        timestamp: transfer.timestamp || transfer.createdAt || transfer.date,
        itemId,
        itemName,
        category: line.category,
        baseUom: line.baseUom || line.unit || line.uom,
        unitCost: resolveUnitCostOrNull(
          { ...line, id: itemId },
          dataSet.stockCostLookup,
        ),
        createdBy:
          transfer.createdByName ||
          transfer.user ||
          transfer.createdByEmail ||
          transfer.createdBy,
        notes: transfer.note || transfer.notes,
        transferType:
          text(transfer.transferType || transfer.type) ||
          (text(transfer.toWorkspaceId || transfer.toSiteId)
            ? "external"
            : "internal"),
        transferScope:
          text(transfer.transferScope || transfer.scope) ||
          (text(transfer.toWorkspaceId || transfer.toSiteId)
            ? "external"
            : "internal"),
        fromSiteId: text(
          transfer.fromSiteId ||
            transfer.fromWorkspaceId ||
            transfer.workspaceId,
        ),
        fromSiteName: text(
          transfer.fromSiteName ||
            transfer.fromWorkspaceName ||
            transfer.workspaceName,
        ),
        toSiteId: text(
          transfer.toSiteId || transfer.toWorkspaceId || transfer.workspaceId,
        ),
        toSiteName: text(
          transfer.toSiteName ||
            transfer.toWorkspaceName ||
            transfer.workspaceName,
        ),
        fromLocationId,
        fromLocationName: resolveLedgerLocationName(
          fromLocationId,
          transfer.fromName ||
            transfer.fromLocationName ||
            line.fromLocationName,
          dataSet,
        ),
        toLocationId,
        toLocationName: resolveLedgerLocationName(
          toLocationId,
          transfer.toName || transfer.toLocationName || line.toLocationName,
          dataSet,
        ),
        status: text(transfer.status),
        requestedAt: text(
          transfer.requestedAt ||
            transfer.createdAt ||
            transfer.timestamp ||
            transfer.date,
        ),
        acceptedAt: text(transfer.acceptedAt || transfer.committedAt),
        shippedQty: safeNumber(
          line.shippedQty ??
            line.quantity ??
            line.qty ??
            line.transferQty ??
            qty,
        ),
        receivedQty: safeNumber(
          line.receivedQty ??
            (text(transfer.status).toLowerCase() === "accepted" ? qty : 0),
        ),
        returnedQty: safeNumber(
          line.returnedQty ?? line.rejectedQty ?? line.shortfallQty,
        ),
      };

      return [
        createLedgerRow({
          ...base,
          id: `transfer-out:${transfer.id}:${itemId}:${fromLocationId}`,
          source: "Transfer Out",
          movementType: "Transfer Out",
          locationId: fromLocationId,
          locationName:
            transfer.fromName ||
            transfer.fromLocationName ||
            line.fromLocationName,
          qtyIn: 0,
          qtyOut: qty,
          extra: {
            transferType: base.transferType,
            transferScope: base.transferScope,
            fromSiteId: base.fromSiteId,
            fromSiteName: base.fromSiteName,
            fromLocationId: base.fromLocationId,
            fromLocationName: base.fromLocationName,
            toSiteId: base.toSiteId,
            toSiteName: base.toSiteName,
            toLocationId: base.toLocationId,
            toLocationName: base.toLocationName,
            status: base.status,
            requestedAt: base.requestedAt,
            acceptedAt: base.acceptedAt,
            shippedQty: base.shippedQty,
            receivedQty: base.receivedQty,
            returnedQty: base.returnedQty,
          },
        }),
        createLedgerRow({
          ...base,
          id: `transfer-in:${transfer.id}:${itemId}:${toLocationId}`,
          source: "Transfer In",
          movementType: "Transfer In",
          locationId: toLocationId,
          locationName:
            transfer.toName || transfer.toLocationName || line.toLocationName,
          qtyIn: qty,
          qtyOut: 0,
          extra: {
            transferType: base.transferType,
            transferScope: base.transferScope,
            fromSiteId: base.fromSiteId,
            fromSiteName: base.fromSiteName,
            fromLocationId: base.fromLocationId,
            fromLocationName: base.fromLocationName,
            toSiteId: base.toSiteId,
            toSiteName: base.toSiteName,
            toLocationId: base.toLocationId,
            toLocationName: base.toLocationName,
            status: base.status,
            requestedAt: base.requestedAt,
            acceptedAt: base.acceptedAt,
            shippedQty: base.shippedQty,
            receivedQty: base.receivedQty,
            returnedQty: base.returnedQty,
          },
        }),
      ];
    }),
  );
}

export function mapManufacturingLedgerRows(dataSet = {}) {
  return toArray(dataSet.manufacturingLogs).flatMap((log) => {
    const rows = [];
    const locationId = text(log.locationId || log.targetLocation);
    const locationName = text(log.locationName || log.targetLocationName);
    const producedQty = safeNumber(
      log.producedQty ?? log.actualQty ?? log.quantity ?? log.madeQty,
    );
    const finishedCost = resolveUnitCostOrNull(log, dataSet.stockCostLookup);

    if (producedQty > 0) {
      rows.push(
        createLedgerRow({
          raw: log,
          dataSet,
          id: `manufacturing-in:${log.id}`,
          source: "Manufacturing In",
          sourceType: SOURCE_TYPES.MANUFACTURING_IN,
          sourceId: log.id,
          documentNumber:
            log.productionNumber || log.batchNumber || log.reference || log.id,
          date: log.date || log.timestamp || log.createdAt,
          timestamp: log.timestamp || log.createdAt || log.date,
          movementType: "Manufacturing In",
          itemId: log.itemId || log.manufacturedItemId || log.stockItemId,
          itemName:
            log.itemName || log.manufacturedItemName || log.stockItemName,
          category: log.category || "Manufactured",
          locationId,
          locationName,
          qtyIn: producedQty,
          qtyOut: 0,
          baseUom: log.baseUom || log.unit || log.uom,
          unitCost: finishedCost,
          createdBy:
            log.createdByName ||
            log.user ||
            log.createdByEmail ||
            log.createdBy,
          notes: log.note || log.notes,
        }),
      );
    }

    toArray(log.components || log.ingredients || log.lines).forEach(
      (component) => {
        const componentQty = resolveBaseQuantity(
          component,
          component.qty ?? component.quantity ?? component.usedQty,
        );
        rows.push(
          createLedgerRow({
            raw: component,
            dataSet,
            id: `manufacturing-out:${log.id}:${component.stockItemId || component.itemId || component.id}`,
            source: "Manufacturing Out",
            sourceType: SOURCE_TYPES.MANUFACTURING_OUT,
            sourceId: log.id,
            documentNumber:
              log.productionNumber ||
              log.batchNumber ||
              log.reference ||
              log.id,
            date: log.date || log.timestamp || log.createdAt,
            timestamp: log.timestamp || log.createdAt || log.date,
            movementType: "Manufacturing Out",
            itemId:
              component.stockItemId ||
              component.itemId ||
              component.ingredientId ||
              component.id,
            itemName:
              component.stockItemName ||
              component.itemName ||
              component.ingredientName ||
              component.name,
            category: component.category || "Raw Material",
            locationId,
            locationName,
            qtyIn: 0,
            qtyOut: componentQty,
            baseUom: component.baseUom || component.unit || component.uom,
            unitCost: resolveUnitCostOrNull(
              { ...component, id: component.stockItemId || component.itemId },
              dataSet.stockCostLookup,
            ),
            createdBy:
              log.createdByName ||
              log.user ||
              log.createdByEmail ||
              log.createdBy,
            notes: `Used in ${text(log.itemName || log.manufacturedItemName || log.stockItemName) || "manufacturing"}`,
          }),
        );
      },
    );

    const wastageQty = safeNumber(
      log.wastageQty ?? log.wasteQty ?? log.shortfallQty,
    );
    if (wastageQty > 0) {
      rows.push(
        createLedgerRow({
          raw: log,
          dataSet,
          id: `manufacturing-wastage:${log.id}`,
          source: "Manufacturing Wastage",
          sourceType: SOURCE_TYPES.MANUFACTURING_WASTAGE,
          sourceId: log.id,
          documentNumber:
            log.productionNumber || log.batchNumber || log.reference || log.id,
          date: log.date || log.timestamp || log.createdAt,
          timestamp: log.timestamp || log.createdAt || log.date,
          movementType: "Manufacturing Wastage",
          itemId:
            log.wastageItemId ||
            log.itemId ||
            log.manufacturedItemId ||
            log.stockItemId,
          itemName:
            log.wastageItemName ||
            log.itemName ||
            log.manufacturedItemName ||
            log.stockItemName,
          category: log.category || "Manufactured",
          locationId,
          locationName,
          qtyIn: 0,
          qtyOut: wastageQty,
          baseUom: log.baseUom || log.unit || log.uom,
          unitCost: finishedCost,
          createdBy:
            log.createdByName ||
            log.user ||
            log.createdByEmail ||
            log.createdBy,
          notes: log.wastageReason || log.note || "Manufacturing wastage",
        }),
      );
    }

    return rows;
  });
}

export function mapSaleUsageLedgerRows(dataSet = {}) {
  return toArray(dataSet.saleUsage).map((usage) =>
    createLedgerRow({
      raw: usage,
      dataSet,
      id: `sale-usage:${usage.id || usage.saleId || usage.orderId}:${usage.stockItemId || usage.itemId || usage.productId}`,
      source: "Sale Usage",
      sourceType: SOURCE_TYPES.SALE_USAGE,
      sourceId: usage.id || usage.saleId || usage.orderId || usage.sourceId,
      documentNumber:
        usage.orderNumber ||
        usage.receiptNumber ||
        usage.saleNumber ||
        usage.reference ||
        usage.number,
      date: usage.date || usage.timestamp || usage.createdAt,
      timestamp: usage.timestamp || usage.createdAt || usage.date,
      movementType: "Sale Usage",
      itemId:
        usage.stockItemId ||
        usage.itemId ||
        usage.ingredientId ||
        usage.productId,
      itemName:
        usage.stockItemName ||
        usage.itemName ||
        usage.ingredientName ||
        usage.productName ||
        usage.name,
      category: usage.category,
      locationId: usage.locationId || usage.siteId,
      locationName: usage.locationName || usage.siteName,
      qtyIn: 0,
      qtyOut: resolveBaseQuantity(
        usage,
        usage.qty ?? usage.quantity ?? usage.usedQty,
      ),
      baseUom: usage.baseUom || usage.unit || usage.uom,
      unitCost: resolveUnitCostOrNull(usage, dataSet.stockCostLookup),
      createdBy:
        usage.createdByName ||
        usage.user ||
        usage.createdByEmail ||
        usage.createdBy,
      notes: usage.notes || usage.note || usage.productName,
    }),
  );
}

export function mapModifierUsageLedgerRows(dataSet = {}) {
  return toArray(dataSet.modifierUsage).map((usage) =>
    createLedgerRow({
      raw: usage,
      dataSet,
      id: `modifier-usage:${usage.id || usage.saleId || usage.orderId}:${usage.stockItemId || usage.itemId || usage.modifierId}`,
      source: "Modifier Usage",
      sourceType: SOURCE_TYPES.MODIFIER_USAGE,
      sourceId: usage.id || usage.saleId || usage.orderId || usage.sourceId,
      documentNumber:
        usage.orderNumber ||
        usage.receiptNumber ||
        usage.saleNumber ||
        usage.reference ||
        usage.number,
      date: usage.date || usage.timestamp || usage.createdAt,
      timestamp: usage.timestamp || usage.createdAt || usage.date,
      movementType: "Modifier Usage",
      itemId:
        usage.stockItemId ||
        usage.itemId ||
        usage.ingredientId ||
        usage.modifierId,
      itemName:
        usage.stockItemName ||
        usage.itemName ||
        usage.ingredientName ||
        usage.modifierName ||
        usage.name,
      category: usage.category,
      locationId: usage.locationId || usage.siteId,
      locationName: usage.locationName || usage.siteName,
      qtyIn: 0,
      qtyOut: resolveBaseQuantity(
        usage,
        usage.qty ?? usage.quantity ?? usage.usedQty,
      ),
      baseUom: usage.baseUom || usage.unit || usage.uom,
      unitCost: resolveUnitCostOrNull(usage, dataSet.stockCostLookup),
      createdBy:
        usage.createdByName ||
        usage.user ||
        usage.createdByEmail ||
        usage.createdBy,
      notes: usage.notes || usage.note || usage.modifierName,
    }),
  );
}

function createLedgerRow({ raw = {}, dataSet = {}, extra = {}, ...row }) {
  const stockItem = resolveStockItem(
    {
      id: row.itemId,
      itemId: row.itemId,
      stockItemId: row.itemId,
      name: row.itemName,
      itemName: row.itemName,
      stockItemName: row.itemName,
    },
    dataSet.stockItemLookup,
  );
  const itemName = text(row.itemName) || text(stockItem?.name);
  const category = text(row.category) || text(stockItem?.category) || "General";
  const locationId = text(row.locationId);
  const locationName = resolveLedgerLocationName(
    locationId,
    row.locationName,
    dataSet,
  );
  const baseUom = text(row.baseUom) || text(stockItem?.baseUom) || "ea";
  // A genuine unit cost of 0 on the row is authoritative — only a missing value may fall back to
  // the stock item's cost, so presence is tested explicitly rather than by truthiness. Callers
  // resolve costs with resolveUnitCostOrNull, so a lookup miss arrives here as null (not 0) and
  // still reaches the stock-item fallback.
  const unitCost = hasValue(row.unitCost)
    ? safeNumber(row.unitCost)
    : safeNumber(stockItem?.unitCost);
  const qtyIn = Math.abs(safeNumber(row.qtyIn));
  const qtyOut = Math.abs(safeNumber(row.qtyOut));
  const netQty = calculateNetMovement(qtyIn, qtyOut);
  const movementValue = calculateStockValue(netQty, unitCost);

  return {
    id: text(row.id),
    date: text(row.date || row.timestamp).slice(0, 10),
    time: text(row.timestamp || row.date),
    timestamp: text(row.timestamp || row.date),
    locationId,
    locationName,
    itemId: text(row.itemId),
    itemName,
    category,
    movementType: text(row.movementType),
    source: text(row.source),
    sourceType: text(row.sourceType),
    documentNumber: text(row.documentNumber),
    qtyIn,
    qtyOut,
    netQty,
    baseUom,
    unit: baseUom,
    unitCost,
    unitCostExVat: unitCost,
    movementValue,
    valueIn: qtyIn > 0 ? calculateStockValue(qtyIn, unitCost) : 0,
    valueOut: qtyOut > 0 ? calculateStockValue(qtyOut, unitCost) : 0,
    netValue: movementValue,
    runningQty: 0,
    runningValue: 0,
    createdBy: text(row.createdBy),
    user: text(row.createdBy),
    notes: text(row.notes),
    note: text(row.notes),
    sourceId: text(row.sourceId),
    rawSourceRow: raw,
    ...extra,
  };
}

function normalizeGenericLedgerRow(row = {}, dataSet = {}, index = 0) {
  const normalized = normalizeLedgerRow(
    { ...row, id: row.id || row.ledgerId || `generic-ledger:${index}` },
    index,
  );
  const stockItem = resolveStockItem(normalized, dataSet.stockItemLookup);
  const locationName =
    normalized.locationName ||
    resolveLedgerLocationName(normalized.locationId, "", dataSet);
  // A genuine unit cost of 0 on the source row is authoritative; only a missing value falls
  // through to the cost lookup and then to the stock item. Presence is tested on the source row
  // because normalizeLedgerRow already flattens a missing cost to 0.
  const hasSourceUnitCost = hasValue(
    row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost,
  );
  const unitCost = hasSourceUnitCost
    ? safeNumber(normalized.unitCost)
    : (resolveUnitCostOrNull(
        { itemId: normalized.itemId, itemName: normalized.itemName },
        dataSet.stockCostLookup,
      ) ?? safeNumber(stockItem?.unitCost));
  const movementValue = calculateStockValue(normalized.netQty, unitCost);
  return {
    ...normalized,
    locationName,
    itemName: normalized.itemName || text(stockItem?.name),
    category: normalized.category || text(stockItem?.category) || "General",
    baseUom: normalized.baseUom || text(stockItem?.baseUom),
    unit: normalized.baseUom || text(stockItem?.baseUom),
    unitCost,
    unitCostExVat: unitCost,
    movementValue,
    netValue: movementValue,
    rawMovementValue:
      row.movementValue ?? row.netValue ?? row.stockValue ?? null,
  };
}

function addRunningBalances(rows = []) {
  const balances = new Map();
  const sortedAscending = [...toArray(rows)].sort((left, right) => {
    const byDate = text(left.timestamp || left.date).localeCompare(
      text(right.timestamp || right.date),
    );
    if (byDate) return byDate;
    const byCreated = text(left.createdAt || left.created_at).localeCompare(
      text(right.createdAt || right.created_at),
    );
    if (byCreated) return byCreated;
    const bySource = text(left.source || left.sourceType).localeCompare(
      text(right.source || right.sourceType),
    );
    if (bySource) return bySource;
    return text(left.sourceId || left.id).localeCompare(
      text(right.sourceId || right.id),
    );
  });

  return sortedAscending.map((row) => {
    const trustedApiRow =
      row.__fromReportingApi === true ||
      text(row.__apiMeta?.dataSource || row.dataSource || row.data_source) ===
        "real";
    const hasBackendRunningQty =
      trustedApiRow && hasValue(row.runningQty ?? row.running_qty);
    const hasBackendRunningValue =
      trustedApiRow && hasValue(row.runningValue ?? row.running_value);
    const key = getBalanceKey(row);
    if (trustedApiRow && (!hasBackendRunningQty || !hasBackendRunningValue)) {
      // The row itself keeps the partial (null) backend values, but the running balance for this
      // item/location must still advance — otherwise every later row for the same key would be
      // computed off a stale previous balance and the whole ledger tail would be wrong.
      const previousQty = safeNumber(balances.get(key));
      const carriedQty = hasBackendRunningQty
        ? safeNumber(row.runningQty ?? row.running_qty)
        : previousQty + safeNumber(row.netQty);
      balances.set(key, carriedQty);
      return {
        ...row,
        runningQty: hasBackendRunningQty
          ? safeNumber(row.runningQty ?? row.running_qty)
          : null,
        runningValue: hasBackendRunningValue
          ? safeNumber(row.runningValue ?? row.running_value)
          : null,
      };
    }

    const previousQty = safeNumber(balances.get(key));
    const runningQty = hasBackendRunningQty
      ? safeNumber(row.runningQty ?? row.running_qty)
      : previousQty + safeNumber(row.netQty);
    balances.set(key, runningQty);
    return {
      ...row,
      runningQty,
      runningValue: hasBackendRunningValue
        ? safeNumber(row.runningValue ?? row.running_value)
        : calculateStockValue(runningQty, row.unitCost),
    };
  });
}

function getBalanceKey(row = {}) {
  return [
    text(row.locationId || row.locationName || "unassigned").toLowerCase(),
    text(row.itemId || row.itemName || "unknown-item").toLowerCase(),
  ].join("::");
}

function resolveBaseQuantity(line = {}, quantityValue = 0) {
  if (
    line.baseQuantity !== undefined &&
    line.baseQuantity !== null &&
    text(line.baseQuantity) !== ""
  ) {
    return Math.abs(safeNumber(line.baseQuantity));
  }
  const qty = Math.abs(safeNumber(quantityValue));
  const packSize = safeNumber(line.packSize ?? line.pack_size ?? 1, 1) || 1;
  const isPackQuantity = Boolean(
    line.packSize ||
    line.pack_size ||
    line.selectedUom ||
    line.receivingUom ||
    line.purchaseUom ||
    line.returnUom,
  );
  return isPackQuantity ? qty * packSize : qty;
}

function resolveLedgerLocationName(
  locationId = "",
  fallback = "",
  dataSet = {},
) {
  return (
    text(fallback) ||
    resolveClearLocationName(locationId, dataSet.locationLookup, "")
  );
}

function isPurchaseOrderReceipt(receipt = {}) {
  return (
    Boolean(
      text(
        receipt.sourcePoId ||
          receipt.poId ||
          receipt.purchaseOrderId ||
          receipt.poNumber,
      ),
    ) || text(receipt.type).toUpperCase() === "PO_GRV"
  );
}

function normalizeSourceLabel(value = "") {
  const normalized = text(value).toLowerCase().replace(/[_-]+/g, " ");
  if (normalized.includes("credit")) return "Credit Note";
  if (
    normalized.includes("purchase order") ||
    normalized === "po receive" ||
    normalized === "po receipt"
  )
    return "Purchase Order Receive";
  if (normalized === "grv" || normalized.includes("goods receipt"))
    return "GRV";
  if (normalized.includes("wastage adjustment")) return "Wastage Adjustment";
  if (normalized.includes("manual adjustment") || normalized === "adjustment")
    return "Manual Adjustment";
  if (normalized.includes("manufacturing wastage"))
    return "Manufacturing Wastage";
  if (normalized.includes("manufacturing in")) return "Manufacturing In";
  if (
    normalized.includes("manufacturing out") ||
    normalized.includes("manufacturing usage")
  )
    return "Manufacturing Out";
  if (normalized.includes("stock take")) return "Stock Take Variance";
  if (normalized.includes("transfer in")) return "Transfer In";
  if (normalized.includes("transfer out")) return "Transfer Out";
  if (normalized.includes("sale")) return "Sale Usage";
  if (normalized.includes("modifier")) return "Modifier Usage";
  return text(value) || "Unknown Source";
}

function sourceToType(source = "") {
  const normalized = normalizeSourceLabel(source);
  if (normalized === "Credit Note") return SOURCE_TYPES.CREDIT_NOTE;
  if (normalized === "Purchase Order Receive")
    return SOURCE_TYPES.PURCHASE_ORDER_RECEIVE;
  if (normalized === "GRV") return SOURCE_TYPES.GRV;
  if (normalized === "Wastage Adjustment")
    return SOURCE_TYPES.WASTAGE_ADJUSTMENT;
  if (normalized === "Manual Adjustment") return SOURCE_TYPES.MANUAL_ADJUSTMENT;
  if (normalized === "Manufacturing Wastage")
    return SOURCE_TYPES.MANUFACTURING_WASTAGE;
  if (normalized === "Manufacturing In") return SOURCE_TYPES.MANUFACTURING_IN;
  if (normalized === "Manufacturing Out") return SOURCE_TYPES.MANUFACTURING_OUT;
  if (normalized === "Stock Take Variance")
    return SOURCE_TYPES.STOCK_TAKE_VARIANCE;
  if (normalized === "Transfer In" || normalized === "Transfer Out")
    return SOURCE_TYPES.TRANSFER;
  if (normalized === "Sale Usage") return SOURCE_TYPES.SALE_USAGE;
  if (normalized === "Modifier Usage") return SOURCE_TYPES.MODIFIER_USAGE;
  return text(source).replace(/\s+/g, "") || "unknown";
}
