import { calculateVatFromGross, normalizeVatRate, roundMoney, safeNumber } from './calculations.js';

const CENT_TOLERANCE = 0.011;
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
  const orderTaxes = arrayValue(order?.total_taxes, order?.totalTaxes);
  const orderTax = sumMoneyEntries(orderTaxes, ['tax_amount', 'taxAmount', 'amount']);
  if (Number.isFinite(orderTax)) return orderTax;

  const lines = arrayValue(order?.line_items, order?.lineItems, order?.items);
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
  // Checkout API scalar money fields are explicitly cents; this path is context-based,
  // never inferred from the size of the number.
  const checkoutGross = resolveYocoMoney(raw, ['amount'], NaN, { scalarUnit: 'minor' });
  const resolvedGross = finiteOr(grossResolution.value, checkoutGross.value);
  const resolvedGrossPath = grossResolution.path || checkoutGross.path;
  const rawFinalAmountIsAuthoritative = isAuthoritativeFinalAmountPath(resolvedGrossPath);
  const persistedTotalMismatch = !isRefund
    && storedTotal > 0
    && Number.isFinite(resolvedGross)
    && rawFinalAmountIsAuthoritative
    && !moneyReconciles(storedTotal, resolvedGross, 0.02);
  // Existing rows created by the old magnitude heuristic can contain R14 for a real
  // R1,400 scalar. When the original raw Yoco final amount is available, repair the
  // report dynamically and surface the mismatch for audit/re-sync.
  const selectedGross = persistedTotalMismatch ? resolvedGross : storedTotal || finiteOr(resolvedGross, 0);
  const grossAmount = isRefund ? 0 : roundMoney(selectedGross);

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
  const explicitTaxPlausible = Number.isFinite(taxResolution.value)
    && taxResolution.value >= 0
    && taxResolution.value <= grossAmount + CENT_TOLERANCE
    && (taxResolution.value > 0 || !grossAmount || !normalizedVatRate || explicitZeroRated);
  const calculatedVat = calculateVatFromGross(grossAmount, vatRate);
  const vatAmount = isRefund
    ? 0
    : roundMoney(explicitTaxPlausible ? taxResolution.value : calculatedVat);
  const netAmount = isRefund ? 0 : roundMoney(grossAmount - vatAmount);

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
  // Refunds are stored as separate reporting rows. Reusing the parent order's discount
  // would double count it in period totals.
  const discountAmount = isRefund ? 0 : roundMoney(finiteOr(directDiscount, finiteOr(checkoutDiscount, 0)));

  const rawRefund = resolveYocoMoney(raw, [
    'refund_amount',
    'refundAmount',
    'refund_total',
    'refundTotal',
    'amounts.refund_amount',
    'amounts.refundAmount'
  ], NaN).value;
  const refundAmount = isRefund
    ? roundMoney(storedTotal || finiteOr(rawRefund, finiteOr(grossResolution.value, 0)))
    : roundMoney(finiteOr(rawRefund, 0));

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
  // The refund row stores the parent order payload. Original sale fees therefore belong
  // only to the sale row and must not be counted again on the refund row.
  const feeAmount = isRefund ? 0 : roundMoney(finiteOr(directFee, finiteOr(sumYocoProcessingFees(raw), 0)));

  const payoutResolution = resolveYocoMoney(raw, [
    'payout_amount',
    'payoutAmount',
    'settlement_amount',
    'settlementAmount',
    'amounts.payout_amount',
    'amounts.payoutAmount'
  ], NaN);
  const expectedPayout = roundMoney(grossAmount - refundAmount - feeAmount + tipAmount);
  const payoutAmount = isRefund
    ? expectedPayout
    : roundMoney(Number.isFinite(payoutResolution.value) ? payoutResolution.value : expectedPayout);

  const issues = [];
  if (persistedTotalMismatch) {
    issues.push({
      code: 'yoco-persisted-total-mismatch',
      level: 'critical',
      message: 'The stored Yoco total did not match the authoritative raw final amount; reporting used the raw amount. Re-sync this order to repair the stored value.'
    });
  }
  if (grossAmount > 0 && normalizedVatRate > 0 && vatAmount === 0 && !explicitZeroRated) {
    issues.push({ code: 'yoco-vat-zero-on-taxable-sale', level: 'critical', message: 'A VAT-bearing Yoco sale resolved to zero VAT.' });
  }
  if (!moneyReconciles(grossAmount, netAmount + vatAmount)) {
    issues.push({ code: 'yoco-gross-net-vat-mismatch', level: 'critical', message: 'Yoco gross amount does not reconcile to net amount plus VAT.' });
  }
  if (!moneyReconciles(payoutAmount, expectedPayout, 0.05)) {
    issues.push({ code: 'yoco-payout-mismatch', level: 'warning', message: 'Yoco payout amount does not reconcile to gross less refunds and fees plus tips.' });
  }
  if (vatRateResolution.fallbackApplied && grossAmount > 0 && !explicitZeroRated) {
    issues.push({ code: 'yoco-vat-rate-fallback-applied', level: 'warning', message: 'The workspace VAT rate was missing or zero; reporting used the default South African VAT rate of 15%.' });
  }
  if (taxResolution.path && !explicitTaxPlausible && grossAmount > 0 && normalizedVatRate > 0) {
    issues.push({ code: 'yoco-tax-fallback-applied', level: 'info', message: 'The Yoco tax value was missing, zero without a zero-rated marker, or invalid; VAT was calculated from the VAT-inclusive gross amount.' });
  }

  return {
    isRefund,
    grossAmount,
    vatAmount,
    netAmount,
    discountAmount,
    refundAmount,
    tipAmount,
    feeAmount,
    payoutAmount,
    expectedPayout,
    vatRate,
    isVatExempt: explicitZeroRated,
    vatSource: isRefund ? 'refund' : explicitZeroRated ? 'zero-rated' : explicitTaxPlausible ? 'yoco' : 'calculated',
    grossSource: persistedTotalMismatch
      ? `raw-corrected:${resolvedGrossPath}`
      : storedTotal
        ? 'persisted-order-total'
        : resolvedGrossPath || 'unresolved',
    issues,
    diagnostics: {
      explicitTaxPath: taxResolution.path,
      explicitTaxValue: Number.isFinite(taxResolution.value) ? roundMoney(taxResolution.value) : null,
      explicitTaxPlausible,
      explicitZeroRated,
      vatRateSource: vatRateResolution.source,
      configuredVatRate: vatRateResolution.configuredValue,
      persistedTotal: storedTotal,
      rawFinalAmount: Number.isFinite(resolvedGross) ? roundMoney(resolvedGross) : null,
      rawFinalAmountPath: resolvedGrossPath,
      persistedTotalMismatch,
      grossNetVatReconciles: moneyReconciles(grossAmount, netAmount + vatAmount),
      payoutReconciles: moneyReconciles(payoutAmount, expectedPayout, 0.05)
    }
  };
}


export function resolveYocoVatRate(raw = {}, configuredVatRate = DEFAULT_YOCO_VAT_RATE) {
  const configuredValue = safeNumber(configuredVatRate, NaN);
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
  const taxes = arrayValue(raw.total_taxes, raw.totalTaxes, raw.taxes);
  return taxes.length > 0 && taxes.every((tax) => {
    const rate = safeNumber(tax?.rate ?? tax?.percentage ?? tax?.tax_rate, NaN);
    const label = String(tax?.name ?? tax?.type ?? '').toLowerCase();
    return rate === 0 || /zero[ _-]?rated|exempt/.test(label);
  });
}
