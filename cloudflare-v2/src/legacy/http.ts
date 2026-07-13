import type { Env } from './types';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8'
};

export function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowOrigin = allowed.some((allowedOrigin) => originMatches(allowedOrigin, origin))
    ? origin
    : allowed[0] || '*';

  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-kcp-admin-token,x-kcp-admin-session,x-yoco-signature,x-yoco-event-id',
    'access-control-max-age': '86400'
  };
}

function originMatches(allowedOrigin: string, origin: string) {
  if (!allowedOrigin || !origin) return false;
  if (allowedOrigin === origin || allowedOrigin === '*') return true;
  if (!allowedOrigin.includes('*')) return false;

  const escaped = allowedOrigin
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^.:/]+');
  return new RegExp(`^${escaped}$`).test(origin);
}

export function json(request: Request, env: Env, body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...corsHeaders(request, env),
      ...(init.headers || {})
    }
  });
}

export function error(request: Request, env: Env, status: number, message: string, details?: unknown) {
  return json(request, env, { ok: false, error: message, details }, { status });
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

export function getParam(url: URL, key: string, fallback = '') {
  return String(url.searchParams.get(key) || fallback).trim();
}

export function limitFromUrl(url: URL, fallback = 50, max = 200) {
  const raw = Number(url.searchParams.get('limit') || fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

export function offsetFromUrl(url: URL) {
  const raw = Number(url.searchParams.get('offset') || 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}
