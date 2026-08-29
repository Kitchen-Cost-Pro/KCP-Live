import '../styles/grv.css';
import '../styles/fieldHelp.css';
import { bindCustomCalendarEvents, renderCustomCalendarOverlay } from './CustomCalendar.js';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';
import { formatDisplayDate, shiftMonthKey, startOfMonthKey, todayLocal } from '../utils/date.js';

export function renderGRVEntry({ state, onGrvFilterChange, onGrvAction = {} } = {}) {
  const grv = state.grv || {};
  const filters = {
    query: '',
    source: '',
    lineQuery: '',
    openDropdown: '',
    overlay: '',
    poQuery: '',
    selectedStockIds: [],
    calendarCursor: '',
    ...grv.filters
  };
  const draft = getDraft(grv);
  const vatRate = getVatRate(state);
  const supplierMatches = getSupplierMatches(state, grv, draft.supplierName || '');
  const convertibleOrders = filterConvertibleOrders(grv.orders || [], filters.poQuery || filters.query || '');
  const stockMatches = getStockMatches(grv.stockItems || [], filters.lineQuery || '', draft.items || []);
  const selectedStockIds = new Set((filters.selectedStockIds || []).map(String));
  const selectedLineIndexes = new Set((filters.selectedLineIndexes || []).map(String));
  const totals = calculateDraftTotals(draft, vatRate);
  const isPoLinkedDraft = Boolean(String(draft.sourcePoId || '').trim());
  const headerReady = Boolean(
    String(draft.supplierName || '').trim() &&
    String(draft.grvNumber || '').trim() &&
    String(draft.date || '').trim() &&
    String(draft.locationId || '').trim()
  );
  const statusLabel = grv.status === 'ready'
    ? `${(draft.items || []).length} ${(draft.items || []).length === 1 ? 'Item' : 'Items'}`
    : 'Loading';

  const view = document.createElement('section');
  view.id = 'view-grv';
  view.className = 'grvView';
  if (grv.status === 'loading' && !(grv.stockItems || []).length && !(grv.orders || []).length && !(grv.receipts || []).length) {
    view.innerHTML = renderLoadingPanel('Loading GRV workspace', 'Fetching suppliers, purchase orders, stock items, and receiving history.');
    return view;
  }
  view.innerHTML = `
    ${grv.actionError ? renderNotice(grv.actionError, 'error') : ''}

    <div class="grv-frame">
      <div class="grv-layout">
        <aside class="grv-sidebar">
          <article class="grv-card grv-sidecard">
            <p class="grv-side-title">Invoice Header</p>
            <div class="grv-stack">
              <div class="grv-inputWrap" data-grv-dropdown-root>
                <input
                  type="search"
                  class="grv-input"
                  value="${escapeAttribute(draft.supplierName || '')}"
                  placeholder="Supplier Name"
                  autocomplete="off"
                  data-grv-draft-field="supplierName"
                  data-focus-key="grv-supplier"
                  data-grv-supplier-input
                />
                ${renderSupplierDropdown(supplierMatches, filters.openDropdown, draft.supplierName)}
              </div>

              <input
                type="text"
                class="grv-input"
                value="${escapeAttribute(draft.grvNumber || '')}"
                placeholder="Invoice #"
                data-grv-draft-field="grvNumber"
                data-focus-key="grv-invoice"
                autocomplete="off"
              />

              <button
                type="button"
                class="grv-input grv-selectLike grv-dateTrigger"
                data-grv-open-calendar
                data-focus-key="grv-date"
              >
                <span>${escapeHtml(formatDisplayDate(draft.date || todayLocal()))}</span>
                ${icon('calendar')}
              </button>

              <label class="grv-pill">
                <input
                  type="checkbox"
                  class="grv-check"
                  ${draft.pricesIncludeVat ? 'checked' : ''}
                  data-grv-price-mode
                />
                <span class="grv-muted">Prices include VAT</span>
              </label>

              <label class="grv-pill">
                <input
                  type="checkbox"
                  class="grv-check"
                  ${draft.overrideCostPrice !== false ? 'checked' : ''}
                  data-grv-override-cost
                />
                <span class="grv-muted">${renderFieldHelpLabel('Override Cost Price', 'When enabled, this GRV updates the item cost for the receiving location using the business costing method. Turn it off for once-off supplier price changes that should not change recipe or stock valuation costs.')}</span>
              </label>

              <label class="grv-pill grv-pill--split">
                <input
                  type="checkbox"
                  class="grv-check"
                  ${draft.splitByLocation ? 'checked' : ''}
                  ${isPoLinkedDraft ? 'disabled' : ''}
                  data-grv-split-location
                />
                <span class="grv-muted">Split by Location</span>
              </label>

              ${renderGrvLocationPicker(draft, grv.locations || [], filters.openDropdown, filters.headerLocationQuery || '')}

              <button type="button" class="grv-add-btn" data-grv-load-last>
                ${icon('history')}
                <span>Load Last Invoice</span>
              </button>

              <button type="button" class="grv-add-btn grv-add-btn--success" data-grv-open-po>
                ${icon('clipboard')}
                <span>Process Purchase Order</span>
              </button>
            </div>
          </article>

          <article class="grv-card grv-sidecard">
            <p class="grv-side-title">Adjustments</p>
            <div class="grv-stack">
              <input
                type="text"
                inputmode="decimal"
                class="grv-input"
                value="${escapeAttribute(formatEditableInput(draft.transportEx || ''))}"
                placeholder="Transport (Ex)"
                data-grv-draft-field="transportEx"
                data-focus-key="grv-transport-ex"
                autocomplete="off"
              />

              <input
                type="text"
                inputmode="decimal"
                class="grv-input"
                value="${escapeAttribute(formatEditableInput(draft.invoiceDiscountEx || ''))}"
                placeholder="Discount (Ex)"
                data-grv-draft-field="invoiceDiscountEx"
                data-focus-key="grv-discount-ex"
                autocomplete="off"
              />
            </div>
          </article>
        </aside>

        ${renderDraftLauncher(statusLabel, totals, draft, headerReady)}
      </div>
    </div>

    ${filters.overlay === 'draft' ? renderDraftDrawer(statusLabel, totals, draft, vatRate, selectedLineIndexes, headerReady, grv.actionStatus, grv.actionError || '', grv.locations || [], filters.openDropdown || '') : ''}
    ${filters.overlay === 'po' ? renderPurchaseOrderOverlay(convertibleOrders, filters.poQuery || '') : ''}
    ${filters.overlay === 'stock' ? renderStockOverlay(stockMatches, filters.lineQuery || '', headerReady, selectedStockIds) : ''}
    ${filters.overlay === 'calendar' ? renderCustomCalendarOverlay({
      title: 'Select Trade Date',
      selectedDate: draft.date || todayLocal(),
      cursorDate: filters.calendarCursor || draft.date || todayLocal()
    }) : ''}
    ${filters.overlay === 'clear-confirm' ? renderClearConfirmOverlay() : ''}
    ${grv.lineDetailDraft?.entries?.length ? renderLineDetailOverlay(grv.lineDetailDraft, draft, grv.sites || [], grv.locations || [], vatRate) : ''}
    ${grv.missingSupplierPrompt ? renderMissingSupplierOverlay(grv.missingSupplierPrompt, grv.actionStatus === 'adding-supplier') : ''}
  `;

  bindGrvEvents(view, state, filters, draft, vatRate, onGrvFilterChange, onGrvAction);
  bindFieldHelpTooltips(view);

  // NOTE: the GRV toast is rendered ONCE by the global app-shell toast (appShell.js
  // getActiveSectionToast → grv). The old body portal here caused a duplicate/overlapping toast
  // and has been removed. Do not re-add a local toast renderer.
  document.getElementById('kcp-grv-toast-portal')?.remove();

  return view;
}

function bindGrvEvents(view, state, filters, draft, vatRate, onGrvFilterChange, onGrvAction) {
  const vatRegistered = isWorkspaceVatRegistered(state);
  const supplierVatRate = getSupplierVatRate(state);
  const blurActiveDraftField = () => {
    const active = document.activeElement;
    if (!active || !view.contains(active)) return;
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return;
    if (!active.matches('[data-grv-draft-field], [data-grv-line], [data-grv-filter], [data-grv-line-detail-field]')) return;
    active.blur();
  };

  view.querySelectorAll('[data-grv-draft-field]').forEach((field) => {
    const apply = () => {
      onGrvAction.onPreserveFocus?.(field);
      const payload = { [field.dataset.grvDraftField]: field.value };
      if (field.hasAttribute('data-grv-supplier-input')) {
        payload.supplierId = '';
        if (filters.openDropdown !== 'supplier') onGrvFilterChange?.({ openDropdown: 'supplier' });
      }
      onGrvAction.onDraftChange?.(payload);
    };
    field.addEventListener('input', apply);
    field.addEventListener('change', apply);
    if (field.hasAttribute('data-grv-supplier-input')) {
      const openSupplierDropdown = () => {
        if (filters.openDropdown !== 'supplier') onGrvFilterChange?.({ openDropdown: 'supplier' });
      };
      field.addEventListener('focus', openSupplierDropdown);
      field.addEventListener('click', openSupplierDropdown);
    }
    if (field.inputMode === 'decimal') {
      field.addEventListener('focus', () => selectAllOnFocusForZero(field));
    }
  });

  view.querySelector('[data-grv-price-mode]')?.addEventListener('change', (event) => {
    onGrvAction.onDraftChange?.({ pricesIncludeVat: event.currentTarget.checked });
  });

  view.querySelector('[data-grv-override-cost]')?.addEventListener('change', (event) => {
    onGrvAction.onDraftChange?.({ overrideCostPrice: event.currentTarget.checked });
  });

  view.querySelector('[data-grv-split-location]')?.addEventListener('change', (event) => {
    onGrvAction.onDraftChange?.({ splitByLocation: event.currentTarget.checked });
  });

  view.querySelectorAll('[data-grv-location-input]').forEach((field) => {
    const openLocationDropdown = () => {
      if (filters.openDropdown !== 'grv-header-location') {
        onGrvFilterChange?.({ openDropdown: 'grv-header-location', headerLocationQuery: field.value });
      }
    };
    field.addEventListener('focus', openLocationDropdown);
    field.addEventListener('click', openLocationDropdown);
    field.addEventListener('input', () => onGrvFilterChange?.({
      openDropdown: 'grv-header-location',
      headerLocationQuery: field.value
    }));
  });

  view.querySelectorAll('[data-grv-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.grvDropdown;
      onGrvFilterChange?.({ openDropdown: filters.openDropdown === id ? '' : id });
    });
  });

  view.querySelectorAll('[data-grv-supplier-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onGrvAction.onDraftChange?.({
        supplierId: button.dataset.grvSupplierId || '',
        supplierName: button.dataset.grvSupplierName || ''
      });
      onGrvFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-grv-close-location-modal]').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (el === event.currentTarget) onGrvFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-grv-header-location]').forEach((button) => {
    button.addEventListener('click', () => {
      onGrvAction.onDraftChange?.({
        locationId: button.dataset.grvHeaderLocation || '',
        locationName: button.dataset.grvHeaderLocationName || ''
      });
      onGrvFilterChange?.({ openDropdown: '', headerLocationQuery: '' });
    });
  });

  view.querySelectorAll('[data-grv-line-location-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onGrvAction.onUpdateLine?.(Number(button.dataset.grvLineLocationIndex || 0), {
        locationId: button.dataset.grvLineLocationOption || '',
        locationName: button.dataset.grvLineLocationName || ''
      });
      onGrvFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-grv-line-uom-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onGrvAction.onUpdateLine?.(Number(button.dataset.grvLineUomIndex || 0), {
        selectedUom: button.dataset.grvLineUomOption || ''
      });
      onGrvFilterChange?.({ openDropdown: '' });
    });
  });

  view.addEventListener('click', (event) => {
    if (!filters.openDropdown) return;
    if (event.target.closest('[data-grv-dropdown-root]')) return;
    blurActiveDraftField();
    onGrvFilterChange?.({ openDropdown: '', headerLocationQuery: '' });
  });

  view.querySelector('[data-grv-load-last]')?.addEventListener('click', () => onGrvAction.onLoadLastInvoice?.());
  view.querySelector('[data-grv-open-po]')?.addEventListener('click', () => {
    blurActiveDraftField();
    onGrvFilterChange?.({
      overlay: 'po',
      poQuery: '',
      selectedStockIds: [],
      calendarCursor: '',
      openDropdown: ''
    });
  });
  view.querySelector('[data-grv-open-draft]')?.addEventListener('click', () => {
    blurActiveDraftField();
    onGrvFilterChange?.({ overlay: 'draft', selectedStockIds: [], calendarCursor: '', openDropdown: '' });
  });
  view.querySelector('[data-grv-open-stock]')?.addEventListener('click', () => {
    blurActiveDraftField();
    onGrvFilterChange?.({ overlay: 'stock', lineQuery: '', selectedStockIds: [], calendarCursor: '' });
  });
  view.querySelector('[data-grv-select-all-lines]')?.addEventListener('click', () => onGrvAction.onSelectAllLines?.());
  view.querySelector('[data-grv-remove-selected]')?.addEventListener('click', () => onGrvAction.onRemoveSelectedLines?.());
  view.querySelector('[data-grv-clear-all]')?.addEventListener('click', () => onGrvAction.onRequestClearAll?.());
  view.querySelector('[data-grv-open-calendar]')?.addEventListener('click', () => {
    blurActiveDraftField();
    onGrvFilterChange?.({ overlay: 'calendar', calendarCursor: startOfMonthKey(draft.date || todayLocal()), openDropdown: '' });
  });
  view.querySelector('[data-grv-save]')?.addEventListener('click', () => onGrvAction.onSave?.());
  view.querySelector('[data-grv-toast-close]')?.addEventListener('click', () => onGrvAction.onDismissToast?.());
  view.querySelector('[data-grv-missing-supplier-confirm]')?.addEventListener('click', () => onGrvAction.onOpenMissingSupplierForm?.());
  view.querySelector('[data-grv-missing-supplier-continue]')?.addEventListener('click', () => onGrvAction.onContinueWithoutSupplier?.());
  view.querySelector('[data-grv-missing-supplier-save]')?.addEventListener('click', () => onGrvAction.onSaveMissingSupplier?.());
  view.querySelectorAll('[data-grv-missing-supplier-dismiss]').forEach((button) => {
    button.addEventListener('click', () => onGrvAction.onDismissMissingSupplier?.());
  });
  view.querySelectorAll('[data-grv-missing-supplier-field]').forEach((field) => {
    field.addEventListener('input', () => {
      onGrvAction.onUpdateMissingSupplierField?.({
        [field.dataset.grvMissingSupplierField]: field.value
      });
    });
  });
  view.querySelector('[data-grv-missing-supplier-overlay]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    onGrvAction.onDismissMissingSupplier?.();
  });

  view.querySelectorAll('[data-grv-filter]').forEach((field) => {
    const update = () => onGrvFilterChange?.({ [field.dataset.grvFilter]: field.value });
    field.addEventListener('input', update);
    field.addEventListener('change', update);
  });

  view.querySelectorAll('[data-grv-convert-po]').forEach((button) => {
    button.addEventListener('click', () => {
      onGrvAction.onConvertPo?.(button.dataset.grvConvertPo);
      onGrvFilterChange?.({ overlay: '', poQuery: '', selectedStockIds: [], calendarCursor: '' });
    });
  });

  view.querySelectorAll('[data-grv-stock-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const ids = new Set((filters.selectedStockIds || []).map(String));
      const id = String(checkbox.dataset.grvStockToggle || '');
      if (checkbox.checked) ids.add(id);
      else ids.delete(id);
      onGrvFilterChange?.({ selectedStockIds: [...ids] });
    });
  });

  view.querySelector('[data-grv-stock-clear]')?.addEventListener('click', () => {
    onGrvFilterChange?.({ selectedStockIds: [] });
  });

  view.querySelector('[data-grv-stock-confirm]')?.addEventListener('click', () => {
    onGrvAction.onAddMultipleLines?.(filters.selectedStockIds || []);
  });
  view.querySelectorAll('[data-grv-line-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onGrvAction.onToggleLineSelection?.(Number(checkbox.dataset.grvLineSelect), checkbox.checked);
    });
  });
  view.querySelector('[data-grv-confirm-clear]')?.addEventListener('click', () => onGrvAction.onConfirmClearAll?.());
  view.querySelector('[data-grv-cancel-clear]')?.addEventListener('click', () => onGrvAction.onCancelClearAll?.());

  view.querySelector('[data-grv-scan-barcode]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onGrvAction.onScanBarcode?.();
  });

  bindCustomCalendarEvents(view, {
    onClose: () => {
      onGrvFilterChange?.({ overlay: '', calendarCursor: '', openDropdown: '' });
    },
    onShift: (delta) => {
      onGrvFilterChange?.({ calendarCursor: shiftMonthKey(filters.calendarCursor || draft.date || todayLocal(), delta) });
    },
    onSelect: (date) => {
      onGrvAction.onDraftChange?.({ date });
      onGrvFilterChange?.({ overlay: '', calendarCursor: '', openDropdown: '' });
    },
    onToday: (date) => {
      onGrvAction.onDraftChange?.({ date });
      onGrvFilterChange?.({ overlay: '', calendarCursor: '', openDropdown: '' });
    }
  });

  view.querySelectorAll('[data-grv-line]').forEach((field) => {
    if (field instanceof HTMLInputElement) {
      field.addEventListener('focus', () => selectAllOnFocusForZero(field));
    }
    const applyLineChange = () => {
      onGrvAction.onPreserveFocus?.(field);
      const lineIndex = Number(field.dataset.grvLineIndex);
      const currentLine = draft.items?.[lineIndex] || {};
      const payload = { [field.dataset.grvLine]: field.value };
      if (field.dataset.grvLine === 'locationId') {
        const option = field.selectedOptions?.[0];
        payload.locationName = option?.dataset.locationName || option?.textContent || '';
      }
      if (field.dataset.grvLine === 'unitCostDisplay') {
        payload.unitCostDisplay = field.value;
        payload.unitCost = normalizeDisplayCost(
          field.value,
          currentLine.receivedQty,
          currentLine.packSize,
          field.dataset.grvVatEnabled !== 'false',
          draft.pricesIncludeVat,
          vatRegistered,
          supplierVatRate
        );
      }
      if (field.dataset.grvLine === 'packPriceDisplay') {
        const displayValue = field.value;
        const packSize = getPositivePackSize(currentLine.packSize);
        const vatEnabled = currentLine.vatEnabled !== false;
        const packPriceEx = finalizeReceivedCost(parseLooseDecimal(displayValue), {
          isVatable: vatEnabled,
          pricesIncludeVat: draft.pricesIncludeVat,
          vatRegistered,
          supplierVatRate
        });
        payload.packPriceDisplay = displayValue;
        payload.packPriceEx = String(packPriceEx);
        payload.unitCost = packSize > 0 ? String(packPriceEx / packSize) : '0';
      }
      if (field.dataset.grvLine === 'receivedQty' || field.dataset.grvLine === 'packSize') {
        const nextPackSize = Math.max(parseLooseDecimal(field.dataset.grvLine === 'packSize' ? field.value : currentLine.packSize) || 1, 1);
        const hasExplicitPackPrice = typeof currentLine.packPriceDisplay === 'string' || currentLine.packPriceEx !== undefined;
        const displayValue = hasExplicitPackPrice
          ? formatEditableInput(currentLine.packPriceDisplay ?? calculateDisplayedPackPrice(currentLine, draft.pricesIncludeVat, vatRate))
          : formatEditableInput(calculateDisplayedPackPrice(currentLine, draft.pricesIncludeVat, vatRate));
        const packPriceEx = finalizeReceivedCost(parseLooseDecimal(displayValue), {
          isVatable: currentLine.vatEnabled !== false,
          pricesIncludeVat: draft.pricesIncludeVat,
          vatRegistered,
          supplierVatRate
        });
        payload.packPriceDisplay = displayValue;
        payload.packPriceEx = String(packPriceEx);
        payload.unitCost = nextPackSize > 0 ? String(packPriceEx / nextPackSize) : '0';
      }
      onGrvAction.onUpdateLine?.(lineIndex, payload);
    };
    field.addEventListener('input', applyLineChange);
    field.addEventListener('change', applyLineChange);
  });

  view.querySelectorAll('[data-grv-line-detail-open]').forEach((button) => {
    button.addEventListener('click', () => onGrvAction.onOpenLineDetail?.(Number(button.dataset.grvLineDetailOpen)));
  });

  view.querySelectorAll('[data-grv-line-split]').forEach((button) => {
    button.addEventListener('click', () => onGrvAction.onSplitLine?.(Number(button.dataset.grvLineSplit)));
  });

  view.querySelectorAll('[data-grv-line-detail-field]').forEach((field) => {
    const apply = () => {
      onGrvAction.onPreserveFocus?.(field);
      const key = field.dataset.grvLineDetailField;
      const entryIndex = Number(field.dataset.grvLineDetailEntryIndex || 0);
      const value = field.type === 'checkbox' ? field.checked : field.value;
      if (key === 'lineTotalDisplay') {
        const packQty = Math.max(parseLooseDecimal(view.querySelector(`[data-grv-line-detail-field="receivedQty"][data-grv-line-detail-entry-index="${entryIndex}"]`)?.value), 0);
        const totalDisplay = parseLooseDecimal(value);
        const vatEnabled = view.querySelector(`[data-grv-line-detail-field="vatEnabled"][data-grv-line-detail-entry-index="${entryIndex}"]`)?.checked !== false;
        const totalCost = finalizeReceivedCost(totalDisplay, {
          isVatable: vatEnabled,
          pricesIncludeVat: draft.pricesIncludeVat,
          vatRegistered,
          supplierVatRate
        });
        const packPriceEx = packQty > 0 ? totalCost / packQty : 0;
        onGrvAction.onUpdateLineDetailDraft?.(entryIndex, { packPriceEx: String(packPriceEx) });
        return;
      }
      if (key === 'packPriceEx') {
        const packPriceDisplay = parseLooseDecimal(value);
        const vatEnabled = view.querySelector(`[data-grv-line-detail-field="vatEnabled"][data-grv-line-detail-entry-index="${entryIndex}"]`)?.checked !== false;
        const packPriceEx = finalizeReceivedCost(packPriceDisplay, {
          isVatable: vatEnabled,
          pricesIncludeVat: draft.pricesIncludeVat,
          vatRegistered,
          supplierVatRate
        });
        onGrvAction.onUpdateLineDetailDraft?.(entryIndex, {
          packPriceDisplay: value,
          packPriceEx: String(packPriceEx)
        });
        return;
      }
      onGrvAction.onUpdateLineDetailDraft?.(entryIndex, { [key]: value });
    };
    field.addEventListener('input', apply);
    field.addEventListener('change', apply);
    if (field.inputMode === 'decimal') {
      field.addEventListener('focus', () => selectAllOnFocusForZero(field));
    }
  });

  view.querySelectorAll('[data-grv-line-detail-location]').forEach((button) => {
    button.addEventListener('click', () => onGrvAction.onUpdateLineDetailDraft?.(Number(button.dataset.grvLineDetailEntryIndex || 0), {
      locationId: button.dataset.grvLineDetailLocation || '',
      locationName: button.dataset.grvLineDetailLocationName || ''
    }));
  });

  view.querySelector('[data-grv-line-detail-location-all]')?.addEventListener('change', (event) => {
    const option = event.currentTarget.selectedOptions?.[0];
    onGrvAction.onUpdateLineDetailLocationAll?.(
      event.currentTarget.value,
      option?.dataset.locationName || option?.textContent || ''
    );
  });

  view.querySelector('[data-grv-line-detail-site-all]')?.addEventListener('change', (event) => {
    const option = event.currentTarget.selectedOptions?.[0];
    const locationId = option?.dataset.locationId || '';
    const locationName = option?.dataset.locationName || '';
    onGrvAction.onDraftChange?.({ siteId: event.currentTarget.value, locationId, locationName });
    onGrvAction.onUpdateLineDetailLocationAll?.(locationId, locationName);
  });

  view.querySelector('[data-grv-line-detail-cancel]')?.addEventListener('click', () => onGrvAction.onCancelLineDetail?.());
  view.querySelector('[data-grv-line-detail-save]')?.addEventListener('click', () => onGrvAction.onApplyLineDetail?.());
  view.querySelector('[data-grv-line-detail-overlay]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    onGrvAction.onCancelLineDetail?.();
  });

  view.querySelectorAll('[data-grv-line-remove]').forEach((button) => {
    button.addEventListener('click', () => onGrvAction.onRemoveLine?.(Number(button.dataset.grvLineRemove)));
  });

  view.querySelectorAll('[data-grv-overlay-close]').forEach((button) => {
    button.addEventListener('click', () => {
      blurActiveDraftField();
      onGrvFilterChange?.({
        overlay: '',
        poQuery: '',
        lineQuery: '',
        selectedStockIds: [],
        calendarCursor: '',
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-grv-overlay]').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target !== overlay) return;
      blurActiveDraftField();
      onGrvFilterChange?.({
        overlay: '',
        poQuery: '',
        lineQuery: '',
        selectedStockIds: [],
        calendarCursor: '',
        openDropdown: ''
      });
    });
  });
}

function renderDraftTable(draft, vatRate, selectedLineIndexes = new Set(), locations = [], openDropdown = '') {
  const splitByLocation = draft.splitByLocation === true;
  return `
    <table class="grv-table">
      <colgroup>
        <col class="grv-tableCol grv-tableCol--check" />
        <col class="grv-tableCol grv-tableCol--item" />
        <col class="grv-tableCol grv-tableCol--uom" />
        <col class="grv-tableCol grv-tableCol--qty" />
        <col class="grv-tableCol grv-tableCol--pack" />
        <col class="grv-tableCol grv-tableCol--unit-price" />
        <col class="grv-tableCol grv-tableCol--price" />
        <col class="grv-tableCol grv-tableCol--vat" />
        <col class="grv-tableCol grv-tableCol--total" />
        <col class="grv-tableCol grv-tableCol--actions" />
      </colgroup>
      <thead>
        <tr>
          <th></th>
          <th>Item</th>
          <th>UOM</th>
          <th>Qty</th>
          <th>Pack</th>
          <th>Unit Price</th>
          <th>${draft.pricesIncludeVat ? 'Pack Price (Incl)' : 'Pack Price (Ex)'}</th>
          <th>VAT</th>
          <th>Total</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${(draft.items || []).map((line, index) => renderDraftRow(line, index, draft.pricesIncludeVat, vatRate, selectedLineIndexes, splitByLocation, locations, openDropdown)).join('')}
      </tbody>
    </table>
  `;
}

function renderDraftLauncher(statusLabel, totals, draft, headerReady) {
  return `
    <section class="grv-card grv-draftLauncher">
      <div>
        <p class="grv-side-title">Draft Table</p>
        <h3>${escapeHtml(statusLabel)}</h3>
        <span>Open the full GRV workspace in a wide slide-out drawer.</span>
      </div>
      <button type="button" class="grv-add-primary" data-grv-open-draft ${headerReady ? '' : 'disabled'}>
        Open Draft Table
      </button>
      <div class="grv-draftLauncherMetrics">
        <div>
          <span>Subtotal</span>
          <strong>${formatCurrency(totals.subtotal)}</strong>
        </div>
        <div>
          <span>VAT</span>
          <strong>${formatCurrency(totals.vat)}</strong>
        </div>
        <div>
          <span>Total</span>
          <strong>${formatCurrency(totals.totalIncl)}</strong>
        </div>
      </div>
      ${!headerReady ? '<small>Complete supplier, invoice number, date, and location first.</small>' : ''}
    </section>
  `;
}

function renderDraftDrawer(statusLabel, totals, draft, vatRate, selectedLineIndexes, headerReady, actionStatus, actionError = '', locations = [], openDropdown = '') {
  return `
    <div class="grv-overlay grv-overlay--drawer" data-grv-overlay>
      <section class="grv-overlayCard grv-overlayCard--draft grv-draft-panel" role="dialog" aria-modal="true">
        <button type="button" class="grv-removeBtn grv-draftDrawerClose" data-grv-overlay-close aria-label="Close draft table">
          ${icon('x')}
        </button>
        ${renderDraftPanelContent(statusLabel, totals, draft, vatRate, selectedLineIndexes, headerReady, actionStatus, actionError, locations, openDropdown)}
      </section>
    </div>
  `;
}

function renderDraftPanelContent(statusLabel, totals, draft, vatRate, selectedLineIndexes, headerReady, actionStatus, actionError = '', locations = [], openDropdown = '') {
  return `
    <div class="grv-topbar">
      <div class="grv-topbarTitle">
        <h3>Draft Table</h3>
        <span>${escapeHtml(statusLabel)}</span>
      </div>

      <div class="grv-topbarActions">
        <button type="button" class="grv-outlineButton" data-grv-select-all-lines ${(draft.items || []).length ? '' : 'disabled'}>Select all</button>
        <button type="button" class="grv-outlineButton grv-outlineButton--danger" data-grv-remove-selected ${(selectedLineIndexes.size ? '' : 'disabled')}>Remove selected</button>
        <button type="button" class="grv-outlineButton grv-outlineButton--danger" data-grv-clear-all ${(draft.items || []).length ? '' : 'disabled'}>Clear all</button>
        <button
          type="button"
          class="grv-add-primary"
          data-grv-open-stock
          ${headerReady ? '' : 'disabled'}
        >
          + Add Item
        </button>
      </div>
    </div>

    ${actionError ? `<div class="grv-drawerNotice">${renderNotice(actionError, 'error')}</div>` : ''}

    <div class="grv-draft-scroll">
      ${(draft.items || []).length ? renderDraftTable(draft, vatRate, selectedLineIndexes, locations, openDropdown) : `
        <div class="grv-empty">
          <span>INVOICE EMPTY.</span>
        </div>
      `}
    </div>

    <div class="grv-bottombar">
      <div class="grv-summaryGrid">
        <div class="grv-metric">
          <div class="grv-metric-label">Subtotal</div>
          <div class="grv-metric-value">${formatCurrency(totals.subtotal)}</div>
        </div>
        <div class="grv-metric">
          <div class="grv-metric-label">Discount</div>
          <div class="grv-metric-value grv-metric-value--blue">${formatCurrency(totals.discount)}</div>
        </div>
        <div class="grv-metric">
          <div class="grv-metric-label">VAT</div>
          <div class="grv-metric-value">${formatCurrency(totals.vat)}</div>
        </div>
      </div>

      <button
        type="button"
        class="grv-commit-primary"
        data-grv-save
        ${(draft.items || []).length && actionStatus !== 'saving' ? '' : 'disabled'}
      >
        <div class="grv-commit-label">Commit Stock</div>
        <div class="grv-commit-value">${formatCurrency(totals.totalIncl)}</div>
      </button>
    </div>
  `;
}

function renderDraftRow(line, index, pricesIncludeVat, vatRate, selectedLineIndexes = new Set(), splitByLocation = false, locations = [], openDropdown = '') {
  const variance = Number(line.receivedQty || 0) - Number(line.orderedQty || 0);
  const unitCostEx = Number(line.unitCost || 0);
  const packSize = getPositivePackSize(line.packSize);
  const packPriceEx = Number(line.packPriceEx ?? (unitCostEx * packSize)) || 0;
  const lineTotalEx = calculateLineTotalEx(line);
  const lineVat = line.vatEnabled === false ? 0 : lineTotalEx * vatRate;
  const destination = line.locationName || line.targetLocationName || line.locationId || line.targetLocation || 'No destination';
  const displayedPackPrice = pricesIncludeVat && line.vatEnabled !== false
    ? packPriceEx * (1 + vatRate)
    : packPriceEx;
  const rawDisplayedPackPrice = String(line.packPriceDisplay ?? '').trim();
  const varianceLabel = variance === 0 ? 'matched' : `${formatSignedNumber(variance)} var`;
  const splitMeta = line.splitGroupId && Number(line.splitExpectedQty || 0) > 0
    ? ` · SPLIT TOTAL ${formatNumber(line.splitExpectedQty)}`
    : '';

  return `
    <tr>
      <td class="grv-lineCheck">
        <input type="checkbox" data-grv-line-select="${index}" ${selectedLineIndexes.has(String(index)) ? 'checked' : ''} />
      </td>
      <td>
        <div class="grv-itemCell">
          <strong>${escapeHtml(line.stockItemName || line.stockItemId || 'Unnamed Stock Item')}</strong>
          <span>${escapeHtml(String(line.unit || 'ea').toUpperCase())} · ORD ${formatNumber(line.orderedQty || 0)} · ${escapeHtml(varianceLabel.toUpperCase())}${escapeHtml(splitMeta)}</span>
          ${splitByLocation ? `
            ${renderLineLocationSelect(line, index, locations, destination, openDropdown)}
          ` : `
            <em class="grv-lineMeta">${escapeHtml(destination)} · ${line.vatEnabled === false ? 'VAT off' : 'VAT on'}</em>
          `}
        </div>
      </td>
      <td>
        ${renderGrvLineUomSelect(line, index, openDropdown)}
      </td>
      <td>
        <input
          type="text"
          inputmode="decimal"
          class="grv-tableInput grv-tableInput--compact"
          value="${escapeAttribute(formatEditableInput(line.receivedQty || '', ''))}"
          placeholder="0"
          data-grv-line="receivedQty"
          data-grv-line-index="${index}"
          data-focus-key="grv-line-qty-${index}-${escapeAttribute(String(line.stockItemId || line.id || 'line'))}"
          autocomplete="off"
          aria-label="Pack quantity for ${escapeAttribute(line.stockItemName || 'stock item')}"
        />
        <span class="grv-cellHint">pack qty</span>
      </td>
      <td>
        <span class="grv-packField">
          <input
            type="text"
            inputmode="decimal"
            class="grv-tableInput grv-tableInput--compact grv-tableInput--pack"
            value="${escapeAttribute(formatEditableInput(line.packSize, '1'))}"
            placeholder="1"
            data-grv-line="packSize"
            data-grv-line-index="${index}"
            data-focus-key="grv-line-pack-${index}-${escapeAttribute(String(line.stockItemId || line.id || 'line'))}"
            autocomplete="off"
            aria-label="Pack size for ${escapeAttribute(line.stockItemName || 'stock item')}"
            ${isGrvLineCustomUom(line) ? 'readonly title="Pack size is set by the selected UOM."' : ''}
          />
          <span class="grv-uomGhost">${escapeHtml(String(line.unit || 'ea').toUpperCase())}</span>
        </span>
        <span class="grv-cellHint">${escapeHtml(String(line.unit || 'ea').toUpperCase())} / pack</span>
      </td>
      <td>
        <div class="grv-tableStat grv-tableStat--price">
          <strong>${formatCurrency(pricesIncludeVat && line.vatEnabled !== false ? unitCostEx * (1 + vatRate) : unitCostEx)}</strong>
          <span>${pricesIncludeVat && line.vatEnabled !== false ? 'unit incl VAT' : 'unit ex VAT'}</span>
        </div>
      </td>
      <td>
        <span class="grv-moneyField">
          <span class="grv-currencyGhost">R</span>
          <input
            type="text"
            inputmode="decimal"
            class="grv-tableInput grv-tableInput--price grv-tableInput--money"
            value="${escapeAttribute(rawDisplayedPackPrice || formatEditableInput(roundValue(displayedPackPrice)))}"
            data-grv-line="packPriceDisplay"
            data-grv-line-index="${index}"
            data-focus-key="grv-line-price-${index}-${escapeAttribute(String(line.stockItemId || line.id || 'line'))}"
            data-grv-vat-enabled="${line.vatEnabled === false ? 'false' : 'true'}"
            autocomplete="off"
            aria-label="${pricesIncludeVat && line.vatEnabled !== false ? 'Pack price including VAT' : 'Pack price excluding VAT'} for ${escapeAttribute(line.stockItemName || 'stock item')}"
          />
        </span>
        <span class="grv-cellHint">${pricesIncludeVat && line.vatEnabled !== false ? 'pack incl VAT' : 'pack ex VAT'}</span>
      </td>
      <td>
        <div class="grv-tableStat grv-tableStat--price">
          <strong>${formatCurrency(lineVat)}</strong>
          <span>${line.vatEnabled === false ? 'VAT off' : 'line VAT'}</span>
        </div>
      </td>
      <td class="grv-totalCell">${formatCurrency(lineTotalEx)}</td>
      <td class="grv-actionsCell">
        <div class="grv-actionsRail">
          ${splitByLocation ? `
            <button
              type="button"
              class="grv-detailBtn grv-detailBtn--split"
              data-grv-line-split="${index}"
              aria-label="Split GRV line by location"
            >
              Split
            </button>
          ` : ''}
          <button type="button" class="grv-removeBtn" data-grv-line-remove="${index}" aria-label="Remove line">
            ${icon('x')}
          </button>
        </div>
      </td>
    </tr>
  `;
}

function renderLineLocationSelect(line, index, locations = [], fallback = '', openDropdown = '') {
  const currentLocationId = String(line.locationId || line.targetLocation || '');
  const activeLocations = (locations || []).filter((location) => String(location.id || '').trim());
  const options = activeLocations.length ? activeLocations : [];
  const currentOption = options.find((location) => String(location.id || location.locationId || '') === currentLocationId) || null;
  const currentName = currentOption
    ? (currentOption.displayName || currentOption.name || currentOption.locationName || currentLocationId)
    : 'Select location';
  const hasLocation = Boolean(currentOption);
  const modalId = `grv-location-modal-${index}`;
  const isModalOpen = openDropdown === modalId;
  return `
    <div class="grv-locationPicker">
      <span class="grv-locationPickerLabel">Location</span>
      <button
        type="button"
        class="grv-locationPickerBtn ${hasLocation ? 'grv-locationPickerBtn--set' : ''}"
        data-grv-dropdown="${escapeAttribute(modalId)}"
        aria-label="Select destination location for ${escapeAttribute(line.stockItemName || 'stock item')}"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <strong>${escapeHtml(currentName)}</strong>
      </button>
      ${isModalOpen ? `
        <div class="grv-locationModalBackdrop" data-grv-close-location-modal="${index}">
          <div class="po-locationModal" role="dialog" aria-modal="true" aria-label="Select destination location">
            <div class="po-locationModalHeader">
              <h3>Select Destination Location</h3>
              <button type="button" class="po-locationModalClose" data-grv-close-location-modal="${index}" aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <p class="po-locationModalSub">Choose where this stock item will be received into.</p>
            <div class="po-locationModalList">
              ${options.map((location) => {
                const id = String(location.id || location.locationId || '');
                const name = location.displayName || location.name || location.locationName || id || 'Unnamed Location';
                const isSelected = id === currentLocationId;
                return `
                  <button type="button"
                    class="po-locationCard ${isSelected ? 'po-locationCard--selected' : ''}"
                    data-grv-line-location-option="${escapeAttribute(id)}"
                    data-grv-line-location-name="${escapeAttribute(name)}"
                    data-grv-line-location-index="${index}"
                  >
                    <span class="po-locationCardIcon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></span>
                    <span class="po-locationCardName">${escapeHtml(name)}</span>
                    ${isSelected ? `<span class="po-locationCardCheck"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></span>` : ''}
                  </button>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderLineDetailOverlay(detailDraft, draft, sites, locations, vatRate) {
  const entries = detailDraft.entries || [];
  const sharedLocationId = entries[0]?.locationId || draft.locationId || '';
  const sharedLocationName = entries[0]?.locationName || draft.locationName || '';
  const sharedSiteId = draft.siteId || getSiteIdForLocation(locations || [], sharedLocationId);
  const siteOptions = (sites || []).map((site) => {
    const firstLocation = (locations || []).find((location) => String(location.siteId || '') === String(site.id));
    return {
      id: site.id,
      name: site.name || site.code || site.id,
      locationId: firstLocation?.id || '',
      locationName: firstLocation?.displayName || firstLocation?.name || ''
    };
  });
  const locationOptions = (locations || []).length
    ? locations.filter((location) => !sharedSiteId || String(location.siteId || '') === String(sharedSiteId))
    : [{ id: sharedLocationId || 'main', name: sharedLocationName }];
  return `
    <div class="grv-overlay grv-overlay--drawer" data-grv-line-detail-overlay>
      <div class="grv-overlayCard grv-overlayCard--detail grv-overlayCard--drawer" role="dialog" aria-modal="true">
        <div class="grv-overlayHeader">
          <div>
            <h3>Set Quantities & Prices</h3>
            <p>${entries.length} item(s) · enter ${draft.pricesIncludeVat ? 'incl VAT' : 'ex VAT'} pack prices</p>
          </div>
          <button type="button" class="grv-removeBtn" data-grv-line-detail-cancel aria-label="Close line details">
            ${icon('x')}
          </button>
        </div>

        ${siteOptions.length > 1 ? `
          <div class="grv-lineDetailTopField">
            <label class="grv-lineDetailTopLabel">${renderFieldHelpLabel('Location Group', 'Choose the trading location group for these received lines.')}</label>
            <select class="grv-input grv-lineDetailLocationSelect" data-grv-line-detail-site-all>
              ${siteOptions.map((site) => `
                <option
                  value="${escapeAttribute(site.id || '')}"
                  data-location-id="${escapeAttribute(site.locationId || '')}"
                  data-location-name="${escapeAttribute(site.locationName || '')}"
                  ${String(site.id || '') === String(sharedSiteId || '') ? 'selected' : ''}
                >
                  ${escapeHtml(site.name || site.id || 'Unnamed Location Group')}
                </option>
              `).join('')}
            </select>
          </div>
        ` : ''}

        <div class="grv-lineDetailTopField">
          <label class="grv-lineDetailTopLabel">${renderFieldHelpLabel('Destination Location', 'Choose which selling location this received line should be booked into.')}</label>
          <select class="grv-input grv-lineDetailLocationSelect" data-grv-line-detail-location-all>
            ${locationOptions.map((location) => `
              <option
                value="${escapeAttribute(location.id || '')}"
                data-location-name="${escapeAttribute(location.displayName || location.name || '')}"
                ${String(location.id || '') === String(sharedLocationId || '') ? 'selected' : ''}
              >
                ${escapeHtml(location.displayName || location.name || location.id || 'Unnamed Location')}
              </option>
            `).join('')}
          </select>
        </div>

        <div class="grv-lineDetailTableHead">
          <span></span>
          ${renderFieldHelpLabel('Pack Qty', 'Number of packs received for this line item.')}
          ${renderFieldHelpLabel('Pack Size', 'Units contained in each received pack.')}
          ${renderFieldHelpLabel(draft.pricesIncludeVat ? 'Pack Price (Incl VAT)' : 'Pack Price (Ex VAT)', 'Pack value used to calculate received stock cost and VAT impact for this line.')}
        </div>

        <div class="grv-lineDetailList grv-lineDetailList--table">
          ${entries.map((detail, entryIndex) => {
            const packQty = Math.max(parseLooseDecimal(detail.receivedQty), 0);
            const packSize = getPositivePackSize(detail.packSize);
            const unitCost = parseLooseDecimal(detail.unitCost);
            const packPriceEx = parseLooseDecimal(detail.packPriceEx || (unitCost * packSize));
            const displayFactor = draft.pricesIncludeVat && detail.vatEnabled !== false ? (1 + vatRate) : 1;
            const packPriceDisplay = packPriceEx * displayFactor;
            const rawPackPriceDisplay = String(detail.packPriceDisplay ?? '').trim();
            const descriptor = [detail.unit, detail.category].filter(Boolean).join(' - ');
            return `
              <section class="grv-lineDetailCard">
                <div class="grv-lineDetailCell grv-lineDetailCell--item">
                  <div>
                    <strong>${escapeHtml(detail.stockItemName || 'Selected stock item')}</strong>
                    <span>${escapeHtml((descriptor || detail.unit || 'ea').toUpperCase())}</span>
                  </div>
                </div>
                <label class="grv-lineDetailField">
                    <input
                      type="text"
                      inputmode="decimal"
                      class="grv-input"
                      value="${escapeAttribute(formatEditableInput(detail.receivedQty))}"
                      data-grv-line-detail-field="receivedQty"
                      data-grv-line-detail-entry-index="${entryIndex}"
                      data-focus-key="grv-detail-qty-${entryIndex}-${escapeAttribute(String(detail.stockItemId || detail.index || 'line'))}"
                      autocomplete="off"
                    />
                </label>
                <label class="grv-lineDetailField">
                  <span class="grv-packField grv-packField--detail">
                      <input
                        type="text"
                        inputmode="decimal"
                        class="grv-input grv-tableInput--pack"
                        value="${escapeAttribute(formatEditableInput(detail.packSize, '1'))}"
                        data-grv-line-detail-field="packSize"
                        data-grv-line-detail-entry-index="${entryIndex}"
                        data-focus-key="grv-detail-pack-${entryIndex}-${escapeAttribute(String(detail.stockItemId || detail.index || 'line'))}"
                        autocomplete="off"
                      />
                      <span class="grv-uomGhost">${escapeHtml(String(detail.unit || 'ea').toUpperCase())}</span>
                  </span>
                </label>
                <label class="grv-lineDetailField">
                  <span class="grv-moneyField grv-moneyField--detail">
                      <span class="grv-currencyGhost">R</span>
                      <input
                        type="text"
                        inputmode="decimal"
                        class="grv-input"
                        value="${escapeAttribute(rawPackPriceDisplay || formatEditableInput(roundValue(packPriceDisplay)))}"
                        data-grv-line-detail-field="packPriceEx"
                        data-grv-line-detail-entry-index="${entryIndex}"
                        data-focus-key="grv-detail-pack-price-${entryIndex}-${escapeAttribute(String(detail.stockItemId || detail.index || 'line'))}"
                        autocomplete="off"
                      />
                  </span>
                </label>
              </section>
            `;
          }).join('')}
        </div>

        <div class="grv-overlayFooter">
          <button type="button" class="grv-add-primary" data-grv-line-detail-save>Confirm & Add</button>
          <button type="button" class="grv-add-primary grv-add-primary--secondary" data-grv-line-detail-cancel>Back</button>
        </div>
      </div>
    </div>
  `;
}

function renderClearConfirmOverlay() {
  return `
    <div class="grv-overlay">
      <section class="grv-overlayCard grv-overlayCard--confirm">
        <header class="grv-overlayHeader">
          <div>
            <h3>Clear all drafted items?</h3>
            <p>This keeps the invoice header and supplier details, but removes every drafted stock line.</p>
          </div>
        </header>
        <div class="grv-overlayFooter grv-overlayFooter--confirm">
          <button type="button" class="grv-add-primary" data-grv-confirm-clear>Clear all</button>
          <button type="button" class="grv-outlineButton" data-grv-cancel-clear>Keep draft</button>
        </div>
      </section>
    </div>
  `;
}

function renderSupplierDropdown(matches, openDropdown, currentValue) {
  const show = openDropdown === 'supplier';
  const rows = matches.length
    ? matches.map((supplier) => `
        <button
          type="button"
          class="grv-supplierOption ${String(currentValue || '').trim().toLowerCase() === String(supplier.name || '').trim().toLowerCase() ? 'is-active' : ''}"
          data-grv-supplier-option
          data-grv-supplier-id="${escapeAttribute(supplier.id || '')}"
          data-grv-supplier-name="${escapeAttribute(supplier.name || '')}"
        >
          <strong>${escapeHtml(supplier.name || 'Unnamed Supplier')}</strong>
          <span>${escapeHtml(supplier.category || supplier.contactPerson || 'Supplier')}</span>
        </button>
      `).join('')
    : '<div class="grv-supplierEmpty">No matching suppliers</div>';

  return `
    <div class="grv-supplierMenu ${show ? 'is-open' : ''}">
      ${rows}
    </div>
  `;
}

function renderPurchaseOrderOverlay(orders, query) {
  return renderOverlay({
    title: 'Process Purchase Order',
    subtitle: 'Search or select a PO to load into GRV',
    filterKey: 'poQuery',
    value: query,
    placeholder: 'Search PO Ref or Supplier...',
    content: orders.length
      ? orders.map((order) => `
          <button type="button" class="grv-pickerItem" data-grv-convert-po="${escapeAttribute(order.id)}">
            <div>
              <strong>${escapeHtml(order.reference || order.poNumber || 'No Ref')}</strong>
              <span>${escapeHtml(order.supplierName || 'Unassigned Supplier')} · ${getOutstandingOrderLineCount(order)} remaining · ${escapeHtml(order.date || '')}</span>
            </div>
            <em class="grv-pickerBadge ${escapeAttribute(order.status || 'draft')}">${escapeHtml(order.status || 'draft')}</em>
          </button>
        `).join('')
      : '<div class="grv-pickerEmpty">No pending purchase orders match this search.</div>'
  });
}

function renderStockOverlay(stockItems, query, headerReady, selectedStockIds) {
  const selectedCount = selectedStockIds.size;
  return `
    <div class="grv-overlay" data-grv-overlay>
      <div class="grv-overlayCard" role="dialog" aria-modal="true">
        <div class="grv-overlayHeader">
          <div>
            <h3>Add Stock Item</h3>
            <p>${escapeHtml(headerReady ? 'Select one or more stock items, then confirm the batch.' : 'Complete the invoice header first')}</p>
          </div>
          <button type="button" class="grv-removeBtn" data-grv-overlay-close aria-label="Close overlay">
            ${icon('x')}
          </button>
        </div>

        <div class="grv-overlaySearch">
          <div class="grv-searchShell">
            <input
              type="search"
              class="grv-input"
              value="${escapeAttribute(query || '')}"
              placeholder="Search stock items..."
              data-grv-filter="lineQuery"
              data-focus-key="grv-stock-search"
            />
            <button type="button" data-grv-scan-barcode aria-label="Scan barcode" title="Scan barcode">
              ${icon('camera')}
            </button>
          </div>
        </div>

        <div class="grv-overlayList" data-scroll-key="grv-stock-picker">
          ${stockItems.length
            ? stockItems.map((item) => renderStockPickerItem(item, selectedStockIds.has(String(item.id)))).join('')
            : '<div class="grv-pickerEmpty">No stock items match this search.</div>'}
        </div>

        <div class="grv-overlayFooter">
          <span>${selectedCount} selected</span>
          <div class="grv-overlayFooterActions">
            <button type="button" class="grv-add-btn" data-grv-stock-clear ${selectedCount ? '' : 'disabled'}>Clear</button>
            <button type="button" class="grv-add-primary" data-grv-stock-confirm ${selectedCount ? '' : 'disabled'}>Add Selected</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderOverlay({ title, subtitle, filterKey, value, placeholder, content }) {
  return `
    <div class="grv-overlay" data-grv-overlay>
      <div class="grv-overlayCard" role="dialog" aria-modal="true">
        <div class="grv-overlayHeader">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(subtitle)}</p>
          </div>
          <button type="button" class="grv-removeBtn" data-grv-overlay-close aria-label="Close overlay">
            ${icon('x')}
          </button>
        </div>

        <div class="grv-overlaySearch">
          <input
            type="search"
            class="grv-input"
            value="${escapeAttribute(value || '')}"
            placeholder="${escapeAttribute(placeholder)}"
            data-grv-filter="${escapeAttribute(filterKey)}"
          />
        </div>

        <div class="grv-overlayList" data-scroll-key="grv-generic-overlay">
          ${content}
        </div>
      </div>
    </div>
  `;
}

function renderStockPickerItem(item, selected) {
  return `
    <label class="grv-pickerItem grv-pickerItem--selectable ${selected ? 'is-selected' : ''}">
      <span class="grv-pickerCheck">
        <input type="checkbox" data-grv-stock-toggle="${escapeAttribute(item.id)}" ${selected ? 'checked' : ''} />
        <span></span>
      </span>
      <div class="grv-pickerContent">
        <strong>${escapeHtml(item.name || 'Unnamed Item')}</strong>
        <span>${escapeHtml(item.category || 'General')} · ${escapeHtml(item.unit || 'ea')} · ${formatCurrency(item.lastPurchasePrice ?? item.cost ?? 0)}</span>
      </div>
      <em class="grv-pickerBadge neutral">${escapeHtml(String(item.unit || 'ea').toUpperCase())}</em>
    </label>
  `;
}

function renderGrvLineUomSelect(line = {}, index = 0, openDropdown = '') {
  const options = getGrvLineUomOptions(line);
  const selected = String(line.selectedUom || line.receivingUom || line.purchaseUom || line.unit || options[0]?.value || 'ea');
  const active = options.find((option) => String(option.value) === selected) || options[0] || { value: selected, label: selected || 'UOM' };
  const dropdownId = `grv-line-uom-${index}`;
  const isOpen = openDropdown === dropdownId;
  return `
    <div class="grv-inlineUomSelect ${isOpen ? 'is-open' : ''}" data-grv-dropdown-root>
      <button
        type="button"
        class="grv-inlineUomTrigger"
        data-grv-dropdown="${escapeAttribute(dropdownId)}"
        aria-haspopup="listbox"
        aria-expanded="${isOpen}"
        aria-label="Receiving UOM"
      >
        <strong>${escapeHtml(active.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="grv-inlineUomMenu" role="listbox" ${isOpen ? '' : 'hidden'}>
        ${options.map((option) => {
          const isSelected = String(option.value) === selected;
          return `
            <button
              type="button"
              class="${isSelected ? 'is-selected' : ''}"
              role="option"
              aria-selected="${isSelected}"
              data-grv-line-uom-option="${escapeAttribute(option.value)}"
              data-grv-line-uom-index="${index}"
            >
              <i aria-hidden="true">${isSelected ? icon('check') : ''}</i>
              <em>${escapeHtml(option.label)}</em>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function getGrvLineUomOptions(line = {}) {
  const baseUom = String(line.unit || line.baseUom || 'ea').trim() || 'ea';
  const configs = normalizeUomConfigurations(line.uomConfigurations || line.uomConfig || line.uomConversions);
  return [
    { value: baseUom, label: `${baseUom} (base)`, ratio: 1, isBase: true },
    ...configs.map((config) => ({
      value: config.customUom,
      label: `${config.customUom} = ${formatNumber(config.ratio)} ${config.baseUom || baseUom}`,
      ratio: config.ratio,
      isBase: false
    }))
  ];
}

function isGrvLineCustomUom(line = {}) {
  const baseUom = String(line.unit || line.baseUom || 'ea').trim() || 'ea';
  const selected = String(line.selectedUom || line.receivingUom || line.purchaseUom || baseUom).trim() || baseUom;
  return selected !== baseUom && getGrvLineUomOptions(line).some((option) => String(option.value) === selected && option.isBase !== true);
}

function normalizeUomConfigurations(value = []) {
  const rows = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  return rows
    .map((entry = {}) => ({
      baseUom: String(entry.baseUom || entry.base_uom || entry.baseUnit || '').trim(),
      customUom: String(entry.customUom || entry.custom_uom || entry.customUnit || entry.orderingUom || '').trim(),
      ratio: Number(entry.ratio ?? entry.conversionRatio ?? entry.unitsPerCustomUnit ?? 0) || 0,
      barcode: String(entry.barcode || entry.customBarcode || entry.customUomBarcode || '').trim(),
      isDefaultOrdering: ['true', '1', 'yes', 'on'].includes(String(entry.isDefaultOrdering ?? entry.defaultOrdering ?? entry.is_default_ordering ?? entry.defaultOrderUom ?? '').toLowerCase()) || entry.isDefaultOrdering === true || entry.defaultOrdering === true
    }))
    .filter((entry) => entry.customUom && entry.ratio > 0);
}

function renderMissingSupplierOverlay(prompt, isSaving) {
  if (prompt.mode === 'form') {
    return renderMissingSupplierForm(prompt, isSaving);
  }

  return `
    <div class="grv-overlay" data-grv-missing-supplier-overlay>
      <div class="grv-overlayCard grv-overlayCard--compact" role="dialog" aria-modal="true">
        <div class="grv-overlayHeader">
          <div>
            <h3>Supplier Not Found</h3>
            <p>Supplier not found. Would you like to add <strong>${escapeHtml(prompt.supplierName || 'Unnamed Supplier')}</strong> to your supplier master list?</p>
          </div>
          <button
            type="button"
            class="grv-removeBtn"
            data-grv-missing-supplier-dismiss
            aria-label="Close overlay"
            ${isSaving ? 'disabled' : ''}
          >
            ${icon('x')}
          </button>
        </div>

        ${renderMissingSupplierSummary(prompt)}

        <div class="grv-overlayFooter">
          <span>Adding the supplier is recommended, but you can continue this invoice without saving it to the supplier master.</span>
          <div class="grv-overlayFooterActions">
            <button
              type="button"
              class="grv-add-btn"
              data-grv-missing-supplier-continue
              ${isSaving ? 'disabled' : ''}
            >
              Continue Without Adding
            </button>
            <button
              type="button"
              class="grv-add-btn"
              data-grv-missing-supplier-dismiss
              ${isSaving ? 'disabled' : ''}
            >
              Cancel
            </button>
            <button
              type="button"
              class="grv-add-primary"
              data-grv-missing-supplier-confirm
              ${isSaving ? 'disabled' : ''}
            >
              Yes, add supplier
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderMissingSupplierForm(prompt, isSaving) {
  const form = {
    name: '',
    contactPerson: '',
    email: '',
    phone: '',
    category: 'General',
    leadTime: '0',
    paymentTerms: 'COD',
    accountNumber: '',
    address: '',
    ...(prompt.formValues || {})
  };

  return `
    <div class="grv-overlay" data-grv-missing-supplier-overlay>
      <div class="grv-overlayCard grv-overlayCard--supplierForm" role="dialog" aria-modal="true">
        <div class="grv-overlayHeader">
          <div>
            <h3>Add Supplier</h3>
            <p>Complete the supplier record before this GRV can link to a new supplier.</p>
          </div>
          <button
            type="button"
            class="grv-removeBtn"
            data-grv-missing-supplier-dismiss
            aria-label="Close overlay"
            ${isSaving ? 'disabled' : ''}
          >
            ${icon('x')}
          </button>
        </div>

        ${prompt.error ? renderNotice(prompt.error, 'error') : ''}

        ${renderMissingSupplierSummary(prompt)}

        <div class="grv-supplierFormGrid">
          ${renderSupplierField('Supplier Name', 'name', form.name, true)}
          ${renderSupplierField('Contact Person', 'contactPerson', form.contactPerson, true)}
          ${renderSupplierField('Email', 'email', form.email, false, 'email')}
          ${renderSupplierField('Phone', 'phone', form.phone, false, 'tel')}
          ${renderSupplierField('Category', 'category', form.category, true)}
          ${renderSupplierField('Lead Time', 'leadTime', form.leadTime, true, 'number')}
          ${renderSupplierField('Payment Terms', 'paymentTerms', form.paymentTerms, true)}
          ${renderSupplierField('Account Number', 'accountNumber', form.accountNumber)}
          <label class="grv-supplierFormWide">
            <span>Address</span>
            <input
              type="text"
              class="grv-input"
              value="${escapeAttribute(form.address)}"
              data-grv-missing-supplier-field="address"
              autocomplete="off"
            />
          </label>
        </div>

        <div class="grv-overlayFooter">
          <span>Phone or email is required so the supplier record is usable in purchasing.</span>
          <div class="grv-overlayFooterActions">
            <button
              type="button"
              class="grv-add-btn"
              data-grv-missing-supplier-dismiss
              ${isSaving ? 'disabled' : ''}
            >
              Cancel
            </button>
            <button
              type="button"
              class="grv-add-primary"
              data-grv-missing-supplier-save
              ${isSaving ? 'disabled' : ''}
            >
              ${isSaving ? 'Saving supplier...' : 'Save Supplier'}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSupplierField(label, field, value = '', required = false, type = 'text') {
  return `
    <label>
      <span>${escapeHtml(label)}${required ? ' *' : ''}</span>
      <input
        type="${escapeAttribute(type)}"
        class="grv-input"
        value="${escapeAttribute(value)}"
        data-grv-missing-supplier-field="${escapeAttribute(field)}"
        ${required ? 'required' : ''}
        autocomplete="off"
      />
    </label>
  `;
}

function renderMissingSupplierSummary(prompt = {}) {
  const supplierName = String(prompt.supplierName || prompt.formValues?.name || '').trim() || 'Unnamed Supplier';
  const sourceLabel = String(prompt.sourceLabel || '').trim();
  const referenceLabel = String(prompt.referenceLabel || '').trim();

  return `
    <div class="grv-missingSupplierSummary">
      <span>Missing Supplier</span>
      <strong>${escapeHtml(supplierName)}</strong>
      ${sourceLabel ? `
        <span>Origin</span>
        <strong>${escapeHtml(sourceLabel)}</strong>
      ` : ''}
      ${referenceLabel ? `
        <span>Reference</span>
        <strong>${escapeHtml(referenceLabel)}</strong>
      ` : ''}
    </div>
  `;
}

function renderNotice(message, tone = 'error') {
  return `<div class="grv-notice grv-notice--${escapeAttribute(tone)}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="grv-toast grv-toast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" class="grv-removeBtn" data-grv-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function renderGrvLocationPicker(draft, locations = [], openDropdown = '', query = '') {
  const locationId = String(draft.locationId || '');
  const options = locations
    .filter((l) => String(l.id || '').trim())
    .map((l) => ({ id: String(l.id), name: l.displayName || l.name || l.id }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const selected = options.find((o) => o.id === locationId) || null;
  const isOpen = openDropdown === 'grv-header-location';
  const searchValue = isOpen ? String(query || '') : (selected ? selected.name : '');
  const needle = String(query || '').trim().toLowerCase();
  const visibleOptions = options.filter((opt) => !needle || String(opt.name || '').toLowerCase().includes(needle));
  return `
    <div class="grv-locationPickerWrap" data-grv-dropdown-root>
      <label class="grv-locationPickerLabel">Destination Location</label>
      <div class="grv-locationSearchShell">
        <input
          type="search"
          class="grv-input grv-locationInput ${selected ? 'grv-locationTrigger--set' : 'grv-locationTrigger--empty'}"
          value="${escapeAttribute(searchValue)}"
          placeholder="Search or select your location"
          autocomplete="off"
          role="combobox"
          aria-expanded="${isOpen}"
          aria-haspopup="listbox"
          data-focus-key="grv-header-location"
          data-grv-location-input
        />
        ${icon('chevron')}
      </div>
      ${isOpen ? `
        <div class="grv-locationMenu" role="listbox">
          ${visibleOptions.length ? visibleOptions.map((opt) => `
            <button type="button" role="option"
              class="grv-locationOption ${opt.id === locationId ? 'is-selected' : ''}"
              data-grv-header-location="${escapeAttribute(opt.id)}"
              data-grv-header-location-name="${escapeAttribute(opt.name)}"
              aria-selected="${opt.id === locationId}"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>${escapeHtml(opt.name)}</span>
              ${opt.id === locationId ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
            </button>
          `).join('') : `<div class="grv-locationOptionEmpty">No locations found.</div>`}
        </div>
      ` : ''}
    </div>
  `;
}

function getDraft(grv) {
  const draft = grv.draftReceipt || {};
  const locationId = String(draft.locationId || '');
  const locationName = locationId
    ? (draft.locationName || grv.locations?.find((location) => String(location.id) === locationId)?.name || '')
    : '';
  const siteId = draft.siteId || getSiteIdForLocation(grv.locations || [], locationId);
  return {
    id: '',
    grvNumber: '',
    sourcePoId: '',
    poNumber: '',
    supplierId: '',
    supplierName: '',
    date: todayLocal(),
    siteId,
    siteName: draft.siteName || '',
    locationId,
    locationName,
    notes: '',
    pricesIncludeVat: false,
    overrideCostPrice: true,
    transportEx: '',
    invoiceDiscountEx: '',
    invoiceTotalEx: '',
    items: [],
    ...draft
  };
}

function getSiteIdForLocation(locations = [], locationId = '') {
  return String((locations || []).find((location) => String(location.id) === String(locationId))?.siteId || '');
}

function getSupplierMatches(state, grv, query) {
  const needle = String(query || '').trim().toLowerCase();
  const suppliers = ([...(grv.suppliers || []), ...(state.suppliers?.items || [])])
    .map((supplier) => ({
      id: supplier.id,
      name: supplier.name,
      category: supplier.category,
      contactPerson: supplier.contactPerson
    }))
    .filter((supplier) => String(supplier.name || '').trim());

  const deduped = Array.from(new Map(
    suppliers.map((supplier) => [String(supplier.name || '').trim().toLowerCase(), supplier])
  ).values());

  return deduped
    .filter((supplier) => !needle || String(supplier.name || '').toLowerCase().includes(needle))
    .slice(0, 8);
}

function filterConvertibleOrders(orders, query) {
  const needle = String(query || '').trim().toLowerCase();
  return (orders || [])
    .filter((order) => !['completed', 'received'].includes(String(order.status || '').toLowerCase()))
    .filter((order) => getOutstandingOrderLineCount(order) > 0)
    .filter((order) => {
      if (!needle) return true;
      return [
        order.reference,
        order.poNumber,
        order.supplierName,
        order.status,
        `${getOutstandingOrderLineCount(order)}`
      ].some((value) => String(value || '').toLowerCase().includes(needle));
    });
}

function getOutstandingOrderLineCount(order = {}) {
  return (order.items || []).filter((item) => Number(item.receivedQty || 0) < Number(item.qty || 0)).length;
}

function getStockMatches(stockItems, query, currentItems = []) {
  const needle = String(query || '').trim().toLowerCase();
  const usedIds = new Set((currentItems || []).map((line) => String(line.stockItemId || line.id)));
  return (stockItems || [])
    .filter(isPhysicalStockItem)
    .filter((item) => !usedIds.has(String(item.id)))
    .filter((item) => {
      if (!needle) return true;
      return [
        item.name,
        item.category,
        ...(item.barcodes || []),
        ...normalizeUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions).map((config) => config.barcode)
      ].some((value) => String(value || '').toLowerCase().includes(needle));
    })
    .slice(0, 28);
}

function isPhysicalStockItem(item = {}) {
  // GRV can only receive Standard and Non Stock items.
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

function calculateDraftTotals(draft, vatRate) {
  const lineSubtotal = (draft.items || []).reduce((sum, line) => sum + calculateLineTotalEx(line), 0);
  const taxableLineSubtotal = (draft.items || []).reduce((sum, line) => (
    line.vatEnabled === false ? sum : sum + calculateLineTotalEx(line)
  ), 0);
  const transportEx = Number(draft.transportEx || 0) || 0;
  const discount = Number(draft.invoiceDiscountEx || 0) || 0;
  const subtotal = Math.max(0, lineSubtotal + transportEx);
  const subtotalAfterDiscount = Math.max(0, subtotal - discount);
  const taxableBaseBeforeDiscount = Math.max(0, taxableLineSubtotal + transportEx);
  const appliedDiscount = Math.min(discount, subtotalAfterDiscount + discount);
  const discountTaxableShare = subtotal > 0
    ? appliedDiscount * (taxableBaseBeforeDiscount / subtotal)
    : 0;
  const taxableAfterDiscount = Math.max(0, taxableBaseBeforeDiscount - discountTaxableShare);
  const vat = Math.max(0, taxableAfterDiscount * vatRate);
  const invoiceOverrideEx = Number(draft.invoiceTotalEx || 0) || 0;
  const totalEx = invoiceOverrideEx > 0 ? invoiceOverrideEx : subtotalAfterDiscount;
  const totalIncl = totalEx + vat;

  return {
    subtotal,
    discount,
    vat,
    totalEx,
    totalIncl
  };
}

function calculateLineTotalEx(line = {}) {
  return getBaseQuantity(line.receivedQty, line.packSize) * Number(line.unitCost || 0);
}

function calculateDisplayedLinePrice(line = {}, pricesIncludeVat, vatRate) {
  const lineTotalEx = calculateLineTotalEx(line);
  if (!pricesIncludeVat || line.vatEnabled === false) return lineTotalEx;
  return lineTotalEx * (1 + vatRate);
}

function calculateDisplayedPackPrice(line = {}, pricesIncludeVat, vatRate) {
  const unitCostEx = Number(line.unitCost || 0) || 0;
  const packSize = getPositivePackSize(line.packSize);
  const packPriceEx = Number(line.packPriceEx ?? (unitCostEx * packSize)) || 0;
  if (!pricesIncludeVat || line.vatEnabled === false) return packPriceEx;
  return packPriceEx * (1 + vatRate);
}

function normalizeDisplayCost(value, receivedQty, packSize, vatEnabled, pricesIncludeVat, vatRegistered, supplierVatRate) {
  const amount = parseLooseDecimal(value);
  const totalCost = finalizeReceivedCost(amount, {
    isVatable: vatEnabled !== false,
    pricesIncludeVat,
    vatRegistered,
    supplierVatRate
  });
  const baseQuantity = getBaseQuantity(receivedQty, packSize);
  return baseQuantity > 0 ? totalCost / baseQuantity : 0;
}

function getBaseQuantity(receivedQty, packSize) {
  const quantity = Math.max(parseLooseDecimal(receivedQty), 0);
  const rawPackSize = String(packSize ?? '').trim();
  const pack = rawPackSize
    ? Math.max(parseLooseDecimal(rawPackSize), 0)
    : 0;
  return quantity * pack;
}

function getPositivePackSize(value) {
  const parsed = parseLooseDecimal(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getVatRate(state) {
  // NOTE: this previously read state.source?.settings, but appState.source is never assigned
  // anywhere in the app (it stays null permanently) — so this was silently, permanently hardcoded
  // to 15% regardless of the workspace's actual configured VAT rate. Read the real, live settings
  // instead, and respect VAT-registration status: a non-registered workspace never shows VAT on
  // any live entry-form preview (GRV pack prices, line VAT, totals).
  const settings = state.settings?.draft || state.settings?.values || {};
  if (settings.vatRegistered === false) return 0;
  return (Number(settings.vatRate ?? settings.vatPercentage ?? 15) || 15) / 100;
}

function isWorkspaceVatRegistered(state) {
  const settings = state.settings?.draft || state.settings?.values || {};
  return settings.vatRegistered !== false;
}

// Unlike getVatRate (zeroed above so no VAT ever shows on a non-registered workspace's live
// previews/totals), this is the real rate a VATable supplier actually charges on their invoice —
// it must stay non-zero regardless of OUR OWN registration status. A non-registered business still
// pays that VAT; it just can't reclaim it, so the input VAT becomes a genuine, unrecoverable part
// of the item's cost (see finalizeReceivedCost below) rather than a separate line it can net off.
function getSupplierVatRate(state) {
  const settings = state.settings?.draft || state.settings?.values || {};
  return (Number(settings.vatRate ?? settings.vatPercentage ?? 15) || 15) / 100;
}

// Turns a raw entered amount into the cost that actually gets saved as this line's unit cost.
// `pricesIncludeVat` tells us how to interpret what was typed (gross vs net); `vatRegistered`
// then decides what the SAVED figure should be: a VAT-registered business reclaims input VAT, so
// its stock cost stays net/ex-VAT (unchanged from before); a non-registered business cannot
// reclaim it, so the VAT a VATable supplier charged is a real cost and must be folded back in.
function finalizeReceivedCost(amount, { isVatable, pricesIncludeVat, vatRegistered, supplierVatRate }) {
  const netExVat = pricesIncludeVat && isVatable ? amount / (1 + supplierVatRate) : amount;
  return (!vatRegistered && isVatable) ? netExVat * (1 + supplierVatRate) : netExVat;
}

function roundValue(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatEditableInput(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function selectAllOnFocusForZero(field) {
  if (!field || field.inputMode !== 'decimal') return;
  const value = String(field.value || '').trim();
  if (!['0', '0.0', '0.00', '0,0', '0,00'].includes(value)) return;
  queueMicrotask(() => {
    if (document.activeElement !== field) return;
    if (typeof field.setSelectionRange !== 'function') return;
    try {
      field.setSelectionRange(0, field.value.length);
    } catch {
      // Numeric-style inputs can be focused without allowing text selection.
    }
  });
}

function parseLooseDecimal(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const normalized = raw.replace(',', '.').replace(/[^0-9.]/g, '');
  if (!normalized || normalized === '.') return 0;
  const parts = normalized.split('.');
  const candidate = parts.length > 1
    ? `${parts.shift()}.${parts.join('')}`
    : parts[0];
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(value || 0));
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatSignedNumber(value) {
  const amount = Number(value || 0);
  if (!amount) return '0';
  return `${amount > 0 ? '+' : ''}${formatNumber(amount)}`;
}

function icon(name) {
  const icons = {
    check: '<path d="m6 12 4 4 8-8"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDoubleLeft: '<path d="m17 18-6-6 6-6"/><path d="m11 18-6-6 6-6"/>',
    chevronDoubleRight: '<path d="m7 18 6-6-6-6"/><path d="m13 18 6-6-6-6"/>',
    camera: '<path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="12.5" r="3.5"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    clipboard: '<path d="M9 5h6"/><path d="M9 3h6a2 2 0 0 1 2 2v14H7V5a2 2 0 0 1 2-2Z"/><path d="M9 9h6"/><path d="M9 13h6"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l3 3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${icons[name] || icons.x}
    </svg>
  `;
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
  return escapeHtml(value).replaceAll('`', '&#096;');
}
