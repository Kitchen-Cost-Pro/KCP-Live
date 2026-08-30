import { escapeHtml, formatMoney, formatNumber, formatPercent } from '../engine/formatters.js';
import { renderReportChart } from './ReportChart.js';
import { renderReportHeatmap } from './ReportHeatmap.js';
import { renderReportRiskMatrix } from './ReportRiskMatrix.js';

export function renderAdvancedReportPresentation(presentation = {}) {
  const wrapper = document.createElement('section');
  wrapper.className = 'advancedReportPresentation';
  const cards = Array.isArray(presentation.summaryCards) ? presentation.summaryCards : [];
  const visuals = Array.isArray(presentation.visuals) ? presentation.visuals : [];
  const explanation = presentation.explanation || null;
  wrapper.innerHTML = cards.length ? `<div class="advancedSummaryCards">${cards.map(renderSummaryCard).join('')}</div>` : '';
  if (visuals.length) {
    const grid = document.createElement('div');
    grid.className = 'advancedVisualGrid';
    visuals.forEach((visual) => {
      if (visual.type === 'heatmap') grid.append(renderReportHeatmap(visual));
      else if (visual.type === 'riskMatrix') grid.append(renderReportRiskMatrix(visual));
      else grid.append(renderReportChart(visual));
    });
    wrapper.append(grid);
  }
  if (explanation) wrapper.append(renderExplanation(explanation));
  return wrapper;
}

function renderSummaryCard(card = {}) {
  return `<article class="advancedSummaryCard advancedSummaryCard--${escapeHtml(card.tone || 'neutral')}"><span>${escapeHtml(card.label || '')}</span><strong>${escapeHtml(formatCardValue(card.value, card.format))}</strong>${card.detail ? `<small>${escapeHtml(card.detail)}</small>` : ''}</article>`;
}

function formatCardValue(value, format) {
  if (format === 'money') return formatMoney(value);
  if (format === 'percent') return formatPercent(value);
  if (format === 'days') return Number.isFinite(Number(value)) ? `${formatNumber(value)} days` : 'No usage';
  return typeof value === 'number' ? formatNumber(value) : String(value ?? '');
}

function renderExplanation(explanation = {}) {
  const panel = document.createElement('details');
  panel.className = 'advancedFormulaPanel';
  panel.open = explanation.open === true;
  const formulas = Array.isArray(explanation.formulas) ? explanation.formulas : [];
  const notes = Array.isArray(explanation.notes) ? explanation.notes : [];
  panel.innerHTML = `<summary><span><strong>${escapeHtml(explanation.title || 'How this report is calculated')}</strong>${explanation.description ? `<small>${escapeHtml(explanation.description)}</small>` : ''}</span><span aria-hidden="true">⌄</span></summary><div class="advancedFormulaPanel__body">${formulas.map((formula) => `<article><strong>${escapeHtml(formula.label || '')}</strong><code>${escapeHtml(formula.formula || '')}</code>${formula.example ? `<p>${escapeHtml(formula.example)}</p>` : ''}</article>`).join('')}${notes.length ? `<aside>${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</aside>` : ''}</div>`;
  return panel;
}
