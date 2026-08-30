import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';

export function loadLowStockNotificationSettings(workspaceId) {
  return callCloudflareWorkspaceRoute(workspaceId, 'notifications/low-stock-settings');
}

export function saveLowStockNotificationSettings(workspaceId, { dispatchTime = '08:00', recipientMemberIds = [] } = {}) {
  return callCloudflareWorkspaceRoute(workspaceId, 'notifications/low-stock-settings', {
    method: 'PUT',
    payload: {
      dispatchTime: String(dispatchTime || '08:00'),
      recipientMemberIds: Array.isArray(recipientMemberIds) ? recipientMemberIds.map(String).filter(Boolean) : []
    }
  });
}
