import { cookieDetector, createI18n } from 'textlate'
import { defineRouting } from 'textlate/routing'

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

/** How locales appear in addresses: `/en`, `/bn`, `/ar`. Safe to import anywhere, client components included. */
export const routing = defineRouting({
	locales: i18n.locales,
	defaultLocale: i18n.sourceLocale,
	origin: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com',
	prefix: 'always'
})

/** Remembers the visitor's choice; `proxy.ts` reads it on their next visit to `/`. */
export const localeCookie = cookieDetector('NEXT_LOCALE')

declare module 'textlate' {
	interface Register {
		i18n: typeof i18n
	}
}
