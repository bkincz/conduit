import { encodeBody, type EncodedBody } from '../http/body'
import { resolveEndpointTags, type Endpoint, type EndpointDefinition } from './endpoint'
import { ConduitError, toConduitError } from '../primitives/errors'
import { createEventBus, elapsed, type EventBus } from '../primitives/events'
import { deriveKey, deriveVariance } from '../http/keys'
import { bodyOptions } from './methods'
import { compose } from '../http/pipeline'
import { conduitPromise } from '../http/promise'
import { createRequest } from '../http/request'
import { createScope, type Scope } from './scopes'
import { composeSignals } from '../http/signals'
import { createFetchTransport } from '../http/transport'
import { createXhrFetch, type UploadProgressEvent } from '../http/xhr'
import { buildUrl } from '../http/url'
import { TIMEOUT_META } from '../plugins/timeout'
import {
	consoleLogger,
	type ClientConfig,
	type ClientContext,
	type ConduitPromise,
	type ConduitRequest,
	type ConduitResponse,
	type FetchLike,
	type HttpMethod,
	type MethodOptions,
	type Middleware,
	type Next,
	type ParseMode,
	type PathParams,
	type Plugin,
	type RequestMethods,
	type RequestOptions,
	type ResolvedClientConfig,
} from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
const EMPTY_TAGS: readonly string[] = Object.freeze([])

/** `ClientConfig.redact`'s default: the headers most likely to carry a live credential. */
export const DEFAULT_REDACTED_HEADERS: readonly string[] = Object.freeze([
	'authorization',
	'cookie',
	'proxy-authorization',
])

function defaultFetch(): FetchLike {
	if (typeof globalThis.fetch !== 'function') {
		throw new ConduitError({
			code: 'CONFIG',
			message:
				'No global fetch was found. Pass one as config.fetch — conduit does not ship a polyfill.',
		})
	}

	return (input, init) => globalThis.fetch(input, init)
}

function resolveConfig(config: ClientConfig): ResolvedClientConfig {
	const headers = config.headers

	return {
		baseUrl: config.baseUrl ?? '',
		headers:
			headers === undefined
				? undefined
				: typeof headers === 'function'
					? headers
					: () => headers,
		credentials: config.credentials,
		vary: config.vary ?? '*',
		owner: config.owner,
		lane: config.lane ?? 'default',
		parse: config.parse ?? 'auto',
		fetch: config.fetch ?? defaultFetch(),
		mode: config.mode,
		redirect: config.redirect,
		cache: config.cache,
		keepalive: config.keepalive,
		priority: config.priority,
		referrerPolicy: config.referrerPolicy,
		integrity: config.integrity,
		origins: config.origins ?? [],
		redact: config.redact ?? DEFAULT_REDACTED_HEADERS,
		logger: config.logger ?? consoleLogger,
	}
}

function buildHeaders(
	configHeaders: HeadersInit | undefined,
	optionHeaders: HeadersInit | undefined,
	contentType: string | undefined
): Headers {
	const headers = new Headers(configHeaders)

	if (optionHeaders !== undefined) {
		new Headers(optionHeaders).forEach((value, name) => {
			headers.set(name, value)
		})
	}

	if (contentType !== undefined && !headers.has('content-type')) {
		headers.set('content-type', contentType)
	}

	return headers
}

/*
 *   REDACTION
 ***************************************************************************************************/
export function redactRequest(request: ConduitRequest, redact: readonly string[]): ConduitRequest {
	if (redact.length === 0) {
		return request
	}

	const hidden = redact.map(name => name.toLowerCase())
	const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(request)
	let redacted: Headers | undefined

	descriptors['headers'] = {
		enumerable: true,
		configurable: true,
		get(): Headers {
			if (redacted === undefined) {
				redacted = new Headers(request.headers)

				for (const name of hidden) {
					if (redacted.has(name)) {
						redacted.set(name, '[redacted]')
					}
				}
			}

			return redacted
		},
	}

	return Object.defineProperties({}, descriptors) as ConduitRequest
}

/** Same idea as {@link redactRequest}, applied to the `request` a response carries. */
function redactResponse<T>(
	response: ConduitResponse<T>,
	redact: readonly string[]
): ConduitResponse<T> {
	if (redact.length === 0) {
		return response
	}

	const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(response)
	let redacted: ConduitRequest | undefined

	descriptors['request'] = {
		enumerable: true,
		configurable: true,
		get(): ConduitRequest {
			redacted ??= redactRequest(response.request, redact)
			return redacted
		},
	}

	return Object.defineProperties({}, descriptors) as ConduitResponse<T>
}

/*
 *   ENDPOINTS
 ***************************************************************************************************/
const hasPathParams = (path: string): boolean =>
	path.split('/').some(segment => segment.startsWith(':'))

/** Folds an endpoint's `query`/`body`/`tags` and its own `vars` into ordinary request options. */
function resolveEndpointOptions<Vars, Result>(
	endpoint: EndpointDefinition<Vars, Result>,
	vars: Vars,
	options: Partial<RequestOptions> | undefined
): RequestOptions {
	const tags = resolveEndpointTags(endpoint.tags, vars)
	const query = endpoint.query?.(vars)
	const body = endpoint.body?.(vars)

	return {
		...endpoint.options,
		method: endpoint.method,
		...(vars === undefined || !hasPathParams(endpoint.path)
			? {}
			: { params: vars as unknown as PathParams }),
		...(query === undefined ? {} : { query }),
		...(body === undefined ? {} : { body }),
		...(tags === undefined ? {} : { tags }),
		...options,
	}
}

/** Runs an endpoint's `response` schema, or plain function, against a decoded body. */
async function decodeEndpointResponse<Result>(
	schema: NonNullable<EndpointDefinition<unknown, Result>['response']>,
	data: unknown
): Promise<Result> {
	if (typeof schema === 'function') {
		return schema(data)
	}

	const outcome = await schema['~standard'].validate(data)

	if ('issues' in outcome) {
		throw new ConduitError({
			code: 'SCHEMA',
			message: 'The response did not pass its schema.',
			body: outcome.issues,
		})
	}

	return outcome.value
}

/*
 *   CLIENT
 ***************************************************************************************************/
export class Client implements RequestMethods {
	private readonly _config: ResolvedClientConfig
	private readonly _transport: Next
	private readonly _context: ClientContext
	private readonly _events: EventBus
	private readonly _plugins: Plugin<object>[] = []
	private readonly _middlewares: Middleware[] = []
	private readonly _scopes: Set<Scope> = new Set()
	private readonly _resetListeners: Set<() => void> = new Set()
	private _dispatch: Next
	private _root: AbortController = new AbortController()
	private _destroyed = false

	constructor(config: ClientConfig = {}) {
		this._config = resolveConfig(config)
		this._events = createEventBus(this._config.logger)
		this._transport = createFetchTransport(this._config)
		this._dispatch = this._transport
		this._context = {
			config: this._config,
			events: this._events,
			request: <T>(path: string, options?: RequestOptions): ConduitPromise<T> =>
				this.request<T>(path, options),
			dispatch: (request): Promise<ConduitResponse> => this._dispatch(request),
			abortAll: (reason?: string): void => {
				this.abortAll(reason)
			},
			resetIdentity: (): void => {
				this._resetIdentity()
			},
			onResetIdentity: (listener: () => void): (() => void) => {
				this._resetListeners.add(listener)

				return () => {
					this._resetListeners.delete(listener)
				}
			},
		}
	}

	public get config(): ResolvedClientConfig {
		return this._config
	}

	/** Whether {@link Client.destroy} has run. */
	public isDestroyed(): boolean {
		return this._destroyed
	}

	/**
	 * The key a request would get, without issuing it.
	 *
	 * ```ts
	 * api.invalidate(api.keyFor('/users/:id', { params: { id } }))
	 * api.invalidate(api.keyFor(getUser, { id: '7' }))
	 * ```
	 */
	public keyFor(path: string, options?: RequestOptions): string
	public keyFor<Vars, Result>(endpoint: Endpoint<Vars, Result>, vars: Vars): string
	public keyFor(pathOrEndpoint: string | Endpoint<unknown, unknown>, second?: unknown): string {
		if (typeof pathOrEndpoint === 'string') {
			return this._prepare(pathOrEndpoint, (second as RequestOptions | undefined) ?? {}).key
		}

		const endpoint = pathOrEndpoint

		return this._prepare(endpoint.path, resolveEndpointOptions(endpoint, second, undefined)).key
	}

	/** Every request start, settle and failure, plus whatever plugins publish. */
	public get events(): EventBus {
		return this._events
	}

	/*
	 * PLUGINS
	 */
	/**
	 * Installs a plugin and merges what it returns onto the client, so the
	 * extension shows up in the type. `client.invalidate()` does not compile
	 * until `cache()` is installed.
	 */
	public with<Ext extends object>(plugin: Plugin<Ext>): this & Ext {
		this._assertAlive()

		if (this._plugins.some(installed => installed.name === plugin.name)) {
			throw new ConduitError({
				code: 'CONFIG',
				message: `Plugin "${plugin.name}" is already installed. Installing it twice would run its middleware twice on every request.`,
			})
		}

		this._plugins.push(plugin as Plugin<object>)

		if (plugin.middleware !== undefined) {
			this._middlewares.push(plugin.middleware)
			this._dispatch = compose(this._middlewares, this._transport)
		}

		const extension = plugin.onInit?.(this._context)

		if (extension) {
			for (const key of Object.keys(extension)) {
				if (key in this) {
					throw new ConduitError({
						code: 'CONFIG',
						message: `Plugin "${plugin.name}" wants to add "${key}", which already exists on the client. Rename it in the plugin.`,
					})
				}
			}

			Object.assign(this, extension)
		}

		return this as this & Ext
	}

	/*
	 * REQUESTS
	 */
	public request<T = unknown>(path: string, options?: RequestOptions): ConduitPromise<T> {
		return this._execute<T>(path, options ?? {}, undefined, undefined)
	}

	public get<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T> {
		return this._execute<T>(path, { ...options, method: 'GET' }, undefined, undefined)
	}

	public head<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T> {
		return this._execute<T>(path, { ...options, method: 'HEAD' }, undefined, undefined)
	}

	public delete<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T> {
		return this._execute<T>(path, { ...options, method: 'DELETE' }, undefined, undefined)
	}

	public post<T = unknown>(
		path: string,
		body?: unknown,
		options?: MethodOptions
	): ConduitPromise<T> {
		return this._execute<T>(path, bodyOptions('POST', body, options), undefined, undefined)
	}

	public put<T = unknown>(
		path: string,
		body?: unknown,
		options?: MethodOptions
	): ConduitPromise<T> {
		return this._execute<T>(path, bodyOptions('PUT', body, options), undefined, undefined)
	}

	public patch<T = unknown>(
		path: string,
		body?: unknown,
		options?: MethodOptions
	): ConduitPromise<T> {
		return this._execute<T>(path, bodyOptions('PATCH', body, options), undefined, undefined)
	}

	/**
	 * Runs a {@link defineEndpoint | typed endpoint}: `vars` fill its path
	 * params, build its query and body, and its `response` schema — if it has
	 * one — validates the decoded body before this resolves. A failing schema
	 * rejects with code `SCHEMA`, carrying the issues as `body`.
	 *
	 * ```ts
	 * const user = await api.call(getUser, { id: '7' })
	 * ```
	 */
	public call<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		vars: Vars,
		options?: Partial<RequestOptions>
	): ConduitPromise<Result> {
		const requestOptions = resolveEndpointOptions(endpoint, vars, options)
		const inner = this._execute<unknown>(endpoint.path, requestOptions, undefined, undefined)
		const schema = endpoint.response

		const run = async (): Promise<ConduitResponse<Result>> => {
			const response = await inner.response()

			if (schema === undefined) {
				return response as ConduitResponse<Result>
			}

			return { ...response, data: await decodeEndpointResponse(schema, response.data) }
		}

		return conduitPromise(run())
	}

	/**
	 * Posts a `FormData` or `Blob`, with no default timeout, since a slow
	 * connection is not a hung one. Passing `onProgress` routes this one
	 * request through `XMLHttpRequest` instead of `config.fetch`, since `fetch`
	 * has no event for upload progress. Without it, `upload` is a `post` that
	 * happens to default its method and skip the timeout, and still goes
	 * through `config.fetch` like everything else, mock servers included.
	 * Either way it runs through the same middleware stack: session, retry,
	 * queue and the rest still apply.
	 */
	public upload<T = unknown>(
		path: string,
		body: FormData | Blob,
		options: MethodOptions & { onProgress?: (event: UploadProgressEvent) => void } = {}
	): ConduitPromise<T> {
		this._assertAlive()

		const { onProgress, meta, ...rest } = options
		const dispatch =
			onProgress === undefined
				? undefined
				: compose(
						this._middlewares,
						createFetchTransport({
							...this._config,
							fetch: createXhrFetch({ onProgress }),
						})
					)

		return this._execute<T>(
			path,
			{ ...rest, method: 'POST', body, meta: { [TIMEOUT_META]: 0, ...meta } },
			undefined,
			undefined,
			dispatch
		)
	}

	/*
	 * SCOPES
	 */
	/** Opens a cancellation boundary. Requests made through it carry `name` as their owner. */
	public scope(name: string): Scope {
		this._assertAlive()

		const scope = createScope({
			name,
			makeExecutor:
				(signal, owner) =>
				<T>(path: string, options: RequestOptions): ConduitPromise<T> =>
					this._execute<T>(path, options, signal, owner),
			onDispose: released => {
				this._scopes.delete(released)
			},
		})

		this._scopes.add(scope)

		return scope
	}

	/** Cancels everything in flight, across every scope. Spent scopes cannot be reused. */
	public abortAll(reason?: string): void {
		const message = reason ?? 'Every in-flight request was aborted.'

		if (!this._root.signal.aborted) {
			this._root.abort(new ConduitError({ code: 'ABORTED', message }))
		}

		for (const scope of this._scopes) {
			scope.abort(message)
		}

		this._root = new AbortController()
	}

	/*
	 * TEARDOWN
	 */
	public destroy(): void {
		if (this._destroyed) {
			return
		}

		this._destroyed = true

		if (!this._root.signal.aborted) {
			this._root.abort(
				new ConduitError({ code: 'ABORTED', message: 'The client was destroyed.' })
			)
		}

		for (const scope of [...this._scopes]) {
			scope.dispose()
		}

		for (let index = this._plugins.length - 1; index >= 0; index--) {
			this._plugins[index]?.onDestroy?.()
		}

		this._plugins.length = 0
		this._middlewares.length = 0
		this._resetListeners.clear()
		this._dispatch = this._transport

		if (this._events.active) {
			this._events.emit('client:destroy', { type: 'client:destroy', at: Date.now() })
		}

		this._events.clear()
	}

	/*
	 * INTERNALS
	 */
	/** Separate from `abortAll`: a sign-out has to cancel traffic and forget what it already has. */
	private _resetIdentity(): void {
		for (const listener of [...this._resetListeners]) {
			try {
				listener()
			} catch (error) {
				this._config.logger.error(
					`[conduit] A plugin threw while dropping its state. ${String(error)}`
				)
			}
		}
	}

	private _assertAlive(): void {
		if (this._destroyed) {
			throw new ConduitError({
				code: 'CONFIG',
				message: 'This client was destroyed. Create a new one rather than reusing it.',
			})
		}
	}

	/** Everything a request's identity depends on, derived once and shared with `keyFor`. */
	private _prepare(
		path: string,
		options: RequestOptions
	): {
		method: HttpMethod
		url: string
		encoded: EncodedBody
		variance: string
		credentials: RequestCredentials | undefined
		parse: ParseMode
		configHeaders: HeadersInit | undefined
		key: string
	} {
		const config = this._config
		const method = options.method ?? 'GET'
		const url = buildUrl(
			config.baseUrl,
			path,
			options.params,
			options.query,
			config.origins,
			config.logger
		)
		const encoded = encodeBody(options.body)
		const credentials = options.credentials ?? config.credentials
		const parse = options.parse ?? config.parse

		const configHeaders = config.headers?.()
		const variance = deriveVariance(configHeaders, options.headers, config.vary, credentials)

		return {
			method,
			url,
			encoded,
			variance,
			credentials,
			parse,
			configHeaders,
			key: options.key ?? deriveKey({ method, url, body: encoded.body, variance, parse }),
		}
	}

	private _execute<T>(
		path: string,
		options: RequestOptions,
		scopeSignal: AbortSignal | undefined,
		scopeOwner: string | undefined,
		dispatchOverride?: Next
	): ConduitPromise<T> {
		const run = async (): Promise<ConduitResponse<T>> => {
			this._assertAlive()

			const config = this._config
			const { method, url, encoded, variance, credentials, parse, configHeaders, key } =
				this._prepare(path, options)
			const composed = composeSignals([this._root.signal, scopeSignal, options.signal])

			const request = createRequest({
				url,
				method,
				body: encoded.body,
				signal: composed.signal,
				key,
				variance,
				lane: options.lane ?? config.lane,
				owner: options.owner ?? scopeOwner ?? config.owner,
				tags: options.tags ?? EMPTY_TAGS,
				parse,
				credentials,
				mode: options.mode ?? config.mode,
				redirect: options.redirect ?? config.redirect,
				cache: options.cache ?? config.cache,
				keepalive: options.keepalive ?? config.keepalive,
				priority: options.priority ?? config.priority,
				referrerPolicy: options.referrerPolicy ?? config.referrerPolicy,
				integrity: options.integrity ?? config.integrity,
				meta: options.meta === undefined ? {} : { ...options.meta },
				buildHeaders: () =>
					buildHeaders(configHeaders, options.headers, encoded.contentType),
			})

			const watched = this._events.active
			const started = watched ? elapsed() : 0
			const exposedRequest = redactRequest(request, config.redact)

			if (watched) {
				this._events.emit('request:start', {
					type: 'request:start',
					request: exposedRequest,
					at: Date.now(),
				})
			}

			try {
				const dispatch = dispatchOverride ?? this._dispatch
				const dispatched = (await dispatch(request)) as ConduitResponse<T>
				const response = redactResponse(dispatched, config.redact)

				if (watched) {
					this._events.emit('request:settle', {
						type: 'request:settle',
						request: exposedRequest,
						response,
						duration: elapsed() - started,
						at: Date.now(),
					})
				}

				return response
			} catch (cause) {
				const error = toConduitError(cause)

				if (watched) {
					this._events.emit('request:error', {
						type: 'request:error',
						request: exposedRequest,
						error,
						duration: elapsed() - started,
						at: Date.now(),
					})
				}

				throw error
			} finally {
				composed.release()
			}
		}

		return conduitPromise(run())
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
export function createClient(config?: ClientConfig): Client {
	return new Client(config)
}
