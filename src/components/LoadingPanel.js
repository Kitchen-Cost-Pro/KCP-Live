export function renderLoadingPanel(title = 'Loading', message = 'Fetching workspace data...', { inline = false } = {}) {
  return `
    <div class="kcpLoadingPanel ${inline ? 'kcpLoadingPanel--inline' : ''}" role="status" aria-live="polite">
      <div class="kcpLoadingPanel__content">
        <div class="kcpLoadingPanel__spinner" aria-hidden="true"></div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(message)}</span>
      </div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
