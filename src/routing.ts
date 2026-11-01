/**
 * Locales in addresses: which locale an address is in, and the same page's address in another. Plain functions with no
 * framework in them, so the server, the proxy and client components share one definition.
 */

export interface RoutingConfig<L extends string> {
	/** The locales with pages, e.g. `i18n.locales`. */
	locales: readonly L[]
	/** The locale of addresses without one (with `prefix: 'as-needed'`), and the one `x-default` points to. */
	defaultLocale: L
	/** The site's origin, e.g. `'https://tareai.com'`: search engines want whole addresses in hreflang links and sitemaps. */
	origin: string
	/**
	 * `'as-needed'` (the default): the default locale's pages have no prefix (`/pricing`, `/de/pricing`), so addresses
	 * already indexed keep their place. `'always'`: every page has one (`/en/pricing`), and `/pricing` redirects.
	 */
	prefix?: 'as-needed' | 'always' | undefined
	/** hreflang codes for locales whose code isn't one, e.g. `{ 'zh-Hant': 'zh-TW' }`. Default: the locale codes. */
	hreflang?: Partial<Record<L, string>> | undefined
}

export interface Routing<L extends string = string> {
	readonly locales: readonly L[]
	readonly defaultLocale: L
	readonly origin: string
	readonly prefix: 'as-needed' | 'always'
	/** The locale an address starts with: `/de/pricing` → `'de'`; `undefined` when it has none. */
	localeOf(pathname: string): L | undefined
	/** An address without its locale: `/de/pricing` → `/pricing`. */
	pathnameOf(pathname: string): string
	/** The page's address in a locale: `path('de', '/pricing')` → `/de/pricing`. A locale already in it is replaced. */
	path(locale: L, href: string): string
	/** The page's whole address in a locale, with the origin. */
	url(locale: L, href: string): string
	/** The hreflang code of a locale. */
	hreflangOf(locale: L): string
	/** The Open Graph locale of a locale, `language_TERRITORY`: `de` → `de_DE`, `zh-Hant` → `zh_TW`. */
	openGraphLocaleOf(locale: L): string
}

/**
 * Define how locales appear in addresses. Import the result anywhere: it holds no secrets and no server code.
 *
 * @example
 * ```ts
 * export const routing = defineRouting({ locales: i18n.locales, defaultLocale: 'en', origin: 'https://tareai.com' })
 * routing.path('de', '/integrations/slack') // '/de/integrations/slack'
 * ```
 */
export const defineRouting = <const L extends string>(config: RoutingConfig<L>): Routing<L> => {
	const { locales, defaultLocale } = config
	const prefix = config.prefix ?? 'as-needed'
	const origin = config.origin.replace(/\/+$/, '')
	const byLowerCase = new Map(locales.map(locale => [locale.toLowerCase(), locale]))
	const split = (href: string) => {
		const at = href.search(/[?#]/)
		return at < 0 ? [href, ''] : [href.slice(0, at), href.slice(at)]
	}
	const localeOf = (pathname: string) => byLowerCase.get((pathname.split('/')[1] ?? '').toLowerCase())
	const pathnameOf = (pathname: string) => {
		const locale = localeOf(pathname)
		const rest = locale ? pathname.slice(locale.length + 1) : pathname
		// One leading slash: `//evil.com` (or `/\evil.com`) would be read as another site's address.
		return `/${rest.replace(/^[/\\]+/, '')}`
	}
	const path = (locale: L, href: string) => {
		const [pathname, rest] = split(href)
		const bare = pathnameOf(pathname!)
		if (prefix === 'as-needed' && locale === defaultLocale) return bare + rest
		return `/${locale}${bare === '/' ? '' : bare}${rest}`
	}
	const openGraph = new Map<string, string>()
	return {
		locales,
		defaultLocale,
		origin,
		prefix,
		localeOf,
		pathnameOf,
		path,
		url: (locale, href) => origin + path(locale, href),
		hreflangOf: locale => config.hreflang?.[locale] ?? locale,
		openGraphLocaleOf: locale => {
			let found = openGraph.get(locale)
			if (!found) {
				// The language's likeliest territory fills in what the code leaves out: de → de-Latn-DE.
				try {
					const { language, region } = new Intl.Locale(locale).maximize()
					found = region ? `${language}_${region}` : language
				} catch {
					found = locale.replace('-', '_')
				}
				openGraph.set(locale, found)
			}
			return found
		}
	}
}
