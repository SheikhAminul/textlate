# Changelog

## 3.0.0

textlate 3 is built for large apps: tens of thousands of messages, dozens of languages, and people reviewing what AI wrote. Apps with one file per locale keep working as they are.

### Runtime

- **Namespaces.** Give `createI18n` a list of `locales`, a `loader(locale, namespace)` and the `namespaces` to load everywhere. `load(locale, { namespaces })` loads more; `getMessages(locale, namespaces)` and `addMessages(messages)` hand the server's translations to the browser; a locale switch loads every namespace in use.
- **Catalogs of any size stay fast.** Only untranslated text counts towards the per-locale memo's limit, and parsed messages are cached for a large app. A 20,000-message catalog read in random order went from about 0.4 to 2.6 million translations a second.
- **Time zones.** `timeZone` on `createI18n`, on `load` and `scope`, on `clone` and on `<I18nProvider>`, for the dates in messages and `format.date`, so the server and the browser render the same dates. Scopes have a `timeZone`.
- **React.** `<I18nProvider messages timeZone namespaces>`, and `useNamespaces(namespaces)` to load a namespace where a component needs it.
- **Subscribers re-render when lazily loaded translations arrive**, not only when loaded ones are replaced.

### CLI

- **Namespaces** in the config: `namespaces: { app: { include: ['app'] }, catalog: { include: ['packages/catalog'], properties: ['label'] } }` writes `<dir>/<locale>/<namespace>.json`. A message used in two namespaces is in both files, and translated once.
- **Text in data**: `properties: ['label', 'description']` extracts the string values of those object properties. `exclude` leaves files and directories out.
- **Review workflow**: each translation is AI-made, reviewed or changed, kept in `<dir>/.textlate/<locale>.json`. A person's edit counts as reviewed; `textlate accept` marks AI translations reviewed; `reviewed: ['de']` makes `textlate check` fail until they are.
- **Changed text keeps its translation**: when a message's text changes, an alike old text's translation stands in, and `textlate translate` updates it with the old text and translation as reference (`carryOver: false` turns it off).
- **Glossary**: terms to keep (checked), explain or translate a set way per locale.
- **Faster, cheaper translation**: one pool of requests across every locale (`ai.concurrency`, 8 by default), and Claude's system prompt cached for every batch after the first.
- **Atomic writes**: every file is written beside itself, then renamed into place, so a run that stops halfway leaves no half-written file.
- New flags `--properties` and `--reviewed`; new command `accept`.

### Guards

- `textlate/pseudo`: a pseudo-locale (`pseudoLocale('en-XA')`) that shows untranslated text accented, longer and in brackets.
- `textlate/eslint`: an ESLint plugin whose `no-untranslated-text` rule reports text written plainly in JSX and in attributes people read.

### Upgrading from 1.x

- **`ai.concurrency` now counts requests, not locales.** It was the number of locales translated at the same time (4); it's now the number of requests in flight across every locale (8). Lower it if your provider's rate limit is tight.
- **Commit `<dir>/.textlate/`.** `extract` and `translate` now keep each translation's state there. Translations from before count as AI-made: if you require reviews (`reviewed`), run `textlate accept` for the locales already reviewed.
- **Claude requests send the system prompt as a cached block** (`system: [{ type: 'text', text, cache_control }]`). An Anthropic-compatible proxy behind `ai.baseUrl` must accept that form, as the Claude API does.
- **Types**: `Scope` has `timeZone`; `I18n` has `namespaces`, `isLoaded`, `getMessages` and `addMessages`; `load` and `scope` take options; `I18nConfig` takes a list of locales as well as an object. Code that only uses textlate is unaffected; code that implements these interfaces itself needs the new members.
