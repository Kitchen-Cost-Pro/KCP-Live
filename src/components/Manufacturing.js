import '../styles/manufacturing.css';
import '../styles/fieldHelp.css';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';

export function renderManufacturing({ state, onManufacturingFilterChange, onManufacturingAction = {} } = {}) {
  const manufacturing = state.manufacturing || {};
  const filters = {
    query: '',
    componentQuery: '',
    type: '',
    section: 'recipes',
    ...manufacturing.filters
  };
  const activeSection = filters.section === 'production' ? 'production' : 'recipes';
  const query = String(filters.query || '').trim().toLowerCase();
  const categoryFilter = String(filters.categoryFilter || '').trim();
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Number(filters.pageSize || 25);
  const allItems = (manufacturing.manufacturedItems || []);
  const visibleItems = allItems.filter((item) => (
    (!filters.type || getProductionItemType(item) === filters.type) &&
    (!categoryFilter || String(item.category || '').trim() === categoryFilter) &&
    (!query || String(item.name || '').toLowerCase().includes(query) || String(item.category || '').toLowerCase().includes(query))
  ));
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, visibleItems.length);
  const pagedItems = visibleItems.slice(pageStart, pageEnd);
  const allCategories = [...new Set(allItems.map((item) => String(item.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const productionDraft = manufacturing.productionDraft || createProductionDraft(manufacturing.sites || [], manufacturing.locations || []);
  const blueprintDraft = manufacturing.blueprintDraft || null;
  const batchDraft = manufacturing.batchDraft || null;

  const view = document.createElement('section');
  view.id = 'view-manufacturing';
  view.className = 'manufacturingView';
  view.dataset.openDropdown = filters.openDropdown || '';
  view.dataset.openProductionImpact = filters.openProductionImpact || '';
  if (manufacturing.status === 'loading' && !(manufacturing.manufacturedItems || []).length && !(manufacturing.stockItems || []).length) {
    view.innerHTML = renderLoadingPanel('Loading manufacturing', 'Fetching recipe blueprints, stock items, production logs, and locations.');
    return view;
  }
  view.innerHTML = `
    ${manufacturing.actionError ? renderNotice(manufacturing.actionError, 'error') : ''}

    <div class="manufacturingShell">
      <section class="manufacturingFrame">
        <header class="manufacturingTopbar">
          <div class="manufacturingTitleWrap">
            <h1>Manufacturing / Sub-Recipe</h1>
            <button
              type="button"
              class="manufacturingHelp"
              aria-label="Manufacturing help"
              data-help-tooltip="Create sub-recipes and manufactured/prep items. Sub-recipes deplete inside menu recipes; prep items post production batches before sale."
            >${icon('info')}</button>
          </div>
          <div class="manufacturingToolbar">
            <input type="file" accept=".csv,.xlsx,.xls,text/csv" hidden data-mfg-import-input />
            ${activeSection === 'recipes' ? `<button type="button" class="manufacturingPrimaryButton" data-mfg-open-blueprint>
              ${icon('plus')}
              <span>New Item</span>
            </button>` : ''}
            ${renderActionDropdown(filters.openDropdown, manufacturing.actionStatus)}
          </div>
        </header>

        <div class="manufacturingSectionSwitch" role="tablist" aria-label="Manufacturing sections">
          <button type="button" class="${activeSection === 'recipes' ? 'is-selected' : ''}" data-mfg-section="recipes" role="tab" aria-selected="${activeSection === 'recipes' ? 'true' : 'false'}">
            ${icon('edit')}
            <span>Recipe Creation</span>
          </button>
          <button type="button" class="${activeSection === 'production' ? 'is-selected' : ''}" data-mfg-section="production" role="tab" aria-selected="${activeSection === 'production' ? 'true' : 'false'}">
            ${icon('factory')}
            <span>Production Events</span>
          </button>
        </div>

        ${activeSection === 'production'
          ? renderProductionEvent(manufacturing, productionDraft, filters)
          : `
            <div class="mfgFilterBar">
              <div class="mfgFilterBar__search">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  type="search"
                  value="${escapeAttribute(filters.query || '')}"
                  placeholder="Search items..."
                  data-mfg-search
                />
              </div>
              <select class="mfgFilterBar__select" data-mfg-type-select>
                <option value="">All Types</option>
                <option value="manufactured" ${filters.type === 'manufactured' ? 'selected' : ''}>Prep / Manufactured</option>
                <option value="sub_recipe" ${filters.type === 'sub_recipe' ? 'selected' : ''}>Sub-Recipes</option>
              </select>
              <select class="mfgFilterBar__select" data-mfg-category-select>
                <option value="">All Categories</option>
                ${allCategories.map((cat) => `<option value="${escapeAttribute(cat)}" ${categoryFilter === cat ? 'selected' : ''}>${escapeHtml(cat)}</option>`).join('')}
              </select>
              ${(filters.query || filters.type || categoryFilter) ? `<button type="button" class="mfgFilterBar__clear" data-mfg-clear-filters>Clear</button>` : ''}
            </div>

            <div class="mfgSummaryRow">
              <span class="mfgSummaryRow__count">${visibleItems.length} item${visibleItems.length !== 1 ? 's' : ''} &middot; Showing ${visibleItems.length ? pageStart + 1 : 0}&ndash;${pageEnd} of ${visibleItems.length}</span>
              <label class="mfgSummaryRow__pageSize">
                Rows per page
                <select data-mfg-page-size>
                  ${[10, 25, 50, 100].map((n) => `<option value="${n}" ${pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
                </select>
              </label>
            </div>

            <div class="mfgTableWrap">
              <table class="mfgTable">
                <thead>
                  <tr>
                    <th class="mfgTable__name">Item Name</th>
                    <th class="mfgTable__type">Type</th>
                    <th class="mfgTable__category">Category</th>
                    <th class="mfgTable__yield">Yield</th>
                    <th class="mfgTable__cost">Cost / Unit</th>
                    <th class="mfgTable__action"></th>
                  </tr>
                </thead>
                <tbody>
                  ${pagedItems.length ? pagedItems.map(renderManufacturedTableRow).join('') : `
                    <tr><td colspan="6" class="mfgTable__empty">No manufacturing or sub-recipe items found.</td></tr>
                  `}
                </tbody>
              </table>
            </div>

            ${totalPages > 1 ? `
            <div class="mfgPagination">
              <span class="mfgPagination__info">Showing ${pageStart + 1}&ndash;${pageEnd} of ${visibleItems.length} items</span>
              <div class="mfgPagination__controls">
                <button type="button" class="mfgPagination__btn" data-mfg-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
                ${Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => `
                  <button type="button" class="mfgPagination__btn ${p === currentPage ? 'is-current' : ''}" data-mfg-page="${p}">${p}</button>
                `).join('')}
                <button type="button" class="mfgPagination__btn" data-mfg-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
              </div>
            </div>` : ''}
          `}
      </section>
    </div>

    ${blueprintDraft ? renderBlueprintModal(blueprintDraft, manufacturing.stockItems || [], manufacturing.locations || [], filters, manufacturing.categories || [], manufacturing.uoms || [], {
      actionStatus: manufacturing.actionStatus,
      actionError: manufacturing.actionError
    }) : ''}
    ${blueprintDraft && manufacturing.lookupPicker?.open ? renderLookupPickerModal(blueprintDraft, manufacturing.lookupPicker, manufacturing.categories || [], manufacturing.uoms || []) : ''}
    ${batchDraft ? renderBatchModal(batchDraft, manufacturing.sites || [], manufacturing.locations || [], manufacturing.filters || {}) : ''}
    ${manufacturing.exportPlatformPicker?.open ? `
    <div id="mfg-platform-picker" class="manufacturingModalBackdrop" style="display:flex;align-items:center;justify-content:center;z-index:1100;">
      <div class="manufacturingPickerModal" style="max-width:420px;width:100%;padding:2rem;text-align:center;">
        <h3 style="margin:0 0 0.5rem;font-size:1.15rem;font-weight:600;">Choose Export Platform</h3>
        <p style="margin:0 0 1.5rem;color:var(--color-text-muted,#6b7280);font-size:0.9rem;">Select where you'll use this import template so the correct formula format is applied.</p>
        <div style="display:flex;gap:1rem;justify-content:center;margin-bottom:1.25rem;">
          <button type="button" class="manufacturingGhostButton" data-mfg-platform="sheets"
            style="display:flex;flex-direction:column;align-items:center;gap:0.5rem;padding:1.25rem 1.5rem;min-width:130px;border-radius:10px;font-size:0.9rem;font-weight:500;">
            <svg width="36" height="36" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect width="48" height="48" rx="8" fill="#34A853"/>
              <rect x="10" y="12" width="28" height="24" rx="2" fill="white"/>
              <line x1="10" y1="20" x2="38" y2="20" stroke="#34A853" stroke-width="2"/>
              <line x1="10" y1="28" x2="38" y2="28" stroke="#34A853" stroke-width="2"/>
              <line x1="22" y1="12" x2="22" y2="36" stroke="#34A853" stroke-width="2"/>
            </svg>
            Google Sheets
          </button>
          <button type="button" class="manufacturingPrimaryButton" data-mfg-platform="excel"
            style="display:flex;flex-direction:column;align-items:center;gap:0.5rem;padding:1.25rem 1.5rem;min-width:130px;border-radius:10px;font-size:0.9rem;font-weight:500;">
            <svg width="36" height="36" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect width="48" height="48" rx="8" fill="#217346"/>
              <rect x="10" y="12" width="28" height="24" rx="2" fill="white"/>
              <line x1="10" y1="20" x2="38" y2="20" stroke="#217346" stroke-width="2"/>
              <line x1="10" y1="28" x2="38" y2="28" stroke="#217346" stroke-width="2"/>
              <line x1="22" y1="12" x2="22" y2="36" stroke="#217346" stroke-width="2"/>
              <text x="16" y="31" font-size="10" font-weight="bold" fill="#217346" font-family="sans-serif">X</text>
            </svg>
            Microsoft Excel
          </button>
        </div>
        <button type="button" class="manufacturingGhostButton" data-mfg-platform-cancel style="font-size:0.85rem;padding:0.4rem 1rem;">Cancel</button>
      </div>
    </div>
    ` : ''}
    ${renderToast(manufacturing.toast)}
  `;

  bindManufacturingEvents(view, onManufacturingFilterChange, onManufacturingAction);
  bindFieldHelpTooltips(view);
  return view;
}

function bindManufacturingEvents(view, onManufacturingFilterChange, onManufacturingAction) {
  view.querySelectorAll('[data-mfg-section]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingFilterChange?.({ section: button.dataset.mfgSection || 'recipes', openDropdown: '', openProductionImpact: '' }));
  });
  view.querySelector('[data-mfg-search]')?.addEventListener('input', (event) => {
    onManufacturingFilterChange?.({ query: event.currentTarget.value, page: 1 });
  });
  view.querySelectorAll('[data-mfg-type-filter]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingFilterChange?.({ type: button.dataset.mfgTypeFilter || '' }));
  });
  view.querySelector('[data-mfg-type-select]')?.addEventListener('change', (event) => {
    onManufacturingFilterChange?.({ type: event.currentTarget.value, page: 1 });
  });
  view.querySelector('[data-mfg-category-select]')?.addEventListener('change', (event) => {
    onManufacturingFilterChange?.({ categoryFilter: event.currentTarget.value, page: 1 });
  });
  view.querySelector('[data-mfg-clear-filters]')?.addEventListener('click', () => {
    onManufacturingFilterChange?.({ query: '', type: '', categoryFilter: '', page: 1 });
  });
  view.querySelector('[data-mfg-page-size]')?.addEventListener('change', (event) => {
    onManufacturingFilterChange?.({ pageSize: Number(event.currentTarget.value), page: 1 });
  });
  view.querySelectorAll('[data-mfg-page]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingFilterChange?.({ page: Number(button.dataset.mfgPage) }));
  });

  view.querySelector('[data-mfg-open-blueprint]')?.addEventListener('click', () => onManufacturingAction.onOpenBlueprint?.(''));
  view.querySelector('[data-mfg-action-new]')?.addEventListener('click', () => {
    onManufacturingFilterChange?.({ openDropdown: '' });
    onManufacturingAction.onOpenBlueprint?.('');
  });
  const importInput = view.querySelector('[data-mfg-import-input]');
  view.querySelector('[data-mfg-import-trigger]')?.addEventListener('click', () => {
    onManufacturingFilterChange?.({ openDropdown: '' });
    importInput?.click();
  });
  importInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) onManufacturingAction.onImport?.(file);
    event.target.value = '';
  });
  view.querySelectorAll('[data-mfg-export]').forEach((button) => {
    button.addEventListener('click', () => {
      onManufacturingFilterChange?.({ openDropdown: '' });
      if (button.dataset.mfgExport === 'template-xlsx') {
        // Download the Excel manufactured-items builder directly (Google Sheets not supported).
        onManufacturingAction.onExport?.('template-xlsx:excel');
      } else {
        onManufacturingAction.onExport?.(button.dataset.mfgExport);
      }
    });
  });
  view.querySelectorAll('[data-mfg-platform]').forEach((button) => {
    button.addEventListener('click', () => {
      onManufacturingAction.onExport?.('template-xlsx:' + button.dataset.mfgPlatform);
      onManufacturingFilterChange?.({ exportPlatformPicker: null });
    });
  });
  view.querySelector('[data-mfg-platform-cancel]')?.addEventListener('click', () => {
    onManufacturingFilterChange?.({ exportPlatformPicker: null });
  });
  view.querySelectorAll('[data-mfg-edit]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingAction.onOpenBlueprint?.(button.dataset.mfgEdit || ''));
  });
  view.querySelectorAll('[data-mfg-produce]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingAction.onOpenBatch?.(button.dataset.mfgProduce || ''));
  });
  view.querySelectorAll('[data-mfg-delete]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingAction.onDeleteBlueprint?.(button.dataset.mfgDelete || ''));
  });

  view.querySelectorAll('[data-mfg-blueprint-close]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingAction.onCloseBlueprint?.());
  });
  view.querySelector('[data-mfg-blueprint-name]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingAction.onUpdateBlueprint?.({ name: event.currentTarget.value });
  });
  view.querySelector('[data-mfg-blueprint-category]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingAction.onUpdateBlueprint?.({ category: event.currentTarget.value });
  });
  view.querySelector('[data-mfg-blueprint-unit]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingAction.onUpdateBlueprint?.({ unit: event.currentTarget.value });
  });
  view.querySelectorAll('[data-mfg-blueprint-type]').forEach((control) => {
    control.addEventListener('click', () => onManufacturingAction.onUpdateBlueprint?.({ itemType: control.dataset.mfgBlueprintType || 'manufactured' }));
  });
  view.querySelectorAll('[data-mfg-open-lookup]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onManufacturingAction.onOpenLookup?.(button.dataset.mfgOpenLookup);
    });
  });
  view.querySelectorAll('[data-mfg-lookup-picker-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      onManufacturingAction.onPreserveFocus?.(input);
      onManufacturingAction.onLookupSearch?.(event.target.value);
    });
  });
  view.querySelectorAll('[data-mfg-lookup-picker-use]').forEach((button) => {
    button.addEventListener('click', () => {
      onManufacturingAction.onLookupUse?.(button.dataset.mfgLookupPickerField, button.dataset.mfgLookupPickerUse);
    });
  });
  view.querySelectorAll('[data-mfg-lookup-picker-close]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingAction.onCloseLookup?.());
  });
  view.querySelector('[data-mfg-blueprint-yield]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingAction.onUpdateBlueprint?.({ yieldBatch: event.currentTarget.value });
  });
  view.querySelector('[data-mfg-component-search]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingFilterChange?.({ componentQuery: event.currentTarget.value });
  });
  view.querySelectorAll('[data-mfg-component-type-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      onManufacturingFilterChange?.({ componentType: button.dataset.mfgComponentTypeFilter || '' });
    });
  });
  view.querySelectorAll('[data-mfg-add-component]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingAction.onToggleComponentSelection?.(button.dataset.mfgAddComponent || ''));
  });
  view.querySelectorAll('[data-mfg-component-qty]').forEach((input) => {
    input.addEventListener('input', () => {
      onManufacturingAction.onPreserveFocus?.(input);
      onManufacturingAction.onUpdateRecipeLine?.(Number(input.dataset.mfgComponentQty), { qty: input.value });
    });
  });
  view.querySelectorAll('[data-mfg-remove-component]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingAction.onRemoveRecipeLine?.(Number(button.dataset.mfgRemoveComponent)));
  });
  view.querySelector('[data-mfg-blueprint-save]')?.addEventListener('click', () => onManufacturingAction.onSaveBlueprint?.());
  view.querySelector('[data-mfg-component-picker-open]')?.addEventListener('click', () => {
    onManufacturingFilterChange?.({ componentQuery: '', componentCategory: '', componentType: '' });
    onManufacturingAction.onUpdateBlueprint?.({ componentPickerOpen: true, componentPickerSelection: [] });
  });
  view.querySelectorAll('[data-mfg-component-picker-close]').forEach((button) => {
    button.addEventListener('click', () => {
      onManufacturingFilterChange?.({ componentQuery: '', componentCategory: '', componentType: '' });
      onManufacturingAction.onUpdateBlueprint?.({ componentPickerOpen: false, componentPickerSelection: [] });
    });
  });
  view.querySelector('[data-mfg-component-picker-confirm]')?.addEventListener('click', () => {
    onManufacturingAction.onConfirmComponentSelection?.();
  });
  view.querySelector('[data-mfg-open-batch-from-blueprint]')?.addEventListener('click', () => {
    const itemId = view.querySelector('[data-mfg-open-batch-from-blueprint]')?.dataset.mfgOpenBatchFromBlueprint || '';
    onManufacturingAction.onOpenBatch?.(itemId);
  });

  view.querySelectorAll('[data-mfg-batch-close]').forEach((button) => {
    button.addEventListener('click', () => onManufacturingAction.onCloseBatch?.());
  });
  view.querySelectorAll('[data-mfg-dropdown-toggle]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dropdownId = button.dataset.mfgDropdownToggle || '';
      if (!dropdownId) return;
      const shouldOpen = button.getAttribute('aria-expanded') !== 'true';
      onManufacturingFilterChange?.({ openDropdown: shouldOpen ? dropdownId : '' });
    });
  });
  view.querySelectorAll('[data-mfg-dropdown-option]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.mfgDropdownAction || '';
      const value = button.dataset.mfgDropdownValue || '';
      const label = button.dataset.mfgDropdownLabel || button.textContent || '';
      if (action === 'batch-site') {
        onManufacturingAction.onUpdateBatch?.({ siteId: value, siteName: label });
      } else if (action === 'batch-location') {
        onManufacturingAction.onUpdateBatch?.({
          locationId: value,
          locationName: label
        });
      } else if (action === 'production-site') {
        onManufacturingAction.onUpdateProductionDraft?.({ siteId: value, siteName: label });
      } else if (action === 'production-location') {
        onManufacturingAction.onUpdateProductionDraft?.({ locationId: value, locationName: label });
      } else if (action === 'production-category') {
        onManufacturingFilterChange?.({ productionCategory: value });
      } else if (action === 'component-category') {
        onManufacturingFilterChange?.({ componentCategory: value });
      }
      onManufacturingFilterChange?.({ openDropdown: '' });
    });
  });
  view.querySelector('[data-mfg-batch-multiplier]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingAction.onUpdateBatch?.({ batchMultiplier: event.currentTarget.value });
  });
  view.querySelector('[data-mfg-batch-expected]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingAction.onUpdateBatch?.({ expectedQty: event.currentTarget.value });
  });
  view.querySelector('[data-mfg-batch-produced]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingAction.onUpdateBatch?.({ producedQty: event.currentTarget.value });
  });
  view.querySelector('[data-mfg-batch-date]')?.addEventListener('input', (event) => {
    onManufacturingAction.onUpdateBatch?.({ date: event.currentTarget.value });
  });
  view.querySelector('[data-mfg-batch-note]')?.addEventListener('input', (event) => {
    onManufacturingAction.onPreserveFocus?.(event.currentTarget);
    onManufacturingAction.onUpdateBatch?.({ note: event.currentTarget.value });
  });
  view.querySelector('[data-mfg-batch-save]')?.addEventListener('click', () => onManufacturingAction.onSaveBatch?.());
  view.querySelectorAll('[data-mfg-production-field]').forEach((field) => {
    field.addEventListener('input', (event) => {
      onManufacturingAction.onPreserveFocus?.(event.currentTarget);
      onManufacturingAction.onUpdateProductionDraft?.({ [field.dataset.mfgProductionField]: event.currentTarget.value });
    });
  });
  view.querySelectorAll('[data-mfg-production-batches]').forEach((field) => {
    field.addEventListener('input', (event) => {
      onManufacturingAction.onPreserveFocus?.(event.currentTarget);
      onManufacturingAction.onUpdateProductionBatches?.(field.dataset.mfgProductionBatches, event.currentTarget.value);
    });
  });
  view.querySelectorAll('[data-mfg-production-actual]').forEach((field) => {
    field.addEventListener('input', (event) => {
      onManufacturingAction.onPreserveFocus?.(event.currentTarget);
      onManufacturingAction.onUpdateProductionActual?.(field.dataset.mfgProductionActual, event.currentTarget.value);
    });
  });
  view.querySelectorAll('[data-mfg-production-impact-toggle]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const itemId = button.dataset.mfgProductionImpactToggle || '';
      const current = view.dataset.openProductionImpact || '';
      onManufacturingFilterChange?.({
        openProductionImpact: current === itemId ? '' : itemId,
        openDropdown: ''
      });
    });
  });
  view.querySelector('[data-mfg-production-save]')?.addEventListener('click', () => onManufacturingAction.onSaveProductionEvent?.());
  view.querySelector('[data-mfg-toast-close]')?.addEventListener('click', () => onManufacturingAction.onDismissToast?.());
  view.addEventListener('click', (event) => {
    if (event.target.closest('[data-mfg-dropdown-root]')) return;
    onManufacturingFilterChange?.({ openDropdown: '' });
  });
}

function renderProductionEvent(manufacturing = {}, draft = {}, filters = {}) {
  const openDropdown = String(filters.openDropdown || '').trim();
  const openProductionImpact = String(filters.openProductionImpact || '').trim();
  const search = String(filters.query || '').trim().toLowerCase();
  const category = String(filters.productionCategory || '').trim();
  const siteOptions = (manufacturing.sites || []).map((site) => ({ value: site.id, label: site.name || site.code || site.id }));
  const siteId = draft.siteId || siteOptions[0]?.value || '';
  const scopedLocations = (manufacturing.locations || []).filter((location) => !siteId || String(location.siteId || '') === String(siteId));
  const locationLabel = (manufacturing.locations || []).find((location) => String(location.id) === String(draft.locationId || ''))?.name ||
    draft.locationName ||
    'Select location';
  const siteLabel = (manufacturing.sites || []).find((site) => String(site.id) === String(siteId || ''))?.name ||
    draft.siteName ||
    'Select group';
  const manufacturedItems = (manufacturing.manufacturedItems || [])
    .filter((item) => getProductionItemType(item) === 'manufactured')
    .filter((item) => !search || String(item.name || '').toLowerCase().includes(search) || String(item.category || '').toLowerCase().includes(search))
    .filter((item) => !category || String(item.category || '') === category);
  const categories = [...new Set((manufacturing.manufacturedItems || [])
    .filter((item) => getProductionItemType(item) === 'manufactured')
    .map((item) => String(item.category || 'Uncategorised').trim() || 'Uncategorised'))]
    .sort((left, right) => left.localeCompare(right));
  const actuals = draft.actuals || {};
  const batchCounts = draft.batchCounts || {};
  const activeRows = manufacturedItems
    .map((item) => ({
      item,
      ...getProductionLineTotals(item, batchCounts, actuals),
      impact: getProductionStockImpact(item, batchCounts, actuals, manufacturing.stockItems || [], draft.locationId || '')
    }))
    .filter((entry) => entry.batchCount > 0);
  const hasStockBlockingIssue = activeRows.some((entry) => entry.impact?.hasInsufficientStock || entry.impact?.hasMissingRecipe);
  const totalValue = activeRows.reduce((sum, entry) => sum + entry.batchCost, 0);

  return `
    <section class="manufacturingProductionEvent">
      <div class="manufacturingProductionHead">
        <div>
          <p>Production Event</p>
          <h2>Post Production Batches</h2>
        </div>
        <div class="manufacturingProductionSummary">
          <span>${activeRows.length} active line${activeRows.length === 1 ? '' : 's'}</span>
          <strong>${formatCurrency(totalValue)}</strong>
        </div>
      </div>

      <div class="manufacturingProductionControls">
        <label class="manufacturingField manufacturingField--note">
          <span>Event Name</span>
          <input type="text" value="${escapeAttribute(draft.note || '')}" placeholder="Today's prep run" data-mfg-production-field="note" data-focus-key="mfg-production-note" />
        </label>
        <label class="manufacturingField">
          <span>Date</span>
          <input type="date" value="${escapeAttribute(draft.date || '')}" data-mfg-production-field="date" />
        </label>
        ${siteOptions.length > 1 ? `
          <label class="manufacturingField">
            <span>Location Group</span>
            ${renderProductionDropdown({
              id: 'production-site',
              action: 'production-site',
              value: siteId,
              label: siteLabel,
              options: siteOptions,
              openDropdown
            })}
          </label>
        ` : ''}
        <label class="manufacturingField">
          <span>Storage Area</span>
          ${renderProductionDropdown({
            id: 'production-location',
            action: 'production-location',
            value: draft.locationId || '',
            label: locationLabel,
            options: scopedLocations.map((location) => ({
              value: location.id,
              label: location.displayName || location.name || location.id
            })),
            openDropdown
          })}
        </label>
      </div>

      <div class="manufacturingProductionFilters">
        <label class="manufacturingSearchField">
          <span>Search</span>
          <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search preparation..." data-mfg-search />
        </label>
        ${renderProductionCategoryFilter(category, categories, openDropdown)}
      </div>

      <div class="manufacturingProductionTableWrap">
        <table class="manufacturingProductionTable">
          <thead>
            <tr>
              <th>${renderFieldHelpLabel('Preparation', 'Manufactured or prep item being produced.')}</th>
              <th>${renderFieldHelpLabel('Recipe Makes', 'Expected output quantity from one saved recipe or standard batch.')}</th>
              <th>${renderFieldHelpLabel('Batches Made', 'How many recipe batches were made. This controls ingredient usage.')}</th>
              <th>${renderFieldHelpLabel('Expected', 'Expected finished output based on recipe makes multiplied by batches made.')}</th>
              <th>${renderFieldHelpLabel('Actually Made', 'Actual finished quantity produced. This updates the final batch costing.')}</th>
              <th>${renderFieldHelpLabel('Value', 'Ingredient cost consumed by this production line.')}</th>
              <th>${renderFieldHelpLabel('Unit', 'Base unit of measure for the finished item.')}</th>
            </tr>
          </thead>
          <tbody>
            ${manufacturedItems.length ? manufacturedItems.map((item) => renderProductionRow(item, batchCounts, actuals, manufacturing.stockItems || [], draft.locationId || '', openProductionImpact)).join('') : `
              <tr>
                <td colspan="7"><div class="manufacturingEmpty manufacturingEmpty--compact">No manufactured/prep items match.</div></td>
              </tr>
            `}
          </tbody>
        </table>
      </div>

      <footer class="manufacturingProductionActions">
        ${hasStockBlockingIssue ? '<span class="manufacturingProductionWarning">Resolve missing recipe ingredients or insufficient stock before posting production.</span>' : ''}
        <button type="button" class="manufacturingPrimaryButton" data-mfg-production-save ${draft.locationId && activeRows.length && manufacturing.actionStatus !== 'saving' ? '' : 'disabled'}>
          ${icon('check')}
          <span>${manufacturing.actionStatus === 'saving' ? 'Posting' : 'Post Production Event'}</span>
        </button>
      </footer>
    </section>
  `;
}

function renderProductionDropdown({ id, action, value, label, options = [], openDropdown = '' }) {
  const isOpen = openDropdown === id;
  return `
    <div class="manufacturingDropdown ${isOpen ? 'manufacturingDropdown--open' : ''}" data-mfg-dropdown-root>
      <button type="button" class="manufacturingDropdownToggle" data-mfg-dropdown-toggle="${escapeAttribute(id)}" aria-expanded="${isOpen ? 'true' : 'false'}">
        <span>${escapeHtml(label || 'Select')}</span>
        ${icon('chevronDown')}
      </button>
      <div class="manufacturingDropdownMenu" role="listbox">
        ${options.length ? options.map((option) => `
          <button
            type="button"
            class="manufacturingDropdownOption ${String(option.value) === String(value) ? 'is-selected' : ''}"
            data-mfg-dropdown-option
            data-mfg-dropdown-action="${escapeAttribute(action)}"
            data-mfg-dropdown-value="${escapeAttribute(option.value)}"
            data-mfg-dropdown-label="${escapeAttribute(option.label)}"
          >
            ${escapeHtml(option.label)}
          </button>
        `).join('') : '<div class="manufacturingDropdownEmpty">No options available.</div>'}
      </div>
    </div>
  `;
}

function renderProductionCategoryFilter(category = '', categories = [], openDropdown = '') {
  return `
    <label class="manufacturingField">
      <span>Category</span>
      ${renderProductionDropdown({
        id: 'production-category',
        action: 'production-category',
        value: category,
        label: category || 'All categories',
        options: [
          { value: '', label: 'All categories' },
          ...categories.map((entry) => ({ value: entry, label: entry }))
        ],
        openDropdown
      })}
    </label>
  `;
}

function renderProductionRow(item = {}, batchCounts = {}, actuals = {}, stockItems = [], locationId = '', openProductionImpact = '') {
  const batchValue = batchCounts[item.id] ?? '';
  const actual = actuals[item.id] ?? '';
  const totals = getProductionLineTotals(item, batchCounts, actuals);
  const impact = getProductionStockImpact(item, batchCounts, actuals, stockItems, locationId);
  const itemId = String(item.id || '');
  const isImpactOpen = openProductionImpact === itemId;
  const hasWastage = totals.batchCount > 0 && totals.producedQty < totals.expectedQty;
  const hasOverProduction = totals.batchCount > 0 && totals.producedQty > totals.expectedQty;
  const unitCostTone = totals.actualUnitCost > totals.expectedUnitCost ? 'is-cost-worse' : totals.actualUnitCost < totals.expectedUnitCost ? 'is-cost-better' : '';
  const unitLabel = String(item.unit || 'ea').toUpperCase();
  return `
    <tr class="${totals.batchCount > 0 ? 'is-active' : ''} ${hasWastage ? 'is-waste' : ''} ${hasOverProduction ? 'is-overproduced' : ''} ${impact.hasInsufficientStock || impact.hasMissingRecipe ? 'is-danger' : ''} ${isImpactOpen ? 'is-impact-open' : ''}">
      <td>
        <div class="manufacturingProductionItem">
          <strong>${escapeHtml(item.name || '')}</strong>
          <span>${escapeHtml(formatManufacturedCategoryLabel(item.category || 'Manufactured'))}</span>
          ${hasWastage ? '<em class="manufacturingYieldBadge manufacturingYieldBadge--waste">Wastage</em>' : ''}
          ${hasOverProduction ? '<em class="manufacturingYieldBadge manufacturingYieldBadge--over">Over produced</em>' : ''}
          <button
            type="button"
            class="manufacturingImpactToggle ${isImpactOpen ? 'is-open' : ''}"
            data-mfg-production-impact-toggle="${escapeAttribute(itemId)}"
            aria-expanded="${isImpactOpen ? 'true' : 'false'}"
          >
            ${icon('chevronDown')}
            <span>Stock impact</span>
          </button>
        </div>
      </td>
      <td>${renderProductionQuantity(item.yieldBatch || 0, unitLabel)}</td>
      <td>
        <input
          class="manufacturingProductionInput"
          type="text"
          inputmode="decimal"
          value="${escapeAttribute(String(batchValue))}"
          placeholder="0"
          data-mfg-production-batches="${escapeAttribute(item.id)}"
          data-focus-key="mfg-production-batches-${escapeAttribute(item.id)}"
        />
      </td>
      <td>${totals.batchCount > 0 ? renderProductionQuantity(totals.expectedQty, unitLabel) : '-'}</td>
      <td>
        <label class="manufacturingProductionInputWrap">
          <input
            class="manufacturingProductionInput"
            type="text"
            inputmode="decimal"
            value="${escapeAttribute(String(actual))}"
            placeholder="${totals.batchCount > 0 ? formatNumber(totals.expectedQty) : 'Optional'}"
            data-mfg-production-actual="${escapeAttribute(item.id)}"
            data-focus-key="mfg-production-actual-${escapeAttribute(item.id)}"
          />
          <span>${escapeHtml(unitLabel)}</span>
        </label>
      </td>
      <td>
        <div class="manufacturingProductionValue">
          <strong>${formatCurrency(totals.batchCost)}</strong>
          ${totals.batchCount > 0 ? `<span class="${unitCostTone}">${formatCurrency(totals.actualUnitCost)} / ${escapeHtml(String(item.unit || 'ea').toLowerCase())}</span>` : ''}
        </div>
      </td>
      <td>${escapeHtml(unitLabel)}</td>
    </tr>
    ${isImpactOpen ? `
    <tr class="manufacturingProductionImpactRow ${totals.batchCount > 0 ? 'is-active' : ''}">
      <td colspan="7">
        ${renderProductionStockImpact(item, impact)}
      </td>
    </tr>
    ` : ''}
  `;
}

function renderProductionQuantity(value, unit = '') {
  return `
    <span class="manufacturingProductionQuantity">
      <strong>${formatNumber(value)}</strong>
      <em>${escapeHtml(String(unit || 'EA').toUpperCase())}</em>
    </span>
  `;
}

function getProductionLineTotals(item = {}, batchCounts = {}, actuals = {}) {
  const batchCount = Math.max(parseNumber(batchCounts[item.id]), 0);
  const standardYield = Math.max(parseNumber(item.yieldBatch || 0), 0);
  const expectedQty = batchCount * standardYield;
  const actualRaw = String(actuals[item.id] ?? '').trim();
  const actualQty = actualRaw ? Math.max(parseNumber(actualRaw), 0) : expectedQty;
  const fallbackUnitCost = Number(item.unitCost || item.cost || 0) || 0;
  const recipeBatchCost = Number(item.batchCost || 0) || (standardYield * fallbackUnitCost);
  const expectedUnitCost = standardYield > 0 ? recipeBatchCost / standardYield : fallbackUnitCost;
  const batchCost = batchCount * recipeBatchCost;
  const actualUnitCost = actualQty > 0 ? batchCost / actualQty : expectedUnitCost;
  return {
    batchCount,
    expectedQty,
    producedQty: actualQty,
    expectedUnitCost,
    actualUnitCost,
    batchCost
  };
}

function getProductionStockImpact(item = {}, batchCounts = {}, actuals = {}, stockItems = [], locationId = '') {
  const totals = getProductionLineTotals(item, batchCounts, actuals);
  const componentMap = new Map((stockItems || []).map((entry) => [String(entry.id), entry]));
  const yieldBatch = Math.max(parseNumber(item.yieldBatch || 0), 0);
  const recipe = Array.isArray(item.recipe) ? item.recipe : [];
  const components = recipe
    .map((line) => {
      const component = componentMap.get(String(line.ingId || line.id || line.stockItemId || ''));
      const componentQty = Math.max(parseNumber(line.qty || line.quantity || 0), 0);
      const usage = yieldBatch > 0 ? (componentQty / yieldBatch) * totals.expectedQty : 0;
      const before = getProductionLocationQty(component, locationId);
      const after = before - usage;
      return {
        id: String(component?.id || line.ingId || ''),
        name: component?.name || 'Missing ingredient',
        unit: component?.unit || '',
        before,
        usage,
        after,
        missing: !component,
        insufficient: Boolean(component) && usage > 0 && after < 0
      };
    })
    .filter((line) => line.id || line.name);
  const finishedBefore = getProductionLocationQty(item, locationId);
  const finishedAfter = finishedBefore + totals.producedQty;
  const wastageQty = Math.max(totals.expectedQty - totals.producedQty, 0);
  const overProductionQty = Math.max(totals.producedQty - totals.expectedQty, 0);
  return {
    ...totals,
    components,
    finishedBefore,
    finishedAfter,
    wastageQty,
    overProductionQty,
    hasMissingRecipe: !recipe.length,
    hasInsufficientStock: components.some((line) => line.insufficient || line.missing)
  };
}

function getProductionLocationQty(item = {}, locationId = '') {
  const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
  const key = String(locationId || '').trim();
  if (key && Object.prototype.hasOwnProperty.call(balances, key)) return Number(balances[key] || 0) || 0;
  if (key) return 0;
  return Object.keys(balances).length
    ? Object.values(balances).reduce((sum, value) => sum + (Number(value || 0) || 0), 0)
    : Number(item?.stock || 0) || 0;
}

function renderProductionStockImpact(item = {}, impact = {}) {
  const unit = String(item.unit || 'ea').toLowerCase();
  if (!(impact.batchCount > 0)) {
    return `
      <div class="manufacturingImpactDropdown">
        <div class="manufacturingImpactEmpty">Enter batches to preview ingredient deductions and finished-stock impact.</div>
      </div>
    `;
  }
  const componentRows = (impact.components || []).length
    ? impact.components.map((line) => `
      <div class="manufacturingImpactLine ${line.insufficient || line.missing ? 'manufacturingImpactLine--danger' : ''}">
        <strong>${escapeHtml(line.name)}</strong>
        <span>Before <b>${formatNumber(line.before)} ${escapeHtml(String(line.unit || '').toLowerCase())}</b></span>
        <span>Deduct <b>${formatNumber(line.usage)} ${escapeHtml(String(line.unit || '').toLowerCase())}</b></span>
        <span>After <b>${formatNumber(line.after)} ${escapeHtml(String(line.unit || '').toLowerCase())}</b></span>
        ${line.missing ? '<em>Missing ingredient</em>' : line.insufficient ? '<em>Insufficient stock</em>' : ''}
      </div>
    `).join('')
    : '<div class="manufacturingImpactEmpty">No blueprint ingredients found for this prep item.</div>';
  return `
    <div class="manufacturingImpactDropdown ${impact.hasInsufficientStock || impact.hasMissingRecipe ? 'manufacturingImpactDropdown--danger' : ''}">
      <div class="manufacturingImpactPanel">
        <div class="manufacturingImpactFinished">
          <span>Expected <b>${formatNumber(impact.expectedQty)} ${escapeHtml(unit)}</b></span>
          <span>Actual <b>${formatNumber(impact.producedQty)} ${escapeHtml(unit)}</b></span>
          <span>Finished after <b>${formatNumber(impact.finishedAfter)} ${escapeHtml(unit)}</b></span>
          <span>Batch cost <b>${formatCurrency(impact.batchCost || 0)}</b></span>
          <span class="${impact.actualUnitCost > impact.expectedUnitCost ? 'is-cost-worse' : impact.actualUnitCost < impact.expectedUnitCost ? 'is-cost-better' : ''}">Cost / ${escapeHtml(unit)} <b>${formatCurrency(impact.actualUnitCost || 0)}</b></span>
          ${impact.wastageQty > 0 ? `<span class="is-waste">Yield wastage <b>${formatNumber(impact.wastageQty)} ${escapeHtml(unit)}</b></span>` : ''}
          ${impact.overProductionQty > 0 ? `<span class="is-over">Over production <b>${formatNumber(impact.overProductionQty)} ${escapeHtml(unit)}</b></span>` : ''}
        </div>
        <div class="manufacturingImpactLines">
          ${componentRows}
        </div>
      </div>
    </div>
  `;
}

function createProductionDraft(sites = [], locations = []) {
  const siteId = locations[0]?.siteId || sites[0]?.id || '';
  const location = (locations || []).find((entry) => !siteId || String(entry.siteId || '') === String(siteId)) || locations[0] || {};
  return {
    note: '',
    date: new Date().toISOString().slice(0, 10),
    siteId,
    siteName: sites.find((site) => String(site.id) === String(siteId))?.name || '',
    locationId: location.id || '',
    locationName: location.displayName || location.name || '',
    batchCounts: {},
    actuals: {}
  };
}

function renderManufacturedTableRow(item) {
  const unit = String(item.unit || 'ea').toUpperCase();
  const itemType = getProductionItemType(item);
  const typeLabel = itemType === 'sub_recipe' ? 'Sub-Recipe' : 'Prep';
  const missingCount = Number(item.missingRecipeCount || 0) || 0;
  const category = String(item.category || '').trim() || (itemType === 'sub_recipe' ? 'Sub-Recipe' : 'Manufactured');
  return `
    <tr class="mfgTable__row" data-mfg-edit="${escapeAttribute(item.id)}">
      <td class="mfgTable__name">
        <div class="mfgTable__nameCell">
          <div class="mfgTable__icon">${icon('factory')}</div>
          <span class="mfgTable__label">${escapeHtml(item.name || '')}</span>
          ${missingCount ? `<em class="manufacturingTypePill manufacturingTypePill--warning">${missingCount} Missing</em>` : ''}
        </div>
      </td>
      <td class="mfgTable__type">
        <em class="manufacturingTypePill manufacturingTypePill--${escapeAttribute(itemType)}">${escapeHtml(typeLabel)}</em>
      </td>
      <td class="mfgTable__category">${escapeHtml(formatManufacturedCategoryLabel(category))}</td>
      <td class="mfgTable__yield">${formatNumber(item.yieldBatch || 0)} <span class="mfgTable__unit">${escapeHtml(unit)}</span></td>
      <td class="mfgTable__cost">${formatCurrency(item.unitCost || item.cost || 0)}</td>
      <td class="mfgTable__action">
        <div class="mfgTable__actions">
          <button type="button" class="mfgTable__actionBtn" data-mfg-edit="${escapeAttribute(item.id)}" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button type="button" class="mfgTable__actionBtn mfgTable__actionBtn--danger" data-mfg-delete="${escapeAttribute(item.id)}" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `;
}

function renderManufacturedRow(item) {
  const unit = String(item.unit || 'ea').toUpperCase();
  const itemType = getProductionItemType(item);
  const typeLabel = itemType === 'sub_recipe' ? 'Sub-Recipe' : 'Prep';
  const missingCount = Number(item.missingRecipeCount || 0) || 0;
  return `
    <article class="manufacturingRow" data-mfg-edit="${escapeAttribute(item.id)}">
      <div class="manufacturingRowIdentity">
        <div class="manufacturingRowIcon">${icon('factory')}</div>
        <div class="manufacturingRowText">
          <div class="manufacturingRowTitle">
            <strong>${escapeHtml(item.name || '')}</strong>
            <em class="manufacturingTypePill manufacturingTypePill--${escapeAttribute(itemType)}">${escapeHtml(typeLabel)}</em>
            ${missingCount ? `<em class="manufacturingTypePill manufacturingTypePill--warning">${missingCount} Missing Recipe</em>` : ''}
          </div>
          <span>${escapeHtml(formatManufacturedCategoryLabel(item.category || (itemType === 'sub_recipe' ? 'Sub-Recipe' : 'Manufactured')))}</span>
        </div>
      </div>

      <div class="manufacturingRowMetrics">
        <div class="manufacturingRowMetric">
          <label>${itemType === 'sub_recipe' ? 'Recipe Yield' : 'Batch Yield'}</label>
          <strong>${formatNumber(item.yieldBatch || 0)} ${escapeHtml(unit)}</strong>
        </div>
        <div class="manufacturingRowMetric">
          <label>Cost / ${escapeHtml(unit)}</label>
          <strong>${formatCurrency(item.unitCost || item.cost || 0)}</strong>
        </div>
      </div>

      <div class="manufacturingRowChevron">${icon('chevron')}</div>
    </article>
  `;
}

function renderBlueprintModal(draft, stockItems, locations, filters = {}, categories = [], uoms = [], status = {}) {
  const itemType = getProductionItemType(draft);
  const recipeIds = new Set((draft.recipe || []).map((line) => String(line.ingId)));
  const selectedIds = new Set((draft.componentPickerSelection || []).map((line) => String(line)));
  const query = String(filters.componentQuery || '');
  const search = String(query || '').trim().toLowerCase();
  const componentCategory = String(filters.componentCategory || '').trim();
  const componentTypeFilter = String(filters.componentType || '').trim();
  const openDropdown = String(filters.openDropdown || '').trim();
  const categoryOptions = [...new Set((stockItems || [])
    .filter((item) => String(item.id) !== String(draft.id || ''))
    .map((item) => String(item.category || 'Uncategorised').trim() || 'Uncategorised'))]
    .sort((left, right) => left.localeCompare(right));
  const componentMatches = (stockItems || [])
    .filter((item) => String(item.id) !== String(draft.id || ''))
    .filter((item) => (
      !search || String(item.name || '').toLowerCase().includes(search) || String(item.category || '').toLowerCase().includes(search)
    ))
    .filter((item) => !componentCategory || String(item.category || 'Uncategorised') === componentCategory)
    .filter((item) => !componentTypeFilter || getProductionItemType(item) === componentTypeFilter);
  const recipe = draft.recipe || [];
  const batchCost = recipe.reduce((sum, line) => {
    const stockItem = (stockItems || []).find((item) => String(item.id) === String(line.ingId));
    return sum + (parseNumber(line.qty) * (Number(stockItem?.cost || 0) || 0));
  }, 0);
  const yieldBatch = parseNumber(draft.yieldBatch) || 1;
  const unitCost = yieldBatch > 0 ? batchCost / yieldBatch : 0;
  const categoryLookupOptions = getCategorySelectOptions(categories);
  const unitLookupOptions = getUnitSelectOptions(uoms);
  const validationErrors = draft.validationErrors || {};
  const isSaving = status.actionStatus === 'saving';

  return `
    <div class="manufacturingModalBackdrop manufacturingModalBackdrop--drawer">
      <section class="manufacturingArchitectModal manufacturingArchitectModal--drawer">
        <header class="manufacturingArchitectHead">
          <div>
            <div class="manufacturingArchitectBadges">
              <span>${itemType === 'sub_recipe' ? 'Sub-Recipe Architect' : 'Blueprint Architect'}</span>
              <em>${escapeHtml(draft.category || (itemType === 'sub_recipe' ? 'Sub-Recipe' : 'Manufactured'))}</em>
            </div>
            ${draft.id
              ? `<h3 class="manufacturingArchitectTitle">${escapeHtml(draft.name || (itemType === 'sub_recipe' ? 'Sub-Recipe Item' : 'Manufactured Item'))}</h3>`
              : `
                <label class="manufacturingArchitectTitleField">
                  <span>${itemType === 'sub_recipe' ? 'Sub-Recipe Item' : 'Manufactured Item'}</span>
                  <input type="text" value="${escapeAttribute(draft.name || '')}" data-mfg-blueprint-name data-focus-key="mfg-blueprint-name" />
                </label>
              `}
          </div>

          <div class="manufacturingArchitectCost">
            <button type="button" class="manufacturingIconButton" data-mfg-blueprint-close aria-label="Close">${icon('x')}</button>
            <p>${itemType === 'sub_recipe' ? 'Theoretical Recipe Cost' : 'Theoretical Batch Cost'}</p>
            <strong>${formatCurrency(batchCost)}</strong>
          </div>
        </header>

        <div class="manufacturingArchitectBody">
          <div class="manufacturingArchitectSummary">
            <div class="manufacturingSummaryCard">
              ${renderFieldHelpLabel('Standard Batch Yield', 'Expected output quantity produced from one standard manufacturing batch.')}
              <div class="manufacturingYieldEditor">
                <input type="text" inputmode="decimal" value="${escapeAttribute(String(draft.yieldBatch ?? 1))}" data-mfg-blueprint-yield data-focus-key="mfg-blueprint-yield" />
                <span>${escapeHtml(String(draft.unit || 'ea').toLowerCase())}</span>
              </div>
              <div class="manufacturingCostPerUnit">
                <label>${renderFieldHelpLabel(`Cost per ${String(draft.unit || 'ea').toLowerCase()}`, 'Theoretical unit cost based on ingredient cost divided by the standard batch yield.')}</label>
                <strong>${formatCurrency(unitCost)}</strong>
              </div>
              <div class="manufacturingSummaryControls">
                <div class="manufacturingSpecCheckGroup" role="group" aria-label="Blueprint item type">
                  ${renderTypeCheckbox('sub_recipe', 'Sub-Recipe', itemType)}
                  ${renderTypeCheckbox('manufactured', 'Manufactured / Prep', itemType)}
                </div>
                <button
                  type="button"
                  class="manufacturingPrimaryButton manufacturingPrimaryButton--wide"
                  data-mfg-component-picker-open
                >
                  ${icon('plus')}
                  Add Material / Prep Item
                </button>
              </div>
            </div>

            <div class="manufacturingArchitectActions">
              ${draft.id && itemType === 'manufactured' ? `
                <button
                  type="button"
                  class="manufacturingGhostButton manufacturingGhostButton--wide"
                  data-mfg-open-batch-from-blueprint="${escapeAttribute(draft.id)}"
                >
                  ${icon('factory')}
                  Post Production Batch
                </button>
              ` : itemType === 'sub_recipe' ? `
                <div class="manufacturingArchitectHint">Sub-recipes are depleted when a menu item or prep recipe uses them. They do not need a production batch.</div>
              ` : `
                <div class="manufacturingArchitectHint">Save the blueprint first to post a production batch.</div>
              `}
              <div class="manufacturingMetaCard">
                <label class="manufacturingField ${validationErrors.category ? 'manufacturingField--error' : ''}">
                  <span>Category</span>
                  ${renderLookupField({
                    field: 'category',
                    value: draft.category || '',
                    placeholder: 'Type or browse category',
                    options: categoryLookupOptions
                  })}
                </label>
                <label class="manufacturingField ${validationErrors.unit ? 'manufacturingField--error' : ''}">
                  <span>UOM</span>
                  ${renderLookupField({
                    field: 'unit',
                    value: draft.unit || '',
                    placeholder: 'Type or browse UOM',
                    options: unitLookupOptions
                  })}
                </label>
                ${status.actionError ? `<div class="manufacturingBlueprintError" role="alert">${escapeHtml(status.actionError)}</div>` : ''}
              </div>
            </div>
          </div>

          <section class="manufacturingTablePanel">
            <div class="manufacturingPanelHead">
              <strong>Blueprint Ingredients</strong>
              <span>${recipe.length} line${recipe.length === 1 ? '' : 's'}</span>
            </div>

            <div class="manufacturingTableWrap">
              <table class="manufacturingTable">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th>Quantity</th>
                    <th>Cost Impact</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${recipe.length ? recipe.map((line, index) => {
                    const stockItem = (stockItems || []).find((item) => String(item.id) === String(line.ingId));
                    const cost = parseNumber(line.qty) * (Number(stockItem?.cost || 0) || 0);
                    const componentType = getProductionItemType(stockItem || line);
                    const missingRecipe = componentType === 'sub_recipe' && !normalizeRecipeLines(stockItem?.recipe).length;
                    return `
                      <tr>
                        <td>
                          <div class="manufacturingIngredientCell">
                            <strong>${escapeHtml(line.name || 'Ingredient')}</strong>
                            <span>
                              ${escapeHtml(stockItem?.category || 'Standard')}
                              ${componentType !== 'standard' ? `<em class="manufacturingTypePill manufacturingTypePill--${escapeAttribute(componentType)}">${componentType === 'sub_recipe' ? 'Sub-Recipe' : 'Prep'}</em>` : ''}
                              ${missingRecipe ? '<em class="manufacturingTypePill manufacturingTypePill--warning">Missing Recipe</em>' : ''}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div class="manufacturingIngredientQty">
                            <input
                              type="text"
                              inputmode="decimal"
                              value="${escapeAttribute(String(line.qty ?? ''))}"
                              data-mfg-component-qty="${index}"
                              data-focus-key="mfg-component-${index}"
                            />
                            <span>${escapeHtml(String(line.unit || '').toLowerCase())}</span>
                          </div>
                        </td>
                        <td class="manufacturingIngredientCost">${formatCurrency(cost)}</td>
                        <td class="manufacturingIngredientAction">
                          <button type="button" class="manufacturingMiniDanger" data-mfg-remove-component="${index}">Remove</button>
                        </td>
                      </tr>
                    `;
                  }).join('') : `
                    <tr>
                      <td colspan="4">
                        <div class="manufacturingEmpty manufacturingEmpty--compact">No ingredients added yet.</div>
                      </td>
                    </tr>
                  `}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <footer class="manufacturingModalActions manufacturingArchitectFooter">
          <button type="button" class="manufacturingGhostButton" data-mfg-blueprint-close>Cancel</button>
          <button type="button" class="manufacturingPrimaryButton" data-mfg-blueprint-save ${String(draft.name || '').trim() && !isSaving ? '' : 'disabled'}>${isSaving ? 'Saving Blueprint' : 'Save Blueprint'}</button>
        </footer>
      </section>
      ${isSaving ? renderBlueprintSavingModal() : ''}

      ${draft.componentPickerOpen ? `
        <div class="manufacturingPickerBackdrop">
          <section class="manufacturingPickerModal manufacturingPickerModal--overlay">
            <header class="manufacturingPanelHead">
              <strong>Add Material / Prep Item</strong>
              <button type="button" class="manufacturingIconButton" data-mfg-component-picker-close aria-label="Close picker">${icon('x')}</button>
            </header>
            <label class="manufacturingField">
              ${renderFieldHelpLabel('Search Ingredients', 'Search stock items that can be added as raw materials or prep inputs to this blueprint.')}
              <input type="search" value="${escapeAttribute(query || '')}" placeholder="Find ingredients..." data-mfg-component-search data-focus-key="mfg-component-search" />
            </label>
            <label class="manufacturingField">
              ${renderFieldHelpLabel('Category', 'Filter available materials by category before selecting them for the blueprint.')}
              <div
                class="manufacturingDropdown ${openDropdown === 'component-category' ? 'manufacturingDropdown--open' : ''}"
                data-mfg-dropdown-root
              >
                <button
                  type="button"
                  class="manufacturingDropdownToggle"
                  data-mfg-dropdown-toggle="component-category"
                  aria-expanded="${openDropdown === 'component-category' ? 'true' : 'false'}"
                >
                  <span>${escapeHtml(componentCategory || 'All categories')}</span>
                  ${icon('chevronDown')}
                </button>
                <div class="manufacturingDropdownMenu" role="listbox" aria-label="Ingredient category">
                  <button
                    type="button"
                    class="manufacturingDropdownOption ${componentCategory ? '' : 'is-selected'}"
                    data-mfg-dropdown-option
                    data-mfg-dropdown-action="component-category"
                    data-mfg-dropdown-value=""
                    data-mfg-dropdown-label="All categories"
                  >
                    All categories
                  </button>
                  ${categoryOptions.map((category) => `
                    <button
                      type="button"
                      class="manufacturingDropdownOption ${componentCategory === category ? 'is-selected' : ''}"
                      data-mfg-dropdown-option
                      data-mfg-dropdown-action="component-category"
                      data-mfg-dropdown-value="${escapeAttribute(category)}"
                      data-mfg-dropdown-label="${escapeAttribute(category)}"
                    >
                      ${escapeHtml(category)}
                    </button>
                  `).join('')}
                </div>
              </div>
            </label>
            ${renderComponentTypeFilters(componentTypeFilter)}
            <div class="manufacturingComponentList" data-scroll-key="manufacturing-component-list">
              ${componentMatches.map((item) => renderComponentPickerRow(item, selectedIds, recipeIds)).join('') || '<div class="manufacturingEmpty manufacturingEmpty--compact">No stock items match this search.</div>'}
            </div>
            <footer class="manufacturingPickerFooter">
              <button type="button" class="manufacturingGhostButton" data-mfg-component-picker-close>Cancel</button>
              <button
                type="button"
                class="manufacturingPrimaryButton"
                data-mfg-component-picker-confirm
                ${(draft.componentPickerSelection || []).length ? '' : 'disabled'}
              >
                Confirm Selection
              </button>
            </footer>
          </section>
        </div>
      ` : ''}
    </div>
  `;
}

function renderBlueprintSavingModal() {
  return `
    <div class="manufacturingSavingOverlay" role="alert" aria-live="assertive">
      <div class="manufacturingSavingCard">
        <span class="manufacturingSavingSpinner" aria-hidden="true"></span>
        <strong>Saving blueprint</strong>
        <p>Please wait while KCP updates this manufacturing item.</p>
      </div>
    </div>
  `;
}

function renderComponentTypeFilters(activeType = '') {
  const options = [
    { value: '', label: 'All items', tone: 'all' },
    { value: 'standard', label: 'Raw', tone: 'standard' },
    { value: 'sub_recipe', label: 'Sub-Recipes', tone: 'sub_recipe' },
    { value: 'manufactured', label: 'Manufactured', tone: 'manufactured' }
  ];

  return `
    <div class="manufacturingComponentTypeFilters" role="group" aria-label="Filter ingredients by item type">
      ${options.map((option) => `
        <button
          type="button"
          class="manufacturingComponentTypeFilter manufacturingComponentTypeFilter--${escapeAttribute(option.tone)} ${String(activeType || '') === option.value ? 'is-active' : ''}"
          data-mfg-component-type-filter="${escapeAttribute(option.value)}"
          aria-pressed="${String(activeType || '') === option.value ? 'true' : 'false'}"
        >
          ${escapeHtml(option.label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderComponentPickerRow(item, selectedIds, recipeIds) {
  const componentType = getProductionItemType(item);
  const typeLabel = componentType === 'sub_recipe' ? 'Sub-Recipe' : componentType === 'manufactured' ? 'Prep' : 'Raw';

  return `
    <button
      type="button"
      class="manufacturingComponentRow ${selectedIds.has(String(item.id)) ? 'is-selected' : ''} ${recipeIds.has(String(item.id)) ? 'is-existing' : ''}"
      data-mfg-add-component="${escapeAttribute(item.id)}"
    >
      <div class="manufacturingComponentRowMain">
        <strong>${escapeHtml(item.name || '')}</strong>
        <span>
          ${escapeHtml(item.category || 'Uncategorised')}
          <em class="manufacturingTypePill manufacturingTypePill--${escapeAttribute(componentType)}">${escapeHtml(typeLabel)}</em>
        </span>
      </div>
      <em class="manufacturingComponentRowUom">${escapeHtml(String(item.unit || 'ea').toUpperCase())}</em>
    </button>
  `;
}

function renderActionDropdown(openDropdown, actionStatus) {
  const isOpen = openDropdown === 'mfg-actions';
  return `
    <div class="manufacturingDropdown manufacturingActionDropdown ${isOpen ? 'manufacturingDropdown--open' : ''}" data-mfg-dropdown-root>
      <button type="button" class="manufacturingGhostButton manufacturingGhostButton--small" data-mfg-dropdown-toggle="mfg-actions" aria-expanded="${isOpen}">
        ${icon('download')}
        <span>Action Items</span>
        ${icon('chevronDown')}
      </button>
      <div class="manufacturingDropdownMenu manufacturingActionDropdown__menu">
        <button type="button" class="manufacturingDropdownOption" data-mfg-import-trigger ${actionStatus === 'importing' ? 'disabled' : ''}>
          ${icon('upload')}
          <span>${actionStatus === 'importing' ? 'Importing' : 'Import Bulk'}</span>
        </button>
        <span class="manufacturingFileDivider">Import Templates</span>
        <button type="button" class="manufacturingDropdownOption" data-mfg-export="template-xlsx">${icon('download')}<span>Download Import Template XLSX</span></button>
        <span class="manufacturingFileDivider">Export</span>
        <button type="button" class="manufacturingDropdownOption" data-mfg-export="xlsx">${icon('download')}<span>XLSX</span></button>
        <button type="button" class="manufacturingDropdownOption" data-mfg-export="pdf">${icon('download')}<span>PDF</span></button>
      </div>
    </div>
  `;
}

function renderTypeFilterButton(value, label, activeValue) {
  const isActive = String(value || '') === String(activeValue || '');
  return `
    <button
      type="button"
      class="${isActive ? 'is-selected' : ''}"
      data-mfg-type-filter="${escapeAttribute(value)}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderTypeCheckbox(type, label, currentType) {
  const isSelected = String(currentType || '') === type;
  return `
    <button
      type="button"
      class="manufacturingSpecCheck ${isSelected ? 'is-selected' : ''}"
      data-mfg-blueprint-type="${escapeAttribute(type)}"
      role="checkbox"
      aria-checked="${isSelected ? 'true' : 'false'}"
    >
      <span class="manufacturingSpecCheck__box">${isSelected ? icon('check') : ''}</span>
      <strong>${escapeHtml(label)}</strong>
    </button>
  `;
}

function renderLookupField({ field, value, placeholder, options = [] }) {
  const textValue = String(value || '');
  const inputAttr = field === 'unit' ? 'data-mfg-blueprint-unit' : 'data-mfg-blueprint-category';

  return `
    <div class="manufacturingLookupField">
      <input
        type="text"
        value="${escapeAttribute(textValue)}"
        placeholder="${escapeAttribute(placeholder || '')}"
        ${inputAttr}
        data-focus-key="mfg-blueprint-${escapeAttribute(field)}"
      />
      <button
        type="button"
        class="manufacturingLookupFieldAction"
        data-mfg-open-lookup="${escapeAttribute(field)}"
        aria-label="Browse ${escapeAttribute(field === 'unit' ? 'UOM' : 'category')}"
        title="Browse ${escapeAttribute(field === 'unit' ? 'UOM' : 'category')}"
      >
        ${icon('search')}
      </button>
    </div>
  `;
}

function renderLookupPickerModal(draft, picker = {}, categories = [], uoms = []) {
  const field = picker.field === 'unit' ? 'unit' : 'category';
  const rawQuery = String(picker.query || '').trim();
  const query = normalizeLookupOption(rawQuery);
  const optionList = field === 'unit'
    ? getUnitSelectOptions(uoms)
    : getCategorySelectOptions(categories);
  const exactMatch = Boolean(query) && optionList.some((option) => normalizeLookupOption(option) === query);
  const options = optionList
    .filter(Boolean)
    .filter((option) => !query || normalizeLookupOption(option).includes(query))
    .map((option) => ({ name: option }));
  const newLabel = field === 'unit' ? 'New UOM' : 'New Category';

  return `
    <div class="manufacturingModalBackdrop manufacturingModalBackdrop--stacked" role="presentation">
      <section class="manufacturingPickerModal manufacturingPickerModal--lookup" role="dialog" aria-modal="true" aria-labelledby="mfg-lookup-picker-title">
        <header class="manufacturingPanelHead">
          <div>
            <strong id="mfg-lookup-picker-title">${field === 'unit' ? 'Select Unit of Measure' : 'Select Category'}</strong>
            <span>${field === 'unit' ? 'Use the shared stock UOM list' : 'Use the shared stock category list'}</span>
          </div>
          <button type="button" class="manufacturingIconButton" data-mfg-lookup-picker-close aria-label="Close picker">${icon('x')}</button>
        </header>
        <label class="manufacturingField">
          <span>Search</span>
          <input
            type="search"
            value="${escapeAttribute(picker.query || '')}"
            placeholder="Filter ${field === 'unit' ? 'UOMs' : 'categories'}..."
            data-mfg-lookup-picker-search
            data-focus-key="mfg-lookup-picker-search"
          />
        </label>
        <div class="manufacturingLookupPickerList">
          ${rawQuery && !exactMatch ? `
            <button
              type="button"
              class="manufacturingLookupPickerRow manufacturingLookupPickerRow--new"
              data-mfg-lookup-picker-use="${escapeAttribute(rawQuery)}"
              data-mfg-lookup-picker-field="${escapeAttribute(field)}"
            >
              <div>
                <strong>${escapeHtml(rawQuery)}</strong>
                <span>${escapeHtml(newLabel)} - created when you save the manufactured item</span>
              </div>
              <em>${icon('plus')} New</em>
            </button>
          ` : ''}
          ${options.map((entry) => `
            <button
              type="button"
              class="manufacturingLookupPickerRow"
              data-mfg-lookup-picker-use="${escapeAttribute(entry.name)}"
              data-mfg-lookup-picker-field="${escapeAttribute(field)}"
            >
              <div><strong>${escapeHtml(entry.name)}</strong></div>
              <span>Use</span>
            </button>
          `).join('') || '<div class="manufacturingEmpty manufacturingEmpty--compact">No matching entries found.</div>'}
        </div>
      </section>
    </div>
  `;
}

function renderBatchModal(draft, sites, locations, filters = {}) {
  const multiplier = Math.max(parseNumber(draft.batchMultiplier) || 1, 1);
  const expectedPerBatch = parseNumber(draft.expectedQty) || 0;
  const producedPerBatch = parseNumber(draft.producedQty) || 0;
  const totalExpected = expectedPerBatch * multiplier;
  const totalProduced = producedPerBatch * multiplier;
  const unit = String(draft.unit || 'ea').toLowerCase();
  const openDropdown = String(filters.openDropdown || '').trim();
  const siteOptions = (sites || []).map((site) => ({ value: site.id, label: site.name || site.code || site.id }));
  const siteId = draft.siteId || getSiteIdForLocation(locations || [], draft.locationId) || siteOptions[0]?.value || '';
  const scopedLocations = (locations || []).filter((location) => !siteId || String(location.siteId || '') === String(siteId));
  const varianceQty = totalProduced - totalExpected;
  const varianceValue = Math.abs(varianceQty) * (Number(draft.unitCost || 0) || 0);
  const varianceTone = varianceQty < 0 ? 'loss' : varianceQty > 0 ? 'gain' : 'neutral';
  const varianceLabel = varianceQty < 0
    ? 'Waste / Under Yield'
    : varianceQty > 0
      ? 'Over Yield'
      : 'On Target';
  const varianceCopy = varianceQty < 0
    ? `${formatNumber(Math.abs(varianceQty))} ${unit} short · ${formatCurrency(varianceValue)} impact`
    : varianceQty > 0
      ? `${formatNumber(varianceQty)} ${unit} above target · ${formatCurrency(varianceValue)} gain`
      : `Expected and actual batch output match exactly.`;

  const locationLabel = (locations || []).find((location) => String(location.id) === String(draft.locationId || ''))?.name
    || draft.locationName
    || 'Select location';
  const siteLabel = (sites || []).find((site) => String(site.id) === String(siteId || ''))?.name
    || draft.siteName
    || 'Select site';

  return `
    <div class="manufacturingModalBackdrop">
      <section class="manufacturingBatchModal">
        <header class="manufacturingBatchHead">
          <div>
            <h3>Record Production</h3>
            <span class="manufacturingBatchSubtitle">Deduct raw materials and update prepped stock for [${escapeHtml(draft.itemName || 'Manufactured Item')}].</span>
          </div>
          <button type="button" class="manufacturingIconButton" data-mfg-batch-close aria-label="Close">${icon('x')}</button>
        </header>

        <div class="manufacturingBatchGrid">
          <label class="manufacturingField manufacturingField--full">
            ${renderFieldHelpLabel('Number of Batches', 'Multiplier that scales the expected ingredient usage and finished output for this production run.')}
            <input type="text" inputmode="decimal" value="${escapeAttribute(String(draft.batchMultiplier ?? 1))}" data-mfg-batch-multiplier data-focus-key="mfg-batch-multiplier" />
          </label>

          <label class="manufacturingField">
            ${renderFieldHelpLabel(`Yield per Batch (${String(draft.unit || 'ea').toUpperCase()})`, 'Expected finished output for one standard batch before any over-yield or under-yield variance.')}
            <input type="text" inputmode="decimal" value="${escapeAttribute(String(draft.expectedQty ?? ''))}" data-mfg-batch-expected data-focus-key="mfg-batch-expected" />
          </label>
          <label class="manufacturingField">
            ${renderFieldHelpLabel(`Actual per Batch (${String(draft.unit || 'ea').toUpperCase()})`, 'Actual finished output achieved for each batch after production is complete.')}
            <input type="text" inputmode="decimal" value="${escapeAttribute(String(draft.producedQty ?? ''))}" data-mfg-batch-produced data-focus-key="mfg-batch-produced" />
          </label>

          ${siteOptions.length > 1 ? `
            <label class="manufacturingField">
              ${renderFieldHelpLabel('Location Group', 'Trading location group where this production run is being posted.')}
              <div
                class="manufacturingDropdown ${openDropdown === 'batch-site' ? 'manufacturingDropdown--open' : ''}"
                data-mfg-dropdown-root
              >
                <button
                  type="button"
                  class="manufacturingDropdownToggle"
                  data-mfg-dropdown-toggle="batch-site"
                  aria-expanded="${openDropdown === 'batch-site' ? 'true' : 'false'}"
                >
                  <span>${escapeHtml(siteLabel)}</span>
                  ${icon('chevronDown')}
                </button>
                <div class="manufacturingDropdownMenu" role="listbox" aria-label="Location Group">
                  ${siteOptions.map((site) => `
                    <button
                      type="button"
                      class="manufacturingDropdownOption ${String(siteId || '') === String(site.value) ? 'is-selected' : ''}"
                      data-mfg-dropdown-option
                      data-mfg-dropdown-action="batch-site"
                      data-mfg-dropdown-value="${escapeAttribute(site.value)}"
                      data-mfg-dropdown-label="${escapeAttribute(site.label)}"
                    >
                      ${escapeHtml(site.label)}
                    </button>
                  `).join('')}
                </div>
              </div>
            </label>
          ` : ''}

          <label class="manufacturingField">
            ${renderFieldHelpLabel('Location', 'Selling location that receives the finished manufactured stock.')}
            <div
              class="manufacturingDropdown ${openDropdown === 'batch-location' ? 'manufacturingDropdown--open' : ''}"
              data-mfg-dropdown-root
            >
              <button
                type="button"
                class="manufacturingDropdownToggle"
                data-mfg-dropdown-toggle="batch-location"
                aria-expanded="${openDropdown === 'batch-location' ? 'true' : 'false'}"
              >
                <span>${escapeHtml(locationLabel)}</span>
                ${icon('chevronDown')}
              </button>
              <div class="manufacturingDropdownMenu" role="listbox" aria-label="Stock location">
                ${scopedLocations.length ? scopedLocations.map((location) => `
                  <button
                    type="button"
                    class="manufacturingDropdownOption ${String(draft.locationId || '') === String(location.id) ? 'is-selected' : ''}"
                    data-mfg-dropdown-option
                    data-mfg-dropdown-action="batch-location"
                    data-mfg-dropdown-value="${escapeAttribute(location.id)}"
                    data-mfg-dropdown-label="${escapeAttribute(location.name)}"
                  >
                    ${escapeHtml(location.name)}
                  </button>
                `).join('') : '<div class="manufacturingDropdownEmpty">No locations available.</div>'}
              </div>
            </div>
          </label>
        </div>

        <div class="manufacturingBatchFeedback">
          <div class="manufacturingBatchStat">
            <label>Total Expected Output</label>
            <strong>${formatNumber(totalExpected)} ${escapeHtml(unit)}</strong>
          </div>
          <div class="manufacturingBatchStat">
            <label>Total Produced Output</label>
            <strong>${formatNumber(totalProduced)} ${escapeHtml(unit)}</strong>
          </div>
          <div class="manufacturingBatchVariance manufacturingBatchVariance--${varianceTone}">
            <label>${escapeHtml(varianceLabel)}</label>
            <strong>${varianceQty === 0 ? formatCurrency(0) : formatCurrency(varianceValue)}</strong>
            <span>${escapeHtml(varianceCopy)}</span>
          </div>
        </div>

        <footer class="manufacturingModalActions manufacturingBatchActions">
          <button type="button" class="manufacturingGhostButton" data-mfg-batch-close>Abort</button>
          <button type="button" class="manufacturingPrimaryButton" data-mfg-batch-save ${draft.locationId ? '' : 'disabled'}>Post Batch</button>
        </footer>
      </section>
    </div>
  `;
}

function renderNotice(message, tone) {
  return `<div class="manufacturingNotice manufacturingNotice--${tone}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="manufacturingToast manufacturingToast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-mfg-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function getSiteIdForLocation(locations = [], locationId = '') {
  return String((locations || []).find((location) => String(location.id) === String(locationId))?.siteId || '');
}

function getProductionItemType(item = {}) {
  const explicit = String(item.itemType || item.stockItemType || item.specificationType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const category = String(item.category || '').toLowerCase();
  if (
    ['sub_recipe', 'subrecipe', 'sub_recipe_item'].includes(explicit) ||
    item.isSubRecipe === true ||
    category.includes('sub recipe') ||
    category.includes('sub-recipe')
  ) return 'sub_recipe';
  if (
    ['manufactured', 'prep', 'prepared', 'manufactured_item'].includes(explicit) ||
    item.isManufactured === true ||
    category.includes('manufactured')
  ) {
    return 'manufactured';
  }
  return 'standard';
}

function normalizeRecipeLines(value) {
  return Array.isArray(value) ? value : Object.values(value || {});
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0) || 0).replace('ZAR', 'R').trim();
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: Number.isInteger(Number(value || 0)) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0) || 0);
}

function parseNumber(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCategorySelectOptions(categories = [], currentCategory = '') {
  return [...new Set([
    ...categories,
    String(currentCategory || '').trim()
  ].map(normalizeCategoryOptionLabel).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function formatManufacturedCategoryLabel(value = '') {
  const raw = String(value || '').trim();
  const bracketMatch = raw.match(/^(.+?)\s+\(([^)]+)\)\s+-\s+Manufactured$/i);
  if (bracketMatch) return `${bracketMatch[1].trim()} - ${bracketMatch[2].trim()} - Manufactured`;
  return raw;
}

function normalizeCategoryOptionLabel(value = '') {
  const displayValue = formatManufacturedCategoryLabel(value);
  const stripped = displayValue.replace(' - Raw Materials', '').replace(' - Manufactured', '').trim();
  const hyphenParts = displayValue.toLowerCase().includes('manufactured')
    ? stripped.split(/\s+-\s+/).filter(Boolean)
    : [];
  return hyphenParts.length > 1 ? hyphenParts.at(-1).trim() : stripped;
}

function getUnitSelectOptions(units = [], currentUnit = '') {
  return [...new Set([
    ...units,
    String(currentUnit || '').trim()
  ].map((unit) => String(unit || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function normalizeLookupOption(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
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
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>',
    factory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V8l7 4V8l7 4V5l4 2v14"/><path d="M3 21h18"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 10v6"/><path d="M12 7.5h.01"/></svg>'
  };
  return icons[name] || '';
}
