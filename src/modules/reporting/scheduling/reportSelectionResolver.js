import { getReportDefinition, resolveReportRoute } from '../reports/index.js';

const LEGACY_VIEW_OVERRIDES = Object.freeze({
  stock_movement: 'ledger',
  low_stock_alerts: 'item_detail',
  inventory_change: 'change_log'
});

/**
 * Resolve any current, redirected, hidden-alias, or legacy report/view pair to the
 * canonical schedulable report definition. This is intentionally shared by the
 * browser scheduling UI and the Worker so format selection can never change or
 * invalidate the selected report view.
 */
export function resolveScheduleReportSelection(reportId = '', viewId = '') {
  const requestedReportId = String(reportId || '').trim();
  const requestedViewId = String(viewId || '').trim();
  if (!requestedReportId) return null;

  const route = resolveReportRoute(requestedReportId, { preferRedirect: true });
  if (!route) return null;

  const canonicalReportId = String(route.activeReportId || route.reportId || requestedReportId).trim();
  const report = getReportDefinition(canonicalReportId);
  if (!report || report.type === 'group') return null;

  const views = Array.isArray(report.availableViews)
    ? report.availableViews.map((value) => String(value || '').trim()).filter(Boolean)
    : [String(report.defaultView || '').trim()].filter(Boolean);
  if (!views.length) return null;

  const routedView = String(route.view || LEGACY_VIEW_OVERRIDES[requestedReportId] || '').trim();
  const canonicalViewId = views.includes(requestedViewId)
    ? requestedViewId
    : views.includes(routedView)
      ? routedView
      : views.includes(String(report.defaultView || '').trim())
        ? String(report.defaultView || '').trim()
        : views[0];

  return {
    requestedReportId,
    requestedViewId,
    reportId: canonicalReportId,
    viewId: canonicalViewId,
    report,
    views,
    redirected: requestedReportId !== canonicalReportId || Boolean(route.redirected)
  };
}

export function isScheduleReportSelectionAvailable(reportId = '', viewId = '') {
  return Boolean(resolveScheduleReportSelection(reportId, viewId));
}
