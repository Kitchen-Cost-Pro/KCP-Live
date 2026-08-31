import '../styles/recipes.css';
import { renderLoadingPanel } from './LoadingPanel.js';
import { matchesBarcodeQuery } from '../utils/barcodes.js';
import { resolveRecipeIngredientUnitCost } from '../utils/stockCostResolver.js';
import { getAccessibleLocationOptions } from '../services/locationAccess.js';
import { averageModifierOptionValue } from '../services/modifierCostService.js';

let lastFocusedRecipeModalRequest = '';
let _uomDocumentCloseHandler = null;

// Matches the 'complete'/'missing' values normalizeRecipeItem() (recipeService.js) already sets
// on every item's `status` field — filtering on the same field the rest of the app already uses
// to decide "does this product have a usable recipe" (onboarding readiness, Go-Live checks).
const RECIPE_STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'complete', label: 'Has Recipe' },
  { value: 'missing', label: 'Missing Recipe' }
];


function getAccessibleSellingLocationOptions(locations = [], access = {}) {
  return getAccessibleLocationOptions(locations, access, { sellingOnly: true });
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
    recipeStatus: '',
    recipeView: 'products',
    ingredientQuery: '',
    ingredientCategory: '',
    ingredientType: '',
    locationId: '',
    openDropdown: '',
    categoryDropdownSearch: '',
    recipeStatusDropdownSearch: '',
    ingredientCategoryDropdownSearch: '',
    locationIdDropdownSearch: '',
    modifierStockRuleOpen: false,
    ...(recipes.filters || {})
  };
  filters.recipeView = 'products';
  const locationOptions = getAccessibleSellingLocationOptions(recipes.locations || [], state.access || {});
  const activeLocationId = resolveActiveLocationId(filters.locationId, locationOptions);
  const activeLocationName = locationOptions.find((option) => option.value === activeLocationId)?.label || '';
  const catalogueItems = recipes.items || [];
  const allItems = catalogueItems
    .filter((item) => !isModifierRecipeItem(item))
    .map((item) => applyRecipeLocationPrice(item, activeLocationId, locationOptions));
  const modifierItems = catalogueItems.filter(isModifierRecipeItem);
  const items = filterRecipeItems(allItems, filters);
  const selectedIds = new Set((recipes.selectedIds || []).map(String));
  const selectedCount = selectedIds.size;
  const selectedItem = recipes.editingItem
    ? allItems.find((item) => String(item.id) === String(recipes.editingItem.id)) || applyRecipeLocationPrice(recipes.editingItem, activeLocationId, locationOptions)
    : null;
  const displayRecipes = {
    ...recipes,
    items: allItems,
    modifierItems,
    allRecipeItems: [...allItems, ...modifierItems],
    activeLocationId,
    activeLocationName
  };
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
      ${renderDropdown({
        id: 'recipeStatus',
        label: 'Recipe Status',
        value: filters.recipeStatus,
        searchValue: filters.recipeStatusDropdownSearch,
        openDropdown: filters.openDropdown,
        options: RECIPE_STATUS_FILTER_OPTIONS
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

  view.querySelector('[data-modifier-stock-open]')?.addEventListener('click', () => {
    onRecipeFilterChange?.({ modifierStockRuleOpen: true, openDropdown: '' });
  });
  view.querySelectorAll('[data-modifier-stock-close]').forEach((button) => {
    button.addEventListener('click', () => onRecipeFilterChange?.({ modifierStockRuleOpen: false }));
  });
  view.querySelector('[data-modifier-stock-done]')?.addEventListener('click', () => {
    onRecipeFilterChange?.({ modifierStockRuleOpen: false });
  });
  view.querySelector('[data-modifier-stock-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) onRecipeFilterChange?.({ modifierStockRuleOpen: false });
  });
  view.querySelectorAll('[data-modifier-stock-action]').forEach((input) => {
    input.addEventListener('change', () => {
      const actionType = input.value;
      const ownerId = view.querySelector('[data-modifier-owner-id]')?.dataset.modifierOwnerId || '';
      const patch = { actionType, locationIds: [], quantity: 1, unit: 'ea' };
      if (actionType === 'ADD_RECIPE') Object.assign(patch, {
        targetOwnerType: 'yoco_modifier',
        targetOwnerId: ownerId,
        sourceStockItemId: '',
        replacementStockItemId: ''
      });
      if (actionType === 'ADD_STOCK_ITEM') Object.assign(patch, { targetOwnerType: 'stock_item', targetOwnerId: '', sourceStockItemId: '', replacementStockItemId: '' });
      if (actionType === 'REMOVE_INGREDIENT') Object.assign(patch, { targetOwnerType: '', targetOwnerId: '', replacementStockItemId: '' });
      if (actionType === 'REPLACE_INGREDIENT') Object.assign(patch, { targetOwnerType: '', targetOwnerId: '' });
      if (actionType === 'NO_STOCK_CHANGE') Object.assign(patch, { targetOwnerType: '', targetOwnerId: '', sourceStockItemId: '', replacementStockItemId: '' });
      onRecipeAction.onModifierStockRuleChange?.(patch);
    });
  });
  view.querySelectorAll('[data-modifier-stock-picker-open]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onOpenModifierStockPicker?.(button.dataset.modifierStockPickerOpen || ''));
  });
  view.querySelectorAll('[data-modifier-stock-picker-close]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onCloseModifierStockPicker?.());
  });
  view.querySelector('[data-modifier-stock-picker-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) onRecipeAction.onCloseModifierStockPicker?.();
  });
  view.querySelector('[data-modifier-stock-picker-search]')?.addEventListener('input', (event) => {
    onRecipeAction.onModifierStockPickerSearch?.(event.currentTarget.value);
  });
  view.querySelectorAll('[data-modifier-stock-picker-select]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onModifierStockPickerSelect?.(button.dataset.modifierStockPickerSelect || ''));
  });
  view.querySelector('[data-modifier-stock-quantity]')?.addEventListener('change', (event) => {
    onRecipeAction.onModifierStockRuleChange?.({ quantity: Number(event.currentTarget.value) });
  });
  view.querySelector('[data-modifier-stock-unit]')?.addEventListener('change', (event) => {
    onRecipeAction.onModifierStockRuleChange?.({ unit: event.currentTarget.value });
  });
  view.querySelector('[data-modifier-stock-replacement-quantity]')?.addEventListener('change', (event) => {
    const sourceQuantity = Number(event.currentTarget.dataset.modifierStockSourceQuantity || 0);
    const entered = Number(event.currentTarget.value);
    onRecipeAction.onModifierStockRuleChange?.({ quantity: sourceQuantity > 0 ? entered / sourceQuantity : entered });
  });
  view.querySelector('[data-modifier-stock-apply-all]')?.addEventListener('change', (event) => {
    onRecipeAction.onModifierStockRuleChange?.({
      applyAllMatchingProducts: event.currentTarget.checked,
      ...(event.currentTarget.checked ? { menuItemIds: [] } : {})
    });
  });
  view.querySelectorAll('[data-modifier-stock-menu-item]').forEach((input) => {
    input.addEventListener('change', () => {
      const menuItemIds = [...view.querySelectorAll('[data-modifier-stock-menu-item]:checked')].map((entry) => entry.value);
      onRecipeAction.onModifierStockRuleChange?.({ menuItemIds, applyAllMatchingProducts: false });
    });
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

  view.querySelector('[data-recipe-note-suggestions-open]')?.addEventListener('click', () => {
    onRecipeAction.onOpenNoteSuggestions?.();
  });
  view.querySelectorAll('[data-recipe-note-suggestions-close]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onCloseNoteSuggestions?.());
  });
  view.querySelector('[data-recipe-note-suggestions-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) onRecipeAction.onCloseNoteSuggestions?.();
  });
  view.querySelector('[data-recipe-note-refresh]')?.addEventListener('click', () => {
    onRecipeAction.onRefreshNoteSuggestions?.();
  });
  view.querySelector('[data-recipe-note-include-ignored]')?.addEventListener('change', (event) => {
    onRecipeAction.onToggleIgnoredNoteSuggestions?.(event.currentTarget.checked);
  });
  view.querySelectorAll('[data-note-suggestion-setup]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onStartNoteRuleSetup?.(button.dataset.noteSuggestionSetup));
  });
  view.querySelectorAll('[data-note-suggestion-ignore]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onIgnoreNoteSuggestion?.(button.dataset.noteSuggestionIgnore));
  });
  view.querySelectorAll('[data-note-suggestion-restore]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onRestoreNoteSuggestion?.(button.dataset.noteSuggestionRestore));
  });
  view.querySelectorAll('[data-note-rule-cancel]').forEach((button) => {
    button.addEventListener('click', () => onRecipeAction.onCancelNoteRuleSetup?.());
  });
  view.querySelectorAll('[data-note-rule-field]').forEach((field) => {
    field.addEventListener('change', () => {
      const key = field.dataset.noteRuleField;
      const value = key === 'quantity' ? Number(field.value) : field.value;
      onRecipeAction.onNoteRuleDraftChange?.({ [key]: value });
    });
  });
  view.querySelectorAll('[data-note-rule-menu-item]').forEach((input) => {
    input.addEventListener('change', () => {
      const menuItemIds = [...view.querySelectorAll('[data-note-rule-menu-item]:checked')].map((entry) => entry.value);
      onRecipeAction.onNoteRuleDraftChange?.({ menuItemIds });
    });
  });
  view.querySelectorAll('[data-note-rule-location]').forEach((input) => {
    input.addEventListener('change', () => {
      const locationIds = [...view.querySelectorAll('[data-note-rule-location]:checked')].map((entry) => entry.value);
      onRecipeAction.onNoteRuleDraftChange?.({ locationIds });
    });
  });
  view.querySelector('[data-note-rule-save]')?.addEventListener('click', () => {
    onRecipeAction.onSaveNoteRule?.();
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


export function bindModifierManagementControls(view, {
  onCloseModifier = () => {},
  onSaveModifier = () => {},
  onModifierStockRuleChange = () => {},
  onOpenModifierStockPicker = () => {},
  onCloseModifierStockPicker = () => {},
  onModifierStockPickerSearch = () => {},
  onModifierStockPickerSelect = () => {},
  onOpenNoteSuggestions = () => {},
  onCloseNoteSuggestions = () => {},
  onRefreshNoteSuggestions = () => {},
  onToggleIgnoredNoteSuggestions = () => {},
  onStartNoteRuleSetup = () => {},
  onCancelNoteRuleSetup = () => {},
  onNoteRuleDraftChange = () => {},
  onSaveNoteRule = () => {},
  onIgnoreNoteSuggestion = () => {},
  onRestoreNoteSuggestion = () => {}
} = {}) {
  if (!view) return;
  view.querySelectorAll('[data-modifier-stock-close]').forEach((button) => {
    button.addEventListener('click', () => onCloseModifier());
  });
  view.querySelector('[data-modifier-stock-done]')?.addEventListener('click', () => onSaveModifier());
  view.querySelector('[data-modifier-stock-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) onCloseModifier();
  });
  view.querySelectorAll('[data-modifier-stock-action]').forEach((input) => {
    input.addEventListener('change', () => {
      const actionType = input.value;
      const ownerId = view.querySelector('[data-modifier-owner-id]')?.dataset.modifierOwnerId || '';
      const patch = { actionType, locationIds: [], quantity: 1, unit: 'ea' };
      if (actionType === 'ADD_RECIPE') Object.assign(patch, { targetOwnerType: 'yoco_modifier', targetOwnerId: ownerId, sourceStockItemId: '', replacementStockItemId: '' });
      if (actionType === 'ADD_STOCK_ITEM') Object.assign(patch, { targetOwnerType: 'stock_item', targetOwnerId: '', sourceStockItemId: '', replacementStockItemId: '' });
      if (actionType === 'REMOVE_INGREDIENT') Object.assign(patch, { targetOwnerType: '', targetOwnerId: '', replacementStockItemId: '' });
      if (actionType === 'REPLACE_INGREDIENT') Object.assign(patch, { targetOwnerType: '', targetOwnerId: '' });
      if (actionType === 'NO_STOCK_CHANGE') Object.assign(patch, { targetOwnerType: '', targetOwnerId: '', sourceStockItemId: '', replacementStockItemId: '' });
      onModifierStockRuleChange(patch);
    });
  });
  view.querySelectorAll('[data-modifier-stock-picker-open]').forEach((button) => {
    button.addEventListener('click', () => onOpenModifierStockPicker(button.dataset.modifierStockPickerOpen || ''));
  });
  view.querySelectorAll('[data-modifier-stock-picker-close]').forEach((button) => {
    button.addEventListener('click', () => onCloseModifierStockPicker());
  });
  view.querySelector('[data-modifier-stock-picker-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) onCloseModifierStockPicker();
  });
  view.querySelector('[data-modifier-stock-picker-search]')?.addEventListener('input', (event) => {
    onModifierStockPickerSearch(event.currentTarget.value);
  });
  view.querySelectorAll('[data-modifier-stock-picker-select]').forEach((button) => {
    button.addEventListener('click', () => onModifierStockPickerSelect(button.dataset.modifierStockPickerSelect || ''));
  });
  view.querySelector('[data-modifier-stock-quantity]')?.addEventListener('change', (event) => {
    onModifierStockRuleChange({ quantity: Number(event.currentTarget.value) });
  });
  view.querySelector('[data-modifier-stock-unit]')?.addEventListener('change', (event) => {
    onModifierStockRuleChange({ unit: event.currentTarget.value });
  });
  view.querySelector('[data-modifier-stock-replacement-quantity]')?.addEventListener('change', (event) => {
    const sourceQuantity = Number(event.currentTarget.dataset.modifierStockSourceQuantity || 0);
    const entered = Number(event.currentTarget.value);
    onModifierStockRuleChange({ quantity: sourceQuantity > 0 ? entered / sourceQuantity : entered });
  });
  view.querySelector('[data-modifier-stock-apply-all]')?.addEventListener('change', (event) => {
    onModifierStockRuleChange({
      applyAllMatchingProducts: event.currentTarget.checked,
      ...(event.currentTarget.checked ? { menuItemIds: [] } : {})
    });
  });
  view.querySelectorAll('[data-modifier-stock-menu-item]').forEach((input) => {
    input.addEventListener('change', () => {
      const menuItemIds = [...view.querySelectorAll('[data-modifier-stock-menu-item]:checked')].map((entry) => entry.value);
      onModifierStockRuleChange({ menuItemIds, applyAllMatchingProducts: false });
    });
  });

  view.querySelectorAll('[data-recipe-note-suggestions-open]').forEach((button) => {
    button.addEventListener('click', () => onOpenNoteSuggestions());
  });
  view.querySelectorAll('[data-recipe-note-suggestions-close]').forEach((button) => {
    button.addEventListener('click', () => onCloseNoteSuggestions());
  });
  view.querySelector('[data-recipe-note-suggestions-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) onCloseNoteSuggestions();
  });
  view.querySelector('[data-recipe-note-refresh]')?.addEventListener('click', () => onRefreshNoteSuggestions());
  view.querySelector('[data-recipe-note-include-ignored]')?.addEventListener('change', (event) => {
    onToggleIgnoredNoteSuggestions(event.currentTarget.checked);
  });
  view.querySelectorAll('[data-note-suggestion-setup]').forEach((button) => {
    button.addEventListener('click', () => onStartNoteRuleSetup(button.dataset.noteSuggestionSetup));
  });
  view.querySelectorAll('[data-note-suggestion-ignore]').forEach((button) => {
    button.addEventListener('click', () => onIgnoreNoteSuggestion(button.dataset.noteSuggestionIgnore));
  });
  view.querySelectorAll('[data-note-suggestion-restore]').forEach((button) => {
    button.addEventListener('click', () => onRestoreNoteSuggestion(button.dataset.noteSuggestionRestore));
  });
  view.querySelectorAll('[data-note-rule-cancel]').forEach((button) => {
    button.addEventListener('click', () => onCancelNoteRuleSetup());
  });
  view.querySelectorAll('[data-note-rule-field]').forEach((field) => {
    field.addEventListener('change', () => {
      const key = field.dataset.noteRuleField;
      const value = key === 'quantity' ? Number(field.value) : field.value;
      onNoteRuleDraftChange({ [key]: value });
    });
  });
  view.querySelectorAll('[data-note-rule-menu-item]').forEach((input) => {
    input.addEventListener('change', () => {
      const menuItemIds = [...view.querySelectorAll('[data-note-rule-menu-item]:checked')].map((entry) => entry.value);
      onNoteRuleDraftChange({ menuItemIds });
    });
  });
  view.querySelectorAll('[data-note-rule-location]').forEach((input) => {
    input.addEventListener('change', () => {
      const locationIds = [...view.querySelectorAll('[data-note-rule-location]:checked')].map((entry) => entry.value);
      onNoteRuleDraftChange({ locationIds });
    });
  });
  view.querySelector('[data-note-rule-save]')?.addEventListener('click', () => onSaveNoteRule());
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
  const statusClass = (item.noRecipeRequired === true || item.recipeStatus === 'NOT_REQUIRED')
    ? 'notRequired'
    : item.status === 'complete' ? 'complete' : 'missing';
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
  const modifierRuleValidation = isModifier ? validateModifierStockRule(getModifierStockRule(item), recipes, item) : '';

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

          ${isModifier ? renderModifierStockActionPanel(item, recipes) : ''}

	        <div class="recipesModule__blueprintGrid ${showModifierPanel ? '' : 'recipesModule__blueprintGrid--single'}">
	          ${renderBaseIngredientPanel(displayRecipe, ingredients, { linkedProductMode, linkedStockItemMode, recipeSourceStockItemName: item.recipeSourceStockItemName || item.recipeSourceStockItem?.name || '', activeLocationId: recipes.activeLocationId || '' })}
	          ${showModifierPanel ? renderModifierCostBreakdown(combinedBreakdown) : ''}
	        </div>

        ${showModifierPanel ? renderCombinedRecipeTotals(combinedBreakdown) : ''}

        ${modifierRuleValidation ? `<div class="recipesModule__inlineError" role="alert">${escapeHtml(modifierRuleValidation)}</div>` : ''}
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
          <button type="button" class="recipesModule__primary" data-recipe-save ${recipes.actionStatus === 'saving' || modifierRuleValidation ? 'disabled' : ''}>
            ${icon('check')}
            <span>${recipes.actionStatus === 'saving' ? 'Saving' : linkedProductMode ? 'Save Link' : 'Save Recipe'}</span>
          </button>
        </footer>
      </section>
      ${isModifier && filters.modifierStockRuleOpen ? renderModifierStockActionDrawer(item, recipes) : ''}
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
  // The visible recipes table intentionally contains menu products only. Modifier
  // options are kept separately so costing can still resolve every attached option.
  const allItems = recipes.allRecipeItems || [
    ...(recipes.items || []),
    ...(recipes.modifierItems || [])
  ];
  const modifierRows = findAttachedModifierRows(item, allItems, attachedGroups)
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
  const totalModifierOptions = attachedGroups.reduce(
    (total, group) => total + Math.max(0, Number(group.modifierCount || 0) || 0),
    0
  ) || modifierRows.length;
  const modifierCostAverage = averageModifierOptionValue(
    modifierRows.map((modifier) => modifier.modifierCost),
    totalModifierOptions
  );
  const modifierPriceAverage = averageModifierOptionValue(
    modifierRows.map((modifier) => modifier.modifierPrice),
    totalModifierOptions
  );
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
    totalModifierOptions,
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
      // Preserve "no UOM chosen" as blank rather than coercing to 'ea'. renderRecipeLine already
      // falls back to the ingredient's base unit for display, and keeping it blank means a
      // round-trip through the editor can no longer persist a bogus unit.
      unit: String(line.unit || line.uom || '').trim()
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
  if (item.noRecipeRequired === true || item.recipeStatus === 'NOT_REQUIRED') return 'No recipe required';
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
  // Only a sub-recipe/manufactured linked item builds its cost from its own recipe lines. A
  // non-stock/raw/virtual item's cost comes straight from its unit_cost — zero recipe lines there
  // is expected, not a problem, so the warning must not fire for it.
  const linkedItemNeedsOwnRecipe = selectedItem && ['sub_recipe', 'manufactured'].includes(getIngredientTypeMeta(selectedItem).value);
  const warning = linkedItemNeedsOwnRecipe && linkedRecipeLines.length === 0
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


function getModifierStockRule(item = {}) {
  const source = item.stockRule && typeof item.stockRule === 'object' ? item.stockRule : {};
  const ownerId = String(item.recipeOwnerId || item.id || '').replace(/^modifier:/, '');
  const fallbackAction = item.recipeCount || getLinkedProductIds(item).length ? 'ADD_RECIPE' : 'NO_STOCK_CHANGE';
  const actionType = String(source.actionType || fallbackAction).toUpperCase();
  return {
    ...source,
    actionType,
    targetOwnerType: String(source.targetOwnerType || (actionType === 'ADD_RECIPE' ? 'yoco_modifier' : actionType === 'ADD_STOCK_ITEM' ? 'stock_item' : '')),
    targetOwnerId: String(source.targetOwnerId || (actionType === 'ADD_RECIPE' ? ownerId : '')),
    sourceStockItemId: String(source.sourceStockItemId || ''),
    replacementStockItemId: String(source.replacementStockItemId || ''),
    quantity: Number(source.quantity || 1) || 1,
    unit: String(source.unit || ''),
    menuItemIds: Array.isArray(source.menuItemIds) ? source.menuItemIds.map(String).filter(Boolean) : [],
    // Modifier stock actions are workspace-wide. Location-specific rules created
    // by older builds are intentionally normalised back to all locations.
    locationIds: [],
    applyAllMatchingProducts: source.applyAllMatchingProducts !== false,
    active: source.active !== false,
    sourceModifierId: String(source.sourceModifierId || item.yocoModifierId || ''),
    sourceModifierGroupId: String(source.sourceModifierGroupId || item.yocoModifierGroupId || ''),
    sourceModifierVariantId: String(source.sourceModifierVariantId || item.yocoModifierVariantId || ''),
    sourceName: String(source.sourceName || item.name || '')
  };
}

function modifierActionLabel(actionType = '') {
  return ({
    ADD_RECIPE: 'Deduct extra recipe',
    ADD_STOCK_ITEM: 'Deduct extra stock item',
    REMOVE_INGREDIENT: 'Remove an ingredient',
    REPLACE_INGREDIENT: 'Replace an ingredient',
    NO_STOCK_CHANGE: 'No stock change'
  })[String(actionType || '').toUpperCase()] || 'Configure stock action';
}

function findModifierRuleEntityName(id = '', recipes = {}) {
  const value = String(id || '');
  return (recipes.items || []).find((entry) => String(entry.id) === value)?.name ||
    (recipes.ingredients || []).find((entry) => String(entry.id) === value)?.name ||
    value || 'the selected item';
}

function buildModifierStockPreview(item = {}, rule = {}, recipes = {}) {
  const quantity = Number(rule.quantity || 1) || 1;
  const currentOwnerId = String(item.recipeOwnerId || item.id || '').replace(/^modifier:/, '');
  const targetName = rule.actionType === 'ADD_RECIPE' && String(rule.targetOwnerType) === 'yoco_modifier' && String(rule.targetOwnerId) === currentOwnerId
    ? String(item.name || 'this modifier')
    : findModifierRuleEntityName(rule.targetOwnerId, recipes);
  const sourceName = findModifierRuleEntityName(rule.sourceStockItemId, recipes);
  const replacementName = findModifierRuleEntityName(rule.replacementStockItemId, recipes);
  const scope = rule.applyAllMatchingProducts || !rule.menuItemIds?.length
    ? 'every matching menu item'
    : `${rule.menuItemIds.length} selected menu item${rule.menuItemIds.length === 1 ? '' : 's'}`;
  const locationScope = ' at all locations';
  switch (rule.actionType) {
    case 'ADD_RECIPE':
      return `When ${item.name || 'this modifier'} is selected, deduct ${quantity} × ${targetName} recipe for ${scope}${locationScope}.`;
    case 'ADD_STOCK_ITEM':
      return `When ${item.name || 'this modifier'} is selected, deduct ${quantity} ${rule.unit || ''} of ${targetName} for ${scope}${locationScope}.`;
    case 'REMOVE_INGREDIENT':
      return `When ${item.name || 'this modifier'} is selected, omit ${sourceName} from the final ingredient usage for ${scope}${locationScope}.`;
    case 'REPLACE_INGREDIENT':
      return `When ${item.name || 'this modifier'} is selected, replace ${sourceName} with ${quantity === 1 ? 'the same' : `${quantity} × the removed`} base-UOM quantity of ${replacementName} for ${scope}${locationScope}.`;
    case 'NO_STOCK_CHANGE':
      return `When ${item.name || 'this modifier'} is selected, no additional or replacement stock movement is created.`;
    default:
      return 'Choose what should happen to stock when this modifier is selected.';
  }
}

function validateModifierStockRule(rule = {}, recipes = {}, item = {}) {
  const actionType = String(rule.actionType || '');
  if (!['ADD_RECIPE', 'ADD_STOCK_ITEM', 'REMOVE_INGREDIENT', 'REPLACE_INGREDIENT', 'NO_STOCK_CHANGE'].includes(actionType)) {
    return 'Choose a valid stock action for this modifier.';
  }
  if ((actionType === 'ADD_RECIPE' || actionType === 'ADD_STOCK_ITEM') && !(Number(rule.quantity) > 0)) {
    return 'Modifier quantity must be greater than zero.';
  }
  if (actionType === 'ADD_RECIPE' && (!rule.targetOwnerType || !rule.targetOwnerId)) {
    return 'Select the recipe that should be deducted.';
  }
  if (actionType === 'ADD_STOCK_ITEM' && !rule.targetOwnerId) {
    return 'Select the stock item that should be deducted.';
  }
  if (actionType === 'REMOVE_INGREDIENT' || actionType === 'REPLACE_INGREDIENT') {
    const baseRecipeItems = getModifierBaseRecipeStockItems(item, rule, recipes);
    if (!baseRecipeItems.length) {
      return 'No replaceable ingredients were found in the linked base recipes. Link menu items or choose a valid menu-item scope first.';
    }
    if (!rule.sourceStockItemId) {
      return 'Select the ingredient that should be removed from the base recipe.';
    }
    if (!baseRecipeItems.some((entry) => String(entry.id) === String(rule.sourceStockItemId))) {
      return 'The original ingredient must come from one of the linked base recipes.';
    }
  }
  if (actionType === 'REPLACE_INGREDIENT' && !rule.replacementStockItemId) {
    return 'Select the replacement ingredient.';
  }
  if (actionType === 'REPLACE_INGREDIENT' && !(Number(rule.quantity) > 0)) {
    return 'Replacement quantity must be greater than zero.';
  }
  if (actionType === 'REPLACE_INGREDIENT' && rule.sourceStockItemId === rule.replacementStockItemId) {
    return 'The replacement ingredient must be different from the original ingredient.';
  }
  if (!rule.applyAllMatchingProducts && !rule.menuItemIds?.length) {
    return 'Select at least one menu item or apply this action to all matching products.';
  }
  return '';
}

function renderModifierStockActionPanel(item = {}, recipes = {}) {
  const rule = getModifierStockRule(item);
  const validation = validateModifierStockRule(rule, recipes, item);
  return `
    <section class="recipesModule__modifierStockPanel ${validation ? 'has-error' : ''}">
      <div class="recipesModule__modifierStockPanelIcon">${icon(rule.actionType === 'NO_STOCK_CHANGE' ? 'minus' : 'layers')}</div>
      <div>
        <span>Stock action</span>
        <strong>${escapeHtml(modifierActionLabel(rule.actionType))}</strong>
        <p>${escapeHtml(buildModifierStockPreview(item, rule, recipes))}</p>
        ${validation ? `<small>${escapeHtml(validation)}</small>` : ''}
      </div>
      <button type="button" data-modifier-stock-open>${icon('settings')}<span>Configure stock action</span></button>
    </section>
  `;
}

function getModifierBaseRecipeStockItems(item = {}, rule = {}, recipes = {}) {
  const products = (recipes.items || []).filter((entry) => !isModifierRecipeItem(entry) && entry.active !== false);
  const stockItems = (recipes.ingredients || []).filter((entry) => entry.active !== false);
  const stockById = new Map(stockItems.map((entry) => [String(entry.id || ''), entry]));
  const productById = new Map(products.map((entry) => [String(entry.id || ''), entry]));
  const productByName = new Map(products.map((entry) => [normalizeRecipeProductName(entry.name), entry]));
  const explicitScopeIds = Array.isArray(rule.menuItemIds) ? rule.menuItemIds.map(String).filter(Boolean) : [];
  const linkedIds = [
    ...(Array.isArray(item.linkedItemIds) ? item.linkedItemIds : []),
    ...getLinkedProductIds(item)
  ].map(String).filter(Boolean);
  const scopeIds = explicitScopeIds.length ? explicitScopeIds : [...new Set(linkedIds)];
  const scopedProducts = scopeIds.map((id) => productById.get(id)).filter(Boolean);
  if (!scopedProducts.length) {
    const linkedNames = [
      ...(Array.isArray(item.linkedItemNames) ? item.linkedItemNames : []),
      ...getLinkedProductNames(item)
    ];
    linkedNames.forEach((name) => {
      const product = productByName.get(normalizeRecipeProductName(name));
      if (product && !scopedProducts.includes(product)) scopedProducts.push(product);
    });
  }

  const ingredientIdsForLines = (lines = [], trail = new Set(), result = new Set()) => {
    for (const line of normalizeRecipeLinesForDisplay(lines)) {
      const id = String(line.ingId || line.stockItemId || '');
      if (!id || trail.has(id)) continue;
      const stockItem = stockById.get(id);
      const nestedLines = stockItem ? getEffectiveRecipeForDisplay(stockItem) : [];
      const explicitType = normalizeRecipeIngredientTypeValue(
        stockItem?.itemType || stockItem?.stockItemType || stockItem?.specificationType || ''
      );
      const engineType = explicitType.replace(/_/g, '');
      const shouldExpandNestedRecipe = Boolean(nestedLines.length && stockItem) && (
        ['subrecipe', 'subrecipeitem', 'prep'].includes(engineType) ||
        stockItem.isStocked === false ||
        Number(stockItem.isStocked) === 0
      );
      if (shouldExpandNestedRecipe) {
        const nextTrail = new Set(trail);
        nextTrail.add(id);
        ingredientIdsForLines(nestedLines, nextTrail, result);
      } else if (stockItem) {
        result.add(id);
      }
    }
    return result;
  };

  const productIngredientSets = scopedProducts.map((product) => ingredientIdsForLines(getEffectiveRecipeForDisplay(product)));
  const ingredientIds = explicitScopeIds.length && productIngredientSets.length
    ? new Set([...productIngredientSets[0]].filter((id) => productIngredientSets.every((set) => set.has(id))))
    : new Set(productIngredientSets.flatMap((set) => [...set]));
  return [...ingredientIds]
    .map((id) => stockById.get(id))
    .filter(Boolean)
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function modifierStockItemUomFactor(item = {}, requestedUnit = '') {
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const baseUnit = normalize(item.unit || item.baseUom || item.base_uom || '');
  const requested = normalize(requestedUnit || item.unit || item.baseUom || item.base_uom || '');
  if (!requested || requested === baseUnit) return 1;
  const collections = [item.uoms, item.customUoms, item.custom_uoms, item.units, item.alternateUoms, item.alternate_uoms];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (normalize(entry?.name || entry?.unit || entry?.uom || entry?.label) !== requested) continue;
      const factor = Number(entry?.ratio ?? entry?.qtyInBase ?? entry?.qty_in_base ?? entry?.factor ?? entry?.baseQty ?? entry?.packSize);
      return Number.isFinite(factor) && factor > 0 ? factor : 1;
    }
  }
  return 1;
}

function getModifierScopedProducts(item = {}, rule = {}, recipes = {}) {
  const products = (recipes.items || []).filter((entry) => !isModifierRecipeItem(entry) && entry.active !== false);
  const productById = new Map(products.map((entry) => [String(entry.id || ''), entry]));
  const productByName = new Map(products.map((entry) => [normalizeRecipeProductName(entry.name), entry]));
  const explicitScopeIds = Array.isArray(rule.menuItemIds) ? rule.menuItemIds.map(String).filter(Boolean) : [];
  const linkedIds = [
    ...(Array.isArray(item.linkedItemIds) ? item.linkedItemIds : []),
    ...getLinkedProductIds(item)
  ].map(String).filter(Boolean);
  const scopeIds = explicitScopeIds.length ? explicitScopeIds : [...new Set(linkedIds)];
  const scopedProducts = scopeIds.map((id) => productById.get(id)).filter(Boolean);
  if (!scopedProducts.length) {
    const linkedNames = [
      ...(Array.isArray(item.linkedItemNames) ? item.linkedItemNames : []),
      ...getLinkedProductNames(item)
    ];
    linkedNames.forEach((name) => {
      const product = productByName.get(normalizeRecipeProductName(name));
      if (product && !scopedProducts.includes(product)) scopedProducts.push(product);
    });
  }
  return scopedProducts;
}

function getModifierSourceQuantityProfile(item = {}, rule = {}, recipes = {}) {
  const sourceId = String(rule.sourceStockItemId || '');
  if (!sourceId) return { baseQuantity: 0, varies: false, quantities: [], unit: '' };
  const stockItems = (recipes.ingredients || []).filter((entry) => entry.active !== false);
  const stockById = new Map(stockItems.map((entry) => [String(entry.id || ''), entry]));
  const sourceItem = stockById.get(sourceId);
  const quantities = [];

  const totalForProduct = (product) => {
    let total = 0;
    const expandLines = (lines = [], multiplier = 1, trail = new Set()) => {
      for (const line of normalizeRecipeLinesForDisplay(lines)) {
        const id = String(line.ingId || line.stockItemId || '');
        if (!id || trail.has(id)) continue;
        const stockItem = stockById.get(id);
        const qty = Math.abs(Number(line.qty ?? line.quantity ?? 0)) || 0;
        const baseQty = qty * modifierStockItemUomFactor(stockItem || {}, line.unit || line.uom || stockItem?.unit) * multiplier;
        if (id === sourceId) {
          total += baseQty;
          continue;
        }
        const nestedLines = stockItem ? getEffectiveRecipeForDisplay(stockItem) : [];
        const explicitType = normalizeRecipeIngredientTypeValue(
          stockItem?.itemType || stockItem?.stockItemType || stockItem?.specificationType || ''
        );
        const engineType = explicitType.replace(/_/g, '');
        const shouldExpandNestedRecipe = Boolean(nestedLines.length && stockItem) && (
          ['subrecipe', 'subrecipeitem', 'prep'].includes(engineType) ||
          stockItem.isStocked === false ||
          Number(stockItem.isStocked) === 0
        );
        if (shouldExpandNestedRecipe) {
          const nextTrail = new Set(trail);
          nextTrail.add(id);
          expandLines(nestedLines, baseQty || multiplier, nextTrail);
        }
      }
    };
    expandLines(getEffectiveRecipeForDisplay(product));
    return total;
  };

  for (const product of getModifierScopedProducts(item, rule, recipes)) {
    const quantity = totalForProduct(product);
    if (quantity > 0) quantities.push(quantity);
  }
  const first = quantities[0] || 0;
  const varies = quantities.some((quantity) => Math.abs(quantity - first) > 0.000001);
  return {
    baseQuantity: !varies ? first : 0,
    varies,
    quantities,
    unit: String(sourceItem?.unit || sourceItem?.baseUom || sourceItem?.base_uom || 'ea')
  };
}

function renderModifierPickerButton({ mode, label, item, placeholder }) {
  return `
    <label class="recipesModule__stockRulePickerField">
      <span>${escapeHtml(label)}</span>
      <button type="button" class="recipesModule__stockRulePickerButton ${item ? 'has-value' : ''}" data-modifier-stock-picker-open="${escapeAttribute(mode)}">
        <span>
          <strong>${escapeHtml(item?.name || placeholder)}</strong>
          <small>${escapeHtml(item?.meta || (item ? 'Selected' : 'Open picker'))}</small>
        </span>
        ${icon('chevron')}
      </button>
    </label>
  `;
}

function renderModifierStockPickerModal({ picker = {}, currentOwnerId = '', item = {}, rule = {}, products = [], stockItems = [], baseRecipeStockItems = [] } = {}) {
  if (!picker?.open) return '';
  const mode = String(picker.mode || '');
  const query = String(picker.query || '').trim().toLowerCase();
  let title = 'Select stock item';
  let candidates = [];
  if (mode === 'recipeTarget') {
    title = 'Select recipe';
    candidates = [
      { value: `yoco_modifier|${currentOwnerId}`, name: 'This modifier recipe', meta: item.name || 'Modifier recipe' },
      ...products.filter((entry) => Number(entry.recipeCount || getEffectiveRecipeForDisplay(entry).length || 0) > 0)
        .map((entry) => ({ value: `product|${entry.id}`, name: entry.name, meta: `${entry.category || 'General'} · menu recipe` })),
      ...stockItems.filter((entry) => Number(entry.recipeCount || getEffectiveRecipeForDisplay(entry).length || 0) > 0)
        .map((entry) => ({ value: `stock_item|${entry.id}`, name: entry.name, meta: `${entry.unit || 'ea'} · stock item recipe` }))
    ];
  } else if (mode === 'source') {
    title = rule.actionType === 'REPLACE_INGREDIENT' ? 'Select ingredient to replace' : 'Select ingredient to remove';
    candidates = baseRecipeStockItems.map((entry) => ({ value: String(entry.id), name: entry.name, meta: `${entry.unit || 'ea'} · base recipe ingredient` }));
  } else if (mode === 'replacement') {
    title = 'Select replacement ingredient';
    candidates = stockItems
      .filter((entry) => String(entry.id) !== String(rule.sourceStockItemId || ''))
      .map((entry) => ({ value: String(entry.id), name: entry.name, meta: `${entry.unit || 'ea'} · replacement stock item` }));
  } else {
    candidates = stockItems.map((entry) => ({ value: String(entry.id), name: entry.name, meta: `${entry.unit || 'ea'} · ${entry.category || 'Stock item'}` }));
  }
  const visible = candidates.filter((entry) => !query || `${entry.name} ${entry.meta}`.toLowerCase().includes(query));
  return `
    <div class="recipesModule__modifierPickerBackdrop" data-modifier-stock-picker-backdrop>
      <section class="recipesModule__modifierPicker" role="dialog" aria-modal="true" aria-labelledby="modifier-stock-picker-title">
        <header>
          <div>
            <p>Stock picker</p>
            <h3 id="modifier-stock-picker-title">${escapeHtml(title)}</h3>
          </div>
          <button type="button" class="recipesModule__iconButton" data-modifier-stock-picker-close aria-label="Close stock picker">${icon('x')}</button>
        </header>
        <label class="recipesModule__modifierPickerSearch">
          <span>Search</span>
          <input type="search" value="${escapeAttribute(picker.query || '')}" placeholder="Search stock items..." data-modifier-stock-picker-search autofocus />
        </label>
        <div class="recipesModule__modifierPickerList">
          ${visible.length ? visible.map((entry) => `
            <button type="button" data-modifier-stock-picker-select="${escapeAttribute(entry.value)}">
              <span>${icon('list')}</span>
              <strong>${escapeHtml(entry.name)}</strong>
              <small>${escapeHtml(entry.meta)}</small>
            </button>
          `).join('') : '<p>No matching items are available.</p>'}
        </div>
      </section>
    </div>
  `;
}

export function renderModifierStockActionDrawer(item = {}, recipes = {}) {
  const rule = getModifierStockRule(item);
  const products = (recipes.items || [])
    .filter((entry) => !isModifierRecipeItem(entry) && entry.active !== false)
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
  const stockItems = (recipes.ingredients || [])
    .filter((entry) => entry.active !== false)
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
  const selectedMenuIds = new Set(rule.menuItemIds || []);
  const currentOwnerId = String(item.recipeOwnerId || item.id || '').replace(/^modifier:/, '');
  const baseRecipeStockItems = getModifierBaseRecipeStockItems(item, rule, { ...recipes, items: products, ingredients: stockItems });
  const sourceItem = stockItems.find((entry) => String(entry.id) === String(rule.sourceStockItemId));
  const replacementItem = stockItems.find((entry) => String(entry.id) === String(rule.replacementStockItemId));
  const targetStockItem = stockItems.find((entry) => String(entry.id) === String(rule.targetOwnerId));
  const targetRecipeItem = rule.targetOwnerType === 'product'
    ? products.find((entry) => String(entry.id) === String(rule.targetOwnerId))
    : rule.targetOwnerType === 'stock_item'
      ? stockItems.find((entry) => String(entry.id) === String(rule.targetOwnerId))
      : { name: 'This modifier recipe', meta: item.name || 'Modifier recipe' };
  const validation = validateModifierStockRule(rule, recipes, item);
  const showAdd = rule.actionType === 'ADD_RECIPE' || rule.actionType === 'ADD_STOCK_ITEM';
  const showSource = rule.actionType === 'REMOVE_INGREDIENT' || rule.actionType === 'REPLACE_INGREDIENT';
  const sourceProfile = getModifierSourceQuantityProfile(item, rule, { ...recipes, items: products, ingredients: stockItems });
  const replacementRatio = Number(rule.quantity || 1) || 1;
  const replacementInputValue = sourceProfile.baseQuantity > 0
    ? sourceProfile.baseQuantity * replacementRatio
    : replacementRatio;
  const replacementUnit = String(replacementItem?.unit || replacementItem?.baseUom || replacementItem?.base_uom || sourceProfile.unit || 'ea');

  return `
    <div class="recipesModule__stockRuleBackdrop" data-modifier-stock-backdrop>
      <aside class="recipesModule__stockRuleDrawer" role="dialog" aria-modal="true" aria-labelledby="modifier-stock-rule-title" data-modifier-owner-id="${escapeAttribute(currentOwnerId)}">
        <header>
          <div>
            <p>Modifier Engine</p>
            <h3 id="modifier-stock-rule-title">What should happen to stock when this is selected?</h3>
            <span>${escapeHtml(item.name || 'Modifier')}</span>
          </div>
          <button type="button" class="recipesModule__iconButton" data-modifier-stock-close aria-label="Close stock action setup">${icon('x')}</button>
        </header>

        <div class="recipesModule__stockRuleBody">
          <fieldset class="recipesModule__stockRuleActions">
            <legend>Stock action</legend>
            ${[
              ['ADD_RECIPE', 'Deduct extra recipe', 'Add the ingredients from a recipe.'],
              ['ADD_STOCK_ITEM', 'Deduct extra stock item', 'Deduct one stock item directly.'],
              ['REMOVE_INGREDIENT', 'Remove an ingredient', 'Omit an ingredient only when it exists in the sold item recipe.'],
              ['REPLACE_INGREDIENT', 'Replace an ingredient', 'Swap the original and control the replacement amount.'],
              ['NO_STOCK_CHANGE', 'No stock change', 'Keep the modifier for reporting only.']
            ].map(([value, label, help]) => `
              <label class="${rule.actionType === value ? 'is-selected' : ''}">
                <input type="radio" name="modifier-stock-action" value="${value}" data-modifier-stock-action ${rule.actionType === value ? 'checked' : ''} />
                <span><strong>${label}</strong><small>${help}</small></span>
              </label>
            `).join('')}
          </fieldset>

          ${showAdd ? `
            <section class="recipesModule__stockRuleSection">
              <h4>Extra stock to deduct</h4>
              ${rule.actionType === 'ADD_RECIPE'
                ? renderModifierPickerButton({
                    mode: 'recipeTarget',
                    label: 'Recipe',
                    item: targetRecipeItem ? { name: targetRecipeItem.name, meta: targetRecipeItem.meta || `${targetRecipeItem.category || targetRecipeItem.unit || 'Recipe'}` } : null,
                    placeholder: 'Choose recipe'
                  })
                : renderModifierPickerButton({
                    mode: 'stockTarget',
                    label: 'Stock item',
                    item: targetStockItem ? { name: targetStockItem.name, meta: `${targetStockItem.unit || 'ea'} · ${targetStockItem.category || 'Stock item'}` } : null,
                    placeholder: 'Choose stock item'
                  })}
              <div class="recipesModule__stockRuleTwoCol">
                <label>
                  <span>Quantity</span>
                  <input type="number" min="0.000001" step="any" value="${escapeAttribute(rule.quantity)}" data-modifier-stock-quantity />
                </label>
                ${rule.actionType === 'ADD_STOCK_ITEM' ? `
                  <label>
                    <span>Unit</span>
                    <input type="text" value="${escapeAttribute(rule.unit || targetStockItem?.unit || '')}" placeholder="Uses base UOM when blank" data-modifier-stock-unit />
                  </label>
                ` : '<div></div>'}
              </div>
            </section>
          ` : ''}

          ${showSource ? `
            <section class="recipesModule__stockRuleSection">
              <h4>${rule.actionType === 'REPLACE_INGREDIENT' ? 'Ingredient replacement' : 'Ingredient to remove'}</h4>
              ${renderModifierPickerButton({
                mode: 'source',
                label: rule.actionType === 'REPLACE_INGREDIENT' ? 'What are we replacing from the base recipe?' : 'What are we removing from the base recipe?',
                item: sourceItem ? { name: sourceItem.name, meta: `${sourceItem.unit || 'ea'} · base recipe ingredient` } : null,
                placeholder: baseRecipeStockItems.length ? 'Choose base-recipe ingredient' : 'No ingredients found in linked recipes'
              })}
              ${rule.actionType === 'REPLACE_INGREDIENT' ? `
                ${renderModifierPickerButton({
                  mode: 'replacement',
                  label: 'What should replace it?',
                  item: replacementItem ? { name: replacementItem.name, meta: `${replacementItem.unit || 'ea'} · replacement stock item` } : null,
                  placeholder: 'Choose replacement ingredient'
                })}
                <label class="recipesModule__stockRuleQuantityField">
                  <span>${sourceProfile.baseQuantity > 0 ? 'Replacement quantity' : 'Replacement quantity multiplier'}</span>
                  <div>
                    <input
                      type="number"
                      min="0.000001"
                      step="any"
                      value="${escapeAttribute(replacementInputValue)}"
                      data-modifier-stock-replacement-quantity
                      data-modifier-stock-source-quantity="${escapeAttribute(sourceProfile.baseQuantity || 0)}"
                    />
                    <strong>${escapeHtml(sourceProfile.baseQuantity > 0 ? replacementUnit : '× removed amount')}</strong>
                  </div>
                  <small>${sourceProfile.baseQuantity > 0
                    ? `The base recipe uses ${sourceProfile.baseQuantity} ${sourceProfile.unit}. The replacement defaults to ${replacementInputValue} ${replacementUnit} but may be increased or reduced.`
                    : 'Linked recipes use different source quantities. Enter a multiplier, where 1 keeps the same amount, 1.5 uses 50% more, and 0.5 uses half.'}</small>
                </label>
                <p class="recipesModule__stockRuleHint">All active stock items are available. The replacement quantity uses the selected item's base UOM.</p>
              ` : '<p class="recipesModule__stockRuleHint">The action is ignored safely on a linked menu item that does not contain this ingredient. No artificial return movement is written.</p>'}
            </section>
          ` : ''}

          ${rule.actionType !== 'NO_STOCK_CHANGE' ? `
            <section class="recipesModule__stockRuleSection">
              <h4>Menu-item scope</h4>
              <label class="recipesModule__stockRuleToggle">
                <input type="checkbox" data-modifier-stock-apply-all ${rule.applyAllMatchingProducts ? 'checked' : ''} />
                <span><strong>Apply to all matching products</strong><small>Use this rule whenever this modifier is selected. Products without the chosen source ingredient are skipped safely.</small></span>
              </label>
              <div class="recipesModule__stockRuleChecklist ${rule.applyAllMatchingProducts ? 'is-disabled' : ''}">
                ${products.slice(0, 150).map((product) => `
                  <label>
                    <input type="checkbox" value="${escapeAttribute(product.id)}" data-modifier-stock-menu-item ${selectedMenuIds.has(String(product.id)) ? 'checked' : ''} ${rule.applyAllMatchingProducts ? 'disabled' : ''} />
                    <span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category || 'General')}</small></span>
                  </label>
                `).join('') || '<p>No menu items are available.</p>'}
              </div>
              <p class="recipesModule__stockRuleHint">This action applies to all locations automatically.</p>
            </section>
          ` : ''}

          <section class="recipesModule__stockRulePreview ${validation ? 'has-error' : ''}">
            <span>Plain-language preview</span>
            <p>${escapeHtml(buildModifierStockPreview(item, rule, recipes))}</p>
            ${validation ? `<small>${escapeHtml(validation)}</small>` : ''}
          </section>
        </div>

        <footer>
          <button type="button" data-modifier-stock-close>Cancel</button>
          <button type="button" class="recipesModule__primary" data-modifier-stock-done ${validation ? 'disabled' : ''}>${icon('check')}<span>Done</span></button>
        </footer>
      </aside>
      ${renderModifierStockPickerModal({
        picker: recipes.modifierStockPicker,
        currentOwnerId,
        item,
        rule,
        products,
        stockItems,
        baseRecipeStockItems
      })}
    </div>
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
    .map((id) => findIngredientById(ingredients, id))
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
  const ingredient = findIngredientById(ingredients, line.ingId);
  const readOnly = options.readOnly === true;
  if (!ingredient) {
    // The ingredient is no longer in the active stock list. Rather than the item never having
    // existed, this is almost always because the stock item was deleted after being used here —
    // the backend still tells us its last-known name/unit (and whether it's deactivated vs. truly
    // gone) via `line.name`/`line.active`, so surface that instead of a bare internal id.
    // Keep the same column count/structure as a normal row (name+detail, qty, uom, cost, remove)
    // so this doesn't blow up the recipesModule__line grid layout.
    const lastKnownName = String(line.name || '').trim();
    const reason = lastKnownName
      ? (line.active === false ? `${lastKnownName} was deleted` : `${lastKnownName} is no longer available`)
      : 'This ingredient no longer exists';
    return `
      <article class="recipesModule__line recipesModule__line--missing">
        <div>
          <strong>${escapeHtml(lastKnownName || 'Missing ingredient')}</strong>
          <span>${escapeHtml(reason)}</span>
        </div>
        <span class="recipesModule__lineUomStatic">&mdash;</span>
        <span class="recipesModule__lineUomStatic">${escapeHtml(String(line.unit || '').toUpperCase())}</span>
        <strong>&mdash;</strong>
        ${readOnly ? '<span></span>' : `<button type="button" data-recipe-line-remove="${index}" aria-label="Remove missing ingredient">${icon('trash')}</button>`}
      </article>
    `;
  }

  const uomOptions = getRecipeLineUomOptions(ingredient);
  const baseUnit = String(ingredient.unit || 'ea').trim() || 'ea';
  const lineUnit = String(line.unit || line.uom || '').trim();
  // A recipe line's unit is forced to 'ea' upstream when no explicit UOM was chosen; only trust it
  // when it matches a real UOM option for this ingredient, otherwise show the ingredient's base UOM.
  const matchedOption = uomOptions.find(
    (opt) => opt.value.toLowerCase() === lineUnit.toLowerCase()
  );
  const selectedUnit = matchedOption ? matchedOption.value : baseUnit;
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


export function renderNoteSuggestionsModal(noteState = {}, recipes = {}) {
  const suggestions = Array.isArray(noteState.items) ? noteState.items : [];
  const editing = suggestions.find((entry) => String(entry.id) === String(noteState.editingId || ''));
  const draft = noteState.draft || null;
  const menuItems = (recipes.items || []).filter((item) => !isModifierRecipeItem(item));
  const ingredients = (recipes.ingredients || []).filter((item) => item?.id);
  const locations = recipes.locations || [];
  const visibleSuggestions = noteState.includeIgnored
    ? suggestions
    : suggestions.filter((entry) => entry.disposition !== 'IGNORED');

  return `
    <div class="recipesModule__modalBackdrop recipesModule__noteBackdrop" data-recipe-note-suggestions-backdrop>
      <section class="recipesModule__modal recipesModule__noteModal" role="dialog" aria-modal="true" aria-labelledby="recipe-note-suggestions-title">
        <header class="recipesModule__modalHeader recipesModule__noteHeader">
          <div>
            <p>Order intelligence</p>
            <h2 id="recipe-note-suggestions-title">Suggestions from orders</h2>
            <span>Notes appear after they have been seen on at least three different order lines. Nothing changes stock until you approve an exact rule.</span>
          </div>
          <button type="button" class="recipesModule__iconButton" data-recipe-note-suggestions-close aria-label="Close suggestions">${icon('x')}</button>
        </header>

        <div class="recipesModule__noteToolbar">
          <label class="recipesModule__noteIgnoredToggle">
            <input type="checkbox" data-recipe-note-include-ignored ${noteState.includeIgnored ? 'checked' : ''} />
            <span>Show ignored notes</span>
          </label>
          <button type="button" class="recipesModule__secondary" data-recipe-note-refresh ${noteState.status === 'loading' || noteState.status === 'saving' ? 'disabled' : ''}>
            ${icon('refresh')}
            <span>${noteState.status === 'loading' ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>

        ${noteState.error ? renderNotice(noteState.error, 'error') : ''}
        ${noteState.status === 'loading' && !visibleSuggestions.length
          ? renderLoadingPanel('Loading order suggestions', 'Reviewing recurring line-item notes without changing stock.')
          : ''}

        <div class="recipesModule__noteContent ${editing && draft ? 'has-editor' : ''}">
          <div class="recipesModule__noteList" aria-label="Recurring order notes">
            ${visibleSuggestions.length
              ? visibleSuggestions.map((suggestion) => renderNoteSuggestionCard(suggestion, recipes, noteState)).join('')
              : noteState.status !== 'loading'
                ? `<div class="recipesModule__noteEmpty">
                    ${icon('sliders')}
                    <strong>No recurring note suggestions yet</strong>
                    <p>New exact phrases will appear here after they are seen at least three times.</p>
                  </div>`
                : ''}
          </div>
          ${editing && draft ? renderNoteRuleEditor(editing, draft, menuItems, ingredients, locations, noteState) : ''}
        </div>

        <footer class="recipesModule__modalFooter recipesModule__noteFooter">
          <span>Matching is exact after safe normalization. “Almond milk” will not match “No almond milk” or “Extra almond milk”.</span>
          <button type="button" data-recipe-note-suggestions-close>Done</button>
        </footer>
      </section>
    </div>
  `;
}

function renderNoteSuggestionCard(suggestion = {}, recipes = {}, noteState = {}) {
  const menuNames = resolveRecipeEntityNames(suggestion.menuItemIds, recipes.items, 'menu item');
  const locationNames = resolveRecipeEntityNames(suggestion.locationIds, recipes.locations, 'location');
  const ignored = suggestion.disposition === 'IGNORED';
  const approved = Boolean(suggestion.rule && suggestion.rule.status === 'APPROVED');
  const active = String(noteState.editingId || '') === String(suggestion.id || '');
  const actionLabel = approved ? modifierNoteActionLabel(suggestion.rule.actionType) : '';
  return `
    <article class="recipesModule__noteCard ${ignored ? 'is-ignored' : ''} ${approved ? 'is-approved' : ''} ${active ? 'is-active' : ''}">
      <div class="recipesModule__noteCardTop">
        <div>
          <span class="recipesModule__notePhrase">${escapeHtml(suggestion.notePhrase || suggestion.normalizedText || '')}</span>
          <small>Exact phrase: ${escapeHtml(suggestion.normalizedText || '')}</small>
        </div>
        <span class="recipesModule__noteStatus recipesModule__noteStatus--${ignored ? 'ignored' : approved ? 'approved' : 'suggested'}">
          ${ignored ? 'Ignored' : approved ? 'Approved' : 'Suggestion'}
        </span>
      </div>
      <dl class="recipesModule__noteFacts">
        <div><dt>Menu items</dt><dd>${escapeHtml(menuNames.join(', '))}</dd></div>
        <div><dt>Locations</dt><dd>${escapeHtml(locationNames.join(', '))}</dd></div>
        <div><dt>Times seen</dt><dd>${escapeHtml(String(suggestion.timesSeen || 0))}</dd></div>
        <div><dt>Last seen</dt><dd>${escapeHtml(formatRecipeDateTime(suggestion.lastSeen))}</dd></div>
      </dl>
      ${approved ? `<div class="recipesModule__noteApprovedRule">${icon('check')}<span>${escapeHtml(actionLabel)} · Rule version ${escapeHtml(String(suggestion.rule.version || 1))}</span></div>` : ''}
      <div class="recipesModule__noteCardActions">
        ${ignored
          ? `<button type="button" class="recipesModule__secondary" data-note-suggestion-restore="${escapeAttribute(suggestion.notePhrase || suggestion.normalizedText || '')}">Restore</button>`
          : `<button type="button" class="recipesModule__primary" data-note-suggestion-setup="${escapeAttribute(suggestion.id || '')}">${approved ? 'Edit setup' : 'Set up'}</button>
             <button type="button" class="recipesModule__secondary" data-note-suggestion-ignore="${escapeAttribute(suggestion.notePhrase || suggestion.normalizedText || '')}">Ignore</button>`}
      </div>
    </article>
  `;
}

function renderNoteRuleEditor(suggestion = {}, draft = {}, menuItems = [], ingredients = [], locations = [], noteState = {}) {
  const actionType = String(draft.actionType || 'NO_STOCK_CHANGE').toUpperCase();
  const actionOptions = [
    ['ADD_RECIPE', 'Add recipe'],
    ['ADD_STOCK_ITEM', 'Add stock item'],
    ['REPLACE_INGREDIENT', 'Replace ingredient'],
    ['REMOVE_INGREDIENT', 'Remove ingredient'],
    ['NO_STOCK_CHANGE', 'No stock change']
  ];
  const needsTarget = ['ADD_RECIPE', 'ADD_STOCK_ITEM'].includes(actionType);
  const needsSource = ['REMOVE_INGREDIENT', 'REPLACE_INGREDIENT'].includes(actionType);
  const needsReplacement = actionType === 'REPLACE_INGREDIENT';
  const needsQuantity = ['ADD_RECIPE', 'ADD_STOCK_ITEM'].includes(actionType);
  const sourceIngredient = findIngredientById(ingredients, draft.sourceStockItemId);
  const targetIngredient = findIngredientById(ingredients, draft.targetOwnerId);
  const targetRecipe = menuItems.find((item) => String(item.id) === String(draft.targetOwnerId || ''));
  const replacementIngredient = findIngredientById(ingredients, draft.replacementStockItemId);
  const preview = actionType === 'ADD_RECIPE'
    ? `Deduct ${Number(draft.quantity || 1)} × ${targetRecipe?.name || 'selected recipe'}`
    : actionType === 'ADD_STOCK_ITEM'
      ? `Deduct ${Number(draft.quantity || 1)} ${draft.unit || targetIngredient?.baseUom || ''} of ${targetIngredient?.name || 'selected stock item'}`
      : actionType === 'REMOVE_INGREDIENT'
        ? `Omit ${sourceIngredient?.name || 'selected ingredient'} from the resolved recipe`
        : actionType === 'REPLACE_INGREDIENT'
          ? `Replace ${sourceIngredient?.name || 'original ingredient'} with ${replacementIngredient?.name || 'replacement ingredient'}`
          : 'Record the note without changing stock';

  return `
    <aside class="recipesModule__noteEditor" aria-label="Set up note rule">
      <div class="recipesModule__noteEditorHeader">
        <div>
          <p>Set up exact note</p>
          <h3>${escapeHtml(suggestion.notePhrase || suggestion.normalizedText || '')}</h3>
        </div>
        <button type="button" class="recipesModule__iconButton" data-note-rule-cancel aria-label="Cancel setup">${icon('x')}</button>
      </div>

      <section class="recipesModule__noteEditorSection">
        <label>
          <span>What should happen to stock?</span>
          <select data-note-rule-field="actionType">
            ${actionOptions.map(([value, label]) => `<option value="${value}" ${actionType === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>

        ${actionType === 'ADD_RECIPE' ? `
          <label>
            <span>Recipe to deduct</span>
            <select data-note-rule-field="targetOwnerId">
              <option value="">Select a recipe</option>
              ${menuItems.map((item) => `<option value="${escapeAttribute(item.id)}" ${String(draft.targetOwnerId || '') === String(item.id) ? 'selected' : ''}>${escapeHtml(item.name || 'Unnamed menu item')}</option>`).join('')}
            </select>
          </label>` : ''}

        ${actionType === 'ADD_STOCK_ITEM' ? `
          <label>
            <span>Stock item to deduct</span>
            <select data-note-rule-field="targetOwnerId">
              <option value="">Select a stock item</option>
              ${renderIngredientOptions(ingredients, draft.targetOwnerId)}
            </select>
          </label>` : ''}

        ${needsSource ? `
          <label>
            <span>Ingredient to ${actionType === 'REPLACE_INGREDIENT' ? 'replace' : 'remove'}</span>
            <select data-note-rule-field="sourceStockItemId">
              <option value="">Select an ingredient</option>
              ${renderIngredientOptions(ingredients, draft.sourceStockItemId)}
            </select>
          </label>` : ''}

        ${needsReplacement ? `
          <label>
            <span>Replacement ingredient</span>
            <select data-note-rule-field="replacementStockItemId">
              <option value="">Select a replacement</option>
              ${renderIngredientOptions(ingredients, draft.replacementStockItemId, draft.sourceStockItemId)}
            </select>
          </label>` : ''}

        ${needsQuantity ? `
          <div class="recipesModule__stockRuleTwoCol">
            <label>
              <span>Quantity</span>
              <input type="number" min="0.000001" step="0.001" value="${escapeAttribute(draft.quantity || 1)}" data-note-rule-field="quantity" />
            </label>
            <label>
              <span>Unit</span>
              <input type="text" value="${escapeAttribute(draft.unit || (actionType === 'ADD_STOCK_ITEM' ? targetIngredient?.baseUom || targetIngredient?.uom || '' : 'ea'))}" placeholder="ea, g, ml" data-note-rule-field="unit" />
            </label>
          </div>` : ''}
      </section>

      <section class="recipesModule__noteEditorSection">
        <div class="recipesModule__noteSectionTitle">
          <div><strong>Menu-item scope</strong><small>Leave all unchecked to apply to every matching product.</small></div>
        </div>
        <div class="recipesModule__stockRuleChecklist">
          ${menuItems.length ? menuItems.map((item) => `
            <label>
              <input type="checkbox" value="${escapeAttribute(item.id)}" data-note-rule-menu-item ${Array.isArray(draft.menuItemIds) && draft.menuItemIds.map(String).includes(String(item.id)) ? 'checked' : ''} />
              <span><strong>${escapeHtml(item.name || 'Unnamed menu item')}</strong><small>${escapeHtml(item.category || 'Uncategorised')}</small></span>
            </label>`).join('') : '<p class="recipesModule__stockRuleHint">No menu items are available.</p>'}
        </div>
      </section>

      <section class="recipesModule__noteEditorSection">
        <div class="recipesModule__noteSectionTitle">
          <div><strong>Location scope</strong><small>Leave all unchecked to apply at every location.</small></div>
        </div>
        <div class="recipesModule__stockRuleChecklist recipesModule__stockRuleChecklist--locations">
          ${locations.length ? locations.map((location) => `
            <label>
              <input type="checkbox" value="${escapeAttribute(location.id || location.value || '')}" data-note-rule-location ${Array.isArray(draft.locationIds) && draft.locationIds.map(String).includes(String(location.id || location.value || '')) ? 'checked' : ''} />
              <span><strong>${escapeHtml(location.name || location.label || 'Unnamed location')}</strong></span>
            </label>`).join('') : '<p class="recipesModule__stockRuleHint">No locations are available.</p>'}
        </div>
      </section>

      <section class="recipesModule__stockRulePreview">
        <strong>When the exact note is selected</strong>
        <p>${escapeHtml(preview)}</p>
        <small>Rule versioning preserves the sale-time decision for future refunds.</small>
      </section>

      ${noteState.error ? `<p class="recipesModule__noteEditorError">${escapeHtml(noteState.error)}</p>` : ''}
      <div class="recipesModule__noteEditorActions">
        <button type="button" data-note-rule-cancel>Cancel</button>
        <button type="button" class="recipesModule__primary" data-note-rule-save ${noteState.status === 'saving' || (needsTarget && !draft.targetOwnerId) || (needsSource && !draft.sourceStockItemId) || (needsReplacement && !draft.replacementStockItemId) ? 'disabled' : ''}>
          ${noteState.status === 'saving' ? 'Saving' : 'Approve exact rule'}
        </button>
      </div>
    </aside>
  `;
}

function renderIngredientOptions(ingredients = [], selectedId = '', excludedId = '') {
  return ingredients
    .filter((item) => String(item.id) !== String(excludedId || ''))
    .map((item) => `<option value="${escapeAttribute(item.id)}" ${String(selectedId || '') === String(item.id) ? 'selected' : ''}>${escapeHtml(item.name || item.itemName || 'Unnamed stock item')}</option>`)
    .join('');
}

function resolveRecipeEntityNames(ids = [], entities = [], fallbackLabel = 'item') {
  const values = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!values.length) return [`All ${fallbackLabel}s`];
  const map = new Map((entities || []).map((entry) => [String(entry.id || entry.value || ''), entry.name || entry.label || entry.title || '']));
  return values.map((id) => map.get(id) || `Unknown ${fallbackLabel}`).filter(Boolean);
}

function modifierNoteActionLabel(actionType = '') {
  return ({
    ADD_RECIPE: 'Add recipe',
    ADD_STOCK_ITEM: 'Add stock item',
    REPLACE_INGREDIENT: 'Replace ingredient',
    REMOVE_INGREDIENT: 'Remove ingredient',
    NO_STOCK_CHANGE: 'No stock change'
  })[String(actionType || '').toUpperCase()] || 'Approved rule';
}

function formatRecipeDateTime(value = '') {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Johannesburg'
  }).format(date);
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
    const matchesRecipeStatus = !filters.recipeStatus || item.status === filters.recipeStatus;
    return matchesQuery && matchesCategory && matchesRecipeStatus;
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

// Client-side dedup (dedupeStockItems in stockService.js) can merge two stock items that share a
// name/category/unit into a single displayed entry, keeping one "primary" id and recording the
// other id(s) in `mergedIds`. A saved recipe line can still reference the id that got merged away
// — a plain `.id` match then fails even though the ingredient is clearly present in the list (just
// under a different primary id), which is exactly what made a real ingredient look "missing" and
// made the recipe screen's ingredient list look inconsistent with the Stock Items tab. Every
// ingredient lookup by id must check `mergedIds` too, not just `.id`.
function findIngredientById(ingredients = [], targetId) {
  const id = String(targetId ?? '').trim();
  if (!id) return null;
  return ingredients.find((entry) => {
    if (String(entry?.id ?? '') === id) return true;
    const mergedIds = String(entry?.mergedIds || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return mergedIds.includes(id);
  }) || null;
}

function calculateRecipeCost(recipe, ingredients, activeLocationId = '') {
  return (recipe || []).reduce((sum, line) => {
    const ingredient = findIngredientById(ingredients, line.ingId);
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
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    minus: '<path d="M5 12h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V20h-3v-.09a1.7 1.7 0 0 0-1.03-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.55-1.03H5v-3h.09A1.7 1.7 0 0 0 6.64 9.94 1.7 1.7 0 0 0 6.3 8.06L6.24 8l2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.33 4.7V4h3v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06A1.7 1.7 0 0 0 19 9.3a1.7 1.7 0 0 0 1.55 1.03H21v3h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    refresh: '<path d="M20 6v6h-6"/><path d="M4 18v-6h6"/><path d="M6.5 8a7 7 0 0 1 11.5-2l2 2"/><path d="M17.5 16a7 7 0 0 1-11.5 2l-2-2"/>',
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
