import { cookieDetector, createI18n } from 'textlate'

// Shared by Server Components, Client Components and the proxy. The text in the code is English, so English needs
// no file; the other locales are code-split and loaded on demand, on the server and in the browser.
// `npm run i18n` (textlate translate) keeps src/locales in sync with the code.
export const i18n = createI18n({
	sourceLocale: 'en',
	locales: {
		bn: () => import('../locales/bn.json'),
		ar: () => import('../locales/ar.json')
	}
})

export type Locale = (typeof i18n.locales)[number]

/** Remembers the visitor's choice; `proxy.ts` reads it on their next visit to `/`. */
export const localeCookie = cookieDetector('NEXT_LOCALE')

declare module 'textlate' {
	interface Register {
		i18n: typeof i18n
	}
}
