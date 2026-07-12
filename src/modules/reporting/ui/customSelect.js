import { escapeHtml } from '../engine/formatters.js';

export function enhanceReportingSelects(root = document) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('select:not([data-report-native-select])').forEach((select) => enhanceSelect(select));
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
  wrapper.className = `reportEnhancedSelect${select.disabled ? ' is-disabled' : ''}`;
  wrapper.dataset.reportEnhancedSelect = 'true';
  select.parentNode.insertBefore(wrapper, select);
  wrapper.append(select);
  select.dataset.reportNativeSelect = 'true';
  select.classList.add('reportEnhancedSelect__native');
  rebuildSelect(wrapper, select);

  document.addEventListener('click', (event) => {
    if (!wrapper.isConnected || wrapper.contains(event.target)) return;
    closeSelect(wrapper);
  }, { capture: true });

  select.addEventListener('change', () => syncSelectLabel(wrapper, select));
}

function rebuildSelect(wrapper, select) {
  wrapper.querySelectorAll('.reportEnhancedSelect__button, .reportEnhancedSelect__menu').forEach((node) => node.remove());
  wrapper.classList.toggle('is-disabled', Boolean(select.disabled));
  const selected = select.selectedOptions?.[0] || select.options?.[0];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reportEnhancedSelect__button';
  button.disabled = select.disabled;
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = `<span data-report-enhanced-label>${escapeHtml(selected?.textContent || '')}</span><span class="reportEnhancedSelect__chevron" aria-hidden="true">⌄</span>`;

  const menu = document.createElement('span');
  menu.className = 'reportEnhancedSelect__menu';
  menu.setAttribute('role', 'listbox');
  [...select.options].forEach((option) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `reportEnhancedSelect__option${option.selected ? ' is-selected' : ''}`;
    item.dataset.value = option.value;
    item.disabled = option.disabled;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
    item.textContent = option.textContent || '';
    item.addEventListener('click', (event) => {
      event.preventDefault();
      if (item.disabled) return;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncSelectLabel(wrapper, select);
      closeSelect(wrapper);
    });
    menu.append(item);
  });

  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const nextOpen = !wrapper.classList.contains('is-open');
    document.querySelectorAll('[data-report-enhanced-select].is-open').forEach((node) => {
      if (node !== wrapper) closeSelect(node);
    });
    wrapper.classList.toggle('is-open', nextOpen);
    button.setAttribute('aria-expanded', String(nextOpen));
  });

  wrapper.append(button, menu);
}

function syncSelectLabel(wrapper, select) {
  const selected = select.selectedOptions?.[0] || select.options?.[0];
  const label = wrapper.querySelector('[data-report-enhanced-label]');
  if (label) label.textContent = selected?.textContent || '';
  wrapper.querySelectorAll('.reportEnhancedSelect__option').forEach((option) => {
    const isSelected = String(option.dataset.value || '') === String(select.value || '');
    option.classList.toggle('is-selected', isSelected);
    option.setAttribute('aria-selected', String(isSelected));
  });
}

function closeSelect(wrapper) {
  wrapper.classList.remove('is-open');
  wrapper.querySelector('.reportEnhancedSelect__button')?.setAttribute('aria-expanded', 'false');
}
