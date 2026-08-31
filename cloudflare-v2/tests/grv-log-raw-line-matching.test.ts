import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrvRawLinePool, takeGrvRawLine } from '../src/legacy/reporting-phase21-routes';

// GRV Log must show each line exactly as it was captured in the Draft (pack qty, pack size, the
// custom UOM the user picked) — but grv_lines only stores the already-converted base-unit total,
// so the report has to pair each flat grv_lines row back up with its raw_json.items[] counterpart.
// grv_lines carries no id back to raw_json (a fresh random id is generated per line at insert time),
// so pairing is by (stockItemId, locationId), consumed first-in-first-out — these tests guard that
// matching logic directly, independent of the DB-backed route around it.

test('a single item at one location matches its own raw draft line', () => {
  const rawJson = JSON.stringify({
    items: [
      { stockItemId: 'stock-1', locationId: 'loc-a', packSize: 6, selectedUom: 'Box', receivedQty: 3 },
    ],
  });
  const pool = buildGrvRawLinePool(rawJson);
  const line = takeGrvRawLine(pool, 'stock-1', 'loc-a');
  assert.equal(line.packSize, 6);
  assert.equal(line.selectedUom, 'Box');
  assert.equal(line.receivedQty, 3);
});

test('an item with no raw counterpart returns an empty object, not a crash', () => {
  const pool = buildGrvRawLinePool(JSON.stringify({ items: [] }));
  assert.deepEqual(takeGrvRawLine(pool, 'stock-missing', 'loc-a'), {});
});

test('a malformed or missing raw_json degrades to an empty pool', () => {
  assert.deepEqual(takeGrvRawLine(buildGrvRawLinePool(undefined), 'stock-1', 'loc-a'), {});
  assert.deepEqual(takeGrvRawLine(buildGrvRawLinePool('not json'), 'stock-1', 'loc-a'), {});
  assert.deepEqual(takeGrvRawLine(buildGrvRawLinePool('{}'), 'stock-1', 'loc-a'), {});
});

test('two split lines for the same item at the same location are matched in draft order when called in that order', () => {
  const rawJson = JSON.stringify({
    items: [
      { stockItemId: 'stock-1', locationId: 'loc-a', packSize: 1, selectedUom: 'ea', receivedQty: 4 },
      { stockItemId: 'stock-1', locationId: 'loc-a', packSize: 6, selectedUom: 'Box', receivedQty: 2 },
    ],
  });
  const pool = buildGrvRawLinePool(rawJson);

  const first = takeGrvRawLine(pool, 'stock-1', 'loc-a', 4);
  assert.equal(first.selectedUom, 'ea');

  const second = takeGrvRawLine(pool, 'stock-1', 'loc-a', 12);
  assert.equal(second.selectedUom, 'Box');

  // A third grv_lines row for this same key (shouldn't exist, but the report must not crash or
  // silently reuse a line already assigned to another row) gets an empty fallback.
  const third = takeGrvRawLine(pool, 'stock-1', 'loc-a', 999);
  assert.deepEqual(third, {});
});

// Regression: grv_lines has no insertion-order column (its own id is a random UUID assigned at
// write time, not sequential), so the SQL query that drives getGrvLogReport can hand rows to
// takeGrvRawLine in ANY order relative to how they were drafted. Plain FIFO consumption would pair
// rows with the wrong raw entries whenever that happens — e.g. a 24-unit case line getting labelled
// "6 loose units, pack size 1" and vice versa: self-inconsistent with each row's own received
// quantity, and confidently wrong rather than blank. Matching by each row's own base quantity
// (packQty*packSize) against the raw entry's own computed base quantity is order-independent.
test('same item, same location, requested OUT OF DRAFT ORDER still pairs each row with its own matching quantity', () => {
  const rawJson = JSON.stringify({
    // Drafted as: case first (24 units), then loose (6 units).
    items: [
      { stockItemId: 'stock-1', locationId: 'loc-a', packSize: 24, selectedUom: 'Case', receivedQty: 1, unitCost: 2 },
      { stockItemId: 'stock-1', locationId: 'loc-a', packSize: 1, selectedUom: 'ea', receivedQty: 6, unitCost: 2.5 },
    ],
  });
  const pool = buildGrvRawLinePool(rawJson);

  // But the grv_lines rows are handed to the matcher in the OPPOSITE order (loose row, 6 base
  // units, arrives first) — simulating the DB returning rows in random UUID order.
  const looseRow = takeGrvRawLine(pool, 'stock-1', 'loc-a', 6);
  assert.equal(looseRow.selectedUom, 'ea');
  assert.equal(looseRow.packSize, 1);

  const caseRow = takeGrvRawLine(pool, 'stock-1', 'loc-a', 24);
  assert.equal(caseRow.selectedUom, 'Case');
  assert.equal(caseRow.packSize, 24);
});

test('truly identical duplicate lines (same item, location, and quantity) fall back to FIFO — inconsequential since both describe the same thing', () => {
  const rawJson = JSON.stringify({
    items: [
      { stockItemId: 'stock-1', locationId: 'loc-a', packSize: 1, selectedUom: 'ea', receivedQty: 5, unitCost: 3 },
      { stockItemId: 'stock-1', locationId: 'loc-a', packSize: 1, selectedUom: 'ea', receivedQty: 5, unitCost: 3 },
    ],
  });
  const pool = buildGrvRawLinePool(rawJson);
  const first = takeGrvRawLine(pool, 'stock-1', 'loc-a', 5);
  const second = takeGrvRawLine(pool, 'stock-1', 'loc-a', 5);
  assert.equal(first.unitCost, 3);
  assert.equal(second.unitCost, 3);
});

test('the same item split across two DIFFERENT locations is not confused with a same-location split', () => {
  const rawJson = JSON.stringify({
    items: [
      { stockItemId: 'stock-1', locationId: 'loc-a', selectedUom: 'ea' },
      { stockItemId: 'stock-1', locationId: 'loc-b', selectedUom: 'Box' },
    ],
  });
  const pool = buildGrvRawLinePool(rawJson);
  assert.equal(takeGrvRawLine(pool, 'stock-1', 'loc-b').selectedUom, 'Box');
  assert.equal(takeGrvRawLine(pool, 'stock-1', 'loc-a').selectedUom, 'ea');
});

test('a raw item using targetLocation instead of locationId still matches', () => {
  const rawJson = JSON.stringify({
    items: [{ stockItemId: 'stock-1', targetLocation: 'loc-a', selectedUom: 'Box' }],
  });
  const pool = buildGrvRawLinePool(rawJson);
  assert.equal(takeGrvRawLine(pool, 'stock-1', 'loc-a').selectedUom, 'Box');
});
