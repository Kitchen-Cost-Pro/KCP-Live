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

export function acknowledgeLowStockItem(workspaceId, { itemId, locationId } = {}) {
  return callCloudflareWorkspaceRoute(workspaceId, 'notifications/low-stock-ack', {
    method: 'POST',
    payload: {
      itemId: String(itemId || ''),
      locationId: String(locationId || '')
    }
  });
}

export function acknowledgeAllLowStockItems(workspaceId, items = []) {
  return callCloudflareWorkspaceRoute(workspaceId, 'notifications/low-stock-ack-all', {
    method: 'POST',
    payload: {
      items: Array.isArray(items)
        ? items
          .map((item) => ({ itemId: String(item?.itemId || ''), locationId: String(item?.locationId || '') }))
          .filter((item) => item.itemId && item.locationId)
        : []
    }
  });
}
