import '../styles/adjustments.css';
import '../styles/fieldHelp.css';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';
import { isSalesAdjustment, isWastageAdjustment } from '../services/wastageClassifier.js';

const WASTE_REASONS = ['Damaged', 'Expired', 'Burnt', 'Prep Error', 'Spillage', 'Theft/Loss', 'Other'];
const SALE_ADJUSTMENT_REASONS = ['POS/Till Offline', 'Order Not Rung Up', 'Staff Meal / Comp', 'Manual/Phone Order', 'Other'];
const ADJUSTMENT_PAGE_SIZE = 25;

export function renderAdjustments({ state, onAdjustmentFilterChange, onAdjustmentAction = {} } = {}) {
  const adjustments = state.adjustments || {};
  const draft = adjustments.draftAdjustment || createEmptyDraft();
  const filters = {
    stockSearch: '',
    stockCategory: '',
    stockPage: 1,
    detailPage: 1,
    overlay: '',
    openDropdown: '',
    adjustmentWorkflow: 'bulk',
    selectedStockIds: [],
    adjustmentTab: 'stock',
    wastageSearch: '',
    wastageCategory: '',
    wastagePage: 1,
    wastageSelectedIds: [],
    saleSearch: '',
    saleCategory: '',
    salePage: 1,
    saleSelectedIds: [],
    ...adjustments.filters
  };
  const activeTab = ['wastage', 'sale'].includes(filters.adjustmentTab) ? filters.adjustmentTab : 'stock';
  // Bulk is now the only stock-adjustment flow (the "Normal" single-item flow was removed).
  const selectedStockIds = new Set((filters.selectedStockIds || []).map(String));
  const stockMatches = getStockMatches(adjustments.stockItems || [], filters.stockSearch || '', filters.stockCategory || '', draft.items || []);
  const totalImpact = (draft.items || []).reduce((sum, item) => sum + Number(item.estimatedImpactEx || 0), 0);
  const stockMap = new Map((adjustments.stockItems || []).map((item) => [String(item.id), item]));
  const hasDraftLines = (draft.items || []).length > 0;

  const view = document.createElement('section');
  view.id = 'view-adjustments';
  view.className = 'adjView';
  view.dataset.openDropdown = filters.openDropdown || '';
  if (adjustments.status === 'loading' && !(adjustments.stockItems || []).length && !(adjustments.locations || []).length) {
    view.innerHTML = renderLoadingPanel('Loading adjustments', 'Fetching stock items, locations, and correction tools.');
    return view;
  }
  view.innerHTML = `
    <div class="adj-tabStrip">
      <button type="button" class="adj-tabBtn ${activeTab === 'stock' ? 'is-active' : ''}" data-adj-tab="stock">
        ${icon('clipboard')} Stock Adjustment
      </button>
      <button type="button" class="adj-tabBtn ${activeTab === 'wastage' ? 'is-active' : ''}" data-adj-tab="wastage">
        ${icon('flame')} Product Wastage Adjustment
      </button>
      <button type="button" class="adj-tabBtn ${activeTab === 'sale' ? 'is-active' : ''}" data-adj-tab="sale">
        ${icon('list')} Product Sales Adjustment
      </button>
    </div>

    ${activeTab === 'wastage'
      ? renderWastageTab(adjustments, filters, onAdjustmentFilterChange, onAdjustmentAction)
      : activeTab === 'sale'
      ? renderSaleAdjustmentTab(adjustments, filters, onAdjustmentFilterChange, onAdjustmentAction)
      : `
    ${adjustments.actionError && !adjustments.lineDetailDraft?.entries?.length ? renderNotice(adjustments.actionError, 'error') : ''}
    <div class="adj-frame">
      <div class="adj-engineShell">
        ${hasDraftLines ? '' : `
          <section class="adj-card adj-engineIntro adj-engineIntro--compact">
            <div class="adj-engineIcon">${icon('list')}</div>
            <div class="adj-engineHead">
              <h3 class="adj-title">Bulk Adjustment</h3>
              <button type="button" class="adj-helpDot" aria-label="Adjustment workflow info">i</button>
            </div>
            <p class="adj-engineLead">Select multiple stock items, enter quantities, and post one grouped adjustment.</p>
            <p class="adj-engineSubcopy">Stock quantity changes from imports are blocked. Use this tab for all balance corrections.</p>
            <div class="adj-engineActions">
              <button type="button" class="adj-primary adj-enginePrimary" data-adj-open-stock>Choose Stock Items</button>
            </div>
          </section>
        `}

        ${hasDraftLines ? `
          <section class="adj-card adj-draftPanel">
            <div class="adj-panelHead">
              <div>
                <h3>Draft Adjustment</h3>
                <span>Bulk · ${(draft.items || []).length} ${(draft.items || []).length === 1 ? 'line' : 'lines'}</span>
              </div>
              <button type="button" class="adj-secondary adj-addItemsButton" data-adj-open-stock>Add Stock Items</button>
            </div>

            <div class="adj-draftScroll">
              ${renderDraftTable(draft)}
            </div>

            <div class="adj-footer">
              <div class="adj-impact">
                <span>Estimated Impact</span>
                <strong>${formatCurrency(totalImpact)}</strong>
              </div>
              <button type="button" class="adj-primary" data-adj-save ${adjustments.actionStatus !== 'saving' ? '' : 'disabled'}>Apply Adjustments</button>
            </div>
          </section>
        ` : ''}
      </div>
    </div>

    ${filters.overlay === 'stock' ? renderStockOverlay(stockMatches, filters, selectedStockIds, adjustments.stockItems || []) : ''}
    ${adjustments.lineDetailDraft?.entries?.length ? renderLineDetailOverlay(adjustments.lineDetailDraft, adjustments.sites || [], adjustments.locations || [], filters, stockMap, adjustments.actionError || '') : ''}
    `}
    ${renderToast(adjustments.toast)}
  `;

  bindAdjustmentEvents(view, adjustments, filters, onAdjustmentFilterChange, onAdjustmentAction);
  bindFieldHelpTooltips(view);
  return view;
}

function bindAdjustmentEvents(view, adjustments, filters, onAdjustmentFilterChange, onAdjustmentAction) {
  view.querySelectorAll('[data-adj-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentFilterChange?.({ adjustmentTab: button.dataset.adjTab, overlay: '', openDropdown: '' });
    });
  });

  // Wastage tab events
  view.querySelectorAll('[data-wastage-open-picker]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentFilterChange?.({ overlay: 'wastage-picker', openDropdown: '', wastageSelectedIds: [] });
    });
  });

  view.querySelector('[data-wastage-picker-close]')?.addEventListener('click', () => {
    onAdjustmentFilterChange?.({ overlay: '', wastageSelectedIds: [] });
  });

  view.querySelector('[data-wastage-search]')?.addEventListener('input', (e) => {
    onAdjustmentFilterChange?.({ wastageSearch: e.target.value, wastagePage: 1 });
  });

  view.querySelectorAll('[data-wastage-category]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentFilterChange?.({ wastageCategory: button.dataset.wastageCategory, wastagePage: 1 });
    });
  });

  view.querySelectorAll('[data-wastage-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onAdjustmentAction.onToggleWastageSelection?.(checkbox.dataset.wastageSelect, checkbox.checked);
    });
  });

  view.querySelector('[data-wastage-add-selected]')?.addEventListener('click', () => {
    onAdjustmentAction.onAddWastageSelected?.();
  });

  view.querySelectorAll('[data-wastage-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentAction.onRemoveWastageLine?.(Number(button.dataset.wastageRemove));
    });
  });

  view.querySelectorAll('[data-wastage-qty]').forEach((input) => {
    input.addEventListener('input', () => {
      onAdjustmentAction.onPreserveFocus?.(input);
      onAdjustmentAction.onWastageQtyChange?.(Number(input.dataset.wastageQty), input.value);
    });
  });

  view.querySelector('[data-wastage-note]')?.addEventListener('input', (e) => {
    onAdjustmentAction.onPreserveFocus?.(e.currentTarget);
    onAdjustmentAction.onWastageDraftChange?.({ note: e.currentTarget.value });
  });

  view.querySelectorAll('[data-wastage-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.dataset.wastageOptionField;
      const value = button.dataset.wastageOptionValue;
      onAdjustmentAction.onWastageDraftChange?.({ [field]: value });
      onAdjustmentFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelector('[data-wastage-save]')?.addEventListener('click', () => onAdjustmentAction.onWastageSave?.());

  view.querySelectorAll('[data-wastage-page]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentFilterChange?.({ wastagePage: Number(button.dataset.wastagePageValue || 1) || 1 });
    });
  });

  // Sale Adjustment tab events (mirrors the wastage tab above)
  view.querySelectorAll('[data-sale-open-picker]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentFilterChange?.({ overlay: 'sale-picker', openDropdown: '', saleSelectedIds: [] });
    });
  });

  view.querySelector('[data-sale-picker-close]')?.addEventListener('click', () => {
    onAdjustmentFilterChange?.({ overlay: '', saleSelectedIds: [] });
  });

  view.querySelector('[data-sale-search]')?.addEventListener('input', (e) => {
    onAdjustmentFilterChange?.({ saleSearch: e.target.value, salePage: 1 });
  });

  view.querySelectorAll('[data-sale-category]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentFilterChange?.({ saleCategory: button.dataset.saleCategory, salePage: 1 });
    });
  });

  view.querySelectorAll('[data-sale-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onAdjustmentAction.onToggleSaleAdjustmentSelection?.(checkbox.dataset.saleSelect, checkbox.checked);
    });
  });

  view.querySelector('[data-sale-add-selected]')?.addEventListener('click', () => {
    onAdjustmentAction.onAddSaleAdjustmentSelected?.();
  });

  view.querySelectorAll('[data-sale-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentAction.onRemoveSaleAdjustmentLine?.(Number(button.dataset.saleRemove));
    });
  });

  view.querySelectorAll('[data-sale-qty]').forEach((input) => {
    input.addEventListener('input', () => {
      onAdjustmentAction.onPreserveFocus?.(input);
      onAdjustmentAction.onSaleAdjustmentQtyChange?.(Number(input.dataset.saleQty), input.value);
    });
  });

  view.querySelector('[data-sale-note]')?.addEventListener('input', (e) => {
    onAdjustmentAction.onPreserveFocus?.(e.currentTarget);
    onAdjustmentAction.onSaleAdjustmentDraftChange?.({ note: e.currentTarget.value });
  });

  view.querySelectorAll('[data-sale-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.dataset.saleOptionField;
      const value = button.dataset.saleOptionValue;
      onAdjustmentAction.onSaleAdjustmentDraftChange?.({ [field]: value });
      onAdjustmentFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelector('[data-sale-save]')?.addEventListener('click', () => onAdjustmentAction.onSaleAdjustmentSave?.());

  view.querySelectorAll('[data-sale-page]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentFilterChange?.({ salePage: Number(button.dataset.salePageValue || 1) || 1 });
    });
  });

  view.querySelectorAll('[data-adj-open-stock]').forEach((button) => {
    button.addEventListener('click', () => {
      onAdjustmentFilterChange?.({
        adjustmentWorkflow: 'bulk',
        overlay: 'stock',
        selectedStockIds: [],
        openDropdown: ''
      });
    });
  });

  view.querySelector('[data-adj-stock-close]')?.addEventListener('click', () => {
    onAdjustmentFilterChange?.({ overlay: '', selectedStockIds: [] });
  });

  view.querySelector('[data-adj-stock-search]')?.addEventListener('input', (event) => {
    onAdjustmentFilterChange?.({ stockSearch: event.target.value, stockPage: 1 });
  });

  view.querySelector('[data-adj-scan-barcode]')?.addEventListener('click', () => {
    onAdjustmentAction.onScanBarcode?.();
  });

  view.querySelectorAll('[data-adj-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.adjDropdown;
      const current = view.dataset.openDropdown || '';
      onAdjustmentFilterChange?.({ openDropdown: current === id ? '' : id });
    });
  });

  view.addEventListener('click', (event) => {
    if (!view.dataset.openDropdown || event.target.closest('[data-adj-dropdown-root]')) return;
    onAdjustmentFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-adj-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.adjOptionAction || '';
      const value = button.dataset.adjOptionValue || '';
      if (action.startsWith('detail:')) {
        const field = action.split(':')[1];
        onAdjustmentAction.onLineDetailMetaChange?.({ [field]: value });
      } else if (action === 'stockCategory') {
        onAdjustmentFilterChange?.({ stockCategory: value, stockPage: 1 });
      } else if (action === 'wastageCategory') {
        onAdjustmentFilterChange?.({ wastageCategory: value, wastagePage: 1 });
      } else if (action === 'saleCategory') {
        onAdjustmentFilterChange?.({ saleCategory: value, salePage: 1 });
      }
      onAdjustmentFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-adj-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.adjPage;
      const value = Number(button.dataset.adjPageValue || 1) || 1;
      onAdjustmentFilterChange?.({ [key]: value });
    });
  });

  view.querySelectorAll('[data-adj-stock-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onAdjustmentAction.onToggleStockSelection?.(checkbox.dataset.adjStockSelect, checkbox.checked);
    });
  });

  view.querySelectorAll('[data-adj-stock-row]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('input, button, a, select, label')) return;
      const checkbox = row.querySelector('[data-adj-stock-select]');
      if (!checkbox || checkbox.disabled) return;
      onAdjustmentAction.onToggleStockSelection?.(row.dataset.adjStockRow, !checkbox.checked);
    });
  });

  view.querySelector('[data-adj-stock-select-all]')?.addEventListener('click', () => {
    onAdjustmentAction.onSelectAllVisibleStock?.();
  });

  view.querySelector('[data-adj-stock-add]')?.addEventListener('click', () => onAdjustmentAction.onAddSelectedStock?.());
  view.querySelector('[data-adj-edit-line]')?.addEventListener('click', () => { });
  view.querySelectorAll('[data-adj-edit-line]').forEach((button) => {
    button.addEventListener('click', () => onAdjustmentAction.onEditLine?.(Number(button.dataset.adjEditLine)));
  });
  view.querySelectorAll('[data-adj-remove-line]').forEach((button) => {
    button.addEventListener('click', () => onAdjustmentAction.onRemoveLine?.(Number(button.dataset.adjRemoveLine)));
  });

  view.querySelectorAll('[data-adj-line-detail-field]').forEach((field) => {
    field.addEventListener('input', () => {
      onAdjustmentAction.onPreserveFocus?.(field);
      onAdjustmentAction.onLineDetailChange?.(Number(field.dataset.adjLineDetailIndex), { quantity: field.value });

      // Update the "After" value directly in the DOM — no renderApp() needed while typing
      const idx = field.dataset.adjLineDetailIndex;
      const metaEl = view.querySelector(`[data-adj-stock-meta="${idx}"]`);
      if (metaEl) {
        const currentStock = parseFloat(field.dataset.adjCurrentStock ?? '0') || 0;
        const mode = field.dataset.adjMode || 'remove';
        const qty = parseFloat(String(field.value).replace(',', '.')) || 0;
        const projected = mode === 'override' ? qty : mode === 'add' ? currentStock + qty : currentStock - qty;
        const afterEl = metaEl.querySelectorAll('.adj-stockPreviewMetric')[1];
        if (afterEl) {
          afterEl.className = `adj-stockPreviewMetric${projected < 0 ? ' is-negative' : projected > currentStock ? ' is-positive' : ''}`;
          const strong = afterEl.querySelector('strong');
          if (strong) strong.textContent = Number.isFinite(projected) ? projected.toLocaleString('en-ZA', { maximumFractionDigits: 3 }) : '0';
        }
      }
    });
  });

  view.querySelector('[data-adj-line-detail-note]')?.addEventListener('input', (event) => {
    onAdjustmentAction.onPreserveFocus?.(event.currentTarget);
    onAdjustmentAction.onLineDetailMetaChange?.({ note: event.currentTarget.value });
  });

  view.querySelector('[data-adj-line-detail-close]')?.addEventListener('click', () => onAdjustmentAction.onCloseLineDetail?.());
  view.querySelector('[data-adj-line-detail-back]')?.addEventListener('click', () => onAdjustmentAction.onBackLineDetail?.());
  view.querySelector('[data-adj-line-detail-apply]')?.addEventListener('click', () => onAdjustmentAction.onApplyLineDetail?.());
  view.querySelector('[data-adj-save]')?.addEventListener('click', () => onAdjustmentAction.onSave?.());
  view.querySelector('[data-adj-toast-close]')?.addEventListener('click', () => onAdjustmentAction.onDismissToast?.());
}

function renderDraftTable(draft) {
  return `
    <table class="adj-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Quantity</th>
          <th>Unit</th>
          <th>Impact</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${(draft.items || []).map((item, index) => `
          <tr>
            <td>
              <strong>${escapeHtml(item.stockItemName || '')}</strong>
              <span>${escapeHtml(item.locationName || draft.locationName || 'Main Store')}</span>
            </td>
            <td>${formatNumber(item.quantity || 0)}</td>
            <td>${escapeHtml(item.unit || '')}</td>
            <td>${formatCurrency(item.estimatedImpactEx || 0)}</td>
            <td>
              <div class="adj-rowActions">
                <button type="button" data-adj-edit-line="${index}">Edit</button>
                <button type="button" data-adj-remove-line="${index}">Remove</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderStockOverlay(stockItems, filters, selectedStockIds, allStockItems = stockItems) {
  const pagination = paginateItems(stockItems, filters.stockPage, ADJUSTMENT_PAGE_SIZE);
  // Bulk is the only flow now — always multi-select.
  const isBulk = true;
  const categoryOptions = [
    { value: '', label: 'All categories' },
    ...getCategoryOptions(allStockItems).map((category) => ({ value: category, label: category }))
  ];

  return `
    <div class="adj-overlayBackdrop">
      <section class="adj-overlayCard adj-overlayCard--picker">
        <header>
          <div>
            <p>Bulk Adjustment</p>
            <h3>Choose stock items</h3>
          </div>
          <button type="button" class="adj-iconButton" data-adj-stock-close aria-label="Close stock picker">${icon('x')}</button>
        </header>
        <div class="adj-overlayFilters">
          <label class="adj-overlaySearchLabel">
            ${renderFieldHelpLabel('Search', 'Search stock items you want to add into this manual adjustment.')}
            <div class="adj-searchShell">
              <input type="search" value="${escapeAttribute(filters.stockSearch || '')}" placeholder="Type name or scan barcode..." data-adj-stock-search data-focus-key="adj-stock-search" />
              <button type="button" data-adj-scan-barcode aria-label="Scan barcode" title="Scan barcode">${icon('camera')}</button>
            </div>
          </label>
          <label>
            ${renderFieldHelpLabel('Category', 'Filter the adjustment picker by category to find items faster.')}
            ${renderOverlayDropdown({
    id: 'stock-category',
    action: 'stockCategory',
    selectedValue: filters.stockCategory || '',
    fallbackLabel: 'All categories',
    options: categoryOptions,
    openDropdown: filters.openDropdown
  })}
          </label>
        </div>
        <div class="adj-pickerTable" data-scroll-key="adjustments-stock-picker">
          <table class="adj-table adj-table--picker">
            <thead>
              <tr>
                <th></th>
                <th>Stock Item</th>
                <th>Category</th>
                <th>Unit</th>
              </tr>
            </thead>
            <tbody>
              ${pagination.items.map((item) => {
    const isSelected = selectedStockIds.has(String(item.id));
    const isLockedOut = !isBulk && selectedStockIds.size > 0 && !isSelected;
    return `
                <tr class="${item.alreadyAdded ? 'is-added' : ''}" data-adj-stock-row="${escapeAttribute(item.id)}">
                  <td><input type="checkbox" data-adj-stock-select="${escapeAttribute(item.id)}" ${isSelected ? 'checked' : ''} ${isLockedOut ? 'disabled' : ''} /></td>
                  <td><strong>${escapeHtml(item.name || '')}</strong>${item.alreadyAdded ? '<span>Already added</span>' : ''}</td>
                  <td>${escapeHtml(item.category || '')}</td>
                  <td>${escapeHtml(String(item.unit || '').toUpperCase())}</td>
                </tr>
              `;
  }).join('') || '<tr><td colspan="4"><div class="adj-empty"><span>No stock items match.</span></div></td></tr>'}
            </tbody>
          </table>
        </div>
        ${renderPagination('stockPage', pagination)}
        <div class="adj-overlayActions">
          <div class="adj-overlaySelectionCount">${selectedStockIds.size} selected</div>
          <div class="adj-overlayActionRail">
            <button type="button" class="adj-secondary" data-adj-stock-select-all ${isBulk && stockItems.length ? '' : 'disabled'}>Select All Shown</button>
            <button type="button" class="adj-primary" data-adj-stock-add ${selectedStockIds.size ? '' : 'disabled'}>Confirm Selection</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderLineDetailOverlay(detailDraft, sites, locations, filters = {}, stockMap = new Map(), errorMessage = '') {
  const modeOptions = [
    { value: 'remove', label: 'Wastage / Remove' },
    { value: 'add', label: 'Add / Found Stock' },
    { value: 'override', label: 'Override Balance' }
  ];
  const modeSelected = detailDraft.mode || 'remove';
  const siteOptions = (sites || []).map((site) => ({ value: site.id, label: site.name || site.code || site.id }));
  const siteId = detailDraft.siteId || getSiteIdForLocation(locations || [], detailDraft.locationId) || siteOptions[0]?.value || '';
  const locationOptions = (locations || [])
    .filter((location) => !siteId || String(location.siteId || '') === String(siteId))
    .map((location) => ({ value: location.id, label: location.displayName || location.name }));
  const wasteOptions = WASTE_REASONS.map((reason) => ({ value: reason, label: reason }));
  const directionHint = modeSelected === 'add' ? '+' : modeSelected === 'remove' ? '-' : '=';
  const basePagination = paginateItems(detailDraft.entries || [], filters.detailPage, ADJUSTMENT_PAGE_SIZE);
  const pagination = {
    ...basePagination,
    items: basePagination.items.map((entry, offsetIndex) => ({
      ...entry,
      originalIndex: basePagination.start + offsetIndex
    }))
  };

  return `
    <div class="adj-overlayBackdrop">
      <section class="adj-overlayCard adj-overlayCard--detail" data-scroll-key="adjustments-detail-card">
        <header>
          <div>
            <p>${modeSelected === 'override' ? 'Set Target Quantities' : 'Set Quantities'}</p>
            <h3>${detailDraft.entries.length} item(s)</h3>
          </div>
          <button type="button" class="adj-iconButton" data-adj-line-detail-close aria-label="Close detail editor">${icon('x')}</button>
        </header>

        ${errorMessage ? renderNotice(errorMessage, 'error') : ''}

        <div class="adj-detailMetaRow">
          ${siteOptions.length > 1 ? `
            <label>
              ${renderFieldHelpLabel('Location Group', 'Choose the trading location group for this stock correction.')}
              ${renderOverlayDropdown({
    id: 'detail-siteId',
    action: 'detail:siteId',
    selectedValue: siteId,
    fallbackLabel: 'Select location group',
    options: siteOptions,
    openDropdown: filters.openDropdown
  })}
            </label>
          ` : ''}

          <label>
            ${renderFieldHelpLabel('Location', 'Choose which selling location is being corrected.')}
            ${renderOverlayDropdown({
    id: 'detail-locationId',
    action: 'detail:locationId',
    selectedValue: detailDraft.locationId || 'main',
    fallbackLabel: 'Select location',
    options: locationOptions,
    openDropdown: filters.openDropdown
  })}
          </label>

          <label>
            ${renderFieldHelpLabel('Correction Type', 'Choose whether stock is being removed, added, or overridden to a target balance.')}
            ${renderOverlayDropdown({
    id: 'detail-mode',
    action: 'detail:mode',
    selectedValue: modeSelected,
    fallbackLabel: 'Select Correction Type...',
    options: modeOptions,
    openDropdown: filters.openDropdown
  })}
          </label>

          <label>
            ${renderFieldHelpLabel('Reference Note', 'Short explanation or reference that tells the team why this adjustment happened.')}
            <input
              type="text"
              value="${escapeAttribute(detailDraft.note || '')}"
              placeholder="Reason..."
              data-adj-line-detail-note
              data-focus-key="adj-line-detail-note"
            />
          </label>
        </div>

        ${modeSelected === 'remove' ? `
          <div class="adj-detailWasteRow">
            <label>
              ${renderFieldHelpLabel('Waste Reason', 'Classify wastage so dashboards can separate true waste from other stock corrections.')}
              ${renderOverlayDropdown({
    id: 'detail-wasteReason',
    action: 'detail:wasteReason',
    selectedValue: detailDraft.wasteReason || 'Other',
    fallbackLabel: 'Select waste reason',
    options: wasteOptions,
    openDropdown: filters.openDropdown
  })}
            </label>
          </div>
        ` : ''}

        <div class="adj-detailTable" data-scroll-key="adjustments-detail-rows">
          <table class="adj-table adj-table--detail">
            <thead>
              <tr>
                <th>Stock Item</th>
                <th>Current / After</th>
                <th>Quantity</th>
              </tr>
            </thead>
            <tbody>
              ${pagination.items.map((entry) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(entry.stockItemName || '')}</strong>
                    <span>${escapeHtml(entry.unit || '')}</span>
                  </td>
                  <td>
                    <div class="adj-detailStockMeta" data-adj-stock-meta="${entry.originalIndex}">
                      ${renderStockPreview(entry, detailDraft, stockMap, locations)}
                    </div>
                  </td>
                  <td>
                    <div class="adj-detailInputShell">
                      <span class="adj-detailHint">${escapeHtml(directionHint)}</span>
                      <input type="text" inputmode="decimal" value="${escapeAttribute(String(entry.quantity ?? ''))}" data-adj-line-detail-index="${entry.originalIndex}" data-adj-line-detail-field="quantity" data-focus-key="adj-detail-${entry.originalIndex}" data-adj-current-stock="${escapeAttribute(String(getLocationStock(stockMap.get(String(entry.stockItemId || '')), entry.locationId || detailDraft.locationId || 'main', locations)))}" data-adj-mode="${escapeAttribute(detailDraft.mode || 'remove')}" />
                      <span class="adj-detailTag">${escapeHtml(entry.unit || 'ea')}</span>
                    </div>
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="3"><div class="adj-empty"><span>No adjustment lines.</span></div></td></tr>'}
            </tbody>
          </table>
        </div>
        ${renderPagination('detailPage', pagination)}

        <div class="adj-overlayActions">
          <button type="button" class="adj-primary" data-adj-line-detail-apply>Confirm & add</button>
          <button type="button" class="adj-secondary" data-adj-line-detail-back>Back</button>
        </div>
      </section>
    </div>
  `;
}

function paginateItems(items = [], page = 1, pageSize = ADJUSTMENT_PAGE_SIZE) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(Number(page || 1) || 1, 1), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  return {
    items: pageItems,
    page: currentPage,
    pageSize,
    totalItems,
    totalPages,
    start,
    end: Math.min(start + pageItems.length, totalItems),
    mapItems(mapper) {
      return {
        ...this,
        items: this.items.map(mapper)
      };
    }
  };
}

function renderPagination(key, pagination) {
  if (!pagination || pagination.totalItems <= pagination.pageSize) return '';
  return `
    <div class="adj-pagination">
      <span>${pagination.start + 1}-${pagination.end} of ${pagination.totalItems}</span>
      <div>
        <button type="button" data-adj-page="${escapeAttribute(key)}" data-adj-page-value="${pagination.page - 1}" ${pagination.page <= 1 ? 'disabled' : ''}>Previous</button>
        <strong>Page ${pagination.page} of ${pagination.totalPages}</strong>
        <button type="button" data-adj-page="${escapeAttribute(key)}" data-adj-page-value="${pagination.page + 1}" ${pagination.page >= pagination.totalPages ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  `;
}

function renderOverlayDropdown({ id, action, selectedValue, fallbackLabel, options, openDropdown, fieldPrefix, fieldName }) {
  const selected = options.find((option) => String(option.value) === String(selectedValue));
  const isOpen = openDropdown === id;
  const isWastageDropdown = fieldPrefix === 'wastage' && fieldName;
  const isSaleDropdown = fieldPrefix === 'sale' && fieldName;
  return `
    <div class="adj-dropdown ${isOpen ? 'adj-dropdown--open' : ''}" data-adj-dropdown-root>
      <button type="button" data-adj-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(selected?.label || fallbackLabel)}</strong>
        ${icon('chevronDown')}
      </button>
      <div class="adj-dropdownMenu">
        ${options.map((option) => `
          <button
            type="button"
            ${isWastageDropdown
      ? `data-wastage-option data-wastage-option-field="${escapeAttribute(fieldName)}" data-wastage-option-value="${escapeAttribute(option.value)}"`
      : isSaleDropdown
      ? `data-sale-option data-sale-option-field="${escapeAttribute(fieldName)}" data-sale-option-value="${escapeAttribute(option.value)}"`
      : `data-adj-option data-adj-option-action="${escapeAttribute(action)}" data-adj-option-value="${escapeAttribute(option.value)}"`
    }
            class="${String(option.value) === String(selectedValue) ? 'is-active' : ''}"
          >
            ${escapeHtml(option.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderNotice(message, tone) {
  return `<div class="adj-notice adj-notice--${tone}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="adj-toast adj-toast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-adj-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function getStockMatches(stockItems = [], query = '', category = '', currentLines = []) {
  const q = String(query || '').trim().toLowerCase();
  const currentKeys = new Set((currentLines || []).map((line) => String(line.stockItemId || '')));
  return stockItems
    .filter(isPhysicalStockItem)
    .filter((item) => {
      if (category && String(item.category || '') !== category) return false;
      if (!q) return true;
      return (
        String(item.name || '').toLowerCase().includes(q) ||
        String(item.category || '').toLowerCase().includes(q) ||
        stockItemHasBarcode(item, q)
      );
    })
    .map((item) => ({ ...item, alreadyAdded: currentKeys.has(String(item.id)) }));
}

function getCategoryOptions(stockItems = []) {
  return [...new Set(stockItems.filter(isPhysicalStockItem).map((item) => String(item.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function stockItemHasBarcode(item = {}, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return false;
  const directBarcodes = [item.barcode, ...(Array.isArray(item.barcodes) ? item.barcodes : [])];
  if (directBarcodes.some((barcode) => String(barcode || '').toLowerCase().includes(needle))) return true;
  return normalizeUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions)
    .some((config) => config.barcode && config.barcode.toLowerCase().includes(needle));
}

function normalizeUomConfigurations(value = []) {
  const rows = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  return rows
    .map((entry = {}) => ({
      barcode: String(entry.barcode || entry.customBarcode || entry.customUomBarcode || '').trim(),
      isDefaultOrdering: ['true', '1', 'yes', 'on'].includes(String(entry.isDefaultOrdering ?? entry.defaultOrdering ?? entry.is_default_ordering ?? entry.defaultOrderUom ?? '').toLowerCase()) || entry.isDefaultOrdering === true || entry.defaultOrdering === true
    }))
    .filter((entry) => entry.barcode);
}

function isPhysicalStockItem(item = {}) {
  // Adjustments can use Standard, Non Stock and Manufactured items, but not Sub-Recipe items.
  if (item.isSubRecipe === true) return false;
  const type = String(item.itemType || item.stockItemType || item.specificationType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['sub_recipe', 'subrecipe'].includes(type)) return false;
  const category = String(item.category || '').toLowerCase();
  return !category.includes('sub recipe') &&
    !category.includes('sub-recipe');
}

function renderStockPreview(entry, detailDraft, stockMap, locations = []) {
  const stockItem = stockMap.get(String(entry.stockItemId || ''));
  const currentStock = getLocationStock(stockItem, entry.locationId || detailDraft.locationId || 'main', locations);
  const quantity = parseQuantity(entry.quantity);
  const mode = detailDraft.mode || 'remove';
  const projected = mode === 'override'
    ? quantity
    : mode === 'add'
      ? currentStock + quantity
      : currentStock - quantity;
  return `
    <span class="adj-stockPreviewMetric">
      <em>Current</em>
      <strong>${formatNumber(currentStock)}</strong>
    </span>
    <span class="adj-stockPreviewMetric ${projected < 0 ? 'is-negative' : projected > currentStock ? 'is-positive' : ''}">
      <em>After</em>
      <strong>${formatNumber(projected)}</strong>
    </span>
  `;
}

function parseQuantity(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLocationStock(item, locationId, locations = []) {
  if (!item) return 0;
  const key = String(locationId || '').trim();
  const balances = item && typeof item.balances === 'object' && item.balances ? item.balances : {};
  if (!key) return Number(item.stock || 0) || 0;

  const balanceKeys = Object.keys(balances);
  if (!balanceKeys.length) return Number(item.stock || 0) || 0;

  const location = (locations || []).find((entry) => (
    String(entry.id || '') === key ||
    String(entry.name || '') === key
  ));
  const candidates = [
    key,
    location?.id,
    location?.name
  ].map((value) => String(value || '').trim()).filter(Boolean);

  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(balances, candidate)) {
      return Number(balances[candidate] || 0) || 0;
    }
  }

  const normalizedCandidates = new Set(candidates.map(normalizeLocationKey).filter(Boolean));
  const match = balanceKeys.find((balanceKey) => normalizedCandidates.has(normalizeLocationKey(balanceKey)));
  if (match) return Number(balances[match] || 0) || 0;

  return 0;
}

function normalizeLocationKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function getSiteIdForLocation(locations = [], locationId = '') {
  return String((locations || []).find((location) => String(location.id) === String(locationId))?.siteId || '');
}

function renderWastageTab(adjustments, filters, onAdjustmentFilterChange, onAdjustmentAction) {
  const draft = adjustments.wastageDraft || createEmptyWastageDraft();
  const products = adjustments.products || [];
  const locations = adjustments.locations || [];
  const hasDraftLines = (draft.items || []).length > 0;
  const isSaving = adjustments.wastageStatus === 'saving';

  const locationOptions = locations.map((loc) => ({ value: loc.id, label: loc.displayName || loc.name }));
  const wasteOptions = WASTE_REASONS.map((r) => ({ value: r, label: r }));
  const totalCostImpact = (draft.items || []).reduce((sum, item) => sum + Number(item.estimatedCost || 0), 0);
  const wastageValidationMessage = getWastageValidationMessage(draft);
  const canRecordWastage = !wastageValidationMessage && !isSaving;

  if (filters.overlay === 'wastage-picker') {
    return renderWastagePickerOverlay(products, filters);
  }

  return `
    ${adjustments.wastageError ? renderNotice(adjustments.wastageError, 'error') : ''}
    <div class="adj-frame">
      <div class="adj-engineShell">
        ${!hasDraftLines ? `
          <section class="adj-card adj-engineIntro">
            <div class="adj-engineIcon">${icon('flame')}</div>
            <div class="adj-engineHead">
              <h3 class="adj-title">Product Wastage Adjustment</h3>
            </div>
            <p class="adj-engineLead">Select menu items that were wasted. KCP will automatically deduct all recipe ingredients from the selected location's stock and record the wastage.</p>
            <div class="adj-engineActions">
              <button type="button" class="adj-primary adj-enginePrimary" data-wastage-open-picker>Choose Menu Items</button>
            </div>
          </section>
        ` : `
          <section class="adj-card adj-draftPanel">
            <div class="adj-panelHead">
              <div>
                <h3>Wastage Draft</h3>
                <span>${(draft.items || []).length} ${(draft.items || []).length === 1 ? 'menu item' : 'menu items'}</span>
              </div>
              <button type="button" class="adj-secondary adj-addItemsButton" data-wastage-open-picker>Add Items</button>
            </div>

            <div class="adj-draftScroll">
              <table class="adj-table">
                <thead>
                  <tr><th>Menu Item</th><th>Qty Wasted</th><th>Est. Cost</th><th></th></tr>
                </thead>
                <tbody>
                  ${(draft.items || []).map((item, index) => `
                    <tr>
                      <td>
                        <strong>${escapeHtml(item.productName || '')}</strong>
                        <span>${escapeHtml(item.category || '')}</span>
                      </td>
                      <td>
                        <input
                          type="text"
                          inputmode="decimal"
                          class="adj-inlineQty"
                          value="${escapeAttribute(String(item.quantity ?? ''))}"
                          data-wastage-qty="${index}"
                          data-focus-key="wastage-qty-${index}"
                          placeholder="0"
                        />
                      </td>
                      <td data-wastage-cost="${index}">${Number(item.unitCost || 0) > 0 ? formatCurrency(item.estimatedCost || 0) : 'Cost unavailable'}</td>
                      <td>
                        <button type="button" class="adj-removeBtn" data-wastage-remove="${index}" aria-label="Remove">${icon('x')}</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="adj-wastageMetaRow">
              <label>
                <span>Location</span>
                ${renderOverlayDropdown({
    id: 'wastage-location',
    action: '',
    selectedValue: draft.locationId || '',
    fallbackLabel: 'Select location…',
    options: locationOptions,
    openDropdown: filters.openDropdown,
    fieldPrefix: 'wastage',
    fieldName: 'locationId'
  })}
              </label>
              <label>
                <span>Waste Reason</span>
                ${renderOverlayDropdown({
    id: 'wastage-reason',
    action: '',
    selectedValue: draft.wasteReason || '',
    fallbackLabel: 'Select reason…',
    options: wasteOptions,
    openDropdown: filters.openDropdown,
    fieldPrefix: 'wastage',
    fieldName: 'wasteReason'
  })}
              </label>
              <label>
                <span>Note (optional)</span>
                <input
                  type="text"
                  value="${escapeAttribute(draft.note || '')}"
                  placeholder="What happened…"
                  data-wastage-note
                  data-focus-key="wastage-note"
                />
              </label>
            </div>

            <div class="adj-footer">
              <div class="adj-impact">
                <span>Est. Stock Cost</span>
                <strong data-wastage-total>${formatCurrency(totalCostImpact)}</strong>
              </div>
              <button type="button" class="adj-primary ${canRecordWastage ? '' : 'adj-primary--blocked'}" data-wastage-save aria-disabled="${canRecordWastage ? 'false' : 'true'}" data-wastage-validation="${escapeAttribute(wastageValidationMessage)}" ${isSaving ? 'disabled' : ''}>${isSaving ? 'Saving…' : 'Record Wastage'}</button>
            </div>
          </section>
        `}
      </div>
    </div>
    ${renderWastageLog(adjustments)}
  `;
}

function getWastageValidationMessage(draft = {}) {
  const items = Array.isArray(draft.items) ? draft.items : [];
  if (!items.length) return 'Select at least one menu item to waste.';
  if (!String(draft.locationId || '').trim()) return 'Select a location before recording wastage.';
  if (!String(draft.wasteReason || '').trim()) return 'Select a waste reason before recording wastage.';
  const invalidItem = items.find((item) => !(Number(String(item.quantity ?? '').replace(',', '.')) > 0));
  if (invalidItem) return `Enter a quantity greater than zero for ${invalidItem.productName || 'every menu item'}.`;
  return '';
}

function renderWastageLog(adjustments) {
  const allAdj = adjustments.adjustments || [];
  const wastageLines = allAdj.filter((log) => isWastageAdjustment(log));
  if (!wastageLines.length) return '';

  // Group by adjustmentId so one record = one wastage event
  const byId = new Map();
  for (const line of wastageLines) {
    const key = line.adjustmentId || line.id;
    if (!byId.has(key)) {
      byId.set(key, {
        date: line.date || line.timestamp || '',
        wasteReason: line.wasteReason || line.note || 'Other',
        locationName: line.locationName || '',
        user: line.user || line.createdByName || '',
        lines: []
      });
    }
    byId.get(key).lines.push(line);
  }

  const events = [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 50);

  return `
    <div class="adj-wastageLog">
      <h3 class="adj-wastageLogTitle">Wastage History</h3>
      <table class="adj-table adj-table--log">
        <thead>
          <tr>
            <th>Date</th>
            <th>Reason</th>
            <th>Location</th>
            <th>Ingredients Deducted</th>
            <th>User</th>
          </tr>
        </thead>
        <tbody>
          ${events.map((ev) => `
            <tr>
              <td>${escapeHtml(ev.date ? ev.date.slice(0, 10) : '')}</td>
              <td>${escapeHtml(ev.wasteReason)}</td>
              <td>${escapeHtml(ev.locationName || 'Main Store')}</td>
              <td>
                ${ev.lines.map((l) => `<span class="adj-wastageIngredient">${escapeHtml(l.stockItemName || l.itemName || '')} (${formatQty(Math.abs(l.qty || l.impactQty || 0))} ${escapeHtml(l.unit || '')})</span>`).join('')}
              </td>
              <td>${escapeHtml(ev.user)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function formatQty(n) {
  const num = Number(n) || 0;
  return num % 1 === 0 ? String(num) : num.toFixed(3).replace(/\.?0+$/, '');
}

function renderWastagePickerOverlay(products, filters) {
  const q = String(filters.wastageSearch || '').trim().toLowerCase();
  const cat = String(filters.wastageCategory || '').trim();
  const selectedIds = new Set((filters.wastageSelectedIds || []).map(String));
  const categoryOptions = [...new Set(products.map((p) => String(p.category || '').trim()).filter(Boolean))].sort();

  const matches = products.filter((p) => {
    if (cat && p.category !== cat) return false;
    if (!q) return true;
    return String(p.name || '').toLowerCase().includes(q) || String(p.category || '').toLowerCase().includes(q);
  });

  const paginated = paginateItems(matches, filters.wastagePage, ADJUSTMENT_PAGE_SIZE);

  return `
    <div class="adj-overlayBackdrop">
      <section class="adj-overlayCard adj-overlayCard--picker">
        <header>
          <div>
            <p>Product Wastage Adjustment</p>
            <h3>Choose menu items to waste</h3>
          </div>
          <button type="button" class="adj-iconButton" data-wastage-picker-close aria-label="Close">${icon('x')}</button>
        </header>
        <div class="adj-overlayFilters">
          <label class="adj-overlaySearchLabel">
            <span>Search</span>
            <input type="search" value="${escapeAttribute(filters.wastageSearch || '')}" placeholder="Type name…" data-wastage-search data-focus-key="wastage-search" />
          </label>
          <label>
            <span>Category</span>
            ${renderOverlayDropdown({
    id: 'wastage-category',
    action: 'wastageCategory',
    selectedValue: cat,
    fallbackLabel: 'All categories',
    options: [{ value: '', label: 'All categories' }, ...categoryOptions.map((c) => ({ value: c, label: c }))],
    openDropdown: filters.openDropdown
  })}
          </label>
        </div>
        <div class="adj-pickerTable" data-scroll-key="wastage-picker">
          <table class="adj-table adj-table--picker">
            <thead>
              <tr><th></th><th>Menu Item</th><th>Category</th></tr>
            </thead>
            <tbody>
              ${paginated.items.map((p) => {
    const isSelected = selectedIds.has(String(p.id));
    return `
                <tr>
                  <td><input type="checkbox" data-wastage-select="${escapeAttribute(p.id)}" ${isSelected ? 'checked' : ''} /></td>
                  <td><strong>${escapeHtml(p.name || '')}</strong></td>
                  <td>${escapeHtml(p.category || '')}</td>
                </tr>`;
  }).join('') || '<tr><td colspan="3"><div class="adj-empty"><span>No menu items found.</span></div></td></tr>'}
            </tbody>
          </table>
        </div>
        ${renderPagination('wastagePage', paginated)}
        <div class="adj-overlayActions">
          <div class="adj-overlaySelectionCount">${selectedIds.size} selected</div>
          <div class="adj-overlayActionRail">
            <button type="button" class="adj-primary" data-wastage-add-selected ${selectedIds.size ? '' : 'disabled'}>Add to Draft</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function createEmptyWastageDraft() {
  return {
    locationId: 'main',
    locationName: 'Main Store',
    wasteReason: '',
    note: '',
    date: '',
    items: []
  };
}

// Product Sales Adjustment: a manual way to deduct stock for a sale the POS never captured (till
// offline, a comp/staff meal never rung up, etc). Mirrors the Product Wastage tab above exactly —
// same product picker, same recipe-expansion mechanic — but is stored/labelled distinctly on the
// backend (see postSalesAdjustment in routes.ts) so it never counts as wastage or as a real sale.
function renderSaleAdjustmentTab(adjustments, filters, onAdjustmentFilterChange, onAdjustmentAction) {
  const draft = adjustments.saleAdjustmentDraft || createEmptySaleAdjustmentDraft();
  const products = adjustments.products || [];
  const locations = adjustments.locations || [];
  const hasDraftLines = (draft.items || []).length > 0;
  const isSaving = adjustments.saleAdjustmentStatus === 'saving';

  const locationOptions = locations.map((loc) => ({ value: loc.id, label: loc.displayName || loc.name }));
  const saleReasonOptions = SALE_ADJUSTMENT_REASONS.map((r) => ({ value: r, label: r }));
  const totalCostImpact = (draft.items || []).reduce((sum, item) => sum + Number(item.estimatedCost || 0), 0);
  const validationMessage = getSaleAdjustmentValidationMessage(draft);
  const canRecord = !validationMessage && !isSaving;

  if (filters.overlay === 'sale-picker') {
    return renderSaleAdjustmentPickerOverlay(products, filters);
  }

  return `
    ${adjustments.saleAdjustmentError ? renderNotice(adjustments.saleAdjustmentError, 'error') : ''}
    <div class="adj-frame">
      <div class="adj-engineShell">
        ${!hasDraftLines ? `
          <section class="adj-card adj-engineIntro">
            <div class="adj-engineIcon">${icon('list')}</div>
            <div class="adj-engineHead">
              <h3 class="adj-title">Product Sales Adjustment</h3>
            </div>
            <p class="adj-engineLead">Select menu items that were sold but never captured by Yoco (till offline, a comp or staff meal, a manual/phone order). KCP will automatically deduct all recipe ingredients from the selected location's stock and record it as a sale adjustment.</p>
            <div class="adj-engineActions">
              <button type="button" class="adj-primary adj-enginePrimary" data-sale-open-picker>Choose Menu Items</button>
            </div>
          </section>
        ` : `
          <section class="adj-card adj-draftPanel">
            <div class="adj-panelHead">
              <div>
                <h3>Sale Adjustment Draft</h3>
                <span>${(draft.items || []).length} ${(draft.items || []).length === 1 ? 'menu item' : 'menu items'}</span>
              </div>
              <button type="button" class="adj-secondary adj-addItemsButton" data-sale-open-picker>Add Items</button>
            </div>

            <div class="adj-draftScroll">
              <table class="adj-table">
                <thead>
                  <tr><th>Menu Item</th><th>Qty Sold</th><th>Est. Cost</th><th></th></tr>
                </thead>
                <tbody>
                  ${(draft.items || []).map((item, index) => `
                    <tr>
                      <td>
                        <strong>${escapeHtml(item.productName || '')}</strong>
                        <span>${escapeHtml(item.category || '')}</span>
                      </td>
                      <td>
                        <input
                          type="text"
                          inputmode="decimal"
                          class="adj-inlineQty"
                          value="${escapeAttribute(String(item.quantity ?? ''))}"
                          data-sale-qty="${index}"
                          data-focus-key="sale-qty-${index}"
                          placeholder="0"
                        />
                      </td>
                      <td data-sale-cost="${index}">${Number(item.unitCost || 0) > 0 ? formatCurrency(item.estimatedCost || 0) : 'Cost unavailable'}</td>
                      <td>
                        <button type="button" class="adj-removeBtn" data-sale-remove="${index}" aria-label="Remove">${icon('x')}</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="adj-wastageMetaRow">
              <label>
                <span>Location</span>
                ${renderOverlayDropdown({
    id: 'sale-location',
    action: '',
    selectedValue: draft.locationId || '',
    fallbackLabel: 'Select location…',
    options: locationOptions,
    openDropdown: filters.openDropdown,
    fieldPrefix: 'sale',
    fieldName: 'locationId'
  })}
              </label>
              <label>
                <span>Reason</span>
                ${renderOverlayDropdown({
    id: 'sale-reason',
    action: '',
    selectedValue: draft.saleReason || '',
    fallbackLabel: 'Select reason…',
    options: saleReasonOptions,
    openDropdown: filters.openDropdown,
    fieldPrefix: 'sale',
    fieldName: 'saleReason'
  })}
              </label>
              <label>
                <span>Note (optional)</span>
                <input
                  type="text"
                  value="${escapeAttribute(draft.note || '')}"
                  placeholder="What happened…"
                  data-sale-note
                  data-focus-key="sale-note"
                />
              </label>
            </div>

            <div class="adj-footer">
              <div class="adj-impact">
                <span>Est. Stock Cost</span>
                <strong data-sale-total>${formatCurrency(totalCostImpact)}</strong>
              </div>
              <button type="button" class="adj-primary ${canRecord ? '' : 'adj-primary--blocked'}" data-sale-save aria-disabled="${canRecord ? 'false' : 'true'}" data-sale-validation="${escapeAttribute(validationMessage)}" ${isSaving ? 'disabled' : ''}>${isSaving ? 'Saving…' : 'Record Sale Adjustment'}</button>
            </div>
          </section>
        `}
      </div>
    </div>
    ${renderSaleAdjustmentLog(adjustments)}
  `;
}

function getSaleAdjustmentValidationMessage(draft = {}) {
  const items = Array.isArray(draft.items) ? draft.items : [];
  if (!items.length) return 'Select at least one menu item that was sold.';
  if (!String(draft.locationId || '').trim()) return 'Select a location before recording this sale adjustment.';
  if (!String(draft.saleReason || '').trim()) return 'Select a reason before recording this sale adjustment.';
  const invalidItem = items.find((item) => !(Number(String(item.quantity ?? '').replace(',', '.')) > 0));
  if (invalidItem) return `Enter a quantity greater than zero for ${invalidItem.productName || 'every menu item'}.`;
  return '';
}

function renderSaleAdjustmentLog(adjustments) {
  const allAdj = adjustments.adjustments || [];
  const saleLines = allAdj.filter((log) => isSalesAdjustment(log));
  if (!saleLines.length) return '';

  // Group by adjustmentId so one record = one sale-adjustment event
  const byId = new Map();
  for (const line of saleLines) {
    const key = line.adjustmentId || line.id;
    if (!byId.has(key)) {
      byId.set(key, {
        date: line.date || line.timestamp || '',
        reason: line.note || 'Other',
        locationName: line.locationName || '',
        user: line.user || line.createdByName || '',
        lines: []
      });
    }
    byId.get(key).lines.push(line);
  }

  const events = [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 50);

  return `
    <div class="adj-wastageLog">
      <h3 class="adj-wastageLogTitle">Sale Adjustment History</h3>
      <table class="adj-table adj-table--log">
        <thead>
          <tr>
            <th>Date</th>
            <th>Reason</th>
            <th>Location</th>
            <th>Ingredients Deducted</th>
            <th>User</th>
          </tr>
        </thead>
        <tbody>
          ${events.map((ev) => `
            <tr>
              <td>${escapeHtml(ev.date ? ev.date.slice(0, 10) : '')}</td>
              <td>${escapeHtml(ev.reason)}</td>
              <td>${escapeHtml(ev.locationName || 'Main Store')}</td>
              <td>
                ${ev.lines.map((l) => `<span class="adj-wastageIngredient">${escapeHtml(l.stockItemName || l.itemName || '')} (${formatQty(Math.abs(l.qty || l.impactQty || 0))} ${escapeHtml(l.unit || '')})</span>`).join('')}
              </td>
              <td>${escapeHtml(ev.user)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSaleAdjustmentPickerOverlay(products, filters) {
  const q = String(filters.saleSearch || '').trim().toLowerCase();
  const cat = String(filters.saleCategory || '').trim();
  const selectedIds = new Set((filters.saleSelectedIds || []).map(String));
  const categoryOptions = [...new Set(products.map((p) => String(p.category || '').trim()).filter(Boolean))].sort();

  const matches = products.filter((p) => {
    if (cat && p.category !== cat) return false;
    if (!q) return true;
    return String(p.name || '').toLowerCase().includes(q) || String(p.category || '').toLowerCase().includes(q);
  });

  const paginated = paginateItems(matches, filters.salePage, ADJUSTMENT_PAGE_SIZE);

  return `
    <div class="adj-overlayBackdrop">
      <section class="adj-overlayCard adj-overlayCard--picker">
        <header>
          <div>
            <p>Product Sales Adjustment</p>
            <h3>Choose menu items that were sold</h3>
          </div>
          <button type="button" class="adj-iconButton" data-sale-picker-close aria-label="Close">${icon('x')}</button>
        </header>
        <div class="adj-overlayFilters">
          <label class="adj-overlaySearchLabel">
            <span>Search</span>
            <input type="search" value="${escapeAttribute(filters.saleSearch || '')}" placeholder="Type name…" data-sale-search data-focus-key="sale-search" />
          </label>
          <label>
            <span>Category</span>
            ${renderOverlayDropdown({
    id: 'sale-category',
    action: 'saleCategory',
    selectedValue: cat,
    fallbackLabel: 'All categories',
    options: [{ value: '', label: 'All categories' }, ...categoryOptions.map((c) => ({ value: c, label: c }))],
    openDropdown: filters.openDropdown
  })}
          </label>
        </div>
        <div class="adj-pickerTable" data-scroll-key="sale-picker">
          <table class="adj-table adj-table--picker">
            <thead>
              <tr><th></th><th>Menu Item</th><th>Category</th></tr>
            </thead>
            <tbody>
              ${paginated.items.map((p) => {
    const isSelected = selectedIds.has(String(p.id));
    return `
                <tr>
                  <td><input type="checkbox" data-sale-select="${escapeAttribute(p.id)}" ${isSelected ? 'checked' : ''} /></td>
                  <td><strong>${escapeHtml(p.name || '')}</strong></td>
                  <td>${escapeHtml(p.category || '')}</td>
                </tr>`;
  }).join('') || '<tr><td colspan="3"><div class="adj-empty"><span>No menu items found.</span></div></td></tr>'}
            </tbody>
          </table>
        </div>
        ${renderPagination('salePage', paginated)}
        <div class="adj-overlayActions">
          <div class="adj-overlaySelectionCount">${selectedIds.size} selected</div>
          <div class="adj-overlayActionRail">
            <button type="button" class="adj-primary" data-sale-add-selected ${selectedIds.size ? '' : 'disabled'}>Add to Draft</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function createEmptySaleAdjustmentDraft() {
  return {
    locationId: 'main',
    locationName: 'Main Store',
    saleReason: '',
    note: '',
    date: '',
    items: []
  };
}

function createEmptyDraft() {
  return {
    mode: 'remove',
    siteId: '',
    siteName: '',
    locationId: 'main',
    locationName: 'Main Store',
    note: '',
    wasteReason: '',
    items: []
  };
}

function formatCurrency(value) {
  const amount = Number(value || 0) || 0;
  return `R ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(value) {
  const amount = Number(value || 0) || 0;
  return amount.toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
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
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3l-1.5-2Z"/><circle cx="12" cy="12.5" r="3.5"/></svg>',
    clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
    flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>'
  };
  return icons[name] || icons.x;
}
