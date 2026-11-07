/*!
 * Stripper — app.js
 *
 * How a photo is cleaned:
 *   1. Read the file and list what its metadata gives away (metadata.js).
 *   2. Decode it and redraw only the pixels onto a fresh canvas. EXIF rotation
 *      is applied first, so the photo keeps the right way up.
 *   3. Nudge one small random patch of pixels by 1/255 (invisible), so every
 *      copy gets a brand-new checksum, even if you clean the same photo twice.
 *   4. Encode a new file from those pixels. Nothing from the original file is
 *      copied: no EXIF, GPS, XMP, thumbnails, maker notes or hidden video.
 *   5. Strip any block the browser's encoder may have added, scan the result
 *      again to prove it's clean, and show the before/after SHA-256.
 *
 * Everything happens in this tab. The page's Content-Security-Policy blocks
 * all network requests, so your photos can't be sent anywhere.
 */
(function () {
  'use strict';

  var Meta = window.StripperMeta;
  var Zip = window.StripperZip;

  // ---------------------------------------------------------------------------
  // Small DOM helper — always uses textContent, never innerHTML, because
  // metadata strings come from the file and must not be treated as HTML.
  // ---------------------------------------------------------------------------

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid instanceof Node ? kid : String(kid));
  }

  function $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------------------
  // Elements & options
  // ---------------------------------------------------------------------------

  var els = {
    input: $('file-input'),
    dropzone: $('dropzone'),
    results: $('results'),
    bulk: $('bulk'),
    downloadAll: $('download-all'),
    clear: $('clear-all'),
    format: $('opt-format'),
    quality: $('opt-quality'),
    qualityOut: $('opt-quality-out'),
    size: $('opt-size'),
    rename: $('opt-rename'),
    notice: $('notice')
  };

  var STORE_KEY = 'stripper:options';

  function loadOptions() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!saved) return;
      if (saved.format) els.format.value = saved.format;
      if (saved.quality) els.quality.value = saved.quality;
      if (saved.size != null) els.size.value = saved.size;
      if (typeof saved.rename === 'boolean') els.rename.checked = saved.rename;
    } catch (e) { /* storage unavailable: use defaults */ }
  }

  function saveOptions() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        format: els.format.value, quality: els.quality.value, size: els.size.value, rename: els.rename.checked
      }));
    } catch (e) { /* ignore */ }
  }

  function options() {
    return {
      format: els.format.value,
      quality: Number(els.quality.value) / 100,
      maxSide: Number(els.size.value) || 0,
      rename: els.rename.checked
    };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
  }

  function sha256(bytes) {
    if (!window.crypto || !crypto.subtle) return Promise.resolve(null);
    return crypto.subtle.digest('SHA-256', bytes).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    }).catch(function () { return null; });
  }

  var EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  function outputType(choice, sourceFormat) {
    if (choice === 'jpeg') return 'image/jpeg';
    if (choice === 'png') return 'image/png';
    if (sourceFormat === 'png' || sourceFormat === 'gif') return 'image/png';
    if (sourceFormat === 'webp') return 'image/webp';
    return 'image/jpeg';
  }

  function baseName(name) {
    return (name || 'photo').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'photo';
  }

  function readBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
  }

  // ---------------------------------------------------------------------------
  // Re-encoding
  // ---------------------------------------------------------------------------

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        if (img.decode) img.decode().then(function () { resolve(img); }, function () { resolve(img); });
        else resolve(img);
      };
      img.onerror = function () { reject(new Error('decode')); };
      img.src = url;
    });
  }

  /**
   * Shift a random patch (up to 32×32 px) by exactly 1/255 in R, G and B.
   * Invisible to the eye, but big enough to survive JPEG compression, so the
   * new file's bytes — and checksum — are different on every run.
   */
  function nudge(ctx, w, h) {
    var size = Math.min(32, w, h);
    var r = new Uint32Array(3);
    crypto.getRandomValues(r);
    var x = r[0] % (w - size + 1), y = r[1] % (h - size + 1), up = (r[2] & 1) === 1;
    var data;
    try { data = ctx.getImageData(x, y, size, size); } catch (e) { return; }
    var p = data.data;
    for (var i = 0; i < p.length; i += 4) {
      for (var c = 0; c < 3; c++) {
        var v = p[i + c];
        p[i + c] = up ? (v === 255 ? 254 : v + 1) : (v === 0 ? 1 : v - 1);
      }
    }
    ctx.putImageData(data, x, y);
  }

  function render(img, w, h, type, quality) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d', { alpha: type !== 'image/jpeg' });
    if (!ctx) return Promise.resolve(null);
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    nudge(ctx, w, h);
    return new Promise(function (resolve) {
      try {
        canvas.toBlob(function (blob) {
          canvas.width = canvas.height = 0; // free memory quickly (matters on phones)
          resolve(blob && blob.size ? blob : null);
        }, type, quality);
      } catch (e) { resolve(null); }
    });
  }

  // Many phone browsers can't draw canvases above ~16.7 megapixels.
  var FALLBACK_PIXELS = [16777216, 8388608];

  function reencode(file, sourceFormat, opts) {
    var url = URL.createObjectURL(file);
    return loadImage(url).then(function (img) {
      var w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) throw new Error('decode');
      var scale = opts.maxSide && Math.max(w0, h0) > opts.maxSide ? opts.maxSide / Math.max(w0, h0) : 1;
      var type = outputType(opts.format, sourceFormat);
      var attempt = 0;

      function tryRender() {
        var w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
        return render(img, w, h, type, opts.quality).then(function (blob) {
          if (blob) return { blob: blob, width: w, height: h, resized: scale < 1, forced: attempt > 0 };
          if (attempt >= FALLBACK_PIXELS.length) throw new Error('too-large');
          scale = Math.min(scale, Math.sqrt(FALLBACK_PIXELS[attempt++] / (w0 * h0)) * 0.999);
          return tryRender();
        });
      }
      return tryRender();
    }).finally(function () { URL.revokeObjectURL(url); });
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  var jobs = [];
  var queue = Promise.resolve();
  var nextId = 1;

  function addFiles(list) {
    var files = Array.prototype.filter.call(list || [], function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|hei[cf]|avif|tiff?)$/i.test(f.name || '');
    });
    if (!files.length) {
      if (list && list.length) notify('That doesn’t look like a photo. Try a JPEG, PNG, WebP or HEIC file.');
      return;
    }
    notify('');
    files.forEach(function (file) {
      var job = { id: nextId++, file: file, gen: 0, out: null };
      job.ui = createCard(job);
      jobs.push(job);
      els.results.append(job.ui.card);
      enqueue(job);
    });
    updateBulk();
  }

  function enqueue(job) {
    var gen = ++job.gen;
    setWorking(job);
    queue = queue.then(function () { return processJob(job, gen); });
  }

  function processJob(job, gen) {
    if (jobs.indexOf(job) < 0 || gen !== job.gen) return;
    var opts = options();
    var original, report;

    return readBytes(job.file).then(function (bytes) {
      original = bytes;
      report = Meta.scan(bytes);
      if (gen === job.gen) renderFindings(job, report);
      return reencode(job.file, report.format, opts);
    }).then(function (res) {
      return readBytes(res.blob).then(function (encoded) {
        var type = res.blob.type || 'image/jpeg';
        var cleaned = Meta.sanitize(encoded);
        var check = Meta.scan(cleaned);
        return Promise.all([sha256(original), sha256(cleaned)]).then(function (hashes) {
          if (gen !== job.gen || jobs.indexOf(job) < 0) return;
          var ext = EXT[type] || 'jpg';
          var name = opts.rename ? 'photo-' + randomHex(4) + '.' + ext : baseName(job.file.name) + '-clean.' + ext;
          var outFile = new File([cleaned], name, { type: type });
          if (job.out) URL.revokeObjectURL(job.out.url);
          job.out = {
            file: outFile, name: name, bytes: cleaned, url: URL.createObjectURL(outFile),
            width: res.width, height: res.height, resized: res.resized, forced: res.forced,
            leftovers: check.items.filter(function (i) { return i.severity !== 'info'; }),
            hashBefore: hashes[0], hashAfter: hashes[1], sizeBefore: original.length
          };
          renderDone(job);
          updateBulk();
        });
      });
    }).catch(function (err) {
      if (gen !== job.gen) return;
      renderError(job, err, report);
      updateBulk();
    });
  }

  function removeJob(job) {
    var i = jobs.indexOf(job);
    if (i >= 0) jobs.splice(i, 1);
    job.gen++;
    if (job.out) URL.revokeObjectURL(job.out.url);
    job.ui.card.remove();
    updateBulk();
  }

  function clearAll() {
    jobs.slice().forEach(removeJob);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function createCard(job) {
    var thumb = h('img', { alt: '', hidden: true });
    var status = h('span', { class: 'badge' });
    var ui = {
      thumb: thumb,
      status: status,
      findings: h('div', { class: 'findings' }),
      after: h('div', { class: 'after', hidden: true }),
      actions: h('div', { class: 'actions', hidden: true })
    };
    ui.card = h('article', { class: 'card' },
      h('div', { class: 'thumb' }, thumb, h('span', { class: 'spinner', 'aria-hidden': 'true' })),
      h('div', { class: 'card-body' },
        h('div', { class: 'card-head' },
          h('h3', { class: 'name', text: job.file.name || 'Pasted image', title: job.file.name || '' }),
          status,
          h('button', {
            type: 'button', class: 'icon-btn', 'aria-label': 'Remove', title: 'Remove',
            onclick: function () { removeJob(job); }
          }, '×')),
        ui.findings, ui.after, ui.actions));
    return ui;
  }

  function setWorking(job) {
    var ui = job.ui;
    ui.card.className = 'card is-working';
    ui.status.className = 'badge';
    ui.status.textContent = 'Cleaning…';
    ui.after.hidden = true;
    ui.actions.hidden = true;
  }

  function mapLink(g) {
    var lat = g.lat.toFixed(5), lon = g.lon.toFixed(5);
    return h('a', {
      class: 'maplink', target: '_blank', rel: 'noopener noreferrer',
      href: 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon + '#map=17/' + lat + '/' + lon
    }, 'Show on map ↗');
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function renderFindings(job, report) {
    var risky = report.items.filter(function (i) { return i.severity !== 'info'; });
    var info = report.items.filter(function (i) { return i.severity === 'info'; });
    var located = report.items.some(function (i) { return i.severity === 'danger'; });
    // Most revealing first
    risky.sort(function (a, b) { return (a.severity === 'danger' ? 0 : 1) - (b.severity === 'danger' ? 0 : 1); });

    var summary;
    if (located) {
      summary = h('p', { class: 'summary is-danger' },
        h('strong', null, 'This photo reveals where it was taken.'),
        ' It carries ' + plural(risky.length, 'hidden detail') + ':');
    } else if (risky.length) {
      summary = h('p', { class: 'summary is-warn' },
        h('strong', null, 'No location, but ' + plural(risky.length, 'hidden detail') + ' found:'));
    } else {
      summary = h('p', { class: 'summary is-quiet' },
        'No hidden details found. You still get a fresh copy with a new fingerprint.');
    }

    var list = risky.length ? h('ul', { class: 'items' }, risky.map(function (it) {
      return h('li', { class: 'item sev-' + it.severity },
        h('span', { class: 'k', text: it.label }),
        h('span', { class: 'v' }, h('span', { text: it.value }), it.gps ? [' ', mapLink(it.gps)] : null));
    })) : null;

    var extra = [];
    if (info.length) {
      extra.push(h('p', { class: 'muted small' },
        'Also inside, harmless: ' + info.map(function (i) { return i.label.toLowerCase() + ' — ' + i.value; }).join('; ') + '.'));
    }
    if (report.limited) {
      extra.push(h('p', { class: 'muted small' },
        'This file type can only be partly inspected, but it doesn’t matter: the clean copy is rebuilt from pixels only.'));
    }

    job.ui.findings.replaceChildren.apply(job.ui.findings, [summary].concat(list ? [list] : [], extra));
  }

  function short(hash) { return hash ? hash.slice(0, 12) : 'n/a'; }

  function renderDone(job) {
    var ui = job.ui, out = job.out;
    var clean = !out.leftovers.length;
    ui.card.className = 'card is-done';
    ui.status.className = clean ? 'badge is-ok' : 'badge is-warn';
    ui.status.textContent = clean ? 'Clean' : 'Check';
    ui.thumb.src = out.url;
    ui.thumb.hidden = false;

    var verdict = clean
      ? h('p', { class: 'verdict is-ok' }, h('strong', null, 'All removed.'),
          ' We scanned the new file again: no hidden details left.')
      : h('p', { class: 'verdict is-warn' }, h('strong', null, 'Something survived: '),
          out.leftovers.map(function (i) { return i.label; }).join(', ') + '. Please report this.');

    var changed = out.hashBefore && out.hashAfter && out.hashBefore !== out.hashAfter;
    var size = Meta.formatBytes(out.sizeBefore) + ' → ' + Meta.formatBytes(out.bytes.length) +
      ' · ' + out.width + ' × ' + out.height + ' px' +
      (out.forced ? ' (scaled down: too large for this browser)' : out.resized ? ' (resized)' : '');

    ui.after.replaceChildren(verdict, h('dl', { class: 'facts' },
      h('dt', null, 'Fingerprint'),
      h('dd', null,
        h('code', { title: out.hashBefore || '', text: short(out.hashBefore) }), ' → ',
        h('code', { title: out.hashAfter || '', text: short(out.hashAfter) }),
        changed ? h('span', { class: 'tick', text: ' changed' }) : null),
      h('dt', null, 'File'), h('dd', { text: size }),
      h('dt', null, 'Saved as'), h('dd', null, h('code', { text: out.name }))));
    ui.after.hidden = false;

    var actions = [h('a', { class: 'btn primary download', href: out.url, download: out.name }, 'Download')];
    if (navigator.canShare && navigator.share) {
      var canShare = false;
      try { canShare = navigator.canShare({ files: [out.file] }); } catch (e) { /* not supported */ }
      if (canShare) {
        actions.push(h('button', {
          type: 'button', class: 'btn', onclick: function () {
            navigator.share({ files: [out.file] }).catch(function () { /* cancelled */ });
          }
        }, 'Save / Share…'));
      }
    }
    ui.actions.replaceChildren.apply(ui.actions, actions);
    ui.actions.hidden = false;
  }

  function renderError(job, err, report) {
    var ui = job.ui;
    ui.card.className = 'card is-error';
    ui.status.className = 'badge is-error';
    ui.status.textContent = 'Couldn’t open';
    var fmt = report && report.format;
    var msg;
    if (err && err.message === 'too-large') {
      msg = 'This photo is too large for this browser. Pick a smaller “Max size” in Options and it will retry.';
    } else if (fmt === 'heic' || fmt === 'avif') {
      msg = 'This browser can’t open ' + fmt.toUpperCase() + ' photos. Open this page in Safari, or export the photo as JPEG first ' +
        '(iPhone: Settings › Camera › Formats › Most Compatible).';
    } else {
      msg = 'This file couldn’t be read as an image. It may be damaged or in a format your browser doesn’t support.';
    }
    ui.after.replaceChildren(h('p', { class: 'verdict is-error', text: msg }));
    ui.after.hidden = false;
    ui.actions.hidden = true;
  }

  function updateBulk() {
    var done = jobs.filter(function (j) { return j.out && j.ui.card.classList.contains('is-done'); });
    els.bulk.hidden = jobs.length === 0;
    els.downloadAll.hidden = done.length < 2;
    els.downloadAll.textContent = 'Download all ' + done.length + ' (.zip)';
  }

  function notify(text) {
    els.notice.textContent = text;
    els.notice.hidden = !text;
  }

  function downloadAll() {
    var used = {};
    var files = jobs.filter(function (j) { return j.out; }).map(function (j) {
      var name = j.out.name, n = 1;
      while (used[name]) name = j.out.name.replace(/(\.[^.]+)$/, '-' + (++n) + '$1');
      used[name] = true;
      return { name: name, data: j.out.bytes };
    });
    if (!files.length) return;
    var blob = new Blob(Zip.createZip(files), { type: 'application/zip' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: 'clean-photos.zip', hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  loadOptions();
  els.qualityOut.textContent = els.quality.value;

  els.dropzone.addEventListener('click', function () { els.input.click(); });
  els.input.addEventListener('change', function () {
    addFiles(els.input.files);
    els.input.value = '';
  });

  var reprocessTimer = 0;
  function optionsChanged() {
    els.qualityOut.textContent = els.quality.value;
    saveOptions();
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(function () { jobs.forEach(enqueue); }, 350);
  }
  [els.format, els.quality, els.size, els.rename].forEach(function (el) {
    el.addEventListener(el.type === 'range' ? 'input' : 'change', optionsChanged);
  });

  els.downloadAll.addEventListener('click', downloadAll);
  els.clear.addEventListener('click', clearAll);

  // Drag & drop anywhere on the page
  var dragDepth = 0;
  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
  }
  document.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    dragDepth++;
    els.dropzone.classList.add('is-over');
  });
  document.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; els.dropzone.classList.remove('is-over'); }
  });
  document.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  });

  // Paste an image (Ctrl/Cmd+V)
  document.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addFiles(files); }
  });
})();
