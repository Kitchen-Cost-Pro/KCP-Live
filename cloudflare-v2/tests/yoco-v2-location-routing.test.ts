import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../src/legacy/types';
import { resolveYocoStockLocation } from '../src/modules/yoco-engine-v2/location-routing';

function testEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE locations (
      id TEXT, workspace_id TEXT, name TEXT, display_name TEXT, kind TEXT,
      active INTEGER, is_default INTEGER, external_provider TEXT,
      external_location_id TEXT, external_name TEXT, created_at TEXT
    );
    INSERT INTO locations VALUES
      ('main-store', 'ws-1', 'Main Storage', 'Main Storage', 'storage', 1, 1, NULL, NULL, NULL, '2026-01-01'),
      ('bar', 'ws-1', 'Bar', 'Bar', 'selling', 1, 0, 'yoco', 'yoco-bar', NULL, '2026-01-02'),
      ('default-store', 'ws-default', 'Central Store', 'Central Store', 'selling', 1, 1, NULL, NULL, NULL, '2026-01-01'),
      ('single-location', 'ws-single', 'Kitchen', 'Kitchen', 'selling', 1, 0, NULL, NULL, NULL, '2026-01-01'),
      ('inactive-main', 'ws-inactive', 'Main Storage', 'Main Storage', 'storage', 0, 1, NULL, NULL, NULL, '2026-01-01');
  `);
  const DB = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => sqlite.prepare(sql).get(...values as any[]),
          };
        },
      };
    },
  };
  return { sqlite, env: { DB } as unknown as Env };
}

test('Yoco location routing keeps mappings and falls back to Main Storage', async () => {
  const { sqlite, env } = testEnv();
  assert.equal(await resolveYocoStockLocation(env, 'ws-1', 'yoco-bar'), 'bar');
  assert.equal(await resolveYocoStockLocation(env, 'ws-1', 'unknown-yoco-location'), 'main-store');
  assert.equal(await resolveYocoStockLocation(env, 'ws-1', ''), 'main-store');
  assert.equal(await resolveYocoStockLocation(env, 'ws-default', ''), 'default-store');
  assert.equal(await resolveYocoStockLocation(env, 'ws-single', ''), 'single-location');
  assert.equal(await resolveYocoStockLocation(env, 'ws-inactive', ''), '');
  sqlite.close();
});
