export function buildDefaultStockSku(name = '') {
  const itemName = String(name || '').trim() || 'Unnamed Stock Item';
  return `SKU - ${itemName}`;
}

export function resolveStockItemSku(name = '', ...candidates) {
  const explicit = candidates
    .map((value) => String(value ?? '').trim())
    .find(Boolean);
  return explicit || buildDefaultStockSku(name);
}
