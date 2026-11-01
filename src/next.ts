/**
 * Next.js App Router, on the server: what search engines need to find each page in each language (hreflang links,
 * canonical addresses, Open Graph locales, sitemaps), pages with too little translated kept out of their index, the
 * proxy that puts visitors on the right locale, and the locale from a root parameter.
 */
import type { MetadataRoute } from 'next'
import { notFound } from 'next/navigation'
import { NextResponse, type NextRequest } from 'next/server'
import { negotiateLocale } from './locale.js'
import type { Routing } from './routing.js'
import type { Meta } from './types.js'

export { defineRouting, type Routing, type RoutingConfig } from './routing.js'

export interface SeoOptions<L extends string> {
	/** Each locale's coverage and last change, as `textlate` writes it: `import meta from './locales/.textlate/meta.json'`. */
	meta?: Meta | undefined
	/**
	 * The share of a page's messages (0–1) a locale needs translated for the page to be indexed. Below it, the page is
	 * `noindex`, and left out of every page's hreflang links and of the sitemap, so search engines never see a page that is
	 * mostly the source language. Default `0`: every locale is indexed.
	 */
	minCoverage?: number | undefined
	/** Count only translations a person reviewed towards `minCoverage`. Default `false`. */
	reviewed?: boolean | undefined
	/** The namespaces whose coverage counts for every page, unless a page names its own. Default: every namespace. */
	namespaces?: readonly string[] | undefined
}

export interface PageOptions<L extends string> {
	/** The namespaces this page shows, for its coverage. Default: the SEO options'. */
	namespaces?: readonly string[] | undefined
	/** The locales the page exists in, when not all of them do (e.g. a blog post written in two). */
	locales?: readonly L[] | undefined
}

export interface SitemapEntry<L extends string> extends PageOptions<L> {
	/** The page's address without a locale, e.g. `/integrations/slack`. */
	pathname: string
	/** When the page's content last changed. Each locale's date is the later of it and its translations' last change. */
	lastModified?: Date | string | undefined
	changeFrequency?: MetadataRoute.Sitemap[number]['changeFrequency']
	priority?: number | undefined
	images?: string[] | undefined
}

/** What a page's `generateMetadata` merges in: canonical and hreflang links, Open Graph locales, and robots when it isn't indexed. */
export interface SeoMetadata {
	alternates: { canonical: string; languages: Record<string, string> }
	openGraph: { locale: string; alternateLocale: string[] }
	robots?: { index: false; follow: true }
}

/**
 * What search engines need, for every page in every locale.
 *
 * @example
 * ```ts
 * // src/i18n/seo.ts
 * import meta from '@/locales/.textlate/meta.json'
 * export const seo = createSeo(routing, { meta, minCoverage: 0.9 })
 *
 * // app/[lang]/integrations/[app]/page.tsx
 * export const generateMetadata = async ({ params }) => {
 *   const { lang, app } = await params
 *   const page = seo.metadata(lang, `/integrations/${app}`)
 *   return { ...page, title: …, openGraph: { ...page.openGraph, title: … } }
 * }
 *
 * // app/sitemap.ts
 * export default () => seo.sitemap(apps.map(app => ({ pathname: `/integrations/${app.slug}` })))
 * ```
 */
export const createSeo = <L extends string>(routing: Routing<L>, options: SeoOptions<L> = {}) => {
	const { meta, minCoverage = 0, reviewed = false } = options

	/** The share of the namespaces' messages a locale has translated (or reviewed): 1 for the default locale, or without meta. */
	const coverage = (locale: L, namespaces = options.namespaces): number => {
		if (locale === routing.defaultLocale || !meta) return 1
		const entries = Object.entries(meta[locale] ?? {}).filter(([name]) => !namespaces || namespaces.includes(name))
		const total = entries.reduce((sum, [, entry]) => sum + entry.messages, 0)
		if (!total) return meta[locale] ? 1 : 0
		return entries.reduce((sum, [, entry]) => sum + (reviewed ? entry.reviewed : entry.translated), 0) / total
	}
	const isIndexed = (locale: L, page: PageOptions<L> = {}) =>
		(!page.locales || page.locales.includes(locale)) && coverage(locale, page.namespaces ?? options.namespaces) >= minCoverage
	/** The locales a page is indexed in. */
	const indexed = (page: PageOptions<L> = {}) => routing.locales.filter(locale => isIndexed(locale, page))
	/** When a locale's translations (of the namespaces) last changed. */
	const updated = (locale: L, namespaces = options.namespaces): Date | undefined => {
		const dates = Object.entries(meta?.[locale] ?? {})
			.filter(([name]) => !namespaces || namespaces.includes(name))
			.map(([, entry]) => Date.parse(entry.updated))
			.filter(Number.isFinite)
		return dates.length ? new Date(Math.max(...dates)) : undefined
	}

	/** hreflang links for every indexed locale, and `x-default` for visitors whose language has none. */
	const languages = (pathname: string, locales: readonly L[]) => {
		const links: Record<string, string> = {}
		for (const locale of locales) links[routing.hreflangOf(locale)] = routing.url(locale, pathname)
		// `x-default`: the address that serves whoever matches no locale — the unprefixed one, which the proxy sends on
		// (`always`), or the default locale's page (`as-needed`).
		links['x-default'] = routing.prefix === 'always' ? routing.origin + routing.pathnameOf(pathname) : routing.url(routing.defaultLocale, pathname)
		return links
	}

	return {
		coverage,
		indexed,
		isIndexed,
		/**
		 * Metadata for a page in a locale: its canonical address (itself — never another locale's), hreflang links to the
		 * indexed locales, Open Graph locales, and `noindex` when its locale isn't indexed. Merge it into what the page returns.
		 */
		metadata: (locale: L, pathname: string, page: PageOptions<L> = {}): SeoMetadata => {
			const locales = indexed(page)
			return {
				alternates: { canonical: routing.url(locale, pathname), languages: languages(pathname, locales) },
				openGraph: {
					locale: routing.openGraphLocaleOf(locale),
					alternateLocale: locales.filter(other => other !== locale).map(routing.openGraphLocaleOf)
				},
				...(!locales.includes(locale) && { robots: { index: false, follow: true } })
			}
		},
		/**
		 * Sitemap entries: one per page and indexed locale, each listing the others as alternates, dated by the later of the
		 * page's change and its locale's translations'. Return them from `app/sitemap.ts` (split with `generateSitemaps` past
		 * 50,000).
		 */
		sitemap: (entries: readonly SitemapEntry<L>[]): MetadataRoute.Sitemap =>
			entries.flatMap(entry => {
				const locales = indexed(entry)
				const alternates = { languages: languages(entry.pathname, locales) }
				return locales.map(locale => {
					const content = entry.lastModified === undefined ? undefined : new Date(entry.lastModified)
					const translations = locale === routing.defaultLocale ? undefined : updated(locale, entry.namespaces ?? options.namespaces)
					const lastModified = content && translations ? (content > translations ? content : translations) : (content ?? translations)
					return {
						url: routing.url(locale, entry.pathname),
						...(lastModified && { lastModified }),
						...(entry.changeFrequency && { changeFrequency: entry.changeFrequency }),
						...(entry.priority !== undefined && { priority: entry.priority }),
						...(entry.images && { images: entry.images }),
						alternates
					}
				})
			})
	}
}

export interface ProxyOptions {
	/** The cookie a visitor's choice of language is kept in. Default `'NEXT_LOCALE'`. */
	cookie?: string | undefined
}

const SKIP = /^\/(?:_next|api)(?:\/|$)|\/[^/]*\.[^/]+$/

/**
 * A `proxy.ts` that puts every request on its locale, the way search engines expect:
 * - an address with a locale is served as it is — never redirected by language, so crawlers see every page;
 * - with `prefix: 'as-needed'`, an address without one is the default locale's page (rewritten to it), unless the
 *   visitor chose another language before (the cookie), and `/en/…` redirects to `/…`, its one address;
 * - with `prefix: 'always'`, an address without one redirects to the visitor's choice, or their browser's language.
 *
 * @example
 * ```ts
 * // src/proxy.ts
 * export const proxy = createProxy(routing)
 * export const config = { matcher: ['/((?!_next|api|.*\\..*).*)'] }
 * ```
 */
export const createProxy = <L extends string>(routing: Routing<L>, options: ProxyOptions = {}) => {
	const cookie = options.cookie ?? 'NEXT_LOCALE'
	return (request: NextRequest): NextResponse | undefined => {
		const { pathname, search } = request.nextUrl
		if (SKIP.test(pathname)) return undefined
		const at = (target: string) => new URL(target + search, request.url)
		const locale = routing.localeOf(pathname)
		if (locale) {
			const canonical = routing.path(locale, pathname)
			// One address per page: `/en/pricing` is `/pricing` with `as-needed`; `/DE/…` is `/de/…`.
			if (canonical !== pathname) return NextResponse.redirect(at(canonical), 308)
			return NextResponse.next()
		}
		const chosen = routing.locales.find(candidate => candidate === request.cookies.get(cookie)?.value)
		if (routing.prefix === 'as-needed') {
			if (chosen && chosen !== routing.defaultLocale) return withVary(NextResponse.redirect(at(routing.path(chosen, pathname)), 307), 'Cookie')
			return NextResponse.rewrite(at(`/${routing.defaultLocale}${pathname === '/' ? '' : pathname}`))
		}
		const preferred = chosen ?? negotiateLocale(request.headers.get('accept-language'), routing.locales, routing.defaultLocale)
		return withVary(NextResponse.redirect(at(routing.path(preferred, pathname)), 307), 'Cookie, Accept-Language')
	}
}

/** A redirect that depends on the visitor must say so, so caches keep one per visitor rather than serve it to everyone. */
const withVary = (response: NextResponse, vary: string) => {
	response.headers.set('Vary', vary)
	response.headers.set('Cache-Control', 'private, no-store')
	return response
}

/**
 * The locale of the current route, from a root parameter getter (`import { lang } from 'next/root-params'`): any Server
 * Component can ask for it without props being passed down. An address whose locale isn't one is not found.
 *
 * @example
 * ```ts
 * import { lang } from 'next/root-params'
 * export const getLocale = createGetLocale(routing, lang)
 *
 * // anywhere on the server
 * const { translate } = await i18n.load(await getLocale())
 * ```
 */
export const createGetLocale =
	<L extends string>(routing: Routing<L>, param: () => Promise<string | undefined>) =>
	async (): Promise<L> => {
		const value = await param()
		const locale = routing.locales.find(candidate => candidate === value)
		if (!locale) notFound()
		return locale
	}
