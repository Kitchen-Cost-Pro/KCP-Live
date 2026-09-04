import type { Env, AuthContext } from "./types";
import { postWorkspaceChat } from "./chat-routes";
import { postWorkspaceAiExtract } from "./ai-extract-routes";
import { requireAuth } from "./auth";
import { corsHeaders, error, json } from "./http";
import { ensureWorkspaceLocationNames } from "./location-display";
import {
  getAuthInvitation,
  getAuthMe,
  getAuthProfile,
  postAdminAuthLogin,
  postAuthChangePassword,
  postAuthClaimInvitation,
  postAuthLogin,
  postAuthLogout,
  postAuthPasswordReset,
  postAuthResetPasswordConfirm,
  postAuthRegister,
} from "./auth-routes";
import {
  deleteAdminInvitation,
  deleteAdminUser,
  postAdminUserPasswordReset,
  deleteAdminWorkspace,
  getAdminWorkspaceSettings,
  patchAdminWorkspaceSettings,
  deleteAdminMember,
  deleteAdminMemberByEmail,
  postAdminAuthRequestReset,
  postAdminMemberSendReset,
  getAdminWorkspaceEmailQueue,
  getAdminSystemSettings,
  getAdminYocoStatus,
  getAdminOverview,
  getAdminRegistrationRequests,
  getAdminInvitations,
  postAdminTestEmail,
  getAdminAuditLogs,
  getSystemBroadcast,
  getAdminWorkspaces,
  patchAdminMember,
  patchAdminUser,
  postAdminSessionBootstrap,
  postAdminApproveRegistration,
  postAdminAuditLog,
  postAdminInvite,
  postAdminMember,
  postAdminUser,
  postAdminRejectRegistration,
  getAdminOrgSites,
  postAdminSaveOrgGroup,
  postAdminUnlinkOrgSite,
  postAdminWorkspaceEmailQueue,
  postAdminYocoConnect,
  postAdminYocoDisconnect,
  postAdminYocoSyncCatalogue,
  requireAdmin,
  putAdminEmailConfig,
  putAdminSystemBroadcast,
  getAdminGmailConnectUrl,
  getAdminGmailCallback,
  getSystemGmailStatus,
  deleteAdminGmail,
} from "./admin-routes";
import {
  getDashboard,
  getDashboardSource,
  getAdjustments,
  getWastageAdjustments,
  getCreditNotes,
  getGoodsReceipts,
  getLinkedTransferProfiles,
  getSelfTransferProfile,
  getAdminWorkspaceSummary,
  getAdminWorkspaceMigrationHealth,
  getAdminWorkspaceOpeningBalanceCheck,
  postAdminWorkspaceMigrationRetry,
  purgeWorkspaceTenant,
  getAdminWorkspaceSettingsDO,
  patchAdminWorkspaceSettingsDO,
  adminYocoActionDO,
  adminYocoStatusDO,
  adminYocoEventsDO,
  adminAuditEventsDO,
  adminActionDO,
  adminOrgFieldsDO,
  adminUnlinkOrgDO,
  postDashboardLowStockEmail,
  getLowStockNotificationSettingsRoute,
  putLowStockNotificationSettingsRoute,
  postLowStockAckRoute,
  postLowStockAckAllRoute,
  postLowStockUnackRoute,
  migrateImport,
  getLocations,
  getManufacturingBatches,
  getProducts,
  getPurchaseOrders,
  getSiteConfiguration,
  getSuppliers,
  getStockItems,
  getStockItemLocationCosts,
  getStockTakeDrafts,
  getStockTakeTemplates,
  getStockTakes,
  getTransfers,
  getTransferTemplates,
  getWorkspaceAccessRoute,
  getWorkspaceSettingsRoute,
  getUserPreferencesRoute,
  getGmailOAuthCallback,
  getGmailStatus,
  getYocoModifierGroupRoute,
  getYocoModifierGroups,
  getYocoModifierRecipes,
  getModifierNoteSuggestionsRoute,
  postModifierNoteRuleRoute,
  postModifierNoteIgnoreRoute,
  postModifierNoteRestoreRoute,
  getModifierEngineControlRoute,
  getModifierEngineDiagnosticsRoute,
  deleteLocationRoute,
  deleteProductRoute,
  deletePurchaseOrderRoute,
  deleteWorkspaceMemberRoute,
  deleteWorkspaceRoleRoute,
  deleteStockTakeDraftRoute,
  deleteStockTakeTemplateRoute,
  deleteStockItemRoute,
  deleteSupplierRoute,
  deleteTransferTemplateRoute,
  deleteYocoModifierRecipeRoute,
  getDataVersion,
  getYocoStatus,
  notFound,
  acceptExternalTransfer,
  rejectExternalTransfer,
  patchLocation,
  patchProduct,
  patchPurchaseOrder,
  patchSupplier,
  patchYocoModifierRecipe,
  patchStockItem,
  patchStockTake,
  patchWorkspaceMemberRoute,
  patchWorkspaceSettingsRoute,
  patchUserPreferencesRoute,
  patchStockLevel,
  postExternalTransfer,
  postGmailConnectStart,
  postGmailDisconnect,
  postGmailSendSupplierEmail,
  postAdjustment,
  postWastageAdjustment,
  postSalesAdjustment,
  postCreditNote,
  patchCreditNote,
  postGoodsReceipt,
  patchGoodsReceipt,
  postImportPreview,
  postInternalTransfer,
  postLocation,
  postManufacturingBatch,
  postProduct,
  postProductBulkDelete,
  postProductImport,
  postPurchaseOrder,
  postPurchaseOrderBulkDelete,
  postSyncDefaultSiteName,
  postSupplier,
  postSupplierBulkDelete,
  postSupplierImport,
  postTransferTemplate,
  postWorkspaceMemberRoute,
  resendWorkspaceMemberInvite,
  postWorkspaceRoleRoute,
  postStockBulkDelete,
  postStockCategoryAction,
  postStockImport,
  postStockLocationCostsImport,
  postStockItemLocationCosts,
  postStockItem,
  postStockResetDashboardHistory,
  postStockTake,
  postStockTakeDraft,
  postStockTakeTemplate,
  postStockUomAction,
  postYocoConnect,
  postYocoDisconnect,
  postYocoSyncCatalogue,
  postRunDueCatalogueSync,
  postSyncCatalogueIfDue,
} from "./routes";
import { sendWorkspaceLowStockNow } from "./low-stock-email";
import {
  getDetailedActivityReport,
  getOperationsExcludedSummary,
  getLedgerIntegrityAudit,
  getInventoryAuditReport,
  getMenuRecipeHealthReport,
  getModifierSalesReport,
  getSaleStockUsageReport,
  getSalesFinancialReport,
  getStockControlReport,
  getStockTakeAuditReport,
  postLedgerIntegrityBackfill,
} from "./reporting-routes";
import {
  getStockOnHandReport,
  getPurchaseOrdersReport,
  getGrvLogReport,
  getCreditNotesReport,
  getManufacturingTransactionsReport,
  getStockTransferTransactionsReport,
} from "./reporting-phase21-routes";
import { getTransactionDetailReport } from "./transaction-detail-routes";
import {
  deleteReportSavedView,
  deleteReportSchedule,
  getReportSavedViews,
  getReportSchedules,
  postReportSavedView,
  postReportSchedule,
  postReportTestEmail,
  postRunDueReportSchedules,
  postRunReportScheduleNow,
  putReportSavedView,
  putReportSchedule,
} from "./report-scheduling-routes";

function routePattern(pathname: string, pattern: RegExp) {
  return pathname.match(pattern);
}

const REPORT_QUERY_TIMEOUT_MS = 20_000;

/**
 * Bounds a report handler's wall-clock time, not just its row count. MAX_REPORT_ROWS
 * (reporting-routes.ts) caps how many rows a query can RETURN, but a wide date range can still
 * make the underlying scan itself expensive well before it reaches that cap — the same shape of
 * resource exhaustion as the 2026-08-26 migration incident, just via a report instead of a schema
 * change. On timeout, the underlying query keeps running to completion in the Durable Object (it
 * cannot be cancelled mid-flight) — this only bounds how long the CALLER waits, so a follow-up
 * request for the same report shortly after a timeout may still be slow while the DO works through
 * its backlog; narrowing the requested date range is the actual fix on the client side.
 */
async function withReportTimeout(resource: string, work: Promise<Response>): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => resolve(new Response(JSON.stringify({
      ok: false,
      error: `The ${resource} report is taking too long — try narrowing the date range or location filter.`
    }), { status: 504, headers: { 'content-type': 'application/json; charset=utf-8' } })), REPORT_QUERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env),
    });
  }
  await env.DB.prepare("PRAGMA foreign_keys = ON")
    .run()
    .catch(() => null);

  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json(request, env, {
      ok: true,
      service: "kcp-cloudflare-api",
      environment: env.ENVIRONMENT || "development",
    });
  }

  const centralResponse = await dispatchCentralRoute(request, env);
  if (centralResponse) return centralResponse;

  const apiMatch = routePattern(
    url.pathname,
    /^\/api\/workspaces\/([^/]+)\/(.+)$/,
  );
  if (!apiMatch) return notFound(request, env);
  const workspaceId = apiMatch[1];
  const resource = apiMatch[2];
  const auth = await requireAuth(request, env);
  return dispatchWorkspaceRoute(request, env, auth, workspaceId, resource);
}

/**
 * All CENTRAL-plane routes (auth, admin, security-config, invitations, system broadcast, etc.).
 * Extracted so the cloudflare-v2 front Worker can serve them against CENTRAL_DB. Returns null when no
 * route matches, so the caller can continue to tenant routing.
 */
export async function dispatchCentralRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    return postAuthLogin(request, env);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/auth/security-config"
  ) {
    const siteKey = String(env.TURNSTILE_SITE_KEY || "").trim();
    const secretConfigured = Boolean(
      String(env.TURNSTILE_SECRET_KEY || "").trim(),
    );
    const siteKeyConfigured = Boolean(siteKey);
    return json(request, env, {
      ok: true,
      turnstile: {
        siteKey,
        enabled: siteKeyConfigured && secretConfigured,
        configured: siteKeyConfigured && secretConfigured,
        siteKeyConfigured,
        secretConfigured,
        mode:
          String(env.APP_TURNSTILE_MODE || "enforce")
            .trim()
            .toLowerCase() || "enforce",
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/auth/login") {
    return postAdminAuthLogin(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/auth/request-reset"
  ) {
    return postAdminAuthRequestReset(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/members/send-reset"
  ) {
    return postAdminMemberSendReset(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    return getAuthMe(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return postAuthLogout(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    return postAuthRegister(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/password-reset"
  ) {
    return postAuthPasswordReset(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/password-reset/confirm"
  ) {
    return postAuthResetPasswordConfirm(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/change-password"
  ) {
    return postAuthChangePassword(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/auth/invitations") {
    return getAuthInvitation(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/system/broadcast") {
    return getSystemBroadcast(request, env);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/admin/security-config"
  ) {
    const siteKey = String(
      env.ADMIN_TURNSTILE_SITE_KEY || env.TURNSTILE_SITE_KEY || "",
    ).trim();
    const secretKey = String(
      env.ADMIN_TURNSTILE_SECRET_KEY || env.TURNSTILE_SECRET_KEY || "",
    ).trim();
    const siteKeyConfigured = Boolean(siteKey);
    const secretConfigured = Boolean(secretKey);
    return json(request, env, {
      ok: true,
      turnstile: {
        siteKey,
        enabled: siteKeyConfigured && secretConfigured,
        configured: siteKeyConfigured && secretConfigured,
        siteKeyConfigured,
        secretConfigured,
        mode:
          String(env.ADMIN_TURNSTILE_MODE || "enforce")
            .trim()
            .toLowerCase() || "enforce",
      },
    });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/auth/invitations/claim"
  ) {
    return postAuthClaimInvitation(request, env);
  }

  const profileMatch = routePattern(
    url.pathname,
    /^\/api\/auth\/profiles\/([^/]+)$/,
  );
  if (profileMatch && request.method === "GET") {
    return getAuthProfile(request, env, profileMatch[1]);
  }

  if (request.method === "GET" && url.pathname === "/api/admin") {
    return getAdminOverview(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/session/bootstrap"
  ) {
    return postAdminSessionBootstrap(request, env);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/admin/system-settings"
  ) {
    return getAdminSystemSettings(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/admin/audit-logs") {
    return getAdminAuditLogs(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/audit-logs") {
    return postAdminAuditLog(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/test-email") {
    return postAdminTestEmail(request, env);
  }

  if (
    (request.method === "PUT" || request.method === "PATCH") &&
    url.pathname === "/api/admin/system-settings/email"
  ) {
    return putAdminEmailConfig(request, env);
  }

  if (
    (request.method === "PUT" || request.method === "PATCH") &&
    url.pathname === "/api/admin/system-settings/broadcast"
  ) {
    return putAdminSystemBroadcast(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/users") {
    return postAdminUser(request, env);
  }

  const adminUserMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/users\/([^/]+)$/,
  );
  if (
    adminUserMatch &&
    (request.method === "PATCH" || request.method === "PUT")
  ) {
    return patchAdminUser(request, env, adminUserMatch[1]);
  }

  if (adminUserMatch && request.method === "DELETE") {
    return deleteAdminUser(request, env, adminUserMatch[1]);
  }

  const adminUserPasswordResetMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/users\/([^/]+)\/password-reset$/,
  );
  if (adminUserPasswordResetMatch && request.method === "POST") {
    return postAdminUserPasswordReset(
      request,
      env,
      adminUserPasswordResetMatch[1],
    );
  }

  if (request.method === "GET" && url.pathname === "/api/admin/workspaces") {
    return getAdminWorkspaces(request, env);
  }

  const adminWorkspaceMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/workspaces\/([^/]+)$/,
  );
  if (adminWorkspaceMatch && request.method === "DELETE") {
    return deleteAdminWorkspace(request, env, adminWorkspaceMatch[1]);
  }

  const adminWorkspaceSettingsMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/workspaces\/([^/]+)\/settings$/,
  );
  if (adminWorkspaceSettingsMatch && request.method === "GET") {
    return getAdminWorkspaceSettings(
      request,
      env,
      adminWorkspaceSettingsMatch[1],
    );
  }
  if (adminWorkspaceSettingsMatch && request.method === "PATCH") {
    return patchAdminWorkspaceSettings(
      request,
      env,
      adminWorkspaceSettingsMatch[1],
    );
  }

  if (request.method === "POST" && url.pathname === "/api/admin/members") {
    return postAdminMember(request, env);
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/members") {
    return deleteAdminMemberByEmail(request, env);
  }

  const adminMemberMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/members\/([^/]+)$/,
  );
  if (
    adminMemberMatch &&
    (request.method === "PATCH" || request.method === "PUT")
  ) {
    return patchAdminMember(request, env, adminMemberMatch[1]);
  }

  if (adminMemberMatch && request.method === "DELETE") {
    return deleteAdminMember(request, env, adminMemberMatch[1]);
  }

  if (request.method === "GET" && url.pathname === "/api/admin/invitations") {
    return getAdminInvitations(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/invitations") {
    return postAdminInvite(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/admin/org-sites") {
    return getAdminOrgSites(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/org-groups") {
    return postAdminSaveOrgGroup(request, env);
  }

  const adminOrgSiteMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/org-sites\/([^/]+)\/unlink$/,
  );
  if (adminOrgSiteMatch && request.method === "POST") {
    return postAdminUnlinkOrgSite(request, env, adminOrgSiteMatch[1]);
  }

  const adminInvitationMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/invitations\/([^/]+)$/,
  );
  if (adminInvitationMatch && request.method === "DELETE") {
    return deleteAdminInvitation(request, env, adminInvitationMatch[1]);
  }

  const adminWorkspaceEmailQueueMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/workspaces\/([^/]+)\/email-queue$/,
  );
  if (adminWorkspaceEmailQueueMatch && request.method === "GET") {
    return getAdminWorkspaceEmailQueue(
      request,
      env,
      adminWorkspaceEmailQueueMatch[1],
    );
  }

  if (adminWorkspaceEmailQueueMatch && request.method === "POST") {
    return postAdminWorkspaceEmailQueue(
      request,
      env,
      adminWorkspaceEmailQueueMatch[1],
    );
  }

  const adminWorkspaceYocoMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/workspaces\/([^/]+)\/yoco\/([^/]+)$/,
  );
  if (
    adminWorkspaceYocoMatch &&
    request.method === "GET" &&
    adminWorkspaceYocoMatch[2] === "status"
  ) {
    return getAdminYocoStatus(request, env, adminWorkspaceYocoMatch[1]);
  }

  if (adminWorkspaceYocoMatch && request.method === "POST") {
    const workspaceId = adminWorkspaceYocoMatch[1];
    const action = adminWorkspaceYocoMatch[2];
    if (action === "connect")
      return postAdminYocoConnect(request, env, workspaceId);
    if (action === "disconnect")
      return postAdminYocoDisconnect(request, env, workspaceId);
    if (action === "sync-catalogue")
      return postAdminYocoSyncCatalogue(request, env, workspaceId);
  }

  const adminWorkspaceActionMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/workspaces\/([^/]+)\/actions\/([^/]+)$/,
  );
  if (adminWorkspaceActionMatch && request.method === "POST") {
    const workspaceId = adminWorkspaceActionMatch[1];
    const action = adminWorkspaceActionMatch[2];
    if (action === "send-low-stock-email") {
      await requireAdmin(request, env);
      const result = await sendWorkspaceLowStockNow(env, workspaceId);
      return json(request, env, { ok: true, ...result });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/admin/gmail/connect") {
    return getAdminGmailConnectUrl(request, env);
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/admin/gmail/callback"
  ) {
    return getAdminGmailCallback(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/gmail/status") {
    await requireAdmin(request, env);
    const status = await getSystemGmailStatus(env);
    return json(request, env, { ok: true, ...status });
  }
  if (request.method === "DELETE" && url.pathname === "/api/admin/gmail") {
    return deleteAdminGmail(request, env);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/admin/registration-requests"
  ) {
    return getAdminRegistrationRequests(request, env);
  }

  const adminRequestMatch = routePattern(
    url.pathname,
    /^\/api\/admin\/registration-requests\/([^/]+)\/(approve|reject)$/,
  );
  if (adminRequestMatch && request.method === "POST") {
    return adminRequestMatch[2] === "approve"
      ? postAdminApproveRegistration(request, env, adminRequestMatch[1])
      : postAdminRejectRegistration(request, env, adminRequestMatch[1]);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/gmail/oauth/callback"
  ) {
    return getGmailOAuthCallback(request, env);
  }

  return null;
}

/**
 * Tenant + workspace route dispatch, extracted so a WorkspaceDO can reuse it VERBATIM with
 * env.DB = the tenant SQLite facade (and env.CENTRAL_DB = the central D1). Central-plane resources
 * that appear here (access-management, members, roles, external transfers, linked-transfer-profiles)
 * are routed by the front Worker to the central plane, NOT forwarded to the DO. See PORTING.md.
 */
export async function dispatchWorkspaceRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  resource: string,
): Promise<Response> {
  await ensureWorkspaceLocationNames(env, workspaceId);

  if (request.method === "GET" && resource === "report-saved-views")
    return getReportSavedViews(request, env, auth, workspaceId);
  if (request.method === "POST" && resource === "report-saved-views")
    return postReportSavedView(request, env, auth, workspaceId);
  const savedViewMatch = routePattern(
    resource,
    /^report-saved-views\/([^/]+)$/,
  );
  if (savedViewMatch && request.method === "PUT")
    return putReportSavedView(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(savedViewMatch[1]),
    );
  if (savedViewMatch && request.method === "DELETE")
    return deleteReportSavedView(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(savedViewMatch[1]),
    );

  if (request.method === "GET" && resource === "report-schedules")
    return getReportSchedules(request, env, auth, workspaceId);
  if (request.method === "POST" && resource === "report-schedules")
    return postReportSchedule(request, env, auth, workspaceId);
  const scheduleRunMatch = routePattern(
    resource,
    /^report-schedules\/([^/]+)\/run-now$/,
  );
  if (scheduleRunMatch && request.method === "POST")
    return postRunReportScheduleNow(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(scheduleRunMatch[1]),
    );
  const scheduleMatch = routePattern(resource, /^report-schedules\/([^/]+)$/);
  if (scheduleMatch && request.method === "PUT")
    return putReportSchedule(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(scheduleMatch[1]),
    );
  if (scheduleMatch && request.method === "DELETE")
    return deleteReportSchedule(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(scheduleMatch[1]),
    );
  if (request.method === "POST" && resource === "reports/send-test-email")
    return postReportTestEmail(request, env, auth, workspaceId);
  if (
    request.method === "POST" &&
    resource === "admin-action/report-schedules-due"
  )
    return postRunDueReportSchedules(request, env, auth, workspaceId);

  if (
    request.method === "POST" &&
    resource === "admin-action/catalogue-sync-due"
  )
    return postRunDueCatalogueSync(request, env, auth, workspaceId);
  const transactionDetailMatch = routePattern(
    resource,
    /^reports\/transactions\/([^/]+)$/,
  );
  if (transactionDetailMatch && request.method === "GET") {
    return getTransactionDetailReport(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(transactionDetailMatch[1]),
    );
  }

  if (request.method === "GET" && resource === "reports/detailed-activity") {
    return withReportTimeout(resource, getDetailedActivityReport(request, env, auth, workspaceId));
  }

  if (request.method === "GET" && resource === "reports/operations-excluded") {
    return getOperationsExcludedSummary(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "reports/stock-take-audit") {
    return withReportTimeout(resource, getStockTakeAuditReport(request, env, auth, workspaceId));
  }

  if (request.method === "GET" && resource === "reports/sales-financial") {
    return withReportTimeout(resource, getSalesFinancialReport(request, env, auth, workspaceId));
  }

  if (request.method === "GET" && resource === "reports/sale-stock-usage") {
    return withReportTimeout(resource, getSaleStockUsageReport(request, env, auth, workspaceId, "all"));
  }

  if (request.method === "GET" && resource === "reports/modifier-usage") {
    return withReportTimeout(resource, getSaleStockUsageReport(request, env, auth, workspaceId, "modifier"));
  }

  if (request.method === "GET" && resource === "reports/modifier-sales") {
    return withReportTimeout(resource, getModifierSalesReport(request, env, auth, workspaceId));
  }

  if (request.method === "GET" && resource === "reports/menu-recipe-health") {
    return getMenuRecipeHealthReport(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "reports/stock-control") {
    return withReportTimeout(resource, getStockControlReport(request, env, auth, workspaceId));
  }

  if (request.method === "GET" && resource === "reports/stock-on-hand") {
    return getStockOnHandReport(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "reports/purchase-orders") {
    return withReportTimeout(resource, getPurchaseOrdersReport(request, env, auth, workspaceId));
  }

  if (request.method === "GET" && resource === "reports/grv-log") {
    return withReportTimeout(resource, getGrvLogReport(request, env, auth, workspaceId));
  }

  if (request.method === "GET" && resource === "reports/credit-notes") {
    return withReportTimeout(resource, getCreditNotesReport(request, env, auth, workspaceId));
  }

  if (
    request.method === "GET" &&
    resource === "reports/manufacturing-transactions"
  ) {
    return withReportTimeout(resource, getManufacturingTransactionsReport(request, env, auth, workspaceId));
  }

  if (
    request.method === "GET" &&
    resource === "reports/stock-transfer-transactions"
  ) {
    return withReportTimeout(resource, getStockTransferTransactionsReport(request, env, auth, workspaceId));
  }

  if (request.method === "GET" && resource === "reports/inventory-audit") {
    return withReportTimeout(resource, getInventoryAuditReport(request, env, auth, workspaceId));
  }

  if (
    request.method === "GET" &&
    resource === "reports/ledger-integrity/audit"
  ) {
    return getLedgerIntegrityAudit(request, env, auth, workspaceId);
  }

  if (
    request.method === "POST" &&
    resource === "reports/ledger-integrity/backfill"
  ) {
    return postLedgerIntegrityBackfill(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "locations") {
    return getLocations(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "locations") {
    return postLocation(request, env, auth, workspaceId);
  }

  if (
    request.method === "POST" &&
    resource === "locations/sync-default-site-name"
  ) {
    return postSyncDefaultSiteName(request, env, auth, workspaceId);
  }

  const locationMatch = resource.match(/^locations\/([^/]+)$/);
  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    locationMatch
  ) {
    return patchLocation(request, env, auth, workspaceId, locationMatch[1]);
  }

  if (request.method === "DELETE" && locationMatch) {
    return deleteLocationRoute(
      request,
      env,
      auth,
      workspaceId,
      locationMatch[1],
    );
  }

  if (request.method === "GET" && resource === "site-configuration") {
    return getSiteConfiguration(request, env, auth, workspaceId);
  }

  if (
    request.method === "GET" &&
    resource === "notifications/low-stock-settings"
  ) {
    return getLowStockNotificationSettingsRoute(
      request,
      env,
      auth,
      workspaceId,
    );
  }

  if (
    (request.method === "PUT" || request.method === "PATCH") &&
    resource === "notifications/low-stock-settings"
  ) {
    return putLowStockNotificationSettingsRoute(
      request,
      env,
      auth,
      workspaceId,
    );
  }

  if (
    request.method === "POST" &&
    resource === "notifications/low-stock-email"
  ) {
    return postDashboardLowStockEmail(request, env, auth, workspaceId);
  }

  if (
    request.method === "POST" &&
    resource === "notifications/low-stock-ack"
  ) {
    return postLowStockAckRoute(request, env, auth, workspaceId);
  }

  if (
    request.method === "POST" &&
    resource === "notifications/low-stock-ack-all"
  ) {
    return postLowStockAckAllRoute(request, env, auth, workspaceId);
  }

  if (
    request.method === "POST" &&
    resource === "notifications/low-stock-unack"
  ) {
    return postLowStockUnackRoute(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "settings") {
    return getWorkspaceSettingsRoute(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "user-preferences") {
    return getUserPreferencesRoute(request, env, auth, workspaceId);
  }

  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    resource === "user-preferences"
  ) {
    return patchUserPreferencesRoute(request, env, auth, workspaceId);
  }

  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    resource === "settings"
  ) {
    return patchWorkspaceSettingsRoute(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "access-management") {
    return getWorkspaceAccessRoute(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "members") {
    return postWorkspaceMemberRoute(request, env, auth, workspaceId);
  }

  const memberMatch = resource.match(/^members\/([^/]+)$/);
  if ((request.method === "PATCH" || request.method === "PUT") && memberMatch) {
    return patchWorkspaceMemberRoute(
      request,
      env,
      auth,
      workspaceId,
      memberMatch[1],
    );
  }

  if (request.method === "DELETE" && memberMatch) {
    return deleteWorkspaceMemberRoute(
      request,
      env,
      auth,
      workspaceId,
      memberMatch[1],
    );
  }

  const memberResendMatch = resource.match(/^members\/([^/]+)\/resend-invite$/);
  if (request.method === "POST" && memberResendMatch) {
    return resendWorkspaceMemberInvite(
      request,
      env,
      auth,
      workspaceId,
      memberResendMatch[1],
    );
  }

  if (request.method === "POST" && resource === "roles") {
    return postWorkspaceRoleRoute(request, env, auth, workspaceId);
  }

  const roleMatch = resource.match(/^roles\/([^/]+)$/);
  if (request.method === "DELETE" && roleMatch) {
    return deleteWorkspaceRoleRoute(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(roleMatch[1]),
    );
  }

  if (request.method === "GET" && resource === "linked-transfer-profiles") {
    return getLinkedTransferProfiles(request, env, auth, workspaceId);
  }

  // A workspace's OWN transfer profile — fanned out by the front Worker to assemble linked profiles.
  if (request.method === "GET" && resource === "transfer-profile") {
    return getSelfTransferProfile(request, env, auth, workspaceId);
  }

  // This workspace's admin-overview summary (settings + counts + Yoco) — fanned out by the front Worker.
  if (request.method === "GET" && resource === "admin-summary") {
    return getAdminWorkspaceSummary(request, env, auth, workspaceId);
  }

  // Purge this workspace's tenant tables — called by the front Worker during admin deletion.
  if (request.method === "POST" && resource === "admin-purge") {
    return purgeWorkspaceTenant(request, env, auth, workspaceId);
  }

  // This workspace's tenant schema migration status/backoff state — fanned out by the front Worker.
  if (request.method === "GET" && resource === "admin-migration-health") {
    return getAdminWorkspaceMigrationHealth(request, env, auth, workspaceId);
  }
  // callWorkspaceDO passes the query string as part of the resource (same as the yoco-v2 admin
  // routes do), so match on the path portion rather than exact equality.
  if (request.method === "GET" && resource.split("?")[0] === "admin-opening-balance-check") {
    return getAdminWorkspaceOpeningBalanceCheck(request, env, auth, workspaceId);
  }
  if (request.method === "POST" && resource === "admin-migration-retry") {
    return postAdminWorkspaceMigrationRetry(request, env, auth, workspaceId);
  }

  // Admin read/patch of this workspace's settings (billing lock etc.) — fanned in by the front Worker.
  if (request.method === "GET" && resource === "admin-settings") {
    return getAdminWorkspaceSettingsDO(request, env, auth, workspaceId);
  }
  if (
    (request.method === "PATCH" || request.method === "POST") &&
    resource === "admin-settings"
  ) {
    return patchAdminWorkspaceSettingsDO(request, env, auth, workspaceId);
  }

  // Admin workspace actions fanned in by the front Worker (already requireAdmin-gated there).
  // These run against tenant env.DB — they must NOT re-auth. See routes.ts adminYoco*/admin*DO.
  if (request.method === "GET" && resource === "admin-yoco/status") {
    return adminYocoStatusDO(request, env, auth, workspaceId);
  }
  if (request.method === "GET" && resource === "admin-yoco/events") {
    return adminYocoEventsDO(request, env, auth, workspaceId);
  }
  if (request.method === "GET" && resource === "admin-audit-events") {
    return adminAuditEventsDO(request, env, auth, workspaceId);
  }
  const adminYocoM = resource.match(/^admin-yoco\/([^/]+)$/);
  if (request.method === "POST" && adminYocoM) {
    return adminYocoActionDO(request, env, auth, workspaceId, adminYocoM[1]);
  }
  const adminActionM = resource.match(/^admin-action\/([^/]+)$/);
  if (request.method === "POST" && adminActionM) {
    return adminActionDO(request, env, auth, workspaceId, adminActionM[1]);
  }
  if (request.method === "GET" && resource === "admin-org-fields") {
    return adminOrgFieldsDO(request, env, auth, workspaceId);
  }
  if (request.method === "POST" && resource === "admin-unlink-org") {
    return adminUnlinkOrgDO(request, env, auth, workspaceId);
  }

  // Data-migration bulk import into THIS DO (superuser-gated by the front Worker before forwarding).
  if (request.method === "POST" && resource === "migrate-import") {
    return migrateImport(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "stock-items") {
    return getStockItems(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "products") {
    return getProducts(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "products") {
    return postProduct(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "products/import") {
    return postProductImport(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "products/bulk-delete") {
    return postProductBulkDelete(request, env, auth, workspaceId);
  }

  const productMatch = resource.match(/^products\/([^/]+)$/);
  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    productMatch
  ) {
    return patchProduct(request, env, auth, workspaceId, productMatch[1]);
  }

  if (request.method === "DELETE" && productMatch) {
    return deleteProductRoute(request, env, auth, workspaceId, productMatch[1]);
  }

  if (request.method === "GET" && resource === "suppliers") {
    return getSuppliers(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "suppliers") {
    return postSupplier(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "suppliers/import") {
    return postSupplierImport(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "suppliers/bulk-delete") {
    return postSupplierBulkDelete(request, env, auth, workspaceId);
  }

  const supplierMatch = resource.match(/^suppliers\/([^/]+)$/);
  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    supplierMatch
  ) {
    return patchSupplier(request, env, auth, workspaceId, supplierMatch[1]);
  }

  if (request.method === "DELETE" && supplierMatch) {
    return deleteSupplierRoute(
      request,
      env,
      auth,
      workspaceId,
      supplierMatch[1],
    );
  }

  if (request.method === "POST" && resource === "stock-items") {
    return postStockItem(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "stock-items/import") {
    return postStockImport(request, env, auth, workspaceId);
  }

  if (
    request.method === "POST" &&
    resource === "stock-items/location-costs/import"
  ) {
    return postStockLocationCostsImport(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "stock-items/bulk-delete") {
    return postStockBulkDelete(request, env, auth, workspaceId);
  }

  if (
    request.method === "POST" &&
    (resource === "stock-items/reset-dashboard" ||
      resource === "stock-items/reset-reporting")
  ) {
    return postStockResetDashboardHistory(request, env, auth, workspaceId);
  }

  const stockLevelMatch = resource.match(/^stock-items\/([^/]+)\/stock-level$/);
  if (request.method === "PATCH" && stockLevelMatch) {
    return patchStockLevel(request, env, auth, workspaceId, decodeURIComponent(stockLevelMatch[1]));
  }

  const stockItemLocationCostsMatch = resource.match(
    /^stock-items\/([^/]+)\/location-costs$/,
  );
  if (request.method === "GET" && stockItemLocationCostsMatch) {
    return getStockItemLocationCosts(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(stockItemLocationCostsMatch[1]),
    );
  }
  if (request.method === "POST" && stockItemLocationCostsMatch) {
    return postStockItemLocationCosts(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(stockItemLocationCostsMatch[1]),
    );
  }

  // Stock item ids are sometimes legacy, name-derived strings (e.g. "Fitch_&_Leeds_-_Pink_Tonic")
  // rather than opaque "stock-XXXX" ids, so a URL-special character forces the frontend to
  // percent-encode the segment (e.g. "Fitch_%26_Leeds_-_Pink_Tonic"). Every match above/below must
  // decode it back before using it as a lookup key — otherwise `WHERE id = ?` compares the raw,
  // still-encoded string against the plain-text id stored in the DB and never matches, producing a
  // 404 for exactly the items whose id happens to need encoding while plain alphanumeric ids work
  // fine. Matches the decodeURIComponent(...) pattern already used by savedViewMatch/scheduleMatch/
  // transactionDetailMatch/roleMatch elsewhere in this file.
  const stockItemMatch = resource.match(/^stock-items\/([^/]+)$/);
  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    stockItemMatch
  ) {
    return patchStockItem(request, env, auth, workspaceId, decodeURIComponent(stockItemMatch[1]));
  }

  if (request.method === "DELETE" && stockItemMatch) {
    return deleteStockItemRoute(
      request,
      env,
      auth,
      workspaceId,
      decodeURIComponent(stockItemMatch[1]),
    );
  }

  const stockCategoryMatch = resource.match(
    /^stock-categories\/(create|rename|delete)$/,
  );
  if (request.method === "POST" && stockCategoryMatch) {
    return postStockCategoryAction(
      request,
      env,
      auth,
      workspaceId,
      stockCategoryMatch[1],
    );
  }

  const stockUomMatch = resource.match(/^stock-uoms\/(create|rename|delete)$/);
  if (request.method === "POST" && stockUomMatch) {
    return postStockUomAction(
      request,
      env,
      auth,
      workspaceId,
      stockUomMatch[1],
    );
  }

  if (request.method === "GET" && resource === "dashboard") {
    return getDashboard(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "dashboard-source") {
    return getDashboardSource(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "adjustments") {
    return getAdjustments(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "adjustments") {
    return postAdjustment(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "wastage-adjustments") {
    return getWastageAdjustments(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "wastage-adjustments") {
    return postWastageAdjustment(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "sale-adjustments") {
    return postSalesAdjustment(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "credit-notes") {
    return getCreditNotes(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "credit-notes") {
    return postCreditNote(request, env, auth, workspaceId);
  }

  const creditNoteMatch = resource.match(/^credit-notes\/([^/]+)$/);
  if ((request.method === "PATCH" || request.method === "PUT") && creditNoteMatch) {
    return patchCreditNote(request, env, auth, workspaceId, creditNoteMatch[1]);
  }

  if (request.method === "GET" && resource === "stock-takes") {
    return getStockTakes(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "stock-takes") {
    return postStockTake(request, env, auth, workspaceId);
  }

  const stockTakeMatch = resource.match(/^stock-takes\/([^/]+)$/);
  if (
    stockTakeMatch &&
    (request.method === "PATCH" || request.method === "PUT")
  ) {
    return patchStockTake(request, env, auth, workspaceId, stockTakeMatch[1]);
  }

  if (request.method === "GET" && resource === "stock-take-templates") {
    return getStockTakeTemplates(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "stock-take-templates") {
    return postStockTakeTemplate(request, env, auth, workspaceId);
  }

  const stockTakeTemplateMatch = resource.match(
    /^stock-take-templates\/([^/]+)$/,
  );
  if (request.method === "DELETE" && stockTakeTemplateMatch) {
    return deleteStockTakeTemplateRoute(
      request,
      env,
      auth,
      workspaceId,
      stockTakeTemplateMatch[1],
    );
  }

  if (request.method === "GET" && resource === "stock-take-drafts") {
    return getStockTakeDrafts(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "stock-take-drafts") {
    return postStockTakeDraft(request, env, auth, workspaceId);
  }

  const stockTakeDraftMatch = resource.match(
    /^stock-take-drafts\/([^/]+)(?:\/([^/]+))?$/,
  );
  if (request.method === "DELETE" && stockTakeDraftMatch) {
    return deleteStockTakeDraftRoute(
      request,
      env,
      auth,
      workspaceId,
      stockTakeDraftMatch[1],
      stockTakeDraftMatch[2] || "",
    );
  }

  if (request.method === "GET" && resource === "manufacturing-batches") {
    return getManufacturingBatches(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "manufacturing-batches") {
    return postManufacturingBatch(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "import-preview") {
    return postImportPreview(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "purchase-orders") {
    return getPurchaseOrders(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "purchase-orders") {
    return postPurchaseOrder(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "purchase-orders/bulk-delete") {
    return postPurchaseOrderBulkDelete(request, env, auth, workspaceId);
  }

  const purchaseOrderMatch = resource.match(/^purchase-orders\/([^/]+)$/);
  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    purchaseOrderMatch
  ) {
    return patchPurchaseOrder(
      request,
      env,
      auth,
      workspaceId,
      purchaseOrderMatch[1],
    );
  }

  if (request.method === "DELETE" && purchaseOrderMatch) {
    return deletePurchaseOrderRoute(
      request,
      env,
      auth,
      workspaceId,
      purchaseOrderMatch[1],
    );
  }

  if (request.method === "GET" && resource === "grvs") {
    return getGoodsReceipts(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "grvs") {
    return postGoodsReceipt(request, env, auth, workspaceId);
  }

  const grvMatch = resource.match(/^grvs\/([^/]+)$/);
  if ((request.method === "PATCH" || request.method === "PUT") && grvMatch) {
    return patchGoodsReceipt(request, env, auth, workspaceId, grvMatch[1]);
  }

  if (request.method === "POST" && resource === "transfers/internal") {
    return postInternalTransfer(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "transfers") {
    return getTransfers(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "transfer-templates") {
    return getTransferTemplates(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "transfer-templates") {
    return postTransferTemplate(request, env, auth, workspaceId);
  }

  const transferTemplateMatch = resource.match(/^transfer-templates\/([^/]+)$/);
  if (request.method === "DELETE" && transferTemplateMatch) {
    return deleteTransferTemplateRoute(
      request,
      env,
      auth,
      workspaceId,
      transferTemplateMatch[1],
    );
  }

  if (request.method === "POST" && resource === "transfers/external") {
    return postExternalTransfer(request, env, auth, workspaceId);
  }

  const transferAcceptMatch = resource.match(/^transfers\/([^/]+)\/accept$/);
  if (request.method === "POST" && transferAcceptMatch) {
    return acceptExternalTransfer(
      request,
      env,
      auth,
      workspaceId,
      transferAcceptMatch[1],
    );
  }

  const transferRejectMatch = resource.match(
    /^transfers\/([^/]+)\/(reject|cancel)$/,
  );
  if (request.method === "POST" && transferRejectMatch) {
    return rejectExternalTransfer(
      request,
      env,
      auth,
      workspaceId,
      transferRejectMatch[1],
      transferRejectMatch[2],
    );
  }

  if (request.method === "GET" && resource === "data-version") {
    return getDataVersion(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "yoco/status") {
    return getYocoStatus(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "yoco/modifier-groups") {
    return getYocoModifierGroups(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "yoco/modifier-recipes") {
    return getYocoModifierRecipes(request, env, auth, workspaceId);
  }

  if (
    request.method === "GET" &&
    resource === "yoco/modifier-note-suggestions"
  ) {
    return getModifierNoteSuggestionsRoute(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "yoco/modifier-note-rules") {
    return postModifierNoteRuleRoute(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "yoco/modifier-note-ignore") {
    return postModifierNoteIgnoreRoute(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "yoco/modifier-note-restore") {
    return postModifierNoteRestoreRoute(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "yoco/modifier-engine/control") {
    return getModifierEngineControlRoute(request, env, auth, workspaceId);
  }

  if (
    request.method === "GET" &&
    resource === "yoco/modifier-engine/diagnostics"
  ) {
    return getModifierEngineDiagnosticsRoute(request, env, auth, workspaceId);
  }

  const yocoModifierRecipeMatch = resource.match(
    /^yoco\/modifier-recipes\/([^/]+)$/,
  );
  if (request.method === "DELETE" && yocoModifierRecipeMatch) {
    return deleteYocoModifierRecipeRoute(
      request,
      env,
      auth,
      workspaceId,
      yocoModifierRecipeMatch[1],
    );
  }
  if (request.method === "PATCH" && yocoModifierRecipeMatch) {
    return patchYocoModifierRecipe(
      request,
      env,
      auth,
      workspaceId,
      yocoModifierRecipeMatch[1],
    );
  }

  const yocoModifierGroupMatch = resource.match(
    /^yoco\/modifier-groups\/([^/]+)$/,
  );
  if (request.method === "GET" && yocoModifierGroupMatch) {
    return getYocoModifierGroupRoute(
      request,
      env,
      auth,
      workspaceId,
      yocoModifierGroupMatch[1],
    );
  }

  if (request.method === "POST" && resource === "yoco/connect") {
    return postYocoConnect(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "yoco/disconnect") {
    return postYocoDisconnect(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "yoco/sync-catalogue") {
    return postYocoSyncCatalogue(request, env, auth, workspaceId);
  }

  // Called once per login/app-load (see requestCatalogueSyncIfDue in the frontend). Unlike the
  // manual button above, this only actually syncs when the catalogue is stale — see
  // postSyncCatalogueIfDue's due-check.
  if (request.method === "POST" && resource === "yoco/sync-catalogue-if-due") {
    return postSyncCatalogueIfDue(request, env, auth, workspaceId);
  }

  if (request.method === "GET" && resource === "gmail-oauth-callback") {
    if (auth.uid !== "gmail-oauth-callback") {
      return error(request, env, 403, "Invalid Gmail OAuth callback route.");
    }
    return getGmailOAuthCallback(request, env);
  }

  if (request.method === "GET" && resource === "gmail/status") {
    return getGmailStatus(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "gmail/connect-start") {
    return postGmailConnectStart(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "gmail/disconnect") {
    return postGmailDisconnect(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "gmail/send-supplier-email") {
    return postGmailSendSupplierEmail(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "chat") {
    return postWorkspaceChat(request, env, auth, workspaceId);
  }

  if (request.method === "POST" && resource === "ai-extract") {
    return postWorkspaceAiExtract(request, env, auth, workspaceId);
  }

  return notFound(request, env);
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handle(request, env);
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : "Internal error.";
      // Surface the real failure in logs (wrangler tail / dashboard). Without this the
      // generic user-facing message below hides the actual cause of every 500.
      console.error(
        "request failed",
        request.method,
        new URL(request.url).pathname,
        raw,
        cause instanceof Error ? cause.stack : undefined,
      );
      // Deliberate validation errors thrown by route handlers (e.g. "X cannot be assigned as a
      // recipe ingredient.", "A stock item named X already exists.") are safe and useful to show
      // verbatim. The keyword list below was previously too narrow — clear, specific validation
      // messages that didn't happen to contain one of these exact words were silently replaced
      // with a useless generic message, hiding the real (and actionable) reason from the user.
      // The denylist guards against ever surfacing a raw runtime/DB exception that happens to
      // contain one of these words incidentally.
      const looksLikeInternalException =
        /sqlite|d1_error|TypeError:|ReferenceError:|SyntaxError:|RangeError:|at Object\.|at async|stack trace|\bundefined is not\b/i.test(
          raw,
        );
      const isUserFacing =
        !looksLikeInternalException &&
        /token|session|expired|access|permission|denied|invalid|required|not found|sign in|password|email|already exists|duplicate|unique|cannot be|must be|not allowed|not permitted|is not configured|could not|non-stock item|no longer/i.test(
          raw,
        );
      const message = isUserFacing
        ? raw
        : "Something went wrong. Please try again.";
      const status = /permission|denied|access to this workspace/i.test(raw)
        ? 403
        : /token|session|expired|sign in/i.test(raw)
          ? 401
          : 500;
      return error(request, env, status, message);
    }
  },
  async scheduled(_controller: unknown, _env: Env, _ctx: unknown) {
    // No-op: the deployed entry point is src/index.ts (see wrangler.toml `main`), whose scheduled()
    // handler runs the low-stock cron by fanning out to each workspace DO. This legacy default
    // export is not the active Worker entry.
  },
};
