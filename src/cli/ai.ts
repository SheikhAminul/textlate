import type { AIConfig, TranslateRequest } from '../config.js'
import type { Message } from '../types.js'
import { checkTranslation, isPlural, isTranslated, pluralCategories } from './catalog.js'

export interface Runtime {
	fetch: typeof fetch
	sleep: (ms: number) => Promise<void>
	env: Readonly<Record<string, string | undefined>>
}

/** Sends one batch to a model and returns its answer: translations by id. */
export type Provider = (request: TranslateRequest) => Promise<Record<string, unknown>>

export const DEFAULT_MODEL = 'claude-opus-5-5'
/** The environment variables each provider's key is read from, the first being the one the CLI writes. */
export const API_KEYS = { anthropic: ['ANTHROPIC_API_KEY'], openai: ['OPENAI_API_KEY'], google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }
// Models that take server-side refusal fallbacks (`fallbacks: "default"`) on the Claude API.
const FALLBACK_MODELS = /^claude-(?:fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/

/** An API error. `retryable` ones (rate limits, overload, server errors) were already retried. */
export class ApiError extends Error {}
/** The answer was cut off at the output limit: the batch is split and sent again. */
class Truncated extends Error {}

const languageName = (locale: string) => {
	try {
		return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale
	} catch {
		return locale
	}
}

/** The system prompt for translating from `sourceLocale` into `locale`. */
export const buildPrompt = (sourceLocale: string, locale: string, instructions?: string) => {
	const source = languageName(sourceLocale)
	const target = languageName(locale)
	return `You translate the user interface of a software application from ${source} (${sourceLocale}) into ${target} (${locale}).

Rules:
- Write natural, idiomatic ${target}, as a native speaker expects to read it in an app. Keep the meaning, tone and length close to the source.
- Keep every placeholder in braces, such as {name} or {count}, exactly as written: never translate, rename or remove it. Move it wherever the grammar needs it.
- Keep every tag, such as <link>…</link> or <br/>, with the same name, and translate the text between tags.
- Keep leading and trailing whitespace.
- Each input item has the source "text", or "plural" forms keyed by plural category, where {count} is the number. Answer a "text" with a string. Answer "plural" forms with an object that has exactly the categories ${target} uses (${pluralCategories(locale).join(', ')}), plus "zero" when the source has one.
- An item's "context" says where or how the text is used. Use it to choose the right words; never translate or include it.
- Answer with a JSON object that maps each id of the input to its translation, and nothing else.${instructions ? `\n\nAbout this application:\n${instructions.trim()}` : ''}`
}

/** A JSON schema for the answer, so providers with structured outputs can only return the expected shape. */
const answerSchema = (request: TranslateRequest) => {
	const properties: Record<string, unknown> = {}
	for (const [id, source] of Object.entries(request.messages)) {
		const categories = pluralCategories(request.locale, source)
		properties[id] =
			!isPlural(source)
				? { type: 'string' }
				: {
						type: 'object',
						properties: Object.fromEntries(categories.map(category => [category, { type: 'string' }])),
						required: categories,
						additionalProperties: false
					}
	}
	return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

/** The JSON object in a model's answer, with or without a ```json fence around it. */
const parseAnswer = (text: string): Record<string, unknown> => {
	const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
	const value: unknown = JSON.parse(json || 'null')
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The answer is not a JSON object.')
	return value as Record<string, unknown>
}

const merge = (base: Record<string, unknown>, extra: Record<string, unknown> | undefined): Record<string, unknown> => {
	const result = { ...base }
	for (const [key, value] of Object.entries(extra ?? {})) {
		const current = result[key]
		const isObject = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item)
		result[key] = isObject(current) && isObject(value) ? merge(current, value) : value
	}
	return result
}

const errorMessage = (body: string) => {
	try {
		const { error } = JSON.parse(body) as { error?: { message?: string } | string }
		const message = typeof error === 'string' ? error : error?.message
		if (message) return message
	} catch {}
	return body.slice(0, 300) || 'no details'
}

/** POST JSON, retrying rate limits, overload, server and network errors with backoff (honouring `retry-after`). */
const post = async (runtime: Runtime, url: string, headers: Record<string, string>, body: unknown): Promise<any> => {
	const retries = 4
	for (let attempt = 0; ; attempt++) {
		const delay = 1000 * 2 ** attempt * (0.75 + Math.random() / 2)
		let response: Response
		try {
			response = await runtime.fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10 * 60_000)
			})
		} catch (error) {
			if (attempt >= retries) throw new ApiError(`Request to ${new URL(url).host} failed: ${(error as Error).message}`)
			await runtime.sleep(delay)
			continue
		}
		if (response.ok) return response.json()
		const text = await response.text()
		const retryable = [408, 409, 429].includes(response.status) || response.status >= 500
		if (!retryable || attempt >= retries) throw new ApiError(`${new URL(url).host} answered ${response.status}: ${errorMessage(text)}`)
		const retryAfter = Number(response.headers.get('retry-after'))
		await runtime.sleep(retryAfter > 0 ? retryAfter * 1000 : delay)
	}
}

/** The provider `ai` configures. Throws when it needs an API key or model that isn't set. */
export const createProvider = (ai: AIConfig, runtime: Runtime): Provider => {
	if (ai.translate) return ai.translate
	const provider = ai.provider ?? 'anthropic'
	if (!(provider in API_KEYS)) throw new Error(`Unknown AI provider "${provider}". Use anthropic, openai or google.`)
	const names = API_KEYS[provider]
	const apiKey = ai.apiKey ?? names.map(name => runtime.env[name]).find(Boolean)
	// A custom base URL may be a local server (e.g. Ollama) that needs no key.
	if (!apiKey && !ai.baseUrl) throw new Error(`Set ${names[0]} (in the environment or .env), or ai.apiKey in the config.`)
	const model = ai.model ?? (provider === 'anthropic' ? DEFAULT_MODEL : undefined)
	if (!model) throw new Error(`Set ai.model for the ${provider} provider.`)

	// Each message as the prompt describes it: { text } or { plural }, with its context.
	const user = (request: TranslateRequest) =>
		JSON.stringify(
			Object.fromEntries(
				Object.entries(request.messages).map(([id, message]) => {
					if (typeof message === 'string') return [id, { text: message }]
					const { context, text, ...forms } = message
					return [id, { ...(text === undefined ? { plural: forms } : { text }), ...(context && { context }) }]
				})
			),
			null,
			1
		)

	if (provider === 'anthropic') {
		const fallbacks = !ai.baseUrl && FALLBACK_MODELS.test(model)
		return async request => {
			const response = await post(
				runtime,
				`${ai.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
				{
					...(apiKey && { 'x-api-key': apiKey }),
					'anthropic-version': '2023-06-01',
					...(fallbacks && { 'anthropic-beta': 'server-side-fallback-2026-07-01' })
				},
				merge(
					{
						model,
						max_tokens: 16000,
						system: request.prompt,
						messages: [{ role: 'user', content: user(request) }],
						output_config: { format: { type: 'json_schema', schema: answerSchema(request) }, ...(model === DEFAULT_MODEL && { effort: 'medium' }) },
						// If a safety classifier declines the request, it is retried on another model instead of failing.
						...(fallbacks && { fallbacks: 'default' })
					},
					ai.body
				)
			)
			if (response.stop_reason === 'max_tokens') throw new Truncated()
			if (response.stop_reason === 'refusal') throw new Error(`The model declined (${response.stop_details?.category ?? 'refusal'}).`)
			return parseAnswer(
				(response.content as { type: string; text?: string }[])
					.filter(block => block.type === 'text')
					.map(block => block.text)
					.join('')
			)
		}
	}

	if (provider === 'openai') {
		return async request => {
			const response = await post(
				runtime,
				`${ai.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`,
				apiKey ? { authorization: `Bearer ${apiKey}` } : {},
				merge(
					{
						model,
						messages: [
							{ role: 'system', content: request.prompt },
							{ role: 'user', content: user(request) }
						],
						response_format: { type: 'json_object' }
					},
					ai.body
				)
			)
			const choice = response.choices?.[0]
			if (choice?.finish_reason === 'length') throw new Truncated()
			if (choice?.message?.refusal) throw new Error(`The model declined: ${choice.message.refusal}`)
			return parseAnswer(choice?.message?.content ?? '')
		}
	}

	return async request => {
		const response = await post(
			runtime,
			`${ai.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${model}:generateContent`,
			apiKey ? { 'x-goog-api-key': apiKey } : {},
			merge(
				{
					systemInstruction: { parts: [{ text: request.prompt }] },
					contents: [{ role: 'user', parts: [{ text: user(request) }] }],
					generationConfig: { responseMimeType: 'application/json' }
				},
				ai.body
			)
		)
		const candidate = response.candidates?.[0]
		if (candidate?.finishReason === 'MAX_TOKENS') throw new Truncated()
		if (!candidate?.content) throw new Error(`The model declined (${response.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no answer'}).`)
		return parseAnswer((candidate.content.parts as { text?: string }[]).map(part => part.text ?? '').join(''))
	}
}

export interface TranslateTask {
	provider: Provider
	sourceLocale: string
	locale: string
	/** Messages to translate, by their text. */
	messages: ReadonlyMap<string, Message>
	instructions?: string | undefined
	batchSize?: number | undefined
	/** Called with each batch's valid translations, by text, so progress is saved as it goes. */
	onTranslated: (translations: Record<string, unknown>) => void
}

export interface TranslateOutcome {
	translated: number
	/** Messages left untranslated, with why. */
	failed: { text: string; reason: string }[]
}

/** A plural's answer may hold only the forms that are needed; a language with only `other` may answer with text. */
const normalize = (source: Message, value: unknown, locale: string) => {
	if (!isPlural(source)) return value
	const categories = pluralCategories(locale, source)
	if (typeof value === 'string') return categories.join() === 'other' ? { other: value } : value
	if (typeof value !== 'object' || value === null) return value
	return Object.fromEntries(categories.map(category => [category, (value as Record<string, unknown>)[category]]))
}

/**
 * Translate `messages` in batches. Each translation is checked (not empty, same params and tags as the source, every plural
 * form present); invalid ones are sent once more, then reported. A batch cut off at the output limit is split.
 */
export const translateMessages = async (task: TranslateTask): Promise<TranslateOutcome> => {
	const prompt = buildPrompt(task.sourceLocale, task.locale, task.instructions)
	const outcome: TranslateOutcome = { translated: 0, failed: [] }

	const send = async (items: [string, Message][], retry: boolean): Promise<void> => {
		const ids = new Map(items.map(([text, source], index) => [String(index + 1), { text, source }]))
		let answer: Record<string, unknown>
		try {
			answer = await task.provider({
				sourceLocale: task.sourceLocale,
				locale: task.locale,
				pluralCategories: pluralCategories(task.locale),
				messages: Object.fromEntries([...ids].map(([id, { source }]) => [id, source])),
				prompt
			})
		} catch (error) {
			if (error instanceof ApiError) throw error
			if (error instanceof Truncated && items.length > 1) {
				const half = Math.ceil(items.length / 2)
				await send(items.slice(0, half), retry)
				return send(items.slice(half), retry)
			}
			if (!retry) return send(items, true)
			const reason = error instanceof Truncated ? 'the answer was too long' : (error as Error).message
			for (const [text] of items) outcome.failed.push({ text, reason })
			return
		}

		const valid: Record<string, unknown> = {}
		const again: [string, Message][] = []
		for (const [id, { text, source }] of ids) {
			const value = normalize(source, answer[id], task.locale)
			const problems =
				value === undefined
					? ['is missing from the answer']
					: checkTranslation(source, value, task.locale).concat(isTranslated(value) ? [] : ['is empty'])
			if (!problems.length) valid[text] = value
			else if (!retry) again.push([text, source])
			else outcome.failed.push({ text, reason: `the translation ${problems.join(', ')}` })
		}
		if (Object.keys(valid).length) {
			task.onTranslated(valid)
			outcome.translated += Object.keys(valid).length
		}
		if (again.length) await send(again, true)
	}

	const items = [...task.messages]
	const size = Math.max(1, task.batchSize ?? 40)
	for (let start = 0; start < items.length; start += size) await send(items.slice(start, start + size), false)
	return outcome
}
