import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { Client } from './client/core'
import { DEV } from './primitives/dev'
import type { ConduitError } from './primitives/errors'
import type { ObservableApi, QueryState, QueryStatus } from './plugins/observable'
import type { SessionApi, SessionState } from './plugins/session'
import type { MethodOptions, RequestOptions } from './primitives/types'

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
	/** No data yet and a request is in the air. */
	isLoading: boolean
	/** A request is in the air, with or without data on screen. */
	isFetching: boolean
	/** The last answer came from cache. */
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
	/**
	 * Runs a request and renders its state, keyed the way the cache and dedupe
	 * key it.
	 *
	 * A client `headers` function that answers differently per call gives every
	 * render a different key under `vary: '*'`, and this refetches on each one.
	 * Development warns when that happens.
	 */
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
	client: Client & ObservableApi & Partial<SessionApi<unknown>>
): Hooks & Partial<SessionHooks<unknown>> {
	/*
	 * REQUEST
	 */
	function useRequest<T>(path: string, options: UseRequestOptions = {}): UseRequestResult<T> {
		const { enabled = true, ...request } = options

		const key = client.keyFor(path, request)

		const checked = useRef(false)

		if (DEV && !checked.current) {
			checked.current = true

			if (client.keyFor(path, request) !== key) {
				console.warn(
					`[conduit] useRequest("${path}") derived two different keys in one render, so the client's headers function answers differently per call — a rotating token, a request id, a trace parent. Under vary: '*' that makes every request unique: nothing hits the cache, nothing shares a flight, and this hook refetches on every render. Narrow vary to the headers that matter (vary: ['authorization']), or keep per-call headers out of the client's headers function.`
				)
			}
		}

		const store = useMemo(() => client.observe<T>(key), [key])
		const state = useSyncExternalStore(store.subscribe, store.get, store.get)

		const latest = useRef<RequestOptions>(request)
		latest.current = request

		const inFlight = useRef<AbortController | undefined>(undefined)

		const refetch = useCallback(async (): Promise<void> => {
			inFlight.current?.abort()

			const controller = new AbortController()
			inFlight.current = controller

			await client
				.request<T>(path, {
					...latest.current,
					key,
					signal: controller.signal,
				})
				.safe()
		}, [key, path])

		useEffect(() => {
			if (!enabled) {
				return
			}

			void refetch()

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
