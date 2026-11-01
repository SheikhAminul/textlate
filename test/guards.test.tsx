import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'
import textlate, { type NoUntranslatedTextOptions } from '../src/eslint.js'
import { createI18n } from '../src/index.js'
import { pseudoLocale, pseudoLocalize } from '../src/pseudo.js'

describe('pseudo-locale', () => {
	it('accents letters, lengthens text and brackets it — keeping params and tags as they are', () => {
		expect(pseudoLocalize('Hello, {name}!')).toBe('[Ĥéļļó, {name}! ~~]')
		expect(pseudoLocalize('Read the <link>terms</link>')).toBe('[Ŕéáð ţĥé <link>ţéŕɱš</link> ~~~~~]')
		expect(pseudoLocalize('{count}')).toBe('[{count}]')
	})

	it('shows every untranslated message of its locale pseudo-localized, and leaves others alone', () => {
		const pseudo = pseudoLocale()
		const i18n = createI18n({ locales: { es: { Save: 'Guardar' }, [pseudo.locale]: {} }, onUntranslated: pseudo.onUntranslated })
		expect(i18n.scope('en-XA').translate('Save {count} files', { count: 3 })).toBe('[Šáṽé 3 ƒíļéš ~~~~]')
		expect(i18n.scope('es').translate('Save')).toBe('Guardar')
		expect(i18n.scope('es').translate('Cancel')).toBe('Cancel')
	})
})

describe('eslint rule', () => {
	const lint = (code: string, options?: NoUntranslatedTextOptions) =>
		new Linter({ configType: 'flat' })
			.verify(code, [
				{
					files: ['**/*.jsx'],
					languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
					plugins: { textlate },
					rules: { 'textlate/no-untranslated-text': options ? ['error', options] : 'error' }
				}
			], 'app.jsx')
			.map(message => message.message)

	it('reports text and read attributes written plainly in JSX', () => {
		expect(
			lint(`
				const App = () => (
					<main title="Dashboard">
						<h1>Welcome back</h1>
						{'Plain in braces'}
						<img alt="Company logo" src="/logo.png" />
						<input placeholder={\`Search\`} type="text" className="search-box" />
					</main>
				)
			`)
		).toEqual([
			'Untranslated title "Dashboard": write it with translate() so it reaches every language.',
			'Untranslated text "Welcome back": write it with translate() so it reaches every language.',
			'Untranslated text "Plain in braces": write it with translate() so it reaches every language.',
			'Untranslated alt "Company logo": write it with translate() so it reaches every language.',
			'Untranslated placeholder "Search": write it with translate() so it reaches every language.'
		])
	})

	it('passes translated text, symbols, numbers, code and what it is told to allow', () => {
		expect(
			lint(
				`
				const App = ({ count }) => (
					<p title={translate('Count')} aria-label={label}>
						{translate('Welcome back')} · 42 — {count} &nbsp; →
						<code>npm install textlate</code>
						<pre>{'const x = 1'}</pre>
						TareAI
					</p>
				)
			`,
				{ allow: ['TareAI', '/^v\\d+$/'] }
			)
		).toEqual([])
	})

	it('checks more attributes when told', () => {
		expect(lint(`const F = () => <Field label="Email address" name="email" />`, { attributes: ['label'] })).toEqual([
			'Untranslated label "Email address": write it with translate() so it reaches every language.'
		])
	})

	it('comes with a recommended config', () => {
		expect(textlate.configs.recommended.rules).toEqual({ 'textlate/no-untranslated-text': 'error' })
		expect(textlate.configs.recommended.plugins.textlate).toBe(textlate)
	})
})
