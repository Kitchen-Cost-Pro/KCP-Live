function normalizeLinkToken(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^product:/, '')
    .replace(/^modifier:/, '')
    .replace(/\s+/g, ' ');
}

export function resolveModifierLinkedItems(item = {}, menuItems = []) {
  // linkedItem* represents menu items that actually have the modifier group
  // assigned. linkedProduct* represents the product or recipe consumed by a
  // product modifier. They are different relationships and must not be merged.
  const assignedIds = (Array.isArray(item.linkedItemIds) ? item.linkedItemIds : [])
    .map(String)
    .filter(Boolean);
  const assignedNames = (Array.isArray(item.linkedItemNames) ? item.linkedItemNames : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const useAssignedItems = assignedIds.length > 0 || assignedNames.length > 0;
  const ids = [...new Set((useAssignedItems
    ? assignedIds
    : Array.isArray(item.linkedProductIds) ? item.linkedProductIds : [])
    .map(String)
    .filter(Boolean))];
  const names = [...new Set((useAssignedItems
    ? assignedNames
    : Array.isArray(item.linkedProductNames) ? item.linkedProductNames : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  const byId = new Map((menuItems || []).map((entry) => [String(entry.id || ''), entry]));
  const byName = new Map((menuItems || []).map((entry) => [normalizeLinkToken(entry.name), entry]));
  const resolved = [];
  const seen = new Set();

  for (const id of ids) {
    const match = byId.get(id);
    if (!match && useAssignedItems) continue;
    const name = String(match?.name || id).trim();
    const key = normalizeLinkToken(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    resolved.push({ name, category: match?.category || 'Menu item' });
  }

  for (const name of names) {
    const match = byName.get(normalizeLinkToken(name));
    const displayName = String(match?.name || name).trim();
    const key = normalizeLinkToken(displayName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    resolved.push({ name: displayName, category: match?.category || 'Menu item' });
  }

  return resolved.sort((left, right) => left.name.localeCompare(right.name));
}
