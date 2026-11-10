// End-to-end smoke test in demo mode (Playwright + Chromium).
// Usage: node tests/smoke.cjs [rootDir=.]   — starts its own static server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

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
// Every <use> icon on the page must exist in the vendored Lucide sprite.
const iconsOk = (page) => page.evaluate(async () => {
  const svg = await (await fetch('vendor/lucide-sprite.svg')).text();
  const ids = new Set([...svg.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  const uses = [...document.querySelectorAll('use')].map((u) => (u.getAttribute('href') || '').split('#')[1]);
  const missing = [...new Set(uses.filter((id) => !ids.has(id)))];
  const broken = [...document.querySelectorAll('button.icon-btn svg')].filter((s) => s.getBoundingClientRect().width && !s.querySelector('use')).length;
  return { missing, count: uses.length, broken };
});

const check = (name, ok) => { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) failures++; };

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/`;
  const b = await chromium.launch();
  const errs = [];
  try {
    const p = await (await b.newContext({ viewport: { width: 1400, height: 860 }, colorScheme: 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base);
    check('welcome screen', await p.locator('.welcome').isVisible());
    await p.click('.welcome [data-action="demo"]');
    await p.waitForSelector('.entry');
    check('entries render', (await p.locator('.entry').count()) > 10);

    await p.click('.bar [data-action="settings"]');
    check('settings shows the app version', /^\S*\s*\S+/.test(await p.textContent('#app-version')), await p.textContent('#app-version'));
    await p.click('#settings .dlg-head .icon-btn');
    {
      const r = await iconsOk(p);
      check('all list/toolbar icons exist in the Lucide sprite', r.count > 8 && r.missing.length === 0, r);
    }
    await p.locator('.entry').nth(1).click();
    await p.waitForSelector('.art-head');
    {
      const r = await iconsOk(p);
      check('all article icons exist in the Lucide sprite', r.missing.length === 0, r);
    }
    check('open marks read', (await p.locator('.entry').nth(1).getAttribute('class')).includes(' read'));

    await p.keyboard.press('r');
    await p.waitForSelector('.art-body:not(.loading)');
    check('reader mode strips chrome', !(await p.content()).includes('Popular posts'));

    const swipe = async (i, dx) => {
      const bb = await p.locator('.entry').nth(i).boundingBox();
      const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
      await p.mouse.move(x, y); await p.mouse.down();
      for (let s = 1; s <= 10; s++) await p.mouse.move(x + (dx * s) / 10, y);
      await p.mouse.up(); await p.waitForTimeout(300);
      return p.locator('.entry').nth(i).getAttribute('class');
    };
    check('swipe right toggles read', !(await swipe(4, 150)).includes('unread'));
    check('swipe left toggles saved', (await swipe(5, -150)).includes('saved'));

    await p.locator('.entry').nth(6).click({ button: 'right' });
    await p.waitForTimeout(300);
    check('quick preview opens', await p.locator('#peek').isVisible());
    await p.keyboard.press('Escape');

    const bg = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await bg();
    await p.emulateMedia({ colorScheme: 'dark' });
    check('follows system dark mode', (await bg()) !== light);
    await p.waitForTimeout(400);
    await p.keyboard.press('t'); // System -> Light
    check('theme override: light', (await bg()) === light);
    await p.keyboard.press('t'); // Light -> Dark
    check('theme override: dark', (await bg()) !== light);
    await p.keyboard.press('t'); // back to System

    const m = await (await b.newContext({ ...devices['iPhone 14'] })).newPage();
    m.on('pageerror', (e) => errs.push(e.message));
    await m.goto(base);
    await m.evaluate(() => localStorage.setItem('pwrss.settings', JSON.stringify({ demo: true })));
    await m.reload();
    await m.waitForSelector('.entry');
    await m.locator('.entry').first().tap();
    await m.waitForTimeout(400);
    const barY = () => m.evaluate(() => document.querySelector('#list > .bar').getBoundingClientRect().top);
    const vh = await m.evaluate(() => innerHeight);
    check('toolbar defaults to bottom on phone', (await barY()) > vh / 2);
    await m.evaluate(() => { document.documentElement.dataset.toolbar = 'top'; });
    check('toolbar can be moved to top', (await barY()) < 60);
    await m.evaluate(() => { document.documentElement.dataset.toolbar = 'bottom'; });
    check('mobile: article view', (await m.getAttribute('#app', 'data-view')) === 'article');
    await m.goBack(); await m.waitForTimeout(300);
    check('mobile: back to list', (await m.getAttribute('#app', 'data-view')) === 'list');

    // ---- OAuth sign-in (all network mocked) ----
    const PROXY = 'https://proxy.test';
    const o = await (await b.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
    o.on('pageerror', (e) => errs.push(e.message));
    const seen = { auth: [], profile: [], cats: [], refresh: 0 };
    let authorizeUrl = null;
    await o.route('https://cloud.feedly.com/**', (r) => { authorizeUrl = r.request().url(); r.fulfill({ status: 200, contentType: 'text/html', body: 'feedly' }); });
    await o.route(PROXY + '/**', (r) => {
      const u = new URL(r.request().url());
      const json = (d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(d) });
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      if (u.pathname === '/auth/config') return json({ enabled: true, clientId: 'cid' });
      if (u.pathname === '/auth/token') { seen.auth.push(JSON.parse(r.request().postData())); return json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, id: 'u1' }); }
      if (u.pathname === '/auth/refresh') { seen.refresh++; return json({ access_token: 'AT2', expires_in: 3600 }); }
      if (u.pathname === '/v3/profile') { seen.profile.push(r.request().headers().authorization); return json({ id: 'u1' }); }
      if (u.pathname === '/v3/categories') seen.cats.push(r.request().headers().authorization);
      if (u.pathname === '/v3/categories' || u.pathname === '/v3/subscriptions') return json([]);
      if (u.pathname === '/v3/markers/counts') return json({ unreadcounts: [] });
      if (u.pathname === '/v3/streams/contents') return json({ items: [] });
      return json({});
    });
    await o.goto(base);
    await o.evaluate((px) => localStorage.setItem('pwrss.settings', JSON.stringify({ proxy: px })), PROXY);
    await o.reload();
    await o.click('.welcome [data-action="settings"]');
    check('sign-in button in settings', await o.locator('#signin-btn').isVisible());
    await o.click('#signin-btn');
    await o.waitForURL(/cloud\.feedly\.com/);
    const au = new URL(authorizeUrl);
    check('authorize URL has client, redirect and scope', au.searchParams.get('client_id') === 'cid'
      && au.searchParams.get('redirect_uri') === base && au.searchParams.get('scope') === 'https://cloud.feedly.com/subscriptions'
      && au.searchParams.get('response_type') === 'code');
    const state = au.searchParams.get('state');

    await o.goto(base + '?code=thecode&state=WRONG');
    await o.waitForTimeout(500);
    check('wrong state is rejected', seen.auth.length === 0 && !(await o.evaluate(() => localStorage.getItem('pwrss.settings'))).includes('AT1'));

    await o.evaluate((st) => localStorage.setItem('pwrss.oauth.state', JSON.stringify({ state: st, ts: Date.now() })), state);
    await o.goto(base + '?code=thecode&state=' + state);
    await o.waitForFunction(() => (localStorage.getItem('pwrss.settings') || '').includes('AT1'));
    check('code exchanged via proxy', seen.auth.length === 1 && seen.auth[0].code === 'thecode' && seen.auth[0].redirect_uri === base);
    await o.waitForTimeout(500);
    check('API call uses OAuth token', seen.profile.includes('Bearer AT1'));
    check('query string cleaned', !o.url().includes('code='));

    await o.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('pwrss.settings'));
      s.oauth.expires = Date.now() + 1000;
      localStorage.setItem('pwrss.settings', JSON.stringify(s));
    });
    await o.reload();
    await o.waitForFunction(() => (localStorage.getItem('pwrss.settings') || '').includes('AT2'));
    check('expiring token refreshed automatically', seen.refresh >= 1 && seen.cats.includes('Bearer AT2'));
    check('refresh token kept', (await o.evaluate(() => localStorage.getItem('pwrss.settings'))).includes('RT1'));

    check('no page errors', errs.length === 0);
    if (errs.length) console.log(errs);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await b.close(); server.close();
    process.exit(failures ? 1 : 0);
  }
});
