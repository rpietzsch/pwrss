// An installed app must pick up a new version by itself (service worker update -> reload once).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || '.');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const ver = { v: 'one' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (p === '/sw.js') body = Buffer.from(body.toString().replace('__BUILD__', ver.v)); // "deploys" a new version on demand
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});

let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) { failures++; if (extra !== undefined) console.log('   ', JSON.stringify(extra)); } };

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/`;
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: 'allow' });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base);
    await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
    await p.waitForTimeout(500);
    check('first install does not reload the page', await p.evaluate(() => !sessionStorage.getItem('pwrss.updated')));
    await p.reload(); // a returning visit: the page now starts under the service worker's control
    await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
    await p.waitForTimeout(500);
    const cachesBefore = await p.evaluate(() => caches.keys());
    check('version one is installed', cachesBefore.includes('pwrss-one'), cachesBefore);

    // a new version is deployed; the app checks for it
    ver.v = 'two';
    await Promise.all([
      p.waitForEvent('load', { timeout: 20000 }),
      p.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update())),
    ]);
    await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
    const cachesAfter = await p.evaluate(() => caches.keys());
    check('the page reloaded by itself onto the new version', cachesAfter.includes('pwrss-two') && !cachesAfter.includes('pwrss-one'), cachesAfter);
    await p.waitForFunction(() => /Updated to the latest version/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 });
    check('it says so', true);
    check('and does not reload again', await p.evaluate(() => !sessionStorage.getItem('pwrss.updated')));

    await p.click('.welcome [data-action="settings"]');
    check('Settings shows the running version', /Version dev/.test(await p.textContent('#app-version')), await p.textContent('#app-version'));
    check('no page errors', errs.length === 0, errs);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await b.close(); server.close();
    process.exit(failures ? 1 : 0);
  }
});
