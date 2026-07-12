import '../styles/userManagement.css';
import '../styles/fieldHelp.css';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { ACTION_PERMISSION_MAP, canManagePermissionSets, hasPermission, toRoleLabel } from '../services/roleService.js';

export function renderUserManagement({ state, onUserManagementFilterChange, onUserManagementAction = {} } = {}) {
  const access = state.access || {};
  const userManagement = state.userManagement || {};
  const filters = {
    query: '',
    role: '',
    openDropdown: '',
    ...userManagement.filters
  };

  if ((access.allowedSections || []).length && !(access.allowedSections || []).includes('user-management')) {
    return renderLockedView('User Management');
  }

  const canSeeSuperUsers = access.currentIsSuperUser === true || isSuperUserRole(access.currentRole);
  const superUsers = access.superUsers || [];
  const members = filterMembers(access.team || [], filters, { includeSuperUsers: canSeeSuperUsers, superUsers });
  const visibleRoleOptions = (access.roleOptions || []).filter((role) => canSeeSuperUsers || !isSuperUserRole(role.value || role.label));
  const roleOptions = [{ value: '', label: 'All Roles' }, ...visibleRoleOptions.map((role) => ({ value: role.value, label: role.label }))];
  const draft = userManagement.draftMember || createEmptyDraft();
  const editingMember = userManagement.editingMember && (canSeeSuperUsers || !isSuperUserMember(userManagement.editingMember, superUsers))
    ? userManagement.editingMember
    : null;
  const confirmRemove = userManagement.confirmRemove && (canSeeSuperUsers || !isSuperUserMember(userManagement.confirmRemove, superUsers))
    ? userManagement.confirmRemove
    : null;
  const canManageUsers = hasPermission(ACTION_PERMISSION_MAP.manageUsers, access.currentRole, access.customRoles || []);
  const canManagePermissions = canManagePermissionSets(access.currentRole, access.currentIsSuperUser);
  const canAssignLowStockTag = hasPermission(ACTION_PERMISSION_MAP.assignLowStockEmailTag, access.currentRole, access.customRoles || []);

  const view = document.createElement('section');
  view.className = 'userMgmtView';
  view.innerHTML = `
    <div class="userMgmtShell">
      <header class="userMgmtHeader">
        <div>
          <p>Administration</p>
          <h1>Workspace Employees</h1>
          <span>Manage employee access, assign roles, and keep workspace membership tidy.</span>
        </div>
        ${canManageUsers ? renderAddEmployeeButton() : ''}
      </header>

      ${userManagement.actionError ? renderNotice(userManagement.actionError, 'error') : ''}

      <div class="userMgmtLayout">
        <section class="userMgmtPanel userMgmtPanel--list">
          <div class="userMgmtPanelHead">
            <div>
              <h2>Active Team</h2>
              <span>${members.length} visible</span>
            </div>
          </div>

          <div class="userMgmtFilters">
            <label>
              ${renderFieldHelpLabel('Search Employees', 'Find a team member by name, surname, email, or assigned role.')}
              <input
                type="search"
                value="${escapeAttribute(filters.query)}"
                placeholder="Name, surname, email..."
                data-user-filter="query"
              />
            </label>

            ${renderDropdown({
              id: 'role',
              label: 'Role Filter',
              value: filters.role,
              openDropdown: filters.openDropdown,
              options: roleOptions
            })}
          </div>

          <div class="userMgmtTableWrap" data-scroll-key="user-management-list">
            <div class="userMgmtTableHead">
              <span>Employee</span>
              <span>Email</span>
              <span>Role</span>
              <span>Access</span>
              <span>Actions</span>
            </div>
            <div class="userMgmtTableBody">
              ${members.length ? members.map((member) => renderMemberRow(member, canManageUsers)).join('') : '<div class="userMgmtEmpty">No employees match the current filters.</div>'}
            </div>
          </div>
      </div>
    </div>

    ${canManageUsers && userManagement.createModalOpen ? renderCreateModal(draft, visibleRoleOptions, filters, canAssignLowStockTag, canManagePermissions, userManagement.createStep || 1, userManagement.actionError || '', access.locations || [], userManagement.actionStatus || '') : ''}
    ${editingMember ? renderEditModal(editingMember, visibleRoleOptions, filters, canAssignLowStockTag, canManagePermissions, access.locations || [], userManagement.editTab || 'details', userManagement.actionStatus || '', userManagement.actionError || '') : ''}
    ${confirmRemove ? renderDeleteDialog(confirmRemove) : ''}
    ${renderToast(userManagement.toast)}
  `;

  bindEvents(view, members, filters, onUserManagementFilterChange, onUserManagementAction);
  bindFieldHelpTooltips(view);
  return view;
}

function bindEvents(view, members, filters, onUserManagementFilterChange, onUserManagementAction) {
  view.querySelectorAll('[data-user-filter]').forEach((field) => {
    field.addEventListener('input', () => onUserManagementFilterChange?.({ [field.dataset.userFilter]: field.value }));
  });

  view.querySelectorAll('[data-user-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.userDropdown;
      onUserManagementFilterChange?.({ openDropdown: filters.openDropdown === id ? '' : id });
    });
  });

  view.addEventListener('click', (event) => {
    if (!filters.openDropdown || event.target.closest('[data-user-dropdown-root]')) return;
    onUserManagementFilterChange?.({ openDropdown: '' });
  });

  view.querySelectorAll('[data-user-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.dataset.userOptionGroup || '';
      const value = button.dataset.userOptionValue || '';
      if (group === 'role') {
        onUserManagementFilterChange?.({ role: value, openDropdown: '' });
        return;
      }
      if (group === 'user-create-role') {
        onUserManagementAction.onDraftChange?.({ role: value });
        onUserManagementFilterChange?.({ openDropdown: '' });
        return;
      }
      if (group === 'user-edit-role') {
        onUserManagementAction.onEditChange?.({ role: value });
        onUserManagementFilterChange?.({ openDropdown: '' });
      }
    });
  });

  view.querySelectorAll('[data-user-role-search]').forEach((field) => {
    field.addEventListener('input', () => {
      onUserManagementAction.onPreserveFocus?.(field);
      onUserManagementFilterChange?.({ [field.dataset.userRoleSearch]: field.value });
    });
  });

  view.querySelectorAll('[data-user-role-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      onUserManagementFilterChange?.({ [button.dataset.userRoleFilter]: button.dataset.userRoleFilterValue || 'all' });
    });
  });

  view.querySelectorAll('[data-user-draft-field]').forEach((field) => {
    const apply = () => {
      onUserManagementAction.onPreserveFocus?.(field);
      onUserManagementAction.onDraftChange?.({ [field.name]: field.type === 'checkbox' ? field.checked : field.value });
    };
    field.addEventListener('input', apply);
    field.addEventListener('change', apply);
  });

  view.querySelector('[data-user-create-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    onUserManagementAction.onCreate?.();
  });

  view.querySelectorAll('[data-user-open-create]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onOpenCreate?.());
  });

  view.querySelectorAll('[data-user-close-create]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onCloseCreate?.());
  });

  view.querySelectorAll('[data-user-next-step]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onNextStep?.());
  });

  view.querySelectorAll('[data-user-prev-step]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onPrevStep?.());
  });

  view.querySelectorAll('[data-user-location-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onUserManagementAction.onLocationToggle?.(checkbox.dataset.userLocationToggle, checkbox.checked);
    });
  });

  view.querySelector('[data-user-location-select-all]')?.addEventListener('change', (e) => {
    onUserManagementAction.onLocationSelectAll?.(e.target.checked);
  });

  view.querySelectorAll('[data-user-edit-location-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      onUserManagementAction.onEditLocationToggle?.(checkbox.dataset.userEditLocationToggle, checkbox.checked);
    });
  });

  view.querySelector('[data-user-edit-location-select-all]')?.addEventListener('change', (e) => {
    onUserManagementAction.onEditLocationSelectAll?.(e.target.checked);
  });

  view.querySelectorAll('[data-user-resend-invite]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onResendInvite?.(button.dataset.userResendInvite || ''));
  });

  view.querySelectorAll('[data-user-edit]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onOpenEdit?.(button.dataset.userEdit || ''));
  });

  view.querySelectorAll('[data-user-remove]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onRequestRemove?.(button.dataset.userRemove || ''));
  });

  view.querySelectorAll('[data-user-edit-field]').forEach((field) => {
    const apply = () => {
      onUserManagementAction.onPreserveFocus?.(field);
      onUserManagementAction.onEditChange?.({ [field.name]: field.type === 'checkbox' ? field.checked : field.value });
    };
    field.addEventListener('input', apply);
    field.addEventListener('change', apply);
  });

  view.querySelectorAll('[data-user-edit-tab]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onEditTabChange?.(button.dataset.userEditTab || 'details'));
  });

  view.querySelectorAll('[data-user-close-edit]').forEach((button) => {
    button.addEventListener('click', () => onUserManagementAction.onCloseEdit?.());
  });

  view.querySelector('[data-user-save-edit]')?.addEventListener('click', () => onUserManagementAction.onSaveEdit?.());
  view.querySelector('[data-user-confirm-remove]')?.addEventListener('click', () => onUserManagementAction.onConfirmRemove?.());
  view.querySelector('[data-user-cancel-remove]')?.addEventListener('click', () => onUserManagementAction.onCancelRemove?.());
  view.querySelector('[data-user-toast-close]')?.addEventListener('click', () => onUserManagementAction.onDismissToast?.());
}

function renderMemberRow(member, canManageUsers) {
  return `
    <article class="userMgmtRow">
      <div>
        <strong>${escapeHtml(member.name || '')}</strong>
        <small>${escapeHtml([member.firstName, member.surname].filter(Boolean).join(' ') || 'Workspace User')}</small>
      </div>
      <span>${escapeHtml(member.email || 'No email')}</span>
      <span><span class="userMgmtRoleBadge">${escapeHtml(toRoleLabel(member.role || 'member'))}</span></span>
      <span class="userMgmtBadgeStack">
        <span class="userMgmtStatusBadge userMgmtStatusBadge--${escapeAttribute(member.status || 'active')}">${member.status === 'invited' ? 'Invited' : 'Active'}</span>
        ${member.viewingOnly ? '<span class="userMgmtStatusBadge userMgmtStatusBadge--view">View Only</span>' : ''}
        ${member.lowStockAlert ? '<span class="userMgmtStatusBadge userMgmtStatusBadge--alert">Low Stock Email</span>' : ''}
      </span>
      <div class="userMgmtRowActions">
        ${canManageUsers ? `
          ${member.status === 'invited' ? `<button type="button" class="userMgmtIconButton userMgmtIconButton--resend" data-user-resend-invite="${escapeAttribute(member.key)}" aria-label="Resend invite">${icon('mail')}</button>` : ''}
          <button type="button" class="userMgmtIconButton" data-user-edit="${escapeAttribute(member.key)}" aria-label="Edit">${icon('edit')}</button>
          <button type="button" class="userMgmtIconButton userMgmtIconButton--danger" data-user-remove="${escapeAttribute(member.key)}" aria-label="Remove">${icon('trash')}</button>
        ` : '<span class="userMgmtMuted">Read only</span>'}
      </div>
    </article>
  `;
}

function renderAddEmployeeButton() {
  return `
    <div class="userMgmtHeaderActions">
      <button type="button" class="userMgmtHeaderActionButton userMgmtHeaderActionButton--primary" data-user-open-create>
        ${icon('plus')}
        <span>Add Employee</span>
      </button>
    </div>
  `;
}

function renderCreateModal(draft, roleOptions, filters = {}, canAssignLowStockTag = false, canManagePermissions = false, step = 1, actionError = '', locations = [], actionStatus = '') {
  if (actionStatus === 'saving' || actionStatus === 'refreshing') {
    const savingMsg = actionStatus === 'refreshing' ? 'Setting up account...' : 'Creating employee...';
    return `
      <div class="userMgmtModalBackdrop">
        <section class="userMgmtModalCard userMgmtModalCard--saving">
          <div class="userMgmtSavingOverlay">
            <span class="userMgmtSavingSpinner"></span>
            <strong>${savingMsg}</strong>
            <small>Sending invite email and refreshing workspace.</small>
          </div>
        </section>
      </div>
    `;
  }

  const stepLabels = ['Details', 'Role & Access', 'Locations'];
  const totalSteps = stepLabels.length;
  const stepsHtml = stepLabels.map((label, idx) => {
    const n = idx + 1;
    const cls = 'userMgmtOnboardingStep' + (n === step ? ' is-active' : '') + (n < step ? ' is-done' : '');
    const dot = n < step ? icon('check') : String(n);
    const sep = idx < stepLabels.length - 1 ? '<div class="userMgmtOnboardingStepLine"><\/div>' : '';
    return '<div class="' + cls + '"><span class="userMgmtOnboardingStepDot">' + dot + '<\/span><span>' + label + '<\/span><\/div>' + sep;
  }).join('');

  const stepTitles = ['Personal Details', 'Role & Access', 'Assigned Locations'];
  const stepSubtitles = [
    'Enter the employee&#39;s name and email address.',
    'Assign a role and configure workspace access.',
    'Restrict this employee to specific selling locations.'
  ];

  const step1Html = '<form class="userMgmtForm userMgmtForm--modal" data-user-create-form>' +
    '<section class="userMgmtModalSection userMgmtEmployeeDetails" aria-label="Employee details">' +
    '<div class="userMgmtGrid userMgmtGrid--2">' +
    renderTextInput({ label: 'First Name', help: 'The employee\'s first name as it should appear in team lists.', iconName: 'user', type: 'text', name: 'firstName', value: draft.firstName, fieldAttr: 'data-user-draft-field="firstName"', focusKey: 'user-member-first-name' }) +
    renderTextInput({ label: 'Surname', help: 'The employee\'s surname used for display and searching.', iconName: 'user', type: 'text', name: 'surname', value: draft.surname, fieldAttr: 'data-user-draft-field="surname"', focusKey: 'user-member-surname' }) +
    '</div>' +
    renderTextInput({ label: 'Email', help: 'This email becomes the employee login for this workspace.', iconName: 'mail', type: 'email', name: 'email', value: draft.email, fieldAttr: 'data-user-draft-field="email"', focusKey: 'user-member-email' }) +
    '</section>' +
    '<div class="userMgmtModalActions">' +
    '<button type="button" class="userMgmtGhostButton" data-user-close-create>Cancel</button>' +
    '<button type="button" class="userMgmtPrimaryButton" data-user-next-step><span>Next</span>' + icon('chevronRight') + '</button>' +
    '</div></form>';

  const step2Html = '<form class="userMgmtForm userMgmtForm--modal" data-user-create-form>' +
    renderRolePicker({ label: 'Assigned Role', roleOptions, activeRole: draft.role || 'member', dataPrefix: 'user-create', disabled: !canManagePermissions, searchKey: 'createRoleSearch', searchValue: filters.createRoleSearch || '', typeKey: 'createRoleType', typeValue: filters.createRoleType || 'all' }) +
    '<div class="userMgmtSupplementalOptions">' +
    renderAccessModeToggle(draft.viewingOnly) +
    renderLowStockAlertToggle(draft.lowStockAlert, false, canAssignLowStockTag) +
    '</div>' +
    '<div class="userMgmtModalActions">' +
    '<button type="button" class="userMgmtGhostButton" data-user-prev-step>' + icon('chevronLeft') + '<span>Back</span></button>' +
    '<button type="button" class="userMgmtPrimaryButton" data-user-next-step><span>Next</span>' + icon('chevronRight') + '</button>' +
    '</div></form>';

  const step3Html = '<form class="userMgmtForm userMgmtForm--modal" data-user-create-form>' +
    renderUserLocationPickerV2(draft.allowedLocations || [], locations) +
    '<div class="userMgmtModalActions">' +
    '<button type="button" class="userMgmtGhostButton" data-user-prev-step>' + icon('chevronLeft') + '<span>Back</span></button>' +
    '<button type="submit" class="userMgmtPrimaryButton">' + icon('userPlus') + '<span>Create &amp; Send Invite</span></button>' +
    '</div></form>';

  const bodyHtml = step === 1 ? step1Html : step === 2 ? step2Html : step3Html;

  return `
    <div class="userMgmtModalBackdrop">
      <section class="userMgmtModalCard">
        <header class="userMgmtModalHead">
          <div>
            <p>New Employee · Step ${step} of ${totalSteps}</p>
            <h3>${stepTitles[step - 1] || ''}</h3>
            <span>${stepSubtitles[step - 1] || ''}</span>
          </div>
          <button type="button" class="userMgmtIconButton" data-user-close-create aria-label="Close">${icon('x')}</button>
        </header>

        <div class="userMgmtOnboardingSteps">
          ${stepsHtml}
        </div>

        ${actionError ? `<div class="userMgmtNotice userMgmtNotice--error">${escapeHtml(actionError)}</div>` : ''}

        ${bodyHtml}
      </section>
    </div>
  `;
}

function renderEditModal(member, roleOptions, filters = {}, canAssignLowStockTag = false, canManagePermissions = false, locations = [], activeTab = 'details', actionStatus = '', actionError = '') {
  if (actionStatus === 'saving' || actionStatus === 'refreshing') {
    return `
      <div class="userMgmtModalBackdrop">
        <section class="userMgmtModalCard userMgmtModalCard--saving">
          <div class="userMgmtSavingOverlay">
            <span class="userMgmtSavingSpinner"></span>
            <strong>Saving changes...</strong>
            <small>Updating this employee's access.</small>
          </div>
        </section>
      </div>
    `;
  }

  const tabs = [
    { id: 'details', label: 'Details' },
    { id: 'role', label: 'Roles' },
    { id: 'locations', label: 'Locations' }
  ];
  const current = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'details';

  const pills = tabs.map((tab) => `
    <button type="button"
      class="userMgmtTabPill ${tab.id === current ? 'is-active' : ''}"
      role="tab"
      aria-selected="${tab.id === current}"
      data-user-edit-tab="${escapeAttribute(tab.id)}">
      ${escapeHtml(tab.label)}
    </button>
  `).join('');

  const detailsPanel = '<div class="userMgmtGrid userMgmtGrid--2">' +
    renderTextInput({
      label: 'First Name',
      help: 'Update the employee first name used across the workspace.',
      iconName: 'user',
      type: 'text',
      name: 'firstName',
      value: member.firstName || '',
      fieldAttr: 'data-user-edit-field="firstName"',
      focusKey: 'user-edit-first-name'
    }) +
    renderTextInput({
      label: 'Surname',
      help: 'Update the employee surname used across the workspace.',
      iconName: 'user',
      type: 'text',
      name: 'surname',
      value: member.surname || '',
      fieldAttr: 'data-user-edit-field="surname"',
      focusKey: 'user-edit-surname'
    }) +
    '</div>' +
    renderTextInput({
      label: 'Email',
      help: member.uid ? 'Active user emails are shown here for reference. They cannot be changed from this screen yet.' : 'Email used for this workspace access record.',
      iconName: 'mail',
      type: 'email',
      name: 'email',
      value: member.email || '',
      fieldAttr: 'data-user-edit-field="email"' + (member.uid ? ' disabled' : ''),
      focusKey: 'user-edit-email'
    });

  const rolePanel = renderRolePicker({
      label: 'Assigned Role',
      roleOptions,
      activeRole: member.role || 'admin',
      dataPrefix: 'user-edit',
      disabled: !canManagePermissions,
      searchKey: 'editRoleSearch',
      searchValue: filters.editRoleSearch || '',
      typeKey: 'editRoleType',
      typeValue: filters.editRoleType || 'all'
    }) +
    '<div class="userMgmtSupplementalOptions">' +
    renderAccessModeToggle(member.viewingOnly, true) +
    renderLowStockAlertToggle(member.lowStockAlert, true, canAssignLowStockTag) +
    '</div>';

  const locationsPanel = renderUserLocationPickerV2(member.allowedLocations || [], locations, true);

  return `
    <div class="userMgmtModalBackdrop">
      <section class="userMgmtModalCard userMgmtEditCard">
        <header class="userMgmtModalHead">
          <div>
            <p>Team Member</p>
            <h3>Edit Employee</h3>
            <span>Update employee details, role, and assigned locations.</span>
          </div>
          <button type="button" class="userMgmtIconButton" data-user-close-edit aria-label="Close">${icon('x')}</button>
        </header>

        ${actionError ? `<div class="userMgmtNotice userMgmtNotice--error">${escapeHtml(actionError)}</div>` : ''}

        <div class="userMgmtTabPills" role="tablist" aria-label="Edit employee sections">
          ${pills}
        </div>

        <div class="userMgmtTabBody">
          <div class="userMgmtTabPanel ${current === 'details' ? 'is-active' : ''}" data-tab-panel="details" role="tabpanel">${detailsPanel}</div>
          <div class="userMgmtTabPanel ${current === 'role' ? 'is-active' : ''}" data-tab-panel="role" role="tabpanel">${rolePanel}</div>
          <div class="userMgmtTabPanel ${current === 'locations' ? 'is-active' : ''}" data-tab-panel="locations" role="tabpanel">${locationsPanel}</div>
        </div>

        <div class="userMgmtModalActions">
          <button type="button" class="userMgmtGhostButton" data-user-close-edit>Cancel</button>
          <button type="button" class="userMgmtPrimaryButton" data-user-save-edit>${icon('save')}<span>Save Changes</span></button>
        </div>
      </section>
    </div>
  `;
}

function renderTextInput({ label, help, iconName, type = 'text', name, value = '', fieldAttr = '', focusKey = '' }) {
  return `
    <label class="userMgmtInputLabel">
      ${renderFieldHelpLabel(label, help)}
      <span class="userMgmtInputShell">
        ${icon(iconName)}
        <input type="${escapeAttribute(type)}" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}" ${fieldAttr} data-focus-key="${escapeAttribute(focusKey)}" />
      </span>
    </label>
  `;
}

function renderAccessModeToggle(viewingOnly = false, isEdit = false) {
  return `
    <label class="userMgmtAccessToggle">
      <input
        type="checkbox"
        name="viewingOnly"
        ${viewingOnly ? 'checked' : ''}
        ${isEdit ? 'data-user-edit-field="viewingOnly"' : 'data-user-draft-field="viewingOnly"'}
      />
      <span>
        <strong>Viewing Only</strong>
        <small>Allows corporate or franchise visibility without write access to transfers or stock changes.</small>
      </span>
    </label>
  `;
}

function renderLowStockAlertToggle(lowStockAlert = false, isEdit = false, canAssign = false) {
  if (!canAssign && !lowStockAlert) return '';
  return `
    <label class="userMgmtAccessToggle userMgmtAccessToggle--alert">
      <input
        type="checkbox"
        name="lowStockAlert"
        ${lowStockAlert ? 'checked' : ''}
        ${canAssign ? '' : 'disabled'}
        ${isEdit ? 'data-user-edit-field="lowStockAlert"' : 'data-user-draft-field="lowStockAlert"'}
      />
      <span>
        <strong>Low Stock Alert Tag</strong>
        <small>${canAssign ? 'Receives scheduled low-stock summary emails with the PDF summary attachment for this workspace.' : 'You need the Low Stock Email Tag permission to change this assignment.'}</small>
      </span>
    </label>
  `;
}

function renderExternalTransferToggle(canAccess = true, isEdit = false) {
  return `
    <label class="userMgmtAccessToggle">
      <input
        type="checkbox"
        name="canAccessExternalTransfers"
        ${canAccess ? 'checked' : ''}
        ${isEdit ? 'data-user-edit-field="canAccessExternalTransfers"' : 'data-user-draft-field="canAccessExternalTransfers"'}
      />
      <span>
        <strong>External Transfers</strong>
        <small>Allows this employee to create and receive external (inter-workspace) stock transfers.</small>
      </span>
    </label>
  `;
}

function renderUserLocationPicker(selected = [], locations = [], isEdit = false) {
  return renderUserLocationPickerV2(selected, locations, isEdit);
}

function renderUserLocationPickerV2(selected = [], locations = [], isEdit = false) {
  const checkedSet = new Set(selected.map((v) => String(v || '').trim()).filter(Boolean));
  const allChecked = locations.length > 0 && locations.every((loc) => checkedSet.has(String(loc.id || loc.locationId || '').trim()));
  const toggleAttr = isEdit ? 'data-user-edit-location-toggle' : 'data-user-location-toggle';
  const selectAllAttr = isEdit ? 'data-user-edit-location-select-all' : 'data-user-location-select-all';

  if (!locations.length) {
    return `
      <div class="userMgmtLocPickerEmpty">
        <span class="userMgmtLocPickerEmptyIcon">${icon('mapPin')}</span>
        <strong>No locations configured</strong>
        <small>Add selling locations in Settings before assigning them to employees.</small>
      </div>
    `;
  }

  const rows = locations.map((loc) => {
    const id = String(loc.id || loc.locationId || '').trim();
    const name = String(loc.displayName || loc.name || id).trim();
    const isChecked = checkedSet.has(id);
    return `
      <label class="userMgmtLocCard ${isChecked ? 'is-checked' : ''}">
        <span class="userMgmtLocCardCheck">
          <input type="checkbox" ${toggleAttr}="${escapeAttribute(id)}" ${isChecked ? 'checked' : ''} />
          <span class="userMgmtLocCardCheckMark">${icon('check')}</span>
        </span>
        <span class="userMgmtLocCardName">${escapeHtml(name)}</span>
        <span class="userMgmtLocCardType">${escapeHtml(String(loc.type || loc.kind || 'location').replace(/-/g, ' '))}</span>
      </label>
    `;
  });

  return `
    <div class="userMgmtLocPicker">
      <div class="userMgmtLocPickerHeader">
        <div>
          <p class="userMgmtLocPickerTitle">Selling Locations</p>
          <small class="userMgmtLocPickerHint">Select where this employee works. Leave all unchecked to allow all permitted locations.</small>
        </div>
        <label class="userMgmtLocSelectAll">
          <input type="checkbox" ${selectAllAttr} ${allChecked ? 'checked' : ''} />
          <span>Select All</span>
        </label>
      </div>
      <div class="userMgmtLocGrid">
        ${rows.join('')}
      </div>
      ${checkedSet.size > 0 ? `<p class="userMgmtLocPickerCount">${checkedSet.size} of ${locations.length} location${locations.length !== 1 ? 's' : ''} selected</p>` : ''}
    </div>
  `;
}

function renderDeleteDialog(member) {
  return `
    <div class="userMgmtModalBackdrop">
      <section class="userMgmtConfirmCard">
        <h3>Remove Employee</h3>
        <p>${escapeHtml(member.name || member.email || 'This employee')} will lose access to this workspace.</p>
        <div class="userMgmtModalActions">
          <button type="button" class="userMgmtGhostButton" data-user-cancel-remove>Keep User</button>
          <button type="button" class="userMgmtDangerButton" data-user-confirm-remove>Remove</button>
        </div>
      </section>
    </div>
  `;
}

const ROLE_PICKER_EXAMPLES = [
  { value: 'owner', label: 'Owner', badge: 'System', description: 'Full control over all settings and access.', icon: 'crown', tone: 'blue' },
  { value: 'admin', label: 'Admin', badge: 'System', description: 'Manage team members, stock, and workspace operations.', icon: 'shield', tone: 'blue' },
  { value: 'finance-admin', label: 'Finance Admin', badge: 'System', description: 'Manage billing, invoices, and payments.', icon: 'coin', tone: 'green' },
  { value: 'inventory-manager', label: 'Inventory Manager', badge: 'System', description: 'Oversee stock, suppliers, and inventory.', icon: 'box', tone: 'purple' },
  { value: 'operations-manager', label: 'Operations Manager', badge: 'System', description: 'Manage operations and store activities.', icon: 'briefcase', tone: 'amber' },
  { value: 'store-supervisor', label: 'Store Supervisor', badge: 'System', description: 'Supervise store staff and daily tasks.', icon: 'store', tone: 'cyan' },
  { value: 'cashier', label: 'Cashier', badge: 'System', description: 'Process sales and manage transactions.', icon: 'receipt', tone: 'blue' },
  { value: 'analyst', label: 'Analyst', badge: 'System', description: 'View dashboards and operational data.', icon: 'chart', tone: 'green' },
  { value: 'support', label: 'Support', badge: 'System', description: 'Assist users and resolve issues.', icon: 'headset', tone: 'purple' },
  { value: 'viewer', label: 'Viewer', badge: 'System', description: 'View-only access to most data.', icon: 'eye', tone: 'slate' }
];

const ROLE_PERMISSION_PREVIEWS = {
  owner: ['Manage team members', 'Manage stock', 'Manage settings'],
  admin: ['Manage team members', 'Manage stock', 'Manage settings'],
  'finance-admin': ['Manage settings', 'Review purchasing records', 'Manage billing'],
  'inventory-manager': ['Manage stock', 'Manage suppliers', 'Manage stock counts'],
  'operations-manager': ['Manage stock', 'Manage transfers', 'Manage daily operations'],
  'store-supervisor': ['Manage stock', 'Manage stock counts', 'Manage store activity'],
  cashier: ['View dashboard', 'Process sales records', 'Limited settings access'],
  analyst: ['View inventory data', 'Read-only dashboard access'],
  support: ['View team members', 'Assist users', 'View operational data', 'Limited settings access'],
  viewer: ['View dashboard', 'Read-only access', 'No write permissions']
};

function renderRolePicker({
  label,
  roleOptions,
  activeRole,
  dataPrefix,
  disabled = false,
  searchKey = 'roleSearch',
  searchValue = '',
  typeKey = 'roleType',
  typeValue = 'all'
}) {
  const roles = buildRolePickerOptions(roleOptions);
  const selected = roles.find((option) => option.value === activeRole) || roles.find((option) => option.value === 'admin') || roles[0];
  const filteredRoles = filterRolePickerOptions(roles, { search: searchValue, type: typeValue });
  const typeFilters = [
    { value: 'all', label: 'All' },
    { value: 'system', label: 'System' },
    { value: 'custom', label: 'Custom' }
  ];
  return `
    <section class="userMgmtRolePicker" aria-label="${escapeAttribute(label)}">
      ${renderFieldHelpLabel(label, 'Assign the permission pack this employee should use in the workspace.')}
      <div class="userMgmtRolePickerGrid">
        <div class="userMgmtRoleBrowser">
          <div class="userMgmtRoleToolbar">
            <label class="userMgmtRoleSearch">
              ${icon('search')}
              <input
                type="search"
                value="${escapeAttribute(searchValue)}"
                placeholder="Search roles"
                data-user-role-search="${escapeAttribute(searchKey)}"
                data-focus-key="${escapeAttribute(`${searchKey}-input`)}"
                ${disabled ? 'disabled' : ''}
              />
            </label>
            <div class="userMgmtRoleFilterChips" role="group" aria-label="Role type filter">
              ${typeFilters.map((filter) => `
                <button
                  type="button"
                  class="${(typeValue || 'all') === filter.value ? 'is-active' : ''}"
                  data-user-role-filter="${escapeAttribute(typeKey)}"
                  data-user-role-filter-value="${escapeAttribute(filter.value)}"
                  ${disabled ? 'disabled' : ''}
                >${escapeHtml(filter.label)}</button>
              `).join('')}
            </div>
          </div>
          <div class="userMgmtRoleList" role="radiogroup" aria-label="Available roles">
            ${filteredRoles.length ? filteredRoles.map((option) => renderRoleRow(option, selected.value, dataPrefix, disabled)).join('') : `
              <div class="userMgmtRoleEmpty">No roles match this search.</div>
            `}
          </div>
          <p class="userMgmtRoleTip">${icon('search')}<span>Tip: Use search to quickly find roles when there are many.</span></p>
        </div>
        ${renderSelectedRolePanel(selected)}
      </div>
      ${disabled ? '<small class="userMgmtMuted">Only owners, admins, and super users can change permission sets.</small>' : ''}
    </section>
  `;
}

function renderRoleRow(option, activeRole, dataPrefix, disabled = false) {
  const isActive = option.value === activeRole;
  return `
    <button
      type="button"
      class="userMgmtRoleRow userMgmtRoleRow--${escapeAttribute(option.tone || 'blue')} ${isActive ? 'is-active' : ''}"
      data-user-option
      data-user-option-group="${escapeAttribute(`${dataPrefix}-role`)}"
      data-user-option-value="${escapeAttribute(option.value)}"
      role="radio"
      aria-checked="${isActive ? 'true' : 'false'}"
      ${disabled ? 'disabled' : ''}
    >
      <span class="userMgmtRoleIcon">${icon(option.icon || 'shield')}</span>
      <span class="userMgmtRoleText">
        <strong>${escapeHtml(option.label)}</strong>
        <small>${escapeHtml(option.description)}</small>
      </span>
      <span class="userMgmtRoleCheck">${isActive ? icon('check') : ''}</span>
    </button>
  `;
}

function renderSelectedRolePanel(role) {
  const permissions = ROLE_PERMISSION_PREVIEWS[role.value] || inferRolePermissionPreview(role);
  return `
    <aside class="userMgmtRoleDetailsPanel" aria-label="Selected role details">
      <div class="userMgmtRoleDetailsHero">
        <span class="userMgmtRoleDetailsIcon">${icon(role.icon || 'shield')}</span>
        <div>
          <h4>${escapeHtml(role.label)}</h4>
          <span class="userMgmtRolePill">${escapeHtml(role.badge === 'Custom' ? 'Custom Role' : 'System Role')}</span>
          <p>${escapeHtml(role.description)}</p>
        </div>
      </div>
      <div class="userMgmtRolePermissions">
        <h5>Permissions preview</h5>
        <ul>
          ${permissions.map((permission) => `<li>${icon('check')}<span>${escapeHtml(permission)}</span></li>`).join('')}
        </ul>
      </div>
      <div class="userMgmtRoleHelper">
        ${icon('info')}
        <span>Permissions shown are a preview. Full details are applied after creation.</span>
      </div>
    </aside>
  `;
}

function buildRolePickerOptions(roleOptions = []) {
  // Only list roles that actually exist on the system (from roleOptions). The
  // ROLE_PICKER_EXAMPLES list is used purely as a metadata lookup (icon / tone /
  // description) for known role names — never as a source of extra roles.
  const metaByValue = new Map(ROLE_PICKER_EXAMPLES.map((role) => [role.value, role]));
  const map = new Map();
  (Array.isArray(roleOptions) ? roleOptions : []).forEach((option) => {
    const value = normalizePickerRoleValue(option.value || option.label);
    if (!value) return;
    const meta = metaByValue.get(value) || {};
    const badge = option.badge || meta.badge || 'Custom';
    map.set(value, {
      value,
      label: option.label || meta.label || toRoleLabel(value),
      badge,
      description: meta.description || roleDescriptionFor(option.label || value, badge),
      icon: meta.icon || roleIconFor(value),
      tone: meta.tone || roleToneFor(value, badge)
    });
  });
  return [...map.values()].sort((left, right) => roleSortScore(left) - roleSortScore(right) || left.label.localeCompare(right.label));
}

function filterRolePickerOptions(roles = [], { search = '', type = 'all' } = {}) {
  const query = String(search || '').trim().toLowerCase();
  const roleType = String(type || 'all').toLowerCase();
  return roles.filter((role) => {
    const isCustom = String(role.badge || '').toLowerCase().includes('custom');
    if (roleType === 'system' && isCustom) return false;
    if (roleType === 'custom' && !isCustom) return false;
    if (!query) return true;
    return [role.label, role.value, role.description, role.badge].some((value) => String(value || '').toLowerCase().includes(query));
  });
}

function inferRolePermissionPreview(role = {}) {
  const value = String(role.value || '').toLowerCase();
  if (value.includes('stock') || value.includes('inventory')) return ['Manage stock', 'Manage suppliers', 'View and export operational data', 'Manage stock counts'];
  if (value.includes('analyst') || value.includes('viewer')) return ['View dashboard', 'View and export operational data', 'View inventory data', 'Read-only access'];
  if (value.includes('manager') || value.includes('supervisor')) return ['Manage stock', 'View and export operational data', 'Manage store activity', 'Review team activity'];
  return ['View dashboard', 'View assigned operational data', 'Use permitted modules', 'Follow assigned access rules'];
}

function roleDescriptionFor(label = '', badge = '') {
  const text = String(label || '').toLowerCase();
  if (text.includes('owner')) return 'Full control over all settings and access.';
  if (text.includes('admin')) return 'Manage team members, stock, and workspace operations.';
  if (text.includes('manager')) return 'Manage daily operations and team workflows.';
  if (text.includes('viewer')) return 'View-only access to assigned data.';
  if (String(badge || '').toLowerCase().includes('custom')) return 'Custom permission set for this workspace.';
  return 'Standard workspace permission set.';
}

function roleIconFor(value = '') {
  const text = String(value || '').toLowerCase();
  if (text.includes('owner')) return 'crown';
  if (text.includes('finance')) return 'coin';
  if (text.includes('inventory') || text.includes('stock')) return 'box';
  if (text.includes('operation') || text.includes('manager')) return 'briefcase';
  if (text.includes('cashier')) return 'receipt';
  if (text.includes('analyst')) return 'chart';
  if (text.includes('support')) return 'headset';
  if (text.includes('viewer') || text.includes('view')) return 'eye';
  return 'shield';
}

function roleToneFor(value = '', badge = '') {
  if (String(badge || '').toLowerCase().includes('custom')) return 'purple';
  const text = String(value || '').toLowerCase();
  if (text.includes('finance') || text.includes('analyst')) return 'green';
  if (text.includes('operation')) return 'amber';
  if (text.includes('store')) return 'cyan';
  if (text.includes('viewer')) return 'slate';
  return 'blue';
}

function roleSortScore(role = {}) {
  const order = ROLE_PICKER_EXAMPLES.findIndex((item) => item.value === role.value);
  if (order >= 0) return order;
  return String(role.badge || '').toLowerCase().includes('custom') ? 100 : 50;
}

function normalizePickerRoleValue(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function renderDropdown({ id, label, value, openDropdown, options }) {
  const active = options.find((option) => option.value === value) || options[0];
  const isOpen = openDropdown === id;
  return `
    <div class="userMgmtDropdown ${isOpen ? 'userMgmtDropdown--open' : ''}" data-user-dropdown-root>
      ${renderFieldHelpLabel(label, 'Narrow the employee list by role.')}
      <button type="button" data-user-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}">
        <strong>${escapeHtml(active.label)}</strong>
        ${icon('chevron')}
      </button>
      <div class="userMgmtDropdownMenu">
        ${options.map((option) => `
          <button
            type="button"
            data-user-option
            data-user-option-group="${escapeAttribute(id)}"
            data-user-option-value="${escapeAttribute(option.value)}"
            class="${option.value === value ? 'is-active' : ''}"
          >
            <strong>${escapeHtml(option.label)}</strong>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderNotice(message, tone) {
  return `<div class="userMgmtNotice userMgmtNotice--${tone}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="userMgmtToast userMgmtToast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-user-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function renderLockedView(title) {
  const view = document.createElement('section');
  view.className = 'userMgmtView';
  view.innerHTML = `
    <div class="userMgmtShell">
      <div class="userMgmtEmpty">You do not currently have access to ${escapeHtml(title)}.</div>
    </div>
  `;
  return view;
}

function filterMembers(members, filters, { includeSuperUsers = false, superUsers = [] } = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const role = String(filters.role || '').trim().toLowerCase();
  return (members || []).filter((member) => {
    if (!includeSuperUsers && isSuperUserMember(member, superUsers)) return false;
    const matchesQuery = !query || [
      member.name,
      member.firstName,
      member.surname,
      member.email,
      toRoleLabel(member.role || 'member')
    ].some((value) => String(value || '').toLowerCase().includes(query));
    const matchesRole = !role || String(member.role || '').toLowerCase() === role;
    return matchesQuery && matchesRole;
  });
}

function isSuperUserRole(role = '') {
  const normalized = String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  return ['super', 'super-user', 'superuser', 'root'].includes(normalized);
}

function isSuperUserMember(member = {}, superUsers = []) {
  if (member.isSuperUser === true || isSuperUserRole(member.role)) return true;
  const uid = String(member.uid || member.key || '').trim();
  const email = String(member.email || '').trim().toLowerCase();
  return (superUsers || []).some((superUser) => (
    (uid && (String(superUser.uid || '') === uid || String(superUser.key || '') === uid)) ||
    (email && String(superUser.email || '').toLowerCase() === email)
  ));
}

function createEmptyDraft() {
  return { firstName: '', surname: '', email: '', password: '', role: 'admin', viewingOnly: false };
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

function icon(name) {
  const icons = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    userPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 10v6"/><path d="M12 7h.01"/></svg>',
    crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8 4 4 5-7 5 7 4-4-2 11H5Z"/><path d="M5 19h14"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></svg>',
    coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M14.5 8.5h-3a2 2 0 0 0 0 4h1a2 2 0 0 1 0 4h-3"/><path d="M12 7v10"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
    briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h16l-1-5H5Z"/><path d="M5 10v9h14v-9"/><path d="M9 19v-5h6v5"/><path d="M4 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></svg>',
    receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h3"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-3"/></svg>',
    headset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a8 8 0 0 1 16 0"/><path d="M4 13v4a2 2 0 0 0 2 2h1v-7H6a2 2 0 0 0-2 2Z"/><path d="M20 13v4a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2Z"/><path d="M16 19a4 4 0 0 1-4 2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>'
  };
  return icons[name] || '';
}
