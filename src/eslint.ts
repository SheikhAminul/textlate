/**
 * An ESLint plugin that keeps untranslated text out of JSX: text between tags, and attributes people read (`alt`,
 * `aria-label`, `placeholder`, `title`…), written as plain strings rather than through `translate`.
 *
 * @example
 * ```js
 * // eslint.config.js
 * import textlate from 'textlate/eslint'
 *
 * export default [
 *   textlate.configs.recommended,
 *   // or with options:
 *   { plugins: { textlate }, rules: { 'textlate/no-untranslated-text': ['error', { attributes: ['label'] }] } }
 * ]
 * ```
 */

/** Attributes whose text people read or hear, checked by default. */
export const READ_ATTRIBUTES = ['alt', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'placeholder', 'title']

export interface NoUntranslatedTextOptions {
	/** More attributes to check besides the default ones, e.g. `['label', 'tooltip']`. */
	attributes?: string[]
	/** Elements whose text is left alone, by name. Default `['code', 'kbd', 'pre', 'samp', 'script', 'style']`. */
	ignoreElements?: string[]
	/** Text that's fine as it is: exact strings, or regular expressions written `/pattern/flags`. */
	allow?: string[]
}

// The few shapes of ESLint's AST and API the rule needs, so the package needn't depend on ESLint.
interface Node {
	type: string
	parent?: Node
	value?: unknown
	name?: Node | string
	expression?: Node
	quasis?: { value: { cooked: string | null } }[]
	expressions?: unknown[]
	openingElement?: { name: Node }
	object?: Node
	property?: Node
	namespace?: Node
}

interface RuleContext {
	options: [NoUntranslatedTextOptions?]
	report(descriptor: { node: Node; messageId: string; data?: Record<string, string> }): void
}

const IGNORED_ELEMENTS = ['code', 'kbd', 'pre', 'samp', 'script', 'style']
/** Text has a letter in it: punctuation, digits, symbols and entities alone need no translation. */
const LETTER = /\p{L}/u

const nameOf = (node: Node | string | undefined): string => {
	if (!node) return ''
	if (typeof node === 'string') return node
	if (node.type === 'JSXIdentifier') return String(node.name)
	if (node.type === 'JSXNamespacedName') return `${nameOf(node.namespace)}:${nameOf(node.name)}`
	if (node.type === 'JSXMemberExpression') return `${nameOf(node.object)}.${nameOf(node.property)}`
	return ''
}

const toPattern = (allowed: string) => {
	const match = /^\/(.+)\/([a-z]*)$/s.exec(allowed)
	return match ? new RegExp(match[1]!, match[2]) : undefined
}

export const noUntranslatedText = {
	meta: {
		type: 'problem' as const,
		docs: { description: 'Keep untranslated text out of JSX: write it with translate() so it reaches every language.' },
		schema: [
			{
				type: 'object',
				properties: {
					attributes: { type: 'array', items: { type: 'string' } },
					ignoreElements: { type: 'array', items: { type: 'string' } },
					allow: { type: 'array', items: { type: 'string' } }
				},
				additionalProperties: false
			}
		],
		messages: {
			text: 'Untranslated text "{{text}}": write it with translate() so it reaches every language.',
			attribute: 'Untranslated {{attribute}} "{{text}}": write it with translate() so it reaches every language.'
		}
	},
	create(context: RuleContext) {
		const options = context.options[0] ?? {}
		const attributes = new Set([...READ_ATTRIBUTES, ...(options.attributes ?? [])])
		const ignoredElements = new Set(options.ignoreElements ?? IGNORED_ELEMENTS)
		const allowed = (options.allow ?? []).map(entry => ({ exact: entry, pattern: toPattern(entry) }))

		const needsTranslation = (text: string) => {
			const trimmed = text.replace(/\s+/g, ' ').trim()
			if (!LETTER.test(trimmed)) return undefined
			if (allowed.some(({ exact, pattern }) => (pattern ? pattern.test(trimmed) : exact === trimmed))) return undefined
			return trimmed.length > 40 ? `${trimmed.slice(0, 37)}...` : trimmed
		}
		const insideIgnored = (node: Node) => {
			for (let parent = node.parent; parent; parent = parent.parent) {
				if (parent.type === 'JSXElement' && ignoredElements.has(nameOf(parent.openingElement?.name))) return true
			}
			return false
		}
		/** The string a JSX child or attribute value holds, when it's written out: `"…"`, `{'…'}`, or a template with no `${}`. */
		const literalOf = (node: Node | undefined): string | undefined => {
			if (!node) return undefined
			if (node.type === 'Literal' && typeof node.value === 'string') return node.value
			if (node.type === 'TemplateLiteral' && !node.expressions?.length) return node.quasis?.[0]?.value.cooked ?? undefined
			if (node.type === 'JSXExpressionContainer') return literalOf(node.expression)
			return undefined
		}

		return {
			JSXText(node: Node) {
				const text = needsTranslation(String(node.value ?? ''))
				if (text && !insideIgnored(node)) context.report({ node, messageId: 'text', data: { text } })
			},
			JSXExpressionContainer(node: Node) {
				// `{'Text'}` as a child, not as an attribute's value (JSXAttribute checks those).
				if (node.parent?.type === 'JSXAttribute') return
				const value = literalOf(node.expression)
				const text = value === undefined ? undefined : needsTranslation(value)
				if (text && !insideIgnored(node)) context.report({ node, messageId: 'text', data: { text } })
			},
			JSXAttribute(node: Node) {
				const attribute = nameOf(node.name)
				if (!attributes.has(attribute)) return
				const value = literalOf(node.value as Node | undefined)
				const text = value === undefined ? undefined : needsTranslation(value)
				if (text && !insideIgnored(node)) context.report({ node, messageId: 'attribute', data: { attribute, text } })
			}
		}
	}
}

/**
 * The plugin. Its rules and configs are typed loosely on purpose: ESLint's own `Plugin` type accepts them as they are,
 * without this package depending on ESLint.
 */
export interface Plugin {
	meta: { name: string }
	rules: Record<string, any>
	configs: Record<string, any>
}

const plugin: Plugin = { meta: { name: 'textlate' }, rules: { 'no-untranslated-text': noUntranslatedText }, configs: {} }
plugin.configs['recommended'] = { name: 'textlate/recommended', plugins: { textlate: plugin }, rules: { 'textlate/no-untranslated-text': 'error' } }

export default plugin
