// Type-level tests: `npm run typecheck` fails if any assertion or `@ts-expect-error` is wrong.
import type { ReactNode } from 'react'
import { describe, expectTypeOf, it } from 'vitest'
import { createI18n, msg, type I18n, type Scope } from '../src/index.js'
import { I18nProvider, useI18n } from '../src/react.js'
import { createTestI18n, inbox } from './fixtures/i18n.js'

describe('types', () => {
	const i18n = createTestI18n()
	const { translate } = i18n

	it('infers locales from the config, source locale first', () => {
		expectTypeOf(i18n.locales).toEqualTypeOf<readonly ('en' | 'ar' | 'bn' | 'bn-BD')[]>()
		expectTypeOf(i18n.locale).toEqualTypeOf<'en' | 'ar' | 'bn' | 'bn-BD'>()
		expectTypeOf(i18n.match).returns.toEqualTypeOf<'en' | 'ar' | 'bn' | 'bn-BD' | undefined>()
		expectTypeOf(createI18n({ sourceLocale: 'de', locales: { fr: {} } })).toEqualTypeOf<I18n<'de' | 'fr'>>()
		expectTypeOf(i18n.load('bn')).resolves.toEqualTypeOf<Scope<'en' | 'ar' | 'bn' | 'bn-BD'>>()
	})

	it('accepts any text, and reads params from it', () => {
		expectTypeOf(translate('Anything at all')).toEqualTypeOf<string>()
		expectTypeOf(translate('Hello, {name}!', { name: 'Ada' })).toEqualTypeOf<string>()
		translate('Total: {amount}', { amount: 1 })
		translate('Total: {amount}', { amount: 10n })
		translate('Total: {amount}', { amount: new Date() })
		translate('Use {curly braces} and {}')

		// @ts-expect-error missing values
		translate('Hello, {name}!')
		// @ts-expect-error misspelled param
		translate('Hello, {name}!', { nam: 'Ada' })
		// @ts-expect-error values must be text, numbers, bigints, dates or React nodes
		translate('Hello, {name}!', { name: { first: 'Ada' } })
	})

	it('requires `count` for plurals, and params from every form', () => {
		expectTypeOf(translate(inbox, { count: 2 })).toEqualTypeOf<string>()
		translate(inbox, { count: 2n })
		translate({ one: 'One file in {folder}', other: '{count} files in {folder}' }, { count: 2, folder: 'Docs' })
		// `{count}` outside a plural is an ordinary param.
		translate('{count} unread', { count: '2' })

		// @ts-expect-error count is required
		translate(inbox)
		// @ts-expect-error count must be a number
		translate(inbox, { count: '2' })
		// @ts-expect-error params from every form are required
		translate({ one: 'One file in {folder}', other: '{count} files' }, { count: 1 })
		// @ts-expect-error a plural needs `other`
		void (() => translate({ one: '{count} file' }, { count: 1 }))
	})

	it('takes context', () => {
		expectTypeOf(translate({ text: 'Open', context: 'ticket status' })).toEqualTypeOf<string>()
		translate({ text: 'Assigned to {name}', context: 'ticket' }, { name: 'Ada' })
		translate({ one: '{count} seat', other: '{count} seats', context: 'airplane' }, { count: 2 })

		// @ts-expect-error missing values
		translate({ text: 'Assigned to {name}', context: 'ticket' })
		// @ts-expect-error text or plural forms, not both
		void (() => translate({ text: 'Open', other: 'Opens' }))
	})

	it('returns React nodes for tags and element values, and requires every tag renderer', () => {
		expectTypeOf(translate('Read the <link>terms</link>.', { link: <a /> })).toEqualTypeOf<ReactNode>()
		expectTypeOf(translate('Hello, {name}!', { name: <b>Ada</b> })).toEqualTypeOf<ReactNode>()
		translate('Read the <link>terms</link>.', { link: chunks => <a>{chunks}</a> })
		translate('One<br />Two <b >bold</b >', { br: <br />, b: <b /> })
		translate({ one: '<b>{count}</b> file', other: '<b>{count}</b> files' }, { count: 1, b: <b /> })
		translate('<a href>x</a> <a.b>y</a.b> <h1>z</h1>', { h1: <h1 /> })

		// @ts-expect-error the <link> renderer is required
		translate('Read the <link>terms</link>.')
		// @ts-expect-error renderers are keyed by the bare tag name
		translate('One<br />Two', { 'br ': <br /> })
		// @ts-expect-error only names the parser reads as tags need renderers; <h1> does
		translate('<a.b>y</a.b> <h1>z</h1>', {})
	})

	it('types text chosen at runtime', () => {
		const labels = { active: msg('Active'), banned: msg('Banned by {admin}'), open: msg({ text: 'Open', context: 'ticket status' }) }
		expectTypeOf(labels.active).toEqualTypeOf<'Active'>()
		translate(labels.banned, { admin: 'Ada' })
		translate(labels.open)
		// @ts-expect-error missing values
		translate(labels.banned)

		const text: string = String(Math.random())
		expectTypeOf(translate(text)).toEqualTypeOf<string>()
		translate(text, { any: 1 })
		expectTypeOf(translate(text, { any: <b /> })).toEqualTypeOf<ReactNode>()
	})

	it('types the React hook via Register', () => {
		const Component = () => {
			const { translate, locale, setLocale, format, dir } = useI18n()
			expectTypeOf(locale).toEqualTypeOf<'en' | 'ar' | 'bn' | 'bn-BD'>()
			expectTypeOf(dir).toEqualTypeOf<'ltr' | 'rtl'>()
			void setLocale('bn')
			return (
				<>
					{translate('Hello, {name}!', { name: 'Ada' })}
					{translate('Read the <link>terms</link>.', { link: <a /> })}
					{format.number(1)}
				</>
			)
		}
		const App = () => (
			<I18nProvider i18n={i18n} translations={{ bn: { Welcome: 'স্বাগতম' } }}>
				<Component />
			</I18nProvider>
		)
		expectTypeOf(App).toBeFunction()
	})
})
