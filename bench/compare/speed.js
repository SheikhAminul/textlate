// Same Spanish translations, same output, four libraries: `npm run speed`
import i18next from 'i18next'
import { createTranslator } from 'next-intl'
import { createIntl } from 'react-intl'
import { Bench } from 'tinybench'
import { createI18n } from 'textlate'

const inbox = { one: 'You have {count} message', other: 'You have {count} messages' }
const { translate } = createI18n({
	locale: 'es',
	locales: {
		es: {
			'Plain text': 'Texto simple',
			'Hello, {name}!': '¡Hola, {name}!',
			'You have {count} messages': { one: 'Tienes {count} mensaje', many: 'Tienes {count} de mensajes', other: 'Tienes {count} mensajes' }
		}
	}
})

await i18next.init({
	lng: 'es',
	resources: {
		es: { translation: { plain: 'Texto simple', greeting: '¡Hola, {{name}}!', inbox_one: 'Tienes {{count}} mensaje', inbox_many: 'Tienes {{count}} de mensajes', inbox_other: 'Tienes {{count}} mensajes' } }
	}
})

const icu = {
	plain: 'Texto simple',
	greeting: '¡Hola, {name}!',
	inbox: '{count, plural, one {Tienes # mensaje} many {Tienes # de mensajes} other {Tienes # mensajes}}'
}
const intl = createIntl({ locale: 'es', messages: icu })
const nextIntl = createTranslator({ locale: 'es', messages: icu })

const cases = {
	'plain': [() => translate('Plain text'), () => i18next.t('plain'), () => intl.formatMessage({ id: 'plain' }), () => nextIntl('plain')],
	'param': [() => translate('Hello, {name}!', { name: 'Ada' }), () => i18next.t('greeting', { name: 'Ada' }), () => intl.formatMessage({ id: 'greeting' }, { name: 'Ada' }), () => nextIntl('greeting', { name: 'Ada' })],
	'plural': [() => translate(inbox, { count: 3 }), () => i18next.t('inbox', { count: 3 }), () => intl.formatMessage({ id: 'inbox' }, { count: 3 }), () => nextIntl('inbox', { count: 3 })]
}
const libs = ['textlate', 'i18next', 'react-intl', 'next-intl']

// Every library must produce the same text for the comparison to be fair.
for (const [name, fns] of Object.entries(cases)) console.log(name, fns.map(fn => fn()))

const rows = {}
for (const [name, fns] of Object.entries(cases)) {
	const bench = new Bench({ time: 400 })
	fns.forEach((fn, i) => bench.add(libs[i], fn))
	await bench.run()
	rows[name] = Object.fromEntries(bench.tasks.map(task => [task.name, `${(task.result.throughput.mean / 1e6).toFixed(2)} M`]))
}
console.table(rows)
