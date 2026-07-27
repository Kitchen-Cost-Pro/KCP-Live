import { escapeHtml } from '../engine/formatters.js';

export function renderReportRiskMatrix(visual = {}) {
  const article = document.createElement('article');
  article.className = 'advancedVisualCard advancedVisualCard--riskMatrix';
  const points = Array.isArray(visual.data) ? visual.data.slice(0, 18) : [];
  article.innerHTML = `
    <header class="advancedVisualCard__header"><div><h3>${escapeHtml(visual.title || 'Risk Matrix')}</h3>${visual.description ? `<p>${escapeHtml(visual.description)}</p>` : ''}</div></header>
    <div class="advancedVisualCard__body">
      ${points.length ? `<div class="advancedRiskMatrix"><span class="advancedRiskMatrix__axis advancedRiskMatrix__axis--y">Impact</span><span class="advancedRiskMatrix__axis advancedRiskMatrix__axis--x">Likelihood</span><div class="advancedRiskMatrix__grid">${Array.from({ length: 25 }, (_, index) => `<span class="advancedRiskMatrix__cell advancedRiskMatrix__cell--${Math.floor(index / 5)}-${index % 5}"></span>`).join('')}${points.map((point) => renderPoint(point)).join('')}</div></div>` : '<div class="advancedVisualEmpty">Not enough data for this visual.</div>'}
    </div>`;
  return article;
}

function renderPoint(point) {
  const x = Math.min(98, Math.max(2, Number(point.probability || point.x || 0)));
  const y = Math.min(98, Math.max(2, Number(point.impact || point.y || 0)));
  return `<span class="advancedRiskMatrix__point" style="left:${x}%;bottom:${y}%" data-report-tooltip="${escapeHtml(point.tooltip || point.label || '')}" aria-label="${escapeHtml(point.label || 'Risk point')}"><i></i></span>`;
}
