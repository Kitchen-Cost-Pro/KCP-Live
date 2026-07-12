import {
  downloadAoaCsv,
  downloadAoaPdf,
  downloadAoaXlsx,
  downloadWorkbookXlsx,
  downloadCsv,
  downloadPdf,
  downloadXlsx
} from './dataService.js';

export const exportSchemas = {
  menu: ['ProductName', 'Category', 'Selling_Price', 'Status', 'Barcodes'],
  recipes: ['Product_Name', 'Ingredient_Name', 'Quantity_Needed', 'UOM'],
  stock: [
    'Item_Name',
    'SKU',
    'Item_Type',
    'Category',
    'Base_UOM',
    'Cost_Ex_VAT',
    'VAT_Enabled',
    'Barcode',
    'Yield_Percentage',
    'Batch_Yield',
    'Opening_Stock',
    'Low_Stock_Threshold',
    'Par_Level',
    'Notes',
    'UOM_1_Name',
    'UOM_1_Qty_In_Base',
    'UOM_1_Barcode',
    'UOM_2_Name',
    'UOM_2_Qty_In_Base',
    'UOM_2_Barcode',
    'UOM_3_Name',
    'UOM_3_Qty_In_Base',
    'UOM_3_Barcode'
  ],
  manufacturing: ['Item_Type', 'Name', 'Category', 'Unit', 'Batch_Yield', 'Component_Name', 'Quantity_Needed'],
  suppliers: [
    'Supplier_Name',
    'Contact_Person',
    'Email',
    'Phone',
    'Category',
    'Lead_Time_Days',
    'Payment_Terms',
    'Account_Number',
    'Address_Line_1',
    'Address_Line_2',
    'City',
    'Province',
    'Postal_Code',
    'Country',
    'Notes',
    'Supplier_ID'
  ],
  purchaseOrderLines: ['Item Description', 'Unit of Measure', 'Pack Size', 'Quantity Required', 'Notes'],
  grvLines: ['Date', 'Supplier', 'Invoice #', 'Item Name', 'Qty', 'Unit', 'Pack Size', 'Unit Cost (Ex)', 'Line Total (Ex)', 'Location']
};

export function buildMenuCatalogueRows(items = []) {
  return [...items]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((item) => ({
      ProductName: item.name || '',
      Category: item.category || '',
      Selling_Price: numberText(item.sellingPrice, 2),
      Status: item.status || '',
      Barcodes: Array.isArray(item.barcodes) ? item.barcodes.join(', ') : String(item.barcodes || item.barcode || '')
    }));
}

export function buildRecipeRows(items = [], ingredients = []) {
  const ingredientMap = new Map((ingredients || []).map((ingredient) => [String(ingredient.id), ingredient]));
  return [...items]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .flatMap((item) => {
      const recipe = item.recipe || [];
      if (!recipe.length) {
        return [{
          Product_Name: item.name || '',
          Ingredient_Name: '',
          Quantity_Needed: '',
          UOM: ''
        }];
      }

      return recipe.map((line) => {
        const ing = ingredientMap.get(String(line.ingId || line.stockItemId || ''));
        return {
          Product_Name: item.name || '',
          Ingredient_Name: ing?.name || '',
          Quantity_Needed: line.qty ?? '',
          UOM: line.uom || ing?.unit || ''
        };
      });
    });
}

export function buildSupplierRows(items = []) {
  return [...items]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((supplier) => {
      const address = splitSupplierAddressForExport(supplier);
      return {
        Supplier_Name: supplier.name || '',
        Contact_Person: supplier.contactPerson || '',
        Email: supplier.email || '',
        Phone: supplier.phone || '',
        Category: supplier.category || '',
        Lead_Time_Days: supplier.leadTime ?? '',
        Payment_Terms: supplier.paymentTerms || '',
        Account_Number: supplier.accountNumber || '',
        Address_Line_1: address.addressLine1 || '',
        Address_Line_2: address.addressLine2 || '',
        City: address.city || '',
        Province: address.province || '',
        Postal_Code: address.postalCode || '',
        Country: address.country || '',
        Notes: supplier.notes || supplier.note || '',
        Supplier_ID: supplier.id || ''
      };
    });
}

function splitSupplierAddressForExport(supplier = {}) {
  const direct = {
    addressLine1: supplier.addressLine1 || supplier.address_line_1 || '',
    addressLine2: supplier.addressLine2 || supplier.address_line_2 || '',
    city: supplier.city || '',
    province: supplier.province || supplier.state || '',
    postalCode: supplier.postalCode || supplier.postal_code || supplier.zip || '',
    country: supplier.country || ''
  };
  if (Object.values(direct).some((value) => String(value || '').trim())) return direct;
  const parts = String(supplier.address || '').split(',').map((part) => part.trim()).filter(Boolean);
  return {
    addressLine1: parts[0] || supplier.address || '',
    addressLine2: parts[1] || '',
    city: parts[2] || '',
    province: parts[3] || '',
    postalCode: parts[4] || '',
    country: parts[5] || ''
  };
}

function getStockExportItemType(item = {}) {
  const explicit = String(item.itemType || item.stockItemType || item.specificationType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const category = String(item.category || '').toLowerCase();
  if (['sub_recipe', 'subrecipe'].includes(explicit) || item.isSubRecipe === true || category.includes('sub recipe') || category.includes('sub-recipe')) return 'Sub-Recipe';
  if (['manufactured', 'prep', 'prepared', 'manufactured_item'].includes(explicit) || item.isManufactured === true || category.includes('manufactured')) return 'Manufactured';
  if (['recipe_source', 'non_stock', 'virtual'].includes(explicit) || category.includes('recipe source') || category.includes('non-stock') || category.includes('non stock') || category.includes('virtual')) return 'Non Stock';
  return 'Standard';
}

export function buildStockRows(items = [], {
  getOnHand = (item) => item?.stock ?? 0
} = {}) {
  return [...items]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((item) => {
      const uomConfigs = normalizeExportUomConfigurations(item.uomConfigurations || item.uomConfig || item.uom_configuration || item.uomConversions || item.uomConversion).slice(0, 3);
      return {
        Item_Name: item.name || '',
        SKU: item.sku || item.SKU || item.stockCode || item.itemCode || '',
        Item_Type: getStockExportItemType(item),
        Category: formatInventoryCategoryForExport(item),
        Base_UOM: item.unit || '',
        Cost_Ex_VAT: numberText(item.cost, 4),
        VAT_Enabled: item.vatEnabled === false ? 'No' : 'Yes',
        Barcode: Array.isArray(item.barcodes) ? item.barcodes.join(', ') : String(item.barcodes || ''),
        Yield_Percentage: numberText(item.yieldFactor, 2),
        Batch_Yield: numberText(item.yieldBatch, 3),
        Opening_Stock: numberText(getOnHand(item), 3),
        Low_Stock_Threshold: numberText(item.lowStockThreshold, 3),
        Par_Level: numberText(item.parLevel, 3),
        Notes: item.notes || item.note || '',
        ...buildExportUomColumns(uomConfigs)
      };
    });
}

export function buildManufacturingRows(items = [], ingredients = []) {
  const ingredientMap = new Map((ingredients || []).map((ingredient) => [String(ingredient.id), ingredient]));
  return [...items]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .flatMap((item) => {
      const recipe = Array.isArray(item.recipe) ? item.recipe : Object.values(item.recipe || {});
      const itemType = getManufacturingExportType(item);
      const itemTypeLabel = itemType === 'sub_recipe' ? 'Sub-Recipe' : 'Manufactured';
      if (!recipe.length) {
        return [{
          Item_Type: itemTypeLabel,
          Name: item.name || '',
          Category: item.category || itemTypeLabel,
          Unit: item.unit || '',
          Batch_Yield: numberText(item.yieldBatch, 3),
          Component_Name: '',
          Quantity_Needed: ''
        }];
      }

      return recipe.map((line) => ({
        Item_Type: itemTypeLabel,
        Name: item.name || '',
        Category: item.category || itemTypeLabel,
        Unit: item.unit || '',
        Batch_Yield: numberText(item.yieldBatch, 3),
        Component_Name: ingredientMap.get(String(line.ingId))?.name || line.name || '',
        Quantity_Needed: line.qty ?? ''
      }));
    });
}

function getManufacturingExportType(item = {}) {
  const explicit = String(item.itemType || item.stockItemType || item.specificationType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['sub_recipe', 'subrecipe', 'sub_recipe_item'].includes(explicit) || item.isSubRecipe === true) return 'sub_recipe';
  return 'manufactured';
}

export function buildPurchaseOrderDocumentRows(orders = [], {
  siteName = 'KCP',
  getLocationName = defaultLocationName
} = {}) {
  const list = (Array.isArray(orders) ? orders : [orders]).filter(Boolean);
  return list.flatMap((order, orderIndex) => {
    const targetLocation = getOrderTargetLocationLabel(order, getLocationName);
    const rows = [
      ['PURCHASE ORDER', order.poNumber || order.reference || order.id || ''],
      ['Business:', order.supplyForName || siteName],
      ['PO Number:', order.poNumber || order.reference || order.id || ''],
      ['Supplier:', order.supplierName || ''],
      ['Supplier VAT No:', order.supplierVatNumber || ''],
      ['Supplier Account:', order.supplierAccountNumber || ''],
      ['Supplier Contact:', order.supplierContact || ''],
      ['Delivery / Supply To:', targetLocation],
      ['PO Reference:', order.reference || order.poNumber || ''],
      [],
      ['Instructions:', 'Please confirm receipt. Any unavailable items, substitutions, or quantity changes must be confirmed before delivery.'],
      exportSchemas.purchaseOrderLines
    ];

    (order.items || []).forEach((item) => {
      const packSize = getPurchaseOrderLinePackSize(item);
      rows.push([
        item.name || item.stockItemName || '',
        item.unit || 'EA',
        packSize,
        item.qty ?? '',
        item.notes || item.note || ''
      ]);
    });

    return orderIndex === list.length - 1 ? rows : [...rows, [], []];
  });
}

export function buildGoodsReceiptDocumentRows(receipts = [], {
  getLocationName = defaultLocationName
} = {}) {
  const list = (Array.isArray(receipts) ? receipts : [receipts]).filter(Boolean);
  const rows = [exportSchemas.grvLines];
  let grandTotal = 0;

  list.forEach((receipt) => {
    const fallbackLocation = getReceiptLocationLabel(receipt, getLocationName);
    (receipt.items || []).forEach((item) => {
      const unitCost = Number(item.costEx ?? item.unitCost ?? item.cost ?? 0);
      const qty = Number(item.qty ?? item.receivedQty ?? 0);
      const packSize = Number(item.packSize || 1) > 0 ? Number(item.packSize || 1) : 1;
      const baseQty = Number(item.baseQuantity ?? item.baseQty ?? (qty * packSize)) || 0;
      rows.push([
        receipt.date || formatDate(receipt.timestamp || receipt.createdAt),
        receipt.supplier || receipt.supplierName || 'Manual Receipt',
        receipt.invoice || receipt.grvNumber || receipt.id || '',
        item.name || item.stockItemName || '',
        qty,
        item.unit || 'EA',
        packSize > 1 ? packSize : '',
        numberText(unitCost, 2),
        numberText(item.lineTotalEx ?? baseQty * unitCost, 2),
        item.locationName || item.targetLocationName || getLocationName(item.locationId || item.targetLocation || '', fallbackLocation)
      ]);
    });
    grandTotal += Number(receipt.totalEx || getReceiptSubtotal(receipt));
  });

  rows.push(['', '', '', '', '', '', '', 'GRAND TOTAL', numberText(grandTotal, 2), '']);
  return rows;
}

export async function exportObjectRows({
  format,
  filename,
  sheetName,
  title,
  subtitle,
  rows,
  columns,
  summaryRows = [],
  detailSheets = [],
  branding = {},
  xlsxOptions = {}
}) {
  const normalized = (rows || []).map((row) => Object.fromEntries(columns.map((column) => [column, row?.[column] ?? ''])));
  const summary = normalizeSummaryRows(summaryRows);
  const effectiveSummary = summary.length
    ? summary
    : buildDefaultSummaryRows({ title, subtitle, rowCount: normalized.length });

  // Drill-down / action detail (e.g. wastage events, price history, GRV lines) so
  // exports carry the same supporting data shown in the on-screen action modals,
  // not just the flat table. Each sheet: { name, columns, rows }.
  const detail = (detailSheets || [])
    .map((sheet) => ({
      name: String(sheet?.name || 'Detail').slice(0, 30),
      columns: sheet?.columns || [],
      rows: (sheet?.rows || []).map((row) => Object.fromEntries((sheet?.columns || []).map((column) => [column, row?.[column] ?? '']))),
    }))
    .filter((sheet) => sheet.columns.length && sheet.rows.length);

  if (format === 'xlsx') {
    if (effectiveSummary.length || detail.length) {
      await downloadWorkbookXlsx(filename, [
        { name: 'Summary', rows: buildSummarySheetAoa(effectiveSummary) },
        {
          name: sheetName || 'Main Export',
          rows: buildMainReportAoa(normalized, columns),
          ...(xlsxOptions.mainSheet || xlsxOptions)
        },
        ...detail.map((sheet) => ({ name: sheet.name, rows: buildMainReportAoa(sheet.rows, sheet.columns) }))
      ]);
      return;
    }
    await downloadXlsx(filename, normalized, sheetName);
    return;
  }

  if (format === 'pdf') {
    await downloadPdf(filename, {
      title,
      subtitle,
      rows: normalized,
      columns,
      summaryRows: effectiveSummary,
      branding,
      detailTables: detail.map((sheet) => ({ title: sheet.name, headers: sheet.columns, rows: sheet.rows }))
    });
    return;
  }

  if (effectiveSummary.length || detail.length) {
    const aoa = buildSeparatedExportAoa(effectiveSummary, normalized, columns);
    detail.forEach((sheet) => {
      aoa.push([], [sheet.name], sheet.columns, ...sheet.rows.map((row) => sheet.columns.map((column) => row?.[column] ?? '')));
    });
    downloadAoaCsv(filename, aoa);
    return;
  }

  downloadCsv(filename, normalized);
}

function normalizeSummaryRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (Array.isArray(row)) return { label: row[0], value: row[1] };
      return { label: row?.label, value: row?.value };
    })
    .filter((row) => String(row.label ?? '').trim());
}

function buildDefaultSummaryRows({ title = 'Export', subtitle = '', rowCount = 0 } = {}) {
  return [
    { label: 'Export', value: title || 'Export' },
    ...(subtitle ? [{ label: 'Description', value: subtitle }] : []),
    { label: 'Rows', value: rowCount },
    { label: 'Generated', value: new Date().toLocaleString('en-ZA') }
  ];
}

function buildSummarySheetAoa(summaryRows = []) {
  return [
    ['Summary'],
    ['Field', 'Value'],
    ...summaryRows.map((row) => [row.label, row.value ?? '']),
  ];
}

function buildMainReportAoa(rows = [], columns = []) {
  return [
    columns,
    ...rows.map((row) => columns.map((column) => row?.[column] ?? ''))
  ];
}

function buildSeparatedExportAoa(summaryRows = [], rows = [], columns = []) {
  return [
    ...buildSummarySheetAoa(summaryRows),
    [],
    ['Main Export'],
    columns,
    ...rows.map((row) => columns.map((column) => row?.[column] ?? ''))
  ];
}

export function buildTemplateRows(columns = []) {
  const safeColumns = Array.isArray(columns) ? columns : [];
  return getTemplateExampleRows(safeColumns)
    .map((example) => Object.fromEntries(safeColumns.map((column) => [column, example[column] ?? ''])));
}

const TEMPLATE_ACCEPTED_BOOLEAN = 'Accepted: Yes, No, Y, N, True, False, 1, 0';
const TEMPLATE_ACCEPTED_VAT = 'Accepted: Yes, No, Tax Exempt, Y, N, True, False, 1, 0';
const TEMPLATE_ACCEPTED_ITEM_TYPE = 'Accepted: Standard, Sub-Recipe, Non Stock, Manufactured';
const TEMPLATE_ACCEPTED_BASE_UOM = 'Accepted: ea, kg, g, L, ml';
const TEMPLATE_ACCEPTED_SUPPLIER_CATEGORY = 'Accepted: Fresh Produce, Meat, Dairy, Dry Goods, Beverages, Packaging, Cleaning, Other';
const TEMPLATE_ACCEPTED_PAYMENT_TERMS = 'Accepted: COD, 7 Days, 14 Days, 30 Days, 60 Days, Custom';
const TEMPLATE_ACCEPTED_MENU_STATUS = 'Accepted: Active, Archived';
const TEMPLATE_ACCEPTED_MANUFACTURING_TYPE = 'Accepted: Manufactured, Sub-Recipe, Sub Recipe';

function getTemplateExampleRows(columns = []) {
  const key = columns.join('|');
  if (key === exportSchemas.stock.join('|')) {
    return [
      {
        Item_Name: 'EXAMPLE ONLY - Almond Milk',
        SKU: 'MILK-ALMOND-001',
        Item_Type: TEMPLATE_ACCEPTED_ITEM_TYPE,
        Category: 'Dairy',
        Base_UOM: TEMPLATE_ACCEPTED_BASE_UOM,
        Cost_Ex_VAT: '24.50',
        VAT_Enabled: TEMPLATE_ACCEPTED_VAT,
        Barcode: '600000000002',
        Yield_Percentage: '100',
        Batch_Yield: '1',
        Opening_Stock: '10',
        Low_Stock_Threshold: '5',
        Par_Level: '20',
        Notes: 'Standard stock item — tracked at all locations by default.',
        UOM_1_Name: 'Box',
        UOM_1_Qty_In_Base: '6',
        UOM_1_Barcode: '600000000102',
        UOM_2_Name: 'Case',
        UOM_2_Qty_In_Base: '12',
        UOM_2_Barcode: '600000000202',
        UOM_3_Name: '',
        UOM_3_Qty_In_Base: '',
        UOM_3_Barcode: ''
      },
      {
        Item_Name: 'EXAMPLE ONLY - Burger Patty Mix',
        SKU: 'PREP-PATTY-MIX',
        Item_Type: 'Manufactured',
        Category: 'Meat',
        Base_UOM: TEMPLATE_ACCEPTED_BASE_UOM,
        Cost_Ex_VAT: '85.00',
        VAT_Enabled: TEMPLATE_ACCEPTED_VAT,
        Barcode: '600000000003',
        Yield_Percentage: '95',
        Batch_Yield: '10',
        Opening_Stock: '0',
        Low_Stock_Threshold: '2',
        Par_Level: '8',
        Notes: 'Manufactured/Prep item — produced in batches, tracked as own stock.',
        UOM_1_Name: 'Tray',
        UOM_1_Qty_In_Base: '5',
        UOM_1_Barcode: '600000000103',
        UOM_2_Name: 'Case',
        UOM_2_Qty_In_Base: '20',
        UOM_2_Barcode: '600000000203',
        UOM_3_Name: 'Batch',
        UOM_3_Qty_In_Base: '10',
        UOM_3_Barcode: '600000000303'
      },
      {
        Item_Name: 'EXAMPLE ONLY - Sauce (Sub-Recipe)',
        SKU: 'SR-SAUCE-001',
        Item_Type: 'Sub-Recipe',
        Category: 'Sauces',
        Base_UOM: 'L',
        Cost_Ex_VAT: '12.00',
        VAT_Enabled: 'No',
        Barcode: '',
        Yield_Percentage: '90',
        Batch_Yield: '5',
        Opening_Stock: '0',
        Low_Stock_Threshold: '0',
        Par_Level: '0',
        Notes: 'Sub-Recipe — used as a nested ingredient. Stock not tracked directly.',
        UOM_1_Name: '',
        UOM_1_Qty_In_Base: '',
        UOM_1_Barcode: '',
        UOM_2_Name: '',
        UOM_2_Qty_In_Base: '',
        UOM_2_Barcode: '',
        UOM_3_Name: '',
        UOM_3_Qty_In_Base: '',
        UOM_3_Barcode: ''
      }
    ];
  }
  return [getTemplateExampleRow(columns)];
}

function getTemplateExampleRow(columns = []) {
  const key = columns.join('|');
  const examples = {
    [exportSchemas.menu.join('|')]: {
      ProductName: 'EXAMPLE ONLY - Americano',
      Category: 'Coffee',
      Selling_Price: '28.00',
      Status: TEMPLATE_ACCEPTED_MENU_STATUS,
      Barcodes: '600000000001'
    },
    [exportSchemas.recipes.join('|')]: {
      Product_ID: 'EXAMPLE ONLY - menu item id',
      Product_Name: 'EXAMPLE ONLY - Americano',
      SKU: 'AM001',
      Category: 'Coffee',
      Ingredient_ID: 'stock item id',
      Ingredient_Name: 'Coffee Beans',
      Quantity_Needed: '0.018'
    },
    [exportSchemas.manufacturing.join('|')]: {
      Item_Type: TEMPLATE_ACCEPTED_MANUFACTURING_TYPE,
      Name: 'EXAMPLE ONLY - Sauce Base - Manufactured',
      Category: 'Sauce - Manufactured',
      Unit: 'L',
      Batch_Yield: '5',
      Component_Name: 'Tomatoes',
      Quantity_Needed: '2.5'
    },
    [exportSchemas.suppliers.join('|')]: {
      Supplier_Name: 'EXAMPLE ONLY - Fresh Produce Co',
      Contact_Person: 'Sam Supplier',
      Email: 'orders@freshproduce.example',
      Phone: '+27 21 000 0000',
      Category: TEMPLATE_ACCEPTED_SUPPLIER_CATEGORY,
      Lead_Time_Days: '2',
      Payment_Terms: TEMPLATE_ACCEPTED_PAYMENT_TERMS,
      Account_Number: 'ACC-001',
      Address_Line_1: '1 Market Road',
      Address_Line_2: 'Unit 4',
      City: 'Cape Town',
      Province: 'Western Cape',
      Postal_Code: '8001',
      Country: 'South Africa',
      Notes: 'Delivers weekday mornings.',
      Supplier_ID: 'EXAMPLE_ONLY_SUPPLIER'
    }
  };

  return examples[key] || Object.fromEntries(columns.map((column) => [column, 'EXAMPLE ONLY']));
}

export async function exportAoaRows({
  format,
  filename,
  sheetName,
  title,
  subtitle,
  rows,
  headerRowIndex = 8,
  branding = {},
  orientation = 'portrait',
  tableOptions = {}
}) {
  if (format === 'xlsx') {
    await downloadAoaXlsx(filename, rows, sheetName);
    return;
  }

  if (format === 'pdf') {
    await downloadAoaPdf(filename, { title, subtitle, rows, headerRowIndex, branding, orientation, tableOptions });
    return;
  }

  downloadAoaCsv(filename, rows);
}

export function getOrderSubtotal(order = {}) {
  return (order.items || []).reduce((sum, item) => {
    return sum + getOrderLineTotal(item);
  }, 0);
}

export function getOrderVat(order = {}, vatRate = 15) {
  return getOrderSubtotal(order) * (Number(vatRate || 0) / 100);
}

function getPurchaseOrderLinePackSize(item = {}) {
  const candidates = [
    item.packSize,
    item.pack_size,
    item.pack,
    item.packQty,
    item.packQuantity,
    item.caseSize,
    item.case_size,
    item.unitsPerPack,
    item.units_per_pack,
    item.unitPackSize
  ];
  const value = candidates.find((candidate) => {
    const number = Number(candidate);
    return Number.isFinite(number) && number > 0;
  });
  return Number(value || 1) || 1;
}

export function getReceiptSubtotal(receipt = {}) {
  return (receipt.items || []).reduce((sum, item) => {
    return sum + Number(item.receivedQty || item.qty || 0) * Number(item.unitCost || item.cost || 0);
  }, 0);
}

export function normalizePoStatusLabel(status) {
  const value = String(status || 'draft').toLowerCase();
  if (value === 'sent' || value === 'submitted') return 'Sent';
  if (value === 'partially_received' || value === 'partially received' || value === 'partial') return 'Partially Received';
  if (value === 'completed' || value === 'received') return 'Completed';
  return 'Draft';
}

function defaultLocationName(_id, fallback = 'Main Store') {
  return fallback || 'Main Store';
}

function getOrderTargetLocationLabel(order = {}, getLocationName = defaultLocationName) {
  const lineLocations = new Set((order.items || [])
    .map((item) => item.locationName || item.targetLocationName || item.locationId || item.targetLocation)
    .filter(Boolean)
    .map(String));

  if (lineLocations.size > 1) return 'Multiple Locations';
  if (lineLocations.size === 1) {
    const [location] = [...lineLocations];
    const line = (order.items || []).find((item) => (
      String(item.locationName || item.targetLocationName || item.locationId || item.targetLocation || '') === location
    ));
    return line?.locationName || line?.targetLocationName || getLocationName(line?.locationId || line?.targetLocation || '', location);
  }

  return getLocationName(order.targetLocation || order.locationId, order.targetLocationName || 'Main Store');
}

function getReceiptLocationLabel(receipt = {}, getLocationName = defaultLocationName) {
  const lineLocations = new Set((receipt.items || [])
    .map((item) => item.locationName || item.targetLocationName || item.locationId || item.targetLocation)
    .filter(Boolean)
    .map(String));

  if (lineLocations.size > 1) return 'Multiple Locations';
  if (lineLocations.size === 1) {
    const [location] = [...lineLocations];
    const line = (receipt.items || []).find((item) => (
      String(item.locationName || item.targetLocationName || item.locationId || item.targetLocation || '') === location
    ));
    return line?.locationName || line?.targetLocationName || getLocationName(line?.locationId || line?.targetLocation || '', location);
  }

  return getLocationName(receipt.targetLocation || receipt.locationId, receipt.targetLocationName || receipt.locationName || 'Main Store');
}

function formatDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function numberText(value, decimals) {
  return Number(value || 0).toFixed(decimals);
}

function buildExportUomColumns(configs = []) {
  return [0, 1, 2].reduce((columns, index) => {
    const row = configs[index] || {};
    const suffix = index + 1;
    columns[`UOM_${suffix}_Name`] = row.customUom || '';
    columns[`UOM_${suffix}_Qty_In_Base`] = row.ratio ? numberText(row.ratio, 3).replace(/\.?0+$/, '') : '';
    columns[`UOM_${suffix}_Barcode`] = row.barcode || '';
    return columns;
  }, {});
}

function normalizeExportUomConfigurations(value = []) {
  const rows = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? [value] : []);
  return rows
    .map((entry = {}) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const baseUom = String(row.baseUom || row.base_uom || row.baseUnit || row.unit || '').trim();
      const customUom = String(row.customUom || row.custom_uom || row.customUnit || row.orderingUom || '').trim();
      const ratio = Number(row.ratio ?? row.conversionRatio ?? row.unitsPerCustomUnit ?? row.units_per_custom_unit ?? 0) || 0;
      const barcode = String(row.barcode || row.customBarcode || row.customUomBarcode || '').trim();
      return { baseUom, customUom, ratio, barcode };
    })
    .filter((entry) => entry.customUom || entry.ratio > 0 || entry.barcode);
}

function getOrderLineTotal(item = {}) {
  if (item.lineTotalEx !== undefined && item.lineTotalEx !== null && item.lineTotalEx !== '') {
    return Number(item.lineTotalEx || 0) || 0;
  }
  const qty = Number(item.qty ?? item.quantity ?? 0) || 0;
  const packSize = Number(item.packSize ?? item.pack_size ?? 1) || 1;
  const unitCost = Number(item.unitCost ?? item.cost ?? item.price ?? 0) || 0;
  return qty * packSize * unitCost;
}

function formatInventoryCategoryForExport(item = {}) {
  const raw = String(item.category || '').trim();
  if (!raw) return '';
  const manufacturedMatch = raw.match(/\(([^)]+)\)\s*-\s*Manufactured$/i);
  if (manufacturedMatch?.[1]) return manufacturedMatch[1].trim();
  return raw
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .trim();
}
