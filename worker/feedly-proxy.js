// Pwrss proxy — a tiny Cloudflare Worker.
//
//   /v3/*          → https://api.feedly.com/v3/*   (adds CORS headers)
//   /fetch?url=…   → fetches an article page for Reader mode
//   /auth/config   → { enabled, clientId } for "Sign in with Feedly"
//   /auth/token    → exchanges an OAuth code for tokens (holds the client secret)
//   /auth/refresh  → refreshes an access token
//
// Environment variables (Worker → Settings → Variables):
//   ALLOWED_ORIGINS  comma-separated origins allowed to use the proxy,
//                    e.g. "https://rpietzsch.github.io,http://localhost:8080"
//   PROXY_KEY        optional shared secret; clients must send X-Proxy-Key
//   FEEDLY_CLIENT_ID / FEEDLY_CLIENT_SECRET   OAuth client issued by Feedly (store as secrets)

const FEEDLY = 'https://api.feedly.com';
const FEEDLY_AUTH = 'https://cloud.feedly.com/v3/auth/token';
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Pwrss/1.0';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Proxy-Key',
    'Access-Control-Expose-Headers': 'X-Final-Url',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(host)
    || host.endsWith('.local') || host.endsWith('.internal');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = !allowed.length || allowed.includes(origin);
    const headers = cors(originOk ? origin : allowed[0]);

    // Public liveness check: open it in a browser to confirm the worker is deployed.
    if (url.pathname === '/health') {
      return new Response(`Pwrss proxy OK\norigins: ${allowed.length ? 'restricted' : 'ANY'}\nkey: ${env.PROXY_KEY ? 'required' : 'not set'}\n`, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!originOk) return new Response('Origin not allowed', { status: 403, headers });
    if (env.PROXY_KEY && request.headers.get('X-Proxy-Key') !== env.PROXY_KEY) {
      return new Response('Bad proxy key', { status: 403, headers });
    }

    try {
      if (url.pathname.startsWith('/auth/')) return await handleAuth(url, request, env, headers, allowed);

      if (url.pathname.startsWith('/v3/')) {
        const upstream = new Request(FEEDLY + url.pathname + url.search, {
          method: request.method,
          headers: {
            Authorization: request.headers.get('Authorization') || '',
            'Content-Type': request.headers.get('Content-Type') || 'application/json',
            'User-Agent': 'Pwrss/1.0',
          },
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
        });
        const res = await fetch(upstream);
        const h = new Headers(headers);
        h.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
        h.set('Cache-Control', 'no-store');
        return new Response(res.body, { status: res.status, headers: h });
      }

      if (url.pathname === '/fetch') {
        const target = url.searchParams.get('url');
        let t;
        try { t = new URL(target); } catch { return new Response('Bad url', { status: 400, headers }); }
        if (!/^https?:$/.test(t.protocol) || isPrivateHost(t.hostname)) {
          return new Response('URL not allowed', { status: 400, headers });
        }
        const res = await fetch(t.href, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en,*;q=0.5' },
          redirect: 'follow',
          cf: { cacheTtl: 600, cacheEverything: true },
        });
        const type = res.headers.get('Content-Type') || '';
        if (!/html|xml|text/i.test(type)) return new Response('Not an HTML page', { status: 415, headers });
        const len = Number(res.headers.get('Content-Length') || 0);
        if (len > MAX_PAGE_BYTES) return new Response('Page too large', { status: 413, headers });
        const h = new Headers(headers);
        h.set('Content-Type', 'text/html; charset=utf-8');
        h.set('X-Final-Url', res.url || t.href);
        h.set('Cache-Control', 'private, max-age=600');
        // decode using the page's charset, re-encode as UTF-8
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_PAGE_BYTES) return new Response('Page too large', { status: 413, headers });
        let charset = /charset=([^;]+)/i.exec(type)?.[1]?.trim();
        if (!charset) {
          const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
          charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
        }
        let text;
        try { text = new TextDecoder(charset || 'utf-8').decode(buf); } catch { text = new TextDecoder().decode(buf); }
        return new Response(text, { status: res.status, headers: h });
      }

      return new Response('Not found', { status: 404, headers });
    } catch (e) {
      return new Response('Proxy error: ' + e.message, { status: 502, headers });
    }
  },
};

function json(body, status, headers) {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

// OAuth endpoints. The client secret stays here; the browser only sees tokens.
async function handleAuth(url, request, env, headers, allowed) {
  const id = env.FEEDLY_CLIENT_ID;
  const secret = env.FEEDLY_CLIENT_SECRET;

  if (url.pathname === '/auth/config' && request.method === 'GET') {
    return json({ enabled: !!(id && secret), clientId: id && secret ? id : null }, 200, headers);
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, headers);
  if (!id || !secret) return json({ error: 'oauth_not_configured' }, 501, headers);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, headers); }

  let params;
  if (url.pathname === '/auth/token') {
    let ru;
    try { ru = new URL(body.redirect_uri); } catch { return json({ error: 'bad_redirect_uri' }, 400, headers); }
    if (allowed.length && !allowed.includes(ru.origin)) return json({ error: 'redirect_uri_not_allowed' }, 400, headers);
    if (!body.code) return json({ error: 'missing_code' }, 400, headers);
    params = { code: body.code, client_id: id, client_secret: secret, redirect_uri: body.redirect_uri, grant_type: 'authorization_code' };
  } else if (url.pathname === '/auth/refresh') {
    if (!body.refresh_token) return json({ error: 'missing_refresh_token' }, 400, headers);
    params = { refresh_token: body.refresh_token, client_id: id, client_secret: secret, grant_type: 'refresh_token' };
  } else {
    return json({ error: 'not_found' }, 404, headers);
  }

  const res = await fetch(FEEDLY_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Pwrss/1.0' },
    body: JSON.stringify(params),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || !data.access_token) {
    return json({ error: data.errorMessage || data.error || `feedly_${res.status}` }, res.ok ? 502 : res.status, headers);
  }
  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token, // absent on refresh responses
    expires_in: data.expires_in,
    id: data.id,
  }, 200, headers);
}
