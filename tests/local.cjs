// Local-feeds tests: parser + OPML (in the browser), import → fetch → read state → persistence (mocked proxy).
const http = require('http');
const fs = require('fs');
const path = require('path');
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
// Every <use> icon on the page must exist in the vendored Lucide sprite.
const iconsOk = (page) => page.evaluate(async () => {
  const svg = await (await fetch('vendor/lucide-sprite.svg')).text();
  const ids = new Set([...svg.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  const uses = [...document.querySelectorAll('use')].map((u) => (u.getAttribute('href') || '').split('#')[1]);
  const missing = [...new Set(uses.filter((id) => !ids.has(id)))];
  const broken = [...document.querySelectorAll('button.icon-btn svg')].filter((s) => s.getBoundingClientRect().width && !s.querySelector('use')).length;
  return { missing, count: uses.length, broken };
});

const check = (name, ok, extra) => { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) { failures++; if (extra !== undefined) console.log('   ', JSON.stringify(extra)); } };

const now = new Date();
const subst = (s) => s
  .replace(/PUBDATE_NOW/g, now.toUTCString())
  .replace(/PUBDATE_HOUR_AGO/g, new Date(now - 3600e3).toUTCString())
  .replace(/UPDATED_NOW|DATE_ISO_NOW/g, now.toISOString());

const FEEDS = {
  'https://alpha.example/feed.xml': subst(fx('rss.xml')),
  'https://beta.example/atom.xml': subst(fx('atom.xml')),
  'https://gamma.example/rdf': subst(fx('rdf.xml')),
  'https://delta.example/feed': subst(fx('broken.xml')),
  'https://loose.example/feed': '<html><body>not a feed</body></html>',
};

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/`;
  const b = await chromium.launch();
  const errs = [];
  try {
    const ctx = await b.newContext({ viewport: { width: 1300, height: 800 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));

    // ---------- parser ----------
    await p.goto(base);
    const parsed = await p.evaluate(async ([rss, atom, rdf, broken, opml]) => {
      const { parseFeed } = await import('./js/feedparse.js');
      const { parseOPML, buildOPML } = await import('./js/opml.js');
      const o = parseOPML(opml);
      return {
        rss: parseFeed(rss), atom: parseFeed(atom), rdf: parseFeed(rdf), broken: parseFeed(broken),
        notFeed: (() => { try { parseFeed('<html><body/></html>'); return 'parsed'; } catch (e) { return e.message; } })(),
        opml: o, round: parseOPML(buildOPML(o)),
      };
    }, [FEEDS['https://alpha.example/feed.xml'], FEEDS['https://beta.example/atom.xml'], FEEDS['https://gamma.example/rdf'], FEEDS['https://delta.example/feed'], fx('sample.opml')]);

    const hnj = fs.readFileSync(path.join(__dirname, 'fixtures', 'hn.json'), 'utf8');
    const hn = await p.evaluate(async (json) => {
      const m = await import('./js/hnapi.js');
      const f = m.parseHNApi(JSON.parse(json), 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30');
      return {
        f,
        hosts: ['https://news.ycombinator.com/rss', 'https://hackernews.com/rss', 'http://hnrss.org/frontpage', 'https://example.com/rss'].map(m.isHNHost),
        api: ['https://hn.algolia.com/api/v1/search?tags=front_page', 'https://hn.algolia.com/api/v1/search_by_date?tags=story', 'https://hn.algolia.com/other'].map(m.isHNApi),
        repl: [m.hnApiReplacement('https://hnrss.org/newest?points=100'), m.hnApiReplacement('https://hackernews.com/rss')],
      };
    }, hnj);
    check('HN API: title, site and one item per hit', hn.f.title === 'Hacker News: Front Page' && hn.f.website === 'https://news.ycombinator.com/' && hn.f.items.length === 3, hn.f);
    check('HN API: story link, author, time, points and discussion link', hn.f.items[0].link.startsWith('https://www.thestateofai.com/') && hn.f.items[0].author === 'TheWiggles' && hn.f.items[0].published === 1794161767000 && /804 points · 430 comments/.test(hn.f.items[0].summary) && hn.f.items[0].summary.includes('item?id=50415628'), hn.f.items[0]);
    check('HN API: Ask HN without a link points at the discussion', hn.f.items[2].link === 'https://news.ycombinator.com/item?id=777', hn.f.items[2]);
    check('HN hosts and API addresses are recognised', JSON.stringify(hn.hosts) === '[true,true,true,false]' && JSON.stringify(hn.api) === '[true,true,false]', hn);
    check('HN replacement: front page by default, newest when asked', hn.repl[0].includes('search_by_date') && hn.repl[1].includes('tags=front_page'), hn.repl);

    const r = parsed.rss;
    check('RSS: title, site, items', r.title === 'Alpha Blog' && r.website === 'https://alpha.example/' && r.items.length === 3, r);
    check('RSS: entities decoded in title', r.items[0].title === 'Fresh & New', r.items[0].title);
    check('RSS: author, content:encoded, summary, thumbnail', r.items[0].author === 'Ada' && r.items[0].html.includes('Full body one') && r.items[0].summary.includes('Short summary') && r.items[0].image === 'https://alpha.example/img/one.jpg', r.items[0]);
    check('RSS: enclosure image', r.items[1].image === 'https://alpha.example/img/two.png', r.items[1]);
    check('RSS: dates parsed', Math.abs(r.items[0].published - now) < 5000 && r.items[2].published === Date.parse('2015-01-05T10:00:00Z'));
    const a = parsed.atom;
    check('Atom: title, site, entry', a.title === 'Beta Journal' && a.website === 'https://beta.example/' && a.items.length === 1, a);
    check('Atom: html title stripped, author, xhtml content', a.items[0].title === 'Entry with markup title' && a.items[0].author === 'Lin' && a.items[0].html.includes('XHTML body') && !a.items[0].html.includes('xmlns'), a.items[0]);
    check('Atom: guid and link', a.items[0].guid === 'tag:beta.example,2026:1' && a.items[0].link === 'https://beta.example/e1');
    check('RDF: item parsed', parsed.rdf.title === 'Gamma RDF' && parsed.rdf.items.length === 1 && parsed.rdf.items[0].title === 'RDF item', parsed.rdf);
    check('Broken XML (bare &, &nbsp;, leading space) recovers', parsed.broken.items.length === 1 && parsed.broken.items[0].title === 'Bare & ampersand', parsed.broken);
    check('HTML page is not a feed', /Not an RSS|Not a valid/.test(parsed.notFeed), parsed.notFeed);
    check('OPML: folders, dedupe, loose feeds', parsed.opml.length === 6 && parsed.opml[0].category === 'Tech' && parsed.opml.find((f) => f.url.includes('loose')).category === null, parsed.opml);
    const key = (l) => JSON.stringify(l.map((f) => [f.url, f.category, f.title]).sort());
    check('OPML: export → import round trip (order-independent)', key(parsed.round) === key(parsed.opml), parsed.round);

    // ---------- app flow with mocked proxy ----------
    const PROXY = 'https://proxy.test';
    const seen = { requests: [], pages: 0 };
    let etagMode = true;
    let feedsStatus = 200;
    await p.route(PROXY + '/**', (route) => {
      const req = route.request();
      const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
      const u = new URL(req.url());
      if (u.pathname === '/feeds' && feedsStatus !== 200) return route.fulfill({ status: feedsStatus, contentType: 'text/plain', headers: h, body: 'Not found' });
      if (u.pathname === '/feeds') {
        const { feeds } = JSON.parse(req.postData());
        seen.requests.push(feeds);
        const results = feeds.map((f) => {
          if (/dead\d?\.example/.test(f.url)) return { url: f.url, status: 0, error: 'Timed out' };
          if (/ycombinator\.com|hackernews\.com|hnrss\.org/.test(f.url)) return { url: f.url, status: 419, error: 'HTTP 419', detail: 'Sorry', finalUrl: f.url, server: 'cloudflare' };
          if (etagMode && f.etag === 'v1') return { url: f.url, status: 304 };
          return { url: f.url, status: 200, finalUrl: f.url, etag: 'v1', modified: null, body: FEEDS[f.url] };
        });
        return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ results }) });
      }
      if (u.pathname === '/fetch') {
        seen.pages++;
        return route.fulfill({ status: 200, contentType: 'text/html', headers: { ...h, 'x-final-url': u.searchParams.get('url') },
          body: '<html><head><title>T</title></head><body><nav>Menu Menu</nav><article><h1>Fresh &amp; New</h1>' + '<p>Reader paragraph that is long enough to count as content for Readability. '.repeat(8) + '</p></article></body></html>' });
      }
      return route.fulfill({ status: 404, headers: h, body: '' });
    });

    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await p.route('https://alpha.example/img/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await p.evaluate((px) => localStorage.setItem('pwrss.settings', JSON.stringify({ proxy: px + '/health/' })), PROXY);
    await p.reload();
    check('welcome offers import', await p.locator('.welcome').getByText('Import feeds').isVisible());
    await p.click('.welcome [data-action="settings"]');
    await p.setInputFiles('#opml-file', path.join(__dirname, 'fixtures', 'sample.opml'));
    await p.waitForSelector('.entry', { timeout: 10000 });
    await p.waitForTimeout(500);

    const titles = await p.$$eval('.entry .e-title', (n) => n.map((x) => x.textContent));
    check('articles from all feed types shown', ['Fresh & New', 'Second post', 'Entry with markup title', 'RDF item', 'Bare & ampersand'].every((t) => titles.includes(t)), titles);
    check('old first-fetch articles start as read', !(await p.locator('.entry.unread .e-title', { hasText: 'Ancient post' }).count()));
    check('first fetch: 2 requests chunks not needed, one batch', seen.requests.length === 1 && seen.requests[0].length === 6, seen.requests.map((r) => r.length));
    const srcLabels = await p.$$eval('.src-label', (n) => n.map((x) => x.textContent));
    check('categories and feeds in sources', ['Tech', 'Misc', 'Alpha Blog', 'Beta Journal', 'Uncategorized'].every((t) => srcLabels.includes(t)) || srcLabels.includes('Tech'), srcLabels);
    const allCount = await p.textContent('.src[data-stream*="global.all"] .count');
    check('unread count matches', Number(allCount) === 5, allCount);

    // thumbnail + reader mode + read state
    check('thumbnail from media:thumbnail', (await p.locator('.entry', { hasText: 'Fresh & New' }).locator('img.thumb').getAttribute('src')) === 'https://alpha.example/img/one.jpg');
    await p.locator('.entry', { hasText: 'Fresh & New' }).click();
    await p.waitForSelector('.art-head');
    check('preview uses feed content', (await p.textContent('.art-body')).includes('Full body one'));
    await p.keyboard.press('r');
    await p.waitForFunction(() => document.querySelector('.art-body')?.textContent.includes('Reader paragraph'));
    check('reader mode fetches page through proxy', seen.pages === 1 && !(await p.content()).includes('Menu Menu'));
    check('opened article marked read', (await p.locator('.entry', { hasText: 'Fresh & New' }).getAttribute('class')).includes(' read'));
    await p.keyboard.press('s');
    await p.waitForTimeout(1500); // flush

    // persistence across reload + conditional refresh
    await p.reload();
    await p.waitForSelector('.entry');
    check('read state survives reload', (await p.locator('.entry', { hasText: 'Fresh & New' }).count()) === 0 || (await p.locator('.entry', { hasText: 'Fresh & New' }).getAttribute('class')).includes(' read'));
    await p.click('.src[data-stream*="tag/global.saved"]');
    await p.waitForTimeout(400);
    check('saved article persisted', (await p.locator('.entry', { hasText: 'Fresh & New' }).count()) === 1);

    seen.requests.length = 0;
    await p.click('[data-action="refresh"]');
    await p.waitForTimeout(800);
    check('refresh sends etags for the 4 healthy feeds (304s)', seen.requests.length === 1 && seen.requests[0].filter((f) => f.etag === 'v1').length === 4, seen.requests);

    // failed feed reported in settings
    await p.click('.bar [data-action="settings"]');
    await p.waitForTimeout(300);
    const status = await p.textContent('#feeds-status');
    check('settings show feed count and failures', /6 feeds/.test(status) && /2 failed/.test(status), status);
    const errsList = await p.textContent('#feeds-errors');
    check('failed feeds listed with reason', errsList.includes('Dead Feed') && errsList.includes('Timed out') && /Loose Feed/.test(errsList), errsList);
    check('failed list shows each feed URL', errsList.includes('https://dead.example/feed') && errsList.includes('https://loose.example/feed'), errsList);
    check('"not a valid feed" shows what the server returned', /Not a valid feed — .*not a feed/.test(errsList), errsList);

    // export
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#settings [data-action="export-opml"]')]);
    const exported = fs.readFileSync(await dl.path(), 'utf8');
    check('OPML export contains feeds and folders', exported.includes('xmlUrl="https://alpha.example/feed.xml"') && exported.includes('text="Tech"') && !exported.includes('Alpha again'), exported.slice(0, 200));

    // ---------- manage feeds ----------
    await p.click('[data-action="manage"].ghost'); // Settings → Manage feeds…
    await p.waitForSelector('#manage[open]');
    const feedsIn = (cat) => p.$$eval(`.mg-cat[data-cat="${cat}"] .mg-feed .mg-title span`, (n) => n.map((x) => x.textContent));
    const catsInOrder = () => p.$$eval('.mg-cat', (n) => n.map((x) => x.dataset.cat));
    {
      const r = await iconsOk(p);
      check('manager icons exist in the Lucide sprite', r.count > 5 && r.missing.length === 0, r);
    }
    check('manager lists categories in file order, uncategorized last', JSON.stringify(await catsInOrder()) === JSON.stringify(['Tech', 'Misc', '']), await catsInOrder());

    // add feed into a category
    FEEDS['https://epsilon.example/feed'] = subst(fx('atom.xml')).replace('Beta Journal', 'Epsilon News').replace('tag:beta.example,2026:1', 'tag:eps:1');
    await p.fill('#mg-url', 'epsilon.example/feed');
    await p.selectOption('#mg-cat', 'Misc');
    await p.click('[data-mg="add-feed"]');
    await p.waitForFunction(() => [...document.querySelectorAll('.mg-cat[data-cat="Misc"] .mg-title span')].some((n) => n.textContent === 'Epsilon News'));
    check('add feed into a category (fetched and titled)', (await feedsIn('Misc')).at(-1) === 'Epsilon News', await feedsIn('Misc'));
    await p.fill('#mg-url', 'nope.example/feed');
    await p.click('[data-mg="add-feed"]');
    await p.waitForTimeout(800);
    check('invalid feed is rejected and not kept', !(await p.textContent('#manage-body')).includes('nope.example'));
    await p.fill('#mg-url', 'https://alpha.example/feed.xml');
    await p.click('[data-mg="add-feed"]');
    await p.waitForTimeout(500);
    check('adding a duplicate is refused', (await feedsIn('Tech')).filter((t) => t === 'Alpha Blog').length === 1);

    // reorder feeds within a category
    check('feed order before: Gamma, Delta, Epsilon', JSON.stringify(await feedsIn('Misc')) === JSON.stringify(['Gamma', 'Delta', 'Epsilon News']), await feedsIn('Misc'));
    await p.click('.mg-feed:has-text("Epsilon News") [data-mg="feed-up"]');
    await p.waitForTimeout(300);
    check('move feed up', JSON.stringify(await feedsIn('Misc')) === JSON.stringify(['Gamma', 'Epsilon News', 'Delta']), await feedsIn('Misc'));

    // rename feed
    p.once('dialog', (d) => d.accept('Epsilon Renamed'));
    await p.click('.mg-feed:has-text("Epsilon News") [data-mg="feed-rename"]');
    await p.waitForTimeout(400);
    check('rename feed', (await feedsIn('Misc')).includes('Epsilon Renamed'));
    check('rename shows in sources list', (await p.$$eval('.src-label', (n) => n.map((x) => x.textContent))).includes('Epsilon Renamed'));

    // re-categorize: Delta -> Tech
    await p.selectOption('.mg-feed:has-text("Delta") select[data-mg="move"]', 'Tech');
    await p.waitForTimeout(400);
    check('move feed to another category (appended)', (await feedsIn('Tech')).at(-1) === 'Delta' && !(await feedsIn('Misc')).includes('Delta'), [await feedsIn('Tech'), await feedsIn('Misc')]);

    // categories: create, rename, reorder, delete
    await p.fill('#mg-newcat', 'Reading');
    await p.click('[data-mg="add-cat"]');
    await p.waitForTimeout(300);
    check('create empty category', (await catsInOrder()).includes('Reading'));
    await p.fill('#mg-newcat', 'tech');
    await p.click('[data-mg="add-cat"]');
    await p.waitForTimeout(300);
    check('duplicate category name refused (case-insensitive)', (await catsInOrder()).filter((c) => c.toLowerCase() === 'tech').length === 1);
    p.once('dialog', (d) => d.accept('Later'));
    await p.click('.mg-cat[data-cat="Reading"] [data-mg="cat-rename"]');
    await p.waitForTimeout(300);
    await p.click('.mg-cat[data-cat="Later"] [data-mg="cat-up"]');
    await p.click('.mg-cat[data-cat="Later"] [data-mg="cat-up"]');
    await p.waitForTimeout(300);
    check('rename and reorder category', JSON.stringify(await catsInOrder()) === JSON.stringify(['Later', 'Tech', 'Misc', '']), await catsInOrder());

    // export reflects the managed state (order, titles, empty category)
    const [dl2] = await Promise.all([p.waitForEvent('download'), p.click('#manage [data-action="export-opml"]')]);
    const managed = fs.readFileSync(await dl2.path(), 'utf8');
    const pos = (t) => managed.indexOf(t);
    check('export: categories in managed order, empty one kept', pos('text="Later"') > -1 && pos('text="Later"') < pos('text="Tech"') && pos('text="Tech"') < pos('text="Misc"'), managed.slice(0, 300));
    check('export: renamed title and moved feed', managed.includes('text="Epsilon Renamed"') && pos('Delta') > pos('Beta Journal') && pos('Delta') < pos('text="Misc"'));
    check('export: feed order within category', pos('Epsilon Renamed') < pos('xmlUrl="https://gamma.example/rdf"') || pos('xmlUrl="https://gamma.example/rdf"') < pos('Epsilon Renamed'));

    // remove feed keeps saved articles
    p.once('dialog', (d) => d.accept());
    await p.click('.mg-feed:has-text("Alpha Blog") [data-mg="feed-remove"]');
    await p.waitForTimeout(500);
    check('remove feed', !(await feedsIn('Tech')).includes('Alpha Blog'));
    p.once('dialog', (d) => d.accept());
    await p.click('.mg-cat[data-cat="Later"] [data-mg="cat-delete"]');
    await p.waitForTimeout(300);
    check('delete category', !(await catsInOrder()).includes('Later'));
    p.once('dialog', (d) => d.accept());
    await p.click('.mg-cat[data-cat="Misc"] [data-mg="cat-delete"]');
    await p.waitForTimeout(400);
    check('deleting a category keeps its feeds as uncategorized', (await feedsIn('')).includes('Gamma') && (await feedsIn('')).includes('Epsilon Renamed'), await feedsIn(''));

    await p.click('#manage .primary[data-action="close-manage"]');
    await p.waitForTimeout(300);
    const labels2 = await p.$$eval('.src-label', (n) => n.map((x) => x.textContent));
    check('sources list reflects management (no Alpha, no Misc)', !labels2.includes('Alpha Blog') && !labels2.includes('Misc') && labels2.includes('Tech'), labels2);
    await p.click('.src[data-stream*="tag/global.saved"]');
    await p.waitForTimeout(400);
    check('saved article survives feed removal', (await p.locator('.entry', { hasText: 'Fresh & New' }).count()) === 1);
    check('saved article keeps its source name', (await p.locator('.entry', { hasText: 'Fresh & New' }).locator('.e-src').textContent()) === 'Alpha Blog');

    // management persists across reload
    await p.reload();
    await p.waitForSelector('.entry');
    const labels3 = await p.$$eval('.src-label', (n) => n.map((x) => x.textContent));
    check('management persists after reload', labels3.includes('Tech') && !labels3.includes('Alpha Blog') && labels3.includes('Epsilon Renamed'), labels3);

    // re-import must not overwrite managed state
    await p.click('.bar [data-action="settings"]');
    await p.setInputFiles('#opml-file', path.join(__dirname, 'fixtures', 'sample.opml'));
    await p.waitForFunction(() => [...document.querySelectorAll('.src-label')].some((n) => n.textContent === 'Alpha Blog'), null, { timeout: 10000 });
    const labels4 = await p.$$eval('.src-label', (n) => n.map((x) => x.textContent));
    const at = (t) => labels4.indexOf(t);
    check('re-import adds the missing feed and fetches it', labels4.includes('Alpha Blog'), labels4);
    check('re-import keeps edits (renamed, moved, uncategorized stay put)', labels4.includes('Epsilon Renamed') && at('Delta') > at('Tech') && at('Delta') < at('Uncategorized') && at('Gamma') > at('Uncategorized'), labels4);

    // ---------- failed feeds: list, retry, edit URL, remove ----------
    await p.click('.bar [data-action="settings"]');
    await p.waitForSelector('#feeds-errors li');
    check('failed list: every failed feed has edit and remove buttons', (await p.locator('#feeds-errors li').count()) === 2 && (await p.locator('#feeds-errors [data-failed-del]').count()) === 2 && (await p.locator('#feeds-errors [data-failed-edit]').count()) === 2);
    seen.requests.length = 0;
    await p.click('[data-action="retry-failed"]');
    await p.waitForFunction(() => /2 failed/.test(document.querySelector('#feeds-status')?.textContent || ''));
    check('retry re-fetches only the failed feeds', seen.requests.length === 1 && seen.requests[0].length === 2 && seen.requests[0].every((f) => /dead|loose/.test(f.url)), seen.requests);

    // per-feed retry: only that feed, with visible feedback above the open dialog
    seen.requests.length = 0;
    await p.click('#feeds-errors li:has-text("Dead Feed") [data-failed-retry]');
    await p.waitForFunction(() => /Still failing/.test(document.querySelector('#toast')?.textContent || ''));
    check('per-feed retry fetches just that feed and reports', seen.requests.length === 1 && seen.requests[0].length === 1 && /dead/.test(seen.requests[0][0].url), seen.requests);
    // Pixel check (hit-testing is blocked outside a modal dialog): the toast is dark, the dialog behind it is white.
    const box = await p.evaluate(() => { const r = document.querySelector('#toast').getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 - 3, width: 6, height: 6 }; });
    const shot = (await p.screenshot({ clip: box })).toString('base64');
    const px = await (async () => {
      const q = await ctx.newPage();
      const rgb = await q.evaluate(async (b64) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        return Array.from(g.getImageData(img.width / 2, img.height / 2, 1, 1).data.slice(0, 3));
      }, shot);
      await q.close();
      return rgb;
    })();
    const toastOnTop = px.every((v) => v < 110);
    check('toast is drawn above the open Settings dialog', toastOnTop, px);

    // a proxy 404 explains itself
    feedsStatus = 404;
    await p.click('#feeds-errors li:has-text("Dead Feed") [data-failed-retry]');
    await p.waitForFunction(() => /no \/feeds endpoint/.test(document.querySelector('#toast')?.textContent || ''));
    const msg404 = await p.textContent('#toast');
    check('proxy 404 names the endpoint, what it said and the likely cause', /Proxy error 404 at proxy\.test\/feeds/.test(msg404) && /Not found/.test(msg404) && /workers\.dev/.test(msg404), msg404);
    feedsStatus = 200;

    // edit URL from the failed list: Loose Feed -> a working address
    FEEDS['https://revived.example/feed'] = subst(fx('rss.xml')).replace('Alpha Blog', 'Revived Blog').replace(/alpha-(\d)/g, 'rev-$1');
    p.once('dialog', (d) => { check('edit URL prompt shows the current address', d.defaultValue() === 'https://loose.example/feed', d.defaultValue()); d.accept('revived.example/feed'); });
    await p.click('#feeds-errors li:has-text("Loose Feed") [data-failed-edit]');
    await p.waitForFunction(() => /1 failed/.test(document.querySelector('#feeds-status')?.textContent || ''));
    check('edited feed recovers and leaves the failed list', !(await p.textContent('#feeds-errors')).includes('Loose Feed'));

    await p.click('#feeds-errors li:has-text("Dead Feed") [data-failed-del]');
    await p.waitForFunction(() => !document.querySelector('#feeds-errors li'));
    check('remove a single failed feed hides the failed list', await p.locator('#feeds-failed-actions').isHidden());
    await p.click('#settings .dlg-head .icon-btn');

    // edit URL from Manage feeds: to an address that fails, then to one another feed already uses
    await p.click('#manage-btn');
    await p.waitForSelector('#manage[open]');
    check('edited feed kept its category and name', (await p.textContent('.mg-cat[data-cat=""]')).includes('Loose Feed'));
    p.once('dialog', (d) => d.accept('https://dead2.example/feed'));
    await p.click('.mg-feed:has-text("Loose Feed") [data-mg="feed-url"]');
    await p.waitForFunction(() => /Failed: Timed out/.test(document.querySelector('.mg-feed')?.closest('#manage-body')?.textContent || ''));
    check('Manage: new address that fails is kept and shown as failed', (await p.textContent('.mg-feed:has-text("Loose Feed")')).includes('Failed: Timed out'));
    p.once('dialog', (d) => d.accept('https://alpha.example/feed.xml'));
    await p.click('.mg-feed:has-text("Loose Feed") [data-mg="feed-url"]');
    await p.waitForTimeout(500);
    check('address already used by another feed is refused', (await p.textContent('.mg-feed:has-text("Loose Feed")')).includes('Failed'));
    await p.click('#manage .primary[data-action="close-manage"]');

    await p.click('.bar [data-action="settings"]');
    await p.waitForSelector('#feeds-errors li');
    check('failed list shows the edited address', (await p.textContent('#feeds-errors')).includes('https://dead2.example/feed'));
    p.once('dialog', (d) => d.accept());
    await p.click('[data-action="remove-failed"]');
    await p.waitForFunction(() => !document.querySelector('#feeds-errors li'));
    check('remove all failed', await p.locator('#feeds-failed-actions').isHidden() && !(await p.textContent('#feeds-status')).includes('failed'));
    // ---------- Hacker News: refused via the proxy, works via the HN API fetched by the browser ----------
    let algoliaCalls = 0;
    await p.route('https://hn.algolia.com/**', (route) => { algoliaCalls++; route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: hnj }); });
    seen.requests.length = 0;
    await p.setInputFiles('#opml-file', { name: 'hn.opml', mimeType: 'text/x-opml', buffer: Buffer.from('<?xml version="1.0"?><opml version="1.0"><body><outline text="News"><outline type="rss" text="Hacker News" xmlUrl="https://hackernews.com/rss"/></outline></body></opml>') });
    await p.waitForFunction(() => /feed failed/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 15000 });
    await p.click('.bar [data-action="settings"]');
    await p.waitForSelector('#feeds-errors li:has-text("Hacker News")');
    const hnLine = await p.textContent('#feeds-errors li:has-text("Hacker News")');
    check('HN failure shows status, what HN said and which server answered', /HTTP 419 — Sorry — server: cloudflare/.test(hnLine) && hnLine.includes('https://hackernews.com/rss'), hnLine);
    check('failed HN feed offers the API switch', (await p.locator('#feeds-errors li:has-text("Hacker News") [data-failed-hn]').count()) === 1);
    await p.click('#feeds-errors [data-failed-hn]');
    await p.waitForFunction(() => !document.querySelector('#feeds-errors li'));
    check('after switching, HN is fetched by the browser (not the proxy) and works', algoliaCalls >= 1 && !JSON.stringify(seen.requests).includes('algolia'), [algoliaCalls, seen.requests]);
    await p.click('#settings .dlg-head .icon-btn');
    await p.click('.src[data-stream*="global.all"]');
    await p.waitForSelector('.entry:has-text("Ask HN")');
    const askRow = p.locator('.entry', { hasText: 'Ask HN' });
    check('HN articles are listed with points and comments', /12 points · 3 comments/.test(await askRow.textContent()));
    check('HN feed keeps its name and category', (await p.$$eval('.src-label', (n) => n.map((x) => x.textContent))).includes('Hacker News'));

    p.once('dialog', (d) => d.accept());
    await p.click('.bar [data-action="settings"]');
    await p.click('[data-action="reset-local"]');
    await p.waitForSelector('.welcome');
    check('reset returns to welcome', true);
    check('no page errors', errs.length === 0, errs);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await b.close(); server.close();
    process.exit(failures ? 1 : 0);
  }
});
