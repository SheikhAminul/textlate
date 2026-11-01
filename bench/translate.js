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

// A large app's catalog: 20,000 messages, read in no particular order.
const LARGE = 20_000
const large = {}
const keys = []
for (let n = 0; n < LARGE; n++) {
	keys.push(`Message ${n} for {name}`)
	large[`Message ${n} for {name}`] = `Mensaje ${n} para {name}`
}
const big = createI18n({ locales: { es: large } }).scope('es').translate
let next = 0
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
	.add(`param, ${LARGE.toLocaleString('en')}-message catalog`, () => big(keys[(next = (next + 7919) % LARGE)], { name: 'Ada' }))

await bench.run()
console.table(bench.table(task => ({ task: task.name, 'ops/sec': Math.round(task.result.throughput.mean).toLocaleString('en') })))
