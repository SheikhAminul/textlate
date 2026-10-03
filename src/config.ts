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
	/** The instructions the built-in providers send as the system prompt, including `ai.instructions`. */
	prompt: string
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
	/** Locales translated at the same time. Default `4`. */
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
	/** The locales to translate into. Default: every `<locale>.json` in `dir`. */
	locales?: readonly string[] | undefined
	/** Where the `<locale>.json` files live. Default `'src/locales'`. */
	dir?: string | undefined
	/** Files and directories to scan for messages. Default `['src']`. */
	include?: readonly string[] | undefined
	/** Functions whose first argument is a message. Default `['translate', 'msg']`. */
	functions?: readonly string[] | undefined
	/** Keep translations of text that is no longer in the code. Default `false`. */
	keepUnused?: boolean | undefined
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
