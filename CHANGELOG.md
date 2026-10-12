<!--
  - SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Changelog

## 0.1.6 – 2026-10-12

- PdfCraft 0.7.1 (main at 7163ba3): the latest PdfCraft.

## 0.1.5 – 2026-10-11

- PdfCraft 0.6.0 (main at 7caaa35): the latest PdfCraft.

## 0.1.4 – 2026-10-11

- PdfCraft 0.6.0 (main at 6d843a8): the latest PdfCraft

## 0.1.3 – 2026-10-11

- PdfCraft 0.6.0 (main at fe2eadb): the latest PdfCraft, 122 commits newer

## 0.1.2 – 2026-10-11

- PdfCraft 0.6.0 (main at bbbe600): the shared document workspace from the CraftSuite UI work and the other changes since b8ddf71.

## 0.1.1 – 2026-10-10

- PdfCraft updated to its main branch at b8ddf71, 74 commits newer. It includes the embedding bridge this app uses (storytold/pdfcraft#842, merged upstream), so the bundled patch now only removes the ArtCraft marks.
- Closing the editor with unsaved changes asks once again: PdfCraft now guards leaving the page itself, which added a second, browser prompt after the app's own question.
- The build scripts accept a git worktree as the PdfCraft checkout.

## 0.1.0 – 2026-10-10

First release.

- App ID `integration_pdfcraft`: "Edit in PdfCraft" in the Files action menu for PDFs (Nextcloud 33–35)
- Editor page with PdfCraft 0.5.0 (commit 1c33e6f) in an iframe
- Save writes back over WebDAV with conflict detection; Save As picks a name and folder
- Read-only files save as a copy
- Optional "open PDFs in PdfCraft when clicked", per user, with an admin default
