import type { MetadataRoute } from 'next'
import { seo } from '@/i18n/seo'

// One entry per page and indexed locale, each listing the others, dated by its translations' last change.
const sitemap = (): MetadataRoute.Sitemap => seo.sitemap([{ pathname: '/', changeFrequency: 'weekly', priority: 1 }])

export default sitemap
