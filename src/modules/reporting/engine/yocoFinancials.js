import { calculateVatFromGross, normalizeVatRate, roundMoney, safeNumber } from './calculations.js';

// Canonical money-reconciliation tolerances — import these rather than re-declaring
// a local literal, so every report agrees on how close two totals must be to "match".
export const CENT_TOLERANCE = 0.011;
export const PAYOUT_TOLERANCE = 0.05;
export const PERSISTED_TOTAL_TOLERANCE = 0.02;
export const DEFAULT_YOCO_VAT_RATE = 15;

export function yocoMoneyToMajor(value, { scalarUnit = 'major', absolute = true } = {}) {
  let numeric = NaN;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value.amount ?? value.value ?? value.minor_amount ?? value.minorAmount;
    numeric = Number(raw);
    if (Number.isFinite(numeric)) numeric /= 100;
  } else {
    numeric = Number(value);
    if (Number.isFinite(numeric) && scalarUnit === 'minor') numeric /= 100;
  }
  if (!Number.isFinite(numeric)) return NaN;
  const resolved = roundMoney(numeric);
  return absolute ? Math.abs(resolved) : resolved;
}

export function getYocoValue(source, path) {
  return String(path || '').split('.').filter(Boolean).reduce((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return current[key];
  }, source);
}

export function resolveYocoMoney(source = {}, paths = [], fallback = NaN, options = {}) {
  for (const path of paths) {
    const rawValue = getYocoValue(source, path);
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const value = yocoMoneyToMajor(rawValue, options);
    if (Number.isFinite(value)) return { value, path, rawValue };
  }
  return { value: fallback, path: '', rawValue: undefined };
}

export function sumYocoProcessingFees(order = {}) {
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  let found = false;
  let total = 0;
  for (const payment of payments) {
    const fees = Array.isArray(payment?.processing_fees)
      ? payment.processing_fees
      : Array.isArray(payment?.processingFees)
        ? payment.processingFees
        : [];
    for (const fee of fees) {
      const value = yocoMoneyToMajor(fee?.amount ?? fee?.fee_amount ?? fee?.feeAmount ?? fee);
      if (!Number.isFinite(value)) continue;
      found = true;
      total += Math.abs(value);
    }
  }
  return found ? roundMoney(total) : NaN;
}


export function sumYocoTaxAmounts(order = {}) {
  const orderTaxes = arrayValue(order?.returned_total_taxes, order?.returnedTotalTaxes, order?.total_taxes, order?.totalTaxes);
  const orderTax = sumMoneyEntries(orderTaxes, ['tax_amount', 'taxAmount', 'amount']);
  if (Number.isFinite(orderTax)) return orderTax;

  const lines = arrayValue(order?.returned_line_items, order?.returnedLineItems, order?.line_items, order?.lineItems, order?.items);
  let found = false;
  let total = 0;
  for (const line of lines) {
    const lineTaxes = arrayValue(line?.applied_taxes, line?.appliedTaxes, line?.taxes);
    const lineTax = sumMoneyEntries(lineTaxes, ['tax_amount', 'taxAmount', 'amount']);
    if (!Number.isFinite(lineTax)) continue;
    found = true;
    total += lineTax;
  }
  return found ? roundMoney(total) : NaN;
}

export function sumYocoPaymentTips(order = {}) {
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  return sumMoneyEntries(payments, ['tip_amount', 'tipAmount']);
}

export function deriveYocoFinancialAmounts({
  raw = {},
  persistedTotal = 0,
  persistedGrossTotal = NaN,
  persistedVatTotal = NaN,
  persistedNetTotal = NaN,
  configuredVatRate = 15,
  orderType = '',
  status = ''
} = {}) {
  const normalizedType = String(orderType || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const isRefund = normalizedType === 'refund' || normalizedStatus.includes('refund');
  const vatRateResolution = resolveYocoVatRate(raw, configuredVatRate);
  const vatRate = vatRateResolution.value;
  const normalizedVatRate = normalizeVatRate(vatRate);
  const storedTotal = Math.abs(safeNumber(persistedTotal, 0));
  const hasPersistedValue = (value) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value));
  const hasStoredGross = hasPersistedValue(persistedGrossTotal);
  const hasStoredVat = hasPersistedValue(persistedVatTotal);
  const hasStoredNet = hasPersistedValue(persistedNetTotal);
  const storedGross = hasStoredGross ? Math.abs(Number(persistedGrossTotal)) : NaN;
  const storedVat = hasStoredVat ? Math.abs(Number(persistedVatTotal)) : NaN;
  const storedNet = hasStoredNet ? Math.abs(Number(persistedNetTotal)) : NaN;

  const directTip = resolveYocoMoney(raw, [
    'amounts.tip_amount',
    'amounts.tipAmount',
    'tip_amount',
    'tipAmount',
    'tip_total',
    'tipTotal',
    'gratuity'
  ], NaN).value;
  const paymentTips = sumYocoPaymentTips(raw);
  const tipAmount = isRefund ? 0 : roundMoney(
    Number.isFinite(directTip) && directTip > 0 ? directTip : finiteOr(paymentTips, finiteOr(directTip, 0))
  );

  // Yoco Orders calls the final amount after discounts `amounts.net_amount`; it is still
  // VAT-inclusive. Prefer it over `gross_amount`, which represents the pre-discount amount.
  const grossResolution = resolveYocoMoney(raw, [
    'total_price',
    'totalPrice',
    'amounts.net_amount',
    'amounts.netAmount',
    'net_amount',
    'netAmount',
    'total_amount',
    'totalAmount',
    'total',
    'amounts.gross_amount',
    'amounts.grossAmount',
    'gross_amount',
    'grossAmount'
  ], NaN);
  const checkoutGross = resolveYocoMoney(raw, ['amount'], NaN, { scalarUnit: 'minor' });
  const resolvedGross = finiteOr(grossResolution.value, checkoutGross.value);
  const resolvedGrossPath = grossResolution.path || checkoutGross.path;
  const rawFinalAmountIsAuthoritative = isAuthoritativeFinalAmountPath(resolvedGrossPath);
  const persistedTotalMismatch = !isRefund
    && storedTotal > 0
    && Number.isFinite(resolvedGross)
    && rawFinalAmountIsAuthoritative
    && !moneyReconciles(storedTotal, resolvedGross, PERSISTED_TOTAL_TOLERANCE);
  const selectedCustomerTotal = persistedTotalMismatch ? resolvedGross : storedTotal || finiteOr(resolvedGross, 0);
  // Customer-paid totals can include gratuity. Gross sales must represent only the bill
  // value because tips are not taxable and are reported in their own column.
  const grossAmount = isRefund ? 0 : roundMoney(hasStoredGross ? storedGross : Math.max(0, selectedCustomerTotal - tipAmount));

  const rawRefund = resolveYocoMoney(raw, [
    'refund_amount',
    'refundAmount',
    'refund_total',
    'refundTotal',
    'amounts.refund_amount',
    'amounts.refundAmount'
  ], NaN).value;
  const refundAmount = isRefund
    ? roundMoney(hasStoredGross ? storedGross : storedTotal || finiteOr(rawRefund, finiteOr(grossResolution.value, 0)))
    : roundMoney(finiteOr(rawRefund, 0));

  const directTaxResolution = resolveYocoMoney(raw, [
    'amounts.tax_amount',
    'amounts.taxAmount',
    'tax_amount',
    'taxAmount',
    'vat_amount',
    'vatAmount',
    'total_tax',
    'totalTax'
  ], NaN);
  const aggregatedTax = sumYocoTaxAmounts(raw);
  const checkoutTax = resolveYocoMoney(raw, ['totalTaxAmount'], NaN, { scalarUnit: 'minor' });
  const taxResolution = Number.isFinite(directTaxResolution.value)
    ? directTaxResolution
    : Number.isFinite(aggregatedTax)
      ? { value: aggregatedTax, path: 'total_taxes', rawValue: aggregatedTax }
      : checkoutTax;
  const explicitZeroRated = isExplicitlyZeroRated(raw);
  const taxBaseAmount = isRefund ? refundAmount : grossAmount;
  const explicitTaxPlausible = Number.isFinite(taxResolution.value)
    && taxResolution.value >= 0
    && taxResolution.value <= taxBaseAmount + CENT_TOLERANCE
    && (taxResolution.value > 0 || !taxBaseAmount || !normalizedVatRate || explicitZeroRated);
  const calculatedVat = resolveMixedBasketVat(raw, grossAmount, vatRate);
  // VAT resolution priority is IDENTICAL for sales and refunds so the same order can never
  // report one VAT figure on its sale row and a different one on its refund row.
  // An explicit zero-rated marker wins over a stored VAT value, matching how the rest of this
  // module treats zero-rating (see `vatSource`, the zero-VAT issue suppression below, and the
  // authoritative explicit-zero handling in resolveYocoVatRate).
  const resolveVatAmount = (calculatedFallback) => roundMoney(explicitZeroRated
    ? 0
    : hasStoredVat
      ? storedVat
      : explicitTaxPlausible
        ? taxResolution.value
        : calculatedFallback);
  const refundVatAmount = resolveVatAmount(resolveMixedBasketVat(raw, refundAmount, vatRate));
  const saleVatAmount = resolveVatAmount(calculatedVat);
  const contradictoryZeroRatedVat = explicitZeroRated && hasStoredVat && roundMoney(storedVat) !== 0;
  const vatAmount = isRefund
    ? roundMoney(-refundVatAmount)
    : saleVatAmount;
  // A contradictory zero-rated order's persisted net was derived from the stale nonzero VAT, so it
  // cannot be trusted either: keeping it would leave gross != net + VAT and trip the critical
  // reconciliation issue. Both components are re-derived from the zero-rated VAT of 0 instead.
  const useStoredNet = hasStoredNet && !contradictoryZeroRatedVat;
  const netAmount = isRefund
    ? roundMoney(-(useStoredNet ? storedNet : refundAmount - refundVatAmount))
    : roundMoney(useStoredNet ? storedNet : grossAmount - vatAmount);

  const directDiscount = resolveYocoMoney(raw, [
    'amounts.discount_amount',
    'amounts.discountAmount',
    'discount_amount',
    'discountAmount',
    'discount_total',
    'discountTotal',
    'total_discount'
  ], NaN).value;
  const checkoutDiscount = resolveYocoMoney(raw, ['totalDiscount'], NaN, { scalarUnit: 'minor' }).value;
  const discountAmount = isRefund ? 0 : roundMoney(finiteOr(directDiscount, finiteOr(checkoutDiscount, 0)));

  const directFee = resolveYocoMoney(raw, [
    'amounts.fee_amount',
    'amounts.feeAmount',
    'fee_amount',
    'feeAmount',
    'fees_total',
    'feesTotal',
    'processing_fee',
    'processingFee'
  ], NaN).value;
  const feeAmount = isRefund ? 0 : roundMoney(finiteOr(directFee, finiteOr(sumYocoProcessingFees(raw), 0)));

  const refundNetAmount = roundMoney(isRefund && useStoredNet ? storedNet : Math.max(0, refundAmount - refundVatAmount));
  // Refunds are cash returned to the customer, so payout and payment reconciliation
  // must deduct the full VAT-inclusive gross refund. VAT and ex-VAT components are
  // still exposed separately for accounting tables.
  const payoutNetSales = isRefund ? 0 : netAmount;
  const expectedPayout = roundMoney(payoutNetSales + tipAmount - refundAmount - feeAmount);
  const payoutAmount = expectedPayout;

  const issues = [];
  if (persistedTotalMismatch) {
    issues.push({
      code: 'yoco-persisted-total-mismatch',
      level: 'critical',
      message: 'The stored Yoco total did not match the authoritative raw final amount; reporting used the raw amount. Re-sync this order to repair the stored value.'
    });
  }
  if (contradictoryZeroRatedVat) {
    issues.push({
      code: 'yoco-zero-rated-with-stored-vat',
      level: 'warning',
      message: 'This order is marked zero-rated but also carries a nonzero stored VAT amount. Reporting used the zero-rated marker (VAT 0); re-sync or correct the stored VAT value.'
    });
  }
  if (!isRefund && grossAmount > 0 && normalizedVatRate > 0 && vatAmount === 0 && !explicitZeroRated) {
    issues.push({ code: 'yoco-vat-zero-on-taxable-sale', level: 'critical', message: 'A VAT-bearing Yoco sale resolved to zero VAT.' });
  }
  const grossReconciles = isRefund
    ? moneyReconciles(refundAmount, Math.abs(netAmount) + Math.abs(vatAmount))
    : moneyReconciles(grossAmount, netAmount + vatAmount);
  if (!grossReconciles) {
    issues.push({ code: 'yoco-gross-net-vat-mismatch', level: 'critical', message: isRefund ? 'Yoco refund does not reconcile to the reversed net amount plus VAT.' : 'Yoco gross amount does not reconcile to net amount plus VAT.' });
  }
  if (vatRateResolution.fallbackApplied && (grossAmount > 0 || refundAmount > 0) && !explicitZeroRated) {
    issues.push({ code: 'yoco-vat-rate-fallback-applied', level: 'warning', message: 'The workspace VAT rate was not configured; reporting used the default South African VAT rate of 15%.' });
  }
  if (!isRefund && taxResolution.path && !explicitTaxPlausible && grossAmount > 0 && normalizedVatRate > 0) {
    issues.push({ code: 'yoco-tax-fallback-applied', level: 'info', message: 'The Yoco tax value was missing, zero without a zero-rated marker, or invalid; VAT was calculated from the VAT-inclusive bill value.' });
  }

  return {
    isRefund,
    grossAmount,
    vatAmount,
    netAmount,
    discountAmount,
    refundAmount,
    refundGrossAmount: refundAmount,
    refundVatAmount,
    refundNetAmount,
    tipAmount,
    feeAmount,
    payoutAmount,
    expectedPayout,
    vatRate,
    isVatExempt: explicitZeroRated,
    vatSource: explicitZeroRated
      ? 'zero-rated'
      : isRefund
        ? (hasStoredVat ? 'persisted-refund' : explicitTaxPlausible ? 'yoco-return' : 'refund-calculated')
        : hasStoredVat ? 'persisted' : explicitTaxPlausible ? 'yoco' : 'calculated',
    grossSource: persistedTotalMismatch
      ? `raw-corrected:${resolvedGrossPath}`
      : storedTotal
        ? 'persisted-order-total'
        : (resolvedGrossPath || 'unresolved'),
    issues,
    diagnostics: {
      explicitTaxPath: taxResolution.path,
      explicitTaxValue: Number.isFinite(taxResolution.value) ? roundMoney(taxResolution.value) : null,
      explicitTaxPlausible,
      explicitZeroRated,
      vatRateSource: vatRateResolution.source,
      configuredVatRate: vatRateResolution.configuredValue,
      persistedTotal: storedTotal,
      customerPaidTotal: roundMoney(selectedCustomerTotal),
      tipExcludedFromGross: tipAmount,
      rawFinalAmount: Number.isFinite(resolvedGross) ? roundMoney(resolvedGross) : null,
      rawFinalAmountPath: resolvedGrossPath,
      persistedTotalMismatch,
      grossNetVatReconciles: grossReconciles,
      payoutReconciles: moneyReconciles(payoutAmount, expectedPayout, PAYOUT_TOLERANCE)
    }
  };
}


export function resolveYocoVatRate(raw = {}, configuredVatRate = DEFAULT_YOCO_VAT_RATE) {
  const configuredValue = safeNumber(configuredVatRate, NaN);
  // An explicit, deliberate 0 (a business that is not VAT registered) is authoritative and must
  // never be overridden by Yoco's own reported tax data or the hardcoded default rate — otherwise
  // a non-registered business would still show VAT on reports whenever Yoco's payload happened to
  // carry a tax figure. Only a missing/NaN value falls through to the lookup chain below.
  // IMPORTANT: check the raw parameter for strict equality to 0 before any coercion — `Number(null)`
  // and `Number('')` both equal 0 in JS, so coercing first would misclassify a genuinely missing
  // rate (null/undefined/'') as "explicitly zero" and wrongly suppress the 15% fallback below.
  const isExplicitZero = configuredVatRate === 0 || configuredVatRate === '0';
  if (isExplicitZero) {
    return { value: 0, source: 'workspace-not-registered', configuredValue: 0, fallbackApplied: false };
  }
  if (normalizeVatRate(configuredValue) > 0) {
    return { value: configuredValue, source: 'workspace', configuredValue, fallbackApplied: false };
  }

  const rawRate = findPositiveYocoTaxRate(raw);
  if (normalizeVatRate(rawRate) > 0) {
    return { value: rawRate, source: 'yoco', configuredValue: Number.isFinite(configuredValue) ? configuredValue : null, fallbackApplied: false };
  }

  return {
    value: DEFAULT_YOCO_VAT_RATE,
    source: 'default',
    configuredValue: Number.isFinite(configuredValue) ? configuredValue : null,
    fallbackApplied: true
  };
}

function findPositiveYocoTaxRate(raw = {}) {
  const directCandidates = [
    raw.vat_rate, raw.vatRate, raw.tax_rate, raw.taxRate,
    raw.amounts?.vat_rate, raw.amounts?.vatRate, raw.amounts?.tax_rate, raw.amounts?.taxRate
  ];
  for (const candidate of directCandidates) {
    if (normalizeVatRate(candidate) > 0) return safeNumber(candidate);
  }

  const taxCollections = [
    ...arrayValue(raw?.total_taxes, raw?.totalTaxes, raw?.taxes),
    ...arrayValue(raw?.line_items, raw?.lineItems, raw?.items).flatMap((line) =>
      arrayValue(line?.applied_taxes, line?.appliedTaxes, line?.taxes)
    )
  ];
  for (const tax of taxCollections) {
    const candidate = tax?.percentage ?? tax?.rate ?? tax?.tax_rate ?? tax?.taxRate;
    if (normalizeVatRate(candidate) > 0) return safeNumber(candidate);
  }
  return NaN;
}

export function moneyReconciles(left, right, tolerance = CENT_TOLERANCE) {
  return Math.abs(roundMoney(left) - roundMoney(right)) <= Math.max(0, safeNumber(tolerance, CENT_TOLERANCE));
}

function isAuthoritativeFinalAmountPath(path = '') {
  return new Set([
    'total_price',
    'totalPrice',
    'total_amount',
    'totalAmount',
    'total',
    'amount'
  ]).has(String(path || ''));
}

function arrayValue(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function sumMoneyEntries(entries = [], keys = []) {
  let found = false;
  let total = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    const raw = keys.map((key) => source[key]).find((value) => value !== undefined && value !== null);
    const value = yocoMoneyToMajor(raw);
    if (!Number.isFinite(value)) continue;
    found = true;
    total += Math.abs(value);
  }
  return found ? roundMoney(total) : NaN;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// A line's own explicit tax rate, if Yoco recorded one — distinct from `resolveYocoVatRate`,
// which resolves ONE rate for the whole order. Used so a basket mixing more than one non-zero
// rate (e.g. a reduced/specialty rate alongside the standard rate) taxes each line at its own
// rate rather than the order's single resolved rate.
function lineOwnRate(line = {}) {
  const directCandidates = [line.vat_rate, line.vatRate, line.tax_rate, line.taxRate];
  for (const candidate of directCandidates) {
    if (normalizeVatRate(candidate) > 0) return safeNumber(candidate);
  }
  const taxes = arrayValue(line.applied_taxes, line.appliedTaxes, line.taxes);
  for (const tax of taxes) {
    const candidate = tax?.percentage ?? tax?.rate ?? tax?.tax_rate ?? tax?.taxRate;
    if (normalizeVatRate(candidate) > 0) return safeNumber(candidate);
  }
  return NaN;
}

// Order-level `calculateVatFromGross(grossAmount, vatRate)` applies one flat rate to the whole
// basket. That is wrong whenever the basket mixes a zero-rated/exempt item with a taxable one, or
// mixes more than one distinct non-zero rate, AND Yoco's own order-level tax figure is
// missing/implausible (so `explicitTaxPlausible` is false and this fallback actually runs) — e.g.
// a R100 zero-rated item plus a R115 VAT-inclusive item would otherwise compute VAT on the full
// R215, wildly overstating it. When there is real per-line evidence of a mixed basket (an explicit
// zero-rated line, or a line carrying its own rate different from the order's resolved rate),
// reverse each taxable line's VAT off its own gross at its own rate (falling back to the order's
// resolved rate for a line with no rate of its own) instead of one flat rate over the whole
// basket. If there is no such evidence at all, this returns the same flat calculation as before —
// it only changes behavior when it has real evidence of a mixed basket.
function resolveMixedBasketVat(raw, grossAmount, vatRate) {
  const flatVat = calculateVatFromGross(grossAmount, vatRate);
  const lines = arrayValue(
    raw?.returned_line_items, raw?.returnedLineItems, raw?.line_items, raw?.lineItems, raw?.items
  );
  if (!lines.length) return flatVat;
  const normalizedOrderRate = normalizeVatRate(vatRate);
  const flagged = lines.map((line) => {
    const zeroRated = isExplicitlyZeroRated(line);
    const ownRate = zeroRated ? NaN : lineOwnRate(line);
    return { line, zeroRated, ownRate };
  });
  const hasZeroRated = flagged.some((entry) => entry.zeroRated);
  const hasDistinctOwnRate = flagged.some((entry) => Number.isFinite(entry.ownRate) && normalizeVatRate(entry.ownRate) !== normalizedOrderRate);
  // No per-line evidence of a mixed basket at all: keep the old flat behavior unchanged.
  if (!hasZeroRated && !hasDistinctOwnRate) return flatVat;
  const hasTaxableLine = flagged.some((entry) => !entry.zeroRated);
  // Every line is explicitly zero-rated: no part of this basket is taxable.
  if (!hasTaxableLine) return 0;
  let total = 0;
  let anyTaxableGross = false;
  for (const { line, zeroRated, ownRate } of flagged) {
    if (zeroRated) continue;
    const lineGross = yocoMoneyToMajor(
      line.total_price ?? line.totalPrice ?? line.total_amount ?? line.totalAmount ?? line.amount
      ?? line.amounts?.gross_amount ?? line.amounts?.grossAmount ?? line.amounts?.net_amount ?? line.amounts?.netAmount
    );
    if (!Number.isFinite(lineGross)) continue;
    anyTaxableGross = true;
    total += calculateVatFromGross(lineGross, Number.isFinite(ownRate) ? ownRate : vatRate);
  }
  if (!anyTaxableGross) return flatVat;
  return roundMoney(Math.min(total, grossAmount));
}

function isExplicitlyZeroRated(raw = {}) {
  const candidates = [
    raw.tax_status,
    raw.taxStatus,
    raw.tax_type,
    raw.taxType,
    raw.vat_status,
    raw.vatStatus,
    raw.zero_rated,
    raw.zeroRated,
    raw.tax_exempt,
    raw.taxExempt
  ];
  if (candidates.some((value) => value === true)) return true;
  const text = candidates.map((value) => String(value ?? '').toLowerCase()).join(' ');
  if (/zero[ _-]?rated|tax[ _-]?exempt|vat[ _-]?exempt|non[ _-]?taxable/.test(text)) return true;
  // Line items carry their applied taxes under `applied_taxes`/`appliedTaxes` rather than
  // `total_taxes` — checked here too so this same function can classify an individual line
  // item (see resolveMixedBasketVat), not just a whole order/refund resource.
  const taxes = arrayValue(raw.total_taxes, raw.totalTaxes, raw.taxes, raw.applied_taxes, raw.appliedTaxes);
  return taxes.length > 0 && taxes.every((tax) => {
    const rate = safeNumber(tax?.rate ?? tax?.percentage ?? tax?.tax_rate, NaN);
    const label = String(tax?.name ?? tax?.type ?? '').toLowerCase();
    return rate === 0 || /zero[ _-]?rated|exempt/.test(label);
  });
}
