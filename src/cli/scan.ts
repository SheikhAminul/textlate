/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { keyOf, PLURAL_CATEGORIES } from '../message.js'
import type { Message } from '../types.js'

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
export const scanCode = (source: string, functions: readonly string[] = DEFAULT_FUNCTIONS, file = '') => {
	// Comments become spaces, so positions and line numbers don't move.
	const code = source.replace(COMMENTS, comment => comment.replace(/[^\n]/g, ' '))
	const messages = new Map<string, Message>()
	const warnings: ScanWarning[] = []
	const warn = (index: number, message: string) => warnings.push({ file, line: code.slice(0, index).split('\n').length, message })

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

const sourceFiles = (path: string, found: string[]) => {
	if (!statSync(path).isDirectory()) {
		found.push(path)
		return found
	}
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name)
		if (entry.isDirectory()) {
			if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) sourceFiles(child, found)
		} else if (SOURCE_FILE.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) found.push(child)
	}
	return found
}

/** Scan files and directories (relative to `cwd`) for messages. `node_modules`, build output and dot-directories are skipped. */
export const scanFiles = (paths: readonly string[], cwd: string, functions?: readonly string[]): ScanResult => {
	const files = paths.flatMap(path => sourceFiles(resolve(cwd, path), [])).sort()
	const messages = new Map<string, Message>()
	const warnings: ScanWarning[] = []
	for (const file of files) {
		const result = scanCode(readFileSync(file, 'utf8'), functions, relative(cwd, file))
		for (const [key, message] of result.messages) {
			if (typeof message !== 'string' || !messages.has(key)) messages.set(key, message)
		}
		warnings.push(...result.warnings)
	}
	return { messages, warnings, files: files.length }
}
