function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function text(value) {
  return String(value || '').trim();
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

export function normalizeManufacturingComponent(component = {}) {
  return {
    ...component,
    id: text(component.id || component.ingId || component.itemId || component.stockItemId),
    ingId: text(component.ingId || component.id || component.itemId || component.stockItemId),
    itemId: text(component.itemId || component.id || component.ingId || component.stockItemId),
    stockItemId: text(component.stockItemId || component.itemId || component.id || component.ingId),
    name: text(component.name || component.itemName || component.stockItemName),
    unit: text(component.unit || component.uom),
    qty: number(component.qty ?? component.usage ?? component.quantity),
    usage: number(component.usage ?? component.qty ?? component.quantity),
    quantity: number(component.quantity ?? component.qty ?? component.usage),
    cost: number(component.cost ?? component.unitCost),
    unitCost: number(component.unitCost ?? component.cost)
  };
}

export function normalizeManufacturingLog(log = {}, fallbackId = '') {
  const components = toArray(log.components || log.recipe || log.items).map(normalizeManufacturingComponent);
  const base = {
    ...log,
    id: text(log.id || fallbackId),
    itemId: text(log.itemId || log.manufacturedItemId || log.stockItemId),
    manufacturedItemId: text(log.manufacturedItemId || log.itemId || log.stockItemId),
    stockItemId: text(log.stockItemId || log.itemId || log.manufacturedItemId),
    itemName: text(log.itemName || log.manufacturedItemName || log.stockItemName || log.name),
    manufacturedItemName: text(log.manufacturedItemName || log.itemName || log.stockItemName || log.name),
    producedQty: getManufacturingProducedQty(log),
    expectedQty: getManufacturingExpectedQty(log),
    batchCount: number(log.batchCount ?? log.batchMultiplier),
    unit: text(log.unit || log.uom),
    locationId: text(log.locationId),
    locationName: text(log.locationName),
    date: text(log.date || log.tradeDate),
    timestamp: log.timestamp || log.createdAt || log.postedAt || '',
    createdAt: log.createdAt || log.timestamp || log.postedAt || '',
    note: text(log.note || log.notes),
    batchCost: number(log.batchCost),
    expectedUnitCost: number(log.expectedUnitCost ?? log.unitCost),
    actualUnitCost: number(log.actualUnitCost ?? log.unitCost),
    unitCost: number(log.unitCost ?? log.expectedUnitCost ?? log.actualUnitCost),
    components
  };
  return {
    ...base,
    variance: getManufacturingVarianceQty(base),
    wastageQty: Math.max(number(log.wastageQty), getManufacturingShortfallQty(base)),
    wastageValue: getManufacturingWastageValue(base),
    expectedUnitCost: getManufacturingExpectedUnitCost(base),
    unitCost: getManufacturingExpectedUnitCost(base)
  };
}

export function normalizeManufacturingLogs(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || `mfg-${index + 1}`, item])
    : Object.entries(value);
  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeManufacturingLog(item, String(id || '').trim()));
}
