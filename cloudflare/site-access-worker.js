const redirectMarker = 'x-nk-access-redirect';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['ateliser.top', 'www.ateliser.top'].includes(url.hostname)) {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get(redirectMarker) === '1') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: 'https://www.google.com/',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }

    const upstream = new Request(request);
    upstream.headers.delete(redirectMarker);
    if (url.pathname === '/lyw' || url.pathname.startsWith('/lyw/')) {
      return env.LYW.fetch(upstream);
    }
    return fetch(upstream);
  },
};
