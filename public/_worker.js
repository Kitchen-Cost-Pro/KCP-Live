const DEFAULT_API_ORIGIN = 'https://kcp-api-v2.adminkitchencostpro.workers.dev';
const STOCK_TAKE_SERVICE_CHUNK = '__STOCK_TAKE_SERVICE_CHUNK__';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      // env.API_ORIGIN is a Pages project variable/secret — unset means this is the production
      // Pages project, which keeps proxying to production. Only a dev/preview Pages project
      // needs it set, to point at its own Worker instead of hardcoded production.
      const apiUrl = new URL(String(env.API_ORIGIN || DEFAULT_API_ORIGIN));
      const target = new URL(request.url);
      target.protocol = apiUrl.protocol;
      target.host = apiUrl.host;
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
