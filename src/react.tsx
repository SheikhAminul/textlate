'use client'

import { createContext, use, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { RegisteredI18n, RegisteredLocale } from './index.js'
import type { I18n, Translations } from './types.js'

const I18nContext = createContext<I18n | null>(null)
I18nContext.displayName = 'I18nContext'

export interface I18nProviderProps {
	i18n: I18n<any>
	/**
	 * Pin this subtree to a locale, e.g. from a Next.js `[lang]` route segment. The provider then works on its own
	 * copy of the instance, so concurrent server requests never share an active locale. Change it by navigating.
	 */
	locale?: string | undefined
	/** Translations already loaded elsewhere (e.g. on the server), so the client needn't fetch them. */
	translations?: { readonly [L in RegisteredLocale]?: Translations } | undefined
	/** Run the instance's detectors after mount. Ignored when `locale` is set. Default `true`. */
	detect?: boolean | undefined
	/** Keep `<html lang dir>` in sync with the active locale. Default `true`. */
	syncDocument?: boolean | undefined
	children?: ReactNode
}

/**
 * Makes an i18n instance available to `useI18n()`. Suspends until the initial locale's translations are loaded,
 * so wrap it in `<Suspense>` when any locale is lazy.
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
 * <I18nProvider i18n={i18n} locale={lang}>{children}</I18nProvider>
 * ```
 */
export const I18nProvider = ({ i18n, locale, translations, detect = true, syncDocument = true, children }: I18nProviderProps) => {
	if (translations) {
		for (const [key, value] of Object.entries(translations)) {
			if (value && !i18n.getTranslations(key)) i18n.addTranslations(key, value)
		}
	}
	const instance = useMemo(() => (locale === undefined ? i18n : i18n.clone({ locale })), [i18n, locale])
	const { locale: active } = useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
	if (!instance.isReady) use(instance.ready)

	// Detection reads browser-only state, so it runs after hydration: the server and client render the same markup.
	useLayoutEffect(() => {
		if (detect && locale === undefined) instance.detect().catch(console.error)
	}, [instance, detect, locale])

	useLayoutEffect(() => {
		if (!syncDocument) return
		document.documentElement.lang = active
		document.documentElement.dir = instance.scope(active).dir
	}, [instance, active, syncDocument])

	return <I18nContext value={instance}>{children}</I18nContext>
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
	const instance = use(I18nContext) as RegisteredI18n | null
	if (!instance) throw new Error('[textlate] useI18n() must be used inside <I18nProvider>.')
	const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
	return useMemo(() => {
		const { locale, dir, translate, format } = instance.scope(snapshot.locale)
		return {
			translate,
			format,
			locale,
			dir,
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
