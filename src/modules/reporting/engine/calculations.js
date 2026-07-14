// Shared report calculations.
// Money outputs are rounded at shared calculation boundaries to prevent floating-point drift in totals and exports.

export function calculateStockValue(qty, unitCost) {
  return roundMoney(Number(qty || 0) * Number(unitCost || 0));
}

export function calculateNetMovement(qtyIn, qtyOut) {
  return Number(qtyIn || 0) - Number(qtyOut || 0);
}

export function calculateExpectedClosingQty(openingQty, qtyIn, qtyOut) {
  return Number(openingQty || 0) + Number(qtyIn || 0) - Number(qtyOut || 0);
}

export function calculateVarianceQty(countedQty, expectedQty) {
  return Number(countedQty || 0) - Number(expectedQty || 0);
}

export function calculateVarianceValue(varianceQty, unitCost) {
  return roundMoney(Number(varianceQty || 0) * Number(unitCost || 0));
}

export function calculateExpectedClosingValue(openingValue, increases, decreases) {
  return roundMoney(Number(openingValue || 0) + Number(increases || 0) - Number(decreases || 0));
}

export function calculateVariancePercent(varianceValue, expectedValue) {
  if (!expectedValue) return 0;
  return Number(varianceValue || 0) / Number(expectedValue || 0);
}

export function calculateVatFromGross(gross, vatRate = 0) {
  const rate = normalizeVatRate(vatRate);
  const grossAmount = safeNumber(gross);
  if (!grossAmount || !rate) return 0;
  return roundMoney(grossAmount - (grossAmount / (1 + rate)));
}

export function calculateNetFromGross(gross, vatRate = 0) {
  return roundMoney(safeNumber(gross) - calculateVatFromGross(gross, vatRate));
}

export function calculateGrossProfit(netSales, cost) {
  return roundMoney(safeNumber(netSales) - safeNumber(cost));
}

export function calculateGpPercent(gp, netSales) {
  const sales = safeNumber(netSales);
  if (!sales) return 0;
  return safeNumber(gp) / sales;
}

export function calculateFoodCostPercent(stockCost, netSales) {
  const sales = safeNumber(netSales);
  if (!sales) return 0;
  return safeNumber(stockCost) / sales;
}

export function normalizeVatRate(vatRate = 0) {
  const rate = safeNumber(vatRate);
  if (!rate) return 0;
  return rate > 1 ? rate / 100 : rate;
}

export function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function roundMoney(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((safeNumber(value) + Number.EPSILON) * factor) / factor;
}

export function addMoney(...values) {
  return roundMoney(values.reduce((sum, value) => sum + safeNumber(value), 0));
}

export function absoluteValue(value) {
  return Math.abs(safeNumber(value));
}
