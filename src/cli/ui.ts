/// <reference types="node" />

const ANSI = /\u001B\[[\d;]*m/g
// Characters that take two terminal columns: CJK, Hangul, fullwidth forms and emoji.
const WIDE =
	/^(?:[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1F000}-\u{1FAFF}])$/u
// Combining marks and zero-width characters, which take none.
const ZERO = /^[̀-ͯ​-‏⁠︀-️]$/

/** `text` without the ANSI colour escapes `Theme` adds. */
export const stripStyles = (text: string): string => text.replace(ANSI, '')

/** How many terminal columns `text` takes, ignoring colour escapes and counting wide characters as two. */
export const width = (text: string): number => {
	let columns = 0
	for (const character of stripStyles(text)) columns += ZERO.test(character) ? 0 : WIDE.test(character) ? 2 : 1
	return columns
}

/** `text` in at most `size` columns, with `…` where the middle was cut out. Cutting costs the text its styles. */
export const truncate = (text: string, size: number): string => {
	if (width(text) <= size) return text
	const plain = stripStyles(text)
	if (size <= 1) return size < 1 ? '' : '…'
	const characters = [...plain]
	const head: string[] = []
	const tail: string[] = []
	let left = size - 1
	while (characters.length) {
		const next = head.length <= tail.length ? characters.shift()! : characters.pop()!
		const cost = width(next)
		if (cost > left) break
		left -= cost
		if (head.length <= tail.length) head.push(next)
		else tail.unshift(next)
	}
	return `${head.join('')}…${tail.join('')}`
}

export type Styler = (text: string) => string

const CODES = { bold: '1', dim: '2', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36' }

/** Text styles. Every one is the identity function when colour is off, so callers never branch on it. */
export type Theme = { readonly [name in keyof typeof CODES]: Styler } & { readonly enabled: boolean }

export const createTheme = (enabled: boolean): Theme =>
	Object.freeze({
		enabled,
		...(Object.fromEntries(
			Object.entries(CODES).map(([name, code]) => [name, enabled ? (text: string) => `\u001B[${code}m${text}\u001B[0m` : (text: string) => text])
		) as { [name in keyof typeof CODES]: Styler })
	})

export interface Glyphs {
	ok: string
	warn: string
	fail: string
	info: string
	dot: string
	dash: string
	arrow: string
	full: string
	empty: string
}

const UNICODE_GLYPHS: Glyphs = { ok: '✔', warn: '!', fail: '✖', info: '›', dot: '·', dash: '–', arrow: '→', full: '█', empty: '░' }
const ASCII_GLYPHS: Glyphs = { ok: 'OK', warn: '!', fail: 'x', info: '>', dot: '-', dash: '-', arrow: '->', full: '#', empty: '.' }

interface BoxChars {
	h: string
	v: string
	topLeft: string
	topRight: string
	bottomLeft: string
	bottomRight: string
	top: string
	bottom: string
	left: string
	right: string
	cross: string
}

const UNICODE_BOX: BoxChars = { h: '─', v: '│', topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', top: '┬', bottom: '┴', left: '├', right: '┤', cross: '┼' }
const ASCII_BOX: BoxChars = { h: '-', v: '|', topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', top: '+', bottom: '+', left: '+', right: '+', cross: '+' }

export type Align = 'left' | 'right'

export interface Column {
	title: string
	/** `'right'` for numbers. Default `'left'`. */
	align?: Align | undefined
	/** Leave the column out when every cell in it is empty: a table only shows what there is to say. */
	optional?: boolean | undefined
	/** Shorten this column first when the table is wider than the terminal. */
	flex?: boolean | undefined
	/** Leave the column out when shortening is not enough: what it says must be nice to have. */
	droppable?: boolean | undefined
}

export interface Row {
	cells: readonly string[]
	/** Draw a rule above the row, to set a totals row apart from the data. */
	rule?: boolean | undefined
}

export type Status = 'ok' | 'warn' | 'fail' | 'info'

export interface RendererOptions {
	/** ANSI colours. Default: whether the output is a terminal (see `detectColor`). */
	color?: boolean | undefined
	/** Box-drawing characters and symbols. Default: whether the terminal can show them (see `detectUnicode`). */
	unicode?: boolean | undefined
	/** Terminal width, at least 40. Default `process.stdout.columns`, or 80. */
	columns?: number | undefined
	/** Put in front of every line. Default two spaces. */
	indent?: string | undefined
}

/** Whether to colour the output: `NO_COLOR` and `FORCE_COLOR` win, otherwise it takes a terminal. */
export const detectColor = (env: Readonly<Record<string, string | undefined>> = process.env, stream: { isTTY?: boolean | undefined } = process.stdout): boolean => {
	if (env.NO_COLOR) return false
	if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true
	return env.TERM !== 'dumb' && Boolean(stream.isTTY)
}

/** Whether the terminal can show box-drawing characters: everything but `TERM=dumb` and a plain Windows console. */
export const detectUnicode = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => {
	if (env.NO_UNICODE || env.TERM === 'dumb') return false
	if (process.platform !== 'win32') return true
	return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI)
}

/**
 * Renders the pieces the command line prints: a title, labelled values, a table and a status line. Everything comes
 * back as lines of text, so the caller decides where they go and tests can read them.
 */
export interface Renderer {
	theme: Theme
	glyphs: Glyphs
	/** The width the output is laid out for. */
	columns: number
	/** The command being run, with a dim note after it. */
	title: (text: string, note?: string) => string
	/** A heading above a table or a block. */
	heading: (text: string) => string
	/** `label  value  note` lines, with the values lined up. Falsy entries are skipped. */
	details: (entries: readonly (readonly [string, string, string?] | false | undefined)[]) => string[]
	/** A table, sized to its contents and to the terminal. */
	table: (columns: readonly Column[], rows: readonly Row[]) => string[]
	/** A line marked with a status symbol, in that status's colour. */
	note: (status: Status, text: string) => string
	/** An indented line, e.g. a detail under a note. */
	line: (text: string, depth?: number) => string
	/** A progress bar of `size` characters. */
	bar: (fraction: number, size?: number) => string
}

export const createRenderer = (options: RendererOptions = {}): Renderer => {
	const theme = createTheme(options.color ?? detectColor())
	const unicode = options.unicode ?? detectUnicode()
	const glyphs = unicode ? UNICODE_GLYPHS : ASCII_GLYPHS
	const box = unicode ? UNICODE_BOX : ASCII_BOX
	const indent = options.indent ?? '  '
	const columns = Math.max(40, options.columns || process.stdout?.columns || 80)
	const COLORS: Record<Status, Styler> = { ok: theme.green, warn: theme.yellow, fail: theme.red, info: theme.cyan }

	const pad = (text: string, size: number, align: Align = 'left') => {
		const space = ' '.repeat(Math.max(0, size - width(text)))
		return align === 'right' ? space + text : text + space
	}

	return {
		theme,
		glyphs,
		columns,
		title: (text, note) => `${indent}${theme.bold(text)}${note ? `  ${theme.dim(`${glyphs.dot} ${note}`)}` : ''}`,
		heading: text => `${indent}${theme.bold(text)}`,
		details: entries => {
			const rows = entries.filter((entry): entry is readonly [string, string, string?] => Boolean(entry))
			const label = Math.max(0, ...rows.map(([text]) => width(text)))
			const value = Math.max(0, ...rows.filter(([, , note]) => note).map(([, text]) => width(text)))
			return rows.map(([name, text, note]) => `${indent}${theme.dim(pad(name, label))}  ${pad(text, note ? value : 0)}${note ? `  ${theme.dim(note)}` : ''}`.trimEnd())
		},
		table: (all, rows) => {
			const cellAt = (row: Row, index: number) => row.cells[index] ?? ''
			// An optional column that says nothing anywhere is left out: the table only shows what there is to say.
			let shown = all
				.map((column, index) => ({ column, index, size: Math.max(width(column.title), ...rows.map(row => width(cellAt(row, index)))) }))
				.filter(({ column, index }) => !column.optional || rows.some(row => stripStyles(cellAt(row, index)).trim()))
			// Padding, borders and the indent, so a table stays inside the terminal rather than wrapping.
			const over = () => indent.length + shown.length * 3 + 1 + shown.reduce((total, { size }) => total + size, 0) - columns
			for (const entry of shown) {
				if (over() <= 0) break
				if (entry.column.flex) entry.size -= Math.min(over(), Math.max(0, entry.size - Math.max(width(entry.column.title), 8)))
			}
			while (over() > 0 && shown.some(({ column }) => column.droppable)) {
				const last = [...shown].reverse().find(({ column }) => column.droppable)!
				shown = shown.filter(entry => entry !== last)
			}
			// Nothing to say in a cell reads as a dash, rather than as a hole in the table.
			const content = rows.map(row => shown.map(({ index }) => (stripStyles(cellAt(row, index)).trim() ? cellAt(row, index) : theme.dim(glyphs.dash))))
			const rule = (left: string, middle: string, right: string) => theme.dim(`${indent}${left}${shown.map(({ size }) => box.h.repeat(size + 2)).join(middle)}${right}`)
			const line = (values: readonly string[]) =>
				`${indent}${theme.dim(box.v)} ${values.map((value, index) => pad(truncate(value, shown[index]!.size), shown[index]!.size, shown[index]!.column.align)).join(` ${theme.dim(box.v)} `)} ${theme.dim(box.v)}`
			const lines = [rule(box.topLeft, box.top, box.topRight), line(shown.map(({ column }) => theme.bold(column.title))), rule(box.left, box.cross, box.right)]
			for (const [index, row] of rows.entries()) {
				if (row.rule) lines.push(rule(box.left, box.cross, box.right))
				lines.push(line(content[index]!))
			}
			lines.push(rule(box.bottomLeft, box.bottom, box.bottomRight))
			return lines
		},
		note: (status, text) => `${indent}${COLORS[status](glyphs[status])} ${text}`,
		line: (text, depth = 1) => `${indent}${'  '.repeat(depth)}${text}`,
		bar: (fraction, size = 10) => {
			const filled = Math.round(Math.min(1, Math.max(0, fraction)) * size)
			return `${theme.green(glyphs.full.repeat(filled))}${theme.dim(glyphs.empty.repeat(size - filled))}`
		}
	}
}

export interface StatusOptions {
	/** Where a terminal line is rewritten. Default `process.stdout`. */
	stream?: (NodeJS.WriteStream & { isTTY?: boolean | undefined }) | undefined
	/** Where lines go when there is no terminal to rewrite. */
	log: (line: string) => void
	/** Rewrite one line in place. Default: whether `stream` is a terminal. */
	interactive?: boolean | undefined
}

/**
 * One line that reports progress: rewritten in place on a terminal, and logged as it changes otherwise, so a log
 * file or a CI run reads as a list of steps.
 */
export interface StatusLine {
	set: (text: string) => void
	/** Erase the line, and log `text` in its place when there is one. */
	end: (text?: string) => void
}

export const createStatus = (options: StatusOptions): StatusLine => {
	const stream = options.stream ?? process.stdout
	const interactive = options.interactive ?? Boolean(stream?.isTTY)
	let drawn = false
	const clear = () => {
		if (!drawn) return
		drawn = false
		stream.write('\r\u001B[2K')
	}
	return {
		set: text => {
			if (!interactive) return options.log(text)
			clear()
			drawn = true
			// A line that would wrap is cut to the terminal's width, which costs it its colours.
			const room = (stream.columns || 80) - 1
			stream.write(width(text) > room ? truncate(text, room) : text)
		},
		end: text => {
			clear()
			if (text !== undefined) options.log(text)
		}
	}
}
