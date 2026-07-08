import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchStock } from './stockService.js';
import { fetchSuppliers } from './supplierService.js';
import { DEFAULT_SITE_ID, normalizeSites, normalizeStockLocations } from './locationModel.js';
import { todayLocal } from '../utils/date.js';

const VALID_STATUSES = new Set(['draft', 'sent', 'partially_received', 'completed']);

export function subscribePurchaseOrders(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for purchase orders.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchPurchaseOrdersWorkspace(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:purchase-orders');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchPurchaseOrdersWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for purchase orders.');

  const [orderResponse, supplierResponse, stockResponse, locationResponse, siteResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'purchase-orders', { query: { limit: 500 } }),
    fetchSuppliers(workspaceKey),
    fetchStock(workspaceKey),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
    callCloudflareWorkspaceRoute(workspaceKey, 'site-configuration')
  ]);

  const settings = { siteName: siteResponse.siteConfiguration?.site_name || 'Main Site' };
  const sites = normalizeSites([{ id: DEFAULT_SITE_ID, name: settings.siteName, isDefault: true }], settings);
  const locations = normalizeStockLocations((locationResponse.locations || []).map(normalizeCloudflareLocation), sites, settings);

  return {
    status: 'ready',
    source: 'Live purchase orders',
    orders: sortOrders(normalizePurchaseOrders(orderResponse.orders || [])),
    suppliers: sortByName(supplierResponse.items || []),
    stockItems: sortByName(stockResponse.items || []),
    sites: sortByName(sites),
    locations: sortByName(locations),
    loaded: {
      orders: true,
      suppliers: true,
      stockItems: true,
      sites: true,
      locations: true
    },
    updatedAt: new Date().toISOString()
  };
}

export async function upsertPurchaseOrder(workspaceId, order = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save a purchase order.');

  const payload = normalizeOrderPayload(order);
  if (!payload.supplierId) throw new Error('Select a supplier before saving the purchase order.');
  if (!payload.items.length) throw new Error('Add at least one stock item to the purchase order.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'purchase-orders', {
    method: 'POST',
    payload: { order: payload }
  });

  return { id: result.id || payload.id };
}

export async function updatePurchaseOrderStatus(workspaceId, orderId, nextStatus) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(orderId || '').trim();
  const status = normalizeStatus(nextStatus);
  if (!workspaceKey) throw new Error('Workspace id is required to update a purchase order.');
  if (!id) throw new Error('Purchase order id is required.');
  if (status !== 'sent') throw new Error('Purchase order status can only change through Send or GRV workflow actions.');

  await callCloudflareWorkspaceRoute(workspaceKey, `purchase-orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    payload: {
      status,
      submittedAt: new Date().toISOString()
    }
  });
}

export async function deletePurchaseOrder(workspaceId, orderId) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(orderId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to delete a purchase order.');
  if (!id) throw new Error('Purchase order id is required.');

  await callCloudflareWorkspaceRoute(workspaceKey, `purchase-orders/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export async function deleteMultiplePurchaseOrders(workspaceId, orderIds = []) {
  const workspaceKey = String(workspaceId || '').trim();
  const ids = new Set(orderIds.map(String).filter(Boolean));
  if (!workspaceKey) throw new Error('Workspace id is required to delete purchase orders.');
  if (!ids.size) return;

  await callCloudflareWorkspaceRoute(workspaceKey, 'purchase-orders/bulk-delete', {
    method: 'POST',
    payload: { ids: [...ids] }
  });
}

export function normalizePurchaseOrders(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, order]) => order && typeof order === 'object')
    .map(([id, order]) => normalizePurchaseOrder(id, order));
}

export function normalizePurchaseOrder(id, order = {}) {
  const items = Array.isArray(order.items)
    ? order.items
    : Object.values(order.items || {});
  const defaultLocationId = String(order.locationId || order.targetLocation || order.location || '').trim();
  const defaultLocationName = String(order.targetLocationName || order.locationName || '').trim();

  return {
    id: String(order.id || id || createId('po')),
    poNumber: String(order.poNumber || order.reference || order.number || id || '').trim() || `PO-${String(id || '').slice(0, 6).toUpperCase()}`,
    reference: String(order.reference || order.poNumber || order.number || id || '').trim(),
    date: String(order.date || order.createdAt || order.orderedAt || '').slice(0, 10),
    supplierId: String(order.supplierId || order.supplier || '').trim(),
    supplierName: String(order.supplierName || order.supplier || 'Unassigned Supplier').trim(),
    locationId: String(order.locationId || order.targetLocation || order.location || '').trim(),
    targetLocation: String(order.targetLocation || order.locationId || order.location || '').trim(),
    targetLocationName: String(order.targetLocationName || order.locationName || '').trim(),
    status: normalizeStatus(order.status),
    items: items.map((line) => normalizePurchaseLine(line, { defaultLocationId, defaultLocationName })).filter((line) => line.stockItemId),
    notes: String(order.notes || '').trim(),
    createdAt: order.createdAt || order.date || order.orderedAt || '',
    submittedAt: order.submittedAt || '',
    partiallyReceivedAt: order.partiallyReceivedAt || '',
    receivedAt: order.receivedAt || '',
    updatedAt: order.updatedAt || '',
    receivedItems: normalizeArray(order.receivedItems),
    receivedHistory: normalizeArray(order.receivedHistory),
    receivedTotalEx: Number(order.receivedTotalEx || 0) || 0,
    grvId: String(order.grvId || '').trim(),
    lastGrvId: String(order.lastGrvId || '').trim()
  };
}

function normalizePurchaseLine(line = {}, { defaultLocationId = '', defaultLocationName = '' } = {}) {
  const locationId = String(line.locationId || line.targetLocation || line.location || defaultLocationId).trim();
  const locationName = String(line.locationName || line.targetLocationName || line.locationLabel || defaultLocationName).trim();
  return {
    id: String(line.id || line.stockItemId || line.ingId || createId('line')),
    stockItemId: String(line.stockItemId || line.ingredientId || line.ingId || line.id || '').trim(),
    stockItemName: String(line.stockItemName || line.ingredientName || line.name || '').trim(),
    qty: Number(line.qty ?? line.quantity ?? line.orderQty ?? 0) || 0,
    packSize: Number(line.packSize ?? line.pack_size ?? 1) || 1,
    unitCost: Number(line.unitCost ?? line.cost ?? line.price ?? 0) || 0,
    unit: String(line.unit || line.uom || 'ea').trim() || 'ea',
    selectedUom: String(line.selectedUom || line.purchaseUom || line.orderUom || line.unit || line.uom || 'ea').trim() || 'ea',
    purchaseUom: String(line.selectedUom || line.purchaseUom || line.orderUom || line.unit || line.uom || 'ea').trim() || 'ea',
    uomConfigurations: normalizeUomConfigurations(line.uomConfigurations || line.uomConfig || line.uomConversions),
    receivedQty: Number(line.receivedQty ?? line.received ?? 0) || 0,
    remainingQty: Number(line.remainingQty ?? Math.max((Number(line.qty ?? line.quantity ?? line.orderQty ?? 0) || 0) - (Number(line.receivedQty ?? line.received ?? 0) || 0), 0)) || 0,
    locationId,
    targetLocation: locationId,
    locationName,
    targetLocationName: locationName
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

function normalizeOrderPayload(order = {}) {
  const id = String(order.id || createId('po')).trim();
  const defaultLocationId = String(order.locationId || order.targetLocation || '').trim();
  const defaultLocationName = String(order.targetLocationName || order.locationName || '').trim();
  return {
    id,
    poNumber: String(order.poNumber || order.reference || `PO-${id.slice(-6).toUpperCase()}`).trim(),
    reference: String(order.reference || order.poNumber || `PO-${id.slice(-6).toUpperCase()}`).trim(),
    date: String(order.date || todayLocal()).trim(),
    supplierId: String(order.supplierId || '').trim(),
    supplierName: String(order.supplierName || '').trim(),
    locationId: String(order.locationId || order.targetLocation || '').trim(),
    targetLocation: String(order.targetLocation || order.locationId || '').trim(),
    targetLocationName: String(order.targetLocationName || '').trim(),
    status: normalizeStatus(order.status || 'draft'),
    items: (order.items || []).map((line) => normalizePurchaseLine(line, { defaultLocationId, defaultLocationName })).filter((line) => line.stockItemId && line.qty > 0),
    notes: String(order.notes || '').trim(),
    createdAt: order.createdAt || new Date().toISOString(),
    submittedAt: order.submittedAt || '',
    partiallyReceivedAt: order.partiallyReceivedAt || '',
    receivedAt: order.receivedAt || '',
    receivedItems: normalizeArray(order.receivedItems),
    receivedHistory: normalizeArray(order.receivedHistory),
    receivedTotalEx: Number(order.receivedTotalEx || 0) || 0,
    grvId: String(order.grvId || '').trim(),
    lastGrvId: String(order.lastGrvId || '').trim()
  };
}

function normalizeCloudflareLocation(row = {}) {
  const id = String(row.id || '').trim();
  const isDefault = Number(row.is_default || row.isDefault || 0) === 1 || id === 'main';
  const kind = String(row.kind || (isDefault ? 'storage' : 'selling')).trim();
  const raw = parseJsonObject(row.raw_json || row.rawJson);
  return {
    ...raw,
    id,
    locationId: id,
    siteId: DEFAULT_SITE_ID,
    name: row.display_name || row.displayName || row.name || row.external_name || row.externalName || 'Location',
    displayName: row.display_name || row.displayName || row.name || '',
    type: kind,
    kind,
    taxInfo: normalizeLocationTaxInfo(raw.taxInfo || raw.siteTaxInfo || row.taxInfo || {}),
    siteInfo: normalizeLocationSiteInfo(raw.siteInfo || raw.site_info || row.siteInfo || {}),
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault
  };
}

function normalizeLocationTaxInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    useDifferentTaxInfo: source.useDifferentTaxInfo === true || String(source.useDifferentTaxInfo || '').toLowerCase() === 'true',
    registeredCompanyName: String(source.registeredCompanyName || '').trim(),
    tradingName: String(source.tradingName || '').trim(),
    companyRegistrationNumber: String(source.companyRegistrationNumber || '').trim(),
    vatNumber: String(source.vatNumber || '').trim(),
    taxNumber: String(source.taxNumber || '').trim(),
    registeredAddress: String(source.registeredAddress || '').trim(),
    registeredAddressLine1: String(source.registeredAddressLine1 || source.addressLine1 || '').trim(),
    registeredAddressLine2: String(source.registeredAddressLine2 || source.addressLine2 || '').trim(),
    suburb: String(source.suburb || '').trim(),
    city: String(source.city || '').trim(),
    province: String(source.province || '').trim(),
    postalCode: String(source.postalCode || '').trim(),
    country: String(source.country || '').trim(),
    accountsContactName: String(source.accountsContactName || '').trim(),
    accountsContactEmail: String(source.accountsContactEmail || '').trim(),
    accountsContactPhone: String(source.accountsContactPhone || '').trim()
  };
}

function normalizeLocationSiteInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    siteTradingName: String(source.siteTradingName || source.site_trading_name || source.tradingName || '').trim(),
    supplierFacingDeliveryName: String(source.supplierFacingDeliveryName || source.supplier_facing_delivery_name || source.deliveryName || '').trim(),
    deliveryAddressLine1: String(source.deliveryAddressLine1 || source.addressLine1 || source.delivery_address_line_1 || '').trim(),
    deliveryAddressLine2: String(source.deliveryAddressLine2 || source.addressLine2 || source.delivery_address_line_2 || '').trim(),
    suburb: String(source.suburb || '').trim(),
    city: String(source.city || '').trim(),
    province: String(source.province || source.state || '').trim(),
    postalCode: String(source.postalCode || source.postal_code || source.postcode || '').trim(),
    country: String(source.country || '').trim(),
    receivingContactName: String(source.receivingContactName || source.receiving_contact_name || '').trim(),
    receivingContactPhone: String(source.receivingContactPhone || source.receiving_contact_phone || '').trim(),
    receivingContactEmail: String(source.receivingContactEmail || source.receiving_contact_email || '').trim(),
    deliveryInstructions: String(source.deliveryInstructions || source.delivery_instructions || '').trim(),
    receivingHours: String(source.receivingHours || source.receiving_hours || '').trim(),
    supplierNotes: String(source.supplierNotes || source.supplier_notes || '').trim()
  };
}

function parseJsonObject(value = '') {
  if (!value) return {};
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeStatus(status) {
  const value = String(status || 'draft').trim().toLowerCase();
  if (value === 'sent' || value === 'submitted' || value === 'pending') return 'sent';
  if (value === 'partial' || value === 'partially received' || value === 'partially-received' || value === 'partially_received') return 'partially_received';
  if (value === 'complete' || value === 'completed' || value === 'received') return 'completed';
  return VALID_STATUSES.has(value) ? value : 'draft';
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : Object.values(value || {}).filter(Boolean);
}

function sortOrders(orders) {
  return [...orders].sort((a, b) => {
    const statusCompare = statusWeight(a.status) - statusWeight(b.status);
    if (statusCompare) return statusCompare;
    return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  });
}

function statusWeight(status) {
  if (status === 'draft') return 0;
  if (status === 'sent') return 1;
  if (status === 'partially_received') return 2;
  return 3;
}

function sortByName(items = []) {
  return [...items].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}
