import { createFormatter, reuse } from './format.js'
import { getDirection, matchLocale } from './locale.js'
import { compile, isPluralTranslation, keyOf, pluralCategory, renderString, type Compiled } from './message.js'
import { isRich, renderRich, toNode } from './rich.js'
import type {
	I18n,
	I18nSnapshot,
	LocaleDetector,
	Message,
	PluralCategory,
	PluralTranslation,
	Scope,
	Translate,
	TranslationSource,
	Translations,
	UntranslatedInfo
} from './types.js'

declare const process: { env: { NODE_ENV?: string } }
const isDev = (() => {
	try {
		return process.env.NODE_ENV !== 'production'
	} catch {
		return false
	}
})()

export interface I18nConfig<Locales extends Record<string, TranslationSource>, S extends string> {
	/** The language the text in your code is written in. It needs no translations. Default `'en'`. */
	sourceLocale?: S | undefined
	/** Translations per locale: an object, or a loader such as `() => import('./locales/es.json')`. */
	locales: Locales
	/** The initial locale (best match). Defaults to the source locale. */
	locale?: string | undefined
	/** Extra fallbacks per locale, tried before the base language and the source text. E.g. `{ 'pt-BR': ['pt-PT'] }`. */
	fallbacks?: { readonly [K in keyof Locales]?: readonly (keyof Locales & string)[] } | undefined
	/** Where `detect()` looks for a preferred locale, in order. Detectors with `persist` remember `setLocale` choices. */
	detectors?: readonly LocaleDetector[] | undefined
	/**
	 * Called once per message and locale that isn't translated yet, e.g. to log it. Return a string to show instead of
	 * the source text.
	 */
	onUntranslated?: ((info: UntranslatedInfo) => string | void) | undefined
}

interface Shared {
	readonly config: I18nConfig<Record<string, TranslationSource>, string>
	readonly sourceLocale: string
	readonly locales: readonly string[]
	readonly translations: Map<string, Translations>
	readonly loading: Map<string, Promise<void>>
	readonly chains: Map<string, readonly string[]>
	readonly scopes: Map<string, Scope>
	readonly warned: Set<string>
	/** Instances with subscribers, re-rendered when loaded translations are replaced. */
	readonly subscribed: Set<() => void>
	/** Bumped whenever translations change, invalidating the scopes' memos. */
	version: number
}

/** A resolved message: the locale it renders in, and its text compiled once (plural forms on first use). */
type Entry =
	| { readonly locale: string; readonly message: Compiled; readonly plural?: undefined }
	| { readonly locale: string; readonly plural: PluralTranslation; readonly forms: { [C in PluralCategory]?: Compiled } }

type Values = Readonly<Record<string, unknown>> | undefined

const warnOnce = (shared: Shared, id: string, message: string) => {
	if (!isDev || shared.warned.has(id)) return
	shared.warned.add(id)
	console.warn(`[textlate] ${message}`)
}

/**
 * `locale`, its configured fallbacks, its base language, then the source locale (whose translations, if it has any,
 * override the text in the code). The text in the code comes last.
 */
const chainOf = (shared: Shared, locale: string): readonly string[] =>
	reuse(shared.chains, locale, () => {
		const base = locale.split('-')[0]!.toLowerCase()
		const baseLocale = shared.locales.find(candidate => candidate.toLowerCase() === base)
		return [...new Set([locale, ...(shared.config.fallbacks?.[locale] ?? []), ...(baseLocale ? [baseLocale] : []), shared.sourceLocale])]
	})

const isLoaded = (shared: Shared, locale: string) => chainOf(shared, locale).every(entry => shared.translations.has(entry))

const setTranslations = (shared: Shared, locale: string, translations: Translations) => {
	// Only a replacement can change what is on screen: a locale renders once its whole chain is loaded.
	// Adding a new locale (as I18nProvider does while rendering) must not notify, or it would update other components mid-render.
	const replaced = shared.translations.has(locale)
	shared.translations.set(locale, translations)
	shared.version++
	if (replaced) for (const refresh of [...shared.subscribed]) refresh()
}

/** Accepts `import('./es.json')` namespaces as well as plain objects. */
const unwrapModule = (module: unknown): Translations => {
	const value = module as { default?: unknown; __esModule?: unknown; [Symbol.toStringTag]?: unknown }
	const isNamespace = value[Symbol.toStringTag] === 'Module' || value.__esModule === true || Object.keys(value).join() === 'default'
	return (isNamespace && typeof value.default === 'object' && value.default ? value.default : value) as Translations
}

const loadOne = (shared: Shared, locale: string): Promise<void> => {
	let pending = shared.loading.get(locale)
	if (!pending) {
		const source = shared.config.locales[locale] as () => Promise<unknown>
		pending = Promise.resolve()
			.then(source)
			.then(module => {
				// Translations added while loading (e.g. sent from the server) win over the loader's.
				if (!shared.translations.has(locale)) setTranslations(shared, locale, unwrapModule(module))
			})
			.finally(() => shared.loading.delete(locale))
		shared.loading.set(locale, pending)
	}
	return pending
}

const RESOLVED = Promise.resolve()

const load = (shared: Shared, locale: string): Promise<void> => {
	const missing = chainOf(shared, locale).filter(entry => !shared.translations.has(entry))
	return missing.length ? Promise.all(missing.map(entry => loadOne(shared, entry))).then(() => {}) : RESOLVED
}

/** The translation of `key` in `locale` or its fallbacks. `""` and plurals without `other` aren't translated yet. */
const lookup = (shared: Shared, locale: string, key: string): Entry | undefined => {
	for (const entry of chainOf(shared, locale)) {
		const translations = shared.translations.get(entry)
		if (!translations || !Object.hasOwn(translations, key)) continue
		const value = translations[key]
		if (typeof value === 'string') {
			if (value) return { locale: entry, message: compile(value) }
		} else if (isPluralTranslation(value) && value.other) return { locale: entry, plural: value, forms: {} }
	}
	return undefined
}

const select = (entry: Entry, count: unknown): Compiled => {
	if (!entry.plural) return entry.message
	const category = pluralCategory(entry.plural, entry.locale, count)
	return (entry.forms[category] ??= compile(entry.plural[category]!))
}

const createScope = (shared: Shared, locale: string): Scope => {
	const { sourceLocale, config } = shared

	// Untranslated messages render their own text, in the source locale.
	const untranslated = (message: Message): Entry => {
		if (typeof message === 'string') message = { text: message }
		if (locale !== sourceLocale && config.onUntranslated) {
			const text = message.text ?? message.other!
			const replacement = config.onUntranslated({ text, context: message.context, locale })
			if (typeof replacement === 'string') return { locale, message: compile(replacement) }
		}
		return message.text === undefined
			? { locale: sourceLocale, plural: message as PluralTranslation, forms: {} }
			: { locale: sourceLocale, message: compile(message.text) }
	}

	// Each message resolves through the fallback chain once, then is served from a memo until translations change.
	// Memos are keyed by the text itself, never a string built per call: one for text, and for message objects one
	// per context and shape (a plural and a string with the same text share a translation, but not a source fallback).
	// They start over if they ever get large, e.g. from text built out of user input.
	let texts = new Map<string, Entry>()
	let objects = new Map<string | undefined, [text: Map<string, Entry>, plural: Map<string, Entry>]>()
	let size = 0
	let version = shared.version
	const resolve = (message: Message): Entry => {
		if (version !== shared.version || size >= 10_000) {
			texts = new Map()
			objects = new Map()
			size = 0
			version = shared.version
		}
		let memo = texts
		let text = message as string
		if (typeof message !== 'string') {
			let memos = objects.get(message.context)
			if (!memos) objects.set(message.context, (memos = [new Map(), new Map()]))
			memo = message.text === undefined ? memos[1] : memos[0]
			text = message.text ?? message.other!
		}
		let entry = memo.get(text)
		if (!entry) {
			entry = lookup(shared, locale, keyOf(message)) ?? untranslated(message)
			memo.set(text, entry)
			size++
		}
		return entry
	}

	const translate = (message: Message, values?: Values) => {
		const entry = resolve(message)
		const compiled = select(entry, values?.count)
		if (typeof compiled === 'string') return compiled
		if (!isRich(values)) return renderString(compiled, entry.locale, values)
		const key = keyOf(message)
		const onMissingTag = (tag: string) => warnOnce(shared, `tag\0${key}\0${tag}`, `No renderer for <${tag}> in "${key}".`)
		return toNode(renderRich(compiled, entry.locale, values, onMissingTag))
	}

	return { locale, dir: getDirection(locale), translate: translate as Translate, format: createFormatter(locale) }
}

const getScope = (shared: Shared, locale: string) => reuse(shared.scopes, locale, () => createScope(shared, locale))

const createInstance = (shared: Shared, requested: string | undefined): I18n => {
	const { config, locales, sourceLocale } = shared
	const match = (preference: string | readonly string[] | null | undefined) => matchLocale(preference, locales)

	let snapshot: I18nSnapshot = { locale: match(requested) ?? sourceLocale, pendingLocale: undefined }
	const listeners = new Set<() => void>()
	let latestRequest = 0

	const notify = (next: I18nSnapshot) => {
		snapshot = next
		for (const listener of listeners) listener()
	}
	const update = (next: I18nSnapshot) => {
		if (next.locale !== snapshot.locale || next.pendingLocale !== snapshot.pendingLocale) notify(next)
	}
	// Same state, new snapshot: subscribers re-render with the replaced translations.
	const refresh = () => notify({ ...snapshot })
	// Only explicit choices are persisted. Saving a detected locale would pin it, e.g. ignore a later browser language change.
	const commit = (locale: string, persist?: boolean) => {
		update({ locale, pendingLocale: undefined })
		if (persist) for (const detector of config.detectors ?? []) detector.persist?.(locale)
	}

	const ready = load(shared, snapshot.locale)
	// Rejections surface through `ready` and the React provider; don't also report them as unhandled.
	ready.catch(() => {})

	const switchTo = (preference: string | readonly string[], persist?: boolean): Promise<void> => {
		const next = match(preference)
		if (!next) {
			warnOnce(shared, `locale\0${String(preference)}`, `No registered locale matches "${String(preference)}".`)
			return RESOLVED
		}
		const request = ++latestRequest
		if (isLoaded(shared, next)) {
			commit(next, persist)
			return RESOLVED
		}
		update({ locale: snapshot.locale, pendingLocale: next })
		return load(shared, next).then(
			() => {
				if (request === latestRequest) commit(next, persist)
			},
			error => {
				if (request === latestRequest) update({ locale: snapshot.locale, pendingLocale: undefined })
				throw error
			}
		)
	}

	const active = () => getScope(shared, snapshot.locale)

	return {
		sourceLocale,
		locales,
		ready,
		get locale() {
			return snapshot.locale
		},
		get dir() {
			return active().dir
		},
		get translate() {
			return active().translate
		},
		get format() {
			return active().format
		},
		get isReady() {
			return isLoaded(shared, snapshot.locale)
		},
		setLocale: preference => switchTo(preference, true),
		detect: () => {
			for (const detector of config.detectors ?? []) {
				let detected
				try {
					detected = match(detector.detect())
				} catch {}
				if (detected) return switchTo(detected)
			}
			return RESOLVED
		},
		match,
		load: locale => {
			const resolved = locale === undefined ? snapshot.locale : (match(locale) ?? sourceLocale)
			return load(shared, resolved).then(() => getScope(shared, resolved))
		},
		scope: locale => getScope(shared, match(locale) ?? sourceLocale),
		addTranslations: (locale, translations) => setTranslations(shared, locale, translations),
		getTranslations: locale => shared.translations.get(locale),
		clone: options => createInstance(shared, options?.locale ?? snapshot.locale),
		subscribe: listener => {
			listeners.add(listener)
			shared.subscribed.add(refresh)
			return () => {
				listeners.delete(listener)
				// Unsubscribed instances (e.g. per-request clones) must not be kept alive by `shared`.
				if (!listeners.size) shared.subscribed.delete(refresh)
			}
		},
		getSnapshot: () => snapshot
	}
}

/**
 * Create an i18n instance. Write your text in your code; `npx textlate translate` creates and fills the
 * translation files. It works anywhere: Server Components, route handlers, middleware and the browser.
 *
 * @example
 * ```ts
 * export const i18n = createI18n({
 *   sourceLocale: 'en', // the default
 *   locales: { es: () => import('./locales/es.json'), bn: () => import('./locales/bn.json') }, // code-split
 *   detectors: [storageDetector(), navigatorDetector()]
 * })
 *
 * i18n.translate('Hello, {name}!', { name: 'Ada' })
 *
 * // Once per app, for typed locales in the React hooks:
 * declare module 'textlate' {
 *   interface Register {
 *     i18n: typeof i18n
 *   }
 * }
 * ```
 */
export const createI18n = <const Locales extends Record<string, TranslationSource>, const S extends string = 'en'>(
	config: I18nConfig<Locales, S>
): I18n<S | (keyof Locales & string)> => {
	const sourceLocale = config.sourceLocale ?? 'en'
	const locales = Object.keys(config.locales)
	if (!locales.includes(sourceLocale)) locales.unshift(sourceLocale)
	const shared: Shared = {
		config: config as unknown as Shared['config'],
		sourceLocale,
		locales,
		translations: new Map(),
		loading: new Map(),
		chains: new Map(),
		scopes: new Map(),
		warned: new Set(),
		subscribed: new Set(),
		version: 0
	}
	for (const locale of locales) {
		// The source locale needs no translations, though it may have some (e.g. to fix wording without a deploy).
		const translations = config.locales[locale] ?? {}
		if (typeof translations === 'object') shared.translations.set(locale, translations)
	}
	return createInstance(shared, config.locale) as unknown as I18n<S | (keyof Locales & string)>
}
