const API_ORIGIN = 'https://kcp-api-v2.adminkitchencostpro.workers.dev';
const API_URL = new URL(API_ORIGIN);
const STOCK_TAKE_SERVICE_CHUNK = '/assets/stockTakeService-DAC1fRgu.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
