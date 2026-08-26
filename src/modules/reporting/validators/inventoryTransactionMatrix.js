function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeCostingMethod(value) {
  return ['wac', 'weighted_average', 'weighted-average', 'weighted'].includes(String(value || '').toLowerCase()) ? 'wac' : 'last';
}

export function incomingCost({ method, quantity, unitCost, incomingQuantity, incomingUnitCost }) {
  const normalized = normalizeCostingMethod(method);
  if (normalized === 'last') return finite(incomingUnitCost);
  const oldQty = Math.max(finite(quantity), 0);
  const newQty = Math.max(finite(incomingQuantity), 0);
  const total = oldQty + newQty;
  return total > 0
    ? ((oldQty * finite(unitCost)) + (newQty * finite(incomingUnitCost))) / total
    : finite(incomingUnitCost);
}

export function createInventoryMatrix(method = 'last') {
  const locations = new Map();
  const ledger = [];

  function state(locationId) {
    if (!locations.has(locationId)) locations.set(locationId, { quantity: 0, unitCost: 0 });
    return locations.get(locationId);
  }

  function movement(locationId, sourceType, quantity, unitCost, metadata = {}) {
    const row = {
      locationId,
      sourceType,
      quantity: finite(quantity),
      unitCost: finite(unitCost),
      value: finite(quantity) * finite(unitCost),
      metadata
    };
    ledger.push(row);
    return row;
  }

  return {
    method: normalizeCostingMethod(method),
    grv(locationId, quantity, receiptCost) {
      const current = state(locationId);
      const nextCost = incomingCost({
        method: this.method,
        quantity: current.quantity,
        unitCost: current.unitCost,
        incomingQuantity: quantity,
        incomingUnitCost: receiptCost
      });
      movement(locationId, 'GRV', quantity, receiptCost);
      current.quantity += finite(quantity);
      current.unitCost = nextCost;
      return { ...current };
    },
    sale(locationId, quantity) {
      const current = state(locationId);
      const qty = -Math.abs(finite(quantity));
      const row = movement(locationId, 'Sale Usage', qty, current.unitCost);
      current.quantity += qty;
      return row;
    },
    refund(locationId, quantity) {
      const current = state(locationId);
      const qty = Math.abs(finite(quantity));
      const row = movement(locationId, 'Sale Refund', qty, current.unitCost);
      current.quantity += qty;
      return row;
    },
    adjustment(locationId, quantity) {
      const current = state(locationId);
      const qty = finite(quantity);
      const row = movement(locationId, 'Manual Adjustment', qty, current.unitCost);
      current.quantity += qty;
      return row;
    },
    stockTake(locationId, countedQuantity) {
      const current = state(locationId);
      const variance = finite(countedQuantity) - current.quantity;
      const row = movement(locationId, 'Stock Take Variance', variance, current.unitCost);
      current.quantity = finite(countedQuantity);
      return row;
    },
    manufacturingConsume(locationId, quantity) {
      const current = state(locationId);
      const qty = -Math.abs(finite(quantity));
      const row = movement(locationId, 'Manufacturing Out', qty, current.unitCost);
      current.quantity += qty;
      return row;
    },
    transfer(fromLocationId, toLocationId, quantity) {
      const source = state(fromLocationId);
      const destination = state(toLocationId);
      const qty = Math.abs(finite(quantity));
      const carriedCost = source.unitCost;
      movement(fromLocationId, 'Transfer Out', -qty, carriedCost);
      source.quantity -= qty;
      const destinationCost = incomingCost({
        method: this.method,
        quantity: destination.quantity,
        unitCost: destination.unitCost,
        incomingQuantity: qty,
        incomingUnitCost: carriedCost
      });
      movement(toLocationId, 'Transfer In', qty, carriedCost);
      destination.quantity += qty;
      destination.unitCost = destinationCost;
      return { source: { ...source }, destination: { ...destination }, carriedCost };
    },
    getLocation(locationId) {
      return { ...state(locationId) };
    },
    getLedger() {
      return ledger.map((row) => ({ ...row, metadata: { ...row.metadata } }));
    },
    reconcile(locationId) {
      const rows = ledger.filter((row) => row.locationId === locationId);
      return {
        movementQuantity: rows.reduce((sum, row) => sum + row.quantity, 0),
        movementValue: rows.reduce((sum, row) => sum + row.value, 0),
        closingQuantity: state(locationId).quantity,
        currentUnitCost: state(locationId).unitCost
      };
    }
  };
}
