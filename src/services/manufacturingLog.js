function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

export function getManufacturingExpectedQty(log = {}) {
  return number(log.expectedQty ?? log.expectedOutput);
}

export function getManufacturingProducedQty(log = {}) {
  return number(log.producedQty ?? log.actualQty ?? log.qty);
}

export function getManufacturingVarianceQty(log = {}) {
  const explicitVariance = number(log.variance);
  const explicitWastage = number(log.wastageQty);
  const expectedQty = getManufacturingExpectedQty(log);
  const producedQty = getManufacturingProducedQty(log);
  const derivedVariance = expectedQty - producedQty;

  if (explicitWastage > 0) return explicitWastage;
  if (expectedQty > 0 || producedQty > 0) {
    if (explicitVariance !== 0 && Math.abs(explicitVariance) === Math.abs(derivedVariance) && Math.sign(explicitVariance) !== Math.sign(derivedVariance)) {
      return derivedVariance;
    }
    return explicitVariance || derivedVariance;
  }
  return explicitVariance;
}

export function getManufacturingShortfallQty(log = {}) {
  return Math.max(getManufacturingVarianceQty(log), 0);
}

export function getManufacturingComponentTotal(log = {}) {
  return toArray(log.components || log.recipe || log.items).reduce((sum, component) => {
    const qty = number(component.qty ?? component.usage ?? component.quantity);
    const cost = number(component.cost ?? component.unitCost);
    return sum + (qty * cost);
  }, 0);
}

export function getManufacturingExpectedUnitCost(log = {}) {
  const shortfallQty = getManufacturingShortfallQty(log);
  const explicitLoss = number(log.wastageValue);
  if (shortfallQty > 0 && explicitLoss > 0) return explicitLoss / shortfallQty;

  const explicitCost = number(log.expectedUnitCost ?? log.unitCost ?? log.actualUnitCost);
  if (explicitCost > 0) return explicitCost;

  const expectedQty = getManufacturingExpectedQty(log);
  const componentTotal = getManufacturingComponentTotal(log);
  return expectedQty > 0 ? componentTotal / expectedQty : 0;
}

export function getManufacturingWastageValue(log = {}) {
  const explicitLoss = number(log.wastageValue);
  if (explicitLoss > 0) return explicitLoss;
  return getManufacturingShortfallQty(log) * getManufacturingExpectedUnitCost(log);
}
