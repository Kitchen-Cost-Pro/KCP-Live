import { completeFirstLoginPasswordChange, confirmPasswordReset, getAuthSecurityConfig, registerWorkspaceAccount, requestPasswordReset, signIn } from './services/authService.js';
import styles from './styles/auth.module.css';

let authTurnstileSiteKey = '';
let authTurnstileEnabled = false;
let authTurnstileWidgetId = null;
let authTurnstileToken = '';
let authTurnstileConfigLoaded = false;
let authTurnstileConfigPromise = null;
let authTurnstileLoadTimer = null;

export function renderLogin({
  authState = {},
  user = null,
  workspaceOptions = [],
  autoLoginPreference = null,
  workspaceError = '',
  onWorkspaceSelect,
  onSignOut,
  onAuthModeChange,
  onRegistrationPending,
  onPasswordChangeComplete,
  onResetTokenComplete,
  onBusy,
  onError
}) {
  const isWorkspaceSelect = authState.status === 'workspace-select' && user && authState.mode !== 'register';
  const isRegistrationPending = authState.status === 'registration-pending';
  const isFirstPassword = (authState.status === 'force-password-reset' || authState.mode === 'set-password') && user;
  const isResetToken = authState.mode === 'reset-token';
  const isRegister = authState.mode === 'register' && !isWorkspaceSelect;
  const view = document.createElement('section');
  view.className = styles.loginShell;
  view.innerHTML = `
    <div class="${styles.loginFrame}">
      <div class="${styles.brandPanel}">
        <div class="${styles.logoMark}">KCP</div>
        <h1>Kitchen Cost <span>Pro</span></h1>
        <p class="${styles.intro}">Secure live workspace access for your kitchen operations.</p>
      </div>

      ${isWorkspaceSelect
        ? renderAuthenticatedCard({ user, workspaceOptions, workspaceError })
        : isFirstPassword
          ? renderFirstPasswordCard(authState, user)
        : isResetToken
          ? renderResetTokenCard(authState)
        : isRegistrationPending
          ? renderRegistrationPendingCard(authState)
          : isRegister
          ? renderRegistrationCard(authState, user)
          : renderCredentialsCard(authState)}
    </div>
    ${isWorkspaceSelect ? renderWorkspaceSelectModal({ user, workspaceOptions, autoLoginPreference, workspaceError, authState }) : ''}
  `;

  const form = view.querySelector('[data-login-form]');
  const registerForm = view.querySelector('[data-register-form]');
  const firstPasswordForm = view.querySelector('[data-first-password-form]');
  const resetTokenForm = view.querySelector('[data-reset-token-form]');
  const resetButton = view.querySelector('[data-reset-password]');
  const workspaceForm = view.querySelector('[data-workspace-form]');
  const workspaceSearch = view.querySelector('[data-workspace-search]');
  bootAuthTurnstile(view);

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const email = formData.get('email');
    const password = formData.get('password');

    try {
      const turnstileToken = await requireAuthTurnstileToken(view);
      onBusy?.();
      await signIn(email, password, { turnstileToken });
    } catch (error) {
      resetAuthTurnstile(view);
      onError?.(error.message || 'Could not sign in.');
    }
  });

  registerForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(registerForm);

    try {
      const turnstileToken = await requireAuthTurnstileToken(view);
      onBusy?.('Creating your workspace...', 'register');
      const result = await registerWorkspaceAccount({
        fullName: formData.get('fullName') || user?.displayName,
        siteName: formData.get('siteName'),
        email: user?.email || formData.get('email'),
        turnstileToken
      });
      onRegistrationPending?.({
        ...result,
        provider: 'email'
      });
    } catch (error) {
      resetAuthTurnstile(view);
      onError?.(error.message || 'Could not create your account.', 'register');
    }
  });

  firstPasswordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(firstPasswordForm);
    try {
      onBusy?.('Saving your new password...', 'set-password');
      await completeFirstLoginPasswordChange(formData.get('password'), formData.get('confirmPassword'));
      onPasswordChangeComplete?.();
    } catch (error) {
      onError?.(error.message || 'Could not update your password.', 'set-password');
    }
  });

  resetTokenForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(resetTokenForm);
    const resetToken = authState.resetToken || '';
    try {
      onBusy?.('Updating your password...', 'reset-token');
      await confirmPasswordReset(resetToken, formData.get('password'), formData.get('confirmPassword'));
      onResetTokenComplete?.();
    } catch (error) {
      onError?.(error.message || 'Could not reset your password.', 'reset-token');
    }
  });

  resetButton?.addEventListener('click', async () => {
    const email = new FormData(form).get('email');
    try {
      const turnstileToken = await requireAuthTurnstileToken(view);
      onBusy?.('Sending reset email...');
      await requestPasswordReset(email, { turnstileToken });
      onError?.('Password reset email sent. Check your inbox.');
    } catch (error) {
      resetAuthTurnstile(view);
      onError?.(error.message || 'Could not send reset email.');
    }
  });

  workspaceForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(workspaceForm);
    const workspaceId = String(formData.get('workspaceId') || '');
    const workspace = workspaceOptions.find((option) => String(option.id) === workspaceId);
    if (!workspace) {
      onError?.('Select a workspace to continue.');
      return;
    }
    onWorkspaceSelect?.(workspace, {
      autoLoginPreference: formData.get('autoLoginWorkspace') === 'on'
    });
  });

  workspaceSearch?.addEventListener('input', () => {
    const query = String(workspaceSearch.value || '').trim().toLowerCase();
    const options = view.querySelectorAll('[data-workspace-option]');
    let firstVisibleInput = null;

    options.forEach((option) => {
      const haystack = String(option.dataset.workspaceSearch || '').toLowerCase();
      const matches = !query || haystack.includes(query);
      option.hidden = !matches;
      if (matches && !firstVisibleInput) {
        firstVisibleInput = option.querySelector('input[type="radio"]');
      }
    });

    const checkedVisible = Array.from(options).some((option) => {
      if (option.hidden) return false;
      const input = option.querySelector('input[type="radio"]');
      return Boolean(input?.checked);
    });

    if (!checkedVisible && firstVisibleInput) {
      firstVisibleInput.checked = true;
    }

    const empty = view.querySelector('[data-workspace-empty-search]');
    if (empty) {
      empty.hidden = Array.from(options).some((option) => !option.hidden);
    }
  });

  view.querySelectorAll('[data-auth-signout]').forEach((button) => {
    button.addEventListener('click', () => onSignOut?.());
  });

  view.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      onAuthModeChange?.(button.dataset.authMode || 'login');
    });
  });

  return view;
}

function renderAuthTurnstilePanel() {
  return `
    <div class="${styles.turnstilePanel}" data-auth-turnstile-panel hidden>
      <div class="${styles.turnstileWidget}" data-auth-turnstile-widget></div>
      <p class="${styles.turnstileStatus}" data-auth-turnstile-status>Security check loading...</p>
      <button type="button" class="${styles.turnstileRetry}" data-auth-turnstile-retry>Retry security check</button>
    </div>
  `;
}

function getAuthTurnstileElements(root = document) {
  return {
    panel: root.querySelector?.('[data-auth-turnstile-panel]') || null,
    widget: root.querySelector?.('[data-auth-turnstile-widget]') || null,
    status: root.querySelector?.('[data-auth-turnstile-status]') || null,
    retry: root.querySelector?.('[data-auth-turnstile-retry]') || null
  };
}

function bootAuthTurnstile(root) {
  const { retry } = getAuthTurnstileElements(root);
  retry?.addEventListener('click', () => reloadAuthTurnstile(root));
  loadAuthTurnstileConfig(root).catch(() => markAuthTurnstileUnavailable(root));
}

async function loadAuthTurnstileConfig(root) {
  if (!authTurnstileConfigLoaded) {
    authTurnstileConfigPromise ||= getAuthSecurityConfig()
      .then((config = {}) => {
        authTurnstileSiteKey = String(config.siteKey || '').trim();
        authTurnstileEnabled = Boolean(config.enabled && authTurnstileSiteKey);
        authTurnstileConfigLoaded = true;
        return config;
      })
      .catch((error) => {
        authTurnstileConfigLoaded = true;
        authTurnstileEnabled = false;
        throw error;
      });
    await authTurnstileConfigPromise;
  }
  renderAuthTurnstile(root);
}

function ensureAuthTurnstileScript(root) {
  if (window.turnstile?.render) return;
  window.onKcpAppTurnstileLoad = () => {
    window.KCP_APP_TURNSTILE_LOAD_FAILED = false;
    renderAuthTurnstile(root);
  };
  if (document.querySelector('script[data-kcp-app-turnstile-script]')) return;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onKcpAppTurnstileLoad&render=explicit';
  script.async = true;
  script.defer = true;
  script.dataset.kcpAppTurnstileScript = 'true';
  script.onerror = () => markAuthTurnstileUnavailable(root);
  document.head.appendChild(script);
}

function renderAuthTurnstile(root = document) {
  const { panel, widget, status, retry } = getAuthTurnstileElements(root);
  if (!panel || !widget) return;
  if (!authTurnstileEnabled || !authTurnstileSiteKey) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  if (!window.turnstile?.render) {
    ensureAuthTurnstileScript(root);
    if (status) status.textContent = window.KCP_APP_TURNSTILE_LOAD_FAILED
      ? 'Security check could not load. Allow challenges.cloudflare.com, then retry.'
      : 'Security check loading...';
    retry?.classList.toggle(styles.isVisible, Boolean(window.KCP_APP_TURNSTILE_LOAD_FAILED));
    if (!authTurnstileLoadTimer && !window.KCP_APP_TURNSTILE_LOAD_FAILED) {
      authTurnstileLoadTimer = window.setTimeout(() => {
        authTurnstileLoadTimer = null;
        if (!window.turnstile?.render) markAuthTurnstileUnavailable(root);
      }, 7000);
    }
    return;
  }

  if (authTurnstileLoadTimer) {
    window.clearTimeout(authTurnstileLoadTimer);
    authTurnstileLoadTimer = null;
  }
  if (authTurnstileWidgetId !== null && widget.childElementCount > 0) return;
  authTurnstileToken = '';
  widget.innerHTML = '';
  retry?.classList.remove(styles.isVisible);
  authTurnstileWidgetId = window.turnstile.render(widget, {
    sitekey: authTurnstileSiteKey,
    theme: 'dark',
    callback: (token) => {
      authTurnstileToken = token || '';
      if (status) status.textContent = authTurnstileToken ? 'Security check ready' : 'Security check loading...';
    },
    'expired-callback': () => {
      authTurnstileToken = '';
      if (status) status.textContent = 'Security check expired. Please retry.';
      retry?.classList.add(styles.isVisible);
    },
    'error-callback': () => {
      authTurnstileToken = '';
      if (status) status.textContent = 'Security check failed. Please retry.';
      retry?.classList.add(styles.isVisible);
    }
  });
}

function markAuthTurnstileUnavailable(root, message = 'Security check could not load. Allow challenges.cloudflare.com, then retry.') {
  window.KCP_APP_TURNSTILE_LOAD_FAILED = true;
  authTurnstileToken = '';
  const { panel, status, retry } = getAuthTurnstileElements(root);
  if (panel && authTurnstileEnabled) panel.hidden = false;
  if (status) status.textContent = message;
  retry?.classList.add(styles.isVisible);
}

function reloadAuthTurnstile(root = document) {
  window.KCP_APP_TURNSTILE_LOAD_FAILED = false;
  authTurnstileToken = '';
  authTurnstileWidgetId = null;
  const { widget, status, retry } = getAuthTurnstileElements(root);
  if (widget) widget.innerHTML = '';
  if (status) status.textContent = 'Security check loading...';
  retry?.classList.remove(styles.isVisible);
  renderAuthTurnstile(root);
}

function resetAuthTurnstile(root = document) {
  authTurnstileToken = '';
  const { status } = getAuthTurnstileElements(root);
  if (authTurnstileWidgetId !== null && window.turnstile?.reset) {
    window.turnstile.reset(authTurnstileWidgetId);
  } else {
    authTurnstileWidgetId = null;
    renderAuthTurnstile(root);
  }
  if (status && authTurnstileEnabled) status.textContent = 'Security check loading...';
}

async function requireAuthTurnstileToken(root) {
  await loadAuthTurnstileConfig(root);
  if (!authTurnstileEnabled) return '';
  renderAuthTurnstile(root);
  if (window.KCP_APP_TURNSTILE_LOAD_FAILED && !window.turnstile?.render) {
    throw new Error('Security check could not load. Please allow challenges.cloudflare.com and retry.');
  }
  if (authTurnstileToken) return authTurnstileToken;
  if (authTurnstileWidgetId !== null && window.turnstile?.getResponse) {
    const token = window.turnstile.getResponse(authTurnstileWidgetId) || '';
    if (token) {
      authTurnstileToken = token;
      return token;
    }
  }
  throw new Error('Complete the security check before continuing.');
}

function renderCredentialsCard(authState) {
  return `
    <form class="${styles.loginCard}" data-login-form>
      <div>
        <p class="${styles.cardKicker}">Secure Sign In</p>
        <h2>Open Your Workspace</h2>
      </div>

      <label class="${styles.field}">
        <span>Email Address</span>
        <input type="email" name="email" autocomplete="email" placeholder="name@company.com" required />
      </label>

      <label class="${styles.field}">
        <span>Password</span>
        <input type="password" name="password" autocomplete="current-password" placeholder="Enter your password" required />
      </label>

      <div class="${styles.actionsRow}">
        <button type="button" class="${styles.linkButton}" data-reset-password>Forgot password?</button>
      </div>

      ${renderAuthTurnstilePanel()}

      ${authState.error ? `<div class="${styles.errorBox}" role="alert">${escapeHtml(authState.error)}</div>` : ''}

      <button class="${styles.primaryButton}" type="submit" ${authState.status === 'loading' ? 'disabled' : ''}>
        ${authState.status === 'loading' ? 'Authenticating...' : 'Sign In To Workspace'}
      </button>

      <p class="${styles.authSwitch}">
        Need an account?
        <button type="button" data-auth-mode="register">Create one</button>
      </p>
    </form>
  `;
}

function renderRegistrationCard(authState, user = null) {
  const userName = String(user?.displayName || '').trim();
  const userEmail = String(user?.email || '').trim();
  return `
    <form class="${styles.loginCard} ${styles.registerCard}" data-register-form>
      <div>
        <p class="${styles.cardKicker}">New Workspace</p>
        <h2>Create Your Account</h2>
      </div>

      <label class="${styles.field}">
        <span>Full Name</span>
        <input type="text" name="fullName" autocomplete="name" placeholder="Your name" value="${escapeAttribute(userName)}" required />
      </label>

      <label class="${styles.field}">
        <span>Workspace / Business Name</span>
        <input type="text" name="siteName" autocomplete="organization" placeholder="Restaurant or business name" required />
      </label>

      <label class="${styles.field}">
        <span>Email Address</span>
        <input type="email" name="email" autocomplete="email" placeholder="name@company.com" value="${escapeAttribute(userEmail)}" ${userEmail ? 'readonly' : 'required'} />
      </label>

      ${renderAuthTurnstilePanel()}

      ${authState.error ? `<div class="${styles.errorBox}" role="alert">${escapeHtml(authState.error)}</div>` : ''}

      <button class="${styles.primaryButton}" type="submit" ${authState.status === 'loading' ? 'disabled' : ''}>
        ${authState.status === 'loading' ? 'Sending Request...' : 'Request Approval'}
      </button>

      <p class="${styles.authSwitch}">
        Already have an account?
        <button type="button" data-auth-mode="login">Sign in</button>
      </p>
    </form>
  `;
}

function renderRegistrationPendingCard(authState) {
  return `
    <article class="${styles.loginCard} ${styles.sessionCard}">
      <div>
        <p class="${styles.cardKicker}">Request Submitted</p>
        <h2>Approval Pending</h2>
      </div>

      <div class="${styles.successBox}" role="status">
        ${escapeHtml(authState.message || 'Your workspace request has been sent to the admin team for approval.')}
      </div>

      <p class="${styles.sessionCopy}">
        Once approved in the KCP Admin Console, you will receive a temporary one-time password. Use it to sign in, then set your permanent password.
      </p>

      <button type="button" class="${styles.primaryButton}" data-auth-mode="login">
        Back To Sign In
      </button>
    </article>
  `;
}

function renderResetTokenCard(authState) {
  return `
    <form class="${styles.loginCard}" data-reset-token-form>
      <div>
        <p class="${styles.cardKicker}">Password Reset</p>
        <h2>Set New Password</h2>
      </div>

      <p class="${styles.sessionCopy}">
        Create a new password for your account. You'll be signed in automatically after saving.
      </p>

      <label class="${styles.field}">
        <span>New Password</span>
        <input type="password" name="password" autocomplete="new-password" placeholder="Minimum 8 characters" minlength="8" required />
      </label>

      <label class="${styles.field}">
        <span>Confirm Password</span>
        <input type="password" name="confirmPassword" autocomplete="new-password" placeholder="Confirm your password" minlength="8" required />
      </label>

      ${authState.error ? `<div class="${styles.errorBox}" role="alert">${escapeHtml(authState.error)}</div>` : ''}

      <button class="${styles.primaryButton}" type="submit" ${authState.status === 'loading' ? 'disabled' : ''}>
        ${authState.status === 'loading' ? 'Saving Password...' : 'Save New Password'}
      </button>
    </form>
  `;
}

function renderFirstPasswordCard(authState, user) {
  return `
    <form class="${styles.loginCard}" data-first-password-form>
      <div>
        <p class="${styles.cardKicker}">First-Time Sign In</p>
        <h2>Set Your Password</h2>
        <p class="${styles.workspaceUser}">${escapeHtml(user.email || 'Authenticated user')}</p>
      </div>

      <p class="${styles.sessionCopy}">
        You signed in with a temporary one-time password. Create your permanent password to continue.
      </p>

      <label class="${styles.field}">
        <span>New Password</span>
        <input type="password" name="password" autocomplete="new-password" placeholder="Minimum 8 characters" minlength="8" required />
      </label>

      <label class="${styles.field}">
        <span>Confirm Password</span>
        <input type="password" name="confirmPassword" autocomplete="new-password" placeholder="Confirm your password" minlength="8" required />
      </label>

      ${authState.error ? `<div class="${styles.errorBox}" role="alert">${escapeHtml(authState.error)}</div>` : ''}

      <button class="${styles.primaryButton}" type="submit" ${authState.status === 'loading' ? 'disabled' : ''}>
        ${authState.status === 'loading' ? 'Saving Password...' : 'Save Password'}
      </button>

      <button type="button" class="${styles.signOutButton}" data-auth-signout>
        Sign Out
      </button>
    </form>
  `;
}

function renderAuthenticatedCard({ user, workspaceOptions, workspaceError }) {
  const hasWorkspaces = workspaceOptions.length > 0;
  return `
    <article class="${styles.loginCard} ${styles.sessionCard}">
      <div>
        <p class="${styles.cardKicker}">Authenticated Session</p>
        <h2>${hasWorkspaces ? 'Choose Your Workspace' : 'Workspace Required'}</h2>
        <p class="${styles.workspaceUser}">${escapeHtml(user.email || 'Authenticated user')}</p>
      </div>
      ${workspaceError ? `<div class="${styles.errorBox}" role="alert">${escapeHtml(workspaceError)}</div>` : ''}
      <p class="${styles.sessionCopy}">
        ${hasWorkspaces
          ? 'Select the organisation and site you want to open from the workspace picker.'
          : 'This account is signed in, but no active workspace is linked to the profile yet.'}
      </p>
      <button type="button" class="${styles.signOutButton}" data-auth-signout>
        Sign Out
      </button>
      ${hasWorkspaces ? '' : `
        <button type="button" class="${styles.primaryButton}" data-auth-mode="register">
          Request Workspace Approval
        </button>
      `}
    </article>
  `;
}

function renderWorkspaceSelectModal({ user, workspaceOptions, autoLoginPreference, workspaceError, authState }) {
  const savedWorkspaceId = autoLoginPreference?.enabled ? String(autoLoginPreference.workspaceId || '') : '';
  const hasSavedWorkspace = Boolean(savedWorkspaceId && workspaceOptions.some((workspace) => String(workspace.id) === savedWorkspaceId));
  const firstWorkspaceId = hasSavedWorkspace ? savedWorkspaceId : workspaceOptions[0]?.id || '';
  return `
    <div class="${styles.workspaceOverlay}" role="presentation">
      <form class="${styles.workspaceModal}" data-workspace-form>
        <div class="${styles.workspaceModalHeader}">
          <p class="${styles.cardKicker}">Workspace Selection</p>
          <h2>Choose your workspace</h2>
          <p class="${styles.workspaceIntro}">Select the organisation and site you want to manage.</p>
          <p class="${styles.workspaceUser}">
            <span>${icon('user')}</span>
            Signed in as ${escapeHtml(user.email || 'Authenticated user')}
          </p>
        </div>

        ${workspaceError ? `<div class="${styles.errorBox}" role="alert">${escapeHtml(workspaceError)}</div>` : ''}

        ${workspaceOptions.length > 1 ? `
          <label class="${styles.workspaceSearch}">
            <span>Search</span>
            <span class="${styles.workspaceSearchControl}">
              ${icon('search')}
              <input type="search" placeholder="Search by organisation or site name..." data-workspace-search />
            </span>
          </label>
        ` : ''}

        <div class="${styles.workspaceList}" role="radiogroup" aria-label="Available workspaces">
          ${workspaceOptions.length ? workspaceOptions.map((workspace, index) => `
            <label class="${styles.workspaceOption}" data-workspace-option data-workspace-search="${escapeAttribute(`${workspace.siteName || ''} ${workspace.role || ''} ${workspace.id || ''}`)}">
              <input
                type="radio"
                name="workspaceId"
                value="${escapeAttribute(workspace.id)}"
                ${String(workspace.id) === String(firstWorkspaceId) || (!firstWorkspaceId && index === 0) ? 'checked' : ''}
              />
              <span class="${styles.workspaceInitials}">${escapeHtml(getWorkspaceInitials(workspace))}</span>
              <span>
                <strong>${escapeHtml(workspace.siteName || workspace.id)}</strong>
                <small>${escapeHtml(getWorkspaceSubtitle(workspace))}</small>
              </span>
              <em>${escapeHtml(toRoleLabel(workspace.role || 'member'))}</em>
              <i aria-hidden="true">${icon('check')}</i>
            </label>
          `).join('') : `
            <div class="${styles.emptyWorkspaces}">
              No active workspaces are linked to this profile.
            </div>
          `}
          <div class="${styles.emptyWorkspaces}" data-workspace-empty-search hidden>
            No workspaces match that search.
          </div>
        </div>

        ${workspaceOptions.length ? `
          <label class="${styles.autoLoginOption}">
            <input type="checkbox" name="autoLoginWorkspace" ${hasSavedWorkspace ? 'checked' : ''} />
            <span class="${styles.autoLoginSwitch}" aria-hidden="true"></span>
            <span>
              <strong>Auto login to this workspace</strong>
              <small>Next time, open the selected site automatically after sign-in.</small>
            </span>
          </label>
        ` : ''}

        ${authState.error ? `<div class="${styles.errorBox}" role="alert">${escapeHtml(authState.error)}</div>` : ''}

        <div class="${styles.workspaceModalActions}">
          <button type="button" class="${styles.signOutButton}" data-auth-signout>
            Sign Out
          </button>
          <button class="${styles.primaryButton}" type="submit" ${!workspaceOptions.length ? 'disabled' : ''}>
            Continue
          </button>
        </div>
      </form>
    </div>
  `;
}

function getWorkspaceInitials(workspace = {}) {
  const label = String(workspace.siteName || workspace.id || 'Workspace').trim();
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length > 1) return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

function getWorkspaceSubtitle(workspace = {}) {
  const siteName = String(workspace.siteName || '').trim();
  const id = String(workspace.id || '').trim();
  const parts = siteName.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(1).join(' ');
  return id || 'Workspace';
}

function toRoleLabel(role = '') {
  return String(role || 'member')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ') || 'Member';
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
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 12 4 4 8-8"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>'
  };
  return icons[name] || '';
}

