// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { directiveOf, importsOf, parseJsonc, readAliases, resolveImport, walk } from '../src/cli/graph.js'
import { run } from '../src/cli/run.js'

let cwd: string
const write = (path: string, content: string) => {
	mkdirSync(dirname(join(cwd, path)), { recursive: true })
	writeFileSync(join(cwd, path), content)
}
const read = (path: string) => JSON.parse(readFileSync(join(cwd, path), 'utf8')) as Record<string, unknown>
const at = (path: string) => join(cwd, path)
const cli = async (args: string[]) => {
	const output: string[] = []
	const code = await run(args, { cwd, color: false, unicode: true, log: line => output.push(line), error: line => output.push(line) })
	return { code, output: output.join('\n') }
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'textlate-sections-'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

describe('the import graph', () => {
	it('reads runtime imports — not type-only ones, nor commented-out code', () => {
		const code = `
			'use client'
			import a from './a'
			import { b, type C } from "@/b"
			import type { D } from './d'
			export * from './e.js'
			export type { F } from './f'
			import './side-effect'
			// import nope from './nope'
			/* import nope2 from './nope2' */
			const lazy = () => import('./lazy')
			const url = 'https://example.com/x'
		`
		expect(importsOf(code)).toEqual(['./a', '@/b', './e.js', './side-effect', './lazy'])
		expect(directiveOf(code)).toBe('client')
		expect(directiveOf(`// A comment first\n"use server"\nexport const x = 1`)).toBe('server')
		expect(directiveOf(`const a = 'use client'`)).toBeUndefined()
	})

	it('resolves relative paths, extensions, index files, .js for .ts and tsconfig aliases', () => {
		write('tsconfig.json', `{
			// Comments and trailing commas, as tsconfig allows
			"compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"], "~lib": ["./lib/index.ts"], }, },
		}`)
		write('lib/index.ts', '')
		write('components/Button.tsx', '')
		write('components/menu/index.tsx', '')
		write('app/page.tsx', '')
		write('app/util.ts', '')
		const aliases = readAliases(cwd)
		const from = at('app/page.tsx')
		expect(resolveImport('@/components/Button', from, aliases)).toBe(at('components/Button.tsx'))
		expect(resolveImport('../components/menu', from, aliases)).toBe(at('components/menu/index.tsx'))
		expect(resolveImport('./util.js', from, aliases)).toBe(at('app/util.ts'))
		expect(resolveImport('~lib', from, aliases)).toBe(at('lib/index.ts'))
		expect(resolveImport('react', from, aliases)).toBeUndefined()
		expect(resolveImport('./styles.css', from, aliases)).toBeUndefined()
		expect(parseJsonc('{ "a": "// not a comment", /* x */ "b": [1,], }')).toEqual({ a: '// not a comment', b: [1] })
	})

	it('marks client modules, and what they import, as the browser\'s — never a server action', () => {
		write('page.tsx', `import { Hero } from './Hero'\nimport { Header } from './Header'`)
		write('Hero.tsx', `'use client'\nimport { Button } from './Button'\nimport { save } from './actions'`)
		write('Header.tsx', `import { Button } from './Button'`)
		write('Button.tsx', ``)
		write('actions.ts', `'use server'\nimport { db } from './db'`)
		write('db.ts', ``)
		const graph = walk([at('page.tsx')], [])
		expect(graph.files).toEqual(['Button.tsx', 'Header.tsx', 'Hero.tsx', 'actions.ts', 'db.ts', 'page.tsx'].map(at))
		expect([...graph.clientFiles].sort()).toEqual(['Button.tsx', 'Hero.tsx'].map(at))
	})
})

describe('sections', () => {
	beforeEach(() => {
		write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }))
		write('textlate.config.json', JSON.stringify({ dir: 'locales', sections: ['app/(site)', 'app/(app)', 'app/(app)/admin'], sectionMessages: 'client' }))
		write('app/(site)/page.tsx', `import { Header } from '@/components/Header'\nimport { Hero } from './Hero'\nexport default () => translate('Welcome')`)
		write('app/(site)/Hero.tsx', `'use client'\nimport { Button } from '@/components/Button'\nimport { send } from './actions'\nexport const Hero = () => translate('Automate your work')`)
		write('app/(site)/actions.ts', `'use server'\nexport const send = () => translate('Something went wrong')`)
		write('components/Header.tsx', `import type { Props } from './types'\nexport const Header = () => translate({ text: 'Home', context: 'navigation' })`)
		write('components/Button.tsx', `'use client'\nexport const Button = ({ count }) => translate({ one: '{count} item', other: '{count} items' }, { count })`)
		write('app/(app)/page.tsx', `import { Header } from '@/components/Header'\nexport default () => translate('Dashboard')`)
		write('app/(app)/admin/page.tsx', `export default () => translate('Admin only')`)
		// French on the site, set up by hand before: its translation is kept.
		write('app/(site)/locales/fr.json', JSON.stringify({ Welcome: 'Bienvenue' }))
		write('locales/fr.json', JSON.stringify({ 'Home // navigation': 'Accueil' }))
	})

	it('writes the main catalog with all a language\'s text, and each section only what its browser code uses', async () => {
		const { code, output } = await cli(['extract'])
		expect(code).toBe(0)
		expect(output).toContain('Sections')
		expect(read('locales/fr.json')).toEqual({
			'Automate your work': '',
			'Something went wrong': '',
			Welcome: 'Bienvenue',
			'{count} items': { one: '', many: '', other: '' },
			'Home // navigation': 'Accueil'
		})
		// Only the client modules' text: not the page's, the header's (server components) or the server action's.
		expect(read('app/(site)/locales/fr.json')).toEqual({ 'Automate your work': '', '{count} items': { one: '', many: '', other: '' } })
		// No languages: English only, so no files — and the admin section's text is its own, not the app's.
		expect(existsSync(at('app/(app)/locales'))).toBe(false)
		expect(read('locales/sections.json')).toEqual({
			sourceLocale: 'en',
			sections: {
				site: { path: 'app/(site)', locales: ['fr'] },
				app: { path: 'app/(app)', locales: [] },
				admin: { path: 'app/(app)/admin', locales: [] }
			}
		})
		expect(Object.keys(read('locales/fr.json'))).not.toContain('Dashboard')
	})

	it('fails the check until everything is translated and every section file is in sync', async () => {
		await cli(['extract'])
		const failing = await cli(['check'])
		expect(failing.code).toBe(1)
		expect(failing.output).toContain('3 untranslated')

		write('locales/fr.json', JSON.stringify({
			'Automate your work': 'Automatisez votre travail',
			'Something went wrong': 'Une erreur est survenue',
			Welcome: 'Bienvenue',
			'{count} items': { one: '{count} élément', many: '{count} d’éléments', other: '{count} éléments' },
			'Home // navigation': 'Accueil'
		}))
		const stale = await cli(['check'])
		expect(stale.code).toBe(1)
		expect(stale.output).toContain('app/(site)/locales/fr.json  out of date')

		await cli(['extract'])
		expect(read('app/(site)/locales/fr.json')).toEqual({
			'Automate your work': 'Automatisez votre travail',
			'{count} items': { one: '{count} élément', many: '{count} d’éléments', other: '{count} éléments' }
		})
		const passing = await cli(['check'])
		expect(passing.code).toBe(0)
		expect(passing.output).toContain('up to date')
	})

	it('adds a language to some sections, and the main catalog follows', async () => {
		const { code, output } = await cli(['add', 'de,ja', '--sections', 'app'])
		expect(code).toBe(0)
		expect(output).toContain('Added app/(app)/locales/de.json')
		expect(read('app/(app)/locales/ja.json')).toEqual({})
		expect(read('locales/de.json')).toEqual({ Dashboard: '', 'Home // navigation': '' })
		expect(read('locales/sections.json')).toMatchObject({ sections: { app: { locales: ['de', 'ja'] } } })

		expect((await cli(['add', 'fr', '--sections', 'nope'])).output).toContain('No section is called "nope"')
		expect((await cli(['add', 'not a code'])).output).toContain('isn\'t a language code')
		expect((await cli(['extract', '--locales', 'ko'])).output).toContain('No section is in ko yet')
	})

	it('puts all of a section\'s text in its files with sectionMessages: all', async () => {
		write('textlate.config.json', JSON.stringify({ dir: 'locales', sections: ['app/(site)', { path: 'app/(app)', name: 'dashboard' }] }))
		await cli(['extract'])
		expect(Object.keys(read('app/(site)/locales/fr.json'))).toEqual(['Automate your work', 'Something went wrong', 'Welcome', '{count} items', 'Home // navigation'])
		// Without its own section, the admin pages are the app's.
		await cli(['add', 'fr', '--sections', 'dashboard'])
		expect(Object.keys(read('app/(app)/locales/fr.json'))).toEqual(['Admin only', 'Dashboard', 'Home // navigation'])
	})

	it('drops text no section uses any more, and warns about a catalog no section is in', async () => {
		await cli(['extract'])
		write('app/(site)/Hero.tsx', `'use client'\nexport const Hero = () => translate('A new headline')`)
		write('locales/es.json', '{}')
		const { output } = await cli(['extract'])
		expect(Object.keys(read('locales/fr.json'))).not.toContain('Automate your work')
		expect(read('app/(site)/locales/fr.json')).toEqual({ 'A new headline': '' })
		expect(output).toContain('locales/es.json: no section is in this language any more')
	})
})
