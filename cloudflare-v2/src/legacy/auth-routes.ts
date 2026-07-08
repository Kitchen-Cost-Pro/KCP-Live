import type { Env } from './types';
import { error, json, readJson } from './http';
import { requireAuth } from './auth';
import { verifyTurnstileToken } from './turnstile';
import { writeAdminAuditEvent, getEmailDeliveryConfig } from './admin-routes';
import { sendEmail } from './email';
import { timingSafeEqual } from './crypto';

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

async function verifyAppTurnstile(request: Request, env: Env, payload: Record<string, unknown>) {
  const turnstile = await verifyTurnstileToken(
    request,
    env,
    payload.turnstileToken || payload['cf-turnstile-response'],
    { mode: env.APP_TURNSTILE_MODE || 'enforce', label: 'Security' }
  );
  if (!turnstile.ok && turnstile.mode !== 'monitor') {
    return error(request, env, 403, turnstile.message || 'Security check failed.', {
      codes: turnstile.codes || [],
      hostname: turnstile.hostname || '',
      mode: turnstile.mode || 'enforce'
    });
  }
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(prefix = 'session') {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${bytesToHex(bytes)}`;
}

async function passwordHash(password: string, salt: string) {
  const input = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return bytesToHex(new Uint8Array(digest));
}

const PBKDF2_ITERATIONS = 100_000;

// Key-stretched hash. Stored as `pbkdf2$<iterations>$<hex>` so it's self-describing and
// coexists with legacy single-SHA-256 hashes during migration.
async function hashPasswordPbkdf2(password: string, salt: string, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `pbkdf2$${iterations}$${bytesToHex(new Uint8Array(bits))}`;
}

// Verify against either a PBKDF2 hash (new) or a legacy SHA-256 hash (old).
async function verifyPassword(password: string, storedHash: string, storedSalt: string) {
  if (!storedHash || !storedSalt) return false;
  if (storedHash.startsWith('pbkdf2$')) {
    const iterations = Number(storedHash.split('$')[1]) || PBKDF2_ITERATIONS;
    return timingSafeEqual(await hashPasswordPbkdf2(password, storedSalt, iterations), storedHash);
  }
  return timingSafeEqual(await passwordHash(password, storedSalt), storedHash);
}

async function createUserSession(env: Env, user: { id: string; email: string; display_name?: string }) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  const now = nowIso();
  // Clean up expired sessions and enforce max 10 concurrent sessions per user
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_sessions WHERE user_id = ?1 AND expires_at < ?2`).bind(user.id, now),
    env.DB.prepare(
      `DELETE FROM auth_sessions WHERE user_id = ?1 AND token IN (
         SELECT token FROM auth_sessions WHERE user_id = ?1 ORDER BY created_at ASC LIMIT MAX(0, (SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?1) - 9)
       )`
    ).bind(user.id),
    env.DB.prepare(
      `INSERT INTO auth_sessions (token, user_id, email, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(token, user.id, user.email, expiresAt, now)
  ]);
  return {
    token,
    expiresAt,
    user: {
      uid: user.id,
      id: user.id,
      email: user.email,
      displayName: text(user.display_name || user.email.split('@')[0]),
      providerData: [{ providerId: 'cloudflare' }]
    }
  };
}

async function getOrCreateUser(env: Env, email: string, displayName = '') {
  const existing = await env.DB.prepare(
    `SELECT id, email, display_name, password_hash, password_salt, status, must_change_password
       FROM app_users
      WHERE lower(email) = lower(?1)
      LIMIT 1`
  ).bind(email).first<{
    id: string;
    email: string;
    display_name?: string;
    password_hash?: string;
    password_salt?: string;
    status?: string;
    must_change_password?: number;
  }>();
  if (existing) return existing;

  const userId = id('user');
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO app_users (id, email, display_name, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'active', ?4, ?4)`
  ).bind(userId, email, displayName || email.split('@')[0], now).run();
  return {
    id: userId,
    email,
    display_name: displayName || email.split('@')[0],
    status: 'active'
  };
}

async function getProfileForUser(env: Env, userId: string, email: string) {
  const user = await env.DB.prepare(
    `SELECT id, email, display_name, status, must_change_password
       FROM app_users
      WHERE id = ?1
      LIMIT 1`
  ).bind(userId).first<{ id: string; email: string; display_name?: string; status?: string; must_change_password?: number }>();

  // Check if this user is a KCP superuser — if so, they see every active workspace
  const adminRow = await env.DB.prepare(
    `SELECT role_key FROM admin_users
      WHERE status = 'active'
        AND (auth_uid = ?1 OR lower(email) = lower(?2))
      LIMIT 1`
  ).bind(userId, email).first<{ role_key: string }>();

  const isKcpSuperuser = text(adminRow?.role_key).toLowerCase() === 'superuser';

  const memberships = isKcpSuperuser
    ? await env.DB.prepare(
        `SELECT id AS workspace_id, 'superuser' AS role_key, 'active' AS status, name, name AS display_name
           FROM workspaces
          WHERE status = 'active'
          ORDER BY lower(name)`
      ).all()
    : await env.DB.prepare(
        `SELECT wm.workspace_id, wm.role_key, wm.status, wm.display_name, w.name
           FROM workspace_members wm
           JOIN workspaces w ON w.id = wm.workspace_id
          WHERE wm.status = 'active'
            AND (wm.auth_uid = ?1 OR lower(wm.email) = lower(?2))
            AND w.status = 'active'
          ORDER BY lower(w.name)`
      ).bind(userId, email).all();

  const workspaces = Object.fromEntries((memberships.results || []).map((row: any) => [
    text(row.workspace_id),
    {
      role: text(row.role_key, 'member'),
      siteName: text(row.name || row.workspace_id),
      viewingOnly: false
    }
  ]));

  const pending = await env.DB.prepare(
    `SELECT site_name, status, requested_at
       FROM workspace_registration_requests
      WHERE lower(email) = lower(?1)
      ORDER BY requested_at DESC
      LIMIT 1`
  ).bind(email).first<{ site_name?: string; status?: string; requested_at?: string }>();

  return {
    uid: userId,
    email,
    name: text(user?.display_name || email.split('@')[0]),
    status: Object.keys(workspaces).length ? 'approved' : text(pending?.status || 'new'),
    mustChangePassword: Number(user?.must_change_password || 0) === 1,
    firstLoginRequired: Number(user?.must_change_password || 0) === 1,
    requestedWorkspace: pending ? {
      siteName: text(pending.site_name),
      status: text(pending.status),
      requestedAt: text(pending.requested_at)
    } : null,
    workspaces
  };
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function checkRateLimit(env: Env, key: string, maxAttempts: number, windowSeconds: number): Promise<{ blocked: boolean }> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSeconds;
    await env.DB.prepare(
      `DELETE FROM auth_rate_limits WHERE key = ?1 AND window_start < ?2`
    ).bind(key, windowStart).run();
    const row = await env.DB.prepare(
      `SELECT attempts FROM auth_rate_limits WHERE key = ?1 LIMIT 1`
    ).bind(key).first<{ attempts: number }>();
    if (row && row.attempts >= maxAttempts) return { blocked: true };
    if (row) {
      await env.DB.prepare(
        `UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE key = ?1`
      ).bind(key).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO auth_rate_limits (key, attempts, window_start) VALUES (?1, 1, ?2)`
      ).bind(key, now).run();
    }
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}

async function authLoginFromPayload(request: Request, env: Env, payload: Record<string, unknown>) {
  const email = text(payload.email).toLowerCase();
  const password = String(payload.password || '');
  if (!email || !password) return error(request, env, 400, 'Enter your email and password.');

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const rateLimitKey = `login:${ip}`;
  const limited = await checkRateLimit(env, rateLimitKey, 10, 300);
  if (limited.blocked) return error(request, env, 429, 'Too many login attempts. Please wait a few minutes and try again.');

  const user = await env.DB.prepare(
    `SELECT id, email, display_name, password_hash, password_salt, status, must_change_password
       FROM app_users
      WHERE lower(email) = lower(?1)
      LIMIT 1`
  ).bind(email).first<{
    id: string;
    email: string;
    display_name?: string;
    password_hash?: string;
    password_salt?: string;
    status?: string;
    must_change_password?: number;
  }>();

  if (!user) return error(request, env, 401, 'Account not found.');
  if (text(user.status) !== 'active') return error(request, env, 401, 'This account is not active.');
  if (!user.password_hash || !user.password_salt) {
    // Migrated account — auto-send a password setup email and prompt the user
    const resetToken = randomToken('reset');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString();
    await env.DB.prepare(
      `INSERT INTO auth_reset_tokens (token, user_id, email, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, created_at = excluded.created_at`
    ).bind(resetToken, user.id, email, expiresAt, nowIso()).run();
    const emailConfig = await getEmailDeliveryConfig(env);
    const appUrl = text(emailConfig.appBaseUrl || env.APP_BASE_URL || '').replace(/\/+$/, '');
    const resetUrl = `${appUrl}?resetToken=${encodeURIComponent(resetToken)}`;
    const recipientName = text(user.display_name || email.split('@')[0]);
    const delivery = await sendEmail(env, emailConfig, {
      to: email,
      subject: 'Set your Kitchen Cost Pro password',
      text: [
        `Hi ${recipientName},`,
        '',
        'Your account has been upgraded and you need to set a password to continue.',
        '',
        `Set your password here: ${resetUrl}`,
        '',
        'This link expires in 1 hour.',
      ].join('\n'),
    });
    if (!delivery.sent) {
      return error(request, env, 500, `Email delivery failed: ${(delivery as any).reason || 'unknown error'}`);
    }
    return error(request, env, 401, 'Your account needs a password. We\'ve sent you an email with a link to set one.');
  }

  const passwordOk = await verifyPassword(password, user.password_hash || '', user.password_salt || '');
  if (!passwordOk) return error(request, env, 401, 'Invalid password.');

  // Transparently upgrade legacy SHA-256 hashes to PBKDF2 on successful login.
  if (user.password_hash && !user.password_hash.startsWith('pbkdf2$')) {
    try {
      const upgradedSalt = randomToken('salt');
      const upgradedHash = await hashPasswordPbkdf2(password, upgradedSalt);
      await env.DB.prepare(
        `UPDATE app_users SET password_hash = ?2, password_salt = ?3, updated_at = ?4 WHERE id = ?1`
      ).bind(user.id, upgradedHash, upgradedSalt, nowIso()).run();
    } catch { /* non-fatal: login still succeeds */ }
  }

  // Link this login to any workspace membership created for their email. Members added
  // via "new user creation" use a password-reset flow (no invitation record), so their
  // workspace_members.auth_uid stays NULL and they show as "Invited" forever. Claiming
  // it here on first successful login flips them to active.
  await env.DB.prepare(
    `UPDATE workspace_members
        SET auth_uid = ?1,
            status = 'active',
            updated_at = ?3
      WHERE lower(email) = lower(?2)
        AND (auth_uid IS NULL OR auth_uid = '')`
  ).bind(user.id, email, nowIso()).run();

  const session = await createUserSession(env, user);
  const mustChangePassword = Number(user.must_change_password || 0) === 1;
  return json(request, env, { ok: true, ...session, mustChangePassword });
}

export async function postAuthLogin(request: Request, env: Env) {
  const payload = await readJson<Record<string, unknown>>(request);
  const turnstileError = await verifyAppTurnstile(request, env, payload);
  if (turnstileError) return turnstileError;
  return authLoginFromPayload(request, env, payload);
}

export async function postAdminAuthLogin(request: Request, env: Env) {
  const payload = await readJson<Record<string, unknown>>(request);
  const adminSecret = text(env.ADMIN_TURNSTILE_SECRET_KEY || env.TURNSTILE_SECRET_KEY);
  const turnstile = await verifyTurnstileToken(
    request,
    env,
    payload.turnstileToken || payload['cf-turnstile-response'],
    { mode: String(env.ADMIN_TURNSTILE_MODE || 'enforce'), secretKey: adminSecret }
  );
  if (!turnstile.ok && turnstile.mode !== 'monitor') {
    return error(request, env, 403, turnstile.message || 'Admin security check failed.', {
      codes: turnstile.codes || [],
      hostname: turnstile.hostname || '',
      mode: turnstile.mode || 'enforce'
    });
  }

  const response = await authLoginFromPayload(request, env, payload);
  if (response.ok) {
    const cloned = response.clone();
    const body = await cloned.json().catch(() => ({})) as any;
    await writeAdminAuditEvent(
      env,
      { uid: text(body?.user?.uid || body?.user?.id), email: text(body?.user?.email || payload.email) },
      'admin.login',
      text(body?.user?.email || payload.email),
      {
        turnstileRequired: Boolean(turnstile.required),
        turnstileMode: text(turnstile.mode || 'enforce'),
        turnstileHostname: text(turnstile.hostname)
      }
    );
  }
  return response;
}

export async function getAuthMe(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const profile = await getProfileForUser(env, auth.uid, auth.email);
  return json(request, env, {
    ok: true,
    user: {
      uid: auth.uid,
      id: auth.uid,
      email: auth.email,
      displayName: profile.name,
      providerData: [{ providerId: 'cloudflare' }]
    },
    profile
  });
}

export async function postAuthLogout(request: Request, env: Env) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM auth_sessions WHERE token = ?1`).bind(match[1]),
      env.DB.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?1`).bind(nowIso())
    ]);
  }
  return json(request, env, { ok: true });
}

export async function postAuthRegister(request: Request, env: Env) {
  const payload = await readJson<Record<string, unknown>>(request);
  const turnstileError = await verifyAppTurnstile(request, env, payload);
  if (turnstileError) return turnstileError;
  const email = text(payload.email).toLowerCase();
  const fullName = text(payload.fullName || payload.name);
  const siteName = text(payload.siteName || payload.workspaceName);
  if (!email) return error(request, env, 400, 'Email is required.');
  if (!isValidEmail(email)) return error(request, env, 400, 'Please enter a valid email address.');
  if (fullName.length > 100) return error(request, env, 400, 'Name is too long.');
  if (siteName.length > 100) return error(request, env, 400, 'Workspace name is too long.');
  if (!fullName) return error(request, env, 400, 'Full name is required.');
  if (!siteName) return error(request, env, 400, 'Workspace name is required.');

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const limited = await checkRateLimit(env, `register:${ip}`, 5, 3600);
  if (limited.blocked) return error(request, env, 429, 'Too many registration attempts. Please try again later.');

  const user = await getOrCreateUser(env, email, fullName);
  const requestId = id('req');
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE app_users
          SET display_name = ?2,
              updated_at = ?3
        WHERE id = ?1`
    ).bind(user.id, fullName, now),
    env.DB.prepare(
      `INSERT INTO workspace_registration_requests
        (id, email, full_name, site_name, status, requested_at, raw_json)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)`
    ).bind(requestId, email, fullName, siteName, now, JSON.stringify({ source: 'cloudflare-pages' }))
  ]);

  return json(request, env, {
    ok: true,
    status: 'pending',
    id: requestId,
    email,
    siteName,
    message: `Your request for ${siteName} is pending admin approval.`
  });
}

export async function getAuthProfile(request: Request, env: Env, userId: string) {
  const auth = await requireAuth(request, env);
  if (auth.uid !== userId) return error(request, env, 403, 'You can only load your own profile.');
  return json(request, env, { ok: true, profile: await getProfileForUser(env, auth.uid, auth.email) });
}

export async function getAuthInvitation(request: Request, env: Env) {
  const url = new URL(request.url);
  const email = text(url.searchParams.get('email')).toLowerCase();
  if (!email) return json(request, env, { ok: true, invitation: null });
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, email, display_name, role_key, status, invited_by, created_at
       FROM workspace_invitations
      WHERE lower(email) = lower(?1)
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1`
  ).bind(email).first<any>();
  return json(request, env, {
    ok: true,
    invitation: row ? {
      id: row.id,
      wsId: row.workspace_id,
      workspaceId: row.workspace_id,
      email: row.email,
      name: row.display_name,
      role: row.role_key,
      invitedBy: row.invited_by
    } : null
  });
}

export async function postAuthClaimInvitation(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const invitationId = text(payload.invitationId || payload.id);
  if (!invitationId) return json(request, env, { ok: true, claimed: false });

  const invitation = await env.DB.prepare(
    `SELECT id, workspace_id, email, display_name, role_key
       FROM workspace_invitations
      WHERE id = ?1
        AND status = 'pending'
      LIMIT 1`
  ).bind(invitationId).first<any>();
  if (!invitation || text(invitation.email).toLowerCase() !== auth.email) {
    return json(request, env, { ok: true, claimed: false });
  }

  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_members (id, workspace_id, auth_uid, email, display_name, status, role_key, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?7)
       ON CONFLICT(workspace_id, email) DO UPDATE SET
         auth_uid = excluded.auth_uid,
         display_name = excluded.display_name,
         status = 'active',
         role_key = excluded.role_key,
         updated_at = excluded.updated_at`
    ).bind(id('member'), invitation.workspace_id, auth.uid, auth.email, invitation.display_name || auth.email, invitation.role_key || 'member', now),
    env.DB.prepare(
      `UPDATE workspace_invitations
          SET status = 'accepted',
              accepted_at = ?2
        WHERE id = ?1`
    ).bind(invitation.id, now)
  ]);

  return json(request, env, { ok: true, claimed: true });
}

export async function postAuthChangePassword(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const password = String(payload.newPassword || payload.password || '');
  if (password.length < 8) return error(request, env, 400, 'Password must be at least 8 characters.');

  const existing = await env.DB.prepare(
    `SELECT password_hash, password_salt, must_change_password FROM app_users WHERE id = ?1 LIMIT 1`
  ).bind(auth.uid).first<{ password_hash?: string; password_salt?: string; must_change_password?: number }>();
  const hasExistingPassword = Boolean(existing?.password_hash && existing?.password_salt);
  const mustChange = Number(existing?.must_change_password || 0) === 1;
  // Require and verify the current password unless the account is in a forced first-set
  // state — otherwise a hijacked/borrowed session could silently lock out the owner.
  if (hasExistingPassword && !mustChange) {
    const currentPassword = String(payload.currentPassword || payload.oldPassword || '');
    if (!currentPassword) return error(request, env, 400, 'Enter your current password.');
    const ok = await verifyPassword(currentPassword, existing!.password_hash || '', existing!.password_salt || '');
    if (!ok) return error(request, env, 401, 'Your current password is incorrect.');
  }

  const salt = randomToken('salt');
  const hash = await hashPasswordPbkdf2(password, salt);
  await env.DB.prepare(
    `UPDATE app_users
        SET password_hash = ?2,
            password_salt = ?3,
            must_change_password = 0,
            updated_at = ?4
      WHERE id = ?1`
  ).bind(auth.uid, hash, salt, nowIso()).run();
  return json(request, env, { ok: true });
}

export async function postAuthPasswordReset(request: Request, env: Env) {
  const payload = await readJson<Record<string, unknown>>(request);
  const turnstileError = await verifyAppTurnstile(request, env, payload);
  if (turnstileError) return turnstileError;

  const email = text(payload.email).toLowerCase();
  if (!email || !isValidEmail(email)) {
    return error(request, env, 400, 'Please enter a valid email address.');
  }

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const limited = await checkRateLimit(env, `reset:${ip}`, 5, 3600);
  if (limited.blocked) return error(request, env, 429, 'Too many reset attempts. Please try again later.');

  // Always return ok to avoid user enumeration — don't reveal if email exists
  const user = await env.DB.prepare(
    `SELECT id, email, display_name, status FROM app_users WHERE lower(email) = lower(?1) LIMIT 1`
  ).bind(email).first<{ id: string; email: string; display_name?: string; status?: string }>();

  if (user && text(user.status) === 'active') {
    const resetToken = randomToken('reset');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1 hour
    await env.DB.prepare(
      `INSERT INTO auth_reset_tokens (token, user_id, email, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, created_at = excluded.created_at`
    ).bind(resetToken, user.id, email, expiresAt, nowIso()).run();

    try {
      const emailConfig = await getEmailDeliveryConfig(env);
      const appUrl = text(emailConfig.appBaseUrl || env.APP_BASE_URL || 'https://kcp-live.pages.dev').replace(/\/+$/, '');
      const resetUrl = `${appUrl}?resetToken=${encodeURIComponent(resetToken)}`;
      const recipientName = text(user.display_name || email.split('@')[0]);
      await sendEmail(env, emailConfig, {
        to: email,
        subject: 'Reset your Kitchen Cost Pro password',
        text: [
          `Hi ${recipientName},`,
          '',
          'We received a request to reset your Kitchen Cost Pro password.',
          '',
          `Reset your password here: ${resetUrl}`,
          '',
          'This link expires in 1 hour.',
          '',
          'If you did not request a password reset, you can safely ignore this email.',
          '',
          'Kitchen Cost Pro'
        ].join('\n')
      });
    } catch {
      // Silent — don't expose email delivery failures to the client
    }
  }

  return json(request, env, {
    ok: true,
    message: 'If an account exists for that email, a reset link has been sent.'
  });
}

export async function postAuthResetPasswordConfirm(request: Request, env: Env) {
  const payload = await readJson<Record<string, unknown>>(request);
  const resetToken = text(payload.resetToken || payload.token);
  const password = String(payload.password || '');
  if (!resetToken) return error(request, env, 400, 'Reset token is required.');
  if (password.length < 8) return error(request, env, 400, 'Password must be at least 8 characters.');

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const limited = await checkRateLimit(env, `reset-confirm:${ip}`, 10, 300);
  if (limited.blocked) return error(request, env, 429, 'Too many attempts. Please wait a few minutes.');

  const row = await env.DB.prepare(
    `SELECT user_id, email, expires_at FROM auth_reset_tokens WHERE token = ?1 LIMIT 1`
  ).bind(resetToken).first<{ user_id: string; email: string; expires_at: string }>();

  if (!row) return error(request, env, 400, 'Invalid or expired reset link.');
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare(`DELETE FROM auth_reset_tokens WHERE token = ?1`).bind(resetToken).run();
    return error(request, env, 400, 'This reset link has expired. Please request a new one.');
  }

  const salt = randomToken('salt');
  const hash = await hashPasswordPbkdf2(password, salt);
  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE app_users SET password_hash = ?2, password_salt = ?3, must_change_password = 0, updated_at = ?4 WHERE id = ?1`
    ).bind(row.user_id, hash, salt, now),
    env.DB.prepare(`DELETE FROM auth_reset_tokens WHERE user_id = ?1`).bind(row.user_id),
    env.DB.prepare(`DELETE FROM auth_sessions WHERE user_id = ?1`).bind(row.user_id)
  ]);

  return json(request, env, { ok: true, message: 'Password updated. Please sign in with your new password.' });
}
