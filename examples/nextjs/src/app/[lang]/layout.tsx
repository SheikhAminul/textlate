import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { i18n } from '@/i18n'
import { Providers } from './providers'

type Props = { children: ReactNode; params: Promise<{ lang: string }> }

export const generateStaticParams = () => i18n.locales.map(lang => ({ lang }))
export const dynamicParams = false

export const generateMetadata = async ({ params }: Omit<Props, 'children'>): Promise<Metadata> => {
	const { translate } = await i18n.load((await params).lang)
	return { title: translate('textlate + Next.js') }
}

const RootLayout = async ({ children, params }: Props) => {
	const { lang } = await params
	const locale = i18n.match(lang)
	if (locale !== lang) notFound()

	return (
		<html lang={locale} dir={i18n.scope(locale).dir}>
			<body>
				<Providers locale={locale}>{children}</Providers>
			</body>
		</html>
	)
}

export default RootLayout
