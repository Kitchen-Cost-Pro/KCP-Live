import '../styles/locations.css';
import '../styles/fieldHelp.css';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';

export function renderLocations({ state, onLocationFilterChange, onLocationAction = {} } = {}) {
  const locations = state.locations || {};
  const filters = {
    query: '',
    ...locations.filters
  };
  const query = String(filters.query || '').trim().toLowerCase();
  const items = locations.items || [];
  const stockCategories = getLocationRoutingCategories(state);
  const locationContext = {
    locations: items,
    stockCategories,
    settings: state.settings
  };
  const visibleLocations = items.filter((location) => {
    if (!query) return true;
    return getLocationDisplayName(location).toLowerCase().includes(query) ||
      String(location.name || '').toLowerCase().includes(query) ||
      String(location.code || '').toLowerCase().includes(query) ||
      String(location.notes || '').toLowerCase().includes(query);
  });
  const editingLocation = locations.editingLocation || null;
  const createOpen = locations.createOpen === true;
  const isInitialLoading = locations.status === 'loading' && !items.length;
  const draft = {
    name: '',
    code: '',
    type: 'storage',
    notes: '',
    ...(locations.draft || {}),
    name: locations.draft?.name ?? locations.draftName ?? ''
  };

  const view = document.createElement('section');
  view.id = 'view-locations';
  view.className = `locationsView ${createOpen ? 'locationsView--create' : ''}`;
  view.innerHTML = `
    ${locations.actionError ? renderNotice(locations.actionError, 'error') : ''}

    <div class="locationsShell">
      <section class="locationsWorkbench">
        <header class="locationsHeader">
          <div>
            <p>Business Locations</p>
            <h1>Locations</h1>
            <span>Manage Yoco selling locations and storage locations for this workspace.</span>
          </div>
          <div class="locationsHeaderActions">
            <button type="button" class="locationsPrimaryButton" data-location-open-create>
              ${icon('plus')}
              <span>Add Storage</span>
            </button>
          </div>
        </header>

        ${createOpen ? renderCreateForm(draft, locations.actionStatus, locationContext) : `
          <div class="locationsToolbar">
            <label class="locationsSearch">
              ${renderFieldHelpLabel('Search', 'Find a selling location by name, code, or note.')}
              <input
                type="search"
                value="${escapeAttribute(filters.query || '')}"
                placeholder="Find a location..."
                data-location-search
              />
            </label>
            <div class="locationsToolbarMeta">
              <span>${visibleLocations.length}</span>
              <strong>locations</strong>
            </div>
            <div class="locationsToolbarMeta">
              <span>${formatCurrency(sumBy(visibleLocations, 'stockValue'))}</span>
              <strong>stock value</strong>
            </div>
          </div>

          ${isInitialLoading
            ? renderLoadingPanel('Loading locations', 'Fetching selling locations, storage locations, and routing details.')
            : locations.status === 'error'
              ? renderNotice(locations.error || 'Could not load locations.', 'error')
              : renderLocationSections(visibleLocations)}
        `}
      </section>
    </div>

    ${editingLocation ? renderEditModal(editingLocation, locationContext) : ''}
    ${renderStockRoutingModal(locations.routingModal, draft, editingLocation, locationContext)}
    ${renderToast(locations.toast)}
  `;

  bindLocationEvents(view, onLocationFilterChange, onLocationAction);
  bindFieldHelpTooltips(view);
  return view;
}

function bindLocationEvents(view, onLocationFilterChange, onLocationAction) {
  view.querySelector('[data-location-open-create]')?.addEventListener('click', () => onLocationAction.onOpenCreate?.());
  view.querySelectorAll('[data-location-create-close]').forEach((button) => {
    button.addEventListener('click', () => onLocationAction.onCloseCreate?.());
  });
  view.querySelector('[data-location-search]')?.addEventListener('input', (event) => {
    onLocationFilterChange?.({ query: event.currentTarget.value });
  });
  view.querySelectorAll('[data-location-draft-field]').forEach((field) => {
    if (field.dataset.locationRoutingCategory) return;
    field.addEventListener(getFieldEventName(field), (event) => {
      onLocationAction.onPreserveFocus?.(event.currentTarget);
      onLocationAction.onUpdateDraft?.({ [event.currentTarget.dataset.locationDraftField]: event.currentTarget.value });
    });
  });
  view.querySelectorAll('[data-location-draft-routing]').forEach((field) => {
    field.addEventListener('change', (event) => {
      onLocationAction.onUpdateDraftRouting?.(event.currentTarget.dataset.locationRoutingCategory || '', event.currentTarget.value);
    });
  });
  view.querySelectorAll('[data-location-open-routing]').forEach((button) => {
    button.addEventListener('click', () => onLocationAction.onOpenRouting?.(button.dataset.locationOpenRouting || 'draft'));
  });
  view.querySelectorAll('[data-location-site-info-toggle]').forEach((button) => {
    button.addEventListener('click', () => onLocationAction.onToggleSiteInfo?.(button.dataset.locationSiteInfoToggle || 'draft'));
  });
  view.querySelectorAll('[data-location-routing-close]').forEach((button) => {
    button.addEventListener('click', () => onLocationAction.onCloseRouting?.());
  });
  view.querySelectorAll('[data-location-routing-search]').forEach((field) => {
    field.addEventListener('input', () => filterRoutingBucket(field));
  });
  view.querySelectorAll('[data-location-routing-chip]').forEach((chip) => {
    chip.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', chip.dataset.locationRoutingCategory || '');
      event.dataTransfer?.setData('application/x-kcp-routing-category', chip.dataset.locationRoutingCategory || '');
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
  });
  view.querySelectorAll('[data-location-routing-unassign]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onLocationAction.onAssignRouting?.(
        button.dataset.locationRoutingMode || 'draft',
        button.dataset.locationRoutingCategory || '',
        'self'
      );
    });
  });
  view.querySelectorAll('[data-location-routing-drop]').forEach((bucket) => {
    bucket.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      bucket.classList.add('locationsRoutingBucket--over');
    });
    bucket.addEventListener('dragleave', () => {
      bucket.classList.remove('locationsRoutingBucket--over');
    });
    bucket.addEventListener('drop', (event) => {
      event.preventDefault();
      bucket.classList.remove('locationsRoutingBucket--over');
      const category = event.dataTransfer?.getData('application/x-kcp-routing-category') ||
        event.dataTransfer?.getData('text/plain') ||
        '';
      onLocationAction.onAssignRouting?.(
        bucket.dataset.locationRoutingMode || 'draft',
        category,
        bucket.dataset.locationRoutingTarget || 'self'
      );
    });
  });
  view.querySelector('[data-location-save-new]')?.addEventListener('click', () => onLocationAction.onSaveNew?.());
  view.querySelectorAll('[data-location-edit]').forEach((button) => {
    button.addEventListener('click', () => onLocationAction.onOpenEdit?.(button.dataset.locationEdit || ''));
  });
  view.querySelectorAll('[data-location-delete]').forEach((button) => {
    button.addEventListener('click', () => onLocationAction.onDelete?.(button.dataset.locationDelete || ''));
  });
  view.querySelectorAll('[data-location-edit-close]').forEach((button) => {
    button.addEventListener('click', () => onLocationAction.onCloseEdit?.());
  });
  view.querySelector('[data-location-edit-save]')?.addEventListener('click', () => {
    const updates = collectLocationEditModalUpdates(view);
    if (Object.keys(updates).length) onLocationAction.onUpdateEditing?.(updates);
    onLocationAction.onSaveEdit?.();
  });
  view.querySelectorAll('[data-location-edit-field]').forEach((field) => {
    if (field.dataset.locationRoutingCategory) return;
    field.addEventListener('change', (event) => {
      onLocationAction.onPreserveFocus?.(event.currentTarget);
      onLocationAction.onUpdateEditing?.({ [event.currentTarget.dataset.locationEditField]: event.currentTarget.value });
    });
  });
  view.querySelectorAll('[data-location-edit-routing]').forEach((field) => {
    field.addEventListener('change', (event) => {
      onLocationAction.onUpdateEditingRouting?.(event.currentTarget.dataset.locationRoutingCategory || '', event.currentTarget.value);
    });
  });
  view.querySelectorAll('[data-location-tax-toggle]').forEach((field) => {
    field.addEventListener('change', (event) => {
      updateLocationTaxDraft(event.currentTarget, onLocationAction);
    });
  });
  view.querySelectorAll('[data-location-tax-field]').forEach((field) => {
    const handleTaxFieldChange = (event) => updateLocationTaxDraft(event.currentTarget, onLocationAction);
    field.addEventListener('change', handleTaxFieldChange);
  });
  view.querySelectorAll('[data-location-site-info-field]').forEach((field) => {
    const handleSiteInfoChange = (event) => updateLocationSiteInfoDraft(event.currentTarget, onLocationAction);
    field.addEventListener('change', handleSiteInfoChange);
  });
  view.querySelector('[data-location-toast-close]')?.addEventListener('click', () => onLocationAction.onDismissToast?.());
}

function filterRoutingBucket(field) {
  const bucket = field.closest('[data-location-routing-drop]');
  if (!bucket) return;
  const query = String(field.value || '').trim().toLowerCase();
  let visibleCount = 0;
  bucket.querySelectorAll('[data-location-routing-chip]').forEach((chip) => {
    const text = String(chip.dataset.locationRoutingSearch || chip.textContent || '').toLowerCase();
    const isVisible = !query || text.includes(query);
    chip.hidden = !isVisible;
    if (isVisible) visibleCount += 1;
  });
  const empty = bucket.querySelector('[data-location-routing-no-results]');
  if (empty) empty.hidden = visibleCount > 0;
}

function updateLocationTaxDraft(field, onLocationAction = {}) {
  const mode = field.dataset.locationTaxMode === 'edit' ? 'edit' : 'draft';
  const key = field.dataset.locationTaxField || '';
  const source = mode === 'edit'
    ? field.closest('.locationsModalCard')?.querySelector('[data-location-tax-state]')?.dataset.locationTaxState
    : field.closest('.locationsDetailForm')?.querySelector('[data-location-tax-state]')?.dataset.locationTaxState;
  const current = normalizeLocationTaxInfo(parseJson(source));
  const nextTaxInfo = field.matches('[data-location-tax-toggle]')
    ? { ...current, useDifferentTaxInfo: field.checked }
    : { ...current, [key]: field.value };
  if (mode === 'edit') onLocationAction.onUpdateEditing?.({ taxInfo: nextTaxInfo });
  else onLocationAction.onUpdateDraft?.({ taxInfo: nextTaxInfo });
}

function updateLocationSiteInfoDraft(field, onLocationAction = {}) {
  const mode = field.dataset.locationSiteInfoMode === 'edit' ? 'edit' : 'draft';
  const key = field.dataset.locationSiteInfoField || '';
  const source = field.closest('.locationsSiteInfoPanel')?.querySelector('[data-location-site-info-state]')?.dataset.locationSiteInfoState;
  const current = normalizeLocationSiteInfo(parseJson(source));
  const nextSiteInfo = { ...current, [key]: field.value };
  onLocationAction.onPreserveFocus?.(field);
  if (mode === 'edit') onLocationAction.onUpdateEditing?.({ siteInfo: nextSiteInfo });
  else onLocationAction.onUpdateDraft?.({ siteInfo: nextSiteInfo });
}

function collectLocationEditModalUpdates(view) {
  const modal = view.querySelector('.locationsModalCard');
  if (!modal) return {};
  const updates = {};
  modal.querySelectorAll('[data-location-edit-field]').forEach((field) => {
    if (field.dataset.locationRoutingCategory) return;
    const key = field.dataset.locationEditField || '';
    if (key) updates[key] = field.value;
  });

  const taxState = modal.querySelector('[data-location-tax-state]')?.dataset.locationTaxState;
  const taxInfo = normalizeLocationTaxInfo(parseJson(taxState));
  const taxToggle = modal.querySelector('[data-location-tax-toggle]');
  if (taxToggle) taxInfo.useDifferentTaxInfo = taxToggle.checked;
  modal.querySelectorAll('[data-location-tax-field]').forEach((field) => {
    const key = field.dataset.locationTaxField || '';
    if (key) taxInfo[key] = field.value;
  });
  if (taxToggle || modal.querySelector('[data-location-tax-field]')) updates.taxInfo = taxInfo;

  const siteInfoState = modal.querySelector('[data-location-site-info-state]')?.dataset.locationSiteInfoState;
  const siteInfo = normalizeLocationSiteInfo(parseJson(siteInfoState));
  modal.querySelectorAll('[data-location-site-info-field]').forEach((field) => {
    const key = field.dataset.locationSiteInfoField || '';
    if (key) siteInfo[key] = field.value;
  });
  if (modal.querySelector('[data-location-site-info-field]')) updates.siteInfo = siteInfo;

  return updates;
}

function renderLocationSections(locations = []) {
  if (!locations.length) return '<div class="locationsEmpty">No locations match this search.</div>';
  const storageLocations = locations.filter(isStorageLocation);
  const sellingLocations = locations.filter((location) => !isStorageLocation(location));

  return `
    ${sellingLocations.length ? `
      <section class="locationsSection">
        <div class="locationsSectionHead">
          <span>Selling Locations</span>
        </div>
        <div class="locationsSiteList locationsSiteList--flat">
          ${sellingLocations.map(renderLocationCard).join('')}
        </div>
      </section>
    ` : ''}

    ${storageLocations.length ? `
      <section class="locationsSection locationsSection--storage">
        <div class="locationsSectionDivider" aria-hidden="true"></div>
        <div class="locationsSectionHead">
          <span>Storage</span>
        </div>
        <div class="locationsSiteList locationsSiteList--flat">
          ${storageLocations.map(renderLocationCard).join('')}
        </div>
      </section>
    ` : ''}
  `;
}

function renderLocationCard(location) {
  const isDefault = isDefaultLocation(location);
  const displayName = getLocationDisplayName(location);
  const officialName = getOfficialLocationName(location);
  const showOfficialName = officialName && officialName.toLowerCase() !== displayName.toLowerCase();
  const typeLabel = isDefault ? 'Main' : (isStorageLocation(location) ? 'Storage' : 'Selling Location');
  return `
    <article class="locationsSiteCard locationsSiteCard--flat">
      <header class="locationsSiteHead">
        <div>
          <span class="locationsTypePill">${escapeHtml(typeLabel)}</span>
          <h2>${escapeHtml(displayName)}</h2>
          <div class="locationsCardBadges">
            ${isDefault ? `<span class="locationsSystemBadge">${icon('star')} Default Location</span>` : ''}
            ${showOfficialName ? `<span class="locationsFormerly">Yoco: ${escapeHtml(officialName)}</span>` : ''}
            ${!isStorageLocation(location) ? renderSiteInfoBadge(location.siteInfo || {}) : ''}
          </div>
          ${location.notes ? `<p>${escapeHtml(location.notes)}</p>` : ''}
        </div>
        <div class="locationsCardActions">
          <div class="locationsActionMenu">
            <button type="button" class="locationsIconButton locationsIconButton--more" data-location-edit="${escapeAttribute(location.id)}" aria-label="Manage location">${icon('more')}</button>
            <div class="locationsActionMenuPanel">
              <span>${isStorageLocation(location) ? 'Manage Location' : 'Edit Site Information'}</span>
            </div>
          </div>
        </div>
      </header>

      <div class="locationsBentoMetrics">
        <div class="locationsBentoMetric">
          <span class="locationsMetricIcon locationsMetricIcon--stock">${icon('box')}</span>
          <label>Stock Items</label>
          <strong>${formatNumber(location.stockItems || 0)}</strong>
        </div>
        <div class="locationsBentoMetric">
          <span class="locationsMetricIcon locationsMetricIcon--qty">${icon('clipboard')}</span>
          <label>On Hand Qty</label>
          <strong>${formatNumber(location.onHandQty || 0)}</strong>
        </div>
        <div class="locationsBentoMetric locationsBentoMetric--wide">
          <span class="locationsMetricIcon locationsMetricIcon--value">${icon('database')}</span>
          <label>Stock Value</label>
          <strong>${formatCurrency(location.stockValue || 0)}</strong>
        </div>
      </div>

    </article>
  `;
}

function renderCreateForm(draft, actionStatus, context = {}) {
  // Only block the button while a save is in flight — NOT on an empty name. renderApp() is
  // suppressed while the name input is focused, so gating `disabled` on draft.name left the
  // button stuck-disabled after typing and the first click was a silent no-op. The handler
  // (saveNewLocationEntry) already validates an empty name and toasts.
  const canSave = actionStatus !== 'saving';
  return `
    <section class="locationsDetailForm" aria-label="Add location details">
      <header class="locationsDetailHead">
        <button type="button" class="locationsGhostButton" data-location-create-close>${icon('arrowLeft')} Back</button>
        <div>
          <p>Storage Location</p>
          <h2>Add Storage Location</h2>
          <span>Create a storage location for stock receiving, routing, transfers, and reporting.</span>
        </div>
      </header>

      <div class="locationsDetailGrid">
        ${renderLocationFields(draft, 'draft', context)}
      </div>

      <div class="locationsModalActions">
        <button type="button" class="locationsGhostButton" data-location-create-close>Cancel</button>
        <button type="button" class="locationsPrimaryButton" data-location-save-new ${canSave ? '' : 'disabled'}>
          ${icon('check')}
          <span>${actionStatus === 'saving' ? 'Saving' : 'Save Location'}</span>
        </button>
      </div>
    </section>
  `;
}

function renderEditModal(location, context = {}) {
  const displayName = getLocationDisplayName(location);
  const canDeleteStorage = isStorageLocation(location) && !isDefaultLocation(location);
  return `
    <div class="locationsModalBackdrop">
      <section class="locationsModalCard locationsModalCard--routing" data-scroll-key="locations-edit-modal">
        <header class="locationsModalHead">
          <div>
            <p>${isStorageLocation(location) ? 'Storage Location' : 'Selling Location'}</p>
            <h3>${escapeHtml(displayName || 'Edit Location')}</h3>
          </div>
          <button type="button" class="locationsIconButton" data-location-edit-close aria-label="Close">${icon('x')}</button>
        </header>

        <div class="locationsModalGrid">
          ${renderLocationFields(location, 'edit', context)}
        </div>

        <div class="locationsModalActions locationsModalActions--split">
          <div>
            ${canDeleteStorage ? `
              <button type="button" class="locationsDangerButton" data-location-delete="${escapeAttribute(location.id)}">
                ${icon('trash')}
                <span>Delete Storage Location</span>
              </button>
            ` : ''}
          </div>
          <div>
            <button type="button" class="locationsGhostButton" data-location-edit-close>Cancel</button>
            <button type="button" class="locationsPrimaryButton" data-location-edit-save ${String(location.name || '').trim() ? '' : 'disabled'}>Save</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderLocationFields(location, mode, context = {}) {
  const prefix = mode === 'edit' ? 'location-edit' : 'location-draft';
  const fieldAttribute = mode === 'edit' ? 'data-location-edit-field' : 'data-location-draft-field';
  const isYocoManaged = isYocoManagedLocation(location);
  const displayName = getLocationDisplayName(location);
  const officialName = getOfficialLocationName(location);
  const showOfficialName = isYocoManaged && officialName && officialName.toLowerCase() !== displayName.toLowerCase();

  return `
    <label class="locationsModalField">
      ${renderFieldHelpLabel(isYocoManaged ? 'Custom Display Name' : 'Location Name', isYocoManaged ? 'This label is used inside KCP. The official Yoco location name is preserved for future syncs.' : 'The location name staff will see across stock movements and reports.')}
      <input type="text" value="${escapeAttribute(displayName || '')}" placeholder="E.g. Kloof Street" ${fieldAttribute}="name" data-focus-key="${prefix}-name" />
      ${isYocoManaged ? `<span class="locationsFieldHint">Yoco official name: ${escapeHtml(officialName || location.name || '')}</span>` : ''}
      ${showOfficialName ? `<span class="locationsFieldHint">Showing in KCP as: ${escapeHtml(displayName)}</span>` : ''}
    </label>
    <label class="locationsModalField">
      ${renderFieldHelpLabel('Code', 'Optional short code for compact reporting and exports.')}
      <input type="text" value="${escapeAttribute(location.code || '')}" placeholder="E.g. KLOOF" ${fieldAttribute}="code" data-focus-key="${prefix}-code" />
    </label>
    <label class="locationsModalField locationsModalField--wide">
      ${renderFieldHelpLabel('Notes', 'Optional internal context for this selling location.')}
      <textarea placeholder="Optional note..." ${fieldAttribute}="notes" data-focus-key="${prefix}-notes">${escapeHtml(location.notes || '')}</textarea>
    </label>
    ${isStorageLocation(location) ? '' : renderLocationSiteInfoSection(location, mode)}
    ${isStorageLocation(location) ? '' : renderLocationTaxInfoSection(location, mode)}
    ${renderStockRoutingSelector(location, context, { mode, prefix })}
  `;
}

function renderSiteInfoBadge(siteInfo = {}) {
  const complete = isLocationSiteInfoComplete(siteInfo);
  return `<span class="${complete ? 'locationsSiteInfoBadge locationsSiteInfoBadge--complete' : 'locationsSiteInfoBadge locationsSiteInfoBadge--missing'}">${complete ? 'Site Info Complete' : 'Site Info Missing'}</span>`;
}

function renderLocationSiteInfoSection(location = {}, mode = 'edit') {
  const siteInfo = normalizeLocationSiteInfo(location.siteInfo || {});
  const isOpen = location.__siteInfoOpen === true;
  const prefix = mode === 'edit' ? 'location-edit-site' : 'location-draft-site';
  const fields = [
    ['Supplier-Facing Delivery Name', 'supplierFacingDeliveryName'],
    ['Delivery Address', 'deliveryAddressLine1'],
    ['City', 'city'],
    ['Receiving Contact Name', 'receivingContactName'],
    ['Receiving Contact Phone', 'receivingContactPhone'],
    ['Receiving Contact Email', 'receivingContactEmail'],
    ['Delivery Instructions', 'deliveryInstructions', 'textarea']
  ];
  return `
    <section class="locationsModalField locationsModalField--wide locationsSiteInfoPanel ${isOpen ? 'locationsSiteInfoPanel--open' : ''}">
      <input type="hidden" data-location-site-info-state="${escapeAttribute(JSON.stringify(siteInfo))}" />
      <div class="locationsSiteInfoHead">
        <div>
          ${renderFieldHelpLabel('Site Information', 'Supplier-facing delivery and receiving details for this selling location.')}
          <p>Used on purchase orders and supplier communication. Stock movement logic still uses the internal location.</p>
        </div>
        <div class="locationsSiteInfoHeadActions">
          ${renderSiteInfoBadge(siteInfo)}
          <button
            type="button"
            class="locationsSectionToggle"
            data-location-site-info-toggle="${escapeAttribute(mode)}"
            aria-expanded="${isOpen ? 'true' : 'false'}"
          >
            <span>${isOpen ? 'Close' : 'Open'}</span>
            ${icon('chevronDown')}
          </button>
        </div>
      </div>
      <div class="locationsSiteInfoGrid" ${isOpen ? '' : 'hidden'}>
        ${fields.map(([label, key, type]) => `
          <label class="${['supplierFacingDeliveryName', 'deliveryAddressLine1', 'deliveryAddressLine2', 'deliveryInstructions', 'supplierNotes'].includes(key) ? 'locationsModalField--wide' : ''}">
            <span>${escapeHtml(label)}</span>
            ${type === 'textarea' ? `
              <textarea
                data-location-site-info-field="${escapeAttribute(key)}"
                data-location-site-info-mode="${escapeAttribute(mode)}"
                data-focus-key="${prefix}-${escapeAttribute(key)}"
              >${escapeHtml(siteInfo[key] || '')}</textarea>
            ` : `
              <input
                type="${key === 'receivingContactEmail' ? 'email' : 'text'}"
                value="${escapeAttribute(siteInfo[key] || '')}"
                data-location-site-info-field="${escapeAttribute(key)}"
                data-location-site-info-mode="${escapeAttribute(mode)}"
                data-focus-key="${prefix}-${escapeAttribute(key)}"
              />
            `}
          </label>
        `).join('')}
      </div>
    </section>
  `;
}

function renderLocationTaxInfoSection(location = {}, mode = 'edit') {
  const taxInfo = normalizeLocationTaxInfo(location.taxInfo || {});
  const prefix = mode === 'edit' ? 'location-edit-tax' : 'location-draft-tax';
  const fields = [
    ['Registered Company Name', 'registeredCompanyName'],
    ['Trading Name', 'tradingName'],
    ['Company Registration No', 'companyRegistrationNumber'],
    ['VAT Number', 'vatNumber'],
    ['Tax Number', 'taxNumber'],
    ['Registered Address', 'registeredAddress'],
    ['Accounts Contact Name', 'accountsContactName'],
    ['Accounts Contact Email', 'accountsContactEmail'],
    ['Accounts Contact Phone', 'accountsContactPhone']
  ];
  return `
    <section class="locationsModalField locationsModalField--wide locationsTaxPanel">
      <input type="hidden" data-location-tax-state="${escapeAttribute(JSON.stringify(taxInfo))}" />
      <div class="locationsTaxHead">
        <div>
          ${renderFieldHelpLabel('Site Tax Information', 'Optional legal and tax details for this selling location. If disabled, company tax information is used.')}
          <p>${taxInfo.useDifferentTaxInfo ? 'This selling location has its own supplier-facing legal details.' : 'This site uses the company tax information.'}</p>
        </div>
        <label class="locationsSwitch">
          <input type="checkbox" data-location-tax-toggle data-location-tax-mode="${escapeAttribute(mode)}" ${taxInfo.useDifferentTaxInfo ? 'checked' : ''} />
          <span>Use different tax information for this site</span>
        </label>
      </div>
      ${taxInfo.useDifferentTaxInfo ? `
        <div class="locationsTaxGrid">
          ${fields.map(([label, key]) => `
            <label class="${key === 'registeredAddress' ? 'locationsModalField--wide' : ''}">
              <span>${escapeHtml(label)}</span>
              <input
                type="${key === 'accountsContactEmail' ? 'email' : 'text'}"
                value="${escapeAttribute(taxInfo[key] || '')}"
                data-location-tax-field="${escapeAttribute(key)}"
                data-location-tax-mode="${escapeAttribute(mode)}"
                data-focus-key="${prefix}-${escapeAttribute(key)}"
              />
            </label>
          `).join('')}
        </div>
      ` : ''}
    </section>
  `;
}

function renderStockRoutingSelector(location = {}, context = {}, { mode } = {}) {
  const categories = context.stockCategories || [];
  const routing = normalizeStockRouting(location.stockRouting);
  const buckets = getRoutingBuckets(location, context.locations || []);
  const assigned = categories.map((category) => getCategoryTarget(category, routing, buckets));
  const selfCount = assigned.filter((target) => target === 'self').length;
  const reroutedCount = assigned.filter((target) => target !== 'self').length;

  return `
    <section class="locationsModalField locationsModalField--wide locationsRoutingPanel">
      <div class="locationsRoutingHead">
        <div>
          ${renderFieldHelpLabel('Stock Routing', 'For each internal stock category, choose whether Yoco sales deplete this location or another selling location such as Kitchen.')}
          <p>Choose where each category should be deducted from when this location makes a sale.</p>
        </div>
        <button type="button" class="locationsRoutingOpenButton" data-location-open-routing="${escapeAttribute(mode || 'draft')}">
          ${icon('route')}
          <span>Configure Routing</span>
        </button>
      </div>
      ${categories.length ? `
        <div class="locationsRoutingSummary">
          <span><strong>${formatNumber(categories.length)}</strong> categories</span>
          <span><strong>${formatNumber(selfCount)}</strong> self</span>
          <span><strong>${formatNumber(reroutedCount)}</strong> rerouted</span>
        </div>
      ` : `
          <div class="locationsRoutingEmpty">
            Import or create stock items first. Categories will appear here automatically.
          </div>
      `}
    </section>
  `;
}

function renderStockRoutingModal(routingModal, draft, editingLocation, context = {}) {
  if (!routingModal?.open) return '';
  const mode = routingModal.mode === 'edit' ? 'edit' : 'draft';
  const location = mode === 'edit' ? editingLocation : draft;
  if (!location) return '';

  const categories = context.stockCategories || [];
  const routing = normalizeStockRouting(location.stockRouting);
  const buckets = getRoutingBuckets(location, context.locations || []);
  const grouped = buckets.map((bucket) => ({
    ...bucket,
    categories: categories.filter((category) => getCategoryTarget(category, routing, buckets) === bucket.id)
  }));
  const selfBucket = grouped.find((bucket) => bucket.id === 'self') || {
    id: 'self',
    eyebrow: 'Default',
    name: `Self (${location.name || 'this location'})`,
    hint: 'Deduct from this location.',
    group: 'self',
    categories: []
  };
  const destinationBuckets = grouped.filter((bucket) => bucket.id !== 'self');
  const sellingBuckets = destinationBuckets.filter((bucket) => bucket.group === 'selling');
  const storageBuckets = destinationBuckets.filter((bucket) => bucket.group === 'storage');
  const selfCount = selfBucket.categories.length;
  const reroutedCount = categories.length - selfCount;
  const mappedDestinations = destinationBuckets.filter((bucket) => bucket.categories.length > 0).length;

  return `
    <div class="locationsModalBackdrop locationsRoutingModalBackdrop">
      <section class="locationsModalCard locationsRoutingModalCard" role="dialog" aria-modal="true" aria-labelledby="locations-routing-title" data-scroll-key="locations-routing-modal">
        <header class="locationsModalHead locationsRoutingModalHead">
          <div>
            <p>Stock Routing</p>
            <h3 id="locations-routing-title">${escapeHtml(getLocationDisplayName(location) || 'New Location')}</h3>
            <span>All stock categories deduct from Self by default. Drag categories to another location only when stock should be supplied from there.</span>
          </div>
          <button type="button" class="locationsIconButton" data-location-routing-close aria-label="Close">${icon('x')}</button>
        </header>

        ${categories.length ? `
          <div class="locationsRoutingStats">
            ${renderRoutingStat({
              iconName: 'route',
              title: 'Unmoved categories stay on Self',
              value: '',
              detail: `All categories that remain in ${selfBucket.name} will continue to deduct from Self.`
            })}
            ${renderRoutingStat({ iconName: 'box', value: buckets.length, title: 'Total locations', detail: 'Including Self' })}
            ${renderRoutingStat({ iconName: 'check', value: selfCount, title: 'Categories on Self', detail: 'Default source' })}
            ${renderRoutingStat({ iconName: 'route', value: reroutedCount, title: 'Rerouted categories', detail: 'Moved to other locations' })}
            ${renderRoutingStat({ iconName: 'database', value: mappedDestinations, title: 'Destinations mapped', detail: 'Receiving categories' })}
          </div>

          <div class="locationsRoutingWorkspace">
            ${renderRoutingSelfBucket(selfBucket, categories.length, reroutedCount, mode)}
            <div class="locationsRoutingDestinations">
              ${renderRoutingSection('Selling Locations', 'Reroute stock deduction to selling locations.', sellingBuckets, mode, 'selling')}
              ${renderRoutingSection('Storage Locations', 'Reroute stock deduction to storage locations.', storageBuckets, mode, 'storage')}
            </div>
          </div>
        ` : `
          <div class="locationsRoutingEmpty locationsRoutingEmpty--modal">
            Import or create stock items first. Categories will appear here automatically.
          </div>
        `}

        <div class="locationsRoutingFooter">
          <span>${icon('box')} All categories not moved to another location will continue to deduct from Self.</span>
          <div>
            <button type="button" class="locationsSecondaryButton" data-location-routing-close>Cancel</button>
            <button type="button" class="locationsPrimaryButton" data-location-routing-close>${icon('check')}<span>Save routing</span></button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderRoutingStat({ iconName = 'box', value = '', title = '', detail = '' } = {}) {
  return `
    <article class="locationsRoutingStat ${value === '' ? 'locationsRoutingStat--wide' : ''}">
      <span>${icon(iconName)}</span>
      ${value !== '' ? `<strong>${formatNumber(value)}</strong>` : ''}
      <div>
        <b>${escapeHtml(title)}</b>
        <em>${escapeHtml(detail)}</em>
      </div>
    </article>
  `;
}

function renderRoutingSelfBucket(bucket, totalCount = 0, reroutedCount = 0, mode = 'draft') {
  return `
    <aside
      class="locationsRoutingSelfBucket"
      data-location-routing-drop
      data-location-routing-mode="${escapeAttribute(mode)}"
      data-location-routing-target="self"
    >
      <header>
        <div>
          <span class="locationsRoutingStep">1</span>
          <strong>Default Categories</strong>
          <em>From ${escapeHtml(bucket.name)}</em>
        </div>
      </header>
      <p>All categories start here and deduct from Self unless moved to another location.</p>
      <p>Categories left here will continue deducting from Self.</p>
      <label class="locationsRoutingSearch">
        ${icon('search')}
        <input type="search" placeholder="Search categories..." data-location-routing-search aria-label="Search default categories" />
      </label>
      <div class="locationsRoutingFilters" aria-hidden="true">
        <span>All <b>${formatNumber(totalCount)}</b></span>
        <span>On Self <b>${formatNumber(bucket.categories.length)}</b></span>
        <span>Rerouted <b>${formatNumber(reroutedCount)}</b></span>
      </div>
      <div class="locationsRoutingChips locationsRoutingChips--self">
        ${bucket.categories.length ? bucket.categories.map((category) => renderRoutingChip(category, { mode, isSelf: true })).join('') : `
          <div class="locationsRoutingDropHint">Drop categories here to return them to Self</div>
        `}
        ${bucket.categories.length ? '<div class="locationsRoutingNoResults" data-location-routing-no-results hidden>No categories match.</div>' : ''}
      </div>
      <footer>${icon('route')} Drag a category to a destination on the right to reroute stock deduction.</footer>
    </aside>
  `;
}

function renderRoutingSection(title, description, buckets = [], mode = 'draft', variant = '') {
  if (!buckets.length) return '';
  const categoryCount = buckets.reduce((total, bucket) => total + (bucket.categories?.length || 0), 0);
  return `
    <section class="locationsRoutingSection locationsRoutingSection--${escapeAttribute(variant || 'default')}">
      <div class="locationsRoutingSectionHead">
        <div>
          <i>${icon(variant === 'storage' ? 'box' : 'route')}</i>
          <span>${escapeHtml(title)}</span>
          <p>${escapeHtml(description)}</p>
        </div>
        <em>${formatNumber(buckets.length)} ${buckets.length === 1 ? 'location' : 'locations'}</em>
      </div>
      <div class="locationsRoutingBuckets">
        ${buckets.map((bucket) => renderRoutingBucket(bucket, mode)).join('')}
      </div>
    </section>
  `;
}

function renderRoutingBucket(bucket, mode) {
  return `
    <article
      class="locationsRoutingBucket ${bucket.id === 'self' ? 'locationsRoutingBucket--self' : ''} ${bucket.group === 'storage' ? 'locationsRoutingBucket--storage' : ''}"
      data-location-routing-drop
      data-location-routing-mode="${escapeAttribute(mode)}"
      data-location-routing-target="${escapeAttribute(bucket.id)}"
    >
      <header>
        <div>
          <span>${escapeHtml(bucket.eyebrow)}</span>
          <strong>${escapeHtml(bucket.name)}</strong>
        </div>
        <em>${formatNumber(bucket.categories.length)}</em>
      </header>
      <p>${escapeHtml(bucket.hint)}</p>
      <label class="locationsRoutingSearch">
        ${icon('search')}
        <input type="search" placeholder="Search categories..." data-location-routing-search aria-label="Search ${escapeAttribute(bucket.name)} categories" />
      </label>
      <div class="locationsRoutingChips">
        ${bucket.categories.length ? bucket.categories.map((category) => renderRoutingChip(category, { mode, isSelf: false })).join('') : `
          <div class="locationsRoutingDropHint">${icon('arrowLeft')}<span>Drop categories here</span><small>or drag from the left</small></div>
        `}
        ${bucket.categories.length ? '<div class="locationsRoutingNoResults" data-location-routing-no-results hidden>No categories match.</div>' : ''}
      </div>
    </article>
  `;
}

function renderRoutingChip(category, { mode = 'draft', isSelf = false } = {}) {
  const categoryNames = category.categoryNames || [category.name].filter(Boolean);
  const categorySummary = categoryNames.length
    ? categoryNames.slice(0, 3).join(', ') + (categoryNames.length > 3 ? ` +${categoryNames.length - 3}` : '')
    : '';
  return `
    <div
      class="locationsRoutingChip ${isSelf ? 'locationsRoutingChip--self' : 'locationsRoutingChip--mapped'}"
      draggable="true"
      role="button"
      tabindex="0"
      data-location-routing-chip
      data-location-routing-category="${escapeAttribute(category.routeKey)}"
      data-location-routing-search="${escapeAttribute(`${category.name} ${categorySummary}`)}"
      aria-label="Drag ${escapeAttribute(category.name)} routing category"
    >
      <i>${icon('box')}</i>
      <strong>${escapeHtml(category.name)}</strong>
      ${categorySummary && categorySummary !== category.name ? `<span>${escapeHtml(categorySummary)}</span>` : ''}
      ${isSelf ? `<em>${formatNumber(category.itemCount || 0)}</em>` : `
        <button
          type="button"
          class="locationsRoutingChipRemove"
          data-location-routing-unassign
          data-location-routing-mode="${escapeAttribute(mode)}"
          data-location-routing-category="${escapeAttribute(category.routeKey)}"
          aria-label="Move ${escapeAttribute(category.name)} back to Self"
        >
          ${icon('x')}
        </button>
      `}
    </div>
  `;
}

function getRoutingBuckets(location = {}, locations = []) {
  const currentLocationId = String(location.id || '').trim();
  const currentGroup = isStockLocationForRouting(location) ? 'storage' : 'selling';
  return [
    {
      id: 'self',
      eyebrow: 'Default',
      name: `Self (${location.name || 'this location'})`,
      hint: currentGroup === 'storage' ? 'Deduct from this storage location.' : 'Deduct from this selling location.',
      group: currentGroup
    },
    ...locations
      .filter((entry) => entry?.id && String(entry.id || '') !== currentLocationId)
      .map((entry) => ({
        id: String(entry.id || ''),
        eyebrow: isStockLocationForRouting(entry) ? 'Storage Location' : 'Selling Location',
        name: entry.name || entry.id,
        hint: `Reroute stock deduction to ${entry.name || entry.id}.`,
        group: isStockLocationForRouting(entry) ? 'storage' : 'selling'
      }))
  ];
}

function getCategoryTarget(category = {}, routing = {}, buckets = []) {
  const bucketIds = new Set(buckets.map((bucket) => String(bucket.id)));
  const selected = String(routing[category.routeKey] || routing[category.name] || 'self').trim() || 'self';
  return bucketIds.has(selected) ? selected : 'self';
}

function getLocationRoutingCategories(state = {}) {
  const stockItems = state.locations?.stockItems || [];
  const routingMap = state.settings?.values?.stockCategoryRoutingMap ||
    state.settings?.draft?.stockCategoryRoutingMap ||
    state.locations?.settings?.stockCategoryRoutingMap ||
    {};
  const categories = new Map();
  stockItems.forEach((item = {}) => {
    const name = normalizeStockCategoryName(item.category || 'General');
    const mapped = getMappedRoutingLabel(name, routingMap);
    const routeKey = mapped || name;
    const current = categories.get(routeKey) || {
      id: routeKey,
      routeKey,
      name: routeKey,
      categoryNames: [],
      itemCount: 0
    };
    const categoryNames = current.categoryNames.includes(name)
      ? current.categoryNames
      : [...current.categoryNames, name];
    categories.set(routeKey, {
      ...current,
      categoryNames,
      itemCount: current.itemCount + 1
    });
  });
  return [...categories.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getMappedRoutingLabel(categoryName = '', routingMap = {}) {
  const entry = routingMap[categoryName] || routingMap[normalizeStockCategoryName(categoryName)] || '';
  return String(entry && typeof entry === 'object' ? entry.routingLabel || entry.label || entry.name || '' : entry).trim();
}

function normalizeStockCategoryName(value = '') {
  return String(value || 'General')
    .trim()
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s*\(([^)]+)\)\s*-\s*Manufactured$/i, '$1')
    .trim() || 'General';
}

function normalizeStockRouting(value = {}) {
  if (typeof value === 'string') {
    return value.split(/[\n,;]+/).reduce((map, pair) => {
      const [label, target] = String(pair || '').split(/[:=]/);
      const key = String(label || '').trim();
      const routeTarget = String(target || '').trim();
      if (key && routeTarget) map[key] = routeTarget;
      return map;
    }, {});
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((map, [label, target]) => {
    const key = String(label || '').trim();
    const routeTarget = String(target || '').trim();
    if (key && routeTarget) map[key] = routeTarget;
    return map;
  }, {});
}

function normalizeLocationTaxInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    useDifferentTaxInfo: source.useDifferentTaxInfo === true || String(source.useDifferentTaxInfo || '').toLowerCase() === 'true',
    registeredCompanyName: String(source.registeredCompanyName || '').trim(),
    tradingName: String(source.tradingName || '').trim(),
    companyRegistrationNumber: String(source.companyRegistrationNumber || '').trim(),
    vatNumber: String(source.vatNumber || '').trim(),
    taxNumber: String(source.taxNumber || '').trim(),
    registeredAddress: String(source.registeredAddress || '').trim(),
    registeredAddressLine1: String(source.registeredAddressLine1 || '').trim(),
    registeredAddressLine2: String(source.registeredAddressLine2 || '').trim(),
    suburb: String(source.suburb || '').trim(),
    city: String(source.city || '').trim(),
    province: String(source.province || '').trim(),
    postalCode: String(source.postalCode || '').trim(),
    country: String(source.country || '').trim(),
    accountsContactName: String(source.accountsContactName || '').trim(),
    accountsContactEmail: String(source.accountsContactEmail || '').trim(),
    accountsContactPhone: String(source.accountsContactPhone || '').trim()
  };
}

function normalizeLocationSiteInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    siteTradingName: String(source.siteTradingName || ''),
    supplierFacingDeliveryName: String(source.supplierFacingDeliveryName || ''),
    deliveryAddressLine1: String(source.deliveryAddressLine1 || ''),
    deliveryAddressLine2: String(source.deliveryAddressLine2 || ''),
    suburb: String(source.suburb || ''),
    city: String(source.city || ''),
    province: String(source.province || ''),
    postalCode: String(source.postalCode || ''),
    country: String(source.country || ''),
    receivingContactName: String(source.receivingContactName || ''),
    receivingContactPhone: String(source.receivingContactPhone || ''),
    receivingContactEmail: String(source.receivingContactEmail || ''),
    deliveryInstructions: String(source.deliveryInstructions || ''),
    receivingHours: String(source.receivingHours || ''),
    supplierNotes: String(source.supplierNotes || '')
  };
}

function isLocationSiteInfoComplete(siteInfo = {}) {
  const info = normalizeLocationSiteInfo(siteInfo);
  return Boolean(
    info.supplierFacingDeliveryName &&
    info.deliveryAddressLine1 &&
    info.city &&
    (info.receivingContactName || info.receivingContactPhone || info.receivingContactEmail)
  );
}

function parseJson(value = '') {
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return {};
  }
}

function renderNotice(message, tone) {
  return `<div class="locationsNotice locationsNotice--${tone}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="locationsToast locationsToast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-location-toast-close aria-label="Dismiss">${icon('x')}<span>Close</span></button>
    </div>
  `;
}

function getFieldEventName(field) {
  return String(field.tagName || '').toLowerCase() === 'select' ? 'change' : 'input';
}

function sumBy(items = [], key = '') {
  return items.reduce((sum, item) => sum + (Number(item?.[key] || 0) || 0), 0);
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

function formatLocationType(value = '') {
  const label = String(value || 'selling').replace(/[-_]+/g, ' ').trim();
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)} Location` : 'Selling Location';
}

function getLocationDisplayName(location = {}) {
  return String(location.customName || location.displayName || location.name || '').trim();
}

function getOfficialLocationName(location = {}) {
  return String(location.yocoLocationName || location.name || location.originalName || '').trim();
}

function isYocoManagedLocation(location = {}) {
  return String(location.source || '').toLowerCase() === 'yoco' ||
    Boolean(String(location.yocoLocationId || location.yocoStoreLocationId || '').trim());
}

function isStorageLocation(location = {}) {
  return isDefaultLocation(location) ||
    String(location.type || '').toLowerCase() === 'storage';
}

function isDefaultLocation(location = {}) {
  const normalizedId = normalizeLocationKey(location.id || location.locationId);
  const normalizedName = normalizeLocationKey(getLocationDisplayName(location) || location.name);
  return location.isDefault === true ||
    location.systemLocked === true ||
    Number(location.is_default || location.isDefault || 0) === 1 ||
    ['main', 'locmain', 'mainstore', 'mainstorage', 'defaultstock'].includes(normalizedId) ||
    normalizedName === 'mainstore';
}

function normalizeLocationKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isStockLocationForRouting(location = {}) {
  const normalizedName = String(getLocationDisplayName(location) || location.name || location.id || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return isStorageLocation(location) || ['mainstore', 'main', 'defaultstock', 'stocklocation'].includes(normalizedName);
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
    arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h3a4 4 0 0 1 4 4v5"/><path d="m13 12 3 3 3-3"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
    clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h6"/><path d="M9 3h6v4H9z"/><path d="M7 5H5v16h14V5h-2"/><path d="M8 12h8"/><path d="M8 16h6"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3 2.54 5.15 5.69.83-4.12 4.01.97 5.66L12 15.98l-5.08 2.67.97-5.66-4.12-4.01 5.69-.83L12 3Z"/></svg>'
  };
  return icons[name] || '';
}
