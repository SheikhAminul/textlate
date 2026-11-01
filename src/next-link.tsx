'use client'

import NextLink from 'next/link'
import type { ComponentProps } from 'react'
import { useI18n } from './react.js'
import type { Routing } from './routing.js'

export type LinkProps<L extends string> = ComponentProps<typeof NextLink> & {
	/** Link to the page in this locale instead of the active one — for a language switcher. */
	locale?: L | undefined
}

/**
 * A Next.js `<Link>` that keeps the visitor in their locale: `href="/pricing"` goes to `/de/pricing` on a German page.
 * With `locale`, it links to the page in that language, and says which with `hrefLang` (and `lang`, for screen readers).
 * Addresses to other sites, and hrefs given as objects, pass through as they are.
 *
 * @example
 * ```tsx
 * // src/i18n/link.tsx
 * 'use client'
 * export const Link = createLink(routing)
 *
 * <Link href="/integrations/slack">Slack</Link>
 * <Link href={pathname} locale="ja">日本語</Link>
 * ```
 */
export const createLink = <L extends string>(routing: Routing<L>) => {
	const Link = ({ href, locale, ...props }: LinkProps<L>) => {
		const { locale: active } = useI18n()
		const target = locale ?? (routing.locales.includes(active as L) ? (active as L) : routing.defaultLocale)
		const internal = typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')
		return (
			<NextLink
				{...props}
				href={internal ? routing.path(target, href) : href}
				{...(locale && { hrefLang: routing.hreflangOf(locale), lang: locale })}
			/>
		)
	}
	Link.displayName = 'Link'
	return Link
}
