import type { HttpMethod, Vary } from './types'

/*
 *   HASH
 ***************************************************************************************************/
/**
 * FNV-1a, 32-bit. Not cryptographic and not meant to be — it exists to collapse
 * a request body into a few characters cheaply enough to run on every call.
 */
export function fnv1a(input: string): string {
	let hash = 0x811c9dc5

	for (let index = 0; index < input.length; index++) {
		hash ^= input.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}

	return (hash >>> 0).toString(36)
}

/*
 *   CANONICAL URL
 ***************************************************************************************************/
function nameOf(pair: string): string {
	const split = pair.indexOf('=')

	return split === -1 ? pair : pair.slice(0, split)
}

/**
 * Sorts the query string so `?a=1&b=2` and `?b=2&a=1` share a cache entry.
 *
 * Sorted by parameter *name* only, and `Array.sort` is stable, so repeated keys
 * keep the order the caller gave them: `?sort=name&sort=age` and
 * `?sort=age&sort=name` stay distinct, because to a server they are.
 */
export function canonicalUrl(url: string): string {
	const mark = url.indexOf('?')

	if (mark === -1) {
		return url
	}

	const path = url.slice(0, mark)
	const pairs = url
		.slice(mark + 1)
		.split('&')
		.filter(pair => pair !== '')
		.sort((first, second) => {
			const a = nameOf(first)
			const b = nameOf(second)

			return a < b ? -1 : a > b ? 1 : 0
		})

	return pairs.length === 0 ? path : `${path}?${pairs.join('&')}`
}

/*
 *   BODY FINGERPRINT
 ***************************************************************************************************/
const bodyIds = new WeakMap<object, string>()
let nextBodyId = 0

/**
 * Reduces a body to something comparable.
 *
 * Text-like bodies hash by value, so two identical payloads share a key. A
 * stream or a `Blob` cannot be read without consuming it, so those get a
 * per-instance id instead — which deliberately makes them non-matching, since
 * pretending two unread streams are equal would serve the wrong response.
 */
export function bodyFingerprint(body: BodyInit | null): string {
	if (body === null) {
		return ''
	}

	if (typeof body === 'string') {
		return fnv1a(body)
	}

	if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
		return fnv1a(body.toString())
	}

	const existing = bodyIds.get(body)

	if (existing !== undefined) {
		return existing
	}

	const id = `#${(nextBodyId++).toString(36)}`
	bodyIds.set(body, id)

	return id
}

/*
 *   HEADER VARIANCE
 ***************************************************************************************************/
function collect(init: HeadersInit | undefined, into: Map<string, string>): void {
	if (init === undefined) {
		return
	}

	if (typeof Headers !== 'undefined' && init instanceof Headers) {
		init.forEach((value, name) => into.set(name, value))
		return
	}

	if (Array.isArray(init)) {
		for (const pair of init) {
			const name = pair[0]
			const value = pair[1]

			if (name !== undefined && value !== undefined) {
				into.set(name.toLowerCase(), value)
			}
		}

		return
	}

	for (const [name, value] of Object.entries(init)) {
		into.set(name.toLowerCase(), value)
	}
}

/**
 * Hashes the headers that make two requests to the same URL different requests.
 *
 * Reads the raw `HeadersInit` rather than a built `Headers`, so identity costs a
 * few map writes and the real `Headers` instance stays deferred to the network
 * path. Last write wins, matching how the client merges them.
 */
export function fingerprintHeaders(
	configHeaders: HeadersInit | undefined,
	optionHeaders: HeadersInit | undefined,
	vary: Vary
): string {
	if (vary !== '*' && vary.length === 0) {
		return ''
	}

	const merged = new Map<string, string>()
	collect(configHeaders, merged)
	collect(optionHeaders, merged)

	if (merged.size === 0) {
		return ''
	}

	const wanted = vary === '*' ? undefined : new Set(vary.map(name => name.toLowerCase()))
	const parts: string[] = []

	for (const [name, value] of merged) {
		if (wanted === undefined || wanted.has(name)) {
			parts.push(`${name}:${value}`)
		}
	}

	if (parts.length === 0) {
		return ''
	}

	parts.sort()

	return fnv1a(parts.join('\n'))
}

/**
 * Everything beyond method, URL and body that makes a request distinct.
 *
 * Kept as a single pre-hashed string on the request so `withRequest` can
 * recompute a key without re-reading headers it no longer has.
 */
export function deriveVariance(
	configHeaders: HeadersInit | undefined,
	optionHeaders: HeadersInit | undefined,
	vary: Vary,
	credentials: RequestCredentials | undefined
): string {
	const headers = fingerprintHeaders(configHeaders, optionHeaders, vary)
	const parts: string[] = []

	if (headers !== '') {
		parts.push(`h:${headers}`)
	}

	// Same URL, same headers, different credential mode is a different request:
	// one carries the session cookie and one does not.
	if (credentials !== undefined) {
		parts.push(`c:${credentials}`)
	}

	return parts.join(' ')
}

/*
 *   KEY
 ***************************************************************************************************/
export interface KeyInputs {
	method: HttpMethod
	url: string
	body: BodyInit | null
	variance: string
}

/**
 * The identity a request is cached, deduped and superseded by.
 *
 * Kept human-readable rather than hashed whole: this string is what shows up in
 * devtools, and `GET /users?id=1` tells you what went wrong where `1f3k9x` does
 * not. The hashed parts are appended only when they carry information, so the
 * common case stays legible.
 *
 * Headers are part of this on purpose. One client is shared across bundles, so
 * two remotes calling the same URL under different credentials must not collide
 * — that collision is a cross-account data leak, not a cache miss.
 */
export function deriveKey(inputs: KeyInputs): string {
	let key = `${inputs.method} ${canonicalUrl(inputs.url)}`

	if (inputs.body !== null) {
		key += ` ${bodyFingerprint(inputs.body)}`
	}

	if (inputs.variance !== '') {
		key += ` ${inputs.variance}`
	}

	return key
}
