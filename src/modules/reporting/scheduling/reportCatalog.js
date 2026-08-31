import { listReports, getReportDefinition } from '../reports/index.js';
import { resolveScheduleReportSelection } from './reportSelectionResolver.js';

export function getSchedulableReportCatalog() {
  return listReports().flatMap((entry) => {
    if (entry.type === 'group') {
      return (entry.reports || []).map((child) => buildCatalogEntry(getReportDefinition(child.id), entry, child.label));
    }
    return [buildCatalogEntry(entry, null, entry.title)];
  }).filter(Boolean);
}

export function findCatalogEntry(reportId = '') {
  const catalog = getSchedulableReportCatalog();
  return resolveCatalogReportSelection(catalog, reportId)?.entry || null;
}

export function resolveCatalogReportSelection(catalog = [], reportId = '', viewId = '') {
  const resolved = resolveScheduleReportSelection(reportId, viewId);
  if (!resolved) return null;
  const entry = (Array.isArray(catalog) ? catalog : []).find((candidate) => candidate.reportId === resolved.reportId);
  if (!entry) return null;
  const view = entry.views.some((candidate) => candidate.value === resolved.viewId)
    ? resolved.viewId
    : entry.defaultView;
  if (!view) return null;
  return {
    ...resolved,
    reportId: entry.reportId,
    viewId: view,
    reportGroupId: entry.reportGroupId || '',
    entry
  };
}

function buildCatalogEntry(report, group = null, label = '') {
  if (!report) return null;
  return {
    reportGroupId: group?.id || '',
    reportGroupTitle: group?.title || '',
    reportId: report.id,
    title: label || report.title || report.id,
    fullTitle: group ? `${group.title} · ${label || report.title || report.id}` : (report.title || report.id),
    defaultView: report.defaultView,
    description: report.description || '',
    tooltip: buildCatalogTooltip(report, group, label),
    views: (report.availableViews || [report.defaultView]).filter(Boolean).map((view) => ({
      value: view,
      label: formatViewLabel(view)
    }))
  };
}


function buildCatalogTooltip(report = {}, group = null, label = '') {
  const title = label || report.title || report.id || 'Report';
  const views = (report.availableViews || [report.defaultView]).filter(Boolean).map(formatViewLabel);
  const parts = [];
  if (report.description) parts.push(report.description);
  if (group?.title) parts.push(`Report group: ${group.title}.`);
  if (views.length) parts.push(`Views: ${views.join(', ')}.`);
  return parts.join(' ') || `${title} reporting view.`;
}

const REPORT_VIEW_LABEL_ACRONYMS = new Set(['uom', 'vat', 'sku', 'grv', 'po']);

export function formatViewLabel(view = '') {
  return String(view || '')
    .split('_')
    .filter(Boolean)
    .map((part) => (REPORT_VIEW_LABEL_ACRONYMS.has(part.toLowerCase())
      ? part.toUpperCase()
      : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}
