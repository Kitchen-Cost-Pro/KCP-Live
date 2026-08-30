import { reportRedirects, reportRegistry } from './reportRegistry.js';
import { assertValidReport } from '../validators/reportValidators.js';

reportRegistry.filter((report) => report.type !== 'group').forEach(assertValidReport);

export { reportRegistry, reportRedirects } from './reportRegistry.js';
export * from './operations/index.js';
export * from './sales/index.js';
export * from './audit/index.js';
export * from './inventory/index.js';
export * from './purchasing/index.js';
export * from './advanced/index.js';

export function listReports({ section = '', includeHidden = false } = {}) {
  const normalizedSection = String(section || '').trim().toLowerCase();
  return reportRegistry.filter((report) => {
    if (!includeHidden && report.hiddenFromDashboard) return false;
    return !normalizedSection || normalizeSectionId(report.section) === normalizeSectionId(normalizedSection);
  });
}

export function getReportDefinition(reportId) {
  return reportRegistry.find((report) => report.id === reportId) || null;
}

export function getReportRedirect(reportId) {
  const id = String(reportId || '').trim();
  if (!id) return null;
  return reportRedirects[id] || null;
}

export function resolveReportRoute(reportId, { preferRedirect = true } = {}) {
  const requestedId = String(reportId || '').trim();
  if (!requestedId) return null;
  const redirect = preferRedirect ? getReportRedirect(requestedId) : null;
  if (redirect) {
    const targetId = redirect.targetId || redirect.reportId || requestedId;
    const target = getReportDefinition(targetId);
    return target ? {
      requestedId,
      redirected: true,
      reportId: targetId,
      activeReportId: redirect.activeReportId || '',
      view: redirect.view || '',
      definition: target
    } : null;
  }
  const definition = getReportDefinition(requestedId);
  return definition ? {
    requestedId,
    redirected: false,
    reportId: requestedId,
    activeReportId: '',
    view: '',
    definition
  } : null;
}

export function normalizeSectionId(section = '') {
  const value = String(section || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (value === 'stock-control') return 'stock_control';
  return value;
}
