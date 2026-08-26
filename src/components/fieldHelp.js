function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function renderFieldHelpLabel(label, tooltip = '') {
  if (!tooltip) return escapeHtml(label);
  return `
    <span class="inventoryHelpLabel">
      ${escapeHtml(label)}
      <span
        class="inventoryHelpIcon"
        tabindex="0"
        aria-label="${escapeHtml(tooltip)}"
        data-help-tooltip="${escapeHtml(tooltip)}"
      >i</span>
    </span>
  `;
}

export function bindFieldHelpTooltips(view, selector = '[data-help-tooltip]') {
  let tooltipNode = null;
  const controller = new AbortController();
  const { signal } = controller;

  const hideTooltip = () => {
    document.querySelectorAll('.inventoryHelpTooltip').forEach((node) => node.remove());
    tooltipNode?.remove();
    tooltipNode = null;
  };

  const showTooltip = (target) => {
    const text = target?.dataset?.helpTooltip;
    if (!text || !target.isConnected) return;
    hideTooltip();
    tooltipNode = document.createElement('div');
    tooltipNode.className = 'inventoryHelpTooltip';
    tooltipNode.textContent = text;
    document.body.append(tooltipNode);
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltipNode.getBoundingClientRect();
    const top = Math.max(10, targetRect.top - tooltipRect.height - 10);
    const left = Math.min(
      window.innerWidth - tooltipRect.width - 10,
      Math.max(10, targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2))
    );
    tooltipNode.style.top = `${top}px`;
    tooltipNode.style.left = `${left}px`;
  };

  view.querySelectorAll(selector).forEach((target) => {
    target.addEventListener('mouseenter', () => showTooltip(target), { signal });
    target.addEventListener('mouseleave', hideTooltip, { signal });
    target.addEventListener('focus', () => showTooltip(target), { signal });
    target.addEventListener('blur', hideTooltip, { signal });
    target.addEventListener('click', hideTooltip, { signal });
  });

  const hideIfLeavingTooltipTarget = (event) => {
    if (event.target?.closest?.(selector)) return;
    hideTooltip();
  };

  document.addEventListener('pointerdown', hideIfLeavingTooltipTarget, { capture: true, signal });
  document.addEventListener('focusin', hideIfLeavingTooltipTarget, { capture: true, signal });
  window.addEventListener('scroll', hideTooltip, { capture: true, signal });
  window.addEventListener('resize', hideTooltip, { signal });
  window.addEventListener('blur', hideTooltip, { signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTooltip();
  }, { signal });

  const observer = new MutationObserver(() => {
    if (view.isConnected) return;
    hideTooltip();
    controller.abort();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
