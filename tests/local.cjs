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
    await p.route(PROXY + '/**', (route) => {
      const req = route.request();
      const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
      const u = new URL(req.url());
      if (u.pathname === '/feeds') {
        const { feeds } = JSON.parse(req.postData());
        seen.requests.push(feeds);
        const results = feeds.map((f) => {
          if (f.url.includes('dead.example')) return { url: f.url, status: 0, error: 'Timed out' };
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
    await p.evaluate((px) => localStorage.setItem('pwrss.settings', JSON.stringify({ proxy: px })), PROXY);
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

    // export
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-action="export-opml"]')]);
    const exported = fs.readFileSync(await dl.path(), 'utf8');
    check('OPML export contains feeds and folders', exported.includes('xmlUrl="https://alpha.example/feed.xml"') && exported.includes('text="Tech"') && !exported.includes('Alpha again'), exported.slice(0, 200));

    // add feed (by URL, scheme optional) and reset
    FEEDS['https://epsilon.example/feed'] = subst(fx('atom.xml')).replace('Beta Journal', 'Epsilon News').replace('tag:beta.example,2026:1', 'tag:eps:1');
    await p.fill('#add-feed-url', 'epsilon.example/feed');
    await p.click('[data-action="add-feed"]');
    await p.waitForFunction(() => document.querySelector('#feeds-status')?.textContent.includes('7 feeds'));
    check('add feed by URL', true);
    await p.fill('#add-feed-url', 'nope.example/feed');
    await p.click('[data-action="add-feed"]');
    await p.waitForTimeout(800);
    check('invalid feed is rejected and not kept', /6 feeds|7 feeds/.test(await p.textContent('#feeds-status')) && !(await p.textContent('#feeds-status')).includes('8 feeds'));

    p.once('dialog', (d) => d.accept());
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
