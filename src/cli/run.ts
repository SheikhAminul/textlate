/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { AIConfig, Config } from '../config.js'
import type { Message } from '../types.js'
import { createProvider, translateMessages, type Runtime } from './ai.js'
import { checkTranslation, isTranslated, readLocaleFile, serialize, syncMessages, writeLocaleFile, type LocaleFile, type LocaleMessages } from './catalog.js'
import { Cancelled, createPrompter, isInteractive, type Prompter } from './prompt.js'
import { scanFiles } from './scan.js'
import { missingAISettings, setupAI, setupHint } from './setup.js'

const CONFIG_FILES = ['ts', 'mts', 'js', 'mjs', 'json'].map(extension => `textlate.config.${extension}`)
const LOCALE_FILE = /^([a-z]{2,3}(?:[-_][a-z\d]+)*)\.json$/i

const HELP = `Usage: textlate <command> [paths...] [options]

Commands:
  extract    Find the messages in your code and update <dir>/<locale>.json
  translate  Extract, then translate what isn't translated yet with AI
  check      Fail if a locale file is out of date, untranslated or invalid (for CI)
  setup      Choose the AI provider, model and API key, and save them

Arguments:
  paths                    Files or directories to scan (default: src)

Options:
  -c, --config <file>      Config file (default: textlate.config.{ts,mts,js,mjs,json})
  -d, --dir <dir>          Directory of <locale>.json files (default: src/locales)
  -s, --source <locale>    Language the text in your code is written in (default: en)
  -l, --locales <list>     Locales to translate into, e.g. es,bn (default: each <locale>.json in --dir)
  -f, --functions <list>   Functions whose first argument is a message (default: translate,msg)
      --provider <name>    AI provider: anthropic (default), openai or google
      --model <id>         AI model (default for anthropic: claude-opus-5-5)
      --keep-unused        Keep translations of text that is no longer in the code
      --dry-run            translate: list what would be translated, without calling the AI
      --no-input           Never ask questions: fail instead (for CI)
  -h, --help               Show this help

API keys come from ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, also read from .env and .env.local.
With none of them set, translate asks which provider, model and key to use, and saves them.

Examples:
  textlate setup
  textlate extract --locales es,bn
  textlate translate
  textlate check`

class UsageError extends Error {}

export interface RunOptions {
	cwd?: string
	log?: (line: string) => void
	error?: (line: string) => void
	fetch?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	/** Defaults to `process.env`, with `.env` and `.env.local` underneath. */
	env?: Readonly<Record<string, string | undefined>>
	/** How setup asks its questions. Defaults to the terminal, or to nothing when there is none. */
	prompt?: Prompter | undefined
}

/** The config from `path`, or from the first `textlate.config.*` in `cwd`, with the file it came from. */
export const loadConfig = async (cwd: string, path?: string): Promise<{ config: Config; file?: string }> => {
	const file = path ? resolve(cwd, path) : CONFIG_FILES.map(name => join(cwd, name)).find(existsSync)
	if (!file) return { config: {} }
	if (!existsSync(file)) throw new UsageError(`Config file ${path} not found.`)
	if (file.endsWith('.json')) return { config: JSON.parse(readFileSync(file, 'utf8')) as Config, file }
	try {
		const module = (await import(pathToFileURL(file).href)) as { default?: Config }
		return { config: module.default ?? (module as Config), file }
	} catch (error) {
		if ((error as { code?: string }).code === 'ERR_UNKNOWN_FILE_EXTENSION') {
			throw new UsageError(`Node ${process.version} can't load ${basename(file)}. Use Node 22.18 or later, or a .js config.`)
		}
		throw error
	}
}

/** `KEY=value` lines, as in `.env` files. */
const parseDotenv = (text: string) =>
	Object.fromEntries(
		[...text.matchAll(/^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\r\n#]*))/gm)].map(
			([, name, double, single, bare]) => [name!, double !== undefined ? double.replace(/\\n/g, '\n') : (single ?? bare!.trim())]
		)
	)

const readEnv = (cwd: string): Record<string, string | undefined> => {
	const env: Record<string, string> = {}
	for (const name of ['.env', '.env.local']) {
		const file = join(cwd, name)
		if (existsSync(file)) Object.assign(env, parseDotenv(readFileSync(file, 'utf8')))
	}
	return { ...env, ...process.env }
}

const list = (value: string | undefined) => value?.split(',').map(item => item.trim()).filter(Boolean)
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
const quote = (text: string) => JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text)

/** Run up to `limit` jobs at a time. */
const pool = async <T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) => {
	let next = 0
	const worker = async () => {
		while (next < items.length) await work(items[next++]!)
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

interface LocaleState {
	locale: string
	file: LocaleFile
	messages: LocaleMessages
	added: number
	removed: number
}

/** Untranslated messages, and translations whose params, tags or plural forms don't match the source. */
const review = (sources: ReadonlyMap<string, Message>, state: LocaleState) => {
	const untranslated = new Map<string, Message>()
	const problems: string[] = []
	for (const [text, source] of sources) {
		const value = state.messages[text]
		if (!isTranslated(value)) untranslated.set(text, source)
		else for (const problem of checkTranslation(source, value, state.locale)) problems.push(`${quote(text)} ${problem}`)
	}
	return { untranslated, problems }
}

/**
 * Run the command line with `args` (without `node` and the script) and return the exit code.
 *
 * @example
 * ```ts
 * process.exitCode = await run(['translate', '--locales', 'es,bn'])
 * ```
 */
export const run = async (args: readonly string[], options: RunOptions = {}): Promise<number> => {
	const cwd = options.cwd ?? process.cwd()
	const log = options.log ?? console.log
	const error = options.error ?? console.error

	let parsed
	try {
		parsed = parseArgs({
			args: [...args],
			allowPositionals: true,
			options: {
				config: { type: 'string', short: 'c' },
				dir: { type: 'string', short: 'd' },
				source: { type: 'string', short: 's' },
				locales: { type: 'string', short: 'l' },
				functions: { type: 'string', short: 'f' },
				provider: { type: 'string' },
				model: { type: 'string' },
				'keep-unused': { type: 'boolean' },
				'dry-run': { type: 'boolean' },
				'no-input': { type: 'boolean' },
				help: { type: 'boolean', short: 'h' }
			}
		})
	} catch (cause) {
		error(`${(cause as Error).message}\n\n${HELP}`)
		return 2
	}
	const { values, positionals } = parsed
	const [command, ...paths] = positionals
	if (values.help || command === 'help') {
		log(HELP)
		return 0
	}
	if (command !== 'extract' && command !== 'translate' && command !== 'check' && command !== 'setup') {
		error(`${command ? `Unknown command "${command}".` : 'Missing command.'}\n\n${HELP}`)
		return 2
	}

	// Questions are only asked on a terminal, so a script or a CI run fails with an explanation instead of hanging.
	const prompt = options.prompt ?? (values['no-input'] || !isInteractive() ? undefined : createPrompter())

	try {
		const { config, file: configFile } = await loadConfig(cwd, values.config)
		const env = options.env ?? readEnv(cwd)
		let ai: AIConfig = { ...config.ai, ...(values.provider && { provider: values.provider as AIConfig['provider'] }), ...(values.model && { model: values.model }) }

		if (command === 'setup') {
			if (!prompt) throw new UsageError('textlate setup asks questions, so it needs a terminal. Set ai.provider and ai.model in textlate.config.js instead.')
			await setupAI({ cwd, ai, configFile, env, prompt, log })
			log('Ready. Run "textlate translate" to translate your messages.')
			return 0
		}

		const sourceLocale = values.source ?? config.sourceLocale ?? 'en'
		const dir = resolve(cwd, values.dir ?? config.dir ?? 'src/locales')
		const existing = existsSync(dir) ? readdirSync(dir).flatMap(name => LOCALE_FILE.exec(name)?.[1] ?? []) : []
		const locales = list(values.locales) ?? config.locales ?? existing.filter(locale => locale !== sourceLocale).sort()
		if (!locales.length) {
			throw new UsageError(
				`No locales to translate into. Pass --locales es,fr, add \`locales: ['es', 'fr']\` to textlate.config.js, or create ${relative(cwd, join(dir, 'es.json'))}.`
			)
		}
		if (locales.includes(sourceLocale)) throw new UsageError(`"${sourceLocale}" is the source locale: the text in your code. It needs no file.`)

		const include = paths.length ? paths : (config.include ?? ['src'])
		for (const path of include) {
			if (!existsSync(resolve(cwd, path))) {
				throw new UsageError(`Nothing to scan at "${path}". Pass the files or directories that hold your code, or set \`include\` in textlate.config.js.`)
			}
		}
		const scan = scanFiles(include, cwd, list(values.functions) ?? config.functions)
		log(`Found ${plural(scan.messages.size, 'message')} in ${plural(scan.files, 'file')}.`)
		for (const warning of scan.warnings) log(`  ${warning.file}:${warning.line}  ${warning.message}`)

		const keepUnused = values['keep-unused'] ?? config.keepUnused
		const states: LocaleState[] = locales.map(locale => {
			const file = readLocaleFile(join(dir, `${locale}.json`))
			return { locale, file, ...syncMessages(scan.messages, file.messages, locale, keepUnused) }
		})
		const name = (state: LocaleState) => relative(cwd, state.file.path)

		if (command === 'check') {
			let failed = false
			for (const state of states) {
				const { untranslated, problems } = review(scan.messages, state)
				const issues = [
					serialize(state.file, state.messages) !== state.file.raw && 'out of date (run textlate extract)',
					untranslated.size > 0 && `${untranslated.size} untranslated (run textlate translate)`,
					problems.length > 0 && plural(problems.length, 'invalid translation')
				].filter(Boolean)
				failed ||= issues.length > 0
				log(`  ${name(state)}: ${issues.length ? issues.join(', ') : 'ok'}`)
				for (const problem of problems) log(`    ${problem}`)
			}
			return failed ? 1 : 0
		}

		const pending = states.map(state => ({ state, messages: review(scan.messages, state).untranslated })).filter(({ messages }) => messages.size)
		if (command === 'translate' && values['dry-run']) {
			for (const { state, messages } of pending) log(`  ${name(state)}: would translate ${plural(messages.size, 'message')}`)
			if (!pending.length) log('  Everything is translated.')
			return 0
		}

		for (const state of states) writeLocaleFile(state.file, state.messages)
		const failures = new Map<string, string[]>()

		if (command === 'translate') {
			const missing = pending.length ? missingAISettings(ai, env) : []
			if (missing.length) {
				if (!prompt) throw new UsageError(setupHint(cwd, ai, missing))
				log(`No ${missing.join(' or ')} to translate with yet. Setting that up once:`)
				ai = await setupAI({ cwd, ai, configFile, env, prompt, log })
			}
			const runtime: Runtime = {
				fetch: options.fetch ?? globalThis.fetch,
				sleep: options.sleep ?? (ms => new Promise(done => setTimeout(done, ms))),
				env
			}
			const provider = pending.length ? createProvider(ai, runtime) : undefined
			await pool(pending, ai.concurrency ?? 4, async ({ state, messages }) => {
				let done = 0
				try {
					const outcome = await translateMessages({
						provider: provider!,
						sourceLocale,
						locale: state.locale,
						messages,
						instructions: ai.instructions,
						batchSize: ai.batchSize,
						onTranslated: translations => {
							// Saved after every batch, so an interrupted run never pays for the same translation twice.
							state.messages = { ...state.messages, ...translations }
							writeLocaleFile(state.file, state.messages)
							done += Object.keys(translations).length
							log(`  ${state.locale}: translated ${done}/${messages.size}`)
						}
					})
					if (outcome.failed.length) failures.set(state.locale, outcome.failed.map(({ text, reason }) => `${quote(text)}: ${reason}`))
				} catch (cause) {
					failures.set(state.locale, [(cause as Error).message])
				}
			})
		}

		for (const state of states) {
			const { untranslated, problems } = review(scan.messages, state)
			const changes = [state.added && `+${state.added}`, state.removed && `-${state.removed}`].filter(Boolean).join(' ')
			const translated = scan.messages.size - untranslated.size
			log(`  ${name(state)}: ${translated}/${scan.messages.size} translated${changes ? ` (${changes})` : ''}`)
			for (const problem of problems) log(`    ${problem}`)
			for (const failure of failures.get(state.locale) ?? []) error(`    ${failure}`)
		}
		return failures.size ? 1 : 0
	} catch (cause) {
		if (cause instanceof Cancelled) {
			error('[textlate] Cancelled.')
			return 130
		}
		error(`[textlate] ${(cause as Error).message}`)
		return cause instanceof UsageError ? 2 : 1
	} finally {
		if (!options.prompt) prompt?.close()
	}
}
