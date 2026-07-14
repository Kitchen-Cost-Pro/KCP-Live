import { callCloudflareRoute } from './cloudflareApi.js';

export async function fetchSystemBroadcast() {
  const payload = await callCloudflareRoute('/api/system/broadcast', { token: '' });
  return payload.broadcast || null;
}
