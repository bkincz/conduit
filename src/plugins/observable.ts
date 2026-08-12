import { toConduitError, type ConduitError } from '../primitives/errors'
import { createStore, type ReadableStore, type WritableStore } from '../primitives/stores'
import type { Middleware, Plugin, ResponseSource } from '../primitives/types'

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
	/** How many keys to keep state for. Defaults to 200. A watched key is never evicted. */
	max?: number
}

export interface ObservableApi {
	/** The live state of one key, created on first call and shared by every watcher. */
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
 * Turns request traffic into per-key state for framework bindings to read. It
 * lives on the client, so two remotes rendering the same query watch one store.
 */
export function observable(config: ObservableConfig = {}): Plugin<ObservableApi> {
	const max = config.max ?? 200
	const stores = new Map<string, WritableStore<QueryState<unknown>>>()

	const pending = new Map<string, number>()

	const enter = (key: string): void => {
		pending.set(key, (pending.get(key) ?? 0) + 1)
	}

	/** Drops one participant and reports how many are left. */
	const leave = (key: string): number => {
		const left = (pending.get(key) ?? 1) - 1

		if (left <= 0) {
			pending.delete(key)

			return 0
		}

		pending.set(key, left)

		return left
	}

	const storeFor = (key: string): WritableStore<QueryState<unknown>> => {
		const existing = stores.get(key)

		if (existing !== undefined) {
			stores.delete(key)
			stores.set(key, existing)

			return existing
		}

		evict()

		const created = createStore<QueryState<unknown>>(IDLE)
		stores.set(key, created)

		return created
	}

	const evict = (): void => {
		while (stores.size >= max) {
			let victim: string | undefined

			for (const [key, store] of stores) {
				if (store.listeners === 0) {
					victim = key
					break
				}
			}

			if (victim === undefined) {
				return
			}

			stores.delete(victim)
		}
	}

	const middleware: Middleware = async (request, next) => {
		const store = storeFor(request.key)

		enter(request.key)

		store.update(current => ({
			...current,
			status: current.data === undefined ? 'loading' : current.status,
			fetching: true,
		}))

		try {
			const response = await next(request)
			const others = leave(request.key)

			store.set({
				status: 'success',
				data: response.data,
				error: undefined,
				from: response.from,
				fetching: others > 0,
				updatedAt: Date.now(),
			})

			return response
		} catch (cause) {
			const error = toConduitError(cause)
			const others = leave(request.key)

			if (error.code === 'ABORTED') {
				if (others === 0) {
					store.update(current => ({
						...current,
						status: current.data === undefined ? 'idle' : current.status,
						fetching: false,
					}))
				}

				throw error
			}

			store.update(current => ({
				...current,
				status: 'error',
				error,
				fetching: others > 0,
				updatedAt: Date.now(),
			}))

			throw error
		}
	}

	let release: (() => void) | undefined

	return {
		name: 'observable',
		middleware,
		onInit: ctx => {
			release = ctx.onResetIdentity(() => {
				for (const store of stores.values()) {
					store.set(IDLE)
				}
			})

			return {
				observe: <T>(key: string): ReadableStore<QueryState<T>> =>
					storeFor(key) as unknown as ReadableStore<QueryState<T>>,
				observedKeys: (): number => stores.size,
			}
		},
		onDestroy: () => {
			release?.()
			release = undefined
			stores.clear()
			pending.clear()
		},
	}
}
