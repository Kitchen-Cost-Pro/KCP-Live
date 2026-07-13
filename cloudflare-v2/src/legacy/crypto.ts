import type { Env } from './types';

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function encryptionKey(env: Env) {
  const secret = String(env.YOCO_KEY_ENCRYPTION_SECRET || '').trim();
  if (!secret) throw new Error('YOCO_KEY_ENCRYPTION_SECRET is not configured.');
  return encryptionKeyFromSecret(secret);
}

async function encryptionKeyFromSecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value)
  );
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptText(env: Env, value: string) {
  const [ivPart, encryptedPart] = String(value || '').split(':');
  if (!ivPart || !encryptedPart) throw new Error('Stored Yoco API key is not encrypted correctly.');
  const key = await encryptionKey(env);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivPart) },
    key,
    base64ToBytes(encryptedPart)
  );
  return new TextDecoder().decode(decrypted);
}

export async function encryptTextWithSecret(secret: string, value: string) {
  const cleanSecret = String(secret || '').trim();
  if (!cleanSecret) throw new Error('Encryption secret is not configured.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKeyFromSecret(cleanSecret);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value)
  );
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptTextWithSecret(secret: string, value: string) {
  const cleanSecret = String(secret || '').trim();
  if (!cleanSecret) throw new Error('Encryption secret is not configured.');
  const [ivPart, encryptedPart] = String(value || '').split(':');
  if (!ivPart || !encryptedPart) throw new Error('Stored secret is not encrypted correctly.');
  const key = await encryptionKeyFromSecret(cleanSecret);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivPart) },
    key,
    base64ToBytes(encryptedPart)
  );
  return new TextDecoder().decode(decrypted);
}

function hmacKeyBytes(secret: string | Uint8Array) {
  return typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
}

function hmacKeyBuffer(secret: string | Uint8Array) {
  const bytes = hmacKeyBytes(secret);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function hmacSha256Base64(secret: string | Uint8Array, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    hmacKeyBuffer(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(signature));
}

export async function hmacSha256Hex(secret: string | Uint8Array, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    hmacKeyBuffer(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}
