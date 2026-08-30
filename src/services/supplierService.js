import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';

const SUPPLIER_QUERY_LIMIT = 500;

export function subscribeSuppliers(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for suppliers.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchSuppliers(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'suppliers');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchSuppliers(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to fetch suppliers.');

  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'suppliers', {
    query: { limit: SUPPLIER_QUERY_LIMIT }
  });
  const items = sortSuppliers((response.suppliers || response.items || []).map((supplier) => (
    normalizeSupplier(supplier.id, supplier, 'Live suppliers', workspaceKey)
  )));

  return {
    status: 'ready',
    source: 'Live suppliers',
    items,
    updatedAt: new Date().toISOString()
  };
}

export async function upsertSupplier(workspaceId, supplier = {}) {
  const workspaceKey = String(workspaceId || supplier.workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save a supplier.');

  const payload = normalizeSupplierPayload(supplier, workspaceKey);
  if (!payload.name) throw new Error('Supplier name is required.');

  const method = payload.id ? 'PATCH' : 'POST';
  const resource = payload.id ? `suppliers/${encodeURIComponent(payload.id)}` : 'suppliers';
  const result = await callCloudflareWorkspaceRoute(workspaceKey, resource, {
    method,
    payload
  });

  return { id: result.id || payload.id };
}

export async function deleteSupplier(supplierId, options = {}) {
  const id = String(supplierId || '').trim();
  const workspaceKey = String(options.workspaceId || '').trim();
  if (!id) throw new Error('Supplier id is required.');
  if (!workspaceKey) throw new Error('Workspace id is required to delete a supplier.');

  await callCloudflareWorkspaceRoute(workspaceKey, `suppliers/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export async function deleteMultipleSuppliers(items = [], options = {}) {
  const workspaceKey = String(options.workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to delete suppliers.');

  const ids = items
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!ids.length) return;

  await callCloudflareWorkspaceRoute(workspaceKey, 'suppliers/bulk-delete', {
    method: 'POST',
    payload: { ids }
  });
}

export async function syncSupplierMetadata(workspaceId, supplierId, metadata = {}) {
  return upsertSupplier(workspaceId, {
    ...metadata,
    id: supplierId
  });
}

export async function importSuppliers(workspaceId, rows = []) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to import suppliers.');

  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => !isImportTemplateExampleRow(row))
    .map((row) => ({
      ...row,
      ...normalizeSupplierPayload(row, workspaceKey),
      rawJson: JSON.stringify(row || {})
    }))
    .filter((row) => row.name);
  return callCloudflareWorkspaceRoute(workspaceKey, 'suppliers/import', {
    method: 'POST',
    payload: { rows: normalizedRows }
  });
}

export function normalizeSupplier(id, supplier = {}, source = 'Live suppliers', workspaceKey = '') {
  const rawJson = parseJsonObject(supplier.raw_json || supplier.rawJson);
  const value = {
    ...rawJson,
    ...supplier
  };

  return {
    id: String(value.id || id || createId('supplier')),
    source,
    firestoreDocId: '',
    realtimeKey: '',
    workspaceId: value.workspaceId || value.workspace_id || workspaceKey,
    name: text(readField(value, ['name', 'supplierName', 'SupplierName', 'Supplier_Name', 'Supplier Name', 'Supplier'])),
    contactPerson: text(readField(value, ['contactPerson', 'contact', 'ContactPerson', 'Contact Person', 'Contact_Person'])),
    email: text(readField(value, ['email', 'Email', 'E-mail', 'Email_Address', 'Email Address'])),
    phone: text(readField(value, ['phone', 'Phone', 'telephone', 'Telephone', 'Phone_Number', 'Phone Number'])),
    category: text(readField(value, ['category', 'Category'], 'General')) || 'General',
    leadTime: number(readField(value, ['leadTime', 'LeadTime', 'Lead Time', 'Lead_Time', 'Lead_Time_Days', 'Lead Time Days'], 0)),
    paymentTerms: text(readField(value, ['paymentTerms', 'PaymentTerms', 'Payment Terms', 'Payment_Terms'], 'COD')) || 'COD',
    accountNumber: text(readField(value, ['accountNumber', 'AccountNumber', 'Account Number', 'Account_Number'])),
    address: text(readField(value, ['address', 'Address'])),
    addressLine1: text(readField(value, ['addressLine1', 'Address_Line_1', 'Address Line 1'])),
    addressLine2: text(readField(value, ['addressLine2', 'Address_Line_2', 'Address Line 2'])),
    city: text(readField(value, ['city', 'City', 'Town'])),
    province: text(readField(value, ['province', 'Province', 'State'])),
    postalCode: text(readField(value, ['postalCode', 'Postal_Code', 'Postal Code', 'Postcode', 'Zip'])),
    country: text(readField(value, ['country', 'Country'])),
    notes: text(readField(value, ['notes', 'Notes', 'Note', 'Comments'])),
    updatedAt: value.updatedAt || value.updated_at || value.modifiedAt || value.createdAt || ''
  };
}

function normalizeSupplierPayload(supplier = {}, workspaceKey) {
  const name = text(readField(supplier, ['name', 'supplierName', 'SupplierName', 'Supplier_Name', 'Supplier Name', 'Supplier']));
  const idValue = readField(supplier, ['id', 'ID', 'Supplier_ID', 'SupplierID', 'Supplier Id', 'Supplier ID', 'supplierId']);
  const id = idValue ? sanitizeId(idValue) : '';

  return sanitizePayload({
    id,
    workspaceId: workspaceKey,
    name,
    contactPerson: text(readField(supplier, ['contactPerson', 'contact', 'ContactPerson', 'Contact Person', 'Contact_Person'])),
    email: text(readField(supplier, ['email', 'Email', 'E-mail', 'Email_Address', 'Email Address'])),
    phone: text(readField(supplier, ['phone', 'Phone', 'telephone', 'Telephone', 'Phone_Number', 'Phone Number'])),
    category: text(readField(supplier, ['category', 'Category'], 'General')) || 'General',
    leadTime: number(readField(supplier, ['leadTime', 'LeadTime', 'Lead Time', 'Lead_Time', 'Lead_Time_Days', 'Lead Time Days'], 0)),
    paymentTerms: text(readField(supplier, ['paymentTerms', 'PaymentTerms', 'Payment Terms', 'Payment_Terms'], 'COD')) || 'COD',
    accountNumber: text(readField(supplier, ['accountNumber', 'AccountNumber', 'Account Number', 'Account_Number'])),
    address: text(readField(supplier, ['address', 'Address'])),
    addressLine1: text(readField(supplier, ['addressLine1', 'Address_Line_1', 'Address Line 1'])),
    addressLine2: text(readField(supplier, ['addressLine2', 'Address_Line_2', 'Address Line 2'])),
    city: text(readField(supplier, ['city', 'City', 'Town'])),
    province: text(readField(supplier, ['province', 'Province', 'State'])),
    postalCode: text(readField(supplier, ['postalCode', 'Postal_Code', 'Postal Code', 'Postcode', 'Zip'])),
    country: text(readField(supplier, ['country', 'Country'])),
    notes: text(readField(supplier, ['notes', 'Notes', 'Note', 'Comments']))
  });
}

function sortSuppliers(items) {
  return [...items].sort((a, b) => {
    const categoryCompare = String(a.category || '').localeCompare(String(b.category || ''));
    if (categoryCompare) return categoryCompare;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function sanitizePayload(payload = {}) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== ''));
}

function readField(source = {}, aliases = [], fallback = '') {
  if (!source || typeof source !== 'object') return fallback;
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) return source[alias];
  }

  const keyMap = new Map(Object.keys(source).map((key) => [normalizeFieldKey(key), key]));
  for (const alias of aliases) {
    const matchedKey = keyMap.get(normalizeFieldKey(alias));
    if (matchedKey) return source[matchedKey];
  }

  return fallback;
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeFieldKey(value = '') {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isImportTemplateExampleRow(row = {}) {
  return Object.values(row || {}).some((value) => {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');
    return normalized === 'example only' || normalized.startsWith('example only ') || normalized.includes(' example only ');
  });
}

function sanitizeId(value = '') {
  const safe = String(value || '')
    .trim()
    .replace(/[.#$/[\]]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return safe || createId('supplier');
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}

function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  return Number(String(value ?? '').trim().replace(',', '.')) || 0;
}
