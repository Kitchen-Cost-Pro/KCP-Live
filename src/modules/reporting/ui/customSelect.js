import { escapeHtml } from '../engine/formatters.js';

const VIEWPORT_PADDING = 8;
const DEFAULT_MIN_WIDTH = 160;
const DEFAULT_MAX_HEIGHT = 320;
const PORTAL_ID = 'report-enhanced-select-portal';

let activeSelect = null;
let globalListenersInstalled = false;
let repositionFrame = 0;

export function enhanceReportingSelects(root = document) {
  cleanupDisconnectedSelectMenu();
  if (!root?.querySelectorAll) return;
  root
    .querySelectorAll('select:not([data-report-native-select])')
    .forEach((select) => enhanceSelect(select));
}

export function refreshReportingSelect(select) {
  if (!select) return;
  const wrapper = select.closest('[data-report-enhanced-select]');
  if (!wrapper) {
    enhanceSelect(select);
    return;
  }
  rebuildSelect(wrapper, select);
}

function enhanceSelect(select) {
  if (!select || select.dataset.reportNativeSelect === 'true') return;
  const wrapper = document.createElement('span');
  wrapper.className = `reportEnhancedSelect${select.disabled ? ' is-disabled' : ''}${select.dataset.reportSelectPlacement === 'top' ? ' reportEnhancedSelect--top' : ''}`;
  wrapper.dataset.reportEnhancedSelect = 'true';
  select.parentNode.insertBefore(wrapper, select);
  wrapper.append(select);
  select.dataset.reportNativeSelect = 'true';
  select.classList.add('reportEnhancedSelect__native');
  select.__reportSelectWrapper = wrapper;
  select.addEventListener('change', () => syncSelectLabel(wrapper, select));
  rebuildSelect(wrapper, select);
  installGlobalListeners();
}

function rebuildSelect(wrapper, select) {
  if (activeSelect?.select === select) closeActiveSelect();
  wrapper.querySelectorAll('.reportEnhancedSelect__button').forEach((node) => node.remove());
  wrapper.classList.toggle('is-disabled', Boolean(select.disabled));
  const selected = select.selectedOptions?.[0] || select.options?.[0];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reportEnhancedSelect__button';
  button.disabled = select.disabled;
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', PORTAL_ID);
  button.innerHTML = `<span data-report-enhanced-label>${escapeHtml(selected?.textContent || '')}</span><span class="reportEnhancedSelect__chevron" aria-hidden="true">⌄</span>`;

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    if (activeSelect?.wrapper === wrapper) closeActiveSelect();
    else openSelect(wrapper, button, select);
  });

  button.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (activeSelect?.wrapper !== wrapper) openSelect(wrapper, button, select);
    const options = getEnabledPortalOptions();
    if (!options.length) return;
    const selectedOption = getPortalMenu().querySelector('.reportEnhancedSelect__option.is-selected');
    const selectedIndex = Math.max(0, options.indexOf(selectedOption));
    const nextIndex = event.key === 'ArrowUp'
      ? Math.max(0, selectedIndex - 1)
      : Math.min(options.length - 1, selectedIndex);
    options[nextIndex]?.focus();
  });

  wrapper.append(button);
}

function openSelect(wrapper, button, select) {
  closeActiveSelect();
  const menu = getPortalMenu();
  menu.replaceChildren();
  [...select.options].forEach((option, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `reportEnhancedSelect__option${option.selected ? ' is-selected' : ''}`;
    item.dataset.optionIndex = String(index);
    item.disabled = option.disabled;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
    item.textContent = option.textContent || '';
    menu.append(item);
  });

  activeSelect = { wrapper, button, select, menu };
  wrapper.classList.add('is-open');
  button.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  menu.classList.add('is-open');
  menu.dataset.placement = '';
  positionActiveSelect();
}

function choosePortalOption(optionButton) {
  if (!activeSelect || !optionButton || optionButton.disabled) return;
  const index = Number(optionButton.dataset.optionIndex);
  const option = activeSelect.select.options?.[index];
  if (!option) return;
  const { wrapper, select, button } = activeSelect;
  select.selectedIndex = index;
  syncSelectLabel(wrapper, select);
  closeActiveSelect();
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  if (button.isConnected) button.focus({ preventScroll: true });
}

function positionActiveSelect() {
  if (!activeSelect) return;
  const { wrapper, button, select, menu } = activeSelect;
  if (!wrapper.isConnected || !button.isConnected) {
    closeActiveSelect();
    return;
  }

  setImportant(menu, 'visibility', 'hidden');
  setImportant(menu, 'display', 'grid');
  setImportant(menu, 'max-height', `${DEFAULT_MAX_HEIGHT}px`);

  const rect = button.getBoundingClientRect();
  const requestedWidth = Math.max(
    rect.width,
    Number(select.dataset.reportSelectMinWidth || 0),
    DEFAULT_MIN_WIDTH,
  );
  const viewportWidth = Math.max(DEFAULT_MIN_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
  const width = Math.min(requestedWidth, viewportWidth);
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - VIEWPORT_PADDING - 6);
  const spaceAbove = Math.max(0, rect.top - VIEWPORT_PADDING - 6);
  const preferTop = wrapper.classList.contains('reportEnhancedSelect--top');
  const estimatedHeight = Math.min(menu.scrollHeight || DEFAULT_MAX_HEIGHT, DEFAULT_MAX_HEIGHT);
  const openAbove = preferTop
    ? spaceAbove >= Math.min(estimatedHeight, 120) || spaceAbove > spaceBelow
    : spaceBelow < Math.min(estimatedHeight, 220) && spaceAbove > spaceBelow;
  const availableHeight = Math.max(80, openAbove ? spaceAbove : spaceBelow);
  const maxHeight = Math.min(DEFAULT_MAX_HEIGHT, availableHeight);
  const menuHeight = Math.min(menu.scrollHeight || maxHeight, maxHeight);
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(rect.left, window.innerWidth - width - VIEWPORT_PADDING),
  );
  const top = openAbove
    ? Math.max(VIEWPORT_PADDING, rect.top - menuHeight - 6)
    : Math.min(window.innerHeight - menuHeight - VIEWPORT_PADDING, rect.bottom + 6);

  setImportant(menu, 'width', `${width}px`);
  setImportant(menu, 'max-height', `${maxHeight}px`);
  setImportant(menu, 'left', `${left}px`);
  setImportant(menu, 'top', `${Math.max(VIEWPORT_PADDING, top)}px`);
  setImportant(menu, 'right', 'auto');
  setImportant(menu, 'bottom', 'auto');
  setImportant(menu, 'visibility', 'visible');
  menu.dataset.placement = openAbove ? 'top' : 'bottom';
}

function schedulePositionActiveSelect() {
  if (!activeSelect || repositionFrame) return;
  repositionFrame = window.requestAnimationFrame(() => {
    repositionFrame = 0;
    positionActiveSelect();
  });
}

function syncSelectLabel(wrapper, select) {
  const selected = select.selectedOptions?.[0] || select.options?.[0];
  const label = wrapper.querySelector('[data-report-enhanced-label]');
  if (label) label.textContent = selected?.textContent || '';
  wrapper.classList.toggle('is-disabled', Boolean(select.disabled));
  const button = wrapper.querySelector('.reportEnhancedSelect__button');
  if (button) button.disabled = select.disabled;
  if (activeSelect?.select === select) {
    getPortalMenu().querySelectorAll('.reportEnhancedSelect__option').forEach((option, index) => {
      const isSelected = index === select.selectedIndex;
      option.classList.toggle('is-selected', isSelected);
      option.setAttribute('aria-selected', String(isSelected));
    });
  }
}

function closeActiveSelect() {
  if (!activeSelect) return;
  const { wrapper, button, menu } = activeSelect;
  wrapper?.classList?.remove('is-open');
  button?.setAttribute('aria-expanded', 'false');
  menu.classList.remove('is-open');
  menu.hidden = true;
  menu.style.removeProperty('display');
  menu.style.removeProperty('visibility');
  menu.style.removeProperty('top');
  menu.style.removeProperty('left');
  menu.style.removeProperty('right');
  menu.style.removeProperty('bottom');
  menu.style.removeProperty('width');
  menu.style.removeProperty('max-height');
  delete menu.dataset.placement;
  activeSelect = null;
}

function getPortalMenu() {
  let menu = document.getElementById(PORTAL_ID);
  if (menu) return menu;
  menu = document.createElement('span');
  menu.id = PORTAL_ID;
  menu.className = 'reportEnhancedSelect__menu reportEnhancedSelect__menu--portal';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  menu.addEventListener('click', (event) => {
    const option = event.target.closest('.reportEnhancedSelect__option');
    if (!option) return;
    event.preventDefault();
    choosePortalOption(option);
  });
  menu.addEventListener('keydown', (event) => {
    const options = getEnabledPortalOptions();
    const currentIndex = options.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      const button = activeSelect?.button;
      closeActiveSelect();
      button?.focus({ preventScroll: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter' || event.key === ' ') {
      choosePortalOption(document.activeElement?.closest?.('.reportEnhancedSelect__option'));
      return;
    }
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    if (event.key === 'ArrowDown') nextIndex = Math.min(options.length - 1, nextIndex + 1);
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, nextIndex - 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = Math.max(0, options.length - 1);
    options[nextIndex]?.focus();
  });
  document.body.append(menu);
  return menu;
}

function getEnabledPortalOptions() {
  return [...getPortalMenu().querySelectorAll('.reportEnhancedSelect__option:not(:disabled)')];
}

function installGlobalListeners() {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;
  document.addEventListener('pointerdown', (event) => {
    if (!activeSelect) return;
    const { wrapper, menu } = activeSelect;
    if (wrapper.contains(event.target) || menu.contains(event.target)) return;
    closeActiveSelect();
  }, { capture: true });
  window.addEventListener('resize', schedulePositionActiveSelect, { passive: true });
  document.addEventListener('scroll', (event) => {
    if (!activeSelect) return;
    if (activeSelect.menu.contains(event.target)) return;
    schedulePositionActiveSelect();
  }, { capture: true, passive: true });
}

function setImportant(node, property, value) {
  node.style.setProperty(property, value, 'important');
}

function cleanupDisconnectedSelectMenu() {
  if (activeSelect && !activeSelect.wrapper?.isConnected) closeActiveSelect();
}
