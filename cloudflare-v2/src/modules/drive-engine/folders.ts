import type { Env } from '../../legacy/types';
import { findOrCreateFolder } from './drive-client';
import { getDriveConnection, saveDriveRootFolderId } from './connection';

export interface LocationFolderIds {
  locationId: string;
  grvsFolderId: string;
  creditNotesFolderId: string;
  inboxFolderId: string;
  processedFolderId: string;
}

/** Ensures `KCP Documents / {Location Name} / {GRVs,Credit Notes,Invoices/Inbox,Invoices/Processed}`
 * exists in the connected Drive for one location, creating anything missing. Idempotent —
 * findOrCreateFolder searches before creating, so calling this repeatedly (e.g. once per push) is
 * safe and cheap once the tree already exists. */
export async function ensureLocationFolders(env: Env, workspaceId: string, locationId: string, locationName: string): Promise<LocationFolderIds> {
  const connection = await getDriveConnection(env, workspaceId);
  let rootFolderId = connection?.root_folder_id || '';
  if (!rootFolderId) {
    rootFolderId = await findOrCreateFolder(env, workspaceId, 'KCP Documents', null);
    await saveDriveRootFolderId(env, workspaceId, rootFolderId);
  }
  const locationFolderId = await findOrCreateFolder(env, workspaceId, locationName || 'Default Location', rootFolderId);
  const [grvsFolderId, creditNotesFolderId, invoicesFolderId] = await Promise.all([
    findOrCreateFolder(env, workspaceId, 'GRVs', locationFolderId),
    findOrCreateFolder(env, workspaceId, 'Credit Notes', locationFolderId),
    findOrCreateFolder(env, workspaceId, 'Invoices', locationFolderId)
  ]);
  const [inboxFolderId, processedFolderId] = await Promise.all([
    findOrCreateFolder(env, workspaceId, 'Inbox', invoicesFolderId),
    findOrCreateFolder(env, workspaceId, 'Processed', invoicesFolderId)
  ]);
  return { locationId, grvsFolderId, creditNotesFolderId, inboxFolderId, processedFolderId };
}

interface LocationRow {
  id: string;
  name: string;
}

export async function listActiveLocations(env: Env, workspaceId: string): Promise<LocationRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, name FROM locations WHERE workspace_id = ?1 AND active = 1 ORDER BY name ASC`
  ).bind(workspaceId).all<LocationRow>();
  return result.results || [];
}
