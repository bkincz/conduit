import { toAbortError } from '../http/abort'
import { toConduitError, type ConduitError } from '../primitives/errors'
import type { EventBus } from '../primitives/events'
import {
	IDEMPOTENT_METHODS,
	type ConduitRequest,
	type Middleware,
	type Plugin,
} from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface RetryInfo {
	readonly request: ConduitRequest
	readonly error: ConduitError
	/** The attempt that just failed. */
	readonly attempt: number
	readonly delay: number
}

export interface RetryConfig {
	/** Total attempts including the first. Defaults to 3. */
	attempts?: number
	/** First backoff step in milliseconds. Defaults to 300. */
	baseDelay?: number
	/** Ceiling for a single backoff. Defaults to 5000. */
	maxDelay?: number
	/** Spread retries across the window instead of stacking them. Defaults to true. */
	jitter?: boolean
	/** Refuse to replay `POST` and `PATCH`. Defaults to true. */
	idempotentOnly?: boolean
	/** Response statuses worth another attempt. */
	statuses?: readonly number[]
	/** Replaces the built-in decision entirely. */
	shouldRetry?: (error: ConduitError, request: ConduitRequest, attempt: number) => boolean
	onRetry?: (info: RetryInfo) => void
}

const RETRYABLE_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504]

/*
 *   RETRY-AFTER
 ***************************************************************************************************/
/** Honours the server's own instruction, in either of the two formats it may use. */
function retryAfter(error: ConduitError): number | undefined {
	const header = error.headers?.get('retry-after')

	if (header === undefined || header === null) {
		return undefined
	}

	const seconds = Number(header)

	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000)
	}

	const date = Date.parse(header)

	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

/*
 *   SLEEP
 ***************************************************************************************************/
/** Waits, unless the request is cancelled first. A backoff must not outlive its request. */
function sleep(ms: number, request: ConduitRequest): Promise<void> {
	if (request.signal.aborted) {
		return Promise.reject(toAbortError(request))
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			request.signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)

		function onAbort(): void {
			clearTimeout(timer)
			reject(toAbortError(request))
		}

		request.signal.addEventListener('abort', onAbort, { once: true })
	})
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Replays a failed request with exponential backoff. Install it outside the
 * queue so a replay waits its turn instead of amplifying a failing endpoint.
 */
export function retry(config: RetryConfig = {}): Plugin {
	const attempts = config.attempts ?? 3
	const baseDelay = config.baseDelay ?? 300
	const maxDelay = config.maxDelay ?? 5_000
	const jitter = config.jitter ?? true
	const idempotentOnly = config.idempotentOnly ?? true
	const statuses = new Set(config.statuses ?? RETRYABLE_STATUSES)

	let events: EventBus | undefined

	const retryable = (error: ConduitError, request: ConduitRequest, attempt: number): boolean => {
		if (config.shouldRetry !== undefined) {
			return config.shouldRetry(error, request, attempt)
		}

		if (
			error.code === 'ABORTED' ||
			error.code === 'CONFIG' ||
			error.code === 'UNAUTHENTICATED'
		) {
			return false
		}

		if (idempotentOnly && !IDEMPOTENT_METHODS.has(request.method)) {
			return false
		}

		if (error.code === 'NETWORK' || error.code === 'TIMEOUT') {
			return true
		}

		return (
			error.code === 'HTTP_ERROR' && error.status !== undefined && statuses.has(error.status)
		)
	}

	/**
	 * How long to wait before the next attempt, or `undefined` to give up. A
	 * `Retry-After` beyond `maxDelay` gives up rather than being clamped, which
	 * would ignore what the server just asked for.
	 */
	const backoff = (error: ConduitError, attempt: number): number | undefined => {
		const instructed = retryAfter(error)

		if (instructed !== undefined) {
			return instructed > maxDelay ? undefined : instructed
		}

		const window = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1))

		return jitter ? Math.random() * window : window
	}

	const middleware: Middleware = async (request, next) => {
		let attempt = 1

		for (;;) {
			request.meta['attempt'] = attempt

			try {
				return await next(request)
			} catch (cause) {
				const error = toConduitError(cause)

				if (attempt >= attempts || !retryable(error, request, attempt)) {
					throw error
				}

				const delay = backoff(error, attempt)

				if (delay === undefined) {
					throw error
				}

				if (events?.active === true) {
					events.emit('retry:attempt', {
						type: 'retry:attempt',
						key: request.key,
						owner: request.owner,
						attempt,
						delay,
						reason: error.code,
						at: Date.now(),
					})
				}

				config.onRetry?.({ request, error, attempt, delay })

				await sleep(delay, request)
				attempt++
			}
		}
	}

	return {
		name: 'retry',
		middleware,
		onInit: ctx => {
			events = ctx.events
			return undefined
		},
	}
}
