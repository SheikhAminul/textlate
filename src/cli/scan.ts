/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { keyOf, PLURAL_CATEGORIES } from '../message.js'
import type { Message } from '../types.js'
import { scanWithTypeScript, type FileScan, type TypeScript } from './ast.js'

export interface ScanWarning {
	file: string
	line: number
	message: string
}

export interface ScanResult {
	/** Messages by their key in a translation file (see `keyOf`), in order of first use. */
	messages: Map<string, Message>
	/** Messages that can't be read from the code. */
	warnings: ScanWarning[]
	files: number
}

export const DEFAULT_FUNCTIONS = ['translate', 'msg']

export interface ScanOptions {
	/** Functions whose first argument is a message. Default `translate` and `msg`. */
	functions?: readonly string[] | undefined
	/**
	 * Object properties whose string values are messages: `label: 'Send a message'` with `['label']`. For text kept in
	 * data — a catalog of apps, a menu, form fields — and translated where it's shown: `translate(app.label)`.
	 */
	properties?: readonly string[] | undefined
	/** Files and directories to leave out, relative to `cwd`. */
	exclude?: readonly string[] | undefined
	/** The project's TypeScript compiler (see `loadTypeScript`): files are parsed exactly, rather than matched. */
	typescript?: TypeScript | undefined
	/** Scans of files that haven't changed since, kept between runs. */
	cache?: ScanCache | undefined
}

/** Scans kept by file, valid while the file's modification time and size are the same. */
export interface ScanCache {
	get(key: string, stamp: string): FileScan | undefined
	set(key: string, stamp: string, scan: FileScan): void
}

// Imports as a regular expression finds them, when TypeScript isn't there to parse the file.
const IMPORT = /(?:^|[^\w$.])(?:import\s+(?!type\s)(?:[^'"`;]*?\sfrom\s*)?|export\s+(?!type\s)[^'"`;]*?\sfrom\s*)['"]([^'"\n]+)['"]|(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
const CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use client\1/

/** One file's messages, warnings, imports and `'use client'`: parsed with TypeScript when there is one, matched otherwise. */
export const scanFile = (path: string, cwd: string, options: ScanOptions = {}): FileScan => {
	const file = relative(cwd, path)
	const functions = options.functions ?? DEFAULT_FUNCTIONS
	const properties = options.properties ?? []
	const parsed = Boolean(options.typescript) && /\.[cm]?[jt]sx?$/.test(path)
	const key = `${parsed ? 'ast' : 'regex'}\0${functions.join()}\0${properties.join()}\0${file}`
	let stamp = ''
	if (options.cache) {
		const stat = statSync(path)
		stamp = `${stat.mtimeMs}:${stat.size}`
		const cached = options.cache.get(key, stamp)
		if (cached) return cached
	}
	const source = readFileSync(path, 'utf8')
	let scan: FileScan
	if (parsed) scan = scanWithTypeScript(options.typescript!, source, file, functions, properties)
	else {
		const result = scanCode(source, functions, file, properties)
		const code = source.replace(COMMENTS, comment => comment.replace(/[^\n]/g, ' '))
		scan = { messages: [...result.messages], warnings: result.warnings, imports: [...code.matchAll(IMPORT)].map(match => (match[1] ?? match[2])!), client: CLIENT.test(source) }
	}
	options.cache?.set(key, stamp, scan)
	return scan
}


// A string literal: quoted, or a template without `${}`.
const LITERAL = /'(?:[^'\\\r\n]|\\[\s\S])*'|"(?:[^"\\\r\n]|\\[\s\S])*"|`(?:[^`\\$]|\\[\s\S]|\$(?!\{))*`/.source
const NAME = `(?:${PLURAL_CATEGORIES.join('|')}|text|context)`
const PROPERTY = `(?:${NAME}|'${NAME}'|"${NAME}")\\s*:\\s*(?:${LITERAL})`
// A message object literal: `{ one: '…', other: '…' }` or `{ text: '…', context: '…' }`, with string literal values.
const OBJECT = `\\{\\s*${PROPERTY}(?:\\s*,\\s*${PROPERTY})*\\s*,?\\s*\\}`
const MESSAGE_ARGUMENT = new RegExp(`(${LITERAL}|${OBJECT})\\s*[,)]`, 'y')
const OBJECT_PROPERTY = new RegExp(`(?:(${NAME})|'(${NAME})'|"(${NAME})")\\s*:\\s*(${LITERAL})`, 'g')
// Commented-out code: whole-line `//` comments, and `/* */` blocks that open a line or a JSX expression.
const COMMENTS = /^[ \t]*\/\/.*$|(?:^[ \t]*|\{\s*)\/\*[\s\S]*?\*\//gm
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage'])

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The value of a JS string literal, quotes included. */
const unquote = (literal: string) => {
	const body = literal.slice(1, -1)
	// Templates read line breaks as \n.
	return (literal[0] === '`' ? body.replace(/\r\n?/g, '\n') : body).replace(
		/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(\r\n|[\s\S]))/gi,
		(_, point?: string, unit?: string, byte?: string, char?: string) =>
			char === undefined
				? String.fromCodePoint(parseInt((point ?? unit ?? byte)!, 16))
				: /^(?:\r\n|[\r\n\u2028\u2029])$/.test(char)
					? '' // a line continuation
					: (ESCAPES[char] ?? char)
	)
}

/** A string literal's text, or a message object literal; a reason when the object isn't a valid message. */
const readMessage = (code: string): Message | string[] => {
	if (code[0] !== '{') return unquote(code)
	const fields: Record<string, string> = {}
	for (const [, bare, single, double, literal] of code.matchAll(OBJECT_PROPERTY)) fields[(bare ?? single ?? double)!] = unquote(literal!)
	const { text, context, ...forms } = fields
	const hasForms = Object.keys(forms).length > 0
	if (text !== undefined && hasForms) return ['a message has either `text` or plural forms, not both']
	if (text !== undefined) return context ? { text, context } : text
	if (forms.other === undefined) return [hasForms ? 'plural forms need an `other` form' : 'a message object needs `text` or plural forms']
	return (context ? { ...forms, context } : forms) as Message
}

/**
 * The messages in `code`, in order of first use: the first argument of the translator functions. Text built at
 * runtime (`translate('Hi ' + name)`) can't be read and is reported instead; a variable is fine, as its text comes from
 * `msg()` elsewhere.
 *
 * @example
 * ```ts
 * scanCode(`<p>{translate('Hello, {name}!', { name })}</p>`).messages // Map { 'Hello, {name}!' => 'Hello, {name}!' }
 * ```
 */
export const scanCode = (source: string, functions: readonly string[] = DEFAULT_FUNCTIONS, file = '', properties: readonly string[] = []) => {
	// Comments become spaces, so positions and line numbers don't move.
	const code = source.replace(COMMENTS, comment => comment.replace(/[^\n]/g, ' '))
	const messages = new Map<string, Message>()
	const warnings: ScanWarning[] = []
	const warn = (index: number, message: string) => warnings.push({ file, line: code.slice(0, index).split('\n').length, message })

	// Text in data comes first where it's declared, as a property's value written out in full. A value built from parts
	// (`label: 'Hi ' + name`), a variable or a call is skipped: it isn't text that can be translated as it is.
	if (properties.length) {
		const names = properties.map(escapeRegExp).join('|')
		const pattern = new RegExp(`(?<![\\w$.])(?:${names}|'(?:${names})'|"(?:${names})")\\s*:\\s*(${LITERAL})(?=\\s*(?:[,}\\])]|\\r?\\n|$))`, 'g')
		for (const [, literal] of code.matchAll(pattern)) {
			const text = unquote(literal!)
			if (text.trim() && !messages.has(text)) messages.set(text, text)
		}
	}

	const names = functions.map(escapeRegExp).join('|')
	for (const call of code.matchAll(new RegExp(`(?<![\\w$])(?<!\\bfunction\\s+)(?:${names})\\s*\\(\\s*`, 'g'))) {
		const start = call.index + call[0].length
		const what = `${call[0].replace(/\s+/g, '')}…)`
		MESSAGE_ARGUMENT.lastIndex = start
		const argument = MESSAGE_ARGUMENT.exec(code)
		if (!argument) {
			if (/^['"`{]/.test(code[start] ?? '')) {
				warn(call.index, `${what}: the text is built at runtime, so it can't be extracted. Write it as one string with {params} for the values.`)
			}
			continue
		}
		const message = readMessage(argument[1]!)
		if (Array.isArray(message)) {
			warn(call.index, `${what}: ${message[0]}.`)
			continue
		}
		const key = keyOf(message)
		// A plural wins over the same text used as a plain string.
		if (key && (typeof message !== 'string' || !messages.has(key))) messages.set(key, message)
	}
	return { messages, warnings }
}

const sourceFiles = (path: string, skip: (path: string) => boolean, found: string[]) => {
	if (skip(path)) return found
	if (!statSync(path).isDirectory()) {
		found.push(path)
		return found
	}
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name)
		if (entry.isDirectory()) {
			if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) sourceFiles(child, skip, found)
		} else if (SOURCE_FILE.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) && !skip(child)) found.push(child)
	}
	return found
}

/**
 * Scan files and directories (relative to `cwd`) for messages. `node_modules`, build output and dot-directories are
 * skipped, and so is anything under `options.exclude`.
 */
export const scanFiles = (paths: readonly string[], cwd: string, options: ScanOptions = {}): ScanResult => {
	const excluded = (options.exclude ?? []).map(path => resolve(cwd, path))
	const skip = (path: string) => excluded.some(prefix => path === prefix || path.startsWith(`${prefix}${sep}`))
	const files = [...new Set(paths.flatMap(path => sourceFiles(resolve(cwd, path), skip, [])))].sort()
	const messages = new Map<string, Message>()
	const warnings: ScanWarning[] = []
	for (const file of files) {
		const result = scanFile(file, cwd, options)
		for (const [key, message] of result.messages) {
			if (typeof message !== 'string' || !messages.has(key)) messages.set(key, message)
		}
		warnings.push(...result.warnings)
	}
	return { messages, warnings, files: files.length }
}
