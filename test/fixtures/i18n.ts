import { createI18n, type LocaleDetector, type UntranslatedInfo } from '../../src/index.js'

/** Plural forms used across the tests. */
export const inbox = { zero: 'No messages', one: 'You have {count} message', other: 'You have {count} messages' } as const

export const ar = {
	'Plain text': 'نص عادي',
	'Hello, {name}!': 'مرحبا، {name}!',
	'You have {count} messages': {
		zero: 'لا رسائل',
		one: 'رسالة واحدة',
		two: 'رسالتان',
		few: '{count} رسائل',
		many: '{count} رسالة',
		other: '{count} رسالة'
	},
	Open: 'افتح',
	'Open // ticket status': 'مفتوحة'
}

/** A promise you settle by hand, to control when a lazy locale finishes loading. */
export const deferred = <T>() => {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

export interface TestOptions {
	locale?: string
	detectors?: LocaleDetector[]
	bn?: () => Promise<unknown>
	onUntranslated?: (info: UntranslatedInfo) => string | void
}

/** The code is English. ar is bundled; bn and bn-BD are lazy, and bn-BD falls back to bn. */
export const createTestI18n = (options: TestOptions = {}) =>
	createI18n({
		locale: options.locale,
		detectors: options.detectors,
		onUntranslated: options.onUntranslated,
		locales: {
			ar,
			bn: (options.bn ?? (() => import('./bn.json'))) as () => Promise<typeof import('./bn.json')>,
			'bn-BD': () => Promise.resolve({ default: { 'Hello, {name}!': 'হ্যালো (BD), {name}!' } })
		}
	})

export type TestI18n = ReturnType<typeof createTestI18n>

declare module '../../src/index.js' {
	interface Register {
		i18n: TestI18n
	}
}
