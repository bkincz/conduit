import { ConduitError } from '../errors'
import { withRequest } from '../request'
import { composeSignals } from '../signals'
import type { Middleware, Plugin } from '../types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface TimeoutConfig {
	/** Milliseconds before a request is cancelled. Defaults to 15 seconds. */
	ms?: number
}

/** Per-request override: `client.get('/slow', { meta: { timeout: 60_000 } })`. */
export const TIMEOUT_META = 'timeout'

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Cancels a request that has taken too long.
 *
 * Innermost in the default stack, just above the transport, so the clock covers
 * one network attempt rather than a whole retry sequence — otherwise the first
 * slow attempt would eat the budget for every replay after it.
 *
 * The abort reason is a `ConduitError` with code `TIMEOUT`, which survives to
 * the caller intact instead of arriving as a generic abort.
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
		}, ms)

		const composed = composeSignals([request.signal, controller.signal])

		try {
			return await next(withRequest(request, { signal: composed.signal }))
		} finally {
			// Both matter: a settled request must not leave a timer holding its
			// closure alive, nor a listener attached to a long-lived scope signal.
			clearTimeout(timer)
			composed.release()
		}
	}

	return { name: 'timeout', middleware }
}
