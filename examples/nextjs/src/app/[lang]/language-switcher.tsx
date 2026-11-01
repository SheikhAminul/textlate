'use client'

import { useI18n } from 'textlate/react'
import { usePathname, useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { localeCookie, routing, type Locale } from '@/i18n'

// With a URL-based locale, switching language means navigating; the new route's layout passes the new locale down.
export const LanguageSwitcher = () => {
	const { translate, locale, locales } = useI18n()
	const router = useRouter()
	const pathname = usePathname()
	const [isPending, startTransition] = useTransition()

	return (
		<label>
			{translate('Language')}{' '}
			<select
				value={locale}
				disabled={isPending}
				onChange={event => {
					const next = event.target.value as Locale
					localeCookie.persist?.(next)
					startTransition(() => router.push(routing.path(next, pathname)))
				}}
			>
				{locales.map(option => (
					<option key={option} value={option} lang={option}>
						{new Intl.DisplayNames([option], { type: 'language' }).of(option)}
					</option>
				))}
			</select>
		</label>
	)
}
