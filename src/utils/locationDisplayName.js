const DEFAULT_LOCATION_LABEL = 'Main Store';

export function normalizeLocationReference(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isTechnicalLocationLabel(value = '', identifiers = []) {
  const label = String(value || '').trim();
  if (!label) return true;

  const normalized = normalizeLocationReference(label);
  if (!normalized) return true;

  const identifierKeys = identifiers
    .map(normalizeLocationReference)
    .filter(Boolean);
  if (identifierKeys.includes(normalized)) return true;

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(label)) return true;
  if (/^(loc|location)[_-][a-z0-9][a-z0-9_-]{7,}$/i.test(label)) return true;
  if (/^ws[_-][a-z0-9][a-z0-9_-]{7,}$/i.test(label)) return true;

  return false;
}

export function isDefaultLocationRecord(location = {}) {
  const identifiers = [
    location.id,
    location.locationId,
    location.location_id
  ].map(normalizeLocationReference).filter(Boolean);
  const names = [
    location.displayName,
    location.display_name,
    location.name,
    location.locationName,
    location.location_name
  ].map(normalizeLocationReference).filter(Boolean);

  return location.isDefault === true ||
    location.is_default === true ||
    Number(location.isDefault ?? location.is_default ?? 0) === 1 ||
    identifiers.some((value) => value === 'main' || value === 'locmain' || value.endsWith('main')) ||
    names.some((value) => ['mainstore', 'mainstorage', 'defaultlocation'].includes(value));
}

export function resolveLocationDisplayName(location = {}, fallback = 'Location') {
  const identifiers = [
    location.id,
    location.locationId,
    location.location_id,
    location.externalLocationId,
    location.external_location_id,
    location.yocoLocationId,
    location.yocoStoreLocationId
  ].filter(Boolean);

  const raw = parseObject(location.raw || location.rawJson || location.raw_json);
  const candidates = [
    location.displayName,
    location.display_name,
    location.customName,
    location.custom_name,
    location.locationName,
    location.location_name,
    location.name,
    location.externalName,
    location.external_name,
    location.yocoLocationName,
    location.label,
    location.title,
    raw.displayName,
    raw.display_name,
    raw.customName,
    raw.custom_name,
    raw.locationName,
    raw.location_name,
    raw.name,
    raw.externalName,
    raw.external_name,
    raw.yocoLocationName
  ];

  for (const candidate of candidates) {
    const label = String(candidate || '').trim();
    if (!label || isTechnicalLocationLabel(label, identifiers)) continue;
    return label;
  }

  if (isDefaultLocationRecord({ ...raw, ...location })) return DEFAULT_LOCATION_LABEL;

  const safeFallback = String(fallback || '').trim();
  return safeFallback && !isTechnicalLocationLabel(safeFallback, identifiers)
    ? safeFallback
    : 'Location';
}

export function buildLocationNameIndex(locations = []) {
  const byReference = new Map();
  const records = [];

  for (const source of Array.isArray(locations) ? locations : []) {
    if (!source || typeof source !== 'object') continue;
    const name = resolveLocationDisplayName(source);
    const record = { ...source, name, displayName: name };
    records.push(record);

    const references = [
      source.id,
      source.locationId,
      source.location_id,
      source.externalLocationId,
      source.external_location_id,
      source.yocoLocationId,
      source.yocoStoreLocationId,
      source.name,
      source.displayName,
      source.display_name,
      source.externalName,
      source.external_name,
      name
    ];

    for (const reference of references) {
      const exact = String(reference || '').trim();
      if (exact && !byReference.has(exact)) byReference.set(exact, record);
      const normalized = normalizeLocationReference(exact);
      if (normalized && !byReference.has(normalized)) byReference.set(normalized, record);
    }
  }

  return { byReference, records };
}

export function resolveLocationNameByReference(reference = '', locations = [], fallback = 'Location') {
  const { byReference } = buildLocationNameIndex(locations);
  const exact = String(reference || '').trim();
  const match = byReference.get(exact) || byReference.get(normalizeLocationReference(exact));
  if (match) return match.name;

  const candidate = resolveLocationDisplayName({ id: exact, name: exact }, fallback);
  return candidate;
}

export function mergeCanonicalLocations(...collections) {
  const merged = new Map();
  for (const source of collections.flatMap((value) => Array.isArray(value) ? value : [])) {
    if (!source || typeof source !== 'object') continue;
    const id = String(source.id || source.locationId || source.location_id || '').trim();
    if (!id) continue;
    const current = merged.get(id);
    const combined = { ...current, ...source, id, locationId: id };
    const name = resolveLocationDisplayName(combined);
    merged.set(id, { ...combined, name, displayName: name });
  }
  return [...merged.values()];
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export { DEFAULT_LOCATION_LABEL };
