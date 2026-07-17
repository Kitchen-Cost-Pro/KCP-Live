import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModifierLinkedItems } from './modifierLinkedItems.js';

const menuItems = [
  { id: 'americano', name: 'Americano', category: 'caffe' },
  { id: 'cappuccino', name: 'Cappuccino', category: 'caffe' },
  { id: 'americano-variant', name: 'Americano - AME001', category: 'Menu item' },
  { id: 'cappuccino-variant', name: 'Cappuccino - CAP001', category: 'Menu item' },
];

test('linked items modal uses assigned menu items instead of merging recipe product links', () => {
  const linked = resolveModifierLinkedItems({
    linkedItemIds: ['americano', 'cappuccino'],
    linkedItemNames: ['Americano', 'Cappuccino'],
    linkedProductIds: ['americano-variant', 'cappuccino-variant'],
    linkedProductNames: ['Americano - AME001', 'Cappuccino - CAP001'],
  }, menuItems);

  assert.deepEqual(linked, [
    { name: 'Americano', category: 'caffe' },
    { name: 'Cappuccino', category: 'caffe' },
  ]);
});

test('linked items modal falls back to recipe product links when no assignment data exists', () => {
  const linked = resolveModifierLinkedItems({
    linkedProductIds: ['americano-variant'],
    linkedProductNames: ['Americano - AME001'],
  }, menuItems);

  assert.deepEqual(linked, [
    { name: 'Americano - AME001', category: 'Menu item' },
  ]);
});
