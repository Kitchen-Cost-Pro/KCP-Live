import { escapeHtml } from '../engine/formatters.js';

export function renderReportEmptyState({ title = 'No report data', message = 'Try changing the filters or checking that the source data has been loaded.' } = {}) {
  const empty = document.createElement('div');
  empty.className = 'reportEmptyState';
  empty.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(message)}</p>
  `;
  return empty;
}

export function renderReportLoadingState({ title = 'Loading report', message = 'Preparing rows, totals, warnings, and export data.' } = {}) {
  const loading = document.createElement('div');
  loading.className = 'reportLoadingState';
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  loading.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(message)}</p>
  `;
  return loading;
}
