// Changes must survive a failing database: marks go into a durable queue first, are retried, shown as a warning,
// and re-applied after a reload (the bug: "Mark all as read", then a reload brought everything back).
// Usage: node tests/persist.cjs [rootDir=.]
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
const world = { 'https://a.example/feed': 8, 'https://b.example/feed': 8 };
const rss = (url) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${url.slice(8, 9)} feed</title><link>https://x.example/</link>${
  Array.from({ length: world[url] }, (_, i) => `<item><title>${url.slice(8, 9)} item ${i}</title><link>${url.slice(0, -5)}/p/${i}</link><guid>${url.slice(8, 9)}${i}</guid><pubDate>${new Date(NOW - 3600e3 - i * 60e3).toUTCString()}</pubDate><description>d</description></item>`).join('')
}</channel></rss>`;
const OPML = '<?xml version="1.0"?><opml version="1.0"><body>' + Object.keys(world).map((u) => `<outline type="rss" text="${u}" xmlUrl="${u}"/>`).join('') + '</body></opml>';

// A browser that loses its database connection. 'soft': existing connections die, reopening works (iOS after the app
// was in the background). 'hard': every transaction fails until the page is reloaded.
const INJECT = () => {
  const seen = new Set();
  const dead = new WeakSet();
  window.__idb = { mode: null };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...a) { const req = open.apply(this, a); req.addEventListener('success', () => seen.add(req.result)); return req; };
  const orig = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...a) {
    if (window.__idb.mode === 'hard' || (window.__idb.mode === 'soft' && dead.has(this))) {
      throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
    }
    return orig.apply(this, a);
  };
  window.__idb.kill = (mode) => { window.__idb.mode = mode; if (mode === 'soft') for (const d of seen) dead.add(d); };
};

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/`;
  const PROXY = 'https://proxy.test';
  const errs = [];
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext({ viewport: { width: 1300, height: 800 } });
    const p = await ctx.newPage();
    await p.addInitScript(INJECT);
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('dialog', (d) => d.accept());
    await p.route(PROXY + '/**', (route) => {
      const req = route.request();
      const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
      const { feeds } = JSON.parse(req.postData());
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ results: feeds.map((f) => ({ url: f.url, status: 200, finalUrl: f.url, body: rss(f.url) })) }) });
    });
    // reads what is really stored, through a page that is not affected by the injected failures
    const reader = await ctx.newPage();
    await reader.goto(base + 'tests/blank.html');
    const stored = () => reader.evaluate(async () => {
      const s = await import('/js/store.js');
      return (await s.getAll('entries')).map((e) => [e.title, e.unread]);
    });
    const unreadStored = async () => (await stored()).filter(([, u]) => u).length;
    const allCount = () => p.evaluate(() => Number(document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0));
    const banner = () => p.evaluate(() => !document.querySelector('#persist-warning').hidden);

    await p.goto(base);
    await p.evaluate((px) => localStorage.setItem('pwrss.settings', JSON.stringify({ proxy: px })), PROXY);
    await p.reload();
    await p.click('.welcome [data-action="settings"]');
    await p.setInputFiles('#opml-file', { name: 'f.opml', mimeType: 'text/x-opml', buffer: Buffer.from(OPML) });
    await p.waitForFunction(() => Number(document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0) === 16, null, { timeout: 20000 });
    await p.waitForTimeout(500);
    check('16 unread articles to start with', (await allCount()) === 16 && (await unreadStored()) === 16);

    // ---- soft outage: the connection is reopened by itself, nothing is lost, no warning stays ----
    await p.evaluate(() => window.__idb.kill('soft'));
    await p.locator('.entry', { hasText: 'a item 0' }).click();
    await p.waitForSelector('.art-head');
    await p.waitForTimeout(1800);
    check('soft outage: the mark is stored (the dead connection was replaced)', (await unreadStored()) === 15, await unreadStored());
    check('soft outage: no warning is left on screen', !(await banner()));

    // ---- hard outage: Mark all as read ----
    await p.evaluate(() => window.__idb.kill('hard'));
    await p.click('#list .bar [data-action="mark-all"]');
    await p.waitForFunction(() => !document.querySelector('.src[data-stream*="global.all"] .count'), null, { timeout: 8000 });
    check('hard outage: the screen and counts show everything read at once', (await allCount()) === 0);
    await p.waitForFunction(() => !document.querySelector('#persist-warning').hidden, null, { timeout: 8000 });
    check('hard outage: a warning says the changes could not be saved', await banner());
    check('hard outage: nothing was stored yet (that is the point)', (await unreadStored()) === 15, await unreadStored());
    const queued = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pwrss.p.')).length);
    check('hard outage: the 15 marks sit in the durable queue', queued === 15, queued);

    // the user reloads: the connection is back; the queued marks must be applied and stored
    await p.reload();
    await p.waitForSelector('.src, .welcome');
    check('after the reload the counts already include the queued marks', (await allCount()) === 0, await allCount());
    await p.waitForFunction(() => Object.keys(localStorage).filter((k) => k.startsWith('pwrss.p.')).length === 0, null, { timeout: 15000 });
    check('after the reload everything is stored as read', (await unreadStored()) === 0, await unreadStored());
    check('and the warning is gone', !(await banner()));
    await p.reload();
    await p.waitForSelector('.src, .welcome');
    await p.waitForTimeout(1200);
    check('a second reload: still all read', (await allCount()) === 0 && (await unreadStored()) === 0);

    // ---- a mark for an article that was never stored (the write failed while it was created) ----
    world['https://a.example/feed'] = 9;               // one new article appears
    await p.evaluate(() => window.__idb.kill('hard'));
    await p.click('.bar [data-action="refresh"]');
    await p.waitForTimeout(250);
    await p.waitForFunction(() => !document.querySelector('.bar [data-action="refresh"]')?.classList.contains('spin'), null, { timeout: 20000 });
    await p.waitForTimeout(500);
    await p.click('.src[data-stream*="global.all"]'); // the list is rebuilt from memory, where the unsaved article is
    await p.waitForSelector('.entry.unread', { timeout: 8000 });
    check('the new article is on screen although it could not be stored', (await p.locator('.entry.unread').count()) === 1, await p.locator('.entry.unread').count());
    await p.locator('.entry.unread').first().click(); // read it while the database is down
    await p.waitForSelector('.art-head');
    await p.waitForTimeout(1200);
    await p.reload(); // the new article was never stored
    await p.waitForSelector('.src, .welcome');
    await p.waitForTimeout(1500);
    await p.click('.bar [data-action="refresh"]'); // it comes back from the feed
    await p.waitForTimeout(250);
    await p.waitForFunction(() => !document.querySelector('.bar [data-action="refresh"]')?.classList.contains('spin'), null, { timeout: 20000 });
    await p.waitForTimeout(800);
    check('the article read while nothing could be stored stays read when it arrives again', (await allCount()) === 0 && (await unreadStored()) === 0, [await allCount(), await unreadStored()]);

    // diagnostics: counters and the log record the outage
    await p.click('.bar [data-action="settings"]');
    await p.click('.diag summary');
    const diag = await p.textContent('#diag-text');
    check('Diagnostics shows the version, the counters and the save problems', /Version \S+/.test(diag) && /Feeds 2 · articles 17/.test(diag) && /save-failed/.test(diag), diag.slice(0, 600));
    await p.click('#settings .dlg-head .icon-btn');

    check('no page errors', errs.length === 0, errs);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await b.close(); server.close();
    process.exit(failures ? 1 : 0);
  }
});
