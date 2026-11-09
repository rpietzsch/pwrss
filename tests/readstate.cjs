// Read state must survive refreshes: nothing marked as read may come back as unread.
// Usage: node tests/readstate.cjs [rootDir=.]
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
const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const item = (title, link, guid, at) =>
  `<item><title>${title}</title><link>${link}</link><guid isPermaLink="false">${guid}</guid><pubDate>${new Date(at).toUTCString()}</pubDate><description>${title}</description></item>`;
const rss = (title, items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://x.example/</link>${items.join('')}</channel></rss>`;

// Feeds change over the test, so they are built per request.
const state = { churn: 0, oldListsAncient: true, bExists: false };
const FEEDS = {
  'https://a.example/feed': () => rss('Feed A', Array.from({ length: 45 }, (_, i) => item(`A item ${i}`, `https://a.example/${i}`, `a${i}`, NOW - HOUR - i * MIN))),
  'https://old.example/feed': () => rss('Old Feed', [
    item('Recent item', 'https://old.example/recent', 'o-recent', NOW - HOUR),
    ...(state.oldListsAncient ? [item('Ancient A', 'https://old.example/a', 'o-a', NOW - 100 * DAY), item('Ancient B', 'https://old.example/b', 'o-b', NOW - 200 * DAY)] : []),
  ]),
  'https://big.example/feed': () => rss('Big Feed', Array.from({ length: 400 }, (_, i) => item(`Big item ${i}`, `https://big.example/${i}`, `b${i}`, NOW - 2 * HOUR - i * MIN))),
  // guid changes on every "version", the link stays
  'https://churn.example/feed': () => rss('Churn Feed', [0, 1, 2].map((i) => item(`Churn ${i}`, `https://churn.example/p/${i}`, `g${i}-v${state.churn}`, NOW - 3 * HOUR - i * MIN))),
  // older articles than A's, but fetched later
  'https://b.example/feed': () => rss('Feed B', Array.from({ length: 5 }, (_, i) => item(`B item ${i}`, `https://b.example/${i}`, `bb${i}`, NOW - 2 * DAY - i * MIN))),
};
const OPML = '<?xml version="1.0"?><opml version="1.0"><body><outline text="All">'
  + ['a', 'old', 'big', 'churn'].map((h) => `<outline type="rss" text="${h} feed" xmlUrl="https://${h}.example/feed"/>`).join('')
  + '</outline></body></opml>';

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/`;
  const PROXY = 'https://proxy.test';
  const errs = [];
  const b = await chromium.launch();
  try {
    const p = await (await b.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.route(PROXY + '/**', (route) => {
      const req = route.request();
      const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
      const { feeds } = JSON.parse(req.postData());
      const results = feeds.map((f) => (FEEDS[f.url]
        ? { url: f.url, status: 200, finalUrl: f.url, body: FEEDS[f.url]() }
        : { url: f.url, status: 404, error: 'HTTP 404' }));
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ results }) });
    });

    const allCount = async () => Number(await p.evaluate(() => document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || '0'));
    const settle = () => p.waitForFunction(() => !document.querySelector('.bar [data-action="refresh"]')?.classList.contains('spin'));
    const refresh = async () => { await p.click('.bar [data-action="refresh"]'); await p.waitForTimeout(200); await settle(); await p.waitForTimeout(300); };
    const perFeed = () => p.evaluate(async () => {
      const s = await import('./js/store.js');
      const by = {};
      for (const e of await s.getAll('entries')) by[e.feedId.replace('feed/https://', '').split('.')[0]] = (by[e.feedId.replace('feed/https://', '').split('.')[0]] || 0) + 1;
      return by;
    });

    await p.goto(base);
    await p.evaluate((px) => localStorage.setItem('pwrss.settings', JSON.stringify({ proxy: px })), PROXY);
    await p.reload();
    await p.click('.welcome [data-action="settings"]');
    await p.setInputFiles('#opml-file', { name: 'f.opml', mimeType: 'text/x-opml', buffer: Buffer.from(OPML) });
    await p.waitForFunction(() => Number(document.querySelector('.src[data-stream*="global.all"] .count')?.textContent || 0) > 400, null, { timeout: 20000 });
    await p.waitForTimeout(500);

    // 45 (A) + 1 (old feed: the ancient ones start as read) + 400 (big) + 3 (churn)
    check('first fetch: everything recent is unread, ancient articles start as read', (await allCount()) === 449, await allCount());

    // ---- 1. refresh must not resurrect old read articles that the feed still lists ----
    await refresh();
    check('refresh #1: nothing comes back as unread', (await allCount()) === 449, await allCount());
    await refresh();
    check('refresh #2: nothing comes back as unread', (await allCount()) === 449, await allCount());
    const kept = await perFeed();
    check('articles the feed still lists are kept (even old, read ones)', kept.old === 3 && kept.big === 400, kept);

    // ---- 2. mark all as read after a feed was added later (its articles are crawled later) ----
    await p.click('#manage-btn');
    await p.waitForSelector('#manage[open]');
    await p.fill('#mg-url', 'https://b.example/feed');
    await p.click('[data-mg="add-feed"]');
    await p.waitForFunction(() => document.querySelector('#manage-body')?.textContent.includes('Feed B'), null, { timeout: 15000 });
    await p.click('#manage .primary[data-action="close-manage"]');
    await p.waitForTimeout(500);
    check('the later feed adds 5 unread articles', (await allCount()) === 454, await allCount());

    p.once('dialog', (d) => d.accept());
    await p.click('#list .bar [data-action="mark-all"]');
    await p.waitForFunction(() => !document.querySelector('.src[data-stream*="global.all"] .count'), null, { timeout: 10000 });
    check('mark all as read leaves nothing unread (also articles fetched later than the visible ones)', (await allCount()) === 0, await allCount());

    // ---- 3. refresh after marking everything read ----
    await refresh();
    check('after mark all + refresh #1: still nothing unread', (await allCount()) === 0, await allCount());
    await refresh();
    check('after mark all + refresh #2: still nothing unread', (await allCount()) === 0, await allCount());
    const afterBig = await perFeed();
    check('a feed with more than 300 articles keeps all of them while it lists them', afterBig.big === 400, afterBig);

    // ---- 4. a feed that changes its GUIDs but keeps its links ----
    state.churn = 1;
    await refresh();
    check('changed GUIDs (same links) do not create unread duplicates', (await allCount()) === 0, await allCount());
    const churned = await perFeed();
    check('no duplicate articles after the GUID change', churned.churn === 3, churned);

    // ---- 5. old read articles that the feed stopped listing are still cleaned up ----
    state.oldListsAncient = false;
    await refresh();
    const cleaned = await perFeed();
    check('read articles that left the feed are pruned when old', cleaned.old === 1, cleaned);
    check('and nothing turned unread', (await allCount()) === 0, await allCount());

    check('no page errors', errs.length === 0, errs);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await b.close(); server.close();
    process.exit(failures ? 1 : 0);
  }
});
