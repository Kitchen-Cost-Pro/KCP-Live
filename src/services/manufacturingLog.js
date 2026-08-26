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
  return number(log.expectedQty ?? log.expectedOutput ?? log.expected_qty ?? log.expected_output);
}

export function getManufacturingProducedQty(log = {}) {
  return number(log.producedQty ?? log.actualQty ?? log.qty ?? log.produced_qty ?? log.actual_qty);
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
    id: text(component.id || component.ingId || component.itemId || component.stockItemId || component.ing_id || component.item_id || component.stock_item_id),
    ingId: text(component.ingId || component.id || component.itemId || component.stockItemId || component.ing_id || component.item_id || component.stock_item_id),
    itemId: text(component.itemId || component.id || component.ingId || component.stockItemId || component.item_id || component.ing_id || component.stock_item_id),
    stockItemId: text(component.stockItemId || component.itemId || component.id || component.ingId || component.stock_item_id || component.item_id || component.ing_id),
    name: text(component.name || component.itemName || component.stockItemName || component.item_name || component.stock_item_name),
    unit: text(component.unit || component.uom),
    qty: number(component.qty ?? component.usage ?? component.quantity ?? component.qty_used),
    usage: number(component.usage ?? component.qty ?? component.quantity ?? component.qty_used),
    quantity: number(component.quantity ?? component.qty ?? component.usage ?? component.qty_used),
    cost: number(component.cost ?? component.unitCost ?? component.unit_cost),
    unitCost: number(component.unitCost ?? component.cost ?? component.unit_cost)
  };
}

export function normalizeManufacturingLog(log = {}, fallbackId = '') {
  const components = toArray(log.components || log.recipe || log.items).map(normalizeManufacturingComponent);
  const base = {
    ...log,
    id: text(log.id || log.batchId || log.batch_id || fallbackId),
    itemId: text(log.itemId || log.manufacturedItemId || log.stockItemId || log.item_id || log.manufactured_item_id || log.stock_item_id),
    manufacturedItemId: text(log.manufacturedItemId || log.itemId || log.stockItemId || log.manufactured_item_id || log.item_id || log.stock_item_id),
    stockItemId: text(log.stockItemId || log.itemId || log.manufacturedItemId || log.stock_item_id || log.item_id || log.manufactured_item_id),
    itemName: text(log.itemName || log.manufacturedItemName || log.stockItemName || log.name || log.item_name || log.manufactured_item_name || log.stock_item_name),
    manufacturedItemName: text(log.manufacturedItemName || log.itemName || log.stockItemName || log.name || log.manufactured_item_name || log.item_name || log.stock_item_name),
    producedQty: getManufacturingProducedQty(log),
    expectedQty: getManufacturingExpectedQty(log),
    batchCount: number(log.batchCount ?? log.batchMultiplier ?? log.batch_count ?? log.batch_multiplier),
    unit: text(log.unit || log.uom),
    locationId: text(log.locationId || log.location_id),
    locationName: text(log.locationName || log.location_name),
    date: text(log.date || log.tradeDate || log.trade_date),
    timestamp: log.timestamp || log.createdAt || log.created_at || log.postedAt || log.posted_at || '',
    createdAt: log.createdAt || log.created_at || log.timestamp || log.postedAt || log.posted_at || '',
    createdBy: text(log.createdBy || log.created_by),
    createdByName: text(log.createdByName || log.created_by_name || log.user || log.createdByEmail || log.created_by_email),
    createdByEmail: text(log.createdByEmail || log.created_by_email),
    user: text(log.user || log.createdByName || log.created_by_name || log.createdByEmail || log.created_by_email || log.createdBy || log.created_by),
    note: text(log.note || log.notes),
    batchCost: number(log.batchCost ?? log.batch_cost),
    expectedUnitCost: number(log.expectedUnitCost ?? log.unitCost ?? log.expected_unit_cost ?? log.unit_cost),
    actualUnitCost: number(log.actualUnitCost ?? log.unitCost ?? log.actual_unit_cost ?? log.unit_cost),
    unitCost: number(log.unitCost ?? log.expectedUnitCost ?? log.actualUnitCost ?? log.unit_cost ?? log.expected_unit_cost ?? log.actual_unit_cost),
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
