import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCreditNoteXeroPayload } from '../src/modules/xero-engine/credit-note-sync';

// credit_note_lines never stores its own VAT amount (unlike grv_lines) — total_ex is always a
// genuine ex-VAT figure (no "already inclusive, fold VAT into cost" duality the way GRV stock
// lines have), so VAT is computed here by adding the workspace's rate on top, gated by the same
// two taxability gates as everywhere else: item vat_enabled and supplier VAT registration.

const RATE = 0.15;

function creditNote(overrides: Partial<Parameters<typeof buildCreditNoteXeroPayload>[0]> = {}) {
  return {
    id: 'cn_123456',
    supplier_id: 'sup_1',
    supplier_name: 'Test Supplier',
    supplier_xero_contact_id: null,
    supplier_raw_json: null,
    credit_note_number: 'CN-001',
    credited_at: '2026-08-31T00:00:00.000Z',
    ...overrides
  };
}

test('Type is ACCPAYCREDIT, Status is DRAFT, Contact is the resolved ContactID', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildCreditNoteXeroPayload(creditNote(), [], 'contact_42', settings, true, RATE, true);
  const note = payload.CreditNotes[0];
  assert.equal(note.Type, 'ACCPAYCREDIT');
  assert.equal(note.Status, 'DRAFT');
  assert.deepEqual(note.Contact, { ContactID: 'contact_42' });
  assert.equal(note.LineAmountTypes, 'Exclusive');
});

test('Reference falls back to a derived code when no credit_note_number is set', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const payload = buildCreditNoteXeroPayload(creditNote({ credit_note_number: null }), [], 'contact_1', settings, true, RATE, true);
  assert.ok(payload.CreditNotes[0].Reference.startsWith('CN-'));
});

test('a VAT-registered workspace: a taxable line uses the normal purchases tax type at its ex-VAT amount', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', vat_enabled: 1, quantity: 2, unit_cost: 10, total_ex: 20 }];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, true, RATE, true);
  const line = payload.CreditNotes[0].LineItems[0];
  assert.equal(line.TaxType, 'INPUT2');
  assert.equal(line.UnitAmount, 20, 'ex-VAT amount, unchanged — Xero adds tax via TaxType');
});

test('a VAT-registered workspace: a zero-rated line (vat_enabled=0) uses the exempt tax type', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_2', stock_item_name: 'Bread', vat_enabled: 0, quantity: 1, unit_cost: 10, total_ex: 10 }];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.CreditNotes[0].LineItems[0].TaxType, 'EXEMPTINPUT');
});

test('a VAT-registered workspace: a zero-rated line falls back to the standard tax type when no exempt type is configured', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_2', stock_item_name: 'Bread', vat_enabled: 0, quantity: 1, unit_cost: 10, total_ex: 10 }];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.CreditNotes[0].LineItems[0].TaxType, 'INPUT2');
});

test('a VAT-registered workspace with a NON-registered supplier: every line falls to the exempt type, regardless of item vat_enabled', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', vat_enabled: 1, quantity: 1, unit_cost: 20, total_ex: 20 }];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, true, RATE, false);
  const line = payload.CreditNotes[0].LineItems[0];
  assert.equal(line.TaxType, 'EXEMPTINPUT', 'the supplier never charged VAT, so this is not reclaimable regardless of the item');
  assert.equal(line.UnitAmount, 20, 'no VAT to add on top when the supplier cannot charge it');
});

// A non-VAT-registered WORKSPACE still genuinely received a real credit that a VAT-registered
// supplier's reduction included VAT on — it just can't reclaim that VAT, so the true, non-
// reclaimable credit is the full inclusive amount, not the ex-VAT split (same "always add VAT on
// top, then fold for a non-registered workspace" treatment as Transport on the GRV push).

test('a non-VAT-registered workspace: a taxable line uses TaxType NONE at its true VAT-inclusive amount', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', vat_enabled: 1, quantity: 1, unit_cost: 100, total_ex: 100 }];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, false, RATE, true);
  const line = payload.CreditNotes[0].LineItems[0];
  assert.equal(line.TaxType, 'NONE');
  assert.equal(line.UnitAmount, 115, 'must gross up to the true inclusive credit, not the raw ex-VAT figure');
});

test('a non-VAT-registered workspace: a non-taxable line (vat_enabled=0) still uses TaxType NONE at its plain ex-VAT amount (no VAT was ever added)', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [{ stock_item_id: 'si_2', stock_item_name: 'Bread', vat_enabled: 0, quantity: 1, unit_cost: 40, total_ex: 40 }];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, false, RATE, true);
  const line = payload.CreditNotes[0].LineItems[0];
  assert.equal(line.TaxType, 'NONE');
  assert.equal(line.UnitAmount, 40, 'non-taxable line never had VAT to gross up in the first place');
});

test('a mixed credit note applies the correct amount/tax type per line, not one blanket rule', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: 'EXEMPTINPUT' };
  const lines = [
    { stock_item_id: 'si_1', stock_item_name: 'Beer', vat_enabled: 1, quantity: 1, unit_cost: 100, total_ex: 100 },
    { stock_item_id: 'si_2', stock_item_name: 'Bread', vat_enabled: 0, quantity: 1, unit_cost: 40, total_ex: 40 }
  ];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal(payload.CreditNotes[0].LineItems[0].TaxType, 'INPUT2');
  assert.equal(payload.CreditNotes[0].LineItems[0].UnitAmount, 100);
  assert.equal(payload.CreditNotes[0].LineItems[1].TaxType, 'EXEMPTINPUT');
  assert.equal(payload.CreditNotes[0].LineItems[1].UnitAmount, 40);
});

// Location Tracking Categories — same "pure function just spreads whatever tracking.ts already
// resolved" contract as buildGrvBillPayload's own tracking tests.
test('a line with a pre-resolved tracking array gets a Tracking field on its LineItem', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [
    {
      stock_item_id: 'si_1',
      stock_item_name: 'Beer',
      vat_enabled: 1,
      quantity: 1,
      unit_cost: 100,
      total_ex: 100,
      tracking: [{ TrackingCategoryID: 'cat_1', TrackingOptionID: 'opt_1' }]
    }
  ];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, true, RATE, true);
  assert.deepEqual(payload.CreditNotes[0].LineItems[0].Tracking, [{ TrackingCategoryID: 'cat_1', TrackingOptionID: 'opt_1' }]);
});

test('a line with no tracking resolved omits the Tracking field entirely', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Beer', vat_enabled: 1, quantity: 1, unit_cost: 100, total_ex: 100 }];
  const payload = buildCreditNoteXeroPayload(creditNote(), lines, 'contact_1', settings, true, RATE, true);
  assert.equal('Tracking' in payload.CreditNotes[0].LineItems[0], false);
});
