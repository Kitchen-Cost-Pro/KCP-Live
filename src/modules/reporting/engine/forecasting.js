import { roundMoney, safeNumber } from './calculations.js';

export function calculateAverageDailyUsage(totalUsage, lookbackDays) {
  const days = Math.max(0, safeNumber(lookbackDays));
  if (!days) return 0;
  return safeNumber(totalUsage) / days;
}

export function calculateWeightedAverageUsage({ usage7Day = 0, usage14Day = 0, usage30Day = 0 } = {}) {
  const average7 = calculateAverageDailyUsage(usage7Day, 7);
  const average14 = calculateAverageDailyUsage(usage14Day, 14);
  const average30 = calculateAverageDailyUsage(usage30Day, 30);
  const available = [
    { value: average7, weight: 0.5, total: safeNumber(usage7Day) },
    { value: average14, weight: 0.3, total: safeNumber(usage14Day) },
    { value: average30, weight: 0.2, total: safeNumber(usage30Day) }
  ].filter((entry) => entry.total > 0);
  if (!available.length) return 0;
  const totalWeight = available.reduce((sum, entry) => sum + entry.weight, 0);
  return available.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight;
}

export function calculateDaysUntilStockOut(currentStock, averageDailyUsage) {
  const stock = safeNumber(currentStock);
  const usage = safeNumber(averageDailyUsage);
  if (stock <= 0) return 0;
  if (usage <= 0) return Number.POSITIVE_INFINITY;
  return stock / usage;
}

export function calculateForecastStockOutDate(today, daysUntilStockOut) {
  const days = safeNumber(daysUntilStockOut, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(days) || days < 0) return '';
  const date = parseUtcDate(today);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + Math.ceil(days));
  return date.toISOString().slice(0, 10);
}

export function calculateRecommendedReorderQty(currentStock, parLevel) {
  return Math.max(safeNumber(parLevel) - safeNumber(currentStock), 0);
}

export function calculateEstimatedReorderValue(requiredQty, unitCostExVat) {
  return roundMoney(safeNumber(requiredQty) * safeNumber(unitCostExVat));
}

export function calculateCoveragePercent(currentStock, parLevel) {
  const par = safeNumber(parLevel);
  if (par <= 0) return 0;
  return safeNumber(currentStock) / par;
}

export function resolveStockOutRiskStatus({ currentStock = 0, daysUntilStockOut = Number.POSITIVE_INFINITY, averageDailyUsage = 0 } = {}) {
  if (safeNumber(currentStock) <= 0) return 'Out';
  if (safeNumber(averageDailyUsage) <= 0 || !Number.isFinite(daysUntilStockOut)) return 'No Usage';
  if (daysUntilStockOut <= 2) return 'Critical';
  if (daysUntilStockOut <= 7) return 'High Risk';
  if (daysUntilStockOut <= 14) return 'Watch';
  return 'Healthy';
}

export function stockOutProbabilityScore(daysUntilStockOut, currentStock = 0, averageDailyUsage = 0) {
  if (safeNumber(currentStock) <= 0) return 100;
  if (safeNumber(averageDailyUsage) <= 0 || !Number.isFinite(daysUntilStockOut)) return 5;
  if (daysUntilStockOut <= 2) return 95;
  if (daysUntilStockOut <= 7) return 82;
  if (daysUntilStockOut <= 14) return 58;
  if (daysUntilStockOut <= 30) return 32;
  return 12;
}

export function parseUtcDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysBetweenInclusive(from, to) {
  const start = parseUtcDate(from);
  const end = parseUtcDate(to);
  if (!start || !end) return 0;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1);
}

export function dateDaysAgo(value, days) {
  const date = parseUtcDate(value) || new Date();
  date.setUTCDate(date.getUTCDate() - Math.max(0, Math.floor(safeNumber(days))));
  return date.toISOString().slice(0, 10);
}
