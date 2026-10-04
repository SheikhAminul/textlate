/// <reference types="node" />
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AIConfig } from '../config.js'
import { API_KEYS, DEFAULT_MODEL } from './ai.js'
import { envFile, saveAISettings, saveEnvKey } from './edit.js'
import type { Prompter } from './prompt.js'

type Provider = NonNullable<AIConfig['provider']>

const PROVIDERS: { value: Provider | 'compatible'; label: string; hint: string }[] = [
	{ value: 'anthropic', label: 'Anthropic', hint: 'Claude' },
	{ value: 'openai', label: 'OpenAI', hint: 'GPT' },
	{ value: 'google', label: 'Google', hint: 'Gemini' },
	{ value: 'compatible', label: 'OpenAI-compatible API', hint: 'OpenRouter, Groq, Mistral, DeepSeek, a local Ollama' }
]

const ANTHROPIC_MODELS = [
	{ value: DEFAULT_MODEL, label: DEFAULT_MODEL, hint: 'most capable' },
	{ value: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', hint: 'balanced' },
	{ value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001', hint: 'fastest and cheapest' },
	{ value: '', label: 'Another model' }
]

const KEY_PAGES: Record<Provider, string> = {
	anthropic: 'https://console.anthropic.com/settings/keys',
	openai: 'https://platform.openai.com/api-keys',
	google: 'https://aistudio.google.com/apikey'
}

/** The environment variable a provider's key is read from. */
export const keyName = (provider: Provider): string => API_KEYS[provider][0]!

/** The key to translate with, from the config or the environment. */
const resolveKey = (provider: Provider, ai: AIConfig, env: Readonly<Record<string, string | undefined>>) =>
	ai.apiKey ?? API_KEYS[provider].map(name => env[name]).find(Boolean)

/**
 * What `ai` still needs before it can translate, in words: whichever of the model and the API key has no default.
 * Empty when translation is ready to run.
 */
export const missingAISettings = (ai: AIConfig, env: Readonly<Record<string, string | undefined>>): string[] => {
	const provider = ai.provider ?? 'anthropic'
	if (ai.translate || !(provider in API_KEYS)) return []
	const missing: string[] = []
	if (!(ai.model ?? (provider === 'anthropic' ? DEFAULT_MODEL : undefined))) missing.push('model')
	// A custom base URL may be a local server (e.g. Ollama) that needs no key.
	if (!resolveKey(provider, ai, env) && !ai.baseUrl) missing.push('API key')
	return missing
}

/** How a run that can't ask questions gets the missing settings. */
export const setupHint = (cwd: string, ai: AIConfig, missing: readonly string[]): string => {
	const provider = ai.provider ?? 'anthropic'
	const fix = missing.includes('API key')
		? `set ${keyName(provider)} in the environment or ${envFile(cwd)}`
		: 'set ai.model in textlate.config.js'
	return `AI translation isn't set up: no ${missing.join(' and ')} for the ${provider} provider. Run "textlate setup" to configure it, or ${fix}.`
}

export interface SetupOptions {
	cwd: string
	/** The settings so far: the config file's `ai`, with any command-line flags on top. */
	ai: AIConfig
	/** The config file to write to, if the project has one. Otherwise one is created. */
	configFile?: string | undefined
	env: Readonly<Record<string, string | undefined>>
	prompt: Prompter
	log: (line: string) => void
}

/** Ask until there is an answer. */
const required = async (prompt: Prompter, question: string, fallback?: string): Promise<string> => {
	for (;;) {
		const answer = await prompt.text(question, fallback)
		if (answer) return answer
	}
}

/**
 * Ask which AI to translate with, write the provider, model, base URL and instructions to the config file, and
 * offer to save the API key to `.env`. Returns the settings to translate with now, including a key that was only
 * entered for this run.
 */
export const setupAI = async (options: SetupOptions): Promise<AIConfig> => {
	const { cwd, ai, configFile, env, prompt, log } = options

	const choice = await prompt.select('Which AI should translate your messages?', PROVIDERS, ai.baseUrl && ai.provider === 'openai' ? 'compatible' : (ai.provider ?? 'anthropic'))
	const provider: Provider = choice === 'compatible' ? 'openai' : choice
	const settings: Record<string, string> = { provider }

	if (choice === 'compatible') {
		log("The API's base URL, for example https://openrouter.ai/api/v1, or http://localhost:11434/v1 for Ollama.")
		settings.baseUrl = await required(prompt, 'Base URL', ai.baseUrl)
	}

	if (choice === 'anthropic') {
		const model = await prompt.select('Which model?', ANTHROPIC_MODELS, ai.model ?? DEFAULT_MODEL)
		settings.model = model || (await required(prompt, 'Model'))
	} else {
		settings.model = await required(prompt, 'Model', ai.model)
	}

	if (!ai.instructions) {
		log('What the app is, the tone to use, and terms to keep or translate a certain way. Optional, but it makes the translations fit.')
		const instructions = await prompt.text('Instructions for the translator')
		if (instructions) settings.instructions = instructions
	}

	const name = keyName(provider)
	const current = resolveKey(provider, ai, env)
	let apiKey: string | undefined
	if (!current || !(await prompt.confirm(`${name} is already set${ai.apiKey ? ' in the config' : ''}. Use it?`, true))) {
		if (!current) log(`Get a key at ${KEY_PAGES[provider]}. It is never written to the config file.`)
		const optional = Boolean(settings.baseUrl)
		apiKey = await prompt.secret(`${name}${optional ? ' (leave empty for a server that needs no key)' : ''}`)
		// Asked again as a secret, never as plain text, so the key stays off the screen.
		while (!apiKey && !optional) apiKey = await prompt.secret(`${name} is needed to translate`)
	}

	const saved = saveAISettings(cwd, configFile, settings)
	if (saved.snippet) log(`Could not edit ${saved.file}. Add this to the config object yourself:\n\n${saved.snippet}\n`)
	else log(`Saved the AI settings to ${saved.file}.`)

	if (apiKey) {
		if (await prompt.confirm(`Save ${name} to ${envFile(cwd)}?`, true)) {
			const written = saveEnvKey(cwd, name, apiKey)
			log(`Saved ${name} to ${written.file}.`)
			if (!written.ignored && existsSync(join(cwd, '.git'))) log(`${written.file} is not in .gitignore: add it, so the key never reaches the repository.`)
		} else {
			log(`Not saved. Set ${name} in your environment before the next run.`)
		}
	}

	return {
		...ai,
		provider,
		model: settings.model!,
		...(settings.baseUrl && { baseUrl: settings.baseUrl }),
		...(settings.instructions && { instructions: settings.instructions }),
		...(apiKey && { apiKey })
	}
}
