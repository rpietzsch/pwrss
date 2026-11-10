// Randomized end-to-end test of read state.
// Drives the real app (two synced devices, optionally a second tab on device A) through random sequences of
// opening articles, mark all, refresh, reload, sync, while the feeds change underneath (new items, items that
// disappear, changed GUIDs). Invariants, checked against what is stored (IndexedDB), which is what survives a reload:
//   1. an article the user marked read never becomes unread (on that device; on the other one after syncing)
//   2. no article exists twice on a device
// Usage: node tests/fuzz.cjs <seed> [steps=40] [tabs=0|1]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const seed = Number(process.argv[2] || 1);
const STEPS = Number(process.argv[3] || 40);
const TABS = process.argv[4] === '1';
const root = path.resolve(__dirname, '..');

function rng(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(seed * 7919 + 13);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

// ---------------- the world: feeds that change over time ----------------
const NOW0 = Date.now();
const HOUR = 3600e3, DAY = 24 * HOUR;
let counter = 0;
const world = {};
const FEED_URLS = [1, 2, 3, 4, 5].map((i) => `https://f${i}.example/feed`);
const mkItem = (feed, at) => { const n = ++counter; return { title: `Title ${n}`, guid: `g${n}`, ver: 0, link: `https://${feed}.example/p/${n}`, at, note: 0 }; };
for (const [i, url] of FEED_URLS.entries()) {
  const host = `f${i + 1}`;
  world[url] = Array.from({ length: 6 + Math.floor(rand() * 9) }, (_, k) => mkItem(host, NOW0 - Math.floor(rand() * 20 * DAY) - k * 60e3));
}
const rss = (url) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed ${url.slice(10, 12)}</title><link>https://x.example/</link>${
  world[url].sort((a, b) => b.at - a.at).map((i) => `<item><title>${i.title}</title><link>${i.link}</link><guid isPermaLink="false">${i.guid}-v${i.ver}</guid><pubDate>${new Date(i.at).toUTCString()}</pubDate><description>desc ${i.title} n${i.note}</description></item>`).join('')
}</channel></rss>`;
const OPML = '<?xml version="1.0"?><opml version="1.0"><body><outline text="All">'
  + FEED_URLS.map((u, i) => `<outline type="rss" text="Feed ${i + 1}" xmlUrl="${u}"/>`).join('') + '</outline></body></opml>';

function mutateWorld() {
  const url = pick(FEED_URLS);
  const host = `f${FEED_URLS.indexOf(url) + 1}`;
  const kind = pick(process.env.NOCHURN ? ['new', 'new', 'drop', 'touch'] : ['new', 'new', 'drop', 'churn', 'touch']);
  const log = `${kind} ${host}`;
  if (kind === 'new') for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) world[url].push(mkItem(host, Date.now() - Math.floor(rand() * 5 * 60e3)));
  if (kind === 'drop' && world[url].length > 4) world[url].sort((a, b) => a.at - b.at).splice(0, 1 + Math.floor(rand() * 3));
  if (kind === 'churn') for (const i of world[url]) i.ver++; // new GUIDs, same links
  if (kind === 'touch') for (const i of world[url]) i.note++;  // same GUIDs, changed content
  return log;
}

const fail = (msg, extra) => { console.log(`✗ [seed ${seed}${TABS ? ' tabs' : ''}] ${msg}`); if (extra !== undefined) console.log('   ', JSON.stringify(extra).slice(0, 1500)); console.log('   steps:', trace.join(' | ')); failures++; };
const trace = [];
let failures = 0;

server.listen(0, async () => {
  const origin = `http://localhost:${server.address().port}`;
  const base = origin + '/';
  const PROXY = 'https://proxy.test';
  process.emitWarning = () => {};
  const { DatabaseSync } = require('node:sqlite');
  const { default: worker } = await import(pathToFileURL(path.join(root, 'worker', 'feedly-proxy.mjs')).href);
  const { SyncStore } = await import(pathToFileURL(path.join(root, 'worker', 'sync-store.mjs')).href);
  const db = new DatabaseSync(':memory:');
  const dobj = new SyncStore({ storage: { sql: { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows, one: () => rows[0] }; } } } });
  const env = { ALLOWED_ORIGINS: origin, PROXY_KEY: 'k', SYNC: { idFromName: (n) => n, get: () => ({ fetch: (r) => dobj.fetch(r) }) } };
  globalThis.fetch = async (url) => (world[String(url)] ? new Response(rss(String(url)), { headers: { 'Content-Type': 'application/rss+xml' } }) : new Response('nope', { status: 404 }));

  const browser = await chromium.launch();
  // Simulates the browser losing its database connection (as iOS does after the app was in the background):
  // while window.__idb.dead is set, every IndexedDB transaction throws. A page reload heals it.
  const INJECT = () => {
    const seen = new Set();            // connections the app has opened
    const dead = new WeakSet();        // connections that were lost
    window.__idb = { mode: null };     // null | 'soft' (old connections die, reopening works) | 'hard' (everything fails until reload)
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
  const attach = async (page) => {
    await page.addInitScript(INJECT);
    await page.route(PROXY + '/**', async (route) => {
      const r = route.request();
      const init = { method: r.method(), headers: r.headers() };
      delete init.headers['content-length'];
      if (r.postData()) init.body = r.postData();
      const res = await worker.fetch(new Request(r.url(), init), env);
      route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    page.on('pageerror', (e) => fail('page error', e.message));
    page.on('dialog', (d) => d.accept());
  };
  const newContext = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
    const page = await ctx.newPage();
    await attach(page);
    await page.goto(base);
    await page.evaluate(([px]) => localStorage.setItem('pwrss.settings', JSON.stringify({ proxy: px, proxyKey: 'k' })), [PROXY]);
    await page.reload();
    return { ctx, page };
  };

  // ---- devices ----
  const A = await newContext();
  const B = await newContext();
  const devices = { A: A.page, B: B.page };
  if (TABS) { devices.A2 = await A.ctx.newPage(); await attach(devices.A2); await devices.A2.goto(base); }
  const owner = (d) => (d === 'B' ? 'B' : 'A'); // A and A2 share one storage
  const readBy = { A: new Set(), B: new Set() };  // titles marked read by the user, per storage
  let globalRead = new Set();

  const readers = {};
  const getReader = async (who) => {
    if (!readers[who]) {
      const ctx = who === 'B' ? B.ctx : A.ctx;
      readers[who] = await ctx.newPage();
      await readers[who].goto(base + 'tests/blank.html');
    }
    return readers[who];
  };
  const idb = async (p) => (await getReader(p === devices.B ? 'B' : 'A')).evaluate(async () => {
    const s = await import('/js/store.js');
    return (await s.getAll('entries')).map((e) => [e.title, e.unread, e.feedId]);
  });
  const settle = async (p) => {
    await p.waitForFunction(() => !document.querySelector('.bar [data-action="refresh"]')?.classList.contains('spin'), null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(250);
  };
  const toast = (p, re, ms = 20000) => p.waitForFunction((s) => new RegExp(s).test(document.querySelector('#toast')?.textContent || ''), re, { timeout: ms }).catch(() => {});
  const syncNow = async (p) => {
    await p.click('.bar [data-action="settings"]');
    await p.waitForSelector('#settings[open]');
    await p.click('#sync-now-btn');
    await toast(p, 'Synced|Already in sync|failed|Sync');
    await p.waitForTimeout(400);
    await p.click('#settings .dlg-head .icon-btn');
    await p.waitForTimeout(300);
  };
  const flushWait = (p) => p.waitForTimeout(1300); // the app writes marks ~0.9 s after they are made

  const check = async (label, devNames, expectGlobal) => {
    for (const d of devNames) {
      const who = owner(d);
      const rows = await idb(devices[d]);
      const byTitle = new Map();
      for (const [t, unread] of rows) { if (byTitle.has(t)) fail(`${label}: duplicate article "${t}" on ${who}`, { d }); byTitle.set(t, unread); }
      const must = expectGlobal ? globalRead : readBy[who];
      const bad = [...must].filter((t) => byTitle.has(t) && byTitle.get(t) === true);
      if (bad.length) {
        const dump = {};
        for (const t of bad.slice(0, 3)) {
          dump[t] = {};
          for (const [name, page] of [['A', await getReader('A')], ['B', await getReader('B')]]) {
            dump[t][name] = await page.evaluate(async (title) => {
              const s = await import('/js/store.js');
              return (await s.getAll('entries')).filter((e) => e.title === title).map((e) => ({ id: e.id, unread: e.unread, link: e.alternate?.[0]?.href, feed: e.feedId.slice(14, 16), crawled: e.crawled }));
            }, t);
          }
          const ids = [...dump[t].A, ...dump[t].B].map((e) => e.id);
          dump[t].server = db.prepare(`SELECT id, read, read_at, seq FROM flags WHERE id IN (${ids.map(() => '?').join(',') || "''"})`).all(...ids);
        }
        fail(`${label}: ${bad.length} article(s) marked read are unread again on ${who} (${d})`, { sample: bad.slice(0, 8), dump });
      }
    }
  };

  const convergeAll = async () => {
    for (const d of Object.keys(outage)) { await devices[d].reload(); await devices[d].waitForTimeout(2200); delete outage[d]; }
    const order = TABS ? ['A2', 'A', 'B', 'A2', 'A'] : ['A', 'B', 'A'];
    for (const d of order) await syncNow(devices[d]);
  };
  const unreadTitles = async (p) => (await idb(p)).filter(([, u]) => u).map(([t]) => t);
  const outage = {}; // device name -> actions since the database connection was lost
  const toAll = async (p) => { await p.click('.src[data-stream*="global.all"]').catch(() => {}); await p.waitForTimeout(250); };

  // ---- set up: A imports and turns sync on, B joins ----
  trace.push('setup');
  await A.page.click('.welcome [data-action="settings"]');
  await A.page.setInputFiles('#opml-file', { name: 'f.opml', mimeType: 'text/x-opml', buffer: Buffer.from(OPML) });
  await A.page.waitForFunction(() => Number(document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0) > 0, null, { timeout: 30000 });
  await A.page.waitForTimeout(800);
  await A.page.click('.bar [data-action="settings"]');
  await A.page.check('input[name="sync"]');
  await A.page.click('#settings button[value="save"]');
  await toast(A.page, 'Synced|Already');
  await A.page.waitForTimeout(500);
  await B.page.click('.welcome [data-action="settings"]');
  await B.page.check('input[name="sync"]');
  await B.page.click('#settings button[value="save"]');
  await toast(B.page, 'Synced');
  await B.page.waitForTimeout(4000);
  if (TABS) { await devices.A2.reload(); await devices.A2.waitForTimeout(1000); }

  // ---- random steps ----
  const actions = ['open', 'open', 'open', 'markAll', 'markAll', 'refresh', 'refresh', 'reload', 'sync', 'world', 'world', 'wait', 'feedMarkAll', 'markReload'];
  if (process.env.OUTAGE) actions.push('outage', 'outage', 'outage');
  for (let step = 1; step <= STEPS && !failures; step++) {
    const d = pick(Object.keys(devices));
    const p = devices[d];
    const who = owner(d);
    let act = pick(actions);
    if (outage[d] >= 2) act = 'reload'; // the user eventually reloads, which restores the connection
    trace.push(`${step}:${d}:${act}`);
    const lost = outage[d] !== undefined;
    if (lost && act !== 'reload') outage[d]++;
    try {
      if (act === 'outage') {
        if (lost) continue;
        await p.evaluate((m) => window.__idb.kill(m), process.env.OUTAGE === 'soft' ? 'soft' : 'hard');
        outage[d] = 0;
        continue;
      }
      if (act === 'world') { trace[trace.length - 1] += `(${mutateWorld()})`; continue; }
      if (act === 'wait') { await p.waitForTimeout(1500); continue; }
      if (act === 'open') {
        await toAll(p);
        const rows = p.locator('.entry.unread');
        const n = await rows.count();
        if (!n) continue;
        const row = rows.nth(Math.floor(rand() * Math.min(n, 12)));
        const title = (await row.locator('.e-title').textContent()).trim();
        await row.click();
        await p.waitForSelector('.art-head', { timeout: 8000 });
        readBy[who].add(title); globalRead.add(title);
        await flushWait(p);
        if (!lost) await check(`after open "${title}"`, [d]);
      } else if (act === 'markAll') {
        await toAll(p);
        const before = await unreadTitles(p);
        if (!before.length) continue;
        // A tab with an outdated view only marks what it knows (like any "mark all" covers what you see): assert
        // only when its counts agree with what is stored.
        const known = Number(await p.evaluate(() => document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0)) === before.length;
        await p.click('#list .bar [data-action="mark-all"]');
        await p.waitForTimeout(600);
        if (!known) { trace[trace.length - 1] += '(stale tab, not asserted)'; await flushWait(p); continue; }
        for (const t of before) { readBy[who].add(t); globalRead.add(t); }
        await flushWait(p);
        if (!lost) await check(`after mark all (${before.length})`, [d]);
      } else if (act === 'feedMarkAll') {
        const feedLink = p.locator('.src.feed[data-stream^="feed/"]').first();
        if (!(await feedLink.count())) continue;
        const sid = await feedLink.getAttribute('data-stream');
        await feedLink.click();
        await p.waitForTimeout(400);
        const before = (await idb(p)).filter(([, u, f]) => u && f === sid).map(([t]) => t);
        if (!before.length) { await toAll(p); continue; }
        const knownFeed = Number(await p.evaluate((id) => document.querySelector(`.src[data-stream="${id}"] .count`)?.textContent || 0, sid)) === before.length;
        await p.click('#list .bar [data-action="mark-all"]');
        await p.waitForTimeout(600);
        if (!knownFeed) { trace[trace.length - 1] += '(stale tab, not asserted)'; await flushWait(p); await toAll(p); continue; }
        for (const t of before) { readBy[who].add(t); globalRead.add(t); }
        await flushWait(p);
        if (!lost) await check(`after marking a feed read (${before.length})`, [d]);
        await toAll(p);
      } else if (act === 'markReload') {
        // mark something, reload at once (the pending marks are only in localStorage for a moment)
        await toAll(p);
        const rows = p.locator('.entry.unread');
        if (!(await rows.count())) continue;
        const title = (await rows.first().locator('.e-title').textContent()).trim();
        await rows.first().click();
        await p.waitForSelector('.art-head', { timeout: 8000 });
        readBy[who].add(title); globalRead.add(title);
        await p.reload();
        await p.waitForTimeout(1500);
        delete outage[d];
        await check(`after open + immediate reload "${title}"`, [d]);
      } else if (act === 'refresh') {
        await p.click('.bar [data-action="refresh"]');
        await p.waitForTimeout(250);
        await settle(p);
        if (!lost) await check('after refresh', [d]);
      } else if (act === 'reload') {
        await p.reload();
        await p.waitForTimeout(2200);
        delete outage[d];
        await check('after page reload', [d]);
      } else if (act === 'sync') {
        await syncNow(p);
        if (!lost) await check('after sync', [d]);
      }
    } catch (e) {
      fail(`step ${step} (${act} on ${d}) threw: ${e.message.slice(0, 200)}`);
    }
    // from time to time: let both devices converge and check everything
    if (!failures && step % 8 === 0) {
      trace.push('converge');
      await convergeAll();
      for (const x of ['A', 'B']) readBy[x] = new Set(globalRead);
      await check(`after converging at step ${step}`, ['A', 'B'], true);
    }
  }

  if (!failures) {
    trace.push('final');
    for (const p of Object.values(devices)) await p.waitForTimeout(500);
    await convergeAll();
    for (const x of ['A', 'B']) readBy[x] = new Set(globalRead);
    await check('final state', ['A', 'B'], true);
    await devices.A.reload(); await devices.B.reload();
    await devices.A.waitForTimeout(2500); await devices.B.waitForTimeout(2500);
    await check('final state after reloading both', ['A', 'B'], true);
  }
  console.log(failures ? `FAILED seed ${seed}${TABS ? ' (tabs)' : ''}` : `ok seed ${seed}${TABS ? ' (tabs)' : ''}: ${STEPS} steps, ${globalRead.size} articles read, ${Object.keys(world).length} feeds`);
  await browser.close(); server.close();
  process.exit(failures ? 1 : 0);
});
