import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';

function adminDevRoute() {
  return {
    name: 'kcp-admin-dev-route',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = String(request.url || '').split('?')[0];
        if (!['/admin', '/admin/', '/admin/index.html'].includes(pathname)) {
          next();
          return;
        }

        const adminHtml = readFileSync(
          resolve(process.cwd(), 'public/KCP Admin ConsoleByYOCO.html'),
          'utf8'
        );
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(adminHtml);
      });
    }
  };
}

// index.html's favicon links use a %VITE_FAVICON_PATH% placeholder so local dev and the deployed
// site can show different tab icons — but Vite's own %VAR% substitution leaves the placeholder
// LITERALLY IN THE HTML if the env var is undefined at build time (rather than erroring or falling
// back), and the browser then requests a URL literally named "%VITE_FAVICON_PATH%", which 400s.
// This happened in production: VITE_CLOUDFLARE_API_URL was configured directly in the Cloudflare
// Pages project (not via a git-tracked .env file — .env/.env.dev are gitignored, correctly, since
// this repo's deploy pulls from a separate GitHub-tracked copy), but VITE_FAVICON_PATH never was.
// A plain HTML transform hook with a guaranteed fallback fixes this regardless of whether that
// dashboard variable ever gets configured — the site's own favicon is never a secret worth gating
// on external config in the first place.
function faviconFallback(faviconPath) {
  return {
    name: 'kcp-favicon-fallback',
    transformIndexHtml(html) {
      return html.replaceAll('%VITE_FAVICON_PATH%', faviconPath || '/favicon.svg');
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = String(
    env.VITE_CLOUDFLARE_API_URL ||
    env.VITE_KCP_API_BASE_URL ||
    ''
  ).replace(/\/+$/, '');

  return {
    plugins: [tailwindcss(), adminDevRoute(), faviconFallback(env.VITE_FAVICON_PATH)],
    server: apiTarget
      ? {
          proxy: {
            '/api': {
              target: apiTarget,
              changeOrigin: true,
              secure: true
            }
          }
        }
      : undefined,
    build: {
      chunkSizeWarningLimit: 2048
    }
  };
});
