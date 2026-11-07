'use strict';
// Home-screen icons: phones ignore SVG favicons, so these PNGs must exist
// at the right sizes or iOS/Android fall back to a generic letter tile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngInfo(file) {
  const b = fs.readFileSync(path.join(root, file));
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

test('apple-touch-icon is a 180×180 opaque PNG', () => {
  const m = /<link rel="apple-touch-icon" href="([^"]+)" sizes="180x180">/.exec(html);
  assert.ok(m, 'index.html must link an apple-touch-icon');
  const info = pngInfo(m[1]);
  assert.deepEqual([info.width, info.height], [180, 180]);
  // iOS fills transparent pixels with black, so no alpha channel (types 4 and 6)
  assert.ok(info.colorType !== 4 && info.colorType !== 6, 'apple-touch-icon must not be transparent');
});

test('manifest is linked, allowed by the CSP, and its icons match their declared sizes', () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /manifest-src 'self'/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.short_name, 'Stripper');
  const purposes = new Set();
  for (const icon of manifest.icons) {
    const [w, h] = icon.sizes.split('x').map(Number);
    const info = pngInfo(icon.src);
    assert.deepEqual([info.width, info.height], [w, h], icon.src);
    purposes.add(icon.purpose);
  }
  assert.ok(purposes.has('maskable'), 'Android needs a maskable icon');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
});

test('every icon linked from index.html exists', () => {
  for (const m of html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, m[1])), `missing ${m[1]}`);
  }
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Stripper">/);
});
