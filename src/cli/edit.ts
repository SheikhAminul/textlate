/// <reference types="node" />
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The settings `textlate setup` writes to the config file. Secrets are never among them. */
export type AISettings = Readonly<Record<string, string>>

export interface ConfigEdit {
	/** The config file the settings are in now, relative to the project. */
	file: string
	/** Set when the settings could not be written: the `ai` block to add to the config by hand. */
	snippet?: string
}

export interface EnvEdit {
	/** The file the key is in now, relative to the project. */
	file: string
	/** Whether `.gitignore` keeps that file out of the repository. */
	ignored: boolean
}

/** The file's indentation: whatever its first indented line uses. */
const indentOf = (text: string) => /^([ \t]+)\S/m.exec(text)?.[1] ?? '\t'

/** A string as a JS single-quoted literal. */
const js = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** The index of the quote that ends the string starting at `open`, or -1. */
const endOfString = (text: string, open: number) => {
	const quote = text[open]
	for (let index = open + 1; index < text.length; index++) {
		if (text[index] === '\\') index++
		else if (text[index] === quote) return index
	}
	return -1
}

/** The index of the brace that closes the one at `open`, skipping strings, templates and comments. Or -1. */
const closeOf = (text: string, open: number) => {
	let depth = 0
	for (let index = open; index < text.length; index++) {
		const character = text[index]!
		const pair = text.slice(index, index + 2)
		if (pair === '//' || pair === '/*') {
			const end = pair === '//' ? text.indexOf('\n', index) : text.indexOf('*/', index)
			if (end < 0) return -1
			index = pair === '//' ? end : end + 1
		} else if (character === "'" || character === '"' || character === '`') {
			const end = endOfString(text, index)
			if (end < 0) return -1
			index = end
		} else if ('{[('.includes(character)) depth++
		else if ('}])'.includes(character)) {
			if (--depth === 0) return index
		}
	}
	return -1
}

interface Property {
	/** The index of the property's name. */
	start: number
	/** The index just past its value. */
	end: number
	/** The index of the `{` its value opens with, when the value is an object literal. */
	open?: number
}

/** A property named `key` directly inside the object literal that starts at `open`. */
const property = (text: string, open: number, key: string): Property | undefined => {
	const close = closeOf(text, open)
	if (close < 0) return undefined
	const name = new RegExp(`(?:^|[{,\\s])(${key}|'${key}'|"${key}")\\s*:\\s*`, 'y')
	for (let index = open; index < close; index++) {
		const character = text[index]!
		const pair = text.slice(index, index + 2)
		if (pair === '//' || pair === '/*') {
			const end = pair === '//' ? text.indexOf('\n', index) : text.indexOf('*/', index)
			if (end < 0 || end > close) return undefined
			index = pair === '//' ? end : end + 1
			continue
		}
		if (character === "'" || character === '"' || character === '`') {
			const end = endOfString(text, index)
			if (end < 0 || end > close) return undefined
			index = end
			continue
		}
		if ('{[('.includes(character) && index !== open) {
			const end = closeOf(text, index)
			if (end < 0 || end > close) return undefined
			index = end
			continue
		}
		name.lastIndex = index
		const match = name.exec(text)
		if (!match) continue
		const value = index + match[0].length
		const valueOpen = text[value] === '{' ? value : undefined
		// The value runs to the next comma or to the end of the object, past any nested literal or string.
		let end = value
		for (; end < close; end++) {
			const inner = text[end]!
			if (inner === ',') break
			if (inner === "'" || inner === '"' || inner === '`') {
				const stop = endOfString(text, end)
				if (stop < 0) return undefined
				end = stop
			} else if ('{[('.includes(inner)) {
				const stop = closeOf(text, end)
				if (stop < 0) return undefined
				end = stop
			}
		}
		return { start: index + match[0].indexOf(match[1]!), end, ...(valueOpen !== undefined && { open: valueOpen }) }
	}
	return undefined
}

/** The index of the `{` of the config object a `textlate.config.{js,mjs,ts,mts}` file exports. */
const configObject = (text: string) => {
	const match = /defineConfig\s*(?:<[^>]*>)?\s*\(\s*|(?:export\s+default|module\.exports\s*=|export\s*=)\s*/.exec(text)
	if (!match) return -1
	const open = text.indexOf('{', match.index + match[0].length)
	return open < 0 || closeOf(text, open) < 0 ? -1 : open
}

/** The settings as `key: value` lines, indented by `indent`. */
const lines = (settings: AISettings, indent: string) =>
	Object.entries(settings)
		.map(([key, value]) => `${indent}${key}: ${js(value)}`)
		.join(',\n')

const createConfig = (cwd: string, settings: AISettings): ConfigEdit => {
	let type: string | undefined
	try {
		type = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { type?: string }).type
	} catch {}
	// `.mjs` is an ES module whatever package.json says; `.js` only in a module package.
	const file = type === 'module' ? 'textlate.config.js' : 'textlate.config.mjs'
	writeFileSync(
		join(cwd, file),
		`import { defineConfig } from 'textlate/config'\n\nexport default defineConfig({\n\tai: {\n${lines(settings, '\t\t')}\n\t}\n})\n`
	)
	return { file }
}

/**
 * Write `settings` into the `ai` block of `file` (a `textlate.config.*`), or create a config file when there is
 * none. Existing settings are replaced and the rest of the file is left as it is. When the file's `ai` block can't
 * be found, nothing is written and the result carries a `snippet` to add by hand.
 */
export const saveAISettings = (cwd: string, file: string | undefined, settings: AISettings): ConfigEdit => {
	if (!Object.keys(settings).length) throw new Error('No settings to save.')
	if (!file) return createConfig(cwd, settings)

	const name = relative(cwd, file)
	const snippet = () => ({ file: name, snippet: `ai: {\n${lines(settings, '\t')}\n}` })
	const raw = readFileSync(file, 'utf8')

	if (file.endsWith('.json')) {
		let parsed: { ai?: Record<string, unknown> }
		try {
			parsed = JSON.parse(raw) as { ai?: Record<string, unknown> }
		} catch {
			return snippet()
		}
		writeFileSync(file, `${JSON.stringify({ ...parsed, ai: { ...parsed.ai, ...settings } }, null, indentOf(raw))}\n`)
		return { file: name }
	}

	const object = configObject(raw)
	if (object < 0) return snippet()
	const indent = indentOf(raw)
	const ai = property(raw, object, 'ai')
	if (ai && ai.open === undefined) return snippet()

	let text = raw
	if (!ai) {
		text = `${text.slice(0, object + 1)}\n${indent}ai: {\n${lines(settings, indent.repeat(2))}\n${indent}},${text.slice(object + 1)}`
	} else {
		// Replace each setting already in the block, and insert the rest after its `{`. The block is found again
		// every time, because each edit moves what follows it.
		for (const [key, value] of Object.entries(settings).reverse()) {
			const block = property(text, object, 'ai')!.open!
			const existing = property(text, block, key)
			text = existing
				? `${text.slice(0, existing.start)}${key}: ${js(value)}${text.slice(existing.end)}`
				: `${text.slice(0, block + 1)}\n${indent.repeat(2)}${key}: ${js(value)},${text.slice(block + 1)}`
		}
	}
	writeFileSync(file, text)
	return { file: name }
}

/** Whether `.gitignore` keeps `file` out of the repository. */
const isIgnored = (cwd: string, file: string) => {
	const path = join(cwd, '.gitignore')
	if (!existsSync(path)) return false
	const patterns = readFileSync(path, 'utf8')
		.split('\n')
		.map(line => line.trim().replace(/^\/+|\/+$/g, ''))
	return patterns.some(pattern => pattern === file || pattern === '.env*' || pattern === '.env.*' || (pattern === '*.local' && file.endsWith('.local')))
}

/** Where a key is saved: the project's `.env.local`, or `.env` when there is no `.env.local`. */
export const envFile = (cwd: string): string => (existsSync(join(cwd, '.env.local')) ? '.env.local' : '.env')

/**
 * Set `name` to `value` in the project's env file. An existing line for `name` is replaced; everything else is kept.
 */
export const saveEnvKey = (cwd: string, name: string, value: string): EnvEdit => {
	const file = envFile(cwd)
	const path = join(cwd, file)
	const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
	// Quote only when the value needs it, so keys stay easy to read.
	const line = `${name}=${/^[\w./:+=~-]*$/.test(value) ? value : JSON.stringify(value)}`
	const existing = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'm')
	const text = existing.test(raw) ? raw.replace(existing, line) : `${raw}${raw && !raw.endsWith('\n') ? '\n' : ''}${line}\n`
	writeFileSync(path, text)
	return { file, ignored: isIgnored(cwd, file) }
}
