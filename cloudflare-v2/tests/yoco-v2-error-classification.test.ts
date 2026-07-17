import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyYocoV2Error } from '../src/modules/yoco-engine-v2/errors';

// A missing recipe/mapping, no resolved proposals, an unresolved location, or an unsupported
// currency are permanent data/setup conditions. Retrying cannot fix them, so they must be
// classified non-retryable (fail once, surface for review) rather than churning as retryable
// INTERNAL_ERROR — which previously logged 8 alarming "retry_scheduled" errors per order.
const NON_RETRYABLE_EFFECT_ERRORS = [
  'YOCO_V2_LIVE_STOCK_BLOCKED_BY_PROPOSAL_WARNINGS:1',
  'YOCO_V2_LIVE_STOCK_HAS_NO_RESOLVED_PROPOSALS',
  'YOCO_V2_LIVE_SALE_LOCATION_NOT_RESOLVED',
  'YOCO_V2_LIVE_SALE_NOT_FULLY_RESOLVED:PARTIAL',
  'YOCO_V2_LIVE_SALE_CURRENCY_UNSUPPORTED:USD',
  'YOCO_V2_LIVE_REFUND_CURRENCY_UNSUPPORTED:USD',
];

for (const message of NON_RETRYABLE_EFFECT_ERRORS) {
  test(`classifies "${message}" as non-retryable`, () => {
    const classified = classifyYocoV2Error(new Error(message));
    assert.equal(classified.retryable, false, 'should not be retried');
    assert.equal(classified.category, 'VALIDATION_ERROR');
    assert.equal(classified.code, 'YOCO_V2_EFFECT_NOT_APPLICABLE');
  });
}

test('genuinely transient errors remain retryable', () => {
  assert.equal(classifyYocoV2Error(new Error('SQLITE_ERROR: database is locked')).retryable, true);
  assert.equal(classifyYocoV2Error({ status: 429, message: 'rate limit' }).retryable, true);
  assert.equal(classifyYocoV2Error({ status: 503, message: 'service unavailable' }).retryable, true);
  assert.equal(classifyYocoV2Error(new Error('fetch failed')).retryable, true);
});

test('an explicit non-retryable classification is still respected', () => {
  const classified = classifyYocoV2Error({ category: 'AUTHENTICATION_ERROR', code: 'X', retryable: false, message: 'nope' });
  assert.equal(classified.retryable, false);
});
