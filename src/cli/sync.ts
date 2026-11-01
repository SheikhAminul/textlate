/// <reference types="node" />
import { createHash } from 'node:crypto'
import type { Message } from '../types.js'
import { isPlural, isTranslated, placeholder } from './catalog.js'

/**
 * Where a translation stands:
 * - `machine`: written by AI (or there before textlate kept track), not yet checked by a person;
 * - `reviewed`: edited by a person, or accepted with `textlate accept`;
 * - `changed`: the message's text changed since it was translated. The old translation stands in until
 *   `textlate translate` updates it.
 */
export type Status = 'machine' | 'reviewed' | 'changed'

export interface StateEntry {
	status: Status
	/** The translation's hash when textlate last wrote or accepted it: a different one means a person edited it. */
	hash?: string | undefined
	/** For `changed`: the key the translation was made for. */
	from?: string | undefined
}

/** A translation's fingerprint, to notice edits. Eight hex digits tell edits apart well enough. */
export const hashOf = (value: unknown): string => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 8)

/** A state file's entry, compact so the file stays small: `m:<hash>`, `r`, or `c:<hash>:<old key>`. */
export const encodeEntry = (entry: StateEntry): string =>
	entry.status === 'reviewed' ? 'r' : entry.status === 'machine' ? `m:${entry.hash ?? ''}` : `c:${entry.hash ?? ''}:${entry.from ?? ''}`

export const decodeEntry = (value: unknown): StateEntry | undefined => {
	if (typeof value !== 'string') return undefined
	if (value === 'r') return { status: 'reviewed' }
	if (value.startsWith('m:')) return { status: 'machine', hash: value.slice(2) }
	if (value.startsWith('c:')) {
		const end = value.indexOf(':', 2)
		return end < 0 ? undefined : { status: 'changed', hash: value.slice(2, end), from: value.slice(end + 1) }
	}
	return undefined
}

/** The state of a kept translation, given what was recorded for it. */
const stateFor = (value: unknown, recorded: StateEntry | undefined): StateEntry => {
	const hash = hashOf(value)
	// Translations from before textlate kept track count as unreviewed, so a review gate never passes them unseen.
	if (!recorded) return { status: 'machine', hash }
	if (recorded.status === 'reviewed') return recorded
	// Edited since textlate wrote it: a person's translation now.
	if (recorded.hash !== hash) return { status: 'reviewed' }
	return recorded
}

// ——— Telling alike text apart ———————————————————————————————————————————————————————————————————————————————

/** How alike two texts must be for one's translation to stand in for the other's: Dice's coefficient on bigrams. */
const ALIKE = 0.7
/** The most pairs compared: beyond it, text that changed is translated afresh rather than matched. */
const MAX_PAIRS = 4_000_000

const bigramsOf = (text: string): Map<string, number> => {
	const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
	const bigrams = new Map<string, number>()
	for (let index = 0; index < normalized.length - 1; index++) {
		const bigram = normalized.slice(index, index + 2)
		bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1)
	}
	return bigrams
}

const sizeOf = (bigrams: Map<string, number>) => {
	let size = 0
	for (const count of bigrams.values()) size += count
	return size
}

/** Dice's coefficient: 1 for the same text, 0 for nothing in common. */
export const similarity = (a: string, b: string): number => {
	if (a === b) return 1
	const left = bigramsOf(a)
	const right = bigramsOf(b)
	const total = sizeOf(left) + sizeOf(right)
	if (!total) return 0
	let shared = 0
	for (const [bigram, count] of left) shared += Math.min(count, right.get(bigram) ?? 0)
	return (2 * shared) / total
}

/**
 * For each new message, the removed one whose translation can stand in for its own: alike text, the same shape (text
 * or plural forms). Each removed message stands in at most once, the most alike pairs first.
 */
export const matchChanged = (
	added: readonly [key: string, source: Message][],
	removed: readonly [key: string, translation: unknown][]
): Map<string, string> => {
	const matches = new Map<string, string>()
	if (!added.length || !removed.length || added.length * removed.length > MAX_PAIRS) return matches
	const old = removed.map(([key, translation]) => ({ key, translation, bigrams: bigramsOf(key), length: key.length }))
	const pairs: { from: string; to: string; score: number }[] = []
	for (const [key, source] of added) {
		const bigrams = bigramsOf(key)
		const size = sizeOf(bigrams)
		for (const candidate of old) {
			// The same shape: a plural's forms can't stand in for text, nor text for forms.
			if (isPlural(source) !== (typeof candidate.translation === 'object')) continue
			const ratio = Math.min(key.length, candidate.length) / Math.max(key.length, candidate.length, 1)
			if (ratio < 0.5) continue
			const total = size + sizeOf(candidate.bigrams)
			if (!total) continue
			let shared = 0
			for (const [bigram, count] of bigrams) shared += Math.min(count, candidate.bigrams.get(bigram) ?? 0)
			const score = (2 * shared) / total
			if (score >= ALIKE) pairs.push({ from: candidate.key, to: key, score })
		}
	}
	pairs.sort((a, b) => b.score - a.score)
	const used = new Set<string>()
	for (const { from, to } of pairs) {
		if (matches.has(to) || used.has(from)) continue
		matches.set(to, from)
		used.add(from)
	}
	return matches
}

// ——— Bringing a locale in line with the code ————————————————————————————————————————————————————————————————

export interface SyncOptions {
	keepUnused?: boolean | undefined
	/** Let alike translations stand in for messages whose text changed. Default `true`. */
	carryOver?: boolean | undefined
}

export interface SyncResult {
	/** Each message's translation (or `''` placeholder), by key, in the code's order; then kept unused ones. */
	values: Map<string, unknown>
	/** The state of each translated message. */
	state: Map<string, StateEntry>
	/** Messages new to this locale. */
	added: number
	/** Translations dropped because their text is no longer in the code. */
	removed: number
	/** Messages whose text changed, started from the old text's translation. */
	carried: number
	/** Keys of translations kept though their text is no longer in the code. */
	unused: string[]
}

/**
 * Bring a locale's translations in line with the messages in the code. Translations are kept, new messages get a
 * placeholder to translate — or, when their text is like that of a message no longer in the code, its translation,
 * marked `changed` — and text no longer in the code is dropped unless `keepUnused`.
 */
export const syncLocale = (
	messages: ReadonlyMap<string, Message>,
	existing: ReadonlyMap<string, unknown>,
	recorded: ReadonlyMap<string, StateEntry>,
	locale: string,
	options: SyncOptions = {}
): SyncResult => {
	const values = new Map<string, unknown>()
	const state = new Map<string, StateEntry>()
	const pending: [string, Message][] = []
	let added = 0
	for (const [key, source] of messages) {
		const value = existing.get(key)
		if (value === undefined) added++
		if (value !== undefined && isTranslated(value)) {
			values.set(key, value)
			const entry = recorded.get(key)
			// A translation standing in for changed text stays `changed` until it's updated — or a person edits it.
			state.set(key, entry?.status === 'changed' ? (entry.hash === hashOf(value) ? entry : { status: 'reviewed' }) : stateFor(value, entry))
			continue
		}
		// An untranslated entry follows the source's shape, e.g. when a message became a plural.
		const fits = value !== undefined && (isPlural(source) ? typeof value === 'object' && value !== null : typeof value === 'string')
		values.set(key, fits ? value : placeholder(source, locale))
		pending.push([key, source])
	}

	const leftOver = [...existing].filter(([key]) => !messages.has(key))
	let carried = 0
	if (options.carryOver !== false) {
		const translated = leftOver.filter(([, value]) => isTranslated(value))
		for (const [to, from] of matchChanged(pending, translated)) {
			const translation = existing.get(from)
			values.set(to, translation)
			state.set(to, { status: 'changed', hash: hashOf(translation), from })
			carried++
		}
	}

	const unused: string[] = []
	let removed = 0
	for (const [key, value] of leftOver) {
		if (!options.keepUnused) {
			removed++
			continue
		}
		values.set(key, value)
		unused.push(key)
		if (isTranslated(value)) state.set(key, stateFor(value, recorded.get(key)))
	}
	return { values, state, added, removed, carried, unused }
}

/** The text a key stands for, without the ` // context` the message it's matched with also has. */
export const textOfKey = (key: string, context: string | undefined): string =>
	context && key.endsWith(` // ${context}`) ? key.slice(0, -` // ${context}`.length) : key
