// Two tabs of the app share one database. A tab with an outdated view must never overwrite the other tab's
// read marks, and state changes must reach the other tab on their own.
// Usage: node tests/tabs.cjs [rootDir=.]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || '.');
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

const NOW = Date.now();
const world = { n: 6, note: 0 };
const rss = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Tabs feed</title><link>https://x.example/</link>${
  Array.from({ length: world.n }, (_, i) => `<item><title>Item ${i}</title><link>https://t.example/p/${i}</link><guid>t${i}</guid><pubDate>${new Date(NOW - 3600e3 - i * 60e3).toUTCString()}</pubDate><description>text ${i} v${world.note}</description></item>`).join('')
}</channel></rss>`;
const OPML = '<?xml version="1.0"?><opml version="1.0"><body><outline type="rss" text="Tabs feed" xmlUrl="https://t.example/feed"/></body></opml>';

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/`;
  const PROXY = 'https://proxy.test';
  const errs = [];
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext({ viewport: { width: 1300, height: 800 } });
    const route = (page) => page.route(PROXY + '/**', (r) => {
      const req = r.request();
      const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
      const { feeds } = JSON.parse(req.postData());
      return r.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ results: feeds.map((f) => ({ url: f.url, status: 200, finalUrl: f.url, body: rss() })) }) });
    });
    const open = async (noBroadcast) => {
      const page = await ctx.newPage();
      if (noBroadcast) await page.addInitScript(() => { delete window.BroadcastChannel; }); // a tab that does not hear about changes
      page.on('pageerror', (e) => errs.push(e.message));
      page.on('dialog', (d) => d.accept());
      await route(page);
      await page.goto(base);
      return page;
    };
    const count = (p) => p.evaluate(() => Number(document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0));
    const reader = await ctx.newPage();
    await reader.goto(base + 'tests/blank.html');
    const unreadStored = () => reader.evaluate(async () => (await (await import('/js/store.js')).getAll('entries')).filter((e) => e.unread).length);
    const refresh = async (p) => {
      await p.click('.bar [data-action="refresh"]');
      await p.waitForTimeout(250);
      await p.waitForFunction(() => !document.querySelector('.bar [data-action="refresh"]')?.classList.contains('spin'), null, { timeout: 20000 });
      await p.waitForTimeout(500);
    };

    // ---------- 1. a tab that is out of date must not undo marks made in another tab ----------
    const T1 = await open(true); // never hears about changes: its view gets outdated
    await T1.evaluate((px) => localStorage.setItem('pwrss.settings', JSON.stringify({ proxy: px })), PROXY);
    await T1.reload();
    await T1.click('.welcome [data-action="settings"]');
    await T1.setInputFiles('#opml-file', { name: 'f.opml', mimeType: 'text/x-opml', buffer: Buffer.from(OPML) });
    await T1.waitForFunction(() => Number(document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0) === 6, null, { timeout: 20000 });
    await T1.waitForTimeout(500);
    const T2 = await open(false);
    await T2.waitForFunction(() => Number(document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0) === 6, null, { timeout: 15000 });
    check('both tabs show 6 unread', (await count(T1)) === 6 && (await count(T2)) === 6);

    await T2.click('#list .bar [data-action="mark-all"]');
    await T2.waitForFunction(() => !document.querySelector('.src[data-stream*="global.all"] .count'), null, { timeout: 8000 });
    await T2.waitForTimeout(1500);
    check('tab 2 marked everything read, and it is stored', (await unreadStored()) === 0, await unreadStored());
    check('tab 1 has not heard about it (its view is outdated)', (await count(T1)) === 6, await count(T1));

    world.note = 1; // every article's text changed: the refresh in tab 1 rewrites them
    await refresh(T1);
    check('an outdated tab refreshing changed articles does not bring them back as unread', (await unreadStored()) === 0, await unreadStored());
    await T1.reload();
    await T1.waitForTimeout(1500);
    check('after a reload tab 1 agrees: nothing unread', (await count(T1)) === 0 && (await unreadStored()) === 0, await count(T1));

    // ---------- 2. state changes reach the other tab by themselves ----------
    const T3 = await open(false);
    world.n = 8; // two new articles
    await refresh(T2);
    await refresh(T3);
    check('both tabs show the 2 new articles', (await count(T2)) === 2 && (await count(T3)) === 2, [await count(T2), await count(T3)]);
    await T2.locator('.entry.unread').first().click(); // read one in tab 2
    await T2.waitForSelector('.art-head');
    await T3.waitForFunction(() => Number(document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0) === 1, null, { timeout: 8000 });
    check('tab 3 followed the change without being touched (count 2 → 1)', (await count(T3)) === 1);
    const stillUnread = await T3.locator('.entry.unread').count();
    check('and its list shows that article as read', stillUnread === 1, stillUnread);

    check('no page errors', errs.length === 0, errs);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await b.close(); server.close();
    process.exit(failures ? 1 : 0);
  }
});
