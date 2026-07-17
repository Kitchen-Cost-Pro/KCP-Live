import test from 'node:test';
import assert from 'node:assert/strict';
import { __modifierReportingInternals } from '../src/legacy/reporting-routes';

const {
  buildModifierUsageIndex,
  enrichModifierUsageRowsWithActionSnapshots,
  loadModifierCatalogue,
  movementBaseUom,
  movementComponentType,
  movementLineId,
  movementModifierId,
  standardizeModifierSalesRow,
} = __modifierReportingInternals;

test('modifier reporting recognises V2 snake_case movement metadata and source modifier aliases', () => {
  const metadata = {
    source_line_id: 'line-1',
    modifier_id: 'group-1:modifier-1',
    base_uom: 'ml',
  };
  const movement = {
    id: 'movement-1',
    document_id: 'order-1',
    movement_type: 'sale_depletion',
    quantity_delta: -1,
    unit_cost: 2,
    value_delta: -2,
    stock_item_id: 'stock-1',
    item_name: 'Decaf Coffee',
    base_uom: '',
    movement_modifier_source_id: 'modifier-1',
    movement_modifier_source_name: 'Decaf',
    movement_modifier_action_type: 'ADD_STOCK_ITEM',
    metadata_json: JSON.stringify(metadata),
  };

  assert.equal(movementComponentType(metadata), 'modifier');
  assert.equal(movementLineId(metadata), 'line-1');
  assert.equal(movementModifierId(movement, metadata), 'modifier-1');
  assert.equal(movementBaseUom(movement, metadata), 'ml');

  const usageIndex = buildModifierUsageIndex([movement]);
  const warnings: Array<{ code: string; level: string; message: string }> = [];
  const result = standardizeModifierSalesRow(
    {
      workspace_id: 'workspace-1',
      yoco_order_id: 'order-1',
      yoco_line_id: 'line-1',
      line_quantity: 1,
      line_total: 0,
      line_raw_json: '{}',
      occurred_at: '2026-07-16T12:00:00.000Z',
      order_type: 'sale',
      status: 'completed',
      product_name: 'Americano',
    },
    {
      modifierId: 'modifier-1',
      modifierName: 'Decaf',
      modifierGroupId: 'group-1',
      modifierGroupName: 'Coffee Options',
      modifierType: 'Product',
      stockActionType: 'ADD_STOCK_ITEM',
      parentLineId: 'line-1',
      qty: 1,
      grossAmount: 0,
      sourceId: 'selection-1',
      raw: {},
    },
    usageIndex,
    new Map(),
    warnings,
    'Africa/Johannesburg',
    0,
  );

  assert.equal(result.stockDeductionStatus, 'Deducted');
  assert.equal(result.hasModifierUsage, true);
  assert.equal(result.linkedStockItemName, 'Decaf Coffee');
  assert.equal(result.baseUom, 'ml');
  assert.equal(result.stockQtyDeducted, 1);
  assert.equal(warnings.some((warning) => warning.code === 'modifier-usage-row-missing'), false);
});

test('modifier reporting does not demand a separate movement for no-stock and remove actions', () => {
  const baseRow = {
    workspace_id: 'workspace-1',
    yoco_order_id: 'order-2',
    yoco_line_id: 'line-2',
    line_quantity: 1,
    line_total: 0,
    line_raw_json: '{}',
    occurred_at: '2026-07-16T12:00:00.000Z',
    order_type: 'sale',
    status: 'completed',
    product_name: 'Americano',
  };
  const baseSelection = {
    modifierId: 'modifier-2',
    modifierName: 'No Foam',
    modifierGroupId: 'group-1',
    modifierGroupName: 'Coffee Options',
    modifierType: 'Product',
    parentLineId: 'line-2',
    qty: 1,
    grossAmount: 0,
    sourceId: 'selection-2',
    raw: {},
  };

  const noStock = standardizeModifierSalesRow(
    baseRow,
    { ...baseSelection, stockActionType: 'NO_STOCK_CHANGE' },
    new Map(),
    new Map(),
    [],
    'Africa/Johannesburg',
    0,
  );
  assert.equal(noStock.stockDeductionStatus, 'No Stock Mapping Required');
  assert.equal(noStock.modifierMarkedStockDeducting, false);

  const remove = standardizeModifierSalesRow(
    baseRow,
    { ...baseSelection, stockActionType: 'REMOVE_INGREDIENT' },
    new Map(),
    new Map(),
    [],
    'Africa/Johannesburg',
    0,
  );
  assert.equal(remove.stockDeductionStatus, 'Applied to Base Recipe');
  assert.equal(remove.modifierMarkedStockDeducting, false);
});


test('modifier catalogue enrichment uses the current status column and cannot regress to legacy active', async () => {
  const queries: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind() {
            return {
              async all() {
                if (sql.includes('FROM yoco_modifier_groups')) {
                  return { results: [] };
                }
                if (sql.includes('FROM modifier_rules')) {
                  assert.match(sql, /status\s*=\s*'active'/);
                  assert.doesNotMatch(sql, /\bactive\s*=\s*1\b/);
                  return { results: [] };
                }
                throw new Error(`Unexpected SQL: ${sql}`);
              },
            };
          },
        };
      },
    },
  };

  const result = await loadModifierCatalogue(env as any, 'workspace-1', true);
  assert.equal(result.size, 0);
  assert.equal(queries.some((sql) => sql.includes('FROM modifier_rules')), true);
});


test('modifier action snapshots are enriched with bounded lookup queries rather than a stock movement join', async () => {
  const queries: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind(...values: unknown[]) {
            assert.equal(values[0], 'workspace-1');
            return {
              async all() {
                return {
                  results: [
                    {
                      source_order_id: 'order-1',
                      source_line_id: 'line-1',
                      source_key: 'modifier-1',
                      source_name: 'Decaf',
                      rule_id: 'rule-1',
                      action_type: 'ADD_STOCK_ITEM',
                    },
                  ],
                };
              },
            };
          },
        };
      },
    },
  };
  const warnings: Array<{ code: string; level: string; message: string }> = [];
  const rows = await enrichModifierUsageRowsWithActionSnapshots(
    env as any,
    'workspace-1',
    [
      {
        id: 'movement-1',
        document_id: 'order-1',
        metadata_json: JSON.stringify({
          source_line_id: 'line-1',
          source_modifier_id: 'modifier-1',
        }),
      },
    ],
    warnings,
  );

  assert.equal(rows[0].movement_modifier_source_name, 'Decaf');
  assert.equal(rows[0].movement_modifier_action_type, 'ADD_STOCK_ITEM');
  assert.equal(warnings.length, 0);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /source_order_id IN/);
  assert.doesNotMatch(queries[0], /JOIN\s+modifier_sale_action_snapshots/i);
  assert.doesNotMatch(queries[0], /LIKE\s+'%:'/i);
});

test('modifier action snapshot lookup fails open without taking down the report', async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                throw new Error('simulated snapshot schema mismatch');
              },
            };
          },
        };
      },
    },
  };
  const source = {
    id: 'movement-1',
    document_id: 'order-1',
    metadata_json: JSON.stringify({ source_line_id: 'line-1' }),
  };
  const warnings: Array<{ code: string; level: string; message: string }> = [];
  const rows = await enrichModifierUsageRowsWithActionSnapshots(
    env as any,
    'workspace-1',
    [source],
    warnings,
  );

  assert.deepEqual(rows, [source]);
  assert.equal(
    warnings.some((warning) => warning.code === 'modifier-action-snapshot-enrichment-unavailable'),
    true,
  );
});
