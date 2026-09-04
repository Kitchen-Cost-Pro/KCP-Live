import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGrvBillPayload, isCodSupplier } from '../src/modules/xero-engine/grv-sync';

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

// Standard 15% rate, VAT-registered supplier — the common case for every test below unless a test
// says otherwise.
const RATE = 0.15;

// All tests below exercise a VAT-registered workspace (`true`) unless stated otherwise — see the
// dedicated "non-VAT-registered workspace" section further down for the other side of this gate.

test('LineAmountTypes is always Exclusive, regardless of the GRV\'s prices_include_vat flag', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_vat: 15 }];

  const withInclusiveFlag = buildGrvBillPayload(grv({ prices_include_vat: 1 }), lines, 'contact_1', settings, true, RATE, true);
  const withExclusiveFlag = buildGrvBillPayload(grv({ prices_include_vat: 0 }), lines, 'contact_1', settings, true, RATE, true);

  assert.equal(withInclusiveFlag.Invoices[0].LineAmountTypes, 'Exclusive');
  assert.equal(withExclusiveFlag.Invoices[0].LineAmountTypes, 'Exclusive');
});

test('a taxable line uses the normal purchases tax type', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'INPUT2');
  assert.equal(payload.Invoices[0].LineItems[0].UnitAmount, 10);
});

test('a zero-rated/exempt line (total_vat = 0) uses the configured exempt tax type instead of the normal one', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_2', stock_item_name: 'Bread (zero-rated)', quantity: 5, unit_price: 8, total_vat: 0 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'EXEMPTINPUT');
});

test('a mixed GRV applies the correct tax type per line, not one blanket type for the whole Bill', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [
    { stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_vat: 15 },
    { stock_item_id: 'si_2', stock_item_name: 'Bread (zero-rated)', quantity: 5, unit_price: 8, total_vat: 0 }
  ];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'INPUT2');
  assert.equal(payload.Invoices[0].LineItems[1].TaxType, 'EXEMPTINPUT');
});

test('an exempt line falls back to the normal purchases tax type when no exempt tax type is configured (opt-in, no behavior change until set)', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_2', stock_item_name: 'Bread (zero-rated)', quantity: 5, unit_price: 8, total_vat: 0 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'INPUT2');
});

test('Bill fields: Type is ACCPAY, Status is DRAFT, Contact is the resolved ContactID', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv(), [], 'contact_42', settings, true, RATE, true);
  const bill = payload.Invoices[0];
  assert.equal(bill.Type, 'ACCPAY');
  assert.equal(bill.Status, 'DRAFT');
  assert.deepEqual(bill.Contact, { ContactID: 'contact_42' });
});

// Regression: Xero rejects a Bill outright with "The document DueDate field must be specified" —
// this was a live production failure (every GRV push failing) until DueDate was added.

test('DueDate is always present on the pushed Bill — Xero rejects a Bill with none at all', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv(), [], 'contact_1', settings, true, RATE, true);
  assert.ok(payload.Invoices[0].DueDate, 'DueDate must be a non-empty value');
});

test('a COD/unset-terms supplier is due the same day as the GRV date', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv({ received_at: '2026-08-05T00:00:00.000Z', supplier_raw_json: null }), [], 'contact_1', settings, true, RATE, true);
  assert.equal(payload.Invoices[0].DueDate, '2026-08-05');
});

test('a supplier on "30 Days" terms is due 30 days after the GRV date', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(
    grv({ received_at: '2026-08-05T00:00:00.000Z', supplier_raw_json: JSON.stringify({ paymentTerms: '30 Days' }) }),
    [],
    'contact_1',
    settings,
    true,
    RATE,
    true
  );
  assert.equal(payload.Invoices[0].DueDate, '2026-09-04');
});

test('a supplier on "EOM" terms is due the last day of the GRV\'s month', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(
    grv({ received_at: '2026-08-05T00:00:00.000Z', supplier_raw_json: JSON.stringify({ paymentTerms: 'EOM' }) }),
    [],
    'contact_1',
    settings,
    true,
    RATE,
    true
  );
  assert.equal(payload.Invoices[0].DueDate, '2026-08-31');
});

test('a supplier on "30 Days EOM" terms is due 30 days after the end of the GRV\'s month', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(
    grv({ received_at: '2026-08-05T00:00:00.000Z', supplier_raw_json: JSON.stringify({ paymentTerms: '30 Days EOM' }) }),
    [],
    'contact_1',
    settings,
    true,
    RATE,
    true
  );
  assert.equal(payload.Invoices[0].DueDate, '2026-09-30');
});

test('a GRV with a transport cost pushes it as its own taxable line item', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv({ transport_ex: 25 }), lines, 'contact_1', settings, true, RATE, true);
  const items = payload.Invoices[0].LineItems;
  assert.equal(items.length, 2);
  const transportLine = items.find((item) => item.Description === 'Transport');
  // VAT-registered workspace: transport is pushed at its raw ex-VAT amount, Xero adds VAT via TaxType.
  assert.equal(transportLine.UnitAmount, 25);
  // Transport is always taxable, regardless of what stock items it shipped — never the exempt type.
  assert.equal(transportLine.TaxType, 'INPUT2');
});

test('no transport line is added when transport_ex is 0/null', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];
  const payload = buildGrvBillPayload(grv({ transport_ex: 0 }), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.Invoices[0].LineItems.some((item) => item.Description === 'Transport'), false);
});

// A discount is pushed as its own explicit negative-UnitAmount LineItem (or two, split by tax
// share) so it stays visible on the Bill — Xero's own documented pattern for a Bill discount,
// since ACCPAY doesn't support the native DiscountRate field at all (that's ACCREC/sales-invoice
// only).

test('a discount on an all-VATable GRV is pushed as a single negative taxable line, not split', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv({ discount_ex: 20 }), lines, 'contact_1', settings, true, RATE, true);
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

  const payload = buildGrvBillPayload(grv({ discount_ex: 10 }), lines, 'contact_1', settings, true, RATE, true);
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

  const payload = buildGrvBillPayload(grv({ transport_ex: 50, discount_ex: 20 }), lines, 'contact_1', settings, true, RATE, true);
  const discountLines = payload.Invoices[0].LineItems.filter((item) => String(item.Description).startsWith('Discount'));
  const taxableDiscount = discountLines.find((item) => item.TaxType === 'INPUT2');
  const exemptDiscount = discountLines.find((item) => item.TaxType === 'EXEMPTINPUT');
  assert.ok(Math.abs(taxableDiscount.UnitAmount - -10) < 1e-9, `expected ~-10, got ${taxableDiscount.UnitAmount}`);
  assert.ok(Math.abs(exemptDiscount.UnitAmount - -10) < 1e-9, `expected ~-10, got ${exemptDiscount.UnitAmount}`);
});

test('no discount lines are added when discount_ex is 0/null', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];
  const payload = buildGrvBillPayload(grv({ discount_ex: 0 }), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.Invoices[0].LineItems.some((item) => String(item.Description).startsWith('Discount')), false);
});

test('regular stock/transport line UnitAmounts are NOT scaled by the discount — only the explicit Discount line(s) carry it', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 10, unit_price: 10, total_ex: 100, total_vat: 15 }];
  const payload = buildGrvBillPayload(grv({ transport_ex: 25, discount_ex: 20 }), lines, 'contact_1', settings, true, RATE, true);
  const beerLine = payload.Invoices[0].LineItems.find((item) => item.Description === 'Beer');
  const transportLine = payload.Invoices[0].LineItems.find((item) => item.Description === 'Transport');
  assert.equal(beerLine.UnitAmount, 10);
  assert.equal(transportLine.UnitAmount, 25);
});

// Regression: COD suppliers are paid at the point of delivery, so their Bill should never sit
// around as an unapproved Draft — see grv-sync.ts's isCodSupplier/applyCodPayment.
test('a COD GRV pushes as an AUTHORISED Bill, not DRAFT', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv(), [], 'contact_1', settings, true, RATE, true, undefined, true);
  assert.equal(payload.Invoices[0].Status, 'AUTHORISED');
});

test('a non-COD (e.g. 30 Days) GRV still pushes as DRAFT, unaffected', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv(), [], 'contact_1', settings, true, RATE, true, undefined, false);
  assert.equal(payload.Invoices[0].Status, 'DRAFT');
});

test('isCod defaults to false when omitted, matching pre-COD-feature behavior', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv(), [], 'contact_1', settings, true, RATE, true);
  assert.equal(payload.Invoices[0].Status, 'DRAFT');
});

// A non-VAT-registered workspace still genuinely PAYS whatever VAT a VAT-registered supplier
// charges — it just can never reclaim it as input VAT credit, so the amounts KCP already stores
// (grv_lines.unit_price) are VAT-INCLUSIVE for this case (see GRVEntry.js's finalizeReceivedCost /
// inventory-costing.ts's linesAreAlreadyVatInclusive), and the Bill must never claim a reclaimable
// tax type for any of it. Regression: before this gate existed, every line still used the real,
// reclaimable purchaseTaxType regardless of workspace registration, which both wrongly claimed
// input VAT credit AND — because the inclusive UnitAmount was declared 'Exclusive' — caused Xero
// to double-count VAT on top of an already-inclusive figure.
//
// Transport/Discount are a SEPARATE case from item unit costs: they're always ex-VAT-typed
// ("Transport (Ex)"/"Discount (Ex)", confirmed with David 2026-09-01) regardless of registration,
// so VAT is always added on top of them, then folded into the final non-reclaimable total for a
// non-registered workspace — see computeGrvTotals/applyGrvTransportAndDiscount in
// inventory-costing.ts. An earlier version of this fix pushed the RAW ex-VAT transport/discount
// values even for a non-registered workspace, silently understating the Bill.

test('a non-VAT-registered workspace sends every stock line under TaxType NONE, not the reclaimable purchase tax type', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  // unit_price here is the VAT-INCLUSIVE cost (115 for a 100 ex-VAT / 15 VAT item) — the true,
  // non-reclaimable figure finalizeReceivedCost would have stored for a non-registered workspace.
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 1, unit_price: 115, total_ex: 100, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings, false, RATE, true);
  const line = payload.Invoices[0].LineItems[0];
  assert.equal(line.TaxType, 'NONE');
  assert.equal(line.UnitAmount, 115, 'must send the full inclusive amount, not the ex-VAT split');
});

test('a non-VAT-registered workspace still uses TaxType NONE even for an item that would otherwise be exempt', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_2', stock_item_name: 'Bread', quantity: 1, unit_price: 40, total_ex: 40, total_vat: 0 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings, false, RATE, true);
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'NONE');
});

test('a non-VAT-registered workspace still sends Transport under TaxType NONE but at its true VAT-INCLUSIVE amount, not the raw ex-VAT figure', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 1, unit_price: 115, total_ex: 100, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv({ transport_ex: 25 }), lines, 'contact_1', settings, false, RATE, true);
  const transportLine = payload.Invoices[0].LineItems.find((item) => item.Description === 'Transport');
  assert.equal(transportLine.TaxType, 'NONE');
  // Transport ("Ex") is 25, VAT-registered supplier still charges 15% on top (25*1.15=28.75) —
  // that VAT is real and paid, just non-reclaimable, so it must be INCLUDED, not dropped.
  assert.ok(Math.abs(transportLine.UnitAmount - 28.75) < 1e-9, `expected 28.75 (25 + 15% VAT), got ${transportLine.UnitAmount}`);
});

test('a non-VAT-registered workspace pushes a discount as a single TaxType-NONE line carrying its own VAT-inclusive impact, never pro-rated/split', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [
    { stock_item_id: 'si_beer', stock_item_name: 'Beer', quantity: 1, unit_price: 69, total_ex: 60, total_vat: 9 },
    { stock_item_id: 'si_bread', stock_item_name: 'Bread', quantity: 1, unit_price: 40, total_ex: 40, total_vat: 0 }
  ];

  const payload = buildGrvBillPayload(grv({ discount_ex: 10 }), lines, 'contact_1', settings, false, RATE, true);
  const discountLines = payload.Invoices[0].LineItems.filter((item) => String(item.Description).startsWith('Discount'));
  assert.equal(discountLines.length, 1, 'must not split into taxable/exempt shares when nothing is reclaimable at all');
  // Pre-discount: 60 taxable + 40 exempt = 100 ex-VAT, 9 VAT, 109 inclusive. A 10 ex-VAT discount
  // pro-rated (6 taxable/4 exempt) reduces taxable-ex to 54 -> 8.1 VAT -> 98.10 inclusive. The
  // true cash impact of the discount is 98.10 - 109 = -10.90, not the raw -10.
  assert.ok(Math.abs(discountLines[0].UnitAmount - -10.9) < 1e-9, `expected ~-10.90, got ${discountLines[0].UnitAmount}`);
  assert.equal(discountLines[0].TaxType, 'NONE');
});

test('the no-lines fallback uses the fully inclusive total for a non-VAT-registered workspace', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv({ total_ex: 100, total_vat: 15, total_inc: 115 }), [], 'contact_1', settings, false, RATE, true);
  const line = payload.Invoices[0].LineItems[0];
  assert.equal(line.UnitAmount, 115);
  assert.equal(line.TaxType, 'NONE');
});

test('the no-lines fallback uses the ex-VAT total for a VAT-registered workspace, unchanged', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildGrvBillPayload(grv({ total_ex: 100, total_vat: 15, total_inc: 115 }), [], 'contact_1', settings, true, RATE, true);
  const line = payload.Invoices[0].LineItems[0];
  assert.equal(line.UnitAmount, 100);
  assert.equal(line.TaxType, 'INPUT2');
});

test('a non-VAT-registered workspace with a non-VAT-registered supplier: transport carries no VAT at all', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 1, unit_price: 100, total_ex: 100, total_vat: 0 }];
  const payload = buildGrvBillPayload(grv({ transport_ex: 25 }), lines, 'contact_1', settings, false, RATE, false);
  const transportLine = payload.Invoices[0].LineItems.find((item) => item.Description === 'Transport');
  assert.equal(transportLine.UnitAmount, 25, 'no VAT to add on top when the supplier itself cannot charge VAT');
  assert.equal(transportLine.TaxType, 'NONE');
});

// Regression: a VAT-REGISTERED workspace buying from a NON-registered supplier — transport used to
// be hardcoded as "always taxable" in proRataDiscountShares, and the Transport line's own TaxType
// never checked supplierIsVatRegistered at all, disagreeing with the shared source of truth
// (applyGrvTransportAndDiscount) that every other total on this GRV already correctly uses. Found
// during a full-session audit, not by a live user report — confirmed via computeGrvTotals-family
// tests already passing, but buildGrvBillPayload's OWN independent transport/discount handling had
// silently diverged.

test('registered workspace + non-registered supplier: Transport falls to the exempt tax type, not the reclaimable one', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 1, unit_price: 100, total_ex: 100, total_vat: 0 }];
  const payload = buildGrvBillPayload(grv({ transport_ex: 100 }), lines, 'contact_1', settings, true, RATE, false);
  const transportLine = payload.Invoices[0].LineItems.find((item) => item.Description === 'Transport');
  assert.equal(transportLine.UnitAmount, 100, 'the supplier never charged VAT, so no VAT is added on top');
  assert.equal(transportLine.TaxType, 'EXEMPTINPUT', 'must NOT be the reclaimable purchaseTaxType — this supplier never charges VAT on anything');
});

test('registered workspace + non-registered supplier: Transport falls back to the standard tax type when no exempt type is configured', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', quantity: 1, unit_price: 100, total_ex: 100, total_vat: 0 }];
  const payload = buildGrvBillPayload(grv({ transport_ex: 100 }), lines, 'contact_1', settings, true, RATE, false);
  const transportLine = payload.Invoices[0].LineItems.find((item) => item.Description === 'Transport');
  assert.equal(transportLine.TaxType, 'INPUT2', 'opt-in fallback, matching the identical stock-line behavior');
});

test('registered workspace + non-registered supplier: a discount does NOT pro-rate any share onto transport, since transport carries no VAT here', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  // 100 non-taxable stock line (item vat_enabled=0) + 100 non-taxable transport (supplier not
  // registered) = 200 subtotal, none of it taxable. A 50 discount must land ENTIRELY on the
  // non-taxable/exempt share — if transport were still (incorrectly) counted as taxable, part of
  // this discount would wrongly appear as a taxable-share line instead.
  const lines = [{ stock_item_id: 'si_bread', stock_item_name: 'Bread', quantity: 1, unit_price: 100, total_ex: 100, total_vat: 0 }];
  const payload = buildGrvBillPayload(grv({ transport_ex: 100, discount_ex: 50 }), lines, 'contact_1', settings, true, RATE, false);
  const discountLines = payload.Invoices[0].LineItems.filter((item) => String(item.Description).startsWith('Discount'));
  assert.equal(discountLines.length, 1, 'must be a single exempt-share discount line, not split into a (wrongly nonzero) taxable share too');
  assert.equal(discountLines[0].UnitAmount, -50);
  assert.equal(discountLines[0].TaxType, 'EXEMPTINPUT');
});

// isCodSupplier reads a supplier's paymentTerms straight out of raw_json (it's not a queryable
// column — see Suppliers.js/supplierService.js, which store/default it the same way).
test('isCodSupplier: an explicit COD supplier is COD', () => {
  assert.equal(isCodSupplier(JSON.stringify({ paymentTerms: 'COD' })), true);
});

test('isCodSupplier: a supplier on 30 Days terms is not COD', () => {
  assert.equal(isCodSupplier(JSON.stringify({ paymentTerms: '30 Days' })), false);
});

test('isCodSupplier: no raw_json at all defaults to COD, matching the Suppliers form\'s own default', () => {
  assert.equal(isCodSupplier(null), true);
});

test('isCodSupplier: raw_json present but paymentTerms unset defaults to COD', () => {
  assert.equal(isCodSupplier(JSON.stringify({ name: 'Test Supplier' })), true);
});

test('isCodSupplier: matching is case-insensitive and trims whitespace', () => {
  assert.equal(isCodSupplier(JSON.stringify({ paymentTerms: ' cod ' })), true);
});

test('isCodSupplier: tolerates the alternate "Payment Terms" key spelling used by imports', () => {
  assert.equal(isCodSupplier(JSON.stringify({ 'Payment Terms': '30 Days' })), false);
});

test('isCodSupplier: malformed raw_json degrades to the COD default rather than throwing', () => {
  assert.equal(isCodSupplier('{not valid json'), true);
});

// Location Tracking Categories: buildGrvBillPayload itself never resolves tracking (that's
// pushOneGrv's job, via tracking.ts, before lines reach this pure function) — it only needs to
// spread whatever `tracking` field is already present on each line, or omit it entirely.
test('a line with a pre-resolved tracking array gets a Tracking field on its LineItem', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [
    {
      stock_item_id: 'si_1',
      stock_item_name: 'Flour',
      quantity: 10,
      unit_price: 10,
      total_vat: 15,
      tracking: [{ TrackingCategoryID: 'cat_1', TrackingOptionID: 'opt_1' }]
    }
  ];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings, true, RATE, true);
  assert.deepEqual(payload.Invoices[0].LineItems[0].Tracking, [{ TrackingCategoryID: 'cat_1', TrackingOptionID: 'opt_1' }]);
});

test('a line with no tracking resolved omits the Tracking field entirely, not an empty/undefined one', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_vat: 15 }];

  const payload = buildGrvBillPayload(grv(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal('Tracking' in payload.Invoices[0].LineItems[0], false);
});
