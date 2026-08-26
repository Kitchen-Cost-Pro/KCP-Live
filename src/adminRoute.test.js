import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

test('admin console remains available at the public source path', () => {
  assert.equal(existsSync(resolve(root, 'public/KCP Admin ConsoleByYOCO.html')), true);
  assert.equal(existsSync(resolve(root, 'public/admin-login-bg.png')), true);
  assert.equal(existsSync(resolve(root, 'public/admin-favicon.svg')), true);
});

test('Vite serves /admin in development and the build copies it to /admin/index.html', () => {
  const viteConfig = read('vite.config.js');
  const packageJson = JSON.parse(read('package.json'));
  const copyScript = read('scripts/copy-admin-route.mjs');

  assert.match(viteConfig, /\/admin\/index\.html/);
  assert.match(viteConfig, /public\/KCP Admin ConsoleByYOCO\.html/);
  assert.match(packageJson.scripts.build, /copy-admin-route\.mjs/);
  assert.match(copyScript, /dist', 'admin'/);
  assert.match(copyScript, /admin-favicon\.svg/);
});
