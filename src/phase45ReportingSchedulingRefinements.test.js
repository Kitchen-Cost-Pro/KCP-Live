import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveYocoFinancialAmounts } from './modules/reporting/engine/yocoFinancials.js';
import { buildPaymentModel } from './modules/reporting/reports/sales/salesReportHelpers.js';
import { resolveDateRangePreset } from './modules/reporting/scheduling/dateRangePresets.js';

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
const scheduling = read('src/modules/reporting/scheduling/SchedulingPage.js');
const schedulingWorker = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');
const reportingCss = read('src/styles/reporting.css');
const reportTable = read('src/modules/reporting/tables/ReportTable.js');
const reportPagination = read('src/modules/reporting/tables/ReportPagination.js');
const modifierReport = read('src/modules/reporting/reports/sales/modifierReport.js');
const workerReporting = read('cloudflare-v2/src/legacy/reporting-routes.ts');

const fixedNow = new Date('2026-07-13T08:00:00.000Z');

test('Phase 45 scheduling uses a three-step report and view picker with report tooltips', () => {
  assert.match(scheduling, /<strong>Select reports<\/strong>/);
  assert.match(scheduling, /<strong>Reports in pack<\/strong>/);
  assert.match(scheduling, /<strong>Select views<\/strong>/);
  assert.match(scheduling, /data-schedule-report-select-button/);
  assert.match(scheduling, /data-schedule-report-open/);
  assert.match(scheduling, /data-schedule-view-toggle/);
  assert.match(scheduling, /data-report-tooltip/);
  assert.match(reportingCss, /\.reportScheduleReportGrid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('Phase 45 scheduling offers workspace recipients and removes custom subject and message fields', () => {
  assert.match(scheduling, /data-schedule-recipient-select/);
  assert.match(scheduling, /Existing workspace user/);
  assert.match(schedulingWorker, /listActiveScheduleRecipientUsers/);
  assert.match(schedulingWorker, /FROM workspace_members/);
  assert.doesNotMatch(scheduling, /name="emailSubject"|name="emailMessage"/);
});

test('Phase 45 scheduled XLSX and PDF files combine all selected views per report and location', () => {
  assert.match(schedulingWorker, /groupScheduledOutputsByReport\(outputs\)/);
  assert.match(schedulingWorker, /buildCombinedXlsxAttachment\(group\)/);
  assert.match(schedulingWorker, /buildCombinedPdfAttachment\(group\)/);
  assert.match(schedulingWorker, /reportResultsToExcelBytes\(payloads/);
  assert.match(schedulingWorker, /reportResultsToPdfBytes\(payloads/);
});

test('Phase 45 date ranges default to Today and support two-day, one-week, and two-week periods', () => {
  assert.deepEqual(resolveDateRangePreset('today', { now: fixedNow }), {
    dateRangeType: 'today', startDate: '2026-07-13', endDate: '2026-07-13'
  });
  assert.deepEqual(resolveDateRangePreset('last_2_days', { now: fixedNow }), {
    dateRangeType: 'last_2_days', startDate: '2026-07-12', endDate: '2026-07-13'
  });
  assert.deepEqual(resolveDateRangePreset('last_7_days', { now: fixedNow }), {
    dateRangeType: 'last_7_days', startDate: '2026-07-07', endDate: '2026-07-13'
  });
  assert.deepEqual(resolveDateRangePreset('last_14_days', { now: fixedNow }), {
    dateRangeType: 'last_14_days', startDate: '2026-06-30', endDate: '2026-07-13'
  });
  assert.match(schedulingWorker, /date_range_type:\s*`TEXT NOT NULL DEFAULT 'today'`/);
});

test('Phase 45 payment reporting excludes tips from taxable gross and keeps refund deductions separate from net sales', () => {
  const sale = deriveYocoFinancialAmounts({
    persistedTotal: 117,
    configuredVatRate: 15,
    status: 'completed',
    raw: {
      amounts: {
        tip_amount: { amount: 200, currency: 'ZAR' },
        tax_amount: { amount: 1500, currency: 'ZAR' }
      }
    }
  });
  assert.equal(sale.grossAmount, 115);
  assert.equal(sale.vatAmount, 15);
  assert.equal(sale.netAmount, 100);
  assert.equal(sale.tipAmount, 2);
  assert.equal(sale.payoutAmount, 102);

  const refund = deriveYocoFinancialAmounts({
    persistedTotal: -115,
    configuredVatRate: 15,
    orderType: 'refund',
    status: 'refunded',
    raw: {}
  });
  assert.equal(refund.refundAmount, 115);
  assert.equal(refund.vatAmount, -15);
  assert.equal(refund.netAmount, -100);
  assert.equal(refund.payoutAmount, -115);

  const model = buildPaymentModel([
    { id: 'sale', saleDate: '2026-07-13', locationName: 'Main', status: 'completed', ...sale },
    { id: 'refund', saleDate: '2026-07-13', locationName: 'Main', status: 'refunded', ...refund }
  ]);
  const summary = model.views.by_location[0];
  assert.equal(summary.grossSales, 115);
  assert.equal(summary.refunds, 115);
  assert.equal(summary.vat, 15);
  assert.equal(summary.netSales, 100);
  assert.equal(summary.tips, 2);
  assert.equal(summary.payoutAmount, -13);
  assert.equal(summary.refundCount, 1);
});

test('Phase 45 report tables use themed headers, aligned cells, and an upward-opening pagination selector', () => {
  assert.match(reportPagination, /data-report-select-placement="top"/);
  assert.match(reportingCss, /\.reportEnhancedSelect--top \.reportEnhancedSelect__menu[\s\S]*bottom:\s*calc\(100% \+ \.35rem\)/);
  assert.match(reportingCss, /\.reportViewer \.reportTable th[\s\S]*var\(--accent-blue\)/);
  assert.match(reportTable, /const align = resolveColumnAlign\(column\)/);
  assert.match(reportTable, /text-align:\$\{escapeHtml\(alignValue\)\}/);
});

test('Phase 45 Modifier by Menu Item GP includes base recipe and modifier stock cost', () => {
  assert.match(modifierReport, /Base Recipe Stock Cost/);
  assert.match(modifierReport, /Modifier Stock Cost/);
  assert.match(modifierReport, /Total Stock Cost/);
  assert.match(modifierReport, /Total GP %/);
  assert.match(modifierReport, /calculateGrossProfit\(netMenuSales, totalStockCost\)/);
  assert.match(workerReporting, /menuItemBaseStockCost/);
  assert.match(workerReporting, /menuItemModifierStockCost/);
  assert.match(workerReporting, /menuItemTotalStockCost/);
});
