'use strict';
// Run with: npm test   (or: node --test tests/)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Meta = require('../js/metadata.js');

const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const labels = (report) => report.items.map((i) => i.label);
const risky = (report) => report.items.filter((i) => i.severity !== 'info');
const valueOf = (report, label) => (report.items.find((i) => i.label === label) || {}).value;

const EIFFEL = { lat: 48.858092, lon: 2.2945 };

function assertEiffel(gps) {
  assert.ok(gps, 'expected GPS');
  assert.ok(Math.abs(gps.lat - EIFFEL.lat) < 1e-5, `lat ${gps.lat}`);
  assert.ok(Math.abs(gps.lon - EIFFEL.lon) < 1e-5, `lon ${gps.lon}`);
}

test('detects formats', () => {
  assert.equal(Meta.detectFormat(fixture('gps.jpg')), 'jpeg');
  assert.equal(Meta.detectFormat(fixture('text.png')), 'png');
  assert.equal(Meta.detectFormat(fixture('exif.webp')), 'webp');
  assert.equal(Meta.detectFormat(new Uint8Array(4)), 'unknown');
});

test('JPEG: finds GPS, device, serial, date, XMP, IPTC, comment and hidden video', () => {
  const r = Meta.scan(fixture('gps.jpg'));
  assertEiffel(r.gps);
  assert.equal(r.gps.alt, 35);
  const gpsItem = r.items.find((i) => i.label === 'GPS location');
  assert.equal(gpsItem.severity, 'danger');
  assert.match(gpsItem.value, /48\.85809° N, 2\.29450° E/);
  assert.equal(valueOf(r, 'Camera / phone'), 'Apple iPhone 15 Pro');
  assert.equal(valueOf(r, 'Camera serial number'), 'SN-0042-TEST');
  assert.equal(valueOf(r, 'Date & time taken'), '2026-11-07 18:30:12 (UTC+01:00)');
  assert.equal(valueOf(r, 'City'), 'Paris');
  assert.equal(valueOf(r, 'Author'), 'Jane Doe');
  assert.equal(valueOf(r, 'Comment'), 'Taken at home');
  assert.ok(labels(r).includes('XMP metadata'));
  assert.ok(labels(r).includes('IPTC / Photoshop data'));
  assert.match(valueOf(r, 'Hidden data after the image'), /video clip/);
});

test('PNG: finds eXIf GPS, text chunks, XMP and modification time', () => {
  const r = Meta.scan(fixture('text.png'));
  assertEiffel(r.gps);
  assert.equal(valueOf(r, 'Author'), 'Jane Doe');
  assert.equal(valueOf(r, 'Comment'), 'Kitchen window');
  assert.equal(valueOf(r, 'Last modified'), '2026-11-07 18:30:12 UTC');
  assert.equal(valueOf(r, 'City'), 'Paris');
});

test('WebP: finds EXIF GPS and XMP', () => {
  const r = Meta.scan(fixture('exif.webp'));
  assertEiffel(r.gps);
  assert.ok(labels(r).includes('XMP metadata'));
  assert.equal(valueOf(r, 'Camera serial number'), 'SN-0042-TEST');
});

test('a photo without metadata reports nothing risky', () => {
  const r = Meta.scan(fixture('plain.jpg'));
  assert.equal(r.gps, null);
  assert.deepEqual(risky(r), []);
});

test('unknown containers (e.g. HEIC) are searched for EXIF and XMP blocks', () => {
  const jpeg = fixture('gps.jpg');
  // Fake ISOBMFF file: ftyp box, then the EXIF and XMP payloads somewhere inside.
  const exifStart = Buffer.from(jpeg).indexOf('Exif\0\0');
  const xmpStart = Buffer.from(jpeg).indexOf('<x:xmpmeta');
  const fake = Buffer.concat([
    Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'),
    Buffer.alloc(64),
    Buffer.from(jpeg.subarray(exifStart, exifStart + 600)),
    Buffer.from(jpeg.subarray(xmpStart, xmpStart + 520))
  ]);
  const r = Meta.scan(new Uint8Array(fake));
  assert.equal(r.format, 'heic');
  assert.equal(r.limited, true);
  assertEiffel(r.gps);
  assert.ok(labels(r).includes('XMP metadata'));
});

test('XMP-only GPS is found', () => {
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description exif:GPSLatitude="48,51.4855N" exif:GPSLongitude="2,17.67W"/></x:xmpmeta>';
  const header = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
  const body = Buffer.concat([header, Buffer.from(xmp)]);
  const seg = Buffer.concat([Buffer.from([0xFF, 0xE1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const jpeg = fixture('plain.jpg');
  const file = Buffer.concat([Buffer.from(jpeg.subarray(0, 2)), seg, Buffer.from(jpeg.subarray(2))]);
  const r = Meta.scan(new Uint8Array(file));
  assert.ok(Math.abs(r.gps.lat - 48.858092) < 1e-5);
  assert.ok(Math.abs(r.gps.lon + 2.2945) < 1e-5);
});

for (const name of ['gps.jpg', 'rotated.jpg', 'text.png', 'exif.webp']) {
  test(`sanitize removes every risky block from ${name}`, () => {
    const input = fixture(name);
    const out = Meta.sanitize(input);
    assert.ok(out.length < input.length);
    const r = Meta.scan(out);
    assert.equal(r.gps, null);
    assert.deepEqual(risky(r), [], JSON.stringify(r.items));
    assert.equal(Meta.detectFormat(out), Meta.detectFormat(input));
  });
}

test('sanitize keeps JPEG image data byte-for-byte', () => {
  // gps.jpg and plain.jpg were encoded from the same pixels with the same settings
  assert.deepEqual(Buffer.from(Meta.sanitize(fixture('gps.jpg'))), Buffer.from(fixture('plain.jpg')));
});

test('sanitize clears WebP VP8X metadata flags and fixes the RIFF size', () => {
  const out = Meta.sanitize(fixture('exif.webp'));
  const riffSize = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
  assert.equal(riffSize + 8, out.length);
  const vp8x = Buffer.from(out).indexOf('VP8X');
  assert.ok(vp8x > 0);
  assert.equal(out[vp8x + 8] & 0x0C, 0);
});

test('never throws on truncated or corrupted files', () => {
  let seed = 1;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const name of ['gps.jpg', 'rotated.jpg', 'text.png', 'exif.webp']) {
    const input = fixture(name);
    for (let cut = 0; cut < input.length; cut += 7) Meta.scan(input.subarray(0, cut));
    for (let n = 0; n < 300; n++) {
      const copy = input.slice();
      for (let k = 0; k < 8; k++) copy[Math.floor(rand() * copy.length)] = Math.floor(rand() * 256);
      Meta.scan(copy);
      try { Meta.sanitize(copy); } catch (e) { assert.match(e.message, /Malformed/); }
    }
  }
});

test('metadata strings are returned as plain text', () => {
  const r = Meta.scan(fixture('gps.jpg'));
  for (const item of r.items) assert.equal(typeof item.value, 'string');
});
