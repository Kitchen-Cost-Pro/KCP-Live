import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFoodCostPercent,
  calculateGpPercent,
  calculateGrossProfit,
  calculateNetFromGross,
  calculateStockValue,
  calculateVatFromGross
} from './calculations.js';
import { explodeRecipeToIngredients } from './recipeExplosion.js';
import { mapModifierUsageRows } from './modifierUsageMapper.js';
import { isReportingMockDataEnabled } from '../api/reportingEndpoints.js';
import { normalizeApiSaleStockUsageRow, normalizeApiSalesFinancialRow } from '../api/reportingMappers.js';
import { validateSalesFinancialRows, validateSaleStockUsageRows } from '../validators/salesUsageValidators.js';

test('VAT calculation separates gross, VAT, and net for VAT-inclusive Rand sales', () => {
  assert.equal(calculateVatFromGross(115, 15), 15);
  assert.equal(calculateNetFromGross(115, 15), 100);
  assert.equal(calculateVatFromGross(100, 0), 0);
});

test('sales validators flag gross and net equality when VAT is not zero', () => {
  const warnings = validateSalesFinancialRows([{ id: 'sale-1', grossAmount: 115, netAmount: 115, vatAmount: 15, paymentMethod: 'Card', receiptNumber: 'R-1' }]);
  assert.ok(warnings.some((warning) => warning.code === 'gross-equals-net-with-vat'));
});

test('recipe explosion converts units and returns final ingredient usage rows', () => {
  const result = explodeRecipeToIngredients({
    menuItemId: 'burger',
    quantitySold: 2,
    recipeData: {
      recipes: [{ id: 'recipe-burger', owner_type: 'product', owner_id: 'burger', yield_qty: 1 }],
      recipeLines: [{ id: 'line-flour', recipe_id: 'recipe-burger', stock_item_id: 'flour', quantity: 500, unit: 'g' }],
      stockItems: [{ id: 'flour', name: 'Flour', category: 'Dry Goods', unit: 'kg', unit_cost: 20, item_type: 'raw' }]
    }
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].inventoryItemId, 'flour');
  assert.equal(result.rows[0].qtyUsed, 1);
  assert.equal(result.rows[0].stockValueUsed, 20);
  assert.deepEqual(result.warnings, []);
});

test('sub-recipe explosion prevents parent and child double counting', () => {
  const result = explodeRecipeToIngredients({
    menuItemId: 'pizza',
    quantitySold: 2,
    recipeData: {
      recipes: [
        { id: 'recipe-pizza', owner_type: 'product', owner_id: 'pizza', yield_qty: 1 },
        { id: 'recipe-sauce', owner_type: 'stock_item', owner_id: 'sauce', yield_qty: 1 }
      ],
      recipeLines: [
        { id: 'pizza-sauce', recipe_id: 'recipe-pizza', stock_item_id: 'sauce', quantity: 2, unit: 'kg' },
        { id: 'sauce-tomato', recipe_id: 'recipe-sauce', stock_item_id: 'tomato', quantity: 0.5, unit: 'kg' }
      ],
      stockItems: [
        { id: 'sauce', name: 'Sauce', unit: 'kg', unit_cost: 10, item_type: 'sub_recipe', is_stocked: 0 },
        { id: 'tomato', name: 'Tomato', category: 'Veg', unit: 'kg', unit_cost: 30, item_type: 'raw' }
      ]
    }
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].inventoryItemId, 'tomato');
  assert.equal(result.rows[0].qtyUsed, 2);
  assert.equal(result.rows[0].stockValueUsed, 60);
  assert.ok(!result.rows.some((row) => row.inventoryItemId === 'sauce'));
});

test('circular recipe prevention returns a warning instead of infinite recursion', () => {
  const result = explodeRecipeToIngredients({
    menuItemId: 'loop-menu-item',
    quantitySold: 1,
    recipeData: {
      recipes: [
        { id: 'recipe-menu', owner_type: 'product', owner_id: 'loop-menu-item', yield_qty: 1 },
        { id: 'recipe-loop', owner_type: 'stock_item', owner_id: 'loop-stock', yield_qty: 1 }
      ],
      recipeLines: [
        { id: 'menu-loop', recipe_id: 'recipe-menu', stock_item_id: 'loop-stock', quantity: 1, unit: 'ea' },
        { id: 'loop-self', recipe_id: 'recipe-loop', stock_item_id: 'loop-stock', quantity: 1, unit: 'ea' }
      ],
      stockItems: [{ id: 'loop-stock', name: 'Loop Stock', unit: 'ea', item_type: 'sub_recipe', is_stocked: 0 }]
    }
  });
  assert.equal(result.rows.length, 0);
  assert.ok(result.warnings.some((warning) => warning.code === 'circular-recipe'));
});

test('sale usage API mapper standardises Sale Usage ledger rows', () => {
  const row = normalizeApiSaleStockUsageRow({
    id: 'mov-1',
    workspace_id: 'ws-1',
    location_id: 'loc-1',
    location_name: 'Kitchen',
    sale_date: '2026-07-09',
    receipt_number: 'R-1',
    sale_id: 'sale-1',
    sale_line_id: 'line-1',
    menu_item_id: 'burger',
    inventory_item_id: 'flour',
    inventory_item_name: 'Flour',
    source_type: 'Sale Usage',
    qty_used: 2,
    base_uom: 'kg',
    unit_cost_ex_vat: 10
  });
  assert.equal(row.sourceType, 'Sale Usage');
  assert.equal(row.stockValueUsed, 20);
  assert.deepEqual(validateSaleStockUsageRows([row]), []);
});

test('modifier usage mapper keeps product and mapped note modifiers separate from sale usage', () => {
  const result = mapModifierUsageRows({
    modifierSelections: [
      { id: 'extra-cheese', type: 'product', name: 'Extra Cheese', quantity: 2, stockItemId: 'cheese', qtyPerSelection: 0.05, unitCost: 100, baseUom: 'kg' },
      { id: 'no-onion', type: 'note', name: 'No Onion' },
      { id: 'add-salt-note', type: 'note', name: 'Add Salt', quantity: 1 }
    ],
    stockMappings: [{ modifierId: 'add-salt-note', inventoryItemId: 'salt', inventoryItemName: 'Salt', qtyPerSelection: 0.01, unitCostExVat: 5, baseUom: 'kg' }],
    saleContext: { workspaceId: 'ws-1', saleId: 'sale-1', saleLineId: 'line-1', locationId: 'loc-1' }
  });
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.sourceType === 'Modifier Usage'));
  assert.equal(result.rows.find((row) => row.inventoryItemId === 'cheese').stockValueUsed, 10);
  assert.ok(result.warnings.some((warning) => warning.code === 'missing-modifier-stock-mapping'));
});

test('sales report normalization repairs unexplained zero VAT and preserves explicit zero-rated sales', async () => {
  const { normalizeSalesFinancialRow } = await import('../reports/sales/salesReportHelpers.js');
  const taxable = normalizeSalesFinancialRow({ grossAmount: 560, vatAmount: 0, netAmount: 560, vatRate: 15, status: 'completed' });
  assert.equal(taxable.vatAmount, 73.04);
  assert.equal(taxable.netAmount, 486.96);
  assert.equal(taxable.vatSource, 'calculated');

  const zeroRated = normalizeSalesFinancialRow({ grossAmount: 560, vatAmount: 0, netAmount: 560, vatRate: 15, status: 'completed', isVatExempt: true });
  assert.equal(zeroRated.vatAmount, 0);
  assert.equal(zeroRated.netAmount, 560);
  assert.equal(zeroRated.vatSource, 'zero-rated');
});

test('sales financial API mapper converts a UTC fallback timestamp to the workspace timezone', () => {
  const row = normalizeApiSalesFinancialRow({ occurred_at: '2026-07-10T16:38:00.000Z' }, 0, { timeZone: 'Africa/Johannesburg' });
  assert.equal(row.saleDate, '2026-07-10');
  assert.equal(row.saleTime, '18:38:00');
});

test('sales financial API mapper preserves refunds, discounts, tips, fees, and payout separately', () => {
  const row = normalizeApiSalesFinancialRow({
    id: 'sale-1',
    workspace_id: 'ws-1',
    sale_date: '2026-07-09',
    receipt_number: 'R-1',
    payment_method: 'Card',
    gross_amount: 115,
    vat_amount: 15,
    net_amount: 100,
    discount_amount: 5,
    refund_amount: 0,
    tip_amount: 10,
    fee_amount: 2,
    payout_amount: 113
  });
  assert.equal(row.grossAmount, 115);
  assert.equal(row.netAmount, 100);
  assert.equal(row.payoutAmount, 113);
});

test('GP, GP percent, food cost percent, and stock value calculations are shared', () => {
  const stockCost = calculateStockValue(2.5, 10);
  const gp = calculateGrossProfit(100, stockCost);
  assert.equal(stockCost, 25);
  assert.equal(gp, 75);
  assert.equal(calculateGpPercent(gp, 100), 0.75);
  assert.equal(calculateFoodCostPercent(stockCost, 100), 0.25);
});

test('reporting mock data is not used by default', () => {
  assert.equal(isReportingMockDataEnabled({}), false);
});

test('payment and sale usage reporting repair zero workspace VAT rates consistently', async () => {
  const { normalizeSalesFinancialRow, normalizeSaleUsageRow } = await import('../reports/sales/salesReportHelpers.js');

  const payment = normalizeSalesFinancialRow({
    grossAmount: 560,
    vatAmount: 0,
    netAmount: 560,
    vatRate: 0,
    status: 'completed'
  });
  assert.equal(payment.vatRate, 0.15);
  assert.equal(payment.vatAmount, 73.04);
  assert.equal(payment.netAmount, 486.96);

  const usage = normalizeSaleUsageRow({
    grossSaleAmount: 560,
    vatAmount: 0,
    netSaleAmount: 560,
    vatRate: 0,
    qtyUsed: 1,
    unitCostExVat: 20
  });
  assert.equal(usage.vatRate, 0.15);
  assert.equal(usage.vatAmount, 73.04);
  assert.equal(usage.netSaleAmount, 486.96);
});
