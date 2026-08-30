import { text, toArray } from '../engine/grouping.js';

export function buildRowWarnings(rows = [], code = '', level = 'warning', message = '', predicate = () => false) {
  return toArray(rows)
    .filter((row) => {
      try {
        return Boolean(predicate(row));
      } catch {
        return false;
      }
    })
    .map((row, index) => createRowWarning(row, code, level, message, index));
}

export function createRowWarning(row = {}, code = '', level = 'warning', message = '', index = 0) {
  const label = resolveRowLabel(row, index);
  const cleanMessage = cleanIssueMessage(message, code);
  return {
    code,
    level,
    message: label ? `${label} - ${cleanMessage}` : cleanMessage,
    rowId: text(row.id || row.rowId || row.lineId || row.auditId || row.sourceRowId || row.key),
    itemId: text(row.itemId || row.stockItemId || row.inventoryItemId || row.productId || row.menuItemId),
    itemName: text(row.itemName || row.stockItemName || row.inventoryItemName || row.inventoryIngredient || row.productName || row.menuItemName || row.menuItem || row.name),
    menuItemId: text(row.menuItemId || row.productId),
    menuItemName: text(row.menuItemName || row.productName),
    productId: text(row.productId || row.menuItemId),
    productName: text(row.productName || row.menuItemName),
    entityId: text(row.entityId || row.sourceId || row.auditId),
    entityName: text(row.entityName || row.sourceName || row.transferNumber || row.receiptNumber || row.sourceId),
    sourceId: text(row.sourceId || row.saleId || row.transferId || row.stockTakeId || row.sessionId),
    locationId: text(row.locationId || row.fromLocationId || row.toLocationId),
    locationName: text(row.locationName || row.fromLocationName || row.toLocationName),
    isItemSpecific: true
  };
}

export function flattenWarnings(warnings = []) {
  return toArray(warnings).flatMap((warning) => Array.isArray(warning) ? flattenWarnings(warning) : [warning]).filter(Boolean);
}

function resolveRowLabel(row = {}, index = 0) {
  return text(
    row.itemName ||
    row.menuItemName ||
    row.menuItem ||
    row.productName ||
    row.stockItemName ||
    row.inventoryItemName ||
    row.inventoryIngredient ||
    row.entityName ||
    row.name ||
    row.transferNumber ||
    row.receiptNumber ||
    row.sourceId ||
    row.id ||
    (Number.isFinite(index) ? `Line ${index + 1}` : '')
  );
}

function cleanIssueMessage(message = '', code = '') {
  const codeText = text(code).replace(/[-_]+/g, ' ');
  let clean = text(message || codeText || 'Review this line.');
  clean = clean
    .replace(/^\d+\s+/, '')
    .replace(/\b(?:ledger|report|adjustment|stock take|transfer|wastage|audit|sale|sales|usage|line detail|committed)\s+row\(s\)\s+/i, '')
    .replace(/\b(?:stock take|transfer|wastage|audit|usage)\s+line\(s\)\s+/i, '')
    .replace(/^row\(s\)\s+/i, '')
    .replace(/^line\(s\)\s+/i, '')
    .replace(/^rows?\s+/i, '')
    .replace(/^lines?\s+/i, '')
    .replace(/\bitem names\b/ig, 'item name')
    .replace(/\blocation names\b/ig, 'location name')
    .trim();
  clean = clean || 'Review this line.';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}
