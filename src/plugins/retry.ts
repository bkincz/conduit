import { toAbortError } from '../abort'
import { toConduitError, type ConduitError } from '../errors'
import type { EventBus } from '../events'
import { IDEMPOTENT_METHODS, type ConduitRequest, type Middleware, type Plugin } from '../types'

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
/** Waits, unless the request is cancelled first — a backoff must not outlive its request. */
function sleep(ms: number, request: ConduitRequest): Promise<void> {
	// An already-aborted signal never fires its listener, so without this check a
	// cancellation landing between the failed attempt and the backoff would be
	// ignored entirely: the wait runs to the end and another request goes out to
	// a server the caller has already walked away from.
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
 * Replays a failed request with exponential backoff.
 *
 * Sits outside the queue in the default stack, so a replay re-enters the
 * scheduler and waits its turn. A retry that skipped the queue would let a
 * failing endpoint amplify itself into exactly the stampede the queue exists to
 * prevent.
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

		// Cancelled means someone decided they no longer want this; a config
		// mistake will fail identically next time; an unrecoverable session is
		// unrecoverable on attempt two as well.
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
	 * How long to wait before the next attempt, or `undefined` to give up.
	 *
	 * A `Retry-After` longer than `maxDelay` gives up rather than being clamped.
	 * Clamping would hammer a server that just asked for an hour, and honouring
	 * it verbatim would park the caller's promise for that hour with no spinner
	 * ever resolving. Failing now is the only option that respects both the
	 * server's instruction and the ceiling the caller configured.
	 */
	const backoff = (error: ConduitError, attempt: number): number | undefined => {
		const instructed = retryAfter(error)

		if (instructed !== undefined) {
			return instructed > maxDelay ? undefined : instructed
		}

		const window = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1))

		// Full jitter: without it, every client that failed together retries
		// together, and the server gets the same spike twice.
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
