import { escapeHtml } from '../engine/formatters.js';
import { formulaTooltips } from './formulaTooltips.js';

let activeTooltipNode = null;
let activeTooltipTarget = null;
let tooltipDisconnectObserver = null;

export function getFormulaTooltip(key) {
  return formulaTooltips[key] || null;
}

export function buildFormulaTooltip(key, fallback = '') {
  const tooltip = getFormulaTooltip(key);
  if (!tooltip) return String(fallback || '');
  return [tooltip.label, tooltip.formula, tooltip.description].filter(Boolean).join('\n');
}

export function buildRowFormulaTooltip(key, rowValues = '', fallback = '') {
  const tooltip = getFormulaTooltip(key);
  if (!tooltip) return String(fallback || rowValues || '');
  return [tooltip.label, tooltip.formula, rowValues, tooltip.description].filter(Boolean).join('\n');
}


export function buildColumnTooltip(column = {}) {
  const explicit = String(
    column.tooltip ||
      column.description ||
      column.helpText ||
      column.help ||
      '',
  ).trim();
  if (column.tooltipKey) {
    const formula = buildFormulaTooltip(column.tooltipKey, explicit);
    if (formula) return formula;
  }
  if (explicit) return explicit;

  const label = String(column.label || column.key || 'Column').trim();
  const key = String(column.key || '').trim();
  const type = String(column.type || '').trim().toLowerCase();
  const normalized = `${label} ${key}`.toLowerCase();

  if (/date and time|datetime|timestamp|occurred at|created at|committed at|counted at/.test(normalized) || type === 'datetime') {
    return `${label}: the reporting date and time recorded for this row, shown in the workspace reporting time zone.`;
  }
  if (type === 'money' || type === 'currency') {
    return `${label}: the monetary amount represented by this row. Currency values are shown in South African rand.`;
  }
  if (['number', 'qty', 'quantity'].includes(type)) {
    return `${label}: the quantity or count represented by this row.`;
  }
  if (type === 'percent' || type === 'percentage') {
    return `${label}: the percentage or rate calculated for this row.`;
  }
  if (/\bdate\b/.test(normalized) || type === 'date') {
    return `${label}: the reporting date associated with this row.`;
  }
  if (/\btime\b/.test(normalized) || type === 'time') {
    return `${label}: the reporting time associated with this row, shown in the workspace reporting time zone.`;
  }
  if (/location|site|from location|to location/.test(normalized)) {
    return `${label}: the stock, selling, source, or destination location linked to this row.`;
  }
  if (/supplier/.test(normalized)) {
    return `${label}: the supplier recorded on the related purchasing transaction. It does not restrict where the item may be ordered.`;
  }
  if (/menu item|product name|item name|inventory item|stock item|ingredient|\bitem\b/.test(normalized)) {
    return `${label}: the item, ingredient, product, or menu item represented by this row.`;
  }
  if (/category/.test(normalized)) {
    return `${label}: the category assigned to the item represented by this row.`;
  }
  if (/source|movement|adjustment type|transaction type|document type/.test(normalized)) {
    return `${label}: identifies the operation or source transaction that produced this row.`;
  }
  if (/status|severity|risk|classification/.test(normalized) || type === 'badge') {
    return `${label}: the current state or classification calculated for this row.`;
  }
  if (/reason|note|description|issue|impact|suggested|action/.test(normalized)) {
    return `${label}: supporting context recorded or calculated for this row.`;
  }
  if (/created by|committed by|user|actor/.test(normalized)) {
    return `${label}: the user associated with creating, committing, or changing this record.`;
  }
  if (/transaction|reference|document number|receipt|invoice|order number|po number/.test(normalized) || type === 'transaction_id') {
    return `${label}: the customer-facing reference used to identify or open the related transaction.`;
  }
  if (/uom|unit of measure|\bunit\b/.test(normalized)) {
    return `${label}: the unit of measure used for the quantity shown in this row.`;
  }
  if (/percent|percentage|margin|gp%|rate/.test(normalized) || type === 'percent') {
    return `${label}: the percentage or rate calculated for this row.`;
  }
  if (/qty|quantity|count|items|events|orders|transactions/.test(normalized) || ['number', 'qty'].includes(type)) {
    return `${label}: the quantity or count represented by this row.`;
  }
  if (/value|cost|sales|amount|payout|refund|vat|gross|net|tip|fee|price|profit/.test(normalized) || type === 'money') {
    return `${label}: the monetary amount represented by this row. Currency values are shown in South African rand.`;
  }
  return `${label}: the value recorded or calculated for this report row.`;
}

export function renderColumnTooltipIcon(column = {}) {
  const title = buildColumnTooltip(column);
  if (!title) return '';
  const safeTitle = escapeHtml(title);
  return `<span class="reportTooltip" role="button" aria-label="${safeTitle}" data-report-tooltip="${safeTitle}" tabindex="0">?</span>`;
}
export function renderTooltipIcon(key, fallback = '') {
  const title = buildFormulaTooltip(key, fallback);
  if (!title) return '';
  const safeTitle = escapeHtml(title);
  return `<button type="button" class="reportTooltip" aria-label="${safeTitle}" data-report-tooltip="${safeTitle}" tabindex="0">?</button>`;
}

export function bindReportTooltips(root = document) {
  if (!root?.addEventListener || typeof document === 'undefined') return () => {};

  if (typeof root.__reportTooltipCleanup === 'function') {
    root.__reportTooltipCleanup();
  }

  hideActiveTooltip();
  ensureTooltipDisconnectObserver();

  const show = (target) => {
    if (target === activeTooltipTarget && activeTooltipNode) return;
    const text = target?.getAttribute?.('data-report-tooltip') || target?.getAttribute?.('title') || '';
    if (!text.trim()) return;

    hideActiveTooltip();

    if (target.hasAttribute('title')) {
      target.setAttribute('data-report-tooltip-title', target.getAttribute('title') || '');
      target.removeAttribute('title');
    }

    activeTooltipTarget = target;
    activeTooltipNode = document.createElement('div');
    activeTooltipNode.className = 'reportFloatingTooltip';
    activeTooltipNode.setAttribute('role', 'tooltip');
    activeTooltipNode.textContent = text;
    document.body.append(activeTooltipNode);

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = activeTooltipNode.getBoundingClientRect();
    const spaceAbove = targetRect.top;
    const spaceBelow = window.innerHeight - targetRect.bottom;
    const showBelow = spaceAbove < tooltipRect.height + 18 && spaceBelow > spaceAbove;
    const top = showBelow
      ? Math.min(window.innerHeight - tooltipRect.height - 10, targetRect.bottom + 10)
      : Math.max(10, targetRect.top - tooltipRect.height - 10);
    const left = Math.min(
      window.innerWidth - tooltipRect.width - 10,
      Math.max(10, targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2))
    );
    activeTooltipNode.style.top = `${top}px`;
    activeTooltipNode.style.left = `${left}px`;
  };

  const onPointerOver = (event) => {
    const target = event.target?.closest?.('[data-report-tooltip]');
    if (target && root.contains(target)) show(target);
  };
  const onPointerOut = (event) => {
    const target = event.target?.closest?.('[data-report-tooltip]');
    if (!target) return;
    if (event.relatedTarget && target.contains(event.relatedTarget)) return;
    hideActiveTooltip();
  };
  const onFocusIn = (event) => {
    const target = event.target?.closest?.('[data-report-tooltip]');
    if (target && root.contains(target)) show(target);
  };
  const onFocusOut = (event) => {
    const target = event.target?.closest?.('[data-report-tooltip]');
    if (target) hideActiveTooltip();
  };
  const onEscape = (event) => {
    if (event.key === 'Escape') hideActiveTooltip();
  };
  const onPointerDown = () => hideActiveTooltip();
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') hideActiveTooltip();
  };
  const onViewportChange = () => hideActiveTooltip();
  const onWindowBlur = () => hideActiveTooltip();
  const onPageHide = () => hideActiveTooltip();
  const onRootLeave = () => hideActiveTooltip();

  root.addEventListener('mouseover', onPointerOver);
  root.addEventListener('mouseout', onPointerOut);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('keydown', onEscape);
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('mouseleave', onRootLeave);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);

  const cleanup = () => {
    if (!activeTooltipTarget || root.contains(activeTooltipTarget) || !activeTooltipTarget.isConnected) {
      hideActiveTooltip();
    }
    root.removeEventListener('mouseover', onPointerOver);
    root.removeEventListener('mouseout', onPointerOut);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', onFocusOut);
    root.removeEventListener('keydown', onEscape);
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('mouseleave', onRootLeave);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (root.__reportTooltipCleanup === cleanup) delete root.__reportTooltipCleanup;
  };

  root.__reportTooltipCleanup = cleanup;
  return cleanup;
}

function restoreTooltipTitle(target) {
  const originalTitle = target?.getAttribute?.('data-report-tooltip-title');
  if (originalTitle !== null && originalTitle !== undefined) {
    target.setAttribute('title', originalTitle);
    target.removeAttribute('data-report-tooltip-title');
  }
}

function hideActiveTooltip() {
  if (activeTooltipTarget) restoreTooltipTitle(activeTooltipTarget);
  activeTooltipNode?.remove();
  activeTooltipNode = null;
  activeTooltipTarget = null;
}

function ensureTooltipDisconnectObserver() {
  if (tooltipDisconnectObserver || !document.body || typeof MutationObserver === 'undefined') return;
  tooltipDisconnectObserver = new MutationObserver(() => {
    if (activeTooltipTarget && !activeTooltipTarget.isConnected) hideActiveTooltip();
  });
  tooltipDisconnectObserver.observe(document.body, { childList: true, subtree: true });
}
