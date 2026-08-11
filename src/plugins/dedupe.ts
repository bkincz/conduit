import { toAbortError } from '../abort'
import type { EventBus } from '../events'
import { protect } from '../freeze'
import { withRequest } from '../request'
import type { ConduitRequest, ConduitResponse, Middleware, Plugin } from '../types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface DedupeConfig {
	/**
	 * Which requests may share a flight. Defaults to `GET` and `HEAD` — sharing a
	 * write would mean one of the two callers never actually wrote anything.
	 */
	shouldDedupe?: (request: ConduitRequest) => boolean
}

export interface DedupeApi {
	/** Distinct requests currently in flight and shareable. */
	inFlight(): number
}

const SHAREABLE: ReadonlySet<string> = new Set(['GET', 'HEAD'])

const byMethod = (request: ConduitRequest): boolean => SHAREABLE.has(request.method)

/*
 *   FLIGHT
 ***************************************************************************************************/
interface Flight {
	promise: Promise<ConduitResponse>
	/** Drives the single underlying request, so no one participant's signal owns it. */
	controller: AbortController
	participants: number
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * One request per key, however many callers ask for it.
 *
 * This is where a composed frontend gets most of its wins: four remotes mount
 * at once, each asks for the session, and the server sees one request.
 *
 * Cancellation is reference-counted rather than shared. The flight runs on its
 * own controller and only aborts when the last participant leaves, so a remote
 * unmounting mid-flight cancels its own wait without pulling the response out
 * from under everyone else — which is exactly what would happen if the first
 * caller's signal drove the request.
 */
export function dedupe(config: DedupeConfig = {}): Plugin<DedupeApi> {
	const shouldDedupe = config.shouldDedupe ?? byMethod
	const flights = new Map<string, Flight>()
	let events: EventBus | undefined

	const join = async (
		flight: Flight,
		request: ConduitRequest,
		joined: boolean
	): Promise<ConduitResponse> => {
		flight.participants++

		let left = false
		let rejectOnAbort: (error: unknown) => void = () => {}

		const leave = (aborted: boolean): void => {
			if (left) {
				return
			}

			left = true
			request.signal.removeEventListener('abort', onAbort)
			flight.participants--

			// The last one out turns off the lights. Until then the request keeps
			// running for whoever is still waiting on it.
			if (aborted && flight.participants === 0) {
				// Dropped from the table in the same tick as the abort. The rejection
				// takes an async unwind to arrive, and a request landing in that
				// window would otherwise join a flight that is already dead and fail
				// with a cancellation it had nothing to do with.
				if (flights.get(request.key) === flight) {
					flights.delete(request.key)
				}

				flight.controller.abort(request.signal.reason)
			}
		}

		function onAbort(): void {
			const error = toAbortError(request)
			leave(true)
			rejectOnAbort(error)
		}

		request.signal.addEventListener('abort', onAbort, { once: true })

		const abandoned = new Promise<never>((_resolve, reject) => {
			rejectOnAbort = reject
		})

		try {
			const response = await Promise.race([flight.promise, abandoned])

			// Every rider holds the same body object, so it carries the same
			// immutability contract as a cache entry: one remote annotating what it
			// received must not rewrite what another is rendering.
			protect(response.data)

			// The originator reports whatever the network said; everyone else is
			// told they rode along, so devtools can show the difference.
			return joined ? { ...response, from: 'dedupe', request } : response
		} finally {
			leave(false)
		}
	}

	const middleware: Middleware = async (request, next) => {
		if (!shouldDedupe(request)) {
			return next(request)
		}

		// Checked before anything is created. Starting a flight for a caller who
		// has already cancelled would put a request on the wire that nothing can
		// abort — it runs on the flight's own controller, and the caller bails out
		// before ever becoming a participant who could release it.
		if (request.signal.aborted) {
			throw toAbortError(request)
		}

		const existing = flights.get(request.key)

		if (existing !== undefined && !existing.controller.signal.aborted) {
			if (events?.active === true) {
				events.emit('dedupe:join', {
					type: 'dedupe:join',
					key: request.key,
					owner: request.owner,
					at: Date.now(),
				})
			}

			return join(existing, request, true)
		}

		const controller = new AbortController()
		const flight: Flight = {
			controller,
			participants: 0,
			promise: next(withRequest(request, { signal: controller.signal })),
		}

		flights.set(request.key, flight)

		const forget = (): void => {
			// Guarded: a later flight for the same key may already have replaced this one.
			if (flights.get(request.key) === flight) {
				flights.delete(request.key)
			}
		}

		// Also marks the flight handled, so a rejection nobody joined does not
		// surface as an unhandled rejection.
		flight.promise.then(forget, forget)

		return join(flight, request, false)
	}

	return {
		name: 'dedupe',
		middleware,
		onInit: ctx => {
			events = ctx.events
			return { inFlight: () => flights.size }
		},
		onDestroy: () => {
			flights.clear()
		},
	}
}
