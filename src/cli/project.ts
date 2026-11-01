/// <reference types="node" />
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Config, GlossaryTerm } from '../config.js'
import type { Message } from '../types.js'
import { isTranslated, readLocaleFile, serialize, writeLocaleFile, type LocaleFile, type LocaleMessages } from './catalog.js'
import { scanFiles, type ScanWarning } from './scan.js'
import { decodeEntry, encodeEntry, hashOf, syncLocale, textOfKey, type StateEntry, type SyncResult } from './sync.js'

/** The namespace of a project with one file per locale. */
export const DEFAULT_NAMESPACE = 'default'
const LOCALE = /^[a-z]{2,3}(?:[-_][a-z\d]+)*$/i
const LOCALE_FILE = /^([a-z]{2,3}(?:[-_][a-z\d]+)*)\.json$/i

/** Thrown for a mistake in how the command was called or configured: exit code 2. */
export class UsageError extends Error {}

export interface NamespaceSpec {
	name: string
	include: readonly string[]
	exclude: readonly string[]
	functions: readonly string[] | undefined
	properties: readonly string[]
}

/** What a run works on: the config and the command line, resolved. */
export interface Project {
	cwd: string
	sourceLocale: string
	dir: string
	locales: string[]
	/** Files per namespace, `<dir>/<locale>/<namespace>.json`, rather than `<dir>/<locale>.json`. */
	namespaced: boolean
	namespaces: NamespaceSpec[]
	keepUnused: boolean
	carryOver: boolean
	glossary: Readonly<Record<string, GlossaryTerm>> | undefined
	/** Whether a locale's translations must be reviewed for `check` to pass. */
	reviewed: (locale: string) => boolean
}

export interface ProjectOptions {
	paths: readonly string[]
	locales?: readonly string[] | undefined
	dir?: string | undefined
	source?: string | undefined
	functions?: readonly string[] | undefined
	properties?: readonly string[] | undefined
	keepUnused?: boolean | undefined
	reviewed?: readonly string[] | undefined
}

const isDirectory = (path: string) => existsSync(path) && statSync(path).isDirectory()

/** Resolve the config and the command line into the project a run works on. */
export const resolveProject = (cwd: string, config: Config, options: ProjectOptions): Project => {
	const sourceLocale = options.source ?? config.sourceLocale ?? 'en'
	const dir = resolve(cwd, options.dir ?? config.dir ?? 'src/locales')
	const namespaced = Boolean(config.namespaces && Object.keys(config.namespaces).length)
	if (namespaced && options.paths.length) throw new UsageError('With namespaces, each one says what to scan (its `include`): leave the paths out.')

	const namespaces: NamespaceSpec[] = namespaced
		? Object.entries(config.namespaces!).map(([name, spec]) => {
				if (!/^[\w.-]+$/.test(name)) throw new UsageError(`"${name}" can't name a namespace: use letters, digits, ".", "-" and "_".`)
				if (!spec.include?.length) throw new UsageError(`The "${name}" namespace needs \`include\`: the files and directories its messages are in.`)
				return {
					name,
					include: spec.include,
					exclude: [...(config.exclude ?? []), ...(spec.exclude ?? [])],
					functions: options.functions ?? spec.functions ?? config.functions,
					properties: options.properties ?? spec.properties ?? config.properties ?? []
				}
			})
		: [
				{
					name: DEFAULT_NAMESPACE,
					include: options.paths.length ? options.paths : (config.include ?? ['src']),
					exclude: config.exclude ?? [],
					functions: options.functions ?? config.functions,
					properties: options.properties ?? config.properties ?? []
				}
			]
	for (const namespace of namespaces) {
		for (const path of namespace.include) {
			if (!existsSync(resolve(cwd, path))) {
				throw new UsageError(
					`Nothing to scan at "${path}". Pass the files or directories that hold your code, or set \`include\` in textlate.config.js.`
				)
			}
		}
	}

	// The locales with files already: `<locale>.json`, or a `<locale>/` folder with namespaces.
	const existing = !isDirectory(dir)
		? []
		: readdirSync(dir).flatMap(name => (namespaced ? (LOCALE.test(name) && isDirectory(join(dir, name)) ? [name] : []) : (LOCALE_FILE.exec(name)?.[1] ?? [])))
	const locales = [...(options.locales ?? config.locales ?? existing.filter(locale => locale !== sourceLocale).sort())]
	if (!locales.length) {
		const example = relative(cwd, namespaced ? join(dir, 'es', `${namespaces[0]!.name}.json`) : join(dir, 'es.json'))
		throw new UsageError(`No locales to translate into. Pass --locales es,fr, add \`locales: ['es', 'fr']\` to textlate.config.js, or create ${example}.`)
	}
	for (const locale of locales) if (!LOCALE.test(locale)) throw new UsageError(`"${locale}" isn't a locale code, like es or pt-BR.`)
	if (locales.includes(sourceLocale)) throw new UsageError(`"${sourceLocale}" is the source locale: the text in your code. It needs no file.`)

	const reviewed = new Set(options.reviewed ?? config.reviewed ?? [])
	return {
		cwd,
		sourceLocale,
		dir,
		locales,
		namespaced,
		namespaces,
		keepUnused: options.keepUnused ?? config.keepUnused ?? false,
		carryOver: config.carryOver ?? true,
		glossary: config.glossary,
		reviewed: locale => reviewed.has('*') || reviewed.has(locale)
	}
}

export const fileOf = (project: Project, locale: string, namespace: string) =>
	project.namespaced ? join(project.dir, locale, `${namespace}.json`) : join(project.dir, `${locale}.json`)

/** Where textlate keeps track of each translation's state: beside the files, out of every bundle. */
export const stateFileOf = (project: Project, locale: string) => join(project.dir, '.textlate', `${locale}.json`)

// ——— The messages in the code ———————————————————————————————————————————————————————————————————————————————

export interface Scan {
	/** Every message, by key, in order of first use. A plural wins over the same text used as a string. */
	messages: Map<string, Message>
	/** Each namespace's messages' keys, in order of first use. */
	byNamespace: Map<string, string[]>
	warnings: ScanWarning[]
	files: number
}

export const scanProject = (project: Project): Scan => {
	const messages = new Map<string, Message>()
	const byNamespace = new Map<string, string[]>()
	const warnings = new Map<string, ScanWarning>()
	let count = 0
	for (const namespace of project.namespaces) {
		const scan = scanFiles(namespace.include, project.cwd, namespace)
		count += scan.files
		for (const [key, message] of scan.messages) if (typeof message !== 'string' || !messages.has(key)) messages.set(key, message)
		byNamespace.set(namespace.name, [...scan.messages.keys()])
		for (const warning of scan.warnings) warnings.set(`${warning.file}:${warning.line}:${warning.message}`, warning)
	}
	return { messages, byNamespace, warnings: [...warnings.values()], files: count }
}

// ——— One locale's files ————————————————————————————————————————————————————————————————————————————————————

export interface LocaleRun {
	locale: string
	files: { namespace: string; file: LocaleFile }[]
	stateFile: LocaleFile
	sync: SyncResult
	/** The namespace each kept unused translation was in. */
	unusedIn: Map<string, string>
}

/** A namespace's file as it should be: its messages in the code's order, then translations it keeps unused. */
const contentOf = (run: LocaleRun, scan: Scan, namespace: string, first: boolean): LocaleMessages => {
	const content = new Map<string, unknown>()
	for (const key of scan.byNamespace.get(namespace) ?? []) content.set(key, run.sync.values.get(key))
	for (const key of run.sync.unused) if ((run.unusedIn.get(key) ?? (first ? namespace : undefined)) === namespace) content.set(key, run.sync.values.get(key))
	// A Map, then `fromEntries`, so a text like `__proto__` is data rather than a prototype.
	return Object.fromEntries(content) as LocaleMessages
}

const stateContentOf = (run: LocaleRun): LocaleMessages => {
	const content = new Map<string, string>()
	for (const key of run.sync.values.keys()) {
		const entry = run.sync.state.get(key)
		if (entry) content.set(key, encodeEntry(entry))
	}
	return Object.fromEntries(content)
}

/** Read a locale's files and bring them in line with the code (in memory: `writeRun` saves them). */
export const openLocale = (project: Project, scan: Scan, locale: string): LocaleRun => {
	const stateFile = readLocaleFile(stateFileOf(project, locale))
	const recorded = new Map<string, StateEntry>()
	for (const [key, value] of Object.entries(stateFile.messages)) {
		const entry = decodeEntry(value)
		if (entry) recorded.set(key, entry)
	}
	const files = project.namespaces.map(({ name }) => ({ namespace: name, file: readLocaleFile(fileOf(project, locale, name)) }))
	const existing = new Map<string, unknown>()
	const origin = new Map<string, string>()
	for (const { namespace, file } of files) {
		for (const [key, value] of Object.entries(file.messages)) {
			const current = existing.get(key)
			// The same message in two files: a translation over none, and a person's edit over what textlate wrote.
			const edited = (candidate: unknown) => recorded.get(key)?.status === 'machine' && recorded.get(key)?.hash !== hashOf(candidate)
			if (current === undefined || (!isTranslated(current) && isTranslated(value)) || (isTranslated(value) && edited(value) && !edited(current))) {
				existing.set(key, value)
				if (!origin.has(key)) origin.set(key, namespace)
			}
		}
	}
	const sync = syncLocale(scan.messages, existing, recorded, locale, { keepUnused: project.keepUnused, carryOver: project.carryOver })
	return { locale, files, stateFile, sync, unusedIn: new Map(sync.unused.map(key => [key, origin.get(key)!])) }
}

/** Each file of the locale with what it should hold. */
const contentsOf = (run: LocaleRun, scan: Scan) => [
	...run.files.map(({ namespace, file }, index) => ({ file, content: contentOf(run, scan, namespace, index === 0) })),
	{ file: run.stateFile, content: stateContentOf(run) }
]

/**
 * Whether any of the locale's translation files isn't what it should be. The state file doesn't count: nothing reads it
 * at runtime, and what it would record (a person's edit, say) is worked out afresh on every run anyway.
 */
export const isOutdated = (run: LocaleRun, scan: Scan) =>
	contentsOf(run, scan).some(({ file, content }) => file !== run.stateFile && serialize(file, content) !== file.raw)

/** Save the locale's files that changed. Returns how many were written (the state file not counted). */
export const writeRun = (run: LocaleRun, scan: Scan): number => {
	let written = 0
	for (const { file, content } of contentsOf(run, scan)) {
		// The state file appears only once there's something to keep track of.
		if (file === run.stateFile && file.raw === undefined && !Object.keys(content).length) continue
		if (writeLocaleFile(file, content) && file !== run.stateFile) written++
	}
	return written
}

/** Record AI translations: the values, and their state. */
export const recordTranslations = (run: LocaleRun, translations: Record<string, unknown>) => {
	for (const [key, value] of Object.entries(translations)) {
		run.sync.values.set(key, value)
		run.sync.state.set(key, { status: 'machine', hash: hashOf(value) })
	}
}

// ——— Where a locale stands ———————————————————————————————————————————————————————————————————————————————————

export interface Review {
	/** Messages to translate: not translated yet, or changed since they were. */
	untranslated: Map<string, Message>
	/** Of those, the changed ones: their old text and translation. */
	previous: Map<string, { text: string; translation: unknown }>
	/** Translations whose params, tags, plural forms or kept terms don't match the source. */
	problems: { key: string; problem: string }[]
	/** Translated messages no person has reviewed yet. */
	unreviewed: number
}

export const reviewRun = (scan: Scan, run: LocaleRun, check: (source: Message, value: unknown) => string[]): Review => {
	const untranslated = new Map<string, Message>()
	const previous = new Map<string, { text: string; translation: unknown }>()
	const problems: { key: string; problem: string }[] = []
	let unreviewed = 0
	for (const [key, source] of scan.messages) {
		const value = run.sync.values.get(key)
		const entry = run.sync.state.get(key)
		if (!isTranslated(value)) {
			untranslated.set(key, source)
			continue
		}
		if (entry?.status === 'changed') {
			untranslated.set(key, source)
			previous.set(key, { text: textOfKey(entry.from ?? key, typeof source === 'string' ? undefined : source.context), translation: value })
			continue
		}
		if (entry?.status !== 'reviewed') unreviewed++
		for (const problem of check(source, value)) problems.push({ key, problem })
	}
	return { untranslated, previous, problems, unreviewed }
}

/** Mark a locale's AI translations as reviewed. Returns how many. */
export const acceptRun = (run: LocaleRun, scan: Scan): number => {
	let accepted = 0
	for (const key of scan.messages.keys()) {
		const entry = run.sync.state.get(key)
		if (entry?.status !== 'machine') continue
		run.sync.state.set(key, { status: 'reviewed' })
		accepted++
	}
	return accepted
}

