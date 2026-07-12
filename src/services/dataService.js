const EXCEL_EXTENSION = /\.(xlsx|xls)$/i;

export async function parseDataFile(file, options = {}) {
  if (!file) return [];

  if (EXCEL_EXTENSION.test(file.name || '')) {
    const workbook = await readExcelWorkbook(file);
    const sheetName = selectImportSheetName(workbook.SheetNames, options);
    if (!sheetName) return [];
    return workbook.Sheets[sheetName]
      ? workbook.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
      : [];
  }

  const text = await file.text();
  return parseDataText(text, file.name);
}

function selectImportSheetName(sheetNames = [], options = {}) {
  const names = Array.isArray(sheetNames) ? sheetNames.filter(Boolean) : [];
  if (!names.length) return '';

  const preferred = [
    ...toArray(options.preferredSheetNames),
    options.preferredSheetName
  ].map(normalizeSheetLookupName).filter(Boolean);
  if (preferred.length) {
    const match = names.find((name) => preferred.includes(normalizeSheetLookupName(name)));
    if (match) return match;
  }

  return names.find((name) => normalizeSheetLookupName(name) !== 'summary') || names[0] || '';
}

function normalizeSheetLookupName(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

export function parseDataText(text, fileName = '') {
  const body = String(text || '').trim();
  if (!body) return [];

  const isJson = /\.json$/i.test(fileName) || body.startsWith('{') || body.startsWith('[');
  if (!isJson) return parseCsvRows(body);

  const parsed = JSON.parse(body);
  if (Array.isArray(parsed)) return parsed;

  const candidates = parsed.menu_items || parsed.menuItems || parsed.recipe_items || parsed.recipeItems ||
    parsed.stock_items || parsed.stockItems || parsed.items || parsed.products || parsed.ingredients ||
    parsed.data || parsed;

  if (Array.isArray(candidates)) return candidates;
  if (candidates && typeof candidates === 'object') {
    return Object.entries(candidates).map(([id, value]) => ({
      ID: id,
      ProductID: id,
      ProductName: value?.name || value?.ProductName || value?.productName || id,
      Category: value?.category || value?.ProductCategory || value?.Group || '',
      SellingPrice: value?.sellingPrice ?? value?.SellingPrice ?? value?.Price ?? value?.price ?? 0,
      ...(value && typeof value === 'object' ? value : {})
    }));
  }

  return [];
}

export function downloadCsv(filename, rows = []) {
  const csv = toCsv(rows);
  downloadBlob(`${ensureExtension(filename, 'csv')}`, csv, 'text/csv;charset=utf-8');
}

export function downloadAoaCsv(filename, rows = []) {
  const csv = (Array.isArray(rows) ? rows : [])
    .map((row) => (Array.isArray(row) ? row : [row]).map(escapeCsvField).join(','))
    .join('\r\n');
  downloadBlob(`${ensureExtension(filename, 'csv')}`, csv, 'text/csv;charset=utf-8');
}

export async function downloadXlsx(filename, rows = [], sheetName = 'Export', options = {}) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(normalizeRowsForXlsx(rows));
  applyXlsxSheetOptions(worksheet, { freezeHeader: true, ...options });
  XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(sheetName));
  XLSX.writeFile(workbook, ensureExtension(filename, 'xlsx'));
}

export async function downloadAoaXlsx(filename, rows = [], sheetName = 'Export') {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(normalizeAoaForXlsx(rows));
  XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(sheetName));
  XLSX.writeFile(workbook, ensureExtension(filename, 'xlsx'));
}

export async function downloadWorkbookXlsx(filename, sheets = []) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const safeSheets = (Array.isArray(sheets) ? sheets : [])
    .filter((sheet) => sheet && Array.isArray(sheet.rows));

  if (!safeSheets.length) {
    const worksheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Export');
  } else {
    safeSheets.forEach((sheet, index) => {
      const worksheet = XLSX.utils.aoa_to_sheet(normalizeAoaForXlsx(sheet.rows));
      applyXlsxSheetOptions(worksheet, { freezeHeader: true, ...sheet });
      const baseName = sanitizeSheetName(sheet.name || `Sheet ${index + 1}`);
      const sheetName = uniqueSheetName(workbook.SheetNames, baseName);
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    });
  }

  XLSX.writeFile(workbook, ensureExtension(filename, 'xlsx'));
}

const STANDARD_UOMS = ['kg', 'g', 'L', 'ml', 'pcs', 'box', 'bunch', 'pack'];

function sanitizeNamedRange(name) {
  // Must match exactly what the INDIRECT formula does: spaces→_ and hyphens→_
  // Other invalid chars are stripped (not replaced) so the formula still resolves correctly
  return String(name || '')
    .replace(/[\s]+/g, '_')
    .replace(/[-]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/^([0-9])/, '_$1') || '_range';
}

export async function downloadStyledRecipeTemplateXlsx(filename, { products = [], ingredientObjects = [], platform = 'excel' } = {}) {
  const ExcelJSModule = await import('exceljs');
  const ExcelJS = ExcelJSModule.default || ExcelJSModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KCP';
  workbook.created = new Date();

  const FONT = 'Segoe UI';
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
  const HEADER_FONT = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  const BODY_FONT = { name: FONT, size: 10 };
  const UOM_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
  const BORDER = {
    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
  };

  // Deduplicate ingredient objects by name
  const uniqueIngredients = [];
  const seenIngNames = new Set();
  for (const ing of ingredientObjects) {
    const name = String(ing.name || '').trim();
    if (!name || seenIngNames.has(name)) continue;
    seenIngNames.add(name);
    uniqueIngredients.push(ing);
  }
  uniqueIngredients.sort((a, b) => a.name.localeCompare(b.name));

  // Build per-ingredient UOM lists — only that ingredient's own UOM + its custom UOMs
  const ingUomMap = new Map(); // name -> string[]
  for (const ing of uniqueIngredients) {
    const uoms = new Set();
    if (ing.uom) uoms.add(ing.uom);
    (ing.customUoms || []).forEach((u) => u && uoms.add(u));
    // If the ingredient has no UOM at all, fall back to standard list rather than empty
    if (!uoms.size) STANDARD_UOMS.forEach((u) => uoms.add(u));
    ingUomMap.set(ing.name, [...uoms]);
  }

  // ── Main sheet ──────────────────────────────────────────────────────────────
  const main = workbook.addWorksheet('Recipe Builder');
  main.columns = [
    { header: 'Product Name',    key: 'a', width: 36 },
    { header: 'Ingredient Name', key: 'b', width: 36 },
    { header: 'UOM',             key: 'c', width: 16 },
    { header: 'Quantity Needed', key: 'd', width: 18 }
  ];

  const headerRow = main.getRow(1);
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = BORDER;
  });

  for (let r = 2; r <= 100; r++) {
    const row = main.getRow(r);
    row.height = 20;
    ['A', 'B', 'C', 'D'].forEach((col) => {
      const cell = row.getCell(col);
      cell.font = BODY_FONT;
      cell.border = BORDER;
      if (col === 'C') {
        cell.fill = UOM_FILL;
      }
      if (col === 'D') {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      }
    });
  }

  // ── Hidden Dropdown_Lists sheet ─────────────────────────────────────────────
  const ref = workbook.addWorksheet('Dropdown_Lists');
  ref.state = 'hidden';

  // Column A: Product names
  ref.getCell('A1').value = 'Product_Name';
  products.forEach((name, i) => { ref.getCell(`A${i + 2}`).value = name; });

  // Column B: Ingredient names
  ref.getCell('B1').value = 'Ingredient_Name';
  uniqueIngredients.forEach((ing, i) => { ref.getCell(`B${i + 2}`).value = ing.name; });

  // Flat fallback UOM list (used only for the Google Sheets platform).
  const allUoms = new Set(STANDARD_UOMS);
  for (const ing of uniqueIngredients) {
    (ingUomMap.get(ing.name) || []).forEach((u) => allUoms.add(u));
  }
  const allUomList = [...allUoms].sort();

  // Columns C onward: one column per ingredient with its valid UOMs.
  // Each column is registered as an Excel defined name (named range) matching the
  // ingredient name (spaces/hyphens → underscores) so the INDIRECT formula below
  // resolves to that ingredient's list. This is the approach that reliably filters
  // UOMs per ingredient in Excel.
  let colIndex = 3; // Start at column C (1-based: 3 = C)
  for (const ing of uniqueIngredients) {
    const uoms = ingUomMap.get(ing.name) || STANDARD_UOMS;
    const colLetter = columnIndexToLetter(colIndex);
    const rangeName = sanitizeNamedRange(ing.name);

    ref.getCell(`${colLetter}1`).value = ing.name;
    uoms.forEach((uom, i) => {
      ref.getCell(`${colLetter}${i + 2}`).value = uom;
    });

    const endRow = uoms.length + 1;
    workbook.definedNames.add(
      `Dropdown_Lists!$${colLetter}$2:$${colLetter}$${endRow}`,
      rangeName
    );

    colIndex++;
  }

  // A dedicated fallback column (after all ingredient columns) holds the flat UOM
  // list — only referenced by the Google Sheets validation path.
  const fallbackColLetter = columnIndexToLetter(colIndex);
  ref.getCell(`${fallbackColLetter}1`).value = 'UOM_All';
  allUomList.forEach((uom, i) => { ref.getCell(`${fallbackColLetter}${i + 2}`).value = uom; });
  const uomEnd = Math.max(allUomList.length + 1, 2);

  // Product Name (Col A) validation
  const pEnd = Math.max(products.length + 1, 2);
  main.dataValidations.add('A2:A100', {
    type: 'list', allowBlank: true, showErrorMessage: true,
    errorStyle: 'stop', errorTitle: 'Invalid Selection',
    error: 'Please select a product from the dropdown list.',
    formulae: [`'Dropdown_Lists'!$A$2:$A$${pEnd}`]
  });

  // Ingredient Name (Col B) validation
  const iEnd = Math.max(uniqueIngredients.length + 1, 2);
  main.dataValidations.add('B2:B100', {
    type: 'list', allowBlank: true, showErrorMessage: true,
    errorStyle: 'stop', errorTitle: 'Invalid Selection',
    error: 'Please select an ingredient from the dropdown list.',
    formulae: [`'Dropdown_Lists'!$B$2:$B$${iEnd}`]
  });

  // UOM (Col C) — filtered per selected ingredient.
  if (platform === 'sheets') {
    // Google Sheets: dependent dropdowns via named ranges don't import reliably,
    // so fall back to the full UOM list (per product decision — ignore Sheets filtering).
    main.dataValidations.add('C2:C100', {
      type: 'list', allowBlank: true, showErrorMessage: false,
      formulae: [`'Dropdown_Lists'!$${fallbackColLetter}$2:$${fallbackColLetter}$${uomEnd}`]
    });
  } else if (uniqueIngredients.length > 0) {
    // Excel: INDIRECT resolves the named range for the ingredient chosen in Col B.
    for (let r = 2; r <= 100; r++) {
      main.dataValidations.add(`C${r}`, {
        type: 'list', allowBlank: true, showErrorMessage: true,
        errorStyle: 'stop', errorTitle: 'Invalid Unit',
        error: 'This unit is not valid for the selected ingredient.',
        formulae: [`INDIRECT(SUBSTITUTE(SUBSTITUTE($B${r}," ","_"),"-","_"))`]
      });
    }
  } else {
    main.dataValidations.add('C2:C100', {
      type: 'list', allowBlank: true, showErrorMessage: false,
      formulae: [`'Dropdown_Lists'!$${fallbackColLetter}$2:$${fallbackColLetter}$${uomEnd}`]
    });
  }

  // ── Write & download ─────────────────────────────────────────────────────
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ensureExtension(filename, 'xlsx');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Manufactured Items Builder XLSX ────────────────────────────────────────
export async function buildManufacturingBuilderXlsx({ manufacturedItems = [], stockItems = [], filename = 'kcp-manufacturing-builder' } = {}) {
  const ExcelJSModule = await import('exceljs');
  const ExcelJS = ExcelJSModule.default || ExcelJSModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KCP';
  workbook.created = new Date();
  const FONT = 'Calibri';
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
  const HEADER_FONT = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  const BODY_FONT = { name: FONT, size: 10 };
  const UOM_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
  const BORDER = {
    top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
    left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
    bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
    right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
  };

  // Only show manufactured and sub-recipe items in the item dropdown
  const mfgNames = [...new Set(
    manufacturedItems
      .map((item) => String(item.name || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  // All stock items available as components
  const componentNames = [...new Set(
    stockItems.map((item) => String(item.name || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  // Build per-component UOM map
  const compUomMap = new Map();
  for (const item of stockItems) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const uoms = new Set();
    if (item.unit) uoms.add(item.unit);
    (item.uomConfig || item.uomConfigurations || []).forEach((u) => {
      if (u.customUom) uoms.add(u.customUom);
    });
    if (!uoms.size) STANDARD_UOMS.forEach((u) => uoms.add(u));
    compUomMap.set(name, [...uoms]);
  }

  // Main sheet
  const main = workbook.addWorksheet('Mfg Builder');
  main.columns = [
    { header: 'Manufactured Item', key: 'a', width: 36 },
    { header: 'Component Name',    key: 'b', width: 36 },
    { header: 'UOM',               key: 'c', width: 16 },
    { header: 'Quantity Needed',   key: 'd', width: 18 }
  ];

  const headerRow = main.getRow(1);
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = BORDER;
  });

  for (let r = 2; r <= 100; r++) {
    const row = main.getRow(r);
    row.height = 20;
    ['A', 'B', 'C', 'D'].forEach((col) => {
      const cell = row.getCell(col);
      cell.font = BODY_FONT;
      cell.border = BORDER;
      if (col === 'C') cell.fill = UOM_FILL;
      if (col === 'D') {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      }
    });
  }

  // Hidden Dropdown_Lists sheet
  const ref = workbook.addWorksheet('Dropdown_Lists');
  ref.state = 'hidden';

  // Col A: manufactured item names
  ref.getCell('A1').value = 'Item_Name';
  mfgNames.forEach((name, i) => { ref.getCell(`A${i + 2}`).value = name; });

  // Col B: component names
  ref.getCell('B1').value = 'Component_Name';
  componentNames.forEach((name, i) => { ref.getCell(`B${i + 2}`).value = name; });

  // Flat fallback UOM list (only used when there are no components).
  const allUoms = new Set(STANDARD_UOMS);
  for (const uoms of compUomMap.values()) uoms.forEach((u) => allUoms.add(u));
  const allUomList = [...allUoms].sort();

  // Cols C+: one column per component with its valid UOMs, each registered as a
  // defined name (named range) so the INDIRECT formula resolves per component.
  let colIndex = 3;
  for (const name of componentNames) {
    const uoms = compUomMap.get(name) || STANDARD_UOMS;
    const colLetter = columnIndexToLetter(colIndex);
    const rangeName = sanitizeNamedRange(name);
    ref.getCell(`${colLetter}1`).value = name;
    uoms.forEach((uom, i) => { ref.getCell(`${colLetter}${i + 2}`).value = uom; });
    const endRow = uoms.length + 1;
    workbook.definedNames.add(`Dropdown_Lists!$${colLetter}$2:$${colLetter}$${endRow}`, rangeName);
    colIndex++;
  }

  const fallbackColLetter = columnIndexToLetter(colIndex);
  ref.getCell(`${fallbackColLetter}1`).value = 'UOM_All';
  allUomList.forEach((uom, i) => { ref.getCell(`${fallbackColLetter}${i + 2}`).value = uom; });
  const uomEnd = Math.max(allUomList.length + 1, 2);

  // Data validations
  const aEnd = Math.max(mfgNames.length + 1, 2);
  main.dataValidations.add('A2:A100', {
    type: 'list', allowBlank: true, showErrorMessage: true,
    errorStyle: 'stop', errorTitle: 'Invalid Selection',
    error: 'Please select a manufactured item from the dropdown list.',
    formulae: [`'Dropdown_Lists'!$A$2:$A$${aEnd}`]
  });

  const bEnd = Math.max(componentNames.length + 1, 2);
  main.dataValidations.add('B2:B100', {
    type: 'list', allowBlank: true, showErrorMessage: true,
    errorStyle: 'stop', errorTitle: 'Invalid Selection',
    error: 'Please select a component from the dropdown list.',
    formulae: [`'Dropdown_Lists'!$B$2:$B$${bEnd}`]
  });

  if (componentNames.length > 0) {
    // INDIRECT resolves the named range for the component chosen in Col B.
    for (let r = 2; r <= 100; r++) {
      main.dataValidations.add(`C${r}`, {
        type: 'list', allowBlank: true, showErrorMessage: true,
        errorStyle: 'stop', errorTitle: 'Invalid Unit',
        error: 'This unit is not valid for the selected component.',
        formulae: [`INDIRECT(SUBSTITUTE(SUBSTITUTE($B${r}," ","_"),"-","_"))`]
      });
    }
  } else {
    main.dataValidations.add('C2:C100', {
      type: 'list', allowBlank: true, showErrorMessage: false,
      formulae: [`'Dropdown_Lists'!$${fallbackColLetter}$2:$${fallbackColLetter}$${uomEnd}`]
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ensureExtension(filename, 'xlsx');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function MATCH_COL_FORMULA(cellRef) {
  return `MATCH(${cellRef},'Dropdown_Lists'!$1:$1,0)`;
}

function columnIndexToLetter(index) {
  let letter = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function applyXlsxSheetOptions(worksheet, options = {}) {
  if (!worksheet || !options) return;
  if (Array.isArray(options.columnWidths) && options.columnWidths.length) {
    worksheet['!cols'] = options.columnWidths.map((width) => ({ wch: Math.max(8, Number(width || 12) || 12) }));
  }
  if (options.freezeHeader) {
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  }
  if (options.autoFilter !== false && worksheet['!ref']) {
    worksheet['!autofilter'] = { ref: worksheet['!ref'] };
  }
  if (Array.isArray(options.validations) && options.validations.length) {
    worksheet['!dataValidation'] = options.validations
      .map((rule = {}) => normalizeXlsxValidationRule(rule))
      .filter(Boolean);
  }
}

function normalizeXlsxValidationRule(rule = {}) {
  const column = String(rule.column || '').trim().toUpperCase();
  const values = (Array.isArray(rule.values) ? rule.values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!/^[A-Z]+$/.test(column) || !values.length) return null;
  const fromRow = Math.max(2, Number(rule.fromRow || 2) || 2);
  const toRow = Math.max(fromRow, Number(rule.toRow || 500) || 500);
  return {
    sqref: `${column}${fromRow}:${column}${toRow}`,
    type: 'list',
    allowBlank: true,
    formula1: `"${values.join(',')}"`
  };
}

function normalizeRowsForXlsx(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeXlsxCellValue(value)]));
  });
}

function normalizeAoaForXlsx(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => (
    Array.isArray(row) ? row.map(normalizeXlsxCellValue) : row
  ));
}

function normalizeXlsxCellValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rawFormula = value.formula ?? value.f;
  if (rawFormula === undefined || rawFormula === null || String(rawFormula).trim() === '') return value;
  const formula = String(rawFormula).trim().replace(/^=/, '');
  return {
    t: value.type || 'n',
    f: formula,
    ...(value.value !== undefined ? { v: value.value } : {})
  };
}

function uniqueSheetName(existingNames = [], baseName = 'Sheet') {
  const safeBase = sanitizeSheetName(baseName || 'Sheet') || 'Sheet';
  if (!existingNames.includes(safeBase)) return safeBase;
  let index = 2;
  while (existingNames.includes(sanitizeSheetName(`${safeBase.slice(0, 27)} ${index}`))) {
    index += 1;
  }
  return sanitizeSheetName(`${safeBase.slice(0, 27)} ${index}`);
}


function pdfTableLayoutOptions(columnCount = 0, options = {}) {
  const count = Number(columnCount || 0) || 0;
  const dense = count > 10;
  const veryDense = count > 14;
  return {
    showHead: 'everyPage',
    tableWidth: 'auto',
    rowPageBreak: 'avoid',
    horizontalPageBreak: count > 7,
    horizontalPageBreakRepeat: count > 3 ? 0 : undefined,
    horizontalPageBreakBehaviour: 'afterAllRows',
    styles: {
      font: 'helvetica',
      fontSize: veryDense ? 6.2 : dense ? 6.8 : 8,
      cellPadding: veryDense ? 3 : dense ? 4 : 5,
      valign: 'middle',
      overflow: 'linebreak',
      minCellHeight: veryDense ? 15 : 18,
      ...(options.styles || {})
    }
  };
}

function pdfCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(pdfCellValue).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

function normalizePdfBodyRows(rows = [], headers = []) {
  const safeHeaders = Array.isArray(headers) ? headers : [];
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (Array.isArray(row)) return row.map(pdfCellValue);
    return safeHeaders.map((header) => pdfCellValue(row?.[header]));
  });
}

function buildPdfColumnStyles(headers = []) {
  return (Array.isArray(headers) ? headers : []).reduce((styles, header, index) => {
    const label = String(header || '').toLowerCase();
    if (/qty|count|cost|price|amount|total|value|vat|variance|stock|par|threshold|percentage|yield|batch/.test(label)) {
      styles[index] = { halign: 'right' };
    }
    if (/name|description|notes|address/.test(label)) {
      styles[index] = { ...(styles[index] || {}), cellWidth: 'wrap' };
    }
    return styles;
  }, {});
}

export async function downloadPdf(filename, {
  title = 'KCP Export',
  subtitle = '',
  rows = [],
  columns = null,
  summaryRows = [],
  orientation = 'landscape',
  branding = {},
  tableOptions = {},
  detailTables = []
} = {}) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);
  const autoTable = autoTableModule.default || autoTableModule.autoTable;
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const headers = columns || getHeaders(normalizedRows);
  const body = normalizePdfBodyRows(normalizedRows, headers);
  const doc = new jsPDF({ orientation: headers.length > 7 ? 'landscape' : orientation, unit: 'pt', format: 'a4' });

  const header = await renderPdfHeader(doc, { title, subtitle, branding });
  const summary = normalizePdfSummaryRows(summaryRows);
  let tableStartY = header.tableStartY;
  if (summary.length) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const columnWidth = (pageWidth - 100) / 2;
    const summaryStartY = header.summaryStartY;
    doc.setFontSize(8);
    summary.slice(0, 14).forEach((row, index) => {
      const leftColumn = index % 2 === 0;
      const x = leftColumn ? 40 : 60 + columnWidth;
      const y = summaryStartY + Math.floor(index / 2) * 14;
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(91, 111, 137);
      doc.text(`${row.label}:`, x, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(17, 24, 39);
      doc.text(String(row.value ?? ''), x + 72, y, { maxWidth: columnWidth - 76 });
    });
    tableStartY = summaryStartY + Math.ceil(Math.min(summary.length, 14) / 2) * 14 + 22;
  }
  doc.setDrawColor(37, 99, 235);
  doc.setLineWidth(1);
  doc.line(40, tableStartY - 14, doc.internal.pageSize.getWidth() - 40, tableStartY - 14);

  const layout = pdfTableLayoutOptions(headers.length, tableOptions);
  autoTable(doc, {
    ...layout,
    head: [headers],
    body,
    startY: tableStartY,
    theme: 'grid',
    headStyles: {
      fillColor: [37, 99, 235],
      textColor: 255,
      fontStyle: 'bold',
      ...(tableOptions.headStyles || {})
    },
    alternateRowStyles: { fillColor: [245, 247, 250], ...(tableOptions.alternateRowStyles || {}) },
    columnStyles: { ...buildPdfColumnStyles(headers), ...(tableOptions.columnStyles || {}) },
    margin: { left: 40, right: 40, ...(tableOptions.margin || {}) },
    ...tableOptions,
    styles: layout.styles
  });

  drawPdfDetailTables(doc, autoTable, detailTables, { margin: 40 });

  doc.save(ensureExtension(filename, 'pdf'));
}


function drawPdfDetailTables(doc, autoTable, detailTables = [], { margin = 40 } = {}) {
  const tables = (Array.isArray(detailTables) ? detailTables : [])
    .map((table) => ({
      title: String(table?.title || table?.name || 'Detail').trim(),
      headers: Array.isArray(table?.headers) ? table.headers : (Array.isArray(table?.columns) ? table.columns : []),
      rows: Array.isArray(table?.rows) ? table.rows : []
    }))
    .filter((table) => table.headers.length && table.rows.length);
  if (!tables.length) return;

  let cursorY = Number(doc.lastAutoTable?.finalY || 80) + 22;
  const pageHeight = doc.internal.pageSize.getHeight();
  tables.forEach((table) => {
    if (cursorY > pageHeight - 110) {
      doc.addPage();
      cursorY = margin;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(37, 99, 235);
    doc.text(table.title.toUpperCase(), margin, cursorY);
    cursorY += 10;
    const layout = pdfTableLayoutOptions(table.headers.length, {});
    autoTable(doc, {
      ...layout,
      head: [table.headers],
      body: normalizePdfBodyRows(table.rows, table.headers),
      startY: cursorY,
      theme: 'grid',
      headStyles: { fillColor: [17, 24, 39], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: buildPdfColumnStyles(table.headers),
      margin: { left: margin, right: margin },
      styles: layout.styles
    });
    cursorY = Number(doc.lastAutoTable?.finalY || cursorY) + 20;
  });
}

function normalizePdfSummaryRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (Array.isArray(row)) return { label: row[0], value: row[1] };
      return { label: row?.label, value: row?.value };
    })
    .filter((row) => String(row.label ?? '').trim());
}

export async function downloadAoaPdf(filename, {
  title = 'KCP Export',
  subtitle = '',
  rows = [],
  orientation = 'portrait',
  headerRowIndex = 0,
  branding = {},
  tableOptions = {}
} = {}) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);
  const autoTable = autoTableModule.default || autoTableModule.autoTable;
  const safeRows = Array.isArray(rows) ? rows : [];
  const head = [safeRows[headerRowIndex] || []];
  const doc = new jsPDF({ orientation: (head[0]?.length || 0) > 7 ? 'landscape' : orientation, unit: 'pt', format: 'a4' });
  const body = safeRows
    .filter((_, index) => index !== headerRowIndex)
    .map((row) => (Array.isArray(row) ? row : [row]));
  const { ruleColor, ...autoTableOptions } = tableOptions || {};
  const resolvedRuleColor = Array.isArray(ruleColor) && ruleColor.length >= 3 ? ruleColor : [37, 99, 235];

  const header = await renderPdfHeader(doc, { title, subtitle, branding });
  doc.setDrawColor(resolvedRuleColor[0], resolvedRuleColor[1], resolvedRuleColor[2]);
  doc.setLineWidth(1);
  doc.line(40, header.ruleY, doc.internal.pageSize.getWidth() - 40, header.ruleY);

  const headerCount = head[0]?.length || 0;
  const layout = pdfTableLayoutOptions(headerCount, autoTableOptions);
  autoTable(doc, {
    ...layout,
    head,
    body: body.map((row) => Array.isArray(row) ? row.map(pdfCellValue) : [pdfCellValue(row)]),
    startY: header.tableStartY,
    theme: 'grid',
    headStyles: {
      fillColor: [37, 99, 235],
      textColor: 255,
      fontStyle: 'bold',
      ...(autoTableOptions.headStyles || {})
    },
    alternateRowStyles: { fillColor: [245, 247, 250], ...(autoTableOptions.alternateRowStyles || {}) },
    columnStyles: { ...buildPdfColumnStyles(head[0] || []), ...(autoTableOptions.columnStyles || {}) },
    margin: { left: 40, right: 40, ...(autoTableOptions.margin || {}) },
    ...autoTableOptions,
    styles: layout.styles
  });

  doc.save(ensureExtension(filename, 'pdf'));
}

export async function buildAoaPdfFile(filename, {
  title = 'KCP Export',
  subtitle = '',
  rows = [],
  orientation = 'portrait',
  headerRowIndex = 0,
  branding = {},
  tableOptions = {}
} = {}) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);
  const autoTable = autoTableModule.default || autoTableModule.autoTable;
  const safeRows = Array.isArray(rows) ? rows : [];
  const head = [safeRows[headerRowIndex] || []];
  const doc = new jsPDF({ orientation: (head[0]?.length || 0) > 7 ? 'landscape' : orientation, unit: 'pt', format: 'a4' });
  const body = safeRows
    .filter((_, index) => index !== headerRowIndex)
    .map((row) => (Array.isArray(row) ? row : [row]));
  const { ruleColor, ...autoTableOptions } = tableOptions || {};
  const resolvedRuleColor = Array.isArray(ruleColor) && ruleColor.length >= 3 ? ruleColor : [37, 99, 235];

  const header = await renderPdfHeader(doc, { title, subtitle, branding });
  doc.setDrawColor(resolvedRuleColor[0], resolvedRuleColor[1], resolvedRuleColor[2]);
  doc.setLineWidth(1);
  doc.line(40, header.ruleY, doc.internal.pageSize.getWidth() - 40, header.ruleY);

  const headerCount = head[0]?.length || 0;
  const layout = pdfTableLayoutOptions(headerCount, autoTableOptions);
  autoTable(doc, {
    ...layout,
    head,
    body: body.map((row) => Array.isArray(row) ? row.map(pdfCellValue) : [pdfCellValue(row)]),
    startY: header.tableStartY,
    theme: 'grid',
    headStyles: {
      fillColor: [37, 99, 235],
      textColor: 255,
      fontStyle: 'bold',
      ...(autoTableOptions.headStyles || {})
    },
    alternateRowStyles: { fillColor: [245, 247, 250], ...(autoTableOptions.alternateRowStyles || {}) },
    columnStyles: { ...buildPdfColumnStyles(head[0] || []), ...(autoTableOptions.columnStyles || {}) },
    margin: { left: 40, right: 40, ...(autoTableOptions.margin || {}) },
    ...autoTableOptions,
    styles: layout.styles
  });

  const fileName = ensureExtension(filename, 'pdf');
  const blob = doc.output('blob');
  return new File([blob], sanitizeFilename(fileName), { type: 'application/pdf' });
}

export async function buildStructuredPdfFile(filename, {
  title = 'KCP Document',
  subtitle = '',
  branding = {},
  sections = [],
  tables = [],
  instruction = '',
  orientation = 'portrait'
} = {}) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);
  const autoTable = autoTableModule.default || autoTableModule.autoTable;
  const doc = new jsPDF({ orientation, unit: 'pt', format: 'a4' });
  const margin = 40;
  const pageWidth = doc.internal.pageSize.getWidth();
  const header = await renderPdfHeader(doc, { title, subtitle, branding });
  let cursorY = header.ruleY + 18;

  doc.setDrawColor(37, 99, 235);
  doc.setLineWidth(1);
  doc.line(margin, header.ruleY, pageWidth - margin, header.ruleY);

  const normalizedSections = (Array.isArray(sections) ? sections : []).filter(Boolean);
  if (normalizedSections.length) {
    const gap = 10;
    const cardWidth = (pageWidth - margin * 2 - gap) / Math.min(2, normalizedSections.length);
    normalizedSections.forEach((section, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = margin + column * (cardWidth + gap);
      const y = cursorY + row * 112;
      drawPdfInfoCard(doc, {
        x,
        y,
        width: cardWidth,
        title: section.title,
        rows: section.rows
      });
    });
    cursorY += Math.ceil(normalizedSections.length / 2) * 112 + 6;
  }

  (Array.isArray(tables) ? tables : []).filter(Boolean).forEach((table) => {
    const headers = Array.isArray(table.headers) ? table.headers : [];
    const body = (Array.isArray(table.rows) ? table.rows : []).map((row) => (
      Array.isArray(row) ? row : headers.map((header) => row?.[header] ?? '')
    ));
    if (table.title) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(37, 99, 235);
      doc.text(String(table.title).toUpperCase(), margin, cursorY);
      cursorY += 10;
    }
    autoTable(doc, {
      head: [headers],
      body,
      startY: cursorY,
      theme: 'grid',
      styles: {
        font: 'helvetica',
        fontSize: 8,
        cellPadding: 6,
        valign: 'middle',
        overflow: 'linebreak'
      },
      headStyles: {
        fillColor: [17, 24, 39],
        textColor: 255,
        fontStyle: 'bold'
      },
      alternateRowStyles: { fillColor: [245, 247, 250] },
      margin: { left: margin, right: margin },
      ...table.tableOptions
    });
    cursorY = (doc.lastAutoTable?.finalY || cursorY) + 18;
  });

  if (instruction) {
    const pageHeight = doc.internal.pageSize.getHeight();
    const lines = doc.splitTextToSize(String(instruction), pageWidth - margin * 2 - 24);
    const blockHeight = Math.max(58, lines.length * 11 + 30);
    if (cursorY + blockHeight > pageHeight - margin) {
      doc.addPage();
      cursorY = margin;
    }
    doc.setFillColor(239, 246, 255);
    doc.setDrawColor(191, 219, 254);
    doc.roundedRect(margin, cursorY, pageWidth - margin * 2, blockHeight, 8, 8, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(37, 99, 235);
    doc.text('INSTRUCTIONS', margin + 12, cursorY + 18);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(17, 24, 39);
    doc.text(lines, margin + 12, cursorY + 34);
  }

  const fileName = ensureExtension(filename, 'pdf');
  return new File([doc.output('blob')], sanitizeFilename(fileName), { type: 'application/pdf' });
}

function buildSupplierPoBusinessTaxLines(taxInfo = {}) {
  const registeredCompanyName = String(taxInfo.registeredCompanyName || '').trim();
  const tradingName = String(taxInfo.tradingName || '').trim();
  const address = String(taxInfo.registeredAddress || '').trim() || [
    taxInfo.registeredAddressLine1,
    taxInfo.registeredAddressLine2,
    taxInfo.suburb,
    taxInfo.city,
    taxInfo.province,
    taxInfo.postalCode,
    taxInfo.country
  ].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
  return [
    registeredCompanyName ? `Registered: ${registeredCompanyName}` : '',
    tradingName && tradingName.toLowerCase() !== registeredCompanyName.toLowerCase() ? `Trading as: ${tradingName}` : '',
    taxInfo.companyRegistrationNumber ? `Company Reg No: ${taxInfo.companyRegistrationNumber}` : '',
    taxInfo.vatNumber ? `VAT No: ${taxInfo.vatNumber}` : '',
    taxInfo.taxNumber ? `Tax No: ${taxInfo.taxNumber}` : '',
    address ? `Registered address: ${address}` : '',
    taxInfo.accountsContactEmail ? `Accounts: ${taxInfo.accountsContactEmail}` : ''
  ].filter(Boolean);
}

export async function buildSupplierPurchaseOrderPdfFile(filename, {
  branding = {},
  business = {},
  order = {},
  supplier = {},
  delivery = {},
  items = [],
  instruction = ''
} = {}) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);
  const autoTable = autoTableModule.default || autoTableModule.autoTable;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4', precision: 12 });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 48;
  const blue = [59, 130, 246];
  const ink = [17, 24, 39];
  const muted = [100, 116, 139];
  const border = [226, 232, 240];
  const logo = await resolvePdfLogo(branding.logoDataUrl);

  let businessX = margin;
  if (logo?.dataUrl) {
    const maxWidth = 92;
    const maxHeight = 64;
    const ratio = Math.min(maxWidth / logo.width, maxHeight / logo.height, 1);
    const width = logo.width * ratio;
    const height = logo.height * ratio;
    try {
      doc.addImage(logo.dataUrl, logo.format, margin, 42, width, height);
      businessX = margin + width + 14;
    } catch {
      businessX = margin;
    }
  }

  const titleRightEdge = pageWidth - 300;
  const businessTextWidth = Math.max(190, titleRightEdge - businessX);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  const businessNameLines = doc.splitTextToSize(String(business.name || branding.companyName || 'Kitchen Cost Pro'), businessTextWidth);
  doc.setTextColor(...ink);
  doc.text(businessNameLines, businessX, 66, { maxWidth: businessTextWidth, lineHeightFactor: 0.95 });

  const businessLines = [
    ...buildSupplierPoBusinessTaxLines(business.taxInfo || {}),
    business.address,
    business.email ? `Email: ${business.email}` : '',
    business.phone ? `Phone: ${business.phone}` : ''
  ].filter(Boolean);
  const businessInfoY = 66 + businessNameLines.length * 23 + 10;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  businessLines.forEach((line, index) => {
    doc.text(String(line), businessX, businessInfoY + index * 13, { maxWidth: Math.max(220, pageWidth - 300 - businessX) });
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(31);
  doc.setTextColor(...blue);
  doc.text('PURCHASE', pageWidth - margin, 75, { align: 'right' });
  doc.text('ORDER', pageWidth - margin, 113, { align: 'right' });

  const metaRows = [
    ['PO NO', order.poNumber || order.reference || ''],
    ['SUPPLIER', supplier.name || 'Unassigned Supplier'],
    ['DELIVER TO', delivery.location || 'Main Store']
  ];
  let metaY = 145;
  metaRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...muted);
    doc.text(`${label}:`, pageWidth - 268, metaY);
    doc.setFontSize(9);
    doc.setTextColor(...ink);
    doc.text(String(value || ''), pageWidth - 182, metaY, { maxWidth: 135 });
    metaY += value && String(value).length > 18 ? 24 : 20;
  });

  doc.setDrawColor(...border);
  doc.setLineWidth(1);
  const headerRuleY = Math.max(226, businessInfoY + businessLines.length * 13 + 22);
  doc.line(margin, headerRuleY, pageWidth - margin, headerRuleY);

  const sectionY = headerRuleY + 28;
  const leftSectionWidth = (pageWidth / 2) - margin - 24;
  const rightSectionX = pageWidth / 2 + 12;
  const rightSectionWidth = pageWidth - margin - rightSectionX;
  const supplierSectionEndY = drawSupplierPoSection(doc, {
    x: margin,
    y: sectionY,
    width: leftSectionWidth,
    title: 'SUPPLIER:',
    rows: [
      { text: supplier.name || 'Unassigned Supplier', bold: true },
      { text: supplier.accountNumber ? `Supplier account: ${supplier.accountNumber}` : '' },
      { text: supplier.contact ? `Contact: ${supplier.contact}` : '' },
      { text: supplier.vatNumber ? `VAT no: ${supplier.vatNumber}` : '' }
    ]
  });
  const deliverySectionEndY = drawSupplierPoSection(doc, {
    x: rightSectionX,
    y: sectionY,
    width: rightSectionWidth,
    title: 'DELIVERY / RECEIVING DESTINATION:',
    rows: [
      { text: delivery.name || delivery.location || business.name || branding.companyName || 'Kitchen Cost Pro', bold: true },
      { text: delivery.address ? `Address: ${delivery.address}` : '' },
      { text: delivery.contact ? `Receiving contact: ${delivery.contact}` : '' },
      { text: delivery.phone ? `Phone: ${delivery.phone}` : '' },
      { text: delivery.email ? `Email: ${delivery.email}` : '' },
      { text: delivery.receivingHours ? `Receiving hours: ${delivery.receivingHours}` : '' },
      { text: delivery.notes || '' },
      { text: delivery.supplierNotes ? `Supplier notes: ${delivery.supplierNotes}` : '' }
    ]
  });

  const pageHeight = doc.internal.pageSize.getHeight();
  let tableStartY = Math.max(supplierSectionEndY, deliverySectionEndY) + 28;
  if (tableStartY > pageHeight - 210) {
    doc.addPage();
    tableStartY = margin;
  }
  autoTable(doc, {
    head: [['ITEM DESCRIPTION', 'UNIT', 'PACK SIZE', 'QTY\nREQUIRED', 'SUPPLIER\nNOTES']],
    body: (Array.isArray(items) ? items : []).map((item) => [
      item.description || '',
      item.unit || '',
      item.packSize || '',
      item.quantity || '',
      item.notes || 'Confirm availability'
    ]),
    startY: tableStartY,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 9,
      cellPadding: { top: 12, right: 8, bottom: 12, left: 8 },
      textColor: [30, 41, 59],
      valign: 'middle',
      lineColor: border,
      lineWidth: 0.8
    },
    headStyles: {
      fillColor: ink,
      textColor: 255,
      fontStyle: 'bold',
      fontSize: 8.5,
      minCellHeight: 42
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 205 },
      1: { cellWidth: 64 },
      2: { cellWidth: 80 },
      3: { cellWidth: 90 },
      4: { cellWidth: pageWidth - margin * 2 - 439 }
    },
    margin: { left: margin, right: margin }
  });

  let blockY = (doc.lastAutoTable?.finalY || tableStartY + 80) + 22;
  const blockWidth = 294;
  const blockX = (pageWidth - blockWidth) / 2;
  const instructionText = instruction || 'Please confirm receipt of this purchase order. Any unavailable items, substitutions, pack-size changes, or quantity changes must be confirmed before delivery. Supply should match the listed unit, pack size, and quantity required.';
  const instructionLines = doc.splitTextToSize(instructionText, blockWidth - 34);
  const blockHeight = Math.max(118, instructionLines.length * 13 + 56);
  if (blockY + blockHeight > pageHeight - 48) {
    doc.addPage();
    blockY = 48;
  }
  doc.setFillColor(241, 245, 249);
  doc.setDrawColor(241, 245, 249);
  doc.rect(blockX, blockY, blockWidth, blockHeight, 'FD');
  doc.setDrawColor(...blue);
  doc.setLineWidth(4);
  doc.line(blockX - 14, blockY, blockX - 14, blockY + blockHeight);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...ink);
  doc.text('SUPPLIER CONFIRMATION REQUIRED', blockX + 18, blockY + 26);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  doc.text(instructionLines, blockX + 18, blockY + 60);

  doc.setDrawColor(...border);
  doc.setLineWidth(1);
  doc.line(margin, pageHeight - 40, pageWidth - margin, pageHeight - 40);

  const fileName = ensureExtension(filename, 'pdf');
  return new File([doc.output('blob')], sanitizeFilename(fileName), { type: 'application/pdf' });
}

function drawSupplierPoSection(doc, { x, y, width = 230, title = '', rows = [] } = {}) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(String(title || '').toUpperCase(), x, y, { maxWidth: width });
  let lineY = y + 24;
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const text = String(row?.text || '').trim();
    if (!text) return;
    doc.setFont('helvetica', row.bold ? 'bold' : 'normal');
    doc.setFontSize(row.bold ? 9.5 : 8.5);
    doc.setTextColor(17, 24, 39);
    const lineHeight = row.bold ? 12 : 11;
    const lines = doc.splitTextToSize(text, width);
    doc.text(lines, x, lineY, { maxWidth: width, lineHeightFactor: 1.15 });
    lineY += Math.max(1, lines.length) * lineHeight + 2;
  });
  return lineY;
}

function drawPdfInfoCard(doc, { x, y, width, title = '', rows = [] } = {}) {
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(x, y, width, 96, 8, 8, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(37, 99, 235);
  doc.text(String(title || '').toUpperCase(), x + 10, y + 16, { maxWidth: width - 20 });

  let lineY = y + 32;
  (Array.isArray(rows) ? rows : []).slice(0, 5).forEach((row) => {
    if (!row) return;
    const label = Array.isArray(row) ? row[0] : row.label;
    const value = Array.isArray(row) ? row[1] : row.value;
    if (!String(value ?? '').trim()) return;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(91, 111, 137);
    doc.text(`${label}:`, x + 10, lineY, { maxWidth: 72 });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(17, 24, 39);
    doc.text(String(value ?? ''), x + 84, lineY, { maxWidth: width - 94 });
    lineY += 12;
  });
}

async function renderPdfHeader(doc, { title = 'KCP Export', subtitle = '', branding = {} } = {}) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const logo = await resolvePdfLogo(branding.logoDataUrl);
  let textRight = pageWidth - 40;

  if (logo?.dataUrl) {
    const maxWidth = 94;
    const maxHeight = 58;
    const ratio = Math.min(maxWidth / logo.width, maxHeight / logo.height, 1);
    const width = logo.width * ratio;
    const height = logo.height * ratio;
    const x = pageWidth - 40 - width;
    const y = 24;
    try {
      doc.addImage(logo.dataUrl, logo.format, x, y, width, height);
      textRight = x - 18;
    } catch {
      textRight = pageWidth - 40;
    }
  }

  const textWidth = Math.max(220, textRight - 40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(17, 24, 39);
  doc.text(String(title || 'KCP Export'), 40, 46, { maxWidth: textWidth });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(91, 111, 137);
  if (subtitle) doc.text(String(subtitle), 40, 64, { maxWidth: textWidth });
  if (branding.companyName) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(91, 111, 137);
    doc.text(String(branding.companyName), 40, subtitle ? 78 : 64, { maxWidth: textWidth });
  }

  const hasBrandLine = Boolean(branding.companyName);
  const ruleY = subtitle && hasBrandLine ? 92 : subtitle ? 78 : hasBrandLine ? 78 : 68;
  return {
    ruleY,
    summaryStartY: ruleY + 16,
    tableStartY: ruleY + 26
  };
}

async function resolvePdfLogo(logoDataUrl = '') {
  const value = String(logoDataUrl || '').trim();
  if (!value || !value.startsWith('data:image/')) return null;
  const mime = value.slice(5, value.indexOf(';')).toLowerCase();
  const image = await loadImage(value).catch(() => null);
  if (!image) return null;

  if (mime.includes('png')) return { dataUrl: value, format: 'PNG', width: image.width || 1, height: image.height || 1 };
  if (mime.includes('jpeg') || mime.includes('jpg')) return { dataUrl: value, format: 'JPEG', width: image.width || 1, height: image.height || 1 };

  if (mime.includes('svg') || mime.includes('webp')) {
    const canvas = document.createElement('canvas');
    const scale = 4;
    canvas.width = Math.max(1, Math.round((image.width || 160) * scale));
    canvas.height = Math.max(1, Math.round((image.height || 90) * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      dataUrl: canvas.toDataURL('image/png'),
      format: 'PNG',
      width: image.width || canvas.width,
      height: image.height || canvas.height
    };
  }

  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

export function toCsv(rows = []) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (!normalizedRows.length) return '';

  const headers = getHeaders(normalizedRows);
  const lines = [
    headers.map(escapeCsvField).join(','),
    ...normalizedRows.map((row) => headers.map((header) => escapeCsvField(row?.[header] ?? '')).join(','))
  ];

  return lines.join('\r\n');
}

function parseCsvRows(text) {
  const delimiter = detectCsvDelimiter(text);
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(field);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => String(value).trim())) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => String(header || '').trim());
  return rows.map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index] ?? ''])
  ));
}

function detectCsvDelimiter(text = '') {
  const candidates = [',', ';', '\t'];
  const firstRows = [];
  let row = '';
  let inQuotes = false;

  for (let index = 0; index < text.length && firstRows.length < 5; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];
    if (char === '"' && inQuotes && nextChar === '"') {
      row += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      if (row.trim()) firstRows.push(row);
      row = '';
      continue;
    }
    row += char;
  }
  if (row.trim()) firstRows.push(row);

  const score = (delimiter) => firstRows.reduce((sum, line) => {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const nextChar = line[index + 1];
      if (char === '"' && quoted && nextChar === '"') {
        index += 1;
        continue;
      }
      if (char === '"') {
        quoted = !quoted;
        continue;
      }
      if (char === delimiter && !quoted) count += 1;
    }
    return sum + count;
  }, 0);

  return candidates
    .map((delimiter) => ({ delimiter, score: score(delimiter) }))
    .sort((left, right) => right.score - left.score)[0]?.delimiter || ',';
}

async function readExcelWorkbook(file) {
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  return {
    ...workbook,
    utils: XLSX.utils
  };
}

function getHeaders(rows) {
  const headerSet = new Set();
  rows.forEach((row) => {
    Object.keys(row || {}).forEach((key) => headerSet.add(key));
  });
  return [...headerSet];
}

function escapeCsvField(value) {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadBlob(filename, body, type) {
  const blob = new Blob([body], { type });
  downloadFileBlob(blob, filename);
}

export function downloadFileBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeFilename(filename);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function ensureExtension(filename = 'kcp-export', extension) {
  const safe = String(filename || 'kcp-export').trim() || 'kcp-export';
  return new RegExp(`\\.${extension}$`, 'i').test(safe) ? safe : `${safe}.${extension}`;
}

function sanitizeFilename(filename) {
  return String(filename || 'kcp-export.csv').replace(/[<>:"/\\|?*]+/g, '-');
}

function sanitizeSheetName(name = 'Export') {
  return String(name || 'Export').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Export';
}
