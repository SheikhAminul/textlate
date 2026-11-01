/// <reference types="node" />
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { hashKey } from '../hash.js'
import { isTranslated, writeAtomic } from './catalog.js'
import type { FileScan } from './ast.js'
import type { LocaleRun, Project, Scan } from './project.js'
import { buildRouteManifest } from './routes.js'
import { scanFile, type ScanCache, type ScanOptions } from './scan.js'
import { hashOf } from './sync.js'

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const read = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
/** Write a generated file when what it should hold changed. Returns whether it was written. */
const writeIfChanged = (path: string, content: string) => {
	if (read(path) === content) return false
	writeAtomic(path, content)
	return true
}

// ——— Scans kept between runs ————————————————————————————————————————————————————————————————————————————————

/** Scans of unchanged files, kept in `node_modules/.cache/textlate`: a large codebase is read once, then only what changes. */
export const openScanCache = (cwd: string): { cache: ScanCache | undefined; save: () => void } => {
	const directory = join(cwd, 'node_modules')
	if (!existsSync(directory)) return { cache: undefined, save: () => {} }
	const path = join(directory, '.cache', 'textlate', 'scan.json')
	let stored: Record<string, { stamp: string; scan: FileScan }> = {}
	try {
		const parsed = JSON.parse(read(path) ?? '{}') as { version?: number; entries?: typeof stored }
		if (parsed.version === 1 && parsed.entries) stored = parsed.entries
	} catch {}
	// Only what this run looked at is kept, so files that are gone drop out.
	const used: typeof stored = {}
	let changed = false
	return {
		cache: {
			get: (key, stamp) => {
				const entry = stored[key]
				if (entry?.stamp !== stamp) return undefined
				used[key] = entry
				return entry.scan
			},
			set: (key, stamp, scan) => {
				used[key] = { stamp, scan }
				changed = true
			}
		},
		save: () => {
			if (changed || Object.keys(used).length !== Object.keys(stored).length) writeAtomic(path, JSON.stringify({ version: 1, entries: used }))
		}
	}
}

// ——— Compiled catalogs ——————————————————————————————————————————————————————————————————————————————————————

const compiledFileOf = (project: Project, locale: string, namespace: string) =>
	project.namespaced ? join(project.compile!.dir, locale, `${namespace}.json`) : join(project.compile!.dir, `${locale}.json`)

/**
 * Each compiled file of a locale and what it should hold: only translated messages, keyed by their short hash — what the
 * browser loads, a third smaller or more than the catalog.
 */
const compiledOf = (project: Project, scan: Scan, run: LocaleRun) => {
	const owners = new Map<string, string>()
	return project.namespaces.map(({ name }) => {
		const content = new Map<string, unknown>()
		for (const key of scan.byNamespace.get(name) ?? []) {
			const value = run.sync.values.get(key)
			if (!isTranslated(value)) continue
			const id = hashKey(key)
			const owner = owners.get(id)
			// 53 bits make this all but impossible; were it ever to happen, the build stops rather than mix two messages up.
			if (owner !== undefined && owner !== key) throw new Error(`"${owner}" and "${key}" have the same short key: reword one of them.`)
			owners.set(id, key)
			content.set(id, value)
		}
		return { path: compiledFileOf(project, run.locale, name), content: json(Object.fromEntries(content)) }
	})
}

/** Write the compiled catalogs that changed. Returns how many were written. */
export const writeCompiled = (project: Project, scan: Scan, runs: readonly LocaleRun[]): number =>
	project.compile ? runs.flatMap(run => compiledOf(project, scan, run)).filter(({ path, content }) => writeIfChanged(path, content)).length : 0

/** Whether compiled catalogs on disk differ from what `compile` would write. Missing ones don't count: they may be built later. */
export const compiledOutdated = (project: Project, scan: Scan, runs: readonly LocaleRun[]): boolean =>
	Boolean(project.compile) && runs.flatMap(run => compiledOf(project, scan, run)).some(({ path, content }) => existsSync(path) && read(path) !== content)

// ——— What each locale has, for SEO ——————————————————————————————————————————————————————————————————————————

type MetaEntry = { messages: number; translated: number; reviewed: number; updated: string; hash: string }
type Meta = Record<string, Record<string, MetaEntry>>

export const metaFileOf = (project: Project) => join(project.dir, '.textlate', 'meta.json')

/**
 * Write each locale's coverage and last change: what `textlate/next` uses to leave half-translated pages out of search
 * engines, and to date the sitemap. A namespace's date moves only when its translations change.
 */
export const writeMeta = (project: Project, scan: Scan, runs: readonly LocaleRun[], now = new Date()): boolean => {
	const path = metaFileOf(project)
	let previous: Meta = {}
	try {
		previous = JSON.parse(read(path) ?? '{}') as Meta
	} catch {}
	const meta: Meta = {}
	for (const run of runs) {
		meta[run.locale] = {}
		for (const { name } of project.namespaces) {
			const keys = scan.byNamespace.get(name) ?? []
			let translated = 0
			let reviewed = 0
			const values: unknown[] = []
			for (const key of keys) {
				const value = run.sync.values.get(key)
				values.push(value)
				if (!isTranslated(value)) continue
				translated++
				if (run.sync.state.get(key)?.status === 'reviewed') reviewed++
			}
			const hash = hashOf([keys, values])
			const before = previous[run.locale]?.[name]
			meta[run.locale]![name] = { messages: keys.length, translated, reviewed, updated: before?.hash === hash ? before.updated : now.toISOString(), hash }
		}
	}
	return writeIfChanged(path, json(meta))
}

// ——— What each route needs in the browser ——————————————————————————————————————————————————————————————————

export const routesFileOf = (project: Project) => join(project.dir, '.textlate', 'routes.json')

/** The scan options for a file: those of the namespace it's in, or the project's defaults. */
const scanOptionsFor = (project: Project, cwd: string, options: ScanOptions) => {
	const namespaces = project.namespaces.map(namespace => ({ namespace, include: namespace.include.map(path => join(cwd, path)), exclude: namespace.exclude.map(path => join(cwd, path)) }))
	return (file: string): ScanOptions => {
		const within = (prefix: string) => file === prefix || file.startsWith(`${prefix}/`) || file.startsWith(`${prefix}\\`)
		const found = namespaces.find(({ include, exclude }) => include.some(within) && !exclude.some(within))?.namespace
		return { ...options, functions: found?.functions ?? options.functions, properties: found?.properties ?? [] }
	}
}

const routesContentOf = (project: Project, options: ScanOptions) => {
	const cwd = realpathSync(project.cwd)
	const optionsFor = scanOptionsFor(project, cwd, options)
	const manifest = buildRouteManifest(cwd, project.routes!.app, file => scanFile(file, cwd, optionsFor(file)))
	return json(manifest)
}

/** Write the routes manifest when it changed. Returns whether it was written. */
export const writeRoutes = (project: Project, options: ScanOptions): boolean =>
	Boolean(project.routes) && writeIfChanged(routesFileOf(project), routesContentOf(project, options))

export const routesOutdated = (project: Project, options: ScanOptions): boolean =>
	Boolean(project.routes) && existsSync(routesFileOf(project)) && read(routesFileOf(project)) !== routesContentOf(project, options)

export const relativeTo = (project: Project, path: string) => relative(project.cwd, path)
