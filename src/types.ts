import type { ReactElement, ReactNode } from 'react'

export type PluralCategory = Intl.LDMLPluralRule

/**
 * Plural forms, picked by `count` with `Intl.PluralRules`: `{ one: '{count} file', other: '{count} files' }`.
 * `other` is required. `zero` is used for a count of 0 whenever it is present, even in English.
 */
export type PluralForms = { readonly other: string } & { readonly [C in Exclude<PluralCategory, 'other'>]?: string }

/**
 * A message, written in your code in the source language:
 * - text: `'Hello, {name}!'`
 * - plural forms: `{ one: '{count} file', other: '{count} files' }`
 * - with `context`, for text that needs telling apart or a hint for the translator: `{ text: 'Open', context: 'ticket status' }`
 */
export type Message =
	| string
	| { readonly text: string; readonly context?: string | undefined; readonly other?: never }
	| (PluralForms & { readonly context?: string | undefined; readonly text?: never })

/** A translation file's plural forms. Forms the language doesn't use can be left out. */
export type PluralTranslation = { readonly [C in PluralCategory]?: string }

/**
 * A translation file, e.g. `es.json`: each message's text (see {@link Message}) → its translation.
 * `""` means not translated yet: the source text is shown instead.
 */
export interface Translations {
	readonly [text: string]: string | PluralTranslation
}

/** A locale's translations, or a loader such as `() => import('./locales/es.json')`. */
export type TranslationSource = Translations | (() => Promise<Translations | { readonly default: Translations }>)

/** Values that render as text. Numbers, bigints and dates are formatted for the locale. */
export type ParamValue = string | number | bigint | Date

/** Renders a `<tag>`: an element to wrap the chunks in, or a function that receives them. */
export type RichTag = ReactElement | ((chunks: ReactNode) => ReactNode)

export type RichValue = ParamValue | ReactNode | RichTag

type Whitespace = ' ' | '\t' | '\n' | '\r'
type TrimEnd<S extends string> = S extends `${infer Rest}${Whitespace}` ? TrimEnd<Rest> : S

// These mirror the parser's TOKEN pattern in message.ts, so the types ask for exactly what gets rendered.

/** `{name}` params. Names have no whitespace or braces: `{a b}` and `{}` stay text, and `{{a}}` is the param `a`. */
type ParamNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
	? Name extends `${string}{${infer Inner}`
		? ParamNames<`{${Inner}}${Rest}`>
		: (Name extends '' | `${string}${Whitespace}${string}` ? never : Name) | ParamNames<Rest>
	: never

type Letter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
type TagChar = Letter | Uppercase<Letter> | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '_' | '-'
type IsTagRest<S extends string> = S extends `${infer Char}${infer Rest}` ? (Char extends TagChar ? IsTagRest<Rest> : false) : true

/** A tag name is an ASCII letter followed by letters, digits, `_` or `-`, e.g. `link`, not `a href` or `a.b`. */
type ValidTagName<Name extends string> = Name extends `${infer First extends Letter | Uppercase<Letter>}${infer Rest}`
	? IsTagRest<Rest> extends true
		? Name
		: never
	: never

/** Tag names of `<tag>` and `<tag/>` (whitespace before `>` or `/>` allowed, so `<br />` is `br`). */
type TagNames<S extends string> = S extends `${string}<${infer Tag}>${infer Rest}`
	? Tag extends `${string}<${infer Inner}`
		? TagNames<`<${Inner}>${Rest}`>
		: (Tag extends `/${string}` ? never : ValidTagName<TrimEnd<Tag extends `${infer Name}/` ? Name : Tag>>) | TagNames<Rest>
	: never

/** The text whose params and tags a call must supply: the string, `text`, or every plural form. */
type TextOf<M> = M extends string
	? M
	: M extends { readonly text: infer T extends string }
		? T
		: Exclude<M[keyof M & PluralCategory], undefined> & string

type IsPlural<M> = M extends string ? false : M extends { readonly text: string } ? false : true
type IsLoose<S extends string> = string extends S ? true : false
type Count<M> = IsPlural<M> extends true ? { readonly count: number | bigint } : {}
/** A plural's `count` comes from `Count`; in any other message `{count}` is an ordinary param. */
type ParamsOf<M> = IsPlural<M> extends true ? Exclude<ParamNames<TextOf<M>>, 'count'> : ParamNames<TextOf<M>>

/** The values a message needs to render as a string. */
export type ValuesOf<M> = Count<M> &
	(IsLoose<TextOf<M>> extends true ? { readonly [name: string]: ParamValue } : { readonly [P in ParamsOf<M>]: ParamValue })

/** The values a message needs to render as React nodes: params may be nodes, and every tag needs a renderer. */
export type RichValuesOf<M> = Count<M> &
	(IsLoose<TextOf<M>> extends true
		? { readonly [name: string]: RichValue }
		: { readonly [P in ParamsOf<M>]: ParamValue | ReactNode } & { readonly [T in TagNames<TextOf<M>>]: RichTag })

/** The values argument is optional when the message needs none, and required otherwise. */
type Args<V> = {} extends V ? [values?: V] : [values: V]

/**
 * Translates a message into the scope's locale. Untranslated messages render in the source language.
 *
 * @example
 * ```tsx
 * translate('Hello, {name}!', { name: 'Ada' })                              // '¡Hola, Ada!'
 * translate({ one: '{count} file', other: '{count} files' }, { count: 3 })  // '3 archivos'
 * translate({ text: 'Open', context: 'ticket status' })                     // 'Abierto'
 * translate('Read the <link>terms</link>.', { link: <a href="/terms" /> })  // React nodes
 * ```
 */
export interface Translate {
	/** A string, when the message has no tags and every value is text, a number or a date. */
	<const M extends Message>(message: M, ...values: [TagNames<TextOf<M>>] extends [never] ? Args<ValuesOf<M>> : [never]): string
	/** React nodes, when the message has tags or a value is an element. */
	<const M extends Message>(message: M, ...values: Args<RichValuesOf<M>>): ReactNode
}

/**
 * `Intl` formatters for one locale.
 *
 * @example
 * ```ts
 * format.number(1234.5, { style: 'currency', currency: 'EUR' }) // '€1,234.50'
 * format.date(new Date(), { dateStyle: 'long' })
 * format.relativeTime(-1, 'day', { numeric: 'auto' }) // 'yesterday'
 * format.list(['a', 'b', 'c']) // 'a, b, and c'
 * format.displayName('bn', { type: 'language' }) // 'Bangla'
 * ```
 */
export interface Formatter {
	readonly locale: string
	number(value: number | bigint, options?: Intl.NumberFormatOptions): string
	date(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string
	relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string
	list(items: Iterable<string>, options?: Intl.ListFormatOptions): string
	displayName(code: string, options: Intl.DisplayNamesOptions): string | undefined
}

/** Everything for one locale: `const { translate, format } = await i18n.load('es')`. */
export interface Scope<L extends string = string> {
	readonly locale: L
	/** `'rtl'` for Arabic, Hebrew, Persian, Urdu and other right-to-left scripts. */
	readonly dir: 'ltr' | 'rtl'
	readonly translate: Translate
	readonly format: Formatter
}

/**
 * Reads a preferred locale from somewhere (navigator, storage, cookie, URL) and optionally remembers changes.
 *
 * @example
 * ```ts
 * const subdomainDetector: LocaleDetector = { detect: () => location.hostname.split('.')[0] }
 * ```
 */
export interface LocaleDetector {
	detect(): string | readonly string[] | null | undefined
	persist?(locale: string): void
}

export interface UntranslatedInfo {
	/** The message's text (a plural's `other` form). */
	text: string
	context: string | undefined
	locale: string
}

export interface I18nSnapshot<L extends string = string> {
	/** The active locale. Its translations (and its fallbacks') are loaded. */
	readonly locale: L
	/** A locale being loaded by `setLocale`. The active locale stays visible until it is ready. */
	readonly pendingLocale: L | undefined
}

/** An i18n instance. It is also the {@link Scope} of its active locale: `i18n.translate`, `i18n.format`, `i18n.locale`. */
export interface I18n<L extends string = string> extends Scope<L> {
	/** The language the text in your code is written in. */
	readonly sourceLocale: L
	/** The source locale, then every locale with translations. */
	readonly locales: readonly L[]
	/** True once the active locale and its fallbacks are loaded. */
	readonly isReady: boolean
	/** Settles when the initial locale and its fallbacks are loaded. */
	readonly ready: Promise<void>

	/**
	 * Load `locale` (best match) and switch to it once loaded. Concurrent calls: the last one wins.
	 * Detectors with `persist` remember the choice.
	 */
	setLocale(locale: string | readonly string[]): Promise<void>
	/** Pick a locale using the configured detectors and switch to it. A detected locale is not persisted. */
	detect(): Promise<void>
	/** Best registered match for a requested locale or preference list. */
	match(requested: string | readonly string[] | null | undefined): L | undefined
	/**
	 * Load a locale (best match; the source locale if none) and its fallbacks, without switching to it, and return
	 * its scope. Defaults to the active locale. Ideal for Server Components.
	 *
	 * @example
	 * ```tsx
	 * const { translate, format } = await i18n.load(lang)
	 * return <h1>{translate('Welcome back, {name}!', { name })}</h1>
	 * ```
	 */
	load(locale?: string): Promise<Scope<L>>
	/** The scope of a locale (best match), as far as it is loaded: untranslated text shows the source text. */
	scope(locale: string): Scope<L>
	/** Add a locale's translations, e.g. ones sent from the server. Replacing loaded ones re-renders subscribers. */
	addTranslations(locale: L, translations: Translations): void
	/** The loaded translations of a locale, if any. */
	getTranslations(locale: L): Translations | undefined

	/** A new instance with its own active locale that shares this one's config and loaded translations. */
	clone(options?: { locale?: string }): I18n<L>
	/** `subscribe` and `getSnapshot` follow the `useSyncExternalStore` contract; the React bindings use them. */
	subscribe(listener: () => void): () => void
	getSnapshot(): I18nSnapshot<L>
}
