import '../styles/menu.css';
import { renderLoadingPanel } from './LoadingPanel.js';

const statusOptions = [
  { value: '', label: 'All Statuses' },
  { value: 'complete', label: 'Complete' },
  { value: 'missing', label: 'Missing Recipes' }
];

const modifierStatusOptions = [
  { value: '', label: 'All Statuses' },
  { value: 'linked', label: 'Linked' },
  { value: 'manual', label: 'Manual Recipe' },
  { value: 'unlinked', label: 'Unlinked' }
];

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

function applyMenuLocationPrice(item = {}, locationId = '', locationOptions = []) {
  const entry = locationId ? item.locationPrices?.[locationId] : null;
  const locationPrice = Number(entry?.sellingPrice ?? entry?.price ?? item.sellingPrice ?? 0) || 0;
  const locationName = locationOptions.find((option) => option.value === locationId)?.label || '';
  return {
    ...item,
    globalSellingPrice: Number(item.sellingPrice || 0) || 0,
    sellingPrice: locationPrice,
    activeLocationId: locationId,
    activeLocationName: locationName,
    locationPriceSource: entry ? 'location' : 'global'
  };
}


function decorateMenuItemsWithModifierLinks(items = [], modifiers = []) {
  const linkIndex = buildModifierProductLinkIndex(modifiers);
  return (items || []).map((item) => ({
    ...item,
    linkedToModifier: isMenuItemLinkedToModifier(item, linkIndex)
  }));
}

function buildModifierProductLinkIndex(modifiers = []) {
  const ids = new Set();
  const names = new Set();
  (modifiers || []).forEach((modifier = {}) => {
    [
      ...(Array.isArray(modifier.linkedProductIds) ? modifier.linkedProductIds : []),
      modifier.linkedProductId,
      modifier.yocoModifierProductId,
      modifier.yocoModifierVariantId,
      modifier.recipeSourceProductId
    ].map(normalizeLinkToken).filter(Boolean).forEach((value) => ids.add(value));
    [
      ...(Array.isArray(modifier.linkedProductNames) ? modifier.linkedProductNames : []),
      modifier.linkedProductName,
      modifier.autoLinkedProductName,
      modifier.yocoModifierProductName
    ].map(normalizeLinkToken).filter(Boolean).forEach((value) => names.add(value));
  });
  return { ids, names };
}

function isMenuItemLinkedToModifier(item = {}, linkIndex = { ids: new Set(), names: new Set() }) {
  const idCandidates = [
    item.id,
    item.productId,
    item.yocoItemId,
    item.yocoVariantId,
    item.variantId,
    item.recipeOwnerId,
    item.sku,
    item.customSku
  ].map(normalizeLinkToken).filter(Boolean);
  if (idCandidates.some((candidate) => linkIndex.ids.has(candidate))) return true;
  const nameCandidates = [
    item.name,
    item.productName,
    item.yocoItemName,
    item.yocoModifierProductName
  ].map(normalizeLinkToken).filter(Boolean);
  return nameCandidates.some((candidate) => linkIndex.names.has(candidate));
}

function normalizeLinkToken(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^product:/, '')
    .replace(/^modifier:/, '')
    .replace(/\s+/g, ' ');
}

export function renderMenuCatalogue({ state, onFilterChange, onMenuAction = {} } = {}) {
  const menu = state.menu || {};
  const filters = {
    view: 'list',
    query: '',
    catalogueView: 'products',
    category: '',
    status: '',
    locationId: '',
    page: 1,
    pageSize: 25,
    openDropdown: '',
    ...(menu.filters || {})
  };
  const catalogueView = filters.catalogueView === 'modifiers' ? 'modifiers' : 'products';
  const allModifiers = menu.modifierItems || [];
  const allItems = decorateMenuItemsWithModifierLinks(menu.items || [], allModifiers);
  const sourceRows = catalogueView === 'modifiers' ? allModifiers : allItems;
  const locationOptions = getAccessibleSellingLocationOptions(menu.locations || [], state.access || {});
  const activeLocationId = catalogueView === 'products' ? resolveActiveLocationId(filters.locationId, locationOptions) : '';
  const filteredRows = catalogueView === 'modifiers' ? filterModifiers(sourceRows, filters) : filterItems(sourceRows, filters);
  const items = catalogueView === 'products'
    ? filteredRows.map((item) => applyMenuLocationPrice(item, activeLocationId, locationOptions))
    : filteredRows;
  const paging = getPaging(items, filters);
  const pagedItems = items.slice(paging.startIndex, paging.endIndex);
  const selectedIds = new Set((menu.selectedIds || []).map(String));
  const posLock = getPosCatalogueLock(menu);
  const selectedCount = catalogueView === 'products' && !posLock.active ? selectedIds.size : 0;
  const categories = catalogueView === 'modifiers' ? getModifierGroups(allModifiers) : getCategories(allItems);
  const categoryOptions = [
    { value: '', label: catalogueView === 'modifiers' ? 'All Groups' : 'All Categories' },
    ...categories.map((category) => ({ value: category, label: category }))
  ];
  const view = document.createElement('section');
  view.className = 'menuCatalogue';

  view.innerHTML = `
    <header class="menuCatalogue__header">
      <div>
        <p class="menuCatalogue__eyebrow">Operations</p>
        <h1>Menu Catalogue</h1>
        <p>Menu management for recipe costing, price control, and import workflows.</p>
      </div>
      <div class="menuCatalogue__headerActions">
        <input type="file" accept=".csv,.json,.xlsx,.xls,text/csv,application/json" hidden data-menu-import-input />
        ${catalogueView === 'products' ? renderFileActionsDropdown(filters.openDropdown, menu.actionStatus, posLock) : ''}
        ${selectedCount ? renderInlineBulkDelete([...selectedIds], menu.actionStatus) : ''}
      </div>
    </header>

    <section class="menuCatalogue__controls" aria-label="Menu catalogue filters">
      ${renderCatalogueModeToggle(catalogueView, allItems.length, allModifiers.length)}
      <label class="menuCatalogue__search">
        <span>${catalogueView === 'modifiers' ? 'Search Modifiers' : 'Search Menu Items'}</span>
        <div class="menuCatalogue__searchShell">
          <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="${catalogueView === 'modifiers' ? 'Search modifiers, groups, or linked products...' : 'Search menu catalogue...'}" data-menu-query />
          <button type="button" data-menu-scan-barcode aria-label="Scan barcode" title="Scan barcode" ${catalogueView === 'modifiers' ? 'hidden' : ''}>
            ${icon('camera')}
          </button>
        </div>
      </label>
      ${renderDropdown({
        id: 'category',
        label: catalogueView === 'modifiers' ? 'Modifier Group' : 'Category',
        value: filters.category,
        openDropdown: filters.openDropdown,
        options: categoryOptions
      })}
      ${catalogueView === 'products' && locationOptions.length ? renderDropdown({
        id: 'locationId',
        label: 'Selling Location',
        value: activeLocationId,
        openDropdown: filters.openDropdown,
        options: locationOptions
      }) : ''}
      ${renderDropdown({
        id: 'status',
        label: 'Status',
        value: filters.status,
        openDropdown: filters.openDropdown,
        options: catalogueView === 'modifiers' ? modifierStatusOptions : statusOptions
      })}
    </section>

    ${menu.actionError && !menu.editingItem && !menu.confirmDelete ? renderActionError(menu.actionError) : ''}
    ${catalogueView === 'modifiers'
      ? renderModifierBody(menu, items, pagedItems, paging)
      : renderBody(menu, items, pagedItems, paging, selectedIds, posLock)}
    ${renderEditModal(menu)}
    ${renderCategoryManagerModal(menu)}
    ${renderDeleteDialog(menu)}
    ${renderToast(menu.toast)}
  `;

  bindFilters(view, filters, onFilterChange);
  bindActions(view, pagedItems, onMenuAction, menu, posLock);

  return view;
}

function bindFilters(view, filters, onFilterChange) {
  view.querySelector('[data-menu-query]')?.addEventListener('input', (event) => {
    onFilterChange?.({ query: event.target.value, page: 1 });
  });

  view.querySelectorAll('[data-menu-catalogue-view]').forEach((button) => {
    button.addEventListener('click', () => {
      onFilterChange?.({
        catalogueView: button.dataset.menuCatalogueView || 'products',
        query: '',
        category: '',
        status: '',
        page: 1,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-menu-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = filters.openDropdown === button.dataset.menuDropdown ? '' : button.dataset.menuDropdown;
      onFilterChange?.({ openDropdown: next });
    });
  });

  view.addEventListener('click', (event) => {
    if (!filters.openDropdown || event.target.closest('[data-menu-dropdown-root]')) return;
    onFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-menu-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onFilterChange?.({
        [button.dataset.menuOptionGroup]: button.dataset.menuOptionValue,
        page: 1,
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-menu-page]').forEach((button) => {
    button.addEventListener('click', () => onFilterChange?.({ page: Number(button.dataset.menuPage || 1) || 1 }));
  });

  view.querySelector('[data-menu-page-size]')?.addEventListener('change', (event) => {
    onFilterChange?.({ pageSize: Number(event.target.value || 25) || 25, page: 1 });
  });
}

function bindActions(view, visibleItems, onMenuAction, menu = {}, posLock = {}) {
  const importInput = view.querySelector('[data-menu-import-input]');

  view.querySelector('[data-menu-import-trigger]')?.addEventListener('click', () => {
    if (posLock.active) return;
    importInput?.click();
  });

  importInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file && !posLock.active) onMenuAction.onImport?.(file);
    event.target.value = '';
  });

  view.querySelectorAll('[data-menu-export]').forEach((button) => {
    button.addEventListener('click', () => onMenuAction.onExport?.(button.dataset.menuExport));
  });

  view.querySelector('[data-menu-scan-barcode]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onMenuAction.onScanBarcode?.();
  });

  view.querySelectorAll('[data-menu-scan-barcode-input]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const input = button.closest('.menuCatalogue__searchShell')?.querySelector('[data-menu-barcodes-input]');
      await scanBarcodeIntoInput(input, {
        title: 'Scan Product Barcode',
        helper: 'Scan a barcode to attach it to this product.'
      });
    });
  });

  view.querySelector('[data-menu-delete-selected]')?.addEventListener('click', () => {
    if (posLock.active) return;
    const rawIds = view.querySelector('[data-menu-delete-selected]')?.dataset.menuDeleteSelected || '[]';
    const ids = parseDatasetJson(rawIds);
    onMenuAction.onRequestDelete?.({ ids, mode: 'bulk' });
  });

  view.querySelectorAll('[data-menu-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      if (posLock.active) return;
      onMenuAction.onEdit?.(button.dataset.menuEdit);
    });
  });

  view.querySelectorAll('[data-menu-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      if (posLock.active) return;
      onMenuAction.onRequestDelete?.({
        ids: [button.dataset.menuDelete],
        mode: 'single'
      });
    });
  });

  view.querySelectorAll('[data-menu-open-recipe]').forEach((button) => {
    button.addEventListener('click', () => onMenuAction.onOpenRecipe?.(button.dataset.menuOpenRecipe));
  });

  view.querySelectorAll('[data-menu-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (posLock.active) return;
      onMenuAction.onSelect?.(checkbox.dataset.menuSelect, checkbox.checked);
    });
  });

  view.querySelector('[data-menu-select-all]')?.addEventListener('change', (event) => {
    if (posLock.active) return;
    onMenuAction.onSelectAll?.(visibleItems.map((item) => item.id), event.target.checked);
  });

  view.querySelector('[data-menu-edit-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const priceLocationId = String(formData.get('priceLocationId') || '').trim();
    const sellingPrice = parseCurrencyInput(formData.get('sellingPrice'));
    const currentItem = menu.editingItem || {};
    const locationPrices = { ...(currentItem.locationPrices || {}) };
    if (priceLocationId) {
      locationPrices[priceLocationId] = {
        ...(locationPrices[priceLocationId] || {}),
        sellingPrice,
        updatedAt: new Date().toISOString()
      };
    }
    onMenuAction.onSaveEdit?.(form.dataset.menuEditId, {
      name: formData.get('name'),
      category: formData.get('category'),
      sellingPrice,
      priceLocationId,
      locationPrices,
      barcodes: formData.get('barcodes')
    });
  });

  view.querySelector('[data-menu-price-location-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    onMenuAction.onTogglePriceLocationDropdown?.();
  });

  view.querySelectorAll('[data-menu-price-location-option]').forEach((button) => {
    button.addEventListener('click', () => {
      onMenuAction.onPriceLocationChange?.(button.dataset.menuPriceLocationOption || '');
    });
  });

  view.querySelectorAll('[data-menu-close-edit]').forEach((button) => {
    button.addEventListener('click', () => onMenuAction.onCloseEdit?.());
  });

  view.querySelectorAll('[data-menu-category-manager-close]').forEach((button) => {
    button.addEventListener('click', () => onMenuAction.onCloseCategoryManager?.());
  });

  view.querySelector('[data-menu-category-create-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    onMenuAction.onCategoryCreate?.();
  });

  view.querySelector('[data-menu-category-draft]')?.addEventListener('input', (event) => {
    onMenuAction.onPreserveFocus?.(event.currentTarget);
    onMenuAction.onCategoryDraftChange?.(event.target.value);
  });

  view.querySelectorAll('[data-menu-category-rename-start]').forEach((button) => {
    button.addEventListener('click', () => onMenuAction.onCategoryRenameStart?.(button.dataset.menuCategoryRenameStart));
  });

  view.querySelectorAll('[data-menu-category-rename-input]').forEach((input) => {
    input.addEventListener('input', (event) => {
      onMenuAction.onPreserveFocus?.(event.currentTarget);
      onMenuAction.onCategoryRenameChange?.(event.target.value);
    });
  });

  view.querySelectorAll('[data-menu-category-rename-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      onMenuAction.onCategoryRenameSave?.();
    });
  });

  view.querySelectorAll('[data-menu-category-rename-cancel]').forEach((button) => {
    button.addEventListener('click', () => onMenuAction.onCategoryRenameCancel?.());
  });

  view.querySelectorAll('[data-menu-category-delete]').forEach((button) => {
    button.addEventListener('click', () => onMenuAction.onCategoryDelete?.(button.dataset.menuCategoryDelete));
  });

  view.querySelector('[data-menu-confirm-delete]')?.addEventListener('click', () => {
    onMenuAction.onConfirmDelete?.();
  });

  view.querySelector('[data-menu-cancel-delete]')?.addEventListener('click', () => {
    onMenuAction.onCancelDelete?.();
  });

  view.querySelector('[data-menu-toast-close]')?.addEventListener('click', () => {
    onMenuAction.onDismissToast?.();
  });
}

function renderBody(menu, items, pagedItems, paging, selectedIds, posLock = {}) {
  if (menu.status === 'loading') {
    return renderLoadingPanel('Loading menu catalogue', 'Fetching POS products, pricing, recipes, and modifiers.');
  }

  if (menu.status === 'error') {
    return `
      <div class="menuCatalogue__notice" role="alert">
        <h2>Menu Catalogue Unavailable</h2>
        <p>${escapeHtml(menu.error || 'Could not load menu items.')}</p>
      </div>
    `;
  }

  if (!items.length) {
    return `
      <div class="menuCatalogue__notice">
        <h2>No Menu Items Found</h2>
        <p>No catalogue items match the current filters.</p>
      </div>
    `;
  }

  const allSelected = pagedItems.length > 0 && pagedItems.every((item) => selectedIds.has(String(item.id)));
  return `
    <div class="menuCatalogue__list">
      <div class="menuCatalogue__tableBar">
        <div>
          <strong>${items.length} item${items.length === 1 ? '' : 's'}</strong>
          <span>Showing ${paging.total ? paging.startIndex + 1 : 0}-${paging.endIndex} of ${paging.total}</span>
        </div>
        ${renderPagingControls('menu', paging)}
      </div>
      <div class="menuCatalogue__listHead">
        <label class="menuCatalogue__checkbox" aria-label="Select all visible menu items">
          <input type="checkbox" data-menu-select-all ${allSelected ? 'checked' : ''} ${posLock.active ? 'disabled' : ''} />
          <span></span>
        </label>
        <span>Product Name</span>
        <span>Variant</span>
        <span>SKU</span>
        <span>Category</span>
        <span>Modifiers / GP</span>
        <span>Price</span>
        <span>Status</span>
        <span>Recipe Lines</span>
        <span>Action</span>
      </div>
      ${pagedItems.map((item) => renderMenuRow(item, selectedIds.has(String(item.id)), posLock)).join('')}
      <div class="menuCatalogue__tableFooter">
        <span>${paging.total ? `${paging.startIndex + 1}-${paging.endIndex}` : '0'} of ${paging.total} items</span>
        ${renderPageButtons('menu', paging)}
      </div>
    </div>
  `;
}

function renderMenuRow(item, isSelected, posLock = {}) {
  return `
    <article class="menuCatalogue__row">
      <label class="menuCatalogue__checkbox" aria-label="Select ${escapeAttribute(item.name)}">
        <input type="checkbox" data-menu-select="${escapeAttribute(item.id)}" ${isSelected ? 'checked' : ''} ${posLock.active ? 'disabled' : ''} />
        <span></span>
      </label>
      <strong>
        <span class="menuCatalogue__nameLine">
          ${escapeHtml(item.name)}
          ${renderLinkedToModifierPill(item)}
        </span>
        <small>${escapeHtml(getMenuItemMeta(item))}</small>
      </strong>
      <span class="menuCatalogue__variantColumn">${renderVariantColumn(item)}</span>
      <span class="menuCatalogue__sku">${escapeHtml(getSkuDisplay(item))}</span>
      <span>${escapeHtml(item.category)}</span>
      ${renderModifierGroupsCell(item)}
      <span class="menuCatalogue__rowPrice">${formatCurrency(item.sellingPrice)}</span>
      ${renderStatus(item)}
      <span class="menuCatalogue__recipeCount">${item.recipeCount}</span>
      <div class="menuCatalogue__rowActions">
        ${renderIconButton('edit', posLock.active ? `${posLock.label} controls this menu item` : 'Edit menu item', `data-menu-edit="${escapeAttribute(item.id)}" ${posLock.active ? 'disabled' : ''}`)}
        ${renderIconButton('trash', posLock.active ? `${posLock.label} controls this menu item` : 'Remove menu item', `data-menu-delete="${escapeAttribute(item.id)}" ${posLock.active ? 'disabled' : ''}`)}
      </div>
    </article>
  `;
}

function renderLinkedToModifierPill(item = {}) {
  if (item.linkedToModifier !== true) return '';
  return '<em class="menuCatalogue__pill menuCatalogue__pill--modifier" title="This menu product is linked from a product modifier option.">Linked to Modifier</em>';
}

function renderMenuCard(item) {
  return `
    <article class="menuCatalogue__card">
      <div class="menuCatalogue__cardTop">
        <span>${escapeHtml(item.category)}</span>
        ${renderStatus(item)}
      </div>
      <h2>${escapeHtml(item.name)} ${renderLinkedToModifierPill(item)}</h2>
      ${renderVariantBadge(item)}
      ${renderModifierGroupsCell(item)}
      <div class="menuCatalogue__skuCard">SKU <strong>${escapeHtml(getSkuDisplay(item))}</strong></div>
      <div class="menuCatalogue__price">${formatCurrency(item.sellingPrice)}</div>
      <div class="menuCatalogue__meta">
        <span>${item.recipeCount} Recipe Lines</span>
        <span>${escapeHtml(item.source)}</span>
      </div>
      <div class="menuCatalogue__cardActions">
        ${renderIconButton('edit', 'Edit menu item', `data-menu-edit="${escapeAttribute(item.id)}"`)}
        ${renderIconButton('trash', 'Remove menu item', `data-menu-delete="${escapeAttribute(item.id)}"`)}
      </div>
    </article>
  `;
}

function renderCatalogueModeToggle(activeView = 'products', productCount = 0, modifierCount = 0) {
  const view = activeView === 'modifiers' ? 'modifiers' : 'products';
  return `
    <div class="menuCatalogue__modeToggle" role="group" aria-label="Menu catalogue type">
      <button type="button" data-menu-catalogue-view="products" class="${view === 'products' ? 'is-active' : ''}" aria-pressed="${view === 'products'}">
        <span>Menu Items</span>
        <strong>${productCount}</strong>
      </button>
      <button type="button" data-menu-catalogue-view="modifiers" class="${view === 'modifiers' ? 'is-active' : ''}" aria-pressed="${view === 'modifiers'}">
        <span>Modifiers</span>
        <strong>${modifierCount}</strong>
      </button>
    </div>
  `;
}

function renderModifierBody(menu, items, pagedItems, paging) {
  if (menu.status === 'loading') {
    return renderLoadingPanel('Loading modifiers', 'Fetching modifier groups, add-ons, and menu links.');
  }

  if (menu.status === 'error') {
    return `
      <div class="menuCatalogue__notice" role="alert">
        <h2>Menu Catalogue Unavailable</h2>
        <p>${escapeHtml(menu.error || 'Could not load modifiers.')}</p>
      </div>
    `;
  }

  if (!items.length) {
    return `
      <div class="menuCatalogue__notice">
        <h2>No Modifiers Found</h2>
        <p>No Yoco modifiers match the current filters.</p>
      </div>
    `;
  }

  return `
    <div class="menuCatalogue__list">
      <div class="menuCatalogue__tableBar">
        <div>
          <strong>${items.length} modifier${items.length === 1 ? '' : 's'}</strong>
          <span>Showing ${paging.total ? paging.startIndex + 1 : 0}-${paging.endIndex} of ${paging.total}</span>
        </div>
        ${renderPagingControls('menu', paging)}
      </div>
      <div class="menuCatalogue__modifierListHead">
        <span>Modifier Name</span>
        <span>Modifier Group</span>
        <span>Price</span>
        <span>Linked Product</span>
        <span>Status</span>
      </div>
      ${pagedItems.map(renderModifierRow).join('')}
      <div class="menuCatalogue__tableFooter">
        <span>${paging.total ? `${paging.startIndex + 1}-${paging.endIndex}` : '0'} of ${paging.total} modifiers</span>
        ${renderPageButtons('menu', paging)}
      </div>
    </div>
  `;
}

function renderModifierRow(item = {}) {
  const linkedProduct = getLinkedProductDisplay(item);
  return `
    <article class="menuCatalogue__modifierRow">
      <strong>
        ${escapeHtml(item.name)}
        <small>${escapeHtml(item.recipeSource === 'linked_product' ? 'Yoco product modifier' : 'Yoco modifier')}</small>
      </strong>
      <span>${escapeHtml(item.modifierGroup || 'Modifier Group')}</span>
      <span class="menuCatalogue__rowPrice">${formatCurrency(item.sellingPrice)}</span>
      <span class="menuCatalogue__linkedProduct" title="${escapeAttribute(linkedProduct.title)}">${escapeHtml(linkedProduct.value)}</span>
      <em class="menuCatalogue__modifierStatus menuCatalogue__modifierStatus--${escapeAttribute(item.status || 'unlinked')}">
        ${escapeHtml(item.statusLabel || 'Unlinked')}
      </em>
    </article>
  `;
}

function renderDropdown({ id, label, value, openDropdown, options }) {
  const activeOption = options.find((option) => option.value === value) || options[0];
  const isOpen = openDropdown === id;

  return `
    <div class="menuCatalogue__dropdown ${isOpen ? 'menuCatalogue__dropdown--open' : ''}" data-menu-dropdown-root>
      <span>${escapeHtml(label)}</span>
      <button type="button" data-menu-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(activeOption.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="menuCatalogue__dropdownMenu">
        ${options.map((option) => `
          <button
            type="button"
            data-menu-option
            data-menu-option-group="${escapeAttribute(id)}"
            data-menu-option-value="${escapeAttribute(option.value)}"
            class="${option.value === value ? 'is-active' : ''}"
          >
            ${escapeHtml(option.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderFileActionsDropdown(openDropdown, actionStatus, posLock = {}) {
  const isOpen = openDropdown === 'fileActions';
  return `
    <div class="menuCatalogue__dropdown menuCatalogue__fileActions ${isOpen ? 'menuCatalogue__dropdown--open' : ''}" data-menu-dropdown-root>
      <button type="button" data-menu-dropdown="fileActions" aria-expanded="${isOpen}">
        ${icon('download')}
        <strong>Import/Export</strong>
        ${icon('chevron')}
      </button>
      <div class="menuCatalogue__dropdownMenu">
        <button type="button" data-menu-import-trigger ${actionStatus === 'importing' || posLock.active ? 'disabled' : ''} title="${posLock.active ? escapeAttribute(`${posLock.label} is connected, so menu imports are disabled.`) : ''}">
          ${icon('upload')}
          <span>${actionStatus === 'importing' ? 'Importing' : posLock.active ? 'Import disabled' : 'Import Menu'}</span>
        </button>
        <span class="menuCatalogue__fileDivider">Export Templates</span>
        <button type="button" data-menu-export="template-xlsx">${icon('download')}<span>XLSX Template</span></button>
        <span class="menuCatalogue__fileDivider">Export</span>
        <button type="button" data-menu-export="xlsx">${icon('download')}<span>XLSX</span></button>
        <button type="button" data-menu-export="pdf">${icon('download')}<span>PDF</span></button>
      </div>
    </div>
  `;
}

function renderViewButton(view, activeView) {
  const label = view === 'list' ? 'List View' : 'Tile View';
  return `
    <button type="button" data-menu-view="${view}" class="${activeView === view ? 'is-active' : ''}" aria-label="${label}" title="${label}">
      ${icon(view)}
    </button>
  `;
}

function renderInlineBulkDelete(selectedIds, actionStatus) {
  const selectedCount = selectedIds.length;
  return `
    <button
      type="button"
      data-menu-delete-selected="${escapeAttribute(JSON.stringify(selectedIds))}"
      class="menuCatalogue__dangerAction menuCatalogue__bulkDeleteInline"
      ${actionStatus === 'deleting' ? 'disabled' : ''}
    >
      ${icon('trash')}
      <span>${actionStatus === 'deleting' ? 'Deleting' : `Delete Selected (${selectedCount})`}</span>
    </button>
  `;
}

function renderEditModal(menu) {
  const item = menu.editingItem;
  if (!item) return '';
  const priceLocationId = String(item.__priceLocationId || '');
  const priceLocationOptions = [
    { value: '', label: 'Global / Default Price' },
    ...((menu.locations || []).map((location) => ({
      value: String(location.id || ''),
      label: String(location.displayName || location.name || location.id || 'Location')
    })).filter((option) => option.value))
  ];

  return `
    <div class="menuCatalogue__modalBackdrop" role="presentation">
      <section class="menuCatalogue__modal" role="dialog" aria-modal="true" aria-labelledby="menu-edit-title">
        <header>
          <div>
            <p>Edit Catalogue Item</p>
            <h2 id="menu-edit-title">${escapeHtml(item.name)}</h2>
          </div>
          <button type="button" class="menuCatalogue__ghostIcon" data-menu-close-edit aria-label="Close edit modal">
            ${icon('x')}
          </button>
        </header>
        <form data-menu-edit-form data-menu-edit-id="${escapeAttribute(item.id)}">
          <label>
            <span>Product Name</span>
            <input name="name" value="${escapeAttribute(item.name)}" required />
          </label>
          <label>
            <span>Category</span>
            <input name="category" value="${escapeAttribute(item.category)}" required />
          </label>
          <label>
            <span>Selling Price</span>
            <input name="sellingPrice" type="text" inputmode="decimal" value="${escapeAttribute(String(item.sellingPrice || 0))}" required />
          </label>
          <label>
            <span>Selling Location Price</span>
            ${renderPriceLocationPicker({
              name: 'priceLocationId',
              value: priceLocationId,
              options: priceLocationOptions,
              isOpen: item.__priceDropdownOpen
            })}
          </label>
          <label>
            <span>Barcodes</span>
            <div class="menuCatalogue__searchShell">
              <input name="barcodes" value="${escapeAttribute((item.barcodes || []).join(', '))}" placeholder="Comma separated" data-menu-barcodes-input />
              <button type="button" data-menu-scan-barcode-input aria-label="Scan product barcode" title="Scan product barcode">
                ${icon('camera')}
              </button>
            </div>
          </label>
          ${menu.actionError ? `<div class="menuCatalogue__inlineError" role="alert">${escapeHtml(menu.actionError)}</div>` : ''}
          <div class="menuCatalogue__modalActions">
            <button type="button" data-menu-close-edit>Cancel</button>
            <button type="submit" class="menuCatalogue__primaryAction" ${menu.actionStatus === 'saving' ? 'disabled' : ''}>
              ${icon('check')}
              <span>${menu.actionStatus === 'saving' ? 'Saving' : 'Save Changes'}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderPriceLocationPicker({ name, value = '', options = [], isOpen = false } = {}) {
  const selected = options.find((option) => String(option.value || '') === String(value || '')) || options[0] || { value: '', label: 'Global / Default Price' };
  return `
    <div class="menuCatalogue__pricePicker ${isOpen ? 'menuCatalogue__pricePicker--open' : ''}">
      <input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}" />
      <button type="button" data-menu-price-location-toggle aria-expanded="${isOpen ? 'true' : 'false'}">
        <span>${escapeHtml(selected.label)}</span>
        ${icon('chevron')}
      </button>
      <div class="menuCatalogue__pricePickerMenu" role="listbox" aria-label="Selling location price scope">
        ${options.map((option) => `
          <button
            type="button"
            class="${String(option.value || '') === String(value || '') ? 'is-active' : ''}"
            data-menu-price-location-option="${escapeAttribute(option.value)}"
            role="option"
            aria-selected="${String(option.value || '') === String(value || '') ? 'true' : 'false'}"
          >
            <span>${escapeHtml(option.label)}</span>
            ${String(option.value || '') === String(value || '') ? icon('check') : ''}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderCategoryManagerModal(menu) {
  const manager = menu.categoryManager;
  if (!manager?.open) return '';

  return `
    <div class="menuCatalogue__modalBackdrop" role="presentation">
      <section class="menuCatalogue__modal menuCatalogue__modal--categoryManager" role="dialog" aria-modal="true" aria-labelledby="menu-category-manager-title">
        <header>
          <div>
            <p>Category Management</p>
            <h2 id="menu-category-manager-title">Stock Categories</h2>
          </div>
          <button type="button" class="menuCatalogue__ghostIcon" data-menu-category-manager-close aria-label="Close category manager">
            ${icon('x')}
          </button>
        </header>
        <form class="menuCatalogue__categoryCreate" data-menu-category-create-form>
          <label>
            <span>New Category</span>
            <input value="${escapeAttribute(manager.draftName || '')}" placeholder="Add a category" data-menu-category-draft data-focus-key="menu-category-draft" />
          </label>
          <button type="submit" class="menuCatalogue__primaryAction" ${manager.status === 'saving' ? 'disabled' : ''}>
            ${icon('plus')}
            <span>${manager.status === 'saving' ? 'Saving' : 'Create'}</span>
          </button>
        </form>
        ${manager.error ? `<div class="menuCatalogue__inlineError" role="alert">${escapeHtml(manager.error)}</div>` : ''}
        <div class="menuCatalogue__categoryList" data-scroll-key="menu-category-list">
          ${manager.status === 'loading' ? '<div class="menuCatalogue__notice"><p>Loading categories...</p></div>' : (manager.items || []).map((category) => renderCategoryManagerRow(category, manager)).join('') || '<div class="menuCatalogue__notice"><p>No categories found.</p></div>'}
        </div>
      </section>
    </div>
  `;
}

function renderCategoryManagerRow(category, manager) {
  const name = String(category?.name || '').trim();
  const itemCount = Number(category?.itemCount || 0);
  const isEditing = String(manager.editingName || '').trim().toLowerCase() === name.toLowerCase();
  const canDelete = itemCount === 0;

  if (isEditing) {
    return `
      <form class="menuCatalogue__categoryRow is-editing" data-menu-category-rename-form>
        <div>
          <strong>${escapeHtml(name)}</strong>
          <span>${itemCount} item${itemCount === 1 ? '' : 's'}</span>
        </div>
        <input value="${escapeAttribute(manager.editingValue || '')}" data-menu-category-rename-input data-focus-key="menu-category-rename" />
        <div class="menuCatalogue__categoryActions">
          <button type="submit" class="menuCatalogue__iconButton" aria-label="Save category name">${icon('check')}</button>
          <button type="button" class="menuCatalogue__iconButton" data-menu-category-rename-cancel aria-label="Cancel category rename">${icon('x')}</button>
        </div>
      </form>
    `;
  }

  return `
    <div class="menuCatalogue__categoryRow">
      <div>
        <strong>${escapeHtml(name)}</strong>
        <span>${itemCount} item${itemCount === 1 ? '' : 's'}</span>
      </div>
      <div class="menuCatalogue__categoryActions">
        <button type="button" class="menuCatalogue__iconButton" data-menu-category-rename-start="${escapeAttribute(name)}" aria-label="Rename category ${escapeAttribute(name)}">${icon('edit')}</button>
        <button type="button" class="menuCatalogue__iconButton menuCatalogue__iconButton--danger" data-menu-category-delete="${escapeAttribute(name)}" aria-label="Delete category ${escapeAttribute(name)}" ${canDelete ? '' : 'disabled'}>${icon('trash')}</button>
      </div>
    </div>
  `;
}

function renderDeleteDialog(menu) {
  const confirmDelete = menu.confirmDelete;
  if (!confirmDelete?.ids?.length) return '';

  const count = confirmDelete.ids.length;
  return `
    <div class="menuCatalogue__modalBackdrop" role="presentation">
      <section class="menuCatalogue__modal menuCatalogue__modal--compact" role="dialog" aria-modal="true" aria-labelledby="menu-delete-title">
        <header>
          <div>
            <p>Confirm Removal</p>
            <h2 id="menu-delete-title">${count === 1 ? 'Remove Menu Item' : 'Remove Selected Items'}</h2>
          </div>
        </header>
        <p class="menuCatalogue__confirmText">
          This will permanently delete ${count === 1 ? 'this menu item' : `${count} menu items`}.
        </p>
        ${menu.actionError ? `<div class="menuCatalogue__inlineError" role="alert">${escapeHtml(menu.actionError)}</div>` : ''}
        <div class="menuCatalogue__modalActions">
          <button type="button" data-menu-cancel-delete>Cancel</button>
          <button type="button" class="menuCatalogue__dangerAction" data-menu-confirm-delete ${menu.actionStatus === 'deleting' ? 'disabled' : ''}>
            ${icon('trash')}
            <span>${menu.actionStatus === 'deleting' ? 'Deleting' : 'Delete'}</span>
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderToast(toast) {
  if (!toast?.message) return '';

  return `
    <div class="menuCatalogue__toast menuCatalogue__toast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-menu-toast-close aria-label="Dismiss notification">${icon('x')}</button>
    </div>
  `;
}

function renderActionError(message) {
  return `
    <div class="menuCatalogue__actionError" role="alert">
      ${escapeHtml(message)}
    </div>
  `;
}

function renderPagingControls(prefix, paging) {
  return `
    <label class="menuCatalogue__pageSize">
      <span>Rows</span>
      <select data-${prefix}-page-size>
        ${[25, 50, 100].map((size) => `<option value="${size}" ${paging.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}
      </select>
    </label>
  `;
}

function renderPageButtons(prefix, paging) {
  return `
    <div class="menuCatalogue__pager" aria-label="Pagination">
      <button type="button" data-${prefix}-page="${paging.page - 1}" ${paging.page <= 1 ? 'disabled' : ''}>${icon('chevronLeft')}</button>
      <strong>Page ${paging.page} of ${paging.totalPages}</strong>
      <button type="button" data-${prefix}-page="${paging.page + 1}" ${paging.page >= paging.totalPages ? 'disabled' : ''}>${icon('chevronRight')}</button>
    </div>
  `;
}

function renderStatus(item) {
  if (item.status === 'complete') {
    const label = item.recipeStatus === 'COMPLETE_VIA_LINKED_STOCK_ITEM' || item.recipeSource === 'linked_stock_item'
      ? 'Complete via linked stock item'
      : 'Complete';
    return `
      <em class="menuCatalogue__status menuCatalogue__status--complete">
        ${escapeHtml(label)}
      </em>
    `;
  }

  return `
    <button type="button" class="menuCatalogue__status menuCatalogue__status--missing menuCatalogue__statusLink" data-menu-open-recipe="${escapeAttribute(item.id)}">
      Missing Recipe
    </button>
  `;
}

function renderVariantBadge(item = {}) {
  const label = getVariantDisplay(item, '');
  const brand = String(item.yocoBrandName || '').trim();
  const badges = [
    label ? `<span class="menuCatalogue__variantBadge">${escapeHtml(label)}</span>` : '',
    brand ? `<span class="menuCatalogue__variantBadge menuCatalogue__variantBadge--brand">${escapeHtml(brand)}</span>` : ''
  ].filter(Boolean);
  return badges.length ? `<span class="menuCatalogue__badgeRow">${badges.join('')}</span>` : '';
}

function renderVariantColumn(item = {}) {
  const label = getVariantDisplay(item, '');
  if (!label) return '<span class="menuCatalogue__mutedDash">—</span>';
  return `<span class="menuCatalogue__variantPill">${escapeHtml(label)}</span>`;
}

function renderModifierGroupsCell(item = {}) {
  const groups = Array.isArray(item.modifierGroups) ? item.modifierGroups : [];
  if (!groups.length) {
    return `
      <span class="menuCatalogue__modifierCell menuCatalogue__modifierCell--empty">
        <strong>No modifiers</strong>
        <small>Ingredients only</small>
      </span>
    `;
  }

  const names = groups.map((group) => String(group.name || group.id || '').trim()).filter(Boolean);
  const displayNames = names.slice(0, 2).join(', ');
  const overflow = names.length > 2 ? ` +${names.length - 2}` : '';
  const optionCount = Number(item.modifierCount || 0);
  const gpText = `${optionCount} modifier option${optionCount === 1 ? '' : 's'}`;

  return `
    <span class="menuCatalogue__modifierCell" title="${escapeAttribute(names.join(', '))}">
      <strong>${escapeHtml(`${displayNames || 'Modifier group'}${overflow}`)}</strong>
      <small>${escapeHtml(gpText)}</small>
    </span>
  `;
}

function getVariantDisplay(item = {}, fallback = 'Default variant') {
  const sku = String(item.sku || item.customSku || '').trim();
  const label = String(item.yocoOptionSummary || item.yocoVariantName || '').trim();
  if (label && label.toLowerCase() !== sku.toLowerCase()) return label;
  if (String(item.yocoVariantId || '').trim()) return fallback;
  return '';
}

function getLinkedProductDisplay(item = {}) {
  const names = Array.isArray(item.linkedProductNames)
    ? item.linkedProductNames
    : String(item.linkedProductName || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const ids = Array.isArray(item.linkedProductIds)
    ? item.linkedProductIds
    : String(item.linkedProductId || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (names.length) {
    const value = names.join(', ');
    return { value, title: `Linked product: ${value}` };
  }
  const autoName = String(item.autoLinkedProductName || '').trim();
  if (autoName) {
    return { value: autoName, title: `Auto-linked from Yoco ${item.modifierLinkSource === 'variant' ? 'variant' : 'product'} match: ${autoName}` };
  }
  const variantId = String(item.yocoModifierVariantId || '').trim();
  const variantName = String(item.yocoModifierProductName || '').trim();
  if (variantName) {
    return {
      value: variantName,
      title: variantId ? `Linked from Yoco product variant: ${variantName}. Variant id: ${variantId}` : `Linked from Yoco product modifier: ${variantName}`
    };
  }
  if (ids.length) {
    const value = ids.join(', ');
    return { value, title: `Linked product id: ${value}` };
  }
  if (variantId) return { value: variantId, title: `Yoco modifier variant id: ${variantId}` };
  return { value: 'No linked product', title: 'No linked product or Yoco variant link found' };
}

function getSkuDisplay(item = {}) {
  return String(item.sku || item.customSku || item.barcode || '').trim() || '—';
}

function getMenuItemMeta(item = {}) {
  const itemName = String(item.yocoItemName || '').trim();
  const variantId = String(item.yocoVariantId || '').trim();
  const variant = getVariantDisplay(item, '');
  const category = String(item.yocoCategoryName || '').trim();
  const categoryText = category ? ` • ${category}` : '';
  if (itemName && variantId) return `Yoco variant • ${itemName}${variant ? ` • ${variant}` : ''}${categoryText}`;
  if (itemName) return `Yoco item • ${itemName}${categoryText}`;
  return displaySourceLabel(item.source, 'Live catalogue');
}

function displaySourceLabel(source = '', fallback = 'Live data') {
  const value = String(source || '').trim();
  return value && !/flare|d1/i.test(value) ? value : fallback;
}

function getPosCatalogueLock(menu = {}) {
  const integration = menu.posIntegration || {};
  const label = String(integration.label || integration.provider || 'POS').trim() || 'POS';
  return {
    active: integration.active === true,
    provider: String(integration.provider || '').trim(),
    label
  };
}

function renderIconButton(iconName, label, attributes) {
  return `
    <button type="button" class="menuCatalogue__iconButton" ${attributes} aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
      ${icon(iconName)}
    </button>
  `;
}

function renderSkeletonCard() {
  return `
    <article class="menuCatalogue__card menuCatalogue__card--loading">
      <div></div>
      <div></div>
      <div></div>
    </article>
  `;
}

function renderSkeletonRow() {
  return `
    <article class="menuCatalogue__row menuCatalogue__row--loading">
      <div></div>
      <div></div>
      <div></div>
      <div></div>
      <div></div>
      <div></div>
      <div></div>
      <div></div>
    </article>
  `;
}

function icon(name) {
  const icons = {
    chevron: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    camera: '<path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="12.5" r="3.5"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    tiles: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="m20 6-11 11-5-5"/>'
  };

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${icons[name] || icons.list}
    </svg>
  `;
}

function filterItems(items, filters) {
  const query = String(filters.query || '').trim().toLowerCase();
  return items.filter((item) => {
    const matchesQuery = !query ||
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.category || '').toLowerCase().includes(query) ||
      String(item.yocoCategoryName || '').toLowerCase().includes(query) ||
      String(item.yocoBrandName || '').toLowerCase().includes(query) ||
      String(item.yocoOptionSummary || '').toLowerCase().includes(query) ||
      String(item.yocoVariantName || '').toLowerCase().includes(query) ||
      (item.modifierGroups || []).some((group) => String(group?.name || group?.id || '').toLowerCase().includes(query)) ||
      String(item.id || '').toLowerCase().includes(query) ||
      String(item.customSku || '').toLowerCase().includes(query) ||
      String(item.sku || '').toLowerCase().includes(query) ||
      String(item.barcode || '').toLowerCase().includes(query) ||
      (item.barcodes || []).some((barcode) => String(barcode).toLowerCase().includes(query));
    const matchesCategory = !filters.category || item.category === filters.category;
    const matchesStatus = !filters.status || item.status === filters.status;
    return matchesQuery && matchesCategory && matchesStatus;
  });
}

function filterModifiers(items, filters) {
  const query = String(filters.query || '').trim().toLowerCase();
  return items.filter((item) => {
    const linkedProduct = getLinkedProductDisplay(item);
    const matchesQuery = !query ||
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.modifierGroup || '').toLowerCase().includes(query) ||
      String(item.statusLabel || '').toLowerCase().includes(query) ||
      linkedProduct.value.toLowerCase().includes(query) ||
      linkedProduct.title.toLowerCase().includes(query);
    const matchesGroup = !filters.category || item.modifierGroup === filters.category;
    const matchesStatus = !filters.status || item.status === filters.status;
    return matchesQuery && matchesGroup && matchesStatus;
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
  return [...new Set(items.map((item) => item.category || 'General'))]
    .sort((a, b) => a.localeCompare(b));
}

function getModifierGroups(items) {
  return [...new Set(items.map((item) => item.modifierGroup || 'Modifier Group'))]
    .sort((a, b) => a.localeCompare(b));
}

function parseCurrencyInput(value) {
  return Number.parseFloat(String(value || 0).replace(',', '.')) || 0;
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
    console.warn('[Menu Catalogue] Barcode scanner failed:', error);
  }
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
