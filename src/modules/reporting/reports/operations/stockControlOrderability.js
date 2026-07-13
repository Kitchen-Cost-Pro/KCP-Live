import { text } from '../../engine/grouping.js';

export function isManufacturedStockControlRow(row = {}) {
  const itemType = text(
    row.itemType ||
      row.stockItemType ||
      row.stock_item_type ||
      row.type ||
      row.stockType ||
      row.tag,
  ).toLowerCase().replace(/[\s-]+/g, '_');
  return Boolean(
    row.isManufactured === true ||
      row.is_manufactured === true ||
      itemType === 'manufactured' ||
      itemType === 'manufactured_good' ||
      itemType === 'manufactured_goods' ||
      itemType === 'sub_recipe' ||
      itemType === 'subrecipe'
  );
}

export function isOrderableStockControlRow(row = {}) {
  return !isManufacturedStockControlRow(row);
}
