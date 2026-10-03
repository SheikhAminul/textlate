import { defineConfig } from 'textlate/config'

// Used by `npm run i18n`. The API key comes from ANTHROPIC_API_KEY (or .env.local).
export default defineConfig({
	sourceLocale: 'en',
	locales: ['bn', 'ar'],
	ai: { instructions: 'A demo page for a JavaScript library. Keep "textlate" and "Next.js" untranslated.' }
})
