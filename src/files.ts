/**
 * SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { IFileAction, INode } from '@nextcloud/files'

import { getCurrentUser } from '@nextcloud/auth'
import { DefaultType, FileType, Permission, registerFileAction } from '@nextcloud/files'
import { loadState } from '@nextcloud/initial-state'
import { t } from '@nextcloud/l10n'
import { generateUrl } from '@nextcloud/router'
import { isPublicShare } from '@nextcloud/sharing/public'
import { pdfCraftIcon } from './icon.ts'

const openByDefault = loadState<boolean>('integration_pdfcraft', 'openByDefault', false)

/**
 * A PDF in the user's own file tree (not the trash bin, versions or a public share).
 *
 * @param node - The file to check
 */
function isEditablePdf(node: INode | undefined): node is INode {
	return node !== undefined
		&& node.type === FileType.File
		&& node.mime === 'application/pdf'
		&& node.fileid !== undefined
		&& (node.permissions & Permission.READ) !== 0
		&& node.root?.startsWith('/files/') === true
}

const editAction: IFileAction = {
	id: 'pdfcraft-edit',
	displayName: () => t('integration_pdfcraft', 'Edit in PdfCraft'),
	iconSvgInline: () => pdfCraftIcon,

	enabled({ nodes }) {
		return getCurrentUser() !== null && !isPublicShare() && nodes.length === 1 && isEditablePdf(nodes[0])
	},

	async exec({ nodes }) {
		const fileId = nodes[0].fileid
		if (fileId === undefined) {
			return false
		}
		window.location.assign(generateUrl('/apps/integration_pdfcraft/edit/{fileId}', { fileId }))
		return null
	},

	// Ahead of the Viewer's "view" action when PdfCraft is the user's default for PDFs.
	...(openByDefault ? { default: DefaultType.DEFAULT, order: -1 } : { order: 20 }),
}

registerFileAction(editAction)
