import type { AuthContext, Env, DbLike, DbStatementLike } from './types';
import { error, json, readJson } from './http';
import { requireAuth } from './auth';
import { connectYoco, disconnectYoco, getYocoConnection, syncYocoCatalogue } from '../modules/yoco-engine-v2/integration-service';
import { sendEmail, type EmailDeliveryConfig } from './email';
import { encryptTextWithSecret, decryptTextWithSecret } from './crypto';
import { KCP_WORKER_RELEASE, KCP_WORKER_RELEASE_DATE, KCP_REFUND_PIPELINE_VERSION } from '../release';
import { checkRateLimit } from './rate-limit';

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function nowIso() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + 2);
  return d.toISOString().replace('Z', '+02:00');
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomPassword(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const randomValues = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(randomValues).map((value) => alphabet[value % alphabet.length]).join('');
}

function randomToken(prefix = 'salt') {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${bytesToHex(bytes)}`;
}

async function passwordHash(password: string, salt: string) {
  const input = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return bytesToHex(new Uint8Array(digest));
}

function slug(value: string) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 44) || 'workspace';
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  try {
    if (!value) return fallback;
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function appBaseUrl(env: Env) {
  return text(env.APP_BASE_URL || 'https://kcp-live.pages.dev').replace(/\/+$/, '');
}

const EMAIL_CONFIG_SETTING_KEY = 'email_config';
const SYSTEM_BROADCAST_SETTING_KEY = 'system_broadcast';

function isMissingSettingsTable(errorValue: unknown) {
  return String((errorValue as any)?.message || errorValue || '').toLowerCase().includes('admin_system_settings');
}

function parseSender(value: string) {
  const clean = text(value);
  const match = clean.match(/^(.*?)\s*<([^>]+)>$/);
  if (!match) return { fromName: '', fromEmail: clean };
  return { fromName: text(match[1]).replace(/^"|"$/g, ''), fromEmail: text(match[2]) };
}

function composeSender(fromName: string, fromEmail: string) {
  const email = text(fromEmail);
  if (!email) return '';
  const name = text(fromName);
  return name ? `${name} <${email}>` : email;
}

async function readAdminSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  try {
    const row = await env.DB.prepare(
      `SELECT value
         FROM admin_system_settings
        WHERE key = ?1
        LIMIT 1`
    ).bind(key).first<{ value?: string }>();
    return safeJsonParse<T>(row?.value, fallback);
  } catch (errorValue) {
    if (isMissingSettingsTable(errorValue)) return fallback;
    throw errorValue;
  }
}

async function writeAdminSetting(env: Env, key: string, value: Record<string, unknown>, updatedBy = '') {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO admin_system_settings (key, value, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).bind(key, JSON.stringify(value), now, updatedBy).run();
  return { ...value, updatedAt: now, updatedBy };
}

async function getStoredEmailConfig(env: Env) {
  return readAdminSetting<Record<string, any>>(env, EMAIL_CONFIG_SETTING_KEY, {});
}

export async function getEmailDeliveryConfig(env: Env) {
  const stored = await getStoredEmailConfig(env);
  const envSender = parseSender(text(env.EMAIL_FROM));
  const storedFrom = text(stored.from) || composeSender(stored.fromName, stored.fromEmail);
  const resolvedStoredSender = parseSender(storedFrom);
  const fromName = text(stored.fromName || resolvedStoredSender.fromName || envSender.fromName || 'Kitchen Cost Pro');
  const fromEmail = text(stored.fromEmail || resolvedStoredSender.fromEmail || envSender.fromEmail);

  const provider = text(stored.provider || (stored.gmailAppPassword || stored.smtpPassword ? 'gmail_smtp' : 'resend'));

  return {
    provider,
    apiKey: text(stored.resendApiKey || env.RESEND_API_KEY),
    from: composeSender(fromName, fromEmail) || text(env.EMAIL_FROM),
    fromName,
    fromEmail,
    smtpHost: text(stored.smtpHost || 'smtp.gmail.com'),
    smtpPort: Number(stored.smtpPort || 587) || 587,
    smtpUsername: text(stored.smtpUsername || stored.gmailUsername || fromEmail),
    smtpPassword: text(stored.smtpPassword || stored.gmailAppPassword),
    appBaseUrl: text(stored.appBaseUrl || env.APP_BASE_URL || appBaseUrl(env)).replace(/\/+$/, ''),
    gmailTokenRefresher: provider === 'gmail_oauth' ? refreshSystemGmailAccessToken : undefined,
  } satisfies EmailDeliveryConfig;
}

async function getEmailConfigForClient(env: Env) {
  const stored = await getStoredEmailConfig(env);
  const delivery = await getEmailDeliveryConfig(env);
  const hasStoredApiKey = Boolean(text(stored.resendApiKey));
  const hasEnvApiKey = Boolean(text(env.RESEND_API_KEY));
  const hasStoredSmtpPassword = Boolean(text(stored.smtpPassword || stored.gmailAppPassword));
  return {
    provider: delivery.provider,
    fromName: delivery.fromName,
    fromEmail: delivery.fromEmail,
    appBaseUrl: delivery.appBaseUrl,
    smtpHost: delivery.smtpHost,
    smtpPort: delivery.smtpPort,
    smtpUsername: delivery.smtpUsername,
    hasSmtpPassword: hasStoredSmtpPassword,
    hasResendApiKey: hasStoredApiKey || hasEnvApiKey,
    apiKeySource: delivery.provider === 'gmail_smtp'
      ? hasStoredSmtpPassword ? 'gmail-app-password' : 'missing'
      : hasStoredApiKey ? 'admin-console' : hasEnvApiKey ? 'environment' : 'missing',
    updatedAt: text(stored.updatedAt),
    updatedBy: text(stored.updatedBy)
  };
}

function normalizeBroadcastItem(value: Record<string, any> = {}) {
  const severityValue = text(value.severity || 'info').toLowerCase();
  const severity = ['info', 'warning', 'critical', 'success'].includes(severityValue) ? severityValue : 'info';
  const gradientValue = text(value.gradient || '').toLowerCase();
  const gradient = ['blue', 'amber', 'red', 'emerald', 'purple', 'rose'].includes(gradientValue) ? gradientValue : '';
  return {
    id: text(value.id || id('broadcast')),
    enabled: Boolean(value.enabled ?? value.active),
    severity,
    gradient,
    title: text(value.title || 'System Notice'),
    message: text(value.message || value.text),
    startsAt: text(value.startsAt),
    endsAt: text(value.endsAt),
    createdAt: text(value.createdAt || value.timestamp || value.updatedAt),
    updatedAt: text(value.updatedAt),
    updatedBy: text(value.updatedBy)
  };
}

function normalizeBroadcastPayload(value: Record<string, any> = {}) {
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems.length
    ? rawItems.map((item) => normalizeBroadcastItem(item)).filter((item) => item.message)
    : [normalizeBroadcastItem(value)].filter((item) => item.message);
  const first = items[0] || normalizeBroadcastItem(value);
  return {
    enabled: Boolean(value.enabled ?? value.active ?? items.some((item) => item.enabled)),
    severity: first.severity,
    gradient: first.gradient || '',
    title: first.title,
    message: first.message,
    startsAt: first.startsAt,
    endsAt: first.endsAt,
    updatedAt: text(value.updatedAt || first.updatedAt),
    updatedBy: text(value.updatedBy || first.updatedBy),
    items
  };
}

async function getBroadcastConfig(env: Env) {
  return normalizeBroadcastPayload(await readAdminSetting<Record<string, any>>(env, SYSTEM_BROADCAST_SETTING_KEY, {}));
}

function isBroadcastItemCurrent(item: ReturnType<typeof normalizeBroadcastItem>, now = Date.now()) {
  if (!item.enabled || !item.message) return false;
  const endsAt = Date.parse(item.endsAt);
  return !Number.isFinite(endsAt) || endsAt >= now;
}

function currentBroadcastConfig(value: ReturnType<typeof normalizeBroadcastPayload>, now = Date.now()) {
  const items = (value.items || []).filter((item) => isBroadcastItemCurrent(item, now));
  const first = items[0];
  return {
    enabled: items.some((item) => item.enabled),
    severity: first?.severity || 'info',
    gradient: first?.gradient || '',
    title: first?.title || '',
    message: first?.message || '',
    startsAt: first?.startsAt || '',
    endsAt: first?.endsAt || '',
    updatedAt: text(value.updatedAt),
    updatedBy: text(value.updatedBy),
    items,
  };
}

function isBroadcastItemActive(item: ReturnType<typeof normalizeBroadcastItem>, now = Date.now()) {
  if (!item.enabled || !item.message) return false;
  const startsAt = Date.parse(item.startsAt);
  const endsAt = Date.parse(item.endsAt);
  if (Number.isFinite(startsAt) && startsAt > now) return false;
  if (Number.isFinite(endsAt) && endsAt < now) return false;
  return true;
}

async function getActiveBroadcastConfig(env: Env) {
  const broadcast = await getBroadcastConfig(env);
  const now = Date.now();
  const activeItems = (broadcast.items || []).filter((item) => isBroadcastItemActive(item, now));
  if (!broadcast.enabled || !activeItems.length) return null;
  const first = activeItems[0];
  return {
    ...broadcast,
    ...first,
    enabled: true,
    items: activeItems
  };
}

async function issueTemporaryPassword(env: Env, email: string, displayName = '') {
  const cleanEmail = text(email).toLowerCase();
  const tempPassword = randomPassword();
  const salt = randomToken();
  const hash = await passwordHash(tempPassword, salt);
  const now = nowIso();
  const existing = await env.DB.prepare(
    `SELECT id, password_hash
       FROM app_users
      WHERE lower(email) = lower(?1)
      LIMIT 1`
  ).bind(cleanEmail).first<{ id: string; password_hash?: string }>();
  const userId = existing?.id || id('user');
  await env.DB.prepare(
    `INSERT INTO app_users (id, email, display_name, password_hash, password_salt, status, must_change_password, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'active', 1, ?6, ?6)
     ON CONFLICT(email) DO UPDATE SET
       display_name = COALESCE(excluded.display_name, display_name),
       password_hash = excluded.password_hash,
       password_salt = excluded.password_salt,
       status = 'active',
       must_change_password = 1,
       updated_at = excluded.updated_at`
  ).bind(userId, cleanEmail, displayName || cleanEmail.split('@')[0], hash, salt, now).run();
  return { userId, tempPassword };
}

async function sendTemporaryPasswordEmail(env: Env, payload: {
  email: string;
  displayName?: string;
  workspaceName?: string;
  tempPassword: string;
}) {
  const emailConfig = await getEmailDeliveryConfig(env);
  const workspaceName = text(payload.workspaceName || 'Kitchen Cost Pro');
  const loginUrl = text(emailConfig.appBaseUrl || appBaseUrl(env)).replace(/\/+$/, '');
  const recipientName = text(payload.displayName || payload.email.split('@')[0]);
  const subject = `Your Kitchen Cost Pro login for ${workspaceName}`;
  const textBody = [
    `Hi ${recipientName},`,
    '',
    `Your Kitchen Cost Pro access for ${workspaceName} is ready.`,
    '',
    `Login email: ${payload.email}`,
    `Temporary password: ${payload.tempPassword}`,
    '',
    `Sign in here: ${loginUrl}`,
    '',
    'You will be asked to create your permanent password after signing in.',
    '',
    'Kitchen Cost Pro'
  ].join('\n');

  return sendEmail(env, emailConfig, {
    to: payload.email,
    subject,
    text: textBody
  });
}

async function issueAndNotifyTemporaryPassword(env: Env, payload: {
  email: string;
  displayName?: string;
  workspaceId?: string;
  workspaceName?: string;
}) {
  const issued = await issueTemporaryPassword(env, payload.email, payload.displayName);
  const delivery = await sendTemporaryPasswordEmail(env, {
    email: text(payload.email).toLowerCase(),
    displayName: payload.displayName,
    workspaceName: payload.workspaceName || payload.workspaceId,
    tempPassword: issued.tempPassword
  });
  return {
    userId: issued.userId,
    temporaryPassword: issued.tempPassword,
    emailDelivery: delivery
  };
}

async function getWorkspaceSettingsMap(env: Env, workspaceId: string) {
  const row = await env.DB.prepare(
    `SELECT raw_json
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`
  ).bind(workspaceId).first<{ raw_json: string }>();
  return safeJsonParse<Record<string, any>>(row?.raw_json, {});
}

export async function getAdminWorkspaceSettings(
  request: Request,
  env: Env,
  workspaceId: string,
  settingsReader?: (workspaceId: string) => Promise<Record<string, any>>
): Promise<Response> {
  await requireAdmin(request, env);
  // workspace_settings lives in the workspace DO — the front Worker supplies a DO-backed reader.
  const settings = settingsReader
    ? await settingsReader(workspaceId)
    : await getWorkspaceSettingsMap(env, workspaceId);
  return json(request, env, { ok: true, settings });
}

export async function patchAdminWorkspaceSettings(
  request: Request,
  env: Env,
  workspaceId: string,
  settingsMerger?: (workspaceId: string, payload: Record<string, unknown>) => Promise<Record<string, any>>
): Promise<Response> {
  await requireAdmin(request, env);
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  // Merge-write happens in the workspace DO (front Worker supplies the merger).
  if (settingsMerger) {
    const merged = await settingsMerger(workspaceId, payload);
    return json(request, env, { ok: true, settings: merged });
  }
  const existing = await getWorkspaceSettingsMap(env, workspaceId);
  const merged = { ...existing, ...payload };
  await env.DB.prepare(
    `INSERT INTO workspace_settings (workspace_id, raw_json)
     VALUES (?1, ?2)
     ON CONFLICT(workspace_id) DO UPDATE SET raw_json = excluded.raw_json`
  ).bind(workspaceId, JSON.stringify(merged)).run();
  return json(request, env, { ok: true, settings: merged });
}

function groupPrefix(linkType: string) {
  return linkType === 'corp' ? 'corp' : 'org';
}

function groupField(linkType: string) {
  return linkType === 'corp'
    ? { camel: 'corpId', snake: 'corp_id' }
    : { camel: 'orgId', snake: 'org_id' };
}

function adminBootstrapEmails(env: Env) {
  return String(env.ADMIN_BOOTSTRAP_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function isBootstrapAdminEmail(email: string, env: Env) {
  const normalized = text(email).toLowerCase();
  if (!normalized) return false;
  // Explicit allow-list only. Previously ANY '@yoco.com' address could self-provision as
  // superuser during the empty-admin-table window — too broad. Configure the allowed
  // bootstrap admins via the ADMIN_BOOTSTRAP_EMAILS env var instead.
  return adminBootstrapEmails(env).includes(normalized);
}

function normalizeAdminRow(row: any) {
  const displayName = text(row?.display_name || row?.email || 'Admin');
  return {
    id: text(row?.id),
    uid: text(row?.auth_uid),
    email: text(row?.email).toLowerCase(),
    name: displayName,
    displayName,
    role: text(row?.role_key || 'superuser'),
    status: text(row?.status || 'active'),
    isSuper: text(row?.role_key || 'superuser') === 'superuser',
    createdAt: text(row?.created_at),
    updatedAt: text(row?.updated_at),
    createdBy: text(row?.created_by),
    notes: text(row?.notes)
  };
}

async function ensureAdminAuditTable(env: Env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS admin_audit_events (
      id TEXT PRIMARY KEY,
      actor_uid TEXT,
      actor_email TEXT,
      action_type TEXT NOT NULL,
      target_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created
       ON admin_audit_events(created_at)`
  ).run();
}

function normalizeAdminAuditRow(row: any) {
  let details: Record<string, unknown> = {};
  try {
    details = row.details_json ? JSON.parse(row.details_json) : {};
  } catch {
    details = { raw: text(row.details_json) };
  }

  return {
    id: text(row.id),
    timestamp: text(row.created_at),
    adminEmail: text(row.actor_email),
    adminUid: text(row.actor_uid),
    actionType: text(row.action_type),
    targetId: text(row.target_id),
    details
  };
}

function normalizeOperationalAuditRow(row: any) {
  let details: Record<string, unknown> = {};
  try {
    details = row.after_json ? JSON.parse(row.after_json) : {};
  } catch {
    details = { raw: text(row.after_json) };
  }

  return {
    id: text(row.id),
    timestamp: text(row.created_at),
    adminEmail: text(row.actor_email || row.actor_uid || 'workspace-user'),
    adminUid: text(row.actor_uid),
    actionType: text(row.event_type || 'workspace.event'),
    targetId: text(row.entity_id || row.workspace_id),
    details: {
      source: 'workspace',
      workspaceId: text(row.workspace_id),
      workspaceName: text(row.workspace_name),
      entityType: text(row.entity_type),
      ...details
    }
  };
}

export async function writeAdminAuditEvent(
  env: Env,
  actor: { uid?: string; email?: string } = {},
  actionType: string,
  targetId = '',
  details: Record<string, unknown> = {}
) {
  await ensureAdminAuditTable(env);
  const createdAt = nowIso();
  const row = {
    id: id('admin_audit'),
    actor_uid: text(actor.uid),
    actor_email: text(actor.email),
    action_type: text(actionType, 'admin.action'),
    target_id: text(targetId),
    details_json: JSON.stringify(details || {}),
    created_at: createdAt
  };
  await env.DB.prepare(
    `INSERT INTO admin_audit_events
      (id, actor_uid, actor_email, action_type, target_id, details_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(
    row.id,
    row.actor_uid,
    row.actor_email,
    row.action_type,
    row.target_id,
    row.details_json,
    row.created_at
  ).run();
  return normalizeAdminAuditRow(row);
}

function adminAuditActor(adminSession: Awaited<ReturnType<typeof requireAdmin>>) {
  return {
    uid: text(adminSession.auth?.uid || adminSession.admin?.id || ''),
    email: text(adminSession.admin?.email || adminSession.auth?.email || '')
  };
}

async function listAdminUsers(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id, auth_uid, email, display_name, role_key, status, created_at, updated_at, created_by, notes
       FROM admin_users
      WHERE status = 'active'
      ORDER BY CASE WHEN lower(email) = 'superuser@yoco.com' THEN 0 ELSE 1 END, lower(email)`
  ).all<any>();
  return (rows.results || []).map(normalizeAdminRow);
}

async function findAdminUserByAuth(env: Env, auth: AuthContext) {
  const row = await env.DB.prepare(
    `SELECT id, auth_uid, email, display_name, role_key, status, created_at, updated_at, created_by, notes
       FROM admin_users
      WHERE status = 'active'
        AND (auth_uid = ?1 OR lower(email) = lower(?2))
      LIMIT 1`
  ).bind(auth.uid, auth.email).first<any>();
  return row ? normalizeAdminRow(row) : null;
}

async function maybeBootstrapAdminUser(env: Env, auth: AuthContext) {
  if (!isBootstrapAdminEmail(auth.email, env)) return null;
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM admin_users
      WHERE status = 'active'`
  ).first<{ count: number | string }>();
  const activeCount = Number(countRow?.count || 0);
  if (activeCount > 0 && !adminBootstrapEmails(env).includes(auth.email)) return null;

  const now = nowIso();
  const rowId = id('admin');
  await env.DB.prepare(
    `INSERT INTO admin_users (id, auth_uid, email, display_name, role_key, status, created_at, updated_at, created_by, notes)
     VALUES (?1, ?2, ?3, ?4, 'superuser', 'active', ?5, ?5, ?6, ?7)
     ON CONFLICT(email) DO UPDATE SET
       auth_uid = excluded.auth_uid,
       display_name = excluded.display_name,
       role_key = 'superuser',
       status = 'active',
       updated_at = excluded.updated_at,
       created_by = COALESCE(admin_users.created_by, excluded.created_by),
       notes = COALESCE(admin_users.notes, excluded.notes)`
  ).bind(
    rowId,
    auth.uid,
    auth.email,
    text(auth.token?.name || auth.email.split('@')[0]),
    now,
    'cloudflare-admin-bootstrap',
    activeCount === 0
      ? 'Auto-bootstrapped first Cloudflare admin.'
      : 'Bootstrapped from ADMIN_BOOTSTRAP_EMAILS.'
  ).run();

  return findAdminUserByAuth(env, auth);
}

export async function requireAdmin(request: Request, env: Env) {
  const configured = text(env.ADMIN_API_TOKEN);
  const suppliedToken = text(request.headers.get('x-kcp-admin-token'));
  if (configured && suppliedToken && suppliedToken === configured) {
    // Rate-limit the shared token path too — a leaked ADMIN_API_TOKEN otherwise has no throttle at
    // all on how fast it can be used to hammer expensive admin routes.
    const tokenLimited = await checkRateLimit(env.DB, 'admin-action:env-token', 60, 60);
    if (tokenLimited.blocked) throw new Error('Too many admin actions. Please wait a moment and try again.');
    return {
      via: 'token' as const,
      auth: null,
      admin: {
        id: 'env-admin-token',
        uid: '',
        email: 'superuser@yoco.com',
        name: 'System Admin',
        role: 'superuser',
        status: 'active',
        isSuper: true,
        createdAt: '',
        updatedAt: '',
        createdBy: 'system',
        notes: 'Environment token access'
      }
    };
  }

  // The admin portal authenticates exclusively through the central D1 session plane.
  const auth = await requireAuth(request, env);
  let admin = await findAdminUserByAuth(env, auth);
  if (!admin) admin = await maybeBootstrapAdminUser(env, auth);
  if (!admin) throw new Error('Admin access denied.');
  // No rate limiting previously existed on ANY admin action once authenticated — nothing stopped a
  // compromised admin session (or a buggy retry loop in the frontend) from hammering expensive
  // routes (catalogue sync, bulk delete, migration-retry) at unlimited speed. This one bucket
  // covers every admin route though, including routine read-only dashboard telemetry (summaries,
  // invitations, registration-requests, webhook health/write-budget/timeseries) — a single normal
  // dashboard load plus opening one tab is easily 8-10 calls on its own, so 10/min (tried first)
  // false-positived on real usage within seconds. 60/min still bounds a runaway loop or abused
  // token while giving normal admin console usage headroom.
  const sessionLimited = await checkRateLimit(env.DB, `admin-action:${admin.id}`, 60, 60);
  if (sessionLimited.blocked) throw new Error('Too many admin actions. Please wait a moment and try again.');
  return { via: 'session' as const, auth, admin };
}

export async function getSystemBroadcast(request: Request, env: Env) {
  return json(request, env, {
    ok: true,
    broadcast: await getActiveBroadcastConfig(env)
  });
}

export async function getAdminSystemSettings(request: Request, env: Env) {
  await requireAdmin(request, env);
  return json(request, env, {
    ok: true,
    emailConfig: await getEmailConfigForClient(env),
    // Admins need the live/scheduled queue, not expired or stopped history.
    broadcast: currentBroadcastConfig(await getBroadcastConfig(env))
  });
}

export async function getAdminAuditLogs(
  request: Request,
  env: Env,
  operationalProvider?: (limit: number) => Promise<any[]>
) {
  await requireAdmin(request, env);
  await ensureAdminAuditTable(env);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 500), 1), 2000);
  const adminRows = await env.DB.prepare(
    `SELECT id, actor_uid, actor_email, action_type, target_id, details_json, created_at
       FROM admin_audit_events
      ORDER BY created_at DESC
      LIMIT ?1`
  ).bind(limit).all<any>();
  let operationalRows: any[] = [];
  if (operationalProvider) {
    operationalRows = await operationalProvider(limit);
  } else {
    // Compatibility for single-database deployments. In the current architecture audit_events
    // lives in each workspace DO and is supplied by the front Worker through operationalProvider.
    try {
      const rows = await env.DB.prepare(
        `SELECT ae.id, ae.workspace_id, ae.actor_uid, ae.event_type, ae.entity_type, ae.entity_id, ae.after_json, ae.created_at,
                au.email AS actor_email,
                w.name AS workspace_name
           FROM audit_events ae
           LEFT JOIN app_users au ON au.id = ae.actor_uid
           LEFT JOIN workspaces w ON w.id = ae.workspace_id
          ORDER BY ae.created_at DESC
          LIMIT ?1`
      ).bind(limit).all<any>();
      operationalRows = rows.results || [];
    } catch {
      operationalRows = [];
    }
  }

  const logs = [
    ...(adminRows.results || []).map(normalizeAdminAuditRow),
    ...operationalRows.map(normalizeOperationalAuditRow)
  ].sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, limit);

  return json(request, env, {
    ok: true,
    logs
  });
}

export async function postAdminAuditLog(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, any>>(request);
  const log = await writeAdminAuditEvent(
    env,
    {
      uid: text(adminSession.auth?.uid || adminSession.admin?.id),
      email: text(adminSession.admin?.email || adminSession.auth?.email)
    },
    text(payload.actionType || payload.action || 'admin.action'),
    text(payload.targetId || payload.target || ''),
    payload.details && typeof payload.details === 'object' ? payload.details : {}
  );

  return json(request, env, { ok: true, log });
}

export async function postAdminTestEmail(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  // Separate from requireAdmin's general action-pace limit — unlimited email sends by any
  // admin/member session is a provider-cost and deliverability-reputation risk in its own right,
  // not just a Cloudflare-quota one, so it gets its own, tighter, email-specific budget.
  const emailLimited = await checkRateLimit(env.DB, `admin-email:${adminSession.admin?.id || 'unknown'}`, 20, 3600);
  if (emailLimited.blocked) return error(request, env, 429, 'Too many emails sent recently. Please wait and try again.');
  const payload = await readJson<Record<string, unknown>>(request);
  const to = text(payload.to);
  if (!to) return error(request, env, 400, 'Recipient email required.');
  const emailConfig = await getEmailDeliveryConfig(env);
  const delivery = await sendEmail(env, emailConfig, {
    to,
    subject: 'Kitchen Cost Pro — Test Email',
    text: `This is a test email from Kitchen Cost Pro.\n\nSMTP host: ${emailConfig.smtpHost}\nFrom: ${emailConfig.from}\nProvider: ${emailConfig.provider}\n\nIf you received this, email delivery is working.`
  });
  return json(request, env, { ok: true, delivery, config: { provider: emailConfig.provider, smtpHost: emailConfig.smtpHost, from: emailConfig.from, smtpUsername: emailConfig.smtpUsername } });
}

export async function putAdminEmailConfig(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, any>>(request);
  const config = payload.emailConfig || payload;
  const current = await getStoredEmailConfig(env);
  const fromName = text(config.fromName || current.fromName || 'Kitchen Cost Pro');
  const fromEmail = text(config.fromEmail || current.fromEmail || parseSender(text(env.EMAIL_FROM)).fromEmail);
  const appUrl = text(config.appBaseUrl || current.appBaseUrl || env.APP_BASE_URL || appBaseUrl(env)).replace(/\/+$/, '');
  const provider = text(config.provider || current.provider || 'resend').toLowerCase();
  if (!fromEmail) return error(request, env, 400, 'Sender email is required.');
  if (!['resend', 'gmail_smtp'].includes(provider)) return error(request, env, 400, 'Choose a valid email provider.');

  const next: Record<string, unknown> = {
    ...current,
    provider,
    fromName,
    fromEmail,
    from: composeSender(fromName, fromEmail),
    appBaseUrl: appUrl,
    updatedAt: nowIso(),
    updatedBy: text(adminSession.admin?.email || 'admin')
  };
  if (config.clearResendApiKey === true) delete next.resendApiKey;
  if (text(config.resendApiKey)) next.resendApiKey = text(config.resendApiKey);
  if (config.clearSmtpPassword === true) delete next.smtpPassword;
  if (text(config.smtpHost)) next.smtpHost = text(config.smtpHost);
  if (text(config.smtpPort)) next.smtpPort = Number(config.smtpPort) || 587;
  if (text(config.smtpUsername)) next.smtpUsername = text(config.smtpUsername);
  if (text(config.smtpPassword)) next.smtpPassword = text(config.smtpPassword);

  await writeAdminSetting(env, EMAIL_CONFIG_SETTING_KEY, next, text(adminSession.admin?.email || 'admin'));
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'email_config.update', 'email_config', {
    fromEmail,
    appBaseUrl: appUrl,
    provider,
    apiKeySource: provider === 'gmail_smtp'
      ? text(config.smtpPassword) ? 'gmail-app-password' : 'unchanged'
      : text(config.resendApiKey) ? 'admin-console' : 'unchanged'
  });
  return json(request, env, {
    ok: true,
    emailConfig: await getEmailConfigForClient(env)
  });
}

export async function putAdminSystemBroadcast(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, any>>(request);
  const current = await getBroadcastConfig(env);
  const adminEmail = text(adminSession.admin?.email || 'admin');
  const now = nowIso();
  const requestedAction = text(payload.action).toLowerCase();

  if (requestedAction === 'remove' || requestedAction === 'delete') {
    const removeId = text(payload.id || payload.broadcastId || payload.removeId);
    if (!removeId) return error(request, env, 400, 'Broadcast id is required.');
    const items = (current.items || [])
      .filter((item) => item.message)
      .filter((item) => item.id !== removeId);
    const next = normalizeBroadcastPayload({
      enabled: items.some((item) => item.enabled),
      updatedAt: now,
      updatedBy: adminEmail,
      items
    });
    const saved = await writeAdminSetting(env, SYSTEM_BROADCAST_SETTING_KEY, next, adminEmail);
    await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'broadcast.remove', removeId, { action: requestedAction });
    return json(request, env, {
      ok: true,
      broadcast: currentBroadcastConfig(normalizeBroadcastPayload(saved))
    });
  }

  if (requestedAction === 'status') {
    const broadcastId = text(payload.id || payload.broadcastId);
    if (!broadcastId) return error(request, env, 400, 'Broadcast id is required.');
    const enabled = Boolean(payload.enabled ?? payload.active);
    let found = false;
    const items = (current.items || [])
      .filter((item) => item.message)
      .map((item) => {
        if (item.id !== broadcastId) return item;
        found = true;
        return { ...item, enabled, updatedAt: now, updatedBy: adminEmail };
      });
    if (!found) return error(request, env, 404, 'Broadcast not found.');
    const next = normalizeBroadcastPayload({
      enabled: items.some((item) => item.enabled),
      updatedAt: now,
      updatedBy: adminEmail,
      items,
    });
    const saved = await writeAdminSetting(env, SYSTEM_BROADCAST_SETTING_KEY, next, adminEmail);
    await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'broadcast.status', broadcastId, { enabled });
    return json(request, env, {
      ok: true,
      broadcast: currentBroadcastConfig(normalizeBroadcastPayload(saved)),
    });
  }

  if (requestedAction === 'clear' || payload.clear === true) {
    const next = normalizeBroadcastPayload({
      enabled: false,
      updatedAt: now,
      updatedBy: adminEmail,
      items: []
    });
    const saved = await writeAdminSetting(env, SYSTEM_BROADCAST_SETTING_KEY, next, adminEmail);
    await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'broadcast.clear', 'system_broadcast', {});
    return json(request, env, {
      ok: true,
      broadcast: currentBroadcastConfig(normalizeBroadcastPayload(saved))
    });
  }

  const nextItem = normalizeBroadcastItem({
    id: id('broadcast'),
    enabled: payload.enabled ?? payload.active,
    severity: payload.severity,
    title: payload.title,
    message: payload.message || payload.text,
    startsAt: payload.startsAt,
    endsAt: payload.endsAt,
    createdAt: now,
    updatedAt: now,
    updatedBy: adminEmail
  });
  if (nextItem.enabled && !nextItem.message) return error(request, env, 400, 'Broadcast message is required.');

  const existingItems = (current.items || []).filter((item) => isBroadcastItemCurrent(item));
  const items = nextItem.enabled
    ? [nextItem, ...existingItems].slice(0, 8)
    : existingItems;
  const next = normalizeBroadcastPayload({
    enabled: items.some((item) => item.enabled),
    updatedAt: now,
    updatedBy: adminEmail,
    items
  });
  const saved = await writeAdminSetting(env, SYSTEM_BROADCAST_SETTING_KEY, next, adminEmail);
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), nextItem.enabled ? 'broadcast.publish' : 'broadcast.update', nextItem.id, {
    severity: nextItem.severity,
    title: nextItem.title,
    message: nextItem.message
  });
  return json(request, env, {
    ok: true,
    broadcast: currentBroadcastConfig(normalizeBroadcastPayload(saved))
  });
}

export async function postAdminUser(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  if (!adminSession.admin?.isSuper) return error(request, env, 403, 'Only superusers can create admin users.');

  const payload = await readJson<Record<string, unknown>>(request);
  const email = text(payload.email).toLowerCase();
  const password = String(payload.password || '');
  const displayName = text(payload.displayName || payload.name || [payload.firstName, payload.surname].map((value) => text(value)).filter(Boolean).join(' ') || email.split('@')[0]);
  const role = text(payload.role || 'superuser');
  if (!email || !email.includes('@')) return error(request, env, 400, 'A valid email is required.');
  if (!password || password.length < 6) return error(request, env, 400, 'Password must be at least 6 characters.');
  if (role !== 'superuser') return error(request, env, 400, 'Only superuser admin accounts can be created here.');

  const salt = randomToken();
  const hash = await passwordHash(password, salt);
  const now = nowIso();
  const existing = await env.DB.prepare(
    `SELECT id
       FROM app_users
      WHERE lower(email) = lower(?1)
      LIMIT 1`
  ).bind(email).first<{ id: string }>();
  const userId = existing?.id || id('user');
  const adminId = id('admin');

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_users (id, email, display_name, password_hash, password_salt, status, must_change_password, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', 0, ?6, ?6)
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name,
         password_hash = excluded.password_hash,
         password_salt = excluded.password_salt,
         status = 'active',
         must_change_password = 0,
         updated_at = excluded.updated_at`
    ).bind(userId, email, displayName, hash, salt, now),
    env.DB.prepare(
      `INSERT INTO admin_users (id, auth_uid, email, display_name, role_key, status, created_at, updated_at, created_by, notes)
       VALUES (?1, ?2, ?3, ?4, 'superuser', 'active', ?5, ?5, ?6, ?7)
       ON CONFLICT(email) DO UPDATE SET
         auth_uid = COALESCE(admin_users.auth_uid, excluded.auth_uid),
         display_name = excluded.display_name,
         role_key = 'superuser',
         status = 'active',
         updated_at = excluded.updated_at,
         notes = COALESCE(admin_users.notes, excluded.notes)`
    ).bind(
      adminId,
      userId,
      email,
      displayName,
      now,
      adminSession.admin?.email || 'admin',
      'Created from Cloudflare admin console.'
    )
  ]);

  const admin = await env.DB.prepare(
    `SELECT id, auth_uid, email, display_name, role_key, status, created_at, updated_at, created_by, notes
       FROM admin_users
      WHERE lower(email) = lower(?1)
      LIMIT 1`
  ).bind(email).first<any>();

  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'admin_user.create', email, { displayName, role });
  return json(request, env, { ok: true, admin: normalizeAdminRow(admin) });
}

export async function patchAdminUser(request: Request, env: Env, adminId: string) {
  const adminSession = await requireAdmin(request, env);
  if (!adminSession.admin?.isSuper) return error(request, env, 403, 'Only superusers can update admin users.');

  const payload = await readJson<Record<string, unknown>>(request);
  const displayName = text(payload.displayName || payload.name || [payload.firstName, payload.surname].map((value) => text(value)).filter(Boolean).join(' '));
  if (!displayName) return json(request, env, { ok: true });
  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE admin_users
          SET display_name = ?2,
              updated_at = ?3
        WHERE id = ?1`
    ).bind(adminId, displayName, now),
    env.DB.prepare(
      `UPDATE app_users
          SET display_name = ?2,
              updated_at = ?3
        WHERE lower(email) = lower((SELECT email FROM admin_users WHERE id = ?1))`
    ).bind(adminId, displayName, now)
  ]);

  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'admin_user.update', adminId, { displayName });
  return json(request, env, { ok: true });
}

export async function deleteAdminUser(request: Request, env: Env, adminId: string) {
  const adminSession = await requireAdmin(request, env);
  if (!adminSession.admin?.isSuper) return error(request, env, 403, 'Only superusers can remove admin users.');

  const row = await env.DB.prepare(
    `SELECT id, email
       FROM admin_users
      WHERE id = ?1
      LIMIT 1`
  ).bind(adminId).first<{ id: string; email: string }>();
  if (!row) return error(request, env, 404, 'Admin user not found.');
  if (text(row.email).toLowerCase() === 'superuser@yoco.com') return error(request, env, 400, 'The root superuser cannot be removed.');
  if (text(row.email).toLowerCase() === text(adminSession.admin?.email).toLowerCase()) return error(request, env, 400, 'You cannot remove your own admin access.');

  const now = nowIso();
  await env.DB.prepare(
    `UPDATE admin_users
        SET status = 'removed',
            updated_at = ?2
      WHERE id = ?1`
  ).bind(adminId, now).run();

  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'admin_user.remove', row.email, { adminId });
  return json(request, env, { ok: true });
}

export async function postAdminUserPasswordReset(request: Request, env: Env, adminId: string) {
  const adminSession = await requireAdmin(request, env);
  if (!adminSession.admin?.isSuper) return error(request, env, 403, 'Only superusers can reset admin passwords.');
  const emailLimited = await checkRateLimit(env.DB, `admin-email:${adminSession.admin.id}`, 20, 3600);
  if (emailLimited.blocked) return error(request, env, 429, 'Too many emails sent recently. Please wait and try again.');

  const row = await env.DB.prepare(
    `SELECT id, email, display_name FROM admin_users WHERE id = ?1 LIMIT 1`
  ).bind(adminId).first<{ id: string; email: string; display_name?: string }>();
  if (!row) return error(request, env, 404, 'Admin user not found.');

  const result = await issueAndNotifyTemporaryPassword(env, {
    email: row.email,
    displayName: text(row.display_name || row.email.split('@')[0]),
    workspaceId: '',
    workspaceName: 'Admin Console'
  });

  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'admin_user.password_reset', row.email, { adminId });
  return json(request, env, { ok: true, temporaryPassword: result.temporaryPassword });
}

/**
 * Per-workspace tenant data (settings/metrics/yoco) that lives in each workspace DO, not in central
 * D1. The front Worker fans out to the DOs to gather this and passes it into getAdminOverview.
 */
export type AdminTenantSummary = {
  settings?: { raw_json?: string; vat_rate?: number; low_stock_email_period?: string; low_stock_email_time?: string };
  metrics?: { stockItemCount?: number; locationCount?: number };
  yoco?: Record<string, unknown>;
};

export type AdminOrgSiteSettings = {
  siteName?: string;
  businessName?: string;
  workspaceName?: string;
  orgId?: string;
  org_id?: string;
  corpId?: string;
  corp_id?: string;
  permissionLevel?: string;
  viewingOnly?: boolean;
  viewing_only?: boolean;
  groupMetadata?: Record<string, unknown> | null;
  linkedSites?: Record<string, unknown>;
  linked_sites?: Record<string, unknown>;
};

export type AdminOrgSettingsProvider = (workspaceIds: string[]) => Promise<Record<string, AdminOrgSiteSettings>>;

export type AdminOrgGroupInput = {
  siteIds: string[];
  linkType: 'org' | 'corp';
  linkId: string;
  groupName: string;
  permissionLevel: string;
  viewingOnly: boolean;
  now: string;
};

export type AdminOrgGroupMutationResult = {
  siteIds: string[];
  linkType: 'org' | 'corp';
  linkId: string;
  groupName: string;
  permissionLevel: string;
};

export type AdminOrgGroupCoordinator = (
  input: AdminOrgGroupInput,
  adminSession: Awaited<ReturnType<typeof requireAdmin>>
) => Promise<AdminOrgGroupMutationResult>;

export type AdminOrgUnlinkInput = {
  siteId: string;
  linkType: 'org' | 'corp';
  now: string;
};

export type AdminOrgUnlinkCoordinator = (
  input: AdminOrgUnlinkInput,
  adminSession: Awaited<ReturnType<typeof requireAdmin>>
) => Promise<{ siteId: string; linkType: 'org' | 'corp'; oldLinkId?: string }>;

export async function getAdminOverview(
  request: Request,
  env: Env,
  tenantDataProvider?: (workspaceIds: string[]) => Promise<Record<string, AdminTenantSummary>>
) {
  const adminSession = await requireAdmin(request, env);
  // TEMPORARY diagnostic (2026-09-05) — see fanOutWorkspaceDOs in index.ts for why. Times the
  // CENTRAL_DB half separately from the per-workspace DO fan-out below, so the two known-slow
  // candidates (a big central join vs. the DO round-trips) don't get conflated in the logs.
  const centralQueriesStartedAt = Date.now();
  const [workspaces, requests, members, invitations, admins] = await Promise.all([
    env.DB.prepare(
      `SELECT w.id, w.name, w.status, w.owner_uid, w.currency, w.timezone, w.created_at, w.updated_at
         FROM workspaces w
        ORDER BY lower(w.name)`
    ).all(),
    env.DB.prepare(
      `SELECT id, email, full_name, site_name, status, workspace_id, requested_at, reviewed_at, reviewed_by
         FROM workspace_registration_requests
        ORDER BY requested_at DESC
        LIMIT 100`
    ).all(),
    env.DB.prepare(
      `SELECT wm.id, wm.workspace_id, wm.auth_uid, wm.email, wm.display_name, wm.status, wm.role_key,
              wm.can_receive_low_stock_email, wm.created_at, wm.updated_at,
              w.name AS workspace_name,
              au.id AS user_id,
              au.display_name AS user_display_name,
              au.status AS user_status,
              au.created_at AS user_created_at
         FROM workspace_members wm
         JOIN workspaces w ON w.id = wm.workspace_id
         LEFT JOIN app_users au ON au.id = wm.auth_uid OR lower(au.email) = lower(wm.email)
        ORDER BY lower(wm.email), lower(w.name)`
    ).all(),
    env.DB.prepare(
      `SELECT wi.id, wi.workspace_id, wi.email, wi.display_name, wi.role_key, wi.status,
              wi.invited_by, wi.created_at, wi.accepted_at, w.name AS workspace_name
         FROM workspace_invitations wi
         JOIN workspaces w ON w.id = wi.workspace_id
        ORDER BY wi.created_at DESC`
    ).all(),
    listAdminUsers(env)
  ]);
  console.log(`[getAdminOverview] CENTRAL_DB queries durationMs=${Date.now() - centralQueriesStartedAt}`);
  const workspaceRows = (workspaces.results || []) as any[];
  const memberRows = (members.results || []) as any[];
  const invitationRows = (invitations.results || []) as any[];
  const requestRows = (requests.results || []) as any[];
  // Settings/metrics/yoco live in each workspace's DO — fanned in by the front Worker (empty if absent).
  // Only wake DOs for active workspaces: an inactive one still needs to appear in the table above
  // (from CENTRAL_DB, no DO involved) but has no reason to be woken on every admin dashboard load —
  // that DO may be dormant with a large accumulated history and a long-pending migration backlog, so
  // touching it here just to fetch settings/metrics nobody's viewing costs a full migration-catch-up
  // attempt for zero benefit. Found 2026-09-05: an inactive tenant's DO was the single slowest call
  // in this fan-out (3360ms vs ~200ms for active ones) and hit SQLITE_NOMEM mid-migration.
  const tenantDataStartedAt = Date.now();
  const activeWorkspaceIds = workspaceRows.filter((r) => r.status === 'active').map((r) => String(r.id));
  const tenantData: Record<string, AdminTenantSummary> = tenantDataProvider
    ? await tenantDataProvider(activeWorkspaceIds)
    : {};
  console.log(`[getAdminOverview] tenantDataProvider (DO fan-out) durationMs=${Date.now() - tenantDataStartedAt}`);
  const workspaceMap: Record<string, any> = {};
  for (const row of workspaceRows) {
    const tenant = tenantData[row.id] || {};
    const settings = tenant.settings || {};
    const metrics = tenant.metrics || {};
    const raw = safeJsonParse<Record<string, any>>(settings.raw_json, {});
    workspaceMap[row.id] = {
      id: row.id,
      data: {
        settings: {
          ...(raw || {}),
          siteName: raw.siteName || raw.businessName || row.name,
          businessName: raw.businessName || row.name,
          vatRate: settings.vat_rate ?? raw.vatRate ?? 15,
          status: row.status,
          ownerUid: row.owner_uid,
          currency: row.currency,
          timezone: row.timezone,
          approvedAt: row.created_at,
          updatedAt: row.updated_at,
          lowStockEmailPeriod: settings.low_stock_email_period,
          lowStockEmailTime: settings.low_stock_email_time
        },
        team: {},
        ingredients: {},
        locations: {},
        integrations: {
          yoco: tenant.yoco || {}
        }
      },
      metrics: {
        stockItemCount: Number(metrics.stockItemCount || 0),
        locationCount: Number(metrics.locationCount || 0)
      }
    };
  }
  const userMap: Record<string, any> = {};
  for (const row of memberRows) {
    const email = text(row.email).toLowerCase();
    if (!email) continue;
    const uid = row.user_id || row.auth_uid || '';
    const key = uid || email.replace(/\./g, '_');
    const workspace = workspaceMap[row.workspace_id];
    if (workspace) {
      workspace.data.team[key] = {
        id: row.id,
        email,
        uid,
        role: row.role_key || 'member',
        name: row.display_name || row.user_display_name || email.split('@')[0],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        canReceiveLowStockEmail: Number(row.can_receive_low_stock_email || 0) === 1
      };
    }
    if (!userMap[email]) {
      userMap[email] = {
        email,
        uid,
        name: row.user_display_name || row.display_name || email.split('@')[0],
        createdAt: row.user_created_at || row.created_at,
        status: row.user_status || row.status || 'active',
        workspaces: {}
      };
    }
    userMap[email].workspaces[row.workspace_id] = {
      id: row.id,
      memberId: row.id,
      role: row.role_key || 'member',
      siteName: row.workspace_name || row.workspace_id,
      name: row.display_name || row.user_display_name || email
    };
  }
  const invitationMap: Record<string, any> = {};
  for (const row of invitationRows) {
    const email = text(row.email).toLowerCase();
    const key = email.replace(/\./g, '_');
    invitationMap[key] = {
      id: row.id,
      email,
      workspaceId: row.workspace_id,
      siteName: row.workspace_name || row.workspace_id,
      role: row.role_key || 'member',
      status: row.status,
      invitedBy: row.invited_by,
      timestamp: row.created_at,
      acceptedAt: row.accepted_at
    };
  }
  const signupRequestMap: Record<string, any> = {};
  for (const row of requestRows) {
    if (row.status !== 'pending') continue;
    const email = text(row.email).toLowerCase();
    const key = email.replace(/\./g, '_');
    signupRequestMap[key] = {
      id: row.id,
      email,
      name: row.full_name,
      siteName: row.site_name,
      status: row.status,
      workspaceId: row.workspace_id,
      requestedAt: row.requested_at,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by
    };
  }
  return json(request, env, {
    ok: true,
    adminSession: {
      isAdmin: true,
      isSuper: Boolean(adminSession.admin?.isSuper),
      email: adminSession.admin?.email || adminSession.auth?.email || '',
      profile: adminSession.admin || null
    },
    admins,
    workspaces: workspaceMap,
    users: userMap,
    invitations: invitationMap,
    signupRequests: signupRequestMap,
    registrationRequests: requestRows
  });
}

export async function postAdminSessionBootstrap(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  const admins = await listAdminUsers(env);
  return json(request, env, {
    ok: true,
    isAdmin: true,
    isSuper: Boolean(adminSession.admin?.isSuper),
    admin: adminSession.admin || null,
    admins
  });
}

export async function getAdminRegistrationRequests(request: Request, env: Env) {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT id, email, full_name, site_name, status, workspace_id, requested_at, reviewed_at, reviewed_by
       FROM workspace_registration_requests
      ORDER BY requested_at DESC
      LIMIT 200`
  ).all();
  return json(request, env, { ok: true, requests: rows.results || [] });
}

export async function postAdminApproveRegistration(request: Request, env: Env, requestId: string) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const adminEmail = text(payload.adminEmail || adminSession.admin?.email || 'admin');
  const row = await env.DB.prepare(
    `SELECT id, email, full_name, site_name, status
       FROM workspace_registration_requests
      WHERE id = ?1
      LIMIT 1`
  ).bind(requestId).first<{ id: string; email: string; full_name: string; site_name: string; status: string }>();
  if (!row) return error(request, env, 404, 'Registration request not found.');
  if (row.status === 'approved') return json(request, env, { ok: true, workspaceId: text(payload.workspaceId) });

  const existing = await env.DB.prepare(`SELECT id FROM app_users WHERE lower(email) = lower(?1) LIMIT 1`).bind(row.email).first<{ id: string }>();
  const userId = existing?.id || id('user');
  const workspaceId = text(payload.workspaceId) || `WS-${slug(row.site_name)}-${crypto.randomUUID().slice(0, 6)}`;
  const now = nowIso();
  const authDelivery = await issueAndNotifyTemporaryPassword(env, {
    email: row.email,
    displayName: row.full_name,
    workspaceId,
    workspaceName: row.site_name
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_users (id, email, display_name, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4)
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name,
         status = 'active',
         updated_at = excluded.updated_at`
    ).bind(userId, row.email.toLowerCase(), row.full_name, now),
    env.DB.prepare(
      `INSERT INTO workspaces (id, name, status, owner_uid, created_at, updated_at)
       VALUES (?1, ?2, 'active', COALESCE((SELECT id FROM app_users WHERE lower(email) = lower(?3)), ?4), ?5, ?5)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         status = 'active',
         updated_at = excluded.updated_at`
    ).bind(workspaceId, row.site_name, row.email, userId, now),
    env.DB.prepare(
      `INSERT INTO workspace_members (id, workspace_id, auth_uid, email, display_name, status, role_key, created_at, updated_at)
       VALUES (?1, ?2, COALESCE((SELECT id FROM app_users WHERE lower(email) = lower(?3)), ?4), ?3, ?5, 'active', 'owner', ?6, ?6)
       ON CONFLICT(workspace_id, email) DO UPDATE SET
         status = 'active',
         role_key = 'owner',
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`
    ).bind(id('member'), workspaceId, row.email.toLowerCase(), userId, row.full_name, now),
    env.DB.prepare(
      `UPDATE workspace_registration_requests
          SET status = 'approved',
              workspace_id = ?2,
              reviewed_at = ?3,
              reviewed_by = ?4
        WHERE id = ?1`
    ).bind(requestId, workspaceId, now, adminEmail)
  ]);
  // NOTE (cloudflare-v2): the new workspace's tenant baseline (workspace_settings + default
  // "Main Storage" location) is seeded into ITS OWN DurableObject by the front Worker after this
  // returns — those tables don't exist in CENTRAL_DB. See provisionWorkspaceTenant in index.ts.

  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'registration.approve', row.email, {
    requestId,
    workspaceId,
    siteName: row.site_name,
    emailDelivery: authDelivery.emailDelivery?.status || ''
  });
  return json(request, env, { ok: true, workspaceId, siteName: row.site_name, auth: authDelivery });
}

export async function postAdminRejectRegistration(request: Request, env: Env, requestId: string) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const row = await env.DB.prepare(
    `SELECT email, site_name
       FROM workspace_registration_requests
      WHERE id = ?1
      LIMIT 1`
  ).bind(requestId).first<{ email?: string; site_name?: string }>();
  await env.DB.prepare(
    `UPDATE workspace_registration_requests
        SET status = 'rejected',
            reviewed_at = ?2,
            reviewed_by = ?3
      WHERE id = ?1`
  ).bind(requestId, nowIso(), text(payload.adminEmail || adminSession.admin?.email || 'admin')).run();
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'registration.reject', text(row?.email || requestId), {
    requestId,
    siteName: text(row?.site_name)
  });
  return json(request, env, { ok: true });
}

export async function getAdminWorkspaces(request: Request, env: Env) {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT w.id, w.name, w.status, w.owner_uid, w.created_at, w.updated_at,
            COUNT(wm.id) AS member_count
       FROM workspaces w
       LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.status = 'active'
      GROUP BY w.id
      ORDER BY lower(w.name)`
  ).all();
  return json(request, env, { ok: true, workspaces: rows.results || [] });
}

export async function deleteAdminWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  purgeTenant?: (workspaceId: string) => Promise<number>
) {
  const adminSession = await requireAdmin(request, env);
  if (!adminSession.admin?.isSuper) return error(request, env, 403, 'Only superusers can delete workspaces.');

  const targetWorkspaceId = text(decodeURIComponent(workspaceId));
  if (!targetWorkspaceId) return error(request, env, 400, 'workspaceId is required.');

  const workspace = await env.DB.prepare(
    `SELECT id, name
       FROM workspaces
      WHERE id = ?1
      LIMIT 1`
  ).bind(targetWorkspaceId).first<{ id: string; name: string }>();
  if (!workspace) return json(request, env, { ok: true, status: 'not-found', workspaceId: targetWorkspaceId });

  const deletedAt = nowIso();
  const deletedBy = text(adminSession.admin?.email || adminSession.auth?.email || 'admin');
  await writeAdminAuditEvent(
    env,
    {
      uid: text(adminSession.auth?.uid || adminSession.admin?.id || ''),
      email: deletedBy
    },
    'workspace.delete',
    targetWorkspaceId,
    { id: workspace.id, name: workspace.name, deletedAt }
  );

  // Tenant plane (all ~40 domain tables) lives in this workspace's DO. The front Worker fans in a
  // purge callback (only it has env.WORKSPACE). All the DELETE FROM <tenant table> statements that
  // used to run here would throw against CENTRAL_DB (no such tables) — that was the 500.
  let tenantRowsDeleted = 0;
  if (purgeTenant) tenantRowsDeleted = await purgeTenant(targetWorkspaceId);

  // Central plane (identity/registry). roles/members/invitations FK-cascade off workspaces, but we
  // delete explicitly for clarity and to cover the non-cascading tables (external_transfers, requests).
  const statements = [
    env.DB.prepare(`DELETE FROM external_transfers WHERE from_workspace_id = ?1 OR to_workspace_id = ?1`).bind(targetWorkspaceId),
    env.DB.prepare(`DELETE FROM workspace_registration_requests WHERE workspace_id = ?1`).bind(targetWorkspaceId),
    env.DB.prepare(`DELETE FROM workspace_invitations WHERE workspace_id = ?1`).bind(targetWorkspaceId),
    env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id = ?1`).bind(targetWorkspaceId),
    env.DB.prepare(`DELETE FROM roles WHERE workspace_id = ?1`).bind(targetWorkspaceId),
    env.DB.prepare(`DELETE FROM workspaces WHERE id = ?1`).bind(targetWorkspaceId)
  ];

  const results = await env.DB.batch(statements);
  const centralRows = results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0);

  return json(request, env, {
    ok: true,
    status: 'deleted',
    workspaceId: targetWorkspaceId,
    workspaceName: workspace.name,
    deletedRows: centralRows + tenantRowsDeleted
  });
}

export async function postAdminMember(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const workspaceId = text(payload.workspaceId);
  const email = text(payload.email).toLowerCase();
  const role = text(payload.role || payload.roleKey || 'member');
  const displayName = text(payload.displayName || payload.name || email.split('@')[0]);
  if (!workspaceId || !email) return error(request, env, 400, 'workspaceId and email are required.');
  const now = nowIso();
  const existing = await env.DB.prepare(`SELECT id FROM app_users WHERE lower(email) = lower(?1) LIMIT 1`).bind(email).first<{ id: string }>();
  const userId = existing?.id || id('user');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_users (id, email, display_name, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4)
       ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, display_name), status = 'active', updated_at = excluded.updated_at`
    ).bind(userId, email, displayName, now),
    env.DB.prepare(
      `INSERT INTO workspace_members (id, workspace_id, auth_uid, email, display_name, status, role_key, created_at, updated_at)
       VALUES (?1, ?2, (SELECT id FROM app_users WHERE lower(email) = lower(?3)), ?3, ?4, 'active', ?5, ?6, ?6)
       ON CONFLICT(workspace_id, email) DO UPDATE SET
         auth_uid = COALESCE(auth_uid, excluded.auth_uid),
         display_name = excluded.display_name,
         role_key = excluded.role_key,
         status = 'active',
         updated_at = excluded.updated_at`
    ).bind(id('member'), workspaceId, email, displayName, role, now)
  ]);
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'member.add', email, { workspaceId, role, displayName });
  return json(request, env, { ok: true });
}

export async function patchAdminMember(request: Request, env: Env, memberId: string) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const now = nowIso();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (payload.role !== undefined) {
    fields.push('role_key = ?');
    values.push(text(payload.role || 'member'));
  }
  if (payload.displayName !== undefined || payload.name !== undefined) {
    fields.push('display_name = ?');
    values.push(text(payload.displayName || payload.name));
  }
  if (payload.status !== undefined) {
    fields.push('status = ?');
    values.push(text(payload.status || 'active'));
  }
  if (payload.canReceiveLowStockEmail !== undefined) {
    fields.push('can_receive_low_stock_email = ?');
    values.push(payload.canReceiveLowStockEmail ? 1 : 0);
  }
  if (!fields.length) return json(request, env, { ok: true });
  fields.push('updated_at = ?');
  values.push(now);
  values.push(memberId);
  await env.DB.prepare(`UPDATE workspace_members SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'member.update', memberId, {
    role: payload.role,
    displayName: payload.displayName || payload.name,
    status: payload.status,
    canReceiveLowStockEmail: payload.canReceiveLowStockEmail
  });
  return json(request, env, { ok: true });
}

export async function deleteAdminMember(request: Request, env: Env, memberId: string) {
  const adminSession = await requireAdmin(request, env);
  await env.DB.prepare(`UPDATE workspace_members SET status = 'removed', updated_at = ?2 WHERE id = ?1`).bind(memberId, nowIso()).run();
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'member.remove', memberId, {});
  return json(request, env, { ok: true });
}

export async function deleteAdminMemberByEmail(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId') || '';
  const email = (url.searchParams.get('email') || '').toLowerCase();
  if (!workspaceId || !email) return error(request, env, 400, 'workspaceId and email are required.');
  await env.DB.prepare(
    `UPDATE workspace_members SET status = 'removed', updated_at = ?3 WHERE workspace_id = ?1 AND lower(email) = lower(?2)`
  ).bind(workspaceId, email, nowIso()).run();
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'member.remove', email, { workspaceId });
  return json(request, env, { ok: true });
}

export async function postAdminAuthRequestReset(request: Request, env: Env) {
  const payload = await readJson<Record<string, unknown>>(request);
  const email = text(payload.email).toLowerCase();
  if (!email) return error(request, env, 400, 'email is required.');
  const row = await env.DB.prepare(
    `SELECT id, email, display_name FROM admin_users WHERE lower(email) = lower(?1) LIMIT 1`
  ).bind(email).first<{ id: string; email: string; display_name?: string }>();
  if (!row) return json(request, env, { ok: true }); // don't leak existence
  await issueAndNotifyTemporaryPassword(env, {
    email: row.email,
    displayName: text(row.display_name || row.email.split('@')[0]),
    workspaceId: '', workspaceName: 'Admin Console'
  });
  return json(request, env, { ok: true });
}

export async function postAdminMemberSendReset(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const email = text(payload.email).toLowerCase();
  if (!email) return error(request, env, 400, 'email is required.');
  const row = await env.DB.prepare(
    `SELECT id, email, display_name FROM app_users WHERE lower(email) = lower(?1) LIMIT 1`
  ).bind(email).first<{ id: string; email: string; display_name?: string }>();
  const ws = await env.DB.prepare(
    `SELECT w.name FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE lower(wm.email) = lower(?1) LIMIT 1`
  ).bind(email).first<{ name: string }>();
  const siteName = ws?.name || 'KCP';
  const result = await issueAndNotifyTemporaryPassword(env, {
    email: row?.email || email,
    displayName: text(row?.display_name || email.split('@')[0]),
    workspaceId: '', workspaceName: siteName
  });
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'member.password_reset', email, {});
  return json(request, env, { ok: true, temporaryPassword: result.temporaryPassword });
}

export async function getAdminInvitations(request: Request, env: Env) {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT wi.id, wi.workspace_id, wi.email, wi.display_name, wi.role_key, wi.status, wi.invited_by, wi.created_at, wi.accepted_at,
            w.name AS workspace_name
       FROM workspace_invitations wi
  LEFT JOIN workspaces w ON w.id = wi.workspace_id
      WHERE wi.status = 'pending'
      ORDER BY wi.created_at DESC
      LIMIT 200`
  ).all();
  return json(request, env, { ok: true, invitations: rows.results || [] });
}

export async function deleteAdminInvitation(request: Request, env: Env, invitationId: string) {
  const adminSession = await requireAdmin(request, env);
  await env.DB.prepare(`DELETE FROM workspace_invitations WHERE id = ?1`).bind(invitationId).run();
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'invitation.delete', invitationId, {});
  return json(request, env, { ok: true });
}

export async function postAdminInvite(request: Request, env: Env) {
  const adminSession = await requireAdmin(request, env);
  const emailLimited = await checkRateLimit(env.DB, `admin-email:${adminSession.admin?.id || 'unknown'}`, 20, 3600);
  if (emailLimited.blocked) return error(request, env, 429, 'Too many emails sent recently. Please wait and try again.');
  const payload = await readJson<Record<string, unknown>>(request);
  const workspaceId = text(payload.workspaceId);
  const email = text(payload.email).toLowerCase();
  const role = text(payload.role || 'member');
  const displayName = text(payload.displayName || payload.name || email.split('@')[0]);
  const invitedBy = text(payload.invitedBy || 'admin');
  if (!workspaceId || !email) return error(request, env, 400, 'workspaceId and email are required.');
  const now = nowIso();
  const workspace = await env.DB.prepare(
    `SELECT name FROM workspaces WHERE id = ?1 LIMIT 1`
  ).bind(workspaceId).first<{ name?: string }>();
  const authDelivery = await issueAndNotifyTemporaryPassword(env, {
    email,
    displayName,
    workspaceId,
    workspaceName: text(workspace?.name || workspaceId)
  });
  await env.DB.prepare(
    `INSERT INTO workspace_invitations (id, workspace_id, email, display_name, role_key, status, invited_by, created_at, raw_json)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8)
     ON CONFLICT(workspace_id, email) DO UPDATE SET
       display_name = excluded.display_name,
       role_key = excluded.role_key,
       status = 'pending',
       invited_by = excluded.invited_by,
       created_at = excluded.created_at,
       raw_json = excluded.raw_json,
       accepted_at = NULL`
  ).bind(id('invite'), workspaceId, email, displayName, role, invitedBy, now, JSON.stringify({
    auth: {
      mustChangePassword: true,
      emailDelivery: authDelivery.emailDelivery,
      temporaryPasswordReturnedToAdmin: Boolean(authDelivery.temporaryPassword)
    }
  })).run();
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'invitation.create', email, {
    workspaceId,
    role,
    emailDelivery: authDelivery.emailDelivery?.status || ''
  });
  return json(request, env, { ok: true, auth: authDelivery });
}

export async function postAdminSaveOrgGroup(
  request: Request,
  env: Env,
  coordinator?: AdminOrgGroupCoordinator
) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const siteIds = Array.isArray(payload.siteIds)
    ? payload.siteIds.map((value) => text(value)).filter(Boolean)
    : [];
  const cleanSiteIds = [...new Set(siteIds)];
  const linkType = groupPrefix(text(payload.linkType || 'org'));
  const fields = groupField(linkType);
  const groupName = text(payload.groupName || 'Linked Group');
  const permissionLevel = text(payload.permissionLevel || 'full_transfer');
  const requestedId = text(payload.linkId);
  const linkId = requestedId || `${linkType}_${crypto.randomUUID()}`;
  const now = nowIso();
  const viewingOnly = permissionLevel === 'corporate_view_only';

  if (!cleanSiteIds.length) return error(request, env, 400, 'Select at least one workspace.');

  if (coordinator) {
    const result = await coordinator({
      siteIds: cleanSiteIds,
      linkType,
      linkId,
      groupName,
      permissionLevel,
      viewingOnly,
      now
    }, adminSession);
    await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'org_group.save', result.linkId, {
      siteIds: result.siteIds,
      linkType: result.linkType,
      groupName: result.groupName,
      permissionLevel: result.permissionLevel
    });
    return json(request, env, { ok: true, ...result });
  }

  const statements: DbStatementLike[] = [];
  for (const workspaceId of cleanSiteIds) {
    const current = await getWorkspaceSettingsMap(env, workspaceId);
    const linkedSites: Record<string, any> = {};
    for (const linkedId of cleanSiteIds) {
      if (linkedId === workspaceId) continue;
      linkedSites[linkedId] = {
        siteId: linkedId,
        linkType,
        linkId,
        groupName,
        permissionLevel,
        linkedAt: now
      };
    }
    const next = {
      ...current,
      [fields.camel]: linkId,
      [fields.snake]: linkId,
      permissionLevel,
      groupMetadata: {
        ...(current.groupMetadata || {}),
        id: linkId,
        name: groupName,
        type: linkType,
        permissionLevel,
        updatedAt: now
      },
      linkedSites: {
        ...(current.linkedSites || {}),
        ...linkedSites
      },
      updatedAt: now
    };
    statements.push(
      env.DB.prepare(
        `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(workspace_id) DO UPDATE SET
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`
      ).bind(workspaceId, JSON.stringify(next), now)
    );
  }

  await env.DB.batch(statements);
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'org_group.save', linkId, {
    siteIds: cleanSiteIds,
    linkType,
    groupName,
    permissionLevel
  });
  return json(request, env, { ok: true, siteIds: cleanSiteIds, linkType, linkId, groupName });
}

export async function postAdminUnlinkOrgSite(
  request: Request,
  env: Env,
  siteId: string,
  coordinator?: AdminOrgUnlinkCoordinator
) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const linkType = groupPrefix(text(payload.linkType || 'org'));

  if (coordinator) {
    const result = await coordinator({ siteId, linkType, now: nowIso() }, adminSession);
    await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'org_group.unlink_site', result.siteId, {
      linkType: result.linkType,
      oldLinkId: text(result.oldLinkId)
    });
    return json(request, env, { ok: true, siteId: result.siteId, linkType: result.linkType });
  }

  const fields = groupField(linkType);
  const current = await getWorkspaceSettingsMap(env, siteId);
  const oldLinkId = text(current[fields.camel] || current[fields.snake]);
  const linkedSites = { ...(current.linkedSites || {}) } as Record<string, any>;
  const now = nowIso();

  for (const linkedId of Object.keys(linkedSites)) {
    const linked = linkedSites[linkedId] || {};
    if (text(linked.linkType || linkType) === linkType) delete linkedSites[linkedId];
  }

  const next: Record<string, any> = {
    ...current,
    linkedSites,
    groupMetadata: {
      ...(current.groupMetadata || {}),
      updatedAt: now
    },
    updatedAt: now
  };
  delete next[fields.camel];
  delete next[fields.snake];
  if (linkType === 'org') {
    delete next.orgId;
    delete next.org_id;
  } else {
    delete next.corpId;
    delete next.corp_id;
  }

  await env.DB.prepare(
    `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(workspace_id) DO UPDATE SET
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`
  ).bind(siteId, JSON.stringify(next), now).run();

  if (oldLinkId) {
    const rows = await env.DB.prepare(
      `SELECT workspace_id, raw_json
         FROM workspace_settings`
    ).all();
    const cleanup: DbStatementLike[] = [];
    for (const row of (rows.results || []) as any[]) {
      if (row.workspace_id === siteId) continue;
      const settings = safeJsonParse<Record<string, any>>(row.raw_json, {});
      const peerLinkedSites = { ...(settings.linkedSites || {}) } as Record<string, any>;
      if (peerLinkedSites[siteId]) {
        delete peerLinkedSites[siteId];
        cleanup.push(
          env.DB.prepare(
            `UPDATE workspace_settings
                SET raw_json = ?2,
                    updated_at = ?3
              WHERE workspace_id = ?1`
          ).bind(row.workspace_id, JSON.stringify({ ...settings, linkedSites: peerLinkedSites, updatedAt: now }), now)
        );
      }
    }
    if (cleanup.length) await env.DB.batch(cleanup);
  }

  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'org_group.unlink_site', siteId, { linkType, oldLinkId });
  return json(request, env, { ok: true, siteId, linkType });
}

export async function getAdminOrgSites(
  request: Request,
  env: Env,
  settingsProvider?: AdminOrgSettingsProvider
) {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT w.id, w.name, w.status, w.org_id, w.corp_id
       FROM workspaces w
      WHERE w.status = 'active'
      ORDER BY lower(w.name) ASC`
  ).all<{ id: string; name: string; status: string; org_id?: string; corp_id?: string }>();
  const workspaceIds = (rows.results || []).map((row) => text(row.id)).filter(Boolean);
  const settingsMap = settingsProvider
    ? await settingsProvider(workspaceIds)
    : Object.fromEntries(await Promise.all(workspaceIds.map(async (workspaceId) => [workspaceId, await getWorkspaceSettingsMap(env, workspaceId)] as const)));

  const sites = (rows.results || []).map((row) => {
    const rawSettings = settingsMap[row.id];
    const settings = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings) ? rawSettings : {};
    const orgId = text(row.org_id || settings.orgId || settings.org_id);
    const corpId = text(row.corp_id || settings.corpId || settings.corp_id);
    return {
      id: row.id,
      name: text(settings.siteName || settings.businessName || row.name || row.id),
      orgId,
      corpId,
      permissionLevel: text(settings.permissionLevel),
      viewingOnly: Boolean(settings.viewingOnly === true || settings.viewing_only === true),
      groupMetadata: settings.groupMetadata || null,
      linkedSites: settings.linkedSites || settings.linked_sites || {}
    };
  });

  return json(request, env, { ok: true, sites });
}

export async function getAdminWorkspaceEmailQueue(request: Request, env: Env, workspaceId: string) {
  await requireAdmin(request, env);
  const invitations = await env.DB.prepare(
    `SELECT id, email, display_name, role_key, status, invited_by, created_at, accepted_at, raw_json
       FROM workspace_invitations
      WHERE workspace_id = ?1
      ORDER BY created_at DESC`
  ).bind(workspaceId).all();
  const queue = (invitations.results || []).map((row: any) => {
    const meta = safeJsonParse<Record<string, any>>(row.raw_json, {});
    return {
      ...row,
      raw_json: undefined,
      welcomeEmailStatus: meta.auth?.emailDelivery?.status || '',
      welcomeEmailSent: Boolean(meta.auth?.emailDelivery?.sent),
      requiresPasswordChange: Boolean(meta.auth?.mustChangePassword)
    };
  });
  return json(request, env, { ok: true, queue });
}

export async function postAdminWorkspaceEmailQueue(request: Request, env: Env, workspaceId: string) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const email = text(payload.email).toLowerCase();
  if (!email) return error(request, env, 400, 'Email is required.');
  const now = nowIso();
  const displayName = text(payload.displayName || payload.name || email.split('@')[0]);
  const workspace = await env.DB.prepare(
    `SELECT name FROM workspaces WHERE id = ?1 LIMIT 1`
  ).bind(workspaceId).first<{ name?: string }>();
  const authDelivery = await issueAndNotifyTemporaryPassword(env, {
    email,
    displayName,
    workspaceId,
    workspaceName: text(workspace?.name || workspaceId)
  });
  await env.DB.prepare(
    `INSERT INTO workspace_invitations (id, workspace_id, email, display_name, role_key, status, invited_by, created_at, raw_json)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8)
     ON CONFLICT(workspace_id, email) DO UPDATE SET
       status = 'pending',
       invited_by = excluded.invited_by,
       created_at = excluded.created_at,
       display_name = excluded.display_name,
       role_key = excluded.role_key,
       raw_json = excluded.raw_json,
       accepted_at = NULL`
  ).bind(
    id('invite'),
    workspaceId,
    email,
    displayName,
    text(payload.role || 'member'),
    text(payload.resentBy || payload.invitedBy || 'admin'),
    now,
    JSON.stringify({
      auth: {
        mustChangePassword: true,
        emailDelivery: authDelivery.emailDelivery,
        temporaryPasswordReturnedToAdmin: Boolean(authDelivery.temporaryPassword)
      }
    })
  ).run();
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'email_queue.requeue', email, {
    workspaceId,
    role: text(payload.role || 'member'),
    emailDelivery: authDelivery.emailDelivery?.status || ''
  });
  return json(request, env, { ok: true, auth: authDelivery });
}

export async function getAdminYocoStatus(request: Request, env: Env, workspaceId: string) {
  await requireAdmin(request, env);
  return json(request, env, await buildAdminYocoStatus(env, workspaceId));
}

export async function buildAdminYocoStatus(env: Env, workspaceId: string) {
  const [connection, catalogue, modifierCatalogue, locations] = await Promise.all([
    getYocoConnection(env, workspaceId),
    env.DB.prepare(
      `SELECT COUNT(*) AS itemsCount
         FROM products
        WHERE workspace_id = ?1 AND external_provider = 'yoco' AND active = 1`
    ).bind(workspaceId).first<{ itemsCount: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS modifierGroupsCount,
              COALESCE(SUM(product_modifier_count), 0) AS productModifiersCount
         FROM yoco_modifier_groups
        WHERE workspace_id = ?1`
    ).bind(workspaceId).first<{ modifierGroupsCount: number; productModifiersCount: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM locations
        WHERE workspace_id = ?1 AND external_provider = 'yoco' AND active = 1`
    ).bind(workspaceId).first<{ count: number }>()
  ]);
  const status = text(connection?.status || 'disconnected').toLowerCase();
  return {
    ok: true,
    workerRelease: KCP_WORKER_RELEASE,
    workerReleaseDate: KCP_WORKER_RELEASE_DATE,
    refundPipelineVersion: KCP_REFUND_PIPELINE_VERSION,
    status,
    connectionActive: connection?.connection_active === 1 || status === 'connected',
    syncState: 'idle',
    health: connection?.last_error ? 'attention' : status === 'connected' ? 'healthy' : 'offline',
    connectedAt: connection?.created_at || '',
    disconnectedAt: connection?.disconnected_at || '',
    lastSyncCompletedAt: connection?.last_sales_sync_at || connection?.last_catalogue_sync_at || '',
    lastImportedAt: connection?.last_catalogue_sync_at || '',
    lastCheckedAt: connection?.last_sales_sync_at || connection?.last_catalogue_sync_at || '',
    updatedAt: connection?.updated_at || connection?.created_at || '',
    lastError: connection?.last_error || '',
    webhook: {
      enabled: Boolean(connection?.webhook_id || connection?.webhook_secret),
      id: connection?.webhook_id || '',
      url: connection?.webhook_url || ''
    },
    catalogue: {
      itemsCount: Number(catalogue?.itemsCount || 0),
      modifierGroupsCount: Number(modifierCatalogue?.modifierGroupsCount || 0),
      productModifiersCount: Number(modifierCatalogue?.productModifiersCount || 0)
    },
    locations: { count: Number(locations?.count || 0) }
  };
}

export async function postAdminYocoConnect(request: Request, env: Env, workspaceId: string) {
  const adminSession = await requireAdmin(request, env);
  const payload = await readJson<Record<string, unknown>>(request);
  const connection = await connectYoco(env, workspaceId, text(payload.apiKey || payload.secretKey));
  const catalogue = await syncYocoCatalogue(env, workspaceId);
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'yoco.connect', workspaceId, {
    webhookEnabled: Boolean(connection.webhookEnabled),
    connected: Boolean(connection.connected),
    historicalSalesImported: false
  });
  return json(request, env, { ok: true, ...connection, catalogueSync: catalogue, historicalSalesImported: false });
}

export async function postAdminYocoDisconnect(request: Request, env: Env, workspaceId: string) {
  const adminSession = await requireAdmin(request, env);
  const result = await disconnectYoco(env, workspaceId);
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'yoco.disconnect', workspaceId, {});
  return json(request, env, { ok: true, ...result });
}

export async function postAdminYocoSyncCatalogue(request: Request, env: Env, workspaceId: string) {
  const adminSession = await requireAdmin(request, env);
  const result = await syncYocoCatalogue(env, workspaceId);
  await writeAdminAuditEvent(env, adminAuditActor(adminSession), 'yoco.sync_catalogue', workspaceId, {
    imported: (result as any)?.imported,
    updated: (result as any)?.updated
  });
  return json(request, env, { ok: true, ...result });
}

// ── System Gmail OAuth ────────────────────────────────────────────────────────

const SYSTEM_GMAIL_SETTING_KEY = 'system_gmail';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SYSTEM_GMAIL_SCOPES = ['openid', 'email', GMAIL_SEND_SCOPE];

function systemGmailConfigured(env: Env) {
  return Boolean(
    text(env.GMAIL_CLIENT_ID) &&
    text(env.GMAIL_CLIENT_SECRET) &&
    text(env.GMAIL_TOKEN_ENCRYPTION_SECRET || env.YOCO_KEY_ENCRYPTION_SECRET)
  );
}

function systemGmailTokenSecret(env: Env) {
  return text(env.GMAIL_TOKEN_ENCRYPTION_SECRET || env.YOCO_KEY_ENCRYPTION_SECRET);
}

function systemGmailRedirectUri(env: Env) {
  // Reuse the same registered redirect URI as the per-workspace Gmail OAuth
  return text(env.GMAIL_OAUTH_REDIRECT_URI) || 'https://kcp-api-v2.adminkitchencostpro.workers.dev/api/gmail/oauth/callback';
}

export async function getSystemGmailStatus(env: Env) {
  const stored = await readAdminSetting<Record<string, any>>(env, SYSTEM_GMAIL_SETTING_KEY, {});
  const status = text(stored.status || 'disconnected');
  return {
    configured: systemGmailConfigured(env),
    status,
    connected: status === 'connected' && Boolean(stored.refreshTokenEncrypted),
    accountEmail: text(stored.accountEmail),
    connectedAt: text(stored.connectedAt),
  };
}

export async function getAdminGmailConnectUrl(request: Request, env: Env) {
  await requireAdmin(request, env);
  if (!systemGmailConfigured(env)) return error(request, env, 400, 'Gmail OAuth is not configured in Worker secrets.');
  const nonce = crypto.randomUUID();
  const state = `system:${nonce}`;
  await writeAdminSetting(env, 'system_gmail_state', { nonce, iat: nowIso() }, 'system');
  const adminOrigin = text(env.APP_BASE_URL || 'https://kcp-live.pages.dev').replace(/\/+$/, '');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', text(env.GMAIL_CLIENT_ID));
  authUrl.searchParams.set('redirect_uri', systemGmailRedirectUri(env));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SYSTEM_GMAIL_SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  return json(request, env, { ok: true, authUrl: authUrl.toString(), adminOrigin });
}

export async function getAdminGmailCallback(request: Request, env: Env) {
  const url = new URL(request.url);
  const adminOrigin = text(env.APP_BASE_URL || 'https://kcp-live.pages.dev').replace(/\/+$/, '');
  try {
    if (!systemGmailConfigured(env)) throw new Error('Gmail OAuth is not configured.');
    const code = text(url.searchParams.get('code'));
    const state = text(url.searchParams.get('state'));
    const googleError = text(url.searchParams.get('error'));
    if (googleError) throw new Error(`Google returned: ${googleError}`);
    if (!code || !state) throw new Error('Missing code or state.');

    const stored = await readAdminSetting<Record<string, any>>(env, 'system_gmail_state', {});
    const expectedNonce = text(stored.nonce);
    if (!expectedNonce || state !== `system:${expectedNonce}`) throw new Error('Invalid OAuth state.');

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: text(env.GMAIL_CLIENT_ID),
        client_secret: text(env.GMAIL_CLIENT_SECRET),
        redirect_uri: systemGmailRedirectUri(env),
        grant_type: 'authorization_code',
      }).toString(),
    });
    const tokens = await tokenRes.json() as Record<string, any>;
    if (!tokenRes.ok || !tokens.refresh_token) throw new Error(text(tokens.error_description || tokens.error || 'No refresh token returned.'));

    // Get account email from id_token or userinfo
    let accountEmail = '';
    if (tokens.id_token) {
      try {
        const payload = JSON.parse(atob(tokens.id_token.split('.')[1]));
        accountEmail = text(payload.email);
      } catch { /* ignore */ }
    }

    const secret = systemGmailTokenSecret(env);
    const refreshTokenEncrypted = await encryptTextWithSecret(secret, text(tokens.refresh_token));
    await writeAdminSetting(env, SYSTEM_GMAIL_SETTING_KEY, {
      status: 'connected',
      refreshTokenEncrypted,
      accountEmail,
      connectedAt: nowIso(),
    }, 'system');

    return new Response(null, {
      status: 302,
      headers: { location: `${adminOrigin}/admin/?gmail=connected` }
    });
  } catch (err) {
    const msg = encodeURIComponent(text((err as any)?.message || 'Gmail connect failed.'));
    return new Response(null, {
      status: 302,
      headers: { location: `${adminOrigin}/admin/?gmail_error=${msg}` }
    });
  }
}

export async function deleteAdminGmail(request: Request, env: Env) {
  await requireAdmin(request, env);
  await writeAdminSetting(env, SYSTEM_GMAIL_SETTING_KEY, { status: 'disconnected' }, 'system');
  return json(request, env, { ok: true });
}

export async function refreshSystemGmailAccessToken(env: Env): Promise<string> {
  const stored = await readAdminSetting<Record<string, any>>(env, SYSTEM_GMAIL_SETTING_KEY, {});
  if (text(stored.status) !== 'connected' || !stored.refreshTokenEncrypted) {
    throw new Error('System Gmail is not connected. Connect it in the Admin Console.');
  }
  const secret = systemGmailTokenSecret(env);
  const refreshToken = await decryptTextWithSecret(secret, text(stored.refreshTokenEncrypted));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: text(env.GMAIL_CLIENT_ID),
      client_secret: text(env.GMAIL_CLIENT_SECRET),
      grant_type: 'refresh_token',
    }).toString(),
  });
  const result = await res.json() as Record<string, any>;
  if (!res.ok || !result.access_token) throw new Error(text(result.error_description || result.error || 'Failed to refresh Gmail token.'));
  return text(result.access_token);
}
