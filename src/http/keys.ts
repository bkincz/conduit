import type { HttpMethod, ParseMode, Vary } from '../primitives/types'

/*
 *   HASH
 ***************************************************************************************************/
/** FNV-1a, 32-bit. Cheap enough to run on every request, and not cryptographic. */
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
 * Sorts the query string so `?a=1&b=2` and `?b=2&a=1` share an entry. Sorted by
 * name only and stably, so `?sort=name&sort=age` keeps its order and stays
 * distinct from the reverse.
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
 * Text-like bodies hash by value, so identical payloads share a key. A stream
 * or `Blob` cannot be read without consuming it, so it gets a per-instance id
 * and never matches anything else.
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
		const own = new Map<string, string>()

		for (const pair of init) {
			const name = pair[0]
			const value = pair[1]

			if (name === undefined || value === undefined) {
				continue
			}

			const lower = name.toLowerCase()
			const existing = own.get(lower)

			own.set(lower, existing === undefined ? value : `${existing}, ${value}`)
		}

		for (const [name, value] of own) {
			into.set(name, value)
		}

		return
	}

	for (const [name, value] of Object.entries(init)) {
		into.set(name.toLowerCase(), value)
	}
}

/**
 * Hashes the headers that make two requests to the same url different requests.
 *
 * Merging matches how the client builds them: a repeated name within one init
 * comma-joins, and the option headers replace the config ones.
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
 * Everything beyond method, url and body that makes a request distinct,
 * pre-hashed so `withRequest` can recompute a key without the headers.
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
	/** How the body will be decoded. Omitted means `auto`, the baseline. */
	parse?: ParseMode
}

/**
 * The identity a request is cached, deduped and superseded by, left readable
 * for devtools. Credentials and decode mode are part of it: colliding on either
 * serves a caller someone else's data, or the same bytes as the wrong type.
 */
export function deriveKey(inputs: KeyInputs): string {
	let key = `${inputs.method} ${canonicalUrl(inputs.url)}`

	if (inputs.body !== null) {
		key += ` ${bodyFingerprint(inputs.body)}`
	}

	if (inputs.variance !== '') {
		key += ` ${inputs.variance}`
	}

	if (inputs.parse !== undefined && inputs.parse !== 'auto') {
		key += ` p:${inputs.parse}`
	}

	return key
}
