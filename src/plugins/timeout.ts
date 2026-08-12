import { ConduitError } from '../primitives/errors'
import { withRequest } from '../http/request'
import { composeSignals } from '../http/signals'
import type { Middleware, Plugin } from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface TimeoutConfig {
	/** Milliseconds before a request is cancelled. Defaults to 15 seconds. */
	ms?: number
}

/** Per-request override: `client.get('/slow', { meta: { timeout: 60_000 } })`. */
export const TIMEOUT_META = 'timeout'

/** The largest delay `setTimeout` can hold without overflowing its 32-bit signed field. */
const MAX_DELAY = 2_147_483_647

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Cancels a request that has taken too long, with code `TIMEOUT` rather than a
 * generic abort. Install it innermost so the clock covers one network attempt
 * rather than a whole retry sequence.
 */
export function timeout(config: TimeoutConfig = {}): Plugin {
	const defaultMs = config.ms ?? 15_000

	const middleware: Middleware = async (request, next) => {
		const override = request.meta[TIMEOUT_META]
		const ms = typeof override === 'number' ? override : defaultMs

		if (!Number.isFinite(ms) || ms <= 0) {
			return next(request)
		}

		const controller = new AbortController()

		const delay = Math.min(ms, MAX_DELAY)

		const timer = setTimeout(() => {
			controller.abort(
				new ConduitError({
					code: 'TIMEOUT',
					message: `${request.method} ${request.url} exceeded its ${ms}ms timeout.`,
					method: request.method,
					url: request.url,
					owner: request.owner,
				})
			)
		}, delay)

		const composed = composeSignals([request.signal, controller.signal])

		try {
			return await next(withRequest(request, { signal: composed.signal }))
		} finally {
			clearTimeout(timer)
			composed.release()
		}
	}

	return { name: 'timeout', middleware }
}
