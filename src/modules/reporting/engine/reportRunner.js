import { createReportingDataSet } from './reportDataMapper.js';
import { sortRows, text } from './grouping.js';
import { getReportDefinition, listReports, resolveReportRoute } from '../reports/index.js';
import { runDataQualityRules } from '../validators/dataQualityRules.js';
import { getReportColumns, validateReportResult } from '../validators/reportValidators.js';
import { categorizeReportWarnings, filterUserVisibleWarnings } from '../validators/warningCategories.js';
import { validateReportRuntimeIntegrity } from '../validators/reportRuntimeIntegrity.js';

export async function runReport(reportId, options = {}) {
  const route = typeof reportId === 'object'
    ? null
    : resolveReportRoute(reportId, { preferRedirect: true });
  const effectiveReportId = route?.activeReportId || route?.reportId || reportId;
  const report = typeof reportId === 'object' ? reportId : getReportDefinition(effectiveReportId);
  if (!report || report.type === 'group') {
    throw new Error(`Unknown report: ${String(reportId || '')}`);
  }

  const view = resolveReportView(report, options.view || options.filters?.view || route?.view);
  const filters = { ...(report.defaultFilters || {}), ...(options.filters || {}), view };
  const dataSet = options.dataSet || createReportingDataSet(options.sourceData || options.state || options.data || {});
  const context = {
    workspaceId: options.workspaceId || options.context?.workspaceId || '',
    filters,
    services: options.services || {},
    dataSet,
    view,
    context: options.context || {}
  };

  const rawRows = await report.getRows(context);
  const rows = sortRows(rawRows, options.sort || filters.sort);
  const totals = typeof report.getTotals === 'function' ? report.getTotals({ rows, filters, dataSet, view, services: context.services }) : {};
  const sourceMeta = resolveSourceMeta(rows, context.services, options.context);
  const generatedAt = sourceMeta.generatedAt || new Date().toISOString();
  const result = {
    id: report.id,
    report,
    title: report.title,
    section: report.section,
    view,
    availableViews: report.availableViews || [view],
    columns: getReportColumns(report, view),
    rows,
    totals,
    filters,
    sort: options.sort || filters.sort || null,
    dataSet,
    generatedAt,
    meta: sourceMeta,
    warnings: [],
    exportMapping: resolveExportMapping(report, view),
    emptyState: report.emptyState || null,
    presentation: null
  };

  if (typeof report.getPresentation === 'function') {
    result.presentation = await report.getPresentation({
      rows,
      filters,
      dataSet,
      view,
      services: context.services,
      totals,
      generatedAt,
      meta: sourceMeta
    });
  }

  if (typeof report.getExcludedSummary === 'function') {
    // Best-effort: a failure here (e.g. a legacy tenant DB mid-migration) must never take down
    // the report itself — the excluded-sales banner just doesn't render.
    result.excluded = await report.getExcludedSummary({
      workspaceId: context.workspaceId,
      filters,
      services: context.services
    }).catch(() => null);
  }

  const allWarnings = categorizeReportWarnings([
    ...validateReportResult(result),
    ...runDataQualityRules(dataSet, result),
    ...validateReportRuntimeIntegrity(result),
    ...(typeof report.validate === 'function' ? await report.validate({ rows, filters, dataSet, view, services: context.services, totals }) : [])
  ]);

  // Keep the complete diagnostic set for internal readiness checks, but only
  // show/export issues a customer can resolve in KCP. Worker, provider, receipt,
  // source-id, audit, schema, and reconciliation notes remain internal.
  result.allWarnings = allWarnings;
  result.warnings = filterUserVisibleWarnings(allWarnings);

  return result;
}

export async function runAllReports(options = {}) {
  const reports = listReports(options).flatMap((report) => {
    if (report.type !== 'group') return [report];
    return (report.reports || []).map((child) => getReportDefinition(child.id)).filter(Boolean);
  });
  return Promise.all(reports.map((report) => runReport(report, options)));
}

export function resolveReportView(report = {}, requestedView = '') {
  const requested = text(requestedView);
  const views = report.availableViews || [];
  return views.includes(requested) ? requested : (report.defaultView || views[0] || 'ledger');
}

function resolveExportMapping(report = {}, view = '') {
  if (report.exportMapping?.[view]) return report.exportMapping[view];
  return report.exportMapping || {};
}


function resolveSourceMeta(rows = [], services = {}, context = {}) {
  const rowMeta = rows.find((row) => row?.__apiMeta && typeof row.__apiMeta === 'object')?.__apiMeta || {};
  const reporting = services?.reporting || {};
  const payloadMeta = Object.values(reporting)
    .filter((value) => value && typeof value === 'object' && value.meta && typeof value.meta === 'object')
    .map((value) => value.meta)
    .find((meta) => meta.timezone || meta.generatedAt) || {};
  return {
    ...payloadMeta,
    ...rowMeta,
    ...(context?.meta || {}),
    ...(context?.timezone ? { timezone: context.timezone } : {})
  };
}
