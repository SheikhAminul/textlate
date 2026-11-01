import { TOKEN } from './message.js'
import type { UntranslatedInfo } from './types.js'

const ACCENTED: Record<string, string> = Object.fromEntries(
	[...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, [...'áƀçðéƒĝĥíĵķļɱñóþǫŕšţúṽŵẋýžÁƁÇÐÉƑĜĤÍĴĶĻṀÑÓÞǪŔŠŢÚṼŴẊÝŽ'][index]!])
)

/**
 * `text` as a pseudo-locale shows it: every letter accented, a third longer, in brackets — with its `{params}` and
 * `<tags>` as they are. Text that shows up plain in a pseudo-locale isn't translated; text cut off at a bracket doesn't
 * fit the longer words most languages have.
 *
 * @example
 * ```ts
 * pseudoLocalize('Hello, {name}!') // '[Ĥéļļó, {name}! ~~~]'
 * ```
 */
export const pseudoLocalize = (text: string): string => {
	let out = ''
	let last = 0
	let letters = 0
	const accent = (part: string) => {
		for (const character of part) {
			const accented = ACCENTED[character]
			if (accented) letters++
			out += accented ?? character
		}
	}
	for (const match of text.matchAll(TOKEN)) {
		accent(text.slice(last, match.index))
		out += match[0]
		last = match.index + match[0].length
	}
	accent(text.slice(last))
	// Most languages run 30–40% longer than English; short text, even more.
	const padding = Math.max(1, Math.ceil(letters * 0.35))
	return `[${out}${letters ? ` ${'~'.repeat(padding)}` : ''}]`
}

/**
 * A pseudo-locale for `createI18n`: every message that isn't translated into `locale` shows pseudo-localized. Register
 * the locale with no translations, and switch to it to find hard-coded text and layouts that break with longer words.
 *
 * @example
 * ```ts
 * const pseudo = pseudoLocale('en-XA')
 * export const i18n = createI18n({
 *   locales: { es: () => import('./locales/es.json'), [pseudo.locale]: {} },
 *   onUntranslated: pseudo.onUntranslated
 * })
 * ```
 */
export const pseudoLocale = <const L extends string = 'en-XA'>(locale: L = 'en-XA' as L) => ({
	locale,
	onUntranslated: (info: UntranslatedInfo): string | undefined => (info.locale === locale ? pseudoLocalize(info.text) : undefined)
})
