import type { Env } from '../../legacy/types';
import { text } from './config';
import { fetchXeroTrackingCategories } from './api-client';
import { recordXeroDiagnosticIfNotable } from './observability';

export interface LocationTrackingContext {
  categoryId: string;
  optionIdByLowerName: Map<string, string>;
  // Dedupes the "no matching option" diagnostic across many lines in the SAME sync run — a GRV
  // with 20 lines at one unmatched location should log once, not 20 times.
  loggedMisses: Set<string>;
}

/**
 * Loaded ONCE per sync run (not per line/document) to avoid a Xero API call per line — the full
 * option list rarely changes within a single daily push. Returns null when tracking isn't
 * configured (no category chosen in settings) or the configured category no longer exists in
 * Xero (e.g. deleted there after being selected) — either way, callers simply push without
 * tracking rather than failing the whole document.
 */
export async function loadLocationTrackingContext(env: Env, workspaceId: string, categoryId: string): Promise<LocationTrackingContext | null> {
  if (!categoryId) return null;
  const categories = await fetchXeroTrackingCategories(env, workspaceId);
  const category = categories.find((entry) => entry.id === categoryId);
  if (!category) return null;
  const optionIdByLowerName = new Map(category.options.map((option) => [option.name.toLowerCase(), option.id] as const));
  return { categoryId, optionIdByLowerName, loggedMisses: new Set() };
}

/**
 * Matches a KCP location's name to an existing Xero Tracking Option by exact (case-insensitive)
 * name — Xero has no "create the option on the fly while pushing a document" API, and an
 * unrecognised Name/Option pair on a LineItem is silently DROPPED by Xero, not rejected, so
 * guessing at an option is worse than just omitting tracking. A location with no matching option
 * is left untracked on that line, logged once per sync run so the mismatch is actually visible
 * (Xero itself gives no signal that anything was dropped).
 */
export async function resolveLocationTracking(
  env: Env,
  workspaceId: string,
  context: LocationTrackingContext | null,
  locationName: string | null | undefined
): Promise<Array<{ TrackingCategoryID: string; TrackingOptionID: string }> | undefined> {
  if (!context) return undefined;
  const name = text(locationName);
  if (!name) return undefined;
  const optionId = context.optionIdByLowerName.get(name.toLowerCase());
  if (!optionId) {
    if (!context.loggedMisses.has(name)) {
      context.loggedMisses.add(name);
      await recordXeroDiagnosticIfNotable(env, workspaceId, {
        operation: 'xero-location-tracking',
        status: 'warning',
        message: `No Xero Tracking Option matches KCP location "${name}" — pushed without location tracking on that line. Add a matching option in Xero (or rename the location) to fix.`,
        details: { locationName: name }
      });
    }
    return undefined;
  }
  return [{ TrackingCategoryID: context.categoryId, TrackingOptionID: optionId }];
}
