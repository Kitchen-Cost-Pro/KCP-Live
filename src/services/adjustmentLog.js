function text(value) {
  return String(value || '').trim();
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function normalizeWastageResponse(response = {}) {
  return response.adjustments || response.wastageAdjustments || response.items || response.movements || [];
}

export function normalizeAdjustmentLogs(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeAdjustmentLog(id, item));
}

export function normalizeAdjustmentLog(id, item = {}) {
  const isProductWastage = Boolean(item.productId || item.productName || item.product_id || item.product_name);
  return {
    ...item,
    id: text(item.id || id),
    itemId: text(item.itemId || item.stockItemId || item.productId || item.item_id || item.stock_item_id || item.product_id),
    itemName: text(item.itemName || item.stockItemName || item.productName || item.item_name || item.stock_item_name || item.product_name),
    stockItemId: text(item.stockItemId || item.itemId || item.productId || item.stock_item_id || item.item_id || item.product_id),
    stockItemName: text(item.stockItemName || item.itemName || item.productName || item.stock_item_name || item.item_name || item.product_name),
    productId: text(item.productId || item.product_id || item.itemId || item.item_id),
    productName: text(item.productName || item.product_name || item.itemName || item.item_name),
    category: text(item.category || item.stockItemCategory || item.stock_item_category) || 'General',
    locationId: text(item.locationId || item.location_id),
    locationName: text(item.locationName || item.location_name),
    createdBy: text(item.createdBy || item.created_by),
    createdByName: text(item.createdByName || item.created_by_name || item.user || item.createdByEmail),
    user: text(item.user || item.createdByName || item.createdByEmail || item.createdBy || item.created_by_name),
    mode: text(item.mode || item.adjustmentType || item.adjustment_type || (isProductWastage ? 'wastage' : '')) || 'remove',
    qty: number(item.qty ?? item.quantity ?? item.impactQty ?? item.impact_qty),
    quantity: number(item.quantity ?? item.qty ?? item.impactQty ?? item.impact_qty),
    unit: text(item.unit || item.uom),
    prevStock: number(item.prevStock ?? item.prev_stock),
    impactQty: number(item.impactQty ?? item.impact_qty ?? item.qty ?? item.quantity),
    impactEx: number(item.impactEx ?? item.impact_ex),
    newStock: number(item.newStock ?? item.new_stock),
    note: text(item.note || item.notes || item.reason),
    wasteReason: text(item.wasteReason || item.waste_reason),
    date: text(item.date || item.timestamp || item.createdAt || item.created_at).slice(0, 10),
    timestamp: item.timestamp || item.createdAt || item.created_at || item.date || '',
    createdAt: item.createdAt || item.created_at || item.timestamp || item.date || ''
  };
}
