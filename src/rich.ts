import { cloneElement, createElement, Fragment, isValidElement, type ReactNode } from 'react'
import { formatValue } from './format.js'
import { isolate, isParamValue, valueFor, type Node } from './message.js'

type Values = Readonly<Record<string, unknown>> | undefined

/** Whether `values` hold anything a string can't: an element, a node or a tag renderer. */
export const isRich = (values: Values) => {
	for (const name in values) {
		const value = values[name]
		if (typeof value === 'function' || (typeof value === 'object' && value !== null && !(value instanceof Date))) return true
	}
	return false
}

/** Render to React nodes: tags with the matching element or `chunks => node` function, params as nodes or text. */
export const renderRich = (
	nodes: readonly Node[],
	locale: string,
	values: Values,
	onMissingTag: (tag: string) => void,
	timeZone?: string,
	isolated?: boolean
): ReactNode[] => {
	const out: ReactNode[] = []
	for (const node of nodes) {
		if (typeof node === 'string') out.push(node)
		else if ('param' in node) {
			const value = valueFor(values, node.param)
			if (value === undefined) out.push(`{${node.param}}`)
			else if (isParamValue(value)) {
				const text = typeof value === 'string' ? value : formatValue(locale, value, timeZone)
				out.push(isolated ? isolate(text) : text)
			} else out.push(value as ReactNode)
		} else {
			const children = renderRich(node.children, locale, values, onMissingTag, timeZone, isolated)
			const render = valueFor(values, node.tag)
			if (typeof render === 'function') out.push((render as (chunks: ReactNode) => ReactNode)(toNode(children)))
			else if (isValidElement(render)) out.push(cloneElement(render, undefined, ...children))
			else {
				onMissingTag(node.tag)
				out.push(...children)
			}
		}
	}
	return out
}

/** Collapse rendered parts: plain text stays a string; anything else becomes a keyless fragment. */
export const toNode = (parts: ReactNode[]): ReactNode =>
	parts.every(part => typeof part === 'string')
		? parts.join('')
		: parts.length === 1
			? parts[0]
			: createElement(Fragment, null, ...parts)
