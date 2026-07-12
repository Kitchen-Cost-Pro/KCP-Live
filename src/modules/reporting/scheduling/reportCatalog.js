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
    views: (report.availableViews || [report.defaultView]).filter(Boolean).map((view) => ({
      value: view,
      label: formatViewLabel(view)
    }))
  };
}

export function formatViewLabel(view = '') {
  return String(view || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
