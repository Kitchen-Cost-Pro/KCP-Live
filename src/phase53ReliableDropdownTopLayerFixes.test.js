import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('Phase 53 keeps application dropdown menus in their owning component while using the browser top layer', () => {
  const portal = read('src/utils/appDropdownPortal.js');

  assert.match(portal, /menu\.setAttribute\('popover', 'manual'\)/);
  assert.match(portal, /menu\.showPopover\(\)/);
  assert.match(portal, /menu\.hidePopover\(\)/);
  assert.match(portal, /menu\.classList\.add\(TOP_LAYER_CLASS\)/);
  assert.doesNotMatch(portal, /document\.body\.append\(menu\)/);
  assert.doesNotMatch(portal, /placeholder\.replaceWith\(menu\)/);
});

test('Phase 53 top-layer menus retain and restore their original component state', () => {
  const portal = read('src/utils/appDropdownPortal.js');

  assert.match(portal, /const originalStyle = menu\.getAttribute\('style'\)/);
  assert.match(portal, /const originalHidden = menu\.hidden/);
  assert.match(portal, /const hadPopoverAttribute = menu\.hasAttribute\('popover'\)/);
  assert.match(portal, /if \(originalStyle === null\) menu\.removeAttribute\('style'\)/);
  assert.match(portal, /menu\.hidden = originalHidden/);
  assert.match(portal, /positionTopLayer\(activeLayer\)/);
  assert.match(portal, /setImportant\(menu, 'top'/);
  assert.match(portal, /setImportant\(menu, 'left'/);
});

test('Phase 53 reporting and pagination selects override legacy inset rules with viewport coordinates', () => {
  const select = read('src/modules/reporting/ui/customSelect.js');

  assert.match(select, /setImportant\(menu, 'left', `\$\{left\}px`\)/);
  assert.match(select, /setImportant\(menu, 'top', `\$\{Math\.max\(VIEWPORT_PADDING, top\)\}px`\)/);
  assert.match(select, /setImportant\(menu, 'right', 'auto'\)/);
  assert.match(select, /setImportant\(menu, 'bottom', 'auto'\)/);
  assert.match(select, /menu\.style\.removeProperty\('right'\)/);
  assert.match(select, /menu\.style\.removeProperty\('bottom'\)/);
});
