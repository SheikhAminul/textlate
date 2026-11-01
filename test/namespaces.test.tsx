import { act, cleanup, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n, type Translations } from '../src/index.js'
import { I18nProvider, useI18n, useNamespaces } from '../src/react.js'
import { deferred } from './fixtures/i18n.js'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

const files: Record<string, Translations> = {
	'es/app': { Save: 'Guardar', 'Hello, {name}!': '¡Hola, {name}!' },
	'es/catalog': { 'Send a message': 'Enviar un mensaje', Save: 'Guardar (catálogo)' },
	'es-MX/app': { Save: 'Salvar' },
	'es-MX/catalog': {},
	'de/app': { Save: 'Speichern' },
	'de/catalog': { 'Send a message': 'Nachricht senden' }
}

/** An app with its translations split into an `app` namespace, loaded everywhere, and a `catalog` one. */
const createApp = (loader = vi.fn((locale: string, namespace: string) => Promise.resolve({ default: files[`${locale}/${namespace}`] ?? {} }))) => ({
	loader,
	i18n: createI18n({ locales: ['es', 'es-MX', 'de'], namespaces: ['app'], loader })
})

describe('namespaces', () => {
	it('needs a loader for a list of locales', () => {
		expect(() => createI18n({ locales: ['es'] })).toThrow(/needs a `loader`/)
	})

	it('loads the default namespaces, and others when asked, with their fallbacks — never the source locale', async () => {
		const { i18n, loader } = createApp()
		expect(i18n.locales).toEqual(['en', 'es', 'es-MX', 'de'])
		expect(i18n.namespaces).toEqual(['app'])

		const app = await i18n.load('es-MX')
		expect(app.translate('Save')).toBe('Salvar')
		expect(app.translate('Hello, {name}!', { name: 'Ada' })).toBe('¡Hola, Ada!') // from es
		expect(app.translate('Send a message')).toBe('Send a message') // catalog isn't loaded
		expect(loader.mock.calls).toEqual([
			['es-MX', 'app'],
			['es', 'app']
		])

		expect(i18n.isLoaded('es-MX', ['catalog'])).toBe(false)
		const both = await i18n.load('es-MX', { namespaces: ['app', 'catalog'] })
		expect(both.translate('Send a message')).toBe('Enviar un mensaje')
		// A message in two namespaces takes the translation of the one loaded first.
		expect(both.translate('Save')).toBe('Salvar')
		expect(i18n.isLoaded('es-MX', ['app', 'catalog'])).toBe(true)
		expect(loader).toHaveBeenCalledTimes(4)
	})

	it('loads each file once, however many ask at the same time', async () => {
		const { i18n, loader } = createApp()
		await Promise.all([i18n.load('es'), i18n.load('es'), i18n.load('es-MX'), i18n.getMessages('es')])
		expect(loader.mock.calls.filter(([locale]) => locale === 'es')).toEqual([['es', 'app']])
	})

	it('hands the server\'s translations to another instance by locale and namespace', async () => {
		const server = createApp()
		const messages = await server.i18n.getMessages('es-MX', ['app', 'catalog'])
		expect(Object.keys(messages)).toEqual(['es-MX', 'es'])
		expect(messages['es']).toEqual({ app: files['es/app'], catalog: files['es/catalog'] })

		const browser = createApp()
		browser.i18n.addMessages(messages)
		expect(browser.i18n.isLoaded('es-MX', ['app', 'catalog'])).toBe(true)
		expect(browser.i18n.scope('es-MX').translate('Send a message')).toBe('Enviar un mensaje')
		expect(browser.loader).not.toHaveBeenCalled()
		// Parts of a namespace add up — a layout's messages, then a page's — and the same object is added once.
		const page = { es: { app: { Close: 'Cerrar' } } }
		browser.i18n.addMessages(page)
		browser.i18n.addMessages(page)
		expect(browser.i18n.scope('es').translate('Close')).toBe('Cerrar')
		expect(browser.i18n.scope('es').translate('Save')).toBe('Guardar')
	})

	it('switches locale with every namespace the current one has loaded', async () => {
		const { i18n } = createApp()
		await i18n.load('es', { namespaces: ['catalog'] })
		await i18n.setLocale('es')
		await i18n.setLocale('de')
		expect(i18n.translate('Send a message')).toBe('Nachricht senden')
		expect(i18n.isLoaded('de', ['app', 'catalog'])).toBe(true)
	})

	it('re-renders subscribers when a namespace finishes loading', async () => {
		const { i18n } = createApp()
		await i18n.setLocale('es')
		const listener = vi.fn()
		i18n.subscribe(listener)
		await i18n.load('es', { namespaces: ['catalog'] })
		expect(listener).toHaveBeenCalled()
	})

	it('keeps an app with one file per locale working, with `default` as its namespace', async () => {
		const i18n = createI18n({ locales: { es: { Save: 'Guardar' }, de: () => Promise.resolve({ default: { Save: 'Speichern' } }) } })
		expect(i18n.namespaces).toEqual(['default'])
		expect(await i18n.getMessages('es')).toEqual({ es: { default: { Save: 'Guardar' } } })
		expect(await i18n.getMessages('de')).toEqual({ de: { default: { Save: 'Speichern' } } })
	})

	it('combines one file per locale with a loader for further namespaces', async () => {
		const loader = vi.fn((locale: string, namespace: string) => Promise.resolve(namespace === 'help' ? { Help: `Ayuda (${locale})` } : {}))
		const i18n = createI18n({ locales: { es: { Save: 'Guardar' } }, loader })
		const es = await i18n.load('es', { namespaces: ['default', 'help'] })
		expect([es.translate('Save'), es.translate('Help')]).toEqual(['Guardar', 'Ayuda (es)'])
		expect(loader.mock.calls).toEqual([['es', 'help']])
	})
})

describe('a catalog of any size', () => {
	it('stays resolved however many messages it has, while text it lacks starts the memo over', () => {
		const es: Record<string, string> = {}
		for (let n = 0; n < 12_000; n++) es[`Item ${n}`] = `Elemento ${n}`
		const onUntranslated = vi.fn()
		const translate = createI18n({ locales: { es }, onUntranslated }).scope('es').translate
		for (let n = 0; n < 12_000; n++) expect(translate(`Item ${n}`)).toBe(`Elemento ${n}`)
		for (let n = 0; n < 12_000; n++) translate(`Item ${n}`)
		expect(onUntranslated).not.toHaveBeenCalled()
		for (let n = 0; n < 5_001; n++) translate(`Missing ${n}`)
		expect(translate('Item 7')).toBe('Elemento 7')
	})
})

describe('time zones', () => {
	const date = new Date(Date.UTC(2026, 0, 15, 23, 30))

	it('renders dates in the instance\'s time zone, or a scope\'s own', async () => {
		const i18n = createI18n({ locales: { de: { 'Due {date}': 'Fällig am {date}' } }, timeZone: 'Asia/Tokyo' })
		expect(i18n.timeZone).toBe('Asia/Tokyo')
		expect(i18n.translate('Due {date}', { date })).toBe('Due 1/16/2026')
		expect(i18n.format.date(date, { timeStyle: 'short' })).toBe('8:30 AM')
		expect(i18n.format.date(date, { timeStyle: 'short', timeZone: 'UTC' })).toBe('11:30 PM')

		const berlin = await i18n.load('de', { timeZone: 'Europe/Berlin' })
		expect(berlin.timeZone).toBe('Europe/Berlin')
		expect(berlin.translate('Due {date}', { date })).toBe('Fällig am 16.1.2026')
		expect(i18n.scope('de', { timeZone: 'America/New_York' }).translate('Due {date}', { date })).toBe('Fällig am 15.1.2026')
		expect(i18n.clone({ timeZone: 'America/New_York' }).format.date(date)).toBe('1/15/2026')
	})
})

describe('React', () => {
	const Catalog = () => {
		useNamespaces(['catalog'])
		const { translate } = useI18n()
		return <p data-testid="catalog">{translate('Send a message')}</p>
	}

	it('suspends a subtree until its namespaces are loaded', async () => {
		const catalog = deferred<{ default: Translations }>()
		const { i18n } = createApp(vi.fn((locale: string, namespace: string) => (namespace === 'catalog' ? catalog.promise : Promise.resolve({ default: files[`${locale}/${namespace}`] ?? {} }))))
		await i18n.setLocale('de')
		await act(async () => {
			render(
				<I18nProvider i18n={i18n} detect={false}>
					<Suspense fallback={<p data-testid="catalog">loading</p>}>
						<Catalog />
					</Suspense>
				</I18nProvider>
			)
		})
		expect(screen.getByTestId('catalog').textContent).toBe('loading')
		await act(async () => catalog.resolve({ default: files['de/catalog']! }))
		expect((await screen.findByText('Nachricht senden')).dataset['testid']).toBe('catalog')
	})

	it('renders with the server\'s messages at once, loading nothing', async () => {
		const server = createApp()
		const messages = await server.i18n.getMessages('de', ['app', 'catalog'])
		const browser = createApp()
		const html = renderToStaticMarkup(
			<I18nProvider i18n={browser.i18n} locale="de" messages={messages} timeZone="UTC">
				<Catalog />
			</I18nProvider>
		)
		expect(html).toBe('<p data-testid="catalog">Nachricht senden</p>')
		expect(browser.loader).not.toHaveBeenCalled()
	})

	it('pins the time zone with the provider', () => {
		const Due = () => {
			const { translate, timeZone } = useI18n()
			return <p>{`${timeZone} ${translate('Due {date}', { date: new Date(Date.UTC(2026, 0, 15, 23, 30)) })}`}</p>
		}
		const i18n = createI18n({ locales: {} })
		expect(renderToStaticMarkup(<I18nProvider i18n={i18n} timeZone="Asia/Tokyo"><Due /></I18nProvider>)).toBe('<p>Asia/Tokyo Due 1/16/2026</p>')
	})
})
