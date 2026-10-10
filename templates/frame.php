<?php
/**
 * SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/** @var array $_ */
?>
<!DOCTYPE html>
<html lang="<?php p($_['language']); ?>">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="robots" content="noindex, nofollow">
	<title>PdfCraft</title>
	<style>
		html, body { margin: 0; height: 100%; overflow: hidden; background: #f1f1f3; }
		canvas { width: 100%; height: 100%; display: block; outline: none; }
		@media (prefers-color-scheme: dark) { html, body { background: #19191c; } }
	</style>
</head>
<body>
	<canvas id="pdfcraft"></canvas>
	<?php emit_script_tag($_['bootUrl'], '', 'module'); ?>
</body>
</html>
