import { createFormatter, reuse } from './format.js'
import { getDirection, matchLocale } from './locale.js'
import { compile, isPluralTranslation, keyOf, pluralCategory, renderString, type Compiled } from './message.js'
import { hashKey } from './hash.js'
import { isRich, renderRich, toNode } from './rich.js'
import type {
	I18n,
	I18nSnapshot,
	LocaleDetector,
	Message,
	Messages,
	PluralCategory,
	PluralTranslation,
	Scope,
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
	 * How the translation files are keyed: by each message's text (the files `textlate extract` writes), or by its short
	 * hash (the compiled files `textlate compile` writes, a third smaller or more). Default `'text'`.
	 */
	keys?: 'text' | 'hashed' | undefined
	/**
	 * Messages the instance (and its clones) remember resolved, across every locale, before the least used are let go.
	 * Default `50_000`: a large app's every message in one locale, and the busy ones of many on a server.
	 */
	memoLimit?: number | undefined
	/**
	 * Locales kept in memory at most; the least recently used beyond it are unloaded, and load again when asked for. For
	 * long-running servers that serve many languages. Default: no limit.
	 */
	maxLocales?: number | undefined
	/**
	 * Called once per message and locale that isn't translated yet, e.g. to log it. Return a string to show instead of
	 * the source text (see `textlate/pseudo` for a pseudo-locale).
	 */
	onUntranslated?: ((info: UntranslatedInfo) => string | void) | undefined
}

type AnyConfig = I18nConfig<Record<string, TranslationSource> | readonly string[], string>

/** One locale's loaded namespaces. */
interface Store {
	/** In the order they were added: a message translated in two namespaces takes the first one's translation. */
	readonly namespaces: Map<string, Translations>
	/** When the locale was last asked for, to unload the least recently used. */
	used: number
}

/** A scope's resolved messages: by text, and for message objects by context and shape. */
interface Memo {
	readonly texts: Map<string, Entry>
	readonly objects: Map<string | undefined, [text: Map<string, Entry>, plural: Map<string, Entry>]>
}

interface Shared {
	readonly config: AnyConfig
	readonly sourceLocale: string
	readonly locales: readonly string[]
	/** What `load()` loads when no namespaces are named. */
	readonly defaults: readonly string[]
	/** Whether the source locale has translations to load. Usually not: its text is in the code. */
	readonly sourceLoads: boolean
	readonly hashed: boolean
	readonly stores: Map<string, Store>
	readonly loading: Map<string, Promise<void>>
	readonly chains: Map<string, readonly string[]>
	readonly scopes: Map<string, Scope>
	readonly warned: Set<string>
	/** Messages objects already added, so a provider re-rendering with the same ones adds nothing. */
	readonly added: WeakSet<object>
	/** Instances with subscribers, re-rendered when translations change. */
	readonly subscribed: Set<() => void>
	/** Bumped whenever translations change, invalidating the scopes' memos. */
	version: number
	/** Messages resolved since the memos last moved on a generation, across every scope. */
	memoSize: number
	/** Each scope's way of moving its memo on a generation, by the scope's key. */
	readonly rotations: Map<string, () => void>
	/** Bumped on every use, to order locales by when they were last used. */
	clock: number
}

/** A resolved message: the locale it renders in, and its text compiled once (plural forms on first use). */
type Entry =
	| { readonly locale: string; readonly message: Compiled; readonly plural?: undefined }
	| { readonly locale: string; readonly plural: PluralTranslation; readonly forms: { [C in PluralCategory]?: Compiled } }

type Values = Readonly<Record<string, unknown>> | undefined

const MEMO_LIMIT = 50_000
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

/** Mark a locale (and its fallbacks) as just used. */
const touch = (shared: Shared, locale: string) => {
	const now = ++shared.clock
	for (const entry of chainOf(shared, locale)) {
		const store = shared.stores.get(entry)
		if (store) store.used = now
	}
}

const storeOf = (shared: Shared, locale: string): Store => {
	let store = shared.stores.get(locale)
	if (!store) shared.stores.set(locale, (store = { namespaces: new Map(), used: ++shared.clock }))
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

/** Let go of a locale's translations, and the scopes that render with them. It loads again when asked for. */
const unload = (shared: Shared, locale: string) => {
	if (!shared.stores.delete(locale)) return
	for (const [key, scope] of shared.scopes) {
		if (!chainOf(shared, scope.locale).includes(locale)) continue
		shared.scopes.delete(key)
		shared.rotations.delete(key)
	}
}

/** Over `maxLocales`: unload the least recently used, never the one just added or the ones it falls back on. */
const evict = (shared: Shared, keep: string) => {
	const limit = shared.config.maxLocales
	if (!limit || shared.stores.size <= limit) return
	const kept = new Set(chainOf(shared, keep))
	const candidates = [...shared.stores].filter(([locale]) => !kept.has(locale)).sort(([, a], [, b]) => a.used - b.used)
	for (const [locale] of candidates) {
		if (shared.stores.size <= limit) break
		unload(shared, locale)
	}
}

/** Whether `existing` has every one of `translations` already, as it is (plural forms compared form by form). */
const holds = (existing: Translations, translations: Translations) => {
	for (const key in translations) {
		const value = translations[key]
		const current = Object.hasOwn(existing, key) ? existing[key] : undefined
		if (value === current) continue
		if (typeof value !== 'object' || typeof current !== 'object' || !value || !current) return false
		const forms = Object.keys(value) as (keyof PluralTranslation)[]
		if (forms.length !== Object.keys(current).length || forms.some(form => value[form] !== current[form])) return false
	}
	return true
}

/**
 * Put a namespace of a locale in memory: `load` (it finished loading: on screen at once) or `add` (sent from the server
 * while rendering: merged in quietly).
 */
const setTranslations = (shared: Shared, locale: string, namespace: string, translations: Translations, mode: 'load' | 'add') => {
	const store = storeOf(shared, locale)
	const existing = store.namespaces.get(namespace)
	// A server renders the provider with the same messages request after request: nothing new, so nothing to copy, and
	// every scope keeps its memo.
	if (mode === 'add' && existing && holds(existing, translations)) return
	// The server may send a page's messages a part at a time (a layout's, then a page's): parts add up.
	store.namespaces.set(namespace, mode === 'add' && existing ? { ...existing, ...translations } : translations)
	store.used = ++shared.clock
	shared.version++
	// Translations added while rendering (as I18nProvider does with the server's) must not notify, or other components
	// would update mid-render.
	if (mode === 'load') for (const refresh of [...shared.subscribed]) refresh()
	evict(shared, locale)
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
				if (!shared.stores.get(locale)?.namespaces.has(namespace)) setTranslations(shared, locale, namespace, unwrapModule(module), 'load')
			})
			.finally(() => shared.loading.delete(id))
		shared.loading.set(id, pending)
	}
	return pending
}

const load = (shared: Shared, locale: string, namespaces: readonly string[]): Promise<void> => {
	touch(shared, locale)
	const missing = missingOf(shared, locale, namespaces)
	return missing.length ? Promise.all(missing.map(([entry, namespace]) => loadOne(shared, entry, namespace))).then(() => {}) : RESOLVED
}

/**
 * The translation of `key` in `locale` or its fallbacks, from the namespaces in memory: the first that has it
 * translated (`""` and plurals without `other` aren't yet). It runs once per message per locale, then the memo answers.
 */
const lookup = (shared: Shared, locale: string, key: string): Entry | undefined => {
	const id = shared.hashed ? hashKey(key) : key
	for (const entry of chainOf(shared, locale)) {
		const store = shared.stores.get(entry)
		if (!store) continue
		for (const translations of store.namespaces.values()) {
			if (!Object.hasOwn(translations, id)) continue
			const value = translations[id]
			if (typeof value === 'string') {
				if (value) return { locale: entry, message: compile(value) }
			} else if (isPluralTranslation(value) && value.other) return { locale: entry, plural: value, forms: {} }
		}
	}
	return undefined
}

const select = (entry: Entry, count: unknown): Compiled => {
	if (!entry.plural) return entry.message
	const category = pluralCategory(entry.plural, entry.locale, count)
	return (entry.forms[category] ??= compile(entry.plural[category]!))
}

const createScope = (shared: Shared, locale: string, timeZone: string | undefined, rotation: { rotate?: () => void }): Scope => {
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
	// Memory stays bounded across every scope: once `memoLimit` messages were resolved, each scope's memo becomes its
	// previous one, and only messages used again are carried over, so a busy server keeps what it uses.
	const createMemo = (): Memo => ({ texts: new Map(), objects: new Map() })
	let current = createMemo()
	let previous = createMemo()
	let version = shared.version
	const limit = config.memoLimit ?? MEMO_LIMIT
	const slot = (memo: Memo, message: Message): Map<string, Entry> => {
		if (typeof message === 'string') return memo.texts
		let memos = memo.objects.get(message.context)
		if (!memos) memo.objects.set(message.context, (memos = [new Map(), new Map()]))
		return message.text === undefined ? memos[1] : memos[0]
	}
	const rotate = () => {
		previous = current
		current = createMemo()
	}
	const remember = (memo: Map<string, Entry>, text: string, entry: Entry) => {
		memo.set(text, entry)
		// Every scope moves on at once — the idle ones too, so a locale nobody asks for lets go of its messages.
		if (++shared.memoSize >= limit) {
			shared.memoSize = 0
			for (const each of [...shared.rotations.values()]) each()
		}
	}
	const resolve = (message: Message): Entry => {
		if (version !== shared.version) {
			current = createMemo()
			previous = createMemo()
			version = shared.version
		}
		const text = typeof message === 'string' ? message : (message.text ?? message.other!)
		const memo = slot(current, message)
		let entry = memo.get(text)
		if (entry) return entry
		entry = slot(previous, message).get(text) ?? lookup(shared, locale, keyOf(message)) ?? untranslated(message)
		remember(memo, text, entry)
		return entry
	}

	rotation.rotate = rotate
	const dir = getDirection(locale)
	// Values in right-to-left text are set apart, so their punctuation stays put; text the scope shows is what counts.
	const isolated = dir === 'rtl'

	const translate = (message: Message, values?: Values) => {
		const entry = resolve(message)
		const compiled = select(entry, values?.count)
		if (typeof compiled === 'string') return compiled
		if (!isRich(values)) return renderString(compiled, entry.locale, values, timeZone, isolated)
		const key = keyOf(message)
		const onMissingTag = (tag: string) => warnOnce(shared, `tag\0${key}\0${tag}`, `No renderer for <${tag}> in "${key}".`)
		return toNode(renderRich(compiled, entry.locale, values, onMissingTag, timeZone, isolated))
	}

	return { locale, dir, timeZone, translate: translate as Translate, format: createFormatter(locale, timeZone) }
}

/** Scopes kept at most: a scope per locale and time zone, and time zones can come from requests. */
const SCOPE_LIMIT = 2_000

const getScope = (shared: Shared, locale: string, timeZone: string | undefined) => {
	const key = timeZone ? `${locale}\0${timeZone}` : locale
	let scope = shared.scopes.get(key)
	if (!scope) {
		if (shared.scopes.size >= SCOPE_LIMIT) {
			shared.scopes.clear()
			shared.rotations.clear()
		}
		const rotation: { rotate?: () => void } = {}
		scope = createScope(shared, locale, timeZone, rotation)
		shared.scopes.set(key, scope)
		shared.rotations.set(key, rotation.rotate!)
	}
	return scope
}

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
		scope: (locale, options) => {
			const resolved = match(locale) ?? sourceLocale
			touch(shared, resolved)
			return getScope(shared, resolved, options?.timeZone ?? timeZone)
		},
		getMessages: (locale, namespaces, options) => {
			const resolved = resolveLocale(locale)
			const wanted = listOf(namespaces, defaults)
			return load(shared, resolved, wanted).then(() => {
				// Only the messages asked for: what a page's client components use, by their keys (see `textlate extract`'s routes).
				const only = options?.only && new Set(shared.hashed ? [...options.only].map(hashKey) : options.only)
				const messages: Record<string, Record<string, Translations>> = {}
				for (const entry of chainOf(shared, resolved)) {
					const store = shared.stores.get(entry)
					if (!store) continue
					for (const namespace of wanted) {
						const translations = store.namespaces.get(namespace)
						if (!translations) continue
						let picked: Record<string, unknown> = translations
						if (only) {
							picked = {}
							for (const key of only) {
								// Only what's translated: untranslated text shows the source text anyway.
								const value = Object.hasOwn(translations, key) ? translations[key] : undefined
								if (value) picked[key] = value
							}
						}
						;(messages[entry] ??= {})[namespace] = picked as Translations
					}
				}
				return messages as Messages
			})
		},
		addMessages: messages => {
			// A provider adds the same messages on every render: once is enough.
			if (shared.added.has(messages)) return
			shared.added.add(messages)
			for (const [locale, namespaces] of Object.entries(messages)) {
				for (const [namespace, translations] of Object.entries(namespaces ?? {})) {
					if (translations) setTranslations(shared, locale, namespace, translations, 'add')
				}
			}
		},
		unload: locale => unload(shared, locale),
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
		hashed: config.keys === 'hashed',
		added: new WeakSet(),
		subscribed: new Set(),
		version: 0,
		memoSize: 0,
		rotations: new Map(),
		clock: 0
	}
	// Translations given as objects are in memory from the start.
	for (const locale of locales) {
		const translations = sources?.[locale]
		if (typeof translations === 'object') setTranslations(shared, locale, DEFAULT_NAMESPACE, translations, 'add')
	}
	return createInstance(shared, config.locale, config.timeZone) as unknown as I18n<S | LocaleNames<Locales>>
}
