import type { ConduitError } from './errors'
import type { EventBus, Unsubscribe } from './events'

/*
 *   UTILITY
 ***************************************************************************************************/
export type EmptyExtension = Record<never, never>

/** A union that still autocompletes, where `T | string` would collapse to `string`. */
export type LiteralUnion<T extends string> = T | (string & Record<never, never>)

/*
 *   HTTP
 ***************************************************************************************************/
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/** Methods conduit may replay after a failure. `POST` and `PATCH` are absent deliberately. */
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
/** Scheduling priority for the queue plugin. The three shipped are a suggestion, not a limit. */
export type Lane = LiteralUnion<'critical' | 'default' | 'prefetch'>

/*
 *   IDENTITY
 ***************************************************************************************************/
/**
 * Which headers take part in a request's identity. `'*'` is every header, `[]`
 * is none.
 *
 * A header that is unique per request, such as a trace id, gives every request
 * its own key under `'*'`, so nothing hits the cache or shares a flight.
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
	/** Fills `:name` placeholders. A missing one is a config error, not a 404. */
	params?: PathParams
	query?: Query
	/** JSON-encoded with a matching content type unless it is already a `BodyInit`. */
	body?: unknown
	headers?: HeadersInit
	signal?: AbortSignal
	/** Overrides the derived cache and dedupe key. */
	key?: string
	lane?: Lane
	owner?: string
	tags?: readonly string[]
	parse?: ParseMode
	credentials?: RequestCredentials
	/** Plugin scratch space, carried through the pipeline untouched by the core. */
	meta?: Record<string, unknown>
}

/** `RequestOptions` minus the parts a method helper already decides for you. */
export type MethodOptions = Omit<RequestOptions, 'method' | 'body'>

/*
 *   REQUEST RECORD
 ***************************************************************************************************/
/** The resolved request every middleware sees. */
export interface ConduitRequest {
	readonly url: string
	readonly method: HttpMethod
	readonly headers: Headers
	readonly body: BodyInit | null
	readonly signal: AbortSignal
	readonly key: string
	/** Pre-hashed identity beyond method, url and body, so a rewrite can recompute its key. */
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
 * Fields a middleware may rewrite before passing the request on.
 *
 * Patching `url`, `method`, `body`, `variance` or `parse` re-derives `key`
 * unless the patch sets one. `meta` is replaced wholesale rather than merged.
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
		| 'meta'
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
	/** Absent for anything served from cache, dedupe or a mock. */
	readonly raw: Response | undefined
	readonly from: ResponseSource
	/** 1 for a first attempt. The retry plugin raises it on each replay. */
	readonly attempt: number
	readonly request: ConduitRequest
}

/** Discriminated on `error`, so `error === null` narrows `data` to non-null. */
export type SafeResult<T> =
	| { readonly data: T; readonly error: null }
	| { readonly data: null; readonly error: ConduitError }

/*
 *   PIPELINE
 ***************************************************************************************************/
export type Next = (req: ConduitRequest) => Promise<ConduitResponse>

/** An onion layer. Return without calling `next` to short-circuit. */
export type Middleware = (req: ConduitRequest, next: Next) => Promise<ConduitResponse>

export interface Plugin<Ext extends object = EmptyExtension> {
	readonly name: string
	readonly middleware?: Middleware
	/** Merged onto the client by `.with()`, and shows up in its type. */
	onInit?(ctx: ClientContext): Ext | void
	onDestroy?(): void
}

/*
 *   CLIENT
 ***************************************************************************************************/
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ClientConfig {
	/** Prefixed to every relative path. Absolute urls bypass it. */
	baseUrl?: string
	/** Pass a function for anything that changes at runtime. It is read per request. */
	headers?: HeadersInit | (() => HeadersInit)
	credentials?: RequestCredentials
	/** Which headers take part in request identity. Defaults to `'*'`, see {@link Vary}. */
	vary?: Vary
	/** Names the app or remote issuing requests, in devtools and on errors. */
	owner?: string
	lane?: Lane
	parse?: ParseMode
	/** Swap the network implementation, for tests, instrumentation or a non-browser host. */
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
	readonly events: EventBus
	/** Re-enters the full pipeline from a path. Guard against recursion via `meta`. */
	request<T = unknown>(path: string, options?: RequestOptions): ConduitPromise<T>
	/**
	 * Re-enters the pipeline from the outside with a request that already exists,
	 * so layers above yours see the response. Mark it or your middleware loops.
	 */
	dispatch(request: ConduitRequest): Promise<ConduitResponse>
	/** Cancels everything in flight, across every scope. */
	abortAll(reason?: string): void
	/**
	 * Drops everything held on behalf of whoever was signed in. Identity is
	 * derived before credentials are attached, so cached responses outlive them.
	 */
	resetIdentity(): void
	/** Registers state to drop when {@link ClientContext.resetIdentity} runs. */
	onResetIdentity(listener: () => void): Unsubscribe
}

/*
 *   PROMISE
 ***************************************************************************************************/
/** A promise of the decoded body, with two other ways to take the same outcome. */
export interface ConduitPromise<T> extends Promise<T> {
	/** The full response record rather than just the body. */
	response(): Promise<ConduitResponse<T>>
	/** Never rejects. Returns the failure as a value instead. */
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
