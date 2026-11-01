/// <reference types="node" />
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { keyOf, PLURAL_CATEGORIES } from '../message.js'
import type { Message } from '../types.js'
import type { ScanWarning } from './scan.js'

// The few parts of the TypeScript compiler API the scanner uses, so textlate needn't depend on TypeScript: it uses the
// project's own, when the project has it.
interface TsNode {
	kind: number
	parent?: TsNode
	getStart(source?: TsSourceFile): number
	forEachChild<T>(visit: (node: TsNode) => T | undefined): T | undefined
}
interface TsSourceFile extends TsNode {
	statements: readonly TsNode[]
	getLineAndCharacterOfPosition(position: number): { line: number }
}
export interface TypeScript {
	createSourceFile(file: string, text: string, target: number, setParents: boolean, kind: number): TsSourceFile
	ScriptTarget: { Latest: number }
	ScriptKind: { TS: number; TSX: number; JS: number; JSX: number }
	SyntaxKind: Record<string, number>
}

/** What the scanner found in one file. */
export interface FileScan {
	/** Messages by key, in order of first use. */
	messages: [key: string, message: Message][]
	warnings: ScanWarning[]
	/** The modules it imports or re-exports (static, dynamic and `require`), as written. Type-only imports aren't. */
	imports: string[]
	/** It starts with `'use client'`. */
	client: boolean
}

/** The project's TypeScript compiler, if it has one installed. */
export const loadTypeScript = async (cwd: string): Promise<TypeScript | undefined> => {
	try {
		const path = createRequire(join(cwd, 'package.json')).resolve('typescript')
		const module = (await import(pathToFileURL(path).href)) as { default?: Partial<TypeScript> } & Partial<TypeScript>
		// TypeScript 7, the native compiler, has no JavaScript API yet: then the regular expressions it is.
		const api = typeof module.default?.createSourceFile === 'function' ? module.default : module
		return typeof api.createSourceFile === 'function' ? (api as TypeScript) : undefined
	} catch {
		return undefined
	}
}

const MESSAGE_FIELDS = new Set<string>([...PLURAL_CATEGORIES, 'text', 'context'])

/**
 * Scan a file with TypeScript's own parser: calls of the translator functions (and their aliases — `const t =
 * translate`, `const { translate: t } = useI18n()`), message objects, the string values of `properties`, and the file's
 * imports. Exact where a regular expression has to guess: comments, strings, JSX and nesting are what the parser says.
 */
export const scanWithTypeScript = (
	ts: TypeScript,
	source: string,
	file: string,
	functions: readonly string[],
	properties: readonly string[] = []
): FileScan => {
	const kind = ts.SyntaxKind
	const scriptKind = /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : /\.[cm]?jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
	const names = new Set(functions)
	const wanted = new Set(properties)
	const messages = new Map<string, Message>()
	const warnings: ScanWarning[] = []
	const imports: string[] = []
	const line = (node: TsNode) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
	const warn = (node: TsNode, message: string) => warnings.push({ file, line: line(node), message })
	const add = (message: Message) => {
		const key = keyOf(message)
		// A plural wins over the same text used as a plain string.
		if (key && (typeof message !== 'string' || !messages.has(key))) messages.set(key, message)
	}

	type Any = TsNode & Record<string, any>
	const textOf = (node: Any | undefined): string | undefined =>
		node && (node.kind === kind['StringLiteral'] || node.kind === kind['NoSubstitutionTemplateLiteral']) ? (node['text'] as string) : undefined
	const nameOf = (node: Any | undefined): string | undefined =>
		node && (node.kind === kind['Identifier'] || node.kind === kind['StringLiteral'] || node.kind === kind['PrivateIdentifier']) ? (node['text'] as string) : undefined

	// Aliases of the translator functions, found before the calls: `const t = translate`, `const { translate: t } = …`.
	const findAliases = (node: Any) => {
		if (node.kind === kind['VariableDeclaration']) {
			const init = node['initializer'] as Any | undefined
			const target = init && (init.kind === kind['PropertyAccessExpression'] ? nameOf(init['name']) : nameOf(init))
			if (target && names.has(target) && node['name'].kind === kind['Identifier']) names.add(node['name'].text)
		}
		if (node.kind === kind['BindingElement']) {
			const property = nameOf(node['propertyName']) ?? nameOf(node['name'])
			if (property && names.has(property) && node['name'].kind === kind['Identifier']) names.add(node['name'].text)
		}
		node.forEachChild(child => void findAliases(child as Any))
	}
	findAliases(sourceFile as Any)

	/** A message object literal, or why it isn't one. */
	const readObject = (node: Any): Message | string => {
		const fields: Record<string, string> = {}
		for (const property of node['properties'] as Any[]) {
			const name = property.kind === kind['PropertyAssignment'] ? nameOf(property['name']) : undefined
			const value = textOf(property['initializer'])
			if (!name || !MESSAGE_FIELDS.has(name) || value === undefined) return 'the text is built at runtime, so it can\'t be extracted. Write it as one string with {params} for the values'
			fields[name] = value
		}
		const { text, context, ...forms } = fields
		const hasForms = Object.keys(forms).length > 0
		if (text !== undefined && hasForms) return 'a message has either `text` or plural forms, not both'
		if (text !== undefined) return context ? { text, context } : text
		if (forms['other'] === undefined) return hasForms ? 'plural forms need an `other` form' : 'a message object needs `text` or plural forms'
		return (context ? { ...forms, context } : forms) as Message
	}

	const visit = (node: Any): void => {
		if (node.kind === kind['ImportDeclaration'] || node.kind === kind['ExportDeclaration']) {
			const typeOnly = node['importClause']?.isTypeOnly || node['isTypeOnly']
			const specifier = textOf(node['moduleSpecifier'])
			if (specifier && !typeOnly) imports.push(specifier)
		} else if (node.kind === kind['CallExpression']) {
			const callee = node['expression'] as Any
			// `import('…')` and `require('…')`: a lazily loaded component is still part of the page.
			if (callee.kind === kind['ImportKeyword'] || (callee.kind === kind['Identifier'] && callee['text'] === 'require')) {
				const specifier = textOf(node['arguments'][0])
				if (specifier) imports.push(specifier)
			} else {
				const name = callee.kind === kind['Identifier'] ? callee['text'] : callee.kind === kind['PropertyAccessExpression'] ? nameOf(callee['name']) : undefined
				const argument = node['arguments'][0] as Any | undefined
				if (name && names.has(name) && argument) {
					const what = `${name}(…)`
					const text = textOf(argument)
					if (text !== undefined) add(text)
					else if (argument.kind === kind['ObjectLiteralExpression']) {
						const message = readObject(argument)
						if (typeof message === 'string') warn(node, `${what}: ${message}.`)
						else add(message)
					} else if (argument.kind === kind['TemplateExpression'] || argument.kind === kind['BinaryExpression']) {
						warn(node, `${what}: the text is built at runtime, so it can't be extracted. Write it as one string with {params} for the values.`)
					}
				}
			}
		} else if (wanted.size && node.kind === kind['PropertyAssignment']) {
			// Text in data: `label: 'Send a message'`, written out in full.
			const name = nameOf(node['name'])
			const text = textOf(node['initializer'])
			if (name && wanted.has(name) && text?.trim() && !messages.has(text)) messages.set(text, text)
		}
		node.forEachChild(child => void visit(child as Any))
	}
	visit(sourceFile as Any)

	// A directive prologue: string statements at the very top of the file.
	let client = false
	for (const statement of sourceFile.statements as Any[]) {
		if (statement.kind !== kind['ExpressionStatement'] || textOf(statement['expression']) === undefined) break
		if (textOf(statement['expression']) === 'use client') client = true
	}
	return { messages: [...messages], warnings, imports, client }
}
