/*!
 * Stripper — metadata.js
 *
 * Finds identifying metadata inside image files (so we can show you what a
 * photo gives away) and removes metadata blocks from JPEG, PNG and WebP
 * containers. Pure functions over Uint8Array: no dependencies, no network.
 *
 * Works as a browser global (window.StripperMeta) and as a CommonJS module
 * (used by the tests).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StripperMeta = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Byte helpers
  // ---------------------------------------------------------------------------

  function matchAt(b, off, str) {
    if (off < 0 || off + str.length > b.length) return false;
    for (var i = 0; i < str.length; i++) if (b[off + i] !== str.charCodeAt(i)) return false;
    return true;
  }

  function indexOf(b, str, from, to) {
    var end = Math.min(to == null ? b.length : to, b.length) - str.length;
    var first = str.charCodeAt(0);
    for (var i = from || 0; i <= end; i++) if (b[i] === first && matchAt(b, i, str)) return i;
    return -1;
  }

  function indexOfByte(b, value, from, to) {
    for (var i = from; i < to; i++) if (b[i] === value) return i;
    return -1;
  }

  function latin1(b, start, end) {
    var s = '';
    var stop = Math.min(end, b.length);
    for (var i = start; i < stop; i += 8192) {
      s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 8192, stop)));
    }
    return s;
  }

  var utf8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  function utf8(b, start, end) {
    end = Math.min(end, b.length);
    if (end <= start) return '';
    return utf8Decoder ? utf8Decoder.decode(b.subarray(start, end)) : latin1(b, start, end);
  }

  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function setU32le(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }

  function concat(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total), p = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out;
  }

  /** Tidy a metadata string for display. */
  function tidy(s, max) {
    s = String(s == null ? '' : s)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\x00-\x1F\x7F]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    max = max || 160;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' bytes';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ---------------------------------------------------------------------------
  // Format detection
  // ---------------------------------------------------------------------------

  function detectFormat(b) {
    if (b.length < 12) return 'unknown';
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (matchAt(b, 0, '\x89PNG\r\n\x1a\n')) return 'png';
    if (matchAt(b, 0, 'RIFF') && matchAt(b, 8, 'WEBP')) return 'webp';
    if (matchAt(b, 0, 'GIF8')) return 'gif';
    if (matchAt(b, 0, 'II*\0') || matchAt(b, 0, 'MM\0*')) return 'tiff';
    if (matchAt(b, 4, 'ftyp')) {
      var brand = latin1(b, 8, 12);
      if (/^(avif|avis)$/.test(brand)) return 'avif';
      return 'heic';
    }
    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  //
  // An item is { severity, label, value, gps? }.
  //   danger — reveals where the photo was taken
  //   warn   — identifies you, your device, or links photos together
  //   info   — harmless technical data (e.g. colour profile)

  function newReport(format) {
    return { format: format, items: [], gps: null, limited: false };
  }

  function add(r, severity, label, value, extra) {
    value = tidy(value);
    if (!value) return;
    for (var i = 0; i < r.items.length; i++) {
      var it = r.items[i];
      if (it.label === label && (it.value === value || (extra && extra.onlyIfNew))) return;
    }
    var item = { severity: severity, label: label, value: value };
    if (extra && extra.gps) item.gps = extra.gps;
    r.items.push(item);
  }

  function setGps(r, gps) {
    if (!r.gps) r.gps = gps;
  }

  function formatCoords(g) {
    var lat = Math.abs(g.lat).toFixed(5) + '° ' + (g.lat < 0 ? 'S' : 'N');
    var lon = Math.abs(g.lon).toFixed(5) + '° ' + (g.lon < 0 ? 'W' : 'E');
    var s = lat + ', ' + lon;
    if (g.alt != null) s += ' · ' + Math.round(g.alt) + ' m altitude';
    return s;
  }

  function formatExifDate(s) {
    return String(s).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  }

  // ---------------------------------------------------------------------------
  // TIFF / EXIF
  // ---------------------------------------------------------------------------

  var TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

  /**
   * Parse a TIFF structure (the body of an EXIF block).
   * Returns { ifd0, exif, gps, ifd1 } as Maps of tag -> entry, or null.
   */
  function parseTiff(b, start, end) {
    end = Math.min(end, b.length);
    var len = end - start;
    if (len < 8) return null;
    var le;
    if (b[start] === 0x49 && b[start + 1] === 0x49) le = true;
    else if (b[start] === 0x4D && b[start + 1] === 0x4D) le = false;
    else return null;

    function u16(o) { return le ? (b[start + o] | (b[start + o + 1] << 8)) : ((b[start + o] << 8) | b[start + o + 1]); }
    function u32(o) { return le ? u32le(b, start + o) : u32be(b, start + o); }
    function s32(o) { return u32(o) | 0; }

    if (u16(2) !== 42) return null;
    var seen = {};

    function readValue(type, count, off) {
      var out, i, o;
      switch (type) {
        case 2: { // ASCII (often actually UTF-8)
          var stop = Math.min(off + count, len);
          var nul = indexOfByte(b, 0, start + off, start + stop);
          return utf8(b, start + off, nul < 0 ? start + stop : nul);
        }
        case 1: case 7: // BYTE / UNDEFINED
          return { bytes: b.subarray(start + off, start + off + count) };
        case 3: case 8: case 4: case 9:
          if (count > 64) return null;
          out = [];
          for (i = 0; i < count; i++) {
            o = off + i * TYPE_SIZE[type];
            out.push(type === 3 ? u16(o) : type === 8 ? (u16(o) << 16 >> 16) : type === 4 ? u32(o) : s32(o));
          }
          return out;
        case 5: case 10:
          if (count > 64) return null;
          out = [];
          for (i = 0; i < count; i++) {
            o = off + i * 8;
            var n = type === 5 ? u32(o) : s32(o);
            var d = type === 5 ? u32(o + 4) : s32(o + 4);
            out.push(d ? n / d : 0);
          }
          return out;
        default:
          return null;
      }
    }

    function readIfd(off) {
      var tags = new Map();
      if (!off || off < 8 || off + 2 > len || seen[off]) return { tags: tags, next: 0 };
      seen[off] = true;
      var n = u16(off);
      if (n > 1000) return { tags: tags, next: 0 };
      for (var i = 0; i < n; i++) {
        var e = off + 2 + i * 12;
        if (e + 12 > len) break;
        var tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        var size = TYPE_SIZE[type];
        if (!size) continue;
        var total = size * count;
        if (total > len) continue;
        var voff = total <= 4 ? e + 8 : u32(e + 8);
        if (voff + total > len) continue;
        tags.set(tag, { type: type, count: count, size: total, value: readValue(type, count, voff) });
      }
      var p = off + 2 + n * 12;
      return { tags: tags, next: p + 4 <= len ? u32(p) : 0 };
    }

    function pointer(tags, tag) {
      var v = tags.get(tag);
      return v && Array.isArray(v.value) ? v.value[0] : 0;
    }

    var ifd0 = readIfd(u32(4));
    return {
      ifd0: ifd0.tags,
      exif: readIfd(pointer(ifd0.tags, 0x8769)).tags,
      gps: readIfd(pointer(ifd0.tags, 0x8825)).tags,
      ifd1: readIfd(ifd0.next).tags
    };
  }

  function tagString(tags, tag) {
    var v = tags.get(tag);
    return v && typeof v.value === 'string' ? tidy(v.value) : '';
  }

  function tagNumber(tags, tag) {
    var v = tags.get(tag);
    if (!v) return null;
    if (Array.isArray(v.value)) return v.value[0];
    if (v.value && v.value.bytes && v.value.bytes.length) return v.value.bytes[0];
    return null;
  }

  function gpsFromTags(gps) {
    function coord(tag, refTag) {
      var v = gps.get(tag);
      if (!v || !Array.isArray(v.value) || !v.value.length) return null;
      var x = (v.value[0] || 0) + (v.value[1] || 0) / 60 + (v.value[2] || 0) / 3600;
      var ref = tagString(gps, refTag).toUpperCase();
      if (ref === 'S' || ref === 'W') x = -Math.abs(x);
      return isFinite(x) ? x : null;
    }
    var lat = coord(2, 1), lon = coord(4, 3);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    var alt = tagNumber(gps, 6);
    if (alt != null && tagNumber(gps, 5) === 1) alt = -alt;
    return { lat: lat, lon: lon, alt: alt != null && isFinite(alt) ? alt : null };
  }

  /** UserComment: 8-byte charset id followed by the text. */
  function decodeUserComment(entry) {
    if (!entry || !entry.value || !entry.value.bytes) return '';
    var bytes = entry.value.bytes;
    if (bytes.length <= 8) return '';
    return latin1(bytes, 8, bytes.length).replace(/\0/g, '');
  }

  /** Windows XP* tags: UCS-2 little-endian stored as BYTE. */
  function decodeXp(entry) {
    if (!entry || !entry.value || !entry.value.bytes) return '';
    var bytes = entry.value.bytes, s = '';
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      var c = bytes[i] | (bytes[i + 1] << 8);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  var POINTER_TAGS = { 0x8769: 1, 0x8825: 1, 0xA005: 1 };

  function reportTiff(r, t) {
    if (!t) return;
    var ifd0 = t.ifd0, exif = t.exif, gps = t.gps, ifd1 = t.ifd1;
    var used = {};
    function s(tags, tag) { used[tag] = true; return tagString(tags, tag); }

    // Where
    var loc = gpsFromTags(gps);
    if (loc) {
      setGps(r, loc);
      add(r, 'danger', 'GPS location', formatCoords(loc), { gps: loc });
    } else if (gps.size > 1) {
      add(r, 'warn', 'GPS data', gps.size + ' GPS tags');
    }

    // When
    var when = s(exif, 0x9003) || s(exif, 0x9004) || s(ifd0, 0x0132);
    var tz = s(exif, 0x9011) || s(exif, 0x9010);
    if (when) add(r, 'warn', 'Date & time taken', formatExifDate(when) + (tz ? ' (UTC' + tz + ')' : ''));
    s(ifd0, 0x0132); s(exif, 0x9004); s(exif, 0x9010); s(exif, 0x9012);

    // Who / which device
    var make = s(ifd0, 0x010F), model = s(ifd0, 0x0110);
    if (make || model) {
      var device = model && make && model.toLowerCase().indexOf(make.toLowerCase()) === 0
        ? model : [make, model].filter(Boolean).join(' ');
      add(r, 'warn', 'Camera / phone', device);
    }
    add(r, 'warn', 'Device name', s(ifd0, 0x013C));
    var lensMake = s(exif, 0xA433), lensModel = s(exif, 0xA434);
    add(r, 'warn', 'Lens', lensModel && lensMake && lensModel.indexOf(lensMake) === 0
      ? lensModel : [lensMake, lensModel].filter(Boolean).join(' '));
    add(r, 'warn', 'Camera serial number', s(exif, 0xA431) || s(ifd0, 0xC62F));
    add(r, 'warn', 'Lens serial number', s(exif, 0xA435));
    add(r, 'warn', 'Owner name', s(exif, 0xA430));
    add(r, 'warn', 'Author', s(ifd0, 0x013B));
    add(r, 'warn', 'Copyright', s(ifd0, 0x8298));
    add(r, 'warn', 'Description', s(ifd0, 0x010E));
    add(r, 'warn', 'Software', s(ifd0, 0x0131));
    add(r, 'warn', 'Unique photo ID', s(exif, 0xA420));
    used[0x9286] = true;
    add(r, 'warn', 'Comment', decodeUserComment(exif.get(0x9286)));

    var xp = [[0x9C9B, 'Title'], [0x9C9C, 'Comment'], [0x9C9D, 'Author'], [0x9C9E, 'Keywords'], [0x9C9F, 'Subject']];
    for (var i = 0; i < xp.length; i++) add(r, 'warn', xp[i][1], decodeXp(ifd0.get(xp[i][0])));

    if (exif.has(0x927C)) {
      used[0x927C] = true;
      add(r, 'warn', 'Camera maker data', formatBytes(exif.get(0x927C).size) +
        ' of manufacturer-specific data (can include serial numbers)');
    }

    var thumbLen = tagNumber(ifd1, 0x0202);
    if (ifd1.has(0x0201) && thumbLen) {
      add(r, 'warn', 'Embedded thumbnail', formatBytes(thumbLen) +
        ' preview image — can show the photo as it was before you cropped or edited it');
    }

    // Everything else: exposure, ISO, focal length…
    var technical = 0;
    exif.forEach(function (_, tag) { if (!used[tag] && !POINTER_TAGS[tag]) technical++; });
    if (technical) add(r, 'info', 'Camera settings', technical + ' technical tags (exposure, ISO, focal length…)');
  }

  // ---------------------------------------------------------------------------
  // XMP
  // ---------------------------------------------------------------------------

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (_, e) {
      var k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      var code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (err) { return ''; }
    });
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function xmpValue(xml, name) {
    var n = escapeRe(name);
    var m = new RegExp('(?:^|\\s)' + n + '\\s*=\\s*"([^"]*)"').exec(xml) ||
            new RegExp('(?:^|\\s)' + n + "\\s*=\\s*'([^']*)'").exec(xml);
    if (m) return tidy(decodeEntities(m[1]));
    m = new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>').exec(xml);
    if (!m) return '';
    var inner = m[1];
    var li = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/.exec(inner);
    if (li) inner = li[1];
    return tidy(decodeEntities(inner.replace(/<[^>]+>/g, '')));
  }

  /** XMP GPS values look like "48,51.4855N" or "48,51,29.13N". */
  function parseXmpCoord(s) {
    var m = /^\s*(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])?\s*$/i.exec(s || '');
    if (!m) return null;
    var v = Math.abs(+m[1]) + (m[2] ? +m[2] / 60 : 0) + (m[3] ? +m[3] / 3600 : 0);
    if ((m[4] && /[SW]/i.test(m[4])) || +m[1] < 0) v = -v;
    return isFinite(v) ? v : null;
  }

  var XMP_FIELDS = [
    ['photoshop:City', 'danger', 'City'],
    ['photoshop:State', 'danger', 'State / region'],
    ['photoshop:Country', 'danger', 'Country'],
    ['Iptc4xmpCore:Location', 'danger', 'Location'],
    ['exif:DateTimeOriginal', 'warn', 'Date & time taken'],
    ['photoshop:DateCreated', 'warn', 'Date & time taken'],
    ['xmp:CreateDate', 'warn', 'Date & time taken'],
    ['tiff:Model', 'warn', 'Camera / phone'],
    ['aux:SerialNumber', 'warn', 'Camera serial number'],
    ['exifEX:BodySerialNumber', 'warn', 'Camera serial number'],
    ['aux:LensSerialNumber', 'warn', 'Lens serial number'],
    ['dc:creator', 'warn', 'Author'],
    ['photoshop:AuthorsPosition', 'warn', 'Author'],
    ['dc:rights', 'warn', 'Copyright'],
    ['dc:title', 'warn', 'Title'],
    ['dc:description', 'warn', 'Description'],
    ['xmp:CreatorTool', 'warn', 'Software'],
    ['xmpMM:OriginalDocumentID', 'warn', 'Unique photo ID'],
    ['xmpMM:DocumentID', 'warn', 'Unique photo ID']
  ];

  function reportXmp(r, xml, size) {
    add(r, 'warn', 'XMP metadata', formatBytes(size) + ' block');
    if (!r.gps) {
      var lat = parseXmpCoord(xmpValue(xml, 'exif:GPSLatitude'));
      var lon = parseXmpCoord(xmpValue(xml, 'exif:GPSLongitude'));
      if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        var g = { lat: lat, lon: lon, alt: null };
        setGps(r, g);
        add(r, 'danger', 'GPS location', formatCoords(g), { gps: g });
      }
    }
    for (var i = 0; i < XMP_FIELDS.length; i++) {
      var f = XMP_FIELDS[i];
      add(r, f[1], f[2], f[2] === 'Date & time taken' ? formatExifDate(xmpValue(xml, f[0])) : xmpValue(xml, f[0]),
        { onlyIfNew: true });
    }
    if (/xmpMM:History/.test(xml)) add(r, 'warn', 'Edit history', 'list of edits and the apps that made them');
    if (/GImage:Data|GDepth:Data/.test(xml)) {
      add(r, 'warn', 'Hidden extra image', 'an extra picture stored inside the metadata (e.g. the original before portrait blur)');
    }
    if (/MotionPhoto|MicroVideo/.test(xml)) add(r, 'warn', 'Motion photo', 'the file carries a short video clip');
  }

  // ---------------------------------------------------------------------------
  // IPTC (inside Photoshop APP13 blocks)
  // ---------------------------------------------------------------------------

  var IPTC_FIELDS = {
    5: ['warn', 'Title'], 25: ['warn', 'Keywords'], 55: ['warn', 'Date created'], 80: ['warn', 'Author'],
    90: ['danger', 'City'], 92: ['danger', 'Sub-location'], 95: ['danger', 'State / region'],
    101: ['danger', 'Country'], 116: ['warn', 'Copyright'], 120: ['warn', 'Caption']
  };

  function reportIptc(r, b, start, end) {
    var i = start;
    while (i + 5 <= end && b[i] === 0x1C) {
      var rec = b[i + 1], ds = b[i + 2], len = u16be(b, i + 3), p = i + 5;
      if (len & 0x8000) break; // extended length: rare, stop here
      if (rec === 2 && IPTC_FIELDS[ds]) add(r, IPTC_FIELDS[ds][0], IPTC_FIELDS[ds][1], utf8(b, p, Math.min(p + len, end)));
      i = p + len;
    }
  }

  function reportPhotoshop(r, b, start, end) {
    add(r, 'warn', 'IPTC / Photoshop data', formatBytes(end - start) + ' block');
    var i = start;
    while (i + 12 <= end && matchAt(b, i, '8BIM')) {
      var id = u16be(b, i + 4);
      var p = i + 6, nameLen = b[p];
      p += 1 + nameLen;
      if ((1 + nameLen) % 2) p++;
      if (p + 4 > end) break;
      var size = u32be(b, p);
      p += 4;
      if (id === 0x0404) reportIptc(r, b, p, Math.min(p + size, end));
      i = p + size + (size % 2);
    }
  }

  // ---------------------------------------------------------------------------
  // Data hidden after the end of the image
  // ---------------------------------------------------------------------------

  function checkTrailing(r, b, from) {
    if (from >= b.length) return;
    var i;
    for (i = from; i < b.length && b[i] === 0; i++);
    if (i >= b.length) return; // just zero padding
    var kind;
    if (indexOf(b, 'ftyp', from) >= 0) kind = 'a video clip (motion / live photo)';
    else if (b[from] === 0xFF && b[from + 1] === 0xD8) kind = 'extra images (e.g. a depth map or preview)';
    else kind = 'unknown extra data';
    add(r, 'warn', 'Hidden data after the image', formatBytes(b.length - from) + ' — ' + kind);
  }

  // ---------------------------------------------------------------------------
  // JPEG
  // ---------------------------------------------------------------------------

  /** Skip entropy-coded scan data; returns the index of the next marker's 0xFF. */
  function skipScan(b, i) {
    while (i + 1 < b.length) {
      if (b[i] === 0xFF) {
        var n = b[i + 1];
        if (n === 0x00 || (n >= 0xD0 && n <= 0xD7)) { i += 2; continue; }
        if (n === 0xFF) { i++; continue; }
        return i;
      }
      i++;
    }
    return b.length;
  }

  function scanJpeg(b, r) {
    var i = 2, iccBytes = 0;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) break;
      var marker = b[i + 1];
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0xD9) { checkTrailing(r, b, i + 2); break; }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      var len = u16be(b, i + 2);
      var s = i + 4, e = i + 2 + len;
      if (len < 2 || e > b.length) break;

      if (marker === 0xE0) {
        if (matchAt(b, s, 'JFIF\0') && e - s >= 14 && (b[s + 12] || b[s + 13])) {
          add(r, 'warn', 'Embedded thumbnail', b[s + 12] + '×' + b[s + 13] + ' preview in the JFIF header');
        } else if (matchAt(b, s, 'JFXX\0')) {
          add(r, 'warn', 'Embedded thumbnail', formatBytes(e - s) + ' preview (JFXX)');
        }
      } else if (marker === 0xE1) {
        if (matchAt(b, s, 'Exif\0')) reportTiff(r, parseTiff(b, s + 6, e));
        else if (matchAt(b, s, 'http://ns.adobe.com/xap/1.0/\0')) reportXmp(r, utf8(b, s + 29, e), e - s);
        else if (matchAt(b, s, 'http://ns.adobe.com/xmp/extension/\0')) add(r, 'warn', 'Extended XMP', formatBytes(e - s) + ' block');
        else add(r, 'warn', 'Other embedded data', formatBytes(e - s) + ' block (APP1)');
      } else if (marker === 0xE2) {
        if (matchAt(b, s, 'ICC_PROFILE\0')) iccBytes += e - s;
        else if (matchAt(b, s, 'MPF\0')) add(r, 'warn', 'Multi-picture data', 'index of extra images stored in this file');
        else add(r, 'warn', 'Other embedded data', formatBytes(e - s) + ' block (APP2)');
      } else if (marker === 0xED) {
        if (matchAt(b, s, 'Photoshop 3.0\0')) reportPhotoshop(r, b, s + 14, e);
        else add(r, 'warn', 'Other embedded data', formatBytes(e - s) + ' block (APP13)');
      } else if (marker === 0xEE) {
        // APP14 "Adobe": colour-transform flag, harmless
      } else if (marker > 0xE2 && marker <= 0xEF) {
        var name = latin1(b, s, Math.min(e, s + 16)).split('\0')[0].replace(/[^\x20-\x7E]/g, '');
        if (name === 'Ducky') add(r, 'info', 'Export settings', 'Photoshop "Save for Web" block');
        else add(r, 'warn', 'Other embedded data', formatBytes(e - s) + ' block (APP' + (marker - 0xE0) + (name ? ' “' + name + '”' : '') + ')');
      } else if (marker === 0xFE) {
        add(r, 'warn', 'Comment', utf8(b, s, e));
      }

      i = e;
      if (marker === 0xDA) i = skipScan(b, i);
    }
    if (iccBytes) add(r, 'info', 'Colour profile', 'ICC profile, ' + formatBytes(iccBytes));
  }

  function sanitizeJpeg(b) {
    var parts = [b.subarray(0, 2)];
    var i = 2;
    while (i + 2 <= b.length) {
      if (b[i] !== 0xFF) throw new Error('Malformed JPEG');
      var marker = b[i + 1];
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0xD9) { parts.push(b.subarray(i, i + 2)); return concat(parts); } // drops trailing data
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
      if (i + 4 > b.length) break;
      var len = u16be(b, i + 2);
      var s = i + 4, e = i + 2 + len;
      if (len < 2 || e > b.length) throw new Error('Malformed JPEG');

      if (marker === 0xE0) {
        if (matchAt(b, s, 'JFIF\0') && e - s >= 14) {
          // Keep the 14-byte JFIF header but zero any thumbnail.
          var app0 = new Uint8Array(18);
          app0.set([0xFF, 0xE0, 0x00, 0x10]);
          app0.set(b.subarray(s, s + 12), 4);
          parts.push(app0);
        }
      } else if (marker === 0xE2) {
        if (matchAt(b, s, 'ICC_PROFILE\0')) parts.push(b.subarray(i, e));
      } else if (marker === 0xEE) {
        if (matchAt(b, s, 'Adobe')) parts.push(b.subarray(i, e));
      } else if ((marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE) {
        // drop: EXIF, XMP, IPTC, vendor blocks, comments
      } else {
        parts.push(b.subarray(i, e));
      }

      i = e;
      if (marker === 0xDA) {
        var scanEnd = skipScan(b, i);
        parts.push(b.subarray(i, scanEnd));
        i = scanEnd;
      }
    }
    parts.push(new Uint8Array([0xFF, 0xD9]));
    return concat(parts);
  }

  // ---------------------------------------------------------------------------
  // PNG
  // ---------------------------------------------------------------------------

  function hexToBytes(hex) {
    hex = hex.replace(/[^0-9a-f]/gi, '');
    var out = new Uint8Array(hex.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function pngText(r, key, val) {
    if (key === 'XML:com.adobe.xmp') { reportXmp(r, val, val.length); return; }
    var raw = /^Raw profile type (exif|APP1|xmp|iptc|8bim)$/i.exec(key);
    if (raw) {
      // ImageMagick stores whole metadata blocks as hex text.
      var kind = raw[1].toLowerCase();
      if (kind === 'exif' || kind === 'app1') {
        var lines = val.split('\n').filter(Boolean);
        var bytes = hexToBytes(lines.slice(2).join(''));
        var off = matchAt(bytes, 0, 'Exif\0\0') ? 6 : 0;
        var t = parseTiff(bytes, off, bytes.length);
        if (t) { reportTiff(r, t); return; }
      }
      add(r, 'warn', 'Embedded ' + raw[1].toUpperCase() + ' data', formatBytes(val.length) + ' block stored as text');
      return;
    }
    add(r, 'warn', key || 'Text', val || '(empty)');
  }

  function scanPng(b, r) {
    var i = 8;
    while (i + 12 <= b.length) {
      var len = u32be(b, i), type = latin1(b, i + 4, i + 8), d = i + 8, e = d + len;
      if (e + 4 > b.length) break;
      var z;
      if (type === 'tEXt') {
        z = indexOfByte(b, 0, d, e);
        pngText(r, latin1(b, d, z < 0 ? e : z), z < 0 ? '' : latin1(b, z + 1, e));
      } else if (type === 'zTXt') {
        z = indexOfByte(b, 0, d, e);
        add(r, 'warn', 'Compressed text', '“' + latin1(b, d, z < 0 ? e : z) + '”');
      } else if (type === 'iTXt') {
        z = indexOfByte(b, 0, d, e);
        if (z > 0) {
          var key = latin1(b, d, z), compressed = b[z + 1];
          var lang = indexOfByte(b, 0, z + 3, e), tkey = lang < 0 ? -1 : indexOfByte(b, 0, lang + 1, e);
          if (compressed || tkey < 0) add(r, 'warn', 'Compressed text', '“' + key + '”');
          else pngText(r, key, utf8(b, tkey + 1, e));
        }
      } else if (type === 'eXIf') {
        var off = matchAt(b, d, 'Exif\0\0') ? d + 6 : d;
        reportTiff(r, parseTiff(b, off, e));
      } else if (type === 'tIME' && len === 7) {
        var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
        add(r, 'warn', 'Last modified', u16be(b, d) + '-' + p2(b[d + 2]) + '-' + p2(b[d + 3]) + ' ' +
          p2(b[d + 4]) + ':' + p2(b[d + 5]) + ':' + p2(b[d + 6]) + ' UTC');
      } else if (type === 'iCCP') {
        add(r, 'info', 'Colour profile', 'ICC profile');
      } else if (type === 'IEND') {
        checkTrailing(r, b, e + 4);
        return;
      }
      i = e + 4;
    }
  }

  var DROP_PNG = { tEXt: 1, zTXt: 1, iTXt: 1, eXIf: 1, tIME: 1 };

  function sanitizePng(b) {
    var parts = [b.subarray(0, 8)];
    var i = 8;
    while (i + 12 <= b.length) {
      var len = u32be(b, i), type = latin1(b, i + 4, i + 8), e = i + 12 + len;
      if (e > b.length) throw new Error('Malformed PNG');
      if (!DROP_PNG[type]) parts.push(b.subarray(i, e));
      if (type === 'IEND') return concat(parts);
      i = e;
    }
    throw new Error('Malformed PNG');
  }

  // ---------------------------------------------------------------------------
  // WebP
  // ---------------------------------------------------------------------------

  function scanWebp(b, r) {
    var riffEnd = Math.min(b.length, 8 + u32le(b, 4));
    var i = 12;
    while (i + 8 <= riffEnd) {
      var id = latin1(b, i, i + 4), size = u32le(b, i + 4), d = i + 8, e = d + size;
      if (e > b.length) break;
      if (id === 'EXIF') reportTiff(r, parseTiff(b, matchAt(b, d, 'Exif\0\0') ? d + 6 : d, e));
      else if (id === 'XMP ') reportXmp(r, utf8(b, d, e), size);
      else if (id === 'ICCP') add(r, 'info', 'Colour profile', 'ICC profile');
      i = e + (size & 1);
    }
    checkTrailing(r, b, 8 + u32le(b, 4));
  }

  function sanitizeWebp(b) {
    var riffEnd = Math.min(b.length, 8 + u32le(b, 4));
    var parts = [];
    var i = 12;
    while (i + 8 <= riffEnd) {
      var id = latin1(b, i, i + 4), size = u32le(b, i + 4), e = i + 8 + size + (size & 1);
      if (i + 8 + size > b.length) throw new Error('Malformed WebP');
      if (id !== 'EXIF' && id !== 'XMP ') {
        var chunk = b.subarray(i, Math.min(e, b.length));
        if (id === 'VP8X') {
          chunk = chunk.slice();
          chunk[8] &= ~(0x08 | 0x04); // clear "has EXIF" and "has XMP" flags
        }
        parts.push(chunk);
      }
      i = e;
    }
    var body = concat(parts);
    var out = new Uint8Array(12 + body.length);
    out.set(b.subarray(0, 12));
    setU32le(out, 4, 4 + body.length);
    out.set(body, 12);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Anything else (HEIC, AVIF, TIFF…): look for the usual blocks anywhere.
  // ---------------------------------------------------------------------------

  function scanGeneric(b, r) {
    r.limited = true;
    var found = false;
    for (var i = indexOf(b, 'Exif\0\0', 0); i >= 0 && !found; i = indexOf(b, 'Exif\0\0', i + 1)) {
      var t = parseTiff(b, i + 6, b.length);
      if (t) { reportTiff(r, t); found = true; }
    }
    if (!found) {
      var j = r.format === 'tiff' ? 0 : indexOf(b, 'MM\0*\0\0\0\x08', 0);
      if (j < 0) j = indexOf(b, 'II*\0\x08\0\0\0', 0);
      if (j >= 0) reportTiff(r, parseTiff(b, j, b.length));
    }
    var x = indexOf(b, '<x:xmpmeta', 0);
    if (x >= 0) {
      var xe = indexOf(b, '</x:xmpmeta>', x);
      var end = xe < 0 ? Math.min(b.length, x + 262144) : xe + 12;
      reportXmp(r, utf8(b, x, end), end - x);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Inspect a file and list what it reveals. Never throws. */
  function scan(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var r = newReport(detectFormat(b));
    try {
      if (r.format === 'jpeg') scanJpeg(b, r);
      else if (r.format === 'png') scanPng(b, r);
      else if (r.format === 'webp') scanWebp(b, r);
      else if (r.format !== 'gif') scanGeneric(b, r);
    } catch (err) {
      r.limited = true; // malformed file: report what we found so far
    }
    return r;
  }

  /**
   * Remove metadata blocks from a JPEG, PNG or WebP container without touching
   * the image data. Other formats are returned unchanged.
   */
  function sanitize(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    switch (detectFormat(b)) {
      case 'jpeg': return sanitizeJpeg(b);
      case 'png': return sanitizePng(b);
      case 'webp': return sanitizeWebp(b);
      default: return b;
    }
  }

  return {
    scan: scan,
    sanitize: sanitize,
    detectFormat: detectFormat,
    formatBytes: formatBytes,
    formatCoords: formatCoords
  };
});
