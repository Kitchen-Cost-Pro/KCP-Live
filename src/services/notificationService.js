import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';

export function emailDashboardStockNotifications(workspaceId, locationId = '') {
  return callCloudflareWorkspaceRoute(workspaceId, 'notifications/low-stock-email', {
    method: 'POST',
    payload: { locationId: String(locationId || '') }
  });
}
