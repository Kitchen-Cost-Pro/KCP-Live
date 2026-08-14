import '../styles/purchaseOrders.css';
import '../styles/fieldHelp.css';
import { bindCustomCalendarEvents, renderCustomCalendarOverlay } from './CustomCalendar.js';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';
import { formatDisplayDate, shiftMonthKey, startOfMonthKey, todayLocal } from '../utils/date.js';

export function renderPurchaseOrders({ state, onPurchaseOrderFilterChange, onPurchaseOrderAction = {} } = {}) {
  const purchaseOrders = state.purchaseOrders || {};
  const filters = {
    query: '',
    status: '',
    view: 'list',
    openDropdown: '',
    lineQuery: '',
    supplierQuery: '',
    calendarCursor: '',
    overlay: '',
    ...(purchaseOrders.filters || {})
  };
  const orders = filterOrders(purchaseOrders.orders || [], filters);
  const selectedIds = new Set((purchaseOrders.selectedIds || []).map(String));
  const statusOptions = [
    { value: '', label: 'All Statuses' },
    { value: 'draft', label: 'Draft' },
    { value: 'sent', label: 'Sent' },
    { value: 'partially_received', label: 'Partially Received' },
    { value: 'completed', label: 'Completed' }
  ];

  const view = document.createElement('section');
  view.className = 'purchaseOrdersModule';
  view.innerHTML = `
    <header class="purchaseOrdersModule__header">
      <div>
        <p class="purchaseOrdersModule__eyebrow">Inventory</p>
        <h1>Purchase Orders</h1>
        <p>Draft, submit, and receive supplier orders into live stock balances.</p>
      </div>
      <div class="purchaseOrdersModule__actions">
        ${renderActionDropdown(filters.openDropdown)}
        <button type="button" class="purchaseOrdersModule__primary" data-po-new>${icon('plus')}<span>New PO</span></button>
      </div>
    </header>

    <section class="purchaseOrdersModule__controls" aria-label="Purchase order filters">
      <label>
        ${renderFieldHelpLabel('Search Orders', 'Search live purchase orders by PO number, supplier, or status to reopen and manage existing orders.')}
        <input type="search" value="${escapeAttribute(filters.query)}" placeholder="PO, supplier, status..." data-po-filter="query" />
      </label>
      ${renderDropdown({
        id: 'status',
        label: 'Status',
        value: filters.status,
        openDropdown: filters.openDropdown,
        options: statusOptions
      })}
      <div class="purchaseOrdersModule__viewToggle" aria-label="Purchase order view toggle">
        ${renderViewButton('list', filters.view)}
        ${renderViewButton('tiles', filters.view)}
      </div>
    </section>

    ${purchaseOrders.actionError && !purchaseOrders.draftOrder && !purchaseOrders.confirmDelete ? renderNotice(purchaseOrders.actionError, 'error') : ''}
    ${selectedIds.size ? renderBulkBar([...selectedIds], purchaseOrders.actionStatus) : ''}
    ${renderOrderBody(purchaseOrders, orders, filters.view, selectedIds)}
    ${renderPurchaseOrderWorkflow(purchaseOrders, filters)}
    ${renderDeleteDialog(purchaseOrders)}
    ${renderGmailPromptModal(purchaseOrders)}
    ${renderLocationModal(purchaseOrders.draftOrder?.locationId || '', filters.openDropdown, purchaseOrders.locations || [], purchaseOrders.draftOrder?.siteId || '')}
    ${renderToast(purchaseOrders.toast)}
  `;

  bindPurchaseOrderEvents(view, orders, filters, onPurchaseOrderFilterChange, onPurchaseOrderAction);
  bindFieldHelpTooltips(view);
  return view;
}

function bindPurchaseOrderEvents(view, visibleOrders, filters, onPurchaseOrderFilterChange, onPurchaseOrderAction) {
  view.querySelector('.purchaseOrdersModule__modal')?.addEventListener('submit', (event) => event.preventDefault());

  view.querySelectorAll('[data-po-filter]').forEach((field) => {
    field.addEventListener('input', () => onPurchaseOrderFilterChange?.({ [field.dataset.poFilter]: field.value }));
  });

  view.querySelectorAll('[data-po-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.poDropdown;
      onPurchaseOrderFilterChange?.({ openDropdown: filters.openDropdown === id ? '' : id });
    });
  });

  view.addEventListener('click', (event) => {
    if (!filters.openDropdown || event.target.closest('[data-po-dropdown-root]')) return;
    onPurchaseOrderFilterChange?.({ openDropdown: '' });
  });

	  view.querySelectorAll('[data-po-option]').forEach((button) => {
	    button.addEventListener('click', () => {
	      onPurchaseOrderFilterChange?.({
	        [button.dataset.poOptionGroup]: button.dataset.poOptionValue,
	        openDropdown: ''
	      });
	    });
	  });

	  view.querySelectorAll('[data-po-open-supplier]').forEach((button) => {
	    button.addEventListener('click', () => {
	      onPurchaseOrderAction.onDraftChange?.({ supplierPickerOpen: true });
	      onPurchaseOrderFilterChange?.({ openDropdown: '' });
	    });
	  });

	  view.querySelectorAll('[data-po-supplier-close]').forEach((button) => {
	    button.addEventListener('click', () => {
	      onPurchaseOrderAction.onDraftChange?.({ supplierPickerOpen: false });
	      onPurchaseOrderFilterChange?.({ supplierQuery: '' });
	    });
	  });

	  view.querySelector('[data-po-confirm-selection]')?.addEventListener('click', () => {
	    onPurchaseOrderAction.onDraftChange?.({ inputMode: 'input' });
	    onPurchaseOrderFilterChange?.({ openDropdown: '' });
	  });

	  view.querySelector('[data-po-back-selection]')?.addEventListener('click', () => {
	    onPurchaseOrderAction.onDraftChange?.({ inputMode: 'selection' });
	    onPurchaseOrderFilterChange?.({ openDropdown: '' });
	  });

  view.querySelectorAll('[data-po-view]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderFilterChange?.({ view: button.dataset.poView }));
  });

  view.querySelector('[data-po-new]')?.addEventListener('click', () => onPurchaseOrderAction.onNew?.());
  view.querySelectorAll('[data-po-export]').forEach((button) => {
    button.addEventListener('click', () => {
      const format = button.dataset.poExport;
      if (format === 'xlsx') onPurchaseOrderAction.onExportXlsx?.();
      else if (format === 'pdf') onPurchaseOrderAction.onExportPdf?.();
      else onPurchaseOrderAction.onExportCsv?.();
    });
  });

  view.querySelectorAll('[data-po-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => onPurchaseOrderAction.onSelect?.(checkbox.dataset.poSelect, checkbox.checked));
  });

  view.querySelector('[data-po-select-all]')?.addEventListener('change', (event) => {
    onPurchaseOrderAction.onSelectAll?.(visibleOrders.map((order) => order.id), event.target.checked);
  });

  view.querySelectorAll('[data-po-edit]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onEdit?.(button.dataset.poEdit));
  });

  view.querySelectorAll('[data-po-status]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onStatus?.(button.dataset.poStatusId, button.dataset.poStatus));
  });

  view.querySelectorAll('[data-po-send]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onSend?.(button.dataset.poSend));
  });

  view.querySelectorAll('[data-po-pdf]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onExportPdf?.(button.dataset.poPdf));
  });

  view.querySelectorAll('[data-po-delete]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onRequestDelete?.({ ids: [button.dataset.poDelete], mode: 'single' }));
  });

  view.querySelector('[data-po-delete-selected]')?.addEventListener('click', () => {
    onPurchaseOrderAction.onRequestDelete?.({ ids: parseJson(view.querySelector('[data-po-delete-selected]')?.dataset.poDeleteSelected), mode: 'bulk' });
  });

	  view.querySelectorAll('[data-po-supplier-select]').forEach((button) => {
	    button.addEventListener('click', () => {
	      onPurchaseOrderAction.onDraftChange?.({
	        supplierId: button.dataset.poSupplierSelect,
	        supplierName: button.dataset.poSupplierName,
	        supplierQuery: button.dataset.poSupplierName,
	        supplierPickerOpen: false
	      });
	      onPurchaseOrderFilterChange?.({ supplierQuery: '' });
	    });
	  });

  view.querySelector('[data-po-open-location-modal]')?.addEventListener('click', () => {
    onPurchaseOrderFilterChange?.({ openDropdown: 'location-modal' });
  });
  view.querySelectorAll('[data-po-close-location-modal]').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (el === event.currentTarget) onPurchaseOrderFilterChange?.({ openDropdown: '' });
    });
  });

	  view.querySelectorAll('[data-po-location]').forEach((button) => {
	    button.addEventListener('click', () => {
	      onPurchaseOrderAction.onDraftChange?.({ locationId: button.dataset.poLocation });
	      onPurchaseOrderFilterChange?.({ openDropdown: '' });
	    });
	  });

	  view.querySelectorAll('[data-po-site]').forEach((button) => {
	    button.addEventListener('click', () => {
	      onPurchaseOrderAction.onDraftChange?.({ siteId: button.dataset.poSite });
	      onPurchaseOrderFilterChange?.({ openDropdown: '' });
	    });
	  });

	  view.querySelectorAll('[data-po-line-location]').forEach((button) => {
	    button.addEventListener('click', () => {
	      onPurchaseOrderAction.onUpdateLine?.(Number(button.dataset.poLineLocationIndex), {
	        locationId: button.dataset.poLineLocation,
	        targetLocation: button.dataset.poLineLocation,
	        locationName: button.dataset.poLineLocationName,
	        targetLocationName: button.dataset.poLineLocationName
	      });
	      onPurchaseOrderFilterChange?.({ openDropdown: '' });
	    });
	  });

  view.querySelectorAll('[data-po-line-uom]').forEach((button) => {
    button.addEventListener('click', () => {
      onPurchaseOrderAction.onUpdateLine?.(Number(button.dataset.poLineUomIndex), {
        selectedUom: button.dataset.poLineUom || ''
      });
      onPurchaseOrderFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-po-draft-field]').forEach((field) => {
    const isTextLike = field.tagName === 'INPUT' && field.type !== 'checkbox' && field.type !== 'radio';
    if (isTextLike) {
      field.addEventListener('input', () => {
        onPurchaseOrderAction.onDraftChangeSilent?.({ [field.dataset.poDraftField]: field.value });
      });
    } else {
      field.addEventListener('change', () => {
        onPurchaseOrderAction.onPreserveFocus?.(field);
        onPurchaseOrderAction.onDraftChange?.({ [field.dataset.poDraftField]: field.value });
      });
    }
  });

  view.querySelectorAll('[data-po-open-calendar]').forEach((button) => {
    button.addEventListener('click', () => {
      const currentDate = button.dataset.poCalendarDate || todayLocal();
      onPurchaseOrderFilterChange?.({
        overlay: 'calendar',
        calendarCursor: startOfMonthKey(currentDate),
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-po-add-stock]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onAddLine?.(button.dataset.poAddStock));
  });

  view.querySelectorAll('[data-po-scan-barcode]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onScanBarcode?.());
  });

  view.querySelectorAll('[data-po-line]').forEach((field) => {
    field.addEventListener('input', () => {
      // Silent state sync during typing — renderApp guard prevents DOM replacement mid-keystroke
      onPurchaseOrderAction.onUpdateLineSilent?.(Number(field.dataset.poLineIndex), {
        [field.dataset.poLine]: field.value
      });
    });
    field.addEventListener('change', () => {
      onPurchaseOrderAction.onPreserveFocus?.(field);
      onPurchaseOrderAction.onUpdateLine?.(Number(field.dataset.poLineIndex), {
        [field.dataset.poLine]: field.value
      });
    });
  });

  view.querySelectorAll('[data-po-line-remove]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onRemoveLine?.(Number(button.dataset.poLineRemove)));
  });

	  view.querySelector('[data-po-save]')?.addEventListener('click', () => {
	    const notesField = view.querySelector('[name="notes"]');
	    onPurchaseOrderAction.onSave?.(notesField ? { notes: notesField.value } : {});
	  });

  view.querySelectorAll('[data-po-close]').forEach((button) => {
    button.addEventListener('click', () => onPurchaseOrderAction.onClose?.());
  });

  bindCustomCalendarEvents(view, {
    onClose: () => onPurchaseOrderFilterChange?.({ overlay: '', calendarCursor: '' }),
    onShift: (delta) => onPurchaseOrderFilterChange?.({
      calendarCursor: shiftMonthKey(filters.calendarCursor || purchaseOrdersDateFallback(view), delta)
    }),
    onSelect: (date) => {
      onPurchaseOrderAction.onDraftChange?.({ date });
      onPurchaseOrderFilterChange?.({ overlay: '', calendarCursor: '' });
    },
    onToday: (date) => {
      onPurchaseOrderAction.onDraftChange?.({ date });
      onPurchaseOrderFilterChange?.({ overlay: '', calendarCursor: '' });
    }
  });

  view.querySelector('[data-po-confirm-delete]')?.addEventListener('click', () => onPurchaseOrderAction.onConfirmDelete?.());
  view.querySelector('[data-po-cancel-delete]')?.addEventListener('click', () => onPurchaseOrderAction.onCancelDelete?.());
  view.querySelector('[data-po-toast-dismiss]')?.addEventListener('click', () => onPurchaseOrderAction.onDismissToast?.());
  view.querySelector('[data-po-gmail-prompt-close]')?.addEventListener('click', () => onPurchaseOrderAction.onDismissGmailPrompt?.());
  view.querySelector('[data-po-gmail-prompt-integrations]')?.addEventListener('click', () => onPurchaseOrderAction.onNavigateToIntegrations?.());

  schedulePurchaseOrderLineDropdownPositioning(view);
}

function schedulePurchaseOrderLineDropdownPositioning(view) {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;

  const positionMenus = () => {
    if (!view.isConnected) return;
    view.querySelectorAll(
      '.purchaseOrdersModule__lineUom.purchaseOrdersModule__dropdown--open, .purchaseOrdersModule__lineLocation.purchaseOrdersModule__dropdown--open'
    ).forEach((dropdown) => {
      const trigger = dropdown.querySelector(':scope > button');
      const menu = dropdown.querySelector(':scope > .purchaseOrdersModule__dropdownMenu');
      if (!trigger || !menu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const viewportPadding = 12;
      const gap = 8;
      const availableWidth = Math.max(220, window.innerWidth - (viewportPadding * 2));
      const width = Math.min(Math.max(triggerRect.width, 220), availableWidth);

      menu.style.width = `${width}px`;
      menu.style.maxWidth = `${availableWidth}px`;
      menu.style.left = `${Math.min(
        Math.max(viewportPadding, triggerRect.left),
        Math.max(viewportPadding, window.innerWidth - width - viewportPadding)
      )}px`;

      const menuHeight = Math.min(menu.scrollHeight || 0, Math.max(160, window.innerHeight - (viewportPadding * 2)));
      const roomAbove = triggerRect.top - viewportPadding;
      const roomBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
      const openAbove = roomAbove >= Math.min(menuHeight + gap, 280) || roomAbove > roomBelow;
      const top = openAbove
        ? Math.max(viewportPadding, triggerRect.top - menuHeight - gap)
        : Math.min(window.innerHeight - menuHeight - viewportPadding, triggerRect.bottom + gap);

      menu.style.top = `${Math.max(viewportPadding, top)}px`;
      menu.style.bottom = 'auto';
    });
  };

  const reposition = () => {
    if (!view.isConnected) {
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
      return;
    }
    window.requestAnimationFrame(positionMenus);
  };

  window.requestAnimationFrame(positionMenus);
  window.addEventListener('resize', reposition, { passive: true });
  document.addEventListener('scroll', reposition, { capture: true, passive: true });
}

function purchaseOrdersDateFallback(view) {
  return view.querySelector('[data-po-open-calendar]')?.dataset.poCalendarDate || todayLocal();
}

function renderOrderBody(purchaseOrders, orders, view, selectedIds) {
  if (purchaseOrders.status === 'loading') {
    return renderLoadingPanel('Loading purchase orders', 'Fetching suppliers, stock items, locations, and order history.');
  }

  if (purchaseOrders.status === 'error') {
    return renderNotice(purchaseOrders.error || 'Could not load purchase orders.', 'error');
  }

  if (!orders.length) {
    return renderNotice('No purchase orders match the current filters.', 'empty');
  }

  return view === 'tiles'
    ? renderTileView(orders, selectedIds)
    : renderListView(orders, selectedIds);
}

function renderListView(orders, selectedIds) {
  const allVisibleSelected = orders.length > 0 && orders.every((order) => selectedIds.has(String(order.id)));
  return `
    <section class="purchaseOrdersModule__list" aria-label="Purchase order list">
      <div class="purchaseOrdersModule__listHead">
        <label><input type="checkbox" data-po-select-all ${allVisibleSelected ? 'checked' : ''} /></label>
        <span>PO</span>
        <span>Supplier</span>
        <span>Status</span>
        <span>Lines</span>
        <span>Total Ex</span>
        <span>Actions</span>
      </div>
      <div class="purchaseOrdersModule__listBody">
        ${orders.map((order) => renderOrderRow(order, selectedIds)).join('')}
      </div>
    </section>
  `;
}

function renderOrderRow(order, selectedIds) {
  const statusClassName = getStatusClass(order.status);
  const selectedClass = selectedIds.has(String(order.id)) ? ' is-selected' : '';
  const locations = getOrderLocationSummary(order);
  return `
    <article class="purchaseOrdersModule__row purchaseOrdersModule__row--${escapeAttribute(statusClassName)}${selectedClass}">
      <label><input type="checkbox" data-po-select="${escapeAttribute(order.id)}" ${selectedIds.has(String(order.id)) ? 'checked' : ''} /></label>
      <div>
        <strong>${escapeHtml(order.poNumber)}</strong>
        <small>${escapeHtml(formatDate(order.updatedAt || order.createdAt))}</small>
      </div>
      <div>
        <strong>${escapeHtml(order.supplierName)}</strong>
        <small>${escapeHtml(locations)}</small>
      </div>
      <span class="purchaseOrdersModule__status purchaseOrdersModule__status--${escapeAttribute(statusClassName)}">${escapeHtml(formatPoStatus(order.status))}</span>
      <span>${order.items.length}</span>
      <span>${currency(totalOrderValue(order))}</span>
      <div class="purchaseOrdersModule__rowActions">
        ${renderStatusAction(order)}
        ${renderIconButton('download', 'Export PDF', `data-po-pdf="${escapeAttribute(order.id)}"`)}
        ${renderIconButton('edit', 'Edit purchase order', `data-po-edit="${escapeAttribute(order.id)}"`)}
        ${renderIconButton('trash', 'Delete purchase order', `data-po-delete="${escapeAttribute(order.id)}"`)}
      </div>
    </article>
  `;
}

function renderTileView(orders, selectedIds) {
  return `
    <section class="purchaseOrdersModule__tiles" aria-label="Purchase order tile view">
      ${orders.map((order) => {
        const statusClassName = getStatusClass(order.status);
        const selectedClass = selectedIds.has(String(order.id)) ? ' is-selected' : '';
        return `
        <article class="purchaseOrdersModule__card purchaseOrdersModule__card--${escapeAttribute(statusClassName)}${selectedClass}">
          <div class="purchaseOrdersModule__cardTop">
            <label><input type="checkbox" data-po-select="${escapeAttribute(order.id)}" ${selectedIds.has(String(order.id)) ? 'checked' : ''} /></label>
            <span class="purchaseOrdersModule__status purchaseOrdersModule__status--${escapeAttribute(statusClassName)}">${escapeHtml(formatPoStatus(order.status))}</span>
          </div>
          <div class="purchaseOrdersModule__cardBody">
            <div class="purchaseOrdersModule__cardInfo">
              <h2>${escapeHtml(order.poNumber)}</h2>
              <p>${escapeHtml(order.supplierName)}</p>
            </div>
            <div class="purchaseOrdersModule__cardBottom">
              <div class="purchaseOrdersModule__metricGrid">
                <span><strong>${order.items.length}</strong><em>Lines</em></span>
                <span><strong>${currency(totalOrderValue(order))}</strong><em>Total Ex</em></span>
              </div>
              <div class="purchaseOrdersModule__cardFooter">
                <div class="purchaseOrdersModule__cardFooterStatus">
                  ${renderStatusAction(order)}
                </div>
                <div class="purchaseOrdersModule__cardFooterIcons">
                  ${renderIconButton('download', 'Export PDF', `data-po-pdf="${escapeAttribute(order.id)}"`)}
                  ${renderIconButton('edit', 'Edit purchase order', `data-po-edit="${escapeAttribute(order.id)}"`)}
                  ${renderIconButton('trash', 'Delete purchase order', `data-po-delete="${escapeAttribute(order.id)}"`)}
                </div>
              </div>
            </div>
          </div>
        </article>
      `;}).join('')}
    </section>
  `;
}

function renderPurchaseOrderWorkflow(purchaseOrders, filters) {
  const draft = purchaseOrders.draftOrder;
  if (!draft) return '';

  const suppliers = purchaseOrders.suppliers || [];
  const stockItems = purchaseOrders.stockItems || [];
  const sites = purchaseOrders.sites || [];
  const locations = purchaseOrders.locations || [];
  const supplierQuery = String(filters.supplierQuery || '').trim().toLowerCase();
  const lineQuery = String(filters.lineQuery || '').trim().toLowerCase();
  const supplierMatches = suppliers
    .filter((supplier) => !supplierQuery || String(supplier.name || '').toLowerCase().includes(supplierQuery))
    .slice(0, 12);
  const stockMatches = stockItems
    .filter(isPhysicalStockItem)
    .filter((item) => !lineQuery || String(item.name || '').toLowerCase().includes(lineQuery) || String(item.category || '').toLowerCase().includes(lineQuery) || stockItemHasBarcode(item, lineQuery))
    .slice(0, 12);
  const selectedSupplier = suppliers.find((supplier) => String(supplier.id) === String(draft.supplierId));

  const modal = draft.inputMode === 'input'
    ? renderQuantityInputModal({ state, draft, filters, sites, locations, actionStatus: purchaseOrders.actionStatus, error: purchaseOrders.actionError })
    : renderSelectionBuilderModal({ state, draft, filters, stockMatches, sites, locations, selectedSupplier, error: purchaseOrders.actionError });

  return `
    ${modal}
    ${draft.supplierPickerOpen ? renderSupplierPickerOverlay(draft, filters, supplierMatches) : ''}
    ${filters.overlay === 'calendar' ? renderCustomCalendarOverlay({
      title: 'Select Purchase Order Date',
      selectedDate: draft.date || todayLocal(),
      cursorDate: filters.calendarCursor || draft.date || todayLocal()
    }) : ''}
  `;
}

function renderSelectionBuilderModal({ state, draft, filters, stockMatches, sites, locations, selectedSupplier, error }) {
  const pendingItems = draft.items || [];
  const hasSupplier = Boolean(draft.supplierId);
  return `
    <div class="purchaseOrdersModule__modalBackdrop">
      <form class="purchaseOrdersModule__modal purchaseOrdersModule__modal--selection" data-scroll-key="purchase-order-selection-modal">
        <div class="purchaseOrdersModule__modalHeader">
          <div>
            <span>Purchase Order Draft</span>
            <h2>${draft.id ? 'Edit Purchase Order' : 'New Purchase Order'}</h2>
            <p>${escapeHtml(draft.supplierName || 'Select a supplier, then add stock items to the pending list.')}</p>
          </div>
          <button type="button" class="purchaseOrdersModule__ghostIcon" data-po-close aria-label="Close">${icon('x')}</button>
        </div>
        ${error ? renderNotice(error, 'error') : ''}
        <section class="purchaseOrdersModule__draftBuilder ${hasSupplier ? '' : 'purchaseOrdersModule__draftBuilder--locked'}">
          <aside class="purchaseOrdersModule__draftMeta" data-scroll-key="purchase-order-draft-meta">
            <div class="purchaseOrdersModule__supplierCard">
              <span>Supplier</span>
              <strong>${escapeHtml(draft.supplierName || 'No supplier selected')}</strong>
              <small>${escapeHtml(selectedSupplier ? getSupplierDetailLine(selectedSupplier) : 'Use Select Supplier to lock this draft before adding stock items.')}</small>
              <button type="button" class="purchaseOrdersModule__secondary" data-po-open-supplier>${draft.supplierId ? 'Change Supplier' : 'Select Supplier'}</button>
            </div>
            <div class="purchaseOrdersModule__fieldPair">
              <label>
                <span>PO Reference</span>
                <input value="${escapeAttribute(draft.reference || '')}" placeholder="PO-001" data-po-draft-field="reference" data-focus-key="po-draft-reference" />
              </label>
              <label>
                <span>Date</span>
                <button
                  type="button"
                  class="purchaseOrdersModule__dateButton"
                  data-po-open-calendar
                  data-po-calendar-date="${escapeAttribute(draft.date || todayLocal())}"
                >
                  <strong>${escapeHtml(formatDisplayDate(draft.date || todayLocal()))}</strong>
                  ${icon('calendar')}
                </button>
              </label>
            </div>
            ${renderSiteDropdown(draft.siteId || getSiteIdForLocation(locations, draft.locationId), filters.openDropdown, sites)}
            ${renderLocationDropdown(draft.locationId, filters.openDropdown, locations, draft.siteId || getSiteIdForLocation(locations, draft.locationId))}
            <label>
              <span>Notes</span>
              <input name="notes" value="${escapeAttribute(draft.notes || '')}" placeholder="Optional receiving notes..." data-po-draft-field="notes" data-focus-key="po-draft-notes" />
            </label>
          </aside>

          ${hasSupplier ? renderStockSelectionPanel({ filters, stockMatches, pendingItems, draft }) : renderSupplierRequiredPanel()}
          ${hasSupplier ? renderPendingSelectionTray(pendingItems, draft) : ''}
        </section>

        <div class="purchaseOrdersModule__modalFooter">
          <div class="purchaseOrdersModule__selectionSummary">
            <span>${pendingItems.length} selected</span>
            <strong>${escapeHtml(draft.supplierName || 'No supplier')}</strong>
          </div>
          <div>
            <button type="button" class="purchaseOrdersModule__secondary" data-po-close>Cancel</button>
            <button type="button" class="purchaseOrdersModule__primary" data-po-confirm-selection ${draft.supplierId && pendingItems.length && !isPurchaseOrderReadOnly(draft) ? '' : 'disabled'}>Confirm Selection</button>
          </div>
        </div>
      </form>
    </div>
  `;
}

function getSupplierDetailLine(supplier = {}) {
  const parts = [supplier.contactPerson, supplier.email, supplier.paymentTerms].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Live supplier record';
}

function renderSupplierRequiredPanel() {
  return `
    <section class="purchaseOrdersModule__supplierRequired">
      <span>Step 1</span>
      <h3>Select a supplier first</h3>
      <p>Once the supplier is locked in, the stock item search and pending selection tray will unlock for this draft.</p>
      <button type="button" class="purchaseOrdersModule__primary" data-po-open-supplier>${icon('plus')}<span>Select Supplier</span></button>
    </section>
  `;
}

function renderStockSelectionPanel({ filters, stockMatches, pendingItems, draft = {} }) {
  const readOnly = isPurchaseOrderReadOnly(draft);
  return `
    <section class="purchaseOrdersModule__searchPanel">
      <label>
        <span>Add Stock Items</span>
        <div class="purchaseOrdersModule__searchShell">
          <input type="search" value="${escapeAttribute(filters.lineQuery)}" placeholder="Search stock items or scan barcode..." data-po-filter="lineQuery" ${readOnly ? 'disabled' : ''} />
          <button type="button" data-po-scan-barcode aria-label="Scan barcode" title="Scan barcode" ${readOnly ? 'disabled' : ''}>${icon('camera')}</button>
        </div>
      </label>
      <div class="purchaseOrdersModule__choiceList purchaseOrdersModule__choiceList--stock" data-scroll-key="purchase-order-stock-picker">
        ${stockMatches.map((item) => renderStockChoice(item, pendingItems, readOnly)).join('') || '<p class="purchaseOrdersModule__emptyState">Search for a stock item to add it to this PO.</p>'}
      </div>
    </section>
  `;
}

function renderPendingSelectionTray(pendingItems, draft = {}) {
  return `
    <section class="purchaseOrdersModule__pendingTray">
      <div class="purchaseOrdersModule__sectionTitle">
        <span>Pending Selection</span>
        <strong>${pendingItems.length} item${pendingItems.length === 1 ? '' : 's'}</strong>
      </div>
      <div class="purchaseOrdersModule__pendingList" data-scroll-key="purchase-order-pending-list">
        ${pendingItems.map((line, index) => `
          <article>
            <div>
              <strong>${escapeHtml(line.stockItemName || line.stockItemId)}</strong>
              <small>${escapeHtml([
                line.unit || 'EA',
                currency(line.unitCost),
                isPurchaseOrderLineLocked(line) ? `Received ${line.receivedQty || 0} / ${line.qty || 0}` : ''
              ].filter(Boolean).join(' · '))}</small>
            </div>
            <button type="button" class="purchaseOrdersModule__ghostIcon" data-po-line-remove="${index}" aria-label="Remove pending item" ${isPurchaseOrderLineLocked(line) || isPurchaseOrderReadOnly(draft) ? 'disabled' : ''}>${icon('trash')}</button>
          </article>
        `).join('') || '<p class="purchaseOrdersModule__emptyState">Selected stock items will appear here before quantity and cost input.</p>'}
      </div>
    </section>
  `;
}

function renderStockChoice(item, pendingItems = [], disabled = false) {
  const selected = pendingItems.some((line) => String(line.stockItemId) === String(item.id));
  const unit = item.unit || 'EA';
  const price = item.lastPurchasePrice ?? item.lastPurchaseCost ?? item.latestPurchasePrice ?? item.cost;
  return `
    <button type="button" class="${selected ? 'is-selected' : ''}" data-po-add-stock="${escapeAttribute(item.id)}" ${disabled ? 'disabled' : ''}>
      <span class="purchaseOrdersModule__stockLine">
        <strong>${escapeHtml(item.name)}</strong>
        <em>${escapeHtml(unit)} · ${currency(price)}</em>
      </span>
      <small>${escapeHtml(item.category || 'Uncategorised')}</small>
    </button>
  `;
}

function renderQuantityInputModal({ state, draft, filters, sites, locations, actionStatus, error }) {
  const subtotal = totalOrderValue(draft);
  const vat = subtotal * getVatRate(state);
  const total = subtotal + vat;
  return `
    <div class="purchaseOrdersModule__modalBackdrop">
      <form class="purchaseOrdersModule__modal purchaseOrdersModule__modal--input" data-scroll-key="purchase-order-input-modal">
        <div class="purchaseOrdersModule__modalHeader">
          <div>
            <span>Quantity & Cost Input</span>
            <h2>${escapeHtml(draft.reference || draft.poNumber || 'New Purchase Order')}</h2>
            <p>${escapeHtml(draft.supplierName || 'Supplier not selected')}</p>
          </div>
          <button type="button" class="purchaseOrdersModule__ghostIcon" data-po-close aria-label="Close">${icon('x')}</button>
        </div>
        ${error ? renderNotice(error, 'error') : ''}
        ${renderQuantityLines(draft, filters, locations)}
        <div class="purchaseOrdersModule__modalFooter">
          <div class="purchaseOrdersModule__totals">
            <span><em>Subtotal</em><strong>${currency(subtotal)}</strong></span>
            <span><em>VAT</em><strong>${currency(vat)}</strong></span>
            <span><em>Total</em><strong>${currency(total)}</strong></span>
          </div>
          <div>
            <button type="button" class="purchaseOrdersModule__secondary" data-po-back-selection>Back</button>
            <button type="button" class="purchaseOrdersModule__primary" data-po-save ${actionStatus === 'saving' ? 'disabled' : ''}>
              ${actionStatus === 'saving' ? 'Saving' : isPurchaseOrderReadOnly(draft) ? 'Save Notes' : 'Confirm Order'}
            </button>
          </div>
        </div>
      </form>
    </div>
  `;
}

function renderQuantityLines(draft, filters, locations) {
  const lines = draft.items || [];
  return `
    <section class="purchaseOrdersModule__lines" aria-label="Purchase order lines">
      <div class="purchaseOrdersModule__linesHead">
        <span>Stock Item</span>
        <span>UOM</span>
        <span>Qty</span>
        <span>Pack</span>
        <span>Unit Cost</span>
        <span>Location</span>
        <span>Total</span>
        <span></span>
      </div>
      <div class="purchaseOrdersModule__linesBody" data-scroll-key="purchase-order-lines">
        ${lines.map((line, index) => {
          const locked = isPurchaseOrderLineLocked(line) || isPurchaseOrderReadOnly(draft);
          return `
          <article class="purchaseOrdersModule__line">
            <div>
              <strong>${escapeHtml(line.stockItemName || line.stockItemId)}</strong>
              <small>${escapeHtml(isPurchaseOrderLineLocked(line)
                ? `${line.stockItemId || ''} · Received ${line.receivedQty || 0} / ${line.qty || 0}`
                : (line.stockItemId || ''))}</small>
            </div>
            ${renderPurchaseLineUomSelect(line, index, locked, filters.openDropdown)}
            <input type="text" inputmode="decimal" value="${escapeAttribute(Number(line.qty) ? line.qty : '')}" placeholder="0" data-po-line="qty" data-po-line-index="${index}" ${locked ? 'disabled' : ''} />
            <input type="text" inputmode="decimal" value="${escapeAttribute(line.packSize || 1)}" data-po-line="packSize" data-po-line-index="${index}" ${locked ? 'disabled' : ''} ${isPurchaseLineCustomUom(line) ? 'readonly title="Pack size is set by the selected UOM."' : ''} />
            <input type="text" inputmode="decimal" value="${escapeAttribute(Number(line.unitCost) ? line.unitCost : '')}" placeholder="0" data-po-line="unitCost" data-po-line-index="${index}" ${locked ? 'disabled' : ''} />
            ${renderLineLocationDropdown(index, line.locationId || line.targetLocation || draft.locationId || '', filters.openDropdown, locations, line.siteId || draft.siteId || getSiteIdForLocation(locations, line.locationId || line.targetLocation || draft.locationId || ''), locked)}
            <span>${currency(Number(line.qty || 0) * getPositivePackSize(line.packSize) * Number(line.unitCost || 0))}</span>
            <button type="button" class="purchaseOrdersModule__ghostIcon" data-po-line-remove="${index}" aria-label="Remove line" ${locked ? 'disabled' : ''}>${icon('trash')}</button>
          </article>
        `;
        }).join('') || '<div class="purchaseOrdersModule__emptyState">Go back and add stock items before confirming this order.</div>'}
      </div>
    </section>
  `;
}

function renderSupplierPickerOverlay(draft, filters, supplierMatches) {
  return `
    <div class="purchaseOrdersModule__modalBackdrop purchaseOrdersModule__modalBackdrop--stacked">
      <section class="purchaseOrdersModule__modal purchaseOrdersModule__modal--supplierPicker" role="dialog" aria-modal="true" data-scroll-key="purchase-order-supplier-picker-modal">
        <div class="purchaseOrdersModule__modalHeader">
          <div>
            <span>Select Supplier</span>
            <h2>Supplier Directory</h2>
            <p>${escapeHtml(draft.supplierName || 'Choose the supplier for this purchase order.')}</p>
          </div>
          <button type="button" class="purchaseOrdersModule__ghostIcon" data-po-supplier-close aria-label="Close">${icon('x')}</button>
        </div>
        <label>
          <span>Search Suppliers</span>
          <input type="search" value="${escapeAttribute(filters.supplierQuery || '')}" placeholder="Search supplier name..." data-po-filter="supplierQuery" />
        </label>
        <div class="purchaseOrdersModule__choiceList purchaseOrdersModule__choiceList--supplier" data-scroll-key="purchase-order-supplier-picker-list">
          ${supplierMatches.map((supplier) => `
            <button type="button" class="${String(supplier.id) === String(draft.supplierId) ? 'is-selected' : ''}" data-po-supplier-select="${escapeAttribute(supplier.id)}" data-po-supplier-name="${escapeAttribute(supplier.name)}">
              <strong>${escapeHtml(supplier.name)}</strong>
              <small>${escapeHtml(supplier.paymentTerms || supplier.email || 'Live supplier record')}</small>
            </button>
          `).join('') || '<p class="purchaseOrdersModule__emptyState">No suppliers match your search.</p>'}
        </div>
      </section>
    </div>
  `;
}

function renderOrderModal(purchaseOrders, filters) {
  const draft = purchaseOrders.draftOrder;
  if (!draft) return '';

  const suppliers = purchaseOrders.suppliers || [];
  const stockItems = purchaseOrders.stockItems || [];
  const sites = purchaseOrders.sites || [];
  const locations = purchaseOrders.locations || [];
  const wizardStep = getWizardStep(draft);
  const supplierQuery = String(filters.supplierQuery || draft.supplierQuery || '').trim().toLowerCase();
  const lineQuery = String(filters.lineQuery || '').trim().toLowerCase();
	  const supplierMatches = suppliers
	    .filter((supplier) => !supplierQuery || String(supplier.name || '').toLowerCase().includes(supplierQuery))
	    .slice(0, 8);
	  const stockMatches = stockItems
	    .filter(isPhysicalStockItem)
	    .filter((item) => !lineQuery || String(item.name || '').toLowerCase().includes(lineQuery) || String(item.category || '').toLowerCase().includes(lineQuery) || stockItemHasBarcode(item, lineQuery))
	    .slice(0, 10);
  const subtotal = totalOrderValue(draft);
  const vat = subtotal * getVatRate(state);
  const total = subtotal + vat;

  return `
    <div class="purchaseOrdersModule__modalBackdrop">
      <form class="purchaseOrdersModule__modal" data-scroll-key="purchase-order-wizard-modal">
	        <div class="purchaseOrdersModule__modalHeader">
	          <div>
	            <span>Purchase Order Workflow</span>
	            <h2>${draft.id ? 'Edit Purchase Order' : 'New Purchase Order'}</h2>
	          </div>
	          <button type="button" class="purchaseOrdersModule__ghostIcon" data-po-close aria-label="Close">${icon('x')}</button>
	        </div>
		        ${renderWizardSteps(wizardStep, draft)}
	        ${purchaseOrders.actionError ? renderNotice(purchaseOrders.actionError, 'error') : ''}
	        ${renderWizardPane({ wizardStep, draft, filters, supplierMatches, stockMatches, sites, locations })}
	
	        <div class="purchaseOrdersModule__modalFooter">
	          <div class="purchaseOrdersModule__totals">
	            <span><em>Subtotal</em><strong>${currency(subtotal)}</strong></span>
	            <span><em>VAT</em><strong>${currency(vat)}</strong></span>
	            <span><em>Total</em><strong>${currency(total)}</strong></span>
	          </div>
	          ${renderWizardFooter(wizardStep, draft, purchaseOrders.actionStatus)}
	        </div>
	      </form>
	    </div>
	  `;
}

function renderWizardSteps(activeStep, draft = {}) {
  const steps = [
    { value: 1, label: 'Supplier' },
    { value: 2, label: 'Selection' },
    { value: 3, label: 'Input' }
  ];
  return `
    <div class="purchaseOrdersModule__wizardSteps" aria-label="Purchase order steps">
      ${steps.map((step) => `
        <button type="button" class="${step.value === activeStep ? 'is-active' : ''}" data-po-step="${step.value}" ${isWizardStepLocked(step.value, draft) ? 'disabled' : ''}>
          <span>${step.value}</span>
          <strong>${escapeHtml(step.label)}</strong>
        </button>
      `).join('')}
    </div>
  `;
}

function renderWizardPane({ wizardStep, draft, filters, supplierMatches, stockMatches, sites, locations }) {
  if (wizardStep === 1) return renderSupplierStep(draft, filters, supplierMatches, sites, locations);
  if (wizardStep === 2) return renderSelectionStep(draft, filters, stockMatches);
  return renderInputStep(draft, filters, locations);
}

function renderSupplierStep(draft, filters, supplierMatches, sites, locations) {
  return `
    <section class="purchaseOrdersModule__wizardPane purchaseOrdersModule__wizardPane--supplier">
      <div class="purchaseOrdersModule__builderPanel">
        <label>
          ${renderFieldHelpLabel('Supplier', 'Choose the supplier record that this purchase order belongs to.')}
          <input type="search" value="${escapeAttribute(filters.supplierQuery || draft.supplierQuery || draft.supplierName || '')}" placeholder="Search suppliers..." data-po-filter="supplierQuery" />
        </label>
        <div class="purchaseOrdersModule__choiceList purchaseOrdersModule__choiceList--supplier" data-scroll-key="purchase-order-wizard-supplier-list">
          ${supplierMatches.map((supplier) => `
            <button type="button" class="${String(supplier.id) === String(draft.supplierId) ? 'is-selected' : ''}" data-po-supplier-select="${escapeAttribute(supplier.id)}" data-po-supplier-name="${escapeAttribute(supplier.name)}">
              <strong>${escapeHtml(supplier.name)}</strong>
              <small>${escapeHtml(supplier.paymentTerms || supplier.email || 'Live supplier record')}</small>
            </button>
          `).join('') || '<p class="purchaseOrdersModule__emptyState">No suppliers match your search.</p>'}
        </div>
      </div>
      <div class="purchaseOrdersModule__builderPanel">
        <div class="purchaseOrdersModule__fieldPair">
          <label>
            ${renderFieldHelpLabel('Reference', 'Internal or supplier-facing PO reference used to identify this order later.')}
            <input value="${escapeAttribute(draft.reference || draft.poNumber || '')}" placeholder="PO reference..." data-po-draft-field="reference" data-focus-key="po-draft-reference" />
          </label>
          <label>
            ${renderFieldHelpLabel('Date', 'Trade date for this purchase order.')}
            <button
              type="button"
              class="purchaseOrdersModule__dateButton"
              data-po-open-calendar
              data-po-calendar-date="${escapeAttribute(draft.date || todayLocal())}"
            >
              <strong>${escapeHtml(formatDisplayDate(draft.date || todayLocal()))}</strong>
              ${icon('calendar')}
            </button>
          </label>
        </div>
        ${renderSiteDropdown(draft.siteId || getSiteIdForLocation(locations, draft.locationId), filters.openDropdown, sites)}
        ${renderLocationDropdown(draft.locationId, filters.openDropdown, locations, draft.siteId || getSiteIdForLocation(locations, draft.locationId))}
        <label>
          ${renderFieldHelpLabel('Notes', 'Optional ordering or receiving notes for the team and supplier.')}
          <input name="notes" value="${escapeAttribute(draft.notes || '')}" placeholder="Optional receiving notes..." data-po-draft-field="notes" data-focus-key="po-draft-notes" />
        </label>
      </div>
    </section>
  `;
}

function renderSelectionStep(draft, filters, stockMatches) {
  const pendingItems = draft.items || [];
  return `
    <section class="purchaseOrdersModule__wizardPane purchaseOrdersModule__wizardPane--selection">
      <div class="purchaseOrdersModule__builderPanel">
        <label>
          ${renderFieldHelpLabel('Add Stock Items', 'Search the live stock master and add items into this purchase order draft.')}
          <div class="purchaseOrdersModule__searchShell">
            <input type="search" value="${escapeAttribute(filters.lineQuery)}" placeholder="Search stock items or scan barcode..." data-po-filter="lineQuery" />
            <button type="button" data-po-scan-barcode aria-label="Scan barcode" title="Scan barcode">${icon('camera')}</button>
          </div>
        </label>
        <div class="purchaseOrdersModule__choiceList purchaseOrdersModule__choiceList--stock" data-scroll-key="purchase-order-wizard-stock-list">
          ${stockMatches.map((item) => `
            <button type="button" data-po-add-stock="${escapeAttribute(item.id)}">
              <strong>${escapeHtml(item.name)}</strong>
              <small>${escapeHtml(item.category || 'Uncategorised')} · ${escapeHtml(item.unit || 'ea')} · ${currency(item.lastPurchasePrice ?? item.lastPurchaseCost ?? item.latestPurchasePrice ?? item.cost)}</small>
            </button>
          `).join('') || '<p class="purchaseOrdersModule__emptyState">Search for a stock item to add it to this PO.</p>'}
        </div>
      </div>
      <div class="purchaseOrdersModule__pendingTray">
        <div class="purchaseOrdersModule__sectionTitle">
          <span>Pending Selection</span>
          <strong>${pendingItems.length} item${pendingItems.length === 1 ? '' : 's'}</strong>
        </div>
        <div class="purchaseOrdersModule__pendingList" data-scroll-key="purchase-order-wizard-pending-list">
          ${pendingItems.map((line, index) => `
            <article>
              <div>
                <strong>${escapeHtml(line.stockItemName || line.stockItemId)}</strong>
                <small>${escapeHtml(line.selectedUom || line.unit || 'ea')} · ${currency(line.unitCost)}</small>
              </div>
              <button type="button" class="purchaseOrdersModule__ghostIcon" data-po-line-remove="${index}" aria-label="Remove pending item">${icon('trash')}</button>
            </article>
          `).join('') || '<p class="purchaseOrdersModule__emptyState">Selected stock items will appear here before quantity and cost input.</p>'}
        </div>
      </div>
    </section>
  `;
}

function renderInputStep(draft, filters, locations) {
  const lines = draft.items || [];
  return `
    <section class="purchaseOrdersModule__lines" aria-label="Purchase order lines">
      <div class="purchaseOrdersModule__linesHead">
        <span>Stock Item</span>
        <span>UOM</span>
        <span>Qty</span>
        <span>Pack</span>
        <span>Unit Cost</span>
        <span>Location</span>
        <span>Total</span>
        <span></span>
      </div>
      <div class="purchaseOrdersModule__linesBody" data-scroll-key="purchase-order-wizard-lines">
        ${lines.map((line, index) => `
          <article class="purchaseOrdersModule__line">
            <div>
              <strong>${escapeHtml(line.stockItemName || line.stockItemId)}</strong>
              <small>${escapeHtml(line.unit || 'ea')} base</small>
            </div>
            ${renderPurchaseLineUomSelect(line, index, false, filters.openDropdown)}
            <input type="text" inputmode="decimal" value="${escapeAttribute(line.qty)}" data-po-line="qty" data-po-line-index="${index}" />
            <input type="text" inputmode="decimal" value="${escapeAttribute(line.packSize || 1)}" data-po-line="packSize" data-po-line-index="${index}" ${isPurchaseLineCustomUom(line) ? 'readonly title="Pack size is set by the selected UOM."' : ''} />
            <input type="text" inputmode="decimal" value="${escapeAttribute(line.unitCost)}" data-po-line="unitCost" data-po-line-index="${index}" />
            ${renderLineLocationDropdown(index, line.locationId || line.targetLocation || draft.locationId || '', filters.openDropdown, locations, line.siteId || draft.siteId || getSiteIdForLocation(locations, line.locationId || line.targetLocation || draft.locationId || ''))}
            <span>${currency(Number(line.qty || 0) * getPositivePackSize(line.packSize) * Number(line.unitCost || 0))}</span>
            <button type="button" class="purchaseOrdersModule__ghostIcon" data-po-line-remove="${index}" aria-label="Remove line">${icon('trash')}</button>
          </article>
        `).join('') || '<div class="purchaseOrdersModule__emptyState">Go back to Selection and add stock items before confirming this order.</div>'}
      </div>
    </section>
  `;
}

function renderWizardFooter(wizardStep, draft, actionStatus) {
  if (wizardStep === 1) {
    return `
      <div>
        <button type="button" class="purchaseOrdersModule__secondary" data-po-close>Cancel</button>
        <button type="button" class="purchaseOrdersModule__primary" data-po-step="2" ${(draft.supplierId && draft.locationId) ? '' : 'disabled'}>Continue</button>
      </div>
    `;
  }

  if (wizardStep === 2) {
    return `
      <div>
        <button type="button" class="purchaseOrdersModule__secondary" data-po-step="1">Back</button>
        <button type="button" class="purchaseOrdersModule__primary" data-po-step="3" ${(draft.items || []).length ? '' : 'disabled'}>Continue</button>
      </div>
    `;
  }

  return `
    <div>
      <button type="button" class="purchaseOrdersModule__secondary" data-po-step="2">Back</button>
      <button type="button" class="purchaseOrdersModule__primary" data-po-save ${actionStatus === 'saving' ? 'disabled' : ''}>
        ${actionStatus === 'saving' ? 'Saving' : 'Confirm Order'}
      </button>
    </div>
  `;
}

function renderDropdown({ id, label, value, openDropdown, options }) {
  const activeOption = options.find((option) => option.value === value) || options[0];
  const isOpen = openDropdown === id;
  return `
    <div class="purchaseOrdersModule__dropdown ${isOpen ? 'purchaseOrdersModule__dropdown--open' : ''}" data-po-dropdown-root>
      ${renderFieldHelpLabel(label, id === 'status' ? 'Filter the order list by operational status such as draft, sent, partially received, or completed.' : '')}
      <button type="button" data-po-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(activeOption.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="purchaseOrdersModule__dropdownMenu">
        ${options.map((option) => `
          <button type="button" data-po-option data-po-option-group="${escapeAttribute(id)}" data-po-option-value="${escapeAttribute(option.value)}" class="${option.value === value ? 'is-active' : ''}">
            ${escapeHtml(option.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderActionDropdown(openDropdown) {
  const isOpen = openDropdown === 'poActions';
  return `
    <div class="purchaseOrdersModule__dropdown purchaseOrdersModule__actionDropdown ${isOpen ? 'purchaseOrdersModule__dropdown--open' : ''}" data-po-dropdown-root>
      <button type="button" data-po-dropdown="poActions" aria-expanded="${isOpen}">
        ${icon('download')}
        <strong>Action Items</strong>
        ${icon('chevron')}
      </button>
      <div class="purchaseOrdersModule__dropdownMenu">
        <button type="button" data-po-export="xlsx">${icon('download')}<span>XLSX</span></button>
        <button type="button" data-po-export="pdf">${icon('download')}<span>PDF</span></button>
      </div>
    </div>
  `;
}

function renderSiteDropdown(siteId, openDropdown, sites = []) {
  const options = (sites || []).map((site) => ({ value: site.id, label: site.name || site.code || site.id }));
  if (options.length <= 1) return '';
  const active = options.find((option) => String(option.value) === String(siteId)) || options[0] || { value: '', label: 'No Location Group' };
  const isOpen = openDropdown === 'site';
  return `
    <div class="purchaseOrdersModule__dropdown ${isOpen ? 'purchaseOrdersModule__dropdown--open' : ''}" data-po-dropdown-root>
	      ${renderFieldHelpLabel('Location Group', 'Trading location group for this purchase order.')}
      <button type="button" data-po-dropdown="site" aria-expanded="${isOpen}">
        <strong>${escapeHtml(active.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="purchaseOrdersModule__dropdownMenu">
        ${options.map((option) => `
          <button type="button" data-po-site="${escapeAttribute(option.value)}" class="${String(option.value) === String(siteId) ? 'is-active' : ''}">
            ${escapeHtml(option.label)}
          </button>
        `).join('')}
      </div>
    </div>
	  `;
}

function renderLocationDropdown(locationId, openDropdown, locations, siteId = '') {
  const options = (locations || [])
    .filter((location) => !siteId || String(location.siteId || '') === String(siteId))
    .map((location) => ({ value: location.id, label: location.displayName || location.name }));
  const active = options.find((option) => String(option.value) === String(locationId)) || null;
  const hasLocation = Boolean(active);
  return `
    <div class="po-locationPicker">
      ${renderFieldHelpLabel('Destination Location', 'Choose which location this stock will be received into.')}
      <button type="button" class="po-locationPickerBtn ${hasLocation ? 'po-locationPickerBtn--set' : ''}" data-po-open-location-modal>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <span>${escapeHtml(active?.label || 'Select your location')}</span>
        ${hasLocation ? `<em class="po-locationPickerBadge">✓</em>` : ''}
      </button>
    </div>
  `;
}

function renderLocationModal(locationId, openDropdown, locations, siteId = '') {
  if (openDropdown !== 'location-modal') return '';
  const options = (locations || [])
    .filter((location) => !siteId || String(location.siteId || '') === String(siteId))
    .map((location) => ({ value: location.id, label: location.displayName || location.name }));
  return `
    <div class="po-locationModalBackdrop" data-po-close-location-modal>
      <div class="po-locationModal" role="dialog" aria-modal="true" aria-label="Select destination location">
        <div class="po-locationModalHeader">
          <h3>Select Destination Location</h3>
          <button type="button" class="po-locationModalClose" data-po-close-location-modal aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <p class="po-locationModalSub">Choose where this stock will be received into.</p>
        <div class="po-locationModalList">
          ${options.length ? options.map((option) => {
            const isSelected = String(option.value) === String(locationId);
            return `
              <button type="button" class="po-locationCard ${isSelected ? 'po-locationCard--selected' : ''}" data-po-location="${escapeAttribute(option.value)}">
                <span class="po-locationCardIcon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                </span>
                <span class="po-locationCardName">${escapeHtml(option.label)}</span>
                ${isSelected ? `<span class="po-locationCardCheck"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></span>` : ''}
              </button>
            `;
          }).join('') : `<div class="po-locationModalEmpty">No locations available. Add locations in Settings.</div>`}
        </div>
      </div>
    </div>
  `;
}

function getSiteIdForLocation(locations = [], locationId = '') {
  return String((locations || []).find((location) => String(location.id) === String(locationId))?.siteId || '');
}

function renderLineLocationDropdown(index, locationId, openDropdown, locations, siteId = '', disabled = false) {
  const dropdownId = `line-location-${index}`;
  const options = (locations || [])
    .filter((location) => !siteId || String(location.siteId || '') === String(siteId))
    .map((location) => ({ value: location.id, label: location.displayName || location.name }));
  const active = options.find((option) => String(option.value) === String(locationId)) || {
    value: '',
    label: options.length ? 'Select Location' : 'No saved locations'
  };
  const isOpen = openDropdown === dropdownId;
  return `
    <div class="purchaseOrdersModule__dropdown purchaseOrdersModule__lineLocation ${isOpen ? 'purchaseOrdersModule__dropdown--open' : ''}" data-po-dropdown-root>
      <button type="button" data-po-dropdown="${escapeAttribute(dropdownId)}" aria-expanded="${isOpen}" ${disabled ? 'disabled' : ''}>
        <strong>${escapeHtml(active.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="purchaseOrdersModule__dropdownMenu">
        ${options.length ? options.map((option) => `
          <button type="button" data-po-line-location="${escapeAttribute(option.value)}" data-po-line-location-name="${escapeAttribute(option.label)}" data-po-line-location-index="${index}" class="${String(option.value) === String(locationId) ? 'is-active' : ''}" ${disabled ? 'disabled' : ''}>
            ${escapeHtml(option.label)}
          </button>
        `).join('') : '<span class="purchaseOrdersModule__dropdownEmpty">No saved locations</span>'}
      </div>
    </div>
  `;
}

function renderPurchaseLineUomSelect(line = {}, index = 0, disabled = false, openDropdown = '') {
  const options = getPurchaseLineUomOptions(line);
  const selected = String(line.selectedUom || line.orderUom || line.purchaseUom || line.unit || options[0]?.value || 'ea');
  if (disabled) {
    return `<strong class="purchaseOrdersModule__uom">${escapeHtml(`${selected || line.unit || 'EA'} • Locked`)}</strong>`;
  }
  const active = options.find((option) => String(option.value) === selected) || options[0] || { value: selected, label: selected || 'UOM' };
  const dropdownId = `line-uom-${index}`;
  const isOpen = openDropdown === dropdownId;
  return `
    <div class="purchaseOrdersModule__dropdown purchaseOrdersModule__lineUom ${isOpen ? 'purchaseOrdersModule__dropdown--open' : ''}" data-po-dropdown-root>
      <button type="button" data-po-dropdown="${escapeAttribute(dropdownId)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(active.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="purchaseOrdersModule__dropdownMenu">
      ${options.map((option) => `
        <button type="button" data-po-line-uom="${escapeAttribute(option.value)}" data-po-line-uom-index="${index}" class="${String(option.value) === selected ? 'is-active' : ''}">
          ${escapeHtml(option.label)}
        </button>
      `).join('')}
      </div>
    </div>
  `;
}

function getPurchaseLineUomOptions(line = {}) {
  const baseUom = String(line.unit || line.baseUom || 'ea').trim() || 'ea';
  const configs = normalizeUomConfigurations(line.uomConfigurations || line.uomConfig || line.uomConversions);
  return [
    { value: baseUom, label: `${baseUom} (base)`, ratio: 1, isBase: true },
    ...configs.map((config) => ({
      value: config.customUom,
      label: `${config.customUom} = ${formatUomRatio(config.ratio)} ${config.baseUom || baseUom}`,
      ratio: config.ratio,
      isBase: false
    }))
  ];
}

function isPurchaseLineCustomUom(line = {}) {
  const baseUom = String(line.unit || line.baseUom || 'ea').trim() || 'ea';
  const selected = String(line.selectedUom || line.orderUom || line.purchaseUom || baseUom).trim() || baseUom;
  return selected !== baseUom && getPurchaseLineUomOptions(line).some((option) => String(option.value) === selected && option.isBase !== true);
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

function stockItemHasBarcode(item = {}, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return false;
  const itemBarcodeMatch = [
    item.barcode,
    ...(Array.isArray(item.barcodes) ? item.barcodes : [])
  ].some((barcode) => String(barcode || '').toLowerCase().includes(needle));
  if (itemBarcodeMatch) return true;
  return normalizeUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions)
    .some((config) => config.barcode && config.barcode.toLowerCase().includes(needle));
}

function formatUomRatio(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

function renderStatusAction(order) {
  if (order.status === 'draft' || order.status === 'sent' || order.status === 'partially_received') {
    const label = order.status === 'partially_received' ? 'Receive Remaining' : 'Receive';
    return `
      <button type="button" class="purchaseOrdersModule__statusAction purchaseOrdersModule__statusAction--receive" data-po-status-id="${escapeAttribute(order.id)}" data-po-status="received">${icon('check')}<span>${label}</span></button>
      <button type="button" class="purchaseOrdersModule__statusAction purchaseOrdersModule__statusAction--send" data-po-send="${escapeAttribute(order.id)}">${icon('send')}<span>${order.status === 'draft' ? 'Send' : 'Resend'}</span></button>
    `;
  }
  return `<span class="purchaseOrdersModule__received">${icon('check')} Completed</span>`;
}

function renderBulkBar(ids, actionStatus) {
  return `
    <aside class="purchaseOrdersModule__bulkBar">
      <strong>${ids.length} selected</strong>
      <button type="button" class="purchaseOrdersModule__danger" data-po-delete-selected="${escapeAttribute(JSON.stringify(ids))}" ${actionStatus === 'deleting' ? 'disabled' : ''}>
        ${icon('trash')}
        <span>${actionStatus === 'deleting' ? 'Deleting' : 'Delete Selected'}</span>
      </button>
    </aside>
  `;
}

function renderDeleteDialog(purchaseOrders) {
  const ids = purchaseOrders.confirmDelete?.ids || [];
  if (!ids.length) return '';
  return `
    <div class="purchaseOrdersModule__modalBackdrop">
      <div class="purchaseOrdersModule__confirm">
        <span>Confirm Removal</span>
        <h2>Delete ${ids.length} purchase order${ids.length === 1 ? '' : 's'}?</h2>
        <p>Received stock movement history stays in the GRV log, but these PO documents will be removed.</p>
        <div class="purchaseOrdersModule__modalFooter">
          <button type="button" class="purchaseOrdersModule__secondary" data-po-cancel-delete>Cancel</button>
          <button type="button" class="purchaseOrdersModule__danger" data-po-confirm-delete ${purchaseOrders.actionStatus === 'deleting' ? 'disabled' : ''}>
            ${purchaseOrders.actionStatus === 'deleting' ? 'Deleting' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderGmailPromptModal(purchaseOrders) {
  if (!purchaseOrders.gmailPrompt) return '';
  return `
    <div class="purchaseOrdersModule__modalBackdrop">
      <div class="purchaseOrdersModule__confirm purchaseOrdersModule__confirm--gmail">
        <div class="purchaseOrdersModule__gmailPromptIcon">${icon('send')}</div>
        <span class="purchaseOrdersModule__gmailPromptEyebrow">Gmail Not Connected</span>
        <h2>Link your Gmail account first</h2>
        <p>To send purchase orders by email, your Gmail account must be connected. Head to Integration Settings to link your account — it only takes a moment.</p>
        <div class="purchaseOrdersModule__modalFooter">
          <button type="button" class="purchaseOrdersModule__secondary" data-po-gmail-prompt-close>Cancel</button>
          <button type="button" class="purchaseOrdersModule__primary" data-po-gmail-prompt-integrations>${icon('settings')}<span>Go to Integrations</span></button>
        </div>
      </div>
    </div>
  `;
}

function renderNotice(message, type = 'empty') {
  return `<div class="purchaseOrdersModule__notice purchaseOrdersModule__notice--${escapeAttribute(type)}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast) return '';
  return `
    <div class="purchaseOrdersModule__toast purchaseOrdersModule__toast--${escapeAttribute(toast.type || 'success')}">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-po-toast-dismiss aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function renderViewButton(view, activeView) {
  return `
    <button type="button" class="${view === activeView ? 'is-active' : ''}" data-po-view="${escapeAttribute(view)}" aria-label="${escapeAttribute(view)} view">
      ${icon(view === 'list' ? 'list' : 'grid')}
    </button>
  `;
}

function renderIconButton(iconName, label, attributes) {
  return `<button type="button" class="purchaseOrdersModule__iconButton" ${attributes} aria-label="${escapeAttribute(label)}">${icon(iconName)}</button>`;
}

function filterOrders(items, filters) {
  const query = String(filters.query || '').trim().toLowerCase();
  return (items || []).filter((order) => {
    const statusLabel = formatPoStatus(order.status).toLowerCase();
    const matchesQuery = !query ||
      String(order.poNumber || '').toLowerCase().includes(query) ||
      String(order.supplierName || '').toLowerCase().includes(query) ||
      String(order.status || '').toLowerCase().includes(query) ||
      statusLabel.includes(query);
    const matchesStatus = !filters.status || getStatusClass(order.status) === getStatusClass(filters.status);
    return matchesQuery && matchesStatus;
  });
}

function totalOrderValue(order) {
  return (order.items || []).reduce((sum, line) => sum + Number(line.qty || 0) * getPositivePackSize(line.packSize) * Number(line.unitCost || 0), 0);
}

// This preview previously used a hardcoded 15% with no settings lookup at all, so it always
// showed the wrong VAT for any workspace on a different rate, and would keep showing VAT even
// for a business that is not VAT registered. Reads the same live settings location used
// elsewhere in the app and returns 0 when the workspace is not VAT registered.
function getVatRate(state) {
  const settings = state?.settings?.draft || state?.settings?.values || {};
  if (settings.vatRegistered === false) return 0;
  return (Number(settings.vatRate ?? settings.vatPercentage ?? 15) || 15) / 100;
}

function getPositivePackSize(value) {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getWizardStep(draft = {}) {
  const step = Number(draft.wizardStep || 1);
  if (step < 1) return 1;
  if (step > 3) return 3;
  return step;
}

function isWizardStepLocked(step, draft = {}) {
  if (step <= 1) return false;
  if (step === 2) return !draft.supplierId;
  return !draft.supplierId || !(draft.items || []).length;
}

function getOrderLocationSummary(order = {}) {
  const locations = new Set((order.items || [])
    .map((line) => line.locationName || line.targetLocationName || line.locationId || line.targetLocation)
    .filter(Boolean)
    .map(String));

  if (locations.size > 1) return `${locations.size} receiving locations`;
  if (locations.size === 1) return [...locations][0];
  return order.targetLocationName || order.locationId || 'No location';
}

function getStatusClass(status) {
  const value = String(status || 'draft').toLowerCase();
  if (value === 'sent' || value === 'submitted') return 'submitted';
  if (value === 'partially_received' || value === 'partial' || value === 'partially-received' || value === 'partially received') return 'partial';
  if (value === 'completed' || value === 'received') return 'received';
  return 'draft';
}

function formatPoStatus(status) {
  const value = getStatusClass(status);
  if (value === 'submitted') return 'Sent';
  if (value === 'partial') return 'Partially Received';
  if (value === 'received') return 'Completed';
  return 'Draft';
}

function isPurchaseOrderLineLocked(line = {}) {
  return Number(line.receivedQty || 0) > 0;
}

function isPurchaseOrderReadOnly(order = {}) {
  return String(order.status || '').toLowerCase() === 'completed';
}

function isPhysicalStockItem(item = {}) {
  // Purchase orders can only order Standard and Non Stock items.
  // Sub-Recipe and Manufactured items are produced internally and must not be ordered.
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

function currency(value) {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return 'No date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
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
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    camera: '<path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3l-1.5-2Z"/><circle cx="12" cy="12.5" r="3.5"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    grid: '<path d="M3 3h7v7H3z"/><path d="M14 3h7v7h-7z"/><path d="M14 14h7v7h-7z"/><path d="M3 14h7v7H3z"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
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
