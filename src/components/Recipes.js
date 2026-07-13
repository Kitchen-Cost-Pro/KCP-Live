import '../styles/recipes.css';
import { renderLoadingPanel } from './LoadingPanel.js';
import { matchesBarcodeQuery } from '../utils/barcodes.js';
import { resolveRecipeIngredientUnitCost } from '../utils/stockCostResolver.js';

let lastFocusedRecipeModalRequest = '';
let _uomDocumentCloseHandler = null;


function getAccessibleSellingLocationOptions(locations = [], access = {}) {
  const active = (locations || []).filter((location) => location?.active !== false);
  const selling = (active.length ? active : locations).filter((location) => {
    const type = String(location.kind || location.type || location.locationType || 'selling').trim().toLowerCase();
    return type === 'selling' || type === 'sale' || type === 'sales' || type === '';
  });
  const base = selling.length ? selling : active.length ? active : locations;
  const filtered = filterLocationsByAccess(base, access);
  return [...(filtered.length ? filtered : base)]
    .map((location) => ({
      value: String(location.id || location.locationId || '').trim(),
      label: String(location.displayName || location.name || location.locationName || location.id || '').trim()
    }))
    .filter((option) => option.value)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function filterLocationsByAccess(locations = [], access = {}) {
  if (access.currentIsSuperUser === true || access.currentIsKcpSuperUser === true) return locations;
  let filtered = locations;
  const roleLocations = access.roleDefinition?.locations || access.currentRoleDefinition?.locations || [];
  if (Array.isArray(roleLocations) && roleLocations.length && !roleLocations.includes('all')) {
    const allowed = new Set(roleLocations.map(normalizeLocationKey).filter(Boolean));
    const next = filtered.filter((location) => locationMatchesLocationKeys(location, allowed));
    filtered = next.length ? next : filtered;
  }
  const userLocations = Array.isArray(access.currentUserLocations) ? access.currentUserLocations : [];
  if (userLocations.length) {
    const allowed = new Set(userLocations.map(normalizeLocationKey).filter(Boolean));
    const next = filtered.filter((location) => locationMatchesLocationKeys(location, allowed));
    filtered = next.length ? next : filtered;
  }
  return filtered;
}

function locationMatchesLocationKeys(location = {}, keys = new Set()) {
  if (!keys.size) return true;
  return [location.id, location.locationId, location.name, location.displayName, location.locationName]
    .map(normalizeLocationKey)
    .filter(Boolean)
    .some((value) => keys.has(value));
}

function normalizeLocationKey(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function resolveActiveLocationId(locationId = '', options = []) {
  const value = String(locationId || '').trim();
  if (value && options.some((option) => option.value === value)) return value;
  return String(options[0]?.value || '');
}

function applyRecipeLocationPrice(item = {}, locationId = '', locationOptions = []) {
  const entry = locationId ? item.locationPrices?.[locationId] : null;
  const locationPrice = Number(entry?.sellingPrice ?? entry?.price ?? item.sellingPrice ?? item.price ?? 0) || 0;
  const locationName = locationOptions.find((option) => option.value === locationId)?.label || '';
  return {
    ...item,
    globalSellingPrice: Number(item.sellingPrice ?? item.price ?? 0) || 0,
    sellingPrice: locationPrice,
    price: locationPrice,
    activeLocationId: locationId,
    activeLocationName: locationName,
    locationPriceSource: entry ? 'location' : 'global'
  };
}

function renderUomDropdown({ options, selected, attr, attrValue }) {
  const current = options.find((o) => o.value === selected) || options[0];
  return `
    <div class="uomDropdown" data-uom-dropdown>
      <button type="button" class="uomDropdown__trigger" data-uom-trigger data-uom-attr="${escapeAttribute(attr)}" data-uom-key="${escapeAttribute(attrValue)}">
        <span class="uomDropdown__label">${escapeHtml(current?.label || String(selected || '').toUpperCase())}</span>
        <svg class="uomDropdown__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><polyline points="4 10 8 6 12 10"/></svg>
      </button>
      <div class="uomDropdown__menu" role="listbox">
        ${options.map((opt) => `
          <button type="button" class="uomDropdown__option${opt.value === selected ? ' is-selected' : ''}" role="option" aria-selected="${opt.value === selected}" data-uom-option="${escapeAttribute(opt.value)}" data-uom-attr="${escapeAttribute(attr)}" data-uom-key="${escapeAttribute(attrValue)}">
            ${escapeHtml(opt.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

export function renderRecipes({ state, onRecipeFilterChange, onRecipeAction = {} } = {}) {
  const recipes = state.recipes || {};
  const filters = {
    query: '',
    category: '',
    recipeView: 'products',
    ingredientQuery: '',
    ingredientCategory: '',
    ingredientType: '',
    locationId: '',
    openDropdown: '',
    categoryDropdownSearch: '',
    ingredientCategoryDropdownSearch: '',
    locationIdDropdownSearch: '',
    ...(recipes.filters || {})
  };
  filters.recipeView = 'products';
  const locationOptions = getAccessibleSellingLocationOptions(recipes.locations || [], state.access || {});
  const activeLocationId = resolveActiveLocationId(filters.locationId, locationOptions);
  const activeLocationName = locationOptions.find((option) => option.value === activeLocationId)?.label || '';
  const allItems = (recipes.items || [])
    .filter((item) => !isModifierRecipeItem(item))
    .map((item) => applyRecipeLocationPrice(item, activeLocationId, locationOptions));
  const items = filterRecipeItems(allItems, filters);
  const selectedIds = new Set((recipes.selectedIds || []).map(String));
  const selectedCount = selectedIds.size;
  const selectedItem = recipes.editingItem
    ? allItems.find((item) => String(item.id) === String(recipes.editingItem.id)) || applyRecipeLocationPrice(recipes.editingItem, activeLocationId, locationOptions)
    : null;
  const displayRecipes = { ...recipes, items: allItems, activeLocationId, activeLocationName };
  const draftRecipe = recipes.draftRecipe || selectedItem?.recipe || [];
  const categories = getCategories(allItems);
  const categoryOptions = [
    { value: '', label: 'All Categories' },
    ...categories.map((category) => ({ value: category, label: category }))
  ];
  const view = document.createElement('section');
  view.className = 'recipesModule';

  view.innerHTML = `
    <header class="recipesModule__header">
      <div>
        <p class="recipesModule__eyebrow">Operations</p>
        <h1>Recipes</h1>
        <p>Recipe blueprints are stored on menu items and costed against live stock items.</p>
      </div>
      <div class="recipesModule__actions">
        <input type="file" accept=".csv,.xlsx,.xls,text/csv" hidden data-recipe-import-input />
        ${renderActionDropdown(filters.openDropdown, recipes.actionStatus)}
        ${selectedCount ? renderInlineBulkDelete([...selectedIds], recipes.actionStatus) : ''}
      </div>
    </header>

    <section class="recipesModule__controls" aria-label="Recipe filters">
      <label>
        <span>Search Menu Items</span>
        <div class="recipesModule__searchShell">
          <input type="search" value="${escapeAttribute(filters.query)}" placeholder="Search products..." data-recipe-filter="query" />
          <button type="button" data-recipe-scan-barcode="recipe" aria-label="Scan recipe barcode" title="Scan recipe barcode">
            ${icon('camera')}
          </button>
        </div>
      </label>
      ${renderDropdown({
        id: 'category',
        label: 'Category',
        value: filters.category,
        searchValue: filters.categoryDropdownSearch,
        openDropdown: filters.openDropdown,
        options: categoryOptions
      })}
      ${locationOptions.length ? renderDropdown({
        id: 'locationId',
        label: 'Selling Location',
        value: activeLocationId,
        searchValue: filters.locationIdDropdownSearch,
        openDropdown: filters.openDropdown,
        options: locationOptions
      }) : ''}
    </section>

    ${recipes.actionError && !selectedItem && !recipes.confirmDelete ? renderNotice(recipes.actionError, 'error') : ''}
    ${renderRecipeBody(displayRecipes, items, selectedIds, 'products')}
    ${selectedItem ? renderRecipeModal(selectedItem, draftRecipe, displayRecipes, filters) : ''}
    ${selectedItem && recipes.pickerOpen ? renderRecipePickerModal(draftRecipe, displayRecipes, filters) : ''}
    ${renderDeleteDialog(recipes)}
    ${filters.exportPlatformPicker?.open ? `
    <div id="recipe-platform-picker" class="manufacturingModalBackdrop" style="display:flex;align-items:center;justify-content:center;z-index:1100;">
      <div class="manufacturingPickerModal" style="max-width:420px;width:100%;padding:2rem;text-align:center;">
        <h3 style="margin:0 0 0.5rem;font-size:1.15rem;font-weight:600;">Choose Export Platform</h3>
        <p style="margin:0 0 1.5rem;color:var(--color-text-muted,#6b7280);font-size:0.9rem;">Select where you'll use this import template so the correct formula format is applied.</p>
        <div style="display:flex;gap:1rem;justify-content:center;margin-bottom:1.25rem;">
          <button type="button" class="manufacturingGhostButton" data-recipe-platform="sheets"
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
          <button type="button" class="manufacturingPrimaryButton" data-recipe-platform="excel"
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
        <button type="button" class="manufacturingGhostButton" data-recipe-platform-cancel style="font-size:0.85rem;padding:0.4rem 1rem;">Cancel</button>
      </div>
    </div>
    ` : ''}
    ${renderToast(recipes.toast)}
  `;

  bindRecipeEvents(view, items, filters, onRecipeFilterChange, onRecipeAction);
  queueMicrotask(() => applyPendingFocus(view, recipes.pendingFocus));
  queueMicrotask(() => applyRecipeModalFocus(view, recipes));
  return view;
}

function bindRecipeEvents(view, visibleItems, filters, onRecipeFilterChange, onRecipeAction) {
  view.querySelectorAll('[data-recipe-filter]').forEach((field) => {
    field.addEventListener('input', () => onRecipeFilterChange?.({ [field.dataset.recipeFilter]: field.value }));
    field.addEventListener('change', () => onRecipeFilterChange?.({ [field.dataset.recipeFilter]: field.value }));
  });

  view.querySelectorAll('[data-recipe-ingredient-type]').forEach((button) => {
    button.addEventListener('click', () => {
      onRecipeFilterChange?.({ ingredientType: button.dataset.recipeIngredientType || '' });
    });
  });

  view.querySelectorAll('[data-recipe-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onRecipeFilterChange?.({
        recipeView: button.dataset.recipeView || 'products',
        category: '',
        categoryDropdownSearch: '',
        query: ''
      });
    });
  });

  view.querySelectorAll('[data-recipe-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.recipeDropdown;
      onRecipeFilterChange?.({ openDropdown: filters.openDropdown === id ? '' : id });
    });
  });

  view.addEventListener('click', (event) => {
    if (!filters.openDropdown || event.target.closest('[data-recipe-dropdown-root]')) return;
    onRecipeFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-recipe-dropdown-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const query = String(event.target.value || '').trim().toLowerCase();
      input.closest('.recipesModule__dropdownMenu')?.querySelectorAll('[data-recipe-option]').forEach((button) => {
        const isResetOption = !button.dataset.recipeOptionValue;
        const label = String(button.textContent || '').toLowerCase();
        button.hidden = !isResetOption && Boolean(query) && !label.includes(query);
      });
    });
  });

  view.querySelectorAll('[data-recipe-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onRecipeFilterChange?.({
        [button.dataset.recipeOptionGroup]: button.dataset.recipeOptionValue,
        [button.dataset.recipeOptionSearchKey]: '',
        openDropdown: ''
      });
    });
  });

  const importInput = view.querySelector('[data-recipe-import-input]');
  view.querySelector('[data-recipe-import-trigger]')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) onRecipeAction.onImport?.(file);
    event.target.value = '';
  });

  view.querySelectorAll('[data-recipe-export]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.recipeExport === 'template-xlsx') {
        onRecipeFilterChange?.({ exportPlatformPicker: { open: true } });
      } else {
        onRecipeAction.onExport?.(button.dataset.recipeExport);
      }
    });
  });
  view.querySelectorAll('[data-recipe-platform]').forEach((button) => {
    button.addEventListener('click', () => {
      onRecipeAction.onExport?.('template-xlsx:' + button.dataset.recipePlatform);
      onRecipeFilterChange?.({ exportPlatformPicker: null });
    });
  });
  view.querySelector('[data-recipe-platform-cancel]')?.addEventListener('click', () => {
    onRecipeFilterChange?.({ exportPlatformPicker: null });
  });
  view.querySelectorAll('[data-recipe-scan-barcode]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRecipeAction.onScanBarcode?.(button.dataset.recipeScanBarcode || 'ingredient');
    });
  });

  view.querySelector('[data-recipe-delete-selected]')?.addEventListener('click', () => {
    const rawIds = view.querySelector('[data-recipe-delete-selected]')?.dataset.recipeDeleteSelected || '[]';
    onRecipeAction.onRequestDelete?.({ ids: parseDatasetJson(rawIds), mode: 'bulk' });
  });

  view.querySelectorAll('[data-recipe-card-open]').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('button, input, label, a')) return;
      onRecipeAction.onOpen?.(card.dataset.recipeCardOpen);
    });
    card.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      if (event.target.closest('button, input, label, a')) return;
      event.preventDefault();
      onRecipeAction.onOpen?.(card.dataset.recipeCardOpen);
    });
  });

  view.querySelectorAll('[data-recipe-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onRecipeAction.onSelect?.(checkbox.dataset.recipeSelect, checkbox.checked);
    });
  });

  view.querySelector('[data-recipe-select-all]')?.addEventListener('change', (event) => {
    onRecipeAction.onSelectAll?.(visibleItems.filter(canSelectRecipeItem).map((item) => item.id), event.target.checked);
  });

  view.querySelectorAll('[data-recipe-open]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onOpen?.(button.dataset.recipeOpen));
  });

  view.querySelectorAll('[data-recipe-close]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onClose?.());
  });

  view.querySelectorAll('[data-recipe-line-qty]').forEach((input) => {
    input.addEventListener('input', () => {
      if (input.disabled) return;
      onRecipeAction.onPreserveFocus?.(input);
      onRecipeAction.onLineChange?.(
        Number(input.dataset.recipeLineQty),
        input.value
      );
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      onRecipeAction.onFocusSearch?.();
    });
  });

  // Custom UOM dropdown — trigger toggles open/closed; option click fires change handler
  if (_uomDocumentCloseHandler) document.removeEventListener('click', _uomDocumentCloseHandler);
  _uomDocumentCloseHandler = (e) => {
    if (!e.target.closest('[data-uom-dropdown]')) {
      document.querySelectorAll('[data-uom-dropdown].is-open').forEach((d) => d.classList.remove('is-open'));
    }
  };
  document.addEventListener('click', _uomDocumentCloseHandler);

  view.querySelectorAll('[data-uom-trigger]').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = trigger.closest('[data-uom-dropdown]');
      const wasOpen = dropdown.classList.contains('is-open');
      document.querySelectorAll('[data-uom-dropdown].is-open').forEach((d) => d.classList.remove('is-open'));
      if (!wasOpen) {
        // Position menu with fixed coords so it escapes overflow:auto containers
        const menu = dropdown.querySelector('.uomDropdown__menu');
        const rect = trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < 160 && rect.top > 160) {
          // Not enough room below — open upward
          menu.style.top = 'auto';
          menu.style.bottom = `${window.innerHeight - rect.top + 5}px`;
        } else {
          menu.style.bottom = 'auto';
          menu.style.top = `${rect.bottom + 5}px`;
        }
        menu.style.left = `${rect.left}px`;
        dropdown.classList.add('is-open');
      }
    });
  });

  view.querySelectorAll('[data-uom-option]').forEach((option) => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = option.closest('[data-uom-dropdown]');
      dropdown?.classList.remove('is-open');
      const attr = option.dataset.uomAttr;
      const key = option.dataset.uomKey;
      const value = option.dataset.uomOption;
      if (attr === 'picker') {
        onRecipeAction.onPickerUomChange?.(key, value);
      } else if (attr === 'line') {
        onRecipeAction.onLineUomChange?.(Number(key), value);
      }
    });
  });

  view.querySelectorAll('[data-recipe-line-remove]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onLineRemove?.(Number(button.dataset.recipeLineRemove)));
  });
  view.querySelector('[data-recipe-line-remove-confirm]')?.addEventListener('click', () => {
    onRecipeAction.onLineRemoveConfirm?.();
  });
  view.querySelector('[data-recipe-line-remove-cancel]')?.addEventListener('click', () => {
    onRecipeAction.onLineRemoveCancel?.();
  });

  view.querySelector('[data-recipe-open-picker]')?.addEventListener('click', () => {
    onRecipeAction.onOpenPicker?.();
  });

  view.querySelector('[data-recipe-modifier-link]')?.addEventListener('change', (event) => {
    onRecipeAction.onModifierLinkChange?.(event.currentTarget.value);
  });
  view.querySelector('[data-recipe-modifier-link-toggle]')?.addEventListener('click', () => {
    onRecipeFilterChange?.({
      openDropdown: filters.openDropdown === 'modifierProductLink' ? '' : 'modifierProductLink'
    });
  });
  view.querySelector('[data-recipe-modifier-link-search]')?.addEventListener('input', (event) => {
    onRecipeFilterChange?.({ modifierProductLinkSearch: event.currentTarget.value, openDropdown: 'modifierProductLink' });
  });
  view.querySelectorAll('[data-recipe-modifier-product-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      onRecipeAction.onModifierLinkToggle?.(button.dataset.recipeModifierProductToggle || '');
    });
  });
	  view.querySelector('[data-recipe-modifier-link-clear]')?.addEventListener('click', () => {
	    onRecipeAction.onModifierLinkChange?.([]);
	  });

	  view.querySelector('[data-recipe-source-stock-toggle]')?.addEventListener('click', () => {
	    onRecipeFilterChange?.({
	      openDropdown: filters.openDropdown === 'recipeSourceStockItem' ? '' : 'recipeSourceStockItem'
	    });
	  });
	  view.querySelector('[data-recipe-source-stock-search]')?.addEventListener('input', (event) => {
	    onRecipeFilterChange?.({ recipeSourceStockSearch: event.currentTarget.value, openDropdown: 'recipeSourceStockItem' });
	  });
	  view.querySelectorAll('[data-recipe-source-stock-select]').forEach((button) => {
	    button.addEventListener('click', () => {
	      onRecipeAction.onRecipeSourceStockItemChange?.(button.dataset.recipeSourceStockSelect || '');
	    });
	  });
	  view.querySelector('[data-recipe-source-stock-clear]')?.addEventListener('click', () => {
	    onRecipeAction.onRecipeSourceStockItemChange?.('');
	  });

  view.querySelectorAll('[data-recipe-picker-close]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onClosePicker?.());
  });

  view.querySelectorAll('[data-recipe-picker-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onRecipeAction.onPickerToggle?.(checkbox.dataset.recipePickerToggle, checkbox.checked);
    });
  });

  view.querySelector('[data-recipe-picker-select-visible]')?.addEventListener('click', () => {
    const ids = [...view.querySelectorAll('[data-recipe-picker-toggle]')].map((input) => input.dataset.recipePickerToggle);
    onRecipeAction.onPickerSelectAll?.(ids);
  });

  view.querySelector('[data-recipe-picker-clear]')?.addEventListener('click', () => {
    onRecipeAction.onPickerClear?.();
  });

  view.querySelector('[data-recipe-picker-confirm]')?.addEventListener('click', () => {
    onRecipeAction.onPickerConfirm?.();
  });

  view.querySelector('[data-recipe-picker-back]')?.addEventListener('click', () => {
    onRecipeAction.onPickerBack?.();
  });

  view.querySelectorAll('[data-recipe-picker-qty]').forEach((input) => {
    input.addEventListener('input', () => {
      onRecipeAction.onPreserveFocus?.(input);
      onRecipeAction.onPickerQtyChange?.(input.dataset.recipePickerQty, input.value);
    });
  });

  view.querySelector('[data-recipe-picker-apply]')?.addEventListener('click', () => {
    onRecipeAction.onPickerApply?.();
  });

  view.querySelector('[data-recipe-save]')?.addEventListener('click', () => {
    onRecipeAction.onSave?.();
  });

  view.querySelector('[data-recipe-confirm-delete]')?.addEventListener('click', () => {
    onRecipeAction.onConfirmDelete?.();
  });

  view.querySelector('[data-recipe-cancel-delete]')?.addEventListener('click', () => {
    onRecipeAction.onCancelDelete?.();
  });

  view.querySelector('[data-recipe-toast-close]')?.addEventListener('click', () => {
    onRecipeAction.onDismissToast?.();
  });
}

function renderRecipeBody(recipes, items, selectedIds, recipeView = 'products') {
  if (recipes.status === 'loading') {
    return renderLoadingPanel('Loading recipes', 'Fetching recipe lines, stock items, menu links, and completion status.');
  }

  if (recipes.status === 'error') {
    return renderNotice(recipes.error || 'Could not load recipes.', 'error');
  }

  if (!items.length) {
    return renderNotice('No matching recipe items found.', 'empty');
  }

  const selectableItems = items.filter(canSelectRecipeItem);
  const allSelected = selectableItems.length > 0 && selectableItems.every((item) => selectedIds.has(String(item.id)));
  const isModifierView = recipeView === 'modifiers';
  return `
    <div class="recipesModule__list">
      <div class="recipesModule__listHead recipe-grid-row">
        <label class="recipesModule__checkbox" aria-label="Select all visible recipes">
          <input type="checkbox" data-recipe-select-all ${allSelected ? 'checked' : ''} />
          <span></span>
        </label>
        <span>Product Name</span>
        <span>SKU</span>
        <span>Category</span>
        ${isModifierView ? '<span>Linked Product</span>' : ''}
        <span>Selling</span>
        <span>Theoretical Cost</span>
        <span>GP / Status</span>
        <span>Action</span>
      </div>
      ${items.map((item) => renderRecipeRow(item, recipes.ingredients || [], selectedIds.has(String(item.id)), isModifierView, recipes.activeLocationId || '')).join('')}
    </div>
  `;
}

function renderRecipeRow(item, ingredients, isSelected, showLinkedProduct = false, activeLocationId = '') {
  const effectiveRecipe = getEffectiveRecipeForDisplay(item);
  const recipeCost = calculateRecipeCost(effectiveRecipe, ingredients, activeLocationId);
  const gp = item.sellingPrice > 0 ? ((item.sellingPrice - recipeCost) / item.sellingPrice) * 100 : 0;
  const isModifier = isModifierRecipeItem(item);
  const linkedProduct = getModifierLinkedProductDisplay(item);
  const isModifierLinked = isModifier && isModifierProductLinked(item);
  const statusLabel = getRecipeStatusLabel(item);
  const statusClass = item.status === 'complete' ? 'complete' : 'missing';
  const linkedStockItemName = String(item.recipeSourceStockItemName || item.recipeSourceStockItem?.name || '').trim();
  const sourceDetail = linkedStockItemName && !isModifier
    ? `${recipeSourceDetail(item)} · ${linkedStockItemName}`
    : recipeSourceDetail(item);
  const legacyStatusLabel = item.status === 'complete'
    ? isModifier && item.recipeSource === 'linked_product'
      ? 'Linked Product Recipe'
      : 'Recipe Assigned'
    : 'Missing Recipe';

  return `
    <article class="recipesModule__row recipe-grid-row ${isSelected ? 'is-selected' : ''}" data-recipe-card-open="${escapeAttribute(item.id)}" tabindex="0" aria-label="Open recipe architect for ${escapeAttribute(item.name)}">
      <label class="recipesModule__checkbox" aria-label="Select ${escapeAttribute(item.name)}">
        <input type="checkbox" data-recipe-select="${escapeAttribute(item.id)}" ${isSelected ? 'checked' : ''} ${canSelectRecipeItem(item) ? '' : 'disabled'} />
        <span></span>
      </label>
      <div class="recipesModule__identity">
        <div class="recipesModule__rowIcon">${icon(isModifier ? 'sliders' : 'utensils')}</div>
        <div class="recipesModule__nameCell">
	          <h2>${escapeHtml(item.name)}</h2>
	          <p>${escapeHtml(sourceDetail)}</p>
	        </div>
	      </div>
      <span class="recipesModule__sku">${escapeHtml(getRecipeSkuDisplay(item))}</span>
      <span class="recipesModule__categoryPill">${escapeHtml(item.category || 'Standard')}</span>
      ${showLinkedProduct ? `
        <div class="recipesModule__linkedProductCell recipesModule__linkedProductCell--${escapeAttribute(linkedProduct.tone)}" title="${escapeAttribute(linkedProduct.title)}">
          <span>${escapeHtml(linkedProduct.label)}</span>
          <strong>${escapeHtml(linkedProduct.value)}</strong>
        </div>
      ` : ''}
      <div class="recipesModule__metric recipesModule__metricCell">
        <span>Selling</span>
        <strong>${formatCurrency(item.sellingPrice)}</strong>
      </div>
      <div class="recipesModule__metric recipesModule__metricCell">
	        <span>Theoretical Cost</span>
	        <strong>${formatCurrency(recipeCost)}</strong>
	      </div>
      <div class="recipesModule__statusCell">
        <div class="recipesModule__metric">
          <span>GP</span>
          ${renderGpBadge(gp)}
        </div>
	        ${isModifierLinked ? '<em class="recipesModule__status recipesModule__status--linked">Linked</em>' : ''}
	        <em class="recipesModule__status recipesModule__status--${statusClass}">
	          ${escapeHtml(statusLabel || legacyStatusLabel)}
	        </em>
	      </div>
      <button type="button" data-recipe-open="${escapeAttribute(item.id)}" aria-label="Open recipe">${icon('arrow')}</button>
    </article>
  `;
}

function renderRecipeModal(item, draftRecipe, recipes, filters) {
  const ingredients = recipes.ingredients || [];
  const linkedProductMode = isModifierRecipeItem(item) && getLinkedProductIds(item).length > 0 && item.recipeSource === 'linked_product';
  const linkedStockItemMode = !isModifierRecipeItem(item) && !normalizeRecipeLinesForDisplay(draftRecipe).length && getRecipeSourceRecipeLines(item).length > 0;
  const displayRecipe = linkedStockItemMode ? getRecipeSourceRecipeLines(item) : draftRecipe;
  const totalCost = calculateRecipeCost(displayRecipe, ingredients, recipes.activeLocationId || '');
  const gp = item.sellingPrice > 0 ? ((item.sellingPrice - totalCost) / item.sellingPrice) * 100 : 0;
  const combinedBreakdown = buildCombinedModifierBreakdown(item, displayRecipe, recipes, ingredients, totalCost, recipes.activeLocationId || '');
  const isModifier = isModifierRecipeItem(item);
  const showModifierPanel = !isModifier && combinedBreakdown.hasModifierContext;

  return `
    <div class="recipesModule__modalBackdrop" role="presentation">
      <section class="recipesModule__modal" role="dialog" aria-modal="true" aria-labelledby="recipe-modal-title" tabindex="-1" data-recipe-modal-dialog>
        <header class="recipesModule__modalHeader">
          <div>
            <p>${isModifier ? 'Modifier Recipe Blueprint' : 'Menu Recipe Blueprint'}</p>
            <h2 id="recipe-modal-title">${escapeHtml(item.name)}</h2>
            <span>${escapeHtml(recipeSourceDetail(item))}</span>
          </div>
          <button type="button" class="recipesModule__iconButton" data-recipe-close aria-label="Close recipe">${icon('x')}</button>
        </header>

	        ${renderRecipeSummaryCards(item, totalCost, gp, combinedBreakdown, { isModifier })}

	        ${isModifier ? renderModifierProductLinkPanel(item, recipes.items || [], filters) : ''}

	        <div class="recipesModule__blueprintGrid ${showModifierPanel ? '' : 'recipesModule__blueprintGrid--single'}">
	          ${renderBaseIngredientPanel(displayRecipe, ingredients, { linkedProductMode, linkedStockItemMode, recipeSourceStockItemName: item.recipeSourceStockItemName || item.recipeSourceStockItem?.name || '', activeLocationId: recipes.activeLocationId || '' })}
	          ${showModifierPanel ? renderModifierCostBreakdown(combinedBreakdown) : ''}
	        </div>

        ${showModifierPanel ? renderCombinedRecipeTotals(combinedBreakdown) : ''}

        ${recipes.actionError ? `<div class="recipesModule__inlineError" role="alert">${escapeHtml(recipes.actionError)}</div>` : ''}
        ${renderLineRemovalConfirm(recipes.confirmLineRemoval)}

        <footer class="recipesModule__modalFooter">
	          ${linkedProductMode ? `
	            <div class="recipesModule__linkedRecipeNote">Recipe is inherited from ${escapeHtml(getLinkedProductNames(item).join(', ') || 'the linked menu product')}.</div>
	          ` : `
	            <button type="button" class="recipesModule__addIngredient" data-recipe-open-picker>
	              ${icon('plus')}
	              <span>Add Ingredient</span>
	            </button>
	          `}
          <button type="button" data-recipe-close>Cancel</button>
          <button type="button" class="recipesModule__primary" data-recipe-save ${recipes.actionStatus === 'saving' ? 'disabled' : ''}>
            ${icon('check')}
            <span>${recipes.actionStatus === 'saving' ? 'Saving' : linkedProductMode ? 'Save Link' : 'Save Recipe'}</span>
          </button>
        </footer>
      </section>
    </div>
  `;
}

function renderRecipeSummaryCards(item = {}, totalCost = 0, gp = 0, breakdown = {}, options = {}) {
  const isModifier = options.isModifier === true;
  const attachedGroups = breakdown.attachedGroups || [];
  const modifierRows = breakdown.modifierRows || [];
  const pendingGroups = breakdown.pendingGroups || [];
  const modifierSummary = isModifier
    ? getModifierLinkedProductDisplay(item).value
    : `${attachedGroups.length} group${attachedGroups.length === 1 ? '' : 's'} · ${modifierRows.length} linked option${modifierRows.length === 1 ? '' : 's'}`;
  return `
    <section class="recipesModule__summaryCards" aria-label="Recipe cost summary">
      <div class="recipesModule__summaryCard recipesModule__summaryCard--price">
        <span>${isModifier ? 'Modifier Selling' : 'Base Selling'} ${renderRecipeInfo('The selling price stored on this catalogue item.')}</span>
        <strong>${formatCurrency(item.sellingPrice || 0)}</strong>
      </div>
      <div class="recipesModule__summaryCard recipesModule__summaryCard--cost">
        <span>${isModifier ? 'Modifier Recipe Cost' : 'Base Ingredient Cost'} ${renderRecipeInfo('The calculated cost of the ingredient lines in this recipe.')}</span>
        <strong>${formatCurrency(totalCost)}</strong>
      </div>
      <div class="recipesModule__summaryCard recipesModule__summaryCard--gp">
        <span>${isModifier ? 'Modifier GP%' : 'Base GP%'} ${renderRecipeInfo('Gross profit percentage from selling price less recipe cost.')}</span>
        ${renderGpBadge(gp, 'recipesModule__gpBadge--large')}
      </div>
      ${(isModifier || attachedGroups.length > 0) ? `
      <div class="recipesModule__summaryCard recipesModule__summaryCard--mods">
        <span>${isModifier ? 'Recipe Source' : 'Attached Modifiers'} ${renderRecipeInfo(isModifier ? 'Whether this modifier uses its own recipe or a linked menu product recipe.' : 'Modifier groups/options attached to this menu item from the Yoco catalogue.')}</span>
        <strong>${escapeHtml(modifierSummary || 'No modifier groups')}</strong>
        ${!isModifier && pendingGroups.length ? `<em>${pendingGroups.length} group${pendingGroups.length === 1 ? '' : 's'} need recipe links</em>` : ''}
      </div>
      ` : ''}
    </section>
  `;
}

function renderBaseIngredientPanel(draftRecipe = [], ingredients = [], options = {}) {
  const linkedProductMode = options.linkedProductMode === true;
  const linkedStockItemMode = options.linkedStockItemMode === true;
  const isReadOnly = linkedProductMode || linkedStockItemMode;
  const title = linkedProductMode ? 'Linked Product Ingredients' : linkedStockItemMode ? 'Linked Stock Item Ingredients' : 'Base Ingredients';
  const info = linkedProductMode
    ? 'These ingredient lines are inherited from the linked menu product recipe.'
    : linkedStockItemMode
      ? 'These ingredient lines are inherited from the linked non-stock item.'
      : 'These are the stock items deducted when this menu item is sold before modifiers are added.';
  return `
	    <section class="recipesModule__lines recipesModule__blueprintPanel recipesModule__blueprintPanel--ingredients" aria-label="Base recipe ingredients">
	      <div class="recipesModule__sectionTitle">
	        <span>${escapeHtml(title)} ${renderRecipeInfo(info)}</span>
	        <strong>${draftRecipe.length} line${draftRecipe.length === 1 ? '' : 's'}</strong>
	      </div>
      <div class="recipesModule__lineHead">
        <span>Ingredient / Stock Item</span>
        <span>Qty</span>
        <span>Ext. Cost</span>
        <span></span>
      </div>
      <div class="recipesModule__lineList">
	        ${draftRecipe.length ? draftRecipe.map((line, index) => renderRecipeLine(line, index, ingredients, { readOnly: isReadOnly, activeLocationId: options.activeLocationId || '' })).join('') : `
	          <div class="recipesModule__emptyLines">No base ingredients added to this recipe.</div>
	        `}
	      </div>
    </section>
  `;
}

function buildCombinedModifierBreakdown(item = {}, draftRecipe = [], recipes = {}, ingredients = [], baseCost = 0, activeLocationId = '') {
  const attachedGroups = normalizeAttachedModifierGroups(item);
  const allItems = recipes.items || [];
  const modifierRows = findAttachedModifierRows(item, recipes.items || [], attachedGroups)
    .map((modifier) => {
      const linkedProduct = findLinkedModifierProduct(modifier, allItems);
      const linkedProductRecipe = Array.isArray(linkedProduct?.recipe) ? linkedProduct.recipe : [];
      const modifierRecipe = Array.isArray(modifier.recipe) ? modifier.recipe : [];
      const usesLinkedProductRecipe = linkedProductRecipe.length > 0;
      const modifierCost = usesLinkedProductRecipe
        ? calculateRecipeCost(linkedProductRecipe, ingredients, activeLocationId)
        : calculateRecipeCost(modifierRecipe, ingredients, activeLocationId);
      const modifierPrice = Number(modifier.sellingPrice ?? modifier.price ?? 0) || 0;
      const combinedPrice = Number(item.sellingPrice || 0) + modifierPrice;
      const combinedCost = baseCost + modifierCost;
      const combinedGp = combinedPrice > 0 ? ((combinedPrice - combinedCost) / combinedPrice) * 100 : 0;
      return {
        ...modifier,
        costSourceProductName: usesLinkedProductRecipe ? linkedProduct.name : '',
        costSourceRecipeLines: usesLinkedProductRecipe ? linkedProductRecipe.length : modifierRecipe.length,
        costSourceType: usesLinkedProductRecipe ? 'linked_product' : modifierRecipe.length ? 'modifier_recipe' : 'missing',
        modifierCost,
        modifierPrice,
        combinedPrice,
        combinedCost,
        combinedGp
      };
    });
  const matchedGroupKeys = new Set(modifierRows.map((modifier) => normalizeKey(modifier.yocoModifierGroupId || modifier.yocoModifierGroupName || modifier.modifierGroup || modifier.category)));
  const pendingGroups = attachedGroups.filter((group) => {
    const idKey = normalizeKey(group.id);
    const nameKey = normalizeKey(group.name);
    return !modifierRows.some((modifier) => (
      normalizeKey(modifier.yocoModifierGroupId) === idKey ||
      normalizeKey(modifier.yocoModifierGroupName || modifier.modifierGroup || modifier.category) === nameKey ||
      matchedGroupKeys.has(idKey) ||
      matchedGroupKeys.has(nameKey)
    ));
  });
  const modifierCostAverage = average(modifierRows.map((modifier) => modifier.modifierCost));
  const modifierPriceAverage = average(modifierRows.map((modifier) => modifier.modifierPrice));
  const combinedCostAverage = baseCost + modifierCostAverage;
  const combinedPriceAverage = Number(item.sellingPrice || 0) + modifierPriceAverage;
  const combinedGpAverage = combinedPriceAverage > 0 ? ((combinedPriceAverage - combinedCostAverage) / combinedPriceAverage) * 100 : 0;

  return {
    item,
    baseCost,
    basePrice: Number(item.sellingPrice || 0) || 0,
    baseGp: Number(item.sellingPrice || 0) > 0 ? ((Number(item.sellingPrice || 0) - baseCost) / Number(item.sellingPrice || 0)) * 100 : 0,
    attachedGroups,
    modifierRows,
    pendingGroups,
    modifierCostAverage,
    modifierPriceAverage,
    combinedCostAverage,
    combinedPriceAverage,
    combinedGpAverage,
    combinedGpRange: formatGpRange(modifierRows.map((modifier) => modifier.combinedGp)),
    hasModifierContext: attachedGroups.length > 0 || modifierRows.length > 0
  };
}

function renderModifierCostBreakdown(breakdown = {}) {
  const rows = breakdown.modifierRows || [];
  const pendingGroups = breakdown.pendingGroups || [];
  const attachedGroups = breakdown.attachedGroups || [];
  return `
    <section class="recipesModule__modifierCostPanel recipesModule__blueprintPanel recipesModule__blueprintPanel--modifiers" aria-label="Attached modifier recipe impact">
      <div class="recipesModule__sectionTitle">
        <span>Attached Modifiers ${renderRecipeInfo('Shows modifier groups/options attached to this menu item and the recipe cost used when each modifier is selected.')}</span>
        <strong>${attachedGroups.length} group${attachedGroups.length === 1 ? '' : 's'}</strong>
      </div>
      <div class="recipesModule__modifierCostHead">
        <span>Modifier</span>
        <span>Modifier Cost</span>
        <span>Combined Cost</span>
        <span>Combined GP</span>
      </div>
      <div class="recipesModule__modifierCostList">
        ${rows.length ? rows.map(renderModifierCostRow).join('') : ''}
        ${pendingGroups.map(renderPendingModifierGroup).join('')}
        ${!rows.length && !pendingGroups.length ? '<div class="recipesModule__emptyLines">No modifier groups are attached to this menu item.</div>' : ''}
      </div>
    </section>
  `;
}

function renderModifierCostRow(modifier = {}) {
  const groupName = modifier.yocoModifierGroupName || modifier.modifierGroup || stripModifierCategory(modifier.category) || 'Modifier Group';
  const costSource = modifier.costSourceProductName
    ? `Uses ${modifier.costSourceProductName} recipe`
    : modifier.costSourceType === 'modifier_recipe'
      ? 'Uses manual modifier recipe'
      : 'Recipe link pending';
  return `
    <article class="recipesModule__modifierCostRow">
      <div>
        <strong>${escapeHtml(modifier.name || 'Modifier')}</strong>
        <span>${escapeHtml(groupName)} · ${formatCurrency(modifier.modifierPrice || 0)} selling · ${escapeHtml(costSource)}</span>
      </div>
      <strong>${formatCurrency(modifier.modifierCost || 0)}</strong>
      <strong>${formatCurrency(modifier.combinedCost || 0)}</strong>
      ${renderGpBadge(modifier.combinedGp || 0)}
    </article>
  `;
}

function renderPendingModifierGroup(group = {}) {
  return `
    <article class="recipesModule__modifierCostRow recipesModule__modifierCostRow--pending">
      <div>
        <strong>${escapeHtml(group.name || group.id || 'Modifier group')}</strong>
        <span>${Number(group.modifierCount || 0)} Yoco option${Number(group.modifierCount || 0) === 1 ? '' : 's'} attached · no recipe link yet</span>
      </div>
      <strong>Pending</strong>
      <strong>Pending</strong>
      <em>Link modifier recipe</em>
    </article>
  `;
}

function renderCombinedRecipeTotals(breakdown = {}) {
  const rows = breakdown.modifierRows || [];
  const gpLabel = rows.length > 1 && breakdown.combinedGpRange
    ? breakdown.combinedGpRange
    : `${Number(breakdown.combinedGpAverage || 0).toFixed(1)}%`;
  return `
    <section class="recipesModule__combinedTotals" aria-label="Combined recipe and modifier totals">
      <div>
        <span>Base Recipe Cost ${renderRecipeInfo('The ingredient cost of the menu item recipe before modifiers.', 'right')}</span>
        <strong>${formatCurrency(breakdown.baseCost || 0)}</strong>
      </div>
      <div>
        <span>Avg Modifier Cost ${renderRecipeInfo('Average recipe cost across the linked modifier options shown above.', 'right')}</span>
        <strong>${rows.length ? formatCurrency(breakdown.modifierCostAverage || 0) : 'Pending'}</strong>
      </div>
      <div>
        <span>Avg Combined Cost ${renderRecipeInfo('Base recipe cost plus the average linked modifier recipe cost.', 'right')}</span>
        <strong>${rows.length ? formatCurrency(breakdown.combinedCostAverage || 0) : 'Pending'}</strong>
      </div>
      <div>
        <span>Combined GP% ${renderRecipeInfo('Gross profit percentage after combining the menu item recipe with linked modifier option costs.', 'right')}</span>
        ${rows.length ? renderGpBadge(breakdown.combinedGpAverage || 0, 'recipesModule__gpBadge--large') : '<strong>Pending</strong>'}
        ${rows.length > 1 && breakdown.combinedGpRange ? `<em>${escapeHtml(gpLabel)} range</em>` : ''}
      </div>
    </section>
  `;
}

function isModifierRecipeItem(item = {}) {
  return item.recipeOwnerType === 'yoco_modifier' || String(item.id || '').startsWith('modifier:');
}

function canSelectRecipeItem(item = {}) {
  return Boolean(item?.id);
}

function normalizeRecipeLinesForDisplay(recipe = []) {
  const lines = Array.isArray(recipe) ? recipe : Object.values(recipe || {});
  return lines
    .map((line = {}) => ({
      ...line,
      ingId: String(line.ingId || line.stockItemId || line.stock_item_id || line.id || '').trim(),
      stockItemId: String(line.stockItemId || line.stock_item_id || line.ingId || line.id || '').trim(),
      qty: parseQtyNumber(line.qty ?? line.quantity ?? 0),
      quantity: parseQtyNumber(line.quantity ?? line.qty ?? 0),
      unit: String(line.unit || line.uom || 'ea').trim() || 'ea'
    }))
    .filter((line) => line.ingId && line.qty > 0);
}

function getRecipeSourceRecipeLines(item = {}) {
  return normalizeRecipeLinesForDisplay(
    item.recipeSourceRecipeLines ||
    item.recipe_source_recipe_lines ||
    item.recipeSourceStockItem?.recipeLines ||
    item.recipeSourceStockItem?.recipe ||
    []
  );
}

function getEffectiveRecipeForDisplay(item = {}) {
  const directRecipe = normalizeRecipeLinesForDisplay(item.recipe || item.recipeLines || []);
  if (directRecipe.length) return directRecipe;
  return normalizeRecipeLinesForDisplay(item.effectiveRecipe || item.effectiveRecipeLines || getRecipeSourceRecipeLines(item));
}

function getRecipeStatusLabel(item = {}) {
  if (item.recipeStatus === 'COMPLETE_VIA_LINKED_STOCK_ITEM' || item.recipeSource === 'linked_stock_item') {
    return 'Complete via linked stock item';
  }
  if (item.recipeStatus === 'COMPLETE' || item.status === 'complete') return 'Recipe Assigned';
  return 'Missing recipe';
}

function normalizeAttachedModifierGroups(item = {}) {
  const groups = Array.isArray(item.modifierGroups) ? item.modifierGroups : Array.isArray(item.yocoModifierGroups) ? item.yocoModifierGroups : [];
  return groups
    .map((group) => ({
      id: String(group?.id || group?.yocoModifierGroupId || '').trim(),
      name: String(group?.name || group?.displayName || group?.yocoModifierGroupName || group?.id || '').trim(),
      modifierCount: Number(group?.modifierCount || group?.optionCount || 0) || 0
    }))
    .filter((group) => group.id || group.name);
}

function findAttachedModifierRows(product = {}, items = [], attachedGroups = []) {
  const groupIds = new Set(attachedGroups.map((group) => normalizeKey(group.id)).filter(Boolean));
  const groupNames = new Set(attachedGroups.map((group) => normalizeKey(group.name)).filter(Boolean));
  if (!groupIds.size && !groupNames.size) return [];

  return (items || [])
    .filter(isModifierRecipeItem)
    .filter((modifier) => {
      const modifierGroupId = normalizeKey(modifier.yocoModifierGroupId);
      const modifierGroupName = normalizeKey(modifier.yocoModifierGroupName || modifier.modifierGroup || stripModifierCategory(modifier.category));
      return (modifierGroupId && groupIds.has(modifierGroupId)) ||
        (modifierGroupName && groupNames.has(modifierGroupName));
    });
}

function findLinkedModifierProduct(modifier = {}, items = []) {
  const products = (items || []).filter((item) => !isModifierRecipeItem(item));
  const linkedIds = new Set(getLinkedProductIds(modifier).map(normalizeKey).filter(Boolean));
  if (linkedIds.size) {
    const idMatch = products.find((product) => linkedIds.has(normalizeKey(product.id)));
    if (idMatch) return idMatch;
  }

  const variantKey = normalizeKey(modifier.yocoModifierVariantId);
  if (variantKey) {
    const variantMatch = products.find((product) => normalizeKey(product.yocoVariantId) === variantKey);
    if (variantMatch) return variantMatch;
  }

  const nameCandidates = [
    ...getLinkedProductNames(modifier),
    modifier.autoLinkedProductName,
    modifier.yocoModifierProductName,
    modifier.name
  ]
    .map(normalizeRecipeProductName)
    .filter(Boolean);
  if (!nameCandidates.length) return null;

  return products.find((product) => {
    const productNames = [
      product.name,
      product.yocoItemName,
      product.yocoVariantName,
      product.yocoOptionSummary
    ].map(normalizeRecipeProductName).filter(Boolean);
    return productNames.some((productName) => nameCandidates.some((candidate) => (
      productName === candidate ||
      productName.includes(candidate) ||
      candidate.includes(productName)
    )));
  }) || null;
}

function recipeSourceDetail(item = {}) {
  if (!isModifierRecipeItem(item)) return displaySourceLabel(item.source, 'Live catalogue');
  const linkedNames = getLinkedProductNames(item);
  if (linkedNames.length) return `Yoco modifier -> ${linkedNames.join(', ')}`;
  return item.yocoModifierGroupName ? `Yoco modifier · ${item.yocoModifierGroupName}` : 'Yoco modifier';
}

function renderRecipeSourceStockItemPanel(item = {}, stockItems = [], filters = {}) {
  const selectedId = String(item.recipeSourceStockItemId || item.recipe_source_stock_item_id || '').trim();
  const selectedItem = selectedId
    ? (item.recipeSourceStockItem || (stockItems || []).find((entry) => String(entry.id) === selectedId) || null)
    : null;
  const linkedRecipeLines = getRecipeSourceRecipeLines({ ...item, recipeSourceStockItem: selectedItem || item.recipeSourceStockItem });
  const isOpen = filters.openDropdown === 'recipeSourceStockItem';
  const search = String(filters.recipeSourceStockSearch || '').trim().toLowerCase();
  const sourceItems = (stockItems || [])
    .filter((entry) => entry?.id)
    .filter((entry) => {
      if (!search) return true;
      return String(entry.name || '').toLowerCase().includes(search) ||
        String(entry.category || '').toLowerCase().includes(search) ||
        String(entry.itemType || '').toLowerCase().includes(search);
    })
    .sort((left, right) => Number(isRecipeSourceStockItem(right)) - Number(isRecipeSourceStockItem(left)) || String(left.name || '').localeCompare(String(right.name || '')))
    .slice(0, 100);
  const selectedLabel = selectedItem?.name || 'No non-stock item';
  const warning = selectedItem && linkedRecipeLines.length === 0
    ? '<p class="recipesModule__sourceWarning">Linked stock item has no recipe lines.</p>'
    : '';

  return `
    <section class="recipesModule__modifierLinkPanel">
      <div>
        <span>Non-stock item</span>
        <strong>${escapeHtml(selectedLabel)}</strong>
        <p>${selectedItem ? `${linkedRecipeLines.length} recipe line${linkedRecipeLines.length === 1 ? '' : 's'} available from linked stock item.` : 'Link a virtual or non-stock build item when the POS item has no direct recipe.'}</p>
        ${warning}
      </div>
      <label>
        <span>Non Stock Item</span>
        <div class="recipesModule__customSelect ${isOpen ? 'is-open' : ''}" data-recipe-dropdown-root>
          <button type="button" data-recipe-source-stock-toggle aria-expanded="${isOpen}">
            <strong>${escapeHtml(selectedLabel)}</strong>
            ${icon('chevron')}
          </button>
          <div class="recipesModule__customSelectMenu">
            <input
              type="search"
              value="${escapeAttribute(filters.recipeSourceStockSearch || '')}"
              placeholder="Search stock items..."
              data-recipe-source-stock-search
            />
            <button type="button" class="recipesModule__customSelectClear" data-recipe-source-stock-clear>
              No linked stock item
            </button>
            <div class="recipesModule__customSelectOptions">
              ${sourceItems.map((stockItem) => {
                const isSelected = selectedId && String(stockItem.id) === selectedId;
                const recipeLines = normalizeRecipeLinesForDisplay(stockItem.recipe || stockItem.recipeLines || []);
                const sourceTypeMeta = getIngredientTypeMeta(stockItem);
                const sourceLabel = sourceTypeMeta.value === 'raw' ? 'Stock item' : sourceTypeMeta.label;
                return `
                  <button
                    type="button"
                    class="${isSelected ? 'is-selected' : ''}"
                    data-recipe-source-stock-select="${escapeAttribute(stockItem.id)}"
                  >
                    <span>${isSelected ? icon('check') : ''}</span>
                    <strong>${escapeHtml(stockItem.name)}</strong>
                    <em>${escapeHtml(sourceLabel)} · ${escapeHtml(stockItem.category || 'General')} · ${recipeLines.length} recipe lines</em>
                  </button>
                `;
              }).join('') || '<div class="recipesModule__customSelectEmpty">No stock items match this search.</div>'}
            </div>
          </div>
        </div>
      </label>
    </section>
  `;
}

function renderRecipeModeToggle(activeView = 'products', productCount = 0, modifierCount = 0) {
  const view = activeView === 'modifiers' ? 'modifiers' : 'products';
  return `
    <div class="recipesModule__modeToggle" role="group" aria-label="Recipe catalogue type">
      <button type="button" data-recipe-view="products" class="${view === 'products' ? 'is-active' : ''}" aria-pressed="${view === 'products'}">
        <span>Menu Items</span>
        <strong>${productCount}</strong>
      </button>
      <button type="button" data-recipe-view="modifiers" class="${view === 'modifiers' ? 'is-active' : ''}" aria-pressed="${view === 'modifiers'}">
        <span>Modifiers</span>
        <strong>${modifierCount}</strong>
      </button>
    </div>
  `;
}

function renderModifierProductLinkPanel(item = {}, allItems = [], filters = {}) {
  const products = (allItems || [])
    .filter((entry) => !isModifierRecipeItem(entry))
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
  const selectedIds = new Set(getLinkedProductIds(item));
  const linkedNames = getLinkedProductNames(item);
  const isOpen = filters.openDropdown === 'modifierProductLink';
  const search = String(filters.modifierProductLinkSearch || '').trim().toLowerCase();
  const visibleProducts = products.filter((product) => (
    !search ||
    String(product.name || '').toLowerCase().includes(search) ||
    String(product.category || '').toLowerCase().includes(search) ||
    String(product.sku || product.customSku || '').toLowerCase().includes(search)
  )).slice(0, 80);
  const selectedLabel = linkedNames.length ? linkedNames.join(', ') : 'Manual modifier recipe';
  return `
    <section class="recipesModule__modifierLinkPanel">
      <div>
        <span>Linked Menu Product</span>
        <strong>${escapeHtml(linkedNames.length ? selectedLabel : item.autoLinkedProductName ? `Auto matched: ${item.autoLinkedProductName}` : 'No product linked')}</strong>
        <p>Use this when a Yoco product modifier should deduct the same recipe as an existing menu item.</p>
      </div>
      <label>
        <span>Product Recipe</span>
        <div class="recipesModule__customSelect ${isOpen ? 'is-open' : ''}" data-recipe-dropdown-root>
          <button type="button" data-recipe-modifier-link-toggle aria-expanded="${isOpen}">
            <strong>${escapeHtml(selectedLabel)}</strong>
            ${icon('chevron')}
          </button>
          <div class="recipesModule__customSelectMenu">
            <input
              type="search"
              value="${escapeAttribute(filters.modifierProductLinkSearch || '')}"
              placeholder="Search menu products..."
              data-recipe-modifier-link-search
            />
            <button type="button" class="recipesModule__customSelectClear" data-recipe-modifier-link-clear>
              Manual modifier recipe
            </button>
            <div class="recipesModule__customSelectOptions">
              ${visibleProducts.map((product) => {
                const isSelected = selectedIds.has(String(product.id));
                return `
                  <button
                    type="button"
                    class="${isSelected ? 'is-selected' : ''}"
                    data-recipe-modifier-product-toggle="${escapeAttribute(product.id)}"
                  >
                    <span>${isSelected ? icon('check') : ''}</span>
                    <strong>${escapeHtml(product.name)}</strong>
                    <em>${escapeHtml(product.category || 'General')} · ${Number(product.recipeCount || 0)} recipe lines</em>
                  </button>
                `;
              }).join('') || '<div class="recipesModule__customSelectEmpty">No products match this search.</div>'}
            </div>
          </div>
        </div>
      </label>
    </section>
  `;
}

function getLinkedProductIds(item = {}) {
  if (Array.isArray(item.linkedProductIds)) return item.linkedProductIds.map(String).filter(Boolean);
  const raw = String(item.linkedProductId || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function getLinkedProductNames(item = {}) {
  if (Array.isArray(item.linkedProductNames)) return item.linkedProductNames.map(String).filter(Boolean);
  return String(item.linkedProductName || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function stripModifierCategory(category = '') {
  return String(category || '').replace(/^modifier\s*-\s*/i, '').trim();
}

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeRecipeProductName(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\byoco\b/g, ' ')
    .replace(/\bmodifier\b/g, ' ')
    .replace(/\bproduct\b/g, ' ')
    .replace(/\boption\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function average(values = []) {
  const normalized = values.map(Number).filter(Number.isFinite);
  return normalized.length ? normalized.reduce((sum, value) => sum + value, 0) / normalized.length : 0;
}

function formatGpRange(values = []) {
  const normalized = values.map(Number).filter(Number.isFinite);
  if (!normalized.length) return '';
  const min = Math.min(...normalized);
  const max = Math.max(...normalized);
  const format = (value) => `${value.toFixed(1)}%`;
  return Math.abs(max - min) < 0.05 ? format(min) : `${format(min)}-${format(max)}`;
}

function getModifierLinkedProductDisplay(item = {}) {
  const linkedNames = getLinkedProductNames(item);
  if (linkedNames.length) {
    return {
      tone: 'linked',
      label: 'Linked',
      value: linkedNames.join(', '),
      title: `Linked product: ${linkedNames.join(', ')}`
    };
  }

  const autoName = String(item.autoLinkedProductName || '').trim();
  if (autoName) {
    return {
      tone: 'linked',
      label: 'Linked',
      value: autoName,
      title: `Linked from Yoco ${item.modifierLinkSource === 'variant' ? 'variant' : 'product'} match: ${autoName}`
    };
  }

  const variantId = String(item.yocoModifierVariantId || '').trim();
  if (variantId) {
    const displayName = String(item.yocoModifierProductName || item.name || '').trim();
    return {
      tone: displayName ? 'linked' : 'variant',
      label: displayName ? 'Linked' : 'Yoco variant',
      value: displayName || variantId,
      title: displayName ? `Linked from Yoco product variant: ${displayName}. Variant id: ${variantId}` : `Yoco modifier variant id: ${variantId}`
    };
  }

  return {
    tone: 'missing',
    label: 'No link',
    value: 'No product linked',
    title: 'No linked product or Yoco variant link found'
  };
}

function isModifierProductLinked(item = {}) {
  if (String(item.modifierLinkStatus || '').toLowerCase() === 'linked') return true;
  if (getLinkedProductNames(item).length || getLinkedProductIds(item).length) return true;
  return Boolean(String(item.autoLinkedProductId || item.autoLinkedProductName || item.yocoModifierProductName || '').trim());
}

function renderRecipePickerModal(draftRecipe, recipes, filters) {
  const ingredients = recipes.ingredients || [];
  const ingredientCategories = getCategories(ingredients);
  const selectedIds = new Set((recipes.pickerSelectedIds || []).map(String));
  const selectedIngredients = [...selectedIds]
    .map((id) => ingredients.find((ingredient) => String(ingredient.id) === id))
    .filter(Boolean)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const isQuantityStep = recipes.pickerStep === 'quantity';

  return `
    <div class="recipesModule__modalBackdrop recipesModule__modalBackdrop--picker" role="presentation">
      <section class="recipesModule__modal recipesModule__modal--picker" role="dialog" aria-modal="true" aria-labelledby="recipe-picker-title" tabindex="-1" data-recipe-modal-dialog>
        <header class="recipesModule__modalHeader">
          <div>
            <p>Stock Item Picker</p>
            <h2 id="recipe-picker-title">${isQuantityStep ? 'Set Portion Quantities' : 'Add Ingredients'}</h2>
            <span>${isQuantityStep ? `${selectedIngredients.length} selected stock item${selectedIngredients.length === 1 ? '' : 's'}` : 'Search, select, then confirm quantities.'}</span>
          </div>
          <button type="button" class="recipesModule__iconButton" data-recipe-picker-close aria-label="Close stock picker">${icon('x')}</button>
        </header>

        ${isQuantityStep ? renderPickerQuantityStep(selectedIngredients, recipes) : `
          <div class="recipesModule__pickerControls">
            <label>
              <span>Search Stock Items</span>
              <div class="recipesModule__searchShell">
                <input
                  type="search"
                  value="${escapeAttribute(filters.ingredientQuery || '')}"
                  placeholder="Type ingredient name or barcode..."
                  data-recipe-filter="ingredientQuery"
                  data-recipe-stock-search
                />
                <button type="button" data-recipe-scan-barcode="ingredient" aria-label="Scan stock item barcode" title="Scan stock item barcode">
                  ${icon('camera')}
                </button>
              </div>
            </label>
            ${renderDropdown({
              id: 'ingredientCategory',
              label: 'Stock Item Category',
              value: filters.ingredientCategory,
              searchValue: filters.ingredientCategoryDropdownSearch,
              openDropdown: filters.openDropdown,
              options: [
                { value: '', label: 'All Stock Categories' },
                ...ingredientCategories.map((category) => ({ value: category, label: category }))
              ]
            })}
            ${renderIngredientTypeFilters(filters.ingredientType)}
          </div>
          ${renderPickerSelectStep(filterIngredients(ingredients, filters, draftRecipe).slice(0, 80), selectedIds, ingredients, draftRecipe)}
        `}

        ${recipes.actionError ? `<div class="recipesModule__inlineError" role="alert">${escapeHtml(recipes.actionError)}</div>` : ''}

        <footer class="recipesModule__modalFooter">
          ${isQuantityStep ? `
            <button type="button" data-recipe-picker-back>Back</button>
            <button type="button" class="recipesModule__primary" data-recipe-picker-apply>
              ${icon('check')}
              <span>Confirm & Add</span>
            </button>
          ` : `
            <button type="button" data-recipe-picker-clear>Clear</button>
            <button type="button" data-recipe-picker-select-visible>Select All Shown</button>
            <button type="button" class="recipesModule__primary" data-recipe-picker-confirm>
              ${icon('check')}
              <span>Confirm Selection</span>
            </button>
          `}
        </footer>
      </section>
    </div>
  `;
}

function renderPickerSelectStep(ingredientItems, selectedIds, ingredients, draftRecipe = []) {
  return `
    <div class="recipesModule__pickerList recipesModule__pickerList--modal" data-scroll-key="recipe-stock-picker">
      ${ingredientItems.length ? ingredientItems.map((ingredient) => renderIngredientChoice(ingredient, selectedIds.has(String(ingredient.id)), ingredients, draftRecipe)).join('') : '<div class="recipesModule__emptyLines">No available stock items match.</div>'}
    </div>
  `;
}

function renderPickerQuantityStep(selectedIngredients, recipes) {
  const quantities = recipes.pickerQuantities || {};
  const pickerUoms = recipes.pickerUoms || {};
  return `
    <div class="recipesModule__pickerQtyHead">
      <span>Stock Item</span>
      <span>Portion Qty</span>
      <span>UOM</span>
    </div>
    <div class="recipesModule__pickerQtyList">
      ${selectedIngredients.length ? selectedIngredients.map((ingredient) => {
        const uomOptions = getRecipeLineUomOptions(ingredient);
        const hasCustomUoms = uomOptions.length > 1;
        const selectedUnit = pickerUoms[ingredient.id] || uomOptions[0]?.value || ingredient.unit || 'ea';
        return `
          <article class="recipesModule__pickerQtyRow">
            <div>
              <strong>${escapeHtml(ingredient.name)}</strong>
              <span>${escapeHtml(ingredient.category || 'General')}</span>
            </div>
            <input
              type="text"
              value="${escapeAttribute(formatQtyInputValue(quantities[ingredient.id] || 0))}"
              data-recipe-picker-qty="${escapeAttribute(ingredient.id)}"
              data-focus-key="recipe-picker-qty-${escapeAttribute(ingredient.id)}"
              inputmode="decimal"
              autocomplete="off"
            />
            ${hasCustomUoms
              ? renderUomDropdown({ options: uomOptions, selected: selectedUnit, attr: 'picker', attrValue: ingredient.id })
              : `<em class="recipesModule__pickerUomStatic">${escapeHtml(selectedUnit.toUpperCase())}</em>`
            }
          </article>
        `;
      }).join('') : '<div class="recipesModule__emptyLines">No stock items selected.</div>'}
    </div>
  `;
}

function getRecipeLineUomOptions(ingredient) {
  const baseUnit = String(ingredient?.unit || 'ea').trim() || 'ea';
  const options = [{ value: baseUnit, label: baseUnit.toUpperCase(), ratio: 1 }];
  const configs = Array.isArray(ingredient?.uomConfigurations) ? ingredient.uomConfigurations : [];
  configs.forEach((cfg) => {
    if (cfg.customUom && Number(cfg.ratio) > 0) {
      options.push({ value: cfg.customUom, label: cfg.customUom.toUpperCase(), ratio: Number(cfg.ratio) });
    }
  });
  return options;
}

function getIngredientUomRatio(ingredient, selectedUnit) {
  const baseUnit = String(ingredient?.unit || 'ea').trim();
  if (!selectedUnit || selectedUnit === baseUnit) return 1;
  const config = (ingredient?.uomConfigurations || []).find(
    (cfg) => cfg.customUom && cfg.customUom.toLowerCase() === String(selectedUnit || '').toLowerCase()
  );
  return config && Number(config.ratio) > 0 ? Number(config.ratio) : 1;
}

function renderRecipeLine(line, index, ingredients, options = {}) {
  const ingredient = ingredients.find((item) => String(item.id) === String(line.ingId));
  const readOnly = options.readOnly === true;
  if (!ingredient) {
    return `
      <article class="recipesModule__line">
        <strong>Missing ingredient</strong>
        <span>${escapeHtml(line.ingId)}</span>
        ${readOnly ? '<span></span>' : `<button type="button" data-recipe-line-remove="${index}" aria-label="Remove missing ingredient">${icon('trash')}</button>`}
      </article>
    `;
  }

  const uomOptions = getRecipeLineUomOptions(ingredient);
  const selectedUnit = String(line.unit || ingredient.unit || 'ea').trim();
  const uomRatio = getIngredientUomRatio(ingredient, selectedUnit);
  const hasCustomUoms = uomOptions.length > 1;

  const unitCost = getIngredientUnitCost(ingredient.id, ingredients, options.activeLocationId || '');
  const yieldPct = ingredient.yieldFactor && ingredient.yieldFactor > 0 ? ingredient.yieldFactor / 100 : 1;
  const effectiveCostPerBaseUnit = unitCost / yieldPct;
  const effectiveCostPerSelectedUnit = effectiveCostPerBaseUnit * uomRatio;
  const lineCost = effectiveCostPerBaseUnit * parseQtyNumber(line.qty) * uomRatio;

  return `
    <article class="recipesModule__line">
      <div>
        <strong>${escapeHtml(ingredient.name)}</strong>
        <span>${escapeHtml(selectedUnit)} · ${formatCurrency(effectiveCostPerSelectedUnit)} per ${escapeHtml(selectedUnit)}</span>
      </div>
      <label>
        <span>Qty</span>
        <input type="text" value="${escapeAttribute(formatQtyInputValue(line.qty))}" data-recipe-line-qty="${index}" data-focus-key="recipe-line-qty-${index}" inputmode="decimal" autocomplete="off" ${readOnly ? 'disabled' : ''} />
      </label>
      ${hasCustomUoms && !readOnly
        ? renderUomDropdown({ options: uomOptions, selected: selectedUnit, attr: 'line', attrValue: String(index) })
        : `<span class="recipesModule__lineUomStatic">${escapeHtml(selectedUnit.toUpperCase())}</span>`
      }
      <strong>${formatCurrency(lineCost)}</strong>
      ${readOnly ? '<span></span>' : `<button type="button" data-recipe-line-remove="${index}" aria-label="Remove ingredient">${icon('trash')}</button>`}
    </article>
  `;
}

function renderLineRemovalConfirm(confirmLineRemoval) {
  if (!confirmLineRemoval) return '';

  return `
    <div class="recipesModule__lineConfirm" role="alertdialog" aria-live="assertive" aria-label="Confirm component removal">
      <div>
        <strong>Remove component?</strong>
        <p>This will remove ${escapeHtml(confirmLineRemoval.name || 'this ingredient')} from the staged recipe. Save the recipe to sync the change.</p>
      </div>
      <div class="recipesModule__lineConfirmActions">
        <button type="button" data-recipe-line-remove-cancel>Keep Component</button>
        <button type="button" class="recipesModule__danger" data-recipe-line-remove-confirm>${icon('trash')}<span>Remove</span></button>
      </div>
    </div>
  `;
}

function formatQtyInputValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function parseQtyNumber(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderIngredientChoice(ingredient, selected = false, ingredients = [], draftRecipe = []) {
  const existingLine = (draftRecipe || []).find((line) => String(line.ingId) === String(ingredient.id));
  const typeMeta = getIngredientTypeMeta(ingredient);
  const detail = [
    ingredient.category || 'General',
    existingLine ? `Already in recipe (${formatQtyInputValue(existingLine.qty)} staged)` : ''
  ].filter(Boolean).join(' · ');

  return `
    <label class="recipesModule__choice ${selected ? 'is-selected' : ''}">
      <input type="checkbox" data-recipe-picker-toggle="${escapeAttribute(ingredient.id)}" ${selected ? 'checked' : ''} />
      <span class="recipesModule__choiceCheck"></span>
      <div>
        <strong>${escapeHtml(ingredient.name)}</strong>
        <span class="recipesModule__choiceMeta">
          ${escapeHtml(detail)}
          ${detail ? ' · ' : ''}
          <em class="recipesModule__choiceTag recipesModule__choiceTag--${escapeAttribute(typeMeta.tone)}">${escapeHtml(typeMeta.label)}</em>
          ${ingredient.unit ? ` · ${escapeHtml(String(ingredient.unit).toUpperCase())}` : ''}
        </span>
      </div>
      <span class="recipesModule__choiceCost">${formatCurrency(getIngredientUnitCost(ingredient.id, ingredients.length ? ingredients : [ingredient]))}</span>
    </label>
  `;
}

function getIngredientTypeMeta(ingredient = {}) {
  const explicit = normalizeRecipeIngredientTypeValue(ingredient.itemType || ingredient.stockItemType || ingredient.specificationType || '');
  const category = String(ingredient.category || '').toLowerCase();

  if (isSubRecipeStockItem(ingredient, explicit, category)) {
    return { label: 'Sub-Recipe', tone: 'sub', value: 'sub_recipe' };
  }
  if (
    ['manufactured', 'prep', 'prepared', 'manufactured_item'].includes(explicit) ||
    ingredient.isManufactured === true ||
    category.includes('manufactured')
  ) {
    return { label: 'Manufactured', tone: 'manufactured', value: 'manufactured' };
  }
  if (isRecipeSourceStockItem(ingredient, explicit, category)) {
    return { label: 'Non Stock', tone: 'sub', value: 'recipe_source' };
  }
  return { label: 'Raw', tone: 'raw', value: 'raw' };
}

function normalizeRecipeIngredientTypeValue(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function isSubRecipeStockItem(item = {}, explicit = normalizeRecipeIngredientTypeValue(item.itemType || item.stockItemType || item.specificationType || ''), category = String(item.category || '').toLowerCase()) {
  return ['sub_recipe', 'subrecipe', 'sub_recipe_item'].includes(explicit) ||
    item.isSubRecipe === true ||
    category.includes('sub recipe') ||
    category.includes('sub-recipe');
}

function isRecipeSourceStockItem(item = {}, explicit = normalizeRecipeIngredientTypeValue(item.itemType || item.stockItemType || item.specificationType || ''), category = String(item.category || '').toLowerCase()) {
  if (isSubRecipeStockItem(item, explicit, category)) return false;
  return ['non_stock', 'recipe_source', 'virtual'].includes(explicit) ||
    category.includes('recipe source') ||
    category.includes('non-stock') ||
    category.includes('non stock') ||
    category.includes('virtual');
}

function renderIngredientTypeFilters(activeType = '') {
  const options = [
    { value: '', label: 'All items', tone: 'all' },
    { value: 'raw', label: 'Raw', tone: 'raw' },
    { value: 'sub_recipe', label: 'Sub-Recipes', tone: 'sub' },
    { value: 'manufactured', label: 'Manufactured', tone: 'manufactured' }
  ];

  return `
    <div class="recipesModule__ingredientTypeFilters" role="group" aria-label="Filter stock items by type">
      ${options.map((option) => `
        <button
          type="button"
          class="recipesModule__ingredientTypeFilter recipesModule__ingredientTypeFilter--${escapeAttribute(option.tone)} ${String(activeType || '') === option.value ? 'is-active' : ''}"
          data-recipe-ingredient-type="${escapeAttribute(option.value)}"
          aria-pressed="${String(activeType || '') === option.value ? 'true' : 'false'}"
        >
          ${escapeHtml(option.label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderActionDropdown(openDropdown, actionStatus) {
  const isOpen = openDropdown === 'recipeActions';
  return `
    <div class="recipesModule__dropdown recipesModule__actionDropdown ${isOpen ? 'recipesModule__dropdown--open' : ''}" data-recipe-dropdown-root>
      <button type="button" data-recipe-dropdown="recipeActions" aria-expanded="${isOpen}">
        ${icon('download')}
        <strong>Action Items</strong>
        ${icon('chevron')}
      </button>
      <div class="recipesModule__dropdownMenu">
        <button type="button" data-recipe-import-trigger ${actionStatus === 'importing' ? 'disabled' : ''}>
          ${icon('upload')}
          <span>${actionStatus === 'importing' ? 'Importing' : 'Import Recipes'}</span>
        </button>
        <span class="recipesModule__fileDivider">Export Templates</span>
        <button type="button" data-recipe-export="template-xlsx">${icon('download')}<span>XLSX Template</span></button>
        <span class="recipesModule__fileDivider">Export</span>
        <button type="button" data-recipe-export="xlsx">${icon('download')}<span>XLSX</span></button>
        <button type="button" data-recipe-export="pdf">${icon('download')}<span>PDF</span></button>
      </div>
    </div>
  `;
}

function renderDropdown({ id, label, value, searchValue = '', openDropdown, options }) {
  const activeOption = options.find((option) => option.value === value) || options[0];
  const isOpen = openDropdown === id;
  const searchKey = `${id}DropdownSearch`;
  const query = String(searchValue || '').trim().toLowerCase();
  const visibleOptions = options.filter((option, index) => (
    index === 0 || !query || String(option.label || '').toLowerCase().includes(query)
  ));

  return `
    <div class="recipesModule__dropdown ${isOpen ? 'recipesModule__dropdown--open' : ''}" data-recipe-dropdown-root>
      <span>${escapeHtml(label)}</span>
      <button type="button" data-recipe-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(activeOption.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="recipesModule__dropdownMenu">
        <input
          type="search"
          value="${escapeAttribute(searchValue)}"
          placeholder="Search ${escapeAttribute(label.toLowerCase())}..."
          data-recipe-dropdown-search="${escapeAttribute(searchKey)}"
          data-recipe-dropdown-group="${escapeAttribute(id)}"
        />
        <div class="recipesModule__dropdownOptions">
          ${visibleOptions.map((option) => `
            <button
              type="button"
              data-recipe-option
              data-recipe-option-group="${escapeAttribute(id)}"
              data-recipe-option-value="${escapeAttribute(option.value)}"
              data-recipe-option-search-key="${escapeAttribute(searchKey)}"
              class="${option.value === value ? 'is-active' : ''}"
            >
              ${escapeHtml(option.label)}
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderInlineBulkDelete(selectedIds, actionStatus) {
  return `
    <button
      type="button"
      data-recipe-delete-selected="${escapeAttribute(JSON.stringify(selectedIds))}"
      class="recipesModule__danger recipesModule__bulkDeleteInline"
      ${actionStatus === 'deleting' ? 'disabled' : ''}
    >
      ${icon('trash')}
      <span>${actionStatus === 'deleting' ? 'Deleting' : `Delete Selected (${selectedIds.length})`}</span>
    </button>
  `;
}

function renderDeleteDialog(recipes) {
  const confirmDelete = recipes.confirmDelete;
  if (!confirmDelete?.ids?.length) return '';

  const count = confirmDelete.ids.length;
  const selectedIds = new Set(confirmDelete.ids.map(String));
  const selectedItems = (recipes.items || []).filter((item) => selectedIds.has(String(item.id)));
  const modifierCount = selectedItems.filter(isModifierRecipeItem).length;
  const productCount = Math.max(0, count - modifierCount);
  const isModifierOnly = modifierCount > 0 && productCount === 0;
  const isMixed = modifierCount > 0 && productCount > 0;
  const eyebrow = isModifierOnly ? 'Confirm Modifier Delete' : isMixed ? 'Confirm Recipe Delete' : 'Confirm Recipe Product Delete';
  const title = isModifierOnly
    ? count === 1 ? 'Delete Modifier' : 'Delete Selected Modifiers'
    : isMixed ? 'Delete Products and Modifiers' : count === 1 ? 'Delete Recipe Product' : 'Delete Selected Recipe Products';
  const subtitle = isModifierOnly
    ? 'This removes the modifier from the Recipes list. Yoco catalogue data remains untouched.'
    : isMixed ? 'Products are removed and modifiers are removed from Recipes.' : 'This removes the product from Recipes and Menu Catalogue.';
  const confirmText = isModifierOnly
    ? count === 1
      ? 'This deletes the KCP modifier recipe/link entry and removes it from this list.'
      : `${count} KCP modifier recipe/link entries will be deleted and removed from this list.`
    : isMixed
      ? `${productCount} product${productCount === 1 ? '' : 's'} will be removed and ${modifierCount} modifier${modifierCount === 1 ? '' : 's'} will be deleted from Recipes.`
      : count === 1
        ? 'This product and its recipe blueprint will no longer appear in the active catalogue.'
        : `${count} products and their recipe blueprints will no longer appear in the active catalogue.`;
  const actionLabel = recipes.actionStatus === 'deleting' ? 'Deleting' : 'Delete';
  return `
    <div class="recipesModule__modalBackdrop" role="presentation">
      <section class="recipesModule__modal recipesModule__modal--compact" role="dialog" aria-modal="true" aria-labelledby="recipe-delete-title" tabindex="-1" data-recipe-modal-dialog>
        <header class="recipesModule__modalHeader">
          <div>
            <p>${escapeHtml(eyebrow)}</p>
            <h2 id="recipe-delete-title">${escapeHtml(title)}</h2>
            <span>${escapeHtml(subtitle)}</span>
          </div>
        </header>
        <p class="recipesModule__confirmText">
          ${escapeHtml(confirmText)}
        </p>
        ${recipes.actionError ? `<div class="recipesModule__inlineError" role="alert">${escapeHtml(recipes.actionError)}</div>` : ''}
        <div class="recipesModule__modalFooter">
          <button type="button" data-recipe-cancel-delete>Cancel</button>
          <button type="button" class="recipesModule__danger" data-recipe-confirm-delete ${recipes.actionStatus === 'deleting' ? 'disabled' : ''}>
            ${icon('trash')}
            <span>${escapeHtml(actionLabel)}</span>
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderNotice(message, tone) {
  return `<div class="recipesModule__notice recipesModule__notice--${tone}">${escapeHtml(message)}</div>`;
}

function renderSkeletonRow() {
  return `
    <article class="recipesModule__row recipe-grid-row recipesModule__row--loading">
      <div></div><div></div><div></div><div></div><div></div><div></div><div></div>
    </article>
  `;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="recipesModule__toast recipesModule__toast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-recipe-toast-close aria-label="Dismiss notification">${icon('x')}</button>
    </div>
  `;
}

function filterRecipeItems(items, filters) {
  const query = String(filters.query || '').trim().toLowerCase();
  const view = filters.recipeView === 'modifiers' ? 'modifiers' : 'products';
  return items.filter((item) => {
    const isModifier = isModifierRecipeItem(item);
    if (view === 'modifiers' && !isModifier) return false;
    if (view === 'products' && isModifier) return false;
    const matchesQuery = !query ||
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.sku || '').toLowerCase().includes(query) ||
      String(item.customSku || '').toLowerCase().includes(query) ||
      String(item.category || '').toLowerCase().includes(query) ||
      String(item.linkedProductName || '').toLowerCase().includes(query) ||
      String(item.autoLinkedProductName || '').toLowerCase().includes(query) ||
      String(item.yocoModifierGroupName || '').toLowerCase().includes(query) ||
      matchesBarcodeQuery(item, query);
    const matchesCategory = !filters.category || item.category === filters.category;
    return matchesQuery && matchesCategory;
  });
}

function getRecipeSkuDisplay(item = {}) {
  return String(item.sku || item.customSku || item.barcode || '').trim() || '—';
}

function displaySourceLabel(source = '', fallback = 'Live data') {
  const value = String(source || '').trim();
  return value && !/flare|d1/i.test(value) ? value : fallback;
}

function filterIngredients(ingredients, filters, draftRecipe) {
  const query = String(filters.ingredientQuery || '').trim().toLowerCase();
  const typeFilter = String(filters.ingredientType || '').trim();
  return ingredients
    .filter((ingredient) => {
      const matchesQuery = !query ||
        String(ingredient.name || '').toLowerCase().includes(query) ||
        String(ingredient.category || '').toLowerCase().includes(query) ||
        matchesBarcodeQuery(ingredient, query);
      const matchesCategory = !filters.ingredientCategory || ingredient.category === filters.ingredientCategory;
      const matchesType = !typeFilter || getIngredientTypeMeta(ingredient).value === typeFilter;
      return matchesQuery && matchesCategory && matchesType;
    })
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function calculateRecipeCost(recipe, ingredients, activeLocationId = '') {
  return (recipe || []).reduce((sum, line) => {
    const ingredient = ingredients.find((item) => String(item.id) === String(line.ingId));
    if (!ingredient) return sum;
    const yieldPct = ingredient.yieldFactor && ingredient.yieldFactor > 0 ? ingredient.yieldFactor / 100 : 1;
    const uomRatio = getIngredientUomRatio(ingredient, line.unit);
    return sum + (getIngredientUnitCost(ingredient.id, ingredients, activeLocationId) / yieldPct) * parseQtyNumber(line.qty) * uomRatio;
  }, 0);
}

function getIngredientUnitCost(ingredientId, ingredients, activeLocationId = '', seen = new Set()) {
  return resolveRecipeIngredientUnitCost(ingredientId, ingredients, activeLocationId, seen);
}

function getCategories(items) {
  return [...new Set(items.map((item) => item.category || 'General'))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function applyPendingFocus(view, pendingFocus) {
  if (!pendingFocus) return;

  const target = pendingFocus.type === 'quantity'
    ? view.querySelector(`[data-recipe-line-qty="${Number(pendingFocus.index)}"]`)
    : pendingFocus.type === 'pickerQuantity'
      ? view.querySelector(`[data-recipe-picker-qty="${cssEscape(pendingFocus.id)}"]`)
      : view.querySelector('[data-recipe-stock-search]');

  if (!target) return;
  target.focus({ preventScroll: true });
  if (canSetTextSelection(target) && typeof target.setSelectionRange === 'function') {
    const end = String(target.value || '').length;
    target.setSelectionRange(end, end);
  }
}

function applyRecipeModalFocus(view, recipes = {}) {
  const requestId = String(recipes.modalFocusRequest || '');
  if (!requestId || requestId === lastFocusedRecipeModalRequest) return;
  const modal = view.querySelector('[data-recipe-modal-dialog]');
  if (!modal) return;

  lastFocusedRecipeModalRequest = requestId;
  modal.scrollTop = 0;
  modal.focus({ preventScroll: true });
}

function canSetTextSelection(element) {
  if (!element) return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  const type = String(element.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'color', 'date', 'datetime-local', 'file', 'hidden', 'image', 'month', 'number', 'radio', 'range', 'reset', 'submit', 'time', 'week'].includes(type);
}

function parseDatasetJson(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR'
  }).format(Number(value || 0));
}

function renderGpBadge(value, extraClass = '') {
  const numeric = Number(value);
  const display = Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : '0.0%';
  return `<strong class="recipesModule__gpBadge ${recipeGpToneClass(numeric)} ${escapeAttribute(extraClass)}">${escapeHtml(display)}</strong>`;
}

function renderRecipeInfo(message = '', align = '') {
  const text = String(message || '').trim();
  if (!text) return '';
  const alignClass = align === 'right' ? ' recipesModule__info--right' : '';
  return `
    <span class="recipesModule__info${alignClass}" tabindex="0" role="button" aria-label="${escapeAttribute(text)}">
      ${icon('info')}
      <span role="tooltip">${escapeHtml(text)}</span>
    </span>
  `;
}

function recipeGpToneClass(value) {
  if (value < 0) return 'is-negative';
  if (value < 30) return 'is-low';
  if (value < 60) return 'is-mid';
  if (value < 80) return 'is-good';
  return 'is-excellent';
}

function icon(name) {
  const icons = {
    arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    camera: '<path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="12.5" r="3.5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    sliders: '<path d="M4 7h16"/><path d="M4 17h16"/><path d="M9 5v4"/><path d="M15 15v4"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
    utensils: '<path d="M4 3v7"/><path d="M8 3v7"/><path d="M6 10v11"/><path d="M17 3v18"/><path d="M14 3h6v8h-6z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${icons[name] || icons.utensils}
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

function cssEscape(value = '') {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
