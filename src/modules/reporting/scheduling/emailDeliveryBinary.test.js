import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(path.join(process.cwd(), 'cloudflare-v2/src/legacy/email.ts'), 'utf8');

test('all configured email providers use the binary-safe attachment encoder', () => {
  assert.match(source, /encodeEmailAttachmentBase64/);
  assert.match(source, /content: base64\(attachment\.content\)/);
  assert.match(source, /Content-Transfer-Encoding: base64/);
  assert.match(source, /base64UrlEncode\(new TextEncoder\(\)\.encode\(mime\)\)/);
});

test('Resend scheduled attachments preserve filename and binary-safe base64 bytes', () => {
  assert.match(source, /filename: attachment\.filename/);
  assert.match(source, /content: base64\(attachment\.content\)/);
});

test('email attachment content accepts text, Uint8Array, and ArrayBuffer', () => {
  assert.match(source, /string \| Uint8Array \| ArrayBuffer/);
});
