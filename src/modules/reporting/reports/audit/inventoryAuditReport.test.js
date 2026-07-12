import test from 'node:test';
import assert from 'node:assert/strict';
import { getReportDefinition, listReports } from '../index.js';
import { buildInventoryAuditViews } from './inventoryAuditReport.js';
import { normalizeApiInventoryAuditCostRow, normalizeApiInventoryAuditRow, normalizeApiInventoryAuditRecipeRow } from '../../api/reportingMappers.js';

const changeRows = [
  {
    id: 'audit-cost-1',
    date: '2026-07-09',
    time: '10:00:00',
    user: 'Jane Manager',
    action: 'Updated Cost',
    entityType: 'Stock Item',
    entityName: 'Beef Patty',
    fieldChanged: 'Unit Cost',
    oldValue: '20',
    newValue: '25',
    locationName: 'Main Kitchen',
    source: 'Audit Event',
    sourceId: 'audit-1',
    highRisk: true
  },
  {
    id: 'audit-recipe-1',
    date: '2026-07-09',
    time: '11:00:00',
    user: 'Chef Admin',
    action: 'Updated Recipe',
    entityType: 'Recipe Ingredient',
    entityName: 'Burger Recipe',
    fieldChanged: 'Quantity',
    oldValue: '0.2',
    newValue: '0.3',
    source: 'Audit Event',
    sourceId: 'audit-2',
    highRisk: true
  },
  {
    id: 'audit-grv-1',
    date: '2026-07-09',
    time: '12:00:00',
    user: 'Jane Manager',
    action: 'Committed GRV',
    entityType: 'GRV',
    entityName: 'GRV grv-1',
    source: 'Stock Movement Source Document',
    sourceId: 'grv-1',
    highRisk: true
  }
];

const costChangeRows = [
  {
    id: 'cost-1',
    date: '2026-07-09',
    time: '10:00:00',
    user: 'Jane Manager',
    itemName: 'Beef Patty',
    oldCostExVat: 20,
    newCostExVat: 25,
    source: 'Audit Event',
    sourceId: 'audit-1'
  }
];

const recipeChangeRows = [
  {
    id: 'recipe-1',
    date: '2026-07-09',
    time: '11:00:00',
    user: 'Chef Admin',
    recipeName: 'Burger Recipe',
    menuItemName: 'Burger',
    changeType: 'Updated Recipe',
    ingredientName: 'Beef Patty',
    oldQty: 0.2,
    newQty: 0.3,
    oldUom: 'kg',
    newUom: 'kg',
    oldCostImpact: 20,
    newCostImpact: 30,
    sourceId: 'audit-2'
  }
];

test('Reporting Dashboard exposes one Inventory Audit tile under operations section', () => {
  const operationsReports = listReports({ section: 'operations' }).map((report) => report.id);
  assert.ok(operationsReports.includes('inventory_audit'));
  assert.equal(getReportDefinition('inventory_audit').title, 'Inventory Audit');
});

test('Inventory Audit builds change, user, entity, cost, recipe, and data quality views', () => {
  const views = buildInventoryAuditViews({
    rows: changeRows,
    costChangeRows,
    recipeChangeRows,
    dataQualityRows: [
      { severity: 'Critical', area: 'Audit', entityType: 'Stock Movement', entityName: 'sale_depletion', issue: 'Missing source ID on stock movement' },
      { severity: 'Critical', area: 'Stock Setup', entityType: 'Stock Item', entityName: 'Flour', issue: 'Missing location name for stock item' }
    ]
  });

  assert.equal(views.change_log.length, 3);
  assert.equal(views.by_user.find((row) => row.user === 'Jane Manager').actions, 2);
  assert.equal(views.by_entity.find((row) => row.entityType === 'GRV').highRiskChanges, 1);
  assert.equal(views.cost_changes[0].costDifference, 5);
  assert.equal(views.cost_changes[0].changePercent, 0.25);
  assert.equal(views.recipe_changes[0].costImpactDifference, 10);
  assert.equal(views.data_quality.length, 1);
  assert.equal(views.data_quality[0].severity, 'Critical');
  assert.match(views.data_quality[0].issue, /location/i);
});

test('Inventory Audit API mappers resolve users, old/new values, and calculated impacts', () => {
  const auditRow = normalizeApiInventoryAuditRow({
    id: 'audit-1',
    created_at: '2026-07-09T10:00:00Z',
    created_by_name: 'Jane Manager',
    event_type: 'updated_cost',
    entity_type: 'stock_item',
    entity_name: 'Beef Patty',
    field_changed: 'unit_cost',
    old_value: '20',
    new_value: '25',
    source_id: 'audit-1'
  });
  assert.equal(auditRow.user, 'Jane Manager');
  assert.equal(auditRow.action, 'updated_cost');
  assert.equal(auditRow.entityType, 'stock_item');

  const costRow = normalizeApiInventoryAuditCostRow({ old_cost_ex_vat: 20, new_cost_ex_vat: 25 });
  assert.equal(costRow.costDifference, 5);
  assert.equal(costRow.changePercent, 0.25);

  const recipeRow = normalizeApiInventoryAuditRecipeRow({ old_cost_impact: 12, new_cost_impact: 18 });
  assert.equal(recipeRow.costImpactDifference, 6);
});
