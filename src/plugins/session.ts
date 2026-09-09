import { toConduitError, ConduitError } from '../primitives/errors'
import type { EventBus, Unsubscribe } from '../primitives/events'
import { isAbsoluteUrl } from '../http/url'
import type {
	ClientContext,
	ConduitPromise,
	ConduitRequest,
	Middleware,
	Plugin,
	RequestOptions,
} from '../primitives/types'
import { CACHE_META } from './cache'
import { DEDUPE_META } from './dedupe'

/*
 *   ADAPTER
 ***************************************************************************************************/
export interface AdapterContext {
	/** Issues a request that bypasses this plugin, so loading a session cannot recurse into itself. */
	request<T = unknown>(path: string, options?: RequestOptions): ConduitPromise<T>
	/** Aborts when the plugin is torn down. */
	signal: AbortSignal
}

/**
 * Everything backend-specific about a session. A cookie backend implements
 * `load` and nothing else. A token backend adds `authorize` and `renew`.
 */
export interface SessionAdapter<S = unknown> {
	/** Reads the current session. `null` means signed out, which is not an error. */
	load(ctx: AdapterContext): Promise<S | null>
	/**
	 * Attaches credentials to an outgoing request. Patch `variance` too if what
	 * you attach can differ between callers of the same client.
	 */
	authorize?(request: ConduitRequest, session: S | null): ConduitRequest | void
	/** Whether a failure means the session is at fault. Defaults to HTTP 401. */
	isUnauthenticated?(error: ConduitError): boolean
	/** Epoch milliseconds, driving a re-read before the session lapses. */
	expiresAt?(session: S): number | undefined
	/** Attempts recovery. `false` gives up. Absent means unauthenticated is terminal. */
	renew?(ctx: AdapterContext): Promise<boolean>
	/**
	 * A stable id for whoever is signed in. Compared on every successful `load`
	 * or `renew`; a change resets everything identity-scoped, not only the
	 * authenticated/anonymous flip.
	 */
	identify?(session: S): string | undefined
	/** Called after `clear()` and after a terminal failure, once local state is already gone. */
	onClear?(): void
}

/*
 *   STATE
 ***************************************************************************************************/
export type SessionStatus = 'unknown' | 'loading' | 'authenticated' | 'anonymous' | 'error'

export interface SessionState<S> {
	readonly status: SessionStatus
	readonly session: S | null
	readonly error: ConduitError | null
	readonly updatedAt: number
}

export interface SessionHandle<S> {
	get(): SessionState<S>
	subscribe(listener: (state: SessionState<S>) => void): Unsubscribe
	/** Single-flight. Concurrent callers share one request; a settled session is returned as-is. */
	load(): Promise<S | null>
	/** Ignores what is already known and re-reads. */
	reload(): Promise<S | null>
	/** Drops local state without telling the server. */
	clear(): void
}

export interface SessionApi<S = unknown> {
	session: SessionHandle<S>
}

export interface SessionConfig<S = unknown> {
	adapter: SessionAdapter<S>
	/** Called once, after everything in flight has been aborted and cached data dropped. */
	onUnauthenticated?: (error: ConduitError) => void
	/** Read the session as soon as the plugin installs. Defaults to false. */
	eager?: boolean
	/** Re-read this long before `expiresAt`. Defaults to 60 seconds. */
	refreshLeeway?: number
	/**
	 * Extra origins, beyond the client's own, that also receive credentials.
	 * A request to anything else passes through unauthorized.
	 */
	origins?: readonly string[]
}

export const SESSION_META = 'conduit.session'

const UNAUTHORISED = 401
const MAX_DELAY = 2_147_483_647
const DEFAULT_IDENTITY = 'conduit.session.authenticated'

/*
 *   ORIGIN
 ***************************************************************************************************/
function originOf(url: string): string {
	if (!isAbsoluteUrl(url)) {
		return ''
	}

	try {
		return new URL(url).origin
	} catch {
		return ''
	}
}

function apiOriginFor(baseUrl: string): string {
	if (isAbsoluteUrl(baseUrl)) {
		try {
			return new URL(baseUrl).origin
		} catch {
			return ''
		}
	}

	return typeof location === 'undefined' ? '' : location.origin
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * One session for every bundle on the page. Loading and recovery are
 * single-flight, and the terminal handoff runs once however many requests
 * failed at the same moment.
 */
export function session<S = unknown>(config: SessionConfig<S>): Plugin<SessionApi<S>> {
	const adapter = config.adapter
	const leeway = config.refreshLeeway ?? 60_000
	const extraOrigins = new Set(config.origins ?? [])
	const listeners = new Set<(state: SessionState<S>) => void>()
	const lifetime = new AbortController()

	let state: SessionState<S> = { status: 'unknown', session: null, error: null, updatedAt: 0 }
	let loading: Promise<S | null> | undefined
	let renewing: Promise<boolean> | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let terminated = false
	let terminalError: ConduitError | undefined
	let lastIdentity: string | undefined
	/** Whether a real identity has ever been observed, so the very first load never resets by itself. */
	let identityKnown = false
	let context: ClientContext | undefined
	let events: EventBus | undefined
	let apiOrigin = ''

	const publish = (next: SessionState<S>): void => {
		state = next

		if (events?.active === true) {
			events.emit('session:change', {
				type: 'session:change',
				status: next.status,
				terminal: terminated,
				at: next.updatedAt,
			})
		}

		for (const listener of [...listeners]) {
			try {
				listener(next)
			} catch (error) {
				console.error(
					'[conduit] A session listener threw. The session is unaffected.',
					error
				)
			}
		}
	}

	/** Arms a timer for a delay of any size, in chunks the platform can hold. */
	const arm = (delay: number, run: () => void): void => {
		if (delay > MAX_DELAY) {
			timer = setTimeout(() => arm(delay - MAX_DELAY, run), MAX_DELAY)

			return
		}

		timer = setTimeout(run, Math.max(0, delay))
	}

	const fire = (): void => {
		if (renewing !== undefined) {
			return
		}

		void reload().catch(() => {})
	}

	const schedule = (value: S | null): void => {
		clearTimeout(timer)
		timer = undefined

		if (value === null || adapter.expiresAt === undefined) {
			return
		}

		const expires = adapter.expiresAt(value)

		if (expires === undefined || !Number.isFinite(expires)) {
			return
		}

		const now = Date.now()
		const beforeLeeway = expires - now - leeway

		if (beforeLeeway > 0) {
			arm(beforeLeeway, fire)

			return
		}

		const untilExpiry = expires - now

		if (untilExpiry > 0) {
			arm(untilExpiry, fire)
		}
	}

	const adapterContext: AdapterContext = {
		request: <T>(path: string, options?: RequestOptions): ConduitPromise<T> => {
			if (context === undefined) {
				throw new Error('The session plugin was used before it was installed.')
			}

			return context.request<T>(path, {
				...options,
				lane: options?.lane ?? 'critical',
				meta: {
					...options?.meta,
					[SESSION_META]: true,
					[CACHE_META]: 'bypass',
					[DEDUPE_META]: 'bypass',
				},
			})
		},
		signal: lifetime.signal,
	}

	const run = async (): Promise<S | null> => {
		publish({ ...state, status: 'loading', updatedAt: Date.now() })

		try {
			const value = await adapter.load(adapterContext)
			const signedIn = value !== null

			terminated = false
			terminalError = undefined

			const identity = signedIn ? (adapter.identify?.(value) ?? DEFAULT_IDENTITY) : undefined

			if (identityKnown && identity !== lastIdentity) {
				context?.resetIdentity()
			}

			lastIdentity = identity
			identityKnown = true

			publish({
				status: signedIn ? 'authenticated' : 'anonymous',
				session: value,
				error: null,
				updatedAt: Date.now(),
			})
			schedule(value)

			return value
		} catch (cause) {
			const error = toConduitError(cause)

			publish({ status: 'error', session: state.session, error, updatedAt: Date.now() })

			throw error
		} finally {
			loading = undefined
		}
	}

	const load = (): Promise<S | null> => {
		if (state.status === 'authenticated' || state.status === 'anonymous') {
			return Promise.resolve(state.session)
		}

		loading ??= run()

		return loading
	}

	const reload = (): Promise<S | null> => {
		loading ??= run()

		return loading
	}

	const terminate = (cause: ConduitError): void => {
		if (terminated) {
			return
		}

		terminated = true
		lastIdentity = undefined
		identityKnown = false
		clearTimeout(timer)
		timer = undefined

		const error = new ConduitError({
			code: 'UNAUTHENTICATED',
			message: cause.message,
			...(cause.method !== undefined && { method: cause.method }),
			...(cause.url !== undefined && { url: cause.url }),
			...(cause.status !== undefined && { status: cause.status }),
			owner: cause.owner,
			headers: cause.headers,
			body: cause.body,
			cause,
		})

		terminalError = error

		publish({ status: 'anonymous', session: null, error, updatedAt: Date.now() })

		context?.abortAll('The session is gone.')
		context?.resetIdentity()
		adapter.onClear?.()
		config.onUnauthenticated?.(error)
	}

	const isUnauthenticated = (error: ConduitError): boolean =>
		adapter.isUnauthenticated !== undefined
			? adapter.isUnauthenticated(error)
			: error.code === 'HTTP_ERROR' && error.status === UNAUTHORISED

	const renew = (): Promise<boolean> => {
		if (loading !== undefined) {
			return loading.then(value => value !== null)
		}

		if (adapter.renew === undefined) {
			return Promise.resolve(false)
		}

		renewing ??= adapter
			.renew(adapterContext)
			.then(async recovered => {
				if (recovered) {
					await reload().catch(() => {})
				}

				return recovered
			})
			.catch(() => false)
			.finally(() => {
				renewing = undefined
			})

		return renewing
	}

	const authorize = (request: ConduitRequest): ConduitRequest => {
		if (adapter.authorize === undefined) {
			return request
		}

		return adapter.authorize(request, state.session) ?? request
	}

	const inScope = (request: ConduitRequest): boolean => {
		const target = originOf(request.url)

		return target === '' || target === apiOrigin || extraOrigins.has(target)
	}

	const middleware: Middleware = async (request, next) => {
		if (request.meta[SESSION_META] === true) {
			return next(request)
		}

		if (!inScope(request)) {
			return next(request)
		}

		if (terminated && terminalError !== undefined) {
			throw terminalError
		}

		if (
			adapter.authorize !== undefined &&
			(state.status === 'unknown' || state.status === 'loading')
		) {
			await load().catch(() => {})
		}

		try {
			return await next(authorize(request))
		} catch (cause) {
			const error = toConduitError(cause)

			if (!isUnauthenticated(error)) {
				throw error
			}

			if (adapter.renew === undefined || !(await renew())) {
				terminate(error)
				throw error
			}

			try {
				return await next(authorize(request))
			} catch (replayCause) {
				const replayed = toConduitError(replayCause)

				if (isUnauthenticated(replayed)) {
					terminate(replayed)
				}

				throw replayed
			}
		}
	}

	const handle: SessionHandle<S> = {
		get: () => state,
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		load,
		reload,
		clear: () => {
			clearTimeout(timer)
			timer = undefined
			terminated = false
			terminalError = undefined
			lastIdentity = undefined
			identityKnown = false
			context?.resetIdentity()
			adapter.onClear?.()
			publish({ status: 'unknown', session: null, error: null, updatedAt: Date.now() })
		},
	}

	return {
		name: 'session',
		middleware,
		onInit: ctx => {
			context = ctx
			events = ctx.events
			apiOrigin = apiOriginFor(ctx.config.baseUrl)

			if (config.eager === true) {
				void load().catch(() => {})
			}

			return { session: handle }
		},
		onDestroy: () => {
			clearTimeout(timer)
			timer = undefined
			lifetime.abort()
			listeners.clear()
		},
	}
}
