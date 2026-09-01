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

test('a GRV with a transport cost pushes it as its own taxable line item', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv({ transport_ex: 25 }), lines, 'contact_1', settings);
  const items = payload.Invoices[0].LineItems;
  assert.equal(items.length, 2);
  const transportLine = items.find((item) => item.Description === 'Transport');
  assert.equal(transportLine.UnitAmount, 25);
  // Transport is always taxable, regardless of what stock items it shipped — never the exempt type.
  assert.equal(transportLine.TaxType, 'INPUT2');
});

test('no transport line is added when transport_ex is 0/null', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];
  const payload = buildGrvBillPayload(grv({ transport_ex: 0 }), lines, 'contact_1', settings);
  assert.equal(payload.Invoices[0].LineItems.some((item) => item.Description === 'Transport'), false);
});

// A discount is pushed as its own explicit negative-UnitAmount LineItem (or two, split by tax
// share) so it stays visible on the Bill — Xero's own documented pattern for a Bill discount,
// since ACCPAY doesn't support the native DiscountRate field at all (that's ACCREC/sales-invoice
// only).

test('a discount on an all-VATable GRV is pushed as a single negative taxable line, not split', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv({ discount_ex: 20 }), lines, 'contact_1', settings);
  const discountLines = payload.Invoices[0].LineItems.filter((item) => String(item.Description).startsWith('Discount'));
  assert.equal(discountLines.length, 1);
  assert.equal(discountLines[0].UnitAmount, -20);
  assert.equal(discountLines[0].TaxType, 'INPUT2');
});

test('a discount on a mixed VATable/exempt GRV is pro-rated across two lines, matching each share\'s tax type', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  // 60 taxable (beer) + 40 exempt (bread) = 100 subtotal; a 10 discount should split 6/4.
  const lines = [
    { stock_item_id: 'si_beer', stock_item_name: 'Beer', quantity: 1, unit_price: 60, total_ex: 60, total_vat: 9 },
    { stock_item_id: 'si_bread', stock_item_name: 'Bread', quantity: 1, unit_price: 40, total_ex: 40, total_vat: 0 }
  ];

  const payload = buildGrvBillPayload(grv({ discount_ex: 10 }), lines, 'contact_1', settings);
  const discountLines = payload.Invoices[0].LineItems.filter((item) => String(item.Description).startsWith('Discount'));
  assert.equal(discountLines.length, 2);
  const taxableDiscount = discountLines.find((item) => item.TaxType === 'INPUT2');
  const exemptDiscount = discountLines.find((item) => item.TaxType === 'EXEMPTINPUT');
  assert.ok(Math.abs(taxableDiscount.UnitAmount - -6) < 1e-9, `expected ~-6, got ${taxableDiscount.UnitAmount}`);
  assert.ok(Math.abs(exemptDiscount.UnitAmount - -4) < 1e-9, `expected ~-4, got ${exemptDiscount.UnitAmount}`);
});

test('transport counts toward the taxable base a discount is pro-rated against (transport is always taxable)', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  // 50 exempt (bread) + 50 transport (always taxable) = 100 subtotal; a 20 discount should split 10/10.
  const lines = [{ stock_item_id: 'si_bread', stock_item_name: 'Bread', quantity: 1, unit_price: 50, total_ex: 50, total_vat: 0 }];

  const payload = buildGrvBillPayload(grv({ transport_ex: 50, discount_ex: 20 }), lines, 'contact_1', settings);
  const discountLines = payload.Invoices[0].LineItems.filter((item) => String(item.Description).startsWith('Discount'));
  const taxableDiscount = discountLines.find((item) => item.TaxType === 'INPUT2');
  const exemptDiscount = discountLines.find((item) => item.TaxType === 'EXEMPTINPUT');
  assert.ok(Math.abs(taxableDiscount.UnitAmount - -10) < 1e-9, `expected ~-10, got ${taxableDiscount.UnitAmount}`);
  assert.ok(Math.abs(exemptDiscount.UnitAmount - -10) < 1e-9, `expected ~-10, got ${exemptDiscount.UnitAmount}`);
});

test('no discount lines are added when discount_ex is 0/null', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];
  const payload = buildGrvBillPayload(grv({ discount_ex: 0 }), lines, 'contact_1', settings);
  assert.equal(payload.Invoices[0].LineItems.some((item) => String(item.Description).startsWith('Discount')), false);
});

test('regular stock/transport line UnitAmounts are NOT scaled by the discount — only the explicit Discount line(s) carry it', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];
  const payload = buildGrvBillPayload(grv({ transport_ex: 25, discount_ex: 20 }), lines, 'contact_1', settings);
  const beerLine = payload.Invoices[0].LineItems.find((item) => item.Description === 'Beer');
  const transportLine = payload.Invoices[0].LineItems.find((item) => item.Description === 'Transport');
  assert.equal(beerLine.UnitAmount, 10);
  assert.equal(transportLine.UnitAmount, 25);
});
