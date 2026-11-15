import { describe, expect, it } from 'vitest'
import { createRouting } from '../src/index.js'

const routing = createRouting({ locales: ['en', 'fr', 'ja', 'pt-BR'], defaultLocale: 'en' })

describe('createRouting', () => {
	it('prefixes every language but the default, keeping the query and hash', () => {
		expect(routing.localize('/pricing', 'fr')).toBe('/fr/pricing')
		expect(routing.localize('/', 'fr')).toBe('/fr')
		expect(routing.localize('/', 'en')).toBe('/')
		expect(routing.localize('/pricing?plan=pro#faq', 'ja')).toBe('/ja/pricing?plan=pro#faq')
		expect(routing.localize('/?ref=x', 'fr')).toBe('/fr?ref=x')
		expect(routing.localize('pricing', 'pt-br')).toBe('/pt-BR/pricing')
		expect(routing.localize('/pricing', 'xx')).toBe('/pricing')
	})

	it('splits a path into its language and the rest', () => {
		expect(routing.split('/fr/pricing')).toEqual({ locale: 'fr', path: '/pricing' })
		expect(routing.split('/fr')).toEqual({ locale: 'fr', path: '/' })
		expect(routing.split('/fr?x=1')).toEqual({ locale: 'fr', path: '/?x=1' })
		expect(routing.split('/PT-br/a/b')).toEqual({ locale: 'pt-BR', path: '/a/b' })
		expect(routing.split('/en/pricing')).toEqual({ locale: 'en', path: '/pricing' })
		expect(routing.split('/pricing')).toEqual({ locale: undefined, path: '/pricing' })
		expect(routing.split('/france')).toEqual({ locale: undefined, path: '/france' })
		expect(routing.split('/')).toEqual({ locale: undefined, path: '/' })
	})

	it('lists hreflang alternates only for the languages a page is in, with x-default', () => {
		expect(routing.alternates('/pricing', { locale: 'fr', available: ['fr', 'ja'], origin: 'https://example.com/' })).toEqual({
			canonical: 'https://example.com/fr/pricing',
			languages: { en: 'https://example.com/pricing', fr: 'https://example.com/fr/pricing', ja: 'https://example.com/ja/pricing', 'x-default': 'https://example.com/pricing' }
		})
		// Shown in a language it isn't translated into: the canonical is the default's.
		expect(routing.alternates('/terms', { locale: 'fr', available: [] })).toEqual({ canonical: '/terms', languages: { en: '/terms', 'x-default': '/terms' } })
		expect(Object.keys(routing.alternates('/', { locale: 'en' }).languages)).toEqual(['en', 'fr', 'ja', 'pt-BR', 'x-default'])
	})

	it('needs the default among the locales', () => {
		expect(() => createRouting({ locales: ['fr'], defaultLocale: 'en' as 'fr' })).toThrow('must be one of the locales')
	})
})
