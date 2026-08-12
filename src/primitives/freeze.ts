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
 * Marks a body that more than one caller holds. Deep in development, where
 * catching the mutation matters, shallow in production, where the cost does.
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
