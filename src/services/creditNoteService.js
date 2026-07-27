import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchStock, normalizeIngredients } from './stockService.js';
import { fetchSuppliers } from './supplierService.js';
import { DEFAULT_SITE_ID, normalizeSites, normalizeStockLocations } from './locationModel.js';
import { fetchGrvWorkspace, normalizeGoodsReceipts } from './grvService.js';
import { todayLocal } from '../utils/date.js';

export function subscribeCreditNotesWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for credit notes.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchCreditNotesWorkspace(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:credit-notes');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchCreditNotesWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for credit notes.');

  const [creditNoteResponse, grvState, stockState, supplierState, locationResponse, siteResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'credit-notes', { query: { limit: 500 } }),
    fetchGrvWorkspace(workspaceKey),
    fetchStock(workspaceKey),
    fetchSuppliers(workspaceKey),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
    callCloudflareWorkspaceRoute(workspaceKey, 'site-configuration')
  ]);

  const settings = { siteName: siteResponse.siteConfiguration?.site_name || 'Main Site' };
  const sites = normalizeSites([{ id: DEFAULT_SITE_ID, name: settings.siteName, isDefault: true }], settings);
  const locations = normalizeStockLocations((locationResponse.locations || []).map(normalizeCloudflareLocation), sites, settings);

  const creditNotes = sortCreditNotes(normalizeCreditNotes(creditNoteResponse.creditNotes || []));
  const processedGrvs = sortProcessedGrvs(
    filterCreditableProcessedGrvs(normalizeProcessedGrvs(grvState.receipts || []), creditNotes)
  );

  return {
    status: 'ready',
    source: 'Live credit notes',
    creditNotes,
    processedGrvs,
    stockItems: sortByName(normalizeIngredients(stockState.items || [])),
    sites: sortByName(sites),
    locations: sortByName(locations),
    suppliers: sortByName(supplierState.items || []),
    loaded: {
      creditNotes: true,
      processedGrvs: true,
      stockItems: true,
      sites: true,
      locations: true,
      suppliers: true
    },
    updatedAt: new Date().toISOString()
  };
}

export async function saveCreditNote(workspaceId, creditNote = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save credit notes.');

  const payload = normalizeCreditNotePayload(creditNote);
  if (!payload.items.length) throw new Error('Add at least one stock item to the credit note.');
  if (!payload.supplierName) throw new Error('Supplier name is required.');
  if (!payload.cnNumber) throw new Error('Credit note number is required.');
  if (!payload.notes) throw new Error('Reasoning is required before saving the credit note.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'credit-notes', {
    method: 'POST',
    payload: { creditNote: payload }
  });

  return { id: result.id || payload.id };
}

export function normalizeCreditNotes(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeCreditNote(id, item));
}

function normalizeCreditNote(id, item = {}) {
  const items = Array.isArray(item.items)
    ? item.items
    : Object.values(item.items || {});
  const totalEx = Number(item.totalEx ?? item.total ?? 0) || items.reduce(
    (sum, line) => sum + (Number(line.lineTotalEx || 0) || (Number(line.baseQuantity || line.qty || 0) * Number(line.unitCost || line.costEx || 0))),
    0
  );

  return {
    ...item,
    id: String(item.id || id || createId('cn')),
    cnNumber: String(item.cnNumber || item.number || item.invoice || '').trim(),
    invoice: String(item.invoice || item.cnNumber || item.number || '').trim(),
    supplierId: String(item.supplierId || '').trim(),
    supplierName: String(item.supplierName || item.supplier || '').trim(),
    supplier: String(item.supplier || item.supplierName || '').trim(),
    date: String(item.date || item.timestamp || '').slice(0, 10),
    timestamp: item.timestamp || item.createdAt || item.date || '',
    locationId: String(item.locationId || '').trim(),
    locationName: String(item.locationName || '').trim(),
    notes: String(item.notes || '').trim(),
    totalEx,
    lineCount: Number(item.lineCount || items.length || 0),
    items: items.map(normalizeCreditNoteLine).filter((line) => line.stockItemId),
    type: item.type || 'SUPPLIER_CREDIT_NOTE'
  };
}

function normalizeCreditNoteLine(line = {}) {
  const packSize = Math.max(parseCreditNoteNumber(line.packSize ?? line.pack_size ?? 1, 1), 1);
  const returnedQty = resolveCreditNoteReturnedQty(line, packSize);
  const baseQuantity = parseCreditNoteNumber(line.baseQuantity, returnedQty * packSize) || 0;
  const unitCost = parseCreditNoteNumber(line.unitCost ?? line.costEx ?? line.cost ?? line.price, 0) || 0;
  const unit = String(line.unit || line.uom || 'ea').trim() || 'ea';
  const selectedUom = String(line.selectedUom || line.returnUom || line.receivingUom || line.purchaseUom || unit).trim() || unit;
  return {
    ...line,
    stockItemId: resolveCreditNoteStockItemId(line),
    stockItemName: String(line.stockItemName || line.name || line.itemName || '').trim(),
    unit,
    selectedUom,
    returnUom: selectedUom,
    uomConfigurations: normalizeCreditNoteUomConfigurations(line.uomConfigurations || line.uomConfig || line.uomConversions),
    returnedQty,
    packQty: returnedQty,
    packSize,
    baseQuantity,
    unitCost,
    lineTotalEx: Number(line.lineTotalEx || (baseQuantity * unitCost)) || 0,
    vatEnabled: line.vatEnabled !== false,
    locationId: String(line.locationId || '').trim(),
    locationName: String(line.locationName || '').trim()
  };
}

function normalizeCreditNotePayload(creditNote = {}) {
  const id = String(creditNote.id || createId('cn')).trim();
  return {
    id,
    cnNumber: String(creditNote.cnNumber || creditNote.number || `CN-${id.slice(-6).toUpperCase()}`).trim(),
    supplierId: String(creditNote.supplierId || '').trim(),
    supplierName: String(creditNote.supplierName || '').trim(),
    date: String(creditNote.date || todayLocal()).trim(),
    locationId: String(creditNote.locationId || '').trim(),
    locationName: String(creditNote.locationName || '').trim(),
    sourceType: String(creditNote.sourceType || '').trim(),
    sourceGrvId: String(creditNote.sourceGrvId || '').trim(),
    sourceGrvNumber: String(creditNote.sourceGrvNumber || '').trim(),
    sourcePoId: String(creditNote.sourcePoId || '').trim(),
    poNumber: String(creditNote.poNumber || '').trim(),
    sourceInvoice: String(creditNote.sourceInvoice || '').trim(),
    sourceReceiptIds: normalizeStringArray(creditNote.sourceReceiptIds),
    sourceReceiptNumbers: normalizeStringArray(creditNote.sourceReceiptNumbers),
    notes: String(creditNote.notes || '').trim(),
    pricesIncludeVat: creditNote.pricesIncludeVat === true,
    items: (creditNote.items || []).map((item) => {
      const packSize = Math.max(parseCreditNoteNumber(item.packSize ?? item.pack_size ?? 1, 1), 1);
      const returnedQty = resolveCreditNoteReturnedQty(item, packSize);
      const unit = String(item.unit || item.uom || 'ea').trim() || 'ea';
      const selectedUom = String(item.selectedUom || item.returnUom || item.receivingUom || item.purchaseUom || unit).trim() || unit;
      return {
        stockItemId: resolveCreditNoteStockItemId(item),
        stockItemName: String(item.stockItemName || item.name || item.itemName || '').trim(),
        unit,
        selectedUom,
        returnUom: selectedUom,
        uomConfigurations: normalizeCreditNoteUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions),
        returnedQty,
        packQty: returnedQty,
        packSize,
        baseQuantity: returnedQty * packSize,
        unitCost: parseCreditNoteNumber(item.unitCost ?? item.costEx ?? item.cost ?? item.price, 0) || 0,
        vatEnabled: item.vatEnabled !== false,
        locationId: String(item.locationId || creditNote.locationId || '').trim(),
        locationName: String(item.locationName || creditNote.locationName || '').trim()
      };
    }).filter((item) => item.stockItemId && item.returnedQty > 0)
  };
}

function resolveCreditNoteReturnedQty(line = {}, packSize = 1) {
  const returnedQty = parseCreditNoteNumber(
    line.returnedQty ?? line.packQty ?? line.receivedQty ?? line.quantity ?? line.qty,
    0
  );
  if (returnedQty > 0) return returnedQty;
  const baseQuantity = parseCreditNoteNumber(line.baseQuantity, 0);
  return baseQuantity > 0 ? baseQuantity / Math.max(packSize, 1) : 0;
}

function parseCreditNoteNumber(value, fallback = 0) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = Number(String(value ?? '').trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveCreditNoteStockItemId(line = {}) {
  return String(
    line.stockItemId ||
    line.ingredientId ||
    line.ingId ||
    line.itemId ||
    line.stock_item_id ||
    line.id ||
    ''
  ).trim();
}

function normalizeCreditNoteUomConfigurations(value = []) {
  const rows = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  return rows
    .map((entry = {}) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      return {
        baseUom: String(row.baseUom || row.base_uom || row.baseUnit || row.unit || '').trim(),
        customUom: String(row.customUom || row.custom_uom || row.customUnit || row.orderingUom || '').trim(),
        ratio: parseCreditNoteNumber(row.ratio ?? row.conversionRatio ?? row.unitsPerCustomUnit ?? row.units_per_custom_unit, 0),
        barcode: String(row.barcode || row.customBarcode || row.customUomBarcode || '').trim()
      };
    })
    .filter((entry) => entry.customUom && entry.ratio > 0);
}

function normalizeProcessedGrvs(value) {
  return mergePurchaseOrderReceiptsForCreditNotes(normalizeGoodsReceipts(value));
}

function filterCreditableProcessedGrvs(receipts = [], creditNotes = []) {
  const creditedKeys = new Set();
  creditNotes.forEach((note) => {
    getCreditNoteSourceKeys(note).forEach((key) => creditedKeys.add(key));
  });
  if (!creditedKeys.size) return receipts;
  return receipts.filter((receipt) => !getReceiptSourceKeys(receipt).some((key) => creditedKeys.has(key)));
}

function getCreditNoteSourceKeys(note = {}) {
  const keys = [];
  addSourceKey(keys, 'receipt-id', note.sourceGrvId);
  addSourceKey(keys, 'grv-number', note.sourceGrvNumber);
  addSourceKey(keys, 'po-id', note.sourcePoId);
  addSourceKey(keys, 'po-number', note.poNumber);
  addSourceKey(keys, 'invoice', note.sourceInvoice);
  normalizeStringArray(note.sourceReceiptIds).forEach((id) => addSourceKey(keys, 'receipt-id', id));
  normalizeStringArray(note.sourceReceiptNumbers).forEach((number) => {
    addSourceKey(keys, 'grv-number', number);
    addSourceKey(keys, 'invoice', number);
  });
  const legacyReference = getLegacySourceReferenceFromNotes(note.notes || note.reason);
  if (legacyReference) {
    addSourceKey(keys, 'grv-number', legacyReference);
    addSourceKey(keys, 'po-number', legacyReference);
    addSourceKey(keys, 'invoice', legacyReference);
  }
  return keys;
}

function getReceiptSourceKeys(receipt = {}) {
  const keys = [];
  addSourceKey(keys, 'receipt-id', receipt.id);
  addSourceKey(keys, 'receipt-id', receipt.sourceGrvId);
  addSourceKey(keys, 'grv-number', receipt.grvNumber);
  addSourceKey(keys, 'grv-number', receipt.invoice);
  addSourceKey(keys, 'po-id', receipt.sourcePoId);
  addSourceKey(keys, 'po-id', receipt.poId);
  addSourceKey(keys, 'po-number', receipt.poNumber);
  addSourceKey(keys, 'po-number', receipt.purchaseOrderNumber);
  addSourceKey(keys, 'invoice', receipt.invoice);
  normalizeStringArray(receipt.sourceReceiptIds).forEach((id) => addSourceKey(keys, 'receipt-id', id));
  normalizeStringArray(receipt.sourceReceiptNumbers).forEach((number) => {
    addSourceKey(keys, 'grv-number', number);
    addSourceKey(keys, 'invoice', number);
  });
  return keys;
}

function addSourceKey(keys, prefix, value) {
  const text = String(value || '').trim().toLowerCase();
  if (text) keys.push(`${prefix}:${text}`);
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? text.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function getLegacySourceReferenceFromNotes(value = '') {
  const match = String(value || '').match(/processed\s+from\s+(?:received\s+)?(?:po|grv)\s+([a-z0-9._/-]+)/i);
  return match?.[1] || '';
}

function mergePurchaseOrderReceiptsForCreditNotes(receipts = []) {
  const mergedByPo = new Map();
  const passthrough = [];

  receipts.forEach((receipt) => {
    const poKey = getReceiptPurchaseOrderKey(receipt);
    if (!poKey) {
      passthrough.push(receipt);
      return;
    }

    if (!mergedByPo.has(poKey)) {
      mergedByPo.set(poKey, {
        ...receipt,
        id: `po_received_${poKey}`,
        grvNumber: receipt.poNumber || receipt.grvNumber || receipt.id || 'Purchase Order',
        invoice: receipt.poNumber || receipt.invoice || receipt.grvNumber || '',
        sourceReceiptIds: [],
        sourceReceiptNumbers: [],
        items: [],
        totalEx: 0,
        lineCount: 0,
        varianceCount: 0,
        sourceDisplay: '',
        sourceLabel: '',
        type: 'PO_RECEIVED_GROUP'
      });
    }

    const group = mergedByPo.get(poKey);
    group.sourceReceiptIds.push(receipt.id);
    group.sourceReceiptNumbers.push(receipt.grvNumber || receipt.invoice || receipt.id);
    group.date = latestDate(group.date, receipt.date);
    group.timestamp = latestDateTime(group.timestamp, receipt.timestamp || receipt.date);
    group.totalEx += Number(receipt.totalEx || 0) || 0;
    group.varianceCount += Number(receipt.varianceCount || 0) || 0;
    if (!group.supplierId && receipt.supplierId) group.supplierId = receipt.supplierId;
    if (!group.supplierName && receipt.supplierName) group.supplierName = receipt.supplierName;
    if (!group.supplier && receipt.supplier) group.supplier = receipt.supplier;
    if (!group.locationId && receipt.locationId) group.locationId = receipt.locationId;
    if (!group.locationName && receipt.locationName) group.locationName = receipt.locationName;
    if (String(group.locationId || '') !== String(receipt.locationId || group.locationId || '')) {
      group.locationId = '';
      group.locationName = 'Multiple Locations';
    }

    receipt.items.forEach((line) => mergeReceivedLine(group.items, line));
  });

  const grouped = [...mergedByPo.values()].map((group) => {
    const receiptCount = group.sourceReceiptIds.length;
    return {
      ...group,
      sourceReceiptIds: [...new Set(group.sourceReceiptIds.filter(Boolean).map(String))],
      sourceReceiptNumbers: [...new Set(group.sourceReceiptNumbers.filter(Boolean).map(String))],
      sourceDisplay: `${group.supplierName || group.supplier || 'Supplier'} (${group.poNumber || group.grvNumber || 'PO'})`,
      sourceLabel: `${group.poNumber || group.grvNumber || 'PO'} · ${receiptCount} receipt${receiptCount === 1 ? '' : 's'}`,
      lineCount: group.items.length
    };
  });

  return [...grouped, ...passthrough];
}

function getReceiptPurchaseOrderKey(receipt = {}) {
  const sourcePoId = String(receipt.sourcePoId || receipt.poId || '').trim();
  if (sourcePoId) return `id_${sourcePoId}`;
  const poNumber = String(receipt.poNumber || receipt.purchaseOrderNumber || '').trim();
  if (poNumber) return `number_${poNumber.toLowerCase()}`;
  return '';
}

function mergeReceivedLine(targetLines = [], line = {}) {
  const stockItemId = String(line.stockItemId || line.ingredientId || line.ingId || line.id || '').trim();
  const locationId = String(line.locationId || line.targetLocation || '').trim();
  const packSize = Math.max(Number(line.packSize || line.pack_size || 1) || 1, 1);
  const unit = String(line.unit || 'ea').trim() || 'ea';
  const key = [
    stockItemId,
    locationId,
    unit.toLowerCase(),
    packSize
  ].join('::');
  const receivedQty = Number(line.receivedQty ?? line.qty ?? line.quantity ?? 0) || 0;
  if (!stockItemId || receivedQty <= 0) return;

  const orderedQty = Number(line.orderedQty ?? line.orderQty ?? 0) || 0;
  const lineTotalEx = Number(line.lineTotalEx ?? (receivedQty * packSize * Number(line.unitCost || line.costEx || 0))) || 0;
  let target = targetLines.find((item) => item._mergeKey === key);

  if (!target) {
    target = {
      ...line,
      _mergeKey: key,
      id: line.id || stockItemId,
      stockItemId,
      ingId: String(line.ingId || line.ingredientId || stockItemId),
      stockItemName: line.stockItemName || line.name || '',
      name: line.name || line.stockItemName || '',
      unit,
      orderedQty: 0,
      receivedQty: 0,
      qty: 0,
      varianceQty: 0,
      packSize,
      unitCost: 0,
      costEx: 0,
      locationId,
      targetLocation: locationId,
      locationName: line.locationName || line.targetLocationName || '',
      targetLocationName: line.targetLocationName || line.locationName || '',
      lineTotalEx: 0
    };
    targetLines.push(target);
  }

  target.orderedQty += orderedQty;
  target.receivedQty += receivedQty;
  target.qty = target.receivedQty;
  target.varianceQty = target.receivedQty - target.orderedQty;
  target.lineTotalEx += lineTotalEx;

  const baseQty = target.receivedQty * packSize;
  target.unitCost = baseQty > 0 ? target.lineTotalEx / baseQty : Number(line.unitCost || line.costEx || 0) || 0;
  target.costEx = target.unitCost;
}

function latestDate(left = '', right = '') {
  return String(right || '').localeCompare(String(left || '')) > 0 ? String(right || '') : String(left || '');
}

function latestDateTime(left = '', right = '') {
  return String(right || '').localeCompare(String(left || '')) > 0 ? String(right || '') : String(left || '');
}

function normalizeCloudflareLocation(row = {}) {
  const id = String(row.id || '').trim();
  return {
    ...row,
    id,
    name: String(row.display_name || row.displayName || row.name || row.external_name || id).trim(),
    siteId: DEFAULT_SITE_ID,
    siteName: 'Main Site',
    type: String(row.kind || row.type || 'selling').trim(),
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault: Number(row.is_default || row.isDefault || 0) === 1 || id === 'main'
  };
}

function sortProcessedGrvs(items = []) {
  return [...items].sort((left, right) => String(right.date || right.timestamp || '').localeCompare(String(left.date || left.timestamp || '')));
}

function sortByName(items = []) {
  return [...items].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function sortCreditNotes(items = []) {
  return [...items].sort((left, right) => String(right.timestamp || right.date || '').localeCompare(String(left.timestamp || left.date || '')));
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}
