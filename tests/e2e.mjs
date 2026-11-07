// End-to-end check in a real browser.
//
//   npm i --no-save playwright && npx playwright install chromium   (once)
//   npm run test:e2e
//
// Serves the site locally, uploads the fixtures, downloads every cleaned file
// and verifies it: no metadata left, new checksum, correct orientation, and
// no network requests to anywhere but the local server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const Meta = require('../js/metadata.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function jpegSize(b) {
  let i = 2;
  while (i < b.length) {
    const m = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xC0 && m <= 0xC3) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}

const browser = await chromium.launch();
let failed = false;
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 900, height: 1200 } });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(origin + '/');

  const names = ['gps.jpg', 'rotated.jpg', 'text.png', 'exif.webp', 'plain.jpg'];
  await page.setInputFiles('#file-input', names.map((n) => path.join(fixtures, n)));
  await page.setInputFiles('#file-input', [path.join(fixtures, 'gps.jpg')]); // same photo again
  const all = [...names, 'gps.jpg'];

  await page.waitForFunction((n) => document.querySelectorAll('.card.is-done').length === n, all.length, { timeout: 30000 });

  const cards = page.locator('.card');
  const firstText = await cards.nth(0).innerText();
  assert.match(firstText, /reveals where it was taken/);
  assert.match(firstText, /48\.85809° N, 2\.29450° E/);
  assert.match(firstText, /SN-0042-TEST/);
  assert.match(firstText, /All removed/);
  assert.match(await cards.nth(4).innerText(), /No hidden details found/);

  const outHashes = [];
  for (let i = 0; i < all.length; i++) {
    const card = cards.nth(i);
    const [dl] = await Promise.all([page.waitForEvent('download'), card.locator('a.download').click()]);
    const bytes = new Uint8Array(fs.readFileSync(await dl.path()));
    const original = fs.readFileSync(path.join(fixtures, all[i]));
    const report = Meta.scan(bytes);
    const left = report.items.filter((x) => x.severity !== 'info');

    assert.deepEqual(left, [], `${all[i]}: metadata left: ${JSON.stringify(left)}`);
    assert.notEqual(sha(bytes), sha(original), `${all[i]}: checksum unchanged`);
    assert.match(dl.suggestedFilename(), /^photo-[0-9a-f]{8}\.(jpg|png|webp)$/);
    outHashes.push(sha(bytes));
    console.log(`  ✓ ${all[i].padEnd(12)} → ${dl.suggestedFilename().padEnd(20)} ${original.length} → ${bytes.length} bytes, ` +
      `${report.items.length ? report.items.map((x) => x.label).join(', ') : 'nothing'} left`);

    if (all[i] === 'rotated.jpg') {
      // stored 120×60 with "rotate 90°" flag → the clean copy must be 60×120 pixels
      assert.deepEqual(jpegSize(bytes), { width: 60, height: 120 });
    }
    if (all[i] === 'text.png') assert.equal(Meta.detectFormat(bytes), 'png');
    if (all[i] === 'exif.webp') assert.equal(Meta.detectFormat(bytes), 'webp');
  }
  assert.notEqual(outHashes[0], outHashes[5], 'cleaning the same photo twice must give different checksums');
  console.log('  ✓ same photo cleaned twice → two different checksums');

  // Download all → zip
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.click('#download-all')]);
  const zip = fs.readFileSync(await zipDl.path());
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), all.length);
  console.log(`  ✓ zip with ${all.length} photos`);

  // Changing an option re-cleans: max size 1280 has no effect on tiny files, so use PNG output
  await page.locator('details.options summary').click();
  await page.selectOption('#opt-format', 'png');
  await page.waitForFunction(() => [...document.querySelectorAll('.card.is-done code')].filter((c) => /\.png$/.test(c.textContent)).length === 6, null, { timeout: 30000 });
  console.log('  ✓ options re-clean existing photos');

  const external = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:'));
  assert.deepEqual(external, [], 'page made outside requests');
  console.log(`  ✓ no outside network requests (${requests.length} local)`);
  assert.deepEqual(errors, []);
  console.log('  ✓ no console errors');

  if (process.env.SCREENSHOT_DIR) {
    await page.selectOption('#opt-format', 'auto');
    await page.locator('details.options summary').click();
    await page.waitForTimeout(800);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `screenshot-${scheme}.png`), fullPage: true });
    }
  }
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? '\nE2E FAILED' : '\nE2E passed');
process.exit(failed ? 1 : 0);
