// Two devices syncing through the real Worker code and the real SyncStore (SQLite); only the internet is mocked.
// Usage: node tests/sync.cjs [rootDir=.]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || '.');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) { failures++; if (extra !== undefined) console.log('   ', JSON.stringify(extra)); } };

const now = new Date();
const subst = (s) => s.replace(/PUBDATE_NOW/g, now.toUTCString()).replace(/PUBDATE_HOUR_AGO/g, new Date(now - 3600e3).toUTCString()).replace(/UPDATED_NOW|DATE_ISO_NOW/g, now.toISOString());
const FEEDS = {
  'https://alpha.example/feed.xml': subst(fx('rss.xml')),
  'https://beta.example/atom.xml': subst(fx('atom.xml')),
  'https://gamma.example/rdf': subst(fx('rdf.xml')),
};
const OPML = '<?xml version="1.0"?><opml version="1.0"><body>'
  + '<outline text="Tech"><outline type="rss" text="Alpha Blog" xmlUrl="https://alpha.example/feed.xml"/><outline type="rss" text="Beta Journal" xmlUrl="https://beta.example/atom.xml"/></outline>'
  + '<outline text="Misc"><outline type="rss" text="Gamma" xmlUrl="https://gamma.example/rdf"/></outline>'
  + '</body></opml>';

server.listen(0, async () => {
  const origin = `http://localhost:${server.address().port}`;
  const base = origin + '/';
  const PROXY = 'https://proxy.test';
  const errs = [];

  // ---- the real Worker, with the real Durable Object logic on SQLite ----
  process.emitWarning = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const { default: worker } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'feedly-proxy.mjs')).href);
  const { SyncStore } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'sync-store.mjs')).href);
  const db = new DatabaseSync(':memory:');
  const state = { storage: { sql: { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows, one: () => rows[0] }; } } } };
  const dobj = new SyncStore(state);
  const env = { ALLOWED_ORIGINS: origin, PROXY_KEY: 'secret', SYNC: { idFromName: (n) => n, get: () => ({ fetch: (r) => dobj.fetch(r) }) } };
  const countFlags = () => db.prepare('SELECT COUNT(*) AS c FROM flags').get().c;
  // the internet, as seen by the Worker
  globalThis.fetch = async (url) => {
    const body = FEEDS[String(url)];
    return body ? new Response(body, { headers: { 'Content-Type': 'application/rss+xml' } }) : new Response('nope', { status: 404 });
  };

  const attach = async (page) => {
    await page.route(PROXY + '/**', async (route) => {
      const r = route.request();
      const init = { method: r.method(), headers: r.headers() };
      delete init.headers['content-length'];
      if (r.postData()) init.body = r.postData();
      const res = await worker.fetch(new Request(r.url(), init), env);
      route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    await page.route('https://alpha.example/img/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') }));
    page.on('pageerror', (e) => errs.push(e.message));
  };
  const newDevice = async (browser, key = 'secret') => {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
    const page = await ctx.newPage();
    await attach(page);
    await page.goto(base);
    await page.evaluate(([px, k]) => localStorage.setItem('pwrss.settings', JSON.stringify({ proxy: px, proxyKey: k })), [PROXY, key]);
    await page.reload();
    return page;
  };
  const labels = (p) => p.$$eval('.src-label', (n) => n.map((x) => x.textContent));
  const waitLabel = (p, t) => p.waitForFunction((x) => [...document.querySelectorAll('.src-label')].some((n) => n.textContent === x), t, { timeout: 15000 });
  const syncNow = async (p) => {
    await p.click('.bar [data-action="settings"]');
    await p.waitForSelector('#settings[open]');
    await p.click('#sync-now-btn');
    await p.waitForFunction(() => /Synced|Already in sync/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 15000 });
    await p.click('#settings .dlg-head .icon-btn');
  };

  const b = await chromium.launch();
  try {
    // ================= device A: import, read, save, manage =================
    const A = await newDevice(b);
    await A.click('.welcome [data-action="settings"]');
    await A.setInputFiles('#opml-file', { name: 'f.opml', mimeType: 'text/x-opml', buffer: Buffer.from(OPML) });
    await A.waitForSelector('.entry', { timeout: 15000 });
    await A.waitForTimeout(500);

    await A.locator('.entry', { hasText: 'Second post' }).click(); // opening marks it read
    await A.waitForSelector('.art-head');
    await A.locator('.entry', { hasText: 'Fresh & New' }).click();
    await A.waitForSelector('.art-head');
    await A.keyboard.press('s'); // save for later
    await A.waitForTimeout(1500);

    await A.click('#manage-btn');
    await A.waitForSelector('#manage[open]');
    A.once('dialog', (d) => d.accept('Alpha Renamed'));
    await A.click('.mg-feed:has-text("Alpha Blog") [data-mg="feed-rename"]');
    await A.waitForTimeout(300);
    await A.click('.mg-cat[data-cat="Tech"] [data-mg="cat-down"]'); // Misc before Tech
    await A.waitForTimeout(300);
    await A.click('#manage .primary[data-action="close-manage"]');

    // switch sync on
    await A.click('.bar [data-action="settings"]');
    await A.check('input[name="sync"]');
    await A.click('#settings button[value="save"]');
    await A.waitForFunction(() => /Synced|Already in sync/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 15000 });
    check('turning sync on uploads state to the Durable Object', countFlags() >= 2, countFlags());
    await A.click('.bar [data-action="settings"]');
    check('status shows a successful sync', /Last synced just now/.test(await A.textContent('#sync-status')), await A.textContent('#sync-status'));
    await A.click('#settings .dlg-head .icon-btn');

    // ================= device B: brand new, joins with sync =================
    const B = await newDevice(b);
    check('B starts empty', await B.locator('.welcome').isVisible());
    await B.click('.welcome [data-action="settings"]');
    await B.check('input[name="sync"]');
    await B.click('#settings button[value="save"]');
    await waitLabel(B, 'Beta Journal');
    const order = await labels(B);
    check('B receives the feeds and folders', order.includes('Tech') && order.includes('Misc') && order.includes('Gamma'), order);
    check('B receives the category order (Misc before Tech)', order.indexOf('Misc') > -1 && order.indexOf('Misc') < order.indexOf('Tech'), order);
    await B.waitForSelector('.entry', { timeout: 15000 });
    await B.waitForTimeout(800);
    const titlesB = await B.$$eval('.entry .e-title', (n) => n.map((x) => x.textContent));
    check('articles read on A are already read on B (not in the unread list)', !titlesB.includes('Second post') && !titlesB.includes('Fresh & New'), titlesB);
    check('articles unread on A are unread on B', titlesB.includes('Entry with markup title') && titlesB.includes('RDF item'), titlesB);
    await B.click('#manage-btn');
    await B.waitForSelector('#manage[open]');
    check('the renamed feed title reached B', (await B.textContent('#manage-body')).includes('Alpha Renamed'));
    await B.click('#manage .primary[data-action="close-manage"]');
    await B.click('.src[data-stream*="tag/global.saved"]');
    await B.waitForSelector('.entry:has-text("Fresh & New")');
    check('an article saved on A is saved on B', await B.locator('.entry', { hasText: 'Fresh & New' }).count() === 1);
    check('saved article shows the (renamed) source', (await B.locator('.entry', { hasText: 'Fresh & New' }).locator('.e-src').textContent()) === 'Alpha Renamed');

    // ================= B changes, A picks it up =================
    await B.click('.src[data-stream*="global.all"]');
    await B.locator('.entry', { hasText: 'Entry with markup title' }).click(); // read on B
    await B.waitForSelector('.art-head');
    await B.waitForTimeout(1500);
    await B.click('.src[data-stream*="tag/global.saved"]');
    await B.locator('.entry', { hasText: 'Fresh & New' }).click();
    await B.waitForSelector('.art-head');
    await B.keyboard.press('s'); // unsave on B
    await B.waitForTimeout(1500);
    await syncNow(B);

    check('A has not seen it yet', await A.locator('.entry.unread', { hasText: 'Entry with markup title' }).count() === 1);
    await syncNow(A);
    check('read state from B reaches A', await A.locator('.entry.read', { hasText: 'Entry with markup title' }).count() === 1);
    await A.click('.src[data-stream*="tag/global.saved"]');
    await A.waitForTimeout(500);
    check('unsaving on B removes it from the Saved list on A', await A.locator('.entry', { hasText: 'Fresh & New' }).count() === 0);

    // feed list changes travel too: B removes a feed
    await B.click('#manage-btn');
    await B.waitForSelector('#manage[open]');
    B.once('dialog', (d) => d.accept());
    await B.click('.mg-feed:has-text("Gamma") [data-mg="feed-remove"]');
    await B.waitForTimeout(500);
    await B.click('#manage .primary[data-action="close-manage"]');
    await syncNow(B);
    await syncNow(A);
    await A.waitForTimeout(500);
    check('feed removed on B is removed on A', !(await labels(A)).includes('Gamma'), await labels(A));

    // ================= the Worker refuses without a proxy key =================
    const saved = env.PROXY_KEY;
    env.PROXY_KEY = undefined;
    await A.click('.bar [data-action="settings"]');
    await A.click('#sync-now-btn');
    await A.waitForFunction(() => /Sync needs a proxy key/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 15000 });
    check('without PROXY_KEY the app explains how to fix it', true);
    env.PROXY_KEY = saved;
    await A.click('#settings .dlg-head .icon-btn');

    check('no page errors', errs.length === 0, errs);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await b.close(); server.close();
    process.exit(failures ? 1 : 0);
  }
});
