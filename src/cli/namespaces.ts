/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { NamespaceConfig } from '../config.js'
import type { Message } from '../types.js'
import { isTranslated, placeholder, type LocaleMessages } from './catalog.js'
import { isInside, readAliases, walk } from './graph.js'
import { mergeMessages, scanCode, sourceFiles, type ScanWarning } from './scan.js'

/** `fr.json`, `pt-BR.json` — a locale file's name. */
export const LOCALE_FILE = /^([a-z]{2,3}(?:[-_][a-z\d]+)*)\.json$/i

/** The locales with a file in `dir`, sorted. */
export const localesIn = (dir: string, sourceLocale?: string) =>
	(existsSync(dir) ? readdirSync(dir).flatMap(name => LOCALE_FILE.exec(name)?.[1] ?? []) : []).filter(locale => locale !== sourceLocale).sort()

export interface Namespace {
	name: string
	/** Its directory, absolute. */
	path: string
	/** Where its `<locale>.json` files are, absolute. */
	dir: string
	/** Its languages: the files in `dir`. */
	locales: string[]
	/** Every message the namespace uses, the server's and the browser's: what the main catalog must translate for it. */
	used: Map<string, Message>
	/** What its files hold: `used`, or only the client modules' messages. */
	messages: Map<string, Message>
	/** How many files it is made of. */
	files: number
}

/** `app/[lang]/(site)` → `site`. */
const nameOf = (path: string) => basename(path).replace(/[()[\]@.]/g, '') || 'root'

/**
 * The namespaces in the config, read: their files (their own, and everything those import), the messages in them and
 * the languages their `locales` directories have. A namespace's own files stop at a namespace nested inside it.
 */
export const readNamespaces = (
	configs: readonly (string | NamespaceConfig)[],
	options: { cwd: string; sourceLocale: string; functions?: readonly string[] | undefined; only: 'all' | 'client' }
) => {
	const { cwd, sourceLocale, functions, only } = options
	const resolved = configs.map(config => {
		const { path, name, dir } = typeof config === 'string' ? { path: config, name: undefined, dir: undefined } : config
		const absolute = resolve(cwd, path)
		if (!existsSync(absolute)) throw new Error(`Namespace "${path}" isn't there. Fix \`namespaces\` in textlate.config.js.`)
		return { name: name ?? nameOf(absolute), path: absolute, dir: resolve(cwd, dir ?? join(path, 'locales')) }
	})
	const names = new Set<string>()
	for (const { name, path } of resolved) {
		if (names.has(name)) throw new Error(`Two namespaces are called "${name}". Give one a \`name\`: { path: '${relative(cwd, path)}', name: '…' }.`)
		names.add(name)
	}

	const aliases = readAliases(cwd)
	const cache = new Map<string, { code: string; imports: string[] }>()
	const scanned = new Map<string, Map<string, Message>>()
	const warnings: ScanWarning[] = []
	const messagesOf = (files: Iterable<string>) => {
		const merged = new Map<string, Message>()
		for (const file of [...files].sort()) {
			let found = scanned.get(file)
			if (!found) {
				const result = scanCode(cache.get(file)?.code ?? readFileSync(file, 'utf8'), functions, relative(cwd, file))
				warnings.push(...result.warnings)
				scanned.set(file, (found = result.messages))
			}
			mergeMessages(merged, found)
		}
		return merged
	}

	const namespaces: Namespace[] = resolved.map(namespace => {
		const nested = resolved.filter(other => other !== namespace && other.path !== namespace.path && isInside(other.path, namespace.path))
		const own = sourceFiles(namespace.path, []).filter(file => !nested.some(other => isInside(file, other.path)) && !isInside(file, namespace.dir))
		const graph = walk(own, aliases, cache)
		const used = messagesOf(graph.files)
		return {
			...namespace,
			locales: localesIn(namespace.dir, sourceLocale),
			used,
			messages: only === 'client' ? messagesOf(graph.clientFiles) : used,
			files: graph.files.length
		}
	})
	return { namespaces, warnings }
}

/** The messages the main catalog holds for `locale`: everything the namespaces in that language use, then `extra`. */
export const mainMessages = (namespaces: readonly Namespace[], locale: string, extra?: ReadonlyMap<string, Message>) => {
	const messages = new Map<string, Message>()
	for (const namespace of namespaces) if (namespace.locales.includes(locale)) mergeMessages(messages, namespace.used)
	if (extra) mergeMessages(messages, extra)
	return messages
}

/**
 * Translations found in a namespace's files and not (yet) in the main catalog — written there by hand, or by an older
 * setup — are taken into it, so nothing translated is ever lost. Where both have one, the main catalog's wins.
 */
export const adopt = (main: LocaleMessages, namespaceFiles: readonly LocaleMessages[]): LocaleMessages => {
	let adopted: Record<string, unknown> | undefined
	for (const file of namespaceFiles) {
		for (const [key, value] of Object.entries(file)) {
			if (isTranslated(value) && !isTranslated(Object.hasOwn(main, key) ? main[key] : undefined)) (adopted ??= { ...main })[key] = value
		}
	}
	return adopted ?? main
}

/** A namespace's file for `locale`: its messages, in its order, translated from the main catalog. */
export const namespaceFile = (namespace: Namespace, main: LocaleMessages, locale: string): LocaleMessages => {
	const entries = new Map<string, unknown>()
	for (const [key, source] of namespace.messages) entries.set(key, Object.hasOwn(main, key) ? main[key] : placeholder(source, locale))
	return Object.fromEntries(entries) as LocaleMessages
}

/** `namespaces.json`: each namespace's directory and languages, for an app's routing (which paths exist in which languages). */
export const manifest = (namespaces: readonly Namespace[], sourceLocale: string, cwd: string) =>
	`${JSON.stringify(
		{
			sourceLocale,
			namespaces: Object.fromEntries(namespaces.map(namespace => [namespace.name, { path: relative(cwd, namespace.path).split(sep).join('/'), locales: namespace.locales }]))
		},
		null,
		2
	)}\n`
