import { createProxy } from 'textlate/next'
import { routing } from './i18n'

// Addresses with a locale are served as they are; `/` and other addresses without one go to the visitor's saved choice,
// then their browser's language.
export const proxy = createProxy(routing)

export const config = {
	matcher: ['/((?!_next|api|.*\\..*).*)']
}
