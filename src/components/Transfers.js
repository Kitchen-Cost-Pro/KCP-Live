import '../styles/transfers.css';
import '../styles/fieldHelp.css';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';
import { getLocationStock } from '../utils/stockBalances.js';
import { ACTION_PERMISSION_MAP, hasPermission } from '../services/roleService.js';
import { isTransferEligibleStockItem } from '../services/stockCountEligibility.js';

export function renderTransfers({ state, onTransferFilterChange, onTransferAction = {} } = {}) {
  const transfers = state.transfers || {};
  const draft = transfers.draftTransfer || createEmptyDraft();
  const filters = {
    stockSearch: '',
    stockCategory: '',
    transferScope: 'internal',
    overlay: '',
    openDropdown: '',
    locationPicker: '',
    locationPickerSiteId: '',
    transferWorkflow: '',
    templateSearch: '',
    bulkTemplateId: '',
    selectedStockIds: [],
    ...transfers.filters
  };
  const workflow = ['normal', 'bulk', 'templates', 'template-builder'].includes(filters.transferWorkflow) ? filters.transferWorkflow : '';
  const transferScope = filters.transferScope === 'external' ? 'external' : 'internal';
  const localLocations = normalizeLocalLocations(transfers.locations || []);
  const locationOptions = localLocations.map((location) => ({ value: location.id, label: location.name || location.id, siteId: String(location.siteId || '') }));
  const currentProfile = createCurrentTransferProfile(state, draft, localLocations);
  const linkedProfiles = normalizeLinkedProfiles(transfers.linkedProfiles || []);
  // External transfer access is now driven strictly by the role permission set
  // (Roles & Permissions → External Transfers), not a per-user toggle.
  const userCanAccessExternalTransfers = hasPermission(
    ACTION_PERMISSION_MAP.externalTransfers,
    state.access?.currentRole,
    state.access?.customRoles || []
  );
  const siteConfig = createTransferSiteConfig({
    ...(transfers.siteConfig || {}),
    linkedSiteCount: Math.max(Number(transfers.siteConfig?.linkedSiteCount || transfers.siteConfig?.linked_site_count || 0), linkedProfiles.length),
    showExternalTransfer: userCanAccessExternalTransfers && (transfers.siteConfig?.showExternalTransfer === true || transfers.siteConfig?.show_external_transfer === true || linkedProfiles.length > 0)
  }, locationOptions.length);
  const selectedExternalProfile = linkedProfiles.find((profile) => String(profile.id) === String(draft.externalSiteId)) || null;
  const toProfiles = transferScope === 'external' ? linkedProfiles : [currentProfile];
  const selectedStockIds = new Set((filters.selectedStockIds || []).map(String));
  const stockMatches = getStockMatches(transfers.stockItems || [], filters.stockSearch || '', filters.stockCategory || '', draft.items || []);
  const pendingInboundTransfers = getPendingInboundTransfers(transfers.externalTransfers || [], state.workspace?.id);
  const canSave = canSaveTransferDraft({ draft, transferScope, siteConfig, actionStatus: transfers.actionStatus });
  const validation = transfers.validation || {};
  const bulkDrawerOpen = workflow === 'bulk' && (transfers.templates || [])
    .some((template) => String(template.id) === String(filters.bulkTemplateId || ''));

  const view = document.createElement('section');
  view.id = 'view-transfers';
  view.className = 'transfersView';
  view.dataset.openDropdown = filters.openDropdown || '';
  if (transfers.status === 'loading' && !(transfers.stockItems || []).length && !(transfers.locations || []).length) {
    view.innerHTML = renderLoadingPanel('Loading transfers', 'Fetching stock items, locations, templates, and linked sites.');
    return view;
  }
  view.innerHTML = `
    ${transfers.actionError && !bulkDrawerOpen ? renderNotice(transfers.actionError, 'error') : ''}

    <div class="transfersShell">
      ${renderPendingExternalTransfers(pendingInboundTransfers, transfers.receiveDrafts || {}, transfers.actionStatus)}
      ${!workflow ? renderTransferWorkflowChooser(siteConfig, linkedProfiles) : ''}
      ${workflow === 'bulk' ? renderBulkTransferWorkspace('bulk', transfers, filters, {
        draft,
        currentProfile,
        localLocations,
        linkedProfiles,
        siteConfig,
        canSave
      }) : ''}
      ${workflow === 'templates' ? renderBulkTransferWorkspace('templates', transfers, filters) : ''}
      ${workflow === 'template-builder' ? renderTransferTemplateBuilder(transfers, filters) : ''}
      ${workflow === 'normal' ? `
      <div class="transfersSectionNav">
        <button type="button" class="transfersMiniAction transfersMiniAction--back" data-transfer-workflow="">Back to Transfer Types</button>
      </div>
      <div class="transfersWorkbench">
        <section class="transfersComposerCard">
          <header class="transfersCardHead">
            <div>
              <p>Transfers</p>
              <h2>New Transfer</h2>
            </div>
            <button type="button" class="transfersInfoPill" aria-label="Transfer guidance">${icon('info')}</button>
          </header>

          <div class="transfersFormStack">
            ${renderTransferModePanel({ transferScope, siteConfig })}

            <div class="transfersLocationGrid">
              ${renderLocationSelectCard({
                side: 'from',
                title: 'From',
                profileName: currentProfile.name,
                locationName: draft.fromLocationName || getProfileLocationName(currentProfile, draft.fromLocationId) || '',
                emptyLabel: 'Choose source location',
                defaultSiteId: currentProfile.id,
                help: 'Source selling location that stock will be deducted from during this transfer.',
                invalid: validation.field === 'fromLocationId'
              })}
              ${renderLocationSelectCard({
                side: 'to',
                title: 'To',
                profileName: transferScope === 'external' ? (selectedExternalProfile?.name || '') : currentProfile.name,
                locationName: transferScope === 'external'
                  ? (draft.externalLocationName || getProfileLocationName(selectedExternalProfile, draft.externalLocationId) || '')
                  : (draft.toLocationName || getProfileLocationName(currentProfile, draft.toLocationId) || ''),
                emptyLabel: transferScope === 'external' ? 'Choose receiving profile and location' : 'Choose destination location',
                defaultSiteId: transferScope === 'external' ? (draft.externalSiteId || linkedProfiles[0]?.id || '') : currentProfile.id,
                disabled: transferScope === 'external' && !linkedProfiles.length,
                invalid: transferScope === 'external'
                  ? ['externalSiteId', 'externalLocationId'].includes(validation.field)
                  : validation.field === 'toLocationId',
                help: transferScope === 'external'
                  ? 'Receiving profile and selling location that will receive this external transfer.'
                  : 'Destination selling location that will receive the transferred stock.'
              })}
            </div>

            <div class="transfersDivider"></div>

            <div class="transfersField">
              ${renderFieldHelpLabel('Add Item', 'Open the stock picker and choose which items should move between locations.')}
              <button type="button" class="transfersPickerButton" data-transfer-open-stock>
                ${icon('plus')}
                <strong>Open Stock Picker</strong>
              </button>
            </div>

            <label class="transfersField transfersNoteField">
              ${renderFieldHelpLabel('Transfer Note (Optional)', 'Optional note explaining why this transfer is happening or who requested it.')}
              <textarea
                placeholder="E.g. for weekend prep / stock replenishment..."
                data-transfer-note
                data-focus-key="transfer-note"
              >${escapeHtml(draft.note || '')}</textarea>
            </label>
          </div>

          <div class="transfersComposerFooter">
            <button
              type="button"
              class="transfersPrimary"
              data-transfer-save
              ${transfers.actionStatus === 'saving' || !(draft.items || []).length ? 'disabled' : ''}
            >
              ${transfers.actionStatus === 'saving' ? 'Saving Transfer...' : transferScope === 'external' ? 'Send External Transfer' : 'Confirm Transfer'}
            </button>
          </div>
        </section>

        <section class="transfersItemsCard">
          <header class="transfersCardHead">
            <div>
              <p>Transfer Draft</p>
              <h2>Items To Transfer</h2>
            </div>
            <span class="transfersCountPill">${(draft.items || []).length} ${(draft.items || []).length === 1 ? 'Item' : 'Items'}</span>
          </header>

          <div class="transfersItemsScroll" data-scroll-key="transfer-draft-lines">
            ${(draft.items || []).length ? renderDraftLines(draft, transfers.stockItems || [], transferScope, linkedProfiles, localLocations, validation) : '<div class="transfersEmpty">No stock items added yet.</div>'}
          </div>
        </section>
      </div>
      ` : ''}
    </div>

    ${filters.overlay === 'stock' ? renderStockOverlay(stockMatches, filters, selectedStockIds) : ''}
    ${filters.locationPicker ? renderLocationPickerOverlay({
      side: filters.locationPicker,
      transferScope,
      draft,
      currentProfile,
      profiles: filters.locationPicker === 'to' ? toProfiles : [currentProfile],
      selectedSiteId: filters.locationPickerSiteId
    }) : ''}
    ${renderToast(transfers.toast)}
  `;

  bindTransferEvents(view, filters, onTransferFilterChange, onTransferAction);
  bindFieldHelpTooltips(view);
  return view;
}

function renderTransferWorkflowChooser(siteConfig = {}, linkedProfiles = []) {
  const linkedCount = Math.max(Number(siteConfig.linkedSiteCount || 0), linkedProfiles.length);
  return `
    <section class="transfersChoicePanel" aria-label="Choose transfer workflow">
      <header class="transfersChoiceHead">
        <div>
          <p>Transfers</p>
          <h2>Choose Transfer Type</h2>
          <span>Start with a normal transfer, run a bulk transfer in-app, or create reusable stock item templates.</span>
        </div>
      </header>

      <div class="transfersChoiceGrid">
        <button type="button" class="transfersChoiceCard" data-transfer-workflow="normal">
          <span class="transfersChoiceIcon">${icon('shuffle')}</span>
          <strong>Normal Transfer</strong>
          <small>Move stock line by line using the in-app stock picker.</small>
        </button>
        <button type="button" class="transfersChoiceCard" data-transfer-workflow="bulk">
          <span class="transfersChoiceIcon">${icon('upload')}</span>
          <strong>Bulk Transfer</strong>
          <small>Use a saved template, enter quantities, and post the transfer from the tool.</small>
        </button>
        <button type="button" class="transfersChoiceCard" data-transfer-workflow="templates">
          <span class="transfersChoiceIcon">${icon('file')}</span>
          <strong>Transfer Templates</strong>
          <small>Create and manage reusable lists of stock items for bulk transfers.</small>
        </button>
      </div>

      <div class="transfersChoiceMeta">
        <span>${linkedCount} linked ${linkedCount === 1 ? 'profile' : 'profiles'} available for external transfers</span>
      </div>
    </section>
  `;
}

function renderBulkTransferWorkspace(mode = 'bulk', transfers = {}, filters = {}, context = {}) {
  const isTemplateMode = mode === 'templates';
  const templates = transfers.templates || [];
  const selectedTemplate = templates.find((template) => String(template.id) === String(filters.bulkTemplateId || '')) || null;
  return `
    <section class="transfersBulkPanel">
      <header class="transfersChoiceHead">
        <button type="button" class="transfersMiniAction transfersMiniAction--back" data-transfer-workflow="">Back to Transfer Types</button>
        <div>
          <p>${isTemplateMode ? 'Transfer Templates' : 'Bulk Transfers'}</p>
          <h2>${isTemplateMode ? 'Transfer Templates' : 'Bulk Transfer Tools'}</h2>
          <span>${isTemplateMode ? 'Create a reusable stock item list, then export it for bulk transfer work.' : 'Choose a saved template, enter quantities and locations, then post directly from the tool.'}</span>
        </div>
      </header>

      <input type="file" accept=".csv,.xlsx,.xls,text/csv" data-transfer-template-import hidden />

      <div class="transfersBulkGrid">
        ${isTemplateMode ? `
        <article class="transfersBulkCard transfersBulkCard--accent">
          <span class="transfersChoiceIcon">${icon('plus')}</span>
          <h3>Create Template</h3>
          <p>Select stock items once and reuse that list whenever you need a bulk transfer file.</p>
          <button type="button" class="transfersPickerButton" data-transfer-template-builder>
            ${icon('plus')}
            <strong>Create Transfer Template</strong>
          </button>
        </article>
        ` : `
        ${renderBulkTransferTool(templates, selectedTemplate, transfers, filters, context)}
        `}
        <article class="transfersBulkCard">
          <span class="transfersChoiceIcon">${icon('upload')}</span>
          <h3>Upload Completed File</h3>
          <p>The system validates locations, item codes, and available stock before processing.</p>
          <button type="button" class="transfersPickerButton transfersPickerButton--secondary" data-transfer-template-import-trigger>
            ${icon('upload')}
            <strong>Upload Transfer File</strong>
          </button>
        </article>
        ${isTemplateMode ? renderSavedTransferTemplates(templates, filters.openDropdown || '') : `
          <article class="transfersBulkCard">
            <span class="transfersChoiceIcon">${icon('file')}</span>
            <h3>Saved Templates</h3>
            <p>Open the template manager to create stock item lists and export populated files.</p>
            <button type="button" class="transfersPickerButton" data-transfer-workflow="templates">
              ${icon('file')}
              <strong>Manage Templates</strong>
            </button>
          </article>
        `}
      </div>
    </section>
    ${!isTemplateMode && selectedTemplate ? renderBulkTransferDrawer(selectedTemplate, transfers, context) : ''}
  `;
}

function renderBulkTransferTool(templates = [], selectedTemplate = null, transfers = {}, filters = {}, context = {}) {
  return `
    <article class="transfersBulkCard transfersBulkToolCard">
      <span class="transfersChoiceIcon">${icon('shuffle')}</span>
      <h3>Bulk Transfer Process</h3>
      <p>Pick a saved stock list to open a side drawer where you can choose locations and enter quantities.</p>

      <div class="transfersTemplateQuickList" aria-label="Saved transfer templates">
        ${templates.length ? templates.map((template) => `
          <button type="button" class="${selectedTemplate && String(selectedTemplate.id) === String(template.id) ? 'is-active' : ''}" data-transfer-use-template="${escapeAttribute(template.id)}">
            <strong>${escapeHtml(template.name || 'Transfer Template')}</strong>
            <span>${(template.items || []).length} ${(template.items || []).length === 1 ? 'item' : 'items'}</span>
          </button>
        `).join('') : `
          <div class="transfersInlineEmpty">
            <strong>No templates yet</strong>
            <span>Create a transfer template first, then return here to process it in-app.</span>
            <button type="button" class="transfersMiniAction" data-transfer-workflow="templates">Manage Templates</button>
          </div>
        `}
      </div>
    </article>
  `;
}

function renderBulkTransferDrawer(selectedTemplate = {}, transfers = {}, context = {}) {
  const draft = context.draft || createEmptyDraft();
  const validation = transfers.validation || {};
  const canAttemptSave = transfers.actionStatus !== 'saving' && (draft.items || []).length;
  return `
    <div class="transfersBulkDrawerBackdrop" role="presentation">
      <aside class="transfersBulkDrawer" role="dialog" aria-modal="true" aria-label="Bulk transfer template">
        <header class="transfersBulkDrawerHead">
          <div>
            <p>Bulk Transfer</p>
            <h2>${escapeHtml(selectedTemplate.name || 'Transfer Template')}</h2>
            <span>${(draft.items || []).length} ${(draft.items || []).length === 1 ? 'line' : 'lines'} ready for this transfer.</span>
          </div>
          <button type="button" class="transfersIconButton" data-transfer-bulk-template-close aria-label="Close bulk transfer drawer">${icon('x')}</button>
        </header>

        <div class="transfersBulkDrawerBody">
          ${transfers.actionError ? renderNotice(transfers.actionError, 'error', 'transfersNotice--drawer') : ''}

          <div class="transfersBulkRouteGrid">
            ${renderLocationSelectCard({
              side: 'from',
              title: 'From',
              profileName: context.currentProfile?.name || '',
              locationName: draft.fromLocationName || getProfileLocationName(context.currentProfile, draft.fromLocationId) || '',
              emptyLabel: 'Choose source location',
              defaultSiteId: context.currentProfile?.id || '',
              help: 'Source selling location that stock will be deducted from during this bulk transfer.',
              invalid: validation.field === 'fromLocationId'
            })}
            ${renderLocationSelectCard({
              side: 'to',
              title: 'To',
              profileName: context.currentProfile?.name || '',
              locationName: draft.toLocationName || getProfileLocationName(context.currentProfile, draft.toLocationId) || '',
              emptyLabel: 'Choose destination location',
              defaultSiteId: context.currentProfile?.id || '',
              help: 'Destination selling location that will receive the transferred stock.',
              invalid: validation.field === 'toLocationId'
            })}
          </div>

          <div class="transfersBulkLinePanel">
            ${(draft.items || []).length
              ? renderDraftLines(draft, transfers.stockItems || [], 'internal', context.linkedProfiles || [], context.localLocations || [], validation)
              : '<div class="transfersEmpty">This template has no active stock items.</div>'}
          </div>
        </div>

        <footer class="transfersBulkDrawerFooter">
          <button type="button" class="transfersGhost" data-transfer-bulk-template-close>Cancel</button>
          <button type="button" class="transfersPrimary" data-transfer-save ${canAttemptSave ? '' : 'disabled'}>
            ${transfers.actionStatus === 'saving' ? 'Posting Bulk Transfer...' : 'Post Bulk Transfer'}
          </button>
        </footer>
      </aside>
    </div>
  `;
}

function renderSavedTransferTemplates(templates = [], openDropdown = '') {
  return `
    <article class="transfersBulkCard transfersTemplateListCard">
      <span class="transfersChoiceIcon">${icon('file')}</span>
      <h3>Saved Templates</h3>
      <div class="transfersTemplateList">
        ${templates.length ? templates.map((template) => `
          <div class="transfersTemplateRow">
            <div>
              <strong>${escapeHtml(template.name || 'Transfer Template')}</strong>
              <small>${(template.items || []).length} ${(template.items || []).length === 1 ? 'item' : 'items'}</small>
            </div>
            <div class="transfersTemplateActions" data-transfer-dropdown-root>
              <button type="button" class="transfersMiniAction" data-transfer-dropdown="template-actions-${escapeAttribute(template.id)}">
                Actions ${icon('chevronDown')}
              </button>
              <div class="transfersTemplateActionMenu ${openDropdown === `template-actions-${String(template.id)}` ? 'is-open' : ''}">
                <button type="button" data-transfer-template-download="xlsx" data-transfer-template-id="${escapeAttribute(template.id)}">Download Excel</button>
                <button type="button" data-transfer-template-builder="${escapeAttribute(template.id)}">Edit Template</button>
                <button type="button" class="is-danger" data-transfer-template-delete="${escapeAttribute(template.id)}">Delete Template</button>
              </div>
            </div>
          </div>
        `).join('') : '<p>No transfer templates created yet.</p>'}
      </div>
    </article>
  `;
}

function renderTransferTemplateBuilder(transfers = {}, filters = {}) {
  const draft = transfers.templateDraft || createEmptyTransferTemplateDraft();
  const query = String(filters.templateSearch || '').trim().toLowerCase();
  const selectedIds = new Set((draft.selectedStockIds || []).map(String));
  const stockItems = (transfers.stockItems || [])
    .filter(isTransferEligibleStockItem)
    .filter((item) => {
      if (!query) return true;
      return getTransferSearchCandidates(item).some((value) => String(value || '').toLowerCase().includes(query));
    });

  return `
    <section class="transfersTemplateBuilder">
      <header class="transfersChoiceHead">
        <div class="transfersHeaderActions">
          <button type="button" class="transfersMiniAction transfersMiniAction--back" data-transfer-workflow="templates">Back to Templates</button>
          <button type="button" class="transfersMiniAction transfersMiniAction--back" data-transfer-workflow="">Transfer Home</button>
        </div>
        <div>
          <p>Transfer Template</p>
          <h2>${draft.id ? 'Edit Template' : 'Create Template'}</h2>
          <span>Select the stock items that should appear in this reusable bulk transfer file.</span>
        </div>
      </header>

      <div class="transfersTemplateBuilderGrid">
        <section class="transfersTemplateSettings">
          <label class="transfersField">
            ${renderFieldHelpLabel('Template Name', 'Name shown in the transfer template manager.')}
            <input type="text" value="${escapeAttribute(draft.name || '')}" placeholder="E.g. Weekly bar replenishment" data-transfer-template-field="name" data-focus-key="transfer-template-name" />
          </label>
          <label class="transfersField">
            ${renderFieldHelpLabel('Notes', 'Optional internal note for this transfer template.')}
            <textarea placeholder="Optional note..." data-transfer-template-field="notes" data-focus-key="transfer-template-notes">${escapeHtml(draft.notes || '')}</textarea>
          </label>
          <div class="transfersTemplateSummary">
            <strong>${selectedIds.size}</strong>
            <span>selected stock items</span>
          </div>
          <button type="button" class="transfersPrimary" data-transfer-template-save ${String(draft.name || '').trim() && selectedIds.size ? '' : 'disabled'}>
            ${transfers.actionStatus === 'saving-template' ? 'Saving...' : 'Save Transfer Template'}
          </button>
        </section>

        <section class="transfersTemplatePicker">
          <div class="transfersTemplatePickerHead">
            <label class="transfersField">
              ${renderFieldHelpLabel('Stock Items', 'Search and select the stock items to include in this template.')}
              <div class="transfersSearchShell">
                <input type="search" value="${escapeAttribute(filters.templateSearch || '')}" placeholder="Search stock items or barcode..." data-transfer-template-search data-focus-key="transfer-template-search" />
                <button type="button" class="transfersSearchCamera" data-transfer-template-camera aria-label="Scan barcode for transfer template search">${icon('camera')}</button>
              </div>
            </label>
            <div class="transfersBulkActions">
              <button type="button" class="transfersMiniAction" data-transfer-template-select-all>Select All Shown</button>
              <button type="button" class="transfersMiniAction" data-transfer-template-clear>Clear</button>
            </div>
          </div>
          <div class="transfersTemplateStockList" data-scroll-key="transfer-template-stock-list">
            ${stockItems.length ? stockItems.map((item) => `
              <label class="transfersTemplateStockRow ${selectedIds.has(String(item.id)) ? 'is-selected' : ''}">
                <input type="checkbox" data-transfer-template-stock="${escapeAttribute(item.id)}" ${selectedIds.has(String(item.id)) ? 'checked' : ''} />
                <div>
                  <strong>${escapeHtml(item.name || '')}</strong>
                  <span>${escapeHtml(item.category || 'Uncategorised')} · ${escapeHtml(item.unit || 'ea')}</span>
                </div>
                <em>${escapeHtml(item.sku || item.SKU || item.code || item.id || '')}</em>
              </label>
            `).join('') : '<div class="transfersEmpty">No stock items match.</div>'}
          </div>
        </section>
      </div>
    </section>
  `;
}

function bindTransferEvents(view, filters, onTransferFilterChange, onTransferAction) {
  view.querySelectorAll('[data-transfer-workflow]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextWorkflow = button.dataset.transferWorkflow || '';
      onTransferFilterChange?.({
        transferWorkflow: nextWorkflow,
        bulkTemplateId: nextWorkflow === 'bulk' ? (filters.bulkTemplateId || '') : '',
        overlay: '',
        openDropdown: '',
        selectedStockIds: []
      });
    });
  });

  view.querySelectorAll('[data-transfer-template-builder]').forEach((button) => {
    button.addEventListener('click', () => onTransferAction.onOpenTemplateBuilder?.(button.dataset.transferTemplateBuilder || ''));
  });

  view.querySelectorAll('[data-transfer-use-template]').forEach((button) => {
    button.addEventListener('click', () => onTransferAction.onUseTemplate?.(button.dataset.transferUseTemplate || ''));
  });

  view.querySelectorAll('[data-transfer-bulk-template-close]').forEach((button) => {
    button.addEventListener('click', () => onTransferFilterChange?.({ bulkTemplateId: '', openDropdown: '', overlay: '' }));
  });

  view.querySelectorAll('[data-transfer-template-delete]').forEach((button) => {
    button.addEventListener('click', () => onTransferAction.onDeleteTemplate?.(button.dataset.transferTemplateDelete || ''));
  });

  view.querySelectorAll('[data-transfer-template-field]').forEach((field) => {
    field.addEventListener('input', () => {
      onTransferAction.onPreserveFocus?.(field);
      onTransferAction.onUpdateTemplateDraft?.({ [field.dataset.transferTemplateField]: field.value });
    });
  });

  view.querySelector('[data-transfer-template-search]')?.addEventListener('input', (event) => {
    onTransferFilterChange?.({ templateSearch: event.currentTarget.value });
  });

  view.querySelector('[data-transfer-template-camera]')?.addEventListener('click', () => {
    onTransferAction.onScanStockSearch?.('template');
  });

  view.querySelectorAll('[data-transfer-template-stock]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => onTransferAction.onToggleTemplateStock?.(checkbox.dataset.transferTemplateStock || '', checkbox.checked));
  });

  view.querySelector('[data-transfer-template-select-all]')?.addEventListener('click', () => onTransferAction.onSelectAllTemplateStock?.());
  view.querySelector('[data-transfer-template-clear]')?.addEventListener('click', () => onTransferAction.onClearTemplateStock?.());
  view.querySelector('[data-transfer-template-save]')?.addEventListener('click', () => onTransferAction.onSaveTemplate?.());

  view.querySelector('[data-transfer-open-stock]')?.addEventListener('click', () => {
    onTransferFilterChange?.({ overlay: 'stock', selectedStockIds: [], openDropdown: '' });
  });

  view.querySelector('[data-transfer-stock-close]')?.addEventListener('click', () => {
    onTransferFilterChange?.({ overlay: '', selectedStockIds: [], openDropdown: '' });
  });

  view.querySelectorAll('[data-transfer-template-download]').forEach((button) => {
    button.addEventListener('click', () => onTransferAction.onExportTemplate?.(button.dataset.transferTemplateDownload || 'csv', button.dataset.transferTemplateId || ''));
  });

  const importInput = view.querySelector('[data-transfer-template-import]');
  view.querySelector('[data-transfer-template-import-trigger]')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file) onTransferAction.onImportTemplate?.(file);
    importInput.value = '';
  });

  view.querySelectorAll('[data-transfer-location-picker]').forEach((button) => {
    button.addEventListener('click', () => {
      onTransferFilterChange?.({
        locationPicker: button.dataset.transferLocationPicker || '',
        locationPickerSiteId: button.dataset.transferPickerDefaultSite || '',
        openDropdown: ''
      });
    });
  });

  view.querySelectorAll('[data-transfer-location-picker-close]').forEach((button) => {
    button.addEventListener('click', () => {
      onTransferFilterChange?.({ locationPicker: '', locationPickerSiteId: '' });
    });
  });

  // Only the site-rail buttons switch the active profile. Location buttons ALSO carry
  // data-transfer-picker-site (to record which profile the location belongs to), so we
  // must exclude them here — otherwise clicking a location re-renders mid-click and the
  // location selection below is lost.
  view.querySelectorAll('[data-transfer-picker-site]:not([data-transfer-picker-location])').forEach((button) => {
    button.addEventListener('click', () => {
      onTransferFilterChange?.({ locationPickerSiteId: button.dataset.transferPickerSite || '' });
    });
  });

  view.querySelectorAll('[data-transfer-picker-location]').forEach((button) => {
    button.addEventListener('click', () => {
      const side = button.dataset.transferPickerSide || 'from';
      const locationId = button.dataset.transferPickerLocation || '';
      if (side === 'from') {
        onTransferAction.onDraftLocationChange?.('from', locationId);
      } else if ((filters.transferScope || 'internal') === 'external') {
        onTransferAction.onDraftChange?.({
          externalSiteId: button.dataset.transferPickerSite || '',
          externalSiteName: button.dataset.transferPickerSiteName || '',
          externalLocationId: locationId,
          externalLocationName: button.dataset.transferPickerLocationName || ''
        });
      } else {
        onTransferAction.onDraftLocationChange?.('to', locationId);
      }
      onTransferFilterChange?.({ locationPicker: '', locationPickerSiteId: '' });
    });
  });

  view.querySelector('[data-transfer-stock-search]')?.addEventListener('input', (event) => {
    onTransferFilterChange?.({ stockSearch: event.target.value });
  });

  view.querySelector('[data-transfer-stock-camera]')?.addEventListener('click', () => {
    onTransferAction.onScanStockSearch?.('stock');
  });

  view.querySelector('[data-transfer-note]')?.addEventListener('input', (event) => {
    onTransferAction.onPreserveFocus?.(event.currentTarget);
    onTransferAction.onDraftChange?.({ note: event.currentTarget.value });
  });

  view.querySelectorAll('[data-transfer-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      onTransferFilterChange?.({ transferScope: button.dataset.transferScope || 'internal', openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-transfer-external-field]').forEach((field) => {
    field.addEventListener('input', () => {
      onTransferAction.onPreserveFocus?.(field);
      onTransferAction.onDraftChange?.({ [field.dataset.transferExternalField]: field.value });
    });
  });

  view.querySelectorAll('[data-transfer-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.transferDropdown;
      const current = view.dataset.openDropdown || '';
      onTransferFilterChange?.({ openDropdown: current === id ? '' : id });
    });
  });

  view.addEventListener('click', (event) => {
    if (!view.dataset.openDropdown || event.target.closest('[data-transfer-dropdown-root]')) return;
    onTransferFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-transfer-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.transferOptionAction || '';
      const value = button.dataset.transferOptionValue || '';
      if (action === 'stockCategory') {
        onTransferFilterChange?.({ stockCategory: value, openDropdown: '' });
        return;
      }
      if (action === 'draft:fromSiteId') {
        onTransferAction.onDraftChange?.({ fromSiteId: value });
      } else if (action === 'draft:toSiteId') {
        onTransferAction.onDraftChange?.({ toSiteId: value });
      } else if (action === 'draft:fromLocationId' || action === 'draft:toLocationId') {
        onTransferAction.onDraftLocationChange?.(action === 'draft:fromLocationId' ? 'from' : 'to', value);
      } else if (action === 'draft:externalSiteId') {
        onTransferAction.onDraftChange?.({ externalSiteId: value });
      } else if (action === 'draft:externalLocationId') {
        onTransferAction.onDraftChange?.({ externalLocationId: value });
      }
      onTransferFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-transfer-stock-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onTransferAction.onToggleStockSelection?.(checkbox.dataset.transferStockSelect, checkbox.checked);
    });
  });

  view.querySelector('[data-transfer-stock-select-all]')?.addEventListener('click', () => onTransferAction.onSelectAllVisibleStock?.());
  view.querySelector('[data-transfer-stock-add]')?.addEventListener('click', () => onTransferAction.onAddSelectedStock?.());
  view.querySelector('[data-transfer-stock-clear]')?.addEventListener('click', () => {
    onTransferFilterChange?.({ selectedStockIds: [] });
  });

  view.querySelectorAll('[data-transfer-line-qty]').forEach((field) => {
    field.addEventListener('input', () => {
      onTransferAction.onPreserveFocus?.(field);
      // renderApp() is suppressed while a text field is focused, so update the live
      // "after" values directly here — otherwise they never change while typing.
      const line = field.closest('[data-transfer-line]');
      if (line) {
        const sourceQty = Number(line.dataset.sourceQty || 0) || 0;
        const destQty = Number(line.dataset.destQty || 0) || 0;
        const unit = line.dataset.lineUnit || '';
        const qty = Math.max(parseTransferQuantity(field.value), 0);
        const sourceAfter = sourceQty - qty;
        const destAfter = destQty + qty;
        const sourceEl = line.querySelector('[data-source-after]');
        const destEl = line.querySelector('[data-dest-after]');
        if (sourceEl) sourceEl.textContent = `${formatNumber(sourceAfter)} ${unit}`;
        if (destEl) destEl.textContent = `${formatNumber(destAfter)} ${unit}`;
        const negative = sourceAfter < 0;
        line.classList.toggle('transfersDraftLine--danger', negative);
        line.querySelector('[data-source-metric]')?.classList.toggle('transfersDraftMetric--danger', negative);
        const insufficient = line.querySelector('[data-source-insufficient]');
        if (insufficient) insufficient.hidden = !negative;
      }
      onTransferAction.onLineChange?.(Number(field.dataset.transferLineQty), field.value);
    });
  });

  view.querySelectorAll('[data-transfer-remove-line]').forEach((button) => {
    button.addEventListener('click', () => onTransferAction.onRemoveLine?.(Number(button.dataset.transferRemoveLine)));
  });

  view.querySelector('[data-transfer-save]')?.addEventListener('click', () => onTransferAction.onSave?.());
  view.querySelector('[data-transfer-toast-close]')?.addEventListener('click', () => onTransferAction.onDismissToast?.());
  view.querySelectorAll('[data-external-receive-qty]').forEach((field) => {
    field.addEventListener('input', () => {
      onTransferAction.onPreserveFocus?.(field);
      onTransferAction.onReceiveQtyChange?.(
        field.dataset.externalTransferId,
        field.dataset.externalStockItemId,
        field.value
      );
    });
  });
  view.querySelectorAll('[data-external-transfer-accept]').forEach((button) => {
    button.addEventListener('click', () => onTransferAction.onAcceptExternalTransfer?.(button.dataset.externalTransferAccept));
  });
  view.querySelectorAll('[data-external-transfer-reject]').forEach((button) => {
    button.addEventListener('click', () => onTransferAction.onRejectExternalTransfer?.(button.dataset.externalTransferReject, button.dataset.externalTransferAction || 'reject'));
  });
  // Per-line Reject/Undo: reject sets received qty to 0 (full line returns to sender on accept);
  // undo restores the shipped qty.
  view.querySelectorAll('[data-external-line-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const restore = button.dataset.externalLineToggle === 'restore';
      onTransferAction.onReceiveQtyChange?.(
        button.dataset.externalTransferId,
        button.dataset.externalStockItemId,
        restore ? String(button.dataset.externalShippedQty ?? '') : '0'
      );
    });
  });
}

function renderTransferModePanel({ transferScope, siteConfig }) {
  const externalReady = siteConfig.showExternalTransfer === true;
  const locationCount = Number(siteConfig.locationCount || 0);
  return `
    <section class="transfersModePanel" aria-label="Transfer type">
      <div class="transfersModeGrid">
        <button type="button" class="transfersModeCard ${transferScope === 'internal' ? 'is-active' : ''}" data-transfer-scope="internal">
          <span>${icon('shuffle')}</span>
          <strong>Internal Transfer</strong>
          <small>${locationCount > 1 ? 'Move stock between selling locations in this profile.' : 'Add another location to transfer internally.'}</small>
        </button>
        <button type="button" class="transfersModeCard ${transferScope === 'external' ? 'is-active' : ''}" data-transfer-scope="external" ${externalReady ? '' : 'disabled'}>
          <span>${icon('network')}</span>
          <strong>External Transfer</strong>
          <small>${externalReady ? `${siteConfig.linkedSiteCount || 0} linked profile${Number(siteConfig.linkedSiteCount || 0) === 1 ? '' : 's'} available.` : 'Requires Org or Corp linking from Admin Portal.'}</small>
        </button>
      </div>
      <div class="transfersLinkStatus ${externalReady ? 'transfersLinkStatus--ready' : ''}">
        <strong>${externalReady ? 'Org/Corp link active' : 'Standalone profile'}</strong>
        <span>${externalReady ? 'External transfer validation will enforce shared Org ID or Corp ID and Transfer Agent role.' : 'This workspace currently transfers only between its own selling locations.'}</span>
      </div>
    </section>
  `;
}

function renderPendingExternalTransfers(transfers = [], receiveDrafts = {}, actionStatus = '') {
  if (!transfers.length) return '';
  return `
    <section class="transfersPendingPanel" aria-label="Pending external transfers">
      <div class="transfersPendingHead">
        <div>
          <p>Pending Action</p>
          <h3>${transfers.length} external transfer${transfers.length === 1 ? '' : 's'} awaiting receipt</h3>
        </div>
        <span>Count items, then accept into on-hand stock.</span>
      </div>
      <div class="transfersPendingList">
        ${transfers.map((transfer) => renderPendingExternalTransferCard(transfer, receiveDrafts[transfer.transferId || transfer.id] || {}, actionStatus)).join('')}
      </div>
    </section>
  `;
}

function renderPendingExternalTransferCard(transfer, draft = {}, actionStatus = '') {
  const transferId = transfer.transferId || transfer.id;
  const isAccepting = actionStatus === `accepting:${transferId}`;
  const isRejecting = actionStatus === `rejecting:${transferId}` || actionStatus === `cancelling:${transferId}`;
  const isOutbound = String(transfer.direction || '') === 'outbound';
  const busy = isAccepting || isRejecting;
  return `
    <article class="transfersPendingCard">
      <header>
        <div>
          <strong>${escapeHtml(transfer.fromSiteName || 'Sending site')}</strong>
          <span>${escapeHtml(transfer.fromLocationName || 'Source')} ${icon('arrowRight')} ${escapeHtml(transfer.toLocationName || 'Receiving location')}</span>
        </div>
        <div class="transfersPendingActions">
          ${isOutbound ? '' : `
          <button type="button" class="transfersPrimary transfersPendingAccept" data-external-transfer-accept="${escapeAttribute(transferId)}" ${busy ? 'disabled' : ''}>
            ${isAccepting ? 'Accepting...' : 'Accept Transfer'}
          </button>`}
          <button type="button" class="transfersGhost transfersPendingReject" data-external-transfer-reject="${escapeAttribute(transferId)}" data-external-transfer-action="${isOutbound ? 'cancel' : 'reject'}" ${busy ? 'disabled' : ''}>
            ${isRejecting ? (isOutbound ? 'Cancelling...' : 'Rejecting...') : (isOutbound ? 'Cancel Request' : 'Reject')}
          </button>
        </div>
      </header>
      <div class="transfersPendingRows">
        ${(transfer.items || []).map((item) => {
          const value = draft[item.stockItemId] ?? item.shippedQty ?? '';
          // A line is "rejected" when its received qty is explicitly set to 0 — the full shipped
          // quantity then returns to the sender when the transfer is accepted.
          const hasDraft = draft[item.stockItemId] !== undefined && draft[item.stockItemId] !== '';
          const rejected = hasDraft && Number(draft[item.stockItemId]) === 0;
          const shippedQty = item.shippedQty || 0;
          return `
            <label class="transfersPendingRow ${rejected ? 'is-rejected' : ''}">
              <span>
                <strong>${escapeHtml(item.name || item.stockItemId)}</strong>
                <small>Sent ${formatNumber(shippedQty)} ${escapeHtml(String(item.unit || '').toLowerCase())}${rejected ? ' · returns to sender' : ''}</small>
              </span>
              <input
                type="text"
                inputmode="decimal"
                value="${escapeAttribute(value)}"
                ${rejected || busy ? 'disabled' : ''}
                data-external-receive-qty
                data-external-transfer-id="${escapeAttribute(transferId)}"
                data-external-stock-item-id="${escapeAttribute(item.stockItemId)}"
                data-focus-key="external-receive-${escapeAttribute(transferId)}-${escapeAttribute(item.stockItemId)}"
              />
              <em>${escapeHtml(String(item.unit || '').toUpperCase())}</em>
              ${isOutbound ? '' : `
              <button
                type="button"
                class="transfersLineReject ${rejected ? 'is-active' : ''}"
                data-external-line-toggle="${rejected ? 'restore' : 'reject'}"
                data-external-transfer-id="${escapeAttribute(transferId)}"
                data-external-stock-item-id="${escapeAttribute(item.stockItemId)}"
                data-external-shipped-qty="${escapeAttribute(shippedQty)}"
                ${busy ? 'disabled' : ''}
              >${rejected ? 'Undo' : 'Reject'}</button>`}
            </label>
          `;
        }).join('')}
      </div>
    </article>
  `;
}

function renderLocationSelectCard({ side, title, profileName, locationName, emptyLabel, defaultSiteId, disabled = false, help, invalid = false }) {
  return `
    <div class="transfersField">
      ${renderFieldHelpLabel(`${title} Location`, help)}
      <button
        type="button"
        class="transfersLocationSelect ${invalid ? 'is-required' : ''}"
        data-transfer-location-picker="${escapeAttribute(side)}"
        data-transfer-picker-default-site="${escapeAttribute(defaultSiteId || '')}"
        ${invalid ? 'aria-invalid="true"' : ''}
        ${disabled ? 'disabled' : ''}
      >
        <span class="transfersLocationSelectIcon">${icon(side === 'from' ? 'store' : 'mapPin')}</span>
        <span class="transfersLocationSelectText">
          <strong>${escapeHtml(locationName || emptyLabel)}</strong>
          <small>${escapeHtml(profileName || 'Select site profile')}</small>
        </span>
        ${icon('chevronDown')}
      </button>
    </div>
  `;
}

function renderExternalTransferHint({ siteConfig, linkedProfiles }) {
  return `
    <section class="transfersExternalPanel">
      <div class="transfersExternalHead">
        <strong>Receiving Profile</strong>
        <span>${siteConfig.orgId ? `Org ${escapeHtml(siteConfig.orgId)}` : siteConfig.corpId ? `Corp ${escapeHtml(siteConfig.corpId)}` : 'No link id'}</span>
      </div>
      ${linkedProfiles.length ? `
        <div class="transfersExternalEmpty transfersExternalEmpty--ready">
          Choose the receiving profile and selling location from the To Location modal.
        </div>
      ` : `
        <div class="transfersExternalEmpty">
          Linked profiles are active, but no receiving profiles were returned yet. Refresh the Org links in the admin portal, then reload Transfers.
        </div>
      `}
    </section>
  `;
}

function renderLocationPickerOverlay({ side, transferScope, draft, currentProfile, profiles, selectedSiteId }) {
  const cleanProfiles = profiles.length ? profiles : [currentProfile];
  const fallbackSiteId = side === 'to' && transferScope === 'external'
    ? (draft.externalSiteId || cleanProfiles[0]?.id || '')
    : (currentProfile.id || cleanProfiles[0]?.id || '');
  const activeSiteId = selectedSiteId || fallbackSiteId;
  const activeProfile = cleanProfiles.find((profile) => String(profile.id) === String(activeSiteId)) || cleanProfiles[0] || currentProfile;
  const selectedLocationId = side === 'from'
    ? draft.fromLocationId
    : transferScope === 'external' ? draft.externalLocationId : draft.toLocationId;
  const title = side === 'from' ? 'Choose From Location' : 'Choose To Location';
  const helper = side === 'from'
    ? 'The selected selling location will lose stock when the transfer is posted.'
    : 'The selected selling location will receive stock when the transfer is posted.';

  return `
    <div class="transfersOverlayBackdrop">
      <section class="transfersLocationModal" role="dialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
        <header class="transfersOverlayHead">
          <div>
            <p>${side === 'from' ? 'Source' : 'Destination'}</p>
            <h3>${escapeHtml(title)}</h3>
          </div>
          <button type="button" class="transfersIconButton" data-transfer-location-picker-close aria-label="Close location picker">${icon('x')}</button>
        </header>

        <p class="transfersLocationModalHelp">${escapeHtml(helper)}</p>

        <div class="transfersLocationModalGrid">
          <aside class="transfersSiteRail">
            <span>Site/Profile</span>
            ${cleanProfiles.map((profile) => `
              <button
                type="button"
                class="${String(profile.id) === String(activeProfile.id) ? 'is-active' : ''}"
                data-transfer-picker-site="${escapeAttribute(profile.id)}"
              >
                <strong>${escapeHtml(profile.name || profile.id)}</strong>
                <small>${(profile.locations || []).length} selling location${(profile.locations || []).length === 1 ? '' : 's'}</small>
              </button>
            `).join('')}
          </aside>

          <div class="transfersLocationList">
            <div class="transfersLocationListHead">
              <span>Selling Locations</span>
              <strong>${escapeHtml(activeProfile?.name || 'Current Profile')}</strong>
            </div>
            ${(activeProfile?.locations || []).length ? activeProfile.locations.map((location) => `
              <button
                type="button"
                class="${String(location.id) === String(selectedLocationId) ? 'is-active' : ''}"
                data-transfer-picker-location="${escapeAttribute(location.id)}"
                data-transfer-picker-location-name="${escapeAttribute(location.name)}"
                data-transfer-picker-site="${escapeAttribute(activeProfile.id)}"
                data-transfer-picker-site-name="${escapeAttribute(activeProfile.name)}"
                data-transfer-picker-side="${escapeAttribute(side)}"
              >
                <span>${icon('mapPin')}</span>
                <strong>${escapeHtml(location.name)}</strong>
                <small>${String(location.id) === String(selectedLocationId) ? 'Selected' : 'Select'}</small>
              </button>
            `).join('') : '<div class="transfersEmpty transfersLocationEmpty">No selling locations found for this profile.</div>'}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderDraftLines(draft, stockItems, transferScope = 'internal', linkedProfiles = [], localLocations = [], validation = {}) {
  return `
    <div class="transfersDraftList">
      ${(draft.items || []).map((item, index) => {
        const stockItem = (stockItems || []).find((entry) => String(entry.id) === String(item.stockItemId)) || null;
        const sourceQty = getLocationStock(stockItem, draft.fromLocationId, localLocations);
        const isExternal = transferScope === 'external';
        const externalProfile = isExternal
          ? ((linkedProfiles || []).find((profile) => String(profile.id) === String(draft.externalSiteId)) ||
             ((linkedProfiles || []).length === 1 ? (linkedProfiles || [])[0] : null))
          : null;
        const destinationStockItem = isExternal ? findMatchingStockItem(externalProfile?.stockItems || [], item, stockItem) : stockItem;
        const destinationQty = isExternal
          ? getLocationStock(destinationStockItem, draft.externalLocationId, externalProfile?.locations || [])
          : getLocationStock(stockItem, draft.toLocationId, localLocations);
        const transferQty = Math.max(parseTransferQuantity(item.quantity), 0);
        const sourceAfter = sourceQty - transferQty;
        const destinationAfter = destinationQty + transferQty;
        const sourceIsNegative = sourceAfter < 0;
        const destinationLabel = isExternal ? (draft.externalLocationName || 'Receiving location') : (draft.toLocationName || 'Destination');
        const quantityRequired = validation.field === `lineQty:${index}`;
        const unitLower = escapeHtml(String(item.unit || 'ea').toLowerCase());
        return `
        <article class="transfersDraftLine ${sourceIsNegative ? 'transfersDraftLine--danger' : ''} ${quantityRequired ? 'transfersDraftLine--required' : ''}"
          data-transfer-line="${index}"
          data-source-qty="${sourceQty}"
          data-dest-qty="${destinationQty}"
          data-line-unit="${unitLower}">
          <div class="transfersDraftMeta">
            <strong>${escapeHtml(item.stockItemName || '')}</strong>
            <span>${escapeHtml(item.category || 'Uncategorised')}</span>
          </div>

          <div class="transfersDraftFlow">
            <div class="transfersDraftMetrics">
              <div class="transfersDraftMetric ${sourceIsNegative ? 'transfersDraftMetric--danger' : ''}" data-source-metric ${sourceIsNegative ? 'aria-label="Source stock will go negative"' : ''}>
                <label>${escapeHtml(draft.fromLocationName || 'Source')} after</label>
                <strong data-source-after>${formatNumber(sourceAfter)} ${unitLower}</strong>
                <small data-source-insufficient ${sourceIsNegative ? '' : 'hidden'}>Insufficient stock</small>
              </div>
              <span class="transfersDraftFlowDivider" aria-hidden="true"></span>
              <div class="transfersDraftMetric">
                <label>${escapeHtml(destinationLabel)} after</label>
                <strong data-dest-after>${formatNumber(destinationAfter)} ${unitLower}</strong>
              </div>
            </div>

            <span class="transfersDraftFlowLine" aria-hidden="true"></span>

            <label class="transfersQtyField">
              ${renderFieldHelpLabel('Transfer Qty', 'Quantity to move out of the source location and into the destination location.')}
              <div class="transfersQtyShell ${quantityRequired ? 'is-required' : ''}">
                <input
                  type="text"
                  inputmode="decimal"
                  value="${escapeAttribute(String(item.quantity ?? ''))}"
                  data-transfer-line-qty="${index}"
                  data-focus-key="transfer-qty-${index}"
                  ${quantityRequired ? 'aria-invalid="true"' : ''}
                />
                <em>${escapeHtml(String(item.unit || 'ea').toUpperCase())}</em>
              </div>
            </label>

            <button type="button" class="transfersIconButton" data-transfer-remove-line="${index}" aria-label="Remove line">
              ${icon('x')}
            </button>
          </div>
        </article>
      `;
      }).join('')}
    </div>
  `;
}

function renderStockOverlay(stockItems, filters, selectedStockIds) {
  const categoryOptions = [
    { value: '', label: 'All categories' },
    ...getCategoryOptions(stockItems).map((category) => ({ value: category, label: category }))
  ];

  return `
    <div class="transfersOverlayBackdrop">
      <section class="transfersOverlayCard">
        <header class="transfersOverlayHead">
          <div>
            <p>Add Stock Items</p>
            <h3>Select items to transfer</h3>
          </div>
          <button type="button" class="transfersIconButton" data-transfer-stock-close aria-label="Close stock picker">${icon('x')}</button>
        </header>

        <div class="transfersOverlayFilters">
          <label class="transfersField">
            ${renderFieldHelpLabel('Search', 'Search stock items available to add into this transfer.')}
            <div class="transfersSearchShell">
              <input type="search" value="${escapeAttribute(filters.stockSearch || '')}" placeholder="Type name or scan barcode..." data-transfer-stock-search data-focus-key="transfer-stock-search" />
              <button type="button" class="transfersSearchCamera" data-transfer-stock-camera aria-label="Scan barcode for transfer search">${icon('camera')}</button>
            </div>
          </label>
          <label class="transfersField">
            ${renderFieldHelpLabel('Category', 'Filter transferable stock items by category.')}
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

        <div class="transfersPickerList" data-scroll-key="transfer-stock-picker">
          ${stockItems.map((item) => `
            <label class="transfersPickerRow ${item.alreadyAdded ? 'is-added' : ''}">
              <input type="checkbox" data-transfer-stock-select="${escapeAttribute(item.id)}" ${selectedStockIds.has(String(item.id)) ? 'checked' : ''} />
              <div>
                <strong>${escapeHtml(item.name || '')}</strong>
                <span>${escapeHtml(item.category || 'Uncategorised')}</span>
              </div>
              <em>${escapeHtml(String(item.unit || 'ea').toUpperCase())}</em>
            </label>
          `).join('') || '<div class="transfersEmpty">No stock items match.</div>'}
        </div>

        <footer class="transfersOverlayFooter">
          <span class="transfersOverlayCount">${selectedStockIds.size} selected</span>
          <div class="transfersOverlayActions">
            <button type="button" class="transfersGhost" data-transfer-stock-select-all ${stockItems.length ? '' : 'disabled'}>Select All Shown</button>
            <button type="button" class="transfersGhost" data-transfer-stock-clear ${selectedStockIds.size ? '' : 'disabled'}>Clear</button>
            <button type="button" class="transfersPrimary" data-transfer-stock-add ${selectedStockIds.size ? '' : 'disabled'}>Confirm</button>
          </div>
        </footer>
      </section>
    </div>
  `;
}

function renderOverlayDropdown({ id, action, selectedValue, fallbackLabel, options, openDropdown }) {
  const selected = options.find((option) => String(option.value) === String(selectedValue));
  const isOpen = openDropdown === id;
  return `
    <div class="transfersDropdown ${isOpen ? 'transfersDropdown--open' : ''}" data-transfer-dropdown-root>
      <button type="button" data-transfer-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(selected?.label || fallbackLabel)}</strong>
        ${icon('chevronDown')}
      </button>
      <div class="transfersDropdownMenu">
        ${options.length ? options.map((option) => `
          <button
            type="button"
            data-transfer-option
            data-transfer-option-action="${escapeAttribute(action)}"
            data-transfer-option-value="${escapeAttribute(option.value)}"
            class="${String(option.value) === String(selectedValue) ? 'is-active' : ''}"
          >
            ${escapeHtml(option.label)}
          </button>
        `).join('') : '<span class="transfersDropdownEmpty">No options available</span>'}
      </div>
    </div>
  `;
}

function renderNotice(message, tone, extraClass = '') {
  return `<div class="transfersNotice transfersNotice--${tone} ${escapeAttribute(extraClass)}" role="alert">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="transfersToast transfersToast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-transfer-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function getStockMatches(stockItems = [], query = '', category = '', currentLines = []) {
  const q = String(query || '').trim().toLowerCase();
  const currentKeys = new Set((currentLines || []).map((line) => String(line.stockItemId || '')));
  return stockItems
    .filter(isTransferEligibleStockItem)
    .filter((item) => {
      if (category && String(item.category || '') !== category) return false;
      if (!q) return true;
      return (
        String(item.name || '').toLowerCase().includes(q)
        || String(item.category || '').toLowerCase().includes(q)
        || getTransferSearchCandidates(item).some((value) => String(value || '').toLowerCase().includes(q))
      );
    })
    .map((item) => ({ ...item, alreadyAdded: currentKeys.has(String(item.id)) }));
}

function getCategoryOptions(stockItems = []) {
  return [...new Set(stockItems.filter(isTransferEligibleStockItem).map((item) => String(item.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function getTransferSearchCandidates(item = {}) {
  return [
    item.id,
    item.name,
    item.category,
    item.sku,
    item.SKU,
    item.code,
    item.itemCode,
    item.stockCode,
    item.barcode,
    ...(Array.isArray(item.barcodes) ? item.barcodes : []),
    ...getTransferUomBarcodeValues(item)
  ];
}

function getTransferUomBarcodeValues(item = {}) {
  const rows = [
    ...(Array.isArray(item.uomConfigurations) ? item.uomConfigurations : []),
    ...(Array.isArray(item.uomConfig) ? item.uomConfig : []),
    ...(Array.isArray(item.uomConversions) ? item.uomConversions : []),
    ...(Array.isArray(item.customUnits) ? item.customUnits : [])
  ];
  return rows.flatMap((row = {}) => [row.barcode, row.customBarcode, row.customUomBarcode, row.uomBarcode, row.sku]).filter(Boolean);
}

function normalizeLinkedProfiles(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((profile) => ({
      id: String(profile.id || profile.siteId || profile.workspaceId || '').trim(),
      name: String(profile.name || profile.siteName || profile.workspaceName || profile.id || '').trim(),
      locations: Array.isArray(profile.locations) ? profile.locations
        .map((location) => ({
          id: String(location.id || location.locationId || '').trim(),
          name: String(location.name || location.displayName || location.locationName || location.label || location.id || '').trim()
        }))
        .filter((location) => location.id && location.name) : [],
      stockItems: Array.isArray(profile.stockItems) ? profile.stockItems
        .map((item) => ({
          id: String(item.id || item.stockItemId || '').trim(),
          name: String(item.name || item.stockItemName || item.ingredientName || '').trim(),
          category: String(item.category || '').trim(),
          unit: String(item.unit || item.uom || '').trim(),
          sku: String(item.sku || item.SKU || '').trim(),
          code: String(item.code || item.itemCode || item.stockCode || '').trim(),
          barcodes: toStringList(item.barcodes || item.barcode || item.Barcode),
          stock: Number(item.stock || 0) || 0,
          balances: item.balances && typeof item.balances === 'object' ? item.balances : {}
        }))
        .filter((item) => item.id && item.name) : []
    }))
    .filter((profile) => profile.id && profile.name);
}

function getPendingInboundTransfers(transfers = [], workspaceId = '') {
  const currentWorkspaceId = String(workspaceId || '').trim();
  return (Array.isArray(transfers) ? transfers : [])
    .filter((transfer) => (
      transfer?.status === 'pending_receipt' &&
      transfer?.direction === 'inbound' &&
      (!currentWorkspaceId || String(transfer.toSiteId || '') === currentWorkspaceId)
    ))
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function normalizeLocalLocations(value = []) {
  const locations = (Array.isArray(value) ? value : [])
    .map((location) => ({
      id: String(location.id || location.locationId || '').trim(),
      name: String(location.name || location.displayName || location.locationName || location.label || location.id || '').trim(),
      siteId: String(location.siteId || '').trim(),
      active: location.active !== false && location.archived !== true && location.deleted !== true
    }))
    .filter((location) => location.id && location.name && location.active);
  return locations.length ? locations : [{ id: 'main', name: 'Main Store', siteId: '' }];
}

function createCurrentTransferProfile(state = {}, draft = {}, locations = []) {
  const workspace = state.workspace || {};
  const id = String(workspace.id || draft.fromSiteId || draft.toSiteId || 'current').trim();
  return {
    id,
    name: String(workspace.siteName || workspace.name || workspace.displayName || draft.fromSiteName || draft.toSiteName || 'Main Site').trim(),
    locations
  };
}

function getProfileLocationName(profile = null, locationId = '') {
  if (!profile || !locationId) return '';
  return (profile.locations || []).find((location) => String(location.id) === String(locationId))?.name || '';
}

function createEmptyDraft() {
  return {
    fromSiteId: '',
    fromSiteName: '',
    fromLocationId: '',
    fromLocationName: '',
    toSiteId: '',
    toSiteName: '',
    toLocationId: '',
    toLocationName: '',
    externalSiteId: '',
    externalSiteName: '',
    externalLocationId: '',
    externalLocationName: '',
    note: '',
    items: []
  };
}

function createEmptyTransferTemplateDraft(seed = {}) {
  const items = Array.isArray(seed.items) ? seed.items : [];
  return {
    id: String(seed.id || '').trim(),
    name: String(seed.name || '').trim(),
    notes: String(seed.notes || '').trim(),
    selectedStockIds: items.map((item) => String(item.stockItemId || item.id || '')).filter(Boolean),
    createdAt: seed.createdAt || '',
    ...seed
  };
}

function createTransferSiteConfig(config = {}, locationCount = 0) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    orgId: String(source.orgId || source.org_id || '').trim(),
    corpId: String(source.corpId || source.corp_id || '').trim(),
    viewingOnly: source.viewingOnly === true || source.viewing_only === true,
    locationCount: Number(source.locationCount ?? source.location_count ?? locationCount) || locationCount,
    linkedSiteCount: Number(source.linkedSiteCount ?? source.linked_site_count ?? 0) || 0,
    showInternalTransfer: source.showInternalTransfer !== false && source.show_internal_transfer !== false,
    showExternalTransfer: source.showExternalTransfer === true || source.show_external_transfer === true
  };
}

function canSaveTransferDraft({ draft, transferScope, siteConfig, actionStatus }) {
  if (actionStatus === 'saving') return false;
  if (!(draft.items || []).length || !draft.fromLocationId) return false;
  if (transferScope === 'external') {
    return siteConfig.showExternalTransfer === true && draft.externalSiteId && draft.externalLocationId;
  }
  return Boolean(draft.toLocationId && draft.fromLocationId !== draft.toLocationId);
}

function findMatchingStockItem(stockItems = [], draftLine = {}, sourceItem = {}) {
  const preferredIds = [
    draftLine.targetStockItemId,
    draftLine.stockItemId,
    sourceItem?.id
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const exact = (stockItems || []).find((item) => preferredIds.includes(String(item.id || '').trim()));
  if (exact) return exact;

  const codes = [
    draftLine.code,
    draftLine.sku,
    sourceItem?.code,
    sourceItem?.itemCode,
    sourceItem?.stockCode,
    sourceItem?.sku,
    sourceItem?.SKU
  ].map(normalizeMatchKey).filter(Boolean);
  if (codes.length) {
    const codeMatch = (stockItems || []).find((item) => [
      item.code,
      item.itemCode,
      item.stockCode,
      item.sku,
      item.SKU
    ].map(normalizeMatchKey).some((code) => code && codes.includes(code)));
    if (codeMatch) return codeMatch;
  }

  const sourceBarcodes = new Set([
    ...toStringList(draftLine.barcodes || draftLine.barcode),
    ...toStringList(sourceItem?.barcodes || sourceItem?.barcode)
  ].map(normalizeMatchKey).filter(Boolean));
  if (sourceBarcodes.size) {
    const barcodeMatch = (stockItems || []).find((item) => toStringList(item.barcodes || item.barcode)
      .map(normalizeMatchKey)
      .some((barcode) => sourceBarcodes.has(barcode)));
    if (barcodeMatch) return barcodeMatch;
  }

  const sourceName = normalizeMatchKey(draftLine.stockItemName || draftLine.name || sourceItem?.name);
  const sourceUnit = normalizeMatchKey(draftLine.unit || sourceItem?.unit);
  if (!sourceName) return null;
  return (stockItems || []).find((item) => (
    normalizeMatchKey(item.name || item.stockItemName || item.ingredientName) === sourceName &&
    (!sourceUnit || !normalizeMatchKey(item.unit || item.uom) || normalizeMatchKey(item.unit || item.uom) === sourceUnit)
  )) || null;
}

function toStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  if (typeof value === 'object') return Object.values(value).map((entry) => String(entry || '').trim()).filter(Boolean);
  return String(value).split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeMatchKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function getSiteIdForLocation(locations = [], locationId = '') {
  return String((locations || []).find((location) => String(location.id) === String(locationId))?.siteId || '');
}

function getSiteById(sites = [], siteId = '') {
  return (sites || []).find((site) => String(site.id) === String(siteId)) || null;
}

function parseTransferQuantity(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
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
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 10v6"/><path d="M12 7h.01"/></svg>',
    mapPin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-4.4 7-11a7 7 0 1 0-14 0c0 6.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 2-5h14l2 5"/><path d="M5 9v10h14V9"/><path d="M9 19v-6h6v6"/><path d="M3 9h18"/></svg>',
    network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="m8.7 10.7 6.6-3.4M8.7 13.3l6.6 3.4"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6v20h12V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3l-1.5-2Z"/><circle cx="12" cy="13" r="3.5"/></svg>'
  };
  return icons[name] || icons.x;
}
