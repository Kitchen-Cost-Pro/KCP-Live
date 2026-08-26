import { escapeHtml, formatDateTime } from '../engine/formatters.js';

// Some Yoco sales are structurally invisible to stock/reporting ledgers by design (an order that
// was never completed, a sale line that couldn't be mapped to a recipe/stock item, etc.) — see
// getOperationsExcludedSummary in cloudflare-v2/src/legacy/reporting-routes.ts. This makes that
// exclusion visible on the report itself instead of leaving "N shown" looking like a complete
// count when it may not be. Renders nothing when there's nothing excluded.
export function renderExcludedSummaryBanner(excluded, shownCount = 0) {
  const unsupported = excluded?.unsupportedOrders || { count: 0, rows: [] };
  const unresolved = excluded?.unresolvedLines || { count: 0, rows: [] };
  const totalExcluded = Number(unsupported.count || 0) + Number(unresolved.count || 0);
  if (!totalExcluded) return document.createDocumentFragment();

  const panel = document.createElement('details');
  panel.className = 'excludedSummaryBanner';

  const items = [
    ...unsupported.rows.map((row) => ({ ...row, group: 'Order not completed' })),
    ...unresolved.rows.map((row) => ({ ...row, group: 'Line not resolved to stock' })),
  ].sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));

  const shownLabel = `${formatCount(shownCount)} shown`;
  const excludedLabel = `${formatCount(totalExcluded)} excluded`;
  const isTruncated = Boolean(unsupported.truncated || unresolved.truncated);

  panel.innerHTML = `
    <summary>
      <span>
        <strong>${escapeHtml(shownLabel)} · ${escapeHtml(excludedLabel)}</strong>
        <small>Some sales couldn't be included automatically — click to see why.</small>
      </span>
      <span aria-hidden="true">⌄</span>
    </summary>
    <div class="excludedSummaryBanner__body">
      ${isTruncated ? `<p class="excludedSummaryBanner__truncated">Showing the ${escapeHtml(String(items.length))} most recent of ${escapeHtml(String(totalExcluded))} excluded sales for this period.</p>` : ''}
      <ul class="excludedSummaryBanner__list">
        ${items.map((item) => `
          <li>
            <span class="excludedSummaryBanner__when">${escapeHtml(formatDateTime(item.occurredAt) || item.occurredAt || '')}</span>
            <span class="excludedSummaryBanner__what">
              <strong>${escapeHtml(item.group)}</strong>
              ${item.itemName ? ` — ${escapeHtml(item.itemName)}` : ''}
              ${item.sourceOrderId ? `<code>${escapeHtml(item.sourceOrderId)}</code>` : ''}
            </span>
            <span class="excludedSummaryBanner__why">${escapeHtml(item.reason || '')}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
  return panel;
}

function formatCount(value) {
  const n = Number(value) || 0;
  return `${n} sale${n === 1 ? '' : 's'}`;
}

export default renderExcludedSummaryBanner;
