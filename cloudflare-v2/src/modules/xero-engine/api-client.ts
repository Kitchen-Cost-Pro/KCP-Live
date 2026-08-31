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
    const message = text(
      (bodyJson as { Message?: string; Detail?: string }).Message ||
        (bodyJson as { Message?: string; Detail?: string }).Detail ||
        `Xero API returned HTTP ${response.status} for ${input.path}.`
    );
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
