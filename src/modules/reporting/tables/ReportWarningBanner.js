import { escapeHtml } from '../engine/formatters.js';
import { groupBy, toArray } from '../engine/grouping.js';
import { WARNING_CATEGORIES, normalizeWarning } from '../validators/warningCategories.js';
import { flattenWarnings } from '../validators/rowWarningUtils.js';

const CATEGORY_ORDER = [
  WARNING_CATEGORIES.critical,
  WARNING_CATEGORIES.backend,
  WARNING_CATEGORIES.coverage
];

export function renderReportWarningBanner(warnings = []) {
  const items = flattenWarnings(warnings)
    .map(normalizeWarning)
    .filter((warning) => shouldRenderWarning(warning));
  if (!items.length) return document.createDocumentFragment();

  const grouped = groupBy(items, (warning) => warning.category || WARNING_CATEGORIES.critical);
  const groups = CATEGORY_ORDER
    .filter((category) => grouped.has(category))
    .map((category) => [category, grouped.get(category)]);

  const banner = document.createElement('div');
  banner.className = 'reportWarningBanner reportWarningBanner--systemOnly';
  banner.setAttribute('role', 'status');
  banner.innerHTML = groups.map(([category, groupItems]) => `
    <section class="reportWarningBanner__group" data-warning-category="${escapeHtml(category)}">
      <strong>${escapeHtml(category)}</strong>
      <ul>
        ${groupItems.map((warning) => `<li data-level="${escapeHtml(warning.level || 'info')}">${escapeHtml(warning.message || warning)}</li>`).join('')}
      </ul>
    </section>
  `).join('');
  return banner;
}

function shouldRenderWarning(warning = {}) {
  return Boolean(String(warning?.message || '').trim());
}
