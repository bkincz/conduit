import { toConduitError, type ConduitError } from '../errors'
import type { EventBus, Unsubscribe } from '../events'
import type {
	ClientContext,
	ConduitPromise,
	ConduitRequest,
	Middleware,
	Plugin,
	RequestOptions,
} from '../types'

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
 * Everything backend-specific about a session.
 *
 * conduit owns the parts that are hard and shared — single-flight loading, one
 * state for every bundle on the page, expiry-driven revalidation, and exactly
 * one terminal handoff no matter how many requests fail at once. The adapter
 * owns the parts that differ per backend, and nothing else needs to change when
 * the backend does.
 *
 * A cookie-session backend implements `load` and nothing else. A token backend
 * adds `authorize` and `renew`.
 */
export interface SessionAdapter<S = unknown> {
	/** Reads the current session. `null` means signed out, which is not an error. */
	load(ctx: AdapterContext): Promise<S | null>
	/**
	 * Attaches credentials to an outgoing request.
	 *
	 * If what you attach can differ between callers of the *same* client, patch
	 * `variance` too — otherwise two callers with different credentials share one
	 * cache entry. A token drawn from this shared session is the same for
	 * everyone, so the common case needs nothing.
	 */
	authorize?(request: ConduitRequest, session: S | null): ConduitRequest | void
	/** Whether a failure means the session is at fault. Defaults to HTTP 401. */
	isUnauthenticated?(error: ConduitError): boolean
	/** Epoch milliseconds, driving a re-read before the session lapses. */
	expiresAt?(session: S): number | undefined
	/** Attempts recovery. `false` gives up. Absent means unauthenticated is terminal. */
	renew?(ctx: AdapterContext): Promise<boolean>
}

/*
 *   STATE
 ***************************************************************************************************/
export type SessionStatus = 'unknown' | 'loading' | 'authenticated' | 'anonymous'

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
	/**
	 * Called once, when the session is gone and cannot be recovered. Everything
	 * in flight has already been aborted by the time it runs.
	 */
	onUnauthenticated?: (error: ConduitError) => void
	/** Read the session as soon as the plugin installs. Defaults to false. */
	eager?: boolean
	/** Re-read this long before `expiresAt`. Defaults to 60 seconds. */
	refreshLeeway?: number
}

/** Marks conduit's own session traffic, so the middleware ignores it. */
export const SESSION_META = 'conduit.session'

const UNAUTHORISED = 401

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * One session, shared by every bundle on the page.
 *
 * The failure this exists to prevent: four remotes hit a 401 at the same
 * moment, four recoveries run concurrently, and a backend that rotates its
 * refresh token invalidates three of them — signing the user out for having too
 * many tabs open. Recovery here is single-flight, and the terminal handoff runs
 * exactly once no matter how many requests were in the air.
 *
 * Sits inside cache and dedupe so a served hit costs nothing, and outside retry
 * so a recovery replays a request that has already exhausted its own attempts.
 */
export function session<S = unknown>(config: SessionConfig<S>): Plugin<SessionApi<S>> {
	const adapter = config.adapter
	const leeway = config.refreshLeeway ?? 60_000
	const listeners = new Set<(state: SessionState<S>) => void>()
	const lifetime = new AbortController()

	let state: SessionState<S> = { status: 'unknown', session: null, error: null, updatedAt: 0 }
	let loading: Promise<S | null> | undefined
	let renewing: Promise<boolean> | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let terminated = false
	let context: ClientContext | undefined
	let events: EventBus | undefined

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

	const schedule = (value: S | null): void => {
		clearTimeout(timer)
		timer = undefined

		if (value === null || adapter.expiresAt === undefined) {
			return
		}

		const expires = adapter.expiresAt(value)

		if (expires === undefined) {
			return
		}

		// A backend that rolls expiry on access turns this into a keep-alive; one
		// that does not gets a re-read just before the session lapses, rather than
		// the user discovering it through a failed action.
		timer = setTimeout(
			() => {
				void reload().catch(() => {})
			},
			Math.max(0, expires - Date.now() - leeway)
		)
	}

	const adapterContext: AdapterContext = {
		request: <T>(path: string, options?: RequestOptions): ConduitPromise<T> => {
			if (context === undefined) {
				throw new Error('The session plugin was used before it was installed.')
			}

			return context.request<T>(path, {
				...options,
				lane: options?.lane ?? 'critical',
				meta: { ...options?.meta, [SESSION_META]: true },
			})
		},
		signal: lifetime.signal,
	}

	const run = async (): Promise<S | null> => {
		publish({ ...state, status: 'loading', updatedAt: Date.now() })

		try {
			const value = await adapter.load(adapterContext)

			terminated = false
			publish({
				status: value === null ? 'anonymous' : 'authenticated',
				session: value,
				error: null,
				updatedAt: Date.now(),
			})
			schedule(value)

			return value
		} catch (cause) {
			const error = toConduitError(cause)

			publish({ status: 'unknown', session: null, error, updatedAt: Date.now() })

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

	const terminate = (error: ConduitError): void => {
		if (terminated) {
			return
		}

		terminated = true
		clearTimeout(timer)
		timer = undefined

		publish({ status: 'anonymous', session: null, error, updatedAt: Date.now() })

		// Ordered deliberately: stop the doomed traffic first, then hand over. The
		// callback usually navigates away, and twenty failing requests racing a
		// redirect help nobody.
		context?.abortAll('The session is gone.')
		config.onUnauthenticated?.(error)
	}

	const isUnauthenticated = (error: ConduitError): boolean =>
		adapter.isUnauthenticated !== undefined
			? adapter.isUnauthenticated(error)
			: error.code === 'HTTP_ERROR' && error.status === UNAUTHORISED

	const renew = (): Promise<boolean> => {
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

	const middleware: Middleware = async (request, next) => {
		if (request.meta[SESSION_META] === true) {
			return next(request)
		}

		if (adapter.authorize !== undefined && state.status === 'unknown') {
			// A token backend cannot send anything useful until it knows the token.
			// A cookie backend has no authorize, so it never pays this wait.
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

			// Re-authorised against the new session, and replayed once rather than
			// in a loop: if a freshly renewed session is still rejected, the
			// problem is not the session.
			return await next(authorize(request))
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
			publish({ status: 'unknown', session: null, error: null, updatedAt: Date.now() })
		},
	}

	return {
		name: 'session',
		middleware,
		onInit: ctx => {
			context = ctx
			events = ctx.events

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
