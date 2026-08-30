import { fetchSalesFinancialRows } from '../../api/reportingApi.js';
import { formatMoney } from '../../engine/formatters.js';
import { text, toArray } from '../../engine/grouping.js';
import { validateSalesFinancialRows } from '../../validators/salesUsageValidators.js';
import { buildRowWarnings } from '../../validators/rowWarningUtils.js';
import { buildPaymentModel, moneyTooltip, paymentTotals } from './salesReportHelpers.js';
import { PAYOUT_TOLERANCE } from '../../engine/yocoFinancials.js';

const paymentSummaryMoneyTooltip = (label, key) => (row) => moneyTooltip(key, `${label}: ${formatMoney(row[label] ?? row[key] ?? 0)}`);

const dailySummaryColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'grossSales', label: 'Gross Sales', type: 'money', align: 'right', tooltipKey: 'grossSales', sortable: true },
  { key: 'vat', label: 'VAT', type: 'money', align: 'right', tooltipKey: 'salesVat', cellTooltip: salesVatTooltip, sortable: true },
  { key: 'netSales', label: 'Net Sales', type: 'money', align: 'right', tooltipKey: 'netSales', cellTooltip: netSalesTooltip, sortable: true },
  { key: 'tips', label: 'Tips', type: 'money', align: 'right', tooltipKey: 'tips', sortable: true },
  { key: 'refunds', label: 'Refunds (Gross)', type: 'money', align: 'right', tooltipKey: 'refunds', sortable: true },
  { key: 'refundVat', label: 'Refund VAT', type: 'money', align: 'right', tooltipKey: 'refundVat', sortable: true },
  { key: 'refundNet', label: 'Refund Ex VAT', type: 'money', align: 'right', tooltipKey: 'refundNet', sortable: true },
  { key: 'discounts', label: 'Discounts', type: 'money', align: 'right', tooltipKey: 'discounts', sortable: true },
  { key: 'fees', label: 'Fees', type: 'money', align: 'right', tooltipKey: 'fees', sortable: true },
  { key: 'payoutAmount', label: 'Payout Amount', type: 'money', align: 'right', tooltipKey: 'payoutAmount', cellTooltip: payoutTooltip, sortable: true },
  { key: 'transactionCount', label: 'Transaction Count', type: 'number', align: 'right', sortable: true }
];

const byPaymentMethodColumns = [
  { key: 'paymentMethod', label: 'Payment Method', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'grossSales', label: 'Gross Sales', type: 'money', align: 'right', tooltipKey: 'grossSales', sortable: true },
  { key: 'vat', label: 'VAT', type: 'money', align: 'right', tooltipKey: 'salesVat', cellTooltip: salesVatTooltip, sortable: true },
  { key: 'netSales', label: 'Net Sales', type: 'money', align: 'right', tooltipKey: 'netSales', cellTooltip: netSalesTooltip, sortable: true },
  { key: 'tips', label: 'Tips', type: 'money', align: 'right', tooltipKey: 'tips', sortable: true },
  { key: 'refunds', label: 'Refunds (Gross)', type: 'money', align: 'right', tooltipKey: 'refunds', sortable: true },
  { key: 'refundVat', label: 'Refund VAT', type: 'money', align: 'right', tooltipKey: 'refundVat', sortable: true },
  { key: 'refundNet', label: 'Refund Ex VAT', type: 'money', align: 'right', tooltipKey: 'refundNet', sortable: true },
  { key: 'discounts', label: 'Discounts', type: 'money', align: 'right', tooltipKey: 'discounts', sortable: true },
  { key: 'fees', label: 'Fees', type: 'money', align: 'right', tooltipKey: 'fees', sortable: true },
  { key: 'payoutAmount', label: 'Payout Amount', type: 'money', align: 'right', tooltipKey: 'payoutAmount', cellTooltip: payoutTooltip, sortable: true },
  { key: 'transactionCount', label: 'Transaction Count', type: 'number', align: 'right', sortable: true },
  { key: 'averageTransactionValue', label: 'Average Transaction Value', type: 'money', align: 'right', tooltipKey: 'averageTransactionValue', sortable: true }
];

const byLocationColumns = [
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'grossSales', label: 'Gross Sales', type: 'money', align: 'right', tooltipKey: 'grossSales', sortable: true },
  { key: 'vat', label: 'VAT', type: 'money', align: 'right', tooltipKey: 'salesVat', cellTooltip: salesVatTooltip, sortable: true },
  { key: 'netSales', label: 'Net Sales', type: 'money', align: 'right', tooltipKey: 'netSales', cellTooltip: netSalesTooltip, sortable: true },
  { key: 'tips', label: 'Tips', type: 'money', align: 'right', tooltipKey: 'tips', sortable: true },
  { key: 'refunds', label: 'Refunds (Gross)', type: 'money', align: 'right', tooltipKey: 'refunds', sortable: true },
  { key: 'refundVat', label: 'Refund VAT', type: 'money', align: 'right', tooltipKey: 'refundVat', sortable: true },
  { key: 'refundNet', label: 'Refund Ex VAT', type: 'money', align: 'right', tooltipKey: 'refundNet', sortable: true },
  { key: 'discounts', label: 'Discounts', type: 'money', align: 'right', tooltipKey: 'discounts', sortable: true },
  { key: 'fees', label: 'Fees', type: 'money', align: 'right', tooltipKey: 'fees', sortable: true },
  { key: 'payoutAmount', label: 'Payout Amount', type: 'money', align: 'right', tooltipKey: 'payoutAmount', cellTooltip: payoutTooltip, sortable: true },
  { key: 'transactionCount', label: 'Transaction Count', type: 'number', align: 'right', sortable: true },
  { key: 'refundCount', label: 'Refund Count', type: 'number', align: 'right', sortable: true }
];

const transactionDetailColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'time', label: 'Time', type: 'time', sortable: true },
  { key: 'receiptNumber', label: 'Receipt Number', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'paymentMethod', label: 'Payment Method', sortable: true },
  { key: 'grossAmount', label: 'Gross Sales', type: 'money', align: 'right', tooltipKey: 'grossSales', sortable: true },
  { key: 'vatAmount', label: 'VAT', type: 'money', align: 'right', tooltipKey: 'salesVat', cellTooltip: salesVatDetailTooltip, sortable: true },
  { key: 'netAmount', label: 'Net Sales', type: 'money', align: 'right', tooltipKey: 'netSales', cellTooltip: netAmountDetailTooltip, sortable: true },
  { key: 'tipAmount', label: 'Tips', type: 'money', align: 'right', tooltipKey: 'tips', sortable: true },
  { key: 'refundAmount', label: 'Refund Gross', type: 'money', align: 'right', tooltipKey: 'refunds', sortable: true },
  { key: 'refundVatAmount', label: 'Refund VAT', type: 'money', align: 'right', tooltipKey: 'refundVat', sortable: true },
  { key: 'refundNetAmount', label: 'Refund Ex VAT', type: 'money', align: 'right', tooltipKey: 'refundNet', sortable: true },
  { key: 'refundReason', label: 'Refund Reason', sortable: true },
  { key: 'refundHandling', label: 'Refund Handling', sortable: true },
  { key: 'refundId', label: 'Refund ID', sortable: true },
  { key: 'discountAmount', label: 'Discounts', type: 'money', align: 'right', tooltipKey: 'discounts', sortable: true },
  { key: 'feeAmount', label: 'Fees', type: 'money', align: 'right', tooltipKey: 'fees', sortable: true },
  { key: 'payoutAmount', label: 'Payout Amount', type: 'money', align: 'right', tooltipKey: 'payoutAmount', cellTooltip: payoutDetailTooltip, sortable: true },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];


const dailySummaryExportMapping = {
  date: 'Date',
  locationName: 'Location',
  grossSales: 'Gross Sales',
  vat: 'VAT',
  netSales: 'Net Sales',
  tips: 'Tips',
  refunds: 'Refunds (Gross)',
  refundVat: 'Refund VAT',
  refundNet: 'Refund Ex VAT',
  discounts: 'Discounts',
  fees: 'Fees',
  payoutAmount: 'Payout Amount',
  transactionCount: 'Transaction Count'
};

const byPaymentMethodExportMapping = {
  paymentMethod: 'Payment Method',
  locationName: 'Location',
  grossSales: 'Gross Sales',
  vat: 'VAT',
  netSales: 'Net Sales',
  tips: 'Tips',
  refunds: 'Refunds (Gross)',
  refundVat: 'Refund VAT',
  refundNet: 'Refund Ex VAT',
  discounts: 'Discounts',
  fees: 'Fees',
  payoutAmount: 'Payout Amount',
  transactionCount: 'Transaction Count',
  averageTransactionValue: 'Average Transaction Value'
};

const byLocationExportMapping = {
  locationName: 'Location',
  grossSales: 'Gross Sales',
  vat: 'VAT',
  netSales: 'Net Sales',
  tips: 'Tips',
  refunds: 'Refunds (Gross)',
  refundVat: 'Refund VAT',
  refundNet: 'Refund Ex VAT',
  discounts: 'Discounts',
  fees: 'Fees',
  payoutAmount: 'Payout Amount',
  transactionCount: 'Transaction Count',
  refundCount: 'Refund Count'
};

const transactionExportMapping = {
  date: 'Date',
  time: 'Time',
  receiptNumber: 'Receipt Number',
  locationName: 'Location',
  paymentMethod: 'Payment Method',
  grossAmount: 'Gross Sales',
  vatAmount: 'VAT',
  netAmount: 'Net Sales',
  tipAmount: 'Tips',
  refundAmount: 'Refund Gross',
  refundVatAmount: 'Refund VAT',
  refundNetAmount: 'Refund Ex VAT',
  refundReason: 'Refund Reason',
  refundHandling: 'Refund Handling',
  refundId: 'Refund ID',
  discountAmount: 'Discounts',
  feeAmount: 'Fees',
  payoutAmount: 'Payout Amount',
  status: 'Status',
  createdBy: 'Created By',
  sourceId: 'Source ID'
};

export const paymentSalesFinancialReport = {
  id: 'payment_sales_financial',
  title: 'Payment / Sales Financial Report',
  section: 'sales',
  description: 'Accounting-friendly sales and payment report showing gross sales, VAT, net sales, tips, refunds, discounts, fees, and payout values.',
  emptyState: { title: 'No Yoco sales found', message: 'No Yoco sales found for the selected filters.' },
  suppressEmptyWarning: true,
  hiddenFromDashboard: true,
  defaultView: 'daily_summary',
  availableViews: ['daily_summary', 'by_payment_method', 'by_location', 'transaction_detail'],
  filterConfig: {
    daily_summary: ['search', 'dateRange', 'location', 'paymentMethod', 'status'],
    by_payment_method: ['search', 'dateRange', 'location', 'paymentMethod', 'status'],
    by_location: ['search', 'dateRange', 'location', 'paymentMethod', 'status'],
    transaction_detail: ['search', 'dateRange', 'location', 'paymentMethod', 'status', 'receiptNumber']
  },
  columns: {
    daily_summary: dailySummaryColumns,
    by_payment_method: byPaymentMethodColumns,
    by_location: byLocationColumns,
    transaction_detail: transactionDetailColumns
  },
  exportColumns: {
    daily_summary: dailySummaryColumns,
    by_payment_method: byPaymentMethodColumns,
    by_location: byLocationColumns,
    transaction_detail: transactionDetailColumns
  },
  getRows: async ({ workspaceId, filters, services = {}, view = 'daily_summary' }) => {
    const payload = services.reporting?.getSalesFinancialRows
      ? await services.reporting.getSalesFinancialRows({ workspaceId, filters })
      : await fetchSalesFinancialRows({ workspaceId, filters });
    const model = buildPaymentModel(payload.rows || []);
    rememberPaymentModel(services, model, payload);
    return (model.views[view] || model.views.daily_summary).map((row) => withPaymentMeta(row, payload));
  },
  getTotals: ({ rows, view }) => paymentTotals(rows, view === 'by_payment_method'),
  validate: ({ rows, services }) => [
    ...toArray(services?.reporting?.__lastPaymentSalesPayload?.warnings),
    ...validateSalesFinancialRows(rows),
    ...validatePaymentRows(rows)
  ],
  exportMapping: {
    daily_summary: dailySummaryExportMapping,
    by_payment_method: byPaymentMethodExportMapping,
    by_location: byLocationExportMapping,
    transaction_detail: transactionExportMapping
  }
};

function rememberPaymentModel(services = {}, model = {}, payload = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastPaymentSalesModel = model;
  services.reporting.__lastPaymentSalesPayload = payload;
}

function withPaymentMeta(row = {}, payload = {}) {
  return {
    ...row,
    __apiMeta: payload.meta,
    __reportSourceRows: payload.rows
  };
}

function validatePaymentRows(rows = []) {
  const warnings = [];
  const sourceRows = toArray(rows).flatMap((row) => toArray(row.__rows).length ? row.__rows : [row]);
  const add = (predicate, code, level, message) => {
    warnings.push(...buildRowWarnings(sourceRows, code, level, message, predicate));
  };
  add((row) => row.grossAmount === undefined || row.grossAmount === null || text(row.grossAmount) === '', 'gross-amount-missing', 'critical', 'Sales line is missing gross amount.');
  add((row) => row.netAmount === undefined || row.netAmount === null || text(row.netAmount) === '', 'net-amount-missing', 'critical', 'Sales line is missing net amount.');
  add((row) => row.vatAmount === undefined || row.vatAmount === null || text(row.vatAmount) === '', 'vat-amount-missing', 'warning', 'Sales line is missing VAT amount where VAT is expected.');
  add((row) => !text(row.locationName) || text(row.locationName) === 'Unmapped Location', 'location-missing', 'warning', 'Sales line is missing a mapped location.');
  add((row) => !text(row.sourceId), 'source-id-missing', 'critical', 'Sales line is missing YOCO transaction/source ID.');
  add((row) => !text(row.status) || text(row.status) === 'Unknown', 'transaction-status-missing', 'warning', 'Sales line is missing transaction status.');
  add((row) => Number(row.refundAmount) < 0, 'refund-negative', 'warning', 'Sales line has a negative refund value after standardisation.');
  add((row) => !payoutReconciles(row), 'payout-reconcile-failed', 'warning', 'Sales line could not reconcile payout amount from net sales plus tips less refunds and fees.');
  return warnings;
}

function payoutReconciles(row = {}) {
  const expected = Number(row.netAmount || 0) + Number(row.tipAmount || 0) - Number(row.refundAmount || 0) - Number(row.feeAmount || 0);
  return Math.abs(expected - Number(row.payoutAmount || 0)) <= PAYOUT_TOLERANCE;
}

function netSalesTooltip(row = {}) {
  return moneyTooltip('netSales', `${formatMoney(row.netSales)} = ${formatMoney(row.grossSales)} - ${formatMoney(row.vat)}`);
}

function salesVatTooltip(row = {}) {
  return moneyTooltip('salesVat', `${formatMoney(row.vat)} = ${formatMoney(row.grossSales)} - ${formatMoney(row.netSales)}`);
}

function payoutTooltip(row = {}) {
  return moneyTooltip('payoutAmount', `${formatMoney(row.payoutAmount)} = ${formatMoney(row.netSales)} + ${formatMoney(row.tips)} - ${formatMoney(row.refunds)} - ${formatMoney(row.fees)}`);
}

function netAmountDetailTooltip(row = {}) {
  if (row.isRefund === true) {
    return moneyTooltip('netSales', `${formatMoney(row.netAmount)} — refund value is shown separately in Refunds`);
  }
  return moneyTooltip('netSales', `${formatMoney(row.netAmount)} = ${formatMoney(row.grossAmount)} - ${formatMoney(row.vatAmount)}`);
}

function salesVatDetailTooltip(row = {}) {
  if (row.isRefund === true) {
    return moneyTooltip('salesVat', `${formatMoney(row.vatAmount)} — refund VAT is excluded from the sales VAT column`);
  }
  return moneyTooltip('salesVat', `${formatMoney(row.vatAmount)} = ${formatMoney(row.grossAmount)} - ${formatMoney(row.netAmount)}`);
}

function payoutDetailTooltip(row = {}) {
  return moneyTooltip('payoutAmount', `${formatMoney(row.payoutAmount)} = ${formatMoney(row.netAmount)} + ${formatMoney(row.tipAmount)} - ${formatMoney(row.refundAmount)} - ${formatMoney(row.feeAmount)}`);
}
