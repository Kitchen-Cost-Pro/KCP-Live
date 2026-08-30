import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KCP_PDF_THEME, kcpPdfTableTheme } from './utils/pdfTheme.js';
import { reportToPdfDocument } from './modules/reporting/exports/exportPdf.js';

const adjustmentCss = fs.readFileSync(new URL('./styles/adjustments.css', import.meta.url), 'utf8');
const reportingCss = fs.readFileSync(new URL('./styles/reporting.css', import.meta.url), 'utf8');
const pdfSources = [
  './services/dataService.js',
  './modules/reporting/exports/exportPdf.js',
  './modules/reporting/transactions/transactionDetailExports.js',
  './main.js'
].map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

test('Phase 66 wastage dropdown options provide visible hover and keyboard focus feedback', () => {
  assert.match(adjustmentCss, /\.adj-dropdownMenu button:hover,[\s\S]*\.adj-dropdownMenu button:focus-visible/);
  assert.match(adjustmentCss, /box-shadow:\s*inset 3px 0 0 var\(--accent-blue/);
  assert.match(adjustmentCss, /transform:\s*translateX\(2px\)/);
});

test('Phase 66 report Actions items visibly react across exports, saved views, and column items', () => {
  assert.match(reportingCss, /\.reportActionMenu__panel button:hover,[\s\S]*border-color:\s*color-mix/);
  assert.match(reportingCss, /\.reportSavedViews__item:focus-within/);
  assert.match(reportingCss, /\.reportColumnVisibility--embedded label:focus-within/);
  assert.match(reportingCss, /box-shadow:\s*inset 3px 0 0 var\(--accent-blue/);
});

test('Phase 66 central PDF theme uses KCP blue surfaces rather than black headers', () => {
  const theme = kcpPdfTableTheme();
  assert.deepEqual(theme.headStyles.fillColor, KCP_PDF_THEME.accentDark);
  assert.deepEqual(theme.headStyles.textColor, KCP_PDF_THEME.white);
  assert.notDeepEqual(theme.headStyles.fillColor, [0, 0, 0]);
  assert.notDeepEqual(theme.headStyles.fillColor, [17, 24, 39]);
  assert.doesNotMatch(pdfSources, /fillColor:\s*\[17,\s*24,\s*39\]/);
  assert.doesNotMatch(pdfSources, /textColor:\s*\[0,\s*0,\s*0\]/);
});

test('Phase 66 manual and scheduled reporting PDFs render with the shared KCP palette', async () => {
  const doc = await reportToPdfDocument({
    title: 'Wastage Report',
    view: 'summary',
    report: { title: 'Wastage Report', description: 'Wastage by item and location' },
    columns: [
      { key: 'itemName', label: 'Item' },
      { key: 'quantity', label: 'Qty' },
      { key: 'value', label: 'Value' }
    ],
    rows: [{ itemName: 'Burger', quantity: 2, value: 120 }],
    totals: {}
  });

  assert.deepEqual(doc.lastAutoTable?.styles?.headStyles?.fillColor, KCP_PDF_THEME.accentDark);
  assert.deepEqual(doc.lastAutoTable?.styles?.styles?.textColor, KCP_PDF_THEME.text);
  assert.deepEqual(doc.lastAutoTable?.styles?.alternateRowStyles?.fillColor, KCP_PDF_THEME.surfaceAlt);
  const bytes = new Uint8Array(doc.output('arraybuffer'));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
});
