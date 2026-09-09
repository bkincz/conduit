import { DEV } from '../primitives/dev'
import { ConduitError } from '../primitives/errors'
import { consoleLogger, type ConduitLogger, type PathParams, type Query } from '../primitives/types'

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
export function applyPathParams(
	path: string,
	params: PathParams | undefined,
	logger: ConduitLogger = consoleLogger
): string {
	const mark = path.indexOf('?')
	const head = mark === -1 ? path : path.slice(0, mark)
	const tail = mark === -1 ? '' : path.slice(mark)

	PARAM_PATTERN.lastIndex = 0

	if (!PARAM_PATTERN.test(head)) {
		if (DEV && params !== undefined && Object.keys(params).length > 0) {
			logger.warn(
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

			const value =
				params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined

			if (value === undefined) {
				throw new ConduitError({
					code: 'CONFIG',
					message: `Path "${path}" needs a value for ":${name}". Pass it as params: { ${name}: … }.`,
					url: path,
				})
			}

			const text = String(value)

			if (text.trim() === '') {
				throw new ConduitError({
					code: 'CONFIG',
					message: `Path "${path}" was given an empty value for ":${name}". An empty path segment is rarely what was meant; pass a real value or drop the placeholder.`,
					url: path,
				})
			}

			return `${prefix}${encodeURIComponent(text)}`
		}
	)

	return substituted + tail
}

/*
 *   QUERY
 ***************************************************************************************************/
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

	// The query belongs before the fragment, not after it: "#x?y" would send
	// the query as part of the fragment instead of the wire.
	const hashMark = url.indexOf('#')
	const head = hashMark === -1 ? url : url.slice(0, hashMark)
	const hash = hashMark === -1 ? '' : url.slice(hashMark)

	return head + (head.includes('?') ? '&' : '?') + serialised + hash
}

/*
 *   JOIN
 ***************************************************************************************************/
const ABSOLUTE_PATTERN = /^([a-z][a-z0-9+.-]*:)?\/\//i

const NO_ORIGINS: readonly string[] = Object.freeze([])

export function isAbsoluteUrl(url: string): boolean {
	return ABSOLUTE_PATTERN.test(url)
}

export function stripQuery(url: string): string {
	const mark = url.indexOf('?')

	return mark === -1 ? url : url.slice(0, mark)
}

/*
 *   ORIGIN GUARD
 ***************************************************************************************************/
function pageOrigin(): string | undefined {
	return typeof globalThis.location === 'object' ? globalThis.location.origin : undefined
}

function originOf(url: string): string | undefined {
	try {
		return new URL(url, pageOrigin()).origin
	} catch {
		return undefined
	}
}

function apiOrigin(baseUrl: string): string | undefined {
	return isAbsoluteUrl(baseUrl) ? originOf(baseUrl) : pageOrigin()
}

function assertAllowedOrigin(url: string, baseUrl: string, origins: readonly string[]): void {
	const target = originOf(url)

	if (target !== undefined && (target === apiOrigin(baseUrl) || origins.includes(target))) {
		return
	}

	throw new ConduitError({
		code: 'CONFIG',
		message: `"${stripQuery(url)}" leaves the origins this client is allowed to call. Add it to config.origins if this is intentional.`,
		url,
	})
}

export function joinUrl(
	baseUrl: string,
	path: string,
	origins: readonly string[] = NO_ORIGINS
): string {
	if (path.startsWith('//')) {
		throw new ConduitError({
			code: 'CONFIG',
			message: `"${stripQuery(path)}" is protocol-relative, which silently follows whatever scheme the page is on. Use an absolute url with an explicit scheme, or a relative one.`,
			url: path,
		})
	}

	if (isAbsoluteUrl(path)) {
		assertAllowedOrigin(path, baseUrl, origins)

		return path
	}

	if (baseUrl === '') {
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
	query: Query | undefined,
	origins: readonly string[] = NO_ORIGINS,
	logger: ConduitLogger = consoleLogger
): string {
	return appendQuery(joinUrl(baseUrl, applyPathParams(path, params, logger), origins), query)
}
