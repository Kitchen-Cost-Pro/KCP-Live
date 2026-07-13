import { escapeHtml } from '../engine/formatters.js';
import { enhanceReportingSelects, refreshReportingSelect } from '../ui/customSelect.js';
import { REPORT_DATE_RANGE_PRESETS } from './dateRangePresets.js';
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
    description: 'Critical stock control and supplier reorder pack.',
    values: {
      name: 'Weekly Stock Control Pack',
      reportItems: [
        { reportId: 'stock_control', viewId: 'location_summary' },
        { reportId: 'stock_control', viewId: 'reorder_detail' },
        { reportId: 'stock_control', viewId: 'supplier_reorder' }
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
  const schedulerUpgradeMessage = 'The Scheduling Worker is older than this page. Deploy cloudflare-v2 from Phase 33.17 first, then reload once.';

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
    const values = normalizeFormValues(schedule ? toSchedulePayload(schedule, catalog) : (preset || {}), state, catalog, workspaceLocations, allowAllLocations, savedViews);
    const overlay = document.createElement('div');
    overlay.className = 'reportModalBackdrop reportScheduleModalBackdrop';
    overlay.innerHTML = renderScheduleModal(values, catalog, savedViews, Boolean(schedule));
    document.body.append(overlay);
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
      const card = toggle.closest('[data-schedule-report-card]');
      const views = [...card.querySelectorAll('[data-schedule-report-view]')];
      card.classList.toggle('is-selected', toggle.checked);
      views.forEach((input) => { input.disabled = !toggle.checked; });
      if (toggle.checked && !views.some((input) => input.checked)) {
        const preferred = views.find((input) => input.dataset.defaultView === 'true') || views[0];
        if (preferred) preferred.checked = true;
      }
      if (!toggle.checked) views.forEach((input) => { input.checked = false; });
      updateBundleCount(form);
    }));
    form.querySelectorAll('[data-schedule-report-view]').forEach((view) => view.addEventListener('change', () => updateBundleCount(form)));

    form.querySelector('[name="savedViewId"]')?.addEventListener('change', (event) => {
      const selectedId = String(event.currentTarget.value || '');
      if (!selectedId) return;
      const selected = savedViews.find((view) => view.id === selectedId);
      if (!selected || !isCatalogViewAvailable(catalog, selected.reportId, selected.viewId) || !selectReportItem(form, selected.reportId, selected.viewId, true)) {
        event.currentTarget.value = '';
        refreshReportingSelect(event.currentTarget);
        showModalMessage(form, 'That saved view is no longer compatible. Select a current report view; the schedule can still be saved.', 'warning');
        updateBundleCount(form);
        return;
      }
      form.querySelector('[name="dateRangeType"]').value = selected.dateRangeType || 'custom';
      form.querySelector('[name="filtersJson"]').value = JSON.stringify(selected.filters || {});
      const savedLocation = selected.locationId || selected.filters?.locationId || '';
      const locationSelect = form.querySelector('[name="locationSelection"]');
      if (locationSelect) {
        const requestedValue = savedLocation || (values.allowAllLocations ? 'all' : values.locations[0]?.id || '');
        const hasOption = [...locationSelect.options].some((option) => option.value === requestedValue);
        if (hasOption) locationSelect.value = requestedValue;
      }
      form.querySelector('[name="customFrom"]').value = selected.filters?.from || selected.filters?.startDate || '';
      form.querySelector('[name="customTo"]').value = selected.filters?.to || selected.filters?.endDate || '';
      refreshReportingSelect(form.querySelector('[name="dateRangeType"]'));
      refreshReportingSelect(form.querySelector('[name="locationSelection"]'));
      syncDateRange();
      updateBundleCount(form);
    });

    enhanceReportingSelects(overlay);
    syncDateRange();
    syncCondition();
    syncFrequency();
    updateBundleCount(form);

    form.querySelector('[data-schedule-test]')?.addEventListener('click', async (event) => {
      event.preventDefault();
      const payload = readScheduleForm(form, catalog, savedViews);
      const button = event.currentTarget;
      button.disabled = true;
      try {
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
        const payload = readScheduleForm(form, catalog, savedViews);
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
            return `
              <tr>
                <td><strong>${escapeHtml(schedule.name)}</strong><span>${escapeHtml(schedule.formatLabel || formatOutputLabel(schedule.format))}</span></td>
                <td><strong>${escapeHtml(report?.fullTitle || first?.reportId || schedule.reportId)}</strong><span>${escapeHtml(formatViewLabel(first?.viewId || schedule.viewId))}${items.length > 1 ? ` · +${items.length - 1} more` : ''}</span></td>
                <td><strong>${escapeHtml(locationDisplay.summary)}</strong><span>${escapeHtml(locationDisplay.detail)}</span></td>
                <td>${escapeHtml(formatFrequency(schedule))}</td>
                <td>${escapeHtml(formatDateTime(schedule.nextRunAt, schedule.timezone))}<span>${schedule.lastRunAt ? `Last: ${escapeHtml(formatDateTime(schedule.lastRunAt, schedule.timezone))}` : 'Never run'}</span></td>
                <td>${escapeHtml((schedule.recipients || []).join(', '))}</td>
                <td><label class="reportScheduleToggle"><input type="checkbox" data-schedule-enabled="${escapeHtml(schedule.id)}" ${schedule.isEnabled ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /><span>${schedule.isEnabled ? 'Enabled' : 'Disabled'}</span></label></td>
                <td><div class="reportScheduleRowActions">
                  ${canRun ? `<button type="button" data-schedule-run="${escapeHtml(schedule.id)}">Run now</button>` : ''}
                  ${canEdit ? `<button type="button" data-schedule-edit="${escapeHtml(schedule.id)}">Edit</button><button type="button" data-schedule-duplicate="${escapeHtml(schedule.id)}">Duplicate</button>` : ''}
                  ${canDelete ? `<button type="button" data-schedule-delete="${escapeHtml(schedule.id)}">Delete</button>` : ''}
                </div></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderScheduleModal(values, catalog, savedViews, editing) {
  const selectedKeys = new Set(values.reportItems.map((item) => `${item.reportId}::${item.viewId}`));
  const activeReports = new Set(values.reportItems.map((item) => item.reportId));
  const catalogGroups = groupCatalog(catalog);
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
              <div><span>Schedule details</span><strong>Name and optional saved configuration</strong></div>
            </header>
            <div class="reportScheduleSectionGrid">
              <label><span>Schedule name</span><input name="name" value="${escapeHtml(values.name)}" required maxlength="120" placeholder="Weekly Management Report Pack" /></label>
              <label><span>Start from a saved view (optional)</span><select name="savedViewId"><option value="">Do not apply a saved view</option>${savedViews.map((view) => `<option value="${escapeHtml(view.id)}" ${values.savedViewId === view.id ? 'selected' : ''}>${escapeHtml(view.name)}</option>`).join('')}</select></label>
            </div>
          </section>

          <section class="reportScheduleFormSection reportScheduleFormSection--pack">
            <header class="reportScheduleFormSection__header">
              <span class="reportScheduleFormSection__step">2</span>
              <div><span>Report pack</span><strong>Choose the reports and views to deliver</strong></div>
            </header>
            <div class="reportSchedulePackSummary">
              <div class="reportSchedulePackSummary__copy">
                <span class="reportSchedulePackSummary__count" data-schedule-bundle-count></span>
                <div class="reportSchedulePackSummary__items" data-schedule-pack-summary></div>
              </div>
              <button type="button" class="reportSchedulePackButton" data-schedule-pack-open>
                <span>Choose reports &amp; views</span><span aria-hidden="true">→</span>
              </button>
            </div>

            <div class="reportSchedulePickerBackdrop" data-schedule-pack-picker hidden>
              <section class="reportSchedulePicker" role="dialog" aria-modal="true" aria-labelledby="schedule-pack-picker-title">
                <header>
                  <div><span>Report pack</span><h4 id="schedule-pack-picker-title">Select reports and views</h4><p>Choose one or more views. Each selected view is delivered as its own report output.</p></div>
                  <button type="button" data-schedule-pack-close aria-label="Close report selector">×</button>
                </header>
                <div class="reportSchedulePicker__body">
                  <section class="reportScheduleBundle">
                    <div class="reportScheduleBundle__groups">
                      ${catalogGroups.map((group) => `
                        <div class="reportScheduleBundle__group">
                          <h4>${escapeHtml(group.title)}</h4>
                          ${group.items.map((entry) => {
                            const reportSelected = activeReports.has(entry.reportId);
                            return `
                              <article class="reportScheduleReportCard${reportSelected ? ' is-selected' : ''}" data-schedule-report-card>
                                <label class="reportScheduleReportCard__title">
                                  <input type="checkbox" data-schedule-report-toggle value="${escapeHtml(entry.reportId)}" ${reportSelected ? 'checked' : ''} />
                                  <span><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.reportGroupTitle || 'Report')}</small></span>
                                </label>
                                <div class="reportScheduleReportCard__views">
                                  ${entry.views.map((view) => `<label><input type="checkbox" data-schedule-report-view data-report-id="${escapeHtml(entry.reportId)}" data-report-group-id="${escapeHtml(entry.reportGroupId || '')}" data-default-view="${view.value === entry.defaultView ? 'true' : 'false'}" value="${escapeHtml(view.value)}" ${selectedKeys.has(`${entry.reportId}::${view.value}`) ? 'checked' : ''} ${reportSelected ? '' : 'disabled'} /><span>${escapeHtml(view.label)}</span></label>`).join('')}
                                </div>
                              </article>
                            `;
                          }).join('')}
                        </div>
                      `).join('')}
                    </div>
                  </section>
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
              <label><span>Location</span><select name="locationSelection" ${!values.allowAllLocations && !values.locations.length ? 'disabled' : ''}>${values.allowAllLocations ? `<option value="all" ${values.locationSelection === 'all' ? 'selected' : ''}>All Locations</option>` : ''}${values.locations.map((location) => `<option value="${escapeHtml(location.id)}" ${values.locationSelection === location.id ? 'selected' : ''}>${escapeHtml(location.name)}</option>`).join('')}${!values.allowAllLocations && !values.locations.length ? '<option value="">No assigned locations</option>' : ''}</select></label>
              <label data-schedule-custom-date><span>From</span><input type="date" name="customFrom" value="${escapeHtml(values.customFrom)}" /></label>
              <label data-schedule-custom-date><span>To</span><input type="date" name="customTo" value="${escapeHtml(values.customTo)}" /></label>
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
              <div><span>Delivery</span><strong>Set the format, recipients and email content</strong></div>
            </header>
            <div class="reportScheduleSectionGrid">
              <label><span>Export format</span><select name="format"><option value="csv" ${values.format === 'csv' ? 'selected' : ''}>CSV attachments</option><option value="xlsx" ${values.format === 'xlsx' ? 'selected' : ''}>XLSX attachments</option><option value="pdf" ${values.format === 'pdf' ? 'selected' : ''}>PDF attachments</option><option value="report_link" ${values.format === 'report_link' ? 'selected' : ''}>Report links only</option></select></label>
              <label><span>Send condition</span><select name="sendCondition">${conditionOptions(values.sendCondition)}</select></label>
              <label data-schedule-threshold><span>Wastage threshold (R)</span><input type="number" min="0" step="0.01" name="wastageThreshold" value="${escapeHtml(String(values.wastageThreshold || ''))}" /></label>
              <label class="reportScheduleFull"><span>Recipients</span><input name="recipients" value="${escapeHtml(values.recipients.join(', '))}" required placeholder="manager@example.com, owner@example.com" /></label>
              <label class="reportScheduleFull"><span>Email subject</span><input name="emailSubject" value="${escapeHtml(values.emailSubject)}" placeholder="Kitchen Cost Pro - Weekly Report Pack" /></label>
              <label class="reportScheduleFull"><span>Email message</span><textarea name="emailMessage" rows="3" placeholder="Your scheduled reports are ready.">${escapeHtml(values.emailMessage)}</textarea></label>
              <label class="reportModalCheck reportScheduleFull"><input type="checkbox" name="isEnabled" ${values.isEnabled ? 'checked' : ''} /> <span>Enable this schedule</span></label>
            </div>
          </section>
        </div>

        <div class="reportModalActions reportScheduleModalActions"><button type="button" data-schedule-close>Cancel</button><button type="button" data-schedule-test>Send test email</button><button type="submit" class="reportModalPrimary">${editing ? 'Save changes' : 'Create schedule'}</button></div>
      </form>
    </section>
  `;
}

function readScheduleForm(form, catalog, savedViews = []) {
  const data = new FormData(form);
  const frequency = String(data.get('frequency') || 'weekly');
  const reportItems = [...form.querySelectorAll('[data-schedule-report-view]:checked')].map((input) => ({
    reportGroupId: String(input.dataset.reportGroupId || ''),
    reportId: String(input.dataset.reportId || ''),
    viewId: String(input.value || ''),
    savedViewId: '',
    filters: {},
    sort: null,
    visibleColumns: []
  })).filter((item) => isCatalogViewAvailable(catalog, item.reportId, item.viewId));
  if (!reportItems.length) throw new Error('Select at least one current report view for this schedule.');

  // Saved views are templates only. Snapshot their configuration into the selected report
  // item and never persist a live saved-view reference on the schedule.
  const requestedSavedViewId = String(data.get('savedViewId') || '');
  const selectedSavedView = savedViews.find((view) => view.id === requestedSavedViewId && isCatalogViewAvailable(catalog, view.reportId, view.viewId));
  if (selectedSavedView) {
    const target = reportItems.find((item) => item.reportId === selectedSavedView.reportId && item.viewId === selectedSavedView.viewId);
    if (target) {
      target.filters = selectedSavedView.filters && typeof selectedSavedView.filters === 'object' ? { ...selectedSavedView.filters } : {};
      target.sort = selectedSavedView.sort && typeof selectedSavedView.sort === 'object' ? { ...selectedSavedView.sort } : null;
      target.visibleColumns = Array.isArray(selectedSavedView.visibleColumns) ? [...selectedSavedView.visibleColumns] : [];
    }
  }

  const recipients = String(data.get('recipients') || '').split(/[;,\n]/).map((entry) => entry.trim()).filter(Boolean);
  const locationSelection = String(data.get('locationSelection') || '').trim();
  if (!locationSelection) throw new Error('Select a location for this schedule.');
  const locationMode = locationSelection === 'all' ? 'all' : 'selected';
  const locationIds = locationMode === 'selected' ? [locationSelection] : [];

  let baseFilters = {};
  try { baseFilters = JSON.parse(String(data.get('filtersJson') || '{}')); } catch { baseFilters = {}; }
  delete baseFilters.locationId;
  delete baseFilters.locationName;
  const dateRangeType = String(data.get('dateRangeType') || 'last_7_days');
  const customFrom = String(data.get('customFrom') || '');
  const customTo = String(data.get('customTo') || '');
  const filters = { ...baseFilters };
  if (dateRangeType === 'custom') {
    if (!customFrom || !customTo) throw new Error('Select both custom dates.');
    filters.from = customFrom; filters.to = customTo; filters.startDate = customFrom; filters.endDate = customTo;
  } else {
    delete filters.from; delete filters.to; delete filters.startDate; delete filters.endDate;
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
    emailSubject: String(data.get('emailSubject') || '').trim(),
    emailMessage: String(data.get('emailMessage') || '').trim(),
    sendCondition: { type: String(data.get('sendCondition') || 'always'), threshold: Number(data.get('wastageThreshold') || 0) || 0 },
    isEnabled: data.get('isEnabled') === 'on'
  };
}

function normalizeFormValues(values = {}, state = {}, catalog = [], availableLocations = null, allowAllLocations = true, savedViews = []) {
  const settings = state.settings?.values || state.settings?.draft || {};
  // Once the Worker supplies a location list, it is the permission-filtered source of truth.
  // Do not merge broader app state back into it for location-restricted users.
  const locations = Array.isArray(availableLocations)
    ? mergeLocations(availableLocations)
    : extractLocations(state);
  const reportItems = normalizeReportItems(values, catalog);
  const locationIds = Array.isArray(values.locationIds) ? values.locationIds.map(String).filter(Boolean) : values.locationId ? [String(values.locationId)] : [];
  const requestedMode = values.locationMode || (locationIds.length ? 'selected' : 'all');
  const selectedLocationId = locationIds.find((id) => locations.some((location) => location.id === id)) || locations[0]?.id || '';
  const locationSelection = requestedMode === 'selected' ? selectedLocationId : (allowAllLocations ? 'all' : selectedLocationId);
  return {
    name: values.name || '',
    reportItems,
    savedViewId: savedViews.some((view) => view.id === values.savedViewId && isCatalogViewAvailable(catalog, view.reportId, view.viewId)) ? values.savedViewId : '',
    dateRangeType: values.dateRangeType || 'last_7_days',
    customFrom: values.filters?.from || values.filters?.startDate || '',
    customTo: values.filters?.to || values.filters?.endDate || '',
    filters: values.filters || {},
    locationMode: locationSelection === 'all' ? 'all' : 'selected',
    locationIds: locationSelection === 'all' ? [] : (locationSelection ? [locationSelection] : []),
    locationSelection,
    allowAllLocations,
    frequency: values.scheduleFrequency || values.frequency || 'weekly',
    scheduleDay: String(values.scheduleDay ?? '1'),
    scheduleTime: values.scheduleTime || '08:00',
    timezone: values.timezone || settings.timezone || 'Africa/Johannesburg',
    format: values.format || 'csv',
    recipients: Array.isArray(values.recipients) ? values.recipients : [],
    emailSubject: values.emailSubject || '',
    emailMessage: values.emailMessage || '',
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
      savedViewId: '',
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

function toSchedulePayload(schedule = {}, catalog = []) {
  const reportItems = normalizeReportItems(schedule, catalog);
  const first = reportItems[0] || {};
  return {
    name: schedule.name,
    reportGroupId: first.reportGroupId || schedule.reportGroupId || '',
    reportId: first.reportId || schedule.reportId || '',
    viewId: first.viewId || schedule.viewId || '',
    reportItems,
    savedViewId: '',
    filters: schedule.filters || {},
    dateRangeType: schedule.dateRangeType || 'custom',
    locationMode: schedule.locationMode || 'all',
    locationIds: schedule.locationIds || [],
    locationId: schedule.locationId || '',
    scheduleFrequency: schedule.scheduleFrequency,
    scheduleDay: schedule.scheduleDay,
    scheduleTime: schedule.scheduleTime,
    timezone: schedule.timezone,
    format: schedule.format,
    recipients: schedule.recipients || [],
    emailSubject: schedule.emailSubject || '',
    emailMessage: schedule.emailMessage || '',
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
  return major > 33 || (major === 33 && minor >= 17);
}

function groupCatalog(catalog = []) {
  const groups = new Map();
  catalog.forEach((entry) => {
    const key = entry.reportGroupId || entry.reportId;
    if (!groups.has(key)) groups.set(key, { title: entry.reportGroupTitle || entry.title, items: [] });
    groups.get(key).items.push(entry);
  });
  return [...groups.values()];
}

function selectReportItem(form, reportId, viewId, replace = false) {
  const resolved = resolveCatalogReportSelection(getSchedulableReportCatalog(), reportId, viewId);
  if (!resolved) return false;
  reportId = resolved.reportId;
  viewId = resolved.viewId;
  if (replace) {
    form.querySelectorAll('[data-schedule-report-toggle]').forEach((input) => { input.checked = false; });
    form.querySelectorAll('[data-schedule-report-view]').forEach((input) => { input.checked = false; input.disabled = true; });
    form.querySelectorAll('[data-schedule-report-card]').forEach((card) => card.classList.remove('is-selected'));
  }
  const view = [...form.querySelectorAll('[data-schedule-report-view]')].find((input) => input.dataset.reportId === reportId && input.value === viewId);
  if (!view) return false;
  const card = view.closest('[data-schedule-report-card]');
  const toggle = card.querySelector('[data-schedule-report-toggle]');
  toggle.checked = true;
  card.classList.add('is-selected');
  card.querySelectorAll('[data-schedule-report-view]').forEach((input) => { input.disabled = false; });
  view.checked = true;
  return true;
}

function updateBundleCount(form) {
  const selectedViews = [...form.querySelectorAll('[data-schedule-report-view]:checked')];
  const views = selectedViews.length;
  const reports = new Set(selectedViews.map((input) => input.dataset.reportId)).size;
  const countLabel = `${reports} report${reports === 1 ? '' : 's'} · ${views} view${views === 1 ? '' : 's'}`;
  form.querySelectorAll('[data-schedule-bundle-count]').forEach((slot) => { slot.textContent = countLabel; });

  const summary = form.querySelector('[data-schedule-pack-summary]');
  if (!summary) return;
  if (!selectedViews.length) {
    summary.innerHTML = '<span class="reportSchedulePackSummary__empty">No report views selected</span>';
    return;
  }
  summary.innerHTML = selectedViews.slice(0, 5).map((input) => {
    const reportTitle = input.closest('[data-schedule-report-card]')?.querySelector('.reportScheduleReportCard__title strong')?.textContent?.trim() || input.dataset.reportId || 'Report';
    const viewTitle = input.closest('label')?.querySelector('span')?.textContent?.trim() || formatViewLabel(input.value);
    return `<span class="reportSchedulePackChip">${escapeHtml(reportTitle)} · ${escapeHtml(viewTitle)}</span>`;
  }).join('') + (selectedViews.length > 5 ? `<span class="reportSchedulePackChip reportSchedulePackChip--more">+${selectedViews.length - 5} more</span>` : '');
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
