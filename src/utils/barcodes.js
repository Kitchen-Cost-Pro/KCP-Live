const BARCODE_OBJECT_KEYS = ['barcodes', 'barcode', 'Barcodes', 'Barcode', 'value', 'code', 'ean', 'EAN', 'upc', 'UPC', 'gtin', 'GTIN', 'text', 'label'];

export function parseBarcodeValues(value) {
  return [...new Set(flattenBarcodeValues(value).filter(Boolean))];
}

export function getBarcodeTokens(value) {
  return parseBarcodeValues(value)
    .map((barcode) => barcode.toLowerCase())
    .filter(Boolean);
}

export function matchesBarcodeQuery(value, query) {
  const needle = normalizeBarcodeValue(query).toLowerCase();
  if (!needle) return false;
  return getBarcodeTokens(value).some((barcode) => barcode === needle || barcode.includes(needle));
}

function flattenBarcodeValues(value, seen = new Set()) {
  if (value === undefined || value === null || value === '') return [];

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
      .split(/[\n,;]+/)
      .map(normalizeBarcodeValue)
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenBarcodeValues(entry, seen));
  }

  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const prioritizedValues = BARCODE_OBJECT_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .flatMap((key) => flattenBarcodeValues(value[key], seen));

  if (prioritizedValues.length) return prioritizedValues;

  const fallbackValues = Object.entries(value)
    .filter(([key]) => !BARCODE_OBJECT_KEYS.includes(key))
    .flatMap(([, entry]) => (
      entry && typeof entry === 'object'
        ? flattenBarcodeValues(entry, seen)
        : []
    ));

  return [...prioritizedValues, ...fallbackValues];
}

function normalizeBarcodeValue(value) {
  return String(value || '').trim();
}
