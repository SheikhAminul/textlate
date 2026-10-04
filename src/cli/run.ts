/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { AIConfig, Config } from '../config.js'
import type { Message } from '../types.js'
import { createProvider, languageName, translateMessages, type Runtime } from './ai.js'
import { checkTranslation, isTranslated, readLocaleFile, serialize, syncMessages, writeLocaleFile, type LocaleFile, type LocaleMessages } from './catalog.js'
import { Cancelled, createPrompter, isInteractive, type Prompter } from './prompt.js'
import { scanFiles } from './scan.js'
import { missingAISettings, setupAI, setupHint } from './setup.js'
import { createRenderer, createStatus, type Column, type Row, type Styler } from './ui.js'

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
      --no-color           Plain output, without colours (also NO_COLOR; NO_UNICODE for ASCII tables)
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
	/** Colour the output. Defaults to whether it goes to a terminal. */
	color?: boolean | undefined
	/** Draw tables with box-drawing characters. Defaults to whether the terminal can show them. */
	unicode?: boolean | undefined
	/** The width the output is laid out for. Defaults to the terminal's. */
	columns?: number | undefined
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
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

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

/** Where one locale stands: what it has, what it misses and what is wrong with it. */
interface Snapshot {
	state: LocaleState
	untranslated: Map<string, Message>
	problems: string[]
	/** The file on disk is not what extract would write: messages were added, removed or reordered. */
	outdated: boolean
}

const snapshot = (sources: ReadonlyMap<string, Message>, state: LocaleState): Snapshot => ({
	state,
	...review(sources, state),
	outdated: serialize(state.file, state.messages) !== state.file.raw
})

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
	const lines = (values: readonly string[]) => {
		for (const line of values) log(line)
	}

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
				'no-color': { type: 'boolean' },
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

	const ui = createRenderer({ color: values['no-color'] ? false : options.color, unicode: options.unicode, columns: options.columns })
	const blank = () => log('')
	const { dim, bold } = ui.theme
	// Questions are only asked on a terminal, so a script or a CI run fails with an explanation instead of hanging.
	const prompt = options.prompt ?? (values['no-input'] || !isInteractive() ? undefined : createPrompter({ indent: '  ' }))

	try {
		const { config, file: configFile } = await loadConfig(cwd, values.config)
		const env = options.env ?? readEnv(cwd)
		let ai: AIConfig = { ...config.ai, ...(values.provider && { provider: values.provider as AIConfig['provider'] }), ...(values.model && { model: values.model }) }

		if (command === 'setup') {
			if (!prompt) throw new UsageError('textlate setup asks questions, so it needs a terminal. Set ai.provider and ai.model in textlate.config.js instead.')
			blank()
			log(ui.title('textlate setup'))
			blank()
			await setupAI({ cwd, ai, configFile, env, prompt, log: line => log(ui.line(line, 0)) })
			blank()
			log(ui.note('ok', 'Ready. Run "textlate translate" to translate your messages.'))
			blank()
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
		const total = scan.messages.size

		const keepUnused = values['keep-unused'] ?? config.keepUnused
		const states: LocaleState[] = locales.map(locale => {
			const file = readLocaleFile(join(dir, `${locale}.json`))
			return { locale, file, ...syncMessages(scan.messages, file.messages, locale, keepUnused) }
		})
		const name = (state: LocaleState) => relative(cwd, state.file.path)
		const snapshots = states.map(state => snapshot(scan.messages, state))

		// What the run is about, before it does anything: the languages, the text found and where the files are.
		blank()
		log(ui.title(`textlate ${command}`))
		blank()
		lines(
			ui.details([
				['Source', sourceLocale, languageName(sourceLocale)],
				['Locales', String(locales.length), locales.join(', ')],
				['Messages', String(total), `in ${plural(scan.files, 'file')}`],
				['Files', join(relative(cwd, dir) || '.', '<locale>.json')],
				Boolean(configFile) && ['Config', relative(cwd, configFile!)]
			])
		)
		if (scan.warnings.length) {
			blank()
			for (const warning of scan.warnings) log(ui.note('warn', `${warning.file}:${warning.line}  ${warning.message}`))
		}

		const COLUMNS: Column[] = [
			{ title: 'Locale' },
			{ title: 'Language', flex: true, droppable: true },
			{ title: 'Translated', align: 'right' },
			{ title: 'Missing', align: 'right' },
			{ title: 'New', align: 'right', optional: true },
			{ title: 'Unused', align: 'right', optional: true },
			{ title: 'Invalid', align: 'right', optional: true }
		]
		// Zero is left blank: the table shows a dash, and a column that is zero everywhere is left out altogether.
		const count = (value: number, sign = '', style: Styler = text => text) => (value ? style(`${sign}${value}`) : '')
		const share = (done: number, all: number) => `${done}/${all}${all ? `  ${dim(`${Math.round((done / all) * 100)}%`)}` : ''}`
		const cells = (locale: string, language: string, snaps: readonly Snapshot[]): string[] => {
			const missing = sum(snaps.map(snap => snap.untranslated.size))
			return [
				locale,
				language,
				share(snaps.length * total - missing, snaps.length * total),
				count(missing, '', ui.theme.yellow),
				count(sum(snaps.map(snap => snap.state.added)), '+'),
				count(sum(snaps.map(snap => snap.state.removed)), '-'),
				count(sum(snaps.map(snap => snap.problems.length)), '', ui.theme.red)
			]
		}
		/** The table under `heading`: one row per locale, and a total row when there is more than one. */
		const catalogs = (snaps: readonly Snapshot[], heading: string) => {
			const rows: Row[] = snaps.map(snap => ({ cells: cells(ui.theme.cyan(snap.state.locale), languageName(snap.state.locale), [snap]) }))
			if (snaps.length > 1) rows.push({ rule: true, cells: cells(bold('Total'), dim(plural(snaps.length, 'locale')), snaps) })
			blank()
			log(ui.heading(heading))
			blank()
			lines(ui.table(COLUMNS, rows))
			blank()
		}
		catalogs(snapshots, 'Catalogs')

		if (command === 'check') {
			let failed = 0
			for (const snap of snapshots) {
				const reasons = [
					snap.outdated && 'out of date (run textlate extract)',
					snap.untranslated.size > 0 && `${snap.untranslated.size} untranslated (run textlate translate)`,
					snap.problems.length > 0 && plural(snap.problems.length, 'invalid translation')
				].filter((reason): reason is string => Boolean(reason))
				if (reasons.length) failed++
				log(ui.note(reasons.length ? 'fail' : 'ok', `${name(snap.state)}  ${reasons.length ? reasons.join(` ${ui.glyphs.dot} `) : dim('up to date')}`))
				for (const problem of snap.problems) log(ui.line(problem, 2))
			}
			blank()
			log(
				failed
					? ui.note('fail', `${failed} of ${plural(snapshots.length, 'locale')} ${failed === 1 ? 'needs' : 'need'} attention.`)
					: ui.note('ok', `${plural(snapshots.length, 'locale')} up to date, ${plural(total * snapshots.length, 'translation')} in place.`)
			)
			blank()
			return failed ? 1 : 0
		}

		const pending = snapshots.filter(snap => snap.untranslated.size > 0)
		const outstanding = sum(pending.map(snap => snap.untranslated.size))

		if (command === 'translate' && values['dry-run']) {
			log(
				pending.length
					? ui.note('info', `Dry run: would translate ${plural(outstanding, 'message')} in ${plural(pending.length, 'locale')}${ai.model ? ` with ${bold(ai.model)}` : ''}. Nothing was written.`)
					: ui.note('ok', 'Everything is translated. Nothing to do.')
			)
			blank()
			return 0
		}

		const written = states.filter(state => writeLocaleFile(state.file, state.messages)).length
		const failures = new Map<string, string[]>()

		/** What is wrong with each locale, under the file it is wrong in. */
		const issues = (snaps: readonly Snapshot[]) => {
			let listed = false
			for (const snap of snaps) {
				const found = [...snap.problems, ...(failures.get(snap.state.locale) ?? [])]
				if (!found.length) continue
				listed = true
				log(ui.note('fail', name(snap.state)))
				for (const issue of found) log(ui.line(issue, 2))
			}
			if (listed) blank()
		}

		if (command === 'extract') {
			issues(snapshots)
			log(written ? ui.note('ok', `Updated ${plural(written, 'file')} in ${relative(cwd, dir) || '.'}.`) : ui.note('ok', 'Every file is already up to date.'))
			if (outstanding) log(ui.note('info', `${plural(outstanding, 'message')} left to translate. Run "textlate translate".`))
			blank()
			return 0
		}

		if (pending.length) {
			const missing = missingAISettings(ai, env)
			if (missing.length) {
				if (!prompt) throw new UsageError(setupHint(cwd, ai, missing))
				log(ui.note('info', `No ${missing.join(' or ')} to translate with yet. Setting that up once:`))
				blank()
				ai = await setupAI({ cwd, ai, configFile, env, prompt, log: line => log(ui.line(line, 0)) })
				blank()
			}
			const runtime: Runtime = {
				fetch: options.fetch ?? globalThis.fetch,
				sleep: options.sleep ?? (ms => new Promise(done => setTimeout(done, ms))),
				env
			}
			const provider = createProvider(ai, runtime)

			log(ui.note('info', `Translating ${plural(outstanding, 'message')} into ${plural(pending.length, 'locale')}${ai.model ? ` with ${bold(ai.model)}` : ''}…`))
			// On a terminal one line keeps track of every locale at once; elsewhere each batch logs a line of its own.
			const live = !options.log && Boolean(process.stdout.isTTY)
			const status = createStatus({ log, interactive: live })
			const progress = new Map(pending.map(snap => [snap.state.locale, { done: 0, size: snap.untranslated.size }]))
			const show = (locale: string, done: number, size: number) => {
				progress.set(locale, { done, size })
				const finished = sum([...progress.values()].map(({ done: count }) => count))
				const each = progress.size > 1 ? `  ${dim([...progress].map(([code, { done: count, size: all }]) => `${code} ${count}/${all}`).join(` ${ui.glyphs.dot} `))}` : ''
				status.set(live ? ui.line(`${ui.bar(finished / outstanding)}  ${finished}/${outstanding}${each}`, 0) : ui.line(`${locale}  ${done}/${size} translated`, 1))
			}

			await pool(pending, ai.concurrency ?? 4, async ({ state, untranslated }) => {
				let done = 0
				try {
					const outcome = await translateMessages({
						provider,
						sourceLocale,
						locale: state.locale,
						messages: untranslated,
						instructions: ai.instructions,
						batchSize: ai.batchSize,
						onTranslated: translations => {
							// Saved after every batch, so an interrupted run never pays for the same translation twice.
							state.messages = { ...state.messages, ...translations }
							writeLocaleFile(state.file, state.messages)
							done += Object.keys(translations).length
							show(state.locale, done, untranslated.size)
						}
					})
					if (outcome.failed.length) failures.set(state.locale, outcome.failed.map(({ text, reason }) => `${quote(text)}: ${reason}`))
				} catch (cause) {
					failures.set(state.locale, [(cause as Error).message])
				}
			})
			status.end()
		}

		const after = states.map(state => snapshot(scan.messages, state))
		const left = sum(after.map(snap => snap.untranslated.size))
		if (pending.length) catalogs(after, 'After translating')
		issues(after)
		log(
			left
				? ui.note(failures.size ? 'fail' : 'warn', `${plural(outstanding - left, 'message')} translated, ${plural(left, 'message')} still missing.${failures.size ? ' Run "textlate translate" again to retry.' : ''}`)
				: ui.note('ok', outstanding ? `Translated ${plural(outstanding, 'message')}. Every locale is complete.` : 'Everything is already translated.')
		)
		blank()
		return failures.size ? 1 : 0
	} catch (cause) {
		if (cause instanceof Cancelled) {
			error(ui.note('warn', 'Cancelled.'))
			return 130
		}
		error(ui.note('fail', (cause as Error).message))
		return cause instanceof UsageError ? 2 : 1
	} finally {
		if (!options.prompt) prompt?.close()
	}
}
