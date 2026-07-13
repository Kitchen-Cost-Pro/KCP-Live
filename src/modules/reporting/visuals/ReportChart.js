import { escapeHtml, formatMoney, formatNumber, formatPercent } from '../engine/formatters.js';
import { renderSparklineSvg } from './ReportSparkline.js';

export function renderReportChart(chart = {}) {
  const article = document.createElement('article');
  article.className = `advancedVisualCard advancedVisualCard--${escapeHtml(chart.type || 'bar')}`;
  article.innerHTML = `
    <header class="advancedVisualCard__header">
      <div><h3>${escapeHtml(chart.title || 'Chart')}</h3>${chart.description ? `<p>${escapeHtml(chart.description)}</p>` : ''}</div>
    </header>
    <div class="advancedVisualCard__body">${renderChartBody(chart)}</div>
  `;
  return article;
}

function renderChartBody(chart) {
  if (chart.type === 'line' || chart.type === 'sparkline') {
    const values = (chart.data || []).map((point) => Number(point.value ?? point.y ?? point));
    const latest = values.at(-1);
    return `<div class="advancedLineChart">${renderSparklineSvg(values, { width: 480, height: 120, label: chart.title || 'Trend' })}<div class="advancedLineChart__footer"><span>${escapeHtml(chart.startLabel || '')}</span><strong>${formatMetric(latest, chart.format)}</strong><span>${escapeHtml(chart.endLabel || '')}</span></div></div>`;
  }
  if (chart.type === 'delta') return renderDeltaChart(chart);
  if (chart.type === 'stacked') return renderStackedChart(chart);
  if (chart.type === 'sparkTable') return renderSparkTable(chart);
  return renderBarChart(chart);
}

function renderBarChart(chart) {
  const data = Array.isArray(chart.data) ? chart.data : [];
  if (!data.length) return renderEmpty();
  const max = Math.max(...data.map((item) => Math.abs(Number(item.value) || 0)), 1);
  return `<div class="advancedBarChart">${data.map((item) => {
    const value = Number(item.value) || 0;
    const width = Math.max(2, (Math.abs(value) / max) * 100);
    return `<div class="advancedBarChart__row"><span class="advancedBarChart__label">${escapeHtml(item.label || '')}</span><span class="advancedBarChart__track"><span class="advancedBarChart__bar ${value < 0 ? 'is-negative' : ''}" style="width:${width.toFixed(2)}%"></span></span><strong>${formatMetric(value, chart.format)}</strong></div>`;
  }).join('')}</div>`;
}

function renderDeltaChart(chart) {
  const data = Array.isArray(chart.data) ? chart.data : [];
  if (!data.length) return renderEmpty();
  const max = Math.max(...data.map((item) => Math.abs(Number(item.value) || 0)), 1);
  return `<div class="advancedDeltaChart">${data.map((item) => {
    const value = Number(item.value) || 0;
    const magnitude = Math.max(2, (Math.abs(value) / max) * 50);
    const style = value >= 0 ? `left:50%;width:${magnitude}%` : `right:50%;width:${magnitude}%`;
    return `<div class="advancedDeltaChart__row"><span>${escapeHtml(item.label || '')}</span><span class="advancedDeltaChart__axis"><i class="${value < 0 ? 'is-negative' : 'is-positive'}" style="${style}"></i></span><strong>${formatMetric(value, chart.format)}</strong></div>`;
  }).join('')}</div>`;
}

function renderStackedChart(chart) {
  const segments = Array.isArray(chart.data) ? chart.data : [];
  if (!segments.length) return renderEmpty();
  const total = segments.reduce((sum, item) => sum + Math.abs(Number(item.value) || 0), 0) || 1;
  return `<div class="advancedStackedChart"><div class="advancedStackedChart__bar">${segments.map((item, index) => `<span class="advancedStackedChart__segment advancedStackedChart__segment--${index % 5}" style="width:${((Math.abs(Number(item.value) || 0) / total) * 100).toFixed(2)}%" title="${escapeHtml(item.label || '')}: ${escapeHtml(formatMetric(item.value, chart.format))}"></span>`).join('')}</div><div class="advancedStackedChart__legend">${segments.map((item, index) => `<span><i class="advancedStackedChart__legendDot advancedStackedChart__legendDot--${index % 5}"></i>${escapeHtml(item.label || '')}<strong>${formatMetric(item.value, chart.format)}</strong></span>`).join('')}</div></div>`;
}

function renderSparkTable(chart) {
  const rows = Array.isArray(chart.data) ? chart.data : [];
  if (!rows.length) return renderEmpty();
  return `<div class="advancedSparkTable">${rows.map((row) => `<div class="advancedSparkTable__row"><span><strong>${escapeHtml(row.label || '')}</strong><small>${escapeHtml(row.meta || '')}</small></span>${renderSparklineSvg(row.values || [], { width: 120, height: 32, label: `${row.label || ''} trend` })}<b>${formatMetric(row.value, chart.format)}</b></div>`).join('')}</div>`;
}

function renderEmpty() {
  return '<div class="advancedVisualEmpty">Not enough data for this visual.</div>';
}

function formatMetric(value, format) {
  if (format === 'money') return formatMoney(value);
  if (format === 'percent') return formatPercent(value);
  return formatNumber(value);
}
