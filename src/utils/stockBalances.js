export function normalizeLocationKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function sumBalances(balances = {}) {
  return Object.values(balances || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

export function getLocationCandidates(locationId = '', locations = []) {
  const key = String(locationId || '').trim();
  const candidates = [key];
  const list = Array.isArray(locations) ? locations : [locations];
  const normalizedKey = normalizeLocationKey(key);

  list
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => {
      const values = [
        entry.id,
        entry.locationId,
        entry.value,
        entry.name,
        entry.displayName,
        entry.label,
        entry.yocoLocationId,
        entry.yocoStoreLocationId
      ];
      return values.some((value) => String(value || '').trim() === key || normalizeLocationKey(value) === normalizedKey);
    })
    .forEach((entry) => {
      candidates.push(
        entry.id,
        entry.locationId,
        entry.value,
        entry.name,
        entry.displayName,
        entry.label,
        entry.yocoLocationId,
        entry.yocoStoreLocationId
      );
      if (isDefaultLocation(entry)) {
        candidates.push('main', 'default', 'Main Store', 'Main Storage', 'Main Location');
      }
    });

  if (!Array.isArray(locations) && typeof locations === 'string') candidates.push(locations);
  return [...new Set(candidates.map((value) => String(value || '').trim()).filter(Boolean))];
}

export function resolveBalanceKey(balances = {}, locationId = '', locations = []) {
  const candidates = getLocationCandidates(locationId, locations);
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(balances, candidate)) return candidate;
  }

  const normalizedCandidates = new Set(candidates.map(normalizeLocationKey).filter(Boolean));
  const match = Object.keys(balances || {}).find((balanceKey) => normalizedCandidates.has(normalizeLocationKey(balanceKey)));
  return match || String(locationId || candidates[0] || '').trim();
}

export function seedStockBalanceIfNeeded(balances = {}, item = {}, locationId = '', locations = []) {
  const key = resolveBalanceKey(balances, locationId, locations);
  const stock = Number(item.stock || 0) || 0;
  const balanceKeys = Object.keys(balances || {});
  const balanceTotal = sumBalances(balances);
  if (
    key &&
    !Object.prototype.hasOwnProperty.call(balances, key) &&
    balanceKeys.length === 1 &&
    isDefaultLocation(getLocationById(locationId, locations)) &&
    isLegacyDefaultBalanceKey(balanceKeys[0]) &&
    stock &&
    Math.abs(stock - balanceTotal) < 0.0001
  ) {
    const legacyKey = balanceKeys[0];
    balances[key] = Number(balances[legacyKey] || 0) || 0;
    delete balances[legacyKey];
    return key;
  }
  if (key && stock > balanceTotal) {
    balances[key] = (Number(balances[key] || 0) || 0) + (stock - balanceTotal);
  }
  return key;
}

export function getLocationStock(item = {}, locationId = '', locations = []) {
  if (!item) return 0;
  const balances = item.balances && typeof item.balances === 'object' ? item.balances : {};
  const balanceKeys = Object.keys(balances);
  const itemStock = Number(item.stock || 0) || 0;
  const key = String(locationId || '').trim();
  if (!key) return itemStock || sumBalances(balances);
  if (!balanceKeys.length) return itemStock;

  const balanceKey = resolveBalanceKey(balances, key, locations);
  if (balanceKey && Object.prototype.hasOwnProperty.call(balances, balanceKey)) {
    return Number(balances[balanceKey] || 0) || 0;
  }

  const balanceTotal = sumBalances(balances);
  if (itemStock && !balanceTotal) {
    return itemStock;
  }
  return 0;
}

export function hasLocationStock(item = {}, locationId = '', locations = []) {
  if (!locationId) return true;
  const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
  const balanceKey = resolveBalanceKey(balances, locationId, locations);
  if (balanceKey && Object.prototype.hasOwnProperty.call(balances, balanceKey)) return true;
  return getLocationStock(item, locationId, locations) !== 0;
}

function getLocationById(locationId = '', locations = []) {
  const key = String(locationId || '').trim();
  const normalizedKey = normalizeLocationKey(key);
  return (Array.isArray(locations) ? locations : [locations])
    .filter((entry) => entry && typeof entry === 'object')
    .find((entry) => [
      entry.id,
      entry.locationId,
      entry.value,
      entry.name,
      entry.displayName,
      entry.label,
      entry.yocoLocationId,
      entry.yocoStoreLocationId
    ].some((value) => String(value || '').trim() === key || normalizeLocationKey(value) === normalizedKey)) || null;
}

function isDefaultLocation(location = {}) {
  if (!location || typeof location !== 'object') return false;
  return location.isDefault === true ||
    location.default === true ||
    normalizeLocationKey(location.id || location.locationId || location.value) === 'main' ||
    normalizeLocationKey(location.name || location.displayName || location.label) === 'mainstore' ||
    normalizeLocationKey(location.name || location.displayName || location.label) === 'mainstorage' ||
    normalizeLocationKey(location.name || location.displayName || location.label) === 'mainlocation';
}

function isLegacyDefaultBalanceKey(value = '') {
  return ['main', 'default', 'mainstore', 'mainstorage', 'mainlocation'].includes(normalizeLocationKey(value));
}
