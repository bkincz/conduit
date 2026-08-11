import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { Client } from './core'
import type { ConduitError } from './errors'
import type { ObservableApi, QueryState, QueryStatus } from './plugins/observable'
import type { SessionApi, SessionState } from './plugins/session'
import type { MethodOptions, RequestOptions } from './types'

/*
 *   TYPES
 ***************************************************************************************************/
export interface UseRequestOptions extends MethodOptions {
	/** Hold off until a dependency is ready. Defaults to true. */
	enabled?: boolean
}

export interface UseRequestResult<T> {
	data: T | undefined
	error: ConduitError | undefined
	status: QueryStatus
	/** No data yet, and a request is in the air. The spinner case. */
	isLoading: boolean
	/** A request is in the air, whether or not something is already on screen. */
	isFetching: boolean
	/** The last answer came from cache, so it may be behind the server. */
	isStale: boolean
	refetch(): Promise<void>
}

export interface UseMutationResult<T, V> {
	mutate(variables: V): Promise<T | undefined>
	data: T | undefined
	error: ConduitError | undefined
	isPending: boolean
	reset(): void
}

export interface Hooks {
	useRequest<T = unknown>(path: string, options?: UseRequestOptions): UseRequestResult<T>
	useMutation<T = unknown, V = void>(
		run: (variables: V) => PromiseLike<T>
	): UseMutationResult<T, V>
	/** Returns a warm-the-cache function that runs in the prefetch lane. */
	usePrefetch(): (path: string, options?: MethodOptions) => void
}

export interface SessionHooks<S> {
	useSession(): SessionState<S>
}

/*
 *   FACTORY
 ***************************************************************************************************/
/**
 * Binds the hooks to one client.
 *
 * There is no provider, deliberately. React context does not cross a federation
 * boundary, so a provider mounted by the host is invisible to a remote — the
 * pattern would look right and silently give each remote its own everything.
 * Binding at the module level instead means every remote that imports this
 * module shares the client the way it shares the cache.
 *
 * ```ts
 * export const { useRequest, useSession } = createHooks(api)
 * ```
 *
 * The session type flows through, so `useSession()` returns your user type
 * without a cast.
 */
export function createHooks<S>(
	client: Client & ObservableApi & SessionApi<S>
): Hooks & SessionHooks<S>
export function createHooks(client: Client & ObservableApi): Hooks
export function createHooks(
	client: Client & ObservableApi & Partial<SessionApi<unknown>>
): Hooks & Partial<SessionHooks<unknown>> {
	/*
	 * REQUEST
	 */
	function useRequest<T>(path: string, options: UseRequestOptions = {}): UseRequestResult<T> {
		const { enabled = true, ...request } = options

		// A string, so it stays stable across the new options object every render
		// produces. This is the dependency everything else keys off.
		const key = client.keyFor(path, request)

		const store = useMemo(() => client.observe<T>(key), [key])
		const state = useSyncExternalStore(store.subscribe, store.get, store.get)

		// Read at call time rather than captured, so a changed header or tag is
		// picked up without making the effect re-run on object identity.
		const latest = useRef<RequestOptions>(request)
		latest.current = request

		// Held in a ref rather than created during render: a scope or a controller
		// built in the render body leaks a second one under StrictMode's double
		// invocation.
		const inFlight = useRef<AbortController | undefined>(undefined)

		const refetch = useCallback(async (): Promise<void> => {
			inFlight.current?.abort()

			const controller = new AbortController()
			inFlight.current = controller

			await client.request<T>(path, { ...latest.current, signal: controller.signal }).safe()
			// `key` is what `path` and the options collapse into, so it is the real
			// dependency; the options object itself is new on every render.
		}, [key, path])

		useEffect(() => {
			if (!enabled) {
				return
			}

			void refetch()

			// Unmounting cancels this component's interest, not everyone's: dedupe
			// counts participants, so a sibling rendering the same query keeps the
			// underlying request alive.
			return () => inFlight.current?.abort()
		}, [refetch, enabled])

		return {
			data: state.data,
			error: state.error,
			status: state.status,
			isLoading: state.fetching && state.data === undefined,
			isFetching: state.fetching,
			isStale: state.from === 'cache',
			refetch,
		}
	}

	/*
	 * MUTATION
	 */
	function useMutation<T, V>(run: (variables: V) => PromiseLike<T>): UseMutationResult<T, V> {
		const [state, setState] = useState<{
			data: T | undefined
			error: ConduitError | undefined
			isPending: boolean
		}>({ data: undefined, error: undefined, isPending: false })

		const alive = useRef(true)
		const latest = useRef(run)
		latest.current = run

		useEffect(() => {
			alive.current = true

			return () => {
				alive.current = false
			}
		}, [])

		const mutate = useCallback(async (variables: V): Promise<T | undefined> => {
			setState(current => ({ ...current, isPending: true, error: undefined }))

			try {
				const data = await latest.current(variables)

				if (alive.current) {
					setState({ data, error: undefined, isPending: false })
				}

				return data
			} catch (cause) {
				// Surfaced as state rather than rethrown: a mutation that fails
				// after its component unmounted would otherwise become an unhandled
				// rejection nobody can catch.
				const error = cause as ConduitError

				if (alive.current) {
					setState({ data: undefined, error, isPending: false })
				}

				return undefined
			}
		}, [])

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
			// Lane, not urgency: warming a route the user has only hovered must not
			// crowd out what is already on screen.
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
