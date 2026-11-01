/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PLURAL_CATEGORIES, TOKEN } from '../message.js'
import type { GlossaryTerm } from '../config.js'
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
export const checkTranslation = (
	source: Message,
	translation: unknown,
	locale: string,
	glossary?: Readonly<Record<string, GlossaryTerm>> | undefined
): string[] => {
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
	// Terms to keep must come through as they're written, in every form that has them.
	for (const [term, rule] of Object.entries(glossary ?? {})) {
		if (!rule.keep || !sourceTexts(source).some(text => text.includes(term))) continue
		if (!texts.some(text => typeof text === 'string' && text.includes(term))) problems.push(`should keep "${term}" as it is`)
	}
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

/**
 * Write `content` to `path` all at once: to a file beside it, then renamed over it. A run that stops halfway (Ctrl-C,
 * a crash, a full disk) leaves the old file or the new one, never half of one.
 */
export const writeAtomic = (path: string, content: string) => {
	mkdirSync(dirname(path), { recursive: true })
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
	try {
		writeFileSync(temporary, content)
		renameSync(temporary, path)
	} catch (error) {
		rmSync(temporary, { force: true })
		throw error
	}
}

/** Write `messages` if they differ from the file. Returns whether it was written. */
export const writeLocaleFile = (file: LocaleFile, messages: LocaleMessages): boolean => {
	const content = serialize(file, messages)
	if (content === file.raw) return false
	writeAtomic(file.path, content)
	file.raw = content
	file.messages = messages
	return true
}
