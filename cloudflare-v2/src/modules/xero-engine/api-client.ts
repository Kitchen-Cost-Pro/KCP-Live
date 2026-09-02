import type { Env } from '../../legacy/types';
import { text, xeroApiBaseUrl } from './config';
import { loadValidXeroAccessToken } from './connection';
import { reserveXeroApiCall } from './rate-limit';
import { recordXeroDiagnosticIfNotable } from './observability';

export type XeroApiErrorCategory = 'RATE_LIMITED' | 'UNAUTHORIZED' | 'RETRYABLE_SERVER_ERROR' | 'NON_RETRYABLE_CLIENT_ERROR' | 'NETWORK_ERROR';

export class XeroApiClientError extends Error {
  readonly category: XeroApiErrorCategory;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, category: XeroApiErrorCategory, status?: number) {
    super(message);
    this.name = 'XeroApiClientError';
    this.category = category;
    this.retryable = category === 'RATE_LIMITED' || category === 'RETRYABLE_SERVER_ERROR';
    this.status = status;
  }
}

function classify(status: number): XeroApiErrorCategory {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status >= 500) return 'RETRYABLE_SERVER_ERROR';
  return 'NON_RETRYABLE_CLIENT_ERROR';
}

interface XeroValidationError {
  Message?: string;
}
interface XeroLineItemElement {
  Description?: string;
  ValidationErrors?: XeroValidationError[];
}
interface XeroResponseElement {
  ValidationErrors?: XeroValidationError[];
  LineItems?: XeroLineItemElement[];
}

/**
 * A Xero ValidationException's top-level `Message` is always the same generic
 * "A validation exception occurred" — completely uninformative on its own (this is exactly what
 * surfaced as a GRV push failure with no way to tell what was actually wrong with the Bill
 * payload). The real detail lives per-element and per-line-item in `Elements[].ValidationErrors`
 * and `Elements[].LineItems[].ValidationErrors`, which every call site was silently discarding.
 */
function extractXeroValidationErrors(bodyJson: Record<string, unknown>): string[] {
  const elements = Array.isArray(bodyJson.Elements) ? (bodyJson.Elements as XeroResponseElement[]) : [];
  const messages: string[] = [];
  for (const element of elements) {
    for (const err of element.ValidationErrors || []) {
      const message = text(err?.Message);
      if (message) messages.push(message);
    }
    for (const line of element.LineItems || []) {
      for (const err of line.ValidationErrors || []) {
        const message = text(err?.Message);
        if (!message) continue;
        const description = text(line.Description);
        messages.push(description ? `${description}: ${message}` : message);
      }
    }
  }
  return [...new Set(messages)];
}

function describeXeroErrorResponse(bodyJson: Record<string, unknown>, fallback: string): string {
  const validationErrors = extractXeroValidationErrors(bodyJson);
  if (validationErrors.length) return validationErrors.join('; ');
  return text(
    (bodyJson as { Message?: string; Detail?: string }).Message ||
      (bodyJson as { Message?: string; Detail?: string }).Detail ||
      fallback
  );
}

/**
 * Single choke point for every outbound Xero Accounting API call, mirroring the shape of
 * modules/yoco-engine-v2/api-client.ts's executeYocoV2ApiRequest — token load/refresh, a rate
 * check, the actual fetch, response classification, and diagnostic logging on failure — just
 * without a dedicated rate-gate Durable Object (see rate-limit.ts for why that's not needed here).
 */
export async function executeXeroApiRequest(
  env: Env,
  workspaceId: string,
  input: { method: 'GET' | 'POST' | 'PUT'; path: string; body?: unknown }
): Promise<Record<string, unknown>> {
  const reservation = await reserveXeroApiCall(env, workspaceId);
  if (!reservation.allowed) {
    throw new XeroApiClientError(reservation.reason || 'Xero API rate limit reached.', 'RATE_LIMITED');
  }
  const { accessToken, xeroTenantId } = await loadValidXeroAccessToken(env, workspaceId);
  if (!xeroTenantId) throw new XeroApiClientError('This workspace\'s Xero connection has no organisation selected.', 'NON_RETRYABLE_CLIENT_ERROR');

  const url = `${xeroApiBaseUrl(env)}/api.xro/2.0/${input.path.replace(/^\/+/, '')}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'xero-tenant-id': xeroTenantId,
        accept: 'application/json',
        ...(input.body ? { 'content-type': 'application/json' } : {})
      },
      body: input.body ? JSON.stringify(input.body) : undefined
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Network error calling Xero.';
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: `xero-api:${input.path}`, status: 'failed', message });
    throw new XeroApiClientError(message, 'NETWORK_ERROR');
  }

  const bodyJson = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const category = classify(response.status);
    const message = describeXeroErrorResponse(bodyJson, `Xero API returned HTTP ${response.status} for ${input.path}.`);
    await recordXeroDiagnosticIfNotable(env, workspaceId, {
      operation: `xero-api:${input.path}`,
      status: category === 'RATE_LIMITED' ? 'warning' : 'failed',
      message,
      details: { status: response.status, path: input.path }
    });
    throw new XeroApiClientError(message, category, response.status);
  }
  return bodyJson;
}

export interface XeroTaxRateSummary {
  name: string;
  taxType: string;
  status: string;
  canApplyToExpenses: boolean;
  canApplyToRevenue: boolean;
}

/**
 * Xero's `TaxType` codes (e.g. `INPUT2`) are never shown in the Chart of Accounts UI — only the
 * friendly Name is ("Standard Rate Purchases (15%)") — so there was previously no way to see,
 * from inside KCP, which literal code to type into the settings form, or whether it was Active in
 * this specific organisation. This is exactly what caused a live outage: `INPUT2` looked like the
 * right code (it's a standard South Africa default) but was Archived for this org, and Xero's
 * error ("Tax rate must be Active") gave no indication of what a valid replacement would be. Used
 * to populate a real dropdown instead of a free-text field a person has to guess at.
 *
 * `canApplyToRevenue`/`canApplyToExpenses` come straight from Xero's own per-rate flags — a rate
 * scoped to expenses only (e.g. a "...Purchases" rate) is REJECTED by Xero if used on a revenue
 * account, and vice versa ("The TaxType code 'X' cannot be used with account code 'Y'" — a real
 * production failure this exact confusion caused: a purchases rate had been picked for the Sales
 * tab's tax type, which the old undifferentiated dropdown never prevented). Callers filter the
 * Sales tab's picker to `canApplyToRevenue` rates and the Purchases tab's to `canApplyToExpenses`
 * ones, same reasoning as never trusting a typed/guessed value.
 */
export async function fetchXeroTaxRates(env: Env, workspaceId: string): Promise<XeroTaxRateSummary[]> {
  const result = await executeXeroApiRequest(env, workspaceId, { method: 'GET', path: 'TaxRates' });
  const rates = (result.TaxRates as
    | Array<{ Name?: string; TaxType?: string; Status?: string; CanApplyToExpenses?: boolean; CanApplyToRevenue?: boolean }>
    | undefined) || [];
  return rates
    .map((rate) => ({
      name: text(rate.Name),
      taxType: text(rate.TaxType),
      status: text(rate.Status) || 'UNKNOWN',
      canApplyToExpenses: rate.CanApplyToExpenses !== false,
      canApplyToRevenue: rate.CanApplyToRevenue !== false
    }))
    .filter((rate) => rate.taxType);
}

export interface XeroTrackingOptionSummary {
  id: string;
  name: string;
  status: string;
}

export interface XeroTrackingCategorySummary {
  id: string;
  name: string;
  status: string;
  options: XeroTrackingOptionSummary[];
}

/**
 * Xero organisations have AT MOST 2 Tracking Categories (a hard platform limit, not
 * KCP-configurable), and their Options must already exist in Xero — the API has no "create an
 * option on the fly while pushing a document" path; an unrecognised Name/Option pair on a
 * LineItem is silently DROPPED, not rejected, so guessing at option IDs is worse than useless.
 * This mirrors `fetchXeroTaxRates`'s reasoning exactly: surface the REAL categories/options so KCP
 * can pick one via a dropdown and match by real ID, never a typed string.
 */
export async function fetchXeroTrackingCategories(env: Env, workspaceId: string): Promise<XeroTrackingCategorySummary[]> {
  const result = await executeXeroApiRequest(env, workspaceId, { method: 'GET', path: 'TrackingCategories' });
  const categories = (result.TrackingCategories as
    | Array<{ TrackingCategoryID?: string; Name?: string; Status?: string; Options?: Array<{ TrackingOptionID?: string; Name?: string; Status?: string }> }>
    | undefined) || [];
  return categories
    .map((category) => ({
      id: text(category.TrackingCategoryID),
      name: text(category.Name),
      status: text(category.Status) || 'UNKNOWN',
      options: (category.Options || [])
        .map((option) => ({ id: text(option.TrackingOptionID), name: text(option.Name), status: text(option.Status) || 'UNKNOWN' }))
        .filter((option) => option.id)
    }))
    .filter((category) => category.id);
}

/**
 * Attachment upload — Xero's `PUT /Invoices/{InvoiceID}/Attachments/{FileName}` (used for Bills
 * too, since a Bill is just an Invoice with Type ACCPAY) takes the raw file bytes as the body with
 * a real Content-Type, not a JSON envelope, so this can't share executeXeroApiRequest's
 * JSON.stringify/parse — everything else (token load/refresh, rate reservation, error
 * classification, diagnostic logging) is identical, so it's kept alongside that function rather
 * than in its own file.
 */
export async function executeXeroBinaryPutRequest(
  env: Env,
  workspaceId: string,
  input: { invoiceId: string; fileName: string; bytes: Uint8Array; contentType: string }
): Promise<Record<string, unknown>> {
  const reservation = await reserveXeroApiCall(env, workspaceId);
  if (!reservation.allowed) {
    throw new XeroApiClientError(reservation.reason || 'Xero API rate limit reached.', 'RATE_LIMITED');
  }
  const { accessToken, xeroTenantId } = await loadValidXeroAccessToken(env, workspaceId);
  if (!xeroTenantId) throw new XeroApiClientError('This workspace\'s Xero connection has no organisation selected.', 'NON_RETRYABLE_CLIENT_ERROR');

  const path = `Invoices/${encodeURIComponent(input.invoiceId)}/Attachments/${encodeURIComponent(input.fileName)}`;
  const url = `${xeroApiBaseUrl(env)}/api.xro/2.0/${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'xero-tenant-id': xeroTenantId,
        accept: 'application/json',
        'content-type': input.contentType
      },
      body: input.bytes.slice().buffer
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Network error calling Xero.';
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: `xero-api:${path}`, status: 'failed', message });
    throw new XeroApiClientError(message, 'NETWORK_ERROR');
  }

  const bodyJson = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const category = classify(response.status);
    const message = describeXeroErrorResponse(bodyJson, `Xero API returned HTTP ${response.status} for ${path}.`);
    await recordXeroDiagnosticIfNotable(env, workspaceId, {
      operation: `xero-api:${path}`,
      status: category === 'RATE_LIMITED' ? 'warning' : 'failed',
      message,
      details: { status: response.status, path }
    });
    throw new XeroApiClientError(message, category, response.status);
  }
  return bodyJson;
}
