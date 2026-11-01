import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashKey } from '../src/hash.js'
import { createI18n, matchLocale, negotiateLocale } from '../src/index.js'
import { createGetLocale, createProxy, createSeo } from '../src/next.js'
import { createLink } from '../src/next-link.js'
import { I18nProvider, Time } from '../src/react.js'
import { defineRouting } from '../src/routing.js'
import type { Metadata } from 'next'
import type { Meta } from '../src/types.js'

afterEach(() => vi.restoreAllMocks())

const FSI = '⁨'
const PDI = '⁩'

describe('renamed language codes', () => {
	it('match today\'s codes, both ways', () => {
		expect(matchLocale('iw', ['en', 'he'])).toBe('he')
		expect(matchLocale('he-IL', ['en', 'iw'])).toBe('iw')
		expect(matchLocale('no', ['en', 'nb'])).toBe('nb')
		expect(matchLocale('nb-NO', ['en', 'no'])).toBe('no')
		expect(matchLocale(['in-ID'], ['id', 'en'])).toBe('id')
		expect(matchLocale('tl', ['fil', 'en'])).toBe('fil')
		expect(matchLocale('sh-RS', ['sr-Latn', 'sr-Cyrl'])).toBe('sr-Latn')
		expect(negotiateLocale('iw-IL,en;q=0.5', ['en', 'he'], 'en')).toBe('he')
	})
})

describe('bidi isolation', () => {
	const he = { '{name} was saved.': '{name} נשמר.', 'Read <b>{name}</b>': 'קרא <b>{name}</b>' }

	it('sets values apart in right-to-left locales, and only there by default', () => {
		const i18n = createI18n({ locales: { he } })
		expect(i18n.scope('he').translate('{name} was saved.', { name: 'Slack v2!' })).toBe(`${FSI}Slack v2!${PDI} נשמר.`)
		expect(i18n.scope('he').translate('{name} was saved.', { name: 3 })).toBe(`${FSI}3${PDI} נשמר.`)
		expect(i18n.translate('{name} was saved.', { name: 'Slack' })).toBe('Slack was saved.')
		expect(renderToStaticMarkup(<>{i18n.scope('he').translate('Read <b>{name}</b>', { b: <b /> , name: 'Slack' })}</>)).toBe(`קרא <b>${FSI}Slack${PDI}</b>`)
	})
})

describe('memory', () => {
	it('keeps resolved messages within a budget shared by every locale, letting idle ones go', () => {
		const onUntranslated = vi.fn()
		const i18n = createI18n({ locales: { es: {}, de: {} }, memoLimit: 4, onUntranslated })
		const es = i18n.scope('es').translate
		const de = i18n.scope('de').translate
		es('Idle')
		es('Idle')
		expect(onUntranslated).toHaveBeenCalledTimes(1)
		// German fills the budget twice over: Spanish, idle meanwhile, lets go of what it had.
		for (let n = 0; n < 9; n++) de(`Busy ${n}`)
		es('Idle')
		expect(onUntranslated.mock.calls.filter(([info]) => info.locale === 'es')).toHaveLength(2)
		// Messages used again are carried over to the next generation.
		for (let n = 0; n < 3; n++) de('Hot')
		expect(onUntranslated.mock.calls.filter(([info]) => info.text === 'Hot')).toHaveLength(1)
	})

	it('unloads the least recently used locales beyond maxLocales, and loads them again when asked', async () => {
		const loader = vi.fn((locale: string) => Promise.resolve({ Save: `Save (${locale})` }))
		const i18n = createI18n({ locales: ['es', 'de', 'fr'], loader, maxLocales: 2 })
		await i18n.load('es')
		await i18n.load('de')
		await i18n.load('fr')
		expect(i18n.isLoaded('es')).toBe(false)
		expect(i18n.isLoaded('fr')).toBe(true)
		expect((await i18n.load('es')).translate('Save')).toBe('Save (es)')
		expect(loader.mock.calls.map(([locale]) => locale)).toEqual(['es', 'de', 'fr', 'es'])
		i18n.unload('es')
		expect(i18n.isLoaded('es')).toBe(false)
	})
})

describe('what the browser receives', () => {
	it('picks only the messages asked for, translated ones only', async () => {
		const i18n = createI18n({ locales: { es: { Save: 'Guardar', Cancel: 'Cancelar', Later: '' } } })
		expect(await i18n.getMessages('es', undefined, { only: ['Save', 'Later', 'Missing'] })).toEqual({ es: { default: { Save: 'Guardar' } } })
	})

	it('reads compiled catalogs keyed by short hashes', async () => {
		const i18n = createI18n({ keys: 'hashed', locales: { es: { [hashKey('Save')]: 'Guardar', [hashKey('{count} files')]: { one: '{count} archivo', other: '{count} archivos' } } } })
		const es = i18n.scope('es')
		expect(es.translate('Save')).toBe('Guardar')
		expect(es.translate({ one: '{count} file', other: '{count} files' }, { count: 2 })).toBe('2 archivos')
		expect(es.translate('Not there')).toBe('Not there')
		expect(await i18n.getMessages('es', undefined, { only: ['Save'] })).toEqual({ es: { default: { [hashKey('Save')]: 'Guardar' } } })
		expect(hashKey('Save')).toMatch(/^[\da-z]{6,11}$/)
	})
})

describe('formatting that hydrates', () => {
	const now = Date.UTC(2026, 10, 1, 12)

	it('writes relative times in the unit that fits, from a given now', () => {
		const { format } = createI18n({ locales: {} })
		expect(format.relative(now - 5 * 60_000, { now })).toBe('5 minutes ago')
		expect(format.relative(now - 86_400_000, { now })).toBe('yesterday')
		expect(format.relative(now + 90 * 86_400_000, { now })).toBe('in 3 months')
		expect(format.relative(now, { now })).toBe('now')
	})

	it('writes the same no-break space whatever the engine uses', () => {
		const { format } = createI18n({ locales: { fr: {} } }).scope('fr')
		const written = format.number(1234567)
		expect(written).not.toContain(' ')
		expect(written.replace(/\D/g, '')).toBe('1234567')
	})

	it('renders <Time> with its machine-readable date, and a relative time from the server\'s now', () => {
		const i18n = createI18n({ locales: {} })
		const html = renderToStaticMarkup(
			<I18nProvider i18n={i18n} timeZone="UTC" now={now}>
				<Time value={new Date(now - 3 * 3_600_000)} relative className="ago" />
				<Time value={now} format={{ dateStyle: 'medium' }} />
			</I18nProvider>
		)
		expect(html).toBe('<time class="ago" dateTime="2026-11-01T09:00:00.000Z">3 hours ago</time><time dateTime="2026-11-01T12:00:00.000Z">Nov 1, 2026</time>')
	})
})

describe('routing', () => {
	const routing = defineRouting({ locales: ['en', 'de', 'zh-Hant'], defaultLocale: 'en', origin: 'https://tareai.com/', hreflang: { 'zh-Hant': 'zh-TW' } })

	it('reads and writes locales in addresses, the default locale without a prefix', () => {
		expect(routing.localeOf('/de/pricing')).toBe('de')
		expect(routing.localeOf('/ZH-HANT/x')).toBe('zh-Hant')
		expect(routing.localeOf('/pricing')).toBeUndefined()
		expect(routing.pathnameOf('/de/pricing')).toBe('/pricing')
		expect(routing.pathnameOf('/de')).toBe('/')
		expect(routing.path('de', '/pricing?plan=pro#faq')).toBe('/de/pricing?plan=pro#faq')
		expect(routing.path('en', '/de/pricing')).toBe('/pricing')
		expect(routing.path('de', '/')).toBe('/de')
		expect(routing.url('zh-Hant', '/')).toBe('https://tareai.com/zh-Hant')
		expect(routing.hreflangOf('zh-Hant')).toBe('zh-TW')
		expect(['en', 'de', 'zh-Hant'].map(locale => routing.openGraphLocaleOf(locale as 'en'))).toEqual(['en_US', 'de_DE', 'zh_TW'])
		expect(defineRouting({ locales: ['en', 'de'], defaultLocale: 'en', origin: 'https://x.com', prefix: 'always' }).path('en', '/a')).toBe('/en/a')
	})
})

describe('SEO', () => {
	const routing = defineRouting({ locales: ['en', 'de', 'ja', 'ar'], defaultLocale: 'en', origin: 'https://tareai.com' })
	const entry = (messages: number, translated: number, reviewed: number, updated: string) => ({ messages, translated, reviewed, updated })
	const meta: Meta = {
		de: { app: entry(100, 100, 40, '2026-10-20T00:00:00.000Z'), catalog: entry(100, 95, 0, '2026-10-25T00:00:00.000Z') },
		ja: { app: entry(100, 100, 100, '2026-09-01T00:00:00.000Z'), catalog: entry(100, 20, 0, '2026-09-02T00:00:00.000Z') },
		ar: { app: entry(100, 50, 0, '2026-08-01T00:00:00.000Z'), catalog: entry(100, 50, 0, '2026-08-01T00:00:00.000Z') }
	}
	const seo = createSeo(routing, { meta, minCoverage: 0.9 })

	it('indexes a locale only where enough of the page is translated', () => {
		expect(seo.coverage('de')).toBe(0.975)
		expect(seo.indexed()).toEqual(['en', 'de'])
		expect(seo.indexed({ namespaces: ['app'] })).toEqual(['en', 'de', 'ja'])
		expect(createSeo(routing, { meta, minCoverage: 0.9, reviewed: true }).indexed({ namespaces: ['app'] })).toEqual(['en', 'ja'])
		expect(seo.indexed({ locales: ['en', 'ja'], namespaces: ['app'] })).toEqual(['en', 'ja'])
	})

	it('gives each page its own canonical address, hreflang links with x-default, and Open Graph locales', () => {
		expect(seo.metadata('de', '/integrations/slack', { namespaces: ['app'] })).toEqual({
			alternates: {
				canonical: 'https://tareai.com/de/integrations/slack',
				languages: {
					en: 'https://tareai.com/integrations/slack',
					de: 'https://tareai.com/de/integrations/slack',
					ja: 'https://tareai.com/ja/integrations/slack',
					'x-default': 'https://tareai.com/integrations/slack'
				}
			},
			openGraph: { locale: 'de_DE', alternateLocale: ['en_US', 'ja_JP'] }
		})
	})

	it('keeps a mostly untranslated page out of the index, and out of the others\' links', () => {
		const page = seo.metadata('ar', '/pricing')
		// It merges into what generateMetadata returns.
		const merged: Metadata = { ...page, title: 'Pricing', openGraph: { ...page.openGraph, title: 'Pricing' } }
		expect(merged.robots).toEqual({ index: false, follow: true })
		expect(page.robots).toEqual({ index: false, follow: true })
		expect(page.alternates.canonical).toBe('https://tareai.com/ar/pricing')
		expect(Object.keys(page.alternates.languages)).toEqual(['en', 'de', 'x-default'])
	})

	it('lists every indexed locale of every page in the sitemap, dated by the later change', () => {
		const sitemap = seo.sitemap([{ pathname: '/pricing', lastModified: '2026-10-22T00:00:00.000Z', changeFrequency: 'weekly', priority: 0.8 }])
		expect(sitemap.map(({ url, lastModified }) => [url, (lastModified as Date).toISOString()])).toEqual([
			['https://tareai.com/pricing', '2026-10-22T00:00:00.000Z'],
			['https://tareai.com/de/pricing', '2026-10-25T00:00:00.000Z']
		])
		expect(sitemap[0]).toMatchObject({ changeFrequency: 'weekly', priority: 0.8, alternates: { languages: { en: 'https://tareai.com/pricing', de: 'https://tareai.com/de/pricing', 'x-default': 'https://tareai.com/pricing' } } })
	})
})

describe('proxy', async () => {
	const { NextRequest } = await import('next/server')
	const request = (url: string, headers: Record<string, string> = {}) => new NextRequest(url, { headers })
	const asNeeded = createProxy(defineRouting({ locales: ['en', 'de', 'ja'], defaultLocale: 'en', origin: 'https://tareai.com' }))
	const always = createProxy(defineRouting({ locales: ['en', 'de', 'ja'], defaultLocale: 'en', origin: 'https://tareai.com', prefix: 'always' }))

	it('serves an address with a locale as it is, never redirecting it by language', () => {
		const response = asNeeded(request('https://tareai.com/de/pricing', { 'accept-language': 'ja', cookie: 'NEXT_LOCALE=ja' }))!
		expect(response.headers.get('x-middleware-next')).toBe('1')
	})

	it('gives each page one address: the default locale without its prefix, codes in their own case', () => {
		const response = asNeeded(request('https://tareai.com/en/pricing?plan=pro'))!
		expect([response.status, response.headers.get('location')]).toEqual([308, 'https://tareai.com/pricing?plan=pro'])
		expect(asNeeded(request('https://tareai.com/DE/pricing'))!.headers.get('location')).toBe('https://tareai.com/de/pricing')
	})

	it('serves an address without one as the default locale, unless the visitor chose another', () => {
		expect(asNeeded(request('https://tareai.com/pricing', { 'accept-language': 'de' }))!.headers.get('x-middleware-rewrite')).toBe('https://tareai.com/en/pricing')
		const chosen = asNeeded(request('https://tareai.com/pricing', { cookie: 'NEXT_LOCALE=de' }))!
		expect([chosen.status, chosen.headers.get('location'), chosen.headers.get('vary')]).toEqual([307, 'https://tareai.com/de/pricing', 'Cookie'])
	})

	it('with a prefix always, sends an address without one to the visitor\'s language', () => {
		const response = always(request('https://tareai.com/pricing', { 'accept-language': 'ja,en;q=0.5' }))!
		expect([response.status, response.headers.get('location'), response.headers.get('cache-control')]).toEqual([307, 'https://tareai.com/ja/pricing', 'private, no-store'])
	})

	it('leaves files and API routes alone', () => {
		expect(asNeeded(request('https://tareai.com/favicon.ico'))).toBeUndefined()
		expect(asNeeded(request('https://tareai.com/api/v1/runs'))).toBeUndefined()
	})
})

describe('Next.js helpers', () => {
	const routing = defineRouting({ locales: ['en', 'de', 'ja'], defaultLocale: 'en', origin: 'https://tareai.com' })

	it('reads the locale from a root parameter, and finds nothing for an address that isn\'t one', async () => {
		expect(await createGetLocale(routing, async () => 'de')()).toBe('de')
		await expect(createGetLocale(routing, async () => 'xx')()).rejects.toThrow()
	})

	it('links within the visitor\'s locale, and to another one for a language switcher', () => {
		const Link = createLink(routing)
		const i18n = createI18n({ locales: { de: {}, ja: {} } })
		const html = renderToStaticMarkup(
			<I18nProvider i18n={i18n} locale="de">
				<Link href="/pricing">Preise</Link>
				<Link href="/pricing" locale="ja">日本語</Link>
				<Link href="https://example.com/x">Extern</Link>
			</I18nProvider>
		)
		expect(html).toBe('<a href="/de/pricing">Preise</a><a hrefLang="ja" lang="ja" href="/ja/pricing">日本語</a><a href="https://example.com/x">Extern</a>')
	})
})
