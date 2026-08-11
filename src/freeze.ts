import { DEV } from './dev'

/*
 *   FREEZE
 ***************************************************************************************************/
function deepFreeze(value: unknown, seen: WeakSet<object>): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) {
		return
	}

	seen.add(value)
	Object.freeze(value)

	// Only plain containers. Walking a Blob or a Date buys nothing and a Map's
	// contents are not reachable this way anyway.
	if (Array.isArray(value)) {
		for (const entry of value) {
			deepFreeze(entry, seen)
		}
		return
	}

	if (Object.getPrototypeOf(value) === Object.prototype) {
		for (const entry of Object.values(value)) {
			deepFreeze(entry, seen)
		}
	}
}

/**
 * Marks a response body as shared.
 *
 * Anything conduit hands to more than one caller — a cache entry, a deduped
 * flight — is handed out by reference, because cloning per read would undo the
 * point of both. Freezing turns "someone mutated shared data" from a bug that
 * surfaces three remotes away into an immediate throw at the line that did it.
 *
 * Shallow in production, where the cost has to stay flat; deep in development,
 * where finding the mutation matters more.
 */
export function protect(data: unknown): void {
	if (typeof data !== 'object' || data === null) {
		return
	}

	if (DEV) {
		deepFreeze(data, new WeakSet())
		return
	}

	Object.freeze(data)
}
