import { safeNumber } from './calculations.js';
import { clamp } from './statistics.js';

export function calculateRiskScore({ probability = 0, financialImpact = 0, urgency = 0, dataConfidence = 100 } = {}) {
  const dataRisk = 100 - clamp(dataConfidence, 0, 100);
  return Math.round(clamp(
    clamp(probability) * 0.35
    + clamp(financialImpact) * 0.30
    + clamp(urgency) * 0.25
    + dataRisk * 0.10,
    0,
    100
  ));
}

export function calculatePriceRiskScore({ volatilityPercent = 0, costChangePercent = 0, purchaseValueImpact = 0, supplierDependence = 0, dataConfidence = 100 } = {}) {
  return calculateRiskScore({
    probability: clamp(Math.abs(safeNumber(volatilityPercent)) * 250),
    financialImpact: clamp(purchaseValueImpact),
    urgency: clamp(Math.abs(safeNumber(costChangePercent)) * 300 + clamp(supplierDependence) * 0.25),
    dataConfidence
  });
}

export function calculateVarianceImpactScore({ varianceValueImpact = 0, variancePercent = 0, itemValueImpact = 0, salesImportance = 0, dataConfidence = 100 } = {}) {
  return calculateRiskScore({
    probability: clamp(Math.abs(safeNumber(variancePercent)) * 200),
    financialImpact: clamp(Math.max(varianceValueImpact, itemValueImpact)),
    urgency: clamp(Math.abs(safeNumber(variancePercent)) * 120 + clamp(salesImportance) * 0.35),
    dataConfidence
  });
}

export function scoreToRiskStatus(score, { critical = 75, high = 55, watch = 30 } = {}) {
  const value = safeNumber(score);
  if (value >= critical) return 'Critical';
  if (value >= high) return 'High Risk';
  if (value >= watch) return 'Watch';
  return 'Healthy';
}

export function priceVolatilityStatus({ purchasesCount = 0, volatilityPercent = 0, costChangePercent = 0 } = {}) {
  if (safeNumber(purchasesCount) < 2) return 'Insufficient Data';
  const volatility = Math.abs(safeNumber(volatilityPercent));
  const change = Math.abs(safeNumber(costChangePercent));
  if (volatility >= 0.20 || change >= 0.15) return 'High';
  if (volatility >= 0.10 || change >= 0.08) return 'Medium';
  return 'Low';
}
