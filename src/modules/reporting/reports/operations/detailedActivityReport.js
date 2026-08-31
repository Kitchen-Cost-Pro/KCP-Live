import { roundMoney, safeNumber } from '../../engine/calculations.js';
import { applyReportFilters, sumBy, text, toArray } from '../../engine/grouping.js';
import { buildRowWarnings } from '../../validators/rowWarningUtils.js';
import { buildStockLedger, finalizeLedgerRows } from '../../engine/stockLedgerMapper.js';
import { fetchDetailedActivityLedger } from '../../api/reportingApi.js';
import { isReportingMockDataEnabled } from '../../api/reportingEndpoints.js';

const MOVEMENT_VALUE_TOLERANCE = 0.01;

const ledgerColumns = [
  { key: 'date', label: 'Date', type: 'date', width: '110px', sortable: true },
  { key: 'time', label: 'Time', type: 'time', width: '90px', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'movementType', label: 'Movement Type', tooltipKey: 'movementDirection', sortable: true },
  { key: 'openingBalance', label: 'Opening Balance', type: 'number', align: 'right', tooltipKey: 'openingBalance', sortable: true },
  { key: 'source', label: 'Source', tooltipKey: 'source', sortable: true },
  { key: 'documentNumber', label: 'Document Number', sortable: true },
  { key: 'qtyIn', label: 'Qty In', type: 'number', align: 'right', sortable: true },
  { key: 'qtyOut', label: 'Qty Out', type: 'number', align: 'right', sortable: true },
  { key: 'netQty', label: 'Net Qty', type: 'number', align: 'right', tooltipKey: 'netMovement', sortable: true },
  { key: 'closingBalance', label: 'Closing Balance', type: 'number', align: 'right', tooltipKey: 'closingBalance', sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', tooltipKey: 'unitCostExVat', sortable: true },
  { key: 'movementValue', label: 'Movement Value', type: 'money', align: 'right', tooltipKey: 'movementValue', sortable: true },
  { key: 'runningQty', label: 'Running Qty', type: 'number', align: 'right', tooltipKey: 'runningQty', sortable: true },
  { key: 'runningValue', label: 'Running Value', type: 'money', align: 'right', tooltipKey: 'runningValue', sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'notes', label: 'Notes' },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

export const detailedActivityReport = {
  id: 'detailed_activity',
  title: 'Detailed Activity',
  section: 'operations',
  description: 'Full stock movement ledger showing every inventory event: opening/closing balance per movement, and why each movement type increases or decreases stock.',
  emptyState: { title: 'No stock activity found', message: 'No stock activity found for this period.' },
  defaultView: 'ledger',
  availableViews: ['ledger'],
  filterConfig: {
    ledger: ['search', 'dateRange', 'time', 'location', 'category', 'source']
  },

  columns: {
    ledger: ledgerColumns
  },

  exportColumns: {
    ledger: ledgerColumns
  },

  getRows: async ({ workspaceId, filters, services = {}, dataSet = {} }) => {
    const response = await loadDetailedActivityLedger({ workspaceId, filters, services, dataSet });
    const ledgerRows = finalizeLedgerRows(response.rows).map((row) => ({
      ...row,
      ...deriveBalanceColumns(row),
      __apiWarnings: response.warnings || [],
      __apiMeta: response.meta || {}
    }));
    return applyReportFilters(ledgerRows, filters);
  },

  getTotals: ({ rows }) => ({
    qtyIn: sumBy(rows, 'qtyIn'),
    qtyOut: sumBy(rows, 'qtyOut'),
    netQty: sumBy(rows, 'netQty'),
    movementValue: sumBy(rows, 'movementValue')
  }),

  // Totals for openingBalance/closingBalance are deliberately omitted from getTotals: they are
  // running per-item/location balances, not additive quantities, so summing them across rows for
  // different items (or different points in the same item's timeline) would not mean anything.

  validate: ({ rows, services }) => validateDetailedActivityRows(rows, services),

  exportMapping: {
    ledger: {
      date: 'Date',
      time: 'Time',
      locationName: 'Location',
      itemName: 'Item',
      category: 'Category',
      movementType: 'Movement Type',
      openingBalance: 'Opening Balance',
      source: 'Source',
      documentNumber: 'Document Number',
      qtyIn: 'Qty In',
      qtyOut: 'Qty Out',
      netQty: 'Net Qty',
      closingBalance: 'Closing Balance',
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

// Closing Balance is the same figure as Running Qty (the balance for this item/location immediately
// after this movement) — Opening Balance is simply that minus this row's own Net Qty. Both stay null
// (not a fabricated 0) whenever Running Qty itself is unavailable (see addRunningBalances in
// stockLedgerMapper.js), matching how the rest of the report treats unresolved balances.
function deriveBalanceColumns(row = {}) {
  const closingBalance = row.runningQty === null || row.runningQty === undefined ? null : safeNumber(row.runningQty);
  const openingBalance = closingBalance === null ? null : roundMoney(closingBalance - safeNumber(row.netQty), 3);
  return {
    openingBalance,
    closingBalance: closingBalance === null ? null : roundMoney(closingBalance, 3)
  };
}


async function loadDetailedActivityLedger({ workspaceId, filters, services = {}, dataSet = {} }) {
  if (services.reporting?.getDetailedActivityLedger) {
    const response = normalizeLedgerResponse(await services.reporting.getDetailedActivityLedger({ workspaceId, filters }), { dataSource: 'real' });
    rememberDetailedActivityResponse(services, response);
    return response;
  }

  if (services.reporting?.getDetailedActivityRows) {
    const rows = await services.reporting.getDetailedActivityRows({ workspaceId, filters });
    const response = normalizeLedgerResponse(rows, { dataSource: 'real' });
    rememberDetailedActivityResponse(services, response);
    return response;
  }

  if (isReportingMockDataEnabled(services)) {
    const response = {
      rows: buildStockLedger(dataSet),
      warnings: [{ code: 'reporting-dev-mock-data', level: 'info', message: 'Using mock reporting data because VITE_REPORTING_USE_MOCK_DATA=true.' }],
      meta: { dataSource: 'mock', workspaceId, generatedAt: new Date().toISOString() }
    };
    rememberDetailedActivityResponse(services, response);
    return response;
  }

  const response = await fetchDetailedActivityLedger({ workspaceId, filters });
  rememberDetailedActivityResponse(services, response);
  return response;
}


function rememberDetailedActivityResponse(services = {}, response = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastDetailedActivityLedger = response;
  services.reporting.__lastDetailedActivityWarnings = toArray(response.warnings);
  services.reporting.__lastDetailedActivityMeta = response.meta || {};
}

function normalizeLedgerResponse(response, fallbackMeta = {}) {
  const meta = Array.isArray(response) ? fallbackMeta : { ...fallbackMeta, ...(response?.meta || {}) };
  const rows = (Array.isArray(response) ? response : toArray(response?.rows)).map((row) => ({
    ...(text(meta.dataSource) === 'real' ? { __fromReportingApi: true } : {}),
    __apiMeta: meta,
    ...row
  }));
  return {
    rows,
    warnings: Array.isArray(response) ? [] : toArray(response?.warnings),
    meta
  };
}

export function validateDetailedActivityRows(rows = [], services = {}) {
  const reportRows = toArray(rows);
  const apiWarnings = toArray(reportRows.find((row) => row.__apiWarnings)?.__apiWarnings || services?.reporting?.__lastDetailedActivityWarnings);
  if (!reportRows.length) {
    return [
      ...apiWarnings,
      { code: 'detailed-activity-empty', level: 'info', message: 'No stock activity found for this period.' }
    ];
  }

  return [
    ...apiWarnings,
    countWarning(reportRows, 'detailed-missing-item-name', 'critical', 'row(s) are missing item names.', (row) => !text(row.itemName)),
    countWarning(reportRows, 'detailed-missing-location-name', 'critical', 'row(s) are missing location names.', (row) => !text(row.locationName)),
    countWarning(reportRows, 'detailed-missing-unit-cost', 'critical', 'row(s) do not have a unit cost yet, so value columns may show R0 until item/location costs are loaded.', isMissingUnitCostAdvisory),
    countWarning(reportRows, 'detailed-missing-source-id', 'critical', 'row(s) are missing source IDs.', (row) => !text(row.sourceId)),
    countWarning(reportRows, 'detailed-qty-in-out-both-populated', 'critical', 'row(s) have both Qty In and Qty Out populated.', (row) => safeNumber(row.qtyIn) > 0 && safeNumber(row.qtyOut) > 0),
    countWarning(reportRows, 'detailed-zero-movement-qty', 'critical', 'row(s) have both Qty In and Qty Out as zero.', (row) => safeNumber(row.qtyIn) === 0 && safeNumber(row.qtyOut) === 0 && !isAccountingOnlyWastage(row)),
    countWarning(reportRows, 'detailed-movement-value-mismatch', 'critical', 'row(s) have Movement Value values that do not match Net Qty x Unit Cost Ex VAT.', movementValueMismatch)
  ].filter(Boolean);
}

function countWarning(rows = [], code = '', level = 'warning', message = '', predicate = () => false) {
  return buildRowWarnings(rows, code, level, message, predicate);
}

function hasMovement(row = {}) {
  return safeNumber(row.qtyIn) !== 0 || safeNumber(row.qtyOut) !== 0 || safeNumber(row.netQty) !== 0;
}


function isMissingUnitCostAdvisory(row = {}) {
  return hasMovement(row) && safeNumber(row.unitCostExVat ?? row.unitCost) === 0;
}

function movementValueMismatch(row = {}) {
  if (isAccountingOnlyWastage(row)) return false;
  const unitCost = safeNumber(row.unitCostExVat ?? row.unitCost);
  const actual = safeNumber(row.movementValue);
  if (unitCost === 0 && actual === 0) return false;
  const expected = safeNumber(row.netQty) * unitCost;
  return Math.abs(actual - expected) > MOVEMENT_VALUE_TOLERANCE;
}

function isAccountingOnlyWastage(row = {}) {
  const source = text(row.source || row.sourceType || row.movementType).toLowerCase();
  const isWastage = source.includes('wastage') || source.includes('waste');
  return isWastage && (row.accountingOnly === true || safeNumber(row.wastageQty) > 0);
}

export default detailedActivityReport;
