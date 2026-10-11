/**
 * SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * The editor page. PdfCraft runs in an iframe (templates/frame.php) and talks to this page
 * with postMessage (see web/README.md for the protocol):
 *
 *   PdfCraft → page   pdfcraft:ready    the app is listening for files
 *   page → PdfCraft   pdfcraft:open     { name, bytes } a PDF to open
 *   PdfCraft → page   pdfcraft:save     { name, saveAs, bytes } the user saved
 *   PdfCraft → page   pdfcraft:dirty    { dirty } unsaved work appeared or went away
 *   boot.js → page    pdfcraft:failed   { error } the app couldn't start
 *
 * This page downloads and uploads over WebDAV with the user's session, so a save becomes a
 * new version of the file in Nextcloud.
 */

import { getRequestToken } from '@nextcloud/auth'
import { DialogBuilder, FilePickerClosed, getFilePickerBuilder, showConfirmation, showError, showSuccess, showWarning } from '@nextcloud/dialogs'
import { loadState } from '@nextcloud/initial-state'
import { t } from '@nextcloud/l10n'
import { basename, dirname, encodePath, join } from '@nextcloud/paths'
import { generateRemoteUrl, generateUrl } from '@nextcloud/router'
import { pdfCraftIcon } from './icon.ts'

import '@nextcloud/dialogs/style.css'

interface FileState {
	fileId: number
	name: string
	path: string
	canUpdate: boolean
	etag: string
	uid: string
}

interface Urls {
	frame: string
	files: string
}

/** Where saves of one PdfCraft document go. */
interface Target {
	path: string
	/** The version this page last read or wrote; uploads only replace that version. */
	etag: string | null
	canUpdate: boolean
}

/** A save that didn't reach Nextcloud, kept so it can be retried. */
interface Unsaved {
	name: string
	saveAs: boolean
	bytes: ArrayBuffer
}

class HttpError extends Error {
	constructor(public readonly status: number) {
		super(`HTTP ${status}`)
	}
}

const APP = 'integration_pdfcraft'
const file = loadState<FileState>(APP, 'file')
const urls = loadState<Urls>(APP, 'urls')
let openByDefault = loadState<boolean>(APP, 'openByDefault', false)

/** Save targets by document name in PdfCraft, which is what a save message carries. */
const targets = new Map<string, Target>([[file.name, { path: file.path, etag: quoted(file.etag), canUpdate: file.canUpdate }]])
const unsaved = new Map<string, Unsaved>()
let frameDirty = false
let uploading = 0
let saveQueue: Promise<void> = Promise.resolve()
let opened = false
let leaving = false
/** A Save As dialog is waiting for the user. */
let choosingPath = false
/** Where Close goes: the folder of the file being edited, with the file highlighted. */
let filesUrl = urls.files

// ---------------------------------------------------------------------------------------------
// Page

const root = document.getElementById('pdfcraft-editor')!
root.replaceChildren()

const bar = element('header', 'pdfcraft-bar')
const icon = element('span', 'pdfcraft-bar__icon')
icon.innerHTML = pdfCraftIcon
icon.setAttribute('aria-hidden', 'true')
const title = element('h2', 'pdfcraft-bar__title')
const status = element('span', 'pdfcraft-bar__status')
status.setAttribute('role', 'status')
const retry = button(t('integration_pdfcraft', 'Retry saving'), 'pdfcraft-button pdfcraft-button--primary', retrySaves)
const defaultToggle = element('label', 'pdfcraft-bar__toggle')
const defaultCheckbox = document.createElement('input')
defaultCheckbox.type = 'checkbox'
defaultCheckbox.checked = openByDefault
defaultCheckbox.addEventListener('change', () => setOpenByDefault(defaultCheckbox.checked))
defaultToggle.append(defaultCheckbox, document.createTextNode(t('integration_pdfcraft', 'Open PDFs here from Files')))
defaultToggle.title = t('integration_pdfcraft', 'Clicking a PDF in Files opens it in PdfCraft instead of the viewer')
const close = button(t('integration_pdfcraft', 'Close'), 'pdfcraft-button', closeEditor)
bar.append(icon, title, status, retry, defaultToggle, close)

const stage = element('div', 'pdfcraft-stage')
const frame = document.createElement('iframe')
frame.className = 'pdfcraft-frame'
frame.title = t('integration_pdfcraft', 'PdfCraft PDF editor')
frame.allow = 'fullscreen; clipboard-read; clipboard-write'
frame.src = urls.frame
const overlay = element('div', 'pdfcraft-overlay')
stage.append(frame, overlay)
root.append(bar, stage)

setTitle(file.path)
showOverlay(t('integration_pdfcraft', 'Opening {name} …', { name: file.name }, { escape: false }))
render()

// A frame that never answers usually means the server sends .wasm with the wrong MIME type.
const startTimeout = window.setTimeout(() => {
	if (!opened) {
		showOverlay(t('integration_pdfcraft', 'PdfCraft is taking unusually long to start. If this persists, make sure your web server serves .wasm files as application/wasm.'), true)
	}
}, 45_000)

// The download starts with the page, alongside PdfCraft loading in the frame.
const initial = download(file.path)
initial.catch((error: unknown) => {
	window.clearTimeout(startTimeout)
	showOverlay(describeError(error, file.name, 'open'), true)
})

window.addEventListener('message', (event: MessageEvent) => {
	if (event.origin !== window.location.origin || event.source !== frame.contentWindow) {
		return
	}
	const data: unknown = event.data
	if (typeof data !== 'object' || data === null) {
		return
	}
	const message = data as Record<string, unknown>
	switch (message.type) {
	case 'pdfcraft:ready':
		void openInFrame()
		break
	case 'pdfcraft:save':
		if (message.bytes instanceof ArrayBuffer) {
			queueSave({ name: String(message.name ?? file.name), saveAs: message.saveAs === true, bytes: message.bytes })
		}
		break
	case 'pdfcraft:dirty':
		frameDirty = message.dirty === true
		render()
		break
	case 'pdfcraft:failed':
		window.clearTimeout(startTimeout)
		showOverlay(t('integration_pdfcraft', 'PdfCraft couldn’t start: {error}', { error: String(message.error ?? '') }, { escape: false }), true)
		break
	}
})

window.addEventListener('beforeunload', (event) => {
	if (!leaving && hasUnsavedWork()) {
		event.preventDefault()
	}
})

// ---------------------------------------------------------------------------------------------
// Opening

async function openInFrame(): Promise<void> {
	try {
		const target = targets.get(file.name)
		// The first download is transferred to the frame; a reloaded frame gets the file as it
		// is in Nextcloud now.
		const { bytes, etag } = opened ? await download(target?.path ?? file.path) : await initial
		if (target && etag) {
			target.etag = etag
		}
		frame.contentWindow?.postMessage({ type: 'pdfcraft:open', name: file.name, bytes }, window.location.origin, [bytes])
		opened = true
		window.clearTimeout(startTimeout)
		hideOverlay()
	} catch (error) {
		window.clearTimeout(startTimeout)
		showOverlay(describeError(error, file.name, 'open'), true)
	}
}

async function download(path: string): Promise<{ bytes: ArrayBuffer, etag: string | null }> {
	const response = await fetch(davUrl(path), {
		headers: { requesttoken: getRequestToken() ?? '' },
		credentials: 'same-origin',
		cache: 'no-store',
	})
	if (!response.ok) {
		throw new HttpError(response.status)
	}
	return { bytes: await response.arrayBuffer(), etag: response.headers.get('ETag') }
}

// ---------------------------------------------------------------------------------------------
// Saving

function queueSave(save: Unsaved): void {
	uploading++
	render()
	saveQueue = saveQueue
		.then(() => store(save))
		.catch((error: unknown) => {
			unsaved.set(save.name, save)
			showError(describeError(error, save.name, 'save'))
		})
		.finally(() => {
			uploading--
			render()
		})
}

/** Upload one save: back to its file, or wherever the user picks for Save As and new files. */
async function store(save: Unsaved): Promise<void> {
	unsaved.delete(save.name)
	const target = targets.get(save.name)
	if (!save.saveAs && target?.canUpdate) {
		await uploadExisting(save, target)
		return
	}

	const reason = save.saveAs ? 'saveAs' : (target ? 'readOnly' : 'new')
	const path = await askSavePathWithStatus(save.name, target, reason)
	if (path === null) {
		unsaved.set(save.name, save)
		showWarning(t('integration_pdfcraft', '{name} was not saved to Nextcloud', { name: save.name }, { escape: false }))
		return
	}
	await uploadNew(save, path)
}

async function uploadExisting(save: Unsaved, target: Target): Promise<void> {
	const response = await put(target.path, save.bytes, target.etag ? { 'If-Match': target.etag } : {})
	if (response.status === 412) {
		// Someone else saved the file since this page read it.
		const choice = await choose(
			t('integration_pdfcraft', 'This file was changed elsewhere'),
			t('integration_pdfcraft', '{name} has been changed by someone else since you opened it. Saving now replaces their changes; a copy keeps both.', { name: basename(target.path) }, { escape: false }),
			[
				{ label: t('integration_pdfcraft', 'Cancel'), value: 'cancel' },
				{ label: t('integration_pdfcraft', 'Save a copy'), value: 'copy' },
				{ label: t('integration_pdfcraft', 'Replace'), value: 'replace', variant: 'error' },
			],
			'cancel',
		)
		if (choice === 'replace') {
			await finishUpload(save, target.path, await put(target.path, save.bytes, {}))
		} else if (choice === 'copy') {
			const path = await askSavePathWithStatus(save.name, target, 'saveAs')
			if (path === null) {
				unsaved.set(save.name, save)
			} else {
				await uploadNew(save, path)
			}
		} else {
			unsaved.set(save.name, save)
			showWarning(t('integration_pdfcraft', '{name} was not saved to Nextcloud', { name: save.name }, { escape: false }))
		}
		return
	}
	await finishUpload(save, target.path, response)
}

async function uploadNew(save: Unsaved, path: string): Promise<void> {
	// Never replace an existing file without asking.
	let response = await put(path, save.bytes, { 'If-None-Match': '*' })
	if (response.status === 412) {
		const replace = await showConfirmation({
			name: t('integration_pdfcraft', 'Replace {name}?', { name: basename(path) }, { escape: false }),
			text: t('integration_pdfcraft', 'A file named {name} already exists in {folder}.', { name: basename(path), folder: folderLabel(dirname(path)) }, { escape: false }),
			labelConfirm: t('integration_pdfcraft', 'Replace'),
			labelReject: t('integration_pdfcraft', 'Cancel'),
			severity: 'warning',
		})
		if (!replace) {
			unsaved.set(save.name, save)
			showWarning(t('integration_pdfcraft', '{name} was not saved to Nextcloud', { name: save.name }, { escape: false }))
			return
		}
		response = await put(path, save.bytes, {})
	}
	await finishUpload(save, path, response)
}

async function finishUpload(save: Unsaved, path: string, response: Response): Promise<void> {
	if (!response.ok) {
		throw new HttpError(response.status)
	}
	const etag = response.headers.get('OC-ETag') ?? response.headers.get('ETag') ?? await currentEtag(path)
	// Later saves of this document go to the file it was just saved as.
	targets.set(save.name, { path, etag: etag ? quoted(etag) : null, canUpdate: true })
	if (save.name === file.name) {
		setTitle(path)
		const fileId = response.headers.get('OC-FileId')
		if (path !== file.path && fileId) {
			// OC-FileId is the zero-padded id followed by the instance id.
			const id = Number.parseInt(fileId, 10)
			if (Number.isFinite(id)) {
				window.history.replaceState(null, '', generateUrl('/apps/integration_pdfcraft/edit/{fileId}', { fileId: id }))
				filesUrl = generateUrl('/apps/files/files/{fileId}?dir={dir}', { fileId: id, dir: dirname(path) })
			}
		}
	}
	showSuccess(t('integration_pdfcraft', 'Saved {name} to Nextcloud', { name: basename(path) }, { escape: false }))
}

function put(path: string, bytes: ArrayBuffer, conditions: Record<string, string>): Promise<Response> {
	return fetch(davUrl(path), {
		method: 'PUT',
		headers: {
			requesttoken: getRequestToken() ?? '',
			'Content-Type': 'application/pdf',
			...conditions,
		},
		body: bytes,
		credentials: 'same-origin',
	})
}

async function currentEtag(path: string): Promise<string | null> {
	try {
		const response = await fetch(davUrl(path), { method: 'HEAD', headers: { requesttoken: getRequestToken() ?? '' }, credentials: 'same-origin', cache: 'no-store' })
		return response.ok ? response.headers.get('ETag') : null
	} catch {
		return null
	}
}

function retrySaves(): void {
	const pending = [...unsaved.values()]
	unsaved.clear()
	pending.forEach(queueSave)
	render()
}

// ---------------------------------------------------------------------------------------------
// Save As

type SaveReason = 'saveAs' | 'readOnly' | 'new'

/**
 * Ask for a file name and folder. Returns the user-relative path, or `null` when cancelled.
 *
 * @param name - The document's name in PdfCraft
 * @param target - Where the document was opened from or last saved, if anywhere
 * @param reason - Why we ask
 */
async function askSavePath(name: string, target: Target | undefined, reason: SaveReason): Promise<string | null> {
	let folder = target ? dirname(target.path) : dirname(file.path)
	const suggested = reason === 'readOnly' ? withSuffix(target ? basename(target.path) : name, t('integration_pdfcraft', 'edited')) : withPdf(target ? basename(target.path) : name)

	const dialog = element('dialog', 'pdfcraft-save') as HTMLDialogElement
	const form = document.createElement('form')
	form.method = 'dialog'
	const heading = element('h2', 'pdfcraft-save__heading')
	heading.textContent = {
		saveAs: t('integration_pdfcraft', 'Save as'),
		readOnly: t('integration_pdfcraft', 'This file is read-only'),
		new: t('integration_pdfcraft', 'Save to Nextcloud'),
	}[reason]
	const hint = element('p', 'pdfcraft-save__hint')
	hint.textContent = reason === 'readOnly' ? t('integration_pdfcraft', 'You can’t change {name}, but you can save your edits as a new file.', { name: basename(target?.path ?? name) }, { escape: false }) : ''
	hint.hidden = reason !== 'readOnly'

	const nameLabel = element('label', 'pdfcraft-save__label')
	nameLabel.textContent = t('integration_pdfcraft', 'File name')
	const nameInput = document.createElement('input')
	nameInput.type = 'text'
	nameInput.required = true
	nameInput.value = suggested
	nameInput.className = 'pdfcraft-save__input'
	nameLabel.append(nameInput)

	const folderRow = element('div', 'pdfcraft-save__folder')
	const folderText = element('span', 'pdfcraft-save__folder-path')
	const showFolder = () => {
		folderText.textContent = t('integration_pdfcraft', 'In {folder}', { folder: folderLabel(folder) }, { escape: false })
	}
	showFolder()
	const pickFolder = button(t('integration_pdfcraft', 'Change folder …'), 'pdfcraft-button', async () => {
		// The picker is its own modal; ours steps aside meanwhile.
		dialog.close('picking')
		const picked = await chooseFolder(folder)
		if (picked !== null) {
			folder = picked
			showFolder()
		}
		dialog.returnValue = ''
		dialog.showModal()
		nameInput.focus()
	})
	folderRow.append(folderText, pickFolder)

	const error = element('p', 'pdfcraft-save__error')
	error.setAttribute('role', 'alert')
	const actions = element('div', 'pdfcraft-save__actions')
	const cancel = button(t('integration_pdfcraft', 'Cancel'), 'pdfcraft-button', () => dialog.close('cancel'))
	const submit = document.createElement('button')
	submit.type = 'submit'
	submit.value = 'save'
	submit.className = 'pdfcraft-button pdfcraft-button--primary'
	submit.textContent = t('integration_pdfcraft', 'Save')
	actions.append(cancel, submit)

	form.append(heading, hint, nameLabel, folderRow, error, actions)
	dialog.append(form)
	document.body.append(dialog)

	return new Promise((resolve) => {
		let result: string | null = null
		form.addEventListener('submit', (event) => {
			const problem = invalidName(nameInput.value)
			if (problem) {
				event.preventDefault()
				error.textContent = problem
				nameInput.focus()
				return
			}
			result = join(folder, withPdf(nameInput.value.trim()))
		})
		dialog.addEventListener('close', () => {
			if (dialog.returnValue === 'picking') {
				return
			}
			dialog.remove()
			resolve(result)
		})
		dialog.showModal()
		// Select the name without its extension, like the Files app does on rename.
		const stem = nameInput.value.toLowerCase().endsWith('.pdf') ? nameInput.value.length - 4 : nameInput.value.length
		nameInput.setSelectionRange(0, stem)
		nameInput.focus()
	})
}

async function askSavePathWithStatus(name: string, target: Target | undefined, reason: SaveReason): Promise<string | null> {
	choosingPath = true
	render()
	try {
		return await askSavePath(name, target, reason)
	} finally {
		choosingPath = false
		render()
	}
}

async function chooseFolder(start: string): Promise<string | null> {
	let chosen: string | null = null
	try {
		await getFilePickerBuilder(t('integration_pdfcraft', 'Choose a folder'))
			.allowDirectories(true)
			.setMimeTypeFilter(['httpd/unix-directory'])
			.startAt(start)
			.setButtonFactory((selected, currentPath) => [{
				label: selected.length === 1 ? t('integration_pdfcraft', 'Choose {folder}', { folder: selected[0]!.basename }, { escape: false }) : t('integration_pdfcraft', 'Choose this folder'),
				variant: 'primary',
				callback: () => {
					chosen = selected.length === 1 ? selected[0]!.path : currentPath
				},
			}])
			.build()
			.pick()
	} catch (error) {
		if (!(error instanceof FilePickerClosed)) {
			throw error
		}
	}
	return chosen
}

function invalidName(raw: string): string | null {
	const name = raw.trim()
	if (name === '' || name === '.pdf') {
		return t('integration_pdfcraft', 'Enter a file name.')
	}
	if (name.includes('/') || name.includes('\\')) {
		return t('integration_pdfcraft', 'A file name can’t contain “/” or “\\”.')
	}
	if (name === '.' || name === '..') {
		return t('integration_pdfcraft', '“{name}” is not a valid file name.', { name }, { escape: false })
	}
	return null
}

// ---------------------------------------------------------------------------------------------
// Leaving

async function closeEditor(): Promise<void> {
	if (hasUnsavedWork()) {
		const leave = await showConfirmation({
			name: t('integration_pdfcraft', 'Leave without saving?'),
			text: uploading > 0
				? t('integration_pdfcraft', 'A save is still being uploaded. If you leave now it may not reach Nextcloud.')
				: t('integration_pdfcraft', 'Your latest changes have not been saved to Nextcloud.'),
			labelConfirm: t('integration_pdfcraft', 'Leave'),
			labelReject: t('integration_pdfcraft', 'Keep editing'),
			severity: 'warning',
		})
		if (!leave) {
			return
		}
	}
	leaveTo(filesUrl)
}

/** Leave the editor when the user has already chosen to (or nothing is unsaved). */
function leaveTo(url: string): void {
	leaving = true
	// PdfCraft asks the browser to confirm leaving while it has unsaved changes. The user has
	// answered our question already, and removing the frame first spares them a second one.
	frame.remove()
	window.location.assign(url)
}

function hasUnsavedWork(): boolean {
	return frameDirty || uploading > 0 || unsaved.size > 0
}

async function setOpenByDefault(enabled: boolean): Promise<void> {
	try {
		const response = await fetch(generateUrl('/apps/integration_pdfcraft/preferences'), {
			method: 'PUT',
			headers: { requesttoken: getRequestToken() ?? '', 'Content-Type': 'application/json' },
			body: JSON.stringify({ openByDefault: enabled }),
			credentials: 'same-origin',
		})
		if (!response.ok) {
			throw new HttpError(response.status)
		}
		openByDefault = enabled
		showSuccess(enabled
			? t('integration_pdfcraft', 'PDFs you click in Files now open in PdfCraft')
			: t('integration_pdfcraft', 'PDFs you click in Files open in the viewer again'))
	} catch {
		defaultCheckbox.checked = openByDefault
		showError(t('integration_pdfcraft', 'Couldn’t save this setting'))
	}
}

// ---------------------------------------------------------------------------------------------
// Helpers

function render(): void {
	let text: string
	let state: string
	if (choosingPath) {
		text = t('integration_pdfcraft', 'Choose where to save …')
		state = 'busy'
	} else if (uploading > 0) {
		text = t('integration_pdfcraft', 'Saving to Nextcloud …')
		state = 'busy'
	} else if (unsaved.size > 0) {
		text = t('integration_pdfcraft', 'Not saved to Nextcloud')
		state = 'error'
	} else if (frameDirty) {
		text = t('integration_pdfcraft', 'Unsaved changes')
		state = 'dirty'
	} else if (!file.canUpdate && targets.get(file.name)?.path === file.path) {
		text = t('integration_pdfcraft', 'Read-only: saving makes a copy')
		state = 'readonly'
	} else {
		text = ''
		state = 'clean'
	}
	status.textContent = text
	status.dataset.state = state
	retry.hidden = unsaved.size === 0 || uploading > 0
}

function setTitle(path: string): void {
	title.textContent = basename(path)
	title.title = path
	document.title = `${basename(path)} - PdfCraft`
}

function showOverlay(text: string, isError = false): void {
	overlay.replaceChildren()
	if (!isError) {
		overlay.append(element('span', 'pdfcraft-overlay__spinner icon-loading'))
	}
	const message = element('p', 'pdfcraft-overlay__text')
	message.textContent = text
	overlay.append(message)
	if (isError) {
		overlay.append(button(t('integration_pdfcraft', 'Back to Files'), 'pdfcraft-button', () => leaveTo(filesUrl)))
	}
	overlay.dataset.error = String(isError)
	overlay.hidden = false
}

function hideOverlay(): void {
	overlay.hidden = true
}

function describeError(error: unknown, name: string, action: 'open' | 'save'): string {
	if (error instanceof HttpError) {
		switch (error.status) {
		case 401:
		case 403:
			return action === 'open'
				? t('integration_pdfcraft', 'You don’t have permission to open {name}.', { name }, { escape: false })
				: t('integration_pdfcraft', 'You don’t have permission to save {name} there.', { name }, { escape: false })
		case 404:
			return t('integration_pdfcraft', '{name} no longer exists.', { name }, { escape: false })
		case 423:
			return t('integration_pdfcraft', '{name} is locked by another app or user. Try again later or save a copy.', { name }, { escape: false })
		case 507:
			return t('integration_pdfcraft', 'There is not enough storage space to save {name}.', { name }, { escape: false })
		}
	}
	const detail = error instanceof Error ? error.message : String(error)
	return action === 'open'
		? t('integration_pdfcraft', 'Couldn’t open {name}: {detail}', { name, detail }, { escape: false })
		: t('integration_pdfcraft', 'Couldn’t save {name}: {detail}', { name, detail }, { escape: false })
}

/**
 * Show a dialog with several choices and resolve to the one picked.
 *
 * @param name - Heading
 * @param text - Explanation
 * @param choices - Buttons, in display order
 * @param fallback - The result when the dialog is dismissed
 */
function choose<T>(name: string, text: string, choices: { label: string, value: T, variant?: 'primary' | 'secondary' | 'error' }[], fallback: T): Promise<T> {
	let result = fallback
	const dialog = new DialogBuilder(name)
		.setText(text)
		.setSeverity('warning')
		.setButtons(choices.map((choice) => ({
			label: choice.label,
			variant: choice.variant,
			callback: () => {
				result = choice.value
			},
		})))
		.build()
	return dialog.show().then(() => result)
}

/** A folder as the Files app names it: "All files" for the root, otherwise its path. */
function folderLabel(dir: string): string {
	return dir === '/' || dir === '' ? t('integration_pdfcraft', 'All files') : dir.replace(/^\//, '')
}

function davUrl(path: string): string {
	return generateRemoteUrl(`dav/files/${encodeURIComponent(file.uid)}`) + encodePath(path)
}

function quoted(etag: string): string {
	return etag.startsWith('"') || etag.startsWith('W/') ? etag : `"${etag}"`
}

function withPdf(name: string): string {
	return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`
}

function withSuffix(name: string, suffix: string): string {
	const pdf = withPdf(name)
	return `${pdf.slice(0, -4)} (${suffix}).pdf`
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	node.className = className
	return node
}

function button(label: string, className: string, onClick: () => unknown): HTMLButtonElement {
	const node = element('button', className)
	node.type = 'button'
	node.textContent = label
	node.addEventListener('click', () => {
		void onClick()
	})
	return node
}
