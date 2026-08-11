import { encodeBody, type EncodedBody } from './body'
import { ConduitError, toConduitError } from './errors'
import { createEventBus, elapsed, type EventBus } from './events'
import { deriveKey, deriveVariance } from './keys'
import { bodyOptions } from './methods'
import { compose } from './pipeline'
import { conduitPromise } from './promise'
import { createRequest } from './request'
import { createScope, type Scope } from './scopes'
import { composeSignals } from './signals'
import { createFetchTransport } from './transport'
import { buildUrl } from './url'
import type {
	ClientConfig,
	ClientContext,
	ConduitPromise,
	ConduitResponse,
	FetchLike,
	HttpMethod,
	MethodOptions,
	Middleware,
	Next,
	Plugin,
	RequestMethods,
	RequestOptions,
	ResolvedClientConfig,
} from './types'

/*
 *   CONFIG
 ***************************************************************************************************/
const EMPTY_TAGS: readonly string[] = Object.freeze([])

function defaultFetch(): FetchLike {
	if (typeof globalThis.fetch !== 'function') {
		throw new ConduitError({
			code: 'CONFIG',
			message:
				'No global fetch was found. Pass one as config.fetch — conduit does not ship a polyfill.',
		})
	}

	// Bound rather than referenced: an unbound fetch throws "Illegal invocation"
	// in browsers when called without its global receiver.
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

	// Only fills a gap: a caller who set their own content type meant it.
	if (contentType !== undefined && !headers.has('content-type')) {
		headers.set('content-type', contentType)
	}

	return headers
}

/*
 *   CLIENT
 ***************************************************************************************************/
export class Client implements RequestMethods {
	private readonly _config: ResolvedClientConfig
	private readonly _transport: Next
	private readonly _context: ClientContext
	private readonly _events: EventBus = createEventBus()
	private readonly _plugins: Plugin<object>[] = []
	private readonly _middlewares: Middleware[] = []
	private readonly _scopes: Set<Scope> = new Set()
	private _dispatch: Next
	private _root: AbortController = new AbortController()
	private _destroyed = false

	constructor(config: ClientConfig = {}) {
		this._config = resolveConfig(config)
		this._transport = createFetchTransport(this._config)
		this._dispatch = this._transport
		this._context = {
			config: this._config,
			events: this._events,
			request: <T>(path: string, options?: RequestOptions): ConduitPromise<T> =>
				this.request<T>(path, options),
			abortAll: (reason?: string): void => {
				this.abortAll(reason)
			},
		}
	}

	public get config(): ResolvedClientConfig {
		return this._config
	}

	/** Whether {@link destroy} has run. A shared registry checks this before handing the client on. */
	public isDestroyed(): boolean {
		return this._destroyed
	}

	/**
	 * The key a request *would* get, without issuing it.
	 *
	 * Framework bindings need to name a query before running it, and callers
	 * invalidating by hand should not have to reconstruct the string:
	 * `api.invalidate(api.keyFor('/users/:id', { params: { id } }))`.
	 */
	public keyFor(path: string, options: RequestOptions = {}): string {
		return this._prepare(path, options).key
	}

	/**
	 * Every request start, settle and failure, plus whatever plugins publish.
	 *
	 * Because one client is shared across bundles, this is the single place that
	 * sees traffic from every remote on the page — which is what makes "who
	 * issued this" answerable at all. Devtools and telemetry bridges read it;
	 * conduit depends on neither.
	 */
	public get events(): EventBus {
		return this._events
	}

	/*
	 * PLUGINS
	 */
	/**
	 * Installs a plugin and merges whatever it returns onto the client, so the
	 * extension shows up in the type: `client.invalidate()` does not compile
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
			// Composed here, once, rather than per request.
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

	/*
	 * SCOPES
	 */
	/**
	 * Opens a cancellation boundary. Requests made through it carry `name` as
	 * their owner, so devtools and errors can say which app issued them.
	 */
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

	/**
	 * Cancels everything in flight, across every scope.
	 *
	 * This is the terminal-session path: when a session is gone and cannot be
	 * recovered, firing the twenty requests already queued only produces twenty
	 * more failures. Existing scopes are spent afterwards — open new ones.
	 */
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

		// Reverse order, so a plugin tears down before anything it was installed on top of.
		for (let index = this._plugins.length - 1; index >= 0; index--) {
			this._plugins[index]?.onDestroy?.()
		}

		this._plugins.length = 0
		this._middlewares.length = 0
		this._dispatch = this._transport

		if (this._events.active) {
			this._events.emit('client:destroy', { type: 'client:destroy', at: Date.now() })
		}

		this._events.clear()
	}

	/*
	 * INTERNALS
	 */
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
		configHeaders: HeadersInit | undefined
		key: string
	} {
		const config = this._config
		const method = options.method ?? 'GET'
		const url = buildUrl(config.baseUrl, path, options.params, options.query)
		const encoded = encodeBody(options.body)
		const credentials = options.credentials ?? config.credentials

		// Read once, here: the header source feeds request identity as well as the
		// request itself, and calling it twice could see two tenants. Building the
		// Headers instance from it stays deferred.
		const configHeaders = config.headers?.()
		const variance = deriveVariance(configHeaders, options.headers, config.vary, credentials)

		return {
			method,
			url,
			encoded,
			variance,
			credentials,
			configHeaders,
			key: options.key ?? deriveKey({ method, url, body: encoded.body, variance }),
		}
	}

	private _execute<T>(
		path: string,
		options: RequestOptions,
		scopeSignal: AbortSignal | undefined,
		scopeOwner: string | undefined
	): ConduitPromise<T> {
		const run = async (): Promise<ConduitResponse<T>> => {
			this._assertAlive()

			const config = this._config
			const { method, url, encoded, variance, credentials, configHeaders, key } =
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
				parse: options.parse ?? config.parse,
				credentials,
				// Copied, not aliased: the pipeline writes scratch state here, and a
				// caller's options object must not come back mutated — or, if it was
				// frozen, take the request down with it.
				meta: options.meta === undefined ? {} : { ...options.meta },
				buildHeaders: () =>
					buildHeaders(configHeaders, options.headers, encoded.contentType),
			})

			// Nothing subscribes in production, so the whole instrumentation path
			// is one boolean check when idle.
			const watched = this._events.active
			const started = watched ? elapsed() : 0

			if (watched) {
				this._events.emit('request:start', {
					type: 'request:start',
					request,
					at: Date.now(),
				})
			}

			try {
				const response = (await this._dispatch(request)) as ConduitResponse<T>

				if (watched) {
					this._events.emit('request:settle', {
						type: 'request:settle',
						request,
						response,
						duration: elapsed() - started,
						at: Date.now(),
					})
				}

				return response
			} catch (cause) {
				// Plugins can throw anything; callers should only ever see one shape.
				const error = toConduitError(cause)

				if (watched) {
					this._events.emit('request:error', {
						type: 'request:error',
						request,
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
