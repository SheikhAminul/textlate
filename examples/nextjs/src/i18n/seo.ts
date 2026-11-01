import { createSeo } from 'textlate/next'
import meta from '../locales/.textlate/meta.json'
import { routing } from '.'

// Server only. A locale with less than 90% of its messages translated stays out of search engines: noindex, and out of
// every page's hreflang links and the sitemap. `npm run i18n` keeps meta.json up to date.
export const seo = createSeo(routing, { meta, minCoverage: 0.9 })
