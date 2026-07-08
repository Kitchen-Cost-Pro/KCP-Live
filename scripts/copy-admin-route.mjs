import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'dist', 'KCP Admin ConsoleByYOCO.html');
const target = join(root, 'dist', 'admin', 'index.html');

if (!existsSync(source)) {
  throw new Error(`Admin console build artifact not found: ${source}`);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);

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
