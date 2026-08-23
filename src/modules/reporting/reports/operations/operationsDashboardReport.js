import {
  absoluteValue,
  calculateExpectedClosingQty,
  calculateExpectedClosingValue,
  calculateStockValue,
  calculateValueVariancePercent,
  calculateVarianceQty,
  calculateVarianceValue,
  safeNumber
} from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { buildRowWarnings } from '../../validators/rowWarningUtils.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';
import { reconcileDetailedActivityToOperationsDashboard } from '../../validators/reconciliationChecks.js';
import { detailedActivityReport } from './detailedActivityReport.js';

const VALUE_TOLERANCE = 0.01;
const QTY_TOLERANCE = 0.0001;

const ledgerColumns = [
  { key: 'date', label: 'Date', type: 'date', width: '110px', sortable: true },
  { key: 'time', label: 'Time', type: 'time', width: '90px', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'movementType', label: 'Movement Type', sortable: true },
  { key: 'source', label: 'Source', tooltipKey: 'source', sortable: true },
  { key: 'documentNumber', label: 'Document Number', sortable: true },
  { key: 'qtyIn', label: 'Qty In', type: 'number', align: 'right', sortable: true },
  { key: 'qtyOut', label: 'Qty Out', type: 'number', align: 'right', sortable: true },
  { key: 'netQty', label: 'Net Qty', type: 'number', align: 'right', tooltipKey: 'netMovement', sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', tooltipKey: 'unitCostExVat', sortable: true },
  { key: 'movementValue', label: 'Movement Value', type: 'money', align: 'right', tooltipKey: 'movementValue', sortable: true },
  { key: 'runningQty', label: 'Running Qty', type: 'number', align: 'right', tooltipKey: 'runningQty', sortable: true },
  { key: 'runningValue', label: 'Running Value', type: 'money', align: 'right', tooltipKey: 'runningValue', sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'notes', label: 'Notes' },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const overviewColumns = [
  { key: 'dateRange', label: 'Date Range', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'openingStockValue', label: 'Opening Stock Value', type: 'money', align: 'right', sortable: true },
  { key: 'purchases', label: 'Purchases', type: 'money', align: 'right', sortable: true },
  { key: 'salesUsage', label: 'Sales Usage', type: 'money', align: 'right', sortable: true },
  { key: 'manufacturingIn', label: 'Manufacturing In', type: 'money', align: 'right', sortable: true },
  { key: 'manufacturingOut', label: 'Manufacturing Out', type: 'money', align: 'right', sortable: true },
  { key: 'manufacturingWastage', label: 'Manufacturing Wastage', type: 'money', align: 'right', sortable: true },
  { key: 'manualWastage', label: 'Manual Wastage', type: 'money', align: 'right', sortable: true },
  { key: 'adjustments', label: 'Adjustments', type: 'money', align: 'right', sortable: true },
  { key: 'transfersIn', label: 'Transfers In', type: 'money', align: 'right', sortable: true },
  { key: 'transfersOut', label: 'Transfers Out', type: 'money', align: 'right', sortable: true },
  { key: 'expectedClosingValue', label: 'Expected Closing Value', type: 'money', align: 'right', tooltipKey: 'expectedClosingValue', cellTooltip: expectedClosingValueTooltip, sortable: true },
  { key: 'actualClosingValue', label: 'Actual Closing Value', type: 'money', align: 'right', sortable: true },
  { key: 'varianceValue', label: 'Variance Value', type: 'money', align: 'right', tooltipKey: 'operationsVarianceValue', cellTooltip: varianceValueTooltip, sortable: true },
  { key: 'netStockMovement', label: 'Net Stock Movement', type: 'money', align: 'right', tooltipKey: 'netStockMovement', cellTooltip: netStockMovementTooltip, sortable: true }
];

const byCategoryColumns = [
  { key: 'category', label: 'Inventory Category', sortable: true },
  { key: 'openingValue', label: 'Opening Value', type: 'money', align: 'right', sortable: true },
  { key: 'purchases', label: 'Purchases', type: 'money', align: 'right', sortable: true },
  { key: 'salesUsage', label: 'Sales Usage', type: 'money', align: 'right', sortable: true },
  { key: 'wastage', label: 'Wastage', type: 'money', align: 'right', sortable: true },
  { key: 'adjustments', label: 'Adjustments', type: 'money', align: 'right', sortable: true },
  { key: 'transfersIn', label: 'Transfers In', type: 'money', align: 'right', sortable: true },
  { key: 'transfersOut', label: 'Transfers Out', type: 'money', align: 'right', sortable: true },
  { key: 'manufacturingIn', label: 'Manufacturing In', type: 'money', align: 'right', sortable: true },
  { key: 'manufacturingOut', label: 'Manufacturing Out', type: 'money', align: 'right', sortable: true },
  { key: 'expectedClosing', label: 'Expected Closing', type: 'money', align: 'right', tooltipKey: 'expectedClosingValue', cellTooltip: expectedClosingValueTooltip, sortable: true },
  { key: 'actualClosing', label: 'Actual Closing', type: 'money', align: 'right', sortable: true },
  { key: 'variance', label: 'Variance', type: 'money', align: 'right', tooltipKey: 'operationsVarianceValue', cellTooltip: varianceValueTooltip, sortable: true },
  { key: 'variancePercent', label: 'Variance %', type: 'percent', align: 'right', tooltipKey: 'variancePercent', cellTooltip: variancePercentTooltip, sortable: true }
];

const byItemColumns = [
  { key: 'itemName', label: 'Inventory Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'openingQty', label: 'Opening Qty', type: 'number', align: 'right', sortable: true },
  { key: 'purchasedQty', label: 'Purchased Qty', type: 'number', align: 'right', sortable: true },
  { key: 'soldUsedQty', label: 'Sold / Used Qty', type: 'number', align: 'right', sortable: true },
  { key: 'wastedQty', label: 'Wasted Qty', type: 'number', align: 'right', sortable: true },
  { key: 'adjustedQty', label: 'Adjusted Qty', type: 'number', align: 'right', sortable: true },
  { key: 'transferredInQty', label: 'Transferred In Qty', type: 'number', align: 'right', sortable: true },
  { key: 'transferredOutQty', label: 'Transferred Out Qty', type: 'number', align: 'right', sortable: true },
  { key: 'manufacturedInQty', label: 'Manufactured In Qty', type: 'number', align: 'right', sortable: true },
  { key: 'manufacturedOutQty', label: 'Manufactured Out Qty', type: 'number', align: 'right', sortable: true },
  { key: 'expectedClosingQty', label: 'Expected Closing Qty', type: 'number', align: 'right', tooltipKey: 'expectedClosingQty', cellTooltip: expectedClosingQtyTooltip, sortable: true },
  { key: 'actualClosingQty', label: 'Actual Closing Qty', type: 'number', align: 'right', sortable: true },
  { key: 'varianceQty', label: 'Variance Qty', type: 'number', align: 'right', tooltipKey: 'operationsVarianceQty', cellTooltip: varianceQtyTooltip, sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', tooltipKey: 'unitCostExVat', sortable: true },
  { key: 'varianceValue', label: 'Variance Value', type: 'money', align: 'right', tooltipKey: 'varianceValue', sortable: true }
];

export const operationsDashboardReport = {
  id: 'operations_dashboard',
  title: 'Operations Dashboard',
  section: 'operations',
  description: 'High-level operational stock movement, value impact, wastage, adjustments, transfers, manufacturing, and variance dashboard.',
  defaultView: 'overview',
  availableViews: ['overview', 'by_category', 'by_item', 'movement_ledger'],
  filterConfig: {
    overview: ['search', 'dateRange'],
    by_category: ['search', 'dateRange', 'location', 'category', 'source'],
    by_item: ['search', 'dateRange', 'location', 'category', 'source'],
    movement_ledger: ['search', 'dateRange', 'time', 'location', 'category', 'source']
  },

  columns: {
    overview: overviewColumns,
    by_category: byCategoryColumns,
    by_item: byItemColumns,
    movement_ledger: ledgerColumns
  },

  exportColumns: {
    overview: overviewColumns,
    by_category: byCategoryColumns,
    by_item: byItemColumns,
    movement_ledger: ledgerColumns
  },

  getRows: async ({ workspaceId, filters, services = {}, dataSet = {}, view = 'overview' }) => {
    const ledgerRows = await getTrustedLedgerRows({ workspaceId, filters, services, dataSet });
    const model = buildOperationsDashboardModel({ ledgerRows, filters, dataSet });
    const rows = view === 'movement_ledger'
      ? ledgerRows.map((row) => withMeta(row, model.meta))
      : toArray(model.views[view]).map((row) => withMeta(row, model.meta));
    return rows;
  },

  getTotals: ({ rows, view }) => getTotalsForView(view, rows),

  validate: ({ rows, view }) => validateOperationsDashboardRows(rows, view),

  exportMapping: {
    overview: {
      dateRange: 'Date Range',
      locationName: 'Location',
      openingStockValue: 'Opening Stock Value',
      purchases: 'Purchases',
      salesUsage: 'Sales Usage',
      manufacturingIn: 'Manufacturing In',
      manufacturingOut: 'Manufacturing Out',
      manufacturingWastage: 'Manufacturing Wastage',
      manualWastage: 'Manual Wastage',
      adjustments: 'Adjustments',
      transfersIn: 'Transfers In',
      transfersOut: 'Transfers Out',
      expectedClosingValue: 'Expected Closing Value',
      actualClosingValue: 'Actual Closing Value',
      varianceValue: 'Variance Value',
      netStockMovement: 'Net Stock Movement'
    },
    by_category: {
      category: 'Category',
      openingValue: 'Opening Value',
      purchases: 'Purchases',
      salesUsage: 'Sales Usage',
      wastage: 'Wastage',
      adjustments: 'Adjustments',
      transfersIn: 'Transfers In',
      transfersOut: 'Transfers Out',
      manufacturingIn: 'Manufacturing In',
      manufacturingOut: 'Manufacturing Out',
      expectedClosing: 'Expected Closing',
      actualClosing: 'Actual Closing',
      variance: 'Variance',
      variancePercent: 'Variance %'
    },
    by_item: {
      itemName: 'Item',
      category: 'Category',
      baseUom: 'Base UOM',
      openingQty: 'Opening Qty',
      purchasedQty: 'Purchased Qty',
      soldUsedQty: 'Sold / Used Qty',
      wastedQty: 'Wasted Qty',
      adjustedQty: 'Adjusted Qty',
      transferredInQty: 'Transferred In Qty',
      transferredOutQty: 'Transferred Out Qty',
      manufacturedInQty: 'Manufactured In Qty',
      manufacturedOutQty: 'Manufactured Out Qty',
      expectedClosingQty: 'Expected Closing Qty',
      actualClosingQty: 'Actual Closing Qty',
      varianceQty: 'Variance Qty',
      unitCostExVat: 'Unit Cost Ex VAT',
      varianceValue: 'Variance Value'
    },
    movement_ledger: {
      date: 'Date',
      time: 'Time',
      locationName: 'Location',
      itemName: 'Item',
      category: 'Category',
      movementType: 'Movement Type',
      source: 'Source',
      documentNumber: 'Document Number',
      qtyIn: 'Qty In',
      qtyOut: 'Qty Out',
      netQty: 'Net Qty',
      baseUom: 'Base UOM',
      unitCostExVat: 'Unit Cost Ex VAT',
      movementValue: 'Movement Value',
      runningQty: 'Running Qty',
      runningValue: 'Running Value',
      createdBy: 'Created By',
      notes: 'Notes',
      sourceId: 'Source ID'
    }
  }
};

async function getTrustedLedgerRows({ workspaceId, filters, services, dataSet }) {
  return detailedActivityReport.getRows({ workspaceId, filters, services, dataSet, view: 'ledger' });
}

function buildOperationsDashboardModel({ ledgerRows = [], filters = {}, dataSet = {} }) {
  const reportLedgerRows = toArray(ledgerRows);
  const includedRows = reportLedgerRows
    .filter((row) => isStockHoldingLedgerRow(row, dataSet))
    .map((row) => normalizeOperationsLedgerRow(row, dataSet));
  const dateRange = buildDateRangeLabel(filters, reportLedgerRows);
  const snapshotResolver = createSnapshotResolver(includedRows, dataSet);
  const meta = buildOperationsMeta(reportLedgerRows, includedRows, snapshotResolver);

  return {
    views: {
      overview: buildOverviewRows(includedRows, dateRange, snapshotResolver),
      by_category: buildByCategoryRows(includedRows, snapshotResolver),
      by_item: buildByItemRows(includedRows, snapshotResolver),
      movement_ledger: reportLedgerRows
    },
    meta
  };
}


function normalizeOperationsLedgerRow(row = {}, dataSet = {}) {
  const stockItem = resolveStockItemFromDataSet(row, dataSet) || {};
  return {
    ...row,
    itemName: text(stockItem.name) || row.itemName,
    category: text(stockItem.category) || row.category || 'Uncategorised',
    baseUom: text(stockItem.baseUom || stockItem.unit || stockItem.uom) || row.baseUom || row.unit
  };
}

function buildOverviewRows(ledgerRows = [], dateRange = 'All Dates', snapshotResolver) {
  return Array.from(groupBy(ledgerRows, (row) => row.locationId || row.locationName || 'All Locations').entries())
    .map(([locationKey, rows]) => {
      const snapshot = snapshotResolver.sumValuesForRows(rows);
      const metrics = summarizeValueMovements(rows);
      const stockIn = metrics.purchases + metrics.manufacturingIn + metrics.transfersIn + metrics.positiveAdjustments;
      const stockOut = metrics.salesUsage + metrics.manufacturingOut + metrics.manufacturingWastage + metrics.manualWastage + metrics.transfersOut + metrics.negativeAdjustments;
      const expectedClosingValue = calculateExpectedClosingValue(snapshot.openingValue, stockIn, stockOut);
      const varianceValue = snapshot.hasActual ? snapshot.actualValue - expectedClosingValue : null;

      return {
        id: `operations-overview:${locationKey}`,
        dateRange,
        locationId: rows[0]?.locationId || '',
        locationName: rows[0]?.locationName || 'Unassigned',
        openingStockValue: snapshot.openingValue,
        purchases: metrics.purchases,
        salesUsage: metrics.salesUsage,
        manufacturingIn: metrics.manufacturingIn,
        manufacturingOut: metrics.manufacturingOut,
        manufacturingWastage: metrics.manufacturingWastage,
        manualWastage: metrics.manualWastage,
        adjustments: metrics.adjustments,
        transfersIn: metrics.transfersIn,
        transfersOut: metrics.transfersOut,
        expectedClosingValue,
        actualClosingValue: snapshot.hasActual ? snapshot.actualValue : null,
        varianceValue,
        netStockMovement: stockIn - stockOut,
        stockIn,
        stockOut,
        positiveAdjustments: metrics.positiveAdjustments,
        negativeAdjustments: metrics.negativeAdjustments,
        missingOpeningCount: snapshot.missingOpeningCount,
        missingActualCount: snapshot.missingActualCount,
        rowCount: rows.length,
        reportSummaryRow: true
      };
    });
}

function buildByCategoryRows(ledgerRows = [], snapshotResolver) {
  return Array.from(groupBy(ledgerRows, (row) => row.category || 'Uncategorised').entries())
    .map(([category, rows]) => {
      const snapshot = snapshotResolver.sumValuesForRows(rows);
      const metrics = summarizeValueMovements(rows);
      const wastage = metrics.manualWastage + metrics.manufacturingWastage;
      const stockIn = metrics.purchases + metrics.transfersIn + metrics.manufacturingIn + metrics.positiveAdjustments;
      const stockOut = metrics.salesUsage + wastage + metrics.transfersOut + metrics.manufacturingOut + metrics.negativeAdjustments;
      const expectedClosing = calculateExpectedClosingValue(snapshot.openingValue, stockIn, stockOut);
      const variance = snapshot.hasActual ? snapshot.actualValue - expectedClosing : null;

      return {
        id: `operations-category:${category}`,
        category: category || 'Uncategorised',
        openingValue: snapshot.openingValue,
        purchases: metrics.purchases,
        salesUsage: metrics.salesUsage,
        wastage,
        manualWastage: metrics.manualWastage,
        manufacturingWastage: metrics.manufacturingWastage,
        adjustments: metrics.adjustments,
        transfersIn: metrics.transfersIn,
        transfersOut: metrics.transfersOut,
        manufacturingIn: metrics.manufacturingIn,
        manufacturingOut: metrics.manufacturingOut,
        expectedClosing,
        actualClosing: snapshot.hasActual ? snapshot.actualValue : null,
        variance,
        variancePercent: calculateValueVariancePercent(variance, expectedClosing),
        stockIn,
        stockOut,
        positiveAdjustments: metrics.positiveAdjustments,
        negativeAdjustments: metrics.negativeAdjustments,
        missingOpeningCount: snapshot.missingOpeningCount,
        missingActualCount: snapshot.missingActualCount,
        rowCount: rows.length,
        reportSummaryRow: true
      };
    });
}

function buildByItemRows(ledgerRows = [], snapshotResolver) {
  return Array.from(groupBy(ledgerRows, (row) => getItemGroupKey(row)).entries())
    .map(([itemKey, rows]) => {
      const first = rows[0] || {};
      const snapshot = snapshotResolver.sumQuantitiesForRows(rows);
      const metrics = summarizeQuantityMovements(rows);
      const stockInQty = metrics.purchasedQty + metrics.transferredInQty + metrics.manufacturedInQty + metrics.positiveAdjustedQty;
      const stockOutQty = metrics.soldUsedQty + metrics.wastedQty + metrics.transferredOutQty + metrics.manufacturedOutQty + metrics.negativeAdjustedQty;
      const expectedClosingQty = calculateExpectedClosingQty(snapshot.openingQty, stockInQty, stockOutQty);
      const actualClosingQty = snapshot.hasActual ? snapshot.actualQty : null;
      const varianceQty = snapshot.hasActual ? calculateVarianceQty(actualClosingQty, expectedClosingQty) : null;
      const unitCostExVat = resolveDisplayUnitCost(rows, snapshot.unitCost);

      return {
        id: `operations-item:${itemKey}`,
        itemId: first.itemId || '',
        itemName: first.itemName || 'Unknown Item',
        category: first.category || 'Uncategorised',
        baseUom: first.baseUom || first.unit || '',
        openingQty: snapshot.openingQty,
        purchasedQty: metrics.purchasedQty,
        soldUsedQty: metrics.soldUsedQty,
        wastedQty: metrics.wastedQty,
        adjustedQty: metrics.adjustedQty,
        transferredInQty: metrics.transferredInQty,
        transferredOutQty: metrics.transferredOutQty,
        manufacturedInQty: metrics.manufacturedInQty,
        manufacturedOutQty: metrics.manufacturedOutQty,
        expectedClosingQty,
        actualClosingQty,
        varianceQty,
        unitCostExVat,
        unitCost: unitCostExVat,
        varianceValue: varianceQty === null ? null : calculateVarianceValue(varianceQty, unitCostExVat),
        stockInQty,
        stockOutQty,
        positiveAdjustedQty: metrics.positiveAdjustedQty,
        negativeAdjustedQty: metrics.negativeAdjustedQty,
        missingOpeningCount: snapshot.missingOpeningCount,
        missingActualCount: snapshot.missingActualCount,
        rowCount: rows.length,
        reportSummaryRow: true
      };
    });
}

function summarizeValueMovements(rows = []) {
  const values = toArray(rows).reduce((metrics, row) => {
    const value = safeNumber(row.movementValue);
    const absValue = absoluteValue(value);
    if (isPurchase(row)) metrics.purchases += value;
    if (isSalesUsage(row)) metrics.salesUsage += absValue;
    if (isManufacturingIn(row)) metrics.manufacturingIn += value;
    if (isManufacturingOut(row)) metrics.manufacturingOut += absValue;
    if (isManufacturingWastage(row)) metrics.manufacturingWastage += absValue;
    if (isManualWastage(row)) metrics.manualWastage += absValue;
    if (isAdjustment(row)) {
      metrics.adjustments += value;
      if (value >= 0) metrics.positiveAdjustments += value;
      if (value < 0) metrics.negativeAdjustments += absValue;
    }
    if (isTransferIn(row)) metrics.transfersIn += absValue;
    if (isTransferOut(row)) metrics.transfersOut += absValue;
    return metrics;
  }, createValueMetrics());

  return values;
}

function summarizeQuantityMovements(rows = []) {
  return toArray(rows).reduce((metrics, row) => {
    const netQty = safeNumber(row.netQty);
    const absQty = absoluteValue(netQty);
    if (isPurchase(row)) metrics.purchasedQty += safeNumber(row.qtyIn) || absQty;
    if (isSalesUsage(row)) metrics.soldUsedQty += safeNumber(row.qtyOut) || absQty;
    if (isManualWastage(row) || isManufacturingWastage(row)) metrics.wastedQty += Math.abs(safeNumber(row.wastageQty)) || safeNumber(row.qtyOut) || absQty;
    if (isAdjustment(row)) {
      metrics.adjustedQty += netQty;
      if (netQty >= 0) metrics.positiveAdjustedQty += netQty;
      if (netQty < 0) metrics.negativeAdjustedQty += absQty;
    }
    if (isTransferIn(row)) metrics.transferredInQty += safeNumber(row.qtyIn) || absQty;
    if (isTransferOut(row)) metrics.transferredOutQty += safeNumber(row.qtyOut) || absQty;
    if (isManufacturingIn(row)) metrics.manufacturedInQty += safeNumber(row.qtyIn) || absQty;
    if (isManufacturingOut(row)) metrics.manufacturedOutQty += safeNumber(row.qtyOut) || absQty;
    return metrics;
  }, createQuantityMetrics());
}

function createValueMetrics() {
  return {
    purchases: 0,
    salesUsage: 0,
    manufacturingIn: 0,
    manufacturingOut: 0,
    manufacturingWastage: 0,
    manualWastage: 0,
    adjustments: 0,
    transfersIn: 0,
    transfersOut: 0,
    positiveAdjustments: 0,
    negativeAdjustments: 0
  };
}

function createQuantityMetrics() {
  return {
    purchasedQty: 0,
    soldUsedQty: 0,
    wastedQty: 0,
    adjustedQty: 0,
    transferredInQty: 0,
    transferredOutQty: 0,
    manufacturedInQty: 0,
    manufacturedOutQty: 0,
    positiveAdjustedQty: 0,
    negativeAdjustedQty: 0
  };
}

function getTotalsForView(view = 'overview', rows = []) {
  const reportRows = toArray(rows);
  if (view === 'movement_ledger') {
    return {
      qtyIn: sumBy(reportRows, 'qtyIn'),
      qtyOut: sumBy(reportRows, 'qtyOut'),
      netQty: sumBy(reportRows, 'netQty'),
      movementValue: sumBy(reportRows, 'movementValue')
    };
  }

  if (view === 'by_item') {
    return {
      openingQty: sumBy(reportRows, 'openingQty'),
      purchasedQty: sumBy(reportRows, 'purchasedQty'),
      soldUsedQty: sumBy(reportRows, 'soldUsedQty'),
      wastedQty: sumBy(reportRows, 'wastedQty'),
      adjustedQty: sumBy(reportRows, 'adjustedQty'),
      transferredInQty: sumBy(reportRows, 'transferredInQty'),
      transferredOutQty: sumBy(reportRows, 'transferredOutQty'),
      manufacturedInQty: sumBy(reportRows, 'manufacturedInQty'),
      manufacturedOutQty: sumBy(reportRows, 'manufacturedOutQty'),
      expectedClosingQty: sumBy(reportRows, 'expectedClosingQty'),
      actualClosingQty: sumBy(reportRows, 'actualClosingQty'),
      varianceQty: sumBy(reportRows, 'varianceQty'),
      varianceValue: sumBy(reportRows, 'varianceValue')
    };
  }

  if (view === 'by_category') {
    const expectedClosing = sumBy(reportRows, 'expectedClosing');
    const actualClosing = sumBy(reportRows, 'actualClosing');
    const variance = actualClosing - expectedClosing;
    return {
      openingValue: sumBy(reportRows, 'openingValue'),
      purchases: sumBy(reportRows, 'purchases'),
      salesUsage: sumBy(reportRows, 'salesUsage'),
      wastage: sumBy(reportRows, 'wastage'),
      adjustments: sumBy(reportRows, 'adjustments'),
      transfersIn: sumBy(reportRows, 'transfersIn'),
      transfersOut: sumBy(reportRows, 'transfersOut'),
      manufacturingIn: sumBy(reportRows, 'manufacturingIn'),
      manufacturingOut: sumBy(reportRows, 'manufacturingOut'),
      expectedClosing,
      actualClosing,
      variance,
      variancePercent: calculateValueVariancePercent(variance, expectedClosing)
    };
  }

  const expectedClosingValue = sumBy(reportRows, 'expectedClosingValue');
  const actualClosingValue = sumBy(reportRows, 'actualClosingValue');
  const varianceValue = actualClosingValue - expectedClosingValue;
  return {
    openingStockValue: sumBy(reportRows, 'openingStockValue'),
    purchases: sumBy(reportRows, 'purchases'),
    salesUsage: sumBy(reportRows, 'salesUsage'),
    manufacturingIn: sumBy(reportRows, 'manufacturingIn'),
    manufacturingOut: sumBy(reportRows, 'manufacturingOut'),
    manufacturingWastage: sumBy(reportRows, 'manufacturingWastage'),
    manualWastage: sumBy(reportRows, 'manualWastage'),
    adjustments: sumBy(reportRows, 'adjustments'),
    transfersIn: sumBy(reportRows, 'transfersIn'),
    transfersOut: sumBy(reportRows, 'transfersOut'),
    expectedClosingValue,
    actualClosingValue,
    varianceValue,
    netStockMovement: sumBy(reportRows, 'netStockMovement')
  };
}

function validateOperationsDashboardRows(rows = [], view = 'overview') {
  const reportRows = toArray(rows);
  if (!reportRows.length) {
    return [{ code: 'operations-dashboard-empty', level: 'info', message: 'No operations dashboard rows found for the selected filters.' }];
  }

  const meta = reportRows.find((row) => row.__meta)?.__meta || {};
  const ledgerRows = toArray(meta.ledgerRows);
  const summaryRows = view === 'movement_ledger' ? [] : reportRows;

  const apiWarnings = toArray(ledgerRows.find((row) => row.__apiWarnings)?.__apiWarnings);

  return [
    ...apiWarnings,
    countWarning(summaryRows, 'operations-missing-opening-stock-value', 'info', 'row(s) do not have opening stock snapshots yet. Opening/expected values are estimated from ledger movements until stock snapshots are added.', (row) => safeNumber(row.missingOpeningCount) > 0),
    countWarning(summaryRows, 'operations-missing-actual-closing-stock-value', 'info', 'row(s) do not have actual closing stock snapshots yet. Actual closing/variance columns show '-' until snapshots are available.', (row) => safeNumber(row.missingActualCount) > 0),
    countWarning(ledgerRows, 'operations-missing-item-name', 'critical', 'ledger row(s) are missing item names.', (row) => !text(row.itemName)),
    countWarning(ledgerRows, 'operations-missing-location-name', 'critical', 'ledger row(s) are missing location names.', (row) => !text(row.locationName)),
    countWarning(ledgerRows, 'operations-missing-category', 'warning', 'ledger row(s) are missing categories.', (row) => !text(row.category)),
    countWarning(ledgerRows, 'operations-missing-unit-cost', 'critical', 'ledger row(s) do not have a unit cost yet, so value columns may show R0 until item/location costs are loaded.', (row) => hasMovement(row) && safeNumber(row.unitCostExVat ?? row.unitCost) === 0),
    countWarning(ledgerRows, 'operations-missing-source-id', 'critical', 'ledger row(s) are missing source IDs.', (row) => !text(row.sourceId)),
    // Movement dates are generated by the system/ledger layer. Do not surface
    // missing-date issues as user-fixable row errors on the dashboard.
    countWarning(summaryRows, 'operations-variance-cannot-be-calculated', 'info', 'row(s) cannot calculate variance yet because actual closing stock snapshots are not available.', (row) => safeNumber(row.missingActualCount) > 0),
    countWarning(summaryRows, 'operations-expected-closing-value-does-not-reconcile', 'critical', 'row(s) have expected closing values that do not reconcile to Opening + Stock In - Stock Out.', expectedClosingMismatch),
    meta.hasManufacturingWastage && !meta.manufacturingWastageSeparate ? { code: 'operations-manufacturing-wastage-grouped', level: 'warning', message: 'Manufacturing wastage exists but is not separated from normal wastage.' } : null,
    meta.hasManualAdjustments && !meta.manualAdjustmentsIncluded ? { code: 'operations-manual-adjustments-missing', level: 'warning', message: 'Manual adjustments exist in the ledger but are not included in Operations Dashboard adjustments.' } : null,
    meta.hasTransfers && !meta.transfersSeparated ? { code: 'operations-transfers-not-separated', level: 'warning', message: 'Transfers exist in the ledger but Transfer In and Transfer Out are not separated.' } : null,
    meta.subRecipeDoubleCountingRisk ? { code: 'operations-sub-recipe-double-counting-risk', level: 'warning', message: `${meta.subRecipeDoubleCountingRisk} recipe-only sub-recipe ledger row(s) were detected and excluded from stock-on-hand summary calculations to avoid double-counting.` } : null,
    ...(view === 'overview' ? reconcileDetailedActivityToOperationsDashboard({ detailedRows: ledgerRows, operationsRows: summaryRows }) : [])
  ].filter(Boolean);
}

function buildOperationsMeta(ledgerRows = [], includedRows = [], snapshotResolver) {
  const hasManufacturingWastage = ledgerRows.some(isManufacturingWastage);
  const hasManualAdjustments = ledgerRows.some(isAdjustment);
  const hasTransferIn = ledgerRows.some(isTransferIn);
  const hasTransferOut = ledgerRows.some(isTransferOut);
  const subRecipeDoubleCountingRisk = ledgerRows.filter((row) => !isStockHoldingLedgerRow(row, snapshotResolver.dataSet)).length;
  const includedMetrics = summarizeValueMovements(includedRows);

  return {
    ledgerRows,
    includedRows,
    hasManufacturingWastage,
    manufacturingWastageSeparate: !hasManufacturingWastage || safeNumber(includedMetrics.manufacturingWastage) > 0,
    hasManualAdjustments,
    manualAdjustmentsIncluded: !hasManualAdjustments || safeNumber(includedMetrics.adjustments) !== 0 || includedRows.some(isAdjustment),
    hasTransfers: hasTransferIn || hasTransferOut,
    transfersSeparated: (!hasTransferIn || safeNumber(includedMetrics.transfersIn) > 0) && (!hasTransferOut || safeNumber(includedMetrics.transfersOut) > 0),
    subRecipeDoubleCountingRisk
  };
}

function expectedClosingMismatch(row = {}) {
  if (row.expectedClosingValue !== undefined) {
    const expected = calculateExpectedClosingValue(row.openingStockValue, row.stockIn, row.stockOut);
    return Math.abs(expected - safeNumber(row.expectedClosingValue)) > VALUE_TOLERANCE;
  }
  if (row.expectedClosing !== undefined) {
    const expected = calculateExpectedClosingValue(row.openingValue, row.stockIn, row.stockOut);
    return Math.abs(expected - safeNumber(row.expectedClosing)) > VALUE_TOLERANCE;
  }
  if (row.expectedClosingQty !== undefined) {
    const expected = calculateExpectedClosingQty(row.openingQty, row.stockInQty, row.stockOutQty);
    return Math.abs(expected - safeNumber(row.expectedClosingQty)) > QTY_TOLERANCE;
  }
  return false;
}

function countWarning(rows = [], code = '', level = 'warning', message = '', predicate = () => false) {
  return buildRowWarnings(rows, code, level, message, predicate);
}

function hasMovement(row = {}) {
  return safeNumber(row.qtyIn) !== 0 || safeNumber(row.qtyOut) !== 0 || safeNumber(row.netQty) !== 0;
}

function isPurchase(row = {}) {
  return ['grv', 'purchaseOrderReceive'].includes(text(row.sourceType)) || ['GRV', 'Purchase Order Receive'].includes(text(row.source));
}

function isSalesUsage(row = {}) {
  return ['saleUsage', 'modifierUsage'].includes(text(row.sourceType)) || ['Sale Usage', 'Modifier Usage'].includes(text(row.source));
}

function isManufacturingIn(row = {}) {
  return text(row.sourceType) === 'manufacturingIn' || text(row.source) === 'Manufacturing In';
}

function isManufacturingOut(row = {}) {
  return text(row.sourceType) === 'manufacturingOut' || text(row.source) === 'Manufacturing Out';
}

function isManufacturingWastage(row = {}) {
  return text(row.sourceType) === 'manufacturingWastage' || text(row.source) === 'Manufacturing Wastage';
}

function isManualWastage(row = {}) {
  const sourceType = text(row.sourceType);
  const source = text(row.source);
  return sourceType === 'wastage' || sourceType === 'manualWastage' || source === 'Wastage Adjustment' || source === 'Manual Wastage';
}

function isAdjustment(row = {}) {
  const sourceType = text(row.sourceType);
  const source = text(row.source);
  const movementType = text(row.movementType);
  return ['adjustment', 'stockTake', 'stockTakeCorrection', 'systemCorrection', 'manufacturingCorrection', 'SystemCorrection', 'StockTakeCorrection', 'ManufacturingCorrection'].includes(sourceType)
    || ['Manual Adjustment', 'Stock Take Variance', 'Stock Take Correction', 'System Correction', 'Manufacturing Correction'].includes(source)
    || /manual adjustment|stock take variance|stock take correction|system correction|manufacturing correction/i.test(movementType);
}

function isTransferIn(row = {}) {
  return text(row.source) === 'Transfer In' || text(row.movementType) === 'Transfer In';
}

function isTransferOut(row = {}) {
  return text(row.source) === 'Transfer Out' || text(row.movementType) === 'Transfer Out';
}

function buildDateRangeLabel(filters = {}, rows = []) {
  const startDate = text(filters.startDate || filters.dateFrom);
  const endDate = text(filters.endDate || filters.dateTo);
  if (startDate || endDate) return `${startDate || 'Start'} to ${endDate || 'Today'}`;
  const dates = toArray(rows).map((row) => text(row.date).slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return 'All Dates';
  const first = dates[0];
  const last = dates[dates.length - 1];
  return first === last ? first : `${first} to ${last}`;
}

function getItemGroupKey(row = {}) {
  return [row.itemId || row.itemName || 'unknown-item', row.category || 'uncategorised', row.baseUom || row.unit || ''].map(text).join('::');
}

function getItemLocationKey(row = {}) {
  return [row.itemId || row.itemName || 'unknown-item', row.locationId || row.locationName || 'unassigned'].map(text).join('::');
}

function createSnapshotResolver(ledgerRows = [], dataSet = {}) {
  const rowsByItemLocation = groupBy(ledgerRows, getItemLocationKey);
  const stockSnapshotLookup = buildStockSnapshotLookup(dataSet);

  function resolveForItemLocation(row = {}) {
    const key = getItemLocationKey(row);
    const rows = rowsByItemLocation.get(key) || [row];
    const first = rows[0] || row;
    const unitCost = resolveDisplayUnitCost(rows);
    const opening = resolveQuantitySnapshot('opening', first, rows, dataSet, stockSnapshotLookup);
    const actual = resolveQuantitySnapshot('actual', first, rows, dataSet, stockSnapshotLookup);
    return {
      key,
      itemId: first.itemId || '',
      itemName: first.itemName || '',
      locationId: first.locationId || '',
      locationName: first.locationName || '',
      unitCost,
      openingQty: opening.value,
      actualQty: actual.value,
      openingAvailable: opening.available,
      actualAvailable: actual.available,
      openingValue: calculateStockValue(opening.value, unitCost),
      actualValue: calculateStockValue(actual.value, unitCost)
    };
  }

  function uniqueSnapshotsForRows(rows = []) {
    const seen = new Set();
    return toArray(rows).reduce((snapshots, row) => {
      const key = getItemLocationKey(row);
      if (seen.has(key)) return snapshots;
      seen.add(key);
      snapshots.push(resolveForItemLocation(row));
      return snapshots;
    }, []);
  }

  return {
    dataSet,
    sumValuesForRows(rows = []) {
      const snapshots = uniqueSnapshotsForRows(rows);
      return {
        openingValue: sumBy(snapshots, 'openingValue'),
        actualValue: sumBy(snapshots, 'actualValue'),
        hasOpening: snapshots.every((snapshot) => snapshot.openingAvailable),
        hasActual: snapshots.every((snapshot) => snapshot.actualAvailable),
        missingOpeningCount: snapshots.filter((snapshot) => !snapshot.openingAvailable).length,
        missingActualCount: snapshots.filter((snapshot) => !snapshot.actualAvailable).length
      };
    },
    sumQuantitiesForRows(rows = []) {
      const snapshots = uniqueSnapshotsForRows(rows);
      return {
        openingQty: sumBy(snapshots, 'openingQty'),
        actualQty: sumBy(snapshots, 'actualQty'),
        unitCost: resolveDisplayUnitCost(rows),
        hasOpening: snapshots.every((snapshot) => snapshot.openingAvailable),
        hasActual: snapshots.every((snapshot) => snapshot.actualAvailable),
        missingOpeningCount: snapshots.filter((snapshot) => !snapshot.openingAvailable).length,
        missingActualCount: snapshots.filter((snapshot) => !snapshot.actualAvailable).length
      };
    }
  };
}

function resolveQuantitySnapshot(kind = 'opening', first = {}, rows = [], dataSet = {}, stockSnapshotLookup = new Map()) {
  const directRowValue = findFirstNumber(rows, kind === 'opening'
    ? ['openingQty', 'openingStockQty', 'opening_stock_qty', 'openingStock']
    : ['actualClosingQty', 'closingQty', 'currentStock', 'stockOnHand', 'onHandQty', 'countedQty']);
  if (directRowValue.available) return directRowValue;

  const stockItem = resolveStockItemFromDataSet(first, dataSet);
  const locationId = text(first.locationId);
  const snapshot = resolveStockSnapshotForItemLocation(first, stockSnapshotLookup);
  const snapshotValue = getQuantityFromObject(snapshot, kind === 'opening'
    ? ['openingQty', 'openingStockQty', 'opening_stock_qty', 'openingStock']
    : ['actualClosingQty', 'closingQty', 'currentStock', 'stockOnHand', 'onHandQty', 'countedQty']);
  if (snapshotValue.available) return snapshotValue;

  const locationStockValue = getLocationStockQuantity(stockItem, locationId, kind);
  if (locationStockValue.available) return locationStockValue;

  const itemValue = getQuantityFromObject(stockItem, kind === 'opening'
    ? ['openingQty', 'openingStockQty', 'opening_stock_qty', 'openingStock']
    : ['actualClosingQty', 'closingQty', 'currentStock', 'stockOnHand', 'onHandQty', 'countedQty']);
  if (itemValue.available && (!locationId || toArray(dataSet.locations).length <= 1)) return itemValue;

  if (kind === 'actual') {
    const stockTakeValue = getLatestStockTakeCount(rows);
    if (stockTakeValue.available) return stockTakeValue;
  }

  return { value: 0, available: false };
}

function buildStockSnapshotLookup(dataSet = {}) {
  const snapshots = [
    ...toArray(dataSet.stockSnapshots),
    ...toArray(dataSet.openingStockSnapshots),
    ...toArray(dataSet.closingStockSnapshots),
    ...toArray(dataSet.source?.stockSnapshots),
    ...toArray(dataSet.source?.openingStockSnapshots),
    ...toArray(dataSet.source?.closingStockSnapshots)
  ];
  return snapshots.reduce((lookup, snapshot) => {
    const itemId = text(snapshot.itemId || snapshot.stockItemId || snapshot.productId);
    const itemName = text(snapshot.itemName || snapshot.stockItemName || snapshot.name);
    const locationId = text(snapshot.locationId || snapshot.location_id);
    const key = [itemId || itemName || 'unknown-item', locationId || snapshot.locationName || 'unassigned'].map(text).join('::');
    if (!lookup.has(key)) lookup.set(key, snapshot);
    return lookup;
  }, new Map());
}

function resolveStockSnapshotForItemLocation(row = {}, lookup = new Map()) {
  const keys = [
    [row.itemId, row.locationId],
    [row.itemName, row.locationId],
    [row.itemId, row.locationName],
    [row.itemName, row.locationName]
  ];
  return keys.map((parts) => parts.map((part) => text(part) || 'unassigned').join('::')).map((key) => lookup.get(key)).find(Boolean) || null;
}

function getLocationStockQuantity(stockItem = {}, locationId = '', kind = 'opening') {
  const locationStocks = [
    ...toArray(stockItem?.locationStocks),
    ...toArray(stockItem?.locations),
    ...toArray(stockItem?.stockByLocation),
    ...toArray(stockItem?.locationStock)
  ];
  const locationStock = locationStocks.find((entry) => text(entry.locationId || entry.location_id || entry.id || entry.location) === text(locationId));
  return getQuantityFromObject(locationStock, kind === 'opening'
    ? ['openingQty', 'openingStockQty', 'opening_stock_qty', 'openingStock']
    : ['actualClosingQty', 'closingQty', 'currentStock', 'stockOnHand', 'onHandQty', 'countedQty']);
}

function getLatestStockTakeCount(rows = []) {
  const stockTakeRows = toArray(rows)
    .filter((row) => isAdjustment(row) && row.countedQty !== undefined)
    .sort((left, right) => text(right.timestamp || right.date).localeCompare(text(left.timestamp || left.date)));
  return getQuantityFromObject(stockTakeRows[0], ['countedQty', 'actualClosingQty', 'closingQty']);
}

function findFirstNumber(rows = [], keys = []) {
  for (const row of toArray(rows)) {
    const value = getQuantityFromObject(row, keys);
    if (value.available) return value;
  }
  return { value: 0, available: false };
}

function getQuantityFromObject(object = {}, keys = []) {
  if (!object) return { value: 0, available: false };
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && text(object[key]) !== '') {
      return { value: safeNumber(object[key]), available: true };
    }
  }
  return { value: 0, available: false };
}

function resolveDisplayUnitCost(rows = [], fallback = 0) {
  const rowList = toArray(rows);
  const firstPositive = rowList.map((row) => safeNumber(row.unitCostExVat ?? row.unitCost)).find((value) => value > 0);
  return firstPositive || safeNumber(fallback);
}

function resolveStockItemFromDataSet(row = {}, dataSet = {}) {
  const itemId = text(row.itemId || row.stockItemId || row.productId);
  const itemName = text(row.itemName || row.stockItemName || row.productName).toLowerCase();
  return toArray(dataSet.stockItems).find((item) => {
    const candidateId = text(item.id || item.stockItemId || item.itemId || item.productId);
    const candidateName = text(item.name || item.itemName || item.stockItemName || item.productName).toLowerCase();
    return (itemId && candidateId === itemId) || (itemName && candidateName === itemName);
  }) || null;
}

function isStockHoldingLedgerRow(row = {}, dataSet = {}) {
  const stockItem = resolveStockItemFromDataSet(row, dataSet) || {};
  const flags = { ...stockItem, ...row.rawSourceRow, ...row };
  const itemType = text(flags.type || flags.itemType || flags.stockItemType || flags.stock_type || flags.tag).toLowerCase();
  const isSubRecipe = Boolean(flags.isSubRecipe || flags.is_sub_recipe || itemType.includes('sub-recipe') || itemType.includes('sub recipe'));
  const recipeOnly = Boolean(flags.isRecipeOnly || flags.recipeOnly || flags.is_recipe_only || flags.allowStockOnHand === false);
  const explicitlyNotStockHolding = flags.trackInventory === false || flags.track_inventory === false || flags.isStockHolding === false || flags.stockHolding === false || flags.stockOnHandEnabled === false;
  return !(isSubRecipe && (recipeOnly || explicitlyNotStockHolding));
}

function withMeta(row = {}, meta = {}) {
  return { ...row, __meta: meta };
}

function expectedClosingValueTooltip(row = {}) {
  const opening = row.openingStockValue ?? row.openingValue;
  const expected = row.expectedClosingValue ?? row.expectedClosing;
  return buildRowFormulaTooltip('expectedClosingValue', `${formatRaw(expected)} = ${formatRaw(opening)} + ${formatRaw(row.stockIn)} - ${formatRaw(row.stockOut)}`);
}

function varianceValueTooltip(row = {}) {
  const actual = row.actualClosingValue ?? row.actualClosing;
  const expected = row.expectedClosingValue ?? row.expectedClosing;
  const variance = row.varianceValue ?? row.variance;
  return buildRowFormulaTooltip('operationsVarianceValue', `${formatRaw(variance)} = ${formatRaw(actual)} - ${formatRaw(expected)}`);
}

function netStockMovementTooltip(row = {}) {
  return buildRowFormulaTooltip('netStockMovement', `${formatRaw(row.netStockMovement)} = ${formatRaw(row.stockIn)} - ${formatRaw(row.stockOut)}`);
}

function expectedClosingQtyTooltip(row = {}) {
  return buildRowFormulaTooltip('expectedClosingQty', `${formatRaw(row.expectedClosingQty)} = ${formatRaw(row.openingQty)} + ${formatRaw(row.stockInQty)} - ${formatRaw(row.stockOutQty)}`);
}

function varianceQtyTooltip(row = {}) {
  return buildRowFormulaTooltip('operationsVarianceQty', `${formatRaw(row.varianceQty)} = ${formatRaw(row.actualClosingQty)} - ${formatRaw(row.expectedClosingQty)}`);
}

function variancePercentTooltip(row = {}) {
  const variance = row.variance ?? row.varianceValue;
  const expected = row.expectedClosing ?? row.expectedClosingValue;
  return buildRowFormulaTooltip('variancePercent', `${formatRaw(row.variancePercent)} = ${formatRaw(variance)} / ${formatRaw(expected)}`);
}

function formatRaw(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Number(numeric.toFixed(2))) : String(value ?? 0);
}

export default operationsDashboardReport;
