/*!
 * Stripper — zip.js
 *
 * Minimal "store" (uncompressed) ZIP writer for the "Download all" button.
 * Photos are already compressed, so storing them is as small as deflating.
 * Every entry gets the same fixed timestamp (1980-01-01 00:00) so the archive
 * doesn't record when you made it.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StripperZip = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  var DOS_TIME = 0;                          // 00:00:00
  var DOS_DATE = (0 << 9) | (1 << 5) | 1;    // 1980-01-01

  /**
   * @param {{name: string, data: Uint8Array}[]} files
   * @returns {Uint8Array[]} parts — pass to `new Blob(parts)`
   */
  function createZip(files) {
    var enc = new TextEncoder();
    var parts = [], central = [];
    var offset = 0, centralSize = 0;

    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var crc = crc32(f.data);
      var size = f.data.length;

      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);         // version needed
      lv.setUint16(6, 0x0800, true);     // UTF-8 names
      lv.setUint16(8, 0, true);          // stored
      lv.setUint16(10, DOS_TIME, true);
      lv.setUint16(12, DOS_DATE, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);

      var cd = new Uint8Array(46 + name.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);         // version made by
      cv.setUint16(6, 20, true);         // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, DOS_TIME, true);
      cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);    // local header offset
      cd.set(name, 46);

      parts.push(local, f.data);
      central.push(cd);
      offset += local.length + size;
      centralSize += cd.length;
    });

    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return parts.concat(central, [end]);
  }

  return { createZip: createZip, crc32: crc32 };
});
