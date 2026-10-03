import type { I18n, Message } from './types.js'

export { createI18n, type I18nConfig } from './core.js'
export { cookieDetector, htmlLangDetector, navigatorDetector, queryDetector, storageDetector, type CookieOptions } from './detectors.js'
export { getDirection, matchLocale, negotiateLocale, parseAcceptLanguage } from './locale.js'
export type * from './types.js'

/**
 * Marks a message that is chosen at runtime, so `textlate extract` finds it. It returns the message unchanged.
 *
 * @example
 * ```ts
 * const labels = { active: msg('Active'), banned: msg({ text: 'Banned', context: 'account status' }) }
 * translate(labels[user.status])
 * ```
 */
export const msg = <const M extends Message>(message: M): M => message

/**
 * Register your instance once to get typed locales from `useI18n()`.
 *
 * @example
 * ```ts
 * declare module 'textlate' {
 *   interface Register {
 *     i18n: typeof i18n
 *   }
 * }
 * ```
 */
export interface Register {}

export type RegisteredI18n = Register extends { i18n: infer Instance extends I18n<any> } ? Instance : I18n
export type RegisteredLocale = RegisteredI18n extends I18n<infer L> ? L : string
