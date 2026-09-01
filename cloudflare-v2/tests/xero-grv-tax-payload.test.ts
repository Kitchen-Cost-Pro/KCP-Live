import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGrvBillPayload } from '../src/modules/xero-engine/grv-sync';

// Regression: the GRV -> Xero Bill payload used to (a) toggle LineAmountTypes based on the GRV's
// "prices include VAT" flag, even though grv_lines.unit_price/total_ex are ALWAYS ex-VAT
// regardless of that flag (GRVEntry.js's toggle only changes what price is TYPED on screen, never
// what's stored — see routes.ts's GRV save path), and (b) applied one flat purchases tax type to
// every line, ignoring that KCP already computes real per-line VAT (0 for a zero-rated/exempt stock
// item, via stock_items.vat_enabled).

function grv(overrides: Partial<Parameters<typeof buildGrvBillPayload>[0]> = {}) {
  return {
    id: 'grv_123456',
    supplier_id: 'sup_1',
    supplier_name: 'Test Supplier',
    supplier_xero_contact_id: null,
    invoice_number: 'INV-001',
    received_at: '2026-08-31T00:00:00.000Z',
    prices_include_vat: 0,
    total_ex: 100,
    total_vat: 15,
    total_inc: 115,
    raw_json: null,
    ...overrides
  };
}

test('LineAmountTypes is always Exclusive, regardless of the GRV\'s prices_include_vat flag', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_vat: 15 }];

  const withInclusiveFlag = buildGrvBillPayload(grv({ prices_include_vat: 1 }), lines, 'contact_1', settings);
  const withExclusiveFlag = buildGrvBillPayload(grv({ prices_include_vat: 0 }), lines, 'contact_1', settings);

  assert.equal(withInclusiveFlag.Invoices[0].LineAmountTypes, 'Exclusive');
  assert.equal(withExclusiveFlag.Invoices[0].LineAmountTypes, 'Exclusive');
});

test('a taxable line uses the normal purchases tax type', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'INPUT2');
  assert.equal(payload.Invoices[0].LineItems[0].UnitAmount, 10);
});

test('a zero-rated/exempt line (total_vat = 0) uses the configured exempt tax type instead of the normal one', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_2', stock_item_name: 'Bread (zero-rated)', quantity: 5, unit_price: 8, total_vat: 0 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'EXEMPTINPUT');
});

test('a mixed GRV applies the correct tax type per line, not one blanket type for the whole Bill', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [
    { stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_vat: 15 },
    { stock_item_id: 'si_2', stock_item_name: 'Bread (zero-rated)', quantity: 5, unit_price: 8, total_vat: 0 }
  ];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'INPUT2');
  assert.equal(payload.Invoices[0].LineItems[1].TaxType, 'EXEMPTINPUT');
});

test('an exempt line falls back to the normal purchases tax type when no exempt tax type is configured (opt-in, no behavior change until set)', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_2', stock_item_name: 'Bread (zero-rated)', quantity: 5, unit_price: 8, total_vat: 0 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'INPUT2');
});

test('Bill fields: Type is ACCPAY, Status is DRAFT, Contact is the resolved ContactID', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv(), [], 'contact_42', settings);
  const bill = payload.Invoices[0];
  assert.equal(bill.Type, 'ACCPAY');
  assert.equal(bill.Status, 'DRAFT');
  assert.deepEqual(bill.Contact, { ContactID: 'contact_42' });
});
