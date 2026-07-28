import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { lowStockLocationRelevantSql } from '../src/legacy/low-stock-policy';

test('rolling low-stock relevance excludes untouched zero balances only', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE stock_items (id TEXT, workspace_id TEXT);
    CREATE TABLE stock_balances (workspace_id TEXT, stock_item_id TEXT, location_id TEXT, quantity REAL);
    CREATE TABLE stock_movements (
      workspace_id TEXT, stock_item_id TEXT, location_id TEXT, movement_type TEXT,
      document_type TEXT, occurred_at TEXT, created_at TEXT
    );
    CREATE TABLE stocktake_templates (id TEXT, workspace_id TEXT, location_id TEXT, active INTEGER);
    CREATE TABLE stocktake_template_lines (
      workspace_id TEXT, stocktake_template_id TEXT, stock_item_id TEXT
    );
    INSERT INTO stock_items VALUES ('item-1', 'ws-1');
    INSERT INTO stock_balances VALUES
      ('ws-1', 'item-1', 'untouched-zero', 0),
      ('ws-1', 'item-1', 'recent-zero', 0),
      ('ws-1', 'item-1', 'old-zero', 0),
      ('ws-1', 'item-1', 'positive-inactive', 2),
      ('ws-1', 'item-1', 'template-zero', 0);
    INSERT INTO stock_movements VALUES
      ('ws-1', 'item-1', 'recent-zero', 'sale_depletion', 'yoco_order', datetime('now', '-10 days'), datetime('now', '-10 days')),
      ('ws-1', 'item-1', 'old-zero', 'grv_in', 'grv', datetime('now', '-31 days'), datetime('now', '-31 days'));
    INSERT INTO stocktake_templates VALUES ('template-1', 'ws-1', 'template-zero', 1);
    INSERT INTO stocktake_template_lines VALUES ('ws-1', 'template-1', 'item-1');
  `);

  const rows = db.prepare(
    `SELECT sb.location_id AS locationId
       FROM stock_items si
       JOIN stock_balances sb ON sb.stock_item_id = si.id AND sb.workspace_id = si.workspace_id
      WHERE ${lowStockLocationRelevantSql('si', 'sb')}
      ORDER BY sb.location_id`,
  ).all() as Array<{ locationId: string }>;

  assert.deepEqual(rows.map((row) => row.locationId), [
    'positive-inactive',
    'recent-zero',
    'template-zero',
  ]);
});
