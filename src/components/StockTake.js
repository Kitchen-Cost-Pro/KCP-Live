import '../styles/stockTake.css';
import '../styles/fieldHelp.css';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { renderLoadingPanel } from './LoadingPanel.js';
import { getLocationStock } from '../utils/stockBalances.js';
import { isStockCountableItem } from '../services/stockCountEligibility.js';

export function renderStockTake({ state, onStockTakeFilterChange, onStockTakeAction = {} } = {}) {
  const stockTake = state.stockTake || {};
  const draft = stockTake.draftSession || createEmptyDraft();
  const savedDrafts = stockTake.savedDrafts || [];
  const scanCount = stockTake.scanCount || createEmptyScanCountDraft();
  const sessionSetup = stockTake.sessionSetup || createEmptySessionSetup();
  const templateDraft = stockTake.templateDraft || createEmptyTemplateDraft();
  const filters = {
    query: '',
    templateListQuery: '',
    templateSelectionQuery: '',
    overlay: '',
    openDropdown: '',
    exportFormat: 'xlsx',
    exportLocationId: '',
    exportTemplateId: '',
    ...stockTake.filters
  };
  const sites = stockTake.sites || [];
  const stockLocations = stockTake.locations || [];
  const siteOptions = sites.map((site) => ({ value: site.id, label: site.name || site.code || site.id }));
  const locationOptions = stockLocations.map((location) => toStockTakeLocationOption(location, sites));
  const visibleItems = getVisibleStockTakeItems(stockTake.stockItems || [], draft, filters.query || '');
  const draftMap = new Map((draft.items || []).map((item) => [String(item.stockItemId), item]));
  const templateSummary = getTemplateSummary(stockTake.templates || [], stockTake.locations || [], filters.templateListQuery || '');
  const templateSelectionOptions = getTemplateSelectionOptions(
    stockTake.stockItems || [],
    templateDraft.scope,
    filters.templateSelectionQuery || '',
    templateDraft.selections || []
  );
  const varianceTotal = (draft.items || []).reduce((sum, item) => sum + Number(item.varianceImpactEx || 0), 0);

  const view = document.createElement('section');
  view.id = 'view-stock-take';
  view.className = 'stockTakeView';
  view.dataset.openDropdown = filters.openDropdown || '';
  if (stockTake.status === 'loading' && !(stockTake.stockItems || []).length && !(stockTake.locations || []).length && !(stockTake.templates || []).length) {
    view.innerHTML = renderLoadingPanel('Loading stock count', 'Fetching count templates, stock items, locations, and saved drafts.');
    return view;
  }
  view.innerHTML = `
    ${stockTake.actionError ? renderNotice(stockTake.actionError, 'error') : ''}

      <div class="stockTakeShell ${stockTake.sessionActive ? 'stockTakeShell--session' : ''}">
      ${renderStockTakePageActions(filters)}
      ${!stockTake.sessionActive ? renderLaunchpad(savedDrafts) : renderActiveSession({
        draft,
        filters,
        visibleItems,
        draftMap,
        locations: stockLocations,
        varianceTotal,
        actionStatus: stockTake.actionStatus || '',
        actionError: stockTake.actionError || ''
      })}
    </div>

    ${renderOverlay({
      stockTake,
      filters,
      scanCount,
      sessionSetup,
      templateDraft,
      siteOptions,
      locationOptions,
      stockLocations,
      templateSummary,
      templateSelectionOptions
    })}
    ${renderToast(stockTake.toast)}
  `;

  bindStockTakeEvents(view, onStockTakeFilterChange, onStockTakeAction, filters);
  bindFieldHelpTooltips(view);
  return view;
}

function bindStockTakeEvents(view, onStockTakeFilterChange, onStockTakeAction, filters = {}) {
  view.querySelector('[data-stocktake-open-start]')?.addEventListener('click', () => onStockTakeAction.onOpenStartSession?.());
  view.querySelector('[data-stocktake-open-quick]')?.addEventListener('click', () => onStockTakeAction.onOpenQuickCount?.());
  view.querySelector('[data-stocktake-open-bulk-scan]')?.addEventListener('click', () => onStockTakeAction.onOpenBulkScan?.());
  view.querySelector('[data-stocktake-open-templates]')?.addEventListener('click', () => {
    onStockTakeFilterChange?.({ openDropdown: '' });
    onStockTakeAction.onOpenTemplateManager?.();
  });
  view.querySelectorAll('[data-stocktake-count-template-download]').forEach((button) => {
    button.addEventListener('click', () => {
      onStockTakeFilterChange?.({ openDropdown: '' });
      onStockTakeAction.onOpenCountTemplateLocationPicker?.(button.dataset.stocktakeCountTemplateDownload || 'csv');
    });
  });
  const stockTakeImportInput = view.querySelector('[data-stocktake-count-template-import]');
  view.querySelector('[data-stocktake-count-template-import-trigger]')?.addEventListener('click', () => {
    onStockTakeFilterChange?.({ openDropdown: '' });
    stockTakeImportInput?.click();
  });
  stockTakeImportInput?.addEventListener('change', () => {
    const file = stockTakeImportInput.files?.[0];
    if (file) onStockTakeAction.onImportCountTemplate?.(file);
    stockTakeImportInput.value = '';
  });
  view.querySelectorAll('[data-stocktake-resume-specific]').forEach((button) => {
    button.addEventListener('click', () => onStockTakeAction.onRestoreSpecificDraft?.(button.dataset.stocktakeResumeSpecific || ''));
  });
  view.querySelectorAll('[data-stocktake-discard-draft]').forEach((button) => {
    button.addEventListener('click', () => onStockTakeAction.onDiscardSpecificDraft?.(button.dataset.stocktakeDiscardDraft || ''));
  });
  view.querySelector('[data-stocktake-cancel]')?.addEventListener('click', () => onStockTakeAction.onCancelSession?.());
  view.querySelector('[data-stocktake-save]')?.addEventListener('click', () => onStockTakeAction.onSave?.());
  view.querySelector('[data-stocktake-save-draft]')?.addEventListener('click', () => onStockTakeAction.onSaveDraftSession?.());
  view.querySelector('[data-stocktake-scan-count]')?.addEventListener('click', () => onStockTakeAction.onScanCount?.());
  view.querySelectorAll('[data-stocktake-overlay-close]').forEach((button) => {
    button.addEventListener('click', () => onStockTakeAction.onCloseOverlay?.());
  });

  view.querySelector('[data-stocktake-count-template-confirm]')?.addEventListener('click', (event) => {
    const selectedLocationId = filters.exportLocationId || event.currentTarget.dataset.stocktakeCountTemplateLocation || '';
    onStockTakeAction.onExportCountTemplate?.(event.currentTarget.dataset.stocktakeCountTemplateFormat || 'xlsx', selectedLocationId);
  });
  view.querySelector('[data-stocktake-template-export-confirm]')?.addEventListener('click', (event) => {
    const templateId = filters.exportTemplateId || event.currentTarget.dataset.stocktakeTemplateExportId || '';
    const selectedLocationId = filters.exportLocationId || event.currentTarget.dataset.stocktakeTemplateExportLocation || '';
    onStockTakeAction.onExportTemplatePdf?.(templateId, selectedLocationId);
  });
  view.querySelector('[data-stocktake-toast-close]')?.addEventListener('click', () => onStockTakeAction.onDismissToast?.());

  view.querySelector('[data-stocktake-search]')?.addEventListener('input', (event) => {
    onStockTakeFilterChange?.({ query: event.target.value });
  });

  view.querySelector('[data-stocktake-scan-count-barcode]')?.addEventListener('input', (event) => {
    onStockTakeAction.onUpdateScanCountBarcode?.(event.currentTarget.value);
  });
  view.querySelector('[data-stocktake-scan-count-barcode]')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const qty = view.querySelector('[data-stocktake-scan-count-qty]');
      qty?.focus();
    }
  });
  view.querySelector('[data-stocktake-scan-count-qty]')?.addEventListener('input', (event) => {
    onStockTakeAction.onPreserveFocus?.(event.currentTarget);
    onStockTakeAction.onUpdateScanCountQuantity?.(event.currentTarget.value);
  });
  view.querySelector('[data-stocktake-scan-count-uom]')?.addEventListener('change', (event) => {
    onStockTakeAction.onUpdateScanCountUom?.(event.currentTarget.value);
  });
  view.querySelector('[data-stocktake-scan-count-add]')?.addEventListener('click', () => onStockTakeAction.onConfirmScanCountEntry?.());
  view.querySelectorAll('[data-stocktake-scan-count-done]').forEach((button) => {
    button.addEventListener('click', () => onStockTakeAction.onCloseScanCount?.());
  });
  view.querySelector('[data-stocktake-scan-camera-open]')?.addEventListener('click', () => onStockTakeAction.onOpenScanCamera?.());
  view.querySelector('[data-stocktake-scan-camera-close]')?.addEventListener('click', () => onStockTakeAction.onCloseScanCamera?.());
  view.querySelector('[data-stocktake-scan-camera-clear]')?.addEventListener('click', () => onStockTakeAction.onClearScanCameraItems?.());
  view.querySelector('[data-stocktake-scan-camera-apply]')?.addEventListener('click', () => onStockTakeAction.onApplyScanCameraItems?.());
  if (view.querySelector('[data-stocktake-camera-reader]')) {
    requestAnimationFrame(() => {
      window.setTimeout(() => onStockTakeAction.onInitScanCamera?.(), 80);
    });
  }
  view.querySelector('[data-stocktake-camera-list]')?.addEventListener('click', (event) => {
    const minus = event.target.closest('[data-stocktake-scan-camera-minus]');
    if (minus) {
      onStockTakeAction.onAdjustScanCameraQty?.(minus.dataset.stocktakeScanCameraMinus || '', -1);
      return;
    }
    const plus = event.target.closest('[data-stocktake-scan-camera-plus]');
    if (plus) {
      onStockTakeAction.onAdjustScanCameraQty?.(plus.dataset.stocktakeScanCameraPlus || '', 1);
      return;
    }
    const remove = event.target.closest('[data-stocktake-scan-camera-remove]');
    if (remove) {
      onStockTakeAction.onRemoveScanCameraItem?.(remove.dataset.stocktakeScanCameraRemove || '');
    }
  });

  view.querySelector('[data-stocktake-note]')?.addEventListener('input', (event) => {
    onStockTakeAction.onPreserveFocus?.(event.currentTarget);
    onStockTakeAction.onDraftChange?.({ note: event.currentTarget.value });
  });

  view.querySelector('[data-stocktake-template-list-search]')?.addEventListener('input', (event) => {
    onStockTakeFilterChange?.({ templateListQuery: event.target.value });
  });

  view.querySelector('[data-stocktake-template-selection-search]')?.addEventListener('input', (event) => {
    onStockTakeAction.onPreserveFocus?.(event.currentTarget);
    onStockTakeFilterChange?.({ templateSelectionQuery: event.target.value });
  });

  view.querySelector('[data-stocktake-session-date]')?.addEventListener('input', (event) => {
    onStockTakeAction.onUpdateSessionSetup?.({ date: event.currentTarget.value });
  });

  view.querySelector('[data-stocktake-quick-date]')?.addEventListener('input', (event) => {
    onStockTakeAction.onUpdateSessionSetup?.({ date: event.currentTarget.value });
  });
  view.querySelector('[data-stocktake-bulk-date]')?.addEventListener('input', (event) => {
    onStockTakeAction.onUpdateSessionSetup?.({ date: event.currentTarget.value });
  });

  view.querySelector('[data-stocktake-template-name]')?.addEventListener('input', (event) => {
    onStockTakeAction.onPreserveFocus?.(event.currentTarget);
    view.querySelector('.stockTakeNotice')?.remove();
    onStockTakeAction.onUpdateTemplateDraft?.({ name: event.currentTarget.value }, { render: false });
  });

  view.querySelectorAll('[data-stocktake-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.stocktakeDropdown;
      const current = view.dataset.openDropdown || '';
      onStockTakeFilterChange?.({ openDropdown: current === id ? '' : id });
    });
  });

  view.addEventListener('click', (event) => {
    if (!view.dataset.openDropdown || event.target.closest('[data-stocktake-dropdown-root]')) return;
    onStockTakeFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-stocktake-dropdown-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const query = String(event.currentTarget.value || '').trim().toLowerCase();
      event.currentTarget.closest('.stockTakeDropdownMenu')?.querySelectorAll('[data-stocktake-option]').forEach((button) => {
        const label = String(button.textContent || '').toLowerCase();
        button.hidden = Boolean(query) && !label.includes(query);
      });
    });
  });

  view.querySelectorAll('[data-stocktake-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.stocktakeOptionAction || '';
      const value = button.dataset.stocktakeOptionValue || '';
      if (action === 'draft:locationId') {
        onStockTakeAction.onDraftLocationChange?.(value);
      } else if (action === 'setup:siteId') {
        onStockTakeAction.onUpdateSessionSetup?.({ siteId: value });
      } else if (action === 'setup:locationId') {
        onStockTakeAction.onUpdateSessionSetup?.({ locationId: value });
      } else if (action === 'setup:templateId') {
        onStockTakeAction.onUpdateSessionSetup?.({ templateId: value });
      } else if (action === 'template:siteId') {
        onStockTakeAction.onUpdateTemplateDraft?.({ siteId: value });
      } else if (action === 'template:targetLocation') {
        onStockTakeAction.onUpdateTemplateDraft?.({ targetLocation: value });
      } else if (action === 'export:locationId') {
        onStockTakeFilterChange?.({ exportLocationId: value, openDropdown: '' });
        return;
      }
      onStockTakeFilterChange?.({ openDropdown: '' });
    });
  });

  view.querySelectorAll('[data-stocktake-count]').forEach((field) => {
    field.addEventListener('input', () => {
      onStockTakeAction.onPreserveFocus?.(field);
      onStockTakeAction.onCountChange?.(field.dataset.stocktakeCount, field.value, field.dataset.stocktakeUom || 'base');
    });
  });

  view.querySelector('[data-stocktake-start-session-confirm]')?.addEventListener('click', () => onStockTakeAction.onConfirmStartSession?.());
  view.querySelector('[data-stocktake-quick-start-confirm]')?.addEventListener('click', () => onStockTakeAction.onConfirmQuickCount?.());
  view.querySelector('[data-stocktake-bulk-start-confirm]')?.addEventListener('click', () => onStockTakeAction.onConfirmBulkScanSetup?.());
  view.querySelector('[data-stocktake-bulk-finalise]')?.addEventListener('click', () => onStockTakeAction.onFinaliseBulkScan?.());
  view.querySelector('[data-stocktake-template-create]')?.addEventListener('click', () => onStockTakeAction.onOpenTemplateEditor?.(''));
  view.querySelectorAll('[data-stocktake-template-edit]').forEach((button) => {
    button.addEventListener('click', () => onStockTakeAction.onOpenTemplateEditor?.(button.dataset.stocktakeTemplateEdit || ''));
  });
  view.querySelectorAll('[data-stocktake-template-export]').forEach((button) => {
    button.addEventListener('click', () => onStockTakeAction.onExportTemplatePdf?.(button.dataset.stocktakeTemplateExport || ''));
  });
  view.querySelectorAll('[data-stocktake-template-delete]').forEach((button) => {
    button.addEventListener('click', () => onStockTakeAction.onDeleteTemplate?.(button.dataset.stocktakeTemplateDelete || ''));
  });
  view.querySelector('[data-stocktake-template-editor-back]')?.addEventListener('click', () => onStockTakeAction.onOpenTemplateManager?.());
  view.querySelector('[data-stocktake-template-save]')?.addEventListener('click', () => onStockTakeAction.onSaveTemplate?.());
  view.querySelectorAll('[data-stocktake-template-scope]').forEach((button) => {
    button.addEventListener('click', () => onStockTakeAction.onSetTemplateScope?.(button.dataset.stocktakeTemplateScope || 'category'));
  });
  view.querySelectorAll('[data-stocktake-template-location]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onStockTakeAction.onToggleTemplateLocation?.(checkbox.dataset.stocktakeTemplateLocation || '', checkbox.checked);
    });
  });
  view.querySelector('[data-stocktake-template-select-all]')?.addEventListener('click', () => onStockTakeAction.onBulkTemplateSelection?.(true));
  view.querySelector('[data-stocktake-template-clear-all]')?.addEventListener('click', () => onStockTakeAction.onBulkTemplateSelection?.(false));
  view.querySelectorAll('[data-stocktake-template-selection]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onStockTakeAction.onToggleTemplateSelection?.(checkbox.dataset.stocktakeTemplateSelection || '', checkbox.checked);
    });
  });
}


function getStockTakeLineUomCountValues(current = {}, item = {}) {
  const counts = current?.uomCounts;
  if (!Array.isArray(counts)) {
    return counts && typeof counts === 'object' ? counts : {};
  }
  const result = {};
  const baseUom = String(item.unit || 'ea').trim().toLowerCase();
  counts.forEach((entry = {}) => {
    const count = Number(entry.count ?? entry.quantity ?? entry.scans ?? 0) || 0;
    if (!count) return;
    const ratio = Number(entry.ratio || 1) || 1;
    const name = String(entry.uomName || entry.customUom || entry.name || entry.key || '').trim();
    const key = ratio === 1 && (!name || name.toLowerCase() === baseUom) ? 'base' : name || 'base';
    result[key] = (Number(result[key] || 0) || 0) + count;
  });
  return result;
}

function renderStockTakePageActions(filters = {}) {
  const isOpen = filters.openDropdown === 'stocktake-actions';
  return `
    <div class="stockTakePageActions stockTakeDropdown stockTakeDropdown--actions ${isOpen ? 'stockTakeDropdown--open' : ''}" data-stocktake-dropdown-root>
      <button type="button" class="stockTakeActionsButton" data-stocktake-dropdown="stocktake-actions" aria-expanded="${isOpen}" aria-label="Stock take actions">
        ${icon('download')}
        <strong>Action Items</strong>
        ${icon('chevronDown')}
      </button>
      <div class="stockTakeDropdownMenu stockTakeActionsMenu" role="menu">
        <button type="button" data-stocktake-open-templates role="menuitem">
          ${icon('folder')}
          <span>Manage Templates</span>
        </button>
        <span class="stockTakeFileDivider">Export Templates</span>
        <button type="button" data-stocktake-count-template-download="xlsx" role="menuitem">
          ${icon('download')}
          <span>XLSX Template</span>
        </button>
        <span class="stockTakeFileDivider">Import Counts</span>
        <button type="button" data-stocktake-count-template-import-trigger role="menuitem">
          ${icon('upload')}
          <span>Upload Count File</span>
        </button>
      </div>
      <input type="file" accept=".csv,.xlsx,.xls,text/csv" data-stocktake-count-template-import hidden />
    </div>
  `;
}

function renderLaunchpad(savedDrafts = []) {
  const activeSessions = [...(Array.isArray(savedDrafts) ? savedDrafts : [])]
    .sort((left, right) => String(right.savedAt || right.date || '').localeCompare(String(left.savedAt || left.date || '')));
  return `
    <div class="stockTakeHero">
      <div class="stockTakeHeroIcon">${icon('clipboard')}</div>
      <h2>Structured Stock Take</h2>
      <p>
        Templates must be created first before attempting a stock take.
        Structure your counts by location, category, or specific item lists.
      </p>
      <div class="stockTakeHeroActions">
        <button type="button" class="stockTakeHeroButton is-primary" data-stocktake-open-start>
          <strong>Start Session</strong>
          <span>Choose Template</span>
        </button>
        <button type="button" class="stockTakeHeroButton" data-stocktake-open-quick>
          <strong>Quick Count</strong>
          <span>No Template</span>
        </button>
        <button type="button" class="stockTakeHeroButton stockTakeHeroButton--bulk" data-stocktake-open-bulk-scan>
          <strong>Bulk Scan</strong>
          <span>Scan Multiple</span>
        </button>
      </div>

      <section class="stockTakeActiveSessions" aria-labelledby="stocktake-active-sessions-title">
        <header class="stockTakeActiveSessionsHead">
          <div>
            <span>Saved Drafts</span>
            <h3 id="stocktake-active-sessions-title">Active Sessions</h3>
          </div>
          <strong>${activeSessions.length} ${activeSessions.length === 1 ? 'session' : 'sessions'}</strong>
        </header>
        <div class="stockTakeActiveSessionsTableWrap">
          <table class="stockTakeActiveSessionsTable">
            <thead>
              <tr>
                <th scope="col">Session Template</th>
                <th scope="col">Date</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${activeSessions.length ? activeSessions.map((draft) => {
                const itemCount = Array.isArray(draft.items) ? draft.items.length : 0;
                const sessionName = draft.templateName || draft.locationName || 'Saved Count';
                const sessionType = draft.sessionMode === 'template' ? 'Template Session' : 'Quick Count';
                const dateLabel = formatDisplayDate(draft.date || draft.savedAt || '') || 'Date not set';
                const savedLabel = draft.savedAt ? `Saved ${formatDisplayDate(draft.savedAt)}` : 'Saved draft';
                return `
                  <tr>
                    <td data-label="Session Template">
                      <strong>${escapeHtml(sessionName)}</strong>
                      <span>${escapeHtml(sessionType)} · ${escapeHtml(draft.locationName || 'Main Store')} · ${itemCount} ${itemCount === 1 ? 'line' : 'lines'}</span>
                    </td>
                    <td data-label="Date">
                      <strong>${escapeHtml(dateLabel)}</strong>
                      <span>${escapeHtml(savedLabel)}</span>
                    </td>
                    <td data-label="Actions">
                      <div class="stockTakeActiveSessionActions">
                        <button type="button" class="stockTakeActiveSessionAction stockTakeActiveSessionAction--resume" data-stocktake-resume-specific="${escapeAttribute(draft.id || '')}" ${draft.id ? '' : 'disabled'}>
                          Resume
                        </button>
                        <button type="button" class="stockTakeActiveSessionAction stockTakeActiveSessionAction--discard" data-stocktake-discard-draft="${escapeAttribute(draft.id || '')}" ${draft.id ? '' : 'disabled'}>
                          ${icon('trash')}
                          <span>Discard</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('') : `
                <tr class="stockTakeActiveSessionsEmptyRow">
                  <td colspan="3">
                    <div class="stockTakeActiveSessionsEmpty">
                      <strong>No active sessions</strong>
                      <span>Sessions saved as drafts will appear here immediately.</span>
                    </div>
                  </td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
}

function renderActiveSession({ draft, filters, visibleItems, draftMap, locations = [], varianceTotal, actionStatus = '', actionError = '' }) {
  const actionPending = ['saving', 'saving-draft'].includes(actionStatus);
  const maxCustomUomColumns = Math.min(3, Math.max(0, ...visibleItems.map((item) => getUomConfigs(item).slice(0, 3).length)));
  const customHeaders = Array.from({ length: maxCustomUomColumns }, (_, index) => `<th>Custom UOM ${index + 1} Count</th>`).join('');
  const emptyColspan = 5 + maxCustomUomColumns;
  return `
    <div class="stockTakeSession">
      <section class="stockTakeSessionCard">
        <header class="stockTakeSessionHead">
          <div>
            <p>${escapeHtml(draft.sessionMode === 'template' ? 'Template Session' : 'Quick Count')}</p>
            <h2>${escapeHtml(draft.templateName || draft.locationName || 'Stock Take')}</h2>
          </div>
          <div class="stockTakeSessionMeta">
            <span>${escapeHtml(formatDisplayDate(draft.date || ''))}</span>
            <span>${escapeHtml(draft.locationName || 'Main Store')}</span>
            <button type="button" class="stockTakeSessionExit" data-stocktake-cancel>Exit Session</button>
          </div>
        </header>

        <div class="stockTakeSessionToolbar">
          <label class="stockTakeField stockTakeField--grow">
            ${renderFieldHelpLabel('Search', 'Search within the active stock take item list to focus on a specific product or ingredient.')}
            <div class="stockTakeSearchShell">
              <input
                type="search"
                value="${escapeAttribute(filters.query || '')}"
                placeholder="Search stock items..."
                data-stocktake-search
                data-focus-key="stocktake-search"
              />
              <button type="button" class="stockTakeSearchAction stockTakeSearchAction--accent" data-stocktake-scan-count aria-label="Quick scan count">
                ${icon('scanPlus')}
              </button>
            </div>
          </label>
          <label class="stockTakeField stockTakeField--note">
            ${renderFieldHelpLabel('Reference Note', 'Optional note for this count session, such as the team, shift, or reason for the count.')}
            <input
              type="text"
              value="${escapeAttribute(draft.note || '')}"
              placeholder="Optional note..."
              data-stocktake-note
              data-focus-key="stocktake-note"
            />
          </label>
        </div>

        <div class="stockTakeSessionTableWrap" data-scroll-key="stocktake-session-table">
          <table class="stockTakeTable stockTakeTable--uomColumns">
            <thead>
              <tr>
                <th>Item</th>
                <th>System</th>
                <th>Base Count</th>
                ${customHeaders}
                <th>Variance</th>
                <th>Impact</th>
              </tr>
            </thead>
            <tbody>
              ${visibleItems.map((item) => {
                const current = draftMap.get(String(item.id));
                const system = getLocationStock(item, draft.locationId, locations);
                const shelfCount = current?.shelfCount ?? '';
                const currentUomCounts = getStockTakeLineUomCountValues(current, item);
                const variance = current ? Number(current.variance || 0) : 0;
                const impact = current ? Number(current.varianceImpactEx || 0) : 0;
                const uomConfigs = getUomConfigs(item).slice(0, 3);
                const baseVal = currentUomCounts.base ?? (current && Object.keys(currentUomCounts || {}).length === 0 ? shelfCount : '');
                return `
                  <tr>
                    <td>
                      <strong>${escapeHtml(item.name || '')}</strong>
                      <span>${escapeHtml(item.category || 'Uncategorised')}</span>
                    </td>
                    <td>${formatNumber(system)} ${escapeHtml(item.unit || '')}</td>
                    <td>
                      <div class="stockTakeCountInput">
                        <input
                          type="text"
                          inputmode="decimal"
                          value="${escapeAttribute(String(baseVal))}"
                          data-stocktake-count="${escapeAttribute(item.id)}"
                          data-stocktake-uom="base"
                          data-focus-key="stocktake-${escapeAttribute(item.id)}-base"
                          placeholder="0"
                        />
                        <em>${escapeHtml(String(item.unit || 'ea').toLowerCase())}</em>
                      </div>
                    </td>
                    ${Array.from({ length: maxCustomUomColumns }, (_, index) => {
                      const cfg = uomConfigs[index];
                      const key = String(cfg?.customUom || '').trim();
                      if (!key) return '<td class="stockTakeTableDash">-</td>';
                      const customVal = currentUomCounts[key] ?? '';
                      return `
                        <td>
                          <div class="stockTakeCountInput">
                            <input
                              type="text"
                              inputmode="decimal"
                              value="${escapeAttribute(String(customVal))}"
                              data-stocktake-count="${escapeAttribute(item.id)}"
                              data-stocktake-uom="${escapeAttribute(key)}"
                              data-focus-key="stocktake-${escapeAttribute(item.id)}-${escapeAttribute(key)}"
                              placeholder="0"
                            />
                            <em>${escapeHtml(key.toLowerCase())}</em>
                          </div>
                        </td>
                      `;
                    }).join('')}
                    <td class="${variance < 0 ? 'is-negative' : variance > 0 ? 'is-positive' : ''}" data-stocktake-variance="${escapeAttribute(item.id)}">
                      ${current ? `${variance > 0 ? '+' : ''}${formatNumber(variance)}` : '-'}
                    </td>
                    <td class="${impact < 0 ? 'is-negative' : impact > 0 ? 'is-positive' : ''}" data-stocktake-impact="${escapeAttribute(item.id)}">
                      ${current ? formatCurrency(impact) : '-'}
                    </td>
                  </tr>
                `;
              }).join('') || `<tr><td colspan="${emptyColspan}" class="stockTakeTableEmpty">No stock items match this count scope.</td></tr>`}
            </tbody>
          </table>
        </div>

        <footer class="stockTakeSessionFooter">
          <div class="stockTakeSessionImpact">
            <div><span>Counted Lines</span><strong data-stocktake-counted-lines>${(draft.items || []).length}</strong></div>
            <div><span>Variance Value</span><strong data-stocktake-variance-total>${formatCurrency(varianceTotal)}</strong></div>
          </div>
          <div class="stockTakeSessionActions">
            ${actionStatus === 'saving-draft' ? `
              <p class="stockTakeSessionFeedback" role="status" aria-live="polite">Saving this draft and returning to Active Sessions...</p>
            ` : actionError ? `
              <p class="stockTakeSessionFeedback stockTakeSessionFeedback--error" role="alert">${escapeHtml(actionError)}</p>
            ` : ''}
            ${draft.sessionMode === 'template' ? `
              <button type="button" class="stockTakeGhost" data-stocktake-save-draft ${draft.locationId && !actionPending ? '' : 'disabled'}>
                ${actionStatus === 'saving-draft' ? 'Saving Draft...' : 'Save Draft'}
              </button>
            ` : ''}
            <button type="button" class="stockTakePrimary" data-stocktake-save ${(draft.items || []).length && !actionPending ? '' : 'disabled'}>
              ${actionStatus === 'saving' ? 'Committing...' : 'Commit Stock Take'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  `;
}

function renderOverlay({ stockTake, filters, scanCount, sessionSetup, templateDraft, siteOptions, locationOptions, stockLocations, templateSummary, templateSelectionOptions }) {
  if (!filters.overlay) return '';
  if (filters.overlay === 'scan-count') {
    return renderScanCountOverlay(scanCount);
  }
  if (filters.overlay === 'start-session') {
    const templateOptions = (stockTake.templates || []).map((template) => ({ value: template.id, label: template.name }));
    const selectedTemplate = (stockTake.templates || []).find((template) => String(template.id) === String(sessionSetup.templateId || ''));
    const selectedTemplateLocationIds = getTemplateLocationIds(selectedTemplate);
    const setupSiteId = sessionSetup.siteId || getSiteIdForStockLocation(sessionSetup.locationId, stockLocations) || getSiteIdForTemplate(selectedTemplate, stockLocations) || siteOptions[0]?.value || '';
    const sessionLocationOptions = selectedTemplate
      ? locationOptions.filter((location) => selectedTemplateLocationIds.includes(String(location.value)) && (!setupSiteId || String(location.siteId) === String(setupSiteId)))
      : locationOptions.filter((location) => !setupSiteId || String(location.siteId) === String(setupSiteId));
    return `
      <div class="stockTakeOverlayBackdrop">
        <section class="stockTakeOverlayCard stockTakeOverlayCard--compact">
          <header class="stockTakeOverlayHead">
            <div>
              <p>Stock Take</p>
              <h3>Start New Session</h3>
            </div>
            <button type="button" class="stockTakeOverlayClose" data-stocktake-overlay-close aria-label="Close">${icon('x')}</button>
          </header>
          <div class="stockTakeOverlayBody stockTakeOverlayBody--compact">
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Which Template?', 'Choose the saved template that controls which items are included in this count session.')}
              ${renderOverlayDropdown({
                id: 'stocktake-start-template',
                action: 'setup:templateId',
                selectedValue: sessionSetup.templateId || '',
                fallbackLabel: 'Select template',
                options: templateOptions,
                openDropdown: filters.openDropdown
              })}
            </label>
            ${siteOptions.length > 1 ? `
              <label class="stockTakeField">
                ${renderFieldHelpLabel('Location Group', 'Choose the location group for this stock take. Locations are filtered to this group.')}
                ${renderOverlayDropdown({
                  id: 'stocktake-start-site',
                  action: 'setup:siteId',
                  selectedValue: setupSiteId,
                  fallbackLabel: 'Select location group',
                  options: siteOptions,
                  openDropdown: filters.openDropdown
                })}
              </label>
            ` : ''}
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Template Selling Location', 'Choose the selling location linked to this template for this count session.')}
              ${renderOverlayDropdown({
                id: 'stocktake-start-location',
                action: 'setup:locationId',
                selectedValue: sessionSetup.locationId || '',
                fallbackLabel: selectedTemplate ? 'Select linked location' : 'Choose a template first',
                options: sessionLocationOptions,
                openDropdown: filters.openDropdown
              })}
            </label>
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Count Date', 'Trade date for this structured stock take session.')}
              <input type="date" value="${escapeAttribute(sessionSetup.date || '')}" data-stocktake-session-date />
            </label>
          </div>
          <footer class="stockTakeOverlayFooter stockTakeOverlayFooter--compact">
            <button type="button" class="stockTakeGhost" data-stocktake-overlay-close>Cancel</button>
            <button type="button" class="stockTakePrimary" data-stocktake-start-session-confirm>Begin Count</button>
          </footer>
        </section>
      </div>
    `;
  }

  if (filters.overlay === 'count-template-location') {
    const exportFormat = ['csv', 'xlsx'].includes(String(filters.exportFormat || '').toLowerCase()) ? String(filters.exportFormat).toLowerCase() : 'xlsx';
    const exportLocationOptions = (stockLocations.length ? stockLocations : [{ id: 'main', name: 'Main Store' }]).map((location) => ({
      value: String(location.id || 'main'),
      label: String(location.name || location.displayName || location.locationName || 'Main Store'),
      meta: ''
    }));
    return `
      <div class="stockTakeOverlayBackdrop">
        <section class="stockTakeOverlayCard stockTakeOverlayCard--compact">
          <header class="stockTakeOverlayHead">
            <div>
              <p>Stock Take Excel</p>
              <h3>Choose Count Location</h3>
            </div>
            <button type="button" class="stockTakeOverlayClose" data-stocktake-overlay-close aria-label="Close">${icon('x')}</button>
          </header>
          <div class="stockTakeOverlayBody stockTakeOverlayBody--compact">
            <p class="stockTakeOverlayHint">Search and select the location you want to count. The exported file will only include this location.</p>
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Count Location', 'Choose the location this stock count sheet is for.')}
              ${renderOverlayDropdown({
                id: 'stocktake-export-location',
                action: 'export:locationId',
                selectedValue: filters.exportLocationId || '',
                fallbackLabel: 'Search and select location',
                options: exportLocationOptions,
                openDropdown: filters.openDropdown
              })}
            </label>
          </div>
          <footer class="stockTakeOverlayFooter stockTakeOverlayFooter--compact">
            <button type="button" class="stockTakeGhost" data-stocktake-overlay-close>Cancel</button>
            <button type="button" class="stockTakePrimary" data-stocktake-count-template-confirm data-stocktake-count-template-format="${escapeAttribute(exportFormat)}" data-stocktake-count-template-location="${escapeAttribute(filters.exportLocationId || '')}" ${(filters.exportLocationId || '') ? '' : 'disabled'}>Download ${escapeHtml(exportFormat.toUpperCase())}</button>
          </footer>
        </section>
      </div>
    `;
  }


  if (filters.overlay === 'template-export-location') {
    const template = (stockTake.templates || []).find((entry) => String(entry.id) === String(filters.exportTemplateId || ''));
    const linkedLocationIds = getTemplateLocationIds(template);
    const exportLocationOptions = (linkedLocationIds.length ? linkedLocationIds : (stockLocations || []).map((location) => location.id))
      .map((locationId) => {
        const location = (stockLocations || []).find((entry) => String(entry.id || entry.locationId || '') === String(locationId));
        return {
          value: String(locationId || ''),
          label: String(location?.name || location?.displayName || location?.locationName || locationId || 'Location'),
          meta: ''
        };
      })
      .filter((option) => option.value);
    return `
      <div class="stockTakeOverlayBackdrop">
        <section class="stockTakeOverlayCard stockTakeOverlayCard--compact">
          <header class="stockTakeOverlayHead">
            <div>
              <p>Stock Count PDF</p>
              <h3>Choose Template Location</h3>
            </div>
            <button type="button" class="stockTakeOverlayClose" data-stocktake-overlay-close aria-label="Close">${icon('x')}</button>
          </header>
          <div class="stockTakeOverlayBody stockTakeOverlayBody--compact">
            <p class="stockTakeOverlayHint">This template is linked to multiple locations. Choose the location for this PDF count sheet.</p>
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Template Location', 'Choose the location this PDF stock count sheet should be generated for.')}
              ${renderOverlayDropdown({
                id: 'stocktake-template-export-location',
                action: 'export:locationId',
                selectedValue: filters.exportLocationId || '',
                fallbackLabel: 'Search and select location',
                options: exportLocationOptions,
                openDropdown: filters.openDropdown
              })}
            </label>
          </div>
          <footer class="stockTakeOverlayFooter stockTakeOverlayFooter--compact">
            <button type="button" class="stockTakeGhost" data-stocktake-overlay-close>Cancel</button>
            <button type="button" class="stockTakePrimary" data-stocktake-template-export-confirm data-stocktake-template-export-id="${escapeAttribute(filters.exportTemplateId || '')}" data-stocktake-template-export-location="${escapeAttribute(filters.exportLocationId || '')}" ${(filters.exportLocationId || '') ? '' : 'disabled'}>Download PDF</button>
          </footer>
        </section>
      </div>
    `;
  }

  if (filters.overlay === 'quick-count') {
    const quickSiteId = sessionSetup.siteId || getSiteIdForStockLocation(sessionSetup.locationId, stockLocations) || siteOptions[0]?.value || '';
    const quickLocationOptions = locationOptions.filter((location) => !quickSiteId || String(location.siteId) === String(quickSiteId));
    return `
      <div class="stockTakeOverlayBackdrop">
        <section class="stockTakeOverlayCard stockTakeOverlayCard--compact">
          <header class="stockTakeOverlayHead">
            <div>
              <p>Stock Take</p>
              <h3>Quick Count</h3>
            </div>
            <button type="button" class="stockTakeOverlayClose" data-stocktake-overlay-close aria-label="Close">${icon('x')}</button>
          </header>
          <div class="stockTakeOverlayBody stockTakeOverlayBody--compact">
            ${siteOptions.length > 1 ? `
              <label class="stockTakeField">
                ${renderFieldHelpLabel('Location Group', 'Choose the location group for this quick count.')}
                ${renderOverlayDropdown({
                  id: 'stocktake-quick-site',
                  action: 'setup:siteId',
                  selectedValue: quickSiteId,
                  fallbackLabel: 'Select location group',
                  options: siteOptions,
                  openDropdown: filters.openDropdown
                })}
              </label>
            ` : ''}
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Location', 'Selling location whose live balances will be counted.')}
              ${renderOverlayDropdown({
                id: 'stocktake-quick-location',
                action: 'setup:locationId',
                selectedValue: sessionSetup.locationId || '',
                fallbackLabel: 'Select location',
                options: quickLocationOptions,
                openDropdown: filters.openDropdown
              })}
            </label>
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Count Date', 'Trade date for this quick count session.')}
              <input type="date" value="${escapeAttribute(sessionSetup.date || '')}" data-stocktake-quick-date />
            </label>
          </div>
          <footer class="stockTakeOverlayFooter stockTakeOverlayFooter--compact">
            <button type="button" class="stockTakeGhost" data-stocktake-overlay-close>Cancel</button>
            <button type="button" class="stockTakePrimary" data-stocktake-quick-start-confirm>Start Quick Count</button>
          </footer>
        </section>
      </div>
    `;
  }

  if (filters.overlay === 'bulk-scan-setup') {
    const bulkSiteId = sessionSetup.siteId || getSiteIdForStockLocation(sessionSetup.locationId, stockLocations) || siteOptions[0]?.value || '';
    const bulkLocationOptions = locationOptions.filter((location) => !bulkSiteId || String(location.siteId) === String(bulkSiteId));
    return `
      <div class="stockTakeOverlayBackdrop">
        <section class="stockTakeOverlayCard stockTakeOverlayCard--compact">
          <header class="stockTakeOverlayHead">
            <div>
              <p>Stock Take</p>
              <h3>Bulk Scan</h3>
            </div>
            <button type="button" class="stockTakeOverlayClose" data-stocktake-overlay-close aria-label="Close">${icon('x')}</button>
          </header>
          <div class="stockTakeOverlayBody stockTakeOverlayBody--compact">
            ${siteOptions.length > 1 ? `
              <label class="stockTakeField">
                ${renderFieldHelpLabel('Location Group', 'Choose the location group for this bulk scan count.')}
                ${renderOverlayDropdown({
                  id: 'stocktake-bulk-site',
                  action: 'setup:siteId',
                  selectedValue: bulkSiteId,
                  fallbackLabel: 'Select location group',
                  options: siteOptions,
                  openDropdown: filters.openDropdown
                })}
              </label>
            ` : ''}
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Location', 'Location whose live balances will be counted by scanned items.')}
              ${renderOverlayDropdown({
                id: 'stocktake-bulk-location',
                action: 'setup:locationId',
                selectedValue: sessionSetup.locationId || '',
                fallbackLabel: 'Select location',
                options: bulkLocationOptions,
                openDropdown: filters.openDropdown
              })}
            </label>
            <label class="stockTakeField">
              ${renderFieldHelpLabel('Count Date', 'Trade date for this bulk scan count session.')}
              <input type="date" value="${escapeAttribute(sessionSetup.date || '')}" data-stocktake-bulk-date />
            </label>
          </div>
          <footer class="stockTakeOverlayFooter stockTakeOverlayFooter--compact">
            <button type="button" class="stockTakeGhost" data-stocktake-overlay-close>Cancel</button>
            <button type="button" class="stockTakePrimary" data-stocktake-bulk-start-confirm>Open Scanner</button>
          </footer>
        </section>
      </div>
    `;
  }

  if (filters.overlay === 'bulk-scan') {
    return renderBulkScanOverlay(scanCount, sessionSetup);
  }

  if (filters.overlay === 'template-manager') {
    return `
      <div class="stockTakeOverlayBackdrop">
        <section class="stockTakeOverlayCard">
          <header class="stockTakeOverlayHead">
            <div>
              <p>Stock Take</p>
              <h3>Manage Templates</h3>
            </div>
            <button type="button" class="stockTakeOverlayClose" data-stocktake-overlay-close aria-label="Close">${icon('x')}</button>
          </header>
          <div class="stockTakeOverlayBody">
            <div class="stockTakeTemplateToolbar">
              <label class="stockTakeField stockTakeField--grow">
                ${renderFieldHelpLabel('Search', 'Filter saved stock take templates by name, location, or scope.')}
                <input type="search" value="${escapeAttribute(filters.templateListQuery || '')}" placeholder="Search templates..." data-stocktake-template-list-search />
              </label>
              <button type="button" class="stockTakePrimary stockTakePrimary--slim" data-stocktake-template-create>Create Template</button>
            </div>
            <div class="stockTakeTemplateList" data-scroll-key="stocktake-template-list">
              ${templateSummary.length ? templateSummary.map((template) => `
                <article class="stockTakeTemplateCard">
                  <div>
                    <strong>${escapeHtml(template.name)}</strong>
                    <span>${escapeHtml(template.locationName)} · ${escapeHtml(template.scopeLabel)}</span>
                  </div>
                  <div class="stockTakeTemplateActions">
                    <button type="button" class="stockTakeMiniButton stockTakeMiniButton--export" data-stocktake-template-export="${escapeAttribute(template.id)}" aria-label="Export template PDF">${icon('download')}</button>
                    <button type="button" class="stockTakeMiniButton stockTakeMiniButton--edit" data-stocktake-template-edit="${escapeAttribute(template.id)}">${icon('edit')}</button>
                    <button type="button" class="stockTakeMiniButton stockTakeMiniButton--danger" data-stocktake-template-delete="${escapeAttribute(template.id)}">${icon('trash')}</button>
                  </div>
                </article>
              `).join('') : '<div class="stockTakeEmptyState">No templates created yet.</div>'}
            </div>
          </div>
          <footer class="stockTakeOverlayFooter">
            <button type="button" class="stockTakeGhost" data-stocktake-overlay-close>Close</button>
          </footer>
        </section>
      </div>
    `;
  }

  if (filters.overlay === 'template-editor') {
    const templateSiteId = templateDraft.siteId || getSiteIdForTemplate(templateDraft, stockLocations) || siteOptions[0]?.value || '';
    const templateLocationOptions = locationOptions.filter((location) => !templateSiteId || String(location.siteId) === String(templateSiteId));
    const selectedTemplateLocations = new Set(getTemplateLocationIds(templateDraft));
    return `
      <div class="stockTakeOverlayBackdrop stockTakeOverlayBackdrop--drawer">
        <section class="stockTakeOverlayCard stockTakeOverlayCard--editor stockTakeOverlayCard--templateDrawer">
          <header class="stockTakeOverlayHead stockTakeOverlayHead--drawer">
            <div>
              <p>Template Builder</p>
              <h3>${templateDraft.id ? 'Edit Template' : 'New Template'}</h3>
            </div>
            <button type="button" class="stockTakeOverlayClose" data-stocktake-overlay-close aria-label="Close">${icon('x')}</button>
          </header>
          <div class="stockTakeOverlayBody stockTakeOverlayBody--editor">
            <div class="stockTakeTemplateDrawerLayout">
              <section class="stockTakeTemplateDrawerPanel">
                <div class="stockTakeTemplateDrawerStep">
                  <span>1</span>
                  <div>
                    <strong>Template Details</strong>
                    <small>Name it and choose where counts are allowed.</small>
                  </div>
                </div>
                <div class="stockTakeTemplateForm stockTakeTemplateForm--drawer">
                  <label class="stockTakeField">
                    ${renderFieldHelpLabel('Template Name', 'Name of the saved stock take template shown when starting future count sessions.')}
                    <input type="text" value="${escapeAttribute(templateDraft.name || '')}" placeholder="E.g. Monthly Bar Count" data-stocktake-template-name data-focus-key="stocktake-template-name" />
                  </label>
                  ${siteOptions.length > 1 ? `
                    <div class="stockTakeField">
                      ${renderFieldHelpLabel('Template Location Group', 'Choose the location group this stock take template belongs to.')}
                      ${renderOverlayDropdown({
                        id: 'stocktake-template-site',
                        action: 'template:siteId',
                        selectedValue: templateSiteId,
                        fallbackLabel: 'Select location group',
                        options: siteOptions,
                        openDropdown: filters.openDropdown
                      })}
                    </div>
                  ` : ''}
                  <div class="stockTakeField">
                    ${renderFieldHelpLabel('Locations', 'Choose selling locations where this recurring template can be used.')}
                    <div class="stockTakeLocationChecklist">
                      ${templateLocationOptions.map((location) => `
                        <label class="stockTakeLocationOption">
                          <input
                            type="checkbox"
                            data-stocktake-template-location="${escapeAttribute(location.value)}"
                            ${selectedTemplateLocations.has(String(location.value)) ? 'checked' : ''}
                          />
                          <span>${escapeHtml(location.label)}</span>
                        </label>
                      `).join('') || '<div class="stockTakeEmptyState">No locations available.</div>'}
                    </div>
                  </div>
                </div>
              </section>

              <section class="stockTakeTemplateDrawerPanel stockTakeTemplateDrawerPanel--scope">
                <div class="stockTakeTemplateDrawerStep">
                  <span>2</span>
                  <div>
                    <strong>Count Scope</strong>
                    <small>Choose categories or exact stock items for this template.</small>
                  </div>
                </div>

                <div class="stockTakeScopeSwitch">
                  <button type="button" class="stockTakeScopeButton ${templateDraft.scope === 'category' ? 'is-active' : ''}" data-stocktake-template-scope="category">Categories</button>
                  <button type="button" class="stockTakeScopeButton ${templateDraft.scope === 'items' ? 'is-active' : ''}" data-stocktake-template-scope="items">Specific Items</button>
                </div>

                <div class="stockTakeTemplateToolbar stockTakeTemplateToolbar--editor">
                  <label class="stockTakeField stockTakeField--grow">
                    ${renderFieldHelpLabel('Search', 'Search categories or items to include in this stock take template.')}
                    <input type="search" value="${escapeAttribute(filters.templateSelectionQuery || '')}" placeholder="${templateDraft.scope === 'items' ? 'Search products...' : 'Search categories...'}" data-stocktake-template-selection-search />
                  </label>
                  <div class="stockTakeInlineActions">
                    <button type="button" class="stockTakeGhost stockTakeGhost--small" data-stocktake-template-select-all>Select All</button>
                    <button type="button" class="stockTakeGhost stockTakeGhost--small" data-stocktake-template-clear-all>Clear</button>
                  </div>
                </div>

                <div class="stockTakeTemplateSelectionGrid" data-scroll-key="stocktake-template-selection-grid">
                  ${templateSelectionOptions.length ? templateSelectionOptions.map((option) => `
                    <label class="stockTakeTemplateSelection">
                      <input
                        type="checkbox"
                        data-stocktake-template-selection="${escapeAttribute(option.value)}"
                        ${option.selected ? 'checked' : ''}
                      />
                      <div>
                        <strong>${escapeHtml(option.label)}</strong>
                        ${option.caption ? `<span>${escapeHtml(option.caption)}</span>` : ''}
                      </div>
                    </label>
                  `).join('') : '<div class="stockTakeEmptyState">No matching options.</div>'}
                </div>
              </section>
            </div>
          </div>
          <footer class="stockTakeOverlayFooter stockTakeOverlayFooter--drawer">
            <button type="button" class="stockTakeGhost" data-stocktake-template-editor-back>Back</button>
            <button type="button" class="stockTakePrimary" data-stocktake-template-save>${templateDraft.id ? 'Update Template' : 'Save Template'}</button>
          </footer>
        </section>
      </div>
    `;
  }

  return '';
}

function renderScanCountOverlay(scanCount = createEmptyScanCountDraft()) {
  const matched = scanCount.matchedStockItemId
    ? {
        ...scanCount,
        item: null
      }
    : null;
  const matchedItemLabel = scanCount.itemName || '';
  return `
    <div class="stockTakeOverlayBackdrop stockTakeOverlayBackdrop--scan">
      <section class="stockTakeOverlayCard stockTakeOverlayCard--scan">
        <header class="stockTakeOverlayHead stockTakeOverlayHead--scan">
          <div>
            <h3>Scan &amp; Count</h3>
            <p>Scan a barcode, enter the counted quantity, repeat.</p>
          </div>
          <button type="button" class="stockTakeOverlayClose" data-stocktake-scan-count-done aria-label="Close">${icon('x')}</button>
        </header>

        <div class="stockTakeScanForm">
          <label class="stockTakeField">
            ${renderFieldHelpLabel('Barcode', 'Scan or type a barcode to match a stock item during scan and count.')}
            <div class="stockTakeScanBarcodeShell">
              <input
                type="text"
                value="${escapeAttribute(scanCount.barcode || '')}"
                placeholder="Scan / type barcode..."
                data-stocktake-scan-count-barcode
                data-focus-key="stocktake-scan-count-barcode"
                autocomplete="off"
              />
              <button type="button" class="stockTakeSearchAction stockTakeSearchAction--accent" data-stocktake-scan-camera-open aria-label="Open camera scan mode">
                ${icon('camera')}
              </button>
            </div>
          </label>

          ${scanCount.cameraOpen ? `
            <section class="stockTakeInlineCamera">
              <div class="stockTakeCameraViewport">
                <div id="stocktake-camera-reader" class="stockTakeCameraReader" data-stocktake-camera-reader></div>
                <div class="stockTakeCameraReticle" aria-hidden="true"></div>
              </div>
              <div class="stockTakeInlineCameraBar">
                <strong data-stocktake-camera-status>${escapeHtml(scanCount.cameraStatus || 'Point the camera at a barcode.')}</strong>
                <button type="button" class="stockTakeCameraClear" data-stocktake-scan-camera-close>Stop Camera</button>
              </div>
            </section>
          ` : ''}

          <div class="stockTakeScanCountGrid">
            <div class="stockTakeScanMatched">
              <label>Matched Item</label>
              <div class="stockTakeScanMatchedCard" data-stocktake-scan-match-card>
                ${scanCount.matchedStockItemId ? `
                  <strong>${escapeHtml(scanCount.itemName || 'Matched item')}</strong>
                  <span>${escapeHtml(getStockTakeScanUomSummary(scanCount))}</span>
                ` : '<span>No item matched yet.</span>'}
              </div>
            </div>
            <div class="stockTakeScanUom">
              <label>Count UOM</label>
              ${renderStockTakeScanUomSelect(scanCount)}
            </div>
            <div class="stockTakeScanQty">
              <label>Counted Qty</label>
              <input
                type="text"
                inputmode="decimal"
                value="${escapeAttribute(scanCount.quantity || '')}"
                placeholder="Enter quantity..."
                data-stocktake-scan-count-qty
                data-focus-key="stocktake-scan-count-qty"
              />
            </div>
          </div>

          <div class="stockTakeScanActions">
            <button type="button" class="stockTakePrimary" data-stocktake-scan-count-add>Add / Update</button>
            <button type="button" class="stockTakeGhost" data-stocktake-scan-count-done>Done</button>
          </div>
          <div class="stockTakeScanHint">Tip: if the item already has a shelf count, this will add to it.</div>
        </div>
      </section>
    </div>
  `;
}

function renderBulkScanOverlay(scanCount = createEmptyScanCountDraft(), sessionSetup = createEmptySessionSetup()) {
  const items = getLoadedStockTakeCameraItems(scanCount);
  const totalQty = items.reduce((sum, item) => sum + (Number(item.quantity || 0) || 0), 0);
  return `
    <div class="stockTakeOverlayBackdrop stockTakeOverlayBackdrop--scan">
      <section class="stockTakeOverlayCard stockTakeOverlayCard--bulkScan">
        <header class="stockTakeOverlayHead stockTakeOverlayHead--scan">
          <div>
            <h3>Bulk Scan</h3>
            <p>${escapeHtml(sessionSetup.locationName || 'Selected location')} · ${escapeHtml(formatDisplayDate(sessionSetup.date || ''))}</p>
          </div>
          <button type="button" class="stockTakeOverlayClose" data-stocktake-overlay-close aria-label="Close">${icon('x')}</button>
        </header>

        <div class="stockTakeBulkScanLayout">
          <section class="stockTakeInlineCamera stockTakeInlineCamera--bulk">
            <div class="stockTakeCameraViewport">
              ${scanCount.cameraOpen ? `
                <div id="stocktake-camera-reader" class="stockTakeCameraReader" data-stocktake-camera-reader></div>
                <div class="stockTakeCameraReticle" aria-hidden="true"></div>
              ` : `
                <div class="stockTakeCameraPaused">
                  ${icon('camera')}
                  <strong>Camera paused</strong>
                  <span>Restart the camera to continue scanning.</span>
                </div>
              `}
            </div>
            <div class="stockTakeInlineCameraBar">
              <strong data-stocktake-camera-status>${escapeHtml(scanCount.cameraStatus || 'Point the camera at a barcode.')}</strong>
              ${scanCount.cameraOpen
                ? '<span class="stockTakeCameraLive">Scanning</span>'
                : '<button type="button" class="stockTakeCameraClear stockTakeCameraClear--start" data-stocktake-scan-camera-open>Start Camera</button>'}
            </div>
          </section>

          <aside class="stockTakeBulkScanPanel">
            <div class="stockTakeBulkScanSummary">
              <div>
                <span>Loaded items</span>
                <strong data-stocktake-bulk-loaded>${formatNumber(items.length)}</strong>
              </div>
              <div>
                <span>Total counted qty</span>
                <strong data-stocktake-bulk-total>${formatNumber(totalQty)}</strong>
              </div>
            </div>
            <div class="stockTakeCameraList stockTakeCameraList--bulk" data-stocktake-camera-list>
              ${renderStockTakeCameraItemsMarkup(scanCount)}
            </div>
            <div class="stockTakeBulkScanActions">
              <button type="button" class="stockTakeGhost" data-stocktake-scan-camera-clear ${items.length ? '' : 'disabled'}>Clear All</button>
              <button type="button" class="stockTakePrimary" data-stocktake-bulk-finalise ${items.length ? '' : 'disabled'}>Finalise Scan</button>
            </div>
          </aside>
        </div>
      </section>
    </div>
  `;
}

function renderStockTakeCameraItemsMarkup(scanCount = createEmptyScanCountDraft()) {
  const items = getLoadedStockTakeCameraItems(scanCount);
  if (!items.length) {
    return `<div class="stockTakeEmptyState stockTakeEmptyState--camera" data-stocktake-camera-status>${escapeHtml(scanCount.cameraStatus || 'Point the camera at a barcode to begin.')}</div>`;
  }
  return items.map((item) => {
    const unit = String(item.unit || 'ea').toUpperCase();
    const uomCounts = getStockTakeCameraItemUomCounts(item);
    const totalQuantity = getStockTakeCameraItemBaseQuantity(item);
    return `
      <div class="stockTakeCameraItem stockTakeCameraItem--uom">
        <div class="stockTakeCameraItemMeta">
          <strong>${escapeHtml(item.stockItemName || '')}</strong>
          <span>${escapeHtml(`${uomCounts.length} UOM count${uomCounts.length === 1 ? '' : 's'}`)}</span>
        </div>
        <div class="stockTakeCameraUomRows">
          ${uomCounts.map((row) => {
            const controlKey = `${item.stockItemId}::uom::${row.key}`;
            return `
              <div class="stockTakeCameraUomRow">
                <span>${escapeHtml(row.uomName || unit)}</span>
                <strong>${escapeHtml(formatNumber(row.count || 0))}</strong>
                <em>${escapeHtml(`${formatNumber((Number(row.count || 0) || 0) * (Number(row.ratio || 1) || 1))} ${unit}`)}</em>
                <div class="stockTakeCameraItemControls">
                  <button type="button" data-stocktake-scan-camera-minus="${escapeAttribute(controlKey)}">-</button>
                  <button type="button" data-stocktake-scan-camera-plus="${escapeAttribute(controlKey)}">+</button>
                </div>
              </div>
            `;
          }).join('')}
          <div class="stockTakeCameraUomTotal">
            <span>Total ${escapeHtml(item.stockItemName || 'item')}</span>
            <strong>${escapeHtml(formatNumber(totalQuantity))} ${escapeHtml(unit)}</strong>
          </div>
        </div>
        <button type="button" class="stockTakeCameraRemove" data-stocktake-scan-camera-remove="${escapeAttribute(item.stockItemId)}" aria-label="Remove item">${icon('trash')}</button>
      </div>
    `;
  }).join('');
}

function getLoadedStockTakeCameraItems(scanCount = createEmptyScanCountDraft()) {
  return (scanCount.cameraItems || [])
    .map((item) => ({
      ...item,
      quantity: getStockTakeCameraItemBaseQuantity(item),
      uomCounts: getStockTakeCameraItemUomCounts(item)
    }))
    .filter((item) => Number(item.quantity || 0) > 0);
}

function getStockTakeCameraItemUomCounts(item = {}) {
  const rows = Array.isArray(item.uomCounts) && item.uomCounts.length
    ? item.uomCounts
    : [{
        key: `${String(item.selectedUom || item.unit || 'ea').toLowerCase()}::${Number(item.ratio || 1) || 1}`,
        uomName: item.selectedUom || item.unit || 'ea',
        baseUom: item.unit || 'ea',
        ratio: Number(item.ratio || 1) || 1,
        count: Number(item.scans || item.quantity || 0) || 0
      }];
  return rows
    .map((row) => ({
      ...row,
      key: String(row.key || `${String(row.uomName || 'ea').toLowerCase()}::${Number(row.ratio || 1) || 1}`),
      uomName: row.uomName || row.selectedUom || row.unit || 'ea',
      ratio: Number(row.ratio || 1) || 1,
      count: Number(row.count || 0) || 0
    }))
    .filter((row) => row.count > 0);
}

function getStockTakeCameraItemBaseQuantity(item = {}) {
  return getStockTakeCameraItemUomCounts(item)
    .reduce((sum, row) => sum + ((Number(row.count || 0) || 0) * (Number(row.ratio || 1) || 1)), 0);
}

function renderStockTakeScanUomSelect(scanCount = {}) {
  const options = getStockTakeScanUomOptions(scanCount);
  const selected = String(scanCount.selectedUom || scanCount.itemUnit || options[0]?.value || 'ea');
  return `
    <select data-stocktake-scan-count-uom ${scanCount.matchedStockItemId ? '' : 'disabled'}>
      ${options.map((option) => `
        <option value="${escapeAttribute(option.value)}" ${String(option.value) === selected ? 'selected' : ''}>
          ${escapeHtml(option.label)}
        </option>
      `).join('')}
    </select>
  `;
}

function getStockTakeScanUomOptions(scanCount = {}) {
  const baseUom = String(scanCount.itemUnit || scanCount.baseUom || 'ea').trim() || 'ea';
  const configs = normalizeScanUomConfigurations(scanCount.uomConfigurations || scanCount.uomConfig || scanCount.uomConversions);
  return [
    { value: baseUom, label: `${baseUom} base`, ratio: 1 },
    ...configs.map((config) => ({
      value: config.customUom,
      label: `${config.customUom} = ${formatRatio(config.ratio)} ${config.baseUom || baseUom}`,
      ratio: config.ratio
    }))
  ];
}

function getStockTakeScanUomSummary(scanCount = {}) {
  const selected = String(scanCount.selectedUom || scanCount.itemUnit || 'ea');
  const config = normalizeScanUomConfigurations(scanCount.uomConfigurations || scanCount.uomConfig || scanCount.uomConversions)
    .find((entry) => entry.customUom.toLowerCase() === selected.toLowerCase());
  return config
    ? `${config.customUom} = ${formatRatio(config.ratio)} ${config.baseUom || scanCount.itemUnit || 'ea'}`
    : `${scanCount.itemUnit || 'ea'} base`;
}

function normalizeScanUomConfigurations(value = []) {
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

function formatRatio(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

function renderOverlayDropdown({ id, action, selectedValue, fallbackLabel, options, openDropdown }) {
  const selected = options.find((option) => String(option.value) === String(selectedValue));
  const isOpen = openDropdown === id;
  return `
    <div class="stockTakeDropdown ${isOpen ? 'stockTakeDropdown--open' : ''}" data-stocktake-dropdown-root>
      <button type="button" data-stocktake-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(selected?.label || fallbackLabel)}</strong>
        ${icon('chevronDown')}
      </button>
      <div class="stockTakeDropdownMenu">
        <input type="search" class="stockTakeDropdownSearch" data-stocktake-dropdown-search placeholder="Search..." />
        <div class="stockTakeDropdownOptions">
          ${options.map((option) => `
            <button
              type="button"
              data-stocktake-option
              data-stocktake-option-action="${escapeAttribute(action)}"
              data-stocktake-option-value="${escapeAttribute(option.value)}"
              class="${String(option.value) === String(selectedValue) ? 'is-active' : ''}"
            >
              <span>${escapeHtml(option.label)}</span>
              ${option.meta ? `<small>${escapeHtml(option.meta)}</small>` : ''}
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderNotice(message, tone) {
  return `<div class="stockTakeNotice stockTakeNotice--${tone}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="stockTakeToast stockTakeToast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-stocktake-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function getVisibleStockTakeItems(items = [], draft = createEmptyDraft(), query = '') {
  const q = String(query || '').trim().toLowerCase();
  const scope = String(draft.templateScope || '').trim();
  const selectionSet = new Set((draft.templateSelections || []).map(String));

  return (items || []).filter(isPhysicalStockItem).filter((item) => {
    if (draft.sessionMode === 'template' && scope === 'category' && selectionSet.size && !selectionSet.has(String(item.category || '').trim())) {
      return false;
    }
    if (draft.sessionMode === 'template' && scope === 'items' && selectionSet.size && !selectionSet.has(String(item.id || '').trim())) {
      return false;
    }
    if (!q) return true;
    return (
      String(item.name || '').toLowerCase().includes(q)
      || String(item.category || '').toLowerCase().includes(q)
      || (item.barcodes || []).some((barcode) => String(barcode).toLowerCase().includes(q))
      || normalizeScanUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions)
        .some((config) => String(config.barcode || '').toLowerCase().includes(q))
    );
  });
}

function getTemplateSummary(templates = [], locations = [], query = '') {
  const q = String(query || '').trim().toLowerCase();
  return (templates || [])
    .filter((template) => !q || String(template.name || '').toLowerCase().includes(q))
    .map((template) => ({
      id: template.id,
      name: template.name,
      locationName: getTemplateLocationNames(template, locations),
      scopeLabel: template.scope === 'category'
        ? `${(template.selections || []).length} ${(template.selections || []).length === 1 ? 'Category' : 'Categories'}`
        : `${(template.selections || []).length} ${(template.selections || []).length === 1 ? 'Item' : 'Items'}`
    }));
}

function toStockTakeLocationOption(location = {}, sites = []) {
  const site = sites.find((entry) => String(entry.id) === String(location.siteId || ''));
  const siteName = location.siteName || site?.name || '';
  return {
    value: location.id,
    label: location.displayName || location.name || location.locationName || location.id,
    siteId: String(location.siteId || ''),
    siteName
  };
}

function getSiteIdForStockLocation(locationId = '', locations = []) {
  return String(locations.find((location) => String(location.id) === String(locationId))?.siteId || '');
}

function getSiteIdForTemplate(template = {}, locations = []) {
  if (template?.siteId) return String(template.siteId);
  const firstLocationId = getTemplateLocationIds(template)[0] || '';
  return getSiteIdForStockLocation(firstLocationId, locations);
}

function getTemplateLocationIds(template = {}) {
  if (!template) return [];
  const values = [
    template.targetLocation,
    ...(Array.isArray(template.targetLocations)
      ? template.targetLocations
      : (template.targetLocations && typeof template.targetLocations === 'object'
        ? Object.values(template.targetLocations)
        : []))
  ];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function getTemplateLocationNames(template = {}, locations = []) {
  const ids = getTemplateLocationIds(template);
  const names = ids.map((id) => locations.find((location) => String(location.id) === String(id))?.name || id).filter(Boolean);
  if (!names.length) return 'No locations';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function getTemplateSelectionOptions(stockItems = [], scope = 'category', query = '', selections = []) {
  const q = String(query || '').trim().toLowerCase();
  const selectedSet = new Set((selections || []).map(String));
  const physicalStockItems = (stockItems || []).filter(isStockCountableItem);
  if (scope === 'items') {
    return physicalStockItems
      .filter((item) => !q || String(item.name || '').toLowerCase().includes(q) || String(item.category || '').toLowerCase().includes(q))
      .map((item) => ({
        value: String(item.id || ''),
        label: item.name || '',
        caption: item.category || '',
        selected: selectedSet.has(String(item.id || ''))
      }));
  }

  return [...new Set(physicalStockItems.map((item) => String(item.category || '').trim()).filter(Boolean))]
    .filter((category) => !q || category.toLowerCase().includes(q))
    .sort((left, right) => left.localeCompare(right))
    .map((category) => ({
      value: category,
      label: category,
      caption: '',
      selected: selectedSet.has(category)
    }));
}

function isPhysicalStockItem(item = {}) {
  return isStockCountableItem(item);
}

function createEmptyDraft() {
  return {
    locationId: '',
    locationName: '',
    date: '',
    templateId: '',
    templateName: '',
    templateScope: '',
    templateSelections: [],
    sessionMode: 'quick',
    note: '',
    items: []
  };
}

function createEmptySessionSetup() {
  return {
    templateId: '',
    siteId: '',
    locationId: '',
    date: ''
  };
}

function createEmptyTemplateDraft() {
  return {
    id: '',
    name: '',
    siteId: '',
    targetLocation: '',
    targetLocations: [],
    scope: 'category',
    selections: []
  };
}

function createEmptyScanCountDraft() {
  return {
    barcode: '',
    matchedStockItemId: '',
    itemName: '',
    itemUnit: '',
    selectedUom: '',
    uomRatio: 1,
    uomConfigurations: [],
    quantity: '',
    cameraOpen: false,
    cameraStatus: 'Point the camera at a barcode.',
    cameraItems: []
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

function formatDisplayDate(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-ZA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
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
    clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6"/><path d="M9 2h6a2 2 0 0 1 2 2v2H7V4a2 2 0 0 1 2-2Z"/><path d="M7 6h10v13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2Z"/><path d="m9 13 2 2 4-4"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    scanPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M20 7V5a1 1 0 0 0-1-1h-2"/><path d="M4 17v2a1 1 0 0 0 1 1h2"/><path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>'
  };
  return icons[name] || icons.x;
}

function getUomConfigs(item = {}) {
  const value = item.uomConfigurations || item.uomConfig || item.uomConversions || [];
  const rows = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  return rows
    .map((entry = {}) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const ratio = Number(row.ratio ?? row.conversionRatio ?? row.unitsPerCustomUnit ?? row.units_per_custom_unit ?? 0);
      return {
        baseUom: String(row.baseUom || row.base_uom || row.baseUnit || row.unit || '').trim(),
        customUom: String(row.customUom || row.custom_uom || row.customUnit || row.orderingUom || '').trim(),
        ratio: Number.isFinite(ratio) ? ratio : 0
      };
    })
    .filter((entry) => entry.customUom && entry.ratio > 0);
}
