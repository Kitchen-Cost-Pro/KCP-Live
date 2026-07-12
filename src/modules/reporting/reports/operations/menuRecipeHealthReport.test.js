import assert from 'node:assert/strict';
import test from 'node:test';
import { getReportDefinition, listReports } from '../index.js';
import { buildMenuRecipeHealthViews, menuRecipeHealthReport } from './menuRecipeHealthReport.js';

const payload = {
  rows: [
    {
      id: 'menu-health:burger',
      menuItemId: 'burger',
      menuItemName: 'Burger',
      yocoProductVariant: 'Burger / Default',
      category: 'Burgers',
      menuCategory: 'Burgers',
      yocoCategory: 'Food',
      locationPriceStatus: 'Multi-location Price',
      sellingPriceInclVat: 115,
      vat: 15,
      sellingPriceExVat: 100,
      recipeCostExVat: 35,
      modifierCostRisk: 'No Modifier Risk Found',
      foodCostPercent: 0.35,
      grossProfit: 65,
      gpPercent: 0.65,
      recipeStatus: 'Recipe Ready',
      stockDeductionStatus: 'Ready',
      yocoMappingStatus: 'Mapped',
      riskStatus: 'Healthy',
      warningsText: ''
    },
    {
      id: 'menu-health:chips',
      menuItemId: 'chips',
      menuItemName: 'Chips',
      category: 'Sides',
      menuCategory: 'Sides',
      sellingPriceInclVat: 0,
      vat: 0,
      sellingPriceExVat: 0,
      recipeCostExVat: 0,
      foodCostPercent: 0,
      grossProfit: 0,
      gpPercent: 0,
      recipeStatus: 'Missing Recipe',
      stockDeductionStatus: 'Not Ready',
      yocoMappingStatus: 'Missing YOCO Product Mapping',
      riskStatus: 'Critical',
      warningsText: 'Missing recipe; Missing YOCO product mapping'
    }
  ],
  recipeRows: [
    {
      id: 'line:bun',
      menuItemId: 'burger',
      menuItemName: 'Burger',
      recipeSubRecipe: 'Burger',
      recipeLevel: 'Level 1',
      recipeLineType: 'Direct Ingredient',
      ingredientName: 'Bun',
      inventoryCategory: 'Bakery',
      qtyRequired: 1,
      baseUom: 'ea',
      unitCostExVat: 5,
      lineCost: 5,
      status: 'Costed'
    },
    {
      id: 'line:mince',
      menuItemId: 'burger',
      menuItemName: 'Burger',
      recipeSubRecipe: 'Patty Mix',
      recipeLevel: 'Level 2',
      recipeLineType: 'Sub-Recipe Ingredient',
      ingredientName: 'Mince',
      inventoryCategory: 'Meat',
      qtyRequired: 0.3,
      baseUom: 'kg',
      unitCostExVat: 100,
      lineCost: 30,
      status: 'Costed'
    }
  ],
  pricingRows: [
    {
      id: 'price:burger:loc-a',
      menuItemId: 'burger',
      menuItemName: 'Burger',
      yocoProductName: 'Burger',
      yocoVariantName: 'Default',
      locationName: 'Upstairs',
      sellingPriceInclVat: 115,
      vatRate: 0.15,
      vat: 15,
      sellingPriceExVat: 100,
      recipeCostExVat: 35,
      grossProfit: 65,
      gpPercent: 0.65,
      foodCostPercent: 0.35,
      priceStatus: 'Multi-location Price'
    }
  ],
  warningRows: [
    {
      id: 'warning:chips',
      severity: 'Critical',
      menuItemId: 'chips',
      menuItemName: 'Chips',
      category: 'Sides',
      issueType: 'Missing recipe',
      issue: 'Menu item has no recipe.',
      impact: 'Sales will not deduct recipe stock.',
      suggestedFix: 'Create or link a recipe.',
      sourceId: 'chips'
    },
    {
      id: 'warning:receipt',
      severity: 'Critical',
      menuItemName: 'Burger',
      issueType: 'Missing receipt ID',
      issue: 'Receipt ID is missing from the provider payload.',
      impact: 'Internal traceability is incomplete.',
      suggestedFix: 'Worker must repair the provider reference.'
    }
  ]
};

test('Menu & Recipe Health is one operations dashboard tile with all required views', () => {
  const visibleIds = listReports().map((report) => report.id);
  assert.ok(visibleIds.includes('menu_recipe_health'));
  assert.equal(visibleIds.filter((id) => ['menu_health', 'recipe_health', 'missing_recipes', 'recipe_cost_warnings', 'yoco_mapping_warnings'].includes(id)).length, 0);
  const report = getReportDefinition('menu_recipe_health');
  assert.equal(report.title, 'Menu & Recipe Health');
  assert.deepEqual(report.availableViews, ['overview', 'menu_items', 'recipe_detail', 'pricing', 'warnings']);
});

test('Menu & Recipe Health builds setup, pricing, recipe detail, and warnings views without mock data', () => {
  const views = buildMenuRecipeHealthViews(payload);
  assert.equal(views.menu_items.length, 2);
  assert.equal(views.recipe_detail.length, 2);
  assert.equal(views.recipe_detail.some((row) => row.recipeLineType === 'Sub-Recipe Ingredient'), true);
  assert.equal(views.pricing[0].priceStatus, 'Multi-location Price');
  assert.equal(views.warnings.length, 1);
  assert.equal(views.warnings[0].severity, 'Critical');
  assert.equal(views.menu_items.find((row) => row.menuItemName === 'Chips').warningsText, 'Missing recipe');
  assert.equal(views.overview.length, 2);
  const burgerOverview = views.overview.find((row) => row.menuCategory === 'Burgers');
  assert.equal(burgerOverview.itemsWithRecipes, 1);
  assert.equal(burgerOverview.avgFoodCostPercent, 0.35);
  assert.equal(menuRecipeHealthReport.emptyState.message.includes('mock'), false);
});

test('Menu & Recipe Health totals recalculate GP and food cost percentages from totals', () => {
  const totals = menuRecipeHealthReport.getTotals({ rows: payload.rows, view: 'menu_items' });
  assert.equal(totals.sellingPriceExVat, 100);
  assert.equal(totals.recipeCostExVat, 35);
  assert.equal(totals.grossProfit, 65);
  assert.equal(totals.gpPercent, 0.65);
  assert.equal(totals.foodCostPercent, 0.35);
});

test('Menu & Recipe Health warnings explain the exact setup issue', async () => {
  const warnings = await menuRecipeHealthReport.validate({ rows: payload.rows, services: {} });
  assert.equal(warnings.some((warning) => /critical menu or recipe setup issues/i.test(warning.message)), false);
  assert.equal(warnings.some((warning) => /Chips.*Missing recipe.*Missing YOCO product mapping/i.test(warning.message)), true);
});
