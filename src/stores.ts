import type { Unsubscribe } from './events'

/*
 *   STORE
 ***************************************************************************************************/
/**
 * The whole framework seam.
 *
 * Anything conduit exposes as changing state is a `ReadableStore`, so a binding
 * for a new framework is a few lines over `subscribe` and `get` rather than a
 * port. React's `useSyncExternalStore` consumes this shape directly.
 */
export interface ReadableStore<T> {
	get(): T
	subscribe(listener: (value: T) => void): Unsubscribe
}

export interface WritableStore<T> extends ReadableStore<T> {
	set(value: T): void
	update(recipe: (current: T) => T): void
	/** How many listeners are attached. Lets an owner drop a store nobody is watching. */
	readonly listeners: number
}

const schedule: (task: () => void) => void =
	typeof queueMicrotask === 'function'
		? queueMicrotask
		: task => void Promise.resolve().then(task)

/**
 * A value with subscribers, where notification is batched onto a microtask.
 *
 * `get()` is always current — only the fan-out is deferred. One request settling
 * writes status, data and timestamp in the same tick; without batching that is
 * three notifications, and with one shared client behind several remotes it
 * becomes three render passes in each of them.
 */
export function createStore<T>(initial: T): WritableStore<T> {
	const listeners = new Set<(value: T) => void>()
	let value = initial
	let scheduled = false

	const notify = (): void => {
		if (scheduled || listeners.size === 0) {
			return
		}

		scheduled = true

		schedule(() => {
			scheduled = false
			const snapshot = value

			for (const listener of [...listeners]) {
				if (listeners.has(listener)) {
					listener(snapshot)
				}
			}
		})
	}

	return {
		get: () => value,

		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},

		set: next => {
			if (Object.is(next, value)) {
				return
			}

			value = next
			notify()
		},

		update: recipe => {
			const next = recipe(value)

			if (Object.is(next, value)) {
				return
			}

			value = next
			notify()
		},

		get listeners(): number {
			return listeners.size
		},
	}
}
