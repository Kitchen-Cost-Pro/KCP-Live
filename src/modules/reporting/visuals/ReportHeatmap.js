import { escapeHtml, formatMoney, formatNumber, formatPercent } from '../engine/formatters.js';

export function renderReportHeatmap(visual = {}) {
  const article = document.createElement('article');
  article.className = 'advancedVisualCard advancedVisualCard--heatmap';
  const cells = Array.isArray(visual.data) ? visual.data : [];
  const rowLabels = [...new Set(cells.map((cell) => String(cell.row || 'Unknown')))].sort();
  const columnLabels = [...new Set(cells.map((cell) => String(cell.column || 'Unknown')))].sort();
  const max = Math.max(...cells.map((cell) => Math.abs(Number(cell.value) || 0)), 1);
  const byKey = new Map(cells.map((cell) => [`${cell.row}::${cell.column}`, cell]));
  article.innerHTML = `
    <header class="advancedVisualCard__header"><div><h3>${escapeHtml(visual.title || 'Heatmap')}</h3>${visual.description ? `<p>${escapeHtml(visual.description)}</p>` : ''}</div></header>
    <div class="advancedVisualCard__body">
      ${cells.length ? `<div class="advancedHeatmap" style="--heatmap-cols:${Math.max(columnLabels.length, 1)}"><span class="advancedHeatmap__corner"></span>${columnLabels.map((label) => `<strong class="advancedHeatmap__column">${escapeHtml(label)}</strong>`).join('')}${rowLabels.map((row) => `<strong class="advancedHeatmap__row">${escapeHtml(row)}</strong>${columnLabels.map((column) => renderCell(byKey.get(`${row}::${column}`), max, visual.format)).join('')}`).join('')}</div>` : '<div class="advancedVisualEmpty">Not enough data for this visual.</div>'}
    </div>`;
  return article;
}

function renderCell(cell, max, format) {
  if (!cell) return '<span class="advancedHeatmap__cell is-empty">-</span>';
  const value = Number(cell.value) || 0;
  const intensity = Math.min(4, Math.max(0, Math.ceil((Math.abs(value) / max) * 4)));
  const formatted = format === 'money' ? formatMoney(value) : format === 'percent' ? formatPercent(value) : formatNumber(value);
  return `<span class="advancedHeatmap__cell intensity-${intensity}" title="${escapeHtml(cell.tooltip || `${cell.row} / ${cell.column}: ${formatted}`)}"><b>${escapeHtml(formatted)}</b>${cell.meta ? `<small>${escapeHtml(cell.meta)}</small>` : ''}</span>`;
}
