<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\PdfCraftIntegration\AppInfo;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\PdfCraftIntegration\Listener\LoadFilesScripts;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

class Application extends App implements IBootstrap {
	public const APP_ID = 'integration_pdfcraft';

	/** User and app config key: open PDFs in PdfCraft when they are clicked in Files. */
	public const OPEN_BY_DEFAULT = 'open_by_default';

	public function __construct() {
		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
		$context->registerEventListener(LoadAdditionalScriptsEvent::class, LoadFilesScripts::class);
	}

	public function boot(IBootContext $context): void {
	}
}
