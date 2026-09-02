import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { __modifierReportingInternals } from '../src/legacy/reporting-routes';

const { signedMovementStockCost, COST_CORRECTION_VALUE_DELTA_SQL } = __modifierReportingInternals;

// Regression: buildSameDayCostCorrectionStatements (routes.ts) correctly writes a compensating
// 'cost_correction' stock_movements row when a GRV edit fixes a mistaken cost that a same-day sale
// was costed off — but until this fix, every margin/GP report computed cost purely from each sale
// row's OWN unit_cost/value_delta and never looked at those correction rows at all, so the
// correction silently never reached anything a user could see. signedMovementStockCost now folds
// in `cost_correction_value_delta` (a correlated subquery every relevant report SELECT must
// include — see COST_CORRECTION_VALUE_DELTA_SQL's doc comment).

test('signedMovementStockCost: a sale with no correction is unaffected (cost_correction_value_delta absent)', () => {
  const row = { movement_type: 'sale_depletion', quantity_delta: -3, unit_cost: 2, value_delta: -6 };
  assert.equal(signedMovementStockCost(row), 6);
});

test('signedMovementStockCost: a sale_depletion row folds in its correction, reflecting the corrected cost', () => {
  // Sale originally costed at R2 (value_delta -6 for 3 units); a GRV edit fixed R2 -> R20, and
  // buildSameDayCostCorrectionStatements wrote a compensating row with value_delta -54
  // (quantityDelta(-3) * (20 - 2)). True total cost should now read as 3 * 20 = 60.
  const row = {
    movement_type: 'sale_depletion',
    quantity_delta: -3,
    unit_cost: 2,
    value_delta: -6,
    cost_correction_value_delta: -54,
  };
  assert.equal(signedMovementStockCost(row), 60);
});

test('signedMovementStockCost: a sale_refund row folds in its correction and keeps the negative sign', () => {
  const row = {
    movement_type: 'sale_refund',
    quantity_delta: 3,
    unit_cost: 2,
    value_delta: 6,
    cost_correction_value_delta: 54,
  };
  // Base cost 6, corrected to 60 (same magnitude fix as the depletion case), sign flipped for refund.
  assert.equal(signedMovementStockCost(row), -60);
});

test('signedMovementStockCost: a zero correction (never edited) is a true no-op', () => {
  const row = { movement_type: 'sale_depletion', quantity_delta: -3, unit_cost: 2, value_delta: -6, cost_correction_value_delta: 0 };
  assert.equal(signedMovementStockCost(row), 6);
});

// End-to-end: run the ACTUAL correlated subquery SQL against real SQLite, proving it resolves the
// right correction sum for the right sale row and doesn't accidentally match another workspace's
// or another sale's correction.
test('COST_CORRECTION_VALUE_DELTA_SQL resolves the right correction against real SQLite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE stock_movements (
      id TEXT PRIMARY KEY, workspace_id TEXT, movement_type TEXT, value_delta REAL, metadata_json TEXT
    );
  `);
  const insert = db.prepare(`INSERT INTO stock_movements (id, workspace_id, movement_type, value_delta, metadata_json) VALUES (?, ?, ?, ?, ?)`);
  insert.run('mv_sale_1', 'ws_1', 'sale_depletion', -6, '{}');
  insert.run('mv_sale_2', 'ws_1', 'sale_depletion', -10, '{}'); // a different sale, never corrected
  insert.run('mv_sale_other_ws', 'ws_2', 'sale_depletion', -6, '{}'); // same id-adjacent value, different workspace
  insert.run(
    'mv_correction_1',
    'ws_1',
    'cost_correction',
    -54,
    JSON.stringify({ correctedMovementId: 'mv_sale_1', previousUnitCost: 2, newUnitCost: 20 }),
  );

  const rows = db
    .prepare(`SELECT sm.id, ${COST_CORRECTION_VALUE_DELTA_SQL} FROM stock_movements sm WHERE sm.movement_type = 'sale_depletion' ORDER BY sm.id`)
    .all() as Array<{ id: string; cost_correction_value_delta: number }>;

  const byId = new Map(rows.map((row) => [row.id, row.cost_correction_value_delta]));
  assert.equal(byId.get('mv_sale_1'), -54); // the corrected sale picks up its correction
  assert.equal(byId.get('mv_sale_2'), 0); // an uncorrected sale gets 0, not null/undefined
  assert.equal(byId.get('mv_sale_other_ws'), 0); // never crosses into another workspace's rows
});

test('COST_CORRECTION_VALUE_DELTA_SQL sums MULTIPLE corrections for the same sale (repeated edits)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE stock_movements (
      id TEXT PRIMARY KEY, workspace_id TEXT, movement_type TEXT, value_delta REAL, metadata_json TEXT
    );
  `);
  const insert = db.prepare(`INSERT INTO stock_movements (id, workspace_id, movement_type, value_delta, metadata_json) VALUES (?, ?, ?, ?, ?)`);
  insert.run('mv_sale_1', 'ws_1', 'sale_depletion', -6, '{}');
  // Note: buildSameDayCostCorrectionStatements actually only ever inserts one NET correction per
  // sale per edit (it reads the prior effective cost first) — this test exercises the SQL's own
  // aggregation behavior in isolation, not that call pattern.
  insert.run('mv_correction_1', 'ws_1', 'cost_correction', -20, JSON.stringify({ correctedMovementId: 'mv_sale_1' }));
  insert.run('mv_correction_2', 'ws_1', 'cost_correction', -10, JSON.stringify({ correctedMovementId: 'mv_sale_1' }));

  const row = db
    .prepare(`SELECT ${COST_CORRECTION_VALUE_DELTA_SQL} FROM stock_movements sm WHERE sm.id = 'mv_sale_1'`)
    .get() as { cost_correction_value_delta: number };
  assert.equal(row.cost_correction_value_delta, -30);
});
