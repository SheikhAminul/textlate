// Benchmarks the built package: `npm run bench`
import { createElement } from 'react'
import { Bench } from 'tinybench'
import { createI18n } from '../dist/index.js'

const inbox = { zero: 'No messages', one: 'You have {count} message', other: 'You have {count} messages' }
const i18n = createI18n({
	locales: {
		es: {
			'Plain text': 'Texto simple',
			'Hello, {name}!': '¡Hola, {name}!',
			'You have {count} messages': { zero: 'Sin mensajes', one: 'Tienes {count} mensaje', many: 'Tienes {count} de mensajes', other: 'Tienes {count} mensajes' },
			'Open // ticket status': 'Abierto',
			'Total: {amount}': 'Total: {amount}',
			'Read the <link>terms</link> and <b>agree</b>.': 'Lee los <link>términos</link> y <b>acepta</b>.'
		},
		'es-MX': {}
	}
})
const en = i18n.scope('en').translate
const es = i18n.scope('es').translate
const esMX = i18n.scope('es-MX').translate
let unique = 0
const values = { link: createElement('a', { href: '/terms' }), b: createElement('b') }

const bench = new Bench({ time: 300 })
	.add('plain, source locale', () => en('Plain text'))
	.add('plain', () => es('Plain text'))
	.add('param', () => es('Hello, {name}!', { name: 'Ada' }))
	.add('number param', () => es('Total: {amount}', { amount: 1234.5 }))
	.add('plural', () => es(inbox, { count: 3 }))
	.add('plural, a new count every call', () => es(inbox, { count: unique++ }))
	.add('context', () => es({ text: 'Open', context: 'ticket status' }))
	.add('fallback es-MX → es', () => esMX('Hello, {name}!', { name: 'Ada' }))
	.add('untranslated', () => es('Not translated, {name}', { name: 'Ada' }))
	.add('rich text', () => es('Read the <link>terms</link> and <b>agree</b>.', values))

await bench.run()
console.table(bench.table(task => ({ task: task.name, 'ops/sec': Math.round(task.result.throughput.mean).toLocaleString('en') })))
