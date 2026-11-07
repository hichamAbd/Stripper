# Stripper

**Share the photo, not your location.**

Stripper is a small web app that removes every piece of hidden data from your photos before you post them online: GPS coordinates, date and time, phone model, serial numbers, editing history, embedded thumbnails, motion-photo video, all of it. It also gives every cleaned copy a brand-new checksum, so the file you post can't be matched byte-for-byte to your original.

It runs **entirely in your browser**. Your photos are never uploaded anywhere: the page's Content-Security-Policy (`connect-src 'none'`) blocks all network requests, it loads no third-party code, fonts or analytics, and it keeps working in airplane mode.

## Using it

1. Open the site (see [Deploying](#deploying) below), or open `index.html` directly from a downloaded copy.
2. Drop in your photos, pick them, or paste one.
3. Stripper lists what each photo gives away. If there's GPS, it shows the coordinates and a "Show on map" link, so you can see what a stranger would see.
4. Click **Download**, or **Save / Share…** on a phone to save straight to your photo library. With several photos, **Download all** gives you a zip.

**Options:** output format (same as original, JPEG or PNG), JPEG/WebP quality, max size (for example 1280 px, plenty for a review site), and random file names. Random names are on by default because names like `IMG_20261107_183012.jpg` reveal when a photo was taken.

## How it works

| Step | What happens |
| --- | --- |
| **Inspect** | `js/metadata.js` reads EXIF (including GPS and maker notes), XMP, IPTC, JPEG comments, PNG text chunks, WebP metadata chunks, embedded thumbnails and data hidden after the end of the image. HEIC/AVIF files are searched for EXIF and XMP blocks. |
| **Rebuild** | The photo is decoded and only its pixels are drawn onto a fresh canvas, with EXIF rotation applied first so it stays the right way up. A new file is encoded from those pixels, so nothing from the original file is carried over. |
| **New fingerprint** | Before encoding, a random patch of up to 32×32 pixels is shifted by exactly 1/255 in brightness. You can't see it, but it changes the bytes every time, even if you clean the same photo twice. An exact checksum (SHA-256, MD5…) of the posted photo will match neither your original nor any other copy you made. |
| **Verify** | Any block the browser's own encoder may add is removed (`sanitize()`), then the result is scanned again. The card shows "All removed" only if nothing identifying is left, plus the before/after SHA-256. |

Why re-encode instead of just deleting tags? Deleting tags only removes the blocks a tool knows about. Re-encoding from pixels removes everything, including vendor-specific blobs, embedded thumbnails (which can show a photo *before* it was cropped) and the video clip that motion/live photos tack onto the end of the file. The cost is a tiny quality loss at the default JPEG quality of 92, which you can raise to 100 in Options.

The only thing left in a cleaned JPEG/WebP is a standard sRGB colour profile written by the browser, which is the same for everyone using that browser.

## What it can't do

- **The picture itself can still identify a place.** Street signs, the view from a window, reflections or landmarks. Crop before you post.
- **Reverse image search still works.** A new checksum defeats exact-file matching, but Google Lens, TinEye and similar compare what the image *looks like*. If the same photo is posted somewhere under your name, it can still be found.
- **Camera sensor fingerprinting** (PRNU) is a forensic technique that can, with effort, link photos to the camera that took them. Re-encoding and downscaling weaken it but don't guarantee to defeat it. That's outside what a metadata tool can promise.
- **HEIC photos** can only be opened in browsers that decode HEIC (Safari). On iPhone, the photo picker usually converts to JPEG for you anyway.
- Animated GIFs come out as a still PNG of the first frame.

## Deploying

It's a static site with no build step: `index.html`, `css/`, `js/`, `favicon.svg`.

**GitHub Pages:** in the repository, go to *Settings → Pages → Build and deployment*, choose *Deploy from a branch*, select the branch and `/ (root)`, and save. The site appears at `https://<user>.github.io/Stripper/` after a minute.

Any other static host works too (Netlify, Cloudflare Pages, your own server). You can also open `index.html` straight from disk.

## Development

No dependencies are needed for the app or the unit tests.

```sh
npm test            # unit tests (Node 20+)
npm run test:e2e    # real-browser test; needs Playwright:
                    #   npm i --no-save playwright && npx playwright install chromium
python3 tests/fixtures/make_fixtures.py   # regenerate test images (needs Pillow)
```

The end-to-end test serves the site locally, uploads the fixtures, downloads every cleaned file and checks it: no metadata left, new checksum, correct orientation, two runs on the same photo give different checksums, and no network requests leave the page.

The test images contain only fake data. Their GPS position is the Eiffel Tower.

```
index.html          page and Content-Security-Policy
css/styles.css      styles (light and dark)
js/metadata.js      metadata scanner and container sanitizer (pure functions)
js/zip.js           tiny zip writer for "Download all"
js/app.js           UI and the re-encoding pipeline
tests/              unit tests, browser test, fixtures
```
