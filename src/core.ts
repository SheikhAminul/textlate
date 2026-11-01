import { createFormatter, reuse } from './format.js'
import { getDirection, matchLocale } from './locale.js'
import { compile, isPluralTranslation, keyOf, pluralCategory, renderString, type Compiled } from './message.js'
import { isRich, renderRich, toNode } from './rich.js'
import type {
	I18n,
	I18nSnapshot,
	LoadOptions,
	LocaleDetector,
	Message,
	Messages,
	PluralCategory,
	PluralTranslation,
	Scope,
	ScopeOptions,
	Translate,
	TranslationLoader,
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

/** The namespace of an app with one translation file per locale. */
export const DEFAULT_NAMESPACE = 'default'

/** The locale codes of a config's `locales`: an array's items, or an object's keys. */
export type LocaleNames<Locales> = Locales extends readonly (infer L extends string)[] ? L : keyof Locales & string

export interface I18nConfig<Locales extends Record<string, TranslationSource> | readonly string[], S extends string> {
	/** The language the text in your code is written in. It needs no translations. Default `'en'`. */
	sourceLocale?: S | undefined
	/**
	 * The locales to translate into: an object of translations per locale (an object, or a loader such as
	 * `() => import('./locales/es.json')`), or a list of locale codes whose files `loader` loads.
	 */
	locales: Locales
	/**
	 * Loads one namespace of one locale, for apps whose translations are split into files per namespace (see
	 * `namespaces`). Bundlers code-split a template-literal import into one chunk per file.
	 *
	 * @example
	 * ```ts
	 * loader: (locale, namespace) => import(`./locales/${locale}/${namespace}.json`)
	 * ```
	 */
	loader?: TranslationLoader | undefined
	/**
	 * The namespaces a locale loads when none are named, e.g. `['app']`, while `['catalog']` loads only on the pages that
	 * ask for it (`i18n.load(locale, { namespaces: ['catalog'] })`, or `<I18nProvider namespaces>`). Default
	 * `['default']`: one file per locale.
	 */
	namespaces?: readonly string[] | undefined
	/** The initial locale (best match). Defaults to the source locale. */
	locale?: string | undefined
	/** Extra fallbacks per locale, tried before the base language and the source text. E.g. `{ 'pt-BR': ['pt-PT'] }`. */
	fallbacks?: { readonly [K in LocaleNames<Locales>]?: readonly LocaleNames<Locales>[] } | undefined
	/** Where `detect()` looks for a preferred locale, in order. Detectors with `persist` remember `setLocale` choices. */
	detectors?: readonly LocaleDetector[] | undefined
	/**
	 * The time zone dates in messages and `format.date` render in, e.g. `'Europe/Berlin'` or the user's own. Set it
	 * wherever text is rendered on a server, so the server and the browser show the same date. Default: the runtime's.
	 */
	timeZone?: string | undefined
	/**
	 * Called once per message and locale that isn't translated yet, e.g. to log it. Return a string to show instead of
	 * the source text (see `textlate/pseudo` for a pseudo-locale).
	 */
	onUntranslated?: ((info: UntranslatedInfo) => string | void) | undefined
}

type AnyConfig = I18nConfig<Record<string, TranslationSource> | readonly string[], string>
type Translation = string | PluralTranslation

/** One locale's loaded namespaces, and their translations merged for lookup. */
interface Store {
	/** In the order they were added: a message translated in two namespaces takes the first one's translation. */
	readonly namespaces: Map<string, Translations>
	/** Translated messages only (no `""`), by key. Rebuilt on first lookup after a namespace changes. */
	merged: Map<string, Translation> | undefined
}

interface Shared {
	readonly config: AnyConfig
	readonly sourceLocale: string
	readonly locales: readonly string[]
	/** What `load()` loads when no namespaces are named. */
	readonly defaults: readonly string[]
	/** Whether the source locale has translations to load. Usually not: its text is in the code. */
	readonly sourceLoads: boolean
	readonly stores: Map<string, Store>
	readonly loading: Map<string, Promise<void>>
	readonly chains: Map<string, readonly string[]>
	readonly scopes: Map<string, Scope>
	readonly warned: Set<string>
	/** Instances with subscribers, re-rendered when translations change. */
	readonly subscribed: Set<() => void>
	/** Bumped whenever translations change, invalidating the scopes' memos. */
	version: number
}

/** A resolved message: the locale it renders in, and its text compiled once (plural forms on first use). */
type Entry =
	| { readonly locale: string; readonly message: Compiled; readonly plural?: undefined }
	| { readonly locale: string; readonly plural: PluralTranslation; readonly forms: { [C in PluralCategory]?: Compiled } }

type Values = Readonly<Record<string, unknown>> | undefined

/**
 * Untranslated messages a scope remembers before it starts over. Translated ones don't count: there are only as many as
 * the catalogs hold, while untranslated text can come from anywhere (e.g. text built from user input).
 */
const MISS_LIMIT = 5_000
const RESOLVED = Promise.resolve()

const warnOnce = (shared: Shared, id: string, message: string) => {
	if (!isDev || shared.warned.has(id)) return
	shared.warned.add(id)
	console.warn(`[textlate] ${message}`)
}

const listOf = (namespaces: string | readonly string[] | undefined, fallback: readonly string[]) =>
	namespaces === undefined ? fallback : typeof namespaces === 'string' ? [namespaces] : namespaces

/**
 * `locale`, its configured fallbacks, its base language, then the source locale (whose translations, if it has any,
 * override the text in the code). The text in the code comes last.
 */
const chainOf = (shared: Shared, locale: string): readonly string[] =>
	reuse(shared.chains, locale, () => {
		const base = locale.split('-')[0]!.toLowerCase()
		const baseLocale = shared.locales.find(candidate => candidate.toLowerCase() === base)
		const fallbacks = (shared.config.fallbacks as Record<string, readonly string[]> | undefined)?.[locale] ?? []
		return [...new Set([locale, ...fallbacks, ...(baseLocale ? [baseLocale] : []), shared.sourceLocale])]
	})

const storeOf = (shared: Shared, locale: string): Store => {
	let store = shared.stores.get(locale)
	if (!store) shared.stores.set(locale, (store = { namespaces: new Map(), merged: undefined }))
	return store
}

/** Whether `namespace` of `locale` is in memory: loaded, added, or nothing to load (the source text). */
const has = (shared: Shared, locale: string, namespace: string) =>
	(locale === shared.sourceLocale && !shared.sourceLoads) || shared.stores.get(locale)?.namespaces.has(namespace) === true

const missingOf = (shared: Shared, locale: string, namespaces: readonly string[]) => {
	const missing: [string, string][] = []
	for (const entry of chainOf(shared, locale)) for (const namespace of namespaces) if (!has(shared, entry, namespace)) missing.push([entry, namespace])
	return missing
}

const isLoaded = (shared: Shared, locale: string, namespaces: readonly string[]) => missingOf(shared, locale, namespaces).length === 0

const setTranslations = (shared: Shared, locale: string, namespace: string, translations: Translations, notify: boolean) => {
	// Whatever was in memory before is on screen: so is the source text, which the source locale's translations override.
	const replaced = has(shared, locale, namespace)
	const store = storeOf(shared, locale)
	store.namespaces.set(namespace, translations)
	store.merged = undefined
	shared.version++
	// A replacement changes what's on screen, and so does anything that finished loading. Translations added while
	// rendering (as I18nProvider does with the server's) must not notify, or other components would update mid-render.
	if (replaced || notify) for (const refresh of [...shared.subscribed]) refresh()
}

/** Accepts `import('./es.json')` namespaces as well as plain objects. */
const unwrapModule = (module: unknown): Translations => {
	const value = (module ?? {}) as { default?: unknown; __esModule?: unknown; [Symbol.toStringTag]?: unknown }
	const isNamespace = value[Symbol.toStringTag] === 'Module' || value.__esModule === true || Object.keys(value).join() === 'default'
	return (isNamespace && typeof value.default === 'object' && value.default ? value.default : value) as Translations
}

/** Where a namespace of a locale comes from: the config's object or loader for it, or `loader`. */
const sourceOf = (shared: Shared, locale: string, namespace: string): TranslationSource | undefined => {
	const { locales, loader } = shared.config
	const own = namespace === DEFAULT_NAMESPACE && !Array.isArray(locales) ? (locales as Record<string, TranslationSource>)[locale] : undefined
	return own ?? (loader ? () => loader(locale, namespace) : undefined)
}

const loadOne = (shared: Shared, locale: string, namespace: string): Promise<void> => {
	const id = `${locale}\0${namespace}`
	let pending = shared.loading.get(id)
	if (!pending) {
		const source = sourceOf(shared, locale, namespace)
		pending = Promise.resolve()
			.then(() => (typeof source === 'function' ? source() : (source ?? {})))
			.then(module => {
				// Translations added while loading (e.g. sent from the server) win over the loader's.
				if (!shared.stores.get(locale)?.namespaces.has(namespace)) setTranslations(shared, locale, namespace, unwrapModule(module), true)
			})
			.finally(() => shared.loading.delete(id))
		shared.loading.set(id, pending)
	}
	return pending
}

const load = (shared: Shared, locale: string, namespaces: readonly string[]): Promise<void> => {
	const missing = missingOf(shared, locale, namespaces)
	return missing.length ? Promise.all(missing.map(([entry, namespace]) => loadOne(shared, entry, namespace))).then(() => {}) : RESOLVED
}

/** A store's translated messages, merged across its namespaces: one `Map` lookup per message. */
const mergedOf = (store: Store): Map<string, Translation> => {
	if (!store.merged) {
		const merged = new Map<string, Translation>()
		for (const translations of store.namespaces.values()) {
			for (const key of Object.keys(translations)) {
				if (merged.has(key)) continue
				const value = translations[key]
				// `""` and plurals without `other` aren't translated yet.
				if (typeof value === 'string' ? value : isPluralTranslation(value) && value.other) merged.set(key, value!)
			}
		}
		store.merged = merged
	}
	return store.merged
}

/** The translation of `key` in `locale` or its fallbacks. */
const lookup = (shared: Shared, locale: string, key: string): Entry | undefined => {
	for (const entry of chainOf(shared, locale)) {
		const store = shared.stores.get(entry)
		const value = store && mergedOf(store).get(key)
		if (value === undefined) continue
		return typeof value === 'string' ? { locale: entry, message: compile(value) } : { locale: entry, plural: value, forms: {} }
	}
	return undefined
}

const select = (entry: Entry, count: unknown): Compiled => {
	if (!entry.plural) return entry.message
	const category = pluralCategory(entry.plural, entry.locale, count)
	return (entry.forms[category] ??= compile(entry.plural[category]!))
}

const createScope = (shared: Shared, locale: string, timeZone: string | undefined): Scope => {
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
	// Only untranslated messages count towards starting over, so a catalog of any size stays resolved.
	let texts = new Map<string, Entry>()
	let objects = new Map<string | undefined, [text: Map<string, Entry>, plural: Map<string, Entry>]>()
	let misses = 0
	let version = shared.version
	const resolve = (message: Message): Entry => {
		if (version !== shared.version || misses >= MISS_LIMIT) {
			texts = new Map()
			objects = new Map()
			misses = 0
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
			entry = lookup(shared, locale, keyOf(message))
			if (!entry) {
				entry = untranslated(message)
				misses++
			}
			memo.set(text, entry)
		}
		return entry
	}

	const translate = (message: Message, values?: Values) => {
		const entry = resolve(message)
		const compiled = select(entry, values?.count)
		if (typeof compiled === 'string') return compiled
		if (!isRich(values)) return renderString(compiled, entry.locale, values, timeZone)
		const key = keyOf(message)
		const onMissingTag = (tag: string) => warnOnce(shared, `tag\0${key}\0${tag}`, `No renderer for <${tag}> in "${key}".`)
		return toNode(renderRich(compiled, entry.locale, values, onMissingTag, timeZone))
	}

	return { locale, dir: getDirection(locale), timeZone, translate: translate as Translate, format: createFormatter(locale, timeZone) }
}

const getScope = (shared: Shared, locale: string, timeZone: string | undefined) =>
	reuse(shared.scopes, timeZone ? `${locale}\0${timeZone}` : locale, () => createScope(shared, locale, timeZone))

const createInstance = (shared: Shared, requested: string | undefined, timeZone: string | undefined): I18n => {
	const { config, locales, sourceLocale, defaults } = shared
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
	// Same state, new snapshot: subscribers re-render with the changed translations.
	const refresh = () => notify({ ...snapshot })
	// Only explicit choices are persisted. Saving a detected locale would pin it, e.g. ignore a later browser language change.
	const commit = (locale: string, persist?: boolean) => {
		update({ locale, pendingLocale: undefined })
		if (persist) for (const detector of config.detectors ?? []) detector.persist?.(locale)
	}
	/** The namespaces in use: the defaults, and any the active locale has loaded since (a switch loads them all). */
	const inUse = () => {
		const loaded = shared.stores.get(snapshot.locale)?.namespaces.keys() ?? []
		return [...new Set([...defaults, ...loaded])]
	}

	const ready = load(shared, snapshot.locale, defaults)
	// Rejections surface through `ready` and the React provider; don't also report them as unhandled.
	ready.catch(() => {})

	const switchTo = (preference: string | readonly string[], persist?: boolean): Promise<void> => {
		const next = match(preference)
		if (!next) {
			warnOnce(shared, `locale\0${String(preference)}`, `No registered locale matches "${String(preference)}".`)
			return RESOLVED
		}
		const request = ++latestRequest
		const namespaces = inUse()
		if (isLoaded(shared, next, namespaces)) {
			commit(next, persist)
			return RESOLVED
		}
		update({ locale: snapshot.locale, pendingLocale: next })
		return load(shared, next, namespaces).then(
			() => {
				if (request === latestRequest) commit(next, persist)
			},
			error => {
				if (request === latestRequest) update({ locale: snapshot.locale, pendingLocale: undefined })
				throw error
			}
		)
	}

	const active = () => getScope(shared, snapshot.locale, timeZone)
	const resolveLocale = (locale: string | undefined) => (locale === undefined ? snapshot.locale : (match(locale) ?? sourceLocale))

	return {
		sourceLocale,
		locales,
		namespaces: defaults,
		ready,
		get locale() {
			return snapshot.locale
		},
		get dir() {
			return active().dir
		},
		get timeZone() {
			return timeZone
		},
		get translate() {
			return active().translate
		},
		get format() {
			return active().format
		},
		get isReady() {
			return isLoaded(shared, snapshot.locale, defaults)
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
		load: (locale, options) => {
			const resolved = resolveLocale(locale)
			return load(shared, resolved, listOf(options?.namespaces, defaults)).then(() => getScope(shared, resolved, options?.timeZone ?? timeZone))
		},
		isLoaded: (locale, namespaces) => isLoaded(shared, resolveLocale(locale), listOf(namespaces, defaults)),
		scope: (locale, options) => getScope(shared, match(locale) ?? sourceLocale, options?.timeZone ?? timeZone),
		getMessages: (locale, namespaces) => {
			const resolved = resolveLocale(locale)
			const wanted = listOf(namespaces, defaults)
			return load(shared, resolved, wanted).then(() => {
				const messages: Record<string, Record<string, Translations>> = {}
				for (const entry of chainOf(shared, resolved)) {
					const store = shared.stores.get(entry)
					if (!store) continue
					for (const namespace of wanted) {
						const translations = store.namespaces.get(namespace)
						if (translations) (messages[entry] ??= {})[namespace] = translations
					}
				}
				return messages as Messages
			})
		},
		addMessages: messages => {
			for (const [locale, namespaces] of Object.entries(messages)) {
				for (const [namespace, translations] of Object.entries(namespaces ?? {})) {
					if (translations && !shared.stores.get(locale)?.namespaces.has(namespace)) setTranslations(shared, locale, namespace, translations, false)
				}
			}
		},
		addTranslations: (locale, translations, namespace = defaults[0]!) => setTranslations(shared, locale, namespace, translations, false),
		getTranslations: (locale, namespace = defaults[0]!) => shared.stores.get(locale)?.namespaces.get(namespace),
		clone: options => createInstance(shared, options?.locale ?? snapshot.locale, options && 'timeZone' in options ? options.timeZone : timeZone),
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
 * // One file per locale
 * export const i18n = createI18n({
 *   locales: { es: () => import('./locales/es.json'), bn: () => import('./locales/bn.json') }, // code-split
 *   detectors: [storageDetector(), navigatorDetector()]
 * })
 *
 * // A large app: files per namespace, loaded as pages need them
 * export const i18n = createI18n({
 *   locales: ['es', 'bn', 'ja'],
 *   namespaces: ['app'],
 *   loader: (locale, namespace) => import(`./locales/${locale}/${namespace}.json`)
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
export const createI18n = <const Locales extends Record<string, TranslationSource> | readonly string[], const S extends string = 'en'>(
	config: I18nConfig<Locales, S>
): I18n<S | LocaleNames<Locales>> => {
	const sourceLocale = config.sourceLocale ?? 'en'
	const listed = Array.isArray(config.locales)
	if (listed && !config.loader) throw new Error('[textlate] A list of `locales` needs a `loader` to load their translations.')
	const locales: string[] = listed ? [...(config.locales as readonly string[])] : Object.keys(config.locales)
	if (!locales.includes(sourceLocale)) locales.unshift(sourceLocale)
	const sources = listed ? undefined : (config.locales as Record<string, TranslationSource>)
	const shared: Shared = {
		config: config as unknown as AnyConfig,
		sourceLocale,
		locales,
		defaults: config.namespaces?.length ? [...config.namespaces] : [DEFAULT_NAMESPACE],
		// The source locale needs no translations, though it may have some (e.g. to fix wording without a deploy).
		sourceLoads: sources?.[sourceLocale] !== undefined,
		stores: new Map(),
		loading: new Map(),
		chains: new Map(),
		scopes: new Map(),
		warned: new Set(),
		subscribed: new Set(),
		version: 0
	}
	// Translations given as objects are in memory from the start.
	for (const locale of locales) {
		const translations = sources?.[locale]
		if (typeof translations === 'object') setTranslations(shared, locale, DEFAULT_NAMESPACE, translations, false)
	}
	return createInstance(shared, config.locale, config.timeZone) as unknown as I18n<S | LocaleNames<Locales>>
}
