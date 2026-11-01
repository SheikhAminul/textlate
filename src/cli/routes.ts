/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { FileScan } from './ast.js'

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.cts', '.mjs', '.cjs']
const ROUTE_FILE = /^(page|layout)\.(?:[cm]?[jt]sx?)$/

const isFile = (path: string) => existsSync(path) && statSync(path).isFile()

/** A tsconfig.json, comments and trailing commas allowed. */
const readJsonc = (path: string): any => {
	try {
		const text = readFileSync(path, 'utf8')
			.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string?: string) => string ?? '')
			.replace(/,(\s*[}\]])/g, '$1')
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/** The file a path stands for, as bundlers find it: itself, with an extension, or an index — and `.js` written for `.ts`. */
const fileFor = (path: string): string | undefined => {
	if (isFile(path)) return path
	const bare = path.replace(/\.[cm]?js$/, '')
	for (const extension of EXTENSIONS) if (isFile(bare + extension)) return bare + extension
	for (const extension of EXTENSIONS) if (isFile(join(path, `index${extension}`))) return join(path, `index${extension}`)
	return undefined
}

/** A package.json `exports` entry for `subpath`: exact, or a `*` pattern; conditions picked for a bundler. */
const exported = (exports: unknown, subpath: string): string | undefined => {
	const pick = (target: unknown): string | undefined => {
		if (typeof target === 'string') return target
		if (Array.isArray(target)) return target.map(pick).find(Boolean)
		if (target && typeof target === 'object') {
			for (const condition of ['source', 'import', 'module', 'default', 'require', 'types']) {
				const found = pick((target as Record<string, unknown>)[condition])
				if (found) return found
			}
		}
		return undefined
	}
	if (typeof exports === 'string' || Array.isArray(exports)) return subpath === '.' ? pick(exports) : undefined
	if (!exports || typeof exports !== 'object') return undefined
	const map = exports as Record<string, unknown>
	if (!Object.keys(map).some(key => key.startsWith('.'))) return subpath === '.' ? pick(map) : undefined
	if (map[subpath] !== undefined) return pick(map[subpath])
	for (const [pattern, target] of Object.entries(map)) {
		const star = pattern.indexOf('*')
		if (star < 0) continue
		const [before, after] = [pattern.slice(0, star), pattern.slice(star + 1)]
		if (subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= before.length + after.length) {
			return pick(target)?.replaceAll('*', subpath.slice(before.length, subpath.length - after.length))
		}
	}
	return undefined
}

/**
 * Resolves imports the way the app's bundler does, for the files of the project: relative paths, tsconfig `paths`
 * (`@/components/…`), and workspace packages linked into node_modules (their `exports` included). Packages from the
 * registry aren't followed: their text isn't the app's.
 */
export const createResolver = (cwd: string) => {
	const tsconfig = readJsonc(join(cwd, 'tsconfig.json'))?.compilerOptions ?? {}
	const base = resolve(cwd, tsconfig.baseUrl ?? '.')
	const paths = Object.entries((tsconfig.paths ?? {}) as Record<string, string[]>)
	const root = realpathSync(cwd)
	const inside = (path: string) => {
		const real = realpathSync(path)
		return (real === root || real.startsWith(root + sep)) && !real.split(sep).includes('node_modules') ? real : undefined
	}
	const cache = new Map<string, string | undefined>()

	const bare = (specifier: string): string | undefined => {
		for (const [pattern, targets] of paths) {
			const star = pattern.indexOf('*')
			const match = star < 0 ? (specifier === pattern ? '' : undefined) : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1)) ? specifier.slice(star, specifier.length - (pattern.length - star - 1)) : undefined
			if (match === undefined) continue
			for (const target of targets) {
				const found = fileFor(resolve(base, target.replace('*', match)))
				if (found) return found
			}
		}
		// A workspace package: linked into node_modules from inside the project.
		const parts = specifier.split('/')
		const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
		const directory = join(cwd, 'node_modules', name)
		if (!existsSync(directory)) return undefined
		const real = inside(directory)
		if (!real) return undefined
		const manifest = readJsonc(join(real, 'package.json')) ?? {}
		const subpath = `.${specifier.slice(name.length)}`
		const target = manifest.exports !== undefined ? exported(manifest.exports, subpath) : subpath === '.' ? (manifest.source ?? manifest.module ?? manifest.main ?? 'index') : subpath
		return target ? fileFor(resolve(real, target)) : undefined
	}

	return (from: string, specifier: string): string | undefined => {
		const id = specifier.startsWith('.') ? `${dirname(from)}\0${specifier}` : specifier
		if (cache.has(id)) return cache.get(id)
		const found = specifier.startsWith('.') ? fileFor(resolve(dirname(from), specifier)) : specifier.startsWith('node:') ? undefined : bare(specifier)
		const result = found && inside(found)
		cache.set(id, result)
		return result
	}
}

/** The route pattern of a page or layout under an app directory, as Next.js writes it: `/[lang]/integrations/[app]`. */
export const routeOf = (appDir: string, file: string): string => {
	const segments = relative(appDir, dirname(file))
		.split(sep)
		// Route groups `(marketing)` and parallel slots `@modal` aren't part of the address.
		.filter(segment => segment && !segment.startsWith('(') && !segment.startsWith('@'))
	return `/${segments.join('/')}`
}

const routeFiles = (directory: string, found: string[] = []) => {
	if (!existsSync(directory)) return found
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) {
			if (!entry.name.startsWith('.') && entry.name !== 'node_modules') routeFiles(path, found)
		} else if (ROUTE_FILE.test(entry.name)) found.push(path)
	}
	return found
}

export interface RouteManifest {
	/** Each layout's client messages, by its route pattern. */
	layouts: Record<string, string[]>
	/** Each page's client messages, by its route pattern. */
	pages: Record<string, string[]>
}

/**
 * The messages each page and layout needs in the browser: those of its client components (`'use client'`) and of
 * everything they import. Server components render their text on the server and send none of it. Pass a route's list
 * as `getMessages(lang, namespaces, { only })`, and the browser gets exactly what the route shows.
 */
export const buildRouteManifest = (cwd: string, appDirs: readonly string[], scan: (file: string) => FileScan): RouteManifest => {
	const resolveImport = createResolver(cwd)
	const scans = new Map<string, FileScan | undefined>()
	const scanOf = (file: string) => {
		if (!scans.has(file)) {
			let result: FileScan | undefined
			try {
				result = scan(file)
			} catch {
				result = undefined
			}
			scans.set(file, result)
		}
		return scans.get(file)
	}
	const importsOf = (file: string) => (scanOf(file)?.imports ?? []).flatMap(specifier => resolveImport(file, specifier) ?? [])

	// Everything a client module brings to the browser: its messages, and every module under it.
	const bundles = new Map<string, Set<string>>()
	const clientMessages = (start: string): Set<string> => {
		const known = bundles.get(start)
		if (known) return known
		const messages = new Set<string>()
		const seen = new Set([start])
		const stack = [start]
		while (stack.length) {
			const file = stack.pop()!
			for (const [key] of scanOf(file)?.messages ?? []) messages.add(key)
			for (const next of importsOf(file)) {
				if (seen.has(next)) continue
				seen.add(next)
				stack.push(next)
			}
		}
		bundles.set(start, messages)
		return messages
	}

	const manifest: RouteManifest = { layouts: {}, pages: {} }
	for (const appDir of appDirs.map(directory => resolve(cwd, directory))) {
		for (const file of routeFiles(appDir).sort()) {
			const keys = new Set<string>()
			// Server modules render on the server: walk through them to the client modules they use.
			const seen = new Set<string>()
			const stack = [realpathSync(file)]
			while (stack.length) {
				const current = stack.pop()!
				if (seen.has(current)) continue
				seen.add(current)
				if (scanOf(current)?.client) {
					for (const key of clientMessages(current)) keys.add(key)
					continue
				}
				stack.push(...importsOf(current))
			}
			const kind = ROUTE_FILE.exec(file.split(sep).pop()!)![1] === 'page' ? 'pages' : 'layouts'
			manifest[kind][routeOf(appDir, file)] = [...keys].sort()
		}
	}
	return manifest
}
