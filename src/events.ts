import { DEV } from './dev'
import type { ConduitError } from './errors'
import type { ConduitRequest, ConduitResponse } from './types'

/*
 *   CLOCK
 ***************************************************************************************************/
const monotonic: () => number =
	typeof performance !== 'undefined' && typeof performance.now === 'function'
		? () => performance.now()
		: () => Date.now()

/*
 *   EVENTS
 ***************************************************************************************************/
export interface RequestStartEvent {
	readonly type: 'request:start'
	/** The request as issued. Middleware may rewrite it further in; see `response.request`. */
	readonly request: ConduitRequest
	readonly at: number
}

export interface RequestSettleEvent {
	readonly type: 'request:settle'
	readonly request: ConduitRequest
	readonly response: ConduitResponse
	/** Milliseconds across the whole pipeline, not just the network. */
	readonly duration: number
	readonly at: number
}

export interface RequestErrorEvent {
	readonly type: 'request:error'
	readonly request: ConduitRequest
	readonly error: ConduitError
	readonly duration: number
	readonly at: number
}

export interface ClientDestroyEvent {
	readonly type: 'client:destroy'
	readonly at: number
}

/*
 *   PLUGIN EVENTS
 ***************************************************************************************************/
// Declared here rather than augmented from each plugin file: the published
// types are bundled into one declaration file, where relative-path module
// augmentation does not survive. Types only — the core imports no plugin.

export interface CacheHitEvent {
	readonly type: 'cache:hit'
	readonly key: string
	readonly owner: string | undefined
	readonly at: number
}

export interface CacheMissEvent {
	readonly type: 'cache:miss'
	readonly key: string
	readonly owner: string | undefined
	readonly at: number
}

export interface CacheStaleEvent {
	readonly type: 'cache:stale'
	readonly key: string
	readonly owner: string | undefined
	/** Whether a background refresh was started, or one was already running. */
	readonly revalidating: boolean
	readonly at: number
}

export interface CacheInvalidateEvent {
	readonly type: 'cache:invalidate'
	/** A key, a `tag:name`, or `*` for a full clear. */
	readonly target: string
	readonly removed: number
	readonly at: number
}

export interface DedupeJoinEvent {
	readonly type: 'dedupe:join'
	readonly key: string
	/** The remote that joined an existing flight rather than starting one. */
	readonly owner: string | undefined
	readonly at: number
}

export interface QueueEnqueueEvent {
	readonly type: 'queue:enqueue'
	readonly key: string
	readonly owner: string | undefined
	readonly lane: string
	/** How many were already waiting when this one joined. */
	readonly depth: number
	readonly at: number
}

export interface SessionChangeEvent {
	readonly type: 'session:change'
	readonly status: 'unknown' | 'loading' | 'authenticated' | 'anonymous'
	/** True once the session is gone and cannot be recovered here. */
	readonly terminal: boolean
	readonly at: number
}

export interface ContractMismatchEvent {
	readonly type: 'contract:mismatch'
	/** What this bundle was built against. */
	readonly expected: string
	/** What the server reported. */
	readonly actual: string
	readonly at: number
}

export interface RetryAttemptEvent {
	readonly type: 'retry:attempt'
	readonly key: string
	readonly owner: string | undefined
	/** The attempt that just failed. */
	readonly attempt: number
	readonly delay: number
	readonly reason: string
	readonly at: number
}

/**
 * The event surface. Plugins extend it by declaration merging:
 *
 * ```ts
 * declare module '@bkincz/conduit' {
 * 	interface ConduitEventMap {
 * 		'cache:hit': { type: 'cache:hit'; key: string; at: number }
 * 	}
 * }
 * ```
 */
export interface ConduitEventMap {
	'request:start': RequestStartEvent
	'request:settle': RequestSettleEvent
	'request:error': RequestErrorEvent
	'client:destroy': ClientDestroyEvent
	'cache:hit': CacheHitEvent
	'cache:miss': CacheMissEvent
	'cache:stale': CacheStaleEvent
	'cache:invalidate': CacheInvalidateEvent
	'dedupe:join': DedupeJoinEvent
	'retry:attempt': RetryAttemptEvent
	'queue:enqueue': QueueEnqueueEvent
	'session:change': SessionChangeEvent
	'contract:mismatch': ContractMismatchEvent
}

export type ConduitEventType = keyof ConduitEventMap
export type ConduitEvent = ConduitEventMap[ConduitEventType]

export type Unsubscribe = () => void

export interface EventBus {
	/**
	 * Whether anything is listening at all.
	 *
	 * Guard emission with it. In production nothing subscribes, and building an
	 * event object per request to hand to nobody is the kind of cost that only
	 * shows up under load.
	 */
	readonly active: boolean
	on<K extends ConduitEventType>(
		type: K,
		listener: (event: ConduitEventMap[K]) => void
	): Unsubscribe
	/** Every event, whatever its type. What devtools and telemetry bridges want. */
	onAny(listener: (event: ConduitEvent) => void): Unsubscribe
	emit<K extends ConduitEventType>(type: K, event: ConduitEventMap[K]): void
	clear(): void
}

/*
 *   BUS
 ***************************************************************************************************/
type AnyListener = (event: ConduitEvent) => void

export function createEventBus(): EventBus {
	const typed = new Map<ConduitEventType, Set<AnyListener>>()
	const all = new Set<AnyListener>()
	let count = 0

	const dispatch = (listener: AnyListener, event: ConduitEvent): void => {
		try {
			listener(event)
		} catch (error) {
			// A broken subscriber must not fail the request it was watching.
			if (DEV) {
				console.error(
					'[conduit] An event listener threw. The request is unaffected.',
					error
				)
			}
		}
	}

	return {
		get active(): boolean {
			return count > 0
		},

		on<K extends ConduitEventType>(
			type: K,
			listener: (event: ConduitEventMap[K]) => void
		): Unsubscribe {
			let listeners = typed.get(type)

			if (listeners === undefined) {
				listeners = new Set()
				typed.set(type, listeners)
			}

			const entry = listener as AnyListener
			listeners.add(entry)
			count++

			let removed = false

			return () => {
				if (removed || !listeners.delete(entry)) {
					return
				}

				removed = true
				count--
			}
		},

		onAny(listener: AnyListener): Unsubscribe {
			all.add(listener)
			count++

			let removed = false

			return () => {
				if (removed || !all.delete(listener)) {
					return
				}

				removed = true
				count--
			}
		},

		emit<K extends ConduitEventType>(type: K, event: ConduitEventMap[K]): void {
			const listeners = typed.get(type)

			// Iterating a copy keeps a listener that subscribes or unsubscribes
			// mid-dispatch from mutating the set underneath the loop. Re-checking
			// membership then makes an unsubscribe take effect immediately, rather
			// than delivering one more event to a listener that just left.
			if (listeners !== undefined) {
				for (const listener of [...listeners]) {
					if (listeners.has(listener)) {
						dispatch(listener, event)
					}
				}
			}

			for (const listener of [...all]) {
				if (all.has(listener)) {
					dispatch(listener, event)
				}
			}
		},

		clear(): void {
			typed.clear()
			all.clear()
			count = 0
		},
	}
}

/*
 *   TIMING
 ***************************************************************************************************/
/** Monotonic milliseconds, for durations. Falls back to `Date.now` where `performance` is absent. */
export function elapsed(): number {
	return monotonic()
}
