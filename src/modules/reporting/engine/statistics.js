import { roundMoney, safeNumber } from './calculations.js';

export function average(values = []) {
  const numbers = numericValues(values);
  if (!numbers.length) return 0;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

export function standardDeviation(values = []) {
  const numbers = numericValues(values);
  if (numbers.length < 2) return 0;
  const mean = average(numbers);
  const variance = numbers.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / numbers.length;
  return Math.sqrt(variance);
}

export function calculateCostChange(firstCost, lastCost) {
  return roundMoney(safeNumber(lastCost) - safeNumber(firstCost));
}

export function calculateCostChangePercent(firstCost, lastCost) {
  const first = safeNumber(firstCost);
  if (!first) return 0;
  return (safeNumber(lastCost) - first) / first;
}

export function calculatePriceRange(lowestCost, highestCost) {
  return roundMoney(safeNumber(highestCost) - safeNumber(lowestCost));
}

export function calculateVolatilityPercent(lowestCost, highestCost, averageCost) {
  const mean = safeNumber(averageCost);
  if (!mean) return 0;
  return (safeNumber(highestCost) - safeNumber(lowestCost)) / mean;
}

export function calculateCoefficientOfVariation(values = []) {
  const mean = average(values);
  if (!mean) return 0;
  return standardDeviation(values) / mean;
}

export function calculateWeightedAverageCost(lines = []) {
  const totals = (Array.isArray(lines) ? lines : []).reduce((result, line) => {
    const qty = Math.max(0, safeNumber(line.qty ?? line.quantity ?? line.receivedQty ?? line.qtyPurchased));
    const cost = safeNumber(line.unitCostExVat ?? line.unitCost ?? line.cost);
    result.quantity += qty;
    result.value += qty * cost;
    return result;
  }, { quantity: 0, value: 0 });
  return totals.quantity ? totals.value / totals.quantity : 0;
}

export function calculateTheoreticalUsage(recipeUsage, modifierUsage, manufacturingUsage) {
  return safeNumber(recipeUsage) + safeNumber(modifierUsage) + safeNumber(manufacturingUsage);
}

export function calculateExpectedClosingStock({ openingStock = 0, purchases = 0, transfersIn = 0, manufacturingIn = 0, theoreticalUsage = 0, wastage = 0, transfersOut = 0 } = {}) {
  return safeNumber(openingStock)
    + safeNumber(purchases)
    + safeNumber(transfersIn)
    + safeNumber(manufacturingIn)
    - safeNumber(theoreticalUsage)
    - safeNumber(wastage)
    - safeNumber(transfersOut);
}

export function calculateVarianceQty(actualClosing, expectedClosing) {
  return safeNumber(actualClosing) - safeNumber(expectedClosing);
}

export function calculateVarianceValue(varianceQty, unitCostExVat) {
  return roundMoney(safeNumber(varianceQty) * safeNumber(unitCostExVat));
}

export function calculateVariancePercent(varianceQty, expectedClosing) {
  const expected = safeNumber(expectedClosing);
  if (!expected) return 0;
  return safeNumber(varianceQty) / expected;
}

export function calculateAccuracyPercent(actual, theoretical) {
  const expected = safeNumber(theoretical);
  const actualValue = safeNumber(actual);
  if (!expected) return actualValue === 0 ? 1 : 0;
  return clamp(1 - Math.abs((actualValue - expected) / expected), 0, 1);
}

export function median(values = []) {
  const numbers = numericValues(values).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function percentileRank(value, values = []) {
  const numbers = numericValues(values);
  if (!numbers.length) return 0;
  const belowOrEqual = numbers.filter((candidate) => candidate <= safeNumber(value)).length;
  return (belowOrEqual / numbers.length) * 100;
}

export function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, safeNumber(value)));
}

function numericValues(values = []) {
  return (Array.isArray(values) ? values : []).map((value) => Number(value)).filter(Number.isFinite);
}
