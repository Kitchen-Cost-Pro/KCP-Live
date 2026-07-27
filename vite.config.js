import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

const DEFAULT_API_ORIGIN = 'https://kcp-api-v2.adminkitchencostpro.workers.dev';
const ADMIN_SOURCE = resolve(process.cwd(), 'public', 'KCP Admin ConsoleByYOCO.html');

function adminDevelopmentRoute() {
  return {
    name: 'kcp-admin-development-route',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url || '/', 'http://localhost');

        if (url.pathname === '/admin') {
          response.statusCode = 308;
          response.setHeader('location', `/admin/${url.search}`);
          response.end();
          return;
        }

        if (url.pathname !== '/admin/' && url.pathname !== '/admin/index.html') {
          next();
          return;
        }

        try {
          const source = await readFile(ADMIN_SOURCE, 'utf8');
          const html = await server.transformIndexHtml(url.pathname, source);
          response.statusCode = 200;
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.setHeader('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiOrigin = String(env.VITE_CLOUDFLARE_API_URL || DEFAULT_API_ORIGIN)
    .trim()
    .replace(/\/+$/, '');

  return {
    plugins: [adminDevelopmentRoute()],
    server: {
      proxy: {
        '/api': {
          target: apiOrigin,
          changeOrigin: true,
          secure: true
        }
      }
    }
  };
});
