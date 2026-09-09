import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { Client } from './client/core'
import { resolveEndpointTags, type Endpoint } from './client/endpoint'
import { composeSignals } from './http/signals'
import { CACHE_META, type CacheApi } from './plugins/cache'
import { DEV } from './primitives/dev'
import type { ConduitError } from './primitives/errors'
import type { ObservableApi, QueryState, QueryStatus } from './plugins/observable'
import type { SessionApi, SessionState } from './plugins/session'
import type { ReadableStore } from './primitives/stores'
import type { MethodOptions, ResponseSource } from './primitives/types'

/*
 *   TYPES
 ***************************************************************************************************/
export interface UseRequestOptions extends MethodOptions {
	/** Hold off until a dependency is ready. Defaults to true. */
	enabled?: boolean
	/** Keep the last successful answer on screen while a new key's first fetch is in flight. Defaults to false. */
	keepPreviousData?: boolean
	/** Refetch when the tab regains focus. Defaults to false. */
	refetchOnFocus?: boolean
	/** Refetch when the connection comes back. Defaults to false. */
	refetchOnReconnect?: boolean
}

export interface UseRequestResult<T> {
	data: T | undefined
	error: ConduitError | undefined
	status: QueryStatus
	/** No data yet and a request is in the air. */
	isLoading: boolean
	/** A request is in the air, with or without data on screen. */
	isFetching: boolean
	/** The last answer came from cache. */
	isStale: boolean
	refetch(): Promise<void>
}

export interface UseMutationOptions<V> {
	/** Tags to invalidate once `mutate` succeeds. Needs the cache plugin. */
	invalidates?: readonly string[] | ((variables: V) => readonly string[])
}

export interface UseMutationResult<T, V> {
	mutate(variables: V): Promise<T | undefined>
	data: T | undefined
	/** Whatever `mutate`'s function rejected with. Not assumed to be a `ConduitError`. */
	error: unknown
	isPending: boolean
	reset(): void
}

export interface Hooks {
	/**
	 * Runs a request and renders its state, keyed the way the cache and dedupe
	 * key it.
	 *
	 * A client `headers` function that answers differently per call gives every
	 * render a different key under `vary: '*'`, and this refetches on each one.
	 * Development warns when that happens.
	 */
	useRequest<T = unknown>(path: string, options?: UseRequestOptions): UseRequestResult<T>
	useRequest<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		vars: Vars,
		options?: UseRequestOptions
	): UseRequestResult<Result>
	useMutation<T = unknown, V = void>(
		run: (variables: V) => PromiseLike<T>,
		options?: UseMutationOptions<V>
	): UseMutationResult<T, V>
	useMutation<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		options?: UseMutationOptions<Vars>
	): UseMutationResult<Result, Vars>
	/** Returns a warm-the-cache function that runs in the prefetch lane. */
	usePrefetch(): (path: string, options?: MethodOptions) => void
}

export interface SessionHooks<S> {
	useSession(): SessionState<S>
}

/*
 *   DISABLED SNAPSHOT
 ***************************************************************************************************/
/** What a disabled or key-less query renders, without a store to read from. */
const DISABLED_STATE: QueryState<never> = {
	status: 'idle',
	data: undefined,
	error: undefined,
	from: undefined,
	fetching: false,
	updatedAt: 0,
	invalidatedAt: 0,
}

const disabledStore: ReadableStore<QueryState<never>> = {
	get: () => DISABLED_STATE,
	subscribe: () => () => {},
}

/*
 *   SHARED QUERY STATE
 ***************************************************************************************************/
/** What either call form normalises into, so one implementation drives both. */
interface RequestDescriptor {
	/** `undefined` when disabled, or when deriving it failed — never thrown from render. */
	key: string | undefined
	enabled: boolean
	run(opts: { signal: AbortSignal; refresh: boolean }): Promise<void>
}

interface PreviousSnapshot<T> {
	key: string
	data: T | undefined
	error: ConduitError | undefined
	status: QueryStatus
	from: ResponseSource | undefined
}

function useRequestCore<T>(
	client: ObservableApi,
	descriptor: RequestDescriptor,
	config: { keepPreviousData: boolean; refetchOnFocus: boolean; refetchOnReconnect: boolean }
): UseRequestResult<T> {
	const { key, enabled, run } = descriptor
	const { keepPreviousData, refetchOnFocus, refetchOnReconnect } = config

	const store = useMemo(
		() => (key === undefined ? undefined : client.observe<T>(key)),
		[client, key]
	)
	const activeStore = (store ?? disabledStore) as ReadableStore<QueryState<T>>
	const state = useSyncExternalStore(activeStore.subscribe, activeStore.get, activeStore.get)

	const latestRun = useRef(run)

	useEffect(() => {
		latestRun.current = run
	})

	const inFlight = useRef<AbortController | undefined>(undefined)

	const execute = useCallback(
		async (refresh: boolean): Promise<void> => {
			if (key === undefined) {
				return
			}

			inFlight.current?.abort()

			const controller = new AbortController()
			inFlight.current = controller

			await latestRun.current({ signal: controller.signal, refresh })
		},
		[key]
	)

	const refetch = useCallback((): Promise<void> => execute(true), [execute])

	useEffect(() => {
		if (!enabled) {
			return
		}

		void execute(false)

		return () => inFlight.current?.abort()
	}, [execute, enabled, state.invalidatedAt])

	useEffect(() => {
		if (!refetchOnFocus || typeof document === 'undefined') {
			return
		}

		const onFocus = (): void => {
			if (document.visibilityState === 'visible') {
				void refetch()
			}
		}

		document.addEventListener('visibilitychange', onFocus)
		window.addEventListener('focus', onFocus)

		return () => {
			document.removeEventListener('visibilitychange', onFocus)
			window.removeEventListener('focus', onFocus)
		}
	}, [refetchOnFocus, refetch])

	useEffect(() => {
		if (!refetchOnReconnect || typeof window === 'undefined') {
			return
		}

		const onOnline = (): void => void refetch()

		window.addEventListener('online', onOnline)

		return () => window.removeEventListener('online', onOnline)
	}, [refetchOnReconnect, refetch])

	const [previous, setPrevious] = useState<PreviousSnapshot<T> | undefined>(undefined)

	useEffect(() => {
		if (!keepPreviousData || key === undefined) {
			return
		}

		if (state.status === 'success' || state.status === 'error') {
			setPrevious({
				key,
				data: state.data,
				error: state.error,
				status: state.status,
				from: state.from,
			})
		}
	}, [keepPreviousData, key, state.status, state.data, state.error, state.from])

	const showPrevious =
		keepPreviousData &&
		previous !== undefined &&
		key !== undefined &&
		previous.key !== key &&
		state.data === undefined &&
		state.status !== 'success'

	const view =
		showPrevious && previous !== undefined
			? {
					data: previous.data,
					error: previous.error,
					status: previous.status,
					from: previous.from,
					fetching: true,
				}
			: {
					data: state.data,
					error: state.error,
					status: state.status,
					from: state.from,
					fetching: state.fetching,
				}

	return {
		data: view.data,
		error: view.error,
		status: view.status,
		// Idle with a key and enabled means the first fetch is about to start.
		isLoading:
			view.data === undefined &&
			(view.fetching || (enabled && key !== undefined && view.status === 'idle')),
		isFetching: view.fetching,
		isStale: view.from === 'cache',
		refetch,
	}
}

/*
 *   MUTATION TAGS
 ***************************************************************************************************/
function invalidateTags(
	client: Partial<CacheApi>,
	tags: readonly string[] | ((variables: unknown) => readonly string[]) | undefined,
	variables: unknown
): void {
	const resolved = resolveEndpointTags(tags, variables)

	if (resolved === undefined) {
		return
	}

	for (const tag of resolved) {
		client.invalidateTag?.(tag)
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
/**
 * Binds the hooks to one client, at module scope rather than through a
 * provider. Context does not cross a federation boundary; a shared client does.
 *
 * ```ts
 * export const { useRequest, useSession } = createHooks(api)
 * ```
 */
export function createHooks<S>(
	client: Client & ObservableApi & SessionApi<S>
): Hooks & SessionHooks<S>
export function createHooks(client: Client & ObservableApi): Hooks
export function createHooks(
	client: Client & ObservableApi & Partial<SessionApi<unknown>> & Partial<CacheApi>
): Hooks & Partial<SessionHooks<unknown>> {
	/*
	 * REQUEST — path form
	 */
	function useRequestByPath<T>(path: string, options: UseRequestOptions): UseRequestResult<T> {
		const {
			enabled = true,
			keepPreviousData = false,
			refetchOnFocus = false,
			refetchOnReconnect = false,
			...request
		} = options

		const latestRequest = useRef(request)

		useEffect(() => {
			latestRequest.current = request
		})

		let key: string | undefined

		try {
			key = enabled ? client.keyFor(path, request) : undefined
		} catch {
			key = undefined
		}

		const warnedRef = useRef(false)

		useEffect(() => {
			if (!DEV || warnedRef.current || key === undefined) {
				return
			}

			warnedRef.current = true

			if (client.keyFor(path, request) !== key) {
				console.warn(
					`[conduit] useRequest("${path}") derived two different keys in one render, so the client's headers function answers differently per call — a rotating token, a request id, a trace parent. Under vary: '*' that makes every request unique: nothing hits the cache, nothing shares a flight, and this hook refetches on every render. Narrow vary to the headers that matter (vary: ['authorization']), or keep per-call headers out of the client's headers function.`
				)
			}
		}, [client, path, request, key])

		const descriptor = useMemo<RequestDescriptor>(
			() => ({
				key,
				enabled: enabled && key !== undefined,
				run: async ({ signal, refresh }) => {
					const requestKey = key

					if (requestKey === undefined) {
						return
					}

					const combined = composeSignals([latestRequest.current.signal, signal])
					const meta = refresh
						? { ...latestRequest.current.meta, [CACHE_META]: 'refresh' }
						: latestRequest.current.meta

					try {
						await client
							.request<T>(path, {
								...latestRequest.current,
								key: requestKey,
								signal: combined.signal,
								...(meta === undefined ? {} : { meta }),
							})
							.safe()
					} finally {
						combined.release()
					}
				},
			}),
			[path, key, enabled]
		)

		return useRequestCore<T>(client, descriptor, {
			keepPreviousData,
			refetchOnFocus,
			refetchOnReconnect,
		})
	}

	/*
	 * REQUEST — endpoint form
	 */
	function useRequestByEndpoint<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		vars: Vars,
		options: UseRequestOptions
	): UseRequestResult<Result> {
		const {
			enabled = true,
			keepPreviousData = false,
			refetchOnFocus = false,
			refetchOnReconnect = false,
			...overrides
		} = options

		const latestVars = useRef(vars)
		const latestOverrides = useRef(overrides)

		useEffect(() => {
			latestVars.current = vars
			latestOverrides.current = overrides
		})

		let key: string | undefined

		try {
			key = enabled ? client.keyFor(endpoint, vars) : undefined
		} catch {
			key = undefined
		}

		const descriptor = useMemo<RequestDescriptor>(
			() => ({
				key,
				enabled: enabled && key !== undefined,
				run: async ({ signal, refresh }) => {
					const requestKey = key

					if (requestKey === undefined) {
						return
					}

					const combined = composeSignals([latestOverrides.current.signal, signal])
					const meta = refresh
						? { ...latestOverrides.current.meta, [CACHE_META]: 'refresh' }
						: latestOverrides.current.meta

					try {
						await client
							.call(endpoint, latestVars.current, {
								...latestOverrides.current,
								key: requestKey,
								signal: combined.signal,
								...(meta === undefined ? {} : { meta }),
							})
							.safe()
					} finally {
						combined.release()
					}
				},
			}),
			[endpoint, key, enabled]
		)

		return useRequestCore<Result>(client, descriptor, {
			keepPreviousData,
			refetchOnFocus,
			refetchOnReconnect,
		})
	}

	function useRequest<T = unknown>(path: string, options?: UseRequestOptions): UseRequestResult<T>
	function useRequest<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		vars: Vars,
		options?: UseRequestOptions
	): UseRequestResult<Result>
	function useRequest(
		pathOrEndpoint: string | Endpoint<unknown, unknown>,
		varsOrOptions?: unknown,
		maybeOptions?: UseRequestOptions
	): UseRequestResult<unknown> {
		if (typeof pathOrEndpoint === 'string') {
			return useRequestByPath(pathOrEndpoint, (varsOrOptions as UseRequestOptions) ?? {})
		}

		return useRequestByEndpoint(pathOrEndpoint, varsOrOptions, maybeOptions ?? {})
	}

	/*
	 * MUTATION
	 */
	function useMutation<T, V>(
		run: (variables: V) => PromiseLike<T>,
		options?: UseMutationOptions<V>
	): UseMutationResult<T, V>
	function useMutation<Vars, Result>(
		endpoint: Endpoint<Vars, Result>,
		options?: UseMutationOptions<Vars>
	): UseMutationResult<Result, Vars>
	function useMutation(
		runOrEndpoint: ((variables: unknown) => PromiseLike<unknown>) | Endpoint<unknown, unknown>,
		options?: UseMutationOptions<unknown>
	): UseMutationResult<unknown, unknown> {
		const isEndpoint = typeof runOrEndpoint !== 'function'

		const [state, setState] = useState<{
			data: unknown
			error: unknown
			isPending: boolean
		}>({ data: undefined, error: undefined, isPending: false })

		const alive = useRef(true)
		const latest = useRef(runOrEndpoint)
		const latestOptions = useRef(options)

		useEffect(() => {
			latest.current = runOrEndpoint
			latestOptions.current = options
		})

		useEffect(() => {
			alive.current = true

			return () => {
				alive.current = false
			}
		}, [])

		const mutate = useCallback(
			async (variables: unknown): Promise<unknown> => {
				setState(current => ({ ...current, isPending: true, error: undefined }))

				try {
					const current = latest.current
					const data = isEndpoint
						? await client.call(current as Endpoint<unknown, unknown>, variables)
						: await (current as (variables: unknown) => PromiseLike<unknown>)(variables)

					if (alive.current) {
						setState({ data, error: undefined, isPending: false })
					}

					// An endpoint's own tags and any the caller added both apply.
					if (isEndpoint) {
						invalidateTags(
							client,
							(current as Endpoint<unknown, unknown>).invalidates,
							variables
						)
					}
					invalidateTags(client, latestOptions.current?.invalidates, variables)

					return data
				} catch (cause) {
					if (alive.current) {
						setState({ data: undefined, error: cause, isPending: false })
					}

					return undefined
				}
			},
			[isEndpoint]
		)

		const reset = useCallback(() => {
			setState({ data: undefined, error: undefined, isPending: false })
		}, [])

		return { mutate, data: state.data, error: state.error, isPending: state.isPending, reset }
	}

	/*
	 * PREFETCH
	 */
	function usePrefetch(): (path: string, options?: MethodOptions) => void {
		return useCallback((path: string, options?: MethodOptions) => {
			void client.get(path, { ...options, lane: options?.lane ?? 'prefetch' }).safe()
		}, [])
	}

	/*
	 * SESSION
	 */
	function useSession(): SessionState<unknown> {
		const handle = client.session

		if (handle === undefined) {
			throw new Error(
				'useSession needs the session plugin. Install it with .with(session({ adapter })), or via defaults(client, { session }).'
			)
		}

		return useSyncExternalStore(handle.subscribe, handle.get, handle.get)
	}

	return { useRequest, useMutation, usePrefetch, useSession }
}

export type { QueryState, QueryStatus }
