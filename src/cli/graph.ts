/// <reference types="node" />
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Following imports from a namespace's own files to everything they use, so a namespace's translation file holds the
 * text of the shared components it renders as well as its own. Only what can be read without running the code:
 * relative imports, the `paths` aliases of `tsconfig.json` (or `jsconfig.json`), and literal `import()`. Packages
 * (bare specifiers) are left out. A file that starts with `'use client'` — and everything it imports — is a client
 * module, whose text ends up in the browser; `'use server'` files never are.
 */

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
// `import x from '…'`, `import { a, type B } from '…'`, `export * from '…'`, `import '…'` and `import('…')`. Type-only
// imports bring no text, so they are skipped.
const IMPORT = /(?:^|[\s;}])(?:import|export)\s+(type\s+)?(?:[\w$*{}\s,]+?\s+from\s*)?(['"])([^'"\n]+)\2|\bimport\s*\(\s*(['"])([^'"\n]+)\4\s*\)/gm
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /(^|[^:\\'"`])\/\/.*$/gm
const DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use (client|server)\1/

export interface Alias {
	/** The part of a specifier before `*`, e.g. `@/`. */
	prefix: string
	/** The part after `*`, usually empty. */
	suffix: string
	/** What `*` is replaced in, absolute, e.g. `/app/src/*`. */
	targets: string[]
	/** Whether the pattern has a `*`. */
	wildcard: boolean
}

/** JSON with comments and trailing commas, as `tsconfig.json` allows. */
export const parseJsonc = (text: string): unknown => {
	let out = ''
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!
		if (char === '"') {
			const end = /"(?:[^"\\]|\\.)*"/y
			end.lastIndex = index
			const string = end.exec(text)?.[0] ?? text.slice(index)
			out += string
			index += string.length - 1
		} else if (char === '/' && text[index + 1] === '/') {
			while (index < text.length && text[index] !== '\n') index++
			out += '\n'
		} else if (char === '/' && text[index + 1] === '*') {
			const close = text.indexOf('*/', index + 2)
			index = close === -1 ? text.length : close + 1
		} else out += char
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** The `paths` aliases of the project's `tsconfig.json` or `jsconfig.json` (following `extends` to a relative file). */
export const readAliases = (cwd: string): Alias[] => {
	for (const name of ['tsconfig.json', 'jsconfig.json']) {
		let file: string | undefined = join(cwd, name)
		const seen = new Set<string>()
		while (file && existsSync(file) && !seen.has(file)) {
			seen.add(file)
			let config: { extends?: unknown; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
			try {
				config = parseJsonc(readFileSync(file, 'utf8')) as typeof config
			} catch {
				break
			}
			const paths = config.compilerOptions?.paths
			if (paths) {
				const base = resolve(dirname(file), config.compilerOptions?.baseUrl ?? '.')
				return Object.entries(paths).map(([pattern, targets]) => {
					const [prefix, suffix = ''] = pattern.split('*')
					return { prefix: prefix!, suffix, wildcard: pattern.includes('*'), targets: targets.map(target => resolve(base, target)) }
				})
			}
			file = typeof config.extends === 'string' && config.extends.startsWith('.') ? resolve(dirname(file), config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`) : undefined
		}
	}
	return []
}

const isFile = (path: string) => {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

/** The source file a path names: as is, with an extension, `.js` written for `.ts`, or a directory's `index`. */
const resolveFile = (path: string): string | undefined => {
	if (SOURCE.test(path) && isFile(path)) return path
	const stripped = path.replace(/\.[cm]?jsx?$/, '')
	for (const candidate of [stripped, path]) {
		for (const extension of EXTENSIONS) if (isFile(candidate + extension)) return candidate + extension
	}
	for (const extension of EXTENSIONS) if (isFile(join(path, `index${extension}`))) return join(path, `index${extension}`)
	return undefined
}

/** The file an import names, or nothing for a package, a missing file or something that isn't code (CSS, JSON). */
export const resolveImport = (specifier: string, from: string, aliases: readonly Alias[]): string | undefined => {
	if (specifier.startsWith('.')) return resolveFile(resolve(dirname(from), specifier))
	if (specifier.startsWith('/')) return resolveFile(specifier)
	for (const alias of aliases) {
		if (alias.wildcard ? !(specifier.startsWith(alias.prefix) && specifier.endsWith(alias.suffix)) : specifier !== alias.prefix) continue
		const star = alias.wildcard ? specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length) : ''
		for (const target of alias.targets) {
			const found = resolveFile(target.replace('*', star))
			if (found) return found
		}
	}
	return undefined
}

/** The specifiers `code` imports at runtime, in order. */
export const importsOf = (code: string): string[] => {
	const clean = code.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, '$1')
	const found: string[] = []
	for (const [, typeOnly, , specifier, , dynamic] of clean.matchAll(IMPORT)) {
		if (dynamic) found.push(dynamic)
		else if (specifier && !typeOnly) found.push(specifier)
	}
	return found
}

/** `'client'` or `'server'` when the file opens with that directive. */
export const directiveOf = (code: string) => DIRECTIVE.exec(code)?.[2] as 'client' | 'server' | undefined

export interface Graph {
	/** Every file the entry files use, themselves included, sorted. */
	files: string[]
	/** The ones that run in the browser: client modules and what they import. */
	clientFiles: Set<string>
}

/**
 * Everything `entries` use, and which of it is client code. Files are read once per `cache`, so namespaces that share
 * components share the work.
 */
export const walk = (entries: readonly string[], aliases: readonly Alias[], cache = new Map<string, { code: string; imports: string[] }>()): Graph => {
	const read = (file: string) => {
		let entry = cache.get(file)
		if (!entry) {
			const code = readFileSync(file, 'utf8')
			entry = { code, imports: importsOf(code).flatMap(specifier => resolveImport(specifier, file, aliases) ?? []) }
			cache.set(file, entry)
		}
		return entry
	}
	const all = new Set<string>()
	const clientFiles = new Set<string>()
	const queue: [string, boolean][] = entries.map(file => [file, false])
	while (queue.length) {
		const [file, parentIsClient] = queue.pop()!
		const { code, imports } = read(file)
		const directive = directiveOf(code)
		// A server action called from the browser still runs on the server: its text is the server's to translate.
		const client = directive === 'server' ? false : parentIsClient || directive === 'client'
		if (client ? clientFiles.has(file) : all.has(file)) continue
		all.add(file)
		if (client) clientFiles.add(file)
		for (const imported of imports) {
			if (!imported.split(sep).includes('node_modules')) queue.push([imported, client])
		}
	}
	return { files: [...all].sort(), clientFiles }
}

/** Whether `path` is `directory` or inside it. */
export const isInside = (path: string, directory: string) => {
	const from = relative(directory, path)
	return from === '' || (!from.startsWith('..') && !from.startsWith(sep) && !/^[a-z]:/i.test(from))
}
