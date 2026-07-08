import styles from '../styles/navigation.module.css';

export const navigationGroups = [
  {
    label: 'Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { id: 'products', label: 'Menu Catalogue', icon: 'products' },
      { id: 'recipes', label: 'Recipes', icon: 'recipes' }
    ]
  },
  {
    label: 'Inventory',
    items: [
      { id: 'ingredients', label: 'Stock Items', icon: 'inventory' },
      { id: 'suppliers', label: 'Suppliers', icon: 'suppliers' },
      { id: 'purchase-orders', label: 'Purchase Orders', icon: 'clipboard' },
      { id: 'grv', label: 'GRV Entry', icon: 'receiving' },
      { id: 'credit-note', label: 'Credit Notes', icon: 'invoice' },
      { id: 'adjustments', label: 'Adjustments', icon: 'sliders' },
      { id: 'transfers', label: 'Transfers', icon: 'transfer' },
      { id: 'stock-count', label: 'Stock Take', icon: 'checklist' },
      { id: 'locations', label: 'Locations', icon: 'location' },
      { id: 'mfg-products', label: 'Manufacturing / Sub-Recipe', navLabel: 'Manufacturing', icon: 'factory' }
    ]
  },
  {
    label: 'Analysis',
    items: [
      { id: 'analytics', label: 'Reports', icon: 'analytics' },
      { id: 'integrations', label: 'Integrations', icon: 'plug' },
      { id: 'user-management', label: 'User Management', icon: 'team' },
      { id: 'custom-roles', label: 'Roles', icon: 'shield' }
    ]
  },
  {
    label: 'System',
    items: [
      {
        id: 'settings',
        label: 'Settings',
        icon: 'settings',
        children: [
          { id: 'settings-business', label: 'Business Settings', icon: 'settings' },
          { id: 'settings-customization', label: 'Customization', icon: 'palette' }
        ]
      }
    ]
  }
];

export function getNavigationItem(sectionId) {
  return navigationGroups
    .flatMap((group) => group.items)
    .flatMap((item) => [item, ...(item.children || [])])
    .find((item) => item.id === sectionId);
}

export function renderNavigation({
  activeSection = 'dashboard',
  workspace = {},
  settings = {},
  workspaceOptions = [],
  autoLoginPreference = null,
  user = {},
  allowedSections = [],
  onNavigate,
  onSignOut,
  onWorkspaceSelect,
  onAutoLoginToggle
} = {}) {
  const visibleGroups = filterNavigationGroups(allowedSections);
  const canSwitchWorkspace = (workspaceOptions || []).length > 1;
  const view = document.createElement('aside');
  view.className = styles.sidebar;
  // Stable, non-hashed hook so cross-module CSS (appShell) can recolor the nav
  // per section (e.g. solid on the Reports tab). CSS-module class names are hashed.
  view.setAttribute('data-app-sidebar', '');
  const logoDataUrl = String(settings.restaurantLogoDataUrl || settings.logoDataUrl || '').trim();
  view.innerHTML = `
    <div class="${styles.brand}">
      <div class="${styles.logoMark} ${logoDataUrl ? styles.logoMarkUploaded : ''}" aria-hidden="true">
        ${logoDataUrl
          ? `<img src="${escapeHtml(logoDataUrl)}" alt="" />`
          : 'KCP'}
      </div>
      <div class="${styles.brandText}">
        <strong>Kitchen Cost Pro</strong>
        <span>${escapeHtml(workspace.siteName || 'Live Workspace')}</span>
        ${canSwitchWorkspace ? `
          <button class="${styles.workspaceSwitcherTrigger}" type="button" data-workspace-toggle aria-expanded="false">
            <span>Switch Workspace</span>
            ${icon('chevronDown')}
          </button>
        ` : ''}
      </div>
      <button class="${styles.mobileMenuToggle}" type="button" data-mobile-menu-toggle aria-expanded="false" aria-label="Toggle navigation menu">
        ${icon('menu')}
      </button>
      ${canSwitchWorkspace ? renderWorkspaceSwitcher(workspace, workspaceOptions, autoLoginPreference) : ''}
    </div>

    <nav class="${styles.navScroll}" aria-label="Primary navigation" data-scroll-key="primary-navigation">
      ${visibleGroups.map((group) => renderGroup(group, activeSection)).join('')}
    </nav>

    <div class="${styles.accountPanel}">
      <div class="${styles.avatar}" aria-hidden="true">${escapeHtml(getInitials(user.email || user.displayName || 'KCP'))}</div>
      <div class="${styles.accountText}">
        <strong>${escapeHtml(user.displayName || 'Workspace User')}</strong>
        <span>${escapeHtml(user.email || 'Authenticated')}</span>
      </div>
      <button class="${styles.signOutButton}" type="button" data-sign-out title="Sign out" aria-label="Sign out">
        ${icon('logout')}
      </button>
    </div>
  `;

  view.addEventListener('click', (event) => {
    const navButton = event.target.closest('[data-nav-target]');
    if (navButton) {
      onNavigate?.(navButton.dataset.navTarget);
      view.dataset.mobileNavOpen = 'false';
      view.querySelector('[data-mobile-menu-toggle]')?.setAttribute('aria-expanded', 'false');
      return;
    }

    const navToggle = event.target.closest('[data-nav-toggle]');
    if (navToggle) {
      const group = navToggle.closest('[data-nav-branch]');
      const isOpen = group?.dataset.open === 'true';
      if (group) group.dataset.open = isOpen ? 'false' : 'true';
      navToggle.setAttribute('aria-expanded', String(!isOpen));
      return;
    }

    const mobileMenuToggle = event.target.closest('[data-mobile-menu-toggle]');
    if (mobileMenuToggle) {
      const isOpen = view.dataset.mobileNavOpen === 'true';
      view.dataset.mobileNavOpen = isOpen ? 'false' : 'true';
      mobileMenuToggle.setAttribute('aria-expanded', String(!isOpen));
      return;
    }

    const workspaceToggle = event.target.closest('[data-workspace-toggle]');
    if (workspaceToggle) {
      const switcher = view.querySelector('[data-workspace-switcher]');
      const isOpen = switcher?.dataset.open === 'true';
      if (switcher) switcher.dataset.open = isOpen ? 'false' : 'true';
      workspaceToggle.setAttribute('aria-expanded', String(!isOpen));
      if (!isOpen) {
        switcher?.querySelector('[data-workspace-filter]')?.focus({ preventScroll: true });
      }
      return;
    }

    const workspaceOption = event.target.closest('[data-workspace-option-button]');
    if (workspaceOption) {
      const workspaceId = workspaceOption.dataset.workspaceOptionButton || '';
      const selected = (workspaceOptions || []).find((option) => String(option.id) === String(workspaceId));
      if (selected) onWorkspaceSelect?.(selected);
      return;
    }

    if (event.target.closest('[data-sign-out]')) {
      onSignOut?.();
      view.dataset.mobileNavOpen = 'false';
      view.querySelector('[data-mobile-menu-toggle]')?.setAttribute('aria-expanded', 'false');
      return;
    }

    if (!event.target.closest('[data-workspace-switcher]') && !event.target.closest('[data-workspace-toggle]')) {
      const switcher = view.querySelector('[data-workspace-switcher]');
      const toggle = view.querySelector('[data-workspace-toggle]');
      if (switcher) switcher.dataset.open = 'false';
      toggle?.setAttribute('aria-expanded', 'false');
    }
  });

  view.querySelector('[data-workspace-filter]')?.addEventListener('input', (event) => {
    const query = String(event.currentTarget.value || '').trim().toLowerCase();
    const options = view.querySelectorAll('[data-workspace-option-button]');
    let visibleCount = 0;
    options.forEach((button) => {
      const haystack = String(button.dataset.workspaceSearch || '').toLowerCase();
      const matches = !query || haystack.includes(query);
      button.hidden = !matches;
      if (matches) visibleCount += 1;
    });
    const empty = view.querySelector('[data-workspace-empty]');
    if (empty) empty.hidden = visibleCount > 0;
  });

  view.querySelector('[data-auto-login-toggle]')?.addEventListener('change', (event) => {
    onAutoLoginToggle?.(event.currentTarget.checked);
  });

  const closeWorkspaceSwitcher = () => {
    const switcher = view.querySelector('[data-workspace-switcher]');
    const toggle = view.querySelector('[data-workspace-toggle]');
    if (switcher) switcher.dataset.open = 'false';
    toggle?.setAttribute('aria-expanded', 'false');
  };
  const handleDocumentPointerDown = (event) => {
    if (!view.isConnected) {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      return;
    }
    if (!view.contains(event.target)) closeWorkspaceSwitcher();
  };
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);

  return view;
}

function filterNavigationGroups(allowedSections = []) {
  const allowSet = new Set((allowedSections || []).map(String));
  if (!allowSet.size) return navigationGroups;
  return navigationGroups
    .map((group) => ({
      ...group,
      items: group.items
        .map((item) => {
          const children = (item.children || []).filter((child) => allowSet.has(String(child.id)));
          if (allowSet.has(String(item.id)) || children.length) return { ...item, children };
          return null;
        })
        .filter(Boolean)
    }))
    .filter((group) => group.items.length);
}

function renderWorkspaceSwitcher(currentWorkspace = {}, workspaceOptions = [], autoLoginPreference = null) {
  const autoLoginEnabled = Boolean(
    autoLoginPreference?.enabled &&
    String(autoLoginPreference.workspaceId || '') === String(currentWorkspace.id || '')
  );
  return `
    <div class="${styles.workspaceSwitcher}" data-workspace-switcher data-open="false">
      <label class="${styles.workspaceSearch}">
        <input type="search" placeholder="Search workspaces..." data-workspace-filter />
      </label>
      <div class="${styles.workspaceSwitcherList}">
        ${workspaceOptions.map((option) => {
          const isActive = String(option.id) === String(currentWorkspace.id || '');
          return `
            <button
              type="button"
              class="${styles.workspaceOptionButton} ${isActive ? styles.workspaceOptionButtonActive : ''}"
              data-workspace-option-button="${escapeHtml(option.id)}"
              data-workspace-search="${escapeHtml(`${option.siteName || ''} ${option.role || ''} ${option.id || ''}`)}"
              ${isActive ? 'aria-current="true"' : ''}
            >
              <strong>${escapeHtml(option.siteName || option.id)}</strong>
              <span>${escapeHtml(option.role || 'member')}</span>
            </button>
          `;
        }).join('')}
        <div class="${styles.workspaceEmpty}" data-workspace-empty hidden>No workspaces match that search.</div>
      </div>
      <label class="${styles.autoLoginToggle}">
        <input type="checkbox" data-auto-login-toggle ${autoLoginEnabled ? 'checked' : ''} />
        <span>
          <strong>Auto login</strong>
          <small>${autoLoginEnabled ? 'Opens after sign-in' : 'Use current workspace'}</small>
        </span>
        <span class="${styles.autoLoginTrack}" aria-hidden="true"></span>
      </label>
    </div>
  `;
}

function renderGroup(group, activeSection) {
  return `
    <section class="${styles.navGroup}">
      <p>${escapeHtml(group.label)}</p>
      <div class="${styles.navItems}">
        ${group.items.map((item) => renderItem(item, activeSection)).join('')}
      </div>
    </section>
  `;
}

function renderItem(item, activeSection) {
  if (Array.isArray(item.children) && item.children.length) return renderBranchItem(item, activeSection);
  const isActive = item.id === activeSection;
  const className = `${styles.navButton} ${isActive ? styles.navButtonActive : ''}`;
  const visibleLabel = item.navLabel || item.label;
  return `
    <button class="${className}" type="button" data-nav-target="${escapeHtml(item.id)}" title="${escapeHtml(item.label)}"${isActive ? ' aria-current="page"' : ''}>
      <span class="${styles.navIcon}" aria-hidden="true">${icon(item.icon)}</span>
      <span class="${styles.navLabel}">${escapeHtml(visibleLabel)}</span>
    </button>
  `;
}

function renderBranchItem(item, activeSection) {
  const children = item.children || [];
  const isActive = item.id === activeSection || children.some((child) => child.id === activeSection);
  const isOpen = isActive;
  const className = `${styles.navButton} ${isActive ? styles.navButtonActive : ''}`;
  const visibleLabel = item.navLabel || item.label;
  return `
    <div class="${styles.navBranch}" data-nav-branch data-open="${isOpen}">
      <button class="${className}" type="button" data-nav-toggle="${escapeHtml(item.id)}" aria-expanded="${isOpen}">
        <span class="${styles.navIcon}" aria-hidden="true">${icon(item.icon)}</span>
        <span class="${styles.navLabel}">${escapeHtml(visibleLabel)}</span>
        <span class="${styles.navChevron}" aria-hidden="true">${icon('chevronDown')}</span>
      </button>
      <div class="${styles.navChildren}">
        ${children.map((child) => renderChildItem(child, activeSection)).join('')}
      </div>
    </div>
  `;
}

function renderChildItem(item, activeSection) {
  const isActive = item.id === activeSection;
  const className = `${styles.navChildButton} ${isActive ? styles.navChildButtonActive : ''}`;
  const visibleLabel = item.navLabel || item.label;
  return `
    <button class="${className}" type="button" data-nav-target="${escapeHtml(item.id)}" title="${escapeHtml(item.label)}"${isActive ? ' aria-current="page"' : ''}>
      <span class="${styles.navChildDot}" aria-hidden="true"></span>
      <span class="${styles.navLabel}">${escapeHtml(visibleLabel)}</span>
    </button>
  `;
}

function icon(name) {
  const icons = {
    analytics: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-9"/>',
    checklist: '<path d="m4 6 1.5 1.5L8 5"/><path d="M11 6h9"/><path d="m4 12 1.5 1.5L8 11"/><path d="M11 12h9"/><path d="m4 18 1.5 1.5L8 17"/><path d="M11 18h9"/>',
    clipboard: '<path d="M9 4h6l1 2h3v14H5V6h3z"/><path d="M9 11h6"/><path d="M9 15h4"/>',
    dashboard: '<path d="M4 13a8 8 0 1 1 16 0"/><path d="M12 13l4-4"/><path d="M6.5 17h11"/>',
    factory: '<path d="M3 21V9l6 4V9l6 4h6v8z"/><path d="M7 17h2"/><path d="M13 17h2"/><path d="M18 17h1"/>',
    inventory: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    invoice: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/>',
    location: '<path d="M12 21s7-5.2 7-12a7 7 0 1 0-14 0c0 6.8 7 12 7 12z"/><circle cx="12" cy="9" r="2"/>',
    logout: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M14 4h5v16h-5"/>',
    plug: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M7 7h10v5a5 5 0 0 1-10 0z"/><path d="M12 17v4"/>',
    products: '<path d="M6 11h12"/><path d="M8 6h8a4 4 0 0 1 4 4H4a4 4 0 0 1 4-4z"/><path d="M5 15h14l-1 5H6z"/>',
    receiving: '<path d="M3 7h11v10H3z"/><path d="M14 11h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
    recipes: '<path d="M4 5a3 3 0 0 1 3-3h13v18H7a3 3 0 0 0-3 3z"/><path d="M8 6h8"/><path d="M8 10h6"/>',
    palette: '<path d="M12 22a10 10 0 1 1 10-10c0 1.7-1.3 3-3 3h-1.7c-.9 0-1.5.9-1.1 1.7l.3.6c.8 1.7-.4 3.7-2.3 3.7z"/><circle cx="7.5" cy="10.5" r=".8"/><circle cx="10.5" cy="7.5" r=".8"/><circle cx="14.5" cy="7.5" r=".8"/><circle cx="16.5" cy="11" r=".8"/>',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 3a7 7 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 3h5l.3-3a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5c.1-.3.1-.7.1-1z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-5"/>',
    sliders: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
    suppliers: '<path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M16 11a3 3 0 1 0 0-6"/><path d="M2 21a6 6 0 0 1 12 0"/><path d="M14 18a5 5 0 0 1 8 3"/>',
    sync: '<path d="M21 12a9 9 0 0 1-15 6.7L4 17"/><path d="M3 12a9 9 0 0 1 15-6.7L20 7"/><path d="M4 17v-5h5"/><path d="M20 7v5h-5"/>',
    team: '<path d="M16 11a4 4 0 1 0-8 0"/><path d="M3 21a7 7 0 0 1 14 0"/><path d="M17 13a5 5 0 0 1 4 8"/>',
    transfer: '<path d="M7 7h13l-3-3"/><path d="M20 7l-3 3"/><path d="M17 17H4l3 3"/><path d="M4 17l3-3"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>'
  };

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      ${icons[name] || icons.dashboard}
    </svg>
  `;
}

function getInitials(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'K';
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
