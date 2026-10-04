/// <reference types="node" />

export interface Choice<T> {
	value: T
	label: string
	/** Shown after the label, in parentheses. */
	hint?: string | undefined
}

/** Questions the command line can ask. Supply your own in `RunOptions.prompt` to drive setup from code or a test. */
export interface Prompter {
	/** Pick one of `choices`, by number or by name. `fallback` is the value an empty answer gives. */
	select: <T>(question: string, choices: readonly Choice<T>[], fallback?: T) => Promise<T>
	/** Free text, trimmed. An empty answer returns `fallback` (`''` when there is none). */
	text: (question: string, fallback?: string) => Promise<string>
	/** Free text for a secret: it shows as stars and is never echoed. */
	secret: (question: string) => Promise<string>
	/** Yes or no. An empty answer returns `fallback`. */
	confirm: (question: string, fallback?: boolean) => Promise<boolean>
	/** Let go of the input, so the process can exit. Safe to call more than once. */
	close: () => void
}

/** Thrown when the user ends the input (Ctrl-C or Ctrl-D) instead of answering. */
export class Cancelled extends Error {
	constructor() {
		super('Cancelled.')
	}
}

type Input = NodeJS.ReadableStream & { isTTY?: boolean | undefined; setRawMode?: ((raw: boolean) => void) | undefined }

export interface PrompterStreams {
	input?: Input
	output?: NodeJS.WritableStream
	/** Put in front of every line, so questions line up with the rest of the output. Default none. */
	indent?: string
}

/** Whether questions can be asked: a terminal on both ends, and not a CI run. */
export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI)

const ENTER = ['\r', '\n']
const DELETE = ['\u007f', '\b']
const END = ['\u0003', '\u0004']

/**
 * A `Prompter` on the terminal. Numbers pick from a list and a secret shows as stars. The input is read a key at a
 * time on a terminal (so nothing is echoed that shouldn't be), and line by line without one.
 */
export const createPrompter = (streams: PrompterStreams = {}): Prompter => {
	const input = streams.input ?? process.stdin
	const output = streams.output ?? process.stdout
	const indent = streams.indent ?? ''
	// Only a terminal can hide what is typed; a pipe echoes nothing in the first place.
	const keys = Boolean(input.isTTY && typeof input.setRawMode === 'function')

	let attached = false
	let cancelled = false
	/** Lines typed before they were asked for. */
	const ahead: string[] = []
	let typed = ''
	let waiting: { resolve: (line: string) => void; reject: (error: Error) => void; mask: boolean } | undefined

	const stop = (error: Error) => {
		cancelled = true
		const pending = waiting
		waiting = undefined
		detach()
		pending?.reject(error)
	}

	const finishLine = () => {
		const line = typed
		typed = ''
		const pending = waiting
		waiting = undefined
		if (pending) pending.resolve(line)
		else ahead.push(line)
	}

	const onData = (chunk: Buffer | string) => {
		const text = String(chunk)
		// An escape sequence (an arrow or function key) is not input.
		if (keys && text.startsWith('\u001b')) return
		for (const character of text) {
			if (ENTER.includes(character)) {
				if (keys) output.write('\n')
				finishLine()
			} else if (keys && END.includes(character)) {
				return stop(new Cancelled())
			} else if (DELETE.includes(character)) {
				if (typed) {
					typed = typed.slice(0, -1)
					if (keys) output.write('\b \b')
				}
			} else if (character >= ' ') {
				typed += character
				if (keys) output.write(waiting?.mask ? '*' : character)
			}
		}
	}

	const onEnd = () => stop(new Cancelled())

	function detach() {
		if (!attached) return
		attached = false
		input.off('data', onData)
		input.off('end', onEnd)
		input.off('close', onEnd)
		if (keys) input.setRawMode!(false)
		input.pause()
	}

	const attach = () => {
		if (attached) return
		attached = true
		if (keys) input.setRawMode!(true)
		if (typeof (input as { setEncoding?: unknown }).setEncoding === 'function') (input as NodeJS.ReadStream).setEncoding('utf8')
		input.on('data', onData)
		input.on('end', onEnd)
		input.on('close', onEnd)
		input.resume()
	}

	const line = (query: string, mask = false): Promise<string> => {
		if (cancelled) return Promise.reject(new Cancelled())
		attach()
		output.write(indent + query)
		// A line typed ahead of its question was echoed as it was typed.
		const ready = ahead.shift()
		if (ready !== undefined) return Promise.resolve(ready)
		return new Promise((resolve, reject) => {
			waiting = { resolve, reject, mask }
		})
	}

	return {
		select: async (question, choices, fallback) => {
			const preset = choices.find(choice => choice.value === fallback) ?? choices[0]!
			const options = choices.map((choice, index) => `${indent}  ${index + 1}) ${choice.label}${choice.hint ? ` (${choice.hint})` : ''}${choice === preset ? '  [default]' : ''}`)
			output.write(`${indent}${question}\n${options.join('\n')}\n`)
			for (;;) {
				const answer = (await line('> ')).trim()
				if (!answer) return preset.value
				const index = Number(answer)
				if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1]!.value
				const named = choices.find(choice => choice.label.toLowerCase().startsWith(answer.toLowerCase()) || String(choice.value).toLowerCase() === answer.toLowerCase())
				if (named) return named.value
				output.write(`${indent}  Answer with a number from 1 to ${choices.length}.\n`)
			}
		},
		text: async (question, fallback = '') => {
			const answer = (await line(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim()
			return answer || fallback
		},
		secret: async question => (await line(`${question}: `, true)).trim(),
		confirm: async (question, fallback = true) => {
			for (;;) {
				const answer = (await line(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
				if (!answer) return fallback
				if (['y', 'yes'].includes(answer)) return true
				if (['n', 'no'].includes(answer)) return false
			}
		},
		close: detach
	}
}
