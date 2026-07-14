import { escapeHtml } from '../engine/formatters.js';

export function renderSparklineSvg(values = [], { width = 160, height = 42, label = 'Trend' } = {}) {
  const numbers = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (!numbers.length) return '<span class="reportSparkline reportSparkline--empty">No trend data</span>';
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const range = max - min || 1;
  const padding = 3;
  const points = numbers.map((value, index) => {
    const x = numbers.length === 1 ? width / 2 : padding + (index / (numbers.length - 1)) * (width - padding * 2);
    const y = height - padding - ((value - min) / range) * (height - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return `<svg class="reportSparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}"><polyline points="${points}" fill="none" vector-effect="non-scaling-stroke"></polyline></svg>`;
}
