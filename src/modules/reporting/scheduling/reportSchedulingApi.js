import { callCloudflareWorkspaceRoute } from '../../../services/cloudflareApi.js';

export async function listSavedViews(workspaceId) {
  const response = await callCloudflareWorkspaceRoute(workspaceId, 'report-saved-views');
  return Array.isArray(response.views) ? response.views : [];
}

export async function createSavedView(workspaceId, payload) {
  return callCloudflareWorkspaceRoute(workspaceId, 'report-saved-views', { method: 'POST', payload });
}

export async function updateSavedView(workspaceId, viewId, payload) {
  return callCloudflareWorkspaceRoute(workspaceId, `report-saved-views/${encodeURIComponent(viewId)}`, { method: 'PUT', payload });
}

export async function deleteSavedView(workspaceId, viewId) {
  return callCloudflareWorkspaceRoute(workspaceId, `report-saved-views/${encodeURIComponent(viewId)}`, { method: 'DELETE' });
}

export async function listReportSchedules(workspaceId) {
  const response = await callCloudflareWorkspaceRoute(workspaceId, 'report-schedules');
  return {
    schedules: Array.isArray(response.schedules) ? response.schedules : [],
    locations: Array.isArray(response.locations) ? response.locations : [],
    allowAllLocations: response.allowAllLocations !== false,
    schedulerVersion: String(response.schedulerVersion || '')
  };
}


export async function createReportSchedule(workspaceId, payload) {
  return callCloudflareWorkspaceRoute(workspaceId, 'report-schedules', { method: 'POST', payload });
}

export async function updateReportSchedule(workspaceId, scheduleId, payload) {
  return callCloudflareWorkspaceRoute(workspaceId, `report-schedules/${encodeURIComponent(scheduleId)}`, { method: 'PUT', payload });
}

export async function deleteReportSchedule(workspaceId, scheduleId) {
  return callCloudflareWorkspaceRoute(workspaceId, `report-schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
}

export async function runReportScheduleNow(workspaceId, scheduleId) {
  return callCloudflareWorkspaceRoute(workspaceId, `report-schedules/${encodeURIComponent(scheduleId)}/run-now`, { method: 'POST', payload: {} });
}

export async function sendReportTestEmail(workspaceId, payload) {
  return callCloudflareWorkspaceRoute(workspaceId, 'reports/send-test-email', { method: 'POST', payload });
}
