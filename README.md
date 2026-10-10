<!--
  - SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
# PdfCraft for Nextcloud

Edit the PDFs in your Nextcloud with [PdfCraft](https://github.com/storytold/printcraft) (formerly PrintCraft), the open-source, Rust-native PDF workbench, without leaving the browser.

- **Edit in PdfCraft** appears in the Files action menu of every PDF you can read.
- **Save** (Ctrl/⌘+S) writes the PDF back to Nextcloud, which keeps the previous state as a file version.
- **Save As** asks for a name and folder and stores a copy.
- Read-only files (for example a share without edit rights) open normally; saving offers a copy.
- If someone else changes the file while you have it open, saving asks whether to replace their version or save a copy instead of overwriting it silently.
- Optionally, clicking a PDF in Files opens it in PdfCraft instead of the viewer: tick **Open PDFs here from Files** in the editor's top bar.

PdfCraft runs entirely in your browser as WebAssembly. Documents go only between your browser and your Nextcloud, and the server needs no extra software or services.

## Requirements

- Nextcloud 33, 34 or 35
- A browser with WebGL2 (any current Chrome, Edge, Firefox or Safari)
- The web server must serve `.wasm` files as `application/wasm`. Nextcloud's own `.htaccess` does this on Apache; the [recommended nginx configuration](https://docs.nextcloud.com/server/latest/admin_manual/installation/nginx.html) does too (`application/wasm wasm;` in its `types` block and `wasm` in the static-file `location`).
- Recommended: gzip or Brotli for `application/wasm` (Debian/Ubuntu Apache's `mod_deflate` does it out of the box; on nginx add it to `gzip_types`). PdfCraft is a 33 MB download uncompressed and about 13 MB compressed, fetched once and then cached.

## Install

1. Download `pdfcraft-<version>.tar.gz` and extract it into your Nextcloud's `apps/` (or `custom_apps/`) folder, so you have `apps/pdfcraft/appinfo/info.xml`.
2. Make it readable by the web server user, e.g. `chown -R www-data:www-data apps/pdfcraft`.
3. Enable it: `sudo -u www-data php occ app:enable pdfcraft` (or in **Apps ▸ Your apps**).

To make PdfCraft the click-to-open default for every user who hasn't chosen otherwise:

```sh
sudo -u www-data php occ config:app:set pdfcraft open_by_default --value=true --type=boolean
```

## How it works

```
Files ── "Edit in PdfCraft" ──▶ /apps/pdfcraft/edit/{fileId}   (Nextcloud page, src/editor.ts)
                                  │  WebDAV GET/PUT with the user's session
                                  ▼
                                <iframe> /apps/pdfcraft/frame?host=parent   (templates/frame.php)
                                  │  PdfCraft (web/*.wasm) — postMessage bridge
```

The editor page downloads the PDF over WebDAV and passes it to PdfCraft with `postMessage`. When you save, PdfCraft passes the bytes back and the page uploads them with `If-Match`, so a newer version on the server is never overwritten without asking. The frame page is the only one whose Content Security Policy allows compiling WebAssembly.

PdfCraft's browser build saves by downloading a file. `patches/pdfcraft-nextcloud.patch` makes two small, generic additions, both meant to be proposed upstream:

- an opt-in embedding bridge (`?host=parent`) so a same-origin parent page can open files in PdfCraft and receive its saves. The protocol is described in [web/README.md](web/README.md);
- an `unbranded` build feature that leaves out the ArtCraft logos. PdfCraft's code is MIT/Apache, but its brand terms (`docs/brand/LICENSE-brand.txt` upstream) don't allow modified builds to carry the ArtCraft marks, so the bundled build uses it. If the bridge lands upstream, an official build can be used as is.

## Build from source

```sh
make js      # npm ci && vite build → js/
make wasm    # clone PdfCraft, apply the patch, build → web/   (needs Rust, see below)
make dist    # → build/dist/pdfcraft-<version>.tar.gz
```

`make wasm` runs `scripts/build-pdfcraft-web.sh`, which needs the `wasm32-unknown-unknown` Rust target, `wasm-bindgen-cli` at the version in PdfCraft's `Cargo.lock` (0.2.129 at the pinned commit), and optionally `wasm-opt` from binaryen. Set `PDFCRAFT_REF` to build another PdfCraft commit, `FAST=1` for quicker development builds, and `CRAFT_FONTS_DIR` to a clone of [storytold/craft-fonts](https://github.com/storytold/craft-fonts) to embed PdfCraft's Japanese fonts as its official builds do.

For development, `npm run watch` rebuilds the scripts as you edit; symlink or copy the repository into `apps/pdfcraft` of a test server.

## Limitations

- PdfCraft is young. Annotating, forms, signing, organizing pages and redaction work well; reliably editing existing text is still limited upstream.
- One person edits at a time. There is no live co-editing; concurrent saves are caught and you choose what happens.
- Files locked by another app (for example while open in Collabora) can't be saved until the lock is released; save a copy instead.
- The whole PDF is held in the browser, so very large files need a correspondingly capable device.

## License

This app is licensed under the AGPL-3.0-or-later. PdfCraft, bundled in `web/`, is licensed under MIT OR Apache-2.0; its bundled fonts and assets carry their own open licenses (see PdfCraft's `ATTRIBUTION.md`). "PdfCraft" refers to the upstream project; this integration is not affiliated with it.
