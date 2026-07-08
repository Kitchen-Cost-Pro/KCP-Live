import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchPurchaseOrdersWorkspace, normalizePurchaseOrders } from './purchaseOrderService.js';
import { todayLocal } from '../utils/date.js';

export function subscribeGrvWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for GRV entries.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchGrvWorkspace(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:grvs');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchGrvWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for GRV entries.');

  const [receiptResponse, purchaseOrderState] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'grvs', { query: { limit: 500 } }),
    fetchPurchaseOrdersWorkspace(workspaceKey)
  ]);

  return {
    status: 'ready',
    source: 'Live GRV entries',
    receipts: sortReceipts(normalizeGoodsReceipts(receiptResponse.receipts || [])),
    orders: sortOrders(normalizePurchaseOrders(purchaseOrderState.orders || [])),
    suppliers: sortByName(purchaseOrderState.suppliers || []),
    stockItems: sortByName(purchaseOrderState.stockItems || []),
    sites: sortByName(purchaseOrderState.sites || []),
    locations: sortByName(purchaseOrderState.locations || []),
    loaded: {
      receipts: true,
      orders: true,
      suppliers: true,
      stockItems: true,
      sites: true,
      locations: true
    },
    updatedAt: new Date().toISOString()
  };
}

export async function saveGoodsReceipt(workspaceId, receipt = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save GRV entries.');

  const payload = normalizeReceiptPayload(receipt);
  if (!payload.items.length) throw new Error('Add at least one received stock item.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'grvs', {
    method: 'POST',
    payload: { receipt: payload }
  });

  return { id: result.id || payload.id };
}

export function normalizeGoodsReceipts(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeGoodsReceipt(id, item));
}

function normalizeGoodsReceipt(id, item = {}) {
  const items = Array.isArray(item.items)
    ? item.items
    : Object.values(item.items || {});
  const totalEx = Number(item.totalEx ?? item.total ?? 0) || sumReceiptLines(items);
  const sourceDisplay = buildReceiptSourceDisplay(item);

  return {
    ...item,
    id: String(item.id || id || createId('grv')),
    grvNumber: String(item.grvNumber || item.reference || item.number || id || '').trim() || `GRV-${String(id || '').slice(0, 6).toUpperCase()}`,
    invoice: String(item.invoice || item.grvNumber || item.reference || item.number || id || '').trim(),
    sourcePoId: String(item.sourcePoId || item.poId || '').trim(),
    poNumber: String(item.poNumber || item.purchaseOrderNumber || '').trim(),
    supplierId: String(item.supplierId || '').trim(),
    supplierName: String(item.supplierName || item.supplier || 'Manual Receipt').trim(),
    supplier: String(item.supplier || item.supplierName || 'Manual Receipt').trim(),
    date: String(item.date || item.timestamp || item.createdAt || '').slice(0, 10),
    timestamp: item.timestamp || item.createdAt || item.date || '',
    locationId: String(item.locationId || item.targetLocation || '').trim(),
    locationName: String(item.locationName || item.targetLocationName || '').trim(),
    notes: String(item.notes || '').trim(),
    status: item.status || 'finalized',
    totalEx,
    sourceDisplay,
    sourceLabel: sourceDisplay,
    lineCount: Number(item.lineCount || items.length || 0),
    varianceCount: Number(item.varianceCount || items.filter((line) => Number(line.varianceQty || 0) !== 0).length || 0),
    items: items.map(normalizeReceiptLine).filter((line) => line.stockItemId),
    type: item.type || (item.sourcePoId ? 'PO_GRV' : 'MANUAL_GRV')
  };
}

function normalizeReceiptPayload(receipt = {}) {
  const id = String(receipt.id || '').trim();
  const defaultLocationId = String(receipt.locationId || receipt.targetLocation || '').trim();
  const defaultLocationName = String(receipt.locationName || receipt.targetLocationName || '').trim();

  return {
    id,
    grvNumber: String(receipt.grvNumber || '').trim(),
    sourcePoId: String(receipt.sourcePoId || '').trim(),
    poNumber: String(receipt.poNumber || '').trim(),
    supplierId: String(receipt.supplierId || '').trim(),
    supplierName: String(receipt.supplierName || '').trim() || 'Manual Receipt',
    date: String(receipt.date || todayLocal()).trim(),
    locationId: defaultLocationId,
    locationName: defaultLocationName,
    notes: String(receipt.notes || '').trim(),
    submittedByUserId: String(receipt.submittedByUserId || receipt.userId || '').trim(),
    submittedByName: String(receipt.submittedByName || receipt.userName || '').trim(),
    pricesIncludeVat: receipt.pricesIncludeVat === true,
    splitByLocation: receipt.splitByLocation === true,
    items: (receipt.items || [])
      .map((line) => normalizeReceiptLine(line, { defaultLocationId, defaultLocationName }))
      .filter((line) => line.stockItemId && Number(line.receivedQty || 0) > 0)
  };
}

function normalizeReceiptLine(line = {}, { defaultLocationId = '', defaultLocationName = '' } = {}) {
  const locationId = String(line.locationId || line.targetLocation || defaultLocationId).trim();
  const locationName = String(line.locationName || line.targetLocationName || defaultLocationName).trim();
  const receivedQty = Number(line.receivedQty ?? line.qty ?? line.quantity ?? 0) || 0;
  const orderedQty = Number(line.orderedQty ?? line.orderQty ?? line.qtyOrdered ?? 0) || 0;
  const packSize = Number(line.packSize ?? line.pack_size ?? 1) || 1;
  const unitCost = Number(line.unitCost ?? line.cost ?? line.price ?? 0) || 0;

  return {
    id: String(line.id || line.stockItemId || line.ingredientId || createId('line')),
    stockItemId: String(line.stockItemId || line.ingredientId || line.ingId || line.id || '').trim(),
    stockItemName: String(line.stockItemName || line.ingredientName || line.name || '').trim(),
    ingId: String(line.ingId || line.ingredientId || line.stockItemId || line.id || '').trim(),
    name: String(line.name || line.stockItemName || line.ingredientName || '').trim(),
    unit: String(line.unit || line.uom || 'ea').trim() || 'ea',
    selectedUom: String(line.selectedUom || line.receivingUom || line.purchaseUom || line.unit || line.uom || 'ea').trim() || 'ea',
    receivingUom: String(line.selectedUom || line.receivingUom || line.purchaseUom || line.unit || line.uom || 'ea').trim() || 'ea',
    uomConfigurations: normalizeUomConfigurations(line.uomConfigurations || line.uomConfig || line.uomConversions),
    orderedQty,
    receivedQty,
    qty: receivedQty,
    varianceQty: Number(line.varianceQty ?? receivedQty - orderedQty) || 0,
    packSize,
    unitCost,
    costEx: unitCost,
    locationId,
    targetLocation: locationId,
    locationName,
    targetLocationName: locationName,
    lineTotalEx: Number(line.lineTotalEx ?? (receivedQty * packSize * unitCost)) || 0
  };
}

function normalizeUomConfigurations(value = []) {
  const rows = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  return rows
    .map((entry = {}) => ({
      baseUom: String(entry.baseUom || entry.base_uom || entry.baseUnit || '').trim(),
      customUom: String(entry.customUom || entry.custom_uom || entry.customUnit || entry.orderingUom || '').trim(),
      ratio: Number(entry.ratio ?? entry.conversionRatio ?? entry.unitsPerCustomUnit ?? 0) || 0,
      barcode: String(entry.barcode || entry.customBarcode || entry.customUomBarcode || '').trim()
    }))
    .filter((entry) => entry.customUom && entry.ratio > 0);
}

function buildReceiptSourceDisplay(receipt = {}) {
  const supplierName = String(receipt.supplierName || receipt.supplier || '').trim();
  const invoiceNumber = String(
    receipt.invoice ||
    receipt.grvNumber ||
    receipt.reference ||
    receipt.number ||
    receipt.id ||
    ''
  ).trim();

  if (supplierName && invoiceNumber) return `${supplierName} (${invoiceNumber})`;
  if (supplierName) return supplierName;
  if (invoiceNumber) return invoiceNumber;
  return 'Manual Receipt';
}

function sumReceiptLines(items = []) {
  return (items || []).reduce((sum, line) => (
    sum + Number(
      line.lineTotalEx
      ?? (Number(line.receivedQty || line.qty || 0) * Math.max(Number(line.packSize || line.pack_size || 1), 1) * Number(line.unitCost || line.cost || 0))
    )
  ), 0);
}

function sortReceipts(items = []) {
  return [...items].sort((a, b) => String(b.timestamp || b.date || '').localeCompare(String(a.timestamp || a.date || '')));
}

function sortOrders(items = []) {
  return [...items].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

function sortByName(items = []) {
  return [...items].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}
