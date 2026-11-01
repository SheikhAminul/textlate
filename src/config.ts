import type { Message } from './types.js'

/** What a custom `ai.translate` function receives. */
export interface TranslateRequest {
	/** The language of the messages, e.g. `'en'`. */
	sourceLocale: string
	/** The language to translate into, e.g. `'es'`. */
	locale: string
	/** The plural categories `locale` uses, e.g. `['one', 'many', 'other']` for Spanish. */
	pluralCategories: readonly string[]
	/**
	 * The messages to translate, by id: text, plural forms, or either with a `context` (a hint, not to be translated).
	 * Return their translations by the same ids: text, or plural forms for `pluralCategories`.
	 */
	messages: Readonly<Record<string, Message>>
	/**
	 * For messages whose text changed since they were translated: the text they had, and its translation, by the same
	 * ids. Update the translation to the new text, changing no more than the change calls for.
	 */
	previous?: Readonly<Record<string, { readonly text: string; readonly translation: unknown }>> | undefined
	/** The instructions the built-in providers send as the system prompt, including `ai.instructions` and the glossary. */
	prompt: string
}

/**
 * How a term is translated, in every locale: kept as it is (a product or brand name), explained to the translator, or
 * translated a set way per locale.
 *
 * @example
 * ```ts
 * glossary: {
 *   TareAI: { keep: true },
 *   workflow: { note: 'an automation the user builds', translations: { de: 'Workflow', ja: 'ワークフロー' } }
 * }
 * ```
 */
export interface GlossaryTerm {
	/** Never translate it: the translation must contain it as it is written. */
	keep?: boolean | undefined
	/** What it means here, for the translator. */
	note?: string | undefined
	/** Its translation per locale, e.g. `{ de: 'Workflow' }`. Locales left out are up to the translator. */
	translations?: Readonly<Record<string, string>> | undefined
}

/** One namespace's messages: where they're found, and how. */
export interface NamespaceConfig {
	/** Files and directories whose messages go into this namespace's files. */
	include: readonly string[]
	/** Files and directories under `include` to leave out. */
	exclude?: readonly string[] | undefined
	/** Functions whose first argument is a message. Default: the config's `functions`. */
	functions?: readonly string[] | undefined
	/** Object properties whose string values are messages, e.g. `['label', 'description']`. Default: the config's `properties`. */
	properties?: readonly string[] | undefined
}

export interface AIConfig {
	/**
	 * `'anthropic'` (default), `'openai'` or `'google'` (Gemini). `'openai'` also covers OpenAI-compatible APIs such
	 * as OpenRouter, Groq, Mistral, DeepSeek or a local Ollama: set `baseUrl`.
	 */
	provider?: 'anthropic' | 'openai' | 'google' | undefined
	/** The model. Defaults to `'claude-opus-5-5'` for Anthropic; required for the other providers. */
	model?: string | undefined
	/**
	 * Defaults to the `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` environment variable, which is also
	 * read from `.env` and `.env.local`. Prefer those to writing a key in a file you commit.
	 */
	apiKey?: string | undefined
	/** The API's base URL, e.g. `'http://localhost:11434/v1'` for Ollama or `'https://openrouter.ai/api/v1'`. */
	baseUrl?: string | undefined
	/** Context for the translator: what the product is, tone, terms to keep or how to translate them. */
	instructions?: string | undefined
	/** Messages per request. Default `40`. */
	batchSize?: number | undefined
	/** Requests sent at the same time, across every locale. Default `8`. */
	concurrency?: number | undefined
	/** Extra fields for every request body, e.g. `{ temperature: 0 }` or `{ output_config: { effort: 'low' } }`. */
	body?: Record<string, unknown> | undefined
	/** Translate with your own code (any SDK or service) instead of a built-in provider. */
	translate?: ((request: TranslateRequest) => Promise<Record<string, unknown>>) | undefined
}

/** Settings for the `textlate` command line, in `textlate.config.{ts,mts,js,mjs,json}`. */
export interface Config {
	/** The language the text in your code is written in. Default `'en'`. */
	sourceLocale?: string | undefined
	/** The locales to translate into. Default: every locale with a file (or, with namespaces, a folder) in `dir`. */
	locales?: readonly string[] | undefined
	/** Where the translation files live: `<dir>/<locale>.json`, or `<dir>/<locale>/<namespace>.json`. Default `'src/locales'`. */
	dir?: string | undefined
	/** Files and directories to scan for messages. Default `['src']`. Ignored with `namespaces`. */
	include?: readonly string[] | undefined
	/** Files and directories under `include` to leave out, e.g. tests. */
	exclude?: readonly string[] | undefined
	/** Functions whose first argument is a message. Default `['translate', 'msg']`. */
	functions?: readonly string[] | undefined
	/** Object properties whose string values are messages, e.g. `['label', 'description']`. Default none. */
	properties?: readonly string[] | undefined
	/**
	 * Split the translations into files per namespace, `<dir>/<locale>/<namespace>.json`, each with the messages of its
	 * own part of the code, so a page loads only what it shows. A message used in two namespaces is in both files, and
	 * translated once.
	 *
	 * @example
	 * ```ts
	 * namespaces: {
	 *   app: { include: ['app', 'components', 'lib'] },
	 *   catalog: { include: ['packages/flow/src/connectors'], properties: ['label', 'description'] }
	 * }
	 * ```
	 */
	namespaces?: Readonly<Record<string, NamespaceConfig>> | undefined
	/** Keep translations of text that is no longer in the code. Default `false`. */
	keepUnused?: boolean | undefined
	/**
	 * When a message's text changes, start its translation from the old text's (when they are alike), marked as needing
	 * an update: `textlate translate` updates it, and `textlate check` fails until it has. Default `true`.
	 */
	carryOver?: boolean | undefined
	/** Terms to keep, explain or translate a set way. They go to the translator, and kept terms are checked. */
	glossary?: Readonly<Record<string, GlossaryTerm>> | undefined
	/**
	 * Locales whose translations must be reviewed by a person before `textlate check` passes. A translation counts as
	 * reviewed once someone edits it, or `textlate accept` marks it. `['*']` for every locale. Default none.
	 */
	reviewed?: readonly string[] | undefined
	/** How `textlate translate` translates. */
	ai?: AIConfig | undefined
}

/**
 * Type-checks a config file.
 *
 * @example
 * ```ts
 * // textlate.config.js
 * import { defineConfig } from 'textlate/config'
 *
 * export default defineConfig({
 *   sourceLocale: 'en',
 *   locales: ['es', 'bn', 'ar'],
 *   ai: { instructions: 'A banking app. Formal tone. Keep "Pocket" untranslated.' }
 * })
 * ```
 */
export const defineConfig = (config: Config): Config => config
