// Render the PNG app icons from the SVG sources in icons/.
//
//   npm i --no-save playwright && npx playwright install chromium   (once)
//   node scripts/make-icons.cjs
'use strict';
const path = require('node:path');
const { chromium } = require('playwright');

const dir = path.join(__dirname, '..', 'icons');
const OUTPUTS = [
  // iOS home screen: must be opaque; iOS rounds the corners itself.
  { src: 'icon-maskable.svg', out: 'apple-touch-icon.png', size: 180, transparent: false },
  // Android launchers crop maskable icons to their own shape.
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512, transparent: false },
  // Everything else (install prompts, tabs): rounded square with transparent corners.
  { src: 'icon.svg', out: 'icon-192.png', size: 192, transparent: true },
  { src: 'icon.svg', out: 'icon-512.png', size: 512, transparent: true }
];

(async () => {
  const browser = await chromium.launch();
  try {
    for (const o of OUTPUTS) {
      const page = await browser.newPage({ viewport: { width: o.size, height: o.size }, deviceScaleFactor: 1 });
      await page.goto('file://' + path.join(dir, o.src));
      await page.screenshot({ path: path.join(dir, o.out), omitBackground: o.transparent });
      await page.close();
      console.log(`icons/${o.out} (${o.size}×${o.size})`);
    }
  } finally {
    await browser.close();
  }
})();
