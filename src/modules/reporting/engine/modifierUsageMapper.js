import { calculateStockValue, safeNumber } from './calculations.js';
import { text, toArray } from './grouping.js';
import { explodeRecipeToIngredients } from './recipeExplosion.js';

export const MODIFIER_USAGE_SOURCE_TYPE = 'Modifier Usage';

export function mapModifierUsageRows({ modifierSelections = [], stockMappings = [], recipeData = {}, saleContext = {} } = {}) {
  const warnings = [];
  const mappingLookup = buildModifierStockMappingLookup(stockMappings);
  const rows = [];

  toArray(modifierSelections).forEach((selection, index) => {
    const modifierType = normalizeModifierType(selection.type || selection.modifierType || selection.modifier_type || selection.kind);
    const modifierId = text(selection.modifierId || selection.modifier_id || selection.id);
    const modifierName = text(selection.modifierName || selection.modifier_name || selection.name || `Modifier ${index + 1}`);
    const qtySold = safeNumber(selection.quantity ?? selection.qty ?? selection.count ?? 1, 1);
    const mapping = mappingLookup.get(modifierId) || mappingLookup.get(normalizeName(modifierName));

    if (modifierType === 'note' && !mapping) {
      warnings.push({
        code: 'missing-modifier-stock-mapping',
        level: 'info',
        message: `Note modifier ${modifierName} has no stock deduction mapping and was not deducted.`,
        details: { modifierId, modifierName }
      });
      return;
    }

    if (mapping?.recipeOwnerId || selection.productId || selection.menuItemId) {
      const recipeOwnerId = text(mapping?.recipeOwnerId || selection.productId || selection.menuItemId || modifierId);
      const exploded = explodeRecipeToIngredients({
        menuItemId: recipeOwnerId,
        quantitySold: qtySold,
        recipeData
      });
      warnings.push(...exploded.warnings.map((warning) => ({ ...warning, sourceType: MODIFIER_USAGE_SOURCE_TYPE })));
      exploded.rows.forEach((row) => rows.push(toModifierUsageRow(row, selection, saleContext, mapping)));
      return;
    }

    if (mapping?.inventoryItemId || selection.inventoryItemId || selection.stockItemId) {
      const inventoryItemId = text(mapping?.inventoryItemId || selection.inventoryItemId || selection.stockItemId);
      const unitCostExVat = safeNumber(mapping?.unitCostExVat ?? selection.unitCostExVat ?? selection.unitCost);
      const qtyUsed = qtySold * safeNumber(mapping?.qtyPerSelection ?? mapping?.quantity ?? selection.qtyPerSelection ?? 1, 1);
      rows.push({
        id: text(selection.id) || `modifier-usage:${modifierId || normalizeName(modifierName)}:${index}`,
        workspaceId: text(saleContext.workspaceId || selection.workspaceId),
        locationId: text(saleContext.locationId || selection.locationId),
        locationName: text(saleContext.locationName || selection.locationName),
        saleDate: text(saleContext.saleDate || selection.saleDate),
        saleTime: text(saleContext.saleTime || selection.saleTime),
        receiptNumber: text(saleContext.receiptNumber || selection.receiptNumber),
        saleId: text(saleContext.saleId || selection.saleId),
        saleLineId: text(saleContext.saleLineId || selection.saleLineId || selection.parentLineId),
        menuItemId: text(saleContext.menuItemId || selection.parentMenuItemId || selection.menuItemId),
        menuItemName: text(saleContext.menuItemName || selection.parentMenuItemName || selection.menuItemName),
        modifierGroupId: text(selection.modifierGroupId || selection.modifier_group_id || mapping?.modifierGroupId),
        modifierGroupName: text(selection.modifierGroupName || selection.modifier_group_name || mapping?.modifierGroupName),
        modifierId,
        modifierName,
        inventoryItemId,
        inventoryItemName: text(mapping?.inventoryItemName || selection.inventoryItemName || selection.stockItemName),
        inventoryCategoryId: text(mapping?.inventoryCategoryId || selection.inventoryCategoryId),
        inventoryCategoryName: text(mapping?.inventoryCategoryName || selection.inventoryCategoryName || selection.category) || 'General',
        sourceType: MODIFIER_USAGE_SOURCE_TYPE,
        sourceId: text(selection.sourceId || selection.id || modifierId),
        qtyUsed,
        baseUom: text(mapping?.baseUom || selection.baseUom || selection.uom || 'ea'),
        unitCostExVat,
        stockValueUsed: calculateStockValue(qtyUsed, unitCostExVat),
        grossSaleAmount: safeNumber(selection.grossSaleAmount ?? saleContext.grossSaleAmount),
        vatAmount: safeNumber(selection.vatAmount ?? saleContext.vatAmount),
        netSaleAmount: safeNumber(selection.netSaleAmount ?? saleContext.netSaleAmount),
        createdBy: text(selection.createdBy || saleContext.createdBy),
        raw: { selection, mapping }
      });
      return;
    }

    if (modifierType === 'product') {
      warnings.push({
        code: 'missing-modifier-stock-mapping',
        level: 'warning',
        message: `Product modifier ${modifierName} could not be mapped to recipe or stock usage.`,
        details: { modifierId, modifierName }
      });
    }
  });

  return { rows, warnings };
}

export function isStockDeductingModifier(selection = {}, stockMappings = []) {
  const modifierType = normalizeModifierType(selection.type || selection.modifierType || selection.modifier_type || selection.kind);
  if (modifierType === 'product') return true;
  if (modifierType !== 'note') return false;
  const modifierId = text(selection.modifierId || selection.modifier_id || selection.id);
  const modifierName = text(selection.modifierName || selection.modifier_name || selection.name);
  const mappingLookup = buildModifierStockMappingLookup(stockMappings);
  return Boolean(mappingLookup.get(modifierId) || mappingLookup.get(normalizeName(modifierName)));
}

export function buildModifierStockMappingLookup(stockMappings = []) {
  const lookup = new Map();
  toArray(stockMappings).forEach((mapping) => {
    const id = text(mapping.modifierId || mapping.modifier_id || mapping.id);
    const name = normalizeName(mapping.modifierName || mapping.modifier_name || mapping.name);
    if (id) lookup.set(id, mapping);
    if (name) lookup.set(name, mapping);
  });
  return lookup;
}

function toModifierUsageRow(row = {}, selection = {}, saleContext = {}, mapping = {}) {
  return {
    ...row,
    id: `${text(selection.id || selection.modifierId || selection.name)}:${row.id}`,
    workspaceId: text(saleContext.workspaceId || selection.workspaceId || row.workspaceId),
    locationId: text(saleContext.locationId || selection.locationId || row.locationId),
    locationName: text(saleContext.locationName || selection.locationName || row.locationName),
    saleDate: text(saleContext.saleDate || selection.saleDate || row.saleDate),
    saleTime: text(saleContext.saleTime || selection.saleTime || row.saleTime),
    receiptNumber: text(saleContext.receiptNumber || selection.receiptNumber || row.receiptNumber),
    saleId: text(saleContext.saleId || selection.saleId || row.saleId),
    saleLineId: text(saleContext.saleLineId || selection.saleLineId || selection.parentLineId || row.saleLineId),
    modifierGroupId: text(selection.modifierGroupId || selection.modifier_group_id || mapping?.modifierGroupId),
    modifierGroupName: text(selection.modifierGroupName || selection.modifier_group_name || mapping?.modifierGroupName),
    modifierId: text(selection.modifierId || selection.modifier_id || selection.id),
    modifierName: text(selection.modifierName || selection.modifier_name || selection.name),
    sourceType: MODIFIER_USAGE_SOURCE_TYPE,
    sourceId: text(selection.sourceId || selection.id || selection.modifierId),
    stockValueUsed: calculateStockValue(row.qtyUsed, row.unitCostExVat),
    grossSaleAmount: safeNumber(selection.grossSaleAmount ?? saleContext.grossSaleAmount),
    vatAmount: safeNumber(selection.vatAmount ?? saleContext.vatAmount),
    netSaleAmount: safeNumber(selection.netSaleAmount ?? saleContext.netSaleAmount),
    createdBy: text(selection.createdBy || saleContext.createdBy),
    raw: { selection, mapping, ingredient: row.raw || row }
  };
}

function normalizeModifierType(value = '') {
  const normalized = text(value || 'product').toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized.includes('note')) return 'note';
  if (normalized.includes('product')) return 'product';
  return normalized || 'product';
}

function normalizeName(value = '') {
  return text(value).toLowerCase().replace(/\s+/g, ' ').trim();
}
