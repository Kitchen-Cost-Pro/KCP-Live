import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveYocoFinancialAmounts } from '../../src/modules/reporting/engine/yocoFinancials.js';

// Regression guard for the mixed-VAT-rate basket bug: when Yoco's own order-level tax figure is
// missing/implausible, deriveYocoFinancialAmounts used to apply one flat rate to the WHOLE gross
// via calculateVatFromGross, even when the line items themselves carry an explicit zero-rated
// marker. A R100 zero-rated item + a R115 VAT-inclusive (15%) item, with no order-level tax field,
// must reverse VAT off only the taxable line's own gross share (R15.00), not the full R215 basket
// (which would wrongly compute R28.04).

test('a mixed zero-rated + taxable basket reverses VAT off only the taxable line, not the whole gross', () => {
  const raw = {
    total_price: 215,
    line_items: [
      { total_price: 100, tax_status: 'zero_rated' },
      { total_price: 115 }
    ]
  };
  const result = deriveYocoFinancialAmounts({ raw, configuredVatRate: 15, orderType: 'sale', status: 'completed' });
  assert.equal(result.grossAmount, 215);
  assert.equal(result.vatAmount, 15, 'VAT should be reversed only off the R115 taxable line, not the full R215 basket');
  assert.ok(!result.issues.some((issue) => issue.code === 'yoco-gross-net-vat-mismatch'));
});

test('the same mixed basket on a refund reverses proportionally off the refunded taxable amount', () => {
  const raw = {
    refund_amount: 215,
    line_items: [
      { total_price: 100, tax_status: 'zero_rated' },
      { total_price: 115 }
    ]
  };
  const result = deriveYocoFinancialAmounts({ raw, configuredVatRate: 15, orderType: 'refund', status: 'refunded' });
  assert.equal(result.refundGrossAmount, 215);
  assert.equal(result.refundVatAmount, 15);
});

test('a basket with no zero-rated signal at all falls back to the flat calculation unchanged', () => {
  const raw = {
    total_price: 215,
    line_items: [
      { total_price: 100 },
      { total_price: 115 }
    ]
  };
  const result = deriveYocoFinancialAmounts({ raw, configuredVatRate: 15, orderType: 'sale', status: 'completed' });
  // No per-line zero-rated evidence exists, so behavior is unchanged from the flat calculation:
  // VAT reversed off the full R215 gross at 15%.
  assert.equal(result.vatAmount, 28.04);
});

test('a fully zero-rated basket (every line marked) still resolves to zero VAT', () => {
  const raw = {
    total_price: 150,
    line_items: [
      { total_price: 100, tax_status: 'zero_rated' },
      { total_price: 50, zero_rated: true }
    ]
  };
  const result = deriveYocoFinancialAmounts({ raw, configuredVatRate: 15, orderType: 'sale', status: 'completed' });
  assert.equal(result.vatAmount, 0);
});

test('a basket mixing two distinct non-zero rates taxes each line at its own rate, not the order default for both', () => {
  const raw = {
    total_price: 200,
    line_items: [
      { total_price: 100, applied_taxes: [{ rate: 8 }] },
      { total_price: 100 }
    ]
  };
  const result = deriveYocoFinancialAmounts({ raw, configuredVatRate: 15, orderType: 'sale', status: 'completed' });
  // R7.41 (line at its own 8%) + R13.04 (the other line at the order's 15% default) = R20.45,
  // not R26.09 (both lines flatly taxed at 15%).
  assert.equal(result.vatAmount, 20.45);
});
