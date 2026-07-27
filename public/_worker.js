const API_ORIGIN = 'https://kcp-api-v2.adminkitchencostpro.workers.dev';
const API_URL = new URL(API_ORIGIN);
const STOCK_TAKE_SERVICE_CHUNK = '__STOCK_TAKE_SERVICE_CHUNK__';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (url.pathname === '/admin') {
        const target = new URL('/admin/', url.origin);
        target.search = url.search;
        return Response.redirect(target.toString(), 308);
      }

      if (url.pathname === '/admin/') {
        const target = new URL('/admin/index.html', url.origin);
        const response = await env.ASSETS.fetch(new Request(target.toString(), {
          method: request.method,
          headers: request.headers
        }));
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const target = new URL(request.url);
      target.protocol = API_URL.protocol;
      target.host = API_URL.host;
      return fetch(new Request(target.toString(), request));
    }

    if (url.pathname === STOCK_TAKE_SERVICE_CHUNK) {
      return env.ASSETS.fetch(request);
    }

    if (/^\/assets\/stockTakeService-[^/]+\.js$/.test(url.pathname) && STOCK_TAKE_SERVICE_CHUNK) {
      const target = new URL(STOCK_TAKE_SERVICE_CHUNK, url.origin);
      const response = await env.ASSETS.fetch(new Request(target.toString(), {
        method: request.method,
        headers: request.headers
      }));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...Object.fromEntries(response.headers),
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store'
        }
      });
    }

    return env.ASSETS.fetch(request);
  }
};
