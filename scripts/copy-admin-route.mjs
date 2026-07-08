import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'dist', 'KCP Admin ConsoleByYOCO.html');
const target = join(root, 'dist', 'admin', 'index.html');

if (!existsSync(source)) {
  throw new Error(`Admin console build artifact not found: ${source}`);
}

// The admin console HTML lives in public/ and is copied verbatim by Vite (no import.meta.env
// substitution happens there), so it ships a %%VITE_TURNSTILE_SITEKEY%% placeholder that we
// replace here at build time instead, reading from the same .env files Vite itself loads.
function loadEnvVar(name) {
  if (process.env[name]) return process.env[name];
  const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';
  const candidates = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
  for (const fileName of candidates) {
    const filePath = join(root, fileName);
    if (!existsSync(filePath)) continue;
    const match = readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${name}=`));
    if (match) return match.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const turnstileSiteKey = loadEnvVar('VITE_TURNSTILE_SITEKEY');
if (!turnstileSiteKey) {
  console.warn('[copy-admin-route] VITE_TURNSTILE_SITEKEY is not set — admin console Turnstile widget will ship without a sitekey.');
}
const adminHtml = readFileSync(source, 'utf8').replaceAll('%%VITE_TURNSTILE_SITEKEY%%', turnstileSiteKey);
writeFileSync(source, adminHtml);

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
