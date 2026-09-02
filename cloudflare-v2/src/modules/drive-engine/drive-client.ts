import type { Env } from '../../legacy/types';
import { loadValidDriveAccessToken } from './connection';
import { text } from './config';

export class DriveApiClientError extends Error {}

async function driveFetch(env: Env, workspaceId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const { accessToken } = await loadValidDriveAccessToken(env, workspaceId);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new DriveApiClientError(`Google Drive request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return response;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  thumbnailLink?: string;
  createdTime?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Idempotent: searches for an existing, non-trashed folder with this name under `parentId` first
 * (Drive allows duplicate folder names, so a naive create-every-time would multiply folders on
 * every reconnect/retry), creating one only if none is found. */
export async function findOrCreateFolder(env: Env, workspaceId: string, name: string, parentId: string | null): Promise<string> {
  const parentClause = parentId ? ` and '${parentId}' in parents` : ` and 'root' in parents`;
  const q = encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='${name.replace(/'/g, "\\'")}' and trashed=false${parentClause}`);
  const searchResponse = await driveFetch(env, workspaceId, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
  const searchResult = (await searchResponse.json()) as { files?: DriveFile[] };
  const existing = searchResult.files?.[0];
  if (existing) return existing.id;

  const createResponse = await driveFetch(env, workspaceId, `https://www.googleapis.com/drive/v3/files?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined })
  });
  const created = (await createResponse.json()) as { id: string };
  return created.id;
}

/** Multipart upload of raw bytes (e.g. a generated PDF) — matches executeXeroBinaryPutRequest's
 * bytes-in signature in modules/xero-engine/api-client.ts so callers can reuse the same
 * grvToPdfBytes()/creditNoteToPdfBytes() output with no conversion step. */
export async function uploadFile(
  env: Env,
  workspaceId: string,
  input: { name: string; parentId: string; bytes: Uint8Array; mimeType: string; appProperties?: Record<string, string> }
): Promise<{ id: string }> {
  const boundary = `kcp-drive-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: input.name, parents: [input.parentId], appProperties: input.appProperties });
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [
    encoder.encode(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    encoder.encode(`--${boundary}\r\ncontent-type: ${input.mimeType}\r\n\r\n`),
    input.bytes,
    encoder.encode(`\r\n--${boundary}--`)
  ];
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  const response = await driveFetch(
    env,
    workspaceId,
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
    { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: body.slice().buffer }
  );
  return (await response.json()) as { id: string };
}

/** Lists non-trashed files directly under `folderId`, newest first — used by the GRV Assistant's
 * Inbox picker. Filters out anything already tagged kcp_status=processed so a processed invoice
 * silently drops out on the next listing without a separate move having to happen first. */
export async function listFolderFiles(env: Env, workspaceId: string, folderId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and not appProperties has { key='kcp_status' and value='processed' }`);
  const fields = encodeURIComponent('files(id,name,mimeType,thumbnailLink,createdTime,appProperties)');
  const response = await driveFetch(
    env,
    workspaceId,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=createdTime desc&spaces=drive&pageSize=50`
  );
  const result = (await response.json()) as { files?: DriveFile[] };
  return result.files || [];
}

export async function getFileBytes(env: Env, workspaceId: string, fileId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const metaResponse = await driveFetch(env, workspaceId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=mimeType`);
  const meta = (await metaResponse.json()) as { mimeType: string };
  const mediaResponse = await driveFetch(env, workspaceId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
  const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
  return { bytes, mimeType: text(meta.mimeType) || 'application/octet-stream' };
}

/** Tags a file with custom key/value metadata (used to mark kcp_status=processed / kcp_grv_id) and
 * optionally moves it between folders in the same call — Drive's files.update takes addParents/
 * removeParents as query params rather than body fields for a move. */
export async function updateFile(
  env: Env,
  workspaceId: string,
  fileId: string,
  input: { appProperties?: Record<string, string>; addParentId?: string; removeParentId?: string }
): Promise<void> {
  const params = new URLSearchParams();
  if (input.addParentId) params.set('addParents', input.addParentId);
  if (input.removeParentId) params.set('removeParents', input.removeParentId);
  const query = params.toString() ? `?${params.toString()}` : '';
  await driveFetch(env, workspaceId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}${query}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input.appProperties ? { appProperties: input.appProperties } : {})
  });
}
