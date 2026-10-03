import Link from 'next/link'
import { i18n } from '@/i18n'
import { Counter } from './counter'
import { LanguageSwitcher } from './language-switcher'

const Home = async ({ params }: { params: Promise<{ lang: string }> }) => {
	// Server Components have no context: load the route's locale and use its translate and format.
	const { translate, format } = await i18n.load((await params).lang)

	return (
		<main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto', lineHeight: 1.6 }}>
			<LanguageSwitcher />
			<h1>{translate('Welcome to {site}', { site: 'textlate' })}</h1>
			<p>
				{translate('This page was rendered by a <b>Server Component</b>. Read the <docs>docs</docs>.', {
					b: <strong />,
					docs: chunks => <Link href="https://github.com/SheikhAminul/textlate">{chunks}</Link>
				})}
			</p>
			<p>
				{translate({ zero: 'No visits yet', one: '{count} visit', other: '{count} visits' }, { count: 1234 })} ·{' '}
				{format.date(new Date(Date.UTC(2026, 9, 2)), { dateStyle: 'full', timeZone: 'UTC' })}
			</p>
			<Counter />
		</main>
	)
}

export default Home
