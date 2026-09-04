import type { AuthContext, Env } from '../../legacy/types';
import { text, nowIso, xeroConfigured, xeroRedirectUri } from './config';
import { signXeroState, verifyXeroState, buildXeroAuthorizeUrl, exchangeXeroCode, fetchXeroConnections } from './oauth';
import { getXeroConnection, saveXeroConnection, disconnectXero } from './connection';
import { fetchXeroTaxRates, fetchXeroTrackingCategories, fetchXeroAccounts, XeroApiClientError } from './api-client';
import { canManageXero } from './admin-permissions';
import { syncXeroItemsForWorkspace } from './item-sync';
import { syncXeroDailyInvoice, upsertXeroTodayInvoice, claimDailyInvoiceSyncIfDue, releaseDailyInvoiceSyncClaim, yesterdayDateKey, todayDateKey } from './invoice-sync';
import { getWorkspaceTradingDayStartHour } from './trading-day';
import {
  syncPendingXeroGrvs,
  claimDailyGrvSyncIfDue,
  releaseDailyGrvSyncClaim,
  listPendingSupplierMatches,
  resolveSupplierMatch,
  syncAllSuppliersToXero
} from './grv-sync';
import {
  syncPendingXeroCreditNotes,
  claimDailyCreditNoteSyncIfDue,
  releaseDailyCreditNoteSyncClaim
} from './credit-note-sync';
import {
  syncXeroDailyWastage,
  upsertXeroTodayWastage,
  claimDailyWastageSyncIfDue,
  releaseDailyWastageSyncClaim
} from './wastage-sync';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Mirrors gmailCallbackHtml in legacy/routes.ts: the frontend opens the Xero consent screen in a
// popup (window.open), so this callback page posts a message back to the opener and closes itself
// rather than relying on a redirect the popup's own location bar would show.
function callbackHtml(message: string, ok: boolean): Response {
  const safe = text(message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return html(
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Xero ${ok ? 'Connected' : 'Connection Failed'}</title></head>
<body style="font-family:Inter,Arial,sans-serif;background:#08111f;color:#f5f8ff;display:grid;place-items:center;min-height:100vh;margin:0">
  <main style="max-width:520px;padding:28px;border:1px solid #28415f;border-radius:16px;background:#101b2c;text-align:center">
    <h1 style="margin:0 0 12px">${ok ? 'Xero connected' : 'Xero connection failed'}</h1>
    <p style="color:#aebbd0">${safe}</p>
  </main>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'kcp:xero-oauth', ok: ${ok ? 'true' : 'false'}, message: ${JSON.stringify(message)} }, '*');
      window.setTimeout(() => window.close(), 900);
    }
  </script>
</body></html>`,
    ok ? 200 : 400
  );
}

interface SyncSettingsRow {
  sales_account_code: string | null;
  default_tax_type: string | null;
  sales_exempt_tax_type: string | null;
  item_account_code: string | null;
  purchase_account_code: string | null;
  purchase_tax_type: string | null;
  purchase_exempt_tax_type: string | null;
  cod_payment_account_code: string | null;
  location_tracking_category_id: string | null;
  wastage_expense_account_code: string | null;
  wastage_asset_account_code: string | null;
  enabled: number;
  grv_sync_enabled: number;
  credit_note_sync_enabled: number;
  wastage_sync_enabled: number;
  last_item_sync_at: string | null;
  last_invoice_sync_date: string | null;
  last_grv_sync_date: string | null;
  last_credit_note_sync_date: string | null;
  last_wastage_sync_date: string | null;
}

async function getSyncSettings(env: Env, workspaceId: string): Promise<SyncSettingsRow | null> {
  return env.DB.prepare(`SELECT * FROM xero_sync_settings WHERE workspace_id = ?1 LIMIT 1`).bind(workspaceId).first<SyncSettingsRow>();
}

async function getStatus(env: Env, workspaceId: string) {
  const [connection, settings, pendingSupplierMatches] = await Promise.all([
    getXeroConnection(env, workspaceId),
    getSyncSettings(env, workspaceId),
    listPendingSupplierMatches(env, workspaceId)
  ]);
  return response({
    ok: true,
    configured: xeroConfigured(env),
    status: connection?.status || 'disconnected',
    tenantName: text(connection?.tenant_name),
    lastError: text(connection?.last_error),
    settings: settings
      ? {
          salesAccountCode: text(settings.sales_account_code),
          defaultTaxType: text(settings.default_tax_type),
          salesExemptTaxType: text(settings.sales_exempt_tax_type),
          itemAccountCode: text(settings.item_account_code),
          purchaseAccountCode: text(settings.purchase_account_code),
          purchaseTaxType: text(settings.purchase_tax_type),
          purchaseExemptTaxType: text(settings.purchase_exempt_tax_type),
          codPaymentAccountCode: text(settings.cod_payment_account_code),
          locationTrackingCategoryId: text(settings.location_tracking_category_id),
          wastageExpenseAccountCode: text(settings.wastage_expense_account_code),
          wastageAssetAccountCode: text(settings.wastage_asset_account_code),
          enabled: Boolean(settings.enabled),
          grvSyncEnabled: Boolean(settings.grv_sync_enabled),
          creditNoteSyncEnabled: Boolean(settings.credit_note_sync_enabled),
          wastageSyncEnabled: Boolean(settings.wastage_sync_enabled),
          lastItemSyncAt: text(settings.last_item_sync_at),
          lastInvoiceSyncDate: text(settings.last_invoice_sync_date),
          lastGrvSyncDate: text(settings.last_grv_sync_date),
          lastCreditNoteSyncDate: text(settings.last_credit_note_sync_date),
          lastWastageSyncDate: text(settings.last_wastage_sync_date)
        }
      : null,
    pendingSupplierMatches
  });
}

async function postConnectStart(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  if (!xeroConfigured(env)) return response({ ok: false, error: 'Xero OAuth is not configured for this environment.' }, 400);
  const state = await signXeroState(env, { workspaceId, uid: auth.uid, email: auth.email, iat: Date.now(), nonce: crypto.randomUUID() });
  return response({ ok: true, authUrl: buildXeroAuthorizeUrl(request, env, state), redirectUri: xeroRedirectUri(request, env) });
}

async function getOauthCallback(request: Request, env: Env) {
  const url = new URL(request.url);
  try {
    if (!xeroConfigured(env)) throw new Error('Xero OAuth is not configured.');
    const xeroError = text(url.searchParams.get('error'));
    if (xeroError) throw new Error(xeroError);
    const code = text(url.searchParams.get('code'));
    if (!code) throw new Error('Xero did not return an authorization code.');
    const state = await verifyXeroState(env, text(url.searchParams.get('state')));
    const workspaceId = text(state.workspaceId);
    if (!workspaceId) throw new Error('Workspace is missing from the Xero connection state.');

    const token = await exchangeXeroCode(request, env, code);
    const accessToken = text(token.access_token);
    const refreshToken = text(token.refresh_token);
    if (!accessToken || !refreshToken) throw new Error('Xero did not return a usable access/refresh token pair.');

    const connections = await fetchXeroConnections(accessToken);
    const tenant = connections[0];
    if (!tenant) throw new Error('No Xero organisation is authorized for this connection.');

    await saveXeroConnection(env, workspaceId, {
      xeroTenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      accessToken,
      refreshToken,
      expiresInSeconds: Number(token.expires_in) || 1800,
      scope: text(token.scope),
      connectedByUid: text(state.uid),
      connectedByEmail: text(state.email)
    });
    await env.DB.prepare(
      `INSERT INTO xero_sync_settings (workspace_id, enabled, created_at, updated_at)
       VALUES (?1, 0, ?2, ?2)
       ON CONFLICT(workspace_id) DO NOTHING`
    )
      .bind(workspaceId, nowIso())
      .run();

    return callbackHtml(`Connected to ${tenant.tenantName || 'your Xero organisation'}. Set your sales account code and tax type in Xero settings before enabling sync.`, true);
  } catch (cause) {
    return callbackHtml(cause instanceof Error ? cause.message : 'Xero connection failed.', false);
  }
}

async function postDisconnect(env: Env, workspaceId: string) {
  await disconnectXero(env, workspaceId);
  return response({ ok: true });
}

async function postSettings(request: Request, env: Env, workspaceId: string) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const salesAccountCode = text(body.salesAccountCode);
  const defaultTaxType = text(body.defaultTaxType);
  const salesExemptTaxType = text(body.salesExemptTaxType);
  const itemAccountCode = text(body.itemAccountCode) || salesAccountCode;
  const enabled = Boolean(body.enabled);
  const purchaseAccountCode = text(body.purchaseAccountCode);
  const purchaseTaxType = text(body.purchaseTaxType);
  const purchaseExemptTaxType = text(body.purchaseExemptTaxType);
  const codPaymentAccountCode = text(body.codPaymentAccountCode);
  const locationTrackingCategoryId = text(body.locationTrackingCategoryId);
  const wastageExpenseAccountCode = text(body.wastageExpenseAccountCode);
  const wastageAssetAccountCode = text(body.wastageAssetAccountCode);
  const grvSyncEnabled = Boolean(body.grvSyncEnabled);
  const creditNoteSyncEnabled = Boolean(body.creditNoteSyncEnabled);
  const wastageSyncEnabled = Boolean(body.wastageSyncEnabled);
  if (enabled && (!salesAccountCode || !defaultTaxType)) {
    return response({ ok: false, error: 'A sales account code and tax type are required before enabling sync.' }, 400);
  }
  if (grvSyncEnabled && (!purchaseAccountCode || !purchaseTaxType)) {
    return response({ ok: false, error: 'A purchases account code and tax type are required before enabling GRV sync.' }, 400);
  }
  // A COD GRV pushes AUTHORISED (not Draft) precisely because it's already paid at delivery — no
  // bookkeeper review needed (see buildGrvBillPayload's doc comment). But "already paid" is only
  // actually true in Xero once applyCodPayment records a matching Payment against that Bill, which
  // silently no-ops without this account code — leaving a COD Bill sitting AUTHORISED but UNPAID,
  // i.e. an open liability for a purchase that was, in reality, already settled. Requiring this
  // up front closes that gap instead of leaving it as a silent, easy-to-miss misconfiguration.
  if (grvSyncEnabled && !codPaymentAccountCode) {
    return response({ ok: false, error: 'A COD payment account is required before enabling GRV sync — COD GRVs push as paid/final, and Xero needs an account to record that payment against.' }, 400);
  }
  if (creditNoteSyncEnabled && (!purchaseAccountCode || !purchaseTaxType)) {
    return response({ ok: false, error: 'A purchases account code and tax type are required before enabling Credit Note sync.' }, 400);
  }
  if (wastageSyncEnabled && (!wastageExpenseAccountCode || !wastageAssetAccountCode)) {
    return response({ ok: false, error: 'A wastage expense account and an inventory asset account are required before enabling wastage sync.' }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO xero_sync_settings (workspace_id, sales_account_code, default_tax_type, sales_exempt_tax_type, item_account_code, enabled, purchase_account_code, purchase_tax_type, purchase_exempt_tax_type, cod_payment_account_code, location_tracking_category_id, wastage_expense_account_code, wastage_asset_account_code, grv_sync_enabled, credit_note_sync_enabled, wastage_sync_enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
     ON CONFLICT(workspace_id) DO UPDATE SET
       sales_account_code = excluded.sales_account_code,
       default_tax_type = excluded.default_tax_type,
       sales_exempt_tax_type = excluded.sales_exempt_tax_type,
       item_account_code = excluded.item_account_code,
       enabled = excluded.enabled,
       purchase_account_code = excluded.purchase_account_code,
       purchase_tax_type = excluded.purchase_tax_type,
       purchase_exempt_tax_type = excluded.purchase_exempt_tax_type,
       cod_payment_account_code = excluded.cod_payment_account_code,
       location_tracking_category_id = excluded.location_tracking_category_id,
       wastage_expense_account_code = excluded.wastage_expense_account_code,
       wastage_asset_account_code = excluded.wastage_asset_account_code,
       grv_sync_enabled = excluded.grv_sync_enabled,
       credit_note_sync_enabled = excluded.credit_note_sync_enabled,
       wastage_sync_enabled = excluded.wastage_sync_enabled,
       updated_at = excluded.updated_at`
  )
    .bind(
      workspaceId,
      salesAccountCode,
      defaultTaxType,
      salesExemptTaxType,
      itemAccountCode,
      enabled ? 1 : 0,
      purchaseAccountCode,
      purchaseTaxType,
      purchaseExemptTaxType,
      codPaymentAccountCode,
      locationTrackingCategoryId,
      wastageExpenseAccountCode,
      wastageAssetAccountCode,
      grvSyncEnabled ? 1 : 0,
      creditNoteSyncEnabled ? 1 : 0,
      wastageSyncEnabled ? 1 : 0,
      nowIso()
    )
    .run();
  return response({ ok: true });
}

async function postResolveSupplierMatch(request: Request, env: Env, workspaceId: string) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const supplierId = text(body.supplierId);
  if (!supplierId) return response({ ok: false, error: 'supplierId is required.' }, 400);
  const result = await resolveSupplierMatch(env, workspaceId, {
    supplierId,
    xeroContactId: text(body.xeroContactId) || undefined,
    createNew: Boolean(body.createNew)
  });
  if (!result.ok) return response({ ok: false, error: result.error }, 400);
  return response({ ok: true, contactId: result.contactId });
}

async function postSyncNow(env: Env, workspaceId: string, kind: string) {
  const settings = await getSyncSettings(env, workspaceId);
  if (!settings) return response({ ok: false, error: 'Connect Xero and set up sync settings first.' }, 400);
  // GRV/Credit Note sync each have their own independent account-code/tax settings (checked in
  // their own branches below) — neither needs sales_account_code/default_tax_type, which only
  // gate the sales-side kinds. Supplier matching needs no account-code/tax setup at all — it only
  // reads/matches Contacts.
  if (
    kind !== 'grv' &&
    kind !== 'credit-notes' &&
    kind !== 'wastage' &&
    kind !== 'wastage-today' &&
    kind !== 'suppliers' &&
    (!settings.sales_account_code || !settings.default_tax_type)
  ) {
    return response({ ok: false, error: 'Set a sales account code and tax type in Xero settings first.' }, 400);
  }
  if (kind === 'suppliers') {
    const result = await syncAllSuppliersToXero(env, workspaceId);
    return response({ ok: true, result });
  }
  if (kind === 'items') {
    const result = await syncXeroItemsForWorkspace(env, workspaceId, {
      itemAccountCode: text(settings.item_account_code) || text(settings.sales_account_code),
      defaultTaxType: text(settings.default_tax_type)
    });
    return response({ ok: true, result });
  }
  if (kind === 'invoice') {
    // The real day-to-day push: always targets yesterday's closed trading day, same as the
    // automatic due-check, and is a strict once-per-day no-op if already pushed.
    const startHour = await getWorkspaceTradingDayStartHour(env, workspaceId);
    const dateKey = yesterdayDateKey(startHour);
    const result = await syncXeroDailyInvoice(env, workspaceId, dateKey, {
      salesAccountCode: text(settings.sales_account_code),
      defaultTaxType: text(settings.default_tax_type),
      salesExemptTaxType: text(settings.sales_exempt_tax_type),
      locationTrackingCategoryId: text(settings.location_tracking_category_id)
    }, startHour);
    return response({ ok: true, dateKey, result });
  }
  if (kind === 'invoice-today') {
    // Unlike "invoice" above, this re-aggregates and upserts on every call — see
    // upsertXeroTodayInvoice's comment for why that's safe/correct only for a still-open day.
    const startHour = await getWorkspaceTradingDayStartHour(env, workspaceId);
    const result = await upsertXeroTodayInvoice(env, workspaceId, {
      salesAccountCode: text(settings.sales_account_code),
      defaultTaxType: text(settings.default_tax_type),
      salesExemptTaxType: text(settings.sales_exempt_tax_type),
      locationTrackingCategoryId: text(settings.location_tracking_category_id)
    }, startHour);
    return response({ ok: true, dateKey: todayDateKey(startHour), result });
  }
  if (kind === 'grv') {
    if (!settings.purchase_account_code || !settings.purchase_tax_type) {
      return response({ ok: false, error: 'Set a purchases account code and tax type in Xero settings first.' }, 400);
    }
    // Same underlying scan as the automatic due-check (see runDueGrvSync below) — this just runs
    // it immediately instead of waiting for the once-a-day claim to become due.
    const result = await syncPendingXeroGrvs(env, workspaceId, {
      purchaseAccountCode: text(settings.purchase_account_code),
      purchaseTaxType: text(settings.purchase_tax_type),
      purchaseExemptTaxType: text(settings.purchase_exempt_tax_type),
      codPaymentAccountCode: text(settings.cod_payment_account_code),
      locationTrackingCategoryId: text(settings.location_tracking_category_id)
    });
    return response({ ok: true, result });
  }
  if (kind === 'credit-notes') {
    if (!settings.purchase_account_code || !settings.purchase_tax_type) {
      return response({ ok: false, error: 'Set a purchases account code and tax type in Xero settings first.' }, 400);
    }
    // Same underlying scan as the automatic due-check (see runDueCreditNoteSync below) — this just
    // runs it immediately instead of waiting for the once-a-day claim to become due.
    const result = await syncPendingXeroCreditNotes(env, workspaceId, {
      purchaseAccountCode: text(settings.purchase_account_code),
      purchaseTaxType: text(settings.purchase_tax_type),
      purchaseExemptTaxType: text(settings.purchase_exempt_tax_type),
      locationTrackingCategoryId: text(settings.location_tracking_category_id)
    });
    return response({ ok: true, result });
  }
  if (kind === 'wastage') {
    if (!settings.wastage_expense_account_code || !settings.wastage_asset_account_code) {
      return response({ ok: false, error: 'Set a wastage expense account and an inventory asset account in Xero settings first.' }, 400);
    }
    const startHour = await getWorkspaceTradingDayStartHour(env, workspaceId);
    const dateKey = yesterdayDateKey(startHour);
    const result = await syncXeroDailyWastage(env, workspaceId, dateKey, {
      wastageExpenseAccountCode: text(settings.wastage_expense_account_code),
      wastageAssetAccountCode: text(settings.wastage_asset_account_code),
      locationTrackingCategoryId: text(settings.location_tracking_category_id)
    }, startHour);
    return response({ ok: true, dateKey, result });
  }
  if (kind === 'wastage-today') {
    if (!settings.wastage_expense_account_code || !settings.wastage_asset_account_code) {
      return response({ ok: false, error: 'Set a wastage expense account and an inventory asset account in Xero settings first.' }, 400);
    }
    const startHour = await getWorkspaceTradingDayStartHour(env, workspaceId);
    const result = await upsertXeroTodayWastage(env, workspaceId, {
      wastageExpenseAccountCode: text(settings.wastage_expense_account_code),
      wastageAssetAccountCode: text(settings.wastage_asset_account_code),
      locationTrackingCategoryId: text(settings.location_tracking_category_id)
    }, startHour);
    return response({ ok: true, dateKey: todayDateKey(startHour), result });
  }
  return response({ ok: false, error: 'Unknown sync kind. Use "items", "invoice", "invoice-today", "grv", "credit-notes", "wastage", "wastage-today", or "suppliers".' }, 400);
}

async function runDueInvoiceSync(env: Env, workspaceId: string) {
  // Read once and pass through everywhere below — claimDailyInvoiceSyncIfDue and
  // syncXeroDailyInvoice must agree on which calendar date "yesterday's trading day" is, or a
  // late-trading venue could claim one date and aggregate sales for a different one.
  const startHour = await getWorkspaceTradingDayStartHour(env, workspaceId);
  const claim = await claimDailyInvoiceSyncIfDue(env, workspaceId, startHour);
  if (!claim.due || !claim.dateKey) return { skipped: true } as const;
  const settings = await getSyncSettings(env, workspaceId);
  if (!settings || !settings.sales_account_code || !settings.default_tax_type) {
    await releaseDailyInvoiceSyncClaim(env, workspaceId, claim.dateKey, false);
    return { skipped: true, reason: 'Xero sync settings incomplete.' } as const;
  }
  const result = await syncXeroDailyInvoice(env, workspaceId, claim.dateKey, {
    salesAccountCode: text(settings.sales_account_code),
    defaultTaxType: text(settings.default_tax_type),
    salesExemptTaxType: text(settings.sales_exempt_tax_type),
    locationTrackingCategoryId: text(settings.location_tracking_category_id)
  }, startHour);
  const success = result.status === 'applied' || result.status === 'duplicate' || result.status === 'skipped_no_sales';
  await releaseDailyInvoiceSyncClaim(env, workspaceId, claim.dateKey, success);
  return { dateKey: claim.dateKey, result } as const;
}

// GRVs are claimed/released independently of the sales invoice above — a workspace can run one
// without the other, and a failure in one never blocks the other's due-check tick. Runs from the
// same due-check tick so GRVs go out "along with POS data once a day," per the plan.
async function runDueGrvSync(env: Env, workspaceId: string) {
  const claim = await claimDailyGrvSyncIfDue(env, workspaceId);
  if (!claim.due || !claim.dateKey) return { skipped: true } as const;
  const settings = await getSyncSettings(env, workspaceId);
  if (!settings || !settings.purchase_account_code || !settings.purchase_tax_type) {
    await releaseDailyGrvSyncClaim(env, workspaceId, claim.dateKey, false);
    return { skipped: true, reason: 'Xero GRV sync settings incomplete.' } as const;
  }
  const result = await syncPendingXeroGrvs(env, workspaceId, {
    purchaseAccountCode: text(settings.purchase_account_code),
    purchaseTaxType: text(settings.purchase_tax_type),
    purchaseExemptTaxType: text(settings.purchase_exempt_tax_type),
    codPaymentAccountCode: text(settings.cod_payment_account_code),
    locationTrackingCategoryId: text(settings.location_tracking_category_id)
  });
  // A failed or needs-supplier-match GRV isn't lost — it stays retryable in its own outbox row and
  // syncPendingXeroGrvs re-scans ALL such rows (not just today's) on every call, including
  // tomorrow's due-check. This claim only gates HOW OFTEN the automatic scan runs (once/day), not
  // which GRVs it looks at, so it's released as "handled" once genuinely attempted either way.
  await releaseDailyGrvSyncClaim(env, workspaceId, claim.dateKey, true);
  return { dateKey: claim.dateKey, result } as const;
}

// Credit Notes are claimed/released independently of the sales invoice and GRV sync above — a
// workspace can run any combination without one blocking the others, same reasoning as
// runDueGrvSync. Runs from the same due-check tick so credit notes go out alongside sales/GRVs.
async function runDueCreditNoteSync(env: Env, workspaceId: string) {
  const claim = await claimDailyCreditNoteSyncIfDue(env, workspaceId);
  if (!claim.due || !claim.dateKey) return { skipped: true } as const;
  const settings = await getSyncSettings(env, workspaceId);
  if (!settings || !settings.purchase_account_code || !settings.purchase_tax_type) {
    await releaseDailyCreditNoteSyncClaim(env, workspaceId, claim.dateKey, false);
    return { skipped: true, reason: 'Xero Credit Note sync settings incomplete.' } as const;
  }
  const result = await syncPendingXeroCreditNotes(env, workspaceId, {
    purchaseAccountCode: text(settings.purchase_account_code),
    purchaseTaxType: text(settings.purchase_tax_type),
    purchaseExemptTaxType: text(settings.purchase_exempt_tax_type),
    locationTrackingCategoryId: text(settings.location_tracking_category_id)
  });
  // Same reasoning as runDueGrvSync: a failed/needs-match credit note stays retryable in its own
  // outbox row and is re-scanned on every call, so this claim only gates run frequency.
  await releaseDailyCreditNoteSyncClaim(env, workspaceId, claim.dateKey, true);
  return { dateKey: claim.dateKey, result } as const;
}

// Wastage is claimed/released independently of the other syncs above, same reasoning as
// runDueGrvSync/runDueCreditNoteSync — but trading-day-bound like the sales invoice claim, since
// aggregateDailyWastageLines sums one specific trading day's stock_movements (unlike GRV/Credit
// Note, which aren't date-bounded scans).
async function runDueWastageSync(env: Env, workspaceId: string) {
  const startHour = await getWorkspaceTradingDayStartHour(env, workspaceId);
  const claim = await claimDailyWastageSyncIfDue(env, workspaceId, startHour);
  if (!claim.due || !claim.dateKey) return { skipped: true } as const;
  const settings = await getSyncSettings(env, workspaceId);
  if (!settings || !settings.wastage_expense_account_code || !settings.wastage_asset_account_code) {
    await releaseDailyWastageSyncClaim(env, workspaceId, claim.dateKey, false);
    return { skipped: true, reason: 'Xero wastage sync settings incomplete.' } as const;
  }
  const result = await syncXeroDailyWastage(env, workspaceId, claim.dateKey, {
    wastageExpenseAccountCode: text(settings.wastage_expense_account_code),
    wastageAssetAccountCode: text(settings.wastage_asset_account_code),
    locationTrackingCategoryId: text(settings.location_tracking_category_id)
  }, startHour);
  const success = result.status === 'applied' || result.status === 'duplicate' || result.status === 'skipped_no_wastage';
  await releaseDailyWastageSyncClaim(env, workspaceId, claim.dateKey, success);
  return { dateKey: claim.dateKey, result } as const;
}

async function postDueCheck(env: Env, workspaceId: string) {
  const [invoice, grv, creditNotes, wastage] = await Promise.all([
    runDueInvoiceSync(env, workspaceId),
    runDueGrvSync(env, workspaceId),
    runDueCreditNoteSync(env, workspaceId),
    runDueWastageSync(env, workspaceId)
  ]);
  return response({ ok: true, invoice, grv, creditNotes, wastage });
}

export async function handleXeroAdminRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  resource: string
): Promise<Response | null> {
  if (resource === 'xero-oauth-callback') {
    if (auth.uid !== 'xero-oauth-callback') return response({ ok: false, error: 'Invalid Xero OAuth callback route.' }, 403);
    return getOauthCallback(request, env);
  }

  if (resource === 'xero/due-check') {
    if (auth.uid !== 'system' && auth.systemRole !== 'queue' && auth.systemRole !== 'admin') {
      return response({ ok: false, error: 'Internal due-check route only.' }, 403);
    }
    return postDueCheck(env, workspaceId);
  }

  if (!resource.startsWith('xero/')) return null;
  if (!auth.uid) return response({ ok: false, error: 'Authentication required.' }, 401);

  // The front Worker already confirmed this user has access to this workspace at all
  // (assertWorkspaceAccess) before forwarding here, so status/sync-now — reads and a one-off
  // push, no config change — are open to any workspace member, matching postYocoSyncCatalogue's
  // bar (`scoped` only) rather than requiring an owner/admin role.
  if (request.method === 'GET' && resource === 'xero/status') {
    return getStatus(env, workspaceId);
  }
  if (request.method === 'POST' && resource.startsWith('xero/sync-now')) {
    const kind = new URL(request.url).searchParams.get('kind') || 'invoice';
    return postSyncNow(env, workspaceId, kind);
  }
  if (request.method === 'GET' && resource === 'xero/pending-supplier-matches') {
    return response({ ok: true, pendingSupplierMatches: await listPendingSupplierMatches(env, workspaceId) });
  }
  if (request.method === 'GET' && resource === 'xero/tax-rates') {
    try {
      return response({ ok: true, taxRates: await fetchXeroTaxRates(env, workspaceId) });
    } catch (cause) {
      const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Could not load Xero tax rates.';
      return response({ ok: false, error: message }, 400);
    }
  }
  if (request.method === 'GET' && resource === 'xero/tracking-categories') {
    try {
      return response({ ok: true, trackingCategories: await fetchXeroTrackingCategories(env, workspaceId) });
    } catch (cause) {
      const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Could not load Xero tracking categories.';
      return response({ ok: false, error: message }, 400);
    }
  }
  if (request.method === 'GET' && resource === 'xero/accounts') {
    try {
      return response({ ok: true, accounts: await fetchXeroAccounts(env, workspaceId) });
    } catch (cause) {
      const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Could not load Xero accounts.';
      return response({ ok: false, error: message }, 400);
    }
  }

  // Connecting/disconnecting Xero and changing the account-code mapping is a workspace-owner-level
  // action — the same bar as connecting Yoco (denyUnlessPermissionManager in legacy/routes.ts):
  // the workspace's own owner/admin, or a KCP superuser. NOT auth.systemRole === 'admin', which is
  // the separate internal KCP admin-portal role and would never be true for an ordinary business
  // owner configuring their own workspace.
  if (!(await canManageXero(env, auth, workspaceId))) {
    return response({ ok: false, error: 'Only workspace owners, admins, and super users can manage the Xero connection.' }, 403);
  }

  if (request.method === 'POST' && resource === 'xero/connect-start') {
    return postConnectStart(request, env, auth, workspaceId);
  }
  if (request.method === 'POST' && resource === 'xero/disconnect') {
    return postDisconnect(env, workspaceId);
  }
  if (request.method === 'POST' && resource === 'xero/settings') {
    return postSettings(request, env, workspaceId);
  }
  if (request.method === 'POST' && resource === 'xero/resolve-supplier-match') {
    return postResolveSupplierMatch(request, env, workspaceId);
  }

  return null;
}
