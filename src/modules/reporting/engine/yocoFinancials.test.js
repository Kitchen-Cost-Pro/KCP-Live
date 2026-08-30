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

test('sale and refund rows of the same zero-rated order resolve identical VAT and flag the contradictory stored value', () => {
  // Regression: the sale path used to consult the stored VAT before the zero-rated marker while
  // the refund path consulted the marker first, so one order reported VAT 73.04 on its sale row
  // and 0 on its refund row. Both paths now apply the same priority (zero-rated wins).
  const raw = { tax_status: 'zero-rated' };
  const sale = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    persistedVatTotal: 73.04,
    configuredVatRate: 15,
    raw
  });
  const refund = deriveYocoFinancialAmounts({
    persistedTotal: -560,
    persistedVatTotal: 73.04,
    orderType: 'refund',
    status: 'refunded',
    configuredVatRate: 15,
    raw
  });
  assert.equal(sale.vatAmount, 0);
  assert.equal(refund.vatAmount, 0);
  assert.equal(refund.refundVatAmount, 0);
  assert.equal(Math.abs(sale.vatAmount), Math.abs(refund.vatAmount));
  assert.equal(sale.vatSource, 'zero-rated');
  assert.equal(refund.vatSource, 'zero-rated');
  assert.equal(sale.netAmount, 560);
  for (const result of [sale, refund]) {
    assert.ok(result.issues.some((issue) => issue.code === 'yoco-zero-rated-with-stored-vat' && issue.level === 'warning'));
  }
});

test('a stored VAT value without a zero-rated marker is still authoritative on both sale and refund paths', () => {
  const sale = deriveYocoFinancialAmounts({ persistedTotal: 560, persistedVatTotal: 73.04, configuredVatRate: 15, raw: {} });
  const refund = deriveYocoFinancialAmounts({
    persistedTotal: -560, persistedVatTotal: 73.04, orderType: 'refund', status: 'refunded', configuredVatRate: 15, raw: {}
  });
  assert.equal(sale.vatAmount, 73.04);
  assert.equal(refund.vatAmount, -73.04);
  assert.equal(sale.vatSource, 'persisted');
  assert.equal(refund.vatSource, 'persisted-refund');
  for (const result of [sale, refund]) {
    assert.ok(!result.issues.some((issue) => issue.code === 'yoco-zero-rated-with-stored-vat'));
  }
});

test('a contradictory zero-rated order discards the stale persisted net so gross, VAT and net still reconcile', () => {
  // Regression: the persisted net was derived from the stale nonzero VAT, so honouring it while
  // forcing VAT to 0 left gross != net + VAT and raised a critical reconciliation issue.
  const persisted = { persistedVatTotal: 73.04, persistedNetTotal: 486.96, configuredVatRate: 15, raw: { tax_status: 'zero-rated' } };
  const sale = deriveYocoFinancialAmounts({ ...persisted, persistedTotal: 560 });
  assert.equal(sale.grossAmount, 560);
  assert.equal(sale.vatAmount, 0);
  assert.equal(sale.netAmount, 560);
  assert.equal(sale.diagnostics.grossNetVatReconciles, true);

  const refund = deriveYocoFinancialAmounts({ ...persisted, persistedTotal: -560, orderType: 'refund', status: 'refunded' });
  assert.equal(refund.vatAmount, 0);
  assert.equal(refund.netAmount, -560);
  assert.equal(refund.refundAmount, 560);
  assert.equal(refund.refundNetAmount, 560);
  assert.equal(refund.diagnostics.grossNetVatReconciles, true);

  for (const result of [sale, refund]) {
    assert.ok(result.issues.some((issue) => issue.code === 'yoco-zero-rated-with-stored-vat' && issue.level === 'warning'));
    assert.ok(!result.issues.some((issue) => issue.code === 'yoco-gross-net-vat-mismatch'));
  }
});

test('a persisted net total is still honoured when nothing contradicts it', () => {
  const sale = deriveYocoFinancialAmounts({
    persistedTotal: 560, persistedVatTotal: 73.04, persistedNetTotal: 486.96, configuredVatRate: 15, raw: {}
  });
  assert.equal(sale.grossAmount, 560);
  assert.equal(sale.vatAmount, 73.04);
  assert.equal(sale.netAmount, 486.96);
  assert.equal(sale.diagnostics.grossNetVatReconciles, true);

  const refund = deriveYocoFinancialAmounts({
    persistedTotal: -560, persistedVatTotal: 73.04, persistedNetTotal: 486.96, orderType: 'refund', status: 'refunded', configuredVatRate: 15, raw: {}
  });
  assert.equal(refund.vatAmount, -73.04);
  assert.equal(refund.netAmount, -486.96);
  assert.equal(refund.refundNetAmount, 486.96);
  assert.equal(refund.diagnostics.grossNetVatReconciles, true);
});

test('a zero-rated order with a stored VAT of exactly zero is not treated as contradictory', () => {
  const result = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    persistedVatTotal: 0,
    configuredVatRate: 15,
    raw: { tax_status: 'zero-rated' }
  });
  assert.equal(result.vatAmount, 0);
  assert.equal(result.netAmount, 560);
  assert.ok(!result.issues.some((issue) => issue.code === 'yoco-zero-rated-with-stored-vat'));
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

test('missing workspace VAT rate falls back to 15 percent for taxable Yoco sales', () => {
  const missingConfigured = deriveYocoFinancialAmounts({
    persistedTotal: 140,
    configuredVatRate: null,
    raw: {}
  });
  assert.equal(missingConfigured.vatRate, 15);
  assert.equal(missingConfigured.vatAmount, 18.26);
  assert.equal(missingConfigured.netAmount, 121.74);
});

test('an explicit zero configured VAT rate (business not VAT registered) is authoritative and never falls back', () => {
  // A workspace that is explicitly not VAT registered configures a rate of exactly 0. This must
  // never be treated the same as "no rate configured" — it must not fall back to the 15% default,
  // and it must not be overridden even when Yoco's own payload reports a positive tax amount,
  // since a non-registered business does not charge or reclaim VAT at all.
  const zeroConfigured = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    configuredVatRate: 0,
    raw: {}
  });
  assert.equal(zeroConfigured.vatRate, 0);
  assert.equal(zeroConfigured.vatAmount, 0);
  assert.equal(zeroConfigured.netAmount, 560);
  assert.equal(zeroConfigured.diagnostics.vatRateSource, 'workspace-not-registered');
});

test('explicit Yoco zero-rated markers still override the default VAT fallback', () => {
  const result = deriveYocoFinancialAmounts({
    persistedTotal: 560,
    configuredVatRate: 15,
    raw: { tax_status: 'zero-rated', amounts: { tax_amount: { amount: 0, currency: 'ZAR' } } }
  });
  assert.equal(result.vatRate, 15);
  assert.equal(result.vatAmount, 0);
  assert.equal(result.netAmount, 560);
  assert.equal(result.isVatExempt, true);
  assert.equal(result.vatSource, 'zero-rated');
});
