import { safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';

export function resolveMovementMetadata(row = {}) {
  const candidates = [
    row.metadata,
    row.raw?.metadata,
    row.raw?.movement?.metadata,
    row.rawSourceRow?.metadata,
    row.reportSourceRow?.raw?.metadata,
    row.reportSourceRow?.rawSourceRow?.metadata,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  const rawCandidates = [
    row.metadata,
    row.metadataJson,
    row.metadata_json,
    row.raw?.movement?.metadata_json,
    row.rawSourceRow?.metadata_json,
    row.reportSourceRow?.raw?.movement?.metadata_json,
  ];
  for (const candidate of rawCandidates) {
    if (!candidate) continue;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
    try {
      const parsed = JSON.parse(String(candidate));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Continue to the next metadata source.
    }
  }
  return {};
}

export function isProductWastageMovement(row = {}) {
  const metadata = resolveMovementMetadata(row);
  const documentType = text(
    row.documentType ||
      row.document_type ||
      row.raw?.movement?.document_type ||
      row.rawSourceRow?.document_type,
  ).toLowerCase();
  return Boolean(
    text(row.productId || row.menuItemId || metadata.productId || metadata.menuItemId || metadata.parentProductId) ||
      text(row.productName || row.menuItemName || metadata.productName || metadata.menuItemName || metadata.parentProductName) ||
      documentType === 'wastage_adjustment',
  );
}

export function resolveProductWastageIdentity(row = {}) {
  const metadata = resolveMovementMetadata(row);
  return {
    productId: text(
      row.productId ||
        row.menuItemId ||
        metadata.productId ||
        metadata.menuItemId ||
        metadata.parentProductId,
    ),
    productName: text(
      row.productName ||
        row.menuItemName ||
        metadata.productName ||
        metadata.menuItemName ||
        metadata.parentProductName,
    ),
  };
}

export function resolveProductWastageQuantity(row = {}) {
  const metadata = resolveMovementMetadata(row);
  return Math.abs(
    safeNumber(
      row.menuItemQty ??
        row.productWastageQty ??
        row.wastageQty ??
        row.wasteQty ??
        metadata.wastageQty ??
        metadata.wasteQty ??
        metadata.wastage_quantity ??
        metadata.productQuantity ??
        metadata.menuItemQuantity,
    ),
  );
}

export function resolveWastageSourceLabel(row = {}, fallback = '') {
  if (isProductWastageMovement(row)) return 'Product Wastage';
  const source = text(fallback || row.source || row.adjustmentType || row.sourceType || row.movementType);
  const normalized = source.toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized.includes('manufacturing wastage')) return 'Manufacturing Wastage';
  if (normalized.includes('recipe wastage')) return 'Recipe Wastage';
  if (normalized.includes('wastage') || normalized.includes('waste') || normalized.includes('manual adjustment')) {
    return 'Stock Item Wastage';
  }
  return source || 'Stock Item Wastage';
}

export function buildMenuItemWastageRows(rows = []) {
  const productRows = toArray(rows).filter(isProductWastageMovement);
  const eventGroups = groupBy(productRows, (row) => {
    const identity = resolveProductWastageIdentity(row);
    return [
      row.sourceId || row.documentId || row.adjustmentId || row.id,
      identity.productId || identity.productName,
      row.locationId || row.locationName,
      row.date || row.movementDate,
    ].map(text).join('::');
  });

  const events = Array.from(eventGroups.entries()).map(([eventKey, groupRows]) => {
    const first = groupRows[0] || {};
    const identity = resolveProductWastageIdentity(first);
    const menuQty = Math.max(...groupRows.map(resolveProductWastageQuantity), 0);
    const ingredientKeys = new Set(
      groupRows
        .map((row) => text(row.itemId || row.stockItemId || row.itemName || row.stockItemName))
        .filter(Boolean),
    );
    return {
      id: `menu-wastage-event:${eventKey}`,
      eventKey,
      sourceId: text(first.sourceId || first.documentId || first.adjustmentId || first.id),
      productId: identity.productId,
      menuItemName: identity.productName || 'Unknown Menu Item',
      locationId: text(first.locationId),
      locationName: text(first.locationName) || 'Unassigned',
      date: text(first.date || first.movementDate).slice(0, 10),
      qtyMenuItemsWasted: menuQty,
      wastageValue: sumBy(groupRows, (row) => Math.abs(safeNumber(row.wastageValue ?? row.valueImpact ?? row.movementValue))),
      ingredientLineCount: ingredientKeys.size,
      reason: text(first.reason || first.notes || first.note) || 'No reason captured',
      createdBy: text(first.createdBy || first.createdByName || first.user),
      __sourceRows: groupRows,
    };
  });

  return Array.from(groupBy(events, (row) => [row.productId || row.menuItemName, row.locationId || row.locationName].map(text).join('::')).entries())
    .map(([key, groupRows]) => {
      const first = groupRows[0] || {};
      const reasons = topText(groupRows, 'reason');
      const users = uniqueText(groupRows.map((row) => row.createdBy));
      return {
        id: `menu-wastage:${key}`,
        productId: first.productId || '',
        menuItemName: first.menuItemName || 'Unknown Menu Item',
        locationId: first.locationId || '',
        locationName: first.locationName || 'Unassigned',
        qtyMenuItemsWasted: sumBy(groupRows, 'qtyMenuItemsWasted'),
        wastageValue: sumBy(groupRows, 'wastageValue'),
        eventCount: groupRows.length,
        ingredientLineCount: sumBy(groupRows, 'ingredientLineCount'),
        lastWastedDate: groupRows.map((row) => row.date).filter(Boolean).sort().at(-1) || '',
        topReason: reasons,
        createdBy: users.length === 1 ? users[0] : (users.length ? `${users.length} users` : ''),
        __eventRows: groupRows,
        __sourceRows: groupRows.flatMap((row) => row.__sourceRows || []),
      };
    });
}

function topText(rows = [], key = '') {
  const counts = new Map();
  toArray(rows).forEach((row) => {
    const value = text(row[key]);
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
}

function uniqueText(values = []) {
  return Array.from(new Set(toArray(values).map(text).filter(Boolean))).sort();
}
