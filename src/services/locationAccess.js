import { isSuperUserRoleName, normalizeRoleName } from './roleService.js';

const UNRESTRICTED_WORKSPACE_ROLES = new Set(['owner', 'admin']);

export function normalizeLocationAccessKey(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function dedupeLocations(locations = []) {
  const byId = new Map();
  const byName = new Map();
  const output = [];

  for (const raw of Array.isArray(locations) ? locations : []) {
    if (!raw || typeof raw !== 'object' || raw.active === false) continue;
    const id = String(raw.id || raw.locationId || raw.location_id || raw.value || '').trim();
    const name = String(raw.displayName || raw.display_name || raw.name || raw.locationName || raw.label || id).trim();
    if (!id && !name) continue;
    const idKey = normalizeLocationAccessKey(id);
    const nameKey = normalizeLocationAccessKey(name);
    if ((idKey && byId.has(idKey)) || (nameKey && byName.has(nameKey))) continue;

    const location = {
      ...raw,
      id: id || name,
      locationId: id || name,
      name: name || id,
      displayName: name || id,
    };
    output.push(location);
    if (idKey) byId.set(idKey, location);
    if (nameKey) byName.set(nameKey, location);
  }

  return output.sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

export function resolveEffectiveLocationIds(access = {}) {
  const role = normalizeRoleName(access.currentRole || '');
  if (
    access.currentIsSuperUser === true ||
    access.currentIsKcpSuperUser === true ||
    isSuperUserRoleName(role) ||
    UNRESTRICTED_WORKSPACE_ROLES.has(role)
  ) {
    return null;
  }

  const roleLocations = normalizeLocationList(
    access.roleDefinition?.locations || access.currentRoleDefinition?.locations || [],
  );
  const userLocations = normalizeLocationList(access.currentUserLocations || []);

  if (roleLocations.includes('all') && userLocations.includes('all')) return null;
  if (userLocations.includes('all')) {
    return roleLocations.includes('all') || !roleLocations.length
      ? null
      : roleLocations;
  }
  if (roleLocations.includes('all')) return userLocations;
  if (!roleLocations.length || !userLocations.length) return [];
  const userSet = new Set(userLocations.map(normalizeLocationAccessKey));
  return roleLocations.filter((value) => userSet.has(normalizeLocationAccessKey(value)));
}

export function filterLocationsByAccess(locations = [], access = {}) {
  const deduped = dedupeLocations(locations);
  if (String(access.status || '').toLowerCase() && String(access.status || '').toLowerCase() !== 'ready') {
    return deduped;
  }
  const allowed = resolveEffectiveLocationIds(access);
  if (allowed === null) return deduped;
  const keys = new Set(allowed.map(normalizeLocationAccessKey).filter(Boolean));
  if (!keys.size) return [];
  return deduped.filter((location) => locationMatchesAccessKeys(location, keys));
}

export function getAccessibleLocationOptions(locations = [], access = {}, { sellingOnly = false } = {}) {
  const filtered = filterLocationsByAccess(locations, access).filter((location) => {
    if (!sellingOnly) return true;
    const type = String(location.kind || location.type || location.locationType || 'selling').trim().toLowerCase();
    return type === 'selling' || type === 'sale' || type === 'sales' || type === '';
  });
  return filtered.map((location) => ({
    value: String(location.id || location.locationId || '').trim(),
    label: String(location.displayName || location.name || location.locationName || location.id || '').trim(),
  })).filter((option) => option.value);
}

function locationMatchesAccessKeys(location = {}, keys = new Set()) {
  return [
    location.id,
    location.locationId,
    location.location_id,
    location.name,
    location.displayName,
    location.display_name,
    location.locationName,
  ]
    .map(normalizeLocationAccessKey)
    .filter(Boolean)
    .some((value) => keys.has(value));
}

function normalizeLocationList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase() === 'all' ? 'all' : value))];
}
