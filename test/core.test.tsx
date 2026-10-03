import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n, msg, storageDetector, type Message } from '../src/index.js'
import { createTestI18n, deferred, inbox } from './fixtures/i18n.js'

/** `translate` without type checks, for calls the types rightly reject. */
const loose = (t: unknown) => t as (message: Message, values?: Record<string, unknown>) => ReactNode
const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>)

afterEach(() => {
	vi.restoreAllMocks()
	localStorage.clear()
})

describe('createI18n', () => {
	it('exposes the source locale first, and starts on it', () => {
		const i18n = createTestI18n()
		expect(i18n.sourceLocale).toBe('en')
		expect(i18n.locales).toEqual(['en', 'ar', 'bn', 'bn-BD'])
		expect(i18n.locale).toBe('en')
		expect(i18n.dir).toBe('ltr')
		expect(i18n.isReady).toBe(true)
	})

	it('starts on the best match for `locale`', () => {
		expect(createTestI18n({ locale: 'ar-EG' }).locale).toBe('ar')
		expect(createTestI18n({ locale: 'fr' }).locale).toBe('en')
	})

	it('takes any source locale, and translations for it as overrides', () => {
		const i18n = createI18n({ sourceLocale: 'de', locales: { de: { Farbe: 'Farbe (neu)' }, en: { Farbe: 'Colour' } } })
		expect(i18n.locales).toEqual(['de', 'en'])
		expect(i18n.translate('Farbe')).toBe('Farbe (neu)')
		expect(i18n.scope('en').translate('Farbe')).toBe('Colour')
		expect(i18n.scope('en').translate('Andere')).toBe('Andere')
	})
})

describe('t', () => {
	const { translate } = createTestI18n()

	it('renders the text of the code in the source locale', () => {
		expect(translate('Plain text')).toBe('Plain text')
		expect(translate('Hello, {name}!', { name: 'Ada' })).toBe('Hello, Ada!')
		expect(translate('Version 1.2.3, see docs.example.com')).toBe('Version 1.2.3, see docs.example.com')
		expect(loose(translate)('Hello, {name}!')).toBe('Hello, {name}!')
	})

	it('translates into a loaded locale', async () => {
		const ar = createTestI18n().scope('ar')
		expect(ar.translate('Plain text')).toBe('نص عادي')
		expect(ar.translate('Hello, {name}!', { name: 'Ada' })).toBe('مرحبا، Ada!')
		expect(ar.dir).toBe('rtl')

		const bn = await createTestI18n().load('bn')
		expect(bn.translate('Welcome')).toBe('স্বাগতম')
	})

	it('formats number, bigint and date values for the locale', async () => {
		expect(translate('Total: {amount}', { amount: 1234567.5 })).toBe('Total: 1,234,567.5')
		expect(translate('Total: {amount}', { amount: 10n ** 12n })).toBe('Total: 1,000,000,000,000')
		expect(translate('Total: {amount}', { amount: new Date(Date.UTC(2026, 0, 15, 12)) })).toMatch(/^Total: 1\/15\/2026$/)

		const bn = await createTestI18n().load('bn')
		expect(bn.translate('Total: {amount}', { amount: 1234 })).toBe('মোট: ১,২৩৪')
	})

	it('renders -0 as 0', () => {
		expect(translate('Total: {amount}', { amount: -0 })).toBe('Total: 0')
	})

	it('picks plural forms with Intl.PluralRules, honouring `zero`', () => {
		expect(translate(inbox, { count: 0 })).toBe('No messages')
		expect(translate(inbox, { count: 1 })).toBe('You have 1 message')
		expect(translate(inbox, { count: 1000 })).toBe('You have 1,000 messages')
		expect(translate(inbox, { count: 1n })).toBe('You have 1 message')
		expect(loose(translate)(inbox)).toBe('You have {count} messages')

		const ar = createTestI18n().scope('ar')
		expect([0, 1, 2, 3, 11, 100].map(count => ar.translate(inbox, { count }))).toEqual(['لا رسائل', 'رسالة واحدة', 'رسالتان', '3 رسائل', '11 رسالة', '100 رسالة'])
	})

	it('tells apart the same text in different contexts', () => {
		const ar = createTestI18n().scope('ar')
		expect(ar.translate('Open')).toBe('افتح')
		expect(ar.translate({ text: 'Open', context: 'ticket status' })).toBe('مفتوحة')
		expect(ar.translate({ text: 'Open' })).toBe('افتح')
		expect(ar.translate({ text: 'Open', context: 'door' })).toBe('Open')
		expect(translate({ text: 'Open', context: 'ticket status' })).toBe('Open')
	})

	it('keeps a plural and a string with the same text apart until translated', () => {
		const i18n = createTestI18n()
		expect(i18n.translate('You have {count} messages', { count: 1 })).toBe('You have 1 messages')
		expect(i18n.translate(inbox, { count: 1 })).toBe('You have 1 message')
	})

	it('does not read translations from the object prototype', () => {
		const ar = createTestI18n().scope('ar')
		expect(ar.translate('constructor')).toBe('constructor')
		expect(ar.translate('toString')).toBe('toString')
	})

	it('stays exact past the cache limits', () => {
		const format = new Intl.NumberFormat('en')
		for (let n = 0; n < 1200; n++) {
			expect(translate('Total: {amount}', { amount: n + 0.25 })).toBe(`Total: ${format.format(n + 0.25)}`)
			expect(translate(inbox, { count: n })).toBe(n === 0 ? 'No messages' : `You have ${format.format(n)} message${n === 1 ? '' : 's'}`)
		}
		for (let n = 0; n < 10_050; n++) expect(translate(`Item ${n}`)).toBe(`Item ${n}`)
		expect(translate('Plain text')).toBe('Plain text')
	})

	it('gives each registered locale one stable scope, and unknown locales the source scope', () => {
		const i18n = createTestI18n()
		for (let n = 0; n < 1200; n++) i18n.scope(`xx-${n}`)
		expect(i18n.scope('ar')).toBe(i18n.scope('ar-SA'))
		expect(i18n.scope('ar').translate).toBe(i18n.scope('ar').translate)
		expect(i18n.scope('fr').locale).toBe('en')
		expect(i18n.scope('ar').translate('Plain text')).toBe('نص عادي')
	})
})

describe('rich text', () => {
	const { translate } = createTestI18n()
	const terms = 'Read the <link>terms</link> and <b>agree</b>.'

	it('renders tags with elements or functions', () => {
		expect(html(translate(terms, { link: <a href="/terms" />, b: chunks => <strong>{chunks}</strong> }))).toBe(
			'Read the <a href="/terms">terms</a> and <strong>agree</strong>.'
		)
		expect(html(translate('One<br/>Two', { br: <br /> }))).toBe('One<br/>Two')
	})

	it('renders translated rich text', async () => {
		const bn = await createTestI18n().load('bn')
		expect(html(bn.translate(terms, { link: <a href="/terms" />, b: <b /> }))).toBe('<a href="/terms">শর্তাবলী</a> পড়ুন এবং <b>সম্মত হন</b>।')
	})

	it('inserts React nodes as values', () => {
		expect(html(translate('Hello, {name}!', { name: <em>Ada</em> }))).toBe('Hello, <em>Ada</em>!')
	})

	it('returns a string, with tags stripped, when no value is an element', () => {
		expect(loose(translate)(terms)).toBe('Read the terms and agree.')
		expect(loose(translate)('One<br/>Two')).toBe('OneTwo')
		expect(translate('Total: {amount}', { amount: 1500 })).toBe('Total: 1,500')
	})

	it('supports nested tags and leaves malformed ones as text', () => {
		const b = <b />
		const i = <i />
		expect(html(translate('<b>bold <i>both</i></b>', { b, i }))).toBe('<b>bold <i>both</i></b>')
		expect(loose(translate)('a <b>b </i> c', { b, i })).toBe('a <b>b </i> c')
		expect(translate('x </b> 1 < 2')).toBe('x </b> 1 < 2')
	})

	it('parses whitespace and braces the way the types expect', () => {
		expect(html(translate('One<br />Two <b >bold</b >', { br: <br />, b: <b /> }))).toBe('One<br/>Two <b>bold</b>')
		expect(translate('Use {curly braces}, {} and a < b > c')).toBe('Use {curly braces}, {} and a < b > c')
		expect(translate('{{name}}', { name: 'x' })).toBe('{x}')
		expect(translate('<a href>x</a>')).toBe('<a href>x</a>')
		expect(html(translate('<a.b>x</a.b> <é>y</é> <h1>z</h1> <my-tag_2>w</my-tag_2>', { h1: <h1 />, 'my-tag_2': <i /> }))).toBe(
			'&lt;a.b&gt;x&lt;/a.b&gt; &lt;é&gt;y&lt;/é&gt; <h1>z</h1> <i>w</i>'
		)
	})

	it('renders the content of tags without a renderer, warning once', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(html(loose(translate)(terms, { link: <a /> }))).toBe('Read the <a>terms</a> and agree.')
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('No renderer for <b>'))
	})

	it('has no key warnings with multiple element children', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		html(translate(terms, { link: <a />, b: <b /> }))
		expect(error).not.toHaveBeenCalled()
	})
})

describe('untranslated text and fallbacks', () => {
	it('falls back through region, base language and the source text', async () => {
		const i18n = createTestI18n()
		await i18n.setLocale('bn-BD')
		expect(i18n.translate('Hello, {name}!', { name: 'A' })).toBe('হ্যালো (BD), A!')
		expect(i18n.translate('Welcome')).toBe('স্বাগতম')
		expect(i18n.translate('Only in English')).toBe('Only in English')
	})

	it('honours configured fallbacks before the base language', async () => {
		const i18n = createI18n({
			fallbacks: { 'pt-BR': ['pt-PT'] },
			locales: { pt: { a: 'pt', b: 'pt' }, 'pt-PT': { a: 'pt-PT' }, 'pt-BR': {} }
		})
		const { translate } = await i18n.load('pt-BR')
		expect([translate('a'), translate('b'), translate('c')]).toEqual(['pt-PT', 'pt', 'c'])
	})

	it('formats each text with the locale it is in', async () => {
		const { translate } = await createTestI18n().load('bn-BD')
		expect(translate('Total: {amount}', { amount: 1234 })).toBe('মোট: ১,২৩৪')
		expect(translate('Untranslated {amount}', { amount: 1234 })).toBe('Untranslated 1,234')
	})

	it('treats empty strings and plural forms as untranslated', () => {
		const i18n = createI18n({
			locale: 'pl',
			locales: { pl: { 'Not yet': '', '{count} files': { one: '{count} plik', few: '', other: '{count} plików' }, 'Empty': { other: '' } } }
		})
		const files = { one: '{count} file', other: '{count} files' }
		expect(i18n.translate('Not yet')).toBe('Not yet')
		expect(i18n.translate(files, { count: 1 })).toBe('1 plik')
		expect(i18n.translate(files, { count: 3 })).toBe('3 plików')
		expect(i18n.translate({ one: 'One', other: 'Empty' }, { count: 1 })).toBe('One')
	})

	it('reports untranslated text once per message and locale, never for the source locale', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const onUntranslated = vi.fn()
		const i18n = createTestI18n({ onUntranslated })
		const { translate } = await i18n.load('bn')
		expect(translate('Not translated')).toBe('Not translated')
		translate('Not translated')
		translate({ text: 'Open', context: 'door' })
		translate(inbox, { count: 2 })
		expect(onUntranslated.mock.calls.map(([info]) => info)).toEqual([
			{ text: 'Not translated', context: undefined, locale: 'bn' },
			{ text: 'Open', context: 'door', locale: 'bn' },
			{ text: 'You have {count} messages', context: undefined, locale: 'bn' }
		])
		i18n.translate('In the source locale')
		expect(onUntranslated).toHaveBeenCalledTimes(3)
		expect(warn).not.toHaveBeenCalled()
	})

	it('lets onUntranslated replace untranslated text', async () => {
		const { translate } = await createTestI18n({ onUntranslated: ({ text }) => `[${text}]` }).load('bn')
		expect(translate('Not translated')).toBe('[Not translated]')
		expect(translate('Welcome')).toBe('স্বাগতম')
	})

	it('fills the params of the text that onUntranslated returns', async () => {
		const { translate } = await createTestI18n({ onUntranslated: ({ text }) => `[${text}]` }).load('bn')
		expect(translate('Bye, {name}!', { name: 'Ada' })).toBe('[Bye, Ada!]')
	})

	it('reads params and tags from the values, never from Object.prototype', () => {
		const i18n = createI18n({ locales: {} })
		expect(i18n.translate('{constructor} and {toString}', {} as never)).toBe('{constructor} and {toString}')
		expect(html(loose(i18n.translate)('<toString>x</toString> <b>y</b>', { b: <i /> }))).toBe('x <i>y</i>')
		expect(i18n.translate('{constructor}', { constructor: 'own' } as never)).toBe('own')
	})

	it('keeps msg() messages unchanged', () => {
		const status = { text: 'Open', context: 'ticket status' } as const
		expect(msg('Active')).toBe('Active')
		expect(msg(inbox)).toBe(inbox)
		expect(msg(status)).toBe(status)
	})
})

describe('locale switching', () => {
	it('switches synchronously to a loaded locale and notifies subscribers', async () => {
		const i18n = createTestI18n()
		const listener = vi.fn()
		const unsubscribe = i18n.subscribe(listener)
		await i18n.setLocale('ar-SA')
		expect(i18n.locale).toBe('ar')
		expect(i18n.dir).toBe('rtl')
		expect(i18n.translate('Plain text')).toBe('نص عادي')
		expect(listener).toHaveBeenCalledTimes(1)

		await i18n.setLocale('ar')
		expect(listener).toHaveBeenCalledTimes(1)
		unsubscribe()
		await i18n.setLocale('en')
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('keeps the current locale while a lazy one loads', async () => {
		const bn = deferred<unknown>()
		const i18n = createTestI18n({ bn: () => bn.promise })
		const switching = i18n.setLocale('bn')
		expect(i18n.getSnapshot()).toEqual({ locale: 'en', pendingLocale: 'bn' })
		expect(i18n.translate('Plain text')).toBe('Plain text')

		bn.resolve({ default: { 'Plain text': 'সাধারণ লেখা' } })
		await switching
		expect(i18n.getSnapshot()).toEqual({ locale: 'bn', pendingLocale: undefined })
		expect(i18n.translate('Plain text')).toBe('সাধারণ লেখা')
	})

	it('lets the latest setLocale call win', async () => {
		const bn = deferred<unknown>()
		const i18n = createTestI18n({ bn: () => bn.promise })
		const slow = i18n.setLocale('bn')
		await i18n.setLocale('ar')
		bn.resolve({ 'Plain text': 'x' })
		await slow
		expect(i18n.locale).toBe('ar')
	})

	it('loads each locale once, even when requested concurrently', async () => {
		const loader = vi.fn(() => Promise.resolve({ 'Plain text': 'x' }))
		const i18n = createTestI18n({ bn: loader })
		await Promise.all([i18n.setLocale('bn'), i18n.load('bn-BD'), i18n.clone().load('bn')])
		expect(loader).toHaveBeenCalledTimes(1)
	})

	it('surfaces load errors, clears the pending state and allows a retry', async () => {
		let attempts = 0
		const i18n = createTestI18n({
			bn: () => (++attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ 'Plain text': 'ok' }))
		})
		await expect(i18n.setLocale('bn')).rejects.toThrow('offline')
		expect(i18n.getSnapshot()).toEqual({ locale: 'en', pendingLocale: undefined })

		await i18n.setLocale('bn')
		expect(i18n.translate('Plain text')).toBe('ok')
	})

	it('ignores unknown locales with a warning', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const i18n = createTestI18n()
		await i18n.setLocale('fr')
		expect(i18n.locale).toBe('en')
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('No registered locale matches "fr"'))
	})

	it('is not ready until a lazy initial locale is loaded', async () => {
		const i18n = createTestI18n({ locale: 'bn' })
		expect(i18n.locale).toBe('bn')
		expect(i18n.isReady).toBe(false)
		await i18n.ready
		expect(i18n.isReady).toBe(true)
		expect(i18n.translate('Welcome')).toBe('স্বাগতম')
	})
})

describe('detection', () => {
	it('uses the first detector with a registered match and persists choices', async () => {
		localStorage.setItem('locale', 'ar')
		const i18n = createTestI18n({
			detectors: [{ detect: () => 'fr' }, { detect: () => { throw new Error('boom') } }, storageDetector()]
		})
		await i18n.detect()
		expect(i18n.locale).toBe('ar')

		await i18n.setLocale('en')
		expect(localStorage.getItem('locale')).toBe('en')
	})

	it('does not persist a detected locale', async () => {
		const i18n = createTestI18n({ detectors: [storageDetector(), { detect: () => 'ar' }] })
		await i18n.detect()
		expect(i18n.locale).toBe('ar')
		expect(localStorage.getItem('locale')).toBeNull()
	})

	it('does nothing without a match', async () => {
		const i18n = createTestI18n({ detectors: [{ detect: () => null }] })
		await i18n.detect()
		expect(i18n.locale).toBe('en')
	})
})

describe('instances', () => {
	it('load() returns a locale scope without switching, defaulting to the active locale', async () => {
		const i18n = createTestI18n()
		const bn = await i18n.load('bn')
		expect(bn.locale).toBe('bn')
		expect(bn.translate('Plain text')).toBe('সাধারণ লেখা')
		expect(bn.format.number(1234)).toBe('১,২৩৪')
		expect(bn).toBe(i18n.scope('bn'))
		expect(i18n.locale).toBe('en')
		expect((await i18n.load('fr')).locale).toBe('en')
		expect((await i18n.load()).locale).toBe('en')
	})

	it('clones have their own locale but share loaded translations', async () => {
		const loader = vi.fn(() => import('./fixtures/bn.json'))
		const i18n = createTestI18n({ bn: loader })
		const a = i18n.clone({ locale: 'ar' })
		const b = i18n.clone({ locale: 'bn' })
		await b.ready
		expect([i18n.locale, a.locale, b.locale]).toEqual(['en', 'ar', 'bn'])

		await a.setLocale('bn')
		expect(a.translate('Plain text')).toBe('সাধারণ লেখা')
		expect(i18n.locale).toBe('en')
		expect(loader).toHaveBeenCalledTimes(1)
	})

	it('accepts translations added at runtime and unwraps module namespaces', async () => {
		const i18n = createTestI18n({ bn: () => Promise.reject(new Error('should not load')) })
		i18n.addTranslations('bn', { 'Plain text': 'added' })
		expect(i18n.getTranslations('bn')).toEqual({ 'Plain text': 'added' })
		expect((await i18n.load('bn')).translate('Plain text')).toBe('added')

		const json = createTestI18n({ bn: () => import('./fixtures/bn.json') })
		await json.load('bn')
		expect(json.getTranslations('bn')).toHaveProperty('Plain text', 'সাধারণ লেখা')
	})

	it('keeps translations added while a loader is in flight', async () => {
		const bn = deferred<unknown>()
		const i18n = createTestI18n({ bn: () => bn.promise })
		const loading = i18n.load('bn')
		i18n.addTranslations('bn', { 'Plain text': 'added' })
		bn.resolve({ default: { 'Plain text': 'loaded' } })
		await loading
		expect(i18n.getTranslations('bn')).toEqual({ 'Plain text': 'added' })
	})

	it('notifies subscribers when loaded translations are replaced, not when a locale is added', () => {
		const i18n = createTestI18n()
		const clone = i18n.clone()
		const listener = vi.fn()
		const cloneListener = vi.fn()
		const unsubscribe = i18n.subscribe(listener)
		const unsubscribeClone = clone.subscribe(cloneListener)

		i18n.addTranslations('bn', { 'Plain text': 'added' })
		expect(listener).not.toHaveBeenCalled()

		const before = i18n.getSnapshot()
		i18n.addTranslations('en', { 'Plain text': 'Replaced' })
		expect(listener).toHaveBeenCalledOnce()
		expect(cloneListener).toHaveBeenCalledOnce()
		expect(i18n.getSnapshot()).not.toBe(before)
		expect(i18n.getSnapshot()).toEqual(before)
		expect(i18n.translate('Plain text')).toBe('Replaced')

		unsubscribe()
		unsubscribeClone()
		i18n.addTranslations('en', { 'Plain text': 'Again' })
		expect(listener).toHaveBeenCalledOnce()
		expect(cloneListener).toHaveBeenCalledOnce()
	})

	it('never serves stale lookups after translations change', async () => {
		const i18n = createTestI18n()
		const bn = i18n.scope('bn')
		expect(bn.translate('Welcome')).toBe('Welcome')
		expect(bn.translate('Only in Bangla')).toBe('Only in Bangla')

		await i18n.load('bn')
		expect(bn.translate('Welcome')).toBe('স্বাগতম')

		i18n.addTranslations('bn', { 'Only in Bangla': 'শুধু বাংলা' })
		expect(bn.translate('Only in Bangla')).toBe('শুধু বাংলা')
		expect(bn.translate('Welcome')).toBe('Welcome')
	})

	it('formats with Intl for the active locale', async () => {
		const i18n = createTestI18n()
		expect(i18n.format.number(1234.5)).toBe('1,234.5')
		expect(i18n.format.number(0.25, { style: 'percent' })).toBe('25%')
		expect(i18n.format.list(['a', 'b', 'c'])).toBe('a, b, and c')
		expect(i18n.format.relativeTime(-1, 'day', { numeric: 'auto' })).toBe('yesterday')
		expect(i18n.format.displayName('bn', { type: 'language' })).toBe('Bangla')
		expect(i18n.format.date('2026-01-15T12:00:00Z', { timeZone: 'UTC', dateStyle: 'long' })).toBe('January 15, 2026')

		await i18n.setLocale('bn')
		expect(i18n.format.number(1234.5)).toBe('১,২৩৪.৫')
		expect(i18n.format).toBe(i18n.scope('bn').format)
	})
})
