import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildPaymentModel, normalizeSalesFinancialRow } from './modules/reporting/reports/sales/salesReportHelpers.js';

const root = process.cwd();
const workerReporting = fs.readFileSync(path.join(root, 'cloudflare-v2/src/legacy/reporting-routes.ts'), 'utf8');
const refundResolver = fs.readFileSync(path.join(root, 'cloudflare-v2/src/modules/yoco-engine-v2/refund-resolver.ts'), 'utf8');
const liveRefund = fs.readFileSync(path.join(root, 'cloudflare-v2/src/modules/yoco-engine-v2/live-refund.ts'), 'utf8');
const schedulerWorker = fs.readFileSync(path.join(root, 'cloudflare-v2/src/legacy/report-scheduling-routes.ts'), 'utf8');
const schedulerPage = fs.readFileSync(path.join(root, 'src/modules/reporting/scheduling/SchedulingPage.js'), 'utf8');
const manufacturingCss = fs.readFileSync(path.join(root, 'src/styles/manufacturing.css'), 'utf8');
const reportingCss = fs.readFileSync(path.join(root, 'src/styles/reporting.css'), 'utf8');

test('refund financial rows inherit the original tender and merge into its payment summary row', () => {
  const model = buildPaymentModel([
    {
      id: 'sale-1', locationId: 'upstairs', locationName: 'Upstairs Bar', saleDate: '2026-07-16',
      status: 'completed', paymentMethod: 'cash', grossAmount: 450, vatAmount: 58.7, netAmount: 391.3
    },
    {
      id: 'refund-1', locationId: 'upstairs', locationName: 'Upstairs Bar', saleDate: '2026-07-16',
      status: 'refunded', orderType: 'refund', paymentMethod: 'refund', originalPaymentMethod: 'cash',
      refundGrossAmount: 450, refundVatAmount: 58.7, refundNetAmount: 391.3
    }
  ]);

  assert.equal(model.views.by_payment_method.length, 1);
  assert.equal(model.views.by_payment_method[0].paymentMethod, 'cash');
  assert.equal(model.views.by_payment_method[0].grossSales, 450);
  assert.equal(model.views.by_payment_method[0].refunds, 450);
  assert.equal(model.views.by_payment_method.some((row) => row.paymentMethod.toLowerCase() === 'refund'), false);
});

test('a refund with no recoverable original tender is labelled Unknown, never refund', () => {
  const row = normalizeSalesFinancialRow({
    id: 'refund-unknown', status: 'refunded', orderType: 'refund', paymentMethod: 'refund',
    refundGrossAmount: 100, saleDate: '2026-07-16'
  });
  assert.equal(row.paymentMethod, 'Unknown');
});

test('refund stock reporting resolves existing and future menu item identities', () => {
  assert.match(workerReporting, /COALESCE\(yol\.name, original_yol\.name\) AS line_name/);
  assert.match(workerReporting, /json_extract\(sm\.metadata_json, '\$\.sourceOriginalLineId'\)/);
  assert.match(workerReporting, /metadata\.productName \|\| metadata\.parentProductName \|\| row\.line_name/);
  assert.match(liveRefund, /productName:\s*canonicalLine\?\.source_name/);
  assert.match(liveRefund, /componentLineId:\s*p\.source_refund_line_id\s*\|\|\s*p\.source_original_line_id/);
});

test('refund resolver carries the original sale payment method into canonical reporting', () => {
  assert.match(refundResolver, /function originalOrderPaymentMethod/);
  assert.match(refundResolver, /originalOrderPaymentMethod\(originalOrder\)/);
  assert.match(workerReporting, /parent_yo\.payment_method AS original_payment_method/);
  assert.match(workerReporting, /NOT IN \('', 'refund'\)/);
});

test('scheduled saved views persist per report view and execute from stored snapshots', () => {
  assert.match(schedulerPage, /data-schedule-item-saved-view/);
  assert.match(schedulerPage, /savedViewSnapshotId/);
  assert.match(schedulerPage, /readScheduleForm\(form, catalog, savedViews, values\.reportItems\)/);
  assert.match(schedulerPage, /minor >= 19/);
  assert.match(schedulerWorker, /schedulerVersion: '33\.19'/);
  assert.match(schedulerWorker, /savedViewSnapshotId: saved\.id/);
  assert.match(schedulerWorker, /const itemFilters = \{ \.\.\.\(item\.filters \|\| \{\}\) \}/);
  assert.match(schedulerWorker, /const visibleColumns = item\.visibleColumns \|\| \[\]/);
});

test('manufacturing and saved-view action menus keep labels visible on hover', () => {
  assert.match(manufacturingCss, /manufacturingActionDropdown__menu button\.manufacturingDropdownOption:hover:not\(:disabled\)/);
  assert.match(manufacturingCss, /color: #ffffff !important/);
  assert.match(manufacturingCss, /visibility: visible !important/);
  assert.match(reportingCss, /reportActionMenu__panel \.reportSavedViews__load > span/);
  assert.match(reportingCss, /reportActionMenu__panel \.reportSavedViews__itemActions button/);
});
