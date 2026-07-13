import { safeNumber } from '../../engine/calculations.js';
import { normalizeKey, text, toArray } from '../../engine/grouping.js';
import { detailedActivityReport } from '../operations/detailedActivityReport.js';
import { stockTakeAuditReport } from '../operations/stockTakeAuditReport.js';
import { stockOnHandReport } from '../inventory/stockOnHandReport.js';
import { grvLogReport } from '../purchasing/grvLogReport.js';
import { purchaseOrdersReport } from '../purchasing/purchaseOrdersReport.js';
import { creditNotesReport } from '../purchasing/creditNotesReport.js';
import { saleStockMovementReport } from '../sales/saleStockMovementReport.js';

export async function loadAdvancedSources({ workspaceId = '', filters = {}, services = {}, dataSet = {}, sources = [] } = {}) {
  const requested = new Set(sources);
  const result = {};
  if (requested.has('stock')) result.stock = await stockOnHandReport.getRows({ workspaceId, filters, services, dataSet, view: 'by_item' });
  if (requested.has('ledger')) result.ledger = await detailedActivityReport.getRows({ workspaceId, filters, services, dataSet, view: 'ledger' });
  if (requested.has('stockTakes')) result.stockTakes = await stockTakeAuditReport.getRows({ workspaceId, filters, services, dataSet, view: 'by_item' });
  if (requested.has('grv')) result.grv = await grvLogReport.getRows({ workspaceId, filters, services, dataSet, view: 'line_detail' });
  if (requested.has('purchaseOrders')) result.purchaseOrders = await purchaseOrdersReport.getRows({ workspaceId, filters, services, dataSet, view: 'line_detail' });
  if (requested.has('creditNotes')) result.creditNotes = await creditNotesReport.getRows({ workspaceId, filters, services, dataSet, view: 'line_detail' });
  if (requested.has('saleUsage')) result.saleUsage = await saleStockMovementReport.getRows({ workspaceId, filters, services, dataSet, view: 'transaction_detail' });
  return result;
}

export function itemLocationKey(row = {}) {
  const item = text(row.itemId || row.stockItemId || row.inventoryItemId || row.inventoryItemName || row.inventoryIngredient || row.itemName).toLowerCase();
  const location = text(row.locationId || row.locationName).toLowerCase();
  return `${item || 'unknown-item'}::${location || 'unknown-location'}`;
}

export function itemSupplierKey(row = {}) {
  const item = text(row.itemId || row.stockItemId || row.itemName).toLowerCase();
  const supplier = text(row.supplierId || row.supplierName).toLowerCase();
  return `${item || 'unknown-item'}::${supplier || 'unknown-supplier'}`;
}

export function normalizeDate(row = {}) {
  return text(row.date || row.grvDate || row.stockTakeDate || row.saleDate || row.purchaseDate || row.occurredAt || row.createdAt).slice(0, 10);
}

export function normalizeUsageQty(row = {}) {
  return Math.abs(safeNumber(row.qtyUsed ?? row.qtyOut ?? (safeNumber(row.netQty) < 0 ? row.netQty : 0)));
}

export function isUsageLedgerRow(row = {}) {
  const type = normalizeKey(`${row.movementType || ''} ${row.source || ''} ${row.sourceType || ''}`);
  if (safeNumber(row.qtyOut) <= 0 && safeNumber(row.netQty) >= 0) return false;
  return /sale usage|modifier usage|manufacturing out|manufacturing ingredient|manufacturing wastage|wastage adjustment|wastage|transfer out/.test(type)
    && !/stock take variance|stock take correction/.test(type);
}

export function isPurchaseLedgerRow(row = {}) {
  return /grv|goods received|purchase receipt|purchase/.test(normalizeKey(`${row.movementType || ''} ${row.source || ''}`)) && safeNumber(row.qtyIn) > 0;
}

export function isTransferInRow(row = {}) {
  return /transfer in/.test(normalizeKey(`${row.movementType || ''} ${row.source || ''}`)) && safeNumber(row.qtyIn) > 0;
}

export function isTransferOutRow(row = {}) {
  return /transfer out/.test(normalizeKey(`${row.movementType || ''} ${row.source || ''}`)) && safeNumber(row.qtyOut) > 0;
}

export function isManufacturingInRow(row = {}) {
  return /manufacturing in|production in|manufactured in/.test(normalizeKey(`${row.movementType || ''} ${row.source || ''}`)) && safeNumber(row.qtyIn) > 0;
}

export function isManufacturingOutRow(row = {}) {
  return /manufacturing out|ingredient consumption|production consumption/.test(normalizeKey(`${row.movementType || ''} ${row.source || ''}`)) && safeNumber(row.qtyOut) > 0;
}

export function isWastageRow(row = {}) {
  const source = normalizeKey(`${row.movementType || ''} ${row.source || ''} ${row.sourceType || ''}`);
  if (/stock take|stocktake|inventory variance/.test(source)) return false;
  return /wastage|waste/.test(source) && (safeNumber(row.qtyOut) > 0 || Math.abs(safeNumber(row.wastageQty)) > 0);
}

export function sourceWarnings(rows = []) {
  const warnings = [];
  toArray(rows).forEach((row) => toArray(row.__apiWarnings).forEach((warning) => warnings.push(warning)));
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${text(warning?.code)}::${text(warning?.message || warning)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function applyAdvancedFilters(rows = [], filters = {}, { riskField = 'riskStatus', itemField = 'itemId' } = {}) {
  const search = normalizeKey(filters.search);
  const locationId = text(filters.locationId);
  const category = normalizeKey(filters.category || filters.inventoryCategory);
  const itemId = text(filters.inventoryItemId || filters.itemId);
  const supplierId = text(filters.supplierId || filters.supplier);
  const riskStatus = normalizeKey(filters.riskStatus);
  return toArray(rows).filter((row) => {
    if (locationId && ![row.locationId, row.locationName].map(text).includes(locationId)) return false;
    if (category && normalizeKey(row.category || row.inventoryCategory || row.categoryName) !== category) return false;
    if (itemId && text(row[itemField] || row.itemId || row.inventoryItemId || row.itemName) !== itemId) return false;
    if (supplierId && ![row.supplierId, row.supplierName].map(text).includes(supplierId)) return false;
    if (riskStatus && normalizeKey(row[riskField] || row.status) !== riskStatus) return false;
    if (search) {
      const haystack = normalizeKey([
        row.itemName, row.category, row.locationName, row.supplierName, row.status,
        row.riskStatus, row.suggestedAction, row.documentNumber, row.sourceType
      ].filter(Boolean).join(' '));
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

export function attachModelMeta(rows = [], model = {}, meta = {}) {
  return toArray(rows).map((row) => ({ ...row, __advancedModelId: model.id, __apiMeta: meta }));
}

export function countWarning(rows = [], code, level, message, predicate) {
  const count = toArray(rows).filter(predicate).length;
  return count ? { code, level, message: `${count} ${message}` } : null;
}

export function latestByDate(rows = [], getKey = itemLocationKey, getDate = normalizeDate) {
  const map = new Map();
  toArray(rows).forEach((row) => {
    const key = getKey(row);
    const date = getDate(row);
    const existing = map.get(key);
    if (!existing || date >= getDate(existing)) map.set(key, row);
  });
  return map;
}

export function maxAbs(values = []) {
  return Math.max(...toArray(values).map((value) => Math.abs(safeNumber(value))), 0);
}

export function safeDivide(numerator, denominator) {
  const bottom = safeNumber(denominator);
  return bottom ? safeNumber(numerator) / bottom : 0;
}
