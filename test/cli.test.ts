// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPrompt, createProvider, translateMessages, type Runtime } from '../src/cli/ai.js'
import { checkTranslation, isTranslated, pluralCategories, syncMessages } from '../src/cli/catalog.js'
import { PassThrough } from 'node:stream'
import { envFile, saveAISettings, saveEnvKey } from '../src/cli/edit.js'
import { Cancelled, createPrompter, type Prompter } from '../src/cli/prompt.js'
import { run } from '../src/cli/run.js'
import { scanCode } from '../src/cli/scan.js'
import { missingAISettings } from '../src/cli/setup.js'
import type { TranslateRequest } from '../src/config.js'
import type { Message } from '../src/types.js'

const files = { one: '{count} file', other: '{count} files' }

describe('scanCode', () => {
	const keys = (code: string, functions?: string[]) => [...scanCode(code, functions).messages.keys()]

	it('finds messages passed to t, in order of first use', () => {
		const code = `
			const { translate } = useI18n()
			return <>
				<div>{translate('Welcome, {firstName}!', { firstName: 'John' })}</div>
				{translate("I am fine.")}
				{translate(\`Read the <link>terms</link>.\`, { link: <a /> })}
				{i18n.translate('Welcome, {firstName}!', { firstName })}
				{translate(
					'Spans lines',
				)}
				<p>Don't {translate('After an apostrophe')}</p>
			</>
		`
		expect(keys(code)).toEqual(['Welcome, {firstName}!', 'I am fine.', 'Read the <link>terms</link>.', 'Spans lines', 'After an apostrophe'])
	})

	it('finds plurals and context', () => {
		const { messages } = scanCode(`
			translate({ one: '{count} file', other: '{count} files' }, { count })
			translate({ zero: "No files", 'one': 'One file', "other": \`{count} files\`, }, { count })
			translate('{count} files')
			translate({ text: 'Open', context: 'ticket status' })
			translate({ text: 'Open' })
			translate({ one: '{count} seat', other: '{count} seats', context: 'airplane' }, { count })
		`)
		expect([...messages]).toEqual([
			['{count} files', { zero: 'No files', one: 'One file', other: '{count} files' }],
			['Open // ticket status', { text: 'Open', context: 'ticket status' }],
			['Open', 'Open'],
			['{count} seats // airplane', { one: '{count} seat', other: '{count} seats', context: 'airplane' }]
		])
	})

	it('finds msg() and custom function names', () => {
		expect(keys(`const labels = { active: msg('Active'), open: msg({ text: 'Open', context: 'door' }) }`)).toEqual(['Active', 'Open // door'])
		expect(keys(`$t('Vue'); __('Underscore'); translate('Default')`, ['$t', '__'])).toEqual(['Vue', 'Underscore'])
	})

	it('decodes escapes in JS strings', () => {
		const code = String.raw`translate('Don\'t'); translate("Say \"hi\"\n"); translate('é\u{1F600}\x41'); translate(` + '`a\\`b`)'
		expect(keys(code)).toEqual(["Don't", 'Say "hi"\n', 'é😀A', 'a`b'])
	})

	it('skips commented-out code, other functions and definitions', () => {
		const code = `
			// translate('Commented')
			/* translate('Blocked') */
			{/* translate('In JSX') */}
			translate.has('Checked')
			set('Setter')
			function translate(message) {}
			translate()
			translate(labels[status])
			translate('Kept')
		`
		const result = scanCode(code)
		expect([...result.messages.keys()]).toEqual(['Kept'])
		expect(result.warnings).toEqual([])
	})

	it('reports messages it cannot read, with their line', () => {
		const code = [
			"translate('Hello ' + name)",
			'translate(`Hi ${name}`)',
			'translate({ text: label })',
			"translate({ one: 'x' })",
			"translate({ text: 'a', other: 'b' })",
			"translate({ context: 'c' })"
		].join('\n')
		const result = scanCode(code, undefined, 'app.tsx')
		expect(result.warnings.map(({ line, message }) => `${line} ${message}`)).toEqual([
			"1 translate(…): the text is built at runtime, so it can't be extracted. Write it as one string with {params} for the values.",
			"2 translate(…): the text is built at runtime, so it can't be extracted. Write it as one string with {params} for the values.",
			"3 translate(…): the text is built at runtime, so it can't be extracted. Write it as one string with {params} for the values.",
			'4 translate(…): plural forms need an `other` form.',
			'5 translate(…): a message has either `text` or plural forms, not both.',
			'6 translate(…): a message object needs `text` or plural forms.'
		])
		expect(result.warnings[0]?.file).toBe('app.tsx')
	})
})

describe('catalog', () => {
	it('knows which plural forms each language needs', () => {
		expect(pluralCategories('en')).toEqual(['one', 'other'])
		expect(pluralCategories('ar')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other'])
		expect(pluralCategories('ja')).toEqual(['other'])
		expect(pluralCategories('ja', { zero: 'None', other: '{count}' })).toEqual(['zero', 'other'])
	})

	it('checks params, tags and plural forms', () => {
		expect(checkTranslation('Hi, {name}!', '¡Hola, {name}!', 'es')).toEqual([])
		expect(checkTranslation('Hi, {name}!', '¡Hola!', 'es')).toEqual(['is missing {name}'])
		expect(checkTranslation('Hi, {name}!', '¡Hola, {nombre}!', 'es')).toEqual(['is missing {name}', 'has an unknown {nombre}'])
		expect(checkTranslation('Read <link>this</link>', 'Lee <a>esto</a>', 'es')).toEqual(['is missing <link>', 'has an unknown <a>'])
		expect(checkTranslation('Hi', { one: 'x', other: 'y' }, 'es')).toEqual(['should be text, not plural forms'])

		expect(checkTranslation(files, { one: 'Un archivo', many: '{count} de archivos', other: '{count} archivos' }, 'es')).toEqual([])
		expect(checkTranslation(files, { one: '{count} archivo', other: '{count} archivos' }, 'es')).toEqual(['is missing the "many" form'])
		expect(checkTranslation(files, '{count} archivos', 'es')).toEqual(['should be plural forms: one, many, other'])
		expect(checkTranslation(files, '{count} ファイル', 'ja')).toEqual([])
		expect(checkTranslation({ one: 'One in {folder}', other: '{count} in {folder}' }, { other: '{count}' }, 'ja')).toEqual(['is missing {folder}'])
		expect(checkTranslation({ text: 'Assigned to {name}', context: 'ticket' }, 'Asignado', 'es')).toEqual(['is missing {name}'])
		expect(checkTranslation({ ...files, context: 'folder' }, { one: 'a', many: 'b', other: 'c' }, 'es')).toEqual([])
	})

	it('treats empty strings and forms as untranslated', () => {
		expect(isTranslated('Hola')).toBe(true)
		expect(isTranslated('')).toBe(false)
		expect(isTranslated(undefined)).toBe(false)
		expect(isTranslated({ one: 'x', other: '' })).toBe(false)
		expect(isTranslated({ one: 'x', other: 'y' })).toBe(true)
	})

	it('syncs a locale with the code: keeps translations, adds placeholders, drops unused text', () => {
		const sources = new Map<string, Message>([
			['Hi', 'Hi'],
			['{count} files', files],
			['New', 'New'],
			['Open // ticket status', { text: 'Open', context: 'ticket status' }]
		])
		const result = syncMessages(sources, { Gone: 'Ido', '{count} files': '', Hi: 'Hola' }, 'es')
		expect(result.messages).toEqual({ Hi: 'Hola', '{count} files': { one: '', many: '', other: '' }, New: '', 'Open // ticket status': '' })
		expect(Object.keys(result.messages)).toEqual(['Hi', '{count} files', 'New', 'Open // ticket status'])
		expect(result).toMatchObject({ added: 2, removed: 1 })

		expect(syncMessages(new Map([['A', 'A']]), { Old: 'Viejo' }, 'es', true).messages).toEqual({ A: '', Old: 'Viejo' })
		expect(JSON.stringify(syncMessages(new Map([['__proto__', '__proto__']]), {}, 'es').messages)).toBe('{"__proto__":""}')
	})
})

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A runtime whose fetch answers with `respond` and records each request. */
const fakeRuntime = (respond: (body: any, url: string, init: RequestInit) => Response, env: Record<string, string> = {}) => {
	const requests: { url: string; headers: Record<string, string>; body: any }[] = []
	const runtime: Runtime = {
		env,
		sleep: vi.fn(async () => {}),
		fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init!.body))
			requests.push({ url: String(url), headers: init!.headers as Record<string, string>, body })
			return respond(body, String(url), init!)
		}) as typeof fetch
	}
	return { runtime, requests }
}

/** A `Prompter` that answers in order and records the questions. An answer of `undefined` takes the default. */
const scripted = (answers: readonly unknown[]) => {
	const asked: string[] = []
	let next = 0
	const take = () => (next < answers.length ? answers[next++] : undefined)
	const prompt: Prompter = {
		select: async <T>(question: string, choices: readonly { value: T }[], fallback?: T) => {
			asked.push(question)
			return (take() as T | undefined) ?? fallback ?? choices[0]!.value
		},
		text: async (question: string, fallback = '') => {
			asked.push(question)
			return (take() as string | undefined) ?? fallback
		},
		secret: async (question: string) => {
			asked.push(question)
			return (take() as string | undefined) ?? ''
		},
		confirm: async (question: string, fallback = true) => {
			asked.push(question)
			return (take() as boolean | undefined) ?? fallback
		},
		close: () => {}
	}
	return { prompt, asked }
}

/** What a model is sent per message: `{ text }` or `{ plural }`, with an optional `context`. */
type Item = { text?: string; plural?: Record<string, string>; context?: string }

/** Answers a request's items with `translate`, as a model would. */
const answer = (body: any, translate: (item: Item) => unknown) => {
	const content: string = body.messages?.at(-1)?.content ?? body.contents[0].parts[0].text
	const items = JSON.parse(content) as Record<string, Item>
	return Object.fromEntries(Object.entries(items).map(([id, item]) => [id, translate(item)]))
}

const toSpanish = ({ text, plural }: Item): unknown =>
	text !== undefined ? `ES ${text}` : { one: `ES ${plural!.one ?? plural!.other}`, many: `ES ${plural!.other}`, other: `ES ${plural!.other}` }

/** A custom `ai.translate` that answers like the model, from the messages it receives. */
const customProvider = (request: TranslateRequest) =>
	Object.fromEntries(
		Object.entries(request.messages).map(([id, message]) => [
			id,
			toSpanish(typeof message === 'string' ? { text: message } : message.text !== undefined ? { text: message.text } : { plural: message as Record<string, string> })
		])
	)

const request: TranslateRequest = {
	sourceLocale: 'en',
	locale: 'es',
	pluralCategories: ['one', 'many', 'other'],
	messages: { '1': 'Hi, {name}!', '2': files, '3': { text: 'Open', context: 'ticket status' } },
	prompt: 'PROMPT'
}

describe('providers', () => {
	it('calls the Claude API with structured outputs and refusal fallbacks', async () => {
		const { runtime, requests } = fakeRuntime(body =>
			json({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer(body, toSpanish)) }] })
		)
		const provider = createProvider({ apiKey: 'sk-test', body: { output_config: { effort: 'low' } } }, runtime)
		expect(await provider(request)).toEqual({
			'1': 'ES Hi, {name}!',
			'2': { one: 'ES {count} file', many: 'ES {count} files', other: 'ES {count} files' },
			'3': 'ES Open'
		})

		const [{ url, headers, body }] = requests as [(typeof requests)[0]]
		expect(JSON.parse(body.messages[0].content)).toEqual({
			'1': { text: 'Hi, {name}!' },
			'2': { plural: files },
			'3': { text: 'Open', context: 'ticket status' }
		})
		expect(url).toBe('https://api.anthropic.com/v1/messages')
		expect(headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' })
		expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, system: 'PROMPT', fallbacks: 'default' })
		expect(body.output_config.effort).toBe('low')
		expect(body.output_config.format.type).toBe('json_schema')
		expect(body.output_config.format.schema).toEqual({
			type: 'object',
			properties: {
				'1': { type: 'string' },
				'2': {
					type: 'object',
					properties: { one: { type: 'string' }, many: { type: 'string' }, other: { type: 'string' } },
					required: ['one', 'many', 'other'],
					additionalProperties: false
				},
				'3': { type: 'string' }
			},
			required: ['1', '2', '3'],
			additionalProperties: false
		})
	})

	it('reads API keys from the environment', async () => {
		const { runtime, requests } = fakeRuntime(() => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }), { ANTHROPIC_API_KEY: 'from-env' })
		await createProvider({ model: 'claude-haiku-4-5' }, runtime)(request)
		expect(requests[0]?.headers['x-api-key']).toBe('from-env')
		expect(requests[0]?.headers['anthropic-beta']).toBeUndefined()
		expect(requests[0]?.body.fallbacks).toBeUndefined()

		expect(() => createProvider({}, fakeRuntime(() => json({})).runtime)).toThrow('Set ANTHROPIC_API_KEY')
		expect(() => createProvider({ provider: 'openai', apiKey: 'x' }, runtime)).toThrow('Set ai.model')
	})

	it('calls OpenAI-compatible APIs', async () => {
		const { runtime, requests } = fakeRuntime(body =>
			json({ choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(answer(body, toSpanish)) + '\n```' } }] })
		)
		const provider = createProvider({ provider: 'openai', model: 'llama3', baseUrl: 'http://localhost:11434/v1' }, runtime)
		expect((await provider(request))['1']).toBe('ES Hi, {name}!')
		expect(requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
		expect(requests[0]?.headers.authorization).toBeUndefined()
		expect(requests[0]?.body).toMatchObject({ model: 'llama3', response_format: { type: 'json_object' } })
		expect(requests[0]?.body.messages[0]).toEqual({ role: 'system', content: 'PROMPT' })
	})

	it('calls Gemini', async () => {
		const { runtime, requests } = fakeRuntime(body =>
			json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer(body, toSpanish)) }] } }] })
		)
		const provider = createProvider({ provider: 'google', model: 'gemini-x' }, { ...runtime, env: { GEMINI_API_KEY: 'g-key' } })
		expect((await provider(request))['1']).toBe('ES Hi, {name}!')
		expect(requests[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent')
		expect(requests[0]?.headers['x-goog-api-key']).toBe('g-key')
		expect(requests[0]?.body.systemInstruction).toEqual({ parts: [{ text: 'PROMPT' }] })
	})

	it('retries rate limits and server errors, honouring retry-after', async () => {
		let calls = 0
		const { runtime } = fakeRuntime(() =>
			++calls === 1
				? json({ error: { message: 'slow down' } }, 429, { 'retry-after': '3' })
				: calls === 2
					? json({ error: { message: 'overloaded' } }, 529)
					: json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"1":"ok"}' }] })
		)
		expect(await createProvider({ apiKey: 'k' }, runtime)(request)).toEqual({ '1': 'ok' })
		expect(runtime.sleep).toHaveBeenNthCalledWith(1, 3000)
		expect(calls).toBe(3)
	})

	it('fails fast on errors a retry cannot fix', async () => {
		const { runtime } = fakeRuntime(() => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401))
		await expect(createProvider({ apiKey: 'bad' }, runtime)(request)).rejects.toThrow('api.anthropic.com answered 401: invalid x-api-key')
		expect(runtime.fetch).toHaveBeenCalledTimes(1)
	})
})

describe('translateMessages', () => {
	const messages = new Map<string, Message>([
		['Hi, {name}!', 'Hi, {name}!'],
		['{count} files', files],
		['Bye', 'Bye']
	])

	it('translates in batches and saves each one', async () => {
		const provider = vi.fn(async (request: TranslateRequest) => customProvider(request))
		const saved: Record<string, unknown>[] = []
		const outcome = await translateMessages({ provider, sourceLocale: 'en', locale: 'es', messages, batchSize: 2, onTranslated: batch => saved.push(batch) })
		expect(outcome).toEqual({ translated: 3, failed: [] })
		expect(provider).toHaveBeenCalledTimes(2)
		expect(provider.mock.calls[0]?.[0].messages).toEqual({ '1': 'Hi, {name}!', '2': files })
		expect(saved).toEqual([
			{ 'Hi, {name}!': 'ES Hi, {name}!', '{count} files': { one: 'ES {count} file', many: 'ES {count} files', other: 'ES {count} files' } },
			{ Bye: 'ES Bye' }
		])
	})

	it('sends invalid translations once more, then reports them', async () => {
		const provider = vi
			.fn<(request: TranslateRequest) => Promise<Record<string, unknown>>>()
			.mockResolvedValueOnce({ '1': '¡Hola!', '2': { one: 'uno', many: 'muchos', other: '{count}' }, '3': 'Adiós' })
			.mockResolvedValueOnce({ '1': '¡Hola!' })
		const saved: Record<string, unknown> = {}
		const outcome = await translateMessages({ provider, sourceLocale: 'en', locale: 'es', messages, onTranslated: batch => Object.assign(saved, batch) })
		expect(provider.mock.calls[1]?.[0].messages).toEqual({ '1': 'Hi, {name}!' })
		expect(saved).toEqual({ '{count} files': { one: 'uno', many: 'muchos', other: '{count}' }, Bye: 'Adiós' })
		expect(outcome.failed).toEqual([{ text: 'Hi, {name}!', reason: 'the translation is missing {name}' }])
	})

	it('treats an empty translation as invalid', async () => {
		const provider = vi
			.fn<(request: TranslateRequest) => Promise<Record<string, unknown>>>()
			.mockResolvedValueOnce({ '1': '', '2': { one: 'uno', many: '', other: 'otros' }, '3': 'Adiós' })
			.mockResolvedValueOnce({ '1': '¡Hola, {name}!', '2': { one: 'uno', many: 'muchos', other: 'otros' } })
		const saved: Record<string, unknown> = {}
		const outcome = await translateMessages({ provider, sourceLocale: 'en', locale: 'es', messages, onTranslated: batch => Object.assign(saved, batch) })
		expect(provider.mock.calls[1]?.[0].messages).toEqual({ '1': 'Hi, {name}!', '2': files })
		expect(saved).toEqual({ Bye: 'Adiós', 'Hi, {name}!': '¡Hola, {name}!', '{count} files': { one: 'uno', many: 'muchos', other: 'otros' } })
		expect(outcome.failed).toEqual([])
	})

	it('splits a batch whose answer is cut off', async () => {
		const { runtime } = fakeRuntime(body =>
			Object.keys(JSON.parse(body.messages[0].content)).length > 1
				? json({ stop_reason: 'max_tokens', content: [] })
				: json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer(body, toSpanish)) }] })
		)
		const outcome = await translateMessages({ provider: createProvider({ apiKey: 'k' }, runtime), sourceLocale: 'en', locale: 'es', messages, onTranslated: () => {} })
		expect(outcome).toEqual({ translated: 3, failed: [] })
		expect(runtime.fetch).toHaveBeenCalledTimes(5)
	})

	it('writes a prompt with the languages, plural forms and project instructions', () => {
		const prompt = buildPrompt('en', 'ar', 'A banking app.')
		expect(prompt).toContain('from English (en) into Arabic (ar)')
		expect(prompt).toContain('(zero, one, two, few, many, other)')
		expect(prompt).toContain('About this application:\nA banking app.')
		expect(prompt).toContain('"context" says where or how the text is used')
	})
})

describe('run', () => {
	let cwd: string
	const write = (path: string, content: string) => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true })
		writeFileSync(join(cwd, path), content)
	}
	const read = (path: string) => JSON.parse(readFileSync(join(cwd, path), 'utf8')) as Record<string, unknown>
	const cli = async (args: string[], options: Partial<Runtime> & { prompt?: Prompter } = {}) => {
		const output: string[] = []
		const code = await run(args, { cwd, log: line => output.push(line), error: line => output.push(line), ...options })
		return { code, output: output.join('\n') }
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'textlate-'))
		write(
			'src/app.tsx',
			`<div>{translate('Welcome, {firstName}!', { firstName: 'John' })}</div>
{translate('I am fine.')}
{translate({ one: '{count} file', other: '{count} files' }, { count })}
{translate('Hello ' + name)}`
		)
		write('src/node_modules/lib.js', `translate('Ignored')`)
	})
	afterEach(() => rmSync(cwd, { recursive: true, force: true }))

	it('extracts placeholders for each locale and reports runtime-built text', async () => {
		const { code, output } = await cli(['extract', '--locales', 'es,ja'])
		expect(code).toBe(0)
		expect(read('src/locales/es.json')).toEqual({
			'Welcome, {firstName}!': '',
			'I am fine.': '',
			'{count} files': { one: '', many: '', other: '' }
		})
		expect(read('src/locales/ja.json')['{count} files']).toEqual({ other: '' })
		expect(output).toContain('Found 3 messages in 1 file.')
		expect(output).toContain('src/app.tsx:4  translate(…)')
		expect(output).toContain(`${join('src', 'locales', 'es.json')}: 0/3 translated (+3)`)
	})

	it('translates only what is untranslated, and keeps existing translations', async () => {
		write('src/locales/es.json', JSON.stringify({ 'I am fine.': 'Estoy bien.', Old: 'Viejo' }))
		const { runtime, requests } = fakeRuntime(body =>
			json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer(body, toSpanish)) }] })
		)
		const { code } = await cli(['translate'], { ...runtime, env: { ANTHROPIC_API_KEY: 'k' } })
		expect(code).toBe(0)
		expect(requests).toHaveLength(1)
		expect(JSON.parse(requests[0]!.body.messages[0].content)).toEqual({ '1': { text: 'Welcome, {firstName}!' }, '2': { plural: files } })
		expect(read('src/locales/es.json')).toEqual({
			'Welcome, {firstName}!': 'ES Welcome, {firstName}!',
			'I am fine.': 'Estoy bien.',
			'{count} files': { one: 'ES {count} file', many: 'ES {count} files', other: 'ES {count} files' }
		})

		const again = await cli(['translate'], { ...runtime, env: {} })
		expect(again.code).toBe(0)
		expect(requests).toHaveLength(1)
	})

	it('reads the config file and .env', async () => {
		write('textlate.config.js', `export default { sourceLocale: 'en', locales: ['fr'], dir: 'locales', ai: { provider: 'openai', model: 'gpt-test', instructions: 'Be brief.' } }`)
		write('.env.local', 'OPENAI_API_KEY="from-dotenv"\n')
		const { runtime, requests } = fakeRuntime(body => json({ choices: [{ message: { content: JSON.stringify(answer(body, toSpanish)) } }] }))
		const { code } = await cli(['translate'], { fetch: runtime.fetch, sleep: runtime.sleep })
		expect(code).toBe(0)
		expect(requests[0]?.headers.authorization).toBe('Bearer from-dotenv')
		expect(requests[0]?.body.messages[0].content).toContain('into French (fr)')
		expect(requests[0]?.body.messages[0].content).toContain('Be brief.')
		expect(read('locales/fr.json')['I am fine.']).toBe('ES I am fine.')
	})

	it('lists what would be translated in a dry run, without an API key', async () => {
		const { code, output } = await cli(['translate', '--dry-run', '-l', 'es'], { env: {} })
		expect(code).toBe(0)
		expect(output).toContain('would translate 3 messages')
	})

	it('writes nothing in a dry run', async () => {
		const { code } = await cli(['translate', '--dry-run', '-l', 'es'], { env: {} })
		expect(code).toBe(0)
		expect(existsSync(join(cwd, 'src/locales'))).toBe(false)
	})

	it('scans absolute paths, and explains a path that does not exist', async () => {
		expect((await cli(['extract', join(cwd, 'src'), '-l', 'es'])).output).toContain('Found 3 messages in 1 file.')
		const missing = await cli(['extract', 'app', '-l', 'es'])
		expect(missing.code).toBe(2)
		expect(missing.output).toContain('Nothing to scan at "app"')
	})

	it('reports failed translations and exits with 1', async () => {
		const { runtime } = fakeRuntime(() => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"1":"no params","2":"Bien","3":{"one":"a","many":"b","other":"c"}}' }] }))
		const { code, output } = await cli(['translate', '-l', 'es'], { ...runtime, env: { ANTHROPIC_API_KEY: 'k' } })
		expect(code).toBe(1)
		expect(output).toContain('"Welcome, {firstName}!": the translation is missing {firstName}')
		expect(output).toContain('2/3 translated')
	})

	it('checks that locale files are complete and valid', async () => {
		expect((await cli(['check', '-l', 'es'])).code).toBe(1)
		write('src/locales/es.json', JSON.stringify({ 'Welcome, {firstName}!': '¡Bienvenido!', 'I am fine.': 'Estoy bien.', '{count} files': { one: '{count} archivo', many: '{count} de archivos', other: '{count} archivos' } }, null, 2) + '\n')
		const invalid = await cli(['check'])
		expect(invalid.code).toBe(1)
		expect(invalid.output).toContain('1 invalid translation')
		expect(invalid.output).toContain('"Welcome, {firstName}!" is missing {firstName}')

		write('src/locales/es.json', JSON.stringify({ 'Welcome, {firstName}!': '¡Bienvenido, {firstName}!', 'I am fine.': 'Estoy bien.', '{count} files': { one: '{count} archivo', many: '{count} de archivos', other: '{count} archivos' } }, null, 2) + '\n')
		const ok = await cli(['check'])
		expect(ok.code).toBe(0)
		expect(ok.output).toContain('es.json: ok')
	})

	it('explains usage errors', async () => {
		expect((await cli(['extract'])).output).toContain('No locales to translate into')
		expect((await cli(['extract', '-l', 'en'])).output).toContain('"en" is the source locale')
		expect((await cli([])).code).toBe(2)
		expect((await cli(['nope'])).output).toContain('Unknown command "nope"')
		expect((await cli(['--help'])).output).toContain('Usage: textlate <command>')
	})

	describe('setup', () => {
		const spanish = () => fakeRuntime(body => json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer(body, toSpanish)) }] }))

		it('asks which AI to use when nothing is configured, then saves and uses it', async () => {
			const { prompt, asked } = scripted(['anthropic', 'claude-sonnet-5-5', 'A banking app.', 'sk-entered', true])
			const { runtime, requests } = spanish()
			const { code, output } = await cli(['translate', '-l', 'es'], { ...runtime, env: {}, prompt })
			expect(code).toBe(0)
			expect(asked).toEqual([
				'Which AI should translate your messages?',
				'Which model?',
				'Instructions for the translator',
				'ANTHROPIC_API_KEY',
				'Save ANTHROPIC_API_KEY to .env?'
			])
			// The answers are used for this run, including the instructions.
			expect(requests[0]?.headers['x-api-key']).toBe('sk-entered')
			expect(requests[0]?.body.model).toBe('claude-sonnet-5-5')
			expect(requests[0]?.body.system).toContain('A banking app.')
			expect(read('src/locales/es.json')['I am fine.']).toBe('ES I am fine.')
			// The provider, model and instructions go to a config file; the key goes to .env.
			const config = readFileSync(join(cwd, 'textlate.config.mjs'), 'utf8')
			expect(config).toContain("import { defineConfig } from 'textlate/config'")
			expect(config).toContain("provider: 'anthropic'")
			expect(config).toContain("model: 'claude-sonnet-5-5'")
			expect(config).toContain("instructions: 'A banking app.'")
			expect(readFileSync(join(cwd, '.env'), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-entered\n')
			expect(output).toContain('Saved the AI settings to textlate.config.mjs')
			expect(output).toContain('Saved ANTHROPIC_API_KEY to .env')
		})

		it('writes the settings into an existing config, and keeps a declined key out of .env', async () => {
			write('textlate.config.mjs', "export default {\n\tlocales: ['es'],\n\tai: { instructions: 'Formal.' }\n}\n")
			const { prompt, asked } = scripted(['openai', 'gpt-test', 'sk-no-save', false])
			const { runtime, requests } = fakeRuntime(body => json({ choices: [{ message: { content: JSON.stringify(answer(body, toSpanish)) } }] }))
			const { code, output } = await cli(['translate'], { ...runtime, env: {}, prompt })
			expect(code).toBe(0)
			// `instructions` is already set, so it isn't asked for again.
			expect(asked).toEqual(['Which AI should translate your messages?', 'Model', 'OPENAI_API_KEY', 'Save OPENAI_API_KEY to .env?'])
			expect(requests[0]?.headers.authorization).toBe('Bearer sk-no-save')
			const config = readFileSync(join(cwd, 'textlate.config.mjs'), 'utf8')
			expect(config).toContain("provider: 'openai'")
			expect(config).toContain("model: 'gpt-test'")
			expect(config).toContain("instructions: 'Formal.'")
			expect(config).toContain("locales: ['es']")
			expect(existsSync(join(cwd, '.env'))).toBe(false)
			expect(output).toContain('Not saved. Set OPENAI_API_KEY in your environment before the next run.')
		})

		it('asks only for what is missing, and merges into a JSON config', async () => {
			write('textlate.config.json', `${JSON.stringify({ locales: ['es'], ai: { provider: 'openai', apiKey: 'sk-config' } }, null, 2)}\n`)
			const { prompt, asked } = scripted(['openai', 'gpt-test', '', true])
			const { runtime, requests } = fakeRuntime(body => json({ choices: [{ message: { content: JSON.stringify(answer(body, toSpanish)) } }] }))
			const { code } = await cli(['translate'], { ...runtime, env: {}, prompt })
			expect(code).toBe(0)
			expect(asked).toEqual([
				'Which AI should translate your messages?',
				'Model',
				'Instructions for the translator',
				'OPENAI_API_KEY is already set in the config. Use it?'
			])
			expect(requests[0]?.headers.authorization).toBe('Bearer sk-config')
			expect(read('textlate.config.json')).toEqual({ locales: ['es'], ai: { provider: 'openai', apiKey: 'sk-config', model: 'gpt-test' } })
		})

		it('runs on its own with the setup command, before there is anything to translate', async () => {
			mkdirSync(join(cwd, '.git'))
			write('.gitignore', 'node_modules\n')
			const { prompt } = scripted(['google', 'gemini-x', '', 'g-key', true])
			const { code, output } = await cli(['setup'], { env: {}, prompt })
			expect(code).toBe(0)
			expect(readFileSync(join(cwd, 'textlate.config.mjs'), 'utf8')).toContain("provider: 'google'")
			expect(readFileSync(join(cwd, '.env'), 'utf8')).toContain('GEMINI_API_KEY=g-key')
			expect(output).toContain('.env is not in .gitignore')
			expect(output).toContain('Run "textlate translate"')
		})

		it('asks nothing when a key is already in the environment', async () => {
			const { prompt, asked } = scripted([])
			const { runtime } = spanish()
			const { code } = await cli(['translate', '-l', 'es'], { ...runtime, env: { ANTHROPIC_API_KEY: 'k' }, prompt })
			expect(code).toBe(0)
			expect(asked).toEqual([])
		})

		it('says how to configure AI when it cannot ask', async () => {
			const translate = await cli(['translate', '-l', 'es', '--no-input'], { env: {} })
			expect(translate.code).toBe(2)
			expect(translate.output).toContain("AI translation isn't set up: no API key for the anthropic provider")
			expect(translate.output).toContain('Run "textlate setup" to configure it, or set ANTHROPIC_API_KEY in the environment or .env')

			const setup = await cli(['setup'], { env: {} })
			expect(setup.code).toBe(2)
			expect(setup.output).toContain('needs a terminal')
		})
	})
})

describe('missingAISettings', () => {
	it('knows when translation is ready to run', () => {
		expect(missingAISettings({}, {})).toEqual(['API key'])
		expect(missingAISettings({}, { ANTHROPIC_API_KEY: 'k' })).toEqual([])
		expect(missingAISettings({ apiKey: 'k' }, {})).toEqual([])
		expect(missingAISettings({ translate: async () => ({}) }, {})).toEqual([])
		expect(missingAISettings({ provider: 'openai' }, {})).toEqual(['model', 'API key'])
		expect(missingAISettings({ provider: 'openai', model: 'gpt-x' }, { OPENAI_API_KEY: 'k' })).toEqual([])
		expect(missingAISettings({ provider: 'google', model: 'gemini-x' }, { GOOGLE_API_KEY: 'k' })).toEqual([])
		// A local server needs no key.
		expect(missingAISettings({ provider: 'openai', model: 'llama', baseUrl: 'http://localhost:11434/v1' }, {})).toEqual([])
	})
})

describe('config and .env files', () => {
	let cwd: string
	const write = (path: string, content: string) => writeFileSync(join(cwd, path), content)
	const read = (path: string) => readFileSync(join(cwd, path), 'utf8')

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'textlate-'))
	})
	afterEach(() => rmSync(cwd, { recursive: true, force: true }))

	it('adds an ai block to a config that has none', () => {
		write('textlate.config.js', "import { defineConfig } from 'textlate/config'\n\nexport default defineConfig({\n\tlocales: ['es'] // for now\n})\n")
		expect(saveAISettings(cwd, join(cwd, 'textlate.config.js'), { provider: 'openai', model: 'gpt-x' })).toEqual({ file: 'textlate.config.js' })
		expect(read('textlate.config.js')).toBe(
			"import { defineConfig } from 'textlate/config'\n\nexport default defineConfig({\n\tai: {\n\t\tprovider: 'openai',\n\t\tmodel: 'gpt-x'\n\t},\n\tlocales: ['es'] // for now\n})\n"
		)
	})

	it('replaces settings that are already in the ai block, and keeps the others', () => {
		write('textlate.config.ts', "export default {\n\tai: {\n\t\tprovider: 'anthropic',\n\t\tinstructions: 'Formal, and {keep} this.'\n\t}\n}\n")
		saveAISettings(cwd, join(cwd, 'textlate.config.ts'), { provider: 'google', model: "gemini's" })
		const text = read('textlate.config.ts')
		expect(text).toContain("provider: 'google'")
		expect(text).toContain("model: 'gemini\\'s'")
		expect(text).toContain("instructions: 'Formal, and {keep} this.'")
		expect(text).not.toContain('anthropic')
	})

	it('creates a config file when the project has none', () => {
		write('package.json', '{ "type": "module" }')
		expect(saveAISettings(cwd, undefined, { provider: 'anthropic' })).toEqual({ file: 'textlate.config.js' })
		expect(read('textlate.config.js')).toBe("import { defineConfig } from 'textlate/config'\n\nexport default defineConfig({\n\tai: {\n\t\tprovider: 'anthropic'\n\t}\n})\n")
	})

	it('changes nothing and hands back a snippet when it cannot edit the config', () => {
		const shapes = ['const config = { ai: {} }\nexport { config }\n', 'export default defineConfig({\n\tai: settings\n})\n', 'export default {\n\tai: {\n}\n']
		for (const shape of shapes) {
			write('textlate.config.js', shape)
			const edit = saveAISettings(cwd, join(cwd, 'textlate.config.js'), { provider: 'openai', model: 'gpt-x' })
			expect(edit.snippet).toBe("ai: {\n\tprovider: 'openai',\n\tmodel: 'gpt-x'\n}")
			expect(read('textlate.config.js')).toBe(shape)
		}
	})

	it('sets a key in .env, leaving the other lines alone', () => {
		write('.env', '# keys\nANTHROPIC_API_KEY=old\nDATABASE_URL=x')
		expect(saveEnvKey(cwd, 'ANTHROPIC_API_KEY', 'new')).toEqual({ file: '.env', ignored: false })
		expect(read('.env')).toBe('# keys\nANTHROPIC_API_KEY=new\nDATABASE_URL=x')

		expect(saveEnvKey(cwd, 'OPENAI_API_KEY', 'sk-1')).toEqual({ file: '.env', ignored: false })
		expect(read('.env')).toBe('# keys\nANTHROPIC_API_KEY=new\nDATABASE_URL=x\nOPENAI_API_KEY=sk-1\n')
	})

	it('prefers .env.local, and reports whether git ignores it', () => {
		write('.env.local', 'A=1\n')
		write('.gitignore', 'node_modules\n.env*\n')
		expect(envFile(cwd)).toBe('.env.local')
		expect(saveEnvKey(cwd, 'GEMINI_API_KEY', 'g key')).toEqual({ file: '.env.local', ignored: true })
		expect(read('.env.local')).toBe('A=1\nGEMINI_API_KEY="g key"\n')
	})
})

describe('createPrompter', () => {
	/** A prompter on a fake terminal: `type` sends keystrokes, `shown` is what the terminal displays. */
	const terminal = ({ tty = true } = {}) => {
		const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (raw: boolean) => void }
		const output = new PassThrough()
		let shown = ''
		output.on('data', chunk => {
			shown += String(chunk)
		})
		if (tty) {
			input.isTTY = true
			input.setRawMode = () => {}
		}
		return { prompt: createPrompter({ input, output }), type: (text: string) => setTimeout(() => input.write(text), 0), shown: () => shown, input }
	}

	const choices = [
		{ value: 'anthropic', label: 'Anthropic', hint: 'Claude' },
		{ value: 'openai', label: 'OpenAI' }
	]

	it('picks from a list by number, by name or by default', async () => {
		const { prompt, type, shown } = terminal()
		type('2\n')
		expect(await prompt.select('Which AI?', choices, 'anthropic')).toBe('openai')
		type('OpenAI\n')
		expect(await prompt.select('Which AI?', choices)).toBe('openai')
		type('\n')
		expect(await prompt.select('Which AI?', choices, 'openai')).toBe('openai')
		type('7\nnope\n1\n')
		expect(await prompt.select('Which AI?', choices)).toBe('anthropic')
		prompt.close()
		expect(shown()).toContain('  1) Anthropic (Claude)  [default]')
		expect(shown()).toContain('  2) OpenAI  [default]')
		expect(shown()).toContain('Answer with a number from 1 to 2.')
	})

	it('reads text, a default and yes or no', async () => {
		const { prompt, type, shown } = terminal()
		type('  gpt-x  \n')
		expect(await prompt.text('Model', 'claude')).toBe('gpt-x')
		type('\n')
		expect(await prompt.text('Model', 'claude')).toBe('claude')
		type('\n')
		expect(await prompt.confirm('Save?', false)).toBe(false)
		type('maybe\nY\n')
		expect(await prompt.confirm('Save?', false)).toBe(true)
		prompt.close()
		expect(shown()).toContain('Model [claude]: ')
		expect(shown()).toContain('Save? [y/N] ')
	})

	it('never echoes a secret, and takes backspace', async () => {
		const { prompt, type, shown } = terminal()
		type('sk-secrex\u007fet\n')
		expect(await prompt.secret('ANTHROPIC_API_KEY')).toBe('sk-secreet')
		prompt.close()
		expect(shown()).not.toContain('sk-secre')
		expect(shown()).toContain('ANTHROPIC_API_KEY: *********\b \b**')
	})

	it('keeps what was typed before the question', async () => {
		const { prompt, type } = terminal()
		type('openai\ngpt-x\n')
		await new Promise(done => setTimeout(done, 10))
		expect(await prompt.select('Which AI?', choices)).toBe('openai')
		expect(await prompt.text('Model')).toBe('gpt-x')
		prompt.close()
	})

	it('cancels on Ctrl-C and when the input ends', async () => {
		const { prompt, type } = terminal()
		type('\u0003')
		await expect(prompt.secret('ANTHROPIC_API_KEY')).rejects.toBeInstanceOf(Cancelled)
		// Every question after that is cancelled too, rather than waiting for input that will not come.
		await expect(prompt.text('Model')).rejects.toBeInstanceOf(Cancelled)

		const ended = terminal()
		setTimeout(() => ended.input.end(), 0)
		await expect(ended.prompt.text('Model')).rejects.toBeInstanceOf(Cancelled)
	})

	it('works without a terminal, where nothing is echoed anyway', async () => {
		const { prompt, type, shown } = terminal({ tty: false })
		type('2\nsk-piped\n')
		expect(await prompt.select('Which AI?', choices)).toBe('openai')
		expect(await prompt.secret('ANTHROPIC_API_KEY')).toBe('sk-piped')
		prompt.close()
		expect(shown()).not.toContain('sk-piped')
	})
})
