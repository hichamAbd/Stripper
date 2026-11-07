'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('../js/zip.js');

test('crc32 matches the standard check value', () => {
  assert.equal(Zip.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('createZip writes a valid stored archive with a fixed timestamp', () => {
  const files = [
    { name: 'photo-a.jpg', data: new Uint8Array([1, 2, 3]) },
    { name: 'photo-b.jpg', data: new Uint8Array([4, 5, 6, 7]) }
  ];
  const parts = Zip.createZip(files);
  const buf = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  assert.equal(buf.readUInt16LE(eocd + 10), 2);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt32LE(cdOffset), 0x02014b50);
  // first local header
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt16LE(10), 0);        // time 00:00
  assert.equal(buf.readUInt16LE(12), 0x0021);   // date 1980-01-01
  assert.equal(buf.readUInt32LE(14), Zip.crc32(files[0].data));
  assert.equal(buf.subarray(30, 30 + 11).toString(), 'photo-a.jpg');
});
