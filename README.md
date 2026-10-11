<!--
  - SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
# PdfCraft integration for Nextcloud

Edit the PDFs in your Nextcloud with [PdfCraft](https://github.com/storytold/pdfcraft) (formerly PrintCraft), the open-source, Rust-native PDF workbench, without leaving the browser.

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

Until the app is in the Nextcloud App Store, the latest version is in [CyberFox-81/nextcloud_plugins](https://github.com/CyberFox-81/nextcloud_plugins), whose README has step-by-step commands for Docker, Nextcloud AIO and regular servers. In short:

1. Download [`integration_pdfcraft.tar.gz`](https://github.com/CyberFox-81/nextcloud_plugins/raw/main/integration_pdfcraft/integration_pdfcraft.tar.gz) and extract it into your Nextcloud's `custom_apps/` (or `apps/`) folder, so you have `custom_apps/integration_pdfcraft/appinfo/info.xml`.
2. Make it readable by the web server user, e.g. `chown -R www-data:www-data custom_apps/integration_pdfcraft`.
3. Enable it: `sudo -u www-data php occ app:enable integration_pdfcraft`. In Docker: `docker exec -u www-data nextcloud php occ app:enable integration_pdfcraft`.

Once it's in the App Store: **Apps ▸ Integration ▸ PdfCraft integration ▸ Download and enable**, or `sudo -u www-data php occ app:install integration_pdfcraft`.

To make PdfCraft the click-to-open default for every user who hasn't chosen otherwise:

```sh
sudo -u www-data php occ config:app:set integration_pdfcraft open_by_default --value=true --type=boolean
```

## How it works

```
Files ── "Edit in PdfCraft" ──▶ /apps/integration_pdfcraft/edit/{fileId}   (src/editor.ts)
                                  │  WebDAV GET/PUT with the user's session
                                  ▼
                                <iframe> /apps/integration_pdfcraft/frame?host=parent   (templates/frame.php)
                                  │  PdfCraft (web/*.wasm) — postMessage bridge
```

The editor page downloads the PDF over WebDAV and passes it to PdfCraft with `postMessage`. When you save, PdfCraft passes the bytes back and the page uploads them with `If-Match`, so a newer version on the server is never overwritten without asking. The frame page is the only one whose Content Security Policy allows compiling WebAssembly.

PdfCraft has an opt-in embedding bridge (`?host=parent`) since [storytold/pdfcraft#842](https://github.com/storytold/pdfcraft/pull/842), contributed for this app: a same-origin parent page can open files in PdfCraft and receive its saves. The protocol is described in [web/README.md](web/README.md). It is in PdfCraft's main branch, but not yet in a release (the latest is 0.4.0).

`patches/pdfcraft-nextcloud.patch` adds only an `unbranded` build feature that leaves out the ArtCraft logos. PdfCraft's code is MIT/Apache, but its brand terms (`docs/brand/LICENSE-brand.txt` upstream) don't allow modified builds to carry the ArtCraft marks, so the build bundled here leaves them out.

## Build from source

```sh
make js      # npm ci && vite build → js/
make wasm    # clone PdfCraft, apply the patch, build → web/   (needs Rust, see below)
make dist    # → build/dist/integration_pdfcraft-<version>.tar.gz
```

`make wasm` runs `scripts/build-pdfcraft-web.sh`, which needs the `wasm32-unknown-unknown` Rust target, `wasm-bindgen-cli` at the version in PdfCraft's `Cargo.lock` (0.2.129 at the pinned commit), and optionally `wasm-opt` from binaryen. Set `PDFCRAFT_REF` to build another PdfCraft commit, `FAST=1` for quicker development builds, and `CRAFT_FONTS_DIR` to a clone of [storytold/craft-fonts](https://github.com/storytold/craft-fonts) to embed PdfCraft's Japanese fonts as its official builds do.

For development, `npm run watch` rebuilds the scripts as you edit; symlink or copy the repository into `custom_apps/integration_pdfcraft` of a test server.

## Releasing to the App Store

One-time setup (see the [App Store developer guide](https://nextcloudappstore.readthedocs.io/en/latest/developer.html)):

1. Create the app's key and certificate request, and keep the key private and backed up:
   ```sh
   mkdir -p ~/.nextcloud/certificates && cd ~/.nextcloud/certificates
   openssl req -nodes -newkey rsa:4096 -keyout integration_pdfcraft.key -out integration_pdfcraft.csr -subj "/CN=integration_pdfcraft"
   ```
2. Submit `integration_pdfcraft.csr` as `integration_pdfcraft/integration_pdfcraft.csr` in a pull request to [nextcloud/app-certificate-requests](https://github.com/nextcloud/app-certificate-requests). Save the signed certificate they reply with as `~/.nextcloud/certificates/integration_pdfcraft.crt`.
3. Register the app at [apps.nextcloud.com/developer/apps/new](https://apps.nextcloud.com/developer/apps/new) with the certificate and this signature:
   ```sh
   echo -n "integration_pdfcraft" | openssl dgst -sha512 -sign ~/.nextcloud/certificates/integration_pdfcraft.key | openssl base64
   ```

Each release:

```sh
make js && make wasm
scripts/sign-release.sh --key ~/.nextcloud/certificates/integration_pdfcraft.key \
  --cert ~/.nextcloud/certificates/integration_pdfcraft.crt --docker nextcloud
```

The script code-signs the app with `occ integrity:sign-app` (borrowed from a running Nextcloud container, or `--occ` for a local install), packs `build/dist/integration_pdfcraft-<version>.tar.gz` and prints the App Store signature. Attach the archive to a GitHub release, then submit its download URL and the signature at [apps.nextcloud.com/developer/apps/releases/new](https://apps.nextcloud.com/developer/apps/releases/new).

Every new version also goes to [nextcloud_plugins](https://github.com/CyberFox-81/nextcloud_plugins), replacing the previous one, with that repository's script (from a clone next to this one):

```sh
../nextcloud_plugins/scripts/update-plugin.py build/dist/integration_pdfcraft-<version>.tar.gz
```

## Limitations

- PdfCraft is young. Annotating, forms, signing, organizing pages and redaction work well; reliably editing existing text is still limited upstream.
- One person edits at a time. There is no live co-editing; concurrent saves are caught and you choose what happens.
- Files locked by another app (for example while open in Collabora) can't be saved until the lock is released; save a copy instead.
- The whole PDF is held in the browser, so very large files need a correspondingly capable device.

## License

This app is licensed under the AGPL-3.0-or-later. PdfCraft, bundled in `web/`, is licensed under MIT OR Apache-2.0; its bundled fonts and assets carry their own open licenses (see PdfCraft's `ATTRIBUTION.md`). "PdfCraft" refers to the upstream project; this integration is not affiliated with it.
