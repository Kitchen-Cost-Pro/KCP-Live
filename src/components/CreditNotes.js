import '../styles/creditNotes.css';
import '../styles/fieldHelp.css';
import { bindCustomCalendarEvents, renderCustomCalendarOverlay } from './CustomCalendar.js';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';
import { formatDisplayDate, shiftMonthKey, startOfMonthKey, todayLocal } from '../utils/date.js';

export function renderCreditNotes({ state, onCreditNoteFilterChange, onCreditNoteAction = {} } = {}) {
  const creditNotes = state.creditNotes || {};
  const draft = creditNotes.draftNote || createEmptyDraft();
  const filters = {
    query: '',
    stockSearch: '',
    stockCategory: '',
    grvQuery: '',
    overlay: '',
    openDropdown: '',
    calendarCursor: '',
    selectedStockIds: [],
    selectedLineIndexes: [],
    ...creditNotes.filters
  };
  const supplierMatches = getSupplierMatches(creditNotes.suppliers || [], draft.supplierName || '');
  const stockMatches = getStockMatches(creditNotes.stockItems || [], filters.stockSearch || '', filters.stockCategory || '', draft.items || []);
  const grvMatches = getProcessedGrvMatches(creditNotes.processedGrvs || [], filters.grvQuery || '');
  const totals = calculateTotals(draft, getVatRate(state));
  const selectedStockIds = new Set((filters.selectedStockIds || []).map(String));
  const selectedLineIndexes = new Set((filters.selectedLineIndexes || []).map(String));
  const headerReady = Boolean(String(draft.supplierName || '').trim() && String(draft.cnNumber || '').trim() && String(draft.date || '').trim() && String(draft.locationId || '').trim());

  const view = document.createElement('section');
  view.id = 'view-credit-note';
  view.className = 'cnView';
  if (creditNotes.status === 'loading' && !(creditNotes.stockItems || []).length && !(creditNotes.suppliers || []).length) {
    view.innerHTML = renderLoadingPanel('Loading credit notes', 'Fetching suppliers, stock items and history.');
    return view;
  }
  view.innerHTML = `
    <div class="cn-frame">
      <div class="cn-layout">
        <aside class="cn-sidebar">
          <article class="cn-card cn-sidecard">
            <h3 class="cn-side-title">Record Return</h3>
            <div class="cn-stack">
              <div class="cn-inputWrap" data-cn-dropdown-root>
                <input
                  type="search"
                  class="cn-input"
                  value="${escapeAttribute(draft.supplierName || '')}"
                  placeholder="Search supplier"
                  data-cn-draft-field="supplierName"
                  data-focus-key="cn-supplier"
                  data-cn-supplier-input
                  autocomplete="off"
                  role="combobox"
                  aria-expanded="${filters.openDropdown === 'supplier' ? 'true' : 'false'}"
                />
                <button type="button" class="cn-fieldIcon" data-cn-open-dropdown="supplier" aria-label="Browse suppliers">
                  ${icon('search')}
                </button>
                ${renderSupplierDropdown(supplierMatches, filters.openDropdown, draft.supplierName)}
              </div>

              <input
                type="text"
                class="cn-input"
                value="${escapeAttribute(draft.cnNumber || '')}"
                placeholder="Credit Note #"
                data-cn-draft-field="cnNumber"
                data-focus-key="cn-number"
                autocomplete="off"
              />

              <button
                type="button"
                class="cn-input cn-selectLike cn-dateTrigger"
                data-cn-open-calendar
                data-cn-calendar-date="${escapeAttribute(draft.date || todayLocal())}"
                data-focus-key="cn-date"
              >
                <span>${escapeHtml(formatDisplayDate(draft.date || todayLocal()))}</span>
                ${icon('calendar')}
              </button>

              ${renderCnLocationPicker(draft, creditNotes.locations || [], filters.openDropdown, filters.headerLocationQuery || '')}

              <label class="cn-pill">
                <input
                  type="checkbox"
                  class="cn-check"
                  ${draft.pricesIncludeVat ? 'checked' : ''}
                  data-cn-price-mode
                />
                <span class="cn-muted">Price includes VAT</span>
              </label>

              <label class="cn-notesField">
                ${renderFieldHelpLabel('Reasoning', 'Mandatory explanation for why this credit is being processed, such as damaged stock, return to supplier, or invoice dispute.')}
                <textarea
                  class="cn-textarea"
                  placeholder="Why is this credit being processed?"
                  data-cn-draft-field="notes"
                  data-focus-key="cn-notes"
                >${escapeHtml(draft.notes || '')}</textarea>
              </label>

              <button type="button" class="cn-secondary" data-cn-open-grv>
                ${icon('clipboard')}
                <span>Select Received PO / GRV</span>
              </button>
            </div>
          </article>
        </aside>

        <section class="cn-card cn-draft-panel">
          <div class="cn-topbar">
            <div class="cn-topbarTitle">
              <h3>Draft Return Breakdown</h3>
              <span>${(draft.items || []).length} ${(draft.items || []).length === 1 ? 'Item' : 'Items'}</span>
            </div>
            <div class="cn-topbarActions">
              <button type="button" class="cn-outlineButton" data-cn-select-all-lines ${(draft.items || []).length ? '' : 'disabled'}>Select all</button>
              <button type="button" class="cn-outlineButton cn-outlineButton--danger" data-cn-remove-selected ${(selectedLineIndexes.size ? '' : 'disabled')}>Remove selected</button>
              <button type="button" class="cn-outlineButton cn-outlineButton--danger" data-cn-clear-all ${(draft.items || []).length ? '' : 'disabled'}>Clear all</button>
              <button type="button" class="cn-add-primary" data-cn-open-stock ${headerReady ? '' : 'disabled'}>+ Add Item</button>
            </div>
          </div>

          <div class="cn-draft-scroll">
            ${(draft.items || []).length ? renderDraftTable(draft, getVatRate(state), selectedLineIndexes, creditNotes.locations || [], filters.openDropdown || '') : `
              <div class="cn-empty"><span>No returns drafted.</span></div>
            `}
          </div>

          <div class="cn-bottombar">
            <div class="cn-summary">
              <div><span>Ex-VAT</span><strong class="cn-valueNegative">${formatSignedCurrency(-totals.subtotal)}</strong></div>
              <div><span>VAT</span><strong class="cn-valueNegative">${formatSignedCurrency(-totals.vat)}</strong></div>
            </div>
            <button type="button" class="cn-commit-primary" data-cn-save ${(draft.items || []).length && creditNotes.actionStatus !== 'saving' ? '' : 'disabled'}>
              <div class="cn-commit-label">Commit Credit</div>
              <div class="cn-commit-value">${formatSignedCurrency(-totals.totalIncl)}</div>
            </button>
          </div>
        </section>
      </div>
    </div>

    ${filters.overlay === 'stock' ? renderStockOverlay(stockMatches, filters, creditNotes.locations || [], selectedStockIds, headerReady, draft.locationId || '') : ''}
    ${filters.overlay === 'grv' ? renderProcessedGrvOverlay(grvMatches, filters.grvQuery || '') : ''}
    ${filters.overlay === 'calendar' ? renderCustomCalendarOverlay({
      title: 'Select Credit Note Date',
      selectedDate: draft.date || todayLocal(),
      cursorDate: filters.calendarCursor || draft.date || todayLocal()
    }) : ''}
    ${creditNotes.lineDetailDraft?.entries?.length ? renderLineDetailOverlay(creditNotes.lineDetailDraft, draft, creditNotes.sites || [], creditNotes.locations || [], filters.openDropdown) : ''}
    ${filters.overlay === 'clear-confirm' ? renderClearConfirmOverlay() : ''}
    ${renderCnLineLocationModal(draft, creditNotes.locations || [], filters.openDropdown)}
    ${renderToast(creditNotes.toast)}
  `;

  bindCreditNoteEvents(view, state, filters, draft, onCreditNoteFilterChange, onCreditNoteAction);
  bindFieldHelpTooltips(view);
  return view;
}

function bindCreditNoteEvents(view, state, filters, draft, onCreditNoteFilterChange, onCreditNoteAction) {
  const closeOverlay = () => onCreditNoteFilterChange?.({ overlay: '', selectedStockIds: [], calendarCursor: '', grvQuery: '' });

  view.querySelectorAll('[data-cn-draft-field]').forEach((field) => {
    const apply = () => {
      onCreditNoteAction.onPreserveFocus?.(field);
      const payload = { [field.dataset.cnDraftField]: field.value };
      if (field.hasAttribute('data-cn-supplier-input')) {
        payload.supplierId = '';
        if (filters.openDropdown !== 'supplier') onCreditNoteFilterChange?.({ openDropdown: 'supplier' });
      }
      onCreditNoteAction.onDraftChange?.(payload);
    };
    field.addEventListener('input', apply);
    field.addEventListener('change', apply);
    if (field.hasAttribute('data-cn-supplier-input')) {
      const openSupplierDropdown = () => {
        if (filters.openDropdown !== 'supplier') onCreditNoteFilterChange?.({ openDropdown: 'supplier' });
      };
      field.addEventListener('focus', openSupplierDropdown);
      field.addEventListener('click', openSupplierDropdown);
      field.addEventListener('mousedown', openSupplierDropdown);
    }
  });

  view.querySelector('[data-cn-price-mode]')?.addEventListener('change', (event) => {
    onCreditNoteAction.onDraftChange?.({ pricesIncludeVat: event.currentTarget.checked });
  });

  view.querySelectorAll('[data-cn-location-input]').forEach((field) => {
    const openLocationDropdown = () => {
      if (filters.openDropdown !== 'cn-header-location') {
        onCreditNoteFilterChange?.({ openDropdown: 'cn-header-location', headerLocationQuery: field.value });
      }
    };
    field.addEventListener('focus', openLocationDropdown);
    field.addEventListener('click', openLocationDropdown);
    field.addEventListener('input', () => onCreditNoteFilterChange?.({
      openDropdown: 'cn-header-location',
      headerLocationQuery: field.value
    }));
  });

  view.querySelectorAll('[data-cn-open-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.cnOpenDropdown || '';
      onCreditNoteFilterChange?.({ openDropdown: filters.openDropdown === target ? '' : target });
    });
  });

  view.querySelectorAll('[data-cn-dropdown-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const query = String(event.target.value || '').trim().toLowerCase();
      input.closest('.cn-dropdownMenu')?.querySelectorAll('[data-cn-option]').forEach((button) => {
        const label = String(button.textContent || '').toLowerCase();
        button.hidden = Boolean(query) && !label.includes(query);
      });
    });
  });

  view.querySelectorAll('[data-cn-header-location]').forEach((button) => {
    button.addEventListener('click', () => {
      onCreditNoteAction.onDraftChange?.({
        locationId: button.dataset.cnHeaderLocation || '',
        locationName: button.dataset.cnHeaderLocationName || ''
      });
      onCreditNoteFilterChange?.({ openDropdown: '', headerLocationQuery: '' });
    });
  });

  view.querySelectorAll('[data-cn-close-line-modal]').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (el === event.currentTarget) onCreditNoteFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-cn-supplier-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onCreditNoteAction.onDraftChange?.({
        supplierId: button.dataset.cnSupplierId || '',
        supplierName: button.dataset.cnSupplierName || ''
      });
      onCreditNoteFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-cn-line-location-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onCreditNoteAction.onUpdateLine?.(Number(button.dataset.cnLineLocationIndex || 0), {
        locationId: button.dataset.cnLineLocationOption || '',
        locationName: button.dataset.cnLineLocationName || ''
      });
      onCreditNoteFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-cn-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.cnOptionAction || '';
      const value = button.dataset.cnOptionValue || '';
      if (action === 'stockCategory') {
        onCreditNoteFilterChange?.({ stockCategory: value, openDropdown: '' });
        return;
      }
      if (action === 'stockLocation') {
        onCreditNoteAction.onDraftChange?.({
          locationId: value,
          locationName: buttonLabelForLocation(state.creditNotes.locations || [], value)
        });
        onCreditNoteFilterChange?.({ openDropdown: '' });
        return;
      }
      if (action === 'detailLocation') {
        onCreditNoteAction.onLineDetailLocationChange?.(value);
        onCreditNoteFilterChange?.({ openDropdown: '' });
      } else if (action === 'detailSite') {
        const firstLocationId = firstLocationIdForSite(state.creditNotes.locations || [], value);
        if (firstLocationId) onCreditNoteAction.onLineDetailLocationChange?.(firstLocationId);
        onCreditNoteFilterChange?.({ openDropdown: '' });
      }
    });
  });

  view.addEventListener('click', (event) => {
    if (!filters.openDropdown) return;
    if (event.target.closest('[data-cn-dropdown-root]')) return;
    onCreditNoteFilterChange?.({ openDropdown: '', headerLocationQuery: '' });
  });

  view.querySelector('[data-cn-open-stock]')?.addEventListener('click', () => {
    onCreditNoteFilterChange?.({ overlay: 'stock', selectedStockIds: [] });
  });

  view.querySelector('[data-cn-open-grv]')?.addEventListener('click', () => {
    onCreditNoteFilterChange?.({ overlay: 'grv', grvQuery: '' });
  });

  view.querySelector('[data-cn-open-calendar]')?.addEventListener('click', () => {
    onCreditNoteFilterChange?.({
      overlay: 'calendar',
      calendarCursor: startOfMonthKey(draft.date || todayLocal()),
      openDropdown: ''
    });
  });

  view.querySelector('[data-cn-stock-close]')?.addEventListener('click', closeOverlay);
  view.querySelector('[data-cn-grv-close]')?.addEventListener('click', closeOverlay);

  view.querySelector('[data-cn-stock-search]')?.addEventListener('input', (event) => {
    onCreditNoteFilterChange?.({ stockSearch: event.target.value });
  });

  view.querySelector('[data-cn-grv-search]')?.addEventListener('input', (event) => {
    onCreditNoteFilterChange?.({ grvQuery: event.target.value });
  });

  view.querySelectorAll('[data-cn-stock-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onCreditNoteAction.onToggleStockSelection?.(checkbox.dataset.cnStockSelect, checkbox.checked);
    });
  });

  view.querySelector('[data-cn-stock-select-all]')?.addEventListener('click', () => {
    onCreditNoteAction.onSelectAllShownStock?.();
  });

  view.querySelector('[data-cn-stock-clear]')?.addEventListener('click', () => {
    onCreditNoteAction.onClearStockSelection?.();
  });

  view.querySelector('[data-cn-stock-add]')?.addEventListener('click', () => {
    onCreditNoteAction.onAddSelectedStock?.();
  });

  view.querySelector('[data-cn-select-all-lines]')?.addEventListener('click', () => {
    onCreditNoteAction.onSelectAllLines?.();
  });

  view.querySelector('[data-cn-remove-selected]')?.addEventListener('click', () => {
    onCreditNoteAction.onRemoveSelectedLines?.();
  });

  view.querySelector('[data-cn-clear-all]')?.addEventListener('click', () => {
    onCreditNoteAction.onRequestClearAll?.();
  });

  view.querySelectorAll('[data-cn-grv-use]').forEach((button) => {
    button.addEventListener('click', () => {
      onCreditNoteAction.onHydrateFromGrv?.(button.dataset.cnGrvUse);
    });
  });

  view.querySelectorAll('[data-cn-edit-line]').forEach((button) => {
    button.addEventListener('click', () => onCreditNoteAction.onEditLine?.(Number(button.dataset.cnEditLine)));
  });

  view.querySelectorAll('[data-cn-line-field]').forEach((field) => {
    const apply = () => {
      onCreditNoteAction.onPreserveFocus?.(field);
      onCreditNoteAction.onUpdateLine?.(Number(field.dataset.cnLineIndex || 0), {
        [field.dataset.cnLineField]: field.value
      });
    };
    field.addEventListener('input', apply);
    field.addEventListener('change', apply);
    field.addEventListener('focus', () => {
      if (field instanceof HTMLInputElement && ['0', '0.00'].includes(String(field.value || '').trim())) {
        field.select();
      }
    });
  });

  view.querySelectorAll('[data-cn-line-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onCreditNoteAction.onToggleLineSelection?.(Number(checkbox.dataset.cnLineSelect), checkbox.checked);
    });
  });

  view.querySelectorAll('[data-cn-remove-line]').forEach((button) => {
    button.addEventListener('click', () => onCreditNoteAction.onRemoveLine?.(Number(button.dataset.cnRemoveLine)));
  });

  view.querySelectorAll('[data-cn-line-detail-field]').forEach((field) => {
    field.addEventListener('input', () => {
      onCreditNoteAction.onPreserveFocus?.(field);
      onCreditNoteAction.onLineDetailChange?.(Number(field.dataset.cnLineDetailIndex), {
        [field.dataset.cnLineDetailField]: field.value
      });
    });
  });

  view.querySelector('[data-cn-line-detail-location]')?.addEventListener('change', (event) => {
    onCreditNoteAction.onLineDetailLocationChange?.(event.target.value);
  });

  view.querySelector('[data-cn-line-detail-close]')?.addEventListener('click', () => onCreditNoteAction.onCloseLineDetail?.());
  view.querySelector('[data-cn-line-detail-back]')?.addEventListener('click', () => onCreditNoteAction.onBackLineDetail?.());
  view.querySelector('[data-cn-line-detail-apply]')?.addEventListener('click', () => onCreditNoteAction.onApplyLineDetail?.());
  view.querySelector('[data-cn-confirm-clear]')?.addEventListener('click', () => onCreditNoteAction.onConfirmClearAll?.());
  view.querySelector('[data-cn-cancel-clear]')?.addEventListener('click', () => onCreditNoteAction.onCancelClearAll?.());
  view.querySelector('[data-cn-save]')?.addEventListener('click', () => onCreditNoteAction.onSave?.());
  view.querySelector('[data-cn-toast-close]')?.addEventListener('click', () => onCreditNoteAction.onDismissToast?.());

  bindCustomCalendarEvents(view, {
    onClose: () => onCreditNoteFilterChange?.({ overlay: '', calendarCursor: '' }),
    onShift: (delta) => onCreditNoteFilterChange?.({
      calendarCursor: shiftMonthKey(filters.calendarCursor || draft.date || todayLocal(), delta)
    }),
    onSelect: (date) => {
      onCreditNoteAction.onDraftChange?.({ date });
      onCreditNoteFilterChange?.({ overlay: '', calendarCursor: '' });
    },
    onToday: (date) => {
      onCreditNoteAction.onDraftChange?.({ date });
      onCreditNoteFilterChange?.({ overlay: '', calendarCursor: '' });
    }
  });
}

function renderSupplierDropdown(matches = [], openDropdown = '', currentValue = '') {
  const normalizedValue = String(currentValue || '').trim();
  const isOpen = openDropdown === 'supplier';
  if (!isOpen) return '';
  return `
    <div class="cn-supplierMenu is-open">
      ${(matches.length ? matches : normalizedValue ? [] : []).map((supplier) => `
        <button type="button" class="cn-supplierOption" data-cn-supplier-option data-cn-supplier-id="${escapeAttribute(supplier.id)}" data-cn-supplier-name="${escapeAttribute(supplier.name)}">
          <strong>${escapeHtml(supplier.name)}</strong>
          <span>${escapeHtml(supplier.category || 'Supplier')}</span>
        </button>
      `).join('') || `<div class="cn-supplierEmpty">${normalizedValue ? 'No suppliers match that search.' : 'Start typing to filter suppliers.'}</div>`}
    </div>
  `;
}

function renderDraftTable(draft, vatRate, selectedLineIndexes = new Set(), locations = [], openDropdown = '') {
  return `
    <table class="cn-table">
      <thead>
        <tr>
          <th></th>
          <th>Item</th>
          <th>Location</th>
          <th>Pack Qty</th>
          <th>Pack Size</th>
          <th>Unit Price</th>
          <th>Pack Price / Total</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${(draft.items || []).map((item, index) => {
          const baseQty = Number(item.returnedQty || 0) * Math.max(Number(item.packSize || 1), 1);
          const lineTotalEx = Number(item.unitCost || 0) * baseQty;
          const lineVat = item.vatEnabled === false ? 0 : lineTotalEx * (vatRate / 100);
          const packPriceEx = Number(item.unitCost || 0) * Math.max(Number(item.packSize || 1), 1);
          const packPriceDisplay = item.vatEnabled !== false && draft.pricesIncludeVat
            ? packPriceEx * (1 + (vatRate / 100))
            : packPriceEx;
          const rawPackPriceDisplay = String(item.packPriceDisplay ?? '').trim();
          return `
            <tr>
              <td class="cn-tableCheck">
                <input type="checkbox" data-cn-line-select="${index}" ${selectedLineIndexes.has(String(index)) ? 'checked' : ''} />
              </td>
              <td>
                <strong>${escapeHtml(item.stockItemName || 'Unnamed Item')}</strong>
                <span>${escapeHtml(getCreditNoteLineUomLabel(item))} · VAT ${item.vatEnabled === false ? 'off' : 'on'} · <em class="cn-valueNegative">${formatSignedCurrency(-lineVat)}</em></span>
              </td>
              <td>${renderLineLocationDropdown(item, index, locations, openDropdown)}</td>
              <td>
                <input
                  type="text"
                  inputmode="decimal"
                  class="cn-tableInput"
                  value="${escapeAttribute(formatEditable(item.returnedQty || ''))}"
                  placeholder="0"
                  data-cn-line-field="returnedQty"
                  data-cn-line-index="${index}"
                  data-focus-key="cn-line-qty-${index}-${escapeAttribute(String(item.stockItemId || item.id || 'line'))}"
                  ${Number(item.maxReturnQty || item.originalOrderQty || 0) > 0 ? `aria-describedby="cn-max-qty-${index}"` : ''}
                />
                <small class="cn-cellHint" id="cn-max-qty-${index}">${Number(item.maxReturnQty || item.originalOrderQty || 0) > 0 ? `Max PO qty: ${escapeHtml(formatEditable(item.maxReturnQty || item.originalOrderQty))}` : 'pack qty'}</small>
              </td>
              <td>
                <span class="cn-packField">
                  <input
                    type="text"
                    inputmode="decimal"
                    class="cn-tableInput cn-tableInput--pack"
                    value="${escapeAttribute(formatEditable(item.packSize || '1'))}"
                    placeholder="1"
                    data-cn-line-field="packSize"
                    data-cn-line-index="${index}"
                    data-focus-key="cn-line-pack-${index}-${escapeAttribute(String(item.stockItemId || item.id || 'line'))}"
                    ${isCreditNoteLineCustomUom(item) ? 'readonly title="Pack size is set by the selected UOM."' : ''}
                  />
                  <em>${escapeHtml(String(item.unit || 'ea').toUpperCase())}</em>
                </span>
                <small class="cn-cellHint">${escapeHtml(String(item.unit || 'ea').toUpperCase())} / pack</small>
              </td>
              <td class="cn-valueNeutral">${formatCurrency(item.unitCost || 0)}</td>
              <td>
                <span class="cn-moneyField">
                  <i>R</i>
                  <input
                    type="text"
                    inputmode="decimal"
                    class="cn-tableInput cn-tableInput--money"
                    value="${escapeAttribute(rawPackPriceDisplay || formatEditable(Number(packPriceDisplay.toFixed(2))))}"
                    data-cn-line-field="packPriceDisplay"
                    data-cn-line-index="${index}"
                    data-focus-key="cn-line-price-${index}-${escapeAttribute(String(item.stockItemId || item.id || 'line'))}"
                  />
                </span>
                <small class="cn-cellHint">${draft.pricesIncludeVat && item.vatEnabled !== false ? 'pack incl VAT' : 'pack ex VAT'}</small>
                <strong class="cn-valueNegative cn-lineTotal">${formatSignedCurrency(-lineTotalEx)}</strong>
              </td>
              <td>
                <div class="cn-rowActions">
                  <button type="button" data-cn-remove-line="${index}" title="Remove line">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderLineLocationDropdown(item, index, locations = [], openDropdown = '') {
  const currentLocationId = String(item.locationId || '');
  const options = (locations || []).filter((location) => String(location.id || '').trim());
  const current = options.find((location) => String(location.id || '') === currentLocationId) || null;
  const fullName = current ? (current.displayName || current.name || current.id) : 'Select location';
  const currentName = fullName.length > 12 ? `${fullName.slice(0, 11)}…` : fullName;
  const hasLocation = Boolean(current);
  const modalId = `cn-line-location-${index}`;
  return `
    <div class="cn-lineLocation">
      <button type="button" class="cn-lineLocationButton ${hasLocation ? '' : 'cn-lineLocationButton--empty'}"
        data-cn-open-dropdown="${escapeAttribute(modalId)}"
        aria-haspopup="dialog"
      >
        <strong>${escapeHtml(currentName)}</strong>
        ${icon('chevronDown')}
      </button>
    </div>
  `;
}

function renderCnLineLocationModal(draft, locations = [], openDropdown = '') {
  const match = String(openDropdown || '').match(/^cn-line-location-(\d+)$/);
  if (!match) return '';
  const index = Number(match[1]);
  const item = (draft.items || [])[index];
  if (!item) return '';
  const currentLocationId = String(item.locationId || '');
  const options = (locations || []).filter((location) => String(location.id || '').trim());
  return `
    <div class="po-locationModalBackdrop" data-cn-close-line-modal>
      <div class="po-locationModal" role="dialog" aria-modal="true" aria-label="Select return location">
        <div class="po-locationModalHeader">
          <h3>Change Line Location</h3>
          <button type="button" class="po-locationModalClose" data-cn-close-line-modal aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <p class="po-locationModalSub">Select where <strong>${escapeHtml(item.stockItemName || 'this item')}</strong> is being returned from.</p>
        <div class="po-locationModalList">
          ${options.length ? options.map((location) => {
            const id = String(location.id || '');
            const name = location.displayName || location.name || id;
            const isSelected = id === currentLocationId;
            return `
              <button type="button"
                class="po-locationCard ${isSelected ? 'po-locationCard--selected' : ''}"
                data-cn-line-location-option="${escapeAttribute(id)}"
                data-cn-line-location-name="${escapeAttribute(name)}"
                data-cn-line-location-index="${index}"
              >
                <span class="po-locationCardIcon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></span>
                <span class="po-locationCardName">${escapeHtml(name)}</span>
                ${isSelected ? `<span class="po-locationCardCheck"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></span>` : ''}
              </button>
            `;
          }).join('') : `<div class="po-locationModalEmpty">No locations available.</div>`}
        </div>
      </div>
    </div>
  `;
}

function renderStockOverlay(stockItems, filters, locations, selectedStockIds, headerReady, activeLocationId) {
  const categoryOptions = [
    { value: '', label: 'All categories' },
    ...getCategoryOptions(stockItems).map((category) => ({ value: category, label: category }))
  ];
  return `
    <div class="cn-overlayBackdrop">
      <section class="cn-overlayCard cn-overlayCard--picker">
        <header>
          <div>
            <p>Add Stock Items (Credit Note)</p>
            <h3>Select stock items, then confirm.</h3>
          </div>
          <button type="button" class="cn-iconButton" data-cn-stock-close aria-label="Close stock picker">${icon('x')}</button>
        </header>
        <div class="cn-overlayFilters">
          <div class="cn-overlaySearchWrap">
            <label>
              ${renderFieldHelpLabel('Search', 'Search stock items to include in this credit note return.')}
              <div class="cn-inputWrap">
                <input type="search" value="${escapeAttribute(filters.stockSearch || '')}" placeholder="Type name..." data-cn-stock-search data-focus-key="cn-stock-search" />
                <button type="button" class="cn-fieldIcon" aria-label="Search stock items" tabindex="-1">
                  ${icon('camera')}
                </button>
              </div>
            </label>
          </div>
          <label>
            ${renderFieldHelpLabel('Category', 'Filter the stock picker by category to narrow the return list faster.')}
            ${renderPickerDropdown({
              id: 'stock-category',
              action: 'stockCategory',
              selectedValue: filters.stockCategory || '',
              fallbackLabel: 'All categories',
              options: categoryOptions,
              openDropdown: filters.openDropdown,
              searchPlaceholder: 'Search categories...'
            })}
          </label>
        </div>
        <div class="cn-pickerList" data-scroll-key="credit-note-stock-picker">
          ${stockItems.map((item) => `
            <label class="cn-pickerItem ${item.alreadyAdded ? 'is-added' : ''}">
              <input type="checkbox" data-cn-stock-select="${escapeAttribute(item.id)}" ${selectedStockIds.has(String(item.id)) ? 'checked' : ''} ${headerReady ? '' : 'disabled'} />
              <div>
                <strong>${escapeHtml(item.name || '')}</strong>
                <span>${escapeHtml(item.category || '')}${item.alreadyAdded ? ' · already added' : ''}</span>
              </div>
              <span class="cn-pickerUnit">${escapeHtml(String(item.unit || '').toUpperCase())}</span>
            </label>
          `).join('') || '<div class="cn-empty"><span>No stock items match.</span></div>'}
        </div>
        <div class="cn-overlayActions">
          <div class="cn-overlaySelectionCount">${selectedStockIds.size} selected</div>
          <div class="cn-overlayActionRail">
            <button type="button" class="cn-outlineButton" data-cn-stock-select-all ${stockItems.length ? '' : 'disabled'}>Select all shown</button>
            <button type="button" class="cn-outlineButton" data-cn-stock-clear ${selectedStockIds.size ? '' : 'disabled'}>Clear</button>
            <button type="button" class="cn-add-primary" data-cn-stock-add ${selectedStockIds.size ? '' : 'disabled'}>Confirm</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderProcessedGrvOverlay(receipts = [], query = '') {
  return `
    <div class="cn-overlayBackdrop">
      <section class="cn-overlayCard">
        <header>
          <div>
            <p>Processed Goods Received Vouchers</p>
            <h3>Select received PO / GRV</h3>
          </div>
          <button type="button" class="cn-iconButton" data-cn-grv-close aria-label="Close GRV picker">${icon('x')}</button>
        </header>
        <div class="cn-overlayFilters">
          <input type="search" value="${escapeAttribute(query)}" placeholder="Search PO #, GRV #, supplier, or date..." data-cn-grv-search data-focus-key="cn-grv-search" />
        </div>
        <div class="cn-pickerList" data-scroll-key="credit-note-grv-picker">
          ${receipts.map((receipt) => `
            <button type="button" class="cn-supplierOption cn-grvOption" data-cn-grv-use="${escapeAttribute(receipt.id || '')}">
              <strong>${escapeHtml(receipt.poNumber || receipt.grvNumber || receipt.id || 'Received stock')}</strong>
              <span>${escapeHtml(receipt.supplierName || 'Unknown Supplier')} · ${escapeHtml(formatDisplayDate(receipt.date || todayLocal()))} · ${(receipt.items || []).length} ${(receipt.items || []).length === 1 ? 'line' : 'lines'}${receipt.sourceReceiptIds?.length ? ` · ${receipt.sourceReceiptIds.length} receipt${receipt.sourceReceiptIds.length === 1 ? '' : 's'}` : ''}</span>
            </button>
          `).join('') || '<div class="cn-empty"><span>No processed GRVs match.</span></div>'}
        </div>
      </section>
    </div>
  `;
}

function renderLineDetailOverlay(detailDraft, draft, sites, locations, openDropdown = '') {
  const locationId = detailDraft.locationId || draft.locationId || (locations[0]?.id || 'main');
  const siteId = detailDraft.siteId || draft.siteId || getSiteIdForLocation(locations, locationId);
  const pricesIncludeVat = draft.pricesIncludeVat === true;
  const siteOptions = (sites || []).map((site) => ({ value: site.id, label: site.name || site.code || site.id }));
  const locationOptions = locations
    .filter((location) => !siteId || String(location.siteId || '') === String(siteId))
    .map((location) => ({ value: location.id, label: location.displayName || location.name }));
  return `
    <div class="cn-overlayBackdrop">
      <section class="cn-overlayCard cn-overlayCard--detail">
        <header>
          <div>
            <p>Set Quantities & Prices</p>
            <h3>${detailDraft.entries.length} item(s)</h3>
          </div>
          <button type="button" class="cn-iconButton" data-cn-line-detail-close aria-label="Close line detail">${icon('x')}</button>
        </header>
        ${siteOptions.length > 1 ? `
          <label class="cn-detailLocation">
            ${renderFieldHelpLabel('Location Group', 'Select the trading location group this credit note affects.')}
            ${renderPickerDropdown({
              id: 'detail-site',
              action: 'detailSite',
              selectedValue: siteId,
              fallbackLabel: 'Select location group',
              options: siteOptions,
              openDropdown,
              searchPlaceholder: 'Search location groups...'
            })}
          </label>
        ` : ''}
        <label class="cn-detailLocation">
          ${renderFieldHelpLabel('Location', 'Select which selling location this returned stock line should affect.')}
          ${renderPickerDropdown({
            id: 'detail-location',
            action: 'detailLocation',
            selectedValue: locationId,
            fallbackLabel: 'Select location',
            options: locationOptions,
            openDropdown,
            searchPlaceholder: 'Search locations...'
          })}
        </label>
        <div class="cn-detailGrid">
          <div></div>
          ${renderFieldHelpLabel('Pack Qty', 'Number of packs being returned on this line.')}
          ${renderFieldHelpLabel('Pack Size', 'Units contained in each returned pack.')}
          ${renderFieldHelpLabel(pricesIncludeVat ? 'Pack Price (Incl VAT)' : 'Pack Price (Ex VAT)', 'Returned pack value used to calculate ex-VAT credit totals and VAT impact.')}
          ${detailDraft.entries.map((entry, index) => `
            <div class="cn-detailName">
              <strong>${escapeHtml(entry.stockItemName || '')}</strong>
              <span>${escapeHtml(entry.category || getCreditNoteLineUomLabel(entry) || '')}</span>
            </div>
            <div class="cn-detailInputWrap">
              <input type="text" inputmode="decimal" value="${escapeAttribute(formatEditable(entry.returnedQty || ''))}" data-cn-line-detail-index="${index}" data-cn-line-detail-field="returnedQty" data-focus-key="cn-detail-qty-${index}" title="${Number(entry.maxReturnQty || entry.originalOrderQty || 0) > 0 ? `Maximum original PO quantity: ${escapeAttribute(formatEditable(entry.maxReturnQty || entry.originalOrderQty))}` : 'Return quantity'}" />
            </div>
            <div class="cn-detailInputWrap cn-detailInputWrap--uom">
              <input type="text" inputmode="decimal" value="${escapeAttribute(formatEditable(entry.packSize || '1'))}" data-cn-line-detail-index="${index}" data-cn-line-detail-field="packSize" data-focus-key="cn-detail-pack-${index}" ${isCreditNoteLineCustomUom(entry) ? 'readonly title="Pack size is set by the selected UOM."' : ''} />
              <span class="cn-detailTag">${escapeHtml(entry.unit || 'ea')}</span>
            </div>
            <div class="cn-detailInputWrap">
              <input type="text" inputmode="decimal" value="${escapeAttribute(formatEditable(entry.packPriceDisplay || ''))}" data-cn-line-detail-index="${index}" data-cn-line-detail-field="packPriceDisplay" data-focus-key="cn-detail-price-${index}" />
            </div>
          `).join('')}
        </div>
        <div class="cn-overlayActions">
          <button type="button" class="cn-add-primary" data-cn-line-detail-apply>Confirm & add</button>
          <button type="button" class="cn-outlineButton" data-cn-line-detail-back>Back</button>
        </div>
      </section>
    </div>
  `;
}

function renderPickerDropdown({
  id,
  action,
  selectedValue,
  fallbackLabel,
  options,
  openDropdown,
  searchPlaceholder
}) {
  const selected = options.find((option) => String(option.value) === String(selectedValue));
  const isOpen = openDropdown === id;
  return `
    <div class="cn-dropdown ${isOpen ? 'cn-dropdown--open' : ''}" data-cn-dropdown-root>
      <button type="button" class="cn-dropdownButton" data-cn-open-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(selected?.label || fallbackLabel)}</strong>
        ${icon('chevronDown')}
      </button>
      <div class="cn-dropdownMenu">
        <input type="search" placeholder="${escapeAttribute(searchPlaceholder)}" data-cn-dropdown-search />
        <div class="cn-dropdownOptions">
          ${options.map((option) => `
            <button
              type="button"
              data-cn-option
              data-cn-option-action="${escapeAttribute(action)}"
              data-cn-option-value="${escapeAttribute(option.value)}"
              class="${String(option.value) === String(selectedValue) ? 'is-active' : ''}"
            >
              ${escapeHtml(option.label)}
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderNotice(message, tone) {
  return `<div class="cn-notice cn-notice--${tone}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="cn-toast cn-toast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-cn-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function renderClearConfirmOverlay() {
  return `
    <div class="cn-overlayBackdrop">
      <section class="cn-overlayCard cn-overlayCard--confirm">
        <header>
          <div>
            <p>Credit Note</p>
            <h3>Clear all drafted items?</h3>
          </div>
        </header>
        <p class="cn-confirmCopy">This keeps the header details and reasoning, but removes every drafted product line.</p>
        <div class="cn-overlayActions">
          <button type="button" class="cn-add-primary" data-cn-confirm-clear>Clear all</button>
          <button type="button" class="cn-outlineButton" data-cn-cancel-clear>Keep draft</button>
        </div>
      </section>
    </div>
  `;
}

function getSupplierMatches(suppliers = [], value = '') {
  const query = String(value || '').trim().toLowerCase();
  return suppliers
    .filter((supplier) => !query || String(supplier.name || '').toLowerCase().includes(query))
    .slice(0, 10);
}

function getProcessedGrvMatches(receipts = [], query = '') {
  const normalized = String(query || '').trim().toLowerCase();
  return receipts
    .filter((receipt) => {
      if (!normalized) return true;
      return [
        receipt.grvNumber,
        receipt.poNumber,
        receipt.sourceLabel,
        receipt.sourceReceiptNumbers,
        receipt.supplierName,
        receipt.date,
        receipt.id
      ].some((value) => String(value || '').toLowerCase().includes(normalized));
    })
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 24);
}

function getStockMatches(stockItems = [], query = '', category = '', currentLines = []) {
  const q = String(query || '').trim().toLowerCase();
  const currentKeys = new Set((currentLines || []).map((line) => `${line.stockItemId || ''}::${line.locationId || ''}`));
  return stockItems
    .filter(isPhysicalStockItem)
    .filter((item) => {
      if (category && String(item.category || '') !== category) return false;
      if (!q) return true;
      return (
        String(item.name || '').toLowerCase().includes(q) ||
        String(item.category || '').toLowerCase().includes(q) ||
        (item.barcodes || []).some((barcode) => String(barcode).toLowerCase().includes(q))
      );
    })
    .map((item) => ({ ...item, alreadyAdded: currentKeys.has(`${item.id || ''}::${item.locationId || ''}`) || currentLines.some((line) => String(line.stockItemId || '') === String(item.id)) }));
}

function getCategoryOptions(stockItems = []) {
  return [...new Set(stockItems.filter(isPhysicalStockItem).map((item) => String(item.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function isPhysicalStockItem(item = {}) {
  // Credit Notes can only credit Standard and Non Stock items.
  if (item.isSubRecipe === true || item.isManufactured === true) return false;
  const type = String(item.itemType || item.stockItemType || item.specificationType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['sub_recipe', 'subrecipe', 'manufactured', 'manufactured_item', 'prep', 'prepared'].includes(type)) return false;
  const category = String(item.category || '').toLowerCase();
  return !category.includes('sub recipe') &&
    !category.includes('sub-recipe') &&
    !category.includes('manufactured');
}

function renderCnLocationPicker(draft, locations = [], openDropdown = '', query = '') {
  const locationId = String(draft.locationId || '');
  const options = locations
    .filter((l) => String(l.id || '').trim())
    .map((l) => ({ id: String(l.id), name: l.displayName || l.name || l.id }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const selected = options.find((o) => o.id === locationId) || null;
  const isOpen = openDropdown === 'cn-header-location';
  const searchValue = isOpen ? String(query || '') : (selected ? selected.name : '');
  const needle = String(query || '').trim().toLowerCase();
  const visibleOptions = options.filter((opt) => !needle || String(opt.name || '').toLowerCase().includes(needle));
  return `
    <div class="cn-locationPickerWrap" data-cn-dropdown-root>
      <label class="cn-locationPickerLabel">Return to Location</label>
      <div class="cn-locationSearchShell">
        <input
          type="search"
          class="cn-input cn-locationInput ${selected ? 'cn-locationTrigger--set' : 'cn-locationTrigger--empty'}"
          value="${escapeAttribute(searchValue)}"
          placeholder="Search or select your location"
          autocomplete="off"
          role="combobox"
          aria-expanded="${isOpen}"
          aria-haspopup="listbox"
          data-focus-key="cn-header-location"
          data-cn-location-input
        />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="cn-chevron" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      ${isOpen ? `
        <div class="cn-locationMenu" role="listbox">
          ${visibleOptions.length ? visibleOptions.map((opt) => `
            <button type="button" role="option"
              class="cn-locationOption ${opt.id === locationId ? 'is-selected' : ''}"
              data-cn-header-location="${escapeAttribute(opt.id)}"
              data-cn-header-location-name="${escapeAttribute(opt.name)}"
              aria-selected="${opt.id === locationId}"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>${escapeHtml(opt.name)}</span>
              ${opt.id === locationId ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
            </button>
          `).join('') : `<div class="cn-locationOptionEmpty">No locations found.</div>`}
        </div>
      ` : ''}
    </div>
  `;
}

function buttonLabelForLocation(locations = [], locationId = '') {
  return locations.find((location) => String(location.id) === String(locationId))?.name || 'Main Store';
}

function getSiteIdForLocation(locations = [], locationId = '') {
  return String((locations || []).find((location) => String(location.id) === String(locationId))?.siteId || '');
}

function firstLocationIdForSite(locations = [], siteId = '') {
  return String((locations || []).find((location) => String(location.siteId || '') === String(siteId))?.id || '');
}

function calculateTotals(draft, vatRate) {
  const subtotal = (draft.items || []).reduce((sum, item) => sum + (Number(item.returnedQty || 0) * Math.max(Number(item.packSize || 1), 1) * Number(item.unitCost || 0)), 0);
  const vat = (draft.items || []).reduce((sum, item) => {
    if (item.vatEnabled === false) return sum;
    return sum + (Number(item.returnedQty || 0) * Math.max(Number(item.packSize || 1), 1) * Number(item.unitCost || 0) * (vatRate / 100));
  }, 0);
  return {
    subtotal,
    vat,
    totalIncl: subtotal + vat
  };
}

function getVatRate(state) {
  // NOTE: this previously read state.source?.settings, but appState.source is never assigned
  // anywhere in the app (it stays null permanently) — so this was silently, permanently hardcoded
  // to 15% regardless of the workspace's actual configured VAT rate. Read the real, live settings
  // instead.
  //
  // Deliberately independent of vatRegistered: calculateTotals above already decides per line
  // whether VAT applies at all (item.vatEnabled), matching the backend's credit-note VAT report.
  // A non-registered workspace still pays real VAT to a VAT-registered supplier on a VATable item
  // (e.g. beer) — it just can't reclaim it — so the rate itself must not be zeroed for everyone.
  const settings = state.settings?.draft || state.settings?.values || {};
  return Number(settings.vatRate ?? settings.vatPercentage ?? 15) || 15;
}

function getCreditNoteLineUomLabel(line = {}) {
  const baseUom = String(line.unit || 'ea').trim() || 'ea';
  const selectedUom = String(line.selectedUom || line.returnUom || line.receivingUom || line.purchaseUom || baseUom).trim() || baseUom;
  return selectedUom === baseUom ? baseUom : `${selectedUom} = ${formatNumber(line.packSize || 1)} ${baseUom}`;
}

function isCreditNoteLineCustomUom(line = {}) {
  const baseUom = String(line.unit || 'ea').trim() || 'ea';
  const selectedUom = String(line.selectedUom || line.returnUom || line.receivingUom || line.purchaseUom || baseUom).trim() || baseUom;
  return selectedUom !== baseUom;
}

function createEmptyDraft() {
  return {
    supplierId: '',
    supplierName: '',
    cnNumber: '',
    date: '',
    locationId: '',
    locationName: '',
    pricesIncludeVat: false,
    items: []
  };
}

function formatCurrency(value) {
  const amount = Number(value || 0) || 0;
  return `R ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedCurrency(value) {
  const amount = Number(value || 0) || 0;
  const sign = amount < 0 ? '-' : amount > 0 ? '+' : '';
  return `${sign}R ${Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(value) {
  const amount = Number(value || 0) || 0;
  return amount.toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function formatEditable(value) {
  return String(value ?? '');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value = '') {
  return escapeHtml(value);
}

function icon(name) {
  const icons = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 12 4 4 8-8"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/></svg>',
    clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a2 2 0 0 1 2-2h2l1.2-2h5.6L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>'
  };
  return icons[name] || icons.x;
}
