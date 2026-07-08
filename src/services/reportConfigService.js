import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';

export async function fetchReportConfigs(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) return [];
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'report-configs');
  return normalizeReportConfigs(response.items || response.reportConfigs || []);
}

export async function saveReportConfig(workspaceId, config = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save a report.');
  const payload = normalizeReportConfigPayload(config);
  const resource = payload.id ? `report-configs/${encodeURIComponent(payload.id)}` : 'report-configs';
  const method = payload.id ? 'PATCH' : 'POST';
  const response = await callCloudflareWorkspaceRoute(workspaceKey, resource, { method, payload });
  return normalizeReportConfig(response.item || payload);
}

export async function createReportConfig(workspaceId, config = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to create a report.');
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'report-configs', {
    method: 'POST',
    payload: normalizeReportConfigPayload(config)
  });
  return normalizeReportConfig(response.item || config);
}

export async function deleteReportConfig(workspaceId, reportId = '') {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(reportId || '').trim();
  if (!workspaceKey || !id) return;
  await callCloudflareWorkspaceRoute(workspaceKey, `report-configs/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export async function planReportConfigWithAi(workspaceId, prompt = '') {
  const workspaceKey = String(workspaceId || '').trim();
  const cleanPrompt = String(prompt || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to build a report.');
  if (!cleanPrompt) throw new Error('Describe the report you want to build.');
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'report-configs/ai-plan', {
    method: 'POST',
    payload: { prompt: cleanPrompt }
  });
  return normalizeReportPlan(response);
}

export function normalizeReportConfigs(items = []) {
  return (Array.isArray(items) ? items : []).map(normalizeReportConfig);
}

export function normalizeReportConfig(item = {}) {
  const config = item.config && typeof item.config === 'object' ? item.config : {};
  const sourceId = String(item.sourceId || item.source_id || config.sourceId || config.customSource || 'stock').trim() || 'stock';
  const sourceIds = normalizeSourceIds(item.sourceIds || item.source_ids || config.sourceIds || config.source_ids, sourceId);
  const visualizationType = String(item.visualizationType || item.visualization_type || config.visualizationType || 'table').trim() || 'table';
  const groupBy = String(item.groupBy || item.group_by || config.groupBy || 'none').trim() || 'none';
  const recipients = Array.isArray(item.recipients)
    ? item.recipients
    : Array.isArray(config.recipients)
      ? config.recipients
      : splitRecipients(item.recipients || item.eodRecipients || item.eod_recipients || config.eodRecipients || '');
  const columns = Array.isArray(item.columns)
    ? item.columns
    : Array.isArray(config.customColumns)
      ? config.customColumns
      : [];
  const status = String(item.status || config.status || (item.emailEnabled || item.email_enabled || config.emailEnabled ? 'Scheduled' : 'Active')).trim() || 'Active';
  const description = String(item.description || config.description || config.summary || '').trim();
  const scheduleType = String(item.scheduleType || item.schedule_type || config.scheduleType || config.eodScheduleType || (status === 'Scheduled' ? 'Scheduled' : 'On Demand')).trim() || 'On Demand';
  const scheduleLabel = String(item.scheduleLabel || item.schedule_label || config.scheduleLabel || config.eodSchedule || (scheduleType === 'On Demand' ? 'Manual send only' : 'Configured schedule')).trim();
  const nextSendAt = String(item.nextSendAt || item.next_send_at || config.nextSendAt || '').trim();
  const lastSentAt = String(item.lastSentAt || item.last_sent_at || config.lastSentAt || '').trim();
  const recipientCount = Number(item.recipientCount ?? item.recipient_count ?? config.recipientCount ?? recipients.length ?? 0) || 0;
  const emailEnabled = item.emailEnabled ?? item.email_enabled ?? config.emailEnabled ?? config.eodEnabled ?? (scheduleType !== 'On Demand' || recipientCount > 0);
  const tags = Array.isArray(item.tags) ? item.tags : Array.isArray(config.tags) ? config.tags : [];
  const recentSends = Array.isArray(item.recentSends)
    ? item.recentSends
    : Array.isArray(config.recentSends)
      ? config.recentSends
      : [];
  const ownerUid = String(item.ownerUid || item.owner_uid || config.ownerUid || item.createdBy || item.created_by || '').trim();
  const ownerEmail = String(item.ownerEmail || item.owner_email || config.ownerEmail || '').trim();
  const ownerName = String(item.ownerName || item.owner_name || config.ownerName || item.createdByName || '').trim();
  const allowedRoles = normalizeAccessList(item.allowedRoles || item.allowed_roles || config.allowedRoles || config.accessPolicy?.roles, true);
  const allowedLocationIds = normalizeAccessList(item.allowedLocationIds || item.allowed_location_ids || config.allowedLocationIds || config.accessPolicy?.locationIds);
  const thresholdRules = Array.isArray(item.thresholdRules)
    ? item.thresholdRules
    : Array.isArray(config.thresholdRules)
      ? config.thresholdRules
      : Array.isArray(config.builder?.thresholdRules)
        ? config.builder.thresholdRules
        : [];
  const shareEnabled = item.shareEnabled ?? item.share_enabled ?? config.shareEnabled ?? config.builder?.options?.shareEnabled ?? false;
  const shareToken = String(item.shareToken || item.share_token || config.shareToken || config.builder?.options?.shareToken || '').trim();
  const auditLog = Array.isArray(item.auditLog)
    ? item.auditLog
    : Array.isArray(config.auditLog)
      ? config.auditLog
      : [];
  return {
    id: String(item.id || '').trim(),
    name: String(item.name || config.name || 'Custom Report').trim() || 'Custom Report',
    description,
    status,
    sourceId,
    sourceIds,
    visualizationType,
    groupBy,
    filters: item.filters && typeof item.filters === 'object' ? item.filters : {},
    columns,
    scheduleType,
    scheduleLabel,
    nextSendAt,
    lastSentAt,
    recipients,
    recipientCount,
    emailEnabled: emailEnabled === true || emailEnabled === 1 || emailEnabled === 'true',
    sentThisMonth: Number(item.sentThisMonth ?? item.sent_this_month ?? config.sentThisMonth ?? 0) || 0,
    recentSends,
    tags,
    ownerUid,
    ownerEmail,
    ownerName,
    allowedRoles,
    allowedLocationIds,
    thresholdRules,
    shareEnabled: shareEnabled === true || shareEnabled === 1 || shareEnabled === 'true',
    shareToken,
    auditLog,
    config: {
      ...config,
      description,
      status,
      sourceId,
      sourceIds,
      customSource: sourceId,
      visualizationType,
      groupBy,
      customColumns: columns,
      scheduleType,
      scheduleLabel,
      nextSendAt,
      lastSentAt,
      recipients,
      recipientCount,
      emailEnabled: emailEnabled === true || emailEnabled === 1 || emailEnabled === 'true',
      sentThisMonth: Number(item.sentThisMonth ?? item.sent_this_month ?? config.sentThisMonth ?? 0) || 0,
      recentSends,
      tags,
      ownerUid,
      ownerEmail,
      ownerName,
      allowedRoles,
      allowedLocationIds,
      thresholdRules,
      shareEnabled: shareEnabled === true || shareEnabled === 1 || shareEnabled === 'true',
      shareToken,
      accessPolicy: {
        ...(config.accessPolicy && typeof config.accessPolicy === 'object' ? config.accessPolicy : {}),
        roles: allowedRoles,
        locationIds: allowedLocationIds
      },
      auditLog
    },
    pinned: item.pinned === true || item.pinned === 1,
    createdAt: item.createdAt || item.created_at || '',
    updatedAt: item.updatedAt || item.updated_at || ''
  };
}

function normalizeReportConfigPayload(config = {}) {
  const normalized = normalizeReportConfig(config);
  return {
    ...(normalized.id ? { id: normalized.id } : {}),
    name: normalized.name,
    sourceId: normalized.sourceId,
    sourceIds: normalized.sourceIds,
    visualizationType: normalized.visualizationType,
    groupBy: normalized.groupBy,
    filters: normalized.filters,
    columns: normalized.columns,
    description: normalized.description,
    status: normalized.status,
    scheduleType: normalized.scheduleType,
    scheduleLabel: normalized.scheduleLabel,
    nextSendAt: normalized.nextSendAt,
    lastSentAt: normalized.lastSentAt,
    recipients: normalized.recipients,
    recipientCount: normalized.recipientCount,
    emailEnabled: normalized.emailEnabled,
    sentThisMonth: normalized.sentThisMonth,
    recentSends: normalized.recentSends,
    tags: normalized.tags,
    ownerUid: normalized.ownerUid,
    ownerEmail: normalized.ownerEmail,
    ownerName: normalized.ownerName,
    allowedRoles: normalized.allowedRoles,
    allowedLocationIds: normalized.allowedLocationIds,
    thresholdRules: normalized.thresholdRules,
    shareEnabled: normalized.shareEnabled,
    shareToken: normalized.shareToken,
    auditLog: normalized.auditLog,
    config: normalized.config,
    pinned: normalized.pinned
  };
}

function splitRecipients(value = '') {
  return String(value || '')
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSourceIds(value, fallback = '') {
  const source = Array.isArray(value) ? value : String(value || '').split('|');
  const ids = source.map((item) => String(item || '').trim()).filter(Boolean);
  const all = [fallback, ...ids].map((item) => String(item || '').trim()).filter(Boolean);
  return [...new Set(all)];
}

function normalizeAccessList(value, lowercase = false) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,|;\n]/);
  return [...new Set(source
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => lowercase ? item.toLowerCase() : item))];
}

function normalizeReportPlan(response = {}) {
  const plan = response.plan && typeof response.plan === 'object' ? response.plan : {};
  const sourceId = String(plan.sourceId || plan.source_id || 'inventory').trim() || 'inventory';
  const columns = Array.isArray(plan.columns) ? plan.columns.map((column) => String(column || '').trim()).filter(Boolean) : [];
  const blocks = Array.isArray(plan.blocks)
    ? plan.blocks
        .filter((block) => block && typeof block === 'object')
        .map((block, index) => ({
          id: String(block.id || `block-${index + 1}`).trim() || `block-${index + 1}`,
          type: String(block.type || 'table').trim() || 'table',
          title: String(block.title || 'Report Block').trim() || 'Report Block',
          description: String(block.description || '').trim(),
          columns: Array.isArray(block.columns) ? block.columns.map((column) => String(column || '').trim()).filter(Boolean) : [],
          valueColumn: String(block.valueColumn || block.value_column || '').trim(),
          labelColumn: String(block.labelColumn || block.label_column || '').trim(),
          groupBy: String(block.groupBy || block.group_by || plan.groupBy || plan.group_by || 'none').trim() || 'none',
          limit: Number(block.limit) || 10
        }))
    : [];
  return {
    customSource: sourceId,
    customColumns: columns,
    visualizationType: String(plan.visualizationType || plan.visualization_type || 'table').trim() || 'table',
    groupBy: String(plan.groupBy || plan.group_by || 'none').trim() || 'none',
    customReportBlocks: blocks,
    customReportName: String(plan.name || plan.title || 'Custom Report').trim() || 'Custom Report',
    customReportEod: plan.eodEnabled === true || plan.eod_enabled === true,
    customReportAiSource: String(response.planner || 'local').trim() || 'local',
    customReportAiMessage: String(plan.explanation || response.warning || '').trim(),
    customReportAiWarning: String(response.warning || '').trim()
  };
}
