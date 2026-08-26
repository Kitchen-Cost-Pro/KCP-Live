import { absoluteValue, safeNumber } from '../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../engine/grouping.js';

// Stock-ledger value tolerance — intentionally separate from the money-reconciliation
// CENT_TOLERANCE/PAYOUT_TOLERANCE constants in engine/yocoFinancials.js, which cover
// Yoco sale/refund totals, not stock movement values.
const VALUE_TOLERANCE = 0.01;
const QTY_TOLERANCE = 0.0001;

export const RECONCILIATION_SOURCE_GROUPS = {
  purchases: ['GRV', 'Purchase Order Receive'],
  salesUsage: ['Sale Usage', 'Modifier Usage'],
  manufacturingIn: ['Manufacturing In'],
  manufacturingOut: ['Manufacturing Out'],
  manufacturingWastage: ['Manufacturing Wastage'],
  manualWastage: ['Wastage Adjustment', 'Manual Wastage'],
  adjustments: ['Manual Adjustment', 'Stock Take Variance', 'Stock Take Correction', 'System Correction', 'Manufacturing Correction'],
  wastage: ['Wastage Adjustment', 'Manual Wastage', 'Manufacturing Wastage', 'Recipe Wastage'],
  stockTakeVariance: ['Stock Take Variance'],
  transfersIn: ['Transfer In'],
  transfersOut: ['Transfer Out'],
  transfers: ['Transfer In', 'Transfer Out']
};

export function summarizeDetailedActivityForReconciliation(rows = []) {
  const ledgerRows = toArray(rows);
  return {
    netMovementValue: sumBy(ledgerRows, 'movementValue'),
    purchases: sumMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.purchases),
    salesUsage: sumAbsMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.salesUsage),
    manufacturingIn: sumMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.manufacturingIn),
    manufacturingOut: sumAbsMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.manufacturingOut),
    manufacturingWastage: sumAbsMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.manufacturingWastage),
    manualWastage: sumAbsMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.manualWastage),
    adjustments: sumMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.adjustments),
    transfersIn: sumAbsMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.transfersIn),
    transfersOut: sumAbsMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.transfersOut),
    wastageValue: sumWastageValueFromDetailedActivity(ledgerRows),
    adjustmentValue: sumMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.adjustments),
    transferMovementValue: sumMovementValueForSources(ledgerRows, RECONCILIATION_SOURCE_GROUPS.transfers)
  };
}

export function reconcileDetailedActivityToOperationsDashboard({ detailedRows = [], operationsRows = [], operationsTotals = null } = {}) {
  const ledger = summarizeDetailedActivityForReconciliation(detailedRows);
  const ops = operationsTotals || sumOperationsRows(operationsRows);
  return [
    valueWarning('reconcile-ops-net-stock-movement', 'Detailed Activity total movement value does not reconcile to Operations Dashboard net stock movement.', ledger.netMovementValue, ops.netStockMovement),
    valueWarning('reconcile-ops-purchases', 'Operations Dashboard Purchases does not reconcile to Detailed Activity GRV / Purchase Order Receive rows.', ledger.purchases, ops.purchases),
    valueWarning('reconcile-ops-sales-usage', 'Operations Dashboard Sales Usage does not reconcile to Detailed Activity Sale Usage / Modifier Usage rows.', ledger.salesUsage, ops.salesUsage),
    valueWarning('reconcile-ops-manufacturing-in', 'Operations Dashboard Manufacturing In does not reconcile to Detailed Activity Manufacturing In rows.', ledger.manufacturingIn, ops.manufacturingIn),
    valueWarning('reconcile-ops-manufacturing-out', 'Operations Dashboard Manufacturing Out does not reconcile to Detailed Activity Manufacturing Out rows.', ledger.manufacturingOut, ops.manufacturingOut),
    valueWarning('reconcile-ops-manufacturing-wastage', 'Operations Dashboard Manufacturing Wastage does not reconcile to Detailed Activity Manufacturing Wastage rows.', ledger.manufacturingWastage, ops.manufacturingWastage),
    valueWarning('reconcile-ops-manual-wastage', 'Operations Dashboard Manual Wastage does not reconcile to Detailed Activity Wastage Adjustment / Manual Wastage rows.', ledger.manualWastage, ops.manualWastage),
    valueWarning('reconcile-ops-adjustments', 'Operations Dashboard Adjustments does not reconcile to Detailed Activity adjustment rows.', ledger.adjustments, ops.adjustments),
    valueWarning('reconcile-ops-transfers-in', 'Operations Dashboard Transfers In does not reconcile to Detailed Activity Transfer In rows.', ledger.transfersIn, ops.transfersIn),
    valueWarning('reconcile-ops-transfers-out', 'Operations Dashboard Transfers Out does not reconcile to Detailed Activity Transfer Out rows.', ledger.transfersOut, ops.transfersOut)
  ].filter(Boolean);
}

export function reconcileWastageToDetailedActivity({ wastageRows = [], detailedRows = [], wastageTotals = null } = {}) {
  const wastageValue = wastageTotals?.wastageValue ?? sumBy(wastageRows, (row) => row.wastageValue ?? absoluteValue(row.movementValue));
  const detailedValue = sumWastageValueFromDetailedActivity(detailedRows);
  return [
    valueWarning('reconcile-wastage-detailed-activity', 'Wastage Report total does not reconcile to Detailed Activity wastage rows.', detailedValue, wastageValue)
  ].filter(Boolean);
}

export function reconcileStockTakeAuditToDetailedActivity({ stockTakeRows = [], detailedRows = [] } = {}) {
  const reportRows = toArray(stockTakeRows);
  const varianceRows = detailedRowsForSources(detailedRows, RECONCILIATION_SOURCE_GROUPS.stockTakeVariance);
  const warnings = [
    valueWarning('reconcile-stocktake-variance-value', 'Stock Take Audit variance value does not reconcile to Detailed Activity Stock Take Variance rows.', sumBy(varianceRows, 'movementValue'), sumBy(reportRows, (row) => row.movementValue ?? row.varianceValue)),
    qtyWarning('reconcile-stocktake-variance-qty', 'Stock Take Audit variance quantity does not reconcile to Detailed Activity Stock Take Variance rows.', sumBy(varianceRows, 'netQty'), sumBy(reportRows, (row) => row.netQty ?? row.varianceQty ?? row.varianceBaseQty))
  ].filter(Boolean);

  const badDirections = reportRows.filter((row) => {
    const netQty = safeNumber(row.netQty ?? row.varianceQty ?? row.varianceBaseQty);
    if (netQty > QTY_TOLERANCE) return safeNumber(row.qtyIn) <= 0 && row.qtyIn !== undefined;
    if (netQty < -QTY_TOLERANCE) return safeNumber(row.qtyOut) <= 0 && row.qtyOut !== undefined;
    return false;
  });
  if (badDirections.length) {
    warnings.push({ code: 'reconcile-stocktake-variance-direction', level: 'critical', message: `${badDirections.length} committed stock take variance row(s) have incorrect Qty In / Qty Out direction.` });
  }
  return warnings;
}

export function reconcileAdjustmentsToDetailedActivity({ adjustmentRows = [], detailedRows = [], adjustmentTotals = null } = {}) {
  const detailedAdjustmentValue = sumMovementValueForSources(detailedRows, [
    ...RECONCILIATION_SOURCE_GROUPS.adjustments,
    'Wastage Adjustment',
    'Manual Wastage'
  ]);
  const adjustmentValue = adjustmentTotals?.valueImpact ?? sumBy(adjustmentRows, (row) => row.valueImpact ?? row.movementValue);
  return [
    valueWarning('reconcile-adjustments-detailed-activity', 'Adjustments Report value impact does not reconcile to Detailed Activity adjustment rows.', detailedAdjustmentValue, adjustmentValue)
  ].filter(Boolean);
}

export function reconcileStockTransfersToDetailedActivity({ transferRows = [], detailedRows = [], transferTotals = null } = {}) {
  const detailedTransferRows = detailedRowsForSources(detailedRows, RECONCILIATION_SOURCE_GROUPS.transfers);
  const reportRows = toArray(transferRows);
  const warnings = [
    valueWarning('reconcile-transfers-movement-value', 'Stock Transfers Report movement value does not reconcile to Detailed Activity Transfer In / Transfer Out rows.', sumBy(detailedTransferRows, 'movementValue'), transferTotals?.movementValue ?? sumBy(reportRows, 'movementValue')),
    qtyWarning('reconcile-transfers-net-qty', 'Stock Transfers Report net quantity does not reconcile to Detailed Activity Transfer In / Transfer Out rows.', sumBy(detailedTransferRows, 'netQty'), transferTotals?.netQty ?? sumBy(reportRows, 'netQty')),
    ...validateCommittedTransferPairs(detailedTransferRows)
  ].filter(Boolean);
  return warnings;
}

export function validateCommittedTransferPairs(rows = []) {
  const warnings = [];
  Array.from(groupBy(toArray(rows), getTransferPairKey).entries()).forEach(([key, groupRows]) => {
    const rowsWithSourceId = groupRows.filter((row) => text(row.sourceId));
    if (!rowsWithSourceId.length) return;
    const inRows = groupRows.filter(isTransferIn);
    const outRows = groupRows.filter(isTransferOut);
    const first = groupRows[0] || {};
    const label = text(first.documentNumber || first.transferNumber || first.sourceId || key);
    const isExternal = groupRows.some((row) => isExternalTransferRow(row));
    if (!isExternal && outRows.length && !inRows.length) warnings.push({ code: 'reconcile-transfer-out-without-in', level: 'critical', message: `Transfer Out exists without matching Transfer In for ${label} / ${first.itemName || 'unknown item'}.` });
    if (!isExternal && inRows.length && !outRows.length) warnings.push({ code: 'reconcile-transfer-in-without-out', level: 'critical', message: `Transfer In exists without matching Transfer Out for ${label} / ${first.itemName || 'unknown item'}.` });
    if (inRows.length && outRows.length) {
      const inQty = sumBy(inRows, (row) => safeNumber(row.qtyIn) || absoluteValue(row.netQty));
      const outQty = sumBy(outRows, (row) => safeNumber(row.qtyOut) || absoluteValue(row.netQty));
      const inValue = sumBy(inRows, (row) => absoluteValue(row.movementValue));
      const outValue = sumBy(outRows, (row) => absoluteValue(row.movementValue));
      if (Math.abs(inQty - outQty) > QTY_TOLERANCE) warnings.push({ code: 'reconcile-transfer-qty-mismatch', level: 'critical', message: `Transfer In and Transfer Out quantities do not match for ${label} / ${first.itemName || 'unknown item'}.` });
      if (Math.abs(inValue - outValue) > VALUE_TOLERANCE) warnings.push({ code: 'reconcile-transfer-value-mismatch', level: 'critical', message: `Transfer In and Transfer Out values do not match for ${label} / ${first.itemName || 'unknown item'}.` });
    }
  });
  return warnings;
}

export function detailedRowsForSources(rows = [], sources = []) {
  const sourceSet = new Set(toArray(sources).map(normalizeSource));
  return toArray(rows).filter((row) => sourceSet.has(resolveSourceKey(row)));
}

export function sumMovementValueForSources(rows = [], sources = []) {
  return sumBy(detailedRowsForSources(rows, sources), 'movementValue');
}

export function sumAbsMovementValueForSources(rows = [], sources = []) {
  return sumBy(detailedRowsForSources(rows, sources), (row) => absoluteValue(row.movementValue));
}

function sumWastageValueFromDetailedActivity(rows = []) {
  return sumBy(toArray(rows).filter(isDetailedWastageRow), (row) => absoluteValue(row.movementValue));
}

function isDetailedWastageRow(row = {}) {
  const source = resolveSourceKey(row);
  if (source === 'sale usage' || source === 'modifier usage') return false;
  if (source === 'manufacturing out') return false;
  if (['wastage adjustment', 'manual wastage', 'manufacturing wastage', 'recipe wastage'].includes(source)) return true;
  return source === 'stock take variance' && safeNumber(row.qtyOut) > 0;
}

function sumOperationsRows(rows = []) {
  return {
    netStockMovement: sumBy(rows, 'netStockMovement'),
    purchases: sumBy(rows, 'purchases'),
    salesUsage: sumBy(rows, 'salesUsage'),
    manufacturingIn: sumBy(rows, 'manufacturingIn'),
    manufacturingOut: sumBy(rows, 'manufacturingOut'),
    manufacturingWastage: sumBy(rows, 'manufacturingWastage'),
    manualWastage: sumBy(rows, 'manualWastage'),
    adjustments: sumBy(rows, 'adjustments'),
    transfersIn: sumBy(rows, 'transfersIn'),
    transfersOut: sumBy(rows, 'transfersOut')
  };
}

function valueWarning(code = '', message = '', expected = 0, actual = 0) {
  return Math.abs(safeNumber(expected) - safeNumber(actual)) > VALUE_TOLERANCE
    ? { code, level: 'critical', message: `${message} Expected ${safeNumber(expected).toFixed(2)}, got ${safeNumber(actual).toFixed(2)}.` }
    : null;
}

function qtyWarning(code = '', message = '', expected = 0, actual = 0) {
  return Math.abs(safeNumber(expected) - safeNumber(actual)) > QTY_TOLERANCE
    ? { code, level: 'critical', message: `${message} Expected ${safeNumber(expected)}, got ${safeNumber(actual)}.` }
    : null;
}

function resolveSourceKey(row = {}) {
  return normalizeSource(row.source || row.sourceType || row.movementType);
}

function normalizeSource(value = '') {
  return text(value).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').toLowerCase();
}

function isExternalTransferRow(row = {}) {
  const value = normalizeSource(row.transferType || row.transferScope || row.transfer_type || row.transfer_scope);
  return value === 'external' || value === 'cross workspace';
}

function isTransferIn(row = {}) {
  return resolveSourceKey(row) === 'transfer in' || text(row.direction) === 'Transfer In';
}

function isTransferOut(row = {}) {
  return resolveSourceKey(row) === 'transfer out' || text(row.direction) === 'Transfer Out';
}

function getTransferPairKey(row = {}) {
  return [row.sourceId || row.documentNumber || row.transferNumber, row.itemId || row.itemName].map(text).join('|');
}
