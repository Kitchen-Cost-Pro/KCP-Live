import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeCookieNotice,
  COOKIE_NOTICE_STORAGE_KEY,
  hasAcknowledgedCookieNotice
} from './CookieNotice.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}

test('cookie notice acknowledgement is remembered', () => {
  const storage = memoryStorage();
  assert.equal(hasAcknowledgedCookieNotice(storage), false);
  assert.equal(acknowledgeCookieNotice(storage), true);
  assert.equal(storage.getItem(COOKIE_NOTICE_STORAGE_KEY), 'acknowledged');
  assert.equal(hasAcknowledgedCookieNotice(storage), true);
});

test('cookie notice remains available when storage is blocked', () => {
  const blockedStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); }
  };
  assert.equal(hasAcknowledgedCookieNotice(blockedStorage), false);
  assert.equal(acknowledgeCookieNotice(blockedStorage), false);
});
