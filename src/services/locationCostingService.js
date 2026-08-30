import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { downloadFileBlob } from './dataService.js';
import { buildExportFilename } from './exportService.js';
import { parseBarcodeValues } from '../utils/barcodes.js';

export const IMPORT_TYPES = Object.freeze({
  STOCK_ITEM_IMPORT: 'STOCK_ITEM_IMPORT',
  LOCATION_COSTING_IMPORT: 'LOCATION_COSTING_IMPORT',
  UNKNOWN: 'UNKNOWN'
});

const LOCATION_COSTING_SHEET = 'Location Costing Import';
const STOCK_IMPORT_SHEET = 'Stock_Import';
const META_SHEET = '_KCP_Metadata';
const HIDDEN_ITEM_ID_COLUMN = '_KCP_Item_ID';

export async function exportLocationCostingTemplate({ stockItems = [], locations = [], locationId = '', workspaceName = 'KCP' } = {}) {
  const selectedLocation = findLocationById(locations, locationId);
  if (!selectedLocation) throw new Error('Please select a location before exporting or importing location costs.');

  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: 'KCP Location Costing Import',
    Subject: 'Location-specific stock item costing',
    Author: 'Kitchen Cost Pro',
    CreatedDate: new Date()
  };

  const rows = (stockItems || [])
    .filter((item) => item && typeof item === 'object' && item.id)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((item) => ({
      'Item Name': item.name || '',
      'SKU / Barcode': getSkuBarcode(item),
      UOM: item.unit || item.uom || 'ea',
      'Current Cost Ex VAT': formatNumber(resolveLocationCost(item, locationId)),
      'New Cost Ex VAT': '',
      [HIDDEN_ITEM_ID_COLUMN]: item.id || ''
    }));

  const columns = ['Item Name', 'SKU / Barcode', 'UOM', 'Current Cost Ex VAT', 'New Cost Ex VAT', HIDDEN_ITEM_ID_COLUMN];
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: columns });
  worksheet['!cols'] = [
    { wch: 34 },
    { wch: 22 },
    { wch: 12 },
    { wch: 18 },
    { wch: 18 },
    { wch: 1, hidden: true }
  ];
  worksheet['!autofilter'] = { ref: `A1:E${Math.max(rows.length + 1, 2)}` };
  worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(workbook, worksheet, LOCATION_COSTING_SHEET);

  const metadataRows = [
    ['key', 'value'],
    ['import_type', 'LOCATION_COSTING'],
    ['template_version', '1'],
    ['location_id', String(locationId || '')],
    ['location_name', getLocationName(selectedLocation)],
    ['workspace_name', workspaceName || 'KCP'],
    ['generated_at', new Date().toISOString()]
  ];
  const metaSheet = XLSX.utils.aoa_to_sheet(metadataRows);
  metaSheet['!cols'] = [{ wch: 22 }, { wch: 44 }];
  XLSX.utils.book_append_sheet(workbook, metaSheet, META_SHEET);
  workbook.Workbook = workbook.Workbook || {};
  workbook.Workbook.Sheets = workbook.Workbook.Sheets || [];
  workbook.Workbook.Sheets[1] = { Hidden: 1 };

  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = `${buildExportFilename({ workspaceName, reportType: 'Location Costing Template Export', suffix: getLocationName(selectedLocation) })}.xlsx`;
  downloadFileBlob(blob, filename);
  return { rowCount: rows.length, filename, locationName: getLocationName(selectedLocation) };
}

export async function detectImportFileType(file) {
  if (!file) return IMPORT_TYPES.UNKNOWN;
  const workbook = await readWorkbook(file).catch(() => null);
  if (!workbook) return IMPORT_TYPES.UNKNOWN;

  const metadata = getWorkbookMetadata(workbook);
  if (String(metadata.import_type || '').trim().toUpperCase() === 'LOCATION_COSTING') return IMPORT_TYPES.LOCATION_COSTING_IMPORT;
  if (workbook.SheetNames.some((name) => normalizeText(name) === normalizeText(LOCATION_COSTING_SHEET))) return IMPORT_TYPES.LOCATION_COSTING_IMPORT;
  if (workbook.SheetNames.some((name) => normalizeText(name) === normalizeText(STOCK_IMPORT_SHEET))) return IMPORT_TYPES.STOCK_ITEM_IMPORT;

  const firstRows = getFirstSheetRows(workbook);
  const columns = new Set(Object.keys(firstRows[0] || {}).map(normalizeColumnKey));
  if (columns.has(normalizeColumnKey('New Cost Ex VAT')) && columns.has(normalizeColumnKey('Current Cost Ex VAT'))) return IMPORT_TYPES.LOCATION_COSTING_IMPORT;
  if (columns.has(normalizeColumnKey('Item_Name')) && columns.has(normalizeColumnKey('Base_UOM')) && columns.has(normalizeColumnKey('Cost_Ex_VAT'))) return IMPORT_TYPES.STOCK_ITEM_IMPORT;
  return IMPORT_TYPES.UNKNOWN;
}

export async function parseLocationCostingImport(file, { selectedLocationId = '', requireFileLocationMetadata = false, stockItems = [], locations = [] } = {}) {
  const workbook = await readWorkbook(file);
  const metadata = getWorkbookMetadata(workbook);
  const fileType = await detectImportFileType(file);
  if (fileType === IMPORT_TYPES.STOCK_ITEM_IMPORT) {
    throw new Error('This file looks like a Stock Item Import. Please upload it in the Stock Item Import section.');
  }
  if (fileType !== IMPORT_TYPES.LOCATION_COSTING_IMPORT) {
    throw new Error('We could not identify this import file. Please download a fresh template from the correct section and try again.');
  }

  const metadataLocationId = String(metadata.location_id || metadata.locationId || '').trim();
  if (requireFileLocationMetadata && !metadataLocationId) {
    throw new Error('This costing XLSX is missing location metadata. Please download a fresh Location Costing XLSX template and upload that file.');
  }
  if (metadataLocationId && selectedLocationId && String(metadataLocationId) !== String(selectedLocationId)) {
    throw new Error('This file was generated for a different location. Please select the matching location or download a new cost sheet.');
  }
  const resolvedLocationId = String(metadataLocationId || selectedLocationId || '').trim();
  if (!resolvedLocationId) throw new Error('This costing XLSX is missing location metadata. Please download a fresh Location Costing XLSX template and upload that file.');

  const selectedLocation = findLocationById(locations, resolvedLocationId);
  if (!selectedLocation) throw new Error('The location saved in this costing XLSX could not be found. Please download a fresh Location Costing XLSX template.');
  const sheetName = findSheetName(workbook, LOCATION_COSTING_SHEET) || workbook.SheetNames.find((name) => normalizeText(name) !== normalizeText(META_SHEET));
  const rows = sheetName && workbook.Sheets[sheetName]
    ? workbook.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
    : [];
  if (!rows.length) throw new Error('The uploaded file is empty. Please use the exported Location Costing template.');

  const stockLookup = createStockLookup(stockItems);
  const previewRows = [];
  rows.forEach((row, index) => {
    if (isBlankRow(row)) return;
    const rowNumber = index + 2;
    const visibleName = getValue(row, ['Item Name', 'Item_Name', 'Name', 'Item']);
    const skuBarcode = getValue(row, ['SKU / Barcode', 'SKU_Barcode', 'SKU', 'Barcode', 'Barcodes']);
    const hiddenId = getValue(row, [HIDDEN_ITEM_ID_COLUMN, 'KCP_Item_ID', 'Stock_Item_ID', 'Stock Item ID']);
    const currentCost = parseCurrency(getValue(row, ['Current Cost Ex VAT', 'Current_Cost_Ex_VAT', 'Current Cost']));
    const rawNewCost = getValue(row, ['New Cost Ex VAT', 'New_Cost_Ex_VAT', 'New Cost']);
    const matchedItem = findStockItemMatch(stockLookup, { hiddenId, skuBarcode, visibleName });
    const baseRow = {
      rowNumber,
      itemName: visibleName || matchedItem?.name || '',
      skuBarcode: skuBarcode || getSkuBarcode(matchedItem || {}),
      stockItemId: matchedItem?.id || '',
      currentCostExVat: Number.isFinite(currentCost) ? currentCost : resolveLocationCost(matchedItem || {}, resolvedLocationId),
      newCostExVat: rawNewCost,
      status: 'ignored',
      error: ''
    };

    if (String(rawNewCost ?? '').trim() === '') {
      previewRows.push({ ...baseRow, status: 'ignored', error: 'Blank cost ignored.' });
      return;
    }
    const newCost = parseCurrency(rawNewCost);
    if (!Number.isFinite(newCost) || newCost < 0) {
      previewRows.push({ ...baseRow, status: 'error', error: 'New Cost Ex VAT must be zero or greater.' });
      return;
    }
    if (!matchedItem) {
      previewRows.push({ ...baseRow, status: 'error', error: 'No matching stock item found.' });
      return;
    }
    const oldCost = resolveLocationCost(matchedItem, resolvedLocationId);
    if (roundCost(oldCost) === roundCost(newCost)) {
      previewRows.push({ ...baseRow, stockItemId: matchedItem.id, currentCostExVat: oldCost, newCostExVat: newCost, status: 'unchanged', error: '' });
      return;
    }
    previewRows.push({ ...baseRow, stockItemId: matchedItem.id, itemName: matchedItem.name || visibleName, currentCostExVat: oldCost, newCostExVat: newCost, status: 'update', error: '' });
  });

  const summary = summarizePreview(previewRows, selectedLocation);
  if (!previewRows.length) throw new Error('The uploaded file is empty. Please use the exported Location Costing template.');
  if (!summary.matched && !summary.toUpdate && !summary.unchanged) throw new Error('No matching stock items were found in this file.');
  return {
    id: createBatchId(),
    locationId: String(resolvedLocationId),
    locationName: getLocationName(selectedLocation),
    rows: previewRows,
    summary,
    metadata
  };
}

export async function applyLocationCostingImport(workspaceId, preview = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to update location costs.');
  const locationId = String(preview.locationId || '').trim();
  if (!locationId) throw new Error('Please select a location before exporting or importing location costs.');
  const updates = (preview.rows || [])
    .filter((row) => row.status === 'update')
    .map((row) => ({
      stockItemId: row.stockItemId,
      itemName: row.itemName,
      oldCostExVat: Number(row.currentCostExVat || 0),
      newCostExVat: Number(row.newCostExVat || 0)
    }));
  if (!updates.length) return { updatedCount: 0, batchId: preview.id || createBatchId() };

  return callCloudflareWorkspaceRoute(workspaceKey, 'stock-items/location-costs/import', {
    method: 'POST',
    payload: {
      locationId,
      locationName: preview.locationName || '',
      batchId: preview.id || createBatchId(),
      source: 'LOCATION_COSTING_IMPORT',
      updates
    }
  });
}

export function applyLocationCostPreviewToItems(items = [], preview = {}) {
  const updates = new Map((preview.rows || [])
    .filter((row) => row.status === 'update' && row.stockItemId)
    .map((row) => [String(row.stockItemId), Number(row.newCostExVat || 0)]));
  if (!updates.size) return items;
  const locationId = String(preview.locationId || '').trim();
  const now = new Date().toISOString();
  return (items || []).map((item) => {
    if (!updates.has(String(item.id))) return item;
    const cost = updates.get(String(item.id));
    const locationCosts = { ...(item.locationCosts || item.locationPrices || {}) };
    locationCosts[locationId] = { cost, unitCost: cost, price: cost, updatedAt: now };
    return { ...item, locationCosts, locationPrices: locationCosts };
  });
}

function summarizePreview(rows = [], location = {}) {
  return {
    locationName: getLocationName(location),
    totalRows: rows.length,
    matched: rows.filter((row) => row.stockItemId).length,
    notMatched: rows.filter((row) => !row.stockItemId && row.status === 'error').length,
    unchanged: rows.filter((row) => row.status === 'unchanged').length,
    toUpdate: rows.filter((row) => row.status === 'update').length,
    errors: rows.filter((row) => row.status === 'error').length,
    ignored: rows.filter((row) => row.status === 'ignored').length
  };
}

async function readWorkbook(file) {
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  return { ...XLSX.read(buffer, { type: 'array' }), utils: XLSX.utils };
}

function getWorkbookMetadata(workbook) {
  const sheetName = findSheetName(workbook, META_SHEET);
  if (!sheetName || !workbook.Sheets[sheetName]) return {};
  const rows = workbook.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', header: 1 });
  return rows.reduce((map, row) => {
    const key = String(row?.[0] || '').trim();
    if (key) map[key] = row?.[1] ?? '';
    return map;
  }, {});
}

function getFirstSheetRows(workbook) {
  const sheetName = workbook.SheetNames.find((name) => normalizeText(name) !== normalizeText(META_SHEET)) || workbook.SheetNames[0];
  return sheetName && workbook.Sheets[sheetName]
    ? workbook.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
    : [];
}

function findSheetName(workbook, target = '') {
  const normalized = normalizeText(target);
  return (workbook.SheetNames || []).find((name) => normalizeText(name) === normalized) || '';
}

function createStockLookup(stockItems = []) {
  const byId = new Map();
  const bySkuBarcode = new Map();
  const byName = new Map();
  (stockItems || []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item.id) byId.set(String(item.id), item);
    [item.sku, item.SKU, item.stockCode, item.itemCode, item.code, ...parseBarcodeValues(item)]
      .map(normalizeLookup)
      .filter(Boolean)
      .forEach((key) => { if (!bySkuBarcode.has(key)) bySkuBarcode.set(key, item); });
    const nameKey = normalizeLookup(item.name);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, item);
  });
  return { byId, bySkuBarcode, byName };
}

function findStockItemMatch(lookup, { hiddenId = '', skuBarcode = '', visibleName = '' } = {}) {
  const idMatch = lookup.byId.get(String(hiddenId || '').trim());
  if (idMatch) return idMatch;
  const skuCandidates = String(skuBarcode || '').split(/[,;]+/).map(normalizeLookup).filter(Boolean);
  for (const candidate of skuCandidates) {
    const match = lookup.bySkuBarcode.get(candidate);
    if (match) return match;
  }
  return lookup.byName.get(normalizeLookup(visibleName)) || null;
}

function getValue(row = {}, labels = []) {
  const normalized = new Map(Object.keys(row || {}).map((key) => [normalizeColumnKey(key), key]));
  for (const label of labels) {
    const key = normalized.get(normalizeColumnKey(label));
    if (key !== undefined) return row[key];
  }
  return '';
}

function resolveLocationCost(item = {}, locationId = '') {
  if (!item) return 0;
  const costs = item.locationCosts || item.locationPrices || item.locationPricing || item.pricesByLocation || {};
  const entry = costs[String(locationId || '')];
  if (entry && typeof entry === 'object') return Number(entry.cost ?? entry.unitCost ?? entry.price ?? item.cost ?? 0) || 0;
  if (entry !== undefined && entry !== null && entry !== '') return Number(entry) || 0;
  return Number(item.cost ?? item.unitCost ?? 0) || 0;
}

function getSkuBarcode(item = {}) {
  return [item.sku || item.SKU || item.stockCode || item.itemCode || '', parseBarcodeValues(item)[0] || '']
    .filter(Boolean)
    .join(' / ');
}

function findLocationById(locations = [], locationId = '') {
  return (locations || []).find((location) => String(location.id || location.locationId || '') === String(locationId || '')) || null;
}

function getLocationName(location = {}) {
  return String(location.displayName || location.name || location.locationName || location.id || 'Location').trim();
}

function normalizeColumnKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeText(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeLookup(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function parseCurrency(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const raw = String(value ?? '').trim();
  if (!raw) return NaN;
  const normalized = raw.replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatNumber(value) {
  const number = Number(value || 0) || 0;
  return Number(number.toFixed(4));
}

function roundCost(value) {
  return Math.round((Number(value || 0) || 0) * 10000) / 10000;
}

function isBlankRow(row = {}) {
  return !Object.values(row || {}).some((value) => String(value ?? '').trim());
}

function createBatchId() {
  return `loc_cost_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
