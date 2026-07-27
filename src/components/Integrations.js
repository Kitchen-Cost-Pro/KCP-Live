import '../styles/integrations.css';
import gmailLogo from '../assets/integrations/gmail.svg';
import yocoLogo from '../assets/integrations/yoco.svg';
import {
  connectYocoIntegration,
  disconnectGmailIntegration,
  disconnectYocoIntegration,
  startGmailConnection,
  subscribeGmailIntegration,
  subscribeYocoIntegration,
  syncYocoCatalogue,
  syncYocoSales
} from '../services/integrationService.js';

const INTEGRATIONS = [
  {
    id: 'yoco',
    name: 'Yoco',
    category: 'POS & Payments',
    status: 'Available',
    stage: 'Primary',
    popular: true,
    description: 'Connect Yoco sales, payments, refunds, and tender data into Kitchen Cost Pro.',
    logo: yocoLogo,
    tone: 'blue',
    action: 'Prepare Setup'
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Email & Communications',
    status: 'Available',
    stage: 'Live',
    popular: true,
    description: 'Link a Gmail account to send supplier emails and purchase orders from the user account your team trusts.',
    logo: gmailLogo,
    tone: 'red',
    action: 'Connect Gmail'
  }
];

const CATEGORY_OPTIONS = [
  { value: 'all', label: 'All Categories' },
  { value: 'POS & Payments', label: 'POS & Payments' },
  { value: 'Email & Communications', label: 'Email & Communications' }
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'Active', label: 'Active' },
  { value: 'Available', label: 'Available' },
  { value: 'Setup Required', label: 'Setup Required' }
];

const yocoDrawerState = {
  open: false,
  busy: false,
  message: 'Sales history starts from the latest saved Yoco sale date. First connection imports all available Yoco sales history.',
  tone: '',
  summary: null
};

const gmailDrawerState = {
  open: false,
  busy: false,
  message: 'Connect Gmail with send-only permission for supplier communication.',
  tone: '',
  status: null
};

export function renderIntegrations({ state } = {}) {
  const workspaceName = state?.workspace?.siteName || 'Workspace';
  const workspaceId = state?.workspace?.id || '';
  const cachedYocoStatus = getCachedYocoStatus(workspaceId);
  const cachedGmailStatus = getCachedGmailStatus(workspaceId);
  const integrations = getRenderedIntegrations(cachedYocoStatus, cachedGmailStatus);
  const view = document.createElement('section');
  view.className = 'integrationsView';
  view.dataset.workspaceId = workspaceId;
  view.dataset.activeTab = 'all';
  view.dataset.category = 'all';
  view.dataset.status = 'all';
  view.innerHTML = `
    <div class="integrationsShell">
      <header class="integrationsHeader">
        <div>
          <p>Workspace Connections</p>
          <h1>Integrations</h1>
          <span>${escapeHtml(workspaceName)} integrations hub.</span>
        </div>
        <button type="button" class="integrationsDocsButton" data-integration-docs>
          ${icon('book')}
          <span>View API Documentation</span>
          ${icon('external')}
        </button>
      </header>

      <section class="integrationsToolbar" aria-label="Integration filters">
        <div class="integrationsTabs" role="tablist" aria-label="Integration status tabs">
          ${renderTab('all', 'All Integrations', true)}
          ${renderTab('available', 'Available', false)}
          ${renderTab('popular', 'Popular', false)}
        </div>
        <div class="integrationsFilters">
          <label class="integrationsSearch">
            ${icon('search')}
            <input type="search" placeholder="Search integrations..." data-integrations-search data-focus-key="integrations-search" />
          </label>
          ${renderDropdown('category', CATEGORY_OPTIONS, 'all')}
          ${renderDropdown('status', STATUS_OPTIONS, 'all')}
        </div>
      </section>

      <section class="integrationsGrid" data-integrations-grid>
        ${integrations.map(renderIntegrationCard).join('')}
      </section>

      <footer class="integrationsFooter">
        <span data-integrations-count>Showing ${integrations.length} of ${integrations.length} integrations</span>
        <div class="integrationsPager" aria-label="Integration pagination">
          <button type="button" disabled>${icon('chevronLeft')}</button>
          <strong>1</strong>
          <button type="button" disabled>${icon('chevronRight')}</button>
        </div>
      </footer>

      <div class="integrationsEmpty" data-integrations-empty hidden>
        <strong>No integrations match those filters.</strong>
        <span>Clear the search or choose a broader category.</span>
      </div>

      ${renderYocoModal()}
      ${renderGmailModal()}
    </div>
  `;

  bindIntegrationEvents(view);
  if (cachedYocoStatus) updateYocoStatus(view, cachedYocoStatus, { skipCache: true });
  if (cachedGmailStatus) updateGmailStatus(view, cachedGmailStatus, { skipCache: true });
  bindYocoStatus(view, workspaceId);
  bindGmailStatus(view, workspaceId);
  setYocoBusy(view, yocoDrawerState.busy);
  setGmailBusy(view, gmailDrawerState.busy);
  applyIntegrationFilters(view);
  return view;
}

function bindIntegrationEvents(view) {
  view.querySelector('[data-integrations-search]')?.addEventListener('input', () => applyIntegrationFilters(view));

  view.querySelectorAll('[data-integrations-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      view.dataset.activeTab = button.dataset.integrationsTab || 'all';
      view.querySelectorAll('[data-integrations-tab]').forEach((tab) => {
        const isActive = tab === button;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
      });
      applyIntegrationFilters(view);
    });
  });

  view.querySelectorAll('[data-integrations-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.integrationsDropdown || '';
      const root = button.closest('[data-integrations-dropdown-root]');
      const isOpen = root?.classList.contains('is-open');
      closeDropdowns(view);
      if (!isOpen) {
        root?.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
      }
      view.dataset.openDropdown = id;
    });
  });

  view.querySelectorAll('[data-integrations-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.dataset.integrationsOptionField || '';
      const value = button.dataset.integrationsOptionValue || 'all';
      view.dataset[field] = value;
      const root = button.closest('[data-integrations-dropdown-root]');
      const label = root?.querySelector('[data-integrations-dropdown-label]');
      if (label) label.textContent = button.textContent.trim();
      root?.querySelectorAll('[data-integrations-option]').forEach((option) => {
        option.classList.toggle('is-active', option === button);
      });
      closeDropdowns(view);
      applyIntegrationFilters(view);
    });
  });

  view.addEventListener('click', (event) => {
    if (event.target.closest('[data-integrations-dropdown-root]')) return;
    closeDropdowns(view);
  });

  view.querySelector('[data-integration-docs]')?.addEventListener('click', () => {
    const button = view.querySelector('[data-integration-docs]');
    if (!button) return;
    button.dataset.pulse = 'true';
    window.setTimeout(() => {
      if (button) button.dataset.pulse = 'false';
    }, 900);
  });

  view.querySelector('[data-yoco-open]')?.addEventListener('click', () => {
    openYocoModal(view);
  });

  view.querySelector('[data-gmail-open]')?.addEventListener('click', () => {
    openGmailModal(view);
  });

  view.querySelectorAll('[data-yoco-close]').forEach((button) => {
    button.addEventListener('click', () => closeYocoModal(view));
  });

  view.querySelectorAll('[data-gmail-close]').forEach((button) => {
    button.addEventListener('click', () => closeGmailModal(view));
  });

  view.querySelector('[data-yoco-connect-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const workspaceId = view.dataset.workspaceId || '';
    const input = view.querySelector('[data-yoco-api-key]');
    const apiKey = String(input?.value || '').trim();
    if (!apiKey) {
      setYocoModalStatus(view, 'Enter your Yoco API key first.', 'error');
      return;
    }
    await runYocoAction(view, 'Connecting Yoco and importing the catalogue...', async () => {
      const result = await connectYocoIntegration(workspaceId, apiKey);
      if (input) input.value = '';
      setYocoSummary(view, result);
      setYocoModalStatus(view, 'Yoco connected. Run Sync Sales when you need historical orders.', 'success');
    });
  });

  view.querySelector('[data-yoco-sync-sales]')?.addEventListener('click', async () => {
    await runYocoAction(view, 'Syncing Yoco sales...', async () => {
      const result = await syncYocoSales(view.dataset.workspaceId || '');
      setYocoSummary(view, result);
      setYocoModalStatus(view, 'Yoco sales sync complete.', 'success');
    });
  });

  view.querySelector('[data-yoco-sync-catalogue]')?.addEventListener('click', async () => {
    await runYocoAction(view, 'Syncing Yoco catalogue...', async () => {
      const result = await syncYocoCatalogue(view.dataset.workspaceId || '');
      setYocoSummary(view, result);
      setYocoModalStatus(view, 'Yoco catalogue sync complete.', 'success');
    });
  });

  view.querySelector('[data-yoco-disconnect]')?.addEventListener('click', async () => {
    await runYocoAction(view, 'Disconnecting Yoco...', async () => {
      await disconnectYocoIntegration(view.dataset.workspaceId || '');
      setYocoModalStatus(view, 'Yoco disconnected. Historical sales logs were kept.', 'success');
    });
  });

  view.querySelector('[data-gmail-connect]')?.addEventListener('click', async () => {
    await runGmailAction(view, 'Opening Google consent...', async () => {
      const result = await startGmailConnection(view.dataset.workspaceId || '');
      if (!result.authUrl) throw new Error('Gmail did not return a connection link.');
      const popup = window.open(result.authUrl, 'kcp-gmail-oauth', 'width=520,height=720,noopener,noreferrer');
      if (!popup) window.location.href = result.authUrl;
      setGmailModalStatus(view, 'Finish the Google consent screen, then this tile will update.', 'busy');
    }, { keepMessage: true });
  });

  view.querySelector('[data-gmail-disconnect]')?.addEventListener('click', async () => {
    await runGmailAction(view, 'Disconnecting Gmail...', async () => {
      await disconnectGmailIntegration(view.dataset.workspaceId || '');
      setGmailModalStatus(view, 'Gmail disconnected for this workspace.', 'success');
      updateGmailStatus(view, { status: 'disconnected', configured: true, connectionActive: false });
    });
  });

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'kcp:gmail-oauth') return;
    setGmailModalStatus(view, event.data.message || (event.data.ok ? 'Gmail connected.' : 'Gmail connection failed.'), event.data.ok ? 'success' : 'error');
    if (event.data.ok) {
      bindGmailStatus(view, view.dataset.workspaceId || '', { once: true });
    }
  }, { once: true });
}

function applyIntegrationFilters(view) {
  const query = String(view.querySelector('[data-integrations-search]')?.value || '').trim().toLowerCase();
  const activeTab = view.dataset.activeTab || 'all';
  const category = view.dataset.category || 'all';
  const status = view.dataset.status || 'all';
  let visibleCount = 0;

  view.querySelectorAll('[data-integration-card]').forEach((card) => {
    const haystack = String(card.dataset.search || '').toLowerCase();
    const matchesSearch = !query || haystack.includes(query);
    const matchesCategory = category === 'all' || card.dataset.category === category;
    const matchesStatus = status === 'all' || card.dataset.status === status;
    const matchesTab = activeTab === 'all' ||
      (activeTab === 'available' && ['Available', 'Active'].includes(card.dataset.status || '')) ||
      (activeTab === 'popular' && card.dataset.popular === 'true');
    const visible = matchesSearch && matchesCategory && matchesStatus && matchesTab;
    card.hidden = !visible;
    if (visible) visibleCount += 1;
  });

  const count = view.querySelector('[data-integrations-count]');
  if (count) count.textContent = `Showing ${visibleCount} of ${INTEGRATIONS.length} integrations`;
  const empty = view.querySelector('[data-integrations-empty]');
  if (empty) empty.hidden = visibleCount > 0;
}

function closeDropdowns(view) {
  view.querySelectorAll('[data-integrations-dropdown-root]').forEach((root) => {
    root.classList.remove('is-open');
    root.querySelector('[data-integrations-dropdown]')?.setAttribute('aria-expanded', 'false');
  });
}

function renderTab(id, label, active) {
  return `
    <button
      type="button"
      class="${active ? 'is-active' : ''}"
      role="tab"
      aria-selected="${active}"
      data-integrations-tab="${escapeAttribute(id)}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderDropdown(field, options, selectedValue) {
  const selected = options.find((option) => option.value === selectedValue) || options[0];
  return `
    <div class="integrationsDropdown" data-integrations-dropdown-root>
      <button type="button" data-integrations-dropdown="${escapeAttribute(field)}" aria-expanded="false">
        <span data-integrations-dropdown-label>${escapeHtml(selected.label)}</span>
        ${icon('chevronDown')}
      </button>
      <div class="integrationsDropdownMenu">
        ${options.map((option) => `
          <button
            type="button"
            data-integrations-option
            data-integrations-option-field="${escapeAttribute(field)}"
            data-integrations-option-value="${escapeAttribute(option.value)}"
            class="${option.value === selectedValue ? 'is-active' : ''}"
          >
            ${escapeHtml(option.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderIntegrationCard(item) {
  const search = `${item.name} ${item.category} ${item.status} ${item.description}`;
  const statusClass = getIntegrationStatusClass(item.status);
  return `
    <article
      class="integrationCard ${item.id === 'yoco' || item.id === 'gmail' ? 'integrationCard--featured' : ''}"
      data-integration-card
      data-integration-id="${escapeAttribute(item.id)}"
      data-category="${escapeAttribute(item.category)}"
      data-status="${escapeAttribute(item.status)}"
      data-popular="${item.popular ? 'true' : 'false'}"
      data-search="${escapeAttribute(search)}"
    >
      <div class="integrationCardTop">
        <div class="integrationLogo integrationLogo--${escapeAttribute(item.tone)}">
          ${item.logo
            ? `<img src="${escapeAttribute(item.logo)}" alt="${escapeAttribute(`${item.name} logo`)}" loading="lazy" />`
            : icon(item.icon || 'plug')}
        </div>
        <div>
          <h2>${escapeHtml(item.name)}</h2>
          <span>${escapeHtml(item.category)}</span>
        </div>
        <em class="${statusClass}">${escapeHtml(item.status)}</em>
      </div>
      <p>${escapeHtml(item.description)}</p>
      <div class="integrationMeta">
        <span>${escapeHtml(item.stage)}</span>
        ${item.popular ? '<span>Popular</span>' : '<span>Workspace Tool</span>'}
      </div>
      <div class="integrationActions">
        <button type="button" class="${item.id === 'yoco' || item.id === 'gmail' ? 'integrationPrimaryAction' : 'integrationGhostAction'}" ${item.id === 'yoco' ? 'data-yoco-open' : ''} ${item.id === 'gmail' ? 'data-gmail-open' : ''}>
          ${item.id === 'yoco' || item.id === 'gmail' ? icon('link') : icon('clock')}
          <span data-integration-action-label>${escapeHtml(item.action)}</span>
        </button>
      </div>
    </article>
  `;
}

function renderYocoModal() {
  const noticeTone = yocoDrawerState.tone ? ` data-tone="${escapeAttribute(yocoDrawerState.tone)}"` : '';
  return `
    <div class="yocoModalBackdrop" data-yoco-modal ${yocoDrawerState.open ? '' : 'hidden'}>
      <section class="yocoModalCard" role="dialog" aria-modal="true" aria-labelledby="yoco-modal-title">
        <header class="yocoModalHead">
          <div>
            <p>POS & Payments</p>
            <h2 id="yoco-modal-title">Connect Yoco</h2>
            <span data-yoco-live-status>Disconnected</span>
          </div>
          <button type="button" class="integrationIconAction" data-yoco-close aria-label="Close Yoco setup">${icon('x')}</button>
        </header>

        <div class="yocoDrawerBody">
          <form class="yocoConnectForm" data-yoco-connect-form>
            <label>
              <span>Personal API Key</span>
              <input type="password" autocomplete="off" placeholder="Paste your Yoco API key" data-yoco-api-key />
            </label>
            <button type="submit" class="integrationPrimaryAction" data-yoco-submit>
              ${icon('shieldCheck')}
              <span>Connect and Sync</span>
            </button>
          </form>

          <aside class="yocoKeyHelper" aria-label="Yoco API key helper">
            <div class="yocoKeyHelperIcon">${icon('keyRound')}</div>
            <div>
              <strong>Need your Yoco API key?</strong>
              <span>Open Yoco, sign in, then paste the key here.</span>
            </div>
            <a
              class="yocoKeyHelperButton"
              href="https://developer-iam.yoco.com/ui/login?flow=c9249270-71ae-46c1-8d7f-9414a0f6c64b"
              target="_blank"
              rel="noopener noreferrer"
            >
              ${icon('external')}
              <span>Get Your Yoco API Key Now</span>
            </a>
          </aside>

          <div class="yocoStatusGrid">
            <article>
              <span>Last Sync</span>
              <strong data-yoco-last-sync>Not synced yet</strong>
            </article>
            <article>
              <span>Catalogue</span>
              <strong data-yoco-catalogue-count>0 items</strong>
            </article>
            <article>
              <span>Product Modifiers</span>
              <strong data-yoco-modifier-count>0 modifiers</strong>
            </article>
            <article>
              <span>Locations</span>
              <strong data-yoco-location-count>0 locations</strong>
            </article>
            <article>
              <span>Webhook</span>
              <strong data-yoco-webhook-status>Not active</strong>
            </article>
          </div>

          <section class="yocoActionPanel" aria-label="Yoco manual controls">
            <div class="yocoActionPanelHead">
              <span>Manual controls</span>
              <strong>Run a focused Yoco sync when required.</strong>
            </div>
            <div class="yocoActionRow">
              <button type="button" class="yocoActionButton" data-yoco-sync-sales>
                <span class="yocoActionIcon">${icon('receiptText')}</span>
                <span><strong>Sync Sales</strong><small>Orders and refunds</small></span>
              </button>
              <button type="button" class="yocoActionButton" data-yoco-sync-catalogue>
                <span class="yocoActionIcon">${icon('boxes')}</span>
                <span><strong>Sync Catalogue</strong><small>Menu items and locations</small></span>
              </button>
              <button type="button" class="yocoActionButton yocoActionButton--danger" data-yoco-disconnect>
                <span class="yocoActionIcon">${icon('unlink')}</span>
                <span><strong>Disconnect</strong><small>Pause Yoco access</small></span>
              </button>
            </div>
          </section>

          <div class="yocoModalNotice" data-yoco-modal-status${noticeTone}>
            ${escapeHtml(yocoDrawerState.message)}
          </div>
          <div class="yocoResult" data-yoco-summary ${yocoDrawerState.summary ? '' : 'hidden'}>
            ${renderYocoSummaryEntries(yocoDrawerState.summary)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderGmailModal() {
  const status = gmailDrawerState.status || {};
  const isConnected = status.connectionActive === true;
  const isConfigured = status.configured !== false;
  const noticeTone = gmailDrawerState.tone ? ` data-tone="${escapeAttribute(gmailDrawerState.tone)}"` : '';
  return `
    <div class="yocoModalBackdrop" data-gmail-modal ${gmailDrawerState.open ? '' : 'hidden'}>
      <section class="yocoModalCard gmailModalCard" role="dialog" aria-modal="true" aria-labelledby="gmail-modal-title">
        <header class="yocoModalHead">
          <div>
            <p>Email & Communications</p>
            <h2 id="gmail-modal-title">Connect Gmail</h2>
            <span data-gmail-live-status>${isConnected ? `Connected as ${escapeHtml(status.accountEmail || 'Gmail')}` : isConfigured ? 'Disconnected' : 'Setup required'}</span>
          </div>
          <button type="button" class="integrationIconAction" data-gmail-close aria-label="Close Gmail setup">${icon('x')}</button>
        </header>

        <div class="yocoDrawerBody">
          <aside class="yocoKeyHelper gmailHelper" aria-label="Gmail permission helper">
            <div class="yocoKeyHelperIcon">${icon('mail')}</div>
            <div>
              <strong>Send-only Gmail access</strong>
              <span>KCP requests permission to send supplier emails. It does not request mailbox read access.</span>
            </div>
          </aside>

          <div class="yocoStatusGrid">
            <article>
              <span>Status</span>
              <strong data-gmail-status>${isConnected ? 'Connected' : isConfigured ? 'Ready' : 'Not configured'}</strong>
            </article>
            <article>
              <span>Account</span>
              <strong data-gmail-account>${escapeHtml(status.accountEmail || 'No account')}</strong>
            </article>
            <article>
              <span>Connected</span>
              <strong data-gmail-connected-at>${formatDateTime(status.connectedAt) || 'Not connected'}</strong>
            </article>
            <article>
              <span>Last Sent</span>
              <strong data-gmail-last-sent>${formatDateTime(status.lastSentAt) || 'No sends yet'}</strong>
            </article>
          </div>

          <section class="yocoActionPanel" aria-label="Gmail controls">
            <div class="yocoActionPanelHead">
              <span>Supplier communication</span>
              <strong>Linked Gmail will be used when sending purchase orders and supplier emails.</strong>
            </div>
            <div class="yocoActionRow">
              <button type="button" class="yocoActionButton" data-gmail-connect ${isConfigured ? '' : 'disabled'}>
                <span class="yocoActionIcon">${icon('link')}</span>
                <span><strong>${isConnected ? 'Reconnect Gmail' : 'Connect Gmail'}</strong><small>Google consent flow</small></span>
              </button>
              <button type="button" class="yocoActionButton yocoActionButton--danger" data-gmail-disconnect ${isConnected ? '' : 'disabled'}>
                <span class="yocoActionIcon">${icon('unlink')}</span>
                <span><strong>Disconnect</strong><small>Remove Gmail token</small></span>
              </button>
            </div>
          </section>

          <div class="yocoModalNotice" data-gmail-modal-status${noticeTone}>
            ${escapeHtml(gmailDrawerState.message)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function bindYocoStatus(view, workspaceId) {
  if (!workspaceId) return;
  const unsubscribe = subscribeYocoIntegration(workspaceId, (status) => updateYocoStatus(view, status));
  const observer = new MutationObserver(() => {
    if (document.body.contains(view)) return;
    unsubscribe?.();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function bindGmailStatus(view, workspaceId, options = {}) {
  if (!workspaceId) return;
  const unsubscribe = subscribeGmailIntegration(workspaceId, (status) => {
    updateGmailStatus(view, status);
    if (options.once) unsubscribe?.();
  });
  if (options.once) return;
  const observer = new MutationObserver(() => {
    if (document.body.contains(view)) return;
    unsubscribe?.();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function updateYocoStatus(view, status = {}, options = {}) {
  if (!options.skipCache) cacheYocoStatus(view.dataset.workspaceId || '', status);
  const isActive = isYocoStatusActive(status);
  const isSyncing = String(status.syncState || '').includes('syncing');
  const statusText = isActive ? (isSyncing ? 'Connected - syncing' : 'Connected') : status.status === 'error' ? 'Error' : 'Disconnected';
  setText(view, '[data-yoco-live-status]', statusText);
  setText(view, '[data-yoco-last-sync]', formatDateTime(status.lastSyncCompletedAt) || 'Not synced yet');
  setText(view, '[data-yoco-catalogue-count]', `${Number(status.catalogue?.itemsCount || 0)} items`);
  setText(view, '[data-yoco-modifier-count]', `${Number(status.catalogue?.productModifiersCount || 0)} modifiers`);
  setText(view, '[data-yoco-location-count]', `${Number(status.locations?.count || 0)} locations`);
  setText(view, '[data-yoco-webhook-status]', status.webhook?.enabled ? 'Active' : 'Not active');
  updateYocoCardStatus(view, isActive ? 'Active' : 'Available');
  if (status.lastError) setYocoModalStatus(view, status.lastError, 'error');
}

function updateYocoCardStatus(view, nextStatus) {
  const card = view.querySelector('[data-integration-id="yoco"]');
  if (!card) return;
  const badge = card.querySelector('em');
  const actionLabel = card.querySelector('[data-integration-action-label]');
  card.dataset.status = nextStatus;
  card.dataset.search = `${card.dataset.search || ''} ${nextStatus}`;
  if (badge) {
    badge.textContent = nextStatus;
    badge.className = getIntegrationStatusClass(nextStatus);
  }
  if (actionLabel) actionLabel.textContent = nextStatus === 'Active' ? 'Manage Yoco' : 'Prepare Setup';
  applyIntegrationFilters(view);
}

function updateGmailStatus(view, status = {}, options = {}) {
  gmailDrawerState.status = status;
  if (!options.skipCache) cacheGmailStatus(view.dataset.workspaceId || '', status);
  const nextStatus = status.configured === false
    ? 'Setup Required'
    : status.connectionActive === true
      ? 'Active'
      : 'Available';
  setText(view, '[data-gmail-live-status]', status.connectionActive ? `Connected as ${status.accountEmail || 'Gmail'}` : status.configured === false ? 'Setup required' : 'Disconnected');
  setText(view, '[data-gmail-status]', status.connectionActive ? 'Connected' : status.configured === false ? 'Not configured' : 'Ready');
  setText(view, '[data-gmail-account]', status.accountEmail || 'No account');
  setText(view, '[data-gmail-connected-at]', formatDateTime(status.connectedAt) || 'Not connected');
  setText(view, '[data-gmail-last-sent]', formatDateTime(status.lastSentAt) || 'No sends yet');
  updateIntegrationCardStatus(view, 'gmail', nextStatus, nextStatus === 'Active' ? 'Manage Gmail' : nextStatus === 'Setup Required' ? 'Needs Config' : 'Connect Gmail');
  if (status.lastError) setGmailModalStatus(view, status.lastError, 'error');
  else if (status.message && status.configured === false) setGmailModalStatus(view, status.message, 'error');
}

function updateIntegrationCardStatus(view, integrationId, nextStatus, nextActionLabel) {
  const card = view.querySelector(`[data-integration-id="${integrationId}"]`);
  if (!card) return;
  const badge = card.querySelector('em');
  const actionLabel = card.querySelector('[data-integration-action-label]');
  card.dataset.status = nextStatus;
  card.dataset.search = `${card.dataset.search || ''} ${nextStatus}`;
  if (badge) {
    badge.textContent = nextStatus;
    badge.className = getIntegrationStatusClass(nextStatus);
  }
  if (actionLabel) actionLabel.textContent = nextActionLabel;
  applyIntegrationFilters(view);
}

function getRenderedIntegrations(yocoStatus, gmailStatus) {
  const yocoActive = isYocoStatusActive(yocoStatus);
  const gmailCardStatus = gmailStatus?.configured === false
    ? 'Setup Required'
    : gmailStatus?.connectionActive === true
      ? 'Active'
      : 'Available';
  return INTEGRATIONS.map((item) => {
    if (item.id === 'gmail') {
      return {
        ...item,
        status: gmailCardStatus,
        action: gmailCardStatus === 'Active' ? 'Manage Gmail' : gmailCardStatus === 'Setup Required' ? 'Needs Config' : item.action
      };
    }
    if (item.id !== 'yoco') return item;
    return {
      ...item,
      status: yocoActive ? 'Active' : item.status,
      action: yocoActive ? 'Manage Yoco' : item.action
    };
  });
}

function isYocoStatusActive(status = {}) {
  const rawStatus = String(status?.status || '').trim().toLowerCase();
  return status?.connectionActive === true || rawStatus === 'connected' || status?.webhook?.enabled === true;
}

function yocoCacheKey(workspaceId) {
  return `kcp-yoco-status:${String(workspaceId || 'default')}`;
}

function gmailCacheKey(workspaceId) {
  return `kcp-gmail-status:${String(workspaceId || 'default')}`;
}

function getCachedYocoStatus(workspaceId) {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(yocoCacheKey(workspaceId));
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[Yoco] Could not read cached integration status:', error);
    return null;
  }
}

function cacheYocoStatus(workspaceId, status = {}) {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(yocoCacheKey(workspaceId), JSON.stringify({
      status: String(status.status || '').trim().toLowerCase() || 'disconnected',
      connectionActive: status.connectionActive === true,
      syncState: status.syncState || 'idle',
      lastSyncCompletedAt: status.lastSyncCompletedAt || '',
      webhook: status.webhook || {},
      catalogue: status.catalogue || {},
      locations: status.locations || {},
      cachedAt: new Date().toISOString()
    }));
  } catch (error) {
    console.warn('[Yoco] Could not cache integration status:', error);
  }
}

function getCachedGmailStatus(workspaceId) {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(gmailCacheKey(workspaceId));
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[Gmail] Could not read cached integration status:', error);
    return null;
  }
}

function cacheGmailStatus(workspaceId, status = {}) {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(gmailCacheKey(workspaceId), JSON.stringify({
      status: String(status.status || '').trim().toLowerCase() || 'disconnected',
      configured: status.configured !== false,
      connectionActive: status.connectionActive === true,
      accountEmail: status.accountEmail || '',
      accountName: status.accountName || '',
      connectedAt: status.connectedAt || '',
      connectedBy: status.connectedBy || '',
      lastSentAt: status.lastSentAt || '',
      lastError: status.lastError || '',
      message: status.message || '',
      cachedAt: new Date().toISOString()
    }));
  } catch (error) {
    console.warn('[Gmail] Could not cache integration status:', error);
  }
}

function getIntegrationStatusClass(status) {
  if (status === 'Active') return 'is-active';
  if (status === 'Available') return 'is-available';
  if (status === 'Setup Required') return 'is-placeholder';
  return 'is-placeholder';
}

function openYocoModal(view) {
  yocoDrawerState.open = true;
  const modal = view.querySelector('[data-yoco-modal]');
  if (modal) modal.hidden = false;
  view.querySelector('[data-yoco-api-key]')?.focus({ preventScroll: true });
}

function closeYocoModal(view) {
  yocoDrawerState.open = false;
  const modal = view.querySelector('[data-yoco-modal]');
  if (modal) modal.hidden = true;
}

function openGmailModal(view) {
  gmailDrawerState.open = true;
  const modal = view.querySelector('[data-gmail-modal]');
  if (modal) modal.hidden = false;
}

function closeGmailModal(view) {
  gmailDrawerState.open = false;
  const modal = view.querySelector('[data-gmail-modal]');
  if (modal) modal.hidden = true;
}

async function runYocoAction(view, message, task) {
  window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = true;
  setYocoBusy(view, true);
  setYocoModalStatus(view, message, 'busy');
  try {
    await task();
  } catch (error) {
    setYocoModalStatus(view, error.message || 'Yoco action failed.', 'error');
  } finally {
    setYocoBusy(view, false);
    window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = false;
    window.dispatchEvent(new CustomEvent('kcp:integrations-sync-complete'));
  }
}

async function runGmailAction(view, message, task, options = {}) {
  window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = true;
  setGmailBusy(view, true);
  setGmailModalStatus(view, message, 'busy');
  try {
    await task();
  } catch (error) {
    setGmailModalStatus(view, error.message || 'Gmail action failed.', 'error');
  } finally {
    setGmailBusy(view, false);
    window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = false;
    if (!options.keepMessage) window.dispatchEvent(new CustomEvent('kcp:integrations-sync-complete'));
  }
}

function setYocoBusy(view, busy) {
  yocoDrawerState.busy = busy;
  view.querySelectorAll('[data-yoco-submit], [data-yoco-sync-sales], [data-yoco-sync-catalogue], [data-yoco-disconnect]').forEach((button) => {
    button.disabled = busy;
  });
}

function setGmailBusy(view, busy) {
  gmailDrawerState.busy = busy;
  view.querySelectorAll('[data-gmail-connect], [data-gmail-disconnect]').forEach((button) => {
    const isDisconnect = button.hasAttribute('data-gmail-disconnect');
    const isConnect = button.hasAttribute('data-gmail-connect');
    button.disabled = busy ||
      (isConnect && gmailDrawerState.status?.configured === false) ||
      (isDisconnect && gmailDrawerState.status?.connectionActive !== true);
  });
}

function setYocoModalStatus(view, message, tone = 'busy') {
  yocoDrawerState.message = message;
  yocoDrawerState.tone = tone;
  const target = view.querySelector('[data-yoco-modal-status]');
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function setGmailModalStatus(view, message, tone = 'busy') {
  gmailDrawerState.message = message;
  gmailDrawerState.tone = tone;
  const target = view.querySelector('[data-gmail-modal-status]');
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function setYocoSummary(view, result = {}) {
  yocoDrawerState.summary = result;
  const target = view.querySelector('[data-yoco-summary]');
  if (!target) return;
  const content = renderYocoSummaryEntries(result);
  target.hidden = !content;
  target.innerHTML = content;
}

function renderYocoSummaryEntries(result = {}) {
  if (!result) return '';
  const entries = [
    ['Locations imported', result.locationsImported],
    ['Locations matched', result.locationsMatched],
    ['Products imported', result.productsImported],
    ['Products matched', result.productsMatched],
    ['Modifier groups stored', result.modifierGroupsStored],
    ['Product modifiers stored', result.productModifiersStored],
    ['Orders', result.ordersProcessed],
    ['Refunds', result.refundsProcessed],
    ['Missing recipes', result.missingRecipes],
    ['Webhook', result.webhookEnabled === true ? 'Active' : result.webhookError ? 'Needs setup' : undefined]
  ].filter(([, value]) => value !== undefined);
  return entries.map(([label, value]) => `<span><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</span>`).join('');
}

function setText(view, selector, value) {
  const target = view.querySelector(selector);
  if (target) target.textContent = value;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function icon(name) {
  const icons = {
    book: '<path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h8"/><path d="M8 11h8"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    boxes: '<path d="M2.5 7.5 12 2l9.5 5.5L12 13z"/><path d="M2.5 7.5V16L12 22l9.5-6V7.5"/><path d="M12 13v9"/><path d="m7 4.8 9.6 5.5"/>',
    external: '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M20 14v6H4V4h6"/>',
    keyRound: '<path d="M2 18a6 6 0 1 1 11.2-3H22l-2 2 2 2-2 2h-3l-2-2h-1.8A6 6 0 0 1 2 18z"/><circle cx="8" cy="18" r="1.5"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    plug: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M7 7h10v5a5 5 0 0 1-10 0z"/><path d="M12 17v4"/>',
    receiptText: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h4"/><path d="M6 22v-4H2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 3a7 7 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 3h5l.3-3a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5c.1-.3.1-.7.1-1z"/>',
    shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/>',
    unlink: '<path d="M15 7h1a5 5 0 0 1 0 10h-2"/><path d="M9 17H8A5 5 0 0 1 8 7h2"/><path d="m8 12 8 0"/><path d="m3 3 18 18"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${icons[name] || icons.plug}
    </svg>
  `;
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
