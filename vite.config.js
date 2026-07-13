import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = String(
    env.VITE_CLOUDFLARE_API_URL ||
    env.VITE_KCP_API_BASE_URL ||
    ''
  ).replace(/\/+$/, '');

  return {
    plugins: [adminDevRoute()],
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
