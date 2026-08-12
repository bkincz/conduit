import { DEV } from '../primitives/dev'
import { ConduitError } from '../primitives/errors'
import type { PathParams, Query } from '../primitives/types'

/*
 *   PATH PARAMS
 ***************************************************************************************************/
/**
 * A placeholder starts a segment. A colon anywhere else is literal, which keeps
 * `/v1/models/gemini-pro:generateContent` and `//user:pass@host` working. Write
 * `::name` for a literal segment that has to begin with one.
 */
const PARAM_PATTERN = /(^|\/)(::?)([A-Za-z_][A-Za-z0-9_]*)/g

/** Substitutes `:name` placeholders. A missing value is a `CONFIG` error, not a 404. */
export function applyPathParams(path: string, params: PathParams | undefined): string {
	const mark = path.indexOf('?')
	const head = mark === -1 ? path : path.slice(0, mark)
	const tail = mark === -1 ? '' : path.slice(mark)

	PARAM_PATTERN.lastIndex = 0

	if (!PARAM_PATTERN.test(head)) {
		if (DEV && params !== undefined && Object.keys(params).length > 0) {
			console.warn(
				`[conduit] "${path}" was given params ${JSON.stringify(Object.keys(params))} but contains no ":name" placeholders. Did you mean to pass them as "query"?`
			)
		}

		return path
	}

	PARAM_PATTERN.lastIndex = 0

	const substituted = head.replace(
		PARAM_PATTERN,
		(_match, prefix: string, colons: string, name: string) => {
			if (colons === '::') {
				return `${prefix}:${name}`
			}

			const value = params?.[name]

			if (value === undefined) {
				throw new ConduitError({
					code: 'CONFIG',
					message: `Path "${path}" needs a value for ":${name}". Pass it as params: { ${name}: … }.`,
					url: path,
				})
			}

			return `${prefix}${encodeURIComponent(String(value))}`
		}
	)

	return substituted + tail
}

/*
 *   QUERY
 ***************************************************************************************************/
/** Appends query values in order. `undefined` and `null` are dropped, arrays repeat the key. */
export function appendQuery(url: string, query: Query | undefined): string {
	if (query === undefined) {
		return url
	}

	const search = new URLSearchParams()

	for (const key of Object.keys(query)) {
		const value = query[key]

		if (value === undefined || value === null) {
			continue
		}

		if (Array.isArray(value)) {
			for (const entry of value) {
				search.append(key, String(entry))
			}
			continue
		}

		search.append(key, String(value))
	}

	const serialised = search.toString()

	if (serialised === '') {
		return url
	}

	return url + (url.includes('?') ? '&' : '?') + serialised
}

/*
 *   JOIN
 ***************************************************************************************************/
const ABSOLUTE_PATTERN = /^([a-z][a-z0-9+.-]*:)?\/\//i

export function isAbsoluteUrl(url: string): boolean {
	return ABSOLUTE_PATTERN.test(url)
}

/** Joins base and path with exactly one slash. An absolute path ignores the base. */
export function joinUrl(baseUrl: string, path: string): string {
	if (baseUrl === '' || isAbsoluteUrl(path)) {
		return path
	}

	const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
	const tail = path.startsWith('/') ? path : `/${path}`

	return base + tail
}

/*
 *   BUILD
 ***************************************************************************************************/
export function buildUrl(
	baseUrl: string,
	path: string,
	params: PathParams | undefined,
	query: Query | undefined
): string {
	return appendQuery(joinUrl(baseUrl, applyPathParams(path, params)), query)
}
