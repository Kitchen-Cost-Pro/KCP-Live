import type { Env } from './types';

type TurnstileResponse = {
  success?: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
};

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

export async function verifyTurnstileToken(request: Request, env: Env, token: unknown, options: {
  mode?: string;
  label?: string;
  secretKey?: string;
} = {}) {
  const secret = text(options.secretKey || env.TURNSTILE_SECRET_KEY);
  const siteKey = text(env.TURNSTILE_SITE_KEY);
  const mode = text(options.mode || env.ADMIN_TURNSTILE_MODE, 'enforce').toLowerCase();
  const label = text(options.label || 'Security');
  if (!secret || !siteKey) {
    return { ok: true, required: false, mode };
  }

  const responseToken = text(token);
  if (!responseToken) {
    return { ok: false, required: true, mode, message: `Complete the ${label.toLowerCase()} check.` };
  }

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', responseToken);
  const remoteIp = text(request.headers.get('CF-Connecting-IP'));
  if (remoteIp) form.append('remoteip', remoteIp);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    const result = await response.json().catch(() => ({})) as TurnstileResponse;
    if (response.ok && result.success === true) {
      return { ok: true, required: true, mode, hostname: result.hostname };
    }
    return {
      ok: false,
      required: true,
      mode,
      message: `${label} check failed. Please try again.`,
      codes: result['error-codes'] || [],
      hostname: result.hostname || '',
      challengeTs: result.challenge_ts || ''
    };
  } catch {
    return {
      ok: false,
      required: true,
      mode,
      message: `${label} check could not be verified. Please try again.`
    };
  }
}
