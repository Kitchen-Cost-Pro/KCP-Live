import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { averageModifierOptionValue } from './services/modifierCostService.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('modifier average uses total catalogue options as the denominator', () => {
  assert.equal(averageModifierOptionValue([7, 7, 7, 7, 7], 5), 7);
  assert.equal(averageModifierOptionValue([5, 10, 15], 3), 10);
  assert.equal(averageModifierOptionValue([7, 7], 5), 2.8);
  assert.equal(averageModifierOptionValue([], 0), 0);
});

test('recipe display keeps hidden modifier options available to the costing engine', () => {
  const recipes = read('src/components/Recipes.js');
  assert.match(recipes, /const catalogueItems = recipes\.items \|\| \[\]/);
  assert.match(recipes, /const modifierItems = catalogueItems\.filter\(isModifierRecipeItem\)/);
  assert.match(recipes, /allRecipeItems: \[\.\.\.allItems, \.\.\.modifierItems\]/);
  assert.match(recipes, /const allItems = recipes\.allRecipeItems \|\| \[/);
  assert.match(recipes, /findAttachedModifierRows\(item, allItems, attachedGroups\)/);
});

test('combined modifier averages use the attached option count', () => {
  const recipes = read('src/components/Recipes.js');
  assert.match(recipes, /const totalModifierOptions = attachedGroups\.reduce/);
  assert.match(recipes, /averageModifierOptionValue\([\s\S]*modifier\.modifierCost[\s\S]*totalModifierOptions/);
  assert.match(recipes, /averageModifierOptionValue\([\s\S]*modifier\.modifierPrice[\s\S]*totalModifierOptions/);
});
