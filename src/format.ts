import type { Formatter, ParamValue } from './types.js'

// Intl constructors are slow, so instances are reused: per locale for the default options used by
// interpolation (no key building on the hot path), and per locale + options for explicit formatting.
const defaults = {
	number: new Map<string, (value: number | bigint) => string>(),
	date: new Map<string, Intl.DateTimeFormat>(),
	plural: new Map<string, (count: number) => Intl.LDMLPluralRule>()
}
const withOptions = new Map<string, unknown>()

/**
 * Get or create a cached value. Every cache is capped, so unbounded input (arbitrary locales, options or numbers,
 * e.g. from requests on a server) can't grow memory forever. A full cache starts over rather than refusing new
 * entries, so values in use are always cached again, e.g. a registered locale's translator after junk locales.
 */
export const reuse = <K, V>(cache: Map<K, V>, key: K, create: (key: K) => V, limit = 500): V => {
	let value = cache.get(key)
	if (value === undefined) {
		if (cache.size >= limit) cache.clear()
		cache.set(key, (value = create(key)))
	}
	return value
}

/** `Intl` calls cost hundreds of nanoseconds and counts repeat, so default-option results are remembered. */
const memo = <K, V>(create: (key: K) => V) => {
	const cache = new Map<K, V>()
	return (key: K) => reuse(cache, key, create)
}

const configured = <T>(kind: string, locale: string, options: object, create: () => T): T =>
	reuse(withOptions as Map<string, T>, `${kind}\0${locale}\0${JSON.stringify(options)}`, create)

const dateFormat = (locale: string, options?: Intl.DateTimeFormatOptions) =>
	options
		? configured('date', locale, options, () => new Intl.DateTimeFormat(locale, options))
		: reuse(defaults.date, locale, () => new Intl.DateTimeFormat(locale))

/** Options with the scope's time zone, unless they name their own. */
const zoned = (options: Intl.DateTimeFormatOptions | undefined, timeZone: string | undefined) =>
	timeZone && !options?.timeZone ? { ...options, timeZone } : options

/** The plural category of `count` in `locale`, memoized. */
export const pluralRules = (locale: string) =>
	reuse(defaults.plural, locale, () => {
		const rules = new Intl.PluralRules(locale)
		return memo((count: number) => rules.select(count))
	})

/** Formats with default options, memoized. -0 shares 0's cache key, so it always renders as "0". */
const formatNumber = (locale: string) =>
	reuse(defaults.number, locale, () => {
		const format = new Intl.NumberFormat(locale)
		return memo((value: number | bigint) => format.format(value === 0 ? 0 : value))
	})

/**
 * A param's text: numbers and bigints with the locale's digits and separators, dates with its default date format,
 * in `timeZone` when one is given (so a server renders the same date as the browser it's sent to).
 */
export const formatValue = (locale: string, value: ParamValue, timeZone?: string): string =>
	typeof value === 'string'
		? value
		: value instanceof Date
			? dateFormat(locale, zoned(undefined, timeZone)).format(value)
			: formatNumber(locale)(value)

export const createFormatter = (locale: string, timeZone?: string): Formatter => ({
	locale,
	number: (value, options) =>
		options ? configured('number', locale, options, () => new Intl.NumberFormat(locale, options)).format(value) : formatNumber(locale)(value),
	date: (value, options) => dateFormat(locale, zoned(options, timeZone)).format(typeof value === 'string' ? new Date(value) : value),
	relativeTime: (value, unit, options = {}) =>
		configured('relative', locale, options, () => new Intl.RelativeTimeFormat(locale, options)).format(value, unit),
	list: (items, options = {}) => configured('list', locale, options, () => new Intl.ListFormat(locale, options)).format(items),
	displayName: (code, options) => configured('display', locale, options, () => new Intl.DisplayNames(locale, options)).of(code)
})
