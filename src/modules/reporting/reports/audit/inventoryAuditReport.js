import { fetchInventoryAuditRows } from '../../api/reportingApi.js';
import { roundMoney, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { formatMoney } from '../../engine/formatters.js';
import { DEFAULT_REPORT_TIMEZONE, formatReportTime, resolveReportTimestamp, zonedDateTimeStrings } from '../../engine/timezone.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';
import { buildRowWarnings } from '../../validators/rowWarningUtils.js';
import { isUserFixableWarning } from '../../validators/warningCategories.js';

const money = (value) => formatMoney(value || 0);
const percent = (value) => `${(safeNumber(value) * 100).toFixed(2)}%`;
const tooltip = (key, values = '') => buildRowFormulaTooltip(key, values);

const costDifferenceTooltip = (row) => tooltip('auditCostDifference', `Cost Difference = New Cost - Old Cost\n${money(row.costDifference)} = ${money(row.newCostExVat)} - ${money(row.oldCostExVat)}`);
const changePercentTooltip = (row) => tooltip('auditChangePercent', `Change % = Cost Difference / Old Cost\n${percent(row.changePercent)} = ${money(row.costDifference)} / ${money(row.oldCostExVat)}`);
const costImpactDifferenceTooltip = (row) => tooltip('auditCostImpactDifference', `Cost Impact Difference = New Cost Impact - Old Cost Impact\n${money(row.costImpactDifference)} = ${money(row.newCostImpact)} - ${money(row.oldCostImpact)}`);

const numberColumn = (key, label) => ({ key, label, type: 'number', align: 'right', sortable: true });
const moneyColumn = (key, label, tooltipKey, cellTooltip) => ({ key, label, type: 'money', align: 'right', tooltipKey, cellTooltip, sortable: true });
const percentColumn = (key, label, tooltipKey, cellTooltip) => ({ key, label, type: 'percent', align: 'right', tooltipKey, cellTooltip, sortable: true });

const changeLogColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'time', label: 'Time', type: 'time', sortable: true },
  { key: 'user', label: 'User', sortable: true },
  { key: 'action', label: 'Action', sortable: true },
  { key: 'entityType', label: 'Entity Type', sortable: true },
  { key: 'entityName', label: 'Entity Name', sortable: true },
  { key: 'fieldChanged', label: 'Field Changed', sortable: true },
  { key: 'oldValue', label: 'Old Value', sortable: false },
  { key: 'newValue', label: 'New Value', sortable: false },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'source', label: 'Source', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true },
  { key: 'notes', label: 'Notes', sortable: false }
];

const byUserColumns = [
  { key: 'user', label: 'User', sortable: true },
  numberColumn('actions', 'Actions'),
  numberColumn('itemsChanged', 'Items Changed'),
  numberColumn('costsChanged', 'Costs Changed'),
  numberColumn('recipesChanged', 'Recipes Changed'),
  numberColumn('stockActions', 'Stock Actions'),
  { key: 'lastActionDate', label: 'Last Action Date', type: 'date', sortable: true },
  { key: 'highRiskActions', label: 'High Risk Actions', type: 'number', align: 'right', tooltipKey: 'auditHighRiskActions', sortable: true }
];

const byEntityColumns = [
  { key: 'entityType', label: 'Entity Type', sortable: true },
  { key: 'entityName', label: 'Entity Name', sortable: true },
  numberColumn('changes', 'Changes'),
  { key: 'lastChangedBy', label: 'Last Changed By', sortable: true },
  { key: 'lastChangedAt', label: 'Last Changed At', type: 'date', sortable: true },
  numberColumn('highRiskChanges', 'High Risk Changes'),
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const costChangesColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'time', label: 'Time', type: 'time', sortable: true },
  { key: 'user', label: 'User', sortable: true },
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  moneyColumn('oldCostExVat', 'Old Cost Ex VAT'),
  moneyColumn('newCostExVat', 'New Cost Ex VAT'),
  moneyColumn('costDifference', 'Cost Difference', 'auditCostDifference', costDifferenceTooltip),
  percentColumn('changePercent', 'Change %', 'auditChangePercent', changePercentTooltip),
  { key: 'source', label: 'Source', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true },
  { key: 'reason', label: 'Reason', sortable: false }
];

const recipeChangesColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'time', label: 'Time', type: 'time', sortable: true },
  { key: 'user', label: 'User', sortable: true },
  { key: 'recipeName', label: 'Recipe', sortable: true },
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'changeType', label: 'Change Type', sortable: true },
  { key: 'ingredientName', label: 'Ingredient', sortable: true },
  { key: 'oldQty', label: 'Old Qty', type: 'qty', align: 'right', sortable: true },
  { key: 'newQty', label: 'New Qty', type: 'qty', align: 'right', sortable: true },
  { key: 'oldUom', label: 'Old UOM', sortable: true },
  { key: 'newUom', label: 'New UOM', sortable: true },
  moneyColumn('oldCostImpact', 'Old Cost Impact'),
  moneyColumn('newCostImpact', 'New Cost Impact'),
  moneyColumn('costImpactDifference', 'Cost Impact Difference', 'auditCostImpactDifference', costImpactDifferenceTooltip),
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const dataQualityColumns = [
  { key: 'severity', label: 'Severity', sortable: true },
  { key: 'area', label: 'Area', sortable: true },
  { key: 'entityType', label: 'Entity Type', sortable: true },
  { key: 'entityName', label: 'Entity Name', sortable: true },
  { key: 'issue', label: 'Issue', sortable: false },
  { key: 'impact', label: 'Impact', sortable: false },
  { key: 'suggestedFix', label: 'Suggested Fix', sortable: false },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const changeLogExportMapping = {
  date: 'Date', time: 'Time', user: 'User', action: 'Action', entityType: 'Entity Type', entityName: 'Entity Name', fieldChanged: 'Field Changed', oldValue: 'Old Value', newValue: 'New Value', locationName: 'Location', source: 'Source', sourceId: 'Source ID', notes: 'Notes'
};

const costChangesExportMapping = {
  date: 'Date', time: 'Time', user: 'User', itemName: 'Item', locationName: 'Location', oldCostExVat: 'Old Cost Ex VAT', newCostExVat: 'New Cost Ex VAT', costDifference: 'Cost Difference', changePercent: 'Change %', source: 'Source', sourceId: 'Source ID', reason: 'Reason'
};

const recipeChangesExportMapping = {
  date: 'Date', time: 'Time', user: 'User', recipeName: 'Recipe', menuItemName: 'Menu Item', changeType: 'Change Type', ingredientName: 'Ingredient', oldQty: 'Old Qty', newQty: 'New Qty', oldUom: 'Old UOM', newUom: 'New UOM', oldCostImpact: 'Old Cost Impact', newCostImpact: 'New Cost Impact', costImpactDifference: 'Cost Impact Difference', sourceId: 'Source ID'
};

const dataQualityExportMapping = {
  severity: 'Severity', area: 'Area', entityType: 'Entity Type', entityName: 'Entity Name', issue: 'Issue', impact: 'Impact', suggestedFix: 'Suggested Fix', sourceId: 'Source ID'
};

export const inventoryAuditReport = {
  id: 'inventory_audit',
  title: 'Inventory Audit',
  section: 'operations',
  description: 'Audits inventory-related changes, user actions, stock item edits, cost changes, UOM changes, recipe changes, supplier changes, and source document changes.',
  emptyState: { title: 'No inventory audit activity found', message: 'No inventory audit activity found for the selected filters.' },
  suppressEmptyWarning: true,
  defaultView: 'change_log',
  availableViews: ['change_log', 'by_user', 'by_entity', 'cost_changes', 'recipe_changes', 'data_quality'],
  filterConfig: {
    default: ['search', 'dateRange', 'user', 'action', 'entityType', 'entityName', 'location', 'warningSeverity'],
    data_quality: ['search', 'dateRange', 'user', 'action', 'entityType', 'entityName', 'location', 'warningSeverity']
  },
  columns: {
    change_log: changeLogColumns,
    by_user: byUserColumns,
    by_entity: byEntityColumns,
    cost_changes: costChangesColumns,
    recipe_changes: recipeChangesColumns,
    data_quality: dataQualityColumns
  },
  exportMapping: {
    change_log: changeLogExportMapping,
    by_user: { user: 'User', actions: 'Actions', itemsChanged: 'Items Changed', costsChanged: 'Costs Changed', recipesChanged: 'Recipes Changed', stockActions: 'Stock Actions', lastActionDate: 'Last Action Date', highRiskActions: 'High Risk Actions' },
    by_entity: { entityType: 'Entity Type', entityName: 'Entity Name', changes: 'Changes', lastChangedBy: 'Last Changed By', lastChangedAt: 'Last Changed At', highRiskChanges: 'High Risk Changes', sourceId: 'Source ID' },
    cost_changes: costChangesExportMapping,
    recipe_changes: recipeChangesExportMapping,
    data_quality: dataQualityExportMapping
  },
  getRows: async ({ workspaceId, filters, services = {}, view = 'change_log' }) => {
    const payload = services.reporting?.getInventoryAuditRows
      ? await services.reporting.getInventoryAuditRows({ workspaceId, filters })
      : await fetchInventoryAuditRows({ workspaceId, filters });
    rememberInventoryAuditPayload(services, payload);
    const rowsByView = buildInventoryAuditViews(payload);
    return rowsByView[view] || rowsByView.change_log;
  },
  getTotals: ({ rows, view }) => buildInventoryAuditTotals(rows, view),
  validate: ({ rows, services, view }) => {
    const warnings = toArray(services?.reporting?.__lastInventoryAuditPayload?.warnings);
    if (!rows.length) return warnings;
    const rowWarnings = [];
    if (view === 'change_log') {
      countWarning(rows, rowWarnings, 'inventory-audit-missing-user', 'critical', 'Audit row(s) have no user.', (row) => !text(row.user));
      countWarning(rows, rowWarnings, 'inventory-audit-missing-source-id', 'critical', 'Audit row(s) are missing source IDs where traceability is expected.', (row) => expectsSourceId(row) && !text(row.sourceId));
    }
    return [...warnings, ...rowWarnings];
  }
};

export function buildInventoryAuditViews(payload = {}) {
  const changeRows = toArray(payload.rows).map(normalizeAuditChangeRow);
  return {
    change_log: changeRows,
    by_user: buildByUserRows(changeRows),
    by_entity: buildByEntityRows(changeRows),
    cost_changes: toArray(payload.costChangeRows).map(normalizeCostChangeRow),
    recipe_changes: toArray(payload.recipeChangeRows).map(normalizeRecipeChangeRow),
    data_quality: toArray(payload.dataQualityRows).map(normalizeAuditQualityRow).filter(isCustomerActionableQualityRow)
  };
}

function isCustomerActionableQualityRow(row = {}) {
  return isUserFixableWarning({
    ...row,
    code: text(row.issueType || row.code),
    message: [row.issue, row.impact, row.suggestedFix].map(text).filter(Boolean).join(' ')
  });
}

function normalizeAuditChangeRow(row = {}) {
  const timeZone = text(row.reportingTimeZone || row.reporting_time_zone || row.timeZone || row.time_zone || row.__apiMeta?.timeZone) || DEFAULT_REPORT_TIMEZONE;
  const suppliedTimestamp = text(row.timestamp || row.occurredAt || row.occurred_at || row.date || '');
  const fallbackTimestamp = text(row.createdAt || row.created_at || '');
  const timestamp = resolveReportTimestamp(suppliedTimestamp, fallbackTimestamp, timeZone)
    || text(`${row.date || ''}T${row.time || ''}`);
  const local = timestamp ? zonedDateTimeStrings(timestamp, timeZone) : { date: '', time: '' };
  return {
    ...row,
    id: text(row.id) || `inventory-audit:${text(row.sourceId)}:${text(row.fieldChanged)}`,
    date: text(row.date || local.date || timestamp).slice(0, 10),
    time: formatReportTime(row.time || timestamp, timeZone, { includeSeconds: true }),
    reportingTimeZone: timeZone,
    user: text(row.user || row.createdByName || row.createdBy || row.actor),
    action: text(row.action),
    entityType: text(row.entityType),
    entityName: text(row.entityName),
    fieldChanged: text(row.fieldChanged),
    oldValue: humanValue(row.oldValue),
    newValue: humanValue(row.newValue),
    locationId: text(row.locationId),
    locationName: text(row.locationName),
    source: text(row.source),
    sourceId: text(row.sourceId),
    notes: text(row.notes),
    highRisk: Boolean(row.highRisk) || isHighRiskAction(row)
  };
}

function normalizeCostChangeRow(row = {}) {
  const oldCostExVat = safeNumber(row.oldCostExVat);
  const newCostExVat = safeNumber(row.newCostExVat);
  const costDifference = row.costDifference !== undefined ? safeNumber(row.costDifference) : roundMoney(newCostExVat - oldCostExVat);
  return {
    ...row,
    oldCostExVat,
    newCostExVat,
    costDifference,
    changePercent: oldCostExVat ? costDifference / oldCostExVat : 0,
    user: text(row.user),
    itemName: text(row.itemName || row.entityName),
    locationName: text(row.locationName),
    source: text(row.source),
    sourceId: text(row.sourceId),
    reason: text(row.reason || row.notes)
  };
}

function normalizeRecipeChangeRow(row = {}) {
  const oldCostImpact = safeNumber(row.oldCostImpact);
  const newCostImpact = safeNumber(row.newCostImpact);
  return {
    ...row,
    user: text(row.user),
    recipeName: text(row.recipeName || row.entityName),
    menuItemName: text(row.menuItemName),
    changeType: text(row.changeType || row.action),
    ingredientName: text(row.ingredientName),
    oldQty: safeNumber(row.oldQty),
    newQty: safeNumber(row.newQty),
    oldUom: text(row.oldUom),
    newUom: text(row.newUom),
    oldCostImpact,
    newCostImpact,
    costImpactDifference: row.costImpactDifference !== undefined ? safeNumber(row.costImpactDifference) : roundMoney(newCostImpact - oldCostImpact),
    sourceId: text(row.sourceId)
  };
}

function normalizeAuditQualityRow(row = {}) {
  return {
    ...row,
    id: text(row.id) || `inventory-audit-quality:${text(row.issueType || row.issue)}:${text(row.sourceId)}`,
    severity: text(row.severity || 'Warning'),
    area: text(row.area || 'Audit'),
    entityType: text(row.entityType),
    entityName: text(row.entityName),
    issueType: text(row.issueType),
    issue: text(row.issue),
    impact: text(row.impact),
    suggestedFix: text(row.suggestedFix),
    sourceId: text(row.sourceId)
  };
}

function buildByUserRows(rows = []) {
  return Array.from(groupBy(rows, (row) => row.user || 'Unknown User').entries()).map(([key, group]) => ({
    id: `inventory-audit-user:${key}`,
    user: text(key),
    actions: group.length,
    itemsChanged: countWhere(group, (row) => /item/i.test(row.entityType)),
    costsChanged: countWhere(group, (row) => /cost/i.test(row.action) || /cost/i.test(row.fieldChanged)),
    recipesChanged: countWhere(group, (row) => /recipe/i.test(row.entityType) || /recipe/i.test(row.action)),
    stockActions: countWhere(group, (row) => /committed|adjusted|stock|grv|transfer|manufacturing|wastage/i.test(`${row.action} ${row.entityType}`)),
    lastActionDate: maxText(group, (row) => row.date),
    highRiskActions: countWhere(group, isHighRiskAction)
  }));
}

function buildByEntityRows(rows = []) {
  return Array.from(groupBy(rows, (row) => `${row.entityType || 'Unknown'}::${row.entityName || row.sourceId || 'Unknown'}`).entries()).map(([key, group]) => ({
    id: `inventory-audit-entity:${key}`,
    entityType: text(group[0]?.entityType),
    entityName: text(group[0]?.entityName),
    changes: group.length,
    lastChangedBy: text(group.sort((a, b) => text(b.date + b.time).localeCompare(text(a.date + a.time)))[0]?.user),
    lastChangedAt: maxText(group, (row) => row.date),
    highRiskChanges: countWhere(group, isHighRiskAction),
    sourceId: text(group[0]?.sourceId)
  }));
}

function buildInventoryAuditTotals(rows = [], view = 'change_log') {
  const totals = {};
  if (view === 'change_log') totals.totalChanges = rows.length;
  if (view === 'by_user') {
    totals.actions = sumBy(rows, (row) => row.actions);
    totals.highRiskActions = sumBy(rows, (row) => row.highRiskActions);
  }
  if (view === 'by_entity') {
    totals.changes = sumBy(rows, (row) => row.changes);
    totals.highRiskChanges = sumBy(rows, (row) => row.highRiskChanges);
  }
  if (view === 'cost_changes') {
    totals.costDifference = roundMoney(sumBy(rows, (row) => row.costDifference));
    const rowsWithOldCost = rows.filter((row) => safeNumber(row.oldCostExVat) !== 0);
    totals.changePercent = rowsWithOldCost.length ? sumBy(rowsWithOldCost, (row) => row.changePercent) / rowsWithOldCost.length : 0;
  }
  if (view === 'recipe_changes') totals.costImpactDifference = roundMoney(sumBy(rows, (row) => row.costImpactDifference));
  if (view === 'data_quality') {
    totals.critical = countWhere(rows, (row) => text(row.severity).toLowerCase() === 'critical');
    totals.warning = countWhere(rows, (row) => text(row.severity).toLowerCase() === 'warning');
    totals.info = countWhere(rows, (row) => text(row.severity).toLowerCase() === 'info');
  }
  return totals;
}

function countWarning(rows, warnings, code, level, message, predicate) {
  warnings.push(...buildRowWarnings(rows, code, level, message, predicate));
}

function expectsSourceId(row = {}) {
  return /committed|deleted|adjusted|updated|created/i.test(text(row.action));
}

function isHighRiskAction(row = {}) {
  return Boolean(row.highRisk) || /cost|quantity|recipe|uom|delete|deleted|committed|stock|transfer|manufacturing|wastage|threshold|par/i.test(`${row.action} ${row.fieldChanged} ${row.entityType}`);
}

function countWhere(rows = [], predicate) {
  return toArray(rows).filter(predicate).length;
}

function maxText(rows = [], selector) {
  return rows.map(selector).map(text).filter(Boolean).sort().pop() || '';
}

function humanValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return text(value);
}

function rememberInventoryAuditPayload(services = {}, payload = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastInventoryAuditPayload = payload;
}

export default inventoryAuditReport;
