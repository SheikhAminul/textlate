'use client'

import type { Messages } from 'textlate'
import { I18nProvider } from 'textlate/react'
import type { ReactNode } from 'react'
import { i18n, type Locale } from '@/i18n'

// The instance holds functions, so it can't be passed from a Server Component; this client module imports it instead.
// `locale` pins the tree to the route's locale, giving every request its own isolated state; `messages` are the
// translations the server loaded for it.
export const Providers = ({ locale, messages, children }: { locale: Locale; messages: Messages; children: ReactNode }) => (
	<I18nProvider i18n={i18n} locale={locale} messages={messages}>
		{children}
	</I18nProvider>
)
