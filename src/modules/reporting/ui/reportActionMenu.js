const REPORT_THEME_PROPERTIES = [
  '--report-panel',
  '--report-panel-strong',
  '--report-border',
  '--report-border-strong',
  '--report-text',
  '--report-muted'
];

function setImportantStyle(element, property, value) {
  element.style.setProperty(property, value, 'important');
}

function copyReportTheme(panel, source) {
  if (typeof window === 'undefined' || !source) return;
  const computed = window.getComputedStyle(source);
  REPORT_THEME_PROPERTIES.forEach((property) => {
    const value = computed.getPropertyValue(property).trim();
    if (value) panel.style.setProperty(property, value);
  });
  const colorScheme = computed.getPropertyValue('color-scheme').trim();
  if (colorScheme) panel.style.setProperty('color-scheme', colorScheme);
}

export function closeReportActionMenu(node) {
  const panel = node?.closest?.('.reportActionMenu__panel');
  const owner = panel?.__reportActionMenuOwner || node?.closest?.('.reportActionMenu');
  owner?.removeAttribute?.('open');
}

export function installReportActionMenu(root) {
  const details = root?.querySelector?.('.reportActionMenu');
  const trigger = details?.querySelector?.('.reportActionMenu__trigger');
  const panel = details?.querySelector?.('.reportActionMenu__panel');
  if (!details || !trigger || !panel || typeof window === 'undefined' || typeof document === 'undefined') return;

  const controller = new AbortController();
  const { signal } = controller;
  const anchor = document.createComment('report-action-menu-panel-anchor');
  panel.before(anchor);
  panel.__reportActionMenuOwner = details;
  panel.setAttribute('popover', 'manual');

  const supportsPopover = typeof panel.showPopover === 'function' && typeof panel.hidePopover === 'function';
  let fallbackPortaled = false;
  let frameOne = 0;
  let frameTwo = 0;

  const isPopoverOpen = () => {
    if (!supportsPopover || typeof panel.matches !== 'function') return false;
    try {
      return panel.matches(':popover-open');
    } catch {
      return false;
    }
  };

  const mountFallbackPortal = () => {
    if (fallbackPortaled || !document.body) return;
    copyReportTheme(panel, details.closest('.reportingDashboard') || root);
    panel.classList.add('reportActionMenu__panel--portal');
    document.body.append(panel);
    fallbackPortaled = true;
  };

  const restoreFallbackPortal = () => {
    if (!fallbackPortaled) return;
    if (anchor.isConnected) anchor.after(panel);
    else panel.remove();
    panel.classList.remove('reportActionMenu__panel--portal');
    fallbackPortaled = false;
  };

  const showPanel = () => {
    if (supportsPopover) {
      if (!isPopoverOpen()) {
        try {
          panel.showPopover();
        } catch {
          mountFallbackPortal();
        }
      }
      return;
    }
    mountFallbackPortal();
  };

  const hidePanel = () => {
    if (supportsPopover && isPopoverOpen()) {
      try {
        panel.hidePopover();
      } catch {
        // The fallback restoration below still guarantees cleanup.
      }
    }
    restoreFallbackPortal();
  };

  const positionPanel = () => {
    if (!details.open || !details.isConnected || !panel.isConnected) return;

    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 8;
    const availableWidth = Math.max(0, window.innerWidth - (viewportPadding * 2));
    const width = Math.min(420, availableWidth);
    const viewportHeight = Math.max(0, window.innerHeight - (viewportPadding * 2));

    setImportantStyle(panel, 'position', 'fixed');
    setImportantStyle(panel, 'box-sizing', 'border-box');
    setImportantStyle(panel, 'z-index', '2147483646');
    setImportantStyle(panel, 'margin', '0');
    setImportantStyle(panel, 'transform', 'none');
    setImportantStyle(panel, 'inset', 'auto');
    setImportantStyle(panel, 'width', `${Math.max(280, width)}px`);
    setImportantStyle(panel, 'max-width', `${availableWidth}px`);

    const left = Math.min(
      Math.max(viewportPadding, triggerRect.right - Math.max(280, width)),
      Math.max(viewportPadding, window.innerWidth - Math.max(280, width) - viewportPadding)
    );

    setImportantStyle(panel, 'left', `${left}px`);
    setImportantStyle(panel, 'right', 'auto');

    const roomBelow = Math.max(0, window.innerHeight - triggerRect.bottom - viewportPadding - gap);
    const roomAbove = Math.max(0, triggerRect.top - viewportPadding - gap);
    const naturalHeight = Math.max(1, panel.scrollHeight || panel.getBoundingClientRect().height || 1);
    const openAbove = roomAbove > roomBelow;
    const availableHeight = Math.max(120, openAbove ? roomAbove : roomBelow);
    const maxHeight = Math.min(viewportHeight, availableHeight);
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const top = openAbove
      ? triggerRect.top - gap - renderedHeight
      : triggerRect.bottom + gap;

    setImportantStyle(panel, 'max-height', `${maxHeight}px`);
    setImportantStyle(panel, 'top', `${Math.max(viewportPadding, Math.min(top, window.innerHeight - renderedHeight - viewportPadding))}px`);
    setImportantStyle(panel, 'bottom', 'auto');
  };

  const schedulePosition = () => {
    window.cancelAnimationFrame(frameOne);
    window.cancelAnimationFrame(frameTwo);
    frameOne = window.requestAnimationFrame(() => {
      positionPanel();
      frameTwo = window.requestAnimationFrame(positionPanel);
    });
  };

  const cleanup = () => {
    window.cancelAnimationFrame(frameOne);
    window.cancelAnimationFrame(frameTwo);
    hidePanel();
    delete panel.__reportActionMenuOwner;
    anchor.remove();
    controller.abort();
  };

  root.__reportActionMenuCleanup = cleanup;

  details.addEventListener('toggle', () => {
    if (!details.open) {
      hidePanel();
      return;
    }
    showPanel();
    schedulePosition();
  }, { signal });

  panel.addEventListener('toggle', () => {
    if (supportsPopover && !isPopoverOpen() && details.open) details.removeAttribute('open');
  }, { signal });

  window.addEventListener('resize', schedulePosition, { passive: true, signal });
  document.addEventListener('scroll', schedulePosition, { capture: true, passive: true, signal });
  document.addEventListener('pointerdown', (event) => {
    if (!details.open) return;
    if (details.contains(event.target) || panel.contains(event.target)) return;
    details.removeAttribute('open');
  }, { capture: true, signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') details.removeAttribute('open');
  }, { signal });
}
