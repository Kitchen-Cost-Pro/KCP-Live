import { escapeHtml } from '../engine/formatters.js';
import { toArray } from '../engine/grouping.js';

export function renderReportDrilldownTabs(reports = [], activeReportId = '') {
  const nav = document.createElement('nav');
  nav.className = 'reportDrilldownTabs';
  nav.setAttribute('aria-label', 'Report tabs');
  nav.innerHTML = toArray(reports).map((report) => {
    const active = report.id === activeReportId ? ' aria-current="page" class="is-active"' : '';
    return `<button type="button" data-report-id="${escapeHtml(report.id)}"${active}>${escapeHtml(report.shortTitle || report.title)}</button>`;
  }).join('');
  return nav;
}

export function renderReportViewTabs(report = {}, activeView = '') {
  const views = toArray(report.availableViews || [report.defaultView]);
  if (views.length <= 1) return document.createDocumentFragment();
  const nav = document.createElement('nav');
  nav.className = 'reportViewTabs';
  nav.setAttribute('aria-label', 'Report view tabs');
  nav.innerHTML = views.map((view) => {
    const active = view === activeView ? ' aria-current="page" class="is-active"' : '';
    return `<button type="button" data-report-view="${escapeHtml(view)}"${active}>${escapeHtml(formatViewLabel(view))}</button>`;
  }).join('');
  return nav;
}

export function formatViewLabel(view = '') {
  return String(view || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
