import { absoluteValue, calculateStockValue, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { buildRowWarnings } from '../../validators/rowWarningUtils.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';
import { reconcileAdjustmentsToDetailedActivity } from '../../validators/reconciliationChecks.js';
import { detailedActivityReport } from './detailedActivityReport.js';
import {
  buildMenuItemWastageRows,
  isProductWastageMovement,
  resolveProductWastageIdentity,
  resolveProductWastageQuantity,
  resolveWastageSourceLabel,
} from './wastageSourceUtils.js';

const VALUE_TOLERANCE = 0.01;
const QTY_TOLERANCE = 0.0001;
const WASTAGE_REASON_PATTERN = /(wast|waste|loss|lost|spoil|spoilage|break|broken|damage|damaged|expired|burnt|burned|dropped|discard)/i;

const summaryColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'adjustmentType', label: 'Adjustment Type', sortable: true },
  { key: 'reason', label: 'Reason', sortable: true },
  { key: 'itemsAdjusted', label: 'Items Adjusted', type: 'number', align: 'right', sortable: true },
  { key: 'totalQtyAdjusted', label: 'Total Qty Adjusted', type: 'number', align: 'right', tooltipKey: 'adjustmentQty', cellTooltip: adjustmentQtyTooltip, sortable: true },
  { key: 'totalValueAdjusted', label: 'Total Value Adjusted', type: 'money', align: 'right', tooltipKey: 'adjustmentValue', cellTooltip: adjustmentValueTooltip, sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'transactionReference', label: 'Transaction ID', type: 'transaction_id', sortable: true }
];

const bySourceColumns = [
  { key: 'adjustmentSource', label: 'Source', sortable: true },
  { key: 'qtyAdjusted', label: 'Stock Qty Adjusted', type: 'number', align: 'right', sortable: true, tooltip: 'The absolute stock-item or ingredient quantity adjusted by this source. Menu-item quantities are shown in the Menu Items view.' },
  { key: 'valueImpact', label: 'Value Impact', type: 'money', align: 'right', tooltipKey: 'adjustmentValue', sortable: true },
  { key: 'eventCount', label: 'Adjustment Events', type: 'number', align: 'right', sortable: true },
  { key: 'menuItemsWasted', label: 'Menu Items Wasted', type: 'number', align: 'right', sortable: true, tooltip: 'The number of finished menu items recorded for product-wastage adjustments. This is zero for direct stock-item adjustments.' }
];

const menuItemColumns = [
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'qtyMenuItemsWasted', label: 'Menu Items Wasted', type: 'number', align: 'right', sortable: true },
  { key: 'wastageValue', label: 'Ingredient Cost Impact', type: 'money', align: 'right', sortable: true },
  { key: 'eventCount', label: 'Wastage Events', type: 'number', align: 'right', sortable: true },
  { key: 'ingredientLineCount', label: 'Ingredient Lines', type: 'number', align: 'right', sortable: true },
  { key: 'lastWastedDate', label: 'Last Wasted Date', type: 'date', sortable: true },
  { key: 'topReason', label: 'Top Reason', sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true }
];

const byReasonColumns = [
  { key: 'reason', label: 'Reason', sortable: true },
  { key: 'adjustmentType', label: 'Adjustment Type', sortable: true },
  { key: 'qtyAdjusted', label: 'Qty Adjusted', type: 'number', align: 'right', tooltipKey: 'adjustmentQty', cellTooltip: adjustmentQtyTooltip, sortable: true },
  { key: 'valueImpact', label: 'Value Impact', type: 'money', align: 'right', tooltipKey: 'adjustmentValue', cellTooltip: adjustmentValueTooltip, sortable: true },
  { key: 'eventCount', label: 'Event Count', type: 'number', align: 'right', sortable: true },
  { key: 'positiveAdjustmentValue', label: 'Positive Adjustment Value', type: 'money', align: 'right', tooltipKey: 'positiveAdjustment', sortable: true },
  { key: 'negativeAdjustmentValue', label: 'Negative Adjustment Value', type: 'money', align: 'right', tooltipKey: 'negativeAdjustment', sortable: true }
];

const byCategoryColumns = [
  { key: 'category', label: 'Category', sortable: true },
  { key: 'qtyAdjusted', label: 'Qty Adjusted', type: 'number', align: 'right', tooltipKey: 'adjustmentQty', cellTooltip: adjustmentQtyTooltip, sortable: true },
  { key: 'valueImpact', label: 'Value Impact', type: 'money', align: 'right', tooltipKey: 'adjustmentValue', cellTooltip: adjustmentValueTooltip, sortable: true },
  { key: 'eventCount', label: 'Event Count', type: 'number', align: 'right', sortable: true },
  { key: 'positiveAdjustmentValue', label: 'Positive Adjustment Value', type: 'money', align: 'right', tooltipKey: 'positiveAdjustment', sortable: true },
  { key: 'negativeAdjustmentValue', label: 'Negative Adjustment Value', type: 'money', align: 'right', tooltipKey: 'negativeAdjustment', sortable: true },
  { key: 'topAdjustedItem', label: 'Top Adjusted Item', sortable: true }
];

const byItemColumns = [
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'qtyAdjusted', label: 'Qty Adjusted', type: 'number', align: 'right', tooltipKey: 'adjustmentQty', cellTooltip: adjustmentQtyTooltip, sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', sortable: true },
  { key: 'valueImpact', label: 'Value Impact', type: 'money', align: 'right', tooltipKey: 'adjustmentValue', cellTooltip: adjustmentValueTooltip, sortable: true },
  { key: 'eventCount', label: 'Event Count', type: 'number', align: 'right', sortable: true },
  { key: 'lastAdjustmentDate', label: 'Last Adjustment Date', type: 'date', sortable: true },
  { key: 'topReason', label: 'Top Reason', sortable: true }
];

const lineDetailColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'time', label: 'Time', type: 'time', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'adjustmentType', label: 'Adjustment Type', sortable: true },
  { key: 'reason', label: 'Reason', sortable: true },
  { key: 'qtyBefore', label: 'Qty Before', type: 'number', align: 'right', sortable: true },
  { key: 'qtyAdjusted', label: 'Qty Adjusted', type: 'number', align: 'right', tooltipKey: 'adjustmentQty', cellTooltip: adjustmentQtyTooltip, sortable: true },
  { key: 'qtyAfter', label: 'Qty After', type: 'number', align: 'right', tooltipKey: 'qtyAfter', cellTooltip: qtyAfterTooltip, sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', sortable: true },
  { key: 'valueImpact', label: 'Value Impact', type: 'money', align: 'right', tooltipKey: 'adjustmentValue', cellTooltip: adjustmentValueTooltip, sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'notes', label: 'Notes' },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const adjustmentExportColumns = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'time', label: 'Time', type: 'time' },
  { key: 'locationName', label: 'Location' },
  { key: 'itemName', label: 'Item' },
  { key: 'category', label: 'Category' },
  { key: 'adjustmentType', label: 'Adjustment Type' },
  { key: 'reason', label: 'Reason' },
  { key: 'qtyBefore', label: 'Qty Before', type: 'number' },
  { key: 'qtyAdjusted', label: 'Qty Adjusted', type: 'number' },
  { key: 'qtyAfter', label: 'Qty After', type: 'number' },
  { key: 'baseUom', label: 'UOM' },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money' },
  { key: 'valueImpact', label: 'Value Impact', type: 'money' },
  { key: 'createdBy', label: 'Created By' },
  { key: 'notes', label: 'Notes' },
  { key: 'sourceId', label: 'Source ID' }
];

export const adjustmentsReport = {
  id: 'adjustments',
  title: 'Adjustments Report',
  section: 'operations',
  description: 'Audit all manual stock adjustments, wastage adjustments, stock take corrections, system corrections, and value impact.',
  emptyState: { title: 'No adjustments found', message: 'No adjustments found for the selected filters.' },
  defaultView: 'summary',
  availableViews: ['summary', 'by_source', 'menu_items', 'by_reason', 'by_category', 'by_item', 'line_detail'],
  filterConfig: {
    summary: ['search', 'dateRange', 'location', 'source'],
    by_source: ['search', 'dateRange', 'location', 'source'],
    menu_items: ['search', 'dateRange', 'location', 'source'],
    by_reason: ['search', 'dateRange', 'location', 'source'],
    by_category: ['search', 'dateRange', 'location', 'category', 'source'],
    by_item: ['search', 'dateRange', 'location', 'category', 'source'],
    line_detail: ['search', 'dateRange', 'time', 'location', 'category', 'source']
  },

  columns: {
    summary: summaryColumns,
    by_source: bySourceColumns,
    menu_items: menuItemColumns,
    by_reason: byReasonColumns,
    by_category: byCategoryColumns,
    by_item: byItemColumns,
    line_detail: lineDetailColumns
  },

  exportColumns: {
    summary: summaryColumns,
    by_source: bySourceColumns,
    menu_items: menuItemColumns,
    by_reason: byReasonColumns,
    by_category: byCategoryColumns,
    by_item: byItemColumns,
    line_detail: adjustmentExportColumns
  },

  getRows: async ({ workspaceId, filters, services = {}, dataSet = {}, view = 'summary' }) => {
    const ledgerRows = await detailedActivityReport.getRows({ workspaceId, filters, services, dataSet, view: 'ledger' });
    const adjustmentRows = buildAdjustmentRows(ledgerRows);
    const model = buildAdjustmentModel(adjustmentRows, ledgerRows);
    rememberAdjustmentModel(services, model);
    return (model.views[view] || model.views.summary).map((row) => withMeta(row, model));
  },

  getTotals: ({ rows, view }) => getTotalsForView(view, rows),

  validate: ({ rows, view, services }) => validateAdjustmentRows(rows, view, services),

  exportMapping: {
    summary: {
      date: 'Date',
      locationName: 'Location',
      adjustmentType: 'Adjustment Type',
      reason: 'Reason',
      itemsAdjusted: 'Items Adjusted',
      totalQtyAdjusted: 'Total Qty Adjusted',
      totalValueAdjusted: 'Total Value Adjusted',
      createdBy: 'Created By',
      transactionReference: 'Transaction ID'
    },
    by_source: {
      adjustmentSource: 'Source',
      qtyAdjusted: 'Stock Qty Adjusted',
      valueImpact: 'Value Impact',
      eventCount: 'Adjustment Events',
      menuItemsWasted: 'Menu Items Wasted'
    },
    menu_items: {
      menuItemName: 'Menu Item',
      locationName: 'Location',
      qtyMenuItemsWasted: 'Menu Items Wasted',
      wastageValue: 'Ingredient Cost Impact',
      eventCount: 'Wastage Events',
      ingredientLineCount: 'Ingredient Lines',
      lastWastedDate: 'Last Wasted Date',
      topReason: 'Top Reason',
      createdBy: 'Created By'
    },
    by_reason: {
      reason: 'Reason',
      adjustmentType: 'Adjustment Type',
      qtyAdjusted: 'Qty Adjusted',
      valueImpact: 'Value Impact',
      eventCount: 'Event Count',
      positiveAdjustmentValue: 'Positive Adjustment Value',
      negativeAdjustmentValue: 'Negative Adjustment Value'
    },
    by_category: {
      category: 'Category',
      qtyAdjusted: 'Qty Adjusted',
      valueImpact: 'Value Impact',
      eventCount: 'Event Count',
      positiveAdjustmentValue: 'Positive Adjustment Value',
      negativeAdjustmentValue: 'Negative Adjustment Value',
      topAdjustedItem: 'Top Adjusted Item'
    },
    by_item: {
      itemName: 'Item',
      category: 'Category',
      locationName: 'Location',
      qtyAdjusted: 'Qty Adjusted',
      baseUom: 'UOM',
      unitCostExVat: 'Unit Cost Ex VAT',
      valueImpact: 'Value Impact',
      eventCount: 'Event Count',
      lastAdjustmentDate: 'Last Adjustment Date',
      topReason: 'Top Reason'
    },
    line_detail: {
      date: 'Date',
      time: 'Time',
      locationName: 'Location',
      itemName: 'Item',
      category: 'Category',
      adjustmentType: 'Adjustment Type',
      reason: 'Reason',
      qtyBefore: 'Qty Before',
      qtyAdjusted: 'Qty Adjusted',
      qtyAfter: 'Qty After',
      baseUom: 'UOM',
      unitCostExVat: 'Unit Cost Ex VAT',
      valueImpact: 'Value Impact',
      createdBy: 'Created By',
      notes: 'Notes',
      sourceId: 'Source ID'
    }
  }
};

export function buildAdjustmentRows(ledgerRows = []) {
  return toArray(ledgerRows)
    .filter(isAdjustmentLedgerRow)
    .map(normalizeAdjustmentRow);
}

function normalizeAdjustmentRow(row = {}, index = 0) {
  const qtyAdjusted = safeNumber(row.netQty ?? safeNumber(row.qtyIn) - safeNumber(row.qtyOut));
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unitCost);
  const valueImpact = hasValue(row.movementValue) ? safeNumber(row.movementValue) : calculateStockValue(qtyAdjusted, unitCostExVat);
  const raw = row.raw || row.rawSourceRow || {};
  const qtyBeforeAfter = resolveBeforeAfterQty(row, qtyAdjusted);
  const reason = resolveReason(row);
  const adjustmentType = resolveAdjustmentType(row);
  const product = resolveProductWastageIdentity(row);
  const signedDirection = qtyAdjusted > 0 ? 'positive' : (qtyAdjusted < 0 ? 'negative' : 'zero');

  return {
    ...row,
    id: text(row.id) || `adjustment-row:${index}`,
    date: text(row.date || row.movementDate || row.timestamp).slice(0, 10),
    time: text(row.time || row.movementTime || row.timestamp),
    locationId: text(row.locationId),
    locationName: text(row.locationName),
    itemId: text(row.itemId),
    itemName: text(row.itemName),
    category: text(row.category || row.categoryName) || 'General',
    adjustmentType,
    source: adjustmentType,
    wastageKind: isProductWastageMovement(row) ? 'product' : (isWastageAdjustment(row) ? 'stock_item' : ''),
    productId: product.productId,
    productName: product.productName,
    menuItemName: product.productName,
    menuItemQty: resolveProductWastageQuantity(row),
    sourceType: row.sourceType,
    reason,
    qtyBefore: qtyBeforeAfter.qtyBefore,
    qtyAdjusted,
    qtyAfter: qtyBeforeAfter.qtyAfter,
    hasQtyBeforeAfter: qtyBeforeAfter.hasQtyBeforeAfter,
    baseUom: text(row.baseUom || row.unit),
    unitCostExVat,
    unitCost: unitCostExVat,
    valueImpact,
    createdBy: text(row.createdBy || row.user || row.createdByName),
    notes: text(row.notes || row.note),
    sourceId: text(row.sourceId),
    transactionReference: text(row.transactionReference),
    documentNumber: text(row.documentNumber),
    signedDirection,
    isWastageAdjustment: isWastageAdjustment(row),
    isStockTakeVariance: isStockTakeVariance(row),
    isSystemCorrection: isSystemCorrection(row),
    raw
  };
}

function buildAdjustmentModel(adjustmentRows = [], ledgerRows = []) {
  const rows = toArray(adjustmentRows);
  return {
    adjustmentRows: rows,
    ledgerRows: toArray(ledgerRows),
    views: {
      summary: summarizeAdjustmentRows(rows, summaryKey, toSummaryRow),
      by_source: summarizeAdjustmentRows(rows, sourceKey, toSourceRow),
      menu_items: buildMenuItemWastageRows(rows),
      by_reason: summarizeAdjustmentRows(rows, reasonKey, toReasonRow),
      by_category: summarizeAdjustmentRows(rows, categoryKey, toCategoryRow),
      by_item: summarizeAdjustmentRows(rows, itemKey, toItemRow),
      line_detail: rows
    }
  };
}

function summarizeAdjustmentRows(rows = [], keySelector, rowBuilder) {
  return Array.from(groupBy(rows, keySelector).entries()).map(([key, groupRows]) => rowBuilder(key, groupRows));
}

// One summary row = one posted adjustment/wastage/correction submission (matching how GRV Log's
// summary groups by grvId, not by date/location/type/reason which can span several distinct
// submissions) — this is what makes a summary row map 1:1 onto a single transaction drawer.
function toSummaryRow(key, rows = []) {
  const first = rows[0] || {};
  const locationNames = uniqueValues(rows, 'locationName');
  return {
    id: `adjustments-summary:${key}`,
    date: first.date || '',
    locationName: locationNames.length === 1 ? locationNames[0] : (locationNames.length > 1 ? 'Multiple Locations' : 'Unassigned'),
    adjustmentType: first.adjustmentType || 'Adjustment',
    reason: first.reason || 'No reason captured',
    itemsAdjusted: uniqueValues(rows, (row) => row.itemId || row.itemName).length,
    totalQtyAdjusted: sumAbs(rows, 'qtyAdjusted'),
    totalValueAdjusted: sumBy(rows, 'valueImpact'),
    createdBy: listTopText(rows, 'createdBy'),
    sourceId: text(first.sourceId, key),
    transactionReference: text(first.transactionReference),
    __sourceRows: rows
  };
}

function uniqueValues(rows = [], keySelector) {
  const selector = typeof keySelector === 'function' ? keySelector : (row) => row[keySelector];
  return [...new Set(toArray(rows).map((row) => text(selector(row))).filter(Boolean))];
}

function toSourceRow(key, rows = []) {
  const menuRows = buildMenuItemWastageRows(rows);
  const sourceIds = new Set(rows.map((row) => text(row.sourceId || row.id)).filter(Boolean));
  return {
    id: `adjustments-source:${key}`,
    adjustmentSource: text(key) || 'Adjustment',
    qtyAdjusted: sumAbs(rows, 'qtyAdjusted'),
    valueImpact: sumBy(rows, 'valueImpact'),
    eventCount: sourceIds.size || rows.length,
    menuItemsWasted: sumBy(menuRows, 'qtyMenuItemsWasted'),
    __sourceRows: rows
  };
}

function toReasonRow(key, rows = []) {
  const first = rows[0] || {};
  return {
    id: `adjustments-reason:${key}`,
    reason: first.reason || 'No reason captured',
    adjustmentType: first.adjustmentType || 'Adjustment',
    qtyAdjusted: sumAbs(rows, 'qtyAdjusted'),
    valueImpact: sumBy(rows, 'valueImpact'),
    eventCount: rows.length,
    positiveAdjustmentValue: sumPositiveValues(rows),
    negativeAdjustmentValue: sumNegativeAbsValues(rows),
    __sourceRows: rows
  };
}

function toCategoryRow(key, rows = []) {
  const valueByItem = topBy(rows, (row) => row.itemName || 'Unknown Item', (groupRows) => sumAbs(groupRows, 'valueImpact'));
  return {
    id: `adjustments-category:${key}`,
    category: rows[0]?.category || 'Uncategorised',
    qtyAdjusted: sumAbs(rows, 'qtyAdjusted'),
    valueImpact: sumBy(rows, 'valueImpact'),
    eventCount: rows.length,
    positiveAdjustmentValue: sumPositiveValues(rows),
    negativeAdjustmentValue: sumNegativeAbsValues(rows),
    topAdjustedItem: valueByItem?.key || '',
    __sourceRows: rows
  };
}

function toItemRow(key, rows = []) {
  const first = rows[0] || {};
  const latest = [...rows].sort((left, right) => text(right.date).localeCompare(text(left.date)))[0] || first;
  const totalQty = sumAbs(rows, 'qtyAdjusted');
  const valueImpact = sumBy(rows, 'valueImpact');
  const latestCost = latest.unitCostExVat || first.unitCostExVat || 0;
  const reason = topBy(rows, (row) => row.reason || 'No reason captured', (groupRows) => groupRows.length);
  return {
    id: `adjustments-item:${key}`,
    itemName: first.itemName || 'Unknown Item',
    category: first.category || 'Uncategorised',
    locationName: first.locationName || 'Unassigned',
    qtyAdjusted: totalQty,
    baseUom: first.baseUom || '',
    unitCostExVat: latestCost,
    valueImpact,
    eventCount: rows.length,
    lastAdjustmentDate: latest.date || '',
    topReason: reason?.key || '',
    __sourceRows: rows
  };
}

function getTotalsForView(view = 'summary', rows = []) {
  const reportRows = toArray(rows);
  if (view === 'summary') {
    return {
      itemsAdjusted: sumBy(reportRows, 'itemsAdjusted'),
      totalQtyAdjusted: sumBy(reportRows, 'totalQtyAdjusted'),
      totalValueAdjusted: sumBy(reportRows, 'totalValueAdjusted')
    };
  }
  if (view === 'by_source') {
    return {
      qtyAdjusted: sumBy(reportRows, 'qtyAdjusted'),
      valueImpact: sumBy(reportRows, 'valueImpact'),
      eventCount: sumBy(reportRows, 'eventCount'),
      menuItemsWasted: sumBy(reportRows, 'menuItemsWasted')
    };
  }
  if (view === 'menu_items') {
    return {
      qtyMenuItemsWasted: sumBy(reportRows, 'qtyMenuItemsWasted'),
      wastageValue: sumBy(reportRows, 'wastageValue'),
      eventCount: sumBy(reportRows, 'eventCount'),
      ingredientLineCount: sumBy(reportRows, 'ingredientLineCount')
    };
  }
  if (view === 'by_reason') {
    return {
      qtyAdjusted: sumBy(reportRows, 'qtyAdjusted'),
      valueImpact: sumBy(reportRows, 'valueImpact'),
      positiveAdjustmentValue: sumBy(reportRows, 'positiveAdjustmentValue'),
      negativeAdjustmentValue: sumBy(reportRows, 'negativeAdjustmentValue'),
      eventCount: sumBy(reportRows, 'eventCount')
    };
  }
  if (view === 'by_category') {
    return {
      qtyAdjusted: sumBy(reportRows, 'qtyAdjusted'),
      valueImpact: sumBy(reportRows, 'valueImpact'),
      eventCount: sumBy(reportRows, 'eventCount')
    };
  }
  if (view === 'by_item') {
    return {
      qtyAdjusted: sumBy(reportRows, 'qtyAdjusted'),
      valueImpact: sumBy(reportRows, 'valueImpact'),
      eventCount: sumBy(reportRows, 'eventCount')
    };
  }
  return {
    qtyAdjusted: sumBy(reportRows, 'qtyAdjusted'),
    valueImpact: sumBy(reportRows, 'valueImpact')
  };
}

function validateAdjustmentRows(rows = [], view = 'summary', services = {}) {
  const reportRows = toArray(rows);
  if (!reportRows.length) return [{ code: 'adjustments-empty', level: 'info', message: 'No adjustments found for the selected filters.' }];

  const meta = reportRows.find((row) => row.__meta)?.__meta || services?.reporting?.__lastAdjustmentsModel || {};
  const adjustmentRows = toArray(meta.adjustmentRows || (view === 'line_detail' ? reportRows : reportRows.flatMap((row) => row.__sourceRows)));
  const warnings = [
    countWarning(adjustmentRows, 'adjustments-missing-item', 'critical', 'adjustment row(s) are missing item names.', (row) => !text(row.itemName)),
    countWarning(adjustmentRows, 'adjustments-missing-location', 'critical', 'adjustment row(s) are missing location names.', (row) => !text(row.locationName)),
    countWarning(adjustmentRows, 'adjustments-missing-source-id', 'critical', 'adjustment row(s) are missing source IDs.', (row) => !text(row.sourceId)),
    countWarning(adjustmentRows, 'adjustments-missing-created-by', 'warning', 'adjustment row(s) are missing created by values.', (row) => !text(row.createdBy)),
    countWarning(adjustmentRows, 'adjustments-missing-unit-cost', 'critical', 'adjustment row(s) do not have a unit cost yet, so value impact may show R0 until item/location costs are loaded.', (row) => hasAdjustmentMovement(row) && safeNumber(row.unitCostExVat) === 0),
    countWarning(adjustmentRows, 'adjustments-missing-reason', 'warning', 'adjustment row(s) are missing a reason.', reasonIsRequiredButMissing),
    countWarning(adjustmentRows, 'adjustments-qty-in-out-both-populated', 'warning', 'adjustment row(s) have both Qty In and Qty Out populated.', (row) => safeNumber(row.qtyIn) > 0 && safeNumber(row.qtyOut) > 0),
    countWarning(adjustmentRows, 'adjustments-zero-movement-qty', 'warning', 'adjustment row(s) have both Qty In and Qty Out as zero.', (row) => safeNumber(row.qtyIn) === 0 && safeNumber(row.qtyOut) === 0 && safeNumber(row.qtyAdjusted) === 0),
    countWarning(adjustmentRows, 'adjustments-value-impact-mismatch', 'critical', 'adjustment row(s) have Value Impact values that do not match Qty Adjusted x Unit Cost Ex VAT.', valueImpactMismatch),
    countWarning(adjustmentRows, 'adjustments-duplicate-source-row', 'warning', 'duplicate adjustment row(s) exist for the same source/item/location/direction.', duplicateAdjustmentPredicate(adjustmentRows)),
    countWarning(adjustmentRows, 'adjustments-wastage-not-marked-for-wastage-report', 'warning', 'Wastage Adjustment row(s) are not marked as wastage rows for Wastage Report reconciliation.', (row) => row.isWastageAdjustment && row.__includedInWastageReport === false),
    ...reconcileAdjustmentsToDetailedActivity({ adjustmentRows, detailedRows: meta.ledgerRows })
  ].filter(Boolean);

  if (view === 'line_detail') {
    warnings.push(countWarning(adjustmentRows, 'adjustments-missing-before-after-qty', 'info', 'line detail adjustment row(s) cannot show Qty Before/After because running quantity is unavailable.', (row) => !row.hasQtyBeforeAfter));
  }

  return warnings.filter(Boolean);
}


function countWarning(rows = [], code = '', level = 'warning', message = '', predicate = () => false) {
  return buildRowWarnings(rows, code, level, message, predicate);
}

function isAdjustmentLedgerRow(row = {}) {
  const source = text(row.source);
  const movementType = text(row.movementType);
  const sourceType = text(row.sourceType);
  if (['Manual Adjustment', 'Wastage Adjustment', 'Manual Wastage', 'Stock Take Variance', 'Stock Take Correction', 'System Correction', 'Manufacturing Correction'].includes(source)) return true;
  if (['Manual Adjustment', 'Wastage Adjustment', 'Manual Wastage', 'Stock Take Variance', 'Stock Take Correction', 'System Correction', 'Manufacturing Correction'].includes(movementType)) return true;
  if (['adjustment', 'wastage', 'manualWastage', 'stockTake', 'stockTakeCorrection', 'systemCorrection', 'manufacturingCorrection'].includes(sourceType)) return true;
  if (/adjustment|correction|stock take variance|stocktake variance/i.test(source) || /adjustment|correction|stock take variance|stocktake variance/i.test(movementType)) return true;
  return false;
}

function resolveAdjustmentType(row = {}) {
  const source = text(row.source);
  const movementType = text(row.movementType);
  if (isStockTakeVariance(row)) return 'Stock Take Variance';
  if (isWastageAdjustment(row)) return resolveWastageSourceLabel(row, source || movementType);
  if (isSystemCorrection(row)) return 'System Correction';
  if (source) return source;
  if (movementType) return movementType;
  return 'Manual Adjustment';
}

function resolveReason(row = {}) {
  const raw = row.raw || row.rawSourceRow || {};
  const metadata = parseMetadata(row.metadata || raw.metadata || raw.meta);
  return text(
    row.reason ||
    row.adjustmentReason ||
    row.adjustment_reason ||
    row.notes ||
    row.note ||
    raw.reason ||
    raw.adjustmentReason ||
    raw.adjustment_reason ||
    metadata.reason ||
    metadata.wasteReason ||
    metadata.waste_reason ||
    metadata.correctionReason
  ) || (isStockTakeVariance(row) ? 'Stock take variance' : 'No reason captured');
}

function resolveBeforeAfterQty(row = {}, qtyAdjusted = 0) {
  const raw = row.raw || row.rawSourceRow || {};
  const qtyBefore = firstNumber(row.qtyBefore, row.beforeQty, row.qty_before, raw.qtyBefore, raw.beforeQty, raw.qty_before, raw.previousQty, raw.previous_qty);
  const qtyAfter = firstNumber(row.qtyAfter, row.afterQty, row.qty_after, raw.qtyAfter, raw.afterQty, raw.qty_after, raw.newQty, raw.new_qty);
  if (qtyBefore !== null && qtyAfter !== null) return { qtyBefore, qtyAfter, hasQtyBeforeAfter: true };
  if (hasValue(row.runningQty)) {
    const derivedAfter = safeNumber(row.runningQty);
    return { qtyBefore: derivedAfter - safeNumber(qtyAdjusted), qtyAfter: derivedAfter, hasQtyBeforeAfter: true };
  }
  if (qtyBefore !== null) return { qtyBefore, qtyAfter: qtyBefore + safeNumber(qtyAdjusted), hasQtyBeforeAfter: true };
  if (qtyAfter !== null) return { qtyBefore: qtyAfter - safeNumber(qtyAdjusted), qtyAfter, hasQtyBeforeAfter: true };
  return { qtyBefore: null, qtyAfter: null, hasQtyBeforeAfter: false };
}

function firstNumber(...values) {
  for (const value of values) {
    if (hasValue(value)) return safeNumber(value);
  }
  return null;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function summaryKey(row = {}) {
  return text(row.sourceId) || [row.date, row.locationId || row.locationName, row.adjustmentType, row.reason, row.createdBy].map(text).join('::');
}

function sourceKey(row = {}) {
  return text(row.adjustmentType || 'Adjustment');
}

function reasonKey(row = {}) {
  return [row.reason || 'No reason captured', row.adjustmentType || 'Adjustment'].map(text).join('::');
}

function categoryKey(row = {}) {
  return text(row.category || 'Uncategorised');
}

function itemKey(row = {}) {
  return [row.itemId || row.itemName || 'Unknown Item', row.locationId || row.locationName || 'Unassigned'].map(text).join('::');
}

function sumAbs(rows = [], key) {
  return toArray(rows).reduce((total, row) => total + absoluteValue(row[key]), 0);
}

function sumPositiveValues(rows = []) {
  return toArray(rows).reduce((total, row) => safeNumber(row.valueImpact) > 0 ? total + safeNumber(row.valueImpact) : total, 0);
}

function sumNegativeAbsValues(rows = []) {
  return toArray(rows).reduce((total, row) => safeNumber(row.valueImpact) < 0 ? total + absoluteValue(row.valueImpact) : total, 0);
}

function topBy(rows = [], keySelector, valueSelector) {
  const grouped = Array.from(groupBy(rows, keySelector).entries()).map(([key, groupRows]) => ({ key, value: valueSelector(groupRows), rows: groupRows }));
  return grouped.sort((left, right) => safeNumber(right.value) - safeNumber(left.value))[0] || null;
}

function listTopText(rows = [], key) {
  return topBy(rows, (row) => row[key] || '', (groupRows) => groupRows.length)?.key || '';
}

function withMeta(row = {}, model = {}) {
  return { ...row, __meta: model };
}

function rememberAdjustmentModel(services = {}, model = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastAdjustmentsModel = model;
}

function hasValue(value) {
  return value !== undefined && value !== null && text(value) !== '';
}

function hasAdjustmentMovement(row = {}) {
  return safeNumber(row.qtyIn) !== 0 || safeNumber(row.qtyOut) !== 0 || safeNumber(row.qtyAdjusted) !== 0;
}

function reasonIsRequiredButMissing(row = {}) {
  const requiresReason = isWastageAdjustment(row) || isSystemCorrection(row) || text(row.adjustmentType) === 'Manual Adjustment';
  return requiresReason && (!text(row.reason) || text(row.reason) === 'No reason captured');
}

function valueImpactMismatch(row = {}) {
  const unitCost = safeNumber(row.unitCostExVat ?? row.unitCost);
  const actual = safeNumber(row.valueImpact);
  if (unitCost === 0 && actual === 0) return false;
  const expected = calculateStockValue(row.qtyAdjusted, unitCost);
  return Math.abs(actual - expected) > VALUE_TOLERANCE;
}

function duplicateAdjustmentPredicate(rows = []) {
  const counts = new Map();
  toArray(rows).forEach((row) => {
    const key = [row.sourceId, row.itemId || row.itemName, row.locationId || row.locationName, row.qtyAdjusted > 0 ? 'in' : 'out', row.adjustmentType].map(text).join('::');
    if (!text(row.sourceId)) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return (row) => {
    const key = [row.sourceId, row.itemId || row.itemName, row.locationId || row.locationName, row.qtyAdjusted > 0 ? 'in' : 'out', row.adjustmentType].map(text).join('::');
    return text(row.sourceId) && (counts.get(key) || 0) > 1;
  };
}

function isWastageAdjustment(row = {}) {
  const source = text(row.source || row.adjustmentType);
  const sourceType = text(row.sourceType);
  const movementType = text(row.movementType);
  return /wastage|waste/i.test(source) || sourceType === 'wastage' || sourceType === 'manualWastage' || /wastage|waste/i.test(movementType) || WASTAGE_REASON_PATTERN.test(text(row.reason || row.notes || row.note));
}

function isStockTakeVariance(row = {}) {
  const source = text(row.source || row.adjustmentType);
  const sourceType = text(row.sourceType);
  const movementType = text(row.movementType);
  return source === 'Stock Take Variance' || source === 'Stock Take Correction' || sourceType === 'stockTake' || sourceType === 'stockTakeCorrection' || /stock ?take/i.test(movementType);
}

function isSystemCorrection(row = {}) {
  const source = text(row.source || row.adjustmentType);
  const sourceType = text(row.sourceType);
  const movementType = text(row.movementType);
  return source === 'System Correction' || sourceType === 'systemCorrection' || /system correction/i.test(movementType);
}

function adjustmentQtyTooltip(row = {}) {
  return buildRowFormulaTooltip(
    'adjustmentQty',
    `${safeNumber(row.qtyAdjusted ?? row.totalQtyAdjusted)} = ${safeNumber(row.qtyIn)} - ${safeNumber(row.qtyOut)}`
  );
}

function adjustmentValueTooltip(row = {}) {
  const qty = safeNumber(row.qtyAdjusted ?? row.totalQtyAdjusted);
  const unitCost = safeNumber(row.unitCostExVat ?? row.unitCost);
  const value = safeNumber(row.valueImpact ?? row.totalValueAdjusted);
  return buildRowFormulaTooltip('adjustmentValue', `${formatMoney(value)} = ${qty} x ${formatMoney(unitCost)}`);
}

function qtyAfterTooltip(row = {}) {
  if (!hasValue(row.qtyBefore) || !hasValue(row.qtyAfter)) return '';
  return buildRowFormulaTooltip('qtyAfter', `${safeNumber(row.qtyAfter)} = ${safeNumber(row.qtyBefore)} + ${safeNumber(row.qtyAdjusted)}`);
}

function formatMoney(value) {
  return `R${safeNumber(value).toFixed(2)}`;
}

export const __adjustmentsReportInternals = {
  buildAdjustmentRows,
  isAdjustmentLedgerRow,
  buildAdjustmentModel,
  resolveAdjustmentType
};

export default adjustmentsReport;
