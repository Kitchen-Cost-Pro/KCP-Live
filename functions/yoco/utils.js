const crypto = require('crypto');

function getWorkspaceDataPath(workspaceId) {
  if (workspaceId === 'appData' || workspaceId === 'appData_legacy' || workspaceId === 'ROOT_WORKSPACE') {
    return 'appData';
  }
  return `workspaces/${workspaceId}/data`;
}

function createId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeArray(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => ({ id: String(item.id || id), ...item }));
}

function normalizeObject(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return { ...value };
  return Object.fromEntries(value.map((item, index) => [String(item?.id || index), item]));
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashSignature(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseQuantity(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toArray(value) {
  return normalizeArray(value);
}

function todayFromIso(value) {
  return String(value || new Date().toISOString()).slice(0, 10);
}

function serverTimestampIso() {
  return new Date().toISOString();
}

module.exports = {
  createId,
  getWorkspaceDataPath,
  hashSignature,
  normalizeArray,
  normalizeObject,
  normalizeText,
  parseQuantity,
  serverTimestampIso,
  todayFromIso,
  toArray
};
