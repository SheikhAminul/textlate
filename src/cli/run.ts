/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { AIConfig, Config } from '../config.js'
import { createProvider, languageName, limiter, translateMessages, type Runtime } from './ai.js'
import { compiledOutdated, metaFileOf, openScanCache, routesFileOf, routesOutdated, writeCompiled, writeMeta, writeRoutes } from './artifacts.js'
import { loadTypeScript } from './ast.js'
import { checkTranslation } from './catalog.js'
import {
	acceptRun,
	fileOf,
	isOutdated,
	openLocale,
	recordTranslations,
	resolveProject,
	reviewRun,
	scanProject,
	UsageError,
	writeRun,
	type LocaleRun,
	type Project,
	type Review
} from './project.js'
import { Cancelled, createPrompter, isInteractive, type Prompter } from './prompt.js'
import { missingAISettings, setupAI, setupHint } from './setup.js'
import { createRenderer, createStatus, type Column, type Row, type Styler } from './ui.js'

const CONFIG_FILES = ['ts', 'mts', 'js', 'mjs', 'json'].map(extension => `textlate.config.${extension}`)

const HELP = `Usage: textlate <command> [paths...] [options]

Commands:
  extract    Find the messages in your code and update the translation files
  translate  Extract, then translate with AI what isn't translated yet, or changed since it was
  check      Fail if a translation file is out of date, untranslated, changed, invalid or unreviewed (for CI)
  accept     Mark the AI translations of the locales as reviewed by a person
  compile    Write the compiled catalogs and the routes' message lists, from the files as they are (for builds)
  setup      Choose the AI provider, model and API key, and save them

Arguments:
  paths                    Files or directories to scan (default: src; with namespaces, each one's include)

Options:
  -c, --config <file>      Config file (default: textlate.config.{ts,mts,js,mjs,json})
  -d, --dir <dir>          Directory of translation files (default: src/locales)
  -s, --source <locale>    Language the text in your code is written in (default: en)
  -l, --locales <list>     Locales to work on, e.g. es,bn (default: each locale with files in --dir)
  -f, --functions <list>   Functions whose first argument is a message (default: translate,msg)
  -p, --properties <list>  Object properties whose string values are messages, e.g. label,description
      --reviewed <list>    Locales whose translations must be reviewed for check to pass (* for all)
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
  textlate check
  textlate accept --locales de`

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
				properties: { type: 'string', short: 'p' },
				reviewed: { type: 'string' },
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
	if (command !== 'extract' && command !== 'translate' && command !== 'check' && command !== 'accept' && command !== 'compile' && command !== 'setup') {
		error(`${command ? `Unknown command "${command}".` : 'Missing command.'}\n\n${HELP}`)
		return 2
	}

	const ui = createRenderer({ color: values['no-color'] ? false : options.color, unicode: options.unicode, columns: options.columns })
	const blank = () => log('')
	const { dim, bold } = ui.theme
	// Questions are only asked on a terminal, so a script or a CI run fails with an explanation instead of hanging.
	const prompt = options.prompt ?? (values['no-input'] || !isInteractive() ? undefined : createPrompter({ indent: '  ' }))
	let saveCache = () => {}

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

		const project = resolveProject(cwd, config, {
			paths,
			locales: list(values.locales),
			dir: values.dir,
			source: values.source,
			functions: list(values.functions),
			properties: list(values.properties),
			keepUnused: values['keep-unused'],
			reviewed: list(values.reviewed)
		})
		// The project's own TypeScript parses its files exactly; scans of unchanged files are kept between runs.
		const typescript = await loadTypeScript(cwd)
		const scanCache = openScanCache(cwd)
		saveCache = scanCache.save
		const scanOptions = { typescript, cache: scanCache.cache, functions: project.functions }
		const scan = scanProject(project, scanOptions)
		const total = scan.messages.size
		/** The files built from the catalogs and the code: compiled catalogs, coverage for SEO, and routes' message lists. */
		const writeArtifacts = () => {
			const compiled = writeCompiled(project, scan, runs)
			writeMeta(project, scan, runs)
			const routes = writeRoutes(project, scanOptions)
			return { compiled, routes }
		}
		const runs = project.locales.map(locale => openLocale(project, scan, locale))
		const check = (locale: string) => (source: Parameters<typeof checkTranslation>[0], value: unknown) => checkTranslation(source, value, locale, project.glossary)
		const reviewOf = (localeRun: LocaleRun) => reviewRun(scan, localeRun, check(localeRun.locale))
		const where = (localeRun: LocaleRun) =>
			project.namespaced ? `${relative(cwd, join(project.dir, localeRun.locale)) || localeRun.locale}/` : relative(cwd, localeRun.files[0]!.file.path)

		// What the run is about, before it does anything: the languages, the text found and where the files are.
		blank()
		log(ui.title(`textlate ${command}`))
		blank()
		lines(
			ui.details([
				['Source', project.sourceLocale, languageName(project.sourceLocale)],
				['Locales', String(project.locales.length), project.locales.join(', ')],
				['Messages', String(total), `in ${plural(scan.files, 'file')}${typescript ? dim(' · parsed with TypeScript') : ''}`],
				project.namespaced && ['Namespaces', String(project.namespaces.length), project.namespaces.map(({ name }) => `${name} ${dim(String(scan.byNamespace.get(name)?.length ?? 0))}`).join(', ')],
				['Files', relative(cwd, fileOf(project, '<locale>', project.namespaced ? '<namespace>' : '')) || '.'],
				Boolean(configFile) && ['Config', relative(cwd, configFile!)]
			])
		)
		if (scan.warnings.length) {
			blank()
			for (const warning of scan.warnings) log(ui.note('warn', `${warning.file}:${warning.line}  ${warning.message}`))
		}

		const table = catalogTable(ui, project, total)
		const show = (heading: string, snaps: readonly Snapshot[]) => {
			blank()
			log(ui.heading(heading))
			blank()
			lines(table(snaps))
			blank()
		}
		const snapshotOf = (localeRun: LocaleRun): Snapshot => ({ run: localeRun, review: reviewOf(localeRun), outdated: isOutdated(localeRun, scan) })
		const snapshots = runs.map(snapshotOf)
		show('Catalogs', snapshots)

		if (command === 'compile') {
			const { compiled, routes } = writeArtifacts()
			if (project.compile) log(ui.note('ok', compiled ? `Compiled ${plural(compiled, 'file')} into ${relative(cwd, project.compile.dir) || '.'}.` : 'The compiled catalogs are up to date.'))
			if (project.routes) log(ui.note('ok', routes ? `Wrote the routes' messages to ${relative(cwd, routesFileOf(project))}.` : "The routes' messages are up to date."))
			if (!project.compile && !project.routes) log(ui.note('info', `Updated ${relative(cwd, metaFileOf(project))}. Set \`compile\` or \`routes\` in the config to build more.`))
			blank()
			return 0
		}

		if (command === 'check') {
			let failed = 0
			// Built files that are there must match: a stale compiled catalog or routes list ships the wrong text.
			const stale = [
				compiledOutdated(project, scan, runs) && `compiled catalogs in ${relative(cwd, project.compile!.dir) || '.'} are out of date (run textlate compile)`,
				routesOutdated(project, scanOptions) && `${relative(cwd, routesFileOf(project))} is out of date (run textlate compile)`
			].filter((reason): reason is string => Boolean(reason))
			for (const reason of stale) log(ui.note('fail', reason))
			if (stale.length) failed++
			for (const snap of snapshots) {
				const { review } = snap
				const missing = review.untranslated.size - review.previous.size
				const reasons = [
					snap.outdated && 'out of date (run textlate extract)',
					missing > 0 && `${missing} untranslated (run textlate translate)`,
					review.previous.size > 0 && `${review.previous.size} changed since translated (run textlate translate)`,
					review.problems.length > 0 && plural(review.problems.length, 'invalid translation'),
					project.reviewed(snap.run.locale) && review.unreviewed > 0 && `${review.unreviewed} not reviewed (review them, then textlate accept)`
				].filter((reason): reason is string => Boolean(reason))
				if (reasons.length) failed++
				log(ui.note(reasons.length ? 'fail' : 'ok', `${where(snap.run)}  ${reasons.length ? reasons.join(` ${ui.glyphs.dot} `) : dim('up to date')}`))
				for (const { key, problem } of review.problems) log(ui.line(`${quote(key)} ${problem}`, 2))
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

		const issues = (snaps: readonly Snapshot[], failures: ReadonlyMap<string, string[]> = new Map()) => {
			let listed = false
			for (const snap of snaps) {
				const found = [...snap.review.problems.map(({ key, problem }) => `${quote(key)} ${problem}`), ...(failures.get(snap.run.locale) ?? [])]
				if (!found.length) continue
				listed = true
				log(ui.note('fail', where(snap.run)))
				for (const issue of found) log(ui.line(issue, 2))
			}
			if (listed) blank()
		}

		if (command === 'accept') {
			let accepted = 0
			for (const localeRun of runs) accepted += acceptRun(localeRun, scan)
			for (const localeRun of runs) writeRun(localeRun, scan)
			writeArtifacts()
			log(
				accepted
					? ui.note('ok', `Marked ${plural(accepted, 'translation')} in ${plural(runs.length, 'locale')} as reviewed.`)
					: ui.note('ok', 'Nothing to accept: every translation is reviewed already.')
			)
			const left = sum(runs.map(localeRun => reviewOf(localeRun).untranslated.size))
			if (left) log(ui.note('info', `${plural(left, 'message')} still to translate first. Run "textlate translate".`))
			blank()
			return 0
		}

		const pending = snapshots.filter(snap => snap.review.untranslated.size > 0)
		const outstanding = sum(pending.map(snap => snap.review.untranslated.size))

		if (command === 'translate' && values['dry-run']) {
			log(
				pending.length
					? ui.note('info', `Dry run: would translate ${plural(outstanding, 'message')} in ${plural(pending.length, 'locale')}${ai.model ? ` with ${bold(ai.model)}` : ''}. Nothing was written.`)
					: ui.note('ok', 'Everything is translated. Nothing to do.')
			)
			blank()
			return 0
		}

		const written = sum(runs.map(localeRun => writeRun(localeRun, scan)))

		if (command === 'extract') {
			writeArtifacts()
			issues(snapshots)
			const carried = sum(runs.map(localeRun => localeRun.sync.carried))
			log(written ? ui.note('ok', `Updated ${plural(written, 'file')} in ${relative(cwd, project.dir) || '.'}.`) : ui.note('ok', 'Every file is already up to date.'))
			if (carried) log(ui.note('info', `${plural(carried, 'changed message')} kept the old text's translation until "textlate translate" updates it.`))
			if (outstanding) log(ui.note('info', `${plural(outstanding, 'message')} left to translate. Run "textlate translate".`))
			blank()
			return 0
		}

		const failures = new Map<string, string[]>()
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
			// One pool of requests for every locale: a large catalog keeps them all busy, a small one finishes at once.
			const limit = limiter(Math.max(1, ai.concurrency ?? 8))

			log(ui.note('info', `Translating ${plural(outstanding, 'message')} into ${plural(pending.length, 'locale')}${ai.model ? ` with ${bold(ai.model)}` : ''}…`))
			// On a terminal one line keeps track of every locale at once; elsewhere each batch logs a line of its own.
			const live = !options.log && Boolean(process.stdout.isTTY)
			const status = createStatus({ log, interactive: live })
			const progress = new Map(pending.map(snap => [snap.run.locale, { done: 0, size: snap.review.untranslated.size }]))
			const report = (locale: string, done: number, size: number) => {
				progress.set(locale, { done, size })
				const finished = sum([...progress.values()].map(({ done: count }) => count))
				const each = progress.size > 1 ? `  ${dim([...progress].map(([code, { done: count, size: all }]) => `${code} ${count}/${all}`).join(` ${ui.glyphs.dot} `))}` : ''
				status.set(live ? ui.line(`${ui.bar(finished / outstanding)}  ${finished}/${outstanding}${each}`, 0) : ui.line(`${locale}  ${done}/${size} translated`, 1))
			}

			await Promise.all(
				pending.map(async ({ run: localeRun, review }) => {
					let done = 0
					try {
						const outcome = await translateMessages({
							provider,
							sourceLocale: project.sourceLocale,
							locale: localeRun.locale,
							messages: review.untranslated,
							previous: review.previous,
							instructions: ai.instructions,
							glossary: project.glossary,
							batchSize: ai.batchSize,
							limit,
							onTranslated: translations => {
								// Saved after every batch, so an interrupted run never pays for the same translation twice.
								recordTranslations(localeRun, translations)
								writeRun(localeRun, scan)
								done += Object.keys(translations).length
								report(localeRun.locale, done, review.untranslated.size)
							}
						})
						if (outcome.failed.length) failures.set(localeRun.locale, outcome.failed.map(({ text, reason }) => `${quote(text)}: ${reason}`))
					} catch (cause) {
						failures.set(localeRun.locale, [(cause as Error).message])
					}
				})
			)
			status.end()
		}

		writeArtifacts()
		const after = runs.map(snapshotOf)
		const left = sum(after.map(snap => snap.review.untranslated.size))
		if (pending.length) show('After translating', after)
		issues(after, failures)
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
		try {
			saveCache()
		} catch {}
	}
}

/** Where one locale stands: what it has, what it misses and what is wrong with it. */
interface Snapshot {
	run: LocaleRun
	review: Review
	/** A file on disk is not what extract would write: messages were added, removed or reordered. */
	outdated: boolean
}

/** The catalogs table: one row per locale, and a total row when there is more than one. */
const catalogTable = (ui: ReturnType<typeof createRenderer>, project: Project, total: number) => {
	const { dim, bold } = ui.theme
	const gated = project.locales.some(project.reviewed)
	const COLUMNS: Column[] = [
		{ title: 'Locale' },
		{ title: 'Language', flex: true, droppable: true },
		{ title: 'Translated', align: 'right' },
		{ title: 'Missing', align: 'right' },
		{ title: 'Changed', align: 'right', optional: true },
		{ title: 'Unreviewed', align: 'right', optional: true },
		{ title: 'New', align: 'right', optional: true },
		{ title: 'Unused', align: 'right', optional: true },
		{ title: 'Invalid', align: 'right', optional: true }
	]
	// Zero is left blank: the table shows a dash, and a column that is zero everywhere is left out altogether.
	const count = (value: number, sign = '', style: Styler = text => text) => (value ? style(`${sign}${value}`) : '')
	const share = (done: number, all: number) => `${done}/${all}${all ? `  ${dim(`${Math.round((done / all) * 100)}%`)}` : ''}`
	const cells = (locale: string, language: string, snaps: readonly Snapshot[]): string[] => {
		const changed = sum(snaps.map(snap => snap.review.previous.size))
		const missing = sum(snaps.map(snap => snap.review.untranslated.size)) - changed
		return [
			locale,
			language,
			share(snaps.length * total - missing - changed, snaps.length * total),
			count(missing, '', ui.theme.yellow),
			count(changed, '', ui.theme.yellow),
			gated ? count(sum(snaps.filter(snap => project.reviewed(snap.run.locale)).map(snap => snap.review.unreviewed)), '', ui.theme.yellow) : '',
			count(sum(snaps.map(snap => snap.run.sync.added)), '+'),
			count(sum(snaps.map(snap => snap.run.sync.removed)), '-'),
			count(sum(snaps.map(snap => snap.review.problems.length)), '', ui.theme.red)
		]
	}
	return (snaps: readonly Snapshot[]) => {
		const rows: Row[] = snaps.map(snap => ({ cells: cells(ui.theme.cyan(snap.run.locale), languageName(snap.run.locale), [snap]) }))
		if (snaps.length > 1) rows.push({ rule: true, cells: cells(bold('Total'), dim(plural(snaps.length, 'locale')), snaps) })
		return ui.table(COLUMNS, rows)
	}
}

