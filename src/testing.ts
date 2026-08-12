import { ConduitError } from './primitives/errors'
import type { FetchLike, HttpMethod } from './primitives/types'

/*
 *   REQUEST
 ***************************************************************************************************/
export interface MockRequest {
	method: string
	/** The full URL the client built, query and all. */
	url: string
	/** Just the path, which is what routes match against. */
	path: string
	query: URLSearchParams
	/** Values captured by `:name` segments in the route pattern. */
	params: Readonly<Record<string, string>>
	headers: Headers
	body: BodyInit | null
	/** The body decoded as JSON, or `undefined` if it was not text. */
	json<T = unknown>(): T | undefined
	/** The body as text, or `undefined` if it was not text. */
	text(): string | undefined
}

export interface MockCall {
	method: string
	url: string
	path: string
	headers: Headers
	body: BodyInit | null
}

/*
 *   RESPONDERS
 ***************************************************************************************************/
/** Spelled out rather than `unknown`, which would absorb the function arm of {@link MockResponder}. */
export type MockValue =
	| Response
	| Error
	| Record<string, unknown>
	| readonly unknown[]
	| string
	| number
	| boolean
	| null
	| undefined

/**
 * A `Response` is used as-is, an `Error` is thrown as a network failure, and
 * anything else is JSON, so the common case is `server.get('/me', { id: 1 })`.
 */
export type MockResponder = ((request: MockRequest) => unknown) | MockValue

export function json(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers)

	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json')
	}

	return new Response(JSON.stringify(body), { ...init, headers })
}

export function text(body: string, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers)

	if (!headers.has('content-type')) {
		headers.set('content-type', 'text/plain')
	}

	return new Response(body, { ...init, headers })
}

/** A failing status with an optional body. */
export function status(code: number, body: unknown = null): Response {
	return body === null ? new Response(null, { status: code }) : json(body, { status: code })
}

/** A request that never reached a server, as distinct from one that failed. */
export function networkError(message = 'Failed to fetch'): TypeError {
	return new TypeError(message)
}

/** Wraps a responder so it answers late. Pair it with fake timers. */
export function delay(ms: number, responder: MockResponder): MockResponder {
	return async (request: MockRequest): Promise<unknown> => {
		await new Promise(resolve => setTimeout(resolve, ms))

		return typeof responder === 'function' ? responder(request) : responder
	}
}

/*
 *   MATCHING
 ***************************************************************************************************/
const ESCAPE = /[.+^${}()|[\]\\]/g

/**
 * Turns `/users/:id` into a matcher that also captures `id`, and `*` into a
 * wildcard. A `RegExp` is used as given.
 */
function toMatcher(pattern: string | RegExp): RegExp {
	if (pattern instanceof RegExp) {
		return pattern
	}

	const source = pattern
		.replace(ESCAPE, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '(?<$1>[^/]+)')

	return new RegExp(`^${source}$`)
}

/*
 *   SERVER
 ***************************************************************************************************/
export interface MockRouteOptions {
	/** Retire the route after this many matches. */
	times?: number
}

export interface MockServerConfig {
	/** Prefixed to every string pattern, so routes read like the client's paths. */
	baseUrl?: string
	/** What an unmatched request does. Throwing, the default, fails it where it was made. */
	onUnmatched?: 'throw' | 'notFound'
}

export interface MockServer {
	/** Hand this to `createClient({ fetch })`. */
	readonly fetch: FetchLike
	/** Every request that arrived, in order. */
	readonly calls: readonly MockCall[]
	route(
		method: HttpMethod | '*',
		pattern: string | RegExp,
		responder: MockResponder,
		options?: MockRouteOptions
	): MockServer
	get(pattern: string | RegExp, responder: MockResponder, options?: MockRouteOptions): MockServer
	post(pattern: string | RegExp, responder: MockResponder, options?: MockRouteOptions): MockServer
	put(pattern: string | RegExp, responder: MockResponder, options?: MockRouteOptions): MockServer
	patch(
		pattern: string | RegExp,
		responder: MockResponder,
		options?: MockRouteOptions
	): MockServer
	delete(
		pattern: string | RegExp,
		responder: MockResponder,
		options?: MockRouteOptions
	): MockServer
	any(pattern: string | RegExp, responder: MockResponder, options?: MockRouteOptions): MockServer
	/** Drops every route and every recorded call. */
	reset(): void
}

interface Route {
	method: HttpMethod | '*'
	label: string
	matcher: RegExp
	responder: MockResponder
	remaining: number
}

/**
 * A server for tests, without a server. It sits at the transport, so cache,
 * dedupe, retry, the queue and session recovery all run for real.
 *
 * ```ts
 * const server = createMockServer({ baseUrl: '/api' })
 * server.get('/users/:id', request => ({ id: request.params.id }))
 * server.post('/users', status(201, { id: 2 }))
 *
 * const api = createClient({ baseUrl: '/api', fetch: server.fetch })
 * ```
 */
export function createMockServer(config: MockServerConfig = {}): MockServer {
	const baseUrl = config.baseUrl ?? ''
	const unmatched = config.onUnmatched ?? 'throw'
	const routes: Route[] = []
	const calls: MockCall[] = []

	const server: MockServer = {
		calls,

		fetch: (url, init) => {
			const mark = url.indexOf('?')
			const path = mark === -1 ? url : url.slice(0, mark)
			const method = (init.method ?? 'GET').toUpperCase()
			const headers = new Headers(init.headers)
			const body = init.body ?? null

			calls.push({ method, url, path, headers, body })

			for (const route of routes) {
				if (route.remaining <= 0) {
					continue
				}

				if (route.method !== '*' && route.method !== method) {
					continue
				}

				const match = route.matcher.exec(path)

				if (match === null) {
					continue
				}

				route.remaining--

				return answer(route.responder, {
					method,
					url,
					path,
					query: new URLSearchParams(mark === -1 ? '' : url.slice(mark + 1)),
					params: match.groups ?? {},
					headers,
					body,
					json: <T>() => (typeof body === 'string' ? (JSON.parse(body) as T) : undefined),
					text: () => (typeof body === 'string' ? body : undefined),
				})
			}

			if (unmatched === 'notFound') {
				return Promise.resolve(new Response(null, { status: 404 }))
			}

			return Promise.reject(
				new ConduitError({
					code: 'CONFIG',
					message: `No route for ${method} ${path}. Registered: ${
						routes.length === 0 ? '(none)' : routes.map(route => route.label).join(', ')
					}`,
					method,
					url,
				})
			)
		},

		route: (method, pattern, responder, options = {}) => {
			const prefixed = typeof pattern === 'string' ? `${baseUrl}${pattern}` : pattern

			routes.push({
				method,
				label: `${method} ${String(prefixed)}`,
				matcher: toMatcher(prefixed),
				responder,
				remaining: options.times ?? Number.POSITIVE_INFINITY,
			})

			return server
		},

		get: (pattern, responder, options) => server.route('GET', pattern, responder, options),
		post: (pattern, responder, options) => server.route('POST', pattern, responder, options),
		put: (pattern, responder, options) => server.route('PUT', pattern, responder, options),
		patch: (pattern, responder, options) => server.route('PATCH', pattern, responder, options),
		delete: (pattern, responder, options) =>
			server.route('DELETE', pattern, responder, options),
		any: (pattern, responder, options) => server.route('*', pattern, responder, options),

		reset: () => {
			routes.length = 0
			calls.length = 0
		},
	}

	return server
}

/*
 *   ANSWERING
 ***************************************************************************************************/
async function answer(responder: MockResponder, request: MockRequest): Promise<Response> {
	const result: unknown = typeof responder === 'function' ? await responder(request) : responder

	if (result instanceof Response) {
		return result
	}

	if (result instanceof Error) {
		throw result
	}

	return json(result)
}
