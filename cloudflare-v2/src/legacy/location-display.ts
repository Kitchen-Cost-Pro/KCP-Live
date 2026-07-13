import type { Env } from './types';

type LocationRow = Record<string, unknown>;

const REPAIR_TTL_MS = 5 * 60 * 1000;
const repairedAtByWorkspace = new Map<string, number>();
const repairPromiseByWorkspace = new Map<string, Promise<void>>();

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function normalize(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDefaultLocation(row: LocationRow): boolean {
  const id = normalize(row.id || row.location_id || row.locationId);
  const name = normalize(row.display_name || row.displayName || row.name);
  return Number(row.is_default || row.isDefault || 0) === 1 ||
    id === 'main' ||
    id === 'locmain' ||
    id.endsWith('main') ||
    name === 'mainstore' ||
    name === 'mainstorage';
}

function isUsableName(value: unknown, id: unknown): boolean {
  const label = text(value);
  if (!label) return false;
  if (normalize(label) === normalize(id)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(label)) return false;
  if (/^(loc|location)[_-][a-z0-9][a-z0-9_-]{7,}$/i.test(label)) return false;
  return true;
}

export function resolveLocationDisplayName(row: LocationRow = {}): string {
  const id = row.id || row.location_id || row.locationId;
  const raw = parseObject(row.raw_json || row.rawJson || row.raw);
  const candidates = [
    row.display_name,
    row.displayName,
    row.custom_name,
    row.customName,
    row.location_name,
    row.locationName,
    row.name,
    row.external_name,
    row.externalName,
    row.yocoLocationName,
    raw.display_name,
    raw.displayName,
    raw.custom_name,
    raw.customName,
    raw.location_name,
    raw.locationName,
    raw.name,
    raw.external_name,
    raw.externalName,
    raw.yocoLocationName
  ];

  for (const candidate of candidates) {
    if (isUsableName(candidate, id)) return text(candidate);
  }

  return isDefaultLocation(row) ? 'Main Store' : 'Location';
}

export async function ensureWorkspaceLocationNames(env: Env, workspaceId: string): Promise<void> {
  const key = text(workspaceId);
  if (!key) return;

  const inFlight = repairPromiseByWorkspace.get(key);
  if (inFlight) return inFlight;

  const lastRepair = repairedAtByWorkspace.get(key) || 0;
  if (Date.now() - lastRepair < REPAIR_TTL_MS) return;

  const repair = (async () => {
    const rows = await env.DB.prepare(
      `SELECT id, name, display_name, external_name, is_default, raw_json
         FROM locations
        WHERE workspace_id = ?1 AND COALESCE(active, 1) = 1`
    ).bind(key).all<LocationRow>();

    const statements = [];
    for (const row of rows.results || []) {
      const id = text(row.id);
      if (!id) continue;

      const currentName = text(row.name);
      const currentDisplayName = text(row.display_name);
      const resolvedName = resolveLocationDisplayName(row);
      const nameNeedsRepair = !isUsableName(currentName, id);
      const displayNeedsRepair = !isUsableName(currentDisplayName, id);

      if (resolvedName === 'Location' || (!nameNeedsRepair && !displayNeedsRepair)) continue;

      statements.push(env.DB.prepare(
        `UPDATE locations
            SET name = CASE WHEN ?3 = 1 THEN ?4 ELSE name END,
                display_name = CASE WHEN ?5 = 1 THEN ?4 ELSE display_name END,
                updated_at = datetime('now')
          WHERE workspace_id = ?1 AND id = ?2`
      ).bind(
        key,
        id,
        nameNeedsRepair ? 1 : 0,
        resolvedName,
        displayNeedsRepair ? 1 : 0
      ));
    }

    if (statements.length) await env.DB.batch(statements);
    repairedAtByWorkspace.set(key, Date.now());
  })().catch(() => {
    repairedAtByWorkspace.delete(key);
  }).finally(() => {
    repairPromiseByWorkspace.delete(key);
  });

  repairPromiseByWorkspace.set(key, repair);
  return repair;
}

function parseObject(value: unknown): LocationRow {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as LocationRow;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as LocationRow
      : {};
  } catch {
    return {};
  }
}
