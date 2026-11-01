// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanWithTypeScript, type TypeScript } from '../src/cli/ast.js'
import { buildRouteManifest, createResolver, routeOf } from '../src/cli/routes.js'
import { run } from '../src/cli/run.js'
import { scanFile } from '../src/cli/scan.js'
import { hashKey } from '../src/hash.js'

const typescript = ts as unknown as TypeScript

describe('parsing with TypeScript', () => {
	const scan = (code: string, file = 'app.tsx', properties: string[] = []) => scanWithTypeScript(typescript, code, file, ['translate', 'msg'], properties)

	it('finds calls, aliases, member calls and message objects — never in comments or strings', () => {
		const result = scan(`
			'use client'
			import type { Props } from './types'
			import { Button } from '@/components/button'
			export { helper } from './helper'
			const Lazy = lazy(() => import('./lazy'))
			const { translate: t } = useI18n()
			const tr = i18n.translate
			// translate('In a comment')
			const text = "translate('In a string')"
			export const View = () => <p title={t('Aliased')}>{tr('Assigned')}{i18n.translate('Member')}{translate({ one: '{count} run', other: '{count} runs' }, { count })}</p>
			const labels = { open: msg({ text: 'Open', context: 'ticket status' }) }
		`)
		expect(result.messages).toEqual([
			['Aliased', 'Aliased'],
			['Assigned', 'Assigned'],
			['Member', 'Member'],
			['{count} runs', { one: '{count} run', other: '{count} runs' }],
			['Open // ticket status', { text: 'Open', context: 'ticket status' }]
		])
		expect(result.imports).toEqual(['@/components/button', './helper', './lazy'])
		expect(result.client).toBe(true)
		expect(result.warnings).toEqual([])
	})

	it('reports text built at runtime and malformed messages, with their lines', () => {
		const { warnings } = scan(`translate('Hi ' + name)\ntranslate(\`Hi \${name}\`)\ntranslate({ text: 'A', one: 'B', other: 'C' })\ntranslate(label)`)
		expect(warnings.map(({ line, message }) => `${line} ${message}`)).toEqual([
			"1 translate(…): the text is built at runtime, so it can't be extracted. Write it as one string with {params} for the values.",
			"2 translate(…): the text is built at runtime, so it can't be extracted. Write it as one string with {params} for the values.",
			'3 translate(…): a message has either `text` or plural forms, not both.'
		])
	})

	it('reads text in data only from the properties it is told', () => {
		const { messages, client } = scan(`export const SLACK = { id: 'slack', label: 'Slack', description: \`Sends messages.\`, help: 'Not this' }\ninterface Field { label: 'not a value' }`, 'slack.ts', ['label', 'description'])
		expect(messages.map(([key]) => key)).toEqual(['Slack', 'Sends messages.'])
		expect(client).toBe(false)
	})
})

describe('routes', () => {
	let cwd: string
	const write = (path: string, content: string) => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true })
		writeFileSync(join(cwd, path), content)
	}
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'textlate-routes-'))
		write('tsconfig.json', `{ // comments are fine\n "compilerOptions": { "paths": { "@/*": ["./*"] }, }, }`)
		// A workspace package, linked into node_modules, with a pattern in its exports.
		write('packages/catalog/package.json', JSON.stringify({ name: '@acme/catalog', exports: { './*': './src/*.ts' } }))
		write('packages/catalog/src/apps.ts', `export const APPS = [{ id: 'slack', label: msg('Slack') }]`)
		mkdirSync(join(cwd, 'node_modules', '@acme'), { recursive: true })
		symlinkSync(join(cwd, 'packages', 'catalog'), join(cwd, 'node_modules', '@acme', 'catalog'))
		write('app/[lang]/layout.tsx', `import { Nav } from '@/components/nav'\nexport default ({ children }) => <html><body><Nav />{children}</body></html>`)
		write('components/nav.tsx', `'use client'\nimport { Logo } from './logo'\nexport const Nav = () => <nav>{translate('Home')}<Logo /></nav>`)
		write('components/logo.tsx', `export const Logo = () => <b>{translate('TareAI logo')}</b>`)
		write('app/[lang]/(marketing)/integrations/[app]/page.tsx', `import { Picker } from './picker'\nimport { title } from './title'\nexport default () => <main><h1>{translate('Rendered on the server')}</h1><Picker /></main>`)
		write('app/[lang]/(marketing)/integrations/[app]/picker.tsx', `"use client"\nimport { APPS } from '@acme/catalog/apps'\nexport const Picker = () => APPS.map(app => <li>{translate(app.label)}{translate('Pick an app')}</li>)`)
		write('app/[lang]/(marketing)/integrations/[app]/title.ts', `export const title = () => translate('Server title')`)
		write('node_modules/left-pad/index.js', `translate('From the registry')`)
	})
	afterEach(() => rmSync(cwd, { recursive: true, force: true }))

	it('resolves relative paths, tsconfig paths and workspace packages, and nothing from the registry', () => {
		const resolve = createResolver(cwd)
		const from = join(cwd, 'app', '[lang]', 'layout.tsx')
		expect(resolve(from, '@/components/nav')).toContain(join('components', 'nav.tsx'))
		expect(resolve(from, '@acme/catalog/apps')).toContain(join('packages', 'catalog', 'src', 'apps.ts'))
		expect(resolve(from, 'left-pad')).toBeUndefined()
		expect(routeOf(join(cwd, 'app'), join(cwd, 'app', '[lang]', '(marketing)', 'integrations', '[app]', 'page.tsx'))).toBe('/[lang]/integrations/[app]')
	})

	it('lists for each page and layout the messages of its client components, and nothing the server renders', () => {
		for (const scanner of [typescript, undefined]) {
			const manifest = buildRouteManifest(cwd, ['app'], file => scanFile(file, cwd, { typescript: scanner }))
			expect(manifest).toEqual({
				layouts: { '/[lang]': ['Home', 'TareAI logo'] },
				pages: { '/[lang]/integrations/[app]': ['Pick an app', 'Slack'] }
			})
		}
	})
})

describe('building for the browser', () => {
	let cwd: string
	const write = (path: string, content: string) => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true })
		writeFileSync(join(cwd, path), content)
	}
	const read = (path: string) => JSON.parse(readFileSync(join(cwd, path), 'utf8')) as Record<string, any>
	const cli = async (args: string[]) => {
		const output: string[] = []
		const code = await run(args, { cwd, color: false, log: line => output.push(line), error: line => output.push(line) })
		return { code, output: output.join('\n') }
	}
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'textlate-build-'))
		mkdirSync(join(cwd, 'node_modules'))
		write('src/app.tsx', `translate('Save'); translate('Cancel'); translate('Later')`)
		write('src/locales/de.json', JSON.stringify({ Save: 'Speichern', Cancel: 'Abbrechen', Later: '' }, null, 2) + '\n')
		write('textlate.config.json', JSON.stringify({ locales: ['de'], compile: true }))
	})
	afterEach(() => rmSync(cwd, { recursive: true, force: true }))

	it('compiles translated messages under short keys, and check notices when they go stale', async () => {
		expect((await cli(['compile'])).output).toContain(`Compiled 1 file into ${join('src', 'locales', '.compiled')}.`)
		expect(read('src/locales/.compiled/de.json')).toEqual({ [hashKey('Save')]: 'Speichern', [hashKey('Cancel')]: 'Abbrechen' })
		expect((await cli(['compile'])).output).toContain('The compiled catalogs are up to date.')

		write('src/locales/de.json', JSON.stringify({ Save: 'Sichern', Cancel: 'Abbrechen', Later: 'Später' }, null, 2) + '\n')
		const stale = await cli(['check'])
		expect(stale.code).toBe(1)
		expect(stale.output).toContain('compiled catalogs in src/locales/.compiled are out of date (run textlate compile)')
	})

	it('keeps each locale\'s coverage and last change for SEO, moving the date only when translations change', async () => {
		await cli(['extract'])
		const first = read('src/locales/.textlate/meta.json')
		expect(first['de'].default).toMatchObject({ messages: 3, translated: 2, reviewed: 0 })
		expect(Date.parse(first['de'].default.updated)).toBeGreaterThan(0)
		await new Promise(done => setTimeout(done, 5))
		await cli(['extract'])
		expect(read('src/locales/.textlate/meta.json')['de'].default.updated).toBe(first['de'].default.updated)
		write('src/locales/de.json', JSON.stringify({ Save: 'Speichern', Cancel: 'Abbrechen', Later: 'Später' }, null, 2) + '\n')
		await cli(['extract'])
		expect(read('src/locales/.textlate/meta.json')['de'].default).toMatchObject({ translated: 3 })
	})

	it('keeps scans of unchanged files between runs', async () => {
		await cli(['extract'])
		const cache = read('node_modules/.cache/textlate/scan.json')
		expect(cache['version']).toBe(1)
		expect(Object.keys(cache['entries'])).toHaveLength(1)
		// The same size and modification time: the kept scan is used, not the file.
		const stamp = new Date(Date.now() - 60_000)
		utimesSync(join(cwd, 'src/app.tsx'), stamp, stamp)
		await cli(['extract'])
		write('src/app.tsx', `translate('Same'); translate('Cancel'); translate('Later')`)
		utimesSync(join(cwd, 'src/app.tsx'), stamp, stamp)
		await cli(['extract'])
		expect(Object.keys(read('src/locales/de.json'))).toEqual(['Save', 'Cancel', 'Later'])
		// Touched: scanned again.
		utimesSync(join(cwd, 'src/app.tsx'), new Date(), new Date())
		await cli(['extract'])
		expect(Object.keys(read('src/locales/de.json'))).toEqual(['Same', 'Cancel', 'Later'])
	})
})
