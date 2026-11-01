'use client'

import { createContext, use, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'
import type { RegisteredI18n, RegisteredLocale } from './index.js'
import type { I18n, Messages, Translations } from './types.js'

const I18nContext = createContext<I18n | null>(null)
I18nContext.displayName = 'I18nContext'
/** The server's time when it rendered, so relative times render the same in the browser. */
const NowContext = createContext<number | undefined>(undefined)

// `use()` needs the same promise on every render while it waits, so each pending load is kept until it settles.
const pending = new WeakMap<I18n, Map<string, Promise<unknown>>>()
const loading = (instance: I18n, locale: string, namespaces: readonly string[]) => {
	let loads = pending.get(instance)
	if (!loads) pending.set(instance, (loads = new Map()))
	const key = `${locale}\0${namespaces.join('\0')}`
	let promise = loads.get(key)
	if (!promise) {
		promise = instance.load(locale, { namespaces }).finally(() => loads.delete(key))
		loads.set(key, promise)
	}
	return promise
}

/** Suspends until `namespaces` of the active locale are loaded. */
const useLoaded = (instance: I18n, locale: string, namespaces: readonly string[] | undefined) => {
	if (namespaces?.length && !instance.isLoaded(locale, namespaces)) use(loading(instance, locale, namespaces))
}

export interface I18nProviderProps {
	i18n: I18n<any>
	/**
	 * Pin this subtree to a locale, e.g. from a Next.js `[lang]` route segment or the signed-in user's setting. The
	 * provider then works on its own copy of the instance, so concurrent server requests never share an active locale.
	 * Change it by navigating (or re-rendering with another locale).
	 */
	locale?: string | undefined
	/** The time zone dates render in, e.g. the user's, so the server and the browser show the same dates. */
	timeZone?: string | undefined
	/** Translations by locale and namespace, from `await i18n.getMessages(lang, namespaces)` on the server. */
	messages?: Messages | undefined
	/** One-file-per-locale translations already loaded elsewhere (e.g. on the server). Prefer `messages`. */
	translations?: { readonly [L in RegisteredLocale]?: Translations } | undefined
	/** Namespaces this subtree needs besides the default ones. It suspends until they're loaded. */
	namespaces?: readonly string[] | undefined
	/** The server's time when it rendered (e.g. `Date.now()` in the layout), so `<Time relative>` renders the same text in the browser. */
	now?: Date | number | undefined
	/** Run the instance's detectors after mount. Ignored when `locale` is set. Default `true`. */
	detect?: boolean | undefined
	/** Keep `<html lang dir>` in sync with the active locale. Default `true`. */
	syncDocument?: boolean | undefined
	children?: ReactNode
}

/**
 * Makes an i18n instance available to `useI18n()`. Suspends until the initial locale's translations are loaded,
 * so wrap it in `<Suspense>` when any locale is lazy and nothing was passed from the server.
 *
 * @example
 * ```tsx
 * <Suspense fallback={null}>
 *   <I18nProvider i18n={i18n}>
 *     <App />
 *   </I18nProvider>
 * </Suspense>
 *
 * // Next.js App Router: in a 'use client' file rendered by app/[lang]/layout.tsx
 * <I18nProvider i18n={i18n} locale={lang} messages={messages}>{children}</I18nProvider>
 * ```
 */
export const I18nProvider = ({ i18n, locale, timeZone, messages, translations, namespaces, now, detect = true, syncDocument = true, children }: I18nProviderProps) => {
	if (messages) i18n.addMessages(messages)
	if (translations) {
		for (const [key, value] of Object.entries(translations)) {
			if (value && !i18n.getTranslations(key)) i18n.addTranslations(key, value)
		}
	}
	const pinned = locale !== undefined || timeZone !== undefined
	const instance = useMemo(() => (pinned ? i18n.clone({ ...(locale !== undefined && { locale }), timeZone }) : i18n), [i18n, pinned, locale, timeZone])
	const { locale: active } = useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
	if (!instance.isReady) use(instance.ready)
	useLoaded(instance, active, namespaces)

	// Detection reads browser-only state, so it runs after hydration: the server and client render the same markup.
	useLayoutEffect(() => {
		if (detect && locale === undefined) instance.detect().catch(console.error)
	}, [instance, detect, locale])

	useLayoutEffect(() => {
		if (!syncDocument) return
		document.documentElement.lang = active
		document.documentElement.dir = instance.scope(active).dir
	}, [instance, active, syncDocument])

	return (
		<I18nContext value={instance}>
			{now === undefined ? children : <NowContext value={typeof now === 'number' ? now : now.getTime()}>{children}</NowContext>}
		</I18nContext>
	)
}

const useInstance = () => {
	const instance = use(I18nContext) as RegisteredI18n | null
	if (!instance) throw new Error('[textlate] useI18n() must be used inside <I18nProvider>.')
	return instance
}

/**
 * Loads namespaces a component needs besides the default ones, suspending until they are there. A locale switch
 * loads them too.
 *
 * @example
 * ```tsx
 * const AppPicker = () => {
 *   useNamespaces(['catalog'])
 *   const { translate } = useI18n()
 *   return apps.map(app => <li key={app.id}>{translate(app.label)}</li>)
 * }
 * ```
 */
export const useNamespaces = (namespaces: readonly string[]): void => {
	const instance = useInstance()
	const { locale } = useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
	useLoaded(instance, locale, namespaces)
}

/**
 * Everything for the active locale. Components re-render only when the locale changes, and `translate` and `format` are
 * stable per locale, so they are safe in dependency arrays.
 *
 * @example
 * ```tsx
 * const { translate, format, locale, locales, setLocale, isPending } = useI18n()
 *
 * <h1>{translate('Hello, {name}!', { name })}</h1>
 * <p>{translate({ one: '{count} file', other: '{count} files' }, { count })}</p>
 * <p>{translate('Read the <link>terms</link>.', { link: <a href="/terms" /> })}</p>
 * <time>{format.date(post.createdAt, { dateStyle: 'medium' })}</time>
 *
 * <select value={locale} disabled={isPending} onChange={event => setLocale(event.target.value)}>
 *   {locales.map(option => <option key={option}>{option}</option>)}
 * </select>
 * ```
 */
export const useI18n = () => {
	const instance = useInstance()
	const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
	return useMemo(() => {
		const { locale, dir, timeZone, translate, format } = instance.scope(snapshot.locale)
		return {
			translate,
			format,
			locale,
			dir,
			timeZone,
			/** A locale being loaded by `setLocale`; the current one stays on screen until it is ready. */
			pendingLocale: snapshot.pendingLocale,
			isPending: snapshot.pendingLocale !== undefined,
			locales: instance.locales,
			sourceLocale: instance.sourceLocale,
			/**
			 * Switch locale. Under a provider with a pinned `locale` (e.g. a Next.js `[lang]` route), navigate to the
			 * other locale's URL instead.
			 */
			setLocale: instance.setLocale,
			i18n: instance
		}
	}, [instance, snapshot])
}

export interface TimeProps extends Omit<ComponentProps<'time'>, 'children' | 'dateTime'> {
	value: Date | number | string
	/** How to write the date and time, e.g. `{ dateStyle: 'medium', timeStyle: 'short' }`. */
	format?: Intl.DateTimeFormatOptions | undefined
	/** Write how long ago (or ahead) it is — "5 minutes ago" — kept up to date every minute once it's in the browser. */
	relative?: boolean | undefined
}

/**
 * A date or time, in the active locale and time zone, that hydrates without mismatches: the browser keeps the text the
 * server rendered (engines can write the same date a little differently), and a relative time starts from the server's
 * `now` (see `<I18nProvider now>`), then keeps itself current.
 *
 * @example
 * ```tsx
 * <Time value={run.startedAt} format={{ dateStyle: 'medium', timeStyle: 'short' }} />
 * <Time value={run.startedAt} relative />
 * ```
 */
export const Time = ({ value, format, relative, ...props }: TimeProps) => {
	const { format: formatter } = useI18n()
	const rendered = use(NowContext)
	const [now, setNow] = useState(rendered)
	useEffect(() => {
		if (!relative) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 60_000)
		return () => clearInterval(timer)
	}, [relative])
	const time = value instanceof Date ? value : new Date(value)
	return (
		<time {...props} dateTime={time.toISOString()} suppressHydrationWarning>
			{relative ? formatter.relative(time, { now: now ?? Date.now() }) : formatter.date(time, format)}
		</time>
	)
}
