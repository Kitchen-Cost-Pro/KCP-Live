import '../styles/suppliers.css';
import '../styles/fieldHelp.css';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';

const PAYMENT_TERM_OPTIONS = [
  'COD',
  'Due on receipt',
  '7 Days',
  '14 Days',
  '30 Days',
  '45 Days',
  '60 Days',
  'EOM',
  '30 Days EOM'
];

export function renderSuppliers({ state, onSupplierFilterChange, onSupplierAction = {} } = {}) {
  const suppliers = state.suppliers || {};
  const filters = {
    query: '',
    category: '',
    view: 'list',
    openDropdown: '',
    ...(suppliers.filters || {})
  };
  const items = filterSuppliers(suppliers.items || [], filters);
  const selectedIds = new Set((suppliers.selectedIds || []).map(String));
  const categoryOptions = [
    { value: '', label: 'All Categories' },
    ...getCategories(suppliers.items || []).map((category) => ({ value: category, label: category }))
  ];

  const view = document.createElement('section');
  view.className = 'suppliersModule';
  view.innerHTML = `
    <header class="suppliersModule__header">
      <div>
        <p class="suppliersModule__eyebrow">Inventory</p>
        <h1>Suppliers</h1>
        <p>Live supplier records feed Purchase Orders, lead-time planning, and contact shortcuts.</p>
      </div>
      <div class="suppliersModule__actions">
        <input type="file" accept=".csv,.json,.xlsx,.xls,text/csv,application/json" hidden data-supplier-import-input />
        ${renderActionDropdown(filters.openDropdown, suppliers.actionStatus)}
        ${selectedIds.size ? renderInlineBulkDelete([...selectedIds], suppliers.actionStatus) : ''}
        <button type="button" class="suppliersModule__primary" data-supplier-edit="">${icon('plus')}<span>Add Supplier</span></button>
      </div>
    </header>

    <section class="suppliersModule__controls" aria-label="Supplier filters">
      <label>
        ${renderFieldHelpLabel('Search Suppliers', 'Filter supplier records by company name, contact person, or email so you can find the right vendor quickly.')}
        <input type="search" value="${escapeAttribute(filters.query)}" placeholder="Name, email, contact..." data-supplier-filter="query" />
      </label>
      ${renderDropdown({
        id: 'category',
        label: 'Category',
        value: filters.category,
        openDropdown: filters.openDropdown,
        options: categoryOptions
      })}
      <div class="suppliersModule__viewToggle" aria-label="Supplier view toggle">
        ${renderViewButton('list', filters.view)}
        ${renderViewButton('tiles', filters.view)}
      </div>
    </section>

    ${suppliers.actionError && !suppliers.editingItem && !suppliers.confirmDelete ? renderNotice(suppliers.actionError, 'error') : ''}
    ${renderSupplierBody(suppliers, items, filters.view, selectedIds)}
    ${renderSupplierModal(suppliers)}
    ${renderDeleteDialog(suppliers)}
    ${renderToast(suppliers.toast)}
  `;

  bindSupplierEvents(view, items, filters, suppliers, onSupplierFilterChange, onSupplierAction);
  bindFieldHelpTooltips(view);
  return view;
}

function bindSupplierEvents(view, visibleItems, filters, suppliers, onSupplierFilterChange, onSupplierAction) {
  const submitSupplierForm = () => {
    const form = view.querySelector('[data-supplier-form]');
    if (!form) return;
    const currentItem = suppliers.editingItem || {};
    // An UNCHECKED checkbox has no meaningful `.value` to read (it's a fixed static string
    // regardless of checked state) — must read `.checked` directly, same fix already applied to
    // StockItems.js's "VAT Enabled" toggle for the identical reason.
    const vatRegisteredField = form.querySelector('[name="vatRegistered"]');
    onSupplierAction.onSave?.({
      id: form.dataset.supplierId,
      name: form.querySelector('[name="name"]')?.value,
      contactPerson: form.querySelector('[name="contactPerson"]')?.value,
      email: form.querySelector('[name="email"]')?.value,
      phone: form.querySelector('[name="phone"]')?.value,
      category: form.querySelector('[name="category"]')?.value,
      leadTime: form.querySelector('[name="leadTime"]')?.value,
      paymentTerms: form.querySelector('[name="paymentTerms"]')?.value,
      accountNumber: form.querySelector('[name="accountNumber"]')?.value,
      address: form.querySelector('[name="address"]')?.value,
      addressLine1: form.querySelector('[name="addressLine1"]')?.value ?? currentItem.addressLine1 ?? '',
      addressLine2: form.querySelector('[name="addressLine2"]')?.value ?? currentItem.addressLine2 ?? '',
      city: form.querySelector('[name="city"]')?.value ?? currentItem.city ?? '',
      province: form.querySelector('[name="province"]')?.value ?? currentItem.province ?? '',
      postalCode: form.querySelector('[name="postalCode"]')?.value ?? currentItem.postalCode ?? '',
      country: form.querySelector('[name="country"]')?.value ?? currentItem.country ?? '',
      vatRegistered: vatRegisteredField ? vatRegisteredField.checked : currentItem.vatRegistered !== false,
      notes: form.querySelector('[name="notes"]')?.value ?? currentItem.notes ?? ''
    });
  };

  view.querySelectorAll('[data-supplier-filter]').forEach((field) => {
    field.addEventListener('input', () => onSupplierFilterChange?.({ [field.dataset.supplierFilter]: field.value }));
  });

  view.querySelectorAll('[data-supplier-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.supplierDropdown;
      onSupplierFilterChange?.({ openDropdown: filters.openDropdown === id ? '' : id });
    });
  });

  view.addEventListener('click', (event) => {
    if (!filters.openDropdown || event.target.closest('[data-supplier-dropdown-root]')) return;
    onSupplierFilterChange?.({ openDropdown: '' });
  });

  const handleDocumentPointerDown = (event) => {
    if (!view.isConnected) {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      return;
    }
    if (!filters.openDropdown || view.contains(event.target)) return;
    onSupplierFilterChange?.({ openDropdown: '' });
  };
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);

  view.querySelectorAll('[data-supplier-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onSupplierFilterChange?.({
        [button.dataset.supplierOptionGroup]: button.dataset.supplierOptionValue,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-supplier-modal-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.dataset.supplierModalOptionField || '';
      if (!field) return;
      const value = button.dataset.supplierModalOptionValue || '';
      const formInput = view.querySelector(`[data-supplier-form] [name="${CSS.escape(field)}"]`);
      if (formInput) formInput.value = value;
      onSupplierAction.onDraftChange?.({ [field]: value });
      onSupplierFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-supplier-field]').forEach((field) => {
    const isTextLike = field.tagName === 'INPUT' && field.type !== 'checkbox' && field.type !== 'radio';
    if (isTextLike) {
      // Text inputs: silent update only — blur/change re-renders corrupt typing by replacing the DOM mid-keystroke
      field.addEventListener('input', () => {
        if (!field.name) return;
        onSupplierAction.onDraftChangeSilent?.({ [field.name]: field.value });
      });
    } else {
      // Selects, checkboxes: change is safe to re-render (no cursor to disrupt). A checkbox's
      // `.value` is a fixed static string ("on") regardless of checked state, so it must read
      // `.checked` instead — same footgun already fixed for the final submit read above.
      const isCheckbox = field.tagName === 'INPUT' && field.type === 'checkbox';
      field.addEventListener('change', () => {
        if (!field.name) return;
        onSupplierAction.onPreserveFocus?.(field);
        onSupplierAction.onDraftChange?.({ [field.name]: isCheckbox ? field.checked : field.value });
      });
    }
  });

  view.querySelectorAll('[data-supplier-view]').forEach((button) => {
    button.addEventListener('click', () => onSupplierFilterChange?.({ view: button.dataset.supplierView }));
  });

  view.querySelectorAll('[data-supplier-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => onSupplierAction.onSelect?.(checkbox.dataset.supplierSelect, checkbox.checked));
  });

  view.querySelector('[data-supplier-select-all]')?.addEventListener('change', (event) => {
    onSupplierAction.onSelectAll?.(visibleItems.map((item) => item.id), event.target.checked);
  });

  view.querySelectorAll('[data-supplier-edit]').forEach((button) => {
    button.addEventListener('click', () => onSupplierAction.onEdit?.(button.dataset.supplierEdit || null));
  });

  view.querySelectorAll('[data-supplier-delete]').forEach((button) => {
    button.addEventListener('click', () => onSupplierAction.onRequestDelete?.({ ids: [button.dataset.supplierDelete], mode: 'single' }));
  });

  view.querySelector('[data-supplier-delete-selected]')?.addEventListener('click', () => {
    onSupplierAction.onRequestDelete?.({ ids: parseJson(view.querySelector('[data-supplier-delete-selected]')?.dataset.supplierDeleteSelected), mode: 'bulk' });
  });

  const importInput = view.querySelector('[data-supplier-import-input]');
  view.querySelector('[data-supplier-import-trigger]')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) onSupplierAction.onImport?.(file);
    event.target.value = '';
  });

  view.querySelectorAll('[data-supplier-export]').forEach((button) => {
    button.addEventListener('click', () => onSupplierAction.onExport?.(button.dataset.supplierExport));
  });

  view.querySelector('[data-supplier-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitSupplierForm();
  });

  view.querySelector('[data-supplier-save]')?.addEventListener('click', () => {
    submitSupplierForm();
  });

  const supplierForm = view.querySelector('[data-supplier-form]');
  supplierForm?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    trapModalTab(event, supplierForm);
  });

  view.querySelector('[data-supplier-map-search]')?.addEventListener('click', () => {
    const addressField = view.querySelector('[name="address"]');
    const address = String(addressField?.value || '').trim();
    if (!address) {
      addressField?.focus();
      return;
    }
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`, '_blank', 'noopener,noreferrer');
  });

  view.querySelectorAll('[data-supplier-close]').forEach((button) => {
    button.addEventListener('click', () => onSupplierAction.onClose?.());
  });

  view.querySelector('[data-supplier-confirm-delete]')?.addEventListener('click', () => onSupplierAction.onConfirmDelete?.());
  view.querySelector('[data-supplier-cancel-delete]')?.addEventListener('click', () => onSupplierAction.onCancelDelete?.());
  view.querySelector('[data-supplier-toast-dismiss]')?.addEventListener('click', () => onSupplierAction.onDismissToast?.());
}

function renderSupplierBody(suppliers, items, view, selectedIds) {
  if (suppliers.status === 'loading') {
    return renderLoadingPanel('Loading suppliers', 'Fetching supplier records, categories, contacts, and terms.');
  }

  if (suppliers.status === 'error') {
    return renderNotice(suppliers.error || 'Could not load suppliers.', 'error');
  }

  if (!items.length) {
    return renderNotice('No suppliers found.<br><small>Try changing your search or category filter, or add a new supplier.</small>', 'empty', true);
  }

  return view === 'tiles'
    ? renderTileView(items, selectedIds)
    : renderListView(items, selectedIds);
}

function renderListView(items, selectedIds) {
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedIds.has(String(item.id)));
  return `
    <section class="suppliersModule__list" aria-label="Supplier list" data-scroll-key="suppliers-list">
      <div class="suppliersModule__listHead">
        <label><input type="checkbox" data-supplier-select-all ${allVisibleSelected ? 'checked' : ''} /></label>
        <span>Supplier</span>
        <span>Contact</span>
        <span>Category</span>
        <span>Lead Time</span>
        <span>Terms</span>
        <span>Actions</span>
      </div>
      <div class="suppliersModule__listBody">
        ${items.map((item) => `
          <article class="suppliersModule__row ${selectedIds.has(String(item.id)) ? 'is-selected' : ''}">
            <label><input type="checkbox" data-supplier-select="${escapeAttribute(item.id)}" ${selectedIds.has(String(item.id)) ? 'checked' : ''} /></label>
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              <small>${escapeHtml(item.accountNumber || 'No account number')}</small>
            </div>
            <div>
              <strong>${escapeHtml(item.contactPerson || 'No contact')}</strong>
              <small>${escapeHtml(item.email || item.phone || 'No contact route')}</small>
            </div>
            <span>${escapeHtml(item.category)}</span>
            <span>${Number(item.leadTime || 0)} days</span>
            <span>${escapeHtml(item.paymentTerms)}</span>
            <div class="suppliersModule__rowActions">
              ${renderShortcut(item.email, 'mailto', 'Email supplier', 'mail')}
              ${renderShortcut(item.phone, 'tel', 'Call supplier', 'phone')}
              ${renderIconButton('edit', 'Edit supplier', `data-supplier-edit="${escapeAttribute(item.id)}"`)}
              ${renderIconButton('trash', 'Remove supplier', `data-supplier-delete="${escapeAttribute(item.id)}"`)}
            </div>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderTileView(items, selectedIds) {
  return `
    <section class="suppliersModule__tiles" aria-label="Supplier tile view">
      ${items.map((item) => `
        <article class="suppliersModule__card ${selectedIds.has(String(item.id)) ? 'is-selected' : ''}">
          <div class="suppliersModule__cardTop">
            <label><input type="checkbox" data-supplier-select="${escapeAttribute(item.id)}" ${selectedIds.has(String(item.id)) ? 'checked' : ''} /></label>
            <span>${escapeHtml(item.category)}</span>
          </div>
          <h2>${escapeHtml(item.name)}</h2>
          <p>${escapeHtml(item.contactPerson || 'No contact person assigned')}</p>
          <div class="suppliersModule__metricGrid">
            <span><strong>${Number(item.leadTime || 0)}</strong><em>Lead Days</em></span>
            <span><strong>${escapeHtml(item.paymentTerms)}</strong><em>Terms</em></span>
          </div>
          <div class="suppliersModule__cardActions">
            ${renderShortcut(item.email, 'mailto', 'Email supplier', 'mail')}
            ${renderShortcut(item.phone, 'tel', 'Call supplier', 'phone')}
            ${renderIconButton('edit', 'Edit supplier', `data-supplier-edit="${escapeAttribute(item.id)}"`)}
            ${renderIconButton('trash', 'Remove supplier', `data-supplier-delete="${escapeAttribute(item.id)}"`)}
          </div>
        </article>
      `).join('')}
    </section>
  `;
}

function renderDropdown({ id, label, value, openDropdown, options }) {
  const activeOption = options.find((option) => option.value === value) || options[0];
  const isOpen = openDropdown === id;
  return `
    <div class="suppliersModule__dropdown ${isOpen ? 'suppliersModule__dropdown--open' : ''}" data-supplier-dropdown-root>
      ${renderFieldHelpLabel(label, id === 'category' ? 'Filter suppliers by their assigned category, such as produce, beverage, or packaging.' : '')}
      <button type="button" data-supplier-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(activeOption.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="suppliersModule__dropdownMenu">
        ${options.map((option) => `
          <button type="button" data-supplier-option data-supplier-option-group="${escapeAttribute(id)}" data-supplier-option-value="${escapeAttribute(option.value)}" class="${option.value === value ? 'is-active' : ''}">
            ${escapeHtml(option.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderActionDropdown(openDropdown, actionStatus = '') {
  const isOpen = openDropdown === 'supplierActions';
  return `
    <div class="suppliersModule__dropdown suppliersModule__actionDropdown ${isOpen ? 'suppliersModule__dropdown--open' : ''}" data-supplier-dropdown-root>
      <button type="button" data-supplier-dropdown="supplierActions" aria-expanded="${isOpen}">
        ${icon('download')}
        <strong>Action Items</strong>
        ${icon('chevron')}
      </button>
      <div class="suppliersModule__dropdownMenu">
        <button type="button" data-supplier-import-trigger ${actionStatus === 'importing' ? 'disabled' : ''}>
          ${icon('upload')}
          <span>${actionStatus === 'importing' ? 'Importing' : 'Import Bulk'}</span>
        </button>
        <span class="suppliersModule__fileDivider">Import Templates</span>
        <button type="button" data-supplier-export="template-xlsx">${icon('download')}<span>XLSX Template</span></button>
        <span class="suppliersModule__fileDivider">Export Visible</span>
        <button type="button" data-supplier-export="xlsx">${icon('download')}<span>XLSX</span></button>
        <button type="button" data-supplier-export="pdf">${icon('download')}<span>PDF</span></button>
      </div>
    </div>
  `;
}

function renderSupplierModal(suppliers) {
  const item = suppliers.editingItem;
  if (!item) return '';
  const isNew = item.id === '__new__';
  const validationErrors = suppliers.validationErrors || {};
  const openDropdown = suppliers.filters?.openDropdown || '';
  const categoryOptions = getSupplierModalCategoryOptions(suppliers.items || [], item.category || 'General');
  return `
    <div class="suppliersModule__modalBackdrop">
      <form class="suppliersModule__modal" data-supplier-form data-supplier-id="${isNew ? '' : escapeAttribute(item.id)}" role="dialog" aria-modal="true" aria-labelledby="supplier-modal-title">
        <div class="suppliersModule__modalHeader">
          <div>
            <span>Supplier Record</span>
            <h2 id="supplier-modal-title">${isNew ? 'Add Supplier' : 'Edit Supplier'}</h2>
          </div>
          <button type="button" class="suppliersModule__ghostIcon" data-supplier-close aria-label="Close">${icon('x')}</button>
        </div>
        ${suppliers.actionError ? renderNotice(suppliers.actionError, 'error') : ''}
        <div class="suppliersModule__modalGrid">
          ${renderField('Supplier Name', 'name', item.name, validationErrors.name, true)}
          ${renderField('Contact Person', 'contactPerson', item.contactPerson, validationErrors.contactPerson, true)}
          ${renderField('Email', 'email', item.email, validationErrors.email, false, 'text', 'email')}
          ${renderField('Phone', 'phone', item.phone, validationErrors.phone, false, 'tel')}
          ${renderSupplierCategoryCombobox({
            value: item.category != null ? item.category : 'General',
            options: categoryOptions,
            openDropdown,
            error: validationErrors.category
          })}
          ${renderLeadTimeField(item.leadTime || 0, validationErrors.leadTime)}
          ${renderSupplierModalDropdown({
            field: 'paymentTerms',
            label: 'Payment Terms',
            value: item.paymentTerms || 'COD',
            options: PAYMENT_TERM_OPTIONS.map((option) => ({ value: option, label: option })),
            openDropdown,
            error: validationErrors.paymentTerms,
            help: 'Commercial payment terms agreed with the supplier.'
          })}
          ${renderField('Account Number', 'accountNumber', item.accountNumber, validationErrors.accountNumber)}
          <label class="suppliersModule__field suppliersModule__field--checkbox" title="A non-VAT-registered supplier never charges VAT on anything they sell, regardless of the item — GRVs, Purchase Orders, and Credit Notes for this supplier will never carry VAT while this is off.">
            <span class="suppliersModule__checkboxRow">
              <input type="checkbox" name="vatRegistered" data-supplier-field data-focus-key="supplier-vatRegistered" ${item.vatRegistered === false ? '' : 'checked'} />
              <span>VAT Registered</span>
            </span>
          </label>
          ${renderAddressField(item.address, validationErrors.address)}
        </div>
        <div class="suppliersModule__modalFooter">
          <button type="button" class="suppliersModule__secondary" data-supplier-close>Cancel</button>
          <button type="button" class="suppliersModule__primary" data-supplier-save ${suppliers.actionStatus === 'saving' ? 'disabled' : ''}>
            ${suppliers.actionStatus === 'saving' ? 'Saving' : 'Save Supplier'}
          </button>
        </div>
      </form>
    </div>
  `;
}

function getSupplierModalCategoryOptions(items = [], currentValue = '') {
  const categories = new Set(['General']);
  getCategories(items).forEach((category) => categories.add(category));
  if (String(currentValue || '').trim()) categories.add(String(currentValue).trim());
  return [...categories].sort((a, b) => a.localeCompare(b)).map((category) => ({
    value: category,
    label: category
  }));
}

function renderLeadTimeField(value = 0, error = '') {
  return `
    <label class="${error ? 'suppliersModule__field suppliersModule__field--error' : 'suppliersModule__field'}">
      ${renderFieldHelpLabel('Lead Time', 'Typical number of days between placing an order and receiving stock.')}
      <div class="suppliersModule__inputSuffix">
        <input
          type="number"
          min="0"
          step="1"
          name="leadTime"
          data-supplier-field
          data-focus-key="supplier-leadTime"
          value="${escapeAttribute(value)}"
          inputmode="numeric"
          required
        />
        <span title="${escapeAttribute(`${Number(value || 0)} Days`)}">Days</span>
      </div>
      ${error ? `<small class="suppliersModule__fieldError">${escapeHtml(error)}</small>` : ''}
    </label>
  `;
}

function renderSupplierModalDropdown({ field, label, value, options = [], openDropdown = '', error = '', help = '' } = {}) {
  const dropdownId = `supplier-modal-${field}`;
  const normalizedValue = options.some((option) => String(option.value) === String(value))
    ? value
    : options[0]?.value || '';
  const activeOption = options.find((option) => String(option.value) === String(normalizedValue)) || options[0] || { value: '', label };
  const isOpen = openDropdown === dropdownId;
  return `
    <label class="${error ? 'suppliersModule__field suppliersModule__field--error' : 'suppliersModule__field'}">
      ${renderFieldHelpLabel(label, help)}
      <input type="hidden" name="${escapeAttribute(field)}" value="${escapeAttribute(normalizedValue)}" required />
      <div class="suppliersModule__dropdown suppliersModule__modalDropdown ${isOpen ? 'suppliersModule__dropdown--open' : ''}" data-supplier-dropdown-root>
        <button type="button" data-supplier-dropdown="${escapeAttribute(dropdownId)}" aria-expanded="${isOpen}" data-focus-key="supplier-${escapeAttribute(field)}">
          <strong>${escapeHtml(activeOption.label)}</strong>
          ${icon('chevron')}
        </button>
        <div class="suppliersModule__dropdownMenu">
          ${options.map((option) => `
            <button
              type="button"
              data-supplier-modal-option
              data-supplier-modal-option-field="${escapeAttribute(field)}"
              data-supplier-modal-option-value="${escapeAttribute(option.value)}"
              class="${String(option.value) === String(normalizedValue) ? 'is-active' : ''}"
            >
              ${escapeHtml(option.label)}
            </button>
          `).join('')}
        </div>
      </div>
      ${error ? `<small class="suppliersModule__fieldError">${escapeHtml(error)}</small>` : ''}
    </label>
  `;
}

function renderSupplierCategoryCombobox({ value = 'General', options = [], openDropdown = '', error = '' } = {}) {
  const dropdownId = 'supplier-modal-category';
  const isOpen = openDropdown === dropdownId;
  return `
    <label class="${error ? 'suppliersModule__field suppliersModule__field--error' : 'suppliersModule__field'}">
      ${renderFieldHelpLabel('Category', 'Group suppliers into buckets such as produce, beverage, meat, or packaging.')}
      <div class="suppliersModule__combobox suppliersModule__modalDropdown ${isOpen ? 'suppliersModule__dropdown--open' : ''}" data-supplier-dropdown-root>
        <div class="suppliersModule__comboboxRow">
          <input
            type="text"
            name="category"
            value="${escapeAttribute(value)}"
            data-supplier-field
            data-focus-key="supplier-category"
            placeholder="Type or pick a category…"
            autocomplete="off"
          />
          <button type="button" class="suppliersModule__comboboxToggle" data-supplier-dropdown="${escapeAttribute(dropdownId)}" aria-expanded="${isOpen}" aria-label="Show categories">
            ${icon('chevron')}
          </button>
        </div>
        <div class="suppliersModule__dropdownMenu">
          ${options.map((option) => `
            <button
              type="button"
              data-supplier-modal-option
              data-supplier-modal-option-field="category"
              data-supplier-modal-option-value="${escapeAttribute(option.value)}"
              class="${String(option.value) === String(value) ? 'is-active' : ''}"
            >
              ${escapeHtml(option.label)}
            </button>
          `).join('')}
        </div>
      </div>
      ${error ? `<small class="suppliersModule__fieldError">${escapeHtml(error)}</small>` : ''}
    </label>
  `;
}

function renderAddressField(value = '', error = '') {
  return `
    <label class="suppliersModule__wide ${error ? 'suppliersModule__field suppliersModule__field--error' : 'suppliersModule__field'}">
      ${renderFieldHelpLabel('Address', 'Physical or billing address stored for supplier reference.')}
      <input name="address" data-supplier-field data-focus-key="supplier-address" value="${escapeAttribute(value)}" />
      ${error ? `<small class="suppliersModule__fieldError">${escapeHtml(error)}</small>` : ''}
    </label>
  `;
}

function renderInlineBulkDelete(ids, actionStatus) {
  return `
    <button
      type="button"
      class="suppliersModule__danger suppliersModule__bulkDeleteInline"
      data-supplier-delete-selected="${escapeAttribute(JSON.stringify(ids))}"
      ${actionStatus === 'deleting' ? 'disabled' : ''}
    >
      ${icon('trash')}
      <span>${actionStatus === 'deleting' ? 'Deleting' : `Delete Selected (${ids.length})`}</span>
    </button>
  `;
}

function renderDeleteDialog(suppliers) {
  const ids = suppliers.confirmDelete?.ids || [];
  if (!ids.length) return '';
  return `
    <div class="suppliersModule__modalBackdrop">
      <div class="suppliersModule__confirm">
        <span>Confirm Removal</span>
        <h2>Delete ${ids.length} supplier${ids.length === 1 ? '' : 's'}?</h2>
        <p>This removes the supplier record. Linked historic purchase orders will keep their supplier name snapshot.</p>
        <div class="suppliersModule__modalFooter">
          <button type="button" class="suppliersModule__secondary" data-supplier-cancel-delete>Cancel</button>
          <button type="button" class="suppliersModule__danger" data-supplier-confirm-delete ${suppliers.actionStatus === 'deleting' ? 'disabled' : ''}>
            ${suppliers.actionStatus === 'deleting' ? 'Deleting' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  `;
}

function trapModalTab(event, container) {
  const focusable = [...container.querySelectorAll([
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(','))].filter((element) => element.offsetParent !== null);

  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
    return;
  }

  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function renderNotice(message, type = 'empty', allowHtml = false) {
  return `<div class="suppliersModule__notice suppliersModule__notice--${escapeAttribute(type)}">${allowHtml ? message : escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast) return '';
  return `
    <div class="suppliersModule__toast suppliersModule__toast--${escapeAttribute(toast.type || 'success')}">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-supplier-toast-dismiss aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function renderField(label, name, value = '', error = '', required = false, type = 'text', inputMode = '') {
  const helpText = {
    name: 'The trading name of the supplier used across purchase orders, GRVs, and credit notes.',
    contactPerson: 'Primary contact person for ordering, follow-ups, and account questions.',
    email: 'Email address used when sending purchase orders or supplier communication.',
    phone: 'Direct phone number for fast supplier contact.',
    category: 'Group suppliers into buckets such as produce, beverage, meat, or packaging.',
    leadTime: 'Typical number of days between placing an order and receiving stock.',
    paymentTerms: 'Commercial payment terms agreed with the supplier.',
    accountNumber: 'Your account reference or code with this supplier.',
    address: 'Physical or billing address stored for supplier reference.'
  };
  return `
    <label class="${error ? 'suppliersModule__field suppliersModule__field--error' : 'suppliersModule__field'}">
      ${renderFieldHelpLabel(label, helpText[name] || '')}
      <input
        type="${escapeAttribute(type)}"
        name="${escapeAttribute(name)}"
        data-supplier-field
        data-focus-key="supplier-${escapeAttribute(name)}"
        value="${escapeAttribute(value)}"
        ${inputMode ? `inputmode="${escapeAttribute(inputMode)}"` : ''}
        ${required ? 'required' : ''}
        autocomplete="off"
      />
      ${error ? `<small class="suppliersModule__fieldError">${escapeHtml(error)}</small>` : ''}
    </label>
  `;
}

function renderViewButton(view, activeView) {
  return `
    <button type="button" class="${view === activeView ? 'is-active' : ''}" data-supplier-view="${escapeAttribute(view)}" aria-label="${escapeAttribute(view)} view">
      ${icon(view === 'list' ? 'list' : 'grid')}
    </button>
  `;
}

function renderIconButton(iconName, label, attributes) {
  return `<button type="button" class="suppliersModule__iconButton" ${attributes} aria-label="${escapeAttribute(label)}">${icon(iconName)}</button>`;
}

function renderShortcut(value, protocol, label, iconName) {
  if (!value) return `<span class="suppliersModule__shortcut suppliersModule__shortcut--disabled">${icon(iconName)}</span>`;
  return `<a class="suppliersModule__shortcut" href="${protocol}:${escapeAttribute(value)}" aria-label="${escapeAttribute(label)}">${icon(iconName)}</a>`;
}

function filterSuppliers(items, filters) {
  const query = String(filters.query || '').trim().toLowerCase();
  return (items || []).filter((item) => {
    const matchesQuery = !query ||
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.contactPerson || '').toLowerCase().includes(query) ||
      String(item.email || '').toLowerCase().includes(query);
    const matchesCategory = !filters.category || item.category === filters.category;
    return matchesQuery && matchesCategory;
  });
}

function getCategories(items) {
  return [...new Set((items || []).map((item) => String(item.category || '').trim()).filter(Boolean))].sort();
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function icon(name) {
  const paths = {
    chevron: '<path d="m6 9 6 6 6-6"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    grid: '<path d="M3 3h7v7H3z"/><path d="M14 3h7v7h-7z"/><path d="M14 14h7v7h-7z"/><path d="M3 14h7v7H3z"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    mail: '<path d="M4 4h16v16H4z"/><path d="m22 6-10 7L2 6"/>',
    mapPin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.92.33 1.82.63 2.68a2 2 0 0 1-.45 2.11L8 9.8a16 16 0 0 0 6.2 6.2l1.29-1.29a2 2 0 0 1 2.11-.45c.86.3 1.76.51 2.68.63A2 2 0 0 1 22 16.92z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
