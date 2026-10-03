/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PLURAL_CATEGORIES, TOKEN } from '../message.js'
import type { Message, PluralForms } from '../types.js'

/** A translation file: message key → translation (a string, or plural forms). `''` means not translated yet. */
export type LocaleMessages = { readonly [key: string]: unknown }
type Forms = Readonly<Record<string, unknown>>

const isForms = (value: unknown): value is Forms => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether a message in the code is plural forms (rather than text, with or without context). */
export const isPlural = (message: Message): message is PluralForms => typeof message !== 'string' && message.text === undefined

/** The source text of a message: the text, or each plural form. */
export const sourceTexts = (message: Message): string[] =>
	typeof message === 'string'
		? [message]
		: message.text !== undefined
			? [message.text]
			: PLURAL_CATEGORIES.flatMap(category => message[category] ?? [])

/** The plural forms a translation into `locale` needs: the language's categories, plus `zero` if the source has one. */
export const pluralCategories = (locale: string, source?: Message): string[] => {
	const used = new Set<string>(new Intl.PluralRules(locale).resolvedOptions().pluralCategories)
	if (source && isPlural(source) && source.zero !== undefined) used.add('zero')
	return PLURAL_CATEGORIES.filter(category => used.has(category))
}

/** What a translation file holds for a message nobody has translated yet. */
export const placeholder = (source: Message, locale: string): string | Record<string, string> =>
	isPlural(source) ? Object.fromEntries(pluralCategories(locale, source).map(category => [category, ''])) : ''

/** Whether a translation is complete: non-empty text, or every plural form filled in. */
export const isTranslated = (value: unknown): boolean =>
	typeof value === 'string' ? value !== '' : isForms(value) && Object.values(value).length > 0 && Object.values(value).every(form => form)

const syntax = (texts: readonly unknown[]) => {
	const params = new Set<string>()
	const tags = new Set<string>()
	for (const text of texts) {
		if (typeof text !== 'string') continue
		for (const [, param, , tag] of text.matchAll(TOKEN)) {
			if (param) params.add(param)
			else tags.add(tag!)
		}
	}
	return { params, tags }
}

/**
 * What is wrong with a translation: a param or tag the source has and the translation lacks (or the other way
 * round), or a missing plural form. Placeholders may move; they can't be renamed or dropped.
 */
export const checkTranslation = (source: Message, translation: unknown, locale: string): string[] => {
	const problems: string[] = []
	let texts: unknown[]
	if (!isPlural(source)) {
		if (typeof translation !== 'string') return ['should be text, not plural forms']
		texts = [translation]
	} else {
		const categories = pluralCategories(locale, source)
		if (typeof translation === 'string' && categories.join() === 'other') texts = [translation]
		else if (!isForms(translation)) return [`should be plural forms: ${categories.join(', ')}`]
		else {
			for (const category of categories) if (typeof translation[category] !== 'string') problems.push(`is missing the "${category}" form`)
			for (const category of Object.keys(translation)) {
				if (!(PLURAL_CATEGORIES as string[]).includes(category)) problems.push(`has an unknown plural form "${category}"`)
			}
			texts = Object.values(translation)
		}
	}
	const expected = syntax(sourceTexts(source))
	const actual = syntax(texts)
	// Plural forms may leave out {count}, e.g. "One file".
	const optional = isPlural(source) ? 'count' : undefined
	for (const param of expected.params) if (!actual.params.has(param) && param !== optional) problems.push(`is missing {${param}}`)
	for (const param of actual.params) if (!expected.params.has(param) && param !== optional) problems.push(`has an unknown {${param}}`)
	for (const tag of expected.tags) if (!actual.tags.has(tag)) problems.push(`is missing <${tag}>`)
	for (const tag of actual.tags) if (!expected.tags.has(tag)) problems.push(`has an unknown <${tag}>`)
	return problems
}

export interface LocaleFile {
	path: string
	messages: LocaleMessages
	/** The file's content as read, if it exists. */
	raw: string | undefined
}

export const readLocaleFile = (path: string): LocaleFile => {
	if (!existsSync(path)) return { path, messages: {}, raw: undefined }
	const raw = readFileSync(path, 'utf8')
	let messages: unknown
	try {
		messages = raw.trim() ? JSON.parse(raw) : {}
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`)
	}
	if (!isForms(messages)) throw new Error(`${path} must contain a JSON object of translations.`)
	return { path, messages, raw }
}

/** The file content for `messages`, in the existing file's indentation (two spaces for a new file). */
export const serialize = (file: LocaleFile, messages: LocaleMessages) =>
	`${JSON.stringify(messages, null, file.raw?.match(/^([ \t]+)"/m)?.[1] ?? '  ')}\n`

/** Write `messages` if they differ from the file. Returns whether it was written. */
export const writeLocaleFile = (file: LocaleFile, messages: LocaleMessages): boolean => {
	const content = serialize(file, messages)
	if (content === file.raw) return false
	mkdirSync(dirname(file.path), { recursive: true })
	writeFileSync(file.path, content)
	file.raw = content
	file.messages = messages
	return true
}

/**
 * Bring a locale's translations in line with the messages in the code, in the code's order. Translations are kept,
 * new messages get a placeholder to translate, and text no longer in the code is dropped unless `keepUnused`.
 */
export const syncMessages = (messages: ReadonlyMap<string, Message>, existing: LocaleMessages, locale: string, keepUnused = false) => {
	// A Map, then `fromEntries`, so a text like `__proto__` is data rather than a prototype.
	const synced = new Map<string, unknown>()
	let added = 0
	for (const [text, source] of messages) {
		const value = Object.hasOwn(existing, text) ? existing[text] : undefined
		// An untranslated entry follows the source's shape, e.g. when a message became a plural.
		const fits = isPlural(source) ? isForms(value) : typeof value === 'string'
		const keep = value !== undefined && (isTranslated(value) || fits)
		if (value === undefined) added++
		synced.set(text, keep ? value : placeholder(source, locale))
	}
	let removed = 0
	for (const [text, value] of Object.entries(existing)) {
		if (synced.has(text)) continue
		if (keepUnused) synced.set(text, value)
		else removed++
	}
	return { messages: Object.fromEntries(synced) as LocaleMessages, added, removed }
}
