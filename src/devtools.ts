import type { Client } from './client/core'
import type { ConduitErrorCode } from './primitives/errors'
import type { ConduitEvent, Unsubscribe } from './primitives/events'
import type { SessionStatus } from './plugins/session'
import { createStore, type ReadableStore } from './primitives/stores'
import type { ConduitRequest, ResponseSource } from './primitives/types'

/*
 *   STATE
 ***************************************************************************************************/
export interface DevtoolsEntry {
	readonly id: number
	readonly key: string
	readonly method: string
	readonly url: string
	/** Which app or remote issued it. */
	readonly owner: string | undefined
	readonly lane: string
	readonly state: 'pending' | 'success' | 'error'
	readonly from: ResponseSource | undefined
	readonly status: number | undefined
	readonly code: ConduitErrorCode | undefined
	readonly duration: number | undefined
	readonly startedAt: number
}

export interface DevtoolsCounters {
	readonly requests: number
	readonly failures: number
	readonly cacheHits: number
	readonly cacheMisses: number
	readonly cacheStale: number
	readonly dedupeJoins: number
	readonly retries: number
	readonly queued: number
}

export interface DevtoolsState {
	/** Most recent first. */
	readonly entries: readonly DevtoolsEntry[]
	readonly inFlight: number
	readonly counters: DevtoolsCounters
	readonly session: SessionStatus | undefined
	/** Set once the session is gone and cannot be recovered. */
	readonly sessionTerminal: boolean
}

export interface DevtoolsConfig {
	/** How many finished requests to keep. Defaults to 100. */
	max?: number
	/** Hang the handle on `globalThis.__CONDUIT_DEVTOOLS__` for console access. Defaults to true. */
	expose?: boolean
}

export interface Devtools {
	readonly store: ReadableStore<DevtoolsState>
	/** Drops the log and zeroes the counters. In-flight requests keep reporting. */
	clear(): void
	/** Unsubscribes from the client and removes the global handle. */
	stop(): void
}

const EMPTY_COUNTERS: DevtoolsCounters = {
	requests: 0,
	failures: 0,
	cacheHits: 0,
	cacheMisses: 0,
	cacheStale: 0,
	dedupeJoins: 0,
	retries: 0,
	queued: 0,
}

const GLOBAL_KEY = '__CONDUIT_DEVTOOLS__'

type DevtoolsScope = typeof globalThis & { [GLOBAL_KEY]?: Devtools }

/*
 *   ATTACH
 ***************************************************************************************************/
/**
 * Watches one client through its event stream and nothing else, so a shared
 * client shows traffic from every remote on the page, attributed by owner.
 */
export function attachDevtools(client: Client, config: DevtoolsConfig = {}): Devtools {
	const max = config.max ?? 100
	const store = createStore<DevtoolsState>({
		entries: [],
		inFlight: 0,
		counters: EMPTY_COUNTERS,
		session: undefined,
		sessionTerminal: false,
	})

	const pending = new Map<ConduitRequest, number>()
	let nextId = 0

	const bump = (counter: keyof DevtoolsCounters): void => {
		store.update(current => ({
			...current,
			counters: { ...current.counters, [counter]: current.counters[counter] + 1 },
		}))
	}

	const complete = (
		request: ConduitRequest,
		patch: Omit<Partial<DevtoolsEntry>, 'id'> & { state: 'success' | 'error' }
	): void => {
		const id = pending.get(request)

		if (id === undefined) {
			return
		}

		pending.delete(request)

		store.update(current => ({
			...current,
			inFlight: pending.size,
			entries: current.entries.map(entry =>
				entry.id === id ? { ...entry, ...patch } : entry
			),
		}))
	}

	const unsubscribe = client.events.onAny((event: ConduitEvent) => {
		switch (event.type) {
			case 'request:start': {
				const id = nextId++
				pending.set(event.request, id)

				store.update(current => ({
					...current,
					inFlight: pending.size,
					counters: { ...current.counters, requests: current.counters.requests + 1 },
					entries: [
						{
							id,
							key: event.request.key,
							method: event.request.method,
							url: event.request.url,
							owner: event.request.owner,
							lane: event.request.lane,
							state: 'pending',
							from: undefined,
							status: undefined,
							code: undefined,
							duration: undefined,
							startedAt: event.at,
						},
						...current.entries.slice(0, max - 1),
					],
				}))
				break
			}

			case 'request:settle':
				complete(event.request, {
					state: 'success',
					from: event.response.from,
					status: event.response.status,
					duration: event.duration,
				})
				break

			case 'request:error':
				complete(event.request, {
					state: 'error',
					status: event.error.status,
					code: event.error.code,
					duration: event.duration,
				})
				bump('failures')
				break

			case 'cache:hit':
				bump('cacheHits')
				break

			case 'cache:miss':
				bump('cacheMisses')
				break

			case 'cache:stale':
				bump('cacheStale')
				break

			case 'dedupe:join':
				bump('dedupeJoins')
				break

			case 'retry:attempt':
				bump('retries')
				break

			case 'queue:enqueue':
				bump('queued')
				break

			case 'session:change':
				store.update(current => ({
					...current,
					session: event.status,
					sessionTerminal: event.terminal,
				}))
				break

			default:
				break
		}
	})

	const devtools: Devtools = {
		store,

		clear: () => {
			store.update(current => ({ ...current, entries: [], counters: EMPTY_COUNTERS }))
		},

		stop: () => {
			unsubscribe()
			pending.clear()

			const scope = globalThis as DevtoolsScope

			if (scope[GLOBAL_KEY] === devtools) {
				delete scope[GLOBAL_KEY]
			}
		},
	}

	if (config.expose !== false) {
		;(globalThis as DevtoolsScope)[GLOBAL_KEY] = devtools
	}

	return devtools
}

/** Reads the handle a previous {@link attachDevtools} exposed, if any. */
export function getDevtools(): Devtools | undefined {
	return (globalThis as DevtoolsScope)[GLOBAL_KEY]
}

/*
 *   UNSUBSCRIBE
 ***************************************************************************************************/
export type { Unsubscribe }
