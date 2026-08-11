import type { ConduitError } from './errors'
import type { EventBus } from './events'

/*
 *   UTILITY
 ***************************************************************************************************/
export type EmptyExtension = Record<never, never>

/**
 * A union that still autocompletes. `T | string` collapses to `string` and loses
 * every suggestion; intersecting the open half with an empty object keeps the
 * literals visible to the editor while accepting any string.
 */
export type LiteralUnion<T extends string> = T | (string & Record<never, never>)

/*
 *   HTTP
 ***************************************************************************************************/
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/**
 * Methods a compliant server treats as repeatable, so conduit may replay them
 * after a failure. `POST` and `PATCH` are absent deliberately: retrying them
 * risks doing the thing twice.
 */
export const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'OPTIONS',
])

/*
 *   SCHEDULING
 ***************************************************************************************************/
/**
 * Scheduling priority, honoured by the queue plugin. The three conduit ships
 * cover the shapes a composed frontend actually has — a host's boot path, a
 * remote's own work, and speculative warming — but the type stays open.
 */
export type Lane = LiteralUnion<'critical' | 'default' | 'prefetch'>

/*
 *   IDENTITY
 ***************************************************************************************************/
/**
 * Which headers take part in a request's identity.
 *
 * `'*'` — the default — means all of them. It is the safe default rather than
 * the fast one: a shared client serving two remotes that differ only by an
 * `Authorization` or tenant header must not collide, and a library cannot know
 * which of your headers change the response.
 *
 * Narrow it to a list once you know (`['authorization', 'x-tenant']`), or pass
 * `[]` to key on URL alone. Beware a header that is unique per request — a
 * request id, a trace parent — under `'*'`: it makes every key unique, so
 * nothing ever hits the cache or shares a flight.
 */
export type Vary = '*' | readonly string[]

/*
 *   REQUEST INPUT
 ***************************************************************************************************/
export type QueryValue =
	string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>

export type Query = Readonly<Record<string, QueryValue>>

export type PathParams = Readonly<Record<string, string | number>>

/** How to decode a response body. `auto` reads the content type. */
export type ParseMode = 'auto' | 'json' | 'text' | 'blob' | 'arrayBuffer' | 'formData' | 'none'

export interface RequestOptions {
	method?: HttpMethod
	/** Fills `:name` placeholders in the path. Missing ones are a config error, not a 404. */
	params?: PathParams
	query?: Query
	/**
	 * Anything that is not already a `BodyInit` is JSON-encoded, and the content
	 * type set to match. Pass a `FormData` or `Blob` to opt out.
	 */
	body?: unknown
	headers?: HeadersInit
	signal?: AbortSignal
	/** Overrides the derived cache/dedupe key. Rarely needed; derivation is stable. */
	key?: string
	lane?: Lane
	owner?: string
	tags?: readonly string[]
	parse?: ParseMode
	credentials?: RequestCredentials
	/** Plugin scratch space. Carried through the pipeline untouched by the core. */
	meta?: Record<string, unknown>
}

/** `RequestOptions` minus the parts a method helper already decides for you. */
export type MethodOptions = Omit<RequestOptions, 'method' | 'body'>

/*
 *   REQUEST RECORD
 ***************************************************************************************************/
/**
 * The fully resolved request travelling through the pipeline. Every field is
 * materialised — middleware never has to re-derive or default anything.
 *
 * `headers` is a lazy getter: a cache hit answers from the key alone and should
 * not pay to build a `Headers` instance it will throw away.
 */
export interface ConduitRequest {
	readonly url: string
	readonly method: HttpMethod
	readonly headers: Headers
	readonly body: BodyInit | null
	readonly signal: AbortSignal
	readonly key: string
	/**
	 * Pre-hashed identity beyond method, URL and body — the headers that `vary`
	 * selects, plus the credential mode. Carried so a middleware rewriting the
	 * request can recompute a key without the header source it no longer holds.
	 */
	readonly variance: string
	readonly lane: Lane
	readonly owner: string | undefined
	readonly tags: readonly string[]
	readonly parse: ParseMode
	readonly credentials: RequestCredentials | undefined
	/** Mutable by design: plugins stash state here across the onion. */
	readonly meta: Record<string, unknown>
}

/**
 * Fields a middleware may legitimately rewrite before passing the request on.
 *
 * Patching `url`, `method`, `body` or `variance` re-derives `key` unless the
 * patch sets one explicitly — a rewritten request that kept its old identity
 * would be cached and deduped as the request it used to be.
 */
export type RequestPatch = Partial<
	Pick<
		ConduitRequest,
		| 'url'
		| 'method'
		| 'body'
		| 'signal'
		| 'key'
		| 'variance'
		| 'lane'
		| 'owner'
		| 'tags'
		| 'parse'
	>
> & {
	headers?: Headers
}

/*
 *   RESPONSE
 ***************************************************************************************************/
export type ResponseSource = 'network' | 'cache' | 'dedupe' | 'mock'

export interface ConduitResponse<T = unknown> {
	readonly status: number
	readonly headers: Headers
	readonly data: T
	/**
	 * The underlying `Response`, when there was one. Absent for anything served
	 * from cache, dedupe or a mock — those never touched the network.
	 */
	readonly raw: Response | undefined
	readonly from: ResponseSource
	/** 1 for a first attempt; the retry plugin raises it on each replay. */
	readonly attempt: number
	readonly request: ConduitRequest
}

/**
 * Result-style outcome from `.safe()`, discriminated on `error`. Narrowing on
 * `error === null` gives you a non-null `data` without an assertion.
 */
export type SafeResult<T> =
	| { readonly data: T; readonly error: null }
	| { readonly data: null; readonly error: ConduitError }

/*
 *   PIPELINE
 ***************************************************************************************************/
export type Next = (req: ConduitRequest) => Promise<ConduitResponse>

/**
 * An onion layer. Call `next` to continue inward, return without calling it to
 * short-circuit — which is how cache and dedupe avoid the network entirely.
 */
export type Middleware = (req: ConduitRequest, next: Next) => Promise<ConduitResponse>

export interface Plugin<Ext extends object = EmptyExtension> {
	readonly name: string
	readonly middleware?: Middleware
	/** Whatever this returns is merged onto the client by `.with()` and shows up in its type. */
	onInit?(ctx: ClientContext): Ext | void
	onDestroy?(): void
}

/*
 *   CLIENT
 ***************************************************************************************************/
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ClientConfig {
	/** Prefixed to every relative path. Absolute URLs bypass it. */
	baseUrl?: string
	/**
	 * Applied to every request. Pass a function when the value changes at
	 * runtime — a tenant id, a locale — and it is read per request rather than
	 * frozen at construction.
	 */
	headers?: HeadersInit | (() => HeadersInit)
	credentials?: RequestCredentials
	/** Which headers take part in request identity. Defaults to `'*'` — see {@link Vary}. */
	vary?: Vary
	/** Identifies the app or remote issuing requests; surfaces in devtools and errors. */
	owner?: string
	/** Default lane for requests that do not pick one. */
	lane?: Lane
	/** Default parse mode for responses that do not pick one. */
	parse?: ParseMode
	/** Swap the network implementation — tests, instrumentation, a non-browser host. */
	fetch?: FetchLike
}

export interface ResolvedClientConfig {
	readonly baseUrl: string
	readonly headers: (() => HeadersInit) | undefined
	readonly credentials: RequestCredentials | undefined
	readonly vary: Vary
	readonly owner: string | undefined
	readonly lane: Lane
	readonly parse: ParseMode
	readonly fetch: FetchLike
}

/** What a plugin is handed at install time. */
export interface ClientContext {
	readonly config: ResolvedClientConfig
	/** The client's event stream. Subscribe to it, or emit your own plugin's events onto it. */
	readonly events: EventBus
	/** Re-enters the full pipeline. Guard against recursion via `meta` if your plugin can see its own call. */
	request<T = unknown>(path: string, options?: RequestOptions): ConduitPromise<T>
	/**
	 * Cancels everything in flight, across every scope.
	 *
	 * For a plugin that has learned nothing else can succeed — a session that is
	 * gone and cannot be recovered. Firing the twenty requests already queued
	 * only produces twenty more failures.
	 */
	abortAll(reason?: string): void
}

/*
 *   PROMISE
 ***************************************************************************************************/
/**
 * A real promise of the decoded body, with two extra ways to take the same
 * outcome:
 *
 * ```ts
 * const user = await api.get<User>('/users/:id', { params: { id } })
 * const res = await api.get<User>('/users/1').response()   // status, headers, source
 * const { data, error } = await api.get<User>('/users/1').safe()
 * ```
 */
export interface ConduitPromise<T> extends Promise<T> {
	/** The full response record rather than just the body. */
	response(): Promise<ConduitResponse<T>>
	/** Never rejects; returns the failure as a value instead. */
	safe(): Promise<SafeResult<T>>
}

export interface RequestMethods {
	request<T = unknown>(path: string, options?: RequestOptions): ConduitPromise<T>
	get<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T>
	head<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T>
	delete<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T>
	post<T = unknown>(path: string, body?: unknown, options?: MethodOptions): ConduitPromise<T>
	put<T = unknown>(path: string, body?: unknown, options?: MethodOptions): ConduitPromise<T>
	patch<T = unknown>(path: string, body?: unknown, options?: MethodOptions): ConduitPromise<T>
}
