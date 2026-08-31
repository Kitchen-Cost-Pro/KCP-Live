import '../styles/stock.css';
import { renderLoadingPanel } from './LoadingPanel.js';
import { matchesBarcodeQuery, parseBarcodeValues } from '../utils/barcodes.js';
import { getLocationStock } from '../utils/stockBalances.js';
import { resolveLocationUnitCost } from '../utils/stockCostResolver.js';
import { resolveStockItemSku } from '../utils/stockSku.js';
import { getAccessibleLocationOptions } from '../services/locationAccess.js';
import { deriveStockItemType, stripStockCategoryTypeSuffix } from '../utils/stockItemType.js';

const defaultUoms = ['ea', 'kg', 'g', 'l', 'ml', 'pack', 'case', 'bottle', 'bag', 'box', 'tray', 'portion', 'batch'];

function getAccessibleStockLocationOptions(locations = [], access = {}) {
  const options = getAccessibleLocationOptions(locations, access);
  return options.length ? options : [];
}

function resolveActiveLocationId(locationId = '', options = []) {
  const value = String(locationId || '').trim();
  if (value && options.some((option) => option.value === value)) return value;
  return String(options[0]?.value || '');
}

export function renderStockItems({ state, onStockFilterChange, onStockAction = {} } = {}) {
  const stock = state.stock || {};
  const filters = {
    query: '',
    category: '',
    siteId: '',
    locationId: '',
    openDropdown: '',
    categoryDropdownSearch: '',
    locationDropdownSearch: '',
    locationCostingLocationId: '',
    locationCostingLocationIdDropdownSearch: '',
    locationCostingPickerKind: '',
    itemType: '',
    itemTypeDropdownSearch: '',
    page: 1,
    pageSize: 25,
    ...(stock.filters || {})
  };
  const renderItems = dedupeRenderableStockItems(stock.items || []);
  const locationOptions = getAccessibleStockLocationOptions(stock.locations || [], state.access || {});
  const activeLocationId = resolveActiveLocationId(filters.locationId, locationOptions);
  const activeFilters = { ...filters, locationId: activeLocationId };
  const items = filterStockItems(renderItems, activeFilters, stock.locations || []);
  const paging = getPaging(items, activeFilters);
  const pagedItems = items.slice(paging.startIndex, paging.endIndex);
  const categories = getCategories(stock.categories?.length ? stock.categories : renderItems);
  const uoms = getUomOptions(stock);
  const managerData = getStockManagerData(stock);
  const categoryOptions = [
    { value: '', label: 'All Categories' },
    ...categories.map((category) => ({ value: category, label: category }))
  ];
  const itemTypeOptions = [
    { value: '', label: 'All Item Types' },
    { value: 'standard', label: 'Standard' },
    { value: 'sub_recipe', label: 'Sub-Recipe' },
    { value: 'manufactured', label: 'Manufactured' },
    { value: 'recipe_source', label: 'Non Stock' }
  ];
  const selectedIds = new Set((stock.selectedIds || []).map(String));
  const view = document.createElement('section');
  view.className = 'stockModule';
  view.dataset.openDropdown = filters.openDropdown || '';

  view.innerHTML = `
    <header class="stockModule__header">
      <div>
        <p class="stockModule__eyebrow">Inventory</p>
        <h1>Stock Items</h1>
        <p>Stock master with costs, thresholds, barcodes, VAT state, and location balances.</p>
      </div>
      <div class="stockModule__actions">
        <input type="file" accept=".csv,.json,.xlsx,.xls,text/csv,application/json" hidden data-stock-import-input />
        <input type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden data-location-costing-import-input />
        ${renderActionDropdown(filters.openDropdown, stock.actionStatus, selectedIds.size, filters, locationOptions)}
        ${selectedIds.size ? renderInlineBulkDelete([...selectedIds], stock.actionStatus) : ''}
        <button type="button" class="stockModule__primary" data-stock-add>
          ${icon('plus')}
          <span>Add Ingredient</span>
        </button>
      </div>
    </header>

    <section class="stockModule__controls" aria-label="Stock item filters">
      <label>
        <span>Search</span>
        <div class="stockModule__searchShell">
          <input type="search" value="${escapeAttribute(filters.query)}" placeholder="Name, SKU or barcode..." data-stock-filter="query" />
          <button type="button" data-stock-scan-search aria-label="Scan stock barcode" title="Scan stock barcode">
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
        id: 'locationId',
        label: 'Location',
        value: activeLocationId,
        searchValue: filters.locationDropdownSearch,
        openDropdown: filters.openDropdown,
        options: locationOptions
      })}
      ${renderDropdown({
        id: 'itemType',
        label: 'Stock Item Type',
        value: filters.itemType,
        searchValue: filters.itemTypeDropdownSearch,
        openDropdown: filters.openDropdown,
        options: itemTypeOptions
      })}
    </section>

    ${stock.actionError && !stock.editingItem && !stock.confirmDelete ? renderNotice(stock.actionError, 'error') : ''}
    ${renderStockBody(stock, items, pagedItems, paging, activeFilters, selectedIds, state.settings?.values?.vatRegistered !== false)}
    ${renderStockModal(stock, categories, uoms, stock.locations || [], renderItems, state.settings?.values?.vatRegistered !== false)}
    ${renderStockLocationCostModal(stock, stock.editingItem)}
    ${renderStockLookupPickerModal(stock, categories, uoms)}
    ${renderStockManagerModal(stock, managerData)}
    ${renderLocationCostingPickerModal(filters, locationOptions, stock.actionStatus || '')}
    ${renderImportReviewModal(stock.importReview)}
    ${renderDeleteDialog(stock)}
    ${renderToast(stock.toast)}
  `;

  bindStockEvents(view, stock, onStockFilterChange, onStockAction);
  return view;
}

function dedupeRenderableStockItems(items = []) {
  const byKey = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const key = stockRenderKey(item);
    if (!key) return;
    byKey.set(key, { ...(byKey.get(key) || {}), ...item });
  });
  return [...byKey.values()];
}

function stockRenderKey(item = {}) {
  const id = String(item.id || '').trim();
  if (id) return `id:${id}`;
  return [
    item.name,
    item.category,
    item.unit || item.uom
  ].map((value) => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
}

function bindStockEvents(view, stock, onStockFilterChange, onStockAction) {
  view.querySelectorAll('[data-stock-filter]').forEach((field) => {
    field.addEventListener('input', () => onStockFilterChange?.({ [field.dataset.stockFilter]: field.value, page: 1 }));
    field.addEventListener('change', () => onStockFilterChange?.({ [field.dataset.stockFilter]: field.value, page: 1 }));
  });

  view.querySelectorAll('[data-stock-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.stockDropdown;
      const current = view.dataset.openDropdown || '';
      onStockFilterChange?.({ openDropdown: current === id ? '' : id });
    });
  });

  view.addEventListener('click', (event) => {
    if (!view.dataset.openDropdown || event.target.closest('[data-stock-dropdown-root]')) return;
    onStockFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-stock-dropdown-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const query = String(event.target.value || '').trim().toLowerCase();
      const group = input.dataset.stockDropdownGroup || '';
      const searchKey = input.dataset.stockDropdownSearch || '';
      input.closest('.stockModule__dropdownMenu')?.querySelectorAll('[data-stock-option]').forEach((button) => {
        const isResetOption = !button.dataset.stockOptionValue;
        const label = String(button.dataset.stockOptionLabel || button.textContent || '').toLowerCase();
        button.hidden = (isResetOption && Boolean(query)) || (!isResetOption && Boolean(query) && !label.includes(query));
      });
      if (searchKey) onStockFilterChange?.({ [searchKey]: event.target.value, openDropdown: group });
    });
  });

  view.querySelectorAll('[data-stock-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockFilterChange?.({
        [button.dataset.stockOptionGroup]: button.dataset.stockOptionValue,
        [button.dataset.stockOptionSearchKey]: '',
        page: 1,
        openDropdown: ''
      });
    });
  });

  view.querySelector('[data-stock-page-size]')?.addEventListener('change', (event) => {
    onStockFilterChange?.({ pageSize: Number(event.target.value || 25) || 25, page: 1 });
  });

  view.querySelectorAll('[data-stock-page]').forEach((button) => {
    button.addEventListener('click', () => onStockFilterChange?.({ page: Number(button.dataset.stockPage || 1) || 1 }));
  });

  const importInput = view.querySelector('[data-stock-import-input]');
  view.querySelector('[data-stock-import-trigger]')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) onStockAction.onImport?.(file);
    event.target.value = '';
  });

  const locationCostingInput = view.querySelector('[data-location-costing-import-input]');
  view.querySelector('[data-location-costing-import-trigger]')?.addEventListener('click', () => locationCostingInput?.click());
  locationCostingInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) onStockAction.onLocationCostingImport?.(file);
    event.target.value = '';
  });

  view.querySelectorAll('[data-location-costing-open]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockFilterChange?.({
        locationCostingPickerKind: button.dataset.locationCostingOpen || 'xlsx',
        locationCostingLocationId: '',
        locationCostingLocationIdDropdownSearch: '',
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-location-costing-picker-close]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockFilterChange?.({ locationCostingPickerKind: '', locationCostingLocationIdDropdownSearch: '', openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-location-costing-export]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockAction.onLocationCostingExport?.(button.dataset.locationCostingExport || 'xlsx');
    });
  });

  view.querySelector('[data-location-costing-preview-confirm]')?.addEventListener('click', () => {
    onStockAction.onLocationCostingConfirm?.();
  });

  view.querySelector('[data-location-costing-preview-cancel]')?.addEventListener('click', () => {
    onStockAction.onLocationCostingCancel?.();
  });

  view.querySelectorAll('[data-stock-export]').forEach((button) => {
    button.addEventListener('click', () => onStockAction.onExport?.(button.dataset.stockExport));
  });

  view.querySelector('[data-stock-open-manager]')?.addEventListener('click', () => {
    onStockAction.onOpenManager?.();
  });

  view.querySelectorAll('[data-stock-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => onStockAction.onSelect?.(checkbox.dataset.stockSelect, checkbox.checked));
  });

  view.querySelector('[data-stock-select-all]')?.addEventListener('change', (event) => {
    const ids = parseJsonList(view.querySelector('[data-stock-select-all]')?.dataset.stockSelectAllIds);
    onStockAction.onSelectAll?.(ids, event.target.checked);
  });

  view.querySelector('[data-stock-add]')?.addEventListener('click', () => onStockAction.onEdit?.(null));

  view.querySelector('[data-stock-scan-search]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onStockAction.onScanBarcode?.();
  });

  view.querySelectorAll('[data-stock-edit]').forEach((button) => {
    button.addEventListener('click', () => onStockAction.onEdit?.(button.dataset.stockEdit));
  });

  view.querySelectorAll('[data-stock-delete]').forEach((button) => {
    button.addEventListener('click', () => onStockAction.onRequestDelete?.(button.dataset.stockDelete));
  });

  view.querySelector('[data-stock-delete-selected]')?.addEventListener('click', () => {
    const rawIds = view.querySelector('[data-stock-delete-selected]')?.dataset.stockDeleteSelected || '[]';
    onStockAction.onRequestDelete?.({ ids: parseJsonList(rawIds), mode: 'bulk' });
  });

  view.querySelector('[data-stock-delete-current]')?.addEventListener('click', () => {
    onStockAction.onRequestDelete?.(view.querySelector('[data-stock-delete-current]')?.dataset.stockDeleteCurrent);
  });

  view.querySelectorAll('[data-stock-open-lookup]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onStockAction.onOpenLookup?.(button.dataset.stockOpenLookup);
    });
  });

  view.querySelectorAll('[data-stock-lookup-input]').forEach((input) => {
    input.addEventListener('change', (event) => {
      onStockAction.onLookupFieldChange?.(input.dataset.stockLookupInput, event.target.value);
    });
  });

  view.addEventListener('click', (event) => {
    const suggestion = event.target.closest('[data-stock-lookup-suggest]');
    if (!suggestion || !view.contains(suggestion)) return;
    onStockAction.onLookupUse?.(suggestion.dataset.stockLookupSuggestField, suggestion.dataset.stockLookupSuggest);
  });

  view.querySelectorAll('[data-stock-spec-type]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextType = button.dataset.stockSpecType || 'standard';
      updateSpecificationSelection(button, nextType);
      onStockAction.onDraftFieldChange?.('itemType', nextType);
    });
  });

  view.querySelector('[data-stock-open-recipe-screen]')?.addEventListener('click', (event) => {
    event.preventDefault();
    syncStockDraftFields(view, onStockAction);
    onStockAction.onOpenRecipeScreen?.();
  });

  view.querySelectorAll('[data-stock-section-toggle]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      syncStockDraftFields(view, onStockAction);
      syncStockRecipeQtyFields(view, onStockAction);
      onStockAction.onToggleEditorSection?.(button.dataset.stockSectionToggle || '');
    });
  });

  view.querySelector('[data-stock-close-recipe-screen]')?.addEventListener('click', (event) => {
    event.preventDefault();
    syncStockRecipeQtyFields(view, onStockAction);
    syncStockDraftFields(view, onStockAction);
    onStockAction.onCloseRecipeScreen?.();
  });

  view.querySelector('[data-stock-recipe-search]')?.addEventListener('input', (event) => {
    filterStockRecipePicker(view, event.target.value);
  });

  view.querySelectorAll('[data-stock-recipe-add]').forEach((button) => {
    button.addEventListener('click', () => {
      syncStockRecipeQtyFields(view, onStockAction);
      syncStockDraftFields(view, onStockAction);
      onStockAction.onRecipeLineAdd?.(button.dataset.stockRecipeAdd);
    });
  });

  view.querySelectorAll('[data-stock-recipe-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      syncStockRecipeQtyFields(view, onStockAction);
      syncStockDraftFields(view, onStockAction);
      onStockAction.onRecipeLineRemove?.(Number(button.dataset.stockRecipeRemove));
    });
  });

  view.querySelectorAll('[data-stock-recipe-qty]').forEach((input) => {
    input.addEventListener('input', () => {
      updateRecipePerUnitHints(view);
    });
    input.addEventListener('change', () => {
      onStockAction.onRecipeLineQtyChange?.(Number(input.dataset.stockRecipeQty), input.value);
    });
  });

  view.querySelectorAll('[data-stock-draft-field]').forEach((field) => {
    field.addEventListener('input', () => {
      if (field.dataset.stockDraftField === 'name') {
        refreshSpecificationTagPreview(field.closest('.stockModule__modal'));
      }
      if (field.dataset.stockDraftField === 'yieldBatch') {
        updateRecipePerUnitHints(view);
      }
    });

    field.addEventListener('change', () => {
      onStockAction.onDraftFieldChange?.(
        field.dataset.stockDraftField,
        field.type === 'checkbox' ? field.checked : field.value
      );
    });
  });

  view.querySelector('[data-stock-form]')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.target.closest('button')) return;
    event.preventDefault();
    event.currentTarget.requestSubmit();
  });

  view.querySelector('[data-stock-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const currentItem = stock.editingItem || {};
    const selectedUnit = String(formData.get('unit') ?? currentItem.unit ?? '').trim();
    const cost = formData.has('cost') ? parseNumber(formData.get('cost')) : parseNumber(currentItem.cost);
    const itemType = String(formData.get('itemType') ?? getStockItemType(currentItem) ?? 'standard');
    const recipe = readStockRecipeLinesFromForm(form, currentItem);
    const uomConfigurations = readStockUomConfigurationsFromForm(form, currentItem, selectedUnit);
    onStockAction.onSave?.({
      id: form.dataset.stockItemId || undefined,
      name: formData.get('name') ?? currentItem.name ?? '',
      sku: formData.get('sku') ?? currentItem.sku ?? currentItem.SKU ?? '',
      category: formData.get('category') ?? currentItem.category ?? '',
      unit: selectedUnit,
      cost,
      lowStockThreshold: formData.has('lowStockThreshold') ? (parseNumber(formData.get('lowStockThreshold')) || 5) : (Number(currentItem.lowStockThreshold || 5) || 5),
      parLevel: formData.has('parLevel') ? parseNumber(formData.get('parLevel')) : (Number(currentItem.parLevel || 0) || 0),
      yieldFactor: formData.has('yieldFactor') ? (parseNumber(formData.get('yieldFactor')) || 100) : (Number(currentItem.yieldFactor || 100) || 100),
      yieldBatch: formData.has('yieldBatch') ? (parseNumber(formData.get('yieldBatch')) || 1) : (Number(currentItem.yieldBatch || 1) || 1),
      barcodes: formData.has('barcodes') ? formData.get('barcodes') : (currentItem.barcodes || []),
      vatEnabled: formData.has('vatEnabled') ? formData.get('vatEnabled') === 'on' : currentItem.vatEnabled !== false,
	      itemType,
	      isSubRecipe: itemType === 'sub_recipe',
	      isManufactured: itemType === 'manufactured',
	      isStocked: itemType !== 'sub_recipe',
	      recipe,
	      uomConfigurations
	    });
  });

  view.querySelector('[data-stock-open-location-cost]')?.addEventListener('click', (event) => {
    onStockAction.onOpenLocationCostModal?.(event.currentTarget.dataset.stockOpenLocationCost);
  });

  view.querySelector('[data-stock-close-location-cost]')?.addEventListener('click', () => {
    onStockAction.onCloseLocationCostModal?.();
  });

  view.querySelectorAll('[data-stock-location-cost-field]').forEach((input) => {
    input.addEventListener('change', () => {
      onStockAction.onLocationCostDraftChange?.(input.dataset.stockLocationCostId, input.value);
    });
  });

  view.querySelector('[data-stock-save-location-costs]')?.addEventListener('click', () => {
    onStockAction.onSaveLocationCosts?.(stock.editingItem?.id || '');
  });

  view.querySelectorAll('[data-stock-scan-barcode-input]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const input = button.closest('.stockModule__barcodeShell')?.querySelector('[data-stock-barcodes-input], [data-stock-uom-barcode]');
      const isUomBarcode = input?.hasAttribute('data-stock-uom-barcode');
      await scanBarcodeIntoInput(input, {
        title: isUomBarcode ? 'Scan UOM Barcode' : 'Scan Stock Item Barcode',
        helper: isUomBarcode
          ? 'Scan the barcode for this custom unit of measure.'
          : 'Scan a barcode to attach it to this stock item.'
      });
    });
  });

  view.querySelectorAll('[data-stock-close]').forEach((button) => {
    button.addEventListener('click', () => onStockAction.onClose?.());
  });

  view.querySelectorAll('[data-stock-manager-close]').forEach((button) => {
    button.addEventListener('click', () => onStockAction.onCloseManager?.());
  });

  view.querySelectorAll('[data-stock-manager-create-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      onStockAction.onManagerCreate?.(form.dataset.stockManagerCreateForm);
    });
  });

  view.querySelectorAll('[data-stock-manager-input]').forEach((input) => {
    input.addEventListener('input', (event) => {
      onStockAction.onPreserveFocus?.(input);
      onStockAction.onManagerDraftChange?.(input.dataset.stockManagerInput, event.target.value);
    });
  });

  view.querySelectorAll('[data-stock-manager-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      onStockAction.onPreserveFocus?.(input);
      onStockAction.onManagerSearchChange?.(input.dataset.stockManagerSearch, event.target.value);
    });
  });

  view.querySelectorAll('[data-stock-manager-rename-start]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockAction.onManagerRenameStart?.(button.dataset.stockManagerRenameType, button.dataset.stockManagerRenameStart);
    });
  });

  view.querySelectorAll('[data-stock-manager-rename-input]').forEach((input) => {
    input.addEventListener('input', (event) => {
      onStockAction.onPreserveFocus?.(input);
      onStockAction.onManagerRenameChange?.(input.dataset.stockManagerRenameInput, event.target.value);
    });
  });

  view.querySelectorAll('[data-stock-manager-rename-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      onStockAction.onManagerRenameSave?.(form.dataset.stockManagerRenameForm);
    });
  });

  view.querySelectorAll('[data-stock-manager-rename-cancel]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockAction.onManagerRenameCancel?.(button.dataset.stockManagerRenameCancel);
    });
  });

  view.querySelectorAll('[data-stock-manager-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockAction.onManagerDelete?.(button.dataset.stockManagerDeleteType, button.dataset.stockManagerDelete);
    });
  });

  view.querySelectorAll('[data-stock-lookup-picker-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      onStockAction.onPreserveFocus?.(input);
      onStockAction.onLookupSearch?.(event.target.value);
    });
  });

  view.querySelectorAll('[data-stock-lookup-picker-use]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockAction.onLookupUse?.(button.dataset.stockLookupPickerField, button.dataset.stockLookupPickerUse);
    });
  });

  view.querySelectorAll('[data-stock-lookup-picker-close]').forEach((button) => {
    button.addEventListener('click', () => onStockAction.onCloseLookup?.());
  });

  view.querySelector('[data-stock-confirm-delete]')?.addEventListener('click', () => {
    onStockAction.onConfirmDelete?.();
  });

  view.querySelector('[data-stock-cancel-delete]')?.addEventListener('click', () => {
    onStockAction.onCancelDelete?.();
  });

  view.querySelector('[data-stock-toast-close]')?.addEventListener('click', () => {
    onStockAction.onDismissToast?.();
  });

  view.querySelector('[data-stock-import-review-close]')?.addEventListener('click', () => {
    onStockAction.onDismissImportReview?.();
  });

  bindStockTooltips(view);
}

function renderDropdown({ id, label, value, searchValue = '', openDropdown, options }) {
  const optionList = Array.isArray(options) ? options : [];
  const activeOption = optionList.find((option) => String(option.value) === String(value)) || optionList[0] || { value: '', label: 'Select' };
  const isOpen = openDropdown === id;
  const searchKey = id === 'locationId'
    ? 'locationDropdownSearch'
    : id === 'locationCostingLocationId'
      ? 'locationCostingLocationIdDropdownSearch'
      : id === 'itemType'
        ? 'itemTypeDropdownSearch'
        : `${id}DropdownSearch`;
  const query = String(searchValue || '').trim().toLowerCase();
  const visibleOptions = optionList.filter((option, index) => {
    const isResetOption = index === 0 && !option.value;
    if (isResetOption) return !query;
    return !query || String(option.label || '').toLowerCase().includes(query);
  });

  return `
    <div class="stockModule__dropdown ${isOpen ? 'stockModule__dropdown--open' : ''}" data-stock-dropdown-root>
      <span>${escapeHtml(label)}</span>
      <button type="button" data-stock-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(activeOption.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="stockModule__dropdownMenu">
        <input
          type="search"
          value="${escapeAttribute(searchValue)}"
          placeholder="Search ${escapeAttribute(label.toLowerCase())}..."
          data-stock-dropdown-search="${escapeAttribute(searchKey)}"
          data-stock-dropdown-group="${escapeAttribute(id)}"
        />
        <div class="stockModule__dropdownOptions">
          ${visibleOptions.length ? visibleOptions.map((option) => `
            <button
              type="button"
              data-stock-option
              data-stock-option-group="${escapeAttribute(id)}"
              data-stock-option-value="${escapeAttribute(option.value)}"
              data-stock-option-search-key="${escapeAttribute(searchKey)}"
              data-stock-option-label="${escapeAttribute(option.label || '')}"
              class="${String(option.value) === String(value) ? 'is-active' : ''}"
            >
              ${escapeHtml(option.label)}
            </button>
          `).join('') : '<em class="stockModule__dropdownEmpty">No locations found.</em>'}
        </div>
      </div>
    </div>
  `;
}


function renderLocationCostingPickerModal(filters = {}, locationOptions = [], actionStatus = '') {
  const kind = String(filters.locationCostingPickerKind || '').toLowerCase();
  if (!['xlsx', 'pdf'].includes(kind)) return '';
  const selectedLocation = (locationOptions || []).find((option) => String(option.value) === String(filters.locationCostingLocationId || ''));
  const isBusy = ['exporting-location-costing', 'importing-location-costing', 'saving-location-costing'].includes(actionStatus);
  const title = kind === 'pdf' ? 'Location Costing PDF Report' : 'Location Costing XLSX Template';
  const hint = kind === 'pdf'
    ? 'Select one location to download a bulk costing report for that location.'
    : 'Select one location to download the editable costing sheet template. Uploads use the location metadata inside the XLSX file.';
  return `
    <div class="stockModule__modalBackdrop stockModule__locationCostingBackdrop" role="presentation">
      <section class="stockModule__modal stockModule__locationCostingModal" role="dialog" aria-modal="true" aria-labelledby="location-costing-picker-title">
        <header>
          <div>
            <p>Location Costing</p>
            <h2 id="location-costing-picker-title">${escapeHtml(title)}</h2>
          </div>
          <button type="button" class="stockModule__iconButton" data-location-costing-picker-close aria-label="Close">${icon('x')}</button>
        </header>
        <div class="stockModule__locationCostingModalBody">
          <p>${escapeHtml(hint)}</p>
          <label class="stockModule__locationCostingPickerField">
            <span>Costing Location</span>
            ${renderDropdown({
              id: 'locationCostingLocationId',
              label: 'Location',
              value: filters.locationCostingLocationId || '',
              searchValue: filters.locationCostingLocationIdDropdownSearch || '',
              openDropdown: filters.openDropdown,
              options: locationOptions.filter((option) => option.value)
            })}
          </label>
        </div>
        <footer class="stockModule__locationCostingModalFooter">
          <button type="button" class="stockModule__secondary" data-location-costing-picker-close>Cancel</button>
          ${kind === 'xlsx' ? `
            <button type="button" class="stockModule__primary" data-location-costing-export="xlsx" ${!selectedLocation || isBusy ? 'disabled' : ''}>
              ${icon('download')}<span>${actionStatus === 'exporting-location-costing' ? 'Exporting...' : 'Download XLSX Template'}</span>
            </button>
          ` : `
            <button type="button" class="stockModule__primary" data-location-costing-export="pdf" ${!selectedLocation || isBusy ? 'disabled' : ''}>
              ${icon('download')}<span>${actionStatus === 'exporting-location-costing' ? 'Exporting...' : 'Download PDF'}</span>
            </button>
          `}
        </footer>
      </section>
    </div>
  `;
}


function renderLocationCostingSection(stock = {}, locationOptions = [], filters = {}) {
  const locationValue = filters.locationCostingLocationId || '';
  const preview = stock.locationCostingPreview || null;
  const status = stock.actionStatus || '';
  const selectedLocation = locationOptions.find((option) => String(option.value) === String(locationValue));
  return `
    <section class="stockModule__locationCostingCard" aria-label="Location costing import and export">
      <div class="stockModule__locationCostingIntro">
        <div>
          <p class="stockModule__eyebrow">Per Location Costing</p>
          <h2>Location Costing Import / Export</h2>
          <p>Export a simple cost sheet for one location, update the New Cost Ex VAT column, then import it back. This only updates costs for the selected location.</p>
        </div>
        <span class="stockModule__locationCostingBadge">Separate from stock item import</span>
      </div>
      <div class="stockModule__locationCostingControls">
        ${renderDropdown({
          id: 'locationCostingLocationId',
          label: 'Costing Location',
          value: locationValue,
          searchValue: filters.locationCostingLocationIdDropdownSearch || '',
          openDropdown: filters.openDropdown,
          options: [{ value: '', label: 'Select location' }, ...locationOptions.filter((option) => option.value)]
        })}
        <button type="button" class="stockModule__secondary" data-location-costing-export ${!selectedLocation || status === 'exporting-location-costing' ? 'disabled' : ''}>
          ${icon('download')}
          <span>${status === 'exporting-location-costing' ? 'Exporting...' : 'Export Location Cost Sheet'}</span>
        </button>
        <button type="button" class="stockModule__secondary" data-location-costing-import-trigger ${!selectedLocation || status === 'importing-location-costing' ? 'disabled' : ''}>
          ${icon('upload')}
          <span>${status === 'importing-location-costing' ? 'Reading...' : 'Upload Cost Sheet'}</span>
        </button>
      </div>
      ${preview ? renderLocationCostingPreview(preview, status) : ''}
    </section>
  `;
}

function renderLocationCostingPreview(preview = {}, status = '') {
  const summary = preview.summary || {};
  const rows = preview.rows || [];
  const blockingErrors = Number(summary.errors || 0) > 0;
  const canConfirm = Number(summary.toUpdate || 0) > 0 && !blockingErrors && status !== 'saving-location-costing';
  return `
    <div class="stockModule__locationCostingPreview">
      <div class="stockModule__locationCostingSummary">
        ${[
          ['Location', preview.locationName || summary.locationName || 'Selected location'],
          ['Rows read', summary.totalRows ?? rows.length],
          ['Matched', summary.matched ?? 0],
          ['Not matched', summary.notMatched ?? 0],
          ['Unchanged', summary.unchanged ?? 0],
          ['To update', summary.toUpdate ?? 0],
          ['Errors', summary.errors ?? 0]
        ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('')}
      </div>
      ${Number(summary.toUpdate || 0) === 0 && !blockingErrors ? '<div class="stockModule__costingEmpty">No changes found.</div>' : ''}
      <div class="stockModule__costingPreviewTable" role="region" aria-label="Location costing import preview">
        <table>
          <thead>
            <tr>
              <th>Row</th>
              <th>Item Name</th>
              <th>SKU / Barcode</th>
              <th>Current Cost Ex VAT</th>
              <th>New Cost Ex VAT</th>
              <th>Status</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            ${rows.slice(0, 100).map((row) => `
              <tr class="stockModule__costingRow--${escapeAttribute(row.status || 'ignored')}">
                <td>${escapeHtml(String(row.rowNumber || ''))}</td>
                <td>${escapeHtml(row.itemName || '')}</td>
                <td>${escapeHtml(row.skuBarcode || '')}</td>
                <td>${escapeHtml(formatNumber(row.currentCostExVat))}</td>
                <td>${escapeHtml(row.newCostExVat === '' || row.newCostExVat == null ? '' : formatNumber(row.newCostExVat))}</td>
                <td>${escapeHtml(formatCostingStatus(row.status))}</td>
                <td>${escapeHtml(row.error || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${rows.length > 100 ? `<p class="stockModule__costingTableNote">Showing first 100 of ${rows.length} rows.</p>` : ''}
      </div>
      <div class="stockModule__locationCostingActions">
        <button type="button" class="stockModule__secondary" data-location-costing-preview-cancel>Cancel</button>
        <button type="button" class="stockModule__primary" data-location-costing-preview-confirm ${canConfirm ? '' : 'disabled'}>
          ${status === 'saving-location-costing' ? 'Applying...' : 'Confirm Import'}
        </button>
      </div>
    </div>
  `;
}

function formatCostingStatus(status = '') {
  const map = { update: 'To update', unchanged: 'Unchanged', ignored: 'Ignored', error: 'Error' };
  return map[status] || status || 'Unknown';
}

function renderStockBody(stock, items, pagedItems, paging, filters, selectedIds, vatRegistered = true) {
  if (stock.status === 'loading') {
    return renderLoadingPanel('Loading stock items', 'Fetching inventory, costs, categories, UOMs, and location balances.');
  }

  if (stock.status === 'error') {
    return renderNotice(stock.error || 'Could not load stock items.', 'error');
  }

  if (!items.length) {
    return renderNotice('No inventory records found.', 'empty');
  }

  const allVisibleSelected = pagedItems.length > 0 && pagedItems.every((item) => selectedIds.has(String(item.id)));

  return `
    <div class="stockModule__list" data-scroll-key="stock-items-list">
      <div class="stockModule__tableBar">
        <div>
          <strong>${items.length} item${items.length === 1 ? '' : 's'}</strong>
          <span>Showing ${paging.total ? paging.startIndex + 1 : 0}-${paging.endIndex} of ${paging.total}</span>
        </div>
        <label class="stockModule__pageSize">
          <span>Rows</span>
          <select data-stock-page-size>
            ${[25, 50, 100].map((size) => `<option value="${size}" ${paging.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="stockModule__listHead">
        <label title="Select all visible stock items on this page."><input type="checkbox" data-stock-select-all data-stock-select-all-ids="${escapeAttribute(JSON.stringify(pagedItems.map((item) => item.id)))}" ${allVisibleSelected ? 'checked' : ''} /></label>
        <span>${withInfo('Ingredient', 'Stock item name, barcode details, VAT state, and item type badges.')}</span>
        <span>${withInfo('SKU', 'Stock keeping unit code used for supplier or internal reference.')}</span>
        <span>${withInfo('Category', 'Inventory category used for filtering, routing, exports, and recipe grouping.')}</span>
        <span>${withInfo('Ex VAT Cost', 'Latest ex-VAT unit cost used for stock valuation and recipe costing.')}</span>
        <span>${withInfo('On Hand', 'Current stock balance for the selected location, shown in the base UOM.')}</span>
        <span>${withInfo('Action', 'Edit or delete this stock item.')}</span>
      </div>
      ${pagedItems.map((item) => renderStockRow(item, filters.locationId, stock.locations || [], selectedIds.has(String(item.id)), vatRegistered)).join('')}
      <div class="stockModule__tableFooter">
        <span>${paging.total ? `${paging.startIndex + 1}-${paging.endIndex}` : '0'} of ${paging.total} items</span>
        <div class="stockModule__pager" aria-label="Pagination">
          <button type="button" data-stock-page="${paging.page - 1}" ${paging.page <= 1 ? 'disabled' : ''}>${icon('chevronLeft')}</button>
          <strong>Page ${paging.page} of ${paging.totalPages}</strong>
          <button type="button" data-stock-page="${paging.page + 1}" ${paging.page >= paging.totalPages ? 'disabled' : ''}>${icon('chevronRight')}</button>
        </div>
      </div>
    </div>
  `;
}

function renderStockRow(item, locationId, locations = [], selected = false, vatRegistered = true) {
  const onHand = locationId ? getLocationStock(item, locationId, locations) : Number(item.stock || 0);
  const itemType = getStockItemType(item);
  const isPhysicalStock = itemType !== 'sub_recipe';
  const isLow = isPhysicalStock && onHand < Number(item.lowStockThreshold || 5);
  const barcodeLabel = parseBarcodeValues(item.barcodes ?? item.barcode ?? item.Barcodes ?? item.Barcode).join(', ') || 'No barcode';
  const locationCost = resolveLocationUnitCost(item, locationId);
  // The pill reflects the item's own VATable-vs-Zero-Rated classification (item.vatEnabled),
  // never the workspace's VAT-registration status — those are independent facts. A VATable item
  // stays labelled "With VAT" even when the workspace isn't VAT registered (no VAT is charged in
  // that case, which the tooltip explains), rather than being relabelled "Without VAT" as if it
  // were the same thing as a genuinely Zero-Rated item.
  const itemIsVatable = item.vatEnabled !== false;
  const vatPillTitle = !vatRegistered
    ? (itemIsVatable
        ? 'This item is VATable, but no VAT is charged because the workspace is not VAT registered.'
        : 'This item is VAT-exempt (Zero-Rated).')
    : itemIsVatable
      ? 'This item carries VAT. Its stored cost is treated as ex-VAT.'
      : 'This item is VAT-exempt.';

  return `
    <article class="stockModule__row ${selected ? 'is-selected' : ''}">
      <label><input type="checkbox" data-stock-select="${escapeAttribute(item.id)}" ${selected ? 'checked' : ''} /></label>
      <div>
        <h2>
          ${escapeHtml(getStockItemDisplayName(item))}
	          ${itemType === 'sub_recipe' ? '<em class="stockModule__pill stockModule__pill--purple" title="Sub-Recipe: used inside recipes, has no stock-on-hand balance, and cannot be ordered.">Sub-Recipe</em>' : ''}
	          ${itemType === 'manufactured' ? '<em class="stockModule__pill stockModule__pill--amber" title="Prep / Manufactured: produced in batches and tracked as its own stock item.">Prep</em>' : ''}
	          ${itemType === 'recipe_source' ? '<em class="stockModule__pill stockModule__pill--purple" title="Non Stock: separate from Sub-Recipe. It can carry stock on hand and be counted, but it cannot be used as a recipe ingredient.">Non Stock</em>' : ''}
          <em class="stockModule__pill ${itemIsVatable ? 'stockModule__pill--green' : 'stockModule__pill--amber'}" title="${escapeAttribute(vatPillTitle)}">${itemIsVatable ? 'With VAT' : 'Without VAT'}</em>
          ${isLow ? '<em class="stockModule__pill stockModule__pill--red">LOW</em>' : ''}
        </h2>
        <p>${escapeHtml(barcodeLabel)}</p>
      </div>
      <span class="stockModule__sku">${escapeHtml(formatStockItemSkuProduct(item))}</span>
      <span>${escapeHtml(formatStockCategoryDisplay(item))}</span>
      <strong>${formatCurrency(locationCost)}</strong>
      <strong ${isPhysicalStock ? '' : 'title="Sub-Recipe items do not carry stock-on-hand. Their ingredients are depleted when used in recipes."'}>${isPhysicalStock ? `${onHand.toFixed(3)} ${escapeHtml(item.unit || '')}` : '-'}</strong>
      <div class="stockModule__rowActions">
        ${renderIconButton('edit', 'Edit stock item', `data-stock-edit="${escapeAttribute(item.id)}"`)}
        ${renderIconButton('trash', 'Delete stock item', `data-stock-delete="${escapeAttribute(item.id)}"`)}
      </div>
    </article>
  `;
}


function formatStockItemSkuProduct(item = {}) {
  return getStockItemSku(item);
}

function getStockItemSku(item = {}) {
  return resolveStockItemSku(
    getStockItemDisplayName(item),
    item.sku,
    item.SKU,
    item.skuCode,
    item.stockCode,
    item.itemCode,
    item.customSku,
    item.code,
  );
}

function renderActionDropdown(openDropdown, actionStatus, selectedCount, filters = {}, locationOptions = []) {
  const isOpen = openDropdown === 'stockActions';
  return `
    <div class="stockModule__dropdown stockModule__actionDropdown ${isOpen ? 'stockModule__dropdown--open' : ''}" data-stock-dropdown-root>
      <button type="button" data-stock-dropdown="stockActions" aria-expanded="${isOpen}">
        ${icon('download')}
        <strong>Action Items</strong>
        ${icon('chevron')}
      </button>
      <div class="stockModule__dropdownMenu">
        <button type="button" data-stock-import-trigger ${actionStatus === 'importing' ? 'disabled' : ''}>
          ${icon('upload')}
          <span>${actionStatus === 'importing' ? 'Importing' : 'Import Bulk'}</span>
        </button>
        <button type="button" data-stock-open-manager>
          ${icon('folder')}
          <span>Category &amp; UOM Management</span>
        </button>
        <span class="stockModule__fileDivider">Export Templates</span>
        <button type="button" data-stock-export="template-xlsx">${icon('download')}<span>XLSX Template</span></button>
        <span class="stockModule__fileDivider">${selectedCount ? `Export Selected (${selectedCount})` : 'Export Visible'}</span>
        <button type="button" data-stock-export="xlsx">${icon('download')}<span>XLSX</span></button>
        <button type="button" data-stock-export="pdf">${icon('download')}<span>PDF</span></button>
        <span class="stockModule__fileDivider">Location Costing</span>
        <button type="button" data-location-costing-import-trigger ${actionStatus === 'importing-location-costing' || actionStatus === 'saving-location-costing' ? 'disabled' : ''}>
          ${icon('upload')}
          <span>${actionStatus === 'importing-location-costing' || actionStatus === 'saving-location-costing' ? 'Updating Costs' : 'Upload XLSX'}</span>
        </button>
        <button type="button" data-location-costing-open="xlsx">
          ${icon('download')}
          <span>XLSX Cost Sheet Template</span>
        </button>
        <button type="button" data-location-costing-open="pdf">
          ${icon('download')}
          <span>PDF Cost Report</span>
        </button>
      </div>
    </div>
  `;
}

function renderInlineBulkDelete(selectedIds, actionStatus) {
  return `
    <button
      type="button"
      data-stock-delete-selected="${escapeAttribute(JSON.stringify(selectedIds))}"
      class="stockModule__danger stockModule__bulkDeleteInline"
      ${actionStatus === 'deleting' ? 'disabled' : ''}
    >
      ${icon('trash')}
      <span>${actionStatus === 'deleting' ? 'Deleting' : `Delete Selected (${selectedIds.length})`}</span>
    </button>
  `;
}

function renderStockModal(stock, categories = [], uoms = [], locations = [], stockItems = [], vatRegistered = true) {
  if (!stock.editingItem) return '';
  const rawItem = stock.editingItem || {};
  const item = rawItem.id === '__new__' ? { ...rawItem, id: '' } : rawItem;
  const categoryOptions = getCategorySelectOptions(categories, '');
  const unitOptions = getUnitSelectOptions(uoms, '');
  const activeLookupField = item.__activeLookupField || '';
  const currentUnit = activeLookupField === 'unit'
    ? String(item.unit ?? '')
    : String(item.unit ?? '').trim();
  const currentCategory = activeLookupField === 'category'
    ? String(item.category ?? '')
    : (String(item.category ?? '').trim() ? getStockCategoryBase(item) : '');
  const confirmedLookups = item.__confirmedLookups || {};
  const itemType = getStockItemType(item);
  const displayName = getStockItemDisplayName(item);
	  // Non Stock ("recipe_source") items are simple purchased items with no bill-of-materials —
	  // they are stocked/counted as-is, not assembled from other ingredients — so they must not be
	  // treated as "recipe-backed" like Sub-Recipe/Manufactured items. Showing an ingredients screen
	  // for them (and requiring one to save) was the source of the "Non Stock" recipe-assignment bug.
	  const isRecipeBackedItem = ['sub_recipe', 'manufactured'].includes(itemType);
  const recipe = normalizeStockRecipe(item.recipe);
  const showRecipeScreen = Boolean(item.__recipeScreenOpen && isRecipeBackedItem);
  const barcodeInputValue = parseBarcodeValues(item.barcodes ?? item.barcode ?? item.Barcodes ?? item.Barcode).join(', ');
  const uomConfigRows = getEditableUomConfigurationRows(item, currentUnit);
  const openSections = getStockEditorOpenSections(item);
  const isDetailsOpen = openSections.has('details');
  const isUomConfigOpen = openSections.has('uom');
  return `
    <div class="stockModule__modalBackdrop" role="presentation">
      <section class="stockModule__modal stockModule__modal--sheet" role="dialog" aria-modal="true" aria-labelledby="stock-modal-title">
        <div class="stockModule__sheetHandle" aria-hidden="true"></div>
        <header>
          <div>
            <p>Stock Master</p>
            <h2 id="stock-modal-title">${item.id ? 'Modify System Master' : 'Create New Entry'}</h2>
          </div>
          <button type="button" class="stockModule__iconButton" data-stock-close aria-label="Close stock form">${icon('x')}</button>
        </header>
        <form data-stock-form data-stock-item-id="${escapeAttribute(item.id || '')}">
          ${showRecipeScreen ? renderStockRecipeScreen(item, stockItems) : `
          <section class="stockModule__sheetPanel stockModule__sheetPanel--collapsible ${isDetailsOpen ? 'is-open' : 'is-closed'}" data-stock-editor-section="details">
            <button type="button" class="stockModule__sectionToggle" data-stock-section-toggle="details" aria-expanded="${isDetailsOpen}">
              <span>
                <strong>1. Item Details</strong>
                <em>Name, category, UOM, cost, barcodes, VAT, and item type.</em>
              </span>
              ${icon('chevron')}
            </button>
            <div class="stockModule__sectionBody">
              <div class="stockModule__formGrid">
              <label>
                <span>Component Name</span>
                <input name="name" value="${escapeAttribute(displayName || '')}" data-stock-draft-field="name" required />
              </label>
              <label>
                <span>${withInfo('SKU', 'Editable stock keeping unit used for purchasing, imports, and product references.')}</span>
                <input name="sku" value="${escapeAttribute(getStockItemSku(item))}" data-stock-draft-field="sku" placeholder="Leave blank to use SKU - Item Name" />
              </label>
              <label>
                <span>${withInfo('Category', 'Controlled category list built from existing stock items to keep spelling consistent.')}</span>
                ${renderLookupField({
                  field: 'category',
                  value: currentCategory,
                  placeholder: 'Type or browse category',
                  options: categoryOptions,
                  confirmedValue: confirmedLookups.category,
                  activeField: activeLookupField
                })}
              </label>
              <label>
                <span>${withInfo('Unit', 'Unit of measure used in stock balances, purchasing, and recipes.')}</span>
                ${renderLookupField({
                  field: 'unit',
                  value: currentUnit,
                  placeholder: 'Type or browse UOM',
                  options: unitOptions,
                  confirmedValue: confirmedLookups.unit,
                  activeField: activeLookupField
                })}
              </label>
              <label>
                <span>${withInfo('Unit Cost', 'Latest ex-VAT unit cost used for stock valuation and recipe costing.')}</span>
                <div class="stockModule__costFieldShell">
                  <input name="cost" type="text" inputmode="decimal" value="${escapeAttribute(String(item.cost || 0))}" data-stock-draft-field="cost" />
                  ${item.id ? `
                    <button type="button" class="stockModule__costByLocationButton" data-stock-open-location-cost="${escapeAttribute(item.id)}">
                      ${icon('mapPin')}<span>Cost by Location</span>
                    </button>
                  ` : ''}
                </div>
              </label>
              <label>
                <span>${withInfo('Threshold', 'Low-stock alert quantity. Items below this level show a LOW badge.')}</span>
                <input name="lowStockThreshold" type="text" inputmode="decimal" value="${escapeAttribute(String(item.lowStockThreshold || 5))}" data-stock-draft-field="lowStockThreshold" />
              </label>
              <label>
                <span>${withInfo('Par Level', 'Ideal replenishment quantity to keep on hand for normal operations.')}</span>
                <input name="parLevel" type="text" inputmode="decimal" value="${escapeAttribute(String(item.parLevel || 0))}" data-stock-draft-field="parLevel" />
              </label>
              <label>
                <span>${withInfo('Yield %', 'Usable yield after trimming, waste, or processing loss.')}</span>
                <input name="yieldFactor" type="text" inputmode="decimal" value="${escapeAttribute(String(item.yieldFactor || 100))}" data-stock-draft-field="yieldFactor" />
              </label>
              <label>
                <span>${withInfo('Batch Yield', 'Output quantity for sub-recipes or prep/manufactured items.')}</span>
                <input name="yieldBatch" type="text" inputmode="decimal" value="${escapeAttribute(String(item.yieldBatch || 1))}" data-stock-draft-field="yieldBatch" />
              </label>
              <label class="stockModule__span2">
                <span>${withInfo('Barcodes', 'One or more barcode values. Separate multiple barcodes with commas.')}</span>
                <div class="stockModule__barcodeShell">
                  <input name="barcodes" value="${escapeAttribute(barcodeInputValue)}" placeholder="Comma separated" data-stock-barcodes-input data-stock-draft-field="barcodes" />
                  <button type="button" data-stock-scan-barcode-input aria-label="Scan stock item barcode" title="Scan stock item barcode">
                    ${icon('camera')}
                  </button>
                </div>
              </label>
              <div class="stockModule__quickSettings stockModule__span2">
                <label class="stockModule__toggle" title="${vatRegistered ? 'This item carries VAT on the workspace\'s configured rate.' : 'The workspace is not VAT registered, so no VAT is applied regardless of this setting.'}">
                  <input name="vatEnabled" type="checkbox" ${item.vatEnabled === false ? '' : 'checked'} data-stock-draft-field="vatEnabled" />
                  <span>VAT Enabled${vatRegistered ? '' : ' (workspace not VAT registered — no VAT applied)'}</span>
                </label>
                <div class="stockModule__typeControl" aria-label="Item type">
                  <span>Item Type</span>
                  <div class="stockModule__specGrid">
	                    ${renderSpecificationCard('standard', 'Standard', itemType)}
	                    ${renderSpecificationCard('sub_recipe', 'Sub-Recipe', itemType)}
	                    ${renderSpecificationCard('manufactured', 'Manufactured', itemType)}
	                    ${renderSpecificationCard('recipe_source', 'Non Stock', itemType)}
                  </div>
                </div>
              </div>
              <input type="hidden" name="itemType" value="${escapeAttribute(itemType)}" data-stock-draft-field="itemType" />
              <input type="hidden" name="isManufactured" value="${itemType === 'manufactured' ? 'on' : ''}" />
              ${isRecipeBackedItem ? `
                <button type="button" class="stockModule__recipeScreenButton stockModule__span2" data-stock-open-recipe-screen>
                  <span>
                    <strong>Edit recipe ingredients</strong>
	                    <em>${recipe.length} ingredient${recipe.length === 1 ? '' : 's'} linked to this ${itemType === 'sub_recipe' ? 'sub-recipe' : itemType === 'recipe_source' ? 'non stock item' : 'prep item'}</em>
                  </span>
                  ${icon('chevronRight')}
                </button>
              ` : ''}
              </div>
            </div>
          </section>
          <section class="stockModule__sheetPanel stockModule__sheetPanel--collapsible stockModule__uomConfigPanel ${isUomConfigOpen ? 'is-open' : 'is-closed'}" data-stock-editor-section="uom">
            <button type="button" class="stockModule__sectionToggle" data-stock-section-toggle="uom" aria-expanded="${isUomConfigOpen}">
              <span>
                <strong>2. UOM Configuration</strong>
                <em>Alternative ordering, receiving, and scan units.</em>
              </span>
              ${icon('chevron')}
            </button>
            <div class="stockModule__sectionBody">
              <div class="stockModule__sectionHeader">
                <p>Define an ordering or receiving unit and how it converts back to the inventory base unit.</p>
              </div>
              <div class="stockModule__uomConfigGrid">
              <div class="stockModule__uomConfigItem">
                <span>Stock Item</span>
                <strong>${escapeHtml(displayName || item.name || 'Stock item')}</strong>
              </div>
              ${uomConfigRows.map((row, rowIndex) => `
                <div class="stockModule__uomConfigRow" data-stock-uom-config-row="${rowIndex}">
                  <label>
                    <span>${withInfo('Base UOM', 'The inventory tracking unit for this item. All custom UOMs convert back to this unit.')}</span>
                    <input name="uomBaseUom[]" data-stock-uom-base value="${escapeAttribute(row.baseUom || currentUnit || item.unit || 'ea')}" readonly />
                  </label>
                  <label>
                    <span>${withInfo('Custom UOM', 'Ordering, receiving, or counting unit such as Box, Case, Tray, or Bottle.')}</span>
                    <input name="uomCustomUom[]" data-stock-uom-custom value="${escapeAttribute(row.customUom || '')}" placeholder="${rowIndex === 0 ? 'E.g. Box' : ''}" />
                  </label>
                  <label>
                    <span>${withInfo('Ratio', 'How many base units are in one custom unit. Example: 1 Box = 6 Liters.')}</span>
                    <input name="uomRatio[]" data-stock-uom-ratio type="text" inputmode="decimal" value="${escapeAttribute(row.ratio ? String(row.ratio) : '')}" placeholder="${rowIndex === 0 ? 'E.g. 6' : ''}" />
                  </label>
                  <label>
                    <span>${withInfo('Barcode', 'Barcode for this custom unit. Example: scanning a tray barcode counts the configured tray ratio.')}</span>
                    <div class="stockModule__barcodeShell">
                      <input name="uomBarcode[]" data-stock-uom-barcode value="${escapeAttribute(row.barcode || '')}" placeholder="${rowIndex === 0 ? 'Barcode' : ''}" />
                      <button type="button" data-stock-scan-barcode-input aria-label="Scan UOM barcode" title="Scan UOM barcode">
                        ${icon('camera')}
                      </button>
                    </div>
                  </label>
                  <label class="stockModule__defaultOrderingUom">
                    <span>${withInfo('Default ordering UOM', 'Use this custom UOM by default when adding the item to a purchase order, GRV, or credit note. Leave all unticked to use the Base UOM.')}</span>
                    <span class="stockModule__defaultOrderingUomControl">
                      <input
                        type="radio"
                        name="defaultOrderingUomRow"
                        value="${rowIndex}"
                        data-stock-uom-default-ordering
                        ${row.isDefaultOrdering ? 'checked' : ''}
                      />
                      <span>Use by default</span>
                    </span>
                  </label>
                </div>
              `).join('')}
              </div>
            </div>
          </section>
          `}
          ${stock.actionError ? `<div class="stockModule__inlineError stockModule__span2" role="alert">${escapeHtml(stock.actionError)}</div>` : ''}
          <div class="stockModule__modalActions stockModule__span2">
            ${item.id ? `
              <button type="button" class="stockModule__danger stockModule__modalDelete" data-stock-delete-current="${escapeAttribute(item.id)}">
                ${icon('trash')}
                <span>Delete</span>
              </button>
            ` : ''}
            <button type="button" data-stock-close>Abort</button>
            <button type="submit" class="stockModule__primary" ${stock.actionStatus === 'saving' ? 'disabled' : ''}>
              ${icon('check')}
              <span>${stock.actionStatus === 'saving' ? 'Saving' : 'Commit'}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderStockLocationCostModal(stock, item) {
  if (!stock.locationCostModalOpen) return '';
  const targetItem = item && item.id && item.id !== '__new__' ? item : null;
  if (!targetItem) return '';
  return `
    <div class="stockModule__modalBackdrop stockModule__locationCostingBackdrop" role="presentation">
      <section class="stockModule__modal stockModule__locationCostingModal stockModule__locationCostingModal--costByLocation" role="dialog" aria-modal="true" aria-labelledby="stock-location-cost-title">
        <header>
          <div>
            <p>Cost by Location</p>
            <h2 id="stock-location-cost-title">${escapeHtml(getStockItemDisplayName(targetItem) || targetItem.name || 'Stock item')}</h2>
          </div>
          <button type="button" class="stockModule__iconButton" data-stock-close-location-cost aria-label="Close">${icon('x')}</button>
        </header>
        <div class="stockModule__locationCostingModalBody">
          ${renderStockLocationCostEditor(stock.locationCostEditor, targetItem)}
        </div>
      </section>
    </div>
  `;
}

function renderStockLocationCostEditor(editor, item = {}) {
  const belongsToItem = Boolean(editor) && String(editor.itemId || '') === String(item.id || '');
  if (!belongsToItem || editor.status === 'loading') {
    return `<p class="stockModule__sectionHint">Loading location costs…</p>`;
  }
  if (editor.status === 'error') {
    return `<p class="stockModule__inlineError" role="alert">${escapeHtml(editor.error || 'Could not load location costs.')}</p>`;
  }
  const locations = Array.isArray(editor.locations) ? editor.locations : [];
  if (!locations.length) {
    return `<p class="stockModule__sectionHint">No active locations found for this workspace.</p>`;
  }
  const draft = editor.draft || {};
  const isSaving = editor.status === 'saving';
  return `
    <div class="stockModule__locationCostGrid">
      ${locations.map((location) => {
        const locationId = String(location.locationId || '');
        const draftValue = draft[locationId] ?? String(location.cost ?? 0);
        const hasLastPurchase = location.lastPurchaseCost !== null && location.lastPurchaseCost !== undefined;
        return `
          <div class="stockModule__locationCostRow" data-stock-location-cost-row="${escapeAttribute(locationId)}">
            <div class="stockModule__locationCostName">
              <strong>${escapeHtml(location.locationName || 'Location')}</strong>
              ${location.hasOverride
                ? '<span class="stockModule__badge">Override</span>'
                : '<span class="stockModule__badge stockModule__badge--muted">Using item cost</span>'}
            </div>
            <label>
              <span>Cost Ex VAT</span>
              <input
                type="text"
                inputmode="decimal"
                value="${escapeAttribute(draftValue)}"
                data-stock-location-cost-field
                data-stock-location-cost-id="${escapeAttribute(locationId)}"
                ${isSaving ? 'disabled' : ''}
              />
            </label>
            ${hasLastPurchase ? `
              <span class="stockModule__locationCostHint">
                Last purchase: ${formatCurrency(location.lastPurchaseCost)}${location.lastPurchasedAt ? ` on ${escapeHtml(String(location.lastPurchasedAt).slice(0, 10))}` : ''}
              </span>
            ` : ''}
          </div>
        `;
      }).join('')}
    </div>
    ${editor.error ? `<div class="stockModule__inlineError" role="alert">${escapeHtml(editor.error)}</div>` : ''}
    <div class="stockModule__locationCostActions">
      <button type="button" class="stockModule__primary" data-stock-save-location-costs ${isSaving ? 'disabled' : ''}>
        ${icon('check')}
        <span>${isSaving ? 'Saving' : 'Save Location Costs'}</span>
      </button>
    </div>
  `;
}

function renderStockRecipeScreen(item = {}, stockItems = []) {
  const itemType = getStockItemType(item);
  const recipe = normalizeStockRecipe(item.recipe);
  const recipeIds = new Set(recipe.map((line) => String(line.ingId)));
  const query = String(item.__recipeSearch || '').trim().toLowerCase();
  const itemId = String(item.id || '');
  const yieldBatch = Math.max(parseNumber(item.yieldBatch || 1), 1);
  const yieldUnit = String(item.unit || 'unit').trim() || 'unit';
  const pickerItems = (stockItems || [])
    .filter((candidate) => candidate?.id && String(candidate.id) !== itemId)
    .filter((candidate) => !recipeIds.has(String(candidate.id)));
  const visibleCount = query
    ? pickerItems.filter((candidate) => getStockRecipeSearchIndex(candidate).includes(query)).slice(0, 18).length
    : 0;
  const title = itemType === 'sub_recipe' ? 'Sub-Recipe Ingredients' : itemType === 'recipe_source' ? 'Non Stock Ingredients' : 'Prep Recipe Ingredients';
  const helper = itemType === 'sub_recipe'
    ? 'These ingredients deplete when a menu item uses this sub-recipe.'
    : itemType === 'recipe_source'
      ? 'These ingredients deplete when a linked menu item is sold. This item can still hold stock on hand and be included in stock counts.'
    : 'These ingredients deplete when a manufacturing batch is posted. Sales deduct the finished prep item.';

  return `
    <section class="stockModule__sheetPanel stockModule__recipeScreen stockModule__span2">
      <div class="stockModule__recipeScreenHeader">
        <button type="button" class="stockModule__ghostMini" data-stock-close-recipe-screen>${icon('chevronLeft')} Item details</button>
        <div>
	          <p>${escapeHtml(itemType === 'sub_recipe' ? 'Sub-Recipe' : itemType === 'recipe_source' ? 'Non Stock' : 'Manufacturing Prep')}</p>
          <h3>${escapeHtml(title)}</h3>
          <span>${escapeHtml(helper)}</span>
        </div>
      </div>
      <div class="stockModule__recipeYieldCard">
        <div>
          <strong>Recipe yield quantity</strong>
          <span>Enter the full batch ingredient quantities below, then set how many finished ${escapeHtml(yieldUnit)} this recipe produces.</span>
        </div>
        <label>
          <span>Yield Qty</span>
          <input name="yieldBatch" type="text" inputmode="decimal" value="${escapeAttribute(String(item.yieldBatch || 1))}" data-stock-draft-field="yieldBatch" />
          <em>${escapeHtml(yieldUnit)}</em>
        </label>
      </div>
      <div class="stockModule__recipeScreenGrid">
        <section class="stockModule__recipeBuilderPanel stockModule__recipeBuilderPanel--single">
          <div class="stockModule__recipeBuilderHead">
            <strong>Search Ingredients</strong>
            <span data-stock-recipe-search-count>${query ? `${visibleCount} shown` : 'Type to search'}</span>
          </div>
          <input
            type="search"
            value="${escapeAttribute(item.__recipeSearch || '')}"
            placeholder="Search RAW, MENU, Sub recipe, or PREP ingredients..."
            data-stock-recipe-search
            data-focus-key="stock-recipe-search"
          />
          <div class="stockModule__recipePickerList stockModule__recipePickerList--inline">
            <div class="stockModule__notice stockModule__notice--empty" data-stock-recipe-search-prompt ${query ? 'hidden' : ''}>Start typing to find an ingredient by name, category, unit, or item type tag.</div>
            <div class="stockModule__notice stockModule__notice--empty" data-stock-recipe-search-empty ${query && !visibleCount ? '' : 'hidden'}>No available ingredients match this search.</div>
            ${(() => {
              let shown = 0;
              return pickerItems.map((candidate) => {
                const tag = getStockRecipePickerTag(candidate);
                const matches = query && getStockRecipeSearchIndex(candidate, tag).includes(query);
                const hidden = !matches || shown >= 18;
                if (matches && shown < 18) shown += 1;
                return `
                  <button
                    type="button"
                    data-stock-recipe-add="${escapeAttribute(candidate.id)}"
                    data-stock-recipe-pickable
                    data-stock-recipe-search-index="${escapeAttribute(getStockRecipeSearchIndex(candidate, tag))}"
                    ${hidden ? 'hidden' : ''}
                  >
                    <span>
                      <strong>
                        ${escapeHtml(getStockItemDisplayName(candidate) || candidate.name)}
                        <em class="stockModule__recipeTypeTag stockModule__recipeTypeTag--${escapeAttribute(tag.tone)}">${escapeHtml(tag.label)}</em>
                      </strong>
                      <em>${escapeHtml(formatStockCategoryDisplay(candidate))} · ${escapeHtml(candidate.unit || '')}</em>
                    </span>
                    ${icon('plus')}
                  </button>
                `;
              }).join('');
            })()}
          </div>
          <div class="stockModule__recipeBuilderHead stockModule__recipeBuilderHead--selected">
            <strong>Selected Ingredients</strong>
            <span>${recipe.length} line${recipe.length === 1 ? '' : 's'}</span>
          </div>
          <div class="stockModule__recipeLineList">
            ${recipe.length ? recipe.map((line, index) => {
              const ingredient = findStockRecipeIngredient(stockItems, line.ingId);
              const tag = getStockRecipePickerTag(ingredient || line);
              const perUnitQty = (Number(line.qty || 0) || 0) / yieldBatch;
              return `
                <article class="stockModule__recipeLine">
                  <div>
                    <strong>
                      ${escapeHtml(ingredient?.name || line.name || 'Unknown ingredient')}
                      <em class="stockModule__recipeTypeTag stockModule__recipeTypeTag--${escapeAttribute(tag.tone)}">${escapeHtml(tag.label)}</em>
                    </strong>
                    <span>${escapeHtml(ingredient?.category || '')}</span>
                  </div>
                  <label>
                    <span>Batch Qty</span>
                    <input type="text" inputmode="decimal" value="${escapeAttribute(String(line.qty || 0))}" data-stock-recipe-qty="${index}" />
                    <em>${escapeHtml(ingredient?.unit || line.unit || '')}</em>
                    <small
                      data-stock-recipe-per-unit="${index}"
                      data-stock-recipe-unit="${escapeAttribute(ingredient?.unit || line.unit || '')}"
                    >Per ${escapeHtml(yieldUnit)}: ${formatRecipeQty(perUnitQty)} ${escapeHtml(ingredient?.unit || line.unit || '')}</small>
                  </label>
                  <button type="button" class="stockModule__iconButton" data-stock-recipe-remove="${index}" aria-label="Remove ingredient">${icon('x')}</button>
                </article>
              `;
            }).join('') : '<div class="stockModule__notice stockModule__notice--empty">No recipe ingredients added yet.</div>'}
          </div>
        </section>
      </div>
    </section>
  `;
}

function readStockRecipeLinesFromForm(form, currentItem = {}) {
  const recipe = normalizeStockRecipe(currentItem.recipe);
  form.querySelectorAll('[data-stock-recipe-qty]').forEach((input) => {
    const index = Number(input.dataset.stockRecipeQty);
    if (!Number.isInteger(index) || !recipe[index]) return;
    recipe[index] = {
      ...recipe[index],
      qty: parseNumber(input.value)
    };
  });
  return recipe;
}

function getEditableUomConfigurationRows(item = {}, fallbackBaseUom = '') {
  const baseUom = String(fallbackBaseUom || item.unit || item.uom || 'ea').trim() || 'ea';
  const configs = normalizeStockUomConfigurations(item.uomConfigurations || item.uomConfig || item.uom_configuration || item.uomConversions || item.uomConversion);
  const rows = configs.length ? configs : [{ baseUom, customUom: '', ratio: '', barcode: '', isDefaultOrdering: false }];
  while (rows.length < 3) rows.push({ baseUom, customUom: '', ratio: '', barcode: '', isDefaultOrdering: false });
  return rows.slice(0, 3).map((row) => ({ ...row, baseUom: row.baseUom || baseUom }));
}

function getStockEditorOpenSections(item = {}) {
  const fallback = item.id ? [] : ['details'];
  const sections = Array.isArray(item.__openStockSections) ? item.__openStockSections : fallback;
  return new Set(sections.map((section) => String(section || '').trim()).filter(Boolean));
}

function readStockUomConfigurationsFromForm(form, item = {}, fallbackBaseUom = '') {
  const rows = [...form.querySelectorAll('[data-stock-uom-config-row]')];
  const baseFallback = String(fallbackBaseUom || item.unit || item.uom || 'ea').trim() || 'ea';
  return rows
    .map((row) => {
      const baseUom = String(row.querySelector('[data-stock-uom-base]')?.value || baseFallback).trim();
      const customUom = String(row.querySelector('[data-stock-uom-custom]')?.value || '').trim();
      const ratioValue = String(row.querySelector('[data-stock-uom-ratio]')?.value || '').trim();
      const barcode = String(row.querySelector('[data-stock-uom-barcode]')?.value || '').trim();
      const isDefaultOrdering = Boolean(row.querySelector('[data-stock-uom-default-ordering]')?.checked);
      return {
        baseUom: baseUom || baseFallback,
        customUom,
        ratio: parseNumber(ratioValue),
        barcode,
        isDefaultOrdering
      };
    })
    .filter((row) => row.customUom || row.ratio > 0 || row.barcode);
}

function normalizeStockUomConfigurations(value) {
  const source = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  return source
    .map((entry) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const baseUom = String(row.baseUom || row.base_uom || row.baseUnit || row.unit || '').trim();
      const customUom = String(row.customUom || row.custom_uom || row.customUnit || row.orderingUom || '').trim();
      const ratio = parseNumber(row.ratio ?? row.conversionRatio ?? row.unitsPerCustomUnit ?? row.units_per_custom_unit);
      const barcode = parseBarcodeValues(row.barcode || row.barcodes || row.customBarcode || row.customUomBarcode)[0] || '';
      const isDefaultOrdering = ['true', '1', 'yes', 'on'].includes(String(row.isDefaultOrdering ?? row.defaultOrdering ?? row.is_default_ordering ?? row.defaultOrderUom ?? '').toLowerCase()) || row.isDefaultOrdering === true || row.defaultOrdering === true;
      return { baseUom, customUom, ratio, barcode, isDefaultOrdering };
    })
    .filter((entry) => entry.baseUom || entry.customUom || entry.ratio > 0 || entry.barcode);
}

function syncStockDraftFields(view, onStockAction = {}) {
  view.querySelectorAll('[data-stock-lookup-input]').forEach((input) => {
    onStockAction.onLookupFieldChange?.(input.dataset.stockLookupInput, input.value);
  });

  view.querySelectorAll('[data-stock-draft-field]').forEach((field) => {
    onStockAction.onDraftFieldChange?.(
      field.dataset.stockDraftField,
      field.type === 'checkbox' ? field.checked : field.value
    );
  });
}

function syncStockRecipeQtyFields(view, onStockAction = {}) {
  view.querySelectorAll('[data-stock-recipe-qty]').forEach((input) => {
    onStockAction.onRecipeLineQtyChange?.(Number(input.dataset.stockRecipeQty), input.value);
  });
}

function filterStockRecipePicker(view, value) {
  const query = String(value || '').trim().toLowerCase();
  const buttons = [...view.querySelectorAll('[data-stock-recipe-pickable]')];
  let shown = 0;

  buttons.forEach((button) => {
    const matches = Boolean(query) && String(button.dataset.stockRecipeSearchIndex || '').includes(query);
    const visible = matches && shown < 18;
    button.hidden = !visible;
    if (visible) shown += 1;
  });

  const count = view.querySelector('[data-stock-recipe-search-count]');
  if (count) count.textContent = query ? `${shown} shown` : 'Type to search';
  const prompt = view.querySelector('[data-stock-recipe-search-prompt]');
  if (prompt) prompt.hidden = Boolean(query);
  const empty = view.querySelector('[data-stock-recipe-search-empty]');
  if (empty) empty.hidden = !query || shown > 0;
}

function refreshInlineLookupSuggestions(view, input, stock = {}) {
  return;
  const field = String(input?.dataset?.stockLookupInput || '');
  if (!field) return;

  const suggestionsNode = [...view.querySelectorAll('[data-stock-lookup-suggestions]')]
    .find((node) => node.dataset.stockLookupSuggestions === field);
  if (!suggestionsNode) return;

  const options = field === 'unit'
    ? (stock.uoms || []).map((entry) => entry?.name || entry).filter(Boolean)
    : (stock.categories || []).map((entry) => entry?.name || entry).filter(Boolean);
  const textValue = String(input.value || '');
  const trimmedValue = textValue.trim();
  const normalized = normalizeLookupOption(trimmedValue);
  const exactMatch = Boolean(normalized) && options.some((option) => normalizeLookupOption(option) === normalized);
  const suggestions = normalized
    ? options
      .filter(Boolean)
      .filter((option) => normalizeLookupOption(option).includes(normalized) && normalizeLookupOption(option) !== normalized)
      .slice(0, 6)
    : [];
  const currentConfirmed = stock.editingItem?.__confirmedLookups || {};
  const isConfirmedNewOption = Boolean(normalized) && normalized === normalizeLookupOption(currentConfirmed[field]);
  const showNewOption = Boolean(trimmedValue) && !exactMatch && !isConfirmedNewOption;
  const newLabel = field === 'unit' ? 'New UOM' : 'New Category';
  const rows = [
    ...(showNewOption ? [{ value: trimmedValue, isNew: true }] : []),
    ...suggestions.map((option) => ({ value: option, isNew: false }))
  ];

  suggestionsNode.hidden = rows.length === 0;
  suggestionsNode.innerHTML = rows.map((option) => `
    <button
      type="button"
      class="stockModule__lookupSuggestion ${option.isNew ? 'stockModule__lookupSuggestion--new' : ''}"
      data-stock-lookup-suggest="${escapeAttribute(option.value)}"
      data-stock-lookup-suggest-field="${escapeAttribute(field)}"
    >
      <span>${escapeHtml(option.value)}</span>
      ${option.isNew ? `<em>${icon('plus')} ${escapeHtml(newLabel)}</em>` : ''}
    </button>
  `).join('');
}

function updateRecipePerUnitHints(view) {
  const form = view.querySelector('[data-stock-form]');
  if (!form) return;
  const yieldBatch = Math.max(parseNumber(form.querySelector('input[name="yieldBatch"]')?.value || 1), 1);
  const yieldUnit = String(form.querySelector('input[name="unit"]')?.value || 'unit').trim() || 'unit';

  form.querySelectorAll('[data-stock-recipe-qty]').forEach((input) => {
    const index = input.dataset.stockRecipeQty;
    const hint = [...form.querySelectorAll('[data-stock-recipe-per-unit]')]
      .find((entry) => String(entry.dataset.stockRecipePerUnit) === String(index));
    if (!hint) return;
    const unit = hint.dataset.stockRecipeUnit || '';
    const perUnitQty = parseNumber(input.value) / yieldBatch;
    hint.textContent = `Per ${yieldUnit}: ${formatRecipeQty(perUnitQty)} ${unit}`;
  });
}

const SPEC_CARD_DESCRIPTIONS = {
  standard: 'Tracks physical stock. Use for ingredients, beverages, and any item whose quantity you count and deplete.',
  sub_recipe: 'A nested component built from other stock items. It can be used inside recipes, but it has no stock-on-hand value and cannot be ordered.',
  manufactured: 'Produced in batches from ingredients. The finished prep item is tracked as its own stock unit.',
  recipe_source: 'Non Stock is separate from Sub-Recipe. It can hold stock on hand and be counted, but it cannot be used as a recipe ingredient.',
};

function renderSpecificationCard(value, title, selectedType) {
  const isSelected = selectedType === value;
  const description = SPEC_CARD_DESCRIPTIONS[value] || '';
  return `
    <button
      type="button"
      class="stockModule__specCard ${isSelected ? 'is-selected' : ''} stockModule__specCard--${escapeAttribute(value)}"
      data-stock-spec-type="${escapeAttribute(value)}"
      aria-pressed="${isSelected ? 'true' : 'false'}"
      data-stock-tooltip="${escapeAttribute(description)}"
    >
      <span>${escapeHtml(title)}</span>
      <i aria-hidden="true"></i>
    </button>
  `;
}

function updateSpecificationSelection(button, nextType) {
  const modal = button.closest('.stockModule__modal');
  if (!modal) return;
  modal.querySelectorAll('[data-stock-spec-type]').forEach((entry) => {
    const isSelected = entry.dataset.stockSpecType === nextType;
    entry.classList.toggle('is-selected', isSelected);
    entry.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  });

  const hidden = modal.querySelector('input[name="itemType"]');
  if (hidden) hidden.value = nextType;
  const manufacturedHidden = modal.querySelector('input[name="isManufactured"]');
  if (manufacturedHidden) manufacturedHidden.value = nextType === 'manufactured' ? 'on' : '';
  const nameInput = modal.querySelector('input[name="name"]');
  const displayName = String(nameInput?.value || '').trim() || 'Item name';
	  const tagPreview = nextType === 'sub_recipe'
	    ? `${displayName} (Sub-Recipe)`
	    : nextType === 'manufactured'
	      ? `${displayName} (Prep)`
	      : nextType === 'recipe_source'
	        ? `${displayName} (Non Stock)`
	      : displayName === 'Item name' ? 'Standard stock item' : displayName;
  const badge = modal.querySelector('.stockModule__tagPreviewBadge');
  if (badge) {
    badge.textContent = tagPreview;
    badge.className = `stockModule__tagPreviewBadge stockModule__tagPreviewBadge--${nextType}`;
  }
}

function refreshSpecificationTagPreview(modal) {
  if (!modal) return;
  const nextType = modal.querySelector('input[name="itemType"]')?.value || 'standard';
  const nameInput = modal.querySelector('input[name="name"]');
  const displayName = String(nameInput?.value || '').trim() || 'Item name';
	  const tagPreview = nextType === 'sub_recipe'
	    ? `${displayName} (Sub-Recipe)`
	    : nextType === 'manufactured'
	      ? `${displayName} (Prep)`
	      : nextType === 'recipe_source'
	        ? `${displayName} (Non Stock)`
	      : displayName === 'Item name' ? 'Standard stock item' : displayName;
  const badge = modal.querySelector('.stockModule__tagPreviewBadge');
  if (badge) badge.textContent = tagPreview;
}

function renderStockLookupPickerModal(stock, categories = [], uoms = []) {
  if (!stock.editingItem || !stock.lookupPicker?.open) return '';
  const field = stock.lookupPicker.field === 'unit' ? 'unit' : 'category';
  const rawQuery = String(stock.lookupPicker.query || '').trim();
  const query = normalizeLookupOption(rawQuery);
  const optionList = field === 'unit' ? getUnitSelectOptions(uoms, '') : getCategorySelectOptions(categories, '');
  const exactMatch = Boolean(query) && optionList.some((option) => normalizeLookupOption(option) === query);
  const options = optionList
    .filter(Boolean)
    .filter((option) => !query || normalizeLookupOption(option).includes(query))
    .map((option) => ({ name: option }));
  const newLabel = field === 'unit' ? 'New UOM' : 'New Category';

  return `
    <div class="stockModule__modalBackdrop stockModule__modalBackdrop--stacked" role="presentation">
      <section class="stockModule__modal stockModule__modal--managerPicker" role="dialog" aria-modal="true" aria-labelledby="stock-lookup-picker-title">
        <header>
          <div>
            <p>${field === 'unit' ? 'Browse UOM' : 'Browse Category'}</p>
            <h2 id="stock-lookup-picker-title">${field === 'unit' ? 'Select Unit of Measure' : 'Select Category'}</h2>
          </div>
          <button type="button" class="stockModule__iconButton" data-stock-lookup-picker-close aria-label="Close lookup modal">${icon('x')}</button>
        </header>
        <label class="stockModule__span2">
          <span>Search</span>
          <input
            type="search"
            value="${escapeAttribute(stock.lookupPicker.query || '')}"
            placeholder="Filter ${field === 'unit' ? 'UOMs' : 'categories'}..."
            data-stock-lookup-picker-search
            data-focus-key="stock-lookup-picker-search"
          />
        </label>
        <div class="stockModule__managerPickerList">
          ${rawQuery && !exactMatch ? `
            <button
              type="button"
              class="stockModule__managerPickerRow stockModule__managerPickerRow--new"
              data-stock-lookup-picker-use="${escapeAttribute(rawQuery)}"
              data-stock-lookup-picker-field="${escapeAttribute(field)}"
            >
              <div>
                <strong>${escapeHtml(rawQuery)}</strong>
                <span>${escapeHtml(newLabel)} - created when you save the stock item</span>
              </div>
              <em>${icon('plus')} New</em>
            </button>
          ` : ''}
          ${options.map((entry) => `
            <button
              type="button"
              class="stockModule__managerPickerRow"
              data-stock-lookup-picker-use="${escapeAttribute(entry.name)}"
              data-stock-lookup-picker-field="${escapeAttribute(field)}"
            >
              <div>
                <strong>${escapeHtml(entry.name)}</strong>
              </div>
              <span>Use</span>
            </button>
          `).join('') || '<div class="stockModule__notice stockModule__notice--empty">No matching entries found.</div>'}
        </div>
      </section>
    </div>
  `;
}

function renderStockManagerModal(stock, managerData) {
  const manager = stock.manager || {};
  if (!manager.open) return '';

  return `
    <div class="stockModule__modalBackdrop" role="presentation">
      <section class="stockModule__modal stockModule__modal--manager" role="dialog" aria-modal="true" aria-labelledby="stock-manager-title">
        <header>
          <div>
            <p>Stock Master</p>
            <h2 id="stock-manager-title">Category &amp; UOM Management</h2>
          </div>
          <button type="button" class="stockModule__iconButton" data-stock-manager-close aria-label="Close taxonomy manager">${icon('x')}</button>
        </header>
        <div class="stockModule__managerGrid">
          ${renderStockManagerColumn('category', 'Category Management', manager.category || {}, managerData.category || [], manager.status)}
          ${renderStockManagerColumn('uom', 'UOM Management', manager.uom || {}, managerData.uom || [], manager.status)}
        </div>
        ${manager.error ? `<div class="stockModule__inlineError stockModule__span2" role="alert">${escapeHtml(manager.error)}</div>` : ''}
      </section>
    </div>
  `;
}

function renderStockManagerColumn(type, title, panelState, entries, status) {
  const draftValue = String(panelState.draftValue || '');
  const searchValue = String(panelState.searchValue || '');
  const normalizedDraft = draftValue.trim().toLowerCase();
  const normalizedSearch = searchValue.trim().toLowerCase();
  const exactMatch = normalizedDraft && entries.some((entry) => entry.name.toLowerCase() === normalizedDraft);
  const visibleEntries = normalizedSearch
    ? entries.filter((entry) => entry.name.toLowerCase().includes(normalizedSearch))
    : entries;

  return `
    <section class="stockModule__managerPanel">
      <div class="stockModule__managerPanelHead">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${entries.length} available</span>
        </div>
      </div>
      <form class="stockModule__managerCreateForm" data-stock-manager-create-form="${escapeAttribute(type)}">
        <label class="stockModule__managerField">
          <span>Add ${type === 'uom' ? 'UOM' : 'Category'}</span>
          <div class="stockModule__managerInputShell">
            <input
              value="${escapeAttribute(draftValue)}"
              placeholder="${type === 'uom' ? 'Type a unit of measure' : 'Type a category name'}"
              data-stock-manager-input="${escapeAttribute(type)}"
              data-focus-key="stock-manager-create-${escapeAttribute(type)}"
            />
            <button
              type="submit"
              class="stockModule__managerInputAction"
              aria-label="Add ${type === 'uom' ? 'UOM' : 'category'}"
              title="Add ${type === 'uom' ? 'UOM' : 'category'}"
              ${status === 'saving' || exactMatch || !draftValue.trim() ? 'disabled' : ''}
            >
              ${icon('plus')}
            </button>
          </div>
        </label>
      </form>
      <label class="stockModule__managerField">
        <span>Search ${type === 'uom' ? 'UOMs' : 'Categories'}</span>
        <input
          type="search"
          value="${escapeAttribute(searchValue)}"
          placeholder="${type === 'uom' ? 'Search UOM list' : 'Search category list'}"
          data-stock-manager-search="${escapeAttribute(type)}"
          data-focus-key="stock-manager-search-${escapeAttribute(type)}"
        />
      </label>
      <div class="stockModule__managerList">
        ${visibleEntries.map((entry) => renderStockManagerRow(type, entry, panelState, status)).join('') || `<div class="stockModule__notice stockModule__notice--empty">No ${type === 'uom' ? 'UOMs' : 'categories'} found.</div>`}
      </div>
    </section>
  `;
}

function renderStockManagerRow(type, entry, panelState, status) {
  const name = String(entry.name || '').trim();
  const itemCount = Number(entry.itemCount || 0);
  const editingName = String(panelState.editingName || '').trim().toLowerCase();
  const isEditing = editingName === name.toLowerCase();

  if (isEditing) {
    return `
      <form class="stockModule__managerRow stockModule__managerRow--editing" data-stock-manager-rename-form="${escapeAttribute(type)}">
        <div>
          <strong>${escapeHtml(name)}</strong>
          <span>${itemCount} item${itemCount === 1 ? '' : 's'}</span>
        </div>
        <input
          value="${escapeAttribute(panelState.editingValue || '')}"
          data-stock-manager-rename-input="${escapeAttribute(type)}"
          data-focus-key="stock-manager-rename-${escapeAttribute(type)}"
        />
        <div class="stockModule__managerRowActions">
          <button type="submit" class="stockModule__iconButton" aria-label="Save ${escapeAttribute(name)}" ${status === 'saving' ? 'disabled' : ''}>${icon('check')}</button>
          <button type="button" class="stockModule__iconButton" data-stock-manager-rename-cancel="${escapeAttribute(type)}" aria-label="Cancel rename">${icon('x')}</button>
        </div>
      </form>
    `;
  }

  return `
    <div class="stockModule__managerRow">
      <div>
        <strong>${escapeHtml(name)}</strong>
        <span>${itemCount} item${itemCount === 1 ? '' : 's'}</span>
      </div>
      <div class="stockModule__managerRowActions">
        <button type="button" class="stockModule__iconButton" data-stock-manager-rename-start="${escapeAttribute(name)}" data-stock-manager-rename-type="${escapeAttribute(type)}" aria-label="Edit ${escapeAttribute(name)}">${icon('edit')}</button>
        <button
          type="button"
          class="stockModule__iconButton"
          data-stock-manager-delete="${escapeAttribute(name)}"
          data-stock-manager-delete-type="${escapeAttribute(type)}"
          aria-label="Delete ${escapeAttribute(name)}"
          title="${escapeAttribute(itemCount > 0 ? `Cannot delete while assigned to ${itemCount} item${itemCount === 1 ? '' : 's'}` : `Delete ${name}`)}"
          ${status === 'saving' ? 'disabled' : ''}
        >${icon('trash')}</button>
      </div>
    </div>
  `;
}

function renderDeleteDialog(stock) {
  const confirmDelete = stock.confirmDelete;
  if (confirmDelete?.handledByBrandDialog) return '';
  const ids = Array.isArray(confirmDelete?.ids)
    ? confirmDelete.ids
    : confirmDelete?.id
      ? [confirmDelete.id]
      : [];
  if (!ids.length) return '';
  const count = ids.length;
  const item = count === 1 ? confirmDelete.items?.[0] || confirmDelete : null;

  return `
    <div class="stockModule__modalBackdrop" role="presentation">
      <section class="stockModule__modal stockModule__modal--compact" role="dialog" aria-modal="true" aria-labelledby="stock-delete-title">
        <header>
          <div>
            <p>Delete Stock Item</p>
            <h2 id="stock-delete-title">${count === 1 ? escapeHtml(item?.name || 'Stock Item') : `Delete Selected Items`}</h2>
          </div>
        </header>
        <p class="stockModule__confirmText">
          This removes ${count === 1 ? 'the stock item' : `${count} stock items`}. Existing historical logs remain untouched.
        </p>
        ${stock.actionError ? `<div class="stockModule__inlineError" role="alert">${escapeHtml(stock.actionError)}</div>` : ''}
        <div class="stockModule__modalActions">
          <button type="button" data-stock-cancel-delete>Cancel</button>
          <button type="button" class="stockModule__danger" data-stock-confirm-delete ${stock.actionStatus === 'deleting' ? 'disabled' : ''}>
            ${icon('trash')}
            <span>${stock.actionStatus === 'deleting' ? 'Deleting' : 'Delete'}</span>
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderNotice(message, tone) {
  return `<div class="stockModule__notice stockModule__notice--${tone}">${escapeHtml(message)}</div>`;
}

function renderImportReviewModal(review) {
  if (!review) return '';
  const errors = Array.isArray(review.errors) ? review.errors : [];
  if (!errors.length) return '';
  const warningCount = errors.filter((entry) => String(entry.code || '').startsWith('WARN_')).length;
  const skippedCount = Number(review.skippedCount || 0);
  const hasHardErrors = skippedCount > 0 || errors.some((entry) => !String(entry.code || '').startsWith('WARN_'));
  return `
    <div class="stockModule__modalBackdrop" role="presentation">
      <section class="stockModule__modal stockModule__modal--importReview" role="dialog" aria-modal="true" aria-labelledby="stock-import-review-title">
        <header>
          <div>
            <p>Import Notification</p>
            <h2 id="stock-import-review-title">${hasHardErrors ? 'Stock Import Needs Attention' : 'Stock Import Notice'}</h2>
          </div>
        </header>
        <p class="stockModule__confirmText">
          ${hasHardErrors
            ? 'Confirm this message, fix the listed rows, and try the import again.'
            : 'Confirm this message before continuing. Stock quantity changes were not processed from the import file.'}
        </p>
        <div class="stockModule__importReviewSummary">
          <strong>${Number(review.importedCount || 0)} imported</strong>
          <span>${skippedCount} skipped · ${warningCount} warning${warningCount === 1 ? '' : 's'} · ${Number(review.totalRows || 0)} rows checked</span>
        </div>
        <ul class="stockModule__importReviewList">
          ${errors.map((error) => `
            <li>
              <code>${escapeHtml(error.code || 'ERR_IMPORT')}</code>
              <span>Row ${escapeHtml(error.row || '-')}: ${escapeHtml(error.message || 'Import row could not be processed.')}</span>
            </li>
          `).join('')}
        </ul>
        <div class="stockModule__modalActions stockModule__modalActions--right">
          <button type="button" class="stockModule__primary" data-stock-import-review-close>
            <span>${hasHardErrors ? 'Confirm & Fix Errors' : 'Confirm'}</span>
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderSkeletonRow() {
  return `
    <article class="stockModule__row stockModule__row--loading">
      <div></div><div></div><div></div><div></div><div></div><div></div>
    </article>
  `;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="stockModule__toast stockModule__toast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
    </div>
  `;
}

function renderLookupField({ field, value, placeholder, options = [], confirmedValue = '', activeField = '' }) {
  const label = field === 'unit' ? 'UOM' : 'Category';
  const textValue = String(value || '');

  return `
    <div class="stockModule__lookupField">
      <input
        name="${escapeAttribute(field)}"
        value="${escapeAttribute(textValue)}"
        placeholder="${escapeAttribute(placeholder || '')}"
        data-stock-lookup-input="${escapeAttribute(field)}"
        data-focus-key="stock-lookup-${escapeAttribute(field)}"
      />
      <button
        type="button"
        class="stockModule__lookupFieldAction"
        data-stock-open-lookup="${escapeAttribute(field)}"
        aria-label="Browse ${escapeAttribute(label)}"
        title="Browse ${escapeAttribute(label)}"
      >
        ${icon('search')}
      </button>
      <div
        class="stockModule__lookupSuggestions"
        data-stock-lookup-suggestions="${escapeAttribute(field)}"
        hidden
      >
      </div>
    </div>
  `;
}

function getStockManagerData(stock = {}) {
  return {
    category: (stock.categories || []).map((entry) => ({
      name: String(entry?.name || '').trim(),
      itemCount: Number(entry?.itemCount || 0)
    })).filter((entry) => entry.name),
    uom: buildUomEntries(stock.uoms || [], stock.items || [])
  };
}

function buildUomEntries(uoms = [], items = []) {
  const usage = new Map();
  uoms.forEach((uom) => {
    const name = String(uom || '').trim();
    if (name) usage.set(name, 0);
  });
  items.forEach((item) => {
    const unit = String(item?.unit || '').trim();
    if (!unit) return;
    usage.set(unit, (usage.get(unit) || 0) + 1);
  });
  return [...usage.entries()]
    .map(([name, itemCount]) => ({ name, itemCount }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function renderIconButton(iconName, label, attributes) {
  return `
    <button type="button" class="stockModule__iconButton" ${attributes} aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
      ${icon(iconName)}
    </button>
  `;
}

function filterStockItems(items, filters, locations = []) {
  const query = String(filters.query || '').trim().toLowerCase();
  return items.filter((item) => {
    const itemType = getStockItemType(item);
    const searchName = getStockItemDisplayName(item);
    const matchesQuery = !query ||
	      String(item.name || '').toLowerCase().includes(query) ||
	      String(searchName || '').toLowerCase().includes(query) ||
	      getStockItemSku(item).toLowerCase().includes(query) ||
	      (itemType === 'sub_recipe' && ['sub recipe', 'sub-recipe'].some((term) => term.includes(query) || query.includes(term))) ||
	      (itemType === 'manufactured' && ['prep', 'manufactured'].some((term) => term.includes(query) || query.includes(term))) ||
	      (itemType === 'recipe_source' && ['recipe source', 'non stock', 'non-stock', 'virtual'].some((term) => term.includes(query) || query.includes(term))) ||
	      String(item.category || '').toLowerCase().includes(query) ||
      matchesBarcodeQuery(item, query);
    const matchesCategory = !filters.category || getStockCategoryBase(item) === filters.category;
    const matchesType = !filters.itemType || itemType === filters.itemType;
    return matchesQuery && matchesCategory && matchesType;
  });
}

// Shared canonical derivation — see src/utils/stockItemType.js. This surface has always treated a
// 'virtual' item as Non Stock, so the fine-grained type is collapsed here.
function getStockItemType(item = {}) {
  const type = deriveStockItemType(item);
  return type === 'virtual' ? 'recipe_source' : type;
}

function getStockItemDisplayName(item = {}) {
  return String(item.name || '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .trim();
}

function normalizeStockRecipe(value = []) {
  const lines = Array.isArray(value)
    ? value
    : Object.values(value && typeof value === 'object' ? value : {});

  return lines
    .map((line = {}) => ({
      ingId: String(line.ingId || line.ingredientId || line.stockItemId || line.id || '').trim(),
      qty: parseNumber(line.qty ?? line.quantity ?? line.amount ?? 0),
      unit: String(line.unit || line.uom || '').trim(),
      name: String(line.name || line.ingredientName || '').trim()
    }))
    .filter((line) => line.ingId);
}

function findStockRecipeIngredient(items = [], ingId) {
  const id = String(ingId || '');
  return (items || []).find((item) => String(item?.id || '') === id) || null;
}

function getStockRecipePickerTag(item = {}) {
	  const itemType = getStockItemType(item);
	  if (itemType === 'sub_recipe') return { label: 'Sub recipe', tone: 'sub' };
	  if (itemType === 'manufactured') return { label: 'PREP', tone: 'prep' };
	  if (itemType === 'recipe_source') return { label: 'NON STOCK', tone: 'sub' };

  const explicit = String(item.itemType || item.productType || item.type || item.kind || '').trim().toLowerCase();
  const looksMenu = ['menu', 'menu_item', 'product', 'catalogue', 'catalog'].includes(explicit) ||
    item.isMenuItem === true ||
    item.menuItemId ||
    (item.yocoProductId && !item.balances);

  if (looksMenu) return { label: 'MENU', tone: 'menu' };
  return { label: 'RAW', tone: 'raw' };
}

function getStockRecipeSearchIndex(item = {}, tag = getStockRecipePickerTag(item)) {
  return [
    getStockItemDisplayName(item),
    item.name,
    item.category,
    item.unit,
    tag.label,
    tag.tone
  ].map((value) => String(value || '').toLowerCase()).join(' ');
}

function formatRecipeQty(value) {
  const numeric = Number(value || 0) || 0;
  return numeric.toLocaleString('en-ZA', {
    maximumFractionDigits: 4,
    minimumFractionDigits: numeric > 0 && numeric < 1 ? 3 : 0
  });
}

function getPaging(items = [], filters = {}) {
  const total = items.length;
  const pageSize = [25, 50, 100].includes(Number(filters.pageSize)) ? Number(filters.pageSize) : 25;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(filters.page || 1) || 1), totalPages);
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(total, startIndex + pageSize);
  return { total, pageSize, totalPages, page, startIndex, endIndex };
}

function getCategories(items) {
  return [...new Set(items.map((item) => (
    item && typeof item === 'object' && Object.hasOwn(item, 'name')
      ? String(item.name || '').trim()
      : getStockCategoryBase(item)
  )))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function getCategorySelectOptions(categories = [], currentCategory = '') {
  const options = [...new Set([
    ...categories.map((category) => (
      category && typeof category === 'object'
        ? String(category.name || category.category || '').trim()
        : String(category || '').trim()
    )),
    stripCategorySuffix(currentCategory || ''),
    'General'
  ].map((category) => String(category || '').trim()).filter(Boolean))];

  return options.sort((a, b) => a.localeCompare(b));
}

function getUomOptions(stock = {}) {
  const configured = Array.isArray(stock.uoms) ? stock.uoms : [];
  const itemUnits = (stock.items || []).map((item) => item.unit);
  return [...new Set([...defaultUoms, ...configured, ...itemUnits]
    .map((unit) => String(unit || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function getUnitSelectOptions(units = [], currentUnit = '') {
  return [...new Set([
    ...units,
    String(currentUnit || '').trim()
  ].filter(Boolean))];
}

function normalizeLookupOption(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Strips every type marker, not just Raw Materials/Manufactured — a category can carry more than
// one accumulated marker, and leaving "- Non Stock" behind kept re-deriving the wrong item type.
function stripCategorySuffix(value = '') {
  return stripStockCategoryTypeSuffix(value);
}

function getStockCategoryBase(item = {}) {
  const raw = String(item.category || 'General').trim();
  const stripped = stripCategorySuffix(raw).trim();

  if (item.isManufactured || raw.toLowerCase().includes('manufactured')) {
    const bracketCategory = raw.match(/\(([^)]+)\)\s*-\s*Manufactured$/i);
    if (bracketCategory?.[1]) return bracketCategory[1].trim();

    const itemBaseName = stripCategorySuffix(item.name || '').trim().toLowerCase();
    if (itemBaseName && stripped.toLowerCase().startsWith(`${itemBaseName} - `)) {
      return stripped.slice(itemBaseName.length + 3).trim();
    }

    const parts = stripped.split(/\s+-\s+/).filter(Boolean);
    if (parts.length > 1) return parts.at(-1).trim();
  }

  return stripped || 'General';
}

function formatStockCategoryDisplay(item = {}) {
  const baseCategory = getStockCategoryBase(item);
  const raw = String(item.category || '').toLowerCase();
  return item.isManufactured || raw.includes('manufactured')
    ? `${baseCategory || 'General'} - Manufactured`
    : baseCategory;
}

function parseNumber(value) {
  return Number.parseFloat(String(value || 0).replace(',', '.')) || 0;
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function withInfo(label, tooltip) {
  return `
    <span class="stockModule__fieldLabel">
      ${escapeHtml(label)}
      <span class="stockModule__infoIcon" tabindex="0" aria-label="${escapeAttribute(tooltip)}" data-stock-tooltip="${escapeAttribute(tooltip)}">i</span>
    </span>
  `;
}

async function scanBarcodeIntoInput(input, options = {}) {
  if (!input) return;
  try {
    const { openBarcodeScanner } = await import('../services/barcodeScanner.js');
    await openBarcodeScanner({
      ...options,
      onScan: (code) => appendBarcode(input, code)
    });
  } catch (error) {
    console.warn('[Stock] Barcode scanner failed:', error);
  }
}

function bindStockTooltips(view) {
  let tooltipNode = null;
  const controller = new AbortController();
  const { signal } = controller;

  const hideTooltip = () => {
    document.querySelectorAll('.stockModule__floatingTooltip').forEach((node) => node.remove());
    tooltipNode = null;
  };

  const showTooltip = (target) => {
    const text = target.dataset.stockTooltip;
    if (!text || !target.isConnected) return;
    hideTooltip();
    tooltipNode = document.createElement('div');
    tooltipNode.className = 'stockModule__floatingTooltip';
    tooltipNode.textContent = text;
    document.body.append(tooltipNode);
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltipNode.getBoundingClientRect();
    const top = Math.max(10, targetRect.top - tooltipRect.height - 10);
    const left = Math.min(
      window.innerWidth - tooltipRect.width - 10,
      Math.max(10, targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2))
    );
    tooltipNode.style.top = `${top}px`;
    tooltipNode.style.left = `${left}px`;
  };

  document.addEventListener('mouseover', (event) => {
    const target = event.target?.closest?.('[data-stock-tooltip]');
    if (target) showTooltip(target);
  }, { signal });

  document.addEventListener('mouseout', (event) => {
    if (!event.relatedTarget?.closest?.('[data-stock-tooltip]')) hideTooltip();
  }, { signal });

  document.addEventListener('focusin', (event) => {
    const target = event.target?.closest?.('[data-stock-tooltip]');
    if (target) showTooltip(target);
    else hideTooltip();
  }, { signal });

  document.addEventListener('focusout', () => hideTooltip(), { signal });

  document.addEventListener('pointerdown', (event) => {
    if (!event.target?.closest?.('[data-stock-tooltip]')) hideTooltip();
  }, { capture: true, signal });

  window.addEventListener('scroll', hideTooltip, { capture: true, signal });
  window.addEventListener('resize', hideTooltip, { signal });
  window.addEventListener('blur', hideTooltip, { signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTooltip();
  }, { signal });

  const observer = new MutationObserver(() => {
    if (view.isConnected) return;
    hideTooltip();
    controller.abort();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function appendBarcode(input, code) {
  const barcode = String(code || '').trim();
  if (!barcode) return;
  const values = String(input.value || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === barcode.toLowerCase())) {
    values.push(barcode);
  }
  input.value = values.join(', ');
  input.focus({ preventScroll: true });
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR'
  }).format(Number(value || 0));
}

function formatNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0.00';
  return number.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function icon(name) {
  const icons = {
    chevron: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    camera: '<path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="12.5" r="3.5"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8.5A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>',
    mapPin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${icons[name] || icons.plus}
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
