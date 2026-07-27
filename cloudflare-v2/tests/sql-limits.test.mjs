import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TENANT_ID_QUERY_CHUNK_SIZE,
  tenantIdChunks
} from '../src/sql-limits.ts';

test('tenant ID queries stay within the Durable Object 100-parameter limit', () => {
  const ids = Array.from({ length: 200 }, (_, index) => `item-${index + 1}`);
  const chunks = tenantIdChunks(ids);

  assert.equal(TENANT_ID_QUERY_CHUNK_SIZE, 99);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [99, 99, 2]);
  assert.equal(chunks.flat().length, ids.length);
  assert.ok(chunks.every((chunk) => chunk.length + 1 <= 100));
});

test('tenant ID chunking preserves order and values', () => {
  const ids = Array.from({ length: 205 }, (_, index) => `recipe-${index + 1}`);
  assert.deepEqual(tenantIdChunks(ids).flat(), ids);
});
