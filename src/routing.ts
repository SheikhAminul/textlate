/**
 * Localized URLs: a prefix per language (`/fr/pricing`), none for the default (`/pricing`), and the `hreflang`
 * alternates and canonical URL search engines need. Framework-free and server-safe: for a proxy, a sitemap, metadata
 * and links alike.
 */

export interface RoutingConfig<L extends string = string> {
	/** Every locale with URLs, the default included. */
	locales: readonly L[]
	/** The locale whose URLs have no prefix. */
	defaultLocale: L
}

export interface Alternates {
	/** This page's own URL, in the language shown. */
	canonical: string
	/** Each language's URL, and `x-default`: the one for everyone else. Next.js `metadata.alternates.languages`. */
	languages: Record<string, string>
}

export interface Routing<L extends string = string> {
	readonly locales: readonly L[]
	readonly defaultLocale: L
	/** `'/pricing'` in `'fr'` → `'/fr/pricing'`; in the default locale, `'/pricing'`. Keeps `?query` and `#hash`. */
	localize: (path: string, locale: string) => string
	/** `'/fr/pricing'` → `{ locale: 'fr', path: '/pricing' }`; `'/pricing'` → `{ locale: undefined, path: '/pricing' }`. */
	split: (path: string) => { locale: L | undefined; path: string }
	/** The locale a path segment names, in its configured spelling: `'pt-br'` → `'pt-BR'`. */
	match: (segment: string | undefined) => L | undefined
	/**
	 * A page's canonical URL and `hreflang` alternates. List only the languages the page is really in (`available`):
	 * pointing search engines at an untranslated copy splits its ranking. A locale not available falls back to the
	 * default's URL as canonical. With `origin`, the URLs are absolute, as search engines prefer.
	 */
	alternates: (path: string, options: { locale: string; available?: readonly string[] | undefined; origin?: string | undefined }) => Alternates
}

/**
 * @example
 * ```ts
 * const routing = createRouting({ locales: ['en', 'fr', 'ja'], defaultLocale: 'en' })
 * routing.localize('/pricing', 'fr')  // '/fr/pricing'
 * routing.split('/ja/pricing')        // { locale: 'ja', path: '/pricing' }
 * routing.alternates('/pricing', { locale: 'fr', origin: 'https://example.com' })
 * // { canonical: 'https://example.com/fr/pricing',
 * //   languages: { en: '…/pricing', fr: '…/fr/pricing', ja: '…/ja/pricing', 'x-default': '…/pricing' } }
 * ```
 */
export const createRouting = <const L extends string>(config: RoutingConfig<L>): Routing<L> => {
	const { locales, defaultLocale } = config
	if (!locales.includes(defaultLocale)) throw new Error(`[textlate] The default locale "${defaultLocale}" must be one of the locales.`)
	const byLowerCase = new Map(locales.map(locale => [locale.toLowerCase(), locale]))
	const match = (segment: string | undefined) => (segment ? byLowerCase.get(segment.toLowerCase()) : undefined)

	const localize = (path: string, locale: string) => {
		const target = match(locale) ?? defaultLocale
		const at = path.search(/[?#]/)
		const [pathname, rest] = at === -1 ? [path, ''] : [path.slice(0, at), path.slice(at)]
		const clean = pathname.startsWith('/') ? pathname : `/${pathname}`
		if (target === defaultLocale) return clean + rest
		return `/${target}${clean === '/' ? '' : clean}${rest}`
	}

	const split = (path: string) => {
		const [, first, remainder = ''] = /^\/([^/?#]+)(.*)$/.exec(path) ?? []
		const locale = match(first)
		if (!locale) return { locale: undefined, path: path || '/' }
		return { locale, path: remainder.startsWith('/') ? remainder : `/${remainder}` }
	}

	const alternates = (path: string, options: { locale: string; available?: readonly string[] | undefined; origin?: string | undefined }) => {
		const origin = options.origin?.replace(/\/+$/, '') ?? ''
		const available = locales.filter(locale => locale === defaultLocale || !options.available || options.available.some(entry => match(entry) === locale))
		const url = (locale: string) => origin + localize(path, locale)
		const shown = match(options.locale)
		const languages: Record<string, string> = Object.fromEntries(available.map(locale => [locale, url(locale)]))
		languages['x-default'] = url(defaultLocale)
		return { canonical: url(shown && available.includes(shown) ? shown : defaultLocale), languages }
	}

	return { locales, defaultLocale, localize, split, match, alternates }
}
