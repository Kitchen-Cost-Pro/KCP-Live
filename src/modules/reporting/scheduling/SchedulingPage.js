import { escapeHtml } from '../engine/formatters.js';
import { bindReportTooltips } from '../tooltips/tooltipBuilder.js';
import { enhanceReportingSelects, refreshReportingSelect } from '../ui/customSelect.js';
import { REPORT_DATE_RANGE_PRESETS, inferDateRangeType } from './dateRangePresets.js';
import { formatViewLabel, getSchedulableReportCatalog, resolveCatalogReportSelection } from './reportCatalog.js';
import {
  createReportSchedule,
  deleteReportSchedule,
  listReportSchedules,
  listSavedViews,
  runReportScheduleNow,
  sendReportTestEmail,
  updateReportSchedule
} from './reportSchedulingApi.js';

const SCHEDULE_TEMPLATES = [
  {
    id: 'stock_controller',
    title: 'Stock Controller',
    description: 'Critical stock control and reorder pack.',
    values: {
      name: 'Weekly Stock Control Pack',
      reportItems: [
        { reportId: 'stock_control', viewId: 'location_summary' },
        { reportId: 'stock_control', viewId: 'reorder_detail' },
      ],
      frequency: 'weekly', scheduleDay: '1', scheduleTime: '07:00', dateRangeType: 'last_7_days',
      format: 'csv', sendCondition: 'only_if_low_stock', filters: { onlyBelowPar: 'true' }
    }
  },
  {
    id: 'operations_manager',
    title: 'Operations Manager',
    description: 'Wastage, adjustments and activity review.',
    values: {
      name: 'Weekly Operations Review',
      reportItems: [
        { reportId: 'wastage', viewId: 'line_detail' },
        { reportId: 'adjustments', viewId: 'line_detail' },
        { reportId: 'detailed_activity', viewId: 'ledger' }
      ],
      frequency: 'weekly', scheduleDay: '1', scheduleTime: '08:00', dateRangeType: 'last_7_days',
      format: 'csv', sendCondition: 'only_if_data', filters: {}
    }
  },
  {
    id: 'sales_manager',
    title: 'Sales Manager',
    description: 'Payment and stock movement views in one delivery.',
    values: {
      name: 'Weekly Sales Pack',
      reportItems: [
        { reportGroupId: 'sales_reports', reportId: 'payment_sales_financial', viewId: 'daily_summary' },
        { reportGroupId: 'sales_reports', reportId: 'payment_sales_financial', viewId: 'by_location' },
        { reportGroupId: 'sales_reports', reportId: 'sale_stock_movement', viewId: 'by_menu_item' }
      ],
      frequency: 'weekly', scheduleDay: '0', scheduleTime: '18:00', dateRangeType: 'this_week',
      format: 'csv', sendCondition: 'only_if_sales', filters: {}
    }
  },
  {
    id: 'general_manager',
    title: 'General Manager',
    description: 'Monthly dashboard, audit and stock control summary.',
    values: {
      name: 'Monthly Management Pack',
      reportItems: [
        { reportId: 'operations_dashboard', viewId: 'overview' },
        { reportId: 'inventory_audit', viewId: 'change_log' },
        { reportId: 'stock_control', viewId: 'location_summary' }
      ],
      frequency: 'monthly', scheduleDay: '1', scheduleTime: '09:00', dateRangeType: 'last_month',
      format: 'report_link', sendCondition: 'only_if_data', filters: {}
    }
  }
];

export function renderSchedulingPage({ workspaceId = '', state = {}, canManage = false, permissions = {} } = {}) {
  const root = document.createElement('section');
  root.className = 'reportSchedulingPage';
  const catalog = getSchedulableReportCatalog();
  let workspaceLocations = extractLocations(state);
  let workspaceUsers = extractWorkspaceUsers(state);
  let allowAllLocations = true;
  let schedulerVersion = '';
  const accessStatus = String(permissions.accessStatus || 'ready');
  const accessReady = accessStatus === 'ready';
  const accessFailed = accessStatus === 'error';
  const canView = accessReady && (permissions.canSchedule ?? canManage);
  const canCreate = canView && (permissions.canEmail ?? canManage);
  const canRun = canCreate;
  const canDelete = accessReady && (permissions.canDelete ?? canManage);
  let schedules = [];
  let savedViews = [];
  let loading = true;
  let error = '';
  let notice = '';
  let loadNotice = '';
  const schedulerReady = () => isSchedulerVersionCompatible(schedulerVersion);
  const schedulerUpgradeMessage = 'The Scheduling Worker is older than this page. Deploy cloudflare-v2 from Phase 33.19 first, then reload once.';

  const feedbackMarkup = () => `
    ${!accessReady && !accessFailed ? '<div class="reportSchedulingNotice">Loading your workspace role and scheduling permissions...</div>' : ''}
    ${accessFailed ? `<div class="reportSchedulingNotice reportSchedulingNotice--error">${escapeHtml(permissions.accessError || 'Workspace permissions could not be loaded. Reload once your connection is available.')}</div>` : ''}
    ${accessReady && !canView ? '<div class="reportSchedulingNotice reportSchedulingNotice--warning">You need the Schedule Reports permission to view recurring report emails.</div>' : ''}
    ${accessReady && canView && !canCreate ? '<div class="reportSchedulingNotice reportSchedulingNotice--warning">You also need the Email Reports permission to create, edit, test, or run report deliveries.</div>' : ''}
    ${accessReady && canCreate && !loading && !schedulerReady() ? `<div class="reportSchedulingNotice reportSchedulingNotice--error">${escapeHtml(schedulerUpgradeMessage)}</div>` : ''}
    ${notice ? `<div class="reportSchedulingNotice">${escapeHtml(notice)}</div>` : ''}
    ${loadNotice ? `<div class="reportSchedulingNotice reportSchedulingNotice--warning">${escapeHtml(loadNotice)}</div>` : ''}
    ${error ? `<div class="reportSchedulingNotice reportSchedulingNotice--error">${escapeHtml(error)}</div>` : ''}
  `;

  const scheduleListMarkup = () => loading
    ? '<div class="reportSchedulingEmpty">Loading schedules…</div>'
    : renderScheduleTable(schedules, catalog, { canEdit: canCreate && schedulerReady(), canRun: canRun && schedulerReady(), canDelete, locations: workspaceLocations });

  const bindStatic = () => {
    root.querySelector('[data-schedule-create]')?.addEventListener('click', () => openScheduleModal());
    root.querySelectorAll('[data-schedule-template]').forEach((button) => button.addEventListener('click', () => {
      const template = SCHEDULE_TEMPLATES.find((entry) => entry.id === button.dataset.scheduleTemplate);
      if (template) openScheduleModal(null, template.values);
    }));
  };

  const bindList = () => {
    root.querySelectorAll('[data-schedule-edit]').forEach((button) => button.addEventListener('click', () => {
      const schedule = schedules.find((entry) => entry.id === button.dataset.scheduleEdit);
      if (schedule) openScheduleModal(schedule);
    }));
    root.querySelectorAll('[data-schedule-duplicate]').forEach((button) => button.addEventListener('click', async () => {
      const schedule = schedules.find((entry) => entry.id === button.dataset.scheduleDuplicate);
      if (!schedule) return;
      await mutate(async () => {
        const result = await createReportSchedule(workspaceId, { ...toSchedulePayload(schedule, catalog), name: `${schedule.name} Copy`, isEnabled: false });
        upsertSchedule(result?.schedule);
        notice = 'Schedule duplicated.';
      });
    }));
    root.querySelectorAll('[data-schedule-delete]').forEach((button) => button.addEventListener('click', async () => {
      const schedule = schedules.find((entry) => entry.id === button.dataset.scheduleDelete);
      if (!schedule || !window.confirm(`Delete “${schedule.name}”?`)) return;
      await mutate(async () => {
        await deleteReportSchedule(workspaceId, schedule.id);
        schedules = schedules.filter((entry) => entry.id !== schedule.id);
        notice = 'Schedule deleted.';
      });
    }));
    root.querySelectorAll('[data-schedule-run]').forEach((button) => button.addEventListener('click', async () => {
      const schedule = schedules.find((entry) => entry.id === button.dataset.scheduleRun);
      if (!schedule) return;
      button.disabled = true;
      await mutate(async () => {
        // Persist a reference-free, current-catalog snapshot before execution. This repairs
        // schedules created by older Workers without depending on a saved view still existing.
        const repaired = await updateReportSchedule(workspaceId, schedule.id, toSchedulePayload(schedule, catalog));
        upsertSchedule(repaired?.schedule);
        const result = await runReportScheduleNow(workspaceId, schedule.id);
        const current = schedules.find((entry) => entry.id === schedule.id);
        if (current) upsertSchedule({ ...current, lastRunAt: new Date().toISOString(), nextRunAt: result.nextRunAt ?? current.nextRunAt });
        notice = result.sent === false
          ? (result.message || 'Schedule ran but its condition prevented sending.')
          : `Schedule ran successfully${result.filesGenerated ? ` · ${result.filesGenerated} file${result.filesGenerated === 1 ? '' : 's'}` : ''}.${result.warning ? ` ${result.warning}` : ''}`;
      });
    }));
    root.querySelectorAll('[data-schedule-enabled]').forEach((input) => input.addEventListener('change', async () => {
      const schedule = schedules.find((entry) => entry.id === input.dataset.scheduleEnabled);
      if (!schedule) return;
      await mutate(async () => {
        const result = await updateReportSchedule(workspaceId, schedule.id, { ...toSchedulePayload(schedule, catalog), isEnabled: input.checked });
        upsertSchedule(result?.schedule);
        notice = input.checked ? 'Schedule enabled.' : 'Schedule paused.';
      });
    }));
  };

  const updateDynamic = () => {
    const feedback = root.querySelector('[data-schedule-feedback]');
    if (feedback) feedback.innerHTML = feedbackMarkup();
    const count = root.querySelector('[data-schedule-count]');
    if (count) count.textContent = `${schedules.length} schedule${schedules.length === 1 ? '' : 's'}`;
    const list = root.querySelector('[data-schedule-list]');
    if (list) list.innerHTML = scheduleListMarkup();
    root.querySelector('[data-schedule-create]')?.toggleAttribute('disabled', loading || !canCreate || !schedulerReady());
    root.querySelectorAll('[data-schedule-template]').forEach((button) => {
      button.disabled = !canCreate || loading || !schedulerReady();
    });
    bindList();
  };

  const draw = () => {
    root.innerHTML = `
      <header class="reportSchedulingHero">
        <div>
          <span class="reportSchedulingHero__eyebrow">Reporting</span>
          <h1>Scheduling</h1>
          <p>Build one delivery containing multiple reports and views, then send it for all locations or one selected location.</p>
        </div>
        ${canCreate ? `<button type="button" class="reportSchedulingPrimary" data-schedule-create ${loading || !schedulerReady() ? 'disabled' : ''}>Create Schedule</button>` : ''}
      </header>
      <div data-schedule-feedback>${feedbackMarkup()}</div>
      <section class="reportSchedulingTemplates">
        <div class="reportSchedulingSectionHeader"><div><span>Quick start</span><h2>Schedule templates</h2><p>Start with a ready-made report pack, then adjust only what you need.</p></div></div>
        <div class="reportSchedulingTemplateGrid">
          ${SCHEDULE_TEMPLATES.map((template) => `
            <button type="button" class="reportSchedulingTemplate" data-schedule-template="${template.id}" ${canCreate && !loading && schedulerReady() ? '' : 'disabled'}>
              <span class="reportSchedulingTemplate__icon" aria-hidden="true">${templateIcon(template.id)}</span>
              <strong>${escapeHtml(template.title)}</strong>
              <small>${escapeHtml(template.description)}</small>
            </button>
          `).join('')}
        </div>
      </section>
      <section class="reportSchedulingListSection">
        <div class="reportSchedulingSectionHeader">
          <div><span>Workspace schedules</span><h2>Scheduled sends</h2><p>Review delivery timing, recipients and status for every saved schedule.</p></div>
          <span class="reportSchedulingCount" data-schedule-count>${schedules.length} schedule${schedules.length === 1 ? '' : 's'}</span>
        </div>
        <div data-schedule-list>${scheduleListMarkup()}</div>
      </section>
    `;
    bindStatic();
    bindList();
  };

  const upsertSchedule = (schedule) => {
    if (!schedule?.id) return;
    const index = schedules.findIndex((entry) => entry.id === schedule.id);
    if (index >= 0) schedules[index] = schedule;
    else schedules.push(schedule);
    schedules.sort((left, right) => {
      if (Boolean(left.isEnabled) !== Boolean(right.isEnabled)) return left.isEnabled ? -1 : 1;
      const leftNext = String(left.nextRunAt || '9999');
      const rightNext = String(right.nextRunAt || '9999');
      return leftNext.localeCompare(rightNext) || String(left.name || '').localeCompare(String(right.name || ''));
    });
  };

  const mutate = async (operation) => {
    error = '';
    notice = '';
    try {
      await operation();
      updateDynamic();
    } catch (cause) {
      error = cause?.message || 'Could not update report schedules.';
      updateDynamic();
    }
  };

  const refresh = async ({ showLoading = schedules.length === 0 } = {}) => {
    if (showLoading) {
      loading = true;
      updateDynamic();
    }
    try {
      const [scheduleResult, savedViewResult] = await Promise.all([
        listReportSchedules(workspaceId),
        listSavedViews(workspaceId).then((views) => ({ views, error: '' })).catch((cause) => ({ views: [], error: cause?.message || 'Saved views could not be loaded.' }))
      ]);
      schedules = Array.isArray(scheduleResult) ? scheduleResult : (scheduleResult.schedules || []);
      workspaceLocations = Array.isArray(scheduleResult)
        ? extractLocations(state)
        : mergeLocations(scheduleResult?.locations || []);
      workspaceUsers = Array.isArray(scheduleResult)
        ? extractWorkspaceUsers(state)
        : mergeWorkspaceUsers(scheduleResult?.users || [], extractWorkspaceUsers(state));
      allowAllLocations = scheduleResult?.allowAllLocations !== false;
      schedulerVersion = String(scheduleResult?.schedulerVersion || '');
      const normalizedSavedViews = normalizeSavedViews(savedViewResult.views, catalog);
      savedViews = normalizedSavedViews.views;
      const savedViewNotice = normalizedSavedViews.ignored
        ? `${normalizedSavedViews.ignored} obsolete saved view${normalizedSavedViews.ignored === 1 ? ' was' : 's were'} hidden because its report view no longer exists.`
        : '';
      loadNotice = [savedViewResult.error ? `${savedViewResult.error} You can still create a schedule without a saved view.` : '', savedViewNotice].filter(Boolean).join(' ');
      error = '';
    } catch (cause) {
      loadNotice = '';
      error = cause?.message || 'Could not load report schedules.';
    } finally {
      loading = false;
      updateDynamic();
    }
  };

  const openScheduleModal = (schedule = null, preset = null) => {
    if (!schedulerReady()) {
      error = schedulerUpgradeMessage;
      updateDynamic();
      return;
    }
    const values = normalizeFormValues(schedule ? toSchedulePayload(schedule, catalog) : (preset || {}), state, catalog, workspaceLocations, allowAllLocations, savedViews, workspaceUsers);
    const overlay = document.createElement('div');
    overlay.className = 'reportModalBackdrop reportScheduleModalBackdrop';
    overlay.innerHTML = renderScheduleModal(values, catalog, savedViews, Boolean(schedule));
    document.body.append(overlay);
    bindReportTooltips(overlay);
    const form = overlay.querySelector('[data-schedule-form]');
    const packPicker = form.querySelector('[data-schedule-pack-picker]');
    const close = () => overlay.remove();
    const openPackPicker = () => {
      if (!packPicker) return;
      packPicker.hidden = false;
      packPicker.querySelector('[data-schedule-pack-close]')?.focus();
    };
    const closePackPicker = () => {
      if (!packPicker) return;
      packPicker.hidden = true;
      form.querySelector('[data-schedule-pack-open]')?.focus();
    };
    overlay.querySelectorAll('[data-schedule-close]').forEach((button) => button.addEventListener('click', close));
    form.querySelector('[data-schedule-pack-open]')?.addEventListener('click', openPackPicker);
    form.querySelectorAll('[data-schedule-pack-close]').forEach((button) => button.addEventListener('click', closePackPicker));
    packPicker?.addEventListener('click', (event) => { if (event.target === packPicker) closePackPicker(); });
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (packPicker && !packPicker.hidden) closePackPicker();
      else close();
    });

    const syncDateRange = () => {
      const isCustom = form.querySelector('[name="dateRangeType"]')?.value === 'custom';
      form.querySelectorAll('[data-schedule-custom-date]').forEach((field) => { field.hidden = !isCustom; });
    };
    form.querySelector('[name="dateRangeType"]')?.addEventListener('change', syncDateRange);

    const syncCondition = () => {
      const needsThreshold = form.querySelector('[name="sendCondition"]')?.value === 'only_if_wastage_threshold';
      const field = form.querySelector('[data-schedule-threshold]');
      if (field) field.hidden = !needsThreshold;
    };
    form.querySelector('[name="sendCondition"]')?.addEventListener('change', syncCondition);

    const syncFrequency = () => {
      const frequency = form.querySelector('[name="frequency"]').value;
      const dayField = form.querySelector('[data-schedule-day-field]');
      const weekly = form.querySelector('[data-weekly-day]');
      const monthly = form.querySelector('[data-monthly-day]');
      dayField.hidden = frequency === 'daily';
      weekly.closest('[data-report-enhanced-select]')?.toggleAttribute('hidden', frequency !== 'weekly');
      monthly.closest('[data-report-enhanced-select]')?.toggleAttribute('hidden', frequency !== 'monthly');
      weekly.hidden = frequency !== 'weekly';
      monthly.hidden = frequency !== 'monthly';
    };
    form.querySelector('[name="frequency"]')?.addEventListener('change', syncFrequency);

    form.querySelectorAll('[data-schedule-report-toggle]').forEach((toggle) => toggle.addEventListener('change', () => {
      syncReportSelection(form, toggle.dataset.reportId || toggle.value, toggle.checked);
      updateBundleCount(form);
    }));

    form.querySelectorAll('[data-schedule-report-select-button]').forEach((button) => button.addEventListener('click', () => {
      const reportId = button.dataset.scheduleReportSelectButton || '';
      const toggle = [...form.querySelectorAll('[data-schedule-report-toggle]')].find((input) => input.dataset.reportId === reportId);
      if (!toggle) return;
      toggle.checked = !toggle.checked;
      syncReportSelection(form, reportId, toggle.checked);
      updateBundleCount(form);
    }));
    form.querySelectorAll('[data-schedule-report-open]').forEach((button) => button.addEventListener('click', () => {
      openReportViewPanel(form, button.dataset.scheduleReportOpen || '');
    }));
    form.querySelectorAll('[data-schedule-view-close]').forEach((button) => button.addEventListener('click', () => closeReportViewPanel(form)));
    form.querySelectorAll('[data-schedule-view-toggle]').forEach((toggle) => toggle.addEventListener('change', () => {
      syncViewSelection(form, toggle.dataset.reportId || '', toggle);
      syncSavedViewSelectState(form, toggle.dataset.reportId || '', toggle.dataset.viewId || '', toggle.checked);
      updateBundleCount(form);
    }));
    form.querySelectorAll('[data-schedule-item-saved-view]').forEach((select) => select.addEventListener('change', () => {
      const reportId = select.dataset.reportId || '';
      const viewId = select.dataset.viewId || '';
      if (select.value) selectReportItem(form, reportId, viewId, false);
      syncSavedViewSelectState(form, reportId, viewId, true);
      updateBundleCount(form);
    }));

    bindRecipientPicker(form);

    enhanceReportingSelects(overlay);
    syncDateRange();
    syncCondition();
    syncFrequency();
    updateBundleCount(form);

    form.querySelector('[data-schedule-test]')?.addEventListener('click', async (event) => {
      event.preventDefault();
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const payload = readScheduleForm(form, catalog, savedViews, values.reportItems);
        const result = await sendReportTestEmail(workspaceId, payload);
        showModalMessage(form, `Test email sent${result.filesGenerated ? ` with ${result.filesGenerated} file${result.filesGenerated === 1 ? '' : 's'}` : ''}.`, 'success');
      } catch (cause) {
        showModalMessage(form, cause?.message || 'Could not send the test email.', 'error');
      } finally {
        button.disabled = false;
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const payload = readScheduleForm(form, catalog, savedViews, values.reportItems);
        const result = schedule
          ? await updateReportSchedule(workspaceId, schedule.id, payload)
          : await createReportSchedule(workspaceId, payload);
        upsertSchedule(result?.schedule);
        close();
        notice = schedule ? 'Schedule updated.' : 'Schedule created.';
        error = '';
        updateDynamic();
      } catch (cause) {
        submit.disabled = false;
        showModalMessage(form, cause?.message || 'Could not save the schedule.', 'error');
      }
    });
  };

  if (!accessReady) loading = true;
  else if (!canView) loading = false;
  draw();
  if (accessReady && canView) void refresh({ showLoading: true });
  return root;
}

function renderScheduleTable(schedules, catalog, { canEdit = false, canRun = false, canDelete = false, locations = [] } = {}) {
  if (!schedules.length) return '<div class="reportSchedulingEmpty"><strong>No schedules yet</strong><span>Create a schedule or start from a template.</span></div>';
  return `
    <div class="reportSchedulingTableWrap">
      <table class="reportSchedulingTable">
        <thead><tr><th>Schedule</th><th>Report pack</th><th>Locations</th><th>Frequency</th><th>Next run</th><th>Recipients</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${schedules.map((schedule) => {
            const items = normalizeReportItems(schedule, catalog);
            const first = items[0];
            const report = catalog.find((entry) => entry.reportId === first?.reportId);
            const locationDisplay = formatScheduleLocations(schedule, locations);
            const reportCount = new Set(items.map((item) => item.reportId)).size;
            const viewCount = items.length;
            return `
              <tr>
                <td><strong>${escapeHtml(schedule.name)}</strong><span>${escapeHtml(schedule.formatLabel || formatOutputLabel(schedule.format))}</span></td>
                <td><strong>${escapeHtml(report?.fullTitle || first?.reportId || schedule.reportId)}</strong><span>${reportCount} report${reportCount === 1 ? '' : 's'} · ${viewCount} view${viewCount === 1 ? '' : 's'}</span></td>
                <td><strong>${escapeHtml(locationDisplay.summary)}</strong><span>${escapeHtml(locationDisplay.detail)}</span></td>
                <td>${escapeHtml(formatFrequency(schedule))}</td>
                <td>${escapeHtml(formatDateTime(schedule.nextRunAt, schedule.timezone))}<span>${schedule.lastRunAt ? `Last: ${escapeHtml(formatDateTime(schedule.lastRunAt, schedule.timezone))}` : 'Never run'}</span></td>
                <td>${escapeHtml((schedule.recipients || []).join(', '))}</td>
                <td><label class="reportScheduleToggle"><input type="checkbox" data-schedule-enabled="${escapeHtml(schedule.id)}" ${schedule.isEnabled ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /><span>${schedule.isEnabled ? 'Enabled' : 'Disabled'}</span></label></td>
                <td><div class="reportScheduleRowActions" role="group" aria-label="Actions for ${escapeHtml(schedule.name)}">
                  ${canRun ? renderScheduleActionButton('run', schedule.id, 'Run now') : ''}
                  ${canEdit ? `${renderScheduleActionButton('edit', schedule.id, 'Edit schedule')}${renderScheduleActionButton('duplicate', schedule.id, 'Duplicate schedule')}` : ''}
                  ${canDelete ? renderScheduleActionButton('delete', schedule.id, 'Delete schedule') : ''}
                </div></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderScheduleActionButton(action, scheduleId, label) {
  return `<button type="button" class="reportScheduleIconAction reportScheduleIconAction--${escapeHtml(action)}" data-schedule-${escapeHtml(action)}="${escapeHtml(scheduleId)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${scheduleActionIcon(action)}</button>`;
}

function scheduleActionIcon(action = '') {
  const icons = {
    run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L18.2 9.3l-3.5-3.5L4 16.5Zm16.7-9.7a1 1 0 0 0 0-1.4l-2.1-2.1a1 1 0 0 0-1.4 0l-1.6 1.6 3.5 3.5 1.6-1.6Z"/></svg>',
    duplicate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h11v11H8zM5 5h11v2H7v9H5z"/></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10l-.7 13H7.7L7 7Zm2-3h6l1 1h4v2H4V5h4l1-1Z"/></svg>'
  };
  return icons[action] || icons.edit;
}

function renderScheduleViewChoice(entry, view, checked, savedViews = [], selectedItem = {}) {
  const compatible = savedViews.filter((saved) => saved.isAvailable !== false && saved.reportId === entry.reportId && saved.viewId === view.value);
  const snapshotId = String(selectedItem.savedViewSnapshotId || selectedItem.savedViewId || '');
  const snapshotName = String(selectedItem.savedViewSnapshotName || '');
  const currentSavedView = compatible.find((saved) => saved.id === snapshotId);
  const missingSnapshot = snapshotId && !currentSavedView;
  return `
    <div class="reportScheduleViewChoice${checked ? ' is-selected' : ''}" data-schedule-view-choice data-report-id="${escapeHtml(entry.reportId)}" data-view-id="${escapeHtml(view.value)}">
      <label class="reportScheduleViewChoice__toggle">
        <input type="checkbox" data-schedule-view-toggle data-report-id="${escapeHtml(entry.reportId)}" data-report-group-id="${escapeHtml(entry.reportGroupId || '')}" data-view-id="${escapeHtml(view.value)}" ${checked ? 'checked' : ''} />
        <span><strong>${escapeHtml(view.label)}</strong><small>Include this view in the ${escapeHtml(entry.title)} attachment.</small></span>
      </label>
      <label class="reportScheduleViewChoice__saved">
        <span>Saved configuration</span>
        <select data-schedule-item-saved-view data-report-id="${escapeHtml(entry.reportId)}" data-view-id="${escapeHtml(view.value)}" ${checked ? '' : 'disabled'}>
          <option value="">Use report defaults</option>
          ${missingSnapshot ? `<option value="__snapshot__:${escapeHtml(snapshotId)}" selected>Snapshot: ${escapeHtml(snapshotName || 'Saved view')} (source removed)</option>` : ''}
          ${compatible.map((saved) => `<option value="${escapeHtml(saved.id)}" ${saved.id === snapshotId ? 'selected' : ''}>${escapeHtml(saved.name)}${saved.scope === 'workspace' ? ' · Workspace' : ' · Mine'}</option>`).join('')}
        </select>
        <small>${snapshotId ? `This schedule uses ${escapeHtml(currentSavedView?.name || snapshotName || 'the saved view')} at send time and keeps a fallback copy.` : 'Choose a saved view to apply its filters, sorting and columns.'}</small>
      </label>
    </div>
  `;
}

export function syncSavedViewSelectState(form, reportId, viewId, enabled) {
  const select = [...form.querySelectorAll('[data-schedule-item-saved-view]')]
    .find((entry) => entry.dataset.reportId === reportId && entry.dataset.viewId === viewId);
  if (!select) return;
  const wasDisabled = select.disabled;
  select.disabled = !enabled;
  if (!enabled) select.value = '';
  // The enhanced (visible) control mirrors the native select, so it must be re-synced on BOTH
  // branches of an actual transition. Refreshing only on the disable branch left the visible button
  // permanently disabled after a view was re-enabled. Refreshing unconditionally is just as wrong:
  // this function also runs on the saved-view select's own change handler, and rebuilding the
  // button there would drop keyboard focus to <body> on every selection.
  if (wasDisabled !== select.disabled) refreshReportingSelect(select);
  select.closest('[data-schedule-view-choice]')?.classList.toggle('is-selected', Boolean(enabled));
}

export function renderScheduleModal(values, catalog, savedViews, editing) {
  const selectedViewsByReport = new Map();
  const selectedItemsByKey = new Map();
  for (const item of values.reportItems || []) {
    if (!selectedViewsByReport.has(item.reportId)) selectedViewsByReport.set(item.reportId, new Set());
    selectedViewsByReport.get(item.reportId).add(item.viewId);
    selectedItemsByKey.set(`${item.reportId}::${item.viewId}`, item);
  }
  const activeReports = new Set(selectedViewsByReport.keys());
  return `
    <section class="reportModalCard reportScheduleModal" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title">
      <header>
        <div><span>Reporting · Scheduling</span><h3 id="schedule-dialog-title">${editing ? 'Edit schedule' : 'Create schedule'}</h3><p>Configure the report pack, delivery timing and recipients.</p></div>
        <button type="button" data-schedule-close aria-label="Close">×</button>
      </header>
      <form data-schedule-form>
        <input type="hidden" name="filtersJson" value="${escapeHtml(JSON.stringify(values.filters || {}))}" />
        <div data-schedule-modal-message></div>

        <div class="reportScheduleFormStack">
          <section class="reportScheduleFormSection">
            <header class="reportScheduleFormSection__header">
              <span class="reportScheduleFormSection__step">1</span>
              <div><span>Schedule details</span><strong>Name this scheduled delivery</strong></div>
            </header>
            <div class="reportScheduleSectionGrid reportScheduleSectionGrid--single">
              <label><span>Schedule name</span><input name="name" value="${escapeHtml(values.name)}" required maxlength="120" placeholder="Weekly Management Report Pack" /></label>
              <input type="hidden" name="savedViewId" value="" />
            </div>
          </section>

          <section class="reportScheduleFormSection reportScheduleFormSection--pack">
            <header class="reportScheduleFormSection__header">
              <span class="reportScheduleFormSection__step">2</span>
              <div><span>Report pack</span><strong>Choose reports first, then choose views for each report</strong></div>
            </header>
            <div class="reportSchedulePackSummary">
              <div class="reportSchedulePackSummary__copy">
                <span class="reportSchedulePackSummary__count" data-schedule-bundle-count></span>
                <div class="reportSchedulePackSummary__items" data-schedule-pack-summary></div>
              </div>
              <button type="button" class="reportSchedulePackButton" data-schedule-pack-open>
                <span>Select reports</span><span aria-hidden="true">→</span>
              </button>
            </div>

            <div class="reportSchedulePickerBackdrop" data-schedule-pack-picker hidden>
              <section class="reportSchedulePicker" role="dialog" aria-modal="true" aria-labelledby="schedule-pack-picker-title">
                <header>
                  <div><span>Report pack</span><h4 id="schedule-pack-picker-title">Build the report pack</h4><p>Select reports, review the pack, then choose one or more views within each report.</p></div>
                  <button type="button" data-schedule-pack-close aria-label="Close report selector">×</button>
                </header>
                <div class="reportSchedulePicker__body">
                  <ol class="reportSchedulePickerSteps" aria-label="Report pack selection steps">
                    <li><span>1</span><strong>Select reports</strong></li>
                    <li><span>2</span><strong>Reports in pack</strong></li>
                    <li><span>3</span><strong>Select views</strong></li>
                  </ol>
                  <section class="reportScheduleBundle">
                    <div class="reportScheduleReportGrid">
                      ${catalog.map((entry) => {
                        const selectedViews = selectedViewsByReport.get(entry.reportId) || new Set();
                        const reportSelected = activeReports.has(entry.reportId);
                        const defaultView = entry.defaultView || entry.views[0]?.value || '';
                        return `
                          <article class="reportScheduleReportCard${reportSelected ? ' is-selected' : ''}" data-schedule-report-card data-report-id="${escapeHtml(entry.reportId)}">
                            <input
                              type="checkbox"
                              class="reportScheduleReportCard__toggle"
                              data-schedule-report-toggle
                              data-report-id="${escapeHtml(entry.reportId)}"
                              data-report-group-id="${escapeHtml(entry.reportGroupId || '')}"
                              data-default-view="${escapeHtml(defaultView)}"
                              value="${escapeHtml(entry.reportId)}"
                              ${reportSelected ? 'checked' : ''}
                            />
                            <button type="button" class="reportScheduleReportCard__open" data-schedule-report-open="${escapeHtml(entry.reportId)}" data-report-tooltip="${escapeHtml(entry.tooltip || entry.description || '')}" aria-label="Open views for ${escapeHtml(entry.title)}">
                              <span><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.reportGroupTitle || 'Report')}</small></span>
                              <span class="reportScheduleReportCard__arrow" aria-hidden="true">→</span>
                            </button>
                            <p>${escapeHtml(entry.description || 'Open this report to choose the views included in the pack.')}</p>
                            <div class="reportScheduleReportCard__selectedViews" data-schedule-selected-views="${escapeHtml(entry.reportId)}">
                              ${renderSelectedViewChips(entry, selectedViews)}
                            </div>
                            <button type="button" class="reportScheduleReportCard__select" data-schedule-report-select-button="${escapeHtml(entry.reportId)}">${reportSelected ? 'Remove from pack' : 'Select report'}</button>
                          </article>
                        `;
                      }).join('')}
                    </div>
                  </section>
                  ${catalog.map((entry) => {
                    const selectedViews = selectedViewsByReport.get(entry.reportId) || new Set();
                    const defaultView = entry.defaultView || entry.views[0]?.value || '';
                    return `
                      <section class="reportScheduleViewPanel" data-schedule-view-panel="${escapeHtml(entry.reportId)}" hidden>
                        <header>
                          <button type="button" class="reportScheduleViewPanel__back" data-schedule-view-close aria-label="Back to report list">←</button>
                          <div><span>Choose views</span><h5>${escapeHtml(entry.title)}</h5><p>${escapeHtml(entry.description || 'Select one or more views for this report.')}</p></div>
                        </header>
                        <div class="reportScheduleViewPanel__list">
                          ${entry.views.map((view) => {
                            const checked = selectedViews.has(view.value) || (!selectedViews.size && view.value === defaultView && activeReports.has(entry.reportId));
                            return renderScheduleViewChoice(entry, view, checked, savedViews, selectedItemsByKey.get(`${entry.reportId}::${view.value}`) || {});
                          }).join('')}
                        </div>
                        <footer><span data-schedule-view-count="${escapeHtml(entry.reportId)}"></span><button type="button" class="reportModalPrimary" data-schedule-view-close>Save views</button></footer>
                      </section>
                    `;
                  }).join('')}
                </div>
                <footer>
                  <span data-schedule-bundle-count></span>
                  <button type="button" class="reportModalPrimary" data-schedule-pack-close>Done</button>
                </footer>
              </section>
            </div>
          </section>

          <section class="reportScheduleFormSection">
            <header class="reportScheduleFormSection__header">
              <span class="reportScheduleFormSection__step">3</span>
              <div><span>Report scope</span><strong>Select the reporting period and location</strong></div>
            </header>
            <div class="reportScheduleSectionGrid">
              <label><span>Date range</span><select name="dateRangeType">${REPORT_DATE_RANGE_PRESETS.map((preset) => `<option value="${preset.value}" ${values.dateRangeType === preset.value ? 'selected' : ''}>${preset.label}</option>`).join('')}</select></label>
              <label><span>Location</span><select name="locationSelection" ${!values.allowAllLocations && !values.locations.length && !values.unresolvedLocationSelection ? 'disabled' : ''}>${!values.locationSelection && (values.locations.length || values.allowAllLocations) ? '<option value="" selected>Select a location…</option>' : ''}${values.allowAllLocations ? `<option value="all" ${values.locationSelection === 'all' ? 'selected' : ''}>All Locations</option>` : ''}${values.unresolvedLocationSelection ? `<option value="${escapeHtml(values.unresolvedLocationSelection)}" selected>${values.unresolvedLocationSelection === 'all' ? 'All Locations (current setting)' : `Current location (${escapeHtml(values.unresolvedLocationSelection)}) — not in your locations`}</option>` : ''}${values.locations.map((location) => `<option value="${escapeHtml(location.id)}" ${values.locationSelection === location.id ? 'selected' : ''}>${escapeHtml(location.name)}</option>`).join('')}${!values.allowAllLocations && !values.locations.length && !values.unresolvedLocationSelection ? '<option value="">No assigned locations</option>' : ''}</select></label>
              <label data-schedule-custom-date><span>From</span><input type="date" name="customFrom" value="${escapeHtml(values.customFrom)}" data-initial-value="${escapeHtml(values.customFrom)}" /></label>
              <label data-schedule-custom-date><span>To</span><input type="date" name="customTo" value="${escapeHtml(values.customTo)}" data-initial-value="${escapeHtml(values.customTo)}" /></label>
              <input type="hidden" name="initialDateRangeType" value="${escapeHtml(values.dateRangeType)}" />
              <p class="reportScheduleLocationNote reportScheduleFull">Choose All Locations to generate a separate output for every active location, or choose one individual location to limit the complete pack to that site.</p>
            </div>
          </section>

          <section class="reportScheduleFormSection">
            <header class="reportScheduleFormSection__header">
              <span class="reportScheduleFormSection__step">4</span>
              <div><span>Timing</span><strong>Choose when the schedule should run</strong></div>
            </header>
            <div class="reportScheduleSectionGrid reportScheduleSectionGrid--four">
              <label><span>Frequency</span><select name="frequency"><option value="daily" ${values.frequency === 'daily' ? 'selected' : ''}>Daily</option><option value="weekly" ${values.frequency === 'weekly' ? 'selected' : ''}>Weekly</option><option value="monthly" ${values.frequency === 'monthly' ? 'selected' : ''}>Monthly</option></select></label>
              <label data-schedule-day-field><span>Day</span><select name="weeklyDay" data-weekly-day>${weekDayOptions(values.scheduleDay)}</select><select name="monthlyDay" data-monthly-day>${monthDayOptions(values.scheduleDay)}</select></label>
              <label><span>Time</span><input type="time" name="scheduleTime" value="${escapeHtml(values.scheduleTime)}" required /></label>
              <label><span>Timezone</span><input name="timezone" value="${escapeHtml(values.timezone)}" required /></label>
            </div>
          </section>

          <section class="reportScheduleFormSection">
            <header class="reportScheduleFormSection__header">
              <span class="reportScheduleFormSection__step">5</span>
              <div><span>Delivery</span><strong>Set the format and recipients</strong></div>
            </header>
            <div class="reportScheduleSectionGrid">
              <label><span>Export format</span><select name="format"><option value="csv" ${values.format === 'csv' ? 'selected' : ''}>CSV attachments</option><option value="xlsx" ${values.format === 'xlsx' ? 'selected' : ''}>XLSX attachments</option><option value="pdf" ${values.format === 'pdf' ? 'selected' : ''}>PDF attachments</option><option value="report_link" ${values.format === 'report_link' ? 'selected' : ''}>Report links only</option></select></label>
              <label><span>Send condition</span><select name="sendCondition">${conditionOptions(values.sendCondition)}</select></label>
              <label data-schedule-threshold><span>Wastage threshold (R)</span><input type="number" min="0" step="0.01" name="wastageThreshold" value="${escapeHtml(String(values.wastageThreshold || ''))}" /></label>
              <div class="reportScheduleFull reportScheduleRecipientField">
                <span class="reportScheduleRecipientField__label">Recipients</span>
                <div class="reportScheduleRecipientPicker" data-schedule-recipient-picker>
                  <input type="hidden" name="recipients" value="${escapeHtml(values.recipients.join(', '))}" />
                  <div class="reportScheduleRecipientChips" data-schedule-recipient-chips>${renderRecipientChips(values.recipients)}</div>
                  <div class="reportScheduleRecipientControls">
                    <label><span>Existing workspace user</span><select data-schedule-recipient-select><option value="">Select a user to add</option>${values.users.map((user) => `<option value="${escapeHtml(user.email)}">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</option>`).join('')}</select></label>
                    <label><span>Other email</span><span class="reportScheduleRecipientAdd"><input type="email" data-schedule-recipient-input placeholder="external@example.com" /><button type="button" data-schedule-recipient-add>Add</button></span></label>
                  </div>
                </div>
              </div>
              <label class="reportModalCheck reportScheduleFull"><input type="checkbox" name="isEnabled" ${values.isEnabled ? 'checked' : ''} /> <span>Enable this schedule</span></label>
            </div>
          </section>
        </div>

        <div class="reportModalActions reportScheduleModalActions"><button type="button" data-schedule-close>Cancel</button><button type="button" data-schedule-test>Send test email</button><button type="submit" class="reportModalPrimary">${editing ? 'Save changes' : 'Create schedule'}</button></div>
      </form>
    </section>
  `;
}

function renderSelectedViewChips(entry = {}, selectedViews = new Set()) {
  const views = entry.views.filter((view) => selectedViews.has(view.value));
  if (!views.length) return '<span class="reportScheduleReportCard__noViews">No views selected</span>';
  return views.map((view) => `<span>${escapeHtml(view.label)}</span>`).join('');
}

function renderRecipientChips(recipients = []) {
  if (!recipients.length) return '<span class="reportScheduleRecipientChips__empty">No recipients selected</span>';
  return recipients.map((email) => `<span class="reportScheduleRecipientChip"><span>${escapeHtml(email)}</span><button type="button" data-schedule-recipient-remove="${escapeHtml(email)}" aria-label="Remove ${escapeHtml(email)}">×</button></span>`).join('');
}

export function readScheduleForm(form, catalog, savedViews = [], existingReportItems = []) {
  const data = new FormData(form);
  const frequency = String(data.get('frequency') || 'weekly');
  const reportItems = [];
  const seen = new Set();

  [...form.querySelectorAll('[data-schedule-report-toggle]:checked')].forEach((reportToggle) => {
    const reportId = String(reportToggle.dataset.reportId || reportToggle.value || '');
    const reportGroupId = String(reportToggle.dataset.reportGroupId || '');
    const selectedViews = [...form.querySelectorAll(`[data-schedule-view-toggle][data-report-id="${cssEscape(reportId)}"]:checked`)]
      .map((input) => String(input.dataset.viewId || ''))
      .filter(Boolean);
    const viewIds = selectedViews.length
      ? selectedViews
      : [String(reportToggle.dataset.defaultView || '')].filter(Boolean);

    viewIds.forEach((viewId) => {
      const resolved = resolveCatalogReportSelection(catalog, reportId, viewId);
      if (!resolved) return;
      const key = `${resolved.reportId}::${resolved.viewId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const existing = existingReportItems.find((item) => item.reportId === resolved.reportId && item.viewId === resolved.viewId) || {};
      reportItems.push({
        reportGroupId: reportGroupId || resolved.reportGroupId || '',
        reportId: resolved.reportId,
        viewId: resolved.viewId,
        savedViewId: '',
        savedViewSnapshotId: String(existing.savedViewSnapshotId || ''),
        savedViewSnapshotName: String(existing.savedViewSnapshotName || ''),
        savedViewUpdatedAt: String(existing.savedViewUpdatedAt || ''),
        dateRangeType: String(existing.dateRangeType || existing.filters?.dateRangeType || ''),
        filters: existing.filters && typeof existing.filters === 'object' ? { ...existing.filters } : {},
        sort: existing.sort && typeof existing.sort === 'object' ? { ...existing.sort } : null,
        visibleColumns: Array.isArray(existing.visibleColumns) ? [...existing.visibleColumns] : []
      });
    });
  });

  for (const item of reportItems) {
    const select = [...form.querySelectorAll('[data-schedule-item-saved-view]')]
      .find((entry) => entry.dataset.reportId === item.reportId && entry.dataset.viewId === item.viewId);
    if (!select) continue;
    const selectedValue = String(select.value || '');
    if (!selectedValue) {
      item.savedViewId = '';
      item.savedViewSnapshotId = '';
      item.savedViewSnapshotName = '';
      item.savedViewUpdatedAt = '';
      item.dateRangeType = '';
      item.filters = {};
      item.sort = null;
      item.visibleColumns = [];
      continue;
    }
    if (selectedValue.startsWith('__snapshot__:')) continue;
    const selected = savedViews.find((view) => view.id === selectedValue && view.reportId === item.reportId && view.viewId === item.viewId);
    if (!selected) continue;
    item.savedViewId = selected.id;
    item.savedViewSnapshotId = selected.id;
    item.savedViewSnapshotName = selected.name || '';
    item.savedViewUpdatedAt = selected.updatedAt || '';
    item.dateRangeType = selected.dateRangeType || inferDateRangeType(selected.filters || {});
    item.filters = selected.filters && typeof selected.filters === 'object' ? { ...selected.filters } : {};
    item.sort = selected.sort && typeof selected.sort === 'object' ? { ...selected.sort } : null;
    item.visibleColumns = Array.isArray(selected.visibleColumns) ? [...selected.visibleColumns] : [];
  }

  if (!reportItems.length) throw new Error('Select at least one current report and one view for this schedule.');

  const recipients = uniqueEmails(String(data.get('recipients') || '').split(/[;,\n]/));
  if (!recipients.length) throw new Error('Add at least one recipient.');

  const locationSelection = String(data.get('locationSelection') || '').trim();
  if (!locationSelection) throw new Error('Select a location for this schedule.');
  const locationMode = locationSelection === 'all' ? 'all' : 'selected';
  const locationIds = locationMode === 'selected' ? [locationSelection] : [];

  let baseFilters = {};
  try { baseFilters = JSON.parse(String(data.get('filtersJson') || '{}')); } catch { baseFilters = {}; }
  delete baseFilters.locationId;
  delete baseFilters.locationName;
  delete baseFilters.locationIds;
  delete baseFilters.locations;
  delete baseFilters.location_id;
  delete baseFilters.location_ids;
  const dateRangeType = String(data.get('dateRangeType') || 'today');
  const customFrom = String(data.get('customFrom') || '');
  const customTo = String(data.get('customTo') || '');
  const filters = { ...baseFilters };
  if (dateRangeType === 'custom' && customFrom && customTo) {
    filters.from = customFrom;
    filters.to = customTo;
    filters.startDate = customFrom;
    filters.endDate = customTo;
  } else if (dateRangeType === 'custom') {
    // Only demand both dates when the user is actually working on the range in this edit. A legacy
    // schedule stored with half a custom range used to save fine (the incomplete range was dropped);
    // hard-gating every save on it blocked unrelated edits such as changing recipients.
    const initialDateRangeType = String(data.get('initialDateRangeType') || '');
    const dateFieldsTouched = [...form.querySelectorAll('[data-schedule-custom-date] input')]
      .some((input) => String(input.value || '') !== String(input.dataset.initialValue || ''));
    if (!initialDateRangeType || dateFieldsTouched || dateRangeType !== initialDateRangeType) {
      throw new Error('Select both custom dates.');
    }
    delete filters.from;
    delete filters.to;
    delete filters.startDate;
    delete filters.endDate;
  } else {
    delete filters.from;
    delete filters.to;
    delete filters.startDate;
    delete filters.endDate;
  }
  const first = reportItems[0];
  const firstCatalog = catalog.find((entry) => entry.reportId === first.reportId);
  return {
    name: String(data.get('name') || '').trim(),
    reportGroupId: first.reportGroupId || firstCatalog?.reportGroupId || '',
    reportId: first.reportId,
    viewId: first.viewId,
    reportItems,
    savedViewId: '',
    filters,
    dateRangeType,
    locationMode,
    locationIds: locationMode === 'all' ? [] : locationIds,
    locationId: locationMode === 'selected' && locationIds.length === 1 ? locationIds[0] : '',
    scheduleFrequency: frequency,
    scheduleDay: frequency === 'weekly' ? Number(data.get('weeklyDay') || 1) : frequency === 'monthly' ? Number(data.get('monthlyDay') || 1) : null,
    scheduleTime: String(data.get('scheduleTime') || '08:00'),
    timezone: String(data.get('timezone') || 'Africa/Johannesburg'),
    format: String(data.get('format') || 'report_link'),
    recipients,
    emailSubject: '',
    emailMessage: '',
    sendCondition: { type: String(data.get('sendCondition') || 'always'), threshold: Number(data.get('wastageThreshold') || 0) || 0 },
    isEnabled: data.get('isEnabled') === 'on'
  };
}

export function normalizeFormValues(values = {}, state = {}, catalog = [], availableLocations = null, allowAllLocations = true, savedViews = [], workspaceUsers = []) {
  const settings = state.settings?.values || state.settings?.draft || {};
  // Once the Worker supplies a location list, it is the permission-filtered source of truth.
  // Do not merge broader app state back into it for location-restricted users.
  const locations = Array.isArray(availableLocations)
    ? mergeLocations(availableLocations)
    : extractLocations(state);
  const reportItems = normalizeReportItems(values, catalog).map((item) => restoreSavedViewSnapshot(item, savedViews));
  const locationIds = Array.isArray(values.locationIds) ? values.locationIds.map(String).filter(Boolean) : values.locationId ? [String(values.locationId)] : [];
  const requestedMode = values.locationMode || (locationIds.length ? 'selected' : 'all');
  // A schedule that already targets a location (or all locations) must keep targeting it. Falling
  // back to locations[0] silently redirected the schedule at whichever location happened to sort
  // first whenever the stored one was outside the current user's permitted list, and silently
  // narrowed an all-locations schedule to a single site for a location-restricted user. The stored
  // selection is preserved here and surfaced as an explicit (out-of-scope) option in the dropdown,
  // so only the user picking a different location can change what the schedule targets.
  const hasStoredLocation = Boolean(values.locationMode) || locationIds.length > 0;
  const resolvedLocationId = locationIds.find((id) => locations.some((location) => location.id === id)) || '';
  let locationSelection = '';
  let unresolvedLocationSelection = '';
  if (requestedMode === 'selected') {
    if (resolvedLocationId) locationSelection = resolvedLocationId;
    else if (locationIds.length) {
      locationSelection = locationIds[0];
      unresolvedLocationSelection = locationIds[0];
    } else if (!hasStoredLocation) locationSelection = allowAllLocations ? 'all' : locations[0]?.id || '';
    // else: stored mode is 'selected' but no location id survives. There is no target to preserve,
    // so neither widening to all locations nor picking one for the user is defensible — leave it
    // blank and let the dropdown demand an explicit choice (readScheduleForm already rejects blank).

  } else if (allowAllLocations) {
    locationSelection = 'all';
  } else if (hasStoredLocation) {
    locationSelection = 'all';
    unresolvedLocationSelection = 'all';
  } else {
    locationSelection = locations[0]?.id || '';
  }
  return {
    name: values.name || '',
    reportItems,
    savedViewId: savedViews.some((view) => view.id === values.savedViewId && isCatalogViewAvailable(catalog, view.reportId, view.viewId)) ? values.savedViewId : '',
    // Same rule as toSchedulePayload: a legacy row with real dates but no stored type opens as the
    // custom range it actually is. Showing "today" left the real dates sitting in filters unseen,
    // and saving from that state destroyed them.
    dateRangeType: values.dateRangeType || inferDateRangeType(values.filters || {}, { fallback: 'today' }),
    customFrom: values.filters?.from || values.filters?.startDate || '',
    customTo: values.filters?.to || values.filters?.endDate || '',
    filters: values.filters || {},
    locationMode: locationSelection === 'all' ? 'all' : 'selected',
    locationIds: locationSelection === 'all' ? [] : (locationSelection ? [locationSelection] : []),
    locationSelection,
    unresolvedLocationSelection,
    allowAllLocations,
    frequency: values.scheduleFrequency || values.frequency || 'weekly',
    scheduleDay: String(values.scheduleDay ?? '1'),
    scheduleTime: values.scheduleTime || '08:00',
    timezone: values.timezone || settings.timezone || 'Africa/Johannesburg',
    format: values.format || 'csv',
    recipients: uniqueEmails(Array.isArray(values.recipients) ? values.recipients : []),
    users: mergeWorkspaceUsers(workspaceUsers, extractWorkspaceUsers(state)),
    emailSubject: '',
    emailMessage: '',
    sendCondition: values.sendCondition?.type || values.sendCondition || 'always',
    wastageThreshold: values.sendCondition?.threshold || 0,
    isEnabled: values.isEnabled !== false,
    locations
  };
}

function normalizeReportItems(values = {}, catalog = []) {
  const raw = Array.isArray(values.reportItems) && values.reportItems.length
    ? values.reportItems
    : values.reportId && values.viewId ? [{ reportGroupId: values.reportGroupId || '', reportId: values.reportId, viewId: values.viewId }] : [];
  const fallback = catalog[0] ? [{ reportGroupId: catalog[0].reportGroupId, reportId: catalog[0].reportId, viewId: catalog[0].defaultView }] : [];
  const seen = new Set();
  const repair = (item) => {
    const resolved = resolveCatalogReportSelection(catalog, item?.reportId, item?.viewId);
    if (!resolved) return null;
    return {
      reportGroupId: String(item?.reportGroupId || resolved.reportGroupId || ''),
      reportId: resolved.reportId,
      viewId: resolved.viewId,
      savedViewId: String(item?.savedViewId || ''),
      savedViewSnapshotId: String(item?.savedViewSnapshotId || ''),
      savedViewSnapshotName: String(item?.savedViewSnapshotName || ''),
      savedViewUpdatedAt: String(item?.savedViewUpdatedAt || ''),
      dateRangeType: String(item?.dateRangeType || item?.filters?.dateRangeType || ''),
      filters: item?.filters && typeof item.filters === 'object' ? { ...item.filters } : {},
      sort: item?.sort && typeof item.sort === 'object' ? { ...item.sort } : null,
      visibleColumns: Array.isArray(item?.visibleColumns) ? [...item.visibleColumns] : []
    };
  };
  const normalized = (raw.length ? raw : fallback).map(repair).filter(Boolean).filter((item) => {
    const key = `${item.reportId}::${item.viewId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return normalized;
}

function restoreSavedViewSnapshot(item = {}, savedViews = []) {
  const explicitId = String(item.savedViewSnapshotId || item.savedViewId || '');
  const explicit = savedViews.find((view) => view.id === explicitId && view.reportId === item.reportId && view.viewId === item.viewId);
  const matched = explicit || savedViews.find((view) => view.reportId === item.reportId
    && view.viewId === item.viewId
    && sameScheduleSnapshot(item, view));
  return {
    ...item,
    savedViewId: '',
    savedViewSnapshotId: matched?.id || explicitId,
    savedViewSnapshotName: matched?.name || item.savedViewSnapshotName || '',
    savedViewUpdatedAt: matched?.updatedAt || item.savedViewUpdatedAt || '',
    dateRangeType: matched?.dateRangeType || matched?.filters?.dateRangeType || item.dateRangeType || item.filters?.dateRangeType || ''
  };
}

function sameScheduleSnapshot(item = {}, savedView = {}) {
  return String(item.dateRangeType || item.filters?.dateRangeType || '') === String(savedView.dateRangeType || savedView.filters?.dateRangeType || '')
    && stableSnapshotJson(item.filters || {}) === stableSnapshotJson(savedView.filters || {})
    && stableSnapshotJson(item.sort || null) === stableSnapshotJson(savedView.sort || null)
    && stableSnapshotJson(item.visibleColumns || []) === stableSnapshotJson(savedView.visibleColumns || []);
}

function stableSnapshotJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableSnapshotJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSnapshotJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function toSchedulePayload(schedule = {}, catalog = []) {
  const reportItems = normalizeReportItems(schedule, catalog);
  const first = reportItems[0] || {};
  // Enable/disable, run-now and duplicate all re-send a full payload rebuilt from the client-side
  // schedule object, so this function must round-trip the schedule's REAL targeting rather than
  // normalising it toward broader defaults. A legacy schedule with locationIds populated but no
  // locationMode used to come back as locationMode: 'all', silently widening a single-location
  // schedule to every location on an unrelated toggle click.
  const locationIds = Array.isArray(schedule.locationIds) && schedule.locationIds.length
    ? schedule.locationIds.map(String).filter(Boolean)
    : schedule.locationId ? [String(schedule.locationId)] : [];
  const locationMode = schedule.locationMode || (locationIds.length ? 'selected' : 'all');
  return {
    name: schedule.name,
    reportGroupId: first.reportGroupId || schedule.reportGroupId || '',
    reportId: first.reportId || schedule.reportId || '',
    viewId: first.viewId || schedule.viewId || '',
    reportItems,
    savedViewId: '',
    filters: schedule.filters || {},
    // A legacy row with neither a type nor dates keeps the historic 'today' window: a schedule that
    // silently became unbounded would email the entire history.
    dateRangeType: schedule.dateRangeType || inferDateRangeType(schedule.filters || {}, { fallback: 'today' }),
    locationMode,
    locationIds: locationMode === 'all' ? [] : locationIds,
    locationId: schedule.locationId || (locationMode === 'selected' && locationIds.length === 1 ? locationIds[0] : ''),
    scheduleFrequency: schedule.scheduleFrequency,
    scheduleDay: schedule.scheduleDay,
    scheduleTime: schedule.scheduleTime,
    timezone: schedule.timezone,
    format: schedule.format,
    recipients: schedule.recipients || [],
    emailSubject: '',
    emailMessage: '',
    sendCondition: schedule.sendCondition || { type: 'always' },
    isEnabled: schedule.isEnabled
  };
}

function isCatalogViewAvailable(catalog = [], reportId = '', viewId = '') {
  return Boolean(resolveCatalogReportSelection(catalog, reportId, viewId));
}

function normalizeSavedViews(views = [], catalog = []) {
  const source = Array.isArray(views) ? views : [];
  const compatible = [];
  let ignored = 0;
  source.forEach((view) => {
    const resolved = view?.id ? resolveCatalogReportSelection(catalog, view.reportId, view.viewId) : null;
    if (!resolved) {
      ignored += 1;
      return;
    }
    compatible.push({
      ...view,
      originalReportId: view.reportId,
      originalViewId: view.viewId,
      reportGroupId: view.reportGroupId || resolved.reportGroupId || '',
      reportId: resolved.reportId,
      viewId: resolved.viewId
    });
  });
  return { views: compatible, ignored };
}


function isSchedulerVersionCompatible(version = '') {
  const [major, minor] = String(version || '').split('.').map((value) => Number(value));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 33 || (major === 33 && minor >= 19);
}

function selectReportItem(form, reportId, viewId, replace = false) {
  const resolved = resolveCatalogReportSelection(getSchedulableReportCatalog(), reportId, viewId);
  if (!resolved) return false;
  reportId = resolved.reportId;
  viewId = resolved.viewId;
  if (replace) {
    form.querySelectorAll('[data-schedule-report-toggle]').forEach((input) => { input.checked = false; });
    form.querySelectorAll('[data-schedule-view-toggle]').forEach((input) => { input.checked = false; });
    form.querySelectorAll('[data-schedule-report-card]').forEach((card) => card.classList.remove('is-selected'));
  }
  const toggle = [...form.querySelectorAll('[data-schedule-report-toggle]')].find((input) => input.dataset.reportId === reportId || input.value === reportId);
  if (!toggle) return false;
  toggle.checked = true;
  const viewToggle = [...form.querySelectorAll('[data-schedule-view-toggle]')]
    .find((input) => input.dataset.reportId === reportId && input.dataset.viewId === viewId);
  if (viewToggle) viewToggle.checked = true;
  syncReportSelection(form, reportId, true);
  updateBundleCount(form);
  return true;
}

function syncReportSelection(form, reportId, selected) {
  if (!reportId) return;
  const reportToggle = [...form.querySelectorAll('[data-schedule-report-toggle]')]
    .find((input) => input.dataset.reportId === reportId);
  if (!reportToggle) return;
  reportToggle.checked = Boolean(selected);
  const viewToggles = [...form.querySelectorAll('[data-schedule-view-toggle]')]
    .filter((input) => input.dataset.reportId === reportId);
  if (selected && !viewToggles.some((input) => input.checked)) {
    const defaultView = reportToggle.dataset.defaultView || '';
    const defaultToggle = viewToggles.find((input) => input.dataset.viewId === defaultView) || viewToggles[0];
    if (defaultToggle) defaultToggle.checked = true;
  }
  if (!selected) viewToggles.forEach((input) => { input.checked = false; });
  viewToggles.forEach((input) => syncSavedViewSelectState(form, reportId, input.dataset.viewId || '', input.checked));

  const card = [...form.querySelectorAll('[data-schedule-report-card]')]
    .find((entry) => entry.dataset.reportId === reportId);
  card?.classList.toggle('is-selected', Boolean(selected));
  const selectButton = card?.querySelector('[data-schedule-report-select-button]');
  if (selectButton) selectButton.textContent = selected ? 'Remove from pack' : 'Select report';
}

function syncViewSelection(form, reportId) {
  if (!reportId) return;
  const viewToggles = [...form.querySelectorAll('[data-schedule-view-toggle]')]
    .filter((input) => input.dataset.reportId === reportId);
  const anySelected = viewToggles.some((input) => input.checked);
  syncReportSelection(form, reportId, anySelected);
}

function openReportViewPanel(form, reportId) {
  const body = form.querySelector('.reportSchedulePicker__body');
  if (!body || !reportId) return;
  body.querySelectorAll('[data-schedule-view-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.scheduleViewPanel !== reportId;
  });
  body.classList.add('is-selecting-views');
  const panel = [...body.querySelectorAll('[data-schedule-view-panel]')]
    .find((entry) => entry.dataset.scheduleViewPanel === reportId);
  panel?.querySelector('[data-schedule-view-toggle]')?.focus();
}

function closeReportViewPanel(form) {
  const body = form.querySelector('.reportSchedulePicker__body');
  if (!body) return;
  body.classList.remove('is-selecting-views');
  body.querySelectorAll('[data-schedule-view-panel]').forEach((panel) => { panel.hidden = true; });
}

function updateBundleCount(form) {
  const selectedReports = [...form.querySelectorAll('[data-schedule-report-toggle]:checked')];
  const selectedReportIds = new Set(selectedReports.map((input) => input.dataset.reportId));
  const selectedViews = [...form.querySelectorAll('[data-schedule-view-toggle]:checked')]
    .filter((input) => selectedReportIds.has(input.dataset.reportId));
  const reports = selectedReports.length;
  const views = selectedViews.length;
  const countLabel = `${reports} report${reports === 1 ? '' : 's'} · ${views} view${views === 1 ? '' : 's'}`;
  form.querySelectorAll('[data-schedule-bundle-count]').forEach((slot) => { slot.textContent = countLabel; });

  form.querySelectorAll('[data-schedule-report-card]').forEach((card) => {
    const reportId = card.dataset.reportId || '';
    const reportViewToggles = [...form.querySelectorAll('[data-schedule-view-toggle]')]
      .filter((input) => input.dataset.reportId === reportId && input.checked);
    const selectedViewsSlot = card.querySelector('[data-schedule-selected-views]');
    if (selectedViewsSlot) {
      selectedViewsSlot.innerHTML = reportViewToggles.length
        ? reportViewToggles.map((input) => {
          const label = input.closest('label')?.querySelector('strong')?.textContent?.trim() || input.dataset.viewId || 'View';
          const savedSelect = [...form.querySelectorAll('[data-schedule-item-saved-view]')]
            .find((select) => select.dataset.reportId === reportId && select.dataset.viewId === input.dataset.viewId);
          const savedLabel = savedSelect?.value ? savedSelect.options[savedSelect.selectedIndex]?.textContent?.trim() : '';
          return `<span>${escapeHtml(savedLabel ? `${label} · ${savedLabel}` : label)}</span>`;
        }).join('')
        : '<span class="reportScheduleReportCard__noViews">No views selected</span>';
    }
    const countSlot = [...form.querySelectorAll('[data-schedule-view-count]')]
      .find((slot) => slot.dataset.scheduleViewCount === reportId);
    if (countSlot) countSlot.textContent = `${reportViewToggles.length} view${reportViewToggles.length === 1 ? '' : 's'} selected`;
  });

  const summary = form.querySelector('[data-schedule-pack-summary]');
  if (!summary) return;
  if (!selectedReports.length) {
    summary.innerHTML = '<span class="reportSchedulePackSummary__empty">No reports selected</span>';
    return;
  }
  summary.innerHTML = selectedReports.map((input) => {
    const reportId = input.dataset.reportId || '';
    const card = input.closest('[data-schedule-report-card]');
    const reportTitle = card?.querySelector('.reportScheduleReportCard__open strong')?.textContent?.trim() || reportId || 'Report';
    const reportViewCount = selectedViews.filter((view) => view.dataset.reportId === reportId).length;
    return `<span class="reportSchedulePackChip">${escapeHtml(reportTitle)} · ${reportViewCount} view${reportViewCount === 1 ? '' : 's'}</span>`;
  }).join('');
}

function bindRecipientPicker(form) {
  const picker = form.querySelector('[data-schedule-recipient-picker]');
  if (!picker) return;
  const hidden = picker.querySelector('input[name="recipients"]');
  const chips = picker.querySelector('[data-schedule-recipient-chips]');
  const userSelect = picker.querySelector('[data-schedule-recipient-select]');
  const emailInput = picker.querySelector('[data-schedule-recipient-input]');
  const addButton = picker.querySelector('[data-schedule-recipient-add]');

  const current = () => uniqueEmails(String(hidden?.value || '').split(/[;,\n]/));
  const render = (emails) => {
    const normalized = uniqueEmails(emails);
    if (hidden) hidden.value = normalized.join(', ');
    if (chips) chips.innerHTML = renderRecipientChips(normalized);
  };
  const add = (email) => {
    const normalized = String(email || '').trim().toLowerCase();
    if (!isValidEmail(normalized)) {
      showModalMessage(form, 'Enter a valid recipient email address.', 'warning');
      return false;
    }
    render([...current(), normalized]);
    return true;
  };

  userSelect?.addEventListener('change', () => {
    if (userSelect.value && add(userSelect.value)) {
      userSelect.value = '';
      refreshReportingSelect(userSelect);
    }
  });
  const addCustom = () => {
    if (add(emailInput?.value || '')) {
      if (emailInput) emailInput.value = '';
      emailInput?.focus();
    }
  };
  addButton?.addEventListener('click', addCustom);
  emailInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCustom();
  });
  chips?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-schedule-recipient-remove]');
    if (!button) return;
    const remove = String(button.dataset.scheduleRecipientRemove || '').toLowerCase();
    render(current().filter((email) => email.toLowerCase() !== remove));
  });
  render(current());
}

function isValidEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function uniqueEmails(values = []) {
  const seen = new Set();
  return values.map((value) => String(value || '').trim()).filter((value) => {
    if (!isValidEmail(value)) return false;
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cssEscape(value = '') {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/(["\\])/g, '\\$1');
}

function extractWorkspaceUsers(state = {}) {
  return mergeWorkspaceUsers(
    state.users?.items,
    Array.isArray(state.users) ? state.users : [],
    state.workspace?.users,
    state.workspace?.members,
    state.members?.items,
    Array.isArray(state.members) ? state.members : [],
    state.userManagement?.users,
    state.data?.users,
    state.reporting?.users
  );
}

function mergeWorkspaceUsers(...collections) {
  const seen = new Set();
  return collections.flatMap((collection) => Array.isArray(collection) ? collection : []).map((user) => {
    const email = String(user?.email || user?.userEmail || user?.user_email || '').trim();
    const name = String(user?.displayName || user?.display_name || user?.name || user?.fullName || user?.full_name || email).trim();
    const status = String(user?.status || user?.membershipStatus || user?.membership_status || 'active').toLowerCase();
    const active = user?.active !== false && user?.isActive !== false && !['disabled', 'inactive', 'removed', 'deleted'].includes(status);
    return { email, name: name || email, active };
  }).filter((user) => {
    const key = user.email.toLowerCase();
    if (!user.active || !isValidEmail(user.email) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ email, name }) => ({ email, name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.email.localeCompare(right.email));
}

function extractLocations(state = {}) {
  return mergeLocations(
    state.locations?.items,
    Array.isArray(state.locations) ? state.locations : [],
    state.stock?.locations,
    state.source?.locations,
    state.workspace?.locations,
    state.data?.locations,
    state.reporting?.locations
  );
}

function mergeLocations(...collections) {
  const seen = new Set();
  return collections.flatMap((collection) => Array.isArray(collection) ? collection : []).map((location) => ({
    id: String(location?.id || location?.locationId || location?.location_id || location?.value || '').trim(),
    name: String(location?.displayName || location?.display_name || location?.name || location?.locationName || location?.label || location?.id || '').trim(),
    active: location?.active !== false && location?.isActive !== false && Number(location?.active ?? 1) !== 0
  })).filter((location) => location.active && location.id && !seen.has(location.id) && seen.add(location.id))
    .map(({ id, name }) => ({ id, name: name || id }));
}

function formatScheduleLocations(schedule = {}, workspaceLocations = []) {
  const activeById = new Map((workspaceLocations || []).map((location) => [String(location.id || ''), String(location.name || location.id || '')]));
  const apiLocations = Array.isArray(schedule.locations) ? schedule.locations : [];
  apiLocations.forEach((location) => {
    const id = String(location?.id || '');
    const name = String(location?.name || id);
    if (id && name) activeById.set(id, name);
  });

  const selectedIds = Array.isArray(schedule.locationIds) ? schedule.locationIds.map(String).filter(Boolean) : [];
  const apiNames = Array.isArray(schedule.locationNames) ? schedule.locationNames.map(String).filter(Boolean) : [];
  const names = schedule.locationMode === 'selected'
    ? selectedIds.map((id, index) => activeById.get(id) || apiNames[index] || id)
    : (apiNames.length ? apiNames : [...activeById.values()]);
  const uniqueNames = [...new Set(names.filter(Boolean))];

  if (schedule.locationMode === 'selected') {
    const count = selectedIds.length || uniqueNames.length;
    return {
      summary: `${count} selected location${count === 1 ? '' : 's'}`,
      detail: uniqueNames.join(', ') || 'No active selected locations'
    };
  }
  return {
    summary: 'All locations',
    detail: uniqueNames.join(', ') || 'Each active location is generated separately'
  };
}

function conditionOptions(selected) {
  const options = [
    ['always', 'Always send'], ['only_if_data', 'Only send if there is data'], ['only_if_critical_warnings', 'Only send if critical warnings exist'], ['only_if_low_stock', 'Only send if low stock exists'], ['only_if_wastage_threshold', 'Only send if wastage exceeds threshold'], ['only_if_reconciliation_issues', 'Only send if reconciliation issues exist'], ['only_if_high_risk_changes', 'Only send if high-risk changes exist'], ['only_if_sales', 'Only send if sales exist']
  ];
  return options.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}
function weekDayOptions(selected) { return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((label, index) => `<option value="${index}" ${String(index) === String(selected) ? 'selected' : ''}>${label}</option>`).join(''); }
function monthDayOptions(selected) { return Array.from({ length: 28 }, (_, index) => index + 1).map((day) => `<option value="${day}" ${String(day) === String(selected) ? 'selected' : ''}>Day ${day}</option>`).join(''); }
function formatFrequency(schedule) { const frequency = schedule.scheduleFrequency || ''; if (frequency === 'daily') return `Daily · ${schedule.scheduleTime}`; if (frequency === 'weekly') return `Weekly · ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][Number(schedule.scheduleDay) || 0]} ${schedule.scheduleTime}`; return `Monthly · Day ${schedule.scheduleDay || 1} ${schedule.scheduleTime}`; }
function formatDateTime(value, timeZone = 'Africa/Johannesburg') { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value); try { return new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short', timeZone: timeZone || 'Africa/Johannesburg' }).format(date); } catch { return new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Johannesburg' }).format(date); } }
function formatOutputLabel(format) {
  return { csv: 'CSV attachments', xlsx: 'XLSX attachments', pdf: 'PDF attachments', report_link: 'Report links only' }[format] || 'Report links only';
}
function templateIcon(id) { return ({ stock_controller: '▤', operations_manager: '◷', sales_manager: '◔', general_manager: '▥' })[id] || '▦'; }
function showModalMessage(form, message, tone) { const slot = form.querySelector('[data-schedule-modal-message]'); if (slot) slot.innerHTML = `<div class="reportSchedulingNotice reportSchedulingNotice--${tone}">${escapeHtml(message)}</div>`; }
