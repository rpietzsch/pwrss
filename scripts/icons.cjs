// Render icons/icon.svg to the PNG app icons. Usage: node scripts/icons.cjs [icons-dir]
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const dir = process.argv[2] || require('path').join(__dirname, '..', 'icons');
  const svg = fs.readFileSync(dir + '/icon.svg', 'utf8');
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (size, file, mask) => {
    await p.setViewportSize({ width: size, height: size });
    const inner = mask
      ? svg.replace('rx="112"', 'rx="0"').replace('<g ', '<g transform="translate(51 51) scale(.8)" ').replace('<circle cx="168" cy="344" r="34"', '<circle cx="185" cy="326" r="27"')
      : svg;
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${inner}`);
    await p.screenshot({ path: dir + '/' + file, omitBackground: true });
  };
  await shot(192, 'icon-192.png');
  await shot(512, 'icon-512.png');
  await shot(512, 'icon-maskable-512.png', true);
  await shot(180, 'apple-touch-icon.png', true);
  await b.close();
})();
