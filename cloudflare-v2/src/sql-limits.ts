// SQLite-backed Durable Objects accept at most 100 bound parameters per query.
// Tenant ID lookups reserve one binding for workspace_id.
export const TENANT_ID_QUERY_CHUNK_SIZE = 99;

export function tenantIdChunks<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += TENANT_ID_QUERY_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + TENANT_ID_QUERY_CHUNK_SIZE));
  }
  return chunks;
}
