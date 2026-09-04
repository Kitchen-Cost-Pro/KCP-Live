import type { Env } from '../../legacy/types';
import { loadValidDriveAccessToken } from './connection';

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

/** Tags a file with custom key/value metadata — used to record kcp_status=processed / kcp_grv_id
 * once an uploaded invoice photo's extraction has been turned into a saved GRV. */
export async function updateFile(env: Env, workspaceId: string, fileId: string, input: { appProperties: Record<string, string> }): Promise<void> {
  await driveFetch(env, workspaceId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appProperties: input.appProperties })
  });
}
