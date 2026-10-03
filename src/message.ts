import { formatValue, pluralRules, reuse } from './format.js'
import type { Message, ParamValue, PluralCategory, PluralTranslation } from './types.js'

export type Node = string | { readonly param: string } | { readonly tag: string; readonly children: readonly Node[] }
/** A message ready to render: plain text as-is, anything with params or tags as a parsed tree. */
export type Compiled = string | readonly Node[]
type Frame = { tag: string; raw: string; children: Node[] }
type Values = Readonly<Record<string, unknown>> | undefined

/** `{param}`, `<tag>`, `</tag>`, `<tag/>`. The CLI checks translations with the same pattern. */
export const TOKEN = /\{([^{}\s]+)\}|<(\/?)([A-Za-z][\w-]*)\s*(\/?)>/g
const MARKUP = /[{<]/
export const PLURAL_CATEGORIES: readonly PluralCategory[] = ['zero', 'one', 'two', 'few', 'many', 'other']

/**
 * Where a message lives in a translation file: its text (a plural's `other` form), followed by ` // context` when it
 * has one, e.g. `"Open // ticket status"`.
 */
export const keyOf = (message: Message): string => {
	if (typeof message === 'string') return message
	const text = message.text ?? message.other!
	return message.context ? `${text} // ${message.context}` : text
}

/** A translation file's plural forms, e.g. `{ one: '{count} archivo', other: '{count} archivos' }`. */
export const isPluralTranslation = (value: unknown): value is PluralTranslation =>
	typeof value === 'object' && value !== null && Object.keys(value).every(key => (PLURAL_CATEGORIES as string[]).includes(key))

/** Parse a message into text, params and (possibly nested) tags. Malformed tags are kept as text. */
const parse = (message: string): readonly Node[] => {
	const root: Frame = { tag: '', raw: '', children: [] }
	const stack = [root]
	let top = root
	let last = 0
	for (const match of message.matchAll(TOKEN)) {
		const [raw, param, closing, tag = '', selfClosing] = match
		if (match.index > last) top.children.push(message.slice(last, match.index))
		last = match.index + raw.length

		if (param !== undefined) top.children.push({ param })
		else if (selfClosing) top.children.push({ tag, children: [] })
		else if (!closing) stack.push((top = { tag, raw, children: [] }))
		else if (top !== root && top.tag === tag) {
			const done = stack.pop()!
			top = stack.at(-1)!
			top.children.push({ tag, children: done.children })
		} else top.children.push(raw)
	}
	if (last < message.length) top.children.push(message.slice(last))
	// Unclosed tags are not markup: put them back as text.
	while (stack.length > 1) {
		const frame = stack.pop()!
		stack.at(-1)!.children.push(frame.raw, ...frame.children)
	}
	return root.children
}

// Trees are shared by every locale that renders the same text.
const parsed = new Map<string, readonly Node[]>()

/** Most messages are plain text: they skip parsing, and the memory for a tree, entirely. */
export const compile = (message: string): Compiled => (MARKUP.test(message) ? reuse(parsed, message, parse) : message)

export const isParamValue = (value: unknown): value is ParamValue =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Date

/** A param's or tag's value. Only the values' own properties count, so `{constructor}` and `<toString>` aren't read from `Object.prototype`. */
export const valueFor = (values: Values, name: string): unknown => (values && Object.hasOwn(values, name) ? values[name] : undefined)

/** Render to a string. Tags keep their text, which suits `aria-label`, `title` and `<title>`. */
export const renderString = (nodes: readonly Node[], locale: string, values: Values): string => {
	let out = ''
	for (const node of nodes) {
		if (typeof node === 'string') out += node
		else if ('param' in node) {
			const value = valueFor(values, node.param)
			out += value === undefined ? `{${node.param}}` : isParamValue(value) ? formatValue(locale, value) : String(value)
		} else out += renderString(node.children, locale, values)
	}
	return out
}

/**
 * The form to use for `count`. `zero` is honoured for 0 even where plural rules never pick it (e.g. English).
 * A missing or empty (not yet translated) form falls back to `other`.
 */
export const pluralCategory = (forms: PluralTranslation, locale: string, count: unknown): PluralCategory => {
	if (typeof count !== 'number' && typeof count !== 'bigint') return 'other'
	const n = Number(count)
	if (n === 0 && forms.zero) return 'zero'
	const category = pluralRules(locale)(n)
	return forms[category] ? category : 'other'
}
