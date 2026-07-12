import { absoluteValue, calculateStockValue, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { buildRowWarnings } from '../../validators/rowWarningUtils.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';
import { reconcileWastageToDetailedActivity } from '../../validators/reconciliationChecks.js';
import { detailedActivityReport } from './detailedActivityReport.js';

const VALUE_TOLERANCE = 0.01;
const WASTAGE_REASON_PATTERN = /(wast|waste|loss|lost|spoil|spoilage|break|broken|damage|damaged|expired|burnt|burned|dropped|discard)/i;

const summaryColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'qtyWasted', label: 'Total Qty Wasted', type: 'number', align: 'right', tooltipKey: 'qtyWasted', cellTooltip: qtyWastedTooltip, sortable: true },
  { key: 'wastageValue', label: 'Total Wastage Value', type: 'money', align: 'right', tooltipKey: 'wastageValue', cellTooltip: wastageValueTooltip, sortable: true },
  { key: 'eventCount', label: 'Wastage Events', type: 'number', align: 'right', sortable: true },
  { key: 'topWastageSource', label: 'Top Wastage Source', sortable: true },
  { key: 'topWastedItem', label: 'Top Wasted Item', sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true }
];

const bySourceColumns = [
  { key: 'wastageSource', label: 'Wastage Source', sortable: true },
  { key: 'qtyWasted', label: 'Qty Wasted', type: 'number', align: 'right', tooltipKey: 'qtyWasted', cellTooltip: qtyWastedTooltip, sortable: true },
  { key: 'wastageValue', label: 'Wastage Value', type: 'money', align: 'right', tooltipKey: 'wastageValue', cellTooltip: wastageValueTooltip, sortable: true },
  { key: 'percentOfTotalWastage', label: '% of Total Wastage', type: 'percent', align: 'right', tooltipKey: 'percentOfTotalWastage', cellTooltip: percentOfTotalTooltip, sortable: true },
  { key: 'eventCount', label: 'Event Count', type: 'number', align: 'right', sortable: true }
];

const byCategoryColumns = [
  { key: 'category', label: 'Category', sortable: true },
  { key: 'qtyWasted', label: 'Qty Wasted', type: 'number', align: 'right', tooltipKey: 'qtyWasted', cellTooltip: qtyWastedTooltip, sortable: true },
  { key: 'wastageValue', label: 'Wastage Value', type: 'money', align: 'right', tooltipKey: 'wastageValue', cellTooltip: wastageValueTooltip, sortable: true },
  { key: 'percentOfTotalWastage', label: '% of Total Wastage', type: 'percent', align: 'right', tooltipKey: 'percentOfTotalWastage', cellTooltip: percentOfTotalTooltip, sortable: true },
  { key: 'eventCount', label: 'Event Count', type: 'number', align: 'right', sortable: true },
  { key: 'topWastedItem', label: 'Top Wasted Item', sortable: true }
];

const byItemColumns = [
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'qtyWasted', label: 'Qty Wasted', type: 'number', align: 'right', tooltipKey: 'qtyWasted', cellTooltip: qtyWastedTooltip, sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', sortable: true },
  { key: 'wastageValue', label: 'Wastage Value', type: 'money', align: 'right', tooltipKey: 'wastageValue', cellTooltip: wastageValueTooltip, sortable: true },
  { key: 'eventCount', label: 'Event Count', type: 'number', align: 'right', sortable: true },
  { key: 'lastWastedDate', label: 'Last Wasted Date', type: 'date', sortable: true },
  { key: 'topWastageSource', label: 'Top Wastage Source', sortable: true }
];

const lineDetailColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'time', label: 'Time', type: 'time', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'wastageSource', label: 'Wastage Source', sortable: true },
  { key: 'documentNumber', label: 'Document Number', sortable: true },
  { key: 'qtyWasted', label: 'Qty Wasted', type: 'number', align: 'right', tooltipKey: 'qtyWasted', cellTooltip: qtyWastedTooltip, sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', sortable: true },
  { key: 'wastageValue', label: 'Wastage Value', type: 'money', align: 'right', tooltipKey: 'wastageValue', cellTooltip: wastageValueTooltip, sortable: true },
  { key: 'reason', label: 'Reason', sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'notes', label: 'Notes' },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const wastageExportColumns = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'time', label: 'Time', type: 'time' },
  { key: 'locationName', label: 'Location' },
  { key: 'itemName', label: 'Item' },
  { key: 'category', label: 'Category' },
  { key: 'wastageSource', label: 'Wastage Source' },
  { key: 'documentNumber', label: 'Document Number' },
  { key: 'qtyWasted', label: 'Qty Wasted', type: 'number' },
  { key: 'baseUom', label: 'UOM' },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money' },
  { key: 'wastageValue', label: 'Wastage Value', type: 'money' },
  { key: 'reason', label: 'Reason' },
  { key: 'createdBy', label: 'Created By' },
  { key: 'notes', label: 'Notes' },
  { key: 'sourceId', label: 'Source ID' }
];

export const wastageReport = {
  id: 'wastage',
  title: 'Wastage Report',
  section: 'operations',
  description: 'Detailed wastage report showing stock losses by source, date, location, category, item, reason, quantity, and value.',
  emptyState: { title: 'No wastage found', message: 'No wastage found for the selected filters.' },
  defaultView: 'summary',
  availableViews: ['summary', 'by_source', 'by_category', 'by_item', 'line_detail'],
  filterConfig: {
    summary: ['search', 'dateRange', 'location', 'source'],
    by_source: ['search', 'dateRange', 'location', 'source'],
    by_category: ['search', 'dateRange', 'location', 'category', 'source'],
    by_item: ['search', 'dateRange', 'location', 'category', 'source'],
    line_detail: ['search', 'dateRange', 'time', 'location', 'category', 'source']
  },

  columns: {
    summary: summaryColumns,
    by_source: bySourceColumns,
    by_category: byCategoryColumns,
    by_item: byItemColumns,
    line_detail: lineDetailColumns
  },

  exportColumns: {
    summary: summaryColumns,
    by_source: bySourceColumns,
    by_category: byCategoryColumns,
    by_item: byItemColumns,
    line_detail: wastageExportColumns
  },

  getRows: async ({ workspaceId, filters, services = {}, dataSet = {}, view = 'summary' }) => {
    const ledgerRows = await detailedActivityReport.getRows({ workspaceId, filters, services, dataSet, view: 'ledger' });
    const wastageRows = buildWastageRows(ledgerRows);
    const meta = buildWastageMeta(ledgerRows, wastageRows);
    if (view === 'by_source') return aggregateBySource(wastageRows, meta).map((row) => withMeta(row, meta));
    if (view === 'by_category') return aggregateByCategory(wastageRows, meta).map((row) => withMeta(row, meta));
    if (view === 'by_item') return aggregateByItem(wastageRows, meta).map((row) => withMeta(row, meta));
    if (view === 'line_detail') return wastageRows.map((row) => withMeta(row, meta));
    return aggregateSummary(wastageRows, meta).map((row) => withMeta(row, meta));
  },

  getTotals: ({ rows, view }) => getTotalsForView(view, rows),

  validate: ({ rows, view }) => validateWastageRows(rows, view),

  exportMapping: {
    summary: {
      date: 'Date',
      locationName: 'Location',
      qtyWasted: 'Total Qty Wasted',
      wastageValue: 'Total Wastage Value',
      eventCount: 'Wastage Events',
      topWastageSource: 'Top Wastage Source',
      topWastedItem: 'Top Wasted Item',
      createdBy: 'Created By'
    },
    by_source: {
      wastageSource: 'Wastage Source',
      qtyWasted: 'Qty Wasted',
      wastageValue: 'Wastage Value',
      percentOfTotalWastage: '% of Total Wastage',
      eventCount: 'Event Count'
    },
    by_category: {
      category: 'Category',
      qtyWasted: 'Qty Wasted',
      wastageValue: 'Wastage Value',
      percentOfTotalWastage: '% of Total Wastage',
      eventCount: 'Event Count',
      topWastedItem: 'Top Wasted Item'
    },
    by_item: {
      itemName: 'Item',
      category: 'Category',
      locationName: 'Location',
      qtyWasted: 'Qty Wasted',
      baseUom: 'Base UOM',
      unitCostExVat: 'Unit Cost Ex VAT',
      wastageValue: 'Wastage Value',
      eventCount: 'Event Count',
      lastWastedDate: 'Last Wasted Date',
      topWastageSource: 'Top Wastage Source'
    },
    line_detail: {
      date: 'Date',
      time: 'Time',
      locationName: 'Location',
      itemName: 'Item',
      category: 'Category',
      wastageSource: 'Wastage Source',
      documentNumber: 'Document Number',
      qtyWasted: 'Qty Wasted',
      baseUom: 'UOM',
      unitCostExVat: 'Unit Cost Ex VAT',
      wastageValue: 'Wastage Value',
      reason: 'Reason',
      createdBy: 'Created By',
      notes: 'Notes',
      sourceId: 'Source ID'
    }
  }
};

function buildWastageRows(ledgerRows = []) {
  return dedupeWastageRows(toArray(ledgerRows).filter(isWastageLedgerRow).map(normalizeWastageRow));
}

function normalizeWastageRow(row = {}, index = 0) {
  const qtyWasted = resolveQtyWasted(row);
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unitCost);
  const movementValue = hasValue(row.movementValue) ? safeNumber(row.movementValue) : -calculateStockValue(qtyWasted, unitCostExVat);
  const wastageValue = hasValue(row.movementValue) && safeNumber(row.movementValue) !== 0
    ? absoluteValue(row.movementValue)
    : calculateStockValue(qtyWasted, unitCostExVat);
  const reason = resolveReason(row);
  const wastageSource = resolveWastageSource(row);
  return {
    ...row,
    id: text(row.id) || `wastage:${row.sourceId || index}`,
    wastageSource,
    source: wastageSource,
    date: text(row.date || row.movementDate).slice(0, 10),
    time: text(row.time || row.movementTime || row.timestamp),
    category: text(row.category || row.categoryName) || 'Uncategorised',
    qtyWasted,
    baseUom: text(row.baseUom || row.unit),
    unitCostExVat,
    unitCost: unitCostExVat,
    movementValue,
    wastageValue,
    reason,
    createdBy: text(row.createdBy || row.createdByName || row.user),
    notes: text(row.notes || row.note),
    reportSourceRow: row
  };
}

function isWastageLedgerRow(row = {}) {
  const source = normalize(row.source || row.sourceType || row.movementType);
  const movement = normalize(row.movementType);
  const qtyOut = safeNumber(row.qtyOut);
  // Stock take differences are inventory variances, never wastage. This must be
  // checked before the broad "waste"/loss classification below so a negative
  // variance cannot leak into wastage totals.
  if (source.includes('stock take') || movement.includes('stock take')) return false;
  if (source.includes('sale usage') || source.includes('modifier usage')) return false;
  if (source.includes('transfer')) return false;
  if (source.includes('manufacturing out') && !source.includes('wastage')) return false;
  if (source.includes('wastage') || source.includes('waste') || source.includes('recipe wastage')) return true;
  if (movement.includes('wastage') || movement.includes('waste')) return true;
  if ((source.includes('manual adjustment') || movement.includes('manual adjustment')) && qtyOut > 0 && isMarkedAsWastage(row)) return true;
  return false;
}

function isMarkedAsWastage(row = {}) {
  return WASTAGE_REASON_PATTERN.test([
    row.reason,
    row.notes,
    row.note,
    row.category,
    row.movementType,
    row.source,
    row.raw?.metadata?.reason,
    row.raw?.metadata?.wasteReason,
    row.rawSourceRow?.metadata?.reason,
    row.rawSourceRow?.metadata?.wasteReason
  ].map(text).join(' '));
}

function dedupeWastageRows(rows = []) {
  const seenIds = new Set();
  const seenLogical = new Set();
  return toArray(rows).filter((row) => {
    const id = text(row.id);
    if (id && seenIds.has(id)) return false;
    if (id) seenIds.add(id);
    const logicalKey = [row.sourceId, row.itemId, row.locationId, row.date, row.qtyWasted, row.wastageValue].map(text).join('::');
    if (logicalKey.replace(/:/g, '')) {
      if (seenLogical.has(logicalKey)) return false;
      seenLogical.add(logicalKey);
    }
    return true;
  });
}

function aggregateSummary(rows = [], meta = {}) {
  return Array.from(groupBy(rows, (row) => `${row.date || 'No Date'}::${row.locationId || row.locationName || 'Unassigned'}`).entries())
    .map(([key, groupRows]) => {
      const first = groupRows[0] || {};
      const [date] = key.split('::');
      return {
        id: `wastage-summary:${key}`,
        date,
        locationId: first.locationId || '',
        locationName: first.locationName || 'Unassigned',
        qtyWasted: sumBy(groupRows, 'qtyWasted'),
        wastageValue: sumBy(groupRows, 'wastageValue'),
        eventCount: groupRows.length,
        topWastageSource: topByValue(groupRows, 'wastageSource'),
        topWastedItem: topByValue(groupRows, 'itemName'),
        createdBy: summarizeTextValues(groupRows, 'createdBy'),
        reportSummaryRow: true,
        __lineRows: groupRows,
        __meta: meta
      };
    });
}

function aggregateBySource(rows = [], meta = {}) {
  const total = sumBy(rows, 'wastageValue');
  return Array.from(groupBy(rows, (row) => row.wastageSource || 'Unknown Source').entries())
    .map(([source, groupRows]) => ({
      id: `wastage-source:${source}`,
      wastageSource: text(source) || 'Unknown Source',
      qtyWasted: sumBy(groupRows, 'qtyWasted'),
      wastageValue: sumBy(groupRows, 'wastageValue'),
      percentOfTotalWastage: total ? sumBy(groupRows, 'wastageValue') / total : 0,
      eventCount: groupRows.length,
      reportSummaryRow: true,
      __lineRows: groupRows,
      __meta: meta
    }));
}

function aggregateByCategory(rows = [], meta = {}) {
  const total = sumBy(rows, 'wastageValue');
  return Array.from(groupBy(rows, (row) => row.category || 'Uncategorised').entries())
    .map(([category, groupRows]) => ({
      id: `wastage-category:${category}`,
      category: text(category) || 'Uncategorised',
      qtyWasted: sumBy(groupRows, 'qtyWasted'),
      wastageValue: sumBy(groupRows, 'wastageValue'),
      percentOfTotalWastage: total ? sumBy(groupRows, 'wastageValue') / total : 0,
      eventCount: groupRows.length,
      topWastedItem: topByValue(groupRows, 'itemName'),
      reportSummaryRow: true,
      __lineRows: groupRows,
      __meta: meta
    }));
}

function aggregateByItem(rows = [], meta = {}) {
  return Array.from(groupBy(rows, (row) => [row.itemId || row.itemName, row.locationId || row.locationName].map(text).join('::')).entries())
    .map(([key, groupRows]) => {
      const first = groupRows[0] || {};
      return {
        id: `wastage-item:${key}`,
        itemId: first.itemId || '',
        itemName: first.itemName || 'Unknown Item',
        category: first.category || 'Uncategorised',
        locationId: first.locationId || '',
        locationName: first.locationName || 'Unassigned',
        qtyWasted: sumBy(groupRows, 'qtyWasted'),
        baseUom: first.baseUom || '',
        unitCostExVat: resolveWeightedUnitCost(groupRows),
        wastageValue: sumBy(groupRows, 'wastageValue'),
        eventCount: groupRows.length,
        lastWastedDate: groupRows.map((row) => row.date).filter(Boolean).sort().at(-1) || '',
        topWastageSource: topByValue(groupRows, 'wastageSource'),
        reportSummaryRow: true,
        __lineRows: groupRows,
        __meta: meta
      };
    });
}

function getTotalsForView(view = 'summary', rows = []) {
  const reportRows = toArray(rows);
  const totals = {
    qtyWasted: sumBy(reportRows, 'qtyWasted'),
    wastageValue: sumBy(reportRows, 'wastageValue'),
    eventCount: sumBy(reportRows, 'eventCount') || reportRows.length
  };
  if (view === 'by_source' || view === 'by_category') totals.percentOfTotalWastage = reportRows.length ? 1 : 0;
  return totals;
}

function validateWastageRows(rows = [], view = 'summary') {
  const reportRows = toArray(rows);
  if (!reportRows.length) return [];
  const meta = reportRows.find((row) => row.__meta)?.__meta || {};
  const lineRows = view === 'line_detail'
    ? reportRows
    : Array.from(new Map(reportRows.flatMap((row) => toArray(row.__lineRows)).map((row) => [row.id, row])).values());

  return [
    ...toArray(meta.apiWarnings),
    countWarning(lineRows, 'wastage-missing-item', 'critical', 'wastage row(s) have no item.', (row) => !text(row.itemName)),
    countWarning(lineRows, 'wastage-missing-location', 'critical', 'wastage row(s) have no location.', (row) => !text(row.locationName)),
    countWarning(lineRows, 'wastage-missing-qty-out', 'critical', 'wastage row(s) have no recorded wastage quantity.', (row) => safeNumber(row.qtyOut) <= 0 && resolveQtyWasted(row) <= 0),
    countWarning(lineRows, 'wastage-qty-in-instead-of-qty-out', 'critical', 'wastage row(s) have qtyIn populated instead of qtyOut.', (row) => safeNumber(row.qtyIn) > 0 && safeNumber(row.qtyOut) <= 0 && !isAccountingOnlyManufacturingWastage(row)),
    countWarning(lineRows, 'wastage-missing-unit-cost', 'critical', 'wastage row(s) do not have a unit cost yet, so wastage value may show R0 until item/location costs are loaded.', (row) => safeNumber(row.unitCostExVat ?? row.unitCost) === 0 && safeNumber(row.qtyWasted) > 0),
    countWarning(lineRows, 'wastage-value-not-calculable', 'critical', 'wastage row(s) have missing movement value and cannot calculate wastage value.', (row) => !hasValue(row.movementValue) && !(safeNumber(row.qtyWasted) > 0 && safeNumber(row.unitCostExVat) > 0)),
    countWarning(lineRows, 'wastage-missing-source-id', 'critical', 'wastage row(s) have no source ID.', (row) => !text(row.sourceId)),
    countWarning(lineRows, 'wastage-manufacturing-missing-recorded-qty', 'critical', 'Manufacturing Wastage row(s) do not contain the recorded yield-loss quantity.', (row) => text(row.wastageSource) === 'Manufacturing Wastage' && resolveQtyWasted(row) <= 0),
    countWarning(lineRows, 'wastage-reason-missing', 'warning', 'wastage row(s) are missing a reason.', (row) => shouldHaveReason(row) && !text(row.reason || row.notes)),
    countWarning(lineRows, 'wastage-value-mismatch', 'critical', 'wastage row(s) have values that do not match Qty Wasted x Unit Cost Ex VAT.', wastageValueMismatch),
    ...reconcileWastageToDetailedActivity({ wastageRows: lineRows, detailedRows: meta.ledgerRows })
  ].filter(Boolean);
}

function buildWastageMeta(ledgerRows = [], wastageRows = []) {
  const apiWarnings = toArray(toArray(ledgerRows).find((row) => row.__apiWarnings)?.__apiWarnings).filter((warning) => !isCoverageOnlyWarning(warning));
  return {
    ledgerRows,
    wastageRows,
    apiWarnings,
    sourceTypes: Array.from(new Set(wastageRows.map((row) => row.wastageSource).filter(Boolean)))
  };
}

function withMeta(row = {}, meta = {}) {
  return { ...row, __meta: meta };
}

function resolveQtyWasted(row = {}) {
  const metadata = row.raw?.metadata || row.raw?.movement?.metadata || row.rawSourceRow?.metadata || {};
  const recordedWastageQty = safeNumber(
    row.wastageQty
    ?? row.wasteQty
    ?? metadata.wastageQty
    ?? metadata.wasteQty
    ?? metadata.wastage_quantity
  );
  if (recordedWastageQty > 0) return recordedWastageQty;
  const qtyOut = safeNumber(row.qtyOut);
  if (qtyOut > 0) return qtyOut;
  const netQty = safeNumber(row.netQty);
  if (netQty < 0) return absoluteValue(netQty);
  return 0;
}

function resolveWastageSource(row = {}) {
  const source = text(row.source || row.sourceType || row.movementType);
  const normalized = normalize(source);
  if (normalized.includes('manufacturing wastage')) return 'Manufacturing Wastage';
  if (normalized.includes('recipe wastage')) return 'Recipe Wastage';
  if (normalized.includes('manual wastage')) return 'Manual Wastage';
  if (normalized.includes('wastage') || normalized.includes('waste')) return 'Wastage Adjustment';
  if (normalized.includes('manual adjustment')) return 'Manual Adjustment';
  return source || 'Unknown Source';
}

function isAccountingOnlyManufacturingWastage(row = {}) {
  if (text(row.wastageSource || row.source || row.sourceType) !== 'Manufacturing Wastage') return false;
  const metadata = row.raw?.metadata || row.raw?.movement?.metadata || row.rawSourceRow?.metadata || {};
  return row.accountingOnly === true
    || metadata.accountingOnly === true
    || Number(metadata.accountingOnly || 0) === 1;
}

function resolveReason(row = {}) {
  const raw = row.raw?.metadata || row.raw?.movement?.metadata || row.rawSourceRow?.metadata || {};
  return text(row.reason || row.wasteReason || row.notes || row.note || raw.wasteReason || raw.reason || raw.note);
}

function shouldHaveReason(row = {}) {
  return ['Wastage Adjustment', 'Manual Wastage', 'Manual Adjustment', 'Recipe Wastage'].includes(text(row.wastageSource));
}

function resolveWeightedUnitCost(rows = []) {
  const qty = sumBy(rows, 'qtyWasted');
  const value = sumBy(rows, 'wastageValue');
  if (qty > 0 && value > 0) return value / qty;
  const latest = [...toArray(rows)].sort((a, b) => text(b.date || b.timestamp).localeCompare(text(a.date || a.timestamp)))[0];
  return safeNumber(latest?.unitCostExVat ?? latest?.unitCost);
}

function topByValue(rows = [], key = '') {
  const groups = groupBy(rows, (row) => row[key] || 'Unknown');
  let topLabel = '';
  let topValue = -1;
  for (const [label, groupRows] of groups.entries()) {
    const value = sumBy(groupRows, 'wastageValue');
    if (value > topValue) {
      topLabel = label;
      topValue = value;
    }
  }
  return text(topLabel) || '-';
}

function summarizeTextValues(rows = [], key = '') {
  const values = Array.from(new Set(toArray(rows).map((row) => text(row[key])).filter(Boolean)));
  if (!values.length) return '-';
  if (values.length === 1) return values[0];
  return `${values.length} users`;
}

function qtyWastedTooltip(row = {}) {
  return buildRowFormulaTooltip('qtyWasted', `Qty Wasted = ${safeNumber(row.qtyWasted)} from Qty Out`);
}

function wastageValueTooltip(row = {}) {
  return buildRowFormulaTooltip('wastageValue', `R ${safeNumber(row.wastageValue).toFixed(2)} = ${safeNumber(row.qtyWasted)} x R ${safeNumber(row.unitCostExVat ?? row.unitCost).toFixed(2)}`);
}

function percentOfTotalTooltip(row = {}) {
  const total = safeNumber(row.__meta?.wastageRows?.reduce((sum, item) => sum + safeNumber(item.wastageValue), 0));
  return buildRowFormulaTooltip('percentOfTotalWastage', `${(safeNumber(row.percentOfTotalWastage) * 100).toFixed(2)}% = R ${safeNumber(row.wastageValue).toFixed(2)} / R ${total.toFixed(2)}`);
}

function wastageValueMismatch(row = {}) {
  if (!safeNumber(row.qtyWasted) || !safeNumber(row.unitCostExVat ?? row.unitCost)) return false;
  const expected = calculateStockValue(row.qtyWasted, row.unitCostExVat ?? row.unitCost);
  return Math.abs(expected - safeNumber(row.wastageValue)) > VALUE_TOLERANCE;
}

function countWarning(rows = [], code = '', level = 'warning', message = '', predicate = () => false) {
  return buildRowWarnings(rows, code, level, message, predicate);
}

function isCoverageOnlyWarning(warning = {}) {
  return /source rows are not present|not present in the selected real ledger data/i.test(text(warning.message));
}

function hasValue(value) {
  return value !== undefined && value !== null && text(value) !== '';
}

function normalize(value = '') {
  return text(value).toLowerCase().replace(/[_-]+/g, ' ');
}

export const __wastageReportInternals = {
  buildWastageRows,
  isWastageLedgerRow
};

export default wastageReport;
