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

    await p.locator('.entry').nth(1).click();
    await p.waitForSelector('.art-head');
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

    check('no page errors', errs.length === 0);
    if (errs.length) console.log(errs);
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await b.close(); server.close();
    process.exit(failures ? 1 : 0);
  }
});
