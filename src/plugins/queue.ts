import { toAbortError } from '../abort'
import type { EventBus } from '../events'
import type { ConduitRequest, Lane, Middleware, Plugin } from '../types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface QueueConfig {
	/** How many requests may be in flight at once. Defaults to 6. */
	concurrency?: number
	/** Lanes in priority order, most urgent first. */
	lanes?: readonly Lane[]
	/**
	 * Per-lane ceilings, so one lane cannot take the whole pool. A lane with no
	 * entry may use all of it.
	 */
	limits?: Readonly<Record<string, number>>
}

export interface QueueApi {
	/** Requests waiting for a slot, optionally in one lane. */
	queueDepth(lane?: Lane): number
	/** Requests currently holding a slot. */
	activeRequests(): number
}

/** Skips the queue entirely: `client.get('/x', { meta: { queue: 'bypass' } })`. */
export const QUEUE_META = 'queue'

const DEFAULT_LANES: readonly Lane[] = ['critical', 'default', 'prefetch']

/*
 *   WAITER
 ***************************************************************************************************/
interface Waiter {
	lane: Lane
	priority: number
	resolve: () => void
	detach: () => void
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Bounded concurrency with priority lanes.
 *
 * A composed frontend has no single owner of request volume: the host is
 * booting while three remotes mount and each fires whatever it needs. Without a
 * scheduler the host's critical path queues behind a remote's speculative
 * prefetching, in the browser's connection pool where nothing can reorder it.
 *
 * Sits inside retry in the default stack, so a replay rejoins the queue and
 * waits its turn rather than letting a failing endpoint amplify itself into a
 * stampede.
 */
export function queue(config: QueueConfig = {}): Plugin<QueueApi> {
	const concurrency = config.concurrency ?? 6
	const lanes = config.lanes ?? DEFAULT_LANES
	const limits = config.limits ?? {}
	const priorities = new Map<string, number>(lanes.map((lane, index) => [lane, index]))

	const waiting: Waiter[] = []
	const laneActive = new Map<string, number>()
	let active = 0
	let events: EventBus | undefined

	// An unconfigured lane sorts last rather than being rejected: a remote naming
	// its own lane should be scheduled politely, not refused.
	const priorityOf = (lane: Lane): number => priorities.get(lane) ?? lanes.length
	const limitOf = (lane: Lane): number => limits[lane] ?? concurrency
	const activeIn = (lane: Lane): number => laneActive.get(lane) ?? 0

	const canRun = (lane: Lane): boolean => active < concurrency && activeIn(lane) < limitOf(lane)

	const acquire = (lane: Lane): void => {
		active++
		laneActive.set(lane, activeIn(lane) + 1)
	}

	const release = (lane: Lane): void => {
		active--
		laneActive.set(lane, activeIn(lane) - 1)
	}

	const pump = (): void => {
		for (;;) {
			let chosen = -1

			// Scanned in insertion order with a strict comparison, so the earliest
			// waiter of the best runnable priority wins — priority across lanes,
			// FIFO within one.
			for (let index = 0; index < waiting.length; index++) {
				const waiter = waiting[index]
				const best = chosen === -1 ? undefined : waiting[chosen]

				if (waiter === undefined || !canRun(waiter.lane)) {
					continue
				}

				if (best === undefined || waiter.priority < best.priority) {
					chosen = index
				}
			}

			if (chosen === -1) {
				return
			}

			const [waiter] = waiting.splice(chosen, 1)

			if (waiter === undefined) {
				return
			}

			waiter.detach()
			// Taken here, synchronously, so the next pass of this loop counts it.
			acquire(waiter.lane)
			waiter.resolve()
		}
	}

	const wait = (request: ConduitRequest): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				lane: request.lane,
				priority: priorityOf(request.lane),
				resolve,
				detach: () => {},
			}

			const onAbort = (): void => {
				const index = waiting.indexOf(waiter)

				if (index !== -1) {
					waiting.splice(index, 1)
				}

				waiter.detach()
				reject(toAbortError(request))
			}

			request.signal.addEventListener('abort', onAbort, { once: true })
			waiter.detach = () => request.signal.removeEventListener('abort', onAbort)

			waiting.push(waiter)
		})

	const middleware: Middleware = async (request, next) => {
		if (request.meta[QUEUE_META] === 'bypass') {
			return next(request)
		}

		// Checked before queuing. A cancelled request must not take a slot, and an
		// already-aborted signal never fires the listener that would free it.
		if (request.signal.aborted) {
			throw toAbortError(request)
		}

		if (canRun(request.lane)) {
			acquire(request.lane)
		} else {
			if (events?.active === true) {
				events.emit('queue:enqueue', {
					type: 'queue:enqueue',
					key: request.key,
					owner: request.owner,
					lane: request.lane,
					depth: waiting.length,
					at: Date.now(),
				})
			}

			await wait(request)
		}

		try {
			return await next(request)
		} finally {
			release(request.lane)
			pump()
		}
	}

	return {
		name: 'queue',
		middleware,
		onInit: ctx => {
			events = ctx.events

			return {
				queueDepth: (lane?: Lane): number =>
					lane === undefined
						? waiting.length
						: waiting.reduce(
								(count, waiter) => count + (waiter.lane === lane ? 1 : 0),
								0
							),
				activeRequests: (): number => active,
			}
		},
		onDestroy: () => {
			// Waiters are released by the root signal aborting during destroy; this
			// only drops the bookkeeping.
			waiting.length = 0
			laneActive.clear()
			active = 0
		},
	}
}
