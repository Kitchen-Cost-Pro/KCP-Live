import type { Env } from './types';
import { getEmailDeliveryConfig } from './admin-routes';
import { sendEmail } from './email';

function clean(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function nowIso() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + 2);
  return d.toISOString().replace('Z', '+02:00');
}

function runId() {
  return `low_stock_email_${crypto.randomUUID()}`;
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  try {
    if (!value) return fallback;
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function normalizeFrequency(value: unknown) {
  const raw = clean(value).toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
  if (['off', 'none', 'disabled', 'never', ''].includes(raw)) return 'off';
  if (['daily', 'day', '1_day', '1_days'].includes(raw)) return '1_day';
  if (['2_day', '2_days', 'every_2_days'].includes(raw)) return '2_day';
  if (['weekly', 'week', '1_week', '1_weeks'].includes(raw)) return '1_week';
  if (['2_week', '2_weeks', 'fortnightly'].includes(raw)) return '2_week';
  if (['monthly', 'month', '1_month', '1_months'].includes(raw)) return '1_month';
  return 'off';
}

function intervalMs(frequency: string) {
  const day = 24 * 60 * 60 * 1000;
  if (frequency === '2_day') return 2 * day;
  if (frequency === '1_week') return 7 * day;
  if (frequency === '2_week') return 14 * day;
  if (frequency === '1_month') return 30 * day;
  return day;
}

function frequencyLabel(frequency: string) {
  if (frequency === '2_day') return '2-day';
  if (frequency === '1_week') return 'weekly';
  if (frequency === '2_week') return 'fortnightly';
  if (frequency === '1_month') return 'monthly';
  return 'daily';
}

function normalizeDispatchTime(value: unknown) {
  const match = clean(value || '08:00').match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return '08:00';
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2] || 0)));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function timePartsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value || 0);
  return { hour: part('hour'), minute: part('minute') };
}

function isSendWindow(date: Date, dispatchTime: string, timeZone: string) {
  const [hourText, minuteText] = dispatchTime.split(':');
  const local = timePartsInZone(date, timeZone);
  // Match hour+minute (not hour-only) so a custom dispatch time only opens a window around
  // its own configured minute, with a tolerance matching the cron's 15-minute cadence.
  if (local.hour !== Number(hourText)) return false;
  return Math.abs(local.minute - Number(minuteText || 0)) < 15;
}

// The most recent instant `dispatchTime` (in `timeZone`) occurred at/before `now`, stepped back
// an extra `frequencyDays - 1` days for multi-day frequencies (e.g. "every 2 weeks").
function mostRecentDispatchBoundary(now: Date, dispatchTime: string, timeZone: string, frequencyDays: number) {
  const day = 24 * 60 * 60 * 1000;
  const [hourText, minuteText] = dispatchTime.split(':');
  const targetMinutes = Number(hourText) * 60 + Number(minuteText || 0);
  const local = timePartsInZone(now, timeZone);
  const nowMinutes = local.hour * 60 + local.minute;
  const todaysBoundary = now.getTime() - (nowMinutes - targetMinutes) * 60 * 1000;
  const lastBoundary = todaysBoundary <= now.getTime() ? todaysBoundary : todaysBoundary - day;
  return lastBoundary - Math.max(0, frequencyDays - 1) * day;
}

function isDue(rawSettings: Record<string, any>, lastSentValue: unknown, frequency: string, now: Date, dispatchTime: string, timeZone: string) {
  const lastSentAt = Date.parse(clean(rawSettings.lowStockEmailLastSentAt || lastSentValue));
  if (!Number.isFinite(lastSentAt)) return true;
  // Anchored to the configured dispatch-time boundary rather than a naive rolling
  // `now - lastSentAt` window — otherwise changing dispatchTime to something later than the
  // schema's 08:00 default leaves lastSentAt anchored near 8am, and the new later window never
  // fires until enough time has drifted back around to the old anchor.
  const boundary = mostRecentDispatchBoundary(now, dispatchTime, timeZone, intervalMs(frequency) / (24 * 60 * 60 * 1000));
  return lastSentAt < boundary;
}

function money(value: number) {
  return `R ${Number(value || 0).toFixed(2)}`;
}

function escHtml(value: unknown) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSummaryText(workspaceName: string, frequency: string, rows: Record<string, any>[], generatedAt: string) {
  const groups = groupLowStockByLocation(rows);
  const sections = groups.flatMap(([location, locRows]) => {
    const locDeficit = locRows.reduce((sum, r) => sum + Number(r.deficitValue || 0), 0);
    const lines = locRows.map((row, index) => {
      const qty = Number(row.currentStock || 0).toFixed(2);
      const threshold = Number(row.threshold || 0).toFixed(2);
      const unit = clean(row.unit);
      return `  ${index + 1}. ${clean(row.name)} | ${qty} ${unit} on hand | threshold ${threshold} ${unit} | deficit ${money(Number(row.deficitValue || 0))}`;
    });
    return [
      `Location: ${location} — ${locRows.length} item${locRows.length !== 1 ? 's' : ''} below threshold | deficit ${money(locDeficit)}`,
      ...lines,
      ''
    ];
  });
  return [
    `Low Stock Summary — ${workspaceName}`,
    `Generated: ${generatedAt} | Frequency: ${frequencyLabel(frequency)} | Locations affected: ${groups.length} | Items below threshold: ${rows.length}`,
    '',
    ...sections,
    'Kitchen Cost Pro'
  ].join('\n');
}

function buildSummaryHtml(workspaceName: string, frequency: string, rows: Record<string, any>[], generatedAt: string) {
  const dateLabel = new Date(generatedAt).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });

  const groups = groupLowStockByLocation(rows);
  const renderItemRow = (row: Record<string, any>) => {
    const qty = Number(row.currentStock || 0);
    const threshold = Number(row.threshold || 0);
    const unit = escHtml(row.unit || '');
    const pct = threshold > 0 ? Math.min(100, Math.round((qty / threshold) * 100)) : 0;
    const barColour = pct <= 20 ? '#ef4444' : pct <= 50 ? '#f97316' : '#eab308';
    const deficit = Number(row.deficitValue || 0);
    return `
      <tr style="border-bottom:1px solid #e2e8f0;">
        <td style="padding:10px 12px;font-weight:600;color:#1e293b;">${escHtml(row.name)}</td>
        <td style="padding:10px 12px;color:#64748b;font-size:13px;">${escHtml(row.category || '—')}</td>
        <td style="padding:10px 12px;text-align:right;">
          <span style="font-weight:700;color:${barColour};">${qty.toFixed(2)}</span>
          <span style="color:#94a3b8;font-size:12px;"> ${unit}</span>
        </td>
        <td style="padding:10px 12px;text-align:right;color:#64748b;">${threshold.toFixed(2)} <span style="font-size:12px;">${unit}</span></td>
        <td style="padding:10px 12px;text-align:right;font-weight:600;color:#dc2626;">${money(deficit)}</td>
      </tr>`;
  };
  // One table section per location so recipients see exactly which site is short.
  const tableRows = groups.map(([location, locRows]) => {
    const locDeficit = locRows.reduce((sum, r) => sum + Number(r.deficitValue || 0), 0);
    return `
      <tr style="background:#0f172a;">
        <td colspan="4" style="padding:10px 12px;font-size:12px;font-weight:800;letter-spacing:.4px;color:#e2e8f0;text-transform:uppercase;">${escHtml(location)} &nbsp;&middot;&nbsp; ${locRows.length} item${locRows.length !== 1 ? 's' : ''}</td>
        <td style="padding:10px 12px;text-align:right;font-weight:700;color:#fca5a5;">${money(locDeficit)}</td>
      </tr>
      ${locRows.map(renderItemRow).join('')}`;
  }).join('');

  const totalDeficit = rows.reduce((sum, r) => sum + Number(r.deficitValue || 0), 0);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">

        <!-- Header -->
        <tr><td style="background:#0f172a;padding:28px 32px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:2px;color:#64748b;text-transform:uppercase;">Kitchen Cost Pro</p>
          <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;">Low Stock Alert</h1>
          <p style="margin:6px 0 0;font-size:14px;color:#94a3b8;">${escHtml(workspaceName)}</p>
        </td></tr>

        <!-- Summary strip -->
        <tr><td style="background:#fef2f2;padding:16px 32px;border-bottom:1px solid #fecaca;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:13px;color:#7f1d1d;font-weight:600;">
                &#9888;&#65039; <strong>${rows.length}</strong> low-stock alert${rows.length !== 1 ? 's' : ''} across <strong>${groups.length}</strong> location${groups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; Total deficit value: <strong>${money(totalDeficit)}</strong>
              </td>
              <td align="right" style="font-size:12px;color:#b91c1c;">${escHtml(dateLabel)}</td>
            </tr>
          </table>
        </td></tr>

        <!-- Table -->
        <tr><td style="padding:0;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">Item</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">Category</th>
                <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">On Hand</th>
                <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">Threshold</th>
                <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">Deficit</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">Frequency: ${escHtml(frequencyLabel(frequency))} &nbsp;&middot;&nbsp; Kitchen Cost Pro</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function writeWorkspaceSettingsResult(env: Env, workspaceId: string, rawJson: string, updates: Record<string, unknown>) {
  const raw = {
    ...safeJsonParse<Record<string, any>>(rawJson, {}),
    ...updates
  };
  await env.DB.prepare(
    `UPDATE workspace_settings
        SET raw_json = ?2,
            updated_at = ?3
      WHERE workspace_id = ?1`
  ).bind(workspaceId, JSON.stringify(raw), nowIso()).run();
}

async function recordRun(env: Env, values: {
  workspaceId: string;
  scheduledFor: string;
  sentAt?: string;
  status: string;
  recipientCount?: number;
  itemCount?: number;
  errorMessage?: string;
}) {
  await env.DB.prepare(
    `INSERT INTO low_stock_email_runs
       (id, workspace_id, scheduled_for, sent_at, status, recipient_count, item_count, error_message, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(
    runId(),
    values.workspaceId,
    values.scheduledFor,
    values.sentAt || null,
    values.status,
    values.recipientCount || 0,
    values.itemCount || 0,
    values.errorMessage || null,
    nowIso()
  ).run();
}

async function getLowStockRows(env: Env, workspaceId: string, locationId = '') {
  // Per-LOCATION low-stock rows: a location is low when its own on-hand for an item
  // is at/below the item threshold. Previously this GROUP BY si.id collapsed every
  // location into one row (with names concatenated and a 'Main Store' fallback), so
  // the email never reflected which location was actually short. INNER JOIN on
  // stock_balances mirrors the on-screen per-location stock view, which only surfaces an
  // item at a location where it actually holds a balance.
  const rows = await env.DB.prepare(
    `SELECT
        si.id AS itemId,
        si.name,
        si.category,
        si.unit,
        si.threshold_qty AS threshold,
        si.unit_cost AS unitCost,
        sb.location_id AS locationId,
        COALESCE(l.display_name, l.name, 'Main Store') AS locationName,
        COALESCE(SUM(sb.quantity), 0) AS currentStock,
        MAX(0, si.threshold_qty - COALESCE(SUM(sb.quantity), 0)) * si.unit_cost AS deficitValue
       FROM stock_items si
       JOIN stock_balances sb ON sb.stock_item_id = si.id AND sb.workspace_id = si.workspace_id
       LEFT JOIN locations l ON l.id = sb.location_id AND l.workspace_id = sb.workspace_id AND l.active = 1
      WHERE si.workspace_id = ?1
        AND si.active = 1
        AND si.threshold_qty > 0
        AND (?2 = '' OR sb.location_id = ?2)
      GROUP BY si.id, sb.location_id
     HAVING currentStock <= threshold
      ORDER BY locationName ASC, deficitValue DESC, si.name ASC
      LIMIT 500`
  ).bind(workspaceId, clean(locationId)).all<Record<string, any>>();
  return rows.results || [];
}

function groupLowStockByLocation(rows: Record<string, any>[]) {
  const map = new Map<string, Record<string, any>[]>();
  for (const row of rows) {
    const location = clean(row.locationName || 'Main Store') || 'Main Store';
    if (!map.has(location)) map.set(location, []);
    map.get(location)!.push(row);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function getRecipients(env: Env, workspaceId: string) {
  // workspace_members is a CENTRAL table — read via env.CENTRAL_DB so this works inside the DO too.
  const rows = await env.CENTRAL_DB.prepare(
    `SELECT email, display_name AS displayName
       FROM workspace_members
      WHERE workspace_id = ?1
        AND status = 'active'
        AND can_receive_low_stock_email = 1
        AND email <> ''
      ORDER BY email ASC`
  ).bind(workspaceId).all<{ email: string; displayName?: string }>();
  return (rows.results || []).map((row) => clean(row.email).toLowerCase()).filter(Boolean);
}

// Load a workspace's low-stock context by reading each table from its correct plane:
// `workspaces` from CENTRAL_DB; `workspace_settings` / `low_stock_email_settings` /
// `low_stock_email_runs` from the tenant DB. Replaces the old single cross-plane 4-table join,
// which could only ever succeed in one plane. Returns null if the central workspace row is missing.
async function loadWorkspaceLowStockContext(env: Env, workspaceId: string) {
  const workspace = await env.CENTRAL_DB.prepare(
    `SELECT id AS workspaceId, name, timezone, status FROM workspaces WHERE id = ?1 LIMIT 1`
  ).bind(workspaceId).first<Record<string, any>>();
  if (!workspace || clean(workspace.status) !== 'active') return null;

  const [settingsRow, emailSettingsRow, lastRunRow] = await Promise.all([
    env.DB.prepare(
      `SELECT raw_json AS rawJson, low_stock_email_period AS settingsPeriod, low_stock_email_time AS settingsTime
         FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`
    ).bind(workspaceId).first<Record<string, any>>(),
    env.DB.prepare(
      `SELECT period, dispatch_time AS dispatchTime, timezone AS emailTimezone, enabled
         FROM low_stock_email_settings WHERE workspace_id = ?1 LIMIT 1`
    ).bind(workspaceId).first<Record<string, any>>(),
    env.DB.prepare(
      `SELECT MAX(sent_at) AS lastSentAt FROM low_stock_email_runs
        WHERE workspace_id = ?1 AND status IN ('sent', 'no-low-stock')`
    ).bind(workspaceId).first<{ lastSentAt?: string }>()
  ]);

  return {
    workspaceId,
    name: workspace.name,
    timezone: workspace.timezone,
    rawJson: settingsRow?.rawJson,
    settingsPeriod: settingsRow?.settingsPeriod,
    settingsTime: settingsRow?.settingsTime,
    period: emailSettingsRow?.period,
    dispatchTime: emailSettingsRow?.dispatchTime,
    emailTimezone: emailSettingsRow?.emailTimezone,
    enabled: emailSettingsRow?.enabled,
    lastSentAt: lastRunRow?.lastSentAt
  };
}

async function sendWorkspaceLowStockSummary(env: Env, workspace: Record<string, any>, now: Date) {
  const workspaceId = clean(workspace.workspaceId);
  const rawSettings = safeJsonParse<Record<string, any>>(workspace.rawJson, {});
  if (workspace.enabled !== null && workspace.enabled !== undefined && Number(workspace.enabled) === 0) {
    return { workspaceId, status: 'disabled' };
  }
  const explicitFrequency = rawSettings.lowStockEmailFrequency || workspace.settingsPeriod || workspace.period;
  const frequency = normalizeFrequency(explicitFrequency);
  const checkedAt = now.toISOString();
  if (frequency === 'off') return { workspaceId, status: 'disabled' };

  const timeZone = clean(rawSettings.lowStockEmailTimeZone || rawSettings.timeZone || workspace.emailTimezone || workspace.timezone || 'Africa/Johannesburg');
  const dispatchTime = normalizeDispatchTime(rawSettings.lowStockEmailDispatchTime || workspace.settingsTime || workspace.dispatchTime);
  const inWindow = isSendWindow(now, dispatchTime, timeZone);
  const due = isDue(rawSettings, workspace.lastSentAt, frequency, now, dispatchTime, timeZone);
  console.log(`[low-stock] ws=${workspaceId} freq=${frequency} dispatch=${dispatchTime} tz=${timeZone} inWindow=${inWindow} due=${due}`);
  if (!inWindow) return { workspaceId, status: 'outside_send_window' };
  if (!due) return { workspaceId, status: 'not_due' };

  const recipients = await getRecipients(env, workspaceId);
  const rows = await getLowStockRows(env, workspaceId);

  if (!recipients.length) {
    await writeWorkspaceSettingsResult(env, workspaceId, clean(workspace.rawJson), {
      lowStockEmailLastCheckedAt: checkedAt,
      lowStockEmailLastResult: 'no-tagged-recipients'
    });
    await recordRun(env, { workspaceId, scheduledFor: checkedAt, status: 'no-recipients' });
    return { workspaceId, status: 'no_recipients' };
  }

  if (!rows.length) {
    await writeWorkspaceSettingsResult(env, workspaceId, clean(workspace.rawJson), {
      lowStockEmailLastSentAt: checkedAt,
      lowStockEmailLastCheckedAt: checkedAt,
      lowStockEmailLastResult: 'no-low-stock',
      lowStockEmailLastRecipientCount: recipients.length,
      lowStockEmailLastLowStockCount: 0
    });
    await recordRun(env, { workspaceId, scheduledFor: checkedAt, sentAt: checkedAt, status: 'no-low-stock', recipientCount: recipients.length });
    return { workspaceId, status: 'no_low_stock', recipients: recipients.length };
  }

  const emailConfig = await getEmailDeliveryConfig(env);
  const workspaceName = clean(rawSettings.siteName || workspace.name || workspaceId);
  const subject = `Low Stock Alert — ${workspaceName} (${rows.length} item${rows.length !== 1 ? 's' : ''})`;
  const text = buildSummaryText(workspaceName, frequency, rows, checkedAt);
  const html = buildSummaryHtml(workspaceName, frequency, rows, checkedAt);
  const delivery = await sendEmail(env, emailConfig, { to: recipients, subject, text, html });
  const status = delivery.sent ? 'sent' : 'email-error';
  await writeWorkspaceSettingsResult(env, workspaceId, clean(workspace.rawJson), {
    lowStockEmailLastSentAt: delivery.sent ? checkedAt : rawSettings.lowStockEmailLastSentAt,
    lowStockEmailLastCheckedAt: checkedAt,
    lowStockEmailLastResult: status,
    lowStockEmailLastRecipientCount: recipients.length,
    lowStockEmailLastLowStockCount: rows.length,
    lowStockEmailLastError: delivery.sent ? '' : clean((delivery as any).reason || 'Email delivery failed.')
  });
  await recordRun(env, {
    workspaceId,
    scheduledFor: checkedAt,
    sentAt: delivery.sent ? checkedAt : undefined,
    status,
    recipientCount: recipients.length,
    itemCount: rows.length,
    errorMessage: delivery.sent ? undefined : clean((delivery as any).reason || 'Email delivery failed.')
  });
  return { workspaceId, status, recipients: recipients.length, lowStockCount: rows.length };
}

// Per-workspace scheduled send (due/window-gated). Runs INSIDE the workspace DO — the front
// Worker's scheduled() handler enumerates active workspaces from CENTRAL_DB and fans out here,
// because the per-workspace stock/settings/run tables are tenant-only.
export async function sendWorkspaceLowStockDue(env: Env, workspaceId: string, now = new Date()) {
  const context = await loadWorkspaceLowStockContext(env, workspaceId);
  if (!context) return { workspaceId, status: 'not_found' };
  try {
    return await sendWorkspaceLowStockSummary(env, context, now);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Low stock summary failed.';
    console.error(`[low-stock] due ws=${workspaceId} failed: ${message}`);
    await recordRun(env, { workspaceId, scheduledFor: now.toISOString(), status: 'error', errorMessage: message }).catch(() => null);
    return { workspaceId, status: 'error', error: message };
  }
}

export async function sendWorkspaceLowStockNow(env: Env, workspaceId: string) {
  const workspace = await loadWorkspaceLowStockContext(env, workspaceId);
  if (!workspace) throw new Error('Workspace not found.');

  const rawSettings = safeJsonParse<Record<string, any>>(workspace.rawJson, {});
  const recipients = await getRecipients(env, workspaceId);
  const rows = await getLowStockRows(env, workspaceId);
  const now = nowIso();
  const workspaceName = clean(rawSettings.siteName || workspace.name || workspaceId);

  if (!recipients.length) return { workspaceId, status: 'no_recipients', recipients: 0, lowStockCount: rows.length };
  if (!rows.length) return { workspaceId, status: 'no_low_stock', recipients: recipients.length, lowStockCount: 0 };

  const emailConfig = await getEmailDeliveryConfig(env);
  const subject = `Low Stock Alert — ${workspaceName} (${rows.length} item${rows.length !== 1 ? 's' : ''})`;
  const text = buildSummaryText(workspaceName, 'manual', rows, now);
  const html = buildSummaryHtml(workspaceName, 'manual', rows, now);
  const delivery = await sendEmail(env, emailConfig, { to: recipients, subject, text, html });

  await recordRun(env, {
    workspaceId,
    scheduledFor: now,
    sentAt: delivery.sent ? now : undefined,
    status: delivery.sent ? 'sent' : 'email-error',
    recipientCount: recipients.length,
    itemCount: rows.length,
    errorMessage: delivery.sent ? undefined : clean((delivery as any).reason || 'Email delivery failed.')
  });

  return { workspaceId, status: delivery.sent ? 'sent' : 'email-error', recipients: recipients.length, lowStockCount: rows.length };
}


export async function sendWorkspaceLowStockToUser(
  env: Env,
  workspaceId: string,
  recipient: string,
  locationId = '',
) {
  const email = clean(recipient).toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Your signed-in account does not have a valid email address.');
  }
  const workspace = await loadWorkspaceLowStockContext(env, workspaceId);
  if (!workspace) throw new Error('Workspace not found.');
  const rawSettings = safeJsonParse<Record<string, any>>(workspace.rawJson, {});
  const rows = await getLowStockRows(env, workspaceId, locationId);
  const generatedAt = nowIso();
  const workspaceName = clean(rawSettings.siteName || workspace.name || workspaceId);
  if (!rows.length) {
    return { workspaceId, status: 'no_low_stock', recipients: 0, lowStockCount: 0 };
  }
  const locationLabel = clean(rows[0]?.locationName);
  const subject = `Stock Notifications — ${workspaceName}${locationLabel ? ` · ${locationLabel}` : ''} (${rows.length})`;
  const emailConfig = await getEmailDeliveryConfig(env);
  const text = buildSummaryText(workspaceName, 'manual', rows, generatedAt);
  const html = buildSummaryHtml(workspaceName, 'manual', rows, generatedAt);
  const delivery = await sendEmail(env, emailConfig, { to: email, subject, text, html });
  await recordRun(env, {
    workspaceId,
    scheduledFor: generatedAt,
    sentAt: delivery.sent ? generatedAt : undefined,
    status: delivery.sent ? 'sent' : 'email-error',
    recipientCount: 1,
    itemCount: rows.length,
    errorMessage: delivery.sent ? undefined : clean((delivery as any).reason || 'Email delivery failed.'),
  });
  if (!delivery.sent) throw new Error(clean((delivery as any).reason || 'Email delivery failed.'));
  return { workspaceId, status: 'sent', recipients: 1, lowStockCount: rows.length, recipient: email };
}
