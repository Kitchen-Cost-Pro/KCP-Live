import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const adminSource = join(root, 'dist', 'KCP Admin ConsoleByYOCO.html');
const adminDirectory = join(root, 'dist', 'admin');
const adminTarget = join(adminDirectory, 'index.html');

if (!existsSync(adminSource)) {
  throw new Error(`Admin console build artifact not found: ${adminSource}`);
}

mkdirSync(adminDirectory, { recursive: true });
copyFileSync(adminSource, adminTarget);

// The admin HTML uses a relative favicon URL, so retain it under /admin/ too.
const faviconSource = join(root, 'dist', 'admin-favicon.svg');
if (existsSync(faviconSource)) {
  copyFileSync(faviconSource, join(adminDirectory, 'admin-favicon.svg'));
}

const workerPath = join(root, 'dist', '_worker.js');
const assetsPath = join(root, 'dist', 'assets');

if (existsSync(workerPath) && existsSync(assetsPath)) {
  const stockTakeChunk = readdirSync(assetsPath)
    .find((fileName) => /^stockTakeService-[\w-]+\.js$/.test(fileName));

  if (stockTakeChunk) {
    const worker = readFileSync(workerPath, 'utf8')
      .replace('__STOCK_TAKE_SERVICE_CHUNK__', `/assets/${stockTakeChunk}`);
    writeFileSync(workerPath, worker);
  }
}
