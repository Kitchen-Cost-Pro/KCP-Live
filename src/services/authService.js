import {
  callCloudflareRoute,
  clearCloudSession,
  getCloudSession,
  setCloudSession
} from './cloudflareApi.js';


let currentUser = null;
const listeners = new Set();

function normalizeUser(user = null) {
  if (!user) return null;
  const token = String(user.token || getCloudSession()?.token || '').trim();
  return {
    uid: String(user.uid || user.id || '').trim(),
    id: String(user.id || user.uid || '').trim(),
    email: String(user.email || '').trim().toLowerCase(),
    displayName: String(user.displayName || user.name || '').trim(),
    providerData: Array.isArray(user.providerData) ? user.providerData : [{ providerId: 'email' }],
    getIdToken: async () => token
  };
}

function emitAuthChange() {
  listeners.forEach((callback) => callback(currentUser));
}

export function getEmailKey(email = '') {
  return String(email || '').trim().toLowerCase().replace(/\./g, '_');
}

export async function getAuthSecurityConfig() {
  const result = await callCloudflareRoute('api/auth/security-config');
  return result.turnstile || {};
}

export function listenToAuthChanges(callback) {
  listeners.add(callback);
  window.queueMicrotask(async () => {
    const session = getCloudSession();
    if (!session?.token) {
      currentUser = null;
      callback(null);
      return;
    }
    try {
      const result = await callCloudflareRoute('api/auth/me', { token: session.token });
      currentUser = normalizeUser({ ...result.user, token: session.token });
      setCloudSession({ ...session, user: currentUser, profile: result.profile });
      callback(currentUser);
    } catch {
      clearCloudSession();
      currentUser = null;
      callback(null);
    }
  });
  return () => listeners.delete(callback);
}

export async function signIn(email, password, options = {}) {
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail || !password) throw new Error('Please enter credentials');
  const result = await callCloudflareRoute('api/auth/login', {
    method: 'POST',
    payload: {
      email: cleanEmail,
      password,
      turnstileToken: options.turnstileToken || ''
    }
  });
  currentUser = normalizeUser({ ...result.user, token: result.token });
  setCloudSession({
    token: result.token,
    expiresAt: result.expiresAt,
    user: currentUser
  });
  emitAuthChange();
  return { user: currentUser };
}


export async function registerWorkspaceAccount(payload = {}) {
  const email = String(payload.email || '').trim().toLowerCase();
  const fullName = String(payload.fullName || '').trim();
  const siteName = String(payload.siteName || '').trim();
  if (!fullName) throw new Error('Enter your full name.');
  if (!siteName) throw new Error('Enter your workspace or site name.');
  if (!email) throw new Error('Enter your email address.');

  return callCloudflareRoute('api/auth/register', {
    method: 'POST',
    payload: {
      fullName,
      siteName,
      email,
      turnstileToken: payload.turnstileToken || ''
    }
  });
}

export async function requestPasswordReset(email, options = {}) {
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) throw new Error('Enter your email address first.');
  return callCloudflareRoute('api/auth/password-reset', {
    method: 'POST',
    payload: {
      email: cleanEmail,
      turnstileToken: options.turnstileToken || ''
    }
  });
}

export async function confirmPasswordReset(resetToken, password, confirmPassword) {
  if (!resetToken) throw new Error('Invalid reset link.');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  if (password !== confirmPassword) throw new Error('Passwords do not match.');
  return callCloudflareRoute('api/auth/password-reset/confirm', {
    method: 'POST',
    payload: { resetToken, password }
  });
}

export async function secureSignOut() {
  const token = getCloudSession()?.token || '';
  try {
    if (token) await callCloudflareRoute('api/auth/logout', { method: 'POST', token });
  } finally {
    clearCloudSession();
    currentUser = null;
    emitAuthChange();
  }
}

export async function completeFirstLoginPasswordChange(password, confirmPassword) {
  const cleanPassword = String(password || '');
  const cleanConfirmPassword = String(confirmPassword || '');
  if (!currentUser?.uid) throw new Error('Your session expired. Please sign in again.');
  if (cleanPassword.length < 8) throw new Error('Password must be at least 8 characters.');
  if (cleanPassword !== cleanConfirmPassword) throw new Error('Passwords do not match.');
  await callCloudflareRoute('api/auth/change-password', {
    method: 'POST',
    payload: { password: cleanPassword }
  });
}

export async function getUserProfile(uid) {
  const userId = String(uid || currentUser?.uid || '').trim();
  if (!userId) return null;
  const session = getCloudSession();
  if (session?.profile && String(session.user?.uid || session.user?.id || '') === userId) {
    return session.profile;
  }
  const result = await callCloudflareRoute(`api/auth/profiles/${encodeURIComponent(userId)}`);
  return result.profile || null;
}

export async function getInvitationForEmail(email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return null;
  const result = await callCloudflareRoute('api/auth/invitations', {
    query: { email: cleanEmail },
    token: getCloudSession()?.token || ''
  });
  return result.invitation || null;
}

export async function claimInvitationForUser(user, invitation) {
  const invitationId = String(invitation?.id || '').trim();
  if (!user?.uid || !user?.email || !invitationId) return;
  await callCloudflareRoute('api/auth/invitations/claim', {
    method: 'POST',
    payload: { invitationId }
  });
}
