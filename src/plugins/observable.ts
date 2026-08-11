import { toConduitError, type ConduitError } from '../errors'
import { createStore, type ReadableStore, type WritableStore } from '../stores'
import type { Middleware, Plugin, ResponseSource } from '../types'

/*
 *   STATE
 ***************************************************************************************************/
export type QueryStatus = 'idle' | 'loading' | 'success' | 'error'

export interface QueryState<T> {
	readonly status: QueryStatus
	readonly data: T | undefined
	readonly error: ConduitError | undefined
	/** Where the last answer came from. `cache` means it may be stale. */
	readonly from: ResponseSource | undefined
	/** A request for this key is in the air, whether or not there is already data. */
	readonly fetching: boolean
	readonly updatedAt: number
}

export interface ObservableConfig {
	/**
	 * How many keys to keep state for. Defaults to 200. A key with subscribers is
	 * never evicted.
	 */
	max?: number
}

export interface ObservableApi {
	/**
	 * The living state of one request key. Created on first call and shared, so
	 * two remotes watching the same key watch the same store.
	 */
	observe<T = unknown>(key: string): ReadableStore<QueryState<T>>
	/** How many keys currently have state. */
	observedKeys(): number
}

const IDLE: QueryState<never> = {
	status: 'idle',
	data: undefined,
	error: undefined,
	from: undefined,
	fetching: false,
	updatedAt: 0,
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Turns request traffic into observable per-key state.
 *
 * This is what framework bindings read. It lives on the client rather than in
 * the binding so that state is shared the same way everything else is: two
 * remotes rendering the same query watch one store, and the second to mount
 * sees the first one's result without asking for it.
 *
 * Outermost in the default stack, so a cache hit still moves the state it is
 * answering.
 */
export function observable(config: ObservableConfig = {}): Plugin<ObservableApi> {
	const max = config.max ?? 200
	const stores = new Map<string, WritableStore<QueryState<unknown>>>()

	const storeFor = (key: string): WritableStore<QueryState<unknown>> => {
		const existing = stores.get(key)

		if (existing !== undefined) {
			stores.delete(key)
			stores.set(key, existing)

			return existing
		}

		const created = createStore<QueryState<unknown>>(IDLE)
		stores.set(key, created)
		evict()

		return created
	}

	const evict = (): void => {
		if (stores.size <= max) {
			return
		}

		for (const [key, store] of stores) {
			// Never drop state something is rendering from. Anything else is
			// reconstructible from the next request.
			if (store.listeners === 0) {
				stores.delete(key)
				break
			}
		}
	}

	const middleware: Middleware = async (request, next) => {
		const store = storeFor(request.key)

		store.update(current => ({
			...current,
			status: current.data === undefined ? 'loading' : current.status,
			fetching: true,
		}))

		try {
			const response = await next(request)

			store.set({
				status: 'success',
				data: response.data,
				error: undefined,
				from: response.from,
				fetching: false,
				updatedAt: Date.now(),
			})

			return response
		} catch (cause) {
			const error = toConduitError(cause)

			store.update(current => ({
				// The previous answer is kept alongside the failure: a refetch that
				// fails should not blank a screen that was showing something.
				...current,
				status: 'error',
				error,
				fetching: false,
				updatedAt: Date.now(),
			}))

			throw error
		}
	}

	return {
		name: 'observable',
		middleware,
		onInit: () => ({
			observe: <T>(key: string): ReadableStore<QueryState<T>> =>
				storeFor(key) as unknown as ReadableStore<QueryState<T>>,
			observedKeys: (): number => stores.size,
		}),
		onDestroy: () => {
			stores.clear()
		},
	}
}
