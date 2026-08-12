/*
 *   COMPOSED SIGNAL
 ***************************************************************************************************/
export interface ComposedSignal {
	readonly signal: AbortSignal
	/**
	 * Call when the request settles. A scope signal outlives every request made
	 * through it, so listeners left attached accumulate for the life of the scope.
	 */
	release(): void
}

const noop = (): void => {}

function hasNativeAny(): boolean {
	return typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
}

/**
 * Merges caller, scope and timeout signals into the one the transport listens
 * to. First to abort wins and its `reason` carries through, so the failure says
 * which one it was.
 */
export function composeSignals(signals: ReadonlyArray<AbortSignal | undefined>): ComposedSignal {
	const present: AbortSignal[] = []

	for (const signal of signals) {
		if (signal !== undefined) {
			present.push(signal)
		}
	}

	if (present.length === 0) {
		return { signal: new AbortController().signal, release: noop }
	}

	const only = present[0]

	if (present.length === 1 && only !== undefined) {
		return { signal: only, release: noop }
	}

	if (hasNativeAny()) {
		return { signal: AbortSignal.any(present), release: noop }
	}

	/* v8 ignore next */
	return composeManually(present)
}

/*
 *   FALLBACK
 ***************************************************************************************************/
/**
 * The pre-`AbortSignal.any` path, exported only so it can be tested directly.
 *
 * @internal
 */
export function composeManually(signals: readonly AbortSignal[]): ComposedSignal {
	const controller = new AbortController()

	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason)
			return { signal: controller.signal, release: noop }
		}
	}

	const listeners: Array<() => void> = []

	const release = (): void => {
		for (const detach of listeners) {
			detach()
		}
		listeners.length = 0
	}

	for (const signal of signals) {
		const onAbort = (): void => {
			controller.abort(signal.reason)
			release()
		}

		signal.addEventListener('abort', onAbort, { once: true })
		listeners.push(() => signal.removeEventListener('abort', onAbort))
	}

	return { signal: controller.signal, release }
}
