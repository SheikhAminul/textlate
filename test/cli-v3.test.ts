// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPrompt, limiter, translateMessages } from '../src/cli/ai.js'
import { checkTranslation } from '../src/cli/catalog.js'
import { run } from '../src/cli/run.js'
import { scanCode, scanFiles } from '../src/cli/scan.js'
import { decodeEntry, encodeEntry, hashOf, matchChanged, similarity, syncLocale } from '../src/cli/sync.js'

describe('text in data', () => {
	it('reads the string values of the properties it is told, as written out in full', () => {
		const { messages } = scanCode(
			`export const SLACK = {
				label: 'Slack',
				description: "Sends messages to channels — and reads them.",
				'label': 'Quoted key',
				actions: [{ id: 'send', label: \`Send a message\`, fields: [{ key: 'channel', label: 'Channel', placeholder: '#general' }] }],
				help: 'Built ' + 'from parts',
				summary: \`{channel} \${dynamic}\`,
				prefixedlabel: 'Not this one',
				meta: { label: computeLabel() },
				description: 'Once more: Sends messages to channels — and reads them.',
			}`,
			[],
			'catalog.ts',
			['label', 'description']
		)
		expect([...messages.keys()]).toEqual([
			'Slack',
			'Sends messages to channels — and reads them.',
			'Quoted key',
			'Send a message',
			'Channel',
			'Once more: Sends messages to channels — and reads them.'
		])
	})

	it('leaves out excluded files and directories', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'textlate-scan-'))
		mkdirSync(join(cwd, 'src', 'test'), { recursive: true })
		writeFileSync(join(cwd, 'src', 'app.ts'), `translate('Kept')`)
		writeFileSync(join(cwd, 'src', 'test', 'app.test.ts'), `translate('Test text')`)
		writeFileSync(join(cwd, 'src', 'fixtures.ts'), `translate('Fixture')`)
		const { messages, files } = scanFiles(['src'], cwd, { exclude: ['src/test', 'src/fixtures.ts'] })
		expect([...messages.keys()]).toEqual(['Kept'])
		expect(files).toBe(1)
		rmSync(cwd, { recursive: true, force: true })
	})
})

describe('translation state', () => {
	it('encodes entries compactly, and reads them back', () => {
		for (const entry of [{ status: 'reviewed' }, { status: 'machine', hash: 'abcd1234' }, { status: 'changed', hash: '0f0f0f0f', from: 'Old text // with: colons' }] as const) {
			expect(decodeEntry(encodeEntry(entry))).toEqual(entry)
		}
		expect(decodeEntry('nonsense')).toBeUndefined()
		expect(hashOf('Hola')).toMatch(/^[\da-f]{8}$/)
	})

	it('tells alike text apart from different text', () => {
		expect(similarity('Send a message', 'Send a message')).toBe(1)
		expect(similarity('Send a messsage', 'Send a message')).toBeGreaterThan(0.9)
		expect(similarity('Save changes', 'Delete the workspace')).toBeLessThan(0.3)
	})

	it('matches each changed message with the most alike removed one, of the same shape', () => {
		const matches = matchChanged(
			[
				['Send a message to the channel', 'Send a message to the channel'],
				['{count} new files', { one: '{count} new file', other: '{count} new files' }],
				['Something else entirely', 'Something else entirely']
			],
			[
				['Send a message to a channel', 'Envía un mensaje a un canal'],
				['{count} new file(s)', 'not plural forms'],
				['{count} files', { one: '{count} archivo', other: '{count} archivos' }]
			]
		)
		// The plural matches plural forms, never the text that looks more like it.
		expect(Object.fromEntries(matches)).toEqual({ 'Send a message to the channel': 'Send a message to a channel', '{count} new files': '{count} files' })
	})

	it('keeps state across a sync: edits become reviewed, alike changed text carries its translation over', () => {
		const messages = new Map<string, string>([
			['Hello', 'Hello'],
			['Edited', 'Edited'],
			['Send a message to the channel', 'Send a message to the channel'],
			['Brand new', 'Brand new']
		])
		const existing = new Map<string, unknown>([
			['Hello', 'Hola'],
			['Edited', 'Editado a mano'],
			['Send a message to a channel', 'Envía un mensaje a un canal']
		])
		const recorded = new Map([
			['Hello', { status: 'machine' as const, hash: hashOf('Hola') }],
			['Edited', { status: 'machine' as const, hash: hashOf('Editado') }]
		])
		const result = syncLocale(messages, existing, recorded, 'es')
		expect(Object.fromEntries(result.values)).toEqual({ Hello: 'Hola', Edited: 'Editado a mano', 'Send a message to the channel': 'Envía un mensaje a un canal', 'Brand new': '' })
		expect(Object.fromEntries(result.state)).toEqual({
			Hello: { status: 'machine', hash: hashOf('Hola') },
			Edited: { status: 'reviewed' },
			'Send a message to the channel': { status: 'changed', hash: hashOf('Envía un mensaje a un canal'), from: 'Send a message to a channel' }
		})
		expect(result).toMatchObject({ added: 2, removed: 1, carried: 1 })
		expect(syncLocale(messages, existing, recorded, 'es', { carryOver: false }).carried).toBe(0)
	})
})

describe('AI', () => {
	it('never runs more jobs than its size, in the order they asked', async () => {
		const limit = limiter(2)
		let running = 0
		let most = 0
		const order: number[] = []
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				limit(async () => {
					running++
					most = Math.max(most, running)
					await new Promise(done => setTimeout(done, 5))
					order.push(index)
					running--
				})
			)
		)
		expect(most).toBe(2)
		expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
	})

	it('sends batches at once through the limit, and the previous translation of changed text', async () => {
		const requests: { ids: string[]; previous: unknown }[] = []
		let inFlight = 0
		let most = 0
		const outcome = await translateMessages({
			sourceLocale: 'en',
			locale: 'es',
			messages: new Map(Array.from({ length: 6 }, (_, index) => [`Text ${index}`, `Text ${index}`])),
			previous: new Map([['Text 0', { text: 'Text zero', translation: 'Texto cero' }]]),
			batchSize: 2,
			limit: limiter(3),
			provider: async request => {
				inFlight++
				most = Math.max(most, inFlight)
				requests.push({ ids: Object.keys(request.messages), previous: request.previous })
				await new Promise(done => setTimeout(done, 5))
				inFlight--
				return Object.fromEntries(Object.entries(request.messages).map(([id, message]) => [id, `ES ${message as string}`]))
			},
			onTranslated: () => {}
		})
		expect(outcome).toEqual({ translated: 6, failed: [] })
		expect(requests).toHaveLength(3)
		expect(most).toBe(3)
		expect(requests[0]!.previous).toEqual({ 1: { text: 'Text zero', translation: 'Texto cero' } })
		expect(requests[1]!.previous).toBeUndefined()
	})

	it('puts the glossary for the locale in the prompt, and checks terms to keep', () => {
		const glossary = { TareAI: { keep: true }, workflow: { note: 'an automation', translations: { de: 'Workflow' } }, run: { translations: { fr: 'exécution' } } }
		const prompt = buildPrompt('en', 'de', 'An automation platform.', glossary)
		expect(prompt).toContain('Glossary:\n- "TareAI": keep it exactly as written, never translate it.\n- "workflow" (an automation): translate it as "Workflow".')
		expect(prompt).not.toContain('exécution')
		expect(checkTranslation('Open TareAI', 'Öffne TareAI', 'de', glossary)).toEqual([])
		expect(checkTranslation('Open TareAI', 'Öffne Tare-KI', 'de', glossary)).toEqual(['should keep "TareAI" as it is'])
	})
})

describe('run', () => {
	let cwd: string
	const write = (path: string, content: string) => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true })
		writeFileSync(join(cwd, path), content)
	}
	const read = (path: string) => JSON.parse(readFileSync(join(cwd, path), 'utf8')) as Record<string, unknown>
	const requests: any[] = []
	/** The Claude API, answering every text with "ES <text>" — or, with a previous translation, "<it> (updated)". */
	const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init!.body))
		requests.push(body)
		const items = JSON.parse(body.messages[0].content) as Record<string, { text?: string; previous?: { translation: string } }>
		const answer = Object.fromEntries(Object.entries(items).map(([id, item]) => [id, item.previous ? `${item.previous.translation} (updated)` : `ES ${item.text}`]))
		return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }), { headers: { 'content-type': 'application/json' } })
	}) as unknown as typeof globalThis.fetch
	const cli = async (args: string[]) => {
		const output: string[] = []
		const code = await run(args, { cwd, color: false, unicode: true, fetch, sleep: async () => {}, env: { ANTHROPIC_API_KEY: 'sk-test' }, log: line => output.push(line), error: line => output.push(line) })
		return { code, output: output.join('\n') }
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'textlate-v3-'))
		requests.length = 0
	})
	afterEach(() => rmSync(cwd, { recursive: true, force: true }))

	describe('namespaces', () => {
		beforeEach(() => {
			write('app/page.tsx', `translate('Save'); translate('Welcome')`)
			write('catalog/slack.ts', `export const SLACK = { label: 'Slack', actions: [{ label: 'Send a message' }, { label: 'Save' }] }`)
			write(
				'textlate.config.json',
				JSON.stringify({ dir: 'locales', locales: ['es', 'de'], namespaces: { app: { include: ['app'] }, catalog: { include: ['catalog'], properties: ['label'] } } })
			)
		})

		it('writes a file per namespace, a shared message in each, translated once', async () => {
			const extracted = await cli(['extract'])
			expect(extracted.code).toBe(0)
			expect(extracted.output).toMatch(/Namespaces\s+2\s+app 2, catalog 3/)
			expect(extracted.output).toContain(join('locales', '<locale>', '<namespace>.json'))
			expect(read('locales/es/app.json')).toEqual({ Save: '', Welcome: '' })
			expect(read('locales/es/catalog.json')).toEqual({ Slack: '', 'Send a message': '', Save: '' })

			const translated = await cli(['translate'])
			expect(translated.code).toBe(0)
			expect(requests.map(body => Object.keys(JSON.parse(body.messages[0].content)).length)).toEqual([4, 4])
			expect(read('locales/de/app.json')).toEqual({ Save: 'ES Save', Welcome: 'ES Welcome' })
			expect(read('locales/de/catalog.json')).toEqual({ Slack: 'ES Slack', 'Send a message': 'ES Send a message', Save: 'ES Save' })
			expect((await cli(['check'])).code).toBe(0)
		})

		it('finds the locales by their folders, and won\'t take paths', async () => {
			write('locales/fr/app.json', '{}')
			write('textlate.config.json', JSON.stringify({ dir: 'locales', namespaces: { app: { include: ['app'] } } }))
			const { code, output } = await cli(['extract'])
			expect(code).toBe(0)
			expect(output).toMatch(/Locales\s+1\s+fr/)
			expect((await cli(['extract', 'app'])).output).toContain('leave the paths out')
		})
	})

	describe('review and changed text', () => {
		beforeEach(() => {
			write('src/app.tsx', `translate('Send a message to a channel'); translate('Welcome')`)
			write('textlate.config.json', JSON.stringify({ locales: ['es'], reviewed: ['es'] }))
		})

		it('gates check on review: a person\'s edit or accept counts, and textlate keeps track beside the files', async () => {
			await cli(['translate'])
			expect(read('src/locales/.textlate/es.json')).toEqual({
				'Send a message to a channel': `m:${hashOf('ES Send a message to a channel')}`,
				Welcome: `m:${hashOf('ES Welcome')}`
			})
			const unreviewed = await cli(['check'])
			expect(unreviewed.code).toBe(1)
			expect(unreviewed.output).toContain('2 not reviewed (review them, then textlate accept)')

			// A person corrects one translation…
			write('src/locales/es.json', JSON.stringify({ 'Send a message to a channel': 'Envía un mensaje a un canal', Welcome: 'ES Welcome' }, null, 2) + '\n')
			expect((await cli(['check'])).output).toContain('1 not reviewed')
			// …and accepts the rest.
			const accepted = await cli(['accept'])
			expect(accepted.output).toContain('Marked 1 translation in 1 locale as reviewed.')
			expect(read('src/locales/.textlate/es.json')).toEqual({ 'Send a message to a channel': 'r', Welcome: 'r' })
			expect((await cli(['check'])).code).toBe(0)
		})

		it('carries a translation over to changed text, updates it, and fails check until then', async () => {
			write('src/locales/es.json', JSON.stringify({ 'Send a message to a channel': 'Envía un mensaje a un canal', Welcome: 'Bienvenido' }) + '\n')
			await cli(['accept'])
			write('src/app.tsx', `translate('Send a message to the channel'); translate('Welcome')`)

			const extracted = await cli(['extract'])
			expect(extracted.output).toContain("1 changed message kept the old text's translation")
			expect(read('src/locales/es.json')).toEqual({ 'Send a message to the channel': 'Envía un mensaje a un canal', Welcome: 'Bienvenido' })
			expect(read('src/locales/.textlate/es.json')['Send a message to the channel']).toBe(`c:${hashOf('Envía un mensaje a un canal')}:Send a message to a channel`)
			const changed = await cli(['check'])
			expect(changed.code).toBe(1)
			expect(changed.output).toContain('1 changed since translated (run textlate translate)')

			await cli(['translate'])
			const item = Object.values(JSON.parse(requests[0].messages[0].content))[0]
			expect(item).toEqual({ text: 'Send a message to the channel', previous: { text: 'Send a message to a channel', translation: 'Envía un mensaje a un canal' } })
			expect(read('src/locales/es.json')['Send a message to the channel']).toBe('Envía un mensaje a un canal (updated)')
			// Updated by AI: to review again, then accepted.
			expect((await cli(['check'])).output).toContain('1 not reviewed')
			await cli(['accept'])
			expect((await cli(['check'])).code).toBe(0)
		})
	})

	it('writes files whole, leaving nothing behind', async () => {
		write('src/app.tsx', `translate('Hello')`)
		await cli(['translate', '-l', 'es'])
		expect(readdirSync(join(cwd, 'src', 'locales')).sort()).toEqual(['.textlate', 'es.json'])
		expect(readdirSync(join(cwd, 'src', 'locales', '.textlate')).sort()).toEqual(['es.json', 'meta.json'])
		expect(existsSync(join(cwd, 'src', 'locales', 'es.json'))).toBe(true)
	})
})
