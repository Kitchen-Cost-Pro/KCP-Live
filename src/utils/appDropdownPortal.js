const DROPDOWN_ROOT_SELECTOR = [
  '[data-adj-dropdown-root]',
  '[data-cn-dropdown-root]',
  '[data-grv-dropdown-root]',
  '[data-integrations-dropdown-root]',
  '[data-menu-dropdown-root]',
  '[data-mfg-dropdown-root]',
  '[data-po-dropdown-root]',
  '[data-recipe-dropdown-root]',
  '[data-settings-dropdown-root]',
  '[data-stock-dropdown-root]',
  '[data-stocktake-dropdown-root]',
  '[data-supplier-dropdown-root]',
  '[data-transfer-dropdown-root]',
  '[data-user-dropdown-root]'
].join(',');

const TOP_LAYER_CLASS = 'appDropdownTopLayerMenu';
const VIEWPORT_GAP = 8;
const DEFAULT_MAX_HEIGHT = 360;

let installed = false;
let observer = null;
let activeLayer = null;
let scheduledFrame = 0;
let mutationSuppressed = false;

export function installAppDropdownPortalSystem() {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  observer = new MutationObserver(() => {
    if (!mutationSuppressed) scheduleAppDropdownPortalRefresh();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'aria-expanded', 'hidden']
  });

  // Observe click in capture so child components cannot swallow outside-close detection, but
  // defer the actual close until the completed click has reached its target. Closing during
  // pointerdown can replace a Save/Commit button before that button receives its click.
  document.addEventListener('click', handleOutsideClick, { capture: true });
  document.addEventListener('keydown', handleEscapeKey, { capture: true });
  document.addEventListener('scroll', scheduleAppDropdownPortalRefresh, { capture: true, passive: true });
  window.addEventListener('resize', scheduleAppDropdownPortalRefresh, { passive: true });

  scheduleAppDropdownPortalRefresh();
}

export function cleanupAppDropdownPortal() {
  if (scheduledFrame) {
    window.cancelAnimationFrame(scheduledFrame);
    scheduledFrame = 0;
  }
  restoreActiveLayer();
}

export function scheduleAppDropdownPortalRefresh() {
  if (typeof window === 'undefined' || scheduledFrame) return;
  scheduledFrame = window.requestAnimationFrame(() => {
    scheduledFrame = 0;
    refreshAppDropdownLayer();
  });
}

function refreshAppDropdownLayer() {
  if (activeLayer) {
    const { root, trigger, menu } = activeLayer;
    if (root.isConnected && trigger.isConnected && menu.isConnected && isRootOpen(root)) {
      ensurePopoverOpen(activeLayer);
      positionTopLayer(activeLayer);
      return;
    }
    restoreActiveLayer();
  }

  const root = [...document.querySelectorAll(DROPDOWN_ROOT_SELECTOR)].find((entry) => isRootOpen(entry));
  if (!root) return;

  const trigger = findTrigger(root);
  const menu = findMenu(root);
  if (!trigger || !menu || menu.classList.contains(TOP_LAYER_CLASS)) return;

  mountTopLayer(root, trigger, menu);
}

function isRootOpen(root) {
  if (!root?.isConnected) return false;
  if (root.querySelector('[aria-expanded="true"]')) return true;
  if ([...root.classList].some((name) => name === 'is-open' || name === 'open' || name.endsWith('--open'))) return true;
  const menu = findMenu(root);
  return Boolean(menu && [...menu.classList].some((name) => name === 'is-open' || name === 'open' || name.endsWith('--open')));
}

function findTrigger(root) {
  return root.querySelector('[aria-expanded="true"]')
    || root.querySelector('button[data-settings-dropdown], button[data-stocktake-dropdown], button[data-mfg-dropdown-toggle], button[data-po-dropdown], button[data-menu-dropdown], button[data-recipe-dropdown], button[data-stock-dropdown], button[data-supplier-dropdown], button[data-transfer-dropdown], button[data-user-dropdown], button[data-adj-dropdown], button[data-cn-open-dropdown], button[data-grv-open-dropdown], button[data-integrations-dropdown]')
    || root.querySelector('[role="combobox"]')
    || root.querySelector('button, input');
}

function findMenu(root) {
  if (!root?.querySelectorAll) return null;
  const candidates = [...root.querySelectorAll('*')];
  return candidates.find((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const role = String(node.getAttribute('role') || '').toLowerCase();
    if (role === 'menu' || role === 'listbox') return true;
    const className = String(node.className || '');
    return /(?:dropdown|supplier|location|action|select|template).*menu|menu$/i.test(className);
  }) || null;
}

function mountTopLayer(root, trigger, menu) {
  const computed = window.getComputedStyle(menu);
  const menuRect = menu.getBoundingClientRect();
  const originalStyle = menu.getAttribute('style');
  const originalHidden = menu.hidden;
  const hadPopoverAttribute = menu.hasAttribute('popover');
  const originalPopover = menu.getAttribute('popover');
  const supportsPopover = typeof menu.showPopover === 'function' && typeof menu.hidePopover === 'function';
  const visibleDisplay = computed.display === 'none' ? 'block' : computed.display;

  mutationSuppressed = true;
  menu.classList.add(TOP_LAYER_CLASS);
  menu.hidden = false;
  if (supportsPopover) menu.setAttribute('popover', 'manual');
  setImportant(menu, 'position', 'fixed');
  setImportant(menu, 'inset', 'auto');
  setImportant(menu, 'display', visibleDisplay || 'block');
  setImportant(menu, 'visibility', 'visible');
  setImportant(menu, 'opacity', '1');
  setImportant(menu, 'pointer-events', 'auto');
  setImportant(menu, 'transform', 'none');
  setImportant(menu, 'margin', '0');
  setImportant(menu, 'z-index', '2147483646');
  setImportant(menu, 'overflow-x', 'hidden');
  setImportant(menu, 'overflow-y', 'auto');
  setImportant(menu, 'overscroll-behavior', 'contain');
  mutationSuppressed = false;

  activeLayer = {
    root,
    trigger,
    menu,
    originalStyle,
    originalHidden,
    hadPopoverAttribute,
    originalPopover,
    supportsPopover,
    computedRight: computed.right,
    measuredWidth: menuRect.width,
    measuredHeight: menuRect.height
  };

  ensurePopoverOpen(activeLayer);
  positionTopLayer(activeLayer);
}

function ensurePopoverOpen(layer) {
  if (!layer?.supportsPopover || !layer.menu.isConnected) return;
  try {
    if (!isPopoverOpen(layer.menu)) layer.menu.showPopover();
  } catch {
    layer.supportsPopover = false;
  }
}

function isPopoverOpen(menu) {
  try {
    return menu.matches(':popover-open');
  } catch {
    return false;
  }
}

function positionTopLayer(layer) {
  const { trigger, menu } = layer;
  const rect = trigger.getBoundingClientRect();
  if (!rect.width && !rect.height) return;

  const computed = window.getComputedStyle(menu);
  const minWidth = parseCssSize(computed.minWidth);
  const desiredWidth = Math.max(rect.width, layer.measuredWidth || 0, minWidth || 0, 120);
  const width = Math.min(desiredWidth, Math.max(120, window.innerWidth - VIEWPORT_GAP * 2));
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - VIEWPORT_GAP - 6);
  const spaceAbove = Math.max(0, rect.top - VIEWPORT_GAP - 6);
  const contentHeight = Math.max(menu.scrollHeight || 0, layer.measuredHeight || 0, 80);
  const openAbove = spaceBelow < Math.min(contentHeight, 220) && spaceAbove > spaceBelow;
  const availableHeight = Math.max(80, openAbove ? spaceAbove : spaceBelow);
  const maxHeight = Math.min(DEFAULT_MAX_HEIGHT, availableHeight);
  const expectedHeight = Math.min(contentHeight, maxHeight);
  const alignRight = layer.computedRight && layer.computedRight !== 'auto';
  const preferredLeft = alignRight ? rect.right - width : rect.left;
  const left = Math.max(VIEWPORT_GAP, Math.min(preferredLeft, window.innerWidth - width - VIEWPORT_GAP));
  const top = openAbove
    ? Math.max(VIEWPORT_GAP, rect.top - expectedHeight - 6)
    : Math.min(window.innerHeight - expectedHeight - VIEWPORT_GAP, rect.bottom + 6);

  setImportant(menu, 'left', `${left}px`);
  setImportant(menu, 'top', `${Math.max(VIEWPORT_GAP, top)}px`);
  setImportant(menu, 'right', 'auto');
  setImportant(menu, 'bottom', 'auto');
  setImportant(menu, 'width', `${width}px`);
  setImportant(menu, 'max-width', `${Math.max(120, window.innerWidth - VIEWPORT_GAP * 2)}px`);
  setImportant(menu, 'max-height', `${maxHeight}px`);
  menu.dataset.portalPlacement = openAbove ? 'top' : 'bottom';
}

function restoreActiveLayer() {
  if (!activeLayer) return;
  const layer = activeLayer;
  activeLayer = null;
  const {
    menu,
    originalStyle,
    originalHidden,
    hadPopoverAttribute,
    originalPopover,
    supportsPopover
  } = layer;

  mutationSuppressed = true;
  if (supportsPopover && menu.isConnected) {
    try {
      if (isPopoverOpen(menu)) menu.hidePopover();
    } catch {
      // The owning component may have been replaced during a render.
    }
  }
  menu.classList.remove(TOP_LAYER_CLASS);
  delete menu.dataset.portalPlacement;
  if (originalStyle === null) menu.removeAttribute('style');
  else menu.setAttribute('style', originalStyle);
  menu.hidden = originalHidden;
  if (hadPopoverAttribute) menu.setAttribute('popover', originalPopover || 'auto');
  else menu.removeAttribute('popover');
  mutationSuppressed = false;
}

function handleOutsideClick(event) {
  const layer = activeLayer;
  const target = event.target;
  if (!layer || !(target instanceof Node)) return;
  if (layer.menu.contains(target) || layer.root.contains(target)) return;

  // Capture observes every click, including controls that stop propagation. The microtask runs
  // after target and bubble handlers, so the unrelated action always receives its click first.
  queueMicrotask(() => {
    if (activeLayer !== layer) return;
    const { root, trigger } = layer;
    restoreActiveLayer();
    if (root.isConnected && trigger.isConnected && isRootOpen(root)) trigger.click();
  });
}

function handleEscapeKey(event) {
  if (event.key !== 'Escape' || !activeLayer) return;
  event.preventDefault();
  const trigger = activeLayer.trigger;
  restoreActiveLayer();
  if (trigger.isConnected) {
    trigger.click();
    trigger.focus({ preventScroll: true });
  }
}

function setImportant(node, property, value) {
  node.style.setProperty(property, value, 'important');
}

function parseCssSize(value = '') {
  const parsed = Number.parseFloat(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
