// Unit tests for worker/feedly-proxy.js with a mocked upstream (no network).
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'feedly-proxy.js'), 'utf8');
  const { default: w } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/v3/auth/token')) {
      const b = JSON.parse(init.body);
      if (b.code === 'bad') return new Response(JSON.stringify({ errorMessage: 'invalid code' }), { status: 400 });
      return new Response(JSON.stringify({
        access_token: 'AT', refresh_token: b.grant_type === 'authorization_code' ? 'RT' : undefined, expires_in: 604800, id: 'u1', plan: 'secret-extra',
      }));
    }
    return new Response('{}');
  };

  const ORIGIN = 'https://rpietzsch.github.io';
  const env = { ALLOWED_ORIGINS: ORIGIN, PROXY_KEY: 'k', FEEDLY_CLIENT_ID: 'cid', FEEDLY_CLIENT_SECRET: 'csecret' };
  const req = (p, { method = 'GET', body, origin = ORIGIN, key = 'k' } = {}) => new Request('https://x' + p, {
    method,
    headers: { Origin: origin, 'X-Proxy-Key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = async (r) => JSON.parse(await r.text());

  let r = await w.fetch(new Request('https://x/health'), env);
  check('health is public', r.status === 200 && (await r.text()).startsWith('Pwrss proxy OK'));

  r = await w.fetch(req('/auth/config'), env);
  let c = await j(r);
  check('config exposes client id only', c.enabled === true && c.clientId === 'cid' && !JSON.stringify(c).includes('csecret'));

  r = await w.fetch(req('/auth/config'), { ...env, FEEDLY_CLIENT_SECRET: undefined });
  check('config disabled without secret', (await j(r)).enabled === false);

  r = await w.fetch(req('/auth/config', { origin: 'https://evil.example' }), env);
  check('auth requires allowed origin', r.status === 403);
  r = await w.fetch(req('/auth/config', { key: 'nope' }), env);
  check('auth requires proxy key', r.status === 403);

  r = await w.fetch(req('/auth/token', { method: 'POST', body: { code: 'abc', redirect_uri: ORIGIN + '/pwrss/' } }), env);
  let t = await j(r);
  const sent = JSON.parse(calls.at(-1).init.body);
  check('token exchange returns only token fields', r.status === 200 && t.access_token === 'AT' && t.refresh_token === 'RT' && t.plan === undefined);
  check('token exchange sends secret server-side', sent.client_secret === 'csecret' && sent.grant_type === 'authorization_code' && sent.redirect_uri === ORIGIN + '/pwrss/');

  r = await w.fetch(req('/auth/token', { method: 'POST', body: { code: 'abc', redirect_uri: 'https://evil.example/' } }), env);
  check('redirect_uri origin must be allowed', r.status === 400);

  r = await w.fetch(req('/auth/token', { method: 'POST', body: { code: 'bad', redirect_uri: ORIGIN + '/pwrss/' } }), env);
  check('feedly error is passed on', r.status === 400 && (await j(r)).error === 'invalid code');

  r = await w.fetch(req('/auth/refresh', { method: 'POST', body: { refresh_token: 'RT' } }), env);
  t = await j(r);
  check('refresh works', r.status === 200 && t.access_token === 'AT' && JSON.parse(calls.at(-1).init.body).grant_type === 'refresh_token');

  r = await w.fetch(req('/auth/refresh', { method: 'POST', body: { refresh_token: 'RT' } }), { ...env, FEEDLY_CLIENT_ID: undefined });
  check('501 when OAuth not configured', r.status === 501);

  r = await w.fetch(req('/fetch?url=http://127.0.0.1/'), env);
  check('private hosts still blocked', r.status === 400);

  // ---- /feeds batch ----
  const feedBody = '<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf\xe9</title></channel></rss>';
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('notmod')) return new Response(null, { status: 304 });
    if (u.includes('gone')) return new Response('nope', { status: 404 });
    if (u.includes('boom')) throw new Error('connect failed');
    if (u.includes('big')) return new Response(new Uint8Array(3 * 1024 * 1024), { status: 200 });
    calls.push({ url: u, init });
    const bytes = Uint8Array.from(feedBody, (c) => c.charCodeAt(0));
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/rss+xml', ETag: '"v1"', 'Last-Modified': 'Tue, 01 Jan 2030 00:00:00 GMT' } });
  };
  const post = (feeds) => w.fetch(req('/feeds', { method: 'POST', body: { feeds } }), env);
  r = await post([
    { url: 'https://ok.example/feed', etag: '"old"', modified: 'Mon, 01 Jan 2029 00:00:00 GMT' },
    { url: 'https://notmod.example/f' }, { url: 'https://gone.example/f' }, { url: 'https://boom.example/f' },
    { url: 'https://big.example/f' }, { url: 'http://127.0.0.1/f' }, { url: 'ftp://x.example/f' }, { url: 'not a url' },
  ]);
  const res = (await j(r)).results;
  const hdr = calls.at(-1).init.headers;
  check('feeds: ok feed returns body, etag, decoded charset', res[0].status === 200 && res[0].etag === '"v1"' && res[0].body.includes('Café'), res[0]);
  check('feeds: conditional headers forwarded', hdr['If-None-Match'] === '"old"' && hdr['If-Modified-Since'].includes('2029'));
  check('feeds: 304 passed through', res[1].status === 304 && !res[1].body);
  check('feeds: errors reported per feed', res[2].status === 404 && res[3].status === 0 && res[3].error === 'connect failed', [res[2], res[3]]);
  check('feeds: oversize rejected', res[4].status === 0 && /large/i.test(res[4].error), res[4]);
  check('feeds: private/non-http/invalid URLs rejected', [5, 6, 7].every((i) => res[i].status === 0), res.slice(5));
  r = await post(Array.from({ length: 41 }, (_, i) => ({ url: `https://x${i}.example/f` })));
  check('feeds: batch limited to 40', r.status === 400);
  r = await w.fetch(req('/feeds', { method: 'POST', body: { feeds: [] }, origin: 'https://evil.example' }), env);
  check('feeds: origin check applies', r.status === 403);

  process.exit(failures ? 1 : 0);
})();
