import type { AuthContext, Env } from './types';
import { assertWorkspaceAccess, assertLocationAccess, getUserAllowedLocationIds } from './auth';
import { error, json, readJson } from './http';
import { getEmailDeliveryConfig } from './admin-routes';
import { sendEmail } from './email';
import {
  getDetailedActivityReport,
  getInventoryAuditReport,
  getMenuRecipeHealthReport,
  getModifierSalesReport,
  getSaleStockUsageReport,
  getSalesFinancialReport,
  getStockControlReport,
  getStockTakeAuditReport
} from './reporting-routes';
import {
  getStockOnHandReport,
  getPurchaseOrdersReport,
  getGrvLogReport,
  getCreditNotesReport,
  getManufacturingTransactionsReport,
  getStockTransferTransactionsReport
} from './reporting-phase21-routes';
// Reuse the exact CSV mapper used by the manual reporting exports. This module is browser-safe
// for reportToCsv; the DOM-only download helper is never invoked by the Worker.
// @ts-ignore JavaScript module shared with the Vite reporting client.
import { reportToCsv } from '../../../src/modules/reporting/exports/exportCsv.js';
// @ts-ignore Shared XLSX export mapper used by manual and scheduled reporting.
import { reportResultsToExcelBytes, reportToExcelBytes } from '../../../src/modules/reporting/exports/exportExcel.js';
// @ts-ignore Shared PDF export mapper used by manual and scheduled reporting.
import { reportResultsToPdfBytes, reportToPdfBytes } from '../../../src/modules/reporting/exports/exportPdf.js';
// @ts-ignore Shared timezone formatter for business-facing report timestamps.
import { formatReportDateTime, normalizeTradingDayStartMinutes } from '../../../src/modules/reporting/engine/timezone.js';
// @ts-ignore Shared reporting engine used by both interactive and scheduled reports.
import { runReport } from '../../../src/modules/reporting/engine/reportRunner.js';
// @ts-ignore Shared adaptive source pagination used by interactive and scheduled reports.
import { collectCompleteReportPages } from '../../../src/modules/reporting/api/reportPageLoader.js';
// @ts-ignore Shared schedule timing used by Worker execution and Node tests.
import { calculateReportNextRunAt, resolveScheduledRelativeRange } from '../../../src/modules/reporting/scheduling/scheduleTiming.js';
// @ts-ignore Shared canonical report/view resolver used by browser scheduling and the Worker.
import { resolveScheduleReportSelection } from '../../../src/modules/reporting/scheduling/reportSelectionResolver.js';
// @ts-ignore Shared canonical schedule format validation used by browser and Worker.
import { normalizeScheduleExportFormat } from '../../../src/modules/reporting/scheduling/scheduleFormats.js';
// @ts-ignore Shared schedule execution freshness guards used by every scheduled report.
import {
  addScheduledSourceCacheBuster,
  buildScheduledSourceHeaders,
  normalizeScheduledReportFilters,
  summarizeScheduledReportOutput
} from '../../../src/modules/reporting/scheduling/scheduleExecutionFreshness.js';

type Row = Record<string, any>;
type SavedViewInput = {
  name?: string; description?: string; scope?: string; reportGroupId?: string; reportId?: string;
  viewId?: string; filters?: Row; sort?: Row | null; visibleColumns?: string[]; dateRangeType?: string;
  locationId?: string; isDefault?: boolean;
};
type ScheduleReportItem = {
  reportGroupId?: string; reportId?: string; viewId?: string; savedViewId?: string;
  savedViewSnapshotId?: string; savedViewSnapshotName?: string; savedViewUpdatedAt?: string;
  filters?: Row; sort?: Row | null; visibleColumns?: string[]; dateRangeType?: string;
};
type ScheduleInput = {
  name?: string; reportGroupId?: string; reportId?: string; viewId?: string; savedViewId?: string;
  reportItems?: ScheduleReportItem[]; filters?: Row; dateRangeType?: string; locationId?: string;
  locationMode?: string; locationIds?: string[]; scheduleFrequency?: string;
  scheduleDay?: number | null; scheduleTime?: string; timezone?: string; format?: string;
  recipients?: string[]; emailSubject?: string; emailMessage?: string; sendCondition?: Row;
  isEnabled?: boolean;
};

const MANAGER_ROLES = new Set(['owner', 'admin', 'manager', 'super', 'super-user', 'superuser', 'root', 'kcp-superuser', 'kcp-super-user']);
const SCHEDULE_PERMISSION = 'action-schedule-reports';
const EMAIL_REPORT_PERMISSION = 'action-email-reports';
const WORKSPACE_VIEW_PERMISSION = 'action-save-workspace-report-views';
const DELETE_SCHEDULE_PERMISSION = 'action-delete-report-schedules';
const MANAGE_SCHEDULE_PERMISSION = 'action-manage-report-schedules';
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const FORMATS = new Set(['csv', 'xlsx', 'pdf', 'report_link']);
const DATE_RANGE_TYPES = new Set(['today', 'yesterday', 'last_2_days', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7_days', 'last_14_days', 'last_30_days', 'custom']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REPORTS: Record<string, { title: string; groupId?: string; views: string[]; source: 'detail' | 'stocktake' | 'sales' | 'sale_usage' | 'modifier' | 'menu' | 'stock' | 'audit' | 'stock_on_hand' | 'purchase_orders' | 'grv' | 'credit_notes' | 'manufacturing' | 'transfers' | 'advanced' }> = {
  payment_sales_financial: { title: 'Sales Reports - Payment Summary', groupId: 'sales_reports', views: ['daily_summary', 'by_payment_method', 'by_location', 'transaction_detail'], source: 'sales' },
  sale_stock_movement: { title: 'Sales Reports - Stock Movement', groupId: 'sales_reports', views: ['summary', 'by_menu_item', 'by_inventory_category', 'by_inventory_item', 'recipe_line_detail', 'transaction_detail'], source: 'sale_usage' },
  modifier_report: { title: 'Modifier Report', views: ['summary', 'gp_tracker', 'by_group', 'by_menu_item', 'by_modifier', 'sales_log'], source: 'modifier' },
  menu_recipe_health: { title: 'Menu & Recipe Health', views: ['overview', 'menu_items', 'recipe_detail', 'pricing', 'warnings'], source: 'menu' },
  stock_control: { title: 'Stock Control', views: ['location_summary', 'category_summary', 'item_detail', 'reorder_detail', 'warnings'], source: 'stock' },
  stock_on_hand: { title: 'Stock on Hand', views: ['summary', 'by_location', 'by_category', 'by_item', 'by_uom', 'line_detail'], source: 'stock_on_hand' },
  stock_out_forecast: { title: 'Stock-Out Forecast', views: ['forecast_summary', 'risk_matrix', 'by_location', 'by_category', 'by_item', 'usage_detail'], source: 'advanced' },
  price_volatility_analysis: { title: 'Price Volatility Analysis', views: ['summary', 'volatility_matrix', 'by_supplier', 'by_category', 'by_item', 'price_history'], source: 'advanced' },
  theoretical_vs_actual: { title: 'Theoretical vs Actual', views: ['summary', 'variance_heatmap', 'by_location', 'by_category', 'by_item', 'variance_detail', 'formula_breakdown'], source: 'advanced' },
  purchase_orders_report: { title: 'Purchase Orders', views: ['summary', 'by_supplier', 'by_location', 'by_status', 'line_detail'], source: 'purchase_orders' },
  grv_log: { title: 'GRV Log', views: ['summary', 'by_supplier', 'by_location', 'by_item', 'line_detail'], source: 'grv' },
  credit_notes_report: { title: 'Credit Notes', views: ['summary', 'by_supplier', 'by_location', 'by_reason', 'line_detail'], source: 'credit_notes' },
  manufacturing_transactions: { title: 'Manufacturing', views: ['batches', 'by_manufactured_item', 'by_location', 'ingredient_usage', 'wastage', 'line_detail'], source: 'manufacturing' },
  inventory_audit: { title: 'Inventory Audit', views: ['change_log', 'by_user', 'by_entity', 'cost_changes', 'recipe_changes', 'data_quality'], source: 'audit' },
  operations_dashboard: { title: 'Operations Dashboard', views: ['overview', 'by_category', 'by_item', 'movement_ledger'], source: 'detail' },
  detailed_activity: { title: 'Detailed Activity', views: ['ledger'], source: 'detail' },
  wastage: { title: 'Wastage', views: ['summary', 'by_source', 'menu_items', 'by_category', 'by_item', 'line_detail'], source: 'detail' },
  stock_take_audit: { title: 'Stock Take Audit', views: ['sessions', 'by_category', 'by_item', 'count_detail', 'variance_movements'], source: 'stocktake' },
  adjustments: { title: 'Adjustments', views: ['summary', 'by_source', 'menu_items', 'by_reason', 'by_category', 'by_item', 'line_detail'], source: 'detail' },
  stock_transfers: { title: 'Stock Transfers', views: ['summary', 'by_item', 'by_location', 'line_detail', 'movement_ledger'], source: 'detail' }
};

function clean(value: unknown, fallback = '') { return String(value ?? fallback).trim(); }
function reportFilterQueryValue(value: unknown) {
  if (value === '' || value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((entry) => clean(entry)).filter(Boolean).join(',');
  if (typeof value === 'object') return '';
  return String(value);
}
function nowIso() { return new Date().toISOString(); }
function makeId(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }
function parseJson<T>(value: unknown, fallback: T): T { try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; } }
function bool(value: unknown) { return value === true || value === 1 || value === '1'; }
function normalizeRole(value: unknown) { return clean(value).toLowerCase().replace(/[_\s]+/g, '-'); }
function safeFileName(value: string) { return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report'; }
function escapeHtml(value: unknown) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }

const schedulingSchemaPromises = new WeakMap<object, Promise<void>>();

const REPORT_SAVED_VIEW_COLUMNS: Record<string, string> = {
  id: `TEXT NOT NULL DEFAULT ''`,
  workspace_id: `TEXT NOT NULL DEFAULT ''`,
  user_id: `TEXT NOT NULL DEFAULT ''`,
  name: `TEXT NOT NULL DEFAULT ''`,
  description: `TEXT`,
  scope: `TEXT NOT NULL DEFAULT 'personal'`,
  report_group_id: `TEXT`,
  report_id: `TEXT NOT NULL DEFAULT ''`,
  view_id: `TEXT NOT NULL DEFAULT ''`,
  filters_json: `TEXT NOT NULL DEFAULT '{}'`,
  sort_json: `TEXT`,
  visible_columns_json: `TEXT`,
  date_range_type: `TEXT NOT NULL DEFAULT 'custom'`,
  location_id: `TEXT`,
  is_default: `INTEGER NOT NULL DEFAULT 0`,
  created_at: `TEXT NOT NULL DEFAULT ''`,
  updated_at: `TEXT NOT NULL DEFAULT ''`
};

const REPORT_SCHEDULE_COLUMNS: Record<string, string> = {
  id: `TEXT NOT NULL DEFAULT ''`,
  workspace_id: `TEXT NOT NULL DEFAULT ''`,
  created_by: `TEXT NOT NULL DEFAULT ''`,
  name: `TEXT NOT NULL DEFAULT ''`,
  report_group_id: `TEXT`,
  report_id: `TEXT NOT NULL DEFAULT ''`,
  view_id: `TEXT NOT NULL DEFAULT ''`,
  report_items_json: `TEXT NOT NULL DEFAULT '[]'`,
  filters_json: `TEXT NOT NULL DEFAULT '{}'`,
  date_range_type: `TEXT NOT NULL DEFAULT 'today'`,
  location_id: `TEXT`,
  location_mode: `TEXT NOT NULL DEFAULT 'all'`,
  location_ids_json: `TEXT NOT NULL DEFAULT '[]'`,
  schedule_frequency: `TEXT NOT NULL DEFAULT 'weekly'`,
  schedule_day: `INTEGER`,
  schedule_time: `TEXT NOT NULL DEFAULT '08:00'`,
  timezone: `TEXT NOT NULL DEFAULT 'Africa/Johannesburg'`,
  format: `TEXT NOT NULL DEFAULT 'report_link'`,
  recipients_json: `TEXT NOT NULL DEFAULT '[]'`,
  email_subject: `TEXT`,
  email_message: `TEXT`,
  send_condition_json: `TEXT NOT NULL DEFAULT '{"type":"always"}'`,
  is_enabled: `INTEGER NOT NULL DEFAULT 1`,
  last_run_at: `TEXT`,
  next_run_at: `TEXT`,
  created_at: `TEXT NOT NULL DEFAULT ''`,
  updated_at: `TEXT NOT NULL DEFAULT ''`
};

const REPORT_SCHEDULE_RUN_COLUMNS: Record<string, string> = {
  id: `TEXT NOT NULL DEFAULT ''`,
  schedule_id: `TEXT NOT NULL DEFAULT ''`,
  workspace_id: `TEXT NOT NULL DEFAULT ''`,
  started_at: `TEXT NOT NULL DEFAULT ''`,
  finished_at: `TEXT`,
  status: `TEXT NOT NULL DEFAULT 'running'`,
  rows_exported: `INTEGER NOT NULL DEFAULT 0`,
  reports_generated: `INTEGER NOT NULL DEFAULT 0`,
  files_generated: `INTEGER NOT NULL DEFAULT 0`,
  output_manifest_json: `TEXT NOT NULL DEFAULT '[]'`,
  file_url: `TEXT`,
  error_message: `TEXT`,
  email_sent: `INTEGER NOT NULL DEFAULT 0`,
  created_at: `TEXT NOT NULL DEFAULT ''`
};

async function ensureReportSchedulingSchema(env: Env, { force = false }: { force?: boolean } = {}) {
  const database = env.DB as unknown as object;
  const current = schedulingSchemaPromises.get(database);
  if (current && !force) return current;

  const repair = repairReportSchedulingSchema(env);
  schedulingSchemaPromises.set(database, repair);
  try {
    await repair;
  } catch (cause) {
    if (schedulingSchemaPromises.get(database) === repair) schedulingSchemaPromises.delete(database);
    throw cause;
  }
}

async function repairReportSchedulingSchema(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS report_saved_views (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, scope TEXT NOT NULL DEFAULT 'personal', report_group_id TEXT,
    report_id TEXT NOT NULL, view_id TEXT NOT NULL, filters_json TEXT NOT NULL DEFAULT '{}',
    sort_json TEXT, visible_columns_json TEXT, date_range_type TEXT NOT NULL DEFAULT 'custom',
    location_id TEXT, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS report_schedules (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_by TEXT NOT NULL, name TEXT NOT NULL,
    report_group_id TEXT, report_id TEXT NOT NULL, view_id TEXT NOT NULL,
    report_items_json TEXT NOT NULL DEFAULT '[]', filters_json TEXT NOT NULL DEFAULT '{}',
    date_range_type TEXT NOT NULL DEFAULT 'today', location_id TEXT,
    location_mode TEXT NOT NULL DEFAULT 'all', location_ids_json TEXT NOT NULL DEFAULT '[]',
    schedule_frequency TEXT NOT NULL, schedule_day INTEGER, schedule_time TEXT NOT NULL,
    timezone TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'report_link' CHECK (format IN ('csv', 'xlsx', 'pdf', 'report_link')), recipients_json TEXT NOT NULL DEFAULT '[]',
    email_subject TEXT, email_message TEXT, send_condition_json TEXT NOT NULL DEFAULT '{"type":"always"}',
    is_enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, next_run_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS report_schedule_runs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'skipped', 'failed')),
    rows_exported INTEGER NOT NULL DEFAULT 0, reports_generated INTEGER NOT NULL DEFAULT 0,
    files_generated INTEGER NOT NULL DEFAULT 0, output_manifest_json TEXT NOT NULL DEFAULT '[]',
    file_url TEXT, error_message TEXT, email_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`).run();

  await ensureTableColumns(env, 'report_saved_views', REPORT_SAVED_VIEW_COLUMNS);
  await ensureTableColumns(env, 'report_schedules', REPORT_SCHEDULE_COLUMNS);
  await ensureTableColumns(env, 'report_schedule_runs', REPORT_SCHEDULE_RUN_COLUMNS);
  await verifyTableColumns(env, 'report_saved_views', Object.keys(REPORT_SAVED_VIEW_COLUMNS));
  await verifyTableColumns(env, 'report_schedules', Object.keys(REPORT_SCHEDULE_COLUMNS));
  await verifyTableColumns(env, 'report_schedule_runs', Object.keys(REPORT_SCHEDULE_RUN_COLUMNS));

  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_report_saved_views_workspace ON report_saved_views(workspace_id)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_report_saved_views_workspace_user ON report_saved_views(workspace_id, user_id)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_report_schedules_workspace ON report_schedules(workspace_id)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_report_schedules_workspace_enabled ON report_schedules(workspace_id, is_enabled)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_report_schedules_next_run ON report_schedules(next_run_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_report_schedule_runs_schedule_created ON report_schedule_runs(schedule_id, created_at)`).run();
}

async function ensureTableColumns(env: Env, table: string, columns: Record<string, string>) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<Row>();
  const existing = new Set(info.results.map((row) => clean(row.name)).filter(Boolean));
  for (const [name, definition] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    try {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
      existing.add(name);
    } catch (cause) {
      const message = clean((cause as Error)?.message || cause).toLowerCase();
      if (/duplicate column name|already exists/.test(message)) {
        existing.add(name);
        continue;
      }
      throw cause;
    }
  }
}

async function verifyTableColumns(env: Env, table: string, required: string[]) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<Row>();
  const existing = new Set(info.results.map((row) => clean(row.name)).filter(Boolean));
  const missing = required.filter((name) => !existing.has(name));
  if (missing.length) throw new Error(`Scheduling schema repair incomplete for ${table}: ${missing.join(', ')}`);
}

function isSchedulingSchemaError(cause: unknown) {
  const message = clean((cause as Error)?.message || cause).toLowerCase();
  return /no such column|has no column named|no such table|duplicate column|schema repair incomplete/.test(message);
}

async function withSchedulingSchemaRetry<T>(env: Env, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (!isSchedulingSchemaError(cause)) throw cause;
    await ensureReportSchedulingSchema(env, { force: true });
    return operation();
  }
}

async function withSchedulingWriteRetry<T>(env: Env, operation: () => Promise<T>): Promise<T> {
  try {
    return await withSchedulingSchemaRetry(env, operation);
  } catch (firstCause) {
    try {
      return await withSchedulingSchemaRetry(env, operation);
    } catch {
      throw firstCause;
    }
  }
}

async function actorPermissions(env: Env, auth: AuthContext, workspaceId: string) {
  const access = await assertWorkspaceAccess(env, auth, workspaceId);
  const role = normalizeRole(access.role_key);
  if (MANAGER_ROLES.has(role)) return { role, permissions: ['*'] };
  const row = await env.CENTRAL_DB.prepare(
    `SELECT permissions_json FROM roles WHERE workspace_id = ?1 AND role_key = ?2 LIMIT 1`
  ).bind(workspaceId, role).first<{ permissions_json?: string }>();
  const parsed = parseJson<any>(row?.permissions_json, []);
  const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.permissions) ? parsed.permissions : [];
  return { role, permissions: values.map((value: unknown) => clean(value)).filter(Boolean) };
}
async function requirePermission(request: Request, env: Env, auth: AuthContext, workspaceId: string, permission: string) {
  const access = await actorPermissions(env, auth, workspaceId);
  if (access.permissions.includes('*') || access.permissions.includes(permission)) return null;
  const message = permission === EMAIL_REPORT_PERMISSION
    ? 'You do not have permission to email reports.'
    : 'You do not have permission to manage report scheduling.';
  return error(request, env, 403, message);
}

function validateReport(reportId: string, viewId: string) {
  const resolved = resolveScheduleReportSelection(reportId, viewId);
  const report = resolved ? REPORTS[resolved.reportId] : null;
  if (!resolved || !report) throw new Error('This report is no longer available for scheduling.');
  return report;
}
function validateEmails(recipients: string[]) {
  if (!recipients.length) throw new Error('At least one recipient is required.');
  if (recipients.some((email) => !EMAIL_RE.test(email))) throw new Error('One or more recipient email addresses are invalid.');
}
function validateDateRangeType(value: string) {
  const normalized = clean(value || 'custom').toLowerCase();
  if (!DATE_RANGE_TYPES.has(normalized)) throw new Error('Unsupported date range preset.');
  return normalized;
}

function repairScheduleItem(item: ScheduleReportItem): ScheduleReportItem | null {
  const resolved = resolveScheduleReportSelection(clean(item.reportId), clean(item.viewId));
  const report = resolved ? REPORTS[resolved.reportId] : null;
  if (!resolved || !report) return null;
  return {
    reportGroupId: clean(item.reportGroupId || report.groupId),
    reportId: clean(resolved.reportId),
    viewId: clean(resolved.viewId),
    savedViewId: clean(item.savedViewId),
    savedViewSnapshotId: clean(item.savedViewSnapshotId),
    savedViewSnapshotName: clean(item.savedViewSnapshotName),
    savedViewUpdatedAt: clean(item.savedViewUpdatedAt),
    filters: item.filters && typeof item.filters === 'object' ? item.filters : {},
    sort: item.sort && typeof item.sort === 'object' ? item.sort : null,
    visibleColumns: Array.isArray(item.visibleColumns) ? item.visibleColumns.map((value) => clean(value)).filter(Boolean) : [],
    dateRangeType: clean(item.dateRangeType || item.filters?.dateRangeType || '')
  };
}

function normalizeScheduleItems(input: ScheduleInput | Row): ScheduleReportItem[] {
  const raw = Array.isArray(input.reportItems) && input.reportItems.length
    ? input.reportItems
    : clean(input.reportId) && clean(input.viewId)
      ? [{ reportGroupId: clean(input.reportGroupId), reportId: clean(input.reportId), viewId: clean(input.viewId), savedViewId: clean(input.savedViewId) }]
      : [];
  const seen = new Set<string>();
  return raw.map((item: ScheduleReportItem) => repairScheduleItem(item)).filter((item): item is ScheduleReportItem => Boolean(item)).filter((item) => {
    const key = `${item.reportId}::${item.viewId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


async function materializeScheduleItems(env: Env, workspaceId: string, input: ScheduleInput | Row) {
  const inputItems = normalizeScheduleItems(input);
  const topLevelSavedViewId = clean(input.savedViewId);
  const hydrated: ScheduleReportItem[] = [];
  const warnings: string[] = [];
  for (let index = 0; index < inputItems.length; index += 1) {
    const item = { ...inputItems[index] };
    const savedViewId = clean(item.savedViewId || (index === 0 ? topLevelSavedViewId : ''));
    if (!savedViewId) {
      hydrated.push({ ...item, savedViewId: '' });
      continue;
    }
    const row = await getSavedViewRow(env, workspaceId, savedViewId);
    if (!row) {
      warnings.push(`Saved view ${savedViewId} was removed; the schedule will use its stored report settings.`);
      hydrated.push({ ...item, savedViewId: '' });
      continue;
    }
    const saved = mapSavedView(row);
    const resolvedSaved = repairScheduleItem({
      reportGroupId: saved.reportGroupId,
      reportId: saved.reportId,
      viewId: saved.viewId,
      filters: saved.filters,
      sort: saved.sort,
      visibleColumns: saved.visibleColumns,
      dateRangeType: saved.dateRangeType
    });
    if (!resolvedSaved) {
      warnings.push(`Saved view ${savedViewId} targets a report that is no longer available; the schedule will use its stored report settings.`);
      hydrated.push({ ...item, savedViewId: '' });
      continue;
    }
    hydrated.push({
      ...item,
      reportGroupId: resolvedSaved.reportGroupId || item.reportGroupId,
      reportId: resolvedSaved.reportId || item.reportId,
      viewId: resolvedSaved.viewId || item.viewId,
      filters: { ...(saved.filters || {}) },
      sort: saved.sort || null,
      visibleColumns: Array.isArray(saved.visibleColumns) ? saved.visibleColumns : [],
      savedViewId: '',
      savedViewSnapshotId: saved.id,
      savedViewSnapshotName: saved.name,
      savedViewUpdatedAt: saved.updatedAt,
      dateRangeType: saved.dateRangeType || saved.filters?.dateRangeType || item.dateRangeType || 'custom'
    });
  }
  const snapshots = normalizeScheduleItems({ ...input, reportItems: hydrated, savedViewId: '' }).map(({ savedViewId: _savedViewId, ...snapshot }) => snapshot);
  return { items: snapshots, warnings };
}


async function hydrateScheduleItemsForExecution(env: Env, workspaceId: string, input: ScheduleInput | Row) {
  const items = normalizeScheduleItems(input);
  const hydrated: ScheduleReportItem[] = [];
  for (const item of items) {
    const savedViewId = clean(item.savedViewSnapshotId || item.savedViewId);
    if (!savedViewId) {
      hydrated.push(item);
      continue;
    }
    const row = await getSavedViewRow(env, workspaceId, savedViewId);
    if (!row) {
      hydrated.push(item);
      continue;
    }
    const saved = mapSavedView(row);
    const resolved = repairScheduleItem({
      reportGroupId: saved.reportGroupId,
      reportId: saved.reportId,
      viewId: saved.viewId,
      filters: saved.filters,
      sort: saved.sort,
      visibleColumns: saved.visibleColumns,
      dateRangeType: saved.dateRangeType,
    });
    if (!resolved) {
      hydrated.push(item);
      continue;
    }
    hydrated.push({
      ...item,
      reportGroupId: resolved.reportGroupId || item.reportGroupId,
      reportId: resolved.reportId || item.reportId,
      viewId: resolved.viewId || item.viewId,
      filters: { ...(saved.filters || {}) },
      sort: saved.sort || null,
      visibleColumns: Array.isArray(saved.visibleColumns) ? [...saved.visibleColumns] : [],
      savedViewSnapshotId: saved.id,
      savedViewSnapshotName: saved.name,
      savedViewUpdatedAt: saved.updatedAt,
      dateRangeType: saved.dateRangeType || saved.filters?.dateRangeType || item.dateRangeType || 'custom',
    });
  }
  return hydrated;
}

async function reconcileExistingScheduleLocations(env: Env, auth: AuthContext, workspaceId: string, input: ScheduleInput) {
  const active = await listActiveScheduleLocations(env, workspaceId);
  const allowedIds = await getUserAllowedLocationIds(env, auth, workspaceId);
  const selectable = allowedIds === null ? active : active.filter((location) => allowedIds.includes(location.id));
  const mode = normalizeLocationMode(input.locationMode);
  if (mode !== 'selected') return { ...input, locationMode: allowedIds === null ? 'all' : 'selected', locationIds: allowedIds === null ? [] : selectable.slice(0, 1).map((location) => location.id), locationId: allowedIds === null ? '' : clean(selectable[0]?.id) };
  const requested = normalizeLocationIds(input);
  const valid = requested.filter((id) => selectable.some((location) => location.id === id));
  const repaired = valid.length ? valid : selectable.slice(0, 1).map((location) => location.id);
  return { ...input, locationMode: 'selected', locationIds: repaired, locationId: repaired.length === 1 ? repaired[0] : '' };
}

function normalizeLocationMode(value: unknown) {
  return clean(value || 'all').toLowerCase() === 'selected' ? 'selected' : 'all';
}

function normalizeLocationIds(input: ScheduleInput | Row) {
  const values = Array.isArray(input.locationIds) ? input.locationIds : clean(input.locationId) ? [clean(input.locationId)] : [];
  return Array.from(new Set(values.map((value) => clean(value)).filter(Boolean)));
}

export async function getReportSavedViews(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  await ensureReportSchedulingSchema(env);
  await assertWorkspaceAccess(env, auth, workspaceId);
  const allowedLocationIds = await getUserAllowedLocationIds(env, auth, workspaceId);
  const rows = await env.DB.prepare(
    `SELECT * FROM report_saved_views WHERE workspace_id = ?1 AND (user_id = ?2 OR scope = 'workspace') ORDER BY is_default DESC, lower(name) ASC`
  ).bind(workspaceId, auth.uid).all<Row>();
  const views = rows.results
    .map(mapSavedViewForClient)
    .filter(Boolean)
    .map((view: Row) => scopeSavedViewForLocations(view, allowedLocationIds))
    .filter(Boolean);
  return json(request, env, { ok: true, views });
}

export async function postReportSavedView(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  await ensureReportSchedulingSchema(env);
  await assertWorkspaceAccess(env, auth, workspaceId);
  const body = await readJson<SavedViewInput>(request);
  const name = clean(body.name);
  const requestedReportId = clean(body.reportId);
  const requestedViewId = clean(body.viewId);
  const resolvedSelection = resolveScheduleReportSelection(requestedReportId, requestedViewId);
  const reportId = clean(resolvedSelection?.reportId);
  const canonicalViewId = clean(resolvedSelection?.viewId);
  const scope = clean(body.scope || 'personal').toLowerCase() === 'workspace' ? 'workspace' : 'personal';
  const filters = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters) ? { ...body.filters } : {};
  if (!name || !requestedReportId || !requestedViewId) return error(request, env, 400, 'Name, report, and view are required.');
  try { validateReport(reportId, canonicalViewId); validateDateRangeType(clean(body.dateRangeType || 'custom')); } catch (cause) { return error(request, env, 400, (cause as Error).message); }
  if (scope === 'workspace') {
    const denied = await requirePermission(request, env, auth, workspaceId, WORKSPACE_VIEW_PERMISSION);
    if (denied) return denied;
  }

  const allowedLocationIds = await getUserAllowedLocationIds(env, auth, workspaceId);
  const requestedLocationIds = savedViewLocationIds({ ...body, filters });
  if (allowedLocationIds !== null) {
    if (!allowedLocationIds.length) return error(request, env, 403, 'No locations are assigned to this user.');
    const unauthorized = requestedLocationIds.find((id) => !allowedLocationIds.includes(id));
    if (unauthorized) return error(request, env, 403, `Permission denied for location ${unauthorized}.`);
    if (!requestedLocationIds.length) {
      filters.locationIds = [...allowedLocationIds];
      if (allowedLocationIds.length === 1) filters.locationId = allowedLocationIds[0];
    }
  }

  const id = makeId('rsv');
  const now = nowIso();
  const dateRangeType = validateDateRangeType(clean(body.dateRangeType || 'custom'));
  const visibleColumns = Array.isArray(body.visibleColumns) ? body.visibleColumns.map((value) => clean(value)).filter(Boolean) : [];
  const storedLocationIds = savedViewLocationIds({ ...body, filters });
  const storedLocationId = storedLocationIds.length === 1 ? storedLocationIds[0] : '';
  try {
    await withSchedulingWriteRetry(env, async () => {
      if (body.isDefault) await clearDefaultViews(env, workspaceId, auth.uid, reportId, clean(body.reportGroupId || REPORTS[reportId]?.groupId), scope);
      await env.DB.prepare(
        `INSERT INTO report_saved_views (id, workspace_id, user_id, name, description, scope, report_group_id, report_id, view_id, filters_json, sort_json, visible_columns_json, date_range_type, location_id, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`
      ).bind(id, workspaceId, auth.uid, name, clean(body.description), scope, clean(body.reportGroupId || REPORTS[reportId]?.groupId), reportId, canonicalViewId,
        JSON.stringify(filters), body.sort && typeof body.sort === 'object' ? JSON.stringify(body.sort) : null, JSON.stringify(visibleColumns),
        dateRangeType, storedLocationId, body.isDefault ? 1 : 0, now).run();
    });
  } catch (cause) {
    return error(request, env, 500, savedViewPersistenceMessage(cause));
  }
  const row = await getSavedViewRow(env, workspaceId, id);
  const view = scopeSavedViewForLocations(mapSavedViewForClient(row || {}) as Row, allowedLocationIds);
  return json(request, env, { ok: true, view }, { status: 201 });
}

export async function putReportSavedView(request: Request, env: Env, auth: AuthContext, workspaceId: string, viewId: string) {
  await ensureReportSchedulingSchema(env);
  await assertWorkspaceAccess(env, auth, workspaceId);
  const existing = await getSavedViewRow(env, workspaceId, viewId);
  if (!existing) return error(request, env, 404, 'Saved view not found.');
  const manager = await actorPermissions(env, auth, workspaceId);
  if (clean(existing.user_id) !== auth.uid && !manager.permissions.includes('*')) return error(request, env, 403, 'You can only edit your own saved views.');
  const body = await readJson<SavedViewInput>(request);
  const merged = { ...mapSavedView(existing), ...body } as any;
  const scope = clean(merged.scope || 'personal').toLowerCase() === 'workspace' ? 'workspace' : 'personal';
  const filters = merged.filters && typeof merged.filters === 'object' && !Array.isArray(merged.filters) ? { ...merged.filters } : {};
  if (!clean(merged.name)) return error(request, env, 400, 'Name is required.');
  const resolvedSelection = resolveScheduleReportSelection(clean(merged.reportId), clean(merged.viewId));
  if (!resolvedSelection) return error(request, env, 400, 'This report is no longer available for saved views.');
  merged.reportId = resolvedSelection.reportId;
  merged.viewId = resolvedSelection.viewId;
  merged.reportGroupId = clean(merged.reportGroupId || REPORTS[clean(merged.reportId)]?.groupId);
  try { validateReport(clean(merged.reportId), clean(merged.viewId)); validateDateRangeType(clean(merged.dateRangeType || 'custom')); } catch (cause) { return error(request, env, 400, (cause as Error).message); }
  if (scope === 'workspace' && !manager.permissions.includes('*') && !manager.permissions.includes(WORKSPACE_VIEW_PERMISSION)) return error(request, env, 403, 'You cannot create workspace saved views.');

  const allowedLocationIds = await getUserAllowedLocationIds(env, auth, workspaceId);
  const requestedLocationIds = savedViewLocationIds({ ...merged, filters });
  if (allowedLocationIds !== null) {
    if (!allowedLocationIds.length) return error(request, env, 403, 'No locations are assigned to this user.');
    const unauthorized = requestedLocationIds.find((id) => !allowedLocationIds.includes(id));
    if (unauthorized) return error(request, env, 403, `Permission denied for location ${unauthorized}.`);
    if (!requestedLocationIds.length) {
      filters.locationIds = [...allowedLocationIds];
      if (allowedLocationIds.length === 1) filters.locationId = allowedLocationIds[0];
    }
  }
  const storedLocationIds = savedViewLocationIds({ ...merged, filters });
  const storedLocationId = storedLocationIds.length === 1 ? storedLocationIds[0] : '';
  const visibleColumns = Array.isArray(merged.visibleColumns) ? merged.visibleColumns.map((value: unknown) => clean(value)).filter(Boolean) : [];
  try {
    await withSchedulingWriteRetry(env, async () => {
      if (merged.isDefault) await clearDefaultViews(env, workspaceId, clean(existing.user_id), clean(merged.reportId), clean(merged.reportGroupId), scope, viewId);
      await env.DB.prepare(
        `UPDATE report_saved_views SET name=?1, description=?2, scope=?3, report_group_id=?4, report_id=?5, view_id=?6, filters_json=?7, sort_json=?8, visible_columns_json=?9, date_range_type=?10, location_id=?11, is_default=?12, updated_at=?13 WHERE id=?14 AND workspace_id=?15`
      ).bind(clean(merged.name), clean(merged.description), scope, clean(merged.reportGroupId), clean(merged.reportId), clean(merged.viewId), JSON.stringify(filters), merged.sort && typeof merged.sort === 'object' ? JSON.stringify(merged.sort) : null, JSON.stringify(visibleColumns), validateDateRangeType(clean(merged.dateRangeType || 'custom')), storedLocationId, merged.isDefault ? 1 : 0, nowIso(), viewId, workspaceId).run();
    });
  } catch (cause) {
    return error(request, env, 500, savedViewPersistenceMessage(cause));
  }
  const row = await getSavedViewRow(env, workspaceId, viewId);
  const view = scopeSavedViewForLocations(mapSavedViewForClient(row || {}) as Row, allowedLocationIds);
  return json(request, env, { ok: true, view });
}

export async function deleteReportSavedView(request: Request, env: Env, auth: AuthContext, workspaceId: string, viewId: string) {
  await ensureReportSchedulingSchema(env);
  await assertWorkspaceAccess(env, auth, workspaceId);
  const existing = await getSavedViewRow(env, workspaceId, viewId);
  if (!existing) return error(request, env, 404, 'Saved view not found.');
  const actor = await actorPermissions(env, auth, workspaceId);
  if (clean(existing.user_id) !== auth.uid && !actor.permissions.includes('*')) return error(request, env, 403, 'You can only delete your own saved views.');
  await env.DB.prepare(`DELETE FROM report_saved_views WHERE id=?1 AND workspace_id=?2`).bind(viewId, workspaceId).run();
  return json(request, env, { ok: true });
}

export async function getReportSchedules(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  try { await ensureReportSchedulingSchema(env); } catch (cause) { return error(request, env, 500, schedulePersistenceMessage(cause)); }
  const denied = await requirePermission(request, env, auth, workspaceId, SCHEDULE_PERMISSION);
  if (denied) return denied;
  const actor = await actorPermissions(env, auth, workspaceId);
  const canManageAll = actor.permissions.includes('*') || actor.permissions.includes(MANAGE_SCHEDULE_PERMISSION);
  const rows = canManageAll
    ? await env.DB.prepare(`SELECT * FROM report_schedules WHERE workspace_id=?1 ORDER BY is_enabled DESC, next_run_at ASC, lower(name) ASC`).bind(workspaceId).all<Row>()
    : await env.DB.prepare(`SELECT * FROM report_schedules WHERE workspace_id=?1 AND created_by=?2 ORDER BY is_enabled DESC, next_run_at ASC, lower(name) ASC`).bind(workspaceId, auth.uid).all<Row>();
  const locations = await listActiveScheduleLocations(env, workspaceId);
  const allowedLocationIds = await getUserAllowedLocationIds(env, auth, workspaceId);
  const selectableLocations = allowedLocationIds === null
    ? locations
    : locations.filter((location) => allowedLocationIds.includes(location.id));
  const schedules = rows.results.map((row) => enrichScheduleLocations(mapSchedule(row), locations));
  const users = await listActiveScheduleRecipientUsers(env, workspaceId);
  return json(request, env, {
    ok: true,
    schedules,
    locations: selectableLocations,
    users,
    allowAllLocations: allowedLocationIds === null,
    schedulerVersion: '33.19'
  });
}

export async function postReportSchedule(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  try { await ensureReportSchedulingSchema(env); } catch (cause) { return error(request, env, 500, schedulePersistenceMessage(cause)); }
  const denied = await requirePermission(request, env, auth, workspaceId, SCHEDULE_PERMISSION);
  if (denied) return denied;
  const emailDenied = await requirePermission(request, env, auth, workspaceId, EMAIL_REPORT_PERMISSION);
  if (emailDenied) return emailDenied;
  const body = await readJson<ScheduleInput>(request);
  const validation = await validateScheduleInput(request, env, auth, workspaceId, body);
  if (validation instanceof Response) return validation;
  const id = makeId('rsch');
  const now = nowIso();
  const next = body.isEnabled === false ? null : calculateReportNextRunAt(body, new Date(now));
  const firstItem = validation.items[0];
  const requestedFormat = normalizeScheduleExportFormat(body.format);
  try {
    await withSchedulingSchemaRetry(env, () => env.DB.prepare(
      `INSERT INTO report_schedules (id, workspace_id, created_by, name, report_group_id, report_id, view_id, report_items_json, filters_json, date_range_type, location_id, location_mode, location_ids_json, schedule_frequency, schedule_day, schedule_time, timezone, format, recipients_json, email_subject, email_message, send_condition_json, is_enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,NULL,?24,?25,?25)`
    ).bind(id, workspaceId, auth.uid, clean(body.name), clean(firstItem.reportGroupId || body.reportGroupId || validation.report.groupId), clean(firstItem.reportId), clean(firstItem.viewId), JSON.stringify(validation.items), JSON.stringify(body.filters || {}), validateDateRangeType(clean(body.dateRangeType || 'today')), validation.locationMode === 'selected' && validation.locationIds.length === 1 ? validation.locationIds[0] : null, validation.locationMode, JSON.stringify(validation.locationIds), clean(body.scheduleFrequency), body.scheduleDay ?? null, clean(body.scheduleTime), clean(body.timezone), requestedFormat, JSON.stringify(body.recipients || []), clean(body.emailSubject), clean(body.emailMessage), JSON.stringify(body.sendCondition || { type: 'always' }), body.isEnabled === false ? 0 : 1, next, now).run());
  } catch (cause) {
    return error(request, env, 500, schedulePersistenceMessage(cause));
  }
  const row = await getScheduleRow(env, workspaceId, id);
  const locations = await listActiveScheduleLocations(env, workspaceId);
  return json(request, env, { ok: true, schedule: enrichScheduleLocations(mapSchedule(row || {}), locations) }, { status: 201 });
}

export async function putReportSchedule(request: Request, env: Env, auth: AuthContext, workspaceId: string, scheduleId: string) {
  try { await ensureReportSchedulingSchema(env); } catch (cause) { return error(request, env, 500, schedulePersistenceMessage(cause)); }
  const denied = await requirePermission(request, env, auth, workspaceId, SCHEDULE_PERMISSION);
  if (denied) return denied;
  const emailDenied = await requirePermission(request, env, auth, workspaceId, EMAIL_REPORT_PERMISSION);
  if (emailDenied) return emailDenied;
  const existing = await getScheduleRow(env, workspaceId, scheduleId);
  if (!existing) return error(request, env, 404, 'Report schedule not found.');
  const actor = await actorPermissions(env, auth, workspaceId);
  if (clean(existing.created_by) !== auth.uid && !actor.permissions.includes('*') && !actor.permissions.includes(MANAGE_SCHEDULE_PERMISSION)) return error(request, env, 403, 'You can only edit your own report schedules.');
  const patch = await readJson<ScheduleInput>(request);
  const mergedRaw = { ...mapSchedule(existing), ...patch } as ScheduleInput;
  const merged = await reconcileExistingScheduleLocations(env, auth, workspaceId, mergedRaw);
  const validation = await validateScheduleInput(request, env, auth, workspaceId, merged);
  if (validation instanceof Response) return validation;
  const isEnabled = merged.isEnabled !== false;
  const next = isEnabled ? calculateReportNextRunAt(merged, new Date()) : null;
  const firstItem = validation.items[0];
  const requestedFormat = normalizeScheduleExportFormat(merged.format);
  try {
    await withSchedulingSchemaRetry(env, () => env.DB.prepare(
      `UPDATE report_schedules SET name=?1, report_group_id=?2, report_id=?3, view_id=?4, report_items_json=?5, filters_json=?6, date_range_type=?7, location_id=?8, location_mode=?9, location_ids_json=?10, schedule_frequency=?11, schedule_day=?12, schedule_time=?13, timezone=?14, format=?15, recipients_json=?16, email_subject=?17, email_message=?18, send_condition_json=?19, is_enabled=?20, next_run_at=?21, updated_at=?22 WHERE id=?23 AND workspace_id=?24`
    ).bind(clean(merged.name), clean(firstItem.reportGroupId || merged.reportGroupId || validation.report.groupId), clean(firstItem.reportId), clean(firstItem.viewId), JSON.stringify(validation.items), JSON.stringify(merged.filters || {}), validateDateRangeType(clean(merged.dateRangeType || 'today')), validation.locationMode === 'selected' && validation.locationIds.length === 1 ? validation.locationIds[0] : null, validation.locationMode, JSON.stringify(validation.locationIds), clean(merged.scheduleFrequency), merged.scheduleDay ?? null, clean(merged.scheduleTime), clean(merged.timezone), requestedFormat, JSON.stringify(merged.recipients || []), clean(merged.emailSubject), clean(merged.emailMessage), JSON.stringify(merged.sendCondition || { type: 'always' }), isEnabled ? 1 : 0, next, nowIso(), scheduleId, workspaceId).run());
  } catch (cause) {
    return error(request, env, 500, schedulePersistenceMessage(cause));
  }
  const row = await getScheduleRow(env, workspaceId, scheduleId);
  const locations = await listActiveScheduleLocations(env, workspaceId);
  return json(request, env, { ok: true, schedule: enrichScheduleLocations(mapSchedule(row || {}), locations) });
}

export async function deleteReportSchedule(request: Request, env: Env, auth: AuthContext, workspaceId: string, scheduleId: string) {
  await ensureReportSchedulingSchema(env);
  const denied = await requirePermission(request, env, auth, workspaceId, DELETE_SCHEDULE_PERMISSION);
  if (denied) return denied;
  const existing = await getScheduleRow(env, workspaceId, scheduleId);
  if (!existing) return error(request, env, 404, 'Report schedule not found.');
  const actor = await actorPermissions(env, auth, workspaceId);
  if (clean(existing.created_by) !== auth.uid && !actor.permissions.includes('*') && !actor.permissions.includes(MANAGE_SCHEDULE_PERMISSION)) return error(request, env, 403, 'You can only delete your own report schedules.');
  await env.DB.prepare(`DELETE FROM report_schedules WHERE id=?1 AND workspace_id=?2`).bind(scheduleId, workspaceId).run();
  return json(request, env, { ok: true });
}

export async function postRunReportScheduleNow(request: Request, env: Env, auth: AuthContext, workspaceId: string, scheduleId: string) {
  await ensureReportSchedulingSchema(env);
  const denied = await requirePermission(request, env, auth, workspaceId, SCHEDULE_PERMISSION);
  if (denied) return denied;
  const emailDenied = await requirePermission(request, env, auth, workspaceId, EMAIL_REPORT_PERMISSION);
  if (emailDenied) return emailDenied;
  const schedule = await getScheduleRow(env, workspaceId, scheduleId);
  if (!schedule) return error(request, env, 404, 'Report schedule not found.');
  const actor = await actorPermissions(env, auth, workspaceId);
  if (clean(schedule.created_by) !== auth.uid && !actor.permissions.includes('*') && !actor.permissions.includes(MANAGE_SCHEDULE_PERMISSION)) return error(request, env, 403, 'You can only run your own report schedules.');
  try {
    const result = await executeSchedule(request, env, auth, workspaceId, schedule, true);
    return json(request, env, result);
  } catch (cause) {
    return error(request, env, 500, scheduleExecutionMessage(cause, 'Could not run the report schedule.'));
  }
}

export async function postReportTestEmail(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  await ensureReportSchedulingSchema(env);
  const denied = await requirePermission(request, env, auth, workspaceId, SCHEDULE_PERMISSION);
  if (denied) return denied;
  const emailDenied = await requirePermission(request, env, auth, workspaceId, EMAIL_REPORT_PERMISSION);
  if (emailDenied) return emailDenied;
  const body = await readJson<ScheduleInput>(request);
  const validation = await validateScheduleInput(request, env, auth, workspaceId, body);
  if (validation instanceof Response) return validation;
  const temp = inputToScheduleRow({ ...body, reportItems: validation.items, savedViewId: '' }, workspaceId, auth.uid);
  try {
    const result = await executeSchedule(request, env, auth, workspaceId, temp, true, true);
    return json(request, env, result);
  } catch (cause) {
    return error(request, env, 500, scheduleExecutionMessage(cause, 'Could not send the test report email.'));
  }
}

export async function postRunDueReportSchedules(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  await ensureReportSchedulingSchema(env);
  if (auth.uid !== 'system') return error(request, env, 403, 'Internal scheduler route.');
  const due = await env.DB.prepare(`SELECT * FROM report_schedules WHERE workspace_id=?1 AND is_enabled=1 AND next_run_at IS NOT NULL AND datetime(next_run_at) <= datetime('now') ORDER BY next_run_at ASC LIMIT 25`).bind(workspaceId).all<Row>();
  const results: Row[] = [];
  for (const schedule of due.results) {
    const auth: AuthContext = { uid: clean(schedule.created_by), email: '', token: { sub: clean(schedule.created_by) } };
    try {
      results.push({ id: schedule.id, ...(await executeSchedule(request, env, auth, workspaceId, schedule, false)) });
    } catch (cause) {
      results.push({ id: schedule.id, ok: false, error: (cause as Error).message });
    }
  }
  return json(request, env, { ok: true, evaluated: due.results.length, results });
}

async function validateScheduleInput(request: Request, env: Env, auth: AuthContext, workspaceId: string, body: ScheduleInput): Promise<{ report: typeof REPORTS[string]; items: ScheduleReportItem[]; locationMode: string; locationIds: string[] } | Response> {
  const name = clean(body.name);
  const materialized = await materializeScheduleItems(env, workspaceId, body);
  const items = materialized.items;
  if (!name || !items.length) return error(request, env, 400, 'Schedule name and at least one current report view are required.');
  if (items.length > 50) return error(request, env, 400, 'A schedule can contain up to 50 report views.');
  let firstReport: typeof REPORTS[string] | null = null;
  try {
    for (const item of items) {
      const report = validateReport(clean(item.reportId), clean(item.viewId));
      if (!firstReport) firstReport = report;
    }
  } catch (cause) {
    return error(request, env, 400, (cause as Error).message);
  }
  const frequency = clean(body.scheduleFrequency).toLowerCase();
  if (!FREQUENCIES.has(frequency)) return error(request, env, 400, 'Schedule frequency must be daily, weekly, or monthly.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(body.scheduleTime))) return error(request, env, 400, 'Schedule time must be HH:MM.');
  if (!clean(body.timezone)) return error(request, env, 400, 'Timezone is required.');
  try { new Intl.DateTimeFormat('en-ZA', { timeZone: clean(body.timezone) }).format(new Date()); } catch { return error(request, env, 400, 'Timezone is invalid.'); }
  const format = clean(body.format).toLowerCase();
  if (!FORMATS.has(format)) return error(request, env, 400, 'Unsupported scheduled report export format.');
  const recipients = Array.isArray(body.recipients) ? body.recipients.map((v) => clean(v).toLowerCase()).filter(Boolean) : [];
  try { validateEmails(recipients); validateDateRangeType(clean(body.dateRangeType || 'today')); } catch (cause) { return error(request, env, 400, (cause as Error).message); }
  const locationMode = normalizeLocationMode(body.locationMode);
  const locationIds = normalizeLocationIds(body);
  const allowedLocations = await getUserAllowedLocationIds(env, auth, workspaceId);
  if (allowedLocations !== null && locationMode !== 'selected') {
    return error(request, env, 403, 'Restricted users cannot schedule reports for All Locations. Select assigned locations only.');
  }
  if (locationMode === 'selected' && !locationIds.length) return error(request, env, 400, 'Select at least one location or choose All Locations.');
  for (const locationId of locationIds) await assertLocationAccess(env, auth, workspaceId, locationId, 'scheduled_report');
  if (locationIds.length > 50) return error(request, env, 400, 'A schedule can contain up to 50 locations.');
  if (locationIds.length) {
    const placeholders = locationIds.map((_, index) => `?${index + 2}`).join(',');
    const rows = await env.DB.prepare(`SELECT id FROM locations WHERE workspace_id=?1 AND active=1 AND id IN (${placeholders})`).bind(workspaceId, ...locationIds).all<Row>();
    if (rows.results.length !== locationIds.length) return error(request, env, 400, 'One or more selected locations do not exist in this workspace.');
  }
  return { report: firstReport as typeof REPORTS[string], items, locationMode, locationIds };
}

async function executeSchedule(request: Request, env: Env, auth: AuthContext, workspaceId: string, rawSchedule: Row, force: boolean, isTest = false) {
  const schedule = mapSchedule(rawSchedule);
  const runId = makeId('rsr');
  const startedAt = nowIso();
  if (!isTest && rawSchedule.id) {
    await withSchedulingWriteRetry(env, () => env.DB.prepare(`INSERT INTO report_schedule_runs (id,schedule_id,workspace_id,started_at,status,created_at) VALUES (?1,?2,?3,?4,'running',?4)`).bind(runId, rawSchedule.id, workspaceId, startedAt).run());
  }
  try {
    const items = await hydrateScheduleItemsForExecution(env, workspaceId, schedule);
    if (!items.length) throw new Error('This schedule does not contain any report views.');
    const locations = await resolveScheduleLocations(env, auth, workspaceId, schedule);
    const allowedLocations = await getUserAllowedLocationIds(env, auth, workspaceId);
    if (allowedLocations !== null && schedule.locationMode !== 'selected') {
      throw new Error('Permission denied: restricted users cannot run an All Locations schedule.');
    }
    for (const location of locations) await assertLocationAccess(env, auth, workspaceId, clean(location.id), 'scheduled_report_run');
    const itemPlans = items.map((item) => ({
      item,
      locations: resolveSavedViewExecutionLocations(item, locations),
    }));
    const outputCount = itemPlans.reduce((total, plan) => total + plan.locations.length, 0);
    if (schedule.format !== 'report_link' && outputCount > 60) throw new Error('This schedule would create more than 60 attachments. Select fewer report views or locations.');
    const tradingDayStartMinutes = await getScheduleTradingDayStartMinutes(env, workspaceId);
    const scheduleRange = resolveScheduledRelativeRange(
      schedule.dateRangeType || 'today',
      schedule.filters || {},
      schedule.timezone,
      new Date(),
      tradingDayStartMinutes,
    );
    if (!isTest && rawSchedule.id) {
      await withSchedulingWriteRetry(env, () => env.DB.prepare(
        `UPDATE report_schedules SET report_items_json=?1,updated_at=?2 WHERE id=?3 AND workspace_id=?4`
      ).bind(JSON.stringify(items), nowIso(), rawSchedule.id, workspaceId).run()).catch((cause) => {
        console.error('Could not refresh scheduled saved-view snapshots before execution', cause);
      });
    }
    const outputs: Row[] = [];
    let sourceSequence = 0;

    for (let itemIndex = 0; itemIndex < itemPlans.length; itemIndex += 1) {
      const { item, locations: itemLocations } = itemPlans[itemIndex];
      const reportId = clean(item.reportId);
      const viewId = clean(item.viewId);
      const itemFilters = { ...(item.filters || {}) } as Row;
      const sort = item.sort || null;
      const visibleColumns = item.visibleColumns || [];
      const isSavedViewItem = Boolean(clean(item.savedViewSnapshotId || item.savedViewId));
      const itemDateRangeType = validateDateRangeType(clean(
        isSavedViewItem
          ? item.dateRangeType || itemFilters.dateRangeType || schedule.dateRangeType || 'custom'
          : schedule.dateRangeType || item.dateRangeType || itemFilters.dateRangeType || 'today'
      ));
      const itemRange = isSavedViewItem
        ? resolveScheduledRelativeRange(itemDateRangeType, itemFilters, schedule.timezone, new Date(), tradingDayStartMinutes)
        : scheduleRange;
      validateReport(reportId, viewId);

      for (const location of itemLocations) {
        const filters = normalizeScheduledReportFilters({
          reportId,
          scheduleFilters: schedule.filters || {},
          itemFilters,
          range: itemRange,
          dateRangeType: itemDateRangeType,
          location: location as any
        }) as Row;
        sourceSequence += 1;
        const payload = await fetchCanonicalReport(
          request,
          env,
          auth,
          workspaceId,
          reportId,
          viewId,
          filters,
          sort,
          visibleColumns,
          { executionId: runId, sourceSequence: sourceSequence * 100000 }
        );
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const warnings = Array.isArray(payload.allWarnings) ? payload.allWarnings : Array.isArray(payload.warnings) ? payload.warnings : [];
        const totals = summarizeScheduledReportOutput(reportId, rows, payload.totals || {}, payload.meta || {});
        const sourceGeneratedAt = clean(payload.meta?.generatedAt || payload.generatedAt || startedAt);
        outputs.push({
          reportId,
          viewId,
          reportTitle: REPORTS[reportId]?.title || payload.title || reportId,
          viewLabel: formatIdentifier(viewId),
          locationId: location.id,
          locationName: location.name || 'All Locations',
          filters,
          payload,
          rows,
          warnings,
          totals,
          sourceGeneratedAt,
          executionId: runId,
          savedViewId: clean(item.savedViewSnapshotId || item.savedViewId),
          savedViewName: clean(item.savedViewSnapshotName),
          savedViewUpdatedAt: clean(item.savedViewUpdatedAt),
          appliedDateRangeType: itemDateRangeType,
          link: buildReportLink(env, reportId, viewId, filters)
        });
      }
    }

    const condition = evaluatePackCondition(schedule.sendCondition || { type: 'always' }, outputs);
    const nextRunAt = schedule.isEnabled ? calculateReportNextRunAt(schedule, new Date()) : null;
    const rowsExported = outputs.reduce((total, output) => total + output.rows.length, 0);
    const manifest = outputs.map((output) => ({
      reportId: output.reportId,
      viewId: output.viewId,
      locationId: output.locationId,
      locationName: output.locationName,
      rows: output.rows.length,
      link: output.link,
      format: schedule.format,
      sourceGeneratedAt: output.sourceGeneratedAt,
      executionId: runId
    }));
    const dataRefreshedAt = latestSourceGeneratedAt(outputs, startedAt);
    if (!condition.send && !isTest) {
      if (rawSchedule.id) {
        await withSchedulingWriteRetry(env, () => env.DB.prepare(`UPDATE report_schedules SET last_run_at=?1,next_run_at=?2,updated_at=?1 WHERE id=?3 AND workspace_id=?4`).bind(startedAt, nextRunAt, rawSchedule.id, workspaceId).run());
        await withSchedulingWriteRetry(env, () => env.DB.prepare(`UPDATE report_schedule_runs SET finished_at=?1,status='skipped',rows_exported=?2,reports_generated=?3,files_generated=0,output_manifest_json=?4,email_sent=0,error_message=?5 WHERE id=?6`).bind(nowIso(), rowsExported, outputs.length, JSON.stringify(manifest), condition.reason, runId).run());
      }
      return { ok: true, sent: false, message: condition.reason, rowsExported, reportsGenerated: outputs.length, filesGenerated: 0, executionId: runId, dataRefreshedAt };
    }

    const workspace = await env.CENTRAL_DB.prepare(`SELECT name FROM workspaces WHERE id=?1 LIMIT 1`).bind(workspaceId).first<Row>();
    const workspaceName = clean(workspace?.name || workspaceId);
    const email = buildReportPackEmail({ schedule, workspaceName, range: scheduleRange, generatedAt: startedAt, outputs, rowsExported, isTest });
    const attachments = await buildScheduledAttachments(schedule.format, outputs);
    const totalAttachmentBytes = attachments.reduce((total, attachment) => total + attachmentSize(attachment.content), 0);
    if (totalAttachmentBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
      throw new Error(`Scheduled report attachments are ${formatBytes(totalAttachmentBytes)}, which exceeds the ${formatBytes(MAX_EMAIL_ATTACHMENT_BYTES)} email limit. Reduce the report views, locations, or date range.`);
    }
    const config = await getEmailDeliveryConfig({ ...env, DB: env.CENTRAL_DB } as Env);
    const sendResult = await sendEmail(env, config, { to: schedule.recipients, subject: email.subject, text: email.text, html: email.html, attachments });
    if (!sendResult.sent) throw new Error(sendResult.reason || 'Email provider did not send the report.');
    const persistenceWarnings: string[] = [];
    if (!isTest && rawSchedule.id) {
      try {
        await withSchedulingWriteRetry(env, () => env.DB.prepare(`UPDATE report_schedules SET last_run_at=?1,next_run_at=?2,updated_at=?1 WHERE id=?3 AND workspace_id=?4`).bind(startedAt, nextRunAt, rawSchedule.id, workspaceId).run());
      } catch (cause) {
        let paused = false;
        try {
          await withSchedulingWriteRetry(env, () => env.DB.prepare(`UPDATE report_schedules SET is_enabled=0,next_run_at=NULL,updated_at=?1 WHERE id=?2 AND workspace_id=?3`).bind(nowIso(), rawSchedule.id, workspaceId).run());
          paused = true;
        } catch (pauseCause) {
          console.error('Scheduled report delivery succeeded but the schedule could not be paused after persistence failure', pauseCause);
        }
        persistenceWarnings.push(paused
          ? 'The email was sent, but the next-run timestamp could not be saved, so this schedule was paused to prevent a duplicate delivery.'
          : 'The email was sent, but the next-run timestamp could not be saved. Disable or review this schedule before running it again.');
        console.error('Scheduled report delivery succeeded but schedule state persistence failed', cause);
      }
      try {
        await withSchedulingWriteRetry(env, () => env.DB.prepare(`UPDATE report_schedule_runs SET finished_at=?1,status='completed',rows_exported=?2,reports_generated=?3,files_generated=?4,output_manifest_json=?5,email_sent=1,error_message=NULL WHERE id=?6`).bind(nowIso(), rowsExported, outputs.length, attachments.length, JSON.stringify(manifest), runId).run());
      } catch (cause) {
        persistenceWarnings.push('The email was sent, but its run-history record could not be finalised. Do not run it again solely because the history is missing.');
        console.error('Scheduled report delivery succeeded but run history persistence failed', cause);
      }
    }
    return {
      ok: true,
      sent: true,
      rowsExported,
      reportsGenerated: outputs.length,
      filesGenerated: attachments.length,
      nextRunAt,
      executionId: runId,
      dataRefreshedAt,
      warning: persistenceWarnings.join(' ')
    };
  } catch (cause) {
    if (!isTest && rawSchedule.id) {
      const failedSchedule = mapSchedule(rawSchedule);
      const nextRunAt = failedSchedule.isEnabled ? calculateReportNextRunAt(failedSchedule, new Date()) : null;
      await withSchedulingWriteRetry(env, () => env.DB.prepare(`UPDATE report_schedules SET last_run_at=?1,next_run_at=?2,updated_at=?1 WHERE id=?3 AND workspace_id=?4`).bind(startedAt, nextRunAt, rawSchedule.id, workspaceId).run()).catch(() => null);
      await withSchedulingWriteRetry(env, () => env.DB.prepare(`UPDATE report_schedule_runs SET finished_at=?1,status='failed',error_message=?2,email_sent=0 WHERE id=?3`).bind(nowIso(), clean((cause as Error).message), runId).run()).catch(() => null);
    }
    throw cause;
  }
}

async function resolveScheduleLocations(env: Env, auth: AuthContext, workspaceId: string, schedule: Row) {
  const allActive = await listActiveScheduleLocations(env, workspaceId);
  const allowedIds = await getUserAllowedLocationIds(env, auth, workspaceId);
  const active = allowedIds === null ? allActive : allActive.filter((location) => allowedIds.includes(location.id));
  if (schedule.locationMode === 'selected') {
    const selected = new Set((schedule.locationIds || []).map((value: unknown) => clean(value)).filter(Boolean));
    const matches = active.filter((location) => selected.has(location.id));
    if (!matches.length) throw new Error('The selected schedule location is no longer active or is outside your permitted location access. Edit the schedule before sending it.');
    return matches;
  }
  return active.length ? active : [{ id: '', name: 'All Locations' }];
}

function resolveSavedViewExecutionLocations(item: ScheduleReportItem, scheduleLocations: Array<{ id: string; name: string }>) {
  const savedViewId = clean(item.savedViewSnapshotId || item.savedViewId);
  if (!savedViewId) return scheduleLocations;
  const requested = extractSavedViewLocationFilters(item.filters || {});
  if (!requested.length) return scheduleLocations;
  const requestedKeys = new Set(requested.map(normalizeLocationIdentity).filter(Boolean));
  const matches = scheduleLocations.filter((location) =>
    requestedKeys.has(normalizeLocationIdentity(location.id)) ||
    requestedKeys.has(normalizeLocationIdentity(location.name))
  );
  if (!matches.length) {
    throw new Error(`Saved view ${clean(item.savedViewSnapshotName || savedViewId)} is filtered to a location outside this schedule's permitted location selection.`);
  }
  return matches;
}

function extractSavedViewLocationFilters(filters: Row) {
  const values = [
    filters.locationId,
    filters.locationName,
    filters.locationIds,
    filters.locations,
    filters.location_id,
    filters.location_ids,
  ];
  return Array.from(new Set(values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    return clean(value).split(',');
  }).map((value) => clean(value)).filter((value) => value && value.toLowerCase() !== 'all')));
}

function evaluatePackCondition(condition: Row, outputs: Row[]) {
  const type = clean(condition.type || 'always');
  if (type === 'always') return { send: true, reason: '' };
  const checks = outputs.map((output) => evaluateCondition(output.reportId, condition, output.rows, output.warnings, output.totals));
  const match = checks.find((entry) => entry.send);
  return match || checks[0] || { send: false, reason: 'No report output met the configured send condition.' };
}

async function fetchCanonicalReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  reportId: string,
  viewId: string,
  filters: Row,
  sort: Row | null = null,
  visibleColumns: string[] = [],
  freshness: Row = {}
) {
  validateReport(reportId, viewId);
  let sourceFetchSequence = Number(freshness.sourceSequence || 0);
  const callRoute = async (sourceKey: string, handler: (...args: any[]) => Promise<Response>, args: any[] = []) => {
    const baseQuery: Row = {};
    for (const [key, value] of Object.entries(filters)) {
      const queryValue = reportFilterQueryValue(value);
      if (!queryValue) continue;
      baseQuery[key === 'startDate' ? 'from' : key === 'endDate' ? 'to' : key] = queryValue;
    }

    return collectCompleteReportPages({
      resource: sourceKey,
      baseQuery,
      fetchPage: async (query: Row) => {
        const url = new URL(request.url);
        url.pathname = `/api/workspaces/${workspaceId}/reports/scheduled-source`;
        url.search = '';
        for (const [key, value] of Object.entries(query || {})) {
          const queryValue = reportFilterQueryValue(value);
          if (!queryValue) continue;
          url.searchParams.set(key, queryValue);
        }
        sourceFetchSequence += 1;
        const offset = Number(query?.offset || 0);
        const freshUrl = addScheduledSourceCacheBuster(url, clean(freshness.executionId), sourceFetchSequence, offset);
        const sourceHeaders = buildScheduledSourceHeaders(request.headers, clean(freshness.executionId), sourceFetchSequence);
        const sourceRequest = new Request(freshUrl.toString(), { method: 'GET', headers: sourceHeaders });
        const response = await handler(sourceRequest, env, auth, workspaceId, ...args);
        if (!response.ok) throw new Error(`Report runner returned ${response.status}.`);
        return await response.json() as Row;
      }
    }) as Row;
  };

  const services = {
    reporting: {
      getDetailedActivityLedger: () => callRoute('detailed-activity', getDetailedActivityReport),
      getStockTakeAuditRows: () => callRoute('stock-take-audit', getStockTakeAuditReport),
      getSalesFinancialRows: () => callRoute('sales-financial', getSalesFinancialReport),
      getSaleStockUsageRows: () => callRoute('sale-stock-usage', getSaleStockUsageReport, ['all']),
      getModifierSalesRows: () => callRoute('modifier-sales', getModifierSalesReport),
      getMenuRecipeHealthRows: () => callRoute('menu-recipe-health', getMenuRecipeHealthReport),
      getStockControlRows: () => callRoute('stock-control', getStockControlReport),
      getStockOnHandRows: () => callRoute('stock-on-hand', getStockOnHandReport),
      getPurchaseOrderReportRows: () => callRoute('purchase-orders', getPurchaseOrdersReport),
      getGrvLogRows: () => callRoute('grv-log', getGrvLogReport),
      getCreditNoteReportRows: () => callRoute('credit-notes', getCreditNotesReport),
      getManufacturingTransactionRows: () => callRoute('manufacturing-transactions', getManufacturingTransactionsReport),
      getStockTransferTransactionRows: () => callRoute('stock-transfer-transactions', getStockTransferTransactionsReport),
      getInventoryAuditRows: () => callRoute('inventory-audit', getInventoryAuditReport)
    }
  };

  const result = await runReport(reportId, {
    workspaceId,
    filters,
    view: viewId,
    sort,
    services,
    dataSet: {}
  }) as Row;
  const requested = new Set((visibleColumns || []).map((value) => clean(value)).filter(Boolean));
  if (requested.size) result.columns = (result.columns || []).filter((column: Row) => requested.has(clean(column.key)));
  return result;
}

const MAX_EMAIL_ATTACHMENT_BYTES = 17 * 1024 * 1024;

type ScheduledAttachment = {
  filename: string;
  content: string | Uint8Array | ArrayBuffer;
  contentType: string;
};

async function buildScheduledAttachments(format: string, outputs: Row[]): Promise<ScheduledAttachment[]> {
  const normalized = clean(format || 'report_link').toLowerCase();
  if (normalized === 'report_link') return [];
  if (!['csv', 'xlsx', 'pdf'].includes(normalized)) throw new Error('Unsupported scheduled report attachment format.');
  if (normalized === 'csv') return outputs.map((output) => buildCsvAttachment(output.payload, output));

  const groups = groupScheduledOutputsByReport(outputs);
  const attachments: ScheduledAttachment[] = [];
  for (const group of groups) {
    if (normalized === 'xlsx') {
      attachments.push(await buildCombinedXlsxAttachment(group));
      continue;
    }
    attachments.push(await buildCombinedPdfAttachment(group));
  }
  return attachments;
}

function groupScheduledOutputsByReport(outputs: Row[]) {
  const grouped = new Map<string, Row[]>();
  for (const output of outputs) {
    const key = `${clean(output.reportId)}::${clean(output.locationId || output.locationName)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(output);
  }
  return [...grouped.values()];
}

function attachmentBaseName(result: Row, output: Row = {}, { includeView = true } = {}) {
  const reportId = clean(output.reportId || result.id || result.report?.id);
  const reportName = result.title || result.report?.title || REPORTS[reportId]?.title || reportId;
  const suffix = [includeView ? formatIdentifier(output.viewId) : '', clean(output.locationName)].filter(Boolean).join('-');
  const date = clean(output.filters?.to || output.filters?.endDate || result.filters?.to || result.filters?.endDate || new Date().toISOString().slice(0, 10));
  return `${safeFileName(`${reportName}-${suffix}`)}-${safeFileName(date)}`;
}

function buildCsvAttachment(result: Row, output: Row = {}): ScheduledAttachment {
  return {
    filename: `${attachmentBaseName(result, output)}.csv`,
    content: reportToCsv(result, { formatted: true }),
    contentType: 'text/csv; charset=utf-8'
  };
}

async function buildXlsxAttachment(result: Row, output: Row = {}): Promise<ScheduledAttachment> {
  return {
    filename: `${attachmentBaseName(result, output)}.xlsx`,
    content: await reportToExcelBytes(result, { formatted: true }),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

async function buildPdfAttachment(result: Row, output: Row = {}): Promise<ScheduledAttachment> {
  return {
    filename: `${attachmentBaseName(result, output)}.pdf`,
    content: await reportToPdfBytes(result, { formatted: true }),
    contentType: 'application/pdf'
  };
}

function outputPayloadForCombinedAttachment(output: Row) {
  return {
    ...(output.payload || {}),
    title: clean(output.reportTitle || output.payload?.title || output.payload?.report?.title),
    view: clean(output.viewId || output.payload?.view),
    filters: output.filters || output.payload?.filters || {},
    meta: {
      ...(output.payload?.meta || {}),
      locationId: clean(output.locationId),
      locationName: clean(output.locationName),
      generatedAt: clean(output.sourceGeneratedAt || output.payload?.meta?.generatedAt)
    }
  };
}

async function buildCombinedXlsxAttachment(outputs: Row[]): Promise<ScheduledAttachment> {
  const first = outputs[0] || {};
  const payloads = outputs.map(outputPayloadForCombinedAttachment);
  return {
    filename: `${attachmentBaseName(first.payload || {}, first, { includeView: false })}.xlsx`,
    content: await reportResultsToExcelBytes(payloads, { formatted: true }),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

async function buildCombinedPdfAttachment(outputs: Row[]): Promise<ScheduledAttachment> {
  const first = outputs[0] || {};
  const payloads = outputs.map(outputPayloadForCombinedAttachment);
  return {
    filename: `${attachmentBaseName(first.payload || {}, first, { includeView: false })}.pdf`,
    content: await reportResultsToPdfBytes(payloads, { formatted: true, title: clean(first.reportTitle) }),
    contentType: 'application/pdf'
  };
}

function attachmentSize(content: string | Uint8Array | ArrayBuffer) {
  if (typeof content === 'string') return new TextEncoder().encode(content).byteLength;
  if (content instanceof Uint8Array) return content.byteLength;
  return content.byteLength;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatIdentifier(value: unknown) {
  return clean(value).split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function evaluateCondition(reportId: string, condition: Row, rows: Row[], warnings: Row[], totals: Row) {
  const type = clean(condition.type || 'always');
  if (type === 'always') return { send: true, reason: '' };
  if (type === 'only_if_data') return { send: rows.length > 0, reason: 'No data exists for this reporting period.' };
  if (type === 'only_if_critical_warnings') return {
    send: Number(totals.criticalWarnings || totals.critical || 0) > 0 || warnings.some((warning) => {
      const severity = clean(warning?.severity || warning?.level || warning?.type || warning?.status).toLowerCase();
      return ['critical', 'error', 'high'].includes(severity) || clean(warning?.message || warning?.title || warning).toLowerCase().includes('critical');
    }),
    reason: 'No critical warnings exist.'
  };
  if (type === 'only_if_low_stock') return { send: Number(totals.lowStockCount) > 0, reason: 'No critical or low-stock items exist.' };
  if (type === 'only_if_wastage_threshold') return { send: Number(totals.totalWastage) > Number(condition.threshold || 0), reason: 'Wastage did not exceed the configured threshold.' };
  if (type === 'only_if_reconciliation_issues') return {
    send: warnings.some((warning) => clean(`${warning?.code || ''} ${warning?.message || ''} ${warning?.title || ''}`).toLowerCase().includes('reconcil')),
    reason: 'No reconciliation issues exist.'
  };
  if (type === 'only_if_high_risk_changes') return { send: Number(totals.highRiskChanges || totals.highRiskActions || 0) > 0 || rows.some((r) => bool(r.highRisk) || ['high', 'critical'].includes(clean(r.riskStatus || r.risk).toLowerCase())), reason: 'No high-risk inventory changes exist.' };
  if (type === 'only_if_sales') return {
    send: Number(totals.totalSales) > 0 || rows.some((row) => Number(row.grossAmount || row.grossSales || row.netSales || row.salesValue || row.quantitySold || row.quantity || 0) > 0),
    reason: 'No sales exist for this period.'
  };
  return { send: true, reason: '' };
}

function buildReportPackEmail(input: { schedule: any; workspaceName: string; range: Row; generatedAt: string; outputs: Row[]; rowsExported: number; isTest: boolean }) {
  const subject = clean(input.schedule.emailSubject) || `Kitchen Cost Pro - ${input.schedule.name || 'Scheduled Report Pack'}`;
  const custom = clean(input.schedule.emailMessage);
  const period = input.schedule.dateRangeType === 'custom'
    ? `${input.range.from || 'All'} to ${input.range.to || 'All'}`
    : formatIdentifier(input.schedule.dateRangeType);
  const uniqueLocations = new Set(input.outputs.map((output) => clean(output.locationName)).filter(Boolean));
  const uniqueReportViews = new Set(input.outputs.map((output) => `${clean(output.reportId)}::${clean(output.viewId)}`).filter((value) => value !== '::'));
  const dataRefreshedAt = latestSourceGeneratedAt(input.outputs, input.generatedAt);
  const refreshedDisplay = formatReportDateTime(dataRefreshedAt, input.schedule.timezone || 'Africa/Johannesburg');
  const keyLines = [
    `Report views: ${uniqueReportViews.size}`,
    `Location outputs: ${input.outputs.length}`,
    `Locations: ${uniqueLocations.size}`,
    `Rows exported: ${input.rowsExported}`,
    `Data refreshed: ${refreshedDisplay} (${input.schedule.timezone || 'Africa/Johannesburg'})`
  ];
  if (input.outputs.length === 1) {
    const totals = input.outputs[0].totals || {};
    if (totals.totalWastage) keyLines.push(`Total Wastage: R${Number(totals.totalWastage).toFixed(2)}`);
    if (totals.totalSales) keyLines.push(`Total Sales: R${Number(totals.totalSales).toFixed(2)}`);
    if (totals.lowStockCount) keyLines.push(`Low Stock Items: ${totals.lowStockCount}`);
  }
  const generatedDisplay = formatReportDateTime(input.generatedAt, input.schedule.timezone || 'Africa/Johannesburg');
  const outputLines = input.outputs.map((output, index) => `${index + 1}. ${output.reportTitle} - ${output.viewLabel} - ${output.locationName}\n   ${output.link}`);
  const textBody = [
    input.isTest ? 'TEST EMAIL' : '',
    'Hi,', '',
    custom || 'Your scheduled report pack is ready.', '',
    `Schedule: ${input.schedule.name || 'Scheduled Report Pack'}`,
    `Workspace: ${input.workspaceName}`,
    `Period: ${period}`,
    `Generated: ${generatedDisplay} (${input.schedule.timezone || 'Africa/Johannesburg'})`,
    `Data refreshed: ${refreshedDisplay} (${input.schedule.timezone || 'Africa/Johannesburg'})`, '',
    'Summary:', ...keyLines, '',
    'Reports:', ...outputLines, '',
    'Regards,', 'Kitchen Cost Pro'
  ].filter(Boolean).join('\n');
  const rows = input.outputs.map((output) => `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtml(output.reportTitle)}</strong><br><span>${escapeHtml(output.viewLabel)}</span></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${escapeHtml(output.locationName)}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(output.rows.length).toLocaleString('en-ZA')}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb"><a href="${escapeHtml(output.link)}">Open report</a></td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;color:#17232d;line-height:1.55;max-width:760px"><h2 style="margin-bottom:6px">${escapeHtml(input.isTest ? `Test: ${input.schedule.name || 'Scheduled Report Pack'}` : input.schedule.name || 'Scheduled Report Pack')}</h2><p>${escapeHtml(custom || 'Your scheduled report pack is ready.')}</p><table style="border-collapse:collapse;width:100%;margin-bottom:18px"><tr><td><strong>Workspace</strong></td><td>${escapeHtml(input.workspaceName)}</td></tr><tr><td><strong>Period</strong></td><td>${escapeHtml(period)}</td></tr><tr><td><strong>Generated</strong></td><td>${escapeHtml(`${generatedDisplay} (${input.schedule.timezone || 'Africa/Johannesburg'})`)}</td></tr><tr><td><strong>Data refreshed</strong></td><td>${escapeHtml(`${refreshedDisplay} (${input.schedule.timezone || 'Africa/Johannesburg'})`)}</td></tr></table><h3>Summary</h3><ul>${keyLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul><h3>Reports</h3><table style="border-collapse:collapse;width:100%"><thead><tr><th style="padding:8px;text-align:left">Report / View</th><th style="padding:8px;text-align:left">Location</th><th style="padding:8px;text-align:right">Rows</th><th style="padding:8px;text-align:left">Link</th></tr></thead><tbody>${rows}</tbody></table><p style="margin-top:20px">Regards,<br>Kitchen Cost Pro</p></div>`;
  return { subject, text: textBody, html };
}

function latestSourceGeneratedAt(outputs: Row[], fallback: string) {
  const timestamps = outputs
    .map((output) => clean(output.sourceGeneratedAt))
    .filter(Boolean)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time);
  return timestamps[0]?.value || fallback;
}

function buildReportLink(env: Env, reportId: string, viewId: string, filters: Row) {
  const base = clean(env.APP_BASE_URL || 'https://app.kitchencostpro.com').replace(/\/+$/, '');
  const url = new URL(base);
  url.searchParams.set('route', 'reporting'); url.searchParams.set('report', reportId); url.searchParams.set('view', viewId);
  for (const [rawKey, rawValue] of Object.entries(filters || {})) {
    const queryValue = reportFilterQueryValue(rawValue);
    if (!queryValue) continue;
    const key = rawKey === 'startDate' ? 'from' : rawKey === 'endDate' ? 'to' : rawKey;
    if (key === 'locationName') continue;
    url.searchParams.set(key, queryValue);
  }
  return url.toString();
}


async function clearDefaultViews(env: Env, workspaceId: string, userId: string, reportId: string, reportGroupId: string, scope: string, excludeId = '') {
  // Defaults are per canonical report. A report group is only navigation metadata; clearing by
  // group made one child report silently remove another child's default.
  const targetSql = `workspace_id=?2 AND report_id=?3`;
  if (scope === 'workspace') {
    await env.DB.prepare(`UPDATE report_saved_views SET is_default=0,updated_at=?1 WHERE ${targetSql} AND scope='workspace' AND id<>?4`).bind(nowIso(), workspaceId, reportId, excludeId).run();
    return;
  }
  await env.DB.prepare(`UPDATE report_saved_views SET is_default=0,updated_at=?1 WHERE ${targetSql} AND scope='personal' AND user_id=?4 AND id<>?5`).bind(nowIso(), workspaceId, reportId, userId, excludeId).run();
}
async function getSavedViewRow(env: Env, workspaceId: string, id: string) { return env.DB.prepare(`SELECT * FROM report_saved_views WHERE id=?1 AND workspace_id=?2 LIMIT 1`).bind(id, workspaceId).first<Row>(); }
async function getScheduleRow(env: Env, workspaceId: string, id: string) { return env.DB.prepare(`SELECT * FROM report_schedules WHERE id=?1 AND workspace_id=?2 LIMIT 1`).bind(id, workspaceId).first<Row>(); }
async function listActiveScheduleLocations(env: Env, workspaceId: string) {
  const rows = await env.DB.prepare(`SELECT id, COALESCE(NULLIF(display_name,''), NULLIF(name,''), NULLIF(external_name,''), id) AS name FROM locations WHERE workspace_id=?1 AND COALESCE(active,1)=1 ORDER BY COALESCE(is_default,0) DESC, lower(COALESCE(NULLIF(display_name,''), NULLIF(name,''), NULLIF(external_name,''), id)) ASC`).bind(workspaceId).all<Row>();
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  return rows.results.map((row) => ({ id: clean(row.id), name: clean(row.name || row.id) })).filter((row) => {
    const idKey = normalizeLocationIdentity(row.id);
    const nameKey = normalizeLocationIdentity(row.name);
    if (!row.id || (idKey && seenIds.has(idKey)) || (nameKey && seenNames.has(nameKey))) return false;
    if (idKey) seenIds.add(idKey);
    if (nameKey) seenNames.add(nameKey);
    return true;
  });
}

function normalizeLocationIdentity(value: unknown) {
  return clean(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
async function listActiveScheduleRecipientUsers(env: Env, workspaceId: string) {
  try {
    const rows = await env.CENTRAL_DB.prepare(
      `SELECT email, COALESCE(NULLIF(display_name,''), email) AS name
         FROM workspace_members
        WHERE workspace_id=?1
          AND lower(COALESCE(status, 'active')) NOT IN ('removed', 'deleted', 'disabled', 'inactive')
          AND email IS NOT NULL
          AND trim(email)<>''
        ORDER BY lower(COALESCE(NULLIF(display_name,''), email)) ASC, lower(email) ASC`
    ).bind(workspaceId).all<Row>();
    const seen = new Set<string>();
    return (rows.results || []).map((row) => ({
      email: clean(row.email),
      name: clean(row.name || row.email)
    })).filter((user) => {
      const key = user.email.toLowerCase();
      if (!EMAIL_RE.test(user.email) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}
function enrichScheduleLocations(schedule: Row, activeLocations: Array<{ id: string; name: string }>) {
  const byId = new Map(activeLocations.map((location) => [location.id, location.name]));
  const selectedIds = Array.isArray(schedule.locationIds) ? schedule.locationIds.map((value: unknown) => clean(value)).filter(Boolean) : [];
  const locations = schedule.locationMode === 'selected'
    ? selectedIds.map((id) => ({ id, name: byId.get(id) || id }))
    : activeLocations;
  return {
    ...schedule,
    locations,
    locationNames: locations.map((location) => location.name)
  };
}
function scheduleExecutionMessage(cause: unknown, fallback: string) {
  const raw = clean((cause as Error)?.message || cause);
  const message = raw.toLowerCase();
  if (/sqlite_constraint|check constraint failed|foreign key constraint/.test(message)) {
    return 'Report scheduling storage rejected the run-history update. Deploy the latest Worker before running this schedule again.';
  }
  if (/no such column|has no column named|no such table|schema repair incomplete/.test(message)) {
    return 'Report scheduling storage is not fully upgraded for this workspace. Deploy the latest Worker and retry once.';
  }
  return raw || fallback;
}

function savedViewLocationIds(input: Row): string[] {
  const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
  const raw = [
    input.locationId,
    filters.locationId,
    ...(Array.isArray(filters.locationIds) ? filters.locationIds : []),
  ];
  return Array.from(new Set(raw.map((value) => clean(value)).filter(Boolean)));
}

function scopeSavedViewForLocations(view: Row, allowedLocationIds: string[] | null): Row | null {
  if (allowedLocationIds === null) return view;
  if (!allowedLocationIds.length) return null;
  const requested = savedViewLocationIds(view);
  if (requested.some((id) => !allowedLocationIds.includes(id))) return null;
  if (requested.length) return view;
  const filters = { ...(view.filters || {}), locationIds: [...allowedLocationIds] };
  if (allowedLocationIds.length === 1) filters.locationId = allowedLocationIds[0];
  return { ...view, filters, locationId: allowedLocationIds.length === 1 ? allowedLocationIds[0] : '' };
}

function savedViewPersistenceMessage(cause: unknown) {
  const message = clean((cause as Error)?.message || cause).toLowerCase();
  if (/no such column|has no column named|no such table|duplicate column|schema repair incomplete/.test(message)) {
    return 'Saved-view storage repair failed after an automatic retry. The view was not saved; deploy this Worker build and retry.';
  }
  if (/constraint|foreign key/.test(message)) return 'The saved view could not be stored because the reporting schema migration is incomplete.';
  return clean((cause as Error)?.message) || 'Could not save the report view.';
}

function schedulePersistenceMessage(cause: unknown) {
  const message = clean((cause as Error)?.message || cause).toLowerCase();
  if (/no such column|has no column named|no such table|duplicate column|schema repair incomplete/.test(message)) {
    return 'Report scheduling storage repair failed after an automatic retry. The schedule was not saved; deploy this Worker build and try again.';
  }
  if (/constraint|foreign key/.test(message)) return 'The schedule could not be saved because the scheduling schema migration is incomplete. Deploy Worker 33.18 and retry once.';
  return 'Could not save the report schedule. The schedule was not partially created.';
}
function mapSavedView(row: Row) { return { id: clean(row.id), workspaceId: clean(row.workspace_id), userId: clean(row.user_id), name: clean(row.name), description: clean(row.description), scope: clean(row.scope || 'personal'), reportGroupId: clean(row.report_group_id), reportId: clean(row.report_id), viewId: clean(row.view_id), filters: parseJson<Row>(row.filters_json, {}), sort: parseJson<Row | null>(row.sort_json, null), visibleColumns: parseJson<string[]>(row.visible_columns_json, []), dateRangeType: clean(row.date_range_type || 'custom'), locationId: clean(row.location_id), isDefault: bool(row.is_default), createdAt: clean(row.created_at), updatedAt: clean(row.updated_at) }; }
function mapSavedViewForClient(row: Row) {
  const saved = mapSavedView(row);
  const resolved = resolveScheduleReportSelection(saved.reportId, saved.viewId);
  if (!resolved) return { ...saved, isAvailable: false };
  return {
    ...saved,
    originalReportId: saved.reportId,
    originalViewId: saved.viewId,
    reportGroupId: saved.reportGroupId || REPORTS[resolved.reportId]?.groupId || '',
    reportId: resolved.reportId,
    viewId: resolved.viewId,
    isAvailable: true
  };
}
async function getScheduleTradingDayStartMinutes(env: Env, workspaceId: string) {
  try {
    const row = await env.DB.prepare(
      `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
    ).bind(workspaceId).first<Row>();
    return normalizeTradingDayStartMinutes(parseJson<Row>(row?.raw_json, {}) as any);
  } catch {
    return 0;
  }
}

function mapSchedule(row: Row) {
  const fallbackItems = clean(row.report_id || row.reportId) && clean(row.view_id || row.viewId)
    ? [{ reportGroupId: clean(row.report_group_id || row.reportGroupId), reportId: clean(row.report_id || row.reportId), viewId: clean(row.view_id || row.viewId) }]
    : [];
  const reportItems = parseJson<ScheduleReportItem[]>(row.report_items_json, row.reportItems || fallbackItems);
  const normalizedItems = normalizeScheduleItems({ ...row, reportItems }).map(({ savedViewId: _savedViewId, ...snapshot }) => snapshot);
  const locationIds = parseJson<string[]>(row.location_ids_json, row.locationIds || (clean(row.location_id || row.locationId) ? [clean(row.location_id || row.locationId)] : []));
  return {
    id: clean(row.id), workspaceId: clean(row.workspace_id), createdBy: clean(row.created_by), name: clean(row.name),
    reportGroupId: clean(row.report_group_id), reportId: clean(row.report_id), viewId: clean(row.view_id),
    reportItems: normalizedItems, filters: parseJson<Row>(row.filters_json, row.filters || {}),
    dateRangeType: clean(row.date_range_type || row.dateRangeType || 'today'), locationId: clean(row.location_id || row.locationId),
    locationMode: clean(row.location_mode || row.locationMode).toLowerCase() === 'selected' || locationIds.length ? 'selected' : 'all', locationIds: Array.from(new Set(locationIds.map((value) => clean(value)).filter(Boolean))),
    scheduleFrequency: clean(row.schedule_frequency || row.scheduleFrequency), scheduleDay: row.schedule_day ?? row.scheduleDay ?? null,
    scheduleTime: clean(row.schedule_time || row.scheduleTime), timezone: clean(row.timezone),
    format: normalizeScheduleExportFormat(row.format),
    recipients: parseJson<string[]>(row.recipients_json, row.recipients || []), emailSubject: clean(row.email_subject || row.emailSubject),
    emailMessage: clean(row.email_message || row.emailMessage), sendCondition: parseJson<Row>(row.send_condition_json, row.sendCondition || { type: 'always' }),
    isEnabled: bool(row.is_enabled ?? row.isEnabled), lastRunAt: clean(row.last_run_at || row.lastRunAt), nextRunAt: clean(row.next_run_at || row.nextRunAt),
    createdAt: clean(row.created_at), updatedAt: clean(row.updated_at)
  };
}

function inputToScheduleRow(body: ScheduleInput, workspaceId: string, uid: string) {
  const items = normalizeScheduleItems(body);
  const first = items[0] || {};
  const locationMode = normalizeLocationMode(body.locationMode);
  const locationIds = normalizeLocationIds(body);
  return {
    id: '', workspace_id: workspaceId, created_by: uid, name: body.name,
    report_group_id: first.reportGroupId || body.reportGroupId, report_id: first.reportId || body.reportId, view_id: first.viewId || body.viewId,
    report_items_json: JSON.stringify(items.map(({ savedViewId: _savedViewId, ...snapshot }) => snapshot)), filters_json: JSON.stringify(body.filters || {}),
    date_range_type: body.dateRangeType, location_id: locationMode === 'selected' && locationIds.length === 1 ? locationIds[0] : '',
    location_mode: locationMode, location_ids_json: JSON.stringify(locationIds), schedule_frequency: body.scheduleFrequency,
    schedule_day: body.scheduleDay, schedule_time: body.scheduleTime, timezone: body.timezone,
    format: normalizeScheduleExportFormat(body.format),
    recipients_json: JSON.stringify(body.recipients || []), email_subject: body.emailSubject, email_message: body.emailMessage,
    send_condition_json: JSON.stringify(body.sendCondition || { type: 'always' }), is_enabled: body.isEnabled === false ? 0 : 1
  };
}
