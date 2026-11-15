/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { AIConfig, Config } from '../config.js'
import type { Message } from '../types.js'
import { createProvider, languageName, translateMessages, type Runtime } from './ai.js'
import { checkTranslation, isTranslated, readLocaleFile, serialize, syncMessages, writeLocaleFile, type LocaleFile, type LocaleMessages } from './catalog.js'
import { Cancelled, createPrompter, isInteractive, type Prompter } from './prompt.js'
import { scanFiles, type ScanWarning } from './scan.js'
import { adopt, localesIn, LOCALE_FILE, mainMessages, manifest, readSections, sectionFile, type Section } from './sections.js'
import { missingAISettings, setupAI, setupHint } from './setup.js'
import { createRenderer, createStatus, type Column, type Row, type Styler } from './ui.js'

const CONFIG_FILES = ['ts', 'mts', 'js', 'mjs', 'json'].map(extension => `textlate.config.${extension}`)

const HELP = `Usage: textlate <command> [paths...] [options]

Commands:
  extract    Find the messages in your code and update <dir>/<locale>.json
  translate  Extract, then translate what isn't translated yet with AI
  check      Fail if a locale file is out of date, untranslated or invalid (for CI)
  add        Add languages: textlate add fr,de (to some sections only: --sections site,auth)
  setup      Choose the AI provider, model and API key, and save them

Arguments:
  paths                    Files or directories to scan (default: src)

Options:
  -c, --config <file>      Config file (default: textlate.config.{ts,mts,js,mjs,json})
  -d, --dir <dir>          Directory of <locale>.json files (default: src/locales)
  -s, --source <locale>    Language the text in your code is written in (default: en)
  -l, --locales <list>     Locales to translate into, e.g. es,bn (default: each <locale>.json in --dir)
  -f, --functions <list>   Functions whose first argument is a message (default: translate,msg)
      --sections <list>    add: the sections to add the languages to (default: every section)
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
  textlate add ja --sections site
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

const writeText = (path: string, content: string) => {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content)
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
	/** The messages in the code this locale translates. */
	sources: ReadonlyMap<string, Message>
}

/** Untranslated messages, and translations whose params, tags or plural forms don't match the source. */
const review = (state: LocaleState) => {
	const untranslated = new Map<string, Message>()
	const problems: string[] = []
	for (const [text, source] of state.sources) {
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

const snapshot = (state: LocaleState): Snapshot => ({
	state,
	...review(state),
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
				sections: { type: 'string' },
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
	const [command, ...rest] = positionals
	// `add` takes languages where the others take paths.
	const paths = command === 'add' ? [] : rest
	if (values.help || command === 'help') {
		log(HELP)
		return 0
	}
	if (command !== 'extract' && command !== 'translate' && command !== 'check' && command !== 'setup' && command !== 'add') {
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
		const functions = list(values.functions) ?? config.functions
		const withSections = Boolean(config.sections?.length)

		if (command === 'add') {
			const requested = [...new Set(rest.flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean))]
			if (!requested.length) throw new UsageError('Name the languages to add, e.g. "textlate add fr,de".')
			for (const locale of requested) {
				let valid = LOCALE_FILE.test(`${locale}.json`)
				try {
					Intl.getCanonicalLocales(locale)
				} catch {
					valid = false
				}
				if (!valid) throw new UsageError(`"${locale}" isn't a language code. Use one like fr, de or pt-BR.`)
				if (locale === sourceLocale) throw new UsageError(`"${sourceLocale}" is the source locale: the text in your code. It needs no file.`)
			}
			const wanted = list(values.sections)
			let targets = [dir]
			if (withSections) {
				const all = config.sections!.map(section => (typeof section === 'string' ? { path: section } : section))
				const { sections } = readSections(all, { cwd, sourceLocale, functions, only: 'all' })
				for (const name of wanted ?? []) {
					if (!sections.some(section => section.name === name)) throw new UsageError(`No section is called "${name}". The sections are: ${sections.map(section => section.name).join(', ')}.`)
				}
				targets = sections.filter(section => !wanted || wanted.includes(section.name)).map(section => section.dir)
			} else if (wanted) throw new UsageError('--sections needs `sections` in textlate.config.js.')
			blank()
			for (const target of targets) {
				for (const locale of requested) {
					const file = readLocaleFile(join(target, `${locale}.json`))
					if (file.raw !== undefined) continue
					writeLocaleFile(file, {})
					log(ui.note('ok', `Added ${relative(cwd, file.path)}`))
				}
			}
		}

		let sections: Section[] = []
		let warnings: ScanWarning[] = []
		let extra: ReadonlyMap<string, Message> | undefined
		let files = 0
		let available: string[]
		if (withSections) {
			const read = readSections(config.sections!, { cwd, sourceLocale, functions, only: config.sectionMessages ?? 'all' })
			sections = read.sections
			warnings = read.warnings
			files = new Set(sections.flatMap(section => section.files)).size
			available = [...new Set([...sections.flatMap(section => section.locales), ...(config.locales ?? [])])].sort()
		} else available = config.locales ? [...config.locales] : localesIn(dir, sourceLocale)
		const locales = (command === 'add' ? undefined : list(values.locales)) ?? available
		if (!locales.length) {
			throw new UsageError(
				withSections
					? 'No section has a language yet. Add one with "textlate add fr" (or "textlate add fr --sections site").'
					: `No locales to translate into. Pass --locales es,fr, add \`locales: ['es', 'fr']\` to textlate.config.js, or create ${relative(cwd, join(dir, 'es.json'))}.`
			)
		}
		if (locales.includes(sourceLocale)) throw new UsageError(`"${sourceLocale}" is the source locale: the text in your code. It needs no file.`)
		if (withSections) {
			for (const locale of locales) {
				if (!available.includes(locale)) throw new UsageError(`No section is in ${locale} yet. Add it with "textlate add ${locale}".`)
			}
		}

		// With sections, `include` (or paths on the command line) adds text the sections don't import, e.g. emails.
		const include = paths.length ? paths : (config.include ?? (withSections ? [] : ['src']))
		for (const path of include) {
			if (!existsSync(resolve(cwd, path))) {
				throw new UsageError(`Nothing to scan at "${path}". Pass the files or directories that hold your code, or set \`include\` in textlate.config.js.`)
			}
		}
		if (include.length) {
			const scan = scanFiles(include, cwd, functions)
			extra = scan.messages
			warnings = [...warnings, ...scan.warnings]
			files += scan.files
		}

		const keepUnused = values['keep-unused'] ?? config.keepUnused
		const states: LocaleState[] = locales.map(locale => {
			const file = readLocaleFile(join(dir, `${locale}.json`))
			const sources = withSections ? mainMessages(sections, locale, extra) : extra!
			const existing = withSections
				? adopt(file.messages, sections.filter(section => section.locales.includes(locale)).map(section => readLocaleFile(join(section.dir, `${locale}.json`)).messages))
				: file.messages
			return { locale, file, sources, ...syncMessages(sources, existing, locale, keepUnused) }
		})
		const total = new Set(states.flatMap(state => [...state.sources.keys()])).size
		const name = (state: LocaleState) => relative(cwd, state.file.path)
		const snapshots = states.map(state => snapshot(state))

		/** The section files, and `sections.json`, as the main catalog says they should be: those that aren't yet. */
		const sectionChanges = () => {
			const changes: { file: LocaleFile; messages: LocaleMessages | undefined; content: string }[] = []
			for (const section of sections) {
				for (const state of states) {
					if (!section.locales.includes(state.locale)) continue
					const file = readLocaleFile(join(section.dir, `${state.locale}.json`))
					const messages = sectionFile(section, state.messages, state.locale)
					const content = serialize(file, messages)
					if (content !== file.raw) changes.push({ file, messages, content })
				}
			}
			if (withSections) {
				const file = readLocaleFile(join(dir, 'sections.json'))
				const content = manifest(sections, sourceLocale, cwd)
				if (content !== file.raw) changes.push({ file, messages: undefined, content })
			}
			return changes
		}
		const writeSections = () => {
			const changes = sectionChanges()
			for (const { file, messages, content } of changes) {
				if (messages) writeLocaleFile(file, messages)
				else writeText(file.path, content)
			}
			return changes.length
		}

		// What the run is about, before it does anything: the languages, the text found and where the files are.
		blank()
		log(ui.title(`textlate ${command}`))
		blank()
		lines(
			ui.details([
				['Source', sourceLocale, languageName(sourceLocale)],
				['Locales', String(locales.length), locales.join(', ')],
				['Messages', String(total), `in ${plural(files, 'file')}`],
				withSections ? ['Files', join(relative(cwd, dir) || '.', '<locale>.json'), `and each section's ${join('locales', '<locale>.json')}`] : ['Files', join(relative(cwd, dir) || '.', '<locale>.json')],
				Boolean(configFile) && ['Config', relative(cwd, configFile!)]
			])
		)
		if (warnings.length) {
			blank()
			for (const warning of warnings) log(ui.note('warn', `${warning.file}:${warning.line}  ${warning.message}`))
		}
		if (withSections) {
			for (const locale of localesIn(dir, sourceLocale)) {
				if (!available.includes(locale)) log(ui.note('warn', `${relative(cwd, join(dir, `${locale}.json`))}: no section is in this language any more. Delete it, or add it to a section with "textlate add ${locale} --sections …".`))
			}
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
			const all = sum(snaps.map(snap => snap.state.sources.size))
			return [
				locale,
				language,
				share(all - missing, all),
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
		catalogs(snapshots, withSections ? 'Main catalog' : 'Catalogs')
		if (withSections) {
			log(ui.heading('Sections'))
			blank()
			const SECTION_COLUMNS: Column[] = [{ title: 'Section' }, { title: 'Languages', flex: true }, { title: 'Messages', align: 'right' }, { title: 'Files', align: 'right', droppable: true }]
			lines(
				ui.table(
					SECTION_COLUMNS,
					sections.map(section => ({
						cells: [ui.theme.cyan(section.name), section.locales.length ? section.locales.join(', ') : dim(`${sourceLocale} only`), String(section.messages.size), String(section.files)]
					}))
				)
			)
			blank()
		}

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
			// A section file can only be out of date: its translations are the main catalog's.
			const stale = sectionChanges()
			for (const { file } of stale) log(ui.note('fail', `${relative(cwd, file.path)}  out of date (run textlate extract)`))
			blank()
			const translations = sum(snapshots.map(snap => snap.state.sources.size))
			log(
				failed || stale.length
					? ui.note('fail', [failed && `${failed} of ${plural(snapshots.length, 'locale')} ${failed === 1 ? 'needs' : 'need'} attention.`, stale.length && `${plural(stale.length, 'section file')} out of date.`].filter(Boolean).join(' '))
					: ui.note('ok', `${plural(snapshots.length, 'locale')} up to date, ${plural(translations, 'translation')} in place.`)
			)
			blank()
			return failed || stale.length ? 1 : 0
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

		const written = states.filter(state => writeLocaleFile(state.file, state.messages)).length + writeSections()
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

		if (command === 'extract' || command === 'add') {
			issues(snapshots)
			log(written ? ui.note('ok', withSections ? `Updated ${plural(written, 'file')}.` : `Updated ${plural(written, 'file')} in ${relative(cwd, dir) || '.'}.`) : ui.note('ok', 'Every file is already up to date.'))
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

		writeSections()
		const after = states.map(state => snapshot(state))
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
