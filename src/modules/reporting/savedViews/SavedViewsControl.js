import { escapeHtml } from '../engine/formatters.js';
import { enhanceReportingSelects } from '../ui/customSelect.js';
import { closeReportActionMenu } from '../ui/reportActionMenu.js';
import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
  updateSavedView
} from '../scheduling/reportSchedulingApi.js';

export function renderSavedViewsControl({
  workspaceId = '',
  reportGroupId = '',
  reportId = '',
  viewId = '',
  getConfiguration,
  onLoad,
  canSavePersonal = true,
  canSaveWorkspace = false,
  initialActiveSavedViewId = '',
  onDefaultAvailable
} = {}) {
  const root = document.createElement('section');
  root.className = 'reportSavedViews reportSavedViews--actionPanel reportActionMenu__section';
  let views = [];
  let loading = true;
  let error = '';
  let activeSavedViewId = initialActiveSavedViewId;
  let defaultNotified = false;

  const relevantViews = () => views.filter((view) => {
    if (reportGroupId && view.reportGroupId === reportGroupId) return true;
    return view.reportId === reportId;
  });

  const draw = () => {
    const relevant = relevantViews();
    const mine = relevant.filter((view) => view.scope !== 'workspace');
    const workspaceViews = relevant.filter((view) => view.scope === 'workspace');
    const defaultView = relevant.find((view) => view.isDefault);
    const activeSavedView = relevant.find((view) => view.id === activeSavedViewId);

    root.innerHTML = `
      <header class="reportSavedViews__header">
        <div><span>Saved view</span><strong>${escapeHtml(activeSavedView?.name || defaultView?.name || 'Current configuration')}</strong></div>
        <div class="reportSavedViews__primaryActions">
          ${canSavePersonal && activeSavedView ? '<button type="button" data-saved-view-update>Update</button>' : ''}
          ${canSavePersonal ? '<button type="button" class="reportSavedViews__primary" data-saved-view-save>Save new</button>' : ''}
        </div>
      </header>
      <div class="reportSavedViews__list">
        ${loading ? '<p class="reportSavedViews__state">Loading saved views…</p>' : ''}
        ${error ? `<p class="reportSavedViews__state reportSavedViews__state--error">${escapeHtml(error)}</p>` : ''}
        ${!loading && !error ? renderGroup('My Saved Views', mine) : ''}
        ${!loading && !error ? renderGroup('Workspace Saved Views', workspaceViews) : ''}
        ${!loading && !error && !relevant.length ? '<p class="reportSavedViews__state">No saved views for this report yet.</p>' : ''}
      </div>
    `;
    bind();
  };

  const renderGroup = (title, items) => `
    <div class="reportSavedViews__group">
      <h4>${escapeHtml(title)}</h4>
      ${items.length ? items.map((item) => `
        <article class="reportSavedViews__item${item.id === activeSavedViewId ? ' is-active' : ''}" data-saved-view-id="${escapeHtml(item.id)}">
          <button type="button" class="reportSavedViews__load" data-saved-view-load="${escapeHtml(item.id)}">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${escapeHtml(item.viewLabel || item.viewId || '')}${item.isDefault ? ' · Default' : ''}</span>
          </button>
          <div class="reportSavedViews__itemActions">
            ${item.scope !== 'workspace' || canSaveWorkspace ? `<button type="button" title="Set as default" aria-label="Set as default" data-saved-view-default="${escapeHtml(item.id)}">★</button>` : ''}
            <button type="button" title="Duplicate" aria-label="Duplicate" data-saved-view-duplicate="${escapeHtml(item.id)}">⧉</button>
            ${item.scope !== 'workspace' || canSaveWorkspace ? `<button type="button" title="Rename" aria-label="Rename" data-saved-view-rename="${escapeHtml(item.id)}">✎</button><button type="button" title="Delete" aria-label="Delete" data-saved-view-delete="${escapeHtml(item.id)}">×</button>` : ''}
          </div>
        </article>
      `).join('') : '<p class="reportSavedViews__state">None</p>'}
    </div>
  `;

  const bind = () => {
    root.querySelector('[data-saved-view-save]')?.addEventListener('click', () => openSaveDialog());
    root.querySelector('[data-saved-view-update]')?.addEventListener('click', async () => {
      const selected = views.find((view) => view.id === activeSavedViewId);
      if (!selected) return;
      const config = getConfiguration?.() || {};
      await mutate(async () => updateSavedView(workspaceId, selected.id, {
        reportGroupId,
        reportId: config.reportId || reportId,
        viewId: config.viewId || viewId,
        filters: config.filters || {},
        sort: config.sort || null,
        visibleColumns: config.visibleColumns || [],
        dateRangeType: config.dateRangeType || config.filters?.dateRangeType || 'custom',
        locationId: config.filters?.locationId || ''
      }));
    });
    root.querySelectorAll('[data-saved-view-load]').forEach((button) => button.addEventListener('click', () => {
      const selected = views.find((view) => view.id === button.dataset.savedViewLoad);
      if (!selected) return;
      activeSavedViewId = selected.id;
      closeReportActionMenu(root);
      onLoad?.(selected);
    }));
    root.querySelectorAll('[data-saved-view-default]').forEach((button) => button.addEventListener('click', async () => {
      await mutate(async () => updateSavedView(workspaceId, button.dataset.savedViewDefault, { isDefault: true }));
    }));
    root.querySelectorAll('[data-saved-view-duplicate]').forEach((button) => button.addEventListener('click', async () => {
      const selected = views.find((view) => view.id === button.dataset.savedViewDuplicate);
      if (!selected) return;
      await mutate(async () => createSavedView(workspaceId, {
        ...serializeView(selected),
        name: `${selected.name} Copy`,
        isDefault: false,
        scope: selected.scope === 'workspace' && canSaveWorkspace ? 'workspace' : 'personal'
      }));
    }));
    root.querySelectorAll('[data-saved-view-rename]').forEach((button) => button.addEventListener('click', async () => {
      const selected = views.find((view) => view.id === button.dataset.savedViewRename);
      if (!selected) return;
      const name = window.prompt('Rename saved view', selected.name || '');
      if (!name?.trim()) return;
      await mutate(async () => updateSavedView(workspaceId, selected.id, { name: name.trim() }));
    }));
    root.querySelectorAll('[data-saved-view-delete]').forEach((button) => button.addEventListener('click', async () => {
      const selected = views.find((view) => view.id === button.dataset.savedViewDelete);
      if (!selected || !window.confirm(`Delete “${selected.name}”?`)) return;
      if (activeSavedViewId === selected.id) activeSavedViewId = '';
      await mutate(async () => deleteSavedView(workspaceId, selected.id));
    }));
  };

  const mutate = async (operation) => {
    error = '';
    try {
      await operation();
      await refresh();
    } catch (cause) {
      error = cause?.message || 'Could not update saved views.';
      draw();
    }
  };

  const openSaveDialog = () => {
    const config = getConfiguration?.() || {};
    const overlay = document.createElement('div');
    overlay.className = 'reportModalBackdrop';
    overlay.innerHTML = `
      <section class="reportModalCard" role="dialog" aria-modal="true" aria-labelledby="saved-view-dialog-title">
        <header>
          <div><span>Reporting</span><h3 id="saved-view-dialog-title">Save report view</h3></div>
          <button type="button" data-saved-view-close aria-label="Close">×</button>
        </header>
        <form data-saved-view-form>
          <label><span>Name</span><input name="name" required maxlength="100" placeholder="Weekly Wastage Review" /></label>
          <label><span>Description</span><textarea name="description" rows="3" maxlength="300" placeholder="Optional description"></textarea></label>
          ${canSaveWorkspace ? `
            <label><span>Visibility</span><select name="scope"><option value="personal">My saved view</option><option value="workspace">Workspace saved view</option></select></label>
          ` : '<input type="hidden" name="scope" value="personal" />'}
          <label class="reportModalCheck"><input type="checkbox" name="isDefault" /> <span>Set as default for this report</span></label>
          <div class="reportModalActions">
            <button type="button" data-saved-view-close>Cancel</button>
            <button type="submit" class="reportModalPrimary">Save view</button>
          </div>
        </form>
      </section>
    `;
    document.body.append(overlay);
    enhanceReportingSelects(overlay);
    const close = () => overlay.remove();
    overlay.querySelectorAll('[data-saved-view-close]').forEach((button) => button.addEventListener('click', close));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    overlay.querySelector('input[name="name"]')?.focus();
    overlay.querySelector('[data-saved-view-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const name = String(data.get('name') || '').trim();
      if (!name) return;
      const submit = event.currentTarget.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await createSavedView(workspaceId, {
          name,
          description: String(data.get('description') || '').trim(),
          scope: String(data.get('scope') || 'personal'),
          isDefault: data.get('isDefault') === 'on',
          reportGroupId,
          reportId: config.reportId || reportId,
          viewId: config.viewId || viewId,
          filters: config.filters || {},
          sort: config.sort || null,
          visibleColumns: config.visibleColumns || [],
          dateRangeType: config.dateRangeType || config.filters?.dateRangeType || 'custom',
          locationId: config.filters?.locationId || ''
        });
        close();
        await refresh();
      } catch (cause) {
        submit.disabled = false;
        event.currentTarget.querySelector('.reportModalError')?.remove();
        const message = document.createElement('p');
        message.className = 'reportModalError';
        message.textContent = cause?.message || 'Could not save this report view.';
        event.currentTarget.prepend(message);
      }
    });
  };

  const refresh = async () => {
    loading = true;
    error = '';
    draw();
    try {
      views = await listSavedViews(workspaceId);
      const relevantDefault = views.find((view) => view.isDefault && ((reportGroupId && view.reportGroupId === reportGroupId) || view.reportId === reportId));
      if (relevantDefault && !defaultNotified && typeof onDefaultAvailable === 'function') {
        defaultNotified = true;
        activeSavedViewId = relevantDefault.id;
        queueMicrotask(() => onDefaultAvailable(relevantDefault));
      }
    } catch (cause) {
      error = cause?.message || 'Could not load saved views.';
    } finally {
      loading = false;
      draw();
    }
  };

  draw();
  void refresh();
  return root;
}

function serializeView(view = {}) {
  return {
    description: view.description || '',
    reportGroupId: view.reportGroupId || '',
    reportId: view.reportId || '',
    viewId: view.viewId || '',
    filters: view.filters || {},
    sort: view.sort || null,
    visibleColumns: view.visibleColumns || [],
    dateRangeType: view.dateRangeType || 'custom',
    locationId: view.locationId || ''
  };
}
