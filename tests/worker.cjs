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

  // ---- /feeds: concurrency, retry, user agent, diagnostics, huge feeds ----
  let inFlight = 0, maxInFlight = 0;
  const seenUA = [];
  const attempts = {};
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seenUA.push(init?.headers?.['User-Agent']);
    attempts[u] = (attempts[u] || 0) + 1;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    if (u.includes('flaky')) return attempts[u] === 1 ? new Response('busy', { status: 503 }) : new Response('<rss><channel><title>ok</title></channel></rss>');
    if (u.includes('always503')) return new Response('<html><body><h1>Sorry,  we are not able   to serve your requests this quickly.</h1><script>x()</script></body></html>', { status: 503 });
    if (u.includes('podcast')) {
      const items = Array.from({ length: 4000 }, (_, i) => `<item><title>Episode ${i}</title><guid>g${i}</guid><description>${'x'.repeat(900)}</description></item>`).join('\n');
      return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title>\n${items}\n</channel></rss>`, { headers: { 'Content-Type': 'application/rss+xml' } });
    }
    if (u.includes('hugeatom')) {
      const items = Array.from({ length: 4000 }, (_, i) => `<entry><title>E${i}</title><id>i${i}</id><summary>${'y'.repeat(900)}</summary></entry>`).join('\n');
      return new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>BigAtom</title>\n${items}\n</feed>`);
    }
    return new Response('<rss><channel><title>t</title></channel></rss>');
  };
  r = await post(Array.from({ length: 25 }, (_, i) => ({ url: `https://c${i}.example/f` })));
  const many = (await j(r)).results;
  check('feeds: at most 6 fetches in flight', maxInFlight <= 6 && maxInFlight > 1 && many.every((x) => x.status === 200), maxInFlight);
  check('feeds: honest feed-reader user agent', seenUA.every((ua) => /Pwrss\/1\.0/.test(ua) && !/Chrome/.test(ua)), seenUA[0]);
  r = await post([{ url: 'https://flaky.example/f' }, { url: 'https://always503.example/f' }]);
  const rt = (await j(r)).results;
  check('feeds: 503 is retried once and can recover', rt[0].status === 200 && attempts['https://flaky.example/f'] === 2, rt[0]);
  check('feeds: persistent 503 reports status and what the server said', rt[1].status === 503 && attempts['https://always503.example/f'] === 2 && rt[1].detail === 'Sorry, we are not able to serve your requests this quickly.', rt[1]);
  r = await post([{ url: 'https://podcast.example/f' }, { url: 'https://hugeatom.example/f' }]);
  const big = (await j(r)).results;
  const pc = big[0].body;
  check('feeds: huge RSS keeps the newest complete items and stays well-formed', big[0].status === 200 && big[0].truncated && pc.includes('Episode 0') && pc.trimEnd().endsWith('</item>\n</channel></rss>') && !pc.includes('Episode 3999') && pc.length < 2.2 * 1024 * 1024, [big[0].truncated, pc.length]);
  check('feeds: huge Atom is cut and closed too', big[1].status === 200 && big[1].body.trimEnd().endsWith('</entry>\n</feed>') && big[1].body.includes('<id>i0</id>'), big[1].body.slice(-60));

  // ---- failures report where a redirect ended up ----
  globalThis.fetch = async (url) => {
    const res = new Response('', { status: 419, headers: { Server: 'nginx' } });
    Object.defineProperty(res, 'url', { value: 'https://target.example/rss' });
    return res;
  };
  r = await post([{ url: 'https://redirecting.example/rss' }]);
  const fin = (await j(r)).results[0];
  check('feeds: failure includes the final URL after redirects', fin.status === 419 && fin.finalUrl === 'https://target.example/rss' && fin.server === 'nginx', fin);

  process.exit(failures ? 1 : 0);
})();
