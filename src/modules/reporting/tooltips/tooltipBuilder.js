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
