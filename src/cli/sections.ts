/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { SectionConfig } from '../config.js'
import type { Message } from '../types.js'
import { isTranslated, placeholder, type LocaleMessages } from './catalog.js'
import { isInside, readAliases, walk } from './graph.js'
import { mergeMessages, scanCode, sourceFiles, type ScanWarning } from './scan.js'

/** `fr.json`, `pt-BR.json` — a locale file's name. */
export const LOCALE_FILE = /^([a-z]{2,3}(?:[-_][a-z\d]+)*)\.json$/i

/** The locales with a file in `dir`, sorted. */
export const localesIn = (dir: string, sourceLocale?: string) =>
	(existsSync(dir) ? readdirSync(dir).flatMap(name => LOCALE_FILE.exec(name)?.[1] ?? []) : []).filter(locale => locale !== sourceLocale).sort()

export interface Section {
	name: string
	/** Its directory, absolute. */
	path: string
	/** Where its `<locale>.json` files are, absolute. */
	dir: string
	/** Its languages: the files in `dir`. */
	locales: string[]
	/** Every message the section uses, the server's and the browser's: what the main catalog must translate for it. */
	used: Map<string, Message>
	/** What its files hold: `used`, or only the client modules' messages. */
	messages: Map<string, Message>
	/** How many files it is made of. */
	files: number
}

/** `app/[lang]/(site)` → `site`. */
const nameOf = (path: string) => basename(path).replace(/[()[\]@.]/g, '') || 'root'

/**
 * The sections in the config, read: their files (their own, and everything those import), the messages in them and
 * the languages their `locales` directories have. A section's own files stop at a section nested inside it.
 */
export const readSections = (
	configs: readonly (string | SectionConfig)[],
	options: { cwd: string; sourceLocale: string; functions?: readonly string[] | undefined; only: 'all' | 'client' }
) => {
	const { cwd, sourceLocale, functions, only } = options
	const resolved = configs.map(config => {
		const { path, name, dir } = typeof config === 'string' ? { path: config, name: undefined, dir: undefined } : config
		const absolute = resolve(cwd, path)
		if (!existsSync(absolute)) throw new Error(`Section "${path}" isn't there. Fix \`sections\` in textlate.config.js.`)
		return { name: name ?? nameOf(absolute), path: absolute, dir: resolve(cwd, dir ?? join(path, 'locales')) }
	})
	const names = new Set<string>()
	for (const { name, path } of resolved) {
		if (names.has(name)) throw new Error(`Two sections are called "${name}". Give one a \`name\`: { path: '${relative(cwd, path)}', name: '…' }.`)
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

	const sections: Section[] = resolved.map(section => {
		const nested = resolved.filter(other => other !== section && other.path !== section.path && isInside(other.path, section.path))
		const own = sourceFiles(section.path, []).filter(file => !nested.some(other => isInside(file, other.path)) && !isInside(file, section.dir))
		const graph = walk(own, aliases, cache)
		const used = messagesOf(graph.files)
		return {
			...section,
			locales: localesIn(section.dir, sourceLocale),
			used,
			messages: only === 'client' ? messagesOf(graph.clientFiles) : used,
			files: graph.files.length
		}
	})
	return { sections, warnings }
}

/** The messages the main catalog holds for `locale`: everything the sections in that language use, then `extra`. */
export const mainMessages = (sections: readonly Section[], locale: string, extra?: ReadonlyMap<string, Message>) => {
	const messages = new Map<string, Message>()
	for (const section of sections) if (section.locales.includes(locale)) mergeMessages(messages, section.used)
	if (extra) mergeMessages(messages, extra)
	return messages
}

/**
 * Translations found in a section's files and not (yet) in the main catalog — written there by hand, or by an older
 * setup — are taken into it, so nothing translated is ever lost. Where both have one, the main catalog's wins.
 */
export const adopt = (main: LocaleMessages, sectionFiles: readonly LocaleMessages[]): LocaleMessages => {
	let adopted: Record<string, unknown> | undefined
	for (const file of sectionFiles) {
		for (const [key, value] of Object.entries(file)) {
			if (isTranslated(value) && !isTranslated(Object.hasOwn(main, key) ? main[key] : undefined)) (adopted ??= { ...main })[key] = value
		}
	}
	return adopted ?? main
}

/** A section's file for `locale`: its messages, in its order, translated from the main catalog. */
export const sectionFile = (section: Section, main: LocaleMessages, locale: string): LocaleMessages => {
	const entries = new Map<string, unknown>()
	for (const [key, source] of section.messages) entries.set(key, Object.hasOwn(main, key) ? main[key] : placeholder(source, locale))
	return Object.fromEntries(entries) as LocaleMessages
}

/** `sections.json`: each section's directory and languages, for an app's routing (which paths exist in which languages). */
export const manifest = (sections: readonly Section[], sourceLocale: string, cwd: string) =>
	`${JSON.stringify(
		{
			sourceLocale,
			sections: Object.fromEntries(sections.map(section => [section.name, { path: relative(cwd, section.path).split(sep).join('/'), locales: section.locales }]))
		},
		null,
		2
	)}\n`
