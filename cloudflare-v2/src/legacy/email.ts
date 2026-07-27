import { connect } from 'cloudflare:sockets';
import type { Env } from './types';
// @ts-ignore Shared binary-safe attachment encoder used by Worker email providers and Node tests.
import { emailAttachmentBytes, encodeEmailAttachmentBase64 } from '../../../src/modules/reporting/scheduling/emailAttachmentEncoding.js';

export interface EmailDeliveryConfig {
  provider: string;
  apiKey?: string;
  from: string;
  fromName?: string;
  fromEmail?: string;
  appBaseUrl?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpPassword?: string;
  gmailTokenRefresher?: (env: Env) => Promise<string>;
}

export type EmailAttachmentContent = string | Uint8Array | ArrayBuffer;

export interface EmailAttachment {
  filename: string;
  content: EmailAttachmentContent;
  contentType?: string;
}

export interface EmailPayload {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  attachments?: EmailAttachment[];
}

function clean(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function emailList(value: string | string[]) {
  return (Array.isArray(value) ? value : [value])
    .map((entry) => clean(entry))
    .filter(Boolean);
}

export { emailAttachmentBytes, encodeEmailAttachmentBase64 };

function base64(value: EmailAttachmentContent) {
  return encodeEmailAttachmentBase64(value);
}

function encodeHeader(value: string) {
  const raw = clean(value);
  return /^[\x00-\x7F]*$/.test(raw) ? raw : `=?UTF-8?B?${base64(raw)}?=`;
}

function dotStuff(value: string) {
  return value.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function smtpAddress(value = '') {
  const match = clean(value).match(/<([^>]+)>/);
  return clean(match?.[1] || value);
}

function buildPlainMessage(config: EmailDeliveryConfig, payload: EmailPayload) {
  const from = clean(payload.from || config.from);
  const to = emailList(payload.to).join(', ');
  const alternativeBoundary = `kcp_alt_${Math.random().toString(36).slice(2)}`;
  const mixedBoundary = `kcp_mix_${Math.random().toString(36).slice(2)}`;
  const attachments = payload.attachments || [];
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(payload.subject)}`,
    'MIME-Version: 1.0'
  ];
  const bodyParts = payload.html
    ? [
        `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
        '',
        `--${alternativeBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        payload.text,
        '',
        `--${alternativeBoundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        payload.html,
        '',
        `--${alternativeBoundary}--`
      ]
    : [
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        payload.text
      ];

  if (!attachments.length) return [...headers, ...bodyParts].join('\r\n');

  const mixed = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    `--${mixedBoundary}`,
    ...bodyParts
  ];
  for (const attachment of attachments) {
    const encoded = base64(attachment.content).match(/.{1,76}/g)?.join('\r\n') || '';
    const filename = clean(attachment.filename || 'attachment.txt').replace(/["\r\n]/g, '_');
    mixed.push(
      '',
      `--${mixedBoundary}`,
      `Content-Type: ${clean(attachment.contentType || 'application/octet-stream')}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      encoded
    );
  }
  mixed.push('', `--${mixedBoundary}--`);
  return mixed.join('\r\n');
}

export async function sendEmail(env: Env, config: EmailDeliveryConfig, payload: EmailPayload) {
  const provider = clean(config.provider || 'resend').toLowerCase();
  if (provider === 'gmail_oauth') {
    return sendViaGmailOAuth(env, config, payload);
  }
  if (provider === 'gmail_smtp' || provider === 'smtp' || provider === 'gmail') {
    return sendViaSmtp(config, payload);
  }
  return sendViaResend(env, config, payload);
}

async function sendViaGmailOAuth(env: Env, config: EmailDeliveryConfig, payload: EmailPayload) {
  if (!config.gmailTokenRefresher) throw new Error('No Gmail token refresher configured.');
  const accessToken = await config.gmailTokenRefresher(env);
  const fromEmail = clean(config.fromEmail || config.from);
  const fromName = clean(config.fromName || 'Kitchen Cost Pro');
  const recipients = emailList(payload.to);
  if (!recipients.length) return { sent: false, status: 'email-error', reason: 'No recipients.' };

  const mime = buildPlainMessage({ ...config, from: fromName ? `${fromName} <${fromEmail}>` : fromEmail }, { ...payload, to: recipients });

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: base64UrlEncode(new TextEncoder().encode(mime)) }),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) return { sent: false, status: 'email-error', reason: String((result as any).error?.message || 'Gmail API error') };
  return { sent: true, status: 'sent', provider: 'gmail_oauth' };
}

function base64UrlEncode(bytes: Uint8Array): string {
  return encodeEmailAttachmentBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendViaResend(_env: Env, config: EmailDeliveryConfig, payload: EmailPayload) {
  const apiKey = clean(config.apiKey);
  const from = clean(config.from);
  const to = emailList(payload.to);
  if (!apiKey || !from) {
    return {
      sent: false,
      status: 'otp-generated',
      reason: 'Email sender is not configured. Add Resend API key and sender details in Admin Console > System Tools.'
    };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to,
      subject: payload.subject,
      text: payload.text,
      ...(payload.html ? { html: payload.html } : {}),
      ...(payload.attachments?.length ? {
        attachments: payload.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: base64(attachment.content)
        }))
      } : {})
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      sent: false,
      status: 'email-error',
      reason: body || `Email provider returned ${response.status}.`
    };
  }

  const result = await response.json().catch(() => ({}));
  return {
    sent: true,
    status: 'sent',
    provider: 'resend',
    providerId: clean((result as any)?.id)
  };
}

async function sendViaSmtp(config: EmailDeliveryConfig, payload: EmailPayload): Promise<{ sent: boolean; status: string; reason?: string; provider?: string }> {
  const host = clean(config.smtpHost || 'smtp.gmail.com');
  const port = Number(config.smtpPort || 587);
  const username = clean(config.smtpUsername || config.fromEmail);
  const password = clean(config.smtpPassword).replace(/\s+/g, '');
  const from = smtpAddress(clean(config.from || config.fromEmail || username));
  const recipients = emailList(payload.to);

  if (!username || !password || !from || !recipients.length) {
    return {
      sent: false,
      status: 'email-error',
      reason: 'Gmail SMTP requires sender email, Gmail username, app password, and at least one recipient.'
    };
  }

  let socket = connect({ hostname: host, port }, { secureTransport: 'starttls', allowHalfOpen: false });
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  let buffer = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  async function readResponse(expectedCode?: number) {
    while (true) {
      const endMatch = buffer.match(/(^|\r?\n)(\d{3}) [^\r\n]*(\r?\n|$)/);
      if (endMatch) {
        const endIndex = (endMatch.index || 0) + endMatch[0].length;
        const chunk = buffer.slice(0, endIndex);
        buffer = buffer.slice(endIndex);
        const code = Number(endMatch[2]);
        if (expectedCode && code !== expectedCode) throw new Error(`SMTP returned ${code}: ${chunk.trim()}`);
        return { code, text: chunk };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP connection closed unexpectedly.');
      buffer += decoder.decode(value, { stream: true });
    }
  }

  async function command(line: string, expectedCode?: number) {
    await writer.write(encoder.encode(`${line}\r\n`));
    return readResponse(expectedCode);
  }

  try {
    await readResponse(220);
    await command('EHLO kitchencostpro.local', 250);
    await command('STARTTLS', 220);
    writer.releaseLock();
    reader.releaseLock();
    socket = socket.startTls();
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    buffer = '';
    await command('EHLO kitchencostpro.local', 250);
    await command('AUTH LOGIN', 334);
    await command(base64(username), 334);
    await command(base64(password), 235);
    await command(`MAIL FROM:<${from}>`, 250);
    for (const recipient of recipients) {
      await command(`RCPT TO:<${smtpAddress(recipient)}>`, 250);
    }
    await command('DATA', 354);
    await writer.write(encoder.encode(`${dotStuff(buildPlainMessage(config, payload))}\r\n.\r\n`));
    await readResponse(250);
    await command('QUIT', 221).catch(() => null);
    return { sent: true, status: 'sent', provider: 'gmail_smtp' };
  } catch (err) {
    return { sent: false, status: 'email-error', reason: String((err as any)?.message || err) };
  } finally {
    try {
      writer.releaseLock();
      reader.releaseLock();
    } catch {
      // Ignore cleanup errors.
    }
    socket.close();
  }
}
