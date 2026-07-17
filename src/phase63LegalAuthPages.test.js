import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 63 exposes Privacy Policy and Terms of Service from sign in and registration', () => {
  const auth = read('src/auth.js');
  const legal = read('src/legal.js');

  assert.match(legal, /PRIVACY_POLICY_URL = '\/privacy\.html'/);
  assert.match(legal, /TERMS_OF_SERVICE_URL = '\/terms\.html'/);
  assert.match(auth, /renderLoginLegalNotice\(\)/);
  assert.match(auth, /renderRegistrationLegalAcceptance\(\)/);
  assert.match(auth, /name="legalAccepted" required/);
  assert.match(auth, /target="_blank" rel="noopener noreferrer"/);
});

test('Phase 63 requires and records legal acceptance for new registration requests', () => {
  const auth = read('src/auth.js');
  const service = read('src/services/authService.js');
  const worker = read('cloudflare-v2/src/legacy/auth-routes.ts');

  assert.match(auth, /termsAccepted: true/);
  assert.match(auth, /privacyAcknowledged: true/);
  assert.match(auth, /legalVersion: LEGAL_DOCUMENT_VERSION/);
  assert.match(service, /if \(!termsAccepted \|\| !privacyAcknowledged \|\| !legalVersion\)/);
  assert.match(worker, /const CURRENT_LEGAL_VERSION = '2026-07-14'/);
  assert.match(worker, /legalVersion !== CURRENT_LEGAL_VERSION/);
  assert.match(worker, /JSON\.stringify\(legalAcceptance\)/);
  assert.match(worker, /acceptedAt: now/);
});

test('Phase 63 ships full legal pages without em dashes', () => {
  const privacy = read('public/privacy.html');
  const terms = read('public/terms.html');
  const css = read('public/legal.css');

  assert.match(privacy, /<h1>Privacy Policy<\/h1>/);
  assert.match(privacy, /Protection of Personal Information Act 4 of 2013/);
  assert.match(privacy, /Information Regulator South Africa/);
  assert.match(terms, /<h1>Terms of Service<\/h1>/);
  assert.match(terms, /Consumer Protection Act 68 of 2008/);
  assert.match(terms, /Electronic acceptance/);
  assert.match(css, /\.legal-document/);
  assert.doesNotMatch(privacy, /\u2014/);
  assert.doesNotMatch(terms, /\u2014/);
});
