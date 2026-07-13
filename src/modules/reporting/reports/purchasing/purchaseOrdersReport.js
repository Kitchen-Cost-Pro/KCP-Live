import { roundMoney, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { fetchPurchaseOrderReportRows } from '../../api/reportingApi.js';
import { firstText, latestText, mapColumns, rememberPayload, titleStatus, uniqueCount } from './purchasingReportHelpers.js';

const moneyColumn = (key, label, tooltipKey = '') => ({ key, label, type: 'money', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const qtyColumn = (key, label, tooltipKey = '') => ({ key, label, type: 'number', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const numberColumn = (key, label) => ({ key, label, type: 'number', align: 'right', sortable: true });

const summaryColumns = [
  { key: 'poDate', label: 'PO Date', type: 'date', sortable: true },
  { key: 'poNumber', label: 'PO Number', sortable: true },
  { key: 'supplierName', label: 'Supplier', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'status', label: 'Status', sortable: true },
  numberColumn('items', 'Items'),
  qtyColumn('totalQtyOrdered', 'Total Qty Ordered'),
  moneyColumn('totalValueExVat', 'Total Value Ex VAT'),
  moneyColumn('vat', 'VAT'),
  moneyColumn('totalValueInclVat', 'Total Value Incl VAT'),
  moneyColumn('receivedValue', 'Received Value'),
  moneyColumn('outstandingValue', 'Outstanding Value', 'outstandingValue'),
  { key: 'expectedDeliveryDate', label: 'Expected Delivery Date', type: 'date', sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'approvedBy', label: 'Approved By', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const bySupplierColumns = [
  { key: 'supplierName', label: 'Supplier', sortable: true },
  numberColumn('purchaseOrders', 'Purchase Orders'),
  numberColumn('openPos', 'Open POs'),
  numberColumn('receivedPos', 'Received POs'),
  moneyColumn('totalValueExVat', 'Total Value Ex VAT'),
  moneyColumn('receivedValue', 'Received Value'),
  moneyColumn('outstandingValue', 'Outstanding Value', 'outstandingValue'),
  { key: 'lastPoDate', label: 'Last PO Date', type: 'date', sortable: true }
];

const byLocationColumns = [
  { key: 'locationName', label: 'Location', sortable: true },
  numberColumn('purchaseOrders', 'Purchase Orders'),
  numberColumn('openPos', 'Open POs'),
  numberColumn('receivedPos', 'Received POs'),
  moneyColumn('totalValueExVat', 'Total Value Ex VAT'),
  moneyColumn('receivedValue', 'Received Value'),
  moneyColumn('outstandingValue', 'Outstanding Value', 'outstandingValue')
];

const byStatusColumns = [
  { key: 'status', label: 'Status', sortable: true },
  numberColumn('purchaseOrders', 'Purchase Orders'),
  numberColumn('items', 'Items'),
  moneyColumn('totalValueExVat', 'Total Value Ex VAT'),
  moneyColumn('receivedValue', 'Received Value'),
  moneyColumn('outstandingValue', 'Outstanding Value', 'outstandingValue')
];

const lineDetailColumns = [
  { key: 'poDate', label: 'PO Date', type: 'date', sortable: true },
  { key: 'poNumber', label: 'PO Number', sortable: true },
  { key: 'supplierName', label: 'Supplier', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  qtyColumn('qtyOrdered', 'Qty Ordered'),
  qtyColumn('qtyReceived', 'Qty Received'),
  qtyColumn('qtyOutstanding', 'Qty Outstanding', 'qtyOutstanding'),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  moneyColumn('unitCostExVat', 'Unit Cost Ex VAT', 'unitCostExVat'),
  moneyColumn('lineValueExVat', 'Line Value Ex VAT', 'poLineValueExVat'),
  moneyColumn('vat', 'VAT'),
  moneyColumn('lineValueInclVat', 'Line Value Incl VAT'),
  { key: 'status', label: 'Status', sortable: true },
  { key: 'expectedDeliveryDate', label: 'Expected Delivery Date', type: 'date', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

export const purchaseOrdersReport = {
  id: 'purchase_orders_report',
  exportFileNameBase: 'purchase-orders',
  title: 'Purchase Orders',
  section: 'purchasing',
  description: 'Purchase order report showing supplier orders, status, expected delivery, ordered value, received value, and outstanding value.',
  emptyState: { title: 'No purchase orders found', message: 'No purchase orders matched the selected filters.' },
  suppressEmptyWarning: true,
  defaultView: 'summary',
  availableViews: ['summary', 'by_supplier', 'by_location', 'by_status', 'line_detail'],
  filterConfig: {
    default: ['search', 'dateRange', 'location', 'supplier', 'status'],
    line_detail: ['search', 'dateRange', 'location', 'category', 'supplier', 'status']
  },
  columns: { summary: summaryColumns, by_supplier: bySupplierColumns, by_location: byLocationColumns, by_status: byStatusColumns, line_detail: lineDetailColumns },
  exportMapping: {
    summary: {
      poDate: 'PO Date', poNumber: 'PO Number', supplierName: 'Supplier', locationName: 'Location', status: 'Status', items: 'Items', totalQtyOrdered: 'Total Qty Ordered', totalValueExVat: 'Total Value Ex VAT', vat: 'VAT', totalValueInclVat: 'Total Value Incl VAT', receivedValue: 'Received Value', outstandingValue: 'Outstanding Value', expectedDeliveryDate: 'Expected Delivery Date', createdBy: 'Created By', approvedBy: 'Approved By', sourceId: 'Source ID'
    },
    by_supplier: mapColumns(bySupplierColumns),
    by_location: mapColumns(byLocationColumns),
    by_status: mapColumns(byStatusColumns),
    line_detail: mapColumns(lineDetailColumns)
  },
  getRows: async ({ workspaceId, filters, services = {}, view = 'summary' }) => {
    const payload = services.reporting?.getPurchaseOrderReportRows
      ? await services.reporting.getPurchaseOrderReportRows({ workspaceId, filters })
      : await fetchPurchaseOrderReportRows({ workspaceId, filters });
    rememberPayload(services, '__lastPurchaseOrderReportPayload', payload);
    const lineRows = toArray(payload.rows).map(normalizeLine);
    const views = buildPurchaseOrderViews(lineRows);
    return (views[view] || views.summary).map((row) => ({ ...row, __apiWarnings: payload.warnings || [], __apiMeta: payload.meta || {} }));
  },
  getTotals: ({ rows, view }) => buildTotals(rows, view),
  validate: ({ rows, services, view }) => {
    const warnings = [...toArray(services?.reporting?.__lastPurchaseOrderReportPayload?.warnings)];
    if (!rows.length) return warnings;
    if (view === 'line_detail') {
      addCountWarning(rows, warnings, 'purchase-order-missing-supplier', 'critical', 'purchase order line(s) have no supplier.', (row) => !text(row.supplierName));
      addCountWarning(rows, warnings, 'purchase-order-missing-location', 'critical', 'purchase order line(s) have no location.', (row) => !text(row.locationName));
      addCountWarning(rows, warnings, 'purchase-order-no-lines', 'critical', 'purchase order(s) have no line items.', (row) => row.hasLine === false);
      addCountWarning(rows, warnings, 'purchase-order-missing-item', 'critical', 'purchase order line(s) have no item.', (row) => row.hasLine !== false && !text(row.itemName));
      addCountWarning(rows, warnings, 'purchase-order-missing-quantity', 'critical', 'purchase order line(s) have no ordered quantity.', (row) => row.hasLine !== false && !safeNumber(row.qtyOrdered));
      addCountWarning(rows, warnings, 'purchase-order-missing-unit-cost', 'critical', 'purchase order line(s) have no unit cost.', (row) => row.hasLine !== false && !safeNumber(row.unitCostExVat));
      addCountWarning(rows, warnings, 'purchase-order-received-without-grv', 'critical', 'received purchase order line(s) have no linked GRV receipt.', (row) => row.hasLine !== false && row.status === 'Received' && safeNumber(row.grvCount) === 0);
      addCountWarning(rows, warnings, 'purchase-order-grv-value-mismatch', 'critical', 'purchase order line(s) do not reconcile to linked GRV value.', (row) => row.hasLine !== false && safeNumber(row.grvCount) > 0 && Math.abs(safeNumber(row.receivedValue) - safeNumber(row.grvReceivedValue)) > 0.01);
    }
    return warnings;
  }
};

export function buildPurchaseOrderViews(rows = []) {
  const summaries = buildSummary(rows);
  return {
    summary: summaries,
    by_supplier: buildBySupplier(summaries),
    by_location: buildByLocation(summaries),
    by_status: buildByStatus(summaries),
    line_detail: rows
  };
}

function normalizeLine(row = {}, index = 0) {
  const hasLine = !(row.hasLine === false || row.has_line === false || row.has_line === 0);
  const qtyOrdered = safeNumber(row.qtyOrdered ?? row.qty_ordered ?? row.quantity);
  const qtyReceived = safeNumber(row.qtyReceived ?? row.qty_received);
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitPrice ?? row.unit_price);
  const lineValueExVat = row.lineValueExVat !== undefined ? safeNumber(row.lineValueExVat) : roundMoney(qtyOrdered * unitCostExVat);
  const vat = safeNumber(row.vat ?? row.lineVat ?? row.line_vat);
  const lineValueInclVat = row.lineValueInclVat !== undefined ? safeNumber(row.lineValueInclVat) : roundMoney(lineValueExVat + vat);
  const receivedValue = safeNumber(row.receivedValue ?? row.received_value);
  return {
    ...row,
    hasLine,
    id: text(row.id) || `purchase-order-line:${text(row.sourceId || row.poId)}:${index}`,
    poId: text(row.poId || row.purchaseOrderId || row.purchase_order_id || row.sourceId),
    sourceId: text(row.sourceId || row.poId || row.purchaseOrderId || row.purchase_order_id),
    poDate: text(row.poDate || row.po_date || row.orderedAt || row.ordered_at).slice(0, 10),
    poNumber: text(row.poNumber || row.po_number),
    supplierId: text(row.supplierId || row.supplier_id),
    supplierName: text(row.supplierName || row.supplier_name),
    locationId: text(row.locationId || row.location_id || row.targetLocationId || row.target_location_id),
    locationName: text(row.locationName || row.location_name),
    itemId: text(row.itemId || row.stockItemId || row.stock_item_id),
    itemName: text(row.itemName || row.item_name || row.description),
    category: text(row.category || row.categoryName || row.category_name) || 'General',
    qtyOrdered,
    qtyReceived,
    qtyOutstanding: roundQuantity(qtyOrdered - qtyReceived),
    baseUom: text(row.baseUom || row.base_uom || row.unit),
    unitCostExVat,
    lineValueExVat,
    vat,
    lineValueInclVat,
    receivedValue,
    grvReceivedValue: safeNumber(row.grvReceivedValue ?? row.grv_received_value ?? receivedValue),
    grvCount: safeNumber(row.grvCount ?? row.grv_count),
    status: titleStatus(row.status),
    expectedDeliveryDate: text(row.expectedDeliveryDate || row.expected_delivery_date || row.expectedAt || row.expected_at).slice(0, 10),
    createdBy: text(row.createdByName || row.created_by_name || row.createdBy || row.created_by),
    approvedBy: text(row.approvedByName || row.approved_by_name || row.approvedBy || row.approved_by)
  };
}

function buildSummary(rows = []) {
  return Array.from(groupBy(rows, (row) => row.poId || row.sourceId || row.poNumber).entries()).map(([key, group]) => {
    const totalValueExVat = roundMoney(sumBy(group, 'lineValueExVat'));
    const vat = roundMoney(sumBy(group, 'vat'));
    const totalValueInclVat = roundMoney(sumBy(group, 'lineValueInclVat'));
    const receivedValue = roundMoney(sumBy(group, 'receivedValue'));
    return {
      id: `purchase-order-summary:${key}`,
      poId: text(group[0]?.poId),
      sourceId: text(group[0]?.sourceId || key),
      poDate: firstText(group, 'poDate'),
      poNumber: firstText(group, 'poNumber', key),
      supplierId: firstText(group, 'supplierId'),
      supplierName: firstText(group, 'supplierName'),
      locationId: firstText(group, 'locationId'),
      locationName: firstText(group, 'locationName'),
      status: firstText(group, 'status', 'Unknown'),
      items: uniqueCount(group, (row) => row.itemId || row.itemName),
      totalQtyOrdered: sumBy(group, 'qtyOrdered'),
      totalValueExVat,
      vat,
      totalValueInclVat,
      receivedValue,
      outstandingValue: roundMoney(totalValueExVat - receivedValue),
      expectedDeliveryDate: firstText(group, 'expectedDeliveryDate'),
      createdBy: firstText(group, 'createdBy'),
      approvedBy: firstText(group, 'approvedBy'),
      grvCount: sumBy(group, 'grvCount')
    };
  });
}

function buildBySupplier(rows) {
  return Array.from(groupBy(rows, (row) => row.supplierId || row.supplierName || 'Missing Supplier').entries()).map(([key, group]) => ({
    id: `purchase-orders-supplier:${key}`,
    supplierId: firstText(group, 'supplierId'),
    supplierName: firstText(group, 'supplierName', 'Missing Supplier'),
    purchaseOrders: group.length,
    openPos: group.filter((row) => !['Received', 'Cancelled'].includes(row.status)).length,
    receivedPos: group.filter((row) => row.status === 'Received').length,
    totalValueExVat: roundMoney(sumBy(group, 'totalValueExVat')),
    receivedValue: roundMoney(sumBy(group, 'receivedValue')),
    outstandingValue: roundMoney(sumBy(group, 'outstandingValue')),
    lastPoDate: latestText(group, 'poDate')
  }));
}

function buildByLocation(rows) {
  return Array.from(groupBy(rows, (row) => row.locationId || row.locationName || 'Missing Location').entries()).map(([key, group]) => ({
    id: `purchase-orders-location:${key}`,
    locationId: firstText(group, 'locationId'),
    locationName: firstText(group, 'locationName', 'Missing Location'),
    purchaseOrders: group.length,
    openPos: group.filter((row) => !['Received', 'Cancelled'].includes(row.status)).length,
    receivedPos: group.filter((row) => row.status === 'Received').length,
    totalValueExVat: roundMoney(sumBy(group, 'totalValueExVat')),
    receivedValue: roundMoney(sumBy(group, 'receivedValue')),
    outstandingValue: roundMoney(sumBy(group, 'outstandingValue'))
  }));
}

function buildByStatus(rows) {
  return Array.from(groupBy(rows, (row) => row.status || 'Unknown').entries()).map(([key, group]) => ({
    id: `purchase-orders-status:${key}`,
    status: key,
    purchaseOrders: group.length,
    items: sumBy(group, 'items'),
    totalValueExVat: roundMoney(sumBy(group, 'totalValueExVat')),
    receivedValue: roundMoney(sumBy(group, 'receivedValue')),
    outstandingValue: roundMoney(sumBy(group, 'outstandingValue'))
  }));
}

function buildTotals(rows, view) {
  if (view === 'summary') return { items: sumBy(rows, 'items'), totalQtyOrdered: sumBy(rows, 'totalQtyOrdered'), totalValueExVat: roundMoney(sumBy(rows, 'totalValueExVat')), vat: roundMoney(sumBy(rows, 'vat')), totalValueInclVat: roundMoney(sumBy(rows, 'totalValueInclVat')), receivedValue: roundMoney(sumBy(rows, 'receivedValue')), outstandingValue: roundMoney(sumBy(rows, 'outstandingValue')) };
  if (view === 'line_detail') return { qtyOrdered: sumBy(rows, 'qtyOrdered'), qtyReceived: sumBy(rows, 'qtyReceived'), qtyOutstanding: sumBy(rows, 'qtyOutstanding'), lineValueExVat: roundMoney(sumBy(rows, 'lineValueExVat')), vat: roundMoney(sumBy(rows, 'vat')), lineValueInclVat: roundMoney(sumBy(rows, 'lineValueInclVat')) };
  return { purchaseOrders: sumBy(rows, 'purchaseOrders'), totalValueExVat: roundMoney(sumBy(rows, 'totalValueExVat')), receivedValue: roundMoney(sumBy(rows, 'receivedValue')), outstandingValue: roundMoney(sumBy(rows, 'outstandingValue')) };
}

function addCountWarning(rows, warnings, code, level, message, predicate) {
  if (warnings.some((warning) => warning?.code === code)) return;
  const count = rows.filter(predicate).length;
  if (count) warnings.push({ code, level, message: `${count} ${message}` });
}

function roundQuantity(value) {
  return Math.round((safeNumber(value) + Number.EPSILON) * 10000) / 10000;
}

export default purchaseOrdersReport;
