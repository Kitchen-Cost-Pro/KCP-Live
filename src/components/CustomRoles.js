import '../styles/customRoles.css';
import '../styles/fieldHelp.css';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';
import { ACTION_PERMISSION_MAP, DEFAULT_ROLES, SECTION_PERMISSION_MAP, canManagePermissionSets, toRoleLabel } from '../services/roleService.js';

export function renderCustomRoles({ state, onRoleManagementAction = {} } = {}) {
  const access = state.access || {};
  const roleManagement = state.roleManagement || {};

  if ((access.allowedSections || []).length && !(access.allowedSections || []).includes('custom-roles')) {
    return renderLockedView('Roles & Permissions');
  }

  const roles = access.roleCatalog || [];
  const editingRole = roleManagement.editingRole || null;
  const confirmDelete = roleManagement.confirmDelete || null;
  const locations = getRoleEditorLocations(state);
  const canManageRoles = canManagePermissionSets(access.currentRole, access.currentIsSuperUser);

  const view = document.createElement('section');
  view.className = 'customRolesView';
  view.innerHTML = `
    <div class="customRolesShell">
      <header class="customRolesHeader">
        <div>
          <p>Administration</p>
          <h1>Roles & Permissions</h1>
          <span>Control which sections, actions, and locations each workspace role can access.</span>
        </div>
        ${canManageRoles ? `<button type="button" class="customRolesPrimaryButton" data-role-new>${icon('plus')}<span>New Role</span></button>` : ''}
      </header>

      ${roleManagement.actionError ? renderNotice(roleManagement.actionError, 'error') : ''}

      <section class="customRolesTableCard">
        <div class="customRolesTableHead">
          <div>
            <h2>Defined Roles</h2>
            <span>${roles.length} roles</span>
          </div>
        </div>

        <div class="customRolesTableWrap" data-scroll-key="custom-roles-list">
          <div class="customRolesTableLabels">
            <span>Role Name</span>
            <span>Permissions</span>
            <span>Location Access</span>
            <span>Actions</span>
          </div>
          <div class="customRolesTableBody">
            ${roles.length ? roles.map((role) => renderRoleRow(role, canManageRoles)).join('') : '<div class="customRolesEmpty">No roles are defined yet.</div>'}
          </div>
        </div>
      </section>
    </div>

    ${editingRole ? renderRoleEditor(editingRole, locations) : ''}
    ${confirmDelete ? renderDeleteDialog(confirmDelete) : ''}
    ${renderToast(roleManagement.toast)}
  `;

  bindEvents(view, onRoleManagementAction);
  bindFieldHelpTooltips(view);
  return view;
}

function bindEvents(view, onRoleManagementAction) {
  view.querySelector('[data-role-new]')?.addEventListener('click', () => onRoleManagementAction.onOpenEditor?.(null));
  view.querySelectorAll('[data-role-edit]').forEach((button) => {
    button.addEventListener('click', () => onRoleManagementAction.onOpenEditor?.(button.dataset.roleEdit || ''));
  });
  view.querySelectorAll('[data-role-delete]').forEach((button) => {
    button.addEventListener('click', () => onRoleManagementAction.onRequestDelete?.(button.dataset.roleDelete || ''));
  });
  view.querySelectorAll('[data-role-close]').forEach((button) => {
    button.addEventListener('click', () => onRoleManagementAction.onCloseEditor?.());
  });
  view.querySelectorAll('[data-role-name]').forEach((field) => {
    field.addEventListener('input', () => {
      onRoleManagementAction.onPreserveFocus?.(field);
      onRoleManagementAction.onUpdateEditor?.({ label: field.value });
    });
  });
  view.querySelector('[data-role-location-all]')?.addEventListener('change', (event) => {
    onRoleManagementAction.onToggleAllLocations?.(event.currentTarget.checked);
  });
  view.querySelector('[data-role-location-search]')?.addEventListener('input', (event) => {
    filterRoleLocationOptions(event.currentTarget);
  });
  view.querySelectorAll('[data-role-permission]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => onRoleManagementAction.onTogglePermission?.(checkbox.dataset.rolePermission || '', checkbox.checked));
  });
  view.querySelectorAll('[data-role-location]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => onRoleManagementAction.onToggleLocation?.(checkbox.dataset.roleLocation || '', checkbox.checked));
  });
  view.querySelector('[data-role-save]')?.addEventListener('click', () => onRoleManagementAction.onSave?.());
  view.querySelector('[data-role-confirm-delete]')?.addEventListener('click', () => onRoleManagementAction.onConfirmDelete?.());
  view.querySelector('[data-role-cancel-delete]')?.addEventListener('click', () => onRoleManagementAction.onCancelDelete?.());
  view.querySelector('[data-role-toast-close]')?.addEventListener('click', () => onRoleManagementAction.onDismissToast?.());
}

function filterRoleLocationOptions(field) {
  const root = field.closest('.customRolesChecklistCard--locations');
  if (!root) return;
  const query = String(field.value || '').trim().toLowerCase();
  let visibleCount = 0;
  root.querySelectorAll('[data-role-location-option]').forEach((option) => {
    const text = String(option.dataset.roleLocationSearch || option.textContent || '').toLowerCase();
    const visible = !query || text.includes(query);
    option.hidden = !visible;
    if (visible) visibleCount += 1;
  });
  root.querySelectorAll('[data-role-location-group]').forEach((group) => {
    const hasVisibleOption = Array.from(group.querySelectorAll('[data-role-location-option]')).some((option) => !option.hidden);
    group.hidden = !hasVisibleOption;
  });
  const empty = root.querySelector('[data-role-location-empty]');
  if (empty) empty.hidden = visibleCount > 0;
}

function renderRoleRow(role, canManageRoles) {
  const locationLabel = (role.locations || []).includes('all')
    ? 'All Locations'
    : `${(role.locations || []).length} Locations`;
  const badge = role.isModified
    ? '<span class="customRolesBadge customRolesBadge--modified">Modified</span>'
    : role.isPreset
      ? '<span class="customRolesBadge">System</span>'
      : '<span class="customRolesBadge customRolesBadge--custom">Custom</span>';

  return `
    <article class="customRolesRow">
      <div class="customRolesNameCell">
        <strong>${escapeHtml(role.label || toRoleLabel(role.name || ''))}</strong>
        ${badge}
      </div>
      <span>${(role.permissions || []).length} Permissions</span>
      <span>${escapeHtml(locationLabel)}</span>
      <div class="customRolesRowActions">
        ${canManageRoles ? `
          <button type="button" class="customRolesIconButton" data-role-edit="${escapeAttribute(role.name)}" aria-label="Edit role">${icon('edit')}</button>
          <button type="button" class="customRolesIconButton customRolesIconButton--danger" data-role-delete="${escapeAttribute(role.name)}" aria-label="${role.isModified ? 'Reset role' : 'Delete role'}">${role.isModified ? icon('reset') : icon('trash')}</button>
        ` : '<span class="customRolesMuted">Read only</span>'}
      </div>
    </article>
  `;
}

function renderRoleEditor(role, locations) {
  const isPreset = DEFAULT_ROLES.some((entry) => entry.name === role.name);
  const allLocations = (role.locations || []).includes('all');
  const permissionGroups = buildPermissionGroups();
  const groupedLocations = groupRoleLocations(locations);

  return `
    <div class="customRolesModalBackdrop">
      <section class="customRolesModalCard" data-scroll-key="role-editor-modal">
        <header class="customRolesModalHead">
          <div>
            <p>Permission Pack</p>
            <h3>${isPreset ? 'Edit Role Override' : role.name ? 'Edit Role' : 'Create Role'}</h3>
          </div>
          <button type="button" class="customRolesIconButton" data-role-close aria-label="Close">${icon('x')}</button>
        </header>

        <div class="customRolesModalBody">
          <label class="customRolesModalField">
            ${renderFieldHelpLabel('Role Name', 'Use a clear name so managers know exactly which permission pack they are assigning.')}
            <input type="text" value="${escapeAttribute(role.label || '')}" data-role-name data-focus-key="role-editor-name" ${isPreset ? 'disabled' : ''} />
          </label>

          <div class="customRolesEditorGrid">
            <section class="customRolesChecklistCard">
              <strong>Permissions</strong>
              <div class="customRolesChecklist customRolesChecklist--groups">
                ${permissionGroups.map((group) => `
                  <section class="customRolesPermissionGroup">
                    <header>
                      <h4>${escapeHtml(group.label)}</h4>
                      ${group.description ? `<p>${escapeHtml(group.description)}</p>` : ''}
                    </header>
                    <div class="customRolesPermissionGroupList">
                      ${group.permissions.map((permission) => `
                        <label>
                          <input type="checkbox" data-role-permission="${escapeAttribute(permission.permissionId)}" ${role.permissions?.includes(permission.permissionId) ? 'checked' : ''} />
                          <span>${escapeHtml(permission.label)}</span>
                        </label>
                      `).join('')}
                    </div>
                  </section>
                `).join('')}
              </div>
            </section>

            <section class="customRolesChecklistCard customRolesChecklistCard--locations">
              <strong>Location Access</strong>
              <label class="customRolesLocationSearch">
                ${icon('search')}
                <input type="search" placeholder="Search locations..." data-role-location-search />
              </label>
              <label class="customRolesAllLocations">
                <input type="checkbox" data-role-location-all ${allLocations ? 'checked' : ''} />
                <span>Full Access (All Locations)</span>
              </label>
              <div class="customRolesChecklist ${allLocations ? 'is-disabled' : ''}">
                ${renderRoleLocationGroup('Selling Locations', groupedLocations.selling, role, allLocations)}
                ${renderRoleLocationGroup('Storage Locations', groupedLocations.storage, role, allLocations)}
                <div class="customRolesLocationEmpty" data-role-location-empty hidden>No locations match.</div>
              </div>
            </section>
          </div>
        </div>

        <div class="customRolesModalActions">
          <button type="button" class="customRolesGhostButton" data-role-close>Cancel</button>
          <button type="button" class="customRolesPrimaryButton" data-role-save>Save Role</button>
        </div>
      </section>
    </div>
  `;
}

function renderRoleLocationGroup(title, locations = [], role = {}, allLocations = false) {
  if (!locations.length) return '';
  return `
    <section class="customRolesLocationGroup" data-role-location-group>
      <header>${escapeHtml(title)}</header>
      ${locations.map((location) => {
        const locationId = String(location.id || location.locationId || '');
        const label = location.displayName || location.name || locationId;
        const meta = isStorageLocation(location) ? 'Storage' : 'Selling';
        return `
          <label data-role-location-option data-role-location-search="${escapeAttribute(`${label} ${meta}`)}">
            <input type="checkbox" data-role-location="${escapeAttribute(locationId)}" ${role.locations?.includes(locationId) ? 'checked' : ''} ${allLocations ? 'disabled' : ''} />
            <span>${escapeHtml(label)}</span>
            <em>${escapeHtml(meta)}</em>
          </label>
        `;
      }).join('')}
    </section>
  `;
}

function groupRoleLocations(locations = []) {
  return (locations || []).reduce((groups, location) => {
    const key = isStorageLocation(location) ? 'storage' : 'selling';
    groups[key].push(location);
    return groups;
  }, { selling: [], storage: [] });
}

function getRoleEditorLocations(state = {}) {
  const sources = [
    state.access?.locations,
    state.locations?.items,
    state.purchaseOrders?.locations,
    state.grv?.locations,
    state.stockTake?.locations
  ];
  const merged = new Map();
  sources.flatMap((source) => Array.isArray(source) ? source : []).forEach((location = {}) => {
    const id = String(location.id || location.locationId || '').trim();
    if (!id) return;
    const existing = merged.get(id) || {};
    merged.set(id, {
      ...existing,
      ...location,
      id,
      locationId: id,
      name: location.displayName || location.name || existing.name || id
    });
  });
  return [...merged.values()]
    .filter((location) => location.active !== false)
    .sort((left, right) => Number(isStorageLocation(left)) - Number(isStorageLocation(right)) || String(left.name || '').localeCompare(String(right.name || '')));
}

function isStorageLocation(location = {}) {
  const type = String(location.kind || location.type || location.locationType || '').toLowerCase();
  const id = String(location.id || location.locationId || '').toLowerCase();
  const name = String(location.displayName || location.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return location.isDefault === true || id === 'main' || type === 'storage' || name === 'mainstore';
}

function buildPermissionGroups() {
  const bySection = (sectionId) => ({
    permissionId: SECTION_PERMISSION_MAP[sectionId],
    label: toPermissionLabel(sectionId)
  });

  return [
    {
      label: 'Core Overview',
      description: 'Top-level operational visibility.',
      permissions: [
        bySection('dashboard')
      ]
    },
    {
      label: 'Product & Recipe Management',
      description: 'Catalogue and recipe maintenance.',
      permissions: [
        bySection('products'),
        bySection('recipes')
      ]
    },
    {
      label: 'Inventory Operations',
      description: 'Daily stock control, receiving, counting, movement, and manufacturing.',
      permissions: [
        bySection('ingredients'),
        bySection('suppliers'),
        bySection('purchase-orders'),
        bySection('grv'),
        bySection('credit-note'),
        bySection('adjustments'),
        bySection('transfers'),
        { permissionId: ACTION_PERMISSION_MAP.externalTransfers, label: 'External Transfers' },
        bySection('stock-count'),
        bySection('locations'),
        bySection('mfg-products')
      ]
    },
    {
      label: 'Reporting & Analysis',
      description: 'Operational reports, ledger views, exports, and reporting dashboards.',
      permissions: [
        bySection('reporting'),
        { permissionId: ACTION_PERMISSION_MAP.saveWorkspaceReportViews, label: 'Save Workspace Report Views' },
        { permissionId: ACTION_PERMISSION_MAP.scheduleReports, label: 'Schedule Reports' },
        { permissionId: ACTION_PERMISSION_MAP.emailReports, label: 'Email Reports' },
        { permissionId: ACTION_PERMISSION_MAP.manageReportSchedules, label: 'Manage All Report Schedules' },
        { permissionId: ACTION_PERMISSION_MAP.deleteReportSchedules, label: 'Delete Report Schedules' }
      ]
    },
    {
      label: 'Administration',
      description: 'Workspace setup, connected systems, users, and role control.',
      permissions: [
        bySection('integrations'),
        bySection('user-management'),
        bySection('custom-roles'),
        bySection('settings')
      ]
    },
    {
      label: 'Record Actions',
      description: 'Control record removal and stock count correction windows.',
      permissions: [
        { permissionId: ACTION_PERMISSION_MAP.deleteRecords, label: 'Delete / Remove Records' },
        { permissionId: ACTION_PERMISSION_MAP.bulkDelete, label: 'Bulk Delete Stock Items' },
        { permissionId: ACTION_PERMISSION_MAP.editStockTake7Days, label: 'Edit Stock Counts - 7 Days' },
        { permissionId: ACTION_PERMISSION_MAP.editStockTake30Days, label: 'Edit Stock Counts - 30 Days' }
      ]
    },
    {
      label: 'Security Actions',
      description: 'Sensitive access management tasks.',
      permissions: [
        { permissionId: ACTION_PERMISSION_MAP.manageUsers, label: 'Manage Workspace Employees' },
        { permissionId: ACTION_PERMISSION_MAP.manageRoles, label: 'Manage Roles & Permissions' },
        { permissionId: ACTION_PERMISSION_MAP.assignLowStockEmailTag, label: 'Assign Low Stock Email Tag' }
      ]
    }
  ];
}

function renderDeleteDialog(role) {
  return `
    <div class="customRolesModalBackdrop">
      <section class="customRolesConfirmCard">
        <h3>${role.isModified ? 'Reset Role Override' : 'Delete Role'}</h3>
        <p>${escapeHtml(role.label || toRoleLabel(role.name || ''))} will be ${role.isModified ? 'restored to the system default' : 'removed from this workspace'}.</p>
        <div class="customRolesModalActions">
          <button type="button" class="customRolesGhostButton" data-role-cancel-delete>Keep Role</button>
          <button type="button" class="customRolesDangerButton" data-role-confirm-delete>${role.isModified ? 'Reset' : 'Delete'}</button>
        </div>
      </section>
    </div>
  `;
}

function renderNotice(message, tone) {
  return `<div class="customRolesNotice customRolesNotice--${tone}">${escapeHtml(message)}</div>`;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="customRolesToast customRolesToast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-role-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

function renderLockedView(title) {
  const view = document.createElement('section');
  view.className = 'customRolesView';
  view.innerHTML = `
    <div class="customRolesShell">
      <div class="customRolesEmpty">You do not currently have access to ${escapeHtml(title)}.</div>
    </div>
  `;
  return view;
}

function toPermissionLabel(sectionId) {
  const labels = {
    dashboard: 'Dashboard',
    products: 'Menu Catalogue',
    recipes: 'Recipes',
    ingredients: 'Stock Items',
    suppliers: 'Suppliers',
    'purchase-orders': 'Purchase Orders',
    grv: 'GRV Entry',
    'credit-note': 'Credit Notes',
    adjustments: 'Adjustments',
    transfers: 'Transfers',
    'stock-count': 'Stock Take',
    locations: 'Locations',
    'mfg-products': 'Manufacturing',
    reporting: 'Reporting',
    integrations: 'Integrations',
    'user-management': 'User Management',
    'custom-roles': 'Roles & Permissions',
    settings: 'Settings'
  };
  return labels[sectionId] || toRoleLabel(sectionId);
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
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10V3h7"/><path d="M3 3l6 6"/><path d="M21 14a8 8 0 1 1-2.3-5.6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
  };
  return icons[name] || '';
}
