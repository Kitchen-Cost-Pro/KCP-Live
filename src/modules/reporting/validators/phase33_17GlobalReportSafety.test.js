import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCustomerActionableIssueText, filterCustomerActionableQualityRows, filterUserVisibleWarnings, isUserFixableWarning } from './warningCategories.js';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Phase 33.17 removes the 100000-row customer error path from every report loader', () => {
  const loader = read('src/modules/reporting/api/reportPageLoader.js');
  const worker = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  const phase21 = read('cloudflare-v2/src/legacy/reporting-phase21-routes.ts');

  assert.doesNotMatch(loader, /One filtered report partition still exceeds/);
  assert.doesNotMatch(loader, /Apply a narrower filter before rendering or exporting/);
  assert.match(loader, /sourceCapRecovered/);
  assert.match(worker, /const MAX_REPORT_ROWS = 1000000/);
  assert.match(phase21, /const MAX_ROWS = 1000000/);
  assert.match(worker, /hasExplicitTruncationState \? extra\.truncated === true : false/);
  assert.match(phase21, /const truncated = extra\.truncated === true/);
});

test('Phase 33.17 exposes only customer-fixable data quality issues', () => {
  const warnings = [
    { code: 'missing-receipt-number', level: 'warning', message: 'Sale row has no receipt number.' },
    { code: 'missing-source-id', level: 'critical', message: 'Ledger row is missing source ID.' },
    { code: 'webhook-signature-invalid', level: 'critical', message: 'Webhook signature is invalid.' },
    { code: 'missing-location-name', level: 'critical', message: 'Stock item has a location id but no location name.' },
    { code: 'missing-price', level: 'critical', message: 'Menu item has no selling price.' },
    { code: 'missing-recipe', level: 'critical', message: 'Menu item is missing a recipe.' },
    { code: 'missing-item-name', level: 'critical', message: 'Stock item is missing a name.' }
  ];

  const visible = filterUserVisibleWarnings(warnings);
  assert.deepEqual(visible.map((warning) => warning.code), [
    'missing-location-name',
    'missing-price',
    'missing-recipe',
    'missing-item-name'
  ]);
  assert.equal(isUserFixableWarning(warnings[0]), false);
  assert.equal(isUserFixableWarning(warnings[3]), true);
});

test('Phase 33.17 filters system-owned Inventory Audit data-quality rows', () => {
  const audit = read('src/modules/reporting/reports/audit/inventoryAuditReport.js');
  assert.match(audit, /data_quality:.*filter\(isCustomerActionableQualityRow\)/);
  assert.match(audit, /isUserFixableWarning/);
});


test('Phase 33.17 filters system-owned row notes and warning views', () => {
  assert.equal(
    filterCustomerActionableIssueText('Missing recipe; Receipt ID is missing; Webhook signature invalid; Missing selling price'),
    'Missing recipe; Missing selling price'
  );

  const rows = filterCustomerActionableQualityRows([
    { issueType: 'Missing source ID', issue: 'Ledger source ID is missing.' },
    { issueType: 'Missing item name', issue: 'Stock item name is missing.' },
    { issueType: 'Missing location', issue: 'Stock item location is missing.' }
  ]);
  assert.deepEqual(rows.map((row) => row.issueType), ['Missing item name', 'Missing location']);
});
