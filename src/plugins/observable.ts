import { toConduitError, type ConduitError } from '../primitives/errors'
import type { Unsubscribe } from '../primitives/events'
import { createStore, type ReadableStore, type WritableStore } from '../primitives/stores'
import type { ConduitRequest, Middleware, Plugin, ResponseSource } from '../primitives/types'

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
	/** Bumped whenever a cache invalidation or identity reset targets this key. */
	readonly invalidatedAt: number
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
	invalidatedAt: 0,
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
	/** Tags seen on requests for a key, so a `cache:invalidate` tag target can be matched here too. */
	const tagsByKey = new Map<string, Set<string>>()
	let generation = 0

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

	const trackTags = (request: ConduitRequest): void => {
		if (request.tags.length === 0) {
			return
		}

		let known = tagsByKey.get(request.key)

		if (known === undefined) {
			known = new Set()
			tagsByKey.set(request.key, known)
		}

		for (const tag of request.tags) {
			known.add(tag)
		}
	}

	const wrappers = new Map<string, ReadableStore<QueryState<unknown>>>()

	const forget = (key: string): void => {
		stores.delete(key)
		tagsByKey.delete(key)
		wrappers.delete(key)
	}

	let sweepTimer: ReturnType<typeof setTimeout> | undefined

	const sweep = (): void => {
		if (stores.size <= max) {
			return
		}

		for (const [key, store] of stores) {
			if (stores.size <= max) {
				break
			}

			if (store.listeners === 0) {
				forget(key)
			}
		}
	}

	const requestSweep = (): void => {
		if (sweepTimer !== undefined) {
			return
		}

		sweepTimer = setTimeout(() => {
			sweepTimer = undefined
			sweep()
		}, 0)
	}

	const storeFor = (key: string): WritableStore<QueryState<unknown>> => {
		const existing = stores.get(key)

		if (existing !== undefined) {
			stores.delete(key)
			stores.set(key, existing)

			return existing
		}

		const created = createStore<QueryState<unknown>>(IDLE)
		stores.set(key, created)

		if (stores.size > max) {
			requestSweep()
		}

		return created
	}

	const bumpOne = (key: string): void => {
		const store = stores.get(key)

		if (store === undefined) {
			return
		}

		generation++
		store.update(current => ({ ...current, invalidatedAt: generation }))
	}

	const bumpAll = (): void => {
		generation++

		for (const store of stores.values()) {
			store.update(current => ({ ...current, invalidatedAt: generation }))
		}
	}

	const bumpTag = (tag: string): void => {
		for (const [key, tags] of tagsByKey) {
			if (tags.has(tag)) {
				bumpOne(key)
			}
		}
	}

	const middleware: Middleware = async (request, next) => {
		const store = storeFor(request.key)

		trackTags(request)
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
				invalidatedAt: store.get().invalidatedAt,
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

	let releaseReset: (() => void) | undefined
	let releaseInvalidate: (() => void) | undefined
	let releaseSet: (() => void) | undefined

	return {
		name: 'observable',
		middleware,
		onInit: ctx => {
			releaseReset = ctx.onResetIdentity(() => {
				generation++

				for (const store of stores.values()) {
					store.set({ ...IDLE, invalidatedAt: generation })
				}

				tagsByKey.clear()
			})

			releaseInvalidate = ctx.events.on('cache:invalidate', event => {
				if (event.target === '*') {
					bumpAll()

					return
				}

				if (event.target.startsWith('tag:')) {
					bumpTag(event.target.slice(4))

					return
				}

				bumpOne(event.target)
			})

			releaseSet = ctx.events.on('cache:set', event => {
				const store = stores.get(event.key)

				if (store === undefined) {
					return
				}

				store.set({
					status: 'success',
					data: event.data,
					error: undefined,
					from: 'cache',
					fetching: false,
					updatedAt: event.at,
					invalidatedAt: store.get().invalidatedAt,
				})
			})

			return {
				observe: <T>(key: string): ReadableStore<QueryState<T>> => {
					const store = storeFor(key)
					const existing = wrappers.get(key)

					if (existing !== undefined) {
						return existing as unknown as ReadableStore<QueryState<T>>
					}

					const wrapped: ReadableStore<QueryState<unknown>> = {
						get: () => store.get(),
						subscribe: listener => {
							const off = store.subscribe(listener)
							let released = false

							const unsubscribe: Unsubscribe = () => {
								if (released) {
									return
								}

								released = true
								off()
								requestSweep()
							}

							return unsubscribe
						},
					}

					wrappers.set(key, wrapped)

					return wrapped as unknown as ReadableStore<QueryState<T>>
				},
				observedKeys: (): number => stores.size,
			}
		},
		onDestroy: () => {
			releaseReset?.()
			releaseReset = undefined
			releaseInvalidate?.()
			releaseInvalidate = undefined
			releaseSet?.()
			releaseSet = undefined
			wrappers.clear()
			clearTimeout(sweepTimer)
			sweepTimer = undefined
			stores.clear()
			tagsByKey.clear()
			pending.clear()
		},
	}
}
