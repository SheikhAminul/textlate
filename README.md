textlate
========

[![NPM Version](https://img.shields.io/npm/v/textlate.svg?branch=main)](https://www.npmjs.com/package/textlate)
[![Bundle size](https://badgen.net/bundlephobia/minzip/textlate)](https://bundlephobia.com/package/textlate)
[![Downloads](https://img.shields.io/npm/dt/textlate)](https://www.npmjs.com/package/textlate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/SheikhAminul/textlate/blob/main/LICENSE)

**Write your text in your code. Translate it with AI in one command.**
textlate is i18n without keys for **React 19** and **Next.js App Router**. It is about 3 kB with zero dependencies, fully type-safe, works in Server Components, and translates 5–60× faster than react-i18next, react-intl and next-intl in [reproducible benchmarks](#comparison).

```tsx
const { translate } = useI18n()

<h1>{translate('Welcome back, {name}!', { name })}</h1>
<p>{translate({ one: 'You have {count} message', other: 'You have {count} messages' }, { count })}</p>
<span>{translate({ text: 'Open', context: 'ticket status' })}</span>
<p>{translate('Read the <link>terms</link>.', { link: <a href="/terms" /> })}</p>
```

```sh
npx textlate translate    # finds the text above, translates only what's new, writes src/locales/*.json
```

## Why textlate?

- **No keys.** You never invent `home.hero.title`, keep a key file in sync, or look up what a key says. The text in your code is the message, and the language you write in needs no file at all.
- **Context where text is ambiguous.** "Open" on a button and "Open" as a ticket status are different words in most languages. `{ text: 'Open', context: 'ticket status' }` keeps them apart, and tells the translator (or the AI) what the text means.
- **AI translation that doesn't waste tokens.** `textlate translate` sends only text that isn't translated yet, saves after every batch, and checks every answer: placeholders, tags and plural forms must match the source. Use Claude, OpenAI, Gemini, any OpenAI-compatible API (OpenRouter, Groq, Mistral, a local Ollama), or your own function.
- **One function.** `translate` returns a string, or React nodes when you pass elements. The types know which, and they read params and tags from the text: `translate('Welcome back, {name}!')` without `name` fails the build.
- **Small and fast.** No plugins, no runtime dependencies, no build step, no message compiler. Built on `Intl`, `useSyncExternalStore`, React 19 `use()` and Server Components.

## Features

- **Source text as messages**, with plurals and context written in place, and `msg()` for text chosen at runtime.
- **AI translation CLI**: `extract`, `translate` and `check` (a gate for CI before you deploy). The first run asks which provider, model and key to use, and saves them.
- **Type-safe** params, plural `count` and rich-text tags, read from the text itself.
- **Small**: about 3 kB for the core and 0.5 kB for the React bindings (minified and brotli-compressed). No dependencies.
- **Fast**: each message resolves once per locale and is then served from a memo. Plain text is never parsed, and components re-render only when the locale changes.
- **Plurals** use `Intl.PluralRules`, so `zero`/`one`/`two`/`few`/`many`/`other` work in every language.
- **Formatting** of numbers, dates, relative times, lists and language names uses `Intl` for the locale.
- **Rich text** like `Read the <link>terms</link>` renders to React elements. There's no `dangerouslySetInnerHTML`.
- **Lazy locales**: `() => import('./locales/bn.json')` is code-split, and the current language stays on screen while the new one loads.
- **Fallbacks**: `bn-BD`, then `bn`, then the text in your code.
- **Detection** from the browser, `localStorage`, a cookie, the query string or `<html lang>`, with the user's choice remembered.
- **RTL**: every scope knows its `dir`, and `<html lang dir>` is kept in sync for you.

## Comparison

Each library translated the same three messages into Spanish with the same tooling, and each produced identical output. Reproduce with [`bench/compare`](bench/compare): `npm i && npm run size && npm run speed`.

| | textlate 1 | react-i18next 17 + i18next 26 | react-intl 12 | next-intl 4 | Lingui 6 |
|---|---|---|---|---|---|
| **Bundle**: provider, hook and rich text (min + brotli) | **3.2 kB** | 18.2 kB | 12.5 kB | 10.1 kB | 3.4 kB¹ |
| **Direct dependencies** | **0** | 3 | 3 | 10 | 3 |
| **Plain text** (ops/sec) | **16 M** | 0.28 M | 1.2 M | 3.2 M | – |
| **With a param** | **7.7 M** | 0.28 M | 0.86 M | 0.29 M | – |
| **Plural** | **8.7 M** | 0.14 M | 0.26 M | 0.15 M | – |
| Messages written in the code, no keys | ✓ | via config | via `defaultMessage` | – | ✓¹ |
| AI translation built in | ✓ | via other tools | via other tools | via other tools | via other tools |
| Server Components | ✓ | ✓ | ✓ | ✓ | ✓ |
| Works without a build step | ✓ | ✓ | ✓ | ✓ | –¹ |
| Full ICU MessageFormat (`select`, ordinals) | – | via plugin | ✓ | ✓ | ✓ |

<sub>Measured with Node 24, size-limit 14 and tinybench 6. Speed is a single-thread microbenchmark, so absolute numbers vary by machine but the ratios are stable. ¹Lingui compiles messages at build time with its CLI or a macro, which keeps its runtime small; it was left out of the speed test because it needs that compile step. Dependencies are the direct dependencies of the packages you install, not counting each other or peers.</sub>

### When to choose something else

textlate covers what most React and Next.js apps need, but not everything:

- **You need full ICU MessageFormat** (`select` for gender, `selectordinal`, nested plurals) → react-intl, next-intl or Lingui.
- **You rely on the i18next ecosystem** (backend plugins, Locize, frameworks other than React) → i18next.
- **You want locale-aware routing helpers** (localized pathnames, navigation APIs) built into the i18n library → next-intl. With textlate you write a short `proxy.ts` yourself; see [Next.js](#nextjs-app-router).

## Install

```sh
npm i textlate
```

Requires React 19+. The package ships ES modules only. The CLI needs Node 20 or later.

## Quick start

**1. Create an instance.** List the locales you translate into. The language your code is written in (English by default) needs no file.

```ts
// src/i18n.ts
import { createI18n, navigatorDetector, storageDetector } from 'textlate'

export const i18n = createI18n({
	locales: {
		es: () => import('./locales/es.json'), // loaded on demand
		bn: () => import('./locales/bn.json')
	},
	detectors: [storageDetector(), navigatorDetector()] // saved choice first, then the browser
})

// Gives useI18n() your locales.
declare module 'textlate' {
	interface Register {
		i18n: typeof i18n
	}
}
```

**2. Provide it.**

```tsx
import { I18nProvider } from 'textlate/react'
import { Suspense } from 'react'
import { i18n } from './i18n'

createRoot(root).render(
	<Suspense fallback={null}>
		<I18nProvider i18n={i18n}>
			<App />
		</I18nProvider>
	</Suspense>
)
```

**3. Write your text.**

```tsx
import { useI18n } from 'textlate/react'

const Inbox = ({ name, count }: { name: string; count: number }) => {
	const { translate } = useI18n()
	return (
		<>
			<h1>{translate('Hello, {name}!', { name })}</h1>
			<p>{translate({ zero: 'No messages', one: 'You have {count} message', other: 'You have {count} messages' }, { count })}</p>
			<p>{translate('Read the <link>terms</link> and <b>agree</b>.', { link: <a href="/terms" />, b: chunks => <strong>{chunks}</strong> })}</p>
		</>
	)
}

const LanguagePicker = () => {
	const { locale, locales, setLocale, isPending, format } = useI18n()
	return (
		<select value={locale} disabled={isPending} onChange={event => setLocale(event.target.value)}>
			{locales.map(code => <option key={code} value={code}>{format.displayName(code, { type: 'language' })}</option>)}
		</select>
	)
}
```

The app already works in English. Until a text is translated, other locales show it in English.

**4. Translate.**

```sh
export ANTHROPIC_API_KEY=...   # or put it in .env.local
npx textlate translate --locales es,bn
```

This creates `src/locales/es.json` and `src/locales/bn.json` and translates every message. Run it again whenever you change text. Only new and changed text is sent to the AI.

## Writing messages

| Feature | In your code | In Spanish |
|---|---|---|
| Text | `translate('Welcome')` | `Bienvenido` |
| Params | `translate('Hello, {name}!', { name: 'Ada' })` | `¡Hola, Ada!` |
| Numbers, dates | `translate('Total: {amount}', { amount: 1234.5 })` | `Total: 1234,5` |
| Plurals | `translate({ one: '{count} file', other: '{count} files' }, { count: 2 })` | `2 archivos` |
| Context | `translate({ text: 'Open', context: 'ticket status' })` | `Abierto` (and `Abrir` on a button) |
| Rich text | `translate('Read the <link>terms</link>', { link: <a href="/terms" /> })` | `Lee los <a href="/terms">términos</a>` |
| Self-closing tags | `translate('One<br/>Two', { br: <br /> })` | `Uno<br/>Dos` |
| Nodes as values | `translate('Hello, {name}!', { name: <b>Ada</b> })` | `¡Hola, <b>Ada</b>!` |
| Text chosen at runtime | `const labels = { active: msg('Active') }` … `translate(labels[status])` | `Activo` |

- **Params** are written `{name}`, with single braces. Numbers, bigints and dates are formatted for the locale.
- **Plurals** are an object of plural categories: `zero`, `one`, `two`, `few`, `many` and `other`, with `other` required. The CLI asks each language for the forms it needs, for example `one`, `few`, `many` and `other` in Polish. `zero` is used for `0` whenever it is present, even in languages whose plural rules never select it, such as English.
- **Context** tells apart the same text with different meanings, and is a hint for the translator: `{ text, context }`, or plural forms with a `context`. Use it for short, ambiguous text like "Open", "Post" or "Save". Text without context and text with different contexts are translated separately.
- **Tags** render with an element, which is cloned with the chunks as its children, or with a function `chunks => ReactNode`. When you pass an element or a function, `translate` returns React nodes; otherwise it returns a string, with tags stripped and their text kept.
- **`msg()`** marks a message that is picked at runtime, so the CLI finds it. It returns the message unchanged. Text built from parts, such as `translate('Hello ' + name)`, can't be translated, and the CLI warns about it: write `translate('Hello {name}', { name })` instead.
- **Types**: params and tags come from the text. A missing or misspelled param, a plural without `count`, or a tag without a renderer is a type error.

## Translating with AI

The `textlate` command keeps the translation files in sync with your code.

| Command | What it does |
|---|---|
| `textlate extract` | Finds the messages in your code and updates `src/locales/<locale>.json`: new text is added untranslated (`""`), text no longer in the code is removed, and translations are kept |
| `textlate translate` | Runs `extract`, then translates every untranslated message with AI |
| `textlate check` | Writes nothing. Fails if a file is out of date, untranslated or invalid. Use it in CI |
| `textlate setup` | Asks which AI to translate with, and saves the answers |

```jsonc
// package.json
"scripts": {
	"i18n": "textlate translate",
	"prebuild": "textlate translate"
}
```

With `prebuild`, every `npm run build` (and so every deploy) translates new text first. If your build environment has no API key, run `npm run i18n` yourself, commit the translation files, and use `textlate check` in CI instead, so nothing ships untranslated.

### What a run reports

Every command starts by counting: the languages, the messages found in your code, the translations already in place, and what is missing. Nothing is sent or written before you can see that.

```
$ npx textlate check

  textlate check

  Source    en  English
  Locales   4   es, bn, ar, ja
  Messages  42  in 18 files
  Files     src/locales/<locale>.json
  Config    textlate.config.js

  Catalogs

  ╭────────┬───────────┬──────────────┬─────────┬─────┬────────┬─────────╮
  │ Locale │ Language  │   Translated │ Missing │ New │ Unused │ Invalid │
  ├────────┼───────────┼──────────────┼─────────┼─────┼────────┼─────────┤
  │ es     │ Spanish   │   40/42  95% │       2 │  +2 │      – │       1 │
  │ bn     │ Bangla    │  42/42  100% │       – │   – │      – │       – │
  │ ar     │ Arabic    │  42/42  100% │       – │   – │     -1 │       – │
  │ ja     │ Japanese  │   38/42  90% │       4 │  +2 │      – │       – │
  ├────────┼───────────┼──────────────┼─────────┼─────┼────────┼─────────┤
  │ Total  │ 4 locales │ 162/168  96% │       6 │  +4 │     -1 │       1 │
  ╰────────┴───────────┴──────────────┴─────────┴─────┴────────┴─────────╯

  ✖ src/locales/es.json  2 untranslated (run textlate translate) · 1 invalid translation
      "Welcome, {firstName}!" is missing {firstName}
  ✔ src/locales/bn.json  up to date
  ✖ src/locales/ar.json  out of date (run textlate extract)
  ✖ src/locales/ja.json  4 untranslated (run textlate translate)

  ✖ 3 of 4 locales need attention.
```

- **Translated** is how many of the messages in your code that file has, **Missing** how many are still untranslated, **New** the messages this run adds to the file (`check` writes nothing, so there they are the ones `extract` would add) and **Unused** the entries it drops. **Invalid** counts translations whose `{params}`, `<tags>` or plural forms don't match the source; each one is listed under the file. A column is left out when it has nothing to report.
- **`translate` prints the table twice**: once before it calls the AI, and once after, with a progress bar in between. `--dry-run` stops after the first one.
- **Plain text when it isn't a terminal**, so logs and CI stay readable. `--no-color` or `NO_COLOR` turns the colours off, `NO_UNICODE` draws the tables in ASCII.

### The first run

`translate` needs a model and an API key. When it has neither from the config nor the environment, it asks once, instead of stopping with an error:

```
$ npx textlate translate

  textlate translate
  …
  › No API key to translate with yet. Setting that up once:

  Which AI should translate your messages?
    1) Anthropic (Claude)  [default]
    2) OpenAI (GPT)
    3) Google (Gemini)
    4) OpenAI-compatible API (OpenRouter, Groq, Mistral, DeepSeek, a local Ollama)
  > 1
  Which model?
    1) claude-opus-5-5 (most capable)  [default]
    2) claude-sonnet-5-5 (balanced)
    3) claude-haiku-4-5-20251001 (fastest and cheapest)
    4) Another model
  > 1
  Instructions for the translator: A banking app for small businesses. Formal tone.
  ANTHROPIC_API_KEY: ********************
  Saved the AI settings to textlate.config.js.
  Save ANTHROPIC_API_KEY to .env? [Y/n] y
  Saved ANTHROPIC_API_KEY to .env.

  › Translating 42 messages into 1 locale with claude-opus-5-5…
  ████████░░  34/42  es 34/42

  ✔ Translated 42 messages. Every locale is complete.
```

- **The provider, model and instructions go to `textlate.config.js`**, next to whatever is already in it. A config file is created when the project has none.
- **The key goes to `.env.local`, or `.env`** when there is no `.env.local`, and only if you say yes: it is never written to the config file. Say no and the key is used for that run only. If git doesn't ignore the file yet, the CLI says so.
- **Only what's missing is asked for.** With `ANTHROPIC_API_KEY` already in your environment, nothing is asked at all. Run `textlate setup` yourself to change the provider, the model or the key later.
- **Nothing is ever asked without a terminal**, so CI and scripts fail with the setting to add instead of hanging. `--no-input` does the same on a terminal.

### Config

Settings live in `textlate.config.js` (or `.mjs`, `.json`, or `.ts` on Node 22.18+) next to `package.json`. Everything is optional:

```js
// textlate.config.js
import { defineConfig } from 'textlate/config'

export default defineConfig({
	sourceLocale: 'en', // the language of the text in your code (default 'en')
	locales: ['es', 'bn', 'ar'], // default: every <locale>.json in `dir`
	dir: 'src/locales', // default
	include: ['src'], // where to look for messages (default)
	ai: {
		provider: 'anthropic', // default; or 'openai', 'google'
		model: 'claude-opus-5-5', // default for anthropic
		instructions: 'A banking app for small businesses. Use a formal tone. Keep "Pocket" untranslated.'
	}
})
```

| Option | Default | |
|---|---|---|
| `sourceLocale` | `'en'` | The language the text in your code is written in |
| `locales` | each `<locale>.json` in `dir` | The locales to translate into |
| `dir` | `'src/locales'` | Where the `<locale>.json` files live |
| `include` | `['src']` | Files and directories to scan. `node_modules`, build output and dot-directories are skipped. Scans `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.vue`, `.svelte` and `.astro` files |
| `functions` | `['translate', 'msg']` | Functions whose first argument is a message |
| `keepUnused` | `false` | Keep translations of text that is no longer in the code |
| `ai.provider` | `'anthropic'` | `'anthropic'`, `'openai'` (and OpenAI-compatible APIs) or `'google'` (Gemini) |
| `ai.model` | `'claude-opus-5-5'` for Anthropic | Required for the other providers |
| `ai.apiKey` | from the environment | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`, also read from `.env` and `.env.local`. Prefer these to a key in a file you commit |
| `ai.baseUrl` | the provider's | For example `'https://openrouter.ai/api/v1'`, or `'http://localhost:11434/v1'` for Ollama (no key needed) |
| `ai.instructions` | none | What the product is, the tone, and terms to keep or translate a certain way |
| `ai.batchSize` | `40` | Messages per request |
| `ai.concurrency` | `4` | Locales translated at the same time |
| `ai.body` | none | Extra request fields, e.g. `{ temperature: 0 }` or `{ output_config: { effort: 'low' } }` |
| `ai.translate` | none | Your own function, for any other SDK or service. It receives the messages by id (with their context), the locale, its plural categories and the prompt, and returns translations by id |

Command-line flags override the config: `--locales es,bn`, `--dir`, `--source`, `--provider`, `--model`, `--keep-unused`, `--config <file>`, `--dry-run` (shows what `translate` would send, without calling the AI or writing files), `--no-input` (never ask questions) and `--no-color` (plain output). Paths after the command replace `include`: `textlate translate app components`.

### How translation works

- **Only untranslated text is sent.** A message is untranslated when its value is `""`, or a plural form is empty. Everything else, including translations you edited by hand, is left alone. Changing a text in your code makes it a new message, so it is translated again.
- **Context goes along.** The model is told what each message's context means, so "Open" as a status and "Open" on a button get different words.
- **Progress is saved after every batch.** If a run stops halfway, the next run continues where it left off.
- **Every answer is checked.** A translation must not be empty, must keep the source's `{params}` and `<tags>`, and a plural must have every form the language needs. An invalid translation is sent once more, then reported and left untranslated.
- **Answers are structured.** With Anthropic, the request uses structured outputs, so the model can only answer in the expected JSON shape. The default model also uses server-side refusal fallbacks (`fallbacks: "default"`): if a safety classifier declines a batch, the API retries it on another model instead of failing.
- **Errors are handled.** Rate limits, overload and network errors are retried with backoff, honouring `retry-after`. A batch cut off at the output limit is split in two.
- **`check` and `extract` validate hand-written translations too**, and list any whose params, tags or plural forms don't match the source.

### Translation files

A translation file maps each message to its translation, in the order the messages appear in your code:

```json
{
  "Welcome, {firstName}!": "¡Bienvenido, {firstName}!",
  "{count} files": { "one": "{count} archivo", "many": "{count} de archivos", "other": "{count} archivos" },
  "Open": "Abrir",
  "Open // ticket status": "Abierto",
  "New text": ""
}
```

A plural is stored under its `other` text, and a message with context under `text // context`. An empty string (or empty plural form) means "not translated yet": the text in your code is shown instead. You can translate by hand, with AI, or both.

## Switching and loading locales

```ts
await i18n.setLocale('bn')        // or ['bn-BD', 'en']: the best match wins
i18n.match('pt-BR')               // 'pt', if that's what you registered
const { translate, format, dir } = await i18n.load('ar')   // load without switching
```

- When the target locale is lazy, the current locale stays on screen while it loads. `useI18n().isPending` and `pendingLocale` tell you a switch is in progress.
- If several calls overlap, the last one wins. Each locale loads only once.
- If the initial locale is lazy, `<I18nProvider>` suspends until it's ready, so wrap it in `<Suspense>`.
- Load errors reject `setLocale` and go to your error boundary on first render.

## Formatting

```tsx
const { format } = useI18n() // or (await i18n.load('bn')).format
format.number(0.25, { style: 'percent' })              // 25%
format.date(new Date(), { dateStyle: 'long' })         // October 2, 2026
format.relativeTime(-1, 'day', { numeric: 'auto' })    // yesterday
format.list(['a', 'b', 'c'])                           // a, b, and c
format.displayName('bn', { type: 'language' })         // Bangla
```

`Intl` instances are cached per locale and options.

## Detection

`detectors` are tried in order, and the first registered match wins. They run **after hydration**, so server and client markup always agree. Detectors with storage (`storageDetector`, `cookieDetector`) also remember every `setLocale` call. A detected locale isn't saved, so a later change of browser language still takes effect.

| Detector | Reads |
|---|---|
| `navigatorDetector()` | `navigator.languages` |
| `storageDetector(key = 'locale')` | `localStorage` (or any `Storage`) |
| `cookieDetector(name = 'locale', { maxAge, path, sameSite, secure })` | `document.cookie`, which a server can read too. `secure` defaults to `true` with `sameSite: 'none'` |
| `queryDetector(param = 'lang')` | `?lang=bn` |
| `htmlLangDetector()` | `<html lang>` |
| `{ detect, persist? }` | anything you like |

In a client-only app, call `await i18n.detect()` before the first render to skip the source-locale frame.

## Next.js (App Router)

A complete, working example is in [`examples/nextjs`](examples/nextjs): locale-prefixed routes, a proxy, Server and Client Components, static generation, and `npm run i18n`.

```ts
// src/i18n.ts: used by Server Components, Client Components and the proxy
export const i18n = createI18n({
	locales: { bn: () => import('./locales/bn.json'), ar: () => import('./locales/ar.json') }
})
// Your language switcher calls `localeCookie.persist?.(locale)`; the proxy reads it on the next visit to `/`.
export const localeCookie = cookieDetector('NEXT_LOCALE')
declare module 'textlate' {
	interface Register { i18n: typeof i18n }
}
```

```ts
// src/proxy.ts (middleware.ts before Next 16): send `/` to the best locale
import { negotiateLocale } from 'textlate'
import { NextResponse, type NextRequest } from 'next/server'
import { i18n } from './i18n'

export const proxy = (request: NextRequest) => {
	const { pathname } = request.nextUrl
	if (i18n.locales.some(locale => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`))) return
	const locale = i18n.match(request.cookies.get('NEXT_LOCALE')?.value)
		?? negotiateLocale(request.headers.get('accept-language'), i18n.locales, i18n.sourceLocale)
	request.nextUrl.pathname = `/${locale}${pathname}`
	return NextResponse.redirect(request.nextUrl)
}

export const config = { matcher: ['/((?!_next|api|.*\\..*).*)'] }
```

```tsx
// src/app/[lang]/providers.tsx: the instance can't cross the server/client boundary, so import it here
'use client'
import { I18nProvider } from 'textlate/react'
import { i18n } from '@/i18n'

export const Providers = ({ locale, children }: { locale: string; children: React.ReactNode }) => (
	<I18nProvider i18n={i18n} locale={locale}>{children}</I18nProvider>
)
```

```tsx
// src/app/[lang]/layout.tsx
import { notFound } from 'next/navigation'
import { i18n } from '@/i18n'
import { Providers } from './providers'

export const generateStaticParams = () => i18n.locales.map(lang => ({ lang }))

export const generateMetadata = async ({ params }: { params: Promise<{ lang: string }> }) => {
	const { translate } = await i18n.load((await params).lang)
	return { title: translate('My store') }
}

const RootLayout = async ({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) => {
	const { lang } = await params
	if (i18n.match(lang) !== lang) notFound()
	return (
		<html lang={lang} dir={i18n.scope(lang).dir}>
			<body><Providers locale={lang}>{children}</Providers></body>
		</html>
	)
}
export default RootLayout
```

```tsx
// src/app/[lang]/page.tsx: Server Component
const Page = async ({ params }: { params: Promise<{ lang: string }> }) => {
	const { translate, format } = await i18n.load((await params).lang)
	return (
		<>
			<h1>{translate('Welcome to <b>our store</b>', { b: <strong /> })}</h1>
			<p>{format.date(new Date(), { dateStyle: 'long' })}</p>
		</>
	)
}
export default Page
```

How it fits together:
- **`textlate`** is server-safe and imports no client hooks, so you can use it in Server Components, `generateMetadata`, route handlers and the proxy.
- **`textlate/react`** is marked `'use client'`.
- **`await i18n.load(locale)`** loads a locale and returns its `{ translate, format, dir, locale }` without touching any shared state. Concurrent requests can't leak into each other.
- **`<I18nProvider locale>`** gives its subtree a private copy of the instance pinned to that locale, while loaded translations stay shared. To change the language in Client Components, navigate to the other locale's URL.
- **To avoid a client fetch for translations**, pass them from the server: `<I18nProvider locale={lang} translations={{ [lang]: translations }}>`.

## API

### `textlate`

| Export | Description |
|---|---|
| `createI18n(config)` | Creates an instance. Config: `locales`, `sourceLocale?` (default `'en'`), `locale?`, `fallbacks?` (e.g. `{ 'pt-BR': ['pt-PT'] }`), `detectors?`, `onUntranslated?` |
| `msg(message)` | Marks a message chosen at runtime for the CLI, and returns it unchanged |
| `negotiateLocale(acceptLanguage, locales, fallback)` | Best locale for an `Accept-Language` header |
| `matchLocale(requested, locales)` | BCP 47 lookup: exact, then shorter tags, then same language |
| `parseAcceptLanguage(header)` | Locales ordered by `q` |
| `getDirection(locale)` | `'ltr'` or `'rtl'` |
| detectors | `navigatorDetector`, `storageDetector`, `cookieDetector`, `queryDetector`, `htmlLangDetector` |

**Scope** (one per locale): `{ locale, dir, translate, format }`. `translate` and `format` are stable per locale, so they are safe in dependency arrays.

**Instance:** the scope of the active locale (`translate`, `format`, `locale`, `dir`), plus `sourceLocale`, `locales`, `isReady`, `ready`, `setLocale()`, `detect()`, `match()`, `load(locale?)` (a scope, once loaded), `scope(locale)` (a scope, as far as it is loaded), `addTranslations()`, `getTranslations()`, `clone()`, `subscribe()`, `getSnapshot()`.

**`onUntranslated({ text, context, locale })`** is called once per message and locale that isn't translated yet. Return a string to show instead of the source text, or use it to log untranslated text.

### `textlate/react`

| Export | Description |
|---|---|
| `<I18nProvider i18n locale? translations? detect? syncDocument?>` | Provides an instance. With `locale`, the subtree is pinned to that locale. `detect` and `syncDocument` default to `true` |
| `useI18n()` | `{ translate, format, locale, dir, locales, sourceLocale, setLocale, isPending, pendingLocale, i18n }` for the active locale |

### `textlate/config` and the CLI

`defineConfig(config)` type-checks `textlate.config.js`. The `textlate` command (`extract`, `translate`, `check`, `setup`) is described in [Translating with AI](#translating-with-ai); `npx textlate --help` lists every option.

## Performance

`npm run bench` on Node 24, translating into Spanish (ops/sec; higher is better):

| Call | ops/sec |
|---|---|
| `translate('Plain text')` | ~15 M |
| `translate({ text: 'Open', context: 'ticket status' })` | ~13 M |
| `translate('Hello, {name}!', { name })` | ~10 M |
| `translate('Total: {amount}', { amount: 1234.5 })` (number formatting) | ~9 M |
| untranslated, shown in the source language | ~9 M |
| fallback `es-MX → es` | ~8 M |
| `translate({ one, other }, { count })` (plural) | ~7 M |
| plural with a count never seen before | ~0.7 M |
| rich text with two elements | ~290 k |

Why it's fast:
- Each message walks the fallback chain once per locale and is then a single `Map` lookup, keyed by the text itself. The memo is cleared only when translations change.
- Text without `{` or `<` is returned as-is, never parsed or copied. Parsed trees are shared across locales.
- `Intl` calls cost hundreds of nanoseconds, so interpolated numbers and plural categories are remembered per locale. Counts repeat, so most plural calls skip `Intl` entirely.
- Memory stays bounded on a long-running server, even when text, locales, options or numbers come from user input: every cache is capped.
- The store lives outside React and is read with `useSyncExternalStore`. The context value never changes, so components re-render only when the locale does, not when a parent re-renders.

## Contributing

You are welcome to contribute! If you are adding a feature or fixing a bug, please contribute to the [GitHub repository](https://github.com/SheikhAminul/textlate/).

```sh
npm install
npm test           # unit, React, SSR, hydration and CLI tests
npm run typecheck  # includes type-level tests
npm run bench
```

## License

textlate is licensed under the [MIT license](https://github.com/SheikhAminul/textlate/blob/main/LICENSE).
