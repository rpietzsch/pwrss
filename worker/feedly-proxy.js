// Pwrss proxy — a tiny Cloudflare Worker.
//
//   /v3/*          → https://api.feedly.com/v3/*   (adds CORS headers)
//   /fetch?url=…   → fetches an article page for Reader mode
//   POST /feeds    → fetches a batch of RSS/Atom feeds: { feeds: [{ url, etag, modified }] }
//   POST /sync     → cross-device sync of read/saved state and the feed list (Durable Object `SYNC`)
//   /auth/config   → { enabled, clientId } for "Sign in with Feedly"
//   /auth/token    → exchanges an OAuth code for tokens (holds the client secret)
//   /auth/refresh  → refreshes an access token
//
// Environment variables (Worker → Settings → Variables):
//   ALLOWED_ORIGINS  comma-separated origins allowed to use the proxy,
//                    e.g. "https://rpietzsch.github.io,http://localhost:8080"
//   PROXY_KEY        optional shared secret; clients must send X-Proxy-Key
//   FEEDLY_CLIENT_ID / FEEDLY_CLIENT_SECRET   OAuth client issued by Feedly (store as secrets)

import { SyncStore } from './sync-store.js';
export { SyncStore }; // Durable Object class (bound as SYNC in wrangler.toml)

const FEEDLY = 'https://api.feedly.com';
const FEEDLY_AUTH = 'https://cloud.feedly.com/v3/auth/token';
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_FEEDS_PER_REQUEST = 40;
const FEED_TIMEOUT_MS = 8000;
const MAX_SYNC_BYTES = 1_500_000;
const FEED_CONCURRENCY = 6; // Workers allow 6 simultaneous outgoing connections per request
const FEED_UA = 'Mozilla/5.0 (compatible; Pwrss/1.0; +https://github.com/rpietzsch/pwrss)';
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
      return new Response(`Pwrss proxy OK\norigins: ${allowed.length ? 'restricted' : 'ANY'}\nkey: ${env.PROXY_KEY ? 'required' : 'not set'}\nsync: ${env.SYNC ? 'ready' : 'not set up'}\n`, {
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

      if (url.pathname === '/sync' && request.method === 'POST') {
        // Personal data: never serve it without a proxy key.
        if (!env.PROXY_KEY) return json({ error: 'sync_requires_proxy_key' }, 403, headers);
        if (!env.SYNC) return json({ error: 'sync_not_configured' }, 501, headers);
        const text = await request.text();
        if (text.length > MAX_SYNC_BYTES) return json({ error: 'too_large' }, 413, headers);
        const stub = env.SYNC.get(env.SYNC.idFromName('main'));
        const res = await stub.fetch(new Request('https://sync.internal/', { method: 'POST', body: text, headers: { 'Content-Type': 'application/json' } }));
        const h = new Headers(headers);
        h.set('Content-Type', 'application/json');
        h.set('Cache-Control', 'no-store');
        return new Response(res.body, { status: res.status, headers: h });
      }

      if (url.pathname === '/feeds' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, headers); }
        const feeds = Array.isArray(body?.feeds) ? body.feeds : null;
        if (!feeds || feeds.length > MAX_FEEDS_PER_REQUEST) return json({ error: 'bad_feeds' }, 400, headers);
        return json({ results: await pool(feeds, FEED_CONCURRENCY, fetchFeed) }, 200, headers);
      }

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
        const text = decode(buf, type);
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

function decode(buf, type) {
  let cs = /charset=([^;]+)/i.exec(type || '')?.[1]?.trim();
  if (!cs) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
    cs = /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(head)?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

// Read at most `max` bytes of a response body.
async function readLimited(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0, truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > max) { truncated = true; await reader.cancel().catch(() => {}); break; }
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return { buf: truncated ? all.subarray(0, max) : all, truncated };
}

// Huge feeds (podcasts with hundreds of episodes): keep the newest complete items and close the document.
function cutAtLastItem(text) {
  const item = text.lastIndexOf('</item>');
  const entry = text.lastIndexOf('</entry>');
  if (item < 0 && entry < 0) return null;
  if (entry > item) return text.slice(0, entry + 8) + '\n</feed>';
  const rdf = /<rdf:RDF/i.test(text.slice(0, 2000));
  return text.slice(0, item + 7) + (rdf ? '\n</rdf:RDF>' : '\n</channel></rss>');
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const snippet = (text, n = 160) => String(text || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One feed of a /feeds batch. Never throws: failures become { status, error, detail }.
async function fetchFeed(f) {
  const first = await fetchFeedOnce(f);
  if (!RETRY_STATUS.has(first.status)) return first;
  await sleep(600);
  return fetchFeedOnce(f);
}

async function fetchFeedOnce(f) {
  const url = f?.url;
  try {
    const t = new URL(url);
    if (!/^https?:$/.test(t.protocol) || isPrivateHost(t.hostname)) return { url, status: 0, error: 'URL not allowed' };
    const headers = {
      'User-Agent': FEED_UA,
      Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    };
    if (f.etag) headers['If-None-Match'] = f.etag;
    if (f.modified) headers['If-Modified-Since'] = f.modified;
    const res = await fetch(t.href, { headers, redirect: 'follow', signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    if (res.status === 304) return { url, status: 304 };
    const type = res.headers.get('Content-Type') || '';
    if (!res.ok) {
      let detail = '';
      try { detail = snippet(await res.text()); } catch {}
      return { url, status: res.status, error: `HTTP ${res.status}`, detail, finalUrl: res.url || t.href, server: res.headers.get('Server') || undefined };
    }
    const { buf, truncated } = await readLimited(res, MAX_FEED_BYTES);
    let body = decode(buf, type);
    if (truncated) {
      body = cutAtLastItem(body);
      if (!body) return { url, status: 0, error: 'Feed too large' };
    }
    return {
      url,
      status: 200,
      finalUrl: res.url || t.href,
      contentType: type,
      etag: res.headers.get('ETag') || null,
      modified: res.headers.get('Last-Modified') || null,
      truncated: truncated || undefined,
      body,
    };
  } catch (e) {
    return { url, status: 0, error: e?.name === 'TimeoutError' ? 'Timed out' : (e?.message || 'Fetch failed') };
  }
}
