import { roundMoney, safeNumber } from './calculations.js';
import { moneyReconciles } from './yocoFinancials.js';

export function buildReportIntegritySummary(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const issues = [];
  for (const row of safeRows) {
    const rowId = row?.id || row?.sourceId || row?.receiptNumber || '';
    if (hasAny(row, ['grossAmount', 'netAmount', 'vatAmount'])) {
      const gross = safeNumber(row.grossAmount);
      const net = safeNumber(row.netAmount);
      const vat = safeNumber(row.vatAmount);
      if (!moneyReconciles(gross, net + vat)) {
        issues.push({ code: 'sales-gross-net-vat-reconciliation', level: 'critical', rowId, difference: roundMoney(gross - net - vat) });
      }
      const isVatExempt = row?.isVatExempt === true || row?.is_vat_exempt === true || /zero[ _-]?rated|exempt|non[ _-]?taxable/.test(String(row?.vatSource || row?.vat_source || '').toLowerCase());
      const taxableSalesContext = safeNumber(row?.vatRate ?? row?.vat_rate) > 0
        || String(row?.createdBy || row?.created_by || '').toLowerCase() === 'yoco'
        || ['yoco', 'calculated', 'source'].includes(String(row?.vatSource || row?.vat_source || '').toLowerCase());
      if (gross > 0 && moneyReconciles(gross, net) && moneyReconciles(vat, 0) && taxableSalesContext && !isVatExempt) {
        issues.push({ code: 'sales-taxable-zero-vat', level: 'critical', rowId, difference: roundMoney(gross - net) });
      }
    }
    if (row?.payoutAmount !== undefined) {
      const expected = roundMoney(safeNumber(row.grossAmount) - safeNumber(row.refundAmount) - safeNumber(row.feeAmount) + safeNumber(row.tipAmount));
      if (!moneyReconciles(row.payoutAmount, expected, 0.05)) {
        issues.push({ code: 'sales-payout-reconciliation', level: 'warning', rowId, difference: roundMoney(safeNumber(row.payoutAmount) - expected) });
      }
    }
    if (hasAny(row, ['qtyIn', 'qtyOut', 'netQty'])) {
      const expected = safeNumber(row.qtyIn) - safeNumber(row.qtyOut);
      if (Math.abs(safeNumber(row.netQty) - expected) > 0.000001) {
        issues.push({ code: 'movement-quantity-reconciliation', level: 'critical', rowId, difference: safeNumber(row.netQty) - expected });
      }
    }
    if (hasAny(row, ['expectedQty', 'countedQty', 'varianceQty'])) {
      const expected = safeNumber(row.countedQty) - safeNumber(row.expectedQty);
      if (Math.abs(safeNumber(row.varianceQty) - expected) > 0.000001) {
        issues.push({ code: 'stocktake-quantity-reconciliation', level: 'critical', rowId, difference: safeNumber(row.varianceQty) - expected });
      }
    }
    if (hasAny(row, ['expectedValue', 'countedValue', 'varianceValue'])) {
      const expected = roundMoney(safeNumber(row.countedValue) - safeNumber(row.expectedValue));
      if (!moneyReconciles(row.varianceValue, expected)) {
        issues.push({ code: 'stocktake-value-reconciliation', level: 'critical', rowId, difference: roundMoney(safeNumber(row.varianceValue) - expected) });
      }
    }
    if (row?.movementValue !== undefined && row?.netQty !== undefined && row?.unitCostExVat !== undefined) {
      const expected = roundMoney(safeNumber(row.netQty) * safeNumber(row.unitCostExVat));
      if (!moneyReconciles(row.movementValue, expected, 0.02)) {
        issues.push({ code: 'movement-value-reconciliation', level: 'warning', rowId, difference: roundMoney(safeNumber(row.movementValue) - expected) });
      }
    }
  }
  return { valid: issues.length === 0, rowsChecked: safeRows.length, issueCount: issues.length, issues };
}

export function appendIntegrityWarnings(rows = [], warnings = []) {
  const summary = buildReportIntegritySummary(rows);
  for (const issue of summary.issues) {
    warnings.push({
      code: issue.code,
      level: issue.level,
      message: `${humanize(issue.code)}${issue.rowId ? ` (row ${issue.rowId})` : ''}.`
    });
  }
  return summary;
}

function hasAny(row = {}, keys = []) {
  return keys.some((key) => row?.[key] !== undefined);
}

function humanize(value = '') {
  return String(value).replace(/[-_]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
