import { fetchModifierSalesRows } from '../../api/reportingApi.js';
import {
  calculateGpPercent,
  calculateGrossProfit,
  calculateVatFromGross,
  roundMoney,
  safeNumber
} from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { formatMoney } from '../../engine/formatters.js';
import { DEFAULT_REPORT_TIMEZONE, formatReportTime } from '../../engine/timezone.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';

const money = (value) => formatMoney(value || 0);
const percent = (value) => `${((safeNumber(value) || 0) * 100).toFixed(1)}%`;

const tooltip = (key, values = '') => buildRowFormulaTooltip(key, values);
const netSalesTooltip = (row) => safeNumber(row.refundAmount ?? row.refunds) > 0
  ? tooltip('netSales', `Net Refund = -(Refunds - Reversed VAT)\n${money(row.netSales ?? row.netAmount)} = -(${money(row.refundAmount ?? row.refunds)} - ${money(Math.abs(safeNumber(row.vat ?? row.vatAmount)))})`)
  : tooltip('netSales', `Net Sales = Gross Sales - VAT\n${money(row.netSales ?? row.netAmount)} = ${money(row.grossSales ?? row.grossAmount)} - ${money(row.vat ?? row.vatAmount)}`);
const stockCostTooltip = (row) => tooltip('stockCost', `Stock Cost = Qty Deducted x Unit Cost Ex VAT\n${money(row.stockCost)} = ${safeNumber(row.stockDeducted ?? row.qtyDeducted ?? row.stockQtyDeducted).toFixed(3)} x ${money(row.unitCostExVat)}`);
const grossProfitTooltip = (row) => tooltip('grossProfit', `Gross Profit = Net Sales - Stock Cost\n${money(row.grossProfit)} = ${money(row.netSales ?? row.netAmount)} - ${money(row.stockCost)}`);
const gpPercentTooltip = (row) => tooltip('gpPercent', `GP % = Gross Profit / Net Sales\n${percent(row.gpPercent)} = ${money(row.grossProfit)} / ${money(row.netSales ?? row.netAmount)}`);
const selectedPercentTooltip = (row) => tooltip('selectedPercent', `Selected % = Times Selected / Total Selections in Modifier Group\n${percent(row.selectedPercent)} = ${safeNumber(row.timesSelected)} / ${safeNumber(row.groupTotalSelections)}`);
const averageSellingPriceTooltip = (row) => tooltip('averageSellingPrice', `Average Selling Price = Gross Sales / Qty Selected\n${money(row.averageSellingPrice)} = ${money(row.grossModifierSales ?? row.grossSales)} / ${safeNumber(row.qtySelected ?? row.timesSelected)}`);
const menuItemNetSalesTooltip = (row) => tooltip('netSales', `Net Menu Sales = Gross Menu Sales - VAT\n${money(row.netMenuSales)} = ${money(row.grossMenuSales)} - ${money(row.vat)}`);
const menuItemTotalStockCostTooltip = (row) => tooltip('stockCost', `Total Stock Cost = Base Recipe Stock Cost + Modifier Stock Cost\n${money(row.totalStockCost)} = ${money(row.baseStockCost)} + ${money(row.modifierStockCost)}`);
const menuItemGrossProfitTooltip = (row) => tooltip('grossProfit', `Total Gross Profit = Net Menu Sales - Total Stock Cost\n${money(row.grossProfit)} = ${money(row.netMenuSales)} - ${money(row.totalStockCost)}`);
const menuItemGpPercentTooltip = (row) => tooltip('gpPercent', `Total GP % = Total Gross Profit / Net Menu Sales\n${percent(row.gpPercent)} = ${money(row.grossProfit)} / ${money(row.netMenuSales)}`);

const moneyColumn = (key, label, tooltipKey, cellTooltip) => ({ key, label, type: 'money', align: 'right', tooltipKey, cellTooltip, sortable: true });
const numberColumn = (key, label) => ({ key, label, type: 'number', align: 'right', sortable: true });
const qtyColumn = (key, label) => ({ key, label, type: 'qty', align: 'right', sortable: true });
const percentColumn = (key, label, tooltipKey, cellTooltip) => ({ key, label, type: 'percent', align: 'right', tooltipKey, cellTooltip, sortable: true });

const summaryColumns = [
  { key: 'modifierGroupName', label: 'Modifier Group', sortable: true },
  { key: 'modifierName', label: 'Modifier Name', sortable: true },
  { key: 'modifierType', label: 'Modifier Type', sortable: true },
  { key: 'stockAction', label: 'Stock Action', sortable: true },
  numberColumn('timesSelected', 'Times Selected'),
  numberColumn('refundedSelections', 'Refunded'),
  numberColumn('netSelections', 'Net Selections'),
  percentColumn('selectedPercent', 'Selected %', 'selectedPercent', selectedPercentTooltip),
  moneyColumn('grossSales', 'Gross Sales', 'grossSales'),
  moneyColumn('refundAmount', 'Refunds', 'refunds'),
  moneyColumn('netSales', 'Net Sales', 'netSales', netSalesTooltip),
  qtyColumn('stockDeducted', 'Stock Deducted'),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  moneyColumn('stockCost', 'Stock Cost', 'stockCost', stockCostTooltip),
  moneyColumn('grossProfit', 'Gross Profit', 'grossProfit', grossProfitTooltip),
  percentColumn('gpPercent', 'GP %', 'gpPercent', gpPercentTooltip),
  { key: 'stockDeductionStatus', label: 'Stock Deduction Status', sortable: true }
];

const gpTrackerColumns = [
  { key: 'modifierGroupName', label: 'Modifier Group', sortable: true },
  { key: 'modifierName', label: 'Modifier Name', sortable: true },
  { key: 'modifierType', label: 'Modifier Type', sortable: true },
  { key: 'stockAction', label: 'Stock Action', sortable: true },
  { key: 'linkedProduct', label: 'Linked Product', sortable: true },
  numberColumn('qtySelected', 'Qty Selected'),
  numberColumn('refundedSelections', 'Refunded'),
  numberColumn('netSelections', 'Net Selections'),
  moneyColumn('averageSellingPrice', 'Average Selling Price', 'averageSellingPrice', averageSellingPriceTooltip),
  moneyColumn('grossModifierSales', 'Gross Modifier Sales', 'grossSales'),
  moneyColumn('refundAmount', 'Refunds', 'refunds'),
  moneyColumn('vat', 'VAT', 'salesVat'),
  moneyColumn('netModifierSales', 'Net Modifier Sales', 'netSales', netSalesTooltip),
  qtyColumn('qtyDeducted', 'Qty Deducted'),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  moneyColumn('unitCostExVat', 'Unit Cost Ex VAT', 'unitCostExVat'),
  moneyColumn('stockCost', 'Stock Cost', 'stockCost', stockCostTooltip),
  moneyColumn('grossProfit', 'Gross Profit', 'grossProfit', grossProfitTooltip),
  percentColumn('gpPercent', 'GP %', 'gpPercent', gpPercentTooltip),
  { key: 'stockDeductionStatus', label: 'Stock Deduction Status', sortable: true }
];

const byGroupColumns = [
  { key: 'modifierGroupName', label: 'Modifier Group', sortable: true },
  { key: 'modifierType', label: 'Modifier Type', sortable: true },
  { key: 'stockAction', label: 'Stock Action', sortable: true },
  numberColumn('totalSelections', 'Total Selections'),
  numberColumn('refundedSelections', 'Refunded'),
  numberColumn('netSelections', 'Net Selections'),
  moneyColumn('grossSales', 'Gross Sales', 'grossSales'),
  moneyColumn('refundAmount', 'Refunds', 'refunds'),
  moneyColumn('vat', 'VAT', 'salesVat'),
  moneyColumn('netSales', 'Net Sales', 'netSales', netSalesTooltip),
  moneyColumn('stockCost', 'Stock Cost', 'stockCost', stockCostTooltip),
  moneyColumn('grossProfit', 'Gross Profit', 'grossProfit', grossProfitTooltip),
  percentColumn('gpPercent', 'GP %', 'gpPercent', gpPercentTooltip),
  { key: 'topModifier', label: 'Top Modifier', sortable: true },
  numberColumn('stockDeductionIssues', 'Stock Deduction Issues')
];

const byMenuItemColumns = [
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  numberColumn('modifierSelections', 'Modifier Selections'),
  numberColumn('refundedSelections', 'Refunded'),
  numberColumn('netSelections', 'Net Selections'),
  moneyColumn('grossMenuSales', 'Gross Menu Sales', 'grossSales'),
  moneyColumn('menuItemRefundAmount', 'Refunds', 'refunds'),
  moneyColumn('vat', 'VAT', 'salesVat'),
  moneyColumn('netMenuSales', 'Net Menu Sales', 'netSales', menuItemNetSalesTooltip),
  moneyColumn('baseStockCost', 'Base Recipe Stock Cost', 'stockCost'),
  moneyColumn('modifierStockCost', 'Modifier Stock Cost', 'stockCost'),
  moneyColumn('totalStockCost', 'Total Stock Cost', 'stockCost', menuItemTotalStockCostTooltip),
  moneyColumn('grossProfit', 'Total Gross Profit', 'grossProfit', menuItemGrossProfitTooltip),
  percentColumn('gpPercent', 'Total GP %', 'gpPercent', menuItemGpPercentTooltip),
  { key: 'stockDeductionStatus', label: 'Stock Deduction Status', sortable: true }
];

const byModifierColumns = [
  { key: 'modifierName', label: 'Modifier Name', sortable: true },
  { key: 'modifierGroupName', label: 'Modifier Group', sortable: true },
  { key: 'modifierType', label: 'Modifier Type', sortable: true },
  { key: 'stockAction', label: 'Stock Action', sortable: true },
  { key: 'linkedStockItemName', label: 'Linked Stock Item', sortable: true },
  numberColumn('timesSelected', 'Times Selected'),
  numberColumn('refundedSelections', 'Refunded'),
  numberColumn('netSelections', 'Net Selections'),
  qtyColumn('stockDeducted', 'Stock Deducted'),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  moneyColumn('grossSales', 'Gross Sales', 'grossSales'),
  moneyColumn('refundAmount', 'Refunds', 'refunds'),
  moneyColumn('vat', 'VAT', 'salesVat'),
  moneyColumn('netSales', 'Net Sales', 'netSales', netSalesTooltip),
  moneyColumn('stockCost', 'Stock Cost', 'stockCost', stockCostTooltip),
  moneyColumn('grossProfit', 'Gross Profit', 'grossProfit', grossProfitTooltip),
  percentColumn('gpPercent', 'GP %', 'gpPercent', gpPercentTooltip),
  { key: 'stockDeductionStatus', label: 'Stock Deduction Status', sortable: true }
];

const salesLogColumns = [
  { key: 'saleDate', label: 'Sale Date', type: 'date', sortable: true },
  { key: 'saleTime', label: 'Sale Time', type: 'time', sortable: true },
  { key: 'receiptNumber', label: 'Receipt Number', sortable: true },
  { key: 'transactionType', label: 'Transaction Type', sortable: true },
  { key: 'refundId', label: 'Refund ID', sortable: true },
  { key: 'refundReason', label: 'Refund Reason', sortable: true },
  { key: 'refundHandling', label: 'Refund Handling', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'modifierGroupName', label: 'Modifier Group', sortable: true },
  { key: 'modifierName', label: 'Modifier Name', sortable: true },
  { key: 'modifierType', label: 'Modifier Type', sortable: true },
  { key: 'stockAction', label: 'Stock Action', sortable: true },
  qtyColumn('qty', 'Qty'),
  moneyColumn('grossAmount', 'Gross Amount', 'grossSales'),
  moneyColumn('refundAmount', 'Refund Amount', 'refunds'),
  moneyColumn('vatAmount', 'VAT', 'salesVat'),
  moneyColumn('netAmount', 'Net Amount', 'netSales', netSalesTooltip),
  { key: 'linkedStockItemName', label: 'Linked Stock Item', sortable: true },
  qtyColumn('stockQtyDeducted', 'Stock Qty Deducted'),
  qtyColumn('wastageQty', 'Wastage Qty'),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  moneyColumn('unitCostExVat', 'Unit Cost Ex VAT', 'unitCostExVat'),
  moneyColumn('stockCost', 'Stock Cost', 'stockCost', stockCostTooltip),
  moneyColumn('grossProfit', 'Gross Profit', 'grossProfit', grossProfitTooltip),
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const summaryExportMapping = {
  modifierGroupName: 'Modifier Group',
  modifierName: 'Modifier Name',
  modifierType: 'Modifier Type',
  stockAction: 'Stock Action',
  timesSelected: 'Times Selected',
  refundedSelections: 'Refunded',
  netSelections: 'Net Selections',
  selectedPercent: 'Selected %',
  grossSales: 'Gross Sales',
  refundAmount: 'Refunds',
  netSales: 'Net Sales',
  stockDeducted: 'Stock Deducted',
  baseUom: 'UOM',
  stockCost: 'Stock Cost',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %',
  stockDeductionStatus: 'Stock Deduction Status'
};

const gpTrackerExportMapping = {
  modifierGroupName: 'Modifier Group',
  modifierName: 'Modifier Name',
  modifierType: 'Modifier Type',
  stockAction: 'Stock Action',
  linkedProduct: 'Linked Product',
  qtySelected: 'Qty Selected',
  refundedSelections: 'Refunded',
  netSelections: 'Net Selections',
  averageSellingPrice: 'Average Selling Price',
  grossModifierSales: 'Gross Sales',
  refundAmount: 'Refunds',
  vat: 'VAT',
  netModifierSales: 'Net Sales',
  qtyDeducted: 'Qty Deducted',
  baseUom: 'UOM',
  unitCostExVat: 'Unit Cost Ex VAT',
  stockCost: 'Stock Cost',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %',
  stockDeductionStatus: 'Stock Deduction Status'
};

const salesLogExportMapping = {
  saleDate: 'Sale Date',
  saleTime: 'Sale Time',
  receiptNumber: 'Receipt Number',
  transactionType: 'Transaction Type',
  refundId: 'Refund ID',
  refundReason: 'Refund Reason',
  refundHandling: 'Refund Handling',
  locationName: 'Location',
  menuItemName: 'Menu Item',
  modifierGroupName: 'Modifier Group',
  modifierName: 'Modifier Name',
  modifierType: 'Modifier Type',
  stockAction: 'Stock Action',
  qty: 'Qty',
  grossAmount: 'Gross Amount',
  refundAmount: 'Refund Amount',
  vatAmount: 'VAT',
  netAmount: 'Net Amount',
  linkedStockItemName: 'Linked Stock Item',
  stockQtyDeducted: 'Stock Qty Deducted',
  wastageQty: 'Wastage Qty',
  baseUom: 'UOM',
  unitCostExVat: 'Unit Cost Ex VAT',
  stockCost: 'Stock Cost',
  grossProfit: 'Gross Profit',
  createdBy: 'Created By',
  sourceId: 'Source ID'
};

const groupExportMapping = {
  modifierGroupName: 'Modifier Group',
  modifierType: 'Modifier Type',
  stockAction: 'Stock Action',
  totalSelections: 'Total Selections',
  refundedSelections: 'Refunded',
  netSelections: 'Net Selections',
  grossSales: 'Gross Sales',
  refundAmount: 'Refunds',
  vat: 'VAT',
  netSales: 'Net Sales',
  stockCost: 'Stock Cost',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %',
  topModifier: 'Top Modifier',
  stockDeductionIssues: 'Stock Deduction Issues'
};

const byMenuItemExportMapping = {
  menuItemName: 'Menu Item',
  modifierSelections: 'Modifier Selections',
  refundedSelections: 'Refunded',
  netSelections: 'Net Selections',
  grossMenuSales: 'Gross Menu Sales',
  menuItemRefundAmount: 'Refunds',
  vat: 'VAT',
  netMenuSales: 'Net Menu Sales',
  baseStockCost: 'Base Recipe Stock Cost',
  modifierStockCost: 'Modifier Stock Cost',
  totalStockCost: 'Total Stock Cost',
  grossProfit: 'Total Gross Profit',
  gpPercent: 'Total GP %',
  stockDeductionStatus: 'Stock Deduction Status'
};

const byModifierExportMapping = {
  modifierName: 'Modifier Name',
  modifierGroupName: 'Modifier Group',
  modifierType: 'Modifier Type',
  stockAction: 'Stock Action',
  linkedStockItemName: 'Linked Stock Item',
  timesSelected: 'Times Selected',
  refundedSelections: 'Refunded',
  netSelections: 'Net Selections',
  stockDeducted: 'Stock Deducted',
  baseUom: 'UOM',
  grossSales: 'Gross Sales',
  refundAmount: 'Refunds',
  vat: 'VAT',
  netSales: 'Net Sales',
  stockCost: 'Stock Cost',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %',
  stockDeductionStatus: 'Stock Deduction Status'
};

export const modifierReport = {
  id: 'modifier_report',
  title: 'Modifier Report',
  section: 'sales',
  description: 'Modifier sales, usage, stock deduction, profitability, and line-level audit from YOCO sales data.',
  emptyState: { title: 'No modifier sales found', message: 'No modifier sales found for the selected filters.' },
  suppressEmptyWarning: true,
  defaultView: 'summary',
  availableViews: ['summary', 'gp_tracker', 'by_group', 'by_menu_item', 'by_modifier', 'sales_log'],
  filterConfig: {
    default: ['search', 'dateRange', 'location', 'modifierGroup', 'modifierType', 'modifierName', 'menuItem', 'stockDeductionStatus']
  },
  columns: {
    summary: summaryColumns,
    gp_tracker: gpTrackerColumns,
    by_group: byGroupColumns,
    by_menu_item: byMenuItemColumns,
    by_modifier: byModifierColumns,
    sales_log: salesLogColumns
  },
  getRows: async ({ workspaceId, filters, services = {}, view = 'summary' }) => {
    const payload = services.reporting?.getModifierSalesRows
      ? await services.reporting.getModifierSalesRows({ workspaceId, filters })
      : await fetchModifierSalesRows({ workspaceId, filters });
    const model = buildModifierReportModel(payload.rows || []);
    rememberModifierModel(services, model, payload);
    return (model.views[view] || model.views.summary).map((row) => withModifierMeta(row, payload));
  },
  getTotals: ({ rows, view }) => modifierTotals(rows, view),
  validate: ({ rows, services }) => [
    ...toArray(services?.reporting?.__lastModifierReportPayload?.warnings),
    ...validateModifierRows(rows)
  ],
  exportMapping: {
    summary: summaryExportMapping,
    gp_tracker: gpTrackerExportMapping,
    by_group: groupExportMapping,
    by_menu_item: byMenuItemExportMapping,
    by_modifier: byModifierExportMapping,
    sales_log: salesLogExportMapping
  }
};

export const modifierSummaryReport = {
  ...modifierReport,
  id: 'modifier_summary',
  defaultView: 'summary',
  hiddenFromDashboard: true,
  redirectsTo: 'modifier_report'
};

export const modifierGpTrackerReport = {
  ...modifierReport,
  id: 'modifier_gp_tracker',
  defaultView: 'gp_tracker',
  hiddenFromDashboard: true,
  redirectsTo: 'modifier_report'
};

export const modifierSalesLogReport = {
  ...modifierReport,
  id: 'modifier_sales_log',
  defaultView: 'sales_log',
  hiddenFromDashboard: true,
  redirectsTo: 'modifier_report'
};

export function buildModifierReportModel(rows = []) {
  const normalized = toArray(rows).map(normalizeModifierRow);
  const summary = buildModifierSummary(normalized);
  return {
    sourceRows: normalized,
    views: {
      summary,
      gp_tracker: summary.map(toGpTrackerRow),
      by_group: buildByGroup(normalized),
      by_menu_item: buildByMenuItem(normalized),
      by_modifier: buildByModifier(normalized),
      sales_log: normalized.map(toSalesLogRow)
    }
  };
}

function normalizeModifierRow(row = {}) {
  const reportingTimeZone = text(row.reportingTimeZone || row.reporting_time_zone || row.timeZone || row.time_zone || row.__apiMeta?.timeZone) || DEFAULT_REPORT_TIMEZONE;
  const isRefund = modifierBoolean(row.isRefund ?? row.is_refund)
    || text(row.transactionType || row.transaction_type).toLowerCase() === 'refund'
    || text(row.status).toLowerCase().includes('refund')
    || Boolean(text(row.refundId || row.refund_id));
  const grossAmount = safeNumber(row.grossAmount ?? row.grossSales);
  const refundAmount = safeNumber(row.refundAmount ?? row.refunds ?? row.refund_amount);
  const suppliedRate = normalizeModifierVatRate(row.vatRate ?? row.vat_rate);
  const vatRate = suppliedRate > 0 ? suppliedRate : 0.15;
  const isVatExempt = modifierBoolean(row.isVatExempt ?? row.is_vat_exempt ?? row.vatExempt ?? row.vat_exempt ?? row.zeroRated ?? row.zero_rated)
    || /zero[ _-]?rated|tax[ _-]?exempt|vat[ _-]?exempt|non[ _-]?taxable/.test(text(row.vatSource || row.vat_source || row.taxStatus || row.tax_status).toLowerCase());
  const explicitVat = row.vatAmount ?? row.vat;
  const explicitVatAmount = safeNumber(explicitVat);
  const explicitVatUsable = hasModifierValue(explicitVat) && (isRefund || explicitVatAmount > 0 || !grossAmount || isVatExempt);
  const vatAmount = explicitVatUsable ? explicitVatAmount : calculateVatFromGross(grossAmount, vatRate);
  const explicitNet = row.netAmount ?? row.netSales;
  const explicitNetAmount = safeNumber(explicitNet);
  const explicitNetReconciles = hasModifierValue(explicitNet)
    && (isRefund || Math.abs(roundMoney(grossAmount - vatAmount) - roundMoney(explicitNetAmount)) <= 0.011);
  const netAmount = explicitNetReconciles ? explicitNetAmount : roundMoney(grossAmount - vatAmount);
  const stockCost = safeNumber(row.stockCost);
  const grossProfit = row.grossProfit !== undefined ? safeNumber(row.grossProfit) : calculateGrossProfit(netAmount, stockCost);
  const transactionQty = safeNumber(row.qty ?? row.netSelections ?? row.timesSelected, isRefund ? -1 : 1);
  const absoluteQty = Math.abs(transactionQty) || 1;
  const saleQty = safeNumber(row.saleQty ?? row.sale_qty, isRefund ? 0 : absoluteQty);
  const refundQty = safeNumber(row.refundQty ?? row.refund_qty ?? row.refundedSelections, isRefund ? absoluteQty : 0);
  const timesSelected = safeNumber(row.timesSelected, saleQty);
  const refundedSelections = safeNumber(row.refundedSelections, refundQty);
  const netSelections = safeNumber(row.netSelections, timesSelected - refundedSelections);
  const modifierType = normalizeModifierType(row.modifierType);
  const stockActionType = normalizeModifierStockActionType(
    row.stockActionType || row.stock_action_type || row.modifierActionType || row.modifier_action_type || row.noteActionType || row.note_action_type || (modifierType === 'Product' ? 'ADD_RECIPE' : '')
  );
  const stockAction = text(row.stockAction || row.stock_action) || modifierStockActionLabel(stockActionType);
  return {
    ...row,
    id: text(row.id || row.sourceId || row.modifierId || row.modifierName),
    saleDate: text(row.saleDate).slice(0, 10),
    saleTime: formatReportTime(row.saleTime || row.time || row.occurredAt || row.occurred_at, reportingTimeZone, { includeSeconds: true }),
    reportingTimeZone,
    receiptNumber: text(row.receiptNumber),
    transactionType: text(row.transactionType || row.transaction_type) || (isRefund ? 'Refund' : 'Sale'),
    isRefund,
    refundId: text(row.refundId || row.refund_id),
    refundReason: text(row.refundReason || row.refund_reason),
    refundHandling: text(row.refundHandling || row.refund_handling),
    refundAmount,
    refunds: refundAmount,
    locationName: text(row.locationName) || 'Unmapped Location',
    menuItemName: text(row.menuItemName) || 'Unmapped Menu Item',
    menuCategory: text(row.menuCategory) || 'Uncategorised',
    parentLineId: text(row.parentLineId || row.parent_line_id),
    menuItemSaleKey: text(row.menuItemSaleKey || row.menu_item_sale_key || `${row.receiptNumber || ''}|${row.parentLineId || row.parent_line_id || row.sourceId || row.id || ''}`),
    menuItemGrossAmount: safeNumber(row.menuItemGrossAmount ?? row.menu_item_gross_amount ?? grossAmount),
    menuItemRefundAmount: safeNumber(row.menuItemRefundAmount ?? row.menu_item_refund_amount ?? refundAmount),
    menuItemVatAmount: safeNumber(row.menuItemVatAmount ?? row.menu_item_vat_amount ?? vatAmount),
    menuItemNetAmount: safeNumber(row.menuItemNetAmount ?? row.menu_item_net_amount ?? netAmount),
    menuItemBaseStockCost: safeNumber(row.menuItemBaseStockCost ?? row.menu_item_base_stock_cost),
    menuItemModifierStockCost: safeNumber(row.menuItemModifierStockCost ?? row.menu_item_modifier_stock_cost ?? stockCost),
    menuItemTotalStockCost: safeNumber(row.menuItemTotalStockCost ?? row.menu_item_total_stock_cost ?? stockCost),
    menuItemGrossProfit: safeNumber(row.menuItemGrossProfit ?? row.menu_item_gross_profit ?? calculateGrossProfit(netAmount, stockCost)),
    menuItemGpPercent: safeNumber(row.menuItemGpPercent ?? row.menu_item_gp_percent ?? calculateGpPercent(calculateGrossProfit(netAmount, stockCost), netAmount)),
    modifierGroupId: text(row.modifierGroupId),
    modifierGroupName: text(row.modifierGroupName) || 'Modifier Group',
    modifierId: text(row.modifierId || row.yocoModifierId),
    yocoModifierId: text(row.yocoModifierId || row.modifierId),
    modifierName: text(row.modifierName) || 'Yoco Modifier',
    modifierType,
    stockActionType,
    stockAction,
    qty: netSelections,
    saleQty,
    refundQty,
    timesSelected,
    refundedSelections,
    netSelections,
    grossAmount,
    vatAmount,
    netAmount,
    vatRate,
    isVatExempt,
    vatSource: text(row.vatSource || row.vat_source) || (isVatExempt ? 'zero-rated' : explicitVatUsable ? 'source' : 'calculated'),
    grossSales: grossAmount,
    vat: vatAmount,
    netSales: netAmount,
    linkedProduct: text(row.linkedProduct) || (modifierType === 'Product' ? text(row.modifierName) : ''),
    linkedStockItemName: text(row.linkedStockItemName),
    stockQuantityChange: safeNumber(row.stockQuantityChange ?? row.stock_quantity_change),
    stockQtyDeducted: safeNumber(row.stockQtyDeducted ?? row.stockDeducted ?? row.qtyDeducted),
    stockDeducted: safeNumber(row.stockDeducted ?? row.stockQtyDeducted ?? row.qtyDeducted),
    qtyDeducted: safeNumber(row.qtyDeducted ?? row.stockQtyDeducted ?? row.stockDeducted),
    wastageQty: safeNumber(row.wastageQty ?? row.wastage_qty),
    wastageCost: safeNumber(row.wastageCost ?? row.wastage_cost),
    accountingOnlyWastage: modifierBoolean(row.accountingOnlyWastage ?? row.accounting_only_wastage),
    baseUom: text(row.baseUom),
    unitCostExVat: safeNumber(row.unitCostExVat),
    stockCost,
    grossProfit,
    gpPercent: calculateGpPercent(grossProfit, netAmount),
    stockDeductionStatus: text(row.stockDeductionStatus) || 'No Stock Mapping Required',
    createdBy: text(row.createdBy),
    sourceId: text(row.sourceId || row.id),
    sourceType: text(row.sourceType || 'Modifier Usage')
  };
}

function buildModifierSummary(rows = []) {
  const groupTotals = new Map();
  for (const [groupKey, groupRows] of groupBy(rows, (row) => row.modifierGroupId || row.modifierGroupName)) {
    groupTotals.set(groupKey, sumBy(groupRows, 'timesSelected'));
  }
  return Array.from(groupBy(rows, (row) => [row.modifierGroupId || row.modifierGroupName, row.modifierId || row.modifierName].join('::')).entries()).map(([key, groupRows], index) => {
    const first = groupRows[0] || {};
    const groupKey = first.modifierGroupId || first.modifierGroupName;
    const timesSelected = sumBy(groupRows, 'timesSelected');
    const refundedSelections = sumBy(groupRows, 'refundedSelections');
    const netSelections = timesSelected - refundedSelections;
    const grossSales = sumBy(groupRows, 'grossAmount');
    const refundAmount = sumBy(groupRows, 'refundAmount');
    const vat = sumBy(groupRows, 'vatAmount');
    const netSales = sumBy(groupRows, 'netAmount');
    const stockDeducted = sumBy(groupRows, 'stockQtyDeducted');
    const stockCost = sumBy(groupRows, 'stockCost');
    const grossProfit = calculateGrossProfit(netSales, stockCost);
    return {
      id: `modifier-summary:${key || index}`,
      modifierGroupName: first.modifierGroupName,
      modifierName: first.modifierName,
      modifierType: mixedOrFirst(groupRows, 'modifierType'),
      stockActionType: mixedOrFirst(groupRows, 'stockActionType'),
      stockAction: mixedOrFirst(groupRows, 'stockAction'),
      timesSelected,
      refundedSelections,
      netSelections,
      groupTotalSelections: groupTotals.get(groupKey) || timesSelected,
      selectedPercent: (groupTotals.get(groupKey) || 0) ? timesSelected / groupTotals.get(groupKey) : 0,
      grossSales,
      refundAmount,
      vat,
      netSales,
      stockDeducted,
      baseUom: mixedOrFirst(groupRows, 'baseUom'),
      unitCostExVat: stockDeducted ? roundMoney(stockCost / stockDeducted) : 0,
      stockCost,
      grossProfit,
      gpPercent: calculateGpPercent(grossProfit, netSales),
      stockDeductionStatus: mostSevereStatus(groupRows),
      linkedProduct: mixedOrFirst(groupRows, 'linkedProduct'),
      linkedStockItemName: mixedOrFirst(groupRows, 'linkedStockItemName'),
      __rows: groupRows
    };
  });
}

function toGpTrackerRow(row = {}) {
  return {
    ...row,
    qtySelected: row.timesSelected,
    refundedSelections: row.refundedSelections,
    netSelections: row.netSelections,
    averageSellingPrice: row.timesSelected ? roundMoney(row.grossSales / row.timesSelected) : 0,
    grossModifierSales: row.grossSales,
    refundAmount: row.refundAmount,
    netModifierSales: row.netSales,
    qtyDeducted: row.stockDeducted
  };
}

function buildByGroup(rows = []) {
  return Array.from(groupBy(rows, (row) => row.modifierGroupId || row.modifierGroupName).entries()).map(([key, groupRows], index) => {
    const first = groupRows[0] || {};
    const grossSales = sumBy(groupRows, 'grossAmount');
    const refundAmount = sumBy(groupRows, 'refundAmount');
    const refundedSelections = sumBy(groupRows, 'refundedSelections');
    const netSelections = sumBy(groupRows, 'netSelections');
    const vat = sumBy(groupRows, 'vatAmount');
    const netSales = sumBy(groupRows, 'netAmount');
    const stockCost = sumBy(groupRows, 'stockCost');
    const grossProfit = calculateGrossProfit(netSales, stockCost);
    return {
      id: `modifier-group:${key || index}`,
      modifierGroupName: first.modifierGroupName,
      modifierType: mixedOrFirst(groupRows, 'modifierType'),
      stockActionType: mixedOrFirst(groupRows, 'stockActionType'),
      stockAction: mixedOrFirst(groupRows, 'stockAction'),
      totalSelections: sumBy(groupRows, 'timesSelected'),
      refundedSelections,
      netSelections,
      grossSales,
      refundAmount,
      vat,
      netSales,
      stockCost,
      grossProfit,
      gpPercent: calculateGpPercent(grossProfit, netSales),
      topModifier: topModifier(groupRows),
      stockDeductionIssues: groupRows.filter((row) => /missing/i.test(row.stockDeductionStatus)).length,
      __rows: groupRows
    };
  });
}

function buildByMenuItem(rows = []) {
  return Array.from(groupBy(rows, (row) => row.menuItemId || row.menuItemName).entries()).map(([key, groupRows], index) => {
    const first = groupRows[0] || {};
    const uniqueLines = new Map();
    groupRows.forEach((row, rowIndex) => {
      const lineKey = text(row.menuItemSaleKey || `${row.receiptNumber || 'receipt'}|${row.parentLineId || row.sourceId || rowIndex}`);
      if (!uniqueLines.has(lineKey)) uniqueLines.set(lineKey, row);
    });
    const saleLines = [...uniqueLines.values()];
    const grossMenuSales = sumBy(saleLines, 'menuItemGrossAmount');
    const menuItemRefundAmount = sumBy(saleLines, 'menuItemRefundAmount');
    const refundedSelections = sumBy(groupRows, 'refundedSelections');
    const netSelections = sumBy(groupRows, 'netSelections');
    const vat = sumBy(saleLines, 'menuItemVatAmount');
    const netMenuSales = sumBy(saleLines, 'menuItemNetAmount');
    const baseStockCost = sumBy(saleLines, 'menuItemBaseStockCost');
    const modifierStockCost = sumBy(saleLines, 'menuItemModifierStockCost');
    const totalStockCost = sumBy(saleLines, 'menuItemTotalStockCost');
    const grossProfit = calculateGrossProfit(netMenuSales, totalStockCost);
    return {
      id: `modifier-menu-item:${key || index}`,
      menuItemName: first.menuItemName,
      modifierSelections: sumBy(groupRows, 'timesSelected'),
      refundedSelections,
      netSelections,
      grossMenuSales,
      menuItemRefundAmount,
      vat,
      netMenuSales,
      baseStockCost,
      modifierStockCost,
      totalStockCost,
      grossProfit,
      gpPercent: calculateGpPercent(grossProfit, netMenuSales),
      stockDeductionStatus: mostSevereStatus(groupRows),
      __rows: groupRows,
      __saleLines: saleLines
    };
  });
}

function buildByModifier(rows = []) {
  return buildModifierSummary(rows).map((row) => ({
    ...row,
    id: `modifier-only:${row.id}`,
    linkedStockItemName: row.linkedStockItemName,
    vat: row.vat || sumBy(row.__rows, 'vatAmount')
  }));
}

function toSalesLogRow(row = {}) {
  return { ...row };
}

function modifierTotals(rows = [], view = 'summary') {
  const net = sumBy(rows, (row) => row.netSales ?? row.netModifierSales ?? row.netAmount);
  const grossProfit = sumBy(rows, 'grossProfit');
  const totals = {
    timesSelected: sumBy(rows, (row) => row.timesSelected ?? row.qtySelected),
    refundedSelections: sumBy(rows, 'refundedSelections'),
    netSelections: sumBy(rows, 'netSelections'),
    selectedPercent: undefined,
    grossSales: sumBy(rows, (row) => row.grossSales ?? row.grossModifierSales ?? row.grossAmount),
    refundAmount: sumBy(rows, (row) => row.refundAmount ?? row.refunds),
    netSales: net,
    stockDeducted: sumBy(rows, (row) => row.stockDeducted ?? row.qtyDeducted ?? row.stockQtyDeducted),
    stockCost: sumBy(rows, 'stockCost'),
    modifierSelections: sumBy(rows, (row) => row.modifierSelections ?? row.timesSelected),
    grossMenuSales: sumBy(rows, (row) => row.grossMenuSales ?? row.menuItemGrossAmount),
    menuItemRefundAmount: sumBy(rows, (row) => row.menuItemRefundAmount ?? row.refundAmount),
    netMenuSales: sumBy(rows, (row) => row.netMenuSales ?? row.menuItemNetAmount),
    baseStockCost: sumBy(rows, (row) => row.baseStockCost ?? row.menuItemBaseStockCost),
    modifierStockCost: sumBy(rows, (row) => row.modifierStockCost ?? row.menuItemModifierStockCost),
    totalStockCost: sumBy(rows, (row) => row.totalStockCost ?? row.menuItemTotalStockCost),
    grossProfit,
    gpPercent: calculateGpPercent(grossProfit, net),
    qtySelected: sumBy(rows, (row) => row.qtySelected ?? row.timesSelected),
    averageSellingPrice: 0,
    grossModifierSales: sumBy(rows, (row) => row.grossModifierSales ?? row.grossSales ?? row.grossAmount),
    vat: sumBy(rows, (row) => row.vat ?? row.vatAmount),
    netModifierSales: sumBy(rows, (row) => row.netModifierSales ?? row.netSales ?? row.netAmount),
    qtyDeducted: sumBy(rows, (row) => row.qtyDeducted ?? row.stockDeducted ?? row.stockQtyDeducted),
    totalSelections: sumBy(rows, (row) => row.totalSelections ?? row.timesSelected),
    stockDeductionIssues: sumBy(rows, 'stockDeductionIssues'),
    qty: sumBy(rows, 'qty'),
    grossAmount: sumBy(rows, 'grossAmount'),
    refunds: sumBy(rows, (row) => row.refundAmount ?? row.refunds),
    vatAmount: sumBy(rows, 'vatAmount'),
    netAmount: sumBy(rows, 'netAmount'),
    stockQtyDeducted: sumBy(rows, 'stockQtyDeducted'),
    wastageQty: sumBy(rows, 'wastageQty')
  };
  totals.averageSellingPrice = totals.qtySelected ? roundMoney(totals.grossModifierSales / totals.qtySelected) : 0;
  if (view === 'by_group') return pickTotals(totals, ['totalSelections', 'refundedSelections', 'netSelections', 'grossSales', 'refundAmount', 'vat', 'netSales', 'stockCost', 'grossProfit', 'gpPercent', 'stockDeductionIssues']);
  if (view === 'gp_tracker') return pickTotals(totals, ['qtySelected', 'refundedSelections', 'netSelections', 'averageSellingPrice', 'grossModifierSales', 'refundAmount', 'vat', 'netModifierSales', 'qtyDeducted', 'stockCost', 'grossProfit', 'gpPercent']);
  if (view === 'by_menu_item') {
    const totalGrossProfit = calculateGrossProfit(totals.netMenuSales, totals.totalStockCost);
    return {
      ...pickTotals(totals, ['modifierSelections', 'refundedSelections', 'netSelections', 'grossMenuSales', 'menuItemRefundAmount', 'vat', 'netMenuSales', 'baseStockCost', 'modifierStockCost', 'totalStockCost']),
      grossProfit: totalGrossProfit,
      gpPercent: calculateGpPercent(totalGrossProfit, totals.netMenuSales)
    };
  }
  if (view === 'by_modifier') return pickTotals(totals, ['timesSelected', 'refundedSelections', 'netSelections', 'stockDeducted', 'grossSales', 'refundAmount', 'vat', 'netSales', 'stockCost', 'grossProfit', 'gpPercent']);
  if (view === 'sales_log') return pickTotals(totals, ['qty', 'grossAmount', 'refunds', 'vatAmount', 'netAmount', 'stockQtyDeducted', 'wastageQty', 'stockCost', 'grossProfit']);
  return pickTotals(totals, ['timesSelected', 'refundedSelections', 'netSelections', 'grossSales', 'refundAmount', 'netSales', 'stockDeducted', 'stockCost', 'grossProfit', 'gpPercent']);
}

function validateModifierRows(rows = []) {
  const modifierRows = toArray(rows).filter((row) => row.modifierName || row.modifierGroupName || row.sourceType === 'Modifier Usage');
  return [
    warning(modifierRows, (row) => !text(row.yocoModifierId || row.modifierId) && !row.orphanUsage, 'modifier-sale-missing-yoco-modifier-id', 'critical', 'Modifier sale row has no YOCO modifier ID.'),
    warning(modifierRows, (row) => !text(row.receiptNumber), 'modifier-sale-missing-receipt-number', 'warning', 'Modifier sale row has no receipt number.'),
    warning(modifierRows, (row) => !text(row.modifierGroupName), 'modifier-group-missing', 'critical', 'Modifier group is missing.'),
    warning(modifierRows, (row) => !text(row.modifierName), 'modifier-name-missing', 'critical', 'Modifier name is missing.'),
    warning(modifierRows, (row) => !text(row.modifierType), 'modifier-type-missing', 'critical', 'Modifier type is missing.'),
    warning(modifierRows, (row) => row.grossAmount === undefined && row.grossSales === undefined, 'modifier-gross-amount-missing', 'warning', 'Gross amount is missing.'),
    warning(modifierRows, (row) => safeNumber(row.grossAmount ?? row.grossSales) > 0 && safeNumber(row.netAmount ?? row.netSales) === 0, 'modifier-vat-net-cannot-calculate', 'critical', 'VAT/net cannot be calculated.'),
    warning(modifierRows, (row) => row.modifierMarkedStockDeducting === true && !text(row.linkedStockItemName || row.linkedStockItemId), 'modifier-stock-item-missing', 'critical', 'Stock-deducting modifier has no linked stock item.'),
    warning(modifierRows, (row) => row.modifierMarkedStockDeducting === true && row.hasModifierUsage === false, 'modifier-usage-row-missing', 'critical', 'Stock-deducting modifier has no Modifier Usage row.'),
    warning(modifierRows, (row) => row.hasModifierUsage === true && safeNumber(row.stockQtyDeducted ?? row.stockDeducted) === 0 && safeNumber(row.wastageQty) === 0 && !row.accountingOnlyWastage, 'modifier-usage-qty-missing', 'critical', 'Modifier Usage row has no physical or wastage qty.'),
    warning(modifierRows, (row) => row.hasModifierUsage === true && safeNumber(row.unitCostExVat) === 0 && safeNumber(row.stockQtyDeducted ?? row.stockDeducted) !== 0, 'modifier-usage-unit-cost-missing', 'critical', 'Modifier Usage row has no unit cost.'),
    warning(modifierRows, (row) => row.hasModifierUsage === true && !text(row.sourceId), 'modifier-usage-source-id-missing', 'critical', 'Modifier Usage row has no source ID.'),
    warning(modifierRows, (row) => row.orphanUsage === true, 'modifier-usage-not-linked-to-yoco-line', 'warning', 'Modifier Usage row cannot be linked back to YOCO sale modifier line.'),
    warning(modifierRows, (row) => !Number.isFinite(safeNumber(row.gpPercent, NaN)) && safeNumber(row.netSales ?? row.netAmount) !== 0, 'modifier-gp-cannot-calculate', 'critical', 'GP cannot be calculated.')
  ].filter(Boolean);
}

function warning(rows, predicate, code, level, message) {
  const count = toArray(rows).filter(predicate).length;
  return count ? { code, level, message: `${count} ${message}` } : null;
}

function rememberModifierModel(services = {}, model = {}, payload = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastModifierReportModel = model;
  services.reporting.__lastModifierReportPayload = payload;
}

function withModifierMeta(row = {}, payload = {}) {
  return { ...row, __apiMeta: payload.meta || row.__apiMeta };
}

function pickTotals(source, keys) {
  return keys.reduce((out, key) => {
    out[key] = source[key];
    return out;
  }, { label: 'Totals' });
}


function normalizeModifierVatRate(value = 0) {
  const rate = safeNumber(value);
  return rate > 1 ? rate / 100 : rate;
}

function hasModifierValue(value) {
  return value !== undefined && value !== null && text(value) !== '' && Number.isFinite(Number(value));
}

function modifierBoolean(value) {
  return value === true || value === 1 || value === '1' || text(value).toLowerCase() === 'true';
}

function mixedOrFirst(rows = [], key = '') {
  const values = Array.from(new Set(toArray(rows).map((row) => text(row[key])).filter(Boolean)));
  if (values.length <= 1) return values[0] || '';
  return 'Mixed';
}

function mostSevereStatus(rows = []) {
  const statuses = toArray(rows).map((row) => text(row.stockDeductionStatus)).filter(Boolean);
  if (statuses.some((status) => /missing/i.test(status))) return statuses.find((status) => /missing/i.test(status));
  if (statuses.some((status) => /scrap|wastage/i.test(status))) return statuses.find((status) => /scrap|wastage/i.test(status));
  if (statuses.some((status) => /returned/i.test(status))) return statuses.find((status) => /returned/i.test(status));
  if (statuses.some((status) => /deducted/i.test(status))) return statuses.find((status) => /deducted/i.test(status));
  return statuses[0] || 'No Stock Mapping Required';
}

function topModifier(rows = []) {
  const grouped = Array.from(groupBy(rows, (row) => row.modifierName).entries()).map(([name, groupRows]) => ({ name, count: sumBy(groupRows, 'timesSelected') }));
  return grouped.sort((a, b) => b.count - a.count)[0]?.name || '';
}

function normalizeModifierStockActionType(value = '') {
  const action = text(value).toUpperCase();
  return ['ADD_RECIPE', 'ADD_STOCK_ITEM', 'REMOVE_INGREDIENT', 'REPLACE_INGREDIENT', 'NO_STOCK_CHANGE'].includes(action)
    ? action
    : '';
}

function modifierStockActionLabel(value = '') {
  return {
    ADD_RECIPE: 'Add recipe',
    ADD_STOCK_ITEM: 'Add stock item',
    REMOVE_INGREDIENT: 'Remove ingredient',
    REPLACE_INGREDIENT: 'Replace ingredient',
    NO_STOCK_CHANGE: 'No stock change'
  }[normalizeModifierStockActionType(value)] || 'Not recorded';
}

function normalizeModifierType(value = '') {
  const raw = text(value).toLowerCase();
  if (raw.includes('product')) return 'Product';
  if (raw.includes('note')) return 'Note';
  if (raw.includes('text')) return 'Note';
  if (raw.includes('option') || raw.includes('choice') || raw.includes('add-on') || raw.includes('addon')) return 'Option';
  return text(value) || 'Option';
}
