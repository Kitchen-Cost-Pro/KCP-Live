import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deriveYocoFinancialAmounts, sumYocoProcessingFees, sumYocoTaxAmounts, yocoMoneyToMajor } from './yocoFinancials.js';

test('Yoco Money objects are converted from cents to Rand', () => {
  assert.equal(yocoMoneyToMajor({ amount: 56000, currency: 'ZAR' }), 560);
  assert.equal(yocoMoneyToMajor({ value: 7304, currency: 'ZAR' }), 73.04);
});

test('normalized scalar amounts are major units regardless of value, while explicit minor scalars are opt-in', () => {
  assert.equal(yocoMoneyToMajor(1400), 1400);
  assert.equal(yocoMoneyToMajor('1400'), 1400);
  assert.equal(yocoMoneyToMajor(140000, { scalarUnit: 'minor' }), 1400);
  assert.equal(yocoMoneyToMajor(-1400, { absolute: false }), -1400);
});

test('Yoco ingestion never guesses currency units from amount magnitude', () => {
  for (const relativePath of [
    'cloudflare-v2/src/modules/yoco-engine-v2/sale-resolver.ts',
    'cloudflare-v2/src/modules/yoco-engine-v2/refund-resolver.ts',
    'cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts',
    'cloudflare-v2/src/legacy/routes.ts',
    'cloudflare-v2/src/legacy/reporting-routes.ts'
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    assert.match(source, /yocoMoneyToMajor/);
    assert.doesNotMatch(source, /Math\.abs\([^)]*\)\s*>\s*999/);
  }
});

test('historical persisted totals corrupted by the old magnitude heuristic are corrected from raw Yoco data', () => {
  const result = deriveYocoFinancialAmounts({
    persistedTotal: 14,
    configuredVatRate: 15,
    raw: { total_price: 1400 }
  });
  assert.equal(result.grossAmount, 1400);
  assert.equal(result.vatAmount, 182.61);
  assert.equal(result.netAmount, 1217.39);
  assert.equal(result.grossSource, 'raw-corrected:total_price');
  assert.equal(result.diagnostics.persistedTotalMismatch, true);
  assert.ok(result.issues.some((issue) => issue.code === 'yoco-persisted-total-mismatch' && issue.level === 'critical'));
});

test('pre-discount gross fallback does not override a stored final order amount', () => {
  const result = deriveYocoFinancialAmounts({
    persistedTotal: 139,
    configuredVatRate: 15,
    raw: { amounts: { gross_amount: { amount: 16680, currency: 'ZAR' } } }
  });
  assert.equal(result.grossAmount, 139);
  assert.equal(result.grossSource, 'persisted-order-total');
  assert.equal(result.diagnostics.persistedTotalMismatch, false);
});

test('Yoco order fallback uses the final after-discount amount rather than pre-discount gross', () => {
  const result = deriveYocoFinancialAmounts({
    configuredVatRate: 15,
    raw: {
      amounts: {
        gross_amount: { amount: 16680, currency: 'ZAR' },
        net_amount: { amount: 13900, currency: 'ZAR' },
        discount_amount: { amount: 2780, currency: 'ZAR' },
        tax_amount: { amount: 1813, currency: 'ZAR' }
      }
    }
  });
  assert.equal(result.grossAmount, 139);
  assert.equal(result.discountAmount, 27.8);
  assert.equal(result.vatAmount, 18.13);
  assert.equal(result.netAmount, 120.87);
  assert.equal(result.grossSource, 'amounts.net_amount');
});

test('Yoco aggregate total_taxes are used when the summary tax field is absent', () => {
  const raw = { total_taxes: [{ name: 'VAT', tax_amount: { amount: 7304, currency: 'ZAR' }, percentage: '15.00' }] };
  assert.equal(sumYocoTaxAmounts(raw), 73.04);
  const result = deriveYocoFinancialAmounts({ persistedTotal: 560, configuredVatRate: 15, raw });
  assert.equal(result.vatAmount, 73.04);
  assert.equal(result.vatSource, 'yoco');
});

test('Yoco sale uses explicit tax Money object and reconciles gross, VAT and net', () => {
  const result = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    configuredVatRate: 15,
    raw: {
      amounts: {
        gross_amount: { amount: 56000, currency: 'ZAR' },
        net_amount: { amount: 48696, currency: 'ZAR' },
        tax_amount: { amount: 7304, currency: 'ZAR' }
      }
    }
  });
  assert.equal(result.grossAmount, 560);
  assert.equal(result.vatAmount, 73.04);
  assert.equal(result.netAmount, 486.96);
  assert.equal(result.vatSource, 'yoco');
  assert.equal(result.diagnostics.grossNetVatReconciles, true);
});

test('zero or invalid Yoco tax falls back to VAT-inclusive calculation unless explicitly zero-rated', () => {
  const zeroTax = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    configuredVatRate: 15,
    raw: { amounts: { tax_amount: { amount: 0, currency: 'ZAR' } } }
  });
  assert.equal(zeroTax.vatAmount, 73.04);
  assert.equal(zeroTax.netAmount, 486.96);
  assert.equal(zeroTax.vatSource, 'calculated');

  const zeroRated = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    configuredVatRate: 15,
    raw: { tax_status: 'zero-rated', amounts: { tax_amount: { amount: 0, currency: 'ZAR' } } }
  });
  assert.equal(zeroRated.vatAmount, 0);
  assert.equal(zeroRated.netAmount, 560);
  assert.equal(zeroRated.vatSource, 'zero-rated');
  assert.equal(zeroRated.isVatExempt, true);
});

test('Yoco processing fees can be summed from nested payment fee Money objects', () => {
  const order = { payments: [{ processing_fees: [{ amount: { amount: 840, currency: 'ZAR' } }, { amount: { amount: 160, currency: 'ZAR' } }] }] };
  assert.equal(sumYocoProcessingFees(order), 10);
  const result = deriveYocoFinancialAmounts({ persistedTotal: 560, raw: order, configuredVatRate: 15 });
  assert.equal(result.feeAmount, 10);
  assert.equal(result.payoutAmount, 476.96);
  assert.equal(result.payoutAmount, result.netAmount + result.tipAmount - result.refundAmount - result.feeAmount);
});

test('refund rows preserve the refund amount and reverse the VAT-exclusive bill values', () => {
  const result = deriveYocoFinancialAmounts({ persistedTotal: -140, orderType: 'refund', status: 'refunded', configuredVatRate: 15, raw: {} });
  assert.equal(result.grossAmount, 0);
  assert.equal(result.vatAmount, -18.26);
  assert.equal(result.netAmount, -121.74);
  assert.equal(result.refundAmount, 140);
  assert.equal(result.payoutAmount, -140);
  assert.equal(result.refundAmount, Math.abs(result.netAmount) + Math.abs(result.vatAmount));
});

test('refund rows do not double count the parent order discount, tip, or processing fee', () => {
  const parentOrder = {
    amounts: {
      discount_amount: { amount: 2000, currency: 'ZAR' },
      tip_amount: { amount: 1000, currency: 'ZAR' }
    },
    payments: [{ processing_fees: [{ amount: { amount: 840, currency: 'ZAR' } }] }]
  };
  const result = deriveYocoFinancialAmounts({
    persistedTotal: -140,
    orderType: 'refund',
    status: 'refunded',
    configuredVatRate: 15,
    raw: parentOrder
  });
  assert.equal(result.discountAmount, 0);
  assert.equal(result.tipAmount, 0);
  assert.equal(result.feeAmount, 0);
  assert.equal(result.refundAmount, 140);
  assert.equal(result.vatAmount, -18.26);
  assert.equal(result.netAmount, -121.74);
  assert.equal(result.payoutAmount, -140);
});

test('known Checkout scalar fields are converted from cents without magnitude guessing', () => {
  const result = deriveYocoFinancialAmounts({
    configuredVatRate: 15,
    raw: { amount: 56000, totalTaxAmount: 7304, totalDiscount: 1200 }
  });
  assert.equal(result.grossAmount, 560);
  assert.equal(result.vatAmount, 73.04);
  assert.equal(result.netAmount, 486.96);
  assert.equal(result.discountAmount, 12);
});

test('zero or missing workspace VAT rate falls back to 15 percent for taxable Yoco sales', () => {
  const zeroConfigured = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    configuredVatRate: 0,
    raw: {}
  });
  assert.equal(zeroConfigured.vatRate, 15);
  assert.equal(zeroConfigured.vatAmount, 73.04);
  assert.equal(zeroConfigured.netAmount, 486.96);
  assert.equal(zeroConfigured.diagnostics.vatRateSource, 'default');
  assert.ok(zeroConfigured.issues.some((issue) => issue.code === 'yoco-vat-rate-fallback-applied'));

  const missingConfigured = deriveYocoFinancialAmounts({
    persistedTotal: 140,
    configuredVatRate: null,
    raw: {}
  });
  assert.equal(missingConfigured.vatRate, 15);
  assert.equal(missingConfigured.vatAmount, 18.26);
  assert.equal(missingConfigured.netAmount, 121.74);
});

test('explicit Yoco zero-rated markers still override the default VAT fallback', () => {
  const result = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    configuredVatRate: 0,
    raw: { tax_status: 'zero-rated', amounts: { tax_amount: { amount: 0, currency: 'ZAR' } } }
  });
  assert.equal(result.vatRate, 15);
  assert.equal(result.vatAmount, 0);
  assert.equal(result.netAmount, 560);
  assert.equal(result.isVatExempt, true);
  assert.equal(result.vatSource, 'zero-rated');
});
