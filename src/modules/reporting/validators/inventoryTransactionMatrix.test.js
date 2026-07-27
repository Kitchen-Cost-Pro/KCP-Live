import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryMatrix } from './inventoryTransactionMatrix.js';

for (const method of ['wac', 'last']) {
  test(`${method} transaction matrix preserves location valuation through all core movements`, () => {
    const matrix = createInventoryMatrix(method);
    matrix.grv('A', 10, 10);
    matrix.grv('A', 10, 20);
    matrix.grv('B', 8, 30);

    assert.equal(matrix.getLocation('A').unitCost, method === 'wac' ? 15 : 20);
    assert.equal(matrix.getLocation('B').unitCost, 30);

    const sale = matrix.sale('A', 2);
    const refund = matrix.refund('A', 1);
    const adjustment = matrix.adjustment('A', -1);
    const stockTake = matrix.stockTake('A', 17);
    const manufacturing = matrix.manufacturingConsume('A', 2);
    const transfer = matrix.transfer('A', 'B', 3);

    const expectedA = method === 'wac' ? 15 : 20;
    assert.equal(sale.unitCost, expectedA);
    assert.equal(refund.unitCost, expectedA);
    assert.equal(adjustment.unitCost, expectedA);
    assert.equal(stockTake.unitCost, expectedA);
    assert.equal(manufacturing.unitCost, expectedA);
    assert.equal(transfer.carriedCost, expectedA);
    assert.equal(matrix.getLocation('A').quantity, 12);
    assert.equal(matrix.getLocation('A').unitCost, expectedA);
    assert.equal(matrix.getLocation('B').quantity, 11);
    assert.equal(matrix.getLocation('B').unitCost, method === 'wac' ? ((8 * 30) + (3 * 15)) / 11 : 20);

    const recA = matrix.reconcile('A');
    const recB = matrix.reconcile('B');
    assert.equal(recA.movementQuantity, recA.closingQuantity);
    assert.equal(recB.movementQuantity, recB.closingQuantity);
  });
}

test('retrying the same logical event can be guarded without changing the transaction outcome', () => {
  const matrix = createInventoryMatrix('wac');
  const processed = new Set();
  const once = (key, action) => {
    if (processed.has(key)) return false;
    processed.add(key);
    action();
    return true;
  };
  assert.equal(once('grv-1', () => matrix.grv('A', 10, 12)), true);
  assert.equal(once('grv-1', () => matrix.grv('A', 10, 12)), false);
  assert.equal(once('sale-1', () => matrix.sale('A', 2)), true);
  assert.equal(once('sale-1', () => matrix.sale('A', 2)), false);
  assert.equal(matrix.getLocation('A').quantity, 8);
});
